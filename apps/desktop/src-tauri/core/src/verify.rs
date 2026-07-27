//! Verification Runner — 결정론적 판정자.
//!
//! CLAUDE.md 원칙 1: "결정론적 검증이 모델 의견보다 우선한다. `VERIFYING`은 `complexityTier`와
//! 무관하게 **항상** 실행된다."
//!
//! 이게 Rust에 있는 이유(Node가 아니라): Node가 장악당하면 "검증했고 통과했다"고 주장할 수 있다.
//! 검증 명령의 탐지·실행·판정과 `verification_reports` 기록이 모두 신뢰 경계 안에 있어야
//! 리포트가 증거로서 의미를 갖는다.
//!
//! 작업 지침 4.8절의 핵심 요구:
//!  - 프로젝트 유형 감지 (Node/npm, Rust/Cargo, .NET)
//!  - baseline(작업 전) vs post(작업 후) 구분
//!  - 변경 전부터 실패하던 것과 이번에 새로 실패한 것 구별
//!  - 실행할 명령이 없으면 통과로 위장하지 않고 `NOT_CONFIGURED`

use crate::artifacts::ArtifactStore;
use crate::paths::WorkspaceRoot;
use crate::time::now_iso;
use crate::tools::{head_tail, MAX_INLINE_OUTPUT_BYTES};
use crate::types::{
    Overall, RunCommandArgs, ToolName, ToolRequest, ToolResult, ToolStatus, VerificationCheck, VerificationKind,
    VerificationPhase, VerificationReport, VerificationStatus,
};
use serde_json::json;
use std::collections::BTreeMap;

/// 감지된 검증 명령 세트. `WorkspaceSnapshot.projectMeta`와 같은 정보를 Rust 쪽에서 독립적으로
/// 만든다 — Node가 넘긴 명령을 그대로 실행하면 "검증 명령을 바꿔치기해 통과시키는" 경로가 열린다.
#[derive(Debug, Clone, Default)]
pub struct DetectedCommands {
    pub commands: BTreeMap<&'static str, (VerificationKind, RunCommandArgs, String)>,
}

impl DetectedCommands {
    fn insert(&mut self, key: &'static str, kind: VerificationKind, cmd: RunCommandArgs, source: &str) {
        self.commands.entry(key).or_insert((kind, cmd, source.to_string()));
    }
}

fn cmd(program: &str, args: &[&str]) -> RunCommandArgs {
    RunCommandArgs {
        program: program.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: ".".to_string(),
        timeout_ms: None,
    }
}

/// 프로젝트 유형 감지. 매니페스트에 실제로 존재하는 스크립트만 명령으로 채택한다 —
/// `npm run lint`를 없는데 실행하면 exit code 1이 나오고, 그걸 "검증 실패"로 보고하면
/// 정직하지 않은 리포트가 된다(그건 실패가 아니라 NOT_CONFIGURED다).
pub fn detect_commands(root: &WorkspaceRoot) -> DetectedCommands {
    let mut detected = DetectedCommands::default();

    // ---- Node / npm ----
    let package_json = root.path().join("package.json");
    if let Ok(text) = std::fs::read_to_string(&package_json) {
        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) {
            let scripts = manifest
                .get("scripts")
                .and_then(|s| s.as_object())
                .cloned()
                .unwrap_or_default();
            let has = |name: &str| scripts.contains_key(name);

            if has("test") {
                detected.insert(
                    "test",
                    VerificationKind::Test,
                    cmd("npm", &["test"]),
                    "package.json scripts.test",
                );
            }
            if has("build") {
                detected.insert(
                    "build",
                    VerificationKind::Build,
                    cmd("npm", &["run", "build"]),
                    "package.json scripts.build",
                );
            }
            if has("typecheck") {
                detected.insert(
                    "typecheck",
                    VerificationKind::Typecheck,
                    cmd("npm", &["run", "typecheck"]),
                    "package.json scripts.typecheck",
                );
            }
            if has("lint") {
                detected.insert(
                    "lint",
                    VerificationKind::Lint,
                    cmd("npm", &["run", "lint"]),
                    "package.json scripts.lint",
                );
            }
        }
    }

    // ---- Rust / Cargo ----
    if root.path().join("Cargo.toml").exists() {
        detected.insert(
            "test",
            VerificationKind::Test,
            cmd("cargo", &["test", "--quiet"]),
            "Cargo.toml",
        );
        detected.insert(
            "build",
            VerificationKind::Build,
            cmd("cargo", &["build", "--quiet"]),
            "Cargo.toml",
        );
    }

    // ---- .NET ----
    // .sln이 있으면 그것을, 없으면 .csproj를 찾는다. dotnet은 인자 없이도 디렉터리를 탐색하므로
    // 파일명을 인자로 붙이지 않는다 — 파일명을 인자로 넘기면 경로 하드 체크와 얽힌다.
    let has_dotnet = std::fs::read_dir(root.path())
        .map(|entries| {
            entries.filter_map(|e| e.ok()).any(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                name.ends_with(".sln") || name.ends_with(".csproj") || name.ends_with(".fsproj")
            })
        })
        .unwrap_or(false);
    if has_dotnet {
        detected.insert("test", VerificationKind::Test, cmd("dotnet", &["test"]), ".sln/.csproj");
        detected.insert(
            "build",
            VerificationKind::Build,
            cmd("dotnet", &["build"]),
            ".sln/.csproj",
        );
    }

    detected
}

