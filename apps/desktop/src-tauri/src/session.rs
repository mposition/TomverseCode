//! Tauri 앱의 세션 상태.
//!
//! 이 모듈은 **얇은 어댑터**다. Policy Gate, Tool Runtime, 저장, 검증은 전부 `tomverse-core`에
//! 있고 여기서는 (a) 워크스페이스별 `TaskHost` 생성 (b) 승인 왕복을 UI와 연결 (c) 이벤트 릴레이만 한다.
//!
//! docs/design/process-architecture.md 4절: 승인/거부는 정책 판단의 연장이므로 Rust 책임 소관이며
//! Node를 거치지 않는다. `UiApprovalGateway`가 그 왕복의 Rust 쪽 절반이다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tomverse_core::artifacts::ArtifactStore;
use tomverse_core::host::{ApprovalGateway, ApprovalOutcome, EventSink, TaskHost};
use tomverse_core::sidecar::{SidecarClient, SpawnConfig};
use tomverse_core::store::Store;
use tomverse_core::types::{ApprovalRequest, ExecutionMode, TaskPolicy};
use tomverse_core::{available_providers, credential_env, WorkspaceRoot, PROTOCOL_VERSION};

/// UI에 승인 요청을 emit하고 사용자 응답을 기다린다.
///
/// 타임아웃을 두는 이유(CLAUDE.md 원칙 5 — 상한 없는 대기를 만들지 않는다): UI가 죽거나
/// 사용자가 창을 닫으면 태스크가 영원히 매달린다. 시간이 지나면 **거부**로 처리한다 —
/// "응답이 없으면 허용"은 승인 게이트의 의미를 무너뜨린다.
pub struct UiApprovalGateway {
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<ApprovalOutcome>>>>,
    timeout: Duration,
}

impl UiApprovalGateway {
    pub fn new(app: AppHandle, pending: Arc<Mutex<HashMap<String, mpsc::Sender<ApprovalOutcome>>>>) -> Self {
        Self {
            app,
            pending,
            timeout: Duration::from_secs(600),
        }
    }
}

impl ApprovalGateway for UiApprovalGateway {
    fn request_approval(&self, request: &ApprovalRequest) -> ApprovalOutcome {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(request.approval_id.clone(), tx);

        // ui-wireframes.md 3.3절 승인 모달이 이 페이로드를 그대로 렌더링한다.
        // run_command 항목의 program/args/cwd는 실제 실행값과 같다 (argv 계약).
        if self
            .app
            .emit(
                "approval-required",
                serde_json::to_value(request).unwrap_or(Value::Null),
            )
            .is_err()
        {
            self.pending.lock().unwrap().remove(&request.approval_id);
            return ApprovalOutcome::Denied {
                note: Some("UI에 승인 요청을 전달할 수 없었습니다".to_string()),
            };
        }

        let outcome = rx.recv_timeout(self.timeout).unwrap_or(ApprovalOutcome::Denied {
            note: Some("승인 대기가 시간 초과되었습니다 — 안전을 위해 거부로 처리합니다".to_string()),
        });
        self.pending.lock().unwrap().remove(&request.approval_id);
        outcome
    }
}

/// Rust → UI 이벤트 릴레이. process-architecture.md 4절대로 내용을 해석하지 않고 그대로 emit한다.
struct TauriSink {
    app: AppHandle,
}

impl EventSink for TauriSink {
    fn emit(&self, channel: &str, payload: &Value) {
        let _ = self.app.emit(channel, payload.clone());
    }
}

pub struct ActiveWorkspace {
    pub root_display: String,
    pub name: String,
    pub host: Arc<TaskHost>,
    pub workspace_id: String,
    pub session_id: String,
    sidecar: Arc<SidecarClient>,
}

#[derive(Default)]
pub struct SessionState {
    inner: Mutex<Option<ActiveWorkspace>>,
    pub pending_approvals: Arc<Mutex<HashMap<String, mpsc::Sender<ApprovalOutcome>>>>,
}

