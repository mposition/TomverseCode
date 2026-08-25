//! Git worktree 격리 — product-strategy.md 8.2절("Git worktree · 브랜치별 격리"), M2.
//!
//! # 이 모듈이 푸는 문제
//!
//! 태스크를 사용자의 작업 트리에서 바로 돌리면, 실패하거나 취소된 태스크의 잔해가 사용자가
//! 손대던 파일과 섞인다. worktree는 **같은 저장소의 다른 체크아웃**이므로 격리 비용이
//! 복제보다 훨씬 싸다(객체 데이터베이스를 공유한다).
//!
//! # 모델은 worktree를 만들 수 없다
//!
//! 여기에는 `ToolRequest`가 없다. 즉 **Node도 모델도 이 코드를 호출할 수 없고**, 호스트(사람이
//! 시작한 명령)만 부른다. 이유는 원칙 2다 — worktree 생성은 새 경로를 만들고 그 경로가 곧
//! 다음 태스크의 Policy Gate 루트가 된다. 모델이 루트를 고를 수 있으면 게이트는 게이트가 아니다.
//!
//! # 만든 경로가 곧 루트다
//!
//! 격리 실행은 "worktree를 만들고 그 경로를 `WorkspaceRoot`로 준다"이다. 별도의 우회 규칙을
//! 두지 않는 것이 요점이다 — 게이트 코드는 자기가 worktree 안에 있는지조차 알 필요가 없다.
//!
//! # worktree를 저장소 **안에** 만들지 않는다
//!
//! 안에 만들면 부모 워크스페이스의 게이트 루트가 그 디렉터리를 포함한다. 그러면 본체에서
//! 도는 태스크가 격리된 트리의 파일을 고칠 수 있고, **격리라고 부르는 것이 격리가 아니게 된다.**
//! 그래서 호출자가 주는 별도 디렉터리(앱 상태 디렉터리) 아래에 만든다.

use std::path::{Path, PathBuf};
use std::process::Command;

/// 이 저장소가 만든 worktree 디렉터리 이름의 접두사.
///
/// 접두사를 두는 이유: `git worktree list`에는 사용자가 손으로 만든 것도 함께 나온다.
/// **우리가 만들지 않은 것을 정리 대상으로 세면 남의 작업을 지운다.**
pub const WORKTREE_PREFIX: &str = "tomverse-";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
    /// 이번 호출이 만들었는가. `false`면 이미 있던 것을 재사용했다.
    ///
    /// 구별하는 이유: 재사용된 트리에는 **이전 실행의 잔해가 남아 있을 수 있다.** 화면이
    /// "새로 만들었다"와 "이어 쓴다"를 같은 말로 하면 사용자는 깨끗한 상태를 가정한다.
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeError {
    /// 브랜치 이름이 우리가 다룰 수 있는 모양이 아니다.
    InvalidBranch { branch: String, reason: String },
    /// 그 브랜치가 이미 다른 worktree에 체크아웃되어 있다 (git이 거부한다).
    ///
    /// 일반 실패와 나누는 이유: 사용자가 **할 수 있는 일이 다르다** — 그쪽 트리를 정리하거나
    /// 다른 브랜치를 고르면 된다. 뭉뚱그리면 "git 실패"만 보인다.
    BranchAlreadyCheckedOut { branch: String, at: String },
    /// 저장소가 아니거나 git을 실행할 수 없다.
    NotARepository { detail: String },
    /// 정리하려는 트리에 커밋되지 않은 변경이 있다.
    ///
    /// **기본값은 지우지 않는 것이다.** `--force`는 사용자의 작업을 버리는 행위라 우리가
    /// 대신 고를 수 없다.
    Dirty { path: PathBuf },
    Failed { operation: String, detail: String },
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBranch { branch, reason } => {
                write!(f, "브랜치 이름을 쓸 수 없습니다 ({branch}): {reason}")
            }
            Self::BranchAlreadyCheckedOut { branch, at } => write!(
                f,
                "{branch} 브랜치가 이미 다른 worktree에 체크아웃되어 있습니다: {at}"
            ),
            Self::NotARepository { detail } => write!(f, "git 저장소가 아닙니다: {detail}"),
            Self::Dirty { path } => write!(
                f,
                "커밋되지 않은 변경이 있어 정리하지 않았습니다: {} (버리려면 force가 필요합니다)",
                path.display()
            ),
            Self::Failed { operation, detail } => write!(f, "git worktree {operation} 실패: {detail}"),
        }
    }
}

