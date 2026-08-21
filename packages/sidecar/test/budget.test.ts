import test from "node:test";
import assert from "node:assert/strict";
import type { ModelEntry, TaskRequest } from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { ModelRegistry, providerKindOf } from "../src/routing/registry.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy } from "./helpers/fixtures.js";
import { DEFAULT_RETRY_POLICY } from "../src/providers/retry.js";
import { createBudgetLedger } from "../src/budget/ledger.js";

/**
 * 제품 호출 경로의 예산 상한 (multi-engine-routing.md 10.6절).
 *
 * # 왜 별도 레지스트리가 필요한가
 *
 * 기본 fake 모델은 단가가 0이다(fake는 실제로 공짜다). 그 레지스트리로는 상한이 **무엇도
 * 막지 않는 상태에서 통과**하므로, 여기서 통과한 테스트가 상한에 대해 아무것도 말하지 않는다.
 * 그래서 같은 fake 어댑터를 쓰되 **가격이 붙은** 레지스트리를 주입한다.
 */

/** 한 호출의 최대 비용 = 입력 60,000 토큰 × $10/MTok + 출력 8,192 토큰 × $30/MTok. */
const MAX_CALL_USD = (60_000 / 1_000_000) * 10 + (8_192 / 1_000_000) * 30;
/** fake 어댑터가 보고하는 실제 사용량(1,200 / 340)으로 계산한 호출당 실제 비용. */
const ACTUAL_CALL_USD = (1_200 / 1_000_000) * 10 + (340 / 1_000_000) * 30;

function pricedEntry(modelId: string, providerId: string, priced: boolean): ModelEntry {
  return {
    modelId,
    providerId,
    protocol: "native",
    apiBaseUrl: "local://fake",
    apiKeyEnvName: "TOMVERSE_FAKE_KEY",
    capabilities: {
      toolCalling: "basic",
      structuredOutput: "strict_schema",
      imageInput: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    economics: priced
      ? { inputPerMTok: 10, outputPerMTok: 30, pricingAsOf: "2026-01-01" }
      : // 단가를 모르는 모델. 0으로 두면 "공짜"가 되어 상한이 아무것도 막지 못하므로,
        // 모르는 것은 수가 아닌 값으로 둔다.
        { inputPerMTok: Number.NaN, outputPerMTok: Number.NaN, pricingAsOf: "2026-01-01" },
    availability: { requiresOrgVerification: false },
  };
}

function pricedRegistry(priced = true): ModelRegistry {
  return new ModelRegistry([
    pricedEntry("fake-executor", "fake-a", priced),
    pricedEntry("fake-reviewer", "fake-b", priced),
  ]);
}

function run(
  budgetUsd: number | null,
  options: { priced?: boolean; host?: FakeHostOptions } = {}
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({
    files: [
      { path: "package.json", isDir: false, sizeBytes: 40 },
      { path: "src/app.ts", isDir: false, sizeBytes: 30 },
    ],
    contents: {
      "package.json": '{"scripts":{"test":"node --test"}}',
      "src/app.ts": "export const a = 1;\n",
    },
    gitStatus: "## main",
    verifyResults: [{ overall: "pass" }, { overall: "pass" }],
    ...options.host,
  });
  const taskRequest: TaskRequest = {
    taskId: "task-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userMessage: "src/app.ts 의 상수를 2로 고쳐줘",
    createdAt: new Date().toISOString(),
  };
  const orchestrator = new Orchestrator(
    {
      taskRequest,
      policy: makePolicy({ budgetUsd }),
      availableProviders: ["fake-a", "fake-b"],
    },
    {
      transport: host.asTransport(),
      adapterOptions: { fake: { defaultPatch: VALID_PATCH } },
      registry: pricedRegistry(options.priced ?? true),
    }
  );
  return { orchestrator, host };
}

/**
 * **상한이 한 호출의 최대 비용보다 작으면 호출은 나가지 않는다.**
 *
 * 이 경우가 중요한 이유: 비싼 모델에서는 한 번의 호출 최대치가 $2에 가깝다. 상한을 그보다
 * 낮게 잡으면 아무것도 돌지 않는데, 그때 "예산 부족"만 말하면 사용자는 상한을 조금씩 올리며
 * 같은 실패를 반복한다. 그래서 오류가 **두 숫자를 함께** 낸다.
 */
test("상한이 한 호출의 최대 비용보다 작으면 호출 전에 멈춘다", async () => {
  const { orchestrator, host } = run(MAX_CALL_USD / 2);
  const result = await orchestrator.run();

  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "budget_exceeded");
  assert.ok(result.summary.includes("최대 비용"), result.summary);
  // **호출이 실제로 나가지 않았다.** 예약이 사후 검사였다면 여기에 usage가 남는다.
  assert.equal(host.usage.length, 0, `상한을 넘겼는데 호출이 나갔습니다: ${JSON.stringify(host.usage)}`);
  assert.equal(result.budget?.state, "limit_reached");
  assert.equal(result.budget?.spentUsd, 0);
});

