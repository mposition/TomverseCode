use asy_03_retry_backoff::retry::plan;

#[test]
fn plan_has_expected_length() {
    assert_eq!(plan(3, 100, 10_000).len(), 3);
}
