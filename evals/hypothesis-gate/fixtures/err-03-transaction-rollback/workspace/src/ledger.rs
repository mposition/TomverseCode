use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub enum TransferError {
    UnknownAccount(String),
    InsufficientFunds { account: String },
}

pub struct Ledger {
    balances: HashMap<String, i64>,
}

impl Ledger {
    pub fn new(accounts: &[(&str, i64)]) -> Self {
        Self {
            balances: accounts.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
        }
    }

    pub fn balance(&self, account: &str) -> Option<i64> {
        self.balances.get(account).copied()
    }

    pub fn total(&self) -> i64 {
        self.balances.values().sum()
    }

    /// 이체. 실패하면 아무것도 바뀌지 않아야 한다.
    pub fn transfer(&mut self, from: &str, to: &str, amount: i64) -> Result<(), TransferError> {
        let from_balance = *self
            .balances
            .get(from)
            .ok_or_else(|| TransferError::UnknownAccount(from.to_string()))?;
        if from_balance < amount {
            return Err(TransferError::InsufficientFunds {
                account: from.to_string(),
            });
        }
        // 출금 먼저.
        self.balances.insert(from.to_string(), from_balance - amount);

        let to_balance = *self
            .balances
            .get(to)
            .ok_or_else(|| TransferError::UnknownAccount(to.to_string()))?;
        self.balances.insert(to.to_string(), to_balance + amount);
        Ok(())
    }
}