/**
 * **예약은 최대 비용으로 열리고 정산은 실제 비용으로 닫힌다.**
 *
 * 이 구별이 없으면 상한이 실제 지출의 수십 배를 막게 되어, 정상 태스크가 거부된다.
 * 여기서 확인하는 것은 "완료됐다"가 아니라 **확정 지출이 예약 총액보다 훨씬 작다**는 것이다.
 */
test("정산은 예약액이 아니라 실제 비용을 누적한다", async () => {
  const { orchestrator, host } = run(100);
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.equal(host.usage.length, 3, "executor ×2 + reviewer");
  const spent = result.budget?.spentUsd ?? -1;
  // 실제 비용 3회분과 같아야 한다(부동소수 오차 허용).
  assert.ok(Math.abs(spent - ACTUAL_CALL_USD * 3) < 1e-6, `확정 지출: ${spent}`);
  // 예약액으로 정산했다면 이 값이 3 × MAX_CALL_USD였을 것이다 — 그 차이가 이 테스트의 요점이다.
  assert.ok(spent < MAX_CALL_USD, `예약액으로 정산한 것으로 보입니다: ${spent}`);
  assert.equal(result.budget?.state, "ok");
  assert.equal(result.budget?.limitUsd, 100);
  assert.equal(result.budget?.unresolvedUsd, 0);
});

/**
 * **동시에 뜬 두 예약은 서로의 예산을 갉아먹는다.** 두 실행자는 병렬로 호출되므로 둘 다
 * 정산 전에 예약을 연다 — 예약이 즉시 차감되지 않으면 상한을 두 배로 넘길 수 있다.
 *
 * 그리고 그때 **태스크가 죽지 않아야 한다.** 대조는 질문을 만드는 장치이지 진행 조건이
 * 아니므로, 검수자 독립성을 만족시킬 수 없을 때 검수를 드롭하고 표시하는 것과 같은 처리다.
 */
test("예산이 모자라면 대조 표본을 드롭하되 태스크는 계속한다", async () => {
  // 한 호출은 되고 두 호출을 동시에 잡을 수는 없는 상한.
  const { orchestrator, host } = run(MAX_CALL_USD * 1.5);
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  // 실행자 1 + 검수자 1. 대조 표본이 빠졌다.
  assert.equal(host.usage.length, 2, JSON.stringify(host.usage.map((u) => (u as { callId: string }).callId)));

  // **드롭했다는 사실이 조용히 사라지지 않는다.**
  const refused = host.events.filter((e) => e.type === "BUDGET_REFUSED");
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.equal((refused[0]!.payload as { skipped: boolean }).skipped, true);
  // 완료됐어도 예산이 무언가를 막았다는 사실은 남는다 — "상한 안에서 끝났다"와 다른 결말이다.
  assert.equal(result.budget?.state, "limit_reached");
});

/**
 * **상한이 없다는 것은 "상한 안에서 끝났다"와 다르다.** 둘 다 초록색으로 보이면 화면이
 * 거짓 안심을 준다. 그래서 상태를 따로 두고, 지출은 그대로 보고한다.
 */
