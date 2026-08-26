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
    /// 이 판정의 **근거가 사는 파일들**(워크스페이스 상대경로).
    ///
    /// # 왜 명령과 따로 모으는가 (50절)
    ///
    /// 사전 승인의 지문은 "이 파일들의 내용이 그대로인가"를 물어야 한다(24.5·29.3절). 종전에는
    /// 그 목록이 `host.rs`에 **손으로 적혀 있었고**, 그래서 `.csproj`도 `pyproject.toml`도
    /// 빠져 있었다 — dotnet·Python 프로젝트에서는 매니페스트를 고쳐도 사전 승인이 살아 있었다.
    ///
    /// **명령이 없어도 근거는 남는다.** 파일을 읽었는데 선언이 없었다는 것도 사실이고,
    /// 나중에 그 파일에 선언이 **생기면** 판정이 달라진다 — 그것도 지문이 봐야 하는 변화다.
    pub evidence: std::collections::BTreeSet<String>,
}

impl DetectedCommands {
    fn insert(&mut self, key: &'static str, kind: VerificationKind, cmd: RunCommandArgs, source: &str) {
        self.commands.entry(key).or_insert((kind, cmd, source.to_string()));
    }

    /// 이 파일을 근거로 읽었다. **판정 결과와 무관하게 부른다.**
    fn read_evidence(&mut self, path: &str) {
        self.evidence.insert(path.to_string());
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
    detected.read_evidence("package.json");
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
    detected.read_evidence("Cargo.toml");
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
    // **프로젝트 파일 이름을 근거로 기록한다**(50절). `.sln/.csproj` 같은 요약 문자열이 아니라
    // 실제 파일이어야 지문이 그 내용을 다시 읽을 수 있다.
    let dotnet_projects: Vec<String> = std::fs::read_dir(root.path())
        .map(|entries| {
            let mut found: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| {
                    let lower = name.to_lowercase();
                    lower.ends_with(".sln") || lower.ends_with(".csproj") || lower.ends_with(".fsproj")
                })
                .collect();
            // 순서를 고정한다 — 디렉터리 순회 순서는 파일시스템마다 다르고, 그러면 근거 문자열이
            // 같은 워크스페이스에서 실행마다 달라진다.
            found.sort();
            found
        })
        .unwrap_or_default();
    for project in &dotnet_projects {
        detected.read_evidence(project);
    }
    if let Some(first) = dotnet_projects.first() {
        detected.insert("test", VerificationKind::Test, cmd("dotnet", &["test"]), first);
        detected.insert("build", VerificationKind::Build, cmd("dotnet", &["build"]), first);
    }

