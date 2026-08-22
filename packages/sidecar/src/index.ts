import { pathToFileURL } from "node:url";
import type { FinalResult, TaskPolicy, TaskStartParams, TaskUserInputParams } from "@tomverse/protocol";
import { DEFAULT_TASK_POLICY } from "@tomverse/protocol";
import { NdjsonTransport } from "./ipc/transport.js";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator/orchestrator.js";
import { estimateCall } from "./orchestrator/budget.js";
import { createAdapter } from "./providers/factory.js";
import { ModelRegistry } from "./routing/registry.js";
import { routerOptionsFromEnv } from "./routing/router.js";
import type { FakeProviderOptions } from "./providers/fake.js";

/**
 * Node sidecar 진입점 — docs/design/process-architecture.md.
 *
 * 이 프로세스가 갖지 않는 것: 파일 시스템 접근, 셸 실행, SQLite 쓰기. 전부 Rust에 요청한다.
 * 갖는 것: 상태 머신, LLM 어댑터, Context Engine 선정 로직.
 *
 * API 키는 Rust가 spawn 시 환경변수로 주입하며 메모리에만 존재한다 — 디스크에 쓰지 않고
 * 로그에도 남기지 않는다.
 */

// process-architecture.md 5절 — Rust가 ready/ping 응답에서 이 값을 확인해 버전 스큐를 감지한다.
// tomverse-core의 `PROTOCOL_VERSION`과 같아야 한다.
export const PROTOCOL_VERSION = "0.2.0";

export interface SidecarOptions {
  /**
   * fake 공급자 스크립트. `TOMVERSE_FAKE_SCRIPT` 환경변수(JSON)로도 줄 수 있어
   * end-to-end 테스트가 별도 진입점 없이 이 프로세스를 그대로 쓴다 —
   * 테스트용 진입점을 따로 만들면 정작 프로덕션 진입점이 테스트되지 않는다.
   */
  fake?: FakeProviderOptions;
}

