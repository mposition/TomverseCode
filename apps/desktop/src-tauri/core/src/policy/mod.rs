//! Policy Gate — 실행 여부의 최종 판단.
//!
//! docs/design/process-architecture.md 2절: Node가 1차 분류(`riskTier`)를 하지만 **실행 여부의
//! 최종 게이트는 항상 Rust**다. 그래서 이 모듈은 `ToolRequest.riskTier`를 판단 근거로 쓰지 않는다 —
//! args만 보고 처음부터 다시 판정한다. Node가 완전히 장악당해 `riskTier: "auto"`를 붙여 보내도
//! 결과가 달라지지 않는다.
//!
//! 설계상 이 모듈은 **순수 함수에 가깝다**: 파일 시스템은 경로 canonicalize에만 쓰고
//! (그건 workspace 경계 판정에 불가피하다) 쓰기·실행은 하지 않는다.
//!
//! # 이 게이트가 보장하지 **않는** 것 (정직하게 적어둔다)
//!
//! 파일 도구(`read_file`/`apply_patch`/`create_file`/`delete_file`)의 workspace 경계는 강한 보장이다 —
//! 경로를 canonicalize해 루트 밖이면 실행 자체를 하지 않는다.
//!
//! **그러나 `run_command`로 실행된 프로세스가 무엇을 하는지는 통제할 수 없다.** `npm test`가
//! workspace 밖 파일을 쓰거나 네트워크를 타는 것을 이 게이트는 막지 못한다 — 그건 프로세스
//! 샌드박싱(job object, seccomp, 컨테이너)의 문제이고 M0 범위 밖이다. 여기서 하는 일은
//! **어떤 프로그램이 어떤 인자로 실행될 수 있는지**를 allowlist로 좁히고, 그 결정을 사용자
//! 승인과 이벤트 로그에 드러내는 것이다.
//!
//! 이 구분을 흐리면 안 된다: "Policy Gate가 있으니 임의 코드 실행이 안전하다"는 주장은 거짓이다.
//! 참인 주장은 "실행될 명령이 사용자에게 정확히 보이고, allowlist 밖 명령은 기본 거부되며,
//! 무엇이 실행됐는지 감사 가능하다"다.

pub mod command;
pub mod secrets;

use crate::paths::{PathViolation, WorkspaceRoot};
use crate::time::now_iso;
use crate::types::{
    CommandPolicy, Decision, PolicyDecision, PolicyLever, RiskLevel, RuleEffect, RunCommandArgs, TaskPolicy, ToolName,
    ToolRequest,
};
use command::{default_command_policy, is_network_capable, match_command, program_basename, CommandMatch};

pub struct PolicyGate {
    command_policy: CommandPolicy,
}

impl PolicyGate {
    pub fn new(task_policy: &TaskPolicy) -> Self {
        Self {
            command_policy: task_policy
                .command_policy
                .clone()
                .unwrap_or_else(default_command_policy),
        }
    }

    /// 모든 도구 실행이 반드시 통과하는 단일 지점.
    pub fn evaluate(&self, request: &ToolRequest, root: &WorkspaceRoot, task_policy: &TaskPolicy) -> PolicyDecision {
        let outcome = self.classify(request, root, task_policy);
        PolicyDecision {
            request_id: request.request_id.clone(),
            decision: outcome.decision,
            risk_level: outcome.risk_level,
            matched_rule: outcome.matched_rule,
            reason: outcome.reason,
            requires_user_approval: matches!(outcome.decision, Decision::RequireUserApproval),
            normalized_target: outcome.normalized_target,
            unblocked_by: outcome.unblocked_by,
            decided_at: now_iso(),
        }
    }

