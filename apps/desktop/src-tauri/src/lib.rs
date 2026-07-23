mod sidecar;

use sidecar::SidecarHandle;
use serde_json::Value;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// process-architecture.md 3절 스모크 테스트용 — Node sidecar에 ping을 보내 왕복 확인.
// 실제 task.start 흐름을 타려면 TaskRequest/WorkspaceSnapshot을 구성해야 하므로,
// 이 단계에서는 연결성 자체만 검증한다.
#[tauri::command]
async fn check_sidecar_connection(state: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    state.request("ping", serde_json::json!({})).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let sidecar = SidecarHandle::spawn(handle)?;
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, check_sidecar_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
