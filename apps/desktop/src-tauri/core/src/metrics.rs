//! 기준 계측 집계 — docs/design/state-machine-and-protocol.md 17.10절,
//! product-strategy.md 14절.
//!
//! # 왜 이게 필요한가
//!
//! 12절 미해결 항목 중 몇 개는 **집계로만** 답할 수 있는 질문이다("기준↔테스트 연결의
//! 커버리지", "위치 충돌 규칙의 오탐률", "강제 포기 노출 시점의 근거"). 이벤트는 이미 쌓이고
//! 있지만, 한 태스크의 로그를 눈으로 읽어서는 "얼마나"를 알 수 없다.
//!
//! # 왜 Rust인가
//!
//! DB는 Rust의 것이다(process-architecture.md 2절 — Rust가 유일한 writer이고 Node는 DB에
//! 직접 접근하지 않는다). 집계는 읽기 전용이지만, Node가 SQLite 파일을 직접 열기 시작하면
//! 그 경계가 흐려진다. 여기 두면 경계가 그대로 유지되고 `tomverse-host metrics`로 GUI 없이 돈다.
//!
//! # 언제 답할 수 있는가도 값으로 낸다
//!
//! 이 파일의 지표 대부분은 제품을 굴리는 값이 아니라 **설계 문서의 열린 항목에 답하려고**
//! 있다. 그런데 집계는 표본이 3개여도 비율을 낸다 — 그 비율을 보고 조치하면 관측이 아니라
//! 우연에 따라 설계를 바꾸는 것이다. 그래서 `openQuestions`가 질문마다 **분모·표본 수·
//! 최소치·지금 들여다볼 때가 됐는지**를 함께 낸다. 유도 문턱들이 이미 하던 일
//! (`MIN_LATENCY_SAMPLES` — 표본이 모자라면 유도값을 내지 않는다)을 열린 질문에도 준 것이다.
//!
//! # 이 집계가 답하지 못하는 것
//!
//! **"충돌이 진짜 잘못된 계획을 잡았는가"의 정답은 어디에도 없다.** 사용자가 매번 판정해주지
//! 않는 한 관측 가능한 것은 "재요청했더니 계획이 바뀌었다/안 바뀌었다"와 "그대로 진행했더니
//! 어떻게 끝났다"뿐이다. 그래서 필드 이름을 추론이 아니라 **일어난 일 그대로** 붙였다 —
//! 지표 이름이 추론을 포함하면 읽는 사람이 그 추론을 사실로 읽는다.

use crate::store::Store;
use serde_json::Value;
use std::collections::BTreeMap;

/// 기준 판정 집계. 마지막 `CRITERIA_EVALUATED`만 센다 — fix loop를 돌면 같은 태스크에서
/// 여러 번 나오는데, 전부 세면 재시도가 많은 태스크가 집계를 좌우한다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CriteriaCoverage {
    /// 판정이 하나라도 있었던 태스크 수.
    #[serde(rename = "tasksWithCriteria")]
    pub tasks_with_criteria: u64,
    /// 기준 총 개수 (태스크별 마지막 판정 기준).
    pub criteria: u64,
    /// 상태별 개수.
    #[serde(rename = "byStatus")]
    pub by_status: BTreeMap<String, u64>,
    /// **사유 코드별 개수.** 커버리지가 왜 낮은지는 여기서만 보인다 —
    /// "테스트 이름이 없었다"와 "이름은 있는데 실행 근거가 없었다"는 고칠 곳이 다르다.
    #[serde(rename = "byCode")]
    pub by_code: BTreeMap<String, u64>,
}

/// 기준 충돌(PLANNING 게이트)의 결말 집계.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ConflictOutcomes {
    /// `CRITERIA_CONFLICT_DETECTED`가 실린 횟수 (이벤트 수가 아니라 충돌 건수).
    pub detected: u64,
    /// 결말이 기록된 충돌 건수. `detected`와 다르면 **결말이 새고 있다는 뜻**이다.
    pub settled: u64,
    #[serde(rename = "byOutcome")]
    pub by_outcome: BTreeMap<String, u64>,
    /// 충돌을 안은 채 진행한 태스크가 어떤 terminal로 끝났는가.
    ///
    /// 통과했다고 충돌이 오탐이었다는 뜻은 **아니다** — 사용자가 지목한 곳을 고치지 않고도
    /// 기존 테스트는 통과할 수 있다. 약한 정황일 뿐이며, 그래서 이름이 "falsePositive"가 아니다.
    #[serde(rename = "proceededTaskTerminalStatus")]
    pub proceeded_task_terminal_status: BTreeMap<String, u64>,
    /// `plan_unchanged`를 **재요청 뒤 해석 텍스트가 달라졌는지**로 쪼갠다 — 12절 "충돌 결말 실측".
    ///
    /// `plan_unchanged` 비율이 높다는 것만으로는 고칠 곳을 알 수 없다. 두 원인이 섞여 있다:
    ///
    /// - `unchanged` — 다시 요청했는데 **해석조차 그대로**다. 모델이 피드백을 반영하지 않은
    ///   것에 가깝고, 그러면 고칠 곳은 게이트가 아니라 프롬프트다.
    /// - `changed` — 해석은 바뀌었는데 계획은 그대로다. 모델이 읽고도 같은 곳을 고르겠다고
    ///   한 것이므로, 게이트가 잡은 것이 실제 문제가 아니었을 가능성이 여기 있다.
    ///
    /// `unknown`은 비교할 새 초안이 없었던 경우다(예산 소진, 태스크 종료). **0으로 뭉개지
    /// 않는다** — 재요청조차 못 한 것과 재요청했는데 그대로인 것은 다른 사실이다.
    ///
    /// 어느 쪽도 "규칙이 틀렸다"의 증거는 아니다. 이건 **원인을 가르는 재료**이지 판정이 아니다.
    #[serde(rename = "planUnchangedByInterpretation")]
    pub plan_unchanged_by_interpretation: BTreeMap<String, u64>,
}

/// 취소 소요 분포 — 12절 미해결 "강제 포기 노출 시점(5초)의 근거".
///
/// # 무엇을 세고 무엇을 빼는가
///
/// `CANCELLATION_REQUESTED`부터 그 뒤 첫 터미널 이벤트까지의 간격을 잰다. 세 갈래로 갈리고,
/// **셋을 섞으면 숫자가 자기 자신을 먹는다.**
///
/// - `settled` — 정상적으로 끝난 취소. 이것만 분포에 들어간다.
/// - `force_abandoned` — 사용자가 기다리기를 그만둔 것. **분포에서 뺀다.** 이 간격은
///   "취소가 얼마나 걸렸는가"가 아니라 "임계값 + 사용자의 반응 시간"이다. 넣으면 임계값이
///   자기 자신을 근거로 매번 커지는 되먹임이 생긴다 — 탈출구를 쓸수록 탈출구가 늦게 뜬다.
/// - `unresolved` — 요청은 있는데 터미널이 없다. 유한한 소요 시간이 **없는** 경우이므로
///   분포에 넣을 수 없다. 그러나 조용히 빼면 안 된다: 이것이 탈출구가 존재하는 이유 그 자체라,
///   개수가 보이지 않으면 분포가 실제보다 건강해 보인다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CancellationLatency {
    /// 분포에 들어간 표본 수.
    pub settled: u64,
    #[serde(rename = "forceAbandoned")]
    pub force_abandoned: u64,
    pub unresolved: u64,
    /// 타임스탬프를 읽지 못한 쌍. 0이 아니면 아래 숫자를 믿기 전에 여기를 봐야 한다 —
    /// 조용히 빼면 표본이 적은 것과 파서가 깨진 것을 구별할 수 없다.
    #[serde(rename = "unparsedTimestamps")]
    pub unparsed_timestamps: u64,
    #[serde(rename = "p50Ms")]
    pub p50_ms: Option<u64>,
    #[serde(rename = "p90Ms")]
    pub p90_ms: Option<u64>,
    #[serde(rename = "p95Ms")]
    pub p95_ms: Option<u64>,
    #[serde(rename = "maxMs")]
    pub max_ms: Option<u64>,
}

/// 표본이 이만큼 쌓이기 전에는 측정값을 쓰지 않는다.
///
/// 하나짜리 표본으로 임계값을 정하면 그 한 번의 실행이 앞으로의 모든 취소를 지배한다.
/// 10은 "분포라고 부를 수 있는 최소"에 대한 관례적 선택이고 **이것도 실측이 아니다** —
/// 다만 이 값이 틀렸을 때의 대가는 임계값이 틀렸을 때보다 작다(기본값으로 남을 뿐이다).
pub const MIN_LATENCY_SAMPLES: u64 = 10;

/// 표본이 없을 때의 기본값. 종전에 UI에 하드코딩되어 있던 추정치와 같다 —
/// 값을 바꾸는 것이 아니라 **근거를 붙이는 것**이 이 작업의 목적이므로, 데이터가 없을 때의
/// 동작은 종전과 같아야 한다.
pub const DEFAULT_FORCE_ABANDON_MS: u64 = 5_000;

/// 측정값에서 임계값을 만들 때의 하한/상한.
///
/// 하한이 `REAP_TIMEOUT`(2초)보다 큰 이유: 그 안에서는 정상 취소가 **아직 진행 중**이므로
/// 탈출구가 뜨면 거짓 경보다. 상한이 있는 이유: 이상치 하나가 max를 끌어올리면 탈출구가
/// 사실상 사라지는데, 탈출구가 없는 것이 이 기능이 고치려던 문제였다.
pub const MIN_FORCE_ABANDON_MS: u64 = 3_000;
pub const MAX_FORCE_ABANDON_MS: u64 = 30_000;

/// 강제 포기 버튼을 여는 시점과 **그 값이 어디서 왔는지**.
///
/// `source`를 값과 함께 돌려주는 이유: 5초가 추정이라는 사실을 지운 채 숫자만 넘기면
/// 읽는 쪽이 그것을 측정값으로 읽는다. 12절 항목이 지적한 문제가 정확히 그것이었다.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForceAbandonThreshold {
    pub ms: u64,
    /// `measured` | `default_insufficient_samples`
    pub source: &'static str,
    #[serde(rename = "sampleCount")]
    pub sample_count: u64,
    #[serde(rename = "minSamples")]
    pub min_samples: u64,
}

/// 관측된 취소 소요에서 탈출구를 열 시점을 정한다.
///
/// # 왜 p95가 아니라 max인가
///
/// 탈출구가 답해야 하는 질문은 "이 취소가 비정상인가"이지 "느린 편인가"가 아니다. p95를 쓰면
/// **정상 취소 20번에 한 번은** 탈출구가 떠서, 곧 정상적으로 끝날 작업에 대고 "예상보다 오래
/// 걸리고 있습니다"라고 말하게 된다. 그건 탈출구가 없는 것과는 다른 종류의 거짓말이다.
///
/// max에 여유를 곱하는 이유는 max 자체가 표본에 따라 흔들리기 때문이고, 1.5는 관례적 선택이다.
/// p50/p90/p95도 함께 보고하므로 이 규칙이 틀렸을 때 사람이 다시 판단할 재료는 남는다.
pub fn suggest_force_abandon_ms(latency: &CancellationLatency) -> ForceAbandonThreshold {
    match latency.max_ms {
        Some(max) if latency.settled >= MIN_LATENCY_SAMPLES => ForceAbandonThreshold {
            ms: (max.saturating_mul(3) / 2).clamp(MIN_FORCE_ABANDON_MS, MAX_FORCE_ABANDON_MS),
            source: "measured",
            sample_count: latency.settled,
            min_samples: MIN_LATENCY_SAMPLES,
        },
        _ => ForceAbandonThreshold {
            ms: DEFAULT_FORCE_ABANDON_MS,
            source: "default_insufficient_samples",
            sample_count: latency.settled,
            min_samples: MIN_LATENCY_SAMPLES,
        },
    }
}

/// 한 자리(카드에서 몇 번째 질문)에서 사용자가 무엇을 골랐는가.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PositionAnswers {
    /// 그 질문의 **첫 번째** 선택지를 골랐다.
    #[serde(rename = "firstOption")]
    pub first_option: u64,
    /// 두 번째 이후 선택지를 골랐다.
    #[serde(rename = "laterOption")]
    pub later_option: u64,
    /// 둘 다 아니라 직접 적었다.
    pub freeform: u64,
    /// 순번을 알 수 없는 기록(옛 이벤트 등). 0으로 뭉개면 비율의 분모가 틀린다.
    pub unknown: u64,
}

/// 한 필드의 쟁점에 사용자가 무엇을 답했는가 — 17.4절 랭킹 튜닝의 재료.
///
/// # 왜 "primary를 골랐는가"로 세는가
///
/// 선택지 1번은 **언제나 primary 실행자의 값**이고, 사용자가 아무것도 판정하지 않았다면
/// 결국 적용됐을 값이다. 그래서 "primary가 아닌 것을 골랐다"는 **그 쟁점을 물어서 실제로
/// 무언가 달라졌다**는 뜻이고, 14절이 말하는 "불일치 1건당 사용자가 뒤집은 비율"이 재려던
/// 것이 그것이다.
///
/// **primary를 골랐다고 그 질문이 쓸모없었다는 뜻은 아니다.** 사용자가 확인해준 것이고,
/// 확인은 공짜가 아니다. 그래서 이름이 `wasted`가 아니라 `pickedPrimary`다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct FieldAnswers {
    /// primary 실행자의 값(선택지 1번)을 골랐다.
    #[serde(rename = "pickedPrimary")]
    pub picked_primary: u64,
    /// 다른 초안의 값을 골랐다.
    #[serde(rename = "pickedOther")]
    pub picked_other: u64,
    /// 둘 다 아니라 직접 적었다 — **두 초안이 모두 틀렸다**는 가장 강한 신호다.
    pub freeform: u64,
    /// 순번을 알 수 없는 기록. 0으로 뭉개면 비율의 분모가 틀린다.
    pub unknown: u64,
}

/// 3.9절 카드의 답변을 **자리별로** 쪼갠 집계 — 12절 "한 카드 질문 상한 4개의 근거".
///
/// # 이 숫자가 말하는 것과 말하지 않는 것
///
/// **첫 선택지를 골랐다는 것은 부주의의 증거가 아니다.** 그 선택지가 맞았을 수 있다. 그래서
/// 필드 이름이 `careless`가 아니라 `firstOption`이다 — 잰 것을 그대로 부른다(17.10절 ③).
///
/// 이 집계를 쓸 수 있게 하는 것은 **카드 안에서 자리끼리 비교한다**는 점이다. 선택지 1번은
/// 언제나 primary 실행자의 값이라 자리와 무관하게 한쪽으로 치우칠 수 있는데, 그 치우침은 한
/// 카드 안의 모든 질문에 똑같이 걸린다. 따라서 **자리에 따라 비율이 달라지면** 그건 모델 품질이
/// 아니라 자리 때문이다. 그것이 "아래쪽 질문은 그럴듯하면 아무거나 눌린다"는 가설이 예측하는
/// 모양이고, 상한 4의 근거를 물을 수 있는 유일한 관측이다.
///
/// 그래도 이건 **신호이지 판정이 아니다.** 비율이 올라간다고 상한이 틀렸다는 증명은 아니다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CardAnswers {
    /// 자리(1부터) → 그 자리의 답 분포.
    #[serde(rename = "byPosition")]
    pub by_position: BTreeMap<u64, PositionAnswers>,
    /// 카드 크기별 카드 수. "3개 중 3번째"와 "4개 중 3번째"는 다른 상황이고,
    /// 스크롤이 생기는지는 크기에 달려 있다.
    #[serde(rename = "cardsBySize")]
    pub cards_by_size: BTreeMap<u64, u64>,
    /// 필드 → 그 필드 쟁점의 답 분포. **`DISAGREEMENT_FIELD_RANK` 튜닝의 재료**다(17.10절 ⑩).
    ///
    /// 자리별 집계와 축이 다르다. 자리는 "화면의 어디에 있었나"이고 필드는 "무엇을 물었나"다.
    /// 한 축으로 합치면 둘 중 어느 것이 비율을 움직였는지 알 수 없다.
    #[serde(rename = "byField")]
    pub by_field: BTreeMap<String, FieldAnswers>,
    /// 필드 → 자리 → 답 분포. **필드와 자리의 교락을 푸는 유일한 표다.**
    ///
    /// # 따로 세면 답할 수 없는 질문이었다
    ///
    /// 17.10절 ⑨는 "자리에 따라 비율이 달라지는 것만이 자리 때문이다"라고 읽는 법을 적어두었다.
    /// 그런데 `byPosition`과 `byField`가 **따로** 있으면 그 비교가 불가능하다: 랭킹이 고정이라
    /// `doneCriteria`는 언제나 앞자리에 오므로, 두 표에서 보이는 차이가 필드 때문인지 자리
    /// 때문인지 가를 수 없다. **교락된 두 축을 각각 주변화해 놓고 "비교하라"고 적어둔 셈이다.**
    ///
    /// 다행히 무작위화가 필요하지는 않다. 카드에는 **갈린 필드만** 실리므로 같은 필드가
    /// 카드마다 다른 자리에 온다 — `targetPaths`는 `doneCriteria`가 갈리지 않은 카드에서
    /// 1번, 갈린 카드에서 2번이다. 그 변이가 자리 효과를 필드와 분리해 준다.
    ///
    /// 읽는 법: **한 필드 안에서 자리별로 비교한다.** 필드를 가로질러 비교하면 원래 문제로
    /// 돌아간다. 남은 교란: 비-blocking 항목은 언제나 blocking 뒤에 실리므로(17.4.1절) 자리에
    /// blocking 여부도 섞인다 — `doneCriteria`처럼 언제나 blocking인 필드가 가장 깨끗한 읽기다.
    #[serde(rename = "byFieldAndPosition")]
    pub by_field_and_position: BTreeMap<String, BTreeMap<u64, FieldAnswers>>,
    /// **규칙이 막을 만하다고 봤는가**별 답 분포 — 12절 "blocking 판정 규칙 자체".
    ///
    /// # 이 축이 없으면 규칙을 검증할 수 없다
    ///
    /// blocking 판정은 규칙이 내린다(17.4절). 그 규칙이 옳은지 물으려면 **규칙이 "묻지 않아도
    /// 된다"고 한 쟁점에서 사용자가 무엇을 골랐는지**를 봐야 하는데, 종전에는 그런 쟁점을
    /// 카드에 싣지도 않았으므로 답이 존재할 수 없었다.
    ///
    /// 읽는 법: `non_blocking`에서 `pickedOther`/`freeform` 비율이 `blocking`과 비슷하거나
    /// 높으면, 규칙이 막지 않기로 한 쟁점도 실제로는 판정이 갈리는 쟁점이었다는 뜻이다.
    /// **절대값이 아니라 두 칸의 비교를 본다** — 카드 자리·필드 편향은 양쪽에 똑같이 걸린다.
    ///
    /// 키는 `blocking` / `non_blocking` / `unknown`. 마지막은 이 축이 붙기 전 기록이며,
    /// 어느 한쪽에 합치면 그 쪽 비율이 과거 데이터로 희석된다.
    #[serde(rename = "byBlocking")]
    pub by_blocking: BTreeMap<String, FieldAnswers>,
}

/// 이 워크스페이스의 커밋이 **몇 개 파일을 담아 왔는가** — 19.6절 "커밋 단위"의 남은 항목.
///
/// 모집단은 `GIT_COMMIT_CREATED`가 있는 태스크뿐이다. 커밋하지 않은 태스크는 "커밋이 크다"라는
/// 질문의 대상이 아니므로 넣으면 분포가 작은 쪽으로 휜다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CommitSizes {
    /// 분포에 들어간 커밋 수.
    pub commits: u64,
    #[serde(rename = "p50Files")]
    pub p50_files: Option<u64>,
    #[serde(rename = "p90Files")]
    pub p90_files: Option<u64>,
    #[serde(rename = "maxFiles")]
    pub max_files: Option<u64>,
}

