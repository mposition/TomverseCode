//! Rust 쪽 프로토콜 타입.
//!
//! docs/design/state-machine-and-protocol.md 1절: Rust 코어는 **정책 판단에 필요한 타입만
//! 강하게 타이핑**하고 나머지(DraftProposal, ReviewDecision 등 UI 렌더링용 콘텐츠)는
//! `serde_json::Value`로 통과시킨다. 그래서 여기에는 ToolRequest/ToolResult/PolicyDecision과
//! 검증 리포트만 있고 모델 산출물 타입은 없다.
//!
//! TypeScript(`packages/protocol`)가 단일 소스이고 이 파일은 그 부분 미러다. 필드를 추가할 때는
//! 반드시 TS 쪽을 먼저 바꾼다.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    ListFiles,
    SearchText,
    ReadFile,
    ApplyPatch,
    CreateFile,
    DeleteFile,
    RunCommand,
    GitStatus,
    GitDiff,
    RunTests,
    /// MCP 서버의 도구 하나를 부른다 (product-strategy 8.2절, mcp.rs).
    ///
    /// **닫힌 집합에 한 칸만 낸다.** MCP 도구는 서버마다 동적으로 달라지지만, 그것을
    /// `ToolName`으로 열면 Policy Gate의 exhaustive match가 무너지고 "분류되지 않은 도구"가
    /// 생긴다. 대신 문 하나를 두고 그 문의 위험도를 우리가 안다: **모른다, 그러므로 승인이다.**
    McpCall,
    /// 브랜치를 remote로 올린다 (pr.rs, state-machine 28절).
    ///
    /// **`run_command`의 `git push`는 여전히 거부다.** 이 칸을 따로 낸 이유가 그것이다:
    /// 임의 argv의 push는 우리가 모양을 모르고(`--force`, refspec), 아는 모양만 여기로 낸다.
    /// 같은 동작에 대한 두 규칙이 아니라 **다른 능력**이다 — 이쪽이 좁다.
    GitPush,
}

impl ToolName {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolName::ListFiles => "list_files",
            ToolName::SearchText => "search_text",
            ToolName::ReadFile => "read_file",
            ToolName::ApplyPatch => "apply_patch",
            ToolName::CreateFile => "create_file",
            ToolName::DeleteFile => "delete_file",
            ToolName::RunCommand => "run_command",
            ToolName::GitStatus => "git_status",
            ToolName::GitDiff => "git_diff",
            ToolName::RunTests => "run_tests",
            ToolName::McpCall => "mcp_call",
            ToolName::GitPush => "git_push",
        }
    }

    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            ToolName::ListFiles | ToolName::SearchText | ToolName::ReadFile | ToolName::GitStatus | ToolName::GitDiff
        )
    }

    pub fn mutates_files(&self) -> bool {
        matches!(self, ToolName::ApplyPatch | ToolName::CreateFile | ToolName::DeleteFile)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskTier {
    Auto,
    Conditional,
    UserApproval,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub tool: ToolName,
    #[serde(default)]
    pub args: serde_json::Value,
    /// Node가 계산한 1차 분류. Rust는 이 값을 판단 근거로 쓰지 않고 기록만 한다.
    #[serde(rename = "riskTier", default)]
    pub risk_tier: Option<RiskTier>,
    /// `{ role, modelId }` 또는 `{ role: "orchestrator" }` — opaque하게 통과시킨다.
    #[serde(rename = "requestedBy", default)]
    pub requested_by: serde_json::Value,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<String>,
    /// 이 명령에 **추가로 넣을 환경변수** (state-machine 33절).
    ///
    /// # `skip_deserializing`이 이 필드의 보안 모델 전부다
    ///
    /// Node가 보내는 JSON에서 **읽지 않는다.** 읽으면 장악당한 sidecar가 임의 명령에 임의
    /// 환경변수를 넣을 수 있고, 그건 argv를 고정해 얻은 보장(원칙 6)을 옆문으로 무효화한다 —
    /// 승인 화면은 argv만 보여주는데 동작은 환경이 바꾼다.
    ///
    /// 그래서 이 값은 **Rust 코드가 구조체를 직접 만들 때만** 채워진다. 지금 채우는 곳은
    /// phase 훅 하나뿐이다(`host.rs`의 `run_phase_hooks`).
    ///
    /// **직렬화는 한다.** 감사 기록이 "무엇이 넘어갔는가"에 답해야 하기 때문이다 —
    /// 넘긴 것을 기록하지 않으면 25.7절이 요구한 투명성이 성립하지 않는다.
    #[serde(rename = "injectedEnv", default, skip_deserializing)]
    pub injected_env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Ok,
    Error,
    Denied,
    Timeout,
    /// 사용자 취소로 중단됨. `Timeout`과 **구별해야 한다** — 타임아웃은 도구/프로젝트의 문제라
    /// 재시도 대상이지만, 취소는 사용자의 의사이므로 재시도하면 안 된다.
    Cancelled,
}

impl ToolStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolStatus::Ok => "ok",
            ToolStatus::Error => "error",
            ToolStatus::Denied => "denied",
            ToolStatus::Timeout => "timeout",
            ToolStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub status: ToolStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(rename = "completedAt")]
    pub completed_at: String,
    /// `status == Denied`일 때 **누가 막았는가**.
    ///
    /// 사유 문장만으로는 소비자가 구별할 수 없다 — 한국어 산문을 파싱하게 만들면 문구를
    /// 다듬는 순간 분기가 조용히 바뀐다(`CriterionCheckCode`를 따로 둔 것과 같은 이유).
    ///
    /// 특히 **"게이트가 거부"와 "물을 사람이 없음"은 다음에 할 일이 다르다**: 전자는 요청을
    /// 다시 생각해야 하고, 후자는 사람이 붙으면 그대로 진행된다.
    #[serde(rename = "denialKind", skip_serializing_if = "Option::is_none")]
    pub denial_kind: Option<DenialKind>,
}

