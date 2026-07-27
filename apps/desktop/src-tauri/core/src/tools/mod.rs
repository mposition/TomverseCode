//! Tool Runtime — 승인된 `ToolRequest`만 실제로 실행하는 곳.
//!
//! docs/design/process-architecture.md 2절: Node는 실행 권한이 없다. 파일 I/O와 프로세스 spawn은
//! 전부 여기서 일어나고, 모든 진입점은 Policy Gate를 이미 통과했음을 전제한다 —
//! 그 전제를 타입으로 강제하기 위해 `execute()`는 `PolicyDecision`을 인자로 받고,
//! 판단이 `Deny`면 실행하지 않는다.

pub mod patch;

use crate::artifacts::ArtifactStore;
use crate::paths::WorkspaceRoot;
use crate::policy::parse_run_command;
use crate::time::{elapsed_ms, now_iso};
use crate::types::{
    Decision, FileMutationRecord, ImageRef, PolicyDecision, RunCommandArgs, ToolName, ToolRequest, ToolResult,
    ToolStatus,
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
}

/// 실행 결과 + 부수 기록. 호출자(host)가 이걸 받아 SQLite에 기록한다 —
/// Tool Runtime이 직접 DB를 만지지 않는 이유는 트랜잭션 경계를 host가 소유해야
/// "이벤트와 상태를 같은 트랜잭션에 쓴다"는 불변식을 지킬 수 있기 때문이다.
pub struct ToolOutcome {
    pub result: ToolResult,
    pub mutation: Option<FileMutationRecord>,
    /// 출력이 커서 artifact로 밀어낸 경우의 참조
    pub output_ref: Option<String>,
    /// UI diff 패널용 unified diff (파일 변경 도구일 때만)
    pub diff: Option<String>,
}

impl ToolRuntime {
    pub fn new(root: WorkspaceRoot, artifacts: ArtifactStore, default_timeout: Duration) -> Self {
        Self {
            root,
            artifacts,
            default_timeout,
        }
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    /// 모든 도구 실행의 단일 진입점.
    ///
    /// `decision`은 Policy Gate의 판단이며, `Deny`거나 승인이 필요한데 아직 승인되지 않았으면
    /// 실행하지 않는다. 승인 여부(`approved`)는 host가 사용자 응답을 받아 넘긴다.
    pub fn execute(&self, request: &ToolRequest, decision: &PolicyDecision, approved: bool) -> ToolOutcome {
        let start = Instant::now();

        if matches!(decision.decision, Decision::Deny) {
            return self.denied(request, start, &decision.reason);
        }
        if decision.requires_user_approval && !approved {
            return self.denied(
                request,
                start,
                &format!("사용자 승인이 필요하지만 승인되지 않았음: {}", decision.reason),
            );
        }

        match self.dispatch(request, start) {
            Ok(outcome) => outcome,
            Err(message) => ToolOutcome {
                result: ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Error,
                    output: None,
                    error: Some(message),
                    duration_ms: elapsed_ms(start),
                    completed_at: now_iso(),
                },
                mutation: None,
                output_ref: None,
                diff: None,
            },
        }
    }

