//! 예산 상한 인자의 해석 — **"말하지 않은 것"과 "상한 없음"을 구별한다.**
//!
//! 강제 자체는 Node가 한다(공급자 HTTP 호출을 Node가 하므로). 여기서 하는 일은 화면이 보낸
//! 인자를 태스크 정책으로 옮기기 전에 검증하는 것이고, 그 검증의 요점은 하나다:
//! **인자를 빠뜨린 UI가 상한을 조용히 끄지 못하게 한다.**
//!
//! `Option<f64>` 하나로 받으면 `null`이 "상한 없음"인지 "화면이 안 보냈다"인지 알 수 없다.
//! 둘의 차이는 사용자 돈이므로, 없는 것을 "없음의 선택"으로 읽지 않고 거부한다.

/// 화면이 보낸 두 인자를 태스크 정책의 상한으로 바꾼다.
///
/// `Ok(None)`은 **사용자가 상한 없음을 골랐다**는 뜻이다. 인자가 없어서 모르는 경우는
/// `Err`이고, 그때 태스크는 시작되지 않는다.
pub fn resolve_budget(usd: Option<f64>, unlimited: Option<bool>) -> Result<Option<f64>, String> {
    match (usd, unlimited.unwrap_or(false)) {
        (Some(_), true) => {
            Err("예산 상한 값과 '상한 없음'이 함께 왔습니다 — 어느 쪽이 사용자의 선택인지 알 수 없습니다".to_string())
        }
        (Some(value), false) => {
            if !value.is_finite() || value <= 0.0 {
                return Err(format!("예산 상한은 0보다 큰 유한한 수여야 합니다 (받은 값: {value})"));
            }
            Ok(Some(value))
        }
        (None, true) => Ok(None),
        (None, false) => {
            Err("예산 상한이 지정되지 않았습니다. 상한 값을 보내거나 '상한 없음'을 명시해야 합니다".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **인자를 빠뜨린 화면이 상한을 끄면 안 된다.** 이 한 줄이 이 모듈의 존재 이유다.
    #[test]
    fn a_missing_argument_is_an_error_not_unlimited() {
        assert!(resolve_budget(None, None).is_err());
        assert!(resolve_budget(None, Some(false)).is_err());
    }

    /// 상한 없음은 **명시적으로만** 성립한다.
    #[test]
    fn unlimited_must_be_stated() {
        assert_eq!(resolve_budget(None, Some(true)).unwrap(), None);
    }

    /// 둘 다 오면 사용자의 선택을 알 수 없다 — 한쪽을 골라 진행하면 그 선택은 우리의 것이다.
    #[test]
    fn both_at_once_is_ambiguous_and_refused() {
        assert!(resolve_budget(Some(5.0), Some(true)).is_err());
    }

    /// 0·음수·NaN은 첫 호출 전에 걸러야 한다. 태스크가 한참 돈 뒤에 죽으면 원인이 보이지 않는다.
    #[test]
    fn a_nonsensical_limit_is_refused_before_the_task_starts() {
        assert!(resolve_budget(Some(0.0), None).is_err());
        assert!(resolve_budget(Some(-1.0), None).is_err());
        assert!(resolve_budget(Some(f64::NAN), None).is_err());
        assert!(resolve_budget(Some(f64::INFINITY), None).is_err());
        assert_eq!(resolve_budget(Some(2.5), None).unwrap(), Some(2.5));
    }
}
