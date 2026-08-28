//! Credential Store — 키를 **앱 안에서** 넣고 지운다.
//!
//! 설계 근거는 docs/design/multi-engine-routing.md 12절, 착지 기준은 `landing.rs`의
//! `credential_checks`다. 여기서는 이 파일을 고칠 사람이 알아야 하는 것만 적는다.
//!
//! # 이 모듈이 바꾸는 것과 바꾸지 않는 것
//!
//! 바꾸는 것: **키가 어디서 오는가.** 종전에는 환경변수 하나뿐이라 데스크톱 사용자가 앱
//! 안에서 키를 넣을 수 없었다.
//!
//! 바꾸지 않는 것: **키가 sidecar로 가는 길.** 여전히 spawn 시 1회 주입이고 허용 목록으로
//! 걸러진다(`lib.rs`의 `credential_injection_for`). 저장소는 그 주입 지점 **앞**에 놓이는
//! 것이지 경로를 바꾸는 것이 아니다 — `credential.get`은 되살아나지 않는다(process-architecture
//! 8.2절이 지운 메서드이고, 저장소를 만들면서 되살리고 싶어지는 자리라 착지 기준
//! `injectionStaysOnce`로 못박아 두었다).
//!
//! # 왜 트레이트인가 — 그리고 왜 폴백이 없는가
//!
//! DPAPI는 Windows API다. 개발은 Linux에서 도므로 저장 계층을 트레이트 뒤에 두어야 한다.
//! 그런데 **조용한 폴백이 이 구조에서 가장 위험한 것**이다: 개발용 구현이 프로덕션에서
//! 쓰이면 "키가 안전하게 저장된다"가 거짓이 되고, 그 증상은 보이지 않는다.
//!
//! 그래서 폴백을 규율이 아니라 **컴파일러**로 막는다. [`MemoryCredentialStore`]는
//! `#[cfg(any(test, not(windows)))]`이므로 **Windows 릴리스 빌드에는 타입 자체가 없다.**
//! 폴백을 쓰려면 그 cfg를 고쳐야 하고, 그건 눈에 띄는 변경이다. Windows에서 저장소를 열지
//! 못하면 오류를 낸다 — 조용히 다른 것으로 바꾸지 않는다.
//!
//! # 값이 새어 나가지 않게 하는 세 장치
//!
//! 1. [`Secret`]은 `Debug`가 값을 가린다. `Display`도 `Serialize`도 없다 —
//!    `format!("{secret:?}")`이 로그·이벤트·오류 메시지 어디에 있어도 값이 나오지 않는다.
//! 2. [`CredentialInjection`]의 값 꺼내기(`into_pairs`)는 `pub(crate)`다. **다른 크레이트는
//!    값을 꺼낼 수단이 없다** — `src-tauri` 껍데기는 이 봉투를 만드는 곳에서 spawn하는 곳으로
//!    옮길 수만 있다. 원칙 3("UI 프로세스는 API 키를 갖지 않는다")이 문서가 아니라 가시성으로
//!    강제되는 자리다.
//! 3. 조회 API는 [`CredentialStore::has`]다 — "있다/없다"만 돌려준다. 값을 읽는 것은
//!    [`CredentialStore::read_for_injection`] 하나뿐이고, 이름이 곧 유일한 정당한 호출자를
//!    가리킨다(`lib.rs`의 주입 지점).
//!
//! # 검증 경계 — 여기서 통과한 verify가 Windows 구현에 대해 말해주는 것은 없다
//!
//! `win_credentials.rs`는 `[target.'cfg(windows)'.dependencies]`에 달린 `windows-sys`를 쓰므로
//! Linux에서는 **한 줄도 컴파일되지 않는다**(`win_job.rs`와 같은 성질 — state-machine 20.5절).
//! 그래서 착지 기준으로 판정받아야 한다.

#[cfg(any(test, not(windows)))]
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
#[cfg(any(test, not(windows)))]
use std::sync::Mutex;