export function createSidecar(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: SidecarOptions = {}
): NdjsonTransport {
  const transport = new NdjsonTransport(input as never, output as never);

  /**
   * 진행 중인 태스크의 registry.
   *
   * `pendingCancels`가 별도로 필요한 이유: **취소 요청이 task.start보다 먼저 도착할 수 있다.**
   * (Rust가 task.start를 보낸 직후 사용자가 취소를 누르면, IPC 왕복 순서에 따라 cancel이
   * 먼저 처리될 수 있다.) 그때 orchestrator가 아직 없다고 취소를 버리면 태스크가 그대로 실행된다.
   */
  const running = new Map<string, Orchestrator>();
  const pendingCancels = new Set<string>();

  const fake = options.fake ?? fakeOptionsFromEnv();

  // **Node 버전을 함께 보고한다.** 동봉 런타임이 요구 버전보다 낮으면 증상이 "sidecar가
  // 조용히 죽는다"이므로(최신 문법을 파싱하다 죽어 오류가 사용자에게 닿지 않는다),
  // 준비 왕복에서 Rust가 확인하고 이해 가능한 실패로 바꾼다
  // (process-architecture.md 10.4절 착지 기준 ④).
  transport.onRequest("ping", async () => ({
    pong: true,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: process.versions.node,
  }));

  /**
   * 이 자격증명으로 **실제로 쓸 수 있는 모델** 목록 (multi-engine-routing.md 15절).
   *
   * 화면이 역할별 모델을 고르려면 목록이 필요한데, 레지스트리는 Node에 있다.
   *
   * **`available()`을 그대로 쓴다.** 전체 카탈로그를 보내고 화면이 거르게 하면, 화면과
   * 라우터가 서로 다른 규칙으로 거르게 되어 "고를 수 있게 보였는데 시작하면 거부되는" 모델이
   * 생긴다. 가용성은 전역 사실이 아니라 자격증명별 사실이라는 것이 gpt-5 사례의 교훈이다.
   *
   * 단가를 함께 보낸다 — 모델 선택은 대부분 비용에 관한 결정이고, 숫자 없이 고르라고 하면
   * 사용자는 이름으로 고른다.
   */
  /**
   * 자격증명 확인 (multi-engine-routing.md 17절).
   *
   * **공급자마다 한 번**, 그 공급자의 후보 중 하나로 확인한다 — 모델마다 확인하면 호출 수가
   * 모델 수만큼 늘어나는데, 여기서 잡으려는 실패(키가 틀렸다·만료됐다)는 공급자 단위다.
   *
   * 무료 조회 엔드포인트만 쓴다. 유료 확인은 태스크에 속하지 않아 예산 원장에도 전송 기록에도
   * 자리가 없고, **기록되지 않는 지출**을 만들지 않기 위해서다.
   */
  transport.onRequest("providers.probe", async (params) => {
    const { availableProviders } = (params ?? {}) as { availableProviders?: string[] };
    const registry = new ModelRegistry();
    const entries = registry.available(availableProviders ?? [], {
      allowOrgVerified: routerOptionsFromEnv().allowOrgVerified,
    });

    const byProvider = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      if (!byProvider.has(entry.providerId)) byProvider.set(entry.providerId, entry);
    }

    const checks = await Promise.all(
      [...byProvider.values()].map(async (entry) => {
        try {
          const adapter = createAdapter(entry, {
            role: "executor",
            modelId: entry.modelId,
            providerId: entry.providerId,
            reason: "자격증명 확인",
          });
          return await adapter.checkCredential();
        } catch (error) {
          // 어댑터를 만들지도 못한 경우(키 없음 등)도 **결과의 한 종류**다 — 예외로 던지면
          // 공급자 하나 때문에 나머지 확인 결과가 통째로 사라진다.
          return {
            providerId: entry.providerId,
            modelId: entry.modelId,
            status: "auth_failed" as const,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
    return { checks };
  });

  transport.onRequest("models.list", async (params) => {
    const { availableProviders } = (params ?? {}) as { availableProviders?: string[] };
    const registry = new ModelRegistry();
    const entries = registry.available(availableProviders ?? [], {
      allowOrgVerified: routerOptionsFromEnv().allowOrgVerified,
    });
    return {
      models: entries.map((entry) => {
        // **예약이 쓸 바로 그 수를 보낸다.** 화면이 같은 공식을 다시 구현하면 두 벌이 생기고,
        // 그 순간 "예상 비용"과 "실제로 예약되는 금액"이 조용히 갈라진다 — 화면은 통과라고
        // 말하는데 시작하면 거부되는 상태가 그것이다(envelopeIdentity가 두 벌이었던 것과 같은 모양).
        const estimate = estimateCall(entry);
        return {
          modelId: entry.modelId,
          providerId: entry.providerId,
          inputPerMTok: entry.economics.inputPerMTok,
          outputPerMTok: entry.economics.outputPerMTok,
          maxContextTokens: entry.capabilities.maxContextTokens,
          // 가격을 모르면 **키를 넣지 않는다.** 0을 넣으면 화면이 "공짜"로 읽는다.
          ...(estimate ? { maxCallCostUsd: estimate.maxUsd } : {}),
        };
      }),
    };
  });

  transport.onRequest("task.start", async (params) => {
    const { taskRequest, policy, availableProviders, experiment } = params as TaskStartParams;
    if (!taskRequest?.taskId) throw new Error("task.start params에 taskRequest.taskId가 없습니다");

    const deps: OrchestratorDeps = {
      transport,
      routerOptions: routerOptionsFromEnv(),
      adapterOptions: { fake },
    };

    const orchestrator = new Orchestrator(
      {
        taskRequest,
        policy: mergePolicy(policy),
        availableProviders: availableProviders ?? [],
        // 실험 제어는 Rust가 준 것을 그대로 넘긴다 — sidecar가 만들어내지 않는다.
        experiment,
      },
      deps
    );
    running.set(taskRequest.taskId, orchestrator);
    // 시작 전에 도착한 취소를 소비한다.
    if (pendingCancels.delete(taskRequest.taskId)) {
      orchestrator.cancel();
    }

    try {
      const result: FinalResult = await orchestrator.run();
      return result;
    } finally {
      // registry cleanup — 터미널에 도달했으므로 반드시 제거한다.
      // 남겨두면 장시간 실행에서 orchestrator가 무한히 쌓이고, 같은 taskId 재사용 시
      // 죽은 orchestrator에 취소가 전달된다.
      running.delete(taskRequest.taskId);
      pendingCancels.delete(taskRequest.taskId);
    }
  });

  transport.onRequest("task.cancel", async (params) => {
    const { taskId } = params as { taskId: string };
    const orchestrator = running.get(taskId);
    if (!orchestrator) {
      // 아직 시작하지 않았을 수 있다 — 기록해 두었다가 시작 시 즉시 취소한다.
      // "진행 중이 아니므로 실패"로 응답하면 그 태스크가 그대로 실행되어 버린다.
      pendingCancels.add(taskId);
      return { taskId, cancelled: true, deferred: true, reason: "아직 시작되지 않은 태스크 — 시작 시 즉시 취소됩니다" };
    }
    const accepted = orchestrator.cancel();
    return {
      taskId,
      cancelled: accepted,
      phase: orchestrator.phase,
      // 이미 터미널이면 accepted=false다. 오류가 아니라 "바꿀 것이 없었다"는 뜻이다.
      reason: accepted ? undefined : "이미 종료된 태스크입니다",
    };
  });

  transport.onRequest("task.userInput", async (params) => {
    const { taskId, message, decisions } = params as TaskUserInputParams;
    const orchestrator = running.get(taskId);
    if (!orchestrator) {
      return { taskId, accepted: false, reason: "진행 중인 태스크가 아닙니다" };
    }
    const accepted = orchestrator.provideUserInput(message, decisions);
    return { taskId, accepted, phase: orchestrator.phase };
  });

  transport.onRequest("shutdown", async () => {
    // 진행 중인 in-flight 공급자 호출을 취소하고 응답한다 (process-architecture.md 5절).
    for (const orchestrator of running.values()) orchestrator.cancel();
    return { ok: true, cancelled: running.size };
  });

  /** 테스트/진단용 — registry가 실제로 정리되는지 확인한다. */
  transport.onRequest("debug.activeTasks", async () => ({
    active: [...running.keys()],
    pendingCancels: [...pendingCancels],
  }));

  transport.emitEvent("", { type: "ready", protocolVersion: PROTOCOL_VERSION, startedAt: new Date().toISOString() });

  return transport;
}

/** UI/Rust가 일부 필드만 보내도 동작하도록 기본값과 병합한다. */
function mergePolicy(partial: Partial<TaskPolicy> | undefined): TaskPolicy {
  return {
    ...DEFAULT_TASK_POLICY,
    ...(partial ?? {}),
    limits: { ...DEFAULT_TASK_POLICY.limits, ...(partial?.limits ?? {}) },
  };
}

function fakeOptionsFromEnv(): FakeProviderOptions | undefined {
  const raw = process.env.TOMVERSE_FAKE_SCRIPT;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as FakeProviderOptions;
  } catch (error) {
    // 조용히 무시하면 테스트가 "왜 기본 응답이 오지" 하고 헤맨다.
    process.stderr.write(`[sidecar] TOMVERSE_FAKE_SCRIPT를 파싱할 수 없습니다: ${String(error)}\n`);
    return undefined;
  }
}

/* c8 ignore start -- entrypoint wiring, exercised via child_process in tests */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createSidecar(process.stdin, process.stdout);
}
/* c8 ignore stop */
