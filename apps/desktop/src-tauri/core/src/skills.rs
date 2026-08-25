//! Skills · 커스텀 에이전트 (얕은 버전) — state-machine-and-protocol.md 26절.
//!
//! product-strategy 8.2절 기준: **"이름 붙인 프롬프트 프리셋 + 도구 허용목록 + 역할별 모델
//! 지정"**. 세 조각이고, 세 조각이 사는 곳이 다르다.
//!
//! | 조각 | 어디서 강제되는가 | 왜 거기인가 |
//! |---|---|---|
//! | 도구 허용목록 | **Rust (Policy Gate)** | Node가 지키면 장악당한 Node에서 그 규칙이 사라진다(원칙 2) |
//! | 프롬프트 프리셋 | Node (프롬프트 조립) | 프롬프트를 만드는 곳이 거기다 |
//! | 역할별 모델 지정 | Node (라우터) | 이미 `modelPins`가 하는 일이다 |
//!
//! **파일을 Rust가 읽는다.** Node가 읽어 넘기면 도구 허용목록의 출처가 Node가 되고, 그러면
//! 장악당한 Node가 "허용목록은 전부입니다"라고 말할 수 있다. Rust가 읽어서 자기 게이트에
//! 꽂고, 프롬프트와 모델 지정만 Node로 넘긴다.
//!
//! # 허용목록은 **좁히기만** 한다
//!
//! 스킬이 도구를 늘릴 수는 없다. 게이트의 분류는 그대로이고, 허용목록은 그 앞에서 한 겹 더
//! 막을 뿐이다. 넓히는 방향을 열면 "스킬 파일 하나로 정책을 푼다"가 되고, 그건 이 저장소가
//! 반복해서 거부해 온 우회 경로다.
//!
//! # 검증 명령은 허용목록의 대상이 아니다
//!
//! `run_tests`는 선언하지 않아도 남는다. 이 목록이 좁히는 것은 **모델이 쓸 수 있는 도구**이고,
//! 검증은 모델의 도구가 아니라 우리의 판정자다(원칙 1). 좁힐 수 있게 두면 스킬 파일 한 줄로
//! `VERIFYING`이 조용히 무력화되는데, 그건 "검증은 `complexityTier`와 무관하게 항상 실행된다"를
//! 정면으로 깨는 것이다. 빠뜨렸다고 꺼지는 것이 아니라 **애초에 끌 수 없어야 한다.**

use crate::types::ToolName;
use serde::Deserialize;
use std::path::Path;

/// 스킬 파일의 모양. 사용자가 손으로 쓰는 JSON이다.
#[derive(Debug, Clone, Deserialize)]
pub struct SkillFile {
    pub name: String,
    /// 프롬프트에 실릴 지시문. **공급자로 나간다** — 전송 집계가 이것을 센다(7.2절).
    #[serde(default)]
    pub instructions: String,
    /// 모델이 쓸 수 있는 도구. 비어 있거나 없으면 **좁히지 않는다**.
    #[serde(rename = "allowedTools", default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(rename = "modelPins", default)]
    pub model_pins: Option<ModelPins>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct ModelPins {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
}

/// 검증된 스킬. 여기까지 오면 도구 이름이 전부 실재한다.
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub instructions: String,
    /// `None`이면 좁히지 않는다. `Some`이면 **여기 없는 도구는 거부**된다.
    pub allowed_tools: Option<Vec<ToolName>>,
    pub model_pins: Option<ModelPins>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SkillError {
    #[error("스킬 파일을 읽을 수 없습니다: {path} ({detail})")]
    Unreadable { path: String, detail: String },
    #[error("스킬 파일이 JSON이 아닙니다: {path} ({detail})")]
    Malformed { path: String, detail: String },
    #[error("스킬에 이름이 없습니다")]
    EmptyName,
    #[error("알 수 없는 도구입니다: {tool} (쓸 수 있는 이름: {known})")]
    UnknownTool { tool: String, known: String },
    #[error("허용목록이 비어 있습니다 — 아무 도구도 못 쓰는 스킬은 아무 일도 하지 못합니다. 좁히지 않으려면 키를 빼세요")]
    EmptyAllowlist,
    #[error("스킬에 지시문도 허용목록도 모델 지정도 없습니다 — 이 스킬은 아무것도 하지 않습니다")]
    Empty,
    /// 워크스페이스 **안**의 스킬 파일 (34절). 모델이 쓸 수 있는 파일이므로 읽지 않는다.
    #[error(
        "스킬 파일이 워크스페이스 안에 있습니다: {path} (워크스페이스: {root})\n         워크스페이스 안의 파일은 모델이 고칠 수 있습니다 — 스킬은 지시문과 도구 허용목록을 정하므로,          모델이 자기 프롬프트에 지시문을 심고 자기가 좁혀 둔 허용목록을 되돌릴 수 있습니다.\n         워크스페이스 밖으로 복사한 뒤 그 경로를 쓰세요."
    )]
    InsideWorkspace { path: String, root: String },
    /// 보관함 파일 이름이 아니다 (36절) — 경로 조각이 들어오면 보관함 밖을 가리킬 수 있다.
    #[error("보관함의 스킬 이름이 아닙니다: {file} (`.json`으로 끝나는 파일 이름이어야 하고 경로일 수 없습니다)")]
    BadLibraryName { file: String },
    #[error("보관함에 같은 이름이 이미 있습니다: {file} — 덮어쓰지 않습니다. 지우고 다시 가져오세요")]
    AlreadyInLibrary { file: String },
    #[error("스킬 파일을 쓸 수 없습니다: {path} ({detail})")]
    Unwritable { path: String, detail: String },
}

