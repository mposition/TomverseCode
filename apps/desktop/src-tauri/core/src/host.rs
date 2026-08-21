//! TaskHost — 신뢰 경계의 조립점.
//!
//! Node sidecar가 보내는 모든 요청이 여기를 지난다. 순서가 불변식이다:
//!
//!   ToolRequest 수신 → Policy Gate 평가 → (필요시) 사용자 승인 대기 → Tool Runtime 실행
//!                   → 이벤트 로그 기록 → 결과 반환
//!
//! 어느 단계도 건너뛸 수 없다. 특히 승인 왕복은 Node를 거치지 않고 Rust가 직접 UI와 주고받는다
//! (process-architecture.md 4절 — 승인은 정책 판단의 연장이므로 Rust 책임 소관).

use crate::artifacts::ArtifactStore;
use crate::cancel::{CancelOutcome, CancellationRegistry, CancellationToken};
use crate::paths::WorkspaceRoot;
use crate::policy::{parse_run_command, secrets, PolicyGate};
use crate::sidecar::SidecarHandler;
use crate::store::{AppendedEvent, Store, StoreError, TerminalOutcome};
use crate::time::now_iso;
use crate::tools::{ToolRuntime, MAX_INLINE_OUTPUT_BYTES};
use crate::types::{
    ApprovalRequest, ApprovalRequestItem, PolicyDecision, RiskTier, TaskPolicy, ToolName, ToolRequest, ToolResult,
    ToolStatus, VerificationPhase, VerificationReport,
};
use crate::verify::{CommandExecutor, VerificationRunner};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 사용자 승인을 구하는 방법. Tauri는 UI로 emit하고 응답을 기다리며, 헤드리스 호스트/테스트는
/// 정책적으로 자동 승인/거부한다.
///
/// trait으로 둔 이유: "테스트에서 자동 승인"이 프로덕션 코드 경로에 `if cfg!(test)` 같은
/// 분기로 새어들지 않게 하려는 것이다.
pub trait ApprovalGateway: Send + Sync {
    fn request_approval(&self, request: &ApprovalRequest) -> ApprovalOutcome;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Granted,
    Denied { note: Option<String> },
}

/// 모든 승인을 허용. **테스트와 명시적 자동 모드 전용.**
pub struct AutoApprove;
impl ApprovalGateway for AutoApprove {
    fn request_approval(&self, _request: &ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Granted
    }
}

/// 모든 승인을 거부 — "승인 거부" 경로 테스트와 읽기 전용 모드에 쓴다.
pub struct AlwaysDeny;
impl ApprovalGateway for AlwaysDeny {
    fn request_approval(&self, _request: &ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Denied {
            note: Some("자동 거부 정책".to_string()),
        }
    }
}

/// UI로 이벤트를 내보내는 통로 (Tauri emit 또는 헤드리스 로거).
pub trait EventSink: Send + Sync {
    fn emit(&self, channel: &str, payload: &Value);
}

pub struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _channel: &str, _payload: &Value) {}
}

pub struct TaskHost {
    root: WorkspaceRoot,
    policy: TaskPolicy,
    gate: PolicyGate,
    runtime: ToolRuntime,
    /// 저장 계층은 **공유**한다. Tauri가 활성 워크스페이스 없이도 작업 목록을 조회해야 하고
    /// (앱 재시작 직후), 여러 컴포넌트가 각자 Store를 열면 SQLite 단일 writer 원칙이 깨진다.
    store: Arc<Mutex<Store>>,
    artifacts: ArtifactStore,
    approvals: Arc<dyn ApprovalGateway>,
    sink: Arc<dyn EventSink>,
    /// task_id별 취소 신호. M0에서는 호스트당 플래그 하나였으나, 작업 목록/재실행이 생기면서
    /// "어느 태스크를 취소하는가"를 구별해야 한다.
    cancels: Arc<CancellationRegistry>,
    /// baseline 검증 리포트 — post 리포트가 "새로 깨진 것"을 계산할 때 쓴다.
    baseline: Mutex<Option<VerificationReport>>,
    /// 이번 태스크에서 마지막으로 만들어진 diff 모음 (UI 표시용)
    diffs: Mutex<Vec<(String, String)>>,
}

