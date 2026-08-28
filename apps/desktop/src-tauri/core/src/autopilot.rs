//! 무인 실행이 **무엇을 허용하는지 미리 말한다** — state-machine-and-protocol.md 47절.
//!
//! # `blocked`의 반대 방향이다
//!
//! 24.8절의 `blocked`는 **지나간** 실행을 읽는다: 무엇이 막았고 무엇을 켜면 지나가는가.
//! 그 보고서가 스스로 적어 둔 한계가 이 모듈이 있는 이유다 —
//!
//! > 플래그를 켜고 다시 돌리면 이번에 도달하지 못한 **새 지점에서 또 멈출 수 있다.**
//!
//! 그건 사후에만 알 수 있는 사실이 아니다. **게이트에 미리 물으면 된다.**
//!
//! # 왜 산문이 아니라 판정인가
//!
//! 24.7절의 미해결 항목은 이렇게 적혀 있었다: *"두 스위치가 함께 켜졌을 때 무엇이 허용되는지는
//! 지금 usage 텍스트에 흩어져 있다."* 흩어진 산문을 한 곳에 모으는 것으로는 부족하다 —
//! 모아 놓은 산문은 **게이트가 바뀌면 조용히 거짓이 된다.** 화면에도 이미 그 조각이 하나
//! 있었다("이 상태의 무인 실행은 검증에서 멈춥니다"): 여러 정지 중 **하나만** 손으로 적은 문장이다.
//!
//! 그래서 여기서는 설명하지 않고 **물어본다.** 도구마다 대표 요청을 만들어 실제 승인 경로에
//! 태우고, 그 답을 그대로 보고한다. 게이트 규칙이 바뀌면 이 보고서도 함께 바뀐다.
//!
//! # 이 미리보기가 말하지 **못하는** 것
//!
//! **대표 요청에 대한 답이지 모든 요청에 대한 답이 아니다.** 같은 도구라도 대상에 따라 판정이
//! 갈리므로(`.env`에 쓰는 것과 소스 파일에 쓰는 것은 다르다), 갈리는 자리는 **탐침을 둘 두어
//! 둘 다 보고한다.** 그래도 우리가 생각하지 못한 세 번째 모양은 여기 없다.
//!
//! **모델이 무엇을 요청할지는 모른다.** 이 목록은 "요청되면 어떻게 되는가"이지 "무엇이
//! 요청되는가"가 아니다. 그 둘을 뭉개면 화면이 "이 태스크는 파일을 지웁니다"로 읽힌다.

use crate::hooks::HookRegistry;
use crate::host::{Fate, TaskProfile};
use crate::paths::WorkspaceRoot;
use crate::types::{Decision, PolicyLever, ToolName, ToolRequest};
use serde::Serialize;
use serde_json::{json, Value};

/// 게이트에 물어볼 대표 요청 하나.
pub struct Probe {
    pub tool: ToolName,
    /// 사람이 읽는 라벨. **무엇을 물었는지**가 답보다 먼저 보여야 한다.
    pub label: &'static str,
    /// **값이지 클로저가 아니다**(64절). 등록된 MCP 서버 이름처럼 목록을 만드는 시점에만
    /// 아는 값이 인자에 들어가므로, `fn() -> Value`로는 담을 수 없다.
    pub args: Value,
}

/// 탐침 하나에 대한 답.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Permission {
    pub tool: String,
    pub probe: &'static str,
    pub decision: Decision,
    #[serde(rename = "matchedRule")]
    pub matched_rule: String,
    /// 무인 실행에서 이 요청이 맞이하는 결말. 게이트가 아니라 **승인 경로**가 정한다 —
    /// 사전 승인(검증 명령·등록된 훅)이 게이트의 요구를 답할 수 있기 때문이다(24.5·25.3절).
    pub fate: Fate,
    /// 이 정지를 미리 통과시키는 CLI 플래그.
    ///
    /// **켜 보고 실제로 결말이 바뀐 것만 싣는다**(47.6절). 게이트의 `unblockedBy`를 그대로
    /// 옮기면 조언이 틀릴 수 있다 — 그 필드가 말하는 것은 "이 **규칙**을 없애는 레버"이지
    /// "무인으로 지나가게 하는 레버"가 아니다.
    #[serde(rename = "rerunFlag")]
    pub rerun_flag: Option<String>,
    /// 게이트는 이 레버를 지목했지만 **켜도 여전히 멈추는** 경우.
    ///
    /// 지우지 않고 남긴다. 지우면 사용자는 이 정지에 대해 아무 설명도 받지 못하고, 남기면
    /// "그 스위치는 이 자리를 열지 않는다"는 것을 안다.
    #[serde(rename = "leverDoesNotFree", skip_serializing_if = "Option::is_none")]
    pub lever_does_not_free: Option<String>,
}

