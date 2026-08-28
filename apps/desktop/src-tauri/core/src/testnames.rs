//! 러너 출력에서 **실패한 테스트 이름**을 뽑는다 — state-machine 54절.
//!
//! # 왜 필요한가 — 체크 단위 귀속이 만드는 거짓말
//!
//! `VerificationRunner`는 "새로 실패한 것"과 "원래 실패하던 것"을 **체크 단위**로 나눈다
//! (build/typecheck/test/lint). 그 단위가 거짓말을 하는 경우가 있고, 하필 흔한 경우다:
//!
//! 저장소에 원래 실패하는 테스트가 하나 있었다고 하자. 이번 변경이 세 개를 더 깨뜨린다.
//! 체크 단위로 보면 `test`는 **baseline에서도 실패했으므로** `preexisting`에 들어가고
//! `newlyFailing`은 비어 있다. 그리고 FIX_LOOP 다이제스트는 모델에게 이렇게 말한다:
//! *"이 체크들은 변경 전에도 실패하고 있었다 — 무관하다면 손대지 말 것."*
//!
//! **모델이 자기 변경으로 깨뜨린 세 테스트를 건드리지 말라고 지시받는다.** 이건 우리가
//! 원칙 1로 세운 것("결정론적 검증이 최종 판정자")을 무디게 만든다 — 판정은 옳은데 그
//! 판정을 읽는 쪽에 틀린 이름표가 붙는다.
//!
//! # 못 뽑은 것과 없는 것을 구별한다
//!
//! 이 모듈의 반환값이 `Option`인 이유다. `None`은 **출력을 해석하지 못했다**이고
//! `Some(빈 집합)`은 **실패한 테스트 이름이 없다**(예: 컴파일 오류로 테스트가 시작조차
//! 못 함)이다. 둘을 뭉개면 파서가 러너를 못 알아본 순간 "새 실패 없음"이 되어, 위의
//! 거짓말이 **더 조용한 모양으로** 돌아온다.
//!
//! # 정규식을 쓰지 않는다
//!
//! 러너 출력은 줄 단위로 규칙적이고, 의존성을 늘릴 값어치가 없다. 대신 각 러너의
//! **실패 줄 모양**을 하나씩 적는다 — 못 알아보면 `None`이고, 그건 정직한 답이다.

use std::collections::BTreeSet;

