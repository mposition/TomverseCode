//! `tomverse-host` — GUI 없이 M0 코어 루프 전체를 돌리는 헤드리스 호스트.
//!
//! 왜 이 바이너리가 존재하는가:
//!  1. **end-to-end 테스트가 진짜여야 한다.** Rust Policy Gate + Tool Runtime + SQLite +
//!     Node Orchestrator를 모두 실제로 태우면서 GUI를 요구하지 않는 실행 경로가 필요하다.
//!     UI를 mock해서 "e2e가 됐다"고 보고하지 않기 위한 구조다.
//!  2. Tauri 앱은 같은 `TaskHost`를 다른 프런트엔드로 감싼 것일 뿐이다 — 두 경로가 같은
//!     신뢰 경계 코드를 공유하므로 여기서 통과한 것이 앱에서도 통과한다.
//!
//! 사용:
//! ```text
//! tomverse-host run --workspace <path> --message "..." [--mode fast|verified]
//!                   [--approve auto|deny|autopilot] [--db <path>] [--artifacts <path>]
//!                   [--hook <phase=프로그램[,인자...]>] [--skill <파일.json>]
//!                   [--sidecar <index.js>] [--auto-approve-writes] [--auto-approve-verification]
//!                   [--allow-git-commit]
//!                   [--cancel-after-ms <n>] [--budget-usd <n>]
//!                   [--pin-executor <modelId>] [--pin-reviewer <modelId>] [--verbose]
//! tomverse-host rollback --workspace <path> --task <taskId> --db <path> [--artifacts <path>]
//! tomverse-host recover  --workspace <path> --db <path>
//! tomverse-host tasks    --workspace <path> --db <path>
//! tomverse-host show     --workspace <path> --task <taskId> --db <path>
//! ```
//!
//! M0.1에서 `recover`/`tasks`/`show`가 추가된 이유: 영속화가 실제로 되는지 검증하려면
//! **호스트가 죽은 뒤 새 프로세스가 DB만 열어서** 같은 사실을 읽을 수 있어야 한다.
//! 같은 프로세스 안에서 확인하면 "메모리에 남아 있었다"와 구별되지 않는다.
//! 이 세 명령은 Tauri 앱이 부르는 것과 **같은 Store 메서드**를 호출한다 — 테스트 전용 경로가 아니다.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tomverse_core::artifacts::ArtifactStore;
use tomverse_core::host::{AlwaysDeny, ApprovalGateway, AutoApprove, EventSink, TaskHost};
use tomverse_core::sidecar::SidecarClient;
use tomverse_core::store::{Store, TerminalOutcome};
use tomverse_core::types::{ExecutionMode, TaskPolicy};
use tomverse_core::CancellationRegistry;
use tomverse_core::{available_providers, credential_env, WorkspaceRoot, PROTOCOL_VERSION};

/// 이벤트를 stderr로 흘린다. stdout은 최종 결과 JSON 전용이므로 섞지 않는다 —
/// 호출자가 stdout을 그대로 파싱할 수 있어야 한다.
struct StderrSink {
    verbose: bool,
}

impl EventSink for StderrSink {
    fn emit(&self, channel: &str, payload: &Value) {
        if !self.verbose {
            // 조용한 모드에서도 phase 전이와 승인은 보여준다 — 그게 이 도구의 관측 지점이다.
            let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            let interesting = matches!(
                event_type,
                "PHASE_CHANGED"
                    | "APPROVAL_REQUESTED"
                    | "APPROVAL_GRANTED"
                    | "APPROVAL_DENIED"
                    | "VERIFICATION_COMPLETED"
                    | "TASK_COMPLETED"
                    | "TASK_FAILED"
                    | "TASK_CANCELLED"
                    | "TASK_REJECTED"
            );
            if !interesting {
                return;
            }
        }
        eprintln!("[{channel}] {payload}");
    }
}

#[derive(Clone)]
struct Args {
    command: String,
    workspace: PathBuf,
    message: String,
    task_id: Option<String>,
    mode: ExecutionMode,
    approve: String,
    db: Option<PathBuf>,
    artifacts: Option<PathBuf>,
    sidecar: Option<PathBuf>,
    auto_approve_writes: bool,
    auto_approve_verification: bool,
    /// 무인 실행의 시한(초) — state-machine 39절. `None`이면 상한이 없다.
    ///
    /// **`--timeout-secs`와 다른 값이다.** 저쪽은 호스트가 기다리기를 그만두는 시각이고,
    /// 이쪽은 태스크가 멈추는 시각이다(39.2절).
    deadline_secs: Option<u64>,
    allow_git_commit: bool,
    /// 이 태스크의 예산 상한(USD). `None`이면 **상한 없이** 돈다.
    ///
    /// 헤드리스 호스트의 기본값이 "상한 없음"인 이유: 이 바이너리를 쓰는 것은 e2e와 가설
    /// 게이트이고, 둘 다 자기 예산 통제를 따로 갖는다(게이트는 Run Card와 원장). 여기에
    /// 기본 상한을 넣으면 그 통제 위에 우리가 모르는 두 번째 상한이 얹힌다.
    /// **UI 경로의 기본값은 이것과 다르다** — 거기서는 상한 없음이 명시적 선택이어야 한다.
    budget_usd: Option<f64>,
    /// 역할별 모델 지정 (multi-engine-routing.md 15절). `executor`/`reviewer`만 지정할 수 있다 —
    /// 대조용 두 번째 실행자는 **primary와 다른 것이 유일한 일**이므로 고르게 두지 않는다.
    pin_executor: Option<String>,
    pin_reviewer: Option<String>,
    timeout_secs: u64,
    verbose: bool,
    /// 시나리오 A용: 실행 시작 후 N ms 뒤에 스스로 취소를 요청한다.
    ///
    /// 테스트 편의 기능이지만, **실행되는 취소 경로는 실제 경로와 동일하다** —
    /// 같은 registry, 같은 토큰, 같은 프로세스 트리 종료 코드를 탄다. 별도 mock이 아니다.
    cancel_after_ms: Option<u64>,
    /// 격리 실행: 이 브랜치의 worktree를 만들고 **그 경로를 워크스페이스 루트로 쓴다**
    /// (multi-engine 없음 — product-strategy 8.2절, worktree.rs).
    ///
    /// 별도의 우회 규칙을 두지 않는 것이 요점이다. 루트가 바뀌면 Policy Gate는 자기가
    /// worktree 안에 있는지조차 알 필요가 없다.
    worktree: Option<String>,
    /// 격리 실행에서 브랜치를 새로 만들 때의 출발점. 브랜치가 이미 있으면 무시된다.
    worktree_base: Option<String>,
    /// `worktree` 하위 명령에서 커밋되지 않은 변경을 **버리고** 지운다.
    force: bool,
    /// 등록된 MCP 서버 (`이름=프로그램[,인자...]`, 반복 가능) — mcp.rs.
    ///
    /// **셸 문자열이 아니라 쉼표로 나눈 argv다**(원칙 6). 등록은 사용자만 할 수 있다 —
    /// 모델이 서버를 추가하는 경로는 없으며, 그것이 이 기능의 안전 모델 전부다.
    mcp_servers: Vec<tomverse_core::mcp::McpServerConfig>,
    /// `--mcp-tools 이름=도구...` — 등록된 서버의 도구를 좁힌다 (32절).
    ///
    /// **서버 등록과 따로 받는 이유**는 구분자다. `--mcp-server`의 쉼표는 argv를 나누므로,
    /// 같은 자리에 도구 이름을 이어 붙이면 둘이 구별되지 않는다.
    mcp_tool_allowlists: Vec<(String, Vec<String>)>,
    hooks: Vec<tomverse_core::hooks::HookConfig>,
    skill: Option<PathBuf>,
    session_id: Option<String>,
    /// `decisions`/`withdraw` 전용 — 거둘 판정의 id (30절).
    ///
    /// **`--task`와 함께 쓴다.** `acceptance_criteria`의 키가 `(task_id, criterion_id)`이므로
    /// id 하나는 세션 안에서 유일하지 않고, 그것만으로 가리키면 엉뚱한 판정을 거둔다.
    criterion_id: Option<String>,
    /// 철회 사유 (선택). 사용자가 자유 입력하는 텍스트라 저장 직전 마스킹을 지난다.
    reason: Option<String>,
    remote: String,
    base: String,
    /// `metrics` 전용: 워크스페이스 필터를 끄고 DB 전체를 집계한다.
    all_workspaces: bool,
    /// `windows-landing` 전용 — tauri 번들 디렉터리.
    bundle: Option<PathBuf>,
    /// `windows-landing` 전용 — **사람이 확인한 항목의 기록**(landing_attest.rs).
    ///
    /// 도구가 자동으로 만들지 않는다. 사람이 확인한 것을 사람이 적는 것이 이 기록의 전부이며,
    /// 도구가 스스로 채우면 그 순간 아무것도 증명하지 않는다.
    attest: Option<PathBuf>,

    // ---- 가설 게이트(evals/hypothesis-gate) 전용 ----
    //
    // 이 세 옵션은 **arm 구성만 바꾸고 실행 경로는 그대로 둔다.** 하네스가 별도 파이프라인을
    // 만들면 "production이 이렇게 동작한다"를 측정하지 못하므로, 같은 Policy Gate·Tool
    // Runtime·Verification Runner를 태우면서 무엇을 비교할지만 지정할 수 있게 한다.
    /// 후보 공급자를 이 목록으로 제한한다.
    ///
    /// arm A/B("단독")를 만드는 **정당한** 방법이다: 공급자가 하나면 라우터의 검수자 독립성
    /// 불변식이 reviewer를 스스로 드롭하고 그 사유를 `appliedPolicies`에 남긴다.
    /// reviewer를 억지로 끄는 별도 분기를 만들지 않아도 된다.
    providers: Option<Vec<String>>,
    /// `blind` | `informed` — 검수자가 초안 작성자의 자기설명을 보는지.
    review_mode: Option<String>,
    /// 초안을 새로 생성하지 않고 이 파일의 `DraftProposal`을 쓴다.
    /// **파일을 읽는 것은 Rust다** — sidecar는 경로를 받지도 않는다.
    replay_draft: Option<PathBuf>,

    // ---- reproduce 전용 ----
    /// 검사할 export 파일. **태스크 id가 아니라 파일이다** — 재현을 돌리는 사람에게는
    /// 대개 DB가 없고, 그래서 export가 있는 것이다.
    file: Option<PathBuf>,
    /// 불일치를 넘기 위해 사용자가 명시하는 **기대 지문**. 플래그 하나로는 넘을 수 없다.
    accept_fingerprint: Option<String>,
    /// 검사에 그치지 않고 **적용한다.** 기본값이 검사인 이유: 쓰는 쪽이 기본이면 실수의 대가가
    /// 워크스페이스에 남는다.
    apply: bool,

    // ---- fleet 전용 (fleet.rs, process-architecture 11.6절) ----
    /// `--member <branch>=<요청>` — 구성원 하나. **N개를 주는 것은 사용자다**(8.2절: 작업
    /// 분해는 이후 깊이 확장 열이다).
    fleet_members: Vec<tomverse_core::fleet::MemberSpec>,
    /// Fleet **합계** 상한(USD). 태스크당 상한(`--budget-usd`)과 **별개다.**
    fleet_budget_usd: Option<f64>,
    /// 합계 상한 없음을 **명시**했는가. `budget.rs`와 같은 규칙 — 말하지 않은 것을 "없음의
    /// 선택"으로 읽지 않는다.
    fleet_budget_unlimited: bool,
    /// Fleet id. 주지 않으면 만든다 — 기록에서 이 Fleet을 다시 찾는 열쇠다.
    fleet_id: Option<String>,
    /// **Fleet 전체**를 N ms 뒤에 취소한다. 구성원 하나를 취소하는 것과 **다른 요청**이므로
    /// 플래그도 다르다(둘을 한 손잡이로 합치지 않는다).
    ///
    /// `--cancel-after-ms`와 같은 성질의 테스트 편의 기능이지만, **실행되는 취소 경로는 실제
    /// 경로와 동일하다** — 같은 registry, 같은 `TaskHost::cancel_task`, 같은 `task.cancel`.
    /// 화면이 붙으면 그 버튼이 여기와 같은 함수를 부른다.
    cancel_fleet_after_ms: Option<u64>,
    /// `--cancel-member-after-ms <branch>=<ms>` — **구성원 하나만** 취소한다.
    cancel_member_after_ms: Vec<(String, u64)>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tomverse_core::types::{TaskPolicy, ToolName, ToolRequest};

    /// 파싱을 거치지 않고 만드는 최소 `Args`. **`parse_args`의 기본값을 복사하지 않는다** —
    /// 여기서 보는 것은 `command`와 `skill` 둘뿐이고, 나머지를 베껴 두면 기본값이 바뀔 때
    /// 이 사본만 낡는다.
    fn args_for(command: &str) -> Args {
        parse_args_from(vec![command.to_string()].into_iter()).expect("args")
    }

    /// **질문은 읽기 전용으로 좁혀진다** — 51절.
    ///
    /// 경로가 `EXECUTING`을 지나지 않는다는 것은 Node의 성질이고, 장악당한 Node는 그 경로를
    /// 우회할 수 있다. 게이트에 꽂히는 목록이 그때의 보장이다(원칙 2).
    #[test]
    fn a_question_is_narrowed_to_read_only_tools() {
        let allowed = allowed_tools_for(&args_for("ask"), None).expect("좁혀지지 않았습니다");
        assert!(!allowed.is_empty());
        for tool in &allowed {
            assert!(tool.is_read_only(), "{}가 읽기 전용이 아닙니다", tool.as_str());
            assert!(!tool.mutates_files(), "{}가 파일을 바꿉니다", tool.as_str());
        }
        // **`run_tests`를 남기지 않는다.** 스킬 파싱은 검증 명령을 강제로 남기지만(26절),
        // 질문 경로에는 `VERIFYING`이 아예 없으므로 남기면 답 하나에 사용자의 테스트가 돈다.
        assert!(!allowed.contains(&ToolName::RunTests), "{allowed:?}");
    }

