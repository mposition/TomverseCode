//! 비밀값을 담을 수 있는 경로의 분류 — **Rust 쪽 독립 판정**.
//!
//! # 왜 Node에 있는데 또 만드는가
//!
//! Node의 Context Engine(`packages/sidecar/src/context/exclude.ts`)이 이미 secret 파일을
//! 모델 컨텍스트에서 제외한다. 그러나 그건 **Node가 스스로 지키는 규칙**이고,
//! process-architecture.md 2절의 신뢰 모델은 "Node가 완전히 장악당해도 Rust 게이트를 반드시
//! 통과해야 한다"이다. Node가 장악당하면 컨텍스트 필터를 우회해
//! `read_file(".env")`를 그냥 요청할 수 있고, 그때 막는 것은 Rust뿐이다.
//!
//! 그래서 목록이 두 곳에 있는 것은 중복이 아니라 **독립 검증**이다. 한쪽을 고칠 때
//! 다른 쪽도 함께 봐야 하며, 그 사실을 양쪽 주석에 적어둔다.
//!
//! # 이 분류가 하는 일과 하지 않는 일
//!
//! 하는 일: **경로 이름**으로 "여기엔 비밀값이 있을 수 있다"를 판정한다. 결정론적이고 빠르다.
//!
//! 하지 않는 일: 파일 **내용**에서 비밀값을 찾지 않는다. 내용 기반 탐지는 원리적으로 불완전하고
//! (모든 API 키 형식을 알 수 없다), 통과했을 때 "검사했으니 안전하다"는 잘못된 확신을 준다.
//! 이름 기반 하드 필터가 약속할 수 있는 것만 약속한다 —
//! context-engine.md 7절의 "진입 자체를 막는다"와 같은 태도다.
//!
//! # 예외: 경로가 없는 자유 텍스트 (`mask_secret_shapes` / `scan_secret_shapes`)
//!
//! 위 규칙의 유일한 예외가 아래 두 함수다. 사용자 판정 원문(`USER_DECISION_RECORDED`)에는
//! **검사할 경로 자체가 없어서** 이름 기반 필터를 적용할 대상이 없다. 둘 다 "안전하다"를
//! 주장하지 않고 알려진 모양만 다루는 완화다.
//!
//! 둘이 답하는 질문은 다르다. `mask_secret_shapes`는 **무엇을 저장할 것인가**(저장 직전 Rust가
//! 가린다), `scan_secret_shapes`는 **사용자에게 무엇을 알릴 것인가**(보내기 전에 경고한다).
//! 마스킹은 감사 로그만 지키고 **모델 공급자로 나가는 것은 막지 못한다** — 그건 사용자만
//! 막을 수 있으므로 알려야 한다. 근거는 17.11절.
//!
//! 모양 목록은 `SECRET_SHAPES` 하나뿐이다. 두 함수가 각자 목록을 가지면 경고 없이 가리거나
//! 가리지 않고 경고하는 상태가 생기고, 둘 다 사용자를 잘못 안심시킨다.

/// 경로가 비밀값을 담을 수 있는 것으로 분류되는가.
///
/// 입력은 **workspace 상대 경로**를 기대하며 구분자는 `/`와 `\` 모두 받는다
/// (Windows에서 넘어온 경로를 그대로 검사할 수 있어야 한다).
pub fn is_secret_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);

    // 디렉터리 전체가 비밀 — 안에 무엇이 있든 상관없다.
    for dir in [".ssh/", ".aws/", ".gnupg/"] {
        if normalized.starts_with(dir) || normalized.contains(&format!("/{dir}")) {
            return true;
        }
    }

    // `.env`, `.env.local`, `.env.production` … `.envrc`
    // `.env.example`을 빼지 않는 이유(exclude.ts와 동일): 이름만으로 "예시라서 안전"을 판정할 수
    // 없고, 컨텍스트에 없어서 잃는 것보다 잘못 보내서 잃는 것이 크다.
    if file_name == ".env" || file_name.starts_with(".env.") || file_name == ".envrc" {
        return true;
    }

    if matches!(file_name, ".npmrc" | ".netrc" | ".pgpass" | ".htpasswd") {
        return true;
    }

    // 개인키 계열 확장자.
    for ext in [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".asc", ".ppk"] {
        if file_name.ends_with(ext) {
            return true;
        }
    }

    // SSH 키는 확장자가 없다.
    for prefix in ["id_rsa", "id_ed25519", "id_dsa", "id_ecdsa"] {
        if file_name.starts_with(prefix) {
            return true;
        }
    }

    // `credentials`, `credentials.json`, `secret.yaml`, `secrets.toml` …
    let stem = file_name.split('.').next().unwrap_or(file_name);
    if matches!(stem, "credentials" | "secret" | "secrets") {
        return true;
    }

    // 접두사가 붙은 서비스 계정 키 — `gcp-service-account-prod.json`처럼 실제로 흔한 이름이다.
    if file_name.ends_with(".json") && (file_name.contains("service-account") || file_name.contains("service_account"))
    {
        return true;
    }
    if file_name.ends_with(".json") && (file_name.contains("gcp-key") || file_name.contains("gcp_key")) {
        return true;
    }

    false
}