impl TaskHost {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root: WorkspaceRoot,
        policy: TaskPolicy,
        store: Arc<Mutex<Store>>,
        artifacts: ArtifactStore,
        approvals: Arc<dyn ApprovalGateway>,
        sink: Arc<dyn EventSink>,
        cancels: Arc<CancellationRegistry>,
    ) -> Self {
        let gate = PolicyGate::new(&policy);
        let runtime = ToolRuntime::new(
            root.clone(),
            artifacts.clone(),
            Duration::from_millis(policy.command_timeout_ms),
        );
        Self {
            root,
            policy,
            gate,
            runtime,
            store,
            artifacts,
            approvals,
            sink,
            cancels,
            baseline: Mutex::new(None),
            diffs: Mutex::new(Vec::new()),
        }
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    pub fn policy(&self) -> &TaskPolicy {
        &self.policy
    }

    /// 태스크 취소 요청. **idempotent**하며, 터미널 상태를 바꾸지 않는다.
    ///
    /// 순서가 중요하다: 먼저 DB에서 터미널 여부를 읽고, 터미널이 아닐 때만 토큰을 켠다.
    /// 반대로 하면 완료된 태스크의 취소 플래그가 켜져 이후 롤백 같은 정당한 도구 실행이 막힌다.
    pub fn cancel_task(&self, task_id: &str) -> Result<Value, String> {
        let terminal = self
            .with_store(|s| s.get_task(task_id))
            .map_err(|e| format!("태스크를 조회할 수 없습니다: {e}"))?
            .and_then(|t| t.terminal_status);

        let outcome = self.cancels.request(task_id, terminal.clone());

        // 취소가 새로 확정된 경우에만 이벤트를 남긴다 (연타가 로그를 채우지 않게).
        if let CancelOutcome::Requested { .. } = &outcome {
            match self.with_store(|s| s.record_cancellation_request(task_id, "사용자 요청")) {
                Ok(_) => {}
                // DB가 터미널이라고 하면 그쪽이 진실이다 — 메모리 토큰보다 DB를 믿는다.
                Err(StoreError::TerminalAlreadySet { status }) => {
                    return Ok(json!({ "accepted": true, "outcome": "already_terminal", "status": status }));
                }
                Err(e) => return Err(format!("취소 요청을 기록할 수 없습니다: {e}")),
            }
        }

        Ok(match outcome {
            CancelOutcome::Requested { requested_at } => {
                json!({ "accepted": true, "outcome": "requested", "requestedAt": requested_at })
            }
            CancelOutcome::AlreadyRequested { requested_at } => {
                json!({ "accepted": true, "outcome": "already_requested", "requestedAt": requested_at })
            }
            CancelOutcome::AlreadyTerminal { status } => {
                json!({ "accepted": true, "outcome": "already_terminal", "status": status })
            }
            CancelOutcome::UnknownTask => json!({ "accepted": false, "outcome": "unknown_task" }),
        })
    }

    /// **강제 포기** — 사용자가 "취소 중"에서 기다리기를 그만둔다 (12절 미해결 항목).
    ///
    /// # 왜 필요한가
    ///
    /// 취소는 즉시 끝나지 않는다. 보통은 몇 백 ms지만, `REAP_TIMEOUT`을 넘겨도 죽지 않는
    /// 프로세스가 있거나 sidecar가 응답하지 않으면 태스크가 터미널에 도달하지 못한다. 그러면
    /// 화면은 영원히 "취소 중"이고, 사용자에게는 앱이 멈춘 것과 구별되지 않는다.
    ///
    /// # 무엇을 하고 무엇을 하지 않는가
    ///
    /// 하는 일: 태스크를 **CANCELLED로 확정**해 사용자를 놓아준다. `finish_task`의 원자적 경로를
    /// 그대로 쓰므로 나중에 sidecar가 자기 terminal을 보고해도 이미 확정된 쪽이 남는다.
    ///
    /// 하지 않는 일: **프로세스를 죽이지 않는다.** 죽일 수 있었으면 이 함수가 필요하지 않았다.
    /// 그래서 "정리됐다"고 말하지 않고 `forceAbandoned`와 함께 그 사실을 기록한다 —
    /// 남은 프로세스가 있을 수 있다는 것이 이 경로의 **정의**이지 예외가 아니다.
    pub fn force_abandon(&self, task_id: &str) -> Result<Value, String> {
        let outcome = self.finish_task(
            task_id,
            "CANCELLED",
            "TASK_CANCELLED",
            None,
            json!({
                "status": "cancelled",
                "summary": "사용자가 강제 포기했습니다. 취소 요청은 보냈지만 정리 완료를 확인하지 못했으므로                             실행 중이던 프로세스가 남아 있을 수 있습니다.",
                "source": "force-abandon",
                "forceAbandoned": true,
            }),
        )?;

        Ok(match outcome {
            TerminalOutcome::Recorded { status, .. } => {
                json!({ "abandoned": true, "status": status })
            }
            // 기다리는 사이에 정상적으로 끝난 경우다. 이건 실패가 아니라 **좋은 소식**이므로
            // 오류로 만들지 않는다 — 다만 무엇으로 끝났는지는 알려준다.
            TerminalOutcome::AlreadyTerminal { status } => {
                json!({ "abandoned": false, "status": status, "reason": "이미 종료된 태스크입니다" })
            }
        })
    }

    pub fn cancellation_token(&self, task_id: &str) -> CancellationToken {
        self.cancels.token(task_id)
    }

    pub fn is_cancelled(&self, task_id: &str) -> bool {
        self.cancels
            .existing(task_id)
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }

    /// 태스크가 터미널에 도달했을 때 토큰을 정리한다.
    pub fn release_task(&self, task_id: &str) {
        self.cancels.remove(task_id);
    }

    pub fn cancels(&self) -> Arc<CancellationRegistry> {
        self.cancels.clone()
    }

    pub fn store_handle(&self) -> Arc<Mutex<Store>> {
        self.store.clone()
    }

    pub fn collected_diffs(&self) -> Vec<(String, String)> {
        self.diffs.lock().unwrap().clone()
    }

    pub fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> T) -> T {
        let mut guard = self.store.lock().unwrap();
        f(&mut guard)
    }

    /// 터미널 상태 확정 + 이벤트를 한 트랜잭션에. 경쟁에서 진 쪽은 아무것도 바꾸지 않는다.
    pub fn finish_task(
        &self,
        task_id: &str,
        terminal_status: &str,
        event_type: &str,
        error_summary: Option<&str>,
        payload: Value,
    ) -> Result<TerminalOutcome, String> {
        let outcome = self
            .with_store(|s| s.finish_task(task_id, terminal_status, event_type, error_summary, &payload))
            .map_err(|e| format!("터미널 상태 기록 실패: {e}"))?;
        if let TerminalOutcome::Recorded { .. } = &outcome {
            self.sink.emit(
                "task-event",
                &json!({ "taskId": task_id, "type": event_type, "payload": payload, "createdAt": now_iso() }),
            );
            // 터미널에 도달했으므로 취소 토큰을 정리한다.
            self.release_task(task_id);
        }
        Ok(outcome)
    }

    /// **이미 DB에 커밋된** 이벤트를 UI로 릴레이한다.
    ///
    /// `record_*_with_event` 계열은 레코드와 이벤트를 한 트랜잭션에 쓰기 위해 `append_event`를
    /// 거치지 않는다. 그러면 sink 릴레이가 빠지므로 UI에서 `FILE_MUTATED` 같은 이벤트가
    /// 사라진다 — DB에는 남는데 화면에는 안 보이는, 발견하기 어려운 종류의 누락이다.
    /// 커밋이 끝난 뒤 이 함수로 명시적으로 릴레이한다(커밋 실패 시에는 호출되지 않는다).
    fn relay(&self, task_id: &str, event_type: &str, payload: &Value, appended: &AppendedEvent) {
        self.sink.emit(
            "task-event",
            &json!({
                "taskId": task_id,
                "eventId": appended.event_id,
                "seq": appended.seq,
                "type": event_type,
                "payload": payload,
                "createdAt": now_iso(),
            }),
        );
    }

    /// 이벤트 로그 기록 + UI 릴레이. 이벤트 없이 상태가 바뀌지 않도록 모든 상태 변화가 이걸 지난다.
    pub fn append_event(&self, task_id: &str, event_type: &str, payload: Value) -> Result<Value, String> {
        // 사용자 판정 원문은 저장 **전에** Rust가 가린다. Node가 스스로 가리게 두면
        // 장악당한 Node에서 그 규칙이 사라진다(process-architecture.md 2절).
        let payload = redact_user_decision(event_type, payload);
        let appended = self
            .with_store(|s| s.append_event(task_id, event_type, &payload))
            .map_err(|e| format!("이벤트 기록 실패: {e}"))?;
        self.sink.emit(
            "task-event",
            &json!({
                "taskId": task_id,
                "eventId": appended.event_id,
                "seq": appended.seq,
                "type": event_type,
                "payload": payload,
                "createdAt": now_iso(),
            }),
        );
        Ok(json!({ "eventId": appended.event_id, "seq": appended.seq }))
    }

    /// ToolRequest 하나를 끝까지 처리한다. 이 함수가 신뢰 경계의 핵심 경로다.
    pub fn execute_tool(&self, request: &ToolRequest) -> Result<Value, String> {
        let cancel = self.cancels.token(&request.task_id);

        // 0) 취소 확인. 취소된 태스크의 도구는 **시작하지 않는다.**
        //    `denied`가 아니라 `cancelled`로 보고해야 오케스트레이터가 정책 거부와 구별한다.
        if cancel.is_cancelled() {
            let result = ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Cancelled,
                output: None,
                error: Some("태스크가 취소되어 도구를 실행하지 않음".to_string()),
                duration_ms: 0,
                completed_at: now_iso(),
            };
            // 취소 후 거부도 감사 로그에 남는다 — "취소했는데 뭐가 더 실행됐나"를 확인할 수 있어야 한다.
            let _ = self.append_event(
                &request.task_id,
                "TOOL_SKIPPED_CANCELLED",
                json!({ "requestId": request.request_id, "tool": request.tool.as_str() }),
            );
            return Ok(json!({
                "result": result,
                "policy": {
                    "decision": "deny", "riskLevel": "none",
                    "reason": "태스크가 취소됨", "matchedRule": "cancelled", "normalizedTarget": ""
                }
            }));
        }

        // 1) Policy Gate. Node가 보낸 riskTier는 여기서 판단 근거로 쓰이지 않는다.
        let decision = self.gate.evaluate(request, &self.root, &self.policy);

        let _ = self.append_event(
            &request.task_id,
            "TOOL_REQUESTED",
            json!({
                "requestId": request.request_id,
                "tool": request.tool.as_str(),
                "args": redact_args(&request.args),
                "requestedBy": request.requested_by,
                "nodeRiskTier": request.risk_tier,
            }),
        );
        let _ = self.append_event(
            &request.task_id,
            "POLICY_DECIDED",
            json!({
                "requestId": request.request_id,
                "decision": decision.decision,
                "riskLevel": decision.risk_level,
                "matchedRule": decision.matched_rule,
                "reason": decision.reason,
                "normalizedTarget": decision.normalized_target,
            }),
        );
        self.with_store(|s| s.record_tool_request(request, "plan-current", &decision))
            .map_err(|e| format!("tool_request 기록 실패: {e}"))?;

        // 2) 승인이 필요하면 UI 왕복. Node는 이 과정에 관여하지 않는다.
        let mut approved = false;
        if decision.requires_user_approval {
            let approval = ApprovalRequest {
                approval_id: format!("approval-{}", uuid::Uuid::new_v4()),
                task_id: request.task_id.clone(),
                items: vec![self.describe_for_approval(request, &decision)],
                created_at: now_iso(),
            };
            // 승인 모달에는 preview(patch/content 본문)를 그대로 보여준다 — 무엇을 승인하는지
            // 모르면 승인이 의미가 없다. 그러나 **이벤트에는 남기지 않는다**: 비밀값 파일에
            // 새로 쓰려는 값이 감사 로그에 영구 보관되면, 승인 화면에서 한 번 보여주는 것과
            // 전혀 다른 노출이 된다.
            let _ = self.append_event(
                &request.task_id,
                "APPROVAL_REQUESTED",
                redact_approval_for_event(&approval),
            );

            match self.approvals.request_approval(&approval) {
                ApprovalOutcome::Granted => {
                    approved = true;
                    let _ = self.append_event(
                        &request.task_id,
                        "APPROVAL_GRANTED",
                        json!({ "approvalId": approval.approval_id, "requestId": request.request_id }),
                    );
                }
                ApprovalOutcome::Denied { note } => {
                    let _ = self.append_event(
                        &request.task_id,
                        "APPROVAL_DENIED",
                        json!({ "approvalId": approval.approval_id, "requestId": request.request_id, "note": note }),
                    );
                }
            }
        }

        // 3) 실행. 승인되지 않았으면 Tool Runtime이 스스로 Denied를 반환한다 —
        //    호출자가 승인 확인을 잊는 경로를 없애기 위해 판단을 런타임에도 넘긴다.
        let outcome = self.runtime.execute(request, &decision, approved, &cancel);

        // 4) 결과 기록. **레코드와 이벤트를 같은 트랜잭션에** 쓴다 (M0.1 트랜잭션 규칙).
        if let Some(mutation) = &outcome.mutation {
            let payload = json!({
                "requestId": mutation.request_id,
                "path": mutation.path,
                "preExisted": mutation.pre_image.existed,
                "postExists": mutation.post_image.existed,
            });
            let appended = self
                .with_store(|s| s.record_file_mutation_with_event(mutation, &payload))
                .map_err(|e| format!("file_mutation 기록 실패: {e}"))?;
            self.relay(&request.task_id, "FILE_MUTATED", &payload, &appended);
        }
        if let Some(diff) = &outcome.diff {
            let path = outcome
                .mutation
                .as_ref()
                .map(|m| m.path.clone())
                .unwrap_or_else(|| "(unknown)".to_string());
            self.diffs.lock().unwrap().push((path, diff.clone()));
        }

        // 비밀값 경로의 **출력은 이벤트에 남기지 않는다.**
        //
        // 사용자가 `.env` 읽기를 승인했다는 것은 "이번 판단을 위해 모델이 보는 것"에 동의한
        // 것이고, "그 값이 감사 로그에 영구히 남는 것"에 동의한 것이 아니다. 이벤트 로그는
        // UI에 그대로 표시되고 오래 보관되므로, 승인 여부와 무관하게 여기서는 덜어낸다.
        let secret_target = secrets::is_secret_path(&decision.normalized_target);
        let completed_payload = json!({
            "requestId": outcome.result.request_id,
            "status": outcome.result.status,
            "error": outcome.result.error,
            "durationMs": outcome.result.duration_ms,
            "outputRef": outcome.output_ref,
            // 큰 출력은 이미 artifact에 있으므로 이벤트에는 요약만 남긴다.
            "output": if secret_target {
                json!({ "redacted": true, "reason": "비밀값을 담을 수 있는 경로이므로 이벤트에 내용을 남기지 않습니다" })
            } else {
                summarize_output(outcome.result.output.as_ref())
            },
        });
        let appended = self
            .with_store(|s| {
                s.record_tool_result_with_event(
                    &outcome.result,
                    outcome.output_ref.as_deref(),
                    &request.task_id,
                    &completed_payload,
                )
            })
            .map_err(|e| format!("tool_result 기록 실패: {e}"))?;
        self.relay(&request.task_id, "TOOL_COMPLETED", &completed_payload, &appended);

        Ok(json!({
            "result": outcome.result,
            "policy": {
                "decision": decision.decision,
                "riskLevel": decision.risk_level,
                "reason": decision.reason,
                "matchedRule": decision.matched_rule,
                "normalizedTarget": decision.normalized_target,
            }
        }))
    }

    /// 승인 모달에 보여줄 항목을 만든다.
    /// `run_command`의 program/args/cwd는 실제 실행값과 정확히 같아야 한다 —
    /// 그래서 표시용 문자열을 새로 조립하지 않고 정규화된 argv를 그대로 넣는다.
    fn describe_for_approval(&self, request: &ToolRequest, decision: &PolicyDecision) -> ApprovalRequestItem {
        let command = match request.tool {
            ToolName::RunCommand | ToolName::RunTests => parse_run_command(&request.args).ok(),
            _ => None,
        };
        let path = request.args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
        let preview = match request.tool {
            ToolName::ApplyPatch => request
                .args
                .get("patch")
                .and_then(|v| v.as_str())
                .map(|p| truncate(p, 4000)),
            ToolName::CreateFile => request
                .args
                .get("content")
                .and_then(|v| v.as_str())
                .map(|p| truncate(p, 4000)),
            _ => None,
        };
        ApprovalRequestItem {
            request_id: request.request_id.clone(),
            tool: request.tool.as_str().to_string(),
            risk_level: decision.risk_level,
            reason: decision.reason.clone(),
            command,
            path,
            preview,
        }
    }

    /// 결정론적 검증 실행. Node는 "언제"만 요청하고 "무엇을 어떻게"는 Rust가 정한다.
    pub fn run_verification(
        &self,
        task_id: &str,
        phase: VerificationPhase,
        attempt_number: u32,
    ) -> Result<Value, String> {
        // 취소 이후에는 검증을 새로 시작하지 않는다. 시작해 버리면 "취소했는데 npm test가 돈다"가 된다.
        if self.is_cancelled(task_id) {
            let _ = self.append_event(
                task_id,
                "VERIFICATION_SKIPPED_CANCELLED",
                json!({ "phase": format!("{phase:?}"), "attemptNumber": attempt_number }),
            );
            return Err("태스크가 취소되어 검증을 실행하지 않았습니다".to_string());
        }
        let runner = VerificationRunner::new(&self.root, &self.artifacts);
        let baseline = self.baseline.lock().unwrap().clone();
        let mut executor = HostExecutor { host: self };

        let report = runner.run(task_id, phase, attempt_number, &mut executor, baseline.as_ref());

        let payload = serde_json::to_value(&report).unwrap_or(Value::Null);
        let appended = self
            .with_store(|s| s.record_verification_with_event(&report, &payload))
            .map_err(|e| format!("verification_report 기록 실패: {e}"))?;
        self.relay(task_id, "VERIFICATION_COMPLETED", &payload, &appended);

        if phase == VerificationPhase::Baseline {
            *self.baseline.lock().unwrap() = Some(report.clone());
        }

        Ok(json!({ "report": report }))
    }

    /// 이 태스크가 만든 커밋을 `git revert`로 되돌린다 — 19절.
    ///
    /// # 충돌을 미리 배제하는 대신, 충돌하면 우리가 치운다
    ///
    /// 예전에는 **충돌이 불가능한 경우에만** 실행했다 — 그 커밋이 아직 HEAD이고 워킹 트리가
    /// 깨끗할 때. 근거는 "충돌하면 `git revert --abort`도 승인을 받아야 하는데 사용자가 거부하면
    /// 충돌 마커가 박힌 채 남는다"였다. 그 전제가 틀렸다: `--abort`는 새로운 작업이 아니라
    /// **우리가 시작해 실패한 작업의 원상복구**다. 사용자는 "되돌리기"를 누르며 이 작업 하나를
    /// 승인했고, 실패했을 때 원래대로 돌려놓는 것까지가 그 한 번의 승인 범위다. 별도 승인을
    /// 묻는 쪽이 오히려 저장소를 망가진 채로 둘 수 있는 길이었다.
    ///
    /// 그래서 HEAD 조건을 버린다. 그 위에 다른 커밋이 쌓였어도 대부분은 깨끗하게 되돌아가고,
    /// 안 되면 되돌려 놓으면 된다. 사용자에게 "직접 하세요"라고 미루던 경우의 대부분이
    /// 사실은 우리가 해줄 수 있는 일이었다.
    ///
    /// # 워킹 트리 검사만 남긴다
    ///
    /// 커밋한 경로에 저장되지 않은 변경이 있으면 여전히 시작하지 않는다. 그건 실패했을 때
    /// **사용자가 아직 저장하지 않은 작업**이 위험해지는 유일한 경우이고, `--abort`가 그것까지
    /// 지켜준다고 보장할 수 없기 때문이다. 우리가 만든 상태는 우리가 되돌릴 수 있지만
    /// 사용자가 만든 상태는 되돌릴 수 없다 — 이 비대칭이 두 조건의 운명을 갈랐다.
    ///
    /// # 남의 revert 위에서는 시작하지 않는다
    ///
    /// 시작 전에 `REVERT_HEAD`가 이미 있으면 거부한다. 진행 중인 revert가 있다는 뜻이고,
    /// 그 위에서 우리가 실패해 `--abort`를 부르면 **사용자가 하던 작업을 지운다.** 실패 후에도
    /// 같은 것을 다시 확인해서, 그 `REVERT_HEAD`가 **이번 실행이 만든 것일 때만** 치운다.
    ///
    /// `reset --hard`를 쓰지 않는 이유는 19.2절에 있다.
    pub fn revert_commit(&self, task_id: &str) -> Result<Value, String> {
        let Some(sha) = self.committed_sha(task_id)? else {
            return Ok(json!({
                "reverted": false,
                "reason": "이 작업이 만든 커밋을 특정할 수 없습니다 (커밋이 없거나 sha를 확인하지 못했습니다).",
            }));
        };

        if self.git_ref_exists(task_id, "REVERT_HEAD")? {
            return Ok(json!({
                "reverted": false,
                "sha": sha,
                "conflicted": false,
                "cleanedUp": true,
                "reason": "이미 진행 중인 revert가 있습니다. 되돌리기가 실패하면 그것까지 취소해 버리므로 시작하지 않습니다 — 진행 중인 revert를 먼저 끝내거나 `git revert --abort`로 정리한 뒤 다시 시도하세요.",
            }));
        }

        let paths = self.committed_paths(task_id)?;
        let mut status_args: Vec<&str> = vec!["status", "--porcelain", "--"];
        for path in &paths {
            status_args.push(path.as_str());
        }
        let dirty = self.git_output(task_id, &status_args)?;
        if !dirty.trim().is_empty() {
            return Ok(json!({
                "reverted": false,
                "sha": sha,
                "conflicted": false,
                "cleanedUp": true,
                "reason": format!(
                    "커밋한 파일에 저장되지 않은 변경이 있습니다. 되돌리기가 충돌하면 이 변경까지 위험해지므로 실행하지 않습니다 — 저장하거나 따로 보관한 뒤 다시 시도하세요:\n{}",
                    dirty.trim()
                ),
            }));
        }

        let (ok, _out, err) = self.git_try(task_id, "revert", &["revert", "--no-edit", &sha], true)?;
        if !ok {
            return self.abort_failed_revert(task_id, &sha, err);
        }

        let done = json!({ "reverted": true, "sha": sha, "paths": paths });
        let _ = self.append_event(task_id, "ROLLBACK_COMPLETED", done.clone());
        Ok(done)
    }

    /// 실패한 `git revert`의 원상복구.
    ///
    /// **별도 승인을 묻지 않는다** — 사용자가 누른 "되돌리기" 한 번의 승인 범위 안이다
    /// (위 주석). 여기서 다시 물으면 거부당했을 때 우리가 만든 충돌 상태를 사용자에게
    /// 떠넘기게 된다.
    fn abort_failed_revert(&self, task_id: &str, sha: &str, error: String) -> Result<Value, String> {
        // revert가 **시작조차 못 한** 경우가 있다: 잘못된 sha, 인덱스에 남은 변경, 머지 커밋.
        // 그때는 치울 것이 없고, 치우려 들면 남의 상태를 건드린다.
        if !self.git_ref_exists(task_id, "REVERT_HEAD")? {
            return Ok(json!({
                "reverted": false,
                "sha": sha,
                "conflicted": false,
                "cleanedUp": true,
                "reason": format!("되돌리기를 시작하지 못했습니다: {}", error.trim()),
            }));
        }

        // 어떤 파일이 충돌했는지는 `--abort` 뒤에는 알 수 없다. **지우기 전에** 읽어 둔다 —
        // 사용자가 다음에 무엇을 해야 하는지는 이 목록에 달려 있다.
        let conflicts: Vec<String> = self
            .git_output(task_id, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();

        let (aborted, _out, abort_err) = self.git_try(task_id, "revert-abort", &["revert", "--abort"], true)?;
        if !aborted {
            // 여기까지 오면 저장소가 revert 진행 중인 채로 남는다. **조용히 넘기지 않는다** —
            // 사용자가 모르면 다음 작업이 전부 그 상태 위에서 벌어진다.
            let done = json!({
                "reverted": false,
                "sha": sha,
                "conflicted": true,
                "cleanedUp": false,
                "conflicts": conflicts,
                "reason": format!(
                    "되돌리기가 충돌했고, 원상복구(`git revert --abort`)까지 실패했습니다. \
                     저장소가 revert 진행 중 상태로 남아 있습니다 — 직접 `git revert --abort`를 실행하세요.\n{}",
                    abort_err.trim()
                ),
            });
            let _ = self.append_event(task_id, "ROLLBACK_FAILED", done.clone());
            return Ok(done);
        }

        let done = json!({
            "reverted": false,
            "sha": sha,
            "conflicted": true,
            "cleanedUp": true,
            "conflicts": conflicts,
            "reason": format!(
                "되돌리기가 충돌해서 저장소를 원래대로 돌려놓았습니다 (아무것도 바뀌지 않았습니다). \
                 충돌한 파일: {}. 되돌리려면 직접 `git revert {}`를 실행하고 충돌을 해결하세요.",
                if conflicts.is_empty() { "(목록 없음)".to_string() } else { conflicts.join(", ") },
                sha
            ),
        });
        // 충돌해서 되돌리지 못한 것도 **이벤트로 남는다.** 저장소가 시작 전과 같다는 것은
        // 아무 일도 없었다는 뜻이 아니다 — 사용자가 되돌리기를 눌렀고 우리가 하지 못했다.
        let _ = self.append_event(task_id, "ROLLBACK_FAILED", done.clone());
        Ok(done)
    }

    /// 이벤트 로그에서 이 태스크가 만든 커밋 sha를 찾는다.
    ///
    /// 별도 컬럼에 저장하지 않는 이유: 이벤트가 진실의 원천이고(7번 원칙), 커밋 sha는 그
    /// 이벤트에 이미 있다. 같은 사실을 두 곳에 두면 어긋날 수 있다.
    fn committed_sha(&self, task_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .commit_event(task_id)?
            .and_then(|p| p.get("sha").and_then(Value::as_str).map(str::to_string))
            .filter(|s| !s.trim().is_empty()))
    }

    fn committed_paths(&self, task_id: &str) -> Result<Vec<String>, String> {
        Ok(self
            .commit_event(task_id)?
            .and_then(|p| {
                p.get("paths").and_then(Value::as_array).map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
            })
            .unwrap_or_default())
    }

    fn commit_event(&self, task_id: &str) -> Result<Option<Value>, String> {
        let events = self
            .with_store(|s| s.events(task_id))
            .map_err(|e| format!("이벤트 조회 실패: {e}"))?;
        Ok(events
            .into_iter()
            .rev()
            .find(|e| e.event_type == "GIT_COMMIT_CREATED")
            .map(|e| e.payload))
    }

    /// 읽기 전용 git 조회. 0이 아닌 종료 코드는 `Err`다.
    fn git_output(&self, task_id: &str, args: &[&str]) -> Result<String, String> {
        let (ok, stdout, stderr) = self.git_try(task_id, args[0], args, false)?;
        if !ok {
            return Err(format!("git {} 실패: {}", args[0], stderr.trim()));
        }
        Ok(stdout)
    }

    /// git 명령 하나를 실행하고 `(성공, stdout, stderr)`를 준다.
    /// **Policy Gate와 Tool Runtime을 그대로 지난다** — Rust가 자기 편의로 게이트를 우회하기
    /// 시작하면 게이트의 의미가 사라진다.
    ///
    /// # `ToolStatus::Ok`을 성공으로 읽으면 안 된다
    ///
    /// `run_command`는 0이 아닌 종료 코드를 "도구 실행 실패"가 아니라 "명령이 실패했다"는
    /// **사실**로 다루기 때문에 `status`는 `Ok`로 두고 `exitCode`만 남긴다(tools/mod.rs).
    /// 그래서 성공 판정은 반드시 `exitCode == 0`까지 봐야 한다. 예전 `revert_commit`은
    /// `status`만 보고 판정해서 **충돌한 revert를 "되돌렸습니다"로 보고할 수 있었다** —
    /// tip 커밋만 되돌린다는 조건이 그 경우를 우연히 막고 있었을 뿐이고, 그 조건을 없애는
    /// 순간 드러났을 결함이다.
    ///
    /// # 0이 아닌 종료를 `Err`로 만들지 않는 이유
    ///
    /// `revert`의 충돌이나 `rev-parse --verify`의 "그런 ref 없음"처럼 **0이 아닌 종료가 답
    /// 그 자체**인 호출이 있다. 그것들을 오류로 뭉개면 호출부가 다시 문자열을 뒤져야 한다.
    ///
    /// `record`는 감사 로그에 남길지다. 상태를 묻기만 하는 내부 조회(`REVERT_HEAD`가 있는가)까지
    /// 남기면 이벤트 로그가 사용자가 읽을 수 없는 것으로 가득 찬다 — 남기는 것은 **저장소를
    /// 바꾸는 명령**뿐이다.
    fn git_try(
        &self,
        task_id: &str,
        label: &str,
        args: &[&str],
        record: bool,
    ) -> Result<(bool, String, String), String> {
        let request = self.git_request(task_id, label, args);
        let decision = self.gate.evaluate(&request, &self.root, &self.policy);
        if !decision.allowed() {
            return Err(format!("git {}이(가) 정책에 막혔습니다: {}", args[0], decision.reason));
        }
        let token = CancellationToken::new();
        let outcome = self.runtime.execute(&request, &decision, true, &token);

        if record {
            self.with_store(|s| s.record_tool_request(&request, "rollback", &decision))
                .ok();
            let payload = json!({
                "requestId": outcome.result.request_id,
                "status": outcome.result.status,
                "revert": true,
            });
            if let Ok(appended) =
                self.with_store(|s| s.record_tool_result_with_event(&outcome.result, None, task_id, &payload))
            {
                self.relay(task_id, "TOOL_COMPLETED", &payload, &appended);
            }
        }

        // 여기 걸리는 것은 spawn 실패·타임아웃·취소처럼 **명령의 결과를 얻지 못한** 경우다.
        if outcome.result.status != ToolStatus::Ok {
            return Err(outcome
                .result
                .error
                .unwrap_or_else(|| format!("git {} 실행 실패", args[0])));
        }
        let text = |name: &str| {
            outcome
                .result
                .output
                .as_ref()
                .and_then(|o| o.get(name).and_then(Value::as_str))
                .unwrap_or_default()
                .to_string()
        };
        let exit = outcome
            .result
            .output
            .as_ref()
            .and_then(|o| o.get("exitCode").and_then(Value::as_i64));
        Ok((exit == Some(0), text("stdout"), text("stderr")))
    }

    /// ref가 존재하는가. 진행 중인 revert를 `REVERT_HEAD`로 감지하는 데 쓴다.
    ///
    /// `.git/REVERT_HEAD` 파일을 직접 보지 않는 이유: worktree나 `--git-dir`에서 그 경로가
    /// 달라진다. git에게 묻는 것이 어디서나 맞는 유일한 방법이다.
    fn git_ref_exists(&self, task_id: &str, name: &str) -> Result<bool, String> {
        let (ok, _out, _err) =
            self.git_try(task_id, "rev-parse", &["rev-parse", "--verify", "--quiet", name], false)?;
        Ok(ok)
    }

    fn git_request(&self, task_id: &str, label: &str, args: &[&str]) -> ToolRequest {
        ToolRequest {
            request_id: format!("{task_id}-git-{label}-{}", uuid::Uuid::new_v4()),
            task_id: task_id.to_string(),
            tool: ToolName::RunCommand,
            args: json!({ "program": "git", "args": args, "cwd": "." }),
            requested_by: json!({ "role": "orchestrator" }),
            // Node의 1차 분류 자리다. Rust는 이 값을 판단 근거로 쓰지 않고 기록만 한다 —
            // 실제 등급은 아래에서 `gate.evaluate`가 정한다.
            risk_tier: Some(RiskTier::Auto),
            created_at: Some(now_iso()),
        }
    }

    /// 롤백: 이 태스크가 건드린 파일을 pre-image로 되돌린다.
    /// 되돌리기도 일반 ToolRequest 경로와 이벤트 로그를 그대로 탄다(문서 10절).
    pub fn rollback(&self, task_id: &str) -> Result<Value, String> {
        let mutations = self
            .with_store(|s| s.rollback_targets(task_id))
            .map_err(|e| format!("롤백 대상 조회 실패: {e}"))?;

        let _ = self.append_event(
            task_id,
            "ROLLBACK_STARTED",
            json!({ "fileCount": mutations.len(), "paths": mutations.iter().map(|m| &m.path).collect::<Vec<_>>() }),
        );

        // 롤백 요청은 사용자가 이미 "되돌리기"를 눌러 승인한 것이므로 승인 게이트웨이를
        // 다시 거치지 않는다 — 다만 Policy Gate는 반드시 거친다(workspace 경계는 예외 없음).
        let mut restored = Vec::new();
        let mut failed = Vec::new();
        for request in self.runtime.rollback_requests(task_id, &mutations) {
            let decision = self.gate.evaluate(&request, &self.root, &self.policy);
            if !decision.allowed() {
                failed.push(json!({ "path": request.args.get("path"), "reason": decision.reason }));
                continue;
            }
            // 롤백은 **취소된/중단된 태스크에서도 반드시 동작해야 한다** — 오히려 그때가
            // 가장 필요한 순간이다. 그래서 태스크 취소 토큰이 아니라 새 토큰을 쓴다.
            // Policy Gate는 그대로 거치므로 workspace 경계 보장은 유지된다.
            let rollback_token = CancellationToken::new();
            let outcome = self.runtime.execute(&request, &decision, true, &rollback_token);
            self.with_store(|s| s.record_tool_request(&request, "rollback", &decision))
                .ok();
            let payload = json!({
                "requestId": outcome.result.request_id,
                "status": outcome.result.status,
                "rollback": true,
            });
            if let Ok(appended) =
                self.with_store(|s| s.record_tool_result_with_event(&outcome.result, None, task_id, &payload))
            {
                self.relay(task_id, "TOOL_COMPLETED", &payload, &appended);
            }
            match outcome.result.status {
                ToolStatus::Ok => {
                    if let Some(path) = request.args.get("path").and_then(Value::as_str) {
                        self.with_store(|s| s.mark_mutation_rolled_back(task_id, path)).ok();
                    }
                    restored.push(request.args.get("path").cloned().unwrap_or(Value::Null));
                }
                _ => failed.push(json!({ "path": request.args.get("path"), "reason": outcome.result.error })),
            }
        }

        let payload = json!({ "restored": restored, "failed": failed });
        let _ = self.append_event(task_id, "ROLLBACK_COMPLETED", payload.clone());
        Ok(payload)
    }
}