    /// 그리고 그 목록이 **게이트에서 실제로 막는다.** 목록만 만들고 꽂지 않으면 아무 일도 없다.
    #[test]
    fn the_gate_denies_a_write_under_a_question_policy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "x").unwrap();
        let root = tomverse_core::paths::WorkspaceRoot::new(dir.path()).unwrap();
        let policy = TaskPolicy {
            allowed_tools: allowed_tools_for(&args_for("ask"), None),
            ..TaskPolicy::default()
        };
        let gate = tomverse_core::policy::PolicyGate::new(&policy);
        let request = ToolRequest {
            request_id: "r".to_string(),
            task_id: "t".to_string(),
            tool: ToolName::ApplyPatch,
            args: serde_json::json!({ "path": "a.ts", "patch": "" }),
            risk_tier: None,
            requested_by: serde_json::json!({}),
            created_at: None,
            injected_env: Default::default(),
        };
        let decision = gate.evaluate(&request, &root, &policy);
        assert_eq!(decision.matched_rule, "tool_not_in_skill_allowlist", "{decision:?}");

        // 읽기는 지난다 — 위 단언이 "전부 막는다"가 아니라는 증거다.
        let read = ToolRequest { tool: ToolName::ReadFile, args: serde_json::json!({ "path": "a.ts" }), ..request };
        assert_ne!(
            gate.evaluate(&read, &root, &policy).matched_rule,
            "tool_not_in_skill_allowlist"
        );
    }

    /// `run`은 종전과 한 글자도 다르지 않다 — 기본값이 동작을 바꾸지 않는다.
    #[test]
    fn a_change_task_is_not_narrowed() {
        assert_eq!(allowed_tools_for(&args_for("run"), None), None);
    }
}

fn parse_args() -> Result<Args, String> {
    parse_args_from(std::env::args().skip(1))
}

/// **인자원을 받는다.** `std::env::args()`를 직접 읽으면 이 파서를 테스트할 방법이 없고,
/// 그러면 기본값이 조용히 바뀌어도 드러나지 않는다.
fn parse_args_from(raw: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut raw = raw;
    let command = raw.next().ok_or_else(usage)?;

    let mut args = Args {
        command,
        workspace: PathBuf::from("."),
        message: String::new(),
        task_id: None,
        mode: ExecutionMode::Verified,
        approve: "auto".to_string(),
        db: None,
        artifacts: None,
        sidecar: None,
        auto_approve_writes: false,
        auto_approve_verification: false,
        deadline_secs: None,
        allow_git_commit: false,
        budget_usd: None,
        pin_executor: None,
        pin_reviewer: None,
        timeout_secs: 600,
        verbose: false,
        cancel_after_ms: None,
        mcp_servers: Vec::new(),
        mcp_tool_allowlists: Vec::new(),
        hooks: Vec::new(),
        skill: None,
        session_id: None,
        criterion_id: None,
        reason: None,
        remote: "origin".to_string(),
        base: "main".to_string(),
        worktree: None,
        worktree_base: None,
        force: false,
        all_workspaces: false,
        bundle: None,
        attest: None,
        providers: None,
        review_mode: None,
        replay_draft: None,
        file: None,
        accept_fingerprint: None,
        apply: false,
        fleet_members: Vec::new(),
        fleet_budget_usd: None,
        fleet_budget_unlimited: false,
        fleet_id: None,
        cancel_fleet_after_ms: None,
        cancel_member_after_ms: Vec::new(),
    };

    while let Some(flag) = raw.next() {
        let mut value = || raw.next().ok_or_else(|| format!("{flag}에 값이 필요합니다"));
        match flag.as_str() {
            "--workspace" => args.workspace = PathBuf::from(value()?),
            "--message" => args.message = value()?,
            "--task" => args.task_id = Some(value()?),
            "--mode" => {
                args.mode = match value()?.as_str() {
                    "fast" => ExecutionMode::Fast,
                    "verified" => ExecutionMode::Verified,
                    other => return Err(format!("알 수 없는 --mode: {other} (fast|verified)")),
                }
            }
            "--approve" => args.approve = value()?,
            "--worktree" => args.worktree = Some(value()?),
            "--member" => args.fleet_members.push(parse_member(&value()?)?),
            "--fleet" => args.fleet_id = Some(value()?),
            "--fleet-budget-usd" => {
                let raw = value()?;
                args.fleet_budget_usd = Some(
                    raw.parse::<f64>()
                        .map_err(|_| format!("--fleet-budget-usd는 수여야 합니다: {raw}"))?,
                )
            }
            "--fleet-budget-unlimited" => args.fleet_budget_unlimited = true,
            "--cancel-fleet-after-ms" => {
                let raw = value()?;
                args.cancel_fleet_after_ms =
                    Some(raw.parse::<u64>().map_err(|_| format!("--cancel-fleet-after-ms: {raw}"))?)
            }
            "--cancel-member-after-ms" => args.cancel_member_after_ms.push(parse_member_delay(&value()?)?),
            "--worktree-base" => args.worktree_base = Some(value()?),
            "--force" => args.force = true,
            "--mcp-server" => args.mcp_servers.push(parse_mcp_server(&value()?)?),
            "--mcp-tools" => args.mcp_tool_allowlists.push(parse_mcp_tools(&value()?)?),
            "--hook" => args.hooks.push(parse_hook(&value()?)?),
            "--skill" => args.skill = Some(PathBuf::from(value()?)),
            "--session" => args.session_id = Some(value()?),
            "--criterion" => args.criterion_id = Some(value()?),
            "--reason" => args.reason = Some(value()?),
            "--remote" => args.remote = value()?,
            "--base" => args.base = value()?,
            "--db" => args.db = Some(PathBuf::from(value()?)),
            "--artifacts" => args.artifacts = Some(PathBuf::from(value()?)),
            "--sidecar" => args.sidecar = Some(PathBuf::from(value()?)),
            "--auto-approve-writes" => args.auto_approve_writes = true,
            "--auto-approve-verification" => args.auto_approve_verification = true,
            "--deadline-secs" => {
                let secs: u64 = value()?
                    .parse()
                    .map_err(|_| "--deadline-secs는 정수여야 합니다".to_string())?;
                // **0을 받지 않는다.** "즉시 멈춘다"를 시한으로 적을 이유가 없고, 받으면
                // 시작하자마자 멈추는 실행이 정상 동작처럼 보인다.
                if secs == 0 {
                    return Err("--deadline-secs는 1 이상이어야 합니다".to_string());
                }
                args.deadline_secs = Some(secs);
            }
            "--allow-git-commit" => args.allow_git_commit = true,
            "--pin-executor" => args.pin_executor = Some(value()?),
            "--pin-reviewer" => args.pin_reviewer = Some(value()?),
            "--budget-usd" => {
                let text = value()?;
                let parsed: f64 = text
                    .parse()
                    .map_err(|_| format!("--budget-usd 값이 수가 아닙니다: {text}"))?;
                if !parsed.is_finite() || parsed <= 0.0 {
                    return Err(format!("--budget-usd는 0보다 큰 유한한 수여야 합니다: {text}"));
                }
                args.budget_usd = Some(parsed);
            }
            "--timeout-secs" => {
                args.timeout_secs = value()?
                    .parse()
                    .map_err(|_| "--timeout-secs는 정수여야 합니다".to_string())?
            }
            "--cancel-after-ms" => {
                args.cancel_after_ms = Some(
                    value()?
                        .parse()
                        .map_err(|_| "--cancel-after-ms는 정수여야 합니다".to_string())?,
                )
            }
            "--providers" => {
                args.providers = Some(
                    value()?
                        .split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect(),
                )
            }
            "--review-mode" => {
                let mode = value()?;
                if mode != "blind" && mode != "informed" {
                    return Err(format!("알 수 없는 --review-mode: {mode} (blind|informed)"));
                }
                args.review_mode = Some(mode);
            }
            "--replay-draft" => args.replay_draft = Some(PathBuf::from(value()?)),
            "--file" => args.file = Some(PathBuf::from(value()?)),
            "--accept-fingerprint" => args.accept_fingerprint = Some(value()?),
            "--apply" => args.apply = true,
            "--verbose" => args.verbose = true,
            "--all-workspaces" => args.all_workspaces = true,
            "--bundle" => args.bundle = Some(PathBuf::from(value()?)),
            "--attest" => args.attest = Some(PathBuf::from(value()?)),
            other => return Err(format!("알 수 없는 인자: {other}\n\n{}", usage())),
        }
    }
    Ok(args)
}

/// `reproduce` — export 파일이 이 워크스페이스에 재현되는지 **검사**하고, `--apply`면 적용한다.
///
/// 판정 규칙은 `tomverse_core::reproduce` 모듈 주석에 있다. 검사는 아무것도 쓰지 않는다.
/// 적용은 파일을 쓰지만 **DB는 열지 않는다** — 재현은 태스크가 아니고, 태스크 상태를 바꾸지도
/// 않는다. 여는 순간 감사자의 머신에 없던 state.db가 생긴다.
fn reproduce_check(args: &Args, root: &WorkspaceRoot) -> Result<i32, String> {
    let path = args
        .file
        .clone()
        .ok_or_else(|| "reproduce에는 --file <export.json>이 필요합니다".to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path:?}를 읽을 수 없습니다: {e}"))?;
    // **파일은 밖에서 온다.** 파싱 실패를 빈 계획으로 넘기지 않는다 — 빈 계획은
    // "재현할 것이 없다"로 읽히고, 그건 "읽지 못했다"와 다른 사실이다.
    let export: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{path:?}가 JSON이 아닙니다: {e}"))?;

    let out = if args.apply {
        // pre-image가 여기 쌓인다 — 적용기가 스스로 되돌리지 않으므로 이게 되돌리기 재료다.
        let artifacts_root = args.artifacts.clone().unwrap_or_else(ArtifactStore::default_root);
        let artifacts = ArtifactStore::new(&artifacts_root).map_err(|e| format!("artifact 저장소 오류: {e}"))?;
        let approve_all = args.approve == "auto";
        let options = tomverse_core::reproduce::ApplyOptions {
            root: root.clone(),
            artifacts,
            policy: TaskPolicy {
                auto_approve_workspace_writes: args.auto_approve_writes,
                allow_git_commit: args.allow_git_commit,
                execution_mode: args.mode,
                ..TaskPolicy::default()
            },
            // 재현이라고 해서 승인이 면제되지 않는다. **기록에 있다는 것은 승인 근거가 아니다.**
            approve: &|_req, _decision| approve_all,
            run_id: format!("repro-{}", uuid::Uuid::new_v4()),
        };
        tomverse_core::reproduce::apply(&export, &options, args.accept_fingerprint.as_deref())?
    } else {
        tomverse_core::reproduce::check(
            &export,
            std::path::Path::new(&root.display()),
            args.accept_fingerprint.as_deref(),
        )?
    };
    // export와 같은 이유로 pretty다 — 사람이 읽고 무엇을 맞춰야 하는지 판단하는 것이 용도다.
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    Ok(0)
}