    fn classify(&self, request: &ToolRequest, root: &WorkspaceRoot, task_policy: &TaskPolicy) -> Outcome {
        // 0) 스킬이 좁힌 도구 집합 (state-machine 26절).
        //
        //    **분류보다 먼저 본다.** 뒤에 두면 도구별 분기마다 같은 검사를 되풀이해야 하고,
        //    하나를 빠뜨리면 그 도구만 조용히 새어 나간다. 그리고 이 검사는 **좁히기만**
        //    하므로 앞에 두어도 어떤 도구가 새로 허용되지 않는다.
        if let Some(allowed) = &task_policy.allowed_tools {
            if !allowed.contains(&request.tool) {
                return Outcome {
                    decision: Decision::Deny,
                    risk_level: RiskLevel::Prohibited,
                    matched_rule: "tool_not_in_skill_allowlist".to_string(),
                    reason: format!(
                        "이 스킬이 허용한 도구가 아닙니다: {} (허용: {})",
                        request.tool.as_str(),
                        allowed.iter().map(|t| t.as_str()).collect::<Vec<_>>().join(", ")
                    ),
                    normalized_target: String::new(),
                    unblocked_by: PolicyLever::NotApplicable,
                };
            }
        }
        match request.tool {
            // ---- 읽기·검색·git 조회: workspace 내부면 자동 허용 ----
            ToolName::ListFiles | ToolName::SearchText | ToolName::GitStatus | ToolName::GitDiff => {
                // 이 도구들은 경로 인자가 선택적이며, 있으면 workspace 내부여야 한다.
                match optional_path_arg(request) {
                    Some(candidate) => match root.resolve_existing(&candidate) {
                        Ok(safe) => Outcome::auto(
                            "read_only_within_workspace",
                            "읽기 전용 도구, workspace 내부 경로",
                            safe.relative().to_string(),
                        ),
                        Err(violation) => Outcome::deny_path(&candidate, violation),
                    },
                    None => Outcome::auto(
                        "read_only_within_workspace",
                        "읽기 전용 도구, workspace 루트 대상",
                        ".".to_string(),
                    ),
                }
            }

            ToolName::ReadFile => match required_path_arg(request) {
                Ok(candidate) => match root.resolve_existing(&candidate) {
                    // 읽기는 보통 자동 허용이지만 **비밀값을 담을 수 있는 경로는 예외**다.
                    //
                    // Node의 Context Engine이 이미 secret 파일을 모델 컨텍스트에서 제외하지만,
                    // 그건 Node가 스스로 지키는 규칙이다. Node가 장악당하면 필터를 우회해
                    // `read_file(".env")`를 그냥 요청할 수 있고, 그때 막는 것은 여기뿐이다
                    // (process-architecture.md 2절 신뢰 모델).
                    //
                    // 거부가 아니라 승인 필요로 두는 이유: 사용자가 정말로 `.env`를 고쳐달라고
                    // 요청하는 경우가 있다. 그걸 원천 차단하면 도구가 쓸모없어지므로,
                    // "무엇을 읽으려 하는지 사용자에게 보이고 사용자가 결정한다"로 처리한다.
                    Ok(safe) if secrets::is_secret_path(safe.relative()) => Outcome::needs_approval(
                        "secret_path_read_requires_approval".to_string(),
                        "비밀값을 담을 수 있는 파일을 읽으려 함 — 사용자 승인 필요".to_string(),
                        safe.relative().to_string(),
                        RiskLevel::High,
                        // 위 주석대로 "사용자가 결정한다"가 이 자리의 전부다 — 넓힐 스위치가 없다.
                        PolicyLever::HumanOnly,
                    ),
                    Ok(safe) => Outcome::auto(
                        "read_only_within_workspace",
                        "파일 읽기, workspace 내부 경로",
                        safe.relative().to_string(),
                    ),
                    Err(violation) => Outcome::deny_path(&candidate, violation),
                },
                Err(reason) => Outcome::deny_malformed(reason),
            },

            // ---- 파일 생성·수정: workspace 내부에서 승인 정책에 따라 ----
            ToolName::CreateFile | ToolName::ApplyPatch => match required_path_arg(request) {
                Ok(candidate) => {
                    // apply_patch는 기존 파일이 있어야 하지만, patch가 새 파일을 만드는 경우도 있어
                    // create 규칙으로 해석한다. 존재 여부는 Tool Runtime이 판단한다.
                    match root.resolve_for_create(&candidate) {
                        Ok(safe) => {
                            let target = safe.relative().to_string();
                            // 비밀값 파일 쓰기는 **자동 승인 정책보다 우선**한다. `.env`를 조용히
                            // 덮어쓰면 사용자가 잃는 것(되돌릴 수 없는 자격증명)이 일반 소스 파일과
                            // 비교할 수 없이 크다. 정책으로도 이 승인을 끌 수 없게 둔다.
                            if secrets::is_secret_path(&target) {
                                Outcome::needs_approval(
                                    "secret_path_write_requires_approval".to_string(),
                                    "비밀값을 담을 수 있는 파일을 변경함 — 자동 승인 정책과 무관하게 승인 필요".to_string(),
                                    target,
                                    RiskLevel::High,
                                    // 바로 위 주석: "정책으로도 이 승인을 끌 수 없게 둔다."
                                    PolicyLever::HumanOnly,
                                )
                            } else if task_policy.auto_approve_workspace_writes {
                                Outcome {
                                    decision: Decision::AutoApprove,
                                    risk_level: RiskLevel::Low,
                                    matched_rule: "workspace_write_auto_approved".to_string(),
                                    reason: "workspace 내부 쓰기이며 정책이 자동 승인을 허용함".to_string(),
                                    normalized_target: target,
                                    unblocked_by: PolicyLever::NotApplicable,
                                }
                            } else {
                                Outcome::needs_approval(
                                    "workspace_write_requires_approval".to_string(),
                                    "workspace 내부 파일을 변경함 — 사용자 승인 필요".to_string(),
                                    target,
                                    RiskLevel::Medium,
                                    PolicyLever::AutoApproveWorkspaceWrites,
                                )
                            }
                        }
                        Err(violation) => Outcome::deny_path(&candidate, violation),
                    }
                }
                Err(reason) => Outcome::deny_malformed(reason),
            },

            // ---- 파일 삭제: 항상 사용자 승인 (정책으로도 자동화하지 않는다) ----
            ToolName::DeleteFile => match required_path_arg(request) {
                Ok(candidate) => match root.resolve_existing(&candidate) {
                    Ok(safe) => Outcome::needs_approval(
                        "delete_always_requires_approval".to_string(),
                        "파일 삭제는 되돌리기 비용이 크므로 정책과 무관하게 항상 승인이 필요함".to_string(),
                        safe.relative().to_string(),
                        RiskLevel::High,
                        PolicyLever::HumanOnly,
                    ),
                    Err(violation) => Outcome::deny_path(&candidate, violation),
                },
                Err(reason) => Outcome::deny_malformed(reason),
            },

            // ---- 셸 명령 ----
            ToolName::RunCommand | ToolName::RunTests => self.classify_command(request, root, task_policy),

            // ---- MCP: 언제나 사용자 승인. 정책으로 낮출 수 없다 ----
            //
            // **무엇을 하는 도구인지 우리가 모른다.** MCP 서버는 우리 게이트 밖에서 파일을
            // 고치고 네트워크를 쓸 수 있으므로, 여기서 자동 허용할 근거를 만들 방법이 없다.
            // `run_command`처럼 allowlist로 완화하는 길도 두지 않는다 — allowlist는 "이 명령이
            // 무엇을 하는지 안다"에 기대는데, 그 전제가 여기서는 성립하지 않는다.
            //
            // 그래서 `task_policy`를 **보지 않는다**. 보면 언젠가 누군가 완화 조건을 넣는다.
            ToolName::McpCall => match crate::mcp::parse_call(&request.args) {
                // 승인 화면이 무엇을 보여줄지 정하지 못하는 요청은 승인받을 수 없다 —
                // "무엇을 승인하는지 모르는 승인"은 승인이 아니다.
                Err(reason) => Outcome::deny_malformed(reason),
                Ok(call) => Outcome::needs_approval(
                    "mcp_always_requires_approval".to_string(),
                    format!(
                        "MCP 도구는 이 게이트 밖에서 동작할 수 있어 언제나 승인을 요구합니다: {}",
                        crate::mcp::describe(&call)
                    ),
                    // 승인 화면과 이벤트가 **이 문자열 그대로**를 보여준다(원칙 6의 MCP판).
                    crate::mcp::describe(&call),
                    RiskLevel::High,
                    // 23.3절: 정책으로 낮출 수 없다. 여기에 레버를 붙이는 순간 그 규칙이 깨진다.
                    PolicyLever::HumanOnly,
                ),
            },
        }
    }