/// 검증 명령을 Tool Runtime + 이벤트 로그를 통해 실행하는 어댑터.
struct HostExecutor<'a> {
    host: &'a TaskHost,
}

impl CommandExecutor for HostExecutor<'_> {
    fn execute(&mut self, request: &ToolRequest) -> ToolResult {
        match self.host.execute_tool(request) {
            Ok(value) => {
                serde_json::from_value(value.get("result").cloned().unwrap_or(Value::Null)).unwrap_or(ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Error,
                    output: None,
                    error: Some("검증 결과를 파싱할 수 없음".to_string()),
                    duration_ms: 0,
                    completed_at: now_iso(),
                })
            }
            Err(message) => ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Error,
                output: None,
                error: Some(message),
                duration_ms: 0,
                completed_at: now_iso(),
            },
        }
    }
}

/// Node → Rust 요청 디스패치.
impl SidecarHandler for TaskHost {
    fn handle_request(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "tool.execute" => {
                let raw = params
                    .get("request")
                    .ok_or_else(|| "tool.execute params에 \"request\"가 없음".to_string())?;
                let request: ToolRequest =
                    serde_json::from_value(raw.clone()).map_err(|e| format!("잘못된 ToolRequest: {e}"))?;
                self.execute_tool(&request)
            }

            "policy.evaluate" => {
                let raw = params
                    .get("request")
                    .ok_or_else(|| "policy.evaluate params에 \"request\"가 없음".to_string())?;
                let request: ToolRequest =
                    serde_json::from_value(raw.clone()).map_err(|e| format!("잘못된 ToolRequest: {e}"))?;
                let decision = self.gate.evaluate(&request, &self.root, &self.policy);
                Ok(serde_json::to_value(decision).unwrap_or(Value::Null))
            }

            "db.appendEvent" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "db.appendEvent params에 \"taskId\"가 없음".to_string())?;
                let event_type = params
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "db.appendEvent params에 \"type\"이 없음".to_string())?;
                let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                self.append_event(task_id, event_type, payload)
            }

            "verify.run" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "verify.run params에 \"taskId\"가 없음".to_string())?;
                let phase = match params.get("phase").and_then(Value::as_str) {
                    Some("baseline") => VerificationPhase::Baseline,
                    Some("post") | None => VerificationPhase::Post,
                    Some(other) => return Err(format!("알 수 없는 검증 phase: {other:?}")),
                };
                let attempt = params.get("attemptNumber").and_then(Value::as_u64).unwrap_or(0) as u32;
                self.run_verification(task_id, phase, attempt)
            }

            "usage.record" => {
                let usage = params.get("usage").cloned().unwrap_or(Value::Null);
                self.with_store(|s| s.record_provider_usage(&usage))
                    .map_err(|e| format!("provider_usage 기록 실패: {e}"))?;
                if let Some(task_id) = usage.get("taskId").and_then(Value::as_str) {
                    let _ = self.append_event(task_id, "PROVIDER_USAGE", usage.clone());
                }
                Ok(json!({ "recorded": true }))
            }

            // 자격증명은 spawn 시 환경변수로 1회 주입한다(process-architecture.md 2절).
            // Node가 런타임에 키를 다시 요청하는 경로를 열지 않는다 — 재요청 빈도로 이상을
            // 탐지하겠다는 8절 미해결 항목보다, 아예 경로를 없애는 편이 M0에서 단순하고 안전하다.
            "credential.get" => {
                Err("credential.get은 지원하지 않음 — 자격증명은 sidecar spawn 시 환경변수로 1회 주입된다".to_string())
            }

            other => Err(format!("알 수 없는 method: {other}")),
        }
    }

    fn handle_event(&self, task_id: &str, event: &Value) {
        // Node가 발행한 phase 전이 등을 이벤트 로그에 기록하고 UI로 릴레이한다.
        // Rust는 내용을 해석하지 않는다(process-architecture.md 4절) — 단, 이벤트 로그에
        // 남기려면 event_type은 알아야 하므로 그 필드만 읽는다.
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("ERROR");
        if task_id.is_empty() {
            // ready 등 태스크에 속하지 않는 이벤트는 로그 대상이 아니고 UI 릴레이만 한다.
            self.sink.emit("sidecar-event", event);
            return;
        }
        let payload = {
            let mut p = event.clone();
            if let Some(obj) = p.as_object_mut() {
                obj.remove("type");
            }
            p
        };
        let _ = self.append_event(task_id, event_type, payload);
    }
}