test("상한이 없으면 강제하지 않지만 지출은 그대로 보고한다", async () => {
  const { orchestrator } = run(null);
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.budget?.state, "not_enforced");
  assert.equal(result.budget?.limitUsd, null);
  assert.ok((result.budget?.spentUsd ?? 0) > 0, "상한이 없다고 지출까지 지우면 안 됩니다");
  assert.equal(result.budget?.unpricedCalls, 0);
});

/**
 * **가격을 모르면 상한을 강제할 수 없다.** 그때 0으로 대체하면 그 순간 상한이 아무것도
 * 막지 못하는데, 사용자에게는 상한이 걸린 것으로 보인다. 그래서 fail closed로 멈춘다.
 */
test("가격을 모르는 모델은 상한이 있으면 거부된다", async () => {
  const { orchestrator, host } = run(100, { priced: false });
  const result = await orchestrator.run();

  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "budget_exceeded");
  assert.ok(result.summary.includes("가격"), result.summary);
  assert.equal(host.usage.length, 0);
  // 무엇을 못 했는지가 숫자로도 남는다.
  assert.ok((result.budget?.unpricedCalls ?? 0) > 0);
});

/** 상한이 없는 채로 도는 것은 **시작 시점에** 드러나야 한다. 결과에만 담으면 진행 중에는 알 수 없다. */
test("상한 유무를 시작 시점 이벤트로 남긴다", async () => {
  const { orchestrator, host } = run(null);
  await orchestrator.run();
  const policy = host.events.find((e) => e.type === "BUDGET_POLICY");
  assert.ok(policy, "BUDGET_POLICY 이벤트가 없습니다");
  assert.equal((policy!.payload as { enforced: boolean }).enforced, false);
});

/** 예약과 정산이 감사 이벤트로 남는다 — 원장이 메모리에만 있으면 사후에 아무것도 설명하지 못한다. */
test("예약과 정산이 task_events에 남는다", async () => {
  const { orchestrator, host } = run(100);
  await orchestrator.run();
  const opened = host.events.filter((e) => e.type === "BUDGET_RESERVATION_OPENED");
  const settled = host.events.filter((e) => e.type === "BUDGET_RESERVATION_SETTLED");
  assert.equal(opened.length, 3);
  assert.equal(settled.length, 3);
  // 예약액과 확정액이 **둘 다** 남아야 한다. 하나만 남기면 상한 제안을 관측에서 유도할 때
  // 최대치와 실제의 간극을 잴 수 없다(metrics.rs TASK_BUDGET_HEADROOM).
  assert.ok((opened[0]!.payload as { reservedUsd: number }).reservedUsd > 0);
  assert.ok((settled[0]!.payload as { actualUsd: number }).actualUsd > 0);
});

/**
 * fake와 real의 구별은 **주소 스킴**에서 온다. providerId 이름 규칙에 기대면 이름이 바뀔 때
 * 조용히 어긋나고, 그 순간 실제 호출의 0 토큰이 정상으로 통과한다.
 */
test("공급자 종류를 주소로 판정한다", () => {
  const builtin = new ModelRegistry();
  for (const entry of builtin.all()) {
    const expected = entry.apiBaseUrl.startsWith("local://") ? "fake" : "real";
    assert.equal(providerKindOf(entry), expected, entry.modelId);
  }
  // 등록된 fake가 실제로 존재해야 이 테스트가 무언가를 검증한다.
  assert.ok(builtin.all().some((e) => providerKindOf(e) === "fake"));
  assert.ok(builtin.all().some((e) => providerKindOf(e) === "real"));
});

/**
 * **타임아웃 하나가 태스크를 "예산 부족"으로 끝내면 안 된다.**
 *
 * 타임아웃은 재시도 대상으로 설계된 정상적인 실패다(원칙 5). 그런데 요청이 나간 뒤의 실패는
 * 과금 여부를 모르므로 예약이 미해결로 남고, 원장을 기본 설정으로 두면 그 시점부터 모든
 * 호출이 막힌다 — 그러면 사용자는 **틀린 이유**로 실패한 태스크를 본다. 실측으로 기존
 * 타임아웃 테스트가 `budget_exceeded`로 깨졌다.
 *
 * 상한은 여전히 지켜진다: 미해결액은 남은 예산에서 계속 빠져 있다.
 */