/// 이름으로 도구를 찾는다.
///
/// **`ToolName::as_str`에서 유도한다.** 별도 표를 만들면 `ToolName`에 변형이 늘 때 한쪽만
/// 갱신되고, 그러면 새 도구는 스킬 파일에서 "알 수 없는 도구"가 된다.
fn parse_tool(name: &str) -> Option<ToolName> {
    ALL_TOOLS.iter().copied().find(|t| t.as_str() == name)
}

/// 모든 도구.
///
/// **이건 손으로 적은 목록이고, 그래서 `ToolName`에 변형이 늘면 낡을 수 있다.** 낡으면 새
/// 도구는 스킬 파일에서 "알 수 없는 도구"가 되고, 사용자는 우리 누락을 자기 오타로 읽는다.
/// 그래서 `all_tools_matches_the_tool_name_enum`이 `types.rs`의 `as_str` 매치 팔에서 이름을
/// **유도해** 대조한다 — 목록을 두 번 적는 대신 두 번째가 첫 번째에서 나오게 한다.
pub const ALL_TOOLS: &[ToolName] = &[
    ToolName::ListFiles,
    ToolName::SearchText,
    ToolName::ReadFile,
    ToolName::ApplyPatch,
    ToolName::CreateFile,
    ToolName::DeleteFile,
    ToolName::MoveFile,
    ToolName::RunCommand,
    ToolName::GitStatus,
    ToolName::GitDiff,
    ToolName::RunTests,
    ToolName::McpCall,
    ToolName::GitPush,
];

/// 스킬 파일을 읽고 검증한다.
/// 위치를 묻지 않고 파일 하나를 읽어 검증한다.
///
/// **`load`와 나눠 둔다.** `load`는 "이 스킬을 태스크에 쓴다"이므로 워크스페이스 안을
/// 거부해야 하고(34절), 이 함수는 "이 파일이 무엇인지 보여준다"이므로 거부가 목적이 아니다.
/// 한 함수로 합치면 목록 화면이 저장소의 제안을 아예 읽지 못한다.
pub fn load_from(path: &Path) -> Result<Skill, SkillError> {
    let text = std::fs::read_to_string(path).map_err(|e| SkillError::Unreadable {
        path: path.display().to_string(),
        detail: e.to_string(),
    })?;
    let file: SkillFile = serde_json::from_str(&text).map_err(|e| SkillError::Malformed {
        path: path.display().to_string(),
        detail: e.to_string(),
    })?;
    validate(file)
}