/// 이벤트 로그에 들어가는 args에서 큰 본문을 덜어낸다.
///
/// 두 가지 이유가 겹친다:
///  - **크기**: 파일 본문 전체를 이벤트에 인라인하면 로그가 비대해진다.
///  - **비밀값**: 대상 경로가 secret으로 분류되면 미리보기조차 남기지 않는다. `.env`에 쓰려는
///    값의 앞 512바이트는 대개 키 전체를 포함한다 — 자르는 것으로는 보호가 되지 않는다.
fn redact_args(args: &Value) -> Value {
    let Some(obj) = args.as_object() else {
        return args.clone();
    };
    let secret_target = obj
        .get("path")
        .and_then(Value::as_str)
        .map(secrets::is_secret_path)
        .unwrap_or(false);

    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        match (k.as_str(), v) {
            ("content" | "patch", Value::String(s)) if secret_target => {
                out.insert(
                    k.clone(),
                    json!({ "bytes": s.len(), "redacted": true, "reason": "비밀값 경로" }),
                );
            }
            ("content" | "patch", Value::String(s)) => {
                out.insert(k.clone(), json!({ "bytes": s.len(), "preview": truncate(s, 512) }));
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

/// `USER_DECISION_RECORDED`의 자유 텍스트에서 비밀값 모양을 가린다.
///
/// # 왜 이 이벤트만인가
///
/// 마스킹을 모든 이벤트에 걸면 `DRAFT_RECEIVED.patch`처럼 **원문 그대로여야 의미가 있는**
/// 기록까지 변형된다. 감사 로그의 patch가 실제 적용된 patch와 다르면 그 로그는 감사에 쓸 수 없다.
/// 그래서 대상을 "사용자가 자유 입력한 텍스트"로 좁힌다 — 여기가 붙여넣기가 실제로 일어나는
/// 자리이고(문서 17.3절), 여기서는 마스킹된 텍스트가 원문의 역할을 그대로 한다.
///
/// 마스킹 **개수**를 payload에 남기는 이유: 0이 아니면 "가린 것이 있었다"가 로그에 보인다.
/// 이건 "남은 것이 없다"는 주장이 아니다 — 모양 기반 탐지의 한계는 `secrets` 모듈에 적어두었다.
fn redact_user_decision(event_type: &str, payload: Value) -> Value {
    if event_type != "USER_DECISION_RECORDED" {
        return payload;
    }
    let mut value = payload;
    let mut total_masked = 0usize;

    if let Some(Value::String(answer)) = value.get("answer") {
        let (masked, count) = secrets::mask_secret_shapes(answer);
        total_masked += count;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("answer".to_string(), Value::String(masked));
        }
    }
    // 기준 텍스트는 답변 원문에서 만들어지므로 같은 값이 한 번 더 들어 있다.
    // 한쪽만 가리면 다른 쪽으로 그대로 새고, 그 사본이 파생 캐시에까지 들어간다.
    if let Some(items) = value.get_mut("acceptanceCriteria").and_then(Value::as_array_mut) {
        for item in items {
            let Some(Value::String(text)) = item.get("text") else {
                continue;
            };
            let (masked, count) = secrets::mask_secret_shapes(text);
            total_masked += count;
            if let Some(obj) = item.as_object_mut() {
                obj.insert("text".to_string(), Value::String(masked));
            }
        }
    }

    if let Some(obj) = value.as_object_mut() {
        obj.insert("secretShapesMasked".to_string(), json!(total_masked));
    }
    value
}

/// `APPROVAL_REQUESTED` 이벤트용 축약. 승인 모달로 가는 원본은 건드리지 않는다.
///
/// `preview`만 제거하는 이유: 나머지 필드(tool, riskLevel, reason, command argv, path)는
/// "무엇을 승인했는가"의 감사 기록으로 반드시 남아야 한다. 본문만 없으면 된다.
fn redact_approval_for_event(approval: &ApprovalRequest) -> Value {
    let mut value = serde_json::to_value(approval).unwrap_or(Value::Null);
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            let secret_target = item
                .get("path")
                .and_then(Value::as_str)
                .map(secrets::is_secret_path)
                .unwrap_or(false);
            let Some(obj) = item.as_object_mut() else { continue };
            match obj.get("preview") {
                Some(Value::String(preview)) => {
                    let bytes = preview.len();
                    obj.insert(
                        "preview".to_string(),
                        if secret_target {
                            json!({ "bytes": bytes, "redacted": true, "reason": "비밀값 경로" })
                        } else {
                            json!({ "bytes": bytes, "preview": truncate(preview, 512) })
                        },
                    );
                }
                _ => continue,
            }
        }
    }
    value
}