fn usage() -> String {
    "usage: tomverse-host <run|ask|rollback|revert|pr|recover|tasks|show|blocked|autopilot-preview|decisions|withdraw|metrics|transmission|export|reproduce|worktree|fleet|fleet-status|windows-landing> --workspace <path> [--message <text>] \
     [--task <id>] [--mode fast|verified] [--approve auto|deny|autopilot] [--db <path>] [--artifacts <path>] \
     [--sidecar <index.js>] [--skill <파일.json>] [--session <id>]\n\
     [--auto-approve-writes] [--auto-approve-verification]\n\
     [--allow-git-commit] [--cancel-after-ms <n>] [--deadline-secs <n>]\n\
     [--budget-usd <n>] [--pin-executor <modelId>] [--pin-reviewer <modelId>] [--verbose]\n\
     \n\
     가설 게이트 전용: [--providers <csv>] [--review-mode blind|informed] [--replay-draft <file>]\n\
     \n\
     run --worktree <branch> — 격리 실행. 그 브랜치의 worktree를 만들고 **그 경로를 워크스페이스\n\
                 루트로 쓴다**. 브랜치가 없으면 만들고, 출발점은 [--worktree-base <ref>].\n\
                 본체의 커밋되지 않은 변경은 따라오지 않으며 그 사실을 stderr로 알린다\n\
     run --hook <phase=프로그램[,인자...]> — phase 전환 훅 등록(반복 가능). **셸 문자열이 아니라\n\
                 쉼표로 나눈 argv다.** 등록한 argv 그대로 Policy Gate를 지나 실행되며,\n\
                 **실패해도 태스크의 판정을 바꾸지 않는다**(훅은 관찰자다). 걸 수 있는 phase는\n\
                 PLANNING/EXECUTING/VERIFYING/COMPLETED/FAILED/CANCELLED\n\
     run --session <id> — 이 세션에 붙는다. 같은 세션의 앞선 태스크에서 **사용자가 정한 것**이\n\
                 이번 프롬프트에 실린다(모델 제안은 실리지 않는다). 생략하면 새 세션이다\n\
     run --skill <파일.json> — 스킬 적용. 지시문(프롬프트에 실린다)·도구 허용목록(게이트가\n\
                 좁힌다)·역할별 모델 지정을 담는다. **허용목록은 좁히기만 하며**, 적지 않아도\n\
                 검증 명령은 남는다. 명시한 --pin-* 가 스킬의 모델 지정을 이긴다\n\
     run --mcp-server <이름=프로그램[,인자...]> — MCP 서버 등록(반복 가능). **셸 문자열이 아니라\n\
                 쉼표로 나눈 argv다.** 그 도구는 `mcp_call`로 변환되어 Policy Gate를 지나며,\n\
                 **언제나 사용자 승인을 요구한다**(정책으로 낮출 수 없다). 등록하면 그 서버의\n\
                 도구 목록이 프롬프트에 실리고, 초안이 요청하면 실행한 뒤 결과와 함께 다시 그린다\n\
     run --mcp-tools <이름=도구1[,도구2...]> — 그 서버에서 부를 수 있는 도구를 좁힌다(반복 가능).\n\
                 **목록 밖의 도구는 승인을 묻지도 않고 거부된다.** 프롬프트에 실리는 목록도\n\
                 함께 좁아진다 — 보여주는 집합과 부를 수 있는 집합은 같아야 한다\n\
     --approve autopilot — **무인 실행.** 정책이 자동 허용하는 것만 진행하고, 승인이 필요한\n\
                 지점에 닿으면 멈춘다(대신 승인해 주지 않는다). `auto`는 전부 승인하는\n\
                 **테스트 전용** 모드이며 Autopilot이 아니다\n\
     --auto-approve-verification — 프로젝트가 매니페스트에 **선언해 둔** 검증 명령을 묻지 않고\n\
                 실행한다. 집합은 태스크 시작 시점에 고정된다 — 실행 중에 매니페스트가 바뀌어도\n\
                 새 명령은 자동 승인되지 않는다. Autopilot이 검증까지 도달하려면 이게 필요하다\n\
     --deadline-secs <n> — **태스크가 멈추는 시각.** 지나면 우리가 대신 취소를 누르고, 왜\n\
                 멈췄는지를 기록에 남긴다(사용자 취소와 다른 사유다). 무인 실행에 \"언제까지\"를\n\
                 주는 값이며, 주지 않으면 상한 없이 돈다. `--timeout-secs`와 다르다 —\n\
                 저쪽은 호스트가 **기다리기를 그만두는** 시각이지 태스크가 멈추는 시각이 아니다\n\
     worktree — 격리 트리 목록(JSON). [--worktree <branch>]를 주면 그 트리를 정리한다.\n\
                 커밋되지 않은 변경이 있으면 지우지 않고 사유를 낸다 — 버리려면 [--force]\n\
     fleet --member <branch>=<요청> (반복) — **N개 병렬 실행.** 구성원마다 격리 트리를 하나씩\n\
                 만들고, 각각은 자기 트리를 게이트 루트로 받는 **평범한 태스크**가 된다.\n\
                 크기 상한 8. 결말은 구성원별로 보고되며 부분 실패를 성공으로 접지 않는다\n\
     fleet --fleet-budget-usd <n> | --fleet-budget-unlimited — **합계 상한.** 태스크당 상한\n\
                 (--budget-usd)과 별개이며, 둘 중 하나만으로는 총지출이 통제되지 않는다.\n\
                 합계 상한을 걸려면 태스크당 상한도 있어야 한다(예약할 금액을 알아야 한다).\n\
                 남은 예산으로 태스크당 상한을 예약할 수 없으면 **새 구성원을 시작하지 않는다**\n\
     fleet --cancel-fleet-after-ms <n> / --cancel-member-after-ms <branch>=<n> —\n\
                 **전체 취소와 하나 취소는 다른 요청이다.** 손잡이를 합치지 않는다\n\
     fleet-status [--fleet <id>] — 기록에서 Fleet 구성원과 합계 지출을 읽는다. DB만 본다 —\n\
                 크래시 후 \"무엇이 돌고 있었나\"의 답은 프로세스가 아니라 이벤트에 있다\n\
     ask     — 질문에 답한다(--message). **파일을 바꾸지 않는다** — 계획도 실행도 검증도\n\
                 하지 않고 모델을 한 번 부른다. 도구는 읽기 전용으로 좁혀 게이트에 꽂히므로,\n\
                 sidecar가 장악당해도 이 태스크는 파일을 바꿀 수 없다. `COMPLETED`가 아니라\n\
                 `ANSWERED`로 끝난다 — 답변은 완료가 아니다(51절)\n\
     plan    — 계획만 낸다(--message). **파일도 patch도 만들지 않는다** — `ask`와 같은 자리이고\n\
                 도구도 같이 읽기 전용으로 좁힌다. `COMPLETED`가 아니라 `OUTLINED`로 끝나며\n\
                 `ANSWERED`와도 다르다: 계획을 읽은 사용자의 다음 걸음은 \"그럼 해 줘\"이고\n\
                 그건 새 태스크다(53절)\n\
     recover — 앱 재시작 시나리오: 터미널이 아닌 태스크를 INTERRUPTED로 확정한다\n\
     pr      — 현재 브랜치를 remote로 올리고 **PR 생성 폼 URL**을 낸다. [--remote origin]\n\
                 [--base main]. **우리는 GitHub에 요청을 보내지 않는다** — 폼을 여는 것은\n\
                 사용자의 브라우저이고 우리는 URL 한 줄을 낼 뿐이다(토큰이 필요 없다).\n\
                 push는 언제나 승인을 요구하며 `--force`는 만들 방법이 없다\n\
     blocked — 무인 정지의 처방(JSON). 무엇이 막았고 **무엇을 켜면 지나가는지**, 그리고\n\
                 어떤 정지는 정책으로 열 수 없는지를 기록에서 유도한다. 아무것도 쓰지 않는다.\n\
                 이번 실행이 도달한 지점까지만 안다 — 켜고 다시 돌리면 더 진행하다 또 멈출 수 있다\n\
     autopilot-preview — 그 반대 방향(JSON). **돌리기 전에** 지금 스위치로 무엇이 사람 없이\n\
                 일어나고 무엇이 멈추는지를 게이트에 물어 답한다. 산문이 아니라 판정이므로\n\
                 게이트가 바뀌면 함께 바뀐다. DB도 워크스페이스도 건드리지 않는다.\n\
                 위 플래그들을 그대로 받는다 — `run`과 **같은 함수**로 정책을 만든다\n\
     decisions — 이 세션에서 사용자가 정한 것 목록 (읽기 전용, --session 필요). **거둔 것도 나온다** —\n\
                 목록에서까지 지우면 '사라졌다'와 '거뒀다'가 같은 모양이 된다\n\
     withdraw — 앞선 판정을 거둔다 (--session --task --criterion [--reason]). 바뀌는 것은\n\
                 **다음 태스크로 나르는가** 하나뿐이며, 그 태스크의 기준 기록은 그대로 남는다.\n\
                 진행 중인 태스크의 기준은 거둘 수 없다 (0=거둠, 1=거두지 않음)\n\
     tasks   — 저장된 작업 목록을 JSON으로 출력한다\n\
     show    — 한 작업의 상태·이벤트·mutation·검증 기록을 JSON으로 출력한다\n\
     transmission — 이 작업에서 무엇이 어느 공급자로 나갔는지 (읽기 전용, --task 필요)\n\
     export  — 한 작업의 감사 기록을 형식 버전이 붙은 JSON으로 출력한다 (읽기 전용, --task 필요).\n\
                show와 다르다 — 도구 argv·patch 원문과 보장 범위가 파일 안에 들어 있다\n\
     revert  — 이 작업이 만든 커밋을 git revert로 되돌린다 (0=되돌림, 1=되돌리지 않음·저장소 그대로, 2=revert 진행 중으로 남음)\n\
     metrics — 기준 계측(커버리지/충돌 결말)을 JSON으로 집계한다. 읽기 전용.\n\
               [--all-workspaces]로 워크스페이스 필터를 끈다\n\
     reproduce — export 파일(--file)을 이 워크스페이스에 재현할 수 있는지 **검사한다**.\n\
                 아무것도 쓰지 않으므로 전제가 무엇이든 거부하지 않는다. DB도 열지 않는다.\n\
                 판정은 종료 코드가 아니라 JSON에 있다 — 종료 코드에 실으면 '오류'와\n\
                 '재현 불가'가 같은 값이 된다. 적용기는 아직 없다.\n\
                 [--accept-fingerprint <sha256:...>]로 불일치를 확인해 넘긴다\n\
                 [--apply]면 실제로 적용한다 — 각 단계는 Policy Gate를 그대로 지나고,\n\
                 첫 실패에서 멈추며, 스스로 되돌리지는 않는다(보고의 preImageRef가 재료다).\n\
                 판정은 '단계가 다 돌았다'(completed)가 아니라 기록된 최종 내용과의\n\
                 대조(outcome)다\n\
     windows-landing — Windows에서만 확인되는 착지 기준(Job Object·번들·Credential Store)을\n\
                 판정한다. 읽기 전용이고 DB도 열지 않는다. **확인하지 못한 것을 통과로 세지\n\
                 않는다** — 사람이 해야 하는 단계는 remaining에 남는다.\n\
                 [--bundle <경로>]로 tauri-build 산출물을 가리키면 번들 기준까지 본다.\n\
                 [--attest <파일>]로 **사람이 확인한 기록**을 읽는다 — 무엇을, 어느 머신에서\n\
                 (OS 빌드·Node·VS·git 설정·Python 유무), 어느 커밋에서 확인했는지가 들어 있다.\n\
                 **커밋이 바뀌면 만료된다**(옛 확인이 새 코드를 통과시키면 안 된다). 관측된\n\
                 `failed`와 아직 만들지 않은 기능은 덮지 못하고, 기록된 머신에 없는 것으로\n\
                 확인했다는 줄도 통과시키지 않는다. 만들어 주는 명령은 없다 — 사람이 적는다"
        .to_string()
}

fn main() {
    match real_main() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("error: {message}");
            std::process::exit(2);
        }
    }
}

/// `이름=프로그램[,인자...]`를 서버 등록으로 읽는다.
///
/// 쉼표로 argv를 나누는 이유: 셸 문자열을 받으면 승인 화면에 보인 것과 실제 실행되는 것이
/// 갈라진다(원칙 6). 쉼표가 인자에 들어가야 하는 서버는 이 CLI로 등록할 수 없다 —
/// **못 하는 것을 조용히 추측해서 하지 않는다**(설정 파일이 생기면 그때 넓힌다).
/// `--hook <phase>=<프로그램>[,인자...]`.
///
/// **셸 문자열이 아니라 쉼표로 나눈 argv다**(원칙 6). `--mcp-server`와 같은 모양으로 둔 이유는
/// 사용자가 두 가지 등록 문법을 외우지 않게 하기 위해서다 — 그리고 같은 한계도 공유한다:
/// 쉼표가 든 인자는 등록할 수 없다(설정 파일이 생기면 그때 넓힌다).
fn parse_hook(spec: &str) -> Result<tomverse_core::hooks::HookConfig, String> {
    let (phase, rest) = spec
        .split_once('=')
        .ok_or_else(|| format!("--hook 형식은 phase=프로그램[,인자...] 입니다: {spec}"))?;
    let mut parts = rest.split(',');
    let program = parts
        .next()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| format!("--hook에 프로그램이 없습니다: {spec}"))?;
    Ok(tomverse_core::hooks::HookConfig {
        phase: phase.trim().to_string(),
        program: program.to_string(),
        args: parts.map(str::to_string).collect(),
    })
}

fn parse_mcp_server(spec: &str) -> Result<tomverse_core::mcp::McpServerConfig, String> {
    let (name, rest) = spec
        .split_once('=')
        .ok_or_else(|| format!("--mcp-server 형식은 이름=프로그램[,인자...] 입니다: {spec}"))?;
    let mut parts = rest.split(',');
    let program = parts
        .next()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| format!("--mcp-server에 프로그램이 없습니다: {spec}"))?;
    Ok(tomverse_core::mcp::McpServerConfig {
        name: name.to_string(),
        program: program.to_string(),
        args: parts.map(str::to_string).collect(),
        env: Default::default(),
        // 허용목록은 **별도 플래그**로 받는다(`--mcp-tools`). 여기 쉼표 목록에 이어 붙이면
        // 인자와 도구 이름이 같은 구분자를 쓰게 되어 서로 구별되지 않는다.
        tools: None,
    })
}

/// `--member <branch>=<요청>` — Fleet 구성원 하나.
///
/// **`=`를 처음 한 번만 나눈다.** 요청 문장에 `=`가 들어가는 것은 흔하고, 거기서 또 나누면
/// 사용자가 적은 문장이 잘린 채 모델에게 간다 — 조용히 다른 요청이 되는 종류의 결함이다.
fn parse_member(spec: &str) -> Result<tomverse_core::fleet::MemberSpec, String> {
    let (branch, message) = spec
        .split_once('=')
        .ok_or_else(|| format!("--member 형식은 브랜치=요청 입니다: {spec}"))?;
    Ok(tomverse_core::fleet::MemberSpec {
        branch: branch.trim().to_string(),
        message: message.to_string(),
    })
}

/// `--cancel-member-after-ms <branch>=<ms>` — **구성원 하나만** 취소한다.
fn parse_member_delay(spec: &str) -> Result<(String, u64), String> {
    let (branch, ms) = spec
        .split_once('=')
        .ok_or_else(|| format!("--cancel-member-after-ms 형식은 브랜치=밀리초 입니다: {spec}"))?;
    let ms = ms
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("--cancel-member-after-ms의 밀리초가 수가 아닙니다: {spec}"))?;
    Ok((branch.trim().to_string(), ms))
}

/// `--mcp-tools 이름=도구1,도구2` — 그 서버에서 부를 수 있는 도구를 좁힌다 (32절).
fn parse_mcp_tools(spec: &str) -> Result<(String, Vec<String>), String> {
    let (name, rest) = spec
        .split_once('=')
        .ok_or_else(|| format!("--mcp-tools 형식은 이름=도구1[,도구2...] 입니다: {spec}"))?;
    let tools: Vec<String> = rest
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();
    if tools.is_empty() {
        // **빈 목록을 "전부 허용"으로 읽지 않는다.** 그렇게 읽으면 오타 하나가 좁히려던
        // 의도를 정반대로 뒤집는다.
        return Err(format!("--mcp-tools에 도구가 없습니다: {spec}"));
    }
    Ok((name.trim().to_string(), tools))
}

/// 격리 트리를 어디에 만드는가.
///
/// **저장소 안에 만들지 않는다** — 안에 만들면 부모 워크스페이스의 게이트 루트가 그것을
/// 포함해서, 본체에서 도는 태스크가 격리된 트리를 고칠 수 있다(worktree.rs 모듈 주석).
/// 상태 디렉터리(`--db`가 사는 곳) 아래에 둔다: 태스크 기록과 같은 수명이라 정리 시점도 같다.
///
/// **자리를 정하는 것은 `worktree::parent_dir`이다**(38절). 여기서 다시 이어붙이면 데스크톱과
/// 갈릴 수 있고, 갈리면 같은 브랜치로 트리가 둘 생긴다.
fn worktree_parent_dir(args: &Args) -> PathBuf {
    let state_dir = args
        .db
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| args.workspace.join(".tomverse"));
    tomverse_core::worktree::parent_dir(&state_dir)
}