/// 이 출력에서 실패한 테스트 이름들. `None`이면 **해석하지 못했다**.
///
/// `program`은 러너를 고르는 데 쓴다(argv의 첫 항목). 확장자와 경로는 무시한다 —
/// Windows에서 `npm`이 `npm.cmd`이고 venv 인터프리터는 절대경로다.
pub fn failed_tests(program: &str, args: &[String], declared: Option<&str>, output: &str) -> Option<BTreeSet<String>> {
    match runner_of(program, args, declared)? {
        Runner::Pytest => Some(parse_pytest(output)),
        Runner::Cargo => Some(parse_cargo(output)),
        Runner::Dotnet => Some(parse_dotnet(output)),
        Runner::NodeTest => Some(parse_node_test(output)),
        Runner::Vitest => Some(parse_vitest(output)),
        Runner::Jest => Some(parse_jest(output)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runner {
    Pytest,
    Cargo,
    Dotnet,
    /// `node --test`의 TAP 출력.
    NodeTest,
    Vitest,
    Jest,
}

fn basename(program: &str) -> String {
    let tail = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let stem = tail.strip_suffix(".exe").or_else(|| tail.strip_suffix(".cmd")).unwrap_or(tail);
    stem.to_ascii_lowercase()
}

/// 패키지 매니저를 거쳐 도는 명령의 러너는 **선언 본문에서 유도한다** (55절).
///
/// # 왜 출력 모양으로 추측하지 않는가
///
/// 54.7절이 이 항목을 미뤄 둔 이유가 그것이다: 출력을 보고 러너를 짐작하면, 짐작이 틀렸을 때
/// **무관한 문자열이 테스트 이름이 된다.** 그러면 baseline 대조가 없는 회귀를 보고하고,
/// 그건 "모른다"보다 나쁘다 — 우리가 만든 거짓 신호이기 때문이다.
///
/// 선언 본문은 짐작이 아니다. `package.json`의 `scripts.test`에 `vitest`라고 적혀 있으면
/// 그 프로젝트는 vitest를 돌린다.
///
/// # 첫 토큰만 보지 않는다
///
/// `cross-env CI=1 vitest run`처럼 앞에 래퍼가 붙는 것이 흔하다. 그래서 **토큰 어디에든**
/// 러너 이름이 있으면 인정한다. 대신 둘 이상이 보이면 `None`이다 — `vitest run && jest`
/// 같은 본문에서 한쪽을 고르면 나머지 절반의 실패 이름을 조용히 잃는다.
fn runner_from_declaration(declared: &str) -> Option<Runner> {
    let mut found: Option<Runner> = None;
    for token in declared.split(|c: char| c.is_whitespace() || c == '&' || c == '|' || c == ';') {
        // `./node_modules/.bin/vitest`처럼 경로가 붙을 수 있다.
        let name = basename(token);
        let candidate = match name.as_str() {
            "vitest" => Some(Runner::Vitest),
            "jest" => Some(Runner::Jest),
            "pytest" => Some(Runner::Pytest),
            _ => None,
        };
        // `node --test`는 토큰 둘로 나뉜다.
        let candidate = candidate.or_else(|| {
            if name == "node" && declared.contains("--test") {
                Some(Runner::NodeTest)
            } else {
                None
            }
        });
        let Some(candidate) = candidate else { continue };
        match found {
            None => found = Some(candidate),
            Some(existing) if existing == candidate => {}
            // **둘 이상이면 모른다.** 한쪽을 고르면 나머지의 실패를 조용히 잃는다.
            Some(_) => return None,
        }
    }
    found
}

fn runner_of(program: &str, args: &[String], declared: Option<&str>) -> Option<Runner> {
    let name = basename(program);
    let first = args.first().map(String::as_str).unwrap_or("");
    let second = args.get(1).map(String::as_str).unwrap_or("");
    match name.as_str() {
        "pytest" => Some(Runner::Pytest),
        // `python -m pytest` (49절). `-m` 뒤가 pytest가 아니면 우리가 아는 러너가 아니다.
        "python" | "python3" if first == "-m" && second == "pytest" => Some(Runner::Pytest),
        "cargo" if first == "test" => Some(Runner::Cargo),
        "dotnet" if first == "test" => Some(Runner::Dotnet),
        "node" if args.iter().any(|a| a == "--test") => Some(Runner::NodeTest),
        // **패키지 매니저는 argv로 알 수 없다** — 뒤에 무엇이 도는지는 매니페스트가 정한다.
        // 그래서 여기서만 선언 본문을 본다(55절).
        "npm" | "pnpm" | "yarn" | "bun" => declared.and_then(runner_from_declaration),
        _ => None,
    }
}

/// pytest: `FAILED tests/test_x.py::test_y - AssertionError: ...`
///
/// 짧은 요약 줄(`-q`)과 기본 출력 양쪽에 같은 모양으로 나온다. `ERROR` 줄도 센다 —
/// 수집 단계에서 죽은 테스트도 이번 변경이 깨뜨렸을 수 있고, 빼면 그 실패가 사라진다.
fn parse_pytest(output: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in output.lines() {
        let line = line.trim();
        for prefix in ["FAILED ", "ERROR "] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let name = rest.split(" - ").next().unwrap_or(rest).trim();
                if !name.is_empty() {
                    out.insert(name.to_string());
                }
            }
        }
    }
    out
}

/// cargo test: 실패 목록은 `failures:` 블록 안에 들여쓰여 나온다.
///
/// ```text
/// failures:
///     tests::a_thing_works
///     tests::another
/// ```
///
/// **`test x ... FAILED` 줄을 쓰지 않는 이유**: 그 줄은 실행 순서대로 흩어져 나오고
/// stdout 캡처와 섞인다. `failures:` 블록은 러너가 마지막에 모아 주는 정본이다.
/// 블록은 두 번 나온다(이름 목록과 그 앞의 출력 덤프) — 집합이므로 중복은 접힌다.
fn parse_cargo(output: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut in_block = false;
    for line in output.lines() {
        if line.trim() == "failures:" {
            in_block = true;
            continue;
        }
        if !in_block {
            continue;
        }
        // 들여쓰기가 끝나면 블록이 끝난 것이다. 빈 줄은 블록 안에도 있으므로 넘긴다.
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            in_block = false;
            continue;
        }
        let name = line.trim();
        // `---- name stdout ----` 같은 덤프 머리글은 이름이 아니다.
        if name.starts_with("----") {
            continue;
        }
        out.insert(name.to_string());
    }
    out
}

