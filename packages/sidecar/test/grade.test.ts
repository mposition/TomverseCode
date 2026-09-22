import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanSubtask } from "@tomverse/protocol";
import { decideGrade, decideGrades } from "../src/orchestrator/grade.js";
import { DEFAULT_TRIAGE_POLICY } from "../src/triage.js";

const RISK = DEFAULT_TRIAGE_POLICY.riskPathSegments;

function subtask(over: Partial<PlanSubtask> = {}): PlanSubtask {
  return { subtaskId: "s1", intent: "i", files: [], proposedGrade: "economy", ...over };
}

/**
 * `balanced`는 **항등이다** — 계획 모델의 판정을 그대로 쓴다(72.10절).
 *
 * 기본값이 clamp를 걸면 제품이 "등급 판정을 계획 모델에게 맡긴다"는 자기 입장을 뒤집는다.
 */
test("balanced는 계획 모델의 판정을 바꾸지 않는다", () => {
  for (const proposed of ["economy", "frontier", "unmeasured"] as const) {
    const d = decideGrade(subtask({ proposedGrade: proposed }), "balanced", RISK);
    assert.equal(d.final, proposed);
    assert.equal(d.clamped, false);
  }
});

/**
 * **내릴 수 있어야 한다는 것이 중요하다.** 내리지 못하면 `economy` 프로파일이 아무 일도
 * 하지 않는다 — 싼 모델에 쉬운 조각을 주는 것이 그 프로파일의 전부다.
 */
test("economy는 frontier 판정을 내린다", () => {
  const d = decideGrade(subtask({ proposedGrade: "frontier" }), "economy", RISK);
  assert.equal(d.final, "economy");
  assert.equal(d.clamped, true);
});

/**
 * `unmeasured`를 `economy`로 **접지 않는다**(21.4절) — 싸다는 것은 가격에 대한 사실이고
 * 등급은 품질에 대한 사실이다. 다만 clamp에서는 취급이 갈린다.
 */
test("economy는 미측정도 내리고 max는 미측정을 올리지 않는다", () => {
  // `economy`가 미측정을 통과시키면 "싼 것만 쓰겠다"는 선택이 지켜지지 않는다.
  assert.equal(decideGrade(subtask({ proposedGrade: "unmeasured" }), "economy", RISK).final, "economy");
  // `max`가 미측정을 올리면 **재지 않은 것을 가장 센 등급이라고 말하는 셈**이다.
  assert.equal(decideGrade(subtask({ proposedGrade: "unmeasured" }), "max", RISK).final, "unmeasured");
  assert.equal(decideGrade(subtask({ proposedGrade: "economy" }), "max", RISK).final, "frontier");
});

/**
 * **위험 하한선은 clamp보다 세다**(72.10절).
 *
 * 사용자가 고르는 것은 비용이지 위험 감수 수준이 아니고, 후자를 비용 선택에 딸려 보내면
 * 그 선택의 뜻이 달라진다.
 */
test("economy를 골라도 결제·인증 경로는 내려가지 않는다", () => {
  const d = decideGrade(
    subtask({ proposedGrade: "economy", files: ["src/payment/charge.ts"] }),
    "economy",
    RISK
  );
  assert.equal(d.final, "frontier");
  assert.deepEqual(d.riskSegments, ["payment"]);
});

/**
 * **순서가 이 계산에서 유일하게 틀리기 쉬운 자리다.** 하한선을 clamp 앞에 두면
 * `economy` 프로파일이 하한선을 도로 내려 버린다.
 */
test("하한선은 clamp 뒤에 적용된다", () => {
  // 제안이 frontier이고 프로파일이 economy이며 위험 경로다 — 앞에 두면 결과가 economy가 된다.
  const d = decideGrade(
    subtask({ proposedGrade: "frontier", files: ["app/auth/session.ts"] }),
    "economy",
    RISK
  );
  assert.equal(d.final, "frontier", "하한선이 clamp에 먹혔습니다");
});

/** 잡음이 섞이면 이 신호는 "전부 frontier"로 수렴한다 — 판정 규칙은 TRIAGE의 것을 그대로 쓴다. */
test("이름 일부가 겹치는 경로는 하한선에 걸리지 않는다", () => {
  const d = decideGrade(subtask({ files: ["src/author.ts", "src/tokenizer.ts"] }), "economy", RISK);
  assert.deepEqual(d.riskSegments, []);
  assert.equal(d.final, "economy");
});

/** 여러 조각이 각각 다른 답을 낼 수 있어야 `balanced`가 뜻을 갖는다. */
test("서브태스크마다 다른 등급이 나온다", () => {
  const decided = decideGrades(
    [
      subtask({ subtaskId: "a", proposedGrade: "economy", files: ["src/util.ts"] }),
      subtask({ subtaskId: "b", proposedGrade: "frontier", files: ["src/core.ts"] }),
      subtask({ subtaskId: "c", proposedGrade: "economy", files: ["src/auth/login.ts"] }),
    ],
    "balanced",
    RISK
  );
  assert.deepEqual(
    decided.map((d) => `${d.subtaskId}:${d.final}`),
    ["a:economy", "b:frontier", "c:frontier"]
  );
});
