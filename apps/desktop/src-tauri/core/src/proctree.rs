//! 자식 프로세스 트리 종료.
//!
//! 왜 직접 자식만 죽이면 부족한가: `npm test`를 실행하면 npm이 다시 node를 spawn한다.
//! npm만 죽이면 **실제로 테스트를 돌리고 있는 node는 계속 살아서** 파일을 쓰고 CPU를 쓴다.
//! 사용자가 "취소"를 눌렀는데 작업이 계속되는 것이므로, 취소 기능이 있다고 말할 수 없다.
//!
//! # 플랫폼별 방식과 그 한계 (정직하게)
//!
//! **Unix**: 자식을 새 프로세스 그룹의 리더로 만들고(`process_group(0)`), 취소 시 그룹 전체에
//! 시그널을 보낸다(`killpg`). 자식이 스스로 그룹을 다시 바꾸지 않는 한 손자까지 확실히 죽는다.
//! SIGTERM을 먼저 보내 정리 기회를 주고, 짧은 유예 후에도 살아 있으면 SIGKILL.
//!
//! **Windows**: **Job Object**를 쓴다 — 커널이 소속을 관리하므로 트리 전체 종료를 보장한다
//! (`win_job.rs`, 문서 20절). 만들지 못하거나 배정에 실패하면 `taskkill /T /F /PID`로
//! 물러선다. **취소를 실패시키지 않는 것이 트리를 보장하는 것보다 우선하기 때문이다.**
//!
//! taskkill 경로를 지우지 않고 남겨둔 이유는 그것이 여전히 도달 가능한 경로이기 때문이다:
//! 구형 Windows나 이미 다른 job에 속한 환경에서는 중첩 배정이 거절될 수 있다. 그때
//! `tree_guaranteed`는 거짓이 되고 화면이 그 사실을 그대로 말한다 —
//! 죽지 않은 것을 죽었다고 보고하지 않기 위해서다.
//!
//! taskkill의 한계(그래서 Job Object가 필요한 이유): `taskkill /T`는 **스냅샷 시점의
//! 부모-자식 관계**를 따라가므로 (a) 부모가 죽은 뒤 고아가 된 손자, (b) 종료 직후 새로
//! spawn된 프로세스를 놓친다. `CREATE_NEW_PROCESS_GROUP`은 계속 걸어두지만 그룹 종료는
//! 콘솔 애플리케이션에만 신뢰성 있게 동작한다.
//!
//! # 이 파일을 고치기 전에 (문서 20절)
//!
//! - **`KILL_ON_JOB_CLOSE`가 걸린 job에 우리 프로세스가 들어가면 앱이 스스로 죽는다.**
//!   `AssignProcessToJobObject`를 부르는 곳은 `win_job.rs`에 하나뿐이고 인자는 자식 핸들뿐이다.
//!   이것이 이 기능에서 가장 나쁜 실패 모드이며, **컴파일러는 잡아주지 않는다.**
//! - **배정은 spawn 직후다.** 그 사이에 자식이 만든 손자는 job 밖에 남는다(마이크로초 단위의
//!   창). 없애려면 `CREATE_SUSPENDED`로 띄웠다가 재개해야 하는데 `std`가 스레드 핸들을 주지
//!   않아 Toolhelp 우회가 필요하고, 취소 경로의 `unsafe` 양이 늘어난다(20.3절).
//! - **이 저장소의 개발 환경(Linux)에서는 실행 검증이 불가능하다.** `win_job.rs`와 이 파일의
//!   Windows 분기는 `cargo check --target x86_64-pc-windows-msvc`로 **타입 검증만** 했다
//!   (core 전체는 `rusqlite`의 bundled SQLite가 `lib.exe`를 요구해 그 방식으로 검사할 수 없어,
//!   두 파일만 담은 별도 크레이트에서 확인했다). **타입 검증은 동작 검증이 아니다** —
//!   Win32에서 컴파일되는 코드가 틀리는 흔한 방식은 핸들 수명이고, 그건 실행해야 드러난다.
//!   20.6절의 착지 기준을 Windows에서 통과시키기 전에는 이 경로를 신뢰하지 말 것.
//!
//! 파일·네트워크 샌드박싱은 **이것과 다른 문제이고, 하지 않기로 했다**(20.2절) —
//! Job Object에 그 기능이 없기도 하지만, 실제로 제한하는 수단들은 사용자의 개발 환경을
//! 바꿔버려 "사용자의 환경에서 통과했다"는 판정의 의미를 약하게 만든다.

