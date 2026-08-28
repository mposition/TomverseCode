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
pub mod autopilot;
pub mod blocked;
pub mod budget;
pub mod cancel;
pub mod credentials;
pub mod deadline;
pub mod decisions;
pub mod export;
pub mod fleet;
pub mod hooks;
pub mod host;
pub mod landing;
pub mod landing_attest;
pub mod launcher;
pub mod mcp;
pub mod metrics;
pub mod msvc;
pub mod paths;
pub mod policy;
pub mod python;
pub mod pr;
pub mod proctree;
pub mod reproduce;
pub mod session_memory;
pub mod settings;
pub mod sidecar;
pub mod shell_habits;
pub mod skills;
pub mod store;
pub mod testnames;
pub mod time;
pub mod tools;
pub mod transmission;
pub mod types;
pub mod uimsg;
pub mod unc;
pub mod worktree;
pub mod verify;
#[cfg(windows)]
pub(crate) mod win_credentials;
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
/// 이 이름들은 **sidecar가 키를 보는 유일한 창구**다. 값은 spawn 시 자식 환경으로 1회
/// 주입되고, UI에는 "설정됨/미설정"만 노출된다 — 값 자체는 UI로도 로그로도 나가지 않는다.
///
/// 키가 **어디서 오는가**는 `credentials.rs`의 Credential Store가 정한다(저장소 우선,
/// 없으면 환경변수). 그 변경이 이 표를 건드리지 않는 것이 요점이다: 저장소는 주입 지점
/// **앞**에 놓이는 것이지 sidecar가 키를 얻는 경로를 바꾸지 않는다.
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

/// 이 공급자가 제품 표에 있는가, 있다면 그 환경변수 이름은 무엇인가.
///
/// **화면이 보낸 공급자 id를 그대로 저장소에 넘기지 않기 위한 자리다.** 저장 계층은 이름의
/// *모양*만 보고(`credentials::valid_provider_id`), 어떤 공급자가 존재하는가는 제품의 질문이다.
pub fn env_name_for(provider_id: &str) -> Option<&'static str> {
    PROVIDER_ENV_VARS
        .iter()
        .find(|(id, _)| *id == provider_id)
        .map(|(_, env)| *env)
}

/// 이 공급자의 키가 **어디서 왔는가.**
///
/// 화면이 이 값을 사실대로 말해야 한다. 둘을 뭉개면 저장소에 넣은 사용자가 왜 여전히
/// "개발용 임시 방식" 문구를 보는지 알 수 없고, 반대로 환경변수만 쓰는 개발자는 자기가
/// 넣지 않은 키가 저장소에 있다고 믿게 된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialSource {
    /// Credential Store (Windows에서는 DPAPI).
    Store,
    /// 프로세스 환경변수. 개발·헤드리스·CI 경로가 계속 이걸 쓴다.
    Environment,
}

/// 한 공급자의 자격증명 상태. **값은 담지 않는다.**
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialPresence {
    pub provider_id: String,
    pub env_name: String,
    /// 없으면 `None`.
    pub source: Option<CredentialSource>,
    /// 저장소와 환경변수에 **서로 다른 값**이 있다.
    ///
    /// 조용히 하나를 고르고 넘어가지 않는다 — sidecar의 `resolveCredential`이 같은 상황을
    /// `ambiguous`로 차단하는 것과 같은 규율이다(providers/credentials.ts). 여기서는 차단
    /// 대신 **저장소를 쓰고 그 사실을 말한다**: 앱 안에서 넣은 것이 사용자의 최신 의도이고,
    /// 차단하면 예전에 설정한 환경변수 하나 때문에 앱이 아무것도 못 하게 된다.
    pub conflict: bool,
}

/// 한 공급자를 푼 결과. `value`는 이 모듈 밖으로 나가지 않는다.
struct Resolved {
    provider_id: String,
    env_name: String,
    value: Option<String>,
    source: Option<CredentialSource>,
    conflict: bool,
}

