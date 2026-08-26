//! `run_command` allowlist/denylist 매칭.
//!
//! docs/design/state-machine-and-protocol.md 5절. 전제: args는 셸 문자열이 아니라 argv 배열이다.
//! 그 덕분에 매칭이 결정론적이고, 셸 메타문자 인젝션이라는 문제 범주 자체가 없다.

use crate::types::{CommandPolicy, CommandRule, RuleEffect, RunCommandArgs};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandMatch {
    /// deny 규칙에 매치 — `blocked` 확정, 정책 override로도 풀 수 없다.
    Denied {
        rule: String,
    },
    Allowed {
        rule: String,
        effect: RuleEffect,
    },
    /// 아무 규칙도 매치되지 않음 → 도구 기본값(user_approval)으로 폴백
    NoMatch,
}

/// 실행 파일 이름 비교는 basename + 확장자 무시로 한다.
/// `C:\tools\git.exe`와 `git`, `/usr/bin/git`이 같은 규칙에 걸려야 한다 —
/// 경로를 붙여 규칙을 우회하는 것을 막는 것이 목적이다.
pub fn program_basename(program: &str) -> String {
    let normalized = program.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or(&normalized);
    let stem = match base.rfind('.') {
        // ".exe", ".cmd", ".bat", ".ps1" 등을 벗겨낸다. 확장자 없는 이름은 그대로.
        Some(idx) if idx > 0 => {
            let ext = &base[idx + 1..];
            if matches!(ext.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat" | "com" | "ps1") {
                &base[..idx]
            } else {
                base
            }
        }
        _ => base,
    };
    stem.to_ascii_lowercase()
}

/// 위치 기반 glob 매칭.
/// - `"*"` = 인자 정확히 1개 (임의 값)
/// - `"**"` = 나머지 전부 (마지막 세그먼트에만 허용)
/// - 그 외 = 문자열 완전 일치
fn args_match(pattern: &[String], args: &[String]) -> bool {
    let mut i = 0usize;
    while i < pattern.len() {
        let p = &pattern[i];
        if p == "**" {
            // 마지막 세그먼트에만 허용 — 그 외 위치의 `**`는 규칙 작성 실수이므로
            // 조용히 넓게 매치시키지 않고 매치 실패로 처리한다.
            return i == pattern.len() - 1;
        }
        if i >= args.len() {
            return false;
        }
        if p != "*" && p != &args[i] {
            return false;
        }
        i += 1;
    }
    // `**`가 없었다면 인자 개수가 정확히 같아야 한다.
    i == args.len()
}

fn rule_matches(rule: &CommandRule, cmd: &RunCommandArgs, cwd_is_root: bool) -> bool {
    if program_basename(&rule.program) != program_basename(&cmd.program) {
        return false;
    }
    if let Some(pattern) = &rule.arg_pattern {
        if !args_match(pattern, &cmd.args) {
            return false;
        }
    }
    // 기본값 true — 명시적으로 false를 준 규칙만 서브디렉터리 실행을 허용한다.
    if rule.cwd_must_be_workspace_root.unwrap_or(true) && !cwd_is_root {
        return false;
    }
    true
}

fn describe(rule: &CommandRule) -> String {
    match &rule.arg_pattern {
        Some(p) if !p.is_empty() => format!("{} {}", program_basename(&rule.program), p.join(" ")),
        _ => program_basename(&rule.program),
    }
}

/// deny를 **전체 스캔**한 뒤 allow를 first-match 한다 (문서 5.1절 매칭 순서).
pub fn match_command(policy: &CommandPolicy, cmd: &RunCommandArgs, cwd_is_root: bool) -> CommandMatch {
    for rule in &policy.deny {
        // deny 규칙은 cwd 제약을 무시한다 — "루트가 아니면 금지가 풀린다"는 건 명백한 구멍이다.
        let mut probe = rule.clone();
        probe.cwd_must_be_workspace_root = Some(false);
        if rule_matches(&probe, cmd, cwd_is_root) {
            return CommandMatch::Denied { rule: describe(rule) };
        }
    }
    for rule in &policy.allow {
        if rule_matches(rule, cmd, cwd_is_root) {
            return CommandMatch::Allowed {
                rule: describe(rule),
                effect: rule.effect,
            };
        }
    }
    CommandMatch::NoMatch
}

