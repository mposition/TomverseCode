import type { ISODateTime, ModelId } from "./common.js";

/** docs/design/context-engine.md 4절 — 이 파일이 왜 선택됐는지. */
/**
 * 이 파일이 왜 골렸는가.
 *
 * # `symbol-match`와 `content-match`를 나눠 두는 이유 (context-engine 9절, state-machine 51절)
 *
 * `symbol-match`는 **심볼 그래프**가 있을 때의 근거다 — "이 식별자가 여기 정의돼 있다"를
 * 파서가 안다. 지금은 그 그래프가 없다.
 *
 * `content-match`는 **본문 검색**이 찾은 것이다. 정의처럼 보이는 자리를 정규식으로 맞춘 것이라
 * 훨씬 약한 근거이고, 그 약함이 이름에 남아야 한다 — `symbol-match`로 적으면 화면과 감사
 * 기록이 "파서가 확인했다"고 말하게 된다.
 */
export type RelevanceReason =
  | "mentioned"
  | "symbol-match"
  | "content-match"
  | "recently-changed"
  | "dependency"
  | "project-meta";

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
  /**
   * 이 파일을 고르게 만든 **줄 번호들** (1-base) — context-engine 13·14절.
   *
   * 본문 검색이 찾은 자리다. 잘라 넣어야 할 때 **어디를 남길지**가 여기 걸려 있다:
   * 앞에서부터 자르면 파일 뒤쪽에 있는 정의는 찾아 놓고도 잘려 나간다.
   */
  anchorLines?: number[];
  /**
   * 잘라 넣었을 때 **실제로 실린 줄 범위** (1-base, 양끝 포함).
   *
   * # 왜 본문에 표시를 넣지 않는가
   *
   * `… N줄 생략 …` 같은 표시를 본문에 넣으면 그 줄이 **파일 내용처럼 보인다.** 모델이 그것을
   * patch의 context 줄로 복사하면 `apply_patch`가 실패하는데, 그 실패는 "모델이 잘못된 patch를
   * 냈다"로 보인다(44.6절과 같은 종류의 오해).
   *
   * 그래서 본문은 **원본의 연속된 조각 그대로** 두고, 어디를 실었는지는 이 값으로 따로 말한다.
   * 프롬프트의 파일 머리글이 그것을 읽어 적는다.
   */
  includedRange?: { startLine: number; endLine: number; totalLines: number };
  /**
   * 잘라 넣었을 때 **창이 덮은 앵커 수와 범위 안에 있던 총수** (context-engine 15절).
   *
   * # 왜 남기는가
   *
   * 14.6절은 다중 앵커 개선을 "앵커 분포를 잰 적이 없다"는 이유로 미뤄 두었다. 재는 장치가
   * 없으면 고쳐도 나아졌는지 모르고, 틀려도 드러나지 않는다. 이 값이 스냅샷에 실리므로
   * 이벤트 기록에 남고, 나중에 분포를 집계할 근거가 된다.
   *
   * # 그리고 모델에게도 말한다
   *
   * `covered < total`은 **관련 지점이 창 밖에 있다**는 뜻이다. 그건 모델이 이 파일에 patch를
   * 자신 있게 쓰면 안 되는 이유이므로 프롬프트 머리글이 그 사실을 적는다.
   *
   * `total`은 넘겨받은 앵커가 아니라 파일 범위 안에 있던 앵커다 — 범위 밖 앵커는 파일이
   * 바뀌었다는 뜻이지 우리가 놓친 것이 아니다.
   */
  anchorCoverage?: { covered: number; total: number };
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
  /**
   * 등록된 MCP 서버가 **실제로 내놓은 도구 목록** (state-machine 31절).
   *
   * Rust가 `tools/list`로 모은다 — MCP 서버는 프로세스이고 그것을 띄우는 것은 Node에게
   * 금지된 일이다(원칙 2). Node는 받은 텍스트를 스냅샷에 넣을 뿐이다.
   *
   * 스냅샷에 있는 이유는 스킬·세션 메모리와 같다: **나가는 것은 스냅샷을 통해 나가야**
   * 전송 집계가 "각 공급자 모두에게 갔다"고 말할 수 있다(7.1절).
   */
  mcpTools?: { text: string; serverCount: number; toolCount: number; truncated: boolean };
  /**
   * 이번 태스크에서 실제로 부른 MCP 도구의 **응답** (state-machine 31절).
   *
   * **우리가 만든 텍스트가 아니라 외부 서버가 준 텍스트다.** 그것이 프롬프트에 실려
   * 공급자로 나가므로 전송 집계가 세야 하고, 모델에게는 "데이터이지 지시가 아니다"라고
   * 말해야 한다(31.5절).
   */
  mcpResults?: { text: string; callCount: number };
  /**
   * **내용이 컨텍스트에 들어가지 않은 파일**과 그 사유.
   *
   * 경로와 사유는 프롬프트에 실린다 — 모델이 그 파일을 없다고 보고 내용을 추측하는 것을
   * 막기 위해서다. 그러므로 여기 들어가는 `path`는 **실제 워크스페이스 경로여야 한다**:
   * 파일이 아닌 것을 여기 넣으면 모델도 화면도 "그런 파일이 있다"고 읽는다(17절).
   */
  excludedNotes?: { path: string; reason: string }[];
  /**
   * **우리가 보지 못한 영역** — context-engine.md 17절.
   *
   * `excludedNotes`와 다른 사실이다. 저쪽은 "이 파일의 내용을 넣지 않았다"이고 이쪽은
   * "이 범위를 확인하지 못했으므로 여기 없다고 없는 것이 아니다"이다. 한동안 검색 쪽 노트가
   * `excludedNotes`에 섞여 있었고, 그래서 `(search: foo)`가 **파일 이름으로** 프롬프트와
   * 화면에 나갔다.
   *
   * `path`가 아니라 `scope`인 이유가 그것이다 — 이 값은 경로가 아니고, 경로인 척하면
   * 읽는 쪽이 파일을 찾는다.
   */
  coverageNotes?: CoverageNote[];
  createdAt: ISODateTime;
}