/// 순수 코어 — 공급자 표와 두 출처의 값을 **주입받는다.**
///
/// 저장소와 환경변수를 직접 읽지 않는 이유는 **테스트 때문만이 아니다.** 프로세스 전역
/// 상태를 읽는 함수는 병렬 테스트에서 서로를 방해하고, 그래서 이런 규칙은 대개 테스트되지
/// 않은 채 남는다. 여기서 정하는 것이 "사용자 데이터가 어느 회사로 나가는가"이므로 그럴 수 없다.
///
/// **우선순위는 저장소다.** 사용자가 앱 안에서 넣은 것이 최신 의도이고, 환경변수는 몇 달 전에
/// 설정해 두고 잊은 값일 수 있다. 둘이 다르면 `conflict`로 남겨 화면이 말한다.
fn resolve_all(
    table: &[(&str, &str)],
    from_store: &dyn Fn(&str) -> Option<String>,
    from_env: &dyn Fn(&str) -> Option<String>,
) -> Vec<Resolved> {
    table
        .iter()
        .map(|(id, env)| {
            let stored = from_store(id).filter(|v| !v.trim().is_empty());
            let ambient = from_env(env).filter(|v| !v.trim().is_empty());
            let conflict = match (&stored, &ambient) {
                (Some(a), Some(b)) => a != b,
                _ => false,
            };
            let (value, source) = match (stored, ambient) {
                (Some(v), _) => (Some(v), Some(CredentialSource::Store)),
                (None, Some(v)) => (Some(v), Some(CredentialSource::Environment)),
                (None, None) => (None, None),
            };
            Resolved {
                provider_id: (*id).to_string(),
                env_name: (*env).to_string(),
                value,
                source,
                conflict,
            }
        })
        .collect()
}

/// 환경변수에서 값을 읽되 **공백만 있는 값은 없는 것으로 본다.**
/// 빈 문자열을 키로 취급하면 "설정됨"으로 보이는데 호출은 인증 실패로 죽는다.
fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// 저장소에서 값을 읽는다. **`read_for_injection`을 부르는 자리가 제품 전체에서 여기 하나다.**
///
/// 저장소가 실패하면 값이 없는 것으로 본다 — 여기서 오류를 위로 던지면 저장소 하나가 고장 났을
/// 때 환경변수로 잘 돌던 사용자까지 앱을 못 쓰게 된다. 실패 자체는 `store.has()`를 부르는
/// 화면 경로에서 사용자에게 보인다.
fn stored_value(store: &dyn credentials::CredentialStore, provider_id: &str) -> Option<String> {
    store
        .read_for_injection(provider_id)
        .ok()
        .flatten()
        .map(|s| s.expose().to_string())
}

/// 공급자별 자격증명 상태. **허용 목록을 적용하지 않는다** —
/// "키가 없다"와 "정책이 막았다"는 다른 사실이고, 후자는 `providers_blocked_by_policy`가 답한다.
pub fn credential_presence(store: &dyn credentials::CredentialStore) -> Vec<CredentialPresence> {
    resolve_all(
        PROVIDER_ENV_VARS,
        &|id| stored_value(store, id),
        &env_value,
    )
    .into_iter()
    .map(|r| CredentialPresence {
        provider_id: r.provider_id,
        env_name: r.env_name,
        source: r.source,
        conflict: r.conflict,
    })
    .collect()
}

/// 워크스페이스 허용 목록을 적용한 사용 가능 공급자. 값은 반환하지 않는다.
pub fn available_providers_for(store: &dyn credentials::CredentialStore, allowed: Option<&[String]>) -> Vec<String> {
    resolve_all(PROVIDER_ENV_VARS, &|id| stored_value(store, id), &env_value)
        .into_iter()
        .filter(|r| r.value.is_some() && allows(allowed, &r.provider_id))
        .map(|r| r.provider_id)
        .collect()
}

