//! 감사 export — product-strategy.md 6절 "Agent Trace 완성".
//!
//! # `show`와 무엇이 다른가
//!
//! `show`는 **진단용 덤프**다. 모양이 바뀌어도 되고, 바뀐다. export는 **몇 년 뒤에 읽힐 기록**이라
//! 다른 것을 약속해야 한다.
//!
//! | | `show` | `export` |
//! |---|---|---|
//! | 형식 안정성 | 없음 | `formatVersion`으로 고정 |
//! | 도구 args(argv·patch) | 없음 | 있음 — 원칙 6의 약속을 사후에 확인하려면 필요하다 |
//! | 공급자 호출 원본 | 없음 | 있음 (응답 모델 포함) |
//! | 워크스페이스 지문 | 이벤트 안에 묻힘 | 최상위 — 재현의 전제이기 때문 |
//! | 무엇을 보장하는가 | 적지 않음 | **파일 안에 적는다** |
//!
//! 마지막 줄이 핵심이다. **무엇을 보장하는지 적지 않은 감사 기록은 읽는 사람이 더 많은 것을
//! 보장한다고 가정하게 만든다.** 그래서 `guarantees` 블록이 파일 맨 앞에 온다.
//!
//! # 재현(reproduce)과 재실행(re-run)을 섞지 않는다
//!
//! 6절이 미리 못박아둔 구분이다. LLM은 결정론적이지 않으므로 "같은 입력이면 같은 결과"는
//! 보장할 수 없다.
//!
//! - **재현** — 기록된 patch·명령을 그대로 다시 적용해 최종 상태를 복원한다. 결정론적이고
//!   보장 가능하며, **기업 감사에 필요한 것은 이쪽이다.**
//! - **재실행** — 같은 프롬프트로 모델을 다시 부른다. 비결정론적이고 비교 분석용이다.
//!
//! 이 파일은 **재현의 재료**를 담는다(`reproduce.steps`). 재현을 **수행**하지는 않는다 —
//! 그 러너는 아직 없고, 없는 것을 있는 것처럼 적지 않는다.
//!
//! # artifact 본문은 담지 않는다
//!
//! 검증 출력과 큰 도구 출력은 artifact 저장소에 있고 export에는 **참조만** 들어간다.
//! 이유는 크기가 아니라 성질이다: artifact에는 빌드 로그가 통째로 들어 있고, 거기에는 환경변수
//! 이름·경로·사내 호스트명이 섞인다. export는 **밖으로 나가라고 만든 파일**이므로 기본이
//! 보수적이어야 한다. 필요하면 artifact를 따로 첨부하는 것이 사용자의 선택이다.

use crate::store::Store;
use serde_json::{json, Value};

/// export 형식 버전. **모양을 바꾸면 반드시 올린다** — 읽는 쪽이 옛 파일을 새 규칙으로 읽으면
/// 조용히 틀린 해석을 한다.
/// | 버전 | 바뀐 것 |
/// |---|---|
/// | 1 | 최초 |
/// | 2 | `fileMutations`에 내용 해시(`preSha256`/`postSha256`)와 존재 여부가 들어갔다. **재현기가 "기록과 같은 내용이 됐는가"를 판정할 수 있게 하려는 것**이다 — 그 전까지 재현기가 말할 수 있는 것은 "단계가 다 돌았다"뿐이었고, 그건 6.3절이 약속한 "최종 상태 복원"의 확인이 아니었다 |
pub const EXPORT_FORMAT_VERSION: u32 = 2;

