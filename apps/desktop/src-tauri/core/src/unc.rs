//! UNC 작업 디렉터리 장벽 — **없는 실패를 지어내지 않는다** (state-machine 71절).
//!
//! # 무엇이 거짓말이었나
//!
//! `\\localhost\Users\...` 같은 UNC 경로 워크스페이스에서 **우리 쪽은 전부 옳다**:
//! 워크스페이스가 열리고, 게이트가 정상 경로를 통과시키고, `apply_patch`가 파일을 실제로
//! 바꾼다(windows-landing-record 11절 실측). Win32 `CreateProcess`는 UNC 작업 디렉터리를
//! 받아들이므로 우리가 직접 띄우는 프로세스에는 문제가 없다.
//!
//! **거부하는 것은 `cmd.exe` 하나다.** 그리고 npm은 자기 lifecycle 스크립트를 `cmd.exe`로
//! 실행한다. 그래서 `npm test`는 이렇게 끝난다:
//!
//! ```text
//! CMD.EXE was started with the above path as the current directory.
//! UNC paths are not supported.  Defaulting to Windows directory.
//! Could not find 'paginate.test.js'
//! ```
//!
//! 러너는 `C:\Windows`에서 돌았고 테스트 파일을 **찾지도 못했다.** 그런데 종전 판정은
//! `exit != 0 ⇒ FAILED` 한 줄이었으므로(`verify.rs`), 화면이 사용자에게 **"당신의 테스트가
//! 실패했다"**고 말했다. CLAUDE.md가 npm shim에서 경계한 실패 모드("검증 없이 완료로 보고")의
//! 사촌이며, 이쪽은 **없는 실패를 지어내는** 방향이다.
//!
//! # 출력 문자열로 잡지 않는다
//!
//! `UNC paths are not supported`는 cmd.exe의 메시지 테이블에서 **로캘로 번역된다.** 한국어
//! Windows에서는 다른 문장이 나오고, 그건 우리 주 사용자 환경이다. 출력 매칭을 판정 근거로
//! 삼으면 하필 거기서 조용히 도로 거짓말이 된다. 판정은 **구조적 사실**로만 한다:
//! 플랫폼이 Windows인가 · 작업 디렉터리가 UNC인가 · 이 명령이 cmd.exe를 지나는가.
//!
//! # 돌려 보고 판정하지 않는다 — exit 0도 근거가 아니다
//!
//! "일단 실행하고 실패하면 해석 불가로 처리한다"는 안이 있었다. 그 안은 **가짜 통과**를
//! 남긴다: cmd.exe가 `C:\Windows`로 떨어진 뒤 스크립트가 우연히 0을 내면
//! (`"test": "echo ok"`, 파일을 못 찾고도 0을 내는 러너) 통과로 읽힌다. 잘못된 디렉터리에서
//! 얻은 통과는 증거가 아니다. **결과 자체가 해석 불가능하므로 실행에 값어치가 없다** —
//! 그래서 spawn 전에 멈추고, `spawned: false`를 기록에 남긴다.
//!
//! # 판정 로직만 여기 있다
//!
//! `msvc.rs`·`tools/program.rs`와 같은 규율이다. **플랫폼·경로·환경·파일 내용을 전부 인자로
//! 받는다** — 그래야 Windows 분기를 Linux에서 검증할 수 있다. `std::path`는 실행 중인 OS의
//! 구분자만 알므로(CLAUDE.md 함정 기록) 경로도 `Path`가 아니라 **문자열**로 다룬다.

use serde::Serialize;

use crate::tools::program::Platform;

/// 구조화된 사유. 문자열 메시지와 달리 기계가 읽고 셀 수 있는 값이다.
pub const REASON: &str = "unsupported_unc_working_directory";

/// 판정 과정에서 **확인한 것 하나**. `msvc::Checked`와 같은 모양이다.
///
/// 거부만 하고 무엇을 봤는지 말하지 않으면, 거부가 틀렸을 때 사용자가 할 수 있는 일이 없다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub what: &'static str,
    pub value: String,
    pub result: String,
}

