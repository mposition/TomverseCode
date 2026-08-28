//! Fleet — **worktree 격리 기반 N개 병렬 실행**. product-strategy.md 8.2절, M4의 토대.
//!
//! # 이 모듈이 푸는 문제는 병렬 실행이 아니다
//!
//! worktree도(22절) 태스크당 예산도(multi-engine 10.6절) 이미 있다. N개를 동시에 띄우는 것
//! 자체는 스레드 N개면 된다. 어려운 것은 [process-architecture.md 11.2절](../../../../../docs/design/process-architecture.md)이
//! 적어둔 셋이고, 셋 다 이 제품의 원칙에 직접 닿는다. 이 모듈은 그중 **②(합계 지출)** 의
//! 판정을 갖는다 — ①은 `approvals.rs`, ③은 `verify.rs`의 검증 레인이다.
//!
//! # ② 태스크당 상한은 총지출을 통제하지 못한다
//!
//! 상한은 태스크 하나에 걸리는데 N개가 동시에 돌면 사용자가 부담하는 것은 N배다. 그래서
//! **합계 상한을 따로 받고, 예약으로 강제한다.**
//!
//! 사후 검사로는 부족하다 — 이미 쓴 뒤에 아는 것은 상한이 아니다. 그래서 순서를 뒤집는다:
//! 구성원을 시작하기 **전에** 그 구성원이 낼 수 있는 최대 비용(= 태스크당 상한)을 예약하고,
//! 예약할 수 없으면 **시작하지 않는다.** sidecar의 `TaskBudget`이 태스크당 상한을 예약으로
//! 강제하므로(`packages/sidecar/src/orchestrator/budget.ts`) 구성원 하나의 지출은 그 상한을
//! 넘지 않고, 따라서 합계도 넘지 않는다. 같은 규율의 한 층 위 판이다.
//!
//! ## 그래서 합계 상한은 태스크당 상한을 **요구한다**
//!
//! 태스크당 상한이 없으면 구성원 하나가 얼마를 쓸지 알 수 없고, 그러면 예약할 금액이 없다.
//! 그 경우 "합계 상한이 있다"는 말은 거짓이 된다 — 마지막 순간에 사후 검사로 물러나는 것보다
//! **시작 전에 거부하는 편이 정직하다**(`budget.rs`가 같은 이유로 "말하지 않은 것"을 거부한다).
//!
//! # 왜 Fleet 크기에 상한이 있는가
//!
//! 원칙 5("모든 루프에는 상한이 있다"). 상한 없이 N을 받으면 오타 하나가 API 비용과
//! 프로세스 개수를 동시에 폭발시킨다 — 여기서 N은 반복 횟수가 아니라 **동시에 살아 있는
//! sidecar 프로세스 수**이므로 상한이 없으면 머신도 함께 넘어간다.
//!
//! # 모델은 Fleet을 시작할 수 없다
//!
//! `worktree.rs`와 같다(22.3절): 이 모듈에는 `ToolRequest`가 없고 호스트만 부른다. 그리고
//! Fleet의 사실을 남기는 이벤트는 `NODE_MAY_NOT_EMIT`에 있으므로 **sidecar는 그 사실을
//! 기록할 수도 없다.** 모델이 병렬 실행을 띄울 수 있으면 예산 상한도 승인도 우회 가능해진다.

use serde::Serialize;

/// 한 Fleet의 최대 구성원 수 (원칙 5).
///
/// 8인 이유는 "동시에 살아 있는 sidecar 프로세스 + 그 아래 검증 프로세스"의 수이기 때문이다.
/// 정확한 최적값이 아니라 **폭발을 막는 상한**이며, 사용자가 더 필요하면 Fleet을 나눠 돌린다.
pub const MAX_FLEET_SIZE: usize = 8;