/// 한 태스크의 감사 기록을 만든다. **아무것도 쓰지 않는다.**
pub fn collect(store: &Store, task_id: &str) -> Result<Value, String> {
    let task = store
        .get_task(task_id)
        .map_err(|e| format!("작업 조회 실패: {e}"))?
        .ok_or_else(|| format!("작업을 찾을 수 없습니다: {task_id}"))?;

    let events = store.events(task_id).map_err(|e| format!("이벤트 조회 실패: {e}"))?;
    let requests = store
        .tool_requests_full(task_id)
        .map_err(|e| format!("도구 요청 조회 실패: {e}"))?;

    // 워크스페이스 지문은 **최상위로 올린다.** 재현의 전제이므로 이벤트 목록 안에 묻혀 있으면
    // 읽는 사람이 그 전제를 확인하지 않고 재현을 시도하게 된다.
    let fingerprint = events
        .iter()
        .rev()
        .find(|e| e.event_type == "WORKSPACE_FINGERPRINT")
        .map(|e| e.payload.clone());

    Ok(json!({
        "formatVersion": EXPORT_FORMAT_VERSION,
        "exportedAt": crate::time::now_iso(),

        // **이 파일이 무엇을 보장하는지 파일 안에 적는다.** 적지 않으면 읽는 사람이 더 많은
        // 것을 보장한다고 가정한다.
        "guarantees": {
            "record": "이 파일은 기록이다 — 무엇이 요청됐고 무엇이 실행됐고 무엇이 검증됐는가.",
            "reproduce": "아래 reproduce.steps를 그대로 다시 적용하면 최종 파일 상태를 복원할 수 있다. 결정론적이다. 다만 이 파일은 재현의 재료일 뿐이고, 재현을 수행하지는 않는다.",
            "reRun": "같은 프롬프트로 모델을 다시 부르는 것은 이 파일이 보장하지 않는다 — LLM은 결정론적이지 않으므로 같은 결과가 나온다는 보장이 없다. 재현과 섞어 읽지 말 것.",
            "artifacts": "검증 출력 등 artifact 본문은 포함하지 않는다. 참조만 들어 있고 본문은 로컬에 남는다.",
            "startingState": "재현은 워크스페이스가 workspaceFingerprint와 같은 상태일 때만 의미가 있다. 지문이 없거나(available:false) 다르면 재현 결과가 기록과 달라질 수 있다.",
            "expectedFinalState": "fileMutations의 postSha256/postExisted가 기록된 최종 내용이다. 재현이 실제로 복원됐는지는 단계가 다 돌았는지가 아니라 이 값과의 대조로 판정한다. 해시가 없는 항목(형식 v1로 만들어진 기록)은 '같다'가 아니라 '판정할 수 없다'이다.",
        },

        "task": task,
        "workspaceFingerprint": fingerprint,

        // 재현의 재료 — **상태를 바꾼 요청만** 시간순으로 추린다. 읽기 전용 요청까지 넣으면
        // "이걸 다시 실행하면 된다"는 목록이 아니게 된다.
        "reproduce": {
            "note": "기록된 순서대로 다시 적용하면 최종 상태가 복원된다. 승인이 거부되어 실행되지 않은 요청은 여기 없다.",
            "steps": reproduce_steps(&requests, store, task_id)?,
        },

        "events": events.iter().map(|e| json!({
            "eventId": e.event_id,
            "seq": e.seq,
            "type": e.event_type,
            "phase": e.phase,
            "payload": e.payload,
            "createdAt": e.created_at,
        })).collect::<Vec<_>>(),

        // argv·patch 원문. **이게 없으면 "승인 화면에 보인 것이 실제 실행된 것"이라는 약속을
        // 사후에 확인할 수 없다**(원칙 6).
        "toolRequests": requests,
        "toolExecutions": store.tool_executions(task_id).map_err(|e| format!("도구 조회 실패: {e}"))?,
        "fileMutations": store.mutation_records(task_id).map_err(|e| format!("변경 조회 실패: {e}"))?,
        "verificationChecks": store.verification_checks(task_id).map_err(|e| format!("검증 조회 실패: {e}"))?,
        "acceptanceCriteria": store.acceptance_criteria(task_id).map_err(|e| format!("기준 조회 실패: {e}"))?,
        "providerUsage": store.provider_usage_rows(task_id).map_err(|e| format!("사용량 조회 실패: {e}"))?,
    }))
}

