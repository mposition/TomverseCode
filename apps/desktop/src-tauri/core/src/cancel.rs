//! 취소 모델.
//!
//! 설계 원칙: **취소 판단의 최종 권한은 Rust에 있다.** Node가 "취소했다"고 주장하는 것만으로
//! 완료 처리하지 않는다 — 실행 중인 자식 프로세스가 실제로 죽었는지는 프로세스를 spawn한
//! 쪽만 알 수 있고, 그건 Rust다.
//!
//! 세 가지 성질을 만족해야 한다:
//!  1. **idempotent** — 이미 취소된 작업을 다시 취소해도 성공 응답이고 상태가 변하지 않는다.
//!  2. **terminal 이후 무효** — COMPLETED/FAILED에 도달한 작업의 취소 요청은 상태를 바꾸지 않는다.
//!  3. **취소 이후 실행 금지** — 새 모델 호출도, 새 도구 실행도 시작되지 않는다.
//!
//! (3)은 이 모듈이 플래그를 제공하고 `TaskHost`/`ToolRuntime`이 실제로 검사함으로써 성립한다.
//! 플래그만 두고 검사하지 않으면 아무것도 보장되지 않으므로, 검사 지점마다 테스트가 있다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::time::now_iso;

/// 하나의 태스크에 대한 취소 신호. 복제해도 같은 신호를 가리킨다.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
    requested_at: Arc<Mutex<Option<String>>>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// 취소를 요청한다.
    ///
    /// 반환값이 `true`면 **이번 호출이 처음으로** 취소를 확정한 것이다. 이벤트를 정확히 한 번만
    /// 기록하기 위해 호출자가 이 값을 봐야 한다 — 중복 취소 요청마다 이벤트를 남기면
    /// 감사 로그가 사용자의 연타를 그대로 반영하게 된다.
    pub fn cancel(&self) -> bool {
        // compare_exchange로 "처음 취소한 쪽"을 원자적으로 하나만 뽑는다.
        let newly = self
            .cancelled
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if newly {
            *self.requested_at.lock().unwrap() = Some(now_iso());
        }
        newly
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn requested_at(&self) -> Option<String> {
        self.requested_at.lock().unwrap().clone()
    }

    /// 취소되었으면 표준 오류 메시지를 만든다. 호출 지점마다 문구가 갈리지 않게 한 곳에 둔다.
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("태스크가 취소되었습니다".to_string())
        } else {
            Ok(())
        }
    }
}

/// 취소 요청의 결과. UI와 이벤트 로그가 세 경우를 구별해야 한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelOutcome {
    /// 이번 요청이 취소를 확정했다 — CANCELLATION_REQUESTED 이벤트를 남긴다.
    Requested { requested_at: String },
    /// 이미 취소 요청된 상태였다 — 성공이지만 새 이벤트는 남기지 않는다(idempotent).
    AlreadyRequested { requested_at: Option<String> },
    /// 이미 터미널 상태다 — 상태를 바꾸지 않는다.
    AlreadyTerminal { status: String },
    /// 그런 태스크를 모른다 (앱 재시작 후 등).
    UnknownTask,
}

impl CancelOutcome {
    /// UI 입장에서 "요청이 받아들여졌는가". 터미널 상태도 오류가 아니다 —
    /// 사용자가 완료 직전에 취소를 눌렀을 뿐이고 그건 실패가 아니다.
    pub fn accepted(&self) -> bool {
        !matches!(self, CancelOutcome::UnknownTask)
    }
}

/// 진행 중인 태스크의 취소 토큰 보관소.
///
/// 앱 프로세스 수명 동안 유지된다. 태스크가 터미널에 도달하면 제거한다 — 그러지 않으면
/// 장시간 실행 시 토큰이 무한히 쌓인다.
#[derive(Debug, Default)]
pub struct CancellationRegistry {
    tokens: Mutex<HashMap<String, CancellationToken>>,
}

