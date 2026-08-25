//! 워크스페이스 설정 — **훅과 MCP 서버 등록** (state-machine 29절).
//!
//! 23.10절과 25.7절이 각각 "설정 파일이 생기면 그때 넓힌다"고 미뤄 둔 자리다. 둘을 같은 파일에
//! 두는 이유는 **수명이 같기 때문**이다: 태스크가 아니라 워크스페이스의 설정이고, 앱을 다시
//! 켜도 남아야 한다(ui-wireframes 3.16.2절).
//!
//! # 이 파일은 워크스페이스 **밖**에 있다
//!
//! 이게 이 기능의 보안 핵심이다.
//!
//! 자연스러운 자리는 `<workspace>/.tomverse/settings.json`이다 — 팀이 공유하고 이력에 남는다.
//! 그런데 **Policy Gate가 파일 쓰기를 워크스페이스 안으로 가두므로, 워크스페이스 안의 파일은
//! 모델이 쓸 수 있는 파일이다.** 거기에 등록을 두면 모델이 MCP 서버나 훅을 스스로 등록할 수
//! 있고, 그 순간 23.5절의 안전 모델 전부("등록은 사용자만 한다")가 무너진다.
//!
//! MCP 서버 하나는 곧 임의의 프로그램이다(23.1절). 훅도 마찬가지다. 그래서 등록은 상태
//! 디렉터리에 둔다 — 게이트가 그 경로에 대한 쓰기를 애초에 허용하지 않는다.
//!
//! 잃는 것도 적어 둔다: **팀이 공유하지 못하고 이력에도 남지 않는다.** 공유하려면 워크스페이스
//! 안의 파일을 *읽어서 제안*하고 사용자가 승인하는 경로가 필요한데, 그건 별개의 기능이다.
//!
//! # 읽고 쓰는 것은 Rust다
//!
//! 화면이 이 파일을 직접 다루면 등록의 출처가 화면이 된다(원칙 3). 화면은 값을 보여주고
//! 사용자의 편집을 넘길 뿐이고, 검증과 저장은 여기서 한다.

use crate::hooks::{validate_hooks, HookConfig};
use crate::mcp::{validate_servers, McpServerConfig};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 한 워크스페이스의 등록 설정.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceSettings {
    #[serde(default)]
    pub hooks: Vec<StoredHook>,
    #[serde(default)]
    pub servers: Vec<StoredServer>,
}

/// 훅 하나. `HookConfig`와 따로 두는 이유는 **저장 형식이 내부 타입과 함께 움직이면 안 되기
/// 때문**이다 — 내부 타입이 바뀔 때마다 사용자의 저장 파일이 깨지면 안 된다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredHook {
    pub phase: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredServer {
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 이 서버에서 부를 수 있는 도구를 좁힌다 (32절). 없으면 서버가 내놓는 전부다.
    ///
    /// **`null`과 `[]`가 다르다.** 전자는 "좁히지 않는다"이고 후자는 오류다 — 아무것도
    /// 부를 수 없는 서버를 등록하는 것은 등록하지 않는 것과 같은데 화면에는 등록된 것으로 보인다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("설정을 읽을 수 없습니다: {0}")]
    Unreadable(String),
    #[error("설정 파일이 JSON이 아닙니다: {0}")]
    Malformed(String),
    #[error("설정을 저장할 수 없습니다: {0}")]
    Unwritable(String),
    #[error("{0}")]
    Invalid(String),
}

/// 이 워크스페이스의 설정 파일 경로.
///
/// **워크스페이스 경로가 아니라 id로 이름을 짓는다.** 경로를 파일명에 쓰면 구분자·대소문자·
/// 길이 제한에 걸리고, 사용자가 폴더를 옮기면 설정이 사라진 것처럼 보인다.
pub fn settings_path(state_dir: &Path, workspace_id: &str) -> PathBuf {
    state_dir.join("workspaces").join(format!("{workspace_id}.json"))
}

