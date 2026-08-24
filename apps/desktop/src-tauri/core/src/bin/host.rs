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
    /// `metrics` 전용: 워크스페이스 필터를 끄고 DB 전체를 집계한다.
    all_workspaces: bool,
    /// `windows-landing` 전용 — tauri 번들 디렉터리.
    bundle: Option<PathBuf>,

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
}

fn parse_args() -> Result<Args, String> {
    let mut raw = std::env::args().skip(1);
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
        allow_git_commit: false,
        budget_usd: None,
        pin_executor: None,
        pin_reviewer: None,
        timeout_secs: 600,
        verbose: false,
        cancel_after_ms: None,
        mcp_servers: Vec::new(),
        worktree: None,
        worktree_base: None,
        force: false,
        all_workspaces: false,
        bundle: None,
        providers: None,
        review_mode: None,
        replay_draft: None,
        file: None,
        accept_fingerprint: None,
        apply: false,
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
            "--worktree-base" => args.worktree_base = Some(value()?),
            "--force" => args.force = true,
            "--mcp-server" => args.mcp_servers.push(parse_mcp_server(&value()?)?),
            "--db" => args.db = Some(PathBuf::from(value()?)),
            "--artifacts" => args.artifacts = Some(PathBuf::from(value()?)),
            "--sidecar" => args.sidecar = Some(PathBuf::from(value()?)),
            "--auto-approve-writes" => args.auto_approve_writes = true,
            "--auto-approve-verification" => args.auto_approve_verification = true,
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
    "usage: tomverse-host <run|rollback|revert|recover|tasks|show|blocked|metrics|transmission|export|reproduce|worktree|windows-landing> --workspace <path> [--message <text>] \
     [--task <id>] [--mode fast|verified] [--approve auto|deny|autopilot] [--db <path>] [--artifacts <path>] \
     [--sidecar <index.js>] [--auto-approve-writes] [--auto-approve-verification]\n\
     [--allow-git-commit] [--cancel-after-ms <n>]\n\
     [--budget-usd <n>] [--pin-executor <modelId>] [--pin-reviewer <modelId>] [--verbose]\n\
     \n\
     가설 게이트 전용: [--providers <csv>] [--review-mode blind|informed] [--replay-draft <file>]\n\
     \n\
     run --worktree <branch> — 격리 실행. 그 브랜치의 worktree를 만들고 **그 경로를 워크스페이스\n\
                 루트로 쓴다**. 브랜치가 없으면 만들고, 출발점은 [--worktree-base <ref>].\n\
                 본체의 커밋되지 않은 변경은 따라오지 않으며 그 사실을 stderr로 알린다\n\
     run --mcp-server <이름=프로그램[,인자...]> — MCP 서버 등록(반복 가능). **셸 문자열이 아니라\n\
                 쉼표로 나눈 argv다.** 그 도구는 `mcp_call`로 변환되어 Policy Gate를 지나며,\n\
                 **언제나 사용자 승인을 요구한다**(정책으로 낮출 수 없다)\n\
     --approve autopilot — **무인 실행.** 정책이 자동 허용하는 것만 진행하고, 승인이 필요한\n\
                 지점에 닿으면 멈춘다(대신 승인해 주지 않는다). `auto`는 전부 승인하는\n\
                 **테스트 전용** 모드이며 Autopilot이 아니다\n\
     --auto-approve-verification — 프로젝트가 매니페스트에 **선언해 둔** 검증 명령을 묻지 않고\n\
                 실행한다. 집합은 태스크 시작 시점에 고정된다 — 실행 중에 매니페스트가 바뀌어도\n\
                 새 명령은 자동 승인되지 않는다. Autopilot이 검증까지 도달하려면 이게 필요하다\n\
     worktree — 격리 트리 목록(JSON). [--worktree <branch>]를 주면 그 트리를 정리한다.\n\
                 커밋되지 않은 변경이 있으면 지우지 않고 사유를 낸다 — 버리려면 [--force]\n\
     recover — 앱 재시작 시나리오: 터미널이 아닌 태스크를 INTERRUPTED로 확정한다\n\
     blocked — 무인 정지의 처방(JSON). 무엇이 막았고 **무엇을 켜면 지나가는지**, 그리고\n\
                 어떤 정지는 정책으로 열 수 없는지를 기록에서 유도한다. 아무것도 쓰지 않는다.\n\
                 이번 실행이 도달한 지점까지만 안다 — 켜고 다시 돌리면 더 진행하다 또 멈출 수 있다\n\
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
                 [--bundle <경로>]로 tauri-build 산출물을 가리키면 번들 기준까지 본다"
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
    })
}