    fn denied(&self, request: &ToolRequest, start: Instant, reason: &str) -> ToolOutcome {
        ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Denied,
                output: None,
                error: Some(reason.to_string()),
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
            },
            mutation: None,
            output_ref: None,
            diff: None,
        }
    }

    fn dispatch(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        match request.tool {
            ToolName::ListFiles => self.list_files(request, start),
            ToolName::SearchText => self.search_text(request, start),
            ToolName::ReadFile => self.read_file(request, start),
            ToolName::CreateFile => self.create_file(request, start),
            ToolName::ApplyPatch => self.apply_patch(request, start),
            ToolName::DeleteFile => self.delete_file(request, start),
            ToolName::RunCommand | ToolName::RunTests => self.run_command(request, start),
            ToolName::GitStatus => self.git(request, start, &["status", "--porcelain=v1", "--branch"]),
            ToolName::GitDiff => self.git_diff(request, start),
        }
    }

    // ---- 읽기 도구 ----

    fn list_files(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        let sub = request.args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let base = self.root.resolve_existing(sub).map_err(|e| e.to_string())?;
        let include_ignored = request
            .args
            .get("includeIgnored")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut builder = ignore::WalkBuilder::new(base.absolute());
        builder
            .hidden(false) // .github 등 dot 디렉터리도 보여준다
            .git_ignore(!include_ignored)
            .git_global(!include_ignored)
            .git_exclude(!include_ignored)
            // .git 디렉터리가 없어도 .gitignore를 적용한다. 기본값(require_git=true)이면
            // git 저장소가 아닌 워크스페이스에서 제외 규칙이 조용히 무시된다.
            .require_git(false)
            .parents(!include_ignored);
        // .git 자체는 .gitignore에 없어도 항상 제외한다 (context-engine.md 7절 하드 제외 목록).
        builder.filter_entry(|entry| entry.file_name() != ".git");

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

        let mut builder = ignore::WalkBuilder::new(base.absolute());
        builder.hidden(false);
        builder.filter_entry(|entry| entry.file_name() != ".git");

        'outer: for item in builder.build() {
            let Ok(entry) = item else { continue };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let Ok(bytes) = std::fs::read(path) else { continue };
            if is_binary(&bytes) {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else { continue };
            let Ok(rel) = path.strip_prefix(self.root.path()) else {
                continue;
            };
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

        self.ok_json(request, start, json!({ "matches": matches, "truncated": truncated }))
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

    fn create_file(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
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

        let pre_image = self.capture_pre_image(request, safe.relative(), existed, &before)?;

        if let Some(parent) = safe.absolute().parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(safe.absolute(), content).map_err(|e| e.to_string())?;

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
        outcome.mutation = Some(mutation);
        outcome.diff = if diff.is_empty() { None } else { Some(diff) };
        Ok(outcome)
    }

    fn apply_patch(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
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

        let pre_image = self.capture_pre_image(request, safe.relative(), existed, &before)?;

        if let Some(parent) = safe.absolute().parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(safe.absolute(), &after).map_err(|e| e.to_string())?;

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
        outcome.mutation = Some(mutation);
        outcome.diff = if diff.is_empty() { None } else { Some(diff) };
        Ok(outcome)
    }

    fn delete_file(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
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
        let pre_image = self.capture_pre_image(request, safe.relative(), true, &before)?;
        std::fs::remove_file(safe.absolute()).map_err(|e| e.to_string())?;

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
        outcome.mutation = Some(mutation);
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

    fn run_command(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
        // Policy Gate가 이미 검증했지만 다시 파싱한다 — 같은 args에서 같은 결론이 나와야 하고,
        // 여기서 별도 경로로 argv를 조립하면 "승인된 것과 실행되는 것"이 갈라질 수 있다.
        let cmd = parse_run_command(&request.args)?;
        let cwd = self.root.resolve_existing(&cmd.cwd).map_err(|e| e.to_string())?;
        let timeout = cmd
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(self.default_timeout);

        let execution = run_process(&cmd, cwd.absolute(), timeout)?;
        self.finish_command(request, start, &cmd, execution)
    }

    fn git(&self, request: &ToolRequest, start: Instant, args: &[&str]) -> Result<ToolOutcome, String> {
        let cmd = RunCommandArgs {
            program: "git".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: ".".to_string(),
            timeout_ms: None,
        };
        let execution = run_process(&cmd, self.root.path(), self.default_timeout)?;
        self.finish_command(request, start, &cmd, execution)
    }

    fn git_diff(&self, request: &ToolRequest, start: Instant) -> Result<ToolOutcome, String> {
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
        let execution = run_process(&cmd, self.root.path(), self.default_timeout)?;
        self.finish_command(request, start, &cmd, execution)
    }

    fn finish_command(
        &self,
        request: &ToolRequest,
        start: Instant,
        cmd: &RunCommandArgs,
        execution: Execution,
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

        let status = if execution.timed_out {
            ToolStatus::Timeout
        } else if execution.exit_code == Some(0) {
            ToolStatus::Ok
        } else {
            // 0이 아닌 종료 코드는 "도구 실행 실패"가 아니라 "명령이 실패했다"는 사실이다.
            // 검증 러너가 이 구분을 필요로 하므로 status는 Ok로 두고 exitCode를 그대로 전달한다.
            // 다만 실행 자체가 안 된 경우(spawn 실패)는 dispatch에서 Err로 처리된다.
            ToolStatus::Ok
        };

        let output = json!({
            "command": { "program": cmd.program, "args": cmd.args, "cwd": cmd.cwd },
            "exitCode": execution.exit_code,
            "stdout": stdout_preview,
            "stderr": stderr_preview,
            "timedOut": execution.timed_out,
            "outputTruncated": output_truncated,
            "outputRef": output_ref,
            "durationMs": execution.duration_ms,
        });

        Ok(ToolOutcome {
            result: ToolResult {
                request_id: request.request_id.clone(),
                status,
                output: Some(output),
                error: if execution.timed_out {
                    Some(format!("명령이 {}ms 후 타임아웃됨", execution.duration_ms))
                } else {
                    None
                },
                duration_ms: elapsed_ms(start),
                completed_at: now_iso(),
            },
            mutation: None,
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
            },
            mutation: None,
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
            });
        }
        requests
    }
}

