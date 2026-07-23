//! docs/design/process-architecture.md 3절 — Rust core <-> Node sidecar 로컬 IPC.
//! stdio + NDJSON(줄바꿈으로 구분된 JSON) 프레이밍, id로 매칭되는 요청/응답 + 별도 이벤트 스트림.
//!
//! 이 모듈은 신뢰 경계(process-architecture.md 2절)의 Rust 쪽 절반이다: 여기서는 아직
//! Policy Gate 최종 판단이나 Tool Runtime 실행을 구현하지 않는다 — 지금은 순수히 sidecar를
//! spawn하고 ping으로 연결을 확인하는 배관까지만 스캐폴딩한다.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct SidecarHandle {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: PendingMap,
}

impl SidecarHandle {
    /// 개발 모드 전용 경로 해석. 실제 배포판에서는 sidecar를 단일 바이너리로 번들링해야 하며
    /// (process-architecture.md 8절 미해결 항목), 지금은 모노레포 내 컴파일된 sidecar를 직접
    /// `node`로 실행한다 — CARGO_MANIFEST_DIR(=apps/desktop/src-tauri) 기준 상대경로.
    fn dev_sidecar_entry() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("sidecar")
            .join("dist")
            .join("src")
            .join("index.js")
    }

    pub fn spawn(app: AppHandle) -> std::io::Result<Self> {
        let entry = Self::dev_sidecar_entry();
        let mut child = Command::new("node")
            .arg(&entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // sidecar 로그는 stderr 전용 — NDJSON과 섞이지 않음
            .spawn()?;

        let mut stdin = child.stdin.take().expect("sidecar stdin should be piped");
        let stdout = child.stdout.take().expect("sidecar stdout should be piped");

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        tauri::async_runtime::spawn(async move {
            // 자식 프로세스를 reader 태스크가 소유해 stdout이 살아있는 동안 child가 drop되지 않게 한다.
            let _child = child;
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                            continue; // 파싱 불가한 줄은 무시 (packages/sidecar transport.ts와 동일 원칙)
                        };
                        Self::handle_message(&app, &pending_for_reader, msg).await;
                    }
                    _ => break, // EOF 또는 읽기 오류 — sidecar 종료
                }
            }
        });

        Ok(Self { stdin_tx: tx, pending })
    }

    async fn handle_message(app: &AppHandle, pending: &PendingMap, msg: Value) {
        match msg.get("kind").and_then(Value::as_str) {
            Some("response") => {
                let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
                if let Some(sender) = pending.lock().await.remove(&id) {
                    let outcome = if ok {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        let message = msg
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown sidecar error")
                            .to_string();
                        Err(message)
                    };
                    let _ = sender.send(outcome);
                }
            }
            Some("event") => {
                // process-architecture.md 4절: Rust는 이벤트 내용을 해석하지 않고 그대로 릴레이한다.
                let _ = app.emit("sidecar-event", msg);
            }
            _ => {}
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let request = serde_json::json!({
            "kind": "request",
            "id": id,
            "method": method,
            "params": params,
        });
        self.stdin_tx
            .send(request.to_string())
            .map_err(|e| format!("failed to write to sidecar stdin: {e}"))?;

        rx.await.map_err(|e| format!("sidecar closed before responding: {e}"))?
    }
}
