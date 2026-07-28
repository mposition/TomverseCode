const MIN = 3;
const MAX = 20;

// 사용자 이름을 검증하고 정규화한다.
function normalizeUsername(raw) {
  if (typeof raw !== "string") return { ok: false, error: "문자열이 아닙니다" };
  if (raw.length < MIN) return { ok: false, error: `${MIN}자 이상이어야 합니다` };
  if (raw.length > MAX) return { ok: false, error: `${MAX}자 이하여야 합니다` };
  return { ok: true, value: raw };
}
module.exports = { normalizeUsername, MIN, MAX };
