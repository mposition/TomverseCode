//! 무인 정지의 처방 — "무엇을 바꾸면 이게 지나가는가".
//!
//! state-machine-and-protocol.md 24.8절.
//!
//! # 왜 "재개"가 아닌가
//!
//! 24.7절은 이 자리를 "사람이 이어받아 승인하고 **재개**하는 경로가 없다"라고 적었다.
//! 그런데 그 문장은 두 가지를 묶고 있었다(21.1절 재현 러너에서 만난 것과 같은 모양이다):
//!
//!  1. **멈춘 지점에서 이어서 계속하기** — 오케스트레이터의 진행 중 상태(초안, 계획, 루프
//!     카운터)를 지속화해야 한다. 되돌리기 비싼 결정이고, 지금 그 값어치를 알지 못한다.
//!  2. **사람이 무엇을 승인해야 하는지 알기** — 이미 기록에 있다. 유도하면 된다.
//!
//! 2를 하면 1의 압박이 대부분 사라진다(다시 돌리는 대가가 "무엇을 바꿔야 할지 모른 채
//! 돌리는 것"에서 "정책 하나 켜고 돌리는 것"으로 줄어든다). 그리고 1을 하더라도 2가 어차피
//! 필요하다. 그래서 2를 먼저 한다.
//!
//! # 이 보고서가 말하지 **못하는** 것
//!
//! **이번 실행이 도달한 지점까지만 안다.** 막힌 지점 뒤로는 진행이 달라지므로, 플래그를 켜고
//! 다시 돌리면 이번에 도달하지 못한 **새 지점에서 또 멈출 수 있다.** 이걸 흐리게 말하면
//! 사용자는 한 번이면 된다고 믿고, 두 번째 정지를 도구의 오작동으로 읽는다.
//!
//! 처음에 이 한계를 "무인 실행은 **첫** 승인 지점에서 끝나므로 그 뒤는 기록에 없다"라고 적었다.
//! **e2e가 그 문장을 반증했다**: 실제 실행의 첫 정지는 baseline 검증 명령이었고 태스크는 거기서
//! 끝나지 않았다 — 검증 거부는 `SKIPPED_WITH_REASON`이 되어(원칙: 통과로 위장하지 않는다)
//! 실행이 계속되고, 태스크를 끝낸 것은 그 다음의 patch 거부였다. 정지가 **둘** 기록된다.
//! 한계는 여전히 있지만 이유가 다르다: 끝나서가 아니라 **경로가 달라져서** 모른다.

use crate::store::Store;
use crate::types::PolicyLever;
use serde::Serialize;

/// 한 번의 무인 정지.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BlockedPoint {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub tool: String,
    #[serde(rename = "normalizedTarget")]
    pub normalized_target: String,
    #[serde(rename = "matchedRule")]
    pub matched_rule: String,
    #[serde(rename = "unblockedBy")]
    pub unblocked_by: PolicyLever,
    /// 이 지점을 미리 통과시키는 CLI 플래그. `null`이면 **켤 것이 없다**는 사실이다.
    #[serde(rename = "rerunFlag")]
    pub rerun_flag: Option<String>,
}

/// 이 태스크를 다시 돌릴 때 무엇을 할 수 있는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// 무인 정지가 없었다 — 이 태스크는 다른 이유로 끝났거나 정상 완료됐다.
    NotBlocked,
    /// 기록된 정지가 전부 정책으로 넓힐 수 있다.
    UnblockableByPolicy,
    /// **정책으로 넓힐 수 없는 정지가 있다.** 사람이 있는 실행이 필요하다.
    RequiresHuman,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockedReport {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub verdict: Verdict,
    pub stops: Vec<BlockedPoint>,
    /// 중복을 없앤 플래그 목록 — 다시 돌릴 때 붙일 것들.
    #[serde(rename = "rerunFlags")]
    pub rerun_flags: Vec<String>,
    /// 사람이 있어야만 지날 수 있는 정지들의 `requestId`.
    #[serde(rename = "humanOnly")]
    pub human_only: Vec<String>,
    /// 이 보고서의 한계를 **기계가 읽는 자리에도** 적는다. 모듈 주석은 사람만 읽는다.
    pub caveat: &'static str,
}