struct Execution {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    duration_ms: u64,
}

/// 프로세스 실행 + 타임아웃.
///
/// `Command`에 program/args를 그대로 넘긴다 — 셸을 경유하지 않으므로 인자 안의 공백이나
/// 메타문자가 재해석되지 않는다. 이게 승인 모달의 표시가 실제 실행과 일치한다는 보장의 실체다.
fn run_process(cmd: &RunCommandArgs, cwd: &Path, timeout: Duration) -> Result<Execution, String> {
    let start = Instant::now();

    let mut child = Command::new(&cmd.program)
        .args(&cmd.args)
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
        .env_remove("NODE_V8_COVERAGE")
        .spawn()
        .map_err(|e| format!("{}를 실행할 수 없음: {e}", cmd.program))?;

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

    let mut timed_out = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("자식 프로세스 상태를 확인할 수 없음: {e}")),
        }
    };

    let stdout = rx_out.recv().unwrap_or_default();
    let stderr = rx_err.recv().unwrap_or_default();
    let _ = out_handle.join();
    let _ = err_handle.join();

    Ok(Execution {
        exit_code: exit_status.and_then(|s| s.code()),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        timed_out,
        duration_ms: elapsed_ms(start),
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
        }
    }

    impl Harness {
        /// Policy Gate를 실제로 통과시켜 실행한다 — 테스트가 게이트를 우회하면
        /// "게이트를 반드시 지난다"는 불변식을 테스트가 검증하지 않게 된다.
        fn run(&self, request: &ToolRequest) -> ToolOutcome {
            let decision = self.gate.evaluate(request, self.runtime.root(), &self.policy);
            let approved = decision.requires_user_approval;
            self.runtime.execute(request, &decision, approved)
        }

        fn run_unapproved(&self, request: &ToolRequest) -> ToolOutcome {
            let decision = self.gate.evaluate(request, self.runtime.root(), &self.policy);
            self.runtime.execute(request, &decision, false)
        }

        fn read(&self, rel: &str) -> String {
            std::fs::read_to_string(self.root_path.join(rel)).unwrap()
        }
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

    #[test]
    fn search_text_finds_matches() {
        let h = harness();
        let out = h.run(&req(ToolName::SearchText, json!({ "pattern": "line two" })));
        let matches = out.result.output.unwrap()["matches"].as_array().unwrap().clone();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"].as_str().unwrap(), "src/app.ts");
        assert_eq!(matches[0]["line"].as_u64().unwrap(), 2);
    }

    #[test]
    fn create_file_records_mutation_with_pre_and_post_images() {
        let h = harness();
        let out = h.run(&req(
            ToolName::CreateFile,
            json!({ "path": "src/new.ts", "content": "export const x = 1;\n" }),
        ));
        assert_eq!(out.result.status, ToolStatus::Ok);
        let m = out.mutation.expect("expected a FileMutationRecord");
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
        let m = out.mutation.unwrap();
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
        assert!(out.mutation.is_none(), "failed patch must not record a mutation");
        assert_eq!(h.read("src/app.ts"), before, "file must be unchanged");
    }

    #[test]
    fn delete_file_records_pre_image_for_rollback() {
        let h = harness();
        let out = h.run(&req(ToolName::DeleteFile, json!({ "path": "src/app.ts" })));
        assert_eq!(out.result.status, ToolStatus::Ok);
        assert!(!h.root_path.join("src/app.ts").exists());
        let m = out.mutation.unwrap();
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
        let mutations = vec![patch_out.mutation.unwrap(), created_out.mutation.unwrap()];

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
