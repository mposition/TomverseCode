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
use serde_json::{json, Value};

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

impl FleetPlan {
    /// 이 Fleet에 실제로 걸린 상한. **기록에 남길 값이다.**
    pub fn caps(&self) -> FleetCaps {
        FleetCaps {
            fleet_cap_usd: self.cap_usd,
            per_task_cap_usd: self.per_task_usd,
        }
    }
}

/// 이 Fleet에 걸린 상한 — **기록에 남는다.**
///
/// # 왜 이벤트에 적는가
///
/// 화면이 "합계 상한이 강제됐는가"에 답하려면 **적용된 값**을 알아야 하고, 그 값은 화면의
/// 폼이 아니라 Rust가 고정한 이벤트에서 와야 한다(state-machine 37절). 요청한 것과 적용된
/// 것은 갈릴 수 있고, 폼으로 만들면 화면이 틀린 답을 자신 있게 말한다.
///
/// 그리고 남기지 않으면 기록을 읽는 쪽은 **"상한이 없었다"와 "상한을 모른다"를 구별할 수
/// 없다.** 그 둘은 정반대의 사실이다 — 앞은 사용자가 고른 것이고 뒤는 우리가 답할 수 없는
/// 것이다(`BudgetPanel`과 같은 규율).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetCaps {
    pub fleet_cap_usd: Option<f64>,
    pub per_task_cap_usd: Option<f64>,
}

/// `FLEET_ENROLLED` 페이로드 — **두 진입점이 같은 것을 쓴다.**
///
/// 헤드리스 호스트와 데스크톱이 각자 `json!`을 적으면 키가 갈라지고, 갈라진 쪽을 읽는 화면은
/// 한쪽 경로에서만 조용히 빈 값을 본다. 그리고 그 빈 값은 "상한이 없었다"로 읽힌다 —
/// 위 `FleetCaps` 주석이 말하는 바로 그 혼동이다.
pub struct Enrollment<'a> {
    pub fleet_id: &'a str,
    pub spec: &'a MemberSpec,
    /// 0부터 세는 색인. 페이로드에는 **1부터**로 나간다 — 화면에 "2/4"로 그대로 실린다.
    pub index: usize,
    pub fleet_size: usize,
    pub caps: FleetCaps,
    /// 실제로 들어갔는가. `false`면 아래 `reason`이 왜 못 들어갔는지 말한다.
    pub admitted: bool,
    pub reserved_usd: Option<f64>,
    pub worktree_path: Option<String>,
    /// 이미 있던 트리를 다시 쓴 것인가. 새로 만든 것과 다른 사실이다(worktree.rs).
    pub reused_tree: bool,
    /// 들어가지 못한 이유. 들어간 구성원에는 없다.
    pub reason: Option<&'a str>,
}

impl Enrollment<'_> {
    pub fn payload(&self) -> Value {
        let mut payload = json!({
            "fleetId": self.fleet_id,
            "branch": self.spec.branch,
            "memberIndex": self.index + 1,
            "fleetSize": self.fleet_size,
            "admitted": self.admitted,
            // **객체가 있다는 것 자체가 "기록됐다"이다.** 값이 `null`인 것과 키가 없는 것을
            // 화면이 구별해야 하므로, 두 값을 최상위에 흩뿌리지 않고 한 객체로 묶는다.
            "caps": self.caps,
            // 구성원이 도는 **경로의 종류** — state-machine 72.2.3절.
            //
            // Fleet은 변경 태스크를 병렬로 돌리는 장치다: `MemberSpec`에 종류 축이 없고,
            // 질문이나 계획 모드를 N개 띄우는 입구도 없다. 그래도 **값으로 적는다** —
            // 화면의 단계 매핑이 `(kind, complexityTier)`를 받으므로, 적지 않으면 화면이
            // 기본값을 추측하게 되고 그 추측은 종류 축이 늘어나는 날 조용히 틀린다.
            "kind": "change",
        });
        let object = payload.as_object_mut().expect("방금 만든 객체");
        if let Some(reserved) = self.reserved_usd {
            object.insert("reservedUsd".to_string(), json!(reserved));
        }
        if let Some(path) = &self.worktree_path {
            object.insert("worktreePath".to_string(), json!(path));
            object.insert("reusedTree".to_string(), json!(self.reused_tree));
        }
        if let Some(reason) = self.reason {
            object.insert("reason".to_string(), json!(reason));
        }
        payload
    }
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
    /// 시작해도 된다. **지금 잡은 금액**(합계 상한이 없으면 `None`).
    ///
    /// 72.12절 뒤로 이 값은 태스크당 상한 전부가 아니라 **계획 단계 몫**이다. 나머지는
    /// 계획이 승인될 때 [`FleetBudget::reserve_implementation`]이 잡는다.
    Admitted { reserved_usd: Option<f64> },
    /// 시작할 수 없다. **지금 도는 구성원이 정산되면 달라질 수 있다.**
    Refused {
        cap_usd: f64,
        committed_usd: f64,
        reserved_usd: f64,
        per_task_usd: f64,
    },
}

/// 계획 승인 시점에 나머지를 **확정한** 결과 — 72.12절.
#[derive(Debug, Clone, PartialEq)]
pub enum ImplementationStage {
    /// 확정할 것이 없다: 합계 상한이 없거나, 이 구성원이 예약을 갖고 있지 않다.
    /// **"0을 잡았다"가 아니다** — 없는 것과 0은 다른 사실이다(`budget.rs`의 같은 규율).
    NotTracked,
    /// 나머지를 카드 금액으로 줄였다. `freed_usd`는 **다른 구성원이 쓸 수 있게 된 금액**이다.
    ///
    /// `priced`가 거짓이면 카드가 금액으로 말하지 못한 배정이 있었다는 뜻이고, 그 경우
    /// 나머지를 **줄이지 않는다** — 모르는 것을 0으로 보는 것이 가장 위험하다.
    Staged {
        held_usd: f64,
        freed_usd: f64,
        priced: bool,
    },
    /// 이미 확정돼 다시 하지 않았다. 같은 승인이 두 번 관측돼도 예약이 두 번 움직이지 않는다.
    AlreadyStaged,
}

