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

#[cfg(test)]
mod tests {
    use super::*;

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