/// 자유 텍스트에서 **비밀값처럼 생긴 토큰**을 가린다. 가린 개수를 함께 돌려준다.
///
/// # 왜 경로 판정으로 충분하지 않은가
///
/// 위의 `is_secret_path`는 **경로 이름**으로 판정한다. 그런데 사용자가 재질문에 답하면서
/// 답변 본문에 토큰을 붙여넣는 경우가 실제로 있고(문서 17.3절), 그 답변에는 경로가 없다.
/// `USER_DECISION_RECORDED`는 판정 원문을 남기는 이벤트이므로 그대로 두면 감사 로그에
/// 자격증명이 영구히 박힌다.
///
/// # 이것이 약속하는 것과 약속하지 않는 것
///
/// 이 모듈 앞부분은 "파일 **내용**에서 비밀값을 찾지 않는다 — 원리적으로 불완전하고, 통과했을 때
/// 잘못된 확신을 준다"고 적어두었다. **그 판단은 지금도 유효하며 여기서 뒤집지 않는다.**
/// 이 함수는 "검사했으니 안전하다"를 주장하지 않는다 — 알려진 모양만 가리는 **완화**이고,
/// 그래서 결과에 마스킹 **개수**를 함께 돌려준다. 호출자는 그 수를 이벤트에 남겨
/// "가린 것이 있었다"를 기록하지, "남은 것이 없다"를 기록하지 않는다.
///
/// 자유 텍스트에 이 완화라도 두는 이유는 대안이 둘뿐이기 때문이다: 원문을 통째로 버리거나
/// (그러면 판정자의 판정이 감사 로그에서 다시 사라진다), 원문을 그대로 남기거나
/// (알려진 모양조차 막지 않는다). 둘 다 이것보다 나쁘다.
pub fn mask_secret_shapes(text: &str) -> (String, usize) {
    let mut masked = 0usize;
    let out = secret_shape_regex().replace_all(text, |caps: &regex::Captures<'_>| {
        masked += 1;
        // 어떤 종류였는지는 남긴다 — 전부 같은 문자열로 바꾸면 나중에 로그를 읽는 사람이
        // "무엇이 가려졌나"를 전혀 알 수 없다. 값 자체는 한 글자도 남기지 않는다.
        format!("[REDACTED:{}]", caps[0].len())
    });
    (out.into_owned(), masked)
}

