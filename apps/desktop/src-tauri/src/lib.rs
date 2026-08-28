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
// 봉투를 만드는 자리는 **한 곳**이고 그 자리는 core다 — 껍데기 크레이트는 이 개발
// 환경에서 컴파일되지 않으므로 화면과의 계약을 정하는 코드를 여기 두지 않는다.
use tomverse_core::uimsg::{envelope, UiMessage};

/// 화면이 종류를 보내지 않았을 때의 기본값 — 파일을 바꾸는 평범한 태스크 (51·53절).
///
/// **한 자리에 둔다.** 종류를 받는 명령이 셋이고(`start_task`·`autopilot_preview`·`restart_task`)
/// 각자 기본값을 적으면, 한 곳만 바뀌었을 때 **미리보기가 실행과 다른 종류에 대해 답한다.**
/// 그 어긋남은 "미리보기가 틀렸다"가 아니라 "도구가 거짓말했다"로 읽힌다(47절).
///
/// 기본값이 읽기 전용이 아닌 쪽인 것은 의도다: 화면은 언제나 종류를 보내고, 보내지 않는
/// 경우란 화면이 아닌 것이 부르는 경우다. 그때 조용히 읽기 전용으로 좁히면 **아무것도
/// 바꾸지 못하는 태스크가 이유 없이** 만들어지고, 그 실패는 원인과 멀다.
const DEFAULT_TASK_KIND: &str = "change";

/// 워크스페이스 열기.
///
/// 경로는 UI가 문자열로 넘기지만 Rust가 canonicalize하고 디렉터리인지 확인한다.
/// 이후 모든 파일 접근은 이 루트를 벗어날 수 없다(`WorkspaceRoot`).
///
/// `isolate_branch`가 있으면 **격리 트리에서 연다**(state-machine 38절). 여는 시점에 정하는
/// 이유는 38.1절 — 게이트 루트가 sidecar 수명과 묶여 있어 태스크마다 바꿀 수 없다.
#[tauri::command]
async fn open_workspace(
    app: tauri::AppHandle,
    path: String,
    isolate_branch: Option<String>,
) -> Result<Value, String> {
    // SQLite 열기와 프로세스 spawn은 블로킹이다 — async 런타임 스레드를 막지 않는다.
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.open_workspace(&app, &path, TaskPolicy::default(), isolate_branch.as_deref())
    })
    .await
    .map_err(|e| format!("워크스페이스 열기 스레드 오류: {e}"))?
}

#[tauri::command]
fn current_workspace(state: tauri::State<'_, SessionState>) -> Option<Value> {
    state.info()
}

/// 자격증명 **보유 여부만** 알려준다. 값은 절대 UI로 나가지 않는다 (원칙 3).
///
/// 무엇이 설정됐는가·어디서 왔는가·어떤 저장소인가는 전부 core가 판정한다
/// (`credential_presence`, `StoreKind`). 여기와 `session.rs`는 그 결과를 화면 모양으로
/// 옮길 뿐이며, **값을 담을 필드가 없다는 것이 이 명령의 계약이다.**
#[tauri::command]
fn provider_status(state: tauri::State<'_, SessionState>) -> Value {
    state.credential_status()
}

/// 키를 저장한다. **값은 이 함수로 들어가고 나오지 않는다.**
///
/// 화면은 입력 즉시 이걸 부르고 자기 상태에서 값을 지운다. 이후 조회는 `provider_status`
/// 하나이며 그것은 "있다/없다"만 돌려준다 — 착지 기준 `uiNeverHoldsTheKey`.
///
/// `async` + `spawn_blocking`인 이유: Windows Credential Manager 호출은 블로킹이다.
#[tauri::command]
async fn set_provider_credential(app: tauri::AppHandle, provider_id: String, secret: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionState>().set_credential(&provider_id, secret)
    })
    .await
    .map_err(|e| format!("자격증명 저장 스레드 오류: {e}"))?
}

