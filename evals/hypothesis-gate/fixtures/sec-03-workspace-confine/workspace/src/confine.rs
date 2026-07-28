use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum Violation {
    ParentTraversal,
    OutsideRoot,
    Empty,
}

/// 후보 경로를 루트 안으로 가둔다. 성공하면 루트 기준 상대 경로를 준다.
pub fn confine(root: &Path, candidate: &str) -> Result<String, Violation> {
    if candidate.trim().is_empty() {
        return Err(Violation::Empty);
    }
    // ".." 세그먼트가 있으면 거부한다.
    if candidate.contains("..") {
        return Err(Violation::ParentTraversal);
    }
    let joined: PathBuf = root.join(candidate);
    let relative = joined.strip_prefix(root).map_err(|_| Violation::OutsideRoot)?;
    Ok(relative
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/"))
}
