import test from "node:test";
import assert from "node:assert/strict";
import type { ModelEntry } from "@tomverse/protocol";
import { BUILTIN_MODELS, ModelRegistry } from "../src/routing/registry.js";
import { Router, RoutingError, routerOptionsFromEnv } from "../src/routing/router.js";

const registry = new ModelRegistry();

/**
 * **이 파일의 `standard` 기대값은 72절이 통째로 바꾼 것이다 — 회귀가 아니다.**
 *
 * 종전 계약은 *"`standard`는 executor와 reviewer를 서로 다른 공급자로 배정한다"*였다.
 * 72.3절이 `REVIEWING`을 standard 경로에서 물러나게 하고 72.9절이 대조를 계획 단계로
 * 옮기면서, 그 자리에 자리 넷이 들어왔다: A(계획) · A′(대조 계획) · B(계획 검토) ·
 * C(결과 검토). `reviewer` 역할은 지우지 않았지만 **새 태스크가 그 자리를 배정하지 않는다.**
 */
test("standard tier는 계획자와 두 검토자를 배정한다", () => {
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b", "fake-c"],
  });

  assert.ok(decision.activeRoles.includes("planner"), decision.activeRoles.join(", "));
  assert.ok(decision.activeRoles.includes("executor"), decision.activeRoles.join(", "));
  // 종전 `reviewer`는 새 태스크에 배정되지 않는다(72.3절).
  assert.ok(!decision.activeRoles.includes("reviewer"), decision.activeRoles.join(", "));

  const planner = decision.assignments.find((a) => a.role === "planner")!;
  const planReviewer = decision.assignments.find((a) => a.role === "planReviewer");
  const resultReviewer = decision.assignments.find((a) => a.role === "resultReviewer");
  const executor = decision.assignments.find((a) => a.role === "executor")!;

  // 21.6절 하드 불변식 둘. 만족하지 못하면 같은 공급자로 "검토한 척"하지 않고 드롭한다.
  if (planReviewer) assert.notEqual(planReviewer.providerId, planner.providerId);
  if (resultReviewer) assert.notEqual(resultReviewer.providerId, executor.providerId);
});

/**
 * **`unmeasured`는 A·B·C에 기본 배정하지 않는다**(21.6절).
 *
 * 이 세 자리가 **독립성 주장의 근거**이고, 검증되지 않은 어댑터가 거기 앉으면 우리 주장이
 * 검증되지 않은 것 위에 선다. 오늘 카탈로그의 실제 공급자는 전부 `unmeasured`이므로
 * (21.8절: "코드를 다 짜도 측정 전까지 A/B/C 독립성은 그대로 막혀 있다") **실제 공급자만으로는
 * B·C가 드롭된다.** 그 사실을 여기 못박는다 — 나중에 누가 필터를 풀면 이 검사가 실패한다.
 */
test("측정되지 않은 공급자는 검토 자리에 앉지 않는다", () => {
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["openai", "anthropic"],
  });
  assert.equal(decision.planReviewIndependence, "dropped");
  assert.equal(decision.resultReviewIndependence, "dropped");
  // **A는 막지 않는다.** 태스크가 돌지 않으면 아무것도 측정되지 않으므로 A까지 막으면
  // 부트스트랩이 닫힌다(21.6절) — 금지의 범위는 검토 자리다.
  assert.ok(decision.activeRoles.includes("planner"));
});

test("검토를 드롭하면 그 사실과 근거가 남는다", () => {
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["anthropic"],
  });
  assert.equal(decision.planReviewIndependence, "dropped");
  const note = decision.appliedPolicies.find((p) => p.startsWith("plan_review_dropped"));
  assert.ok(note, `드롭 사유가 기록되어야 합니다: ${JSON.stringify(decision.appliedPolicies)}`);
  // 결정론적 검증은 그대로 수행된다는 사실을 사유에 남긴다 — 드롭은 흐름을 막지 않는다.
  assert.ok(note!.includes("VERIFYING"));
});

test("같은 공급자의 두 모델로 독립 검토를 흉내내지 않는다", () => {
  // anthropic에 모델이 둘 있지만 같은 공급자이므로 검토 자리에 쓰지 않는다 —
  // "다른 모델"과 "다른 공급자"는 다른 보장이다.
  const anthropicModels = BUILTIN_MODELS.filter((m) => m.providerId === "anthropic");
  assert.ok(anthropicModels.length >= 2, "이 테스트는 같은 공급자에 모델이 2개 이상일 때 유효합니다");

  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["anthropic"],
  });
  assert.equal(decision.assignments.filter((a) => a.role === "planReviewer").length, 0);
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

/**
 * ~~planner는 기본 비활성이다~~ → **72절이 뒤집었다.**
 *
 * 4절은 "표현 가능하게 두되 켜지 않는다"고 적었고 근거는 *"표준 태스크당 LLM 호출 3회는
 * 스파이크 결과의 반대 방향"*이었다. 72절 흐름에서 `standard`는 **계획으로 시작한다** —
 * 계획 호출 한 번이 분해·등급·N개의 구현 호출을 전부 결정하므로 흐름에서 한계 수익이 가장
 * 큰 호출이고, 그 자리를 비우면 흐름 자체가 성립하지 않는다.
 *
 * **`simple`에는 여전히 planner가 없다.** 그 경로는 바뀌지 않았다(72절 첫 문단).
 */