/// 이 명령은 **시작하지 않는다**는 판정과 그 근거.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Barrier {
    /// 언제나 [`REASON`]. 필드로 두는 이유는 기록을 읽는 쪽이 문장에서 사유를 되뽑지 않게
    /// 하기 위함이다 — 문장은 번역되고 다듬어지지만 이 값은 고정이다.
    pub reason: &'static str,
    /// 요청된 프로그램 (해석 전 — 사용자가 승인 화면에서 본 것).
    pub program: String,
    /// 이 명령이 돌았어야 할 작업 디렉터리.
    pub cwd: String,
    pub checked: Vec<Checked>,
    /// 사용자가 **실제로 할 수 있는 일**. 순서가 곧 권장 순서다.
    pub remediation: Vec<String>,
}

impl Barrier {
    /// 사람이 읽는 한 문단. `ToolResult.error`에 실리고, 거기서 검증 체크의 `summary`로
    /// 흘러 화면에 그대로 뜬다 — **문장을 한 곳에만 둔다.**
    pub fn message(&self) -> String {
        format!(
            "`{}`을(를) 시작하지 않았습니다 — 작업 디렉터리가 UNC 경로입니다({}). \
             이 러너는 자기 스크립트를 cmd.exe로 실행하는데 cmd.exe는 UNC 작업 디렉터리를 \
             지원하지 않아, 러너가 엉뚱한 디렉터리에서 돌게 됩니다. 그 결과는 통과든 실패든 \
             이 저장소에 대해 아무것도 말해주지 않으므로 실행하지 않았습니다 — \
             검증 실패가 아니라 검증 안 됨입니다. 해결: {}",
            self.program,
            self.cwd,
            self.remediation.join(" / ")
        )
    }
}

/// 판정에 필요한 바깥 세계. **전부 주입한다.**
pub struct Probe<'a> {
    pub platform: Platform,
    /// 작업 디렉터리. **문자열이다** — `Path`로 받으면 Linux에서 Windows 경로를 다룰 수 없다.
    pub cwd: &'a str,
    /// 환경변수 조회. npm은 `npm_config_script_shell`을 설정으로 읽는다.
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// `.npmrc` 후보들: `(출처 라벨, 내용)`. 없는 파일은 애초에 목록에 넣지 않는다 —
    /// "없다"와 "빈 파일"을 여기서 뭉갤 이유가 없다.
    pub npmrc: &'a dyn Fn() -> Vec<(String, String)>,
}

/// 이 경로가 UNC인가.
///
/// **Windows 경로 문자열로만 판정한다.** POSIX에서 `//foo/bar`는 평범한 경로이므로
/// 이 함수를 플랫폼 검사 없이 부르면 안 된다 — [`check`]가 그 순서를 지킨다.
///
/// 다루는 형태:
///  - `\\server\share\...` — 일반 UNC
///  - `\\?\UNC\server\share\...` — verbatim UNC (`paths.rs`가 일부러 벗기지 않는 형태)
///  - `//server/share/...` — 슬래시 형태. Windows API가 받아들이므로 우리도 UNC로 본다
///
/// UNC가 **아닌** 것:
///  - `\\?\C:\...` — verbatim 드라이브. 로컬이다
///  - `\\.\PhysicalDrive0` — 장치 이름공간. 워크스페이스가 될 수 없다
pub fn is_unc(path: &str) -> bool {
    let p = path.replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        // `UNC\`는 대소문자를 가리지 않는다.
        return rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("UNC\\");
    }
    if p.starts_with(r"\\.\") {
        return false;
    }
    p.starts_with(r"\\")
}