/// 키는 있는데 **워크스페이스 정책이 막은** 공급자.
///
/// "키가 없다"와 "정책이 막았다"는 다른 사실이다. 화면이 둘을 뭉개면 사용자는 없는 키를
/// 찾아 헤매거나, 반대로 자기가 건 제한을 잊고 "왜 안 되지"를 반복한다.
pub fn providers_blocked_by_policy(
    store: &dyn credentials::CredentialStore,
    allowed: Option<&[String]>,
) -> Vec<String> {
    if allowed.is_none() {
        return Vec::new();
    }
    available_providers_for(store, None)
        .into_iter()
        .filter(|id| !allows(allowed, id))
        .collect()
}

/// 워크스페이스 허용 목록을 적용한 **sidecar 주입 봉투.**
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
///
/// # 저장소가 생겨도 이 경로는 그대로다
///
/// 주입은 **spawn 시 1회**이고, sidecar는 런타임에 키를 다시 요청할 수 없다
/// (`host.rs`의 `credential.get`은 여전히 거절한다). 저장소는 이 함수의 **입력**을 바꿀 뿐이다.
/// 착지 기준 `injectionStaysOnce`가 그 사실을 못박는다.
pub fn credential_injection_for(
    store: &dyn credentials::CredentialStore,
    allowed: Option<&[String]>,
) -> credentials::CredentialInjection {
    let mut injection = credentials::CredentialInjection::new();
    for resolved in resolve_all(PROVIDER_ENV_VARS, &|id| stored_value(store, id), &env_value) {
        if !allows(allowed, &resolved.provider_id) {
            continue;
        }
        let Some(value) = resolved.value else { continue };
        // `Secret::new`는 공백만 있는 값을 거부한다. `resolve_all`이 이미 걸렀으므로 여기서
        // 실패하면 규칙이 갈라진 것이다 — 조용히 건너뛰지 않고 그 자리를 비운다.
        if let Ok(secret) = credentials::Secret::new(value) {
            injection.push_secret(resolved.env_name, secret);
        }
    }
    injection
}

