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
//!                   [--approve auto|deny] [--db <path>] [--artifacts <path>]
//!                   [--sidecar <index.js>] [--auto-approve-writes] [--allow-git-commit]
//!                   [--cancel-after-ms <n>] [--verbose]
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

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tomverse_core::artifacts::ArtifactStore;
use tomverse_core::host::{AlwaysDeny, ApprovalGateway, AutoApprove, EventSink, TaskHost};
use tomverse_core::sidecar::{SidecarClient, SpawnConfig};
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
    allow_git_commit: bool,
    timeout_secs: u64,
    verbose: bool,
    /// 시나리오 A용: 실행 시작 후 N ms 뒤에 스스로 취소를 요청한다.
    ///
    /// 테스트 편의 기능이지만, **실행되는 취소 경로는 실제 경로와 동일하다** —
    /// 같은 registry, 같은 토큰, 같은 프로세스 트리 종료 코드를 탄다. 별도 mock이 아니다.
    cancel_after_ms: Option<u64>,
    /// `metrics` 전용: 워크스페이스 필터를 끄고 DB 전체를 집계한다.
    all_workspaces: bool,

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
        allow_git_commit: false,
        timeout_secs: 600,
        verbose: false,
        cancel_after_ms: None,
        all_workspaces: false,
        providers: None,
        review_mode: None,
        replay_draft: None,
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
            "--db" => args.db = Some(PathBuf::from(value()?)),
            "--artifacts" => args.artifacts = Some(PathBuf::from(value()?)),
            "--sidecar" => args.sidecar = Some(PathBuf::from(value()?)),
            "--auto-approve-writes" => args.auto_approve_writes = true,
            "--allow-git-commit" => args.allow_git_commit = true,
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
            "--verbose" => args.verbose = true,
            "--all-workspaces" => args.all_workspaces = true,
            other => return Err(format!("알 수 없는 인자: {other}\n\n{}", usage())),
        }
    }
    Ok(args)
}

fn usage() -> String {
    "usage: tomverse-host <run|rollback|revert|recover|tasks|show|metrics> --workspace <path> [--message <text>] \
     [--task <id>] [--mode fast|verified] [--approve auto|deny] [--db <path>] [--artifacts <path>] \
     [--sidecar <index.js>] [--auto-approve-writes] [--allow-git-commit] [--cancel-after-ms <n>] [--verbose]\n\
     \n\
     가설 게이트 전용: [--providers <csv>] [--review-mode blind|informed] [--replay-draft <file>]\n\
     \n\
     recover — 앱 재시작 시나리오: 터미널이 아닌 태스크를 INTERRUPTED로 확정한다\n\
     tasks   — 저장된 작업 목록을 JSON으로 출력한다\n\
     show    — 한 작업의 상태·이벤트·mutation·검증 기록을 JSON으로 출력한다\n\
     revert  — 이 작업이 만든 커밋을 git revert로 되돌린다 (0=되돌림, 1=되돌리지 않음·저장소 그대로, 2=revert 진행 중으로 남음)\n\
     metrics — 기준 계측(커버리지/충돌 결말)을 JSON으로 집계한다. 읽기 전용.\n\
               [--all-workspaces]로 워크스페이스 필터를 끈다"
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

fn real_main() -> Result<i32, String> {
    let args = parse_args()?;

    let root = WorkspaceRoot::new(&args.workspace)
        .map_err(|e| format!("워크스페이스 {:?}를 열 수 없습니다: {e}", args.workspace))?;

    let artifacts_root = args.artifacts.clone().unwrap_or_else(ArtifactStore::default_root);
    let artifacts = ArtifactStore::new(&artifacts_root).map_err(|e| format!("artifact 저장소 오류: {e}"))?;

    let db_path = args
        .db
        .clone()
        .unwrap_or_else(|| artifacts_root.parent().unwrap_or(&artifacts_root).join("state.db"));
    let store = Arc::new(Mutex::new(
        Store::open(&db_path, artifacts.clone()).map_err(|e| format!("SQLite 오류: {e}"))?,
    ));

    let workspace_id = format!("ws-{}", short_hash(&root.display()));
    store
        .lock()
        .unwrap()
        .upsert_workspace(&workspace_id, &root.display(), workspace_name(&root))
        .map_err(|e| format!("워크스페이스 기록 실패: {e}"))?;

    let policy = TaskPolicy {
        auto_approve_workspace_writes: args.auto_approve_writes,
        allow_git_commit: args.allow_git_commit,
        execution_mode: args.mode,
        ..TaskPolicy::default()
    };

    let approvals: Arc<dyn ApprovalGateway> = match args.approve.as_str() {
        "auto" => Arc::new(AutoApprove),
        "deny" => Arc::new(AlwaysDeny),
        other => return Err(format!("알 수 없는 --approve: {other} (auto|deny)")),
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

            let host = Arc::new(TaskHost::new(
                root,
                policy,
                store.clone(),
                artifacts,
                approvals,
                sink,
                Arc::new(CancellationRegistry::new()),
            ));
            let final_result = run_task(&args, host.clone(), &workspace_id, &session_id, &task_id)?;

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
    let sidecar_entry = args
        .sidecar
        .clone()
        .unwrap_or_else(|| SidecarClient::dev_entry(&repo_root()));
    if !sidecar_entry.exists() {
        return Err(format!(
            "sidecar 진입점을 찾을 수 없습니다: {}\n먼저 `npm run build`를 실행하세요.",
            sidecar_entry.display()
        ));
    }

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

    let client = SidecarClient::spawn(
        SpawnConfig {
            program: "node".to_string(),
            args: vec![sidecar_entry.to_string_lossy().to_string()],
            working_dir: None,
            env,
        },
        host.clone(),
    )
    .map_err(|e| format!("sidecar를 spawn할 수 없습니다: {e}"))?;

    // process-architecture.md 5절 — ready 대기 타임아웃 10초.
    let ready = client.wait_ready(Duration::from_secs(10))?;
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
            "allowGitCommit": args.allow_git_commit,
            "executionMode": match args.mode { ExecutionMode::Fast => "fast", ExecutionMode::Verified => "verified" },
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
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("..")
}

fn workspace_name(root: &WorkspaceRoot) -> &str {
    root.path().file_name().and_then(|n| n.to_str()).unwrap_or("workspace")
}

fn short_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}
