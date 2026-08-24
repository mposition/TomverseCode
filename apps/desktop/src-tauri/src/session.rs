//! Tauri 앱의 세션 상태.
//!
//! 이 모듈은 **얇은 어댑터**다. Policy Gate, Tool Runtime, 저장, 검증은 전부 `tomverse-core`에
//! 있고 여기서는 (a) 워크스페이스별 `TaskHost` 생성 (b) 승인 왕복을 UI와 연결 (c) 이벤트 릴레이만 한다.
//!
//! docs/design/process-architecture.md 4절: 승인/거부는 정책 판단의 연장이므로 Rust 책임 소관이며
//! Node를 거치지 않는다. `UiApprovalGateway`가 그 왕복의 Rust 쪽 절반이다.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tomverse_core::artifacts::ArtifactStore;
use tomverse_core::host::{ApprovalGateway, ApprovalOutcome, EventSink, TaskHost};
use tomverse_core::sidecar::{RespawnOutcome, SidecarClient, SidecarSupervisor, MAX_SIDECAR_RESPAWNS};
use tomverse_core::store::{Store, StoreIssue, StoreOp, TaskRow};
use tomverse_core::uimsg::{UiMessage, UserFacing};
use tomverse_core::types::{ApprovalRequest, ExecutionMode, TaskPolicy};
use tomverse_core::{
    available_providers, available_providers_for, credential_env_for, providers_blocked_by_policy,
    CancellationRegistry, WorkspaceRoot, PROTOCOL_VERSION,
};
use tomverse_core::approvals::PendingApprovals;

/// UI에 승인 요청을 emit하고 사용자 응답을 기다린다.
///
/// 타임아웃을 두는 이유(CLAUDE.md 원칙 5 — 상한 없는 대기를 만들지 않는다): UI가 죽거나
/// 사용자가 창을 닫으면 태스크가 영원히 매달린다. 시간이 지나면 **거부**로 처리한다 —
/// "응답이 없으면 허용"은 승인 게이트의 의미를 무너뜨린다.
pub struct UiApprovalGateway {
    app: AppHandle,
    /// **워크스페이스별로 묶인 등록부**(core `approvals.rs`). 낡은 모달의 승인이 다른
    /// 워크스페이스에서 실행되는 것을 막는 지점이 거기다.
    pending: Arc<PendingApprovals>,
    timeout: Duration,
}

impl UiApprovalGateway {
    pub fn new(app: AppHandle, pending: Arc<PendingApprovals>) -> Self {
        Self {
            app,
            pending,
            timeout: Duration::from_secs(600),
        }
    }
}

impl ApprovalGateway for UiApprovalGateway {
    fn request_approval(&self, request: &ApprovalRequest) -> ApprovalOutcome {
        let rx = self.pending.register(&request.approval_id, &request.workspace_root);

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
            self.pending.forget(&request.approval_id);
            return ApprovalOutcome::Denied {
                note: Some("UI에 승인 요청을 전달할 수 없었습니다".to_string()),
            };
        }

        let outcome = rx.recv_timeout(self.timeout).unwrap_or(ApprovalOutcome::Denied {
            note: Some("승인 대기가 시간 초과되었습니다 — 안전을 위해 거부로 처리합니다".to_string()),
        });
        self.pending.forget(&request.approval_id);
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
    /// 이 워크스페이스에서 허용된 공급자 (multi-engine-routing.md 16절).
    ///
    /// **sidecar를 spawn할 때 이 목록으로 자격증명을 걸렀다.** 즉 이 값은 표시용 사본이고,
    /// 실제 강제는 이미 일어났다 — 바꾸려면 sidecar를 다시 띄워야 한다.
    pub allowed_providers: Option<Vec<String>>,
    /// **클라이언트가 아니라 감독자를 들고 있다** (process-architecture.md 5절).
    /// Node가 죽으면 다음 태스크 전에 다시 띄운다 — 종전에는 한 번 닫히면 워크스페이스를
    /// 다시 열기 전까지 모든 요청이 실패했고, 사용자에게는 앱이 죽은 것처럼 보였다.
    sidecar: Arc<SidecarSupervisor>,
}