/// dotnet test: `  Failed Namespace.Class.Method [12 ms]`
///
/// 대괄호의 소요 시간은 이름이 아니므로 떼어낸다 — 남겨 두면 같은 테스트가 실행마다
/// 다른 이름이 되어 baseline 대조가 **언제나 "새 실패"**를 낸다.
fn parse_dotnet(output: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in output.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Failed ") else {
            continue;
        };
        let name = match rest.find(" [") {
            Some(at) => &rest[..at],
            None => rest,
        };
        let name = name.trim();
        // `Failed!  - Failed: 1, Passed: ...` 같은 요약 줄을 이름으로 받지 않는다.
        if name.is_empty() || name.contains(',') || name.starts_with('!') {
            continue;
        }
        out.insert(name.to_string());
    }
    out
}

/// `node --test`의 TAP: `not ok 3 - 이름`
///
/// 하위 테스트도 같은 모양으로 들여쓰여 나오므로 트림하고 받는다. 번호는 실행 순서라
/// **이름에서 뺀다** — 테스트가 하나 추가되면 그 뒤 번호가 전부 밀려서, 남기면 baseline
/// 대조가 무관한 테스트를 "새로 실패"로 보고한다.
fn parse_node_test(output: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in output.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("not ok ") else {
            continue;
        };
        let name = match rest.find(" - ") {
            Some(at) => rest[at + 3..].trim(),
            // `not ok 3` 뒤에 이름이 없으면 번호라도 남긴다 — 이름 없는 실패도 실패다.
            None => rest.trim(),
        };
        if !name.is_empty() {
            out.insert(name.to_string());
        }
    }
    out
}

/// vitest: 실패 요약 블록의 `FAIL  <파일> > <이름>` 줄.
///
/// ```text
///  FAIL  src/a.test.ts > 덧셈 > 두 수를 더한다
/// ```
///
/// **파일 경로를 이름에 남긴다.** 다른 파일의 같은 이름이 한 이름으로 접히면 대조가
/// 무관한 테스트를 "고쳐짐"으로 읽는다 — 이름의 목적은 사람이 읽는 것이 아니라
/// baseline과 대조되는 것이다.
///
/// **파일만 있고 테스트 이름이 없는 줄은 받지 않는다.** vitest는 파일 단위 실패
/// (수집 오류 등)에도 `FAIL  src/a.test.ts`를 내는데, 그걸 테스트 이름으로 세면
/// 같은 파일의 개별 실패와 뒤섞인다.
fn parse_vitest(output: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in output.lines() {
        let line = strip_ansi(line);
        let line = line.trim();
        let Some(rest) = line.strip_prefix("FAIL ") else {
            continue;
        };
        let rest = rest.trim();
        // 테스트 이름이 붙어 있어야 한다.
        if !rest.contains(" > ") {
            continue;
        }
        if !rest.is_empty() {
            out.insert(rest.to_string());
        }
    }
    out
}

/// jest: 실패 상세의 `● <스위트> › <이름>` 줄.
///
/// ```text
///   ● 덧셈 › 두 수를 더한다
/// ```
///
/// **`✕` 줄을 쓰지 않는 이유**: 거기에는 소요 시간이 붙고(`✕ name (3 ms)`), 그건 실행마다
/// 달라져 같은 테스트가 매번 다른 이름이 된다(54.2절이 dotnet에서 막은 것과 같은 함정).
///
/// jest는 훅 실패도 같은 모양으로 내는데(`● Test suite failed to run`) 그것도 실패이므로
/// 뺄 이유가 없다. 다만 요약 블록의 화살표 줄(`● Console`)은 테스트가 아니라 섹션 머리글이라
/// 제외한다.
fn parse_jest(output: &str) -> BTreeSet<String> {
    const SECTIONS: &[&str] = &["Console", "Deprecation Warning", "Validation Warning"];
    let mut out = BTreeSet::new();
    for line in output.lines() {
        let line = strip_ansi(line);
        let line = line.trim();
        let Some(rest) = line.strip_prefix("● ") else {
            continue;
        };
        let name = rest.trim();
        if name.is_empty() || SECTIONS.contains(&name) {
            continue;
        }
        out.insert(name.to_string());
    }
    out
}