use std::process::Child;
use std::time::{Duration, Instant};

/// 종료 유예 — 이 시간 안에 스스로 끝나면 강제 종료하지 않는다.
/// Unix 전용 — Windows에는 SIGTERM에 해당하는 단계가 없다(Job Object는 즉시 종료한다).
#[cfg(unix)]
const GRACE: Duration = Duration::from_millis(300);

/// SIGKILL(또는 taskkill) 이후 **자식이 사라지기를 기다리는 상한**.
///
/// # 왜 상한이 필요한가
///
/// `Child::wait()`은 무한히 기다린다. 보통은 SIGKILL을 받으면 즉시 죽으므로 문제가 없지만,
/// **uninterruptible sleep(D 상태)에 들어간 프로세스는 SIGKILL로도 즉시 죽지 않는다** —
/// 응답 없는 네트워크 파일 시스템이나 멈춘 드라이버를 기다리는 경우가 실제로 그렇다.
/// 그 상태에서 무한히 기다리면 "취소 중"이 영원히 끝나지 않고, 사용자에게는 앱이 멈춘 것과
/// 구별되지 않는다(12절 미해결 "취소 중 상한").
///
/// 그래서 기다리되 **포기할 줄 안다.** 포기했다는 사실은 숨기지 않고 `child_still_running`으로
/// 올려보낸다 — 죽지 않은 것을 죽었다고 보고하는 것이 이 기능에서 할 수 있는 가장 나쁜 일이다.
const REAP_TIMEOUT: Duration = Duration::from_millis(2_000);

/// `Command`에 플랫폼별 그룹 설정을 붙인다. spawn 전에 호출해야 한다.
#[cfg(unix)]
pub fn configure_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // 자식을 새 프로세스 그룹의 리더로 만든다 (pgid = 자식의 pid).
    // 이렇게 해두면 손자까지 같은 그룹에 속하므로 그룹 단위로 확실히 죽일 수 있다.
    command.process_group(0);
}

#[cfg(windows)]
pub fn configure_group(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NEW_PROCESS_GROUP — Ctrl+C가 우리 프로세스로 전파되지 않게 하고,
    // taskkill이 트리를 찾을 때의 기준을 명확히 한다.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
pub fn configure_group(_command: &mut std::process::Command) {}

/// 수거 상한을 넘긴 자식을 백그라운드에서 계속 거두는 상한.
///
/// 상한이 있는 이유는 원칙 5다 — 끝나지 않는 스레드를 명령마다 하나씩 만드는 것은
/// 그 자체가 누수이고, 우리가 고치려던 누수와 성질이 같다.
const ORPHAN_REAP_CAP: Duration = Duration::from_secs(300);
const ORPHAN_POLL: Duration = Duration::from_millis(500);

/// 수거를 포기한 자식을 **넘겨받아 계속 거둔다.** 소유권을 가져가는 것이 핵심이다.
///
/// # 왜 필요한가 — 버리면 좀비가 남는다
///
/// Rust의 `Child::drop`은 기다리지도 죽이지도 않는다(문서화된 동작이다). 그래서
/// `reap_with_timeout`이 상한을 넘겨 포기한 자식을 그냥 버리면, 그 프로세스가 **나중에 죽을 때
/// 좀비가 되고 우리 앱이 살아 있는 한 사라지지 않는다.** 취소를 여러 번 하면 그만큼 쌓인다.
///
/// # 그리고 우리 보고가 영원히 틀린 채로 남는다
///
/// `is_alive`는 `kill(pid, 0)`이라 **좀비를 살아 있다고 보고한다.** 즉 사용자에게 "PID 1234가
/// 남아 있을 수 있습니다"라고 말해 놓고, 사용자가 나중에 확인해도 계속 살아 있는 것으로 보인다 —
/// 실제로는 그 프로세스가 이미 죽었고 **우리가 거두지 않아서** 그렇게 보이는 것인데도.
/// 죽은 것을 살아 있다고 보고하는 것은 그 반대만큼은 아니어도 여전히 거짓말이다.
///
/// # 이것이 프로세스를 죽이지는 않는다
///
/// SIGKILL은 `terminate_tree`에서 이미 보냈고, 그 시그널은 **이미 걸려 있다.** D 상태에서
/// 빠져나오는 순간 적용되므로 다시 보낼 것이 없다. 이 함수가 하는 일은 죽이는 것이 아니라
/// **죽었을 때 뒷정리를 하는 것**이다.
///
/// Windows에는 좀비 개념이 없어 무해하지만 같은 경로를 타게 둔다 — 플랫폼 분기를 하나 줄이는
/// 편이, 한쪽만 고쳐 두 플랫폼의 의미가 갈리는 것보다 낫다.
pub fn adopt_orphan(mut child: Child) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + ORPHAN_REAP_CAP;
        loop {
            match child.try_wait() {
                // 거뒀거나(Ok(Some)) 이미 누군가 거뒀다(Err) — 어느 쪽이든 할 일이 끝났다.
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => {}
            }
            if Instant::now() >= deadline {
                // 상한을 넘겼다. **포기한다** — 여기서 더 기다리면 이 스레드가 누수가 된다.
                return;
            }
            std::thread::sleep(ORPHAN_POLL);
        }
    });
}