/// 검증 실행자. Tool Runtime을 통해 명령을 돌리는 콜백을 받는다 —
/// 이렇게 하면 검증 명령도 예외 없이 Tool Runtime과 이벤트 로그를 거친다
/// (감사 추적에 예외가 없어야 한다는 원칙).
pub struct VerificationRunner<'a> {
    root: &'a WorkspaceRoot,
    artifacts: &'a ArtifactStore,
}

/// Tool Runtime 호출 어댑터. host가 구현하며, 실행 결과를 이벤트 로그에도 남긴다.
pub trait CommandExecutor {
    fn execute(&mut self, request: &ToolRequest) -> ToolResult;
}

impl<'a> VerificationRunner<'a> {
    pub fn new(root: &'a WorkspaceRoot, artifacts: &'a ArtifactStore) -> Self {
        Self { root, artifacts }
    }

    /// 검증 1회 실행.
    ///
    /// `baseline`이 주어지면 post 리포트에서 "새로 실패한 것"과 "원래 실패하던 것"을 나눈다.
    pub fn run(
        &self,
        task_id: &str,
        phase: VerificationPhase,
        attempt_number: u32,
        executor: &mut dyn CommandExecutor,
        baseline: Option<&VerificationReport>,
    ) -> VerificationReport {
        let detected = detect_commands(self.root);
        let mut checks: Vec<VerificationCheck> = Vec::new();

        // 실행 순서: build → typecheck → test → lint.
        // build가 깨지면 test 결과는 의미가 없지만 그래도 전부 실행한다 — 사용자가 한 번에
        // 전체 상태를 보는 편이 낫고, 스킵하면 그 스킵이 "통과"로 오해될 여지가 생긴다.
        for key in ["build", "typecheck", "test", "lint"] {
            let kind = match key {
                "build" => VerificationKind::Build,
                "typecheck" => VerificationKind::Typecheck,
                "test" => VerificationKind::Test,
                _ => VerificationKind::Lint,
            };
            match detected.commands.get(key) {
                None => checks.push(VerificationCheck {
                    kind,
                    command: None,
                    status: VerificationStatus::NotConfigured,
                    summary: format!("이 프로젝트에 {key} 명령이 없음 — 실행하지 않았고, 통과로 간주하지 않음"),
                    detail: None,
                    detail_ref: None,
                    exit_code: None,
                    duration_ms: None,
                }),
                Some((kind, command, source)) => {
                    checks.push(self.run_one(task_id, *kind, command, source, executor));
                }
            }
        }

        let (newly_failing, preexisting) = match (phase, baseline) {
            (VerificationPhase::Post, Some(base)) => {
                let base_failed: Vec<VerificationKind> = base
                    .checks
                    .iter()
                    .filter(|c| matches!(c.status, VerificationStatus::Failed | VerificationStatus::TimedOut))
                    .map(|c| c.kind)
                    .collect();
                let now_failed: Vec<VerificationKind> = checks
                    .iter()
                    .filter(|c| matches!(c.status, VerificationStatus::Failed | VerificationStatus::TimedOut))
                    .map(|c| c.kind)
                    .collect();
                let newly: Vec<VerificationKind> = now_failed
                    .iter()
                    .copied()
                    .filter(|k| !base_failed.contains(k))
                    .collect();
                let pre: Vec<VerificationKind> =
                    now_failed.iter().copied().filter(|k| base_failed.contains(k)).collect();
                (Some(newly), Some(pre))
            }
            // baseline이 없으면 "새로 실패한 것"을 알 수 없다. 빈 배열(=새 실패 없음)로
            // 위장하지 않고 None을 둔다.
            _ => (None, None),
        };

        let overall = compute_overall(&checks, newly_failing.as_deref());

        VerificationReport {
            task_id: task_id.to_string(),
            report_id: format!("verify-{}", uuid::Uuid::new_v4()),
            phase,
            attempt_number,
            checks,
            newly_failing,
            preexisting_failures: preexisting,
            overall,
            created_at: now_iso(),
        }
    }

