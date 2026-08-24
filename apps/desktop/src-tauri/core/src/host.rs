//! TaskHost — 신뢰 경계의 조립점.
//!
//! Node sidecar가 보내는 모든 요청이 여기를 지난다. 순서가 불변식이다:
//!
//!   ToolRequest 수신 → Policy Gate 평가 → (필요시) 사용자 승인 대기 → Tool Runtime 실행
//!                   → 이벤트 로그 기록 → 결과 반환
//!
//! 어느 단계도 건너뛸 수 없다. 특히 승인 왕복은 Node를 거치지 않고 Rust가 직접 UI와 주고받는다
//! (process-architecture.md 4절 — 승인은 정책 판단의 연장이므로 Rust 책임 소관).

use crate::artifacts::ArtifactStore;
use crate::cancel::{CancelOutcome, CancellationRegistry, CancellationToken};
use crate::decisions;
use crate::paths::WorkspaceRoot;
use crate::policy::{parse_run_command, secrets, PolicyGate};
use crate::sidecar::{IpcLineMeter, SidecarHandler};
use crate::store::{AppendedEvent, Store, StoreError, TerminalOutcome};
use crate::time::now_iso;
use crate::tools::{ToolRuntime, MAX_INLINE_OUTPUT_BYTES};
use crate::types::{
    ApprovalRequest, ApprovalRequestItem, PolicyDecision, RiskTier, TaskPolicy, ToolName, ToolRequest, ToolResult,
    ToolStatus, VerificationPhase, VerificationReport,
};
use crate::verify::{CommandExecutor, VerificationRunner};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 사용자 승인을 구하는 방법. Tauri는 UI로 emit하고 응답을 기다리며, 헤드리스 호스트/테스트는
/// 정책적으로 자동 승인/거부한다.
///
/// trait으로 둔 이유: "테스트에서 자동 승인"이 프로덕션 코드 경로에 `if cfg!(test)` 같은
/// 분기로 새어들지 않게 하려는 것이다.
pub trait ApprovalGateway: Send + Sync {
    fn request_approval(&self, request: &ApprovalRequest) -> ApprovalOutcome;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Granted,
    Denied { note: Option<String> },
    /// **물을 사람이 없다** — 무인 실행(Autopilot)에서 승인이 필요한 지점에 닿았다.
    ///
    /// `Denied`와 나누는 이유: 뭉개면 최종 보고가 **"사용자가 거부했다"고 거짓말한다.**
    /// 사용자는 아무것도 거부한 적이 없고, 다음에 할 일도 다르다 — 거부는 요청을 다시
    /// 생각하라는 뜻이고, 이쪽은 사람이 붙어서 한 번 봐 달라는 뜻이다.
    Unattended,
}

/// 모든 승인을 허용. **테스트 전용이며 제품의 Autopilot이 아니다.**
///
/// Autopilot은 승인을 대신해 주지 않는다(`UnattendedStop`). 이 둘을 같은 것으로 쓰면
/// "무인 실행"이 곧 "전부 자동 승인"이 되어 Policy Gate의 `RequireUserApproval`이
/// 의미를 잃는다 — MCP 호출까지 포함해서(state-machine 23.3절).
pub struct AutoApprove;
impl ApprovalGateway for AutoApprove {
    fn request_approval(&self, _request: &ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Granted
    }
}

/// 모든 승인을 거부 — "승인 거부" 경로 테스트와 읽기 전용 모드에 쓴다.
pub struct AlwaysDeny;
impl ApprovalGateway for AlwaysDeny {
    fn request_approval(&self, _request: &ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Denied {
            note: Some("자동 거부 정책".to_string()),
        }
    }
}

/// **Autopilot** — 무인 실행 (product-strategy 8.2절, state-machine 24절).
///
/// 정책이 자동 허용하는 것은 그대로 진행하고, **사람이 필요한 지점에 닿으면 멈춘다.**
/// 대신 승인해 주지 않는 것이 이 게이트웨이의 전부다.
///
/// "승인 정책은 그대로 적용"이라는 출시 기준을 이렇게 읽는다: 게이트의 분류를 바꾸지 않는다.
/// 더 많은 것을 무인으로 돌리고 싶으면 **정책을 미리 넓히는 것**이 사용자의 수단이다
/// (`auto_approve_workspace_writes` 등) — 그건 사전에, 보이는 곳에서, 워크스페이스 단위로
/// 내리는 결정이다. 실행 중에 우리가 대신 눌러 주는 것과는 다르다.
pub struct UnattendedStop;
impl ApprovalGateway for UnattendedStop {
    fn request_approval(&self, _request: &ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Unattended
    }
}

/// UI로 이벤트를 내보내는 통로 (Tauri emit 또는 헤드리스 로거).
pub trait EventSink: Send + Sync {
    fn emit(&self, channel: &str, payload: &Value);
}

pub struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _channel: &str, _payload: &Value) {}
}

/// 한 태스크의 정책과 **그로부터 유도된 것들**. 태스크 수명 동안 불변이다.
///
/// # 왜 정책의 수명이 태스크인가
///
/// 종전에는 `TaskHost`가 정책 하나를 들고 있었고, UI 경로에서 그것은 **워크스페이스를 열 때
/// 고정**됐다. 그 결정에는 이유가 있었다(`session.rs`): *"UI에서 켠 스위치가 신뢰 경계의 위험
/// 등급을 낮출 수 있으면 그건 게이트가 아니다."* 그런데 그 대가로 **태스크마다 다른 정책이
/// 필요한 기능들이 전부 배선될 수 없었다** — Autopilot·Skills·검증 명령 자동 승인
/// (ui-wireframes 3.16.2절).
///
/// 정책을 가변 필드로 바꿔 태스크마다 갈아끼우는 것이 가장 짧은 길인데, 그러면 **진행 중인
/// 태스크의 게이트가 도중에 바뀔 수 있다.** 승인 화면이 보여준 근거와 실행 시점의 근거가
/// 달라지고, 그건 이 게이트가 파는 성질을 직접 깨뜨린다.
///
/// 그래서 갈아끼우지 않고 **태스크별로 하나씩 만든다.** 등록은 한 번뿐이고(`begin_task`),
/// 그 뒤로 그 태스크의 정책은 바뀌지 않는다.
///
/// # 검증 명령 고정이 여기로 온 것도 같은 이유다
///
/// 24.5절은 자동 승인 대상을 **태스크 시작 시점**에 고정한다고 적었는데, 호스트가 워크스페이스
/// 수명을 갖는 UI 경로에서는 그게 **워크스페이스 열 때**였다. 문서와 코드가 갈라져 있었다.
/// 프로필이 태스크마다 만들어지므로 이제 문서대로 동작한다.
pub struct TaskProfile {
    pub policy: TaskPolicy,
    gate: PolicyGate,
    /// **이 프로필이 만들어진 시점에** 프로젝트가 선언해 두었던 검증 명령 (program, args).
    ///
    /// `auto_approve_verification`이 켜졌을 때 자동 승인의 유일한 근거다. 매번 다시 탐지하지
    /// 않는 이유는 24.5절에 있다 — `detect_commands`는 매니페스트에서 유도하므로 모델이 명령을
    /// **지어낼** 수는 없지만, 모델은 매니페스트를 **고칠** 수 있다.
    verification_pin: Vec<(String, Vec<String>)>,
    /// 같은 시점의 **매니페스트 내용** 지문.
    ///
    /// # argv를 고정해도 본문은 고정되지 않는다
    ///
    /// 24.5절의 고정은 명령의 **이름**을 지킨다: 모델이 `scripts.lint`를 새로 추가해도 그
    /// 명령은 자동 승인 집합에 없다. 그런데 `npm test`의 argv는 그대로 두고 `scripts.test`의
    /// **본문**을 바꾸면, 고정된 argv가 다른 프로그램을 돌린다. 훅도 같다 — 등록된
    /// `npm run fmt`의 본문이 바뀌면 등록이 승인한 것과 실제로 도는 것이 달라진다(25.3절).
    ///
    /// 그래서 사전 승인은 **매니페스트가 그대로일 때만** 유효하다. 바뀌었으면 자동 승인을
    /// 취소하고 평소대로 묻는다(무인이면 멈춘다) — 막는 것이 아니라 **사람에게 되돌린다.**
    manifest_fingerprint: String,
}

impl TaskProfile {
    pub fn new(root: &WorkspaceRoot, policy: TaskPolicy) -> Self {
        let gate = PolicyGate::new(&policy);
        // 아직 아무것도 고치지 않은 시점의 매니페스트를 읽는다. 이 호출이 뒤로 밀리면
        // 고정의 의미가 사라진다.
        let verification_pin = crate::verify::detect_commands(root)
            .commands
            .values()
            .map(|(_, cmd, _)| (cmd.program.clone(), cmd.args.clone()))
            .collect();
        Self {
            policy,
            gate,
            verification_pin,
            manifest_fingerprint: manifest_fingerprint(root),
        }
    }
}

/// 검증 명령의 **본문이 사는 파일들**의 지문.
///
/// 이름이 아니라 내용을 센다. 없는 파일과 빈 파일을 구별하기 위해 존재 여부도 함께 넣는다 —
/// 뭉개면 파일이 새로 생긴 것을 못 본다.
fn manifest_fingerprint(root: &WorkspaceRoot) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    // **목록을 손으로 적는다.** `detect_commands`가 읽는 것과 같아야 하는데, 거기서 유도하려면
    // 그 함수가 경로를 돌려줘야 하고 그건 지금 하는 일이 아니다. 대신 새 매니페스트를 지원할 때
    // 이 목록도 함께 늘려야 한다는 것을 `manifest_fingerprint_covers_what_detect_reads`가 지킨다.
    for name in ["package.json", "Cargo.toml"] {
        hasher.update(name.as_bytes());
        match std::fs::read(root.path().join(name)) {
            Ok(bytes) => {
                hasher.update([1u8]);
                hasher.update(&bytes);
            }
            Err(_) => hasher.update([0u8]),
        }
    }
    format!("{:x}", hasher.finalize())
}

pub struct TaskHost {
    root: WorkspaceRoot,
    /// 태스크에 속하지 않는 요청(되돌리기·PR 등)이 쓰는 프로필. 워크스페이스 수명이다.
    default_profile: Arc<TaskProfile>,
    /// task_id별 프로필. **등록은 한 번뿐이다.**
    profiles: Mutex<std::collections::HashMap<String, Arc<TaskProfile>>>,
    runtime: ToolRuntime,
    /// 저장 계층은 **공유**한다. Tauri가 활성 워크스페이스 없이도 작업 목록을 조회해야 하고
    /// (앱 재시작 직후), 여러 컴포넌트가 각자 Store를 열면 SQLite 단일 writer 원칙이 깨진다.
    store: Arc<Mutex<Store>>,
    artifacts: ArtifactStore,
    approvals: Arc<dyn ApprovalGateway>,
    sink: Arc<dyn EventSink>,
    /// task_id별 취소 신호. M0에서는 호스트당 플래그 하나였으나, 작업 목록/재실행이 생기면서
    /// "어느 태스크를 취소하는가"를 구별해야 한다.
    cancels: Arc<CancellationRegistry>,
    /// baseline 검증 리포트 — post 리포트가 "새로 깨진 것"을 계산할 때 쓴다.
    baseline: Mutex<Option<VerificationReport>>,
    /// 사용자가 등록한 phase 훅 (hooks.rs, state-machine 25절). 비어 있으면 아무것도 하지 않는다.
    hooks: crate::hooks::HookRegistry,
    /// 훅 실행 중인가 — 훅이 훅을 부르는 것을 **구조적으로** 막는다.
    ///
    /// 지금은 훅 실행이 `PHASE_CHANGED`를 만들지 않으므로 재귀가 나지 않지만, 그건 지금의
    /// 사실이지 규칙이 아니다. 규칙으로 두지 않으면 나중에 누군가 훅 안에서 phase를 옮기는
    /// 경로를 만들고 **상한 없는 루프**가 생긴다(원칙 5).
    in_hook: std::sync::atomic::AtomicBool,
    /// 이번 태스크에서 마지막으로 만들어진 diff 모음 (UI 표시용)
    diffs: Mutex<Vec<(String, String)>>,
    /// IPC 한 줄 크기를 재는 쪽 (process-architecture.md 3.1절 — 32 MiB가 맞는지).
    ///
    /// **생성자 인자가 아니라 나중에 붙인다.** 호스트가 먼저 만들어지고 그 호스트를 handler로
    /// 삼아 sidecar를 띄우므로, 만들 때는 잴 대상이 아직 없다. 없으면 그냥 재지 않는다 —
    /// 계측이 없다고 태스크를 세우지 않는다.
    ipc_meter: Mutex<Option<std::sync::Weak<dyn IpcLineMeter>>>,
}

