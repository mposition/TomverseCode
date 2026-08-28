//! 대기 중인 승인의 등록부 — **워크스페이스 단위로 묶는다.**
//!
//! process-architecture.md 11절(멀티 워크스페이스). 여러 워크스페이스를 오가는 기능을 만들기
//! 전에 먼저 닫아야 하는 구멍이 여기 있었다.
//!
//! # 무엇이 뚫려 있었나
//!
//! 승인 등록부는 `approvalId → 응답 채널` 하나짜리 맵이었고 워크스페이스를 몰랐다. 그리고
//! 워크스페이스를 전환할 때 이전 sidecar만 종료하고 **대기 중이던 승인은 그대로 뒀다.**
//! 그 승인은 타임아웃(10분)까지 살아 있으므로, 그 사이에
//!
//! - 화면이 들고 있던 낡은 모달에서 사용자가 "승인"을 누르면
//! - 응답이 이전 워크스페이스의 `TaskHost`로 전달되고
//! - 그 호스트의 Policy Gate는 **이전 워크스페이스 루트**로 판정하므로
//! - **사용자가 보고 있지 않은 저장소에서 명령이 돈다.**
//!
//! 승인 화면은 워크스페이스를 말하지도 않았다(`ApprovalRequest`에 필드가 없었다). 즉 사용자가
//! 알아챌 방법도 없었다. 워크스페이스가 하나뿐일 때는 드러나지 않는 종류의 결함이고, 그래서
//! 멀티 워크스페이스 설계의 **전제 조건**으로 먼저 닫는다.
//!
//! # 규칙
//!
//! 1. **응답은 활성 워크스페이스의 것만 받는다.** 다른 워크스페이스의 승인 id로 온 응답은
//!    거부한다 — 낡은 모달은 언제나 존재할 수 있고, 그때 승인이 통과하면 위의 일이 벌어진다.
//! 2. **전환 시 이전 워크스페이스의 대기 승인은 전부 거부로 정리한다.** 남겨두면 타임아웃까지
//!    창이 열려 있다. 거부가 기본인 이유는 승인 게이트웨이의 타임아웃과 같다 — "응답이 없으면
//!    허용"은 게이트의 의미를 무너뜨린다.
//! 3. **정리했다는 사실을 센다.** 조용히 지우면 그 워크스페이스의 태스크가 왜 거부로 끝났는지
//!    설명할 수 없다.
//!
//! # 왜 core에 있나
//!
//! 종전에는 이 등록부가 Tauri 껍데기 크레이트에 있었다. 그 크레이트는 GUI 라이브러리를 요구해
//! 개발 환경에서 **컴파일되지 않으므로**, 거기 있는 로직은 검증되지 않는다. 승인은 보안 로직이다.

use crate::host::ApprovalOutcome;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

struct Entry {
    /// 이 승인이 속한 워크스페이스 루트. **Policy Gate가 제한하는 그 루트다.**
    workspace_root: String,
    /// 등록 순서. **큐를 만들려면 순서가 있어야 한다** — `HashMap`의 순회 순서는 답이 아니다.
    seq: u64,
    /// 어느 Fleet 구성원의 요청인가(있으면). 화면이 "같은 argv, 다른 트리"를 구별하는 근거다.
    origin: Option<crate::types::ApprovalOrigin>,
    sender: Sender<ApprovalOutcome>,
}

/// 대기 중인 승인 하나의 요약 — **큐를 그리는 데 필요한 것만**.
///
/// 명령 내용(`items`)은 여기 없다. 큐는 "몇 개가 밀려 있고 각각 어느 트리의 것인가"를 말하는
/// 자리이고, 무엇을 승인하는가는 그 승인의 모달이 말한다.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub approval_id: String,
    pub workspace_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<crate::types::ApprovalOrigin>,
}

#[derive(Default)]
pub struct PendingApprovals {
    inner: Mutex<HashMap<String, Entry>>,
    next_seq: std::sync::atomic::AtomicU64,
}

/// 응답이 전달되지 못한 이유. **"찾을 수 없다"로 뭉치지 않는다** — 세 경우에 사용자가 알아야
/// 할 것이 다르다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RespondError {
    /// 그런 승인이 없다(이미 처리됐거나 시간이 초과됐다).
    Unknown,
    /// **다른 워크스페이스의 승인이다.** 낡은 모달에서 눌렀다는 뜻이다.
    WrongWorkspace { belongs_to: String },
    /// 승인은 있었는데 기다리던 쪽이 이미 사라졌다.
    Gone,
}