/// 지금 켜져 있는 스위치 — 보고서를 **어떤 설정에 대한 답인지 모른 채** 읽지 않게 한다.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Switches {
    pub unattended: bool,
    #[serde(rename = "autoApproveWorkspaceWrites")]
    pub auto_approve_workspace_writes: bool,
    #[serde(rename = "autoApproveVerification")]
    pub auto_approve_verification: bool,
    #[serde(rename = "allowGitCommit")]
    pub allow_git_commit: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub switches: Switches,
    /// 사람 없이 그대로 일어나는 것.
    pub proceeds: Vec<Permission>,
    /// 무인이면 여기서 멈추는 것.
    pub stops: Vec<Permission>,
    /// 게이트가 거부하는 것 — 스위치와 무관하다.
    pub denied: Vec<Permission>,
    /// `stops` 중 정책으로 넓힐 수 있는 것들의 플래그 (중복 없음).
    #[serde(rename = "rerunFlags")]
    pub rerun_flags: Vec<String>,
    /// **어떤 스위치로도 지나지 않는** 정지의 라벨. 여기 있는 것은 사람이 있어야 한다.
    #[serde(rename = "humanOnly")]
    pub human_only: Vec<&'static str>,
    /// 한계를 **기계가 읽는 자리에도** 적는다. 모듈 주석은 사람만 읽는다.
    pub caveat: &'static str,
}

const CAVEAT: &str = "이 목록은 도구마다 정한 대표 요청에 대한 답입니다. 같은 도구라도 대상에 따라 판정이 \
                      갈리므로 여기 없는 모양이 있을 수 있고, 무엇이 실제로 요청될지는 모델이 정합니다";

/// 워크스페이스 안의 평범한 소스 파일 하나. **존재하지 않아도 된다** —
/// 쓰기 계열은 `resolve_for_create`로 해석하므로 조상만 있으면 된다.
const ORDINARY: &str = "src/app.ts";
/// 비밀값을 담을 수 있는 이름. 게이트가 이 모양을 다르게 판정한다.
const SECRET: &str = ".env";

/// 대표 요청 목록.
///
/// **이건 손으로 적은 목록이다.** 그래서 `ToolName`에 변형이 늘면 낡을 수 있고, 낡으면 새
/// 도구는 미리보기에서 **그냥 사라진다** — 사용자는 그것을 "무인에서 아무 일도 안 한다"로
/// 읽는다. 그래서 `every_tool_has_a_probe`가 `ALL_TOOLS`에서 유도해 대조한다.
///
/// # 등록을 받는 이유 (64절)
///
/// `mcp_call`은 **등록 여부에 따라 판정이 갈리는 유일한 도구**다: 등록 밖이면 묻지 않고
/// 거부하고(32절), 등록 안이면 언제나 승인을 요구한다(23.3절). 그런데 탐침이
/// `server: "any"` 하나뿐이던 동안 미리보기는 **언제나 전자만** 보고했다 — 서버를 등록해 둔
/// 사용자에게는 틀린 규칙 이름이고, 48.2절이 호스트에 미리보기를 둔 이유(등록된 풀이 거기
/// 있다)가 아무것도 회수하지 못하고 있었다.
///
/// 그래서 `.env`/보통 파일을 둘로 나눈 것과 **같은 처리**를 한다: 갈리는 자리에는 탐침을 둘
/// 둔다. 등록이 없으면 둘째 탐침을 만들 수 없으므로 목록에 넣지 않는다 — 없는 서버 이름을
/// 지어내면 그 탐침은 "등록 밖 거부"가 되어 첫째와 구별되지 않는다.
pub fn probes(registration: Option<crate::mcp::Registration<'_>>) -> Vec<Probe> {
    let mut list = vec![
        Probe { tool: ToolName::ListFiles, label: "파일 목록 보기", args: json!({ "path": "." }) },
        Probe { tool: ToolName::SearchText, label: "본문 검색", args: json!({ "query": "TODO" }) },
        Probe { tool: ToolName::ReadFile, label: "워크스페이스 안의 파일 읽기", args: json!({ "path": "." }) },
        Probe {
            tool: ToolName::ApplyPatch,
            label: "소스 파일 고치기",
            args: json!({ "path": ORDINARY, "patch": "" }),
        },
        Probe {
            tool: ToolName::ApplyPatch,
            label: "비밀값 파일 고치기",
            args: json!({ "path": SECRET, "patch": "" }),
        },
        Probe {
            tool: ToolName::CreateFile,
            label: "새 파일 만들기",
            args: json!({ "path": ORDINARY, "content": "" }),
        },
        // 삭제·이동은 원본이 **있어야** 해석된다(`resolve_existing`). 워크스페이스 루트는
        // 반드시 있으므로 그것을 대상으로 묻는다 — 게이트는 디렉터리 여부를 보지 않고,
        // 여기서 알고 싶은 것은 "삭제라는 종류가 무인에서 어떻게 되는가"다.
        Probe { tool: ToolName::DeleteFile, label: "파일 지우기", args: json!({ "path": "." }) },
        Probe {
            tool: ToolName::MoveFile,
            label: "파일 옮기기",
            args: json!({ "from": ".", "to": ORDINARY }),
        },
        Probe {
            tool: ToolName::RunCommand,
            label: "allowlist에 있는 명령 실행",
            args: json!({ "program": "git", "args": ["status"], "cwd": "." }),
        },
        Probe {
            tool: ToolName::RunCommand,
            label: "allowlist에 없는 명령 실행",
            args: json!({ "program": "curl", "args": ["https://example.com"], "cwd": "." }),
        },
        Probe {
            tool: ToolName::RunCommand,
            label: "git commit 만들기",
            args: json!({ "program": "git", "args": ["commit", "-m", "msg"], "cwd": "." }),
        },
        Probe {
            tool: ToolName::RunTests,
            label: "프로젝트가 선언한 검증 명령 실행",
            args: json!({ "program": "npm", "args": ["test"], "cwd": "." }),
        },
        Probe { tool: ToolName::GitStatus, label: "git 상태 보기", args: json!({}) },
        Probe { tool: ToolName::GitDiff, label: "git diff 보기", args: json!({}) },
        // **등록 밖의 서버를 부르는 쪽.** 등록이 하나도 없어도 이 답은 뜻이 있다 —
        // "MCP는 무인에서 어떻게 되는가"의 답이 여기 있다.
        Probe {
            tool: ToolName::McpCall,
            label: "등록되지 않은 MCP 도구 부르기",
            args: json!({ "server": "not-registered", "tool": "any", "arguments": {} }),
        },
        Probe {
            tool: ToolName::GitPush,
            label: "remote로 push",
            args: json!({ "remote": "origin", "branch": "main" }),
        },
    ];

    // **등록된 서버가 있으면 그쪽도 묻는다**(64절). 결말은 어느 쪽이든 정지이지만 규칙
    // 이름이 다르고, 화면은 규칙 이름을 보여준다 — 서버를 등록해 둔 사용자에게
    // "등록 밖 거부"만 보이면 자기 등록이 무시된 것으로 읽힌다.
    if let Some((server, tool)) = registration.as_ref().and_then(|r| r.probe_call()) {
        list.push(Probe {
            tool: ToolName::McpCall,
            label: "등록된 MCP 도구 부르기",
            args: json!({ "server": server, "tool": tool, "arguments": {} }),
        });
    }
    list
}

