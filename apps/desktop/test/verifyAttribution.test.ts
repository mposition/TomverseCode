import test from "node:test";
import assert from "node:assert/strict";
import { attributionView, mixedLabel } from "../src/lib/verifyAttribution.js";

/** 원래 실패 하나 + 이번 변경이 깨뜨린 둘 — 54절이 고친 그 상황. */
function mixed() {
  return {
    newlyFailing: ["test"],
    preexistingFailures: ["test"],
    testAttribution: [
      {
        kind: "test",
        newlyFailing: ["tests/new.py::a", "tests/new.py::b"],
        preexisting: ["tests/old.py::broken"],
        fixed: [],
      },
    ],
  };
}

test("실패가 없으면 영역을 그리지 않는다", () => {
  assert.equal(attributionView({}).show, false);
  assert.equal(attributionView(null).show, false);
});

/**
 * **세 갈래는 배타여야 한다.** 54절이 섞인 체크를 `newlyFailing`에도 올렸으므로, 종전
 * 두 줄로 그리면 같은 체크가 양쪽에 나와 화면이 자기모순으로 읽힌다
 * ("새로 실패인데 변경 전부터 실패 중?").
 */
test("섞인 체크는 따로 묶인다", () => {
  const view = attributionView(mixed());
  assert.deepEqual(view.brokeOnly, []);
  assert.deepEqual(view.oldOnly, []);
  assert.equal(view.mixed.length, 1);
  assert.equal(view.mixed[0]!.kind, "test");
});

/**
 * **어느 쪽이 내 책임인지 이름으로 보여야 한다.** 54절 이전에는 이 체크가 "변경 전부터
 * 실패 중"으로만 보였다 — 모델에게 하던 거짓말과 같고, 청중만 달랐다.
 */
test("섞인 체크 안을 이름으로 가른다", () => {
  const g = attributionView(mixed()).mixed[0]!;
  assert.deepEqual(g.newTests, ["tests/new.py::a", "tests/new.py::b"]);
  assert.deepEqual(g.oldTests, ["tests/old.py::broken"]);
  assert.equal(g.split, true);
});

/** **"이건 당신 변경 때문이 아니다"라고 쓰지 않는다** — 이 묶음에서 그 문장은 거짓이다. */
test("섞인 체크의 문장이 무관하다고 말하지 않는다", () => {
  const label = mixedLabel(attributionView(mixed()).mixed[0]!);
  assert.ok(!label.includes("무관"), label);
  assert.match(label, /이번 변경이 깨뜨린 것 2개/);
  assert.match(label, /변경 전부터 실패하던 것 1개/);
});

/** 순수하게 원래 실패만인 체크에는 **"무관하다"가 남아야 한다** — 그건 여전히 참이다. */
test("원래 실패만인 체크는 무관하다고 말한다", () => {
  const view = attributionView({ preexistingFailures: ["lint"] });
  assert.equal(view.mixed.length, 0);
  assert.deepEqual(
    view.oldOnly.map((g) => g.kind),
    ["lint"]
  );
  assert.deepEqual(view.brokeOnly, []);
});

/** baseline이 통과했던 체크는 순수한 새 실패다. */
test("새로 깨진 체크만 있으면 따로 묶인다", () => {
  const view = attributionView({
    newlyFailing: ["build"],
    testAttribution: [{ kind: "build", newlyFailing: ["x"], preexisting: [], fixed: [] }],
  });
  assert.deepEqual(
    view.brokeOnly.map((g) => g.kind),
    ["build"]
  );
  assert.deepEqual(view.mixed, []);
  assert.deepEqual(view.oldOnly, []);
});

/**
 * **가르지 못한 것을 "없다"로 그리지 않는다.** 말없이 이름을 안 보여 주면 사용자는
 * "새로 깨진 것이 없다"로 읽는다.
 */
test("가르지 못했으면 그 사실을 말한다", () => {
  const view = attributionView({ newlyFailing: ["test"], preexistingFailures: [] });
  assert.equal(view.brokeOnly[0]!.split, false);
  assert.match(view.unsplitNote, /가르지 못했다/);
  assert.match(view.unsplitNote, /없다는 뜻이 아니라/);
});

/** 전부 갈랐으면 그 문장은 **없어야** 한다 — 언제나 붙으면 신호가 아니라 배경이 된다. */
test("전부 갈랐으면 그 문장이 없다", () => {
  assert.equal(attributionView(mixed()).unsplitNote, "");
});

/** 가르지 못한 섞인 체크에도 **무관하다는 말이 붙으면 안 된다.** */
test("가르지 못한 섞인 체크도 무관하다고 말하지 않는다", () => {
  const view = attributionView({ newlyFailing: ["test"], preexistingFailures: ["test"] });
  const label = mixedLabel(view.mixed[0]!);
  assert.ok(!label.includes("무관"), label);
  assert.match(label, /가르지 못했습니다/);
});

/**
 * **고친 것도 센다**(54.4절). 새 실패만 보여 주면 사용자는 변경이 순전히 나빴다고 읽는다 —
 * "다섯을 고치면서 둘을 깨뜨렸다"는 "둘을 깨뜨렸다"와 다른 사실이다.
 */
test("고쳐진 테스트가 따로 나온다", () => {
  const view = attributionView({
    newlyFailing: ["test"],
    preexistingFailures: ["test"],
    testAttribution: [{ kind: "test", newlyFailing: ["b"], preexisting: [], fixed: ["a1", "a2"] }],
  });
  assert.deepEqual(view.fixed, [{ kind: "test", tests: ["a1", "a2"] }]);
});