impl SessionState {
    /// 워크스페이스를 열고 sidecar를 spawn한다. 이미 열려 있으면 교체한다.
    pub fn open_workspace(&self, app: &AppHandle, path: &str, policy: TaskPolicy) -> Result<Value, String> {
        let root = WorkspaceRoot::new(path).map_err(|e| format!("워크스페이스를 열 수 없습니다: {e}"))?;

        let state_dir = app_state_dir();
        let artifacts = ArtifactStore::new(state_dir.join("artifacts"))
            .map_err(|e| format!("artifact 저장소를 만들 수 없습니다: {e}"))?;
        let store = Store::open(state_dir.join("state.db"), artifacts.clone())
            .map_err(|e| format!("로컬 DB를 열 수 없습니다: {e}"))?;

        let workspace_id = format!("ws-{}", short_hash(&root.display()));
        let name = root
            .path()
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace")
            .to_string();
        store
            .upsert_workspace(&workspace_id, &root.display(), &name)
            .map_err(|e| format!("워크스페이스 기록 실패: {e}"))?;

        let session_id = format!("sess-{}", uuid::Uuid::new_v4());
        store
            .upsert_session(&session_id, &workspace_id, Some(&name))
            .map_err(|e| format!("세션 기록 실패: {e}"))?;

        let approvals = Arc::new(UiApprovalGateway::new(app.clone(), self.pending_approvals.clone()));
        let sink = Arc::new(TauriSink { app: app.clone() });
        let host = Arc::new(TaskHost::new(root.clone(), policy, store, artifacts, approvals, sink));

        // sidecar spawn: 여기서 API 키가 자식 환경으로 1회 주입된다.
        // 값은 UI로도 로그로도 나가지 않는다.
        let sidecar = SidecarClient::spawn(
            SpawnConfig {
                program: "node".to_string(),
                args: vec![sidecar_entry().to_string_lossy().to_string()],
                working_dir: None,
                env: credential_env(),
            },
            host.clone(),
        )
        .map_err(|e| format!("백엔드(sidecar)를 시작할 수 없습니다: {e}"))?;

        let ready = sidecar.wait_ready(Duration::from_secs(10))?;
        let sidecar_version = ready.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        if sidecar_version != PROTOCOL_VERSION {
            sidecar.shutdown(Duration::from_secs(2));
            return Err(format!(
                "백엔드 프로토콜 버전이 맞지 않습니다 (앱 {PROTOCOL_VERSION} / 백엔드 {sidecar_version}). 앱을 업데이트하세요."
            ));
        }

        let info = json!({
            "rootPath": root.display(),
            "name": name,
            "workspaceId": workspace_id,
            "sessionId": session_id,
            "protocolVersion": PROTOCOL_VERSION,
        });

        let mut guard = self.inner.lock().unwrap();
        if let Some(previous) = guard.take() {
            previous.sidecar.shutdown(Duration::from_secs(3));
        }
        *guard = Some(ActiveWorkspace {
            root_display: root.display(),
            name,
            host,
            workspace_id,
            session_id,
            sidecar,
        });
        Ok(info)
    }

    pub fn with_active<T>(&self, f: impl FnOnce(&ActiveWorkspace) -> Result<T, String>) -> Result<T, String> {
        let guard = self.inner.lock().unwrap();
        let active = guard
            .as_ref()
            .ok_or_else(|| "먼저 워크스페이스를 선택하세요.".to_string())?;
        f(active)
    }

