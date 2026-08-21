//! 기준 계측 집계 — docs/design/state-machine-and-protocol.md 17.10절,
//! product-strategy.md 14절.
//!
//! # 왜 이게 필요한가
//!
//! 12절 미해결 두 항목("기준↔테스트 연결의 커버리지", "위치 충돌 규칙의 오탐률")은 **집계로만**
//! 답할 수 있는 질문이다. 이벤트는 이미 쌓이고 있지만, 한 태스크의 로그를 눈으로 읽어서는
//! "얼마나"를 알 수 없다.
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
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CriteriaMetrics {
    pub coverage: CriteriaCoverage,
    pub conflicts: ConflictOutcomes,
    /// 집계에 들어간 태스크 수 (기준이 없는 태스크 포함).
    #[serde(rename = "tasksScanned")]
    pub tasks_scanned: u64,
}

/// 저장된 이벤트에서 두 지표를 집계한다. **아무것도 쓰지 않는다.**
pub fn collect(store: &Store, workspace_path: Option<&str>) -> Result<CriteriaMetrics, String> {
    let tasks = store
        .all_tasks_for_metrics(workspace_path)
        .map_err(|e| format!("작업 목록을 읽을 수 없습니다: {e}"))?;

    let mut metrics = CriteriaMetrics::default();
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
                        if outcome.get("outcome").and_then(Value::as_str) == Some("proceeded_without_change") {
                            proceeded = true;
                        }
                    }
                }
                _ => {}
            }
        }

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

    Ok(metrics)
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