impl TaskHost {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root: WorkspaceRoot,
        policy: TaskPolicy,
        store: Arc<Mutex<Store>>,
        artifacts: ArtifactStore,
        approvals: Arc<dyn ApprovalGateway>,
        sink: Arc<dyn EventSink>,
        cancels: Arc<CancellationRegistry>,
    ) -> Self {
        // **도구 실행 상한은 호스트 수명이다.** 태스크별로 바꿀 수 있게 하면 화면 토글이
        // 실행 중인 명령의 상한을 바꿀 수 있게 되는데, 그건 이 값이 하는 일이 아니다.
        let runtime = ToolRuntime::new(
            root.clone(),
            artifacts.clone(),
            Duration::from_millis(policy.command_timeout_ms),
        );
        let default_profile = Arc::new(TaskProfile::new(&root, policy));
        Self {
            root,
            default_profile,
            profiles: Mutex::new(std::collections::HashMap::new()),
            runtime,
            store,
            artifacts,
            approvals,
            sink,
            cancels,
            baseline: Mutex::new(None),
            hooks: crate::hooks::HookRegistry::default(),
            in_hook: std::sync::atomic::AtomicBool::new(false),
            diffs: Mutex::new(Vec::new()),
            ipc_meter: Mutex::new(None),
        }
    }

    /// 등록된 MCP 서버를 붙인다 (mcp.rs, state-machine 23절).
    ///
    /// **붙이지 않으면 `mcp_call`은 실행되지 않는다.** 서버를 등록하지 않은 사용자에게 MCP
    /// 도구는 존재하지 않아야 하고, 그 사실이 사유로 남는다.
    pub fn with_mcp(mut self, pool: Arc<crate::mcp::McpPool>) -> Self {
        self.runtime = std::mem::replace(
            &mut self.runtime,
            ToolRuntime::new(
                self.root.clone(),
                self.artifacts.clone(),
                Duration::from_millis(self.default_profile.policy.command_timeout_ms),
            ),
        )
        .with_mcp(pool);
        self
    }

    /// 등록하려는 훅을 **게이트에 미리 태워 본다.**
    ///
    /// 게이트는 allowlist에 없는 프로그램을 기본 거부한다(정책 5절). 그래서 `node build.js`
    /// 같은 훅은 등록은 되는데 매 phase마다 거부만 기록하고 아무 일도 하지 않는다 —
    /// 사용자에게는 "훅이 동작하지 않는다"로 보이고 원인은 로그 깊은 곳에 있다.
    ///
    /// **이건 미리보기이지 판정이 아니다.** 실제 결정은 실행 시점에 다시 내려진다(그게 신뢰
    /// 경계의 규칙이다). 여기서 하는 일은 확실히 거부될 것을 **지금** 알려주는 것뿐이고,
    /// 통과한다고 해서 나중에 반드시 실행된다는 뜻은 아니다.
    pub fn preflight_hooks(&self, hooks: &[crate::hooks::HookConfig]) -> Result<(), String> {
        for hook in hooks {
            let command = hook.command();
            let request = ToolRequest {
                request_id: "hook-preflight".to_string(),
                task_id: String::new(),
                tool: ToolName::RunCommand,
                args: json!({ "program": command.program, "args": command.args, "cwd": command.cwd }),
                risk_tier: None,
                requested_by: json!({ "role": "hook-preflight" }),
                created_at: None,
            };
            // 훅 등록은 태스크에 속하지 않는다 — 워크스페이스 기본 정책으로 미리 태워 본다.
            let profile = &self.default_profile;
            let decision = profile.gate.evaluate(&request, &self.root, &profile.policy);
            if !decision.allowed() {
                return Err(format!(
                    "훅 {}의 명령을 Policy Gate가 거부합니다: {} ({})\n\
                     allowlist에 없는 프로그램은 기본 거부입니다 — 스크립트를 package.json에 넣고 \
                     `npm run <스크립트>`로 거는 것이 이 게이트를 지나는 길입니다",
                    hook.phase,
                    hook.describe(),
                    decision.reason
                ));
            }
        }
        Ok(())
    }

    /// 등록된 phase 훅을 붙인다 (hooks.rs, state-machine 25절).
    ///
    /// **`with_mcp`와 같은 이유로 생성자 인자가 아니다**: 붙이지 않으면 훅은 존재하지 않으며,
    /// 훅을 쓰지 않는 실행 경로가 훅 코드를 지나지 않는다.
    pub fn with_hooks(mut self, hooks: crate::hooks::HookRegistry) -> Self {
        self.hooks = hooks;
        self
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    /// 태스크에 속하지 않는 경로가 쓰는 정책. **태스크의 정책이 아니다** — 그건 `profile()`이다.
    pub fn policy(&self) -> &TaskPolicy {
        &self.default_profile.policy
    }

    /// 이 태스크의 프로필. 등록된 적이 없으면 워크스페이스 기본값이다.
    ///
    /// **없는 것을 오류로 만들지 않는다.** 되돌리기·PR·복구처럼 태스크가 끝난 뒤에 도는
    /// 경로가 있고, 그때 그 태스크의 정책은 이미 의미가 없다 — 그 동작들은 사용자의 것이지
    /// 그 태스크의 실행이 아니다.
    fn profile(&self, task_id: &str) -> Arc<TaskProfile> {
        self.profiles
            .lock()
            .unwrap()
            .get(task_id)
            .cloned()
            .unwrap_or_else(|| self.default_profile.clone())
    }

    /// 이 태스크의 정책을 **한 번** 등록한다 (ui-wireframes 3.16.2절).
    ///
    /// 두 번째 등록은 오류다. 갈아끼울 수 있게 두면 진행 중인 태스크의 게이트가 도중에
    /// 바뀔 수 있고, 그러면 승인 화면이 보여준 근거와 실행 시점의 근거가 달라진다.
    pub fn begin_task(&self, task_id: &str, policy: TaskPolicy) -> Result<(), String> {
        let mut profiles = self.profiles.lock().unwrap();
        if profiles.contains_key(task_id) {
            return Err(format!(
                "이 태스크의 정책이 이미 정해졌습니다: {task_id} — 진행 중에 정책을 바꿀 수 없습니다"
            ));
        }
        profiles.insert(task_id.to_string(), Arc::new(TaskProfile::new(&self.root, policy)));
        Ok(())
    }

    /// 태스크 취소 요청. **idempotent**하며, 터미널 상태를 바꾸지 않는다.
    ///
    /// 순서가 중요하다: 먼저 DB에서 터미널 여부를 읽고, 터미널이 아닐 때만 토큰을 켠다.
    /// 반대로 하면 완료된 태스크의 취소 플래그가 켜져 이후 롤백 같은 정당한 도구 실행이 막힌다.
    pub fn cancel_task(&self, task_id: &str) -> Result<Value, String> {
        let terminal = self
            .with_store(|s| s.get_task(task_id))
            .map_err(|e| format!("태스크를 조회할 수 없습니다: {e}"))?
            .and_then(|t| t.terminal_status);

        let outcome = self.cancels.request(task_id, terminal.clone());

        // 취소가 새로 확정된 경우에만 이벤트를 남긴다 (연타가 로그를 채우지 않게).
        if let CancelOutcome::Requested { .. } = &outcome {
            match self.with_store(|s| s.record_cancellation_request(task_id, "사용자 요청")) {
                Ok(_) => {}
                // DB가 터미널이라고 하면 그쪽이 진실이다 — 메모리 토큰보다 DB를 믿는다.
                Err(StoreError::TerminalAlreadySet { status }) => {
                    return Ok(json!({ "accepted": true, "outcome": "already_terminal", "status": status }));
                }
                Err(e) => return Err(format!("취소 요청을 기록할 수 없습니다: {e}")),
            }
        }

        Ok(match outcome {
            CancelOutcome::Requested { requested_at } => {
                json!({ "accepted": true, "outcome": "requested", "requestedAt": requested_at })
            }
            CancelOutcome::AlreadyRequested { requested_at } => {
                json!({ "accepted": true, "outcome": "already_requested", "requestedAt": requested_at })
            }
            CancelOutcome::AlreadyTerminal { status } => {
                json!({ "accepted": true, "outcome": "already_terminal", "status": status })
            }
            CancelOutcome::UnknownTask => json!({ "accepted": false, "outcome": "unknown_task" }),
        })
    }

    /// **강제 포기** — 사용자가 "취소 중"에서 기다리기를 그만둔다 (12절 미해결 항목).
    ///
    /// # 왜 필요한가
    ///
    /// 취소는 즉시 끝나지 않는다. 보통은 몇 백 ms지만, `REAP_TIMEOUT`을 넘겨도 죽지 않는
    /// 프로세스가 있거나 sidecar가 응답하지 않으면 태스크가 터미널에 도달하지 못한다. 그러면
    /// 화면은 영원히 "취소 중"이고, 사용자에게는 앱이 멈춘 것과 구별되지 않는다.
    ///
    /// # 무엇을 하고 무엇을 하지 않는가
    ///
    /// 하는 일: 태스크를 **CANCELLED로 확정**해 사용자를 놓아준다. `finish_task`의 원자적 경로를
    /// 그대로 쓰므로 나중에 sidecar가 자기 terminal을 보고해도 이미 확정된 쪽이 남는다.
    ///
    /// 하지 않는 일: **프로세스를 죽이지 않는다.** 죽일 수 있었으면 이 함수가 필요하지 않았다.
    /// 그래서 "정리됐다"고 말하지 않고 `forceAbandoned`와 함께 그 사실을 기록한다 —
    /// 남은 프로세스가 있을 수 있다는 것이 이 경로의 **정의**이지 예외가 아니다.
    pub fn force_abandon(&self, task_id: &str) -> Result<Value, String> {
        let outcome = self.finish_task(
            task_id,
            "CANCELLED",
            "TASK_CANCELLED",
            None,
            json!({
                "status": "cancelled",
                "summary": "사용자가 강제 포기했습니다. 취소 요청은 보냈지만 정리 완료를 확인하지 못했으므로                             실행 중이던 프로세스가 남아 있을 수 있습니다.",
                "source": "force-abandon",
                "forceAbandoned": true,
            }),
        )?;

        Ok(match outcome {
            TerminalOutcome::Recorded { status, .. } => {
                json!({ "abandoned": true, "status": status })
            }
            // 기다리는 사이에 정상적으로 끝난 경우다. 이건 실패가 아니라 **좋은 소식**이므로
            // 오류로 만들지 않는다 — 다만 무엇으로 끝났는지는 알려준다.
            TerminalOutcome::AlreadyTerminal { status } => {
                json!({ "abandoned": false, "status": status, "reason": "이미 종료된 태스크입니다" })
            }
        })
    }

    pub fn cancellation_token(&self, task_id: &str) -> CancellationToken {
        self.cancels.token(task_id)
    }

    pub fn is_cancelled(&self, task_id: &str) -> bool {
        self.cancels
            .existing(task_id)
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }

    /// 태스크가 터미널에 도달했을 때 토큰을 정리한다.
    pub fn release_task(&self, task_id: &str) {
        self.cancels.remove(task_id);
    }

    pub fn cancels(&self) -> Arc<CancellationRegistry> {
        self.cancels.clone()
    }

    pub fn store_handle(&self) -> Arc<Mutex<Store>> {
        self.store.clone()
    }

    pub fn collected_diffs(&self) -> Vec<(String, String)> {
        self.diffs.lock().unwrap().clone()
    }

    pub fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> T) -> T {
        let mut guard = self.store.lock().unwrap();
        f(&mut guard)
    }

    /// 터미널 상태 확정 + 이벤트를 한 트랜잭션에. 경쟁에서 진 쪽은 아무것도 바꾸지 않는다.
    pub fn finish_task(
        &self,
        task_id: &str,
        terminal_status: &str,
        event_type: &str,
        error_summary: Option<&str>,
        payload: Value,
    ) -> Result<TerminalOutcome, String> {
        let outcome = self
            .with_store(|s| s.finish_task(task_id, terminal_status, event_type, error_summary, &payload))
            .map_err(|e| format!("터미널 상태 기록 실패: {e}"))?;
        if let TerminalOutcome::Recorded { .. } = &outcome {
            self.sink.emit(
                "task-event",
                &json!({ "taskId": task_id, "type": event_type, "payload": payload, "createdAt": now_iso() }),
            );
            // 터미널에 도달했으므로 취소 토큰을 정리한다.
            self.release_task(task_id);
        }
        // **`Recorded`만 보면 안 된다.** 정상 경로에서 터미널을 먼저 잡는 것은 Node가 보낸
        // 터미널 `PHASE_CHANGED`이고(store의 원자적 자리 잡기), 그러면 호스트의 확정은
        // `AlreadyTerminal`로 돌아온다 — 거기서 계측을 건너뛰면 **정상 실행에서만 기록이
        // 사라진다.** 실제로 그랬고 e2e가 잡았다.
        //
        // 두 번 불려도 안전하다: `take_line_sizes`가 비우므로 두 번째는 0을 보고 남기지 않는다.
        self.record_ipc_line_sizes(task_id);
        Ok(outcome)
    }

    /// 이 태스크 구간에 관측한 IPC 줄 크기를 남긴다 (process-architecture.md 3.1절).
    ///
    /// **한 줄도 못 봤으면 남기지 않는다.** 0짜리 이벤트가 쌓이면 "트래픽이 없었다"가
    /// "계측이 안 붙었다"와 같은 모양이 되고, 그러면 분포의 분모를 믿을 수 없다.
    fn record_ipc_line_sizes(&self, task_id: &str) {
        // 클라이언트가 이미 사라졌으면 잴 것이 없다. **약한 참조라서** 여기서 upgrade한다.
        let Some(meter) = self.ipc_meter.lock().unwrap().as_ref().and_then(|m| m.upgrade()) else {
            return;
        };
        let sizes = meter.take_line_sizes();
        if sizes.lines == 0 {
            return;
        }
        let payload = serde_json::to_value(&sizes).unwrap_or(Value::Null);
        let _ = self.append_event(task_id, "IPC_LINE_SIZES", payload);
    }

    /// **이미 DB에 커밋된** 이벤트를 UI로 릴레이한다.
    ///
    /// `record_*_with_event` 계열은 레코드와 이벤트를 한 트랜잭션에 쓰기 위해 `append_event`를
    /// 거치지 않는다. 그러면 sink 릴레이가 빠지므로 UI에서 `FILE_MUTATED` 같은 이벤트가
    /// 사라진다 — DB에는 남는데 화면에는 안 보이는, 발견하기 어려운 종류의 누락이다.
    /// 커밋이 끝난 뒤 이 함수로 명시적으로 릴레이한다(커밋 실패 시에는 호출되지 않는다).
    fn relay(&self, task_id: &str, event_type: &str, payload: &Value, appended: &AppendedEvent) {
        self.sink.emit(
            "task-event",
            &json!({
                "taskId": task_id,
                "eventId": appended.event_id,
                "seq": appended.seq,
                "type": event_type,
                "payload": payload,
                "createdAt": now_iso(),
            }),
        );
    }

    /// 이벤트 로그 기록 + UI 릴레이. 이벤트 없이 상태가 바뀌지 않도록 모든 상태 변화가 이걸 지난다.
    pub fn append_event(&self, task_id: &str, event_type: &str, payload: Value) -> Result<Value, String> {
        // 사용자 판정 원문은 저장 **전에** Rust가 가린다. Node가 스스로 가리게 두면
        // 장악당한 Node에서 그 규칙이 사라진다(process-architecture.md 2절).
        let payload = redact_user_decision(event_type, payload);
        let appended = self
            .with_store(|s| s.append_event(task_id, event_type, &payload))
            .map_err(|e| format!("이벤트 기록 실패: {e}"))?;
        self.sink.emit(
            "task-event",
            &json!({
                "taskId": task_id,
                "eventId": appended.event_id,
                "seq": appended.seq,
                "type": event_type,
                "payload": payload,
                "createdAt": now_iso(),
            }),
        );
        // **훅은 이벤트가 기록된 뒤에 돈다.** 먼저 돌리면 훅이 실패했을 때 phase 전환 자체가
        // 기록되지 않을 수 있고, 그러면 `task_events`가 진실의 원천이라는 성질이 깨진다
        // (원칙 7). 훅은 관찰자이지 판정자가 아니다(25.4절).
        if event_type == "PHASE_CHANGED" {
            if let Some(to) = payload.get("to").and_then(Value::as_str) {
                self.run_phase_hooks(task_id, to);
            }
        }
        Ok(json!({ "eventId": appended.event_id, "seq": appended.seq }))
    }

    /// 이 phase에 걸린 훅을 순서대로 실행한다.
    ///
    /// **결과를 돌려주지 않는다.** 훅이 실패해도 태스크의 판정은 바뀌지 않는다 —
    /// 결정론적 검증이 판정자라는 원칙 1이 훅마다 달라지면 안 된다. 실패는 기록될 뿐이다.
    fn run_phase_hooks(&self, task_id: &str, phase: &str) {
        use std::sync::atomic::Ordering;
        if self.hooks.is_empty() {
            return;
        }
        // 재귀 차단. `swap`으로 검사와 표시를 한 번에 한다 — 검사한 뒤 표시하면 그 사이가
        // 열린다(취소 가드에서 이미 한 번 겪었다).
        if self.in_hook.swap(true, Ordering::SeqCst) {
            return;
        }
        for hook in self.hooks.for_phase(phase) {
            let command = hook.command();
            let request = ToolRequest {
                request_id: format!("hook-{}", uuid::Uuid::new_v4()),
                task_id: task_id.to_string(),
                tool: ToolName::RunCommand,
                args: json!({ "program": command.program, "args": command.args, "cwd": command.cwd }),
                risk_tier: None,
                // **모델이 아니라 사용자 설정이 요청자다.** 이 값은 기록용이며 승인 근거가
                // 아니다 — 승인 근거는 argv가 등록된 것과 같은지다(25.3절).
                requested_by: json!({ "role": "hook", "phase": phase }),
                created_at: Some(now_iso()),
            };
            let outcome = self.execute_tool(&request);
            // `ToolStatus::Ok`은 "명령이 성공했다"가 아니다(CLAUDE.md 함정 기록) — 종료 코드를
            // 본다. 여기서 뭉개면 실패한 훅이 성공으로 기록된다.
            let (status, exit_code) = match &outcome {
                Ok(value) => {
                    let result = value.get("result");
                    let status = result
                        .and_then(|r| r.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let exit = result
                        .and_then(|r| r.get("output"))
                        .and_then(|o| o.get("exitCode"))
                        .and_then(Value::as_i64);
                    (status, exit)
                }
                Err(message) => (format!("error: {message}"), None),
            };
            let _ = self.append_event(
                task_id,
                "HOOK_EXECUTED",
                json!({
                    "phase": phase,
                    "requestId": request.request_id,
                    "command": hook.describe(),
                    "status": status,
                    "exitCode": exit_code,
                    // 실패했다는 것과 **그것이 판정을 바꾸지 않는다**는 것을 함께 남긴다.
                    // 나중에 이 기록을 읽는 사람이 "왜 실패했는데 완료인가"를 묻지 않도록.
                    "affectsVerdict": false,
                }),
            );
        }
        self.in_hook.store(false, Ordering::SeqCst);
    }

    /// ToolRequest 하나를 끝까지 처리한다. 이 함수가 신뢰 경계의 핵심 경로다.
    /// 이 요청이 **태스크 시작 전에 프로젝트가 선언해 둔** 검증 명령과 정확히 같은가.
    ///
    /// 세 가지를 모두 본다. 하나라도 느슨하게 하면 레버가 검증 밖으로 새어 나간다:
    ///  - 도구가 `run_tests`인가 — 검증 러너가 쓰는 이름이다. `run_command`로 온 같은 argv는
    ///    통과하지 못한다.
    ///  - cwd가 워크스페이스 루트인가 — 탐지된 명령은 전부 루트에서 돈다. 하위 디렉터리에서
    ///    같은 이름의 스크립트를 돌리는 것은 다른 명령이다.
    ///  - program과 args가 **완전히** 같은가. prefix 비교를 하면 `npm test --ignore-scripts`
    ///    같은 변형이 딸려 들어온다.
    fn is_pinned_verification(&self, request: &ToolRequest, profile: &TaskProfile) -> bool {
        if request.tool != ToolName::RunTests {
            return false;
        }
        let Ok(cmd) = parse_run_command(&request.args) else {
            return false;
        };
        if cmd.cwd != "." {
            return false;
        }
        profile
            .verification_pin
            .iter()
            .any(|(program, args)| *program == cmd.program && *args == cmd.args)
    }

    /// 게이트가 정한 레버를 **호스트만 아는 사실로 고쳐 적는다**.
    ///
    /// conditional allowlist 명령에 대해 게이트는 `HumanOnly`밖에 말할 수 없다 — 그 명령이
    /// 프로젝트가 선언해 둔 검증 명령인지는 고정 집합을 든 이 쪽만 안다(24.5절). 게이트에
    /// 고정 집합을 넘겨 거기서 판단하게 하지 않는 이유는 게이트를 순수하게 두기 위해서다:
    /// 게이트가 태스크의 시작 시점 상태를 들고 있으면 "args만 보고 처음부터 다시 판정한다"가
    /// 깨진다.
    fn lever_for(
        &self,
        request: &ToolRequest,
        decision: &PolicyDecision,
        profile: &TaskProfile,
    ) -> crate::types::PolicyLever {
        use crate::types::PolicyLever;
        if decision.unblocked_by == PolicyLever::HumanOnly
            && !profile.policy.auto_approve_verification
            && self.is_pinned_verification(request, profile)
        {
            return PolicyLever::AutoApproveVerification;
        }
        decision.unblocked_by
    }

    /// 사용자가 **미리 적어 둔 것**이 이 요청을 승인하는가.
    ///
    /// 둘 다 근거가 같다: 명령의 출처가 모델이 아니라 사용자이고, 그 사실을 이 프로세스가
    /// 구조적으로 확인할 수 있다. 그러나 **하나의 스위치로 뭉개지 않는다** — 검증 명령을
    /// 자동 승인하기로 한 것과 훅을 등록한 것은 다른 결정이고, 기록도 달라야 한다.
    fn pre_approval(&self, request: &ToolRequest, profile: &TaskProfile) -> Option<PreApproval> {
        let candidate = if profile.policy.auto_approve_verification && self.is_pinned_verification(request, profile) {
            Some(PreApproval::DeclaredVerification)
        } else if self.is_registered_hook(request) {
            Some(PreApproval::RegisteredHook)
        } else {
            None
        };
        let kind = candidate?;

        // **매니페스트가 바뀌었으면 사전 승인이 성립하지 않는다**(29.3절). argv는 그대로인데
        // 그 argv가 돌리는 본문이 달라졌을 수 있고, 그러면 사용자가 승인한 것과 실제로 도는
        // 것이 다르다. 막는 것이 아니라 **사람에게 되돌린다** — 평소대로 묻고, 무인이면 멈춘다.
        if manifest_fingerprint(&self.root) != profile.manifest_fingerprint {
            let _ = self.append_event(
                &request.task_id,
                "PRE_APPROVAL_WITHDRAWN",
                json!({
                    "requestId": request.request_id,
                    "wouldHaveBeen": kind.event_type(),
                    "reason": "태스크 시작 이후 매니페스트가 바뀌어 사전 승인이 성립하지 않습니다 —                                같은 명령이라도 그 본문이 달라졌을 수 있습니다",
                }),
            );
            return None;
        }
        Some(kind)
    }

    /// 이 요청이 **사용자가 등록한 훅과 바이트 단위로 같은** 명령인가.
    ///
    /// `requested_by`를 보지 않는다 — 그건 IPC로 들어오는 값이라 Node가 지어낼 수 있다.
    /// 판정 근거는 argv뿐이고, 그래서 모델이 같은 argv를 요청하면 이것도 통과한다.
    /// **그 사실을 숨기지 않는다**: 사용자가 "이 명령을 매 phase 전환마다 자동으로 돌려라"라고
    /// 등록한 이상, 같은 명령이 한 번 더 도는 것은 그 승인의 범위 안이다(25.3절).
    fn is_registered_hook(&self, request: &ToolRequest) -> bool {
        if request.tool != ToolName::RunCommand {
            return false;
        }
        let Ok(cmd) = parse_run_command(&request.args) else {
            return false;
        };
        // 훅은 언제나 루트에서 돈다(hooks.rs `command()`). cwd가 다르면 등록된 것이 아니다.
        cmd.cwd == "." && self.hooks.matches_registered(&cmd.program, &cmd.args)
    }

    pub fn execute_tool(&self, request: &ToolRequest) -> Result<Value, String> {
        let cancel = self.cancels.token(&request.task_id);

        // 0) 취소 확인. 취소된 태스크의 도구는 **시작하지 않는다.**
        //    `denied`가 아니라 `cancelled`로 보고해야 오케스트레이터가 정책 거부와 구별한다.
        if cancel.is_cancelled() {
            let result = ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Cancelled,
                output: None,
                error: Some("태스크가 취소되어 도구를 실행하지 않음".to_string()),
                duration_ms: 0,
                completed_at: now_iso(),
                denial_kind: None,
            };
            // 취소 후 거부도 감사 로그에 남는다 — "취소했는데 뭐가 더 실행됐나"를 확인할 수 있어야 한다.
            let _ = self.append_event(
                &request.task_id,
                "TOOL_SKIPPED_CANCELLED",
                json!({ "requestId": request.request_id, "tool": request.tool.as_str() }),
            );
            return Ok(json!({
                "result": result,
                "policy": {
                    "decision": "deny", "riskLevel": "none",
                    "reason": "태스크가 취소됨", "matchedRule": "cancelled", "normalizedTarget": ""
                }
            }));
        }

        // 1) Policy Gate. Node가 보낸 riskTier는 여기서 판단 근거로 쓰이지 않는다.
        // **이 태스크의 정책으로 판정한다.** 등록된 적이 없으면 워크스페이스 기본값이다
        // (되돌리기처럼 태스크가 끝난 뒤에 도는 경로).
        let profile = self.profile(&request.task_id);
        let decision = profile.gate.evaluate(request, &self.root, &profile.policy);

        let _ = self.append_event(
            &request.task_id,
            "TOOL_REQUESTED",
            json!({
                "requestId": request.request_id,
                "tool": request.tool.as_str(),
                "args": redact_args(&request.args),
                "requestedBy": request.requested_by,
                "nodeRiskTier": request.risk_tier,
            }),
        );
        let _ = self.append_event(
            &request.task_id,
            "POLICY_DECIDED",
            json!({
                "requestId": request.request_id,
                "decision": decision.decision,
                "riskLevel": decision.risk_level,
                "matchedRule": decision.matched_rule,
                "reason": decision.reason,
                "normalizedTarget": decision.normalized_target,
            }),
        );
        self.with_store(|s| s.record_tool_request(request, "plan-current", &decision))
            .map_err(|e| format!("tool_request 기록 실패: {e}"))?;

        // 2) 승인이 필요하면 UI 왕복. Node는 이 과정에 관여하지 않는다.
        //
        // **기본값이 `NotRequired`다.** 게이트가 승인을 요구하지 않은 요청은 "승인되지 않음"이
        // 아니라 "물을 일이 아니었음"이고, 둘을 같은 값으로 두면 결과 기록이 그 사실을 잃는다.
        let mut approval_state = crate::tools::ApprovalState::NotRequired;
        let pre_approval = if decision.requires_user_approval {
            self.pre_approval(request, &profile)
        } else {
            None
        };
        if let Some(kind) = pre_approval {
            // 사용자가 **미리** 정해 둔 것이 답한다. **게이트 분류는 그대로다** — 바뀐 것은
            // "누가 답하는가"뿐이고, 그 대상은 사용자가 먼저 적어 둔 것으로 한정된다
            // (24.5절 검증 명령 / 25.3절 등록된 훅).
            approval_state = crate::tools::ApprovalState::GrantedByPolicy;
            let _ = self.append_event(
                &request.task_id,
                kind.event_type(),
                json!({
                    "requestId": request.request_id,
                    "normalizedTarget": decision.normalized_target,
                    // 게이트가 무엇을 요구했는지 지운 채로 남기면, 나중에 이것이 무엇을
                    // 통과시켰는지 되짚을 수 없다.
                    "wouldHaveAsked": decision.matched_rule,
                    "riskLevel": decision.risk_level,
                }),
            );
        } else if decision.requires_user_approval && profile.policy.unattended {
            // **무인 여부는 정책이 정한다.** 종전에는 승인 게이트웨이를 `UnattendedStop`으로
            // 바꿔 끼우는 것으로 표현했는데, 게이트웨이는 호스트 수명이라 **태스크마다 다른
            // 무인 여부**를 표현할 수 없었다(ui-wireframes 3.16.2절).
            //
            // 게이트웨이 쪽 `UnattendedStop`을 지우지는 않았다. 이 짧은 길이 어떤 이유로
            // 우회되더라도 그쪽이 같은 답을 내야 하기 때문이다 — 두 규칙이 아니라 같은 답의
            // 두 겹이다.
            let lever = self.lever_for(request, &decision, &profile);
            let _ = self.append_event(
                &request.task_id,
                "APPROVAL_UNATTENDED",
                json!({
                    "requestId": request.request_id,
                    "reason": "무인 실행(Autopilot)이라 승인을 물을 사람이 없습니다",
                    "tool": request.tool.as_str(),
                    "normalizedTarget": decision.normalized_target,
                    "matchedRule": decision.matched_rule,
                    "unblockedBy": lever,
                    "rerunFlag": lever.rerun_flag(),
                }),
            );
            approval_state = crate::tools::ApprovalState::Unattended;
        } else if decision.requires_user_approval {
            let approval = ApprovalRequest {
                approval_id: format!("approval-{}", uuid::Uuid::new_v4()),
                task_id: request.task_id.clone(),
                // Policy Gate가 벗어나지 못하게 지키는 바로 그 루트다. 승인 화면이 말하는
                // 워크스페이스와 실제로 제한되는 워크스페이스가 같아야 한다.
                workspace_root: self.root.display(),
                items: vec![self.describe_for_approval(request, &decision)],
                created_at: now_iso(),
            };
            // 승인 모달에는 preview(patch/content 본문)를 그대로 보여준다 — 무엇을 승인하는지
            // 모르면 승인이 의미가 없다. 그러나 **이벤트에는 남기지 않는다**: 비밀값 파일에
            // 새로 쓰려는 값이 감사 로그에 영구 보관되면, 승인 화면에서 한 번 보여주는 것과
            // 전혀 다른 노출이 된다.
            let _ = self.append_event(
                &request.task_id,
                "APPROVAL_REQUESTED",
                redact_approval_for_event(&approval),
            );

            // **`match`의 값을 그대로 받는다.** 한때 왕복 전에 `DeniedByUser`를 넣어 두는
            // 방어 코드가 있었지만, 그건 "어떤 경로로도 승인 없이 빠져나가지 않는다"를 사람이
            // 지키는 규칙으로 만든다. 값을 match에서 받으면 컴파일러가 지킨다 —
            // `ApprovalOutcome`에 변형이 늘면 여기가 컴파일되지 않는다.
            approval_state = match self.approvals.request_approval(&approval) {
                ApprovalOutcome::Granted => {
                    let _ = self.append_event(
                        &request.task_id,
                        "APPROVAL_GRANTED",
                        json!({ "approvalId": approval.approval_id, "requestId": request.request_id }),
                    );
                    crate::tools::ApprovalState::Granted
                }
                ApprovalOutcome::Denied { note } => {
                    let _ = self.append_event(
                        &request.task_id,
                        "APPROVAL_DENIED",
                        json!({ "approvalId": approval.approval_id, "requestId": request.request_id, "note": note }),
                    );
                    crate::tools::ApprovalState::DeniedByUser
                }
                // **같은 이벤트를 쓰지 않는다.** `APPROVAL_DENIED`로 남기면 감사 로그가
                // 사용자의 판단을 기록한 것처럼 보이는데, 사용자는 이 자리에 없었다.
                ApprovalOutcome::Unattended => {
                    // **여기가 무인 정지의 유일한 기록이다.** 사용자가 다음에 물을 것은
                    // "무엇을 바꾸면 지나가는가"이고(24.8절), 그 답을 지금 남기지 않으면
                    // 나중에는 게이트 규칙을 사람이 다시 읽어 추론해야 한다.
                    let lever = self.lever_for(request, &decision, &profile);
                    let _ = self.append_event(
                        &request.task_id,
                        "APPROVAL_UNATTENDED",
                        json!({
                            "approvalId": approval.approval_id,
                            "requestId": request.request_id,
                            "reason": "무인 실행(Autopilot)이라 승인을 물을 사람이 없습니다",
                            "tool": request.tool.as_str(),
                            "normalizedTarget": decision.normalized_target,
                            "matchedRule": decision.matched_rule,
                            "unblockedBy": lever,
                            // 플래그가 없다는 것은 **정보다** — 켤 것이 없다는 뜻이고,
                            // 키를 빼면 "아직 안 적었다"와 구별되지 않는다.
                            "rerunFlag": lever.rerun_flag(),
                        }),
                    );
                    crate::tools::ApprovalState::Unattended
                }
            };
        }

        // 3) 실행. 승인되지 않았으면 Tool Runtime이 스스로 Denied를 반환한다 —
        //    호출자가 승인 확인을 잊는 경로를 없애기 위해 판단을 런타임에도 넘긴다.
        let outcome = self.runtime.execute(request, &decision, approval_state, &cancel);

        // 4) 결과 기록. **레코드와 이벤트를 같은 트랜잭션에** 쓴다 (M0.1 트랜잭션 규칙).
        if let Some(mutation) = &outcome.mutation {
            let payload = json!({
                "requestId": mutation.request_id,
                "path": mutation.path,
                "preExisted": mutation.pre_image.existed,
                "postExists": mutation.post_image.existed,
            });
            let appended = self
                .with_store(|s| s.record_file_mutation_with_event(mutation, &payload))
                .map_err(|e| format!("file_mutation 기록 실패: {e}"))?;
            self.relay(&request.task_id, "FILE_MUTATED", &payload, &appended);
        }
        if let Some(diff) = &outcome.diff {
            let path = outcome
                .mutation
                .as_ref()
                .map(|m| m.path.clone())
                .unwrap_or_else(|| "(unknown)".to_string());
            self.diffs.lock().unwrap().push((path, diff.clone()));
        }

        // 비밀값 경로의 **출력은 이벤트에 남기지 않는다.**
        //
        // 사용자가 `.env` 읽기를 승인했다는 것은 "이번 판단을 위해 모델이 보는 것"에 동의한
        // 것이고, "그 값이 감사 로그에 영구히 남는 것"에 동의한 것이 아니다. 이벤트 로그는
        // UI에 그대로 표시되고 오래 보관되므로, 승인 여부와 무관하게 여기서는 덜어낸다.
        let secret_target = secrets::is_secret_path(&decision.normalized_target);
        let completed_payload = json!({
            "requestId": outcome.result.request_id,
            "status": outcome.result.status,
            "error": outcome.result.error,
            "durationMs": outcome.result.duration_ms,
            "outputRef": outcome.output_ref,
            // 큰 출력은 이미 artifact에 있으므로 이벤트에는 요약만 남긴다.
            "output": if secret_target {
                json!({ "redacted": true, "reason": "비밀값을 담을 수 있는 경로이므로 이벤트에 내용을 남기지 않습니다" })
            } else {
                summarize_output(outcome.result.output.as_ref())
            },
        });
        let appended = self
            .with_store(|s| {
                s.record_tool_result_with_event(
                    &outcome.result,
                    outcome.output_ref.as_deref(),
                    &request.task_id,
                    &completed_payload,
                )
            })
            .map_err(|e| format!("tool_result 기록 실패: {e}"))?;
        self.relay(&request.task_id, "TOOL_COMPLETED", &completed_payload, &appended);

        Ok(json!({
            "result": outcome.result,
            "policy": {
                "decision": decision.decision,
                "riskLevel": decision.risk_level,
                "reason": decision.reason,
                "matchedRule": decision.matched_rule,
                "normalizedTarget": decision.normalized_target,
            }
        }))
    }

    /// 승인 모달에 보여줄 항목을 만든다.
    /// `run_command`의 program/args/cwd는 실제 실행값과 정확히 같아야 한다 —
    /// 그래서 표시용 문자열을 새로 조립하지 않고 정규화된 argv를 그대로 넣는다.
    fn describe_for_approval(&self, request: &ToolRequest, decision: &PolicyDecision) -> ApprovalRequestItem {
        let command = match request.tool {
            ToolName::RunCommand | ToolName::RunTests => parse_run_command(&request.args).ok(),
            _ => None,
        };
        let path = request.args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
        let preview = match request.tool {
            ToolName::ApplyPatch => request
                .args
                .get("patch")
                .and_then(|v| v.as_str())
                .map(|p| truncate(p, 4000)),
            ToolName::CreateFile => request
                .args
                .get("content")
                .and_then(|v| v.as_str())
                .map(|p| truncate(p, 4000)),
            _ => None,
        };
        ApprovalRequestItem {
            request_id: request.request_id.clone(),
            tool: request.tool.as_str().to_string(),
            risk_level: decision.risk_level,
            reason: decision.reason.clone(),
            command,
            path,
            preview,
        }
    }

    /// 결정론적 검증 실행. Node는 "언제"만 요청하고 "무엇을 어떻게"는 Rust가 정한다.
    pub fn run_verification(
        &self,
        task_id: &str,
        phase: VerificationPhase,
        attempt_number: u32,
    ) -> Result<Value, String> {
        // 취소 이후에는 검증을 새로 시작하지 않는다. 시작해 버리면 "취소했는데 npm test가 돈다"가 된다.
        if self.is_cancelled(task_id) {
            let _ = self.append_event(
                task_id,
                "VERIFICATION_SKIPPED_CANCELLED",
                json!({ "phase": format!("{phase:?}"), "attemptNumber": attempt_number }),
            );
            return Err("태스크가 취소되어 검증을 실행하지 않았습니다".to_string());
        }
        let runner = VerificationRunner::new(&self.root, &self.artifacts);
        let baseline = self.baseline.lock().unwrap().clone();
        let mut executor = HostExecutor { host: self };

        let report = runner.run(task_id, phase, attempt_number, &mut executor, baseline.as_ref());

        let payload = serde_json::to_value(&report).unwrap_or(Value::Null);
        let appended = self
            .with_store(|s| s.record_verification_with_event(&report, &payload))
            .map_err(|e| format!("verification_report 기록 실패: {e}"))?;
        self.relay(task_id, "VERIFICATION_COMPLETED", &payload, &appended);

        if phase == VerificationPhase::Baseline {
            *self.baseline.lock().unwrap() = Some(report.clone());
        }

        Ok(json!({ "report": report }))
    }

    /// 이 태스크가 만든 커밋을 `git revert`로 되돌린다 — 19절.
    ///
    /// # 충돌을 미리 배제하는 대신, 충돌하면 우리가 치운다
    ///
    /// 예전에는 **충돌이 불가능한 경우에만** 실행했다 — 그 커밋이 아직 HEAD이고 워킹 트리가
    /// 깨끗할 때. 근거는 "충돌하면 `git revert --abort`도 승인을 받아야 하는데 사용자가 거부하면
    /// 충돌 마커가 박힌 채 남는다"였다. 그 전제가 틀렸다: `--abort`는 새로운 작업이 아니라
    /// **우리가 시작해 실패한 작업의 원상복구**다. 사용자는 "되돌리기"를 누르며 이 작업 하나를
    /// 승인했고, 실패했을 때 원래대로 돌려놓는 것까지가 그 한 번의 승인 범위다. 별도 승인을
    /// 묻는 쪽이 오히려 저장소를 망가진 채로 둘 수 있는 길이었다.
    ///
    /// 그래서 HEAD 조건을 버린다. 그 위에 다른 커밋이 쌓였어도 대부분은 깨끗하게 되돌아가고,
    /// 안 되면 되돌려 놓으면 된다. 사용자에게 "직접 하세요"라고 미루던 경우의 대부분이
    /// 사실은 우리가 해줄 수 있는 일이었다.
    ///
    /// # 워킹 트리 검사만 남긴다
    ///
    /// 커밋한 경로에 저장되지 않은 변경이 있으면 여전히 시작하지 않는다. 그건 실패했을 때
    /// **사용자가 아직 저장하지 않은 작업**이 위험해지는 유일한 경우이고, `--abort`가 그것까지
    /// 지켜준다고 보장할 수 없기 때문이다. 우리가 만든 상태는 우리가 되돌릴 수 있지만
    /// 사용자가 만든 상태는 되돌릴 수 없다 — 이 비대칭이 두 조건의 운명을 갈랐다.
    ///
    /// # 남의 revert 위에서는 시작하지 않는다
    ///
    /// 시작 전에 `REVERT_HEAD`가 이미 있으면 거부한다. 진행 중인 revert가 있다는 뜻이고,
    /// 그 위에서 우리가 실패해 `--abort`를 부르면 **사용자가 하던 작업을 지운다.** 실패 후에도
    /// 같은 것을 다시 확인해서, 그 `REVERT_HEAD`가 **이번 실행이 만든 것일 때만** 치운다.
    ///
    /// `reset --hard`를 쓰지 않는 이유는 19.2절에 있다.
    /// 브랜치를 remote로 올리고 PR 폼 URL을 만든다 (pr.rs, state-machine 28절).
    ///
    /// **사용자 명령이지 모델의 도구가 아니다** — 되돌리기(19절)와 같은 자리다. 그러나
    /// 되돌리기와 다른 점이 하나 있고 그게 중요하다: **여기서는 승인을 건너뛰지 않는다.**
    /// 되돌리기는 사용자가 "되돌려"를 누른 것 자체가 그 동작의 승인이지만, push는 *무엇이*
    /// 올라가는지가 매번 다르다. 그래서 승인 왕복을 그대로 지난다.
    /// 앞선 태스크의 사용자 판정을 **거둔다** (state-machine 30절).
    ///
    /// **사용자만 부른다.** 모델도 오케스트레이터도 이 경로에 닿지 않는다 — `revert`/`pr`과
    /// 같은 자리이고, `db.appendEvent`는 이 이벤트 종류를 아예 거절한다(`NODE_MAY_NOT_EMIT`).
    ///
    /// 거두는 것은 **다음 태스크로 나르는가** 하나뿐이다. 소유 태스크의 기록은 그대로 남는다.
    pub fn withdraw_decision(
        &self,
        session_id: &str,
        task_id: &str,
        criterion_id: &str,
        reason: Option<&str>,
    ) -> Result<Value, String> {
        // **거절도 오류가 아니라 값이다.** 오류로 내면 "거두지 못했다"와 "저장소가 깨졌다"가
        // 호출자에게 같은 모양이 된다.
        if let Err(refusal) = self.with_store(|s| decisions::check(s, session_id, task_id, criterion_id)) {
            return Ok(json!({
                "withdrawn": false,
                "taskId": task_id,
                "criterionId": criterion_id,
                "refusal": refusal,
                "detail": refusal.message(),
            }));
        }

        let withdrawn_at = now_iso();
        let payload = json!({
            "criterionId": criterion_id,
            "withdrawnAt": withdrawn_at,
            "reason": reason,
            // 파생 캐시를 바꾸는 열쇠. `sync_acceptance_criteria_tx`가 이 키만 본다 —
            // 이벤트 없이 기준이 사라지는 길을 만들지 않기 위해서다(원칙 7).
            "acceptanceCriteriaWithdrawn": [criterion_id],
        });
        self.append_event(task_id, "USER_DECISION_WITHDRAWN", payload)?;
        Ok(json!({
            "withdrawn": true,
            "taskId": task_id,
            "criterionId": criterion_id,
            "withdrawnAt": withdrawn_at,
        }))
    }

    pub fn open_pull_request(&self, task_id: &str, remote: &str, base: &str) -> Result<Value, String> {
        let (ok, branch, err) = self.git_try(task_id, "pr-branch", &["rev-parse", "--abbrev-ref", "HEAD"], false)?;
        if !ok {
            return Err(format!("현재 브랜치를 확인하지 못했습니다: {err}"));
        }
        let branch = branch.trim().to_string();
        // **detached HEAD에서는 올릴 브랜치가 없다.** "HEAD"를 그대로 밀면 remote에 `HEAD`라는
        // 브랜치가 생긴다 — 사용자가 의도한 적 없는 결과다.
        if branch.is_empty() || branch == "HEAD" {
            return Err("detached HEAD 상태라 올릴 브랜치가 없습니다. 먼저 브랜치를 만드세요".to_string());
        }
        if branch == base {
            return Err(format!(
                "현재 브랜치가 base와 같습니다 ({base}). PR은 서로 다른 두 브랜치 사이에만 만들 수 있습니다"
            ));
        }

        let request = ToolRequest {
            request_id: format!("push-{}", uuid::Uuid::new_v4()),
            task_id: task_id.to_string(),
            tool: ToolName::GitPush,
            args: json!({ "remote": remote, "branch": branch }),
            risk_tier: None,
            requested_by: json!({ "role": "user", "command": "pr" }),
            created_at: Some(now_iso()),
        };
        let outcome = self.execute_tool(&request)?;
        let status = outcome
            .get("result")
            .and_then(|r| r.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let exit_code = outcome
            .get("result")
            .and_then(|r| r.get("output"))
            .and_then(|o| o.get("exitCode"))
            .and_then(Value::as_i64);
        // `ToolStatus::Ok`은 "명령이 성공했다"가 아니다(CLAUDE.md 함정 기록).
        let pushed = status == "ok" && exit_code == Some(0);
        if !pushed {
            let _ = self.append_event(
                task_id,
                "PR_PUSH_FAILED",
                json!({ "remote": remote, "branch": branch, "status": status, "exitCode": exit_code }),
            );
            return Ok(json!({
                "pushed": false,
                "branch": branch,
                "remote": remote,
                "status": status,
                "exitCode": exit_code,
                "compareUrl": Value::Null,
                "reason": outcome.get("result").and_then(|r| r.get("error")).cloned().unwrap_or(Value::Null),
            }));
        }

        let (title, body) = self.pull_request_text(task_id)?;
        // remote URL은 **push가 끝난 뒤에** 읽는다. 앞에서 읽으면 URL을 만들 수 없는 remote일 때
        // 올리지도 않고 실패하게 되는데, 올리는 것 자체는 URL과 무관하게 성립한다.
        let (ok, remote_url, _) = self.git_try(task_id, "pr-remote", &["remote", "get-url", remote], false)?;
        let slug = if ok { crate::pr::github_slug(remote_url.trim()) } else { None };
        let compare_url = slug
            .as_ref()
            .map(|s| crate::pr::compare_url(s, base, &branch, &title, &body));

        let payload = json!({
            "pushed": true,
            "branch": branch,
            "remote": remote,
            "base": base,
            "title": title,
            "body": body,
            // **GitHub이 아니면 `null`이다.** 모르는 호스팅의 URL을 추측해 만들면 사용자는
            // 404를 받고 그 원인을 알 방법이 없다.
            "compareUrl": compare_url,
        });
        let _ = self.append_event(
            task_id,
            "PR_BRANCH_PUSHED",
            json!({ "remote": remote, "branch": branch, "base": base, "compareUrlAvailable": compare_url.is_some() }),
        );
        Ok(payload)
    }

    /// PR 제목과 본문. **커밋 메시지와 같은 규칙**이다(19.6절): 제목은 사용자의 요청문이고
    /// 본문은 무엇을 했는지이며, 전체 기록으로 가는 열쇠(task id)를 남긴다.
    fn pull_request_text(&self, task_id: &str) -> Result<(String, String), String> {
        let task = self
            .with_store(|s| s.get_task(task_id))
            .map_err(|e| format!("작업 조회 실패: {e}"))?
            .ok_or_else(|| format!("작업을 찾을 수 없습니다: {task_id}"))?;
        let checks = self
            .with_store(|s| s.verification_checks(task_id))
            .map_err(|e| format!("검증 조회 실패: {e}"))?;
        let mut lines = vec![task.user_message.clone(), String::new()];
        if checks.is_empty() {
            // **"검증했다"고 쓰지 않는다.** 기록이 없으면 없다고 쓴다.
            lines.push("검증 기록이 없습니다.".to_string());
        } else {
            lines.push("## 검증".to_string());
            for check in &checks {
                let kind = check.get("kind").and_then(Value::as_str).unwrap_or("?");
                let status = check.get("status").and_then(Value::as_str).unwrap_or("?");
                let stage = check.get("stage").and_then(Value::as_str).unwrap_or("?");
                lines.push(format!("- {kind} ({stage}): {status}"));
            }
        }
        lines.push(String::new());
        lines.push(format!("Tomverse-Task: {task_id}"));
        Ok((task.user_message, lines.join("\n")))
    }

    pub fn revert_commit(&self, task_id: &str) -> Result<Value, String> {
        let Some(sha) = self.committed_sha(task_id)? else {
            return Ok(json!({
                "reverted": false,
                "reason": "이 작업이 만든 커밋을 특정할 수 없습니다 (커밋이 없거나 sha를 확인하지 못했습니다).",
            }));
        };

        if self.git_ref_exists(task_id, "REVERT_HEAD")? {
            return Ok(json!({
                "reverted": false,
                "sha": sha,
                "conflicted": false,
                "cleanedUp": true,
                "reason": "이미 진행 중인 revert가 있습니다. 되돌리기가 실패하면 그것까지 취소해 버리므로 시작하지 않습니다 — 진행 중인 revert를 먼저 끝내거나 `git revert --abort`로 정리한 뒤 다시 시도하세요.",
            }));
        }

        let paths = self.committed_paths(task_id)?;
        let mut status_args: Vec<&str> = vec!["status", "--porcelain", "--"];
        for path in &paths {
            status_args.push(path.as_str());
        }
        let dirty = self.git_output(task_id, &status_args)?;
        if !dirty.trim().is_empty() {
            return Ok(json!({
                "reverted": false,
                "sha": sha,
                "conflicted": false,
                "cleanedUp": true,
                "reason": format!(
                    "커밋한 파일에 저장되지 않은 변경이 있습니다. 되돌리기가 충돌하면 이 변경까지 위험해지므로 실행하지 않습니다 — 저장하거나 따로 보관한 뒤 다시 시도하세요:\n{}",
                    dirty.trim()
                ),
            }));
        }

        let (ok, _out, err) = self.git_try(task_id, "revert", &["revert", "--no-edit", &sha], true)?;
        if !ok {
            return self.abort_failed_revert(task_id, &sha, err);
        }

        let done = json!({ "reverted": true, "sha": sha, "paths": paths });
        let _ = self.append_event(task_id, "ROLLBACK_COMPLETED", done.clone());
        Ok(done)
    }

    /// 실패한 `git revert`의 원상복구.
    ///
    /// **별도 승인을 묻지 않는다** — 사용자가 누른 "되돌리기" 한 번의 승인 범위 안이다
    /// (위 주석). 여기서 다시 물으면 거부당했을 때 우리가 만든 충돌 상태를 사용자에게
    /// 떠넘기게 된다.
    fn abort_failed_revert(&self, task_id: &str, sha: &str, error: String) -> Result<Value, String> {
        // revert가 **시작조차 못 한** 경우가 있다: 잘못된 sha, 인덱스에 남은 변경, 머지 커밋.
        // 그때는 치울 것이 없고, 치우려 들면 남의 상태를 건드린다.
        if !self.git_ref_exists(task_id, "REVERT_HEAD")? {
            return Ok(json!({
                "reverted": false,
                "sha": sha,
                "conflicted": false,
                "cleanedUp": true,
                "reason": format!("되돌리기를 시작하지 못했습니다: {}", error.trim()),
            }));
        }

        // 어떤 파일이 충돌했는지는 `--abort` 뒤에는 알 수 없다. **지우기 전에** 읽어 둔다 —
        // 사용자가 다음에 무엇을 해야 하는지는 이 목록에 달려 있다.
        let conflicts: Vec<String> = self
            .git_output(task_id, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();

        let (aborted, _out, abort_err) = self.git_try(task_id, "revert-abort", &["revert", "--abort"], true)?;
        if !aborted {
            // 여기까지 오면 저장소가 revert 진행 중인 채로 남는다. **조용히 넘기지 않는다** —
            // 사용자가 모르면 다음 작업이 전부 그 상태 위에서 벌어진다.
            let done = json!({
                "reverted": false,
                "sha": sha,
                "conflicted": true,
                "cleanedUp": false,
                "conflicts": conflicts,
                "reason": format!(
                    "되돌리기가 충돌했고, 원상복구(`git revert --abort`)까지 실패했습니다. \
                     저장소가 revert 진행 중 상태로 남아 있습니다 — 직접 `git revert --abort`를 실행하세요.\n{}",
                    abort_err.trim()
                ),
            });
            let _ = self.append_event(task_id, "ROLLBACK_FAILED", done.clone());
            return Ok(done);
        }

        let done = json!({
            "reverted": false,
            "sha": sha,
            "conflicted": true,
            "cleanedUp": true,
            "conflicts": conflicts,
            "reason": format!(
                "되돌리기가 충돌해서 저장소를 원래대로 돌려놓았습니다 (아무것도 바뀌지 않았습니다). \
                 충돌한 파일: {}. 되돌리려면 직접 `git revert {}`를 실행하고 충돌을 해결하세요.",
                if conflicts.is_empty() { "(목록 없음)".to_string() } else { conflicts.join(", ") },
                sha
            ),
        });
        // 충돌해서 되돌리지 못한 것도 **이벤트로 남는다.** 저장소가 시작 전과 같다는 것은
        // 아무 일도 없었다는 뜻이 아니다 — 사용자가 되돌리기를 눌렀고 우리가 하지 못했다.
        let _ = self.append_event(task_id, "ROLLBACK_FAILED", done.clone());
        Ok(done)
    }

    /// 태스크 시작 시점의 **워크스페이스 지문** — product-strategy 6절.
    ///
    /// # 왜 `git_head`만으로는 부족한가
    ///
    /// 같은 HEAD에서도 워킹 트리가 다르면 **다른 실행**이다. 커밋되지 않은 변경을 반영하지 않는
    /// 지문은 서로 다른 상태를 같다고 말하고, 감사에서 그건 빠뜨림이 아니라 오답이다.
    ///
    /// # 무엇을 섞는가
    ///
    /// 세 가지를 이어 붙여 SHA-256을 낸다. 전부 **읽기 전용** 명령이고 이미 allowlist에 있다.
    ///
    /// | 재료 | 담기는 것 |
    /// |---|---|
    /// | `git rev-parse HEAD` | 커밋된 상태 |
    /// | `git status --porcelain -uall` | 변경·추가·삭제된 **경로** (추적되지 않는 파일 포함) |
    /// | `git diff HEAD` | 추적되는 파일의 **내용 변경** |
    ///
    /// # 이 지문이 놓치는 것 — 숨기지 않는다
    ///
    /// **추적되지 않는 파일은 경로만 들어가고 내용은 들어가지 않는다.** `git diff HEAD`가
    /// 추적되는 파일만 보기 때문이다. 그래서 추적되지 않는 파일의 **내용만** 바뀐 두 실행은
    /// 같은 지문을 낸다.
    ///
    /// 이걸 문서 한 줄로 덮지 않고 `untrackedFiles` 개수를 함께 남긴다 — **그 수가 0이면 이
    /// 한계가 이번 실행에 적용되지 않는다**는 뜻이고, 0이 아닐 때만 화면이 정밀도가 낮다고
    /// 말하면 된다. 항상 붙는 면책 문구는 아무도 읽지 않는다.
    ///
    /// git 저장소가 아니면 지문을 내지 않는다(`available: false`). **빈 해시를 만들어 내면
    /// "상태가 비어 있었다"로 읽히는데, 실제로는 "잴 수 없었다"이다.**
    pub fn record_workspace_fingerprint(&self, task_id: &str) -> Result<Value, String> {
        let payload = self.workspace_fingerprint(task_id);
        let _ = self.append_event(task_id, "WORKSPACE_FINGERPRINT", payload.clone());
        Ok(payload)
    }

    /// 재료와 조립은 `reproduce::fingerprint`에 있고 여기서는 **git 호출만** 준다.
    ///
    /// 한 곳에 모은 이유: 재현 검사는 태스크 없이 지문을 내야 하는데(감사자에게는 DB가 없다),
    /// 조립을 두 벌 두면 같은 워크스페이스가 경로에 따라 다른 지문을 낸다 — 그러면 비교
    /// 자체가 무너진다. 여기서 넘기는 러너는 **Policy Gate를 지나는** 것이고, 그 사실이
    /// 태스크가 있는 경로와 없는 경로의 유일한 차이다.
    fn workspace_fingerprint(&self, task_id: &str) -> Value {
        crate::reproduce::fingerprint(|args| self.git_output(task_id, args))
    }

    /// 인덱스 캐시의 키 — **워크스페이스 지문이다.**
    ///
    /// `gitHeadAtIndex` 하나로는 부족하다. HEAD가 같아도 워킹 트리가 다르면 **파일 집합이
    /// 다르고**, 인덱스는 파일 집합이다. 종전 규칙("HEAD가 같으면 재사용")은 커밋 없이 만든
    /// 파일을 인덱스에서 영영 빠뜨렸고, 그러면 사용자가 이름으로 지목해도 컨텍스트에 들어가지
    /// 않는다 — 재현 전제 판정에서 같은 이유로 지문을 쓰기로 한 것과 같은 문제다.
    ///
    /// **이벤트를 남기지 않는다.** `record_workspace_fingerprint`와 달리 이건 캐시 판정이고,
    /// 태스크마다 지문 이벤트가 두 개씩 쌓이면 감사 로그가 캐시 사정을 설명하게 된다.
    fn index_cache_key(&self, task_id: &str) -> Option<String> {
        let payload = crate::reproduce::fingerprint(|args| self.git_output(task_id, args));
        payload.get("fingerprint").and_then(Value::as_str).map(str::to_string)
    }

    /// 이 호스트가 다루는 워크스페이스의 id. **루트에서 유도한다** — Node가 말한 값을 쓰지 않는다.
    fn workspace_id(&self) -> String {
        crate::paths::workspace_id_for(&self.root.display())
    }

    /// 이벤트 로그에서 이 태스크가 만든 커밋 sha를 찾는다.
    ///
    /// 별도 컬럼에 저장하지 않는 이유: 이벤트가 진실의 원천이고(7번 원칙), 커밋 sha는 그
    /// 이벤트에 이미 있다. 같은 사실을 두 곳에 두면 어긋날 수 있다.
    fn committed_sha(&self, task_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .commit_event(task_id)?
            .and_then(|p| p.get("sha").and_then(Value::as_str).map(str::to_string))
            .filter(|s| !s.trim().is_empty()))
    }

    fn committed_paths(&self, task_id: &str) -> Result<Vec<String>, String> {
        Ok(self
            .commit_event(task_id)?
            .and_then(|p| {
                p.get("paths").and_then(Value::as_array).map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
            })
            .unwrap_or_default())
    }

    fn commit_event(&self, task_id: &str) -> Result<Option<Value>, String> {
        let events = self
            .with_store(|s| s.events(task_id))
            .map_err(|e| format!("이벤트 조회 실패: {e}"))?;
        Ok(events
            .into_iter()
            .rev()
            .find(|e| e.event_type == "GIT_COMMIT_CREATED")
            .map(|e| e.payload))
    }

    /// 읽기 전용 git 조회. 0이 아닌 종료 코드는 `Err`다.
    fn git_output(&self, task_id: &str, args: &[&str]) -> Result<String, String> {
        let (ok, stdout, stderr) = self.git_try(task_id, args[0], args, false)?;
        if !ok {
            return Err(format!("git {} 실패: {}", args[0], stderr.trim()));
        }
        Ok(stdout)
    }

    /// git 명령 하나를 실행하고 `(성공, stdout, stderr)`를 준다.
    /// **Policy Gate와 Tool Runtime을 그대로 지난다** — Rust가 자기 편의로 게이트를 우회하기
    /// 시작하면 게이트의 의미가 사라진다.
    ///
    /// # `ToolStatus::Ok`을 성공으로 읽으면 안 된다
    ///
    /// `run_command`는 0이 아닌 종료 코드를 "도구 실행 실패"가 아니라 "명령이 실패했다"는
    /// **사실**로 다루기 때문에 `status`는 `Ok`로 두고 `exitCode`만 남긴다(tools/mod.rs).
    /// 그래서 성공 판정은 반드시 `exitCode == 0`까지 봐야 한다. 예전 `revert_commit`은
    /// `status`만 보고 판정해서 **충돌한 revert를 "되돌렸습니다"로 보고할 수 있었다** —
    /// tip 커밋만 되돌린다는 조건이 그 경우를 우연히 막고 있었을 뿐이고, 그 조건을 없애는
    /// 순간 드러났을 결함이다.
    ///
    /// # 0이 아닌 종료를 `Err`로 만들지 않는 이유
    ///
    /// `revert`의 충돌이나 `rev-parse --verify`의 "그런 ref 없음"처럼 **0이 아닌 종료가 답
    /// 그 자체**인 호출이 있다. 그것들을 오류로 뭉개면 호출부가 다시 문자열을 뒤져야 한다.
    ///
    /// `record`는 감사 로그에 남길지다. 상태를 묻기만 하는 내부 조회(`REVERT_HEAD`가 있는가)까지
    /// 남기면 이벤트 로그가 사용자가 읽을 수 없는 것으로 가득 찬다 — 남기는 것은 **저장소를
    /// 바꾸는 명령**뿐이다.
    fn git_try(
        &self,
        task_id: &str,
        label: &str,
        args: &[&str],
        record: bool,
    ) -> Result<(bool, String, String), String> {
        let request = self.git_request(task_id, label, args);
        let profile = self.profile(task_id);
        let decision = profile.gate.evaluate(&request, &self.root, &profile.policy);
        if !decision.allowed() {
            return Err(format!("git {}이(가) 정책에 막혔습니다: {}", args[0], decision.reason));
        }
        let token = CancellationToken::new();
        let outcome = self.runtime.execute(&request, &decision, crate::tools::ApprovalState::NotRequired, &token);

        if record {
            self.with_store(|s| s.record_tool_request(&request, "rollback", &decision))
                .ok();
            let payload = json!({
                "requestId": outcome.result.request_id,
                "status": outcome.result.status,
                "revert": true,
            });
            if let Ok(appended) =
                self.with_store(|s| s.record_tool_result_with_event(&outcome.result, None, task_id, &payload))
            {
                self.relay(task_id, "TOOL_COMPLETED", &payload, &appended);
            }
        }

        // 여기 걸리는 것은 spawn 실패·타임아웃·취소처럼 **명령의 결과를 얻지 못한** 경우다.
        if outcome.result.status != ToolStatus::Ok {
            return Err(outcome
                .result
                .error
                .unwrap_or_else(|| format!("git {} 실행 실패", args[0])));
        }
        let text = |name: &str| {
            outcome
                .result
                .output
                .as_ref()
                .and_then(|o| o.get(name).and_then(Value::as_str))
                .unwrap_or_default()
                .to_string()
        };
        let exit = outcome
            .result
            .output
            .as_ref()
            .and_then(|o| o.get("exitCode").and_then(Value::as_i64));
        Ok((exit == Some(0), text("stdout"), text("stderr")))
    }

    /// ref가 존재하는가. 진행 중인 revert를 `REVERT_HEAD`로 감지하는 데 쓴다.
    ///
    /// `.git/REVERT_HEAD` 파일을 직접 보지 않는 이유: worktree나 `--git-dir`에서 그 경로가
    /// 달라진다. git에게 묻는 것이 어디서나 맞는 유일한 방법이다.
    fn git_ref_exists(&self, task_id: &str, name: &str) -> Result<bool, String> {
        let (ok, _out, _err) =
            self.git_try(task_id, "rev-parse", &["rev-parse", "--verify", "--quiet", name], false)?;
        Ok(ok)
    }

    fn git_request(&self, task_id: &str, label: &str, args: &[&str]) -> ToolRequest {
        ToolRequest {
            request_id: format!("{task_id}-git-{label}-{}", uuid::Uuid::new_v4()),
            task_id: task_id.to_string(),
            tool: ToolName::RunCommand,
            args: json!({ "program": "git", "args": args, "cwd": "." }),
            requested_by: json!({ "role": "orchestrator" }),
            // Node의 1차 분류 자리다. Rust는 이 값을 판단 근거로 쓰지 않고 기록만 한다 —
            // 실제 등급은 아래에서 `gate.evaluate`가 정한다.
            risk_tier: Some(RiskTier::Auto),
            created_at: Some(now_iso()),
        }
    }

    /// 롤백: 이 태스크가 건드린 파일을 pre-image로 되돌린다.
    /// 되돌리기도 일반 ToolRequest 경로와 이벤트 로그를 그대로 탄다(문서 10절).
    pub fn rollback(&self, task_id: &str) -> Result<Value, String> {
        let mutations = self
            .with_store(|s| s.rollback_targets(task_id))
            .map_err(|e| format!("롤백 대상 조회 실패: {e}"))?;

        let _ = self.append_event(
            task_id,
            "ROLLBACK_STARTED",
            json!({ "fileCount": mutations.len(), "paths": mutations.iter().map(|m| &m.path).collect::<Vec<_>>() }),
        );

        // 롤백 요청은 사용자가 이미 "되돌리기"를 눌러 승인한 것이므로 승인 게이트웨이를
        // 다시 거치지 않는다 — 다만 Policy Gate는 반드시 거친다(workspace 경계는 예외 없음).
        let mut restored = Vec::new();
        let mut failed = Vec::new();
        // 되돌리기는 **사용자의 동작이지 그 태스크의 실행이 아니다.** 태스크가 이미 끝났으면
        // 프로필은 워크스페이스 기본값이고, 그게 맞다 — 그 태스크가 스킬로 도구를 좁혔더라도
        // 그 제한은 "모델이 무엇을 요청할 수 있는가"였지 사용자의 되돌리기가 아니었다.
        let profile = self.profile(task_id);
        for request in self.runtime.rollback_requests(task_id, &mutations) {
            let decision = profile.gate.evaluate(&request, &self.root, &profile.policy);
            if !decision.allowed() {
                failed.push(json!({ "path": request.args.get("path"), "reason": decision.reason }));
                continue;
            }
            // 롤백은 **취소된/중단된 태스크에서도 반드시 동작해야 한다** — 오히려 그때가
            // 가장 필요한 순간이다. 그래서 태스크 취소 토큰이 아니라 새 토큰을 쓴다.
            // Policy Gate는 그대로 거치므로 workspace 경계 보장은 유지된다.
            let rollback_token = CancellationToken::new();
            let outcome = self.runtime.execute(&request, &decision, crate::tools::ApprovalState::NotRequired, &rollback_token);
            self.with_store(|s| s.record_tool_request(&request, "rollback", &decision))
                .ok();
            let payload = json!({
                "requestId": outcome.result.request_id,
                "status": outcome.result.status,
                "rollback": true,
            });
            if let Ok(appended) =
                self.with_store(|s| s.record_tool_result_with_event(&outcome.result, None, task_id, &payload))
            {
                self.relay(task_id, "TOOL_COMPLETED", &payload, &appended);
            }
            match outcome.result.status {
                ToolStatus::Ok => {
                    if let Some(path) = request.args.get("path").and_then(Value::as_str) {
                        self.with_store(|s| s.mark_mutation_rolled_back(task_id, path)).ok();
                    }
                    restored.push(request.args.get("path").cloned().unwrap_or(Value::Null));
                }
                _ => failed.push(json!({ "path": request.args.get("path"), "reason": outcome.result.error })),
            }
        }

        let payload = json!({ "restored": restored, "failed": failed });
        let _ = self.append_event(task_id, "ROLLBACK_COMPLETED", payload.clone());
        Ok(payload)
    }
}