/// 브랜치 이름이 **인자로 안전하고 경로 조각으로도 안전한가**.
///
/// 두 가지를 동시에 막는다.
///
/// - `-`로 시작하면 git이 **플래그로 읽는다.** `--force` 같은 이름이 인자 자리에 들어가면
///   우리가 부르지 않은 동작이 실행된다. argv 배열을 쓰는 것만으로는 이걸 못 막는다 —
///   원칙 6이 막는 것은 셸 재해석이지 플래그 해석이 아니다.
/// - `/`·`..`·`\`가 들어가면 파생 디렉터리 이름이 상위로 탈출한다.
///
/// git이 허용하는 이름 전부를 받지는 않는다(예: `feature/x`). **못 받는 것을 조용히 바꾸지
/// 않고 거부한다** — 이름을 우리가 바꾸면 사용자가 만든 브랜치와 다른 브랜치가 생긴다.
pub fn validate_branch(branch: &str) -> Result<(), WorktreeError> {
    let invalid = |reason: &str| {
        Err(WorktreeError::InvalidBranch {
            branch: branch.to_string(),
            reason: reason.to_string(),
        })
    };
    if branch.is_empty() {
        return invalid("비어 있습니다");
    }
    if branch.len() > 200 {
        return invalid("너무 깁니다 (200자 이하)");
    }
    if branch.starts_with('-') {
        return invalid("`-`로 시작하면 git이 플래그로 읽습니다");
    }
    if branch.contains("..") {
        return invalid("`..`를 포함할 수 없습니다");
    }
    if !branch
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return invalid("영숫자와 `-` `_` `.`만 쓸 수 있습니다");
    }
    Ok(())
}

/// 이 브랜치를 위한 worktree 디렉터리 이름.
///
/// 브랜치 이름을 **그대로** 쓰지 않고 접두사를 붙인다 — `git worktree list`에서 우리 것을
/// 구별하기 위해서다(정리 대상 판정이 여기 달려 있다).
pub fn directory_name(branch: &str) -> String {
    format!("{WORKTREE_PREFIX}{branch}")
}

fn git(repo: &Path, args: &[&str]) -> Result<std::process::Output, WorktreeError> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| WorktreeError::NotARepository {
            detail: format!("git을 실행할 수 없습니다: {e}"),
        })
}