    fn classify_command(&self, request: &ToolRequest, root: &WorkspaceRoot, task_policy: &TaskPolicy) -> Outcome {
        // 1) argv 구조 검증. 여기서 실패하면 셸 문자열을 넘기려 한 것이므로 거부한다.
        let cmd = match parse_run_command(&request.args) {
            Ok(cmd) => cmd,
            Err(reason) => {
                return Outcome {
                    decision: Decision::Deny,
                    risk_level: RiskLevel::Prohibited,
                    matched_rule: "argv_contract_violation".to_string(),
                    reason,
                    normalized_target: "(malformed)".to_string(),
                    unblocked_by: PolicyLever::NotApplicable,
                }
            }
        };

        // 2) cwd가 workspace 내부인지. 밖이면 규칙을 볼 필요조차 없다.
        let cwd_safe = match root.resolve_existing(&cmd.cwd) {
            Ok(safe) => safe,
            Err(violation) => {
                return Outcome {
                    decision: Decision::Deny,
                    risk_level: RiskLevel::Prohibited,
                    matched_rule: "cwd_outside_workspace".to_string(),
                    reason: format!("cwd {:?}를 거부함: {violation}", cmd.cwd),
                    normalized_target: cmd.display(),
                    unblocked_by: PolicyLever::NotApplicable,
                }
            }
        };
        let cwd_is_root = cwd_safe.relative() == ".";

        // 3) 경로처럼 보이는 인자의 하드 체크 (문서 5.2절 마지막 문단).
        //    규칙 매칭 여부와 무관하게 항상 적용된다.
        for arg in &cmd.args {
            if let Err(violation) = root.check_command_arg(arg) {
                return Outcome {
                    decision: Decision::Deny,
                    risk_level: RiskLevel::Prohibited,
                    matched_rule: "command_arg_path_outside_workspace".to_string(),
                    reason: format!("명령 인자 {arg:?}가 workspace를 벗어남: {violation}"),
                    normalized_target: cmd.display(),
                    unblocked_by: PolicyLever::NotApplicable,
                };
            }
        }

        let target = cmd.display();
        let program = program_basename(&cmd.program);

        // 4) git commit은 별도 게이트를 하나 더 통과해야 한다.
        //    "Git commit 자동 생성은 사용자가 명시적으로 승인한 경우에만 허용한다."
        let is_git_commit = program == "git" && cmd.args.first().map(|a| a.as_str()) == Some("commit");

        match match_command(&self.command_policy, &cmd, cwd_is_root) {
            CommandMatch::Denied { rule } => Outcome {
                decision: Decision::Deny,
                risk_level: RiskLevel::Prohibited,
                matched_rule: format!("deny:{rule}"),
                reason: format!("deny 규칙 {rule:?}에 매치 — 정책 override로 해제할 수 없음"),
                normalized_target: target,
                unblocked_by: PolicyLever::NotApplicable,
            },
            CommandMatch::Allowed { rule, effect } => {
                if is_git_commit && !task_policy.allow_git_commit {
                    return Outcome::needs_approval(
                        "git_commit_requires_explicit_approval".to_string(),
                        "git commit은 사용자가 명시적으로 승인해야 함".to_string(),
                        target,
                        RiskLevel::High,
                        PolicyLever::AllowGitCommit,
                    );
                }
                if is_network_capable(&cmd) {
                    return Outcome::needs_approval(
                        format!("network_capable:{rule}"),
                        "네트워크를 발생시킬 수 있는 명령 — 사용자 승인 필요".to_string(),
                        target,
                        RiskLevel::High,
                        // 이 판정을 끄는 스위치는 없다 — 만들면 "네트워크를 탈 수 있다"를 미리
                        // 승인하는 것이 되는데, 그 대상은 명령마다 다르고 우리가 모른다.
                        PolicyLever::HumanOnly,
                    );
                }
                match effect {
                    RuleEffect::Auto => Outcome::auto(&format!("allow:{rule}"), "allowlist auto 규칙", target),
                    // **게이트는 여기서 `HumanOnly`밖에 말할 수 없다.** 이 명령이 프로젝트가
                    // 선언해 둔 검증 명령이면 `autoApproveVerification`이 통과시키지만, 그
                    // 고정 집합은 게이트가 아니라 `TaskHost`가 들고 있다(24.5절). 모르는 것을
                    // 여기서 추측해 적으면 대부분의 conditional 명령에 틀린 처방이 붙는다 —
                    // 아는 쪽이 무인 정지 시점에 고쳐 적는다.
                    RuleEffect::Conditional => Outcome::needs_approval(
                        format!("allow:{rule}"),
                        "allowlist conditional 규칙 — 1클릭 승인으로 노출".to_string(),
                        target,
                        RiskLevel::Medium,
                        PolicyLever::HumanOnly,
                    ),
                }
            }
            // 5) 분류할 수 없는 요청은 기본 거부다.
            //
            //    설계 문서 4절은 `run_command`의 도구 기본값을 `user_approval`로 적었지만,
            //    작업 지침 4.2절은 "모호하거나 분류할 수 없는 요청: 기본 거부"를 요구한다.
            //    후자를 택했다 — 승인 모달은 사용자가 판단할 정보를 갖고 있을 때만 의미가 있고,
            //    allowlist에 없는 임의 실행 파일에 대해 사용자는 그 정보를 갖고 있지 않다.
            //    필요한 명령은 워크스페이스 정책에 규칙을 추가해 명시적으로 허용한다.
            CommandMatch::NoMatch => Outcome {
                decision: Decision::Deny,
                risk_level: RiskLevel::High,
                matched_rule: "no_rule_matched_default_deny".to_string(),
                reason: format!(
                    "{program:?}에 매치되는 allowlist 규칙이 없음 — 분류 불가한 명령은 기본 거부. \
                     필요하면 워크스페이스 정책에 규칙을 추가할 것"
                ),
                normalized_target: target,
                unblocked_by: PolicyLever::NotApplicable,
            },
        }
    }
}