test("simple에는 계획자가 없다", () => {
  const decision = new Router(registry).decide({
    taskId: "task-1",
    complexityTier: "simple",
    availableProviders: ["openai", "anthropic"],
  });
  assert.ok(!decision.activeRoles.includes("planner"));
  assert.deepEqual(decision.activeRoles, ["executor"]);
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
  // fake를 특별 취급하지 않는 덕분에 이 불변식을 실제로 테스트할 수 있다 —
  // 그것이 레지스트리가 fake 엔트리에 `grade`를 적어 둔 이유이기도 하다.
  const decision = new Router(registry).decide({
    taskId: "t",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b"],
  });
  const planner = decision.assignments.find((a) => a.role === "planner")!;
  const planReviewer = decision.assignments.find((a) => a.role === "planReviewer");
  assert.ok(planReviewer, JSON.stringify(decision.assignments));
  assert.notEqual(planReviewer!.providerId, planner.providerId);
  assert.equal(decision.planReviewIndependence, "independent");
});

/**
 * **C = B는 허용되는 유일한 예외다**(21.6절). 이유는 **B가 코드를 쓰지 않았기 때문** —
 * 자기 산출물을 자기가 승인하는 경우가 아니다. 그래도 계획에 관여했으므로 **부분적
 * 자기검토**임을 기록이 말해야 한다: 감추면 13.3절보다 정직성이 후퇴한다.
 */
test("공급자가 둘뿐이면 결과 검토자가 계획 검토자와 같아지고 그 사실이 남는다", () => {
  const decision = new Router(registry).decide({
    taskId: "t",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b"],
  });
  const planReviewer = decision.assignments.find((a) => a.role === "planReviewer")!;
  const resultReviewer = decision.assignments.find((a) => a.role === "resultReviewer");
  if (resultReviewer && resultReviewer.providerId === planReviewer.providerId) {
    assert.equal(decision.resultReviewIndependence, "shares_provider");
    assert.ok(
      decision.appliedPolicies.some((p) => p.startsWith("result_reviewer_shares_provider_with_plan_reviewer")),
      JSON.stringify(decision.appliedPolicies)
    );
  }
  // **C가 코드를 쓴 공급자와 같아지는 일은 없어야 한다** — 그건 하드 불변식이다.
  const executor = decision.assignments.find((a) => a.role === "executor")!;
  if (resultReviewer) assert.notEqual(resultReviewer.providerId, executor.providerId);
});

/**
 * **대조가 켜지면 B = A′가 구조적 상수다**(21.6절).
 *
 * 사용자가 고르는 것이 아니다 — 17.8①이 "살아남는 초안은 primary다"라고 이미 정했으므로,
 * 살아남지 않은 쪽의 계획자를 B로 쓰면 자기 계획을 자기가 검토하는 일이 생기지 않는다.
 * 그리고 **그건 완전 독립이 아니다**: 같은 스냅샷을 같은 시점에 본 당사자다.
 */
test("대조가 켜지면 계획 검토자가 대조 참가자일 수 있고 그 대가가 기록된다", () => {
  const decision = new Router(registry).decide({
    taskId: "t",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b"],
    contrast: true,
  });
  const planners = decision.assignments.filter((a) => a.role === "planner");
  assert.equal(planners.length, 2, "대조 계획자가 배정되지 않았습니다");
  assert.notEqual(planners[0]!.providerId, planners[1]!.providerId);

  const planReviewer = decision.assignments.find((a) => a.role === "planReviewer");
  if (planReviewer && planReviewer.providerId === planners[1]!.providerId) {
    assert.equal(decision.planReviewIndependence, "shares_provider");
    assert.ok(
      decision.appliedPolicies.some((p) => p.startsWith("plan_reviewer_was_contrast_participant")),
      JSON.stringify(decision.appliedPolicies)
    );
  }
});

/** 72.9절: **둘이 되는 것은 executor가 아니라 계획자다.** */
test("대조는 실행자를 늘리지 않는다", () => {
  const decision = new Router(registry).decide({
    taskId: "t",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b", "fake-c"],
    contrast: true,
  });
  assert.equal(decision.assignments.filter((a) => a.role === "executor").length, 1);
  assert.equal(decision.assignments.filter((a) => a.role === "planner").length, 2);
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
/**
 * 15.2절 — 지정한 검토자가 독립성 요구를 만족하지 못하면 **바꾸지 않고 드롭한다.**
 *
 * 바꿔 배정하면 "지정은 대체하지 않는다"가 깨지고, 그대로 쓰면 원칙 4가 깨진다.
 * **원칙 4를 지킨다.**
 *
 * **자리가 둘로 갈린 뒤로 이 판정도 자리마다 따로 한다**(72.15절) — `reviewer` 한 자리뿐일
 * 때는 이 규칙이 어느 검토자에 걸리는지 정해지지 않았다.
 */
test("지정한 계획 검토자가 독립적이지 않으면 바꾸지 않고 드롭한다", () => {
  const decision = new Router(registry, {
    // fake-b는 계획자(fake-a)와 다른 공급자이므로 정상 배정이 가능한 상태에서,
    // **계획자와 같은 공급자**를 지정해 본다.
    pinned: { planner: "fake-executor", planReviewer: "fake-executor" },
  }).decide({
    taskId: "task-1",
    complexityTier: "standard",
    availableProviders: ["fake-a", "fake-b", "fake-c"],
  });

  assert.equal(decision.planReviewIndependence, "dropped");
  const dropped = decision.appliedPolicies.find((p) => p.startsWith("plan_review_dropped:pinned_not_independent"));
  assert.ok(dropped, JSON.stringify(decision.appliedPolicies));
  // **다른 모델로 조용히 바뀌지 않았다.** fake-b/fake-c가 후보에 있었으므로 대체는 가능했다.
  assert.ok(!decision.assignments.some((a) => a.role === "planReviewer"));
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
