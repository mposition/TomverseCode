일부 사용자 레코드에 name 필드가 없는 경우 `getFirstName` 호출 시 앱이 크래시합니다(Cannot read properties of undefined).
name이 없거나 null인 경우에는 크래시 대신 빈 문자열을 반환하도록 안전하게 처리해주세요.