fn stderr_of(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

/// 브랜치용 worktree를 확보한다. 이미 있으면 **재사용**하고 `created: false`로 알린다.
///
/// `base`는 브랜치가 아직 없을 때 어디서 만들 것인가다. 브랜치가 이미 있으면 무시된다 —
/// 있는 브랜치를 다른 지점으로 옮기는 것은 사용자의 이력을 바꾸는 일이라 여기서 하지 않는다.
pub fn ensure(repo: &Path, parent_dir: &Path, branch: &str, base: Option<&str>) -> Result<Worktree, WorktreeError> {
    validate_branch(branch)?;
    if let Some(base) = base {
        validate_branch(base)?;
    }
    // 저장소인지 먼저 확인한다 — 아니면 아래 실패가 전부 "worktree add 실패"로 뭉뚱그려진다.
    let inside = git(repo, &["rev-parse", "--is-inside-work-tree"])?;
    if !inside.status.success() {
        return Err(WorktreeError::NotARepository { detail: stderr_of(&inside) });
    }

    let path = parent_dir.join(directory_name(branch));
    // 이미 등록된 worktree면 그대로 쓴다. 경로만 보고 판단하지 않는 이유: 디렉터리가 남아
    // 있어도 git이 모르는 상태(수동 삭제 후 prune 전)가 있고, 그때 재사용하면 git이 거부한다.
    if list(repo)?.iter().any(|w| w.path == path) && path.is_dir() {
        return Ok(Worktree { path, branch: branch.to_string(), created: false });
    }

    std::fs::create_dir_all(parent_dir).map_err(|e| WorktreeError::Failed {
        operation: "add".to_string(),
        detail: format!("상위 디렉터리를 만들 수 없습니다: {e}"),
    })?;

    let path_arg = path.to_string_lossy().to_string();
    let branch_exists = git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])?
        .status
        .success();

    // **`--`로 옵션 끝을 표시한다.** validate_branch가 이미 `-` 시작을 막지만, 방어를 한
    // 겹으로 두면 그 검사가 완화될 때 조용히 뚫린다.
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if !branch_exists {
        args.push("-b".into());
        args.push(branch.into());
    }
    args.push("--".into());
    args.push(path_arg);
    if branch_exists {
        args.push(branch.into());
    } else if let Some(base) = base {
        args.push(base.into());
    }

    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git(repo, &borrowed)?;
    if !out.status.success() {
        let detail = stderr_of(&out);
        // git이 이 경우를 문장으로만 알려주므로 여기서 구조로 바꾼다.
        if detail.contains("already used by worktree") || detail.contains("is already checked out") {
            return Err(WorktreeError::BranchAlreadyCheckedOut {
                branch: branch.to_string(),
                at: detail,
            });
        }
        return Err(WorktreeError::Failed { operation: "add".to_string(), detail });
    }
    Ok(Worktree { path, branch: branch.to_string(), created: true })
}

/// 등록된 worktree 목록. **본체(주 작업 트리)는 빼고** 준다 — 정리 대상이 아니다.
pub fn list(repo: &Path) -> Result<Vec<Worktree>, WorktreeError> {
    let out = git(repo, &["worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        return Err(WorktreeError::NotARepository { detail: stderr_of(&out) });
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut found = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch = String::new();
    let mut first = true;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(rest));
            branch.clear();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = rest.trim_start_matches("refs/heads/").to_string();
        } else if line.is_empty() {
            if let Some(p) = path.take() {
                // 첫 항목은 본체다.
                if !first {
                    found.push(Worktree { path: p, branch: std::mem::take(&mut branch), created: false });
                }
                first = false;
            }
        }
    }
    if let Some(p) = path {
        if !first {
            found.push(Worktree { path: p, branch, created: false });
        }
    }
    Ok(found)
}

/// **우리가 만든** worktree만 고른다. 접두사로 판정한다.
pub fn ours(worktrees: &[Worktree]) -> Vec<&Worktree> {
    worktrees
        .iter()
        .filter(|w| {
            w.path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(WORKTREE_PREFIX))
        })
        .collect()
}

/// 커밋되지 않은 변경이 있는가. 판정할 수 없으면 **있다고 본다**(fail-closed) —
/// 모르는 상태에서 지우는 것이 모르는 상태에서 남기는 것보다 나쁘다.
pub fn is_dirty(worktree: &Path) -> bool {
    match git(worktree, &["status", "--porcelain"]) {
        Ok(out) if out.status.success() => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        _ => true,
    }
}

/// worktree를 정리한다.
///
/// `force`는 **사용자의 커밋되지 않은 작업을 버린다.** 그래서 기본이 아니고, 더러운 트리는
/// 지우지 않고 `Dirty`로 돌려준다 — 버릴지는 사용자가 정한다.
pub fn remove(repo: &Path, worktree: &Path, force: bool) -> Result<(), WorktreeError> {
    if !force && is_dirty(worktree) {
        return Err(WorktreeError::Dirty { path: worktree.to_path_buf() });
    }
    let path_arg = worktree.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push("--".into());
    args.push(path_arg);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git(repo, &borrowed)?;
    if !out.status.success() {
        return Err(WorktreeError::Failed { operation: "remove".to_string(), detail: stderr_of(&out) });
    }
    Ok(())
}