/// 키를 지운다. `removed`는 **지울 것이 있었는가**다 — 없었던 것과 실패는 다른 사실이다.
#[tauri::command]
async fn delete_provider_credential(app: tauri::AppHandle, provider_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<SessionState>().delete_credential(&provider_id))
        .await
        .map_err(|e| format!("자격증명 삭제 스레드 오류: {e}"))?
}

/// 인자 설명이 `///`가 아니라 `//`인 이유: **Rust에는 파라미터 문서 주석이 없다.**
/// `///`를 붙이면 "documentation comments cannot be applied to function parameters"로
/// 컴파일이 깨진다. 설명을 함수 위로 몰면 어느 인자의 이야기인지가 흐려지므로 자리를
/// 지키고 형식만 바꿨다 — 되돌리지 말 것.
#[tauri::command]
async fn start_task(
    app: tauri::AppHandle,
    message: String,
    mode: String,
    // 검증 통과 후 커밋을 **제안할지**. 승인 등급은 낮추지 않는다(session.rs 주석 참조).
    allow_git_commit: Option<bool>,
    // 이 태스크의 예산 상한(USD). `budget_unlimited`와 함께 해석된다 —
    // **인자를 빠뜨린 화면이 상한을 조용히 끄지 못하게** 하는 것이 두 인자로 받는 이유다.
    budget_usd: Option<f64>,
    budget_unlimited: Option<bool>,
    // 역할별 모델 지정(`{ executor?, reviewer? }`). 없으면 라우터가 정한다.
    // **Rust는 해석하지 않고 그대로 넘긴다** — 모델 목록은 Node의 것이다.
    model_pins: Option<Value>,
    // 무인 실행 (state-machine 24절). 켜면 승인이 필요한 지점에서 **멈춘다** —
    // 대신 승인해 주지 않는다.
    unattended: Option<bool>,
    // 프로젝트가 매니페스트에 선언해 둔 검증 명령을 묻지 않고 실행한다 (24.5절).
    auto_approve_verification: Option<bool>,
    // 워크스페이스 안의 파일 쓰기를 묻지 않고 승인한다 (63절).
    //
    // **넓히는 방향이라 기본값이 `false`다.** 화면이 인자를 빠뜨리면 켜지는 것이 아니라
    // 꺼진다 — 넓히는 스위치의 기본값은 언제나 좁은 쪽이어야 한다.
    auto_approve_writes: Option<bool>,
    // 스킬 파일 경로 (26절). **Rust가 읽는다.**
    skill_path: Option<String>,
    // 이 요청이 **질문인가** (state-machine 51절). 참이면 파일을 바꾸지 않는 경로를 탄다.
    kind: Option<String>,
    // 이 태스크가 이어받는 앞선 태스크 (state-machine 70절).
    follows_up: Option<String>,
    // 무인 실행의 시한(초) — state-machine 39절. 지나면 **태스크가 멈춘다.**
    // `timeout_secs`와 다르다: 저쪽은 기다리기를 그만두는 시각이다(39.2절).
    deadline_secs: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let execution_mode = parse_mode(&mode)?;
    let budget = tomverse_core::budget::resolve_budget(budget_usd, budget_unlimited)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(900));

    // 태스크 실행은 승인 대기 때문에 오래 블록된다. 별도 스레드로 보내야 그 사이에
    // `respond_approval` command가 처리될 수 있다 — 같은 스레드면 교착된다.
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.start_task(
            &message,
            execution_mode,
            allow_git_commit.unwrap_or(false),
            budget,
            model_pins.unwrap_or(Value::Null),
            unattended.unwrap_or(false),
            auto_approve_verification.unwrap_or(false),
            auto_approve_writes.unwrap_or(false),
            skill_path.as_deref(),
            kind.as_deref().unwrap_or(DEFAULT_TASK_KIND),
            follows_up.as_deref(),
            // 0은 받지 않는다 — "즉시 멈춘다"를 시한으로 적을 이유가 없고, 받으면 시작하자마자
            // 멈추는 실행이 정상 동작처럼 보인다.
            deadline_secs.filter(|s| *s > 0),
            timeout,
        )
    })
    .await
    .map_err(|e| format!("태스크 실행 스레드 오류: {e}"))?
}

