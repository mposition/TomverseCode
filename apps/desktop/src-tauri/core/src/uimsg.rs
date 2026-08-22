//! 화면에 뜨는 문장의 **공통 모양** — ui-wireframes.md 6절.
//!
//! # 규칙
//!
//! > 화면에 그대로 뜨는 문장은 프로세스 경계를 넘지 않는다. **판정과 파라미터가 넘고, 문장은
//! > 화면이 만든다.**
//!
//! 넘어온 문장은 영원히 한국어다. 다국어 카탈로그를 만들어도 그 문장은 **카탈로그 밖에
//! 남고**, 언어를 바꾸면 절반만 바뀐다. 반쪽 번역은 사용자가 "어느 문장이 왜 안 바뀌었는가"를
//! 알 수 없게 만들므로 번역이 없는 것보다 나쁘다.
//!
//! # 왜 봉투를 공통으로 두는가
//!
//! 경계마다 자기 모양을 만들면 화면에 렌더러가 여러 개 생기고, 카탈로그도 갈라진다. 그러면
//! **"이 코드가 카탈로그에 있는가"를 한 번에 확인할 수 없다** — 확인할 수 없는 규칙은 지켜지지
//! 않는다. 그래서 모든 경계가 같은 `{code, params, message}`를 낸다.
//!
//! # `message`는 기본값이 아니라 대체 표시다
//!
//! 화면이 그 코드를 아직 모를 때만 쓴다. 빈 문장을 그리는 것보다 번역되지 않은 원문을 그리는
//! 편이 낫다 — **반쪽 번역과 빈 화면 중에서는 반쪽 번역이 낫다.**
//!
//! # 무엇이 대상이 아닌가
//!
//! **진단 출력은 아니다.** stderr 로그, `launcher::describe_failure`처럼 개발자가 읽는 설명,
//! 그리고 `tomverse-host reproduce` 같은 CLI의 JSON 판정은 화면에 그대로 뜨지 않는다.
//! 대상을 "사용자에게 도움이 되는 모든 문자열"로 넓히면 규칙이 지킬 수 없는 크기가 된다.

use serde_json::Value;

/// 화면으로 나가는 봉투.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UiMessage {
    /// 화면이 문장을 고르는 열쇠. **바뀌면 카탈로그도 바뀌어야 한다.**
    pub code: String,
    /// 문장에 끼울 값들. **이어 붙이지 않는다** — 이미 이어 붙인 문장은 어순이 다른 언어로
    /// 옮길 수 없다.
    pub params: Value,
    /// 원문(한국어). 화면이 코드를 모를 때의 대체 표시.
    pub message: String,
}

/// 화면에 뜨는 문제를 나타내는 타입이 구현한다.
pub trait UserFacing {
    fn code(&self) -> &'static str;
    fn params(&self) -> Value;
    fn korean(&self) -> String;

    fn ui(&self) -> UiMessage {
        UiMessage {
            code: self.code().to_string(),
            params: self.params(),
            message: self.korean(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Sample;
    impl UserFacing for Sample {
        fn code(&self) -> &'static str {
            "sample"
        }
        fn params(&self) -> Value {
            json!({ "n": 3 })
        }
        fn korean(&self) -> String {
            "값은 3입니다".to_string()
        }
    }

    /// 봉투는 셋을 **전부** 담는다. 하나라도 빠지면 화면이 그 경계만 다르게 다뤄야 한다.
    #[test]
    fn the_envelope_carries_code_params_and_fallback() {
        let ui = Sample.ui();
        assert_eq!(ui.code, "sample");
        assert_eq!(ui.params["n"], json!(3));
        assert_eq!(ui.message, "값은 3입니다");
    }

    /// 직렬화 이름이 화면의 계약이다 — 바꾸면 화면이 조용히 못 읽는다.
    #[test]
    fn the_serialized_shape_is_the_contract() {
        let value = serde_json::to_value(Sample.ui()).unwrap();
        for key in ["code", "params", "message"] {
            assert!(value.get(key).is_some(), "{key}가 빠졌습니다: {value}");
        }
    }
}
