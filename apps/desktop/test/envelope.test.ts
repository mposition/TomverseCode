import test from "node:test";
import assert from "node:assert/strict";
import { unwrap, type Envelope } from "../src/lib/envelope.js";

/**
 * 봉투 벗기기 — ui-wireframes.md 6.4·6.5절.
 *
 * 여기서 검증하는 실패는 **조용하다**: 봉투를 잘못 읽어도 성공 경로에서는 아무 일도 없고,
 * 실제로 저장 계층이 실패하는 날에만 화면이 이상해진다.
 */

test("성공이면 ok 키를 벗기고 값만 준다", () => {
  const response: Envelope<{ tasks: string[]; nextCursor: string | null }> = {
    ok: true,
    tasks: ["t1"],
    nextCursor: null,
  };
  const result = unwrap(response);
  assert.equal(result.ok, true);
  // `ok`가 값에 남으면 그 값을 그대로 상태에 넣는 코드가 화면 어딘가에서 그걸 보게 된다.
  assert.deepEqual(result.ok && result.value, { tasks: ["t1"], nextCursor: null });
});

test("실패면 카탈로그가 만든 문장을 준다 — 원문을 그대로 쓰지 않는다", () => {
  const result = unwrap({
    ok: false,
    code: "storeReadTasks",
    params: { detail: "database is locked" },
    message: "(Rust 원문)",
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problem.text.includes("작업 목록을 읽을 수 없습니다"), JSON.stringify(result));
  assert.ok(!result.ok && result.problem.text.includes("database is locked"));
  assert.equal(!result.ok && result.problem.untranslated, false);
});

test("모르는 코드는 원문으로 떨어지고 그 사실을 표시한다", () => {
  const result = unwrap({ ok: false, code: "아직-없는-코드", message: "Rust가 준 원문" });
  assert.equal(!result.ok && result.problem.text, "Rust가 준 원문");
  assert.equal(!result.ok && result.problem.untranslated, true);
});

/**
 * **`ok`가 없는 응답을 성공으로 읽지 않는다.** 그렇게 읽으면 전환을 빠뜨린 명령이 조용히
 * 통과하고, 그 사실은 실패가 실제로 일어나는 날에야 드러난다.
 */
test("봉투가 아닌 응답은 성공이 아니다", () => {
  const notAnEnvelope = { tasks: [] } as unknown as Envelope<{ tasks: string[] }>;
  const result = unwrap(notAnEnvelope);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problem.text.includes("전환되지 않았습니다"), JSON.stringify(result));
});

test("응답이 없어도 터지지 않는다", () => {
  for (const value of [null, undefined]) {
    const result = unwrap(value);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problem.text.length > 0);
  }
});

/** `ok: false`인데 코드가 비어 있으면 원문으로 떨어진다 — 빈 문장을 그리지 않는다. */
test("실패 봉투에 코드가 없어도 문장이 남는다", () => {
  const result = unwrap({ ok: false, code: "", message: "무슨 일이 났다" } as Envelope<never>);
  assert.equal(!result.ok && result.problem.text, "무슨 일이 났다");
});
