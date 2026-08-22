import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIFF_LINE_CAP,
  summarizeChange,
  summarizeDiff,
  visibleDiff,
} from "../src/lib/diffSummary.js";

/**
 * diff 요약 — ui-wireframes.md 3.14절.
 *
 * 이 계산이 틀리면 사용자는 "12줄 바뀜"을 보고 판단하는데 실제로는 120줄일 수 있고,
 * **그 오류는 눈으로 잡히지 않는다.** 화면 안에 두면 검증할 방법이 없어서 순수 함수로 뺐다.
 */

const ONE_FILE = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
].join("\n");

/**
 * **파일 헤더를 변경으로 세지 않는다.** unified diff의 `+++`/`---`는 `+`/`-`로 시작하지만
 * 변경된 줄이 아니다 — 세면 모든 파일이 +1/−1씩 부풀려진다.
 */
test("파일 헤더는 +/− 에 세지 않는다", () => {
  const stat = summarizeDiff(ONE_FILE);
  assert.equal(stat.added, 2, "추가 2줄이어야 합니다");
  assert.equal(stat.removed, 1, "삭제 1줄이어야 합니다");
  assert.equal(stat.lines, 7);
});

test("변경 전체 요약은 파일별 합계다", () => {
  const total = summarizeChange([
    ["src/app.ts", ONE_FILE],
    ["src/b.ts", ONE_FILE],
  ]);
  assert.deepEqual(total, { files: 2, added: 4, removed: 2, lines: 14 });
});

test("변경이 없으면 0이다 — 빈 값을 만들어내지 않는다", () => {
  assert.deepEqual(summarizeChange([]), { files: 0, added: 0, removed: 0, lines: 0 });
});

/** 상한 이하면 **손대지 않는다.** 멀쩡한 diff를 자르면 사용자가 "더 보기"를 누르게 된다. */
test("상한 이하는 그대로 돌려준다", () => {
  const { text, hidden } = visibleDiff(ONE_FILE, 100);
  assert.equal(text, ONE_FILE);
  assert.equal(hidden, 0);
});

/**
 * **자른 사실을 값으로 돌려준다.** 잘라 놓고 화면이 그 사실을 모르면 사용자는 잘린 diff를
 * 전체로 읽고 판단한다 — 이 화면의 목적이 "이 변경을 받아들일지 판단"이므로, 그건 판단의
 * 근거를 조용히 바꾸는 것이다.
 */
test("자를 때 감춘 줄 수를 함께 준다", () => {
  const long = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join("\n");
  const { text, hidden } = visibleDiff(long, 10);
  assert.equal(text.split("\n").length, 10);
  assert.equal(hidden, 40);
  // 앞에서부터 자른다 — 뒤에서 자르면 파일 헤더가 사라져 무엇의 diff인지 알 수 없다.
  assert.ok(text.startsWith("+line 0"));
});

/** 상한이 0 이하인 경우도 **조용히 전부 보여주지 않는다.** */
test("상한이 0이면 아무것도 보여주지 않고 전부 감췄다고 말한다", () => {
  const { text, hidden } = visibleDiff(ONE_FILE, 0);
  assert.equal(text, "");
  assert.equal(hidden, 7);
});

/** 기본 상한이 사라지면 큰 파일 하나가 화면을 멈추게 한다. */
test("기본 상한이 존재하고 양수다", () => {
  assert.ok(DEFAULT_DIFF_LINE_CAP > 0);
  const huge = Array.from({ length: DEFAULT_DIFF_LINE_CAP + 5 }, () => "+x").join("\n");
  assert.equal(visibleDiff(huge).hidden, 5);
});
