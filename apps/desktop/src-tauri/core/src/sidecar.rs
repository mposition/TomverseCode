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

/// Node → Rust 한 줄의 최대 바이트 (process-architecture.md 3.1절).
///
/// # 왜 상한이 필요한가 — 성능이 아니라 신뢰 경계다
///
/// 종전 구현은 `BufReader::lines()`였다. 그건 줄바꿈이 나올 때까지 **무한히** 버퍼를 키우므로,
/// Node가 줄바꿈 없이 계속 쓰면 **신뢰 경계 프로세스가 메모리를 다 쓴다.** 원칙 2는 "Node가
/// 완전히 장악당해도 Rust 게이트를 반드시 통과해야 한다"고 말하는데, 게이트에 도달하기 전에
/// 게이트가 죽으면 그 문장은 성립하지 않는다. 문서가 이 항목을 "파싱을 느리게 만들 가능성"으로
/// 적어둔 것은 문제의 성질을 잘못 짚은 것이다.
///
/// # 왜 32 MiB인가
///
/// 정당한 메시지가 크다. Node → Rust 방향에는 초안 patch가 실린 `db.appendEvent`가 있고,
/// 다중 파일 patch는 수 MB가 될 수 있다. 상한을 작게 잡으면 **정상 작업이 프로토콜 위반으로
/// 죽는다.** 반대로 이보다 큰 한 줄은 코딩 에이전트의 IPC 메시지로 설명되지 않는다.
///
/// **유도하지 못한 상수다.** 실사용 메시지 크기 분포를 재기 전까지는 관측이 아니라 판단이다.
pub const MAX_IPC_LINE_BYTES: usize = 32 * 1024 * 1024;

/// 한 줄을 읽은 결과.
///
/// `Oversized`와 `InvalidUtf8`을 **다른 값으로 두는 것이 이 타입의 요점이다.** 둘 다 "이 줄을
/// 쓸 수 없다"이지만 그 다음이 다르다:
///
/// - `InvalidUtf8`은 줄이 **완결됐다** — 줄바꿈까지 읽었으므로 프레임 동기가 살아 있고, 그 줄만
///   버리면 다음 줄부터 정상이다. 파싱 불가한 JSON을 무시하는 것과 같은 처리를 한다.
/// - `Oversized`는 줄이 **완결되지 않았다** — 상한까지 읽고 멈췄으므로 그 줄의 나머지가 스트림에
///   남아 있고, 다음에 읽는 "줄"은 앞 메시지의 꼬리다. **프레임 동기를 잃은 상태에서 계속
///   파싱하는 것은 멈추는 것보다 나쁘다.**
#[derive(Debug, PartialEq, Eq)]
pub enum FramedLine {
    Line(String),
    /// 상한을 넘겨 줄을 완결하지 못했다. 읽은 바이트 수를 함께 준다 — 사유를 사람이 읽을 때
    /// "얼마나 컸나"가 없으면 상한을 조정할 근거가 없다.
    Oversized {
        bytes: usize,
    },
    /// 줄은 완결됐지만 UTF-8이 아니다.
    InvalidUtf8 {
        bytes: usize,
    },
    Eof,
    ReadError(String),
}

/// NDJSON 한 줄을 **상한 안에서** 읽는다.
///
/// `BufRead::read_until`은 상한이 없으므로 `take`로 감싸 이번 호출이 읽을 수 있는 바이트를
/// 묶는다. `max_bytes + 1`을 허용하는 이유: 정확히 `max_bytes`인 줄은 정당하므로, 초과를
/// **판정하려면** 한 바이트를 더 볼 수 있어야 한다.
pub fn read_framed_line<R: BufRead>(reader: R, max_bytes: usize) -> FramedLine {
    let mut buf: Vec<u8> = Vec::new();
    // **리더를 값으로 받는다.** `take`가 값을 가져가므로, 호출자는 `&mut BufReader<...>`를
    // 넘긴다 — 그러면 이 호출이 소비하는 것은 차용이고 리더 자체는 다음 줄을 위해 남는다.
    let read = reader.take(max_bytes as u64 + 1).read_until(b'\n', &mut buf);
    match read {
        Err(e) => FramedLine::ReadError(e.to_string()),
        Ok(0) => FramedLine::Eof,
        Ok(n) => {
            // 줄바꿈으로 끝나지 않았는데 상한을 넘겼다면 줄이 완결되지 않은 것이다.
            // 줄바꿈 없이 끝난 **마지막** 줄(EOF)은 정당하므로 두 경우를 구별해야 한다.
            if n > max_bytes && buf.last() != Some(&b'\n') {
                return FramedLine::Oversized { bytes: n };
            }
            while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                buf.pop();
            }
            match String::from_utf8(buf) {
                Ok(line) => FramedLine::Line(line),
                Err(_) => FramedLine::InvalidUtf8 { bytes: n },
            }
        }
    }
}

