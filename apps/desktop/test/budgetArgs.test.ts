import test from "node:test";
import assert from "node:assert/strict";
import { budgetArgs, budgetLimitOf } from "../src/lib/budgetArgs.js";

/**
 * 화면의 예산 입력이 Rust가 받는 두 값으로 어떻게 번역되는가 — `budget.rs`의 `resolve_budget`.
 *
 * 값이 둘인 이유는 **"말하지 않은 것"과 "없음"을 구별하기 위해서다.** 인자를 빠뜨린 화면이
 * 상한을 조용히 끄면, 그 순간 예산 상한이라는 기능이 거짓이 된다.
 */

test("빈 입력은 상한 없음을 **명시적으로** 말한다", () => {
  assert.deepEqual(budgetArgs("   "), { budgetUsd: null, budgetUnlimited: true });
  assert.equal(budgetLimitOf(""), null);
});

test("수를 적으면 그 값이 상한이다", () => {
  assert.deepEqual(budgetArgs(" 2.5 "), { budgetUsd: 2.5, budgetUnlimited: false });
  assert.equal(budgetLimitOf("2.5"), 2.5);
});

/**
 * **오타를 무제한으로 접지 않는다.** 접으면 오타 하나가 상한을 지우고, 사용자는 자기가 건
 * 상한이 걸려 있다고 믿는다. 그대로 보내고 Rust가 거부한다.
 */
test("잘못된 값은 상한 없음이 되지 않는다", () => {
  for (const text of ["abc", "0", "-1"]) {
    const args = budgetArgs(text);
    assert.equal(args.budgetUnlimited, false, `${text}가 무제한이 됐습니다`);
  }
  assert.ok(Number.isNaN(budgetArgs("abc").budgetUsd as number));
  assert.equal(budgetArgs("0").budgetUsd, 0);
});