/// 자식과 수명을 같이하는 종료 보조물.
///
/// Windows에서는 Job Object 핸들을 담고, 그 밖에서는 **비어 있다** — Unix는 프로세스 그룹이
/// 커널에 이미 있으므로 따로 들고 다닐 것이 없다. 그래도 타입을 두는 이유는 호출부의 모양을
/// 플랫폼마다 다르게 만들지 않기 위해서다.
///
/// # Drop이 곧 정리다 (Windows)
///
/// job 핸들이 닫히면 커널이 안에 남은 프로세스를 죽인다(`KILL_ON_JOB_CLOSE`). 그래서
/// 명령이 정상 종료했든, 취소됐든, 사용자가 강제 포기했든 **이 값이 스코프를 벗어나는 순간
/// 남은 것이 정리된다.** 12절 "강제 포기 이후 남은 프로세스의 정리"가 이렇게 닫힌다 —
/// PID를 추적할 필요가 없다.
///
/// **부작용을 숨기지 않는다**: 정상 종료한 명령이 뒤에 남긴 백그라운드 프로세스도 이때 죽는다.
/// `run_command`의 allowlist는 빌드·테스트·lint용이고 데몬을 띄워 남겨두는 용도가 아니므로
/// 그 편이 맞다고 본다. 남기고 싶은 프로세스가 생기면 이 결정을 다시 봐야 한다.
#[derive(Default)]
pub struct ProcessGuard {
    #[cfg(windows)]
    job: Option<crate::win_job::JobHandle>,
}

/// spawn 직후 자식을 종료 보조물에 편입시킨다.
///
/// **spawn 전이 아니라 직후인 이유**는 문서 20.3절에 있다 — 경쟁 창을 없애려면 정지 상태로
/// 띄웠다가 재개해야 하는데 `std`가 스레드 핸들을 주지 않는다. 남는 창은 마이크로초 단위이고,
/// 어느 쪽이든 taskkill보다 나빠지지 않는다.
#[cfg(windows)]
pub fn adopt(child: &std::process::Child) -> ProcessGuard {
    ProcessGuard {
        job: crate::win_job::JobHandle::create_and_assign(child),
    }
}

#[cfg(not(windows))]
pub fn adopt(_child: &std::process::Child) -> ProcessGuard {
    ProcessGuard::default()
}