/// docs/design/state-machine-and-protocol.md 5.2절의 기본 워크스페이스 정책.
pub fn default_command_policy() -> CommandPolicy {
    fn deny(program: &str, pattern: Option<&[&str]>) -> CommandRule {
        CommandRule {
            program: program.to_string(),
            arg_pattern: pattern.map(|p| p.iter().map(|s| s.to_string()).collect()),
            cwd_must_be_workspace_root: Some(false),
            effect: RuleEffect::Conditional, // deny 규칙에서 effect는 쓰이지 않는다
        }
    }
    fn allow(program: &str, pattern: &[&str], effect: RuleEffect) -> CommandRule {
        CommandRule {
            program: program.to_string(),
            arg_pattern: Some(pattern.iter().map(|s| s.to_string()).collect()),
            cwd_must_be_workspace_root: Some(false),
            effect,
        }
    }

    CommandPolicy {
        deny: vec![
            // 권한 상승
            deny("sudo", None),
            deny("runas", None),
            deny("su", None),
            // 시스템 설정 변경
            deny("reg", None),
            deny("netsh", None),
            deny("sc", None),
            deny("bcdedit", None),
            // 셸을 통한 우회 — argv 약속을 무의미하게 만드는 경로이므로 도구 기본값이 아니라 deny다.
            // 작업 지침 3.2절: `cmd /c`, `powershell -Command` 같은 우회는 기본적으로 차단한다.
            deny("cmd", None),
            deny("powershell", None),
            deny("pwsh", None),
            deny("sh", None),
            deny("bash", None),
            deny("zsh", None),
            deny("wscript", None),
            deny("cscript", None),
            // **임의 argv의 push는 여전히 거부다** (state-machine 28.2절).
            //
            // 종전 사유는 "M0 범위 밖"이었고 그건 범위 표시였지 판단이 아니었다. M3에서
            // PR 연동을 하면서 그 자리를 다시 봤고, 결론은 **여는 것이 아니라 좁히는 것**이다:
            // `--force`와 refspec을 우리가 통제할 수 없는 문을 여는 대신, 아는 모양만 내는
            // `git_push` 도구를 따로 두었다. 그쪽은 언제나 승인이고 정책으로 낮출 수 없다.
            deny("git", Some(&["push", "**"])),
            // 원격 코드 실행 유틸리티
            deny("curl", None),
            deny("wget", None),
            deny("iwr", None),
            deny("Invoke-WebRequest", None),
        ],
        allow: vec![
            allow("git", &["status", "**"], RuleEffect::Auto),
            allow("git", &["diff", "**"], RuleEffect::Auto),
            allow("git", &["log", "**"], RuleEffect::Auto),
            allow("git", &["show", "**"], RuleEffect::Auto),
            allow("git", &["rev-parse", "**"], RuleEffect::Auto),
            // `remote get-url`은 `.git/config`를 읽을 뿐이다 — 네트워크를 타지 않는다.
            // **`remote` 전체를 열지 않는다**: `add`/`set-url`은 설정을 바꾸고 `update`는
            // 네트워크를 탄다. 여기서 여는 것은 읽기 하나뿐이다(28.3절).
            allow("git", &["remote", "get-url", "**"], RuleEffect::Auto),
            allow("git", &["branch", "--list"], RuleEffect::Auto),
            allow("git", &["add", "**"], RuleEffect::Conditional),
            allow("git", &["commit", "**"], RuleEffect::Conditional),
            // `git revert`는 되돌리기 화면이 쓴다(state-machine-and-protocol.md 19절).
            // Conditional인 이유: 이력을 바꾸는 쓰기 동작이므로 승인을 거쳐야 하고,
            // 되돌리기 화면에서 사용자가 이미 고른 것이라 1클릭이면 충분하다.
            //
            // **`reset`은 넣지 않는다.** `reset --hard`는 커밋되지 않은 작업을 복구 불가능하게
            // 지우고 이력을 다시 쓴다 — 그 커밋이 이미 공유됐는지 우리는 알 수 없으므로,
            // 되돌릴 수 없는 동작을 우리가 대신 실행하지 않는다(19.2절).
            allow("git", &["revert", "**"], RuleEffect::Conditional),
            allow("git", &["checkout", "**"], RuleEffect::Conditional),
            // 테스트/빌드 러너. auto가 아니라 conditional인 이유: npm 스크립트는 임의 코드를
            // 실행할 수 있으므로 "무음 허용"은 과하다. 승인 1클릭으로 노출한다.
            allow("npm", &["test", "**"], RuleEffect::Conditional),
            allow("npm", &["run", "*"], RuleEffect::Conditional),
            allow("npm", &["run", "*", "**"], RuleEffect::Conditional),
            allow("npm", &["ci"], RuleEffect::Conditional),
            allow("pnpm", &["test", "**"], RuleEffect::Conditional),
            allow("yarn", &["test", "**"], RuleEffect::Conditional),
            allow("node", &["--test", "**"], RuleEffect::Conditional),
            // **`pytest`를 그대로 부르는 길은 남겨 두되, 우리가 만드는 명령은 이쪽이 아니다**
            // (49절). 가상환경을 활성화하지 않으면 `pytest`는 PATH에 없고, 활성화를 흉내 내려면
            // 셸을 거쳐야 해서 argv 계약이 깨진다. 그래서 `verify.rs`는 인터프리터를 직접 부른다.
            allow("pytest", &["**"], RuleEffect::Conditional),
            // `<python> -m <도구>` — 활성화가 하는 일을 구조적으로 재현한 모양(49.2절).
            //
            // **`-m` 뒤를 열어 두지 않는다.** `python -m **`을 허용하면 `-m http.server`도
            // `-m pip`도 지나가고, 그건 "테스트 러너 허용"이 아니라 "임의 파이썬 실행 허용"이다.
            // 세 도구만 적는다 — 새 도구는 `verify.rs`가 만들 때 여기도 함께 는다.
            //
            // `python`과 `python3`를 둘 다 적는 이유: `program_basename`은 확장자만 벗기므로
            // 두 이름이 다른 프로그램으로 매치된다. Unix PATH 폴백이 `python3`를 고를 수 있다.
            allow("python", &["-m", "pytest", "**"], RuleEffect::Conditional),
            allow("python", &["-m", "ruff", "**"], RuleEffect::Conditional),
            allow("python", &["-m", "mypy", "**"], RuleEffect::Conditional),
            allow("python3", &["-m", "pytest", "**"], RuleEffect::Conditional),
            allow("python3", &["-m", "ruff", "**"], RuleEffect::Conditional),
            allow("python3", &["-m", "mypy", "**"], RuleEffect::Conditional),
            allow("cargo", &["build", "**"], RuleEffect::Conditional),
            allow("cargo", &["test", "**"], RuleEffect::Conditional),
            allow("cargo", &["check", "**"], RuleEffect::Conditional),
            allow("cargo", &["clippy", "**"], RuleEffect::Conditional),
            allow("cargo", &["fmt", "**"], RuleEffect::Conditional),
            allow("dotnet", &["build", "**"], RuleEffect::Conditional),
            allow("dotnet", &["test", "**"], RuleEffect::Conditional),
            allow("tsc", &["**"], RuleEffect::Conditional),
        ],
    }
}