#[cfg(test)]
mod credential_tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryCredentialStore, Secret};

    const TABLE: &[(&str, &str)] = &[("openai", "KEY_A"), ("anthropic", "KEY_B"), ("google", "KEY_C")];

    /// 아무것도 저장되지 않은 저장소.
    fn no_store(_: &str) -> Option<String> {
        None
    }

    /// KEY_A와 KEY_B만 설정된 환경.
    fn present(name: &str) -> Option<String> {
        match name {
            "KEY_A" => Some("sk-a".to_string()),
            "KEY_B" => Some("sk-b".to_string()),
            _ => None,
        }
    }

    fn injected(resolved: Vec<Resolved>, allowed: Option<&[String]>) -> Vec<String> {
        resolved
            .into_iter()
            .filter(|r| r.value.is_some() && allows(allowed, &r.provider_id))
            .map(|r| r.env_name)
            .collect()
    }

    fn ids(resolved: Vec<Resolved>, allowed: Option<&[String]>) -> Vec<String> {
        resolved
            .into_iter()
            .filter(|r| r.value.is_some() && allows(allowed, &r.provider_id))
            .map(|r| r.provider_id)
            .collect()
    }

    /// **허용 목록이 없으면 제한이 없다.** 종전 동작이며, 이 기능이 기존 경로를 바꾸지 않는다.
    #[test]
    fn no_allowlist_means_no_restriction() {
        let names = injected(resolve_all(TABLE, &no_store, &present), None);
        assert_eq!(names, vec!["KEY_A", "KEY_B"]);
        assert_eq!(
            ids(resolve_all(TABLE, &no_store, &present), None),
            vec!["openai", "anthropic"]
        );
    }

    /// **빈 목록은 "제한 없음"이 아니라 "아무것도 허용하지 않음"이다.**
    ///
    /// 둘을 같게 다루면 빈 목록을 저장한 사용자에게 전부 허용된다 — 정반대의 결과다.
    #[test]
    fn an_empty_allowlist_blocks_everything() {
        let empty: Vec<String> = Vec::new();
        assert!(injected(resolve_all(TABLE, &no_store, &present), Some(&empty)).is_empty());
        assert!(ids(resolve_all(TABLE, &no_store, &present), Some(&empty)).is_empty());
    }

    /// **허용되지 않은 공급자의 키는 주입되지 않는다.** 이게 이 제한의 강제 지점 전부다 —
    /// Node가 검사를 지워도 키가 없으면 호출할 수단이 없다.
    #[test]
    fn a_disallowed_provider_gets_no_credential() {
        let only_anthropic = vec!["anthropic".to_string()];
        let names = injected(resolve_all(TABLE, &no_store, &present), Some(&only_anthropic));
        assert_eq!(names, vec!["KEY_B"]);
    }

    /// 허용 목록에 있어도 **키가 없으면 쓸 수 없다.** 허용은 존재를 만들어내지 않는다.
    #[test]
    fn allowing_a_provider_does_not_create_a_key() {
        let with_google = vec!["google".to_string()];
        assert!(ids(resolve_all(TABLE, &no_store, &present), Some(&with_google)).is_empty());
    }

    // ---- 저장소가 앞에 놓인다 (Credential Store) ----

    fn stored<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |id: &str| pairs.iter().find(|(k, _)| *k == id).map(|(_, v)| (*v).to_string())
    }

    /// **저장소만 있어도 주입된다.** 환경변수를 설정하지 않은 데스크톱 사용자가
    /// 앱 안에서 키를 넣을 수 있게 된 것이 이 작업의 전부다.
    #[test]
    fn a_stored_key_is_injected_without_any_environment_variable() {
        let store = stored(&[("openai", "from-store")]);
        let resolved = resolve_all(TABLE, &store, &no_store);
        let openai = resolved.iter().find(|r| r.provider_id == "openai").unwrap();
        assert_eq!(openai.value.as_deref(), Some("from-store"));
        assert_eq!(openai.source, Some(CredentialSource::Store));
        assert!(!openai.conflict);
    }

    /// **환경변수 경로가 사라지지 않는다.** 헤드리스 호스트·e2e·가설 게이트가 계속 쓴다.
    #[test]
    fn the_environment_path_still_works() {
        let resolved = resolve_all(TABLE, &no_store, &present);
        let openai = resolved.iter().find(|r| r.provider_id == "openai").unwrap();
        assert_eq!(openai.value.as_deref(), Some("sk-a"));
        assert_eq!(openai.source, Some(CredentialSource::Environment));
    }

    /// **같은 값이 양쪽에 있으면 충돌이 아니다.** 충돌을 남발하면 경고가 배경음이 된다.
    #[test]
    fn the_same_value_in_both_places_is_not_a_conflict() {
        let store = stored(&[("openai", "sk-a")]);
        let resolved = resolve_all(TABLE, &store, &present);
        let openai = resolved.iter().find(|r| r.provider_id == "openai").unwrap();
        assert!(!openai.conflict);
        assert_eq!(openai.source, Some(CredentialSource::Store));
    }

    /// **다른 값이면 저장소를 쓰고, 그 사실을 남긴다.**
    ///
    /// 조용히 환경변수를 쓰면 "앱에서 키를 바꿨는데 예전 키로 호출된다"가 되고, 그 증상은
    /// 인증 실패조차 아니어서(옛 키도 유효할 수 있다) 원인과 아주 멀다.
    #[test]
    fn a_differing_value_prefers_the_store_and_says_so() {
        let store = stored(&[("openai", "from-store")]);
        let resolved = resolve_all(TABLE, &store, &present);
        let openai = resolved.iter().find(|r| r.provider_id == "openai").unwrap();
        assert_eq!(openai.value.as_deref(), Some("from-store"));
        assert!(openai.conflict, "충돌이 조용히 삼켜졌습니다");
    }

    /// 저장소에 공백만 있는 값이 어떤 경로로 들어가도 **없는 것으로 본다.**
    #[test]
    fn a_blank_stored_value_is_treated_as_absent() {
        let store = stored(&[("openai", "   ")]);
        let resolved = resolve_all(TABLE, &store, &no_store);
        let openai = resolved.iter().find(|r| r.provider_id == "openai").unwrap();
        assert!(openai.value.is_none());
        assert_eq!(openai.source, None);
    }

    /// **실제 저장소 구현을 태워** 주입 봉투가 만들어지는지 본다.
    ///
    /// 위 테스트들은 순수 함수를 재고, 이건 `PROVIDER_ENV_VARS`와 트레이트가 실제로 이어지는지를
    /// 잰다 — 둘 중 하나만 있으면 배선이 끊겨도 통과한다.
    ///
    /// # 주장을 이렇게 좁힌 이유
    ///
    /// 이 함수는 `std::env`를 읽으므로 **프로세스 환경이 이 테스트의 입력이다.** 개발자
    /// 머신에는 `OPENAI_API_KEY`가 있는 것이 정상이고(실제로 여기서 한 번 잡혔다), "봉투에
    /// 아무것도 없다"류의 주장은 그 머신에서 실패한다. 그러면 사람은 테스트를 고치거나 —
    /// 더 나쁘게 — 환경을 지우게 되고, 어느 쪽이든 검사가 재는 것이 흐려진다.
    ///
    /// 그래서 **환경이 바꿀 수 없는 방향만** 잰다: (a) 저장소에 넣으면 들어간다,
    /// (b) 허용 목록이 막으면 출처와 무관하게 빠진다. 순수 규칙은 위 `resolve_all` 테스트가
    /// 환경 없이 전부 덮는다.
    #[test]
    fn the_injection_envelope_is_built_from_a_real_store() {
        let store = MemoryCredentialStore::new();
        store.store("anthropic", Secret::new("sk-ant").unwrap()).unwrap();

        let injection = credential_injection_for(&store, None);
        assert!(injection.secret_names().contains(&"ANTHROPIC_API_KEY"), "{injection:?}");

        // 허용 목록이 막으면 **저장소에 있어도** 봉투에 들어가지 않는다.
        let only_openai = vec!["openai".to_string()];
        let blocked = credential_injection_for(&store, Some(&only_openai));
        assert!(
            !blocked.secret_names().contains(&"ANTHROPIC_API_KEY"),
            "허용되지 않은 공급자의 키가 주입되었습니다: {blocked:?}"
        );
    }

    /// 저장소에 넣은 키가 `available_providers_for`와 `credential_presence`에도 보인다 —
    /// 화면과 라우터가 같은 사실을 본다.
    ///
    /// 여기서도 "넣기 전에는 없다"는 주장은 하지 않는다 — 환경변수가 이미 있을 수 있다.
    /// 위 테스트와 같은 이유다.
    #[test]
    fn a_stored_key_makes_the_provider_available() {
        let store = MemoryCredentialStore::new();
        store.store("anthropic", Secret::new("sk-ant").unwrap()).unwrap();
        assert!(available_providers_for(&store, None).contains(&"anthropic".to_string()));

        let presence = credential_presence(&store);
        let anthropic = presence.iter().find(|p| p.provider_id == "anthropic").unwrap();
        // 저장소가 환경변수보다 앞이므로 출처는 환경과 무관하게 `Store`다.
        assert_eq!(anthropic.source, Some(CredentialSource::Store));
        assert_eq!(anthropic.env_name, "ANTHROPIC_API_KEY");
    }
}
