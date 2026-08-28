//! Tool Runtime — 승인된 `ToolRequest`만 실제로 실행하는 곳.
//!
//! docs/design/process-architecture.md 2절: Node는 실행 권한이 없다. 파일 I/O와 프로세스 spawn은
//! 전부 여기서 일어나고, 모든 진입점은 Policy Gate를 이미 통과했음을 전제한다 —
//! 그 전제를 타입으로 강제하기 위해 `execute()`는 `PolicyDecision`을 인자로 받고,
//! 판단이 `Deny`면 실행하지 않는다.

pub mod patch;
pub mod program;

use crate::artifacts::ArtifactStore;
use crate::cancel::CancellationToken;
use crate::paths::WorkspaceRoot;
use crate::policy::parse_run_command;
use crate::proctree;
use crate::tools::program::Platform;
use crate::time::{elapsed_ms, now_iso};
use crate::types::{
    Decision, DenialKind, FileMutationRecord, ImageRef, PolicyDecision, RunCommandArgs, ToolName, ToolRequest,
    ToolResult, ToolStatus,
};
use serde_json::json;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 명령 출력 상한. 이 크기를 넘으면 잘라서 IPC로 보내고 전체는 artifact로 저장한다
/// (작업 지침 4.3절: "대용량 결과는 artifact로 저장하고 작은 preview만 IPC로 보낸다").
pub const MAX_INLINE_OUTPUT_BYTES: usize = 16 * 1024;
/// 파일 읽기 상한. 이보다 큰 파일은 잘라서 읽고 truncated 표시를 남긴다.
pub const MAX_READ_FILE_BYTES: usize = 512 * 1024;
/// 검색 결과 상한
pub const MAX_SEARCH_MATCHES: usize = 200;
/// 파일 목록 상한
pub const MAX_LIST_ENTRIES: usize = 5_000;

pub struct ToolRuntime {
    root: WorkspaceRoot,
    artifacts: ArtifactStore,
    default_timeout: Duration,
    /// 등록된 MCP 서버들(mcp.rs). **없는 것이 기본이다** — 서버를 등록하지 않은 사용자에게
    /// MCP 도구는 존재하지 않아야 한다.
    ///
    /// 런타임이 세션을 **소유하지 않고 빌려 쓴다**: 프로세스 수명은 태스크 수명에 걸리므로
    /// 호스트가 들고, 여기서는 요청 하나를 넘기기만 한다.
    mcp: Option<std::sync::Arc<crate::mcp::McpPool>>,
}

/// 실행 결과 + 부수 기록. 호출자(host)가 이걸 받아 SQLite에 기록한다 —
/// Tool Runtime이 직접 DB를 만지지 않는 이유는 트랜잭션 경계를 host가 소유해야
/// "이벤트와 상태를 같은 트랜잭션에 쓴다"는 불변식을 지킬 수 있기 때문이다.
pub struct ToolOutcome {
    pub result: ToolResult,
    /// 이 요청이 남긴 파일 변경들.
    ///
    /// **`Option` 하나가 아니라 목록인 이유**(state-machine 44절): `move_file`은 한 요청으로
    /// 두 파일을 바꾼다(원본이 사라지고 대상이 생긴다). 하나만 기록하면 되돌리기가 절반만
    /// 알게 되고, 그러면 이동은 되돌려지지 않는다. 타입을 바꾸면 컴파일러가 소비하는 자리를
    /// 전부 지목한다 — 사람이 기억할 규칙으로 두지 않는다.
    pub mutations: Vec<FileMutationRecord>,
    /// 출력이 커서 artifact로 밀어낸 경우의 참조
    pub output_ref: Option<String>,
    /// UI diff 패널용 unified diff (파일 변경 도구일 때만)
    pub diff: Option<String>,
}

/// 이 요청에 대한 승인 상태.
///
/// `bool`을 쓰지 않는 이유는 `execute`의 주석에 있다 — `false`가 세 가지 서로 다른 사실을
/// 뭉친다: 승인이 필요 없었다 / 사람이 거부했다 / 물을 사람이 없었다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalState {
    /// 게이트가 승인을 요구하지 않았다.
    NotRequired,
    Granted,
    /// 사용자가 **미리** 정해 둔 정책이 승인했다 — 그 순간 사람이 답한 것이 아니다.
    ///
    /// `Granted`와 나누는 이유는 `Unattended`를 `Denied`와 나눈 이유와 같다: 뭉개면 감사
    /// 로그가 "사용자가 이 요청을 보고 승인했다"고 말하는데, 사용자는 명령이 무엇인지 모르는
    /// 채로 규칙만 켜 두었다. 규칙이 승인한 것과 사람이 승인한 것은 다른 사실이다.
    GrantedByPolicy,
    DeniedByUser,
    /// 무인 실행이라 물을 사람이 없었다 (product-strategy 8.2절 Autopilot).
    Unattended,
}

impl ApprovalState {
    pub fn is_granted(self) -> bool {
        matches!(self, Self::Granted | Self::GrantedByPolicy | Self::NotRequired)
    }
}

impl ToolRuntime {
    pub fn new(root: WorkspaceRoot, artifacts: ArtifactStore, default_timeout: Duration) -> Self {
        Self {
            root,
            artifacts,
            default_timeout,
            mcp: None,
        }
    }

    /// 등록된 MCP 서버를 붙인다. 붙이지 않으면 `mcp_call`은 **실행되지 않고 사유가 남는다.**
    pub fn with_mcp(mut self, pool: std::sync::Arc<crate::mcp::McpPool>) -> Self {
        self.mcp = Some(pool);
        self
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    /// 모든 도구 실행의 단일 진입점.
    ///
    /// `decision`은 Policy Gate의 판단이며, `Deny`거나 승인이 필요한데 아직 승인되지 않았으면
    /// 실행하지 않는다. 승인 여부(`approved`)는 host가 사용자 응답을 받아 넘긴다.
    /// `cancel`은 태스크의 취소 신호다. 실행 직전과 (파일 도구의 경우) 기록 직전에 검사하며,
    /// `run_command`는 실행 **중에도** 감시한다.
    /// 도구 하나를 실행한다.
    ///
    /// `approval`이 `bool`이 아닌 이유: `false`는 **"왜 승인되지 않았는가"를 이미 잃은 값**이다.
    /// 사람이 거부한 것과 무인 실행이라 물을 사람이 없었던 것은 결과 기록에서 구별되어야 하고
    /// (다음에 할 일이 다르다), 그 구별을 아는 것은 호출자다.
    pub fn execute(
        &self,
        request: &ToolRequest,
        decision: &PolicyDecision,
        approval: ApprovalState,
        cancel: &CancellationToken,
    ) -> ToolOutcome {
        let start = Instant::now();

        if matches!(decision.decision, Decision::Deny) {
            return self.denied(request, start, &decision.reason, DenialKind::Policy);
        }
        if decision.requires_user_approval && !approval.is_granted() {
            let (label, kind) = match approval {
                ApprovalState::Unattended => (
                    "무인 실행(Autopilot)이라 승인을 물을 사람이 없었음",
                    DenialKind::Unattended,
                ),
                _ => ("사용자 승인이 필요하지만 승인되지 않았음", DenialKind::User),
            };
            return self.denied(request, start, &format!("{label}: {}", decision.reason), kind);
        }
        // 취소된 태스크의 도구는 시작하지 않는다. `Denied`가 아니라 `Cancelled`로 보고해야
        // 호출자가 "정책이 막았다"와 "사용자가 멈췄다"를 구별할 수 있다.
        if cancel.is_cancelled() {
            return self.cancelled(request, start, "취소된 태스크의 도구 실행을 시작하지 않음");
        }

        match self.dispatch(request, start, cancel) {
            Ok(outcome) => outcome,
            Err(message) => ToolOutcome {
                result: ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Error,
                    output: None,
                    error: Some(message),
                    duration_ms: elapsed_ms(start),
                    completed_at: now_iso(),
                    denial_kind: None,
                    file_failure: None,
                },
                mutations: Vec::new(),
                output_ref: None,
                diff: None,
            },
        }
    }