/// TRIAGE의 **테스트 파일 제외 규칙**이 실제로 얼마나 오분류를 내는가
/// (context-engine.md 11.1절 미해결 항목).
///
/// # 무엇이 분모인가
///
/// "`simple`이 몇 건인가"는 이 질문에 답하지 못한다. 규칙이 **작동하기라도 한** 태스크만
/// 세야 하는데, 테스트 파일이 제외됐어도 위험 키워드나 미커밋 변경 때문에 이미 `standard`였다면
/// 그 태스크는 이 규칙에 대해 아무것도 말해주지 않기 때문이다.
///
/// 그래서 분모는 **규칙이 판정을 바꾼 태스크**(`tier != tierIfTestsCounted`)이고, 분자는
/// 그중 **제외했던 테스트 파일을 실제로 고친** 태스크다. 후자가 오분류다: 그 파일은 작업
/// 대상이었는데 복잡도에서 빠졌다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct TestFileRule {
    /// 근거가 실린 TRIAGE 이벤트를 가진 태스크. **사용자가 tier를 고른 태스크는 여기 없다** —
    /// 그 태스크에서는 규칙이 돌지 않았다.
    #[serde(rename = "tasksJudgedByRules")]
    pub tasks_judged_by_rules: u64,
    /// 테스트 파일을 하나라도 제외한 태스크.
    #[serde(rename = "tasksWithExcludedTests")]
    pub tasks_with_excluded_tests: u64,
    /// **제외가 판정을 바꾼** 태스크. 오분류율의 분모다.
    #[serde(rename = "tasksWhereRuleChangedTier")]
    pub tasks_where_rule_changed_tier: u64,
    /// 그중 제외했던 테스트 파일이 실제로 변경된 태스크. 오분류율의 분자다.
    #[serde(rename = "tasksWhereExcludedTestWasMutated")]
    pub tasks_where_excluded_test_was_mutated: u64,
}

/// 인덱스 캐시가 실제로 이득인가 (context-engine.md 2.1절, process-architecture.md 11.4절).
///
/// **문서는 "계측을 붙였으므로 실사용이 쌓이면 답할 수 있다"고 적었는데 집계가 없었다.**
/// 이벤트만 있고 세는 사람이 없으면 답할 수 있는 것이 아니다 — 감사자가 손으로 이벤트를
/// 세야 하고, 그건 "답할 수 있다"가 아니라 "원리적으로 가능하다"이다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct IndexCache {
    /// 캐시를 못 써서 새로 구축한 횟수.
    pub builds: u64,
    /// 캐시가 맞아 구축을 건너뛴 횟수.
    pub hits: u64,
    /// 회피한 시간을 **모르는** 적중 수(옛 기록 등).
    ///
    /// 조용히 0으로 더하면 "이득이 작다"와 "배선이 끊겼다"를 구별할 수 없다 —
    /// `callsWithoutEstimate`와 같은 이유로 따로 센다.
    #[serde(rename = "hitsWithoutSavedMs")]
    pub hits_without_saved_ms: u64,
    /// 적중이 회피한 구축 시간의 합(ms). **이득의 크기**는 적중률이 아니라 이 값에 있다 —
    /// 100번 적중해도 구축이 20ms였다면 캐시는 필요 없다.
    #[serde(rename = "savedMsTotal")]
    pub saved_ms_total: u64,
    /// 구축 시간 분포. 회피한 시간이 큰지 작은지는 이것과 비교해야 안다.
    #[serde(rename = "p50BuildMs")]
    pub p50_build_ms: Option<u64>,
    #[serde(rename = "p90BuildMs")]
    pub p90_build_ms: Option<u64>,
    /// 구축한 인덱스의 파일 수 분포 — 느린 것이 저장소가 커서인지 디스크가 느려서인지 가른다.
    #[serde(rename = "p90FileCount")]
    pub p90_file_count: Option<u64>,
}

/// 표본이 부족할 때 "이 계획은 크다"고 볼 파일 수.
///
/// **이 값만은 유도하지 못했다.** 취소 소요와 달리 "정상 범위"를 관측에서 끌어낼 수 없는
/// 첫 사용자가 있고, 그때 쓸 숫자가 필요하다. 승인 모달에서 눈으로 훑을 수 있는 변경의
/// 크기를 어림한 것이며 **실측이 아니다.** 이 사실을 주석에 적어두는 이유는, 근거 없는 숫자가
/// 근거 있는 숫자와 코드에서 구별되지 않기 때문이다.
pub const DEFAULT_LARGE_CHANGE_FILES: u64 = 8;

/// 유도한 임계값의 하한/상한.
///
/// 하한(3)보다 낮으면 거의 모든 작업에 안내가 떠서 읽히지 않고, 상한(50)보다 높으면 사실상
/// 뜨지 않는다. 안내가 없는 것과 언제나 있는 것은 사용자에게 같은 것이다.
pub const MIN_LARGE_CHANGE_FILES: u64 = 3;
pub const MAX_LARGE_CHANGE_FILES: u64 = 50;

/// 표본이 이만큼 쌓이기 전에는 관측값을 쓰지 않는다.
pub const MIN_COMMIT_SIZE_SAMPLES: u64 = 10;

/// "이 계획은 이 워크스페이스 기준으로 큰가"의 문턱과 **그 값이 어디서 왔는지**.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LargeChangeThreshold {
    pub files: u64,
    /// `measured` | `default_insufficient_samples`
    pub source: &'static str,
    #[serde(rename = "sampleCount")]
    pub sample_count: u64,
    #[serde(rename = "minSamples")]
    pub min_samples: u64,
}

/// 관측된 커밋 크기에서 "크다"의 문턱을 정한다.
///
/// # 왜 max가 아니라 p90인가
///
/// 취소 소요(16.3절)에서는 max를 썼다. 거기서 답할 질문은 "이 취소가 **비정상**인가"였고,
/// 정상 취소 중에 탈출구가 뜨는 것은 거짓 경보였기 때문이다.
///
/// 여기서 답할 질문은 다르다. "이 작업이 **이 워크스페이스 기준으로 큰 편인가**"이고, 큰 편인
/// 것은 비정상이 아니다. 안내는 막지 않고 사실만 말하므로 가끔 떠도 손해가 작다. max를 쓰면
/// 지금까지 가장 컸던 작업보다 커야만 뜨는데, 그러면 사실상 아무 때도 뜨지 않는다.
pub fn suggest_large_change_files(sizes: &CommitSizes) -> LargeChangeThreshold {
    match sizes.p90_files {
        Some(p90) if sizes.commits >= MIN_COMMIT_SIZE_SAMPLES => LargeChangeThreshold {
            files: p90.clamp(MIN_LARGE_CHANGE_FILES, MAX_LARGE_CHANGE_FILES),
            source: "measured",
            sample_count: sizes.commits,
            min_samples: MIN_COMMIT_SIZE_SAMPLES,
        },
        _ => LargeChangeThreshold {
            files: DEFAULT_LARGE_CHANGE_FILES,
            source: "default_insufficient_samples",
            sample_count: sizes.commits,
            min_samples: MIN_COMMIT_SIZE_SAMPLES,
        },
    }
}

/// 태스크 하나가 공급자 호출에 실제로 쓴 비용의 분포 (마이크로 달러, 1 USD = 1_000_000).
///
/// **정수로 다루는 이유**는 백분위 계산을 다른 지표와 같은 함수로 하기 위해서다. 달러를
/// f64로 정렬하면 NaN 하나가 정렬 순서를 무의미하게 만드는데, 그 NaN은 "비용을 모른다"에서
/// 온다 — 그건 분포에 넣을 값이 아니라 분포에서 **빼야 하는 사실**이다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct TaskCosts {
    /// 분포에 들어간 태스크 수 — 공급자 호출이 있었고 **모든 호출의 비용을 아는** 태스크.
    pub tasks: u64,
    /// 비용을 모르는 호출이 하나라도 있어 분포에서 제외된 태스크 수.
    ///
    /// 조용히 빼면 "표본이 적다"와 "가격 정보가 없다"를 구별할 수 없다. 이 수가 크면
    /// 고칠 곳은 표본이 아니라 레지스트리의 단가다.
    #[serde(rename = "tasksWithUnpricedCalls")]
    pub tasks_with_unpriced_calls: u64,
    #[serde(rename = "p50Usd")]
    pub p50_usd: Option<f64>,
    #[serde(rename = "p90Usd")]
    pub p90_usd: Option<f64>,
    #[serde(rename = "maxUsd")]
    pub max_usd: Option<f64>,
}

/// 상한을 유도할 과거가 없을 때의 기본값(USD). protocol의 `DEFAULT_TASK_BUDGET_USD`와 **같아야 한다**.
///
/// 두 곳에 있는 이유는 둘이 다른 시점에 쓰이기 때문이다: 이 값은 화면이 입력란을 채울 때,
/// 저쪽은 정책이 병합될 때 쓰인다. 어긋나면 화면이 제안한 값과 실제로 강제되는 값이 달라진다.
pub const DEFAULT_TASK_BUDGET_USD: f64 = 5.0;

/// 유도값의 하한/상한.
///
/// 하한이 $1인 이유: 가장 비싼 등록 모델의 **한 호출** 최대 비용이 약 $2이므로 그보다 낮은
/// 상한은 첫 호출부터 거부되어 아무것도 돌지 않는다. 상한이 $50인 이유: 이상치 하나가
/// 제안을 끌어올리면 상한이 사실상 없어지는데, 없는 상한이 이 기능이 고치려던 문제다.
pub const MIN_TASK_BUDGET_USD: f64 = 1.0;
pub const MAX_TASK_BUDGET_USD: f64 = 50.0;

/// 표본이 이만큼 쌓이기 전에는 관측값을 쓰지 않는다.
pub const MIN_TASK_COST_SAMPLES: u64 = 10;

/// 관측된 지출에 곱하는 여유 배수.
///
/// **유도하지 못한 상수다.** 필요한 이유는 분명하다: 예약은 그 호출의 **최대** 비용으로 열리고
/// 확정은 **실제** 비용으로 되므로, 상한을 과거 실제 지출에 맞추면 남은 예산이 다음 호출의
/// 최대치를 못 덮어 정상 태스크가 거부된다. 그 간극이 얼마인지는 `BUDGET_RESERVATION_OPENED`의
/// `reservedUsd`가 쌓이면 **측정할 수 있다** — 그때 이 상수를 관측으로 바꾼다.
pub const TASK_BUDGET_HEADROOM: f64 = 3.0;

/// 태스크당 예산 상한의 제안값과 **그 값이 어디서 왔는지**.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskBudgetThreshold {
    pub usd: f64,
    /// `measured` | `default_insufficient_samples`
    pub source: &'static str,
    #[serde(rename = "sampleCount")]
    pub sample_count: u64,
    #[serde(rename = "minSamples")]
    pub min_samples: u64,
    /// 관측값에 곱한 여유 배수. 값만 넘기면 화면이 이걸 관측된 지출로 말하게 된다.
    #[serde(rename = "headroomMultiplier")]
    pub headroom_multiplier: f64,
}

/// 관측된 태스크 비용에서 상한 제안을 만든다.
///
/// # 왜 max가 아니라 p90인가
///
/// 상한을 지금까지 가장 비쌌던 태스크에 맞추면 이상치 하나가 상한을 무의미하게 만든다.
/// 반대로 p50에 맞추면 절반이 거부된다. "가끔 거부되고, 그때 사용자가 올릴 수 있다"가
/// 이 값이 목표하는 자리다 — 거부는 손실이 아니라 멈춤이고, 되돌릴 수 있다.
pub fn suggest_task_budget_usd(costs: &TaskCosts) -> TaskBudgetThreshold {
    match costs.p90_usd {
        Some(p90) if costs.tasks >= MIN_TASK_COST_SAMPLES => TaskBudgetThreshold {
            usd: round_cents((p90 * TASK_BUDGET_HEADROOM).clamp(MIN_TASK_BUDGET_USD, MAX_TASK_BUDGET_USD)),
            source: "measured",
            sample_count: costs.tasks,
            min_samples: MIN_TASK_COST_SAMPLES,
            headroom_multiplier: TASK_BUDGET_HEADROOM,
        },
        _ => TaskBudgetThreshold {
            usd: DEFAULT_TASK_BUDGET_USD,
            source: "default_insufficient_samples",
            sample_count: costs.tasks,
            min_samples: MIN_TASK_COST_SAMPLES,
            headroom_multiplier: TASK_BUDGET_HEADROOM,
        },
    }
}

fn round_cents(usd: f64) -> f64 {
    (usd * 100.0).round() / 100.0
}

fn micros_to_usd(micros: u64) -> f64 {
    micros as f64 / 1_000_000.0
}

/// 우리 토큰 추정이 **실제로 상한이었는가.**
///
/// 컨텍스트 패킹은 "이보다 많지는 않을 것"이라고 주장하는 수로 예산을 짠다
/// (context-engine.md 8절). 그 주장이 참인지는 공급자가 보고한 실제와 비교해야만 알 수 있고,
/// 비교하지 않으면 계수를 고칠 근거가 감밖에 없다.
///
/// **비율의 정의는 `실제 / 추정`이다.** 1을 넘으면 추정이 상한이 아니었다는 뜻이고, 그 방향이
/// 위험한 쪽이다 — 예약보다 많이 쓴 것이므로 원장이 `BUDGET_ESTIMATE_BREACH`로 막는다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct TokenEstimateAccuracy {
    /// 추정과 실제를 **둘 다 아는** 호출 수. 이 수가 0이면 아래 값들은 아무것도 말하지 않는다.
    pub calls: u64,
    /// 추정이 없어 비교하지 못한 호출 수 (v5 이전 기록, 추정하지 않은 경로).
    ///
    /// 조용히 빼면 "표본이 적다"와 "배선이 끊겼다"를 구별할 수 없다.
    #[serde(rename = "callsWithoutEstimate")]
    pub calls_without_estimate: u64,
    /// **실제가 추정을 넘은 호출 수.** 0이 아니면 그 추정은 상한이 아니다.
    ///
    /// 이름이 `overrun`이나 `error`가 아닌 이유: 무슨 일이 있었는지를 말하는 이름이어야 한다.
    /// "초과"는 판정이고, 여기 있는 것은 관측이다.
    #[serde(rename = "callsWhereActualExceededEstimate")]
    pub calls_where_actual_exceeded_estimate: u64,
    /// `실제 / 추정` × 100의 백분위. 100이면 정확히 맞은 것, 100 미만이면 과대 추정이다.
    #[serde(rename = "p50RatioPercent")]
    pub p50_ratio_percent: Option<u64>,
    #[serde(rename = "p90RatioPercent")]
    pub p90_ratio_percent: Option<u64>,
    #[serde(rename = "maxRatioPercent")]
    pub max_ratio_percent: Option<u64>,
}

/// 두 모델의 정면 비교 하나 — multi-engine-routing.md 8절/12절.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HeadToHead {
    /// 비교된 두 모델. 정렬되어 있으므로 `wins[0]`은 `models[0]`의 것이다.
    pub models: [String; 2],
    /// 각 모델이 이긴 **태스크** 수. 쟁점 수가 아니다 — 아래 `ModelEvaluation` 주석 참조.
    pub wins: [u64; 2],
    /// 두 모델이 같은 수의 쟁점에서 선택된 태스크. 승자가 없다.
    pub ties: u64,
    /// 부호 검정(단측)의 p-value — **승패가 동전 던지기라는 가설 아래** 이만큼 치우칠 확률.
    #[serde(rename = "pValue")]
    pub p_value: f64,
    pub verdict: EvaluationVerdict,
}

/// 이 비교를 **라우팅에 반영해도 되는가.**
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationVerdict {
    /// **완승이어도** 유의할 수 없는 표본 수. 여기서 최소 표본이 유도된다 — 상수가 아니다.
    TooFewToSeparate,
    /// 표본은 갈릴 수 있는 크기인데 갈리지 않았다. **"차이가 없다"가 아니라 "못 갈랐다"이다.**
    NoDifference,
    /// 한쪽이 유의하게 더 자주 선택됐다.
    Separated { better: String },
}

/// 부호 검정의 유의수준. **관례적 상수다** — 0.05에 자연법칙이 있는 것은 아니다.
///
/// 여기 적어두는 이유는 이 값이 아래 최소 표본 수를 **결정**하기 때문이다. 바꾸면 최소치가
/// 따라 움직이므로, 두 값을 각각 손으로 적어두면 언젠가 어긋난다.
pub const SIGN_TEST_ALPHA: f64 = 0.05;

/// **완승했을 때조차** 유의할 수 없는 표본 크기의 경계.
///
/// 유도한다: 한쪽이 n번 모두 이길 확률은 동전 던지기 아래 `0.5^n`이므로, 그 값이 α보다 크면
/// 그 표본으로는 무엇을 관측하든 갈릴 수 없다. α=0.05에서 n=5다.
///
/// **이 숫자를 상수로 박지 않는 이유**: 박아두면 α를 바꿨을 때 최소치가 따라오지 않고, 그러면
/// "유의하다"고 말하면서 실제로는 유의할 수 없는 표본을 통과시킨다. 그 종류의 오류는 값이
/// 그럴듯해서 눈으로 잡히지 않는다.
pub fn min_separable_comparisons() -> u64 {
    let mut n: u64 = 1;
    // 0.5^n은 n=1074 부근에서 f64 하한에 닿는다. α가 0보다 크면 그 훨씬 전에 멈춘다.
    while 0.5_f64.powi(n as i32) > SIGN_TEST_ALPHA && n < 1_074 {
        n += 1;
    }
    n
}

/// 부호 검정(단측) p-value. `wins` 쪽이 우연만으로 이만큼 이상 이길 확률.
///
/// 로그 공간에서 더한다. `0.5^n`을 직접 곱하면 n이 커질 때 0으로 내려앉는데, 그러면
/// **50:50인 큰 표본도 p=0**이 되어 "유의하다"로 읽힌다 — 값이 그럴듯해서 잡히지 않는 종류의
/// 고장이다.
pub fn sign_test_p_value(wins: u64, losses: u64) -> f64 {
    let n = wins + losses;
    if n == 0 {
        return 1.0;
    }
    let k = wins.max(losses);
    // 누적 로그 팩토리얼. n이 커도 O(n)이고 정밀도가 유지된다.
    let mut log_fact = vec![0.0_f64; (n + 1) as usize];
    for i in 1..=n {
        log_fact[i as usize] = log_fact[(i - 1) as usize] + (i as f64).ln();
    }
    let ln_half = 0.5_f64.ln();
    let mut sum = 0.0_f64;
    for i in k..=n {
        let ln_c = log_fact[n as usize] - log_fact[i as usize] - log_fact[(n - i) as usize];
        sum += (ln_c + (n as f64) * ln_half).exp();
    }
    // `min`을 쓰면 NaN이 1.0으로 **세탁된다** — 계산이 깨진 상태가 "유의하지 않음"과
    // 똑같이 보인다. `clamp`는 NaN을 그대로 통과시키므로 고장이 값에 남는다.
    sum.clamp(0.0, 1.0)
}

/// 승패에서 판정을 만든다. **판정 로직은 여기 한 곳뿐이다.**
pub fn evaluation_verdict(models: &[String; 2], wins: [u64; 2]) -> EvaluationVerdict {
    let n = wins[0] + wins[1];
    if n < min_separable_comparisons() {
        return EvaluationVerdict::TooFewToSeparate;
    }
    if sign_test_p_value(wins[0], wins[1]) > SIGN_TEST_ALPHA {
        return EvaluationVerdict::NoDifference;
    }
    let better = if wins[0] > wins[1] { 0 } else { 1 };
    EvaluationVerdict::Separated {
        better: models[better].clone(),
    }
}

/// 모델 평가 — multi-engine-routing.md 12절 "표본 몇 개부터 라우팅에 반영할 것인가".
///
/// # 문항보다 먼저 답해야 하는 것이 있었다
///
/// 12절은 **표본 수의 임계**를 물었다. 그런데 임계를 정하기 전에 물어야 하는 것은
/// **어떤 관측이 애초에 모델 간 비교가 되는가**이고, 대부분의 관측은 되지 않는다.
///
/// `verificationPassRate`가 그렇다. 어떤 모델이 어떤 태스크를 받았는지는 **라우터가 정한다.**
/// 즉 그 비율은 라우터가 만든 분포 위에서 재는 값이고, 모델이 아니라 **그 모델에게 배정된
/// 태스크가 쉬웠는지**를 함께 담고 있다. 표본이 아무리 쌓여도 이 편향은 줄지 않는다 —
/// 오히려 좁은 신뢰구간이 붙어 더 그럴듯해진다. 8절의 부트스트랩 순환이 남긴 잔여물이다.
///
/// **태스크 난이도가 상쇄되는 관측은 하나뿐이다**: 대조 실행(13절 co-executor)에서 두 모델이
/// **같은 태스크·같은 스냅샷**에 대해 낸 안을 사용자가 고른 결과. 여기서만 두 모델이 같은
/// 문제를 풀었고, 그래서 승패가 모델의 차이를 말한다.
///
/// # 왜 쟁점이 아니라 태스크로 세는가
///
/// 한 태스크의 쟁점들은 **같은 두 초안**에서 나온다. 쟁점으로 세면 쟁점 4개짜리 태스크 하나가
/// 표본 4가 되어 유의성이 부풀려진다 — 독립이 아닌 것을 독립으로 센 것이다. 그래서 태스크마다
/// 다수결로 승자를 하나 정하고, 동수면 무승부로 둔다.
///
/// # 사용자가 판정자인 것이 문제가 아니라 이유다
///
/// 여기서 이기고 진다는 것은 "사용자가 그 모델의 해석을 골랐다"이다. 요구에 대한 최종 권위는
/// 사용자이므로(product-strategy.md 16절), 이건 대리 지표가 아니라 **재려던 것 그 자체**다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ModelEvaluation {
    /// 모델 쌍(정렬된 두 ID를 ` vs `로 이은 키) → 정면 비교.
    #[serde(rename = "headToHead")]
    pub head_to_head: BTreeMap<String, HeadToHead>,
    /// 대조를 돌린 태스크 수. 아래 모든 수의 상위 분모다.
    #[serde(rename = "contrastTasks")]
    pub contrast_tasks: u64,
    /// 사용자가 두 안을 **모두 버리고** 직접 적어 승자가 없는 태스크.
    ///
    /// 어느 모델의 패배도 아니지만 버리지 않는다 — 이 수가 크면 갈라야 할 것은 모델이 아니라
    /// 초안 프롬프트다.
    #[serde(rename = "bothRejected")]
    pub both_rejected: u64,
    /// 사용자 판정이 없어 비교가 성립하지 않은 태스크(쟁점 0건, 카드가 뜨지 않음).
    #[serde(rename = "noVerdict")]
    pub no_verdict: u64,
    /// 선택을 모델에 **귀속시키지 못한** 태스크.
    ///
    /// 귀속은 `USER_DECISION_RECORDED.optionId` → `DISAGREEMENT_DETECTED`의
    /// `fromProposalId` → `DRAFT_RECEIVED.model`로 세 번 잇는다. 한 곳이라도 끊기면 그 태스크는
    /// **조용히 사라지는 대신** 여기 남는다 — 조용히 버리면 배선이 끊긴 상태가
    /// "아직 대조를 안 돌렸다"와 똑같이 보인다.
    pub unattributed: u64,
}

