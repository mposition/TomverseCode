//! 파일 도구가 실패한 **이유**를 우리가 아는 만큼만 말한다 —
//! docs/design/product-strategy.md 12.4절, state-machine 65절.
//!
//! # 왜 필요한가
//!
//! 쓰기가 실패하면 지금까지 남는 것은 OS의 문장 하나였다. Windows에서 그 문장은 이렇다:
//! *"다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스할 수 없습니다. (os error 32)"*
//! — 사용자에게는 도구가 고장 난 것으로 읽히고, 모델에게는 **다시 해 보라는 뜻으로 읽힌다.**
//!
//! 그리고 실제로 다시 한다: 오케스트레이터가 `toolRetries`만큼 재시도한다. 그 재시도에는
//! 근거가 있었다 — 주석에 *"파일 락 같은 일시적 원인이 있을 수 있어 짧게 기다린다"*고
//! 적혀 있다. 맞는 말이지만 **모든 실패에 대해 참은 아니다.** 경로가 길어서 실패한 쓰기는
//! 2.2초를 기다린 뒤에도 같은 이유로 실패한다.
//!
//! # 문자열로 판정하지 않는다
//!
//! 위 문장은 **한국어 Windows의 것**이다. 영어 로케일에서는 다른 문장이 오고, 그 사실은
//! 개발자의 기계에서 드러나지 않는다 — 우리가 영어로 개발했다면 한국어 사용자에게서만
//! 판정이 사라진다. OS 오류 메시지는 번역되므로 **코드로 판정한다.**
//!
//! 이식성 있게 판정되는 것은 `ErrorKind`로 본다(권한). 그렇지 않은 것만 원시 코드를 쓴다.
//!
//! # 같은 숫자가 플랫폼마다 다른 뜻이다
//!
//! `raw_os_error() == Some(32)`는 Windows에서 `ERROR_SHARING_VIOLATION`(다른 프로세스가
//! 열고 있음)이고 **Linux에서는 `EPIPE`**(끊긴 파이프)다. 플랫폼을 보지 않고 숫자만 보면
//! Linux에서 엉뚱한 처방이 나간다.
//!
//! 그래서 `Platform`을 **인자로 받는다.** `msvc.rs`가 같은 규율을 쓴다 — 바깥 세계를 인자로
//! 받으면 Windows 분기를 Linux에서 값으로 검증할 수 있다. 다만 **판정 로직이 여기서
//! 검증된다는 것과 그 동작이 Windows에서 확인됐다는 것은 다른 사실이고**, 후자는
//! `landing.rs`의 착지 검사로 남는다.

use crate::tools::program::Platform;
use serde::{Deserialize, Serialize};

/// 우리가 **구별할 수 있는** 실패 원인.
///
/// 값이지 문장이 아니다 — 소비자가 산문을 파싱하게 만들면 문구를 다듬는 순간 분기가 조용히
/// 바뀐다(`DenialKind`를 따로 둔 것과 같은 이유).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileFailureKind {
    /// 다른 프로세스가 그 파일을 열고 있다.
    Locked,
    /// 경로가 이 시스템이 다룰 수 있는 길이를 넘었다.
    PathTooLong,
    /// 쓸 권한이 없다. **왜인지는 모른다** — 읽기 전용 속성, 폴더 권한, 백신이 다 이 코드를 낸다.
    PermissionDenied,
}

/// 실패 하나에 대해 우리가 말할 수 있는 것.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFailure {
    pub kind: FileFailureKind,
    /// 무슨 일이 일어났는가. **모델이 읽는 자리다.**
    pub fact: String,
    /// 사람이 해 볼 수 있는 일. **우리가 모르는 것은 모른다고 적는다.**
    #[serde(rename = "tryThis")]
    pub try_this: String,
    /// 기다렸다 다시 하면 달라질 수 있는가.
    ///
    /// **재시도 상한을 늘리는 값이 아니다**(원칙 5). `false`일 때 상한을 기다리지 않고
    /// 일찍 끝내기 위한 값이다 — 좁히는 방향으로만 쓴다.
    pub retryable: bool,
}

/// Windows 오류 코드. `windows-sys`를 끌어오지 않는 이유는 이 판정이 **Linux에서도 돌아야**
/// 하기 때문이다 — 상수를 여기 적고 그 뜻을 주석에 남긴다.
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
const ERROR_FILENAME_EXCED_RANGE: i32 = 206;
/// Unix `ENAMETOOLONG`.
const ENAMETOOLONG: i32 = 36;
/// Unix `EACCES` / `EPERM`.
const EACCES: i32 = 13;
const EPERM: i32 = 1;

