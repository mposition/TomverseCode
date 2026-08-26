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
pub fn failed_tests(program: &str, args: &[String], output: &str) -> Option<BTreeSet<String>> {
    match runner_of(program, args)? {
        Runner::Pytest => Some(parse_pytest(output)),
        Runner::Cargo => Some(parse_cargo(output)),
        Runner::Dotnet => Some(parse_dotnet(output)),
        Runner::NodeTest => Some(parse_node_test(output)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runner {
    Pytest,
    Cargo,
    Dotnet,
    /// `node --test`의 TAP 출력. vitest·jest도 `not ok` 줄을 내지 않으므로 여기 해당하지 않는다 —
    /// 그건 아래 "아직 하지 않은 것"이다.
    NodeTest,
}

fn basename(program: &str) -> String {
    let tail = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let stem = tail.strip_suffix(".exe").or_else(|| tail.strip_suffix(".cmd")).unwrap_or(tail);
    stem.to_ascii_lowercase()
}

fn runner_of(program: &str, args: &[String]) -> Option<Runner> {
    let name = basename(program);
    let first = args.first().map(String::as_str).unwrap_or("");
    let second = args.get(1).map(String::as_str).unwrap_or("");
    match name.as_str() {
        "pytest" => Some(Runner::Pytest),
        // `python -m pytest` (49절). `-m` 뒤가 pytest가 아니면 우리가 아는 러너가 아니다.
        "python" | "python3" if first == "-m" && second == "pytest" => Some(Runner::Pytest),
        "cargo" if first == "test" => Some(Runner::Cargo),
        "dotnet" if first == "test" => Some(Runner::Dotnet),
        // `node --test ...`. **`npm test`는 여기 오지 않는다** — 그 뒤에 무엇이 도는지는
        // 매니페스트가 정하므로 argv만 보고는 알 수 없다(아래 `NODE_VIA_NPM` 참조).
        "node" if args.iter().any(|a| a == "--test") => Some(Runner::NodeTest),
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
        assert_eq!(failed_tests("mocha", &args(&[]), "not ok 1 - x"), None);
        assert_eq!(failed_tests("npm", &args(&["test"]), "FAILED tests/a.py::b"), None);
        // 아는 러너인데 실패가 없으면 **빈 집합**이다 — None이 아니다.
        assert_eq!(failed_tests("pytest", &args(&[]), "3 passed"), Some(BTreeSet::new()));
    }

    #[test]
    fn pytest_failures_are_named() {
        let out = "tests/test_a.py .F\n\
                   FAILED tests/test_a.py::test_two - AssertionError: 1 != 2\n\
                   ERROR tests/test_b.py::test_three\n\
                   1 failed, 1 passed";
        let found = failed_tests("pytest", &args(&[]), out).unwrap();
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
            "FAILED tests/test_a.py::test_two - boom",
        );
        assert_eq!(found.unwrap().len(), 1);
        // Windows의 `python.exe`도 같다.
        assert!(failed_tests(r"C:\venv\Scripts\python.exe", &args(&["-m", "pytest"]), "").is_some());
        // 그러나 `-m pip`은 pytest가 아니다 — 아는 척하지 않는다.
        assert_eq!(failed_tests("python", &args(&["-m", "pip"]), "FAILED x"), None);
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
        let found = failed_tests("cargo", &args(&["test"]), out).unwrap();
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
        let found = failed_tests("dotnet", &args(&["test"]), out).unwrap();
        assert_eq!(found.iter().next().map(String::as_str), Some("Acme.Tests.WidgetTests.ItWorks"));
        assert_eq!(found.len(), 1, "{found:?}");

        let again = failed_tests("dotnet", &args(&["test"]), "  Failed Acme.Tests.WidgetTests.ItWorks [980 ms]").unwrap();
        assert_eq!(found, again, "소요 시간이 다르면 다른 테스트가 됩니다");
    }

    /// **TAP 번호를 이름에 남기지 않는다.** 테스트를 하나 추가하면 뒤 번호가 전부 밀린다 —
    /// 남기면 무관한 테스트가 "새로 실패"로 보고된다.
    #[test]
    fn tap_numbers_are_not_part_of_the_name() {
        let before = failed_tests("node", &args(&["--test", "a.js"]), "not ok 3 - 이름이 있는 검사").unwrap();
        let after = failed_tests("node", &args(&["--test", "a.js"]), "not ok 9 - 이름이 있는 검사").unwrap();
        assert_eq!(before, after);
        assert_eq!(before.iter().next().map(String::as_str), Some("이름이 있는 검사"));
    }

    #[test]
    fn nested_tap_failures_are_counted() {
        let out = "not ok 1 - 바깥\n    not ok 1 - 안쪽\nok 2 - 통과";
        let found = failed_tests("node", &args(&["--test", "a.js"]), out).unwrap();
        assert_eq!(found.len(), 2, "{found:?}");
    }
}