pub fn load(path: &Path, root: &crate::paths::WorkspaceRoot) -> Result<Skill, SkillError> {
    // **워크스페이스 안의 스킬 파일은 읽지 않는다** (state-machine 34절).
    //
    // Policy Gate가 파일 쓰기를 워크스페이스 안으로 가두므로, 워크스페이스 안의 파일은
    // **모델이 쓸 수 있는 파일**이다. 스킬 파일은 두 가지를 정한다: 프롬프트에 실릴 지시문과
    // 도구 허용목록. 모델이 그 파일을 고치면 자기 다음 프롬프트에 지시문을 심을 수 있고,
    // 허용목록을 지워 **자기가 좁혀 둔 것을 스스로 되돌릴 수 있다.**
    //
    // 29.1절이 등록 설정에 대해 내린 판단과 같은 문장이며, 규칙의 근거도 같다: 모델이 쓸 수
    // 있는 곳은 워크스페이스 안이므로, 그 밖에서 오는 것만 사용자의 것이라고 말할 수 있다.
    if root.contains(path) {
        return Err(SkillError::InsideWorkspace {
            path: path.display().to_string(),
            root: root.display(),
        });
    }
    load_from(path)
}

pub fn validate(file: SkillFile) -> Result<Skill, SkillError> {
    if file.name.trim().is_empty() {
        return Err(SkillError::EmptyName);
    }
    let allowed_tools = match file.allowed_tools {
        None => None,
        Some(names) => {
            // **빈 목록은 "좁히지 않는다"가 아니다.** 그렇게 읽으면 사용자가 실수로 비운
            // 목록이 조용히 전체 허용이 된다 — 좁히려던 의도와 정반대다.
            if names.is_empty() {
                return Err(SkillError::EmptyAllowlist);
            }
            let mut tools = Vec::new();
            for name in &names {
                let tool = parse_tool(name).ok_or_else(|| SkillError::UnknownTool {
                    tool: name.clone(),
                    known: ALL_TOOLS.iter().map(|t| t.as_str()).collect::<Vec<_>>().join(", "),
                })?;
                if !tools.contains(&tool) {
                    tools.push(tool);
                }
            }
            // 검증 명령은 선언하지 않아도 남는다 — 모듈 주석 참조.
            if !tools.contains(&ToolName::RunTests) {
                tools.push(ToolName::RunTests);
            }
            Some(tools)
        }
    };

    let skill = Skill {
        name: file.name.trim().to_string(),
        instructions: file.instructions.trim().to_string(),
        allowed_tools,
        model_pins: file.model_pins,
    };
    // 셋 다 없으면 이 스킬은 이름만 있는 것이다. 등록을 통과시키면 사용자는 무언가
    // 적용됐다고 믿는다.
    if skill.instructions.is_empty()
        && skill.allowed_tools.is_none()
        && skill
            .model_pins
            .as_ref()
            .map(|p| p.executor.is_none() && p.reviewer.is_none())
            .unwrap_or(true)
    {
        return Err(SkillError::Empty);
    }
    Ok(skill)
}

impl Skill {
    /// 사용자에게 보여주는 한 줄 요약. **무엇이 적용됐는지 말하지 않으면 적용된 줄 모른다.**
    pub fn describe(&self) -> String {
        let tools = match &self.allowed_tools {
            None => "도구 제한 없음".to_string(),
            Some(t) => format!("도구 {}개로 제한", t.len()),
        };
        let pins = match &self.model_pins {
            Some(p) => format!(
                "모델 지정(executor={}, reviewer={})",
                p.executor.as_deref().unwrap_or("-"),
                p.reviewer.as_deref().unwrap_or("-")
            ),
            None => "모델 지정 없음".to_string(),
        };
        format!(
            "{} — 지시문 {}자 · {tools} · {pins}",
            self.name,
            self.instructions.chars().count()
        )
    }
}

// ---- 스킬 보관함 (state-machine 36절) ----

/// 보관함이 사는 자리. **상태 디렉터리다** — 모델이 쓸 수 없는 곳이고, 그래서 34절의 규칙을
/// 자동으로 만족한다. 규칙을 한 번 더 적는 대신 규칙을 만족하는 자리를 고른다.
pub const LIBRARY_DIR: &str = "skills";

