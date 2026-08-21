//! Tauri 앱 — UI 프로세스와 Rust 신뢰 경계의 연결부.
//!
//! **이 크레이트에는 보안 로직이 없다.** Policy Gate, Tool Runtime, 저장, 검증은 모두
//! `tomverse-core`에 있고 여기서는 Tauri command/event 배관만 한다 (CLAUDE.md "보안 로직과
//! UI 로직을 섞지 않는다").
//!
//! UI가 갖지 않는 것(process-architecture.md 7절): API 키, 셸 실행 권한, 파일 쓰기 권한.
//! 아래 command 목록에 그런 능력을 주는 것이 하나도 없다는 점이 그 원칙의 실체다 —
//! UI는 "이 워크스페이스에서 이 작업을 해달라"고 요청할 수 있을 뿐, 무엇을 실행할지 지정할 수 없다.

mod session;

use std::time::Duration;

use serde_json::{json, Value};
use session::SessionState;
use tauri::{Emitter, Manager};
use tomverse_core::types::{ExecutionMode, TaskPolicy};
use tomverse_core::{PROTOCOL_VERSION, PROVIDER_ENV_VARS};

/// 워크스페이스 열기.
///
/// 경로는 UI가 문자열로 넘기지만 Rust가 canonicalize하고 디렉터리인지 확인한다.
/// 이후 모든 파일 접근은 이 루트를 벗어날 수 없다(`WorkspaceRoot`).
#[tauri::command]
async fn open_workspace(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    // SQLite 열기와 프로세스 spawn은 블로킹이다 — async 런타임 스레드를 막지 않는다.
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.open_workspace(&app, &path, TaskPolicy::default())
    })
    .await
    .map_err(|e| format!("워크스페이스 열기 스레드 오류: {e}"))?
}

#[tauri::command]
fn current_workspace(state: tauri::State<'_, SessionState>) -> Option<Value> {
    state.info()
}

/// 자격증명 **보유 여부만** 알려준다. 값은 절대 UI로 나가지 않는다 (작업 지침 4.9절).
#[tauri::command]
fn provider_status() -> Value {
    let providers: Vec<Value> = PROVIDER_ENV_VARS
        .iter()
        .map(|(id, env_name)| {
            let configured = std::env::var(env_name).map(|v| !v.trim().is_empty()).unwrap_or(false);
            json!({ "providerId": id, "envName": env_name, "configured": configured })
        })
        .collect();
    let configured_count = providers
        .iter()
        .filter(|p| p["configured"].as_bool() == Some(true))
        .count();
    json!({
        "providers": providers,
        // M0에서는 Windows Credential Manager 연동 대신 환경변수를 지원한다.
        // UI가 이걸 "개발용 임시 방식"으로 표시하도록 명시적으로 알린다.
        "source": "environment",
        "isDevelopmentOnly": true,
        // 서로 다른 공급자 2개 이상이 있어야 교차검증(검수자 독립성 불변식)이 성립한다.
        "crossVerificationPossible": configured_count >= 2,
        "protocolVersion": PROTOCOL_VERSION,
    })
}

#[tauri::command]
async fn start_task(
    app: tauri::AppHandle,
    message: String,
    mode: String,
    /// 검증 통과 후 커밋을 **제안할지**. 승인 등급은 낮추지 않는다(session.rs 주석 참조).
    allow_git_commit: Option<bool>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let execution_mode = match mode.as_str() {
        "fast" => ExecutionMode::Fast,
        "verified" => ExecutionMode::Verified,
        other => return Err(format!("알 수 없는 실행 정책: {other}")),
    };
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(900));

    // 태스크 실행은 승인 대기 때문에 오래 블록된다. 별도 스레드로 보내야 그 사이에
    // `respond_approval` command가 처리될 수 있다 — 같은 스레드면 교착된다.
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.start_task(&message, execution_mode, allow_git_commit.unwrap_or(false), timeout)
    })
    .await
    .map_err(|e| format!("태스크 실행 스레드 오류: {e}"))?
}

/// ui-wireframes.md 3.3절 승인 모달의 응답. Node를 거치지 않고 Rust가 직접 받는다.
#[tauri::command]
fn respond_approval(
    state: tauri::State<'_, SessionState>,
    approval_id: String,
    granted: bool,
    note: Option<String>,
) -> Result<Value, String> {
    state.respond_approval(&approval_id, granted, note)
}

#[tauri::command]
fn cancel_task(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    state.cancel_task(&task_id)
}

/// ui-wireframes.md 3.4절 확인 필요 카드 / 3.9절 불일치 카드의 답변.
///
/// `decisions`는 3.9절 카드에서만 온다 — 어떤 쟁점에 대한 답인지를 문장 파싱이 아니라 id로
/// 남기기 위한 것이다. Rust는 그 내용을 해석하지 않고 sidecar로 통과시킨다.
#[tauri::command]
fn provide_user_input(
    state: tauri::State<'_, SessionState>,
    task_id: String,
    message: String,
    decisions: Option<Value>,
) -> Result<Value, String> {
    state.provide_user_input(&task_id, &message, decisions)
}