/// 정책과 워크스페이스를 받아 **아무것도 쓰지 않고** 보고서를 만든다.
///
/// 저장소를 받지 않는 것이 이 함수의 성질이다: 승인 판정에 저장소가 필요하지 않으므로,
/// 미리보기가 없던 `state.db`를 만들지 않는다(21.1절 재현 러너와 같은 규칙).
pub fn preview(root: &WorkspaceRoot, profile: &TaskProfile, hooks: &HookRegistry) -> Preview {
    let mut proceeds = Vec::new();
    let mut stops = Vec::new();
    let mut denied = Vec::new();

    // **게이트가 아는 등록으로 탐침을 만든다**(64절). 풀 자체가 아니라 읽기 전용 뷰를
    // 받으므로, 이 함수는 서버를 띄울 수 **없다** — 검사가 아니라 타입이 그것을 지킨다.
    for probe in probes(profile.gate().mcp_registration()) {
        let request = ToolRequest {
            request_id: format!("preview-{}", probe.label),
            task_id: "preview".to_string(),
            tool: probe.tool,
            args: probe.args.clone(),
            risk_tier: None,
            requested_by: json!({ "role": "preview" }),
            created_at: None,
            injected_env: Default::default(),
        };
        let decision = profile.gate().evaluate(&request, root, &profile.policy);
        let fate = crate::host::fate_of(root, profile, hooks, &request, &decision);

        // **조언을 검증한다.** 레버를 실제로 켜고 같은 요청을 다시 태워, 결말이 정지에서
        // 벗어나는지 본다. 벗어나지 않으면 그 플래그는 이 자리에 대한 답이 아니다.
        let (rerun_flag, lever_does_not_free) = match fate.lever() {
            Some(lever) => match lever.rerun_flag() {
                None => (None, None),
                Some(flag) => {
                    if frees(root, profile, hooks, &request, lever) {
                        (Some(flag.to_string()), None)
                    } else {
                        (None, Some(flag.to_string()))
                    }
                }
            },
            None => (None, None),
        };

        let permission = Permission {
            tool: probe.tool.as_str().to_string(),
            probe: probe.label,
            decision: decision.decision,
            matched_rule: decision.matched_rule.clone(),
            fate,
            rerun_flag,
            lever_does_not_free,
        };
        match permission.fate {
            Fate::Denied => denied.push(permission),
            Fate::UnattendedStop { .. } | Fate::AsksUser { .. } => stops.push(permission),
            Fate::NotRequired | Fate::PreApproved { .. } => proceeds.push(permission),
        }
    }

    let mut rerun_flags: Vec<String> = Vec::new();
    for flag in stops.iter().filter_map(|s| s.rerun_flag.clone()) {
        if !rerun_flags.contains(&flag) {
            rerun_flags.push(flag);
        }
    }
    let human_only: Vec<&'static str> = stops
        .iter()
        .filter(|s| s.fate.lever() == Some(PolicyLever::HumanOnly))
        .map(|s| s.probe)
        .collect();

    Preview {
        switches: Switches {
            unattended: profile.policy.unattended,
            auto_approve_workspace_writes: profile.policy.auto_approve_workspace_writes,
            auto_approve_verification: profile.policy.auto_approve_verification,
            allow_git_commit: profile.policy.allow_git_commit,
        },
        proceeds,
        stops,
        denied,
        rerun_flags,
        human_only,
        caveat: CAVEAT,
    }
}

