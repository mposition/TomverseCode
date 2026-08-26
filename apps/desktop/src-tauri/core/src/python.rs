//! Python 프로젝트의 검증 명령 — state-machine-and-protocol.md 49절.
//!
//! # 왜 따로 있는가
//!
//! `verify.rs`의 다른 세 갈래(npm·cargo·dotnet)는 **매니페스트만 보면 끝난다.** 명령의
//! 프로그램 이름이 고정되어 있고(`npm`/`cargo`/`dotnet`) PATH에 있으면 그대로 돈다.
//!
//! Python은 그렇지 않다. 도구가 **인터프리터 안에** 설치되고, 그 인터프리터는 대개
//! 가상환경 안에 있으며, 가상환경은 **활성화해야** PATH에 올라온다. 우리는 셸을 거치지
//! 않으므로(원칙 6) 활성화를 흉내 낼 수 없고, 흉내 내려고 `bash -c "source .venv/bin/activate && pytest"`를
//! 쓰는 순간 argv 계약이 깨진다.
//!
//! 그래서 `npm.cmd` shim에서 한 것과 **같은 방법**을 쓴다(`tools/program.rs`): 활성화가 하는
//! 일을 구조적으로 재현한다. 활성화가 실제로 하는 일은 PATH 앞에 `bin`/`Scripts`를 붙이는
//! 것이고, 그 결과 `pytest`는 **그 가상환경의 인터프리터**로 실행된다. 우리는 그 인터프리터를
//! 직접 부른다: `<venv>/bin/python -m pytest`.
//!
//! # 선언이 근거다
//!
//! 도구가 있는지 없는지는 **실행해 봐야** 안다. 그런데 실행해서 "No module named pytest"를
//! 받으면 그건 검증 실패로 기록되고, 그 실패는 모델을 고칠 것 없는 문제로 보낸다.
//!
//! 그래서 24.5절의 규칙을 그대로 쓴다: **프로젝트가 선언해 둔 것만 명령으로 만든다.**
//! `pytest.ini`가 있거나 `pyproject.toml`에 `[tool.pytest.ini_options]`가 있으면 그 프로젝트는
//! pytest로 테스트한다고 말한 것이고, 그때의 "No module named pytest"는 **사용자가 알아야 할
//! 진짜 환경 문제**다. 선언이 없으면 아무 명령도 만들지 않는다 — `NOT_CONFIGURED`이며,
//! 그건 "통과"가 아니라 "돌릴 것이 없다"이다(원칙 1).
//!
//! # `tests/` 디렉터리를 근거로 삼지 않는다
//!
//! 가장 흔한 신호지만 **선언이 아니다.** unittest·nose·tox를 쓰는 프로젝트에도 `tests/`가
//! 있고, 그런 프로젝트에 pytest를 돌리면 우리가 만든 실패가 사용자의 실패로 보고된다.
//!
//! # 경로 조립을 대상 플랫폼 기준으로 한다
//!
//! 가상환경의 인터프리터 자리가 플랫폼마다 다르다(`bin/python` vs `Scripts\python.exe`).
//! `std::path`는 **실행 중인 OS의 구분자만 알므로**(CLAUDE.md), Windows 분기를 Linux에서
//! 검증하려면 `Platform`을 인자로 받아 문자열로 조립해야 한다. `msvc.rs`가 같은 이유로
//! 같은 모양을 하고 있다.

use crate::tools::program::Platform;
use serde::Serialize;

/// 인터프리터를 **무엇을 근거로** 골랐는가.
///
/// 근거를 값으로 남기는 이유: "왜 이 python을 골랐나"는 검증이 이상하게 실패했을 때 사용자가
/// 가장 먼저 묻는 질문이고, 그때 우리가 답할 수 있어야 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum How {
    /// 워크스페이스 안의 `.venv`.
    DotVenv,
    /// 워크스페이스 안의 `venv`.
    Venv,
    /// 활성화된 가상환경(`VIRTUAL_ENV`).
    ActivatedEnv,
    /// PATH에서 찾은 인터프리터. **가상환경이 아니므로 도구가 없을 수 있다.**
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interpreter {
    /// `workspace_relative`이면 워크스페이스 루트 기준 상대경로, 아니면 그대로 실행할 이름/경로.
    pub program: String,
    pub how: How,
    /// 이 인터프리터가 **워크스페이스 안에** 있는가.
    ///
    /// 두 가지가 여기 걸려 있다.
    ///
    /// **① 절대경로로 바꿔야 한다.** 상대 프로그램 경로는 플랫폼마다 다르게 풀린다 —
    /// Unix는 자식이 `chdir` 뒤에 찾지만 **Windows는 부모의 cwd 기준으로 먼저 찾는다.**
    /// 그러면 같은 값이 한쪽에서만 동작한다.
    ///
    /// **② 모델이 그 파일을 고칠 수 있다.** 워크스페이스 안이므로 `apply_patch`의 사정권이고,
    /// 그래서 사전 승인의 지문이 이 파일의 **내용**을 함께 세야 한다(49.5절). npm에서 이미
    /// 겪은 것과 같은 문제인데(29.3절), 거기서는 매니페스트가 바뀌었고 여기서는 **프로그램
    /// 자체**가 바뀐다.
    pub workspace_relative: bool,
}

