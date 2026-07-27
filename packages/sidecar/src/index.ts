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
  const running = new Map<string, Orchestrator>();

  const fake = options.fake ?? fakeOptionsFromEnv();

  transport.onRequest("ping", async () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }));

  transport.onRequest("task.start", async (params) => {
    const { taskRequest, policy, availableProviders } = params as TaskStartParams;
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
      },
      deps
    );
    running.set(taskRequest.taskId, orchestrator);

    try {
      const result: FinalResult = await orchestrator.run();
      return result;
    } finally {
      running.delete(taskRequest.taskId);
    }
  });

  transport.onRequest("task.cancel", async (params) => {
    const { taskId } = params as { taskId: string };
    const orchestrator = running.get(taskId);
    if (!orchestrator) {
      return { taskId, cancelled: false, reason: "진행 중인 태스크가 아닙니다" };
    }
    orchestrator.cancel();
    return { taskId, cancelled: true };
  });

  transport.onRequest("task.userInput", async (params) => {
    const { taskId, message } = params as TaskUserInputParams;
    const orchestrator = running.get(taskId);
    if (!orchestrator) {
      return { taskId, accepted: false, reason: "진행 중인 태스크가 아닙니다" };
    }
    const accepted = orchestrator.provideUserInput(message);
    return { taskId, accepted, phase: orchestrator.phase };
  });

  transport.onRequest("shutdown", async () => {
    // 진행 중인 in-flight 공급자 호출을 취소하고 응답한다 (process-architecture.md 5절).
    for (const orchestrator of running.values()) orchestrator.cancel();
    return { ok: true };
  });

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