/// 사용자가 미리 적어 둔 것이 승인을 대신한 경로. **둘을 하나로 뭉개지 않는다** —
/// 감사 로그를 읽는 사람에게 "검증 명령이라 통과했다"와 "등록된 훅이라 통과했다"는
/// 다른 사실이고, 잘못 걸렸을 때 고칠 자리도 다르다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreApproval {
    DeclaredVerification,
    RegisteredHook,
}

impl PreApproval {
    fn event_type(self) -> &'static str {
        match self {
            Self::DeclaredVerification => "APPROVAL_AUTO_VERIFICATION",
            Self::RegisteredHook => "APPROVAL_REGISTERED_HOOK",
        }
    }
}

/// 검증 명령을 Tool Runtime + 이벤트 로그를 통해 실행하는 어댑터.
struct HostExecutor<'a> {
    host: &'a TaskHost,
}

impl CommandExecutor for HostExecutor<'_> {
    fn execute(&mut self, request: &ToolRequest) -> ToolResult {
        match self.host.execute_tool(request) {
            Ok(value) => {
                serde_json::from_value(value.get("result").cloned().unwrap_or(Value::Null)).unwrap_or(ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Error,
                    output: None,
                    error: Some("검증 결과를 파싱할 수 없음".to_string()),
                    duration_ms: 0,
                    completed_at: now_iso(),
                    denial_kind: None,
                })
            }
            Err(message) => ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Error,
                output: None,
                error: Some(message),
                duration_ms: 0,
                completed_at: now_iso(),
                denial_kind: None,
            },
        }
    }
}