    // ---- Python ----
    //
    // **마지막에 온다.** `insert`가 먼저 넣은 것을 이기지 않으므로(`or_insert`), 다국어
    // 저장소에서 이 순서가 곧 우선순위다. Python을 끝에 두는 이유는 이 갈래만 인터프리터
    // 해석을 요구해서 실패할 여지가 넓기 때문이다 — 다른 갈래가 답할 수 있으면 그쪽이 낫다.
    //
    // 선언이 없으면 아무것도 넣지 않는다. 자세한 근거는 `python.rs`에 있다.
    let py_probe = crate::python::Probe {
        platform: crate::tools::program::Platform::current(),
        is_file: &|rel| root.path().join(rel).is_file(),
        read: &|rel| std::fs::read_to_string(root.path().join(rel)).ok(),
        env: &|key| std::env::var(key).ok(),
        // **실행 경로가 쓰는 것과 같은 해석기를 쓴다.** 여기서 따로 PATH를 뒤지면 "찾았다고
        // 해 놓고 실행에서 못 찾는" 갈림이 생긴다 — Windows의 `PATHEXT`가 정확히 그 자리다.
        on_path: &|name| {
            let path = std::env::var("PATH").unwrap_or_default();
            let pathext = std::env::var("PATHEXT").unwrap_or_default();
            let is_file = |p: &std::path::Path| p.is_file();
            crate::tools::program::find_executable(
                name,
                &crate::tools::program::ResolveEnv {
                    platform: crate::tools::program::Platform::current(),
                    path: &path,
                    pathext: &pathext,
                    is_file: &is_file,
                },
            )
            .is_some()
        },
    };
    let py = crate::python::detect(&py_probe);
    // **선언 파일은 명령이 만들어지지 않아도 근거다**(50절). 인터프리터를 못 찾아 명령이
    // 비어도 그 파일의 변화는 판정을 바꿀 수 있다.
    for check in &py.checks {
        detected.read_evidence(&check.evidence);
    }
    if let Some(interpreter) = &py.interpreter {
        // **워크스페이스 안의 인터프리터는 절대경로로 바꾼다.** 상대 프로그램 경로는
        // 플랫폼마다 다르게 풀린다 — Unix는 자식이 `chdir` 뒤에 찾지만 Windows는 부모의
        // cwd 기준으로 먼저 찾으므로, 같은 값이 한쪽에서만 동작한다.
        let program = if interpreter.workspace_relative {
            root.path().join(&interpreter.program).to_string_lossy().to_string()
        } else {
            interpreter.program.clone()
        };
        for check in &py.checks {
            let kind = match check.key {
                "test" => VerificationKind::Test,
                "lint" => VerificationKind::Lint,
                _ => VerificationKind::Typecheck,
            };
            let args: Vec<&str> = check.args.iter().map(String::as_str).collect();
            detected.insert(
                check.key,
                kind,
                cmd(&program, &args),
                // **어느 인터프리터를 왜 골랐는지도 근거에 넣는다.** 검증이 이상하게 실패했을 때
                // 사용자가 가장 먼저 묻는 것이 그것이다.
                &format!("{} (interpreter: {:?})", check.source, interpreter.how),
            );
        }
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
            injected_env: Default::default(),
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
/// 실행된 검증이 하나도 없으면 pass가 아니라 `not_configured`다.
///
/// **돌려고 했는데 돌지 못한 체크가 하나라도 있으면 `pass`를 낼 수 없다.**
/// `SkippedWithReason`은 정책 거부·취소·실행 오류를 담는데, 그중 실행 오류에는
/// "Windows에서 `npm`을 찾지 못했다" 같은 환경 결함이 포함된다. 예전 규칙(`Passed`가 하나라도
/// 있고 `Failed`가 없으면 pass)이면 **build만 통과하고 test는 실행조차 못한 상태가 `pass`가
/// 된다.** 그게 정확히 이번 Windows 결함이 만든 상황이며 — 검증되지 않은 것을 검증됐다고
/// 보고하는 것은 이 제품이 존재하는 이유를 부정한다.
///
/// `NotConfigured`는 여기 해당하지 않는다. 그건 "돌릴 것이 없었다"이지 "돌리지 못했다"가
/// 아니고, lint 스크립트가 없는 프로젝트를 영원히 pass 불가로 만들면 규칙이 쓸모없어진다.
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
        // **여기서 두 경우가 갈린다.** 돌린 것이 하나도 없더라도, 돌리려다 못 돌린 체크가
        // 있으면 그건 "명령이 없다"가 아니다. 뭉쳐 두면 아래 `any_unrunnable` 분기가
        // 영원히 닿지 않는 죽은 코드가 되고, 사용자는 틀린 안내를 받는다.
        if checks
            .iter()
            .any(|c| matches!(c.status, VerificationStatus::SkippedWithReason))
        {
            return Overall::CouldNotRun;
        }
        return Overall::NotConfigured;
    }

    let any_failure = checks
        .iter()
        .any(|c| matches!(c.status, VerificationStatus::Failed | VerificationStatus::TimedOut));
    if any_failure {
        return Overall::Fail;
    }

    let any_unrunnable = checks
        .iter()
        .any(|c| matches!(c.status, VerificationStatus::SkippedWithReason));
    if any_unrunnable {
        return Overall::CouldNotRun;
    }

    Overall::Pass
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