/// 구성원 하나가 **계획 단계에** 잡는 몫의 비율 — 72.12절의 "예약을 단계로 나눈다".
///
/// **측정값이 아니다.** `PlanOutline`에는 patch가 없으므로 계획 호출이 구현보다 싸다는 것만
/// 확실하고, 얼마나 싼지는 모델·분해 수에 따라 달라진다. 가설 게이트가 실제 계획/구현 비용
/// 비를 낼 수 있는 자리다(72.16절).
///
/// 이 값이 틀려도 **상한은 깨지지 않는다.** 입장 판정은 두 몫의 **합**(= 태스크당 상한)을
/// 보기 때문이다 — 비율은 *어디까지가 계획 몫인가*만 가른다.
pub const PLANNING_SHARE: f64 = 0.25;

/// 구성원 하나가 잡고 있는 금액. 단계로 나뉘어 있고, **둘의 합이 이 구성원의 노출**이다.
#[derive(Debug, Clone, Copy, Default)]
struct Held {
    planning_usd: f64,
    /// 아직 확정되지 않은 구현 몫. 입장 시점에는 *태스크당 상한 − 계획 몫*이고, 계획이
    /// 승인되면 **승인 카드가 보여준 금액으로 줄어든다.**
    remainder_usd: f64,
    /// 승인 시점에 확정됐는가. 두 번 확정하지 않기 위한 표시다.
    staged: bool,
}

impl Held {
    fn total(&self) -> f64 {
        self.planning_usd + self.remainder_usd
    }
}

/// Fleet 합계 예산 원장 — **예약 후 정산**.
///
/// # 왜 합계 비교만으로 부족한가
///
/// 정산되지 않은 예약이 합계에 나타나지 않기 때문이다. 확정 지출만 보고 판정하면, 지금 도는
/// 구성원들이 아직 쓰지 않은 돈이 없는 것처럼 보여 새 구성원을 들여보내게 된다. 그 순간 상한은
/// **동시에 도는 구성원 수만큼** 초과될 수 있다. (같은 실수를 가설 게이트에서 한 번 했다 —
/// multi-engine-routing.md 10.7절.)
///
/// # 예약은 **단계로** 나뉜다 (72.12절)
///
/// 구성원이 사용자 게이트 앞에서 사람을 기다리는 동안 태스크당 상한 전부가 잠겨 있으면,
/// Fleet 병렬성이 사람의 대기 시간만큼 죽는다. 그래서 예약을 계획 몫과 구현 몫으로 나눈다.
///
/// ## 나누되 **합은 줄이지 않는다** — 입장 판정에서는
///
/// 처음 쓴 것은 "입장 시점에 계획 몫만 잡는다"였고, `the_aggregate_cap_is_never_exceeded…`가
/// 그것을 즉시 잡았다: 상한 $10 / 태스크당 $3에 구성원이 **10개** 들어갔다. 잡아 둔 금액만
/// 세면 아직 오지 않은 구현 비용이 없는 것처럼 보이고, 그건 이 모듈 머리말이 경계한 바로 그
/// 실수를 한 층 위에서 되풀이하는 것이다. **측정하지 않은 상수(`PLANNING_SHARE`)가 상한의
/// 뜻을 정하게 두지 않는다.**
///
/// 그래서 입장 판정이 보는 것은 두 몫의 **합**, 즉 태스크당 상한 전부다. 이 점에서 판정은
/// 분할 이전과 한 글자도 다르지 않고, **합계 상한은 그대로 딱딱하다.**
///
/// ## 그러면 분할이 실제로 버는 것은 무엇인가
///
/// **태스크당 상한과 계획의 실제 비용 사이의 차액이다.** 승인 카드는 그 계획이 얼마나 들지를
/// 금액으로 말하고([`ImplementationStage`]), 그 금액은 거의 언제나 태스크당 상한보다 훨씬
/// 작다. 승인 시점에 구현 몫을 **카드 금액으로 줄이면** 그 차액이 즉시 다른 구성원에게
/// 열린다 — 분할 이전에는 그 돈이 태스크가 끝날 때까지 잠겨 있었다.
///
/// 이 방향은 [`reserve_implementation`](Self::reserve_implementation)이 노출을 **줄이기만**
/// 한다는 뜻이기도 하다. 그래서 그 함수는 거절할 일이 없고(72.12절: *"사용자가 승인한 작업이
/// 돈이 없어 멈추는 것은 잠기는 것보다 나쁘다"*), 승인된 작업이 예산 때문에 서는 경로도,
/// 서로의 정산을 기다리는 교착도 생기지 않는다.
///
/// **카드가 금액으로 말하지 못하면 줄이지 않는다.** 가격을 모르는 배정이 섞인 카드에서
/// 모르는 부분을 0으로 보면, 그 순간 상한이 조용히 사라진다.
#[derive(Debug, Clone)]
pub struct FleetBudget {
    cap_usd: Option<f64>,
    per_task_usd: Option<f64>,
    /// 정산이 끝난 지출의 누적.
    committed_usd: f64,
    /// 구성원별로 지금 잡고 있는 금액. **스케줄러가 금액을 들고 다니지 않는다** — 화면과
    /// 헤드리스 두 루프가 각자 더하면 언젠가 갈리고, 갈린 예산은 화면에서 드러나지 않는다.
    held: std::collections::BTreeMap<usize, Held>,
    /// 승인 시점에 **다른 구성원에게 열어준** 금액의 누적. 이 분할이 실제로 무언가를 했다는
    /// 유일한 관측 근거다 — 0이면 아무것도 벌지 못했다는 뜻이고, 그 사실도 사실이다.
    staging_freed_usd: f64,
}