/// 상태를 바꾼, **실제로 실행된** 요청만 시간순으로.
///
/// 두 가지를 걸러낸다.
///
/// - **읽기 전용 도구**(`read_file`·`search_text`·`list_files`): 다시 실행해도 상태가 바뀌지
///   않으므로 재현 목록에 있으면 잡음이다.
/// - **실행되지 않은 요청**: 정책이 막았거나 사용자가 거부한 것. 그걸 재현 목록에 넣으면
///   **거부된 동작을 다시 하라고 말하는 파일**이 된다.
///
/// 그리고 남은 것에 `recordedOutcome`을 붙인다. **`status: "ok"`는 "명령이 성공했다"가
/// 아니기 때문이다** — `run_command`는 0이 아닌 종료 코드를 "도구 실행 실패"가 아니라
/// "명령이 실패했다는 사실"로 다뤄 `status`를 `Ok`로 둔다. 종료 코드를 빼고 내보내면 읽는
/// 사람은 이 목록을 "전부 성공한 단계들"로 읽는다.
fn reproduce_steps(requests: &[Value], store: &Store, task_id: &str) -> Result<Vec<Value>, String> {
    let executions = store
        .tool_executions(task_id)
        .map_err(|e| format!("도구 조회 실패: {e}"))?;
    let from_events = exit_codes_from_events(store, task_id);

    let mut steps = Vec::new();
    for req in requests {
        let tool = req.get("tool").and_then(Value::as_str).unwrap_or("");
        if !mutates_state(tool) {
            continue;
        }
        let id = req.get("requestId").and_then(Value::as_str).unwrap_or("");
        let Some(exec) = executions.iter().find(|ex| {
            ex.get("requestId").and_then(Value::as_str) == Some(id)
                && ex.get("executionStatus").and_then(Value::as_str) == Some("ok")
        }) else {
            continue;
        };

        let mut step = req.clone();
        if let Some(obj) = step.as_object_mut() {
            obj.insert(
                "recordedOutcome".into(),
                json!({
                    "status": exec.get("executionStatus").cloned().unwrap_or(Value::Null),
                    "exitCode": recorded_exit_code(store, exec)
                        .or_else(|| from_events.get(id).copied().flatten()),
                    "note": "status는 도구가 끝까지 돌았다는 뜻이고, 명령의 성공 여부는 exitCode가 말한다. exitCode가 null이면 종료 코드를 갖지 않는 도구이거나 출력 기록을 읽지 못한 것이다.",
                }),
            );
        }
        steps.push(step);
    }
    Ok(steps)
}

/// 이벤트 로그에서 요청별 종료 코드를 모은다.
///
/// artifact만 보면 **대부분의 명령에서 종료 코드를 잃는다.** 출력이 16KB 이하면 artifact가
/// 아예 만들어지지 않기 때문이다 — 그런데 `task_events`는 진실의 원천이고(원칙 7)
/// `TOOL_COMPLETED` 페이로드가 그 값을 이미 담고 있다. 없는 것을 새로 저장하는 대신
/// 있는 곳에서 읽는다.
///
/// 값이 `Some(None)`인 항목은 "이벤트는 있었는데 종료 코드가 없었다"이다 — 종료 코드를 갖지
/// 않는 도구가 그렇다. 키가 없는 것("그런 요청의 이벤트를 못 찾았다")과 다르므로 합치지 않는다.
fn exit_codes_from_events(store: &Store, task_id: &str) -> std::collections::HashMap<String, Option<i64>> {
    let mut out = std::collections::HashMap::new();
    let Ok(events) = store.events(task_id) else {
        return out;
    };
    for event in events {
        if event.event_type != "TOOL_COMPLETED" {
            continue;
        }
        let Some(request_id) = event.payload.get("requestId").and_then(Value::as_str) else {
            continue;
        };
        let code = event
            .payload
            .get("output")
            .and_then(|o| o.get("exitCode"))
            .and_then(Value::as_i64);
        out.insert(request_id.to_string(), code);
    }
    out
}

/// 도구 출력 artifact에서 **종료 코드만** 꺼낸다.
///
/// 본문(빌드 로그 등)은 여전히 export에 넣지 않는다 — 꺼내는 것은 정수 하나다. 실패해도
/// `None`이고 오류를 올리지 않는다: 로그 파일 하나를 읽지 못했다고 감사 기록 전체를 못 만들면
/// 기록이 가장 필요한 상황(디스크가 어질러진 사후 조사)에서 아무것도 나오지 않는다.
fn recorded_exit_code(store: &Store, exec: &Value) -> Option<i64> {
    let output_ref = exec.get("outputRef").and_then(Value::as_str)?;
    let text = store.artifacts().read_text(output_ref).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("exitCode")
        .and_then(Value::as_i64)
}

