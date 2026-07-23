import { pathToFileURL } from "node:url";
import type { TaskRequest, WorkspaceSnapshot } from "@tomverse/protocol";
import { NdjsonTransport } from "./ipc/transport.js";
import { triageTask } from "./triage.js";

// docs/design/process-architecture.md 5절 — 프로토콜 버전. Rust가 ready 이벤트에서
// 이 값을 확인해 버전 스큐를 감지한다.
export const PROTOCOL_VERSION = "0.1.0";

export function createSidecar(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): NdjsonTransport {
  const transport = new NdjsonTransport(input as never, output as never);

  transport.onRequest("task.start", async (params) => {
    const { taskRequest, snapshot } = params as { taskRequest: TaskRequest; snapshot: WorkspaceSnapshot };

    transport.emitEvent(taskRequest.taskId, { type: "PHASE_CHANGED", phase: "SNAPSHOTTING" });
    // Context Engine(WorkspaceIndex 기반 스냅샷 생성)은 아직 구현되지 않았다 —
    // Rust가 넘겨준 snapshot을 그대로 사용한다. docs/design/context-engine.md 참조.

    transport.emitEvent(taskRequest.taskId, { type: "PHASE_CHANGED", phase: "TRIAGE" });
    const complexityTier = triageTask(snapshot, taskRequest.userMessage);
    transport.emitEvent(taskRequest.taskId, { type: "TRIAGE_COMPLETED", complexityTier });

    const nextPhase = complexityTier === "simple" ? "SINGLE_MODEL_FIX" : "DRAFTING";
    transport.emitEvent(taskRequest.taskId, {
      type: "NOT_IMPLEMENTED",
      message: `complexityTier=${complexityTier}로 분류됨. ${nextPhase} 이후 단계(Provider 호출, Tool 실행)는 이 스캐폴딩 버전에 아직 구현되지 않았습니다.`,
    });

    return { taskId: taskRequest.taskId, complexityTier, reachedPhase: "TRIAGE" };
  });

  transport.onRequest("ping", async () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }));

  transport.onRequest("task.cancel", async (params) => {
    const { taskId } = params as { taskId: string };
    transport.emitEvent(taskId, { type: "PHASE_CHANGED", phase: "CANCELLED" });
    return { taskId, cancelled: true };
  });

  transport.emitEvent("", { type: "ready", protocolVersion: PROTOCOL_VERSION });

  return transport;
}

/* c8 ignore start -- entrypoint wiring, exercised via child_process in test/smoke.test.ts, not unit-testable */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createSidecar(process.stdin, process.stdout);
}
/* c8 ignore stop */
