//! Tomverse Code — Rust 신뢰 경계.
//!
//! 이 크레이트가 담는 것 (docs/design/process-architecture.md 2절, 7절):
//!  - **Policy Gate**: 도구 실행 여부의 최종 판단
//!  - **Tool Runtime**: 파일 I/O와 프로세스 실행. Node에는 이 능력이 없다
//!  - **Store**: SQLite. Rust가 유일한 writer이며 `task_events`는 append-only
//!  - **Verification Runner**: 결정론적 판정자. Node가 검증했다고 주장할 수 없다
//!  - **Sidecar IPC**: Node sidecar spawn 및 NDJSON 왕복
//!
//! 담지 않는 것: UI, LLM 호출, 오케스트레이션 상태 머신. 앞의 둘은 각각 Tauri 웹뷰와
//! Node sidecar의 몫이고, 상태 머신은 Node가 소유한다.
//!
//! `tauri`에 의존하지 않으므로 GUI 시스템 라이브러리 없이 `cargo test`가 돌아간다.

pub mod approvals;
pub mod artifacts;
pub mod budget;
pub mod cancel;
pub mod export;
pub mod host;
pub mod landing;
pub mod launcher;
pub mod metrics;
pub mod paths;
pub mod policy;
pub mod proctree;
pub mod reproduce;
pub mod sidecar;
pub mod store;
pub mod time;
pub mod tools;
pub mod transmission;
pub mod types;
pub mod uimsg;
pub mod worktree;
pub mod verify;
#[cfg(windows)]
pub(crate) mod win_job;

pub use artifacts::ArtifactStore;
pub use cancel::{CancelOutcome, CancellationRegistry, CancellationToken};
pub use host::{ApprovalGateway, ApprovalOutcome, AutoApprove, EventSink, TaskHost};
pub use paths::{PathViolation, SafePath, WorkspaceRoot};
pub use policy::PolicyGate;
pub use sidecar::{RespawnOutcome, SidecarClient, SidecarHandler, SidecarSupervisor, SpawnConfig};
pub use store::{Store, SCHEMA_VERSION};
pub use tools::ToolRuntime;
pub use verify::VerificationRunner;

/// Node sidecar와 맞춰야 하는 프로토콜 버전 (process-architecture.md 5절).
/// `packages/sidecar/src/index.ts`의 `PROTOCOL_VERSION`과 같아야 한다.
pub const PROTOCOL_VERSION: &str = "0.2.0";

/// 자격증명 환경변수 이름 → 공급자 id.
///
/// M0에서는 Windows Credential Manager 연동 대신 환경변수를 지원한다(작업 지침 4.9절).
/// 이 값들은 sidecar spawn 시 자식 환경으로 주입되고, UI에는 "설정됨/미설정"만 노출된다 —
/// 값 자체는 UI로도 로그로도 나가지 않는다.
pub const PROVIDER_ENV_VARS: &[(&str, &str)] = &[("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY")];

/// 허용 목록이 이 공급자를 허용하는가.
///
/// `None`은 **제한 없음**이고 `Some(&[])`는 **아무것도 허용하지 않음**이다. 둘을 같게 다루면
/// 빈 목록을 저장한 사용자에게 전부 허용된다 — 정반대의 결과다.
fn allows(allowed: Option<&[String]>, provider_id: &str) -> bool {
    match allowed {
        None => true,
        Some(list) => list.iter().any(|a| a == provider_id),
    }
}

/// 순수 코어 — 공급자 표와 "이 환경변수의 값"을 주입받는다.
///
/// 환경변수를 직접 읽지 않는 이유는 **테스트 때문만이 아니다.** 프로세스 전역 상태를 읽는
/// 함수는 병렬 테스트에서 서로를 방해하고, 그래서 이런 규칙은 대개 테스트되지 않은 채 남는다.
/// 여기서 정하는 것이 "사용자 데이터가 어느 회사로 나가는가"이므로 그럴 수 없다.
fn select_credentials(
    table: &[(&str, &str)],
    allowed: Option<&[String]>,
    value_of: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    table
        .iter()
        .filter(|(id, _)| allows(allowed, id))
        .filter_map(|(_, env)| value_of(env).map(|v| ((*env).to_string(), v)))
        .collect()
}

fn select_providers(
    table: &[(&str, &str)],
    allowed: Option<&[String]>,
    value_of: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    table
        .iter()
        .filter(|(id, _)| allows(allowed, id))
        .filter(|(_, env)| value_of(env).is_some())
        .map(|(id, _)| (*id).to_string())
        .collect()
}

/// 환경변수에서 값을 읽되 **공백만 있는 값은 없는 것으로 본다.**
/// 빈 문자열을 키로 취급하면 "설정됨"으로 보이는데 호출은 인증 실패로 죽는다.
fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// 어떤 공급자의 키가 실제로 존재하는지. 값은 반환하지 않는다.
pub fn available_providers() -> Vec<String> {
    available_providers_for(None)
}

