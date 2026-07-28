/// HTTP `Range: bytes=start-end` 를 파싱한다.
/// **HTTP 명세상 `end`는 포함(inclusive)이다.**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: usize,
    /// inclusive
    pub end: usize,
}

pub fn parse_range(header: &str) -> Option<ByteRange> {
    let rest = header.strip_prefix("bytes=")?;
    let (start, end) = rest.split_once('-')?;
    Some(ByteRange {
        start: start.parse().ok()?,
        end: end.parse().ok()?,
    })
}