/// Fleet 시작 — **worktree 격리 기반 N개 병렬 실행**(process-architecture 11.6절).
///
/// # 화면이 상한을 정하지 않는다
///
/// 크기 상한(`MAX_FLEET_SIZE`)도 합계 예산도 Rust가 강제한다(`fleet::plan`). 화면은 그보다 큰
/// 값을 받아 놓고 나중에 거부하지 않기 위해 상한을 **미리 물어서**(`fleet_status`의
/// `maxFleetSize`) 입력을 막지만, 그것은 편의이고 판정이 아니다.
///
/// 예산 인자가 둘씩인 이유는 `start_task`와 같다 — **인자를 빠뜨린 화면이 상한을 조용히 끄지
/// 못하게** 하는 것이 `resolve_budget`의 목적이다.
#[tauri::command]
async fn start_fleet(
    app: tauri::AppHandle,
    // `{ branch, message }`의 목록. 하나의 요청을 우리가 N개로 쪼개지 않는다 — N개를 주는 것은
    // 사용자다(8.2절 "작업 분해"는 이후 깊이 확장 열이다).
    members: Vec<FleetMemberInput>,
    mode: String,
    allow_git_commit: Option<bool>,
    budget_usd: Option<f64>,
    budget_unlimited: Option<bool>,
    fleet_budget_usd: Option<f64>,
    fleet_budget_unlimited: Option<bool>,
    model_pins: Option<Value>,
    unattended: Option<bool>,
    auto_approve_verification: Option<bool>,
    auto_approve_writes: Option<bool>,
    deadline_secs: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let execution_mode = parse_mode(&mode)?;
    let per_task = tomverse_core::budget::resolve_budget(budget_usd, budget_unlimited)?;
    let fleet_cap = tomverse_core::budget::resolve_budget(fleet_budget_usd, fleet_budget_unlimited)
        .map_err(|e| format!("Fleet 합계 상한: {e}"))?;
    let specs: Vec<tomverse_core::fleet::MemberSpec> = members
        .into_iter()
        .map(|m| tomverse_core::fleet::MemberSpec {
            branch: m.branch,
            message: m.message,
        })
        .collect();
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(900));

    // 태스크 실행은 승인 대기 때문에 오래 블록된다. 별도 스레드로 보내야 그 사이에
    // `respond_approval` command가 처리될 수 있다 — 같은 스레드면 교착된다.
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.start_fleet(
            &app,
            specs,
            execution_mode,
            allow_git_commit.unwrap_or(false),
            per_task,
            fleet_cap,
            model_pins.unwrap_or(Value::Null),
            unattended.unwrap_or(false),
            auto_approve_verification.unwrap_or(false),
            auto_approve_writes.unwrap_or(false),
            deadline_secs.filter(|s| *s > 0),
            timeout,
        )
    })
    .await
    .map_err(|e| format!("Fleet 실행 스레드 오류: {e}"))?
}

/// 화면이 보내는 구성원 하나. **브랜치 이름 규칙은 여기서 보지 않는다** — `worktree.rs`가
/// 정본이고 `fleet::plan`이 그것을 부른다(규칙을 두 곳에 적으면 하나는 덜 검사된다).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetMemberInput {
    branch: String,
    message: String,
}

/// Fleet **전체** 취소. 구성원 하나의 취소와 다른 요청이다 — 이쪽은 대기열도 닫는다.
#[tauri::command]
fn cancel_fleet(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    state.cancel_fleet()
}

/// 구성원 **하나**만 취소한다. 나머지는 계속 돈다.
#[tauri::command]
fn cancel_fleet_member(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    state.cancel_fleet_member(&task_id)
}

/// 기록에서 유도한 Fleet 상태 — 구성원별 결말과 **합계** 지출.
#[tauri::command]
fn fleet_status(state: tauri::State<'_, SessionState>, fleet_id: Option<String>) -> Result<Value, String> {
    Ok(envelope(state.fleet_status(fleet_id.as_deref())))
}

