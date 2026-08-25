//! 무인 실행의 **시한** — state-machine 39절.
//!
//! # 왜 Rust가 재는가
//!
//! 무인 실행에는 "언제까지"가 없었다(24.7절). 상한이 하나 있긴 했지만 그것은 **호스트가
//! 기다리기를 그만두는 시각**이었지 태스크가 멈추는 시각이 아니었다 — 그 시각이 지나면 화면은
//! 실패라고 말하는데 sidecar는 계속 돌고, 모델을 부르고, 도구를 요청했다.
//!
//! 그래서 시한은 **Rust가 재고 Rust가 집행한다.** Node가 지키면 장악당한 Node에서 사라지고,
//! 그건 도구 허용목록을 Node가 지키게 두는 것과 같은 종류의 약속이다(원칙 2·26.3절).
//!
//! # 새 정지 메커니즘을 만들지 않는다
//!
//! 시한이 지나면 **우리가 대신 취소를 누른다.** 취소 경로는 이미 세 성질을 만족하도록
//! 만들어져 있고(cancel.rs: idempotent · terminal 이후 무효 · 취소 이후 실행 금지) 자식
//! 프로세스 트리 종료까지 지난다. 새 경로를 만들면 그 세 성질을 다시 증명해야 한다.
//!
//! 대신 **왜 멈췄는지는 뭉개지 않는다.** 24.2절이 "멈춘 것을 거부라고 부르지 않는다"를 정한
//! 것과 같은 이유로, 시한 초과는 사용자 취소와 다른 사실이다 — 기록에 그렇게 남긴다.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::cancel::CancellationRegistry;
use crate::host::EventSink;
use crate::store::Store;
use crate::time::now_iso;

/// 취소 기록에 남는 사유. **사용자 취소와 다른 문자열이어야 한다** — 같으면 감사 기록이
/// "사용자가 취소했다"고 말한다.
pub const REASON: &str = "시한 초과";

/// 얼마나 자주 깨어나 볼 것인가. 시한 자체의 정밀도가 아니라 **끝난 태스크를 얼마나 빨리
/// 알아채는가**를 정한다 — 시한은 마지막 한 번의 판정으로 결정된다.
const POLL: Duration = Duration::from_millis(250);

/// 한 번의 판정. **순수 함수로 떼어 둔다** — 스레드 안에 규칙을 두면 시계를 기다리지 않고는
/// 검사할 수 없다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// 아직이다. 이만큼 자고 다시 본다.
    Wait(Duration),
    /// 시한이 지났다 — 멈춰야 한다.
    Expired,
    /// 태스크가 이미 끝났다. **시한은 끝난 태스크에 대해 아무 말도 하지 않는다.**
    Gone,
}

pub fn tick(elapsed: Duration, limit: Duration, still_running: bool, poll: Duration) -> Verdict {
    // **끝난 것이 먼저다.** 순서를 뒤집으면 시한과 완료가 같은 순간에 겹쳤을 때 완료된
    // 태스크를 "시한 초과"로 기록한다.
    if !still_running {
        return Verdict::Gone;
    }
    if elapsed >= limit {
        return Verdict::Expired;
    }
    Verdict::Wait(std::cmp::min(limit - elapsed, poll))
}

/// 한 태스크의 시한 감시.
///
/// **`TaskHost`를 통째로 들지 않는다.** 필요한 것은 셋뿐이고(취소 신호·저장 계층·화면 릴레이)
/// 전부 `Arc`다 — 호스트를 들면 감시가 호스트 수명에 묶이고, 검사도 호스트를 세워야 한다.
pub struct Watch {
    cancels: Arc<CancellationRegistry>,
    store: Arc<Mutex<Store>>,
    sink: Arc<dyn EventSink>,
    task_id: String,
    limit: Duration,
}

impl Watch {
    pub fn new(
        cancels: Arc<CancellationRegistry>,
        store: Arc<Mutex<Store>>,
        sink: Arc<dyn EventSink>,
        task_id: &str,
        limit: Duration,
    ) -> Self {
        Self {
            cancels,
            store,
            sink,
            task_id: task_id.to_string(),
            limit,
        }
    }

