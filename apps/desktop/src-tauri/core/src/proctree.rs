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
//! **Windows**: 원래는 **Job Object**가 정답이다 — 커널이 트리를 보장한다. M0.1에서는 채택하지
//! 않았고 `taskkill /T /F /PID`를 쓴다. 이유와 한계:
//!
//! - Job Object를 쓰려면 `windows`/`winapi` 크레이트와 `unsafe` 핸들 관리가 필요하다. 취소
//!   경로에 검증하기 어려운 unsafe 코드를 넣는 것은 M0.1의 위험 대비 이득이 맞지 않는다.
//! - `taskkill /T`는 **스냅샷 시점의 부모-자식 관계**를 따라 트리를 죽인다. 따라서
//!   (a) 부모가 죽은 뒤 고아가 된 손자, (b) 종료 직후 새로 spawn된 프로세스는 놓칠 수 있다.
//! - `CREATE_NEW_PROCESS_GROUP`으로 그룹을 만들어 두지만, 그룹 종료는 콘솔 애플리케이션에만
//!   신뢰성 있게 동작하므로 taskkill을 주 수단으로 쓴다.
//!
//! 즉 **Windows에서 프로세스 트리 종료는 best-effort다.** 이 한계는
//! docs/design/state-machine-and-protocol.md 5.3절의 "실행된 프로세스 내부는 통제하지 못한다"와
//! 같은 성질이며, Job Object 도입은 미해결 항목으로 남겨 두었다.

use std::process::Child;
use std::time::{Duration, Instant};

/// 종료 유예 — 이 시간 안에 스스로 끝나면 강제 종료하지 않는다.
const GRACE: Duration = Duration::from_millis(300);

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
        let _ = child.wait();
        return TreeKillOutcome {
            direct_child_terminated: true,
            tree_guaranteed: group_killed,
            method: if group_killed {
                "killpg(SIGTERM→SIGKILL)"
            } else {
                "kill(child)"
            },
        };
    }

    #[cfg(windows)]
    {
        let tree_killed = windows_taskkill_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
        return TreeKillOutcome {
            direct_child_terminated: true,
            // taskkill은 스냅샷 기반이므로 보장이라고 말하지 않는다.
            tree_guaranteed: false,
            method: if tree_killed {
                "taskkill /T /F (best-effort)"
            } else {
                "kill(child) — taskkill 실패"
            },
        };
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
        let _ = child.wait();
        TreeKillOutcome {
            direct_child_terminated: true,
            tree_guaranteed: false,
            method: "kill(child)",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeKillOutcome {
    pub direct_child_terminated: bool,
    /// 트리 전체 종료를 **보장**하는가. Windows의 taskkill 경로는 false다.
    pub tree_guaranteed: bool,
    pub method: &'static str,
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
    use super::*;
    use std::process::{Command, Stdio};

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