/// 지금 밀려 있는 승인들 — 화면의 승인 **큐**가 이것을 정본으로 쓴다.
#[tauri::command]
fn pending_approvals(state: tauri::State<'_, SessionState>) -> Value {
    state.pending_approvals()
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
    Ok(envelope(state.get_task_events(&task_id, after_event_id)))
}

/// 보내기 **전에** 자격증명처럼 보이는 값이 있는지 본다 (17.11절).
///
/// # 왜 이 명령이 필요한가
///
/// `mask_secret_shapes`는 저장 직전에 도는 것이라 **감사 로그만 지킨다.** 사용자 답변과 요청문은
/// 그대로 프롬프트에 실려 모델 공급자로 나가고, 그건 우리가 되돌릴 수 있는 일이 아니다.
/// 나가는 것을 막을 수 있는 것은 보내기 전의 사용자뿐이므로, 알려주는 것 말고 할 수 있는 일이 없다.
///
/// # 상태를 만들지 않는다
///
/// 입력을 저장하지도, 이벤트를 남기지도 않는다. 편집 중인 텍스트를 기록하기 시작하면 이 기능이
/// 막으려는 것(자격증명이 어딘가에 남는 것)을 이 기능이 하게 된다.
#[tauri::command]
fn scan_input_for_secret_shapes(text: String) -> Result<Value, String> {
    Ok(json!({ "hits": tomverse_core::policy::secrets::scan_secret_shapes(&text) }))
}

/// 이 작업에서 무엇이 어느 공급자로 나갔는가 (product-strategy 7절).
///
/// **읽기 전용이고 아무것도 실행하지 않는다.** 사용자가 사후에 물을 수 있어야 하는 사실이라
/// 진행 중 상태가 아니라 저장된 이벤트에서 만든다.
#[tauri::command]
fn task_transmission(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    Ok(envelope(state.task_transmission(&task_id)))
}

/// 한 작업의 감사 export (product-strategy 6절).
///
/// **읽기 전용이다.** 값만 돌려주고 파일은 쓰지 않는다 — 이유는 `SessionState::task_export`에
/// 적어두었다.
#[tauri::command]
fn task_export(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    Ok(envelope(state.task_export(&task_id)))
}

/// 이 워크스페이스의 훅·MCP 등록을 읽는다 (state-machine 29절).
#[tauri::command]
fn workspace_settings(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    state.workspace_settings()
}

/// 격리 트리 목록 (state-machine 38절). **읽기 전용이다.**
#[tauri::command]
fn worktrees(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    state.worktrees()
}

/// 격리 트리 정리 (22.6절). 더러운 트리는 `force` 없이는 지우지 않는다.
#[tauri::command]
fn remove_worktree(state: tauri::State<'_, SessionState>, path: String, force: bool) -> Result<Value, String> {
    state.remove_worktree(&path, force)
}

/// 스킬 보관함과 저장소의 제안 (state-machine 36절). **읽기만 한다.**
#[tauri::command]
fn skill_library(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    state.skill_library()
}

/// 저장소의 스킬을 보관함으로 복사한다 (36절). 사용자가 눌렀을 때만.
#[tauri::command]
fn import_skill(state: tauri::State<'_, SessionState>, file: String) -> Result<Value, String> {
    state.import_skill(&file)
}

/// 보관함에서 지운다 (36절).
#[tauri::command]
fn remove_skill(state: tauri::State<'_, SessionState>, file: String) -> Result<Value, String> {
    state.remove_skill(&file)
}

/// 보관함 항목의 절대 경로 (36절). **경로 조립은 Rust가 한다.**
#[tauri::command]
fn skill_path(state: tauri::State<'_, SessionState>, file: String) -> Result<Value, String> {
    state.skill_path(&file)
}

/// 저장소가 제안한 등록 (state-machine 35절). **읽기만 한다** — 등록하지 않는다.
#[tauri::command]
fn workspace_proposal(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    state.workspace_proposal()
}