/// 격리 트리들이 사는 디렉터리.
///
/// **이 지식을 두 곳에 두지 않는다.** 헤드리스 호스트와 데스크톱이 각자 계산하면 한쪽만
/// 고쳐졌을 때 같은 브랜치로 두 개의 트리가 생기고, 사용자에게는 "지웠는데 남아 있다"로 보인다.
/// 상태 디렉터리 아래인 이유는 22.2절 — 저장소 **안**은 부모 게이트 루트에 포함된다.
pub fn parent_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("worktrees")
}

/// 격리 실행의 **기록 가능한 사실** — state-machine 38절.
///
/// 문자열 알림 하나로 두지 않는 이유: 이 사실들은 `TASK_CONFIG_PINNED`에 실려 지난 작업
/// 기록에서도 읽힌다(37절). 문장으로 굳혀 두면 화면이 그 문장을 다시 뜯어야 한다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Isolation {
    /// **사용자가 연 것은 이 저장소다.** 격리는 그 저장소를 *어디서* 도느냐일 뿐이다.
    pub repo: PathBuf,
    pub branch: String,
    pub path: PathBuf,
    /// 이미 있던 트리를 이어 쓰는가 (22.5②). 이전 실행의 잔해가 남아 있을 수 있다.
    pub reused: bool,
    /// 본체에 커밋되지 않은 변경이 있는가 (22.5①). 그 변경은 이 실행에 **포함되지 않는다.**
    pub main_tree_dirty: bool,
}

impl Isolation {
    pub fn of(repo: &Path, worktree: &Worktree) -> Self {
        Self {
            repo: repo.to_path_buf(),
            branch: worktree.branch.clone(),
            path: worktree.path.clone(),
            reused: !worktree.created,
            main_tree_dirty: is_dirty(repo),
        }
    }

    /// 사용자가 **정반대로 읽지 않으려면 들어야 하는 문장들** (22.5절).
    ///
    /// 판정을 화면에 두지 않는 이유: 같은 사실을 헤드리스는 stderr로, 데스크톱은 패널로
    /// 내는데 조건이 갈리면 한쪽 사용자만 듣게 된다.
    pub fn notices(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.main_tree_dirty {
            out.push(format!(
                "본체 작업 트리에 커밋되지 않은 변경이 있습니다. 격리 실행은 {} 브랜치의 마지막 커밋에서 \
                 시작하므로 그 변경은 이 실행에 **포함되지 않습니다**.",
                self.branch
            ));
        }
        if self.reused {
            out.push(format!(
                "{} 브랜치의 격리 트리를 **이어 씁니다**. 이전 실행의 결과가 남아 있을 수 있습니다.",
                self.branch
            ));
        }
        // **결과가 본체에 없다는 것**은 언제나 말한다. 위 둘과 달리 조건이 없다 — 격리 실행의
        // 결과를 본체에서 찾는 것은 격리를 켠 사람이 가장 흔히 하는 일이다.
        out.push(format!(
            "결과는 본체가 아니라 {} 에 남습니다.",
            self.path.display()
        ));
        out
    }
}

/// 격리 실행에서 갈리는 **두 경로**.
///
/// # 왜 하나가 아닌가
///
/// 격리는 `WorkspaceRoot`를 바꾸는 것이 전부다(22.1절). 그런데 그 경로를 **신원**으로도 쓰면
/// 격리할 때마다 `workspace_id`가 바뀌고, 그 id에 매달린 것들이 조용히 사라진다 — 등록한 훅과
/// MCP 서버(29절), 세션 메모리가 나르는 판정(27절), 작업 기록. 사용자에게는 "격리를 켰더니
/// 등록이 없어졌다"로 보이고, 그건 격리가 약속한 것이 아니다.
///
/// 사용자가 연 것은 **저장소**이고, 격리 트리는 이번 실행이 파일을 쓰는 자리다.
pub struct Roots {
    /// 게이트 루트 — 파일이 실제로 바뀌는 곳.
    pub gate: PathBuf,
    /// 신원 루트 — `workspace_id`와 거기 매달린 설정이 따라가는 곳.
    pub identity: PathBuf,
}

