import test from "node:test";
import assert from "node:assert/strict";
import type { DraftProposal } from "@tomverse/protocol";
import { contrastDrafts, planQuestionRound, MAX_QUESTIONS_PER_ROUND } from "../src/orchestrator/contrast.js";

/**
 * 구조적 대조 — docs/design/state-machine-and-protocol.md 17절.
 *
 * 이 파일이 고정하는 것은 **대조가 판정이 아니라 질문 생성이라는 사실**이다. 어느 초안이 옳은지
 * 정하는 코드가 들어오면 여기 테스트가 아니라 product-strategy 16.1절이 깨진다.
 */

function draft(overrides: Partial<DraftProposal> & { proposalId: string }): DraftProposal {
  return {
    taskId: "task-1",
    interpretation: "이메일 검증이 빠졌다",
    relevantFiles: [],
    plan: [{ stepId: "s1", description: "고친다", targetPaths: ["src/validate.ts"] }],
    risks: [],
    requiredTests: ["validate.test.ts"],
    uncertainties: [],
    doneCriteria: ["빈 문자열을 거부한다"],
    model: "fake",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function run(a: DraftProposal, b?: DraftProposal, tier: "simple" | "standard" = "standard") {
  return contrastDrafts({
    taskId: "task-1",
    proposals: b ? [a, b] : [a],
    complexityTier: tier,
    round: 1,
  });
}

test("초안이 하나뿐이면 불일치도 일치도 없다 (대조하지 않았다는 사실이 남는다)", () => {
  // 라우터가 독립 executor 둘을 배정하지 못해 대조를 드롭한 경우가 정상 경로다(13.2절).
  // 여기서 예외를 던지면 그 정상 경로가 실패가 된다.
  const report = run(draft({ proposalId: "p1" }));
  assert.deepEqual(report.disagreements, []);
  assert.deepEqual(report.agreedFields, []);
  assert.deepEqual(report.proposalIds, ["p1"]);
});

test("완전히 같은 초안 둘은 불일치를 만들지 않는다", () => {
  const report = run(draft({ proposalId: "p1" }), draft({ proposalId: "p2" }));
  assert.deepEqual(report.disagreements, []);
  // 일치는 **검증이 아니다** — agreedFields라는 이름을 쓰는 이유(16.5절).
  assert.ok(report.agreedFields.includes("doneCriteria"));
  assert.ok(report.agreedFields.includes("targetPaths"));
});

test("표기 차이(공백·대소문자·경로 구분자)는 불일치가 아니다", () => {
  const report = run(
    draft({ proposalId: "p1", plan: [{ stepId: "s", description: "d", targetPaths: ["src/validate.ts"] }] }),
    draft({
      proposalId: "p2",
      // Windows 스타일 구분자 + 대소문자 + 여분 공백. 이걸 이견으로 세면 카드가 잡음으로 덮인다.
      plan: [{ stepId: "s", description: "d", targetPaths: ["  src\\Validate.TS "] }],
    })
  );
  assert.ok(report.agreedFields.includes("targetPaths"), JSON.stringify(report.disagreements));
});

test("doneCriteria가 갈리면 항상 blocking이다", () => {
  const report = run(
    draft({ proposalId: "p1", doneCriteria: ["빈 문자열을 거부한다"] }),
    draft({ proposalId: "p2", doneCriteria: ["빈 문자열을 통과시킨다"] })
  );
  const done = report.disagreements.find((d) => d.field === "doneCriteria");
  assert.ok(done, "완료 기준 불일치가 감지되지 않았습니다");
  assert.equal(done!.blocking, true);
  // 강제 선택 — 개방형 확인("이렇게 이해했는데 맞습니까?")을 만들지 않는다(16.2절 ②).
  assert.equal(done!.question.options.length, 2);
  assert.equal(done!.question.allowFreeform, true);
  // 각 선택지는 어느 초안에서 왔는지 추적 가능해야 한다.
  assert.deepEqual(
    done!.question.options.map((o) => o.fromProposalId),
    ["p1", "p2"]
  );
});

test("선택지 라벨에 모델 이름이 들어가지 않는다", () => {
  // 3.9절: 출처가 보이면 사용자가 요구가 아니라 **모델 선호로 판단**한다.
  const report = run(
    draft({ proposalId: "p1", model: "gpt-5", doneCriteria: ["A"] }),
    draft({ proposalId: "p2", model: "claude-opus-5", doneCriteria: ["B"] })
  );
  const labels = report.disagreements.flatMap((d) => d.question.options.map((o) => o.label));
  for (const label of labels) {
    assert.ok(!label.includes("gpt"), `선택지 라벨에 모델 이름이 있습니다: ${label}`);
    assert.ok(!label.includes("claude"), `선택지 라벨에 모델 이름이 있습니다: ${label}`);
  }
});

test("targetPaths는 서로소일 때만 blocking이다", () => {
  const disjoint = run(
    draft({ proposalId: "p1", plan: [{ stepId: "s", description: "d", targetPaths: ["src/validate.ts"] }] }),
    draft({ proposalId: "p2", plan: [{ stepId: "s", description: "d", targetPaths: ["src/api/login.ts"] }] })
  );
  assert.equal(disjoint.disagreements.find((d) => d.field === "targetPaths")?.blocking, true);

  // 겹치는 파일이 하나라도 있으면 두 초안이 같은 문제를 보고 범위만 다르게 잡은 것이다.
  const overlapping = run(
    draft({ proposalId: "p1", plan: [{ stepId: "s", description: "d", targetPaths: ["src/validate.ts"] }] }),
    draft({
      proposalId: "p2",
      plan: [{ stepId: "s", description: "d", targetPaths: ["src/validate.ts", "src/api/login.ts"] }],
    })
  );
  assert.equal(overlapping.disagreements.find((d) => d.field === "targetPaths")?.blocking, false);
});

test("interpretation/risks는 갈려도 blocking이 아니다", () => {
  // 자유 서술이라 표현만 달라도 갈린 것으로 보인다. blocking으로 만들면 거의 모든 태스크가
  // 질문을 만들고, 예산이 진짜 쟁점에 도달하기 전에 소진된다.
  const report = run(
    draft({ proposalId: "p1", interpretation: "오프바이원", risks: ["기존 호출부 영향"] }),
    draft({ proposalId: "p2", interpretation: "경계 조건 누락", risks: ["성능"] })
  );
  for (const field of ["interpretation", "risks"] as const) {
    const d = report.disagreements.find((x) => x.field === field);
    assert.ok(d, `${field} 불일치가 감지되지 않았습니다`);
    assert.equal(d!.blocking, false);
  }
});

test("양쪽 다 비어 있는 필드는 일치로도 불일치로도 세지 않는다", () => {
  // 침묵을 동의로 보고하면 agreedFields가 거짓말을 한다.
  const report = run(
    draft({ proposalId: "p1", risks: [] }),
    draft({ proposalId: "p2", risks: [] })
  );
  assert.ok(!report.agreedFields.includes("risks"));
  assert.ok(!report.disagreements.some((d) => d.field === "risks"));
});

test("blocking 판정에는 언제나 규칙 기반 근거가 붙는다", () => {
  // 모델에게 "이게 심각한가"를 묻지 않으므로(17.4절), 판정은 항상 문장으로 설명할 수 있어야 한다.
  const report = run(
    draft({ proposalId: "p1", doneCriteria: ["A"], interpretation: "X" }),
    draft({ proposalId: "p2", doneCriteria: ["B"], interpretation: "Y" })
  );
  assert.ok(report.disagreements.length > 0);
  for (const d of report.disagreements) {
    assert.ok(d.blockingReason.trim().length > 0, `${d.field}에 판정 근거가 없습니다`);
  }
});

test("질문은 랭킹 순으로 나오고 상한을 넘긴 것은 deferred로 남는다", () => {
  const report = run(
    draft({
      proposalId: "p1",
      doneCriteria: ["A"],
      requiredTests: ["t1"],
      plan: [{ stepId: "s", description: "d", targetPaths: ["a.ts"] }],
    }),
    draft({
      proposalId: "p2",
      doneCriteria: ["B"],
      requiredTests: ["t2"],
      plan: [{ stepId: "s", description: "d", targetPaths: ["b.ts"] }],
    })
  );

  const { asked, deferred } = planQuestionRound(report, 2);
  // 17.4절 랭킹: doneCriteria > targetPaths > requiredTests
  assert.deepEqual(
    asked.map((d) => d.field),
    ["doneCriteria", "targetPaths"]
  );
  // **조용히 버리지 않는다** — "물어볼 수 없었다"와 "쟁점이 없었다"는 다른 사실이다.
  assert.deepEqual(
    deferred.map((d) => d.field),
    ["requiredTests"]
  );
});

test("비-blocking 쟁점은 질문 목록에 들어가지 않는다", () => {
  // 필수와 참고를 같은 목록에 섞으면 전부 참고 항목처럼 읽힌다(3.9절).
  const report = run(
    draft({ proposalId: "p1", doneCriteria: ["A"], interpretation: "X" }),
    draft({ proposalId: "p2", doneCriteria: ["B"], interpretation: "Y" })
  );
  const { asked, deferred } = planQuestionRound(report);
  assert.ok(asked.every((d) => d.blocking));
  assert.ok(deferred.every((d) => d.blocking));
  assert.ok(!asked.some((d) => d.field === "interpretation"));
  assert.ok(!deferred.some((d) => d.field === "interpretation"));
});

test("한 라운드 질문 상한은 한 화면에 들어가는 수다", () => {
  // 라운드는 왕복 횟수이지 질문 개수가 아니다(17.4절) — 세 번 깨우는 것이 최악이므로
  // 여러 쟁점을 한 카드에 묶는다. 다만 스크롤이 생길 만큼 묶지는 않는다.
  assert.ok(MAX_QUESTIONS_PER_ROUND >= 3 && MAX_QUESTIONS_PER_ROUND <= 4);
});

test("simple tier에서는 requiredTests 차이가 blocking이 아니다", () => {
  const report = run(
    draft({ proposalId: "p1", requiredTests: ["t1"] }),
    draft({ proposalId: "p2", requiredTests: ["t2"] }),
    "simple"
  );
  assert.equal(report.disagreements.find((d) => d.field === "requiredTests")?.blocking, false);
});