/// 자격증명 값. **값을 인쇄할 수 없는 것이 요점이다.**
///
/// `Debug`만 있고 값을 가린다. `Display`·`Serialize`·`Deref`를 붙이지 말 것 —
/// 하나라도 붙는 순간 `format!`/`json!`/`?`가 값을 흘리는 경로가 된다.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// 공백만 있는 값은 **없는 것으로 본다.** 빈 문자열을 키로 저장하면 화면에는 "설정됨"으로
    /// 보이는데 호출은 인증 실패로 죽는다 — 원인과 가장 먼 증상이다.
    pub fn new(value: impl Into<String>) -> Result<Self, CredentialError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(CredentialError::EmptySecret);
        }
        Ok(Self(value))
    }

    /// 값을 꺼낸다. **이름이 경고다** — 부르는 자리를 늘리지 말 것.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // 길이도 적지 않는다. 길이는 어느 공급자의 키인지를 좁히는 정보다.
        f.write_str("Secret(<가려짐>)")
    }
}

/// 어떤 저장 계층이 실제로 쓰이고 있는가. **화면이 이 값을 사실대로 말해야 한다.**
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoreKind {
    /// Windows Credential Manager — 저장이 DPAPI를 지난다.
    WindowsCredentialManager,
    /// 개발용. **프로세스 메모리에만 있다** — 디스크에 아무것도 쓰지 않고 앱을 끄면 사라진다.
    DevelopmentInMemory,
}

impl StoreKind {
    /// 이것으로 "키가 안전하게 저장된다"고 말할 수 있는가.
    pub fn is_production(self) -> bool {
        matches!(self, StoreKind::WindowsCredentialManager)
    }

    /// 앱을 다시 켜도 남는가. `false`면 화면이 그 사실을 말해야 한다 —
    /// 넣은 키가 사라지는 것을 사용자가 버그로 읽는다.
    pub fn survives_restart(self) -> bool {
        matches!(self, StoreKind::WindowsCredentialManager)
    }

