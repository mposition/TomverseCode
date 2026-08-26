//! 데이터 전송 투명성 — **무엇이 어느 공급자로 나갔는가** (product-strategy.md 7절).
//!
//! # 왜 이게 우리에게 저렴한가
//!
//! 컨텍스트를 모으는 경로가 하나(Context Engine)이고, 공급자 호출이 한 곳(Node sidecar)을
//! 지나며, 둘 다 이벤트로 남는다. 그래서 새로 계측할 것이 거의 없고 **이미 있는 사실을 잇기만
//! 하면 된다.** 사후에 추가하려면 컨텍스트 수집 경로 전체를 계측해야 하는 제품들과 다른 지점이다.
//!
//! # 이 집계가 말할 수 있는 것과 없는 것
//!
//! 말할 수 있는 것: 어떤 파일이 스냅샷에 담겼고, 어떤 공급자가 몇 번 호출됐고, 토큰이 얼마나
//! 나갔는가. **모든 프롬프트가 같은 스냅샷을 싣기 때문에**(providers/prompts.ts의 빌더가
//! 전부 `renderSnapshot`을 쓴다) "이 파일들이 이 공급자들 각각에게 갔다"고 말할 수 있다.
//!
//! **그 전제는 이제 검사된다.** 한동안 이 문장은 TypeScript 코드에 대한 주장을 Rust 주석에
//! 적어둔 것이었고 아무도 대조하지 않았다 — 빌더가 하나 늘거나 하나가 `renderSnapshot`을
//! 멈추면 이 화면이 **가지 않은 파일을 갔다고** 말하게 된다. 지금은
//! `packages/sidecar/test/transmissionClaim.test.ts`가 소스에서 빌더를 찾아 대조한다.
//! 개수("네 빌더")를 여기 적지 않는 이유도 같다: 숫자를 적으면 늘었을 때 이 주석이 낡는다.
//!
//! 말할 수 없는 것: 공급자가 그것을 어떻게 보관·학습하는가. 그건 우리 계측의 범위 밖이고,
//! 화면이 그 부분을 흐리게 말하면 안 된다.
//!
//! # 두 개의 함정 — 정직하게 말하지 않으면 정반대로 읽힌다
//!
//! **① 제외된 파일도 "이름은" 나간다.** `.env` 같은 파일은 내용이 컨텍스트에 들어가지 않지만,
//! 프롬프트에는 "다음 파일들은 일부러 제외했다"는 목록으로 **경로와 사유가 실린다**
//! (`renderSnapshot`의 "Files deliberately excluded from context"). 모델이 그 파일을 있다고
//! 착각해 추측하는 것을 막으려는 것인데, 그 대가로 경로 이름은 나간다. 화면이 이걸
//! "Local only"라고만 쓰면 **경로도 안 나간 것으로 읽힌다.**
//!
//! **② 마스킹은 저장 기록에만 걸린다.** `USER_DECISION_RECORDED`의 `secretShapesMasked`는
//! **DB에 남기기 전에** 가린 개수이고, 같은 답변은 프롬프트에 원문으로 실려 나간다(17.11절).
//! 이 숫자를 전송 화면에 그냥 올리면 "가려져서 안 나갔다"로 읽히는데 정반대다.

use crate::store::Store;
use serde_json::Value;

/// 한 공급자에게 나간 것.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ProviderTransmission {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub calls: u64,
    /// 어떤 역할로 불렸는가 (executor / co-executor / reviewer …). 중복 없이 정렬된다.
    pub roles: Vec<String>,
    /// **요청한** 모델. 우리가 보낸 값이라 언제나 우리 기대와 같다.
    pub models: Vec<String>,
    /// **공급자가 응답했다고 밝힌** 모델. 비어 있으면 "같았다"가 아니라 **"기록하기 전이었다"**
    /// 또는 공급자가 알려주지 않았다는 뜻이다(스키마 v4 이전 행).
    #[serde(rename = "resolvedModels")]
    pub resolved_models: Vec<String>,
    /// 요청한 모델과 응답한 모델이 다른 호출이 있었는가 — **조용한 대체**.
    ///
    /// 이걸 화면에 올리는 이유: 감사 기록이 요청값만 남기면 대체가 일어났다는 사실이 지워진다.
    /// 모르는 것(둘 중 하나가 없음)은 대체로 세지 않는다 — 모름을 사고로 보고하면
    /// 진짜 사고가 묻힌다.
    pub substituted: bool,
    /// 공급자 쪽 요청 id. **감사에서 공급자 로그와 대조할 수 있는 유일한 열쇠다** —
    /// 우리 `callId`는 우리만 아는 값이라 상대에게 물을 수 없다.
    #[serde(rename = "providerRequestIds")]
    pub provider_request_ids: Vec<String>,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
}

