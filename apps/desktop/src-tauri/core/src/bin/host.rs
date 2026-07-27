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
//! tomverse-host rollback --workspace <path> --task <taskId> --db <path> [--artifacts <path>]
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tomverse_core::artifacts::ArtifactStore;
use tomverse_core::host::{AlwaysDeny, ApprovalGateway, AutoApprove, EventSink, TaskHost};
use tomverse_core::sidecar::{SidecarClient, SpawnConfig};
use tomverse_core::store::Store;
use tomverse_core::types::{ExecutionMode, TaskPolicy};
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
            "--verbose" => args.verbose = true,
            other => return Err(format!("알 수 없는 인자: {other}\n\n{}", usage())),
        }
    }
    Ok(args)
}

fn usage() -> String {
    "usage: tomverse-host <run|rollback> --workspace <path> [--message <text>] [--task <id>] \
     [--mode fast|verified] [--approve auto|deny] [--db <path>] [--artifacts <path>] \
     [--sidecar <index.js>] [--auto-approve-writes] [--allow-git-commit] [--verbose]"
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
    let mut store = Store::open(&db_path, artifacts.clone()).map_err(|e| format!("SQLite 오류: {e}"))?;

    let workspace_id = format!("ws-{}", short_hash(&root.display()));
    store
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
            store
                .upsert_session(&session_id, &workspace_id, Some("headless"))
                .map_err(|e| format!("세션 기록 실패: {e}"))?;
            store
                .create_task(&task_id, &session_id, &workspace_id, &args.message)
                .map_err(|e| format!("태스크 생성 실패: {e}"))?;

            let host = Arc::new(TaskHost::new(root, policy, store, artifacts, approvals, sink));
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
            let host = TaskHost::new(root, policy, store, artifacts, approvals, sink);
            let result = host.rollback(&task_id)?;
            println!("{result}");
            let failed = result
                .get("failed")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            Ok(if failed == 0 { 0 } else { 1 })
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
        p
    } else {
        providers
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
            "allowGitCommit": args.allow_git_commit,
            "executionMode": match args.mode { ExecutionMode::Fast => "fast", ExecutionMode::Verified => "verified" },
        },
        "workspaceName": workspace_name(host.root()),
        "availableProviders": providers,
    });

    let outcome = client.request("task.start", params, Duration::from_secs(args.timeout_secs));
    client.shutdown(Duration::from_secs(3));

    match outcome {
        Ok(value) => Ok(value),
        Err(message) => {
            // sidecar가 죽었어도 이벤트 로그로 마지막 상태를 설명할 수 있어야 한다.
            let _ = host.append_event(
                task_id,
                "TASK_FAILED",
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
