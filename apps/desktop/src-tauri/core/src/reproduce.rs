//! 재현(reproduce) — 기록을 다시 적용할 수 있는가를 **판정**한다.
//!
//! product-strategy.md 6.3절이 재현과 재실행을 갈라놓았고, state-machine-and-protocol.md
//! 12절이 러너를 만들 때 **먼저 정할 것은 기능이 아니라 판정 규칙**이라고 적어두었다.
//! 이 모듈이 그 판정 규칙의 실체다.
//!
//! # 문서가 던진 질문은 답할 수 없는 형태였다
//!
//! 종전 문항은 "지문이 다르면 (a) 거부할지 (b) 경고 후 진행할지"였고, 답하지 못한 이유로
//! "재현을 돌리는 사람이 같은 상태를 만들 수 없는 머신에 있는지, 원본 저장소를 들고 있는지에
//! 따라 답이 반대"라고 적혀 있었다. 그런데 그 문항에는 답을 막는 전제가 둘 들어 있다.
//!
//! - **전제 ①: 불일치가 한 비트다.** 지문은 세 재료(HEAD·status·diff)의 해시이고, 그 해시가
//!   다르다는 사실 하나로는 "기반 커밋이 아예 다르다"와 "같은 커밋인데 워킹 트리가 더럽다"가
//!   구별되지 않는다. 뒤쪽은 사용자가 stash 한 번으로 없앨 수 있는 차이인데, 한 비트로 뭉치면
//!   그 사실을 말해줄 방법이 없다. 게다가 **"다르다"와 "잴 수 없었다"까지 같은 칸에 들어간다.**
//! - **전제 ②: 재현이 한 동작이다.** 실제로는 두 동작이다 — 아무것도 쓰지 않는 **검사**와
//!   파일을 쓰는 **적용**. 거부할 것이 있는 쪽은 후자뿐이다.
//!
//! 전제를 풀면 "재현을 돌리는 사람이 누구인가"를 추측할 필요가 없어진다. 같은 상태를 만들 수
//! 없는 머신의 감사자는 **검사가 줄 수 있는 것을 전부** 받고(patch가 붙는지까지), 원본 저장소를
//! 들고 있는 사람은 적용을 받는다. 우리가 고를 것이 남지 않는다.
//!
//! # 판정 규칙
//!
//! 1. **입력은 export 파일이고, 그 파일은 신뢰되지 않는다.** 재현을 돌리는 사람은 대개 DB가
//!    없다 — 그래서 export가 있는 것이다. 그리고 파일은 밖에서 온다. **기록에 있다는 사실은
//!    승인 근거가 아니다.** 아는 `formatVersion`이 아니면 읽지 않는다.
//! 2. **전제는 세 값이다** — `match` / `mismatch` / `unknown`. "다르다"와 "모른다"를 한 값으로
//!    합치면 잴 수 없었던 것이 달랐던 것으로 보고된다.
//! 3. **불일치는 무엇이 다른지까지 말한다.** HEAD가 다른 것과 워킹 트리가 다른 것은 사용자가
//!    할 수 있는 일이 다르다.
//! 4. **검사는 어떤 전제에서도 거부하지 않는다.** 쓰지 않으므로 거부할 것이 없다.
//! 5. **적용은 `match`가 아니면 자동으로 진행하지 않는다.** `mismatch`는 **본 것을 되짚는
//!    확인**으로 넘을 수 있다(기대 지문을 명시해야 하고, 플래그 하나로는 안 된다).
//!    **`unknown`은 확인이 있어도 넘지 못한다** — 볼 수 없는 차이를 확인할 수는 없다.
//! 6. **재현 단계도 Policy Gate를 그대로 지난다**(적용기를 만들 때). 기록에 있다는 것이 승인
//!    근거가 되면 export 파일 하나로 임의 명령을 돌리는 경로가 생긴다.
//!
//! # 지금 있는 것과 없는 것
//!
//! 이 모듈은 **검사까지** 한다: 전제 판정, 계획 복원, 그리고 각 단계가 이 워크스페이스에
//! 적용될 수 있는지의 정적 확인. **적용기는 없다.** 규칙 5의 판정(`decide_apply`)은 여기
//! 있지만 그것은 "적용해도 되는가"에 대한 답이지 적용이 아니다 — 없는 것을 있는 것처럼 적으면
//! 6.3절이 세운 재현/재실행 구분이 무의미해진다.

use crate::tools::patch::apply_unified_diff;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

/// 이 러너가 읽을 수 있는 export 형식 버전.
///
/// 목록으로 두는 이유: 형식이 3까지 갔을 때 2도 읽을 수 있으면 여기에 2가 남는다.
/// "최신만 읽는다"로 두면 옛 감사 기록이 조용히 읽히지 않게 된다 — 감사 기록은 **몇 년 뒤에
/// 읽히는 것**이 용도이므로 그 조용함이 특히 나쁘다.
pub const SUPPORTED_FORMAT_VERSIONS: &[u32] = &[crate::export::EXPORT_FORMAT_VERSION];

