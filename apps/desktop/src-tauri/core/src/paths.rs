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

    /// 이 경로가 워크스페이스 **안**인가 (state-machine 34절).
    ///
    /// `resolve_existing`과 목적이 다르다. 저건 "모델이 준 상대경로를 안전하게 푼다"이고,
    /// 이건 **사용자가 고른 절대경로가 모델이 쓸 수 있는 자리인지** 묻는다 — 답이 "예"면
    /// 그 파일의 내용은 모델이 바꿀 수 있다.
    ///
    /// **canonical로 비교한다.** `..`이나 심링크로 우회할 수 있으면 이 질문의 답이 거짓이
    /// 되고, 그 거짓은 "안전한 자리에서 읽었다"는 결론으로 이어진다. 워크스페이스 안의
    /// 심링크가 밖을 가리키면 그 실체는 밖이므로 안이 아니다 — 그리고 그 심링크를 모델이
    /// 다시 안쪽으로 돌리면 canonical이 안이 되어 여기서 걸린다.
    ///
    /// 존재하지 않는 경로는 `false`다. 없는 파일은 읽기에서 실패하고, **그 실패는 여기서
    /// 만드는 것보다 원인에 가깝다.**
    pub fn contains(&self, path: &Path) -> bool {
        match dunce_canonicalize(path) {
            Ok(canonical) => canonical.starts_with(&self.canonical),
            Err(_) => false,
        }
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

    /// workspace 밖에 **실제로 존재하는** 파일을 만들고 그 절대경로를 넘긴다.
    ///
    /// OS별 하드코딩 경로(`/etc/passwd`)를 쓰지 않는 이유: Windows에서 `/etc/passwd`는
    /// `Path::is_absolute()`가 **false**다(드라이브 접두사가 없어 "루트 상대" 경로로 해석된다).
    /// 그래서 절대경로 분기에 들어가지 않고 workspace에 이어 붙여져 `NotFound`가 되며,
    /// 테스트가 의도한 `AbsoluteOutsideWorkspace` 경로를 **전혀 검증하지 못했다.**
    /// 실제 임시 디렉터리에서 절대경로를 만들면 두 OS에서 같은 의미가 된다.
    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let (_dir, root) = workspace();

        // workspace와 완전히 별개인 임시 디렉터리 — 형제 관계이므로 절대 중첩되지 않는다.
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("stolen.txt");
        fs::write(&outside_file, "workspace 밖의 내용\n").unwrap();

        // 전제 확인: 이 경로가 두 OS 모두에서 실제로 절대경로여야 테스트가 의미를 가진다.
        assert!(
            outside_file.is_absolute(),
            "테스트 전제 실패 — 절대경로가 아니면 검증하려는 분기에 들어가지 않습니다: {outside_file:?}"
        );
        assert!(outside_file.exists(), "테스트 전제 실패 — 파일이 실제로 있어야 합니다");

        assert_eq!(
            root.resolve_existing(&outside_file.to_string_lossy()).unwrap_err(),
            PathViolation::AbsoluteOutsideWorkspace
        );

        // 쓰기 경로도 같은 판정이어야 한다 — 읽기만 막고 쓰기가 열려 있으면 의미가 없다.
        assert_eq!(
            root.resolve_for_create(&outside_file.to_string_lossy()).unwrap_err(),
            PathViolation::AbsoluteOutsideWorkspace
        );
    }

    /// 함정 기록: Windows에서 `/etc/passwd`류는 절대경로가 **아니다.**
    ///
    /// `Path::is_absolute()`는 Windows에서 접두사(`C:`)와 루트를 모두 요구하므로 `/etc/passwd`는
    /// false다. 따라서 workspace에 이어 붙여져 `NotFound`가 된다 — 탈출이 허용되는 것은 아니지만
    /// **`AbsoluteOutsideWorkspace` 분기를 검증하지 못한다.** 이 사실을 테스트로 못박아두면
    /// 다음 사람이 문자열 특수 처리로 "고치려는" 시도를 막을 수 있다.
    #[cfg(windows)]
    #[test]
    fn posix_root_relative_paths_are_not_absolute_on_windows() {
        let (_dir, root) = workspace();
        assert!(!Path::new("/etc/passwd").is_absolute());
        // workspace 상대로 해석되어 존재하지 않으므로 NotFound. 탈출은 여전히 일어나지 않는다.
        assert_eq!(
            root.resolve_existing("/etc/passwd").unwrap_err(),
            PathViolation::NotFound
        );
    }

    /// 같은 경로가 Unix에서는 진짜 절대경로다 — 같은 입력이 OS에 따라 다른 판정을 받는다는
    /// 사실 자체를 남겨둔다. 그래서 위 `rejects_absolute_path_outside_workspace`가
    /// 하드코딩 문자열이 아니라 실제 임시 디렉터리를 써야 한다.
    #[cfg(unix)]
    #[test]
    fn posix_root_relative_paths_are_absolute_on_unix() {
        let (_dir, root) = workspace();
        assert!(Path::new("/etc").is_absolute());
        assert_eq!(
            root.resolve_existing("/etc").unwrap_err(),
            PathViolation::AbsoluteOutsideWorkspace
        );
    }

    /// 아직 없는 workspace 밖 절대경로도 거부해야 한다.
    /// 존재 여부로 갈리면 "없는 파일을 만들어 탈출"이 열린다.
    #[test]
    fn rejects_absolute_path_outside_workspace_even_when_missing() {
        let (_dir, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        let missing = outside.path().join("not-created-yet.txt");
        assert!(missing.is_absolute());
        assert!(!missing.exists());

        assert_eq!(
            root.resolve_for_create(&missing.to_string_lossy()).unwrap_err(),
            PathViolation::AbsoluteOutsideWorkspace
        );
    }

    #[test]
    fn accepts_absolute_path_inside_workspace() {
        let (_dir, root) = workspace();
        let abs = root.path().join("src/app.ts");
        assert!(abs.is_absolute());
        let safe = root.resolve_existing(&abs.to_string_lossy()).unwrap();
        assert_eq!(safe.relative(), "src/app.ts");

        // 아직 없는 workspace 내부 절대경로는 **생성 대상으로는** 허용된다.
        let new_abs = root.path().join("src/new.ts");
        let safe = root.resolve_for_create(&new_abs.to_string_lossy()).unwrap();
        assert_eq!(safe.relative(), "src/new.ts");
    }

    /// §2.1이 요구하는 네 판정이 **한 곳에서** 서로 구별되는지 본다.
    /// 개별 테스트로 흩어 두면 "셋 다 통과하지만 서로 뭉개진 경우"를 놓친다.
    #[test]
    fn path_violations_are_distinguishable_on_every_os() {
        let (_dir, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("stolen.txt");
        fs::write(&outside_file, "x").unwrap();

        let cases: Vec<(&str, String, PathViolation)> = vec![
            (
                "workspace 밖 절대경로",
                outside_file.to_string_lossy().to_string(),
                PathViolation::AbsoluteOutsideWorkspace,
            ),
            (
                "없는 workspace 내부 상대경로",
                "src/missing.ts".to_string(),
                PathViolation::NotFound,
            ),
            (
                "상위 탐색",
                "../outside.txt".to_string(),
                PathViolation::ParentTraversal,
            ),
            (
                "workspace 안으로 되돌아오는 상위 탐색",
                "src/../src/app.ts".to_string(),
                PathViolation::ParentTraversal,
            ),
        ];

        for (label, candidate, expected) in cases {
            assert_eq!(
                root.resolve_existing(&candidate).unwrap_err(),
                expected,
                "{label}: 기대한 위반과 다릅니다"
            );
        }

        // 그리고 정상 경로는 통과해야 한다 — 전부 거부하는 것으로는 위 단정이 무의미하다.
        assert_eq!(root.resolve_existing("src/app.ts").unwrap().relative(), "src/app.ts");
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

/// 워크스페이스 루트 경로 → 워크스페이스 id.
///
/// **한 곳에만 둔다.** 종전에는 Tauri 껍데기와 헤드리스 호스트가 각자 같은 FNV 해시를
/// 복사해 갖고 있었다. 두 벌이 갈라지면 같은 폴더가 서로 다른 워크스페이스가 되고, 그러면
/// 작업 이력과 인덱스 캐시가 조용히 둘로 나뉜다 — 증상은 "이력이 사라졌다"로만 보인다.
///
/// 값 자체는 **경로의 함수**여야 한다(난수가 아니다). 앱을 다시 켜도 같은 폴더가 같은
/// 워크스페이스여야 이력이 이어진다.
pub fn workspace_id_for(root_display: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in root_display.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("ws-{hash:x}")
}

#[cfg(test)]
mod workspace_id_tests {
    use super::workspace_id_for;

    /// 같은 경로는 언제나 같은 id. 앱을 다시 켜도 이력이 이어지는 근거다.
    #[test]
    fn the_same_path_always_maps_to_the_same_id() {
        assert_eq!(workspace_id_for("/work/alpha"), workspace_id_for("/work/alpha"));
    }

    /// 다른 경로는 다른 id. 같아지면 두 프로젝트의 이력과 인덱스가 섞인다.
    #[test]
    fn different_paths_map_to_different_ids() {
        assert_ne!(workspace_id_for("/work/alpha"), workspace_id_for("/work/beta"));
        // 대소문자와 구분자 차이도 다른 값이다 — 정규화는 `WorkspaceRoot`가 이미 했다.
        assert_ne!(workspace_id_for("/work/alpha"), workspace_id_for("/work/Alpha"));
    }

    /// 접두사가 붙어 있어야 로그에서 이 값이 무엇인지 알아볼 수 있다.
    #[test]
    fn the_id_is_prefixed() {
        assert!(workspace_id_for("/work/alpha").starts_with("ws-"));
    }
}
