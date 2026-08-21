//! Windows Job Object — 프로세스 트리 종료 **보장**.
//!
//! 설계·조사·착지 기준은 docs/design/state-machine-and-protocol.md 20절에 있다.
//! 여기서는 이 파일을 고칠 사람이 알아야 하는 것만 적는다.
//!
//! # 왜 필요한가
//!
//! `taskkill /T`는 **스냅샷 시점의 부모-자식 관계**를 따라가므로 (a) 이미 고아가 된 손자와
//! (b) 종료 직후 새로 생긴 프로세스를 놓친다. Job Object는 커널이 소속을 관리하므로 그 두
//! 구멍이 없다 — 그래서 `tree_guaranteed`를 참으로 만들 수 있는 유일한 수단이다.
//!
//! # 가장 나쁜 실패 모드: 앱이 스스로 죽는다
//!
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`가 걸린 job은 **마지막 핸들이 닫히는 순간 안에 있는
//! 프로세스를 전부 죽인다.** 그러므로 우리 프로세스가 그 job에 들어가면 앱이 자살한다.
//!
//! 이 파일은 그 사고를 구조로 막는다: `AssignProcessToJobObject`를 부르는 곳이 하나뿐이고,
//! 인자가 `Child`에서 온 핸들뿐이다. **`GetCurrentProcess`를 쓰지 말 것** —
//! 이 파일에 그 심볼이 등장하면 리뷰에서 멈춰야 한다.
//!
//! # 배정 시점의 경쟁 창 (20.3절)
//!
//! spawn **직후** 배정한다. 그 사이에 자식이 만든 손자는 job 밖에 남는다 — 마이크로초 단위의
//! 창이지만 0은 아니다. 없애려면 `CREATE_SUSPENDED`로 띄우고 배정한 뒤 재개해야 하는데,
//! `std::process`가 스레드 핸들을 주지 않아 Toolhelp 스냅샷 우회가 필요하다. 취소 경로에
//! 들어가는 `unsafe`의 양을 늘리는 대가가 그 창을 없애는 이득보다 크다고 보아 택하지 않았다.
//!
//! **어느 쪽이든 지금(taskkill)보다 나빠지지 않는다**는 것이 이 선택의 안전망이다.
//!
//! # 실패는 오류가 아니다
//!
//! job을 만들지 못하거나 배정에 실패하면 `None`을 돌려준다. 호출자는 taskkill 경로로 물러서고
//! `tree_guaranteed`는 거짓이 된다. **취소를 실패시키지 않는다** — 취소가 안 되는 것이
//! 트리를 보장하지 못하는 것보다 나쁘다.

use std::os::windows::io::AsRawHandle;
use std::process::Child;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// 자식과 수명을 같이하는 job 핸들.
///
/// **Drop이 곧 정리다.** 핸들이 닫히면 커널이 job 안에 남은 프로세스를 죽이므로,
/// 강제 포기(사용자가 기다리기를 그만둔 경우)에도 별도 PID 추적이 필요 없다(20.4절).
pub struct JobHandle {
    handle: HANDLE,
}

// SAFETY: `HANDLE`은 raw pointer라 Send/Sync가 자동으로 붙지 않는다. 그러나 job 핸들은
// 스레드에 묶이지 않은 커널 객체이고, 이 타입이 하는 일은 생성·종료·닫기뿐이다.
// 도구 실행이 스레드를 넘나들므로(tools/mod.rs) 이 표시가 없으면 쓸 수 없다.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    /// job을 만들어 **이 자식만** 넣는다. 실패하면 `None` (호출자는 taskkill로 물러선다).
    pub fn create_and_assign(child: &Child) -> Option<Self> {
        // SAFETY: 인자는 널 포인터 둘(기본 보안 속성, 이름 없는 job)이고, 반환값이
        // 널인지 검사한다. 이름을 주지 않는 이유: 이름이 있으면 다른 프로세스가 같은 이름으로
        // 열 수 있고, 우리 job은 이 태스크 밖에서 참조될 이유가 없다.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return None;
        }
        let job = Self { handle };

        // SAFETY: 0으로 채운 뒤 우리가 쓰는 필드만 세운다. 이 구조체는 모두 POD다.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `limits`는 이 스코프에 살아 있고, 길이를 그 타입의 크기로 넘긴다.
        let set = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            // KILL_ON_JOB_CLOSE를 걸지 못한 job은 쓰지 않는다. 그게 없으면 핸들을 닫아도
            // 안에 있는 프로세스가 살아남아, 보장한다고 말할 근거가 사라진다.
            return None;
        }

        // **여기가 이 파일에서 유일하게 프로세스를 job에 넣는 곳이다.** 인자는 자식 핸들뿐이다.
        //
        // SAFETY: `child`가 살아 있는 동안 그 핸들은 유효하다. 우리 프로세스의 핸들은
        // 이 호출에 들어가지 않는다 — 들어가면 Drop이 앱을 죽인다(위 주석).
        let assigned = unsafe { AssignProcessToJobObject(job.handle, child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            // 이미 다른 job에 속해 있고 중첩이 허용되지 않는 환경(구형 Windows, 일부 CI)에서
            // 실패한다. 오류로 만들지 않고 taskkill로 물러선다.
            return None;
        }

        Some(job)
    }

    /// job 안의 모든 프로세스를 즉시 종료한다. 반환값은 요청이 받아들여졌는가다.
    ///
    /// **"죽었다"가 아니라 "죽이라고 했다"**이다. 실제로 사라졌는지는 호출자가 자식을 수거해
    /// 확인하며, 그 두 조건의 결합은 `TreeKillOutcome::new`가 강제한다.
    pub fn terminate(&self) -> bool {
        // SAFETY: 핸들은 Drop 전까지 유효하다. 종료 코드 1은 "우리가 죽였다"는 표식이다.
        unsafe { TerminateJobObject(self.handle, 1) != 0 }
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // SAFETY: 이 타입이 소유한 핸들을 정확히 한 번 닫는다.
        // 닫는 순간 커널이 job 안에 남은 프로세스를 죽인다(KILL_ON_JOB_CLOSE).
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}
