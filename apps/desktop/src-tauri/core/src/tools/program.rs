//! Windows 프로그램 해석 계층 — **정책 판정 이후, 프로세스 spawn 직전.**
//!
//! # 왜 필요한가
//!
//! Tool Runtime은 `Command::new(&cmd.program).args(&cmd.args)`로 실행한다. Windows에서
//! `{"program": "npm", "args": ["test"]}`를 그렇게 실행하면 이렇게 끝난다:
//!
//! ```text
//! npm를 실행할 수 없음: program not found
//! ```
//!
//! Windows의 npm은 `npm.exe`가 아니라 **`npm.cmd`(배치 shim)**이고, 배치 파일은 셸 없이는
//! 실행되지 않기 때문이다.
//!
//! 그 결과는 단순한 "명령 실패"가 아니었다. Verification Runner가 테스트를 돌리지 못하고
//! `SKIPPED_WITH_REASON` → `not_verified`가 되면서, **정상 수정 작업이 검증 없이 완료로
//! 보고**되고 fix loop가 아예 돌지 않았다. 즉 이건 e2e 문제가 아니라 **Windows 제품 런타임
//! 결함**이며, 결정론적 검증을 제품 명제로 내건 이상 가장 나쁜 종류의 결함이다.
//!
//! # 왜 `cmd.exe /c`로 감싸지 않는가
//!
//! `cmd.exe /c npm test`로 감싸면 실행은 된다. 그러나 그 순간
//! CLAUDE.md 원칙 6("`run_command`는 셸 문자열이 아니라 argv 배열만 받는다")이 무너진다 —
//! 인자 안의 `&`, `|`, `>`, `%`, `^`가 셸에 재해석되므로 **승인 모달에 보인 명령과 실제로
//! 실행되는 것이 같다는 보장**이 사라진다. 보안 모델과 UI 약속이 동시에 깨진다.
//!
//! 대신 shim이 실제로 하는 일을 우리가 구조적으로 재현한다:
//!
//! ```text
//! 요청:  npm test --silent
//! 실행:  <node.exe> <...\node_modules\npm\bin\npm-cli.js> test --silent
//! ```
//!
//! 인자는 **하나도 건드리지 않고** 그대로 뒤에 붙는다. 셸이 개입하지 않으므로 메타문자는
//! 언제나 리터럴이다.
//!
//! # 확인할 수 없으면 실패한다
//!
//! Node 설치 구조를 확인하지 못하면 추측해서 실행하지 않는다. 알려지지 않은 `.cmd`/`.bat`도
//! 조용히 셸로 돌리지 않는다. "무엇을 못 찾았는지" 말하고 멈추는 편이, 사용자가 승인한 것과
//! 다른 것을 실행하는 것보다 낫다.
//!
//! # 테스트 가능성
//!
//! 이 저장소의 개발 환경은 Linux이고 제품 대상은 Windows다. `hostBinary.ts`가 그랬듯,
//! **플랫폼·PATH·파일 존재 판정을 전부 인자로 받는다.** 그래야 Windows 분기를 Linux에서
//! 검증할 수 있다 — 그렇게 하지 않아서 `.exe` 결함이 살아남았다.

use crate::policy::command::program_basename;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 해석 대상 플랫폼. `cfg!(windows)`를 직접 읽지 않는 이유는 모듈 문서 마지막 절에 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    /// 지금 이 바이너리가 도는 플랫폼. 프로덕션 호출부는 이것만 쓴다.
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }
}

/// PATH 탐색에 필요한 환경. 테스트가 통째로 구성할 수 있어야 한다.
pub struct ResolveEnv<'a> {
    pub platform: Platform,
    /// `PATH` 원문 (플랫폼 구분자로 이어진 것).
    pub path: &'a str,
    /// Windows `PATHEXT` 원문. 비어 있으면 기본값을 쓴다.
    pub pathext: &'a str,
    /// 이 경로가 실행 가능한 파일인가. 실제 구현은 `std::path::Path::is_file`이다.
    pub is_file: &'a dyn Fn(&Path) -> bool,
}

/// 어떻게 해석했는가. 감사(audit)를 위해 결과에 그대로 실린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionKind {
    /// 비 Windows — 요청을 그대로 실행한다. 기존 동작과 한 글자도 다르지 않다.
    Passthrough,
    /// PATH/PATHEXT로 찾은 실행 파일을 직접 실행 (`.exe`, `.com`).
    DirectExecutable,
    /// `.cmd` shim을 Node + CLI 스크립트로 변환 (npm, npx).
    NodeCliShim,
}