/// Node → Rust 요청 디스패치.
impl SidecarHandler for TaskHost {
    fn attach_ipc_meter(&self, meter: std::sync::Weak<dyn IpcLineMeter>) {
        *self.ipc_meter.lock().unwrap() = Some(meter);
    }

    fn handle_request(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "tool.execute" => {
                let raw = params
                    .get("request")
                    .ok_or_else(|| "tool.execute params에 \"request\"가 없음".to_string())?;
                let request: ToolRequest =
                    serde_json::from_value(raw.clone()).map_err(|e| format!("잘못된 ToolRequest: {e}"))?;
                self.execute_tool(&request)
            }

            "policy.evaluate" => {
                let raw = params
                    .get("request")
                    .ok_or_else(|| "policy.evaluate params에 \"request\"가 없음".to_string())?;
                let request: ToolRequest =
                    serde_json::from_value(raw.clone()).map_err(|e| format!("잘못된 ToolRequest: {e}"))?;
                // Node가 "이 요청이 어떻게 분류되나"를 미리 묻는 자리다. **그 태스크의
                // 정책으로 답해야** 미리 본 것과 실제 판정이 같다.
                let profile = self.profile(&request.task_id);
                let decision = profile.gate.evaluate(&request, &self.root, &profile.policy);
                Ok(serde_json::to_value(decision).unwrap_or(Value::Null))
            }

            "db.appendEvent" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "db.appendEvent params에 \"taskId\"가 없음".to_string())?;
                let event_type = params
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "db.appendEvent params에 \"type\"이 없음".to_string())?;
                // **Node가 낼 수 없는 이벤트가 있다**(30절) — 아래 상수 참조.
                if NODE_MAY_NOT_EMIT.contains(&event_type) {
                    return Err(format!(
                        "{event_type}은 sidecar가 낼 수 없는 이벤트입니다 — 사용자가 직접 부르는 경로에서만 기록됩니다"
                    ));
                }
                let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                self.append_event(task_id, event_type, payload)
            }

            "verify.run" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "verify.run params에 \"taskId\"가 없음".to_string())?;
                let phase = match params.get("phase").and_then(Value::as_str) {
                    Some("baseline") => VerificationPhase::Baseline,
                    Some("post") | None => VerificationPhase::Post,
                    Some(other) => return Err(format!("알 수 없는 검증 phase: {other:?}")),
                };
                let attempt = params.get("attemptNumber").and_then(Value::as_u64).unwrap_or(0) as u32;
                self.run_verification(task_id, phase, attempt)
            }

            // 워크스페이스 지문 — product-strategy 6절 "Agent Trace 완성".
            //
            // **Rust가 계산하고 Rust가 기록한다.** Node는 "지금 찍어라"만 말할 수 있고 값에는
            // 손대지 못한다 — `verify.run`과 같은 이유다(Node가 "검증했다"를 만들어낼 수 없어야
            // 하듯, "이 상태였다"도 만들어낼 수 없어야 한다).
            "workspace.fingerprint" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "workspace.fingerprint params에 \"taskId\"가 없음".to_string())?;
                self.record_workspace_fingerprint(task_id)
            }

            // ---- WorkspaceIndex 캐시 (context-engine.md 2절, process-architecture.md 11.4절) ----
            //
            // **워크스페이스 id를 Node가 정하지 않는다.** Rust가 자기 루트에서 유도한다 —
            // Node가 id를 말할 수 있으면 다른 워크스페이스의 캐시를 읽고 쓸 수 있고,
            // 그건 "이 루트를 벗어날 수 없다"를 캐시 계층에서 우회하는 길이다.
            "index.load" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "index.load params에 \"taskId\"가 없음".to_string())?;
                let fingerprint = self.index_cache_key(task_id);
                let Some(key) = fingerprint.clone() else {
                    // 지문을 낼 수 없으면(git 저장소가 아니면) **캐시를 쓰지 않는다.**
                    // 워크스페이스가 그때와 같은지 판정할 방법이 없기 때문이다 —
                    // "모른다"를 "같다"로 읽으면 낡은 파일 목록으로 모델을 부르게 된다.
                    return Ok(
                        json!({ "fingerprint": null, "index": null, "reason": "지문을 낼 수 없어 캐시를 쓰지 않습니다" }),
                    );
                };
                let cached = self
                    .with_store(|s| s.cached_workspace_index(&self.workspace_id(), &key))
                    .map_err(|e| format!("인덱스 캐시 조회 실패: {e}"))?;
                match cached {
                    Some(hit) => {
                        // **캐시의 이득을 재는 자리다.** 11.4절은 "전환을 싸게 만든다"고 적었는데
                        // 그 이득은 아직 측정된 적이 없다 — 적중 여부와 원래 걸린 시간을 남긴다.
                        let _ = self.append_event(
                            task_id,
                            "WORKSPACE_INDEX_CACHE_HIT",
                            json!({
                                "builtAt": hit.get("builtAt").cloned().unwrap_or(Value::Null),
                                "savedBuildMs": hit.get("buildMs").cloned().unwrap_or(Value::Null),
                            }),
                        );
                        Ok(json!({
                            "fingerprint": key,
                            "index": hit.get("index").cloned().unwrap_or(Value::Null),
                            "builtAt": hit.get("builtAt").cloned().unwrap_or(Value::Null),
                            "buildMs": hit.get("buildMs").cloned().unwrap_or(Value::Null),
                        }))
                    }
                    None => Ok(json!({ "fingerprint": key, "index": null })),
                }
            }

            "index.save" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "index.save params에 \"taskId\"가 없음".to_string())?;
                let claimed = params
                    .get("fingerprint")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "index.save params에 \"fingerprint\"가 없음".to_string())?;
                let index = params
                    .get("index")
                    .cloned()
                    .ok_or_else(|| "index.save params에 \"index\"가 없음".to_string())?;
                let build_ms = params.get("buildMs").and_then(Value::as_i64);

                // **인덱스를 만드는 사이에 워크스페이스가 바뀌었으면 저장하지 않는다.**
                // 그 인덱스는 지금 존재하지 않는 상태를 설명하므로, 어느 지문으로 저장해도
                // 틀린다 — 옛 지문으로 저장하면 그 상태에 없던 내용이 들어가고, 새 지문으로
                // 저장하면 아직 반영되지 않은 변경을 반영했다고 주장하게 된다.
                let now = self.index_cache_key(task_id);
                if now.as_deref() != Some(claimed) {
                    return Ok(json!({
                        "saved": false,
                        "reason": "인덱스를 만드는 사이에 워크스페이스가 바뀌었습니다",
                    }));
                }
                self.with_store(|s| s.save_workspace_index(&self.workspace_id(), claimed, None, &index, build_ms))
                    .map_err(|e| format!("인덱스 캐시 저장 실패: {e}"))?;
                let _ = self.append_event(
                    task_id,
                    "WORKSPACE_INDEX_BUILT",
                    json!({
                        "buildMs": build_ms,
                        // 인덱스의 크기를 함께 남긴다 — 걸린 시간만으로는 그게 큰 저장소 때문인지
                        // 느린 디스크 때문인지 구별되지 않는다.
                        "fileCount": index.get("fileTree").and_then(Value::as_array).map(|a| a.len()),
                    }),
                );
                Ok(json!({ "saved": true, "fingerprint": claimed }))
            }

            "usage.record" => {
                let usage = params.get("usage").cloned().unwrap_or(Value::Null);
                self.with_store(|s| s.record_provider_usage(&usage))
                    .map_err(|e| format!("provider_usage 기록 실패: {e}"))?;
                if let Some(task_id) = usage.get("taskId").and_then(Value::as_str) {
                    let _ = self.append_event(task_id, "PROVIDER_USAGE", usage.clone());
                }
                Ok(json!({ "recorded": true }))
            }

            // 자격증명은 spawn 시 환경변수로 1회 주입한다(process-architecture.md 2절).
            // Node가 런타임에 키를 다시 요청하는 경로를 열지 않는다 — 재요청 빈도로 이상을
            // 탐지하겠다는 8절 미해결 항목보다, 아예 경로를 없애는 편이 M0에서 단순하고 안전하다.
            "credential.get" => {
                Err("credential.get은 지원하지 않음 — 자격증명은 sidecar spawn 시 환경변수로 1회 주입된다".to_string())
            }

            other => Err(format!("알 수 없는 method: {other}")),
        }
    }

    fn handle_event(&self, task_id: &str, event: &Value) {
        // Node가 발행한 phase 전이 등을 이벤트 로그에 기록하고 UI로 릴레이한다.
        // Rust는 내용을 해석하지 않는다(process-architecture.md 4절) — 단, 이벤트 로그에
        // 남기려면 event_type은 알아야 하므로 그 필드만 읽는다.
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("ERROR");
        if task_id.is_empty() {
            // ready 등 태스크에 속하지 않는 이벤트는 로그 대상이 아니고 UI 릴레이만 한다.
            self.sink.emit("sidecar-event", event);
            return;
        }
        let payload = {
            let mut p = event.clone();
            if let Some(obj) = p.as_object_mut() {
                obj.remove("type");
            }
            p
        };
        let _ = self.append_event(task_id, event_type, payload);
    }
}