/// product-strategy.md 14절 **보조 지표** 표의 순수 집계들.
///
/// # 이벤트는 쌓이는데 읽는 곳이 없었다
///
/// 14절은 "집계는 `tomverse-host metrics`가 저장된 이벤트에서 계산한다"고 적어두었다. 그런데
/// 표의 여러 행(첫 시도 통과율, 승인율·거부율, 되돌리기 비율, 위험 명령 차단률)은 **이벤트만
/// 있고 집계가 없었다.** 기록은 M0부터 하고 있었으므로 데이터를 잃지는 않았지만, "실사용이
/// 쌓이면 본다"고 적어둔 값을 정작 볼 방법이 없는 상태였다.
///
/// # 이건 열린 질문이 아니라 운영 지표다
///
/// 그래서 `openQuestions`에 넣지 않는다. 열린 질문은 **설계를 바꿀지 말지**를 묻고 최소 표본
/// 가드가 필요하지만, 이쪽은 그냥 "지금 어떤가"를 보는 값이다. 대신 면제 목록에 그 사실을
/// 적어 둔다 — 아무 말 없이 지나가는 길은 두지 않는다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct OperationalCounts {
    /// 작업 후(post) 검증 리포트 수. 아래 첫 시도 비율의 분모다.
    #[serde(rename = "postVerifications")]
    pub post_verifications: u64,
    /// 그중 **재시도 없이**(attemptNumber = 0) 통과한 수.
    #[serde(rename = "firstAttemptPasses")]
    pub first_attempt_passes: u64,
    #[serde(rename = "approvalsGranted")]
    pub approvals_granted: u64,
    #[serde(rename = "approvalsDenied")]
    pub approvals_denied: u64,
    /// 되돌리기가 **완료된** 태스크 수. 시작만 하고 끝나지 않은 것은 세지 않는다.
    #[serde(rename = "tasksRolledBack")]
    pub tasks_rolled_back: u64,
    /// Policy Gate가 내린 판정 수와 그중 거부. 차단률의 분자·분모다.
    #[serde(rename = "policyDecisions")]
    pub policy_decisions: u64,
    #[serde(rename = "policyDenials")]
    pub policy_denials: u64,
}

/// 예약이 실제 비용의 몇 배였는가 — multi-engine-routing.md 10.6절.
///
/// # 문서가 "측정할 수 있다"고 적어둔 것이 측정되지 않고 있었다
///
/// `TASK_BUDGET_HEADROOM`(×3)은 유도하지 못한 상수이고, 그 주석은 *"그 간극이 얼마인지는
/// `BUDGET_RESERVATION_OPENED`의 `reservedUsd`가 쌓이면 측정할 수 있다"* 고 적어두었다.
/// 그런데 **그 이벤트를 읽는 집계가 없었다.** 실사용이 아무리 쌓여도 아무도 읽지 못한다 —
/// "데이터를 기다린다"와 "데이터를 읽을 수 없다"는 다른 상태이고, 후자는 기다려도 오지 않는다.
///
/// # 왜 배수가 필요한가
///
/// 예약은 그 호출의 **최대** 비용으로 열리고 확정은 **실제** 비용으로 된다. 상한을 과거 실제
/// 지출에 맞추면 남은 예산이 다음 호출의 최대치를 못 덮어 **정상 태스크가 거부된다.** 그래서
/// 배수가 필요하고, 그 크기가 여기서 나온다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct BudgetHeadroom {
    /// 예약과 확정이 짝지어진 호출 수. **비율의 분모다.**
    pub settled: u64,
    /// 확정은 됐는데 실제 비용이 0이라 배수를 낼 수 없는 호출 수.
    ///
    /// fake 공급자나 단가를 모르는 모델이 여기 들어온다. **0을 배수 계산에 넣으면 무한대가
    /// 되므로 빼되, 뺀 사실을 남긴다** — 조용히 빼면 분모가 왜 작은지 알 수 없다.
    #[serde(rename = "settledWithoutCost")]
    pub settled_without_cost: u64,
    /// 열렸다가 **취소된** 예약 수(호출이 일어나지 않았다).
    pub released: u64,
    /// 열린 채로 끝난 예약 수. 0이 아니면 그 요청은 과금됐을 수 있다(10.7절).
    pub unresolved: u64,
    /// `예약 / 실제` × 100의 백분위. 300이면 지금 상수(×3)가 맞는다는 뜻이다.
    #[serde(rename = "p50ReservedOverActualPercent")]
    pub p50_reserved_over_actual_percent: Option<u64>,
    #[serde(rename = "p90ReservedOverActualPercent")]
    pub p90_reserved_over_actual_percent: Option<u64>,
    #[serde(rename = "maxReservedOverActualPercent")]
    pub max_reserved_over_actual_percent: Option<u64>,
}

/// 검수가 무엇을 했는가 — product-strategy.md 14절.
///
/// # 이름에 추론을 넣지 않는다
///
/// 14절 표에는 **"검수 모델이 실제 결함을 발견한 비율"** 과 **"잘못된 검수 경고 비율"** 이
/// 있었고, 12절에는 그 판정 기준을 정하라는 항목이 남아 있었다. 정하려고 보니 **production에서는
/// 정할 수 없다.**
///
/// - 표가 적어둔 출처("검수 지적 항목 중 테스트로 확인된 것")는 기준↔테스트 연결과 같은
///   문제이고(state-machine 17.9절), 그쪽 결론은 이미 **"대부분 이을 수 없다"** 였다.
///   같은 규칙을 지적에 적용하면 값은 거의 언제나 0이고, 0을 피하려면 모델에게 판정을 맡겨야
///   하는데 그건 CLAUDE.md 원칙 1이 막는 바로 그 일이다.
/// - 결정론적으로 답하려면 **반사실**이 필요하다: 그 지적을 반영하지 않은 초안이 검증을
///   통과했는가. production은 한 태스크에 한 경로만 태우므로 그 반사실이 없다.
///
/// 반사실이 있는 곳은 게이트 하네스다(같은 초안을 Arm A는 검수 없이, Arm C는 검수와 함께
/// 태운다). 그래서 그 두 지표는 **실험 지표**로 옮겼고, 여기 남는 것은 production에서 실제로
/// 관측되는 사실뿐이다 — 14절 자신이 "오탐률이라는 이름의 지표는 두지 않았다"고 적어둔 규율의
/// 연장이다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ReviewerFindings {
    /// 검수가 실제로 돌아 판정을 낸 태스크 수. 아래 모든 수의 분모다.
    #[serde(rename = "tasksReviewed")]
    pub tasks_reviewed: u64,
    /// verdict별 태스크 수 (마지막 판정 기준).
    #[serde(rename = "byVerdict")]
    pub by_verdict: BTreeMap<String, u64>,
    /// REVISE 판정 수.
    #[serde(rename = "revisionsProposed")]
    pub revisions_proposed: u64,
    /// 그중 수정본이 초안과 **실제로 달랐던** 수.
    ///
    /// 같으면 그 지적은 산문만 남기고 아무것도 바꾸지 못한 것이다. 이건 "틀린 지적"이라는
    /// 뜻이 아니다 — 관측된 것은 patch가 같다는 사실뿐이다.
    #[serde(rename = "revisionsThatChangedThePatch")]
    pub revisions_that_changed_the_patch: u64,
    /// REVISE인데 수정본이 아예 없던 수. 이 경로는 태스크를 실패로 끝낸다.
    #[serde(rename = "revisionsWithoutPatch")]
    pub revisions_without_patch: u64,
    /// **수정본을 실행한 태스크**의 최종 상태 분포.
    ///
    /// "검수가 도움이 됐는가"에 답하지 않는다 — 검수 없이 돌렸을 때의 결과가 없기 때문이다.
    /// 답하는 것은 "수정본을 태운 태스크들이 어떻게 끝났는가"뿐이다.
    #[serde(rename = "outcomeAfterRevision")]
    pub outcome_after_revision: BTreeMap<String, u64>,
}

/// 쌍의 기록을 찾거나 만든다. 키는 정렬된 두 모델 ID이므로 순서가 뒤집혀도 같은 칸에 쌓인다.
fn head_to_head_entry<'a>(
    map: &'a mut BTreeMap<String, HeadToHead>,
    models: [String; 2],
) -> &'a mut HeadToHead {
    let key = format!("{} vs {}", models[0], models[1]);
    map.entry(key).or_insert(HeadToHead {
        models,
        wins: [0, 0],
        ties: 0,
        // 판정은 집계가 끝난 뒤 한 번에 채운다 — 중간값으로 채우면 그 값이 최종처럼 보인다.
        p_value: 1.0,
        verdict: EvaluationVerdict::TooFewToSeparate,
    })
}

/// 한 대조 태스크가 모델 비교에 무엇을 기여하는가.
///
/// **모든 결말에 이름이 있다.** "기여하지 않음"을 하나로 뭉치면, 배선이 끊긴 것과 사용자가
/// 판정하지 않은 것과 두 안이 모두 버려진 것이 같은 값이 된다 — 셋은 서로 다른 조치를 부른다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContrastOutcome {
    /// 대조를 돌리지 않은 태스크. 비교의 모집단이 아니다.
    NotContrasted,
    /// 대조는 돌렸지만 사용자 판정이 없었다(쟁점 0건이거나 카드가 뜨지 않았다).
    NoVerdict,
    /// 사용자가 두 안을 모두 버리고 직접 적었다.
    BothRejected,
    /// 선택을 모델에 이을 수 없었다.
    Unattributed,
    /// 두 모델이 같은 수의 쟁점에서 선택됐다.
    Tied { models: [String; 2] },
    /// 한쪽이 더 많이 선택됐다. `winner`는 `models`의 인덱스다.
    Won { models: [String; 2], winner: usize },
}

/// 대조 태스크 하나에서 승자를 가린다.
///
/// 잇는 순서: `USER_DECISION_RECORDED.decisions[].optionId`
/// → `DISAGREEMENT_DETECTED`의 `question.options[].fromProposalId`
/// → `DRAFT_RECEIVED.model`.
///
/// **새 계측을 붙이지 않았다.** 세 이벤트가 이미 각자 필요한 것을 남기고 있었고, 없던 것은
/// 그 셋을 잇는 일뿐이었다. 그래서 이 집계는 오늘 이전에 쌓인 로그에도 그대로 적용된다.
pub fn contrast_outcome(events: &[crate::store::StoredEvent]) -> ContrastOutcome {
    let contrasted = events.iter().any(|e| {
        e.event_type == "DISAGREEMENT_DETECTED"
            && e.payload.get("contrasted").and_then(Value::as_bool) == Some(true)
    });
    if !contrasted {
        return ContrastOutcome::NotContrasted;
    }

    // proposalId → model
    let mut proposal_model: BTreeMap<String, String> = BTreeMap::new();
    for event in events.iter().filter(|e| e.event_type == "DRAFT_RECEIVED") {
        let (Some(id), Some(model)) = (
            event.payload.get("proposalId").and_then(Value::as_str),
            event.payload.get("model").and_then(Value::as_str),
        ) else {
            continue;
        };
        proposal_model.insert(id.to_string(), model.to_string());
    }

    // optionId → proposalId
    let mut option_proposal: BTreeMap<String, String> = BTreeMap::new();
    for event in events.iter().filter(|e| e.event_type == "DISAGREEMENT_DETECTED") {
        let Some(items) = event.payload.get("disagreements").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(options) = item
                .get("question")
                .and_then(|q| q.get("options"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for option in options {
                let (Some(option_id), Some(from)) = (
                    option.get("optionId").and_then(Value::as_str),
                    option.get("fromProposalId").and_then(Value::as_str),
                ) else {
                    continue;
                };
                option_proposal.insert(option_id.to_string(), from.to_string());
            }
        }
    }

    // 모델이 정확히 둘일 때만 정면 비교가 성립한다. 하나면 대조가 실제로 돌지 않은 것이고,
    // 셋 이상이면 이 집계가 다루는 모양이 아니다 — 어느 쪽이든 승패로 세지 않는다.
    let mut models: Vec<String> = proposal_model.values().cloned().collect();
    models.sort();
    models.dedup();
    if models.len() != 2 {
        return ContrastOutcome::Unattributed;
    }
    let pair: [String; 2] = [models[0].clone(), models[1].clone()];

    let mut picks = [0_u64, 0_u64];
    let mut freeform = 0_u64;
    let mut answered = 0_u64;
    for event in events.iter().filter(|e| e.event_type == "USER_DECISION_RECORDED") {
        let Some(decisions) = event.payload.get("decisions").and_then(Value::as_array) else {
            continue;
        };
        for decision in decisions {
            answered += 1;
            if decision.get("freeform").and_then(Value::as_bool) == Some(true) {
                freeform += 1;
                continue;
            }
            let model = decision
                .get("optionId")
                .and_then(Value::as_str)
                .and_then(|o| option_proposal.get(o))
                .and_then(|p| proposal_model.get(p));
            let Some(model) = model else {
                // 한 선택이라도 이을 수 없으면 이 태스크의 승패를 믿을 수 없다.
                return ContrastOutcome::Unattributed;
            };
            if *model == pair[0] {
                picks[0] += 1;
            } else if *model == pair[1] {
                picks[1] += 1;
            } else {
                return ContrastOutcome::Unattributed;
            }
        }
    }

    if answered == 0 {
        return ContrastOutcome::NoVerdict;
    }
    if picks[0] == 0 && picks[1] == 0 && freeform > 0 {
        return ContrastOutcome::BothRejected;
    }
    if picks[0] == picks[1] {
        return ContrastOutcome::Tied { models: pair };
    }
    let winner = if picks[0] > picks[1] { 0 } else { 1 };
    ContrastOutcome::Won { models: pair, winner }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Metrics {
    pub coverage: CriteriaCoverage,
    pub conflicts: ConflictOutcomes,
    pub cancellation: CancellationLatency,
    #[serde(rename = "cardAnswers")]
    pub card_answers: CardAnswers,
    #[serde(rename = "commitSizes")]
    pub commit_sizes: CommitSizes,
    /// 관측에서 유도한 "큰 변경" 문턱. **집계 결과이지 설정이 아니다.**
    #[serde(rename = "largeChangeThreshold")]
    pub large_change_threshold: Option<LargeChangeThreshold>,
    /// 관측에서 유도한 강제 포기 임계값. **집계 결과이지 설정이 아니다** —
    /// 데이터가 없으면 기본값과 그 사실을 그대로 돌려준다.
    #[serde(rename = "forceAbandonThreshold")]
    pub force_abandon_threshold: Option<ForceAbandonThreshold>,
    #[serde(rename = "taskCosts")]
    pub task_costs: TaskCosts,
    #[serde(rename = "tokenEstimate")]
    pub token_estimate: TokenEstimateAccuracy,
    /// TRIAGE 테스트 파일 제외 규칙의 오분류 빈도 (context-engine.md 11.1절).
    #[serde(rename = "testFileRule")]
    pub test_file_rule: TestFileRule,
    /// 관측에서 유도한 태스크당 예산 상한 제안. **집계 결과이지 설정이 아니다.**
    #[serde(rename = "taskBudgetThreshold")]
    pub task_budget_threshold: Option<TaskBudgetThreshold>,
    /// 인덱스 캐시의 이득 (context-engine.md 2.1절).
    #[serde(rename = "indexCache")]
    pub index_cache: IndexCache,
    /// IPC 한 줄 크기 분포 (process-architecture.md 3.1절).
    #[serde(rename = "ipcLineSizes")]
    pub ipc_line_sizes: IpcLineSizes,
    /// 모델 정면 비교 (multi-engine-routing.md 12절).
    #[serde(rename = "modelEvaluation")]
    pub model_evaluation: ModelEvaluation,
    /// 검수가 무엇을 했는가 (product-strategy.md 14절).
    #[serde(rename = "reviewerFindings")]
    pub reviewer_findings: ReviewerFindings,
    /// 예약이 실제 비용의 몇 배였는가 (multi-engine-routing.md 10.6절).
    #[serde(rename = "budgetHeadroom")]
    pub budget_headroom: BudgetHeadroom,
    /// 14절 보조 지표의 순수 집계.
    #[serde(rename = "operational")]
    pub operational: OperationalCounts,
    /// 집계에 들어간 태스크 수 (기준이 없는 태스크 포함).
    #[serde(rename = "tasksScanned")]
    pub tasks_scanned: u64,
    /// **아직 답하지 못한 질문들과 그 답이 나올 때가 됐는지.**
    ///
    /// 이 목록이 비면 "열린 질문이 없다"는 뜻이고, 그건 설계 문서의 미해결 목록과 어긋난
    /// 상태다. 지표를 추가하면서 여기 넣는 것을 잊으면 그 지표는 **아무도 읽지 않는 숫자**가 된다.
    #[serde(rename = "openQuestions")]
    pub open_questions: Vec<OpenQuestion>,
}

/// IPC 한 줄 크기의 분포 (process-architecture.md 3.1절 — 32 MiB가 맞는 값인가).
///
/// **최댓값 하나로는 답이 안 나온다.** "3 MiB짜리가 한 번 있었다"와 "3 MiB짜리가 늘 온다"는
/// 상한을 낮출 수 있는지에 대해 정반대를 말하는데, 최댓값은 둘을 구별하지 못한다.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct IpcLineSizes {
    /// 줄 크기를 보고한 **태스크 수.**
    ///
    /// **표본은 줄이 아니라 태스크다.** 한 태스크가 줄을 수십 개 주고받으므로 줄로 세면
    /// 한 번 돌린 것만으로 "표본이 충분하다"가 되어 버린다 — 실제로 e2e 한 번에 43줄이
    /// 나왔다. 질문은 "여러 태스크에 걸쳐 어떤 크기가 오가는가"이므로 분모도 태스크다.
    #[serde(rename = "tasksObserved")]
    pub tasks_observed: u64,
    /// 관측한 줄 수. 0이면 아래 값들은 아무것도 말하지 않는다.
    pub lines: u64,
    /// 관측한 가장 큰 줄(바이트). **상한을 판단하는 값이다.**
    #[serde(rename = "maxBytes")]
    pub max_bytes: u64,
    /// 상한(`MAX_IPC_LINE_BYTES`) 대비 최댓값의 비율(%). 상한이 얼마나 헐거운지가 여기 보인다.
    #[serde(rename = "maxPercentOfLimit")]
    pub max_percent_of_limit: Option<u64>,
    /// 구간별 줄 수. 키는 구간의 상한(바이트).
    #[serde(rename = "byUpToBytes")]
    pub by_up_to_bytes: BTreeMap<u64, u64>,
}

/// 아직 답하지 못한 질문 하나와 **그 답이 나올 때가 됐는지**.
///
/// # 왜 필요한가
///
/// 이 파일의 지표 대부분은 제품을 굴리기 위한 값이 아니라 **설계 문서의 열린 항목에 답하려고**
/// 있다. 그런데 집계는 표본이 3개여도 비율을 낸다. `no_test_reference 4/5`를 보고 "압도적이다"라고
/// 읽는 순간, 문서가 경계하라고 적어둔 바로 그 성급한 조치로 간다.
///
/// 유도 문턱들에는 이미 이런 가드가 있다(`MIN_LATENCY_SAMPLES` 등 — 표본이 모자라면 유도값을
/// 내지 않는다). **열린 질문들에는 없었다.** 같은 규율을 그쪽에도 준다.
///
/// # 왜 `ready`가 아니라 `EnoughToLook`인가
///
/// 표본이 최소치를 넘었다는 것은 "이제 답이 믿을 만하다"가 아니라 **"이제 들여다볼 값이 있다"**는
/// 뜻이다. `ready`라고 부르면 그 숫자가 확정된 답처럼 읽히고, 그건 이 가드가 막으려던 것과 같은
/// 종류의 착시다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    /// 표본이 최소치에 못 미친다. **비율을 읽지 말 것.**
    InsufficientSamples,
    /// 들여다볼 값이 생겼다. 확정된 답이라는 뜻은 아니다.
    EnoughToLook,
}

