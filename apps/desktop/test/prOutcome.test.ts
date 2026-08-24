import test from "node:test";
import assert from "node:assert/strict";
import { describePrOutcome, type PrResult } from "../src/lib/prOutcome.js";

const pushed: PrResult = {
  pushed: true,
  branch: "feature/x",
  remote: "origin",
  base: "main",
  title: "제목",
  body: "본문",
  compareUrl: "https://github.com/o/r/compare/main...feature/x?expand=1&title=%EC&body=%EB",
};

/**
 * **"PR을 만들었습니다"라고 쓰지 않는다.** 우리는 만들지 않았다 — 브랜치를 올리고 폼 주소를
 * 냈을 뿐이다(28.1절). 만들었다고 쓰면 사용자는 GitHub에 가서 없는 PR을 찾는다.
 */
test("폼 주소가 있어도 PR이 만들어졌다고 말하지 않는다", () => {
  const outcome = describePrOutcome(pushed);
  assert.equal(outcome.kind, "pushed_with_form");
  assert.equal(outcome.url, pushed.compareUrl);
  assert.match(outcome.detail, /아직 PR은 만들어지지 않았습니다/);
  assert.ok(!/PR을 만들었습니다/.test(outcome.headline + outcome.detail), outcome.detail);
});

/**
 * push는 성공했고 URL만 못 만든 것이다. 이걸 실패로 보이게 하면 사용자는 "다시 시도"를 누르는데,
 * 다시 눌러도 같은 결과다 — 할 일은 호스팅에서 직접 PR을 여는 것이다.
 */
test("폼 주소를 못 만든 것은 실패가 아니다", () => {
  const outcome = describePrOutcome({ ...pushed, compareUrl: null });
  assert.equal(outcome.kind, "pushed_no_form");
  assert.match(outcome.headline, /브랜치를 올렸습니다/);
  assert.match(outcome.detail, /직접 PR을 여세요/);
  assert.equal(outcome.url, null);
});

test("올리지 못했으면 그렇게 말한다", () => {
  const outcome = describePrOutcome({
    pushed: false,
    branch: "feature/x",
    remote: "origin",
    compareUrl: null,
    exitCode: 1,
    reason: null,
  });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.detail, /종료 코드 1/);
  assert.equal(outcome.url, null);
});

/** **원인을 지어내지 않는다.** 기록이 없으면 없다고 쓴다. */
test("사유도 종료 코드도 없으면 없다고 쓴다", () => {
  const outcome = describePrOutcome({
    pushed: false,
    branch: "feature/x",
    remote: "origin",
    compareUrl: null,
    exitCode: null,
    reason: null,
  });
  assert.match(outcome.detail, /기록되지 않았습니다/);
});