/// 컨텍스트에 실려 나간 파일 하나.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SentFile {
    pub path: String,
    /// 왜 골랐는가. 사용자가 "이건 왜 나갔나"를 물을 수 있어야 투명성이다.
    pub reason: String,
    /// 잘려서 일부만 나갔는가.
    pub truncated: bool,
}

/// 내용은 빼고 **이름만** 나간 파일.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NamedOnlyFile {
    pub path: String,
    pub reason: String,
}

/// **파일이 아닌데 프롬프트에 실려 나가는 것.**
///
/// 이게 없던 동안 화면은 파일 목록만 보여줬고, 그건 "나간 것은 이 파일들뿐"으로 읽혔다.
/// 실제로는 프로젝트 규칙 전문과 커밋되지 않은 변경 요약이 매 호출마다 함께 나가고 있었다
/// (7.2절).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SentContext {
    /// `renderSnapshot`이 만드는 섹션과 짝이다 — 아래 `REPORTED_SECTIONS` 참조.
    pub section: String,
    /// 사람이 읽는 설명. "무엇이" 나갔는지를 말한다.
    pub detail: String,
    /// 프롬프트에 실린 크기. **0이 "안 나갔다"는 뜻이 아니다** — 섹션 제목은 언제나 나간다.
    pub bytes: u64,
    /// 이 내용이 온 파일들(있으면). 프로젝트 규칙은 파일에서 오지만 `sentFiles`에는 없다 —
    /// 컨텍스트 엔진이 고른 것이 아니라 항상 실리는 것이라 경로가 다르다.
    pub sources: Vec<String>,
}

/// 프롬프트에 실리는 섹션의 **분류**. 세 목록의 합집합이 `prompts.ts`의 모든 섹션이어야 한다.
///
/// # 왜 셋인가
///
/// 처음에는 "집계가 설명하는가"만 물었다. 그런데 섹션을 전부 뽑아 보니 축이 둘이 아니었다:
/// 우리가 모델에게 주는 **지시문**(출력 형식 규칙 같은 것)에는 사용자 데이터가 없고, 그걸
/// 화면에 "나갔습니다"로 올리면 진짜 데이터가 그 안에 묻힌다. 반대로 **나가는데 아직 세지
/// 못하는 것**도 있다 — 그걸 지시문 칸에 넣으면 거짓이 되고, 설명한다고 적으면 더 큰 거짓이
/// 된다. 그래서 "아직 세지 않는다"를 **적어 두는 칸**을 만들었다.
///
/// 셋으로 나눈 덕분에 이 목록 자체가 7.2절의 남은 과제 목록이 된다.
///
/// `packages/sidecar/test/transmissionClaim.test.ts`가 `prompts.ts`에서 섹션을 뽑아 이
/// 목록들과 대조한다 — 새 섹션은 **누군가 여기서 결정을 내려야** 통과한다.

/// 화면이 무엇이 나갔는지 실제로 설명하는 섹션.
pub const REPORTED_SECTIONS: &[&str] = &[
    "Repository state",
    "Project",
    "Project rules",
    "Decisions carried from earlier tasks",
    "Skill instructions",
    "MCP tools available",
    "MCP tool results",
    "Files",
    "Files deliberately excluded from context",
];

/// **우리가 모델에게 주는 지시문.** 사용자 데이터가 들어 있지 않으므로 전송 목록에 올리지
/// 않는다 — 올리면 진짜 데이터가 지시문 사이에 묻힌다.
pub const INSTRUCTION_SECTIONS: &[&str] = &["Output rules", "Verdict rules", "Answer rules", "Plan rules"];

