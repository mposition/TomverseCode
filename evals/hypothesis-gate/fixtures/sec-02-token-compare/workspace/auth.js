// 토큰 검증.
function verifyToken(provided, expected, options = {}) {
  // 길이가 다르면 바로 거절.
  if (provided.length !== expected.length) return false;
  for (let i = 0; i < provided.length; i += 1) {
    if (provided[i] !== expected[i]) return false;
  }
  return true;
}
module.exports = { verifyToken };