pub fn roots(repo: &Path, isolation: Option<&Isolation>) -> Roots {
    Roots {
        gate: isolation.map(|i| i.path.clone()).unwrap_or_else(|| repo.to_path_buf()),
        identity: repo.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// 커밋 하나가 있는 저장소. worktree는 커밋에서만 만들어지므로 빈 저장소로는 검사할 수 없다.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        git_ok(dir.path(), &["init", "-q", "."]);
        git_ok(dir.path(), &["config", "user.email", "a@b.c"]);
        git_ok(dir.path(), &["config", "user.name", "t"]);
        git_ok(dir.path(), &["add", "-A"]);
        git_ok(dir.path(), &["commit", "-qm", "init"]);
        dir
    }

    /// **브랜치 이름이 플래그가 되면 안 된다.**
    ///
    /// argv 배열을 쓰는 것만으로는 못 막는다 — 원칙 6이 막는 것은 셸 재해석이고, `--force`가
    /// 인자 자리에 오는 것은 git 자신의 옵션 해석이다.
    #[test]
    fn a_branch_name_that_looks_like_a_flag_is_refused() {
        for name in ["--force", "-b", "--git-dir=/etc"] {
            let err = validate_branch(name).unwrap_err();
            assert!(matches!(err, WorktreeError::InvalidBranch { .. }), "{name}: {err:?}");
        }
    }

    /// 파생 디렉터리 이름이 상위로 탈출하면 worktree가 격리가 아니게 된다.
    #[test]
    fn a_branch_name_that_escapes_the_directory_is_refused() {
        for name in ["../evil", "a/b", "..", "a\\b"] {
            assert!(validate_branch(name).is_err(), "{name}이 통과했습니다");
        }
        // 평범한 이름은 통과한다 — 위 거부가 모든 이름을 막는 것이 아님을 확인한다.
        for name in ["fix-1", "task_2", "v1.2"] {
            assert!(validate_branch(name).is_ok(), "{name}이 거부됐습니다");
        }
    }

    #[test]
    fn ensure_creates_then_reuses() {
        let repo_dir = repo();
        let parent = tempfile::tempdir().unwrap();

        let first = ensure(repo_dir.path(), parent.path(), "task-1", None).unwrap();
        assert!(first.created, "처음에는 만들어야 합니다");
        assert!(first.path.is_dir());
        // 격리된 트리에 저장소의 내용이 있다.
        assert!(first.path.join("a.txt").is_file());

        let second = ensure(repo_dir.path(), parent.path(), "task-1", None).unwrap();
        // **재사용은 재사용이라고 말한다.** "새로 만들었다"로 보고하면 잔해가 있는 트리를
        // 깨끗한 것으로 가정하게 된다.
        assert!(!second.created, "두 번째는 재사용해야 합니다");
        assert_eq!(second.path, first.path);
    }

    /// worktree 경로가 곧 Policy Gate 루트다 — 그 루트가 **본체를 포함하지 않아야** 한다.
    #[test]
    fn the_worktree_root_does_not_contain_the_main_tree() {
        let repo_dir = repo();
        let parent = tempfile::tempdir().unwrap();
        let wt = ensure(repo_dir.path(), parent.path(), "iso", None).unwrap();

        let root = crate::paths::WorkspaceRoot::new(&wt.path).unwrap();
        // 본체의 파일을 상대 경로로 지목해도 루트 밖이라 거부된다.
        let escape = format!(
            "../{}/a.txt",
            repo_dir.path().file_name().unwrap().to_string_lossy()
        );
        assert!(root.resolve_existing(&escape).is_err(), "격리 트리에서 본체 파일이 열렸습니다");
    }

    /// 우리가 만들지 않은 worktree를 정리 대상으로 세면 남의 작업을 지운다.
    #[test]
    fn only_our_worktrees_are_listed_as_ours() {
        let repo_dir = repo();
        let parent = tempfile::tempdir().unwrap();
        ensure(repo_dir.path(), parent.path(), "mine", None).unwrap();
        // 사용자가 손으로 만든 것.
        let theirs = parent.path().join("hand-made");
        git_ok(
            repo_dir.path(),
            &["worktree", "add", "-b", "theirs", "--", theirs.to_str().unwrap()],
        );

        let all = list(repo_dir.path()).unwrap();
        assert_eq!(all.len(), 2, "{all:?}");
        let ours = ours(&all);
        assert_eq!(ours.len(), 1, "{ours:?}");
        assert_eq!(ours[0].branch, "mine");
    }

    /// **더러운 트리는 기본적으로 지우지 않는다.** 버리는 결정은 사용자의 것이다.
    #[test]
    fn a_dirty_worktree_is_not_removed_without_force() {
        let repo_dir = repo();
        let parent = tempfile::tempdir().unwrap();
        let wt = ensure(repo_dir.path(), parent.path(), "dirty", None).unwrap();
        std::fs::write(wt.path.join("a.txt"), "changed\n").unwrap();

        let err = remove(repo_dir.path(), &wt.path, false).unwrap_err();
        assert!(matches!(err, WorktreeError::Dirty { .. }), "{err:?}");
        assert!(wt.path.is_dir(), "거부했는데 지워졌습니다");

        // force면 지운다 — 위 거부가 "절대 못 지운다"가 아님을 확인한다.
        remove(repo_dir.path(), &wt.path, true).unwrap();
        assert!(!wt.path.is_dir());
    }

    #[test]
    fn a_clean_worktree_is_removed() {
        let repo_dir = repo();
        let parent = tempfile::tempdir().unwrap();
        let wt = ensure(repo_dir.path(), parent.path(), "clean", None).unwrap();
        remove(repo_dir.path(), &wt.path, false).unwrap();
        assert!(!wt.path.is_dir());
        assert!(ours(&list(repo_dir.path()).unwrap()).is_empty());
    }

    /// 같은 브랜치를 두 곳에 체크아웃하려 하면 git이 막는다 — 그 거부를 **구조로** 돌려준다.
    #[test]
    fn a_branch_checked_out_elsewhere_is_its_own_outcome() {
        let repo_dir = repo();
        let parent = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        git_ok(
            repo_dir.path(),
            &["worktree", "add", "-b", "shared", "--", other.path().join("wt").to_str().unwrap()],
        );

        let err = ensure(repo_dir.path(), parent.path(), "shared", None).unwrap_err();
        assert!(matches!(err, WorktreeError::BranchAlreadyCheckedOut { .. }), "{err:?}");
    }

    #[test]
    fn a_non_repository_says_so() {
        let plain = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let err = ensure(plain.path(), parent.path(), "x", None).unwrap_err();
        assert!(matches!(err, WorktreeError::NotARepository { .. }), "{err:?}");
    }


    // ---- 격리의 기록 가능한 사실 (38절) ----

    /// **격리는 사용자가 연 것이 무엇인지를 바꾸지 않는다.** 바꾸면 그 id에 매달린 등록(훅·MCP)과
    /// 작업 기록이 격리를 켤 때마다 사라지고, 사용자에게는 "격리를 켰더니 설정이 없어졌다"로 보인다.
    #[test]
    fn isolating_changes_where_files_go_but_not_who_the_workspace_is() {
        let repo_path = PathBuf::from("/repo");
        let iso = Isolation {
            repo: repo_path.clone(),
            branch: "b".into(),
            path: PathBuf::from("/state/worktrees/tomverse-b"),
            reused: false,
            main_tree_dirty: false,
        };

        let plain = roots(&repo_path, None);
        let isolated = roots(&repo_path, Some(&iso));

        assert_eq!(plain.gate, repo_path);
        assert_eq!(isolated.gate, iso.path, "게이트 루트는 격리 트리여야 합니다");
        assert_eq!(
            isolated.identity, plain.identity,
            "신원 루트가 갈리면 workspace_id가 바뀌고 등록이 사라집니다"
        );
    }

    /// 22.5절의 두 사실 — 말하지 않으면 사용자가 **정반대로 읽는다.**
    #[test]
    fn the_notices_cover_what_would_otherwise_be_read_backwards() {
        let base = Isolation {
            repo: PathBuf::from("/repo"),
            branch: "b".into(),
            path: PathBuf::from("/state/worktrees/tomverse-b"),
            reused: false,
            main_tree_dirty: false,
        };
        let quiet = base.notices();
        // 결과가 어디 있는지는 **조건 없이** 말한다 — 격리를 켠 사람이 가장 흔히 하는 일이
        // 본체에서 결과를 찾는 것이다.
        assert_eq!(quiet.len(), 1, "{quiet:?}");
        assert!(quiet[0].contains("tomverse-b"), "{quiet:?}");

        let dirty = Isolation { main_tree_dirty: true, ..base.clone() };
        assert!(
            dirty.notices().iter().any(|n| n.contains("포함되지 않습니다")),
            "{:?}",
            dirty.notices()
        );

        let reused = Isolation { reused: true, ..base.clone() };
        assert!(
            reused.notices().iter().any(|n| n.contains("이어 씁니다")),
            "{:?}",
            reused.notices()
        );
        // **셋을 뭉개지 않는다** — 조건이 다르므로 개수도 달라야 한다.
        assert!(dirty.notices().len() > quiet.len() && reused.notices().len() > quiet.len());
    }

    /// `created`의 뜻이 뒤집히면 "이어 씁니다"가 새 트리에 붙는다 — 그러면 깨끗한 트리를
    /// 더럽다고 말하고, 더 나쁘게는 이어 쓰는 트리를 새것이라고 말한다.
    #[test]
    fn a_freshly_created_tree_is_not_reported_as_reused() {
        let wt = Worktree { path: PathBuf::from("/x"), branch: "b".into(), created: true };
        let iso = Isolation::of(Path::new("/repo"), &wt);
        assert!(!iso.reused);
    }

    /// **격리 트리가 사는 자리를 두 곳에서 계산하지 않는다.** 각자 계산하면 한쪽만 고쳐졌을 때
    /// 같은 브랜치로 트리가 둘 생기고, 사용자에게는 "지웠는데 남아 있다"로 보인다.
    #[test]
    fn only_one_place_decides_where_isolated_trees_live() {
        // needle을 **런타임에 조립한다** — 그대로 적으면 이 파일이 자기 자신을 센다.
        // 그리고 **이어붙이는 것만** 센다: 같은 낱말이 JSON 키로 쓰이는 것은 자리를 정하는
        // 행위가 아니다(실제로 그걸 세다 헛짚었다).
        let needle = format!("join({}worktrees{})", '"', '"');
        let mut hits: Vec<String> = Vec::new();
        let core = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // 데스크톱 껍데기도 함께 본다 — 이 환경에서 컴파일되지 않으므로 컴파일러가 잡아주지 않는다.
        let shell = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut files: Vec<PathBuf> = Vec::new();
        for dir in [core, shell] {
            collect_rs(&dir, &mut files);
        }
        assert!(files.len() > 5, "소스를 찾지 못했습니다: {}", files.len());
        for file in &files {
            let text = std::fs::read_to_string(file).unwrap_or_default();
            if text.contains(&needle) {
                hits.push(file.file_name().unwrap().to_string_lossy().to_string());
            }
        }
        assert_eq!(hits, vec!["worktree.rs".to_string()], "격리 디렉터리를 정하는 곳이 여럿입니다");
    }

    fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    /// 판정할 수 없으면 더럽다고 본다 — 모르는 상태에서 지우지 않기 위해서다.
    #[test]
    fn an_unreadable_worktree_counts_as_dirty() {
        let plain = tempfile::tempdir().unwrap();
        assert!(is_dirty(&plain.path().join("does-not-exist")));
    }
}