/// "취소 중"에서 기다리기를 그만둔다 (12절 미해결 "취소 중 상한").
///
/// **프로세스를 죽이지 않는다** — 죽일 수 있었으면 이 명령이 필요하지 않았다. 태스크를
/// 터미널로 확정해 사용자를 놓아주고, 남은 프로세스가 있을 수 있다는 사실을 기록한다.
#[tauri::command]
fn force_abandon_task(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    state.force_abandon_task(&task_id)
}

/// 이 작업이 만든 커밋을 `git revert`로 되돌린다 (19절).
///
/// 파일 되돌리기와 **별도 명령**인 이유: 둘은 저장소에 남기는 결과가 다르다. 하나로 합치고
/// 내부에서 알아서 고르면, 사용자는 자기가 무엇을 눌렀는지 모른 채 이력이 바뀌는 것을 본다.
///
/// 결과는 하나가 아니다 — 되돌렸는지(`reverted`), 충돌했는지(`conflicted`), 저장소가 시작 전으로
/// 돌아왔는지(`cleanedUp`)를 따로 돌려준다(19.3절). UI가 셋을 합쳐서 말하면, 사용자가 지금
/// 손대야 하는 유일한 상태를 "아무것도 안 바뀌었습니다"로 보고하게 된다.
#[tauri::command]
async fn revert_task_commit(app: tauri::AppHandle, task_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.with_active(|active| active.host.revert_commit(&task_id))
    })
    .await
    .map_err(|e| format!("되돌리기 스레드 오류: {e}"))?
}

/// ui-wireframes.md 3.6절 롤백. 일반 ToolRequest 경로와 이벤트 로그를 그대로 탄다.
#[tauri::command]
async fn rollback_task(app: tauri::AppHandle, task_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.with_active(|active| active.host.rollback(&task_id))
    })
    .await
    .map_err(|e| format!("롤백 스레드 오류: {e}"))?
}

/// 개발자 모드 로그 뷰용 — 이벤트 로그 원본 (ui-wireframes.md 2절).
///
/// **워크스페이스가 열려 있지 않아도 동작한다.** 저장된 작업의 타임라인은 앱을 다시 켠 직후
/// (아직 워크스페이스를 고르기 전에도) 봐야 하는 정보이기 때문이다.
/// `after_event_id`를 주면 그 이후만 돌려준다 — UI가 이미 받은 이벤트를 다시 그리지 않도록.
#[tauri::command]
fn get_task_events(
    state: tauri::State<'_, SessionState>,
    task_id: String,
    after_event_id: Option<i64>,
) -> Result<Value, String> {
    state.get_task_events(&task_id, after_event_id)
}

/// 최근 작업 목록. `workspace_path`가 없으면 전체.
#[tauri::command]
fn list_tasks(
    state: tauri::State<'_, SessionState>,
    workspace_path: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
) -> Result<Value, String> {
    // 상한을 두는 이유: UI가 limit를 크게 넘겨 전체 이력을 한 번에 끌어오지 못하게 한다.
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let rows = state.list_tasks(workspace_path.as_deref(), limit, cursor.as_deref())?;
    // 다음 페이지 커서는 마지막 행의 created_at — 목록이 limit을 채웠을 때만 의미가 있다.
    let next_cursor = if rows.len() as i64 == limit {
        rows.last().map(|r| r.created_at.clone())
    } else {
        None
    };
    Ok(json!({ "tasks": rows, "nextCursor": next_cursor }))
}

#[tauri::command]
fn get_task(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    let task = state.get_task(&task_id)?;
    let (mutated, criteria) = if task.is_some() {
        (state.task_mutations(&task_id)?, state.task_acceptance_criteria(&task_id)?)
    } else {
        (Vec::new(), Value::Null)
    };
    Ok(json!({ "task": task, "mutatedPaths": mutated, "acceptanceCriteria": criteria }))
}

/// 저장된 작업을 **새 task_id로** 처음부터 다시 실행한다 (부분 재개가 아니다).
#[tauri::command]
async fn restart_task(app: tauri::AppHandle, task_id: String, timeout_secs: Option<u64>) -> Result<Value, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(900));
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.restart_task(&task_id, timeout)
    })
    .await
    .map_err(|e| format!("재실행 스레드 오류: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(SessionState::default());

            // 저장 계층을 앱 시작 시 연다. 여기서 **비정상 종료로 남은 작업이 INTERRUPTED로
            // 확정된다** — 이 시점을 지나야 "실행 중"으로 보이는 유령 작업이 사라진다.
            // 실패해도 앱을 죽이지 않는다: 이력을 못 봐도 새 작업은 할 수 있어야 한다.
            // 대신 UI에 알려서 조용한 데이터 손실로 보이지 않게 한다.
            let state = app.state::<SessionState>();
            let payload = match state.initialize() {
                Ok(info) => json!({ "ok": true, "recovery": info }),
                Err(message) => json!({ "ok": false, "error": message }),
            };
            let _ = app.emit("store-ready", payload);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            current_workspace,
            provider_status,
            start_task,
            respond_approval,
            cancel_task,
            provide_user_input,
            force_abandon_task,
            rollback_task,
            revert_task_commit,
            get_task_events,
            list_tasks,
            get_task,
            restart_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