/// 프로세스 트리를 종료한다. 반환값은 "트리 전체를 종료했다고 확신하는가"다.
///
/// `false`는 실패가 아니라 **보장할 수 없다는 뜻**이며, 호출자가 그 불확실성을 사용자에게
/// 전달할 수 있게 하기 위해 구별한다.
pub fn terminate_tree(child: &mut Child, guard: &ProcessGuard) -> TreeKillOutcome {
    let pid = child.id();
    let _ = guard;

    #[cfg(unix)]
    {
        let group_killed = unix_kill_group(pid);
        // 그룹 시그널이 닿지 않는 경우(이미 죽어 pgid가 사라짐 등)에도 직접 자식은 확실히 정리한다.
        let _ = child.kill();
        let reaped = reap_with_timeout(child);
        return TreeKillOutcome::new(
            pid,
            reaped,
            // 그룹 시그널이 닿았을 때만 손자까지 닿았다고 말할 수 있다.
            group_killed,
            if group_killed {
                "killpg(SIGTERM→SIGKILL)"
            } else {
                "kill(child)"
            },
        );
    }

    #[cfg(windows)]
    {
        // Job Object가 있으면 그것만으로 충분하다 — 커널이 소속을 관리하므로 고아가 된 손자도
        // 놓치지 않는다. 없으면(생성·배정 실패) taskkill로 물러선다. **취소를 실패시키지 않는
        // 것이 트리를 보장하는 것보다 우선한다.**
        let (covers_tree, method) = match guard.job.as_ref() {
            Some(job) if job.terminate() => (true, "TerminateJobObject"),
            // job은 있는데 종료 요청이 거절된 경우. 보장을 말할 수 없으므로 taskkill을 겹쳐 쓴다.
            Some(_) => (false, taskkill_method(windows_taskkill_tree(pid))),
            None => (false, taskkill_method(windows_taskkill_tree(pid))),
        };
        let _ = child.kill();
        let reaped = reap_with_timeout(child);
        // `covers_tree`가 참이어도 수거에 실패하면 보장이 아니다 — 그 결합은 `new`가 강제한다.
        return TreeKillOutcome::new(pid, reaped, covers_tree, method);
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
        let reaped = reap_with_timeout(child);
        TreeKillOutcome::new(pid, reaped, false, "kill(child)")
    }
}