/// 한 구성원이 받는 것: 어느 브랜치(=어느 격리 트리)에서 무엇을 할 것인가.
///
/// **하나의 요청을 우리가 N개로 쪼개지 않는다**(8.2절 "작업 분해"는 이후 깊이 확장 열이다).
/// N개를 주는 것은 사용자다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberSpec {
    pub branch: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FleetError {
    /// 구성원이 없다. 빈 Fleet을 성공으로 돌려주면 "돌았는데 아무 일도 없었다"가 된다.
    Empty,
    TooLarge { requested: usize, max: usize },
    /// 같은 브랜치가 두 번 왔다. **격리가 아니게 된다** — 두 구성원이 같은 트리를 쓴다.
    DuplicateBranch { branch: String },
    InvalidBranch { branch: String, reason: String },
    EmptyMessage { branch: String },
    /// 합계 상한은 있는데 태스크당 상한이 없다 — 예약할 금액을 알 수 없다.
    BudgetUnbounded,
    /// 합계 상한이 태스크당 상한보다 작다 — 어떤 구성원도 시작할 수 없다.
    BudgetTooSmall { cap: f64, per_task: f64 },
}

impl std::fmt::Display for FleetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "Fleet에 구성원이 없습니다"),
            Self::TooLarge { requested, max } => write!(
                f,
                "Fleet 크기 상한을 넘었습니다: {requested}개 요청, 최대 {max}개 \
                 (상한이 없으면 오타 하나가 비용과 프로세스를 동시에 폭발시킵니다)"
            ),
            Self::DuplicateBranch { branch } => write!(
                f,
                "브랜치 {branch}가 두 번 왔습니다 — 두 구성원이 같은 격리 트리를 쓰면 격리가 아닙니다"
            ),
            Self::InvalidBranch { branch, reason } => {
                write!(f, "브랜치 이름을 쓸 수 없습니다 ({branch}): {reason}")
            }
            Self::EmptyMessage { branch } => write!(f, "{branch} 구성원에 요청 내용이 없습니다"),
            Self::BudgetUnbounded => write!(
                f,
                "Fleet 합계 상한을 걸려면 태스크당 상한도 있어야 합니다. 구성원 하나가 얼마를 쓸지 \
                 모르면 예약할 금액이 없고, 그러면 합계 상한은 지켜지지 않습니다"
            ),
            Self::BudgetTooSmall { cap, per_task } => write!(
                f,
                "Fleet 합계 상한(${cap})이 태스크당 상한(${per_task})보다 작아 어떤 구성원도 시작할 수 없습니다"
            ),
        }
    }
}

/// 계획된 Fleet. **여기까지 오면 크기·이름·예산이 전부 검증된 상태다.**
#[derive(Debug, Clone)]
pub struct FleetPlan {
    pub fleet_id: String,
    pub members: Vec<MemberSpec>,
    /// 합계 상한(USD). `None`이면 합계 상한 없음 — 사용자가 **명시적으로** 고른 것이다.
    pub cap_usd: Option<f64>,
    /// 태스크당 상한(USD). `None`이면 태스크당 상한 없음.
    pub per_task_usd: Option<f64>,
}

/// Fleet을 계획한다. 실패하면 **아무것도 시작하지 않는다** — worktree도 만들지 않는다.
///
/// 검증을 시작 전에 모아 두는 이유: 세 번째 구성원의 브랜치 이름이 잘못됐다는 것을 두 개가
/// 이미 돈 뒤에 알면, 사용자는 절반만 실행된 Fleet을 손으로 수습해야 한다.
pub fn plan(
    fleet_id: &str,
    members: Vec<MemberSpec>,
    per_task_usd: Option<f64>,
    cap_usd: Option<f64>,
) -> Result<FleetPlan, FleetError> {
    if members.is_empty() {
        return Err(FleetError::Empty);
    }
    if members.len() > MAX_FLEET_SIZE {
        return Err(FleetError::TooLarge {
            requested: members.len(),
            max: MAX_FLEET_SIZE,
        });
    }
    for (i, member) in members.iter().enumerate() {
        // 브랜치 이름 규칙은 **worktree.rs가 정본이다.** 여기서 다시 적으면 두 규칙이 생기고,
        // 그중 하나는 언젠가 덜 검사된다.
        crate::worktree::validate_branch(&member.branch).map_err(|e| match e {
            crate::worktree::WorktreeError::InvalidBranch { branch, reason } => {
                FleetError::InvalidBranch { branch, reason }
            }
            other => FleetError::InvalidBranch {
                branch: member.branch.clone(),
                reason: other.to_string(),
            },
        })?;
        if member.message.trim().is_empty() {
            return Err(FleetError::EmptyMessage {
                branch: member.branch.clone(),
            });
        }
        if members[..i].iter().any(|m| m.branch == member.branch) {
            return Err(FleetError::DuplicateBranch {
                branch: member.branch.clone(),
            });
        }
    }
    match (cap_usd, per_task_usd) {
        (Some(_), None) => return Err(FleetError::BudgetUnbounded),
        (Some(cap), Some(per_task)) if per_task > cap => {
            return Err(FleetError::BudgetTooSmall { cap, per_task })
        }
        _ => {}
    }
    Ok(FleetPlan {
        fleet_id: fleet_id.to_string(),
        members,
        cap_usd,
        per_task_usd,
    })
}

