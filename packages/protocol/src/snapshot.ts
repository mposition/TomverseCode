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

/**
 * 사용자가 고른 스킬의 프롬프트 프리셋 (state-machine 26절).
 *
 * **스냅샷에 두는 이유가 있다.** 이건 워크스페이스에서 모은 것이 아니라 사용자 설정이므로
 * 여기 있는 것이 어색해 보인다. 그런데 전송 투명성이 "이 내용이 각 공급자 모두에게 갔다"고
 * 말할 수 있는 근거는 **모든 프롬프트 빌더가 같은 스냅샷을 싣는다**는 것 하나다(7.1절).
 * 스킬 지시문을 스냅샷 밖에 두면 빌더마다 실을지 말지가 갈리고, 그 순간 그 근거가 사라진다.
 * 그래서 **나가는 것은 스냅샷을 통해 나간다**로 규칙을 지킨다.
 */
export interface SnapshotSkill {
  name: string;
  /** 프롬프트에 실리는 지시문 **원문**. 공급자로 그대로 나간다. */
  instructions: string;
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
  /** 이 태스크에 적용된 스킬. 없으면 스킬을 쓰지 않은 것이다. */
  skill?: SnapshotSkill;
  /**
   * 같은 세션의 **앞선 태스크에서 사용자가 정한 것** (state-machine 27절).
   *
   * 스킬과 같은 이유로 스냅샷에 있다 — 프롬프트에 실리는 것은 스냅샷을 통해 나가야 전송
   * 집계가 "각 공급자 모두에게 갔다"고 말할 수 있다(7.1절).
   *
   * **이 태스크의 `doneCriteria`가 아니다.** 섞으면 기준 평가가 사용자가 이번에 말한 적 없는
   * 요구로 태스크를 판정한다(17.9절).
   */
  sessionMemory?: { text: string; decisionCount: number; truncated: boolean };
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
