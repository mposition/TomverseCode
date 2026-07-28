use sec_03_workspace_confine::confine::{confine, Violation};
use std::path::Path;

#[test]
fn normal_paths_still_work() {
    let root = Path::new("/ws");
    assert_eq!(confine(root, "src/app.ts").unwrap(), "src/app.ts");
    assert_eq!(confine(root, "./src/app.ts").unwrap(), "src/app.ts");
}

#[test]
fn absolute_paths_outside_root_are_rejected() {
    let root = Path::new("/ws");
    // join은 절대경로를 만나면 **앞을 통째로 버린다** — 문자열 검사만으로는 잡히지 않는다.
    assert_eq!(confine(root, "/etc/passwd").unwrap_err(), Violation::OutsideRoot);
}

#[test]
fn absolute_paths_inside_root_are_accepted() {
    let root = Path::new("/ws");
    assert_eq!(confine(root, "/ws/src/app.ts").unwrap(), "src/app.ts");
}

#[test]
fn parent_traversal_is_rejected_in_all_forms() {
    let root = Path::new("/ws");
    assert_eq!(confine(root, "../etc/passwd").unwrap_err(), Violation::ParentTraversal);
    assert_eq!(confine(root, "src/../../etc").unwrap_err(), Violation::ParentTraversal);
}

#[test]
fn filenames_merely_containing_dotdot_are_not_rejected() {
    // "..": 세그먼트일 때만 위험하다. `a..b.txt`는 정상 파일 이름이다.
    let root = Path::new("/ws");
    assert_eq!(confine(root, "notes/a..b.txt").unwrap(), "notes/a..b.txt");
}

#[test]
fn empty_is_rejected() {
    assert_eq!(confine(Path::new("/ws"), "   ").unwrap_err(), Violation::Empty);
}