/// 구성원 하나를 시작해도 되는가에 대한 답.
#[derive(Debug, Clone, PartialEq)]
pub enum Admission {
    /// 시작해도 된다. 예약된 금액(합계 상한이 없으면 `None`).
    Admitted { reserved_usd: Option<f64> },
    /// 시작할 수 없다. **지금 도는 구성원이 정산되면 달라질 수 있다.**
    Refused {
        cap_usd: f64,
        committed_usd: f64,
        reserved_usd: f64,
        per_task_usd: f64,
    },
}

/// Fleet 합계 예산 원장 — **예약 후 정산**.
///
/// # 왜 합계 비교만으로 부족한가
///
/// 정산되지 않은 예약이 합계에 나타나지 않기 때문이다. 확정 지출만 보고 판정하면, 지금 도는
/// 구성원들이 아직 쓰지 않은 돈이 없는 것처럼 보여 새 구성원을 들여보내게 된다. 그 순간 상한은
/// **동시에 도는 구성원 수만큼** 초과될 수 있다. (같은 실수를 가설 게이트에서 한 번 했다 —
/// multi-engine-routing.md 10.7절.)
#[derive(Debug, Clone)]
pub struct FleetBudget {
    cap_usd: Option<f64>,
    per_task_usd: Option<f64>,
    /// 정산이 끝난 지출의 누적.
    committed_usd: f64,
    /// 지금 도는 구성원들이 잡아 둔 예약의 합.
    reserved_usd: f64,
    /// 열린 예약 수. 0인데 거부되면 **기다려도 달라지지 않는다.**
    outstanding: usize,
}

impl FleetBudget {
    pub fn new(cap_usd: Option<f64>, per_task_usd: Option<f64>) -> Self {
        Self {
            cap_usd,
            per_task_usd,
            committed_usd: 0.0,
            reserved_usd: 0.0,
            outstanding: 0,
        }
    }

    pub fn from_plan(plan: &FleetPlan) -> Self {
        Self::new(plan.cap_usd, plan.per_task_usd)
    }

    /// 합계 상한을 실제로 강제하고 있는가. **화면과 결과가 이걸 구별해야 한다** —
    /// "상한 안에서 끝났다"와 "상한이 없었다"는 정반대의 사실이다(`BudgetPanel`과 같은 규율).
    pub fn enforced(&self) -> bool {
        self.cap_usd.is_some()
    }

    pub fn cap_usd(&self) -> Option<f64> {
        self.cap_usd
    }

    pub fn per_task_usd(&self) -> Option<f64> {
        self.per_task_usd
    }

    pub fn committed_usd(&self) -> f64 {
        self.committed_usd
    }

    pub fn reserved_usd(&self) -> f64 {
        self.reserved_usd
    }

    pub fn outstanding(&self) -> usize {
        self.outstanding
    }

