use asy_03_retry_backoff::retry::{plan, should_retry, CallError};

#[test]
fn first_attempt_has_no_delay() {
    let p = plan(4, 100, 10_000);
    assert_eq!(p[0].delay_ms, 0, "최초 시도는 기다리지 않아야 합니다");
}

#[test]
fn delay_doubles_each_retry() {
    let p = plan(4, 100, 10_000);
    assert_eq!(p[1].delay_ms, 100);
    assert_eq!(p[2].delay_ms, 200);
    assert_eq!(p[3].delay_ms, 400);
}

#[test]
fn delay_is_capped() {
    let p = plan(6, 100, 250);
    for attempt in &p {
        assert!(attempt.delay_ms <= 250, "상한 250ms를 넘었습니다: {}", attempt.delay_ms);
    }
    assert_eq!(p[5].delay_ms, 250);
}

#[test]
fn permanent_errors_are_not_retried() {
    assert!(should_retry(&CallError::Transient));
    assert!(!should_retry(&CallError::Permanent), "영구 오류를 재시도하면 안 됩니다");
}

#[test]
fn attempt_numbers_are_sequential_from_one() {
    let p = plan(3, 10, 1000);
    assert_eq!(p.iter().map(|a| a.number).collect::<Vec<_>>(), vec![1, 2, 3]);
}