// ---- 워크스페이스 지문 ----

/// 지문 재료 — **무엇으로 만든 지문인지**. 재료가 바뀌면 옛 지문과 비교할 수 없고,
/// 그 사실을 모르면 "상태가 달라졌다"로 잘못 읽는다.
pub const FINGERPRINT_INPUTS: &[&str] = &["rev-parse HEAD", "status --porcelain -uall", "diff HEAD"];

/// 지문을 계산한다. git 호출은 **호출자가 준다.**
///
/// 이렇게 나눈 이유: `TaskHost`는 Policy Gate를 지나는 러너를 넘기고(자기 편의로 게이트를
/// 우회하지 않는다), 태스크가 없는 읽기 전용 경로는 읽기 전용 러너를 넘긴다. 지문을 만드는
/// **재료와 조립 방식은 한 곳에만** 둔다 — 두 벌이 되면 같은 워크스페이스가 경로에 따라 다른
/// 지문을 내고, 그건 비교 자체를 무너뜨린다.
pub fn fingerprint(run_git: impl Fn(&[&str]) -> Result<String, String>) -> Value {
    let Ok(head) = run_git(&["rev-parse", "HEAD"]) else {
        // git 저장소가 아니거나 커밋이 하나도 없다. 둘 다 "잴 수 없었다"이지 "비어 있었다"가 아니다.
        return serde_json::json!({ "available": false, "reason": "git 저장소가 아니거나 아직 커밋이 없습니다" });
    };
    let Ok(status) = run_git(&["status", "--porcelain", "-uall"]) else {
        return serde_json::json!({ "available": false, "reason": "git status를 읽지 못했습니다" });
    };
    let Ok(diff) = run_git(&["diff", "HEAD"]) else {
        return serde_json::json!({ "available": false, "reason": "git diff를 읽지 못했습니다" });
    };

    let untracked = status.lines().filter(|l| l.starts_with("?? ")).count() as u64;
    let dirty = !status.trim().is_empty();

    let mut hasher = Sha256::new();
    // 구분자를 넣는 이유: 재료를 그냥 이으면 한 재료의 끝과 다음 재료의 시작이 붙어
    // **서로 다른 조합이 같은 바이트열**이 될 수 있다.
    hasher.update(b"head\n");
    hasher.update(head.trim().as_bytes());
    hasher.update(b"\nstatus\n");
    hasher.update(status.as_bytes());
    hasher.update(b"\ndiff\n");
    hasher.update(diff.as_bytes());
    let digest = hasher.finalize();

    serde_json::json!({
        "available": true,
        "fingerprint": format!("sha256:{digest:x}"),
        "gitHead": head.trim(),
        "dirty": dirty,
        // 0이면 위 한계(추적되지 않는 파일의 내용 미반영)가 이번 실행에 적용되지 않는다.
        "untrackedFiles": untracked,
        "inputs": FINGERPRINT_INPUTS,
    })
}