    pub fn label(self) -> &'static str {
        match self {
            StoreKind::WindowsCredentialManager => "Windows Credential Manager (DPAPI)",
            StoreKind::DevelopmentInMemory => "개발용 메모리 저장소 — 디스크에 쓰지 않고 앱을 끄면 사라진다",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    #[error("공급자 id가 저장소 이름으로 쓸 수 없는 모양입니다: {0:?}")]
    InvalidProviderId(String),
    #[error("빈 값은 저장하지 않습니다 — 화면에는 설정됨으로 보이는데 호출은 인증 실패로 죽습니다")]
    EmptySecret,
    /// 저장 계층 자체가 실패했다. **`detail`에 값이 들어가지 않는다** — `Secret`은
    /// `Display`가 없으므로 실수로도 넣을 수 없다.
    #[error("자격증명 저장소 {op} 실패: {detail}")]
    Backend { op: &'static str, detail: String },
}

/// 공급자 id가 저장소 이름의 일부로 쓸 수 있는 모양인가.
///
/// **저장 이름(`TARGET_PREFIX` + id)을 지키는 것이 목적이다.** 임의 문자열이 들어오면
/// Credential Manager의 다른 항목을 가리키는 이름을 만들 수 있다. 어떤 공급자가 제품에
/// 존재하는가는 여기서 판정하지 않는다 — 그건 `PROVIDER_ENV_VARS`의 일이고, 저장 계층이
/// 제품 표를 알면 저장 계층의 테스트가 제품 표에 묶인다.
fn valid_provider_id(provider_id: &str) -> bool {
    !provider_id.is_empty()
        && provider_id.len() <= 64
        && provider_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// 저장 이름의 접두사. **되돌리기 비싼 결정이다** — 바꾸면 이미 저장한 사용자의 키가
/// 사라진 것처럼 보인다(근거: multi-engine-routing.md 12.1절).
pub const TARGET_PREFIX: &str = "TomverseCode/";

/// 이 공급자의 저장 이름.
pub fn target_name(provider_id: &str) -> Result<String, CredentialError> {
    if !valid_provider_id(provider_id) {
        return Err(CredentialError::InvalidProviderId(provider_id.to_string()));
    }
    Ok(format!("{TARGET_PREFIX}{provider_id}"))
}

/// 자격증명 저장 계층.
///
/// **읽기가 하나뿐인 것이 설계다.** `has`는 "있다/없다"만 돌려주고, 값을 주는 것은
/// `read_for_injection` 하나다. 그 이름이 유일한 정당한 호출자(주입 지점)를 가리킨다 —
/// 새 호출자를 만들기 전에 착지 기준 `uiNeverHoldsTheKey`를 먼저 읽을 것.
pub trait CredentialStore: Send + Sync {
    fn kind(&self) -> StoreKind;

    /// 넣는다. 이미 있으면 덮어쓴다.
    fn store(&self, provider_id: &str, secret: Secret) -> Result<(), CredentialError>;

    /// 지운다. 반환값은 **지울 것이 있었는가**다 — 없었던 것과 실패는 다른 사실이다.
    fn forget(&self, provider_id: &str) -> Result<bool, CredentialError>;

    /// 있는가. **값은 돌려주지 않는다.**
    fn has(&self, provider_id: &str) -> Result<bool, CredentialError>;

    /// 값을 읽는다 — **sidecar spawn 주입 지점 하나만 부른다.**
    fn read_for_injection(&self, provider_id: &str) -> Result<Option<Secret>, CredentialError>;
}

/// sidecar에 넘길 환경변수 봉투.
///
/// # 왜 `Vec<(String, String)>`을 그대로 쓰지 않는가
///
/// 종전에는 `credential_env_for`가 평문 쌍을 그대로 돌려주었고, 그것을 받는 코드가
/// **`src-tauri` 껍데기 크레이트**였다(`session.rs`). 원칙 3은 UI 프로세스가 키를 갖지
/// 않는다고 말하는데, 그 규칙이 "껍데기가 값을 들여다보지 않는다"는 규율로만 지켜지고 있었다.
///
/// 봉투로 감싸고 값 꺼내기를 `pub(crate)`로 두면 **다른 크레이트는 값을 꺼낼 수단이 없다.**
/// 껍데기는 만드는 곳에서 spawn하는 곳으로 옮길 수만 있다. 규율이 아니라 가시성이 지킨다.
#[derive(Default)]
pub struct CredentialInjection {
    pairs: Vec<(String, String)>,
    /// 이 중 자격증명인 것의 이름. 진단에 쓴다 — **값이 아니라 이름이다.**
    secret_names: Vec<String>,
}

impl CredentialInjection {
    pub fn new() -> Self {
        Self::default()
    }

    /// 자격증명 하나를 담는다.
    pub fn push_secret(&mut self, env_name: impl Into<String>, secret: Secret) {
        let env_name = env_name.into();
        self.secret_names.push(env_name.clone());
        self.pairs.push((env_name, secret.0));
    }

    /// 자격증명이 **아닌** 값(fake 스크립트 경로, 모델 핀 등).
    pub fn push_plain(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.pairs.push((name.into(), value.into()));
    }

    /// 주입되는 자격증명 환경변수 이름들. 허용 목록이 실제로 걸렸는지 확인할 때 쓴다.
    pub fn secret_names(&self) -> Vec<&str> {
        self.secret_names.iter().map(String::as_str).collect()
    }

    pub fn secret_count(&self) -> usize {
        self.secret_names.len()
    }

    /// **이 크레이트 안에서만 값을 꺼낸다.** `launcher::config_from`이 유일한 소비자다.
    pub(crate) fn into_pairs(self) -> Vec<(String, String)> {
        self.pairs
    }
}

impl fmt::Debug for CredentialInjection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // 자격증명이 아닌 값도 인쇄하지 않는다 — 이름만으로 "무엇이 주입됐는가"는 충분히 보이고,
        // 값을 넣기 시작하면 어느 것이 비밀인지를 이 함수가 판단해야 한다.
        let names: Vec<&str> = self.pairs.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("CredentialInjection")
            .field("names", &names)
            .field("secrets", &self.secret_names)
            .finish()
    }
}

/// 개발용 저장소 — **메모리에만 있다.**
///
/// # 왜 파일에 쓰지 않는가
///
/// Linux/macOS에도 키체인은 있지만 이 제품은 Windows 데스크톱 앱이고, 개발 환경을 위해
/// 두 번째 프로덕션 저장 계층을 만드는 것은 이 작업의 범위가 아니다. 그렇다고 파일에 쓰면
/// **평문이 디스크에 남는다** — 착지 기준 `noPlaintextAtRest`가 금지하는 바로 그것이다.
/// "직접 암호화한다"는 더 나쁘다: 키를 어디에 둘지가 그대로 남는데, 암호화했다는 사실이
/// 잘못된 확신을 준다.
///
/// 그래서 **저장하지 않는 것**을 고른다. 앱을 끄면 사라지고, 그 사실을 `survives_restart`가
/// 화면에 말한다. 개발자는 종전대로 환경변수를 쓰면 된다.
///
/// `cfg(any(test, not(windows)))`인 이유는 모듈 주석에 있다 — Windows 릴리스 빌드에
/// **타입 자체가 없어야** 조용한 폴백이 불가능하다.
#[cfg(any(test, not(windows)))]
pub struct MemoryCredentialStore {
    entries: Mutex<BTreeMap<String, String>>,
}

#[cfg(any(test, not(windows)))]
impl Default for MemoryCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(test, not(windows)))]
impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
        }
    }
}