/// 격리 트리를 어디에 만드는가.
///
/// **저장소 안에 만들지 않는다** — 안에 만들면 부모 워크스페이스의 게이트 루트가 그것을
/// 포함해서, 본체에서 도는 태스크가 격리된 트리를 고칠 수 있다(worktree.rs 모듈 주석).
/// 상태 디렉터리(`--db`가 사는 곳) 아래에 둔다: 태스크 기록과 같은 수명이라 정리 시점도 같다.
fn worktree_parent_dir(args: &Args) -> PathBuf {
    let state_dir = args
        .db
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| args.workspace.join(".tomverse"));
    state_dir.join("worktrees")
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
            // **본체의 커밋되지 않은 변경은 따라오지 않는다.** 말하지 않으면 사용자는 자기가
            // 방금 고친 코드에 대해 태스크가 돈다고 믿고, 결과 diff를 "모델이 내 수정을
            // 되돌렸다"로 읽는다.
            if let Some(notice) = tomverse_core::worktree::isolation_notice(
                tomverse_core::worktree::is_dirty(repo.path()),
                &wt,
            ) {
                eprintln!("{notice}");
            }
            eprintln!(
                "격리 실행: {} ({}) — {}",
                wt.path.display(),
                wt.branch,
                if wt.created { "새로 만듦" } else { "기존 트리 재사용" }
            );
            Some(wt)
        }
        None => None,
    };

    let workspace_path = isolated
        .as_ref()
        .map(|w| w.path.clone())
        .unwrap_or_else(|| args.workspace.clone());
    let root = WorkspaceRoot::new(&workspace_path)
        .map_err(|e| format!("워크스페이스 {workspace_path:?}를 열 수 없습니다: {e}"))?;

    // **재현 검사는 DB를 열지 않는다.** 감사자에게는 DB가 없다 — 그래서 export 파일이 있는
    // 것이고, 여기서 store를 열면 없던 state.db가 생긴다. "아무것도 쓰지 않는다"는 약속은
    // 그 파일 하나로 깨진다. 그래서 store를 만들기 **전에** 갈라진다.
    // **착지 검사도 DB를 열지 않는다.** 관측만 하고 아무것도 쓰지 않으므로, 여기서 store를
    // 열면 없던 state.db가 생긴다 — reproduce와 같은 이유로 store를 만들기 전에 갈라진다.
    if args.command == "windows-landing" {
        let report = tomverse_core::landing::assess(&tomverse_core::landing::Observations::here(args.bundle.clone()));
        println!("{}", serde_json::to_string(&report).unwrap_or_default());
        // **판정을 종료 코드에 싣지 않는다.** 실으면 "도구가 실패했다"와 "아직 착지하지
        // 않았다"가 같은 값이 된다 — reproduce가 같은 이유로 그렇게 한다.
        return Ok(0);
    }

    if args.command == "reproduce" {
        return reproduce_check(&args, &root);
    }

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

    let policy = TaskPolicy {
        auto_approve_workspace_writes: args.auto_approve_writes,
        auto_approve_verification: args.auto_approve_verification,
        allow_git_commit: args.allow_git_commit,
        execution_mode: args.mode,
        // sidecar가 완료 판정에 쓴다 — 무인 실행에서는 "검증되지 않음"을 완료로 보고하지 않는다.
        unattended: args.approve == "autopilot",
        ..TaskPolicy::default()
    };

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
        "run" => {
            if args.message.trim().is_empty() {
                return Err("run에는 --message가 필요합니다".to_string());
            }
            let session_id = format!("sess-{}", uuid::Uuid::new_v4());
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
            let mcp = if args.mcp_servers.is_empty() {
                None
            } else {
                Some(Arc::new(
                    tomverse_core::mcp::McpPool::new(args.mcp_servers.clone()).map_err(|e| e.to_string())?,
                ))
            };
            let mut task_host = TaskHost::new(
                root,
                policy,
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
            let host = Arc::new(task_host);
            let final_result = run_task(&args, host.clone(), &workspace_id, &session_id, &task_id);
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
                policy,
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
                policy,
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

fn run_task(
    args: &Args,
    host: Arc<TaskHost>,
    workspace_id: &str,
    session_id: &str,
    task_id: &str,
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
    ] {
        if let Ok(value) = std::env::var(key) {
            env.push((key.to_string(), value));
        }
    }

    let config = tomverse_core::launcher::config_from(&launcher, env);
    let client = SidecarClient::spawn(config, host.clone())
        .map_err(|e| format!("sidecar를 spawn할 수 없습니다: {e}\n{}", launcher.describe_failure()))?;

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

    let params = json!({
        "taskRequest": {
            "taskId": task_id,
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "userMessage": args.message,
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
        },
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
            let _ = host.finish_task(
                task_id,
                "FAILED",
                "TASK_FAILED",
                Some(&message),
                json!({ "status": "failed", "summary": message.clone() }),
            );
            Ok(json!({ "status": "failed", "summary": message, "taskId": task_id }))
        }
    }
}

/// 개발 모드 sidecar 경로 해석용 리포지토리 루트.
/// 배포판에서는 `--sidecar`로 번들된 진입점을 넘긴다.
fn workspace_name(root: &WorkspaceRoot) -> &str {
    root.path().file_name().and_then(|n| n.to_str()).unwrap_or("workspace")
}