struct Outcome {
    decision: Decision,
    risk_level: RiskLevel,
    matched_rule: String,
    reason: String,
    normalized_target: String,
    /// 승인을 요구하는 결정에서만 의미가 있다. 나머지는 `NotApplicable`.
    unblocked_by: PolicyLever,
}

impl Outcome {
    fn auto(rule: &str, reason: &str, target: String) -> Self {
        Self {
            decision: Decision::AutoApprove,
            risk_level: RiskLevel::None,
            matched_rule: rule.to_string(),
            reason: reason.to_string(),
            normalized_target: target,
            unblocked_by: PolicyLever::NotApplicable,
        }
    }

    /// 승인을 요구하는 **유일한** 생성 경로.
    ///
    /// 필드를 직접 채워 `RequireUserApproval`을 만들 수 있게 두면, 새 승인 자리를 만든 사람이
    /// 레버를 정하지 않고 지나갈 수 있다. 그러면 무인 정지 보고가 그 자리에 대해 아무 말도
    /// 못 하거나, 더 나쁘게는 기본값이 붙어 **틀린 처방**을 내놓는다. 인자로 받으면 컴파일러가
    /// 매번 답을 요구한다 — "생각해 보니 사람만"도 `HumanOnly`라고 적어야 하는 답이다.
    ///
    /// 이 경로 밖에서 `RequireUserApproval`이 만들어지지 않는다는 것은 소스를 훑는 검사가
    /// 지킨다(`the_only_way_to_require_approval_is_the_constructor`).
    fn needs_approval(rule: String, reason: String, target: String, risk: RiskLevel, lever: PolicyLever) -> Self {
        debug_assert_ne!(
            lever,
            PolicyLever::NotApplicable,
            "승인을 요구하면서 넓힐 레버를 '해당 없음'으로 둘 수 없다"
        );
        Self {
            decision: Decision::RequireUserApproval,
            risk_level: risk,
            matched_rule: rule,
            reason,
            normalized_target: target,
            unblocked_by: lever,
        }
    }

    fn deny_path(candidate: &str, violation: PathViolation) -> Self {
        // NotFound는 정책 위반이 아니라 실행 오류다 — 하지만 Policy Gate 단계에서 경로를
        // 확정할 수 없으면 통과시킬 수 없으므로 거부한다. Tool Runtime이 "없는 파일"을
        // 만들어내지 않도록 하는 것도 이 판정의 역할이다.
        let risk = match violation {
            PathViolation::NotFound => RiskLevel::Low,
            _ => RiskLevel::Prohibited,
        };
        Self {
            decision: Decision::Deny,
            risk_level: risk,
            matched_rule: "workspace_boundary".to_string(),
            reason: format!("경로 {candidate:?}를 거부함: {violation}"),
            normalized_target: candidate.to_string(),
            unblocked_by: PolicyLever::NotApplicable,
        }
    }

    fn deny_malformed(reason: String) -> Self {
        Self {
            decision: Decision::Deny,
            risk_level: RiskLevel::Prohibited,
            matched_rule: "malformed_tool_args".to_string(),
            reason,
            normalized_target: "(malformed)".to_string(),
            unblocked_by: PolicyLever::NotApplicable,
        }
    }
}

fn required_path_arg(request: &ToolRequest) -> Result<String, String> {
    match request.args.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => Ok(p.to_string()),
        _ => Err(format!("{} 요청에 문자열 \"path\" 인자가 없음", request.tool.as_str())),
    }
}

fn optional_path_arg(request: &ToolRequest) -> Option<String> {
    request
        .args
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.to_string())
}