/// 워크스페이스 허용 목록을 적용한 사용 가능 공급자.
pub fn available_providers_for(allowed: Option<&[String]>) -> Vec<String> {
    select_providers(PROVIDER_ENV_VARS, allowed, &env_value)
}

/// 키는 있는데 **워크스페이스 정책이 막은** 공급자.
///
/// "키가 없다"와 "정책이 막았다"는 다른 사실이다. 화면이 둘을 뭉개면 사용자는 없는 키를
/// 찾아 헤매거나, 반대로 자기가 건 제한을 잊고 "왜 안 되지"를 반복한다.
pub fn providers_blocked_by_policy(allowed: Option<&[String]>) -> Vec<String> {
    if allowed.is_none() {
        return Vec::new();
    }
    let all = select_providers(PROVIDER_ENV_VARS, None, &env_value);
    all.into_iter().filter(|id| !allows(allowed, id)).collect()
}

/// sidecar에 주입할 자격증명 환경변수 쌍. 존재하는 것만 담는다.
pub fn credential_env() -> Vec<(String, String)> {
    credential_env_for(None)
}

/// 워크스페이스 허용 목록을 적용한 자격증명 주입 목록.
///
/// # 이 함수가 곧 게이트다
///
/// 공급자 호출은 Policy Gate를 지나지 않는다 — 파일·셸과 달리 HTTP는 Node가 직접 한다.
/// 그래서 "이 워크스페이스는 이 공급자만 쓴다"를 Node 안에서 검사하면, 예산 상한과 같은
/// 한계를 갖는다(장악당한 Node는 그 검사를 지운다).
///
/// **여기서는 다르다.** 허용되지 않은 공급자의 키를 애초에 주입하지 않으면 Node는 그 공급자를
/// 호출할 수단이 없다. 검사를 지워도 키가 없다. 이게 이 제한이 구조적으로 강제되는 이유이며,
/// 그래서 필터가 Node가 아니라 **Rust의 주입 지점**에 있다.
pub fn credential_env_for(allowed: Option<&[String]>) -> Vec<(String, String)> {
    select_credentials(PROVIDER_ENV_VARS, allowed, &env_value)
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    const TABLE: &[(&str, &str)] = &[("openai", "KEY_A"), ("anthropic", "KEY_B"), ("google", "KEY_C")];

    /// KEY_A와 KEY_B만 설정된 환경.
    fn present(name: &str) -> Option<String> {
        match name {
            "KEY_A" => Some("sk-a".to_string()),
            "KEY_B" => Some("sk-b".to_string()),
            _ => None,
        }
    }

    fn ids(list: &[String]) -> Vec<&str> {
        list.iter().map(String::as_str).collect()
    }

    /// **허용 목록이 없으면 제한이 없다.** 종전 동작이며, 이 기능이 기존 경로를 바꾸지 않는다.
    #[test]
    fn no_allowlist_means_no_restriction() {
        let creds = select_credentials(TABLE, None, &present);
        assert_eq!(creds.len(), 2, "{creds:?}");
        assert_eq!(
            ids(&select_providers(TABLE, None, &present)),
            vec!["openai", "anthropic"]
        );
    }

    /// **빈 목록은 "제한 없음"이 아니라 "아무것도 허용하지 않음"이다.**
    ///
    /// 둘을 같게 다루면 빈 목록을 저장한 사용자에게 전부 허용된다 — 정반대의 결과다.
    #[test]
    fn an_empty_allowlist_blocks_everything() {
        let empty: Vec<String> = Vec::new();
        assert!(select_credentials(TABLE, Some(&empty), &present).is_empty());
        assert!(select_providers(TABLE, Some(&empty), &present).is_empty());
    }

    /// **허용되지 않은 공급자의 키는 주입되지 않는다.** 이게 이 제한의 강제 지점 전부다 —
    /// Node가 검사를 지워도 키가 없으면 호출할 수단이 없다.
    #[test]
    fn a_disallowed_provider_gets_no_credential() {
        let only_anthropic = vec!["anthropic".to_string()];
        let creds = select_credentials(TABLE, Some(&only_anthropic), &present);
        assert_eq!(creds.len(), 1);
        assert_eq!(creds[0].0, "KEY_B");
        assert!(
            !creds.iter().any(|(name, _)| name == "KEY_A"),
            "허용되지 않은 공급자의 키가 주입되었습니다: {creds:?}"
        );
    }

    /// 허용 목록에 있어도 **키가 없으면 쓸 수 없다.** 허용은 존재를 만들어내지 않는다.
    #[test]
    fn allowing_a_provider_does_not_create_a_key() {
        let with_google = vec!["google".to_string()];
        assert!(select_providers(TABLE, Some(&with_google), &present).is_empty());
    }
}