/// 이 도구가 워크스페이스 상태를 바꾸는가.
///
/// **모르는 도구는 바꾼다고 본다.** 새 도구가 생겼을 때 재현 목록에서 조용히 빠지는 것보다,
/// 들어가서 눈에 띄는 편이 낫다 — 빠진 것은 아무도 알아채지 못한다.
///
/// `run_tests`는 목록에 없다. 테스트 실행은 최종 파일 상태를 만드는 단계는 아니지만 빌드
/// 산출물을 남기므로, 보수적 기본값을 그대로 따른다.
fn mutates_state(tool: &str) -> bool {
    !matches!(
        tool,
        "read_file" | "search_text" | "list_files" | "git_status" | "git_diff"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifacts::ArtifactStore;
    use crate::types::{Decision, PolicyDecision, RiskLevel, ToolName, ToolRequest, ToolResult, ToolStatus};

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

    fn decision(id: &str, d: Decision) -> PolicyDecision {
        PolicyDecision {
            request_id: id.into(),
            decision: d,
            risk_level: RiskLevel::Medium,
            matched_rule: "test".into(),
            reason: "test".into(),
            requires_user_approval: false,
            normalized_target: String::new(),
            decided_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    /// 요청만 기록한다 — 실행되지 않은(정책이 막았거나 승인 대기인) 요청을 만드는 데 쓴다.
    fn request(store: &Store, id: &str, tool: ToolName, args: serde_json::Value) {
        let req = ToolRequest {
            request_id: id.into(),
            task_id: "task-1".into(),
            tool,
            args,
            risk_tier: None,
            requested_by: json!({ "role": "executor" }),
            created_at: Some(format!("2026-01-01T00:00:{id:0>2}Z")),
        };
        store
            .record_tool_request(&req, "plan-1", &decision(id, Decision::AutoApprove))
            .unwrap();
    }

    /// 요청 + 실행 결과. `output`이 있으면 artifact로 저장되어 종료 코드를 꺼낼 수 있다.
    fn executed(
        store: &Store,
        id: &str,
        tool: ToolName,
        args: serde_json::Value,
        status: ToolStatus,
        output: Option<serde_json::Value>,
    ) {
        request(store, id, tool, args);
        let output_ref = output.map(|o| {
            store
                .artifacts()
                .put_text("task-1", &format!("{id}.json"), &o.to_string())
                .unwrap()
                .artifact_ref
        });
        store
            .record_tool_result(
                &ToolResult {
                    request_id: id.into(),
                    status,
                    output: None,
                    error: None,
                    duration_ms: 5,
                    completed_at: "2026-01-01T00:01:00Z".into(),
                    denial_kind: None,
                },
                output_ref.as_deref(),
            )
            .unwrap();
    }

    /// **형식 버전과 보장 범위가 파일 안에 있어야 한다.** 둘 다 이 파일이 `show` 덤프와
    /// 다른 물건이라는 근거이고, 없으면 읽는 사람이 스스로 가정을 채운다.
    #[test]
    fn the_file_states_its_own_version_and_what_it_guarantees() {
        let (_d, store) = seeded();
        let out = collect(&store, "task-1").unwrap();

        assert_eq!(out["formatVersion"], json!(EXPORT_FORMAT_VERSION));
        let g = &out["guarantees"];
        // 재현과 재실행이 **둘 다** 명시되어야 한다 — 하나만 적으면 나머지 하나를 독자가
        // 같은 것으로 읽는다. 6절이 섞지 말라고 못박은 지점이다.
        assert!(g["reproduce"].is_string());
        assert!(g["reRun"].is_string());
        assert!(g["artifacts"].is_string());
        assert!(g["startingState"].is_string());
    }

    /// 지문은 이벤트 목록 **안**이 아니라 최상위에 있어야 한다. 재현의 전제이기 때문이다.
    #[test]
    fn the_workspace_fingerprint_is_hoisted_to_the_top_level() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "WORKSPACE_FINGERPRINT",
                &json!({ "available": true, "fingerprint": "sha256:abc", "dirty": false }),
            )
            .unwrap();

        let out = collect(&store, "task-1").unwrap();
        assert_eq!(out["workspaceFingerprint"]["fingerprint"], json!("sha256:abc"));
    }

    /// **출력이 작으면 artifact가 아예 없다** — 그런데 종료 코드는 있어야 한다.
    ///
    /// 이게 실제로 뚫려 있던 구멍이다: `run_command` 출력이 16KB 이하면 artifact가 만들어지지
    /// 않으므로 artifact만 보는 경로는 종료 코드를 잃었고, 그 결과 감사 기록이 **명령의 성공
    /// 여부를 말하지 못했다.** `task_events`가 진실의 원천이므로(원칙 7) 거기서 읽는다.
    #[test]
    fn the_exit_code_survives_when_the_output_was_too_small_for_an_artifact() {
        let (_d, mut store) = seeded();
        // artifact 없이 실행된 명령 — output_ref가 없다.
        executed(
            &store,
            "01",
            ToolName::RunCommand,
            json!({ "program": "npm" }),
            ToolStatus::Ok,
            None,
        );
        store
            .append_event(
                "task-1",
                "TOOL_COMPLETED",
                &json!({ "requestId": "01", "status": "ok", "output": { "exitCode": 1 } }),
            )
            .unwrap();

        let out = collect(&store, "task-1").unwrap();
        let step = &out["reproduce"]["steps"][0];
        assert_eq!(step["requestId"], json!("01"));
        assert_eq!(
            step["recordedOutcome"]["exitCode"],
            json!(1),
            "출력이 작았다는 이유로 종료 코드가 사라졌습니다: {step}"
        );
    }

    /// **재현의 판정 재료가 export에 있어야 한다.** 내용 해시가 빠지면 재현기가 말할 수 있는
    /// 것은 "단계가 다 돌았다"뿐이고, 그건 6.3절이 약속한 "최종 상태 복원"의 확인이 아니다.
    /// 본문은 여전히 넣지 않는다 — 해시는 판정에 충분하고, 본문은 밖으로 나가면 안 된다.
    #[test]
    fn file_mutations_carry_content_hashes_but_not_content() {
        let (_d, store) = seeded();
        request(
            &store,
            "01",
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@" }),
        );
        store
            .record_file_mutation(&crate::types::FileMutationRecord {
                request_id: "01".into(),
                task_id: "task-1".into(),
                path: "src/app.ts".into(),
                pre_image: crate::types::ImageRef {
                    existed: true,
                    content_ref: Some("artifact://pre".into()),
                    sha256: Some("sha-before".into()),
                },
                post_image: crate::types::ImageRef {
                    existed: true,
                    content_ref: Some("artifact://post".into()),
                    sha256: Some("sha-after".into()),
                },
            })
            .unwrap();

        let out = collect(&store, "task-1").unwrap();
        let m = &out["fileMutations"][0];
        assert_eq!(m["postSha256"], json!("sha-after"), "{m}");
        assert_eq!(m["preSha256"], json!("sha-before"), "{m}");
        assert_eq!(m["postExisted"], json!(true), "{m}");
        // 본문 참조는 나가지 않는다 — artifact를 빼기로 한 결정이 여기서도 유지된다.
        let text = serde_json::to_string(&out).unwrap();
        assert!(
            !text.contains("artifact://post"),
            "artifact 참조가 export에 들어갔습니다"
        );
        // 그리고 보장 블록이 이 재료로 무엇을 하는지 말해야 한다.
        assert!(out["guarantees"]["expectedFinalState"].is_string());
    }

    /// 지문이 아예 없는 실행도 export는 나와야 하되, **없다는 사실이 보여야 한다.**
    /// 빈 값을 "깨끗한 상태였다"로 읽게 두면 안 된다.
    #[test]
    fn a_missing_fingerprint_is_null_not_omitted() {
        let (_d, store) = seeded();
        let out = collect(&store, "task-1").unwrap();
        assert!(out.get("workspaceFingerprint").is_some(), "키 자체가 빠졌습니다");
        assert!(out["workspaceFingerprint"].is_null());
    }

    /// **재현 목록은 "다시 실행하면 되는 것"의 목록이다.** 읽기 전용 도구는 다시 실행해도
    /// 상태가 그대로이므로 여기 있으면 잡음이고, 거부된 요청이 여기 있으면 그 파일은
    /// **거부된 동작을 다시 하라고 말하는 파일**이 된다.
    #[test]
    fn reproduce_steps_exclude_read_only_tools_and_requests_that_never_ran() {
        let (_d, store) = seeded();
        executed(
            &store,
            "01",
            ToolName::ReadFile,
            json!({ "path": "src/app.ts" }),
            ToolStatus::Ok,
            None,
        );
        executed(
            &store,
            "02",
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@" }),
            ToolStatus::Ok,
            None,
        );
        // 승인이 거부되어 결과가 없는 요청.
        request(&store, "03", ToolName::DeleteFile, json!({ "path": "src/gone.ts" }));
        // 실행은 됐지만 실패한 도구.
        executed(
            &store,
            "04",
            ToolName::CreateFile,
            json!({ "path": "src/new.ts" }),
            ToolStatus::Error,
            None,
        );

        let out = collect(&store, "task-1").unwrap();
        let steps = out["reproduce"]["steps"].as_array().unwrap();
        let ids: Vec<&str> = steps.iter().map(|s| s["requestId"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["02"], "재현 목록: {ids:?}");

        // 걸러낸 것들은 **기록에서는 사라지지 않는다** — 재현 목록에서만 빠진다.
        let all = out["toolRequests"].as_array().unwrap();
        assert_eq!(all.len(), 4);
        // argv·patch 원문이 남아야 원칙 6의 약속을 사후에 확인할 수 있다.
        assert_eq!(all[1]["args"]["patch"], json!("@@"));
    }

    /// **`status: "ok"`는 "명령이 성공했다"가 아니다.** `run_command`는 0이 아닌 종료 코드를
    /// "명령이 실패했다는 사실"로 다뤄 status를 Ok로 두므로, 종료 코드를 빼고 내보내면 읽는
    /// 사람은 재현 목록을 "전부 성공한 단계들"로 읽는다.
    #[test]
    fn a_failed_command_is_not_reported_as_a_successful_step() {
        let (_d, store) = seeded();
        executed(
            &store,
            "01",
            ToolName::RunCommand,
            json!({ "program": "npm", "args": ["test"] }),
            ToolStatus::Ok,
            Some(json!({ "exitCode": 1, "stdout": "1 failing", "stderr": "" })),
        );

        let out = collect(&store, "task-1").unwrap();
        let step = &out["reproduce"]["steps"][0];
        assert_eq!(step["recordedOutcome"]["status"], json!("ok"));
        assert_eq!(step["recordedOutcome"]["exitCode"], json!(1));
        // 본문은 여전히 나가지 않는다 — 꺼낸 것은 정수 하나다.
        assert!(
            !serde_json::to_string(&out).unwrap().contains("1 failing"),
            "artifact 본문이 export에 실렸습니다"
        );
    }

    /// 새 도구가 생겼을 때 재현 목록에서 **조용히 빠지는** 편보다 들어가서 눈에 띄는 편이 낫다.
    #[test]
    fn an_unknown_tool_is_treated_as_state_changing() {
        assert!(mutates_state("some_future_tool"));
        assert!(!mutates_state("read_file"));
        // git 조회는 알려진 읽기 전용이다.
        assert!(!mutates_state("git_diff"));
    }

    /// 없는 작업을 빈 export로 내주면 **아무 일도 없었던 기록**처럼 보인다.
    #[test]
    fn an_unknown_task_is_an_error_not_an_empty_record() {
        let (_d, store) = seeded();
        assert!(collect(&store, "task-없음").is_err());
    }
}