/// 네트워크를 발생시킬 가능성이 높은 명령 (작업 지침 4.2절 — 사용자 승인 필요).
/// deny 목록의 curl/wget과 달리 이건 "정상 개발 흐름에서 필요하지만 조용히 돌면 안 되는" 것들이다.
pub fn is_network_capable(cmd: &RunCommandArgs) -> bool {
    let program = program_basename(&cmd.program);
    let first = cmd.args.first().map(|s| s.as_str()).unwrap_or("");
    match program.as_str() {
        "npm" | "pnpm" | "yarn" => matches!(first, "install" | "i" | "ci" | "add" | "update" | "publish" | "audit"),
        "cargo" => matches!(first, "publish" | "install" | "update" | "fetch" | "add"),
        "pip" | "pip3" => matches!(first, "install" | "download" | "uninstall"),
        // **`python -m pip install`도 네트워크를 탄다**(49절). allowlist가 `-m pip`를 열어 두지
        // 않으므로 지금은 여기 닿지 않지만, 위 `git push` 주석과 같은 이유로 적어 둔다 —
        // 나중에 그 규칙을 넓히는 사람이 있으면 네트워크 분류가 함께 따라와야 한다.
        "python" | "python3" | "py" => {
            cmd.args.first().map(String::as_str) == Some("-m")
                && matches!(cmd.args.get(1).map(String::as_str), Some("pip") | Some("ensurepip") | Some("venv"))
        }
        "dotnet" => matches!(first, "restore" | "nuget"),
        // `push`는 `run_command`에서 deny라 이 분류에 닿지 않는다. **그래도 적어 둔다** —
        // 나중에 그 deny를 푸는 사람이 있으면 네트워크 분류가 함께 따라와야 하고, 여기 없으면
        // 조용히 "네트워크를 타지 않는 명령"으로 분류된다.
        //
        // **`remote`는 하위 명령을 봐야 한다.** 종전에는 `remote` 전체를 네트워크로 봤는데,
        // `get-url`은 `.git/config`를 읽을 뿐이다. 로컬 조회에 승인을 요구하면 사용자는
        // 승인을 습관으로 누르게 되고, 그러면 정작 네트워크를 타는 요청도 같이 지나간다.
        // 넓히는 방향이지만 **allowlist가 먼저 막는다** — 여기 닿는 것은 이미 허용된 명령뿐이다.
        "git" => match first {
            "remote" => matches!(cmd.args.get(1).map(String::as_str), Some("update") | Some("prune")),
            other => matches!(other, "fetch" | "pull" | "clone" | "submodule" | "push"),
        },
        "ssh" | "scp" | "rsync" | "nc" | "ftp" | "telnet" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(program: &str, args: &[&str]) -> RunCommandArgs {
        RunCommandArgs {
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: ".".to_string(),
            timeout_ms: None,
        }
    }

    #[test]
    fn basename_ignores_path_and_windows_extension() {
        assert_eq!(program_basename("git"), "git");
        assert_eq!(program_basename("/usr/bin/git"), "git");
        assert_eq!(program_basename(r"C:\Program Files\Git\bin\git.exe"), "git");
        assert_eq!(program_basename("PowerShell.EXE"), "powershell");
        // 확장자처럼 보이지만 실행 파일 확장자가 아니면 보존한다.
        assert_eq!(program_basename("my.tool"), "my.tool");
    }

    #[test]
    fn double_star_matches_rest() {
        let p = vec!["status".to_string(), "**".to_string()];
        assert!(args_match(&p, &["status".to_string()]));
        assert!(args_match(&p, &["status".to_string(), "--short".to_string()]));
        assert!(!args_match(&p, &["diff".to_string()]));
    }

    #[test]
    fn single_star_matches_exactly_one() {
        let p = vec!["run".to_string(), "*".to_string()];
        assert!(args_match(&p, &["run".to_string(), "build".to_string()]));
        assert!(!args_match(&p, &["run".to_string()]));
        assert!(!args_match(
            &p,
            &["run".to_string(), "build".to_string(), "--watch".to_string()]
        ));
    }

    #[test]
    fn exact_pattern_requires_same_arity() {
        let p = vec!["branch".to_string(), "--list".to_string()];
        assert!(args_match(&p, &["branch".to_string(), "--list".to_string()]));
        assert!(!args_match(
            &p,
            &["branch".to_string(), "--list".to_string(), "-r".to_string()]
        ));
    }

    #[test]
    fn double_star_in_non_final_position_does_not_match() {
        // 규칙 작성 실수를 조용히 넓게 해석하지 않는다.
        let p = vec!["**".to_string(), "safe".to_string()];
        assert!(!args_match(&p, &["anything".to_string(), "safe".to_string()]));
    }

    #[test]
    fn deny_wins_over_allow_regardless_of_order() {
        let policy = default_command_policy();
        // git push는 allow에 git status/diff 등이 먼저 있어도 deny로 확정된다.
        assert_eq!(
            match_command(&policy, &cmd("git", &["push", "origin", "main"]), true),
            CommandMatch::Denied {
                rule: "git push **".to_string()
            }
        );
    }

    #[test]
    fn shell_launchers_are_denied() {
        let policy = default_command_policy();
        for program in ["cmd", "powershell", "pwsh", "bash", "sh"] {
            let m = match_command(&policy, &cmd(program, &["-c", "echo hi"]), true);
            assert!(
                matches!(m, CommandMatch::Denied { .. }),
                "{program} should be denied, got {m:?}"
            );
        }
    }

    #[test]
    fn read_only_git_is_auto() {
        let policy = default_command_policy();
        assert_eq!(
            match_command(&policy, &cmd("git", &["status", "--short"]), true),
            CommandMatch::Allowed {
                rule: "git status **".to_string(),
                effect: RuleEffect::Auto
            }
        );
    }

    #[test]
    fn unknown_command_falls_through_to_no_match() {
        let policy = default_command_policy();
        assert_eq!(
            match_command(&policy, &cmd("rm", &["-rf", "src"]), true),
            CommandMatch::NoMatch
        );
    }

    #[test]
    fn network_capable_detection() {
        assert!(is_network_capable(&cmd("npm", &["install"])));
        assert!(is_network_capable(&cmd("git", &["fetch"])));
        assert!(!is_network_capable(&cmd("npm", &["test"])));
        assert!(!is_network_capable(&cmd("cargo", &["test"])));
    }
}
