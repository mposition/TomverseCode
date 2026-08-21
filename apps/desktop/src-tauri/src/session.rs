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
use tomverse_core::store::TaskRow;
use tomverse_core::types::{ApprovalRequest, ExecutionMode, TaskPolicy};
use tomverse_core::{available_providers, credential_env, CancellationRegistry, WorkspaceRoot, PROTOCOL_VERSION};

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
    /// 저장 계층은 **워크스페이스와 독립적으로** 살아 있어야 한다.
    ///
    /// 앱을 켜자마자(워크스페이스를 열기 전) 최근 작업 목록과 중단된 작업을 보여줘야 하기 때문이다.
    /// 워크스페이스를 열 때 Store를 만들면 그 화면을 그릴 수 없다.
    store: Mutex<Option<Arc<Mutex<Store>>>>,
    artifacts: Mutex<Option<ArtifactStore>>,
    /// 앱 수명 동안 유지되는 취소 registry. 워크스페이스를 바꿔도 진행 중이던 태스크의
    /// 취소 신호가 유실되면 안 된다.
    cancels: Arc<CancellationRegistry>,
}

impl SessionState {
    /// 앱 시작 시 1회. 저장 계층을 열고 **비정상 종료된 작업을 INTERRUPTED로 확정한다.**
    ///
    /// 자동 재실행하지 않는다(state-machine-and-protocol.md 7절): 부분 실행된 도구의 재개는
    /// 멱등성 보장이 없으면 위험하다. 사용자에게 되돌리기/재실행 선택을 준다.
    pub fn initialize(&self) -> Result<Value, String> {
        let state_dir = app_state_dir();
        let artifacts = ArtifactStore::new(state_dir.join("artifacts"))
            .map_err(|e| format!("artifact 저장소를 만들 수 없습니다: {e}"))?;
        let mut store = Store::open(state_dir.join("state.db"), artifacts.clone())
            .map_err(|e| format!("로컬 DB를 열 수 없습니다: {e}"))?;

        let interrupted = store
            .mark_unfinished_as_interrupted()
            .map_err(|e| format!("중단된 작업을 정리할 수 없습니다: {e}"))?;

        *self.store.lock().unwrap() = Some(Arc::new(Mutex::new(store)));
        *self.artifacts.lock().unwrap() = Some(artifacts);

        Ok(json!({
            "interruptedTasks": interrupted,
            "stateDir": state_dir.to_string_lossy(),
        }))
    }

