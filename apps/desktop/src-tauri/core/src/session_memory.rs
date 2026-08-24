//! 세션 메모리 — 같은 세션의 **앞선 태스크에서 사용자가 정한 것**을 다음 태스크가 안다.
//!
//! product-strategy 8.2절 기준: **"세션 내 대화·결정 유지"**. state-machine-and-protocol.md 27절.
//!
//! # 무엇을 나르는가 — 그리고 무엇을 나르지 않는가
//!
//! **사용자 판정만 나른다**(`source == "user_decision"`). 모델이 제안한 기준은 나르지 않는다.
//! 두 값의 권위가 다르기 때문이다(product-strategy 16.1절): 하나는 사용자가 정한 요구이고
//! 다른 하나는 모델이 낸 후보다. 후보를 세션 너머로 나르면 **제안이 요구로 세탁된다** —
//! 사용자는 한 번도 동의한 적이 없는 문장을 다음 태스크에서 "이미 정해진 것"으로 보게 된다.
//!
//! 대화 원문도 나르지 않는다. 나를 수 있는 것은 저장된 판정뿐이고, 그건 **마스킹을 거친
//! 값**이다(host.rs `redact_user_decision`). 원문을 따로 들고 나르면 17.11절이 지적한 노출이
//! 태스크 수만큼 늘어난다 — 그 답변은 원래 한 태스크의 프롬프트에만 실렸다.
//!
//! # 나른 것은 이 태스크의 **기준이 아니다**
//!
//! 앞선 판정은 맥락이지 이번 태스크의 `doneCriteria`가 아니다. 섞으면 17.9절의 기준 평가가
//! **사용자가 이번에 말한 적 없는 요구**에 대해 태스크를 판정하게 된다. 그래서 프롬프트에서도
//! 자리를 나누고, 이 모듈은 `acceptance_criteria`에 아무것도 쓰지 않는다.
//!
//! # 상한이 있다
//!
//! 세션이 길어지면 프롬프트가 무한정 자란다(원칙 5). 최근 것부터 상한까지만 나르고,
//! **잘렸다는 사실을 함께 낸다** — 조용히 자르면 사용자는 앞선 판정이 계속 유효하다고 믿는다.

use crate::store::Store;
use serde::Serialize;

/// 앞선 태스크에서 사용자가 정한 것 하나.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CarriedDecision {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub text: String,
    #[serde(rename = "decidedAt")]
    pub decided_at: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct SessionMemory {
    pub decisions: Vec<CarriedDecision>,
    /// 상한에 걸려 잘렸는가. **개수와 따로 낸다** — "3건"만 보면 그게 전부인 줄 안다.
    pub truncated: bool,
    /// 상한 전에 세션에 있던 사용자 판정의 총 개수.
    #[serde(rename = "consideredCount")]
    pub considered_count: usize,
}

/// 한 프롬프트에 실을 수 있는 앞선 판정의 최대 개수.
///
/// **유도한 값이 아니라 관례적 선택이다.** 실사용에서 세션당 판정이 몇 건이나 쌓이는지 아직
/// 모른다 — 그 분포가 보이면 다시 볼 것(27.5절).
pub const MAX_CARRIED_DECISIONS: usize = 10;

/// 이 세션의 **앞선** 태스크에서 사용자가 정한 것을 모은다. **아무것도 쓰지 않는다.**
///
/// `current_task_id`는 제외한다 — 이번 태스크의 판정은 이번 프롬프트가 이미 싣고 있고,
/// 두 자리에 같은 문장이 오면 모델이 그것을 두 개의 요구로 읽는다.
pub fn collect(store: &Store, session_id: &str, current_task_id: &str) -> Result<SessionMemory, String> {
    let rows = store
        .session_user_decisions(session_id, current_task_id)
        .map_err(|e| format!("세션 판정 조회 실패: {e}"))?;

    let considered_count = rows.len();
    let truncated = considered_count > MAX_CARRIED_DECISIONS;
    let decisions: Vec<CarriedDecision> = rows
        .into_iter()
        .take(MAX_CARRIED_DECISIONS)
        .map(|(task_id, text, decided_at)| CarriedDecision {
            task_id,
            text,
            decided_at,
        })
        .collect();

    Ok(SessionMemory {
        decisions,
        truncated,
        considered_count,
    })
}

impl SessionMemory {
    pub fn is_empty(&self) -> bool {
        self.decisions.is_empty()
    }

