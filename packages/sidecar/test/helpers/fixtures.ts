import type { RelevantFile, TaskPolicy, WorkspaceSnapshot } from "@tomverse/protocol";
import { DEFAULT_TASK_POLICY } from "@tomverse/protocol";

export function makeRelevantFile(overrides: Partial<RelevantFile> = {}): RelevantFile {
  return {
    path: "src/app.ts",
    reason: "mentioned",
    reasonDetail: "테스트 픽스처",
    content: "export const a = 1;\n",
    truncated: false,
    sizeBytes: 20,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    snapshotId: "snap-1",
    workspaceId: "ws-1",
    gitHead: "main@abc",
    gitBranch: "main",
    gitDirty: false,
    relevantFiles: [makeRelevantFile()],
    projectMeta: { languages: ["typescript"], agentsMdPresent: false },
    tokenBudget: [{ modelId: "fake-executor", maxTokens: 60_000 }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makePolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return {
    ...DEFAULT_TASK_POLICY,
    ...overrides,
    limits: { ...DEFAULT_TASK_POLICY.limits, ...(overrides.limits ?? {}) },
  };
}
