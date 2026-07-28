use err_03_transaction_rollback::ledger::{Ledger, TransferError};

#[test]
fn successful_transfer_still_works() {
    let mut ledger = Ledger::new(&[("payer", 250), ("payee", 75)]);
    ledger.transfer("payer", "payee", 125).unwrap();
    assert_eq!(ledger.balance("payer"), Some(125));
    assert_eq!(ledger.balance("payee"), Some(200));
    assert_eq!(ledger.total(), 325);
}

#[test]
fn unknown_destination_does_not_debit_source() {
    let mut ledger = Ledger::new(&[("a", 100)]);
    let before = ledger.balance("a");
    let err = ledger.transfer("a", "nope", 40).unwrap_err();
    assert_eq!(err, TransferError::UnknownAccount("nope".to_string()));
    assert_eq!(ledger.balance("a"), before, "출금만 되고 입금이 안 됐습니다");
}

#[test]
fn total_is_conserved_across_failures() {
    let mut ledger = Ledger::new(&[("a", 100), ("b", 50)]);
    let total_before = ledger.total();
    let _ = ledger.transfer("a", "nope", 10);
    let _ = ledger.transfer("a", "b", 1000);
    let _ = ledger.transfer("missing", "b", 5);
    assert_eq!(ledger.total(), total_before, "실패한 이체가 총액을 바꿨습니다");
}

#[test]
fn insufficient_funds_changes_nothing() {
    let mut ledger = Ledger::new(&[("a", 10), ("b", 0)]);
    let err = ledger.transfer("a", "b", 100).unwrap_err();
    assert_eq!(err, TransferError::InsufficientFunds { account: "a".to_string() });
    assert_eq!(ledger.balance("a"), Some(10));
    assert_eq!(ledger.balance("b"), Some(0));
}

#[test]
fn self_transfer_is_a_noop_not_a_duplication() {
    let mut ledger = Ledger::new(&[("a", 100)]);
    ledger.transfer("a", "a", 30).unwrap();
    assert_eq!(ledger.balance("a"), Some(100), "자기 자신에게 이체하면서 잔액이 바뀌었습니다");
}