fn real_main() -> Result<i32, String> {
    let args = parse_args()?;

    // **격리 실행은 루트를 바꾸는 것이 전부다.** worktree를 만들고 그 경로를 루트로 준다 —
    // Policy Gate에 "worktree 모드"라는 분기를 만들지 않는다. 분기를 만들면 그 분기가 곧
    // 우회 지점이 되고, 게이트가 두 가지 규칙을 갖게 된다.
    // **`run`에서만 격리 트리를 만든다.** `worktree` 하위 명령에서 `--worktree <branch>`는
    // "이걸 정리하라"는 뜻이므로, 여기서 만들면 지우려던 사람이 트리를 새로 만들게 된다
    // (실제로 그랬다 — 정리 명령이 "새로 만듦"을 찍었다).
    let isolated = match args.worktree.as_ref().filter(|_| args.command == "run") {
        Some(branch) => {
            let repo = WorkspaceRoot::new(&args.workspace)
                .map_err(|e| format!("워크스페이스 {:?}를 열 수 없습니다: {e}", args.workspace))?;
            let parent = worktree_parent_dir(&args);
            let wt = tomverse_core::worktree::ensure(repo.path(), &parent, branch, args.worktree_base.as_deref())
                .map_err(|e| e.to_string())?;
            // **말하지 않으면 사용자가 정반대로 읽는 것들**(22.5절). 문장은 `Isolation`이
            // 만든다 — 헤드리스와 데스크톱이 각자 조건을 적으면 한쪽 사용자만 듣게 된다.
            let iso = tomverse_core::worktree::Isolation::of(repo.path(), &wt);
            eprintln!(
                "격리 실행: {} ({}) — {}",
                wt.path.display(),
                wt.branch,
                if wt.created { "새로 만듦" } else { "기존 트리 재사용" }
            );
            for notice in iso.notices() {
                eprintln!("{notice}");
            }
            Some(iso)
        }
        None => None,
    };

    // **격리는 게이트 루트만 바꾼다**(38절). 신원(workspace_id)은 저장소를 따라간다 —
    // 여기서는 태스크가 하나뿐이라 차이가 드러나지 않지만, 규칙을 두 곳에 적지 않는다.
    let workspace_path = tomverse_core::worktree::roots(&args.workspace, isolated.as_ref()).gate;
    let root = WorkspaceRoot::new(&workspace_path)
        .map_err(|e| format!("워크스페이스 {workspace_path:?}를 열 수 없습니다: {e}"))?;

    // **환경이 만드는 한계는 여는 자리에서 말한다**(`unc.rs`, 55.4절). 격리 공지와 같은
    // 규율이다 — 문장은 core가 만들고 헤드리스와 데스크톱이 같은 것을 낸다. 각자 적으면
    // 한쪽만 조용해지고, 그 경로의 사용자는 경고를 못 받는다.
    if let Some(notice) = tomverse_core::unc::workspace_notice(
        tomverse_core::tools::program::Platform::current(),
        &root.display(),
    ) {
        eprintln!("{notice}");
    }

    // **재현 검사는 DB를 열지 않는다.** 감사자에게는 DB가 없다 — 그래서 export 파일이 있는
    // 것이고, 여기서 store를 열면 없던 state.db가 생긴다. "아무것도 쓰지 않는다"는 약속은
    // 그 파일 하나로 깨진다. 그래서 store를 만들기 **전에** 갈라진다.
    // **착지 검사도 DB를 열지 않는다.** 관측만 하고 아무것도 쓰지 않으므로, 여기서 store를
    // 열면 없던 state.db가 생긴다 — reproduce와 같은 이유로 store를 만들기 전에 갈라진다.
    if args.command == "windows-landing" {
        // **읽기와 판정을 나눈다.** 파일을 읽는 것(IO)만 여기서 하고, 만료·머신 사양·덮어쓸 수
        // 없는 상태의 판정은 전부 순수 함수 안에 있다 — 그래야 Windows 없이도 규칙을 테스트한다.
        let attestation = args.attest.as_deref().map(tomverse_core::landing_attest::read_file);
        // 지금 커밋. **만료 판정의 기준**이며, 읽지 못하면 attestation을 반영하지 않는다
        // (모르는 것을 통과로 세지 않는다). `read_only_git`은 인자를 allowlist로 막으므로
        // 이 경로가 저장소에 쓸 수 없다는 것이 구조로 확인된다.
        let head_commit = tomverse_core::reproduce::read_only_git(root.path(), &["rev-parse", "HEAD"])
            .ok()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty());
        let obs = tomverse_core::landing::Observations::here(args.bundle.clone())
            .with_attestation(head_commit, attestation);
        let report = tomverse_core::landing::assess(&obs);
        println!("{}", serde_json::to_string(&report).unwrap_or_default());
        // **판정을 종료 코드에 싣지 않는다.** 실으면 "도구가 실패했다"와 "아직 착지하지
        // 않았다"가 같은 값이 된다 — reproduce가 같은 이유로 그렇게 한다.
        return Ok(0);
    }

    if args.command == "reproduce" {
        return reproduce_check(&args, &root);
    }

    // **미리보기도 DB를 열지 않는다.** 승인 판정에 저장소가 필요하지 않으므로(47절), 여기서
    // store를 만들면 "무엇이 허용되는지 물어봤을 뿐"인 명령이 없던 state.db를 남긴다 —
    // reproduce·windows-landing과 같은 이유로 store를 만들기 전에 갈라진다.
    if args.command == "autopilot-preview" {
        let skill = load_skill(&args, &root)?;
        let profile = tomverse_core::host::TaskProfile::new(&root, task_policy_from(&args, skill.as_ref()));
        let hooks = tomverse_core::hooks::HookRegistry::new(args.hooks.clone());
        let report = tomverse_core::autopilot::preview(&root, &profile, &hooks);
        println!("{}", serde_json::to_string(&report).unwrap_or_default());
        // **판정을 종료 코드에 싣지 않는다.** "멈추는 곳이 있다"는 실패가 아니라 사실이다 —
        // reproduce·windows-landing이 같은 이유로 그렇게 한다.
        Ok(0)
    } else {
        run_with_store(args, root, isolated)
    }
}

/// 이 태스크가 쓸 수 있는 도구.
///
/// **좁히기만 한다.** 스킬이 좁힌 것과 질문 경로가 좁힌 것을 **교집합**으로 놓는다 —
/// 둘 중 하나라도 막으면 막힌다. 합집합으로 두면 질문이 스킬보다 넓어지거나 그 반대가 된다.
///
/// # 질문은 파일을 바꾸지 않는다 — 그 보장이 여기 있다 (51절)
///
/// sidecar의 경로가 `EXECUTING`을 지나지 않는다는 것은 **Node의 성질**이고, 장악당한 Node는
/// 그 경로를 우회할 수 있다. 게이트에 읽기 전용 목록을 꽂으면 그때도 파일이 바뀌지 않는다 —
/// 원칙 2가 요구하는 것이 정확히 이 이중화다.
///
/// **`run_tests`를 남기지 않는다.** 스킬 파싱은 검증 명령을 강제로 남기지만(26절), 그건
/// "`VERIFYING`이 스킬 파일 한 줄로 꺼지지 않게" 하려는 것이다. 질문 경로에는 `VERIFYING`이
/// 아예 없으므로 남길 이유가 없고, 남기면 답 하나 얻자고 사용자의 테스트가 돈다.
fn allowed_tools_for(
    args: &Args,
    skill: Option<&tomverse_core::skills::Skill>,
) -> Option<Vec<tomverse_core::types::ToolName>> {
    let from_skill = skill.and_then(|s| s.allowed_tools.clone());
    if !is_read_only_command(&args.command) {
        return from_skill;
    }
    // 좁히기 자체는 코어에 있다 — 화면과 이 CLI가 **같은 함수**를 쓴다.
    tomverse_core::skills::tools_for_question(from_skill)
}

/// 파일을 바꾸지 않는 하위 명령들 (51·53절).
///
/// **한 자리에서 판정한다.** 도구 좁히기와 sidecar에 보내는 `kind`가 각자 명령 이름을 직접
/// 비교하면, 새 읽기 전용 명령이 늘 때 한쪽만 갱신되고 **좁혀지지 않은 쪽이 이긴다.**
fn is_read_only_command(command: &str) -> bool {
    matches!(command, "ask" | "plan")
}

/// 스킬을 **Rust가 읽는다**(26.1절). sidecar가 읽으면 도구 허용목록의 출처가 sidecar가 되고,
/// 장악당한 sidecar가 "허용목록은 전부입니다"라고 말할 수 있다.
fn load_skill(args: &Args, root: &WorkspaceRoot) -> Result<Option<tomverse_core::skills::Skill>, String> {
    match &args.skill {
        None => Ok(None),
        Some(path) => {
            let loaded = tomverse_core::skills::load(path, root).map_err(|e| e.to_string())?;
            eprintln!("스킬 적용: {}", loaded.describe());
            Ok(Some(loaded))
        }
    }
}

/// 플래그에서 이 태스크의 정책을 만든다.
///
/// **`run`과 `autopilot-preview`가 같은 함수를 쓴다**(47절). 두 벌로 두면 미리보기가 실행과
/// 다른 정책에 대해 답하게 되고, 그 어긋남은 "미리보기가 틀렸다"가 아니라 "도구가 거짓말했다"로
/// 읽힌다.
fn task_policy_from(args: &Args, skill: Option<&tomverse_core::skills::Skill>) -> TaskPolicy {
    TaskPolicy {
        // 도구 허용목록은 **게이트에 꽂힌다.** sidecar에 알려 주기는 하지만 지키는 것은 여기다.
        allowed_tools: allowed_tools_for(args, skill),
        auto_approve_workspace_writes: args.auto_approve_writes,
        auto_approve_verification: args.auto_approve_verification,
        allow_git_commit: args.allow_git_commit,
        execution_mode: args.mode,
        // sidecar가 완료 판정에 쓴다 — 무인 실행에서는 "검증되지 않음"을 완료로 보고하지 않는다.
        unattended: args.approve == "autopilot",
        // **sidecar로 가지 않는다**(39.1절). Rust가 재고 Rust가 집행한다.
        deadline_ms: args.deadline_secs.map(|s| s * 1_000),
        ..TaskPolicy::default()
    }
}