/// 보관함의 항목 하나.
///
/// **깨진 파일도 목록에 남는다.** 지우면 사용자는 자기 파일이 왜 안 보이는지 모른다 —
/// 31.6절이 "물어보지 못한 서버"에 대해 내린 판단과 같다: 없는 것과 읽지 못한 것은 다르다.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct LibraryEntry {
    /// 파일 이름(확장자 포함). **이것이 고를 때 쓰는 열쇠다** — 스킬의 `name`은 중복될 수 있다.
    pub file: String,
    /// 검증을 통과했으면 그 요약, 아니면 `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 스킬이 스스로 부르는 이름. 검증에 실패했으면 `None`이다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 읽지 못했다면 왜인가.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

fn library_dir(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join(LIBRARY_DIR)
}

/// 보관함의 스킬 파일 경로. **이름을 검사한다** — 경로 조각이 들어오면 보관함 밖을 가리킬 수 있다.
pub fn library_path(state_dir: &Path, file: &str) -> Result<std::path::PathBuf, SkillError> {
    let trimmed = file.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || !trimmed.ends_with(".json")
    {
        return Err(SkillError::BadLibraryName { file: file.to_string() });
    }
    Ok(library_dir(state_dir).join(trimmed))
}

/// 보관함 목록. **아무것도 쓰지 않는다.** 디렉터리가 없으면 빈 목록이다.
pub fn list_library(state_dir: &Path) -> Vec<LibraryEntry> {
    let dir = library_dir(state_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<LibraryEntry> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            match load_from(&e.path()) {
                Ok(skill) => LibraryEntry {
                    file,
                    summary: Some(skill.describe()),
                    name: Some(skill.name),
                    problem: None,
                },
                Err(err) => LibraryEntry {
                    file,
                    summary: None,
                    name: None,
                    problem: Some(err.to_string()),
                },
            }
        })
        .collect();
    // 파일 이름 순 — 디렉터리 순회 순서는 OS가 정하므로 화면이 실행마다 달라진다.
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// 저장소가 제안하는 스킬들 (35절의 두 번째 적용). **읽기만 한다.**
///
/// 워크스페이스 안이므로 모델이 쓸 수 있다 — 그래서 이 목록으로 하는 일은 화면에 띄우는
/// 것뿐이고, 보관함에 들어가는 것은 사용자가 가져오기를 누를 때다.
pub fn list_proposed(root: &crate::paths::WorkspaceRoot) -> Vec<LibraryEntry> {
    let dir = root.path().join(".tomverse").join(LIBRARY_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<LibraryEntry> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            // **`load`가 아니라 `load_from`이다.** `load`는 워크스페이스 안을 거부하는데,
            // 여기서는 거부가 목적이 아니라 **보여주는 것**이 목적이다 — 거부는 그 내용이
            // 태스크에 쓰이려 할 때 일어난다.
            match load_from(&e.path()) {
                Ok(skill) => LibraryEntry {
                    file,
                    summary: Some(skill.describe()),
                    name: Some(skill.name),
                    problem: None,
                },
                Err(err) => LibraryEntry {
                    file,
                    summary: None,
                    name: None,
                    problem: Some(err.to_string()),
                },
            }
        })
        .collect();
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// 저장소의 스킬을 보관함으로 **복사한다** — 사용자가 가져오기를 눌렀을 때만.
///
/// # 사본이라는 것이 요점이다
///
/// 복사한 뒤에는 저장소의 파일이 바뀌어도 보관함의 것은 그대로다. 참조로 두면 34.1절의
/// 구멍이 그대로 남는다 — 모델이 저장소의 파일을 고치면 다음 태스크가 다른 내용을 받는다.
///
/// **이미 있으면 덮어쓰지 않는다.** 덮어쓰면 사용자가 손으로 고쳐 둔 보관함의 스킬이 조용히
/// 사라진다. 지우고 다시 가져오는 것은 사용자가 정한다.
pub fn import_proposed(
    state_dir: &Path,
    root: &crate::paths::WorkspaceRoot,
    file: &str,
) -> Result<String, SkillError> {
    // **이름 검사를 먼저 한 뒤 그 이름으로 양쪽 경로를 만든다.** 원본 쪽만 검사를 빠뜨리면
    // 경로 조각이 워크스페이스 밖의 파일을 읽는 데 쓰인다.
    let target = library_path(state_dir, file)?;
    let name = file.trim();
    let source = root.path().join(".tomverse").join(LIBRARY_DIR).join(name);
    // **가져오기 전에 검증한다.** 깨진 파일을 보관함에 넣으면 목록에 문제 항목이 늘 뿐이다.
    let skill = load_from(&source)?;
    if target.exists() {
        return Err(SkillError::AlreadyInLibrary { file: file.to_string() });
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| SkillError::Unwritable {
            path: target.display().to_string(),
            detail: e.to_string(),
        })?;
    }
    let text = std::fs::read_to_string(&source).map_err(|e| SkillError::Unreadable {
        path: source.display().to_string(),
        detail: e.to_string(),
    })?;
    std::fs::write(&target, text).map_err(|e| SkillError::Unwritable {
        path: target.display().to_string(),
        detail: e.to_string(),
    })?;
    Ok(skill.name)
}