/// **우리가 프로토콜 위반으로 닫았다**는 표시.
///
/// 재spawn 판정이 이 표시를 본다. 위반으로 닫은 연결을 다시 띄우면 같은 위반을 반복할 뿐이고,
/// 그게 공격이라면 재시도가 곧 협조다 — 크래시(우리가 닫지 않았는데 끊긴 것)와 구별해야 한다.
pub const PROTOCOL_VIOLATION_PREFIX: &str = "[protocol] ";

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
    /// 왜 닫혔는지. **정상 종료와 프로토콜 위반을 같은 문장으로 보고하지 않기 위해** 있다.
    close_reason: Arc<Mutex<Option<String>>>,
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
        let close_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let client = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            child: Mutex::new(Some(child)),
            closed: closed.clone(),
            close_reason: close_reason.clone(),
            reader: Mutex::new(None),
        });

        let reader_client = Arc::downgrade(&client);
        let reason_slot = close_reason.clone();
        let reader = std::thread::spawn(move || {
            let mut buffered = BufReader::new(stdout);
            // **종료 사유를 갖고 나간다.** 종전에는 어떤 이유로 끝나든 대기 중인 요청이
            // "sidecar가 응답 전에 종료됨"을 받았다. 프로토콜 위반과 정상 종료가 같은 문장으로
            // 보고되면, 사용자는 고칠 수 있는 것(상한)과 고칠 수 없는 것(크래시)을 구별하지 못한다.
            let mut exit_reason: Option<String> = None;
            loop {
                let line = match read_framed_line(&mut buffered, MAX_IPC_LINE_BYTES) {
                    FramedLine::Line(line) => line,
                    FramedLine::Eof => break,
                    FramedLine::InvalidUtf8 { bytes } => {
                        // 줄은 완결됐으므로 프레임 동기가 살아 있다 — 파싱 불가한 JSON과 같이
                        // 그 줄만 버린다. 그 줄이 응답이었다면 해당 요청은 타임아웃으로 끝난다.
                        eprintln!("[sidecar] UTF-8이 아닌 {bytes}바이트 줄을 버립니다");
                        continue;
                    }
                    FramedLine::Oversized { bytes } => {
                        // **여기서 멈춘다.** 줄이 완결되지 않았으므로 그 나머지가 스트림에 남아
                        // 있고, 다음에 읽는 것은 앞 메시지의 꼬리다. 동기를 잃은 스트림을 계속
                        // 파싱하면 우리가 해석하는 "메시지"는 아무것도 보장하지 않는다.
                        //
                        // 줄바꿈까지 버려 동기를 되찾는 방법도 있지만 그렇게 하지 않는다:
                        // 32 MiB를 넘는 한 줄은 정상 상태가 아니고, 정상 아닌 것을 조용히
                        // 회복하는 것이 그 상태를 오래 남기는 방식이다.
                        exit_reason = Some(format!(
                            "{PROTOCOL_VIOLATION_PREFIX}sidecar가 한 줄에 {bytes}바이트를 보냈습니다 (상한 {MAX_IPC_LINE_BYTES}).                              프로토콜 위반이므로 연결을 닫습니다."
                        ));
                        break;
                    }
                    FramedLine::ReadError(message) => {
                        exit_reason = Some(format!("sidecar stdout 읽기 실패: {message}"));
                        break;
                    }
                };
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
            // 여기 오는 경로는 셋이다: EOF(정상 종료), 프로토콜 위반, 읽기 실패.
            // 대기 중인 요청을 전부 깨워야 호출자가 영원히 블록되지 않는다.
            let message = exit_reason.unwrap_or_else(|| "sidecar가 응답 전에 종료됨".to_string());
            if let Ok(mut slot) = reason_slot.lock() {
                *slot = Some(message.clone());
            }
            closed.store(true, Ordering::SeqCst);
            let mut guard = pending.lock().unwrap();
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err(message.clone()));
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
            // **왜 닫혔는지를 함께 말한다.** "실행 중이 아님"만 보고하면 프로토콜 위반으로
            // 우리가 닫은 것과 sidecar가 죽은 것이 같은 문장이 되고, 사용자는 고칠 수 있는
            // 것과 고칠 수 없는 것을 구별하지 못한다.
            return Err(match self.close_reason() {
                Some(reason) => format!("sidecar가 실행 중이 아님: {reason}"),
                None => "sidecar가 실행 중이 아님".to_string(),
            });
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

    /// 닫힌 사유. 아직 열려 있으면 `None`이다.
    pub fn close_reason(&self) -> Option<String> {
        self.close_reason.lock().ok().and_then(|g| g.clone())
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

/// 워크스페이스 하나가 쓰는 sidecar를 **감독한다** (process-architecture.md 5절).
///
/// # 재spawn이 태스크를 살리지는 못한다
///
/// Node가 죽으면 그 안에 있던 Orchestrator 상태도 함께 사라진다. 새 프로세스는 그 태스크를
/// 모르므로, 재spawn이 하는 일은 **다음 태스크가 가능해지는 것**뿐이다. 진행 중이던 태스크는
/// 재시작 복구 절차와 같이 처리된다(7절) — 그게 5절 표가 두 문장으로 적어둔 이유다.
///
/// 그런데 종전에는 그 "다음"도 없었다: 한 번 닫히면 `closed`가 영원히 true라 워크스페이스를
/// 다시 열기 전까지 모든 요청이 실패했다. 사용자에게는 **앱이 죽은 것처럼 보인다.**
///
/// # 상한은 워크스페이스 세션당이다
///
/// 원칙 5는 모든 루프에 상한을 요구한다. "성공하면 리셋"은 상한이 아니다 — 태스크마다 한 번씩
/// 죽는 sidecar가 영원히 재spawn된다. 그래서 카운터는 **워크스페이스를 여는 동안 누적**되고,
/// 리셋하는 유일한 방법은 사용자가 다시 여는 것이다. 사람을 루프 안에 둔다.
///
/// # 프로토콜 위반은 재spawn하지 않는다
///
/// 우리가 위반으로 닫은 연결을 다시 띄우면 같은 위반을 반복할 뿐이고, 그게 공격이라면
/// 재시도가 곧 협조다. 크래시(우리가 닫지 않았는데 끊긴 것)만 재spawn 대상이다.
pub struct SidecarSupervisor {
    factory: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync>,
    client: Mutex<Arc<SidecarClient>>,
    respawns: AtomicU64,
    max_respawns: u64,
}

/// 재spawn을 하지 않기로 한 이유. **"안 했다"만 알면 사용자는 왜인지 모른다.**
#[derive(Debug, PartialEq, Eq)]
pub enum RespawnOutcome {
    /// sidecar가 살아 있어 할 일이 없었다.
    Alive,
    /// 새로 띄웠다. 몇 번째인지 함께 준다.
    Respawned { attempt: u64 },
    /// 상한에 도달했다.
    LimitReached { attempts: u64 },
    /// 프로토콜 위반으로 우리가 닫았다 — 다시 띄우면 반복될 뿐이다.
    ProtocolViolation { reason: String },
    /// 다시 띄우려 했으나 spawn 자체가 실패했다.
    SpawnFailed { attempt: u64, error: String },
}

/// 워크스페이스 세션 하나에서 허용하는 재spawn 횟수 (5절 표의 "최대 2회").
pub const MAX_SIDECAR_RESPAWNS: u64 = 2;

impl SidecarSupervisor {
    /// `factory`는 **같은 설정으로 다시 띄우는 방법**이다. 설정을 복제해 두는 대신 클로저로
    /// 받는 이유: 자격증명이 그 설정에 들어 있고(2절), 그걸 감독자가 들고 있으면 살아 있는
    /// 사본이 하나 더 생긴다.
    pub fn new(factory: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync>) -> std::io::Result<Self> {
        let client = factory()?;
        Ok(Self {
            factory,
            client: Mutex::new(client),
            respawns: AtomicU64::new(0),
            max_respawns: MAX_SIDECAR_RESPAWNS,
        })
    }

    /// 지금 쓸 수 있는 클라이언트.
    pub fn client(&self) -> Arc<SidecarClient> {
        self.client.lock().unwrap().clone()
    }

    pub fn respawn_count(&self) -> u64 {
        self.respawns.load(Ordering::SeqCst)
    }

    /// 죽어 있으면 다시 띄운다. **호출자가 부르는 시점을 정한다** — 태스크를 시작하기 전이지,
    /// 태스크 도중이 아니다. 도중에 바꿔치기하면 진행 중인 요청이 어느 프로세스의 것인지
    /// 알 수 없게 된다.
    pub fn ensure_alive(&self) -> RespawnOutcome {
        let mut guard = self.client.lock().unwrap();
        if !guard.is_closed() {
            return RespawnOutcome::Alive;
        }
        if let Some(reason) = guard.close_reason() {
            if reason.starts_with(PROTOCOL_VIOLATION_PREFIX) {
                return RespawnOutcome::ProtocolViolation { reason };
            }
        }
        let attempt = self.respawns.load(Ordering::SeqCst) + 1;
        if attempt > self.max_respawns {
            return RespawnOutcome::LimitReached {
                attempts: self.max_respawns,
            };
        }
        match (self.factory)() {
            Ok(fresh) => {
                *guard = fresh;
                self.respawns.store(attempt, Ordering::SeqCst);
                RespawnOutcome::Respawned { attempt }
            }
            Err(e) => {
                // **실패한 시도도 센다.** 세지 않으면 spawn이 계속 실패하는 환경에서
                // 상한이 없는 것과 같아진다.
                self.respawns.store(attempt, Ordering::SeqCst);
                RespawnOutcome::SpawnFailed {
                    attempt,
                    error: e.to_string(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 평범한 줄은 그대로 나오고, `\r\n`도 벗겨진다(Windows에서 온 줄을 그대로 파싱하면
    /// JSON 뒤에 `\r`이 붙어 파싱이 실패한다).
    #[test]
    fn reads_lines_and_strips_terminators() {
        let mut input = Cursor::new(b"{\"a\":1}\n{\"b\":2}\r\n".to_vec());
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("{\"a\":1}".to_string())
        );
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("{\"b\":2}".to_string())
        );
        assert_eq!(read_framed_line(&mut input, MAX_IPC_LINE_BYTES), FramedLine::Eof);
    }

    /// **정확히 상한인 줄은 정당하다.** 경계를 초과로 판정하면 상한이 실제로는 하나 작은 값이 된다.
    #[test]
    fn a_line_exactly_at_the_limit_is_accepted() {
        let mut data = vec![b'x'; 16];
        data.push(b'\n');
        let mut input = Cursor::new(data);
        assert_eq!(read_framed_line(&mut input, 16), FramedLine::Line("x".repeat(16)));
    }

    /// 줄바꿈 없이 끝난 **마지막** 줄은 정당하다 — EOF는 프레임 위반이 아니다.
    #[test]
    fn a_final_line_without_a_newline_is_accepted() {
        let mut input = Cursor::new(b"{\"a\":1}".to_vec());
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("{\"a\":1}".to_string())
        );
    }

    /// **상한을 넘기면 메모리를 계속 키우지 않는다.** 종전 `BufReader::lines()`는 줄바꿈이
    /// 나올 때까지 무한히 버퍼를 키웠고, 그건 신뢰 경계 프로세스를 Node가 죽일 수 있다는 뜻이다.
    ///
    /// 입력을 실제로 크게 만들지 않고 확인한다 — 끝없는 바이트 스트림을 주고, 함수가
    /// **돌아오는지**를 본다. 상한이 없으면 이 테스트는 끝나지 않는다.
    #[test]
    fn an_endless_line_is_bounded_instead_of_growing_forever() {
        // `repeat`은 Read이지 BufRead가 아니므로 BufReader로 감싼다 — 감싸는 버퍼는 고정
        // 크기이고, 무한히 커질 수 있는 것은 우리가 만드는 줄 버퍼뿐이다.
        let mut endless = BufReader::new(std::io::repeat(b'x'));
        match read_framed_line(&mut endless, 1_024) {
            FramedLine::Oversized { bytes } => assert_eq!(bytes, 1_025, "상한+1까지만 읽어야 한다"),
            other => panic!("초과를 감지하지 못했습니다: {other:?}"),
        }
    }

    /// **초과와 완결 불가를 구별해야 다음 처리가 갈린다.** 완결된 줄(UTF-8 위반)은 프레임
    /// 동기가 살아 있어 그 줄만 버리면 되지만, 초과는 나머지가 스트림에 남아 동기를 잃는다.
    #[test]
    fn invalid_utf8_is_distinguished_from_oversize() {
        // 0xFF는 어떤 UTF-8 시퀀스에도 나타나지 않는다.
        let mut input = Cursor::new(vec![0xFF, 0xFE, b'\n', b'o', b'k', b'\n']);
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::InvalidUtf8 { bytes: 3 }
        );
        // 그 줄만 버리면 다음 줄은 정상이다 — 이것이 초과와 다른 점이다.
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("ok".to_string())
        );
    }

    /// 초과 뒤의 스트림은 **앞 메시지의 꼬리**다. 그 사실을 이 테스트가 고정한다 —
    /// 계속 읽으면 우리가 "메시지"라고 부르는 것이 아무것도 보장하지 않는다.
    #[test]
    fn after_an_oversized_line_the_stream_is_desynchronized() {
        let mut input = Cursor::new(b"aaaaaaaaaa{\"tail\":1}\n{\"next\":2}\n".to_vec());
        assert!(matches!(read_framed_line(&mut input, 4), FramedLine::Oversized { .. }));
        // 다음에 읽히는 것은 온전한 메시지가 아니라 앞 줄의 나머지다.
        match read_framed_line(&mut input, MAX_IPC_LINE_BYTES) {
            FramedLine::Line(line) => {
                assert_ne!(line, "{\"next\":2}", "동기가 유지된 것처럼 보입니다");
                assert!(line.ends_with("{\"tail\":1}"), "실제로 읽힌 줄: {line}");
            }
            other => panic!("예상치 못한 결과: {other:?}"),
        }
    }
}

#[cfg(test)]
mod supervisor_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct NoopHandler;
    impl SidecarHandler for NoopHandler {
        fn handle_request(&self, _method: &str, _params: &Value) -> Result<Value, String> {
            Ok(Value::Null)
        }
        fn handle_event(&self, _task_id: &str, _event: &Value) {}
    }

    /// 즉시 죽는 sidecar. **실제 프로세스를 띄운다** — mock 클라이언트로 확인하면 "죽었다"의
    /// 판정 자체(EOF 감지)가 검증에서 빠진다.
    fn dying_factory(spawns: Arc<AtomicUsize>) -> Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> {
        Box::new(move || {
            spawns.fetch_add(1, Ordering::SeqCst);
            SidecarClient::spawn(
                SpawnConfig {
                    program: "node".to_string(),
                    args: vec!["-e".to_string(), "process.exit(0)".to_string()],
                    working_dir: None,
                    env: Vec::new(),
                },
                Arc::new(NoopHandler),
            )
        })
    }

    fn wait_closed(client: &SidecarClient) {
        for _ in 0..200 {
            if client.is_closed() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("sidecar가 종료를 보고하지 않았습니다");
    }

    /// **상한이 있고, 그 상한이 워크스페이스 세션당이다.** "성공하면 리셋"은 상한이 아니다 —
    /// 태스크마다 한 번씩 죽는 sidecar가 영원히 재spawn된다.
    #[test]
    fn respawns_up_to_the_limit_and_then_stops() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();

        for attempt in 1..=MAX_SIDECAR_RESPAWNS {
            wait_closed(&supervisor.client());
            assert_eq!(supervisor.ensure_alive(), RespawnOutcome::Respawned { attempt });
        }

        wait_closed(&supervisor.client());
        assert_eq!(
            supervisor.ensure_alive(),
            RespawnOutcome::LimitReached {
                attempts: MAX_SIDECAR_RESPAWNS
            }
        );
        // 상한에 도달한 뒤에는 **더 띄우지 않는다.** 최초 1회 + 재spawn 2회.
        assert_eq!(spawns.load(Ordering::SeqCst), (MAX_SIDECAR_RESPAWNS + 1) as usize);
    }

    /// 살아 있으면 아무것도 하지 않는다 — 멀쩡한 sidecar를 바꿔치기하면 진행 중인 요청이
    /// 어느 프로세스의 것인지 알 수 없게 된다.
    #[test]
    fn a_live_sidecar_is_left_alone() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let long_lived: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> = {
            let spawns = spawns.clone();
            Box::new(move || {
                spawns.fetch_add(1, Ordering::SeqCst);
                SidecarClient::spawn(
                    SpawnConfig {
                        program: "node".to_string(),
                        args: vec!["-e".to_string(), "setTimeout(() => {}, 60000)".to_string()],
                        working_dir: None,
                        env: Vec::new(),
                    },
                    Arc::new(NoopHandler),
                )
            })
        };
        let supervisor = SidecarSupervisor::new(long_lived).unwrap();
        assert_eq!(supervisor.ensure_alive(), RespawnOutcome::Alive);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(supervisor.respawn_count(), 0);
    }

    /// **프로토콜 위반은 재spawn하지 않는다.** 다시 띄우면 같은 위반을 반복할 뿐이고,
    /// 그게 공격이라면 재시도가 곧 협조다.
    #[test]
    fn a_protocol_violation_is_not_respawned() {
        let spawns = Arc::new(AtomicUsize::new(0));
        // 상한을 넘는 한 줄을 뱉고 죽는 sidecar를 흉내내는 대신, 종료 사유를 직접 만든다 —
        // 32 MiB를 실제로 쓰는 테스트는 느리고, 여기서 확인하려는 것은 **판정 규칙**이다.
        // (상한 감지 자체는 `read_framed_line` 테스트가 확인한다.)
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();
        wait_closed(&supervisor.client());
        {
            let client = supervisor.client();
            let mut slot = client.close_reason.lock().unwrap();
            *slot = Some(format!("{PROTOCOL_VIOLATION_PREFIX}한 줄이 너무 깁니다"));
        }
        match supervisor.ensure_alive() {
            RespawnOutcome::ProtocolViolation { reason } => {
                assert!(reason.contains("너무 깁니다"), "{reason}");
            }
            other => panic!("위반인데 재spawn했습니다: {other:?}"),
        }
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "다시 띄우면 안 됩니다");
    }

    /// spawn 자체가 실패한 시도도 **센다.** 세지 않으면 실행 파일이 없는 환경에서 상한이
    /// 없는 것과 같아진다 — `ensure_alive`를 부를 때마다 새로 시도하게 된다.
    #[test]
    fn a_failed_spawn_still_counts_against_the_limit() {
        let calls = Arc::new(AtomicUsize::new(0));
        let factory: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> = {
            let calls = calls.clone();
            Box::new(move || {
                // 첫 호출만 성공한다(그리고 바로 죽는다). 이후 재spawn은 전부 실패한다.
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                SidecarClient::spawn(
                    SpawnConfig {
                        program: if first { "node" } else { "tomverse-not-a-real-program" }.to_string(),
                        args: if first {
                            vec!["-e".to_string(), "process.exit(0)".to_string()]
                        } else {
                            Vec::new()
                        },
                        working_dir: None,
                        env: Vec::new(),
                    },
                    Arc::new(NoopHandler),
                )
            })
        };

        let supervisor = SidecarSupervisor::new(factory).unwrap();
        wait_closed(&supervisor.client());

        for attempt in 1..=MAX_SIDECAR_RESPAWNS {
            match supervisor.ensure_alive() {
                RespawnOutcome::SpawnFailed { attempt: got, .. } => assert_eq!(got, attempt),
                other => panic!("spawn이 실패했는데 다른 결과가 나왔습니다: {other:?}"),
            }
        }
        // 실패한 시도가 세어졌으므로 상한에 도달한다 — 세지 않았다면 영원히 재시도했을 것이다.
        assert_eq!(
            supervisor.ensure_alive(),
            RespawnOutcome::LimitReached {
                attempts: MAX_SIDECAR_RESPAWNS
            }
        );
    }
}
