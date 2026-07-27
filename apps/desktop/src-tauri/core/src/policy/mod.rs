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

use crate::paths::{PathViolation, WorkspaceRoot};
use crate::time::now_iso;
use crate::types::{
    CommandPolicy, Decision, PolicyDecision, RiskLevel, RuleEffect, RunCommandArgs, TaskPolicy, ToolName, ToolRequest,
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
            decided_at: now_iso(),
        }
    }

    fn classify(&self, request: &ToolRequest, root: &WorkspaceRoot, task_policy: &TaskPolicy) -> Outcome {
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
                            if task_policy.auto_approve_workspace_writes {
                                Outcome {
                                    decision: Decision::AutoApprove,
                                    risk_level: RiskLevel::Low,
                                    matched_rule: "workspace_write_auto_approved".to_string(),
                                    reason: "workspace 내부 쓰기이며 정책이 자동 승인을 허용함".to_string(),
                                    normalized_target: target,
                                }
                            } else {
                                Outcome {
                                    decision: Decision::RequireUserApproval,
                                    risk_level: RiskLevel::Medium,
                                    matched_rule: "workspace_write_requires_approval".to_string(),
                                    reason: "workspace 내부 파일을 변경함 — 사용자 승인 필요".to_string(),
                                    normalized_target: target,
                                }
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
                    Ok(safe) => Outcome {
                        decision: Decision::RequireUserApproval,
                        risk_level: RiskLevel::High,
                        matched_rule: "delete_always_requires_approval".to_string(),
                        reason: "파일 삭제는 되돌리기 비용이 크므로 정책과 무관하게 항상 승인이 필요함".to_string(),
                        normalized_target: safe.relative().to_string(),
                    },
                    Err(violation) => Outcome::deny_path(&candidate, violation),
                },
                Err(reason) => Outcome::deny_malformed(reason),
            },

            // ---- 셸 명령 ----
            ToolName::RunCommand | ToolName::RunTests => self.classify_command(request, root, task_policy),
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
            },
            CommandMatch::Allowed { rule, effect } => {
                if is_git_commit && !task_policy.allow_git_commit {
                    return Outcome {
                        decision: Decision::RequireUserApproval,
                        risk_level: RiskLevel::High,
                        matched_rule: "git_commit_requires_explicit_approval".to_string(),
                        reason: "git commit은 사용자가 명시적으로 승인해야 함".to_string(),
                        normalized_target: target,
                    };
                }
                if is_network_capable(&cmd) {
                    return Outcome {
                        decision: Decision::RequireUserApproval,
                        risk_level: RiskLevel::High,
                        matched_rule: format!("network_capable:{rule}"),
                        reason: "네트워크를 발생시킬 수 있는 명령 — 사용자 승인 필요".to_string(),
                        normalized_target: target,
                    };
                }
                match effect {
                    RuleEffect::Auto => Outcome::auto(&format!("allow:{rule}"), "allowlist auto 규칙", target),
                    RuleEffect::Conditional => Outcome {
                        decision: Decision::RequireUserApproval,
                        risk_level: RiskLevel::Medium,
                        matched_rule: format!("allow:{rule}"),
                        reason: "allowlist conditional 규칙 — 1클릭 승인으로 노출".to_string(),
                        normalized_target: target,
                    },
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
}

impl Outcome {
    fn auto(rule: &str, reason: &str, target: String) -> Self {
        Self {
            decision: Decision::AutoApprove,
            risk_level: RiskLevel::None,
            matched_rule: rule.to_string(),
            reason: reason.to_string(),
            normalized_target: target,
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
        }
    }

    fn deny_malformed(reason: String) -> Self {
        Self {
            decision: Decision::Deny,
            risk_level: RiskLevel::Prohibited,
            matched_rule: "malformed_tool_args".to_string(),
            reason,
            normalized_target: "(malformed)".to_string(),
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