#[cfg(any(test, not(windows)))]
impl CredentialStore for MemoryCredentialStore {
    fn kind(&self) -> StoreKind {
        StoreKind::DevelopmentInMemory
    }

    fn store(&self, provider_id: &str, secret: Secret) -> Result<(), CredentialError> {
        // 이름 검증을 여기서도 지난다 — 개발용이라고 규칙이 다르면, 개발에서 통과한 것이
        // Windows에서 거부되는 차이가 생긴다.
        let key = target_name(provider_id)?;
        self.entries.lock().unwrap().insert(key, secret.0);
        Ok(())
    }

    fn forget(&self, provider_id: &str) -> Result<bool, CredentialError> {
        let key = target_name(provider_id)?;
        Ok(self.entries.lock().unwrap().remove(&key).is_some())
    }

    fn has(&self, provider_id: &str) -> Result<bool, CredentialError> {
        let key = target_name(provider_id)?;
        Ok(self.entries.lock().unwrap().contains_key(&key))
    }

    fn read_for_injection(&self, provider_id: &str) -> Result<Option<Secret>, CredentialError> {
        let key = target_name(provider_id)?;
        Ok(self.entries.lock().unwrap().get(&key).map(|v| Secret(v.clone())))
    }
}

/// 이 플랫폼의 저장소를 연다.
///
/// **폴백이 없다.** Windows 릴리스 빌드에는 개발용 타입이 아예 없으므로(모듈 주석),
/// 이 함수를 고쳐도 조용한 폴백을 쓸 수 없다 — 컴파일이 깨진다.
///
/// # 왜 `Result`가 아닌가
///
/// 여는 데에 얻어야 할 자원이 없다. Credential Manager는 호출할 때마다 여닫는 API이고
/// 개발용 저장소는 빈 맵이다. `Result`로 두면 호출자마다 "열지 못했을 때"라는 분기를 갖게
/// 되는데, **그 분기가 곧 조용한 폴백이 자라는 자리다.** 실패는 열 때가 아니라
/// `store`/`forget`/`has`에서 나고, 그 자리가 사용자에게 보일 자리이기도 하다.
pub fn open_credential_store() -> Arc<dyn CredentialStore> {
    #[cfg(windows)]
    {
        Arc::new(crate::win_credentials::WindowsCredentialStore::new())
    }
    #[cfg(not(windows))]
    {
        Arc::new(MemoryCredentialStore::new())
    }
}

