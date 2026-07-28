use err_03_transaction_rollback::ledger::Ledger;

#[test]
fn transfer_moves_money() {
    let mut ledger = Ledger::new(&[("a", 100), ("b", 0)]);
    ledger.transfer("a", "b", 40).unwrap();
    assert_eq!(ledger.balance("a"), Some(60));
    assert_eq!(ledger.balance("b"), Some(40));
}