/// 태스크 없이 지문을 낼 때 쓰는 **읽기 전용** git 러너.
///
/// 인자를 allowlist로 막는다. 주석으로 "읽기 전용이다"라고 적는 것과 구조로 그렇게 만드는
/// 것은 다르다 — 게이트를 지나지 않는 경로가 생겼다면 그 경로가 쓸 수 없다는 것이 코드에서
/// 확인 가능해야 한다.
pub fn read_only_git(workspace: &Path, args: &[&str]) -> Result<String, String> {
    const READ_ONLY: &[&str] = &["rev-parse", "status", "diff"];
    let Some(sub) = args.first() else {
        return Err("git 하위 명령이 없습니다".to_string());
    };
    if !READ_ONLY.contains(sub) {
        return Err(format!("읽기 전용 경로에서 허용되지 않는 git 하위 명령입니다: {sub}"));
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {sub} 실패: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ---- 전제 판정 ----

/// 지문 두 개가 무엇 때문에 다른가. **해시 하나만 비교하면 알 수 없는 것들이다.**
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Difference {
    /// 기반 커밋이 다르다. 사용자가 checkout으로 좁힐 수 있는 차이다.
    GitHead,
    /// 같은 커밋인데 워킹 트리가 다르다. stash/clean으로 좁힐 수 있는 차이다.
    WorkingTree,
}

/// 비교가 성립하지 않는 이유. **"다르다"와 같은 칸에 두지 않는다.**
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UnknownReason {
    /// export에 지문 키 자체가 없다 — 지문을 남기기 전에 만들어진 기록이다.
    MissingInExport,
    /// 기록 당시 잴 수 없었다(git 저장소가 아니었다 등).
    RecordedUnavailable { reason: String },
    /// 지금 잴 수 없다.
    CurrentUnavailable { reason: String },
    /// 재료가 다르다. 같은 이름의 해시지만 **비교할 수 있는 값이 아니다.**
    InputsDiffer {
        recorded: Vec<String>,
        current: Vec<String>,
    },
    /// 한쪽에 지문 문자열이 없다 — `available: true`인데 값이 빠진 깨진 기록.
    MalformedFingerprint,
}

/// 재현의 전제 — **세 값이다.**
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum Precondition {
    /// 지문이 같다. 기록과 같은 상태다.
    Match { fingerprint: String },
    /// 잴 수 있었고 다르다.
    Mismatch {
        recorded: String,
        current: String,
        /// 비어 있지 않다 — 무엇이 다른지 하나 이상 말한다.
        differs: Vec<Difference>,
    },
    /// 비교할 수 없다. **다르다는 뜻이 아니다.**
    Unknown { reason: UnknownReason },
}

fn field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn inputs_of(v: &Value) -> Vec<String> {
    v.get("inputs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// 기록된 지문과 현재 지문을 견준다.
///
/// `recorded`는 export의 `workspaceFingerprint`다. **`null`과 `available:false`와 값 불일치는
/// 서로 다른 사실이므로 서로 다른 결과를 낸다.**
pub fn judge(recorded: Option<&Value>, current: &Value) -> Precondition {
    let Some(recorded) = recorded.filter(|v| !v.is_null()) else {
        return Precondition::Unknown {
            reason: UnknownReason::MissingInExport,
        };
    };
    if recorded.get("available").and_then(Value::as_bool) != Some(true) {
        return Precondition::Unknown {
            reason: UnknownReason::RecordedUnavailable {
                reason: field(recorded, "reason")
                    .unwrap_or("사유가 기록되지 않았습니다")
                    .to_string(),
            },
        };
    }
    if current.get("available").and_then(Value::as_bool) != Some(true) {
        return Precondition::Unknown {
            reason: UnknownReason::CurrentUnavailable {
                reason: field(current, "reason").unwrap_or("사유를 알 수 없습니다").to_string(),
            },
        };
    }

    // **재료 비교가 값 비교보다 먼저다.** 재료가 다르면 값이 우연히 같아도 그 같음은 의미가 없고,
    // 값이 다른 것도 상태 때문인지 재료 때문인지 가릴 수 없다.
    let (ri, ci) = (inputs_of(recorded), inputs_of(current));
    if ri != ci {
        return Precondition::Unknown {
            reason: UnknownReason::InputsDiffer {
                recorded: ri,
                current: ci,
            },
        };
    }

    let (Some(rf), Some(cf)) = (field(recorded, "fingerprint"), field(current, "fingerprint")) else {
        return Precondition::Unknown {
            reason: UnknownReason::MalformedFingerprint,
        };
    };
    if rf == cf {
        return Precondition::Match {
            fingerprint: rf.to_string(),
        };
    }

    // 무엇이 달라서 해시가 갈렸는지까지 말한다. HEAD가 같은데 해시가 다르면 남는 재료는
    // 워킹 트리뿐이다 — 그건 사용자가 좁힐 수 있는 차이이므로 "다르다"로 끝내면 안 된다.
    let mut differs = Vec::new();
    if field(recorded, "gitHead") != field(current, "gitHead") {
        differs.push(Difference::GitHead);
    } else {
        differs.push(Difference::WorkingTree);
    }
    Precondition::Mismatch {
        recorded: rf.to_string(),
        current: cf.to_string(),
        differs,
    }
}

// ---- 적용 판정 (규칙 5) ----

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "decision", rename_all = "camelCase")]
pub enum ApplyDecision {
    /// 진행해도 된다.
    Allowed,
    /// 사용자가 **본 것을 되짚어야** 한다. 기대 지문을 명시하는 형태여야 하고, 플래그
    /// 하나로는 안 된다 — 무엇이 다른지 보지 않고 넘길 수 있으면 규칙 3이 무의미해진다.
    NeedsAcknowledgement { expected: String, differs: Vec<Difference> },
    /// 진행하지 않는다.
    Refused { reason: String },
}

/// 적용해도 되는가. `acknowledged`는 사용자가 명시한 **기대 지문**이다.
///
/// **이 함수는 적용하지 않는다.** 판정만 한다 — 적용기는 아직 없다.
pub fn decide_apply(pre: &Precondition, acknowledged: Option<&str>) -> ApplyDecision {
    match pre {
        Precondition::Match { .. } => ApplyDecision::Allowed,
        Precondition::Mismatch { recorded, differs, .. } => match acknowledged {
            Some(ack) if ack == recorded => ApplyDecision::Allowed,
            Some(ack) => ApplyDecision::Refused {
                reason: format!(
                    "확인한 지문({ack})이 기록된 지문({recorded})과 다릅니다 — 다른 기록을 보고 확인했을 수 있습니다"
                ),
            },
            None => ApplyDecision::NeedsAcknowledgement {
                expected: recorded.clone(),
                differs: differs.clone(),
            },
        },
        // **확인으로 넘을 수 없다.** 볼 수 없는 차이를 확인할 수는 없으므로, 여기서 확인을
        // 받으면 그 확인은 아무 내용도 담지 않은 형식이 된다.
        Precondition::Unknown { .. } => ApplyDecision::Refused {
            reason: "전제를 비교할 수 없습니다. 확인으로 넘을 수 있는 것은 '다르다'이지 '모른다'가 아닙니다"
                .to_string(),
        },
    }
}

// ---- 계획 복원 ----

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub index: usize,
    pub request_id: String,
    pub tool: String,
    /// 기록된 인자 **원문**. 새로 조립하지 않는다(원칙 6).
    pub args: Value,
    /// 기록에서의 종료 코드. `None`은 종료 코드를 갖지 않는 도구이거나 읽지 못한 것이다.
    pub recorded_exit_code: Option<i64>,
    /// **기록에서도 실패한 단계.** 재현이 여기서 같은 종료 코드를 내면 그건 재현 성공이다 —
    /// 이 표시가 없으면 읽는 사람이 재현 실패로 읽는다.
    pub failed_in_record: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub format_version: u32,
    pub task_id: Option<String>,
    pub steps: Vec<Step>,
}

/// export에서 재현 계획을 복원한다.
///
/// 형식 버전을 모르면 **읽지 않는다.** 옛 파일을 새 규칙으로 읽으면 조용히 틀린 해석을 하고,
/// 감사 기록에서 조용히 틀린 해석은 아무것도 없는 것보다 나쁘다.
pub fn plan(export: &Value) -> Result<Plan, String> {
    let version = export
        .get("formatVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "formatVersion이 없습니다 — export 파일이 아닙니다".to_string())? as u32;
    if !SUPPORTED_FORMAT_VERSIONS.contains(&version) {
        return Err(format!(
            "읽을 수 없는 export 형식 버전입니다: {version} (읽을 수 있는 버전: {SUPPORTED_FORMAT_VERSIONS:?})"
        ));
    }

    let raw = export
        .get("reproduce")
        .and_then(|r| r.get("steps"))
        .and_then(Value::as_array)
        .ok_or_else(|| "reproduce.steps가 없습니다".to_string())?;

    let steps = raw
        .iter()
        .enumerate()
        .map(|(index, s)| {
            let exit = s
                .get("recordedOutcome")
                .and_then(|o| o.get("exitCode"))
                .and_then(Value::as_i64);
            Step {
                index,
                request_id: field(s, "requestId").unwrap_or("").to_string(),
                tool: field(s, "tool").unwrap_or("").to_string(),
                args: s.get("args").cloned().unwrap_or(Value::Null),
                recorded_exit_code: exit,
                // `None`을 실패로 세지 않는다 — 종료 코드가 없는 도구가 전부 실패로 보인다.
                failed_in_record: matches!(exit, Some(code) if code != 0),
            }
        })
        .collect();

    Ok(Plan {
        format_version: version,
        task_id: export.get("task").and_then(|t| field(t, "taskId")).map(str::to_string),
        steps,
    })
}

// ---- 적용 가능성 정적 확인 (아무것도 쓰지 않는다) ----

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StepCheck {
    /// 이 워크스페이스에 적용된다.
    Applies,
    /// 적용되지 않는다. 사유는 재현을 포기하라는 뜻이 아니라 **무엇을 맞춰야 하는지**다.
    WouldFail { reason: String },
    /// 정적으로 판정할 수 없다. **실패가 아니다.**
    NotDecidable { reason: String },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedStep {
    pub index: usize,
    pub tool: String,
    pub check: StepCheck,
}

/// 계획이 이 워크스페이스에 붙는지 확인한다. **파일을 쓰지 않는다.**
///
/// # 순차 적용을 흉내 낸다
///
/// patch 2는 patch 1이 적용된 결과에 붙는다. 각 patch를 **디스크의 현재 내용**에 대고 검사하면
/// 같은 파일을 두 번 고친 기록이 전부 거짓 실패로 나온다. 그래서 메모리에 겹침(overlay)을 두고
/// 앞 단계의 결과를 반영해 가며 검사한다.
///
/// # 명령을 만나면 흉내를 멈춘다
///
/// `run_command`가 파일을 어떻게 바꾸는지는 정적으로 알 수 없다. 그 뒤의 patch 검사는
/// **실패가 아니라 `NotDecidable`**이다 — 여기서 실패로 보고하면 "명령이 만들어 낸 파일에 붙는
/// patch"가 전부 재현 불가로 뒤집힌다. 모르는 것을 아니라고 말하지 않는다.
pub fn check_applicability(plan: &Plan, workspace: &Path) -> Vec<CheckedStep> {
    // `None`은 "이 경로는 삭제된 상태"다. 키가 없는 것(=디스크를 봐야 한다)과 다르다.
    let mut overlay: HashMap<String, Option<String>> = HashMap::new();
    let mut simulated = true;
    let mut out = Vec::new();

    for step in &plan.steps {
        let path = field(&step.args, "path").map(str::to_string);
        let check = match step.tool.as_str() {
            "apply_patch" => match (&path, field(&step.args, "patch")) {
                (Some(p), Some(patch)) if simulated => match current_text(&overlay, workspace, p) {
                    Some(before) => match apply_unified_diff(&before, patch) {
                        Ok(after) => {
                            overlay.insert(p.clone(), Some(after));
                            StepCheck::Applies
                        }
                        Err(e) => StepCheck::WouldFail {
                            reason: format!("patch가 붙지 않습니다: {e}"),
                        },
                    },
                    None => StepCheck::WouldFail {
                        reason: format!("대상 파일이 없습니다: {p}"),
                    },
                },
                (_, _) if !simulated => StepCheck::NotDecidable {
                    reason: unsimulated_reason(),
                },
                _ => StepCheck::NotDecidable {
                    reason: "기록에 path 또는 patch가 없습니다".to_string(),
                },
            },
            "create_file" => match (&path, simulated) {
                (Some(p), true) => {
                    let existed = current_text(&overlay, workspace, p).is_some();
                    overlay.insert(
                        p.clone(),
                        Some(
                            step.args
                                .get("content")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                        ),
                    );
                    if existed {
                        // 실패로 부르지 않는다 — 재현은 기록된 최종 상태를 만드는 것이고,
                        // 덮어쓰기는 그 목적에 어긋나지 않는다. 다만 **말은 해야 한다.**
                        StepCheck::NotDecidable {
                            reason: format!("이미 있는 파일을 덮어씁니다: {p}"),
                        }
                    } else {
                        StepCheck::Applies
                    }
                }
                (_, false) => StepCheck::NotDecidable {
                    reason: unsimulated_reason(),
                },
                _ => StepCheck::NotDecidable {
                    reason: "기록에 path가 없습니다".to_string(),
                },
            },
            "delete_file" => match (&path, simulated) {
                (Some(p), true) => {
                    let existed = current_text(&overlay, workspace, p).is_some();
                    overlay.insert(p.clone(), None);
                    if existed {
                        StepCheck::Applies
                    } else {
                        StepCheck::WouldFail {
                            reason: format!("지울 파일이 없습니다: {p}"),
                        }
                    }
                }
                (_, false) => StepCheck::NotDecidable {
                    reason: unsimulated_reason(),
                },
                _ => StepCheck::NotDecidable {
                    reason: "기록에 path가 없습니다".to_string(),
                },
            },
            // 명령은 정적으로 판정하지 않는다. 그리고 **이 시점부터 겹침은 신뢰할 수 없다.**
            _ => {
                simulated = false;
                StepCheck::NotDecidable {
                    reason: "명령이 무엇을 바꾸는지는 실행해 봐야 압니다".to_string(),
                }
            }
        };
        out.push(CheckedStep {
            index: step.index,
            tool: step.tool.clone(),
            check,
        });
    }
    out
}

fn unsimulated_reason() -> String {
    "앞선 명령이 무엇을 바꿨는지 알 수 없어 이 단계를 판정할 수 없습니다".to_string()
}

/// 겹침을 먼저 보고, 없으면 디스크를 본다. `None`은 "그 경로에 파일이 없다"이다.
fn current_text(overlay: &HashMap<String, Option<String>>, workspace: &Path, path: &str) -> Option<String> {
    if let Some(entry) = overlay.get(path) {
        return entry.clone();
    }
    std::fs::read_to_string(workspace.join(path)).ok()
}

/// 검사 전체의 한 줄 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reproducibility {
    /// 모든 단계가 붙는다.
    Yes,
    /// 붙지 않는 단계가 있다.
    No,
    /// 판정할 수 없는 단계가 있다(명령이 섞였거나 기록이 모자라다).
    Unknown,
}

/// **`No`가 `Unknown`을 이긴다.** 하나라도 확실히 붙지 않으면 그 계획은 그대로 재현되지 않고,
/// 그 사실은 나머지를 몰라도 이미 확정이다.
pub fn summarize(checks: &[CheckedStep]) -> Reproducibility {
    if checks.iter().any(|c| matches!(c.check, StepCheck::WouldFail { .. })) {
        Reproducibility::No
    } else if checks.iter().any(|c| matches!(c.check, StepCheck::NotDecidable { .. })) {
        Reproducibility::Unknown
    } else {
        Reproducibility::Yes
    }
}

/// 검사 결과 전체 — CLI가 그대로 찍는다.
pub fn check(export: &Value, workspace: &Path, acknowledged: Option<&str>) -> Result<Value, String> {
    let plan = plan(export)?;
    let current = fingerprint(|args| read_only_git(workspace, args));
    let precondition = judge(export.get("workspaceFingerprint"), &current);
    let checks = check_applicability(&plan, workspace);

    Ok(serde_json::json!({
        "formatVersion": plan.format_version,
        "taskId": plan.task_id,
        "note": "검사는 아무것도 쓰지 않는다. 전제가 무엇이든 거부하지 않는 이유가 이것이다.",
        "precondition": precondition,
        "currentFingerprint": current,
        // **판정이지 동작이 아니다.** 적용기는 아직 없다.
        "applyGate": {
            "decision": decide_apply(&precondition, acknowledged),
            "note": "적용해도 되는가에 대한 판정이다. 적용기는 아직 없으며, 만들 때 각 단계는 Policy Gate를 그대로 지나야 한다.",
        },
        "reproducibility": summarize(&checks),
        "steps": plan.steps,
        "checks": checks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fp(hash: &str, head: &str) -> Value {
        json!({
            "available": true,
            "fingerprint": hash,
            "gitHead": head,
            "dirty": false,
            "untrackedFiles": 0,
            "inputs": FINGERPRINT_INPUTS,
        })
    }

    // ---- 전제 판정: 세 값을 섞지 않는다 ----

    #[test]
    fn identical_fingerprints_match() {
        let a = fp("sha256:aaa", "c1");
        assert_eq!(
            judge(Some(&a), &a),
            Precondition::Match {
                fingerprint: "sha256:aaa".into()
            }
        );
    }

    /// **"다르다"와 "모른다"가 같은 값이 되면 안 된다.** 잴 수 없었던 것을 달랐다고 보고하면
    /// 읽는 사람은 워크스페이스를 맞추려 시도하는데, 맞출 대상이 애초에 없다.
    #[test]
    fn unmeasurable_is_not_reported_as_different() {
        let unavailable = json!({ "available": false, "reason": "git 저장소가 아닙니다" });
        let ok = fp("sha256:aaa", "c1");

        let recorded_missing = judge(None, &ok);
        assert_eq!(
            recorded_missing,
            Precondition::Unknown {
                reason: UnknownReason::MissingInExport
            }
        );

        let recorded_unavailable = judge(Some(&unavailable), &ok);
        assert!(matches!(
            recorded_unavailable,
            Precondition::Unknown {
                reason: UnknownReason::RecordedUnavailable { .. }
            }
        ));

        let current_unavailable = judge(Some(&ok), &unavailable);
        assert!(matches!(
            current_unavailable,
            Precondition::Unknown {
                reason: UnknownReason::CurrentUnavailable { .. }
            }
        ));

        // 셋 다 Mismatch가 아니다 — 이걸 확인하지 않으면 위 assert들이 값만 보고 통과할 수 있다.
        for p in [recorded_missing, recorded_unavailable, current_unavailable] {
            assert!(
                !matches!(p, Precondition::Mismatch { .. }),
                "모르는 것을 다르다고 했습니다"
            );
        }
    }

    /// 재료가 다르면 값 비교 자체가 성립하지 않는다 — **값이 같아도** 같다고 하지 않는다.
    #[test]
    fn different_inputs_make_the_comparison_meaningless() {
        let mut old = fp("sha256:aaa", "c1");
        old["inputs"] = json!(["rev-parse HEAD"]);
        let now = fp("sha256:aaa", "c1");
        assert!(matches!(
            judge(Some(&old), &now),
            Precondition::Unknown {
                reason: UnknownReason::InputsDiffer { .. }
            }
        ));
    }

    /// 불일치는 **무엇이 다른지**까지 말한다. HEAD가 같으면 남는 재료는 워킹 트리뿐이고,
    /// 그건 사용자가 좁힐 수 있는 차이다.
    #[test]
    fn mismatch_says_what_differs() {
        let recorded = fp("sha256:aaa", "c1");
        let same_head = fp("sha256:bbb", "c1");
        let other_head = fp("sha256:bbb", "c2");

        match judge(Some(&recorded), &same_head) {
            Precondition::Mismatch { differs, .. } => assert_eq!(differs, vec![Difference::WorkingTree]),
            other => panic!("불일치가 아닙니다: {other:?}"),
        }
        match judge(Some(&recorded), &other_head) {
            Precondition::Mismatch { differs, .. } => assert_eq!(differs, vec![Difference::GitHead]),
            other => panic!("불일치가 아닙니다: {other:?}"),
        }
    }

    // ---- 적용 판정 ----

    #[test]
    fn matching_state_may_apply() {
        let pre = Precondition::Match {
            fingerprint: "sha256:aaa".into(),
        };
        assert_eq!(decide_apply(&pre, None), ApplyDecision::Allowed);
    }

    /// 불일치는 확인으로 넘을 수 있다. 단 **기대 지문을 명시해야** 한다 — 플래그 하나로
    /// 넘을 수 있으면 "무엇이 다른지 보지 않고 강행"이 가능해지고, 그러면 규칙이 없는 것과 같다.
    #[test]
    fn mismatch_needs_the_recorded_fingerprint_to_be_named() {
        let pre = judge(Some(&fp("sha256:aaa", "c1")), &fp("sha256:bbb", "c1"));
        assert!(matches!(
            decide_apply(&pre, None),
            ApplyDecision::NeedsAcknowledgement { .. }
        ));
        assert_eq!(decide_apply(&pre, Some("sha256:aaa")), ApplyDecision::Allowed);
        // 다른 기록을 보고 확인했을 수 있다 — 그건 확인이 아니다.
        assert!(matches!(
            decide_apply(&pre, Some("sha256:zzz")),
            ApplyDecision::Refused { .. }
        ));
    }

    /// **모르는 것은 확인으로 넘지 못한다.** 볼 수 없는 차이에 대한 확인은 내용이 없다.
    #[test]
    fn unknown_cannot_be_acknowledged_away() {
        let pre = Precondition::Unknown {
            reason: UnknownReason::MissingInExport,
        };
        assert!(matches!(decide_apply(&pre, None), ApplyDecision::Refused { .. }));
        assert!(matches!(
            decide_apply(&pre, Some("sha256:aaa")),
            ApplyDecision::Refused { .. }
        ));
    }

    // ---- 계획 복원 ----

    fn export_with(steps: Value) -> Value {
        json!({
            "formatVersion": crate::export::EXPORT_FORMAT_VERSION,
            "task": { "taskId": "task-1" },
            "reproduce": { "steps": steps },
        })
    }

    #[test]
    fn unknown_format_version_is_refused_rather_than_guessed() {
        let mut e = export_with(json!([]));
        e["formatVersion"] = json!(crate::export::EXPORT_FORMAT_VERSION + 7);
        assert!(plan(&e).is_err(), "모르는 형식 버전을 읽었습니다");
        // 아는 버전은 읽힌다 — 위 거부가 모든 파일을 막는 것이 아님을 확인한다.
        assert!(plan(&export_with(json!([]))).is_ok());
    }

    /// 기록에서 실패한 단계를 **표시한다.** 표시가 없으면 재현이 같은 종료 코드를 냈을 때
    /// 읽는 사람이 재현 실패로 읽는다. 그리고 종료 코드가 **없는** 것은 실패가 아니다.
    #[test]
    fn steps_carry_whether_they_failed_in_the_record() {
        let p = plan(&export_with(json!([
            { "requestId": "r1", "tool": "run_command", "args": {}, "recordedOutcome": { "exitCode": 0 } },
            { "requestId": "r2", "tool": "run_command", "args": {}, "recordedOutcome": { "exitCode": 1 } },
            { "requestId": "r3", "tool": "apply_patch", "args": {}, "recordedOutcome": { "exitCode": null } },
        ])))
        .unwrap();
        assert_eq!(
            p.steps.iter().map(|s| s.failed_in_record).collect::<Vec<_>>(),
            vec![false, true, false]
        );
    }

    // ---- 적용 가능성 ----

    fn workspace_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, body) in files {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        dir
    }

    fn patch_step(path: &str, patch: &str) -> Value {
        json!({ "requestId": "r", "tool": "apply_patch", "args": { "path": path, "patch": patch } })
    }

    /// 같은 파일을 두 번 고친 기록이 **거짓 실패**를 내면 안 된다. 두 번째 patch는 첫 번째가
    /// 적용된 결과에 붙기 때문이다 — 디스크의 현재 내용에 대고 검사하면 반드시 어긋난다.
    #[test]
    fn sequential_patches_are_checked_against_the_simulated_result() {
        let ws = workspace_with(&[("a.txt", "one\n")]);
        let p1 = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";
        let p2 = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n";
        let plan = plan(&export_with(json!([patch_step("a.txt", p1), patch_step("a.txt", p2)]))).unwrap();

        let checks = check_applicability(&plan, ws.path());
        assert_eq!(checks[0].check, StepCheck::Applies);
        assert_eq!(checks[1].check, StepCheck::Applies, "두 번째 patch가 거짓 실패했습니다");
        assert_eq!(summarize(&checks), Reproducibility::Yes);

        // 디스크는 그대로다 — 검사는 아무것도 쓰지 않는다.
        assert_eq!(std::fs::read_to_string(ws.path().join("a.txt")).unwrap(), "one\n");
    }

    /// 붙지 않는 patch는 붙지 않는다고 말한다. **지문과 무관하게** 이 사실이 나와야 한다 —
    /// 지문이 달라도 patch가 붙는지는 별개의 증거다.
    #[test]
    fn a_patch_that_does_not_apply_is_reported() {
        let ws = workspace_with(&[("a.txt", "something else\n")]);
        let plan = plan(&export_with(json!([patch_step(
            "a.txt",
            "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n"
        )])))
        .unwrap();
        let checks = check_applicability(&plan, ws.path());
        assert!(matches!(checks[0].check, StepCheck::WouldFail { .. }));
        assert_eq!(summarize(&checks), Reproducibility::No);
    }

    /// 명령 뒤의 patch는 **실패가 아니라 판정 불가**다. 실패로 부르면 "명령이 만든 파일에 붙는
    /// patch"가 전부 재현 불가로 뒤집힌다.
    #[test]
    fn steps_after_a_command_are_undecidable_not_failed() {
        let ws = workspace_with(&[("a.txt", "one\n")]);
        let plan = plan(&export_with(json!([
            { "requestId": "r1", "tool": "run_command", "args": { "program": "npm", "args": ["run", "build"] } },
            patch_step("generated.txt", "--- a/generated.txt\n+++ b/generated.txt\n@@ -1 +1 @@\n-x\n+y\n"),
        ])))
        .unwrap();
        let checks = check_applicability(&plan, ws.path());
        assert!(matches!(checks[0].check, StepCheck::NotDecidable { .. }));
        assert!(
            matches!(checks[1].check, StepCheck::NotDecidable { .. }),
            "명령 뒤의 단계를 실패로 판정했습니다: {:?}",
            checks[1].check
        );
        assert_eq!(summarize(&checks), Reproducibility::Unknown);
    }

    /// **확실한 실패가 판정 불가를 이긴다.** 하나라도 붙지 않으면 그 계획은 그대로 재현되지
    /// 않고, 나머지를 몰라도 그 사실은 이미 확정이다.
    #[test]
    fn a_definite_failure_outranks_an_undecidable_step() {
        let ws = workspace_with(&[("a.txt", "different\n")]);
        let plan = plan(&export_with(json!([
            patch_step("a.txt", "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n"),
            { "requestId": "r2", "tool": "run_command", "args": {} },
        ])))
        .unwrap();
        assert_eq!(summarize(&check_applicability(&plan, ws.path())), Reproducibility::No);
    }

    /// 삭제된 파일을 다시 고치려는 기록은 붙지 않는다 — 겹침이 "없음"과 "안 봤음"을 구별해야만
    /// 나오는 답이다.
    #[test]
    fn deleting_then_patching_the_same_path_does_not_fall_back_to_disk() {
        let ws = workspace_with(&[("a.txt", "one\n")]);
        let plan = plan(&export_with(json!([
            { "requestId": "r1", "tool": "delete_file", "args": { "path": "a.txt" } },
            patch_step("a.txt", "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n"),
        ])))
        .unwrap();
        let checks = check_applicability(&plan, ws.path());
        assert_eq!(checks[0].check, StepCheck::Applies);
        assert!(
            matches!(checks[1].check, StepCheck::WouldFail { .. }),
            "삭제된 파일을 디스크에서 다시 읽었습니다: {:?}",
            checks[1].check
        );
    }

    /// 읽기 전용 러너는 **구조적으로** 읽기만 한다. 주석이 아니라 코드가 막아야 한다.
    #[test]
    fn the_read_only_git_runner_refuses_writing_subcommands() {
        let ws = tempfile::tempdir().unwrap();
        for sub in ["commit", "checkout", "clean", "reset", "apply"] {
            assert!(
                read_only_git(ws.path(), &[sub]).is_err(),
                "{sub}가 읽기 전용 경로에서 허용됐습니다"
            );
        }
    }

    /// git 저장소가 아니면 지문을 내지 않는다 — **빈 해시는 "상태가 비어 있었다"로 읽힌다.**
    #[test]
    fn a_non_repository_yields_unavailable_not_an_empty_hash() {
        let ws = tempfile::tempdir().unwrap();
        let out = fingerprint(|args| read_only_git(ws.path(), args));
        assert_eq!(out["available"], json!(false));
        assert!(out.get("fingerprint").is_none(), "잴 수 없었는데 해시가 나왔습니다");
    }
}