/// ANSI 색 코드를 지운다.
///
/// **vitest와 jest만 이게 필요하다.** 둘은 TTY가 아니어도 색을 내는 설정이 흔하고, 색 코드가
/// 이름에 남으면 같은 테스트가 설정에 따라 다른 이름이 된다. 다른 러너는 우리가 쓰는 모양에
/// 색이 끼지 않으므로 부르지 않는다 — 부르면 비용만 든다.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // `ESC [ ... <letter>` 를 통째로 버린다.
        if chars.next() != Some('[') {
            continue;
        }
        for tail in chars.by_ref() {
            if tail.is_ascii_alphabetic() {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// **못 알아본 것과 없는 것을 구별한다.** 뭉개면 파서가 러너를 놓친 순간 "새 실패 없음"이
    /// 되고, 이 모듈이 고치려는 거짓말이 더 조용한 모양으로 돌아온다.
    #[test]
    fn an_unknown_runner_returns_none_not_an_empty_set() {
        assert_eq!(failed_tests("mocha", &args(&[]), None, "not ok 1 - x"), None);
        assert_eq!(failed_tests("npm", &args(&["test"]), None, "FAILED tests/a.py::b"), None);
        // 아는 러너인데 실패가 없으면 **빈 집합**이다 — None이 아니다.
        assert_eq!(failed_tests("pytest", &args(&[]), None, "3 passed"), Some(BTreeSet::new()));
    }

    #[test]
    fn pytest_failures_are_named() {
        let out = "tests/test_a.py .F\n\
                   FAILED tests/test_a.py::test_two - AssertionError: 1 != 2\n\
                   ERROR tests/test_b.py::test_three\n\
                   1 failed, 1 passed";
        let found = failed_tests("pytest", &args(&[]), None, out).unwrap();
        assert!(found.contains("tests/test_a.py::test_two"), "{found:?}");
        assert!(found.contains("tests/test_b.py::test_three"), "{found:?}");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    /// 49절의 가상환경 인터프리터는 **절대경로**로 온다. basename만 보지 않으면 놓친다.
    #[test]
    fn a_venv_interpreter_is_still_pytest() {
        let found = failed_tests(
            "/work/.venv/bin/python",
            &args(&["-m", "pytest"]),
            None,
            "FAILED tests/test_a.py::test_two - boom",
        );
        assert_eq!(found.unwrap().len(), 1);
        // Windows의 `python.exe`도 같다.
        assert!(failed_tests(r"C:\venv\Scripts\python.exe", &args(&["-m", "pytest"]), None, "").is_some());
        // 그러나 `-m pip`은 pytest가 아니다 — 아는 척하지 않는다.
        assert_eq!(failed_tests("python", &args(&["-m", "pip"]), None, "FAILED x"), None);
    }

    #[test]
    fn cargo_failures_come_from_the_failures_block() {
        let out = "running 3 tests\n\
                   test tests::ok_one ... ok\n\
                   test tests::bad_one ... FAILED\n\
                   \n\
                   failures:\n\
                   \n\
                   ---- tests::bad_one stdout ----\n\
                   thread panicked\n\
                   \n\
                   failures:\n\
                   \x20   tests::bad_one\n\
                   \x20   tests::bad_two\n\
                   \n\
                   test result: FAILED. 1 passed; 2 failed";
        let found = failed_tests("cargo", &args(&["test"]), None, out).unwrap();
        assert!(found.contains("tests::bad_one"), "{found:?}");
        assert!(found.contains("tests::bad_two"), "{found:?}");
        // 덤프 머리글은 이름이 아니다.
        assert!(!found.iter().any(|n| n.starts_with("----")), "{found:?}");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    /// **소요 시간을 이름에 남기지 않는다.** 남기면 같은 테스트가 실행마다 다른 이름이 되어
    /// baseline 대조가 언제나 "새 실패"를 낸다 — 그러면 이 기능이 정반대로 거짓말한다.
    #[test]
    fn dotnet_names_do_not_carry_the_duration() {
        let out = "  Failed Acme.Tests.WidgetTests.ItWorks [12 ms]\n\
                   Failed!  - Failed: 1, Passed: 4, Skipped: 0";
        let found = failed_tests("dotnet", &args(&["test"]), None, out).unwrap();
        assert_eq!(found.iter().next().map(String::as_str), Some("Acme.Tests.WidgetTests.ItWorks"));
        assert_eq!(found.len(), 1, "{found:?}");

        let again =
            failed_tests("dotnet", &args(&["test"]), None, "  Failed Acme.Tests.WidgetTests.ItWorks [980 ms]").unwrap();
        assert_eq!(found, again, "소요 시간이 다르면 다른 테스트가 됩니다");
    }

    /// **TAP 번호를 이름에 남기지 않는다.** 테스트를 하나 추가하면 뒤 번호가 전부 밀린다 —
    /// 남기면 무관한 테스트가 "새로 실패"로 보고된다.
    #[test]
    fn tap_numbers_are_not_part_of_the_name() {
        let before = failed_tests("node", &args(&["--test", "a.js"]), None, "not ok 3 - 이름이 있는 검사").unwrap();
        let after = failed_tests("node", &args(&["--test", "a.js"]), None, "not ok 9 - 이름이 있는 검사").unwrap();
        assert_eq!(before, after);
        assert_eq!(before.iter().next().map(String::as_str), Some("이름이 있는 검사"));
    }

    /// **패키지 매니저 뒤의 러너는 선언에서 유도한다** — 55절.
    ///
    /// 출력 모양으로 짐작하지 않는다: 짐작이 틀리면 무관한 문자열이 테스트 이름이 되고,
    /// 그건 "모른다"보다 나쁘다(우리가 만든 거짓 신호이기 때문이다).
    #[test]
    fn a_declaration_picks_the_runner_behind_the_package_manager() {
        let out = " FAIL  src/a.test.ts > 덧셈 > 두 수";
        // 선언이 없으면 모른다 — 종전 그대로.
        assert_eq!(failed_tests("npm", &args(&["test"]), None, out), None);
        // 선언이 있으면 갈린다.
        let found = failed_tests("npm", &args(&["test"]), Some("vitest run"), out).unwrap();
        assert_eq!(found.iter().next().map(String::as_str), Some("src/a.test.ts > 덧셈 > 두 수"));
        // 모르는 러너를 선언하면 여전히 모른다.
        assert_eq!(failed_tests("npm", &args(&["test"]), Some("mocha"), out), None);
    }

    /// **래퍼가 앞에 붙는 것이 흔하다.** 첫 토큰만 보면 `cross-env`에서 멈춘다.
    #[test]
    fn a_wrapper_in_front_does_not_hide_the_runner() {
        for declared in [
            "cross-env CI=1 vitest run",
            "NODE_OPTIONS=--experimental-vm-modules jest",
            "./node_modules/.bin/vitest --run",
        ] {
            assert!(
                failed_tests("npm", &args(&["test"]), Some(declared), "").is_some(),
                "{declared}에서 러너를 찾지 못했습니다"
            );
        }
    }

    /// **둘 이상이 보이면 모른다.** 한쪽을 고르면 나머지의 실패 이름을 조용히 잃는다 —
    /// 그러면 대조가 그 절반을 "고쳐짐"으로 읽는다.
    #[test]
    fn two_runners_in_one_script_means_we_do_not_know() {
        assert_eq!(failed_tests("npm", &args(&["test"]), Some("vitest run && jest"), ""), None);
        // 같은 러너가 두 번 나오는 것은 갈라짐이 아니다.
        assert!(failed_tests("npm", &args(&["test"]), Some("vitest run a && vitest run b"), "").is_some());
    }

    #[test]
    fn vitest_failures_carry_the_file_and_the_name() {
        let out = " ❯ src/a.test.ts (3)\n\
                   \x20FAIL  src/a.test.ts > 덧셈 > 두 수를 더한다\n\
                   \x20FAIL  src/b.test.ts > 뺄셈 > 두 수를 뺀다\n\
                   Tests  2 failed";
        let found = failed_tests("npm", &args(&["test"]), Some("vitest"), out).unwrap();
        assert!(found.contains("src/a.test.ts > 덧셈 > 두 수를 더한다"), "{found:?}");
        assert!(found.contains("src/b.test.ts > 뺄셈 > 두 수를 뺀다"), "{found:?}");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    /// **파일만 있고 테스트 이름이 없는 줄은 받지 않는다.** vitest는 수집 오류에도
    /// `FAIL  <파일>`을 내는데, 그걸 테스트 이름으로 세면 같은 파일의 개별 실패와 뒤섞인다.
    #[test]
    fn a_vitest_file_level_failure_is_not_a_test_name() {
        let out = " FAIL  src/a.test.ts\n FAIL  src/a.test.ts > 덧셈 > 두 수";
        let found = failed_tests("npm", &args(&["test"]), Some("vitest"), out).unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
    }

    #[test]
    fn jest_failures_come_from_the_bullet_lines() {
        let out = "  ● 덧셈 › 두 수를 더한다\n\
                   \x20   expect(received).toBe(expected)\n\
                   \x20 ● Console\n\
                   \x20 ● 뺄셈 › 두 수를 뺀다";
        let found = failed_tests("npm", &args(&["test"]), Some("jest"), out).unwrap();
        assert!(found.contains("덧셈 › 두 수를 더한다"), "{found:?}");
        assert!(found.contains("뺄셈 › 두 수를 뺀다"), "{found:?}");
        // 섹션 머리글은 테스트가 아니다.
        assert!(!found.contains("Console"), "{found:?}");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    /// **소요 시간이 붙는 줄을 쓰지 않는다.** jest의 `✕ name (3 ms)`를 쓰면 같은 테스트가
    /// 실행마다 다른 이름이 되어 대조가 언제나 "새 실패"를 낸다(dotnet에서 막은 것과 같다).
    #[test]
    fn jest_names_do_not_come_from_the_timing_lines() {
        let a = failed_tests("npm", &args(&["test"]), Some("jest"), "    ✕ 두 수를 더한다 (3 ms)\n  ● 덧셈 › 두 수를 더한다").unwrap();
        let b = failed_tests("npm", &args(&["test"]), Some("jest"), "    ✕ 두 수를 더한다 (91 ms)\n  ● 덧셈 › 두 수를 더한다").unwrap();
        assert_eq!(a, b, "소요 시간이 이름에 들어갔습니다");
        assert_eq!(a.len(), 1, "{a:?}");
    }

    /// **색 코드가 이름에 남으면 안 된다.** vitest·jest는 TTY가 아니어도 색을 내는 설정이
    /// 흔하고, 남기면 같은 테스트가 설정에 따라 다른 이름이 된다.
    #[test]
    fn ansi_colours_do_not_become_part_of_the_name() {
        let coloured = "\u{1b}[31m FAIL \u{1b}[0m src/a.test.ts > 덧셈 > 두 수";
        let plain = " FAIL  src/a.test.ts > 덧셈 > 두 수";
        let a = failed_tests("npm", &args(&["test"]), Some("vitest"), coloured).unwrap();
        let b = failed_tests("npm", &args(&["test"]), Some("vitest"), plain).unwrap();
        assert_eq!(a, b, "{a:?} vs {b:?}");
        assert_eq!(a.len(), 1, "{a:?}");
    }

    #[test]
    fn nested_tap_failures_are_counted() {
        let out = "not ok 1 - 바깥\n    not ok 1 - 안쪽\nok 2 - 통과";
        let found = failed_tests("node", &args(&["--test", "a.js"]), None, out).unwrap();
        assert_eq!(found.len(), 2, "{found:?}");
    }
}