    /// 파일을 바꾸려다 실패했을 때 — **왜 실패했는지를 값으로 함께 남긴다**(65절).
    ///
    /// OS의 문장만 남기면 두 가지가 일어난다. 사용자에게는 도구가 고장 난 것으로 읽히고,
    /// 오케스트레이터는 **재시도한다** — 경로가 길어서 실패한 쓰기도 상한만큼 다시 한다.
    ///
    /// 판정이 없으면(`None`) OS의 문장을 그대로 남긴다. 없는 처방을 지어내지 않는다.
    fn write_failed(&self, request: &ToolRequest, start: Instant, target: &str, err: &std::io::Error) -> ToolOutcome {
        let failure = crate::file_errors::diagnose(Platform::current(), target, err);
        // **사실 문장은 판정이 있으면 그것을 쓴다.** OS 문장은 뒤에 붙여 남긴다 — 지우면
        // 우리가 모르는 실패를 디버깅할 근거가 사라진다.
        let message = match &failure {
            Some(f) => format!("{} ({err})", f.fact),
            None => err.to_string(),
        };
        ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Error,
                output: None,
                error: Some(message),
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
                denial_kind: None,
                file_failure: failure,
            },
            mutations: Vec::new(),
            output_ref: None,
            diff: None,
        }
    }

    fn denied(&self, request: &ToolRequest, start: Instant, reason: &str, kind: DenialKind) -> ToolOutcome {
        ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Denied,
                output: None,
                error: Some(reason.to_string()),
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
                denial_kind: Some(kind),
                file_failure: None,
            },
            mutations: Vec::new(),
            output_ref: None,
            diff: None,
        }
    }

    fn cancelled(&self, request: &ToolRequest, start: Instant, reason: &str) -> ToolOutcome {
        ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Cancelled,
                output: None,
                error: Some(reason.to_string()),
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
                denial_kind: None,
                file_failure: None,
            },
            mutations: Vec::new(),
            output_ref: None,
            diff: None,
        }
    }

    fn dispatch(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        match request.tool {
            ToolName::ListFiles => self.list_files(request, start),
            ToolName::SearchText => self.search_text(request, start),
            ToolName::ReadFile => self.read_file(request, start),
            ToolName::CreateFile => self.create_file(request, start, cancel),
            ToolName::ApplyPatch => self.apply_patch(request, start, cancel),
            ToolName::DeleteFile => self.delete_file(request, start, cancel),
            ToolName::MoveFile => self.move_file(request, start, cancel),
            ToolName::RunCommand | ToolName::RunTests => self.run_command(request, start, cancel),
            ToolName::GitStatus => self.git(request, start, &["status", "--porcelain=v1", "--branch"], cancel),
            ToolName::GitDiff => self.git_diff(request, start, cancel),
            ToolName::McpCall => self.mcp_call(request, start),
            ToolName::GitPush => self.git_push(request, start, cancel),
        }
    }

    // ---- 읽기 도구 ----

    fn list_files(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        let sub = request.args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let base = self.root.resolve_existing(sub).map_err(|e| e.to_string())?;
        let builder = workspace_walker(base.absolute());

        let mut entries: Vec<serde_json::Value> = Vec::new();
        let mut truncated = false;
        for item in builder.build() {
            let Ok(entry) = item else { continue };
            let path = entry.path();
            if path == base.absolute() {
                continue;
            }
            let Ok(rel) = path.strip_prefix(self.root.path()) else {
                continue;
            };
            if entries.len() >= MAX_LIST_ENTRIES {
                truncated = true;
                break;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
            entries.push(json!({
                "path": to_forward_slashes(rel),
                "isDir": is_dir,
                "sizeBytes": size,
            }));
        }

        self.ok_json(
            request,
            start,
            json!({ "entries": entries, "truncated": truncated, "root": base.relative() }),
        )
    }

    fn search_text(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        let pattern = request
            .args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "search_text에 \"pattern\" 인자가 없음".to_string())?;
        let sub = request.args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let base = self.root.resolve_existing(sub).map_err(|e| e.to_string())?;

        let case_insensitive = request
            .args
            .get("caseInsensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let regex = regex::RegexBuilder::new(pattern)
            .case_insensitive(case_insensitive)
            .build()
            .map_err(|e| format!("잘못된 정규식: {e}"))?;

        let mut matches: Vec<serde_json::Value> = Vec::new();
        let mut truncated = false;
        // 건너뛴 비밀값 파일 수 — 조용히 빼면 "검색했는데 없다"와 구별되지 않는다.
        let mut skipped_secret_files = 0usize;

        let builder = workspace_walker(base.absolute());

        'outer: for item in builder.build() {
            let Ok(entry) = item else { continue };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let Ok(rel_early) = path.strip_prefix(self.root.path()) else {
                continue;
            };
            // 비밀값 파일은 **읽기 전에** 건너뛴다.
            //
            // 왜 여기서 막아야 하는가: `search_text`는 자동 승인 도구다. 매칭된 줄 본문을
            // 그대로 돌려주므로, 제외하지 않으면 `pattern: "sk-"` 한 번으로 승인 절차 없이
            // API 키를 그대로 얻을 수 있다. 경로 기반 이벤트 redaction으로는 막을 수 없다 —
            // 검색 대상은 디렉터리이고 유출되는 것은 다른 파일의 내용이기 때문이다.
            if crate::policy::secrets::is_secret_path(&to_forward_slashes(rel_early)) {
                skipped_secret_files += 1;
                continue;
            }
            let Ok(bytes) = std::fs::read(path) else { continue };
            if is_binary(&bytes) {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else { continue };
            let rel = rel_early;
            for (idx, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    if matches.len() >= MAX_SEARCH_MATCHES {
                        truncated = true;
                        break 'outer;
                    }
                    matches.push(json!({
                        "path": to_forward_slashes(rel),
                        "line": idx + 1,
                        "text": truncate_str(line, 400),
                    }));
                }
            }
        }

        self.ok_json(
            request,
            start,
            json!({
                "matches": matches,
                "truncated": truncated,
                // 무엇이 빠졌는지 알려준다. 오케스트레이터가 "여기 없으니 없다"고 결론 내리는 것을
                // 막고, 사용자에게도 "비밀값 파일은 검색하지 않았다"를 표시할 수 있게 한다.
                "skippedSecretFiles": skipped_secret_files,
            }),
        )
    }

    fn read_file(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        let path = require_str_arg(request, "path")?;
        let safe = self.root.resolve_existing(&path).map_err(|e| e.to_string())?;
        let bytes = std::fs::read(safe.absolute()).map_err(|e| e.to_string())?;

        if is_binary(&bytes) {
            return self.ok_json(
                request,
                start,
                json!({
                    "path": safe.relative(),
                    "binary": true,
                    "sizeBytes": bytes.len(),
                    "content": null,
                    "truncated": false,
                }),
            );
        }

        let full_len = bytes.len();
        let truncated = full_len > MAX_READ_FILE_BYTES;
        let slice = if truncated {
            &bytes[..MAX_READ_FILE_BYTES]
        } else {
            &bytes[..]
        };
        let content = String::from_utf8_lossy(slice).to_string();

        self.ok_json(
            request,
            start,
            json!({
                "path": safe.relative(),
                "binary": false,
                "content": content,
                "sizeBytes": full_len,
                "includedBytes": slice.len(),
                "truncated": truncated,
            }),
        )
    }

    // ---- 파일 변경 도구 ----

    fn create_file(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let path = require_str_arg(request, "path")?;
        let content = request
            .args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "create_file에 \"content\" 인자가 없음".to_string())?;
        let overwrite = request.args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(true);

        let safe = self.root.resolve_for_create(&path).map_err(|e| e.to_string())?;
        let existed = safe.absolute().exists();
        if existed && !overwrite {
            return Err(format!("{}가 이미 존재하며 overwrite=false임", safe.relative()));
        }

        let before = if existed {
            std::fs::read_to_string(safe.absolute()).unwrap_or_default()
        } else {
            String::new()
        };

        // mutation 기록 직전 취소 검사. 여기서 걸러야 "취소했는데 파일이 바뀌었다"가 안 생긴다.
        // 검사와 쓰기 사이의 창은 원자적으로 없앨 수 없으므로(파일 쓰기는 취소 불가) 최소화한다.
        if cancel.is_cancelled() {
            return Ok(self.cancelled(request, start, "취소 요청으로 파일 변경을 적용하지 않음"));
        }
        let pre_image = self.capture_pre_image(request, safe.relative(), existed, &before)?;

        if let Some(parent) = safe.absolute().parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Ok(self.write_failed(request, start, safe.relative(), &e));
            }
        }
        if let Err(e) = std::fs::write(safe.absolute(), content) {
            return Ok(self.write_failed(request, start, safe.relative(), &e));
        }

        let post = self
            .artifacts
            .put_text(
                &request.task_id,
                &format!("{}-{}-post.txt", request.request_id, flatten_path(safe.relative())),
                content,
            )
            .map_err(|e| e.to_string())?;

        let diff = patch::make_unified_diff(safe.relative(), &before, content);
        let mutation = FileMutationRecord {
            request_id: request.request_id.clone(),
            task_id: request.task_id.clone(),
            path: safe.relative().to_string(),
            pre_image,
            post_image: ImageRef {
                existed: true,
                content_ref: Some(post.artifact_ref),
                sha256: Some(post.sha256),
            },
        };

        let mut outcome = self.ok_json(
            request,
            start,
            json!({ "path": safe.relative(), "created": !existed, "bytesWritten": content.len() }),
        )?;
        outcome.mutations = vec![mutation];
        outcome.diff = if diff.is_empty() { None } else { Some(diff) };
        Ok(outcome)
    }

    fn apply_patch(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let path = require_str_arg(request, "path")?;
        let patch_text = request
            .args
            .get("patch")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "apply_patch에 \"patch\" 인자가 없음".to_string())?;

        let safe = self.root.resolve_for_create(&path).map_err(|e| e.to_string())?;
        let existed = safe.absolute().exists();
        let before = if existed {
            std::fs::read_to_string(safe.absolute()).map_err(|e| format!("{}를 읽을 수 없음: {e}", safe.relative()))?
        } else {
            String::new()
        };

        // 여기서 실패하면 파일은 아직 손대지 않은 상태다 — 부분 적용이 구조적으로 불가능하다.
        let after = patch::apply_unified_diff(&before, patch_text)
            .map_err(|e| format!("{}에 patch를 적용할 수 없음: {e}", safe.relative()))?;

        // mutation 기록 직전 취소 검사. 여기서 걸러야 "취소했는데 파일이 바뀌었다"가 안 생긴다.
        // 검사와 쓰기 사이의 창은 원자적으로 없앨 수 없으므로(파일 쓰기는 취소 불가) 최소화한다.
        if cancel.is_cancelled() {
            return Ok(self.cancelled(request, start, "취소 요청으로 파일 변경을 적용하지 않음"));
        }
        let pre_image = self.capture_pre_image(request, safe.relative(), existed, &before)?;

        if let Some(parent) = safe.absolute().parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Ok(self.write_failed(request, start, safe.relative(), &e));
            }
        }
        if let Err(e) = std::fs::write(safe.absolute(), &after) {
            return Ok(self.write_failed(request, start, safe.relative(), &e));
        }

        let post = self
            .artifacts
            .put_text(
                &request.task_id,
                &format!("{}-{}-post.txt", request.request_id, flatten_path(safe.relative())),
                &after,
            )
            .map_err(|e| e.to_string())?;

        let diff = patch::make_unified_diff(safe.relative(), &before, &after);
        let mutation = FileMutationRecord {
            request_id: request.request_id.clone(),
            task_id: request.task_id.clone(),
            path: safe.relative().to_string(),
            pre_image,
            post_image: ImageRef {
                existed: true,
                content_ref: Some(post.artifact_ref),
                sha256: Some(post.sha256),
            },
        };

        let mut outcome = self.ok_json(
            request,
            start,
            json!({
                "path": safe.relative(),
                "bytesBefore": before.len(),
                "bytesAfter": after.len(),
            }),
        )?;
        outcome.mutations = vec![mutation];
        outcome.diff = if diff.is_empty() { None } else { Some(diff) };
        Ok(outcome)
    }

    fn delete_file(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let path = require_str_arg(request, "path")?;
        let safe = self.root.resolve_existing(&path).map_err(|e| e.to_string())?;

        if safe.absolute().is_dir() {
            // 디렉터리 재귀 삭제는 M0 범위 밖이다 — 되돌리기 기록을 파일 단위로 남기는 구조와
            // 맞지 않고, 잘못 승인했을 때의 피해가 비대칭적으로 크다.
            return Err(format!(
                "{}는 디렉터리임 — delete_file은 파일만 삭제한다",
                safe.relative()
            ));
        }

        let before = std::fs::read_to_string(safe.absolute()).unwrap_or_default();
        if cancel.is_cancelled() {
            return Ok(self.cancelled(request, start, "취소 요청으로 파일 삭제를 수행하지 않음"));
        }
        let pre_image = self.capture_pre_image(request, safe.relative(), true, &before)?;
        if let Err(e) = std::fs::remove_file(safe.absolute()) {
            return Ok(self.write_failed(request, start, safe.relative(), &e));
        }

        let mutation = FileMutationRecord {
            request_id: request.request_id.clone(),
            task_id: request.task_id.clone(),
            path: safe.relative().to_string(),
            pre_image,
            post_image: ImageRef {
                existed: false,
                content_ref: None,
                sha256: None,
            },
        };

        let mut outcome = self.ok_json(request, start, json!({ "path": safe.relative(), "deleted": true }))?;
        outcome.mutations = vec![mutation];
        Ok(outcome)
    }

    /// 파일 하나를 다른 경로로 옮긴다 — state-machine 44절.
    ///
    /// # 덮어쓰지 않는다
    ///
    /// 대상이 이미 있으면 **거부한다.** 덮어쓰기는 삭제를 이동 안에 숨기는 것이고, 승인 화면이
    /// "옮깁니다"라고 말한 것과 실제로 일어나는 일(그 자리의 파일이 사라진다)이 달라진다.
    /// 정말 덮어써야 하면 사용자가 지우는 것을 먼저 승인하면 된다 — 우리가 대신 고르지 않는다.
    ///
    /// # 변경을 **둘로** 기록한다
    ///
    /// 요청은 하나지만 파일 시스템에서 일어난 일은 둘이다: 원본이 사라졌고 대상이 생겼다.
    /// 되돌리기는 그 두 사실로 복원한다(기존 기계를 그대로 쓴다 — 이동 전용 복원 경로를
    /// 만들지 않는다).
    ///
    /// # 내용을 읽어 옮기지 않는다
    ///
    /// `std::fs::rename`을 쓴다. 읽어서 쓰고 지우면 큰 파일에서 느리고, 중간에 죽으면 두
    /// 곳에 남는다. 다만 **되돌리기용 pre-image는 읽어 둔다** — 그건 복원의 근거다.
    fn move_file(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let from = require_str_arg(request, "from")?;
        let to = require_str_arg(request, "to")?;
        let from_safe = self.root.resolve_existing(&from).map_err(|e| e.to_string())?;
        let to_safe = self.root.resolve_for_create(&to).map_err(|e| e.to_string())?;

        if from_safe.absolute().is_dir() {
            // `delete_file`과 같은 이유다 — 디렉터리는 되돌리기 기록을 파일 단위로 남기는
            // 구조와 맞지 않고, 잘못 승인했을 때의 피해가 비대칭적으로 크다.
            return Err(format!("{}는 디렉터리임 — move_file은 파일만 옮긴다", from_safe.relative()));
        }
        if to_safe.absolute().exists() {
            return Err(format!(
                "{}가 이미 있음 — move_file은 덮어쓰지 않는다 (덮어쓰려면 그 파일 삭제를 먼저 승인할 것)",
                to_safe.relative()
            ));
        }
        if from_safe.relative() == to_safe.relative() {
            return Err("from과 to가 같은 경로임".to_string());
        }

        let before = std::fs::read_to_string(from_safe.absolute()).unwrap_or_default();
        if cancel.is_cancelled() {
            return Ok(self.cancelled(request, start, "취소 요청으로 파일 이동을 수행하지 않음"));
        }

        // pre-image는 **옮기기 전에** 잡는다. 옮긴 뒤에는 원본이 없다.
        let from_pre = self.capture_pre_image(request, from_safe.relative(), true, &before)?;
        if let Some(parent) = to_safe.absolute().parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Ok(self.write_failed(request, start, to_safe.relative(), &e));
            }
        }
        if let Err(e) = std::fs::rename(from_safe.absolute(), to_safe.absolute()) {
            // **대상이 아니라 원본을 지목한다.** 이동에서 잠기는 것은 대개 열려 있는 원본이다.
            return Ok(self.write_failed(request, start, from_safe.relative(), &e));
        }

        // post-image도 남긴다 — 되돌리기가 "대상이 생겼다"를 지우려면 무엇이 생겼는지 알아야 한다.
        let post_stored = self
            .artifacts
            .put_text(
                &request.task_id,
                &format!("{}-{}-post.txt", request.request_id, flatten_path(to_safe.relative())),
                &before,
            )
            .map_err(|e| e.to_string())?;
        let post = ImageRef {
            existed: true,
            content_ref: Some(post_stored.artifact_ref),
            sha256: Some(post_stored.sha256),
        };
        let mutations = vec![
            // ① 원본이 사라졌다 — `delete_file`이 남기는 것과 같은 모양이다.
            FileMutationRecord {
                request_id: request.request_id.clone(),
                task_id: request.task_id.clone(),
                path: from_safe.relative().to_string(),
                pre_image: from_pre,
                post_image: ImageRef {
                    existed: false,
                    content_ref: None,
                    sha256: None,
                },
            },
            // ② 대상이 생겼다 — `create_file`이 남기는 것과 같은 모양이다.
            FileMutationRecord {
                request_id: request.request_id.clone(),
                task_id: request.task_id.clone(),
                path: to_safe.relative().to_string(),
                pre_image: ImageRef {
                    existed: false,
                    content_ref: None,
                    sha256: None,
                },
                post_image: post,
            },
        ];

        let mut outcome = self.ok_json(
            request,
            start,
            json!({ "from": from_safe.relative(), "to": to_safe.relative(), "moved": true }),
        )?;
        outcome.mutations = mutations;
        Ok(outcome)
    }

    /// 변경 전 내용을 artifact로 저장한다. 롤백과 diff 표시가 모두 이걸 쓴다
    /// (state-machine-and-protocol.md 10절 — git stash를 쓰지 않는 이유).
    fn capture_pre_image(
        &self,
        request: &ToolRequest,
        rel_path: &str,
        existed: bool,
        before: &str,
    ) -> Result<ImageRef, String> {
        if !existed {
            return Ok(ImageRef {
                existed: false,
                content_ref: None,
                sha256: None,
            });
        }
        let stored = self
            .artifacts
            .put_text(
                &request.task_id,
                &format!("{}-{}-pre.txt", request.request_id, flatten_path(rel_path)),
                before,
            )
            .map_err(|e| e.to_string())?;
        Ok(ImageRef {
            existed: true,
            content_ref: Some(stored.artifact_ref),
            sha256: Some(stored.sha256),
        })
    }

    // ---- 명령 실행 ----

    fn run_command(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        // Policy Gate가 이미 검증했지만 다시 파싱한다 — 같은 args에서 같은 결론이 나와야 하고,
        // 여기서 별도 경로로 argv를 조립하면 "승인된 것과 실행되는 것"이 갈라질 수 있다.
        let cmd = parse_run_command(&request.args)?;
        let cwd = self.root.resolve_existing(&cmd.cwd).map_err(|e| e.to_string())?;
        let timeout = cmd
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(self.default_timeout);

        // **개발자 환경은 명령이 필요로 할 때만 붙는다**(msvc.rs, state-machine 40절).
        // 준비하지 못해도 막지 않는다 — 탐지가 틀릴 수 있고, 틀린 판정으로 되는 명령을 막는
        // 것이 못 준비한 채 실행하는 것보다 나쁘다. 대신 무엇을 확인했는지 결과에 남긴다.
        let developer_env = developer_env_for(&cmd);

        // **추가 환경변수는 요청 구조체에서만 온다** — Node의 JSON에서는 읽지 않는다
        // (`ToolRequest::injected_env`의 `skip_deserializing`). 지금 채우는 곳은 phase 훅뿐이다.
        //
        // 순서: 개발자 환경을 먼저 깔고 요청의 것을 덮는다. 훅이 넘기는 `TOMVERSE_*`와는
        // 겹치지 않지만, 겹칠 때 이기는 쪽을 정해 두지 않으면 나중에 조용히 갈린다.
        let mut env: std::collections::BTreeMap<String, String> =
            developer_env.as_ref().map(|p| p.vars()).unwrap_or_default();
        env.extend(request.injected_env.clone());

        let execution = match run_process(&cmd, cwd.absolute(), timeout, cancel, &env) {
            Ok(execution) => execution,
            Err(refusal) => return self.spawn_refused(request, &cmd, refusal),
        };
        self.finish_command(request, start, &cmd, execution, developer_env)
    }

    fn git(
        &self,
        request: &ToolRequest,
        start: Instant,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let cmd = RunCommandArgs {
            program: "git".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: ".".to_string(),
            timeout_ms: None,
        };
        let execution = match run_process(&cmd, self.root.path(), self.default_timeout, cancel, &Default::default()) {
            Ok(execution) => execution,
            Err(refusal) => return self.spawn_refused(request, &cmd, refusal),
        };
        self.finish_command(request, start, &cmd, execution, None)
    }

    /// 브랜치를 remote로 올린다 — pr.rs, state-machine 28절.
    ///
    /// **인자를 다시 뜯는다.** 게이트가 이미 검증했지만, 여기서 별도 경로로 argv를 조립하면
    /// "승인된 것과 실행되는 것"이 갈라질 수 있다(`run_command`와 같은 이유).
    fn git_push(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let target = crate::pr::parse_push(&request.args).map_err(|e| e.to_string())?;
        let cmd = target.command();
        let execution = match run_process(&cmd, self.root.path(), self.default_timeout, cancel, &Default::default()) {
            Ok(execution) => execution,
            Err(refusal) => return self.spawn_refused(request, &cmd, refusal),
        };
        self.finish_command(request, start, &cmd, execution, None)
    }

    /// MCP 도구 호출 — mcp.rs, state-machine 23절.
    ///
    /// **여기까지 온 요청은 이미 Policy Gate와 사용자 승인을 지났다**(게이트가 `mcp_call`을
    /// 언제나 `RequireUserApproval`로 분류한다). 그래서 여기서 다시 판정하지 않는다 —
    /// 두 곳에서 판정하면 언젠가 둘이 갈라지고, 갈라진 쪽이 느슨하면 그게 우회 경로가 된다.
    fn mcp_call(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        let call = crate::mcp::parse_call(&request.args)?;
        let Some(pool) = self.mcp.as_ref() else {
            // **"서버가 없다"와 "호출이 실패했다"를 뭉개지 않는다.** 전자는 설정 문제이고
            // 사용자가 할 일이 다르다.
            return Err(
                "MCP 서버가 등록되어 있지 않습니다 — 등록은 사용자만 할 수 있습니다(모델이 서버를 추가하는 경로는 없습니다)"
                    .to_string(),
            );
        };
        match pool.call(&call) {
            Ok(value) => Ok(ToolOutcome {
                result: ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Ok,
                    // 서버가 돌려준 것을 **그대로** 싣는다. 요약하면 감사 기록이 실제로
                    // 무엇이 오갔는지에 답하지 못한다.
                    output: Some(serde_json::json!({ "server": call.server, "tool": call.tool, "result": value })),
                    error: None,
                    duration_ms: elapsed_ms(start),
                    completed_at: now_iso(),
                    denial_kind: None,
                    file_failure: None,
                },
                mutations: Vec::new(),
                output_ref: None,
                diff: None,
            }),
            // **`status`는 "우리가 호출할 수 있었는가"를 말한다.** 서버가 돌려준 결과 안의
            // `isError`는 도구 자신의 판정이므로 그대로 실어 보내고 여기서 뒤집지 않는다 —
            // `run_command`가 0이 아닌 종료 코드를 `Ok`로 두는 것과 같은 구별이다.
            Err(e) => Err(e.to_string()),
        }
    }

    fn git_diff(
        &self,
        request: &ToolRequest,
        start: Instant,
        cancel: &CancellationToken,
    ) -> Result<ToolOutcome, String> {
        let mut args = vec!["diff".to_string()];
        if request.args.get("staged").and_then(|v| v.as_bool()).unwrap_or(false) {
            args.push("--staged".to_string());
        }
        if request.args.get("statOnly").and_then(|v| v.as_bool()).unwrap_or(false) {
            args.push("--stat".to_string());
        }
        if let Some(path) = request.args.get("path").and_then(|v| v.as_str()) {
            // 경로 인자도 workspace 안이어야 한다.
            let safe = self.root.resolve_existing(path).map_err(|e| e.to_string())?;
            args.push("--".to_string());
            args.push(safe.relative().to_string());
        }
        let cmd = RunCommandArgs {
            program: "git".to_string(),
            args,
            cwd: ".".to_string(),
            timeout_ms: None,
        };
        let execution = match run_process(&cmd, self.root.path(), self.default_timeout, cancel, &Default::default()) {
            Ok(execution) => execution,
            Err(refusal) => return self.spawn_refused(request, &cmd, refusal),
        };
        self.finish_command(request, start, &cmd, execution, None)
    }

    /// 실행을 내놓지 못한 두 경우를 가른다 (71.2절).
    ///
    /// `Failed`는 종전 그대로 `Err`로 올라가 `ToolStatus::Error` + 문자열이 된다.
    /// `NotSpawned`는 **구조를 실어야 하므로** 여기서 결과를 직접 만든다 — 문자열만 남기면
    /// 화면과 모델이 "실행했는데 실패"와 "시작하지 않음"을 다시 구별하지 못한다.
    /// `start`를 받지 않는다 — 이 경로에는 **잴 실행이 없다**(아래 `durationMs` 참조).
    fn spawn_refused(
        &self,
        request: &ToolRequest,
        cmd: &RunCommandArgs,
        refusal: SpawnRefusal,
    ) -> Result<ToolOutcome, String> {
        let barrier = match refusal {
            SpawnRefusal::Failed(message) => return Err(message),
            SpawnRefusal::NotSpawned(barrier) => barrier,
        };
        Ok(ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                // **`Denied`가 아니다.** 정책이 막은 것이 아니라 환경이 결과를 해석 불가능하게
                // 만든 것이고, 사용자가 할 일이 다르다(정책 레버를 켜도 이건 지나가지 않는다).
                // `Error`는 `verify.rs`에서 `SkippedWithReason`이 되어 종합 판정을
                // `could_not_run`으로 만든다 — 정확히 우리가 원하는 자리다.
                status: ToolStatus::Error,
                output: Some(json!({
                    "command": { "program": cmd.program, "args": cmd.args, "cwd": cmd.cwd },
                    // **이 한 줄이 이 결함의 핵심이다.** 프로세스가 없었으므로 exit code도
                    // 출력도 없고, 없는 것을 0이나 1로 채우면 그 순간 다시 거짓말이 된다.
                    "spawned": false,
                    "reason": barrier.reason,
                    "workspace": barrier.cwd,
                    "checked": barrier.checked,
                    "remediation": barrier.remediation,
                    "exitCode": serde_json::Value::Null,
                    // 아무것도 돌지 않았다. 정책 판정에 쓴 시간을 여기 적으면 "이 명령이
                    // 얼마나 걸렸나"라는 질문에 없는 실행의 시간이 답하게 된다.
                    "durationMs": 0,
                })),
                error: Some(barrier.message()),
                duration_ms: 0,
                completed_at: now_iso(),
                denial_kind: None,
                // **`None`은 "문제가 없다"가 아니라 "더 말할 것이 없다"이다**(65절).
                // 이 실패는 파일 하나에 대한 것이 아니라 워크스페이스 전체가 만드는
                // 장벽이고, `FileFailure`의 종류 중 어느 것도 그것을 말하지 않는다.
                // 억지로 하나를 고르면 오케스트레이터가 **재시도할 값어치를 잘못 읽는다** —
                // 이 장벽은 다시 해도 같다.
                file_failure: None,
            },
            mutations: Vec::new(),
            output_ref: None,
            diff: None,
        })
    }

    fn finish_command(
        &self,
        request: &ToolRequest,
        start: Instant,
        cmd: &RunCommandArgs,
        execution: Execution,
        // 개발자 환경 (msvc.rs, 40절). `None`은 **필요 없는 명령이었다**는 뜻이고,
        // "준비하지 못했다"와 다른 사실이다 — 그 구별은 `Preparation`의 변형이 담는다.
        developer_env: Option<&crate::msvc::Preparation>,
    ) -> Result<ToolOutcome, String> {
        let combined = format!(
            "$ {}\n\n[stdout]\n{}\n[stderr]\n{}",
            cmd.display(),
            execution.stdout,
            execution.stderr
        );

        // 큰 출력은 artifact로 밀어내고 preview만 IPC로 보낸다.
        let (output_ref, stdout_preview, stderr_preview, output_truncated) = if combined.len() > MAX_INLINE_OUTPUT_BYTES
        {
            let stored = self
                .artifacts
                .put_text(
                    &request.task_id,
                    &format!("{}-output.log", request.request_id),
                    &combined,
                )
                .map_err(|e| e.to_string())?;
            (
                Some(stored.artifact_ref),
                head_tail(&execution.stdout, 60, 60),
                head_tail(&execution.stderr, 60, 60),
                true,
            )
        } else {
            (None, execution.stdout.clone(), execution.stderr.clone(), false)
        };

        // 세 종료 유형을 구별해 보고한다. 취소를 타임아웃으로 보고하면 재시도 정책이
        // 사용자 의사를 무시하고 명령을 다시 실행한다.
        let (status, error) = match &execution.termination {
            Termination::TimedOut => (
                ToolStatus::Timeout,
                Some(format!("명령이 {}ms 후 타임아웃됨", execution.duration_ms)),
            ),
            Termination::Cancelled {
                tree_guaranteed,
                method,
                surviving_pid,
            } => (
                ToolStatus::Cancelled,
                Some(match (surviving_pid, tree_guaranteed) {
                    // 가장 나쁜 경우를 가장 분명하게 말한다: 기다리기를 포기했고 무엇이 남았는지.
                    (Some(pid), _) => format!(
                        "사용자 취소로 중단을 요청했으나 프로세스 {pid}가 종료 상한 안에 끝나지 않았습니다 \
                         (종료 시도: {method}). 아직 실행 중일 수 있으니 직접 확인이 필요합니다."
                    ),
                    (None, true) => format!("사용자 취소로 중단됨 (프로세스 트리 종료: {method})"),
                    // 보장하지 못한다는 사실을 감추지 않는다 — 사용자가 남은 프로세스를
                    // 직접 확인해야 할 수도 있다.
                    (None, false) => {
                        format!("사용자 취소로 중단됨 (프로세스 종료: {method} — 하위 프로세스 종료를 보장하지 못함)")
                    }
                }),
            ),
            // 0이 아닌 종료 코드는 "도구 실행 실패"가 아니라 "명령이 실패했다"는 사실이다.
            // 검증 러너가 이 구분을 필요로 하므로 status는 Ok로 두고 exitCode를 그대로 전달한다.
            // 실행 자체가 안 된 경우(spawn 실패)는 dispatch에서 Err로 처리된다.
            Termination::Exited => (ToolStatus::Ok, None),
        };

        let output = json!({
            // 요청된 명령 — 승인 화면에 표시됐고 Policy Gate가 판정한 바로 그것이다.
            "command": { "program": cmd.program, "args": cmd.args, "cwd": cmd.cwd },
            // 실제로 spawn한 것. Windows에서 `npm test`는 `node.exe npm-cli.js test`가 된다.
            // 둘을 나란히 남기지 않으면 "승인한 것과 실행된 것"의 대응을 사후에 확인할 수 없다.
            "resolvedCommand": {
                "executable": execution.resolved.executable.to_string_lossy(),
                "args": execution.resolved.effective_args,
                "kind": execution.resolved.kind.as_str(),
                "shimPath": execution.resolved.shim_path.as_ref().map(|p| p.to_string_lossy()),
            },
            "exitCode": execution.exit_code,
            "stdout": stdout_preview,
            "stderr": stderr_preview,
            "timedOut": matches!(execution.termination, Termination::TimedOut),
            "cancelled": matches!(execution.termination, Termination::Cancelled { .. }),
            "treeKill": match &execution.termination {
                Termination::Cancelled { tree_guaranteed, method, surviving_pid } => {
                    json!({ "guaranteed": tree_guaranteed, "method": method, "survivingPid": surviving_pid })
                }
                _ => serde_json::Value::Null,
            },
            "outputTruncated": output_truncated,
            "outputRef": output_ref,
            "durationMs": execution.duration_ms,
            // **환경은 argv가 아니다.** 승인 화면이 보여준 argv는 그대로이지만 환경은 달라지므로,
            // 무엇이 붙었는지(또는 왜 못 붙었는지) 여기 남긴다 — 훅의 `injectedEnv`와 같은
            // 규율이다(33.5절). 준비하지 못한 경우가 특히 중요하다: 그 명령이 실패하면
            // 사용자가 읽어야 할 것이 `stdarg.h`가 아니라 이 기록이다.
            "developerEnv": developer_env,
        });

        Ok(ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status,
                output: Some(output),
                error,
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
                denial_kind: None,
                file_failure: None,
            },
            mutations: Vec::new(),
            output_ref,
            diff: None,
        })
    }

    fn ok_json(&self, request: &ToolRequest, start: Instant, output: serde_json::Value) -> Result<ToolOutcome, String> {
        let serialized = serde_json::to_string(&output).unwrap_or_default();
        let (output, output_ref) = if serialized.len() > MAX_INLINE_OUTPUT_BYTES {
            let stored = self
                .artifacts
                .put_text(
                    &request.task_id,
                    &format!("{}-output.json", request.request_id),
                    &serialized,
                )
                .map_err(|e| e.to_string())?;
            (
                json!({
                    "artifactRef": stored.artifact_ref,
                    "sizeBytes": stored.size_bytes,
                    "preview": truncate_str(&serialized, 1024),
                }),
                Some(stored.artifact_ref),
            )
        } else {
            (output, None)
        };

        Ok(ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Ok,
                output: Some(output),
                error: None,
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
                denial_kind: None,
                file_failure: None,
            },
            mutations: Vec::new(),
            output_ref,
            diff: None,
        })
    }

    /// 롤백: pre-image로 파일을 되돌린다.
    ///
    /// state-machine-and-protocol.md 10절대로 **일반 ToolRequest 경로를 그대로 탄다** —
    /// 호출자가 `create_file`/`delete_file` 요청을 만들어 Policy Gate를 통과시킨 뒤 이 함수가
    /// 아니라 `execute()`를 쓴다. 여기서는 그 요청을 만들어주는 것까지만 한다.
    pub fn rollback_requests(&self, task_id: &str, mutations: &[FileMutationRecord]) -> Vec<ToolRequest> {
        let mut requests = Vec::new();
        for m in mutations {
            let args = if m.pre_image.existed {
                let content = m
                    .pre_image
                    .content_ref
                    .as_ref()
                    .and_then(|r| self.artifacts.read_text(r).ok())
                    .unwrap_or_default();
                json!({ "path": m.path, "content": content, "overwrite": true })
            } else {
                // 이 태스크가 만든 파일 → 지운다.
                json!({ "path": m.path })
            };
            requests.push(ToolRequest {
                request_id: format!("rollback-{}", uuid::Uuid::new_v4()),
                task_id: task_id.to_string(),
                tool: if m.pre_image.existed {
                    ToolName::CreateFile
                } else {
                    ToolName::DeleteFile
                },
                args,
                risk_tier: None,
                requested_by: json!({ "role": "orchestrator" }),
                created_at: Some(now_iso()),
                injected_env: Default::default(),
            });
        }
        requests
    }
}