fn summarize_output(output: Option<&Value>) -> Value {
    let Some(value) = output else { return Value::Null };
    let serialized = value.to_string();
    if serialized.len() <= MAX_INLINE_OUTPUT_BYTES / 4 {
        return value.clone();
    }
    json!({ "preview": truncate(&serialized, 1024), "sizeBytes": serialized.len() })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…(truncated)", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn host(
        policy: TaskPolicy,
        approvals: Arc<dyn ApprovalGateway>,
    ) -> (tempfile::TempDir, tempfile::TempDir, TaskHost) {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir_all(ws.path().join("src")).unwrap();
        fs::write(ws.path().join("src/app.ts"), "a\nb\nc\n").unwrap();
        let art = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(art.path()).unwrap();
        let mut store = Store::open_in_memory(artifacts.clone()).unwrap();
        store
            .upsert_workspace("ws-1", &ws.path().to_string_lossy(), "ws")
            .unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task(
                "task-1",
                "sess-1",
                "ws-1",
                &ws.path().to_string_lossy(),
                "verified",
                "fix",
            )
            .unwrap();
        let root = WorkspaceRoot::new(ws.path()).unwrap();
        let host = TaskHost::new(
            root,
            policy,
            Arc::new(Mutex::new(store)),
            artifacts,
            approvals,
            Arc::new(NullSink),
            Arc::new(CancellationRegistry::new()),
        );
        (ws, art, host)
    }

    /// sink로 나간 이벤트를 기록한다 — "DB에는 남았는데 UI로는 안 갔다"를 잡기 위한 것.
    #[derive(Default)]
    struct RecordingSink {
        seen: Mutex<Vec<String>>,
        /// 원본 payload — "DB는 막았는데 화면으로 흘렸다"를 잡기 위해 필요하다.
        payloads: Mutex<Vec<String>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, _channel: &str, payload: &Value) {
            self.seen
                .lock()
                .unwrap()
                .push(payload.get("type").and_then(Value::as_str).unwrap_or("").to_string());
            self.payloads.lock().unwrap().push(payload.to_string());
        }
    }

    /// 테스트용 git 저장소. identity와 gpgsign을 저장소 로컬로 박는 이유는 픽스처와 같다 —
    /// 전역 설정이 없는 환경에서 **검증하려는 것과 무관한 이유로** 실패하면 안 된다.
    /// 테스트가 저장소 상태를 만들 때 쓰는 git. 종료 코드를 검사하지 않는다 —
    /// 충돌하는 revert를 **일부러** 만드는 테스트가 있기 때문이다.
    fn git_at(root: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .output()
            .expect("git을 실행할 수 없습니다");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// 이 태스크가 만든 커밋 하나를 흉내낸다: 파일을 바꾸고 커밋한 뒤 그 sha를 이벤트에 남긴다.
    fn commit_as_task(host: &TaskHost, root: &std::path::Path, task_id: &str, body: &str) -> String {
        fs::write(root.join("src/app.ts"), body).unwrap();
        git_at(root, &["add", "-A"]);
        git_at(root, &["commit", "-m", "task commit"]);
        let sha = git_at(root, &["rev-parse", "HEAD"]).trim().to_string();
        host.append_event(
            task_id,
            "GIT_COMMIT_CREATED",
            json!({ "sha": sha, "paths": ["src/app.ts"], "branch": "main" }),
        )
        .unwrap();
        sha
    }

    fn init_git_repo(root: &std::path::Path) {
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("git을 실행할 수 없습니다");
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.invalid"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["add", "-A"]);
        git(&["commit", "-m", "initial"]);
    }

    fn host_with_sink(sink: Arc<RecordingSink>) -> (tempfile::TempDir, tempfile::TempDir, TaskHost) {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir_all(ws.path().join("src")).unwrap();
        fs::write(ws.path().join("src/app.ts"), "a\nb\nc\n").unwrap();
        let art = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(art.path()).unwrap();
        let mut store = Store::open_in_memory(artifacts.clone()).unwrap();
        store
            .upsert_workspace("ws-1", &ws.path().to_string_lossy(), "ws")
            .unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task(
                "task-1",
                "sess-1",
                "ws-1",
                &ws.path().to_string_lossy(),
                "verified",
                "fix",
            )
            .unwrap();
        let root = WorkspaceRoot::new(ws.path()).unwrap();
        let host = TaskHost::new(
            root,
            TaskPolicy::default(),
            Arc::new(Mutex::new(store)),
            artifacts,
            Arc::new(AutoApprove),
            sink,
            Arc::new(CancellationRegistry::new()),
        );
        (ws, art, host)
    }

    /// 12절 미해결 "취소 중 상한" — 기다리기를 그만두는 탈출구.
    #[test]
    fn force_abandon_terminalizes_the_task_without_claiming_cleanup() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink.clone());

        let result = host.force_abandon("task-1").unwrap();
        assert_eq!(result.get("abandoned").and_then(Value::as_bool), Some(true));

        // 태스크가 실제로 터미널이 됐다 — 사용자가 "취소 중" 화면에서 풀려난다.
        let task = host.with_store(|s| s.get_task("task-1")).unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("CANCELLED"));

        // **"정리됐다"고 말하지 않는다.** 남은 프로세스가 있을 수 있다는 것이 이 경로의
        // 정의이지 예외가 아니므로, 그 사실이 이벤트에 남아야 한다.
        let event = host
            .with_store(|s| s.events("task-1"))
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "TASK_CANCELLED")
            .expect("terminal 이벤트가 없습니다");
        assert_eq!(event.payload.get("forceAbandoned").and_then(Value::as_bool), Some(true));
        let summary = event.payload.get("summary").and_then(Value::as_str).unwrap_or("");
        assert!(
            summary.contains("남아 있을 수 있"),
            "남은 프로세스 가능성을 알리지 않습니다: {summary}"
        );
    }

    /// 기다리는 사이에 정상 종료된 경우는 **오류가 아니라 좋은 소식**이다.
    #[test]
    fn force_abandon_does_not_override_an_already_finished_task() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);

        host.finish_task(
            "task-1",
            "COMPLETED",
            "TASK_COMPLETED",
            None,
            json!({ "status": "completed" }),
        )
        .unwrap();

        let result = host.force_abandon("task-1").unwrap();
        assert_eq!(result.get("abandoned").and_then(Value::as_bool), Some(false));
        assert_eq!(result.get("status").and_then(Value::as_str), Some("COMPLETED"));
        // 완료를 취소로 덮어쓰지 않는다 — 먼저 확정된 쪽이 남는다.
        let task = host.with_store(|s| s.get_task("task-1")).unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("COMPLETED"));
    }

    /// 문서 17.3절: 판정 원문은 남되 비밀값 모양은 가려야 한다.
    ///
    /// **Node가 보낸 payload를 그대로 믿지 않는 경로를 검증한다.** Node가 마스킹하고 보내주기를
    /// 기대하면, 장악당한 Node에서 그 규칙이 사라진다(원칙 2). 그래서 마스킹은 저장 직전
    /// Rust에서 일어나고, DB와 UI 릴레이 **양쪽**에 가려진 값이 간다.
    #[test]
    fn user_decision_keeps_the_answer_but_masks_secret_shapes() {
        const PASTED: &str = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink.clone());

        host.append_event(
            "task-1",
            "USER_DECISION_RECORDED",
            json!({
                "questions": ["빈 문자열 이메일은 통과입니까, 거부입니까?"],
                "answer": format!("거부해주세요. 토큰은 {PASTED} 입니다"),
                "acceptanceCriteria": [{
                    "criterionId": "u-1",
                    "text": format!("거부해주세요. 토큰은 {PASTED} 입니다"),
                    "source": "user_decision",
                    "decidedAt": "2024-01-01T00:00:00Z",
                }],
            }),
        )
        .unwrap();

        let stored = host
            .with_store(|s| s.events("task-1"))
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "USER_DECISION_RECORDED")
            .expect("USER_DECISION_RECORDED가 기록되지 않았습니다");
        let payload = stored.payload.to_string();

        assert!(
            !payload.contains(PASTED),
            "붙여넣은 토큰이 이벤트에 남았습니다:\n{payload}"
        );
        // 원문이 통째로 사라지면 판정자의 판정이 다시 감사 로그에서 없어진다 — 그게 이 작업이 고친 구멍이다.
        assert!(payload.contains("거부해주세요"), "판정 원문이 사라졌습니다:\n{payload}");
        assert_eq!(
            stored.payload.get("secretShapesMasked").and_then(Value::as_u64),
            Some(2)
        );

        // 파생 캐시에도 가려진 값이 들어가야 한다. 한쪽만 막으면 다른 쪽으로 샌다.
        let criteria = host.with_store(|s| s.acceptance_criteria("task-1")).unwrap();
        assert_eq!(criteria.len(), 1);
        assert!(!criteria[0].text.contains(PASTED), "파생 캐시에 토큰이 남았습니다");

        let relayed = sink.payloads.lock().unwrap().join("\n");
        assert!(!relayed.contains(PASTED), "UI 릴레이로 토큰이 흘렀습니다:\n{relayed}");
    }

    /// 마스킹을 모든 이벤트에 걸면 감사 로그의 patch가 실제 적용된 patch와 달라진다.
    /// 그러면 그 로그는 "무엇이 적용됐나"에 답할 수 없어 감사에 쓸 수 없다.
    #[test]
    fn other_events_are_not_reshaped_by_the_mask() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);
        let patch = "--- a/x\n+++ b/x\n-const token = \"sk-abcdefghijklmnopqrstuvwxyz012345\";\n";

        host.append_event("task-1", "DRAFT_RECEIVED", json!({ "patch": patch }))
            .unwrap();

        let stored = host
            .with_store(|s| s.events("task-1"))
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "DRAFT_RECEIVED")
            .unwrap();
        assert_eq!(stored.payload.get("patch").and_then(Value::as_str), Some(patch));
    }

    /// 명세 §5 "DB 이벤트에 API 키와 비밀 값 저장 금지"의 실체.
    ///
    /// **Node를 신뢰하지 않는 경로를 검증한다.** Node의 Context Engine이 secret 파일을 걸러도,
    /// 장악당한 Node는 필터를 우회해 `read_file(".env")`를 그냥 요청할 수 있다. 그때
    /// (a) Policy Gate가 자동 허용하지 않고 (b) 사용자가 승인해도 값이 이벤트에 남지 않아야 한다.
    #[test]
    fn secret_file_contents_never_reach_the_event_log() {
        const SECRET: &str = "sk-must-never-appear-in-the-event-log";
        let sink = Arc::new(RecordingSink::default());
        let (ws, _a, host) = host_with_sink(sink.clone());
        fs::write(ws.path().join(".env"), format!("OPENAI_API_KEY={SECRET}\n")).unwrap();

        // 1) 자동 허용이 아니라 승인 필요로 분류된다.
        let read = req(ToolName::ReadFile, json!({ "path": ".env" }));
        let decision = host.gate.evaluate(&read, host.root(), host.policy());
        assert!(
            decision.requires_user_approval,
            "비밀값 파일 읽기가 자동 허용되었습니다: {decision:?}"
        );

        // 2) 사용자가 승인해도(AutoApprove 게이트웨이) 값이 이벤트에 남지 않는다.
        //    승인은 "모델이 이번 판단에 쓰는 것"에 대한 동의이고, "감사 로그 영구 보관"이 아니다.
        let result = host.execute_tool(&read).unwrap();
        let output = result.pointer("/result/output").and_then(|v| v.get("content"));
        assert!(
            output
                .map(|c| c.as_str() == Some(&format!("OPENAI_API_KEY={SECRET}\n")))
                .unwrap_or(false),
            "승인된 읽기는 호출자에게 실제 내용을 돌려줘야 합니다 (이벤트에만 남지 않는 것이다)"
        );

        // 3) DB의 어떤 이벤트에도 비밀값이 없다.
        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let all = events
            .iter()
            .map(|e| e.payload.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!all.contains(SECRET), "이벤트 로그에 비밀값이 저장되었습니다:\n{all}");

        // 4) UI로 릴레이된 스트림에도 없다 — DB만 막고 화면으로 흘리면 의미가 없다.
        let relayed = sink.payloads.lock().unwrap().join("\n");
        assert!(
            !relayed.contains(SECRET),
            "이벤트 스트림에 비밀값이 유출되었습니다:\n{relayed}"
        );
    }

    /// 비밀값 파일에 **쓰는** 경로. 자동 승인 정책이 켜져 있어도 승인을 요구해야 하고,
    /// 쓰려는 값이 이벤트에 남지 않아야 한다.
    #[test]
    fn writing_a_secret_file_requires_approval_even_when_auto_approve_is_on() {
        const NEW_SECRET: &str = "sk-newly-written-value-must-not-leak";
        let policy = TaskPolicy {
            auto_approve_workspace_writes: true,
            ..TaskPolicy::default()
        };
        let (_ws, _a, host) = host(policy, Arc::new(AutoApprove));

        let write = req(
            ToolName::CreateFile,
            json!({ "path": ".env.local", "content": format!("KEY={NEW_SECRET}\n") }),
        );
        let decision = host.gate.evaluate(&write, host.root(), host.policy());
        assert!(
            decision.requires_user_approval,
            "auto_approve_workspace_writes가 비밀값 파일 쓰기까지 자동 승인했습니다: {decision:?}"
        );

        host.execute_tool(&write).unwrap();
        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let all = events
            .iter()
            .map(|e| e.payload.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !all.contains(NEW_SECRET),
            "쓰려던 비밀값이 이벤트에 저장되었습니다:\n{all}"
        );
        // 그러나 "무엇을 했는가"는 남아야 한다 — 값만 빠지고 감사 추적은 유지된다.
        assert!(all.contains(".env.local"), "감사에 필요한 경로 정보까지 사라졌습니다");
    }

    /// 일반 소스 파일은 이 규칙에 걸리지 않아야 한다.
    /// 오탐이 많으면 정상 작업이 매번 승인 모달을 띄우게 되어 승인이 무의미해진다.
    #[test]
    fn ordinary_files_are_still_auto_approved_for_reading() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let read = req(ToolName::ReadFile, json!({ "path": "src/app.ts" }));
        let decision = host.gate.evaluate(&read, host.root(), host.policy());
        assert!(!decision.requires_user_approval, "일반 파일 읽기에 승인을 요구했습니다");
    }

    /// M0.1 회귀 방지: 레코드와 이벤트를 한 트랜잭션에 쓰는 `record_*_with_event` 경로는
    /// `append_event`를 거치지 않는다. 커밋 후 sink로 릴레이하지 않으면 DB에는 남는데
    /// **UI에서는 파일 변경이 보이지 않는다.** 조용히 사라지는 종류의 버그라 테스트로 못박는다.
    #[test]
    fn combined_writes_are_relayed_to_the_ui_not_only_to_the_database() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _a, host) = host_with_sink(sink.clone());
        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
        ))
        .unwrap();

        let emitted = sink.seen.lock().unwrap().clone();
        assert!(
            emitted.contains(&"FILE_MUTATED".to_string()),
            "sink로 나간 이벤트: {emitted:?}"
        );
        assert!(
            emitted.contains(&"TOOL_COMPLETED".to_string()),
            "sink로 나간 이벤트: {emitted:?}"
        );

        // DB와 sink가 같은 이벤트를 봐야 한다 — 한쪽에만 있으면 감사 추적이 갈라진다.
        let stored = host.with_store(|s| s.event_types("task-1")).unwrap();
        for event_type in ["FILE_MUTATED", "TOOL_COMPLETED", "POLICY_DECIDED"] {
            assert!(stored.contains(&event_type.to_string()), "DB에 {event_type}이 없습니다");
            assert!(
                emitted.contains(&event_type.to_string()),
                "sink에 {event_type}이 없습니다"
            );
        }
    }

    fn req(tool: ToolName, args: Value) -> ToolRequest {
        ToolRequest {
            request_id: format!("req-{}", uuid::Uuid::new_v4()),
            task_id: "task-1".to_string(),
            tool,
            args,
            risk_tier: None,
            requested_by: json!({ "role": "orchestrator" }),
            created_at: Some(now_iso()),
        }
    }

    #[test]
    fn approval_flow_logs_request_and_grant() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
        ))
        .unwrap();

        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        // 순서가 불변식이다: 요청 → 정책 판단 → 승인 요청 → 승인 → 실행 결과
        let approval_requested = types.iter().position(|t| t == "APPROVAL_REQUESTED").unwrap();
        let approval_granted = types.iter().position(|t| t == "APPROVAL_GRANTED").unwrap();
        let tool_completed = types.iter().position(|t| t == "TOOL_COMPLETED").unwrap();
        let policy_decided = types.iter().position(|t| t == "POLICY_DECIDED").unwrap();
        assert!(policy_decided < approval_requested);
        assert!(approval_requested < approval_granted);
        assert!(approval_granted < tool_completed);
    }

    #[test]
    fn denied_approval_does_not_mutate_and_is_logged() {
        let (ws, _a, host) = host(TaskPolicy::default(), Arc::new(AlwaysDeny));
        let before = fs::read_to_string(ws.path().join("src/app.ts")).unwrap();

        let out = host
            .execute_tool(&req(
                ToolName::ApplyPatch,
                json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+A\n" }),
            ))
            .unwrap();

        assert_eq!(out["result"]["status"].as_str().unwrap(), "denied");
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), before);
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"APPROVAL_DENIED".to_string()));
        assert!(!types.contains(&"FILE_MUTATED".to_string()));
    }

    #[test]
    fn cancelled_task_refuses_tool_execution() {
        let (ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.cancel_task("task-1").unwrap();
        let out = host
            .execute_tool(&req(ToolName::CreateFile, json!({ "path": "new.ts", "content": "x" })))
            .unwrap();
        // "denied"(정책이 막음)가 아니라 "cancelled"(사용자가 멈춤)여야 한다 —
        // 오케스트레이터의 재시도/실패 분류가 이 구분에 의존한다.
        assert_eq!(out["result"]["status"].as_str().unwrap(), "cancelled");
        assert!(!ws.path().join("new.ts").exists());
        // 취소 이후 실행 시도도 감사 로그에 남는다.
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"TOOL_SKIPPED_CANCELLED".to_string()));
        assert!(!types.contains(&"FILE_MUTATED".to_string()));
    }

    #[test]
    fn cancel_is_idempotent_and_records_one_event() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let first = host.cancel_task("task-1").unwrap();
        let second = host.cancel_task("task-1").unwrap();
        assert_eq!(first["outcome"].as_str().unwrap(), "requested");
        assert_eq!(second["outcome"].as_str().unwrap(), "already_requested");
        assert!(first["accepted"].as_bool().unwrap() && second["accepted"].as_bool().unwrap());

        let requests = host
            .with_store(|s| s.event_types("task-1"))
            .unwrap()
            .into_iter()
            .filter(|t| t == "CANCELLATION_REQUESTED")
            .count();
        assert_eq!(requests, 1, "연타해도 이벤트는 한 번만 남아야 합니다");
    }

    #[test]
    fn cancelling_a_completed_task_does_not_change_state() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.finish_task(
            "task-1",
            "COMPLETED",
            "TASK_COMPLETED",
            None,
            json!({ "summary": "done" }),
        )
        .unwrap();

        let outcome = host.cancel_task("task-1").unwrap();
        assert_eq!(outcome["outcome"].as_str().unwrap(), "already_terminal");
        assert_eq!(outcome["status"].as_str().unwrap(), "COMPLETED");

        let task = host.with_store(|s| s.get_task("task-1")).unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("COMPLETED"));
        assert!(
            task.cancellation_requested_at.is_none(),
            "터미널 태스크에 취소 시각이 기록되면 안 됩니다"
        );
        // 취소 플래그도 켜지지 않아야 한다 — 켜지면 이후 롤백이 막힌다.
        assert!(!host.is_cancelled("task-1"));
    }

    #[test]
    fn rollback_works_after_cancellation() {
        // 취소된 태스크야말로 되돌리기가 가장 필요한 순간이다.
        let (ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        let original = fs::read_to_string(ws.path().join("src/app.ts")).unwrap();
        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+CHANGED\n" }),
        ))
        .unwrap();
        host.cancel_task("task-1").unwrap();

        let result = host.rollback("task-1").unwrap();
        assert_eq!(result["failed"].as_array().unwrap().len(), 0, "{result}");
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), original);
    }

    #[test]
    fn verification_does_not_start_after_cancellation() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.cancel_task("task-1").unwrap();
        let err = host.run_verification("task-1", VerificationPhase::Post, 0).unwrap_err();
        assert!(err.contains("취소"), "{err}");
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"VERIFICATION_SKIPPED_CANCELLED".to_string()));
        assert_eq!(host.with_store(|s| s.verification_report_count("task-1")).unwrap(), 0);
    }

    #[test]
    fn competing_terminal_states_keep_the_first_one() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let first = host
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, json!({}))
            .unwrap();
        assert!(matches!(first, TerminalOutcome::Recorded { .. }));

        let second = host
            .finish_task("task-1", "CANCELLED", "TASK_CANCELLED", None, json!({}))
            .unwrap();
        assert_eq!(
            second,
            TerminalOutcome::AlreadyTerminal {
                status: "COMPLETED".to_string()
            }
        );

        // terminal 이벤트는 정확히 하나만 남아야 한다.
        let terminal_events = host
            .with_store(|s| s.event_types("task-1"))
            .unwrap()
            .into_iter()
            .filter(|t| t.starts_with("TASK_") && t != "TASK_CREATED")
            .collect::<Vec<_>>();
        assert_eq!(terminal_events, vec!["TASK_COMPLETED"]);
    }

    /// 19절: 커밋 sha를 모르면 **아무것도 하지 않는다.** 추측으로 이력을 건드리지 않는다.
    #[test]
    fn revert_does_nothing_when_the_commit_cannot_be_identified() {
        let sink = Arc::new(RecordingSink::default());
        let (_ws, _art, host) = host_with_sink(sink);

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false));
        assert!(
            result
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("특정할 수 없습니다"),
            "{result}"
        );
    }

    /// revert가 **시작조차 못 한** 경우는 충돌이 아니다.
    ///
    /// 존재하지 않는 sha는 git이 아무것도 만들기 전에 거절한다. 치울 것이 없으므로
    /// `--abort`를 부르면 안 된다 — 그때 `REVERT_HEAD`가 있다면 그건 **남의 것**이다.
    #[test]
    fn revert_that_never_started_is_not_reported_as_a_conflict() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        host.append_event(
            "task-1",
            "GIT_COMMIT_CREATED",
            json!({ "sha": "0000000000000000000000000000000000000000", "paths": ["src/app.ts"], "branch": "main" }),
        )
        .unwrap();

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false));
        assert_eq!(result.get("conflicted").and_then(Value::as_bool), Some(false));
        assert_eq!(result.get("cleanedUp").and_then(Value::as_bool), Some(true));
        assert!(
            !ws.path().join(".git/REVERT_HEAD").exists(),
            "revert가 진행 중 상태로 남았습니다"
        );
    }

    /// **충돌하는 revert를 시도하고, 실패하면 우리가 되돌려 놓는다.**
    ///
    /// 예전에는 이 상황(커밋 위에 다른 커밋이 쌓임)에서 아무것도 하지 않고 거절했다. 지금은
    /// 시도한다 — 실패해도 저장소가 시작 전과 같아야 한다는 것이 이 테스트의 계약이다.
    ///
    /// 이 테스트가 없으면 조용히 깨지는 것: `run_command`는 0이 아닌 종료 코드를 `ToolStatus::Ok`로
    /// 보고하므로(tools/mod.rs), `status`만 보는 코드는 **충돌한 revert를 성공으로 읽는다.**
    #[test]
    fn revert_cleans_up_after_a_conflicting_revert() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        // 이 태스크의 커밋: 가운데 줄을 바꾼다.
        commit_as_task(&host, ws.path(), "task-1", "a\nB2\nc\n");
        // 그 위에 **같은 줄을** 바꾼 커밋이 쌓인다 → revert는 반드시 충돌한다.
        fs::write(ws.path().join("src/app.ts"), "a\nB3\nc\n").unwrap();
        git_at(ws.path(), &["add", "-A"]);
        git_at(ws.path(), &["commit", "-m", "someone else"]);

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false), "{result}");
        assert_eq!(
            result.get("conflicted").and_then(Value::as_bool),
            Some(true),
            "{result}"
        );
        assert_eq!(result.get("cleanedUp").and_then(Value::as_bool), Some(true), "{result}");

        // 충돌한 파일 목록은 `--abort` **전에** 읽어야만 남는다.
        let conflicts = result
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(
            conflicts.iter().any(|c| c.as_str() == Some("src/app.ts")),
            "충돌 파일 목록이 비었습니다: {result}"
        );

        // 저장소가 시작 전과 같다는 것은 **아무 일도 없었다는 뜻이 아니다** — 사용자가
        // 되돌리기를 눌렀고 우리가 하지 못했다는 사실이 이벤트로 남는다.
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"ROLLBACK_FAILED".to_string()), "{types:?}");
        assert!(!types.contains(&"ROLLBACK_COMPLETED".to_string()), "{types:?}");

        // 저장소는 시작 전과 같다: 진행 중인 revert도, 충돌 마커도, 미커밋 변경도 없다.
        assert!(
            !ws.path().join(".git/REVERT_HEAD").exists(),
            "revert가 진행 중 상태로 남았습니다"
        );
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), "a\nB3\nc\n");
        assert_eq!(git_at(ws.path(), &["status", "--porcelain"]).trim(), "");
    }

    /// **남이 시작한 revert 위에서는 시작하지 않는다.**
    ///
    /// 우리가 실패했을 때 부르는 `git revert --abort`는 진행 중인 revert를 구별하지 않는다.
    /// 사용자가 손으로 충돌을 절반쯤 풀어 놓은 상태에서 우리가 그걸 부르면 그 작업이 사라진다.
    /// 그래서 시작 전 `REVERT_HEAD` 검사는 **워킹 트리 검사보다 먼저**다.
    #[test]
    fn revert_refuses_while_another_revert_is_in_progress() {
        let sink = Arc::new(RecordingSink::default());
        let (ws, _art, host) = host_with_sink(sink);
        init_git_repo(ws.path());

        let sha = commit_as_task(&host, ws.path(), "task-1", "a\nB2\nc\n");
        fs::write(ws.path().join("src/app.ts"), "a\nB3\nc\n").unwrap();
        git_at(ws.path(), &["add", "-A"]);
        git_at(ws.path(), &["commit", "-m", "someone else"]);

        // 사용자가 직접 같은 revert를 시작해 충돌 상태에 있다.
        git_at(ws.path(), &["revert", "--no-edit", &sha]);
        assert!(
            ws.path().join(".git/REVERT_HEAD").exists(),
            "테스트 전제가 성립하지 않았습니다"
        );

        let result = host.revert_commit("task-1").unwrap();
        assert_eq!(result.get("reverted").and_then(Value::as_bool), Some(false), "{result}");
        let reason = result.get("reason").and_then(Value::as_str).unwrap_or("");
        assert!(reason.contains("이미 진행 중인 revert"), "{reason}");
        // 사용자의 진행 중 상태를 건드리지 않았다.
        assert!(
            ws.path().join(".git/REVERT_HEAD").exists(),
            "사용자가 진행 중이던 revert를 지웠습니다"
        );
    }

    #[test]
    fn rollback_restores_files_through_the_normal_tool_path() {
        let (ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        let original = fs::read_to_string(ws.path().join("src/app.ts")).unwrap();

        host.execute_tool(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-a\n+CHANGED\n" }),
        ))
        .unwrap();
        assert_ne!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), original);

        let result = host.rollback("task-1").unwrap();
        assert_eq!(result["failed"].as_array().unwrap().len(), 0);
        assert_eq!(fs::read_to_string(ws.path().join("src/app.ts")).unwrap(), original);

        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"ROLLBACK_STARTED".to_string()));
        assert!(types.contains(&"ROLLBACK_COMPLETED".to_string()));
    }

    #[test]
    fn unknown_method_is_rejected() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        assert!(host.handle_request("tool.executeUnchecked", &json!({})).is_err());
    }

    #[test]
    fn credential_get_is_not_exposed_over_ipc() {
        let (_ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        let err = host
            .handle_request("credential.get", &json!({ "providerId": "openai" }))
            .unwrap_err();
        assert!(err.contains("credential.get"));
    }

    #[test]
    fn tool_event_payload_does_not_inline_file_bodies() {
        let (_ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        let big = "x".repeat(50_000);
        host.execute_tool(&req(ToolName::CreateFile, json!({ "path": "big.txt", "content": big })))
            .unwrap();

        let events = host.with_store(|s| s.events("task-1")).unwrap();
        let requested = events.iter().find(|e| e.event_type == "TOOL_REQUESTED").unwrap();
        // 본문 전체가 아니라 크기 + preview만 남아야 한다.
        assert!(requested.payload["args"]["content"]["bytes"].as_u64().unwrap() == 50_000);
        let preview = requested.payload["args"]["content"]["preview"].as_str().unwrap();
        assert!(preview.len() < 1024);
    }

    #[test]
    fn verification_report_is_persisted_by_rust_not_node() {
        let (ws, _a, host) = host(
            TaskPolicy {
                auto_approve_workspace_writes: true,
                ..TaskPolicy::default()
            },
            Arc::new(AutoApprove),
        );
        fs::write(
            ws.path().join("package.json"),
            r#"{ "scripts": { "test": "node -e \"process.exit(0)\"" } }"#,
        )
        .unwrap();

        let out = host.run_verification("task-1", VerificationPhase::Post, 0).unwrap();
        assert!(out["report"]["reportId"].as_str().is_some());
        assert_eq!(host.with_store(|s| s.verification_report_count("task-1")).unwrap(), 1);
        let types = host.with_store(|s| s.event_types("task-1")).unwrap();
        assert!(types.contains(&"VERIFICATION_COMPLETED".to_string()));
    }
}