/// **문장이 아니라 코드와 파라미터로 화면에 간다**(ui-wireframes.md 6절).
///
/// 종전에는 `message()`가 한국어 문장을 돌려주고 그 문장이 그대로 화면에 떴다. 그러면 그
/// 문장은 카탈로그 밖에 남아 영원히 한국어다. `korean()`은 남지만 이제 **화면이 코드를 모를
/// 때의 대체 표시**이고, 로그용이다.
impl crate::uimsg::UserFacing for RespondError {
    fn code(&self) -> &'static str {
        match self {
            RespondError::Unknown => "approvalUnknown",
            RespondError::WrongWorkspace { .. } => "approvalWrongWorkspace",
            RespondError::Gone => "approvalGone",
        }
    }

    fn params(&self) -> serde_json::Value {
        match self {
            // 끼울 값이 없는 코드도 **빈 객체**를 준다 — `null`을 주면 화면이 `params.x`를
            // 읽다 터지고, 그 실패는 "문장이 안 뜬다"로만 보인다.
            RespondError::Unknown | RespondError::Gone => serde_json::json!({}),
            RespondError::WrongWorkspace { belongs_to } => serde_json::json!({ "belongsTo": belongs_to }),
        }
    }

    fn korean(&self) -> String {
        match self {
            RespondError::Unknown => {
                "해당 승인 요청을 찾을 수 없습니다 (이미 처리되었거나 시간이 초과되었습니다).".to_string()
            }
            RespondError::WrongWorkspace { belongs_to } => format!(
                "다른 워크스페이스({belongs_to})의 승인 요청입니다. 그 사이 워크스페이스가 바뀌었으므로 처리하지 않았습니다."
            ),
            RespondError::Gone => "승인 응답을 전달할 수 없습니다 (요청이 이미 종료되었습니다).".to_string(),
        }
    }
}

impl PendingApprovals {
    pub fn new() -> Self {
        Self::default()
    }

    /// 승인을 등록하고 응답을 받을 수신부를 준다.
    ///
    /// 같은 id가 이미 있으면 **덮어쓴다.** id는 UUID이므로 실제로는 일어나지 않지만, 만약
    /// 일어난다면 옛 항목을 남겨 두는 쪽이 더 나쁘다 — 응답이 어느 쪽으로 갈지 알 수 없어진다.
    pub fn register(&self, approval_id: &str, workspace_root: &str) -> Receiver<ApprovalOutcome> {
        self.register_with_origin(approval_id, workspace_root, None)
    }

    /// 출처를 함께 등록한다 — Fleet 구성원의 승인이면 **어느 구성원인지**가 여기 실린다.
    pub fn register_with_origin(
        &self,
        approval_id: &str,
        workspace_root: &str,
        origin: Option<crate::types::ApprovalOrigin>,
    ) -> Receiver<ApprovalOutcome> {
        let (tx, rx) = channel();
        let seq = self.next_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.lock().unwrap().insert(
            approval_id.to_string(),
            Entry {
                workspace_root: workspace_root.to_string(),
                seq,
                origin,
                sender: tx,
            },
        );
        rx
    }

    /// 지금 밀려 있는 승인들 — **등록 순서대로**.
    ///
    /// # 왜 이것이 동시 실행의 선행 조건인가 (process-architecture 11.6①)
    ///
    /// 종전에는 `len()`뿐이었다. 승인이 하나뿐일 때는 모달이 그것을 그리면 되므로 목록이
    /// 필요 없었지만, N개가 동시에 승인을 요구하면 화면은 **무엇이 밀려 있는지** 말할 수
    /// 있어야 한다. 개수만 아는 화면은 "3개 대기 중"이라고 쓰고 그중 하나만 보여주게 되고,
    /// 그러면 사용자는 자기가 지금 어느 트리의 명령을 승인하는지 알 수 없다.
    pub fn pending(&self) -> Vec<PendingApproval> {
        let guard = self.inner.lock().unwrap();
        let mut rows: Vec<(u64, PendingApproval)> = guard
            .iter()
            .map(|(id, e)| {
                (
                    e.seq,
                    PendingApproval {
                        approval_id: id.clone(),
                        workspace_root: e.workspace_root.clone(),
                        origin: e.origin.clone(),
                    },
                )
            })
            .collect();
        rows.sort_by_key(|(seq, _)| *seq);
        rows.into_iter().map(|(_, row)| row).collect()
    }

    /// 대기가 끝났다(응답을 받았든 타임아웃이든). 남겨두면 맵이 계속 자란다.
    pub fn forget(&self, approval_id: &str) {
        self.inner.lock().unwrap().remove(approval_id);
    }