/// `Denied`의 종류. 문자열이 아니라 값이라 소비자가 분기할 수 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DenialKind {
    /// Policy Gate가 거부했다 (workspace 경계 위반 등).
    Policy,
    /// 사용자가 승인 요청을 거부했다.
    User,
    /// 무인 실행(Autopilot)이라 물을 사람이 없었다 — product-strategy 8.2절.
    Unattended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    AutoApprove,
    RequireUserApproval,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    None,
    Low,
    Medium,
    High,
    Prohibited,
}

/// 승인을 요구한 결정을 **사용자가 미리 넓혀 통과시킬 수 있는 정책 레버**.
///
/// 무인 실행이 승인 지점에서 멈췄을 때(24.2절) 사용자가 다음에 물을 것은 하나다 —
/// "무엇을 바꾸면 이게 지나가는가". 그 답은 게이트가 결정을 내리는 **그 자리에 있고**,
/// 다른 곳에 표로 옮겨 적으면 규칙이 바뀔 때 조용히 어긋난다.
///
/// **`HumanOnly`가 있는 이유가 이 타입의 핵심이다.** 어떤 승인은 어떤 정책으로도 낮출 수
/// 없다(비밀값 파일, 삭제, MCP — 23.3절). 그런 자리에 "이 스위치를 켜세요"를 제안하면
/// 거짓말이 되고, 사용자는 켜 놓고 다시 돌렸다가 같은 자리에서 또 멈춘다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyLever {
    /// 승인을 요구하지 않은 결정 — 넓힐 것이 없다.
    NotApplicable,
    AutoApproveWorkspaceWrites,
    AllowGitCommit,
    AutoApproveVerification,
    /// **어떤 정책으로도 무인 통과시킬 수 없다.** 사람이 있어야 한다.
    HumanOnly,
}

