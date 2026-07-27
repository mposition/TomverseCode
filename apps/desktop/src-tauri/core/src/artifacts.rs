//! Artifact 저장소.
//!
//! docs/design/state-machine-and-protocol.md 7절: 8KB 넘는 페이로드는 `payload_json`에
//! 인라인하지 않고 `<artifacts>/<taskId>/<name>.blob`으로 쓰고 JSON에는 경로+해시만 남긴다
//! (SQLite WAL 비대화 방지).
//!
//! 기본 위치는 Windows에서 `%APPDATA%/Tomverse Code/artifacts/`다(11절). 테스트와 헤드리스
//! 호스트는 임의 경로를 주입할 수 있어야 하므로 루트를 생성자에서 받는다.

use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 이 크기를 넘는 페이로드는 artifact로 밀어낸다.
pub const INLINE_PAYLOAD_LIMIT_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone)]
pub struct ArtifactStore {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifact {
    /// artifact 루트 기준 상대경로 — DB에 저장되는 값. 절대경로를 저장하면 앱 재설치 후 깨진다.
    pub artifact_ref: String,
    pub sha256: String,
    pub size_bytes: u64,
}

impl ArtifactStore {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// `%APPDATA%/Tomverse Code/artifacts` (Windows) 또는 그에 대응하는 위치.
    pub fn default_root() -> PathBuf {
        // Windows: APPDATA. 그 외(개발·CI): XDG_DATA_HOME 또는 ~/.local/share.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("Tomverse Code").join("artifacts");
        }
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join("tomverse-code").join("artifacts");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("tomverse-code")
                .join("artifacts");
        }
        PathBuf::from(".tomverse").join("artifacts")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn put(&self, task_id: &str, name: &str, bytes: &[u8]) -> io::Result<StoredArtifact> {
        let safe_task = sanitize_component(task_id);
        let safe_name = sanitize_component(name);
        let dir = self.root.join(&safe_task);
        fs::create_dir_all(&dir)?;
        let path = dir.join(&safe_name);
        fs::write(&path, bytes)?;

        Ok(StoredArtifact {
            artifact_ref: format!("{safe_task}/{safe_name}"),
            sha256: sha256_hex(bytes),
            size_bytes: bytes.len() as u64,
        })
    }

    pub fn put_text(&self, task_id: &str, name: &str, text: &str) -> io::Result<StoredArtifact> {
        self.put(task_id, name, text.as_bytes())
    }

    pub fn read(&self, artifact_ref: &str) -> io::Result<Vec<u8>> {
        // artifact_ref는 우리가 만든 값이지만, DB에서 읽어온 값이므로 다시 검증한다.
        let path = self.resolve(artifact_ref)?;
        fs::read(path)
    }

    pub fn read_text(&self, artifact_ref: &str) -> io::Result<String> {
        let bytes = self.read(artifact_ref)?;
        String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    fn resolve(&self, artifact_ref: &str) -> io::Result<PathBuf> {
        if artifact_ref.contains("..") || artifact_ref.starts_with('/') || artifact_ref.contains('\\') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("suspicious artifact ref: {artifact_ref}"),
            ));
        }
        Ok(self.root.join(artifact_ref))
    }

    /// 태스크 디렉터리 통째로 삭제 (11절 GC). M0에서는 자동 GC 스케줄러를 돌리지 않고
    /// 이 함수만 제공한다 — 정책(30일/2GB)을 구현하기 전에 삭제 능력만 있으면 롤백/정리가 된다.
    pub fn purge_task(&self, task_id: &str) -> io::Result<()> {
        let dir = self.root.join(sanitize_component(task_id));
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }
}

/// 경로 구성요소로 안전한 문자만 남긴다. taskId/eventId는 우리가 만들지만,
/// 방어적으로 처리하지 않으면 디렉터리 탈출 가능성이 생긴다.
fn sanitize_component(raw: &str) -> String {
    let mut cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // 연속된 점은 상위 디렉터리 참조가 될 수 있으므로 하나로 접는다.
    // 확장자(마지막 점 하나)는 보존해야 하므로 문자열을 잘라내지 않고 치환만 한다.
    while cleaned.contains("..") {
        cleaned = cleaned.replace("..", "_");
    }
    let trimmed = cleaned.trim_start_matches('.');
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(dir.path()).unwrap();
        let stored = store.put_text("task-1", "event-3.blob", "hello").unwrap();
        assert_eq!(stored.artifact_ref, "task-1/event-3.blob");
        assert_eq!(stored.size_bytes, 5);
        assert_eq!(store.read_text(&stored.artifact_ref).unwrap(), "hello");
        assert_eq!(stored.sha256, sha256_hex(b"hello"));
    }

    #[test]
    fn rejects_traversal_in_ref() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(dir.path()).unwrap();
        assert!(store.read("../../etc/passwd").is_err());
    }

    #[test]
    fn sanitizes_path_components() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(dir.path()).unwrap();
        let stored = store.put_text("../evil", "../../x.blob", "x").unwrap();
        assert!(!stored.artifact_ref.contains(".."), "got {}", stored.artifact_ref);
        assert!(store.read(&stored.artifact_ref).is_ok());
    }

    #[test]
    fn purge_removes_task_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(dir.path()).unwrap();
        store.put_text("task-1", "a.blob", "x").unwrap();
        store.purge_task("task-1").unwrap();
        assert!(store.read("task-1/a.blob").is_err());
    }
}