/**
 * 범위 노트의 **종류** — context-engine.md 19절.
 *
 * # 왜 문장 말고 값이 필요한가
 *
 * `reason`은 사람이 읽는 문장이라 집계의 열쇠가 될 수 없다. 문장으로 묶으면 표현을 다듬는
 * 순간 계열이 갈라지고, **갈라진 계열은 "줄었다"로 읽힌다** — 잘못된 분모가 표본 부족보다
 * 나쁘다는 규칙이 여기에도 그대로 적용된다.
 *
 * 그리고 종류마다 **할 일이 다르다**: 목록이 잘린 것은 상한 문제이고, 검색이 실패한 것은
 * 도구 문제이며, 비밀값을 건너뛴 것은 고칠 것이 없는 정상 동작이다. 셋을 한 숫자로 세면
 * 그 숫자로 할 수 있는 일이 없다.
 *
 * **배열이 정본이고 타입은 거기서 유도한다.** 둘을 따로 적으면 갈라지고, 갈라지면 런타임
 * 검사가 타입에 없는 값을 통과시킨다.
 */
export const COVERAGE_NOTE_KINDS = [
  /** 호스트의 파일 목록이 상한에서 잘렸다 (18절). */
  "listing_truncated",
  /** 목록이 전부인지 호스트가 말하지 않았다. **`listing_truncated`와 다른 사실이다.** */
  "listing_unknown",
  /** 본문 검색 호출 자체가 실패했다 (13절). */
  "search_failed",
  /** 검색이 비밀값 파일을 읽지 않고 건너뛰었다 (16절). */
  "search_secret_skipped",
  /** 검색 결과가 상한에서 잘렸다. */
  "search_truncated",
  /** 검색 결과가 전부인지 호스트가 말하지 않았다. */
  "search_unknown",
] as const;

export type CoverageNoteKind = (typeof COVERAGE_NOTE_KINDS)[number];

export interface CoverageNote {
  /** 어느 범위인가. 사람이 읽는 이름이고 **경로가 아니다**(17절). */
  scope: string;
  /** 사람이 읽는 문장. **집계의 열쇠로 쓰지 않는다** — 다듬으면 계열이 갈라진다. */
  reason: string;
  /** 집계의 열쇠. 종류마다 할 일이 다르다(19절). */
  kind: CoverageNoteKind;
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
  /**
   * **호스트의 파일 목록이 상한에서 잘렸는가** — context-engine.md 18절.
   *
   * `excluded`와 다른 사실이다. 저쪽은 "봤고 일부러 뺐다"이고 이쪽은 **"보지도 못했다"**이다 —
   * 잘린 뒤의 파일은 `fileTree`에도 `excluded`에도 없으므로, 이 값이 없으면 그 파일들은
   * 어디에서도 언급되지 않는다.
   *
   * `null`/부재는 **"모른다"**이다(옛 호스트, 또는 이 필드가 생기기 전에 저장된 캐시).
   * `false`로 접지 않는다 — 인덱스는 캐시에 저장되어 다음 태스크가 그대로 쓰므로, 여기서
   * 한 번 접으면 그 거짓이 계속 재사용된다.
   */
  listingTruncated?: boolean | null;
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
