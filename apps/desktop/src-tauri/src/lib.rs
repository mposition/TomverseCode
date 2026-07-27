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
use tauri::Manager;
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
        session.start_task(&message, execution_mode, timeout)
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

/// ui-wireframes.md 3.4절 확인 필요 카드의 답변.
#[tauri::command]
fn provide_user_input(
    state: tauri::State<'_, SessionState>,
    task_id: String,
    message: String,
) -> Result<Value, String> {
    state.provide_user_input(&task_id, &message)
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
#[tauri::command]
fn task_events(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    state.with_active(|active| {
        let events = active
            .host
            .with_store(|s| s.events(&task_id))
            .map_err(|e| format!("이벤트를 읽을 수 없습니다: {e}"))?;
        Ok(json!(events
            .into_iter()
            .map(|e| json!({
                "eventId": e.event_id,
                "seq": e.seq,
                "type": e.event_type,
                "payload": e.payload,
                "createdAt": e.created_at,
            }))
            .collect::<Vec<_>>()))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(SessionState::default());
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
            rollback_task,
            task_events,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