const CAVEAT: &str = "이 목록은 이번 실행이 실제로 도달한 승인 지점까지입니다. 막힌 지점 뒤로는 진행이 \
                      달라지므로, 플래그를 켜고 다시 돌리면 이번에 도달하지 못한 새 지점에서 또 멈출 수 있습니다";

/// 저장된 이벤트에서 보고서를 유도한다. **아무것도 쓰지 않는다.**
pub fn collect(store: &Store, task_id: &str) -> Result<BlockedReport, String> {
    let events = store
        .events_after(task_id, None)
        .map_err(|e| format!("이벤트 조회 실패: {e}"))?;

    let mut stops = Vec::new();
    for event in events.iter().filter(|e| e.event_type == "APPROVAL_UNATTENDED") {
        let p = &event.payload;
        let text = |key: &str| p.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
        // **읽지 못한 레버를 `HumanOnly`로 접지 않는다.** 그러면 "사람이 필요하다"는 판정이
        // 파싱 실패에서 나올 수 있고, 그 판정은 근거 없이 사용자를 막는다. 대신 레버가 없는
        // 예전 기록은 정지 목록에 남되 판정에서 제외된다(아래 `lever`가 `None`인 경우).
        let lever: Option<PolicyLever> = p.get("unblockedBy").and_then(|v| serde_json::from_value(v.clone()).ok());
        stops.push(BlockedPoint {
            request_id: text("requestId"),
            tool: text("tool"),
            normalized_target: text("normalizedTarget"),
            matched_rule: text("matchedRule"),
            unblocked_by: lever.unwrap_or(PolicyLever::NotApplicable),
            rerun_flag: lever.and_then(|l| l.rerun_flag()).map(str::to_string),
        });
    }

    let mut rerun_flags: Vec<String> = Vec::new();
    for flag in stops.iter().filter_map(|s| s.rerun_flag.clone()) {
        if !rerun_flags.contains(&flag) {
            rerun_flags.push(flag);
        }
    }
    let human_only: Vec<String> = stops
        .iter()
        .filter(|s| s.unblocked_by == PolicyLever::HumanOnly)
        .map(|s| s.request_id.clone())
        .collect();

    let verdict = if stops.is_empty() {
        Verdict::NotBlocked
    } else if human_only.is_empty() {
        Verdict::UnblockableByPolicy
    } else {
        Verdict::RequiresHuman
    };

    Ok(BlockedReport {
        task_id: task_id.to_string(),
        verdict,
        stops,
        rerun_flags,
        human_only,
        caveat: CAVEAT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::ArtifactStore;
    use serde_json::json;

    fn store_with(events: &[(&str, serde_json::Value)]) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(dir.path()).unwrap();
        let mut store = Store::open_in_memory(artifacts).unwrap();
        store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        for (kind, payload) in events {
            store.append_event("task-1", kind, payload).unwrap();
        }
        (dir, store)
    }

    fn unattended(request_id: &str, lever: &str, rule: &str) -> serde_json::Value {
        json!({
            "requestId": request_id,
            "tool": "apply_patch",
            "normalizedTarget": "src/app.ts",
            "matchedRule": rule,
            "unblockedBy": lever,
        })
    }

    #[test]
    fn a_task_that_never_stopped_is_not_reported_as_blocked() {
        let (_d, store) = store_with(&[("TASK_CREATED", json!({}))]);
        let report = collect(&store, "task-1").unwrap();
        assert_eq!(report.verdict, Verdict::NotBlocked);
        assert!(report.stops.is_empty());
        assert!(report.rerun_flags.is_empty());
    }

    #[test]
    fn a_policy_widenable_stop_yields_the_flag_that_widens_it() {
        let (_d, store) = store_with(&[(
            "APPROVAL_UNATTENDED",
            unattended("req-1", "autoApproveWorkspaceWrites", "workspace_write_requires_approval"),
        )]);
        let report = collect(&store, "task-1").unwrap();
        assert_eq!(report.verdict, Verdict::UnblockableByPolicy);
        assert_eq!(report.rerun_flags, vec!["--auto-approve-writes".to_string()]);
        assert!(report.human_only.is_empty());
    }

    /// **정책으로 못 여는 정지 하나가 판정을 뒤집는다.** 나머지가 전부 열려도 그렇다 —
    /// 열리는 것만 세어 "이 플래그를 켜세요"라고 하면, 사용자는 켜고 다시 돌렸다가 같은
    /// 자리에서 또 멈춘다.
    #[test]
    fn one_human_only_stop_outranks_every_widenable_one() {
        let (_d, store) = store_with(&[
            (
                "APPROVAL_UNATTENDED",
                unattended("req-1", "autoApproveWorkspaceWrites", "workspace_write_requires_approval"),
            ),
            (
                "APPROVAL_UNATTENDED",
                unattended("req-2", "humanOnly", "mcp_always_requires_approval"),
            ),
        ]);
        let report = collect(&store, "task-1").unwrap();
        assert_eq!(report.verdict, Verdict::RequiresHuman);
        assert_eq!(report.human_only, vec!["req-2".to_string()]);
        // 열리는 쪽의 플래그는 여전히 알려준다 — 사람이 붙어도 그 왕복은 줄일 수 있다.
        assert_eq!(report.rerun_flags, vec!["--auto-approve-writes".to_string()]);
    }

    /// 같은 레버가 여러 번 걸려도 플래그는 한 번만 말한다.
    #[test]
    fn the_same_flag_is_not_repeated() {
        let (_d, store) = store_with(&[
            (
                "APPROVAL_UNATTENDED",
                unattended("req-1", "autoApproveWorkspaceWrites", "workspace_write_requires_approval"),
            ),
            (
                "APPROVAL_UNATTENDED",
                unattended("req-2", "autoApproveWorkspaceWrites", "workspace_write_requires_approval"),
            ),
        ]);
        let report = collect(&store, "task-1").unwrap();
        assert_eq!(report.rerun_flags.len(), 1);
        assert_eq!(report.stops.len(), 2, "정지 자체는 합치지 않는다 — 몇 번 막혔는지는 사실이다");
    }

    /// 레버를 읽지 못한 기록(이 필드가 없던 시절의 이벤트)을 `HumanOnly`로 접으면,
    /// **파싱 실패가 "사람이 필요하다"는 판정을 만든다.** 근거 없이 사용자를 막는 판정이다.
    #[test]
    fn an_unreadable_lever_does_not_become_a_verdict() {
        let (_d, store) = store_with(&[(
            "APPROVAL_UNATTENDED",
            json!({ "requestId": "req-1", "reason": "옛 기록" }),
        )]);
        let report = collect(&store, "task-1").unwrap();
        assert_eq!(report.stops.len(), 1, "정지가 있었다는 사실은 남아야 한다");
        assert!(report.human_only.is_empty(), "레버를 못 읽은 것이 humanOnly가 되었습니다");
        assert_eq!(report.verdict, Verdict::UnblockableByPolicy);
        assert!(report.stops[0].rerun_flag.is_none());
    }

    /// 한계를 사람이 읽는 주석에만 적으면, 이 JSON을 먹는 쪽은 그것을 모른다.
    #[test]
    fn the_report_carries_its_own_limit() {
        let (_d, store) = store_with(&[(
            "APPROVAL_UNATTENDED",
            unattended("req-1", "humanOnly", "delete_always_requires_approval"),
        )]);
        let json = serde_json::to_string(&collect(&store, "task-1").unwrap()).unwrap();
        assert!(json.contains("새 지점에서 또 멈출 수 있습니다"), "{json}");
    }
}