/// 열린 질문 하나.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OpenQuestion {
    /// 설계 문서의 항목과 잇는 열쇠.
    pub id: &'static str,
    /**
     * 이 질문이 **어느 집계를 읽는가** (`Metrics`의 JSON 키).
     *
     * 이 필드가 없을 때 이 파일의 모듈 주석은 "지표를 추가하면서 여기 넣는 것을 잊으면 그
     * 지표는 아무도 읽지 않는 숫자가 된다"고 **경고만** 하고 있었다. 경고는 잊히고, 잊힌 것은
     * 조용하다 — 실제로 `budgetHeadroom`이 그렇게 빠져 있었다(문서는 "측정할 수 있다"고
     * 적어두었는데 집계가 없었다).
     *
     * 이제 테스트가 `Metrics`의 모든 키를 훑어 질문이 읽거나 면제 목록에 있는지 확인한다.
     */
    pub metric: &'static str,
    /// 무엇을 묻는가.
    pub question: &'static str,
    /// **이 질문의 분모.** 지표마다 세는 대상이 다르므로 여기 적어둔다 — 잘못된 분모로 읽는
    /// 것이 표본이 모자란 것보다 나쁘다(그쪽은 적어도 틀린 줄 안다).
    pub denominator: &'static str,
    /// 지금까지 쌓인 표본 수.
    pub samples: u64,
    /// 들여다보기 시작할 최소치.
    #[serde(rename = "minSamples")]
    pub min_samples: u64,
    pub readiness: Readiness,
    /// 답이 나왔을 때 **어디를 고치는가.** 이게 없으면 관측이 결정으로 이어지지 않는다.
    #[serde(rename = "actOn")]
    pub act_on: &'static str,
}

/// 열린 질문을 들여다보기 시작할 표본 수.
///
/// **유도하지 못한 상수다.** 유도 문턱들이 쓰는 10(`MIN_LATENCY_SAMPLES` 등)보다 크게 잡은
/// 이유는 재는 것이 다르기 때문이다: 그쪽은 분포의 백분위이고 여기는 **비율**이라, 10건에서는
/// 한 건이 10%를 움직인다. 30은 "한 건이 비율을 3%보다 크게 흔들지 않는" 수준으로 고른
/// 관례적 선택이며 관측이 아니다 — 이 사실을 적어두는 이유는, 근거 없는 숫자가 근거 있는
/// 숫자와 코드에서 구별되지 않기 때문이다.
pub const MIN_OPEN_QUESTION_SAMPLES: u64 = 30;

fn open_question(
    id: &'static str,
    metric: &'static str,
    question: &'static str,
    denominator: &'static str,
    samples: u64,
    act_on: &'static str,
) -> OpenQuestion {
    open_question_with_min(id, metric, question, denominator, samples, MIN_OPEN_QUESTION_SAMPLES, act_on)
}

/// `Metrics`의 키 중 **질문이 읽지 않아도 되는 것**과 그 이유.
///
/// 면제를 목록으로 두는 이유: 새 지표를 넣을 때 "질문을 붙이거나, 여기 이유를 적거나" 둘 중
/// 하나를 하게 만든다. 아무 말 없이 지나가는 길을 없앤다.
pub const METRICS_WITHOUT_QUESTION: &[(&str, &str)] = &[
    ("cancellation", "forceAbandonThreshold의 입력. 유도값 쪽에 자체 표본 가드가 있다"),
    ("commitSizes", "largeChangeThreshold의 입력. 같은 이유"),
    ("taskCosts", "taskBudgetThreshold의 입력. 같은 이유"),
    ("largeChangeThreshold", "유도된 문턱 자체 — 표본이 모자라면 값을 내지 않는다"),
    ("forceAbandonThreshold", "유도된 문턱 자체"),
    ("taskBudgetThreshold", "유도된 문턱 자체"),
    ("tasksScanned", "분모/부기 — 질문이 아니라 다른 수를 읽는 근거다"),
    ("openQuestions", "질문 목록 자체"),
    (
        "operational",
        "14절 보조 지표 — 설계를 바꿀지 묻는 열린 질문이 아니라 '지금 어떤가'를 보는 운영 값이다. 최소 표본 가드가 필요 없다",
    ),
];

/// 최소치를 **유도할 수 있는** 질문용.
///
/// 대부분의 열린 질문은 비율을 재므로 최소치가 관례적 상수일 수밖에 없다
/// (`MIN_OPEN_QUESTION_SAMPLES`). 그러나 검정으로 판정하는 질문은 **완승해도 유의할 수 없는
/// 표본 크기**가 검정 자체에서 나온다. 그런 질문에까지 관례적 상수를 씌우면, 이미 갈린 결과를
/// "표본 부족"이라고 부르게 된다.
fn open_question_with_min(
    id: &'static str,
    metric: &'static str,
    question: &'static str,
    denominator: &'static str,
    samples: u64,
    min_samples: u64,
    act_on: &'static str,
) -> OpenQuestion {
    OpenQuestion {
        id,
        metric,
        question,
        denominator,
        samples,
        min_samples,
        readiness: if samples >= min_samples {
            Readiness::EnoughToLook
        } else {
            Readiness::InsufficientSamples
        },
        act_on,
    }
}

/// 집계된 값에서 열린 질문들의 준비 상태를 만든다.
///
/// **표본 수를 여기서 다시 세지 않는다.** 위에서 이미 센 값을 읽는다 — 두 번 세면 두 수가
/// 어긋날 수 있고, 그때 어느 쪽이 정본인지 알 방법이 없다.
fn open_questions(m: &Metrics) -> Vec<OpenQuestion> {
    vec![
        open_question(
            "criteriaCoverage",
            "coverage",
            "기준을 테스트에 이을 수 있는 경우가 실제로 얼마나 되는가 (state-machine 17.9절)",
            "판정된 기준 개수",
            m.coverage.criteria,
            "no_test_reference가 압도적이면 (a) 기준을 적을 때 테스트를 함께 적게 하거나 (b) 잇는 규칙을 넓힌다. **(b)를 먼저 하고 싶은 유혹을 경계할 것** — 늘어난 확인이 근거 있는지는 같은 규칙으로 검사할 수 없다. 다만 17.9.1절이 고친 것은 (b)가 아니라 **실재 판정의 오류**였다: 증거의 문턱은 그대로 두고 '이 파일이 있는가'에 잘못 답하던 것을 고쳤으므로, 그 변경 이전 기록과 이후 기록은 같은 축이 아니다",
        ),
        open_question(
            "conflictOutcomes",
            "conflicts",
            "기준 충돌 게이트가 실제 문제를 잡는가, 프롬프트가 기준을 안 읽는 것인가 (17.10절 8)",
            "결말이 기록된 충돌 건수",
            m.conflicts.settled,
            "plan_unchanged가 해석이 그대로인 쪽에 몰리면 프롬프트를, 해석이 달라진 쪽에 몰리면 게이트가 잡은 것이 실제 문제였는지를 본다",
        ),
        open_question(
            "cardQuestions",
            "cardAnswers",
            "한 카드 질문 상한 4개와 필드 랭킹이 맞는가 (17.10절 9·10)",
            "카드에서 받은 답의 개수",
            m.card_answers
                .by_position
                .values()
                .map(|p| p.first_option + p.later_option + p.freeform + p.unknown)
                .sum(),
            "**byFieldAndPosition을 본다** — byPosition과 byField는 교락된 두 축의 주변 분포라 따로 보면 자리 때문인지 필드 때문인지 가를 수 없다. 한 필드 안에서 자리별로 비교하고, 고칠 자리는 DISAGREEMENT_FIELD_RANK 한 줄이다. **다만 랭킹의 '예산 초과 시 무엇을 버릴지'는 지금 발생할 수 없다** — 필드가 3개라 상한 4를 넘을 수 없으므로 랭킹의 실제 효과는 자리 하나뿐이다",
        ),
        open_question(
            "tokenEstimate",
            "tokenEstimate",
            "토큰 상한 계수가 실제로 상한인가 (context-engine 8.1절)",
            "추정과 실제를 둘 다 아는 호출 수",
            m.token_estimate.calls,
            "callsWhereActualExceededEstimate가 0이 아니면 상한이 아니므로 계수를 올린다. p90 비율이 한참 낮으면 과대 추정이므로 내린다",
        ),
        open_question(
            "testFileRule",
            "testFileRule",
            "TRIAGE의 테스트 파일 제외 규칙이 오분류를 얼마나 내는가 (context-engine 11.1절)",
            "**규칙이 판정을 바꾼** 태스크 수 (simple 건수가 아니다)",
            m.test_file_rule.tasks_where_rule_changed_tier,
            "자주 틀리면 고칠 자리는 TEST_FILE_PATTERNS가 아니라 규칙 자체다 — 테스트 파일을 고치는 것이 작업인 태스크를 어떻게 알아볼 것인가가 진짜 질문이다",
        ),
        open_question(
            "ipcLineSize",
            "ipcLineSizes",
            "NDJSON 한 줄 상한 32 MiB가 맞는 값인가 (process-architecture 3.1절)",
            "줄 크기를 보고한 **태스크 수** (줄 수가 아니다 — 한 태스크가 수십 줄을 주고받는다)",
            m.ipc_line_sizes.tasks_observed,
            "maxPercentOfLimit이 한 자리 수에 머무르면 상한이 헐거운 것이다. 다만 **낮추는 것은 정당한 메시지를 프로토콜 위반으로 죽이는 쪽**이므로, 분포의 꼬리(가장 큰 구간의 줄 수)를 함께 보고 여유를 남긴다",
        ),
        open_question_with_min(
            "modelEvaluation",
            "modelEvaluation",
            "모델 평가 데이터를 표본 몇 개부터 라우팅에 반영할 것인가 (multi-engine-routing 12절)",
            "대조 실행에서 **승패가 갈린 태스크 수** (쟁점 수가 아니다 — 한 태스크의 쟁점들은 같은 두 초안에서 나오므로 독립이 아니다)",
            m.model_evaluation
                .head_to_head
                .values()
                .map(|h| h.wins[0] + h.wins[1])
                .sum(),
            // 이 질문의 최소치만 관례적 상수가 아니다 — 검정에서 유도된다.
            min_separable_comparisons(),
            "verdict가 separated인 쌍이 생기면 그때 라우터를 데이터 기반으로 전환한다(8절). **verificationPassRate로는 전환하지 않는다** — 그 분포는 라우터가 만든 것이라 표본이 쌓여도 편향이 줄지 않는다. unattributed가 0이 아니면 먼저 그 배선부터 본다",
        ),
        open_question(
            "blockingRule",
            "cardAnswers",
            "규칙이 '묻지 않아도 된다'고 판정한 쟁점에서 사용자가 뒤집는가 (state-machine 12절)",
            "카드에서 받은 답 중 blocking 여부가 기록된 것",
            m.card_answers
                .by_blocking
                .iter()
                .filter(|(k, _)| k.as_str() != "unknown")
                .map(|(_, f)| f.picked_primary + f.picked_other + f.freeform + f.unknown)
                .sum(),
            "non_blocking 칸의 pickedOther+freeform 비율이 blocking 칸과 비슷하거나 높으면 17.4절의 blocking 규칙이 막아야 할 것을 막지 않은 것이다. **절대값이 아니라 두 칸의 비교를 볼 것** — 자리·필드 편향은 양쪽에 똑같이 걸린다",
        ),
        open_question(
            "reviewerFindings",
            "reviewerFindings",
            "검수가 patch를 실제로 바꾸는가, 산문만 남기는가 (product-strategy 14절)",
            "검수가 판정을 낸 태스크 수",
            m.reviewer_findings.tasks_reviewed,
            "revisionsThatChangedThePatch가 revisionsProposed에 비해 낮으면 검수 프롬프트가 수정본을 내놓게 하지 못하는 것이다. **이 값으로 '검수가 쓸모없다'를 판정하지 말 것** — 검수 없이 돌렸을 때의 결과가 없으므로 그 비교는 게이트 하네스에서만 성립한다",
        ),
        open_question(
            "budgetHeadroom",
            "budgetHeadroom",
            "예약이 실제 비용의 몇 배인가 — 여유 배수 ×3의 근거 (multi-engine-routing 10.6절)",
            "예약과 확정이 짝지어진 공급자 호출 수 (실제 비용이 0인 호출은 배수를 낼 수 없어 빠진다)",
            m.budget_headroom.settled,
            "p90이 300%보다 한참 낮으면 TASK_BUDGET_HEADROOM을 내린다. **올리는 쪽이 안전한 방향이 아니다** — 배수가 작으면 남은 예산이 다음 호출의 최대치를 못 덮어 정상 태스크가 거부된다. unresolved가 0이 아니면 그 요청은 과금됐을 수 있으므로(10.7절) 배수보다 그쪽을 먼저 본다",
        ),
        open_question(
            "indexCache",
            "indexCache",
            "인덱스 캐시가 이득인가 (context-engine 2.1절)",
            "구축 + 적중 횟수",
            m.index_cache.builds + m.index_cache.hits,
            "적중률이 아니라 savedMsTotal을 본다. 구축이 원래 빨랐다면 캐시는 지우는 것이 맞다",
        ),
    ]
}

/// 두 경로가 같은 파일을 가리키는가.
///
/// 스냅샷의 경로는 워크스페이스 상대이고 `FILE_MUTATED`의 경로는 Rust가 정규화한 것이라
/// 표기가 다를 수 있다. **구분자를 맞추고 뒤에서부터 본다** — 한쪽이 절대 경로여도
/// 꼬리가 같으면 같은 파일이다. Windows에서는 대소문자를 구별하지 않는다.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_start_matches("./").to_lowercase();
    let (a, b) = (norm(a), norm(b));
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