    fn run_one(
        &self,
        task_id: &str,
        kind: VerificationKind,
        command: &RunCommandArgs,
        source: &str,
        executor: &mut dyn CommandExecutor,
    ) -> VerificationCheck {
        let request = ToolRequest {
            request_id: format!("verify-{}-{}", kind.as_str(), uuid::Uuid::new_v4()),
            task_id: task_id.to_string(),
            tool: ToolName::RunTests,
            args: json!({
                "program": command.program,
                "args": command.args,
                "cwd": command.cwd,
            }),
            risk_tier: None,
            requested_by: json!({ "role": "orchestrator" }),
            created_at: Some(now_iso()),
        };

        let result = executor.execute(&request);

        let output = result.output.clone().unwrap_or(serde_json::Value::Null);
        let exit_code = output.get("exitCode").and_then(|v| v.as_i64()).map(|v| v as i32);
        let stdout = output.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
        let stderr = output.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
        let duration = output.get("durationMs").and_then(|v| v.as_u64());
        let combined = format!("{stdout}\n{stderr}");

        let status = match result.status {
            ToolStatus::Timeout => VerificationStatus::TimedOut,
            // 취소된 검증은 실패가 아니다 — 사용자가 멈춘 것이므로 "고쳐야 할 실패"로 다루면
            // FIX_LOOP가 존재하지 않는 문제를 고치려 든다.
            ToolStatus::Cancelled => VerificationStatus::SkippedWithReason,
            // Policy Gate가 검증 명령을 거부한 경우. 이건 통과도 실패도 아니며,
            // 사유를 명시한 스킵으로 기록한다 — 조용히 pass로 넘기면 안 된다.
            ToolStatus::Denied => VerificationStatus::SkippedWithReason,
            ToolStatus::Error => VerificationStatus::SkippedWithReason,
            ToolStatus::Ok => {
                if exit_code == Some(0) {
                    VerificationStatus::Passed
                } else {
                    VerificationStatus::Failed
                }
            }
        };

        let summary = match status {
            VerificationStatus::Passed => format!("{} 통과 ({})", kind.as_str(), source),
            VerificationStatus::Failed => format!(
                "{} 실패 (exit {}) — {}",
                kind.as_str(),
                exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                first_meaningful_line(&combined)
            ),
            VerificationStatus::TimedOut => format!("{} 타임아웃", kind.as_str()),
            VerificationStatus::SkippedWithReason => format!(
                "{} 실행하지 못함: {}",
                kind.as_str(),
                result.error.clone().unwrap_or_else(|| "알 수 없는 오류".into())
            ),
            VerificationStatus::NotConfigured => format!("{} 명령 없음", kind.as_str()),
        };

        // 전체 로그는 artifact로, 리포트에는 발췌만. FIX_LOOP 다이제스트가 이걸 쓴다.
        let (detail, detail_ref) = if combined.trim().is_empty() {
            (None, None)
        } else if combined.len() > MAX_INLINE_OUTPUT_BYTES {
            let stored = self
                .artifacts
                .put_text(
                    task_id,
                    &format!("{}-{}.log", request.request_id, kind.as_str()),
                    &combined,
                )
                .ok();
            (Some(head_tail(&combined, 40, 40)), stored.map(|s| s.artifact_ref))
        } else {
            (Some(combined.clone()), None)
        };

        VerificationCheck {
            kind,
            command: Some(command.clone()),
            status,
            summary,
            detail,
            detail_ref,
            exit_code,
            duration_ms: duration,
        }
    }
}