/// 프로세스가 어떻게 끝났는가. 세 경우를 구별하는 것이 이 타입의 목적이다 —
/// `bool timed_out` 하나로는 취소를 표현할 수 없고, 취소를 타임아웃으로 보고하면
/// 재시도 정책이 사용자 의사를 무시하게 된다.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Termination {
    /// 스스로 종료했다 (exit code가 0이 아니어도 여기에 해당한다).
    Exited,
    TimedOut,
    Cancelled {
        tree_guaranteed: bool,
        method: &'static str,
        /// 종료 상한 안에 자식이 사라지지 않아 **기다리기를 포기한** 경우의 PID.
        ///
        /// 이걸 남기는 이유: "취소했습니다"만 말하고 프로세스가 계속 도는 것이 이 기능에서 할
        /// 수 있는 가장 나쁜 일이다. 무엇이 남았는지 알려줘야 사용자가 직접 정리할 수 있다.
        surviving_pid: Option<u32>,
    },
}

struct Execution {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    termination: Termination,
    duration_ms: u64,
    /// 요청 argv가 실제로 무엇으로 실행됐는가. 결과 JSON에 그대로 실린다 —
    /// Windows에서 `npm`이 `node.exe npm-cli.js`가 되므로, 둘을 구별해 남기지 않으면
    /// "승인한 것과 실행된 것"의 대응을 사후에 확인할 수 없다.
    resolved: program::ResolvedProgram,
}