/// 저장된 이벤트에서 두 지표를 집계한다. **아무것도 쓰지 않는다.**
pub fn collect(store: &Store, workspace_path: Option<&str>) -> Result<Metrics, String> {
    let tasks = store
        .all_tasks_for_metrics(workspace_path)
        .map_err(|e| format!("작업 목록을 읽을 수 없습니다: {e}"))?;

    let mut metrics = Metrics::default();
    let mut latencies: Vec<u64> = Vec::new();
    let mut commit_files: Vec<u64> = Vec::new();
    // 마이크로 달러 정수로 모은다 — 백분위를 다른 지표와 같은 함수로 내기 위해서다.
    let mut task_cost_micros: Vec<u64> = Vec::new();
    // `실제 / 추정` × 100. 정수로 모으는 이유는 위와 같다.
    let mut token_ratios: Vec<u64> = Vec::new();
    let mut build_ms: Vec<u64> = Vec::new();
    let mut index_file_counts: Vec<u64> = Vec::new();
    // `예약 / 실제` × 100. 정수로 모으는 이유는 다른 지표와 같은 백분위 함수를 쓰기 위해서다.
    let mut headroom_ratios: Vec<u64> = Vec::new();
    for (task_id, terminal_status) in &tasks {
        metrics.tasks_scanned += 1;

        // ---- 태스크당 지출 ----
        //
        // 비용을 모르는 호출이 하나라도 있으면 **분포에서 뺀다.** 그 태스크의 합계는 하한이고,
        // 하한을 분포에 넣으면 유도된 상한이 실제보다 낮아진다 — 낮은 상한은 정상 태스크를
        // 거부하고, 그 거부의 원인이 데이터 결함이라는 사실은 어디에도 남지 않는다.
        // ---- 토큰 추정의 정확도 ----
        if let Ok((pairs, without_estimate)) = store.token_estimate_pairs(task_id) {
            for (estimated, actual) in &pairs {
                token_ratios.push(((*actual as f64 / *estimated as f64) * 100.0).round() as u64);
                if actual > estimated {
                    metrics.token_estimate.calls_where_actual_exceeded_estimate += 1;
                }
            }
            metrics.token_estimate.calls += pairs.len() as u64;
            metrics.token_estimate.calls_without_estimate += without_estimate;
        }

        if let Ok((sum, calls, unpriced)) = store.task_cost_usd(task_id) {
            if calls > 0 {
                if unpriced > 0 {
                    metrics.task_costs.tasks_with_unpriced_calls += 1;
                } else if sum.is_finite() && sum >= 0.0 {
                    task_cost_micros.push((sum * 1_000_000.0).round() as u64);
                }
            }
        }

        let events = store
            .events(task_id)
            .map_err(|e| format!("이벤트를 읽을 수 없습니다: {e}"))?;

        // ---- 커버리지: **마지막** CRITERIA_EVALUATED만 ----
        let last_evaluation = events
            .iter()
            .rev()
            .find(|e| e.event_type == "CRITERIA_EVALUATED")
            .map(|e| &e.payload);
        if let Some(payload) = last_evaluation {
            if let Some(items) = payload.get("evaluations").and_then(Value::as_array) {
                if !items.is_empty() {
                    metrics.coverage.tasks_with_criteria += 1;
                }
                for item in items {
                    metrics.coverage.criteria += 1;
                    bump(&mut metrics.coverage.by_status, item.get("status"));
                    bump(&mut metrics.coverage.by_code, item.get("code"));
                }
            }
        }

        // ---- IPC 한 줄 크기 (process-architecture.md 3.1절) ----
        for event in events.iter().filter(|e| e.event_type == "IPC_LINE_SIZES") {
            metrics.ipc_line_sizes.tasks_observed += 1;
            metrics.ipc_line_sizes.lines += event.payload.get("lines").and_then(Value::as_u64).unwrap_or(0);
            let max = event.payload.get("maxBytes").and_then(Value::as_u64).unwrap_or(0);
            metrics.ipc_line_sizes.max_bytes = metrics.ipc_line_sizes.max_bytes.max(max);
            if let Some(buckets) = event.payload.get("buckets").and_then(Value::as_array) {
                for bucket in buckets {
                    let Some(limit) = bucket.get("upToBytes").and_then(Value::as_u64) else {
                        continue;
                    };
                    *metrics.ipc_line_sizes.by_up_to_bytes.entry(limit).or_insert(0) +=
                        bucket.get("lines").and_then(Value::as_u64).unwrap_or(0);
                }
            }
        }

        // ---- TRIAGE 테스트 파일 제외 규칙 (context-engine.md 11.1절) ----
        //
        // **마지막 TRIAGE_COMPLETED를 쓴다.** 재질문 왕복으로 다시 분류될 수 있고, 질문은
        // "이 태스크가 어떤 tier로 실행됐는가"이므로 마지막이 정본이다.
        if let Some(payload) = events
            .iter()
            .rev()
            .find(|e| e.event_type == "TRIAGE_COMPLETED")
            .map(|e| &e.payload)
        {
            // 근거가 없으면 규칙이 돌지 않은 태스크다(사용자가 tier를 고르거나 강제함).
            // **분모에 넣지 않는다** — 넣으면 오분류율이 실제보다 낮아 보인다.
            if let Some(counterfactual) = payload.get("tierIfTestsCounted").and_then(Value::as_str) {
                metrics.test_file_rule.tasks_judged_by_rules += 1;
                let excluded: Vec<&str> = payload
                    .get("excludedTestFiles")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                if !excluded.is_empty() {
                    metrics.test_file_rule.tasks_with_excluded_tests += 1;
                }
                let tier = payload.get("complexityTier").and_then(Value::as_str).unwrap_or("");
                if tier != counterfactual {
                    metrics.test_file_rule.tasks_where_rule_changed_tier += 1;
                    // 제외했던 테스트 파일이 실제로 고쳐졌는가 — 그랬다면 그 파일은 작업
                    // 대상이었고, 복잡도에서 빠진 것이 오분류다.
                    let mutated_an_excluded_test = events.iter().any(|e| {
                        e.event_type == "FILE_MUTATED"
                            && e.payload
                                .get("path")
                                .and_then(Value::as_str)
                                .is_some_and(|p| excluded.iter().any(|t| same_path(t, p)))
                    });
                    if mutated_an_excluded_test {
                        metrics.test_file_rule.tasks_where_excluded_test_was_mutated += 1;
                    }
                }
            }
        }

        // ---- 14절 보조 지표 ----
        for event in &events {
            match event.event_type.as_str() {
                "APPROVAL_GRANTED" => metrics.operational.approvals_granted += 1,
                "APPROVAL_DENIED" => metrics.operational.approvals_denied += 1,
                "POLICY_DECIDED" => {
                    metrics.operational.policy_decisions += 1;
                    if event.payload.get("decision").and_then(Value::as_str) == Some("deny") {
                        metrics.operational.policy_denials += 1;
                    }
                }
                "VERIFICATION_COMPLETED" => {
                    // baseline은 "작업 전"이라 첫 시도 통과율의 대상이 아니다. 넣으면 분모가
                    // 두 배가 되고 비율이 절반으로 보인다.
                    if event.payload.get("phase").and_then(Value::as_str) != Some("post") {
                        continue;
                    }
                    metrics.operational.post_verifications += 1;
                    let first = event.payload.get("attemptNumber").and_then(Value::as_u64) == Some(0);
                    let passed = event.payload.get("overall").and_then(Value::as_str) == Some("pass");
                    if first && passed {
                        metrics.operational.first_attempt_passes += 1;
                    }
                }
                _ => {}
            }
        }
        // 되돌리기는 **태스크 단위**다. 한 태스크에서 두 번 되돌려도 되돌린 태스크는 하나다.
        if events.iter().any(|e| e.event_type == "ROLLBACK_COMPLETED") {
            metrics.operational.tasks_rolled_back += 1;
        }

        // ---- 예약 대비 실제 (multi-engine-routing.md 10.6절) ----
        for event in &events {
            match event.event_type.as_str() {
                "BUDGET_RESERVATION_RELEASED" => metrics.budget_headroom.released += 1,
                "BUDGET_RESERVATION_UNRESOLVED" => metrics.budget_headroom.unresolved += 1,
                "BUDGET_RESERVATION_SETTLED" => {
                    let reserved = event.payload.get("reservedUsd").and_then(Value::as_f64);
                    let actual = event.payload.get("actualUsd").and_then(Value::as_f64);
                    let (Some(reserved), Some(actual)) = (reserved, actual) else {
                        continue;
                    };
                    if !reserved.is_finite() || !actual.is_finite() || reserved < 0.0 || actual < 0.0 {
                        continue;
                    }
                    // 실제가 0이면 배수를 낼 수 없다. **조용히 빼지 않는다** — 빼면 분모가 왜
                    // 작은지 알 수 없고, fake 공급자로 돌린 기록이 섞였는지도 구별되지 않는다.
                    if actual == 0.0 {
                        metrics.budget_headroom.settled_without_cost += 1;
                        continue;
                    }
                    metrics.budget_headroom.settled += 1;
                    headroom_ratios.push(((reserved / actual) * 100.0).round() as u64);
                }
                _ => {}
            }
        }

        // ---- 검수가 무엇을 했는가 (product-strategy.md 14절) ----
        //
        // **마지막 REVIEW_RECEIVED를 쓴다.** REVISE 루프를 돌면 여러 번 나오는데, 질문은
        // "이 태스크에서 검수가 어떻게 끝났는가"이므로 마지막이 정본이다.
        if let Some(payload) = events
            .iter()
            .rev()
            .find(|e| e.event_type == "REVIEW_RECEIVED")
            .map(|e| &e.payload)
        {
            metrics.reviewer_findings.tasks_reviewed += 1;
            let verdict = payload
                .get("verdict")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            *metrics.reviewer_findings.by_verdict.entry(verdict.clone()).or_insert(0) += 1;

            if verdict == "REVISE" {
                metrics.reviewer_findings.revisions_proposed += 1;
                match payload.get("revisionChangedThePatch").and_then(Value::as_bool) {
                    Some(true) => {
                        metrics.reviewer_findings.revisions_that_changed_the_patch += 1;
                        *metrics
                            .reviewer_findings
                            .outcome_after_revision
                            .entry(terminal_status.clone().unwrap_or_else(|| "running".to_string()))
                            .or_insert(0) += 1;
                    }
                    Some(false) => {
                        // 수정본은 왔는데 초안과 같다 — 실행은 됐으므로 결말은 센다.
                        *metrics
                            .reviewer_findings
                            .outcome_after_revision
                            .entry(terminal_status.clone().unwrap_or_else(|| "running".to_string()))
                            .or_insert(0) += 1;
                    }
                    // `null`은 "수정본이 없었다"이다. false로 뭉개면 "바꾸지 않았다"와
                    // "바꿀 기회가 없었다"가 같은 값이 된다.
                    None => metrics.reviewer_findings.revisions_without_patch += 1,
                }
            }
        }

        // ---- 모델 정면 비교 (multi-engine-routing.md 12절) ----
        match contrast_outcome(&events) {
            ContrastOutcome::NotContrasted => {}
            ContrastOutcome::NoVerdict => {
                metrics.model_evaluation.contrast_tasks += 1;
                metrics.model_evaluation.no_verdict += 1;
            }
            ContrastOutcome::BothRejected => {
                metrics.model_evaluation.contrast_tasks += 1;
                metrics.model_evaluation.both_rejected += 1;
            }
            ContrastOutcome::Unattributed => {
                metrics.model_evaluation.contrast_tasks += 1;
                metrics.model_evaluation.unattributed += 1;
            }
            ContrastOutcome::Tied { models } => {
                metrics.model_evaluation.contrast_tasks += 1;
                head_to_head_entry(&mut metrics.model_evaluation.head_to_head, models).ties += 1;
            }
            ContrastOutcome::Won { models, winner } => {
                metrics.model_evaluation.contrast_tasks += 1;
                head_to_head_entry(&mut metrics.model_evaluation.head_to_head, models).wins[winner] += 1;
            }
        }

        // ---- 인덱스 캐시 (context-engine.md 2.1절) ----
        for event in &events {
            match event.event_type.as_str() {
                "WORKSPACE_INDEX_BUILT" => {
                    metrics.index_cache.builds += 1;
                    if let Some(ms) = event.payload.get("buildMs").and_then(Value::as_u64) {
                        build_ms.push(ms);
                    }
                    if let Some(n) = event.payload.get("fileCount").and_then(Value::as_u64) {
                        index_file_counts.push(n);
                    }
                }
                "WORKSPACE_INDEX_CACHE_HIT" => {
                    metrics.index_cache.hits += 1;
                    // 회피한 시간을 **모르는 적중은 따로 센다.** 0으로 더하면 "이득이 작다"와
                    // "배선이 끊겼다"가 같은 숫자가 된다.
                    match event.payload.get("savedBuildMs").and_then(Value::as_u64) {
                        Some(ms) => metrics.index_cache.saved_ms_total += ms,
                        None => metrics.index_cache.hits_without_saved_ms += 1,
                    }
                }
                _ => {}
            }
        }

        // ---- 충돌: 감지와 결말을 각각 센다 ----
        let mut proceeded = false;
        for event in &events {
            match event.event_type.as_str() {
                "CRITERIA_CONFLICT_DETECTED" => {
                    let n = event
                        .payload
                        .get("conflicts")
                        .and_then(Value::as_array)
                        .map(|a| a.len() as u64)
                        .unwrap_or(0);
                    metrics.conflicts.detected += n;
                }
                "CRITERIA_CONFLICT_RESOLVED" => {
                    let Some(outcomes) = event.payload.get("outcomes").and_then(Value::as_array) else {
                        continue;
                    };
                    for outcome in outcomes {
                        metrics.conflicts.settled += 1;
                        bump(&mut metrics.conflicts.by_outcome, outcome.get("outcome"));
                        let kind = outcome.get("outcome").and_then(Value::as_str);
                        if kind == Some("proceeded_without_change") {
                            proceeded = true;
                        }
                        // **`plan_unchanged`에만 쪼갠다.** 계획이 바뀐 건에도 붙이면 "해석이
                        // 바뀌었다"가 두 결말에 걸쳐 세어져, 원인을 가르려던 분해가 다시 뭉개진다.
                        if kind == Some("plan_unchanged") {
                            let key = match outcome.get("interpretationTextChanged") {
                                Some(Value::Bool(true)) => "changed",
                                Some(Value::Bool(false)) => "unchanged",
                                _ => "unknown",
                            };
                            *metrics
                                .conflicts
                                .plan_unchanged_by_interpretation
                                .entry(key.to_string())
                                .or_insert(0) += 1;
                        }
                    }
                }
                _ => {}
            }
        }

        // ---- 커밋 크기: GIT_COMMIT_CREATED의 paths 개수 ----
        if let Some(files) = events
            .iter()
            .rev()
            .find(|e| e.event_type == "GIT_COMMIT_CREATED")
            .and_then(|e| e.payload.get("paths").and_then(Value::as_array))
            .map(|paths| paths.len() as u64)
        {
            commit_files.push(files);
        }

        // ---- 카드 답변: 자리별 분포 ----
        collect_card_answers(&events, &mut metrics.card_answers);

        // ---- 취소 소요: CANCELLATION_REQUESTED → 그 뒤 첫 터미널 ----
        collect_cancellation(&events, &mut metrics.cancellation, &mut latencies);

        if proceeded {
            // phase가 아니라 terminal_status를 쓴다 — 진행 중 태스크와 끝난 태스크를 섞지 않는다.
            let status = terminal_status.clone().unwrap_or_else(|| "RUNNING".to_string());
            *metrics
                .conflicts
                .proceeded_task_terminal_status
                .entry(status)
                .or_insert(0) += 1;
        }
    }

    finalize_latency(&mut metrics.cancellation, &mut latencies);

    commit_files.sort_unstable();
    metrics.commit_sizes.commits = commit_files.len() as u64;
    metrics.commit_sizes.p50_files = percentile(&commit_files, 50);
    metrics.commit_sizes.p90_files = percentile(&commit_files, 90);
    metrics.commit_sizes.max_files = commit_files.last().copied();
    metrics.large_change_threshold = Some(suggest_large_change_files(&metrics.commit_sizes));

    token_ratios.sort_unstable();
    // 상한 대비 비율은 **집계가 끝난 뒤** 낸다 — 최댓값이 확정돼야 계산할 수 있다.
    if metrics.ipc_line_sizes.lines > 0 {
        let limit = crate::sidecar::MAX_IPC_LINE_BYTES as u64;
        metrics.ipc_line_sizes.max_percent_of_limit =
            Some((metrics.ipc_line_sizes.max_bytes * 100).div_ceil(limit.max(1)));
    }

    metrics.index_cache.p50_build_ms = percentile(&build_ms, 50);
    metrics.index_cache.p90_build_ms = percentile(&build_ms, 90);
    metrics.index_cache.p90_file_count = percentile(&index_file_counts, 90);

    metrics.token_estimate.p50_ratio_percent = percentile(&token_ratios, 50);
    metrics.token_estimate.p90_ratio_percent = percentile(&token_ratios, 90);
    metrics.token_estimate.max_ratio_percent = token_ratios.last().copied();

    task_cost_micros.sort_unstable();
    metrics.task_costs.tasks = task_cost_micros.len() as u64;
    metrics.task_costs.p50_usd = percentile(&task_cost_micros, 50).map(micros_to_usd);
    metrics.task_costs.p90_usd = percentile(&task_cost_micros, 90).map(micros_to_usd);
    metrics.task_costs.max_usd = task_cost_micros.last().copied().map(micros_to_usd);
    metrics.task_budget_threshold = Some(suggest_task_budget_usd(&metrics.task_costs));

    headroom_ratios.sort_unstable();
    metrics.budget_headroom.p50_reserved_over_actual_percent = percentile(&headroom_ratios, 50);
    metrics.budget_headroom.p90_reserved_over_actual_percent = percentile(&headroom_ratios, 90);
    metrics.budget_headroom.max_reserved_over_actual_percent = headroom_ratios.last().copied();

    metrics.force_abandon_threshold = Some(suggest_force_abandon_ms(&metrics.cancellation));

    // 정면 비교의 판정은 **집계가 끝난 뒤** 한 번에 낸다. 태스크마다 갱신하면 중간 상태의
    // 판정이 로그에 남고, 그 값은 최종 판정과 구별되지 않는다.
    for entry in metrics.model_evaluation.head_to_head.values_mut() {
        entry.p_value = sign_test_p_value(entry.wins[0], entry.wins[1]);
        entry.verdict = evaluation_verdict(&entry.models, entry.wins);
    }

    // **마지막에 만든다.** 위에서 센 값을 읽을 뿐이므로 순서가 뒤집히면 전부 0을 본다.
    metrics.open_questions = open_questions(&metrics);
    Ok(metrics)
}

/// `USER_DECISION_RECORDED`에서 카드 자리별 답을 센다.
///
/// 3.4절 확인 필요 카드(모델이 스스로 모호하다고 말한 경우)에는 쟁점도 자리도 없다.
/// 그건 **다른 화면**이므로 이 집계에 섞지 않는다 — 섞으면 자리 없는 답이 전부 `unknown`으로
/// 쌓여 분모를 부풀린다.
fn collect_card_answers(events: &[crate::store::StoredEvent], out: &mut CardAnswers) {
    for event in events {
        if event.event_type != "USER_DECISION_RECORDED" {
            continue;
        }
        let Some(decisions) = event.payload.get("decisions").and_then(Value::as_array) else {
            continue;
        };
        if decisions.is_empty() {
            continue;
        }
        // 카드 크기는 payload가 말한다. 결정 개수로 추론하지 않는 이유: 답이 오지 않은 항목이
        // 있으면 둘이 달라지고, 그때 필요한 것은 **띄운 개수**다.
        let size = event
            .payload
            .get("cardSize")
            .and_then(Value::as_u64)
            .unwrap_or(decisions.len() as u64);
        *out.cards_by_size.entry(size).or_insert(0) += 1;

        for decision in decisions {
            let Some(position) = decision.get("cardPosition").and_then(Value::as_u64) else {
                continue;
            };
            let freeform = decision.get("freeform").and_then(Value::as_bool) == Some(true);
            let rank = decision.get("optionRank").and_then(Value::as_u64);

            let slot = out.by_position.entry(position).or_default();
            if freeform {
                slot.freeform += 1;
            } else {
                match rank {
                    Some(1) => slot.first_option += 1,
                    Some(_) => slot.later_option += 1,
                    None => slot.unknown += 1,
                }
            }

            // 답 하나를 어느 칸에 더할지는 같은 규칙이다. 두 번 적으면 한쪽만 고쳐질 수 있다.
            let tally = |slot: &mut FieldAnswers| {
                if freeform {
                    slot.freeform += 1;
                } else {
                    match rank {
                        Some(1) => slot.picked_primary += 1,
                        Some(_) => slot.picked_other += 1,
                        None => slot.unknown += 1,
                    }
                }
            };

            // 필드는 payload가 말한다. **id에서 파싱하지 않는다** — id 형식을 바꾸는 순간
            // 집계가 조용히 끊기고, 끊긴 것은 0으로 보인다.
            if let Some(field) = decision.get("field").and_then(Value::as_str) {
                tally(out.by_field.entry(field.to_string()).or_default());
                // 결합 분포. 주변 분포 둘로는 교락을 풀 수 없다.
                tally(
                    out.by_field_and_position
                        .entry(field.to_string())
                        .or_default()
                        .entry(position)
                        .or_default(),
                );
            }

            // 규칙이 막을 만하다고 봤는가. **없으면 `unknown`이고 어느 쪽에도 합치지 않는다** —
            // 이 축이 붙기 전 기록을 blocking으로 세면 그 칸이 과거 데이터로 희석된다.
            let bucket = match decision.get("blocking").and_then(Value::as_bool) {
                Some(true) => "blocking",
                Some(false) => "non_blocking",
                None => "unknown",
            };
            tally(out.by_blocking.entry(bucket.to_string()).or_default());
        }
    }
}

/// 한 태스크의 이벤트에서 취소 소요를 뽑는다.
///
/// 한 태스크에 `CANCELLATION_REQUESTED`가 여러 번 있을 수 있다(사용자가 취소를 두 번 눌러도
/// `already_requested`로 흡수되지만, 이벤트 자체는 남는 경로가 있다). **첫 번째만** 쓴다 —
/// 두 번째 요청은 이미 진행 중인 취소에 대한 것이라 그 간격은 취소가 걸린 시간이 아니다.
fn collect_cancellation(events: &[crate::store::StoredEvent], out: &mut CancellationLatency, samples: &mut Vec<u64>) {
    let Some(requested_at) = events
        .iter()
        .find(|e| e.event_type == "CANCELLATION_REQUESTED")
        .map(|e| e.created_at.as_str())
    else {
        return;
    };

    // 요청 **뒤에** 온 터미널만 본다. 앞에 있는 것은 다른 사건이다.
    let requested_index = events
        .iter()
        .position(|e| e.event_type == "CANCELLATION_REQUESTED")
        .unwrap_or(0);
    let Some(terminal) = events[requested_index..]
        .iter()
        .find(|e| e.event_type.starts_with("TASK_") && e.event_type != "TASK_CREATED")
    else {
        out.unresolved += 1;
        return;
    };

    if terminal.payload.get("forceAbandoned").and_then(Value::as_bool) == Some(true) {
        out.force_abandoned += 1;
        return;
    }

    match (parse_ms(requested_at), parse_ms(&terminal.created_at)) {
        (Some(a), Some(b)) => {
            out.settled += 1;
            // 음수는 시계가 뒤로 간 경우다. 0으로 눕히되 표본에서 빼지는 않는다 —
            // 빼면 "빠른 취소"가 통째로 사라져 분포가 느린 쪽으로 치우친다.
            samples.push((b - a).max(0) as u64);
        }
        _ => out.unparsed_timestamps += 1,
    }
}

