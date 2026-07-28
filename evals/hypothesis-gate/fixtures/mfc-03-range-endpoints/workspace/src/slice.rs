use crate::range::ByteRange;

/// 범위만큼 잘라낸다.
pub fn slice_range(data: &[u8], range: ByteRange) -> &[u8] {
    // end를 exclusive로 취급한다.
    let end = range.end.min(data.len());
    &data[range.start.min(end)..end]
}