    /// 구성원 하나를 들여보낼 수 있는가. 가능하면 **그 자리에서 예약한다.**
    pub fn try_admit(&mut self) -> Admission {
        let (Some(cap), Some(per_task)) = (self.cap_usd, self.per_task_usd) else {
            // 합계 상한이 없으면 예약할 것이 없다. 열린 예약 수는 세지 않는다 — 세면
            // "기다리면 달라지는가"의 답이 흐려진다(상한이 없으므로 언제나 들어간다).
            return Admission::Admitted { reserved_usd: None };
        };
        if self.committed_usd + self.reserved_usd + per_task > cap {
            return Admission::Refused {
                cap_usd: cap,
                committed_usd: self.committed_usd,
                reserved_usd: self.reserved_usd,
                per_task_usd: per_task,
            };
        }
        self.reserved_usd += per_task;
        self.outstanding += 1;
        Admission::Admitted {
            reserved_usd: Some(per_task),
        }
    }

    /// 끝난 구성원의 예약을 실제 지출로 바꾼다.
    ///
    /// `actual_usd`는 저장소가 집계한 값이다(**Node의 주장이 아니라 `provider_usage` 행**).
    /// 예약보다 클 수 없지만, 가격을 모르는 모델처럼 집계가 커질 여지가 있는 경우를 위해
    /// 잘라내지 않고 그대로 누적한다 — 상한을 넘긴 사실을 지우는 것이 가장 나쁘다.
    pub fn settle(&mut self, reserved_usd: Option<f64>, actual_usd: f64) {
        if let Some(reserved) = reserved_usd {
            self.reserved_usd = (self.reserved_usd - reserved).max(0.0);
            self.outstanding = self.outstanding.saturating_sub(1);
        }
        if actual_usd.is_finite() && actual_usd > 0.0 {
            self.committed_usd += actual_usd;
        }
    }

    /// 지금 거부됐다면, **기다리면 달라지는가.** 열린 예약이 없으면 달라지지 않는다.
    pub fn waiting_could_help(&self) -> bool {
        self.outstanding > 0
    }
}

/// 한 구성원의 결말. **개별로 보고한다** — N개 중 3개가 실패했을 때 화면이 "완료"로 접으면
/// 이 제품이 파는 것을 파는 행위다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberReport {
    pub index: usize,
    pub branch: String,
    pub task_id: String,
    /// **실제로 시작됐는가.** `false`인 경우는 둘이고 `status`가 그 둘을 가른다:
    /// 합계 상한이나 Fleet 취소로 아예 들어가지 못한 것(`not_started`)과, 들어갔는데
    /// 트리를 만들지 못해 시작에 실패한 것(`failed`). **미시작은 실패가 아니다** —
    /// 사용자가 다음에 할 일이 다르다.
    pub admitted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// `completed` | `failed` | `cancelled` | `rejected` | `not_started`
    pub status: String,
    pub summary: String,
    /// 이 구성원 하나의 지출. **합계가 아니다.**
    pub cost_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl MemberReport {
    pub fn not_started(index: usize, branch: &str, task_id: &str, reason: String) -> Self {
        Self {
            index,
            branch: branch.to_string(),
            task_id: task_id.to_string(),
            admitted: false,
            worktree_path: None,
            status: "not_started".to_string(),
            summary: reason,
            cost_usd: 0.0,
            reserved_usd: None,
            started_at: None,
            finished_at: None,
        }
    }
}

/// **합계는 합계라고 말한다.** 필드 이름에 `fleet`이 들어가는 이유가 그것이다 — 태스크 하나의
/// 지출과 같은 이름으로 부르면 화면이 둘을 구별할 수 없고, 그러면 참인 숫자가 답이 아니게 된다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetTotals {
    pub members: usize,
    pub completed: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub rejected: usize,
    pub not_started: usize,
    /// 구성원 지출의 **합**. 어느 한 태스크의 지출이 아니다.
    pub fleet_cost_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fleet_cap_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_task_cap_usd: Option<f64>,
    /// 합계 상한을 실제로 강제했는가. 없었으면 위 금액은 **집계일 뿐 제약이 아니었다.**
    pub cap_enforced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetReport {
    pub fleet_id: String,
    pub members: Vec<MemberReport>,
    pub totals: FleetTotals,
    /// 검증 레인 계측 (verify.rs). **직렬화를 택했다는 주장의 관측 근거다** — 레인을 지나지
    /// 않았다면 이 수가 구성원 수에 못 미친다.
    ///
    /// **프로세스 전체의 누적이다.** `fleet` 프로세스는 이 Fleet만 돌리므로 지금은 같은 값이지만,
    /// 한 프로세스가 Fleet을 둘 돌리게 되면 그렇지 않다 — 그때 "이 Fleet의 것"이 필요하면
    /// 시작 시점의 값을 빼야 한다. 지금 빼지 않는 이유는 뺀 값이 **더 틀릴 수 있기 때문**이다:
    /// 이 프로세스에 다른 검증이 없다는 사실을 계측이 스스로 말해주는 편이 낫다.
    pub verification_lane: crate::verify::LaneStats,
}