fn run_with_store(args: Args, root: WorkspaceRoot, isolated: Option<tomverse_core::worktree::Isolation>) -> Result<i32, String> {

    let artifacts_root = args.artifacts.clone().unwrap_or_else(ArtifactStore::default_root);
    let artifacts = ArtifactStore::new(&artifacts_root).map_err(|e| format!("artifact 저장소 오류: {e}"))?;

    let db_path = args
        .db
        .clone()
        .unwrap_or_else(|| artifacts_root.parent().unwrap_or(&artifacts_root).join("state.db"));
    let store = Arc::new(Mutex::new(
        Store::open(&db_path, artifacts.clone()).map_err(|e| format!("SQLite 오류: {e}"))?,
    ));

    let workspace_id = tomverse_core::paths::workspace_id_for(&root.display());
    store
        .lock()
        .unwrap()
        .upsert_workspace(&workspace_id, &root.display(), workspace_name(&root))
        .map_err(|e| format!("워크스페이스 기록 실패: {e}"))?;

    let skill = load_skill(&args, &root)?;
    let policy_for_task = task_policy_from(&args, skill.as_ref());

    let approvals: Arc<dyn ApprovalGateway> = match args.approve.as_str() {
        // **`auto`는 테스트 전용이며 제품의 Autopilot이 아니다.** 전부 승인하므로 게이트의
        // `RequireUserApproval`이 의미를 잃는다 — MCP 호출까지 포함해서(23.3절).
        "auto" => Arc::new(AutoApprove),
        "deny" => Arc::new(AlwaysDeny),
        // Autopilot: 정책이 자동 허용하는 것만 무인으로 진행하고 사람이 필요하면 멈춘다.
        "autopilot" => Arc::new(tomverse_core::host::UnattendedStop),
        other => return Err(format!("알 수 없는 --approve: {other} (auto|deny|autopilot)")),
    };
    let sink = Arc::new(StderrSink { verbose: args.verbose });

    match args.command.as_str() {
        // **`ask`는 `run`과 같은 경로를 탄다.** 스냅샷·라우팅·예산·전송 기록이 모두 같은
        // 자리를 지나야 하고, 다른 것은 sidecar가 갈라지는 지점 하나뿐이다(51절).
        //
        // 도구 허용목록은 **읽기 전용으로 좁혀서** 보낸다(아래 `policy`). 경로가 파일을 바꾸지
        // 않는다는 것은 Node의 성질이고, 게이트가 막는다는 것은 Rust의 성질이다 — 둘을
        // 뭉치면 한쪽이 뚫렸을 때 다른 쪽도 없는 것으로 여기게 된다.
        "run" | "ask" | "plan" => {
            if args.message.trim().is_empty() {
                return Err(format!("{}에는 --message가 필요합니다", args.command));
            }
            // **세션을 명시하면 그 세션에 붙는다.** 매번 새 세션을 만들면 세션 메모리는
            // 영원히 비어 있고, 그러면 그 기능이 동작하는지 확인할 방법이 없다(27절).
            let session_id = args
                .session_id
                .clone()
                .unwrap_or_else(|| format!("sess-{}", uuid::Uuid::new_v4()));
            let task_id = args
                .task_id
                .clone()
                .unwrap_or_else(|| format!("task-{}", uuid::Uuid::new_v4()));
            {
                let mut guard = store.lock().unwrap();
                guard
                    .upsert_session(&session_id, &workspace_id, Some("headless"))
                    .map_err(|e| format!("세션 기록 실패: {e}"))?;
                guard
                    .create_task(
                        &task_id,
                        &session_id,
                        &workspace_id,
                        &root.display(),
                        match args.mode {
                            ExecutionMode::Fast => "fast",
                            ExecutionMode::Verified => "verified",
                        },
                        &args.message,
                    )
                    .map_err(|e| format!("태스크 생성 실패: {e}"))?;
            }

            // 등록이 잘못되면 **태스크를 시작하기 전에** 멈춘다 — 실행 중에 알면 이미 모델이
            // 그 서버의 도구를 쓸 수 있다고 믿고 계획을 세운 뒤다.
            // 허용목록을 등록에 접어 넣는다 (32절). **알 수 없는 서버 이름은 오류다** —
            // 조용히 넘기면 좁히려던 의도가 사라지고 서버 전체가 열린 채로 돈다.
            let mut mcp_servers = args.mcp_servers.clone();
            for (name, tools) in &args.mcp_tool_allowlists {
                match mcp_servers.iter_mut().find(|s| &s.name == name) {
                    Some(server) => server.tools = Some(tools.clone()),
                    None => {
                        return Err(format!(
                            "--mcp-tools가 가리키는 서버가 등록되어 있지 않습니다: {name} (등록된 것: {})",
                            if mcp_servers.is_empty() {
                                "없음".to_string()
                            } else {
                                mcp_servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
                            }
                        ))
                    }
                }
            }
            let mcp = if mcp_servers.is_empty() {
                None
            } else {
                Some(Arc::new(
                    tomverse_core::mcp::McpPool::new(mcp_servers).map_err(|e| e.to_string())?,
                ))
            };
            let mut task_host = TaskHost::new(
                root,
                policy_for_task.clone(),
                store.clone(),
                artifacts,
                approvals,
                sink,
                Arc::new(CancellationRegistry::new()),
            );
            if let Some(pool) = mcp.clone() {
                eprintln!("MCP 서버 등록: {}", pool.names().join(", "));
                task_host = task_host.with_mcp(pool);
            }
            if !args.hooks.is_empty() {
                // **등록 시점에 검증한다.** 오타 난 phase를 통과시키면 영원히 안 도는 훅이
                // 되고, 사용자에게는 "훅이 동작하지 않는다"로만 보인다.
                tomverse_core::hooks::validate_hooks(&args.hooks).map_err(|e| e.to_string())?;
                // 게이트가 확실히 거부할 훅은 **지금** 알린다. 등록만 되고 매 phase마다 조용히
                // 거부되는 것보다, 사용자가 명령을 적은 이 자리에서 거절당하는 편이 낫다.
                task_host.preflight_hooks(&args.hooks)?;
                for hook in &args.hooks {
                    eprintln!("훅 등록: {} → {}", hook.phase, hook.describe());
                }
                task_host = task_host.with_hooks(tomverse_core::hooks::HookRegistry::new(args.hooks.clone()));
            }
            // **격리 실행의 사실을 기록에 남긴다**(38절). 남기지 않으면 끝난 태스크에 대해
            // "결과가 어디 있는가"에 답할 수 없다 — 22.7절이 남겨둔 "태스크 기록과의 연결"이다.
            if let Some(iso) = isolated.clone() {
                task_host = task_host.with_isolation(iso);
            }
            let host = Arc::new(task_host);
            // **이 태스크의 정책을 등록한다**(ui-wireframes 3.16.2절). 헤드리스 호스트는
            // 태스크가 하나뿐이라 워크스페이스 기본값과 같지만, **경로를 하나로 둔다** —
            // 두 경로면 언젠가 한쪽만 고쳐진다.
            host.begin_task(&task_id, policy_for_task, skill.as_ref())?;
            let final_result = run_task(&args, host.clone(), &workspace_id, &session_id, &task_id, skill.as_ref(), None);
            // **띄운 서버를 반드시 내린다.** 남기면 사용자가 모르는 프로세스가 계속 돈다.
            // 태스크가 실패해도 내려야 하므로 `?` 앞에서 한다.
            if let Some(pool) = &mcp {
                pool.shutdown();
            }
            let final_result = final_result?;

            // stdout에는 최종 결과만. 호출자(테스트)가 그대로 파싱한다.
            let mutated = host.with_store(|s| s.mutated_paths(&task_id)).unwrap_or_default();
            let events = host.with_store(|s| s.event_types(&task_id)).unwrap_or_default();
            let output = json!({
                "final": final_result,
                "mutatedPaths": mutated,
                "eventTypes": events,
                "taskId": task_id,
                "dbPath": db_path.to_string_lossy(),
            });
            println!("{output}");

            let status = final_result.get("status").and_then(Value::as_str).unwrap_or("failed");
            Ok(if status == "completed" { 0 } else { 1 })
        }

        "rollback" => {
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "rollback에는 --task가 필요합니다".to_string())?;
            let host = TaskHost::new(
                root,
                policy_for_task.clone(),
                store,
                artifacts,
                approvals,
                sink,
                Arc::new(CancellationRegistry::new()),
            );
            let result = host.rollback(&task_id)?;
            println!("{result}");
            let failed = result
                .get("failed")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            Ok(if failed == 0 { 0 } else { 1 })
        }

        // 앱 재시작 시나리오. Tauri `setup()`이 `SessionState::initialize()`에서 부르는 것과
        // **같은 Store 메서드**를 그대로 호출한다 — 테스트용 별도 경로가 아니다.
        "recover" => {
            let marked = store
                .lock()
                .unwrap()
                .mark_unfinished_as_interrupted()
                .map_err(|e| format!("복구 실패: {e}"))?;
            println!(
                "{}",
                json!({ "interruptedTasks": marked, "dbPath": db_path.to_string_lossy() })
            );
            Ok(0)
        }

        // 격리 트리 조회·정리. **DB를 열지 않는다** — git 상태만 보고 아무것도 기록하지 않으므로
        // reproduce/windows-landing과 같은 이유로 store 앞에서 갈라지는 것이 맞지만, 여기서는
        // `--db`가 트리 위치를 정하므로 args만 쓴다.
        "worktree" => {
            let repo = WorkspaceRoot::new(&args.workspace)
                .map_err(|e| format!("워크스페이스 {:?}를 열 수 없습니다: {e}", args.workspace))?;
            let all = tomverse_core::worktree::list(repo.path()).map_err(|e| e.to_string())?;
            let ours: Vec<_> = tomverse_core::worktree::ours(&all).into_iter().cloned().collect();

            if args.worktree.is_none() {
                // 목록만 낸다. **남의 트리도 함께 보여주되 우리 것과 구별한다** — 정리 대상
                // 판정이 여기 달려 있고, 뭉치면 사용자가 자기 트리를 우리 것으로 읽는다.
                let described: Vec<_> = all
                    .iter()
                    .map(|w| {
                        serde_json::json!({
                            "path": w.path.to_string_lossy(),
                            "branch": w.branch,
                            "ours": ours.iter().any(|o| o.path == w.path),
                            "dirty": tomverse_core::worktree::is_dirty(&w.path),
                        })
                    })
                    .collect();
                println!("{}", serde_json::json!({ "worktrees": described }));
                return Ok(0);
            }

            // `--worktree <branch>`가 있으면 그 트리를 정리한다.
            let branch = args.worktree.clone().unwrap_or_default();
            tomverse_core::worktree::validate_branch(&branch).map_err(|e| e.to_string())?;
            let target = ours
                .iter()
                .find(|w| w.branch == branch)
                .ok_or_else(|| format!("{branch}에 해당하는 격리 트리가 없습니다"))?;
            match tomverse_core::worktree::remove(repo.path(), &target.path, args.force) {
                Ok(()) => {
                    println!("{}", serde_json::json!({ "removed": target.path.to_string_lossy() }));
                    Ok(0)
                }
                // **더러운 트리를 지우지 않은 것은 도구의 실패가 아니다.** 종료 코드에 실으면
                // "git이 깨졌다"와 "사용자가 정할 일이 남았다"가 같은 값이 된다.
                Err(e @ tomverse_core::worktree::WorktreeError::Dirty { .. }) => {
                    println!(
                        "{}",
                        serde_json::json!({ "refused": target.path.to_string_lossy(), "reason": e.to_string() })
                    );
                    Ok(0)
                }
                Err(e) => Err(e.to_string()),
            }
        }

        // Fleet — 구성원마다 격리 트리 하나. **호스트만 부른다**(fleet.rs, 22.3절과 같은 이유).
        "fleet" => run_fleet(
            &args,
            root,
            store,
            artifacts,
            approvals,
            sink,
            skill,
            policy_for_task,
            &db_path,
        ),

        // Fleet 조회 — **DB만 읽는다.** 크래시 후 "무엇이 돌고 있었나"에 답하는 자리이므로
        // 실행 중인 프로세스가 아니라 이벤트에서 유도한다(원칙 7).
        "fleet-status" => {
            let guard = store.lock().unwrap();
            let members = guard
                .fleet_members(args.fleet_id.as_deref())
                .map_err(|e| format!("Fleet 조회 실패: {e}"))?;
            let mut cost = 0.0;
            for member in &members {
                cost += guard.task_cost_usd(&member.task_id).map(|(c, _, _)| c).unwrap_or(0.0);
            }
            // **`final_status`가 없으면 돌고 있었다.** 크래시로 죽은 것은 `recover`가
            // `INTERRUPTED`로 확정하며, 그전까지는 "확정되지 않았다"가 정직한 답이다.
            let unfinished: Vec<&str> = members
                .iter()
                .filter(|m| m.final_status.is_none())
                .map(|m| m.task_id.as_str())
                .collect();
            println!(
                "{}",
                json!({
                    "members": members,
                    // 이름이 `fleetCostUsd`인 이유: 태스크 하나의 지출과 같은 이름으로 부르면
                    // 화면이 둘을 구별할 수 없고, 그러면 참인 숫자가 답이 아니게 된다.
                    "fleetCostUsd": cost,
                    "unfinishedTaskIds": unfinished,
                })
            );
            Ok(0)
        }

        "tasks" => {
            let guard = store.lock().unwrap();
            let rows = guard
                .list_tasks(Some(&root.display()), 200, None)
                .map_err(|e| format!("작업 목록 조회 실패: {e}"))?;
            println!("{}", json!({ "tasks": rows }));
            Ok(0)
        }

        // 재시작 후에도 기록이 남아 있는지 확인하는 통로. DB만 읽고 아무것도 실행하지 않는다.
        "revert" => {
            // 되돌리기의 두 뜻 중 **커밋 되돌리기**. `rollback`(파일 복원)과 별도 명령인 이유는
            // 저장소에 남기는 결과가 다르기 때문이다(19절).
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "revert에는 --task가 필요합니다".to_string())?;
            let host = TaskHost::new(
                root,
                policy_for_task.clone(),
                store,
                artifacts,
                approvals,
                sink,
                Arc::new(CancellationRegistry::new()),
            );
            let result = host.revert_commit(&task_id)?;
            println!("{result}");
            // 종료 코드로 세 결말을 구별한다. "되돌리지 못했다"와 "되돌리지 못한 데다 저장소가
            // revert 진행 중으로 남았다"를 같은 1로 보고하면, 스크립트가 후자를 알아챌 방법이 없다.
            Ok(if result.get("reverted").and_then(Value::as_bool) == Some(true) {
                0
            } else if result.get("cleanedUp").and_then(Value::as_bool) == Some(false) {
                2
            } else {
                1
            })
        }

        // 데이터 전송 투명성 — **읽기 전용이다.** product-strategy 7절.
        "transmission" => {
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "transmission에는 --task가 필요합니다".to_string())?;
            let guard = store.lock().unwrap();
            let out = tomverse_core::transmission::collect(&guard, &task_id)?;
            println!("{}", serde_json::to_string(&out).unwrap_or_default());
            Ok(0)
        }

        // 감사 export — **읽기 전용이다.** product-strategy 6절.
        "export" => {
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "export에는 --task가 필요합니다".to_string())?;
            let guard = store.lock().unwrap();
            let out = tomverse_core::export::collect(&guard, &task_id)?;
            // **이것만 pretty로 찍는다.** 다른 하위 명령의 출력은 도구가 바로 먹지만,
            // export는 파일로 저장되어 사람이 읽고 diff하는 것이 용도다 — 한 줄로 내보내면
            // 그 용도가 사라진다.
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
            Ok(0)
        }

        "metrics" => {
            // **읽기 전용이다.** 아무것도 쓰지 않고, 저장된 이벤트만 집계한다.
            // 사람이 눈으로 세는 대신 숫자를 내는 것이 목적이며, 답하지 못하는 것은
            // metrics.rs 모듈 주석에 적어두었다.
            let guard = store.lock().unwrap();
            let scope = if args.all_workspaces {
                None
            } else {
                Some(args.workspace.to_string_lossy().to_string())
            };
            let metrics = tomverse_core::metrics::collect(&guard, scope.as_deref())?;
            println!("{}", serde_json::to_string(&metrics).unwrap_or_default());
            Ok(0)
        }

        "pr" => {
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "pr에는 --task가 필요합니다".to_string())?;
            let host = TaskHost::new(
                root,
                policy_for_task.clone(),
                store.clone(),
                artifacts,
                approvals,
                sink,
                Arc::new(CancellationRegistry::new()),
            );
            let out = host.open_pull_request(&task_id, &args.remote, &args.base)?;
            let pushed = out.get("pushed").and_then(Value::as_bool).unwrap_or(false);
            println!("{out}");
            // **올리지 못한 것을 0으로 보고하지 않는다** — 호출자가 성공으로 읽는다.
            Ok(if pushed { 0 } else { 1 })
        }

        // 판정의 철회 (30절). **목록은 읽기 전용이다.**
        "decisions" => {
            let session_id = args
                .session_id
                .clone()
                .ok_or_else(|| "decisions에는 --session이 필요합니다".to_string())?;
            let guard = store.lock().unwrap();
            let items = tomverse_core::decisions::list(&guard, &session_id)?;
            println!("{}", json!({ "decisions": items }));
            Ok(0)
        }

        // **읽기 전용이 아니다** — 이벤트가 하나 남는다. 그래도 `run`과 달리 모델도 sidecar도
        // 부르지 않는다: 사용자가 직접 부르는 자리이고, Node는 이 이벤트를 낼 수 없다.
        "withdraw" => {
            let session_id = args
                .session_id
                .clone()
                .ok_or_else(|| "withdraw에는 --session이 필요합니다".to_string())?;
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "withdraw에는 --task가 필요합니다 (판정의 열쇠는 태스크와 기준 id 둘입니다)".to_string())?;
            let criterion_id = args
                .criterion_id
                .clone()
                .ok_or_else(|| "withdraw에는 --criterion이 필요합니다".to_string())?;
            let host = TaskHost::new(
                root,
                policy_for_task.clone(),
                store,
                artifacts,
                approvals,
                sink,
                Arc::new(CancellationRegistry::new()),
            );
            let out = host.withdraw_decision(&session_id, &task_id, &criterion_id, args.reason.as_deref())?;
            let withdrawn = out.get("withdrawn").and_then(Value::as_bool).unwrap_or(false);
            println!("{out}");
            // **거두지 못한 것을 0으로 보고하지 않는다** — 호출자가 성공으로 읽는다.
            Ok(if withdrawn { 0 } else { 1 })
        }

        "blocked" => {
            // **읽기 전용이다.** 저장된 이벤트에서 처방을 유도할 뿐, 정책을 고치지도
            // 태스크를 다시 돌리지도 않는다 — 다시 돌리는 것은 사용자의 결정이다.
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "blocked에는 --task가 필요합니다".to_string())?;
            let guard = store.lock().unwrap();
            let report = tomverse_core::blocked::collect(&guard, &task_id)?;
            println!("{}", serde_json::to_string(&report).unwrap_or_default());
            Ok(0)
        }

        "show" => {
            let task_id = args
                .task_id
                .clone()
                .ok_or_else(|| "show에는 --task가 필요합니다".to_string())?;
            let guard = store.lock().unwrap();
            let task = guard.get_task(&task_id).map_err(|e| format!("작업 조회 실패: {e}"))?;
            let events = guard
                .events_after(&task_id, None)
                .map_err(|e| format!("이벤트 조회 실패: {e}"))?;
            let output = json!({
                "task": task,
                "events": events.iter().map(|e| json!({
                    "eventId": e.event_id,
                    "seq": e.seq,
                    "type": e.event_type,
                    "phase": e.phase,
                    "payload": e.payload,
                    "createdAt": e.created_at,
                })).collect::<Vec<_>>(),
                "eventTypes": events.iter().map(|e| e.event_type.clone()).collect::<Vec<_>>(),
                "mutations": guard.mutation_records(&task_id).map_err(|e| format!("변경 조회 실패: {e}"))?,
                "toolExecutions": guard.tool_executions(&task_id).map_err(|e| format!("도구 조회 실패: {e}"))?,
                "verificationChecks": guard.verification_checks(&task_id).map_err(|e| format!("검증 조회 실패: {e}"))?,
                // 확정 기준. 이벤트를 재생하지 않고도 "무엇을 결정했는가"를 볼 수 있어야
                // 진단이 가능하다 — UI의 get_task와 같은 자리를 헤드리스에서도 연다.
                "acceptanceCriteria": guard.acceptance_criteria(&task_id).map_err(|e| format!("기준 조회 실패: {e}"))?,
            });
            println!("{output}");
            Ok(if task.is_some() { 0 } else { 1 })
        }

        other => Err(format!("알 수 없는 명령: {other}\n\n{}", usage())),
    }
}

