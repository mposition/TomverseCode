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
use crate::paths::WorkspaceRoot;
use crate::policy::{parse_run_command, PolicyGate};
use crate::sidecar::SidecarHandler;
use crate::store::Store;
use crate::time::now_iso;
use crate::tools::{ToolRuntime, MAX_INLINE_OUTPUT_BYTES};
use crate::types::{
    ApprovalRequest, ApprovalRequestItem, PolicyDecision, TaskPolicy, ToolName, ToolRequest, ToolResult, ToolStatus,
    VerificationPhase, VerificationReport,
};
use crate::verify::{CommandExecutor, VerificationRunner};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
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
    store: Mutex<Store>,
    artifacts: ArtifactStore,
    approvals: Arc<dyn ApprovalGateway>,
    sink: Arc<dyn EventSink>,
    /// 태스크별이 아니라 호스트별 취소 플래그. M0는 동시에 한 태스크만 다룬다
    /// (product-strategy.md 8.2절 "다중 태스크 동시 실행"은 이후 깊이 확장 항목).
    cancelled: AtomicBool,
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
        store: Store,
        artifacts: ArtifactStore,
        approvals: Arc<dyn ApprovalGateway>,
        sink: Arc<dyn EventSink>,
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
            store: Mutex::new(store),
            artifacts,
            approvals,
            sink,
            cancelled: AtomicBool::new(false),
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

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn collected_diffs(&self) -> Vec<(String, String)> {
        self.diffs.lock().unwrap().clone()
    }

    pub fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> T) -> T {
        let mut guard = self.store.lock().unwrap();
        f(&mut guard)
    }

    /// 이벤트 로그 기록 + UI 릴레이. 이벤트 없이 상태가 바뀌지 않도록 모든 상태 변화가 이걸 지난다.
    pub fn append_event(&self, task_id: &str, event_type: &str, payload: Value) -> Result<Value, String> {
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
        // 0) 취소 확인. 취소된 태스크의 도구는 실행하지 않는다.
        if self.is_cancelled() {
            let result = ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Denied,
                output: None,
                error: Some("태스크가 취소됨".to_string()),
                duration_ms: 0,
                completed_at: now_iso(),
            };
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
            let _ = self.append_event(
                &request.task_id,
                "APPROVAL_REQUESTED",
                serde_json::to_value(&approval).unwrap_or(Value::Null),
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
        let outcome = self.runtime.execute(request, &decision, approved);

        // 4) 결과 기록. 파일 변경이면 mutation과 diff도.
        self.with_store(|s| s.record_tool_result(&outcome.result, outcome.output_ref.as_deref()))
            .map_err(|e| format!("tool_result 기록 실패: {e}"))?;

        if let Some(mutation) = &outcome.mutation {
            self.with_store(|s| s.record_file_mutation(mutation))
                .map_err(|e| format!("file_mutation 기록 실패: {e}"))?;
            let _ = self.append_event(
                &request.task_id,
                "FILE_MUTATED",
                json!({
                    "requestId": mutation.request_id,
                    "path": mutation.path,
                    "preExisted": mutation.pre_image.existed,
                    "postExists": mutation.post_image.existed,
                }),
            );
        }
        if let Some(diff) = &outcome.diff {
            let path = outcome
                .mutation
                .as_ref()
                .map(|m| m.path.clone())
                .unwrap_or_else(|| "(unknown)".to_string());
            self.diffs.lock().unwrap().push((path, diff.clone()));
        }

        let _ = self.append_event(
            &request.task_id,
            "TOOL_COMPLETED",
            json!({
                "requestId": outcome.result.request_id,
                "status": outcome.result.status,
                "error": outcome.result.error,
                "durationMs": outcome.result.duration_ms,
                "outputRef": outcome.output_ref,
                // 큰 출력은 이미 artifact에 있으므로 이벤트에는 요약만 남긴다.
                "output": summarize_output(outcome.result.output.as_ref()),
            }),
        );

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
        let runner = VerificationRunner::new(&self.root, &self.artifacts);
        let baseline = self.baseline.lock().unwrap().clone();
        let mut executor = HostExecutor { host: self };

        let report = runner.run(task_id, phase, attempt_number, &mut executor, baseline.as_ref());

        self.with_store(|s| s.record_verification_report(&report))
            .map_err(|e| format!("verification_report 기록 실패: {e}"))?;
        let _ = self.append_event(
            task_id,
            "VERIFICATION_COMPLETED",
            serde_json::to_value(&report).unwrap_or(Value::Null),
        );

        if phase == VerificationPhase::Baseline {
            *self.baseline.lock().unwrap() = Some(report.clone());
        }

        Ok(json!({ "report": report }))
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
            let outcome = self.runtime.execute(&request, &decision, true);
            self.with_store(|s| s.record_tool_request(&request, "rollback", &decision))
                .ok();
            self.with_store(|s| s.record_tool_result(&outcome.result, None)).ok();
            match outcome.result.status {
                ToolStatus::Ok => restored.push(request.args.get("path").cloned().unwrap_or(Value::Null)),
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
/// secret은 애초에 컨텍스트에 들어가지 않지만(context-engine.md 7절), 파일 본문 전체를
/// 이벤트에 인라인하면 로그가 비대해진다.
fn redact_args(args: &Value) -> Value {
    let Some(obj) = args.as_object() else {
        return args.clone();
    };
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        match (k.as_str(), v) {
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
        store.create_task("task-1", "sess-1", "ws-1", "fix").unwrap();
        let root = WorkspaceRoot::new(ws.path()).unwrap();
        let host = TaskHost::new(root, policy, store, artifacts, approvals, Arc::new(NullSink));
        (ws, art, host)
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
    fn cancelled_host_refuses_tool_execution() {
        let (ws, _a, host) = host(TaskPolicy::default(), Arc::new(AutoApprove));
        host.cancel();
        let out = host
            .execute_tool(&req(ToolName::CreateFile, json!({ "path": "new.ts", "content": "x" })))
            .unwrap();
        assert_eq!(out["result"]["status"].as_str().unwrap(), "denied");
        assert!(!ws.path().join("new.ts").exists());
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
