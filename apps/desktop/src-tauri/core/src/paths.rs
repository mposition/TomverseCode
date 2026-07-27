//! Workspace 경계 강제.
//!
//! 작업 지침 3.3절: 모든 경로를 canonicalize한다. 상대경로 / `..` / junction / symlink를
//! 이용한 workspace 탈출을 차단한다. workspace 밖 쓰기·삭제는 기본 거부.
//!
//! 이 모듈이 이 저장소에서 가장 되돌리기 비싼 코드다 — 여기가 뚫리면 Policy Gate의 나머지
//! 규칙이 전부 무의미해진다. 그래서 "허용할 이유를 찾는" 구조가 아니라 "거부할 이유가 하나도
//! 없을 때만 통과시키는" 구조로 짰다.

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathViolation {
    /// `..` 세그먼트가 포함됨 (canonicalize 이전에 형태만으로 거부)
    ParentTraversal,
    /// 절대경로인데 workspace 밖을 가리킴
    AbsoluteOutsideWorkspace,
    /// canonicalize 결과가 workspace root 밖 — symlink/junction 탈출을 포함한다
    EscapesWorkspace,
    /// 경로 구성요소 중 하나가 workspace 밖을 가리키는 symlink였다
    SymlinkEscape { at: String },
    /// NUL 등 파일 이름에 쓸 수 없는 문자
    InvalidPathString(String),
    /// 존재해야 하는 경로가 없음
    NotFound,
    /// 상위 디렉터리를 확인할 수 없음
    UnresolvableParent(String),
}

impl fmt::Display for PathViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathViolation::ParentTraversal => write!(f, r#"path contains a ".." segment"#),
            PathViolation::AbsoluteOutsideWorkspace => {
                write!(f, "absolute path points outside the workspace root")
            }
            PathViolation::EscapesWorkspace => write!(f, "resolved path escapes the workspace root"),
            PathViolation::SymlinkEscape { at } => {
                write!(
                    f,
                    "path component {at:?} is a symlink pointing outside the workspace root"
                )
            }
            PathViolation::InvalidPathString(why) => write!(f, "invalid path: {why}"),
            PathViolation::NotFound => write!(f, "path does not exist"),
            PathViolation::UnresolvableParent(why) => write!(f, "cannot resolve parent directory: {why}"),
        }
    }
}

impl std::error::Error for PathViolation {}

/// canonicalize된 workspace 루트. 이 타입을 갖고 있다는 것 자체가 "루트가 실재하고
/// 정규화되었다"는 증명이므로, 아래 함수들은 루트를 다시 검사하지 않는다.
#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    canonical: PathBuf,
}

/// 검증을 통과한 workspace 내부 경로. `ToolRuntime`은 이 타입만 받는다 —
/// `&Path`를 받는 API를 두지 않는 것이 "검증을 건너뛴 호출"을 타입으로 막는 방법이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafePath {
    absolute: PathBuf,
    /// workspace root 기준 상대경로, 항상 `/` 구분자 (표시·저장용 정규형)
    relative: String,
}

impl SafePath {
    pub fn absolute(&self) -> &Path {
        &self.absolute
    }
    pub fn relative(&self) -> &str {
        &self.relative
    }
}

