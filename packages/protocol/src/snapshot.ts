import type { ISODateTime, ModelId } from "./common.js";

/** docs/design/context-engine.md 4절 — 이 파일이 왜 선택됐는지. */
/**
 * 이 파일이 왜 골렸는가.
 *
 * # `symbol-match`와 `content-match`를 나눠 두는 이유 (context-engine 5·16절, state-machine 51절)
 *
 * `symbol-match`는 **심볼 그래프**가 있을 때의 근거다 — "이 식별자가 여기 정의돼 있다"를
 * Tree-sitter가 안다. 그 그래프는 16절에서 생겼고, 그래서 이 값은 이제 실제로 만들어진다.
 *
 * `content-match`는 **본문 검색**이 찾은 것이다. 정의처럼 보이는 자리를 정규식으로 맞춘 것이라
 * 훨씬 약한 근거이고, 그 약함이 이름에 남아야 한다 — `symbol-match`로 적으면 화면과 감사
 * 기록이 "파서가 확인했다"고 말하게 된다. **심볼 그래프가 생겨도 이 값은 남는다**: 파싱에
 * 실패한 파일과 MVP 범위 밖 언어의 폴백이 여기이기 때문이다(5절).
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
  excludedNotes?: { path: string; reason: string }[];
  createdAt: ISODateTime;
}

// docs/design/context-engine.md 2절 — 세션 스코프로 유지되는 인덱스.
// WorkspaceSnapshot과 달리 태스크 artifact가 아니며 SQLite workspace_index 테이블에 대응한다.
//
// `symbols`/`dependencyEdges`는 16절에서 채워졌다(Tree-sitter, MVP 3개 언어 — 9절).
// 인터페이스를 WorkspaceSnapshot과 분리해 둔 덕분에 그 층을 채우면서 스냅샷 선택 로직의
// **계약은 바뀌지 않았다** — 바뀐 것은 `relevantFiles[].reason`에 어떤 값이 나타나는가뿐이다.
/**
 * 이 파일에 대해 **심볼 인덱싱이 어디까지 갔는가** (context-engine.md 5·6.1절).
 *
 * # 왜 `symbols`가 비어 있다는 사실만으로는 부족한가
 *
 * "이 파일에 심볼이 없다"와 "이 파일을 파싱하지 못했다"는 **다른 사실**이고, 뒤를 앞으로
 * 읽으면 선정이 조용히 좁아진다 — 파싱에 실패한 파일은 `symbol-match`로 영영 걸리지 않는데
 * 화면에는 "심볼이 없는 파일"로 보인다. 6.1절이 정한 규칙("심볼을 잃되 파일이 사라지지는
 * 않는다")을 지키려면 **잃었다는 사실 자체가 값으로 남아야** 한다.
 */
export type SymbolIndexStatus =
  /** 파서가 읽었다. 심볼이 0개여도 그건 "없다"는 사실이다. */
  | "indexed"
  /** 파싱을 시도했고 문법 오류가 있었다 — 심볼을 잃되 파일은 인덱스에 남는다(6.1절). */
  | "parse-failed"
  /** 내용을 받지 못했다(읽기 실패·바이너리). 파싱을 시도조차 못 했다. */
  | "unreadable"
  /** 9절 MVP 언어 범위 밖 — 애초에 파서가 없다. 폴백은 ripgrep(5절). */
  | "unsupported-language"
  /** grammar를 싣지 못했다. **폴백이지 침묵이 아니다** — 이 값이 그 사실을 나른다. */
  | "grammar-unavailable"
  /** 인덱싱 상한에 걸려 시도하지 않았다. 결정적으로 잘린다(파일 트리 순서). */
  | "skipped-budget";

export interface WorkspaceIndexFileEntry {
  path: string;
  language: string | null;
  sizeBytes: number;
  sha256: string;
  /** 심볼 인덱싱 결과 — 위 타입의 주석이 왜 필요한지를 말한다. */
  symbolStatus: SymbolIndexStatus;
}

/**
 * 심볼 인덱스 층이 **실제로 무엇을 했는가** — context-engine.md 5절.
 *
 * 값이 아니라 상태를 남기는 이유: grammar 로딩 실패는 폴백(ripgrep)으로 이어지므로 태스크는
 * 계속 돈다. 그래서 **아무 오류도 나지 않는다.** 그 조용함이 곧 "Tree-sitter가 도는 줄 알았는데
 * 실은 한 번도 안 돌았다"를 만든다 — 그 사실이 인덱스에 실려 이벤트로 나가야 한다.
 */
export interface SymbolIndexReport {
  /**
   * 인덱스 **모양**의 버전. 캐시가 이 값을 갖지 않거나 다르면 없는 것으로 다룬다(2.1절).
   *
   * 심볼이 붙으면서 `WorkspaceIndexFileEntry`에 필드가 늘었는데, 옛 행을 그대로 쓰면
   * `symbolStatus`가 `undefined`인 파일들이 생기고 그건 "모른다"가 아니라 **조용한 거짓**이 된다.
   */
  version: number;
  /** grammar별 로딩 결과. `loaded=false`인 언어의 파일은 전부 `grammar-unavailable`이다. */
  languages: { language: string; loaded: boolean; error?: string }[];
  filesIndexed: number;
  filesParseFailed: number;
  filesSkipped: number;
  filesUnreadable: number;
  symbolCount: number;
  edgeCount: number;
  /** 파싱에 쓴 시간. 인덱스 전체 구축 시간(`WORKSPACE_INDEX_BUILT.buildMs`)의 부분집합이다. */
  durationMs: number;
  /** 파서에 넣은 바이트 총량 — 시간이 저장소 크기 때문인지 파서 때문인지 가른다. */
  bytesParsed: number;
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
  /** 심볼 인덱스 층이 무엇을 했는가 (context-engine.md 5절). */
  symbolIndex: SymbolIndexReport;
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