/// 실패의 원인을 **아는 만큼만** 말한다. 모르면 `None`이다.
///
/// `None`은 "문제가 없다"가 아니라 **"우리가 이 실패에 대해 더 말할 것이 없다"**이다.
/// 없는 처방을 지어내면 사용자는 그걸 따라 하다가 시간을 쓰고, 그 다음부터는 우리 처방을
/// 읽지 않는다.
pub fn diagnose(platform: Platform, target: &str, err: &std::io::Error) -> Option<FileFailure> {
    let code = err.raw_os_error();

    // **경로 길이가 먼저다.** Windows는 긴 경로에 대해 `ERROR_ACCESS_DENIED`를 내는 경우도
    // 있어서, 권한 판정을 먼저 하면 "권한이 없습니다"라는 틀린 처방이 나간다.
    let too_long = match platform {
        Platform::Windows => code == Some(ERROR_FILENAME_EXCED_RANGE),
        Platform::Unix => code == Some(ENAMETOOLONG),
    };
    if too_long {
        return Some(FileFailure {
            kind: FileFailureKind::PathTooLong,
            fact: format!("경로가 이 시스템에서 다룰 수 있는 길이를 넘어 쓰지 못했습니다: {target}"),
            try_this: match platform {
                Platform::Windows =>
                    "저장소를 더 짧은 경로로 옮기거나 Windows의 긴 경로 지원을 켜세요. 재시도해도 같은 결과입니다."
                        .to_string(),
                Platform::Unix => "더 짧은 경로로 옮기세요. 재시도해도 같은 결과입니다.".to_string(),
            },
            retryable: false,
        });
    }

    // **잠김은 Windows에만 있다.** 같은 숫자가 Linux에서는 `EPIPE`이므로, 여기서 플랫폼을
    // 보지 않으면 끊긴 파이프에 "편집기를 닫으세요"라는 처방이 붙는다.
    if platform == Platform::Windows && matches!(code, Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION)) {
        return Some(FileFailure {
            kind: FileFailureKind::Locked,
            fact: format!("다른 프로세스가 이 파일을 열고 있어 쓰지 못했습니다: {target}"),
            // **어느 프로세스인지는 모른다.** 알려면 Restart Manager를 불러야 하고 지금은
            // 부르지 않는다. 모르는 것을 지어내지 않는다 — "메모장을 닫으세요"는 틀릴 수 있다.
            try_this: "이 파일을 열고 있는 편집기나 실행 중인 프로그램을 닫고 다시 시도하세요. \
                       어느 프로세스가 잡고 있는지는 우리가 알지 못합니다."
                .to_string(),
            // 다른 프로세스가 놓을 수 있으므로 짧게 기다렸다 다시 해 볼 값어치가 있다.
            retryable: true,
        });
    }

    // 권한. **`ErrorKind`만 보지 않는다.**
    //
    // 처음에는 `ErrorKind::PermissionDenied` 하나로 충분하다고 적었다 — 두 플랫폼 모두
    // 이식성 있게 매핑되므로. 그런데 그 매핑을 하는 것은 **인자로 받은 플랫폼이 아니라
    // 지금 도는 OS**다. 그래서 Linux에서 Windows의 5번을 만들면 `ErrorKind`는 `Uncategorized`고
    // (5는 Linux에서 `EIO`다) 판정이 사라진다 — 이 모듈의 전제("인자만으로 판정한다")가
    // 절반만 참이 되고, Windows 분기를 여기서 검증할 수 없게 된다. 검사가 그것을 잡았다.
    //
    // 그래서 **둘 다** 본다: 실제 실행에서는 `ErrorKind`가 맞고, 인자로 재구성한 오류에서는
    // 코드가 맞는다.
    let denied_code = match platform {
        Platform::Windows => code == Some(ERROR_ACCESS_DENIED),
        Platform::Unix => matches!(code, Some(EACCES) | Some(EPERM)),
    };
    if denied_code || err.kind() == std::io::ErrorKind::PermissionDenied {
        return Some(FileFailure {
            kind: FileFailureKind::PermissionDenied,
            fact: format!("쓰기 권한이 없습니다: {target}"),
            try_this: match platform {
                // **후보를 나열하되 단정하지 않는다.** 셋 다 같은 코드를 내므로 우리는
                // 어느 것인지 판정하지 못한다.
                Platform::Windows => "읽기 전용 속성, 폴더 권한, 백신의 실시간 검사 중 하나일 수 있습니다 — \
                                      어느 것인지는 우리가 판정하지 못합니다. 재시도해도 같은 결과입니다."
                    .to_string(),
                Platform::Unix => "파일이나 상위 폴더의 권한을 확인하세요. 재시도해도 같은 결과입니다.".to_string(),
            },
            retryable: false,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(code: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code)
    }

    /// **같은 숫자가 플랫폼마다 다른 뜻이다.** 32는 Windows에서 공유 위반이고 Linux에서
    /// `EPIPE`다 — 플랫폼을 보지 않으면 끊긴 파이프에 "편집기를 닫으세요"가 붙는다.
    #[test]
    fn the_same_code_means_different_things_on_each_platform() {
        let windows = diagnose(Platform::Windows, "src/app.ts", &os(ERROR_SHARING_VIOLATION));
        assert_eq!(windows.as_ref().map(|f| f.kind), Some(FileFailureKind::Locked), "{windows:?}");

        // Linux에서 32는 EPIPE다. **처방이 없어야 한다** — 없는 처방을 지어내면 사용자는
        // 그걸 따라 하다가 시간을 쓰고, 그 다음부터 우리 처방을 읽지 않는다.
        let unix = diagnose(Platform::Unix, "src/app.ts", &os(ERROR_SHARING_VIOLATION));
        assert_eq!(unix, None, "{unix:?}");
    }

    /// **잠김만 재시도할 값어치가 있다.** 다른 둘은 기다려도 같다.
    #[test]
    fn only_a_lock_is_worth_retrying() {
        let locked = diagnose(Platform::Windows, "a.ts", &os(ERROR_LOCK_VIOLATION)).expect("잠김 판정이 없습니다");
        assert!(locked.retryable, "{locked:?}");

        for code in [ERROR_FILENAME_EXCED_RANGE, ERROR_ACCESS_DENIED] {
            let f = diagnose(Platform::Windows, "a.ts", &os(code)).expect("판정이 없습니다");
            assert!(!f.retryable, "{code}: {f:?}");
        }
    }

    /// **경로 길이를 권한보다 먼저 본다.** Windows는 긴 경로에 대해 접근 거부를 내는 경우가
    /// 있어서, 순서가 뒤집히면 "권한이 없습니다"라는 틀린 처방이 나간다.
    #[test]
    fn a_long_path_is_not_reported_as_a_permission_problem() {
        let f = diagnose(Platform::Windows, "a.ts", &os(ERROR_FILENAME_EXCED_RANGE)).expect("판정이 없습니다");
        assert_eq!(f.kind, FileFailureKind::PathTooLong, "{f:?}");
        // 그리고 Unix에서는 다른 코드다 — 두 상수를 뭉치면 한쪽이 조용히 안 잡힌다.
        assert_eq!(
            diagnose(Platform::Unix, "a.ts", &os(ENAMETOOLONG)).map(|f| f.kind),
            Some(FileFailureKind::PathTooLong)
        );
        assert_eq!(diagnose(Platform::Unix, "a.ts", &os(ERROR_FILENAME_EXCED_RANGE)), None);
    }

    /// **`ErrorKind`와 코드를 둘 다 본다.**
    ///
    /// `ErrorKind`만 보면 실제 실행에서는 맞지만 **여기서 검증할 수 없다**: 매핑을 하는 것은
    /// 인자로 받은 플랫폼이 아니라 지금 도는 OS이고, Linux에서 Windows의 5번은 `EIO`다.
    /// 코드만 보면 반대로, 원시 코드가 없는 오류(`ErrorKind`로만 만들어진 것)를 놓친다.
    #[test]
    fn permission_is_read_from_both_the_kind_and_the_code() {
        // ① 코드로 재구성한 오류 — 인자만으로 판정된다.
        for (platform, code) in [(Platform::Windows, ERROR_ACCESS_DENIED), (Platform::Unix, EACCES)] {
            let f = diagnose(platform, "a.ts", &os(code)).expect("판정이 없습니다");
            assert_eq!(f.kind, FileFailureKind::PermissionDenied, "{platform:?}");
            assert!(!f.retryable, "{f:?}");
        }

        // ② 코드가 없는 오류 — `ErrorKind`가 잡는다.
        for platform in [Platform::Windows, Platform::Unix] {
            let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
            assert_eq!(err.raw_os_error(), None, "이 테스트의 전제가 깨졌습니다");
            let f = diagnose(platform, "a.ts", &err).expect("판정이 없습니다");
            assert_eq!(f.kind, FileFailureKind::PermissionDenied, "{platform:?}");
        }

        // ③ 그리고 플랫폼이 갈린다 — Windows의 5번은 Unix에서 `EIO`이고 우리는 그것을 모른다.
        assert_eq!(diagnose(Platform::Unix, "a.ts", &os(ERROR_ACCESS_DENIED)), None);
    }

    /// **모르면 `None`이다.** "문제가 없다"가 아니라 "더 말할 것이 없다"이고, 호출부는
    /// 그때 OS의 문장을 그대로 남긴다.
    #[test]
    fn an_unknown_failure_gets_no_advice() {
        assert_eq!(diagnose(Platform::Windows, "a.ts", &os(9_999)), None);
        assert_eq!(diagnose(Platform::Unix, "a.ts", &os(9_999)), None);
    }

    /// **모르는 것을 지어내지 않는다.** 잠근 프로세스의 이름을 우리는 알지 못하고, 그 사실이
    /// 처방에 적혀 있어야 사용자가 "왜 안 알려주지"라고 생각하지 않는다.
    #[test]
    fn the_lock_advice_admits_what_we_do_not_know() {
        let f = diagnose(Platform::Windows, "a.ts", &os(ERROR_SHARING_VIOLATION)).expect("판정이 없습니다");
        assert!(f.try_this.contains("알지 못합니다"), "{}", f.try_this);
        // 그리고 대상 경로는 사실 쪽에 있다 — 처방만 보고는 무엇이 막혔는지 알 수 없다.
        assert!(f.fact.contains("a.ts"), "{}", f.fact);
    }
}
