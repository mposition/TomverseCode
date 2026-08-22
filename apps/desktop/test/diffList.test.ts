import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, hiddenNotice, matchesFilter, viewDiffs } from "../src/lib/diffList.js";

/**
 * diff 목록의 필터와 정렬 — ui-wireframes.md 3.14절.
 *
 * 여기서 검증하는 실패는 **화면에서 정상으로 보인다**: 숨겨진 파일은 그냥 없는 파일처럼
 * 보이고, 뒤섞인 순서는 그냥 다른 순서처럼 보인다.
 */

/** `n`줄을 더하고 `m`줄을 지우는 최소한의 unified diff. */
function diff(path: string, added: number, removed: number): [string, string] {
  const body = [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
  ].join("\n");
  return [path, body];
}

const SAMPLE: [string, string][] = [
  diff("src/zeta.ts", 1, 0), // 적용 0번, 변경 1줄
  diff("src/alpha.ts", 10, 5), // 적용 1번, 변경 15줄
  diff("docs/mid.md", 3, 1), // 적용 2번, 변경 4줄
];

test("기본 순서는 적용 순서다", () => {
  const view = viewDiffs(SAMPLE);
  assert.deepEqual(
    view.rows.map((r) => r.path),
    ["src/zeta.ts", "src/alpha.ts", "docs/mid.md"]
  );
  assert.deepEqual(
    view.rows.map((r) => r.appliedIndex),
    [0, 1, 2]
  );
});

/**
 * **정렬해도 적용 순번은 그대로다.** 이게 정렬의 대가를 치르지 않는 방법이다 — 재배열돼도
 * 화면이 순번을 보여주면 원래 위치를 읽을 수 있다.
 */
test("정렬해도 각 행이 자기 적용 순번을 들고 있다", () => {
  const view = viewDiffs(SAMPLE, { sort: "changes" });
  assert.deepEqual(
    view.rows.map((r) => r.path),
    ["src/alpha.ts", "docs/mid.md", "src/zeta.ts"]
  );
  assert.deepEqual(
    view.rows.map((r) => r.appliedIndex),
    [1, 2, 0],
    "정렬이 적용 순번을 다시 매겼습니다 — 그러면 순서가 정말로 사라집니다"
  );
});

test("경로순 정렬은 코드포인트 비교다", () => {
  const view = viewDiffs(SAMPLE, { sort: "path" });
  assert.deepEqual(
    view.rows.map((r) => r.path),
    ["docs/mid.md", "src/alpha.ts", "src/zeta.ts"]
  );
});

/**
 * **동점은 적용 순서로 푼다.** 풀지 않으면 같은 변경이 렌더마다 다르게 보일 수 있고,
 * 사용자는 그걸 화면이 바뀐 것으로 읽는다.
 */
test("변경량이 같으면 적용 순서를 지킨다", () => {
  // b와 c가 2줄로 동점이고 a는 5줄이다 — 동점 둘이 적용 순서(0, 2)를 지키는지 본다.
  const tie: [string, string][] = [diff("b.ts", 2, 0), diff("a.ts", 3, 2), diff("c.ts", 2, 0)];
  const view = viewDiffs(tie, { sort: "changes" });
  assert.deepEqual(
    view.rows.map((r) => r.path),
    ["a.ts", "b.ts", "c.ts"]
  );
  // 그리고 그 둘은 정말로 동점이어야 한다 — 아니면 이 테스트는 동점을 검증하지 않는다.
  const [, b, c] = view.rows;
  assert.equal(b!.stat.added + b!.stat.removed, c!.stat.added + c!.stat.removed);
});

// ---- 필터 ----

test("필터는 대소문자를 구별하지 않는 부분 문자열이다", () => {
  assert.equal(matchesFilter("src/Login.ts", "login"), true);
  assert.equal(matchesFilter("src/Login.ts", "SRC/"), true);
  assert.equal(matchesFilter("src/Login.ts", "logout"), false);
  // 빈 필터는 전부 통과 — "아무것도 안 걸림"이 아니다.
  assert.equal(matchesFilter("src/Login.ts", ""), true);
});

/** 붙여넣은 경로에 딸려온 공백 때문에 0건이 되면 사용자는 필터가 고장 났다고 읽는다. */
test("필터의 앞뒤 공백은 버린다", () => {
  assert.equal(matchesFilter("src/login.ts", "  login  "), true);
  assert.equal(matchesFilter("src/login.ts", "   "), true);
});

/**
 * **숨긴 것을 값으로 돌려준다.** 되돌리기가 전부 아니면 전무이므로, 필터가 걸러낸 파일이
 * 있는데 말하지 않으면 사용자는 일부만 보고 전체를 판단한다.
 */
test("필터가 숨긴 파일 수와 그 합계를 함께 준다", () => {
  const view = viewDiffs(SAMPLE, { filter: "src/" });
  assert.deepEqual(
    view.rows.map((r) => r.path),
    ["src/zeta.ts", "src/alpha.ts"]
  );
  assert.equal(view.hiddenFiles, 1);
  assert.equal(view.hiddenAdded, 3);
  assert.equal(view.hiddenRemoved, 1);
  assert.equal(view.filtered, true);
});

test("필터가 없으면 숨긴 것도 없다", () => {
  const view = viewDiffs(SAMPLE);
  assert.equal(view.hiddenFiles, 0);
  assert.equal(view.filtered, false);
  assert.equal(hiddenNotice(view), null);
});

/**
 * **"변경이 없다"와 "필터가 다 걸러냈다"는 다른 사실이다.** 합치면 사용자는 되돌릴 것이
 * 없다고 읽는다 — 실제로는 되돌릴 것이 전부 있다.
 */
test("필터가 전부 걸러낸 상태를 변경 없음과 구별한다", () => {
  const view = viewDiffs(SAMPLE, { filter: "존재하지-않는-경로" });
  assert.equal(view.rows.length, 0);
  assert.equal(view.filtered, true);
  assert.equal(view.hiddenFiles, 3);

  const notice = hiddenNotice(view);
  assert.ok(notice, "다 걸러졌는데 아무 말도 하지 않았습니다");
  assert.ok(notice.includes("3개"), notice);

  // 변경이 정말 없는 경우와는 다른 결과여야 한다.
  const empty = viewDiffs([], { filter: "존재하지-않는-경로" });
  assert.equal(empty.hiddenFiles, 0);
  assert.equal(hiddenNotice(empty), null);
});

/** 안내 문구는 **되돌리기 범위가 화면과 다르다는 사실**을 말해야 한다. */
test("일부를 숨겼을 때 되돌리기 범위를 알린다", () => {
  const notice = hiddenNotice(viewDiffs(SAMPLE, { filter: "src/" }));
  assert.ok(notice?.includes("전부"), notice ?? "(없음)");
});

/** 원본 배열을 건드리지 않는다 — 정렬이 호출자의 목록을 재배열하면 다음 렌더가 달라진다. */
test("입력 배열을 뒤섞지 않는다", () => {
  const input: [string, string][] = [...SAMPLE];
  const before = input.map(([p]) => p);
  viewDiffs(input, { sort: "changes" });
  assert.deepEqual(
    input.map(([p]) => p),
    before,
    "입력 배열이 재배열됐습니다"
  );
});

test("행에 붙는 통계는 파일 헤더를 세지 않는다", () => {
  const rows = buildRows([diff("a.ts", 2, 3)]);
  assert.equal(rows[0]?.stat.added, 2);
  assert.equal(rows[0]?.stat.removed, 3);
});