impl CancellationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 태스크의 토큰을 얻는다. 없으면 만든다.
    ///
    /// **취소 요청이 태스크 시작보다 먼저 도착할 수 있으므로** 조회 시 생성하는 것이 중요하다.
    /// 시작 시점에만 등록하면 "시작 직후 즉시 취소" 경쟁에서 취소가 유실된다.
    pub fn token(&self, task_id: &str) -> CancellationToken {
        let mut guard = self.tokens.lock().unwrap();
        guard.entry(task_id.to_string()).or_default().clone()
    }

    /// 이미 등록된 토큰만 찾는다 (없으면 만들지 않는다).
    pub fn existing(&self, task_id: &str) -> Option<CancellationToken> {
        self.tokens.lock().unwrap().get(task_id).cloned()
    }

    /// 태스크가 터미널에 도달했을 때 호출한다.
    pub fn remove(&self, task_id: &str) {
        self.tokens.lock().unwrap().remove(task_id);
    }

    pub fn active_count(&self) -> usize {
        self.tokens.lock().unwrap().len()
    }

    /// 취소를 요청한다. `terminal_status`는 저장 계층이 알려주는 현재 터미널 상태다.
    ///
    /// 터미널 판정을 registry가 스스로 하지 않고 인자로 받는 이유: 진실의 원천은 SQLite이고,
    /// 메모리 상태로 판단하면 앱 재시작 후 두 판단이 갈린다.
    pub fn request(&self, task_id: &str, terminal_status: Option<String>) -> CancelOutcome {
        if let Some(status) = terminal_status {
            return CancelOutcome::AlreadyTerminal { status };
        }
        let token = self.token(task_id);
        if token.cancel() {
            CancelOutcome::Requested {
                requested_at: token.requested_at().unwrap_or_else(now_iso),
            }
        } else {
            CancelOutcome::AlreadyRequested {
                requested_at: token.requested_at(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_returns_true_only_on_first_call() {
        let token = CancellationToken::new();
        assert!(token.cancel(), "첫 취소는 true여야 합니다");
        assert!(!token.cancel(), "두 번째 취소는 false여야 합니다 (이벤트 중복 방지)");
        assert!(token.is_cancelled());
    }

    #[test]
    fn requested_at_is_set_once_and_kept() {
        let token = CancellationToken::new();
        assert_eq!(token.requested_at(), None);
        token.cancel();
        let first = token.requested_at().expect("취소 시각이 기록되어야 합니다");
        token.cancel();
        assert_eq!(
            token.requested_at().as_deref(),
            Some(first.as_str()),
            "재요청이 시각을 덮어쓰면 안 됩니다"
        );
    }

    #[test]
    fn clones_share_the_same_signal() {
        let token = CancellationToken::new();
        let clone = token.clone();
        token.cancel();
        assert!(clone.is_cancelled(), "복제본이 같은 신호를 봐야 합니다");
    }

    #[test]
    fn check_reports_cancellation() {
        let token = CancellationToken::new();
        assert!(token.check().is_ok());
        token.cancel();
        assert!(token.check().is_err());
    }

    #[test]
    fn registry_request_is_idempotent() {
        let registry = CancellationRegistry::new();
        let first = registry.request("task-1", None);
        assert!(matches!(first, CancelOutcome::Requested { .. }));
        let second = registry.request("task-1", None);
        assert!(matches!(second, CancelOutcome::AlreadyRequested { .. }));
        // 둘 다 "받아들여졌다" — 사용자가 두 번 눌렀다고 오류를 보여줄 이유가 없다.
        assert!(first.accepted() && second.accepted());
    }

    #[test]
    fn registry_refuses_to_change_terminal_tasks() {
        let registry = CancellationRegistry::new();
        let outcome = registry.request("task-1", Some("completed".to_string()));
        assert_eq!(
            outcome,
            CancelOutcome::AlreadyTerminal {
                status: "completed".to_string()
            }
        );
        // 터미널 태스크에 대해서는 토큰을 만들지도 않는다 — 취소 플래그가 켜지면
        // 이후 롤백 같은 정당한 후속 도구 실행이 막힌다.
        assert!(registry.existing("task-1").is_none());
    }

    #[test]
    fn token_can_be_created_before_task_starts() {
        // 취소 요청이 시작보다 먼저 도착하는 경쟁 상황.
        let registry = CancellationRegistry::new();
        registry.request("task-1", None);
        // 나중에 태스크가 시작하며 토큰을 조회하면 이미 취소된 토큰을 받는다.
        assert!(registry.token("task-1").is_cancelled());
    }

    #[test]
    fn remove_clears_the_token() {
        let registry = CancellationRegistry::new();
        registry.request("task-1", None);
        assert_eq!(registry.active_count(), 1);
        registry.remove("task-1");
        assert_eq!(registry.active_count(), 0);
        assert!(registry.existing("task-1").is_none());
    }

    #[test]
    fn concurrent_cancels_elect_exactly_one_winner() {
        use std::sync::Barrier;
        let token = CancellationToken::new();
        let barrier = Arc::new(Barrier::new(8));
        let winners = Arc::new(AtomicBool::new(false));
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let token = token.clone();
                let barrier = barrier.clone();
                let count = count.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    if token.cancel() {
                        count.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let _ = winners;
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "정확히 한 스레드만 취소를 확정해야 합니다"
        );
    }
}
