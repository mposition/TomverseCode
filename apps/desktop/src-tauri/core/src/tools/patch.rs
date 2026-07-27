//! 최소한의 안전한 unified diff 적용.
//!
//! 작업 지침 4.3절: "patch가 예상한 기존 내용과 일치하지 않으면 **부분 적용하지 말고 실패**시킨다."
//!
//! 그래서 이 구현은 두 단계로 나뉜다:
//!   1. 전체 hunk를 검증하며 결과 문자열을 메모리에서 만든다 (파일은 건드리지 않는다)
//!   2. 전부 성공했을 때만 호출자가 파일에 쓴다
//!
//! 의도적으로 하지 않는 것: fuzzy matching, 컨텍스트 오프셋 탐색(git apply의 `-C`/fuzz 동작).
//! "대충 맞으면 적용"은 LLM이 만든 patch에 특히 위험하다 — 엉뚱한 위치에 적용된 변경은
//! 컴파일은 되지만 의미가 달라질 수 있고, 그건 VERIFYING이 잡지 못할 수도 있다.
//! 실패하고 FIX_LOOP로 다시 시도하는 편이 낫다.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchError {
    /// diff 텍스트 자체가 파싱되지 않음
    Malformed { line: usize, reason: String },
    /// hunk가 기대한 컨텍스트/삭제 줄이 실제 파일과 다름
    ContextMismatch {
        hunk: usize,
        at_line: usize,
        expected: String,
        found: String,
    },
    /// hunk가 파일 끝을 넘어감
    OutOfBounds {
        hunk: usize,
        at_line: usize,
        file_lines: usize,
    },
    /// 적용할 hunk가 없음 — 조용히 성공시키면 "고쳤다"고 잘못 보고하게 된다
    NoHunks,
}

impl fmt::Display for PatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PatchError::Malformed { line, reason } => write!(f, "malformed patch at line {line}: {reason}"),
            PatchError::ContextMismatch {
                hunk,
                at_line,
                expected,
                found,
            } => write!(
                f,
                "hunk #{hunk} does not match the file at line {at_line}: expected {expected:?}, found {found:?}"
            ),
            PatchError::OutOfBounds {
                hunk,
                at_line,
                file_lines,
            } => write!(
                f,
                "hunk #{hunk} reaches line {at_line} but the file only has {file_lines} lines"
            ),
            PatchError::NoHunks => write!(f, "patch contains no hunks"),
        }
    }
}

impl std::error::Error for PatchError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Op {
    Context(String),
    Remove(String),
    Add(String),
}

#[derive(Debug, Clone)]
struct Hunk {
    /// 1-based 원본 시작 줄
    old_start: usize,
    ops: Vec<Op>,
}

/// unified diff 파싱. `---`/`+++`/`diff --git`/`index` 헤더는 무시하고 hunk만 읽는다 —
/// 대상 파일 경로는 `ToolRequest.args.path`로 명시적으로 오고, patch 안의 경로를 신뢰해
/// 파일을 고르면 Policy Gate가 승인한 대상과 실제 대상이 달라질 수 있다.
fn parse_hunks(patch: &str) -> Result<Vec<Hunk>, PatchError> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut current: Option<Hunk> = None;

    for (idx, raw) in patch.lines().enumerate() {
        let line_no = idx + 1;

        if raw.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = Some(Hunk {
                old_start: parse_hunk_header(raw, line_no)?,
                ops: Vec::new(),
            });
            continue;
        }

        // hunk 시작 전의 헤더 줄은 건너뛴다.
        let Some(hunk) = current.as_mut() else {
            continue;
        };

        // "\ No newline at end of file" — 이 구현은 줄 단위로만 동작하므로 표시만 무시한다.
        if raw.starts_with('\\') {
            continue;
        }

        match raw.chars().next() {
            Some(' ') => hunk.ops.push(Op::Context(raw[1..].to_string())),
            Some('-') => hunk.ops.push(Op::Remove(raw[1..].to_string())),
            Some('+') => hunk.ops.push(Op::Add(raw[1..].to_string())),
            // 빈 줄은 컨텍스트의 빈 줄로 취급한다 (많은 도구가 후행 공백을 지운다).
            None => hunk.ops.push(Op::Context(String::new())),
            Some(_) => {
                return Err(PatchError::Malformed {
                    line: line_no,
                    reason: format!("unexpected line prefix in hunk body: {raw:?}"),
                })
            }
        }
    }

    if let Some(h) = current {
        hunks.push(h);
    }
    if hunks.is_empty() {
        return Err(PatchError::NoHunks);
    }
    Ok(hunks)
}