    /// 감시를 시작한다. 태스크가 끝나면 스스로 물러난다.
    ///
    /// **토큰을 여기서 만든다.** 없으면 첫 판정이 곧바로 `Gone`이 되어(토큰의 부재 = 끝난
    /// 태스크) 감시가 시작하자마자 사라진다.
    pub fn arm(self) {
        let _ = self.cancels.token(&self.task_id);
        std::thread::spawn(move || self.run(Instant::now()));
    }

    fn run(self, started: Instant) {
        loop {
            // 토큰이 사라졌다는 것은 `release_task`가 불렸다는 뜻이고, 그건 터미널 도달이다.
            let running = self.cancels.existing(&self.task_id).is_some();
            match tick(started.elapsed(), self.limit, running, POLL) {
                Verdict::Wait(nap) => std::thread::sleep(nap),
                Verdict::Gone => return,
                Verdict::Expired => {
                    self.expire(started.elapsed());
                    return;
                }
            }
        }
    }

    /// 시한이 지났다 — 취소를 대신 누르고 **왜인지를 남긴다.**
    ///
    /// 반환값은 실제로 멈췄는가다. 이미 터미널이면 아무것도 하지 않는다 — DB가 진실이고,
    /// 메모리의 시계가 DB를 이기면 끝난 태스크의 기록이 나중에 바뀐다.
    fn expire(&self, elapsed: Duration) -> bool {
        let recorded = {
            let mut guard = self.store.lock().unwrap();
            guard.record_cancellation_request(&self.task_id, REASON)
        };
        match recorded {
            // 이미 터미널이거나 모르는 태스크. 시한은 여기서 아무 말도 하지 않는다.
            Err(_) => return false,
            // **저장된 payload를 그대로 릴레이한다.** 여기서 다시 만들면 `requestedAt`이
            // 기록과 갈리고, 감사 화면과 DB가 다른 시각을 말한다.
            Ok(Some((appended, payload))) => {
                self.relay("CANCELLATION_REQUESTED", &payload, appended.event_id, appended.seq)
            }
            // 이미 취소가 요청되어 있었다(사용자가 눌렀다). 토큰만 확실히 세운다.
            Ok(None) => {}
        }
        self.cancels.token(&self.task_id).cancel();

        // **왜 멈췄는가**는 따로 남긴다. `CANCELLATION_REQUESTED`의 사유 문자열만으로는
        // 상한값을 알 수 없고, 상한값이 없으면 사용자는 다음에 얼마로 올려야 하는지 모른다.
        let payload = json!({
            "limitMs": self.limit.as_millis() as u64,
            "elapsedMs": elapsed.as_millis() as u64,
        });
        let appended = {
            let mut guard = self.store.lock().unwrap();
            guard.append_event(&self.task_id, "TASK_DEADLINE_EXCEEDED", &payload)
        };
        if let Ok(appended) = appended {
            self.relay("TASK_DEADLINE_EXCEEDED", &payload, appended.event_id, appended.seq);
        }
        true
    }

    fn relay(&self, event_type: &str, payload: &serde_json::Value, event_id: i64, seq: i64) {
        self.sink.emit(
            "task-event",
            &json!({
                "taskId": self.task_id,
                "eventId": event_id,
                "seq": seq,
                "type": event_type,
                "payload": payload,
                "createdAt": now_iso(),
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_task_is_never_reported_as_out_of_time() {
        // **끝난 것이 시한보다 먼저다.** 뒤집으면 완료와 시한이 같은 순간에 겹쳤을 때
        // 완료된 태스크가 "시한 초과"로 기록된다.
        assert_eq!(
            tick(Duration::from_secs(99), Duration::from_secs(1), false, POLL),
            Verdict::Gone
        );
    }

    #[test]
    fn the_wait_never_overshoots_the_limit() {
        // 남은 시간이 poll보다 짧으면 **남은 만큼만** 잔다. poll만큼 자면 시한이 그만큼
        // 늦게 걸리고, 그 오차는 사용자가 적은 숫자와 다른 값이 된다.
        let nap = match tick(Duration::from_millis(900), Duration::from_secs(1), true, POLL) {
            Verdict::Wait(d) => d,
            other => panic!("{other:?}"),
        };
        assert_eq!(nap, Duration::from_millis(100));
    }

    #[test]
    fn reaching_the_limit_expires() {
        assert_eq!(
            tick(Duration::from_secs(1), Duration::from_secs(1), true, POLL),
            Verdict::Expired
        );
    }
}