impl FleetBudget {
    pub fn new(cap_usd: Option<f64>, per_task_usd: Option<f64>) -> Self {
        Self {
            cap_usd,
            per_task_usd,
            committed_usd: 0.0,
            held: std::collections::BTreeMap::new(),
            staging_freed_usd: 0.0,
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
        self.held.values().map(Held::total).sum()
    }

    /// 승인 시점의 확정으로 다른 구성원에게 열어준 금액의 누적. **결과가 이걸 말해야 한다** —
    /// 0이면 단계 분할이 이 Fleet에서는 아무것도 벌지 못했다는 뜻이다.
    pub fn staging_freed_usd(&self) -> f64 {
        self.staging_freed_usd
    }

    pub fn outstanding(&self) -> usize {
        self.held.len()
    }

    /// 이 구성원이 지금 잡고 있는 금액. 정산 이벤트와 보고서가 **여기서** 읽는다.
    pub fn held_for(&self, member: usize) -> Option<f64> {
        self.held.get(&member).map(Held::total)
    }

    /// 구성원 하나를 들여보낼 수 있는가. 가능하면 **그 자리에서 예약한다.**
    ///
    /// 판정도 예약도 태스크당 상한 **전부**다 — 위 머리말의 이유. 나뉘는 것은 그 금액이
    /// 계획 몫과 구현 몫으로 **표시되는 방식**이고, 구현 몫은 승인 때 줄어든다.
    pub fn try_admit(&mut self, member: usize) -> Admission {
        let (Some(cap), Some(per_task)) = (self.cap_usd, self.per_task_usd) else {
            // 합계 상한이 없으면 예약할 것이 없다. 열린 예약으로 세지 않는다 — 세면
            // "기다리면 달라지는가"의 답이 흐려진다(상한이 없으므로 언제나 들어간다).
            return Admission::Admitted { reserved_usd: None };
        };
        let reserved = self.reserved_usd();
        if self.committed_usd + reserved + per_task > cap {
            return Admission::Refused {
                cap_usd: cap,
                committed_usd: self.committed_usd,
                reserved_usd: reserved,
                per_task_usd: per_task,
            };
        }
        let planning = per_task * PLANNING_SHARE;
        self.held.insert(
            member,
            Held {
                planning_usd: planning,
                remainder_usd: per_task - planning,
                staged: false,
            },
        );
        Admission::Admitted {
            reserved_usd: Some(per_task),
        }
    }

    /// 계획이 승인됐다 — **구현 몫을 카드 금액으로 확정한다**(72.12절).
    ///
    /// `estimated_usd`는 승인 카드가 보여준 금액이고, `priced`는 그 카드의 모든 배정이
    /// 금액으로 환산됐는가다(`unpricedAssignments`가 비어 있는가). **거절하지 않는다** —
    /// 이 함수는 노출을 줄이기만 하므로 거절할 일이 없고, 그래서 72.12절이 거부한 결말
    /// (*"승인한 작업이 돈이 없어 멈춘다"*)도 교착도 생기지 않는다.
    ///
    /// 줄이지 않는 경우가 둘이다: 카드가 금액으로 말하지 못했을 때(`priced == false`),
    /// 그리고 카드 금액이 남은 몫보다 클 때. 뒤쪽은 **올려 잡지 않는다**는 뜻이기도 하다 —
    /// 구성원 하나의 지출은 자기 `TaskBudget`이 태스크당 상한으로 막는다.
    pub fn reserve_implementation(
        &mut self,
        member: usize,
        estimated_usd: Option<f64>,
        priced: bool,
    ) -> ImplementationStage {
        if self.cap_usd.is_none() || self.per_task_usd.is_none() {
            return ImplementationStage::NotTracked;
        }
        let Some(held) = self.held.get_mut(&member) else {
            return ImplementationStage::NotTracked;
        };
        if held.staged {
            return ImplementationStage::AlreadyStaged;
        }
        held.staged = true;
        let before = held.remainder_usd;
        // **모르는 것을 0으로 보지 않는다.** 그 순간 상한이 조용히 사라진다.
        let target = match estimated_usd {
            Some(usd) if priced && usd.is_finite() && usd >= 0.0 => usd.min(before),
            _ => before,
        };
        held.remainder_usd = target;
        let freed = before - target;
        if freed > 0.0 {
            self.staging_freed_usd += freed;
        }
        ImplementationStage::Staged {
            held_usd: held.total(),
            freed_usd: freed,
            priced,
        }
    }

    /// 끝난 구성원의 예약을 실제 지출로 바꾼다.
    ///
    /// `actual_usd`는 저장소가 집계한 값이다(**Node의 주장이 아니라 `provider_usage` 행**).
    /// 예약보다 클 수 없지만, 가격을 모르는 모델처럼 집계가 커질 여지가 있는 경우를 위해
    /// 잘라내지 않고 그대로 누적한다 — 상한을 넘긴 사실을 지우는 것이 가장 나쁘다.
    pub fn settle(&mut self, member: usize, actual_usd: f64) {
        self.held.remove(&member);
        if actual_usd.is_finite() && actual_usd > 0.0 {
            self.committed_usd += actual_usd;
        }
    }

    /// 지금 거부됐다면, **기다리면 달라지는가.** 열린 예약이 없으면 달라지지 않는다.
    pub fn waiting_could_help(&self) -> bool {
        !self.held.is_empty()
    }
}

/// 구성원의 이벤트 흐름에서 `PLAN_APPROVED` **하나만** 골라 스케줄러에 알린다 — 72.12절.
///
/// # 왜 이 자리가 공유 코드인가
///
/// 합계 예약을 단계로 나누려면 스케줄러가 "이 구성원이 승인을 받았다"를 알아야 하는데, 그
/// 사실이 흐르는 곳은 구성원마다 하나씩인 `EventSink`다. 그 감시를 화면(`session.rs`)과
/// 헤드리스(`bin/host.rs`) 두 루프에 각각 적으면 **둘이 갈리고, 갈린 예산은 화면에서 드러나지
/// 않는다**(72.16절이 이 변경을 한 번에 하라고 적은 이유). 그래서 감시는 여기 하나뿐이고 두
/// 루프는 알림 콜백만 다르게 준다.
///
/// # 왜 이 신호를 믿어도 되는가
///
/// `PLAN_APPROVED`는 `NODE_MAY_NOT_EMIT`이다(`host.rs`) — Rust만 기록할 수 있으므로,
/// 장악당한 sidecar가 승인을 꾸며 **구현 예산을 스스로 열 수 없다.** 신호의 출처가 곧
/// 승인 자체의 출처다.
pub struct PlanApprovalWatch {
    inner: std::sync::Arc<dyn crate::host::EventSink>,
    index: usize,
    notify: Box<dyn Fn(PlanApproved) + Send + Sync>,
}

/// 감시가 스케줄러에 건네는 것 — **승인 카드가 말한 금액**까지 함께다.
///
/// 금액이 없으면 `FleetBudget`이 구현 몫을 줄이지 않는다. 그래서 "얼마인지 모른다"와
/// "0달러다"를 여기서부터 구별해 둔다.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanApproved {
    pub index: usize,
    pub estimated_cost_usd: Option<f64>,
    /// 카드의 모든 배정이 금액으로 환산됐는가(`unpricedAssignments`가 비어 있는가).
    pub priced: bool,
}