    /// 사용자의 응답을 전달한다.
    ///
    /// `active_workspace_root`는 **지금 화면이 보고 있는 워크스페이스**다. 승인이 그것과 다른
    /// 워크스페이스의 것이면 전달하지 않는다 — 낡은 모달에서 누른 승인이 사용자가 보고 있지
    /// 않은 저장소에서 명령을 돌리는 것을 막는 유일한 지점이다.
    pub fn respond(
        &self,
        approval_id: &str,
        active_workspace_root: &str,
        outcome: ApprovalOutcome,
    ) -> Result<(), RespondError> {
        self.respond_in_scope(approval_id, &[active_workspace_root], outcome)
    }

    /// 사용자가 **지금 보고 있는 루트들** 중 하나에 속한 승인만 전달한다.
    ///
    /// # 왜 하나가 아니라 집합인가 (process-architecture 11.6①)
    ///
    /// Fleet은 한 저장소의 worktree 여러 개에서 동시에 돈다. 각 구성원의 게이트 루트는 서로
    /// 다른 경로이므로, "활성 루트 하나"로 판정하면 **자기 Fleet의 승인이 전부 거부된다.**
    ///
    /// 지키려는 불변식은 바뀌지 않는다: *응답은 사용자가 지금 보고 있는 것의 승인일 때만
    /// 전달된다.* 달라진 것은 "보고 있는 것"이 하나가 아닐 수 있다는 사실뿐이고, 그래서
    /// 규칙도 하나다 — 화면은 자기가 지금 붙어 있는 루트 전부를 넘긴다. 목록 밖의 승인은
    /// 종전과 똑같이 거부되고 **지워지지도 않는다.**
    pub fn respond_in_scope(
        &self,
        approval_id: &str,
        active_workspace_roots: &[&str],
        outcome: ApprovalOutcome,
    ) -> Result<(), RespondError> {
        let mut guard = self.inner.lock().unwrap();
        let Some(entry) = guard.get(approval_id) else {
            return Err(RespondError::Unknown);
        };
        if !active_workspace_roots.contains(&entry.workspace_root.as_str()) {
            // **지우지 않는다.** 이 승인은 여전히 자기 워크스페이스의 것이고, 여기서 지우면
            // 그 태스크는 응답도 거부도 못 받은 채 타임아웃까지 매달린다.
            return Err(RespondError::WrongWorkspace {
                belongs_to: entry.workspace_root.clone(),
            });
        }
        let entry = guard.remove(approval_id).expect("방금 확인했다");
        entry.sender.send(outcome).map_err(|_| RespondError::Gone)
    }