/// 실제 환경으로 프로그램을 해석한다.
///
/// 해석 계층이 필요한 이유는 `program.rs` 모듈 문서에 있다. 요약하면 Windows의 `npm`은
/// `npm.cmd`(배치 shim)이라 `Command::new("npm")`으로는 실행되지 않고, 그 결과 검증이
/// 돌지 않은 채 작업이 완료로 보고됐다.
///
/// **셸을 만들지 않는다.** 해석 결과도 program + argv이며, 인자는 가공 없이 그대로 넘어간다.
fn resolve_for_execution(cmd: &RunCommandArgs) -> Result<program::ResolvedProgram, String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_default();
    let is_file = |p: &Path| p.is_file();
    let env = program::ResolveEnv {
        platform: program::Platform::current(),
        path: &path,
        pathext: &pathext,
        is_file: &is_file,
    };
    program::resolve_program(&cmd.program, &cmd.args, &env).map_err(|e| e.message)
}

/// 프로세스 실행 + 타임아웃.
///
/// `Command`에 해석된 program/args를 그대로 넘긴다 — 셸을 경유하지 않으므로 인자 안의
/// 공백이나 메타문자가 재해석되지 않는다. 이게 승인 모달의 표시가 실제 실행과 일치한다는
/// 보장의 실체다.
/// 이 프로세스가 준비한 개발자 환경 (msvc.rs, state-machine 40절).
///
/// # 성공도 실패도 한 번만 판정한다
///
/// 준비는 프로세스를 하나 띄우는 일이다. 명령마다 하면 **그것이 새 세금이 된다** — 이 기능이
/// 없애려는 바로 그것이다. 그래서 실패도 캐시한다: 못 찾은 상태에서 명령마다 다시 찾으면
/// 느린 데다 결과도 같다.
///
/// 대가는 **VS를 설치한 뒤 앱을 다시 시작해야 한다는 것**이고, 그 사실은 실패 문장이 말한다.
static DEVELOPER_ENV: std::sync::OnceLock<crate::msvc::Preparation> = std::sync::OnceLock::new();

/// 이 명령에 붙일 개발자 환경. 필요 없는 명령이면 `None`이다 —
/// **"필요 없었다"와 "준비하지 못했다"는 다른 사실이고**, 기록에서도 갈려야 한다.
fn developer_env_for(cmd: &RunCommandArgs) -> Option<&'static crate::msvc::Preparation> {
    // 판정은 `msvc.rs`에 있다 — 플랫폼까지 포함해서. 여기서 `cfg!(windows)`를 읽으면 그
    // 판정이 Linux에서 검증되지 않는다.
    if !crate::msvc::applies(program::Platform::current(), &cmd.program, &cmd.args) {
        return None;
    }
    Some(DEVELOPER_ENV.get_or_init(prepare_developer_env))
}

/// 바깥 세계를 실제로 들여다보는 쪽. **판정은 전부 `msvc.rs`에 있다** — 여기 있으면
/// Windows에서만 검증할 수 있고, 그러면 이 환경에서 아무것도 확인되지 않는다.
fn prepare_developer_env() -> crate::msvc::Preparation {
    use crate::msvc;

    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let is_file = |p: &Path| p.is_file();
    let vswhere = |exe: &Path, args: &[&str]| -> Vec<String> {
        // **환경을 물려주지 않는다**(23.7절과 같은 규율). 조회 도구에 자격증명을 넘길 이유가 없다.
        let out = Command::new(exe).args(args).env_clear().stdin(Stdio::null()).output();
        match out {
            Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        }
    };
    let search = |dir: &Path| -> Option<std::path::PathBuf> {
        // **목록이 아니라 검색이다.** 버전·에디션 디렉터리 이름을 우리가 알 수 없다(실측:
        // 드라이브도 `18`이라는 버전 디렉터리도 하드코딩 후보와 전부 달랐다).
        //
        // 깊이를 묶는다 — Program Files 전체를 훑으면 마지막 겹이 가장 비싼 겹이 된다.
        let root = dir.join("Microsoft Visual Studio");
        if !root.is_dir() {
            return None;
        }
        ignore::WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(false)
            .max_depth(Some(8))
            .build()
            .filter_map(Result::ok)
            .find(|e| e.file_name() == "vcvarsall.bat")
            .map(|e| e.path().to_path_buf())
    };
    let run = |_vcvarsall: &Path, args: &[String]| -> Option<String> {
        // **여기서 부르는 셸은 사용자의 명령이 아니다.** 인자는 전부 우리가 만들었고(원칙 6의
        // 약속은 사용자 명령에 대한 것이다), 배치 파일은 셸 없이 실행되지 않는다.
        //
        // 자격증명은 물려주지 않는다 — 그런데 `PATH`는 넘겨야 한다: vcvarsall이 만드는 PATH가
        // **우리 PATH 앞에 MSVC를 붙인 것**이어야 Git의 GNU `link.exe` 가림이 풀린다.
        let mut command = Command::new("cmd.exe");
        command
            .args(args)
            .stdin(Stdio::null())
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("GOOGLE_API_KEY");
        let out = command.output().ok()?;
        // 종료 코드를 판정으로 쓰지 않는다 — vcvarsall은 0으로 끝나고도 환경을 안 잡을 수
        // 있고, 그 판정은 `msvc.rs`가 `INCLUDE`의 존재로 한다.
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    };

    msvc::prepare(
        &msvc::Probe {
            env: &env,
            is_file: &is_file,
            vswhere: &vswhere,
            search: &search,
        },
        // x64 고정. 다른 아키텍처를 고르게 하려면 "무엇을 빌드하는가"를 알아야 하고,
        // 그건 명령 문자열에서 유도할 수 없다.
        "x64",
        &run,
    )
}

/// `run_process`가 실행을 내놓지 못한 두 가지 이유. **문자열 하나로 뭉치지 않는다** —
/// 뒤쪽은 화면과 모델에게 구조로 전달되어야 하는 사실이다.
enum SpawnRefusal {
    /// 실행하려 했으나 실패했다(프로그램 해석 실패, spawn 오류 등). 문자열이 전부다.
    Failed(String),
    /// **시작하지 않았다.** 환경이 이 명령의 결과를 해석 불가능하게 만든다 (`unc.rs`, 71절).
    /// `Box`인 이유는 이 변형만 크고, 성공 경로가 그 크기를 지불할 이유가 없기 때문이다.
    NotSpawned(Box<crate::unc::Barrier>),
}

impl From<String> for SpawnRefusal {
    fn from(message: String) -> Self {
        SpawnRefusal::Failed(message)
    }
}

/// **모든 프로세스 실행 앞의 공통 경계** (71.2절).
///
/// `run_command`·`git`·`git_push`·`revert` 네 경로가 전부 `run_process`를 지나므로 검사를
/// 여기 한 번만 둔다. `verify.rs`에만 두면 모델이 직접 요청한 `run_command`는 여전히 엉뚱한
/// 실패 출력을 받고, **없는 버그를 고치려 fix loop를 태운다.**
fn spawn_barrier(cmd: &RunCommandArgs, cwd: &Path) -> Option<crate::unc::Barrier> {
    // 판정은 전부 `unc.rs`에 있다 — 여기서 `cfg!(windows)`나 경로 모양을 읽으면 그 판정이
    // Linux에서 검증되지 않는다(`developer_env_for`와 같은 규율).
    let cwd = cwd.to_string_lossy().to_string();
    // **알려진 한계**: npm은 프로젝트 `.npmrc`를 패키지 루트에서 읽지만 우리는 `cwd`에서
    // 읽는다. `cwd`가 하위 디렉터리이고 루트에만 `script-shell` 재정의가 있으면 우리가
    // 장벽을 잘못 세운다. 부모를 거슬러 올라가면 워크스페이스 **밖** 파일을 읽게 되므로
    // 하지 않는다 — 그리고 틀렸을 때의 결말이 나쁘지 않다: 거부 사유가 화면에 그대로 뜨고,
    // 세 가지 해결책 중 하나가 정확히 그 재정의를 가리킨다.
    let npmrc_sources = || -> Vec<(String, String)> {
        let mut out = Vec::new();
        // 프로젝트가 먼저다 — npm의 우선순위와 같다.
        for (label, path) in [
            ("프로젝트 .npmrc".to_string(), Path::new(&cwd).join(".npmrc")),
            (
                "사용자 .npmrc".to_string(),
                match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
                    Ok(home) => Path::new(&home).join(".npmrc"),
                    Err(_) => return out,
                },
            ),
        ] {
            // **없는 파일은 목록에 넣지 않는다.** "없다"와 "빈 파일"을 뭉갤 이유가 없다.
            if let Ok(body) = std::fs::read_to_string(&path) {
                out.push((label, body));
            }
        }
        out
    };
    crate::unc::check(
        &crate::unc::Probe {
            platform: program::Platform::current(),
            cwd: &cwd,
            env: &|key| std::env::var(key).ok(),
            npmrc: &npmrc_sources,
        },
        &cmd.program,
    )
}