/// 이벤트 로그에 들어가는 args에서 큰 본문을 덜어낸다.
///
/// 두 가지 이유가 겹친다:
///  - **크기**: 파일 본문 전체를 이벤트에 인라인하면 로그가 비대해진다.
///  - **비밀값**: 대상 경로가 secret으로 분류되면 미리보기조차 남기지 않는다. `.env`에 쓰려는
///    값의 앞 512바이트는 대개 키 전체를 포함한다 — 자르는 것으로는 보호가 되지 않는다.
fn redact_args(args: &Value) -> Value {
    let Some(obj) = args.as_object() else {
        return args.clone();
    };
    let secret_target = obj
        .get("path")
        .and_then(Value::as_str)
        .map(secrets::is_secret_path)
        .unwrap_or(false);

    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        match (k.as_str(), v) {
            ("content" | "patch", Value::String(s)) if secret_target => {
                out.insert(
                    k.clone(),
                    json!({ "bytes": s.len(), "redacted": true, "reason": "비밀값 경로" }),
                );
            }
            ("content" | "patch", Value::String(s)) => {
                out.insert(k.clone(), json!({ "bytes": s.len(), "preview": truncate(s, 512) }));
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

/// `USER_DECISION_RECORDED`의 자유 텍스트에서 비밀값 모양을 가린다.
///
/// # 왜 이 이벤트만인가
///
/// 마스킹을 모든 이벤트에 걸면 `DRAFT_RECEIVED.patch`처럼 **원문 그대로여야 의미가 있는**
/// 기록까지 변형된다. 감사 로그의 patch가 실제 적용된 patch와 다르면 그 로그는 감사에 쓸 수 없다.
/// 그래서 대상을 "사용자가 자유 입력한 텍스트"로 좁힌다 — 여기가 붙여넣기가 실제로 일어나는
/// 자리이고(문서 17.3절), 여기서는 마스킹된 텍스트가 원문의 역할을 그대로 한다.
///
/// 마스킹 **개수**를 payload에 남기는 이유: 0이 아니면 "가린 것이 있었다"가 로그에 보인다.
/// 이건 "남은 것이 없다"는 주장이 아니다 — 모양 기반 탐지의 한계는 `secrets` 모듈에 적어두었다.
/// **sidecar가 낼 수 없는 이벤트 종류.** `db.appendEvent`가 이 목록을 거절한다 (30절).
///
/// # 왜 목록이 이것뿐인가 — 원칙이 있다
///
/// Node는 `USER_DECISION_RECORDED`처럼 "사용자가 이렇게 답했다"는 이벤트를 **낼 수 있다.**
/// 그 답변은 오케스트레이터가 던진 질문의 회신이라 그 경로를 지나는 것이 자연스럽고, 막으면
/// 재질문 왕복 자체가 성립하지 않는다.
///
/// 여기 있는 것은 성질이 다르다: **오케스트레이터가 관여하지 않는 사용자 행위**의 기록이다.
/// 사용자가 화면이나 CLI에서 직접 부르고, 그 사이 어디에도 Node가 없다. Node가 이걸 낼 이유가
/// 없으므로 거절해도 잃는 것이 없고, 거절하면 장악당한 Node가 **사용자가 하지 않은 일을
/// 했다고 기록하는 경로**가 하나 닫힌다 — 철회는 앞선 판정을 조용히 지우는 데 쓸 수 있고,
/// 롤백 기록은 복원되지 않은 파일을 복원됐다고 말하는 데 쓸 수 있다.
///
/// **"Rust가 내는 이벤트 전부"가 아니다.** 그런 목록이었다면 Node가 정당하게 내는 것까지
/// 섞여 언젠가 한쪽을 풀어야 하고, 그때 이 상수는 판정 근거가 되지 못한다.
/// 이 목록이 실제로 그 성질을 갖는지는 sidecar 소스에서 유도해 검사한다
/// (`packages/toolchain/test/rustOnlyEvents.test.ts`).
pub const NODE_MAY_NOT_EMIT: &[&str] = &[
    "USER_DECISION_WITHDRAWN",
    "ROLLBACK_STARTED",
    "ROLLBACK_COMPLETED",
    "ROLLBACK_FAILED",
];

fn redact_user_decision(event_type: &str, payload: Value) -> Value {
    // 철회 사유도 **사용자가 자유 입력한 텍스트**다. 여기를 빼면 붙여넣은 토큰이 가려지는
    // 자리와 가려지지 않는 자리가 생기고, 사용자는 둘을 구별할 방법이 없다.
    if event_type != "USER_DECISION_RECORDED" && event_type != "USER_DECISION_WITHDRAWN" {
        return payload;
    }
    let mut value = payload;
    let mut total_masked = 0usize;

    if let Some(Value::String(reason)) = value.get("reason") {
        let (masked, count) = secrets::mask_secret_shapes(reason);
        total_masked += count;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("reason".to_string(), Value::String(masked));
        }
    }

    if let Some(Value::String(answer)) = value.get("answer") {
        let (masked, count) = secrets::mask_secret_shapes(answer);
        total_masked += count;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("answer".to_string(), Value::String(masked));
        }
    }
    // 기준 텍스트는 답변 원문에서 만들어지므로 같은 값이 한 번 더 들어 있다.
    // 한쪽만 가리면 다른 쪽으로 그대로 새고, 그 사본이 파생 캐시에까지 들어간다.
    if let Some(items) = value.get_mut("acceptanceCriteria").and_then(Value::as_array_mut) {
        for item in items {
            let Some(Value::String(text)) = item.get("text") else {
                continue;
            };
            let (masked, count) = secrets::mask_secret_shapes(text);
            total_masked += count;
            if let Some(obj) = item.as_object_mut() {
                obj.insert("text".to_string(), Value::String(masked));
            }
        }
    }

    if let Some(obj) = value.as_object_mut() {
        obj.insert("secretShapesMasked".to_string(), json!(total_masked));
    }
    value
}

/// `APPROVAL_REQUESTED` 이벤트용 축약. 승인 모달로 가는 원본은 건드리지 않는다.
///
/// `preview`만 제거하는 이유: 나머지 필드(tool, riskLevel, reason, command argv, path)는
/// "무엇을 승인했는가"의 감사 기록으로 반드시 남아야 한다. 본문만 없으면 된다.
fn redact_approval_for_event(approval: &ApprovalRequest) -> Value {
    let mut value = serde_json::to_value(approval).unwrap_or(Value::Null);
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            let secret_target = item
                .get("path")
                .and_then(Value::as_str)
                .map(secrets::is_secret_path)
                .unwrap_or(false);
            let Some(obj) = item.as_object_mut() else { continue };
            match obj.get("preview") {
                Some(Value::String(preview)) => {
                    let bytes = preview.len();
                    obj.insert(
                        "preview".to_string(),
                        if secret_target {
                            json!({ "bytes": bytes, "redacted": true, "reason": "비밀값 경로" })
                        } else {
                            json!({ "bytes": bytes, "preview": truncate(preview, 512) })
                        },
                    );
                }
                _ => continue,
            }
        }
    }
    value
}