impl FleetReport {
    pub fn build(
        fleet_id: &str,
        members: Vec<MemberReport>,
        budget: &FleetBudget,
        lane: crate::verify::LaneStats,
    ) -> Self {
        let count = |status: &str| members.iter().filter(|m| m.status == status).count();
        let totals = FleetTotals {
            members: members.len(),
            completed: count("completed"),
            failed: count("failed"),
            cancelled: count("cancelled"),
            rejected: count("rejected"),
            not_started: count("not_started"),
            fleet_cost_usd: members.iter().map(|m| m.cost_usd).sum(),
            fleet_cap_usd: budget.cap_usd(),
            per_task_cap_usd: budget.per_task_usd(),
            cap_enforced: budget.enforced(),
        };
        Self {
            fleet_id: fleet_id.to_string(),
            members,
            totals,
            verification_lane: lane,
        }
    }

    /// **전부 완료됐을 때만 참이다.** 부분 실패를 성공으로 접지 않는다.
    pub fn all_completed(&self) -> bool {
        self.totals.members > 0 && self.totals.completed == self.totals.members
    }

    /// 사용자가 반드시 들어야 하는 문장들. 헤드리스와 데스크톱이 **같은 것**을 낸다
    /// (`worktree::Isolation::notices`와 같은 규율 — 각자 적으면 한쪽만 조용해진다).
    pub fn notices(&self) -> Vec<String> {
        let t = &self.totals;
        let mut out = vec![format!(
            "Fleet 합계 지출 ${:.4} — 구성원 {}개의 **합**이며 어느 한 태스크의 금액이 아닙니다.",
            t.fleet_cost_usd, t.members
        )];
        match (t.cap_enforced, t.fleet_cap_usd, t.per_task_cap_usd) {
            (true, Some(cap), Some(per)) => out.push(format!(
                "합계 상한 ${cap:.2}을 강제했습니다(태스크당 상한 ${per:.2} × 예약). 상한이 남지 않으면 새 구성원을 시작하지 않습니다."
            )),
            _ => out.push(
                "**이 Fleet에는 합계 상한이 없었습니다.** 위 금액은 집계한 지출이며, 무언가가 그것을 막고 있었다는 뜻이 아닙니다."
                    .to_string(),
            ),
        }
        if t.not_started > 0 {
            out.push(format!(
                "{}개 구성원은 합계 상한이 남지 않아 **시작되지 않았습니다** — 실패와 다른 결말입니다.",
                t.not_started
            ));
        }
        if t.failed + t.cancelled + t.rejected > 0 {
            out.push(format!(
                "완료 {}개 / 실패 {}개 / 취소 {}개 / 거부 {}개 — 결말은 구성원별로 다릅니다.",
                t.completed, t.failed, t.cancelled, t.rejected
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(branch: &str) -> MemberSpec {
        MemberSpec {
            branch: branch.to_string(),
            message: "고쳐주세요".to_string(),
        }
    }

    fn specs(n: usize) -> Vec<MemberSpec> {
        (0..n).map(|i| spec(&format!("m{i}"))).collect()
    }

    /// **크기 상한이 강제된다** (원칙 5). 상한 없이 N을 받으면 오타 하나가 비용을 폭발시킨다.
    #[test]
    fn the_fleet_size_is_capped() {
        assert!(plan("f", specs(MAX_FLEET_SIZE), Some(1.0), None).is_ok());
        assert_eq!(
            plan("f", specs(MAX_FLEET_SIZE + 1), Some(1.0), None).unwrap_err(),
            FleetError::TooLarge {
                requested: MAX_FLEET_SIZE + 1,
                max: MAX_FLEET_SIZE
            }
        );
    }

    /// 빈 Fleet은 성공이 아니다 — "돌았는데 아무 일도 없었다"가 된다.
    #[test]
    fn an_empty_fleet_is_refused() {
        assert_eq!(plan("f", vec![], None, None).unwrap_err(), FleetError::Empty);
    }

    /// 같은 브랜치가 둘이면 **격리가 아니다.** 두 구성원이 같은 트리에 쓴다.
    #[test]
    fn two_members_may_not_share_a_tree() {
        let err = plan("f", vec![spec("a"), spec("a")], None, None).unwrap_err();
        assert_eq!(
            err,
            FleetError::DuplicateBranch {
                branch: "a".to_string()
            }
        );
    }

    /// 브랜치 이름 규칙은 **worktree.rs에서 온다.** 여기서 다시 적지 않는다.
    #[test]
    fn branch_names_go_through_the_worktree_rule() {
        let err = plan("f", vec![spec("--force")], None, None).unwrap_err();
        assert!(matches!(err, FleetError::InvalidBranch { .. }), "{err:?}");
        assert!(matches!(
            plan("f", vec![spec("feature/x")], None, None).unwrap_err(),
            FleetError::InvalidBranch { .. }
        ));
    }

    /// **합계 상한은 태스크당 상한을 요구한다.** 없으면 예약할 금액을 모르고, 그러면
    /// "합계 상한이 있다"는 말이 거짓이 된다.
    #[test]
    fn an_aggregate_cap_requires_a_per_task_cap() {
        assert_eq!(
            plan("f", specs(2), None, Some(10.0)).unwrap_err(),
            FleetError::BudgetUnbounded
        );
        // 반대 방향은 정상이다 — 태스크당 상한만 있는 것은 종전과 같은 상태다.
        assert!(plan("f", specs(2), Some(1.0), None).is_ok());
    }

    /// 어떤 구성원도 시작할 수 없는 상한은 **시작 전에** 거부한다. 시작한 뒤에 알면 사용자는
    /// worktree만 N개 생긴 결과를 본다.
    #[test]
    fn a_cap_that_admits_nobody_is_refused_up_front() {
        assert_eq!(
            plan("f", specs(2), Some(5.0), Some(3.0)).unwrap_err(),
            FleetError::BudgetTooSmall {
                cap: 3.0,
                per_task: 5.0
            }
        );
    }

    /// **핵심 불변식**: 태스크당 상한이 지켜지면 합계도 지켜진다.
    ///
    /// 예약이 없으면 성립하지 않는다 — 확정 지출만 보고 판정하면 도는 구성원이 아직 쓰지 않은
    /// 돈이 없는 것처럼 보여 새 구성원을 들여보내게 된다.
    #[test]
    fn the_aggregate_cap_is_never_exceeded_even_when_everyone_spends_the_maximum() {
        let mut budget = FleetBudget::new(Some(10.0), Some(3.0));
        let mut admitted = Vec::new();
        // 들여보낼 수 있는 만큼 들여보낸다.
        loop {
            match budget.try_admit() {
                Admission::Admitted { reserved_usd } => admitted.push(reserved_usd),
                Admission::Refused { .. } => break,
            }
        }
        assert_eq!(admitted.len(), 3, "10 / 3 = 3개까지만 동시에 들어간다");
        // 전원이 상한을 꽉 채워 쓴다.
        for reserved in admitted {
            budget.settle(reserved, 3.0);
        }
        assert!((budget.committed_usd() - 9.0).abs() < 1e-9, "{}", budget.committed_usd());
        assert!(budget.committed_usd() <= 10.0);
        // 남은 $1로는 태스크당 상한 $3을 예약할 수 없다 — **새 구성원이 시작되지 않는다.**
        assert!(matches!(budget.try_admit(), Admission::Refused { .. }));
        assert!(!budget.waiting_could_help(), "열린 예약이 없으므로 기다려도 달라지지 않는다");
    }

    /// 거부의 두 가지를 구별한다: **지금 자리가 없다**와 **영원히 자리가 없다**.
    #[test]
    fn a_refusal_says_whether_waiting_would_help() {
        let mut budget = FleetBudget::new(Some(6.0), Some(3.0));
        let a = match budget.try_admit() {
            Admission::Admitted { reserved_usd } => reserved_usd,
            other => panic!("{other:?}"),
        };
        let b = match budget.try_admit() {
            Admission::Admitted { reserved_usd } => reserved_usd,
            other => panic!("{other:?}"),
        };
        assert!(matches!(budget.try_admit(), Admission::Refused { .. }));
        // 둘이 도는 동안은 기다리면 달라진다.
        assert!(budget.waiting_could_help());
        // 싸게 끝나면 자리가 생긴다 — 예약은 최대치였고 실제는 그보다 작을 수 있다.
        budget.settle(a, 0.5);
        budget.settle(b, 0.5);
        assert!(matches!(budget.try_admit(), Admission::Admitted { .. }));
    }

    /// 합계 상한이 없으면 **예약도 없다.** 그리고 그 사실이 결과에 남는다.
    #[test]
    fn without_an_aggregate_cap_nothing_is_reserved_and_the_report_says_so() {
        let mut budget = FleetBudget::new(None, Some(3.0));
        for _ in 0..MAX_FLEET_SIZE {
            assert_eq!(budget.try_admit(), Admission::Admitted { reserved_usd: None });
        }
        assert!(!budget.enforced());
        let report = FleetReport::build("f", vec![], &budget, crate::verify::LaneStats::default());
        assert!(!report.totals.cap_enforced);
        assert!(
            report.notices().iter().any(|n| n.contains("합계 상한이 없었습니다")),
            "{:?}",
            report.notices()
        );
    }

    /// **부분 실패가 조용하면 안 된다.** 합계는 합계라고 말하고, 결말은 개별로 센다.
    #[test]
    fn partial_failure_is_reported_per_member_and_never_folded_into_success() {
        let budget = FleetBudget::new(Some(10.0), Some(3.0));
        let members = vec![
            MemberReport {
                index: 0,
                branch: "a".into(),
                task_id: "t0".into(),
                admitted: true,
                worktree_path: Some("/w/a".into()),
                status: "completed".into(),
                summary: "됨".into(),
                cost_usd: 1.0,
                reserved_usd: Some(3.0),
                started_at: None,
                finished_at: None,
            },
            MemberReport {
                index: 1,
                branch: "b".into(),
                task_id: "t1".into(),
                admitted: true,
                worktree_path: Some("/w/b".into()),
                status: "failed".into(),
                summary: "안 됨".into(),
                cost_usd: 2.0,
                reserved_usd: Some(3.0),
                started_at: None,
                finished_at: None,
            },
            MemberReport::not_started(2, "c", "t2", "합계 상한이 남지 않았습니다".into()),
        ];
        let report = FleetReport::build("f", members, &budget, crate::verify::LaneStats::default());
        assert!(!report.all_completed(), "하나라도 실패하면 완료가 아니다");
        assert_eq!(report.totals.completed, 1);
        assert_eq!(report.totals.failed, 1);
        assert_eq!(report.totals.not_started, 1);
        assert!((report.totals.fleet_cost_usd - 3.0).abs() < 1e-9);
        let notices = report.notices().join("\n");
        assert!(notices.contains("합"), "{notices}");
        assert!(notices.contains("시작되지 않았습니다"), "{notices}");
    }

    /// 시작되지 않은 것은 **실패가 아니다.** 둘을 뭉치면 사용자가 할 일이 달라지는데 화면이
    /// 같은 말을 한다.
    #[test]
    fn not_started_is_not_failed() {
        let r = MemberReport::not_started(0, "a", "t", "예산".into());
        assert_eq!(r.status, "not_started");
        assert!(!r.admitted);
        assert_eq!(r.cost_usd, 0.0);
    }
}
