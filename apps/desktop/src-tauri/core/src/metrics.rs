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

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Metrics {
    pub coverage: CriteriaCoverage,
    pub conflicts: ConflictOutcomes,
    pub cancellation: CancellationLatency,
    /// 관측에서 유도한 강제 포기 임계값. **집계 결과이지 설정이 아니다** —
    /// 데이터가 없으면 기본값과 그 사실을 그대로 돌려준다.
    #[serde(rename = "forceAbandonThreshold")]
    pub force_abandon_threshold: Option<ForceAbandonThreshold>,
    /// 집계에 들어간 태스크 수 (기준이 없는 태스크 포함).
    #[serde(rename = "tasksScanned")]
    pub tasks_scanned: u64,
}

/// 저장된 이벤트에서 두 지표를 집계한다. **아무것도 쓰지 않는다.**
pub fn collect(store: &Store, workspace_path: Option<&str>) -> Result<Metrics, String> {
    let tasks = store
        .all_tasks_for_metrics(workspace_path)
        .map_err(|e| format!("작업 목록을 읽을 수 없습니다: {e}"))?;

    let mut metrics = Metrics::default();
    let mut latencies: Vec<u64> = Vec::new();
    for (task_id, terminal_status) in &tasks {
        metrics.tasks_scanned += 1;
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
    metrics.force_abandon_threshold = Some(suggest_force_abandon_ms(&metrics.cancellation));
    Ok(metrics)
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
}