/// 등록을 저장한다. **즉시 반영되지 않는다** — 이유는 `SessionState`에 적어두었다.
#[tauri::command]
fn set_workspace_settings(state: tauri::State<'_, SessionState>, settings: Value) -> Result<Value, String> {
    state.set_workspace_settings(settings)
}

/// 이 세션에서 사용자가 정한 것 목록 (state-machine 30절). **읽기 전용이다.**
#[tauri::command]
fn session_decisions(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    Ok(envelope(state.session_decisions()))
}

/// 앞선 판정을 거둔다 (state-machine 30절).
///
/// **승인 모달이 뜨지 않으므로 별도 스레드가 필요 없다** — 실행되는 것이 없고 바뀌는 것은
/// 다음 프롬프트에 무엇이 실리는가 하나다.
#[tauri::command]
fn withdraw_decision(
    state: tauri::State<'_, SessionState>,
    task_id: String,
    criterion_id: String,
    reason: Option<String>,
) -> Result<Value, String> {
    state.withdraw_decision(&task_id, &criterion_id, reason)
}

/// 실행 정책 문자열을 값으로. **모르는 값은 기본값으로 접지 않는다** — 접으면 화면이 보낸
/// 오타가 조용히 `verified`가 되고, 사용자는 자기가 고른 것과 다른 실행을 본다.
fn parse_mode(mode: &str) -> Result<ExecutionMode, String> {
    match mode {
        "fast" => Ok(ExecutionMode::Fast),
        "verified" => Ok(ExecutionMode::Verified),
        other => Err(format!("알 수 없는 실행 정책: {other}")),
    }
}

/// 무인 정지의 처방 (state-machine 24.8절). **읽기 전용이다.**
#[tauri::command]
fn task_blocked(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    Ok(envelope(state.task_blocked(&task_id)))
}

/// **그 태스크가 돈 정책**으로 만든 미리보기 (state-machine 59절). **읽기 전용이다.**
///
/// `autopilot_preview`와 나란히 두되 다른 명령이다 — 저쪽은 "지금 스위치로 돌리면"이고
/// 이쪽은 "그 태스크는 어떤 예고를 받았나"다. 섞으면 `blocked`와의 비교가 다른 질문에
/// 대한 답을 나란히 놓는다.
#[tauri::command]
fn task_autopilot_preview(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    state.task_autopilot_preview(&task_id)
}

/// 무인 실행이 지금 스위치로 무엇을 허용하는지 (state-machine 47·48절).
///
/// **아무것도 쓰지 않는다.** 화면이 스위치를 바꿀 때마다 다시 물으므로 자주 불린다 —
/// 그래서 저장소도 워크스페이스도 건드리지 않는 것이 이 명령의 성질이다.
#[tauri::command]
fn autopilot_preview(
    state: tauri::State<'_, SessionState>,
    mode: String,
    allow_git_commit: Option<bool>,
    unattended: Option<bool>,
    auto_approve_verification: Option<bool>,
    auto_approve_writes: Option<bool>,
    skill_path: Option<String>,
    deadline_secs: Option<u64>,
    // 무인 스위치는 종류와 무관하게 켤 수 있으므로(화면의 그 fieldset은 `taskKind` 게이트
    // 밖에 있다) 미리보기도 종류를 알아야 한다. 모르면 질문·계획 태스크에서 좁혀진 도구를
    // "그냥 지나갑니다"로 보고한다.
    //
    // **`start_task`와 같은 값을 받아야 한다**(63절). 종류가 빠져 있던 동안 질문 태스크의
    // 예고는 변경 태스크의 답이었다 — 같은 함수를 쓰는 것만으로는 부족하다.
    kind: Option<String>,
) -> Result<Value, String> {
    state.autopilot_preview(
        parse_mode(&mode)?,
        allow_git_commit.unwrap_or(false),
        unattended.unwrap_or(false),
        auto_approve_verification.unwrap_or(false),
        auto_approve_writes.unwrap_or(false),
        skill_path.as_deref(),
        deadline_secs,
        kind.as_deref().unwrap_or(DEFAULT_TASK_KIND),
    )
}