/// **나가지만 아직 세지 않는 것** (7.2절의 남은 과제).
///
/// 여기 있는 것들은 전부 사용자·저장소에서 온 내용이다. 특히 검증 출력에는 실패한 테스트의
/// 스택 트레이스와 소스 조각이 그대로 들어가고, 그건 `relevantFiles`에 없던 파일의 내용일 수
/// 있다. **지금 화면은 그것을 말하지 않는다.** 말하지 않는다는 사실을 여기 적어 두는 이유는,
/// 적지 않으면 위 `REPORTED_SECTIONS`가 "전부"로 읽히기 때문이다.
pub const UNREPORTED_SECTIONS: &[&str] = &[
    "Task",
    // 질문 경로의 사용자 요청(51절). 바로 위 항목과 **같은 것이다** — 사용자가 쓴 문장이
    // 그대로 나간다. 제목만 다른 이유는 그 프롬프트가 하는 일이 다르기 때문이다.
    "Question",
    // 계획 경로의 사용자 요청(53절). 위 둘과 **같은 것이다** — 제목만 다르다.
    "Request",
    "Acceptance criteria",
    "Clarifications already provided by the user",
    "Draft author's interpretation",
    "Draft author's stated risks",
    "Proposed patch",
    // 초안이 patch 밖에서 하려는 일(46절). **바로 위 항목과 같은 가족이다** — 제안 자체이고,
    // 내용은 워크스페이스 경로다. 지시문이 아니므로 위 칸에 넣을 수 없고, 집계가 세지도 않는다.
    //
    // (주석에 다른 섹션 이름을 큰따옴표로 적지 말 것. 대조 테스트가 이 목록을 정규식으로
    //  읽으므로 그 이름이 목록에 한 번 더 들어간 것이 된다 — 42절에서 같은 함정을 밟았다.)
    "File operations requested outside the patch",
    "Your previous draft was rejected before it was applied",
    // 게이트 거부 사유(42절). 바로 위 항목과 같은 가족이다 — 우리 문장에 게이트의 사유가
    // 붙고, 그 사유에는 **경로가 들어갈 수 있다**(경계 위반이면 그 경로가 문장에 있다).
    // 그래서 우리 지시문으로 접지 않고 여기 둔다.
    "Your previous plan was refused by the policy gate before anything ran",
    "Attempt number",
    "Failing checks",
    "Checks that passed",
    "Already failing before your change — DO NOT try to fix these",
    "Files your previous attempt changed",
];

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Transmission {
    #[serde(rename = "taskId")]
    pub task_id: String,
    /// 스냅샷을 만든 적이 있는가. false면 아래 목록이 비어 있는 이유가 "아무것도 안 나갔다"가
    /// 아니라 **"아직 모은 적이 없다"**이다 — 둘을 구별하지 못하면 화면이 거짓 안심을 준다.
    #[serde(rename = "snapshotTaken")]
    pub snapshot_taken: bool,
    pub providers: Vec<ProviderTransmission>,
    /// 내용까지 나간 파일.
    #[serde(rename = "sentFiles")]
    pub sent_files: Vec<SentFile>,
    /// **경로와 사유만** 나간 파일 (secret 등으로 내용이 제외된 것). 위 모듈 주석 ①.
    #[serde(rename = "namedOnlyFiles")]
    pub named_only_files: Vec<NamedOnlyFile>,
    /// 파일이 아닌데 함께 나간 것 — 프로젝트 규칙 전문, 커밋되지 않은 변경 요약 등(7.2절).
    #[serde(rename = "sentContext")]
    pub sent_context: Vec<SentContext>,
    /// 저장 기록에서 가려진 자격증명 모양의 수. **보낸 것에서 가려진 수가 아니다** — ②.
    #[serde(rename = "secretShapesMaskedInLog")]
    pub secret_shapes_masked_in_log: u64,
    /// 사용자가 자유 텍스트로 답한 횟수. 그 원문은 프롬프트에 그대로 실린다(17.11절).
    #[serde(rename = "freeTextAnswers")]
    pub free_text_answers: u64,
}