impl PlanApprovalWatch {
    pub fn new(
        inner: std::sync::Arc<dyn crate::host::EventSink>,
        index: usize,
        notify: Box<dyn Fn(PlanApproved) + Send + Sync>,
    ) -> Self {
        Self { inner, index, notify }
    }

    /// 이 payload가 계획 승인인가. **채널과 타입을 둘 다 본다** — 타입만 보면 다른 채널의
    /// 같은 이름이 예산을 열 수 있다.
    fn plan_approved(&self, channel: &str, payload: &Value) -> Option<PlanApproved> {
        if channel != "task-event" {
            return None;
        }
        if payload.get("type").and_then(Value::as_str) != Some("PLAN_APPROVED") {
            return None;
        }
        let body = payload.get("payload").unwrap_or(payload);
        // **환산되지 않은 배정이 하나라도 있으면 금액으로 말할 수 없다**(72.4절의 카드와
        // 같은 규율). 목록을 읽지 못한 경우도 같게 다룬다 — 모르는 것을 "없음"으로 보지 않는다.
        let priced = match body.get("unpricedAssignments") {
            Some(Value::Array(items)) => items.is_empty(),
            Some(Value::Null) | None => false,
            _ => false,
        };
        Some(PlanApproved {
            index: self.index,
            estimated_cost_usd: body.get("estimatedCostUsd").and_then(Value::as_f64),
            priced,
        })
    }
}

impl crate::host::EventSink for PlanApprovalWatch {
    fn emit(&self, channel: &str, payload: &Value) {
        // **먼저 흘려보낸다.** 알림이 스케줄러를 깨워 이 구성원의 상태를 읽을 수 있으므로,
        // 이벤트가 화면에 닿기 전에 깨우면 화면과 예산이 서로 다른 순간을 말한다.
        self.inner.emit(channel, payload);
        if let Some(approved) = self.plan_approved(channel, payload) {
            // 두 번 와도 안전하다 — `FleetBudget::reserve_implementation`이 멱등이다.
            (self.notify)(approved);
        }
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
    /// 계획 승인 때 구현 몫을 카드 금액으로 확정하며 **다른 구성원에게 열어준** 금액의
    /// 누적(72.12절). 0이면 단계 분할이 이 Fleet에서는 아무것도 벌지 못했다는 뜻이고,
    /// 그 사실도 사실이다 — **예약이지 지출이 아니다.**
    pub fleet_staging_freed_usd: f64,
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
            fleet_staging_freed_usd: budget.staging_freed_usd(),
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
        if t.fleet_staging_freed_usd > 0.0 {
            out.push(format!(
                "계획이 승인될 때 구현 예산을 카드 금액으로 확정해 ${:.4}을 다른 구성원에게 열어주었습니다 \
(72.12절). **예약이지 지출이 아닙니다** — 합계 상한은 그대로 강제됐습니다.",
                t.fleet_staging_freed_usd
            ));
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

/// 한 구성원의 결말을 **하나의 값으로** 부른다.
///
/// # 왜 `final_status`를 그대로 쓰지 않는가
///
/// 두 가지가 빠지기 때문이다. ① 시작조차 못 한 구성원은 `REJECTED`로 확정되지만 **거부가
/// 아니다** — 사용자가 다음에 할 일이 다르다(`admitted`가 그것을 가른다). ② 아직 끝나지
/// 않은 구성원은 `final_status`가 없는데, 그것을 "결말 없음"으로 화면에 흘리면 **끝난 것과
/// 같은 자리에 빈칸으로** 그려진다. 도는 것은 결말이 아니라 진행이고, 그 사실이 값에
/// 있어야 화면이 "완료"로 접지 않는다.
pub fn member_status(admitted: bool, final_status: Option<&str>) -> &'static str {
    if !admitted {
        return "not_started";
    }
    match final_status {
        None => "running",
        Some("COMPLETED") => "completed",
        Some("FAILED") => "failed",
        Some("CANCELLED") => "cancelled",
        Some("REJECTED") => "rejected",
        Some("INTERRUPTED") => "interrupted",
        // 모르는 값을 "실패"로 접지 않는다 — 접으면 새 종착지가 생길 때마다 화면이
        // **말없이 틀린 답**을 한다.
        Some(_) => "unknown",
    }
}

/// 기록에서 유도한 구성원 하나.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberStatus {
    pub task_id: String,
    pub branch: String,
    pub member_index: usize,
    pub fleet_size: usize,
    pub admitted: bool,
    /// `completed`|`failed`|`cancelled`|`rejected`|`interrupted`|`not_started`|`running`|`unknown`
    pub status: String,
    pub phase: String,
    /// 이 구성원이 도는 경로 — `phaseToStage`의 선택자(72.2.3절). 기록에 없으면 `change`다.
    pub kind: String,
    /// TRIAGE의 판정. **`None`은 "아직 판정 전"이지 `simple`이 아니다** — 뭉개면 시작 직후의
    /// 구성원이 전부 짧은 진행바로 그려진다.
    #[serde(rename = "complexityTier")]
    pub complexity_tier: Option<String>,
    /// **이 구성원 하나의 지출.** 합계가 아니다 — 이름이 그것을 말한다.
    pub cost_usd: f64,
    /// 가격을 모르는 모델로 나간 호출 수. 있으면 위 금액은 **하한이다.**
    pub unpriced_calls: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub created_at: String,
}

/// 기록에서 유도한 Fleet 하나 — **화면과 CLI가 같은 함수를 읽는다.**
///
/// 종전에는 `fleet-status`가 CLI 안에서 구성원 비용을 더했다. 화면이 같은 것을 물으려면
/// 그 덧셈이 한 벌 더 생기고, **두 벌은 갈라진다.** 갈라진 쪽이 합계 상한을 말하지 않으면
/// 화면은 "상한 안에서 끝났다"를 근거 없이 말하게 된다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    pub fleet_id: String,
    pub members: Vec<MemberStatus>,
    /// 구성원 지출의 **합**. 어느 한 태스크의 지출이 아니다.
    pub fleet_cost_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fleet_cap_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_task_cap_usd: Option<f64>,
    /// 상한을 **기록에서 읽을 수 있었는가.** 거짓이면 위 두 값이 없는 이유는 "상한이
    /// 없었다"가 아니라 "이 기록이 상한을 남기기 전의 것이다"이다.
    pub caps_recorded: bool,
    /// 아직 확정되지 않은 구성원. 크래시로 죽은 것은 `recover`가 `INTERRUPTED`로 확정하며,
    /// 그전까지는 "확정되지 않았다"가 정직한 답이다.
    pub unfinished_task_ids: Vec<String>,
    /// 첫 구성원이 등록된 시각. 목록을 최신순으로 세우는 기준이다.
    pub started_at: String,
}