/// argv 계약 검증. 셸 문자열을 넘기려는 모든 형태를 여기서 거부한다.
///
/// Node 쪽 `normalizeRunCommandArgs`와 규칙이 겹치지만 의도적이다 — Node가 장악당해도
/// 이 검사를 통과해야 하므로, Node의 검증 결과를 신뢰해 생략하면 신뢰 경계가 무너진다.
pub fn parse_run_command(args: &serde_json::Value) -> Result<RunCommandArgs, String> {
    let obj = args
        .as_object()
        .ok_or_else(|| "run_command args가 객체가 아님".to_string())?;

    if let Some(shell) = obj.get("shell") {
        if !shell.is_null() && shell != &serde_json::Value::Bool(false) {
            return Err("shell 실행은 지원하지 않음 — argv 배열을 넘길 것".to_string());
        }
    }
    // 셸 문자열을 담을 만한 필드명을 명시적으로 거부한다. 조용히 무시하면 호출자가
    // "넘겼는데 왜 안 되지"를 겪고 우회를 시도한다.
    for key in ["command", "commandLine", "script", "shellCommand"] {
        if obj.get(key).map(|v| v.is_string()).unwrap_or(false) {
            return Err(format!(
                "셸 명령 문자열({key:?})은 받지 않음 — program + args를 넘길 것"
            ));
        }
    }

    let program = obj
        .get("program")
        .or_else(|| obj.get("executable"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "run_command에 문자열 \"program\" 인자가 없음".to_string())?;

    // program 자체가 셸 문자열인 경우 (예: "npm test && rm -rf /")
    if program.chars().any(|c| " \t;&|<>`$\n\r\"'".contains(c)) {
        return Err(format!(
            "program은 실행 파일 이름이어야 하며 셸 문자열일 수 없음 (받은 값: {program:?})"
        ));
    }

    let args_vec = match obj.get("args") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                match item.as_str() {
                    Some(s) => out.push(s.to_string()),
                    None => return Err(format!("args[{i}]가 문자열이 아님")),
                }
            }
            out
        }
        // 문자열 하나를 args로 주는 것은 셸 파싱을 기대하는 것이므로 거부한다.
        Some(serde_json::Value::String(_)) => {
            return Err("args는 문자열이 아니라 배열이어야 함 (셸 파싱을 하지 않음)".to_string())
        }
        Some(_) => return Err("args가 배열이 아님".to_string()),
    };

    let cwd = obj
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(".")
        .to_string();

    let timeout_ms = obj.get("timeoutMs").and_then(|v| v.as_u64());

    Ok(RunCommandArgs {
        program,
        args: args_vec,
        cwd,
        timeout_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn setup() -> (tempfile::TempDir, WorkspaceRoot) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/app.ts"), "const a = 1;\n").unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        (dir, root)
    }

    // ---- 스킬의 도구 허용목록 (state-machine 26절) ----

    fn skill_policy(tools: &[ToolName]) -> TaskPolicy {
        TaskPolicy {
            allowed_tools: Some(tools.to_vec()),
            // **넓히는 스위치를 함께 켠다.** 허용목록이 좁히는 쪽에서만 작동하는지 보려면,
            // 정책이 원래 자동 허용했을 도구를 막는 것까지 확인해야 한다.
            auto_approve_workspace_writes: true,
            ..TaskPolicy::default()
        }
    }

    /// 허용목록 밖의 도구는 **거부**다. 승인 필요가 아니다 — 스킬이 안 쓰기로 한 도구를
    /// 사용자에게 물으면, 사용자는 자기가 고른 스킬이 왜 그걸 요구하는지 알 수 없다.
    #[test]
    fn a_tool_outside_the_skill_allowlist_is_denied() {
        let (_d, root) = setup();
        let policy = skill_policy(&[ToolName::ReadFile]);
        let gate = PolicyGate::new(&policy);
        let request = ToolRequest {
            request_id: "req-1".to_string(),
            task_id: "task-1".to_string(),
            tool: ToolName::CreateFile,
            args: json!({ "path": "src/new.ts", "content": "x" }),
            risk_tier: None,
            requested_by: json!({ "role": "executor" }),
            created_at: None,
        };
        let decision = gate.evaluate(&request, &root, &policy);
        assert_eq!(decision.decision, Decision::Deny, "{}", decision.reason);
        assert_eq!(decision.matched_rule, "tool_not_in_skill_allowlist");
        // 무엇이 허용됐는지 함께 말한다 — 거부만 하면 사용자가 추측하게 된다.
        assert!(decision.reason.contains("read_file"), "{}", decision.reason);
    }

    /// **허용목록은 넓히지 않는다.** 목록에 있어도 게이트의 분류를 그대로 지난다 —
    /// 여기서 자동 허용이 되면 스킬 파일 한 줄이 정책을 푸는 경로가 된다.
    #[test]
    fn being_on_the_allowlist_does_not_relax_the_gate() {
        let (dir, root) = setup();
        std::fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
        let policy = skill_policy(&[ToolName::ApplyPatch, ToolName::DeleteFile]);
        let gate = PolicyGate::new(&policy);

        // 삭제는 허용목록에 있어도 여전히 승인이 필요하다(정책으로 낮출 수 없는 자리).
        let delete = ToolRequest {
            request_id: "req-1".to_string(),
            task_id: "task-1".to_string(),
            tool: ToolName::DeleteFile,
            args: json!({ "path": "src/app.ts" }),
            risk_tier: None,
            requested_by: json!({ "role": "executor" }),
            created_at: None,
        };
        let d = gate.evaluate(&delete, &root, &policy);
        assert!(d.requires_user_approval, "{}", d.matched_rule);

        // 비밀값 파일 쓰기도 마찬가지 — `auto_approve_workspace_writes`가 켜져 있어도 그렇다.
        let secret = ToolRequest {
            request_id: "req-2".to_string(),
            task_id: "task-1".to_string(),
            tool: ToolName::ApplyPatch,
            args: json!({ "path": ".env", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
            risk_tier: None,
            requested_by: json!({ "role": "executor" }),
            created_at: None,
        };
        let d = gate.evaluate(&secret, &root, &policy);
        assert!(d.requires_user_approval, "{}", d.matched_rule);
    }

    /// **검증은 스킬이 끌 수 없다.** 허용목록에 `run_tests`를 적지 않아도 검증 명령은 지나야
    /// 한다 — 여기서 막히면 스킬 파일 한 줄로 `VERIFYING`이 조용히 무력화된다(원칙 1).
    ///
    /// 목록을 만드는 쪽(`skills::validate`)이 `run_tests`를 넣어 주지만, **게이트가 그 사실에
    /// 기대고 있다는 것을 여기서 고정한다** — 정책을 다른 경로로 만들면 그 보정이 없다.
    #[test]
    fn a_policy_that_forgot_run_tests_still_lets_verification_through() {
        let (_d, root) = setup();
        let skill = crate::skills::validate(
            serde_json::from_str(r#"{"name":"s","allowedTools":["read_file"]}"#).unwrap(),
        )
        .unwrap();
        let policy = TaskPolicy {
            allowed_tools: skill.allowed_tools.clone(),
            ..TaskPolicy::default()
        };
        let gate = PolicyGate::new(&policy);
        let request = ToolRequest {
            request_id: "req-1".to_string(),
            task_id: "task-1".to_string(),
            tool: ToolName::RunTests,
            args: json!({ "program": "npm", "args": ["test"], "cwd": "." }),
            risk_tier: None,
            requested_by: json!({ "role": "orchestrator" }),
            created_at: None,
        };
        let decision = gate.evaluate(&request, &root, &policy);
        assert_ne!(
            decision.matched_rule, "tool_not_in_skill_allowlist",
            "스킬 허용목록이 검증 명령을 막았습니다 — 원칙 1이 깨집니다"
        );
    }

    /// 허용목록이 없으면 아무것도 달라지지 않는다.
    #[test]
    fn no_allowlist_changes_nothing() {
        let (_d, root) = setup();
        let policy = TaskPolicy::default();
        let gate = PolicyGate::new(&policy);
        let request = ToolRequest {
            request_id: "req-1".to_string(),
            task_id: "task-1".to_string(),
            tool: ToolName::CreateFile,
            args: json!({ "path": "src/new.ts", "content": "x" }),
            risk_tier: None,
            requested_by: json!({ "role": "executor" }),
            created_at: None,
        };
        let decision = gate.evaluate(&request, &root, &policy);
        assert_ne!(decision.matched_rule, "tool_not_in_skill_allowlist");
    }

    // ---- 무인 정지의 처방 (state-machine 24.8절) ----

    /// 승인을 요구하는 결정은 **한 자리에서만** 만들어진다.
    ///
    /// 이 검사가 없으면 새 승인 자리를 만드는 사람이 필드를 직접 채워 레버를 정하지 않고
    /// 지나갈 수 있다. 컴파일러는 `Outcome`의 필드가 다 찼는지만 보므로 그때 아무 말도 하지
    /// 않고, `NotApplicable`이 조용히 들어가 무인 정지 보고가 **그 자리에 대해 틀린 처방**을
    /// 내놓는다.
    #[test]
    fn the_only_way_to_require_approval_is_the_constructor() {
        // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일 자체가 검사 대상에 들어가
        // 개수가 언제나 어긋난다.
        let construction = format!("decision: {}::{},", "Decision", "RequireUserApproval");
        let source = include_str!("mod.rs");
        // 테스트 모듈은 제외한다. 단언문에 같은 토큰이 있고, 그건 생성이 아니다.
        let cfg_test = format!("#[cfg({})]", "test");
        let end = source.find(&cfg_test).expect("테스트 모듈 경계를 찾지 못했습니다");
        let production = &source[..end];

        let sites: Vec<usize> = production.match_indices(&construction).map(|(i, _)| i).collect();
        assert_eq!(
            sites.len(),
            1,
            "승인 결정을 직접 만드는 자리가 {}곳입니다. `Outcome::needs_approval`을 쓰세요 — \
             그래야 레버를 정하지 않고 지나갈 수 없습니다",
            sites.len()
        );

        let ctor = production
            .find("fn needs_approval")
            .expect("needs_approval을 찾지 못했습니다");
        // 생성자 다음 함수가 시작되기 전까지가 생성자의 범위다.
        let after = production[ctor..]
            .find("\n    fn ")
            .map(|i| ctor + i)
            .unwrap_or(production.len());
        assert!(
            sites[0] > ctor && sites[0] < after,
            "유일한 생성 자리가 `needs_approval` 밖에 있습니다"
        );
    }

    /// 게이트의 레버는 **규칙마다 다르다.** 하나로 뭉개면 처방이 무의미해진다.
    #[test]
    fn each_approval_rule_names_the_lever_that_widens_it() {
        let (dir, root) = setup();
        // 비밀값 경로 규칙은 **실재하는 파일**에 대해서만 도달한다 — 없으면 그 앞의 경계
        // 검사가 먼저 거부하고, 그러면 이 표는 규칙이 아니라 "파일이 없다"를 재게 된다.
        fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
        let gate = PolicyGate::new(&TaskPolicy::default());
        let cases: &[(ToolName, serde_json::Value, PolicyLever)] = &[
            // 워크스페이스 쓰기는 미리 넓힐 수 있다.
            (
                ToolName::CreateFile,
                json!({ "path": "src/new.ts", "content": "x" }),
                PolicyLever::AutoApproveWorkspaceWrites,
            ),
            // 삭제·비밀값·MCP는 정책으로 낮출 수 없다 — 여기에 레버를 붙이면 거짓말이 된다.
            (
                ToolName::DeleteFile,
                json!({ "path": "src/app.ts" }),
                PolicyLever::HumanOnly,
            ),
            (
                ToolName::ReadFile,
                json!({ "path": ".env" }),
                PolicyLever::HumanOnly,
            ),
            (
                ToolName::McpCall,
                json!({ "server": "s", "tool": "t", "arguments": {} }),
                PolicyLever::HumanOnly,
            ),
            (
                ToolName::RunCommand,
                json!({ "program": "git", "args": ["commit", "-m", "x"], "cwd": "." }),
                PolicyLever::AllowGitCommit,
            ),
        ];
        for (tool, args, expected) in cases {
            let request = ToolRequest {
                request_id: "req-1".to_string(),
                task_id: "task-1".to_string(),
                tool: *tool,
                args: args.clone(),
                risk_tier: None,
                requested_by: json!({ "role": "orchestrator" }),
                created_at: None,
            };
            let decision = gate.evaluate(&request, &root, &TaskPolicy::default());
            assert!(
                decision.requires_user_approval,
                "{tool:?}가 승인을 요구하지 않았습니다 — 이 표가 낡았습니다: {}",
                decision.matched_rule
            );
            assert_eq!(decision.unblocked_by, *expected, "{tool:?} / {}", decision.matched_rule);
        }
    }

    /// 승인을 요구하지 **않는** 결정에 레버가 붙으면, 보고서가 넓힐 것이 없는 자리에
    /// 스위치를 제안한다.
    #[test]
    fn a_decision_that_asks_nothing_names_no_lever() {
        let (_d, root) = setup();
        let gate = PolicyGate::new(&TaskPolicy::default());
        let request = ToolRequest {
            request_id: "req-1".to_string(),
            task_id: "task-1".to_string(),
            tool: ToolName::ListFiles,
            args: json!({}),
            risk_tier: None,
            requested_by: json!({ "role": "orchestrator" }),
            created_at: None,
        };
        let decision = gate.evaluate(&request, &root, &TaskPolicy::default());
        assert!(!decision.requires_user_approval);
        assert_eq!(decision.unblocked_by, PolicyLever::NotApplicable);
    }

    // ---- MCP (state-machine 23절) ----

    /// **어떤 정책으로도 자동 허용이 되지 않는다.**
    ///
    /// `auto_approve_workspace_writes`는 워크스페이스 안의 쓰기를 자동화하는 스위치인데,
    /// MCP 도구는 워크스페이스 안에서 도는지조차 우리가 모른다. 그 스위치가 여기에 걸리면
    /// 사용자는 "내 저장소 안의 편집을 자동 승인"한다고 생각하면서 **게이트 밖의 임의 도구를
    /// 자동 승인**하게 된다.
    #[test]
    fn mcp_always_requires_approval_regardless_of_policy() {
        let dir = tempfile::tempdir().unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        let call = json!({ "server": "fs", "tool": "write_file", "arguments": { "path": "/etc/hosts" } });

        for policy in [
            TaskPolicy::default(),
            TaskPolicy { auto_approve_workspace_writes: true, ..TaskPolicy::default() },
        ] {
            let d = PolicyGate::new(&policy).evaluate(&request(ToolName::McpCall, call.clone()), &root, &policy);
            assert_eq!(d.decision, Decision::RequireUserApproval, "{policy:?}");
            assert!(d.requires_user_approval);
            assert_eq!(d.risk_level, RiskLevel::High);
        }
    }

    /// 승인 화면이 보는 것은 `normalizedTarget`이다. **인자가 거기 그대로 있어야** 사용자가
    /// 승인한 것과 실제 나가는 것이 같다(원칙 6의 MCP판).
    #[test]
    fn the_decision_carries_the_call_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        let policy = TaskPolicy::default();
        let d = PolicyGate::new(&policy).evaluate(
            &request(
                ToolName::McpCall,
                json!({ "server": "fs", "tool": "write_file", "arguments": { "path": "/etc/hosts" } }),
            ),
            &root,
            &policy,
        );
        assert!(d.normalized_target.contains("fs"), "{}", d.normalized_target);
        assert!(d.normalized_target.contains("write_file"), "{}", d.normalized_target);
        assert!(d.normalized_target.contains("/etc/hosts"), "{}", d.normalized_target);
    }

    /// 무엇을 승인하는지 정하지 못하는 요청은 **승인 대상이 아니라 거부 대상**이다.
    #[test]
    fn a_malformed_mcp_call_is_denied_not_sent_for_approval() {
        let dir = tempfile::tempdir().unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        let policy = TaskPolicy::default();
        let d = PolicyGate::new(&policy).evaluate(
            &request(ToolName::McpCall, json!({ "server": "fs" })),
            &root,
            &policy,
        );
        assert_eq!(d.decision, Decision::Deny);
        assert!(!d.requires_user_approval);
    }

    fn request(tool: ToolName, args: serde_json::Value) -> ToolRequest {
        ToolRequest {
            request_id: "req-1".to_string(),
            task_id: "task-1".to_string(),
            tool,
            args,
            // Node가 "auto"라고 주장해도 Rust 판정이 달라지지 않아야 한다.
            risk_tier: Some(crate::types::RiskTier::Auto),
            requested_by: json!({ "role": "orchestrator" }),
            created_at: None,
        }
    }

    fn gate() -> PolicyGate {
        PolicyGate::new(&TaskPolicy::default())
    }

    #[test]
    fn read_inside_workspace_is_auto_approved() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::ReadFile, json!({ "path": "src/app.ts" })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::AutoApprove);
        assert_eq!(d.normalized_target, "src/app.ts");
        assert!(!d.requires_user_approval);
    }

    #[test]
    fn parent_traversal_is_denied() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::ReadFile, json!({ "path": "../../etc/passwd" })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::Deny);
        assert_eq!(d.risk_level, RiskLevel::Prohibited);
    }

    #[test]
    fn write_outside_workspace_is_denied() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::CreateFile, json!({ "path": "/tmp/evil.txt", "content": "x" })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::Deny);
    }

    #[test]
    fn workspace_write_requires_approval_by_default() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::ApplyPatch, json!({ "path": "src/app.ts", "patch": "..." })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::RequireUserApproval);
        assert!(d.requires_user_approval);
    }

    #[test]
    fn workspace_write_can_be_auto_approved_by_policy() {
        let (_d, root) = setup();
        let policy = TaskPolicy {
            auto_approve_workspace_writes: true,
            ..TaskPolicy::default()
        };
        let d = PolicyGate::new(&policy).evaluate(
            &request(ToolName::ApplyPatch, json!({ "path": "src/app.ts", "patch": "..." })),
            &root,
            &policy,
        );
        assert_eq!(d.decision, Decision::AutoApprove);
    }

    #[test]
    fn delete_always_requires_approval_even_with_auto_writes() {
        let (_d, root) = setup();
        let policy = TaskPolicy {
            auto_approve_workspace_writes: true,
            ..TaskPolicy::default()
        };
        let d = PolicyGate::new(&policy).evaluate(
            &request(ToolName::DeleteFile, json!({ "path": "src/app.ts" })),
            &root,
            &policy,
        );
        assert_eq!(d.decision, Decision::RequireUserApproval);
        assert_eq!(d.risk_level, RiskLevel::High);
    }

    #[test]
    fn shell_string_command_is_denied() {
        let (_d, root) = setup();
        for args in [
            json!({ "command": "npm test && rm -rf /" }),
            json!({ "program": "npm test && rm -rf /", "args": [] }),
            json!({ "program": "npm", "args": "test" }),
            json!({ "program": "npm", "args": ["test"], "shell": true }),
        ] {
            let d = gate().evaluate(
                &request(ToolName::RunCommand, args.clone()),
                &root,
                &TaskPolicy::default(),
            );
            assert_eq!(d.decision, Decision::Deny, "expected deny for {args}");
        }
    }

    #[test]
    fn argv_structure_is_preserved_in_normalized_target() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(
                ToolName::RunCommand,
                json!({ "program": "npm", "args": ["run", "build"], "cwd": "." }),
            ),
            &root,
            &TaskPolicy::default(),
        );
        // 승인 모달에 보이는 문자열이 실제 argv를 그대로 반영해야 한다.
        assert_eq!(d.normalized_target, "npm run build (cwd: .)");
        assert_eq!(d.decision, Decision::RequireUserApproval);
    }

    #[test]
    fn git_push_is_denied() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::RunCommand, json!({ "program": "git", "args": ["push"] })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::Deny);
        assert!(d.matched_rule.starts_with("deny:"));
    }

    #[test]
    fn git_commit_requires_approval_unless_policy_allows() {
        let (_d, root) = setup();
        let default_policy = TaskPolicy::default();
        let d = gate().evaluate(
            &request(
                ToolName::RunCommand,
                json!({ "program": "git", "args": ["commit", "-m", "fix"] }),
            ),
            &root,
            &default_policy,
        );
        assert_eq!(d.decision, Decision::RequireUserApproval);
        assert_eq!(d.matched_rule, "git_commit_requires_explicit_approval");

        let allowed = TaskPolicy {
            allow_git_commit: true,
            ..TaskPolicy::default()
        };
        let d2 = PolicyGate::new(&allowed).evaluate(
            &request(
                ToolName::RunCommand,
                json!({ "program": "git", "args": ["commit", "-m", "fix"] }),
            ),
            &root,
            &allowed,
        );
        // allow_git_commit=true여도 conditional 규칙이므로 여전히 1클릭 승인이다 —
        // "정책으로 켰다"가 "무음 실행"을 뜻하지는 않는다.
        assert_eq!(d2.decision, Decision::RequireUserApproval);
        assert_eq!(d2.matched_rule, "allow:git commit **");
    }

    #[test]
    fn network_command_requires_approval() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::RunCommand, json!({ "program": "npm", "args": ["ci"] })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::RequireUserApproval);
        assert!(d.matched_rule.starts_with("network_capable:"));
    }

    #[test]
    fn unclassifiable_command_is_denied_by_default() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(ToolName::RunCommand, json!({ "program": "rm", "args": ["-rf", "src"] })),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::Deny);
        assert_eq!(d.matched_rule, "no_rule_matched_default_deny");
    }

    #[test]
    fn cwd_outside_workspace_is_denied() {
        let (_d, root) = setup();
        let d = gate().evaluate(
            &request(
                ToolName::RunCommand,
                json!({ "program": "npm", "args": ["test"], "cwd": "../.." }),
            ),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::Deny);
        assert_eq!(d.matched_rule, "cwd_outside_workspace");
    }

    #[test]
    fn command_arg_escaping_workspace_is_denied_even_if_rule_matches() {
        let (_d, root) = setup();
        // `npm run *`는 allowlist에 있지만 경로 인자가 workspace를 벗어나면 하드 체크가 이긴다.
        let d = gate().evaluate(
            &request(
                ToolName::RunCommand,
                json!({ "program": "npm", "args": ["run", "../../../etc/passwd"] }),
            ),
            &root,
            &TaskPolicy::default(),
        );
        assert_eq!(d.decision, Decision::Deny);
        assert_eq!(d.matched_rule, "command_arg_path_outside_workspace");
    }

    #[test]
    fn node_supplied_risk_tier_does_not_influence_decision() {
        let (_d, root) = setup();
        let mut req = request(ToolName::DeleteFile, json!({ "path": "src/app.ts" }));
        req.risk_tier = Some(crate::types::RiskTier::Auto); // Node가 "자동 허용"이라고 주장
        let d = gate().evaluate(&req, &root, &TaskPolicy::default());
        assert_eq!(d.decision, Decision::RequireUserApproval);
    }

    #[test]
    fn malformed_args_are_denied_not_defaulted() {
        let (_d, root) = setup();
        let d = gate().evaluate(&request(ToolName::ReadFile, json!({})), &root, &TaskPolicy::default());
        assert_eq!(d.decision, Decision::Deny);
        assert_eq!(d.matched_rule, "malformed_tool_args");
    }
}
