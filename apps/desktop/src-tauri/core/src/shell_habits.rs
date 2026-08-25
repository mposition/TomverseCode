//! 모델의 **셸 습관**을 원인과 가까운 곳에서 말한다 — product-strategy 12.3③, state-machine 41절.
//!
//! # 무엇이 문제인가
//!
//! 12.3③이 이 제품의 Windows 해자 셋 중 하나로 적어둔 것: **모델의 prior가 Unix로 기울어
//! 있다.** 학습 데이터가 그렇다. 그래서 모델은 두 가지를 자연스럽게 한다.
//!
//! - `ls`·`cat`·`grep`·`rm`을 요청한다. Windows에는 대개 없다.
//! - `&&`로 명령을 잇는다. 우리는 **셸을 쓰지 않으므로**(원칙 6) 그건 인자로 전달된다.
//!
//! 둘 다 지금은 **원인과 먼 실패**가 된다. 앞은 `program not found`이고, 뒤는 프로그램이
//! 이상한 인자를 받아 내는 알 수 없는 오류다. 모델은 그 실패에서 배울 것이 없으므로 같은
//! 모양을 다시 시도하고, `toolRetries` 상한을 태운다.
//!
//! # 이 메시지의 주 독자는 사용자가 아니라 **모델**이다
//!
//! 도구 실패는 프롬프트로 돌아간다. 그래서 여기서 만드는 문장은 "무엇이 잘못됐다"에서 끝나지
//! 않고 **"대신 무엇을 하라"**로 간다 — 12.3③이 말한 "구조적 교정"의 실체가 그것이다.
//!
//! 그리고 권하는 대체는 전부 **우리 도구 집합 안**이다. 셸로 파일을 지우는 것보다 `delete_file`이
//! 낫다: 게이트가 경로를 알고, 승인 화면이 무엇이 지워지는지 보여주며, 롤백이 그 변경을 안다.
//! 즉 이 교정은 Windows 교정이면서 동시에 **보안·감사 이득**이다.
//!
//! # 우리는 사용자의 환경을 이기지 않는다
//!
//! `ls`가 PATH에 실제로 있으면(Git for Windows의 `usr/bin`이 PATH에 있는 머신이 그렇다)
//! 그대로 실행된다. 이 안내는 **해석이 실패한 뒤에만** 나온다 — `msvc.rs`가 준비 실패에도
//! 명령을 막지 않는 것과 같은 판단이다.

/// 셸 습관 하나와 그 처방.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    /// 무엇을 본 것인가 (기록·테스트가 이 값으로 분기한다).
    pub habit: &'static str,
    /// 모델에게 줄 문장.
    pub message: String,
}

/// Unix 명령 → 같은 일을 하는 **우리 도구**.
///
/// # 목록의 판정 기준
///
/// 오른쪽은 전부 `ToolName`에 실재하는 도구여야 한다. 없는 도구를 권하면 모델이 그것을
/// 요청하고 게이트가 거부한다 — 도우려던 것이 새 실패를 만든다. 그래서 테스트가 이 목록을
/// **`ToolName`에서 유도해** 대조한다.
///
/// # 여기 없는 것들
///
/// `mv`·`cp`·`chmod`·`ps`·`curl`은 대응하는 도구가 없다. **없는 대안을 지어내지 않는다** —
/// 그 경우 모델이 받는 것은 "PATH에서 못 찾았다"라는 사실 그대로이고, 그게 정확하다.
const ALTERNATIVES: &[(&str, &str, &str)] = &[
    ("ls", "list_files", "디렉터리 목록"),
    ("dir", "list_files", "디렉터리 목록"),
    ("find", "list_files", "파일 찾기"),
    ("cat", "read_file", "파일 내용 읽기"),
    ("head", "read_file", "파일 내용 읽기"),
    ("tail", "read_file", "파일 내용 읽기"),
    ("less", "read_file", "파일 내용 읽기"),
    ("grep", "search_text", "내용 검색"),
    ("rg", "search_text", "내용 검색"),
    ("ack", "search_text", "내용 검색"),
    ("rm", "delete_file", "파일 삭제"),
    ("del", "delete_file", "파일 삭제"),
    ("touch", "create_file", "파일 만들기"),
    ("sed", "apply_patch", "파일 수정"),
    ("awk", "apply_patch", "파일 수정"),
    ("diff", "git_diff", "변경 비교"),
];

