import test from "node:test";
import assert from "node:assert/strict";
import type { ModelEntry } from "@tomverse/protocol";
import { BUILTIN_MODELS, ModelRegistry } from "../src/routing/registry.js";
import { Router, RoutingError, routerOptionsFromEnv } from "../src/routing/router.js";

const registry = new ModelRegistry();

test("standard tier는 executor와 reviewer를 서로 다른 공급자로 배정한다", () => {
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["openai", "anthropic"],
  });

  assert.deepEqual(decision.activeRoles.sort(), ["executor", "reviewer"]);
  const executor = decision.assignments.find((a) => a.role === "executor")!;
  const reviewer = decision.assignments.find((a) => a.role === "reviewer")!;

  // 5절 불변식 — 이게 교차검증의 전체 가치를 지탱한다.
  assert.notEqual(executor.providerId, reviewer.providerId);
  assert.equal(decision.reviewerIndependent, true);
});

test("독립 공급자가 없으면 reviewer를 드롭하고 그 사실을 드러낸다", () => {
  // 5절: 같은 공급자로 "검증한 척"하지 않는다.
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["anthropic"],
  });

  assert.deepEqual(decision.activeRoles, ["executor"]);
  assert.equal(decision.assignments.length, 1);
  assert.equal(decision.reviewerIndependent, false);
  const note = decision.appliedPolicies.find((p) => p.startsWith("reviewer_dropped"));
  assert.ok(note, `드롭 사유가 기록되어야 합니다: ${JSON.stringify(decision.appliedPolicies)}`);
  // 결정론적 검증은 그대로 수행된다는 사실을 사유에 남긴다.
  assert.ok(note!.includes("VERIFYING"));
});

test("같은 공급자의 두 모델로 교차검증을 흉내내지 않는다", () => {
  // anthropic에 claude-sonnet-5와 claude-opus-4-8이 둘 다 있지만, 같은 공급자이므로
  // reviewer로 쓰지 않는다 — "다른 모델"과 "다른 공급자"는 다른 보장이다.
  const anthropicModels = BUILTIN_MODELS.filter((m) => m.providerId === "anthropic");
  assert.ok(anthropicModels.length >= 2, "이 테스트는 같은 공급자에 모델이 2개 이상일 때 유효합니다");

  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["anthropic"],
  });
  assert.equal(decision.assignments.length, 1);
});

test("simple tier는 executor 하나만 배정한다", () => {
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "simple",
    availableProviders: ["openai", "anthropic"],
  });
  assert.deepEqual(decision.activeRoles, ["executor"]);
  assert.equal(decision.reviewerIndependent, false);
});

test("planner는 기본 비활성이다", () => {
  // 4절: 표현 가능하게 두되 켜지 않는다 (표준 태스크당 LLM 호출 3회는 스파이크 결과의 반대 방향).
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["openai", "anthropic"],
  });
  assert.ok(!decision.activeRoles.includes("planner"));
});

test("자격증명이 없는 공급자의 모델은 후보에서 제외한다", () => {
  // BYOK에서 모델 가용성은 전역 사실이 아니라 자격증명별 사실이다 (3절).
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "simple",
    availableProviders: ["openai"],
  });
  assert.equal(decision.assignments[0]!.providerId, "openai");
});

test("공급자가 하나도 없으면 안내와 함께 실패한다", () => {
  assert.throws(
    () => new Router(registry).decide({ taskId: "t", complexityTier: "simple", availableProviders: [] }),
    (error: unknown) => {
      assert.ok(error instanceof RoutingError);
      assert.ok(error.message.includes("API 키"));
      return true;
    }
  );
});

test("조직 인증이 필요한 모델은 기본적으로 후보에서 빠진다", () => {
  // gpt-5는 requiresOrgVerification: true다. 후보에 넣으면 호출 시점에
  // model_not_found로 실패하고, 사용자에게는 원인 불명의 실패로 보인다.
  const openaiOnly = registry.available(["openai"]);
  assert.ok(!openaiOnly.some((e) => e.modelId === "gpt-5.1"));
  assert.ok(openaiOnly.some((e) => e.modelId === "gpt-4.1"));

  const allowed = registry.available(["openai"], { allowOrgVerified: true });
  assert.ok(allowed.some((e) => e.modelId === "gpt-5.1"));
});

test("설정으로 역할별 모델을 지정할 수 있다", () => {
  const decision = new Router(registry, { preferred: { executor: "claude-sonnet-5" } }).decide({
    taskId: "t",
    complexityTier: "simple",
    availableProviders: ["openai", "anthropic"],
  });
  assert.equal(decision.assignments[0]!.modelId, "claude-sonnet-5");
  assert.ok(decision.assignments[0]!.reason.includes("지정"));
});

test("지정한 모델을 쓸 수 없으면 조용히 대체하지 않고 사유를 남긴다", () => {
  const decision = new Router(registry, { preferred: { executor: "gpt-5.1" } }).decide({
    taskId: "t",
    complexityTier: "simple",
    availableProviders: ["anthropic"],
  });
  assert.notEqual(decision.assignments[0]!.modelId, "gpt-5.1");
  assert.ok(
    decision.assignments[0]!.reason.includes("대체"),
    `대체 사유가 기록되어야 합니다: ${decision.assignments[0]!.reason}`
  );
});

test("fake 공급자 두 개로도 독립성 불변식이 성립한다", () => {
  // fake를 특별 취급하지 않는 덕분에 이 불변식을 실제로 테스트할 수 있다.
  const decision = new Router(registry).decide({
    taskId: "t",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b"],
  });
  assert.equal(decision.reviewerIndependent, true);
  assert.notEqual(
    decision.assignments.find((a) => a.role === "executor")!.providerId,
    decision.assignments.find((a) => a.role === "reviewer")!.providerId
  );
});

test("deprecated 모델은 후보에서 빠진다", () => {
  const deprecated: ModelEntry = {
    ...registry.get("gpt-4.1")!,
    modelId: "old-model",
    availability: { requiresOrgVerification: false, deprecatedAfter: "2020-01-01T00:00:00Z" },
  };
  const custom = new ModelRegistry([deprecated]);
  assert.equal(custom.available(["openai"]).length, 0);
});

test("환경변수에서 라우터 옵션을 읽는다", () => {
  const options = routerOptionsFromEnv({
    TOMVERSE_EXECUTOR_MODEL: "gpt-4.1",
    TOMVERSE_REVIEWER_MODEL: "claude-sonnet-5",
    TOMVERSE_ALLOW_ORG_VERIFIED: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(options.preferred?.executor, "gpt-4.1");
  assert.equal(options.preferred?.reviewer, "claude-sonnet-5");
  assert.equal(options.allowOrgVerified, true);
});
