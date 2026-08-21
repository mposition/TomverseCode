import { pathToFileURL } from "node:url";
import type { FinalResult, TaskPolicy, TaskStartParams, TaskUserInputParams } from "@tomverse/protocol";
import { DEFAULT_TASK_POLICY } from "@tomverse/protocol";
import { NdjsonTransport } from "./ipc/transport.js";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator/orchestrator.js";
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

  transport.onRequest("ping", async () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }));

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