/// `@@ -12,7 +12,8 @@ optional heading` 에서 원본 시작 줄을 뽑는다.
fn parse_hunk_header(line: &str, line_no: usize) -> Result<usize, PatchError> {
    let malformed = |reason: &str| PatchError::Malformed {
        line: line_no,
        reason: reason.to_string(),
    };

    let after = line.strip_prefix("@@").ok_or_else(|| malformed("missing @@"))?;
    let minus = after
        .split_whitespace()
        .find(|tok| tok.starts_with('-'))
        .ok_or_else(|| malformed("missing -old,count range"))?;
    let digits = &minus[1..];
    let start_str = digits.split(',').next().unwrap_or("");
    let start: usize = start_str
        .parse()
        .map_err(|_| malformed(&format!("cannot parse old start line from {minus:?}")))?;
    Ok(start)
}

/// 적용 결과. 성공하면 새 파일 내용 전체를 반환한다 — 호출자가 쓰기 전에
/// pre-image를 저장할 수 있도록 파일 쓰기는 이 함수가 하지 않는다.
pub fn apply_unified_diff(original: &str, patch: &str) -> Result<String, PatchError> {
    let hunks = parse_hunks(patch)?;

    let had_trailing_newline = original.ends_with('\n') || original.is_empty();
    let lines: Vec<&str> = split_lines(original);

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    // 0-based 커서. 마지막으로 원본에서 소비한 위치.
    let mut cursor = 0usize;

    for (hunk_idx, hunk) in hunks.iter().enumerate() {
        let hunk_no = hunk_idx + 1;
        // old_start가 0인 hunk는 "빈 파일에 추가"를 뜻한다.
        let target = hunk.old_start.saturating_sub(1);

        if target < cursor {
            return Err(PatchError::Malformed {
                line: 0,
                reason: format!(
                    "hunk #{hunk_no} starts at line {} which is before the previous hunk",
                    hunk.old_start
                ),
            });
        }
        if target > lines.len() {
            return Err(PatchError::OutOfBounds {
                hunk: hunk_no,
                at_line: hunk.old_start,
                file_lines: lines.len(),
            });
        }

        // hunk 사이의 변경되지 않은 부분을 그대로 옮긴다.
        for line in &lines[cursor..target] {
            out.push((*line).to_string());
        }
        cursor = target;

        for op in &hunk.ops {
            match op {
                Op::Add(text) => out.push(text.clone()),
                Op::Context(expected) | Op::Remove(expected) => {
                    let Some(actual) = lines.get(cursor) else {
                        return Err(PatchError::OutOfBounds {
                            hunk: hunk_no,
                            at_line: cursor + 1,
                            file_lines: lines.len(),
                        });
                    };
                    // 정확히 일치해야 한다. 공백을 무시하거나 근처를 찾아보는 관용은 없다.
                    if actual != expected {
                        return Err(PatchError::ContextMismatch {
                            hunk: hunk_no,
                            at_line: cursor + 1,
                            expected: expected.clone(),
                            found: (*actual).to_string(),
                        });
                    }
                    if matches!(op, Op::Context(_)) {
                        out.push((*actual).to_string());
                    }
                    cursor += 1;
                }
            }
        }
    }

    for line in &lines[cursor..] {
        out.push((*line).to_string());
    }

    let mut result = out.join("\n");
    if had_trailing_newline && !result.is_empty() {
        result.push('\n');
    }
    Ok(result)
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    // 마지막 개행 뒤의 빈 조각은 줄이 아니다.
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// pre-image로 되돌리는 역방향 patch를 만드는 대신, 롤백은 파일 전체를 pre-image로
/// 덮어쓰는 방식을 쓴다 — 역방향 diff 생성은 또 하나의 실패 지점이고, pre-image 전체를
/// 이미 artifact로 갖고 있으므로 필요가 없다.
///
/// 단순한 unified diff 생성기. UI diff 표시와 `WorkspaceDelta`에 쓰인다.
/// LCS 없이 "공통 접두/접미를 벗기고 가운데를 통째로 교체"하는 방식이므로 최소 diff는 아니지만,
/// 정확하고(적용하면 반드시 같은 결과) 예측 가능하다.
pub fn make_unified_diff(path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let a = split_lines(before);
    let b = split_lines(after);

    let mut prefix = 0usize;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < a.len() - prefix && suffix < b.len() - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }

    const CONTEXT: usize = 3;
    let ctx_start = prefix.saturating_sub(CONTEXT);
    let a_change_end = a.len() - suffix;
    let b_change_end = b.len() - suffix;
    let ctx_a_end = (a_change_end + CONTEXT).min(a.len());
    let ctx_b_end = (b_change_end + CONTEXT).min(b.len());

    let mut out = String::new();
    out.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        ctx_start + 1,
        ctx_a_end - ctx_start,
        ctx_start + 1,
        ctx_b_end - ctx_start
    ));
    for line in &a[ctx_start..prefix] {
        out.push_str(&format!(" {line}\n"));
    }
    for line in &a[prefix..a_change_end] {
        out.push_str(&format!("-{line}\n"));
    }
    for line in &b[prefix..b_change_end] {
        out.push_str(&format!("+{line}\n"));
    }
    for line in &a[a_change_end..ctx_a_end] {
        out.push_str(&format!(" {line}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGINAL: &str = "line one\nline two\nline three\nline four\n";

    #[test]
    fn applies_a_simple_replacement() {
        let patch = "--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n line two\n-line three\n+LINE THREE\n";
        let out = apply_unified_diff(ORIGINAL, patch).unwrap();
        assert_eq!(out, "line one\nline two\nLINE THREE\nline four\n");
    }

    #[test]
    fn applies_an_insertion() {
        let patch = "@@ -1,1 +1,2 @@\n line one\n+inserted\n";
        let out = apply_unified_diff(ORIGINAL, patch).unwrap();
        assert_eq!(out, "line one\ninserted\nline two\nline three\nline four\n");
    }

    #[test]
    fn applies_a_deletion() {
        let patch = "@@ -2,2 +2,1 @@\n line two\n-line three\n";
        let out = apply_unified_diff(ORIGINAL, patch).unwrap();
        assert_eq!(out, "line one\nline two\nline four\n");
    }

    #[test]
    fn applies_multiple_hunks() {
        let original = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let patch = "@@ -1,1 +1,1 @@\n-a\n+A\n@@ -7,2 +7,2 @@\n-g\n+G\n h\n";
        let out = apply_unified_diff(original, patch).unwrap();
        assert_eq!(out, "A\nb\nc\nd\ne\nf\nG\nh\n");
    }

    #[test]
    fn rejects_context_mismatch_without_partial_application() {
        // 첫 hunk는 맞고 둘째 hunk가 틀린 patch. 부분 적용되면 첫 변경만 반영된 결과가 나온다.
        let original = "a\nb\nc\nd\n";
        let patch = "@@ -1,1 +1,1 @@\n-a\n+A\n@@ -3,1 +3,1 @@\n-WRONG\n+X\n";
        let err = apply_unified_diff(original, patch).unwrap_err();
        match err {
            PatchError::ContextMismatch {
                hunk, expected, found, ..
            } => {
                assert_eq!(hunk, 2);
                assert_eq!(expected, "WRONG");
                assert_eq!(found, "c");
            }
            other => panic!("expected ContextMismatch, got {other:?}"),
        }
        // 원본이 그대로임을 확인하는 것은 tool runtime 테스트 쪽 책임이지만,
        // 이 함수가 Err를 반환하는 한 파일에 쓰일 값이 존재하지 않는다.
    }

    #[test]
    fn rejects_out_of_bounds_hunk() {
        let patch = "@@ -99,1 +99,1 @@\n-nope\n+yes\n";
        assert!(matches!(
            apply_unified_diff(ORIGINAL, patch).unwrap_err(),
            PatchError::OutOfBounds { .. }
        ));
    }

    #[test]
    fn rejects_patch_with_no_hunks() {
        assert_eq!(
            apply_unified_diff(ORIGINAL, "--- a/f\n+++ b/f\n").unwrap_err(),
            PatchError::NoHunks
        );
    }

    #[test]
    fn rejects_malformed_hunk_header() {
        let err = apply_unified_diff(ORIGINAL, "@@ nonsense @@\n line one\n").unwrap_err();
        assert!(matches!(err, PatchError::Malformed { .. }));
    }

    #[test]
    fn rejects_out_of_order_hunks() {
        let patch = "@@ -3,1 +3,1 @@\n-line three\n+X\n@@ -1,1 +1,1 @@\n-line one\n+Y\n";
        assert!(matches!(
            apply_unified_diff(ORIGINAL, patch).unwrap_err(),
            PatchError::Malformed { .. }
        ));
    }

    #[test]
    fn preserves_absence_of_trailing_newline() {
        let original = "a\nb";
        let patch = "@@ -1,1 +1,1 @@\n-a\n+A\n";
        assert_eq!(apply_unified_diff(original, patch).unwrap(), "A\nb");
    }

    #[test]
    fn handles_empty_file_with_zero_start() {
        // 빈 파일에 줄을 추가하면 개행으로 끝나는 것이 정상적인 텍스트 파일 형태다.
        let patch = "@@ -0,0 +1,1 @@\n+first line\n";
        assert_eq!(apply_unified_diff("", patch).unwrap(), "first line\n");
    }

    #[test]
    fn generated_diff_round_trips() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "a\nb\nCHANGED\nd\ne\n";
        let diff = make_unified_diff("f.txt", before, after);
        assert!(diff.contains("-c"), "diff was:\n{diff}");
        assert!(diff.contains("+CHANGED"), "diff was:\n{diff}");
        // 생성한 diff를 다시 적용하면 원래의 after가 나와야 한다.
        assert_eq!(apply_unified_diff(before, &diff).unwrap(), after);
    }

    #[test]
    fn generated_diff_is_empty_when_unchanged() {
        assert_eq!(make_unified_diff("f.txt", "a\n", "a\n"), "");
    }
}
