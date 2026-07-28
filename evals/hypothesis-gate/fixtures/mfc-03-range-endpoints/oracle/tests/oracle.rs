use mfc_03_range_endpoints::range::{parse_range, ByteRange};
use mfc_03_range_endpoints::slice::slice_range;

#[test]
fn end_is_inclusive_end_to_end() {
    let data = b"abcdefghij";
    let r = parse_range("bytes=0-4").unwrap();
    assert_eq!(slice_range(data, r), b"abcde", "0-4는 5바이트여야 합니다");
}

#[test]
fn single_byte_range_returns_one_byte() {
    let data = b"abcdefghij";
    let r = parse_range("bytes=3-3").unwrap();
    assert_eq!(slice_range(data, r), b"d");
}

#[test]
fn range_past_end_is_clamped_not_panicking() {
    let data = b"abc";
    let r = ByteRange { start: 1, end: 99 };
    assert_eq!(slice_range(data, r), b"bc");
}

#[test]
fn empty_when_start_past_end_of_data() {
    let data = b"abc";
    let r = ByteRange { start: 5, end: 9 };
    assert_eq!(slice_range(data, r), b"");
}