fn parse_ms(text: &str) -> Option<i64> {
    time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn finalize_latency(out: &mut CancellationLatency, samples: &mut Vec<u64>) {
    if samples.is_empty() {
        return;
    }
    samples.sort_unstable();
    out.p50_ms = percentile(samples, 50);
    out.p90_ms = percentile(samples, 90);
    out.p95_ms = percentile(samples, 95);
    out.max_ms = samples.last().copied();
}

/// 최근접 순위 백분위. 보간하지 않는 이유: 표본이 수십 개 수준이라 보간이 만들어내는 값은
/// 관측된 적 없는 숫자이고, 여기서 필요한 것은 "실제로 이만큼 걸린 적이 있다"는 사실이다.
fn percentile(sorted: &[u64], p: u64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len() as u64;
    let rank = (p * n).div_ceil(100).max(1);
    sorted.get((rank - 1) as usize).copied()
}

/// 문자열 값 하나를 집계 맵에 더한다. 값이 없거나 문자열이 아니면 `unknown`으로 센다 —
/// 조용히 빼면 합계가 맞지 않는데 왜 안 맞는지 알 수 없다.
fn bump(map: &mut BTreeMap<String, u64>, value: Option<&Value>) {
    let key = value.and_then(Value::as_str).unwrap_or("unknown").to_string();
    *map.entry(key).or_insert(0) += 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::ArtifactStore;
    use serde_json::json;

    fn seeded() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();
        let mut store = Store::open_in_memory(artifacts).unwrap();
        store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        (dir, store)
    }

    fn evaluated(items: Vec<(&str, &str)>) -> Value {
        json!({
            "evaluations": items
                .into_iter()
                .enumerate()
                .map(|(i, (status, code))| json!({
                    "criterionId": format!("c-{i}"), "status": status, "code": code, "reason": "",
                }))
                .collect::<Vec<_>>(),
        })
    }

    /// 여러 태스크에 공급자 호출 비용을 심는다.
    fn seed_task_with_cost(store: &mut Store, task_id: &str, costs: &[Option<f64>]) {
        store
            .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        for (i, cost) in costs.iter().enumerate() {
            store
                .record_provider_usage(&json!({
                    "taskId": task_id,
                    "callId": format!("{task_id}-c{i}"),
                    "role": "executor",
                    "providerId": "p",
                    "modelId": "m",
                    "usage": { "inputTokens": 100, "outputTokens": 10 },
                    "costUsd": cost,
                    "latencyMs": 1,
                    "attempt": 1,
                    "createdAt": "2026-01-01T00:00:00Z",
                }))
                .unwrap();
        }
    }

    /// 대조 태스크 하나를 심는다. `picks`는 (쟁점 번호, 고른 초안 번호 또는 None=자유 입력).
    ///
    /// **이벤트를 직접 쓴다.** 세 이벤트를 잇는 것이 이 집계의 전부이므로, 그 세 이벤트가
    /// 실제로 저장된 모양대로 있어야 검사가 의미를 갖는다.
    fn seed_contrast_task(
        store: &mut Store,
        task_id: &str,
        models: (&str, &str),
        picks: &[Option<usize>],
    ) {
        store
            .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        for (i, model) in [models.0, models.1].iter().enumerate() {
            store
                .append_event(
                    task_id,
                    "DRAFT_RECEIVED",
                    &json!({ "proposalId": format!("p{i}"), "model": model }),
                )
                .unwrap();
        }
        let disagreements: Vec<Value> = picks
            .iter()
            .enumerate()
            .map(|(q, _)| {
                json!({
                    "disagreementId": format!("d{q}"),
                    "field": "doneCriteria",
                    "question": { "options": [
                        { "optionId": format!("d{q}-o0"), "fromProposalId": "p0" },
                        { "optionId": format!("d{q}-o1"), "fromProposalId": "p1" },
                    ]},
                })
            })
            .collect();
        store
            .append_event(
                task_id,
                "DISAGREEMENT_DETECTED",
                &json!({ "contrasted": true, "disagreements": disagreements }),
            )
            .unwrap();
        let decisions: Vec<Value> = picks
            .iter()
            .enumerate()
            .map(|(q, pick)| match pick {
                Some(which) => json!({
                    "disagreementId": format!("d{q}"),
                    "optionId": format!("d{q}-o{which}"),
                    "freeform": false,
                }),
                None => json!({
                    "disagreementId": format!("d{q}"),
                    "optionId": Value::Null,
                    "freeform": true,
                }),
            })
            .collect();
        store
            .append_event(task_id, "USER_DECISION_RECORDED", &json!({ "decisions": decisions }))
            .unwrap();
    }

    fn seed_token_estimate(store: &Store, task_id: &str, call: &str, estimated: Option<i64>, actual: i64) {
        let mut usage = json!({
            "taskId": task_id,
            "callId": call,
            "role": "executor",
            "providerId": "p",
            "modelId": "m",
            "usage": { "inputTokens": actual, "outputTokens": 10 },
            "costUsd": 0.01,
            "latencyMs": 1,
            "attempt": 1,
            "createdAt": "2026-01-01T00:00:00Z",
        });
        if let Some(e) = estimated {
            usage["estimatedInputTokens"] = json!(e);
        }
        store.record_provider_usage(&usage).unwrap();
    }

    /// **추정이 상한이었는지를 이 숫자가 말한다.** 실제가 추정을 넘은 호출이 하나라도 있으면
    /// 그 추정은 상한이 아니고, 그건 예약보다 많이 썼다는 뜻이다.
    #[test]
    fn counts_the_calls_where_the_actual_exceeded_our_estimate() {
        let (_d, store) = seeded();
        seed_token_estimate(&store, "task-1", "c1", Some(1_000), 500); // 과대 추정 — 안전한 방향
        seed_token_estimate(&store, "task-1", "c2", Some(1_000), 1_000); // 정확
        seed_token_estimate(&store, "task-1", "c3", Some(1_000), 2_000); // 과소 추정 — 위험한 방향

        let m = collect(&store, None).unwrap();
        assert_eq!(m.token_estimate.calls, 3);
        assert_eq!(m.token_estimate.calls_where_actual_exceeded_estimate, 1);
        assert_eq!(m.token_estimate.max_ratio_percent, Some(200));
        assert_eq!(m.token_estimate.p50_ratio_percent, Some(100));
    }

    /// **추정이 없는 호출을 비율 1로 세지 않는다.** 없는 쪽을 채우면 "추정이 맞았다"는 결론이
    /// 데이터 없이 나오고, 배선이 끊긴 것과 표본이 적은 것을 구별할 수 없게 된다.
    #[test]
    fn calls_without_an_estimate_are_counted_separately_not_as_agreement() {
        let (_d, store) = seeded();
        seed_token_estimate(&store, "task-1", "c1", None, 500);
        seed_token_estimate(&store, "task-1", "c2", Some(0), 500);
        seed_token_estimate(&store, "task-1", "c3", Some(400), 500);

        let m = collect(&store, None).unwrap();
        assert_eq!(m.token_estimate.calls, 1, "비교 가능한 호출만 센다");
        assert_eq!(m.token_estimate.calls_without_estimate, 2, "0과 NULL 둘 다 비교 불가다");
        assert_eq!(m.token_estimate.calls_where_actual_exceeded_estimate, 1);
    }

    /// 기록이 없으면 백분위는 `None`이다. 0으로 채우면 "추정이 0배로 정확했다"로 읽힌다.
    #[test]
    fn no_token_records_yield_no_percentiles() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.token_estimate.calls, 0);
        assert_eq!(m.token_estimate.p90_ratio_percent, None);
    }

    /// **비용을 모르는 호출이 있는 태스크는 분포에서 빠진다.**
    ///
    /// 그 태스크의 합계는 하한이고, 하한을 분포에 넣으면 유도된 상한이 실제보다 낮아진다 —
    /// 낮은 상한은 정상 태스크를 거부하는데, 그 원인이 데이터 결함이라는 사실은 어디에도
    /// 남지 않는다. 그래서 빼되 **뺐다는 사실을 센다.**
    #[test]
    fn a_task_with_unpriced_calls_is_excluded_but_counted() {
        let (_d, mut store) = seeded();
        seed_task_with_cost(&mut store, "task-priced", &[Some(0.10), Some(0.20)]);
        seed_task_with_cost(&mut store, "task-unpriced", &[Some(0.10), None]);

        let m = collect(&store, None).unwrap();
        assert_eq!(m.task_costs.tasks, 1, "가격을 모르는 태스크가 분포에 들어갔습니다");
        assert_eq!(m.task_costs.tasks_with_unpriced_calls, 1);
        assert_eq!(m.task_costs.max_usd, Some(0.30));
    }

    /// 호출이 아예 없었던 태스크(스냅샷 전에 끝난 것 등)는 "0달러를 쓴 태스크"가 아니다.
    /// 분포에 넣으면 유도값이 0쪽으로 끌려 내려간다.
    #[test]
    fn a_task_with_no_provider_calls_is_not_a_zero_dollar_sample() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.task_costs.tasks, 0);
        assert_eq!(m.task_costs.p90_usd, None);
    }

    /// 표본이 부족하면 관측값을 쓰지 않고 **기본값과 그 사실**을 함께 돌려준다.
    #[test]
    fn an_insufficient_sample_yields_the_default_and_says_so() {
        let costs = TaskCosts {
            tasks: 3,
            p90_usd: Some(0.5),
            ..TaskCosts::default()
        };
        let t = suggest_task_budget_usd(&costs);
        assert_eq!(t.usd, DEFAULT_TASK_BUDGET_USD);
        assert_eq!(t.source, "default_insufficient_samples");
        assert_eq!(t.sample_count, 3);
    }

    /// 표본이 충분하면 p90에 여유를 곱한다. **여유 배수를 값에 녹이지 않고 함께 돌려주는**
    /// 이유: 그러지 않으면 화면이 이 숫자를 관측된 지출로 말하게 된다.
    #[test]
    fn a_sufficient_sample_yields_a_measured_suggestion_with_its_headroom() {
        let costs = TaskCosts {
            tasks: MIN_TASK_COST_SAMPLES,
            p90_usd: Some(2.0),
            ..TaskCosts::default()
        };
        let t = suggest_task_budget_usd(&costs);
        assert_eq!(t.source, "measured");
        assert_eq!(t.headroom_multiplier, TASK_BUDGET_HEADROOM);
        assert_eq!(t.usd, 6.0);
    }

    /// **하한이 없으면 유도된 상한이 첫 호출조차 못 덮는다.** 가장 비싼 등록 모델의 한 호출
    /// 최대 비용이 약 $2이므로, 값싼 태스크만 쌓인 워크스페이스에서 제안이 그 아래로 내려가면
    /// 사용자는 아무것도 돌릴 수 없게 된다.
    #[test]
    fn a_cheap_history_does_not_suggest_a_limit_that_blocks_everything() {
        let costs = TaskCosts {
            tasks: MIN_TASK_COST_SAMPLES,
            p90_usd: Some(0.0001),
            ..TaskCosts::default()
        };
        assert_eq!(suggest_task_budget_usd(&costs).usd, MIN_TASK_BUDGET_USD);
    }

    /// 반대쪽: 이상치 하나가 제안을 끌어올리면 상한이 사실상 사라진다.
    #[test]
    fn an_outlier_cannot_remove_the_limit() {
        let costs = TaskCosts {
            tasks: MIN_TASK_COST_SAMPLES,
            p90_usd: Some(10_000.0),
            ..TaskCosts::default()
        };
        assert_eq!(suggest_task_budget_usd(&costs).usd, MAX_TASK_BUDGET_USD);
    }

    #[test]
    fn counts_only_the_last_evaluation_per_task() {
        // fix loop를 돌면 같은 태스크에서 여러 번 나온다. 전부 세면 재시도가 많은 태스크가
        // 집계를 좌우하고, "기준 하나가 어떻게 끝났는가"라는 질문의 답이 아니게 된다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "CRITERIA_EVALUATED",
                &evaluated(vec![("UNVERIFIED", "no_test_reference")]),
            )
            .unwrap();
        store
            .append_event(
                "task-1",
                "CRITERIA_EVALUATED",
                &evaluated(vec![("VERIFIED_BY_TEST", "verified_named_test_ran")]),
            )
            .unwrap();

        let metrics = collect(&store, None).unwrap();
        assert_eq!(metrics.coverage.criteria, 1);
        assert_eq!(metrics.coverage.by_status.get("VERIFIED_BY_TEST"), Some(&1));
        assert_eq!(metrics.coverage.by_code.get("no_test_reference"), None);
        assert_eq!(metrics.coverage.tasks_with_criteria, 1);
    }

    #[test]
    fn separates_unverified_reasons() {
        // 커버리지가 왜 낮은지는 코드별로만 보인다 — "이름이 없었다"와 "실행 근거가 없었다"는
        // 고쳐야 할 곳이 서로 다르다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "CRITERIA_EVALUATED",
                &evaluated(vec![
                    ("UNVERIFIED", "no_test_reference"),
                    ("UNVERIFIED", "no_run_evidence"),
                    ("VERIFIED_BY_TEST", "verified_named_test_ran"),
                ]),
            )
            .unwrap();

        let metrics = collect(&store, None).unwrap();
        assert_eq!(metrics.coverage.by_status.get("UNVERIFIED"), Some(&2));
        assert_eq!(metrics.coverage.by_code.get("no_test_reference"), Some(&1));
        assert_eq!(metrics.coverage.by_code.get("no_run_evidence"), Some(&1));
    }

    #[test]
    fn detected_and_settled_are_counted_separately() {
        // 두 수가 다르면 결말이 새고 있다는 뜻이다. 같은 수로 강제하면 그 사실이 숨는다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "CRITERIA_CONFLICT_DETECTED",
                &json!({ "conflicts": [{ "criterionId": "c-0" }, { "criterionId": "c-1" }] }),
            )
            .unwrap();
        store
            .append_event(
                "task-1",
                "CRITERIA_CONFLICT_RESOLVED",
                &json!({ "outcomes": [{ "criterionId": "c-0", "outcome": "plan_changed_to_expected" }] }),
            )
            .unwrap();

        let metrics = collect(&store, None).unwrap();
        assert_eq!(metrics.conflicts.detected, 2);
        assert_eq!(metrics.conflicts.settled, 1);
        assert_eq!(metrics.conflicts.by_outcome.get("plan_changed_to_expected"), Some(&1));
    }

    #[test]
    fn records_how_overridden_conflicts_ended() {
        // 통과했다고 충돌이 오탐이었다는 뜻은 아니다 — 약한 정황일 뿐이라 이름도 그렇게 뒀다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "CRITERIA_CONFLICT_RESOLVED",
                &json!({ "outcomes": [{ "criterionId": "c-0", "outcome": "proceeded_without_change" }] }),
            )
            .unwrap();
        store
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, &json!({}))
            .unwrap();

        let metrics = collect(&store, None).unwrap();
        assert_eq!(
            metrics.conflicts.proceeded_task_terminal_status.get("COMPLETED"),
            Some(&1)
        );
    }

    /// **`plan_unchanged`의 두 원인을 가른다.** 비율만으로는 고칠 곳이 게이트인지 프롬프트인지
    /// 알 수 없고, 그 구분이 없으면 이 지표는 "낮다/높다" 말고 아무것도 말하지 못한다.
    #[test]
    fn splits_plan_unchanged_by_whether_the_interpretation_text_moved() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "CRITERIA_CONFLICT_RESOLVED",
                &json!({ "outcomes": [
                    { "criterionId": "c-1", "outcome": "plan_unchanged", "interpretationTextChanged": false },
                    { "criterionId": "c-2", "outcome": "plan_unchanged", "interpretationTextChanged": true },
                    // 비교할 새 초안이 없었던 경우. **0으로 뭉개지 않는다.**
                    { "criterionId": "c-3", "outcome": "plan_unchanged", "interpretationTextChanged": null },
                    // 계획이 바뀐 건은 이 분해에 들어가지 않는다 — 들어가면 분해가 다시 뭉개진다.
                    { "criterionId": "c-4", "outcome": "plan_changed_to_expected", "interpretationTextChanged": true },
                ] }),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert_eq!(m.conflicts.settled, 4);
        let split = &m.conflicts.plan_unchanged_by_interpretation;
        assert_eq!(split.get("unchanged"), Some(&1), "{split:?}");
        assert_eq!(split.get("changed"), Some(&1), "{split:?}");
        assert_eq!(split.get("unknown"), Some(&1), "{split:?}");
        // 분해의 합은 plan_unchanged 개수와 같아야 한다 — 어긋나면 어느 쪽이 맞는지 알 수 없다.
        assert_eq!(
            split.values().sum::<u64>(),
            *m.conflicts.by_outcome.get("plan_unchanged").unwrap()
        );
    }

    /// 카드 답변은 **자리별로** 쌓여야 "아래쪽 질문이 대충 눌리는가"를 물을 수 있다.
    /// 자리를 잃으면 남는 것은 "첫 선택지를 몇 번 골랐나"뿐이고, 그 수는 상한 4에 대해
    /// 아무것도 말하지 않는다.
    #[test]
    fn card_answers_are_counted_per_position() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({
                    "cardSize": 3,
                    "decisions": [
                        { "disagreementId": "d1", "cardPosition": 1, "optionRank": 2, "freeform": false },
                        { "disagreementId": "d2", "cardPosition": 2, "optionRank": 1, "freeform": false },
                        { "disagreementId": "d3", "cardPosition": 3, "optionRank": null, "freeform": true },
                    ],
                }),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert_eq!(m.card_answers.cards_by_size.get(&3), Some(&1));
        assert_eq!(m.card_answers.by_position.get(&1).map(|p| p.later_option), Some(1));
        assert_eq!(m.card_answers.by_position.get(&2).map(|p| p.first_option), Some(1));
        assert_eq!(m.card_answers.by_position.get(&3).map(|p| p.freeform), Some(1));
    }

    /// **자리와 필드는 다른 축이다.** 한 축으로 합치면 비율을 움직인 것이 화면의 위치인지
    /// 물어본 내용인지 알 수 없다 — 그런데 랭킹(17.4절)이 튜닝해야 하는 것은 후자다.
    #[test]
    fn card_answers_are_also_counted_per_field() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({
                    "cardSize": 3,
                    "decisions": [
                        // primary(선택지 1번)를 그대로 골랐다 — 물어서 달라진 것이 없다.
                        { "disagreementId": "d1", "field": "doneCriteria", "cardPosition": 1, "optionRank": 1, "freeform": false },
                        // 다른 초안을 골랐다 — 물어서 실제로 달라졌다.
                        { "disagreementId": "d2", "field": "targetPaths", "cardPosition": 2, "optionRank": 2, "freeform": false },
                        // 둘 다 틀렸다 — 가장 강한 신호.
                        { "disagreementId": "d3", "field": "targetPaths", "cardPosition": 3, "optionRank": null, "freeform": true },
                    ],
                }),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        let by_field = &m.card_answers.by_field;
        assert_eq!(
            by_field.get("doneCriteria").map(|f| f.picked_primary),
            Some(1),
            "{by_field:?}"
        );
        assert_eq!(
            by_field.get("targetPaths").map(|f| f.picked_other),
            Some(1),
            "{by_field:?}"
        );
        assert_eq!(by_field.get("targetPaths").map(|f| f.freeform), Some(1), "{by_field:?}");
        // 필드별 합계는 자리별 합계와 같아야 한다 — 어긋나면 한쪽이 답을 흘리고 있다.
        let by_field_total: u64 = by_field
            .values()
            .map(|f| f.picked_primary + f.picked_other + f.freeform + f.unknown)
            .sum();
        let by_position_total: u64 = m
            .card_answers
            .by_position
            .values()
            .map(|p| p.first_option + p.later_option + p.freeform + p.unknown)
            .sum();
        assert_eq!(by_field_total, by_position_total);
    }

    /// 필드가 없는 기록은 필드 집계에 **들어가지 않는다.** 억지로 "unknown" 필드로 넣으면
    /// 필드별 비율의 분모가 실제로 물어본 쟁점 수와 달라진다.
    #[test]
    fn decisions_without_a_field_do_not_create_an_unknown_field_bucket() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({
                    "cardSize": 1,
                    "decisions": [{ "disagreementId": "d1", "cardPosition": 1, "optionRank": 1, "freeform": false }],
                }),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert!(m.card_answers.by_field.is_empty(), "{:?}", m.card_answers.by_field);
        // 자리별로는 세어진다 — 자리는 payload에 있었다.
        assert_eq!(m.card_answers.by_position.get(&1).map(|p| p.first_option), Some(1));
    }

    /// 3.4절 확인 필요 카드는 **다른 화면**이라 자리가 없다. 섞으면 자리 없는 답이 전부
    /// unknown으로 쌓여 자리별 비율의 분모가 부풀려진다.
    #[test]
    fn clarification_answers_without_positions_do_not_enter_the_card_aggregate() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({ "decisions": [], "answer": "빈 문자열은 거부한다" }),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert!(m.card_answers.by_position.is_empty(), "{:?}", m.card_answers);
        assert!(m.card_answers.cards_by_size.is_empty(), "{:?}", m.card_answers);
    }

    fn commit_of(store: &mut Store, task_id: &str, files: usize) {
        let paths: Vec<String> = (0..files).map(|i| format!("src/f{i}.ts")).collect();
        store
            .append_event(task_id, "GIT_COMMIT_CREATED", &json!({ "sha": "abc", "paths": paths }))
            .unwrap();
    }

    /// 커밋하지 않은 태스크는 **"커밋이 크다"라는 질문의 대상이 아니다.** 넣으면 분포가
    /// 작은 쪽으로 휘어 문턱이 낮아지고, 안내가 아무 때나 뜬다.
    #[test]
    fn only_committed_tasks_enter_the_commit_size_distribution() {
        let (_d, mut store) = seeded();
        commit_of(&mut store, "task-1", 5);
        store
            .create_task("task-2", "sess-1", "ws-1", "/tmp/ws", "fast", "fix")
            .unwrap();
        // task-2는 커밋하지 않았다.

        let m = collect(&store, None).unwrap();
        assert_eq!(m.tasks_scanned, 2);
        assert_eq!(m.commit_sizes.commits, 1);
        assert_eq!(m.commit_sizes.max_files, Some(5));
    }

    /// 표본이 부족하면 관측값을 쓰지 않고, **그 사실을 source로 말한다.**
    #[test]
    fn large_change_threshold_falls_back_to_the_default_until_there_are_enough_commits() {
        let (_d, mut store) = seeded();
        commit_of(&mut store, "task-1", 30);

        let t = collect(&store, None).unwrap().large_change_threshold.unwrap();
        assert_eq!(t.files, DEFAULT_LARGE_CHANGE_FILES);
        assert_eq!(t.source, "default_insufficient_samples");
        assert_eq!(t.sample_count, 1);
    }

    /// 표본이 쌓이면 p90에서 유도한다. **max가 아닌 이유**: "큰 편인가"는 "비정상인가"와 다른
    /// 질문이고, max를 쓰면 지금까지 가장 컸던 작업보다 커야만 떠서 사실상 뜨지 않는다.
    #[test]
    fn large_change_threshold_comes_from_the_ninetieth_percentile() {
        let (_d, mut store) = seeded();
        let mut add = |store: &mut Store, index: usize, files: usize| {
            let id = format!("t{index}");
            store
                .create_task(&id, "sess-1", "ws-1", "/tmp/ws", "fast", "fix")
                .unwrap();
            commit_of(store, &id, files);
        };
        for i in 0..8 {
            add(&mut store, i, 4);
        }
        // **이상치 하나는 p90을 움직이지 못한다.** max를 쓰지 않는 이유가 이것이다 —
        // 한 번의 큰 작업이 앞으로의 모든 안내를 꺼버리면 안 된다.
        add(&mut store, 8, 20);
        add(&mut store, 9, 4);

        let m = collect(&store, None).unwrap();
        assert_eq!(m.commit_sizes.commits, 10);
        assert_eq!(m.commit_sizes.p50_files, Some(4));
        assert_eq!(m.commit_sizes.max_files, Some(20));
        assert_eq!(
            m.large_change_threshold.as_ref().unwrap().files,
            4,
            "이상치 하나가 문턱을 끌어올렸습니다"
        );

        // 큰 작업이 둘이 되면(10건 중 2건) 그때는 p90이 따라 올라간다 — 드물지 않은 크기라는 뜻이다.
        add(&mut store, 10, 20);
        add(&mut store, 11, 4);
        let m = collect(&store, None).unwrap();
        assert_eq!(m.commit_sizes.commits, 12);
        let t = m.large_change_threshold.unwrap();
        assert_eq!(t.source, "measured");
        assert_eq!(t.files, 20);
    }

    /// 이상치 하나로 문턱이 사실상 사라지지 않는다. 안내가 없는 것과 언제나 있는 것은
    /// 사용자에게 같은 것이다.
    #[test]
    fn large_change_threshold_is_clamped_at_both_ends() {
        let huge = CommitSizes {
            commits: 20,
            p90_files: Some(5_000),
            ..CommitSizes::default()
        };
        assert_eq!(suggest_large_change_files(&huge).files, MAX_LARGE_CHANGE_FILES);

        let tiny = CommitSizes {
            commits: 20,
            p90_files: Some(1),
            ..CommitSizes::default()
        };
        assert_eq!(suggest_large_change_files(&tiny).files, MIN_LARGE_CHANGE_FILES);
    }

    #[test]
    fn missing_fields_are_counted_as_unknown_not_dropped() {
        // 조용히 빼면 합계가 맞지 않는데 왜 안 맞는지 알 수 없다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "CRITERIA_EVALUATED",
                &json!({ "evaluations": [{ "criterionId": "c-0" }] }),
            )
            .unwrap();

        let metrics = collect(&store, None).unwrap();
        assert_eq!(metrics.coverage.criteria, 1);
        assert_eq!(metrics.coverage.by_status.get("unknown"), Some(&1));
        assert_eq!(metrics.coverage.by_code.get("unknown"), Some(&1));
    }

    /// `CANCELLATION_REQUESTED` → 터미널 쌍 하나를 만든다. 밀리초 오프셋으로 시각을 준다.
    fn cancel_pair(offset_ms: i64, terminal_payload: Value) -> Vec<crate::store::StoredEvent> {
        let base = time::OffsetDateTime::UNIX_EPOCH + time::Duration::days(20_000);
        let at = |ms: i64| {
            (base + time::Duration::milliseconds(ms))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        let ev = |seq: i64, ty: &str, created_at: String, payload: Value| crate::store::StoredEvent {
            event_id: seq,
            seq,
            event_type: ty.to_string(),
            payload,
            created_at,
            phase: None,
        };
        vec![
            ev(1, "CANCELLATION_REQUESTED", at(0), json!({})),
            ev(2, "TASK_CANCELLED", at(offset_ms), terminal_payload),
        ]
    }

    fn latency_of(pairs: Vec<Vec<crate::store::StoredEvent>>) -> CancellationLatency {
        let mut out = CancellationLatency::default();
        let mut samples = Vec::new();
        for events in &pairs {
            collect_cancellation(events, &mut out, &mut samples);
        }
        finalize_latency(&mut out, &mut samples);
        out
    }

    /// **강제 포기한 취소는 분포에 들어가면 안 된다.**
    ///
    /// 그 간격은 "취소가 얼마나 걸렸는가"가 아니라 "임계값 + 사용자의 반응 시간"이다. 넣으면
    /// 임계값이 자기 자신을 근거로 매번 커지고, 탈출구를 쓸수록 탈출구가 늦게 뜨게 된다.
    #[test]
    fn force_abandoned_cancellations_do_not_feed_back_into_the_threshold() {
        let mut pairs: Vec<Vec<crate::store::StoredEvent>> = (0..10).map(|_| cancel_pair(500, json!({}))).collect();
        // 강제 포기는 임계값(5초) 언저리에서 일어난다 — 넣으면 max가 500 → 6000이 된다.
        for _ in 0..5 {
            pairs.push(cancel_pair(6_000, json!({ "forceAbandoned": true })));
        }

        let latency = latency_of(pairs);
        assert_eq!(latency.settled, 10);
        assert_eq!(latency.force_abandoned, 5);
        assert_eq!(latency.max_ms, Some(500), "강제 포기가 분포에 섞였습니다");

        let threshold = suggest_force_abandon_ms(&latency);
        assert_eq!(threshold.source, "measured");
        // 500 * 1.5 = 750이지만 하한이 3초다 — 그 안은 정상 취소가 아직 진행 중인 구간이다.
        assert_eq!(threshold.ms, MIN_FORCE_ABANDON_MS);
    }

    /// 끝나지 않은 취소는 **유한한 소요 시간이 없다.** 분포에 넣을 수 없지만 조용히 빼면
    /// 안 된다 — 이것이 탈출구가 존재하는 이유 그 자체라, 안 보이면 분포가 실제보다 건강해 보인다.
    #[test]
    fn unresolved_cancellations_are_counted_not_dropped() {
        let base = time::OffsetDateTime::UNIX_EPOCH + time::Duration::days(20_000);
        let stuck = vec![crate::store::StoredEvent {
            event_id: 1,
            seq: 1,
            event_type: "CANCELLATION_REQUESTED".to_string(),
            payload: json!({}),
            created_at: base.format(&time::format_description::well_known::Rfc3339).unwrap(),
            phase: None,
        }];
        let latency = latency_of(vec![stuck, cancel_pair(400, json!({}))]);
        assert_eq!(latency.unresolved, 1);
        assert_eq!(latency.settled, 1);
    }

    /// 표본이 적으면 **측정값을 쓰지 않는다.** 한 번의 실행이 앞으로의 모든 취소를 지배하면
    /// 그건 측정이 아니라 우연이다. 그리고 그 사실을 `source`로 함께 말한다 — 숫자만 넘기면
    /// 읽는 쪽이 기본값을 측정값으로 읽는다.
    #[test]
    fn threshold_falls_back_to_the_default_until_there_are_enough_samples() {
        let latency = latency_of(
            (0..(MIN_LATENCY_SAMPLES - 1))
                .map(|_| cancel_pair(9_000, json!({})))
                .collect(),
        );
        let threshold = suggest_force_abandon_ms(&latency);
        assert_eq!(threshold.ms, DEFAULT_FORCE_ABANDON_MS);
        assert_eq!(threshold.source, "default_insufficient_samples");
        assert_eq!(threshold.sample_count, MIN_LATENCY_SAMPLES - 1);
    }

    /// 이상치 하나가 max를 끌어올려도 탈출구가 사라지지는 않는다.
    #[test]
    fn threshold_is_capped_so_the_escape_hatch_never_disappears() {
        let mut pairs: Vec<Vec<crate::store::StoredEvent>> = (0..10).map(|_| cancel_pair(400, json!({}))).collect();
        pairs.push(cancel_pair(600_000, json!({})));
        let latency = latency_of(pairs);
        assert_eq!(latency.max_ms, Some(600_000));
        assert_eq!(suggest_force_abandon_ms(&latency).ms, MAX_FORCE_ABANDON_MS);
    }

    /// 백분위는 관측된 값 중에서 고른다 — 보간하면 실제로 걸린 적 없는 숫자가 나온다.
    #[test]
    fn percentile_picks_an_observed_value() {
        let sorted: Vec<u64> = (1..=10).map(|n| n * 100).collect();
        assert_eq!(percentile(&sorted, 50), Some(500));
        assert_eq!(percentile(&sorted, 90), Some(900));
        assert_eq!(percentile(&sorted, 95), Some(1000));
        assert_eq!(percentile(&[], 50), None);
    }

    /// 실제 저장소를 한 번 지나 배선을 확인한다. 단위 테스트가 직접 만든 이벤트만 세면
    /// `collect`가 이 집계를 부르지 않게 되어도 아무도 모른다.
    #[test]
    fn collect_wires_cancellation_latency_through_the_store() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "CANCELLATION_REQUESTED", &json!({}))
            .unwrap();
        store
            .finish_task("task-1", "CANCELLED", "TASK_CANCELLED", None, &json!({}))
            .unwrap();

        let metrics = collect(&store, None).unwrap();
        assert_eq!(metrics.cancellation.settled, 1);
        assert_eq!(metrics.cancellation.unparsed_timestamps, 0);
        assert!(metrics.cancellation.p50_ms.is_some());
        // 표본 하나로는 임계값을 정하지 않는다.
        let threshold = metrics.force_abandon_threshold.unwrap();
        assert_eq!(threshold.source, "default_insufficient_samples");
    }

    #[test]
    fn empty_database_yields_zeros_not_an_error() {
        // 데이터가 없는 것은 오류가 아니다. 다만 0을 "지표가 좋다"로 읽으면 안 되므로
        // tasksScanned를 함께 낸다 — 분모가 0인 비율은 계산하지 않는다.
        let (_d, store) = seeded();
        let metrics = collect(&store, None).unwrap();
        assert_eq!(metrics.tasks_scanned, 1);
        assert_eq!(metrics.coverage.criteria, 0);
        assert_eq!(metrics.conflicts.detected, 0);
    }
    // ---- TRIAGE 테스트 파일 제외 규칙 (context-engine.md 11.1절) ----

    fn seed_triage(store: &mut Store, task_id: &str, payload: Value, mutated: &[&str]) {
        if task_id != "task-1" {
            store
                .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "fast", "fix")
                .unwrap();
        }
        store.append_event(task_id, "TRIAGE_COMPLETED", &payload).unwrap();
        for path in mutated {
            store
                .append_event(task_id, "FILE_MUTATED", &json!({ "path": path }))
                .unwrap();
        }
    }

    /// 규칙이 판정을 바꾸고, 제외했던 테스트 파일이 실제로 고쳐졌다 = **오분류**다.
    #[test]
    fn a_mutated_excluded_test_counts_as_a_misclassification() {
        let (_d, mut store) = seeded();
        seed_triage(
            &mut store,
            "task-1",
            json!({
                "complexityTier": "simple",
                "tierIfTestsCounted": "standard",
                "excludedTestFiles": ["src/paginate.test.ts"],
            }),
            &["src/paginate.test.ts"],
        );

        let m = collect(&store, None).unwrap();
        assert_eq!(m.test_file_rule.tasks_judged_by_rules, 1);
        assert_eq!(m.test_file_rule.tasks_with_excluded_tests, 1);
        assert_eq!(m.test_file_rule.tasks_where_rule_changed_tier, 1);
        assert_eq!(m.test_file_rule.tasks_where_excluded_test_was_mutated, 1);
    }

    /// 규칙이 판정을 바꿨지만 그 테스트 파일은 건드리지 않았다 = 규칙이 **맞았다.**
    #[test]
    fn an_untouched_excluded_test_is_not_a_misclassification() {
        let (_d, mut store) = seeded();
        seed_triage(
            &mut store,
            "task-1",
            json!({
                "complexityTier": "simple",
                "tierIfTestsCounted": "standard",
                "excludedTestFiles": ["src/paginate.test.ts"],
            }),
            &["src/paginate.ts"],
        );

        let m = collect(&store, None).unwrap();
        assert_eq!(m.test_file_rule.tasks_where_rule_changed_tier, 1);
        assert_eq!(m.test_file_rule.tasks_where_excluded_test_was_mutated, 0);
    }

    /// **분모를 부풀리지 않는다.** 다른 이유로 이미 standard였다면 규칙은 아무것도 하지 않았고,
    /// 그 태스크를 분모에 넣으면 오분류율이 실제보다 낮아 보인다.
    #[test]
    fn a_task_the_rule_did_not_change_stays_out_of_the_denominator() {
        let (_d, mut store) = seeded();
        seed_triage(
            &mut store,
            "task-1",
            json!({
                "complexityTier": "standard",
                "tierIfTestsCounted": "standard",
                "excludedTestFiles": ["src/auth.test.ts"],
            }),
            &["src/auth.test.ts"],
        );

        let m = collect(&store, None).unwrap();
        assert_eq!(m.test_file_rule.tasks_with_excluded_tests, 1);
        assert_eq!(m.test_file_rule.tasks_where_rule_changed_tier, 0);
        assert_eq!(m.test_file_rule.tasks_where_excluded_test_was_mutated, 0);
    }

    /// 사용자가 tier를 고른 태스크에는 근거가 없다 — **규칙이 돌지 않았으므로** 세지 않는다.
    #[test]
    fn a_task_without_evidence_is_not_judged_by_the_rule() {
        let (_d, mut store) = seeded();
        seed_triage(
            &mut store,
            "task-1",
            json!({ "complexityTier": "standard", "appliedPolicies": ["executionMode=verified"] }),
            &["src/a.test.ts"],
        );

        let m = collect(&store, None).unwrap();
        assert_eq!(m.test_file_rule.tasks_judged_by_rules, 0);
        assert_eq!(m.test_file_rule.tasks_where_rule_changed_tier, 0);
    }

    /// 스냅샷의 경로와 `FILE_MUTATED`의 경로는 표기가 다를 수 있다. 꼬리가 같으면 같은 파일이다 —
    /// 여기서 못 맞추면 오분류가 **0으로 보고되고**, 그건 "규칙이 완벽하다"로 읽힌다.
    #[test]
    fn paths_match_across_notations() {
        assert!(same_path("src/a.test.ts", "./src/a.test.ts"));
        assert!(same_path("src\\a.test.ts", "src/a.test.ts"));
        assert!(same_path("src/a.test.ts", "/tmp/ws/src/a.test.ts"));
        assert!(!same_path("src/a.test.ts", "src/b.test.ts"));
        // 꼬리 일치가 경로 경계를 무시하면 안 된다.
        assert!(!same_path("a.test.ts", "src/ba.test.ts"));
    }
    // ---- 인덱스 캐시 (context-engine.md 2.1절) ----

    #[test]
    fn index_cache_counts_builds_hits_and_the_time_they_saved() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "WORKSPACE_INDEX_BUILT",
                &json!({ "buildMs": 400, "fileCount": 1200 }),
            )
            .unwrap();
        store
            .append_event("task-1", "WORKSPACE_INDEX_CACHE_HIT", &json!({ "savedBuildMs": 400 }))
            .unwrap();
        store
            .append_event("task-1", "WORKSPACE_INDEX_CACHE_HIT", &json!({ "savedBuildMs": 380 }))
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert_eq!(m.index_cache.builds, 1);
        assert_eq!(m.index_cache.hits, 2);
        // **이득의 크기는 적중률이 아니라 이 값에 있다.**
        assert_eq!(m.index_cache.saved_ms_total, 780);
        assert_eq!(m.index_cache.p50_build_ms, Some(400));
        assert_eq!(m.index_cache.p90_file_count, Some(1200));
    }

    /// 회피한 시간을 모르는 적중을 **조용히 0으로 더하지 않는다.** 그러면 "이득이 작다"와
    /// "배선이 끊겼다"가 같은 숫자가 되고, 그 결론은 "캐시를 지우자"로 간다.
    #[test]
    fn a_hit_without_a_recorded_build_time_is_counted_separately() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "WORKSPACE_INDEX_CACHE_HIT", &json!({ "savedBuildMs": 500 }))
            .unwrap();
        store
            .append_event("task-1", "WORKSPACE_INDEX_CACHE_HIT", &json!({ "builtAt": "옛 기록" }))
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert_eq!(m.index_cache.hits, 2);
        assert_eq!(m.index_cache.saved_ms_total, 500);
        assert_eq!(m.index_cache.hits_without_saved_ms, 1);
    }

    // ---- 열린 질문의 준비 상태 ----

    fn question<'a>(m: &'a Metrics, id: &str) -> &'a OpenQuestion {
        m.open_questions.iter().find(|q| q.id == id).expect(id)
    }

    #[test]
    fn open_questions_start_out_unanswerable() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();

        // 빈 목록이면 "열린 질문이 없다"가 되어 이 가드 자체가 사라진다.
        assert!(m.open_questions.len() >= 6, "{:?}", m.open_questions);
        for q in &m.open_questions {
            assert_eq!(q.samples, 0, "{}", q.id);
            assert_eq!(q.readiness, Readiness::InsufficientSamples, "{}", q.id);
        }
    }

    /// **각 질문이 자기 계수기에 연결돼 있는가.** 하나를 채웠을 때 그것만 바뀌어야 한다 —
    /// 공유 계수기를 읽고 있으면 여러 개가 함께 넘어가고, 그러면 "이 질문의 표본"이라는 말이
    /// 아무것도 뜻하지 않는다.
    #[test]
    fn filling_one_question_does_not_move_the_others() {
        let (_d, mut store) = seeded();
        let items: Vec<(&str, &str)> = (0..MIN_OPEN_QUESTION_SAMPLES)
            .map(|_| ("UNVERIFIED", "no_test_reference"))
            .collect();
        store
            .append_event("task-1", "CRITERIA_EVALUATED", &evaluated(items))
            .unwrap();

        let m = collect(&store, None).unwrap();
        let coverage = question(&m, "criteriaCoverage");
        assert_eq!(coverage.samples, MIN_OPEN_QUESTION_SAMPLES);
        assert_eq!(coverage.readiness, Readiness::EnoughToLook);

        for q in m.open_questions.iter().filter(|q| q.id != "criteriaCoverage") {
            assert_eq!(
                q.readiness,
                Readiness::InsufficientSamples,
                "{} 가 함께 움직였습니다",
                q.id
            );
        }
    }

    /// 하나 모자라면 아직 아니다 — 경계에서 관대해지면 문턱이 있으나 마나다.
    #[test]
    fn one_short_of_the_minimum_is_still_insufficient() {
        let (_d, mut store) = seeded();
        let items: Vec<(&str, &str)> = (0..(MIN_OPEN_QUESTION_SAMPLES - 1))
            .map(|_| ("UNVERIFIED", "no_test_reference"))
            .collect();
        store
            .append_event("task-1", "CRITERIA_EVALUATED", &evaluated(items))
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert_eq!(
            question(&m, "criteriaCoverage").readiness,
            Readiness::InsufficientSamples
        );
    }

    /// 분모와 "어디를 고치는가"가 비어 있으면 이 목록은 숫자만 늘린다 — 관측이 결정으로
    /// 이어지지 않는다.
    #[test]
    fn every_question_names_its_denominator_and_what_to_act_on() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();

        let mut ids = std::collections::BTreeSet::new();
        for q in &m.open_questions {
            assert!(!q.question.is_empty(), "{}", q.id);
            assert!(!q.denominator.is_empty(), "{}", q.id);
            assert!(!q.act_on.is_empty(), "{}", q.id);
            assert!(q.min_samples > 0, "{}", q.id);
            assert!(ids.insert(q.id), "id가 겹칩니다: {}", q.id);
        }
    }
    // ---- IPC 줄 크기 (process-architecture.md 3.1절) ----

    #[test]
    fn ipc_line_sizes_merge_across_tasks_and_keep_the_largest() {
        let (_d, mut store) = seeded();
        store
            .create_task("task-2", "sess-1", "ws-1", "/tmp/ws", "fast", "fix")
            .unwrap();
        store
            .append_event(
                "task-1",
                "IPC_LINE_SIZES",
                &json!({
                    "lines": 3,
                    "maxBytes": 2048,
                    "buckets": [{ "upToBytes": 1024, "lines": 2 }, { "upToBytes": 65536, "lines": 1 }],
                }),
            )
            .unwrap();
        store
            .append_event(
                "task-2",
                "IPC_LINE_SIZES",
                &json!({
                    "lines": 1,
                    "maxBytes": 900,
                    "buckets": [{ "upToBytes": 1024, "lines": 1 }],
                }),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        // 표본은 태스크 수다 — 줄로 세면 한 태스크가 최소치를 넘겨버린다.
        assert_eq!(m.ipc_line_sizes.tasks_observed, 2);
        assert_eq!(question(&m, "ipcLineSize").samples, 2);
        assert_eq!(m.ipc_line_sizes.lines, 4);
        // **합치지 않고 최댓값을 고른다.** 더하면 상한 판단이 무의미해진다.
        assert_eq!(m.ipc_line_sizes.max_bytes, 2048);
        assert_eq!(m.ipc_line_sizes.by_up_to_bytes.get(&1024), Some(&3));
        assert_eq!(m.ipc_line_sizes.by_up_to_bytes.get(&65536), Some(&1));
    }

    /// **상한 대비 비율이 답의 형태다.** 2 KiB가 32 MiB의 몇 %인지가 "상한이 헐거운가"에
    /// 직접 답한다 — 0으로 반올림해 버리면 "재봤더니 0%"가 되어 아무 말도 하지 않는다.
    #[test]
    fn the_max_is_reported_as_a_share_of_the_limit_without_rounding_to_zero() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "IPC_LINE_SIZES", &json!({ "lines": 1, "maxBytes": 2048 }))
            .unwrap();

        let m = collect(&store, None).unwrap();
        assert_eq!(m.ipc_line_sizes.max_percent_of_limit, Some(1));
    }

    /// 관측이 없으면 비율을 말하지 않는다 — 0%는 "작다"로 읽히지만 사실은 "모른다"다.
    #[test]
    fn no_observation_means_no_share_at_all() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.ipc_line_sizes.max_percent_of_limit, None);
        assert_eq!(question(&m, "ipcLineSize").readiness, Readiness::InsufficientSamples);
    }

    // ---- 검수가 무엇을 했는가 (product-strategy.md 14절) ----

    #[test]
    fn field_and_position_are_tallied_jointly() {
        // 주변 분포 둘로는 교락을 풀 수 없다. 같은 필드가 다른 자리에 온 카드가 실제로
        // 존재하므로, 결합 분포에서만 "자리 때문인가"를 물을 수 있다.
        let (_d, mut store) = seeded();
        // 카드 1: doneCriteria가 갈려서 targetPaths는 2번 자리.
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({ "cardSize": 2, "decisions": [
                    { "disagreementId": "a", "cardPosition": 1, "optionRank": 1, "field": "doneCriteria", "freeform": false, "blocking": true },
                    { "disagreementId": "b", "cardPosition": 2, "optionRank": 2, "field": "targetPaths", "freeform": false, "blocking": true },
                ]}),
            )
            .unwrap();
        // 카드 2: doneCriteria가 갈리지 않아 targetPaths가 1번 자리.
        store
            .create_task("task-2", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        store
            .append_event(
                "task-2",
                "USER_DECISION_RECORDED",
                &json!({ "cardSize": 1, "decisions": [
                    { "disagreementId": "c", "cardPosition": 1, "optionRank": 1, "field": "targetPaths", "freeform": false, "blocking": true },
                ]}),
            )
            .unwrap();

        let m = collect(&store, None).unwrap();
        let target = m.card_answers.by_field_and_position.get("targetPaths").expect("필드가 없습니다");
        // **같은 필드가 두 자리에 나타난다** — 이게 없으면 자리 효과를 물을 수 없다.
        assert_eq!(target.get(&1).map(|f| f.picked_primary), Some(1), "{target:?}");
        assert_eq!(target.get(&2).map(|f| f.picked_other), Some(1), "{target:?}");
        // 주변 분포는 그대로 남는다 — 결합이 그것을 대체하지는 않는다.
        assert_eq!(m.card_answers.by_field.get("targetPaths").map(|f| f.picked_primary), Some(1));
    }

    // ---- 지표가 읽히는가 ----

    /// **모든 집계에 읽는 법이 붙어 있는가.**
    ///
    /// 이 파일의 모듈 주석은 오래전부터 "지표를 추가하면서 여기 넣는 것을 잊으면 그 지표는
    /// 아무도 읽지 않는 숫자가 된다"고 경고하고 있었다. 경고는 잊혔고 — `budgetHeadroom`이
    /// 정확히 그렇게 빠져 있었다(문서는 "측정할 수 있다"고 적었는데 집계가 없었다).
    /// 이제 새 지표를 넣으면 질문을 붙이거나 면제 이유를 적어야 한다.
    #[test]
    fn every_metric_is_read_by_a_question_or_is_explicitly_exempt() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        let json = serde_json::to_value(&m).unwrap();
        let keys: Vec<String> = json.as_object().unwrap().keys().cloned().collect();
        assert!(keys.len() >= 10, "직렬화가 깨졌습니다: {keys:?}");

        let read: Vec<&str> = m.open_questions.iter().map(|q| q.metric).collect();
        let exempt: Vec<&str> = METRICS_WITHOUT_QUESTION.iter().map(|(k, _)| *k).collect();

        let orphans: Vec<&String> = keys
            .iter()
            .filter(|k| !read.contains(&k.as_str()) && !exempt.contains(&k.as_str()))
            .collect();
        assert!(
            orphans.is_empty(),
            "읽는 법이 없는 지표: {orphans:?} — openQuestion을 붙이거나 METRICS_WITHOUT_QUESTION에 이유를 적을 것"
        );
    }

    #[test]
    fn a_question_cannot_point_at_a_metric_that_does_not_exist() {
        // 오타 하나면 질문이 없는 칸을 가리키고, 그 질문은 영원히 0을 읽는다.
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        let json = serde_json::to_value(&m).unwrap();
        let object = json.as_object().unwrap();
        for question in &m.open_questions {
            assert!(
                object.contains_key(question.metric),
                "질문 {}가 없는 지표 {}를 가리킵니다",
                question.id,
                question.metric
            );
        }
    }

    #[test]
    fn exemptions_carry_a_reason() {
        // 이유 없는 면제는 다음 사람이 판단할 수 없다.
        for (key, reason) in METRICS_WITHOUT_QUESTION {
            assert!(!reason.trim().is_empty(), "{key}의 면제 이유가 비어 있습니다");
        }
    }

    // ---- 14절 보조 지표 ----

    #[test]
    fn baseline_reports_are_not_in_the_first_attempt_denominator() {
        // baseline은 "작업 전"이라 첫 시도 통과율의 대상이 아니다. 넣으면 분모가 두 배가 되고
        // 비율이 절반으로 보인다.
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "VERIFICATION_COMPLETED", &json!({ "phase": "baseline", "attemptNumber": 0, "overall": "pass" }))
            .unwrap();
        store
            .append_event("task-1", "VERIFICATION_COMPLETED", &json!({ "phase": "post", "attemptNumber": 0, "overall": "pass" }))
            .unwrap();
        store
            .append_event("task-1", "VERIFICATION_COMPLETED", &json!({ "phase": "post", "attemptNumber": 1, "overall": "pass" }))
            .unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.operational.post_verifications, 2);
        // 재시도 끝에 통과한 것은 "첫 시도"가 아니다.
        assert_eq!(m.operational.first_attempt_passes, 1);
    }

    #[test]
    fn rollback_is_counted_per_task_not_per_event() {
        let (_d, mut store) = seeded();
        store.append_event("task-1", "ROLLBACK_COMPLETED", &json!({})).unwrap();
        store.append_event("task-1", "ROLLBACK_COMPLETED", &json!({})).unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.operational.tasks_rolled_back, 1);
    }

    #[test]
    fn policy_denials_have_a_denominator() {
        // 거부 건수만 세면 "차단률"을 낼 수 없다 — 100건 중 1건과 2건 중 1건은 다른 사실이다.
        let (_d, mut store) = seeded();
        store.append_event("task-1", "POLICY_DECIDED", &json!({ "decision": "allow" })).unwrap();
        store.append_event("task-1", "POLICY_DECIDED", &json!({ "decision": "deny" })).unwrap();
        store.append_event("task-1", "APPROVAL_GRANTED", &json!({})).unwrap();
        store.append_event("task-1", "APPROVAL_DENIED", &json!({})).unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.operational.policy_decisions, 2);
        assert_eq!(m.operational.policy_denials, 1);
        assert_eq!(m.operational.approvals_granted, 1);
        assert_eq!(m.operational.approvals_denied, 1);
    }

    // ---- 예약 대비 실제 (multi-engine-routing 10.6절) ----

    #[test]
    fn reservation_settlements_yield_the_headroom_multiple() {
        let (_d, mut store) = seeded();
        for (reserved, actual) in [(0.30, 0.10), (0.60, 0.10), (0.20, 0.10)] {
            store
                .append_event(
                    "task-1",
                    "BUDGET_RESERVATION_SETTLED",
                    &json!({ "reservedUsd": reserved, "actualUsd": actual }),
                )
                .unwrap();
        }
        let m = collect(&store, None).unwrap();
        assert_eq!(m.budget_headroom.settled, 3);
        // 300%, 600%, 200% → p50은 300%. 지금 상수(×3)가 맞는지는 이 수가 말한다.
        assert_eq!(m.budget_headroom.p50_reserved_over_actual_percent, Some(300));
        assert_eq!(m.budget_headroom.max_reserved_over_actual_percent, Some(600));
    }

    #[test]
    fn a_settlement_without_cost_is_counted_not_dropped() {
        // 0으로 나누면 무한대다. 조용히 빼면 분모가 왜 작은지 알 수 없고, fake 공급자로 돌린
        // 기록이 섞였는지도 구별되지 않는다.
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "BUDGET_RESERVATION_SETTLED", &json!({ "reservedUsd": 0.3, "actualUsd": 0.0 }))
            .unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.budget_headroom.settled, 0);
        assert_eq!(m.budget_headroom.settled_without_cost, 1);
        assert_eq!(m.budget_headroom.p50_reserved_over_actual_percent, None);
    }

    #[test]
    fn open_and_unresolved_reservations_are_different_facts() {
        // 열린 채 끝난 예약은 **과금됐을 수 있다**(10.7절). 취소된 예약과 같은 칸에 넣으면
        // 그 위험이 사라진다.
        let (_d, mut store) = seeded();
        store.append_event("task-1", "BUDGET_RESERVATION_RELEASED", &json!({})).unwrap();
        store.append_event("task-1", "BUDGET_RESERVATION_UNRESOLVED", &json!({})).unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.budget_headroom.released, 1);
        assert_eq!(m.budget_headroom.unresolved, 1);
    }

    // ---- blocking 판정 규칙 (state-machine 12절) ----

    #[test]
    fn answers_are_split_by_whether_the_rule_called_it_blocking() {
        // 이 축이 없으면 "규칙이 묻지 않아도 된다고 한 쟁점에서 사용자가 뒤집었는가"를 물을 수 없다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({ "cardSize": 2, "decisions": [
                    { "disagreementId": "d0", "cardPosition": 1, "optionRank": 1, "field": "doneCriteria", "freeform": false, "blocking": true },
                    { "disagreementId": "d1", "cardPosition": 2, "optionRank": 2, "field": "targetPaths", "freeform": false, "blocking": false },
                ]}),
            )
            .unwrap();
        let m = collect(&store, None).unwrap();
        let by = &m.card_answers.by_blocking;
        assert_eq!(by.get("blocking").map(|f| f.picked_primary), Some(1), "{by:?}");
        // 규칙이 막지 않기로 한 쟁점에서 사용자가 다른 초안을 골랐다 — 그 판정이 틀렸던 경우다.
        assert_eq!(by.get("non_blocking").map(|f| f.picked_other), Some(1), "{by:?}");
    }

    #[test]
    fn records_without_the_axis_are_not_folded_into_either_side() {
        // 어느 한쪽에 합치면 그 칸의 비율이 과거 데이터로 희석된다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({ "cardSize": 1, "decisions": [
                    { "disagreementId": "d0", "cardPosition": 1, "optionRank": 1, "field": "doneCriteria", "freeform": false },
                ]}),
            )
            .unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.card_answers.by_blocking.get("unknown").map(|f| f.picked_primary), Some(1));
        assert!(m.card_answers.by_blocking.get("blocking").is_none());
        // 그리고 분모에도 들어가지 않는다.
        assert_eq!(question(&m, "blockingRule").samples, 0);
    }

    fn seed_review(store: &mut Store, task_id: &str, verdict: &str, changed: Option<bool>) {
        store
            .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        let mut payload = json!({ "verdict": verdict });
        if let Some(changed) = changed {
            payload["revisionChangedThePatch"] = json!(changed);
        }
        store.append_event(task_id, "REVIEW_RECEIVED", &payload).unwrap();
    }

    #[test]
    fn a_revision_that_changed_nothing_is_counted_separately() {
        // 산문만 남긴 지적과 실제로 patch를 바꾼 지적은 다른 사실이다. 뭉개면 "검수가 기여했다"가
        // 언제나 참이 된다.
        let (_d, mut store) = seeded();
        seed_review(&mut store, "t-changed", "REVISE", Some(true));
        seed_review(&mut store, "t-same", "REVISE", Some(false));
        let m = collect(&store, None).unwrap();
        assert_eq!(m.reviewer_findings.revisions_proposed, 2);
        assert_eq!(m.reviewer_findings.revisions_that_changed_the_patch, 1);
    }

    #[test]
    fn a_revise_without_a_patch_is_not_a_revision_that_changed_nothing() {
        // `null`을 false로 뭉개면 "바꾸지 않았다"와 "바꿀 기회가 없었다"가 같은 값이 된다.
        let (_d, mut store) = seeded();
        seed_review(&mut store, "t-none", "REVISE", None);
        let m = collect(&store, None).unwrap();
        assert_eq!(m.reviewer_findings.revisions_without_patch, 1);
        assert_eq!(m.reviewer_findings.revisions_that_changed_the_patch, 0);
        // 실행된 적이 없으므로 결말 분포에도 들어가지 않는다.
        assert!(m.reviewer_findings.outcome_after_revision.is_empty(), "{:?}", m.reviewer_findings);
    }

    #[test]
    fn verdicts_are_counted_by_the_last_review() {
        // REVISE 루프를 돌면 여러 번 나온다. 전부 세면 루프가 많은 태스크가 분포를 좌우한다.
        let (_d, mut store) = seeded();
        store
            .create_task("t-loop", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        store
            .append_event("t-loop", "REVIEW_RECEIVED", &json!({ "verdict": "REVISE", "revisionChangedThePatch": true }))
            .unwrap();
        store
            .append_event("t-loop", "REVIEW_RECEIVED", &json!({ "verdict": "ACCEPT" }))
            .unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.reviewer_findings.tasks_reviewed, 1);
        assert_eq!(m.reviewer_findings.by_verdict.get("ACCEPT"), Some(&1));
        assert_eq!(m.reviewer_findings.by_verdict.get("REVISE"), None);
    }

    #[test]
    fn tasks_without_a_review_are_not_in_the_denominator() {
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.reviewer_findings.tasks_reviewed, 0);
    }

    // ---- 모델 정면 비교 (multi-engine-routing.md 12절) ----

    #[test]
    fn contrast_picks_are_attributed_to_the_model_that_wrote_the_option() {
        let (_d, mut store) = seeded();
        // 쟁점 3개 중 2개에서 두 번째 초안(model-b)을 골랐다 → 그 태스크는 b의 승리다.
        seed_contrast_task(&mut store, "t-a", ("model-a", "model-b"), &[Some(1), Some(1), Some(0)]);
        let m = collect(&store, None).unwrap();
        let h = m.model_evaluation.head_to_head.get("model-a vs model-b").expect("쌍이 없습니다");
        assert_eq!(h.wins, [0, 1], "{h:?}");
        assert_eq!(m.model_evaluation.contrast_tasks, 1);
        assert_eq!(m.model_evaluation.unattributed, 0);
    }

    #[test]
    fn a_task_is_one_sample_however_many_disagreements_it_had() {
        // 쟁점으로 세면 이 태스크 하나가 표본 5가 되어 완승으로 유의해진다. 태스크로 세면 1이다.
        let (_d, mut store) = seeded();
        seed_contrast_task(
            &mut store,
            "t-a",
            ("model-a", "model-b"),
            &[Some(0), Some(0), Some(0), Some(0), Some(0)],
        );
        let m = collect(&store, None).unwrap();
        let h = m.model_evaluation.head_to_head.get("model-a vs model-b").unwrap();
        assert_eq!(h.wins, [1, 0]);
        assert_eq!(h.verdict, EvaluationVerdict::TooFewToSeparate, "{h:?}");
    }

    #[test]
    fn ties_and_rejections_and_broken_wiring_are_different_facts() {
        let (_d, mut store) = seeded();
        // 동수 — 승자가 없다.
        seed_contrast_task(&mut store, "t-tie", ("model-a", "model-b"), &[Some(0), Some(1)]);
        // 둘 다 버리고 직접 적었다.
        seed_contrast_task(&mut store, "t-free", ("model-a", "model-b"), &[None, None]);
        // 판정이 없었다.
        seed_contrast_task(&mut store, "t-none", ("model-a", "model-b"), &[]);
        let m = collect(&store, None).unwrap();
        let h = m.model_evaluation.head_to_head.get("model-a vs model-b").unwrap();
        assert_eq!(h.ties, 1);
        assert_eq!(h.wins, [0, 0]);
        assert_eq!(m.model_evaluation.both_rejected, 1);
        assert_eq!(m.model_evaluation.no_verdict, 1);
        assert_eq!(m.model_evaluation.contrast_tasks, 3);
    }

    #[test]
    fn an_unlinkable_pick_is_counted_not_dropped() {
        // 조용히 버리면 배선이 끊긴 상태가 "아직 대조를 안 돌렸다"와 똑같이 보인다.
        let (_d, mut store) = seeded();
        store
            .create_task("t-broken", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        for (i, model) in ["model-a", "model-b"].iter().enumerate() {
            store
                .append_event("t-broken", "DRAFT_RECEIVED", &json!({ "proposalId": format!("p{i}"), "model": model }))
                .unwrap();
        }
        store
            .append_event(
                "t-broken",
                "DISAGREEMENT_DETECTED",
                &json!({ "contrasted": true, "disagreements": [
                    { "disagreementId": "d0", "question": { "options": [
                        { "optionId": "d0-o0", "fromProposalId": "p0" }
                    ]}}
                ]}),
            )
            .unwrap();
        store
            .append_event(
                "t-broken",
                "USER_DECISION_RECORDED",
                // 이 optionId는 어느 선택지 목록에도 없다 — 이을 수 없다.
                &json!({ "decisions": [{ "disagreementId": "d0", "optionId": "없는-선택지", "freeform": false }] }),
            )
            .unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.model_evaluation.unattributed, 1);
        assert!(m.model_evaluation.head_to_head.is_empty(), "{:?}", m.model_evaluation);
    }

    #[test]
    fn tasks_without_contrast_are_not_in_the_population() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "DRAFT_RECEIVED", &json!({ "proposalId": "p0", "model": "model-a" }))
            .unwrap();
        store
            .append_event("task-1", "DISAGREEMENT_DETECTED", &json!({ "contrasted": false, "disagreements": [] }))
            .unwrap();
        let m = collect(&store, None).unwrap();
        assert_eq!(m.model_evaluation.contrast_tasks, 0);
    }

    // ---- 부호 검정 ----

    #[test]
    fn the_minimum_sample_is_derived_from_the_test_not_written_down() {
        let n = min_separable_comparisons();
        // 완승해도 유의하지 않은 크기에서는 판정이 나오면 안 된다.
        let models = ["a".to_string(), "b".to_string()];
        assert_eq!(
            evaluation_verdict(&models, [n - 1, 0]),
            EvaluationVerdict::TooFewToSeparate,
            "n={n}"
        );
        // 하나만 더 있으면 완승이 갈린다.
        assert_eq!(
            evaluation_verdict(&models, [n, 0]),
            EvaluationVerdict::Separated { better: "a".to_string() }
        );
        // 그리고 그 경계가 α와 실제로 이어져 있다.
        assert!(0.5_f64.powi((n - 1) as i32) > SIGN_TEST_ALPHA);
        assert!(0.5_f64.powi(n as i32) <= SIGN_TEST_ALPHA);
    }

    #[test]
    fn a_big_but_balanced_sample_is_not_significant() {
        // 로그 공간으로 더하지 않으면 0.5^n이 0으로 내려앉아 **50:50도 p=0**이 된다.
        // 값이 그럴듯해서 눈으로 잡히지 않는 종류의 고장이다.
        let p = sign_test_p_value(600, 600);
        // 참값은 0.5보다 아주 조금 크다. 구간을 넓게 잡으면 **0으로 내려앉은 것도 1.0으로
        // 세탁된 것도** 통과한다 — 둘 다 실제로 나온 고장이다.
        assert!(p > 0.4 && p < 0.6, "p={p}");
        let models = ["a".to_string(), "b".to_string()];
        assert_eq!(evaluation_verdict(&models, [600, 600]), EvaluationVerdict::NoDifference);
    }

    #[test]
    fn a_lopsided_large_sample_separates() {
        let p = sign_test_p_value(40, 10);
        assert!(p < 0.001, "p={p}");
        let models = ["a".to_string(), "b".to_string()];
        assert_eq!(
            evaluation_verdict(&models, [40, 10]),
            EvaluationVerdict::Separated { better: "a".to_string() }
        );
    }

    #[test]
    fn sign_test_matches_hand_computed_values() {
        // 5전 5승: 0.5^5 = 0.03125.
        assert!((sign_test_p_value(5, 0) - 0.03125).abs() < 1e-12);
        // 4전 3승: (4 + 1)/16 = 0.3125.
        assert!((sign_test_p_value(3, 1) - 0.3125).abs() < 1e-12);
        // 표본이 없으면 아무것도 말하지 않는다.
        assert_eq!(sign_test_p_value(0, 0), 1.0);
    }

    #[test]
    fn model_evaluation_minimum_is_not_the_conventional_one() {
        // 이 질문만 최소치가 유도된다. 관례적 상수를 씌우면 이미 갈린 결과를 "표본 부족"이라
        // 부르게 된다.
        let (_d, store) = seeded();
        let m = collect(&store, None).unwrap();
        let q = question(&m, "modelEvaluation");
        assert_eq!(q.min_samples, min_separable_comparisons());
        assert!(q.min_samples < MIN_OPEN_QUESTION_SAMPLES);
    }

}