/// 바깥 세계. **전부 인자로 받는다** — 그래야 Linux에서 Windows 분기를 검증할 수 있다.
pub struct Probe<'a> {
    pub platform: Platform,
    /// 워크스페이스 **상대** 경로가 파일로 존재하는가.
    pub is_file: &'a dyn Fn(&str) -> bool,
    /// 워크스페이스 상대 경로의 내용. 없으면 `None`.
    pub read: &'a dyn Fn(&str) -> Option<String>,
    /// 환경변수. `VIRTUAL_ENV`를 읽는 데만 쓴다.
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// 이 프로그램 이름이 PATH에 있는가.
    pub on_path: &'a dyn Fn(&str) -> bool,
}

/// 가상환경 디렉터리 안에서 인터프리터의 자리. **조립을 한 곳에 둔다.**
///
/// 구분자도 대상 플랫폼 것을 쓴다 — Linux에서 `Path::join`으로 만들면 `C:\venv/Scripts/python.exe`가
/// 되고, 그건 Windows에서 존재하지 않는 경로다.
pub fn interpreter_in(venv: &str, platform: Platform) -> String {
    match platform {
        Platform::Windows => {
            let trimmed = venv.trim_end_matches(['\\', '/']);
            format!("{trimmed}\\Scripts\\python.exe")
        }
        Platform::Unix => {
            let trimmed = venv.trim_end_matches('/');
            format!("{trimmed}/bin/python")
        }
    }
}

/// PATH에서 찾을 인터프리터 이름. 플랫폼마다 관례가 다르다.
fn path_candidates(platform: Platform) -> &'static [&'static str] {
    match platform {
        // Windows에는 `python3.exe`가 대개 없다(있어도 Store 별칭이라 실행하면 창이 뜬다).
        Platform::Windows => &["python"],
        Platform::Unix => &["python3", "python"],
    }
}

/// 이 워크스페이스에서 쓸 인터프리터.
///
/// # 순서의 근거
///
/// **워크스페이스 안의 가상환경이 먼저다.** 활성화된 환경(`VIRTUAL_ENV`)은 사용자가 우리를
/// 띄운 셸의 사정이고 **다른 프로젝트의 것일 수 있다.** 우리가 검증하려는 것은 이 워크스페이스이므로,
/// 이 워크스페이스가 들고 있는 환경이 더 구체적인 근거다.
///
/// PATH는 마지막이다. 가상환경이 아니므로 선언된 도구가 거기 없을 수 있고, 그 사실을
/// `How::Path`가 말한다.
pub fn interpreter(probe: &Probe) -> Option<Interpreter> {
    for (dir, how) in [(".venv", How::DotVenv), ("venv", How::Venv)] {
        let candidate = interpreter_in(dir, probe.platform);
        if (probe.is_file)(&candidate) {
            return Some(Interpreter { program: candidate, how, workspace_relative: true });
        }
    }
    // `VIRTUAL_ENV`는 **우리 프로세스의 환경**이다 — Node도 모델도 채울 수 없다. PATH를
    // 신뢰하는 것과 같은 등급이며, 그보다 구체적이다.
    if let Some(active) = (probe.env)("VIRTUAL_ENV").filter(|v| !v.trim().is_empty()) {
        return Some(Interpreter {
            program: interpreter_in(&active, probe.platform),
            how: How::ActivatedEnv,
            workspace_relative: false,
        });
    }
    for name in path_candidates(probe.platform) {
        if (probe.on_path)(name) {
            return Some(Interpreter { program: (*name).to_string(), how: How::Path, workspace_relative: false });
        }
    }
    None
}