/// 파일이 아닌 전송 내용을 스냅샷 이벤트에서 뽑는다.
///
/// **섹션이 비어 있으면 넣지 않는다.** 0바이트짜리 항목을 늘어놓으면 화면이 "이것도 나갔다"로
/// 읽히는데, 그 섹션은 프롬프트에 아예 없었다.
fn collect_context(payload: &Value, out: &mut Vec<SentContext>) {
    // ① 저장소 상태 — 브랜치 이름과 **커밋되지 않은 변경 요약**이다. 요약에는 이번 컨텍스트에
    //    선정되지 않은 파일의 경로도 들어간다(`git diff --stat`은 바뀐 파일을 전부 센다).
    //    그래서 "선정된 파일만 나갔다"는 읽기가 틀린다.
    let branch = payload.get("gitBranch").and_then(Value::as_str).unwrap_or("");
    let diff_summary = payload.get("gitDiffSummary").and_then(Value::as_str).unwrap_or("");
    if !branch.is_empty() || !diff_summary.is_empty() {
        let detail = if diff_summary.is_empty() {
            format!("브랜치 이름 ({branch})")
        } else {
            format!("브랜치 이름 ({branch})과 커밋되지 않은 변경 요약 — 요약에는 컨텍스트로 선정되지 않은 파일의 경로도 들어갑니다")
        };
        out.push(SentContext {
            section: "Repository state".to_string(),
            detail,
            bytes: (branch.len() + diff_summary.len()) as u64,
            sources: Vec::new(),
        });
    }

    // ② 스킬 지시문 — 사용자가 고른 프리셋의 **원문**이 매 호출에 실린다(26절).
    //    `projectMeta`보다 먼저 본다: 메타가 없는 스냅샷에서도 스킬은 나갈 수 있다.
    if let Some(skill) = payload.get("skill").filter(|v| !v.is_null()) {
        let name = skill.get("name").and_then(Value::as_str).unwrap_or("(이름 없음)");
        let instructions = skill.get("instructions").and_then(Value::as_str).unwrap_or("");
        if !instructions.is_empty() {
            out.push(SentContext {
                section: "Skill instructions".to_string(),
                detail: format!("스킬 \"{name}\"의 지시문 **원문**이 매 호출에 실립니다"),
                bytes: instructions.len() as u64,
                sources: Vec::new(),
            });
        }
    }

    // ③ 세션 메모리 — 앞선 태스크에서 사용자가 정한 것이 이 태스크의 프롬프트로 나간다(27절).
    //    **한 태스크에만 실렸던 판정이 다른 태스크로 넘어간다는 사실**이라 화면이 말해야 한다.
    if let Some(memory) = payload.get("sessionMemory").filter(|v| !v.is_null()) {
        let text = memory.get("text").and_then(Value::as_str).unwrap_or("");
        if !text.is_empty() {
            let count = memory.get("decisionCount").and_then(Value::as_u64).unwrap_or(0);
            let truncated = memory.get("truncated").and_then(Value::as_bool).unwrap_or(false);
            out.push(SentContext {
                section: "Decisions carried from earlier tasks".to_string(),
                detail: format!(
                    "이 세션의 앞선 태스크에서 사용자가 정한 {count}건이 이번 호출에도 실립니다{}",
                    if truncated { " (상한에 걸려 일부만)" } else { "" }
                ),
                bytes: text.len() as u64,
                sources: Vec::new(),
            });
        }
    }

    // ④ MCP — 등록된 서버의 도구 목록과 그 응답 (31절).
    //
    //    응답을 따로 세는 이유: **그 텍스트는 우리가 만든 것도 사용자가 쓴 것도 아니다.**
    //    외부 서버가 준 것이 프롬프트에 실려 공급자로 나가므로, 목록과 한 줄로 뭉치면
    //    "우리가 무엇을 보냈는가"에서 가장 설명이 필요한 쪽이 사라진다.
    if let Some(tools) = payload.get("mcpTools").filter(|v| !v.is_null()) {
        let text = tools.get("text").and_then(Value::as_str).unwrap_or("");
        if !text.is_empty() {
            let servers = tools.get("serverCount").and_then(Value::as_u64).unwrap_or(0);
            let count = tools.get("toolCount").and_then(Value::as_u64).unwrap_or(0);
            let truncated = tools.get("truncated").and_then(Value::as_bool).unwrap_or(false);
            out.push(SentContext {
                section: "MCP tools available".to_string(),
                detail: format!(
                    "등록된 MCP 서버 {servers}개의 도구 {count}개(이름·설명·인자 스키마)가 매 호출에 실립니다{}",
                    if truncated { " (상한에 걸려 일부만)" } else { "" }
                ),
                bytes: text.len() as u64,
                sources: Vec::new(),
            });
        }
    }
    if let Some(results) = payload.get("mcpResults").filter(|v| !v.is_null()) {
        let text = results.get("text").and_then(Value::as_str).unwrap_or("");
        if !text.is_empty() {
            let calls = results.get("callCount").and_then(Value::as_u64).unwrap_or(0);
            out.push(SentContext {
                section: "MCP tool results".to_string(),
                detail: format!(
                    "MCP 도구 {calls}건의 **응답 원문**이 이후 호출에 실립니다 — 외부 서버가 준 내용이며 우리가 만든 것이 아닙니다"
                ),
                bytes: text.len() as u64,
                sources: Vec::new(),
            });
        }
    }

    let Some(meta) = payload.get("projectMeta") else {
        return;
    };

    // ② 프로젝트 메타 — 언어 목록과 감지된 검증 명령.
    let languages: Vec<String> = meta
        .get("languages")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let commands: Vec<&str> = ["buildCommand", "testCommand", "lintCommand", "typecheckCommand"]
        .into_iter()
        .filter(|k| meta.get(*k).map(|v| !v.is_null()).unwrap_or(false))
        .collect();
    if !languages.is_empty() || !commands.is_empty() {
        out.push(SentContext {
            section: "Project".to_string(),
            detail: format!(
                "언어({}) · 감지된 검증 명령 {}개",
                if languages.is_empty() { "없음".to_string() } else { languages.join(", ") },
                commands.len()
            ),
            bytes: meta.get("languages").map(|v| v.to_string().len()).unwrap_or(0) as u64,
            sources: Vec::new(),
        });
    }

    // ③ 프로젝트 규칙 — **파일 전문이 나간다.** 이게 빠져 있던 것이 7.2절의 결함이다.
    //    `sentFiles`에 넣지 않는 이유: 저 목록은 컨텍스트 엔진이 고른 것이고, 규칙 파일은
    //    선정을 거치지 않고 언제나 실린다. 같은 칸에 넣으면 두 사실이 뭉개진다.
    if let Some(rules) = meta.get("agentsMdContent").and_then(Value::as_str) {
        if !rules.is_empty() {
            let sources: Vec<String> = meta
                .get("agentsMdSources")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            out.push(SentContext {
                section: "Project rules".to_string(),
                detail: "프로젝트 규칙 파일의 **전문**이 매 호출에 실립니다".to_string(),
                bytes: rules.len() as u64,
                sources,
            });
        }
    }
}