/// 이 프로그램을 못 찾았을 때, 대신 권할 도구가 있는가.
///
/// **경로와 확장자를 벗겨서 본다** — 모델이 `/usr/bin/ls`를 적을 수도 있다.
pub fn alternative_for(program: &str) -> Option<Advice> {
    let base = crate::policy::command::program_basename(program).to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    let (_, tool, what) = ALTERNATIVES.iter().find(|(name, _, _)| *name == base)?;
    Some(Advice {
        habit: "unix_command",
        message: format!(
            "이 플랫폼에는 {base}이(가) 없습니다. 같은 일을 하는 도구가 있습니다: \
             {what}은(는) `{tool}` 도구로 요청하세요 — 셸을 거치지 않으므로 경로가 \
             워크스페이스 안인지 검사되고, 변경은 되돌릴 수 있습니다."
        ),
    })
}

/// argv 안에 **셸 연산자**가 독립 토큰으로 들어왔는가.
///
/// # `&&`와 `||`만 본다
///
/// 다른 메타문자는 정당한 인자일 수 있고, **거짓 양성이 이 검사에서 가장 비싼 실패다** —
/// 되는 명령을 막으면 사용자는 우리가 고장 났다고 읽는다.
///
/// - `;`는 `find . -exec cmd {} \;`에서 **인자로** 온다.
/// - `|`는 `awk -F '|'`·`cut -d '|'`에서 구분자 값이다.
/// - `>`는 값으로 쓰는 CLI가 있다.
///
/// `&&`/`||`가 독립 인자로 오는 정당한 경우는 찾지 못했다. 못 찾았다는 것이 없다는 증거는
/// 아니므로, **판정을 이 둘로 좁히고 나머지는 보지 않는다**(41.3절).
pub fn chaining_in(args: &[String]) -> Option<Advice> {
    let at = args.iter().position(|a| a == "&&" || a == "||")?;
    Some(Advice {
        habit: "shell_chaining",
        message: format!(
            "인자 {at}번이 셸 연산자({})입니다. 이 실행기는 셸을 쓰지 않으므로(승인 화면에 보인 \
             argv가 그대로 실행됩니다) 그 토큰은 프로그램에 **문자 그대로** 전달됩니다. \
             명령을 나눠서 한 번에 하나씩 요청하세요.",
            args[at]
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolName;

    /// **권하는 도구가 실재해야 한다.** 없는 도구를 권하면 모델이 그것을 요청하고 게이트가
    /// 거부한다 — 도우려던 것이 새 실패를 만든다. 판정 기준을 손으로 적지 않고 `ToolName`에서
    /// 유도한다.
    #[test]
    fn every_alternative_is_a_tool_we_actually_have() {
        let known: Vec<&str> = [
            ToolName::ListFiles,
            ToolName::SearchText,
            ToolName::ReadFile,
            ToolName::ApplyPatch,
            ToolName::CreateFile,
            ToolName::DeleteFile,
            ToolName::RunCommand,
            ToolName::GitStatus,
            ToolName::GitDiff,
            ToolName::RunTests,
            ToolName::McpCall,
            ToolName::GitPush,
        ]
        .iter()
        .map(|t| t.as_str())
        .collect();

        assert!(ALTERNATIVES.len() >= 10, "목록이 비었습니다");
        for (unix, tool, _) in ALTERNATIVES {
            assert!(known.contains(tool), "{unix} → {tool}: 그런 도구가 없습니다");
        }
    }

    /// 위 목록이 `ToolName`의 **전부**를 훑는지 확인한다 — 하나라도 빠지면 위 검사가
    /// "없는 도구"를 통과시킬 수 있다.
    #[test]
    fn the_known_tool_list_is_complete() {
        // 새 도구가 생기면 여기가 먼저 깨진다. 개수를 적는 것이 아니라 **as_str가 전부
        // 다른 값을 내는지**로 확인한다 — 개수만 세면 오타 난 복제가 통과한다.
        let names = [
            ToolName::ListFiles.as_str(),
            ToolName::SearchText.as_str(),
            ToolName::ReadFile.as_str(),
            ToolName::ApplyPatch.as_str(),
            ToolName::CreateFile.as_str(),
            ToolName::DeleteFile.as_str(),
            ToolName::RunCommand.as_str(),
            ToolName::GitStatus.as_str(),
            ToolName::GitDiff.as_str(),
            ToolName::RunTests.as_str(),
            ToolName::McpCall.as_str(),
            ToolName::GitPush.as_str(),
        ];
        let unique: std::collections::BTreeSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len(), "도구 이름이 겹칩니다: {names:?}");
    }

    #[test]
    fn unix_commands_get_the_tool_that_does_the_same_thing() {
        let advice = alternative_for("ls").expect("ls에 대한 안내가 없습니다");
        assert!(advice.message.contains("list_files"), "{}", advice.message);
        // 경로와 확장자를 벗겨서 본다 — 모델이 `/usr/bin/ls`를 적을 수도 있다.
        assert!(alternative_for("/usr/bin/ls").is_some());
        assert!(alternative_for("GREP.EXE").is_some());
    }

    /// **없는 대안을 지어내지 않는다.** 대응 도구가 없으면 안내도 없고, 모델이 받는 것은
    /// "PATH에서 못 찾았다"라는 사실 그대로다.
    #[test]
    fn commands_without_an_equivalent_get_no_invented_advice() {
        for program in ["mv", "cp", "chmod", "curl", "ps", "sudo", "make"] {
            assert!(alternative_for(program).is_none(), "{program}에 없는 대안을 권했습니다");
        }
        // 우리 도구로 도는 정상 명령에도 붙지 않는다.
        assert!(alternative_for("npm").is_none());
        assert!(alternative_for("cargo").is_none());
    }

    /// 모델에게 **무엇을 하라**까지 말한다 — "잘못됐다"에서 끝나면 배울 것이 없다.
    #[test]
    fn the_message_tells_the_model_what_to_do_instead() {
        let advice = alternative_for("rm").unwrap();
        assert!(advice.message.contains("delete_file"), "{}", advice.message);
        assert!(advice.message.contains("요청하세요"), "{}", advice.message);
    }

    #[test]
    fn chaining_is_caught_with_its_position() {
        let args: Vec<String> = ["test", "&&", "npm", "run", "lint"].iter().map(|s| s.to_string()).collect();
        let advice = chaining_in(&args).expect("체이닝을 잡지 못했습니다");
        assert_eq!(advice.habit, "shell_chaining");
        assert!(advice.message.contains('1'), "{}", advice.message);
        assert!(advice.message.contains("나눠서"), "{}", advice.message);
    }

    /// **거짓 양성이 이 검사에서 가장 비싼 실패다.** 되는 명령을 막으면 사용자는 우리가 고장
    /// 났다고 읽는다 — 그래서 정당한 인자로 오는 메타문자는 보지 않는다.
    #[test]
    fn legitimate_arguments_are_not_mistaken_for_shell_syntax() {
        let cases: Vec<Vec<&str>> = vec![
            // find는 `;`를 인자로 받는다.
            vec![".", "-name", "*.ts", "-exec", "wc", "-l", "{}", ";"],
            // awk/cut은 `|`를 구분자 값으로 받는다.
            vec!["-F", "|", "{print $1}"],
            // 커밋 메시지 안의 `&&`는 문자열의 일부다.
            vec!["commit", "-m", "fix: a && b"],
            vec!["-e", "console.log(1 > 2)"],
        ];
        for case in cases {
            let args: Vec<String> = case.iter().map(|s| s.to_string()).collect();
            assert!(chaining_in(&args).is_none(), "{case:?}를 셸 문법으로 오인했습니다");
        }
    }

    #[test]
    fn ordinary_arguments_are_quiet() {
        let args: Vec<String> = ["run", "build"].iter().map(|s| s.to_string()).collect();
        assert!(chaining_in(&args).is_none());
        assert!(chaining_in(&[]).is_none());
    }
}