/// 한 도구가 **선언된 근거**. 문자열은 사용자에게 그대로 보여준다.
fn declared_by(probe: &Probe, files: &[&str], sections: &[(&str, &str)]) -> Option<Declaration> {
    for file in files {
        if (probe.is_file)(file) {
            return Some(Declaration { path: (*file).to_string(), describe: (*file).to_string() });
        }
    }
    for (file, section) in sections {
        if let Some(text) = (probe.read)(file) {
            if has_section(&text, section) {
                return Some(Declaration {
                    path: (*file).to_string(),
                    describe: format!("{file} {section}"),
                });
            }
        }
    }
    None
}

/// 선언을 **두 값으로** 돌려준다.
///
/// `describe`는 사람이 읽는 근거이고 `path`는 **기계가 다시 읽어야 할 파일**이다. 한 문자열로
/// 뭉치면 나중에 경로를 되찾으려고 `"pyproject.toml [tool.mypy]"`를 파싱하게 되고, 그 파싱은
/// 문구를 다듬는 순간 조용히 깨진다(50절).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
    pub path: String,
    pub describe: String,
}

/// TOML/INI 섹션 헤더가 있는가.
///
/// **TOML 파서를 들이지 않는다.** 여기서 답해야 하는 질문은 "이 프로젝트가 이 도구를
/// 선언했는가" 하나이고, 섹션 헤더의 존재가 그 답이다. 파서를 들이면 의존성이 늘고, 그 대가로
/// 얻는 것은 이 판정에서 쓰이지 않는다.
///
/// **주석 처리된 줄은 세지 않는다.** `# [tool.mypy]`를 선언으로 읽으면, 꺼 둔 도구를 우리가
/// 켠다.
fn has_section(text: &str, section: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with('#') && !trimmed.starts_with(';') && trimmed.starts_with(section)
    })
}

/// 한 검증 명령.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// `verify.rs`의 키 — `test` / `lint` / `typecheck`.
    pub key: &'static str,
    pub args: Vec<String>,
    /// 무엇을 보고 이 명령을 만들었는가. 사용자에게 그대로 보여준다.
    pub source: String,
    /// 그 근거가 **사는 파일**. 지문이 다시 읽어야 하므로 문장과 따로 둔다(50절).
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Detection {
    pub interpreter: Option<Interpreter>,
    pub checks: Vec<Check>,
}