impl ResolutionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ResolutionKind::Passthrough => "passthrough",
            ResolutionKind::DirectExecutable => "direct",
            ResolutionKind::NodeCliShim => "node-cli-shim",
        }
    }
}

/// 요청된 것과 실제 실행되는 것을 **모두** 담는다.
///
/// 둘을 구별해 남기는 것이 이 타입의 존재 이유다. 결과 JSON과 이벤트에 요청 argv와
/// effective argv가 나란히 들어가야, 승인 화면에서 본 것과 실제 실행이 어떻게 대응하는지
/// 사후에 확인할 수 있다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProgram {
    pub requested_program: String,
    pub requested_args: Vec<String>,
    pub executable: PathBuf,
    pub effective_args: Vec<String>,
    pub kind: ResolutionKind,
    /// `.cmd` shim을 거쳐 해석했다면 그 shim의 경로. 감사용이다.
    pub shim_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveError {
    pub message: String,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Windows에서 확장자 없이 부른 이름에 붙여볼 확장자 기본값.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// 알려진 Node CLI shim. **이 목록 밖의 `.cmd`/`.bat`는 실행하지 않는다.**
///
/// 목록을 넓히는 것은 곧 "배치 파일을 실행할 수 있는 경로"를 넓히는 것이므로, 각 항목마다
/// 대응하는 CLI 스크립트 구조를 검증할 수 있어야 한다.
const NODE_CLI_SHIMS: &[(&str, &str)] = &[("npm", "npm-cli.js"), ("npx", "npx-cli.js")];

/// 실행 파일 해석의 단일 진입점.
///
/// 비 Windows에서는 아무것도 하지 않는다 — 요청한 program/args가 그대로 나간다.
pub fn resolve_program(program: &str, args: &[String], env: &ResolveEnv<'_>) -> Result<ResolvedProgram, ResolveError> {
    if env.platform != Platform::Windows {
        return Ok(ResolvedProgram {
            requested_program: program.to_string(),
            requested_args: args.to_vec(),
            executable: PathBuf::from(program),
            effective_args: args.to_vec(),
            kind: ResolutionKind::Passthrough,
            shim_path: None,
        });
    }

    let found = find_executable(program, env).ok_or_else(|| ResolveError {
        message: not_found_message(program, env),
    })?;
    let found_text = found.to_string_lossy().to_string();

    match extension_of(&found_text).as_str() {
        // 직접 실행 가능한 것.
        "exe" | "com" => Ok(ResolvedProgram {
            requested_program: program.to_string(),
            requested_args: args.to_vec(),
            executable: found,
            effective_args: args.to_vec(),
            kind: ResolutionKind::DirectExecutable,
            shim_path: None,
        }),
        "cmd" | "bat" => resolve_batch_shim(program, args, &found_text, env),
        other => Err(ResolveError {
            message: format!(
                "{program}는 셸 없이 실행할 수 없는 형식입니다 (.{other}): {found_text}\n\
                 셸을 경유하면 인자가 재해석되므로 실행하지 않습니다."
            ),
        }),
    }
}

// ---------------------------------------------------------------------------
// 경로 조작
//
// `std::path`를 쓰지 않는 이유: `Path::join`과 `Path::parent`는 **실행 중인 OS의**
// 구분자만 안다. Linux에서 `C:\Program Files\nodejs\npm.cmd`의 부모를 물으면 `""`가 나온다.
// 그러면 Windows 분기를 Linux에서 검증할 수 없고, 그게 `.exe` 결함이 살아남은 이유다.
// 여기서는 Windows 규칙(`\`와 `/`를 모두 구분자로)으로 문자열을 직접 다룬다.
// ---------------------------------------------------------------------------

/// 마지막 구분자 앞부분. 구분자가 없으면 `None`.
fn parent_of(path: &str) -> Option<String> {
    let index = path.rfind(['\\', '/'])?;
    Some(path[..index].to_string())
}

/// Windows 구분자로 이어 붙인다. 이미 구분자로 끝나면 겹치지 않게 한다.
fn join_windows(base: &str, segments: &[&str]) -> String {
    let mut out = base.trim_end_matches(['\\', '/']).to_string();
    for segment in segments {
        out.push('\\');
        out.push_str(segment);
    }
    out
}

/// 마지막 구분자 뒤 부분.
fn file_name_of(path: &str) -> &str {
    match path.rfind(['\\', '/']) {
        Some(index) => &path[index + 1..],
        None => path,
    }
}

/// `.cmd`/`.bat`를 만났을 때. **알려진 Node CLI shim만** 구조적으로 변환한다.
fn resolve_batch_shim(
    program: &str,
    args: &[String],
    shim: &str,
    env: &ResolveEnv<'_>,
) -> Result<ResolvedProgram, ResolveError> {
    let stem = program_basename(shim);
    let Some((_, cli_name)) = NODE_CLI_SHIMS.iter().find(|(name, _)| *name == stem) else {
        return Err(ResolveError {
            message: format!(
                "{program}는 알려지지 않은 배치 스크립트입니다: {shim}\n\
                 배치 파일은 셸을 통해야 실행되고, 셸을 거치면 인자가 재해석되므로 실행하지 않습니다."
            ),
        });
    };

    // npm shim은 Node 설치 디렉터리에 node.exe와 나란히 있고, 실제 CLI는
    // `<dir>\node_modules\npm\bin\npm-cli.js`다. 두 파일을 **모두 확인**한다.
    let shim_dir = parent_of(shim).ok_or_else(|| ResolveError {
        message: format!("shim 경로에 디렉터리가 없습니다: {shim}"),
    })?;
    let node_exe = join_windows(&shim_dir, &["node.exe"]);
    let cli_script = join_windows(&shim_dir, &["node_modules", "npm", "bin", cli_name]);

    let mut missing: Vec<String> = Vec::new();
    if !(env.is_file)(Path::new(&node_exe)) {
        missing.push(node_exe.clone());
    }
    if !(env.is_file)(Path::new(&cli_script)) {
        missing.push(cli_script.clone());
    }
    if !missing.is_empty() {
        return Err(ResolveError {
            message: format!(
                "{program}의 Node 설치 구조를 확인하지 못했습니다 (shim: {shim}).\n  없음: {}\n\
                 추측해서 다른 Node나 다른 npm을 실행하지 않습니다.",
                missing.join("\n  없음: ")
            ),
        });
    }

    // 안전 장치: 해석 결과가 정말 node인지 확인한다. 여기가 뚫리면 "npm을 승인했는데
    // 다른 프로그램이 돈다"가 되므로, 이름이 바뀔 수 없다는 것을 명시적으로 단정한다.
    if program_basename(&node_exe) != "node" {
        return Err(ResolveError {
            message: format!("해석 결과가 node가 아닙니다: {node_exe}"),
        });
    }

    let mut effective_args = Vec::with_capacity(args.len() + 1);
    effective_args.push(cli_script);
    // 요청 인자는 **가공 없이** 그대로 뒤에 붙는다. 셸이 없으므로 메타문자는 리터럴이다.
    effective_args.extend(args.iter().cloned());

    Ok(ResolvedProgram {
        requested_program: program.to_string(),
        requested_args: args.to_vec(),
        executable: PathBuf::from(node_exe),
        effective_args,
        kind: ResolutionKind::NodeCliShim,
        shim_path: Some(PathBuf::from(shim)),
    })
}

/// PATH와 PATHEXT로 실제 파일을 찾는다.
pub fn find_executable(program: &str, env: &ResolveEnv<'_>) -> Option<PathBuf> {
    let windows = env.platform == Platform::Windows;
    let separator = if windows { ';' } else { ':' };

    // 경로 구분자가 들어 있으면 PATH를 뒤지지 않는다 — 지정된 위치만 본다.
    if program.contains('/') || program.contains('\\') {
        return probe(program, program, env);
    }

    for dir in env.path.split(separator) {
        if dir.trim().is_empty() {
            continue;
        }
        let candidate = if windows {
            join_windows(dir, &[program])
        } else {
            format!("{}/{program}", dir.trim_end_matches('/'))
        };
        if let Some(found) = probe(&candidate, program, env) {
            return Some(found);
        }
    }
    None
}

/// 한 후보 경로에 대해 실행 가능한 파일을 찾는다.
///
/// # Windows에서 확장자 없는 파일을 집으면 안 된다
///
/// Node의 Windows 설치 디렉터리에는 `npm.cmd` **옆에 확장자 없는 `npm`**이 함께 있다
/// (Git Bash/MSYS용 셸 스크립트다). 확장자 없는 후보를 먼저 확인하면 그걸 집게 되고,
/// 실측으로 이렇게 실패했다:
///
/// ```text
/// npm는 셸 없이 실행할 수 없는 형식입니다 (.): D:\Program Files\nodejs\npm
/// ```
///
/// Windows에서 실행 파일 판정은 **PATHEXT가 한다.** 확장자 없는 파일은 어떤 PATHEXT 항목과도
/// 맞지 않으므로 실행 파일이 아니다 — `cmd`도 CreateProcess도 그렇게 해석한다. 그러니 이름에
/// 확장자가 없으면 PATHEXT를 붙인 것만 후보로 본다.
fn probe(candidate: &str, requested: &str, env: &ResolveEnv<'_>) -> Option<PathBuf> {
    let exists = |path: &str| (env.is_file)(Path::new(path));

    if env.platform != Platform::Windows {
        // POSIX에는 PATHEXT가 없다. 파일이 곧 실행 대상이다.
        return exists(candidate).then(|| PathBuf::from(candidate));
    }

    // 이미 확장자를 갖고 있으면 그대로만 본다 — `npm.cmd.exe`를 찾으려 들면 안 된다.
    if !extension_of(requested).is_empty() {
        return exists(candidate).then(|| PathBuf::from(candidate));
    }

    let raw = if env.pathext.trim().is_empty() {
        DEFAULT_PATHEXT
    } else {
        env.pathext
    };
    for ext in raw.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        let ext = if ext.starts_with('.') {
            ext.to_string()
        } else {
            format!(".{ext}")
        };
        // PATHEXT는 보통 대문자로 오지만 실제 파일은 소문자다. 대소문자를 구별하는 파일
        // 시스템에서도 찾히도록 세 가지를 시도한다 — Windows 자체는 비구분이므로
        // 첫 시도로 끝나지만, 이 함수는 대소문자를 구별하는 곳에서도 테스트된다.
        let mut seen = BTreeSet::new();
        for cased in [ext.clone(), ext.to_lowercase(), ext.to_uppercase()] {
            if !seen.insert(cased.clone()) {
                continue;
            }
            let with_ext = format!("{candidate}{cased}");
            if exists(&with_ext) {
                return Some(PathBuf::from(with_ext));
            }
        }
    }
    None
}

