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
    #[serde(rename = "allowGitCommit", default)]
    pub allow_git_commit: bool,
    #[serde(rename = "commandTimeoutMs", default = "default_timeout")]
    pub command_timeout_ms: u64,
    #[serde(rename = "executionMode", default = "default_mode")]
    pub execution_mode: ExecutionMode,
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
            allow_git_commit: false,
            command_timeout_ms: default_timeout(),
            execution_mode: ExecutionMode::Verified,
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
    NotVerified,
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
