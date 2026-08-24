//! PR 연동 — 브랜치를 올리고 **사용자의 브라우저가** PR 폼을 연다.
//!
//! product-strategy 8.2절 기준: **"GitHub PR 생성"**. state-machine-and-protocol.md 28절.
//!
//! # 우리는 GitHub에 요청을 보내지 않는다
//!
//! PR을 만드는 자연스러운 구현은 GitHub API를 호출하는 것이고, 그러면 토큰이 필요하다.
//! 그 길을 가지 않았다.
//!
//! `compare` URL은 제목과 본문을 쿼리로 미리 채운 **PR 생성 폼**을 연다. 그 요청을 보내는
//! 것은 사용자의 브라우저이고, 우리는 URL 한 줄을 낼 뿐이다. 얻는 것이 셋이다:
//!
//!  - **자격증명이 없다.** 저장할 토큰이 없으면 샐 토큰도 없다.
//!  - **전송 투명성이 깨지지 않는다**(7절). 우리가 어디로도 코드를 보내지 않는다 —
//!    push는 사용자의 remote로 가고, 그건 사용자가 이미 설정해 둔 곳이다.
//!  - **마지막 확인이 사람에게 남는다.** 제목·본문·대상 브랜치를 사용자가 폼에서 보고 누른다.
//!
//! 대가도 적어 둔다: **PR 번호를 돌려받지 못한다.** 열렸는지도 우리는 모른다. 그걸 알아야
//! 하는 기능(리뷰 코멘트 반영)은 8.2 표의 "이후 깊이 확장"이고, 그때 이 결정을 다시 본다.
//!
//! # 왜 이게 사용자 명령인가
//!
//! `pr`은 모델의 도구가 아니라 **사용자가 부르는 하위 명령**이다. 되돌리기(19절)와 같은
//! 자리다: 되돌릴 수 없거나 바깥으로 나가는 동작은 사용자가 고른 것만 우리가 수행한다.

use crate::types::RunCommandArgs;

/// `git push`의 **아는 모양**. 임의 argv를 받지 않는다(28.2절).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PushArgError {
    #[error("push 대상에 {field}가 없습니다")]
    Missing { field: &'static str },
    #[error("push 대상 {field}의 모양이 아닙니다: {value:?} — 이름만 받습니다(refspec·옵션 불가)")]
    Malformed { field: &'static str, value: String },
}

/// `git_push` 요청의 인자를 뜯는다.
///
/// **모르는 모양은 통과시키지 않는다.** 승인 화면이 무엇을 승인하는지 정하지 못하는 요청은
/// 승인 대상이 아니라 거부 대상이다(23.4절과 같은 규칙).
pub fn parse_push(args: &serde_json::Value) -> Result<PushTarget, PushArgError> {
    let field = |name: &'static str| -> Result<String, PushArgError> {
        let value = args
            .get(name)
            .and_then(|v| v.as_str())
            .ok_or(PushArgError::Missing { field: name })?;
        if !is_plain_ref_name(value) {
            return Err(PushArgError::Malformed {
                field: name,
                value: value.to_string(),
            });
        }
        Ok(value.to_string())
    };
    Ok(PushTarget {
        remote: field("remote")?,
        branch: field("branch")?,
    })
}

