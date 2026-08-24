//! 판정의 철회 — 나른 판정을 사용자가 **거두는** 길 (state-machine 30절).
//!
//! # 무엇이 없었는가
//!
//! 27절이 세션 메모리를 만들면서 남긴 두 미해결 중 하나가 "판정 사이의 충돌"이었다. 앞선
//! 판정과 이번 요청이 부딪히면 지금은 둘 다 프롬프트에 실리고, 누가 이기는지 정해져 있지 않다.
//!
//! 그때 문서는 "정하려면 사용자가 마음을 바꾼 것인지 잊은 것인지 구별해야 한다"고 적었다.
//! 그 문장은 맞지만 **막힌 곳을 잘못 짚었다.** 구별이 없어서 막힌 것이 아니라, 구별한 뒤에
//! 사용자가 **할 수 있는 일이 없어서** 막혀 있었다 — 마음이 바뀌었다는 걸 알아도 앞선 판정을
//! 거둘 방법이 없었다. 이 모듈이 그 레버를 만든다.
//!
//! # 우리는 충돌을 판정하지 않는다
//!
//! 모델에게 "이 둘이 충돌하는가"를 물어 자동으로 거두게 만들 수도 있었다. 만들지 않았다.
//! 그 대답은 또 하나의 **모델 의견**이고, 그것으로 사용자 판정을 지우면 16절의 관할이 뒤집힌다 —
//! 요구에 대한 권위는 사용자에게 있고, 모델은 어느 쪽도 판정하지 않는다.
//!
//! 그래서 이 모듈에는 감지가 없다. 목록을 보여주고, 거두는 것은 사람이 누른다.
//!
//! # 철회는 삭제가 아니다
//!
//! 거둬도 `task_events`의 `USER_DECISION_RECORDED`는 그대로 있고, 그 태스크의
//! `acceptance_criteria` 행도 그대로 있다. 더해지는 것은 **"이후 거뒀다"는 나중의 사실**뿐이다.
//!
//! 이게 중요한 이유: 그 태스크는 그 기준으로 판정됐다. 행을 지우면 끝난 태스크의 최종 보고가
//! 소급해서 바뀌고, 감사 기록이 "그때 무엇을 기준으로 삼았는가"에 답하지 못하게 된다.
//! **철회가 바꾸는 것은 오직 하나 — 다음 태스크로 나르는가다.**
//!
//! # 열쇠는 `(taskId, criterionId)`다
//!
//! `acceptance_criteria`의 기본 키가 `(task_id, criterion_id)`이므로 `criterionId` 하나는
//! 세션 안에서 유일하지 않다. 그것만으로 가리키면 두 태스크가 같은 id를 쓸 때 **엉뚱한 판정을
//! 거둔다** — 거두는 동작은 되돌리는 경로가 없으므로 잘못 가리키는 것이 특히 나쁘다.

use crate::store::Store;
use serde::Serialize;

/// 거둘 수 없는 이유. **"안 된다"만 말하지 않는다** — 사용자가 다음에 할 일이 이유마다 다르다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// 그런 판정이 이 세션에 없다.
    NotFound,
    /// 이미 거둔 판정이다.
    AlreadyWithdrawn,
    /// 소유 태스크가 아직 진행 중이다.
    TaskStillRunning,
}

impl Refusal {
    pub fn message(self) -> &'static str {
        match self {
            Refusal::NotFound => "이 세션에 그런 사용자 판정이 없습니다",
            Refusal::AlreadyWithdrawn => "이미 거둔 판정입니다",
            // 진행 중인 태스크의 기준을 중간에 빼면, **그 태스크가 무엇으로 판정되는지가
            // 실행 도중 바뀐다.** 이번 태스크의 기준을 고치는 길은 철회가 아니라 재질문이다.
            Refusal::TaskStillRunning => "이 판정을 만든 태스크가 아직 진행 중입니다 — 끝난 뒤에 거둘 수 있습니다",
        }
    }
}

/// 화면과 CLI가 보는 판정 하나. **거둔 것도 목록에 남는다**(모듈 주석).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DecisionItem {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "criterionId")]
    pub criterion_id: String,
    pub text: String,
    #[serde(rename = "decidedAt")]
    pub decided_at: String,
    #[serde(rename = "withdrawnAt", skip_serializing_if = "Option::is_none")]
    pub withdrawn_at: Option<String>,
    /// 지금 이 판정이 다음 태스크로 나르는가. `withdrawn_at`에서 유도하지만 **따로 낸다** —
    /// 화면이 "언제 거뒀는가"와 "지금 나르는가"를 각각 물을 수 있어야 한다.
    #[serde(rename = "inForce")]
    pub in_force: bool,
    /// 지금 거둘 수 있는가.
    pub withdrawable: bool,
    /// 거둘 수 없다면 왜인가.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<Refusal>,
}