    /// 프롬프트에 실릴 문장. **권위를 함께 적는다** — 이게 없으면 모델은 이 목록을 참고
    /// 사항으로 읽고, 그러면 나른 의미가 없다.
    ///
    /// 잘렸으면 그 사실도 적는다. 적지 않으면 모델은 이 목록이 전부라고 보고, 목록에 없는
    /// 앞선 판정과 충돌하는 안을 자신 있게 낸다.
    pub fn render(&self) -> String {
        let mut lines = vec![
            "These were decided by the USER in EARLIER tasks of this session.".to_string(),
            "They are still in force. They are NOT this task's acceptance criteria —".to_string(),
            "do not treat them as things to verify; treat them as constraints already agreed.".to_string(),
        ];
        if self.truncated {
            lines.push(format!(
                "(NOTE: {} of {} earlier decisions are shown — older ones are omitted. Do not assume the omitted ones do not exist.)",
                self.decisions.len(),
                self.considered_count
            ));
        }
        for decision in &self.decisions {
            lines.push(format!("- {}", decision.text));
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::ArtifactStore;
    use serde_json::json;

    fn seeded() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(dir.path()).unwrap();
        let mut store = Store::open_in_memory(artifacts).unwrap();
        store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store.upsert_session("sess-2", "ws-1", None).unwrap();
        (dir, store)
    }

    /// 태스크 하나를 만들고 판정을 기록한다. `source`가 이 모듈의 판정 기준이다.
    fn task_with(store: &mut Store, session: &str, task_id: &str, criteria: serde_json::Value) {
        store
            .create_task(task_id, session, "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        store
            .append_event(task_id, "USER_DECISION_RECORDED", &json!({ "acceptanceCriteria": criteria }))
            .unwrap();
    }

    fn decision(text: &str) -> serde_json::Value {
        json!({ "criterionId": format!("c-{text}"), "text": text, "source": "user_decision", "decidedAt": "2026-01-01T00:00:00Z" })
    }

    fn proposal(text: &str) -> serde_json::Value {
        json!({ "criterionId": format!("p-{text}"), "text": text, "source": "draft_proposal", "decidedAt": "2026-01-01T00:00:00Z" })
    }

    #[test]
    fn an_earlier_user_decision_is_carried() {
        let (_d, mut store) = seeded();
        task_with(&mut store, "sess-1", "task-1", json!([decision("1페이지는 첫 항목부터")]));
        task_with(&mut store, "sess-1", "task-2", json!([]));

        let memory = collect(&store, "sess-1", "task-2").unwrap();
        assert_eq!(memory.decisions.len(), 1);
        assert_eq!(memory.decisions[0].text, "1페이지는 첫 항목부터");
        assert!(!memory.truncated);
    }

    /// **모델 제안은 나르지 않는다.** 나르면 사용자가 동의한 적 없는 문장이 다음 태스크에서
    /// "이미 정해진 것"이 된다 — 제안이 요구로 세탁되는 경로다(16.1절).
    #[test]
    fn a_model_proposal_is_not_carried_as_a_decision() {
        let (_d, mut store) = seeded();
        task_with(
            &mut store,
            "sess-1",
            "task-1",
            json!([decision("사용자가 정한 것"), proposal("모델이 낸 후보")]),
        );
        task_with(&mut store, "sess-1", "task-2", json!([]));

        let memory = collect(&store, "sess-1", "task-2").unwrap();
        let texts: Vec<&str> = memory.decisions.iter().map(|d| d.text.as_str()).collect();
        assert_eq!(texts, vec!["사용자가 정한 것"], "{texts:?}");
    }

    /// 다른 세션의 판정은 나르지 않는다 — 세션은 사용자가 "이 흐름"이라고 묶은 단위다.
    #[test]
    fn another_sessions_decision_does_not_leak_in() {
        let (_d, mut store) = seeded();
        task_with(&mut store, "sess-2", "other-1", json!([decision("다른 세션의 판정")]));
        task_with(&mut store, "sess-1", "task-1", json!([]));

        let memory = collect(&store, "sess-1", "task-1").unwrap();
        assert!(memory.decisions.is_empty(), "{:?}", memory.decisions);
    }

    /// **이번 태스크의 판정은 제외한다.** 이번 프롬프트가 이미 싣고 있으므로, 두 자리에 같은
    /// 문장이 오면 모델이 그것을 두 개의 요구로 읽는다.
    #[test]
    fn the_current_tasks_own_decisions_are_not_carried() {
        let (_d, mut store) = seeded();
        task_with(&mut store, "sess-1", "task-1", json!([decision("이번 태스크의 판정")]));

        let memory = collect(&store, "sess-1", "task-1").unwrap();
        assert!(memory.decisions.is_empty(), "{:?}", memory.decisions);
    }

    /// **상한이 있고, 잘렸다는 사실을 낸다.** 조용히 자르면 모델은 이 목록이 전부라고 보고
    /// 목록에 없는 앞선 판정과 충돌하는 안을 자신 있게 낸다.
    #[test]
    fn the_carried_list_is_bounded_and_says_so() {
        let (_d, mut store) = seeded();
        for i in 0..(MAX_CARRIED_DECISIONS + 3) {
            task_with(
                &mut store,
                "sess-1",
                &format!("task-{i}"),
                json!([decision(&format!("판정 {i}"))]),
            );
        }
        task_with(&mut store, "sess-1", "current", json!([]));

        let memory = collect(&store, "sess-1", "current").unwrap();
        assert_eq!(memory.decisions.len(), MAX_CARRIED_DECISIONS);
        assert!(memory.truncated);
        assert_eq!(memory.considered_count, MAX_CARRIED_DECISIONS + 3);
        // 잘린 사실이 **프롬프트 문장에** 들어간다 — 구조체 필드는 모델이 읽지 않는다.
        assert!(memory.render().contains("older ones are omitted"), "{}", memory.render());
    }

    /// 프롬프트 문장이 **권위와 성격**을 함께 말한다. 없으면 모델은 참고 사항으로 읽거나,
    /// 반대로 이번 태스크에서 검증해야 할 기준으로 읽는다.
    #[test]
    fn the_rendered_text_states_both_the_authority_and_the_limit() {
        let (_d, mut store) = seeded();
        task_with(&mut store, "sess-1", "task-1", json!([decision("x")]));
        task_with(&mut store, "sess-1", "task-2", json!([]));
        let rendered = collect(&store, "sess-1", "task-2").unwrap().render();
        assert!(rendered.contains("decided by the USER"), "{rendered}");
        assert!(rendered.contains("NOT this task's acceptance criteria"), "{rendered}");
    }

    #[test]
    fn an_empty_session_carries_nothing() {
        let (_d, mut store) = seeded();
        task_with(&mut store, "sess-1", "task-1", json!([]));
        let memory = collect(&store, "sess-1", "task-1").unwrap();
        assert!(memory.is_empty());
        assert_eq!(memory.considered_count, 0);
        assert!(!memory.truncated);
    }
}