/// 저장소에서 Fleet 상태를 읽는다. **최신 Fleet이 앞에 온다.**
///
/// 비용은 `provider_usage` 행에서 온다 — Node의 주장이 아니다(11.7①).
pub fn collect_status(
    store: &crate::store::Store,
    fleet_id: Option<&str>,
) -> Result<Vec<FleetStatus>, String> {
    let rows = store
        .fleet_members(fleet_id)
        .map_err(|e| format!("Fleet 기록을 읽을 수 없습니다: {e}"))?;

    let mut order: Vec<String> = Vec::new();
    let mut grouped: std::collections::HashMap<String, FleetStatus> = std::collections::HashMap::new();
    for row in rows {
        let entry = grouped.entry(row.fleet_id.clone()).or_insert_with(|| {
            order.push(row.fleet_id.clone());
            FleetStatus {
                fleet_id: row.fleet_id.clone(),
                members: Vec::new(),
                fleet_cost_usd: 0.0,
                fleet_cap_usd: None,
                per_task_cap_usd: None,
                caps_recorded: false,
                unfinished_task_ids: Vec::new(),
                started_at: row.created_at.clone(),
            }
        });
        // **비용을 읽지 못한 것을 0으로 적지 않는다.** 0은 "안 썼다"이고, 여기서 필요한 것은
        // "모른다"이다 — 그래서 읽기 실패는 가격 미상 호출과 같은 취급을 받는다(하한 표시).
        let (cost_usd, _, unpriced) = match store.task_cost_usd(&row.task_id) {
            Ok(v) => v,
            Err(_) => (0.0, 0, 1),
        };
        if let Some(caps) = row.caps {
            entry.caps_recorded = true;
            entry.fleet_cap_usd = caps.fleet_cap_usd;
            entry.per_task_cap_usd = caps.per_task_cap_usd;
        }
        if row.final_status.is_none() {
            entry.unfinished_task_ids.push(row.task_id.clone());
        }
        entry.fleet_cost_usd += cost_usd;
        if row.created_at < entry.started_at {
            entry.started_at = row.created_at.clone();
        }
        entry.members.push(MemberStatus {
            status: member_status(row.admitted, row.final_status.as_deref()).to_string(),
            task_id: row.task_id,
            branch: row.branch,
            member_index: row.member_index,
            fleet_size: row.fleet_size,
            admitted: row.admitted,
            phase: row.phase,
            kind: row.kind,
            complexity_tier: row.complexity_tier,
            cost_usd,
            unpriced_calls: unpriced,
            reserved_usd: row.reserved_usd,
            worktree_path: row.worktree_path,
            created_at: row.created_at,
        });
    }

    let mut out: Vec<FleetStatus> = order
        .into_iter()
        .filter_map(|id| grouped.remove(&id))
        .collect();
    for status in &mut out {
        status.members.sort_by_key(|m| m.member_index);
    }
    // 최신이 앞이다 — 화면은 방금 돌린 것을 먼저 본다.
    out.reverse();
    Ok(out)
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

    fn caps(fleet: Option<f64>, per_task: Option<f64>) -> FleetCaps {
        FleetCaps {
            fleet_cap_usd: fleet,
            per_task_cap_usd: per_task,
        }
    }

    /// **상한이 기록에 남는다.** 남기지 않으면 화면은 "상한이 없었다"와 "모른다"를 구별할 수
    /// 없고, 그 둘은 정반대의 사실이다.
    #[test]
    fn the_enrollment_records_the_caps_that_were_applied() {
        let member = spec("feat-a");
        let payload = Enrollment {
            fleet_id: "f1",
            spec: &member,
            index: 1,
            fleet_size: 3,
            caps: caps(Some(6.0), Some(2.0)),
            admitted: true,
            reserved_usd: Some(2.0),
            worktree_path: Some("/tmp/t".to_string()),
            reused_tree: false,
            reason: None,
        }
        .payload();
        assert_eq!(payload["caps"]["fleetCapUsd"], json!(6.0));
        assert_eq!(payload["caps"]["perTaskCapUsd"], json!(2.0));
        // 화면에 "2/3"으로 나가는 값이다 — 0부터 세는 색인을 그대로 흘리지 않는다.
        assert_eq!(payload["memberIndex"], json!(2));
        assert_eq!(payload["admitted"], json!(true));
        assert_eq!(payload["reusedTree"], json!(false));
        assert!(payload.get("reason").is_none(), "들어간 구성원에는 사유가 없다");
    }

    /// 상한이 **없었다**는 것도 기록이다. 키가 사라지면 옛 기록과 구별되지 않는다.
    #[test]
    fn no_cap_is_still_recorded_as_a_fact() {
        let member = spec("feat-a");
        let payload = Enrollment {
            fleet_id: "f1",
            spec: &member,
            index: 0,
            fleet_size: 1,
            caps: caps(None, None),
            admitted: false,
            reserved_usd: None,
            worktree_path: None,
            reused_tree: false,
            reason: Some("Fleet이 취소되어 시작하지 않았습니다"),
        }
        .payload();
        assert!(payload["caps"].is_object(), "상한 객체는 언제나 있다");
        assert_eq!(payload["caps"]["fleetCapUsd"], Value::Null);
        assert!(
            payload.get("worktreePath").is_none(),
            "시작하지 않은 구성원에는 트리가 없다 — 없는 경로를 기록에 적으면 그 기록을 여는 사람이 없는 디렉터리를 찾는다"
        );
        assert_eq!(payload["reason"], json!("Fleet이 취소되어 시작하지 않았습니다"));
    }

    // ---- 기록에서 유도한 Fleet 상태 (collect_status) ----

    fn store_with_fleet() -> (tempfile::TempDir, crate::store::Store) {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = crate::artifacts::ArtifactStore::new(dir.path()).unwrap();
        let mut store = crate::store::Store::open_in_memory(artifacts).unwrap();
        store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        (dir, store)
    }

    #[allow(clippy::too_many_arguments)]
    fn enroll(
        store: &mut crate::store::Store,
        task_id: &str,
        branch: &str,
        index: usize,
        size: usize,
        caps: FleetCaps,
        admitted: bool,
        terminal: Option<&str>,
        cost_usd: Option<f64>,
    ) {
        let member = spec(branch);
        store
            .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "verified", &member.message)
            .unwrap();
        store
            .append_event(
                task_id,
                "FLEET_ENROLLED",
                &Enrollment {
                    fleet_id: "f1",
                    spec: &member,
                    index,
                    fleet_size: size,
                    caps,
                    admitted,
                    reserved_usd: caps.per_task_cap_usd.filter(|_| admitted),
                    worktree_path: admitted.then(|| format!("/tmp/wt/{branch}")),
                    reused_tree: false,
                    reason: (!admitted).then_some("합계 상한이 남지 않았습니다"),
                }
                .payload(),
            )
            .unwrap();
        if let Some(cost) = cost_usd {
            store
                .record_provider_usage(&json!({
                    "taskId": task_id,
                    "callId": format!("call-{task_id}"),
                    "role": "executor",
                    "providerId": "anthropic",
                    "modelId": "m",
                    "costUsd": cost,
                }))
                .unwrap();
        }
        if let Some(status) = terminal {
            store
                .finish_task(task_id, status, &format!("TASK_{status}"), None, &json!({}))
                .unwrap();
        }
    }

    /// **합계는 합계라고 말한다** — 그리고 그 합계는 저장소가 센 값이다(Node의 주장이 아니다).
    #[test]
    fn the_status_sums_member_costs_and_never_multiplies_by_member_count() {
        let (_dir, mut store) = store_with_fleet();
        enroll(&mut store, "t1", "a", 0, 3, caps(Some(6.0), Some(2.0)), true, Some("COMPLETED"), Some(0.5));
        enroll(&mut store, "t2", "b", 1, 3, caps(Some(6.0), Some(2.0)), true, Some("FAILED"), Some(0.25));
        enroll(&mut store, "t3", "c", 2, 3, caps(Some(6.0), Some(2.0)), false, Some("REJECTED"), None);

        let fleets = collect_status(&store, None).unwrap();
        assert_eq!(fleets.len(), 1);
        let fleet = &fleets[0];
        assert_eq!(fleet.members.len(), 3);
        // 구성원 셋의 **합**이다 — 구성원 수만큼 곱해지지 않는다.
        assert!((fleet.fleet_cost_usd - 0.75).abs() < 1e-9, "{}", fleet.fleet_cost_usd);
        assert_eq!(fleet.fleet_cap_usd, Some(6.0));
        assert_eq!(fleet.per_task_cap_usd, Some(2.0));
        assert!(fleet.caps_recorded);
    }

    /// **부분 실패가 개별로 보인다.** 결말을 하나로 접으면 이 제품이 파는 것을 파는 행위다.
    #[test]
    fn every_member_keeps_its_own_outcome() {
        let (_dir, mut store) = store_with_fleet();
        enroll(&mut store, "t1", "a", 0, 3, caps(None, None), true, Some("COMPLETED"), Some(0.1));
        enroll(&mut store, "t2", "b", 1, 3, caps(None, None), true, Some("FAILED"), Some(0.1));
        enroll(&mut store, "t3", "c", 2, 3, caps(None, None), false, Some("REJECTED"), None);

        let fleet = &collect_status(&store, None).unwrap()[0];
        let statuses: Vec<&str> = fleet.members.iter().map(|m| m.status.as_str()).collect();
        // **미시작은 거부가 아니다** — 셋째는 `REJECTED`로 확정됐지만 들어간 적이 없다.
        assert_eq!(statuses, vec!["completed", "failed", "not_started"]);
        // 그리고 순서는 구성원 번호다 — 화면이 "2/3"으로 읽는 그 번호다.
        assert_eq!(
            fleet.members.iter().map(|m| m.member_index).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    /// 아직 도는 구성원은 **결말이 없다**는 사실이 값으로 남는다.
    #[test]
    fn a_running_member_is_not_an_outcome() {
        let (_dir, mut store) = store_with_fleet();
        enroll(&mut store, "t1", "a", 0, 2, caps(None, None), true, Some("COMPLETED"), Some(0.1));
        enroll(&mut store, "t2", "b", 1, 2, caps(None, None), true, None, None);

        let fleet = &collect_status(&store, None).unwrap()[0];
        assert_eq!(fleet.members[1].status, "running");
        assert_eq!(fleet.unfinished_task_ids, vec!["t2".to_string()]);
    }

    /// **상한이 없었던 것과 기록에 없는 것은 다른 사실이다.** 옛 기록에는 `caps`가 없다.
    #[test]
    fn a_record_without_caps_does_not_claim_there_was_no_cap() {
        let (_dir, mut store) = store_with_fleet();
        let member = spec("a");
        store
            .create_task("t1", "sess-1", "ws-1", "/tmp/ws", "verified", &member.message)
            .unwrap();
        store
            .append_event(
                "t1",
                "FLEET_ENROLLED",
                // 상한 필드가 생기기 전의 페이로드.
                &json!({ "fleetId": "f1", "branch": "a", "memberIndex": 1, "fleetSize": 1, "admitted": true }),
            )
            .unwrap();

        let fleet = &collect_status(&store, None).unwrap()[0];
        assert!(!fleet.caps_recorded, "읽지 못한 것을 '상한 없음'으로 단정하지 않는다");
        assert_eq!(fleet.fleet_cap_usd, None);
    }

    /// **미시작은 거부가 아니고, 도는 것은 결말이 아니다.**
    #[test]
    fn the_member_status_separates_never_started_and_still_running() {
        // 시작조차 못 한 구성원은 `REJECTED`로 확정되지만 거부가 아니다.
        assert_eq!(member_status(false, Some("REJECTED")), "not_started");
        assert_eq!(member_status(true, Some("REJECTED")), "rejected");
        assert_eq!(member_status(true, None), "running");
        assert_eq!(member_status(true, Some("COMPLETED")), "completed");
        // 모르는 값을 실패로 접지 않는다 — 접으면 새 종착지가 생길 때 화면이 말없이 틀린다.
        assert_eq!(member_status(true, Some("ANSWERED")), "unknown");
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
        // 들여보낼 수 있는 만큼 들여보낸다. **단계 분할 뒤로도 판정은 태스크당 상한 전부를
        // 본다** — 그렇지 않으면 이 불변식이 `PLANNING_SHARE`만큼 느슨해진다.
        let mut index = 0usize;
        loop {
            match budget.try_admit(index) {
                Admission::Admitted { .. } => {
                    admitted.push(index);
                    index += 1;
                }
                Admission::Refused { .. } => break,
            }
        }
        assert_eq!(admitted.len(), 3, "10 / 3 = 3개까지만 동시에 들어간다");
        // 전원이 상한을 꽉 채워 쓴다.
        for member in admitted {
            budget.settle(member, 3.0);
        }
        assert!((budget.committed_usd() - 9.0).abs() < 1e-9, "{}", budget.committed_usd());
        assert!(budget.committed_usd() <= 10.0);
        // 남은 $1로는 태스크당 상한 $3을 예약할 수 없다 — **새 구성원이 시작되지 않는다.**
        assert!(matches!(budget.try_admit(index), Admission::Refused { .. }));
        assert!(!budget.waiting_could_help(), "열린 예약이 없으므로 기다려도 달라지지 않는다");
    }

    /// **입장 판정은 분할 전과 한 글자도 다르지 않다.** 이 사실이 합계 상한을 딱딱하게 유지한다.
    ///
    /// 처음 쓴 분할은 입장 시점에 계획 몫만 세었고, `the_aggregate_cap_is_never_exceeded…`가
    /// 즉시 잡았다(상한 $10 / 태스크당 $3에 구성원 10개가 들어갔다). 잡아 둔 금액만 세면
    /// 아직 오지 않은 구현 비용이 없는 것처럼 보이는데, 그것이 이 모듈이 경계한 실수다.
    #[test]
    fn admission_still_counts_the_whole_per_task_cap() {
        let mut budget = FleetBudget::new(Some(6.0), Some(3.0));
        match budget.try_admit(0) {
            // **예약은 태스크당 상한 전부다.** 계획 몫은 그 안에서의 구분일 뿐이다.
            Admission::Admitted { reserved_usd } => assert_eq!(reserved_usd, Some(3.0)),
            other => panic!("{other:?}"),
        }
        assert!((budget.reserved_usd() - 3.0).abs() < 1e-9);
        assert!(matches!(budget.try_admit(1), Admission::Admitted { .. }));
        // $6이 전부 잡혔다 — 셋째는 들어가지 못한다. 분할이 이것을 느슨하게 만들지 않는다.
        assert!(matches!(budget.try_admit(2), Admission::Refused { .. }));
    }

    /// **분할이 버는 것은 상한과 실제 비용의 차액이다** — 72.12절의 Fleet 쪽 절반.
    ///
    /// 승인 카드가 이 계획이 얼마인지 말하므로, 그 금액으로 구현 몫을 줄이면 나머지가 즉시
    /// 다른 구성원에게 열린다. 분할 이전에는 그 돈이 태스크가 끝날 때까지 잠겨 있었다.
    #[test]
    fn approving_a_plan_frees_the_gap_between_the_cap_and_the_card() {
        // 상한 $8 / 태스크당 $3 — 둘은 들어가고 셋째는 $2가 모자라 들어가지 못한다.
        let mut budget = FleetBudget::new(Some(8.0), Some(3.0));
        budget.try_admit(0);
        budget.try_admit(1);
        // 둘이 상한을 다 잡고 있으므로 셋째는 들어가지 못한다.
        assert!(matches!(budget.try_admit(2), Admission::Refused { .. }));

        // 0번의 계획이 승인됐고, 카드가 말한 금액은 $0.40이다.
        let planning = 3.0 * PLANNING_SHARE;
        match budget.reserve_implementation(0, Some(0.40), true) {
            ImplementationStage::Staged { held_usd, freed_usd, priced } => {
                assert!(priced);
                assert!((held_usd - (planning + 0.40)).abs() < 1e-9, "{held_usd}");
                assert!((freed_usd - (3.0 - planning - 0.40)).abs() < 1e-9, "{freed_usd}");
            }
            other => panic!("{other:?}"),
        }
        // **그 차액으로 셋째가 들어간다.** 이것이 분할이 실제로 버는 것이다.
        assert!(matches!(budget.try_admit(2), Admission::Admitted { .. }));
        // 그리고 결과가 그 사실을 말한다.
        let report = FleetReport::build("f", vec![], &budget, crate::verify::LaneStats::default());
        assert!(report.totals.fleet_staging_freed_usd > 0.0);
        assert!(
            report.notices().iter().any(|n| n.contains("다른 구성원에게 열어주었습니다")),
            "{:?}",
            report.notices()
        );
    }

    /// **카드가 금액으로 말하지 못하면 줄이지 않는다.** 모르는 것을 0으로 보면 상한이 사라진다.
    #[test]
    fn an_unpriced_card_never_shrinks_the_reservation() {
        let mut budget = FleetBudget::new(Some(6.0), Some(3.0));
        budget.try_admit(0);
        // 환산되지 않은 배정이 있었다 — 금액은 있지만 그것이 전부가 아니다.
        match budget.reserve_implementation(0, Some(0.10), false) {
            ImplementationStage::Staged { freed_usd, priced, .. } => {
                assert!(!priced);
                assert_eq!(freed_usd, 0.0, "모르면 줄이지 않는다");
            }
            other => panic!("{other:?}"),
        }
        assert!((budget.reserved_usd() - 3.0).abs() < 1e-9);
        assert_eq!(budget.staging_freed_usd(), 0.0);
    }

    /// **올려 잡지 않는다.** 카드가 남은 몫보다 큰 금액을 말해도 노출은 커지지 않는다 —
    /// 구성원 하나의 지출은 자기 `TaskBudget`이 태스크당 상한으로 막는다.
    #[test]
    fn a_card_larger_than_the_remainder_never_raises_the_exposure() {
        let mut budget = FleetBudget::new(Some(6.0), Some(3.0));
        budget.try_admit(0);
        budget.reserve_implementation(0, Some(99.0), true);
        assert!((budget.reserved_usd() - 3.0).abs() < 1e-9, "{}", budget.reserved_usd());
        assert_eq!(budget.staging_freed_usd(), 0.0);
    }

    /// 같은 승인이 두 번 관측돼도 예약이 두 번 움직이지 않는다.
    #[test]
    fn staging_happens_exactly_once_per_member() {
        let mut budget = FleetBudget::new(Some(10.0), Some(4.0));
        budget.try_admit(0);
        assert!(matches!(
            budget.reserve_implementation(0, Some(0.5), true),
            ImplementationStage::Staged { .. }
        ));
        let after = budget.reserved_usd();
        assert_eq!(
            budget.reserve_implementation(0, Some(0.1), true),
            ImplementationStage::AlreadyStaged
        );
        assert_eq!(budget.reserved_usd(), after, "두 번째 승인은 예약을 움직이지 않는다");
    }

    /// 합계 상한이 없으면 **확정할 것도 없다.** "0을 잡았다"와 "잡을 것이 없다"는 다르다.
    #[test]
    fn without_an_aggregate_cap_there_is_nothing_to_stage() {
        let mut budget = FleetBudget::new(None, Some(3.0));
        budget.try_admit(0);
        assert_eq!(
            budget.reserve_implementation(0, Some(0.5), true),
            ImplementationStage::NotTracked
        );
        // 들어간 적 없는 구성원의 승인도 잡을 것이 없다 — 있지도 않은 예약을 열지 않는다.
        let mut capped = FleetBudget::new(Some(6.0), Some(3.0));
        assert_eq!(
            capped.reserve_implementation(7, Some(0.5), true),
            ImplementationStage::NotTracked
        );
        assert_eq!(capped.reserved_usd(), 0.0);
    }

    /// **정산은 단계를 함께 닫는다.** 계획 몫만 닫으면 구현 예약이 영원히 떠 있다.
    #[test]
    fn settling_closes_both_stages_of_one_member() {
        let mut budget = FleetBudget::new(Some(10.0), Some(4.0));
        budget.try_admit(0);
        budget.reserve_implementation(0, Some(1.0), true);
        let planning = 4.0 * PLANNING_SHARE;
        assert!((budget.held_for(0).unwrap() - (planning + 1.0)).abs() < 1e-9);
        budget.settle(0, 1.25);
        assert_eq!(budget.held_for(0), None);
        assert_eq!(budget.reserved_usd(), 0.0);
        assert_eq!(budget.outstanding(), 0);
        assert!((budget.committed_usd() - 1.25).abs() < 1e-9);
        assert!(!budget.waiting_could_help());
    }

    /// 감시는 **`PLAN_APPROVED`만** 고른다. 다른 이벤트가 예산을 열면 승인의 뜻이 사라진다.
    #[test]
    fn the_watch_only_fires_on_a_plan_approval_task_event() {
        use crate::host::EventSink;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let seen: Arc<std::sync::Mutex<Vec<PlanApproved>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = fired.clone();
        let collected = seen.clone();
        let watch = PlanApprovalWatch::new(
            Arc::new(crate::host::NullSink),
            2,
            Box::new(move |approved| {
                counter.fetch_add(1, Ordering::SeqCst);
                collected.lock().unwrap().push(approved);
            }),
        );
        watch.emit("task-event", &json!({ "type": "PLAN_REVIEW_COMPLETED" }));
        watch.emit("task-event", &json!({ "type": "USER_VERIFICATION_APPROVED" }));
        // 채널이 다르면 이름이 같아도 열리지 않는다.
        watch.emit("approval-request", &json!({ "type": "PLAN_APPROVED" }));
        assert_eq!(fired.load(Ordering::SeqCst), 0);

        watch.emit(
            "task-event",
            &json!({
                "type": "PLAN_APPROVED",
                "payload": { "estimatedCostUsd": 0.42, "unpricedAssignments": [] }
            }),
        );
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        assert_eq!(
            seen.lock().unwrap()[0],
            PlanApproved {
                index: 2,
                estimated_cost_usd: Some(0.42),
                priced: true
            }
        );

        // **환산되지 않은 배정이 하나라도 있으면 금액으로 말할 수 없다.**
        watch.emit(
            "task-event",
            &json!({
                "type": "PLAN_APPROVED",
                "payload": { "estimatedCostUsd": 0.42, "unpricedAssignments": ["reviewer"] }
            }),
        );
        assert!(!seen.lock().unwrap()[1].priced);

        // 목록 자체가 없으면 **모르는 것**이다 — "없음"으로 읽지 않는다.
        watch.emit(
            "task-event",
            &json!({ "type": "PLAN_APPROVED", "payload": { "estimatedCostUsd": 0.42 } }),
        );
        assert!(!seen.lock().unwrap()[2].priced);
    }

    /// 거부의 두 가지를 구별한다: **지금 자리가 없다**와 **영원히 자리가 없다**.
    #[test]
    fn a_refusal_says_whether_waiting_would_help() {
        let mut budget = FleetBudget::new(Some(6.0), Some(3.0));
        assert!(matches!(budget.try_admit(0), Admission::Admitted { .. }));
        assert!(matches!(budget.try_admit(1), Admission::Admitted { .. }));
        // 둘이 $6을 전부 잡고 있다 — 입장 시점에 태스크당 상한 전부를 잡기 때문이다.
        assert!(matches!(budget.try_admit(2), Admission::Refused { .. }));
        // 둘이 도는 동안은 기다리면 달라진다.
        assert!(budget.waiting_could_help());
        // 싸게 끝나면 자리가 생긴다 — 예약은 최대치였고 실제는 그보다 작을 수 있다.
        budget.settle(0, 0.5);
        budget.settle(1, 0.5);
        assert!(matches!(budget.try_admit(2), Admission::Admitted { .. }));
    }

    /// 합계 상한이 없으면 **예약도 없다.** 그리고 그 사실이 결과에 남는다.
    #[test]
    fn without_an_aggregate_cap_nothing_is_reserved_and_the_report_says_so() {
        let mut budget = FleetBudget::new(None, Some(3.0));
        for member in 0..MAX_FLEET_SIZE {
            assert_eq!(budget.try_admit(member), Admission::Admitted { reserved_usd: None });
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