/// 이 레버를 켜면 이 요청이 무인에서 **지나가는가**.
///
/// 켜 보고 다시 판정한다 — 규칙 표를 읽고 추론하지 않는다. 새 프로필을 만드는 것은 검증
/// 명령 고정이 정책에 딸려 있기 때문이다(`auto_approve_verification`은 그 고정이 있어야 뜻이 있다).
fn frees(
    root: &WorkspaceRoot,
    profile: &TaskProfile,
    hooks: &HookRegistry,
    request: &ToolRequest,
    lever: PolicyLever,
) -> bool {
    let mut widened = profile.policy.clone();
    lever.apply_to(&mut widened);
    let widened_profile = TaskProfile::new(root, widened);
    let decision = widened_profile
        .gate()
        .evaluate(request, root, &widened_profile.policy);
    let fate = crate::host::fate_of(root, &widened_profile, hooks, request, &decision);
    !matches!(fate, Fate::UnattendedStop { .. } | Fate::AsksUser { .. } | Fate::Denied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TaskPolicy;

    /// 검증 명령을 **선언해 둔** 워크스페이스.
    ///
    /// 매니페스트가 없으면 `verification_pin`이 비고, 그러면 `--auto-approve-verification`은
    /// 미리보기에 아예 나타나지 않는다 — 그게 옳은 동작이다(선언하지 않은 프로젝트에서 그
    /// 스위치는 아무것도 하지 않는다). 그 사실을 아래에서 따로 검사한다.
    fn workspace_with_manifest() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"node -e 0"}}"#).unwrap();
        dir
    }

    fn root(dir: &std::path::Path) -> WorkspaceRoot {
        WorkspaceRoot::new(dir).expect("root")
    }

    fn profile(dir: &std::path::Path, policy: TaskPolicy) -> TaskProfile {
        TaskProfile::new(&root(dir), policy)
    }

    /// **목록을 두 번 적는 대신 두 번째가 첫 번째에서 나오게 한다.**
    ///
    /// 탐침이 없는 도구는 미리보기에서 **그냥 사라지고**, 사용자는 그 침묵을 "무인에서 아무
    /// 일도 안 한다"로 읽는다. 빠진 것이 드러나지 않는 종류의 누락이다.
    #[test]
    fn every_tool_has_a_probe() {
        use crate::skills::ALL_TOOLS;
        let probed: Vec<ToolName> = probes(None).iter().map(|p| p.tool).collect();
        let missing: Vec<&str> = ALL_TOOLS
            .iter()
            .filter(|t| !probed.contains(t))
            .map(|t| t.as_str())
            .collect();
        assert!(missing.is_empty(), "탐침이 없는 도구: {missing:?}");
    }

    #[test]
    fn unattended_preview_reports_every_probe_exactly_once() {
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let prof = profile(dir.path(), policy);
        let p = preview(&root(dir.path()), &prof, &HookRegistry::default());
        let total = p.proceeds.len() + p.stops.len() + p.denied.len();
        // **같은 등록으로 센다**(64절). `probes(None)`으로 세면 풀이 붙은 프로필에서 이 검사가
        // 조용히 틀려진다 — 늘어난 탐침 하나가 "어느 칸에도 없다"로 읽힌다.
        let expected = probes(prof.gate().mcp_registration()).len();
        assert_eq!(total, expected, "탐침 하나가 어느 칸에도 없거나 두 칸에 있습니다");
    }

    /// **스위치를 켜면 실제로 달라진다.** 달라지지 않으면 우리가 광고한 플래그가 거짓이다.
    #[test]
    fn the_write_switch_moves_source_writes_from_stops_to_proceeds() {
        let dir = workspace_with_manifest();
        let hooks = HookRegistry::default();
        let off = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let on = TaskPolicy { unattended: true, auto_approve_workspace_writes: true, ..TaskPolicy::default() };

        let before = preview(&root(dir.path()), &profile(dir.path(), off), &hooks);
        let after = preview(&root(dir.path()), &profile(dir.path(), on), &hooks);

        assert!(before.stops.iter().any(|s| s.probe == "소스 파일 고치기"));
        assert!(after.proceeds.iter().any(|s| s.probe == "소스 파일 고치기"));
        // **비밀값 파일은 따라오지 않는다** — 그 스위치가 승인한 것이 아니다.
        assert!(after.stops.iter().any(|s| s.probe == "비밀값 파일 고치기"));
    }

    /// 넓힐 수 없는 정지는 **플래그를 지어내지 않는다.**
    #[test]
    fn human_only_stops_have_no_rerun_flag() {
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let p = preview(&root(dir.path()), &profile(dir.path(), policy), &HookRegistry::default());
        for stop in p.stops.iter().filter(|s| s.fate.lever() == Some(PolicyLever::HumanOnly)) {
            assert_eq!(stop.rerun_flag, None, "{}에 없는 플래그를 붙였습니다", stop.probe);
        }
        assert!(!p.human_only.is_empty(), "사람만 지날 수 있는 정지가 하나도 없습니다");
    }

    fn pool(name: &str, tools: Option<Vec<String>>) -> std::sync::Arc<crate::mcp::McpPool> {
        std::sync::Arc::new(
            crate::mcp::McpPool::new(vec![crate::mcp::McpServerConfig {
                name: name.to_string(),
                program: "node".to_string(),
                args: vec!["server.js".to_string()],
                env: Default::default(),
                tools,
            }])
            .unwrap(),
        )
    }

    /// **등록된 서버를 부르는 쪽도 묻는다** — 64절.
    ///
    /// 탐침이 `server: "any"` 하나뿐이던 동안 미리보기는 **언제나 "등록 밖 거부"** 를
    /// 보고했다. 풀이 붙어 있어도 그랬다 — 묻는 서버 이름이 등록에 없었기 때문이다.
    /// 그래서 48.2절이 미리보기를 호스트에 둔 이유("등록된 풀이 거기 있다")가 아무것도
    /// 회수하지 못하고 있었다: 옮겨도 답이 같았다.
    ///
    /// 두 답이 **동시에** 나와야 한다. 등록 밖 호출이 거부된다는 사실(32절)과 등록된
    /// 호출도 사람을 요구한다는 사실(23.3절)은 사용자가 다음에 할 일이 서로 다르다.
    #[test]
    fn a_registered_server_gets_its_own_probe_with_a_different_rule() {
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let profile = TaskProfile::with_mcp(&root(dir.path()), policy, Some(pool("notes", None)));
        let p = preview(&root(dir.path()), &profile, &HookRegistry::default());

        let all: Vec<&Permission> = p.stops.iter().chain(p.denied.iter()).collect();
        let outside = all
            .iter()
            .find(|x| x.probe == "등록되지 않은 MCP 도구 부르기")
            .expect("등록 밖 탐침이 없습니다");
        let inside = all
            .iter()
            .find(|x| x.probe == "등록된 MCP 도구 부르기")
            .expect("등록된 탐침이 없습니다 — 풀을 붙였는데 목록이 그대로입니다");

        // **규칙 이름이 갈린다.** 갈리지 않으면 탐침을 둘 둔 뜻이 없다.
        assert_ne!(outside.matched_rule, inside.matched_rule, "{outside:?} / {inside:?}");
        assert_eq!(inside.matched_rule, "mcp_always_requires_approval", "{inside:?}");
        assert_eq!(inside.decision, Decision::RequireUserApproval, "{inside:?}");
        assert_eq!(outside.decision, Decision::Deny, "{outside:?}");

        // 그리고 **둘 다 사람 없이 지나가지 않는다**(23.3절).
        assert!(!p.proceeds.iter().any(|x| x.tool == "mcp_call"), "{:?}", p.proceeds);
    }

    /// **등록이 없으면 둘째 탐침을 지어내지 않는다** — 64절.
    ///
    /// 없는 서버 이름으로 만들면 그 탐침은 "등록 밖 거부"가 되어 첫째와 구별되지 않는다.
    /// 같은 답을 두 줄로 보여주는 것은 정보가 아니라 잡음이고, 사용자는 등록이 있는 줄 안다.
    #[test]
    fn without_a_registration_there_is_only_the_outside_probe() {
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let p = preview(&root(dir.path()), &profile(dir.path(), policy), &HookRegistry::default());
        let mcp: Vec<&str> = p
            .stops
            .iter()
            .chain(p.denied.iter())
            .filter(|x| x.tool == "mcp_call")
            .map(|x| x.probe)
            .collect();
        assert_eq!(mcp, vec!["등록되지 않은 MCP 도구 부르기"], "{mcp:?}");
    }

    /// **도구 허용목록 안에서 고른다** — 64절.
    ///
    /// 목록 밖 이름으로 물으면 게이트가 `ToolNotAllowed`로 거부하고, 그러면 이 탐침은
    /// 등록되지 않은 경우와 같은 답을 낸다 — 즉 등록을 반영한 것이 아니게 된다.
    #[test]
    fn the_registered_probe_stays_inside_the_tool_allowlist() {
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let profile = TaskProfile::with_mcp(
            &root(dir.path()),
            policy,
            Some(pool("notes", Some(vec!["append".to_string()]))),
        );
        let p = preview(&root(dir.path()), &profile, &HookRegistry::default());
        let inside = p
            .stops
            .iter()
            .find(|x| x.probe == "등록된 MCP 도구 부르기")
            .expect("등록된 탐침이 정지 목록에 없습니다");
        assert_eq!(inside.matched_rule, "mcp_always_requires_approval", "{inside:?}");
        assert!(
            p.denied.iter().all(|x| x.probe != "등록된 MCP 도구 부르기"),
            "허용목록 밖 이름으로 물어 거부됐습니다: {:?}",
            p.denied
        );
        // **대조군**: 같은 서버의 허용목록 밖 이름은 거부된다. 이것이 없으면 위 단언은
        // "게이트가 허용목록을 아예 안 본다"일 때도 통과한다.
        let outside_the_allowlist = profile.gate().evaluate(
            &ToolRequest {
                request_id: "x".to_string(),
                task_id: "preview".to_string(),
                tool: ToolName::McpCall,
                args: json!({ "server": "notes", "tool": "delete", "arguments": {} }),
                risk_tier: None,
                requested_by: json!({}),
                created_at: None,
                injected_env: Default::default(),
            },
            &root(dir.path()),
            &profile.policy,
        );
        assert_eq!(outside_the_allowlist.decision, Decision::Deny, "{outside_the_allowlist:?}");
    }

    /// **MCP 도구는 어떤 설정으로도 무인으로 실행되지 않는다**(23.3절).
    ///
    /// 등록 여부에 따라 규칙 이름은 갈린다(등록 밖이면 거부, 등록 안이면 언제나 승인). 그런데
    /// **무인에서의 결말은 갈리지 않는다** — 어느 쪽도 사람 없이 진행되지 않는다. 여기서는
    /// 풀을 붙이지 않은 쪽을 재고, 붙인 쪽은 `fate_of`의 성질로 확인한다: 승인을 요구하는
    /// `HumanOnly` 판정은 무인에서 언제나 정지다.
    #[test]
    fn mcp_never_proceeds_unattended() {
        use crate::host::fate_of;
        use crate::types::{PolicyDecision, RiskLevel};

        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let p = preview(&root(dir.path()), &profile(dir.path(), policy.clone()), &HookRegistry::default());
        assert!(!p.proceeds.iter().any(|x| x.tool == "mcp_call"), "{:?}", p.proceeds);

        // 등록이 있는 쪽: 게이트가 "언제나 승인 + HumanOnly"를 내는 상황을 그대로 태운다.
        let prof = profile(dir.path(), policy);
        let request = ToolRequest {
            request_id: "x".to_string(),
            task_id: "preview".to_string(),
            tool: ToolName::McpCall,
            args: json!({ "server": "s", "tool": "t", "arguments": {} }),
            risk_tier: None,
            requested_by: json!({}),
            created_at: None,
            injected_env: Default::default(),
        };
        let registered = PolicyDecision {
            request_id: "x".to_string(),
            decision: Decision::RequireUserApproval,
            risk_level: RiskLevel::High,
            matched_rule: "mcp_always_requires_approval".to_string(),
            reason: String::new(),
            requires_user_approval: true,
            normalized_target: "s/t".to_string(),
            unblocked_by: PolicyLever::HumanOnly,
            redraftable: false,
            decided_at: String::new(),
        };
        let fate = fate_of(&root(dir.path()), &prof, &HookRegistry::default(), &request, &registered);
        assert!(matches!(fate, Fate::UnattendedStop { lever: PolicyLever::HumanOnly, .. }), "{fate:?}");
    }

    /// **켤 수 있는 스위치는 전부 미리보기에 나타난다.**
    ///
    /// 탐침 목록이 도구를 다 덮어도 **레버를 다 덮지는 못한다** — `git commit`은 `run_command`
    /// 하나로 묶여 있어서, 도구 기준 검사는 통과하면서 `--allow-git-commit`은 미리보기에서
    /// 통째로 빠져 있었다(실측). 그 누락은 침묵이라 드러나지 않는다: 사용자는 그 스위치가
    /// 자기 실행과 무관하다고 읽는다.
    ///
    /// 판정 기준은 `PolicyLever` 자신이다 — 플래그를 가진 변형이 늘면 여기가 실패한다.
    #[test]
    fn every_lever_with_a_flag_shows_up_somewhere() {
        use crate::types::PolicyLever::*;
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let p = preview(&root(dir.path()), &profile(dir.path(), policy), &HookRegistry::default());

        // **"권한다"가 아니라 "다뤄진다"를 본다.** 켜도 지나가지 않는 레버는 권하지 않지만
        // (`--allow-git-commit`), 그렇다고 없는 것처럼 굴어서도 안 된다 — 그 사실이
        // `leverDoesNotFree`로 남아 있어야 한다.
        let mentioned = |flag: &str| {
            p.rerun_flags.iter().any(|f| f == flag)
                || p.stops.iter().any(|s| s.lever_does_not_free.as_deref() == Some(flag))
        };
        let missing: Vec<&str> = [NotApplicable, AutoApproveWorkspaceWrites, AllowGitCommit, AutoApproveVerification, HumanOnly]
            .into_iter()
            .filter_map(PolicyLever::rerun_flag)
            .filter(|flag| !mentioned(flag))
            .collect();
        assert!(missing.is_empty(), "미리보기가 아예 다루지 않는 스위치: {missing:?}");
    }

    /// **`leverDoesNotFree`와 "사람만 지날 수 있음"은 겹치지 않는다** (48절).
    ///
    /// 화면은 이 둘에 다른 문장을 붙이므로 겹치면 어느 쪽을 먼저 보느냐가 답을 바꾼다.
    /// 겹칠 수 없는 이유는 구성에 있다 — `leverDoesNotFree`는 **플래그가 있는 레버**에만
    /// 붙고 `HumanOnly`에는 플래그가 없다. 그런데 그건 두 함수에 흩어진 사실이라, 한쪽이
    /// 바뀌면 조용히 겹치기 시작한다. 여기서 고정한다.
    ///
    /// 프로브가 이 검사를 요구했다: 화면 쪽에서 두 분기의 순서를 바꿔 봐도 **아무 검사도
    /// 실패하지 않았다.** 순서에 의미가 있다고 적어 둔 주석이 실제로는 아무것도 지키지
    /// 않고 있었다는 뜻이다.
    #[test]
    fn a_stop_is_never_both_human_only_and_lever_does_not_free() {
        let dir = workspace_with_manifest();
        let hooks = HookRegistry::default();
        let mut seen_lever_does_not_free = false;

        // 스위치 조합을 돌면서 본다 — 한 설정에서만 확인하면 다른 조합의 겹침을 놓친다.
        for writes in [false, true] {
            for commit in [false, true] {
                for verification in [false, true] {
                    let policy = TaskPolicy {
                        unattended: true,
                        auto_approve_workspace_writes: writes,
                        allow_git_commit: commit,
                        auto_approve_verification: verification,
                        ..TaskPolicy::default()
                    };
                    let p = preview(&root(dir.path()), &profile(dir.path(), policy), &hooks);
                    for stop in &p.stops {
                        if stop.lever_does_not_free.is_some() {
                            seen_lever_does_not_free = true;
                            assert_ne!(
                                stop.fate.lever(),
                                Some(PolicyLever::HumanOnly),
                                "{}이 두 갈래에 동시에 들어갑니다",
                                stop.probe
                            );
                        }
                    }
                }
            }
        }
        // **빈 집합에 대한 전칭 명제는 언제나 참이다.**
        assert!(seen_lever_does_not_free, "`leverDoesNotFree`가 붙은 정지가 하나도 없습니다");
    }

    /// **이 스위치가 넓히는 것은 되돌릴 수 있는 쓰기뿐이다** (63절).
    ///
    /// `--auto-approve-writes`를 화면에 올리기로 한 결정의 근거가 이것이다. 근거를 산문으로
    /// 적어 두면 게이트가 바뀔 때 조용히 거짓이 되므로, **게이트에 물어서 세운다.**
    ///
    /// # 재는 것은 절대량이 아니라 **차이**다
    ///
    /// 처음에는 "무인에서 사람 없이 지나가는 것은 전부 되돌릴 수 있는 것"으로 적었는데
    /// 그건 틀린 명제였다 — 스위치를 다 끈 기본 설정에서도 `git status`가 지나간다
    /// (allowlist의 `auto` 규칙이고, 그건 **워크스페이스 정책**이 넓혀 둔 것이지 이 스위치가
    /// 아니다). 절대량으로 재면 남의 결정을 이 스위치의 책임으로 세게 되고, 그 검사는
    /// 언젠가 무관한 이유로 실패해 약해진다.
    ///
    /// 그래서 **같은 설정에서 이 스위치만 켜 보고 늘어난 것**을 본다. 늘어난 것이
    /// `create_file`/`apply_patch`뿐이면 이 스위치가 넓힌 자리는 전부 `capture_pre_image`가
    /// 이전 내용을 남기는 자리다(19절) — 되돌리기가 복원할 수 있다.
    #[test]
    fn the_write_switch_widens_nothing_but_undoable_writes() {
        let dir = workspace_with_manifest();
        let hooks = HookRegistry::default();
        // **pre-image가 남는 쓰기 도구.** 이 목록이 늘면 `tools/mod.rs`의 `capture_pre_image`
        // 호출도 함께 늘어야 한다 — 늘리지 않으면 되돌릴 수 없는 것이 여기 통과한다.
        let undoable_writes = [ToolName::CreateFile.as_str(), ToolName::ApplyPatch.as_str()];
        let mut total_newly_allowed = 0;

        for commit in [false, true] {
            for verification in [false, true] {
                let base = TaskPolicy {
                    unattended: true,
                    allow_git_commit: commit,
                    auto_approve_verification: verification,
                    ..TaskPolicy::default()
                };
                let with_writes = TaskPolicy { auto_approve_workspace_writes: true, ..base.clone() };
                let before = preview(&root(dir.path()), &profile(dir.path(), base), &hooks);
                let after = preview(&root(dir.path()), &profile(dir.path(), with_writes), &hooks);

                let was: Vec<&str> = before.proceeds.iter().map(|p| p.probe).collect();
                for done in after.proceeds.iter().filter(|p| !was.contains(&p.probe)) {
                    total_newly_allowed += 1;
                    assert!(
                        undoable_writes.contains(&done.tool.as_str()),
                        "이 스위치가 되돌릴 수 없는 자리를 열었습니다: {} ({}) — commit={commit} verification={verification}",
                        done.probe,
                        done.tool
                    );
                }
                // **켜서 좁아지는 일은 없어야 한다.** 좁아졌다면 위 차집합이 그 사실을
                // 놓치므로, 반대 방향도 함께 본다.
                let now: Vec<&str> = after.proceeds.iter().map(|p| p.probe).collect();
                let lost: Vec<&str> = was.iter().copied().filter(|p| !now.contains(p)).collect();
                assert!(lost.is_empty(), "스위치를 켰는데 지나가던 것이 막혔습니다: {lost:?}");
            }
        }
        // **빈 집합에 대한 전칭 명제는 언제나 참이다.** 늘어난 것이 하나도 없다면 위 반복은
        // 아무것도 검사하지 않았고, 그건 이 스위치가 아무 일도 하지 않는다는 뜻이기도 하다.
        assert!(
            total_newly_allowed > 0,
            "이 스위치를 켜도 새로 지나가는 것이 없습니다 — 위 단언이 공허합니다"
        );
    }

    /// **되돌리기가 비싸지는 자리는 어떤 조합으로도 사람 없이 지나가지 않는다** (63절).
    ///
    /// 48.6절은 쓰기 자동 승인의 조건을 *"`git commit`이 꺼져 있어야 되돌리기가 싸다"* 로
    /// 적고 **두 스위치의 조합이 결정의 대상**이라고 했다. 그런데 그 조건은 화면이 지킬
    /// 것이 아니라 **게이트가 이미 지키고 있었다** — 47.6절이 찾아 둔 사실이 그것이다:
    /// `--allow-git-commit`을 켜도 `git commit`은 무인에서 여전히 멈춘다.
    ///
    /// 그래서 화면에 두 스위치를 묶는 규칙을 만들지 않았다. 만들면 게이트가 가진 규칙의
    /// **두 번째 사본**이 되고, 두 벌은 갈라진다(47절이 미리보기를 만든 이유와 같다).
    /// 대신 그 사실을 여기서 고정한다.
    #[test]
    fn a_commit_never_proceeds_unattended_under_any_switch_combination() {
        let dir = workspace_with_manifest();
        let hooks = HookRegistry::default();
        const COMMIT: &str = "git commit 만들기";
        let mut seen = 0;

        for writes in [false, true] {
            for commit in [false, true] {
                for verification in [false, true] {
                    let policy = TaskPolicy {
                        unattended: true,
                        auto_approve_workspace_writes: writes,
                        allow_git_commit: commit,
                        auto_approve_verification: verification,
                        ..TaskPolicy::default()
                    };
                    let p = preview(&root(dir.path()), &profile(dir.path(), policy), &hooks);
                    assert!(
                        !p.proceeds.iter().any(|x| x.probe == COMMIT),
                        "writes={writes} commit={commit} verification={verification}에서 커밋이 사람 없이 지나갑니다"
                    );
                    // 탐침이 사라지면 위 단언은 공허해진다 — 어느 칸엔가는 있어야 한다.
                    assert!(
                        p.stops.iter().chain(p.denied.iter()).any(|x| x.probe == COMMIT),
                        "커밋 탐침이 어느 칸에도 없습니다"
                    );
                    seen += 1;
                }
            }
        }
        assert_eq!(seen, 8, "조합을 다 돌지 않았습니다");
    }

    /// **틀린 조언을 하나 찾았고, 그것을 지우지 않고 사실로 남긴다** (47.6절).
    ///
    /// 게이트는 `git commit` 정지의 `unblockedBy`를 `AllowGitCommit`이라고 말한다. 그런데 그
    /// 스위치를 켜면 규칙만 `allow:git commit **`으로 바뀌고 **여전히 승인이 필요하다** —
    /// 무인 실행은 같은 자리에서 또 멈춘다. `unblockedBy`가 말하는 것은 "이 **규칙**을 없애는
    /// 레버"이지 "무인으로 지나가게 하는 레버"가 아니었다.
    ///
    /// 그래서 미리보기는 플래그를 **켜 보고** 결말이 바뀐 것만 싣고, 바뀌지 않은 것은
    /// `leverDoesNotFree`로 남긴다.
    #[test]
    fn a_lever_that_does_not_actually_free_the_stop_is_not_advertised_as_one() {
        let dir = workspace_with_manifest();
        let policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let p = preview(&root(dir.path()), &profile(dir.path(), policy), &HookRegistry::default());

        let commit = p
            .stops
            .iter()
            .find(|s| s.probe == "git commit 만들기")
            .expect("git commit 탐침이 정지 목록에 없습니다");
        assert_eq!(commit.rerun_flag, None, "켜도 지나가지 않는 플래그를 조언했습니다");
        assert_eq!(commit.lever_does_not_free.as_deref(), Some("--allow-git-commit"));
        assert!(!p.rerun_flags.iter().any(|f| f == "--allow-git-commit"));
    }

    /// **광고한 플래그는 켜면 실제로 멈추는 곳이 준다.** 이제 구성상 참이지만, 검사가 없으면
    /// `frees`가 언제나 true를 내도록 망가져도 드러나지 않는다.
    #[test]
    fn every_advertised_flag_actually_moves_something() {
        let dir = workspace_with_manifest();
        let hooks = HookRegistry::default();
        let base = TaskPolicy { unattended: true, ..TaskPolicy::default() };
        let before = preview(&root(dir.path()), &profile(dir.path(), base), &hooks);
        assert!(!before.rerun_flags.is_empty(), "넓힐 수 있는 정지가 하나도 없습니다");

        for flag in &before.rerun_flags {
            let mut policy = TaskPolicy { unattended: true, ..TaskPolicy::default() };
            match flag.as_str() {
                "--auto-approve-writes" => policy.auto_approve_workspace_writes = true,
                "--allow-git-commit" => policy.allow_git_commit = true,
                "--auto-approve-verification" => policy.auto_approve_verification = true,
                other => panic!("모르는 플래그를 광고하고 있습니다: {other}"),
            }
            let after = preview(&root(dir.path()), &profile(dir.path(), policy), &hooks);
            assert!(
                after.stops.len() < before.stops.len(),
                "{flag}를 켜도 멈추는 곳이 줄지 않습니다"
            );
        }
    }

    /// **선언하지 않은 프로젝트에서는 그 스위치가 나타나지 않는다.**
    ///
    /// `--auto-approve-verification`이 통과시키는 것은 "프로젝트가 매니페스트에 선언해 둔"
    /// 명령뿐이다(24.5절). 선언이 없으면 켤 이유가 없고, 미리보기가 그것을 권하면 사용자는
    /// 아무 효과 없는 스위치를 켠다.
    #[test]
    fn the_verification_switch_only_appears_when_the_project_declares_one() {
        let hooks = HookRegistry::default();
        let policy = || TaskPolicy { unattended: true, ..TaskPolicy::default() };

        let bare = tempfile::tempdir().unwrap();
        let without = preview(&root(bare.path()), &profile(bare.path(), policy()), &hooks);
        assert!(!without.rerun_flags.iter().any(|f| f == "--auto-approve-verification"));

        let declared = workspace_with_manifest();
        let with = preview(&root(declared.path()), &profile(declared.path(), policy()), &hooks);
        assert!(
            with.rerun_flags.iter().any(|f| f == "--auto-approve-verification"),
            "{:?}",
            with.rerun_flags
        );
    }
}