test("타임아웃이 남긴 미해결 예약은 이후 호출을 막지 않는다", async () => {
  const host = new FakeHost({
    files: [
      { path: "package.json", isDir: false, sizeBytes: 40 },
      { path: "src/app.ts", isDir: false, sizeBytes: 30 },
    ],
    contents: {
      "package.json": '{"scripts":{"test":"node --test"}}',
      "src/app.ts": "export const a = 1;\n",
    },
    gitStatus: "## main",
    verifyResults: [{ overall: "pass" }, { overall: "pass" }],
  });
  const orchestrator = new Orchestrator(
    {
      taskRequest: {
        taskId: "task-1",
        sessionId: "sess-1",
        workspaceId: "ws-1",
        userMessage: "src/app.ts 의 상수를 2로 고쳐줘",
        createdAt: new Date().toISOString(),
      },
      policy: makePolicy({ budgetUsd: 100 }),
      availableProviders: ["fake-a", "fake-b"],
    },
    {
      transport: host.asTransport(),
      // **한 모델의 첫 시도만** 타임아웃시킨다. 재시도는 스크립트를 다 소비하고 기본 응답을
      // 받으므로, 태스크는 계속 진행할 수 있어야 한다.
      adapterOptions: {
        fake: {
          defaultPatch: VALID_PATCH,
          scriptByModel: { "fake-executor": [{ kind: "draft", delayMs: 5_000 }] },
        },
      },
      registry: pricedRegistry(),
      providerTimeoutMs: 50,
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxRetries: 2, transientBaseMs: 1, transientCapMs: 2 },
    }
  );

  const result = await orchestrator.run();

  // 예산 때문에 멈춘 것이 아니다 — 재시도는 그대로 일어났고 태스크는 진행했다.
  assert.notEqual(result.failureReason, "budget_exceeded", result.summary);
  // 그러나 **미해결액은 사라지지 않는다.** 나간 요청은 과금됐을 수 있고, 그 돈을
  // 사용 가능한 예산으로 되돌리면 상한이 그만큼 늘어난다.
  assert.ok((result.budget?.unresolvedUsd ?? 0) > 0, JSON.stringify(result.budget));
});

/**
 * **기본값은 여전히 막는다.** 위 테스트가 제품의 선택(막지 않음)을 고정하므로, 그 선택이
 * 원장의 기본 동작을 바꿔버리지 않았는지를 여기서 함께 고정한다 — 가설 게이트는 미해결
 * 예약을 안고 계속 돌면 안 되고(측정의 유효성), 그 보호가 조용히 사라지면 알 방법이 없다.
 */
test("원장의 기본 동작은 미해결 예약 이후 유료 호출을 막는 것이다", () => {
  const ledger = createBudgetLedger(10, { runId: "r", stage: "s" });
  const first = ledger.reserve({ maxUsd: 1, basis: "테스트" }, "call-1");
  assert.ok(first.ok);
  first.reservation.markUnresolved({ dispatchState: "dispatched_no_response", reason: "응답 없음" });
  assert.equal(ledger.state(), "UNRESOLVED_RESERVATION");

  const second = ledger.reserve({ maxUsd: 1, basis: "테스트" }, "call-2");
  assert.equal(second.ok, false);

  // 옵션을 끄면 막지 않지만, **미해결액은 그대로 빠져 있다.** 막는 것과 빼두는 것은 다른 보호다.
  const lenient = createBudgetLedger(10, { runId: "r", stage: "s", blockOnUnresolved: false });
  const opened = lenient.reserve({ maxUsd: 4, basis: "테스트" }, "call-1");
  assert.ok(opened.ok);
  opened.reservation.markUnresolved({ dispatchState: "dispatched_no_response", reason: "응답 없음" });
  assert.equal(lenient.state(), "OK");
  assert.equal(lenient.unresolvedUsd(), 4);
  assert.equal(lenient.availableUsd(), 6);
});