/// **`build`가 없다.** `python -m build`는 패키징이지 검증이 아니고, 대부분의 프로젝트에서
/// 돌릴 이유가 없다. 없는 것을 만들어 돌리면 그 실패가 검증 실패로 보고된다.
pub fn detect(probe: &Probe) -> Detection {
    let declarations: [(&str, &str, &[&str], &[(&str, &str)]); 3] = [
        (
            "test",
            "pytest",
            &["pytest.ini"],
            &[
                ("pyproject.toml", "[tool.pytest.ini_options]"),
                ("setup.cfg", "[tool:pytest]"),
                ("tox.ini", "[pytest]"),
            ],
        ),
        (
            "lint",
            "ruff",
            &["ruff.toml", ".ruff.toml"],
            &[("pyproject.toml", "[tool.ruff")],
        ),
        ("typecheck", "mypy", &["mypy.ini", ".mypy.ini"], &[("pyproject.toml", "[tool.mypy]")]),
    ];

    let mut checks = Vec::new();
    for (key, module, files, sections) in declarations {
        let Some(source) = declared_by(probe, files, sections) else {
            continue;
        };
        // ruff는 하위 명령이 필요하다(`ruff check`). pytest·mypy는 대상만 준다.
        let mut args = vec!["-m".to_string(), module.to_string()];
        if module == "ruff" {
            args.push("check".to_string());
        }
        if module != "pytest" {
            // pytest는 인자 없이 자기 설정에서 대상을 찾는다. ruff·mypy는 대상을 요구한다.
            args.push(".".to_string());
        }
        checks.push(Check { key, args, source: source.describe, evidence: source.path });
    }

    // **선언이 하나도 없으면 인터프리터도 찾지 않는다.** 찾아 두면 "python은 있는데 아무것도
    // 안 돈다"가 되어, 없는 것이 인터프리터인지 선언인지 구별되지 않는다.
    if checks.is_empty() {
        return Detection::default();
    }
    Detection { interpreter: interpreter(probe), checks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    struct World {
        files: BTreeMap<String, String>,
        path: BTreeSet<String>,
        env: BTreeMap<String, String>,
    }

    impl World {
        fn new() -> Self {
            Self { files: BTreeMap::new(), path: BTreeSet::new(), env: BTreeMap::new() }
        }
        fn file(mut self, name: &str, body: &str) -> Self {
            self.files.insert(name.to_string(), body.to_string());
            self
        }
        fn on_path(mut self, name: &str) -> Self {
            self.path.insert(name.to_string());
            self
        }
        fn env(mut self, key: &str, value: &str) -> Self {
            self.env.insert(key.to_string(), value.to_string());
            self
        }
    }

    fn probe<'a>(world: &'a World, platform: Platform) -> Probe<'a> {
        Probe {
            platform,
            is_file: Box::leak(Box::new(move |p: &str| world.files.contains_key(p))),
            read: Box::leak(Box::new(move |p: &str| world.files.get(p).cloned())),
            env: Box::leak(Box::new(move |k: &str| world.env.get(k).cloned())),
            on_path: Box::leak(Box::new(move |n: &str| world.path.contains(n))),
        }
    }

    /// **선언이 없으면 아무것도 만들지 않는다.** `tests/`가 있어도 마찬가지다 —
    /// unittest·tox를 쓰는 프로젝트에 pytest를 돌리면 우리가 만든 실패가 사용자의 실패로 보고된다.
    #[test]
    fn no_declaration_means_no_command() {
        let world = World::new().file("tests/test_app.py", "").on_path("python3");
        let d = detect(&probe(&world, Platform::Unix));
        assert!(d.checks.is_empty(), "{:?}", d.checks);
        // 인터프리터도 찾지 않는다 — 없는 것이 무엇인지 흐려진다.
        assert_eq!(d.interpreter, None);
    }

    #[test]
    fn pytest_ini_declares_the_test_command() {
        let world = World::new().file("pytest.ini", "[pytest]\n").on_path("python3");
        let d = detect(&probe(&world, Platform::Unix));
        let test = d.checks.iter().find(|c| c.key == "test").expect("test 명령이 없습니다");
        assert_eq!(test.args, vec!["-m", "pytest"]);
        assert_eq!(test.source, "pytest.ini");
    }

    /// 선언은 파일만이 아니라 **섹션**으로도 온다. 그리고 그 섹션이 어느 도구의 것인지가 갈린다.
    #[test]
    fn pyproject_sections_declare_each_tool_separately() {
        let world = World::new()
            .file(
                "pyproject.toml",
                "[project]\nname = \"x\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n\n[tool.mypy]\nstrict = true\n",
            )
            .on_path("python3");
        let d = detect(&probe(&world, Platform::Unix));
        let keys: Vec<&str> = d.checks.iter().map(|c| c.key).collect();
        assert_eq!(keys, vec!["test", "typecheck"], "{:?}", d.checks);
        // **선언하지 않은 도구는 만들지 않는다.** ruff 섹션이 없으므로 lint도 없다.
        assert!(!keys.contains(&"lint"));
    }

    /// **주석 처리된 선언을 선언으로 읽지 않는다** — 꺼 둔 도구를 우리가 켜게 된다.
    #[test]
    fn a_commented_out_section_is_not_a_declaration() {
        let world = World::new()
            .file("pyproject.toml", "# [tool.mypy]\n# strict = true\n")
            .on_path("python3");
        let d = detect(&probe(&world, Platform::Unix));
        assert!(d.checks.is_empty(), "{:?}", d.checks);
    }

    /// **워크스페이스 안의 가상환경이 활성화된 환경을 이긴다.** 활성화된 것은 다른 프로젝트의
    /// 것일 수 있고, 우리가 검증하려는 것은 이 워크스페이스다.
    #[test]
    fn the_workspace_venv_wins_over_an_activated_one() {
        let world = World::new()
            .file("pytest.ini", "[pytest]\n")
            .file(".venv/bin/python", "")
            .env("VIRTUAL_ENV", "/somewhere/else");
        let d = detect(&probe(&world, Platform::Unix));
        let i = d.interpreter.expect("인터프리터가 없습니다");
        assert_eq!(i.program, ".venv/bin/python");
        assert_eq!(i.how, How::DotVenv);
        // 워크스페이스 안이라는 사실이 값에 남는다 — 절대경로 변환과 지문이 여기 걸려 있다.
        assert!(i.workspace_relative);
    }

    /// 워크스페이스에 없으면 활성화된 환경을 쓰고, 그 사실을 근거로 남긴다.
    #[test]
    fn an_activated_env_is_used_when_the_workspace_has_none() {
        let world = World::new().file("pytest.ini", "[pytest]\n").env("VIRTUAL_ENV", "/home/u/envs/proj");
        let d = detect(&probe(&world, Platform::Unix));
        let i = d.interpreter.expect("인터프리터가 없습니다");
        assert_eq!(i.program, "/home/u/envs/proj/bin/python");
        assert_eq!(i.how, How::ActivatedEnv);
        // 워크스페이스 밖이다 — 모델이 고칠 수 없고, 그래서 지문 대상도 아니다.
        assert!(!i.workspace_relative);
    }

    /// **PATH는 마지막이고, 그 사실이 값에 남는다.** 가상환경이 아니므로 선언된 도구가
    /// 거기 없을 수 있다.
    #[test]
    fn path_is_the_last_resort_and_says_so() {
        let world = World::new().file("pytest.ini", "[pytest]\n").on_path("python3");
        let d = detect(&probe(&world, Platform::Unix));
        assert_eq!(d.interpreter.as_ref().map(|i| i.how), Some(How::Path));
        let i = d.interpreter.unwrap();
        assert_eq!(i.program, "python3");
        assert!(!i.workspace_relative);
    }

    /// 아무 인터프리터도 없으면 **없다고 말한다.** 지어내면 `program not found`가 검증 실패로
    /// 보고되고, 그 실패는 모델을 고칠 것 없는 문제로 보낸다.
    #[test]
    fn no_interpreter_is_reported_as_none() {
        let world = World::new().file("pytest.ini", "[pytest]\n");
        let d = detect(&probe(&world, Platform::Unix));
        assert_eq!(d.interpreter, None);
        // 선언은 그대로 남는다 — "돌릴 것이 없다"와 "돌릴 수 없다"는 다른 사실이다.
        assert_eq!(d.checks.len(), 1);
    }

    /// **Windows의 가상환경 자리는 다르다.** 이 검사가 Linux에서 도는 것이 요점이다 —
    /// `std::path`로 조립하면 여기서 `C:\venv/Scripts/python.exe`가 나온다(CLAUDE.md).
    #[test]
    fn the_windows_venv_layout_is_built_with_windows_separators() {
        assert_eq!(interpreter_in(".venv", Platform::Windows), ".venv\\Scripts\\python.exe");
        assert_eq!(interpreter_in(".venv", Platform::Unix), ".venv/bin/python");
        // 뒤에 구분자가 붙어 오는 경우(`VIRTUAL_ENV`가 그렇게 오기도 한다).
        assert_eq!(
            interpreter_in("C:\\envs\\proj\\", Platform::Windows),
            "C:\\envs\\proj\\Scripts\\python.exe"
        );
        assert_eq!(interpreter_in("/home/u/env/", Platform::Unix), "/home/u/env/bin/python");
    }

    #[test]
    fn windows_finds_the_venv_interpreter_at_the_windows_path() {
        let world = World::new()
            .file("pytest.ini", "[pytest]\n")
            .file(".venv\\Scripts\\python.exe", "");
        let d = detect(&probe(&world, Platform::Windows));
        assert_eq!(d.interpreter.map(|i| i.how), Some(How::DotVenv));
    }

    /// **Windows에서는 `python3`를 찾지 않는다.** 있어도 Store 별칭이라 실행하면 창이 뜬다.
    #[test]
    fn windows_does_not_look_for_python3_on_path() {
        let world = World::new().file("pytest.ini", "[pytest]\n").on_path("python3");
        let d = detect(&probe(&world, Platform::Windows));
        assert_eq!(d.interpreter, None, "python3를 골랐습니다");
    }

    /// 각 도구의 argv가 그 도구가 요구하는 모양이다.
    #[test]
    fn each_tool_gets_the_arguments_it_needs() {
        let world = World::new()
            .file("pyproject.toml", "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n")
            .on_path("python3");
        let d = detect(&probe(&world, Platform::Unix));
        let by = |key: &str| d.checks.iter().find(|c| c.key == key).expect(key).args.clone();
        assert_eq!(by("test"), vec!["-m", "pytest"]);
        assert_eq!(by("lint"), vec!["-m", "ruff", "check", "."]);
        assert_eq!(by("typecheck"), vec!["-m", "mypy", "."]);
    }

    /// `[tool.ruff.lint]`만 있는 프로젝트도 ruff를 선언한 것이다 — 접두사로 본다.
    #[test]
    fn a_ruff_subsection_still_declares_ruff() {
        let world = World::new().file("pyproject.toml", "[tool.ruff.lint]\nselect = [\"E\"]\n");
        let d = detect(&probe(&world, Platform::Unix));
        assert!(d.checks.iter().any(|c| c.key == "lint"), "{:?}", d.checks);
    }
}
