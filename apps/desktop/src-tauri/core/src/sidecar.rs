//! Node sidecar와의 로컬 IPC (stdio + NDJSON).
//!
//! docs/design/process-architecture.md 3절. 이 구현은 tokio를 쓰지 않고 std 스레드만 쓴다 —
//! 코어 크레이트가 비동기 런타임에 묶이지 않아야 Tauri(비동기)와 헤드리스 호스트(동기)가
//! 같은 코드를 공유할 수 있다.
//!
//! 방향이 양쪽이라는 점이 중요하다: Rust가 `task.start`를 보내고, 그 처리 중에 Node가
//! `tool.execute`를 되묻는다. 그래서 요청 디스패치가 양방향으로 동작해야 한다.

use crate::time::now_iso;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Node가 Rust에 보낸 요청을 처리하는 쪽. host가 구현한다.
pub trait SidecarHandler: Send + Sync {
    /// `tool.execute`, `db.appendEvent`, `verify.run` 등
    fn handle_request(&self, method: &str, params: &Value) -> Result<Value, String>;
    /// Node가 발행한 이벤트 (응답 없음) — UI 릴레이 + 이벤트 로그
    fn handle_event(&self, task_id: &str, event: &Value);
}

pub struct SidecarClient {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
    child: Mutex<Option<Child>>,
    /// sidecar stdout이 EOF에 도달했는지 (프로세스 종료)
    closed: Arc<AtomicBool>,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
}

pub struct SpawnConfig {
    /// `node` 실행 파일 (또는 번들된 sidecar 바이너리)
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: Option<std::path::PathBuf>,
    /// sidecar에 주입할 환경변수. **API 키가 여기로 들어간다** —
    /// 자격증명은 Rust가 보유하고 Node는 프로세스 시작 시 1회 주입받아 메모리에만 둔다
    /// (process-architecture.md 2절).
    pub env: Vec<(String, String)>,
}

impl SidecarClient {
    /// 개발 모드 sidecar 진입점 (`packages/sidecar/dist/src/index.js`).
    /// 배포판에서는 단일 바이너리로 번들해야 한다(process-architecture.md 8절 미해결 항목).
    pub fn dev_entry(repo_root: &Path) -> std::path::PathBuf {
        repo_root
            .join("packages")
            .join("sidecar")
            .join("dist")
            .join("src")
            .join("index.js")
    }

    pub fn spawn(config: SpawnConfig, handler: Arc<dyn SidecarHandler>) -> std::io::Result<Arc<Self>> {
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr는 sidecar 로그 전용 — NDJSON 프로토콜과 섞이지 않는다.
            .stderr(Stdio::inherit());
        if let Some(dir) = &config.working_dir {
            command.current_dir(dir);
        }
        for (k, v) in &config.env {
            command.env(k, v);
        }

        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("sidecar stdin should be piped");
        let stdout = child.stdout.take().expect("sidecar stdout should be piped");

        let pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        let client = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            child: Mutex::new(Some(child)),
            closed: closed.clone(),
            reader: Mutex::new(None),
        });

        let reader_client = Arc::downgrade(&client);
        let reader = std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            while let Some(Ok(line)) = lines.next() {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    // 파싱 불가한 줄은 무시한다 (packages/sidecar transport.ts와 동일 원칙).
                    continue;
                };
                match msg.get("kind").and_then(Value::as_str) {
                    Some("response") => {
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        let outcome = if msg.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(msg
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("unknown sidecar error")
                                .to_string())
                        };
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(outcome);
                        }
                    }
                    Some("request") => {
                        // Node → Rust 요청. 신뢰 경계를 넘는 지점이므로 handler가 전부 재검증한다.
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        let method = msg
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        let response = match handler.handle_request(&method, &params) {
                            Ok(result) => json!({ "kind": "response", "id": id, "ok": true, "result": result }),
                            Err(message) => json!({
                                "kind": "response", "id": id, "ok": false,
                                "error": { "code": "HOST_ERROR", "message": message }
                            }),
                        };
                        if let Some(c) = reader_client.upgrade() {
                            let _ = c.write_raw(&response);
                        }
                    }
                    Some("event") => {
                        let task_id = msg.get("taskId").and_then(Value::as_str).unwrap_or_default();
                        let event = msg.get("event").cloned().unwrap_or(Value::Null);
                        handler.handle_event(task_id, &event);
                    }
                    _ => {}
                }
            }
            // EOF — sidecar 종료. 대기 중인 요청을 전부 깨워야 호출자가 영원히 블록되지 않는다.
            closed.store(true, Ordering::SeqCst);
            let mut guard = pending.lock().unwrap();
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err("sidecar가 응답 전에 종료됨".to_string()));
            }
        });

        *client.reader.lock().unwrap() = Some(reader);
        Ok(client)
    }

    fn write_raw(&self, msg: &Value) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "sidecar stdin lock poisoned".to_string())?;
        let line = format!("{msg}\n");
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("sidecar stdin 쓰기 실패: {e}"))?;
        stdin.flush().map_err(|e| format!("sidecar stdin flush 실패: {e}"))
    }

    /// Rust → Node 요청. `timeout`이 지나면 대기를 포기한다 (상한 없는 대기를 만들지 않는다).
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("sidecar가 실행 중이 아님".to_string());
        }
        let id = format!("rust-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        self.write_raw(&json!({ "kind": "request", "id": id, "method": method, "params": params }))?;

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "sidecar 요청 {method:?}가 {}초 후 타임아웃됨",
                    timeout.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.pending.lock().unwrap().remove(&id);
                Err("sidecar가 응답 전에 종료됨".to_string())
            }
        }
    }

    /// `ready` 이벤트가 아니라 `ping` 왕복으로 준비 여부를 확인한다 —
    /// 이벤트는 handler로 흘러가므로 여기서 관측할 수 없다.
    pub fn wait_ready(&self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let mut last_error = String::new();
        while Instant::now() < deadline {
            match self.request("ping", json!({}), Duration::from_millis(500)) {
                Ok(v) => return Ok(v),
                Err(e) => {
                    last_error = e;
                    if self.closed.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        Err(format!("sidecar가 준비되지 않음: {last_error}"))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 정상 종료 (process-architecture.md 5절): shutdown 요청 → 응답 대기 → 강제 종료.
    pub fn shutdown(&self, grace: Duration) {
        let _ = self.request("shutdown", json!({ "at": now_iso() }), grace);
        // stdin을 닫으면 Node 쪽 readline이 EOF를 받고 자연 종료한다.
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                let deadline = Instant::now() + grace;
                loop {
                    match c.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() >= deadline => {
                            let _ = c.kill();
                            let _ = c.wait();
                            break;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                        Err(_) => break,
                    }
                }
            }
        }
    }
}

impl Drop for SidecarClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}