/// 소문자 확장자 (점 없음). 확장자가 없으면 빈 문자열.
///
/// `Path::extension`을 쓰지 않는다 — 구분자 판정이 실행 중인 OS에 묶이기 때문이다.
fn extension_of(path: &str) -> String {
    let name = file_name_of(path);
    match name.rfind('.') {
        Some(index) if index > 0 => name[index + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// 못 찾았을 때의 안내. **PATH 전체를 그대로 뱉지 않는다** — 길고, 자격증명은 아니지만
/// 로그를 오염시킨다. 대신 무엇을 어떻게 찾았는지 알려준다.
fn not_found_message(program: &str, env: &ResolveEnv<'_>) -> String {
    let dirs = env.path.split(';').filter(|d| !d.trim().is_empty()).count();
    let pathext = if env.pathext.trim().is_empty() {
        DEFAULT_PATHEXT
    } else {
        env.pathext
    };
    let base = format!(
        "{program}을(를) 실행할 수 없습니다: PATH에서 찾지 못했습니다.\n  \
         검색한 디렉터리 수: {dirs}\n  시도한 확장자: {pathext}\n  \
         해당 도구가 설치되어 있고 PATH에 있는지 확인하세요."
    );
    // **모델의 Unix 편향을 여기서 교정한다**(state-machine 41절, product-strategy 12.3③).
    // 이 문장의 주 독자는 사용자가 아니라 모델이다 — 도구 실패는 프롬프트로 돌아가고,
    // "못 찾았다"에서 끝나면 모델은 같은 모양을 다시 시도한다.
    //
    // **해석이 실패한 뒤에만** 붙는다. `ls`가 PATH에 실제로 있으면(Git for Windows가 깔린
    // 머신이 그렇다) 그대로 실행된다 — 우리가 사용자의 환경을 이기지 않는다.
    match crate::shell_habits::alternative_for(program) {
        Some(advice) => format!("{base}\n  {}", advice.message),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 가상 파일 시스템. 실제 Windows 없이 Windows 분기를 전부 태우기 위한 것이다.
    struct Fs {
        files: HashSet<String>,
    }

    impl Fs {
        fn new(files: &[&str]) -> Self {
            // 양쪽 구분자를 같은 형태로 맞춘다. 이 하네스는 Windows 경로와 POSIX 경로를
            // 모두 담으므로, 조회할 때만 정규화하면 POSIX 항목이 영영 매치되지 않는다.
            Self {
                files: files.iter().map(|f| f.replace('/', "\\")).collect(),
            }
        }
        fn probe(&self) -> impl Fn(&Path) -> bool + '_ {
            move |p: &Path| self.files.contains(&p.to_string_lossy().replace('/', "\\"))
        }
    }

    /// 전형적인 Windows Node 설치.
    ///
    /// **확장자 없는 `npm`/`npx`가 `.cmd` 옆에 실제로 존재한다.** Node 인스톨러가 Git Bash/MSYS용
    /// 셸 스크립트를 함께 깔기 때문이다. 실측에서 해석기가 이걸 집어 실패했으므로, fixture가
    /// 실제 설치를 그대로 흉내내지 않으면 그 결함을 다시 놓친다.
    fn node_install() -> Fs {
        Fs::new(&[
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files\nodejs\npm",
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\npx",
            r"C:\Program Files\nodejs\npx.cmd",
            r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js",
            r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js",
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Users\me\.cargo\bin\cargo.exe",
        ])
    }

    /// **못 찾았을 때 모델이 다음에 할 일을 말한다**(41절). 이 문장은 프롬프트로 돌아가므로,
    /// "못 찾았다"에서 끝나면 모델은 같은 모양을 다시 시도한다.
    #[test]
    fn a_unix_command_that_is_missing_points_at_the_tool_that_replaces_it() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let err = resolve_program("ls", &[], &env).unwrap_err();
        assert!(err.message.contains("list_files"), "{}", err.message);
        // 사실 자체도 남아 있어야 한다 — 안내가 원인을 덮으면 안 된다.
        assert!(err.message.contains("PATH"), "{}", err.message);
    }

    /// 대응 도구가 없으면 **지어내지 않는다.**
    #[test]
    fn a_missing_command_without_an_equivalent_gets_no_extra_advice() {
        let fs = node_install();
        let env = win_env(&fs, "");
        // `mv`는 44절이 `move_file`을 만들면서 대안이 생겼다 — 여전히 대응이 없는 것을 쓴다.
        let err = resolve_program("cp", &[], &env).unwrap_err();
        assert!(err.message.contains("PATH"), "{}", err.message);
        assert!(!err.message.contains("도구로 요청하세요"), "{}", err.message);
    }

    /// **PATH에 실제로 있으면 그대로 실행된다** — 우리가 사용자의 환경을 이기지 않는다.
    /// Git for Windows가 깔린 머신에는 `ls.exe`가 있다.
    #[test]
    fn a_unix_command_that_actually_exists_is_not_second_guessed() {
        let fs = Fs::new(&[r"C:\Program Files\Git\usr\bin\ls.exe"]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r"C:\Program Files\Git\usr\bin",
            pathext: "",
            is_file: &fs.probe(),
        };
        let resolved = resolve_program("ls", &[], &env).expect("있는데 거부했습니다");
        assert_eq!(resolved.kind, ResolutionKind::DirectExecutable);
    }

    const WIN_PATH: &str = r"C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Users\me\.cargo\bin";

    fn win_env<'a>(fs: &'a Fs, pathext: &'a str) -> ResolveEnv<'a> {
        ResolveEnv {
            platform: Platform::Windows,
            path: WIN_PATH,
            pathext,
            is_file: Box::leak(Box::new(fs.probe())),
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // ---- 1. 비 Windows는 그대로 ----

    #[test]
    fn non_windows_keeps_the_requested_program_and_argv_untouched() {
        let fs = Fs::new(&[]);
        let probe = fs.probe();
        let env = ResolveEnv {
            platform: Platform::Unix,
            path: "/usr/bin:/bin",
            pathext: "",
            is_file: &probe,
        };
        let requested = args(&["test", "--silent", "a&b", "c|d"]);
        let resolved = resolve_program("npm", &requested, &env).unwrap();

        assert_eq!(resolved.executable, PathBuf::from("npm"));
        assert_eq!(resolved.effective_args, requested);
        assert_eq!(resolved.kind, ResolutionKind::Passthrough);
        assert_eq!(resolved.shim_path, None);
    }

    #[test]
    fn non_windows_does_not_touch_the_file_system_at_all() {
        // 기존 동작을 한 글자도 바꾸지 않는다는 것을 구조로 보인다:
        // 비 Windows 경로는 is_file을 한 번도 부르지 않는다.
        let calls = std::cell::Cell::new(0usize);
        let probe = |_: &Path| {
            calls.set(calls.get() + 1);
            true
        };
        let env = ResolveEnv {
            platform: Platform::Unix,
            path: "/usr/bin",
            pathext: "",
            is_file: &probe,
        };
        resolve_program("npm", &args(&["test"]), &env).unwrap();
        assert_eq!(calls.get(), 0, "비 Windows에서 파일 시스템을 건드렸습니다");
    }

    // ---- 2. .exe는 직접 실행 ----

    #[test]
    fn windows_exe_is_executed_directly() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let resolved = resolve_program("git", &args(&["status", "--short"]), &env).unwrap();

        assert_eq!(resolved.executable, PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
        assert_eq!(resolved.effective_args, args(&["status", "--short"]));
        assert_eq!(resolved.kind, ResolutionKind::DirectExecutable);
        assert_eq!(resolved.shim_path, None);
    }

    #[test]
    fn windows_exe_given_with_extension_is_not_double_suffixed() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let resolved = resolve_program("git.exe", &args(&[]), &env).unwrap();
        assert_eq!(resolved.executable, PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
    }

    // ---- 3. npm이 Node CLI로 안전하게 해석된다 ----

    #[test]
    fn windows_npm_resolves_to_node_plus_npm_cli() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let resolved = resolve_program("npm", &args(&["test", "--silent"]), &env).unwrap();

        assert_eq!(resolved.kind, ResolutionKind::NodeCliShim);
        assert_eq!(resolved.executable, PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        assert_eq!(
            resolved.effective_args,
            args(&[
                r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js",
                "test",
                "--silent"
            ])
        );
        assert_eq!(
            resolved.shim_path,
            Some(PathBuf::from(r"C:\Program Files\nodejs\npm.cmd"))
        );
        // 논리적 요청은 보존된다.
        assert_eq!(resolved.requested_program, "npm");
        assert_eq!(resolved.requested_args, args(&["test", "--silent"]));
    }

    /// 실측 결함: Node 인스톨러가 `npm.cmd` 옆에 확장자 없는 `npm`(Git Bash용 셸 스크립트)을
    /// 함께 깐다. 확장자 없는 후보를 먼저 확인하면 그걸 집고, Windows에서는 실행할 수 없다.
    #[test]
    fn windows_ignores_the_extensionless_unix_shim_next_to_npm_cmd() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let resolved = resolve_program("npm", &args(&["test"]), &env).unwrap();

        assert_eq!(
            resolved.shim_path,
            Some(PathBuf::from(r"C:\Program Files\nodejs\npm.cmd")),
            "확장자 없는 Unix 셸 스크립트를 집었습니다"
        );
        assert_eq!(resolved.kind, ResolutionKind::NodeCliShim);
    }

    #[test]
    fn windows_never_resolves_to_an_extensionless_file() {
        // PATHEXT에 맞지 않는 파일은 Windows에서 실행 파일이 아니다. 어떤 이름으로도
        // 확장자 없는 결과가 나오면 안 된다 — 나오면 spawn 단계에서 정체불명으로 실패한다.
        let fs = Fs::new(&[r"C:\tools\thing", r"C:\tools\other"]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r"C:\tools",
            pathext: "",
            is_file: Box::leak(Box::new(fs.probe())),
        };
        for program in ["thing", "other"] {
            let error =
                resolve_program(program, &args(&[]), &env).expect_err("확장자 없는 파일이 실행 대상이 되었습니다");
            assert!(error.message.contains("PATH에서 찾지 못했습니다"), "{}", error.message);
        }
    }

    #[test]
    fn non_windows_still_accepts_extensionless_executables() {
        // POSIX에는 PATHEXT가 없다. 위 규칙을 그쪽까지 적용하면 모든 명령이 깨진다.
        let fs = Fs::new(&["/usr/bin/npm"]);
        let probe = fs.probe();
        let env = ResolveEnv {
            platform: Platform::Unix,
            path: "/usr/bin",
            pathext: "",
            is_file: &probe,
        };
        // Unix 분기는 PATH를 뒤지지 않고 요청을 그대로 통과시킨다.
        let resolved = resolve_program("npm", &args(&["test"]), &env).unwrap();
        assert_eq!(resolved.kind, ResolutionKind::Passthrough);
        assert_eq!(resolved.executable, PathBuf::from("npm"));
        // find_executable 자체도 확장자 없는 파일을 찾아야 한다.
        assert_eq!(find_executable("npm", &env), Some(PathBuf::from("/usr/bin/npm")));
    }

    // ---- 4. npm.cmd와 절대 경로 npm.cmd ----

    #[test]
    fn windows_npm_cmd_and_absolute_npm_cmd_resolve_identically() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let by_name = resolve_program("npm", &args(&["test"]), &env).unwrap();
        let by_ext = resolve_program("npm.cmd", &args(&["test"]), &env).unwrap();
        let by_abs = resolve_program(r"C:\Program Files\nodejs\npm.cmd", &args(&["test"]), &env).unwrap();

        assert_eq!(by_name.executable, by_ext.executable);
        assert_eq!(by_name.executable, by_abs.executable);
        assert_eq!(by_name.effective_args, by_ext.effective_args);
        assert_eq!(by_name.effective_args, by_abs.effective_args);
        assert_eq!(by_abs.kind, ResolutionKind::NodeCliShim);
        // 요청 문자열 자체는 각자 보존된다 — 감사 기록이 무엇을 요청했는지 알아야 한다.
        assert_eq!(by_abs.requested_program, r"C:\Program Files\nodejs\npm.cmd");
    }

    // ---- 5. npx ----

    #[test]
    fn windows_npx_resolves_to_npx_cli() {
        let fs = node_install();
        let env = win_env(&fs, "");
        for requested in ["npx", "npx.cmd"] {
            let resolved = resolve_program(requested, &args(&["tsc", "--noEmit"]), &env).unwrap();
            assert_eq!(resolved.kind, ResolutionKind::NodeCliShim);
            assert_eq!(
                resolved.effective_args,
                args(&[
                    r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js",
                    "tsc",
                    "--noEmit"
                ])
            );
        }
    }

    // ---- 6. 못 찾으면 명확히 실패 ----

    #[test]
    fn missing_program_fails_with_actionable_message() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let error = resolve_program("pytest", &args(&["-q"]), &env).unwrap_err();
        assert!(error.message.contains("pytest"), "{}", error.message);
        assert!(error.message.contains("PATH에서 찾지 못했습니다"), "{}", error.message);
        // 무엇을 시도했는지 알려준다.
        assert!(error.message.contains("시도한 확장자"), "{}", error.message);
        // PATH 전체를 그대로 뱉지 않는다.
        assert!(!error.message.contains(WIN_PATH), "PATH 전체가 메시지에 들어갔습니다");
    }

    #[test]
    fn missing_node_install_structure_fails_instead_of_guessing() {
        // npm.cmd는 있는데 npm-cli.js가 없다 — 여기서 추측해 다른 npm을 실행하면 안 된다.
        let fs = Fs::new(&[r"C:\Program Files\nodejs\node.exe", r"C:\Program Files\nodejs\npm.cmd"]);
        let env = win_env(&fs, "");
        let error = resolve_program("npm", &args(&["test"]), &env).unwrap_err();
        assert!(
            error.message.contains("구조를 확인하지 못했습니다"),
            "{}",
            error.message
        );
        assert!(error.message.contains("npm-cli.js"), "{}", error.message);
        assert!(error.message.contains("추측"), "{}", error.message);
    }

    // ---- 7. PATHEXT 대소문자 ----

    #[test]
    fn pathext_case_differences_are_handled() {
        let fs = node_install();
        for pathext in [
            ".COM;.EXE;.BAT;.CMD",
            ".com;.exe;.bat;.cmd",
            ".Com;.Exe;.Bat;.Cmd",
            "COM;EXE;BAT;CMD", // 점 없는 변형
        ] {
            let env = win_env(&fs, pathext);
            let resolved =
                resolve_program("npm", &args(&["test"]), &env).unwrap_or_else(|e| panic!("PATHEXT={pathext}: {e}"));
            assert_eq!(resolved.kind, ResolutionKind::NodeCliShim, "PATHEXT={pathext}");
        }
    }

    #[test]
    fn empty_pathext_falls_back_to_the_default_set() {
        let fs = node_install();
        let env = win_env(&fs, "   ");
        let resolved = resolve_program("git", &args(&[]), &env).unwrap();
        assert_eq!(resolved.kind, ResolutionKind::DirectExecutable);
    }

    // ---- 8. 셸 메타문자가 리터럴로 유지된다 ----

    #[test]
    fn shell_metacharacters_stay_a_single_literal_argument() {
        let fs = node_install();
        let env = win_env(&fs, "");
        let hostile = args(&[
            "run",
            "build && del /q C:\\",
            "a|b",
            "c>d",
            "e<f",
            "%PATH%",
            "^caret",
            "with space",
            "\"quoted\"",
        ]);
        let resolved = resolve_program("npm", &hostile, &env).unwrap();

        // CLI 스크립트 하나만 앞에 붙고, 나머지는 개수도 내용도 그대로다.
        assert_eq!(resolved.effective_args.len(), hostile.len() + 1);
        assert_eq!(&resolved.effective_args[1..], &hostile[..]);
        for original in &hostile {
            assert!(
                resolved.effective_args.contains(original),
                "인자가 변형되었습니다: {original}"
            );
        }
    }

    // ---- 9. allowlist 우회 불가 ----

    #[test]
    fn resolution_never_changes_the_program_identity_the_policy_matched() {
        // Policy Gate는 요청된 program의 basename으로 판정한다. 해석이 그 정체성을 바꾸면
        // "npm을 승인했는데 다른 것이 돈다"가 된다.
        let fs = node_install();
        let env = win_env(&fs, "");

        for (requested, expected_identity) in [("npm", "npm"), ("npx", "npx"), ("git", "git")] {
            let resolved = resolve_program(requested, &args(&["x"]), &env).unwrap();
            assert_eq!(program_basename(&resolved.requested_program), expected_identity);
            match resolved.kind {
                // 직접 실행이면 실행 파일 자체가 같은 정체성이어야 한다.
                ResolutionKind::DirectExecutable => assert_eq!(
                    program_basename(&resolved.executable.to_string_lossy()),
                    expected_identity
                ),
                // shim 변환이면 실행 파일은 node이고, 무엇을 실행하는지는 첫 인자가 말한다.
                ResolutionKind::NodeCliShim => {
                    assert_eq!(program_basename(&resolved.executable.to_string_lossy()), "node");
                    assert!(
                        resolved.effective_args[0].contains(expected_identity),
                        "{} 요청이 {}로 해석되었습니다",
                        requested,
                        resolved.effective_args[0]
                    );
                }
                ResolutionKind::Passthrough => unreachable!(),
            }
        }
    }

    #[test]
    fn resolution_never_produces_a_shell_launcher() {
        // 해석 결과가 cmd/powershell이 되는 경로가 있으면 deny 목록이 무의미해진다.
        let fs = Fs::new(&[
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js",
        ]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r"C:\Program Files\nodejs;C:\Windows\System32",
            pathext: "",
            is_file: Box::leak(Box::new(fs.probe())),
        };
        let resolved = resolve_program("npm", &args(&["test"]), &env).unwrap();
        let executed = program_basename(&resolved.executable.to_string_lossy());
        assert_ne!(executed, "cmd");
        assert_ne!(executed, "powershell");
        assert_eq!(executed, "node");
    }

    // ---- 13. 알려지지 않은 배치는 실행하지 않는다 ----

    #[test]
    fn unknown_batch_scripts_are_refused_not_run_through_a_shell() {
        let fs = Fs::new(&[r"C:\tools\deploy.bat", r"C:\tools\install.cmd"]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r"C:\tools",
            pathext: "",
            is_file: Box::leak(Box::new(fs.probe())),
        };
        for program in ["deploy", "install", "deploy.bat", "install.cmd"] {
            let error =
                resolve_program(program, &args(&[]), &env).expect_err("알려지지 않은 배치가 실행 대상이 되었습니다");
            assert!(
                error.message.contains("알려지지 않은 배치 스크립트"),
                "{}",
                error.message
            );
            assert!(error.message.contains("재해석"), "{}", error.message);
        }
    }

    #[test]
    fn other_script_types_are_refused_too() {
        let fs = Fs::new(&[r"C:\tools\thing.ps1"]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r"C:\tools",
            pathext: ".PS1",
            is_file: Box::leak(Box::new(fs.probe())),
        };
        let error = resolve_program("thing", &args(&[]), &env).unwrap_err();
        assert!(
            error.message.contains("셸 없이 실행할 수 없는 형식"),
            "{}",
            error.message
        );
    }

    // ---- 경로 지정 동작 ----

    #[test]
    fn a_program_with_a_separator_is_not_searched_on_path() {
        let fs = node_install();
        let env = win_env(&fs, "");
        // PATH에 있는 git.exe와 이름이 같아도, 지정한 위치에 없으면 못 찾아야 한다.
        let error = resolve_program(r"C:\elsewhere\git.exe", &args(&[]), &env).unwrap_err();
        assert!(error.message.contains("PATH에서 찾지 못했습니다"), "{}", error.message);
    }

    #[test]
    fn path_entries_are_searched_in_order() {
        let fs = Fs::new(&[r"C:\first\tool.exe", r"C:\second\tool.exe"]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r"C:\first;C:\second",
            pathext: "",
            is_file: Box::leak(Box::new(fs.probe())),
        };
        let resolved = resolve_program("tool", &args(&[]), &env).unwrap();
        assert_eq!(resolved.executable, PathBuf::from(r"C:\first\tool.exe"));
    }

    #[test]
    fn empty_path_segments_are_skipped() {
        let fs = Fs::new(&[r"C:\bin\tool.exe"]);
        let env = ResolveEnv {
            platform: Platform::Windows,
            path: r";;C:\bin;  ;",
            pathext: "",
            is_file: Box::leak(Box::new(fs.probe())),
        };
        assert!(resolve_program("tool", &args(&[]), &env).is_ok());
    }
}