    /// **우리가 만든 검증 명령을 우리 게이트가 거부하지 않는다** (49.4절).
    ///
    /// 이 둘은 다른 파일에 있고 서로를 모른다. 어긋나면 증상이 고약하다 — 검증이 정책 거부로
    /// 끝나고, 그건 `SKIPPED_WITH_REASON` → `could_not_run`이 되어 **정상 수정 작업이 검증 없이
    /// 완료로 보고된다**(CLAUDE.md가 npm shim에서 겪은 그 실패 모드다).
    ///
    /// 그리고 반대 방향의 어긋남도 실제로 있었다: allowlist에 `pytest`가 **처음부터 있었는데**
    /// `detect_commands`가 그것을 한 번도 만들지 않았다. 문만 있고 길이 없었던 것이다.
    ///
    /// 판정 기준을 손으로 적지 않는다 — 픽스처 워크스페이스를 만들어 **실제로 만들어진 명령**을
    /// 게이트에 태운다.
    #[test]
    fn every_command_we_detect_passes_the_default_gate() {
        use crate::policy::command::{default_command_policy, match_command, CommandMatch};

        let fixtures: Vec<(&str, Vec<(&str, &str)>)> = vec![
            ("npm", vec![("package.json", r#"{"scripts":{"test":"x","build":"x","lint":"x","typecheck":"x"}}"#)]),
            ("cargo", vec![("Cargo.toml", "[package]\nname = \"x\"\n")]),
            ("dotnet", vec![("app.csproj", "<Project/>")]),
            (
                "python",
                vec![("pyproject.toml", "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n")],
            ),
        ];

        let policy = default_command_policy();
        let mut checked = 0;
        for (label, files) in fixtures {
            let dir = tempfile::tempdir().unwrap();
            for (name, body) in files {
                fs::write(dir.path().join(name), body).unwrap();
            }
            // Python 갈래는 인터프리터를 찾아야 명령이 나온다. 워크스페이스 안에 가상환경을
            // 만들어 **PATH에 의존하지 않게** 한다 — CI에 python이 없어도 이 검사는 성립해야 한다.
            let venv = dir.path().join(".venv").join("bin");
            fs::create_dir_all(&venv).unwrap();
            fs::write(venv.join("python"), "").unwrap();

            let root = WorkspaceRoot::new(dir.path()).unwrap();
            let detected = detect_commands(&root);
            for (key, (_, cmd, source)) in &detected.commands {
                checked += 1;
                match match_command(&policy, cmd, true) {
                    CommandMatch::Denied { rule } => panic!(
                        "{label}의 {key} 명령이 게이트에서 거부됩니다: {} {} (규칙 {rule}, 근거 {source})",
                        cmd.program,
                        cmd.args.join(" ")
                    ),
                    CommandMatch::NoMatch => panic!(
                        "{label}의 {key} 명령이 allowlist에 없습니다: {} {} (근거 {source})",
                        cmd.program,
                        cmd.args.join(" ")
                    ),
                    CommandMatch::Allowed { .. } => {}
                }
            }
        }
        // **빈 집합에 대한 전칭 명제는 언제나 참이다.**
        assert!(checked >= 10, "검사한 명령이 {checked}개뿐입니다");
    }

    /// Python 갈래가 **인터프리터를 직접 부른다**(49.2절) — `pytest`를 PATH에서 찾지 않는다.
    #[test]
    fn a_declared_python_project_runs_through_its_venv_interpreter() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pytest.ini"), "[pytest]\n").unwrap();
        let venv = dir.path().join(".venv").join("bin");
        fs::create_dir_all(&venv).unwrap();
        fs::write(venv.join("python"), "").unwrap();

        let root = WorkspaceRoot::new(dir.path()).unwrap();
        let detected = detect_commands(&root);
        let (_, cmd, source) = detected.commands.get("test").expect("test 명령이 없습니다");
        assert!(cmd.program.ends_with(".venv/bin/python"), "{}", cmd.program);
        assert_eq!(cmd.args, vec!["-m", "pytest"]);
        // 근거에 **어느 인터프리터를 왜 골랐는지**가 남는다.
        assert!(source.contains("pytest.ini"), "{source}");
        assert!(source.contains("DotVenv"), "{source}");
    }

    /// **선언이 없으면 아무것도 만들지 않는다.** `tests/`만 있는 프로젝트는 pytest 프로젝트가 아니다.
    #[test]
    fn a_python_project_without_a_declaration_gets_no_command() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("tests")).unwrap();
        fs::write(dir.path().join("tests").join("test_x.py"), "").unwrap();
        let venv = dir.path().join(".venv").join("bin");
        fs::create_dir_all(&venv).unwrap();
        fs::write(venv.join("python"), "").unwrap();

        let root = WorkspaceRoot::new(dir.path()).unwrap();
        assert!(detect_commands(&root).commands.is_empty());
    }

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
                denial_kind: None,
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
        // 그리고 **왜** 검증되지 않았는지까지 남는다 — 이 경우는 정말로 명령이 없었다.
        assert_eq!(report.overall, Overall::NotConfigured);
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
                    denial_kind: None,
                }
            }
        }
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut DenyExecutor, None);
        let test_check = report.checks.iter().find(|c| c.kind == VerificationKind::Test).unwrap();
        assert_eq!(test_check.status, VerificationStatus::SkippedWithReason);
        assert!(test_check.summary.contains("policy denied"));
        // 실행된 검증이 없으므로 pass가 아니다. 그리고 명령은 있었으므로 `NotConfigured`도
        // 아니다 — 정책이 막아서 못 돌린 것이고, 사용자가 할 일이 다르다.
        assert_eq!(report.overall, Overall::CouldNotRun);
    }

    /// Windows 결함이 만든 상황 그대로: build는 돌아서 통과했는데 test는 프로그램 해석 실패로
    /// 실행조차 못했다. 예전 규칙이면 `pass`가 나오고, 작업이 검증 없이 완료로 보고된다.
    #[test]
    fn a_check_that_could_not_run_blocks_pass_even_if_another_check_passed() {
        struct PartialExecutor;
        impl CommandExecutor for PartialExecutor {
            fn execute(&mut self, request: &ToolRequest) -> ToolResult {
                let args: Vec<String> = request.args["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                // `npm run build`는 성공, `npm test`는 실행 자체가 실패.
                if args.first().map(|a| a.as_str()) == Some("run") {
                    return ToolResult {
                        request_id: request.request_id.clone(),
                        status: ToolStatus::Ok,
                        output: Some(json!({ "exitCode": 0, "stdout": "built", "stderr": "" })),
                        error: None,
                        duration_ms: 5,
                        completed_at: now_iso(),
                        denial_kind: None,
                    };
                }
                ToolResult {
                    request_id: request.request_id.clone(),
                    status: ToolStatus::Error,
                    output: None,
                    error: Some("npm를 실행할 수 없음: program not found".into()),
                    duration_ms: 1,
                    completed_at: now_iso(),
                    denial_kind: None,
                }
            }
        }

        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x", "build": "y" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut PartialExecutor, None);

        let build = report
            .checks
            .iter()
            .find(|c| c.kind == VerificationKind::Build)
            .unwrap();
        let test = report.checks.iter().find(|c| c.kind == VerificationKind::Test).unwrap();
        assert_eq!(build.status, VerificationStatus::Passed);
        assert_eq!(test.status, VerificationStatus::SkippedWithReason);
        assert_eq!(
            report.overall,
            Overall::CouldNotRun,
            "돌지 못한 검증이 있는데 통과로 보고했습니다"
        );
    }

    /// 네 값이 **서로 다른 사실**을 말하는지 한 자리에서 고정한다.
    ///
    /// 종전에는 `executed == 0`이 무조건 `not_verified`였고, 그 아래의 "돌지 못한 체크가 있다"
    /// 분기는 통과한 체크가 함께 있을 때만 닿았다. 즉 **정책이 모든 검증을 막은 경우**가
    /// "이 프로젝트에는 명령이 없습니다"로 보고됐다.
    #[test]
    fn the_four_verdicts_say_four_different_things() {
        let check = |kind, status| VerificationCheck {
            kind,
            command: None,
            status,
            summary: String::new(),
            detail: None,
            detail_ref: None,
            exit_code: None,
            duration_ms: None,
        };
        use VerificationKind::{Build, Test};
        use VerificationStatus as S;

        assert_eq!(
            compute_overall(&[check(Test, S::NotConfigured), check(Build, S::NotConfigured)], None),
            Overall::NotConfigured
        );
        // 돌린 것은 없지만 **돌리려다 못 돌린** 체크가 있다 — 명령이 없는 것이 아니다.
        assert_eq!(
            compute_overall(&[check(Test, S::SkippedWithReason), check(Build, S::NotConfigured)], None),
            Overall::CouldNotRun
        );
        assert_eq!(
            compute_overall(&[check(Test, S::Passed), check(Build, S::NotConfigured)], None),
            Overall::Pass
        );
        assert_eq!(
            compute_overall(&[check(Test, S::Failed), check(Build, S::SkippedWithReason)], None),
            Overall::Fail
        );
    }

    #[test]
    fn not_configured_checks_do_not_block_pass() {
        // "돌릴 것이 없었다"와 "돌리지 못했다"는 다르다. lint 스크립트가 없다고 해서
        // 영원히 pass가 불가능해지면 규칙이 쓸모없어진다.
        let (_d, _a, root, artifacts) = setup(&[("package.json", r#"{ "scripts": { "test": "x" } }"#)]);
        let runner = VerificationRunner::new(&root, &artifacts);
        let mut exec = FakeExecutor {
            responses: vec![("npm test".into(), 0, "ok".into())],
            calls: vec![],
        };
        let report = runner.run("task-1", VerificationPhase::Post, 0, &mut exec, None);
        assert!(report
            .checks
            .iter()
            .any(|c| c.status == VerificationStatus::NotConfigured));
        assert_eq!(report.overall, Overall::Pass);
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
                    denial_kind: None,
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