#[derive(Default)]
pub struct SessionState {
    inner: Mutex<Option<ActiveWorkspace>>,
    pub pending_approvals: Arc<PendingApprovals>,
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

/// 스킬의 모델 지정 위에 화면이 명시한 지정을 덮는다.
///
/// **우선순위를 한 곳에서 정한다**(26.1절). 두 값을 sidecar로 각각 보내면 거기서 다시 정하게
/// 되고, 그러면 규칙이 둘이 된다.
fn merge_model_pins(skill: Option<&tomverse_core::skills::ModelPins>, explicit: Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Some(pins) = skill {
        if let Some(m) = &pins.executor {
            merged.insert("executor".to_string(), Value::String(m.clone()));
        }
        if let Some(m) = &pins.reviewer {
            merged.insert("reviewer".to_string(), Value::String(m.clone()));
        }
    }
    if let Some(obj) = explicit.as_object() {
        for (key, value) in obj {
            // **null은 "지정 없음"이지 "지우기"가 아니다.** 화면이 키만 보내고 값을 비운
            // 경우까지 스킬의 지정을 지우면, 사용자가 스킬로 정한 것이 조용히 사라진다.
            if !value.is_null() {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    if merged.is_empty() {
        Value::Null
    } else {
        Value::Object(merged)
    }
}

impl SessionState {
    /// 앱 시작 시 1회. 저장 계층을 열고 **비정상 종료된 작업을 INTERRUPTED로 확정한다.**
    ///
    /// 자동 재실행하지 않는다(state-machine-and-protocol.md 7절): 부분 실행된 도구의 재개는
    /// 멱등성 보장이 없으면 위험하다. 사용자에게 되돌리기/재실행 선택을 준다.
    /// 실패는 **봉투**로 돌려준다 — 문장이 아니라 코드와 파라미터다(ui-wireframes.md 6절).
    /// 화면이 그 코드로 문장을 만들 수 있어야 카탈로그 밖에 남는 문장이 생기지 않는다.
    pub fn initialize(&self) -> Result<Value, UiMessage> {
        let state_dir = app_state_dir();
        let artifacts = ArtifactStore::new(state_dir.join("artifacts"))
            .map_err(|e| StoreIssue::new(StoreOp::OpenArtifacts, e).ui())?;
        let mut store = Store::open(state_dir.join("state.db"), artifacts.clone())
            .map_err(|e| StoreIssue::new(StoreOp::OpenDatabase, e).ui())?;

        let interrupted = store
            .mark_unfinished_as_interrupted()
            .map_err(|e| StoreIssue::new(StoreOp::RecoverInterrupted, e).ui())?;

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

    /// 저장 계층 접근. **`op`를 반드시 받는다.**
    ///
    /// 종전에는 `Result<T, String>`이라 호출부마다 산문을 지어 붙였고, 새 화면 명령을 만들면서
    /// 그걸 잊으면 아무도 알아채지 못했다 — 실패가 실제로 일어나야만 보이기 때문이다.
    /// 이제 **이름 없는 저장 계층 실패는 타입이 막는다**(ui-wireframes.md 6.5절): 무엇을
    /// 하려던 것인지 말하지 않고는 저장 계층에 닿을 수 없다.
    ///
    /// 실행 경로처럼 화면에 봉투로 나가지 않는 자리는 `.map_err(|ui| ui.message)`로 되돌린다 —
    /// **되돌리는 것은 눈에 보이지만, 빠뜨리는 것은 보이지 않는다.**
    pub fn with_store<T>(&self, op: StoreOp, f: impl FnOnce(&mut Store) -> T) -> Result<T, UiMessage> {
        let store = self
            .store()
            .map_err(|e| StoreIssue::new(op.clone(), e).ui())?;
        let mut guard = store.lock().unwrap();
        Ok(f(&mut guard))
    }

    /// 화면에 봉투로 나가지 **않는** 저장 계층 접근.
    ///
    /// 실행 경로처럼 결과가 사용자 문장이 되지 않는 자리다. **`op`를 받지 않는 대신 이름을
    /// 고르게 한다** — 코드를 만들어 두면 카탈로그에 도착하지 않는 항목이 생기고, 그러면
    /// "카탈로그가 코드를 안다"는 검사가 번역된다는 뜻을 잃는다(ui-wireframes.md 6.5절).
    ///
    /// 이 함수를 고르는 것은 **눈에 보이는 선택**이다. 그게 요점이다: 봉투를 빠뜨리는 것은
    /// 보이지 않지만, 이걸 쓰는 것은 보인다.
    fn with_store_prose<T>(&self, what: &str, f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
        let store = self.store().map_err(|e| format!("{what}: {e}"))?;
        let mut guard = store.lock().unwrap();
        Ok(f(&mut guard))
    }

    /// 안쪽도 `Result`인 흔한 형태 — 두 겹을 한 번에 편다. **같은 `op`가 양쪽에 붙는다**:
    /// 저장 계층이 안 열린 것도, 질의가 실패한 것도 화면에는 같은 실패다.
    fn read_store<T, E: std::fmt::Display>(
        &self,
        op: StoreOp,
        f: impl FnOnce(&mut Store) -> Result<T, E>,
    ) -> Result<T, UiMessage> {
        self.with_store(op.clone(), f)?
            .map_err(|e| StoreIssue::new(op, e).ui())
    }

    // ---- 조회 (UI는 DB에 직접 접근하지 않는다 — 전부 이 경로를 지난다) ----

    pub fn list_tasks(
        &self,
        workspace_path: Option<&str>,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<Vec<TaskRow>, UiMessage> {
        self.read_store(StoreOp::ReadTasks, |s| s.list_tasks(workspace_path, limit, cursor))
    }

    /// 화면이 쓰는 문턱들. **저장된 이벤트에서 유도한다** — 추정값이던 상수들의 자리다
    /// (16.3절 강제 포기 시점, 19.6절 "큰 변경" 안내).
    ///
    /// 워크스페이스를 열 때 한 번만 부른다. 집계가 전체 태스크의 이벤트를 훑기 때문이기도 하지만,
    /// 더 중요한 이유는 **문턱이 한 세션 안에서 흔들리지 않아야** 하기 때문이다 — 안내가 뜨는
    /// 기준이 매번 달라지면 사용자는 그 기준을 배울 수 없다.
    ///
    /// 둘을 한 명령으로 묶는 이유: 같은 집계 한 번에서 나오므로 따로 부르면 같은 훑기를 두 번
    /// 한다. 그리고 문턱이 늘어날 때마다 명령이 늘어나면 UI가 부를 것을 빠뜨리기 쉽다.
    pub fn derived_thresholds(&self, workspace_path: Option<&str>) -> Result<Value, UiMessage> {
        let metrics = self.read_store(StoreOp::ReadThresholds, |s| {
            tomverse_core::metrics::collect(s, workspace_path)
        })?;
        Ok(json!({
            "forceAbandon": metrics.force_abandon_threshold,
            "largeChange": metrics.large_change_threshold,
            // 분포도 함께 준다. 문턱만 주면 화면이 그 숫자의 출처를 설명할 수 없다.
            "latency": metrics.cancellation,
            "commitSizes": metrics.commit_sizes,
            // 태스크당 예산 상한의 **제안값**이다. 화면이 입력란을 채우는 데 쓰고,
            // 사용자가 바꾸면 그 값이 강제된다 — 제안은 승인이 아니다.
            "taskBudget": metrics.task_budget_threshold,
            "taskCosts": metrics.task_costs,
        }))
    }

    /// 이 작업에서 **무엇이 어느 공급자로 나갔는가** (product-strategy 7절).
    ///
    /// 태스크가 끝난 뒤에도 답할 수 있어야 하므로 이벤트와 `provider_usage`에서 만든다 —
    /// 진행 중 상태를 들고 있다가 보여주면 앱을 다시 켠 뒤에는 답하지 못한다.
    pub fn task_transmission(&self, task_id: &str) -> Result<Value, UiMessage> {
        let out = self.read_store(StoreOp::ReadTransmission, |s| {
            tomverse_core::transmission::collect(s, task_id)
        })?;
        serde_json::to_value(out)
            .map_err(|e| StoreIssue::new(StoreOp::ReadTransmission, format!("직렬화: {e}")).ui())
    }

    /// 무인 정지의 처방 (state-machine 24.8절). **읽기 전용이다.**
    pub fn task_blocked(&self, task_id: &str) -> Result<Value, UiMessage> {
        let out = self.read_store(StoreOp::ReadBlocked, |s| tomverse_core::blocked::collect(s, task_id))?;
        serde_json::to_value(out).map_err(|e| StoreIssue::new(StoreOp::ReadBlocked, format!("직렬화: {e}")).ui())
    }

    /// 브랜치를 remote로 올리고 PR 폼 URL을 만든다 (state-machine 28절).
    ///
    /// **읽기 전용이 아니다** — push가 일어난다. 그래서 다른 조회들과 달리 `read_store`가 아니라
    /// 활성 호스트를 지나며, 승인 왕복도 그대로 탄다(28.4절). 호출자는 별도 스레드에서 부른다:
    /// 승인 모달이 뜨는 동안 이 호출이 블록되므로, 같은 스레드면 교착된다.
    pub fn open_pull_request(&self, task_id: &str, remote: &str, base: &str) -> Result<Value, String> {
        let host = self.with_active(|active| Ok(active.host.clone()))?;
        host.open_pull_request(task_id, remote, base)
    }

    /// 이 워크스페이스에서 쓸 공급자를 정한다 (multi-engine-routing.md 16절).
    ///
    /// **즉시 반영되지 않는다.** 강제는 sidecar spawn 시 자격증명을 거르는 것으로 일어나므로,
    /// 이미 떠 있는 sidecar에는 예전 키가 들어 있다. 그래서 저장만 하고 "다시 열어야 적용된다"를
    /// 호출자에게 알린다 — 여기서 몰래 sidecar를 재시작하면 진행 중인 태스크가 죽는다.
    pub fn set_allowed_providers(&self, allowed: Option<Vec<String>>) -> Result<Value, String> {
        let workspace_id = self.with_active(|active| Ok(active.workspace_id.clone()))?;
        // **쓰기이고, 아직 봉투로 전환하지 않은 경계다.** 그래서 코드를 만들지 않는 쪽을
        // 고른다 — 그 선택이 여기 눈에 보인다(6.5절).
        self.with_store_prose("허용 목록을 저장할 수 없습니다", |s| {
            s.set_allowed_providers(&workspace_id, allowed.as_deref())
        })?
        .map_err(|e| format!("허용 목록을 저장할 수 없습니다: {e}"))?;
        Ok(json!({
            "saved": allowed,
            "appliesAfterReopen": true,
            "note": "이미 실행 중인 백엔드에는 이전 자격증명이 주입되어 있습니다. 워크스페이스를 다시 열면 적용됩니다.",
        }))
    }

    /// sidecar가 죽어 있으면 **다음 태스크 전에** 다시 띄운다 (process-architecture.md 5절).
    ///
    /// 재spawn이 진행 중이던 태스크를 살리지는 못한다 — 그 상태는 죽은 프로세스에 있었다.
    /// 여기서 하는 일은 **다음 태스크가 가능해지는 것**뿐이며, 그것도 상한 안에서다.
    fn ensure_sidecar_alive(&self) -> Result<(), String> {
        let supervisor = self.with_active(|active| Ok(active.sidecar.clone()))?;
        match supervisor.ensure_alive() {
            RespawnOutcome::Alive => Ok(()),
            RespawnOutcome::Respawned { attempt } => {
                eprintln!("[session] 백엔드가 종료되어 다시 시작했습니다 ({attempt}/{MAX_SIDECAR_RESPAWNS})");
                Ok(())
            }
            // **사유와 복구 방법은 core에서 온다.** 문장을 여기 두면 조회 경로(`backend_status`)와
            // 갈라지고, 이 크레이트는 개발 환경에서 컴파일되지 않으므로 그 갈라짐이 드러나지 않는다.
            // 여기서는 **원문**을 쓴다. 이 경로의 오류는 태스크 결과 문자열로 흘러가므로
            // 화면이 코드로 문장을 고를 자리가 없다 — 배너 경로(`backend_status`)가 코드를
            // 쓰고, 이 경로는 그때까지의 대체 표시다.
            other => match other.failure() {
                Some(issue) => Err(issue.korean()),
                // `failure()`가 None인 것은 성공뿐이고 그건 위에서 처리했다.
                None => Ok(()),
            },
        }
    }

    /// 백엔드 상태 조회. **아무것도 다시 띄우지 않는다** — 물었더니 재spawn이 일어나면
    /// 그건 조회가 아니다.
    ///
    /// 화면이 "다시 열기" 버튼을 띄울지는 `recovery` 값이 정한다. 안내 문장을 문자열로
    /// 비교하게 두면 문구를 다듬는 순간 버튼이 사라진다.
    pub fn backend_status(&self) -> Result<Value, String> {
        let guard = self.inner.lock().unwrap();
        let Some(active) = guard.as_ref() else {
            // 워크스페이스가 없는 것은 백엔드 고장이 아니다. 같은 칸에 넣으면 앱을 켜자마자
            // "백엔드에 문제가 있습니다"가 뜬다.
            return Ok(json!({ "state": "noWorkspace" }));
        };
        Ok(serde_json::to_value(active.sidecar.status()).unwrap_or(Value::Null))
    }

    /// 자격증명 확인 (multi-engine-routing.md 17절).
    ///
    /// **유료 호출을 하지 않는다** — sidecar가 무료 모델 조회 엔드포인트만 쓴다.
    /// 그래서 이 버튼은 예산 상한과 무관하고, 누른다고 돈이 나가지 않는다.
    pub fn probe_providers(&self, timeout: Duration) -> Result<Value, String> {
        let (sidecar, allowed) =
            self.with_active(|active| Ok((active.sidecar.client(), active.allowed_providers.clone())))?;
        sidecar.request(
            "providers.probe",
            json!({ "availableProviders": available_providers_for(allowed.as_deref()) }),
            timeout,
        )
    }

    /// 이 자격증명으로 실제로 쓸 수 있는 모델 목록 (multi-engine-routing.md 15절).
    ///
    /// **sidecar에 묻는다** — 레지스트리는 Node의 것이고, Rust가 별도 목록을 들고 있으면 두
    /// 목록이 갈라져 "화면에서는 고를 수 있는데 시작하면 거부되는" 모델이 생긴다.
    pub fn list_models(&self, timeout: Duration) -> Result<Value, String> {
        let (sidecar, allowed) =
            self.with_active(|active| Ok((active.sidecar.client(), active.allowed_providers.clone())))?;
        sidecar.request(
            "models.list",
            // **허용 목록을 여기서도 적용한다.** 목록에 없는 공급자의 모델을 고를 수 있게
            // 보여주면, 고른 뒤 "키가 없다"는 오류를 만나게 된다 — 키는 있고 정책이 막은 것인데.
            json!({ "availableProviders": available_providers_for(allowed.as_deref()) }),
            timeout,
        )
    }

    /// 한 작업의 **감사 export**를 만든다 (product-strategy 6절).
    ///
    /// **값을 돌려줄 뿐 파일을 쓰지 않는다.** 임의 경로 쓰기를 UI가 시킬 수 있게 만들면
    /// 모델 요청이 Policy Gate를 지나야 한다는 규칙과 나란히, 게이트를 지나지 않는 두 번째
    /// 쓰기 경로가 생긴다. 파일로 떨구는 것은 `tomverse-host export`가 한다.
    pub fn task_export(&self, task_id: &str) -> Result<Value, String> {
        // **export 본문에 봉투 키를 섞지 않는다.** 이건 감사자가 그대로 복사해 가는 문서이고
        // `reproduce`가 읽는 입력이다 — 여기에 `ok`가 끼면 우리가 만든 기록이 아니게 된다.
        // 그래서 봉투가 감쌀 자리를 따로 만든다.
        let export = self.read_store(StoreOp::ReadExport, |s| tomverse_core::export::collect(s, task_id))?;
        Ok(json!({ "export": export }))
    }

    /// 작업 상세를 이루는 세 읽기는 **하나의 사용자 동작**이다("이 작업을 연다").
    /// 그래서 셋 다 같은 코드를 낸다 — 무엇을 하려다 실패했는가가 코드이고, 어느 읽기였는지는
    /// `detail`에 남는다(ui-wireframes.md 6.5절).
    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRow>, UiMessage> {
        self.read_store(StoreOp::ReadTask, |s| s.get_task(task_id))
    }

    pub fn get_task_events(&self, task_id: &str, after_event_id: Option<i64>) -> Result<Value, UiMessage> {
        let events = self
            .read_store(StoreOp::ReadTaskEvents, |s| s.events_after(task_id, after_event_id))?;
        // **배열이 아니라 객체로 돌려준다.** 봉투가 `ok`를 얹을 자리가 있어야 하고,
        // 배열에는 키를 얹을 수 없다.
        Ok(json!({ "events": events
            .into_iter()
            .map(|e| json!({
                "eventId": e.event_id,
                "seq": e.seq,
                "type": e.event_type,
                "phase": e.phase,
                "payload": e.payload,
                "createdAt": e.created_at,
            }))
            .collect::<Vec<_>>() }))
    }

    /// 저장된 mutation 목록 — INTERRUPTED 작업의 "되돌리기" 버튼이 이걸 보고 판단한다.
    pub fn task_mutations(&self, task_id: &str) -> Result<Vec<String>, UiMessage> {
        self.read_store(StoreOp::ReadTask, |s| s.mutated_paths(task_id))
            .map_err(|ui| StoreIssue::new(StoreOp::ReadTask, format!("변경 목록 — {}", ui.message)).ui())
    }

    /// 저장된 작업의 확정 기준. 히스토리에서 지난 작업을 열었을 때도 "무엇을 결정했는가"가
    /// 보여야 한다 — 그 화면에는 FinalResult가 없고 DB뿐이다.
    pub fn task_acceptance_criteria(&self, task_id: &str) -> Result<Value, UiMessage> {
        let rows = self
            .read_store(StoreOp::ReadTask, |s| s.acceptance_criteria(task_id))
            .map_err(|ui| StoreIssue::new(StoreOp::ReadTask, format!("기준 목록 — {}", ui.message)).ui())?;
        Ok(serde_json::to_value(rows).unwrap_or(Value::Null))
    }

    /// 워크스페이스를 열고 sidecar를 spawn한다. 이미 열려 있으면 교체한다.
    pub fn open_workspace(&self, app: &AppHandle, path: &str, policy: TaskPolicy) -> Result<Value, String> {
        let root = WorkspaceRoot::new(path).map_err(|e| format!("워크스페이스를 열 수 없습니다: {e}"))?;

        let artifacts = self.artifacts()?;
        let store = self.store()?;

        let workspace_id = tomverse_core::paths::workspace_id_for(&root.display());
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

        // 허용 목록을 **spawn 전에** 읽는다. 읽지 못하면 진행하지 않는다 —
        // 깨진 기록을 "제한 없음"으로 읽으면 사용자가 건 제한이 조용히 사라진다.
        let allowed_providers = {
            let guard = store.lock().unwrap();
            guard
                .allowed_providers(&workspace_id)
                .map_err(|e| format!("공급자 허용 목록을 읽을 수 없습니다: {e}"))?
        };

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
        // 재spawn이 **같은 설정으로** 일어나야 하므로 spawn 방법을 클로저로 넘긴다.
        // 자격증명은 이 클로저 안에서 매번 다시 읽는다 — 감독자가 키 사본을 들고 있지 않다.
        let allowed_for_spawn = allowed_providers.clone();
        let host_for_spawn = host.clone();
        // **PATH가 인터프리터를 고르게 두지 않는다**(launcher.rs). 여기서 한 번 해석해
        // 재spawn까지 같은 것을 쓴다 — 재spawn마다 다시 찾으면 그 사이 PATH가 바뀌었을 때
        // 두 번째 sidecar가 첫 번째와 다른 런타임으로 뜬다.
        let launcher = tomverse_core::launcher::detect()?;
        if !launcher.is_bundled() {
            // 배포판에서 이게 뜨면 번들이 깨진 것이다. 조용히 넘어가면 그 사실을 아무도 모른다.
            eprintln!("[sidecar] 동봉 런타임이 아닙니다:\n{}", launcher.describe_failure());
        }
        let launcher_for_spawn = launcher.clone();
        let supervisor = SidecarSupervisor::new(Box::new(move || {
            SidecarClient::spawn(
                // **여기가 게이트다.** 허용되지 않은 공급자의 키를 주입하지 않으면 Node는
                // 그 공급자를 호출할 수단 자체가 없다 — 검사를 지워도 키가 없다.
                tomverse_core::launcher::config_from(
                    &launcher_for_spawn,
                    credential_env_for(allowed_for_spawn.as_deref()),
                ),
                host_for_spawn.clone(),
            )
        }))
        .map_err(|e| {
            // 무엇을 어디서 찾았는지 붙인다 — `No such file or directory`만 보여주면
            // 사용자가 할 수 있는 일이 없다.
            format!("백엔드(sidecar)를 시작할 수 없습니다: {e}\n{}", launcher.describe_failure())
        })?;
        let supervisor = Arc::new(supervisor);
        let sidecar = supervisor.client();

        let ready = sidecar.wait_ready(Duration::from_secs(10))?;
        let sidecar_version = ready.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        if sidecar_version != PROTOCOL_VERSION {
            sidecar.shutdown(Duration::from_secs(2));
            return Err(format!(
                "백엔드 프로토콜 버전이 맞지 않습니다 (앱 {PROTOCOL_VERSION} / 백엔드 {sidecar_version}). 앱을 업데이트하세요."
            ));
        }
        // 런타임 버전 확인 — 판정과 문장은 core에 있다(launcher.rs).
        if let Err(message) =
            tomverse_core::launcher::require_supported_node(ready.get("nodeVersion").and_then(Value::as_str), &launcher)
        {
            sidecar.shutdown(Duration::from_secs(2));
            return Err(message);
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
            previous.sidecar.client().shutdown(Duration::from_secs(3));
            // **떠나는 워크스페이스의 대기 승인을 거부로 정리한다.** 남겨두면 타임아웃(10분)까지
            // 살아 있고, 그동안 낡은 모달에서 누른 승인이 이전 워크스페이스에서 실행될 창이
            // 열려 있다. 거부가 기본인 이유는 승인 타임아웃과 같다.
            let revoked = self
                .pending_approvals
                .revoke_workspace(&previous.root_display, "워크스페이스가 바뀌어 승인 요청을 취소했습니다");
            if revoked > 0 {
                eprintln!("[session] 이전 워크스페이스의 대기 승인 {revoked}건을 거부로 정리했습니다");
            }
        }
        *guard = Some(ActiveWorkspace {
            root_display: root.display(),
            name,
            host,
            workspace_id,
            session_id,
            allowed_providers,
            sidecar: supervisor,
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
                // 허용 목록과 **그 때문에 빠진 공급자**를 함께 준다. "키가 없다"와 "정책이
                // 막았다"는 다른 사실이고, 화면이 뭉개면 사용자는 없는 키를 찾아 헤맨다.
                "allowedProviders": active.allowed_providers,
                "providersBlockedByPolicy": providers_blocked_by_policy(active.allowed_providers.as_deref()),
            })
        })
    }

    /// 태스크 시작. sidecar 요청이 끝날 때까지 블록되므로 호출자는 별도 스레드에서 부른다.
    /// `allow_git_commit`은 **커밋을 제안할지**를 정할 뿐 승인 등급을 낮추지 않는다.
    ///
    /// # 정책의 수명은 **태스크**다 (ui-wireframes 3.16.2절)
    ///
    /// 종전에는 Rust `TaskPolicy`가 워크스페이스를 열 때 고정되고 여기서 바뀌지 않았다.
    /// 그 결정의 이유는 지금도 유효하다 — **UI에서 켠 스위치가 신뢰 경계의 위험 등급을 낮출 수
    /// 있으면 그건 게이트가 아니다**(원칙 2·3). 그래서 `allow_git_commit` 토글은 지금도 게이트를
    /// 건드리지 않는다: `git commit`은 계속 High 승인이고, 토글이 정하는 것은 "커밋을 제안할
    /// 것인가"뿐이다.
    ///
    /// 바뀐 것은 **어떤 필드가 태스크마다 달라져도 되는가**이고, 그 판정은 방향으로 한다:
    ///
    ///  - `allowed_tools`(Skills)는 **좁힌다** — 어떤 도구도 새로 허용되지 않는다(26.3절).
    ///  - `unattended`(Autopilot)는 넓히지도 좁히지도 않는다 — 승인을 *묻지 않고 멈춘다*(24.2절).
    ///  - `auto_approve_verification`은 **넓힌다.** 그런데도 받는 이유는 대상 집합을
    ///    **Rust가 매니페스트에서 유도해 태스크 시작 시점에 고정**하기 때문이다(24.5절).
    ///
    /// **넓히는 방향은 이것이 마지막이어야 한다.** 위 셋이 통과하는 이유는 각각 다르고,
    /// 그 이유가 없는 필드는 통과하지 못한다.
    /// `budget_usd`가 `None`이면 **상한 없이** 실행한다 — 사용자가 명시적으로 고른 경우이거나
    /// (가격을 모르는 모델) 화면이 그렇게 보낸 경우다. 값을 우리가 대신 채워 넣지 않는다:
    /// 상한은 사용자의 승인이고, 코드가 만들어낸 승인은 승인이 아니다.
    #[allow(clippy::too_many_arguments)]
    pub fn start_task(
        &self,
        message: &str,
        mode: ExecutionMode,
        allow_git_commit: bool,
        budget_usd: Option<f64>,
        model_pins: Value,
        /// 무인 실행 (state-machine 24절). 승인이 필요한 지점에서 **멈춘다**.
        unattended: bool,
        /// 프로젝트가 매니페스트에 선언해 둔 검증 명령을 묻지 않고 실행한다 (24.5절).
        auto_approve_verification: bool,
        /// 스킬 파일 경로 (26절). **Rust가 읽는다** — 도구 허용목록의 출처가 UI가 되면
        /// 장악당한 UI가 "허용목록은 전부입니다"라고 말할 수 있다.
        skill_path: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        // **태스크를 시작하기 전에** 살아 있는지 확인한다(5절). 도중에 바꿔치기하면 진행 중인
        // 요청이 어느 프로세스의 것인지 알 수 없게 되므로, 재spawn 지점은 여기 한 곳이다.
        self.ensure_sidecar_alive()?;

        let (sidecar, host, workspace_id, session_id, allowed_providers) = self.with_active(|active| {
            Ok((
                active.sidecar.client(),
                active.host.clone(),
                active.workspace_id.clone(),
                active.session_id.clone(),
                active.allowed_providers.clone(),
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
        host.with_store_prose("태스크를 만들 수 없습니다", |s| {
            s.create_task(&task_id, &session_id, &workspace_id, &workspace_path, mode_str, message)
        })
            .map_err(|e| format!("태스크를 만들 수 없습니다: {e}"))?;

        // 스킬 파일은 **Rust가 읽는다**(26.1절). 화면이 읽어 넘기면 도구 허용목록의 출처가
        // 화면이 되고, 그러면 장악당한 화면이 "허용목록은 전부입니다"라고 말할 수 있다.
        let skill = match skill_path {
            None => None,
            Some(path) => Some(tomverse_core::skills::load(std::path::Path::new(path)).map_err(|e| e.to_string())?),
        };

        // **이 태스크의 정책을 여기서 정하고, 여기서만 정한다.** 등록은 한 번뿐이므로
        // 진행 중에 바뀌지 않는다(3.16.2절).
        let task_policy = TaskPolicy {
            execution_mode: mode,
            allow_git_commit,
            unattended,
            auto_approve_verification,
            allowed_tools: skill.as_ref().and_then(|s| s.allowed_tools.clone()),
            ..TaskPolicy::default()
        };
        host.begin_task(&task_id, task_policy)?;

        // 스킬의 모델 지정은 화면이 명시한 지정에 **진다** — 우선순위를 한 곳에서 정한다(26.1절).
        let model_pins = merge_model_pins(skill.as_ref().and_then(|s| s.model_pins.as_ref()), model_pins);

        // 세션 메모리는 **Rust가 저장소에서 유도한다**(27.1절). 화면 경로에서는 세션이 실제로
        // 여러 태스크를 담으므로, 헤드리스와 달리 이 값이 대체로 비어 있지 않다.
        //
        // **읽지 못하면 태스크를 시작하지 않는다.** 조용히 빈 값으로 넘어가면 사용자가 앞서
        // 정한 것이 이번 태스크에서 사라지고, 그 사실은 아무 데도 보이지 않는다.
        let memory = self
            .read_store(StoreOp::ReadSessionMemory, |s| {
                tomverse_core::session_memory::collect(s, &session_id, &task_id)
            })
            .map_err(|m| m.text.clone())?;

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
                // null은 "기본값을 쓰라"가 아니라 **"상한 없음"**이다. sidecar의 mergePolicy가
                // 키의 부재와 null을 구별하므로 여기서 항상 키를 넣는다.
                "budgetUsd": budget_usd,
                // 역할별 모델 지정. **Rust는 값을 해석하지 않고 그대로 넘긴다** — 모델 목록은
                // Node의 것이고, 여기서 검증하면 두 곳이 서로 다른 규칙을 갖게 된다.
                "modelPins": model_pins,
                "unattended": unattended,
                "autoApproveVerification": auto_approve_verification,
                // 화면은 이 목록을 **지키지 않는다** — 지키는 것은 Rust의 게이트다(26.1절).
                "allowedTools": skill
                    .as_ref()
                    .and_then(|s| s.allowed_tools.as_ref())
                    .map(|t| t.iter().map(|x| x.as_str()).collect::<Vec<_>>()),
            },
            "skill": skill.as_ref().map(|s| json!({ "name": s.name, "instructions": s.instructions })),
            "sessionMemory": if memory.is_empty() {
                Value::Null
            } else {
                json!({
                    "text": memory.render(),
                    "decisionCount": memory.decisions.len(),
                    "truncated": memory.truncated,
                })
            },
            "workspaceName": self.info().and_then(|i| i.get("name").cloned()).unwrap_or(Value::Null),
            // 라우터가 보는 후보도 같은 목록이어야 한다 — 주입된 키와 후보가 어긋나면
            // "고를 수 있다고 했는데 호출이 실패"가 된다.
            "availableProviders": available_providers_for(allowed_providers.as_deref()),
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
                    let mutated = host
                        .with_store(StoreOp::ReadTask, |s| s.mutated_paths(&task_id))
                        .unwrap_or_default();
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
    pub fn restart_task(
        &self,
        task_id: &str,
        budget_usd: Option<f64>,
        model_pins: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        // 여기는 화면이 그리는 실패 경로가 아니라 재실행 중의 내부 조회다 — 봉투를 산문으로
        // 되돌려 기존 흐름에 넘긴다. 봉투가 필요한 것은 **화면이 문장을 만드는 자리**뿐이다.
        let task = self
            .get_task(task_id)
            .map_err(|ui| ui.message)?
            .ok_or_else(|| format!("작업을 찾을 수 없습니다: {task_id}"))?;
        let mode = match task.mode.as_deref() {
            Some("fast") => ExecutionMode::Fast,
            _ => ExecutionMode::Verified,
        };
        // 재실행은 커밋을 제안하지 않는다. 저장된 작업 행에는 그 토글이 남아 있지 않고,
        // **기억나지 않는 설정으로 저장소 이력을 바꾸는 것**보다 제안하지 않는 편이 안전하다.
        // **다시 실행은 새 승인이다.** 이전 태스크의 상한을 이어받지 않고 화면이 준 값을 쓴다 —
        // 상한이 태스크당이라는 결정의 직접적 귀결이고, 그 사실은 화면이 말해야 한다.
        // **다시 실행은 새 태스크다**(16.6절). 그래서 원래 태스크의 정책을 물려받지 않는다 —
        // 무인 실행이었다면 이번에도 무인일 이유가 없고, 스킬을 골랐다면 이번에도 그것을
        // 고를지는 사용자가 정할 일이다. 물려받게 하려면 화면이 그것을 **보여준 뒤**여야 한다.
        self.start_task(
            &task.user_message,
            mode,
            false,
            budget_usd,
            model_pins,
            false,
            false,
            None,
            timeout,
        )
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
        // **취소는 재spawn하지 않는다.** 취소가 향하는 곳은 그 태스크를 돌리고 있는
        // 프로세스이고, 그게 죽었다면 태스크도 함께 죽었다 — 새로 띄운 프로세스에
        // 취소를 보내는 것은 아무 의미가 없다.
        let sidecar = active.sidecar.client();
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
                .client()
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
        // **취소는 재spawn하지 않는다.** 취소가 향하는 곳은 그 태스크를 돌리고 있는
        // 프로세스이고, 그게 죽었다면 태스크도 함께 죽었다 — 새로 띄운 프로세스에
        // 취소를 보내는 것은 아무 의미가 없다.
        let sidecar = active.sidecar.client();
        drop(guard);

        // 취소 토큰을 확실히 켠다. 이미 켜져 있으면 idempotent다.
        let _ = host.cancel_task(task_id);
        // sidecar 응답을 **기다리지 않는다** — 응답하지 않는 것이 이 경로의 전제다.
        // 짧은 타임아웃으로 한 번만 밀어 넣고, 실패해도 진행한다.
        let _ = sidecar.request("task.cancel", json!({ "taskId": task_id }), Duration::from_secs(1));

        host.force_abandon(task_id)
    }

    /// 승인 응답. **활성 워크스페이스의 것만 받는다**(core `approvals.rs`).
    ///
    /// 화면이 낡은 모달을 들고 있을 수 있고, 그때 승인이 통과하면 사용자가 보고 있지 않은
    /// 저장소에서 명령이 돈다 — 이전 워크스페이스의 `TaskHost`가 그 워크스페이스 루트로
    /// 판정하기 때문이다.
    pub fn respond_approval(&self, approval_id: &str, granted: bool, note: Option<String>) -> Result<Value, String> {
        let active_root = self.with_active(|active| Ok(active.root_display.clone()))?;
        let outcome = if granted {
            ApprovalOutcome::Granted
        } else {
            ApprovalOutcome::Denied { note }
        };
        // **실패도 `Ok` 봉투로 돌려준다.** Tauri의 `Err`는 문자열 하나뿐이라 구조가 들어갈
        // 자리가 없고, 문자열에 구조를 실으면 화면이 문장을 파싱하게 된다 — 그건 6절이
        // 없애려는 바로 그것이다.
        //
        // 봉투를 만드는 자리는 **한 곳**이다(`tomverse_core::uimsg::envelope`). 경계마다 직접 조립하면
        // 키 이름이 갈라지고, 화면은 그 갈래마다 다른 읽기를 갖게 된다 — 실제로 `store-ready`가
        // `message` 대신 `error`를 쓰고 있었다.
        Ok(tomverse_core::uimsg::envelope(
            self.pending_approvals
                .respond(approval_id, &active_root, outcome)
                .map(|()| json!({}))
                .map_err(|issue| tomverse_core::uimsg::UserFacing::ui(&issue)),
        ))
    }
}

/// `%APPDATA%/Tomverse Code/` (Windows) 또는 대응 위치.
fn app_state_dir() -> PathBuf {
    ArtifactStore::default_root()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".tomverse"))
}