/// Fleet 구성원 하나를 밖에서 멈추기 위한 손잡이.
///
/// # 왜 필요한가 — 취소가 N개 전부에 닿아야 한다
///
/// Rust 쪽 취소(`TaskHost::cancel_task`)는 task_id만 있으면 되지만, Node 쪽의 진행 중인 공급자
/// 호출을 끊으려면 그 구성원의 `SidecarClient`가 필요하다. 클라이언트는 `run_task` **안에서**
/// 만들어지므로, 만들어지는 즉시 여기에 걸어 둔다.
///
/// **취소가 클라이언트보다 먼저 올 수 있다.** 그때 `cancelled`가 이미 켜져 있으면 게시하는
/// 쪽이 즉시 끊는다 — 켜지지 않았다고 가정하면 "시작 직후 Fleet 취소"에서 그 구성원만 살아남는다.
#[derive(Default)]
struct MemberControl {
    client: Mutex<Option<Arc<SidecarClient>>>,
    cancelled: std::sync::atomic::AtomicBool,
}

impl MemberControl {
    /// Node 쪽 취소. Rust 쪽은 `TaskHost::cancel_task`가 따로 한다 — 둘 다 필요하다.
    fn cancel_sidecar(&self, task_id: &str) {
        self.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        let client = self.client.lock().unwrap().clone();
        if let Some(client) = client {
            let _ = client.request("task.cancel", json!({ "taskId": task_id }), Duration::from_secs(5));
        }
    }

    fn publish(&self, task_id: &str, client: &Arc<SidecarClient>) {
        *self.client.lock().unwrap() = Some(client.clone());
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = client.request("task.cancel", json!({ "taskId": task_id }), Duration::from_secs(5));
        }
    }
}

fn run_task(
    args: &Args,
    host: Arc<TaskHost>,
    workspace_id: &str,
    session_id: &str,
    task_id: &str,
    // **이미 읽은 것을 받는다.** 여기서 파일을 다시 읽으면 정책에 꽂힌 것과 sidecar로 보내는
    // 것이 서로 다른 시점의 파일이 될 수 있다.
    skill: Option<&tomverse_core::skills::Skill>,
    // Fleet 구성원이면 밖에서 멈출 수 있게 클라이언트를 걸어 둘 자리. 단일 태스크는 `None`이다.
    control: Option<Arc<MemberControl>>,
) -> Result<Value, String> {
    // 진입점도 인터프리터도 **launcher가 정한다**(launcher.rs). 여기서 따로 찾으면
    // 헤드리스 호스트와 데스크톱 앱이 서로 다른 규칙으로 sidecar를 띄우게 되고,
    // e2e가 통과해도 그 통과가 앱 경로에 대해 말해주는 것이 줄어든다.
    let launcher = tomverse_core::launcher::detect_with_entry(args.sidecar.clone())?;

    // 자격증명은 여기서 한 번 주입된다. Node는 이 값을 디스크에 쓰지 않는다.
    let mut env = credential_env();
    // fake 공급자 스크립트는 자격증명이 아니므로 그대로 전달한다 (e2e 테스트가 쓴다).
    if let Ok(script) = std::env::var("TOMVERSE_FAKE_SCRIPT") {
        env.push(("TOMVERSE_FAKE_SCRIPT".to_string(), script));
    }
    for key in [
        "TOMVERSE_EXECUTOR_MODEL",
        "TOMVERSE_REVIEWER_MODEL",
        "TOMVERSE_ALLOW_ORG_VERIFIED",
        // 공급자 호출 1회 타임아웃(ms). **`--timeout-secs`와 다른 값이다** — 저쪽은 호스트가
        // 기다리기를 그만두는 시각이고 이건 한 번의 provider 호출에 거는 상한이다. 둘을
        // 하나로 묶으면 "응답을 끝까지 받겠다"와 "이 태스크를 여기서 접겠다"가 같은 손잡이가 된다.
        "TOMVERSE_PROVIDER_TIMEOUT_MS",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.push((key.to_string(), value));
        }
    }

    let config = tomverse_core::launcher::config_from(&launcher, env);
    let client = SidecarClient::spawn(config, host.clone())
        .map_err(|e| format!("sidecar를 spawn할 수 없습니다: {e}\n{}", launcher.describe_failure()))?;

    // **만들어지는 즉시 건다.** 뒤로 미루면 그 사이의 Fleet 취소가 이 구성원을 놓친다.
    if let Some(control) = &control {
        control.publish(task_id, &client);
    }

    // process-architecture.md 5절 — ready 대기 타임아웃 10초.
    let ready = client.wait_ready(Duration::from_secs(10))?;
    if let Err(message) =
        tomverse_core::launcher::require_supported_node(ready.get("nodeVersion").and_then(Value::as_str), &launcher)
    {
        client.shutdown(Duration::from_secs(2));
        return Err(message);
    }
    let sidecar_version = ready.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    if sidecar_version != PROTOCOL_VERSION {
        client.shutdown(Duration::from_secs(2));
        return Err(format!(
            "프로토콜 버전 불일치: Rust {PROTOCOL_VERSION} vs sidecar {sidecar_version}. 앱을 다시 빌드하세요."
        ));
    }

    let providers = available_providers();
    // fake 공급자는 자격증명이 없으므로 available_providers()에 안 잡힌다.
    // 명시적으로 fake 모드를 요청했을 때만 후보에 넣는다 — 키가 없으면 조용히 가짜 모델로
    // 넘어가는 동작은 사용자를 속이는 것이다.
    let providers = if std::env::var("TOMVERSE_FAKE_SCRIPT").is_ok() || std::env::var("TOMVERSE_USE_FAKE").is_ok() {
        let mut p = providers;
        p.push("fake-a".to_string());
        p.push("fake-b".to_string());
        // 셋째를 넣는 이유: 둘뿐이면 대조(executor ×2)를 켤 때 검수자가 대조 참가자와 같은
        // 공급자가 되는 **절충 경로만** e2e에서 돌게 된다(multi-engine-routing.md 13.3절).
        // 완전 독립 배정이 가능한 경로도 실제 바이너리로 확인할 수 있어야 한다.
        // `--providers`가 좁히기만 하므로 필요하면 e2e가 둘로 줄여 절충 경로를 따로 볼 수 있다.
        p.push("fake-c".to_string());
        p
    } else {
        providers
    };

    // `--providers`는 **좁히기만 한다.** 자격증명이 없는 공급자를 후보에 넣을 수는 없다 —
    // 그러면 "키가 없는데 있는 척"이 되고, 실험이 실제로 어느 모델을 불렀는지 알 수 없어진다.
    let providers = match &args.providers {
        Some(requested) => {
            let narrowed: Vec<String> = providers.iter().filter(|p| requested.contains(p)).cloned().collect();
            if narrowed.is_empty() {
                return Err(format!(
                    "--providers {:?} 중 자격증명이 있는 공급자가 없습니다 (사용 가능: {:?}). \
                     실험을 실제로 돌리려면 해당 공급자의 API 키가 필요합니다.",
                    requested, providers
                ));
            }
            narrowed
        }
        None => providers,
    };

    // 초안 재생 파일은 **Rust가 읽는다.** sidecar에는 경로가 아니라 내용만 넘어간다.
    let replay_draft: Option<Value> = match &args.replay_draft {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("--replay-draft 파일을 읽을 수 없습니다 {path:?}: {e}"))?;
            let parsed: Value = serde_json::from_str(&text)
                .map_err(|e| format!("--replay-draft 파일이 유효한 JSON이 아닙니다 {path:?}: {e}"))?;
            // 최소 형태 확인 — 잘못된 파일이 조용히 "초안 없음"으로 흘러가면 arm이 뒤바뀐다.
            if parsed.get("patch").is_none() && parsed.get("plan").is_none() {
                return Err(format!(
                    "--replay-draft 파일에 patch도 plan도 없습니다 {path:?} — 재생할 초안이 아닙니다"
                ));
            }
            Some(parsed)
        }
        None => None,
    };

    let mut experiment = serde_json::Map::new();
    if let Some(mode) = &args.review_mode {
        experiment.insert("reviewMode".to_string(), json!(mode));
    }
    if let Some(draft) = replay_draft {
        experiment.insert("replayDraft".to_string(), draft);
    }

    // 지정이 없으면 키 자체를 넣지 않는다 — 빈 객체를 넣으면 "지정했는데 비었다"와
    // "지정하지 않았다"가 같은 모양이 된다.
    let mut pins = serde_json::Map::new();
    // **스킬의 지정을 먼저 깔고 명시한 플래그로 덮는다.** 우선순위를 여기 한 곳에서 정한다 —
    // sidecar에도 스킬 지정을 보내면 거기서 다시 정하게 되고, 그러면 규칙이 둘이 된다.
    if let Some(p) = skill.as_ref().and_then(|s| s.model_pins.as_ref()) {
        if let Some(m) = &p.executor {
            pins.insert("executor".to_string(), json!(m));
        }
        if let Some(m) = &p.reviewer {
            pins.insert("reviewer".to_string(), json!(m));
        }
    }
    if let Some(m) = &args.pin_executor {
        pins.insert("executor".to_string(), json!(m));
    }
    if let Some(m) = &args.pin_reviewer {
        pins.insert("reviewer".to_string(), json!(m));
    }
    let model_pins = if pins.is_empty() {
        Value::Null
    } else {
        Value::Object(pins)
    };

    // **이 태스크를 만든 뒤에 모은다.** 앞에서 모으면 이번 태스크가 아직 없어 제외 대상도
    // 없지만, 재실행 경로에서는 이미 있을 수 있다 — 그때 자기 판정을 자기에게 나르게 된다.
    let memory = host.with_store(|s| tomverse_core::session_memory::collect(s, session_id, task_id))?;
    let session_memory = if memory.is_empty() {
        Value::Null
    } else {
        json!({
            "text": memory.render(),
            "decisionCount": memory.decisions.len(),
            "truncated": memory.truncated,
        })
    };

    // **태스크를 만든 뒤, 첫 프롬프트 전에 한 번만 묻는다.** 서버를 실제로 띄우므로
    // 반복해서 물으면 그만큼 프로세스를 건드린다. 실패한 서버는 사유와 함께 목록에 남고
    // 태스크를 세우지 않는다 — 관계없는 서버 하나가 죽었다고 작업이 막히면 안 된다.
    let mcp_tools = match host.mcp_catalog(task_id) {
        None => Value::Null,
        Some(catalog) => json!({
            "text": catalog.render(),
            "serverCount": catalog.server_count(),
            "toolCount": catalog.tool_count(),
            "truncated": catalog.truncated(),
        }),
    };

    let params = json!({
        "taskRequest": {
            "taskId": task_id,
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "userMessage": args.message,
            // **바꿔 달라는 것인가 물어보는 것인가**(51절). 값이 없으면 종전과 같다.
            "kind": match args.command.as_str() {
                "ask" => "question",
                "plan" => "plan",
                _ => "change",
            },
            "createdAt": tomverse_core::time::now_iso(),
        },
        "policy": {
            "autoApproveWorkspaceWrites": args.auto_approve_writes,
            "autoApproveVerification": args.auto_approve_verification,
            "allowGitCommit": args.allow_git_commit,
            // null은 "기본값을 쓰라"가 아니라 **"상한 없음"**이다. 키를 빼면 sidecar의
            // 기본 상한이 적용되어, 이 바이너리를 쓰는 하네스가 모르는 상한이 생긴다.
            "budgetUsd": args.budget_usd,
            "modelPins": model_pins,
            "executionMode": match args.mode { ExecutionMode::Fast => "fast", ExecutionMode::Verified => "verified" },
            // **이 map은 Rust의 `TaskPolicy`가 아니라 TS의 `TaskPolicy`를 향해 손으로 조립된다.**
            // 그래서 Rust 구조체에 필드를 더해도 여기 넣지 않으면 sidecar에 도달하지 않는다 —
            // 실제로 `unattended`를 추가하고 그렇게 빠뜨렸고, e2e가 잡았다.
            "unattended": args.approve == "autopilot",
            // sidecar는 이 목록을 **지키지 않는다** — 지키는 것은 Rust의 게이트다. 보내는
            // 이유는 화면이 "이 스킬이 무엇을 좁혔는가"를 말할 수 있어야 하기 때문이다.
            // **게이트에 꽂힌 값을 그대로 보낸다**(51절). 여기서 다시 계산하면 화면이 말하는
            // 허용목록과 실제로 좁혀진 목록이 갈릴 수 있고, 갈리면 화면이 거짓말한다.
            "allowedTools": allowed_tools_for(args, skill)
                .as_ref()
                .map(|t| t.iter().map(|x| x.as_str()).collect::<Vec<_>>()),
        },
        // 프롬프트 프리셋과 모델 지정만 sidecar로 간다 — 도구 허용목록은 policy로 갔고
        // 강제하는 곳은 Rust다(26.1절).
        "skill": skill.as_ref().map(|s| json!({ "name": s.name, "instructions": s.instructions })),
        // 세션 메모리는 **Rust가 저장소에서 유도한다**(27.1절) — 무엇을 나를 수 있는지는
        // 권위에 관한 판정이고, 그 판정이 sidecar에 있으면 장악당한 sidecar가 모델 제안을
        // 사용자 판정으로 나를 수 있다.
        "sessionMemory": session_memory,
        // 등록된 MCP 서버가 실제로 내놓는 도구 목록 (31절). **Rust가 서버를 띄워 묻는다** —
        // MCP 서버는 프로세스이고 그것을 띄우는 것은 Node에게 금지된 일이다(원칙 2).
        // 이것이 없으면 모델은 서버 이름도 도구 이름도 몰라 `mcp_call`을 부를 수 없다.
        "mcpTools": mcp_tools,
        "workspaceName": workspace_name(host.root()),
        "availableProviders": providers,
        // 비어 있으면 아예 넣지 않는다 — production 실행과 바이트 단위로 같은 params가 되도록.
        "experiment": if experiment.is_empty() { Value::Null } else { Value::Object(experiment) },
    });

    // 시나리오 A: 실행 중 취소를 스스로 트리거한다. **취소 경로는 UI의 것과 동일하다** —
    // `TaskHost::cancel_task`를 그대로 부르고 Node에도 `task.cancel`을 보낸다. 별도 mock이 아니다.
    if let Some(delay_ms) = args.cancel_after_ms {
        let host_for_cancel = host.clone();
        let client_for_cancel = client.clone();
        let task = task_id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            // Rust 쪽: 실행 중인 자식 프로세스를 죽이고 이후 도구 실행을 막는다.
            if let Err(message) = host_for_cancel.cancel_task(&task) {
                eprintln!("취소 요청 실패: {message}");
            }
            // Node 쪽: 진행 중인 공급자 호출을 abort한다.
            let _ = client_for_cancel.request("task.cancel", json!({ "taskId": task }), Duration::from_secs(5));
        });
    }

    let outcome = client.request("task.start", params, Duration::from_secs(args.timeout_secs));
    client.shutdown(Duration::from_secs(3));

    match outcome {
        Ok(value) => {
            // Node가 보고한 최종 상태를 **호스트가 확정한다.** Node의 주장을 그대로 믿지 않고
            // 원자적 terminal 규칙을 통과시켜야 경쟁 상황에서도 하나만 남는다.
            let status = value.get("status").and_then(Value::as_str).unwrap_or("failed");
            let terminal = match status {
                "completed" => "COMPLETED",
                "cancelled" => "CANCELLED",
                "rejected" => "REJECTED",
                _ => "FAILED",
            };
            let summary = value.get("summary").and_then(Value::as_str).unwrap_or("");
            match host.finish_task(
                task_id,
                terminal,
                &format!("TASK_{terminal}"),
                if terminal == "FAILED" { Some(summary) } else { None },
                json!({ "status": status, "summary": summary, "source": "host-confirm" }),
            ) {
                Ok(TerminalOutcome::Recorded { .. }) | Ok(TerminalOutcome::AlreadyTerminal { .. }) => {}
                Err(message) => eprintln!("terminal 확정 실패: {message}"),
            }
            Ok(value)
        }
        Err(message) => {
            // sidecar가 죽었어도 이벤트 로그로 마지막 상태를 설명할 수 있어야 한다.
            // **적기 전에 멈춘다**(39.2절) — 여기서는 바로 위에서 sidecar를 내렸으므로 남은
            // 일이 없지만, 판정을 두 진입점에 따로 적지 않는다.
            host.abandon_unanswered(task_id, &message);
            Ok(json!({ "status": "failed", "summary": message, "taskId": task_id }))
        }
    }
}