/// 보관함에서 지운다. **보관함 안의 파일만** — 이름 검사가 그것을 보장한다.
pub fn remove_from_library(state_dir: &Path, file: &str) -> Result<(), SkillError> {
    let path = library_path(state_dir, file)?;
    std::fs::remove_file(&path).map_err(|e| SkillError::Unwritable {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(json: &str) -> Result<Skill, SkillError> {
        validate(serde_json::from_str(json).unwrap())
    }

    // ---- 스킬 파일이 어디서 오는가 (34절) ----

    const SAMPLE: &str = r#"{"name":"s","instructions":"do it"}"#;

    /// **워크스페이스 안의 스킬 파일은 읽지 않는다.** 모델이 쓸 수 있는 파일이 지시문과
    /// 도구 허용목록을 정하면, 모델은 자기 프롬프트에 지시문을 심고 자기가 좁혀 둔
    /// 허용목록을 되돌릴 수 있다.
    #[test]
    fn a_skill_inside_the_workspace_is_refused() {
        let ws = tempfile::tempdir().unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        let inside = ws.path().join("skill.json");
        std::fs::write(&inside, SAMPLE).unwrap();

        let err = load(&inside, &root).unwrap_err();
        assert!(matches!(err, SkillError::InsideWorkspace { .. }), "{err:?}");
        // 사유가 **고칠 방법**을 말한다 — 거부만 하면 사용자는 왜 자기 파일이 안 되는지 모른다.
        assert!(err.to_string().contains("밖으로 복사"), "{err}");
    }

    /// 하위 디렉터리도 마찬가지다 — 루트 바로 아래만 막으면 `.tomverse/skill.json`이 지나간다.
    #[test]
    fn a_skill_in_a_subdirectory_is_refused_too() {
        let ws = tempfile::tempdir().unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        let dir = ws.path().join(".tomverse");
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("skill.json");
        std::fs::write(&inside, SAMPLE).unwrap();

        assert!(matches!(load(&inside, &root).unwrap_err(), SkillError::InsideWorkspace { .. }));
    }

    /// **`..`로 되돌아오는 경로도 안이다.** canonical로 비교하지 않으면 이 우회가 지나가고,
    /// 그 통과는 "안전한 자리에서 읽었다"는 결론으로 이어진다.
    #[test]
    fn a_path_that_walks_back_into_the_workspace_is_refused() {
        let ws = tempfile::tempdir().unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        let dir = ws.path().join("sub");
        std::fs::create_dir_all(&dir).unwrap();
        let inside = ws.path().join("skill.json");
        std::fs::write(&inside, SAMPLE).unwrap();

        let sneaky = dir.join("..").join("skill.json");
        assert!(matches!(load(&sneaky, &root).unwrap_err(), SkillError::InsideWorkspace { .. }));
    }

    /// **밖에 있으면 읽는다.** 이 단언이 없으면 위 검사들은 "언제나 거부"로도 통과한다.
    #[test]
    fn a_skill_outside_the_workspace_loads() {
        let ws = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        let outside = elsewhere.path().join("skill.json");
        std::fs::write(&outside, SAMPLE).unwrap();

        let skill = load(&outside, &root).unwrap();
        assert_eq!(skill.name, "s");
    }

    /// 없는 파일은 **읽기 실패**여야 한다 — 위치 검사가 그 원인을 가리면 사용자는 경로 오타를
    /// "워크스페이스 안이라서"로 읽는다.
    #[test]
    fn a_missing_file_reports_the_read_failure_not_the_location() {
        let ws = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        let missing = elsewhere.path().join("nope.json");
        assert!(matches!(load(&missing, &root).unwrap_err(), SkillError::Unreadable { .. }));
    }

    // ---- 스킬 보관함 (36절) ----

    fn write_skill(dir: &std::path::Path, file: &str, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(file),
            format!(r#"{{"name":"{name}","instructions":"do it"}}"#),
        )
        .unwrap();
    }

    /// 보관함이 없으면 빈 목록이다 — 오류가 아니다. 대부분의 설치에는 처음에 없다.
    #[test]
    fn an_absent_library_is_an_empty_list() {
        let state = tempfile::tempdir().unwrap();
        assert!(list_library(state.path()).is_empty());
    }

    /// **깨진 파일도 목록에 남는다.** 지우면 사용자는 자기 파일이 왜 안 보이는지 모른다.
    #[test]
    fn a_broken_skill_stays_in_the_list_with_its_reason() {
        let state = tempfile::tempdir().unwrap();
        let dir = state.path().join(LIBRARY_DIR);
        write_skill(&dir, "good.json", "좋은 것");
        std::fs::write(dir.join("bad.json"), "{ not json").unwrap();

        let list = list_library(state.path());
        assert_eq!(list.len(), 2, "{list:?}");
        let bad = list.iter().find(|e| e.file == "bad.json").unwrap();
        assert!(bad.problem.is_some(), "{bad:?}");
        assert!(bad.name.is_none(), "읽지 못했는데 이름이 있습니다");
        let good = list.iter().find(|e| e.file == "good.json").unwrap();
        assert_eq!(good.name.as_deref(), Some("좋은 것"));
        assert!(good.problem.is_none());
    }

    /// 순서가 실행마다 달라지면 화면이 흔들린다 — 디렉터리 순회 순서는 OS가 정한다.
    #[test]
    fn the_library_is_sorted_by_file_name() {
        let state = tempfile::tempdir().unwrap();
        let dir = state.path().join(LIBRARY_DIR);
        for file in ["c.json", "a.json", "b.json"] {
            write_skill(&dir, file, file);
        }
        let files: Vec<String> = list_library(state.path()).into_iter().map(|e| e.file).collect();
        assert_eq!(files, vec!["a.json", "b.json", "c.json"]);
    }

    /// **경로 조각은 보관함 이름이 아니다.** 통과시키면 보관함 밖의 파일을 지우거나 덮어쓸 수 있다.
    #[test]
    fn a_path_fragment_is_not_a_library_name() {
        let state = tempfile::tempdir().unwrap();
        for bad in ["../escape.json", "sub/skill.json", "skill.txt", "", "..json/x.json"] {
            assert!(
                matches!(library_path(state.path(), bad), Err(SkillError::BadLibraryName { .. })),
                "{bad} 가 통과했습니다"
            );
        }
        // **공허하지 않다**: 평범한 이름은 실제로 통과한다.
        assert!(library_path(state.path(), "skill.json").is_ok());
    }

    /// 저장소의 제안은 **읽기만 한다** — 보관함은 그대로다.
    #[test]
    fn listing_a_proposal_does_not_import_it() {
        let state = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        write_skill(&ws.path().join(".tomverse").join(LIBRARY_DIR), "team.json", "팀 스킬");
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();

        let proposed = list_proposed(&root);
        assert_eq!(proposed.len(), 1);
        assert_eq!(proposed[0].name.as_deref(), Some("팀 스킬"));
        // 보관함은 비어 있다 — 보는 것이 가져오는 것이면 모델이 자기 스킬을 넣을 수 있다.
        assert!(list_library(state.path()).is_empty());
    }

    /// **가져오면 사본이 생기고, 그 뒤 저장소가 바뀌어도 사본은 그대로다.**
    ///
    /// 참조로 두면 34.1절의 구멍이 그대로 남는다 — 모델이 저장소의 파일을 고치면 다음
    /// 태스크가 다른 내용을 받는다.
    #[test]
    fn importing_takes_a_copy_that_the_repository_cannot_change_later() {
        let state = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let proposed_dir = ws.path().join(".tomverse").join(LIBRARY_DIR);
        write_skill(&proposed_dir, "team.json", "처음 이름");
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();

        let name = import_proposed(state.path(), &root, "team.json").unwrap();
        assert_eq!(name, "처음 이름");

        // 저장소가 바뀐다 (모델이 고쳤다고 하자).
        write_skill(&proposed_dir, "team.json", "바뀐 이름");
        let list = list_library(state.path());
        assert_eq!(list[0].name.as_deref(), Some("처음 이름"), "사본이 아니라 참조였습니다");
    }

    /// **덮어쓰지 않는다.** 덮어쓰면 사용자가 손으로 고쳐 둔 보관함의 스킬이 조용히 사라진다.
    #[test]
    fn importing_over_an_existing_name_is_refused() {
        let state = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        write_skill(&ws.path().join(".tomverse").join(LIBRARY_DIR), "team.json", "저장소 것");
        write_skill(&state.path().join(LIBRARY_DIR), "team.json", "내가 고친 것");
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();

        assert!(matches!(
            import_proposed(state.path(), &root, "team.json"),
            Err(SkillError::AlreadyInLibrary { .. })
        ));
        assert_eq!(list_library(state.path())[0].name.as_deref(), Some("내가 고친 것"));
    }

    /// 깨진 제안은 **가져오기 전에** 걸린다 — 보관함에 문제 항목을 늘리지 않는다.
    #[test]
    fn a_broken_proposal_is_not_imported() {
        let state = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let dir = ws.path().join(".tomverse").join(LIBRARY_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bad.json"), "{ not json").unwrap();
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();

        assert!(import_proposed(state.path(), &root, "bad.json").is_err());
        assert!(list_library(state.path()).is_empty());
    }

    #[test]
    fn removing_takes_the_entry_out_of_the_library() {
        let state = tempfile::tempdir().unwrap();
        write_skill(&state.path().join(LIBRARY_DIR), "s.json", "지울 것");
        assert_eq!(list_library(state.path()).len(), 1);
        remove_from_library(state.path(), "s.json").unwrap();
        assert!(list_library(state.path()).is_empty());
    }

    /// 보관함의 스킬은 **워크스페이스 밖**이므로 태스크에 그대로 쓸 수 있다 — 34절의 규칙을
    /// 자리 선택으로 만족한다.
    #[test]
    fn a_library_skill_can_be_used_by_a_task() {
        let state = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        write_skill(&state.path().join(LIBRARY_DIR), "s.json", "보관함 것");
        let root = crate::paths::WorkspaceRoot::new(ws.path()).unwrap();
        let path = library_path(state.path(), "s.json").unwrap();
        assert_eq!(load(&path, &root).unwrap().name, "보관함 것");
    }

    /// `ALL_TOOLS`가 `ToolName` 전체를 담고 있는가 — **`as_str`의 매치 팔에서 유도해** 본다.
    ///
    /// 기대 목록을 여기 다시 적으면 갈라질 자리가 셋이 된다. `as_str`은 exhaustive match라
    /// 변형이 늘면 컴파일러가 그쪽을 잡아 주므로, 거기서 이름을 읽는 것이 가장 앞선 정본이다.
    #[test]
    fn all_tools_matches_the_tool_name_enum() {
        let source = include_str!("types.rs");
        // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일이 검사 대상처럼 보인다.
        let marker = "fn as_str".to_string() + "(&self)";
        let at = source.find(&marker).expect("ToolName::as_str를 찾지 못했습니다");
        let end = at + source[at..].find("\n    }").expect("as_str 본문이 닫히지 않았습니다");
        let arrow = "=> ".to_string() + "\"";
        let mut from_enum: Vec<&str> = source[at..end]
            .lines()
            .filter_map(|line| line.split_once(arrow.as_str()))
            .filter_map(|(_, rest)| rest.split('"').next())
            .collect();
        // 0개면 아래 비교가 빈 집합끼리의 비교가 된다 — 형식이 바뀐 경우다.
        assert!(from_enum.len() >= 8, "as_str에서 도구 이름을 {}개만 읽었습니다", from_enum.len());

        from_enum.sort_unstable();
        let mut from_list: Vec<&str> = ALL_TOOLS.iter().map(|t| t.as_str()).collect();
        from_list.sort_unstable();
        assert_eq!(
            from_list, from_enum,
            "ALL_TOOLS가 ToolName과 갈라졌습니다 — 빠진 도구는 스킬 파일에서 '알 수 없는 도구'가 됩니다"
        );
    }

    /// **모든 도구 이름이 파싱된다.** 목록과 파서가 갈라지면 새 도구는 스킬 파일에서
    /// "알 수 없는 도구"가 되고, 사용자는 우리 오타를 자기 오타로 읽는다.
    #[test]
    fn every_tool_name_round_trips() {
        for tool in ALL_TOOLS {
            assert_eq!(parse_tool(tool.as_str()), Some(*tool), "{}", tool.as_str());
        }
    }

    /// 오타는 조용히 무시되면 안 된다 — 무시하면 좁히려던 도구가 그대로 열린다.
    #[test]
    fn an_unknown_tool_is_rejected_and_the_known_names_are_shown() {
        let err = file(r#"{"name":"s","allowedTools":["read_files"]}"#).unwrap_err();
        match err {
            SkillError::UnknownTool { tool, known } => {
                assert_eq!(tool, "read_files");
                assert!(known.contains("read_file"), "{known}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// **빈 목록을 "제한 없음"으로 읽지 않는다.** 좁히려다 비운 사용자에게 정반대를 준다.
    #[test]
    fn an_empty_allowlist_is_an_error_not_unrestricted() {
        assert_eq!(file(r#"{"name":"s","allowedTools":[]}"#).unwrap_err(), SkillError::EmptyAllowlist);
    }

    /// 키가 아예 없는 것은 "좁히지 않는다"이며, 그건 빈 목록과 다른 사실이다.
    #[test]
    fn an_absent_allowlist_means_no_narrowing() {
        let skill = file(r#"{"name":"s","instructions":"x"}"#).unwrap();
        assert!(skill.allowed_tools.is_none());
    }

    /// **검증 명령은 선언하지 않아도 남는다.** 좁힐 수 있게 두면 스킬 파일 한 줄로
    /// `VERIFYING`이 조용히 꺼진다 — 원칙 1을 정면으로 깨는 경로다.
    #[test]
    fn verification_survives_an_allowlist_that_forgot_it() {
        let skill = file(r#"{"name":"s","allowedTools":["read_file"]}"#).unwrap();
        let tools = skill.allowed_tools.unwrap();
        assert!(tools.contains(&ToolName::RunTests), "{tools:?}");
        assert!(tools.contains(&ToolName::ReadFile));
        // 그 외에는 넓어지지 않았다 — 검증을 남기는 것이 전체 허용이 되면 안 된다.
        assert_eq!(tools.len(), 2, "{tools:?}");
    }

    /// 이름만 있는 스킬은 아무 일도 하지 않는다. 통과시키면 사용자는 적용됐다고 믿는다.
    #[test]
    fn a_skill_that_does_nothing_is_rejected() {
        assert_eq!(file(r#"{"name":"s"}"#).unwrap_err(), SkillError::Empty);
    }

    #[test]
    fn a_nameless_skill_is_rejected() {
        assert_eq!(file(r#"{"name":"  ","instructions":"x"}"#).unwrap_err(), SkillError::EmptyName);
    }

    /// 중복은 조용히 접는다 — 사용자 실수이지 거절할 일은 아니다.
    #[test]
    fn duplicate_tools_are_folded() {
        let skill = file(r#"{"name":"s","allowedTools":["read_file","read_file"]}"#).unwrap();
        let tools = skill.allowed_tools.unwrap();
        assert_eq!(tools.iter().filter(|t| **t == ToolName::ReadFile).count(), 1);
    }
}
