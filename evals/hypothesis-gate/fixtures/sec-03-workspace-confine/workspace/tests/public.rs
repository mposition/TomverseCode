use sec_03_workspace_confine::confine::{confine, Violation};
use std::path::Path;

#[test]
fn accepts_simple_relative_path() {
    let root = Path::new("/ws");
    assert_eq!(confine(root, "src/app.ts").unwrap(), "src/app.ts");
}

#[test]
fn rejects_parent_traversal() {
    let root = Path::new("/ws");
    assert_eq!(confine(root, "../etc/passwd").unwrap_err(), Violation::ParentTraversal);
}