/// 종합 판정.
///
/// **규칙: 현재 실패 중인 체크가 하나라도 있으면 `fail`이다.** baseline에서도 실패했는지는
/// 판정을 바꾸지 않고 `preexistingFailures`로 따로 보고한다.
///
/// 처음에는 "baseline에도 있던 실패는 이번 변경의 책임이 아니므로 pass"로 구현했는데,
/// e2e 테스트가 그 규칙의 치명적 결과를 드러냈다: **"실패하는 테스트를 고쳐줘"라는 태스크에서
/// 모델이 아무것도 고치지 못했는데 COMPLETED가 나온다.** 그 테스트는 baseline에서도 실패했으니
/// "새로 깨진 것 없음 → pass"가 되기 때문이다. 이건 CLAUDE.md 원칙 1("결정론적 검증이 최종
/// 판정자")과 작업 지침 3.4절("통과로 위장하지 말 것")을 정면으로 위반한다 —
/// 버그 수정 태스크에서 대상 테스트가 여전히 실패하는데 성공이라고 보고하는 것이므로.
///
/// 이 규칙의 대가: 오래전부터 lint가 깨져 있던 저장소에서는 무관한 작은 수정도 `fail`이 된다.
/// 그 대가를 받아들이는 대신 두 가지로 완화한다 —
///   1. `preexistingFailures`가 "이건 당신 변경 때문이 아니다"를 명시하고 UI/요약에 드러난다.
///   2. FIX_LOOP 다이제스트가 pre-existing 실패를 별도로 표시해 모델이 맥락을 안다.
/// "거짓 성공"과 "설명이 붙은 실패" 중에서는 후자가 이 제품의 명제에 맞다.
///
/// 실행된 검증이 하나도 없으면 pass가 아니라 `not_verified`다.
fn compute_overall(checks: &[VerificationCheck], _newly_failing: Option<&[VerificationKind]>) -> Overall {
    let executed = checks
        .iter()
        .filter(|c| {
            matches!(
                c.status,
                VerificationStatus::Passed | VerificationStatus::Failed | VerificationStatus::TimedOut
            )
        })
        .count();
    if executed == 0 {
        return Overall::NotVerified;
    }

    let any_failure = checks
        .iter()
        .any(|c| matches!(c.status, VerificationStatus::Failed | VerificationStatus::TimedOut));
    if any_failure {
        Overall::Fail
    } else {
        Overall::Pass
    }
}