/// 알려진 자격증명 모양과 **사람이 읽을 이름**. 완결 목록이 아니다 —
/// 새 공급자가 새 접두사를 쓰면 여기 없다.
///
/// # 이름을 함께 두는 이유
///
/// 입력 시점 경고(17.11절)가 "무언가 자격증명처럼 보입니다"만 말하면 사용자는 긴 답변의
/// 어디를 봐야 하는지 알 수 없다. **값은 한 글자도 돌려주지 않으므로** 이름이 유일한 단서다.
///
/// 목록이 하나인 것도 결정이다. 가리는 쪽(`mask_secret_shapes`)과 경고하는 쪽
/// (`scan_secret_shapes`)이 각자 목록을 가지면, 경고하지 않고 가리거나 가리지 않고 경고하는
/// 상태가 생긴다. 둘 다 사용자를 잘못 안심시킨다.
const SECRET_SHAPES: &[(&str, &str)] = &[
    // OpenAI / Anthropic 계열 접두사 + 충분히 긴 본문
    ("OpenAI·Anthropic 계열 키", r"(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}"),
    ("Stripe 계열 키", r"sk_(?:live|test)_[A-Za-z0-9]{16,}"),
    ("Google API 키", r"AIza[A-Za-z0-9_\-]{20,}"),
    // GitHub 토큰 (ghp_/gho_/ghu_/ghs_/ghr_)
    ("GitHub 토큰", r"gh[pousr]_[A-Za-z0-9]{20,}"),
    ("GitHub 개인 액세스 토큰", r"github_pat_[A-Za-z0-9_]{20,}"),
    ("Slack 토큰", r"xox[abposr]-[A-Za-z0-9\-]{10,}"),
    ("AWS 액세스 키 ID", r"(?:AKIA|ASIA)[A-Z0-9]{16}"),
    ("JWT", r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    (
        "PEM 개인키",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    ),
    // `Authorization: Bearer <token>` 의 토큰 부분
    ("Bearer 토큰", r"(?i:bearer)\s+[A-Za-z0-9_\-\.=]{20,}"),
];

/// 위 목록을 하나로 합친 정규식. **가리는 것과 세는 것의 정본**이다.
fn secret_shape_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        // 각 모양을 `(?:)`로 감싼다 — 감싸지 않으면 모양 안의 `|`가 바깥 교대와 섞여
        // 목록에 항목을 추가하는 순간 조용히 다른 것을 매칭하게 된다.
        let joined = SECRET_SHAPES
            .iter()
            .map(|(_, pattern)| format!("(?:{pattern})"))
            .collect::<Vec<_>>()
            .join("|");
        regex::Regex::new(&joined).expect("secret shape regex는 컴파일 시점에 고정된 상수다")
    })
}

/// 모양별 정규식. **양끝을 고정한다** — 고정하지 않으면 `Bearer eyJ…`가 JWT로 이름 붙는다
/// (JWT 모양이 그 안에 들어 있기 때문이다). 이름이 틀리면 사용자가 엉뚱한 곳을 본다.
fn anchored_shape_regexes() -> &'static [regex::Regex] {
    static RES: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    RES.get_or_init(|| {
        SECRET_SHAPES
            .iter()
            .map(|(_, pattern)| regex::Regex::new(&format!("^(?:{pattern})$")).expect("고정된 상수다"))
            .collect()
    })
}

/// 자유 텍스트에서 발견된 자격증명 모양의 **이름과 개수**. 값은 담지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SecretShapeHit {
    pub label: String,
    pub count: usize,
}

