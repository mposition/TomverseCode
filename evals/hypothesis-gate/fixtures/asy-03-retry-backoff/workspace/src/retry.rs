#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// 다시 시도하면 성공할 수 있다
    Transient,
    /// 다시 시도해도 같다 — 즉시 포기해야 한다
    Permanent,
}

pub struct Attempt {
    pub number: u32,
    pub delay_ms: u64,
}

/// 재시도 계획을 만든다. `max_attempts`는 최초 시도를 포함한다.
pub fn plan(max_attempts: u32, base_delay_ms: u64, _max_delay_ms: u64) -> Vec<Attempt> {
    let mut out = Vec::new();
    for number in 1..=max_attempts {
        out.push(Attempt {
            number,
            delay_ms: base_delay_ms,
        });
    }
    out
}

/// 오류를 보고 재시도할지 결정한다.
pub fn should_retry(_error: &CallError) -> bool {
    true
}