// ---- Fleet — worktree 격리 기반 N개 병렬 실행 (fleet.rs, process-architecture 11.6절) ----

/// 구성원별로 이벤트에 **누구의 것인지** 붙여 내보낸다.
///
/// N개가 동시에 돌면 stderr가 섞인다. 섞인 로그에서 "3개가 실패했다"를 읽어내는 것은 사람의
/// 일이 되고, 그러면 부분 실패가 조용해진다 — 이 제품이 팔지 않기로 한 바로 그것이다.
struct MemberSink {
    inner: Arc<dyn EventSink>,
    label: String,
}

impl EventSink for MemberSink {
    fn emit(&self, channel: &str, payload: &Value) {
        self.inner.emit(&format!("{}·{channel}", self.label), payload);
    }
}

/// 한 구성원이 끝났다는 소식.
struct MemberDone {
    index: usize,
    status: String,
    summary: String,
    finished_at: String,
}

/// 도는 중인 구성원.
struct RunningMember {
    branch: String,
    task_id: String,
    host: Arc<TaskHost>,
    control: Arc<MemberControl>,
    reserved_usd: Option<f64>,
    worktree_path: String,
    started_at: String,
    handle: std::thread::JoinHandle<()>,
}

/// Fleet 실행.
///
/// # 각 구성원은 **평범한 태스크다**
///
/// 자기 worktree를 게이트 루트로 받는 것 말고는 `run`과 한 글자도 다르지 않다 — 같은
/// `TaskHost`, 같은 Policy Gate, 같은 Tool Runtime, 같은 sidecar 계약. Policy Gate에 "Fleet
/// 모드" 분기를 만들지 않은 것이 요점이다(22.1절이 worktree에서 한 결정과 같다): 분기를 만들면
/// 게이트가 두 규칙을 갖고, 둘 중 하나는 언젠가 덜 검사되며 그 순간 우회 지점이 된다.
///
/// # 왜 프로세스가 아니라 스레드인가
///
/// 구성원을 별도 `tomverse-host` 프로세스로 띄우면 세 가지가 프로세스 경계를 넘어야 한다:
/// 승인 큐, 합계 예산 원장, 검증 레인. 셋 다 **파일 잠금이나 새 IPC 채널**을 요구하고, 그
/// 코드는 이 환경에서 동작을 검증할 수 없다(플랫폼별 잠금 API — `win_job.rs`가 남긴 교훈).
/// 스레드로 두면 셋 다 프로세스 안의 평범한 자료구조가 되고, **검증할 수 있는 것이 된다.**
///
/// 그러면서도 "여러 프로세스가 실제로 동시에 돈다"는 사실은 그대로다 — 구성원마다 **자기
/// sidecar 프로세스**가 뜨고 그 아래에서 검증 명령이 돈다. 병렬성은 거기 있다.
///
/// # 자격증명 노출면 (11.6④)
///
/// 11.3절은 워크스페이스마다 sidecar를 살려두는 것을 거부했다. 근거는 **아무 일도 하지 않는
/// 프로세스가 키를 들고 있다**는 것이었고, 그 조건이 Fleet에서는 성립하지 않는다: 여기 있는
/// sidecar는 전부 사용자가 방금 시작한 태스크를 돌리고 있고, 태스크가 끝나면 즉시 내려간다.
/// 사본 수는 `MAX_FLEET_SIZE`로 묶여 있고 수명은 일의 수명이다. 11.3절의 두 번째 근거(공유
/// sidecar가 게이트 루트를 요청마다 정하게 만든다)는 **그대로 지켜진다** — 구성원마다 sidecar가
/// 하나씩이고 각각 루트가 하나뿐이다. 즉 Fleet은 11.3절을 어기는 것이 아니라 만족한다.
#[allow(clippy::too_many_arguments)]
fn run_fleet(
    args: &Args,
    repo: WorkspaceRoot,
    store: Arc<Mutex<Store>>,
    artifacts: ArtifactStore,
    approvals: Arc<dyn ApprovalGateway>,
    sink: Arc<dyn EventSink>,
    skill: Option<tomverse_core::skills::Skill>,
    policy: TaskPolicy,
    db_path: &Path,
) -> Result<i32, String> {
    use tomverse_core::fleet::{Admission, FleetBudget, MemberReport};

    if args.worktree.is_some() {
        // 격리 트리는 구성원마다 하나씩 만들어진다. 여기에 또 하나를 주면 "어느 트리에서
        // 도는가"의 답이 둘이 되고, 둘 중 하나는 거짓이다.
        return Err("fleet은 구성원마다 격리 트리를 만듭니다 — --worktree와 함께 쓸 수 없습니다".to_string());
    }
    // **합계 상한도 "말하지 않은 것"과 "없음"을 구별한다**(budget.rs와 같은 규칙). 인자를
    // 빠뜨린 호출이 합계 상한을 조용히 끄면, 그 순간 이 기능의 출시 기준("비용 상한")이 거짓이 된다.
    let cap_usd = tomverse_core::budget::resolve_budget(
        args.fleet_budget_usd,
        Some(args.fleet_budget_unlimited),
    )
    .map_err(|e| format!("Fleet 합계 상한: {e}"))?;

    let fleet_id = args
        .fleet_id
        .clone()
        .unwrap_or_else(|| format!("fleet-{}", uuid::Uuid::new_v4()));
    let plan = tomverse_core::fleet::plan(
        &fleet_id,
        args.fleet_members.clone(),
        args.budget_usd,
        cap_usd,
    )
    .map_err(|e| e.to_string())?;

    // 취소 지연이 가리키는 브랜치가 실제로 있는지 **시작 전에** 본다. 오타를 통과시키면
    // "취소를 걸었는데 아무 일도 없었다"가 되고, 그건 취소가 동작하지 않는 것과 구별되지 않는다.
    for (branch, _) in &args.cancel_member_after_ms {
        if !plan.members.iter().any(|m| &m.branch == branch) {
            return Err(format!("--cancel-member-after-ms가 가리키는 구성원이 없습니다: {branch}"));
        }
    }

    let session_id = args
        .session_id
        .clone()
        .unwrap_or_else(|| format!("sess-{}", uuid::Uuid::new_v4()));
    let parent_dir = worktree_parent_dir(args);
    // **취소 등록부를 공유한다.** 구성원마다 따로 두면 Fleet 전체 취소가 각 호스트를 찾아다녀야
    // 하고, 그 목록이 곧 두 번째 진실의 원천이 된다.
    let cancels = Arc::new(CancellationRegistry::new());
    let mut budget = FleetBudget::from_plan(&plan);

    let size = plan.members.len();
    eprintln!(
        "Fleet {fleet_id}: 구성원 {size}개 (최대 {}), 태스크당 상한 {}, 합계 상한 {}",
        tomverse_core::fleet::MAX_FLEET_SIZE,
        args.budget_usd.map(|v| format!("${v}")).unwrap_or_else(|| "없음".into()),
        cap_usd.map(|v| format!("${v}")).unwrap_or_else(|| "없음".into()),
    );

    let (tx, rx) = std::sync::mpsc::channel::<MemberDone>();
    let mut reports: Vec<Option<MemberReport>> = (0..size).map(|_| None).collect();
    let mut running: std::collections::HashMap<usize, RunningMember> = std::collections::HashMap::new();
    let mut next = 0usize;

    // **Fleet 전체 취소는 구성원 하나의 취소와 다른 요청이다.** 손잡이를 합치지 않는다.
    //
    // **아직 시작하지 않은 구성원에도 닿아야 한다.** 도는 것만 멈추고 대기열은 그대로 두면,
    // 취소를 누른 뒤에 새 태스크가 시작된다 — 사용자가 요청한 것의 정반대다. 그래서 취소는
    // 도는 구성원을 멈추는 것과 **대기열을 닫는 것** 둘 다 한다.
    let cancel_all: Arc<Mutex<Vec<(String, Arc<MemberControl>, Arc<TaskHost>)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let fleet_cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(delay) = args.cancel_fleet_after_ms {
        let registry = cancel_all.clone();
        let flag = fleet_cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            // **대기열을 먼저 닫는다.** 나중에 닫으면 그 사이에 하나가 더 시작될 수 있고,
            // 그 구성원은 취소 목록에 없으므로 끝까지 돈다.
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            // 스냅샷을 떠서 잠금을 놓고 취소한다 — 취소가 sidecar 왕복을 기다리는 동안
            // 잠금을 쥐고 있으면 새로 시작하는 구성원이 등록되지 못한다.
            let members = registry.lock().unwrap().clone();
            eprintln!("Fleet 전체 취소: 구성원 {}개", members.len());
            for (task_id, control, host) in members {
                if let Err(message) = host.cancel_task(&task_id) {
                    eprintln!("취소 요청 실패({task_id}): {message}");
                }
                control.cancel_sidecar(&task_id);
            }
        });
    }

    loop {
        // ---- 들여보낼 수 있는 만큼 들여보낸다 ----
        while next < size {
            // **취소된 Fleet은 새 구성원을 시작하지 않는다.** 도는 것만 멈추면 취소를 누른
            // 뒤에 태스크가 시작되고, 그건 사용자가 요청한 것의 정반대다.
            if fleet_cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                let index = next;
                next += 1;
                let spec = &plan.members[index];
                let reason = "Fleet이 취소되어 시작하지 않았습니다".to_string();
                eprintln!("구성원 미시작({}): {reason}", spec.branch);
                let task_id = format!("task-{}", uuid::Uuid::new_v4());
                if let Err(message) = record_unstarted_member(
                    &store, &repo, &session_id, &fleet_id, size, index, spec, &task_id,
                    "fleet_cancelled", &reason,
                ) {
                    eprintln!("미시작 구성원 기록 실패: {message}");
                }
                reports[index] = Some(MemberReport::not_started(index, &spec.branch, &task_id, reason));
                continue;
            }
            match budget.try_admit() {
                Admission::Admitted { reserved_usd } => {
                    let index = next;
                    next += 1;
                    let spec = plan.members[index].clone();
                    match start_member(
                        args,
                        &repo,
                        &parent_dir,
                        &store,
                        &artifacts,
                        &approvals,
                        &sink,
                        &cancels,
                        skill.clone(),
                        policy.clone(),
                        &fleet_id,
                        size,
                        index,
                        &spec,
                        &session_id,
                        reserved_usd,
                        tx.clone(),
                    ) {
                        Ok(member) => {
                            cancel_all.lock().unwrap().push((
                                member.task_id.clone(),
                                member.control.clone(),
                                member.host.clone(),
                            ));
                            if let Some((_, delay)) =
                                args.cancel_member_after_ms.iter().find(|(b, _)| *b == spec.branch)
                            {
                                let task_id = member.task_id.clone();
                                let control = member.control.clone();
                                let host = member.host.clone();
                                let delay = *delay;
                                std::thread::spawn(move || {
                                    std::thread::sleep(Duration::from_millis(delay));
                                    eprintln!("구성원 취소: {task_id}");
                                    if let Err(message) = host.cancel_task(&task_id) {
                                        eprintln!("취소 요청 실패({task_id}): {message}");
                                    }
                                    control.cancel_sidecar(&task_id);
                                });
                            }
                            running.insert(index, member);
                        }
                        Err(message) => {
                            // **시작에 실패한 것도 결말이다.** 예약을 돌려주지 않으면 남은
                            // 구성원들이 있지도 않은 지출에 막힌다.
                            budget.settle(reserved_usd, 0.0);
                            eprintln!("구성원 시작 실패({}): {message}", spec.branch);
                            reports[index] = Some(MemberReport {
                                index,
                                branch: spec.branch.clone(),
                                task_id: String::new(),
                                admitted: false,
                                worktree_path: None,
                                status: "failed".to_string(),
                                summary: message,
                                cost_usd: 0.0,
                                reserved_usd: None,
                                started_at: None,
                                finished_at: Some(tomverse_core::time::now_iso()),
                            });
                        }
                    }
                }
                Admission::Refused {
                    cap_usd,
                    committed_usd,
                    reserved_usd,
                    per_task_usd,
                } => {
                    if budget.waiting_could_help() {
                        // 도는 구성원이 정산되면 자리가 생길 수 있다. 지금 거부로 확정하지 않는다.
                        break;
                    }
                    // **영원히 자리가 없다.** 합계 상한이 걸렸으므로 새 태스크를 시작하지 않는다.
                    let index = next;
                    next += 1;
                    let spec = &plan.members[index];
                    let reason = format!(
                        "Fleet 합계 상한(${cap_usd:.2})이 남지 않아 시작하지 않았습니다 \
                         (확정 지출 ${committed_usd:.4} + 예약 ${reserved_usd:.4} + 태스크당 상한 ${per_task_usd:.2})"
                    );
                    eprintln!("구성원 미시작({}): {reason}", spec.branch);
                    let task_id = format!("task-{}", uuid::Uuid::new_v4());
                    if let Err(message) = record_unstarted_member(
                        &store, &repo, &session_id, &fleet_id, size, index, spec, &task_id,
                        "fleet_budget_exhausted", &reason,
                    ) {
                        eprintln!("미시작 구성원 기록 실패: {message}");
                    }
                    reports[index] = Some(MemberReport::not_started(index, &spec.branch, &task_id, reason));
                }
            }
        }

        if running.is_empty() {
            break;
        }

        // ---- 하나가 끝나기를 기다린다 ----
        let done = rx.recv().map_err(|e| format!("구성원 결과를 받지 못했습니다: {e}"))?;
        let member = running.remove(&done.index).expect("도는 구성원");
        let _ = member.handle.join();
        // **비용은 저장소가 말한다.** Node의 주장이 아니라 `provider_usage` 행이다 —
        // 합계 상한의 근거가 sidecar에 있으면 장악당한 sidecar가 상한을 지웠다고 말할 수 있다.
        let (cost_usd, _, _) = store
            .lock()
            .unwrap()
            .task_cost_usd(&member.task_id)
            .unwrap_or((0.0, 0, 0));
        budget.settle(member.reserved_usd, cost_usd);
        let _ = member.host.append_event(
            &member.task_id,
            "FLEET_MEMBER_SETTLED",
            json!({
                "fleetId": fleet_id,
                "branch": member.branch,
                "memberIndex": done.index + 1,
                "status": done.status,
                "costUsd": cost_usd,
                "reservedUsd": member.reserved_usd,
                "fleetCommittedUsd": budget.committed_usd(),
            }),
        );
        eprintln!(
            "구성원 종료: {} → {} (${cost_usd:.4}) / Fleet 합계 ${:.4}",
            member.branch,
            done.status,
            budget.committed_usd()
        );
        reports[done.index] = Some(MemberReport {
            index: done.index,
            branch: member.branch,
            task_id: member.task_id,
            admitted: true,
            worktree_path: Some(member.worktree_path),
            status: done.status,
            summary: done.summary,
            cost_usd,
            reserved_usd: member.reserved_usd,
            started_at: Some(member.started_at),
            finished_at: Some(done.finished_at),
        });
    }

    let members: Vec<MemberReport> = reports
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            r.unwrap_or_else(|| {
                MemberReport::not_started(i, &plan.members[i].branch, "", "결말이 기록되지 않았습니다".to_string())
            })
        })
        .collect();
    let report = tomverse_core::fleet::FleetReport::build(
        &fleet_id,
        members,
        &budget,
        tomverse_core::verify::lane_stats(),
    );
    for notice in report.notices() {
        eprintln!("{notice}");
    }
    println!(
        "{}",
        json!({
            "fleet": report,
            "dbPath": db_path.to_string_lossy(),
            "sessionId": session_id,
        })
    );
    // **부분 실패를 성공으로 접지 않는다.**
    Ok(if report.all_completed() { 0 } else { 1 })
}

