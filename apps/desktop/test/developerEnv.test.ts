import test from "node:test";
import assert from "node:assert/strict";
import {
  describeDeveloperEnv,
  isDeveloperEnvProblem,
  toolEventDeservesAttention,
} from "../src/lib/developerEnv.js";

/**
 * **`null`은 "필요 없는 명령이었다"**이고 그건 아무 말도 하지 않아야 하는 경우다.
 * "준비하지 못했다"와 뭉개면 `npm test` 한 줄마다 경고가 붙는다.
 */
test("필요 없던 명령에는 아무 말도 하지 않는다", () => {
  assert.equal(describeDeveloperEnv(null), null);
  assert.equal(describeDeveloperEnv(undefined), null);
  assert.equal(isDeveloperEnvProblem(null), false);
});

/** 실패는 **처방까지** 말한다 — 이 기능의 값어치가 드러나는 유일한 순간이다. */
test("준비 실패는 처방과 함께, 그리고 명령이 그대로 돌았다는 사실을 말한다", () => {
  const text = describeDeveloperEnv({ kind: "notFound", advice: "TOMVERSE_VCVARSALL 을 설정하세요" });
  assert.ok(text?.includes("TOMVERSE_VCVARSALL"), text ?? "");
  // 막았다고 읽히면 사용자는 명령이 돌지 않았다고 생각한다.
  assert.ok(text?.includes("그대로 실행"), text ?? "");
  assert.equal(isDeveloperEnvProblem({ kind: "notFound" }), true);
});

/** 준비가 **불완전한 것**은 못 찾은 것과 다른 결말이다 — 다음에 할 일이 다르다. */
test("불완전한 준비는 못 찾은 것과 다른 문장이 된다", () => {
  const broken = describeDeveloperEnv({ kind: "broken", detail: "INCLUDE가 설정되지 않았습니다" });
  const notFound = describeDeveloperEnv({ kind: "notFound", advice: "x" });
  assert.ok(broken?.includes("INCLUDE"), broken ?? "");
  assert.notEqual(broken, notFound);
  assert.equal(isDeveloperEnvProblem({ kind: "broken" }), true);
});

/** 성공은 **조용하다.** 정상 동작이 로그를 채우면 이상 동작이 안 보인다. */
test("성공은 짧게 말하고 문제로 표시하지 않는다", () => {
  const text = describeDeveloperEnv({ kind: "prepared", names: ["INCLUDE", "LIB"] });
  assert.ok(text?.includes("2개"), text ?? "");
  assert.equal(isDeveloperEnvProblem({ kind: "prepared", names: [] }), false);
  // 처방을 붙이지 않는다 — 할 일이 없다.
  assert.ok(!text?.includes("그대로 실행"), text ?? "");
});

/** 모르는 형식에서 화면이 죽지 않는다. */
test("모르는 형식은 지어내지 않는다", () => {
  assert.equal(describeDeveloperEnv({ kind: "미래형식" }), null);
  assert.equal(describeDeveloperEnv("문자열"), null);
});

/**
 * **정상 동작은 조용하고 이상 동작은 보인다.** 모든 도구 실행을 보이면 목록이 `read_file`로
 * 덮이고, 전부 감추면 준비 실패가 개발자 모드에서만 보인다 — 그건 이 기능이 도우려는
 * 사용자가 켜지 않는 모드다.
 */
test("준비 실패한 도구 실행만 기본 목록에 올라온다", () => {
  assert.equal(
    toolEventDeservesAttention({ tool: "run_command", output: { developerEnv: { kind: "notFound" } } }),
    true
  );
  assert.equal(
    toolEventDeservesAttention({ tool: "run_command", output: { developerEnv: { kind: "prepared" } } }),
    false
  );
  // 개발자 환경과 무관한 도구는 조용하다.
  assert.equal(toolEventDeservesAttention({ tool: "read_file", output: { exitCode: 0 } }), false);
  assert.equal(toolEventDeservesAttention(null), false);
});
