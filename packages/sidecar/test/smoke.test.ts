import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import type { IpcMessage, TaskRequest, WorkspaceSnapshot } from "@tomverse/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ENTRY = path.join(__dirname, "..", "src", "index.js");

function makeSnapshot(relevantFileCount: number, gitDirty: boolean): WorkspaceSnapshot {
  return {
    snapshotId: "snap-1",
    workspaceId: "ws-1",
    gitHead: "abc123",
    gitBranch: "main",
    gitDirty,
    gitDiffSummary: gitDirty ? "M src/other.ts" : undefined,
    relevantFiles: Array.from({ length: relevantFileCount }, (_, i) => ({
      path: `src/file${i}.ts`,
      reason: "mentioned" as const,
      content: "// stub",
      truncated: false,
    })),
    projectMeta: { languages: ["typescript"], agentsMdPresent: false },
    tokenBudget: [],
    createdAt: new Date().toISOString(),
  };
}

function makeTaskRequest(taskId: string, userMessage: string): TaskRequest {
  return {
    taskId,
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userMessage,
    createdAt: new Date().toISOString(),
  };
}

async function runTaskStart(
  taskRequest: TaskRequest,
  snapshot: WorkspaceSnapshot
): Promise<{ events: IpcMessage[]; response: IpcMessage }> {
  const child = spawn("node", [SIDECAR_ENTRY], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout });

  const events: IpcMessage[] = [];
  let resolveResponse!: (msg: IpcMessage) => void;
  const responsePromise = new Promise<IpcMessage>((resolve) => {
    resolveResponse = resolve;
  });

  let sawReady = false;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as IpcMessage;
    if (msg.kind === "event") {
      events.push(msg);
      if ((msg.event as { type?: string }).type === "ready" && !sawReady) {
        sawReady = true;
        child.stdin.write(
          JSON.stringify({
            kind: "request",
            id: "1",
            method: "task.start",
            params: { taskRequest, snapshot },
          }) + "\n"
        );
      }
    } else if (msg.kind === "response" && msg.id === "1") {
      resolveResponse(msg);
    }
  });

  const response = await responsePromise;
  child.kill();
  return { events, response };
}

test("simple task (few files, no dirty git, no risk keyword) triages to simple", async () => {
  const { events, response } = await runTaskStart(
    makeTaskRequest("task-a", "로그인 버튼 오타 수정해줘"),
    makeSnapshot(1, false)
  );

  assert.equal(response.kind, "response");
  assert.equal((response as { ok: boolean }).ok, true);
  const result = (response as { result: { complexityTier: string } }).result;
  assert.equal(result.complexityTier, "simple");

  const triageEvent = events.find((e) => (e as { event: { type?: string } }).event.type === "TRIAGE_COMPLETED");
  assert.ok(triageEvent, "expected a TRIAGE_COMPLETED event");
});

test("risky task (keyword match) triages to standard even with 1 file", async () => {
  const { response } = await runTaskStart(
    makeTaskRequest("task-b", "결제 처리 로직을 리팩터링 해줘"),
    makeSnapshot(1, false)
  );
  const result = (response as { result: { complexityTier: string } }).result;
  assert.equal(result.complexityTier, "standard");
});

test("multi-file task triages to standard", async () => {
  const { response } = await runTaskStart(makeTaskRequest("task-c", "여러 파일에 걸친 버그 수정"), makeSnapshot(3, false));
  const result = (response as { result: { complexityTier: string } }).result;
  assert.equal(result.complexityTier, "standard");
});

test("dirty git state triages to standard", async () => {
  const { response } = await runTaskStart(makeTaskRequest("task-d", "간단한 오타 수정"), makeSnapshot(1, true));
  const result = (response as { result: { complexityTier: string } }).result;
  assert.equal(result.complexityTier, "standard");
});