/// 브랜치를 올리고 PR 폼 URL을 만든다 (state-machine 28절).
///
/// **별도 스레드로 보낸다.** push는 승인 모달을 띄우고 그 답을 기다리는데, 같은 스레드면
/// `respond_approval`이 처리되지 못해 교착된다 — `start_task`와 같은 이유다.
#[tauri::command]
async fn open_pull_request(
    app: tauri::AppHandle,
    task_id: String,
    remote: Option<String>,
    base: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.open_pull_request(
            &task_id,
            remote.as_deref().unwrap_or("origin"),
            base.as_deref().unwrap_or("main"),
        )
    })
    .await
    .map_err(|e| format!("PR 스레드 오류: {e}"))?
}

/// 백엔드(sidecar) 상태. **읽기 전용이다** — 물었다고 다시 띄우지 않는다.
///
/// `recovery`가 화면의 "다시 열기" 버튼을 정한다. 안내 문장을 화면이 문자열로 비교하게 두면
/// 문구를 다듬는 순간 버튼이 사라진다.
#[tauri::command]
fn backend_status(state: tauri::State<'_, SessionState>) -> Result<Value, String> {
    state.backend_status()
}

/// 자격증명 확인 (multi-engine-routing.md 17절). **유료 호출을 하지 않는다.**
#[tauri::command]
async fn probe_providers(app: tauri::AppHandle, timeout_secs: Option<u64>) -> Result<Value, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(30));
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.probe_providers(timeout)
    })
    .await
    .map_err(|e| format!("자격증명 확인 스레드 오류: {e}"))?
}

/// 이 워크스페이스에서 쓸 공급자를 정한다 (multi-engine-routing.md 16절).
///
/// `allowed`가 없으면 **제한 없음**, 빈 배열이면 **아무것도 허용하지 않음**이다 —
/// 둘은 다른 사실이므로 다른 값으로 저장된다.
#[tauri::command]
fn set_allowed_providers(
    state: tauri::State<'_, SessionState>,
    allowed: Option<Vec<String>>,
) -> Result<Value, String> {
    state.set_allowed_providers(allowed)
}

/// 이 자격증명으로 실제로 쓸 수 있는 모델 목록 (multi-engine-routing.md 15절).
#[tauri::command]
async fn list_models(app: tauri::AppHandle, timeout_secs: Option<u64>) -> Result<Value, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(10));
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.list_models(timeout)
    })
    .await
    .map_err(|e| format!("모델 목록 스레드 오류: {e}"))?
}

/// 화면이 쓰는 문턱들과 그 근거 (16.3절 강제 포기 시점, 19.6절 "큰 변경" 안내).
///
/// 값과 함께 `source`를 돌려주는 이유: 표본이 부족하면 그 값은 여전히 추정치인데, 숫자만
/// 넘기면 화면이 그것을 측정값으로 말하게 된다. 12절 항목이 지적한 문제가 정확히 그것이었다.
#[tauri::command]
fn derived_thresholds(
    state: tauri::State<'_, SessionState>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    Ok(envelope(state.derived_thresholds(workspace_path.as_deref())))
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
    // 실패를 `Err`가 아니라 봉투로 돌려준다. Tauri의 `Err`는 문자열 하나뿐이라 구조가 들어갈
    // 자리가 없고, 문자열에 구조를 실으면 화면이 문장을 파싱하게 된다(ui-wireframes.md 6.4절).
    // **성공 쪽도 같은 함수를 지난다** — `ok`를 손으로 얹기 시작하면 곧 한 군데가 빠진다.
    Ok(envelope(
        state
            .list_tasks(workspace_path.as_deref(), limit, cursor.as_deref())
            .map(|rows| {
                // 커서는 **Store가 만든다.** 여기서 직접 조립하면 정렬 기준이 바뀔 때 화면과
                // 질의가 조용히 갈라진다 — 실제로 갈라져 있었다(커서는 created_at인데 질의는
                // updated_at으로 잘랐다). 그러면 페이지 경계에서 행이 빠지거나 두 번 나오는데,
                // 목록만 봐서는 알아챌 수 없다.
                //
                // 커서를 limit을 채웠을 때만 주는 이유: 덜 채운 페이지는 마지막 페이지이므로
                // 커서를 주면 화면이 "더 보기"를 계속 띄우고, 누르면 늘 빈 결과가 돌아온다.
                let next_cursor = if rows.len() as i64 == limit {
                    rows.last().map(tomverse_core::store::Store::cursor_for)
                } else {
                    None
                };
                json!({ "tasks": rows, "nextCursor": next_cursor })
            }),
    ))
}