/// 이 프로그램이 자기 스크립트를 셸(`cmd.exe`)에 넘기는가.
///
/// # 하위 명령으로 가리지 않는다
///
/// `msvc::needs_msvc`와 같은 판단이다: 가리려면 "어느 하위 명령이 lifecycle 스크립트를
/// 도는가"를 우리가 들고 있어야 하는데, **그 목록이 틀리는 쪽이 더 나쁘다.** `npm ci`도
/// 의존성의 `preinstall`/`postinstall`을 cmd.exe로 돈다. 게이트 allowlist가 npm에 대해
/// 허용하는 것은 어차피 `test`/`run`/`ci`뿐이므로(`policy/command.rs`), 실질 범위는 정확히
/// lifecycle 명령들이다.
///
/// # 목록에 없는 것은 넣지 않는다
///
/// `cargo`·`dotnet`·`python`은 cmd.exe를 지나지 않는다. "혹시 모르니 넓게"는 **동작하는
/// 명령을 막는** 반대 방향의 거짓말이다 — 확인한 것만 넣는다.
pub fn delegates_to_cmd(program: &str) -> bool {
    let base = crate::policy::command::program_basename(program).to_ascii_lowercase();
    let base = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(&base);
    matches!(base, "npm" | "npx" | "pnpm" | "pnpx" | "yarn")
}

/// npm의 `script-shell` 설정값. cmd.exe가 아니면 이 장벽은 성립하지 않는다.
///
/// 우선순위는 npm의 것을 따른다: 환경변수 → `.npmrc`(프로젝트가 먼저, 그다음 사용자).
fn script_shell(probe: &Probe<'_>, checked: &mut Vec<Checked>) -> Option<String> {
    if let Some(v) = (probe.env)("npm_config_script_shell").filter(|v| !v.trim().is_empty()) {
        checked.push(Checked {
            what: "npm_config_script_shell",
            value: v.trim().to_string(),
            result: "환경변수로 설정됨".to_string(),
        });
        return Some(v.trim().to_string());
    }
    for (label, body) in (probe.npmrc)() {
        match npmrc_script_shell(&body) {
            Some(v) => {
                checked.push(Checked {
                    what: "script-shell (.npmrc)",
                    value: format!("{label}: {v}"),
                    result: "설정 파일로 설정됨".to_string(),
                });
                return Some(v);
            }
            None => checked.push(Checked {
                what: "script-shell (.npmrc)",
                value: label,
                result: "이 파일에는 script-shell이 없음".to_string(),
            }),
        }
    }
    None
}