/// 텍스트를 **바꾸지 않고** 자격증명처럼 보이는 것이 있는지만 본다 — 입력 시점 경고용(17.11절).
///
/// # 왜 마스킹과 별개의 함수인가
///
/// 두 함수가 답하는 질문이 다르다. `mask_secret_shapes`는 "무엇을 저장할 것인가"이고,
/// 이건 "사용자에게 무엇을 알릴 것인가"다. 경고 단계에서 텍스트를 바꾸면 사용자가 자기가
/// 쓴 것과 다른 것을 보게 되고, 그건 편집 중인 입력에 할 수 있는 일이 아니다.
///
/// # 값을 돌려주지 않는다
///
/// 발견된 값 자체는 결과에 담지 않는다. UI는 이미 그 텍스트를 갖고 있으므로 필요가 없고,
/// 프로세스 경계를 넘는 곳마다 자격증명 사본이 하나씩 늘어나는 것은 그 자체로 노출면이다.
///
/// **개수는 결합 정규식에서 센다.** 모양별로 따로 세면 겹치는 모양(`Bearer` 안의 JWT)이
/// 두 번 세어져, 가려질 개수와 경고에 적힌 개수가 어긋난다.
pub fn scan_secret_shapes(text: &str) -> Vec<SecretShapeHit> {
    let mut counts: std::collections::BTreeMap<&'static str, usize> = std::collections::BTreeMap::new();
    for matched in secret_shape_regex().find_iter(text) {
        *counts.entry(shape_label(matched.as_str())).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .map(|(label, count)| SecretShapeHit {
            label: label.to_string(),
            count,
        })
        .collect()
}

fn shape_label(matched: &str) -> &'static str {
    for (index, (label, _)) in SECRET_SHAPES.iter().enumerate() {
        if anchored_shape_regexes()[index].is_match(matched) {
            return label;
        }
    }
    // 결합 정규식이 잡았는데 어떤 모양도 고정 매칭되지 않는 경우는 정의상 없다.
    // 그래도 패닉하지 않는다 — 이름 하나 때문에 입력창을 죽이는 것은 균형이 맞지 않는다.
    // 테스트가 이 값이 나오지 않음을 지킨다.
    "알 수 없는 모양"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_known_credential_shapes() {
        for raw in [
            "키는 sk-abcdefghijklmnopqrstuvwxyz012345 입니다",
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz 를 쓰세요",
            "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789",
            "xoxb-1234567890-abcdefghij",
            "AKIAIOSFODNN7EXAMPLE",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop",
            "AIzaSyA0123456789abcdefghijklmnopqrstu",
            "sk_live_0123456789abcdefghij",
        ] {
            let (masked, count) = mask_secret_shapes(raw);
            assert!(count >= 1, "{raw}에서 아무것도 마스킹되지 않았습니다");
            assert!(
                masked.contains("[REDACTED:"),
                "{raw}의 마스킹 결과에 표식이 없습니다: {masked}"
            );
        }
    }

    /// 결합 정규식이 잡은 것에는 **반드시 이름이 붙어야 한다.** 이름이 "알 수 없는 모양"으로
    /// 떨어지면 경고가 사용자에게 어디를 보라고 말하지 못한다.
    #[test]
    fn every_matched_shape_gets_a_name() {
        for raw in [
            "sk-abcdefghijklmnopqrstuvwxyz012345",
            "sk_live_0123456789abcdefghij",
            "AIzaSyA0123456789abcdefghijklmnopqrstu",
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
            "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789",
            "xoxb-1234567890-abcdefghij",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop",
        ] {
            let hits = scan_secret_shapes(raw);
            assert!(!hits.is_empty(), "{raw}에서 아무것도 잡히지 않았습니다");
            for hit in &hits {
                assert_ne!(hit.label, "알 수 없는 모양", "{raw} → {hit:?}");
            }
        }
    }

    /// **겹치는 모양을 두 번 세지 않는다.** `Bearer eyJ…`는 Bearer 안에 JWT가 들어 있어서,
    /// 모양별로 따로 세면 2개가 된다. 그러면 경고에 적힌 개수가 실제로 가려질 개수와 어긋나고,
    /// 사용자는 하나를 지운 뒤에도 경고가 남는 이유를 알 수 없다.
    #[test]
    fn overlapping_shapes_are_counted_once_and_named_by_the_outer_one() {
        let hits = scan_secret_shapes("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].count, 1, "{hits:?}");
        assert_eq!(hits[0].label, "Bearer 토큰", "{hits:?}");

        // 세는 방식이 마스킹과 같아야 한다 — 두 숫자가 다르면 어느 쪽이 맞는지 알 수 없다.
        let (_masked, count) = mask_secret_shapes("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop");
        assert_eq!(count, hits.iter().map(|h| h.count).sum::<usize>());
    }

    /// **검사는 텍스트를 바꾸지 않는다.** 편집 중인 입력을 사용자 몰래 고치면, 사용자가 자기가
    /// 쓴 것과 다른 것을 보게 된다.
    #[test]
    fn scanning_reports_names_and_counts_but_never_the_value() {
        let secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
        let hits = scan_secret_shapes(&format!("이 키 {secret} 를 쓰세요"));
        assert_eq!(hits.len(), 1);
        // 값 조각이 결과에 들어가면 프로세스 경계를 넘는 곳마다 사본이 하나씩 는다.
        let serialized = serde_json::to_string(&hits).unwrap();
        assert!(
            !serialized.contains("abcdefghij"),
            "값이 결과에 담겼습니다: {serialized}"
        );
    }

    #[test]
    fn ordinary_text_is_not_flagged() {
        // 거짓 경보는 공짜가 아니다 — 매번 뜨면 사용자가 경고를 읽지 않게 된다.
        for raw in [
            "빈 문자열은 거부한다",
            "sk-짧음",
            "validate.test.ts:41 을 보세요",
            "AKIA_TOO_SHORT",
        ] {
            assert!(scan_secret_shapes(raw).is_empty(), "{raw}가 자격증명으로 잡혔습니다");
        }
    }

    #[test]
    fn masked_output_keeps_no_fragment_of_the_secret() {
        // 앞부분만 남기는 식의 "미리보기"는 보호가 아니다 — 키 전체가 대개 그 안에 들어간다.
        let secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
        let (masked, _) = mask_secret_shapes(&format!("답: 빈 문자열은 거부. 참고로 {secret} 씀"));
        assert!(!masked.contains("abcdefghij"), "비밀값 조각이 남았습니다: {masked}");
        // 판정 원문의 나머지는 그대로 남아야 한다 — 통째로 버리면 감사 로그가 다시 비어버린다.
        assert!(masked.contains("빈 문자열은 거부"));
    }

    #[test]
    fn leaves_ordinary_answers_alone() {
        // 오탐이 많으면 판정 원문이 읽을 수 없게 되고, 그러면 감사 로그의 가치가 사라진다.
        for raw in [
            "빈 문자열 이메일은 거부해주세요",
            "src/validate.ts 의 checkEmail 을 고치면 됩니다",
            "package-lock.json 은 건드리지 마세요",
            "sk-short",
            "PR #1234 를 참고하세요",
        ] {
            let (masked, count) = mask_secret_shapes(raw);
            assert_eq!(count, 0, "{raw}가 잘못 마스킹되었습니다: {masked}");
            assert_eq!(masked, raw);
        }
    }

    #[test]
    fn masks_private_key_blocks_entirely() {
        let raw = "-----BEGIN RSA PRIVATE KEY-----
MIIEow
AQEA
-----END RSA PRIVATE KEY-----";
        let (masked, count) = mask_secret_shapes(raw);
        assert_eq!(count, 1);
        assert!(!masked.contains("MIIEow"), "개인키 본문이 남았습니다: {masked}");
    }

    #[test]
    fn classifies_env_files() {
        for path in [
            ".env",
            ".env.local",
            ".env.production",
            "apps/web/.env",
            "apps\\web\\.env.local",
            ".envrc",
            // 예시 파일도 제외 대상이다 — 실제로 키를 적어두는 경우가 흔하다.
            ".env.example",
        ] {
            assert!(is_secret_path(path), "{path}가 secret으로 분류되지 않았습니다");
        }
    }

    #[test]
    fn classifies_keys_and_credentials() {
        for path in [
            "certs/server.pem",
            "server.key",
            "keystore.p12",
            "app.pfx",
            "release.keystore",
            "release.jks",
            ".ssh/id_rsa",
            "home/.ssh/known_hosts",
            "id_ed25519",
            "id_ed25519.pub",
            ".aws/credentials",
            "credentials.json",
            "config/secrets.yaml",
            "config/secret.toml",
            "gcp-service-account-prod.json",
            "infra/gcp_service_account.json",
            ".npmrc",
            ".netrc",
        ] {
            assert!(is_secret_path(path), "{path}가 secret으로 분류되지 않았습니다");
        }
    }

    #[test]
    fn does_not_classify_ordinary_source_files() {
        // 오탐이 많으면 정상 작업이 매번 승인 모달을 띄우게 되어 승인이 무의미해진다.
        for path in [
            "src/app.ts",
            "src/keyboard.ts",
            "src/monkey.js",
            "README.md",
            "package.json",
            "tsconfig.json",
            "Cargo.toml",
            "docs/environment.md",
            "src/components/KeyBadge.tsx",
            "test/fixtures/sample.json",
        ] {
            assert!(!is_secret_path(path), "{path}가 잘못 secret으로 분류되었습니다");
        }
    }

    #[test]
    fn is_case_insensitive() {
        assert!(is_secret_path(".ENV"));
        assert!(is_secret_path("Certs/Server.PEM"));
        assert!(is_secret_path(".SSH/id_rsa"));
    }
}