/// 큰 출력을 이벤트에 그대로 싣지 않기 위한 요약.
///
/// **요약은 크기를 줄이는 것이지 사실을 줄이는 것이 아니다.** 잘라낸 쪽에서 `exitCode`가
/// 함께 사라지고 있었고, 그 결과 감사 기록이 **명령의 성공 여부를 말하지 못했다.**
/// 출력이 16KB 이하면 artifact도 만들어지지 않으므로 그 사실을 되찾을 곳이 아예 없었다
/// (4KB~16KB 구간). 재현 적용기가 "기록된 종료 코드와 같은가"를 물으면서 드러났다 —
/// 기록에서 실패했던 단계를 그대로 재현했는데 비교할 값이 없어서 멈췄다.
fn summarize_output(output: Option<&Value>) -> Value {
    let Some(value) = output else { return Value::Null };
    let serialized = value.to_string();
    if serialized.len() <= MAX_INLINE_OUTPUT_BYTES / 4 {
        return value.clone();
    }
    json!({
        "preview": truncate(&serialized, 1024),
        "sizeBytes": serialized.len(),
        // 잘라도 이것만은 남긴다. 정수 하나이고, 이게 없으면 목록 전체가 "성공한 단계들"로 읽힌다.
        "exitCode": value.get("exitCode").cloned().unwrap_or(Value::Null),
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…(truncated)", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// **요약은 크기를 줄이는 것이지 사실을 줄이는 것이 아니다.** 잘라낸 쪽에서 종료 코드가
    /// 함께 사라지면 감사 기록이 명령의 성공 여부를 말하지 못한다 — 그리고 그 크기 구간에서는
    /// artifact도 만들어지지 않으므로 되찾을 곳이 없다.
    #[test]
    fn a_truncated_output_summary_still_carries_the_exit_code() {
        let big = "x".repeat(MAX_INLINE_OUTPUT_BYTES);
        let out = summarize_output(Some(&json!({ "exitCode": 3, "stdout": big })));
        assert!(
            out.get("preview").is_some(),
            "잘리지 않았습니다 — 이 테스트의 전제가 깨졌습니다"
        );
        assert_eq!(out["exitCode"], json!(3), "요약이 종료 코드를 버렸습니다: {out}");
    }

    /// 자르지 않는 크기에서는 원본이 그대로 나가야 한다 — 위 테스트가 두 경로를 다 덮도록.
    #[test]
    fn a_small_output_is_not_summarized() {
        let value = json!({ "exitCode": 0, "stdout": "ok" });
        assert_eq!(summarize_output(Some(&value)), value);
    }

    fn host(
        policy: TaskPolicy,
        approvals: Arc<dyn ApprovalGateway>,
    ) -> (tempfile::TempDir, tempfile::TempDir, TaskHost) {
        host_with_manifest(policy, approvals, None)
    }

    /// `manifest`가 있으면 **호스트를 만들기 전에** `package.json`으로 쓴다 — 검증 명령 고정이
    /// 생성 시점의 매니페스트를 읽는지 확인하려면 순서가 이래야 한다.
    fn host_with_manifest(
        policy: TaskPolicy,
        approvals: Arc<dyn ApprovalGateway>,
        manifest: Option<&str>,
    ) -> (tempfile::TempDir, tempfile::TempDir, TaskHost) {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir_all(ws.path().join("src")).unwrap();
        fs::write(ws.path().join("src/app.ts"), "a\nb\nc\n").unwrap();
        if let Some(text) = manifest {
            fs::write(ws.path().join("package.json"), text).unwrap();
        }
        let art = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(art.path()).unwrap();
        let mut store = Store::open_in_memory(artifacts.clone()).unwrap();
        store
            .upsert_workspace("ws-1", &ws.path().to_string_lossy(), "ws")
            .unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task(
                "task-1",
                "sess-1",
                "ws-1",
                &ws.path().to_string_lossy(),
                "verified",
                "fix",
            )
            .unwrap();
        let root = WorkspaceRoot::new(ws.path()).unwrap();
        let host = TaskHost::new(
            root,
            policy,
            Arc::new(Mutex::new(store)),
            artifacts,
            approvals,
            Arc::new(NullSink),
            Arc::new(CancellationRegistry::new()),
        );
        (ws, art, host)
    }

    /// sink로 나간 이벤트를 기록한다 — "DB에는 남았는데 UI로는 안 갔다"를 잡기 위한 것.
    #[derive(Default)]
    struct RecordingSink {
        seen: Mutex<Vec<String>>,
        /// 원본 payload — "DB는 막았는데 화면으로 흘렸다"를 잡기 위해 필요하다.
        payloads: Mutex<Vec<String>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, _channel: &str, payload: &Value) {
            self.seen
                .lock()
                .unwrap()
                .push(payload.get("type").and_then(Value::as_str).unwrap_or("").to_string());
            self.payloads.lock().unwrap().push(payload.to_string());
        }
    }

    /// 테스트용 git 저장소. identity와 gpgsign을 저장소 로컬로 박는 이유는 픽스처와 같다 —
    /// 전역 설정이 없는 환경에서 **검증하려는 것과 무관한 이유로** 실패하면 안 된다.
    /// 테스트가 저장소 상태를 만들 때 쓰는 git. 종료 코드를 검사하지 않는다 —
    /// 충돌하는 revert를 **일부러** 만드는 테스트가 있기 때문이다.
    fn git_at(root: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .output()
            .expect("git을 실행할 수 없습니다");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// 이 태스크가 만든 커밋 하나를 흉내낸다: 파일을 바꾸고 커밋한 뒤 그 sha를 이벤트에 남긴다.
    fn commit_as_task(host: &TaskHost, root: &std::path::Path, task_id: &str, body: &str) -> String {
        fs::write(root.join("src/app.ts"), body).unwrap();
        git_at(root, &["add", "-A"]);
        git_at(root, &["commit", "-m", "task commit"]);
        let sha = git_at(root, &["rev-parse", "HEAD"]).trim().to_string();
        host.append_event(
            task_id,
            "GIT_COMMIT_CREATED",
            json!({ "sha": sha, "paths": ["src/app.ts"], "branch": "main" }),
        )
        .unwrap();
        sha
    }

    fn init_git_repo(root: &std::path::Path) {
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("git을 실행할 수 없습니다");
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.invalid"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["add", "-A"]);
        git(&["commit", "-m", "initial"]);
    }

    fn host_with_sink(sink: Arc<RecordingSink>) -> (tempfile::TempDir, tempfile::TempDir, TaskHost) {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir_all(ws.path().join("src")).unwrap();
        fs::write(ws.path().join("src/app.ts"), "a\nb\nc\n").unwrap();
        let art = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(art.path()).unwrap();
        let mut store = Store::open_in_memory(artifacts.clone()).unwrap();
        store
            .upsert_workspace("ws-1", &ws.path().to_string_lossy(), "ws")
            .unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task(
                "task-1",
                "sess-1",
                "ws-1",
                &ws.path().to_string_lossy(),
                "verified",
                "fix",
            )
            .unwrap();
        let root = WorkspaceRoot::new(ws.path()).unwrap();
        let host = TaskHost::new(
            root,
            TaskPolicy::default(),
            Arc::new(Mutex::new(store)),
            artifacts,
            Arc::new(AutoApprove),
            sink,
            Arc::new(CancellationRegistry::new()),
        );
        (ws, art, host)
    }

    /// 12절 미해결 "취소 중 상한" — 기다리기를 그만두는 탈출구.
    #[test]
    fn force_abandon_terminalizes_the_task_without_claiming_cleanup() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink.clone());

        let result = host.force_abandon("task-1").unwrap();
        assert_eq!(result.get("abandoned").and_then(Value::as_bool), Some(true));

        // 태스크가 실제로 터미널이 됐다 — 사용자가 "취소 중" 화면에서 풀려난다.
        let task = host.with_store(|s| s.get_task("task-1")).unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("CANCELLED"));

        // **"정리됐다"고 말하지 않는다.** 남은 프로세스가 있을 수 있다는 것이 이 경로의
        // 정의이지 예외가 아니므로, 그 사실이 이벤트에 남아야 한다.
        let event = host
            .with_store(|s| s.events("task-1"))
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "TASK_CANCELLED")
            .expect("terminal 이벤트가 없습니다");
        assert_eq!(event.payload.get("forceAbandoned").and_then(Value::as_bool), Some(true));
        let summary = event.payload.get("summary").and_then(Value::as_str).unwrap_or("");
        assert!(
            summary.contains("남아 있을 수 있"),
            "남은 프로세스 가능성을 알리지 않습니다: {summary}"
        );
    }

    /// 기다리는 사이에 정상 종료된 경우는 **오류가 아니라 좋은 소식**이다.
    #[test]
    fn force_abandon_does_not_override_an_already_finished_task() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);

        host.finish_task(
            "task-1",
            "COMPLETED",
            "TASK_COMPLETED",
            None,
            json!({ "status": "completed" }),
        )
        .unwrap();

        let result = host.force_abandon("task-1").unwrap();
        assert_eq!(result.get("abandoned").and_then(Value::as_bool), Some(false));
        assert_eq!(result.get("status").and_then(Value::as_str), Some("COMPLETED"));
        // 완료를 취소로 덮어쓰지 않는다 — 먼저 확정된 쪽이 남는다.
        let task = host.with_store(|s| s.get_task("task-1")).unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("COMPLETED"));
    }

    // ---- 판정의 철회 (30절) ----

    fn decided(host: &TaskHost, task_id: &str, criterion_id: &str, text: &str) {
        host.append_event(
            task_id,
            "USER_DECISION_RECORDED",
            json!({ "acceptanceCriteria": [{
                "criterionId": criterion_id, "text": text, "source": "user_decision",
                "decidedAt": "2026-01-01T00:00:00Z",
            }] }),
        )
        .unwrap();
    }

    /// 끝난 태스크의 판정을 거두면 **다음 태스크로 나르지 않는다.** 그것이 철회의 전부다.
    #[test]
    fn withdrawing_a_decision_stops_it_from_being_carried() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink.clone());
        decided(&host, "task-1", "c-1", "1페이지는 첫 항목부터");
        host.finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();

        let before = host
            .with_store(|s| crate::session_memory::collect(s, "sess-1", "task-9"))
            .unwrap();
        assert_eq!(before.decisions.len(), 1);

        let out = host.withdraw_decision("sess-1", "task-1", "c-1", None).unwrap();
        assert_eq!(out.get("withdrawn").and_then(Value::as_bool), Some(true), "{out}");

        let after = host
            .with_store(|s| crate::session_memory::collect(s, "sess-1", "task-9"))
            .unwrap();
        assert!(after.decisions.is_empty(), "{:?}", after.decisions);
        // 화면도 그 사실을 받는다 — DB에만 남고 화면에 안 보이는 변화를 만들지 않는다.
        let seen = sink.seen.lock().unwrap().clone();
        assert!(
            seen.contains(&"USER_DECISION_WITHDRAWN".to_string()),
            "sink에 철회 이벤트가 없습니다: {seen:?}"
        );
    }

    /// **거절은 오류가 아니라 값이다.** 오류로 내면 "거두지 못했다"와 "저장소가 깨졌다"가
    /// 호출자에게 같은 모양이 된다.
    #[test]
    fn a_running_tasks_decision_is_refused_with_a_reason_not_an_error() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        decided(&host, "task-1", "c-1", "진행 중");

        let out = host.withdraw_decision("sess-1", "task-1", "c-1", None).unwrap();
        assert_eq!(out.get("withdrawn").and_then(Value::as_bool), Some(false), "{out}");
        assert_eq!(out.get("refusal").and_then(Value::as_str), Some("task_still_running"), "{out}");
        assert!(out.get("detail").and_then(Value::as_str).unwrap_or("").contains("진행 중"), "{out}");
        // 거절했으면 이벤트도 남기지 않는다 — 남기면 로그가 하지 않은 일을 말한다.
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(!types.contains(&"USER_DECISION_WITHDRAWN".to_string()), "{types:?}");
    }

    /// 철회 사유도 **사용자가 자유 입력한 텍스트**다. 가리는 자리와 가리지 않는 자리가
    /// 갈리면 사용자는 둘을 구별할 방법이 없다.
    #[test]
    fn a_withdrawal_reason_is_masked_like_any_other_free_text() {
        const PASTED: &str = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        decided(&host, "task-1", "c-1", "거둘 것");
        host.finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();

        host.withdraw_decision("sess-1", "task-1", "c-1", Some(&format!("이 토큰 때문 {PASTED}")))
            .unwrap();

        let stored = host.with_store(|s| s.events_after("task-1", None)).unwrap();
        let event = stored
            .into_iter()
            .find(|e| e.event_type == "USER_DECISION_WITHDRAWN")
            .expect("철회 이벤트가 없습니다");
        let reason = event.payload.get("reason").and_then(Value::as_str).unwrap_or("");
        assert!(!reason.contains(PASTED), "사유에 원문이 남았습니다: {reason}");
        assert!(reason.contains("이 토큰 때문"), "사유 본문까지 지웠습니다: {reason}");
    }

    /// **sidecar는 철회를 기록할 수 없다.** 낼 수 있으면 장악당한 Node가 사용자가 하지 않은
    /// 철회를 기록해 앞선 판정을 조용히 지울 수 있다.
    ///
    /// **이벤트 이름을 여기 적는 것이 맞다.** `NODE_MAY_NOT_EMIT`을 훑는 것만으로는 이 성질을
    /// 지킬 수 없다 — 목록에서 항목을 지우면 훑을 것이 사라져 검사가 통과한다(실제로 그 probe가
    /// 통과했다). 목록은 **수단**이고, 지켜야 하는 것은 "철회는 Node를 지나지 않는다"는
    /// **주장**이므로, 주장은 목록과 무관하게 적는다.
    #[test]
    fn the_sidecar_cannot_emit_a_withdrawal() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        decided(&host, "task-1", "c-1", "거둘 것");

        let err = host
            .handle_request(
                "db.appendEvent",
                &json!({ "taskId": "task-1", "type": "USER_DECISION_WITHDRAWN", "payload": {
                    "withdrawnAt": "2026-02-02T00:00:00Z",
                    "acceptanceCriteriaWithdrawn": ["c-1"],
                } }),
            )
            .unwrap_err();
        assert!(err.contains("USER_DECISION_WITHDRAWN"), "{err}");

        // 판정은 그대로 나른다 — 거부가 실제로 효력을 가졌는지는 결과로 본다.
        let memory = host
            .with_store(|s| crate::session_memory::collect(s, "sess-1", "task-9"))
            .unwrap();
        assert_eq!(memory.decisions.len(), 1, "{:?}", memory.decisions);

        // **이 거부가 모든 이벤트를 막는 것이 아니다.** 막았다면 위 단언은 아무 말도 하지 않는다.
        assert!(host
            .handle_request(
                "db.appendEvent",
                &json!({ "taskId": "task-1", "type": "PLAN_CREATED", "payload": {} }),
            )
            .is_ok());
    }

    /// 목록에 **올라간 것은 전부** 거절된다. 위 테스트가 주장 하나를 지킨다면 이것은 수단이
    /// 목록 전체에 대해 작동하는지를 본다 — 항목이 늘어날 때 조용히 빠지는 것을 막는다.
    #[test]
    fn every_entry_in_the_deny_list_is_actually_refused() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        assert!(!NODE_MAY_NOT_EMIT.is_empty(), "거절 목록이 비면 이 검사는 아무 말도 하지 않습니다");
        for event_type in NODE_MAY_NOT_EMIT.iter().copied() {
            let err = host
                .handle_request(
                    "db.appendEvent",
                    &json!({ "taskId": "task-1", "type": event_type, "payload": {} }),
                )
                .unwrap_err();
            assert!(err.contains(event_type), "{err}");
        }
    }

    /// 문서 17.3절: 판정 원문은 남되 비밀값 모양은 가려야 한다.
    ///
    /// **Node가 보낸 payload를 그대로 믿지 않는 경로를 검증한다.** Node가 마스킹하고 보내주기를
    /// 기대하면, 장악당한 Node에서 그 규칙이 사라진다(원칙 2). 그래서 마스킹은 저장 직전
    /// Rust에서 일어나고, DB와 UI 릴레이 **양쪽**에 가려진 값이 간다.
    #[test]
    fn user_decision_keeps_the_answer_but_masks_secret_shapes() {
        const PASTED: &str = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink.clone());

        host.append_event(
            "task-1",
            "USER_DECISION_RECORDED",
            json!({
                "questions": ["빈 문자열 이메일은 통과입니까, 거부입니까?"],
                "answer": format!("거부해주세요. 토큰은 {PASTED} 입니다"),
                "acceptanceCriteria": [{
                    "criterionId": "u-1",
                    "text": format!("거부해주세요. 토큰은 {PASTED} 입니다"),
                    "source": "user_decision",
                    "decidedAt": "2024-01-01T00:00:00Z",
                }],
            }),
        )
        .unwrap();

        let stored = host
            .with_store(|s| s.events("task-1"))
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "USER_DECISION_RECORDED")
            .expect("USER_DECISION_RECORDED가 기록되지 않았습니다");
        let payload = stored.payload.to_string();

        assert!(
            !payload.contains(PASTED),
            "붙여넣은 토큰이 이벤트에 남았습니다:\n{payload}"
        );
        // 원문이 통째로 사라지면 판정자의 판정이 다시 감사 로그에서 없어진다 — 그게 이 작업이 고친 구멍이다.
        assert!(payload.contains("거부해주세요"), "판정 원문이 사라졌습니다:\n{payload}");
        assert_eq!(
            stored.payload.get("secretShapesMasked").and_then(Value::as_u64),
            Some(2)
        );

        // 파생 캐시에도 가려진 값이 들어가야 한다. 한쪽만 막으면 다른 쪽으로 샌다.
        let criteria = host.with_store(|s| s.acceptance_criteria("task-1")).unwrap();
        assert_eq!(criteria.len(), 1);
        assert!(!criteria[0].text.contains(PASTED), "파생 캐시에 토큰이 남았습니다");

        let relayed = sink.payloads.lock().unwrap().join("\n");
        assert!(!relayed.contains(PASTED), "UI 릴레이로 토큰이 흘렀습니다:\n{relayed}");
    }

    /// 마스킹을 모든 이벤트에 걸면 감사 로그의 patch가 실제 적용된 patch와 달라진다.
    /// 그러면 그 로그는 "무엇이 적용됐나"에 답할 수 없어 감사에 쓸 수 없다.
    #[test]
    fn other_events_are_not_reshaped_by_the_mask() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        let patch = "--- a/x\n+++ b/x\n-const token = \"sk-abcdefghijklmnopqrstuvwxyz012345\";\n";

        host.append_event("task-1", "DRAFT_RECEIVED", json!({ "patch": patch }))
            .unwrap();

        let stored = host
            .with_store(|s| s.events("task-1"))
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "DRAFT_RECEIVED")
            .unwrap();
        assert_eq!(stored.payload.get("patch").and_then(Value::as_str), Some(patch));
    }

    /// 명세 §5 "DB 이벤트에 API 키와 비밀 값 저장 금지"의 실체.
    ///
    /// **Node를 신뢰하지 않는 경로를 검증한다.** Node의 Context Engine이 secret 파일을 걸러도,
    /// 장악당한 Node는 필터를 우회해 `read_file(".env")`를 그냥 요청할 수 있다. 그때
    /// (a) Policy Gate가 자동 허용하지 않고 (b) 사용자가 승인해도 값이 이벤트에 남지 않아야 한다.
    #[test]
    fn secret_file_contents_never_reach_the_event_log() {
        const SECRET: &str = "sk-must-never-appear-in-the-event-log";
        let sink = Arc::new(RecordingSink::default());
        let (ws, _a, host) = host_with_sink(sink.clone());
        fs::write(ws.path().join(".env"), format!("OPENAI_API_KEY={SECRET}\n")).unwrap();

        // 1) 자동 허용이 아니라 승인 필요로 분류된다.
        let read = req(ToolName::ReadFile, json!({ "path": ".env" }));
        let decision = host.default_profile.gate.evaluate(&read, host.root(), host.policy());
        assert!(
            decision.requires_user_approval,
            "비밀값 파일 읽기가 자동 허용되었습니다: {decision:?}"
        );

        // 2) 사용자가 승인해도(AutoApprove 게이트웨이) 값이 이벤트에 남지 않는다.
        //    승인은 "모델이 이번 판단에 쓰는 것"에 대한 동의이고, "감사 로그 영구 보관"이 아니다.
        let result = host.execute_tool(&read).unwrap();
        let output = result.pointer("/result/output").and_then(|v| v.get("content"));
        assert!(
            output
                .map(|c| c.as_str() == Some(&format!("OPENAI_API_KEY={SECRET}\n")))
                .unwrap_or(false),
            "승인된 읽기는 호출자에게 실제 내용을 돌려줘야 합니다 (이벤트에만 남지 않는 것이다)"
        );

        // 3) DB의 어떤 이벤트에도 비밀값이 없다.
        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let all = events
            .iter()
            .map(|e| e.payload.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!all.contains(SECRET), "이벤트 로그에 비밀값이 저장되었습니다:\n{all}");

        // 4) UI로 릴레이된 스트림에도 없다 — DB만 막고 화면으로 흘리면 의미가 없다.
        let relayed = sink.payloads.lock().unwrap().join("\n");
        assert!(
            !relayed.contains(SECRET),
            "이벤트 스트림에 비밀값이 유출되었습니다:\n{relayed}"
        );
    }

    /// 비밀값 파일에 **쓰는** 경로. 자동 승인 정책이 켜져 있어도 승인을 요구해야 하고,
    /// 쓰려는 값이 이벤트에 남지 않아야 한다.
    #[test]
    fn writing_a_secret_file_requires_approval_even_when_auto_approve_is_on() {
        const NEW_SECRET: &str = "sk-newly-written-value-must-not-leak";
        let policy = TaskPolicy {
            auto_approve_workspace_writes: true,
            ..TaskPolicy::default()
        };
        let (_ws, _a, host) = host(policy, Arc::new(AutoApprove));

        let write = req(
            ToolName::CreateFile,
            json!({ "path": ".env.local", "content": format!("KEY={NEW_SECRET}\n") }),
        );
        let decision = host.default_profile.gate.evaluate(&write, host.root(), host.policy());
        assert!(
            decision.requires_user_approval,
            "auto_approve_workspace_writes가 비밀값 파일 쓰기까지 자동 승인했습니다: {decision:?}"
        );

        host.execute_tool(&write).unwrap();
        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let all = events
            .iter()
            .map(|e| e.payload.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !all.contains(NEW_SECRET),
            "쓰려던 비밀값이 이벤트에 저장되었습니다:\n{all}"
        );
        // 그러나 "무엇을 했는가"는 남아야 한다 — 값만 빠지고 감사 추적은 유지된다.
        assert!(all.contains(".env.local"), "감사에 필요한 경로 정보까지 사라졌습니다");
    }

    /// 일반 소스 파일은 이 규칙에 걸리지 않아야 한다.
    /// 오탐이 많으면 정상 작업이 매번 승인 모달을 띄우게 되어 승인이 무의미해진다.
    #[test]
    fn ordinary_files_are_still_auto_approved_for_reading() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let read = req(ToolName::ReadFile, json!({ "path": "src/app.ts" }));
        let decision = host.default_profile.gate.evaluate(&read, host.root(), host.policy());
        assert!(!decision.requires_user_approval, "일반 파일 읽기에 승인을 요구했습니다");
    }

    /// M0.1 회귀 방지: 레코드와 이벤트를 한 트랜잭션에 쓰는 `record_*_with_event` 경로는
    /// `append_event`를 거치지 않는다. 커밋 후 sink로 릴레이하지 않으면 DB에는 남는데
    /// **UI에서는 파일 변경이 보이지 않는다.** 조용히 사라지는 종류의 버그라 테스트로 못박는다.
    #[test]
    fn combined_writes_are_relayed_to_the_ui_not_only_to_the_database() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _a, host) = host_with_sink(sink.clone());
        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
        ))
        .unwrap();

        let emitted = sink.seen.lock().unwrap().clone();
        assert!(
            emitted.contains(&"FILE_MUTATED".to_string()),
            "sink로 나간 이벤트: {emitted:?}"
        );
        assert!(
            emitted.contains(&"TOOL_COMPLETED".to_string()),
            "sink로 나간 이벤트: {emitted:?}"
        );

        // DB와 sink가 같은 이벤트를 봐야 한다 — 한쪽에만 있으면 감사 추적이 갈라진다.
        let stored = host.with_store(|s| s.event_types("task-1")).unwrap();
        for event_type in ["FILE_MUTATED", "TOOL_COMPLETED", "POLICY_DECIDED"] {
            assert!(stored.contains(&event_type.to_string()), "DB에 {event_type}이 없습니다");
            assert!(
                emitted.contains(&event_type.to_string()),
                "sink에 {event_type}이 없습니다"
            );
        }
    }

    fn req(tool: ToolName, args: Value) -> ToolRequest {
        ToolRequest {
            request_id: format!("req-{}", uuid::Uuid::new_v4()),
            task_id: "task-1".to_string(),
            tool,
            args,
            risk_tier: None,
            requested_by: json!({ "role": "orchestrator" }),
            created_at: Some(now_iso()),
        }
    }

    #[test]
    fn approval_flow_logs_request_and_grant() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
        ))
        .unwrap();

        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        // 순서가 불변식이다: 요청 → 정책 판단 → 승인 요청 → 승인 → 실행 결과
        let approval_requested = types.iter().position(|t| t == "APPROVAL_REQUESTED").unwrap();
        let approval_granted = types.iter().position(|t| t == "APPROVAL_GRANTED").unwrap();
        let tool_completed = types.iter().position(|t| t == "TOOL_COMPLETED").unwrap();
        let policy_decided = types.iter().position(|t| t == "POLICY_DECIDED").unwrap();
        assert!(policy_decided < approval_requested);
        assert!(approval_requested < approval_granted);
        assert!(approval_granted < tool_completed);
    }

    // ---- 정책의 수명 (ui-wireframes 3.16.2절) ----

    /// **정책은 태스크 수명 동안 불변이다.** 두 번째 등록은 오류다 — 갈아끼울 수 있게 두면
    /// 진행 중인 태스크의 게이트가 도중에 바뀌고, 승인 화면이 보여준 근거와 실행 시점의
    /// 근거가 달라진다.
    #[test]
    fn a_tasks_policy_cannot_be_changed_once_it_started() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AlwaysDeny));
        host.begin_task("task-1", TaskPolicy::default()).unwrap();
        let err = host.begin_task("task-1", TaskPolicy::default()).unwrap_err();
        assert!(err.contains("이미 정해졌습니다"), "{err}");
    }

    /// 태스크마다 다른 정책이 **실제로 다르게 판정된다.** 이게 안 되면 3.16.2절이 막혔던
    /// 이유가 그대로 남는다.
    #[test]
    fn two_tasks_in_one_host_can_have_different_policies() {
        let (ws, _a, host) = host(TaskPolicy::default(), Arc::new(AlwaysDeny));
        // task-1은 스킬이 도구를 좁혔고, task-2는 좁히지 않았다.
        host.begin_task(
            "task-1",
            TaskPolicy {
                allowed_tools: Some(vec![ToolName::ReadFile, ToolName::RunTests]),
                ..TaskPolicy::default()
            },
        )
        .unwrap();
        host.begin_task("task-2", TaskPolicy::default()).unwrap();

        let narrowed = host.profile("task-1");
        let open = host.profile("task-2");
        let request = |task: &str| ToolRequest {
            request_id: "req-1".to_string(),
            task_id: task.to_string(),
            tool: ToolName::CreateFile,
            args: json!({ "path": "new.ts", "content": "x" }),
            risk_tier: None,
            requested_by: json!({ "role": "executor" }),
            created_at: None,
        };
        let d1 = narrowed
            .gate
            .evaluate(&request("task-1"), host.root(), &narrowed.policy);
        let d2 = open.gate.evaluate(&request("task-2"), host.root(), &open.policy);
        assert_eq!(d1.matched_rule, "tool_not_in_skill_allowlist", "{}", d1.reason);
        assert_ne!(d2.matched_rule, "tool_not_in_skill_allowlist", "{}", d2.reason);
        drop(ws);
    }

    /// **등록되지 않은 태스크는 워크스페이스 기본값으로 판정된다.** 오류로 만들면 되돌리기·PR
    /// 처럼 태스크가 끝난 뒤에 도는 경로가 전부 막힌다.
    #[test]
    fn an_unregistered_task_falls_back_to_the_workspace_policy() {
        let (_ws, _a, host) = host(
            TaskPolicy {
                allow_git_commit: true,
                ..TaskPolicy::default()
            },
            Arc::new(AlwaysDeny),
        );
        let profile = host.profile("never-registered");
        assert!(profile.policy.allow_git_commit, "기본 프로필이 아닙니다");
    }

    /// **검증 명령 고정이 태스크 시작 시점으로 옮겨졌다.** 종전에는 호스트를 만들 때였고,
    /// 워크스페이스 수명을 갖는 UI 경로에서는 그게 **워크스페이스를 열 때**였다 —
    /// 24.5절이 적어 둔 것과 코드가 갈라져 있었다.
    #[test]
    fn the_verification_pin_is_taken_when_the_task_starts_not_when_the_host_is_made() {
        let (ws, _a, host) = host_with_manifest(TaskPolicy::default(), Arc::new(AlwaysDeny), None);
        // 호스트를 만들 때는 매니페스트가 없었다.
        assert!(host.default_profile.verification_pin.is_empty());

        fs::write(ws.path().join("package.json"), r#"{"scripts":{"test":"node -e 0"}}"#).unwrap();
        host.begin_task("task-1", TaskPolicy::default()).unwrap();

        let profile = host.profile("task-1");
        assert!(
            profile
                .verification_pin
                .iter()
                .any(|(p, a)| p == "npm" && a == &vec!["test".to_string()]),
            "{:?}",
            profile.verification_pin
        );
    }

    /// **argv를 고정해도 본문은 고정되지 않는다** (29.3절).
    ///
    /// 24.5절의 고정은 명령의 *이름*을 지킨다. 그런데 `npm test`의 argv를 그대로 두고
    /// `scripts.test`의 **본문**을 바꾸면, 고정된 argv가 다른 프로그램을 돌린다. 훅도 같다.
    /// 그 구멍은 이 저장소가 이미 스킬·검증에서 세운 규칙("모델은 매니페스트를 고칠 수 있다")의
    /// 두 번째 얼굴이었고, 등록 화면을 만들면서 드러났다.
    #[test]
    fn a_changed_manifest_withdraws_the_pre_approval() {
        let (ws, _a, host) = host_with_manifest(
            TaskPolicy {
                auto_approve_verification: true,
                ..TaskPolicy::default()
            },
            Arc::new(AlwaysDeny),
            Some(r#"{"scripts":{"test":"node -e 0"}}"#),
        );
        host.begin_task(
            "task-1",
            TaskPolicy {
                auto_approve_verification: true,
                ..TaskPolicy::default()
            },
        )
        .unwrap();
        let profile = host.profile("task-1");
        let request = req(
            ToolName::RunTests,
            json!({ "program": "npm", "args": ["test"], "cwd": "." }),
        );

        // 바뀌기 전에는 사전 승인이 성립한다 — 아래 단언이 공허하지 않다는 증거다.
        assert!(host.pre_approval(&request, &profile).is_some());

        // **argv는 그대로이고 본문만 바뀐다.**
        fs::write(
            ws.path().join("package.json"),
            r#"{"scripts":{"test":"node evil.js"}}"#,
        )
        .unwrap();

        assert!(
            host.pre_approval(&request, &profile).is_none(),
            "본문이 바뀌었는데 사전 승인이 그대로입니다"
        );
        // 막는 것이 아니라 사람에게 되돌린다 — 그 사실이 기록에 남는다.
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"PRE_APPROVAL_WITHDRAWN".to_string()), "{types:?}");
    }

    /// 등록된 훅도 같은 규칙을 받는다 — `npm run fmt`의 본문이 바뀌면 등록이 승인한 것과
    /// 실제로 도는 것이 다르다.
    #[test]
    fn a_changed_manifest_also_withdraws_a_registered_hooks_pre_approval() {
        let (ws, _a, host) = host_with_manifest(
            TaskPolicy::default(),
            Arc::new(AlwaysDeny),
            Some(r#"{"scripts":{"fmt":"node -e 0"}}"#),
        );
        let host = host.with_hooks(crate::hooks::HookRegistry::new(vec![crate::hooks::HookConfig {
            phase: "COMPLETED".to_string(),
            program: "npm".to_string(),
            args: vec!["run".to_string(), "fmt".to_string()],
        }]));
        host.begin_task("task-1", TaskPolicy::default()).unwrap();
        let profile = host.profile("task-1");
        let request = req(
            ToolName::RunCommand,
            json!({ "program": "npm", "args": ["run", "fmt"], "cwd": "." }),
        );
        assert!(host.pre_approval(&request, &profile).is_some());

        fs::write(ws.path().join("package.json"), r#"{"scripts":{"fmt":"node evil.js"}}"#).unwrap();
        assert!(host.pre_approval(&request, &profile).is_none());
    }

    /// 지문이 **읽는 파일 목록**은 손으로 적혀 있다. `detect_commands`가 새 매니페스트를
    /// 지원하면 여기도 함께 늘어야 하고, 늘지 않으면 그 매니페스트의 본문 변경이 보이지 않는다.
    #[test]
    fn manifest_fingerprint_covers_what_detect_reads() {
        let dir = tempfile::tempdir().unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        let empty = manifest_fingerprint(&root);

        // `detect_commands`가 읽는 매니페스트마다 지문이 달라져야 한다.
        for name in ["package.json", "Cargo.toml"] {
            fs::write(dir.path().join(name), "x").unwrap();
            assert_ne!(manifest_fingerprint(&root), empty, "{name}의 변화가 지문에 없습니다");
            fs::remove_file(dir.path().join(name)).unwrap();
        }
        // 지웠으면 원래대로 — 존재 여부도 지문에 들어간다.
        assert_eq!(manifest_fingerprint(&root), empty);
    }

    /// 고정 집합은 매니페스트가 **선언한 것만** 담는다. 없는 스크립트를 담으면 자동 승인이
    /// 프로젝트가 정하지 않은 명령까지 덮는다.
    #[test]
    fn the_verification_pin_holds_only_what_the_manifest_declared() {
        let (_ws, _a, host) = host_with_manifest(
            TaskPolicy::default(),
            Arc::new(AlwaysDeny),
            Some(r#"{"scripts":{"test":"node -e 0","build":"node -e 0"}}"#),
        );
        let pinned: Vec<String> = host
            .default_profile
            .verification_pin
            .iter()
            .map(|(p, a)| format!("{p} {}", a.join(" ")))
            .collect();
        assert!(pinned.iter().any(|c| c == "npm test"), "{pinned:?}");
        assert!(pinned.iter().any(|c| c == "npm run build"), "{pinned:?}");
        // lint는 선언되지 않았다 — 담기면 "매니페스트에서 유도한다"가 거짓이 된다.
        assert!(!pinned.iter().any(|c| c.contains("lint")), "{pinned:?}");
    }

    /// **이 테스트가 24.5절이 막으려는 경로 그 자체다.** 모델은 검증 명령을 지어낼 수는
    /// 없지만 매니페스트는 고칠 수 있다. 실행 중에 추가된 스크립트가 자동 승인을 받으면,
    /// 자동 승인의 근거였던 "프로젝트가 미리 선언했다"가 사라진다.
    #[test]
    fn a_manifest_edited_mid_task_does_not_widen_the_pin() {
        let (ws, _a, host) = host_with_manifest(
            TaskPolicy {
                auto_approve_verification: true,
                ..TaskPolicy::default()
            },
            Arc::new(AlwaysDeny),
            Some(r#"{"scripts":{"test":"node -e 0"}}"#),
        );
        // 시작 시점에 선언돼 있던 명령은 매치된다 — 아래 부정 단언이 공허하지 않다는 증거다.
        let profile = host.default_profile.clone();
        assert!(host.is_pinned_verification(
            &req(ToolName::RunTests, json!({ "program": "npm", "args": ["test"], "cwd": "." })),
            &profile
        ));

        fs::write(
            ws.path().join("package.json"),
            r#"{"scripts":{"test":"node -e 0","lint":"node -e 0"}}"#,
        )
        .unwrap();

        assert!(
            !host.is_pinned_verification(
                &req(ToolName::RunTests, json!({ "program": "npm", "args": ["run", "lint"], "cwd": "." })),
                &profile
            ),
            "실행 중에 추가된 스크립트가 자동 승인 집합에 들어왔습니다"
        );
    }

    /// 매치는 세 축 전부를 본다. 하나라도 느슨하면 레버가 검증 밖으로 샌다.
    #[test]
    fn the_pin_does_not_match_a_variant_a_subdirectory_or_another_tool() {
        let (_ws, _a, host) = host_with_manifest(
            TaskPolicy::default(),
            Arc::new(AlwaysDeny),
            Some(r#"{"scripts":{"test":"node -e 0"}}"#),
        );
        let cases = [
            // 같은 argv라도 `run_command`로 오면 검증 러너가 부른 것이 아니다.
            (ToolName::RunCommand, json!({ "program": "npm", "args": ["test"], "cwd": "." })),
            // 인자가 붙은 변형은 다른 명령이다 (prefix 비교였다면 통과했을 것).
            (
                ToolName::RunTests,
                json!({ "program": "npm", "args": ["test", "--ignore-scripts"], "cwd": "." }),
            ),
            // 하위 디렉터리에서 도는 같은 이름의 스크립트도 다른 명령이다.
            (
                ToolName::RunTests,
                json!({ "program": "npm", "args": ["test"], "cwd": "src" }),
            ),
        ];
        for (tool, args) in cases {
            assert!(
                !host.is_pinned_verification(&req(tool, args.clone()), &host.default_profile),
                "고정 집합이 {args}를 검증 명령으로 인정했습니다"
            );
        }
    }

    #[test]
    fn denied_approval_does_not_mutate_and_is_logged() {
        let (ws, _a, host) = host(TaskPolicy::default(), Arc::new(AlwaysDeny));
        let before = fs::read_to_string(ws.path().join("src/app.ts")).unwrap();

        let out = host
            .execute_tool(&req(
                ToolName::ApplyPatch,
                json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
            ))
            .unwrap();

        assert_eq!(out["result"]["status"].as_str().unwrap(), "denied");
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), before);
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"APPROVAL_DENIED".to_string()));
        assert!(!types.contains(&"FILE_MUTATED".to_string()));
    }

    #[test]
    fn cancelled_task_refuses_tool_execution() {
        let (ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.cancel_task("task-1").unwrap();
        let out = host
            .execute_tool(&req(ToolName::CreateFile, json!({ "path": "new.ts", "content": "x" })))
            .unwrap();
        // "denied"(정책이 막음)가 아니라 "cancelled"(사용자가 멈춤)여야 한다 —
        // 오케스트레이터의 재시도/실패 분류가 이 구분에 의존한다.
        assert_eq!(out["result"]["status"].as_str().unwrap(), "cancelled");
        assert!(!ws.path().join("new.ts").exists());
        // 취소 이후 실행 시도도 감사 로그에 남는다.
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"TOOL_SKIPPED_CANCELLED".to_string()));
        assert!(!types.contains(&"FILE_MUTATED".to_string()));
    }

    #[test]
    fn cancel_is_idempotent_and_records_one_event() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let first = host.cancel_task("task-1").unwrap();
        let second = host.cancel_task("task-1").unwrap();
        assert_eq!(first["outcome"].as_str().unwrap(), "requested");
        assert_eq!(second["outcome"].as_str().unwrap(), "already_requested");
        assert!(first["accepted"].as_bool().unwrap() && second["accepted"].as_bool().unwrap());

        let requests = host
            .with_store(|s| s.event_types("task-1"))
            .unwrap()
            .into_iter()
            .filter(|t| t == "CANCELLATION_REQUESTED")
            .count();
        assert_eq!(requests, 1, "연타해도 이벤트는 한 번만 남아야 합니다");
    }

    #[test]
    fn cancelling_a_completed_task_does_not_change_state() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.finish_task(
            "task-1",
            "COMPLETED",
            "TASK_COMPLETED",
            None,
            json!({ "summary": "done" }),
        )
        .unwrap();

        let outcome = host.cancel_task("task-1").unwrap();
        assert_eq!(outcome["outcome"].as_str().unwrap(), "already_terminal");
        assert_eq!(outcome["status"].as_str().unwrap(), "COMPLETED");

        let task = host.with_store(|s| s.get_task("task-1")).unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("COMPLETED"));
        assert!(
            task.cancellation_requested_at.is_none(),
            "터미널 태스크에 취소 시각이 기록되면 안 됩니다"
        );
        // 취소 플래그도 켜지지 않아야 한다 — 켜지면 이후 롤백이 막힌다.
        assert!(!host.is_cancelled("task-1"));
    }

    #[test]
    fn rollback_works_after_cancellation() {
        // 취소된 태스크야말로 되돌리기가 가장 필요한 순간이다.
        let (ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        let original = fs::read_to_string(ws.path().join("src/app.ts")).unwrap();
        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+CHANGED\n" }),
        ))
        .unwrap();
        host.cancel_task("task-1").unwrap();

        let result = host.rollback("task-1").unwrap();
        assert_eq!(result["failed"].as_array().unwrap().len(), 0, "{result}");
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), original);
    }

    #[test]
    fn verification_does_not_start_after_cancellation() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.cancel_task("task-1").unwrap();
        let err = host.run_verification("task-1", VerificationPhase::Post, 0).unwrap_err();
        assert!(err.contains("취소"), "{err}");
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"VERIFICATION_SKIPPED_CANCELLED".to_string()));
        assert_eq!(host.with_store(|s| s.verification_report_count("task-1")).unwrap(), 0);
    }

    #[test]
    fn competing_terminal_states_keep_the_first_one() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let first = host
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();
        assert!(matches!(first, TerminalOutcome::Recorded { .. }));

        let second = host
            .finish_task("task-1", "CANCELLED", "TASK_CANCELLED", None, json!({}))
            .unwrap();
        assert_eq!(
            second,
            TerminalOutcome::AlreadyTerminal {
                status: "COMPLETED".to_string()
            }
        );

        // terminal 이벤트는 정확히 하나만 남아야 한다.
        let terminal_events = host
            .with_store(|s| s.event_types("task-1"))
            .unwrap()
            .into_iter()
            .filter(|t| t.starts_with("TASK_") && t != "TASK_CREATED")
            .collect::<Vec<_>>();
        assert_eq!(terminal_events, vec!["TASK_COMPLETED"]);
    }

    fn fingerprint_of(host: &TaskHost) -> Value {
        host.record_workspace_fingerprint("task-1").unwrap()
    }

    /// **같은 HEAD라도 워킹 트리가 다르면 다른 실행이다.** `git_head`만 남기는 지문이
    /// 놓치는 것이 이것이고, 6절이 "uncommitted 상태 미반영"이라고 적은 자리다.
    #[test]
    fn the_fingerprint_changes_when_a_tracked_file_changes_without_a_commit() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        let before = fingerprint_of(&host);
        assert_eq!(before.get("available").and_then(Value::as_bool), Some(true), "{before}");
        assert_eq!(before.get("dirty").and_then(Value::as_bool), Some(false));

        fs::write(ws.path().join("src/app.ts"), "a\nCHANGED\nc\n").unwrap();
        let after = fingerprint_of(&host);

        assert_eq!(
            before.get("gitHead"),
            after.get("gitHead"),
            "커밋하지 않았으므로 HEAD는 같아야 한다 — 그래서 HEAD만으로는 부족하다"
        );
        assert_ne!(
            before.get("fingerprint"),
            after.get("fingerprint"),
            "커밋되지 않은 변경이 지문에 반영되지 않았습니다"
        );
        assert_eq!(after.get("dirty").and_then(Value::as_bool), Some(true));
    }

    /// 같은 상태에서 두 번 재면 같은 지문이 나와야 한다 — 재현 확인에 쓸 수 없으면
    /// 지문이 아니다.
    #[test]
    fn the_fingerprint_is_stable_for_an_unchanged_workspace() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());
        assert_eq!(
            fingerprint_of(&host).get("fingerprint"),
            fingerprint_of(&host).get("fingerprint")
        );
    }

    /// **추적되지 않는 파일은 경로가 지문에 들어간다.** 내용은 들어가지 않지만(git diff HEAD가
    /// 추적되는 파일만 보므로), 파일이 생겼다 없어졌다는 사실 자체는 잡힌다.
    /// 그리고 그 한계가 이번 실행에 적용되는지를 `untrackedFiles`가 말한다.
    #[test]
    fn an_untracked_file_enters_the_fingerprint_by_path_and_is_counted() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        let clean = fingerprint_of(&host);
        assert_eq!(clean.get("untrackedFiles").and_then(Value::as_u64), Some(0));

        fs::write(ws.path().join("scratch.txt"), "temp").unwrap();
        let dirty = fingerprint_of(&host);
        assert_ne!(
            clean.get("fingerprint"),
            dirty.get("fingerprint"),
            "새 파일이 지문에 없습니다"
        );
        assert_eq!(
            dirty.get("untrackedFiles").and_then(Value::as_u64),
            Some(1),
            "한계가 적용되는지를 화면이 알 수 없습니다"
        );
    }

    /// git 저장소가 아니면 **지문을 만들어 내지 않는다.** 빈 해시를 내면 "상태가 비어 있었다"로
    /// 읽히는데 실제로는 "잴 수 없었다"이다.
    #[test]
    fn a_non_git_workspace_reports_unavailable_not_an_empty_hash() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        let out = fingerprint_of(&host);
        assert_eq!(out.get("available").and_then(Value::as_bool), Some(false), "{out}");
        assert!(
            out.get("fingerprint").is_none(),
            "잴 수 없었는데 지문이 있습니다: {out}"
        );
    }

    /// 지문은 **Rust가 기록한다.** Node는 "지금 찍어라"만 말할 수 있고 값에는 손대지 못한다.
    #[test]
    fn the_fingerprint_is_written_to_the_event_log_by_rust() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());
        let out = fingerprint_of(&host);

        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let recorded = events
            .iter()
            .find(|e| e.event_type == "WORKSPACE_FINGERPRINT")
            .expect("지문 이벤트가 없습니다");
        assert_eq!(recorded.payload.get("fingerprint"), out.get("fingerprint"));
    }

    /// 19절: 커밋 sha를 모르면 **아무것도 하지 않는다.** 추측으로 이력을 건드리지 않는다.
    #[test]
    fn revert_does_nothing_when_the_commit_cannot_be_identified() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false));
        assert!(
            result
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("특정할 수 없습니다"),
            "{result}"
        );
    }

    /// revert가 **시작조차 못 한** 경우는 충돌이 아니다.
    ///
    /// 존재하지 않는 sha는 git이 아무것도 만들기 전에 거절한다. 치울 것이 없으므로
    /// `--abort`를 부르면 안 된다 — 그때 `REVERT_HEAD`가 있다면 그건 **남의 것**이다.
    #[test]
    fn revert_that_never_started_is_not_reported_as_a_conflict() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        host.append_event(
            "task-1",
            "GIT_COMMIT_CREATED",
            json!({ "sha": "0000000000000000000000000000000000000000", "paths": ["src/app.ts"], "branch": "main" }),
        )
        .unwrap();

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false));
        assert_eq!(result.get("conflicted").and_then(Value::as_bool), Some(false));
        assert_eq!(result.get("cleanedUp").and_then(Value::as_bool), Some(true));
        assert!(
            !ws.path().join(".git/REVERT_HEAD").exists(),
            "revert가 진행 중 상태로 남았습니다"
        );
    }

    /// **충돌하는 revert를 시도하고, 실패하면 우리가 되돌려 놓는다.**
    ///
    /// 예전에는 이 상황(커밋 위에 다른 커밋이 쌓임)에서 아무것도 하지 않고 거절했다. 지금은
    /// 시도한다 — 실패해도 저장소가 시작 전과 같아야 한다는 것이 이 테스트의 계약이다.
    ///
    /// 이 테스트가 없으면 조용히 깨지는 것: `run_command`는 0이 아닌 종료 코드를 `ToolStatus::Ok`로
    /// 보고하므로(tools/mod.rs), `status`만 보는 코드는 **충돌한 revert를 성공으로 읽는다.**
    #[test]
    fn revert_cleans_up_after_a_conflicting_revert() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        // 이 태스크의 커밋: 가운데 줄을 바꾼다.
        commit_as_task(&host, ws.path(), "task-1", "a\nB2\nc\n");
        // 그 위에 **같은 줄을** 바꾼 커밋이 쌓인다 → revert는 반드시 충돌한다.
        fs::write(ws.path().join("src/app.ts"), "a\nB3\nc\n").unwrap();
        git_at(ws.path(), &["add", "-A"]);
        git_at(ws.path(), &["commit", "-m", "someone else"]);

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false), "{result}");
        assert_eq!(
            result.get("conflicted").and_then(Value::as_bool),
            Some(true),
            "{result}"
        );
        assert_eq!(result.get("cleanedUp").and_then(Value::as_bool), Some(true), "{result}");

        // 충돌한 파일 목록은 `--abort` **전에** 읽어야만 남는다.
        let conflicts = result
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(
            conflicts.iter().any(|c| c.as_str() == Some("src/app.ts")),
            "충돌 파일 목록이 비었습니다: {result}"
        );

        // 저장소가 시작 전과 같다는 것은 **아무 일도 없었다는 뜻이 아니다** — 사용자가
        // 되돌리기를 눌렀고 우리가 하지 못했다는 사실이 이벤트로 남는다.
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"ROLLBACK_FAILED".to_string()), "{types:?}");
        assert!(!types.contains(&"ROLLBACK_COMPLETED".to_string()), "{types:?}");

        // 저장소는 시작 전과 같다: 진행 중인 revert도, 충돌 마커도, 미커밋 변경도 없다.
        assert!(
            !ws.path().join(".git/REVERT_HEAD").exists(),
            "revert가 진행 중 상태로 남았습니다"
        );
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), "a\nB3\nc\n");
        assert_eq!(git_at(ws.path(), &["status", "--porcelain"]).trim(), "");
    }

    /// **남이 시작한 revert 위에서는 시작하지 않는다.**
    ///
    /// 우리가 실패했을 때 부르는 `git revert --abort`는 진행 중인 revert를 구별하지 않는다.
    /// 사용자가 손으로 충돌을 절반쯤 풀어 놓은 상태에서 우리가 그걸 부르면 그 작업이 사라진다.
    /// 그래서 시작 전 `REVERT_HEAD` 검사는 **워킹 트리 검사보다 먼저**다.
    #[test]
    fn revert_refuses_while_another_revert_is_in_progress() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        let sha = commit_as_task(&host, ws.path(), "task-1", "a\nB2\nc\n");
        fs::write(ws.path().join("src/app.ts"), "a\nB3\nc\n").unwrap();
        git_at(ws.path(), &["add", "-A"]);
        git_at(ws.path(), &["commit", "-m", "someone else"]);

        // 사용자가 직접 같은 revert를 시작해 충돌 상태에 있다.
        git_at(ws.path(), &["revert", "--no-edit", &sha]);
        assert!(
            ws.path().join(".git/REVERT_HEAD").exists(),
            "테스트 전제가 성립하지 않았습니다"
        );

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false), "{result}");
        let reason = result.get("reason").and_then(Value::as_str).unwrap_or("");
        assert!(reason.contains("이미 진행 중인 revert"), "{reason}");
        // 사용자의 진행 중 상태를 건드리지 않았다.
        assert!(
            ws.path().join(".git/REVERT_HEAD").exists(),
            "사용자가 진행 중이던 revert를 지웠습니다"
        );
    }

    #[test]
    fn rollback_restores_files_through_the_normal_tool_path() {
        let (ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        let original = fs::read_to_string(ws.path().join("src/app.ts")).unwrap();

        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+CHANGED\n" }),
        ))
        .unwrap();
        assert_ne!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), original);

        let result = host.rollback("task-1").unwrap();
        assert_eq!(result["failed"].as_array().unwrap().len(), 0);
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), original);

        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"ROLLBACK_STARTED".to_string()));
        assert!(types.contains(&"ROLLBACK_COMPLETED".to_string()));
    }

    #[test]
    fn unknown_method_is_rejected() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        assert!(host.handle_request("tool.executeUnchecked", &json!({})).is_err());
    }

    #[test]
    fn credential_get_is_not_exposed_over_ipc() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let err = host
            .handle_request("credential.get", &json!({ "providerId": "openai" }))
            .unwrap_err();
        assert!(err.contains("credential.get"));
    }

    #[test]
    fn tool_event_payload_does_not_inline_file_bodies() {
        let (_ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        let big = "x".repeat(50_000);
        host.execute_tool(&req(ToolName::CreateFile, json!({ "path": "big.txt", "content": big })))
            .unwrap();

        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let requested = events.iter().find(|e| e.event_type == "TOOL_REQUESTED").unwrap();
        // 본문 전체가 아니라 크기 + preview만 남아야 한다.
        assert!(requested.payload["args"]["content"]["bytes"].as_u64().unwrap() == 50_000);
        let preview = requested.payload["args"]["content"]["preview"].as_str().unwrap();
        assert!(preview.len() < 1024);
    }

    #[test]
    fn verification_report_is_persisted_by_rust_not_node() {
        let (ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        fs::write(
            ws.path().join("package.json"),
            r#"{ "scripts": { "test": "node -e \"process.exit(0)\"" } }"#,
        )
        .unwrap();

        let out = host.run_verification("task-1", VerificationPhase::Post, 0).unwrap();
        assert!(out["report"]["reportId"].as_str().is_some());
        assert_eq!(host.with_store(|s| s.verification_report_count("task-1")).unwrap(), 1);
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"VERIFICATION_COMPLETED".to_string()));
    }
    // ---- IPC 줄 크기 계측 (process-architecture.md 3.1절) ----

    /// **꺼내면 비워지는 계약을 그대로 흉내낸다.** 매번 같은 값을 주는 fake를 쓰면
    /// "두 번 불러도 중복되지 않는다"를 검증할 수 없다 — 진짜는 비우기 때문에 중복되지
    /// 않는데, 흉내가 그 성질을 빼면 테스트는 존재하지 않는 동작을 재는 것이 된다.
    struct FakeMeter {
        taken: std::sync::atomic::AtomicU64,
    }

    impl crate::sidecar::IpcLineMeter for FakeMeter {
        fn take_line_sizes(&self) -> crate::sidecar::IpcLineSizes {
            let first = self.taken.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            crate::sidecar::IpcLineSizes {
                lines: if first { 2 } else { 0 },
                max_bytes: if first { 4096 } else { 0 },
                buckets: vec![crate::sidecar::IpcLineBucket {
                    up_to_bytes: 65536,
                    lines: if first { 2 } else { 0 },
                }],
            }
        }
    }

    #[test]
    fn a_terminal_task_records_the_lines_it_exchanged() {
        let (_ws, _art, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let meter = Arc::new(FakeMeter {
            taken: std::sync::atomic::AtomicU64::new(0),
        });
        host.attach_ipc_meter(Arc::downgrade(&meter) as std::sync::Weak<dyn crate::sidecar::IpcLineMeter>);

        host.finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();

        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let recorded = events
            .iter()
            .find(|e| e.event_type == "IPC_LINE_SIZES")
            .expect("IPC_LINE_SIZES가 없습니다");
        assert_eq!(recorded.payload["lines"], json!(2));
        assert_eq!(recorded.payload["maxBytes"], json!(4096));
    }

    /// **계측기를 강하게 잡으면 순환 참조가 된다.** 클라이언트가 handler를 `Arc`로 들고 있고
    /// handler가 클라이언트를 되잡으면 둘 다 영원히 해제되지 않는다 — 워크스페이스를 전환할
    /// 때마다 sidecar 클라이언트가 하나씩 쌓인다. 이 테스트는 그 되잡기가 약한지를 본다.
    #[test]
    fn attaching_the_meter_does_not_keep_it_alive() {
        let (_ws, _art, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let meter = Arc::new(FakeMeter {
            taken: std::sync::atomic::AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&meter);
        host.attach_ipc_meter(weak.clone() as std::sync::Weak<dyn crate::sidecar::IpcLineMeter>);

        drop(meter);
        assert!(weak.upgrade().is_none(), "호스트가 계측기를 붙잡고 있습니다");

        // 계측기가 사라져도 터미널 확정은 그대로 된다 — 계측은 태스크의 결과가 아니다.
        host.finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();
        let events = host.with_store(|s| s.events("task-1")).unwrap();
        assert!(events.iter().any(|e| e.event_type == "TASK_COMPLETED"));
        assert!(!events.iter().any(|e| e.event_type == "IPC_LINE_SIZES"));
    }
    /// **정상 경로가 `AlreadyTerminal`이다.** Node가 보낸 터미널 `PHASE_CHANGED`가 먼저
    /// 자리를 잡으므로, `Recorded`에서만 계측하면 정상 실행에서만 기록이 사라진다.
    #[test]
    fn the_lines_are_recorded_even_when_the_terminal_was_already_claimed() {
        let (_ws, _art, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let meter = Arc::new(FakeMeter {
            taken: std::sync::atomic::AtomicU64::new(0),
        });
        host.attach_ipc_meter(Arc::downgrade(&meter) as std::sync::Weak<dyn crate::sidecar::IpcLineMeter>);

        // Node가 터미널을 먼저 잡는다.
        host.append_event(
            "task-1",
            "PHASE_CHANGED",
            json!({ "from": "EXECUTING", "to": "COMPLETED" }),
        )
        .unwrap();
        let outcome = host
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();
        assert!(
            matches!(outcome, TerminalOutcome::AlreadyTerminal { .. }),
            "{outcome:?}"
        );

        let events = host.with_store(|s| s.events("task-1")).unwrap();
        assert!(
            events.iter().any(|e| e.event_type == "IPC_LINE_SIZES"),
            "정상 경로에서 계측이 빠졌습니다"
        );
    }

    /// 두 번 불려도 이벤트가 둘이 되지 않는다 — 꺼내면 비워지므로 두 번째는 남길 것이 없다.
    #[test]
    fn recording_twice_does_not_duplicate_the_event() {
        let (_ws, _art, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let meter = Arc::new(FakeMeter {
            taken: std::sync::atomic::AtomicU64::new(0),
        });
        host.attach_ipc_meter(Arc::downgrade(&meter) as std::sync::Weak<dyn crate::sidecar::IpcLineMeter>);

        host.finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();
        host.finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();

        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let recorded = events.iter().filter(|e| e.event_type == "IPC_LINE_SIZES").count();
        assert_eq!(recorded, 1);
    }
}