/// `REAP_TIMEOUT` 안에 자식이 사라졌는가.
///
/// `wait()` 대신 `try_wait()` 폴링을 쓰는 이유는 하나뿐이다 — **포기할 수 있어야 하기 때문이다.**
/// 표준 라이브러리에는 시간 제한이 있는 wait이 없다.
fn reap_with_timeout(child: &mut Child) -> bool {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            // 종료됐다. 또는 이미 누군가 거둬갔다(Err) — 어느 쪽이든 이 자식은 더 없다.
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeKillOutcome {
    /// 직접 자식이 실제로 사라졌는가. **상한 안에 사라지지 않으면 false다** — 죽였다고 믿는 것과
    /// 죽은 것을 확인한 것은 다르다.
    pub direct_child_terminated: bool,
    /// 상한을 넘겨 포기했는가. true면 그 프로세스는 아직 돌고 있을 수 있다.
    pub child_still_running: bool,
    /// 살아남았을 수 있는 PID. 사용자에게 무엇이 남았는지 알려주기 위한 것이다 —
    /// "뭔가 남았을 수 있습니다"만으로는 사용자가 할 수 있는 일이 없다.
    pub surviving_pid: Option<u32>,
    /// 트리 전체 종료를 **보장**하는가. Windows의 taskkill 경로는 false다.
    ///
    /// **직접 세우지 말고 `TreeKillOutcome::new`를 쓸 것** — 이유는 그 함수 주석에.
    pub tree_guaranteed: bool,
    pub method: &'static str,
}

impl TreeKillOutcome {
    /// 종료 결과를 만든다. **`tree_guaranteed`를 직접 세우지 못하게 하는 것이 이 함수의 목적이다.**
    ///
    /// # 왜 생성자를 두는가
    ///
    /// 보장은 두 가지가 **모두** 참일 때만 성립한다.
    ///
    /// 1. 쓴 수단이 트리 전체에 닿는가 (`mechanism_covers_tree`)
    /// 2. 그래서 **실제로 사라졌는가** (`reaped`)
    ///
    /// 2번이 빠지기 쉽다. Job Object는 커널이 트리를 보장하므로(문서 20절) 구현하는 사람이
    /// `tree_guaranteed: true`를 조건 없이 쓰고 싶어진다. 그런데 `reap_with_timeout`이 상한을
    /// 넘겨 포기했다면 우리가 아는 것은 "요청했다"까지이고, 그 상태에서 보장을 말하면
    /// **살아 있을 수 있는 프로세스를 죽었다고 보고**하게 된다. 이 기능에서 할 수 있는 가장
    /// 나쁜 일이 그것이다(16.3절).
    ///
    /// 그래서 두 조건의 결합을 호출자에게 맡기지 않고 여기서 강제한다. 호출자는 자기가 아는
    /// 것(1번)만 말하면 된다.
    fn new(pid: u32, reaped: bool, mechanism_covers_tree: bool, method: &'static str) -> Self {
        Self {
            direct_child_terminated: reaped,
            child_still_running: !reaped,
            surviving_pid: if reaped { None } else { Some(pid) },
            tree_guaranteed: mechanism_covers_tree && reaped,
            method,
        }
    }
}

#[cfg(unix)]
fn unix_kill_group(pid: u32) -> bool {
    // pgid는 리더의 pid와 같다 (configure_group에서 process_group(0)을 했으므로).
    let pgid = pid as i32;

    // SIGTERM으로 정리 기회를 준다 — 테스트 러너가 임시 파일을 정리할 수 있다.
    let term_sent = unsafe { libc::killpg(pgid, libc::SIGTERM) } == 0;
    if !term_sent {
        // 그룹이 이미 없다 (전부 종료됨) — 죽일 것이 없으므로 성공으로 본다.
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    }

    // 유예 후에도 살아 있으면 SIGKILL. `killpg(pgid, 0)`으로 생존을 확인한다.
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline {
        if unsafe { libc::killpg(pgid, 0) } != 0 {
            return true; // 그룹이 사라졌다
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    true
}

#[cfg(windows)]
fn taskkill_method(killed: bool) -> &'static str {
    if killed {
        "taskkill /T /F (best-effort)"
    } else {
        "kill(child) — taskkill 실패"
    }
}

#[cfg(windows)]
fn windows_taskkill_tree(pid: u32) -> bool {
    // taskkill은 Windows에 내장되어 있어 새 의존성이 없다.
    // /T = 트리, /F = 강제. 셸을 경유하지 않고 argv로 실행한다(원칙 6과 같은 이유).
    std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 프로세스가 아직 살아 있는지 확인한다 (테스트가 "실제로 죽었나"를 검증할 때 쓴다).
#[cfg(unix)]
pub fn is_alive(pid: u32) -> bool {
    // 시그널 0은 존재 확인 전용이다.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
pub fn is_alive(pid: u32) -> bool {
    // tasklist 출력에 PID가 있으면 살아 있다. 의존성 없이 확인하는 방법.
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
pub fn is_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {

    /// 수거를 포기한 자식을 **버리면 좀비가 남는다.** `adopt_orphan`이 그걸 거둔다.
    ///
    /// `/proc/<pid>`의 존재로 확인하는 이유: 좀비는 `kill(pid, 0)`에 응답하므로 `is_alive`로는
    /// 구별되지 않는다 — 그게 이 함수가 필요한 이유 그 자체다. 거두지 않은 좀비는 부모(테스트
    /// 프로세스)가 살아 있는 한 `/proc`에 남고, 거두면 사라진다.
    ///
    /// **대조군이 없으면 이 테스트는 아무것도 증명하지 못한다** — 프로세스가 그냥 빨리
    /// 사라진 것과 우리가 거둔 것을 구별할 수 없기 때문이다.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_abandoned_child_is_reaped_instead_of_left_as_a_zombie() {
        fn spawn_short_lived() -> Child {
            Command::new("node")
                .args(["-e", "setTimeout(() => process.exit(0), 200)"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
        let exists = |pid: u32| std::path::Path::new(&format!("/proc/{pid}")).exists();

        // 대조군: 거두지 않고 버린다 → 죽은 뒤 좀비로 남는다.
        let abandoned = spawn_short_lived();
        let zombie_pid = abandoned.id();
        drop(abandoned);

        // 실험군: 넘겨서 거두게 한다.
        let adopted = spawn_short_lived();
        let reaped_pid = adopted.id();
        adopt_orphan(adopted);

        let deadline = Instant::now() + Duration::from_secs(10);
        while exists(reaped_pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !exists(reaped_pid),
            "넘긴 자식이 거둬지지 않았습니다 (pid {reaped_pid})"
        );

        // 대조군은 여전히 남아 있어야 한다 — 남아 있지 않으면 위 결과가 우연이다.
        assert!(
            exists(zombie_pid),
            "버린 자식이 스스로 사라졌습니다 — 이 테스트는 아무것도 검증하지 못합니다 (pid {zombie_pid})"
        );
        // 그리고 좀비는 `is_alive`에 살아 있는 것으로 보인다. 사용자에게 "남아 있을 수 있습니다"가
        // 영원히 참으로 남는 자리가 여기다.
        assert!(is_alive(zombie_pid), "좀비가 kill(pid, 0)에 응답하지 않습니다");
    }

    /// **살아남은 프로세스가 있으면 보장을 말하지 않는다.** 수단이 트리를 덮더라도 그렇다.
    ///
    /// Job Object로 바꿀 때 실수하기 가장 쉬운 자리다 — 커널이 보장하니까
    /// `tree_guaranteed: true`를 조건 없이 쓰고 싶어지는데, 수거에 실패했다면 우리가 아는 것은
    /// "요청했다"까지다. 그 상태에서 보장을 말하면 살아 있을 수 있는 프로세스를 죽었다고
    /// 보고하게 된다.
    #[test]
    fn a_surviving_child_never_reports_a_guaranteed_tree_kill() {
        for mechanism_covers_tree in [true, false] {
            let out = TreeKillOutcome::new(4242, false, mechanism_covers_tree, "test");
            assert!(
                !out.tree_guaranteed,
                "수거 실패인데 보장을 말했습니다 ({mechanism_covers_tree})"
            );
            assert!(out.child_still_running);
            assert_eq!(out.surviving_pid, Some(4242));
            assert!(!out.direct_child_terminated);
        }
    }

    /// 반대 방향: 수단이 트리를 덮지 못하면 수거에 성공해도 보장이 아니다.
    /// 지금 Windows(taskkill 스냅샷)가 이 경우이고, 화면이 그 사실을 말한다.
    #[test]
    fn reaping_alone_is_not_a_tree_guarantee() {
        let out = TreeKillOutcome::new(1, true, false, "test");
        assert!(out.direct_child_terminated);
        assert!(!out.tree_guaranteed);
        assert_eq!(out.surviving_pid, None);

        let guaranteed = TreeKillOutcome::new(1, true, true, "test");
        assert!(guaranteed.tree_guaranteed);
    }
    use super::*;
    use std::process::{Command, Stdio};

    /// 종료 상한이 실제로 **포기하는지** 확인한다 (12절 미해결 "취소 중 상한").
    ///
    /// SIGKILL을 무시하는 프로세스를 만들 수는 없으므로(그건 커널이 정한다), 여기서는
    /// `reap_with_timeout`에 **이미 다른 곳에서 거둬간** 자식을 주는 대신 살아 있는 자식을
    /// 주고 상한이 지나면 false가 나오는지를 본다. 죽이지 않은 채 기다리기만 하는 상황이
    /// D 상태 프로세스와 같은 관측 결과를 만든다.
    #[cfg(unix)]
    #[test]
    fn reaping_gives_up_instead_of_waiting_forever() {
        let mut child = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("node를 실행할 수 없습니다");

        let started = Instant::now();
        // **죽이지 않고** 거두기만 시도한다 — 죽지 않는 프로세스를 기다리는 것과 같은 상황이다.
        let reaped = reap_with_timeout(&mut child);
        let elapsed = started.elapsed();

        assert!(!reaped, "살아 있는 프로세스를 거뒀다고 보고했습니다");
        // 무한히 기다리지 않았다. 이게 없으면 "취소 중"이 영원히 끝나지 않는다.
        assert!(
            elapsed < REAP_TIMEOUT + Duration::from_millis(1_500),
            "종료 상한을 지키지 못했습니다: {elapsed:?}"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// 정상적으로 죽는 프로세스는 상한을 다 쓰지 않는다 — 상한이 지연을 만들면 안 된다.
    #[test]
    fn reaping_returns_immediately_for_a_process_that_exits() {
        let mut child = Command::new("node")
            .args(["-e", "process.exit(0)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("node를 실행할 수 없습니다");

        let started = Instant::now();
        assert!(reap_with_timeout(&mut child));
        assert!(started.elapsed() < REAP_TIMEOUT, "정상 종료인데 상한을 다 썼습니다");
    }

    /// 손자 프로세스까지 죽는지 확인한다 — 이게 이 모듈의 존재 이유다.
    #[test]
    fn terminates_grandchildren_not_just_the_direct_child() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("grandchild.pid");

        // 부모(node) → 자식(node) 구조를 만든다. 부모만 죽이면 자식이 남는다.
        let script = format!(
            r#"
            const {{ spawn }} = require("node:child_process");
            const fs = require("node:fs");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{ stdio: "ignore" }});
            fs.writeFileSync({pid_file:?}, String(child.pid));
            setInterval(() => {{}}, 1000);
            "#,
            pid_file = pid_file.to_string_lossy()
        );

        let mut command = Command::new("node");
        command
            .args(["-e", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_group(&mut command);
        let mut child = command.spawn().expect("node를 실행할 수 없습니다");
        let parent_pid = child.id();

        // 손자가 pid를 기록할 때까지 기다린다.
        let deadline = Instant::now() + Duration::from_secs(10);
        let grandchild_pid = loop {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    break pid;
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("손자 프로세스가 pid를 기록하지 않았습니다");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(is_alive(grandchild_pid), "손자가 살아 있어야 테스트가 의미 있습니다");

        // 실제 경로와 같게 편입시킨 뒤 종료한다 — 보조물 없이 부르면 Windows에서 검사하는
        // 것이 실제 동작과 달라진다.
        let guard = adopt(&child);
        let outcome = terminate_tree(&mut child, &guard);
        assert!(outcome.direct_child_terminated);

        // 부모는 반드시 죽는다.
        let deadline = Instant::now() + Duration::from_secs(5);
        while is_alive(parent_pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!is_alive(parent_pid), "직접 자식이 종료되지 않았습니다");

        if outcome.tree_guaranteed {
            // Unix: 그룹 종료를 보장하므로 손자도 죽어야 한다.
            let deadline = Instant::now() + Duration::from_secs(5);
            while is_alive(grandchild_pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !is_alive(grandchild_pid),
                "손자 프로세스가 남았습니다 (method={})",
                outcome.method
            );
        } else {
            // best-effort 플랫폼에서는 보장하지 않는다고 선언했으므로 단정하지 않는다.
            // 대신 테스트 환경을 오염시키지 않도록 정리한다.
            eprintln!(
                "이 플랫폼은 트리 종료를 보장하지 않습니다 (method={}) — 손자 생존 여부를 단정하지 않습니다",
                outcome.method
            );
            #[cfg(windows)]
            {
                let _ = windows_taskkill_tree(grandchild_pid);
            }
        }
    }

    #[test]
    fn terminating_an_already_dead_process_is_not_an_error() {
        let mut child = Command::new("node")
            .args(["-e", "process.exit(0)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _ = child.wait();
        // 이미 죽은 프로세스를 종료하려 해도 패닉하거나 오류를 내지 않아야 한다 —
        // 취소 경로는 경쟁 상황에서 늘 이 상태를 만난다.
        let outcome = terminate_tree(&mut child, &ProcessGuard::default());
        assert!(outcome.direct_child_terminated);
    }

    #[test]
    fn is_alive_detects_dead_process() {
        let mut child = Command::new("node")
            .args(["-e", "process.exit(0)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let _ = child.wait();
        // 좀비 수거 후에는 죽은 것으로 보여야 한다.
        let deadline = Instant::now() + Duration::from_secs(3);
        while is_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!is_alive(pid));
    }
}