#[tauri::command]
fn get_task(state: tauri::State<'_, SessionState>, task_id: String) -> Result<Value, String> {
    Ok(envelope(load_task_detail(&state, &task_id)))
}

fn load_task_detail(state: &SessionState, task_id: &str) -> Result<Value, UiMessage> {
    let task = state.get_task(task_id)?;
    let (mutated, criteria) = if task.is_some() {
        (state.task_mutations(task_id)?, state.task_acceptance_criteria(task_id)?)
    } else {
        (Vec::new(), Value::Null)
    };
    Ok(json!({ "task": task, "mutatedPaths": mutated, "acceptanceCriteria": criteria }))
}

/// 저장된 작업을 **새 task_id로** 처음부터 다시 실행한다 (부분 재개가 아니다).
#[tauri::command]
async fn restart_task(
    app: tauri::AppHandle,
    task_id: String,
    budget_usd: Option<f64>,
    budget_unlimited: Option<bool>,
    model_pins: Option<Value>,
    // 종류는 저장된 행에서 복원할 수 없다 — `tasks`에도 `TaskRow`에도 컬럼이 없다.
    // 화면이 지금 고른 값을 보낸다: **다시 실행은 새 태스크이고**(16.6절) 예산·모델 지정도
    // 이미 그렇게 받는다.
    kind: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    // 재실행은 **새 승인**이다. 이전 태스크의 상한을 이어받지 않는다 — 상한이 태스크당이라는
    // 결정의 직접적 귀결이고, 이어받으면 사용자가 승인한 적 없는 값이 강제된다.
    let budget = tomverse_core::budget::resolve_budget(budget_usd, budget_unlimited)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(900));
    let kind = kind.unwrap_or_else(|| DEFAULT_TASK_KIND.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<SessionState>();
        session.restart_task(&task_id, budget, model_pins.unwrap_or(Value::Null), &kind, timeout)
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
            // 실패는 **봉투**로 나간다 — 화면이 코드로 문장을 만든다(ui-wireframes.md 6절).
            // `error`는 그 봉투의 원문이며 화면이 코드를 모를 때의 대체 표시다.
            let payload = envelope(state.initialize().map(|info| json!({ "recovery": info })));
            let _ = app.emit("store-ready", payload);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            current_workspace,
            provider_status,
            set_provider_credential,
            delete_provider_credential,
            start_task,
            respond_approval,
            pending_approvals,
            start_fleet,
            cancel_fleet,
            cancel_fleet_member,
            fleet_status,
            cancel_task,
            provide_user_input,
            force_abandon_task,
            rollback_task,
            revert_task_commit,
            get_task_events,
            list_tasks,
            derived_thresholds,
            task_transmission,
            task_blocked,
            autopilot_preview,
            session_decisions,
            withdraw_decision,
            workspace_settings,
            workspace_proposal,
            worktrees,
            remove_worktree,
            skill_library,
            import_skill,
            remove_skill,
            skill_path,
            set_workspace_settings,
            open_pull_request,
            task_autopilot_preview,
            task_export,
            list_models,
            set_allowed_providers,
            probe_providers,
            backend_status,
            scan_input_for_secret_shapes,
            get_task,
            restart_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