/// 저장된 설정을 읽는다. **파일이 없으면 빈 설정이다** — 그건 오류가 아니다.
pub fn load(state_dir: &Path, workspace_id: &str) -> Result<WorkspaceSettings, SettingsError> {
    let path = settings_path(state_dir, workspace_id);
    if !path.exists() {
        return Ok(WorkspaceSettings::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| SettingsError::Unreadable(e.to_string()))?;
    serde_json::from_str(&text).map_err(|e| SettingsError::Malformed(e.to_string()))
}

/// 검증하고 저장한다.
///
/// **검증을 저장 앞에 둔다.** 뒤에 두면 잘못된 설정이 파일에 남고, 다음에 앱을 켤 때
/// 워크스페이스가 열리지 않는다 — 사용자가 그 파일을 손으로 고쳐야 빠져나온다.
pub fn save(state_dir: &Path, workspace_id: &str, settings: &WorkspaceSettings) -> Result<(), SettingsError> {
    let (hooks, servers) = to_configs(settings)?;
    validate_hooks(&hooks).map_err(|e| SettingsError::Invalid(e.to_string()))?;
    validate_servers(&servers).map_err(|e| SettingsError::Invalid(e.to_string()))?;

    let path = settings_path(state_dir, workspace_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| SettingsError::Unwritable(e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| SettingsError::Unwritable(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| SettingsError::Unwritable(e.to_string()))
}

/// 저장 형식 → 내부 타입. **검증은 여기서 하지 않는다** — 부르는 쪽이 검증한다.
pub fn to_configs(settings: &WorkspaceSettings) -> Result<(Vec<HookConfig>, Vec<McpServerConfig>), SettingsError> {
    let hooks = settings
        .hooks
        .iter()
        .map(|h| HookConfig {
            phase: h.phase.trim().to_string(),
            program: h.program.trim().to_string(),
            args: h.args.clone(),
        })
        .collect();
    let servers = settings
        .servers
        .iter()
        .map(|s| McpServerConfig {
            name: s.name.trim().to_string(),
            program: s.program.trim().to_string(),
            args: s.args.clone(),
            env: Default::default(),
            tools: s
                .tools
                .as_ref()
                .map(|list| list.iter().map(|t| t.trim().to_string()).collect()),
        })
        .collect();
    Ok((hooks, servers))
}

// ---- 저장소의 제안 (state-machine 35절) ----

/// 저장소가 제안을 두는 자리. **우리가 정한 규약이다** — 저장소가 알아서 고르는 값이 아니라
/// 우리가 한 곳만 본다는 뜻이고, 그래서 "어디를 봤나"에 언제나 답할 수 있다.
pub const PROPOSAL_DIR: &str = ".tomverse";
pub const PROPOSAL_FILE: &str = "proposal.json";

/// 화면과 문서가 쓰는 표시용 경로. **`load_proposal`이 실제로 여는 경로에서 유도한다** —
/// 손으로 적으면 언젠가 둘이 갈라지고, 갈라진 문장은 사용자를 없는 파일로 보낸다.
pub fn proposal_display_path() -> String {
    format!("{PROPOSAL_DIR}/{PROPOSAL_FILE}")
}

/// 저장소의 제안이 등록과 어떤 관계인가 (35절).
///
/// **세 상태를 뭉개지 않는다.** "제안이 없다"와 "제안이 등록과 같다"와 "다르다"는 사용자가
/// 할 일이 각각 다르고, 특히 마지막은 **저장소가 바뀌었다**는 신호다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Absent,
    SameAsRegistered,
    Differs,
}

/// 저장소의 제안을 **읽는다. 적용하지 않는다.**
///
/// # 이 함수가 하는 일은 화면에 문장을 띄우는 것뿐이다
///
/// 이 파일은 워크스페이스 안에 있으므로 **모델이 쓸 수 있다**(29.1·34.1절). 그래서 읽은
/// 내용으로 아무것도 등록하지 않는다 — 등록은 사용자가 화면에서 저장을 누를 때 기존 저장
/// 경로(`save`)를 그대로 지나 일어난다. 여기서 곧장 등록하는 지름길을 만들면 그 순간
/// **모델이 자기 훅과 자기 MCP 서버를 등록할 수 있게 된다.**
///
/// # 그래도 검증은 여기서 한다
///
/// 화면에 띄우기 전에 형식을 확인한다. 잘못된 제안을 그대로 띄우면 사용자는 저장을 누른
/// 뒤에야 거절당하고, 그 거절의 원인이 자기 편집인지 저장소의 제안인지 구별할 수 없다.
pub fn load_proposal(root: &crate::paths::WorkspaceRoot) -> Result<Option<WorkspaceSettings>, SettingsError> {
    let path = root.path().join(PROPOSAL_DIR).join(PROPOSAL_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| SettingsError::Unreadable(e.to_string()))?;
    let settings: WorkspaceSettings =
        serde_json::from_str(&text).map_err(|e| SettingsError::Malformed(e.to_string()))?;
    let (hooks, servers) = to_configs(&settings)?;
    validate_hooks(&hooks).map_err(|e| SettingsError::Invalid(e.to_string()))?;
    validate_servers(&servers).map_err(|e| SettingsError::Invalid(e.to_string()))?;
    Ok(Some(settings))
}

/// 제안과 등록의 관계.
pub fn proposal_status(proposal: Option<&WorkspaceSettings>, registered: &WorkspaceSettings) -> ProposalStatus {
    match proposal {
        None => ProposalStatus::Absent,
        Some(p) if p == registered => ProposalStatus::SameAsRegistered,
        Some(_) => ProposalStatus::Differs,
    }
}

/// 저장된 설정을 읽어 **검증까지 마친** 것으로 돌려준다.
///
/// 저장 시점에 검증했더라도 다시 한다: 파일은 사용자가 손으로 고칠 수 있고, 그때 앱이
/// 조용히 잘못된 등록으로 도는 것보다 열리지 않는 편이 낫다.
pub fn load_validated(
    state_dir: &Path,
    workspace_id: &str,
) -> Result<(Vec<HookConfig>, Vec<McpServerConfig>), SettingsError> {
    let settings = load(state_dir, workspace_id)?;
    let (hooks, servers) = to_configs(&settings)?;
    validate_hooks(&hooks).map_err(|e| SettingsError::Invalid(e.to_string()))?;
    validate_servers(&servers).map_err(|e| SettingsError::Invalid(e.to_string()))?;
    Ok((hooks, servers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(phase: &str, program: &str) -> StoredHook {
        StoredHook {
            phase: phase.to_string(),
            program: program.to_string(),
            args: vec!["run".to_string(), "fmt".to_string()],
        }
    }

    /// **설정 파일이 워크스페이스 밖에 있어야 한다.** 안에 있으면 모델이 쓸 수 있고,
    /// 그러면 "등록은 사용자만 한다"(23.5절)가 무너진다.
    #[test]
    fn the_settings_file_is_outside_the_workspace() {
        let state = Path::new("/state");
        let path = settings_path(state, "ws-1");
        assert!(path.starts_with(state), "{}", path.display());
        // 워크스페이스 경로가 파일명에 들어가지 않는다 — id로만 짓는다.
        assert!(path.to_string_lossy().contains("ws-1"));
    }

    #[test]
    fn a_missing_file_is_an_empty_setting_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load(dir.path(), "ws-none").unwrap();
        assert_eq!(settings, WorkspaceSettings::default());
    }

    #[test]
    fn saved_settings_come_back() {
        let dir = tempfile::tempdir().unwrap();
        let settings = WorkspaceSettings {
            hooks: vec![hook("COMPLETED", "npm")],
            servers: vec![StoredServer {
                name: "echo".to_string(),
                program: "node".to_string(),
                args: vec!["server.js".to_string()],
                tools: None,
            }],
        };
        save(dir.path(), "ws-1", &settings).unwrap();
        assert_eq!(load(dir.path(), "ws-1").unwrap(), settings);
    }

    /// **검증이 저장보다 먼저다.** 뒤면 잘못된 설정이 파일에 남고, 다음에 앱을 켤 때
    /// 워크스페이스가 열리지 않는다 — 사용자가 파일을 손으로 고쳐야 빠져나온다.
    #[test]
    fn an_invalid_hook_is_rejected_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let settings = WorkspaceSettings {
            hooks: vec![hook("VERIFYNG", "npm")],
            servers: vec![],
        };
        assert!(save(dir.path(), "ws-1", &settings).is_err());
        assert!(!settings_path(dir.path(), "ws-1").exists(), "거부했는데 파일이 생겼습니다");
    }

    // ---- 저장소의 제안 (35절) ----

    fn workspace_with_proposal(body: &str) -> (tempfile::TempDir, crate::paths::WorkspaceRoot) {
        let ws = tempfile::tempdir().unwrap();
        let dir = ws.path().join(PROPOSAL_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(PROPOSAL_FILE), body).unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        (ws, root)
    }

    /// **제안이 없는 것은 오류가 아니다.** 대부분의 저장소에는 이 파일이 없다.
    #[test]
    fn a_workspace_without_a_proposal_says_absent() {
        let ws = tempfile::tempdir().unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        assert_eq!(load_proposal(&root).unwrap(), None);
        assert_eq!(
            proposal_status(None, &WorkspaceSettings::default()),
            ProposalStatus::Absent
        );
    }

    /// 제안을 읽는다 — **그러나 등록은 건드리지 않는다.** 이 함수가 하는 일은 화면에 띄울
    /// 값을 돌려주는 것뿐이고, 등록 파일은 그대로 있어야 한다.
    #[test]
    fn reading_a_proposal_does_not_register_anything() {
        let state = tempfile::tempdir().unwrap();
        let (_ws, root) = workspace_with_proposal(
            r#"{"hooks":[{"phase":"COMPLETED","program":"npm","args":["run","fmt"]}],"servers":[]}"#,
        );

        let proposal = load_proposal(&root).unwrap().expect("제안을 읽지 못했습니다");
        assert_eq!(proposal.hooks.len(), 1);
        // 등록은 여전히 비어 있다 — 읽기가 곧 등록이면 모델이 자기 훅을 등록할 수 있다.
        assert_eq!(load(state.path(), "ws-1").unwrap(), WorkspaceSettings::default());
        assert!(!settings_path(state.path(), "ws-1").exists());
    }

    /// **읽기가 등록이 될 수 없다는 것을 구조로 확인한다.**
    ///
    /// 위 테스트는 "지금은 등록되지 않았다"까지만 말한다 — `load_proposal`이 상태 디렉터리를
    /// 받지 않으므로 그 함수 안에서는 등록할 대상 경로조차 만들 수 없고, 그것이 진짜 보장이다.
    /// 그래서 **본문에 저장 호출이 없다**를 소스에서 확인한다: 저장하려면 먼저 인자가 늘어야
    /// 하고, 그 변경은 이 검사에서 멈춘다.
    #[test]
    fn the_proposal_reader_cannot_register() {
        let source = include_str!("settings.rs");
        // needle을 런타임에 조립한다 — 리터럴로 적으면 이 검사 자체가 검사 대상에 걸린다.
        let marker = "fn load_proposal".to_string();
        let start = source.find(&marker).expect("load_proposal을 찾지 못했습니다");
        let body = &source[start..];
        let end = body.find("\n}\n").expect("함수가 닫히지 않았습니다");
        let body = &body[..end];
        for forbidden in ["save".to_string() + "(", "write".to_string() + "("] {
            assert!(
                !body.contains(&forbidden),
                "load_proposal이 `{forbidden}`을 부릅니다 — 읽기가 등록이 되면 모델이 자기 훅을 등록할 수 있습니다"
            );
        }
        // **이 검사가 공허하지 않다는 것**: 같은 방식으로 찾으면 저장하는 함수는 실제로 걸린다.
        let save_start = source.find("fn save").expect("save를 찾지 못했습니다");
        let save_body = &source[save_start..];
        let save_end = save_body.find("\n}\n").expect("save가 닫히지 않았습니다");
        assert!(
            save_body[..save_end].contains(&("write".to_string() + "(")),
            "검사 방식이 아무것도 보지 않고 있습니다"
        );
    }

    /// **화면에 띄우기 전에 검증한다.** 잘못된 제안을 그대로 띄우면 사용자는 저장을 누른
    /// 뒤에야 거절당하고, 원인이 자기 편집인지 저장소의 제안인지 구별할 수 없다.
    #[test]
    fn an_invalid_proposal_is_refused_before_it_reaches_the_screen() {
        let (_ws, root) = workspace_with_proposal(
            r#"{"hooks":[{"phase":"NOPE","program":"npm","args":["test"]}],"servers":[]}"#,
        );
        assert!(load_proposal(&root).is_err());
    }

    /// **세 상태를 뭉개지 않는다.** "같다"와 "다르다"가 같은 모양이면 저장소가 바뀌었다는
    /// 신호가 사라진다.
    #[test]
    fn the_status_separates_same_from_different() {
        let registered = WorkspaceSettings {
            hooks: vec![hook("COMPLETED", "npm")],
            servers: vec![],
        };
        assert_eq!(
            proposal_status(Some(&registered.clone()), &registered),
            ProposalStatus::SameAsRegistered
        );
        let other = WorkspaceSettings {
            hooks: vec![hook("FAILED", "npm")],
            servers: vec![],
        };
        assert_eq!(proposal_status(Some(&other), &registered), ProposalStatus::Differs);
    }

    /// 표시용 경로는 **실제로 여는 경로에서 유도한다** — 손으로 적으면 사용자를 없는 파일로 보낸다.
    #[test]
    fn the_displayed_path_is_the_one_we_actually_open() {
        let (ws, root) = workspace_with_proposal(r#"{"hooks":[],"servers":[]}"#);
        assert!(load_proposal(&root).unwrap().is_some());
        let shown = ws.path().join(proposal_display_path().replace('/', std::path::MAIN_SEPARATOR_STR));
        assert!(shown.exists(), "{}", shown.display());
    }

    /// 손으로 고친 파일도 다시 검증한다 — 조용히 잘못된 등록으로 도는 것보다 열리지 않는
    /// 편이 낫다.
    #[test]
    fn a_hand_edited_file_is_validated_again_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path(), "ws-1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"hooks":[{"phase":"NOPE","program":"npm","args":["test"]}],"servers":[]}"#,
        )
        .unwrap();
        assert!(load_validated(dir.path(), "ws-1").is_err());
    }
}