/// `.npmrc`에서 `script-shell` 값을 뽑는다. ini 형태이고 `#`/`;`가 주석이다.
fn npmrc_script_shell(body: &str) -> Option<String> {
    for line in body.lines() {
        let line = line.split(['#', ';']).next().unwrap_or("").trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("script-shell") {
            let value = value.trim().trim_matches('"').trim_matches('\'').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 이 값이 cmd.exe를 가리키는가. `%COMSPEC%`도 cmd.exe다.
fn is_cmd_exe(shell: &str) -> bool {
    if shell.eq_ignore_ascii_case("%COMSPEC%") {
        return true;
    }
    let base = crate::policy::command::program_basename(shell).to_ascii_lowercase();
    base.strip_suffix(".exe").unwrap_or(&base) == "cmd"
}

/// **이 명령을 시작해도 되는가.** `Some(Barrier)`면 시작하지 않는다.
///
/// 세 조건이 모두 참일 때만 막는다 — 하나라도 거짓이면 종전과 한 글자도 다르지 않게 실행된다.
pub fn check(probe: &Probe<'_>, program: &str) -> Option<Barrier> {
    if probe.platform != Platform::Windows {
        return None;
    }
    if !delegates_to_cmd(program) {
        return None;
    }
    if !is_unc(probe.cwd) {
        return None;
    }

    let mut checked = vec![
        Checked {
            what: "작업 디렉터리",
            value: probe.cwd.to_string(),
            result: "UNC 경로 — cmd.exe가 작업 디렉터리로 받아들이지 않는다".to_string(),
        },
        Checked {
            what: "러너",
            value: program.to_string(),
            result: "자기 스크립트를 cmd.exe로 실행한다".to_string(),
        },
    ];

    // **거부하기 전에 빠져나갈 문이 있는지 본다.** script-shell을 바꾼 사용자에게는 이
    // 장벽이 없고, 그 사람의 정상 실행을 막으면 우리가 **반대 방향으로** 거짓말하는 것이다.
    match script_shell(probe, &mut checked) {
        Some(shell) if !is_cmd_exe(&shell) => return None,
        Some(shell) => checked.push(Checked {
            what: "script-shell 값",
            value: shell,
            result: "cmd.exe를 가리킨다 — 장벽이 그대로다".to_string(),
        }),
        None => checked.push(Checked {
            what: "script-shell",
            value: "(설정 없음)".to_string(),
            result: "Windows 기본값 %COMSPEC%(cmd.exe)이 쓰인다".to_string(),
        }),
    }

    Some(Barrier {
        reason: REASON,
        program: program.to_string(),
        cwd: probe.cwd.to_string(),
        checked,
        remediation: remediation(probe.cwd),
    })
}

/// 사용자가 실제로 할 수 있는 일.
///
/// **우리가 드라이브 문자를 만들지 않는다.** 드라이브 매핑은 로그온 세션 전역 상태이고,
/// 우리가 만들면 태스크가 죽었을 때 사용자 탐색기에 우리 흔적이 남는다(71.3절).
/// 명령은 알려주고, 만드는 것은 사용자다 — 전역 상태의 소유자와 만든 사람이 같아야 한다.
pub fn remediation(cwd: &str) -> Vec<String> {
    vec![
        format!(
            "이 공유를 드라이브 문자로 직접 매핑한 뒤 그 경로로 다시 여십시오 \
             (예: `net use X: {} /persistent:no` 후 `X:\\...`를 엽니다)",
            share_of(cwd)
        ),
        "또는 저장소를 로컬 경로(`C:\\...`)로 clone/복사한 뒤 여십시오".to_string(),
        "또는 npm `script-shell`을 cmd.exe가 아닌 셸로 설정하십시오 \
         (예: `.npmrc`에 `script-shell=powershell.exe`)"
            .to_string(),
    ]
}

/// `\\server\share\a\b` → `\\server\share`. 매핑 안내에 쓸 최소 단위다 —
/// `net use X: \\host\share\a\b`는 동작하지 않으므로 폴더까지 붙여 주면 안내가 틀린다.
///
/// 형태를 알아보지 못하면 **원본을 그대로 돌려준다**: 잘라내다 틀린 경로를 안내하는 것보다
/// 길더라도 맞는 것이 낫다.
fn share_of(cwd: &str) -> String {
    let p = cwd.replace('/', "\\");
    let body = match p.strip_prefix(r"\\?\") {
        Some(rest) if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("UNC\\") => {
            format!(r"\\{}", &rest[4..])
        }
        _ => p.clone(),
    };
    let Some(rest) = body.strip_prefix(r"\\") else {
        return cwd.to_string();
    };
    let parts: Vec<&str> = rest.split('\\').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return cwd.to_string();
    }
    format!(r"\\{}\{}", parts[0], parts[1])
}

/// 워크스페이스를 **열 때** 띄우는 경고 (71.4절).
///
/// # 왜 결과가 아니라 시작 지점인가
///
/// 격리 실행 공지(22.5절)가 배너 자리에 있는 이유와 같다: "이 워크스페이스에서는 검증이
/// 돌지 않는다"는 **작업을 시작하기 전에** 알아야 하는 사실이다. 결과에서 처음 알면 이미
/// 모델 호출 비용을 쓴 뒤다.
///
/// `None`이면 할 말이 없다 — 빈 문자열을 돌려주지 않는다.
pub fn workspace_notice(platform: Platform, root: &str) -> Option<String> {
    if platform != Platform::Windows || !is_unc(root) {
        return None;
    }
    Some(format!(
        "이 워크스페이스는 UNC 경로입니다({root}). 파일 읽기·쓰기·patch·git은 정상 동작하지만 \
         npm/pnpm/yarn 계열 검증 명령은 실행되지 않습니다 — cmd.exe가 UNC 작업 디렉터리를 \
         지원하지 않아 러너가 엉뚱한 디렉터리에서 돌기 때문입니다. 해당 명령은 시작조차 하지 \
         않고 검증 안 됨(could_not_run)으로 기록되며, 검증 실패가 아닙니다. \
         검증되지 않은 변경을 merge·commit·PR 자동화로 넘기지 마십시오. 해결: {}",
        remediation(root).join(" / ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none_env(_: &str) -> Option<String> {
        None
    }
    fn no_npmrc() -> Vec<(String, String)> {
        Vec::new()
    }

    fn probe<'a>(
        cwd: &'a str,
        env: &'a dyn Fn(&str) -> Option<String>,
        npmrc: &'a dyn Fn() -> Vec<(String, String)>,
    ) -> Probe<'a> {
        Probe {
            platform: Platform::Windows,
            cwd,
            env,
            npmrc,
        }
    }

    /// **UNC의 여러 형태를 전부 알아본다.** 하나라도 놓치면 그 형태에서 거짓말이 살아남는다.
    #[test]
    fn every_unc_shape_is_recognised() {
        assert!(is_unc(r"\\localhost\Users\me\repo"));
        assert!(is_unc(r"\\?\UNC\localhost\Users\me\repo"));
        // verbatim UNC의 대소문자는 고정되어 있지 않다.
        assert!(is_unc(r"\\?\unc\localhost\Users\me"));
        // 슬래시 형태도 Windows API가 받아들인다.
        assert!(is_unc("//localhost/Users/me/repo"));
    }

    /// **로컬 경로를 UNC로 잘못 읽으면 정상 워크스페이스에서 npm이 통째로 막힌다.**
    /// verbatim 드라이브(`\\?\C:`)가 `\\`로 시작한다는 사실이 정확히 그 함정이다.
    #[test]
    fn local_paths_are_not_unc() {
        assert!(!is_unc(r"C:\Users\me\repo"));
        assert!(!is_unc(r"\\?\C:\Users\me\repo"));
        assert!(!is_unc(r"\\.\PhysicalDrive0"));
        assert!(!is_unc("/home/me/repo"));
        assert!(!is_unc("relative\\path"));
    }

    #[test]
    fn only_runners_that_go_through_cmd_are_blocked() {
        for p in ["npm", "npm.cmd", "NPM.CMD", "npx", "pnpm", "yarn", r"C:\nvm4w\nodejs\npm.cmd"] {
            assert!(delegates_to_cmd(p), "{p}");
        }
        // cmd.exe를 지나지 않는 것은 막지 않는다 — 넓히면 동작하는 명령을 막는다.
        for p in ["cargo", "dotnet", "python", "python.exe", "git", "node", "node.exe"] {
            assert!(!delegates_to_cmd(p), "{p}");
        }
    }

    /// **Linux에서는 아무것도 막지 않는다.** `cfg!(windows)`를 읽지 않고 플랫폼을 인자로
    /// 받는 이유가 이 검사를 이 환경에서 돌리기 위해서다.
    #[test]
    fn nothing_is_blocked_off_windows() {
        let p = Probe {
            platform: Platform::Unix,
            cwd: r"\\localhost\Users\me\repo",
            env: &none_env,
            npmrc: &no_npmrc,
        };
        assert!(check(&p, "npm").is_none());
    }

    #[test]
    fn npm_in_a_unc_workspace_is_refused_with_its_grounds() {
        let p = probe(r"\\localhost\Users\me\repo", &none_env, &no_npmrc);
        let barrier = check(&p, "npm").expect("막았어야 합니다");
        assert_eq!(barrier.reason, REASON);
        assert_eq!(barrier.cwd, r"\\localhost\Users\me\repo");
        // 무엇을 봤는지 전부 남는다 — 거부만 하고 침묵하면 사용자가 할 수 있는 일이 없다.
        assert!(barrier.checked.len() >= 3, "{:?}", barrier.checked);
        assert!(!barrier.remediation.is_empty());
        // 메시지가 **검증 실패가 아니라는 것**을 말한다. 이게 이 결함의 전부다.
        assert!(barrier.message().contains("검증 실패가 아니라"), "{}", barrier.message());
    }

    /// 로컬 워크스페이스의 npm은 종전과 한 글자도 다르지 않게 실행된다.
    #[test]
    fn npm_in_a_local_workspace_is_untouched() {
        let p = probe(r"C:\Users\me\repo", &none_env, &no_npmrc);
        assert!(check(&p, "npm").is_none());
    }

    /// UNC라도 cargo/pytest는 막지 않는다 — cmd.exe를 지나지 않으므로 결과가 해석 가능하다.
    #[test]
    fn a_runner_that_does_not_use_cmd_still_runs_on_unc() {
        let p = probe(r"\\localhost\Users\me\repo", &none_env, &no_npmrc);
        assert!(check(&p, "cargo").is_none());
        assert!(check(&p, r"\\localhost\Users\me\repo\.venv\Scripts\python.exe").is_none());
    }

    /// **script-shell을 바꾼 사용자를 막지 않는다.** 여기서 틀리면 우리가 반대 방향으로
    /// 거짓말한다 — 돌아갈 수 있는 명령을 "환경 때문에 못 돈다"고 말하는 것이다.
    #[test]
    fn an_overridden_script_shell_lifts_the_barrier() {
        let env = |k: &str| (k == "npm_config_script_shell").then(|| "powershell.exe".to_string());
        let p = probe(r"\\localhost\Users\me\repo", &env, &no_npmrc);
        assert!(check(&p, "npm").is_none());

        let npmrc = || vec![("프로젝트 .npmrc".to_string(), "script-shell=bash\n".to_string())];
        let p = probe(r"\\localhost\Users\me\repo", &none_env, &npmrc);
        assert!(check(&p, "npm").is_none());
    }

    /// script-shell이 **cmd.exe를 가리키면** 장벽은 그대로다. 설정이 있다는 사실만으로
    /// 빠져나가게 두면 `script-shell=cmd.exe`라고 적은 사용자가 거짓말을 되돌려받는다.
    #[test]
    fn a_script_shell_that_points_at_cmd_keeps_the_barrier() {
        let npmrc = || {
            vec![(
                "프로젝트 .npmrc".to_string(),
                "; 주석\nscript-shell = \"cmd.exe\"\n".to_string(),
            )]
        };
        let p = probe(r"\\localhost\Users\me\repo", &none_env, &npmrc);
        assert!(check(&p, "npm").is_some());
    }

    #[test]
    fn npmrc_comments_are_not_values() {
        assert_eq!(npmrc_script_shell("# script-shell=bash\n"), None);
        assert_eq!(npmrc_script_shell("script-shell=bash # 주석\n").as_deref(), Some("bash"));
        assert_eq!(npmrc_script_shell("other=1\n"), None);
    }

    /// 매핑 안내가 **공유 단위**를 가리켜야 사용자가 그대로 쓸 수 있다.
    #[test]
    fn the_remediation_points_at_the_share_not_the_folder() {
        assert_eq!(share_of(r"\\localhost\Users\me\repo"), r"\\localhost\Users");
        assert_eq!(share_of(r"\\?\UNC\localhost\Users\me\repo"), r"\\localhost\Users");
        assert_eq!(share_of("//localhost/Users/me"), r"\\localhost\Users");
        // 알아보지 못하면 원본을 그대로 — 틀린 경로를 안내하지 않는다.
        assert_eq!(share_of(r"\\localhost"), r"\\localhost");
    }

    /// 배너가 말해야 하는 네 가지(71.4절): 무엇이 안 도는가 · 무엇은 되는가 ·
    /// 실패가 아니라는 것 · 무엇을 하면 되는가. 그리고 검증 전 자동화 경고.
    #[test]
    fn the_workspace_notice_only_speaks_when_it_has_something_to_say() {
        assert!(workspace_notice(Platform::Windows, r"C:\repo").is_none());
        assert!(workspace_notice(Platform::Unix, r"\\localhost\Users\me").is_none());
        let notice = workspace_notice(Platform::Windows, r"\\localhost\Users\me").unwrap();
        assert!(notice.contains("npm"), "{notice}");
        assert!(notice.contains("patch"), "{notice}");
        assert!(notice.contains("검증 실패가 아닙니다"), "{notice}");
        assert!(notice.contains("net use"), "{notice}");
        assert!(notice.contains("PR"), "{notice}");
    }
}