/// 이 플랫폼에서 기대되는 저장소 종류. 착지 판정과 테스트가 같은 규칙을 본다.
pub fn expected_kind_here() -> StoreKind {
    if cfg!(windows) {
        StoreKind::WindowsCredentialManager
    } else {
        StoreKind::DevelopmentInMemory
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MemoryCredentialStore {
        MemoryCredentialStore::new()
    }

    /// **트레이트 계약**: 넣고, 있고, 읽고, 지우고, 없다.
    #[test]
    fn the_contract_is_store_has_read_forget() {
        let s = store();
        assert!(!s.has("openai").unwrap());
        assert!(s.read_for_injection("openai").unwrap().is_none());

        s.store("openai", Secret::new("sk-live").unwrap()).unwrap();
        assert!(s.has("openai").unwrap());
        assert_eq!(s.read_for_injection("openai").unwrap().unwrap().expose(), "sk-live");

        assert!(s.forget("openai").unwrap(), "지울 것이 있었으면 true여야 합니다");
        assert!(!s.has("openai").unwrap());
    }

    /// **없었던 것과 실패는 다른 사실이다.** 없는 것을 지우는 것은 오류가 아니고,
    /// `false`가 그 사실을 전한다 — 화면이 "지웠습니다"라고 말하지 않게 하는 근거다.
    #[test]
    fn forgetting_what_is_not_there_is_not_an_error() {
        assert!(!store().forget("openai").unwrap());
    }

    #[test]
    fn storing_again_overwrites() {
        let s = store();
        s.store("openai", Secret::new("first").unwrap()).unwrap();
        s.store("openai", Secret::new("second").unwrap()).unwrap();
        assert_eq!(s.read_for_injection("openai").unwrap().unwrap().expose(), "second");
    }

    /// 공급자끼리 섞이지 않는다 — 저장 이름이 id로 갈린다.
    #[test]
    fn providers_do_not_share_a_slot() {
        let s = store();
        s.store("openai", Secret::new("a").unwrap()).unwrap();
        s.store("anthropic", Secret::new("b").unwrap()).unwrap();
        assert_eq!(s.read_for_injection("openai").unwrap().unwrap().expose(), "a");
        assert_eq!(s.read_for_injection("anthropic").unwrap().unwrap().expose(), "b");
        s.forget("openai").unwrap();
        assert!(s.has("anthropic").unwrap(), "다른 공급자가 함께 지워졌습니다");
    }

    /// **빈 값은 저장되지 않는다.** 화면에는 "설정됨"으로 보이는데 호출이 인증 실패로 죽는
    /// 상태를 만들지 않는다.
    #[test]
    fn a_blank_secret_is_refused_before_it_reaches_the_store() {
        assert_eq!(Secret::new("   ").unwrap_err(), CredentialError::EmptySecret);
        assert_eq!(Secret::new("").unwrap_err(), CredentialError::EmptySecret);
    }

    /// 저장 이름을 임의 문자열로 만들 수 없다 — Credential Manager의 다른 항목을 가리키는
    /// 이름이 만들어지면 안 된다.
    #[test]
    fn a_provider_id_cannot_shape_the_target_name() {
        let too_long = "a".repeat(65);
        for bad in ["", "../other", "Open AI", "openai/../x", "OPENAI", too_long.as_str()] {
            assert!(
                matches!(target_name(bad), Err(CredentialError::InvalidProviderId(_))),
                "{bad:?}가 저장 이름으로 통과했습니다"
            );
        }
        assert_eq!(target_name("openai").unwrap(), "TomverseCode/openai");
    }

    /// 개발용 저장소도 같은 이름 규칙을 지난다 — 규칙이 갈리면 개발에서 통과한 것이
    /// Windows에서 거부된다.
    #[test]
    fn the_development_store_applies_the_same_name_rule() {
        assert!(matches!(
            store().store("Open AI", Secret::new("x").unwrap()),
            Err(CredentialError::InvalidProviderId(_))
        ));
    }

    /// **`Debug`가 값을 인쇄하지 않는다.** 로그·이벤트·오류 메시지 어디에 있어도 값이 나오지
    /// 않는 것이 이 타입의 존재 이유다.
    #[test]
    fn debug_never_prints_the_value() {
        let secret = Secret::new("sk-should-never-appear").unwrap();
        let printed = format!("{secret:?}");
        assert!(!printed.contains("sk-should-never-appear"), "{printed}");

        let mut injection = CredentialInjection::new();
        injection.push_secret("OPENAI_API_KEY", secret);
        injection.push_plain("TOMVERSE_FAKE_SCRIPT", "/tmp/script.json");
        let printed = format!("{injection:?}");
        assert!(!printed.contains("sk-should-never-appear"), "{printed}");
        // 이름은 보여야 한다 — 무엇이 주입됐는지는 진단에 필요하다.
        assert!(printed.contains("OPENAI_API_KEY"), "{printed}");
    }

    #[test]
    fn the_injection_envelope_counts_only_secrets() {
        let mut injection = CredentialInjection::new();
        injection.push_secret("OPENAI_API_KEY", Secret::new("a").unwrap());
        injection.push_plain("TOMVERSE_EXECUTOR_MODEL", "gpt-5");
        assert_eq!(injection.secret_count(), 1);
        assert_eq!(injection.secret_names(), vec!["OPENAI_API_KEY"]);
        assert_eq!(injection.into_pairs().len(), 2);
    }

    /// **이 플랫폼에서 열리는 저장소가 무엇인지 사실대로 말한다.**
    ///
    /// Windows에서 이 테스트가 `DevelopmentInMemory`를 보면 조용한 폴백이 일어난 것이다.
    #[test]
    fn the_store_opened_here_is_the_expected_one() {
        let store = open_credential_store();
        assert_eq!(store.kind(), expected_kind_here());
        assert_eq!(store.kind().is_production(), cfg!(windows));
    }
}
