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
//! **Windows**: 원래는 **Job Object**가 정답이다 — 커널이 트리를 보장한다. 지금은 채택하지
//! 않았고 `taskkill /T /F /PID`를 쓴다. 한계:
//!
//! - `taskkill /T`는 **스냅샷 시점의 부모-자식 관계**를 따라 트리를 죽인다. 따라서
//!   (a) 부모가 죽은 뒤 고아가 된 손자, (b) 종료 직후 새로 spawn된 프로세스는 놓칠 수 있다.
//! - `CREATE_NEW_PROCESS_GROUP`으로 그룹을 만들어 두지만, 그룹 종료는 콘솔 애플리케이션에만
//!   신뢰성 있게 동작하므로 taskkill을 주 수단으로 쓴다.
//!
//! 즉 **Windows에서 프로세스 트리 종료는 best-effort다.** 그래서 `tree_guaranteed`가 false이고,
//! 화면이 그 사실을 그대로 말한다 — 죽지 않은 것을 죽었다고 보고하지 않기 위해서다.
//!
//! # Job Object로 넘어갈 때 알아야 할 것 (문서 20절)
//!
//! 조사와 착지 기준은 state-machine-and-protocol.md 20절에 있다. 여기서는 **이 파일을 고칠
//! 사람이 먼저 알아야 하는 세 가지**만 적어둔다.
//!
//! - **`KILL_ON_JOB_CLOSE`가 걸린 job에 우리 프로세스가 들어가면 앱이 스스로 죽는다.**
//!   `AssignProcessToJobObject`는 **자식 핸들에만** 부를 것. 이것이 이 변경에서 가장 나쁜
//!   실패 모드이며, 컴파일러는 잡아주지 않는다.
//! - **spawn 직후 배정에는 경쟁 창이 있다.** 그 사이에 자식이 만든 손자는 job 밖에 남는다.
//!   없애려면 `CREATE_SUSPENDED`로 띄우고 배정한 뒤 재개해야 하는데, `std`가 스레드 핸들을
//!   주지 않아 Toolhelp 우회가 필요하다(20.3절). 어느 쪽을 골랐는지 여기 적을 것.
//! - **이 저장소의 개발 환경(Linux)에서는 실행 검증이 불가능하다.** `windows-sys`는
//!   `cargo check --target x86_64-pc-windows-msvc`로 타입 검증까지는 되지만(core 전체는
//!   `rusqlite`의 bundled SQLite가 `lib.exe`를 요구해 막힌다), 동작은 Windows에서만 확인된다.
//!   20.6절의 착지 기준을 전부 통과하기 전에는 `taskkill` 경로를 지울 것.
//!
//! 파일·네트워크 샌드박싱은 **이것과 다른 문제이고, 하지 않기로 했다**(20.2절) —
//! Job Object에 그 기능이 없기도 하지만, 실제로 제한하는 수단들은 사용자의 개발 환경을
//! 바꿔버려 "사용자의 환경에서 통과했다"는 판정의 의미를 약하게 만든다.

use std::process::Child;
use std::time::{Duration, Instant};

/// 종료 유예 — 이 시간 안에 스스로 끝나면 강제 종료하지 않는다.
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

/// 프로세스 트리를 종료한다. 반환값은 "트리 전체를 종료했다고 확신하는가"다.
///
/// `false`는 실패가 아니라 **보장할 수 없다는 뜻**이며, 호출자가 그 불확실성을 사용자에게
/// 전달할 수 있게 하기 위해 구별한다.
pub fn terminate_tree(child: &mut Child) -> TreeKillOutcome {
    let pid = child.id();

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
        let tree_killed = windows_taskkill_tree(pid);
        let _ = child.kill();
        let reaped = reap_with_timeout(child);
        return TreeKillOutcome::new(
            pid,
            reaped,
            // taskkill은 스냅샷 기반이므로 보장이라고 말하지 않는다.
            // Job Object로 바꾸면 이 인자가 true가 된다(문서 20절).
            false,
            if tree_killed {
                "taskkill /T /F (best-effort)"
            } else {
                "kill(child) — taskkill 실패"
            },
        );
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

        let outcome = terminate_tree(&mut child);
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
        let outcome = terminate_tree(&mut child);
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
