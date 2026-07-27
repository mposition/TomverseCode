import type { ISODateTime, ModelId } from "./common.js";

/** docs/design/context-engine.md 4절 — 이 파일이 왜 선택됐는지. */
export type RelevanceReason = "mentioned" | "symbol-match" | "recently-changed" | "dependency" | "project-meta";

export interface RelevantFile {
  path: string;
  reason: RelevanceReason;
  /** 선택 근거의 사람이 읽는 설명 — 감사/UI 표시용(작업 지침 4.5절 "파일별 선택 이유 기록") */
  reasonDetail: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
  /** truncated일 때 실제로 포함된 바이트 수 */
  includedBytes?: number;
}

/**
 * 프로젝트에서 실행할 수 있는 검증 명령. 셸 문자열이 아니라 argv로 보관한다 —
 * Verification Runner가 이걸 그대로 run_command에 넘기므로 여기서 문자열을 쓰면
 * 어딘가에서 셸 파싱이 되살아난다(CLAUDE.md 원칙 6).
 */
export interface DetectedCommand {
  program: string;
  args: string[];
  /** workspace root 기준 상대경로 */
  cwd: string;
  /** 어떻게 이 명령을 알아냈는지 (예: "package.json scripts.test") */
  source: string;
}

export interface ProjectMeta {
  languages: string[];
  buildCommand?: DetectedCommand;
  testCommand?: DetectedCommand;
  lintCommand?: DetectedCommand;
  typecheckCommand?: DetectedCommand;
  agentsMdPresent: boolean;
  agentsMdContent?: string;
  /** 어떤 파일에서 프로젝트 규칙을 읽었는지 (CLAUDE.md / AGENTS.md / README.md) */
  agentsMdSources?: string[];
}

export interface WorkspaceSnapshot {
  snapshotId: string;
  workspaceId: string;
  gitHead: string;
  gitBranch: string;
  gitDirty: boolean;
  gitDiffSummary?: string;
  relevantFiles: RelevantFile[];
  projectMeta: ProjectMeta;
  /**
   * docs/design/multi-engine-routing.md 7절 — provider 유니온 대신 modelId.
   * 파일 선택 결과는 모든 모델에 동일하고(context-engine.md 1절), 예산에 따른
   * truncation만 모델별로 달라진다.
   */
  tokenBudget: { modelId: ModelId; maxTokens: number }[];
  /** 제외된 파일 중 사용자에게 알려야 하는 것 (너무 큼, secret 패턴 등) */
  excludedNotes?: { path: string; reason: string }[];
  createdAt: ISODateTime;
}

// docs/design/context-engine.md 2절 — 세션 스코프로 유지되는 인덱스.
// WorkspaceSnapshot과 달리 태스크 artifact가 아니며 SQLite workspace_index 테이블에 대응한다.
//
// M0에서는 symbols/dependencyEdges가 비어 있다 (Tree-sitter 미도입 — context-engine.md 9절).
// 인터페이스를 WorkspaceSnapshot과 분리해 둔 이유가 이것이다: 나중에 심볼 그래프를 채워도
// 스냅샷 선택 로직의 계약은 바뀌지 않는다.
export interface WorkspaceIndexFileEntry {
  path: string;
  language: string | null;
  sizeBytes: number;
  sha256: string;
}

export interface WorkspaceIndex {
  workspaceId: string;
  gitHeadAtIndex: string;
  fileTree: WorkspaceIndexFileEntry[];
  symbols: SymbolEntry[];
  dependencyEdges: DependencyEdge[];
  projectMeta: ProjectMeta;
  /** 하드 필터로 인덱스 진입 자체가 막힌 파일 (context-engine.md 7절) */
  excluded: { path: string; reason: string }[];
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
