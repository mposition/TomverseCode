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
        })
        .collect();
    Ok((hooks, servers))
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
