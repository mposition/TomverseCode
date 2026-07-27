//! ISO 8601 타임스탬프. 프로토콜의 `ISODateTime`은 전부 이 형식이다.

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        // Rfc3339 포맷은 UTC OffsetDateTime에 대해 실패할 수 없다. 그래도 unwrap하지 않는 이유:
        // 타임스탬프 하나 때문에 태스크 전체를 패닉시키는 것이 이벤트 로그 기록보다 나쁘다.
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn elapsed_ms(start: std::time::Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_iso_is_rfc3339_utc() {
        let s = now_iso();
        assert!(s.ends_with('Z'), "expected UTC Z suffix, got {s}");
        assert!(OffsetDateTime::parse(&s, &Rfc3339).is_ok(), "not parseable: {s}");
    }
}