/// 합계 상한이 남지 않아 시작하지 못한 구성원을 **기록으로 남긴다**(원칙 7).
///
/// 기록하지 않으면 그 구성원은 화면에서 사라진다 — 사용자는 자기가 N개를 요청했는데 결말이
/// N-1개인 것을 보게 되고, 없어진 하나가 실패인지 시작조차 안 한 것인지 알 방법이 없다.
/// 그리고 나중에 기록을 여는 사람에게는 **그 태스크가 아예 존재한 적 없는 것**이 된다.
#[allow(clippy::too_many_arguments)]
fn record_unstarted_member(
    store: &Arc<Mutex<Store>>,
    repo: &WorkspaceRoot,
    session_id: &str,
    fleet_id: &str,
    fleet_size: usize,
    index: usize,
    spec: &tomverse_core::fleet::MemberSpec,
    task_id: &str,
    // 사유 **코드**. 문장과 따로 두는 이유: 기록을 읽는 쪽이 문장을 다시 뜯게 하지 않는다.
    reason_code: &str,
    reason: &str,
) -> Result<(), String> {
    let workspace_id = tomverse_core::paths::workspace_id_for(&repo.display());
    let mut guard = store.lock().unwrap();
    guard
        .upsert_session(session_id, &workspace_id, Some("fleet"))
        .map_err(|e| e.to_string())?;
    // **본체 경로로 만든다.** 시작하지 않았으므로 격리 트리도 만들지 않았고, 있지도 않은
    // 경로를 기록에 적으면 그 기록을 여는 사람이 없는 디렉터리를 찾게 된다.
    guard
        .create_task(task_id, session_id, &workspace_id, &repo.display(), "verified", &spec.message)
        .map_err(|e| e.to_string())?;
    guard
        .append_event(
            task_id,
            "FLEET_ENROLLED",
            &json!({
                "fleetId": fleet_id,
                "branch": spec.branch,
                "memberIndex": index + 1,
                "fleetSize": fleet_size,
                "admitted": false,
                "reason": reason,
            }),
        )
        .map_err(|e| e.to_string())?;
    guard
        .finish_task(
            task_id,
            "REJECTED",
            "TASK_REJECTED",
            None,
            &json!({ "reason": reason_code, "detail": reason }),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 구성원 하나를 시작한다: worktree 확보 → 태스크 생성 → 등록 이벤트 → 스레드.
#[allow(clippy::too_many_arguments)]
fn start_member(
    args: &Args,
    repo: &WorkspaceRoot,
    parent_dir: &Path,
    store: &Arc<Mutex<Store>>,
    artifacts: &ArtifactStore,
    approvals: &Arc<dyn ApprovalGateway>,
    sink: &Arc<dyn EventSink>,
    cancels: &Arc<CancellationRegistry>,
    skill: Option<tomverse_core::skills::Skill>,
    policy: TaskPolicy,
    fleet_id: &str,
    fleet_size: usize,
    index: usize,
    spec: &tomverse_core::fleet::MemberSpec,
    session_id: &str,
    reserved_usd: Option<f64>,
    tx: std::sync::mpsc::Sender<MemberDone>,
) -> Result<RunningMember, String> {
    // **격리는 루트를 바꾸는 것이 전부다**(22.1절). 구성원은 자기 트리를 루트로 받는
    // 평범한 태스크가 된다.
    let wt = tomverse_core::worktree::ensure(
        repo.path(),
        parent_dir,
        &spec.branch,
        args.worktree_base.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    let isolation = tomverse_core::worktree::Isolation::of(repo.path(), &wt);
    for notice in isolation.notices() {
        eprintln!("[{}] {notice}", spec.branch);
    }
    let member_root = WorkspaceRoot::new(&wt.path).map_err(|e| format!("{:?}를 열 수 없습니다: {e}", wt.path))?;
    let workspace_id = tomverse_core::paths::workspace_id_for(&member_root.display());
    let task_id = format!("task-{}", uuid::Uuid::new_v4());
    {
        let mut guard = store.lock().unwrap();
        guard
            .upsert_workspace(&workspace_id, &member_root.display(), &spec.branch)
            .map_err(|e| format!("워크스페이스 기록 실패: {e}"))?;
        guard
            .upsert_session(session_id, &workspace_id, Some("fleet"))
            .map_err(|e| format!("세션 기록 실패: {e}"))?;
        guard
            .create_task(
                &task_id,
                session_id,
                &workspace_id,
                &member_root.display(),
                match args.mode {
                    ExecutionMode::Fast => "fast",
                    ExecutionMode::Verified => "verified",
                },
                &spec.message,
            )
            .map_err(|e| format!("태스크 생성 실패: {e}"))?;
    }

    let origin = tomverse_core::types::ApprovalOrigin {
        fleet_id: fleet_id.to_string(),
        member_index: index + 1,
        fleet_size,
        branch: spec.branch.clone(),
    };
    let member_sink: Arc<dyn EventSink> = Arc::new(MemberSink {
        inner: sink.clone(),
        label: spec.branch.clone(),
    });
    let host = Arc::new(
        TaskHost::new(
            member_root,
            policy.clone(),
            store.clone(),
            artifacts.clone(),
            approvals.clone(),
            member_sink,
            cancels.clone(),
        )
        .with_isolation(isolation)
        // **승인 화면이 어느 트리의 것인지 말할 수 있어야 한다**(11.6①). 게이트는 이 값을
        // 보지 않는다 — 보게 되면 "Fleet일 때만 다른 규칙"이 생긴다.
        .with_fleet_member(origin),
    );
    host.begin_task(&task_id, policy, skill.as_ref())?;
    // **등록을 이벤트로 남긴다**(원칙 7). Fleet 단위 상태를 메모리에만 두면 크래시 후
    // "무엇이 돌고 있었나"에 답할 수 없다. `FLEET_ENROLLED`는 `NODE_MAY_NOT_EMIT`에 있으므로
    // sidecar가 자기를 이 집합에 넣을 수 없다.
    host.append_event(
        &task_id,
        "FLEET_ENROLLED",
        json!({
            "fleetId": fleet_id,
            "branch": spec.branch,
            "memberIndex": index + 1,
            "fleetSize": fleet_size,
            "admitted": true,
            "reservedUsd": reserved_usd,
            "worktreePath": wt.path.to_string_lossy(),
            "reusedTree": !wt.created,
        }),
    )?;

    let control = Arc::new(MemberControl::default());
    let started_at = tomverse_core::time::now_iso();
    // 구성원은 자기 요청으로 도는 **평범한 `run`**이다 — 메시지만 다르다.
    let mut member_args = args.clone();
    member_args.command = "run".to_string();
    member_args.message = spec.message.clone();
    member_args.cancel_after_ms = None;

    let thread_host = host.clone();
    let thread_control = control.clone();
    let thread_task = task_id.clone();
    let thread_session = session_id.to_string();
    let thread_workspace = workspace_id.clone();
    let handle = std::thread::spawn(move || {
        let outcome = run_task(
            &member_args,
            thread_host,
            &thread_workspace,
            &thread_session,
            &thread_task,
            skill.as_ref(),
            Some(thread_control),
        );
        let (status, summary) = match outcome {
            Ok(value) => (
                value.get("status").and_then(Value::as_str).unwrap_or("failed").to_string(),
                value.get("summary").and_then(Value::as_str).unwrap_or("").to_string(),
            ),
            Err(message) => ("failed".to_string(), message),
        };
        // **보내지 못하면 스케줄러가 영원히 기다린다.** 받는 쪽이 사라지는 경우는 스케줄러가
        // 이미 끝난 때뿐이고, 그때는 보낼 곳이 없는 것이 맞다.
        let _ = tx.send(MemberDone {
            index,
            status,
            summary,
            finished_at: tomverse_core::time::now_iso(),
        });
    });

    Ok(RunningMember {
        branch: spec.branch.clone(),
        task_id,
        host,
        control,
        reserved_usd,
        worktree_path: wt.path.to_string_lossy().to_string(),
        started_at,
        handle,
    })
}

/// 개발 모드 sidecar 경로 해석용 리포지토리 루트.
/// 배포판에서는 `--sidecar`로 번들된 진입점을 넘긴다.
fn workspace_name(root: &WorkspaceRoot) -> &str {
    root.path().file_name().and_then(|n| n.to_str()).unwrap_or("workspace")
}