fn first_meaningful_line(text: &str) -> String {
    text.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
        .unwrap_or_else(|| "(출력 없음)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct FakeExecutor {
        /// program+args → (exitCode, stdout)
        responses: Vec<(String, i32, String)>,
        pub calls: Vec<String>,
    }

    impl CommandExecutor for FakeExecutor {
        fn execute(&mut self, request: &ToolRequest) -> ToolResult {
            let program = request.args["program"].as_str().unwrap().to_string();
            let args: Vec<String> = request.args["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            let key = format!("{program} {}", args.join(" "));
            self.calls.push(key.clone());
            let (code, stdout) = self
                .responses
                .iter()
                .find(|(k, _, _)| *k == key)
                .map(|(_, c, s)| (*c, s.clone()))
                .unwrap_or((0, String::new()));
            ToolResult {
                request_id: request.request_id.clone(),
                status: ToolStatus::Ok,
                output: Some(json!({
                    "command": { "program": program, "args": args, "cwd": "." },
                    "exitCode": code,
                    "stdout": stdout,
                    "stderr": "",
                    "durationMs": 10,
                })),
                error: None,
                duration_ms: 10,
                completed_at: now_iso(),
            }
        }
    }

    fn setup(files: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, WorkspaceRoot, ArtifactStore) {
        let dir = tempfile::tempdir().unwrap();
        for (path, content) in files {
            let full = dir.path().join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, content).unwrap();
        }
        let art_dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(art_dir.path()).unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        (dir, art_dir, root, artifacts)
    }

    #[test]
    fn detects_npm_scripts_that_exist_only() {
        let (_d, _a, root, _art) = setup(&[(
            "package.json",
            r#"{ "scripts": { "test": "node --test", "build": "tsc" } }"#,
        )]);
        let detected = detect_commands(&root);
        assert!(detected.commands.contains_key("test"));
        assert!(detected.commands.contains_key("build"));
        // lint 스크립트가 없으므로 명령을 만들어내지 않는다.
        assert!(!detected.commands.contains_key("lint"));
    }

    #[test]
    fn detects_cargo_project() {
        let (_d, _a, root, _art) = setup(&[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        let detected = detect_commands(&root);
        let (_, cmd, _) = detected.commands.get("test").unwrap();
        assert_eq!(cmd.program, "cargo");
        assert_eq!(cmd.args, vec!["test", "--quiet"]);
    }

    #[test]
    fn detects_dotnet_project() {
        let (_d, _a, root, _art) = setup(&[("App.csproj", "<Project />")]);
        let detected = detect_commands(&root);
        let (_, cmd, _) = detected.commands.get("build").unwrap();
        assert_eq!(cmd.program, "dotnet");
    }

    #[test]
    fn missing_commands_are_not_configured_not_passed() {
        // 아무 매니페스트도 없는 디렉터리.
        let (_d, _a, root, artifacts) = setup(&[("readme.md", "hi")]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let mut exec = FakeExecutor {
            responses: vec![],
            calls: vec![],
        };
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut exec, None);

        assert!(exec.calls.is_empty(), "nothing should have been executed");
        assert!(report
            .checks
            .iter()
            .all(|c| c.status == VerificationStatus::NotConfigured));
        // 여기가 핵심: 실행할 게 없었다는 사실이 pass로 위장되지 않는다.
        assert_eq!(report.overall, Overall::NotVerified);
    }

    #[test]
    fn passing_test_yields_pass() {
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let mut exec = FakeExecutor {
            responses: vec![("npm test".into(), 0, "ok".into())],
            calls: vec![],
        };
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut exec, None);
        assert_eq!(report.overall, Overall::Pass);
        let test_check = report.checks.iter().find(|c| c.kind == VerificationKind::Test).unwrap();
        assert_eq!(test_check.status, VerificationStatus::Passed);
    }

    #[test]
    fn failing_test_yields_fail() {
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let mut exec = FakeExecutor {
            responses: vec![("npm test".into(), 1, "1 test failed".into())],
            calls: vec![],
        };
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut exec, None);
        assert_eq!(report.overall, Overall::Fail);
    }

    #[test]
    fn still_failing_check_is_reported_as_fail_but_attributed_to_baseline() {
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x", "lint": "y" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);

        // baseline: lint가 원래 실패하고 있었다.
        let mut base_exec = FakeExecutor {
            responses: vec![
                ("npm test".into(), 0, "ok".into()),
                ("npm run lint".into(), 2, "style errors".into()),
            ],
            calls: vec![],
        };
        let baseline = runner.run("task-1", VerificationPhase::Baseline, 0, &mut base_exec, None);
        assert_eq!(baseline.overall, Overall::Fail);

        // post: lint가 여전히 실패한다.
        let mut post_exec = FakeExecutor {
            responses: vec![
                ("npm test".into(), 0, "ok".into()),
                ("npm run lint".into(), 2, "style errors".into()),
            ],
            calls: vec![],
        };
        let post = runner.run("task-1", VerificationPhase::Post, 0, &mut post_exec, Some(&baseline));

        // 이번 변경이 새로 깨뜨린 것은 없다는 사실은 정확히 보고된다...
        assert_eq!(post.newly_failing.as_deref(), Some(&[][..]));
        assert_eq!(
            post.preexisting_failures.as_deref(),
            Some(&[VerificationKind::Lint][..])
        );
        // ...그러나 현재 실패 중인 체크가 있으므로 통과로 위장하지 않는다.
        assert_eq!(post.overall, Overall::Fail);
    }

    #[test]
    fn fixing_a_previously_failing_check_yields_pass() {
        // 이게 버그 수정 태스크의 정상 경로다: baseline에서 실패 → 변경 후 통과.
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);

        let mut base_exec = FakeExecutor {
            responses: vec![("npm test".into(), 1, "1 failing".into())],
            calls: vec![],
        };
        let baseline = runner.run("task-1", VerificationPhase::Baseline, 0, &mut base_exec, None);
        assert_eq!(baseline.overall, Overall::Fail);

        let mut post_exec = FakeExecutor {
            responses: vec![("npm test".into(), 0, "ok".into())],
            calls: vec![],
        };
        let post = runner.run("task-1", VerificationPhase::Post, 0, &mut post_exec, Some(&baseline));
        assert_eq!(post.overall, Overall::Pass);
        assert_eq!(post.newly_failing.as_deref(), Some(&[][..]));
    }

    #[test]
    fn newly_broken_check_fails_even_if_something_was_already_broken() {
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x", "lint": "y" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);

        let mut base_exec = FakeExecutor {
            responses: vec![
                ("npm test".into(), 0, "ok".into()),
                ("npm run lint".into(), 2, "".into()),
            ],
            calls: vec![],
        };
        let baseline = runner.run("task-1", VerificationPhase::Baseline, 0, &mut base_exec, None);

        // 이번 변경이 test를 깨뜨렸다.
        let mut post_exec = FakeExecutor {
            responses: vec![
                ("npm test".into(), 1, "AssertionError".into()),
                ("npm run lint".into(), 2, "".into()),
            ],
            calls: vec![],
        };
        let post = runner.run("task-1", VerificationPhase::Post, 1, &mut post_exec, Some(&baseline));

        assert_eq!(post.newly_failing.as_deref(), Some(&[VerificationKind::Test][..]));
        assert_eq!(post.overall, Overall::Fail);
    }

    #[test]
    fn baseline_absent_means_newly_failing_is_unknown_not_empty() {
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let mut exec = FakeExecutor {
            responses: vec![("npm test".into(), 0, "".into())],
            calls: vec![],
        };
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut exec, None);
        assert!(report.newly_failing.is_none());
    }

    #[test]
    fn denied_command_is_skipped_with_reason_not_passed() {
        struct DenyExecutor;
        impl CommandExecutor for DenyExecutor {
            fn execute(&mut self, request: &ToolRequest) -> ToolResult {
                ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Denied,
                    output: None,
                    error: Some("policy denied".into()),
                    duration_ms: 0,
                    completed_at: now_iso(),
                }
            }
        }
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut DenyExecutor, None);
        let test_check = report.checks.iter().find(|c| c.kind == VerificationKind::Test).unwrap();
        assert_eq!(test_check.status, VerificationStatus::SkippedWithReason);
        assert!(test_check.summary.contains("policy denied"));
        // 실행된 검증이 없으므로 pass가 아니다.
        assert_eq!(report.overall, Overall::NotVerified);
    }

    #[test]
    fn timeout_is_reported_as_timed_out() {
        struct TimeoutExecutor;
        impl CommandExecutor for TimeoutExecutor {
            fn execute(&mut self, request: &ToolRequest) -> ToolResult {
                ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Timeout,
                    output: Some(json!({ "exitCode": null, "stdout": "", "stderr": "", "timedOut": true })),
                    error: Some("timed out".into()),
                    duration_ms: 1000,
                    completed_at: now_iso(),
                }
            }
        }
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut TimeoutExecutor, None);
        let test_check = report.checks.iter().find(|c| c.kind == VerificationKind::Test).unwrap();
        assert_eq!(test_check.status, VerificationStatus::TimedOut);
        assert_eq!(report.overall, Overall::Fail);
    }
}