impl WorkspaceRoot {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, io::Error> {
        let canonical = dunce_canonicalize(root.as_ref())?;
        if !canonical.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                format!("workspace root is not a directory: {}", canonical.display()),
            ));
        }
        Ok(Self { canonical })
    }

    pub fn path(&self) -> &Path {
        &self.canonical
    }

    pub fn display(&self) -> String {
        self.canonical.display().to_string()
    }

    /// 이미 존재해야 하는 경로 해석 (읽기, 삭제, patch 적용 대상).
    /// canonicalize가 symlink를 끝까지 따라가므로 symlink/junction 탈출이 여기서 잡힌다.
    pub fn resolve_existing(&self, candidate: &str) -> Result<SafePath, PathViolation> {
        let joined = self.join_checked(candidate)?;
        let canonical = dunce_canonicalize(&joined).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => PathViolation::NotFound,
            _ => PathViolation::InvalidPathString(e.to_string()),
        })?;
        self.confine(canonical)
    }

    /// 아직 없어도 되는 경로 해석 (생성 대상).
    ///
    /// 대상 자체는 canonicalize할 수 없으므로 **존재하는 가장 가까운 조상**을 canonicalize한 뒤
    /// 남은 세그먼트를 이어 붙인다. 이렇게 하면 `safe_dir_symlink_to_outside/new.txt` 같은
    /// 경로에서도 조상 단계에서 탈출이 잡힌다 — 조상을 검사하지 않고 문자열만 정규화하면
    /// symlink된 디렉터리 안에 파일을 만들 수 있게 된다.
    pub fn resolve_for_create(&self, candidate: &str) -> Result<SafePath, PathViolation> {
        let joined = self.join_checked(candidate)?;

        let mut existing = joined.as_path();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if existing.exists() {
                break;
            }
            let Some(name) = existing.file_name() else {
                return Err(PathViolation::UnresolvableParent(
                    "reached filesystem root without finding an existing ancestor".to_string(),
                ));
            };
            tail.push(name.to_os_string());
            match existing.parent() {
                Some(parent) => existing = parent,
                None => return Err(PathViolation::UnresolvableParent("path has no parent".to_string())),
            }
        }

        let canonical_ancestor =
            dunce_canonicalize(existing).map_err(|e| PathViolation::UnresolvableParent(e.to_string()))?;
        // 조상이 workspace 안인지 먼저 확인한다.
        let confined_ancestor = self.confine(canonical_ancestor)?;

        let mut full = confined_ancestor.absolute;
        for name in tail.iter().rev() {
            full.push(name);
        }
        self.confine(full)
    }

    /// 후보 문자열의 형태 검사 + 루트에 결합. canonicalize는 하지 않는다.
    fn join_checked(&self, candidate: &str) -> Result<PathBuf, PathViolation> {
        if candidate.contains('\0') {
            return Err(PathViolation::InvalidPathString("contains a NUL byte".into()));
        }
        if candidate.trim().is_empty() {
            return Err(PathViolation::InvalidPathString("empty path".into()));
        }

        let candidate_path = Path::new(candidate);

        // `..`는 canonicalize가 지워버리기 전에 형태로 거부한다. 그래야 감사 로그에
        // "탈출 시도가 있었다"가 남고, 우연히 workspace 안으로 되돌아오는 경로
        // (`a/../b`)도 정책상 거부로 일관되게 처리된다.
        if candidate_path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(PathViolation::ParentTraversal);
        }

        if candidate_path.is_absolute() || has_windows_prefix(candidate_path) {
            // 절대경로도 workspace 내부라면 허용한다 — UI가 절대경로를 넘기는 경우가 있다.
            // 다만 여기서는 형태만 보고, 실제 판정은 confine()이 한다.
            if !candidate_path.starts_with(&self.canonical) {
                // 아직 canonicalize 전이므로 여기서 확정하지 않는다. symlink를 통한 진입은
                // resolve_* 쪽 canonicalize에서 최종 판정된다.
                let looks_inside = dunce_canonicalize(candidate_path)
                    .map(|c| c.starts_with(&self.canonical))
                    .unwrap_or(false);
                if !looks_inside {
                    return Err(PathViolation::AbsoluteOutsideWorkspace);
                }
            }
            return Ok(candidate_path.to_path_buf());
        }

        Ok(self.canonical.join(candidate_path))
    }

    /// canonicalize된 절대경로가 루트 안에 있는지 최종 확인하고 `SafePath`로 봉인한다.
    fn confine(&self, canonical: PathBuf) -> Result<SafePath, PathViolation> {
        let relative = canonical
            .strip_prefix(&self.canonical)
            .map_err(|_| PathViolation::EscapesWorkspace)?;

        let relative_str = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");

        Ok(SafePath {
            absolute: canonical,
            // 루트 자체를 가리키면 상대경로는 "." 이다.
            relative: if relative_str.is_empty() {
                ".".to_string()
            } else {
                relative_str
            },
        })
    }

    /// 명령 인자 중 경로처럼 보이는 것의 하드 체크 (state-machine-and-protocol.md 5.2절 마지막 문단).
    /// 규칙 매칭 여부와 무관하게 항상 적용된다.
    pub fn check_command_arg(&self, arg: &str) -> Result<(), PathViolation> {
        for candidate in path_candidates_in_arg(arg) {
            // 존재하지 않아도 되는 경로일 수 있으므로 create 규칙으로 판정한다.
            match self.resolve_for_create(&candidate) {
                Ok(_) => {}
                // 조상을 못 찾는 경우는 workspace와 무관한 문자열일 가능성이 높으므로
                // 경로 인자가 아니었다고 보고 통과시킨다 — 여기서 거부하면 값에 슬래시가 들어간
                // 정상 인자(`--reporter=spec/json` 같은 것)를 경로로 오인해 막는다.
                Err(PathViolation::UnresolvableParent(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// 인자 하나에서 경로로 볼 만한 부분들을 뽑는다.
///
/// `--flag` 자체는 경로가 아니지만 **`--out=../../etc/passwd`의 값 부분은 경로다.** 플래그로
/// 시작하는 인자를 통째로 건너뛰면 여기로 탈출할 수 있으므로, `=` 뒤와 `:` 뒤를 각각 검사한다.
fn path_candidates_in_arg(arg: &str) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();

    let mut push_if_pathlike = |value: &str| {
        if looks_like_path(value) {
            candidates.push(value.to_string());
        }
    };

    if arg.starts_with('-') {
        // `--out=path`, `-o=path` 형태의 값 부분.
        if let Some((_, value)) = arg.split_once('=') {
            push_if_pathlike(value);
        }
    } else {
        push_if_pathlike(arg);
        // `src=dest` 같은 형태도 양쪽을 본다.
        if let Some((left, right)) = arg.split_once('=') {
            push_if_pathlike(left);
            push_if_pathlike(right);
        }
    }

    candidates
}

/// 구분자를 포함하거나 절대경로 형태면 경로로 본다.
fn looks_like_path(arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    arg.contains('/') || arg.contains('\\') || Path::new(arg).is_absolute() || has_windows_prefix(Path::new(arg))
}

fn has_windows_prefix(path: &Path) -> bool {
    matches!(path.components().next(), Some(Component::Prefix(_)))
}

/// Windows에서 `std::fs::canonicalize`는 `\\?\` verbatim 프리픽스를 붙이는데, 그 형태는
/// 일부 API와 사용자에게 보여줄 문자열로 부적합하다. dunce 크레이트를 추가하는 대신
/// 필요한 최소 동작만 직접 처리한다 (의존성을 늘리지 않는다는 지침).
fn dunce_canonicalize(path: &Path) -> io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    Ok(strip_verbatim_prefix(canonical))
}

#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    const VERBATIM: &str = r"\\?\";
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(VERBATIM) {
        // UNC verbatim(`\\?\UNC\server\share`)은 건드리지 않는다 — 잘못 변환하면 경로가 깨진다.
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest.to_string());
        }
    }
    path
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> (tempfile::TempDir, WorkspaceRoot) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/app.ts"), "export const a = 1;\n").unwrap();
        let root = WorkspaceRoot::new(dir.path()).unwrap();
        (dir, root)
    }

    #[test]
    fn resolves_path_inside_workspace() {
        let (_dir, root) = workspace();
        let safe = root.resolve_existing("src/app.ts").unwrap();
        assert_eq!(safe.relative(), "src/app.ts");
        assert!(safe.absolute().starts_with(root.path()));
    }

    #[test]
    fn rejects_parent_traversal() {
        let (_dir, root) = workspace();
        assert_eq!(
            root.resolve_existing("../outside.txt").unwrap_err(),
            PathViolation::ParentTraversal
        );
        // workspace 안으로 되돌아오는 형태도 거부한다 — 감사 로그에 시도가 남아야 한다.
        assert_eq!(
            root.resolve_existing("src/../src/app.ts").unwrap_err(),
            PathViolation::ParentTraversal
        );
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let (_dir, root) = workspace();
        let err = root.resolve_existing("/etc/passwd").unwrap_err();
        assert_eq!(err, PathViolation::AbsoluteOutsideWorkspace);
    }

    #[test]
    fn accepts_absolute_path_inside_workspace() {
        let (_dir, root) = workspace();
        let abs = root.path().join("src/app.ts");
        let safe = root.resolve_existing(&abs.to_string_lossy()).unwrap();
        assert_eq!(safe.relative(), "src/app.ts");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let (dir, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "TOP SECRET\n").unwrap();

        std::os::unix::fs::symlink(outside.path().join("secret.txt"), dir.path().join("link.txt")).unwrap();
        assert_eq!(
            root.resolve_existing("link.txt").unwrap_err(),
            PathViolation::EscapesWorkspace
        );

        // 디렉터리 symlink를 통한 "생성" 탈출도 막아야 한다 — 대상 파일이 아직 없으므로
        // canonicalize할 수 없고, 조상을 검사하지 않으면 여기서 뚫린다.
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape_dir")).unwrap();
        assert_eq!(
            root.resolve_for_create("escape_dir/new.txt").unwrap_err(),
            PathViolation::EscapesWorkspace
        );
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_that_stays_inside_workspace() {
        let (dir, root) = workspace();
        std::os::unix::fs::symlink(dir.path().join("src/app.ts"), dir.path().join("alias.ts")).unwrap();
        let safe = root.resolve_existing("alias.ts").unwrap();
        // canonicalize가 symlink를 따라가므로 실제 대상 경로로 정규화된다.
        assert_eq!(safe.relative(), "src/app.ts");
    }

    #[test]
    fn resolve_for_create_allows_new_nested_file() {
        let (_dir, root) = workspace();
        let safe = root.resolve_for_create("src/nested/deep/new.ts").unwrap();
        assert_eq!(safe.relative(), "src/nested/deep/new.ts");
    }

    #[test]
    fn resolve_for_create_rejects_traversal() {
        let (_dir, root) = workspace();
        assert_eq!(
            root.resolve_for_create("../evil.ts").unwrap_err(),
            PathViolation::ParentTraversal
        );
    }

    #[test]
    fn resolve_existing_reports_not_found_separately_from_escape() {
        let (_dir, root) = workspace();
        assert_eq!(
            root.resolve_existing("src/missing.ts").unwrap_err(),
            PathViolation::NotFound
        );
    }

    #[test]
    fn command_arg_path_check() {
        let (_dir, root) = workspace();
        assert!(root.check_command_arg("--coverage").is_ok());
        assert!(root.check_command_arg("test").is_ok());
        assert!(root.check_command_arg("src/app.ts").is_ok());
        assert!(root.check_command_arg("../../etc/passwd").is_err());
        assert!(root.check_command_arg("/etc/passwd").is_err());
    }

    #[test]
    fn command_arg_check_looks_inside_flag_values() {
        // `-`로 시작하는 인자를 통째로 건너뛰면 여기로 탈출할 수 있다.
        let (_dir, root) = workspace();
        assert!(root.check_command_arg("--out=../../etc/passwd").is_err());
        assert!(root.check_command_arg("--out=/etc/passwd").is_err());
        assert!(root.check_command_arg("-o=../outside.txt").is_err());
        // 정상적인 플래그 값은 통과해야 한다.
        assert!(root.check_command_arg("--out=src/build").is_ok());
        assert!(root.check_command_arg("--reporter=spec").is_ok());
        assert!(root.check_command_arg("--max-old-space-size=4096").is_ok());
    }

    #[test]
    fn root_itself_resolves_to_dot() {
        let (_dir, root) = workspace();
        assert_eq!(root.resolve_existing(".").unwrap().relative(), ".");
    }
}