fn run_process(
    cmd: &RunCommandArgs,
    cwd: &Path,
    timeout: Duration,
    cancel: &CancellationToken,
    extra_env: &std::collections::BTreeMap<String, String>,
) -> Result<Execution, SpawnRefusal> {
    let start = Instant::now();

    // **해석보다 먼저 본다.** 이 판정은 머신이 아니라 워크스페이스에 대한 것이라 더 싸고,
    // 무엇보다 놓치면 결과가 "사용자 테스트 실패"로 둔갑하는 유일한 경로다.
    if let Some(barrier) = spawn_barrier(cmd, cwd) {
        return Err(SpawnRefusal::NotSpawned(Box::new(barrier)));
    }

    // 해석은 취소 검사보다 먼저 한다 — 해석 실패는 "실행하지 못했다"이지 "취소됐다"가 아니고,
    // 두 가지를 섞으면 취소 경로가 환경 결함을 감춘다.
    let resolved = resolve_for_execution(cmd)?;

    // 실행 직전 취소 검사 — spawn과 검사 사이의 창을 최소화한다.
    if cancel.is_cancelled() {
        return Ok(Execution {
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            termination: Termination::Cancelled {
                tree_guaranteed: true, // 아예 시작하지 않았으므로 남은 프로세스가 없다
                method: "not-started",
                surviving_pid: None,
            },
            duration_ms: 0,
            resolved,
        });
    }

    let mut command = Command::new(&resolved.executable);
    command
        .args(&resolved.effective_args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 자식이 부모 환경을 그대로 물려받으면 API 키가 임의 명령에 노출된다.
        // 알려진 공급자 키 변수를 명시적으로 제거한다 (작업 지침: secret을 로그/자식에 흘리지 않는다).
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("GOOGLE_API_KEY")
        .env_remove("TOMVERSE_OPENAI_API_KEY")
        .env_remove("TOMVERSE_ANTHROPIC_API_KEY")
        // 테스트 러너 제어 변수를 제거한다. **결정론적 검증의 전제 조건이다.**
        //
        // 실측으로 확인한 문제: `NODE_TEST_CONTEXT`가 설정된 셸에서 앱을 실행하면 `node --test`가
        // 자신을 테스트 러너의 자식으로 취급해 **실패해도 exit code 0을 반환한다.** 그러면
        // 검증 러너가 실패한 테스트를 통과로 보고하게 되고, 그건 이 제품의 존재 이유가 무너지는
        // 종류의 버그다. `NODE_OPTIONS`도 같은 이유로 제거한다(로더/힙 설정이 결과를 바꿀 수 있음).
        .env_remove("NODE_TEST_CONTEXT")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_V8_COVERAGE");
    // **제거 다음에 넣는다.** 순서가 반대면 위 제거 목록이 우리가 넣은 값을 지울 수 있고,
    // 그러면 "넘겼다고 기록했는데 도착하지 않은" 상태가 된다 — 감사 기록이 거짓이 되는 방향이다.
    for (key, value) in extra_env {
        command.env(key, value);
    }
    // 취소 시 손자 프로세스까지 죽이려면 spawn 전에 그룹을 설정해야 한다 (proctree.rs).
    proctree::configure_group(&mut command);
    let mut child = command.spawn().map_err(|e| {
        // 요청된 이름과 **실제로 실행하려 한 것**을 모두 보여준다. Windows에서 이 둘이
        // 다를 수 있고, 다를 때 요청 이름만 보면 원인에 도달할 수 없다.
        format!(
            "{}를 실행할 수 없음: {e} (실행 대상: {})",
            cmd.program,
            resolved.executable.display()
        )
    })?;

    // 자식을 종료 보조물에 편입시킨다 (Windows에서는 Job Object).
    //
    // **이 값의 수명이 곧 정리 시점이다** — 스코프를 벗어나면 job 핸들이 닫히고 커널이 안에
    // 남은 프로세스를 죽인다. 정상 종료·취소·타임아웃 어느 경로로 나가도 같다(proctree.rs).
    let guard = proctree::adopt(&child);

    // stdout/stderr를 별도 스레드로 읽는다. 파이프 버퍼가 차면 자식이 블록되므로
    // wait()만 하고 나중에 읽는 방식은 큰 출력에서 데드락이 된다.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (tx_out, rx_out) = mpsc::channel();
    let (tx_err, rx_err) = mpsc::channel();

    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx_out.send(buf);
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx_err.send(buf);
    });

    // 타임아웃과 취소를 **동시에** 감시한다. 폴링 간격이 곧 취소 응답 지연이므로 짧게 유지한다.
    let mut termination = Termination::Exited;
    // 수거를 포기한 자식은 **버리지 않고 넘긴다**(proctree::adopt_orphan). 버리면 나중에 죽을 때
    // 좀비로 남고, `is_alive`가 좀비를 살아 있다고 보고하므로 "남아 있을 수 있습니다"라는
    // 우리 보고가 영원히 틀린 채로 남는다.
    let mut unreaped = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if cancel.is_cancelled() {
                    let outcome = proctree::terminate_tree(&mut child, &guard);
                    unreaped = outcome.child_still_running;
                    termination = Termination::Cancelled {
                        tree_guaranteed: outcome.tree_guaranteed,
                        method: outcome.method,
                        surviving_pid: outcome.surviving_pid,
                    };
                    break None;
                }
                if start.elapsed() >= timeout {
                    // 타임아웃도 트리 종료를 쓴다 — npm이 타임아웃됐는데 node가 남는 것도 같은 문제다.
                    unreaped = proctree::terminate_tree(&mut child, &guard).child_still_running;
                    termination = Termination::TimedOut;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("자식 프로세스 상태를 확인할 수 없음: {e}").into()),
        }
    };

    if unreaped {
        // 상한 안에 사라지지 않은 자식. 소유권을 넘겨 나중에라도 거두게 한다 —
        // 죽이는 것이 아니라 **죽었을 때 뒷정리를 하는 것**이다(proctree.rs).
        proctree::adopt_orphan(child);
    }

    // 출력 수집으로 무기한 대기하지 않는다.
    //
    // 왜 상한이 필요한가: 손자 프로세스가 파이프를 물고 살아 있으면 `read_to_end`가 EOF를 보지
    // 못한다. Windows처럼 트리 종료를 보장하지 못하는 플랫폼에서 이게 실제로 발생하며,
    // 그러면 "취소했는데 UI가 멈춘다"가 된다. 부분 출력을 잃는 편이 낫다.
    let collect_timeout = if matches!(termination, Termination::Exited) {
        Duration::from_secs(10)
    } else {
        Duration::from_millis(500)
    };
    let stdout = rx_out.recv_timeout(collect_timeout).unwrap_or_default();
    let stderr = rx_err.recv_timeout(collect_timeout).unwrap_or_default();
    // 스레드가 아직 파이프에 매달려 있어도 join으로 기다리지 않는다 — 그게 무기한 대기의 원인이다.
    // 프로세스 종료 시 파이프가 닫히면 스레드는 스스로 끝난다.
    if matches!(termination, Termination::Exited) {
        let _ = out_handle.join();
        let _ = err_handle.join();
    } else {
        drop(out_handle);
        drop(err_handle);
    }

    Ok(Execution {
        exit_code: exit_status.and_then(|s| s.code()),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        termination,
        duration_ms: elapsed_ms(start),
        resolved,
    })
}

fn require_str_arg(request: &ToolRequest, key: &str) -> Result<String, String> {
    request
        .args
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{} 요청에 문자열 {key:?} 인자가 없음", request.tool.as_str()))
}

/// 파일 앞 8KB에 NUL 바이트가 있으면 바이너리로 본다 (context-engine.md 7절).
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|b| *b == 0)
}

/// 워크스페이스를 훑는 **단 하나의** walker 설정 — context-engine 20절.
///
/// `list_files`와 `search_text`는 같은 워크스페이스에 대해 같은 파일 집합을 봐야 한다.
/// 컨텍스트 엔진이 둘의 결과를 합치기 때문이다: 목록이 말하지 않은 파일에서 검색이 맞으면,
/// 스냅샷은 **인덱스에 없는 경로**를 근거로 답하게 된다.
///
/// **그런데 두 벌로 두었더니 갈렸다.** `list_files`만 `require_git(false)`를 불렀고
/// `search_text`는 부르지 않았다 — 그래서 `.git`이 없는 워크스페이스에서 목록은 `.gitignore`를
/// 지키는데 검색은 무시했다(실측: 같은 파일에 대해 `listed=false`, `matches=1`).
/// `ignore` 크레이트의 기본값이 `require_git(true)`이고, 그 기본값은 **저장소가 아니면 제외
/// 규칙을 조용히 끈다.** `list_files` 쪽 주석은 바로 그 위험을 적어 두고 있었는데도 그랬다.
///
/// 갈린 이유는 설정 축이 하나 더 있었기 때문이다. `list_files`에는 `includeIgnored`라는
/// 인자가 있어서 다섯 축이 그 값으로 조립됐고, `search_text`는 두 축만 손으로 세웠다.
/// **두 벌이 달라 보이는 이유를 그 인자가 설명해 버려서**, 빠진 축이 그 뒤에 숨었다.
/// 그 인자는 호출자가 하나도 없었다 — 브리지도 컨텍스트 엔진도 넘기지 않고, 모델에게 도구
/// 스키마로 노출되지도 않는다. 그래서 함께 지웠다. 없는 문을 열쇠로 지키느라 자물쇠가
/// 갈라진 셈이었다. 무시된 파일이 필요한 호출자가 생기면 **이 함수에** 축을 더한다 —
/// 그러면 두 도구가 동시에 받는다.
fn workspace_walker(base: &Path) -> ignore::WalkBuilder {
    let mut builder = ignore::WalkBuilder::new(base);
    builder
        // dot 파일도 대상이다 — 목록은 `.github` 같은 디렉터리를 보여줘야 하고, 검색은
        // `.env`를 **훑은 뒤 비밀값으로 걸러낸다**(16절). 걸러내는 자리는 여기가 아니다.
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // .git 디렉터리가 없어도 .gitignore를 적용한다. 기본값(require_git=true)이면
        // git 저장소가 아닌 워크스페이스에서 제외 규칙이 조용히 무시된다.
        .require_git(false)
        .parents(true);
    // .git 자체는 .gitignore에 없어도 항상 제외한다 (context-engine.md 7절 하드 제외 목록).
    builder.filter_entry(|entry| entry.file_name() != ".git");
    builder
}

