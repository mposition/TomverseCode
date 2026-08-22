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

// ---- 15절: 역할별 모델 지정 ----

/**
 * **지정은 존중된다.** 정적 우선순위가 다른 것을 골랐을 값이라도 사용자가 고른 것을 쓴다.
 */
test("지정한 모델이 그 역할에 배정된다", () => {
  const decision = new Router(registry, { pinned: { executor: "gpt-4.1" } }).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["openai", "anthropic"],
  });
  const executor = decision.assignments.find((a) => a.role === "executor")!;
  assert.equal(executor.modelId, "gpt-4.1");
  assert.ok(executor.reason.includes("지정"), executor.reason);
});

/**
 * **지정은 대체하지 않는다.** 선호(`preferred`)는 쓸 수 없으면 조용히 다른 걸 쓰지만,
 * 지정은 사용자가 이번 태스크에 대해 고른 값이다 — 대체하면 고르지 않은 모델에 돈이 나간다.
 */
test("지정한 모델을 쓸 수 없으면 대체하지 않고 멈춘다", () => {
  assert.throws(
    () =>
      new Router(registry, { pinned: { executor: "claude-sonnet-5" } }).decide({
        taskId: "task-1",
        complexityTier: "standard",
        // anthropic 키가 없다 — 이건 "그 모델이 없다"가 아니라 "이 자격증명으로는 못 쓴다"이다.
        availableProviders: ["openai"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoutingError, `${error}`);
      assert.ok(error.message.includes("claude-sonnet-5"), error.message);
      // 무엇을 고쳐야 하는지 말해야 한다 — 키인지, 조직 인증인지, 오타인지가 다른 행동이다.
      assert.ok(error.message.includes("API 키"), error.message);
      return true;
    }
  );
});

/** 선호는 종전대로 대체한다 — 기본값과 사용자의 선택은 다른 것이다. */
test("선호는 쓸 수 없으면 대체하고 사유를 남긴다", () => {
  const decision = new Router(registry, { preferred: { executor: "claude-sonnet-5" } }).decide({
    taskId: "task-1",
    complexityTier: "simple",
    availableProviders: ["openai"],
  });
  const executor = decision.assignments.find((a) => a.role === "executor")!;
  assert.notEqual(executor.modelId, "claude-sonnet-5");
  assert.ok(executor.reason.includes("대체"), executor.reason);
});

/**
 * **불변식이 지정을 이긴다.** 지정한 검수자가 실행자와 같은 공급자면 독립 검수가 성립하지
 * 않는다. 다른 모델로 바꾸면 "지정은 대체하지 않는다"가 깨지고, 그대로 쓰면 원칙 4가 깨진다.
 * 원칙 4를 지키고 **드롭 사실을 표시한다** — 사용자 권위는 "무엇을 만들 것인가"에 대한
 * 것이고, "우리가 무엇을 검증이라 부를 것인가"는 우리가 파는 것이다.
 */
test("지정한 검수자가 독립적이지 않으면 바꾸지 않고 검수를 드롭한다", () => {
  const decision = new Router(registry, {
    pinned: { executor: "claude-sonnet-5", reviewer: "claude-opus-4-8" },
  }).decide({
    taskId: "task-1",
    complexityTier: "standard",
    // openai도 쓸 수 있다 — 즉 **독립 검수자를 뽑는 것이 가능했는데도** 바꾸지 않았다는 뜻이다.
    // 대조는 켜지 않았으므로 실행자는 anthropic 하나이고, 지정된 검수자도 anthropic이다.
    availableProviders: ["openai", "anthropic"],
  });

  assert.ok(!decision.activeRoles.includes("reviewer"), JSON.stringify(decision.assignments));
  assert.equal(decision.reviewerIndependent, false);
  const dropped = decision.appliedPolicies.find((p) => p.startsWith("reviewer_dropped:pinned_not_independent"));
  assert.ok(dropped, JSON.stringify(decision.appliedPolicies));
  // **다른 모델로 조용히 바뀌지 않았다.** anthropic이 후보에 있었으므로 대체는 가능했다.
  assert.ok(!decision.assignments.some((a) => a.role === "reviewer"));
  // 결정론적 검증은 그대로 돈다는 사실을 사유가 말해야 한다.
  assert.ok(dropped!.includes("VERIFYING"), dropped);
});

/** 지정이 없으면 종전 동작 그대로다 — 이 기능이 기존 경로를 바꾸지 않는다. */
test("지정이 없으면 정적 우선순위가 그대로 동작한다", () => {
  const withPinField = new Router(registry, { pinned: {} }).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["openai", "anthropic"],
  });
  const without = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["openai", "anthropic"],
  });
  assert.deepEqual(
    withPinField.assignments.map((a) => a.modelId),
    without.assignments.map((a) => a.modelId)
  );
});