impl PolicyLever {
    /// 이 레버를 켜는 CLI 플래그. 없으면 `None` — **없는 플래그를 지어내지 않는다.**
    pub fn rerun_flag(self) -> Option<&'static str> {
        match self {
            Self::AutoApproveWorkspaceWrites => Some("--auto-approve-writes"),
            Self::AllowGitCommit => Some("--allow-git-commit"),
            Self::AutoApproveVerification => Some("--auto-approve-verification"),
            Self::NotApplicable | Self::HumanOnly => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDecision {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub decision: Decision,
    #[serde(rename = "riskLevel")]
    pub risk_level: RiskLevel,
    #[serde(rename = "matchedRule")]
    pub matched_rule: String,
    pub reason: String,
    #[serde(rename = "requiresUserApproval")]
    pub requires_user_approval: bool,
    #[serde(rename = "normalizedTarget")]
    pub normalized_target: String,
    /// 승인이 필요하다면, 사용자가 **미리** 그것을 넓힐 수 있는 정책 레버.
    #[serde(rename = "unblockedBy")]
    pub unblocked_by: PolicyLever,
    /// 이 거부가 **요청의 모양** 때문인가 (state-machine 41.4절).
    ///
    /// "하면 안 된다"와 "그렇게 요청하면 안 된다"를 뭉개면 보고가 "정책이 거부했습니다"가
    /// 되고, 사용자는 정책 설정에서 고칠 곳을 찾다가 아무것도 찾지 못한다.
    #[serde(rename = "redraftable", default)]
    pub redraftable: bool,
    #[serde(rename = "decidedAt")]
    pub decided_at: String,
}

impl PolicyDecision {
    pub fn allowed(&self) -> bool {
        !matches!(self.decision, Decision::Deny)
    }
}

/// 정규화된 `run_command` 인자. 셸 문자열은 이 타입으로 표현할 수 없다 —
/// 그게 CLAUDE.md 원칙 6("승인 모달 표시 = 실제 실행")의 구조적 근거다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunCommandArgs {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

fn default_cwd() -> String {
    ".".to_string()
}

impl RunCommandArgs {
    /// 승인 모달과 감사 로그에 쓰이는 표시 형태. 실제 실행되는 argv를 그대로 반영한다.
    pub fn display(&self) -> String {
        let mut parts = vec![self.program.clone()];
        parts.extend(self.args.iter().cloned());
        format!("{} (cwd: {})", parts.join(" "), self.cwd)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRule {
    /// 설계 문서 5.1절의 `executable`. `program`/`executable` 두 이름 모두 받는다.
    #[serde(alias = "executable")]
    pub program: String,
    #[serde(rename = "argPattern", default)]
    pub arg_pattern: Option<Vec<String>>,
    #[serde(rename = "cwdMustBeWorkspaceRoot", default)]
    pub cwd_must_be_workspace_root: Option<bool>,
    #[serde(default = "default_effect")]
    pub effect: RuleEffect,
}

fn default_effect() -> RuleEffect {
    RuleEffect::Conditional
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleEffect {
    Auto,
    Conditional,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPolicy {
    #[serde(default)]
    pub deny: Vec<CommandRule>,
    #[serde(default)]
    pub allow: Vec<CommandRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLoopLimits {
    #[serde(rename = "clarificationRounds", default = "two")]
    pub clarification_rounds: u32,
    #[serde(rename = "reviseRounds", default = "two")]
    pub revise_rounds: u32,
    #[serde(rename = "fixLoopRounds", default = "three")]
    pub fix_loop_rounds: u32,
    #[serde(rename = "toolRetries", default = "two")]
    pub tool_retries: u32,
    #[serde(rename = "providerRetries", default = "three")]
    pub provider_retries: u32,
}

fn two() -> u32 {
    2
}
fn three() -> u32 {
    3
}

impl Default for TaskLoopLimits {
    fn default() -> Self {
        Self {
            clarification_rounds: 2,
            revise_rounds: 2,
            fix_loop_rounds: 3,
            tool_retries: 2,
            provider_retries: 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Fast,
    Verified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskPolicy {
    #[serde(default)]
    pub limits: TaskLoopLimits,
    #[serde(rename = "forceComplexityTier", default)]
    pub force_complexity_tier: Option<String>,
    #[serde(rename = "commandPolicy", default)]
    pub command_policy: Option<CommandPolicy>,
    #[serde(rename = "autoApproveWorkspaceWrites", default)]
    pub auto_approve_workspace_writes: bool,
    /// 무인 실행(Autopilot)인가 — product-strategy 8.2절. sidecar가 완료 판정에 쓴다.
    #[serde(default)]
    pub unattended: bool,
    /// 스킬이 **좁힌** 도구 집합 (skills.rs, state-machine 26절).
    ///
    /// `None`이면 좁히지 않는다. **넓히는 방향은 없다** — 여기 있는 도구도 게이트의 분류를
    /// 그대로 지나며, 이 목록은 그 앞에서 한 겹 더 막을 뿐이다.
    #[serde(rename = "allowedTools", default)]
    pub allowed_tools: Option<Vec<ToolName>>,
    /// 프로젝트가 **매니페스트에 선언해 둔** 검증 명령을 매번 묻지 않고 실행한다.
    ///
    /// 이 레버가 안전한 근거는 명령의 출처다 — `verify::detect_commands`가 `package.json`·
    /// `Cargo.toml`에서 유도하므로 모델이 명령을 지어낼 수 없고, 집합은 태스크 **시작
    /// 시점에 고정**되므로 모델이 매니페스트를 고쳐 넣을 수도 없다(state-machine 24.5절).
    #[serde(rename = "autoApproveVerification", default)]
    pub auto_approve_verification: bool,
    #[serde(rename = "allowGitCommit", default)]
    pub allow_git_commit: bool,
    #[serde(rename = "commandTimeoutMs", default = "default_timeout")]
    pub command_timeout_ms: u64,
    #[serde(rename = "executionMode", default = "default_mode")]
    pub execution_mode: ExecutionMode,
    /// 무인 실행의 **시한** (state-machine 39절). `None`이면 상한이 없다.
    ///
    /// # sidecar로 보내지 않는다
    ///
    /// Node가 알아야 할 이유가 없고, 알면 언젠가 Node가 집행자가 된다 — 그 순간 장악당한
    /// Node에서 상한이 사라진다. 시계도 판정도 Rust가 갖는다.
    ///
    /// # 기본값을 우리가 만들지 않는다
    ///
    /// 예산 상한과 같은 규칙이다: 코드가 만들어낸 승인은 승인이 아니다. 상한 없이 도는 것은
    /// 사용자가 고를 수 있는 선택이고, **그 사실을 화면이 말한다.**
    #[serde(rename = "deadlineMs", default)]
    pub deadline_ms: Option<u64>,
}

fn default_timeout() -> u64 {
    120_000
}
fn default_mode() -> ExecutionMode {
    ExecutionMode::Verified
}

impl Default for TaskPolicy {
    fn default() -> Self {
        Self {
            limits: TaskLoopLimits::default(),
            force_complexity_tier: None,
            command_policy: None,
            auto_approve_workspace_writes: false,
            unattended: false,
            allowed_tools: None,
            auto_approve_verification: false,
            allow_git_commit: false,
            command_timeout_ms: default_timeout(),
            execution_mode: ExecutionMode::Verified,
            // **기본 시한을 만들지 않는다.** 예산 상한과 같은 규칙이다 — 코드가 만들어낸
            // 승인은 승인이 아니다.
            deadline_ms: None,
        }
    }
}

// ---- 검증 ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationKind {
    Build,
    Test,
    Lint,
    Typecheck,
    #[serde(rename = "diff_review")]
    DiffReview,
}

impl VerificationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            VerificationKind::Build => "build",
            VerificationKind::Test => "test",
            VerificationKind::Lint => "lint",
            VerificationKind::Typecheck => "typecheck",
            VerificationKind::DiffReview => "diff_review",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerificationStatus {
    Passed,
    Failed,
    NotConfigured,
    SkippedWithReason,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationCheck {
    pub kind: VerificationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<RunCommandArgs>,
    pub status: VerificationStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(rename = "detailRef", skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<String>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationPhase {
    Baseline,
    Post,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Overall {
    Pass,
    Fail,
    /// 프로젝트에 돌릴 검증 명령이 아예 없었다.
    NotConfigured,
    /// **돌리려 했는데 돌지 못했다.** 사용자가 할 일이 `NotConfigured`와 다르다 —
    /// 여기서 "스크립트를 추가하세요"라고 말하면 없는 문제를 고치러 보내는 것이다.
    CouldNotRun,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationReport {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "reportId")]
    pub report_id: String,
    pub phase: VerificationPhase,
    #[serde(rename = "attemptNumber")]
    pub attempt_number: u32,
    pub checks: Vec<VerificationCheck>,
    #[serde(rename = "newlyFailing", skip_serializing_if = "Option::is_none")]
    pub newly_failing: Option<Vec<VerificationKind>>,
    #[serde(rename = "preexistingFailures", skip_serializing_if = "Option::is_none")]
    pub preexisting_failures: Option<Vec<VerificationKind>>,
    pub overall: Overall,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// ---- 파일 변경 기록 (롤백) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRef {
    pub existed: bool,
    #[serde(rename = "contentRef", skip_serializing_if = "Option::is_none")]
    pub content_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMutationRecord {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub path: String,
    #[serde(rename = "preImage")]
    pub pre_image: ImageRef,
    #[serde(rename = "postImage")]
    pub post_image: ImageRef,
}

// ---- 승인 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequestItem {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub tool: String,
    #[serde(rename = "riskLevel")]
    pub risk_level: RiskLevel,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<RunCommandArgs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    #[serde(rename = "approvalId")]
    pub approval_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    /// **어느 워크스페이스의 명령인가.**
    ///
    /// 원칙 6은 "승인 화면에 보인 argv가 실제 실행되는 것과 같다"를 약속하는데, **같은 argv라도
    /// 대상 저장소가 다르면 다른 동작**이다. 워크스페이스가 빠지면 그 약속이 절반만 성립한다 —
    /// 여러 워크스페이스를 오가는 순간 사용자는 자기가 어느 프로젝트에서 `git clean`을
    /// 승인하는지 알 수 없다.
    ///
    /// 그리고 이 값은 표시용만이 아니다. 응답이 **활성 워크스페이스의 것인지** 검사하는
    /// 기준이 여기다(`approvals.rs`).
    #[serde(rename = "workspaceRoot")]
    pub workspace_root: String,
    pub items: Vec<ApprovalRequestItem>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 태스크 진행 상태 캐시 (`tasks` 테이블). 진실의 원천은 `task_events`다.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskCounters {
    #[serde(rename = "clarificationRounds", default)]
    pub clarification_rounds: u32,
    #[serde(rename = "reviseRounds", default)]
    pub revise_rounds: u32,
    #[serde(rename = "fixLoopRounds", default)]
    pub fix_loop_rounds: u32,
    #[serde(rename = "toolRetries", default)]
    pub tool_retries: BTreeMap<String, u32>,
    #[serde(rename = "providerRetries", default)]
    pub provider_retries: BTreeMap<String, u32>,
}