/// 한 태스크의 전송 사실을 모은다. **아무것도 쓰지 않는다.**
pub fn collect(store: &Store, task_id: &str) -> Result<Transmission, String> {
    let events = store
        .events(task_id)
        .map_err(|e| format!("이벤트를 읽을 수 없습니다: {e}"))?;

    let mut out = Transmission {
        task_id: task_id.to_string(),
        ..Transmission::default()
    };

    // **마지막 스냅샷을 쓴다.** 재질문 왕복으로 다시 만들면 그 뒤의 호출은 새 스냅샷을 싣고,
    // 화면이 답해야 하는 질문은 "지금 무엇이 나가 있는가"다.
    if let Some(payload) = events
        .iter()
        .rev()
        .find(|e| e.event_type == "SNAPSHOT_CREATED")
        .map(|e| &e.payload)
    {
        out.snapshot_taken = true;
        if let Some(files) = payload.get("relevantFiles").and_then(Value::as_array) {
            for file in files {
                let Some(path) = file.get("path").and_then(Value::as_str) else {
                    continue;
                };
                out.sent_files.push(SentFile {
                    path: path.to_string(),
                    reason: file
                        .get("reasonDetail")
                        .or_else(|| file.get("reason"))
                        .and_then(Value::as_str)
                        .unwrap_or("(사유 없음)")
                        .to_string(),
                    truncated: file.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                });
            }
        }
        collect_context(payload, &mut out.sent_context);
        if let Some(excluded) = payload.get("excludedNotes").and_then(Value::as_array) {
            for note in excluded {
                let Some(path) = note.get("path").and_then(Value::as_str) else {
                    continue;
                };
                out.named_only_files.push(NamedOnlyFile {
                    path: path.to_string(),
                    reason: note
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("(사유 없음)")
                        .to_string(),
                });
            }
        }
    }

    for event in &events {
        if event.event_type != "USER_DECISION_RECORDED" {
            continue;
        }
        out.secret_shapes_masked_in_log += event
            .payload
            .get("secretShapesMasked")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        // 자유 입력은 선택지가 아니라 사용자가 직접 쓴 문장이다 — 그 원문이 프롬프트로 나간다.
        let freeform = event
            .payload
            .get("decisions")
            .and_then(Value::as_array)
            .map(|d| {
                d.iter()
                    .filter(|x| x.get("freeform").and_then(Value::as_bool) == Some(true))
                    .count() as u64
            })
            .unwrap_or(0);
        // 3.4절 확인 필요 카드에는 decisions가 없다 — 그때는 답변 전체가 자유 텍스트다.
        let has_decisions = event
            .payload
            .get("decisions")
            .and_then(Value::as_array)
            .is_some_and(|d| !d.is_empty());
        let plain = u64::from(!has_decisions);
        out.free_text_answers += freeform + plain;
    }

    out.providers = store
        .provider_transmission(task_id)
        .map_err(|e| format!("공급자 사용량을 읽을 수 없습니다: {e}"))?;

    Ok(out)
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

    fn snapshot_event(store: &mut Store) {
        store
            .append_event(
                "task-1",
                "SNAPSHOT_CREATED",
                &json!({
                    "snapshotId": "snap-1",
                    "relevantFiles": [
                        { "path": "src/app.ts", "reason": "keyword", "reasonDetail": "요청문의 식별자와 일치", "truncated": false },
                        { "path": "src/big.ts", "reason": "import", "reasonDetail": "app.ts가 import", "truncated": true },
                    ],
                    "excludedNotes": [
                        { "path": ".env", "reason": "secret으로 분류된 경로" },
                    ],
                }),
            )
            .unwrap();
    }

    fn usage(store: &Store, call: &str, role: &str, provider: &str, model: &str, input: i64) {
        usage_resolved(store, call, role, provider, model, input, Some(model));
    }

    fn usage_resolved(
        store: &Store,
        call: &str,
        role: &str,
        provider: &str,
        model: &str,
        input: i64,
        resolved: Option<&str>,
    ) {
        store
            .record_provider_usage(&json!({
                "taskId": "task-1",
                "callId": call,
                "role": role,
                "providerId": provider,
                "modelId": model,
                "requestedModelId": model,
                "resolvedModelId": resolved,
                "providerRequestId": format!("req-{call}"),
                "usage": { "inputTokens": input, "outputTokens": 10 },
                "costUsd": 0.5,
                "latencyMs": 100,
                "attempt": 1,
                "createdAt": "2026-01-01T00:00:00Z",
            }))
            .unwrap();
    }

    /// **모든 프롬프트가 같은 스냅샷을 싣는다.** 그래서 "이 파일들이 이 공급자들 각각에게
    /// 갔다"고 말할 수 있고, 공급자별로 파일 목록을 따로 들고 다닐 필요가 없다.
    #[test]
    fn aggregates_what_went_to_each_provider() {
        let (_d, mut store) = seeded();
        snapshot_event(&mut store);
        usage(&store, "c1", "executor", "openai", "gpt-x", 100);
        usage(&store, "c2", "co-executor", "anthropic", "claude-x", 120);
        usage(&store, "c3", "reviewer", "anthropic", "claude-y", 80);

        let t = collect(&store, "task-1").unwrap();
        assert!(t.snapshot_taken);
        assert_eq!(t.providers.len(), 2);

        let anthropic = t.providers.iter().find(|p| p.provider_id == "anthropic").unwrap();
        assert_eq!(anthropic.calls, 2);
        assert_eq!(anthropic.input_tokens, 200);
        // 역할과 모델은 중복 없이 정렬된다 — 화면 문구가 실행마다 흔들리면 안 된다.
        assert_eq!(anthropic.roles, vec!["co-executor", "reviewer"]);
        assert_eq!(anthropic.models, vec!["claude-x", "claude-y"]);

        assert_eq!(t.sent_files.len(), 2);
        assert!(t.sent_files.iter().any(|f| f.path == "src/big.ts" && f.truncated));
    }

    /// **조용한 대체를 기록이 지우지 않는다.** `modelId`는 우리가 요청한 값이라 언제나 우리
    /// 기대와 같으므로, 그것만 남기면 공급자가 다른 모델로 답한 사실이 사라진다.
    #[test]
    fn a_silently_substituted_model_is_visible_in_the_trace() {
        let (_d, mut store) = seeded();
        snapshot_event(&mut store);
        usage_resolved(&store, "c1", "executor", "openai", "gpt-x", 100, Some("gpt-x-2026-01"));

        let t = collect(&store, "task-1").unwrap();
        let p = &t.providers[0];
        assert_eq!(p.models, vec!["gpt-x"], "요청한 모델");
        assert_eq!(p.resolved_models, vec!["gpt-x-2026-01"], "실제 응답한 모델");
        assert!(p.substituted, "대체가 보고되지 않았습니다");
        // 공급자 로그와 대조할 열쇠도 남는다.
        assert_eq!(p.provider_request_ids, vec!["req-c1"]);
    }

    /// **모르는 것을 대체로 세지 않는다.** 스키마 v4 이전 행이나 공급자가 모델을 알려주지 않은
    /// 호출은 `resolved_model_id`가 NULL이다. 그걸 대체로 보고하면 진짜 대체가 그 안에 묻힌다.
    #[test]
    fn an_unknown_resolved_model_is_not_reported_as_substitution() {
        let (_d, mut store) = seeded();
        snapshot_event(&mut store);
        usage_resolved(&store, "c1", "executor", "openai", "gpt-x", 100, None);

        let t = collect(&store, "task-1").unwrap();
        let p = &t.providers[0];
        assert!(!p.substituted, "모르는 것을 대체로 보고했습니다");
        assert!(p.resolved_models.is_empty(), "{:?}", p.resolved_models);
    }

    /// **프로젝트 규칙 파일의 전문이 나가는데 화면에 없었다** (7.2절).
    ///
    /// `sentFiles`에 `CLAUDE.md`가 없으므로, 그 화면을 본 사용자는 자기 규칙 파일이 나가지
    /// 않았다고 믿는다. 정반대다 — 규칙 파일은 컨텍스트 선정을 거치지 않고 **매 호출에 전문이
    /// 실린다.**
    #[test]
    fn project_rules_are_reported_even_though_they_are_not_selected_files() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "SNAPSHOT_CREATED",
                &json!({
                    "snapshotId": "snap-1",
                    "gitBranch": "main",
                    "relevantFiles": [],
                    "excludedNotes": [],
                    "projectMeta": {
                        "languages": ["typescript"],
                        "agentsMdPresent": true,
                        "agentsMdContent": "규칙 본문 전체",
                        "agentsMdSources": ["CLAUDE.md", "AGENTS.md"],
                    },
                }),
            )
            .unwrap();

        let t = collect(&store, "task-1").unwrap();
        let rules = t
            .sent_context
            .iter()
            .find(|c| c.section == "Project rules")
            .expect("프로젝트 규칙이 전송 목록에 없습니다");
        assert_eq!(rules.sources, vec!["CLAUDE.md".to_string(), "AGENTS.md".to_string()]);
        assert!(rules.bytes > 0, "전문이 나갔는데 크기가 0입니다");
        // 선정된 파일 칸에 섞지 않는다 — 두 사실은 다른 경로로 실린다.
        assert!(t.sent_files.is_empty(), "{:?}", t.sent_files);
    }

    /// **커밋되지 않은 변경 요약에는 선정되지 않은 파일의 경로가 들어간다.**
    ///
    /// `git diff --stat`은 바뀐 파일을 전부 세므로, 컨텍스트에 들어가지 않은 파일의 이름도
    /// 프롬프트로 나간다. 화면이 파일 목록만 보여주면 "이것만 나갔다"로 읽힌다.
    #[test]
    fn the_uncommitted_diff_summary_is_reported_as_going_out() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "SNAPSHOT_CREATED",
                &json!({
                    "snapshotId": "snap-1",
                    "gitBranch": "feature/x",
                    "gitDiffSummary": " src/unrelated.ts | 3 +-\n 1 file changed",
                    "relevantFiles": [],
                    "excludedNotes": [],
                }),
            )
            .unwrap();

        let t = collect(&store, "task-1").unwrap();
        let state = t
            .sent_context
            .iter()
            .find(|c| c.section == "Repository state")
            .expect("저장소 상태가 전송 목록에 없습니다");
        assert!(state.bytes > 0);
        // 그 요약이 무엇을 담는지 화면이 말해야 한다 — 크기만으로는 읽는 사람이 알 수 없다.
        assert!(state.detail.contains("선정되지 않은"), "{}", state.detail);
    }

    /// **없는 섹션을 0바이트로 늘어놓지 않는다.** 그러면 화면이 "이것도 나갔다"로 읽히는데
    /// 그 섹션은 프롬프트에 아예 없었다.
    #[test]
    fn a_section_that_was_never_rendered_is_not_listed() {
        let (_d, mut store) = seeded();
        // **`projectMeta`가 있는데 규칙만 비어 있는 상태**여야 한다. 메타 자체가 없으면
        // 수집이 그 앞에서 끝나 이 검사가 빈 분기를 지나간다 — 실제로 그렇게 공허했다.
        store
            .append_event(
                "task-1",
                "SNAPSHOT_CREATED",
                &json!({
                    "snapshotId": "snap-1",
                    "relevantFiles": [],
                    "excludedNotes": [],
                    "projectMeta": { "languages": ["typescript"], "agentsMdPresent": false, "agentsMdContent": "" },
                }),
            )
            .unwrap();
        let t = collect(&store, "task-1").unwrap();
        assert!(
            !t.sent_context.iter().any(|c| c.section == "Project rules"),
            "규칙이 없는데 목록에 있습니다: {:?}",
            t.sent_context
        );
    }

    /// **제외된 파일도 이름은 나간다.** 내용이 빠졌다고 아무것도 안 나간 것이 아니다 —
    /// 프롬프트에 "이 파일은 일부러 제외했다"는 목록으로 경로와 사유가 실린다.
    /// 화면이 이걸 "Local only"라고만 쓰면 경로도 안 나간 것으로 읽힌다.
    #[test]
    fn excluded_files_are_reported_as_name_only_not_as_absent() {
        let (_d, mut store) = seeded();
        snapshot_event(&mut store);

        let t = collect(&store, "task-1").unwrap();
        assert_eq!(t.named_only_files.len(), 1);
        assert_eq!(t.named_only_files[0].path, ".env");
        // 내용이 나간 목록에는 없어야 한다 — 두 목록이 섞이면 둘 다 뜻을 잃는다.
        assert!(!t.sent_files.iter().any(|f| f.path == ".env"));
    }

    /// 스냅샷이 없는 것과 "아무것도 안 나갔다"는 다른 사실이다. 구별하지 못하면 빈 화면이
    /// 거짓 안심을 준다.
    #[test]
    fn no_snapshot_is_distinguishable_from_nothing_sent() {
        let (_d, store) = seeded();
        let t = collect(&store, "task-1").unwrap();
        assert!(!t.snapshot_taken);
        assert!(t.sent_files.is_empty());
        assert!(t.providers.is_empty());
    }

    /// 마스킹 수는 **저장 기록**의 것이고, 자유 텍스트 답변은 원문 그대로 나간다(17.11절).
    /// 두 숫자를 함께 내는 이유: 마스킹 수만 보여주면 "가려져서 안 나갔다"로 읽힌다.
    #[test]
    fn counts_masking_in_the_log_separately_from_free_text_that_was_sent() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({
                    "secretShapesMasked": 2,
                    "decisions": [
                        { "disagreementId": "d1", "freeform": true },
                        { "disagreementId": "d2", "freeform": false },
                    ],
                }),
            )
            .unwrap();
        // 3.4절 확인 필요 카드 — decisions가 없으면 답변 전체가 자유 텍스트다.
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &json!({ "secretShapesMasked": 0, "decisions": [] }),
            )
            .unwrap();

        let t = collect(&store, "task-1").unwrap();
        assert_eq!(t.secret_shapes_masked_in_log, 2);
        assert_eq!(t.free_text_answers, 2, "자유 입력 1건 + 카드 없는 답변 1건");
    }

    /// 재질문 왕복으로 스냅샷을 다시 만들면 **마지막 것**이 지금 나가 있는 것이다.
    #[test]
    fn the_latest_snapshot_is_what_is_currently_exposed() {
        let (_d, mut store) = seeded();
        snapshot_event(&mut store);
        store
            .append_event(
                "task-1",
                "SNAPSHOT_CREATED",
                &json!({ "relevantFiles": [{ "path": "src/only.ts", "reason": "k", "reasonDetail": "d" }], "excludedNotes": [] }),
            )
            .unwrap();

        let t = collect(&store, "task-1").unwrap();
        assert_eq!(t.sent_files.len(), 1);
        assert_eq!(t.sent_files[0].path, "src/only.ts");
        assert!(t.named_only_files.is_empty());
    }
}
