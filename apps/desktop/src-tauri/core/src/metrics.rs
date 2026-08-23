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
    question: &'static str,
    denominator: &'static str,
    samples: u64,
    act_on: &'static str,
) -> OpenQuestion {
    OpenQuestion {
        id,
        question,
        denominator,
        samples,
        min_samples: MIN_OPEN_QUESTION_SAMPLES,
        readiness: if samples >= MIN_OPEN_QUESTION_SAMPLES {
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
            "기준을 테스트에 이을 수 있는 경우가 실제로 얼마나 되는가 (state-machine 17.9절)",
            "판정된 기준 개수",
            m.coverage.criteria,
            "no_test_reference가 압도적이면 (a) 기준을 적을 때 테스트를 함께 적게 하거나 (b) 잇는 규칙을 넓힌다. **(b)를 먼저 하고 싶은 유혹을 경계할 것** — 늘어난 확인이 근거 있는지는 같은 규칙으로 검사할 수 없다",
        ),
        open_question(
            "conflictOutcomes",
            "기준 충돌 게이트가 실제 문제를 잡는가, 프롬프트가 기준을 안 읽는 것인가 (17.10절 8)",
            "결말이 기록된 충돌 건수",
            m.conflicts.settled,
            "plan_unchanged가 해석이 그대로인 쪽에 몰리면 프롬프트를, 해석이 달라진 쪽에 몰리면 게이트가 잡은 것이 실제 문제였는지를 본다",
        ),
        open_question(
            "cardQuestions",
            "한 카드 질문 상한 4개와 필드 랭킹이 맞는가 (17.10절 9·10)",
            "카드에서 받은 답의 개수",
            m.card_answers
                .by_position
                .values()
                .map(|p| p.first_option + p.later_option + p.freeform + p.unknown)
                .sum(),
            "자리에 따라 비율이 달라지는 것만이 자리 때문이다. 필드는 절대값이 아니라 필드끼리 비교하고, 고칠 자리는 DISAGREEMENT_FIELD_RANK 한 줄이다",
        ),
        open_question(
            "tokenEstimate",
            "토큰 상한 계수가 실제로 상한인가 (context-engine 8.1절)",
            "추정과 실제를 둘 다 아는 호출 수",
            m.token_estimate.calls,
            "callsWhereActualExceededEstimate가 0이 아니면 상한이 아니므로 계수를 올린다. p90 비율이 한참 낮으면 과대 추정이므로 내린다",
        ),
        open_question(
            "testFileRule",
            "TRIAGE의 테스트 파일 제외 규칙이 오분류를 얼마나 내는가 (context-engine 11.1절)",
            "**규칙이 판정을 바꾼** 태스크 수 (simple 건수가 아니다)",
            m.test_file_rule.tasks_where_rule_changed_tier,
            "자주 틀리면 고칠 자리는 TEST_FILE_PATTERNS가 아니라 규칙 자체다 — 테스트 파일을 고치는 것이 작업인 태스크를 어떻게 알아볼 것인가가 진짜 질문이다",
        ),
        open_question(
            "ipcLineSize",
            "NDJSON 한 줄 상한 32 MiB가 맞는 값인가 (process-architecture 3.1절)",
            "줄 크기를 보고한 **태스크 수** (줄 수가 아니다 — 한 태스크가 수십 줄을 주고받는다)",
            m.ipc_line_sizes.tasks_observed,
            "maxPercentOfLimit이 한 자리 수에 머무르면 상한이 헐거운 것이다. 다만 **낮추는 것은 정당한 메시지를 프로토콜 위반으로 죽이는 쪽**이므로, 분포의 꼬리(가장 큰 구간의 줄 수)를 함께 보고 여유를 남긴다",
        ),
        open_question(
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

    metrics.force_abandon_threshold = Some(suggest_force_abandon_ms(&metrics.cancellation));

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

            // 필드는 payload가 말한다. **id에서 파싱하지 않는다** — id 형식을 바꾸는 순간
            // 집계가 조용히 끊기고, 끊긴 것은 0으로 보인다.
            if let Some(field) = decision.get("field").and_then(Value::as_str) {
                let by_field = out.by_field.entry(field.to_string()).or_default();
                if freeform {
                    by_field.freeform += 1;
                } else {
                    match rank {
                        Some(1) => by_field.picked_primary += 1,
                        Some(_) => by_field.picked_other += 1,
                        None => by_field.unknown += 1,
                    }
                }
            }
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
}