    fn store(&self) -> Result<Arc<Mutex<Store>>, String> {
        self.store
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "저장 계층이 아직 초기화되지 않았습니다".to_string())
    }

    fn artifacts(&self) -> Result<ArtifactStore, String> {
        self.artifacts
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "artifact 저장소가 아직 초기화되지 않았습니다".to_string())
    }

    pub fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
        let store = self.store()?;
        let mut guard = store.lock().unwrap();
        Ok(f(&mut guard))
    }

    // ---- 조회 (UI는 DB에 직접 접근하지 않는다 — 전부 이 경로를 지난다) ----

    pub fn list_tasks(
        &self,
        workspace_path: Option<&str>,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<Vec<TaskRow>, String> {
        self.with_store(|s| s.list_tasks(workspace_path, limit, cursor))?
            .map_err(|e| format!("작업 목록을 읽을 수 없습니다: {e}"))
    }

    /// 강제 포기 버튼을 열 시점. **저장된 취소 이벤트에서 유도한다** — 12절 미해결
    /// "강제 포기 노출 시점(5초)의 근거"가 추정이었던 자리다(16.3절).
    ///
    /// 워크스페이스를 열 때 한 번만 부른다. 집계가 전체 태스크의 이벤트를 훑기 때문인데,
    /// 취소마다 다시 계산할 이유는 없다 — 임계값은 한 세션 안에서 흔들리지 않는 편이
    /// 사용자에게도 낫다(탈출구가 뜨는 시점이 매번 달라지면 그 자체가 불안이다).
    pub fn force_abandon_threshold(&self, workspace_path: Option<&str>) -> Result<Value, String> {
        let metrics = self.with_store(|s| tomverse_core::metrics::collect(s, workspace_path))??;
        Ok(json!({
            "threshold": metrics.force_abandon_threshold,
            // 분포도 함께 준다. 임계값만 주면 화면이 그 숫자의 출처를 설명할 수 없다.
            "latency": metrics.cancellation,
        }))
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRow>, String> {
        self.with_store(|s| s.get_task(task_id))?
            .map_err(|e| format!("작업을 읽을 수 없습니다: {e}"))
    }

    pub fn get_task_events(&self, task_id: &str, after_event_id: Option<i64>) -> Result<Value, String> {
        let events = self
            .with_store(|s| s.events_after(task_id, after_event_id))?
            .map_err(|e| format!("이벤트를 읽을 수 없습니다: {e}"))?;
        Ok(json!(events
            .into_iter()
            .map(|e| json!({
                "eventId": e.event_id,
                "seq": e.seq,
                "type": e.event_type,
                "phase": e.phase,
                "payload": e.payload,
                "createdAt": e.created_at,
            }))
            .collect::<Vec<_>>()))
    }

    /// 저장된 mutation 목록 — INTERRUPTED 작업의 "되돌리기" 버튼이 이걸 보고 판단한다.
    pub fn task_mutations(&self, task_id: &str) -> Result<Vec<String>, String> {
        self.with_store(|s| s.mutated_paths(task_id))?
            .map_err(|e| format!("변경 목록을 읽을 수 없습니다: {e}"))
    }

    /// 저장된 작업의 확정 기준. 히스토리에서 지난 작업을 열었을 때도 "무엇을 결정했는가"가
    /// 보여야 한다 — 그 화면에는 FinalResult가 없고 DB뿐이다.
    pub fn task_acceptance_criteria(&self, task_id: &str) -> Result<Value, String> {
        let rows = self
            .with_store(|s| s.acceptance_criteria(task_id))?
            .map_err(|e| format!("기준 목록을 읽을 수 없습니다: {e}"))?;
        Ok(serde_json::to_value(rows).unwrap_or(Value::Null))
    }

    /// 워크스페이스를 열고 sidecar를 spawn한다. 이미 열려 있으면 교체한다.
    pub fn open_workspace(&self, app: &AppHandle, path: &str, policy: TaskPolicy) -> Result<Value, String> {
        let root = WorkspaceRoot::new(path).map_err(|e| format!("워크스페이스를 열 수 없습니다: {e}"))?;

        let artifacts = self.artifacts()?;
        let store = self.store()?;

        let workspace_id = format!("ws-{}", short_hash(&root.display()));
        let name = root
            .path()
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace")
            .to_string();
        let session_id = format!("sess-{}", uuid::Uuid::new_v4());
        {
            let guard = store.lock().unwrap();
            guard
                .upsert_workspace(&workspace_id, &root.display(), &name)
                .map_err(|e| format!("워크스페이스 기록 실패: {e}"))?;
            guard
                .upsert_session(&session_id, &workspace_id, Some(&name))
                .map_err(|e| format!("세션 기록 실패: {e}"))?;
        }

        let approvals = Arc::new(UiApprovalGateway::new(app.clone(), self.pending_approvals.clone()));
        let sink = Arc::new(TauriSink { app: app.clone() });
        let host = Arc::new(TaskHost::new(
            root.clone(),
            policy,
            store,
            artifacts,
            approvals,
            sink,
            self.cancels.clone(),
        ));

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
    /// `allow_git_commit`은 **커밋을 제안할지**를 정할 뿐 승인 등급을 낮추지 않는다.
    ///
    /// Rust `TaskPolicy`는 워크스페이스를 열 때 고정되고 여기서 바뀌지 않는다. 그래서 UI 토글이
    /// 켜져도 Policy Gate는 `git commit`을 계속 High 승인으로 다룬다 — **UI에서 켠 스위치가
    /// 신뢰 경계의 위험 등급을 낮출 수 있으면 그건 게이트가 아니다**(원칙 2·3).
    /// 토글이 하는 일은 "매 태스크마다 커밋 승인 모달을 띄울 것인가"뿐이다.
    pub fn start_task(
        &self,
        message: &str,
        mode: ExecutionMode,
        allow_git_commit: bool,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (sidecar, host, workspace_id, session_id) = self.with_active(|active| {
            Ok((
                active.sidecar.clone(),
                active.host.clone(),
                active.workspace_id.clone(),
                active.session_id.clone(),
            ))
        })?;

        let task_id = format!("task-{}", uuid::Uuid::new_v4());
        let workspace_path = self
            .info()
            .and_then(|i| i["rootPath"].as_str().map(str::to_string))
            .unwrap_or_default();
        let mode_str = match mode {
            ExecutionMode::Fast => "fast",
            ExecutionMode::Verified => "verified",
        };
        host.with_store(|s| s.create_task(&task_id, &session_id, &workspace_id, &workspace_path, mode_str, message))
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
                "allowGitCommit": allow_git_commit,
            },
            "workspaceName": self.info().and_then(|i| i.get("name").cloned()).unwrap_or(Value::Null),
            "availableProviders": available_providers(),
        });

        let result = sidecar.request("task.start", params, timeout);
        match result {
            Ok(mut value) => {
                // Node가 보고한 최종 상태를 **호스트가 원자적으로 확정한다.** Node의 주장을
                // 그대로 믿으면 완료/취소 경쟁에서 두 terminal이 기록될 수 있다.
                let status = value.get("status").and_then(Value::as_str).unwrap_or("failed");
                let terminal = match status {
                    "completed" => "COMPLETED",
                    "cancelled" => "CANCELLED",
                    "rejected" => "REJECTED",
                    _ => "FAILED",
                };
                let summary = value.get("summary").and_then(Value::as_str).unwrap_or("").to_string();
                let _ = host.finish_task(
                    &task_id,
                    terminal,
                    &format!("TASK_{terminal}"),
                    if terminal == "FAILED" { Some(&summary) } else { None },
                    json!({ "status": status, "summary": summary, "source": "host-confirm" }),
                );

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
                let _ = host.finish_task(
                    &task_id,
                    "FAILED",
                    "TASK_FAILED",
                    Some(&message),
                    json!({ "status": "failed", "summary": message.clone() }),
                );
                Err(message)
            }
        }
    }

    /// 저장된 작업을 **새 task_id로 다시 실행한다.**
    ///
    /// 이전 명령을 자동 재개하지 않는 이유(state-machine-and-protocol.md 7절): 부분 실행된
    /// `ToolRequest`의 재개는 멱등성 보장이 없으면 위험하다. 같은 요청 문구로 처음부터 다시 돈다.
    pub fn restart_task(&self, task_id: &str, timeout: Duration) -> Result<Value, String> {
        let task = self
            .get_task(task_id)?
            .ok_or_else(|| format!("작업을 찾을 수 없습니다: {task_id}"))?;
        let mode = match task.mode.as_deref() {
            Some("fast") => ExecutionMode::Fast,
            _ => ExecutionMode::Verified,
        };
        // 재실행은 커밋을 제안하지 않는다. 저장된 작업 행에는 그 토글이 남아 있지 않고,
        // **기억나지 않는 설정으로 저장소 이력을 바꾸는 것**보다 제안하지 않는 편이 안전하다.
        self.start_task(&task.user_message, mode, false, timeout)
    }

    /// 취소 요청. **두 방향 모두 필요하다:**
    ///  - Rust(`TaskHost`): 실행 중인 자식 프로세스를 죽이고 이후 도구 실행을 거부한다
    ///  - Node(`task.cancel`): 진행 중인 공급자 HTTP 호출을 abort한다
    ///
    /// 한쪽만 하면 취소가 절반만 된다 — Rust만 하면 모델 호출이 계속 돌고,
    /// Node만 하면 이미 시작된 `npm test`가 끝까지 실행된다.
    pub fn cancel_task(&self, task_id: &str) -> Result<Value, String> {
        let guard = self.inner.lock().unwrap();
        let Some(active) = guard.as_ref() else {
            return Err("먼저 워크스페이스를 선택하세요.".to_string());
        };
        let host = active.host.clone();
        let sidecar = active.sidecar.clone();
        drop(guard);

        // 순서: Rust 먼저. 토큰이 켜져야 진행 중인 프로세스가 죽고 새 도구가 시작되지 않는다.
        let rust_outcome = host.cancel_task(task_id)?;
        let node_outcome = sidecar
            .request("task.cancel", json!({ "taskId": task_id }), Duration::from_secs(5))
            .unwrap_or(Value::Null);

        Ok(json!({
            "accepted": rust_outcome.get("accepted").and_then(Value::as_bool).unwrap_or(false),
            "outcome": rust_outcome.get("outcome"),
            "host": rust_outcome,
            "sidecar": node_outcome,
        }))
    }

    /// `decisions`는 3.9절 불일치 카드의 구조적 답변이다(state-machine-and-protocol.md 17.2절).
    ///
    /// **Rust는 내용을 해석하지 않는다.** 어떤 쟁점에 대한 답인지는 Node 상태 머신의 관심사이고,
    /// 신뢰 경계가 판단할 것이 없다 — 이 값으로는 파일도 셸도 건드릴 수 없다. 그대로 통과시킨다
    /// (process-architecture.md 4절: Rust는 승인·정책·실행만 판단한다).
    pub fn provide_user_input(
        &self,
        task_id: &str,
        message: &str,
        decisions: Option<Value>,
    ) -> Result<Value, String> {
        self.with_active(|active| {
            let mut params = json!({ "taskId": task_id, "message": message });
            if let Some(decisions) = decisions.clone() {
                if !decisions.is_null() {
                    params["decisions"] = decisions;
                }
            }
            active
                .sidecar
                .request("task.userInput", params, Duration::from_secs(10))
                .map_err(|e| e)
        })
    }

    /// 강제 포기 — ui-wireframes.md 3.5절, 12절 미해결 "취소 중 상한".
    ///
    /// 취소를 **다시 한 번 보내고** 나서 포기한다. 순서가 중요한 이유: 포기가 "취소를 취소한다"는
    /// 뜻으로 읽히면 안 된다. 죽이려는 시도는 계속하되 **기다리기만** 그만두는 것이다.
    pub fn force_abandon_task(&self, task_id: &str) -> Result<Value, String> {
        let guard = self.inner.lock().unwrap();
        let Some(active) = guard.as_ref() else {
            return Err("먼저 워크스페이스를 선택하세요.".to_string());
        };
        let host = active.host.clone();
        let sidecar = active.sidecar.clone();
        drop(guard);

        // 취소 토큰을 확실히 켠다. 이미 켜져 있으면 idempotent다.
        let _ = host.cancel_task(task_id);
        // sidecar 응답을 **기다리지 않는다** — 응답하지 않는 것이 이 경로의 전제다.
        // 짧은 타임아웃으로 한 번만 밀어 넣고, 실패해도 진행한다.
        let _ = sidecar.request("task.cancel", json!({ "taskId": task_id }), Duration::from_secs(1));

        host.force_abandon(task_id)
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