    pub fn info(&self) -> Option<Value> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().map(|active| {
            json!({
                "rootPath": active.root_display,
                "name": active.name,
                "workspaceId": active.workspace_id,
                "sessionId": active.session_id,
            })
        })
    }

    /// 태스크 시작. sidecar 요청이 끝날 때까지 블록되므로 호출자는 별도 스레드에서 부른다.
    pub fn start_task(&self, message: &str, mode: ExecutionMode, timeout: Duration) -> Result<Value, String> {
        let (sidecar, host, workspace_id, session_id) = self.with_active(|active| {
            Ok((
                active.sidecar.clone(),
                active.host.clone(),
                active.workspace_id.clone(),
                active.session_id.clone(),
            ))
        })?;

        let task_id = format!("task-{}", uuid::Uuid::new_v4());
        host.with_store(|s| s.create_task(&task_id, &session_id, &workspace_id, message))
            .map_err(|e| format!("태스크를 만들 수 없습니다: {e}"))?;

        let params = json!({
            "taskRequest": {
                "taskId": task_id,
                "sessionId": session_id,
                "workspaceId": workspace_id,
                "userMessage": message,
                "createdAt": tomverse_core::time::now_iso(),
            },
            "policy": {
                "executionMode": match mode { ExecutionMode::Fast => "fast", ExecutionMode::Verified => "verified" },
            },
            "workspaceName": self.info().and_then(|i| i.get("name").cloned()).unwrap_or(Value::Null),
            "availableProviders": available_providers(),
        });

        let result = sidecar.request("task.start", params, timeout);
        match result {
            Ok(mut value) => {
                if let Some(obj) = value.as_object_mut() {
                    let mutated = host.with_store(|s| s.mutated_paths(&task_id)).unwrap_or_default();
                    obj.insert("mutatedPaths".to_string(), json!(mutated));
                    obj.insert("taskId".to_string(), json!(task_id));
                    obj.insert("diffs".to_string(), json!(host.collected_diffs()));
                }
                Ok(value)
            }
            Err(message) => {
                // sidecar가 죽어도 이벤트 로그로 상태를 설명할 수 있어야 한다.
                let _ = host.append_event(
                    &task_id,
                    "TASK_FAILED",
                    json!({ "status": "failed", "summary": message.clone() }),
                );
                Err(message)
            }
        }
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<Value, String> {
        self.with_active(|active| {
            // 두 방향 모두 필요하다: Node는 진행 중인 공급자 호출을 끊고,
            // Rust는 이후 도구 실행을 거부한다.
            active.host.cancel();
            let node = active
                .sidecar
                .request("task.cancel", json!({ "taskId": task_id }), Duration::from_secs(5))
                .unwrap_or(Value::Null);
            Ok(json!({ "cancelled": true, "sidecar": node }))
        })
    }

    pub fn provide_user_input(&self, task_id: &str, message: &str) -> Result<Value, String> {
        self.with_active(|active| {
            active
                .sidecar
                .request(
                    "task.userInput",
                    json!({ "taskId": task_id, "message": message }),
                    Duration::from_secs(10),
                )
                .map_err(|e| e)
        })
    }

    pub fn respond_approval(&self, approval_id: &str, granted: bool, note: Option<String>) -> Result<Value, String> {
        let sender = self.pending_approvals.lock().unwrap().remove(approval_id);
        let Some(sender) = sender else {
            return Err("해당 승인 요청을 찾을 수 없습니다 (이미 처리되었거나 시간이 초과되었습니다).".to_string());
        };
        let outcome = if granted {
            ApprovalOutcome::Granted
        } else {
            ApprovalOutcome::Denied { note }
        };
        sender
            .send(outcome)
            .map_err(|_| "승인 응답을 전달할 수 없습니다 (요청이 이미 종료되었습니다).".to_string())?;
        Ok(json!({ "ok": true }))
    }
}

/// 개발 모드 sidecar 진입점. 배포판에서는 번들된 바이너리를 쓴다
/// (process-architecture.md 8절 미해결 항목).
fn sidecar_entry() -> PathBuf {
    if let Some(explicit) = std::env::var_os("TOMVERSE_SIDECAR_ENTRY") {
        return PathBuf::from(explicit);
    }
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

/// `%APPDATA%/Tomverse Code/` (Windows) 또는 대응 위치.
fn app_state_dir() -> PathBuf {
    ArtifactStore::default_root()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".tomverse"))
}

fn short_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}