/// 이 세션에서 사용자가 정한 것 전부를 목록으로 낸다. **아무것도 쓰지 않는다.**
pub fn list(store: &Store, session_id: &str) -> Result<Vec<DecisionItem>, String> {
    let rows = store
        .session_decision_rows(session_id)
        .map_err(|e| format!("세션 판정 조회 실패: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let running = row.task_final_status.is_none();
            let refusal = if row.withdrawn_at.is_some() {
                Some(Refusal::AlreadyWithdrawn)
            } else if running {
                Some(Refusal::TaskStillRunning)
            } else {
                None
            };
            DecisionItem {
                in_force: row.withdrawn_at.is_none(),
                withdrawable: refusal.is_none(),
                refusal,
                task_id: row.task_id,
                criterion_id: row.criterion_id,
                text: row.text,
                decided_at: row.decided_at,
                withdrawn_at: row.withdrawn_at,
            }
        })
        .collect())
}

/// 이 판정을 지금 거둘 수 있는가. 거둘 수 있으면 `Ok(())`.
///
/// **거두는 동작과 나눠 둔다** — 화면은 버튼을 그리기 전에 물어야 하고, 호스트는 이벤트를
/// 남기기 전에 물어야 한다. 두 자리가 각자 판단하면 화면이 허용한 것을 호스트가 거절한다.
pub fn check(store: &Store, session_id: &str, task_id: &str, criterion_id: &str) -> Result<(), Refusal> {
    let rows = list(store, session_id).map_err(|_| Refusal::NotFound)?;
    let Some(item) = rows
        .iter()
        .find(|i| i.task_id == task_id && i.criterion_id == criterion_id)
    else {
        return Err(Refusal::NotFound);
    };
    match item.refusal {
        Some(refusal) => Err(refusal),
        None => Ok(()),
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
        (dir, store)
    }

    fn decided(store: &mut Store, task_id: &str, criterion_id: &str, text: &str) {
        store
            .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        store
            .append_event(
                task_id,
                "USER_DECISION_RECORDED",
                &json!({ "acceptanceCriteria": [{
                    "criterionId": criterion_id,
                    "text": text,
                    "source": "user_decision",
                    "decidedAt": "2026-01-01T00:00:00Z",
                }] }),
            )
            .unwrap();
    }

    fn finish(store: &mut Store, task_id: &str) {
        store
            .append_event(task_id, "PHASE_CHANGED", &json!({ "to": "COMPLETED" }))
            .unwrap();
    }

    fn withdraw(store: &mut Store, task_id: &str, criterion_id: &str) {
        store
            .append_event(
                task_id,
                "USER_DECISION_WITHDRAWN",
                &json!({
                    "criterionId": criterion_id,
                    "withdrawnAt": "2026-02-02T00:00:00Z",
                    "acceptanceCriteriaWithdrawn": [criterion_id],
                }),
            )
            .unwrap();
    }

    #[test]
    fn a_finished_tasks_decision_can_be_withdrawn() {
        let (_d, mut store) = seeded();
        decided(&mut store, "task-1", "c-1", "1페이지는 첫 항목부터");
        finish(&mut store, "task-1");

        let items = list(&store, "sess-1").unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].withdrawable, "{items:?}");
        assert!(items[0].in_force);
        assert_eq!(check(&store, "sess-1", "task-1", "c-1"), Ok(()));
    }

    /// **진행 중인 태스크의 기준은 거둘 수 없다.** 중간에 빼면 그 태스크가 무엇으로
    /// 판정되는지가 실행 도중 바뀐다 — 이번 태스크의 기준을 고치는 길은 재질문이다.
    #[test]
    fn a_running_tasks_decision_cannot_be_withdrawn() {
        let (_d, mut store) = seeded();
        decided(&mut store, "task-1", "c-1", "진행 중");

        let items = list(&store, "sess-1").unwrap();
        assert!(!items[0].withdrawable);
        assert_eq!(items[0].refusal, Some(Refusal::TaskStillRunning));
        assert_eq!(check(&store, "sess-1", "task-1", "c-1"), Err(Refusal::TaskStillRunning));
    }

    /// 거둔 판정은 **목록에 남는다.** 목록에서까지 지우면 "사라졌다"와 "거뒀다"가 화면에서
    /// 같은 모양이 되고, 사용자는 자기가 무엇을 거뒀는지 확인할 수 없다.
    #[test]
    fn a_withdrawn_decision_stays_in_the_list_but_is_no_longer_in_force() {
        let (_d, mut store) = seeded();
        decided(&mut store, "task-1", "c-1", "거둘 것");
        finish(&mut store, "task-1");
        withdraw(&mut store, "task-1", "c-1");

        let items = list(&store, "sess-1").unwrap();
        assert_eq!(items.len(), 1, "{items:?}");
        assert!(!items[0].in_force);
        assert_eq!(items[0].withdrawn_at.as_deref(), Some("2026-02-02T00:00:00Z"));
        assert_eq!(check(&store, "sess-1", "task-1", "c-1"), Err(Refusal::AlreadyWithdrawn));
    }

    /// **거둔 판정은 다음 태스크로 나르지 않는다.** 이 단언이 이 기능의 전부다 — 나머지는
    /// 그 사실을 사람이 볼 수 있게 만드는 배관이다.
    #[test]
    fn a_withdrawn_decision_is_not_carried_to_the_next_task() {
        let (_d, mut store) = seeded();
        decided(&mut store, "task-1", "c-1", "거둘 것");
        decided(&mut store, "task-2", "c-2", "남을 것");
        finish(&mut store, "task-1");

        let before = crate::session_memory::collect(&store, "sess-1", "task-9").unwrap();
        assert_eq!(before.decisions.len(), 2, "{:?}", before.decisions);

        withdraw(&mut store, "task-1", "c-1");

        let after = crate::session_memory::collect(&store, "sess-1", "task-9").unwrap();
        let texts: Vec<&str> = after.decisions.iter().map(|d| d.text.as_str()).collect();
        assert_eq!(texts, vec!["남을 것"], "{texts:?}");
        // 상한 계산도 거둔 것을 세지 않는다 — 세면 "잘렸다"가 거짓이 된다.
        assert_eq!(after.considered_count, 1);
    }

    /// **거둬도 그 태스크의 기준 기록은 남는다.** 지우면 끝난 태스크의 최종 보고가 소급해서
    /// 바뀌고, 감사 기록이 "그때 무엇을 기준으로 삼았는가"에 답하지 못한다.
    #[test]
    fn withdrawing_does_not_rewrite_the_owning_tasks_record() {
        let (_d, mut store) = seeded();
        decided(&mut store, "task-1", "c-1", "거둘 것");
        finish(&mut store, "task-1");
        withdraw(&mut store, "task-1", "c-1");

        let rows = store.acceptance_criteria("task-1").unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].text, "거둘 것");
        assert_eq!(rows[0].withdrawn_at.as_deref(), Some("2026-02-02T00:00:00Z"));
    }

    /// 열쇠는 `(taskId, criterionId)`다. `criterionId`만으로 가리키면 두 태스크가 같은 id를
    /// 쓸 때 엉뚱한 판정을 거둔다 — 되돌리는 경로가 없으므로 특히 나쁘다.
    #[test]
    fn the_same_criterion_id_in_two_tasks_is_two_different_decisions() {
        let (_d, mut store) = seeded();
        decided(&mut store, "task-1", "c-1", "첫 번째");
        decided(&mut store, "task-2", "c-1", "두 번째");
        finish(&mut store, "task-1");
        finish(&mut store, "task-2");
        withdraw(&mut store, "task-1", "c-1");

        let items = list(&store, "sess-1").unwrap();
        let second = items
            .iter()
            .find(|i| i.task_id == "task-2")
            .expect("두 번째 판정이 목록에 없습니다");
        assert!(second.in_force, "다른 태스크의 같은 id가 함께 거둬졌습니다");
    }

    /// 모델 제안은 애초에 이 목록에 없다 — 나르지 않으므로 거둘 대상도 아니다.
    #[test]
    fn a_model_proposal_is_not_listed() {
        let (_d, mut store) = seeded();
        store
            .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
            .unwrap();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({ "acceptanceCriteria": [{
                    "criterionId": "p-1", "text": "모델 후보", "source": "draft_proposal",
                    "decidedAt": "2026-01-01T00:00:00Z",
                }] }),
            )
            .unwrap();

        assert!(list(&store, "sess-1").unwrap().is_empty());
        assert_eq!(check(&store, "sess-1", "task-1", "p-1"), Err(Refusal::NotFound));
    }
}
