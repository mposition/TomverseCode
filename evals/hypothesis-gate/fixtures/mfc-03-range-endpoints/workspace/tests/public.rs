use mfc_03_range_endpoints::range::parse_range;

#[test]
fn parses_start_and_end() {
    let r = parse_range("bytes=0-4").unwrap();
    assert_eq!(r.start, 0);
    assert_eq!(r.end, 4);
}
