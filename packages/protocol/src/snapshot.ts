import type { ISODateTime } from "./common.js";

export interface WorkspaceSnapshot {
  snapshotId: string;
  workspaceId: string;
  gitHead: string;
  gitBranch: string;
  gitDirty: boolean;
  gitDiffSummary?: string;
  relevantFiles: {
    path: string;
    reason: "mentioned" | "symbol-match" | "recently-changed" | "dependency";
    content: string;
    truncated: boolean;
  }[];
  projectMeta: {
    languages: string[];
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    agentsMdPresent: boolean;
  };
  tokenBudget: { provider: "openai" | "anthropic"; maxTokens: number }[];
  createdAt: ISODateTime;
}

// docs/design/context-engine.md 2절 — 세션 스코프로 유지되는 인덱스.
// WorkspaceSnapshot과 달리 태스크 artifact가 아니며 SQLite workspace_index 테이블에 대응한다.
export interface WorkspaceIndex {
  workspaceId: string;
  gitHeadAtIndex: string;
  fileTree: { path: string; language: string | null; sizeBytes: number; sha256: string }[];
  symbols: SymbolEntry[];
  dependencyEdges: DependencyEdge[];
  projectMeta: {
    languages: string[];
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    agentsMdPresent: boolean;
    agentsMdContent?: string;
  };
  builtAt: ISODateTime;
  lastIncrementalUpdateAt: ISODateTime;
}

export interface SymbolEntry {
  id: string;
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "const" | "export";
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}

export interface DependencyEdge {
  fromFile: string;
  toFile: string;
  kind: "import" | "require" | "reference";
}