    /// 이 워크스페이스의 대기 승인을 **전부 거부로 정리한다.** 정리한 개수를 돌려준다.
    ///
    /// 워크스페이스를 떠날 때 부른다. 남겨두면 타임아웃까지 살아 있고, 그동안 낡은 모달로
    /// 승인이 들어올 창이 열려 있다.
    pub fn revoke_workspace(&self, workspace_root: &str, note: &str) -> usize {
        let mut guard = self.inner.lock().unwrap();
        let ids: Vec<String> = guard
            .iter()
            .filter(|(_, e)| e.workspace_root == workspace_root)
            .map(|(id, _)| id.clone())
            .collect();
        let mut revoked = 0;
        for id in ids {
            if let Some(entry) = guard.remove(&id) {
                // 보내기에 실패해도(기다리던 쪽이 이미 사라졌어도) 정리한 것으로 센다 —
                // 목적은 전달이 아니라 **그 승인이 더는 통과할 수 없게 하는 것**이다.
                let _ = entry.sender.send(ApprovalOutcome::Denied {
                    note: Some(note.to_string()),
                });
                revoked += 1;
            }
        }
        revoked
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uimsg::UserFacing;

    const A: &str = "/work/alpha";
    const B: &str = "/work/beta";

    fn origin(index: usize, branch: &str) -> crate::types::ApprovalOrigin {
        crate::types::ApprovalOrigin {
            fleet_id: "fleet-1".to_string(),
            member_index: index,
            fleet_size: 3,
            branch: branch.to_string(),
        }
    }

    /// **N개가 동시에 밀려 있을 수 있고, 큐가 그 사실을 말한다** (11.6①).
    ///
    /// 개수만 아는 화면은 "3개 대기 중"이라고 쓰고 하나만 보여준다 — 그러면 사용자는 자기가
    /// 어느 트리의 명령을 승인하는지 알 수 없다.
    #[test]
    fn the_queue_lists_every_waiting_approval_in_arrival_order() {
        let pending = PendingApprovals::new();
        let _a = pending.register_with_origin("ap-1", "/w/tomverse-feat-a", Some(origin(1, "feat-a")));
        let _b = pending.register_with_origin("ap-2", "/w/tomverse-feat-b", Some(origin(2, "feat-b")));
        let _c = pending.register_with_origin("ap-3", "/w/tomverse-feat-c", Some(origin(3, "feat-c")));

        let queue = pending.pending();
        assert_eq!(
            queue.iter().map(|p| p.approval_id.as_str()).collect::<Vec<_>>(),
            vec!["ap-1", "ap-2", "ap-3"],
            "도착 순서가 아니면 큐가 아니다"
        );
        // **어느 트리인지 화면이 말할 수 있다.** 경로만이 아니라 자리("2/3")까지 있다.
        let second = queue[1].origin.as_ref().expect("출처가 없습니다");
        assert_eq!((second.member_index, second.fleet_size), (2, 3));
        assert_eq!(second.branch, "feat-b");
        assert_ne!(queue[0].workspace_root, queue[1].workspace_root);
    }

    /// Fleet은 한 저장소의 worktree 여러 개에서 돈다 — **활성 루트가 하나가 아니다.**
    ///
    /// 루트 하나로 판정하면 자기 Fleet의 승인이 전부 거부된다.
    #[test]
    fn a_fleet_answers_approvals_for_every_tree_it_is_attending() {
        let pending = PendingApprovals::new();
        let rx_a = pending.register("ap-a", "/w/tomverse-feat-a");
        let rx_b = pending.register("ap-b", "/w/tomverse-feat-b");
        let scope = ["/w/tomverse-feat-a", "/w/tomverse-feat-b"];

        assert!(pending.respond_in_scope("ap-a", &scope, ApprovalOutcome::Granted).is_ok());
        assert!(pending.respond_in_scope("ap-b", &scope, ApprovalOutcome::Granted).is_ok());
        assert_eq!(rx_a.recv().unwrap(), ApprovalOutcome::Granted);
        assert_eq!(rx_b.recv().unwrap(), ApprovalOutcome::Granted);
    }

    /// **불변식은 넓어지지 않았다.** 목록 밖의 승인은 종전과 똑같이 거부되고 지워지지도 않는다.
    #[test]
    fn a_tree_outside_the_scope_is_still_refused() {
        let pending = PendingApprovals::new();
        let rx = pending.register("ap-x", "/w/other");
        let err = pending
            .respond_in_scope("ap-x", &["/w/tomverse-feat-a", "/w/tomverse-feat-b"], ApprovalOutcome::Granted)
            .unwrap_err();
        assert_eq!(
            err,
            RespondError::WrongWorkspace {
                belongs_to: "/w/other".to_string()
            }
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(pending.len(), 1, "남의 워크스페이스 승인을 지우면 그 태스크가 매달린다");
    }

    #[test]
    fn a_response_reaches_the_waiter() {
        let pending = PendingApprovals::new();
        let rx = pending.register("ap-1", A);
        assert!(pending.respond("ap-1", A, ApprovalOutcome::Granted).is_ok());
        assert_eq!(rx.recv().unwrap(), ApprovalOutcome::Granted);
        // 전달한 뒤에는 남지 않는다 — 남으면 같은 승인이 두 번 처리될 수 있다.
        assert!(pending.is_empty());
    }

    /// **다른 워크스페이스의 승인은 통과하지 못한다.** 이걸 막지 않으면 낡은 모달에서 누른
    /// 승인이 사용자가 보고 있지 않은 저장소에서 명령을 돌린다.
    #[test]
    fn a_stale_modal_cannot_approve_into_another_workspace() {
        let pending = PendingApprovals::new();
        let rx = pending.register("ap-1", A);

        let err = pending.respond("ap-1", B, ApprovalOutcome::Granted).unwrap_err();
        assert_eq!(
            err,
            RespondError::WrongWorkspace {
                belongs_to: A.to_string()
            }
        );
        // 워크스페이스는 **파라미터로** 온다 — 문장에 이어 붙이면 번역할 수 없다.
        assert_eq!(err.params()["belongsTo"], serde_json::json!(A));
        assert!(err.korean().contains(A), "{}", err.korean());

        // **아무것도 전달되지 않았다.**
        assert!(rx.try_recv().is_err(), "다른 워크스페이스의 승인이 전달됐습니다");
        // 그리고 지워지지도 않았다 — 여전히 자기 워크스페이스의 것이다.
        assert_eq!(pending.len(), 1);
        assert!(pending.respond("ap-1", A, ApprovalOutcome::Granted).is_ok());
    }

    /// 워크스페이스를 떠나면 그 워크스페이스의 대기 승인은 **거부로 정리된다.**
    /// 남겨두면 타임아웃(10분)까지 위의 창이 열려 있다.
    #[test]
    fn leaving_a_workspace_denies_its_pending_approvals() {
        let pending = PendingApprovals::new();
        let rx = pending.register("ap-1", A);

        assert_eq!(pending.revoke_workspace(A, "워크스페이스가 바뀌었습니다"), 1);
        match rx.recv().unwrap() {
            ApprovalOutcome::Denied { note } => {
                assert!(note.unwrap().contains("바뀌었습니다"));
            }
            other => panic!("거부가 아닙니다: {other:?}"),
        }
        assert!(pending.is_empty());
        // 정리된 뒤에는 승인할 수 없다.
        assert_eq!(
            pending.respond("ap-1", A, ApprovalOutcome::Granted).unwrap_err(),
            RespondError::Unknown
        );
    }

    /// 정리는 **떠나는 워크스페이스의 것만** 건드린다. 전부 지우면 다른 워크스페이스에서
    /// 진행 중이던 태스크가 이유 없이 거부된다.
    #[test]
    fn revoking_one_workspace_leaves_the_others_alone() {
        let pending = PendingApprovals::new();
        let rx_a = pending.register("ap-a", A);
        let rx_b = pending.register("ap-b", B);

        assert_eq!(pending.revoke_workspace(A, "전환"), 1);
        assert!(matches!(rx_a.recv().unwrap(), ApprovalOutcome::Denied { .. }));
        assert!(rx_b.try_recv().is_err(), "다른 워크스페이스의 승인이 정리됐습니다");
        assert_eq!(pending.len(), 1);
    }

    /// 정리할 것이 없으면 0을 돌려준다 — **0과 "정리했다"를 구별해야** 화면이
    /// 필요 없는 안내를 띄우지 않는다.
    #[test]
    fn revoking_with_nothing_pending_reports_zero() {
        let pending = PendingApprovals::new();
        assert_eq!(pending.revoke_workspace(A, "전환"), 0);
    }

    /// 기다리던 쪽이 이미 사라져도 **정리한 것으로 센다.** 목적은 전달이 아니라 그 승인이
    /// 더는 통과할 수 없게 하는 것이다.
    #[test]
    fn a_dropped_waiter_still_counts_as_revoked() {
        let pending = PendingApprovals::new();
        drop(pending.register("ap-1", A));
        assert_eq!(pending.revoke_workspace(A, "전환"), 1);
        assert!(pending.is_empty());
    }

    /// 없는 승인과 사라진 승인은 다른 사실이다 — 한 값으로 합치면 사용자가 무엇을
    /// 잘못했는지(혹은 잘못한 것이 없는지) 알 수 없다.
    #[test]
    fn unknown_and_gone_are_different_facts() {
        let pending = PendingApprovals::new();
        assert_eq!(
            pending.respond("없는-id", A, ApprovalOutcome::Granted).unwrap_err(),
            RespondError::Unknown
        );

        drop(pending.register("ap-1", A));
        assert_eq!(
            pending.respond("ap-1", A, ApprovalOutcome::Granted).unwrap_err(),
            RespondError::Gone
        );
        // 전달에 실패했어도 항목은 정리된다 — 남겨두면 영원히 실패하는 id가 쌓인다.
        assert!(pending.is_empty());
    }

    /// **코드가 서로 달라야** 화면이 문장을 고를 수 있고, **파라미터가 객체여야** 화면이
    /// 값을 읽다 터지지 않는다(끼울 값이 없으면 빈 객체다).
    #[test]
    fn every_respond_error_has_its_own_code_and_object_params() {
        let errors = [
            RespondError::Unknown,
            RespondError::WrongWorkspace {
                belongs_to: A.to_string(),
            },
            RespondError::Gone,
        ];
        let codes: std::collections::BTreeSet<&str> = errors.iter().map(|e| e.code()).collect();
        assert_eq!(codes.len(), errors.len(), "코드가 겹칩니다: {codes:?}");
        for error in &errors {
            assert!(
                error.params().is_object(),
                "{}의 파라미터가 객체가 아닙니다",
                error.code()
            );
            assert!(!error.korean().is_empty());
        }
    }

    /// `forget`은 대기가 끝났을 때(타임아웃 포함) 부른다. 부르지 않으면 맵이 계속 자란다.
    #[test]
    fn forgetting_removes_the_entry() {
        let pending = PendingApprovals::new();
        let _rx = pending.register("ap-1", A);
        pending.forget("ap-1");
        assert!(pending.is_empty());
    }
}