/// 이름인가 — 옵션도 refspec도 아닌가.
///
/// `-`로 시작하면 옵션이고(`--force`), `:`가 있으면 refspec이다(`local:remote`). 둘 다
/// **우리가 조립한 명령의 의미를 바꾼다** — 원칙 6이 지키려는 것이 정확히 그것이다.
fn is_plain_ref_name(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.contains(':')
        && !value.contains("..")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

impl PushTarget {
    /// 실제로 실행되는 argv. **`--force`도 refspec도 없다.**
    ///
    /// 되돌릴 수 없는 동작을 우리가 대신 실행하지 않는다는 19.2절의 판단이 여기도 적용된다:
    /// force push는 남의 이력을 지울 수 있고, 그게 이미 공유됐는지 우리는 알 수 없다.
    pub fn command(&self) -> RunCommandArgs {
        RunCommandArgs {
            program: "git".to_string(),
            args: vec!["push".to_string(), self.remote.clone(), self.branch.clone()],
            cwd: ".".to_string(),
            timeout_ms: None,
        }
    }

    /// 승인 화면과 이벤트가 보는 문자열. **이 값 그대로**가 실행된다.
    pub fn describe(&self) -> String {
        format!("git push {} {}", self.remote, self.branch)
    }
}

/// remote URL에서 `owner/repo`를 뽑는다 — **GitHub일 때만.**
///
/// 다른 호스팅은 compare URL 모양이 다르고, 우리는 그 모양을 모른다. 모르는 것을 추측해
/// 만들면 사용자는 404를 받고 그 원인을 알 방법이 없다. **못 만든다고 말하는 편이 낫다.**
pub fn github_slug(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim().trim_end_matches('/');
    let rest = if let Some(r) = trimmed.strip_prefix("git@github.com:") {
        r
    } else if let Some(r) = trimmed.strip_prefix("https://github.com/") {
        r
    } else if let Some(r) = trimmed.strip_prefix("ssh://git@github.com/") {
        r
    } else {
        return None;
    };
    let slug = rest.strip_suffix(".git").unwrap_or(rest);
    // `owner/repo` 두 조각이어야 한다. 더 깊으면 우리가 아는 모양이 아니다.
    let mut parts = slug.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// PR 생성 폼 URL. 제목과 본문을 미리 채운다.
pub fn compare_url(slug: &str, base: &str, head: &str, title: &str, body: &str) -> String {
    format!(
        "https://github.com/{slug}/compare/{base}...{head}?expand=1&title={}&body={}",
        percent_encode(title),
        percent_encode(body)
    )
}

/// 쿼리 값에 넣을 수 있게 인코딩한다.
///
/// **직접 쓴다.** 의존성을 하나 늘릴 만큼의 일이 아니고, 여기서 필요한 규칙은 하나다:
/// unreserved가 아닌 바이트는 전부 `%XX`. 한글 제목이 그대로 들어오므로 **바이트 단위**로
/// 돌아야 한다 — 문자 단위로 돌면 멀티바이트가 깨진다.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_plain_remote_and_branch_are_accepted() {
        let target = parse_push(&json!({ "remote": "origin", "branch": "feature/x" })).unwrap();
        assert_eq!(target.command().args, vec!["push", "origin", "feature/x"]);
        assert_eq!(target.describe(), "git push origin feature/x");
    }

    /// **옵션과 refspec을 이름 자리에 넣을 수 없다.** 넣을 수 있으면 승인 화면이 보여준 것과
    /// 다른 일이 벌어진다 — 원칙 6이 지키려는 바로 그 보장이다.
    #[test]
    fn options_and_refspecs_are_rejected_in_a_name_slot() {
        for bad in ["--force", "-f", "main:refs/heads/other", "..", "a..b", "origin main"] {
            assert!(
                parse_push(&json!({ "remote": "origin", "branch": bad })).is_err(),
                "이름이 아닌 값이 통과했습니다: {bad}"
            );
        }
    }

    #[test]
    fn a_missing_field_is_an_error_not_a_default() {
        assert_eq!(
            parse_push(&json!({ "remote": "origin" })).unwrap_err(),
            PushArgError::Missing { field: "branch" }
        );
    }

    /// **force는 만들 방법이 없다.** 인자로도 못 들어오고 우리가 붙이지도 않는다.
    #[test]
    fn the_built_command_never_forces() {
        let target = parse_push(&json!({ "remote": "origin", "branch": "main" })).unwrap();
        let args = target.command().args;
        assert!(!args.iter().any(|a| a.starts_with('-')), "{args:?}");
        assert_eq!(args.len(), 3, "{args:?}");
    }

    #[test]
    fn github_remotes_in_every_form_yield_the_same_slug() {
        for url in [
            "git@github.com:mposition/TomverseCode.git",
            "https://github.com/mposition/TomverseCode.git",
            "https://github.com/mposition/TomverseCode",
            "ssh://git@github.com/mposition/TomverseCode.git",
        ] {
            assert_eq!(github_slug(url).as_deref(), Some("mposition/TomverseCode"), "{url}");
        }
    }

    /// **모르는 호스팅에는 URL을 만들지 않는다.** 추측해 만들면 사용자는 404를 받고 원인을
    /// 알 방법이 없다.
    #[test]
    fn a_non_github_remote_yields_no_url() {
        for url in [
            "git@gitlab.com:owner/repo.git",
            "https://bitbucket.org/owner/repo.git",
            "/tmp/local-bare-repo",
            "https://github.com/owner/repo/extra",
        ] {
            assert_eq!(github_slug(url), None, "{url}");
        }
    }

    /// 한글 제목이 깨지지 않는다 — **바이트 단위**로 인코딩해야 한다.
    #[test]
    fn a_korean_title_survives_encoding() {
        let url = compare_url("o/r", "main", "feat", "페이지 계산 수정", "본문");
        assert!(!url.contains(' '), "{url}");
        // 디코딩하면 원문이 돌아온다.
        let title = url.split("title=").nth(1).unwrap().split("&body=").next().unwrap();
        let bytes: Vec<u8> = title
            .split('%')
            .skip(1)
            .map(|h| u8::from_str_radix(&h[..2], 16).unwrap())
            .collect();
        assert_eq!(String::from_utf8(bytes).unwrap(), "페이지 계산 수정");
    }
}