fn to_forward_slashes(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn flatten_path(rel: &str) -> String {
    rel.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…(truncated)", &s[..end])
}

/// 앞 N줄 + 뒤 M줄, 가운데 생략 (state-machine-and-protocol.md 6절의 excerpt 규칙).
pub fn head_tail(text: &str, head: usize, tail: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= head + tail {
        return text.to_string();
    }
    let omitted = lines.len() - head - tail;
    let mut out: Vec<String> = lines[..head].iter().map(|s| s.to_string()).collect();
    out.push(format!("… ({omitted} lines omitted) …"));
    out.extend(lines[lines.len() - tail..].iter().map(|s| s.to_string()));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PolicyGate;
    use crate::types::TaskPolicy;

    struct Harness {
        _dir: tempfile::TempDir,
        _artifacts_dir: tempfile::TempDir,
        runtime: ToolRuntime,
        gate: PolicyGate,
        policy: TaskPolicy,
        root_path: std::path::PathBuf,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/app.ts"), "line one\nline two\nline three\n").unwrap();
        let artifacts_dir = tempfile::tempdir().unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        let root_path = dir.path().to_path_buf();
        let artifacts = ArtifactStore::new(artifacts_dir.path()).unwrap();

        // 테스트는 승인 흐름이 아니라 실행 동작을 보므로 쓰기 자동 승인을 켠다.
        //
        // `node -e`는 임의 코드 실행이므로 **기본 정책에는 없다**. 런타임 동작(타임아웃,
        // argv 보존, 환경변수 차단, 큰 출력 처리)을 검증하려면 실행 가능한 명령이 필요하므로,
        // 워크스페이스 정책 override로 명시적으로 허용한다 — 정책 override 경로 자체도 함께 검증된다.
        let mut command_policy = crate::policy::command::default_command_policy();
        command_policy.allow.insert(
            0,
            crate::types::CommandRule {
                program: "node".to_string(),
                arg_pattern: Some(vec!["**".to_string()]),
                cwd_must_be_workspace_root: Some(false),
                effect: crate::types::RuleEffect::Conditional,
            },
        );
        let policy = TaskPolicy {
            auto_approve_workspace_writes: true,
            command_policy: Some(command_policy),
            ..TaskPolicy::default()
        };
        Harness {
            _dir: dir,
            _artifacts_dir: artifacts_dir,
            runtime: ToolRuntime::new(root, artifacts, Duration::from_secs(10)),
            gate: PolicyGate::new(&policy),
            policy,
            root_path,
        }
    }

    fn req(tool: ToolName, args: serde_json::Value) -> ToolRequest {
        ToolRequest {
            request_id: format!("req-{}", uuid::Uuid::new_v4()),
            task_id: "task-1".to_string(),
            tool,
            args,
            risk_tier: None,
            requested_by: json!({ "role": "orchestrator" }),
            created_at: Some(now_iso()),
            injected_env: Default::default(),
        }
    }

    impl Harness {
        /// Policy Gate를 실제로 통과시켜 실행한다 — 테스트가 게이트를 우회하면
        /// "게이트를 반드시 지난다"는 불변식을 테스트가 검증하지 않게 된다.
        fn run(&self, request: &ToolRequest) -> ToolOutcome {
            let decision = self.gate.evaluate(request, self.runtime.root(), &self.policy);
            let approval = if decision.requires_user_approval {
                ApprovalState::Granted
            } else {
                ApprovalState::NotRequired
            };
            self.runtime
                .execute(request, &decision, approval, &CancellationToken::new())
        }

        fn run_unapproved(&self, request: &ToolRequest) -> ToolOutcome {
            let decision = self.gate.evaluate(request, self.runtime.root(), &self.policy);
            self.runtime
                .execute(request, &decision, ApprovalState::DeniedByUser, &CancellationToken::new())
        }

        fn read(&self, rel: &str) -> String {
            std::fs::read_to_string(self.root_path.join(rel)).unwrap()
        }
    }

    /// 취소 토큰을 명시적으로 넘겨 실행한다 (취소 경로 테스트 전용 헬퍼).
    impl Harness {
        fn run_with_cancel(&self, request: &ToolRequest, cancel: &CancellationToken) -> ToolOutcome {
            let decision = self.gate.evaluate(request, self.runtime.root(), &self.policy);
            let approved = decision.requires_user_approval;
            let approval = if approved { ApprovalState::Granted } else { ApprovalState::DeniedByUser };
            self.runtime.execute(request, &decision, approval, cancel)
        }
    }

    /// **주입한 환경변수가 실제로 자식 프로세스에 도착한다** (state-machine 33절).
    ///
    /// 기록만 남기고 도착하지 않으면 감사 기록이 거짓이 된다 — "넘겼다"고 적혀 있는데
    /// 훅은 못 받은 상태다.
    #[test]
    fn injected_env_reaches_the_child_process() {
        let h = harness();
        let mut request = req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "process.stdout.write(process.env.TOMVERSE_TASK_ID ?? '(none)')"],
                "cwd": ".",
            }),
        );
        request.injected_env = crate::hooks::hook_env("task-42", "COMPLETED");

        let out = h.run(&request);
        let stdout = out
            .result
            .output
            .as_ref()
            .and_then(|o| o.get("stdout"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(stdout, "task-42", "{stdout}");
    }

    /// 주입하지 않으면 그 변수는 **없다.** 있으면 부모 환경이 새는 것이고, 그때 훅은
    /// 바깥 실행의 태스크를 이번 태스크로 착각한다.
    #[test]
    fn a_command_without_injection_does_not_see_the_variable() {
        let h = harness();
        let request = req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "process.stdout.write(process.env.TOMVERSE_TASK_ID ?? '(none)')"],
                "cwd": ".",
            }),
        );
        let out = h.run(&request);
        let stdout = out
            .result
            .output
            .as_ref()
            .and_then(|o| o.get("stdout"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(stdout, "(none)", "{stdout}");
    }

    /// **Node는 이 필드를 채울 수 없다** (33절). 채울 수 있으면 장악당한 sidecar가 임의
    /// 명령에 임의 환경변수를 넣어, argv를 고정해 얻은 보장을 옆문으로 무효화한다.
    #[test]
    fn the_sidecar_cannot_set_injected_env_through_json() {
        let raw = json!({
            "requestId": "r1",
            "taskId": "t1",
            "tool": "run_command",
            "args": { "program": "node", "args": [], "cwd": "." },
            "injectedEnv": { "PATH": "/evil", "TOMVERSE_TASK_ID": "spoofed" },
        });
        let parsed: ToolRequest = serde_json::from_value(raw).unwrap();
        assert!(parsed.injected_env.is_empty(), "{:?}", parsed.injected_env);

        // **이 검사가 공허하지 않다는 것**: 같은 JSON의 다른 필드는 실제로 읽힌다.
        assert_eq!(parsed.task_id, "t1");
    }

    #[test]
    fn run_command_is_cancelled_mid_execution() {
        let h = harness();
        let cancel = CancellationToken::new();
        let token = cancel.clone();

        // 60초짜리 명령을 시작하고 300ms 뒤에 취소한다.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            token.cancel();
        });

        let started = Instant::now();
        let out = h.run_with_cancel(
            &req(
                ToolName::RunCommand,
                json!({ "program": "node", "args": ["-e", "setTimeout(() => {}, 60000)"], "cwd": "." }),
            ),
            &cancel,
        );
        let elapsed = started.elapsed();

        assert_eq!(out.result.status, ToolStatus::Cancelled);
        assert!(
            elapsed < Duration::from_secs(20),
            "취소가 실제로 프로세스를 끊지 못했습니다 ({elapsed:?})"
        );
        let output = out.result.output.unwrap();
        assert_eq!(output["cancelled"].as_bool().unwrap(), true);
        assert_eq!(output["timedOut"].as_bool().unwrap(), false);
    }

    #[test]
    fn cancellation_and_timeout_are_distinguished() {
        let h = harness();

        // 타임아웃
        let timed_out = h.run_with_cancel(
            &req(
                ToolName::RunCommand,
                json!({ "program": "node", "args": ["-e", "setTimeout(() => {}, 60000)"], "cwd": ".", "timeoutMs": 300 }),
            ),
            &CancellationToken::new(),
        );
        assert_eq!(timed_out.result.status, ToolStatus::Timeout);
        assert!(timed_out.result.error.unwrap().contains("타임아웃"));

        // 취소
        let cancel = CancellationToken::new();
        cancel.cancel();
        let cancelled = h.run_with_cancel(
            &req(
                ToolName::RunCommand,
                json!({ "program": "node", "args": ["-e", "setTimeout(() => {}, 60000)"], "cwd": "." }),
            ),
            &cancel,
        );
        assert_eq!(cancelled.result.status, ToolStatus::Cancelled);
        assert!(cancelled.result.error.unwrap().contains("취소"));
    }

    #[test]
    fn cancellation_kills_the_process_tree_not_just_the_direct_child() {
        // npm처럼 자식을 다시 spawn하는 명령을 흉내낸다.
        let h = harness();
        let pid_file = h.root_path.join("grandchild.pid");
        let script = format!(
            r#"
            const {{ spawn }} = require("node:child_process");
            const fs = require("node:fs");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{ stdio: "ignore" }});
            fs.writeFileSync({pid:?}, String(child.pid));
            setInterval(() => {{}}, 1000);
            "#,
            pid = pid_file.to_string_lossy()
        );

        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let watch_file = pid_file.clone();
        std::thread::spawn(move || {
            // 손자가 뜰 때까지 기다렸다가 취소한다.
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                if watch_file.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(100));
            token.cancel();
        });

        let out = h.run_with_cancel(
            &req(
                ToolName::RunCommand,
                json!({ "program": "node", "args": ["-e", script], "cwd": "." }),
            ),
            &cancel,
        );
        assert_eq!(out.result.status, ToolStatus::Cancelled);

        let grandchild: u32 = std::fs::read_to_string(&pid_file)
            .expect("손자 pid 파일이 없습니다")
            .trim()
            .parse()
            .unwrap();

        let output = out.result.output.unwrap();
        if output["treeKill"]["guaranteed"].as_bool().unwrap_or(false) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while crate::proctree::is_alive(grandchild) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !crate::proctree::is_alive(grandchild),
                "취소했는데 손자 프로세스가 살아 있습니다"
            );
        } else {
            // 보장하지 않는다고 선언한 플랫폼에서는 단정하지 않되, 그 사실이 결과에 드러나야 한다.
            assert!(out.result.error.unwrap().contains("보장하지 못함"));
        }
    }

    #[test]
    fn cancelled_command_does_not_hang_collecting_output() {
        // 손자가 파이프를 물고 있으면 read_to_end가 EOF를 못 본다. 그래도 반환은 빨라야 한다.
        let h = harness();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            token.cancel();
        });

        let started = Instant::now();
        let out = h.run_with_cancel(
            &req(
                ToolName::RunCommand,
                json!({
                    "program": "node",
                    "args": ["-e", "const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'inherit'}); setInterval(()=>{},1000);"],
                    "cwd": "."
                }),
            ),
            &cancel,
        );
        assert_eq!(out.result.status, ToolStatus::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "출력 수집에서 무기한 대기했습니다 ({:?})",
            started.elapsed()
        );
    }

    #[test]
    fn file_tools_do_not_mutate_after_cancellation() {
        let h = harness();
        let before = h.read("src/app.ts");
        let cancel = CancellationToken::new();
        cancel.cancel();

        let out = h.run_with_cancel(
            &req(
                ToolName::ApplyPatch,
                json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-line one\n+CHANGED\n" }),
            ),
            &cancel,
        );
        assert_eq!(out.result.status, ToolStatus::Cancelled);
        assert!(out.mutations.is_empty(), "취소됐는데 mutation이 기록되었습니다");
        assert_eq!(h.read("src/app.ts"), before, "취소됐는데 파일이 변경되었습니다");
    }

    #[test]
    fn delete_is_not_performed_after_cancellation() {
        let h = harness();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = h.run_with_cancel(&req(ToolName::DeleteFile, json!({ "path": "src/app.ts" })), &cancel);
        assert_eq!(out.result.status, ToolStatus::Cancelled);
        assert!(
            h.root_path.join("src/app.ts").exists(),
            "취소됐는데 파일이 삭제되었습니다"
        );
    }

    #[test]
    fn read_file_returns_content() {
        let h = harness();
        let out = h.run(&req(ToolName::ReadFile, json!({ "path": "src/app.ts" })));
        assert_eq!(out.result.status, ToolStatus::Ok);
        let content = out.result.output.unwrap()["content"].as_str().unwrap().to_string();
        assert!(content.starts_with("line one"));
    }

    #[test]
    fn read_file_outside_workspace_is_denied_by_gate() {
        let h = harness();
        let out = h.run(&req(ToolName::ReadFile, json!({ "path": "../../etc/passwd" })));
        assert_eq!(out.result.status, ToolStatus::Denied);
    }

    #[test]
    fn list_files_respects_gitignore() {
        let h = harness();
        std::fs::write(h.root_path.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(h.root_path.join("ignored")).unwrap();
        std::fs::write(h.root_path.join("ignored/secret.txt"), "x").unwrap();

        let out = h.run(&req(ToolName::ListFiles, json!({ "path": "." })));
        let entries = out.result.output.unwrap()["entries"].as_array().unwrap().clone();
        let paths: Vec<String> = entries
            .iter()
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect();
        assert!(paths.contains(&"src/app.ts".to_string()), "got {paths:?}");
        assert!(
            !paths.iter().any(|p| p.starts_with("ignored")),
            ".gitignore should exclude it, got {paths:?}"
        );
    }

    /// **검색도 `.gitignore`를 지킨다 — `.git` 디렉터리가 없어도**(context-engine 20절).
    ///
    /// 여기가 실제로 갈려 있던 자리다. `list_files`만 `require_git(false)`를 불렀고 검색은
    /// 부르지 않아서, `ignore` 크레이트의 기본값(`require_git=true`)이 **저장소가 아닌
    /// 워크스페이스에서 제외 규칙을 조용히 껐다.** 하네스에 `.git`이 없다는 것이 이 결함을
    /// 계속 살려둔 조건이었고, 동시에 드러낼 수 있는 조건이기도 하다.
    ///
    /// 대조가 없으면 이 테스트는 "검색이 고장 나서 0건"으로도 통과한다 — 그래서 무시되지
    /// 않는 파일에 **같은 토큰**을 둔다.
    #[test]
    fn search_applies_gitignore_even_without_a_git_directory() {
        const TOKEN: &str = "tomverse-gitignore-divergence-token";
        let h = harness();
        assert!(
            !h.root_path.join(".git").exists(),
            "이 테스트는 .git이 없는 상태를 봅니다"
        );
        std::fs::write(h.root_path.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(h.root_path.join("ignored")).unwrap();
        std::fs::write(h.root_path.join("ignored/gen.ts"), format!("// {TOKEN}\n")).unwrap();
        std::fs::write(h.root_path.join("src/keep.ts"), format!("// {TOKEN}\n")).unwrap();

        let out = h.run(&req(ToolName::SearchText, json!({ "pattern": TOKEN, "path": "." })));
        assert_eq!(out.result.status, ToolStatus::Ok);
        let matched: Vec<String> = out.result.output.unwrap()["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap().to_string())
            .collect();

        assert!(
            matched.iter().any(|p| p.ends_with("keep.ts")),
            "대조가 안 잡혔습니다 — 0건이 '제외했다'의 증거가 되지 못합니다: {matched:?}"
        );
        assert!(
            !matched.iter().any(|p| p.starts_with("ignored")),
            "무시된 파일이 검색에 걸렸습니다: {matched:?}"
        );
    }

    /// **검색이 볼 수 있는 파일은 목록이 말한 파일의 부분집합이다**(context-engine 20절).
    ///
    /// 두 도구의 결과는 컨텍스트 엔진에서 합쳐진다. 목록에 없는 경로에서 검색이 맞으면
    /// 스냅샷은 **인덱스에 없는 파일**을 근거로 답하게 되고, 그건 "못 찾았다"보다 나쁘다.
    ///
    /// 판정 기준을 손으로 적지 않는다 — 두 도구를 **같은 워크스페이스에 실제로 돌려** 나온
    /// 두 집합을 비교한다. 그래서 나중에 축이 하나 더 갈려도 이 비교가 잡는다.
    ///
    /// 검사가 공허해지는 두 가지 길을 막는다: 두 집합이 비어 있으면 부분집합은 언제나 참이고,
    /// **아무것도 제외되지 않아도** 언제나 참이다. 그래서 비어 있지 않음과 "실제로 무언가
    /// 빠졌음"을 함께 단언한다.
    #[test]
    fn search_never_sees_a_file_the_listing_did_not_report() {
        const TOKEN: &str = "tomverse-walker-parity-token";
        for with_git in [false, true] {
            let h = harness();
            std::fs::write(h.root_path.join(".gitignore"), "ignored/\n").unwrap();
            std::fs::create_dir_all(h.root_path.join("ignored")).unwrap();
            std::fs::write(h.root_path.join("ignored/gen.ts"), format!("// {TOKEN}\n")).unwrap();
            std::fs::write(h.root_path.join("keep.ts"), format!("// {TOKEN}\n")).unwrap();
            // dot 파일도 양쪽이 같게 봐야 한다 — `hidden(false)`가 두 도구에 함께 걸리는지.
            std::fs::create_dir_all(h.root_path.join(".github")).unwrap();
            std::fs::write(h.root_path.join(".github/ci.yml"), format!("# {TOKEN}\n")).unwrap();
            if with_git {
                // `.git/info/exclude`는 `.gitignore`와 **다른 축**이다(`git_exclude`).
                std::fs::create_dir_all(h.root_path.join(".git/info")).unwrap();
                std::fs::write(h.root_path.join(".git/info/exclude"), "excluded.ts\n").unwrap();
                std::fs::write(h.root_path.join("excluded.ts"), format!("// {TOKEN}\n")).unwrap();
            }

            let out = h.run(&req(ToolName::ListFiles, json!({ "path": "." })));
            let listed: std::collections::BTreeSet<String> = out.result.output.unwrap()["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| !e["isDir"].as_bool().unwrap_or(false))
                .map(|e| e["path"].as_str().unwrap().to_string())
                .collect();

            let out = h.run(&req(ToolName::SearchText, json!({ "pattern": TOKEN, "path": "." })));
            let searched: std::collections::BTreeSet<String> = out.result.output.unwrap()["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["path"].as_str().unwrap().to_string())
                .collect();

            assert!(!listed.is_empty(), "with_git={with_git}: 목록이 비었습니다");
            assert!(!searched.is_empty(), "with_git={with_git}: 검색이 비었습니다");
            // **제외가 실제로 일어났음**을 확인한다 — 아무것도 안 빠지면 부분집합은 공허하다.
            assert!(
                !listed.iter().any(|p| p.starts_with("ignored")),
                "with_git={with_git}: 무시 규칙이 적용되지 않아 비교가 공허합니다: {listed:?}"
            );
            if with_git {
                assert!(
                    !listed.contains("excluded.ts"),
                    "with_git={with_git}: .git/info/exclude가 적용되지 않았습니다: {listed:?}"
                );
            }
            // dot 파일은 양쪽 다 **본다** — 제외 확인이 "전부 막혔다"가 아님을 보인다.
            assert!(
                listed.iter().any(|p| p.starts_with(".github")),
                "with_git={with_git}: dot 디렉터리가 목록에서 빠졌습니다: {listed:?}"
            );

            let only_in_search: Vec<&String> = searched.difference(&listed).collect();
            assert!(
                only_in_search.is_empty(),
                "with_git={with_git}: 목록이 말하지 않은 파일에서 검색이 맞았습니다: {only_in_search:?}"
            );
        }
    }

    /// `search_text`는 자동 승인 도구이므로, 비밀값 파일을 훑으면 승인 절차 없이 키가 유출된다.
    /// 경로 기반 이벤트 redaction으로는 막을 수 없는 경로다 — 여기서 막아야 한다.
    #[test]
    fn search_text_skips_secret_files_so_keys_cannot_be_harvested() {
        const SECRET: &str = "sk-harvested-through-search";
        let h = harness();
        std::fs::write(h.root_path.join(".env"), format!("OPENAI_API_KEY={SECRET}\n")).unwrap();
        // 일반 파일에도 같은 접두사를 둬서 "패턴이 안 맞아서 못 찾은 것"이 아님을 분명히 한다.
        std::fs::write(h.root_path.join("src/note.ts"), "// sk-this-one-is-fine\n").unwrap();

        let out = h.run(&req(ToolName::SearchText, json!({ "pattern": "sk-" })));
        let output = out.result.output.unwrap();
        let serialized = output.to_string();

        assert!(
            !serialized.contains(SECRET),
            "검색 결과로 비밀값이 유출되었습니다: {serialized}"
        );
        assert_eq!(
            output["skippedSecretFiles"].as_u64().unwrap(),
            1,
            "건너뛴 사실이 보고되지 않았습니다"
        );
        // 일반 파일은 그대로 찾아야 한다 — 과하게 막아 검색이 무용해지면 안 된다.
        let paths: Vec<&str> = output["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["src/note.ts"]);
    }

    #[test]
    fn search_text_finds_matches() {
        let h = harness();
        let out = h.run(&req(ToolName::SearchText, json!({ "pattern": "line two" })));
        let matches = out.result.output.unwrap()["matches"].as_array().unwrap().clone();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"].as_str().unwrap(), "src/app.ts");
        assert_eq!(matches[0]["line"].as_u64().unwrap(), 2);
    }

    /// **판정이 도구까지 닿는가** — state-machine 65절.
    ///
    /// `file_errors.rs`의 단위 테스트는 판정 자체를 값으로 본다. 그런데 그 판정을 **도구가
    /// 부르는지**는 거기서 알 수 없고, 실제로 그 배선을 지워도 아무 검사도 실패하지 않았다
    /// (프로브로 확인). 그래서 여기서 실제 실패를 하나 만들어 끝에서 끝까지 본다.
    ///
    /// **이름 길이를 쓰는 이유**: 권한 실패는 root로 도는 환경에서 재현되지 않고(권한 비트를
    /// 무시한다), 잠금은 이 플랫폼에 없다. `ENAMETOOLONG`은 둘 다 아니다.
    #[test]
    fn a_write_failure_carries_a_diagnosis_to_the_tool_result() {
        let h = harness();
        // 파일 이름 한 칸의 상한은 255바이트다. 경로 전체가 아니라 **한 칸**을 넘긴다 —
        // 전체 길이 상한은 플랫폼마다 다르고 여기서는 재현이 불안정하다.
        let long_name = "z".repeat(300);
        let out = h.run(&req(
            ToolName::CreateFile,
            json!({ "path": format!("src/{long_name}.ts"), "content": "x" }),
        ));

        assert_eq!(out.result.status, ToolStatus::Error, "{:?}", out.result);
        let failure = out.result.file_failure.as_ref().expect("판정이 붙지 않았습니다");
        assert_eq!(failure.kind, crate::file_errors::FileFailureKind::PathTooLong, "{failure:?}");
        assert!(!failure.retryable, "{failure:?}");
        // **OS 문장을 지우지 않았다.** 우리가 모르는 실패를 나중에 디버깅할 근거다.
        let message = out.result.error.clone().unwrap_or_default();
        assert!(message.contains("길이를 넘어"), "{message}");
        assert!(message.contains("os error"), "OS 문장이 사라졌습니다: {message}");
    }

    /// 그리고 **성공한 쓰기에는 판정이 붙지 않는다** — 붙으면 위 검사가 언제나 통과한다.
    #[test]
    fn a_successful_write_carries_no_diagnosis() {
        let h = harness();
        let out = h.run(&req(
            ToolName::CreateFile,
            json!({ "path": "src/fine.ts", "content": "x" }),
        ));
        assert_eq!(out.result.status, ToolStatus::Ok, "{:?}", out.result);
        assert!(out.result.file_failure.is_none(), "{:?}", out.result.file_failure);
    }

    #[test]
    fn create_file_records_mutation_with_pre_and_post_images() {
        let h = harness();
        let out = h.run(&req(
            ToolName::CreateFile,
            json!({ "path": "src/new.ts", "content": "export const x = 1;\n" }),
        ));
        assert_eq!(out.result.status, ToolStatus::Ok);
        let m = out.mutations.into_iter().next().expect("expected a FileMutationRecord");
        assert_eq!(m.path, "src/new.ts");
        assert!(!m.pre_image.existed, "new file should have no pre-image");
        assert!(m.post_image.existed);
        assert_eq!(h.read("src/new.ts"), "export const x = 1;\n");
    }

    #[test]
    fn overwriting_records_previous_content_as_pre_image() {
        let h = harness();
        let out = h.run(&req(
            ToolName::CreateFile,
            json!({ "path": "src/app.ts", "content": "replaced\n" }),
        ));
        let m = out.mutations.into_iter().next().expect("mutation이 없습니다");
        assert!(m.pre_image.existed);
        let pre = h
            .runtime
            .artifacts
            .read_text(m.pre_image.content_ref.as_deref().unwrap())
            .unwrap();
        assert_eq!(pre, "line one\nline two\nline three\n");
    }

    #[test]
    fn apply_patch_applies_valid_diff() {
        let h = harness();
        let patch = "@@ -1,2 +1,2 @@\n line one\n-line two\n+LINE TWO\n";
        let out = h.run(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": patch }),
        ));
        assert_eq!(out.result.status, ToolStatus::Ok, "error: {:?}", out.result.error);
        assert_eq!(h.read("src/app.ts"), "line one\nLINE TWO\nline three\n");
        assert!(out.diff.unwrap().contains("+LINE TWO"));
    }

    #[test]
    fn apply_patch_leaves_file_untouched_on_mismatch() {
        let h = harness();
        let before = h.read("src/app.ts");
        let patch = "@@ -1,2 +1,2 @@\n line one\n-WRONG CONTEXT\n+LINE TWO\n";
        let out = h.run(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": patch }),
        ));
        assert_eq!(out.result.status, ToolStatus::Error);
        assert!(out.mutations.is_empty(), "failed patch must not record a mutation");
        assert_eq!(h.read("src/app.ts"), before, "file must be unchanged");
    }

    // ---- 파일 이동 (44절) ----

    /// **한 요청이 두 파일을 바꾼다.** 하나만 기록하면 되돌리기가 절반만 알게 되고,
    /// 그러면 이동은 되돌려지지 않는다.
    #[test]
    fn moving_a_file_records_both_sides() {
        let h = harness();
        let before = std::fs::read_to_string(h.root_path.join("src/app.ts")).unwrap();

        let out = h.run(&req(
            ToolName::MoveFile,
            json!({ "from": "src/app.ts", "to": "src/renamed.ts" }),
        ));
        assert_eq!(out.result.status, ToolStatus::Ok);
        assert!(!h.root_path.join("src/app.ts").exists(), "원본이 남아 있습니다");
        assert_eq!(std::fs::read_to_string(h.root_path.join("src/renamed.ts")).unwrap(), before);

        assert_eq!(out.mutations.len(), 2, "{:?}", out.mutations);
        // ① 원본이 사라졌다 — 되돌리기가 내용을 복원할 근거(pre-image)가 있어야 한다.
        let gone = &out.mutations[0];
        assert_eq!(gone.path, "src/app.ts");
        assert!(gone.pre_image.existed && gone.pre_image.content_ref.is_some());
        assert!(!gone.post_image.existed);
        // ② 대상이 생겼다 — 되돌리기가 지울 근거가 있어야 한다.
        let created = &out.mutations[1];
        assert_eq!(created.path, "src/renamed.ts");
        assert!(!created.pre_image.existed);
        assert!(created.post_image.existed);
    }

    /// **덮어쓰지 않는다.** 덮어쓰기는 삭제를 이동 안에 숨기는 것이고, 승인 화면이
    /// "옮깁니다"라고 말한 것과 실제로 일어나는 일이 달라진다.
    #[test]
    fn moving_onto_an_existing_file_is_refused_and_changes_nothing() {
        let h = harness();
        std::fs::write(h.root_path.join("src/other.ts"), "keep me\n").unwrap();

        let out = h.run(&req(
            ToolName::MoveFile,
            json!({ "from": "src/app.ts", "to": "src/other.ts" }),
        ));
        assert_ne!(out.result.status, ToolStatus::Ok);
        // 양쪽 다 그대로다 — 거부가 절반만 일어나지 않았다.
        assert!(h.root_path.join("src/app.ts").exists());
        assert_eq!(std::fs::read_to_string(h.root_path.join("src/other.ts")).unwrap(), "keep me\n");
        assert!(out.mutations.is_empty());
    }

    /// 워크스페이스 밖으로 옮기는 것은 **파일을 밖으로 내보내는 것**이다. 게이트가 막지만,
    /// 런타임도 스스로 막는다 — 두 겹인 이유는 게이트를 우회하는 호출 경로가 생겨도
    /// 파일이 나가지 않게 하기 위해서다.
    #[test]
    fn moving_outside_the_workspace_is_refused() {
        let h = harness();
        let out = h.run(&req(
            ToolName::MoveFile,
            json!({ "from": "src/app.ts", "to": "../escaped.ts" }),
        ));
        assert_ne!(out.result.status, ToolStatus::Ok);
        assert!(h.root_path.join("src/app.ts").exists());
    }

    /// **시작하지 않은 명령의 결과 모양** — UNC 워크스페이스 결함(71.2절).
    ///
    /// 장벽 자체는 Windows에서만 성립하므로 여기서는 `unc::check`로 판정을 만들어
    /// **결과 직렬화**를 검증한다. 확인하는 것은 "무엇이 기록되는가"이고, 그건 플랫폼과
    /// 무관하게 틀릴 수 있는 부분이다 — 없는 exit code를 0으로 채우는 종류의 실수.
    #[test]
    fn a_command_that_was_not_spawned_records_that_it_was_not_spawned() {
        let h = harness();
        let barrier = crate::unc::check(
            &crate::unc::Probe {
                platform: program::Platform::Windows,
                cwd: r"\\localhost\Users\me\repo",
                env: &|_| None,
                npmrc: &Vec::new,
            },
            "npm",
        )
        .expect("Windows + UNC + npm이면 장벽이 있어야 합니다");

        let cmd = RunCommandArgs {
            program: "npm".to_string(),
            args: vec!["test".to_string()],
            cwd: ".".to_string(),
            timeout_ms: None,
        };
        let request = req(ToolName::RunTests, json!({ "program": "npm", "args": ["test"], "cwd": "." }));
        let out = h
            .runtime
            .spawn_refused(&request, &cmd, SpawnRefusal::NotSpawned(Box::new(barrier)))
            .expect("NotSpawned는 Err가 아니라 구조화된 결과여야 합니다");

        // 정책 거부가 아니다 — 레버를 켜도 지나가지 않는다.
        assert_eq!(out.result.status, ToolStatus::Error);
        assert_eq!(out.result.denial_kind, None);

        let output = out.result.output.as_ref().unwrap();
        assert_eq!(output["spawned"], json!(false));
        assert_eq!(output["reason"], json!(crate::unc::REASON));
        // **없는 것을 채우지 않는다.** 프로세스가 없었으므로 exit code도 소요 시간도 없다.
        assert!(output["exitCode"].is_null());
        assert_eq!(output["durationMs"], json!(0));
        assert_eq!(out.result.duration_ms, 0);
        // 무엇을 보고 그렇게 판정했는지, 그리고 사용자가 할 수 있는 일이 함께 남는다.
        assert!(output["checked"].as_array().is_some_and(|a| a.len() >= 3));
        assert!(output["remediation"].as_array().is_some_and(|a| !a.is_empty()));
        // 화면으로 흘러가는 문장이 "실패"라고 말하지 않는다.
        let message = out.result.error.clone().unwrap();
        assert!(message.contains("검증 실패가 아니라"), "{message}");
        assert!(message.contains("net use"), "{message}");
        // 아무것도 바꾸지 않았다.
        assert!(out.mutations.is_empty());
    }

    #[test]
    fn moving_a_directory_is_refused() {
        let h = harness();
        let out = h.run(&req(ToolName::MoveFile, json!({ "from": "src", "to": "src2" })));
        assert_ne!(out.result.status, ToolStatus::Ok);
        assert!(h.root_path.join("src").is_dir());
    }

    /// 취소된 뒤에는 **옮기지 않는다** — 다른 변경 도구와 같은 규칙이다.
    #[test]
    fn a_cancelled_move_does_not_touch_anything() {
        let h = harness();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = h.run_with_cancel(
            &req(ToolName::MoveFile, json!({ "from": "src/app.ts", "to": "src/renamed.ts" })),
            &cancel,
        );
        assert_eq!(out.result.status, ToolStatus::Cancelled);
        assert!(h.root_path.join("src/app.ts").exists());
        assert!(!h.root_path.join("src/renamed.ts").exists());
        assert!(out.mutations.is_empty());
    }

    #[test]
    fn delete_file_records_pre_image_for_rollback() {
        let h = harness();
        let out = h.run(&req(ToolName::DeleteFile, json!({ "path": "src/app.ts" })));
        assert_eq!(out.result.status, ToolStatus::Ok);
        assert!(!h.root_path.join("src/app.ts").exists());
        let m = out.mutations.into_iter().next().expect("mutation이 없습니다");
        assert!(m.pre_image.existed);
        assert!(!m.post_image.existed);
    }

    #[test]
    fn delete_without_approval_does_not_touch_the_file() {
        let h = harness();
        let out = h.run_unapproved(&req(ToolName::DeleteFile, json!({ "path": "src/app.ts" })));
        assert_eq!(out.result.status, ToolStatus::Denied);
        assert!(h.root_path.join("src/app.ts").exists(), "file must still exist");
    }

    #[test]
    fn delete_refuses_directories() {
        let h = harness();
        let out = h.run(&req(ToolName::DeleteFile, json!({ "path": "src" })));
        assert_eq!(out.result.status, ToolStatus::Error);
        assert!(h.root_path.join("src").is_dir());
    }

    #[test]
    fn run_command_preserves_argv_and_reports_exit_code() {
        let h = harness();
        // node는 테스트 환경에 반드시 있다 (sidecar가 Node로 돌아간다).
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["--test", "--help"],
                "cwd": "."
            }),
        ));
        let output = out.result.output.unwrap();
        // 실행된 argv가 그대로 보고되어야 한다 — 승인 화면과 실제 실행의 일치를 검증한다.
        assert_eq!(output["command"]["program"].as_str().unwrap(), "node");
        assert_eq!(
            output["command"]["args"].as_array().unwrap(),
            &vec![json!("--test"), json!("--help")]
        );
    }

    #[test]
    fn run_command_does_not_interpret_shell_metacharacters() {
        let h = harness();
        let sentinel = h.root_path.join("pwned.txt");
        // 셸을 경유한다면 `;`가 명령 구분자로 해석되어 뒤쪽 명령이 실행된다.
        // argv로 전달되므로 이 전체가 node에 넘어가는 하나의 인자 문자열일 뿐이어야 한다.
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "process.stdout.write('ok'); /* ; touch pwned.txt */", "; touch pwned.txt"],
                "cwd": "."
            }),
        ));
        assert_eq!(out.result.status, ToolStatus::Ok, "error: {:?}", out.result.error);
        let output = out.result.output.unwrap();
        assert_eq!(output["stdout"].as_str().unwrap(), "ok");
        assert!(!sentinel.exists(), "shell metacharacters must not be interpreted");
        // 세 번째 인자가 그대로 전달됐음을 확인 — 어디서도 재파싱되지 않았다.
        assert_eq!(
            output["command"]["args"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                .as_str()
                .unwrap(),
            "; touch pwned.txt"
        );
    }

    #[test]
    fn run_command_times_out() {
        let h = harness();
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "setTimeout(() => {}, 60000)"],
                "cwd": ".",
                "timeoutMs": 400
            }),
        ));
        assert_eq!(out.result.status, ToolStatus::Timeout);
        let output = out.result.output.unwrap();
        assert_eq!(output["timedOut"].as_bool().unwrap(), true);
    }

    #[test]
    fn run_command_strips_provider_api_keys_from_child_env() {
        let h = harness();
        std::env::set_var("OPENAI_API_KEY", "sk-should-not-leak");
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY))"],
                "cwd": "."
            }),
        ));
        std::env::remove_var("OPENAI_API_KEY");
        let stdout = out.result.output.unwrap()["stdout"].as_str().unwrap().to_string();
        assert_eq!(stdout.trim(), "undefined", "API key leaked into child process env");
    }

    // ---- 프로그램 해석 계층 (program.rs)의 런타임 쪽 확인 ----

    /// 회귀 10 — 요청 argv와 실제 실행 argv를 결과에서 구별할 수 있어야 한다.
    ///
    /// Windows에서 `npm test`는 `node.exe npm-cli.js test`로 실행된다. 둘을 나란히 남기지
    /// 않으면 "승인 화면에서 본 것과 실제로 돈 것"의 대응을 사후에 확인할 방법이 없다.
    #[test]
    fn result_distinguishes_the_requested_command_from_what_was_actually_executed() {
        let h = harness();
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({ "program": "node", "args": ["-e", "process.stdout.write('ok')"], "cwd": "." }),
        ));
        let output = out.result.output.unwrap();

        // 요청은 그대로 보존된다 — Policy Gate가 판정한 바로 그 값이다.
        assert_eq!(output["command"]["program"].as_str().unwrap(), "node");
        assert_eq!(
            output["command"]["args"].as_array().unwrap(),
            &vec![json!("-e"), json!("process.stdout.write('ok')")]
        );

        // 실행된 것이 별도 필드로 남는다.
        let resolved = &output["resolvedCommand"];
        assert!(!resolved.is_null(), "해석 결과가 기록되지 않았습니다");
        let executable = resolved["executable"].as_str().unwrap();
        assert_eq!(crate::policy::command::program_basename(executable), "node");
        let kind = resolved["kind"].as_str().unwrap();
        assert!(
            ["passthrough", "direct", "node-cli-shim"].contains(&kind),
            "알 수 없는 해석 종류: {kind}"
        );
        // 요청 인자는 해석 후에도 끝에 그대로 남아야 한다 (앞에 CLI 스크립트가 붙을 수는 있다).
        let effective: Vec<String> = resolved["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(
            effective.ends_with(&["-e".to_string(), "process.stdout.write('ok')".to_string()]),
            "요청 인자가 변형되었습니다: {effective:?}"
        );
    }

    /// 회귀 11 — 자격증명·테스트 러너 제어 변수 제거가 **실제로 spawn되는 프로세스**에 적용된다.
    ///
    /// `NODE_TEST_CONTEXT`가 남으면 `node --test`가 실패해도 exit 0을 반환한다. 해석 계층이
    /// 프로그램을 바꿔도 이 제거가 함께 따라가야 한다 — 안 그러면 검증 러너가 실패를 통과로
    /// 보고하고, 그건 이 제품의 존재 이유가 무너지는 종류의 버그다.
    #[test]
    fn credential_and_test_runner_variables_are_removed_from_the_process_that_actually_runs() {
        let h = harness();
        std::env::set_var("OPENAI_API_KEY", "sk-should-not-leak-to-resolved-process");
        std::env::set_var("NODE_TEST_CONTEXT", "child");
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                // `join`은 undefined를 빈 문자열로 만든다 — String()으로 감싸야 "없음"이 드러난다.
                "args": ["-e", "process.stdout.write([process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.NODE_TEST_CONTEXT, process.env.NODE_OPTIONS].map(String).join('|'))"],
                "cwd": "."
            }),
        ));
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("NODE_TEST_CONTEXT");

        let output = out.result.output.unwrap();
        let stdout = output["stdout"].as_str().unwrap().to_string();
        assert_eq!(
            stdout.trim(),
            "undefined|undefined|undefined|undefined",
            "해석된 프로세스에 제거 대상 변수가 남았습니다: {stdout}"
        );
        // 그 프로세스가 정말 해석을 거친 것이었음을 함께 확인한다.
        assert!(!output["resolvedCommand"].is_null());
    }

    /// 회귀 12 — 취소와 타임아웃이 **해석된** 프로세스에도 그대로 작동하고,
    /// 해석 정보가 종료 경로와 무관하게 결과에 남는다.
    #[test]
    fn cancellation_and_timeout_apply_to_the_resolved_process() {
        let h = harness();

        // 타임아웃
        let timed_out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "setTimeout(() => {}, 60000)"],
                "cwd": ".",
                "timeoutMs": 300
            }),
        ));
        assert_eq!(timed_out.result.status, ToolStatus::Timeout);
        assert!(
            !timed_out.result.output.unwrap()["resolvedCommand"].is_null(),
            "타임아웃 결과에 해석 정보가 없습니다"
        );

        // 실행 중 취소
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            token.cancel();
        });
        let started = Instant::now();
        let cancelled = h.run_with_cancel(
            &req(
                ToolName::RunCommand,
                json!({ "program": "node", "args": ["-e", "setTimeout(() => {}, 60000)"], "cwd": "." }),
            ),
            &cancel,
        );
        assert_eq!(cancelled.result.status, ToolStatus::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "해석된 프로세스에서 취소가 동작하지 않았습니다 ({:?})",
            started.elapsed()
        );
        let output = cancelled.result.output.unwrap();
        assert!(!output["resolvedCommand"].is_null(), "취소 결과에 해석 정보가 없습니다");
        assert_eq!(output["cancelled"].as_bool().unwrap(), true);
    }

    /// 해석 실패는 "통과"도 "설정 없음"도 아니다 — 오류로 드러나야 한다.
    #[test]
    fn a_program_that_cannot_be_resolved_fails_loudly() {
        let h = harness();
        // 정책은 통과하지만(basename이 node라 harness의 allow 규칙에 맞는다) 그 위치에는
        // 실행 파일이 없다. Linux에서는 spawn이, Windows에서는 해석이 먼저 실패한다.
        let missing = if cfg!(windows) {
            r"C:\tomverse-nonexistent\node.exe"
        } else {
            "/tomverse-nonexistent/node"
        };
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({ "program": missing, "args": ["-e", "0"], "cwd": "." }),
        ));
        assert_eq!(
            out.result.status,
            ToolStatus::Error,
            "실행하지 못한 명령이 오류로 드러나지 않았습니다: {:?}",
            out.result.output
        );
        let error = out.result.error.unwrap();
        assert!(error.contains("실행할 수 없"), "무엇이 실패했는지 없습니다: {error}");
    }

    #[test]
    fn unclassifiable_command_never_runs() {
        let h = harness();
        let sentinel = h.root_path.join("src/app.ts");
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({ "program": "rm", "args": ["-f", "src/app.ts"], "cwd": "." }),
        ));
        assert_eq!(out.result.status, ToolStatus::Denied);
        assert!(sentinel.exists(), "denied command must not have run");
    }

    #[test]
    fn large_output_goes_to_artifact_with_preview() {
        let h = harness();
        let out = h.run(&req(
            ToolName::RunCommand,
            json!({
                "program": "node",
                "args": ["-e", "for (let i = 0; i < 4000; i++) console.log('x'.repeat(40))"],
                "cwd": "."
            }),
        ));
        let output = out.result.output.unwrap();
        assert_eq!(output["outputTruncated"].as_bool().unwrap(), true);
        let artifact_ref = out.output_ref.expect("expected an artifact ref");
        let full = h.runtime.artifacts.read_text(&artifact_ref).unwrap();
        assert!(full.len() > MAX_INLINE_OUTPUT_BYTES);
        // preview는 앞/뒤만 담고 중간 생략을 표시해야 한다.
        assert!(output["stdout"].as_str().unwrap().contains("lines omitted"));
    }

    #[test]
    fn rollback_requests_restore_pre_images() {
        let h = harness();
        let original = h.read("src/app.ts");

        let patch_out = h.run(&req(
            ToolName::ApplyPatch,
            json!({ "path": "src/app.ts", "patch": "@@ -1,1 +1,1 @@\n-line one\n+CHANGED\n" }),
        ));
        let created_out = h.run(&req(
            ToolName::CreateFile,
            json!({ "path": "src/brand-new.ts", "content": "new\n" }),
        ));
        let mutations = vec![
            patch_out.mutations.into_iter().next().unwrap(),
            created_out.mutations.into_iter().next().unwrap(),
        ];

        // 롤백도 일반 ToolRequest 경로를 탄다.
        for request in h.runtime.rollback_requests("task-1", &mutations) {
            let out = h.run(&request);
            assert_eq!(
                out.result.status,
                ToolStatus::Ok,
                "rollback failed: {:?}",
                out.result.error
            );
        }

        assert_eq!(h.read("src/app.ts"), original);
        assert!(!h.root_path.join("src/brand-new.ts").exists());
    }

    #[test]
    fn git_status_runs_in_a_repo() {
        let h = harness();
        let init = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&h.root_path)
            .status();
        if init.map(|s| !s.success()).unwrap_or(true) {
            // git이 없는 환경이면 이 테스트는 의미가 없다. 조용히 통과시키지 않고 명시적으로 알린다.
            eprintln!("skipping git_status test: `git init` unavailable in this environment");
            return;
        }
        let out = h.run(&req(ToolName::GitStatus, json!({})));
        assert_eq!(out.result.status, ToolStatus::Ok);
        let stdout = out.result.output.unwrap()["stdout"].as_str().unwrap().to_string();
        assert!(
            stdout.contains("##"),
            "expected porcelain branch header, got {stdout:?}"
        );
    }

    #[test]
    fn head_tail_marks_omission() {
        let text = (1..=200).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let excerpt = head_tail(&text, 2, 2);
        assert!(excerpt.starts_with("1\n2\n"));
        assert!(excerpt.ends_with("199\n200"));
        assert!(excerpt.contains("196 lines omitted"));
    }

    #[test]
    fn binary_detection() {
        assert!(is_binary(b"abc\0def"));
        assert!(!is_binary(b"plain text"));
    }
}
