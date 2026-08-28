import type {
  CoverageNote,
  DependencyEdge,
  DetectedCommand,
  ModelId,
  ProjectMeta,
  RelevanceReason,
  RelevantFile,
  SymbolEntry,
  SymbolIndexReport,
  WorkspaceIndex,
  WorkspaceIndexFileEntry,
  WorkspaceSnapshot,
} from "@tomverse/protocol";
import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "../budget/ledger.js";
import type { ToolBridge } from "../tools/bridge.js";
import { classifyFile, languageOf } from "./exclude.js";
import { packageFiles, type TokenBudget } from "./budget.js";
import { dependenciesWithinHops, symbolMatchFiles } from "./graph.js";
import {
  indexSymbols,
  mergeSymbolIndex,
  recountReport,
  SYMBOL_INDEX_VERSION,
  type IndexTarget,
} from "./symbolIndex.js";
import type { GrammarSet } from "./treeSitter.js";

/**
 * Context Engine — docs/design/context-engine.md.
 *
 * 2계층 구조를 지킨다:
 *  - `WorkspaceIndex`: **세션 스코프**. 파일 트리 + 프로젝트 메타. 비싼 작업을 여기서 1회.
 *  - `WorkspaceSnapshot`: **태스크 스코프**. 인덱스에서 관련 파일을 고르고 예산에 맞춰 패키징.
 *
 * **심볼 그래프가 생겼다**(22절). `symbols`/`dependencyEdges`를 Tree-sitter가 채우므로
 * `symbol-match`(정의가 여기 있다)와 `dependency`(1~2홉 import 이웃) 선정이 실제로 동작한다.
 * 두 타입을 분리해 둔 덕분에 그 층을 채우면서 스냅샷 생성 쪽 **계약은 바뀌지 않았다.**
 *
 * **본문 검색은 남는다**(51절, 13절). 종전에는 선정이 파일 **이름**만 봤고, 그래서
 * `resolveBudget`을 고쳐 달라는 요청에서 그 함수가 `ledger.ts`에 있으면 우리는 그 파일을
 * 영원히 고르지 못했다. 심볼이 생겨도 `content-match`를 지우지 않는 이유는 5절이 정한
 * 그대로다: **파싱에 실패한 파일과 MVP 범위 밖 언어에는 폴백이 필요하다.** 그리고 두 층은
 * 서로 앵커를 보탠다(15.2절 — 근거는 먼저 것을 지키고 앵커는 합친다).
 *
 * **모든 파일 접근이 `ToolBridge`(= Rust Tool Runtime)를 지난다.** 이 모듈에 `node:fs`
 * import가 없는 것은 실수가 아니라 신뢰 경계 원칙이다.
 */

/**
 * 저장된 캐시가 인덱스의 모양인가.
 *
 * **밖에서 온 값으로 다룬다.** 앱을 업데이트해 인덱스 모양이 바뀌면 옛 행이 그대로 남아 있고,
 * 그걸 그대로 쓰면 `fileTree.find`가 `undefined`에서 터지거나 조용히 빈 목록이 된다.
 * 캐시는 잃어도 되는 데이터이므로, 모양이 다르면 **없는 것으로 다루고 다시 만든다.**
 */
function isWorkspaceIndex(value: unknown): value is WorkspaceIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceIndex>;
  return (
    typeof candidate.workspaceId === "string" &&
    Array.isArray(candidate.fileTree) &&
    typeof candidate.projectMeta === "object" &&
    candidate.projectMeta !== null &&
    Array.isArray(candidate.symbols) &&
    Array.isArray(candidate.dependencyEdges) &&
    // **버전을 본다.** 심볼 층이 붙으면서 파일 항목에 `symbolStatus`가 늘었는데, 옛 행에는
    // 그 필드가 없다. 그대로 쓰면 모든 파일이 "상태를 모르는 파일"이 되고, 그건 화면에서
    // "심볼이 없는 파일"과 구별되지 않는다 — 조용한 거짓이므로 없는 것으로 다룬다.
    typeof candidate.symbolIndex === "object" &&
    candidate.symbolIndex !== null &&
    candidate.symbolIndex.version === SYMBOL_INDEX_VERSION
  );
}

/** 프로젝트 규칙 파일 — 우선순위 순서대로 찾아 항상 스냅샷에 포함한다 (4절). */
const PROJECT_RULE_FILES = ["CLAUDE.md", "AGENTS.md", ".cursorrules", "CONTRIBUTING.md", "README.md"];

/** 선정된 후보 하나. `anchorLines`는 잘라 넣을 때 **어디를 남길지**를 정한다(14절). */
interface Candidate {
  path: string;
  reason: RelevanceReason;
  reasonDetail: string;
  anchorLines?: number[];
}

/** 본문 검색을 돌릴 키워드 수 상한 (원칙 5). 검색은 저장소 크기에 비례한다. */
const MAX_SEARCHED_KEYWORDS = 4;
/** 키워드 하나가 넣을 수 있는 후보 수 상한. 흔한 이름 하나가 예산을 다 먹는 것을 막는다. */
/**
 * 키워드 하나가 후보로 올릴 수 있는 파일 수의 상한.
 *
 * **내보내는 이유는 fake와의 관계를 테스트가 확인해야 하기 때문이다**(21절). fake의 검색
 * 상한이 이 값보다 크지 않으면 이 상한에 걸리는 경로가 fake로는 **도달 불가능**해지고,
 * 그러면 그 경로의 코드를 지워도 아무 검사도 실패하지 않는다. 실제로 둘 다 3이라 그랬다.
 */
export const MAX_MATCHES_PER_KEYWORD = 3;

/**
 * "정의처럼 보이는 자리"의 앞부분.
 *
 * 언어마다 다르지만 **한 정규식으로 묶는다** — 파일 확장자별로 갈래를 만들면 그 목록이
 * 또 하나의 손으로 지키는 규칙이 되고, 틀려도 조용히 후보가 줄 뿐이라 드러나지 않는다.
 * 여기서 틀리는 대가는 "정의를 못 찾아 넓은 검색으로 내려간다"이며, 그건 실패가 아니다.
 */
const DEFINITION_PREFIX =
  "\\b(function|class|const|let|var|def|fn|struct|enum|interface|type|impl|trait|async)\\s+";

/** 키워드를 정규식에 넣기 전에 escape한다. 하지 않으면 `a.b` 같은 토큰이 다른 것을 찾는다. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MANIFEST_FILES = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle"];

/** pytest 선언을 찾는 파일들 — 증분에서 프로젝트 메타를 다시 읽을지 판정할 때 함께 본다. */
const PYTEST_FILES = ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"];

/**
 * 심볼 매치가 키워드 하나로 넣을 수 있는 파일 수 상한 (원칙 5).
 *
 * 흔한 이름(`new`, `run`, `id`)은 저장소 전체에 정의가 흩어져 있다. 상한이 없으면 그 하나가
 * `maxRelevantFiles`를 다 먹고, 정작 사용자가 지목한 파일이 밀려난다.
 */
const MAX_SYMBOL_MATCH_FILES_PER_KEYWORD = 3;

/** 심볼 매치를 시도할 키워드 수 상한. 본문 검색과 같은 이유의 상한이다. */
const MAX_SYMBOL_MATCH_KEYWORDS = 6;

/** 의존성 순회 홉 수 — 4절이 "1~2홉 이내"라고 적었다. */
const DEPENDENCY_MAX_HOPS = 2;

/** 의존성 순회가 넣을 수 있는 파일 수 상한. 배럴 파일 하나가 컨텍스트를 다 먹지 않게 한다. */
const MAX_DEPENDENCY_FILES = 4;

/** 도구 실행 뒤 스냅샷을 다시 읽은 결과. **무엇이 달라졌는지도 값으로 남긴다.** */
export interface SnapshotRefresh {
  snapshot: WorkspaceSnapshot;
  /** 내용이 실제로 달라진 파일 */
  changed: string[];
  /** 변경이 만들어 새로 들어온 파일 */
  added: string[];
  /** 이번 변경이 삭제해 빠진 파일 */
  removed: string[];
  /**
   * 읽지 못해 **옛 내용을 그대로 둔** 파일.
   *
   * 비어 있지 않으면 스냅샷의 그 부분은 낡았을 수 있다. 빈 컨텍스트보다는 낫지만
   * 조용히 넘기면 안 되는 사실이라 값으로 남긴다.
   */
  unreadable: string[];
}

export interface ContextEngineOptions {
  /** 인덱싱할 최대 파일 수. 아주 큰 저장소에서 첫 태스크가 무한정 느려지지 않게 한다. */
  maxIndexedFiles?: number;
  /** 관련 파일 후보 최대 개수 */
  maxRelevantFiles?: number;
  /**
   * 증분으로 다시 파싱할 파일 수 상한 — 6절 표 3행("diff가 너무 크면 전체 재구축").
   *
   * 넘으면 전체 재구축으로 간다. 증분의 이득은 "안 바뀐 것을 다시 안 한다"인데, 대부분이
   * 바뀌었으면 그 이득이 없고 대신 옛 인덱스를 들고 다니는 복잡도만 남는다.
   */
  maxIncrementalFiles?: number;
  /**
   * grammar 집합 주입 — **테스트용**이다.
   *
   * grammar를 못 실은 상황에서 선정이 어떻게 되는지는 검사할 수 있어야 하는데, 실제 적재를
   * 실패시키는 방법은 패키지를 지우는 것뿐이다. 기본값은 프로세스 캐시(`loadGrammars`).
   */
  grammars?: GrammarSet;
}

export class ContextEngine {
  private index: WorkspaceIndex | null = null;
  /**
   * 지금 들고 있는 인덱스가 유효한 **워크스페이스 지문**.
   *
   * `gitHeadAtIndex`가 아닌 이유는 `ensureIndex` 주석에 있다. `null`이면 "지문을 낼 수 없어
   * 재사용 판정을 할 수 없다"이지 "아무 상태에나 맞는다"가 아니다.
   */
  private indexKey: string | null = null;
  private readonly maxIndexedFiles: number;
  private readonly maxRelevantFiles: number;
  private readonly maxIncrementalFiles: number;
  private readonly grammars: GrammarSet | undefined;

  constructor(options: ContextEngineOptions = {}) {
    this.maxIndexedFiles = options.maxIndexedFiles ?? 20_000;
    this.maxRelevantFiles = options.maxRelevantFiles ?? 12;
    this.maxIncrementalFiles = options.maxIncrementalFiles ?? 200;
    this.grammars = options.grammars;
  }

  /**
   * 세션 스코프 인덱스 구축/재사용.
   *
   * # 캐시는 프로세스보다 오래 산다
   *
   * 워크스페이스를 전환하면 sidecar가 종료되므로 프로세스 안 캐시는 함께 사라진다
   * (process-architecture.md 11.3절 — sidecar를 살려두지 않는 이유는 자격증명 사본이다).
   * 그래서 **프로세스가 아니라 결과를 저장한다**: Rust가 SQLite에 워크스페이스당 한 행으로
   * 들고 있고, 지문이 맞을 때만 돌려준다.
   *
   * # 재사용 판정 키를 지문으로 바꿨다
   *
   * 종전 키는 `readGitHead`가 만드는 `브랜치@hash(git status --porcelain=v1 --branch)`였다.
   * (문서 3절이 "git HEAD가 같으면 재사용"이라고 적은 것은 **코드보다 약하게 적힌 것**이다 —
   * 실제로는 워킹 트리 변화도 대부분 잡고 있었다.) 다만 그 키에는 좁은 사각이 둘 있다.
   *
   * - `--porcelain`의 기본 untracked 모드는 **새 디렉터리를 한 줄로 접는다**(`?? newdir/`).
   *   그 안에 파일을 더 만들어도 status 출력이 그대로이므로 키가 바뀌지 않고, 인덱스는 그
   *   파일을 모른다. 선정 로직이 전부 `index.fileTree`를 보므로 **이름으로 지목해도
   *   컨텍스트에 들어가지 않는다.**
   * - 추적되는 파일을 계속 고쳐도 status에는 `M path` 한 줄뿐이라 키가 더 바뀌지 않는다.
   *   인덱스의 `sizeBytes`가 그만큼 낡는다.
   *
   * Rust의 지문은 `HEAD` + `status --porcelain -uall` + `diff HEAD`이므로 둘 다 닫는다.
   * 그리고 무엇보다 **같은 질문("이 워크스페이스가 그때와 같은가")에 답이 두 개 있을 이유가
   * 없다** — 재현 전제 판정이 쓰는 값과 같은 것을 쓴다(state-machine 21절).
   *
   * 지문을 낼 수 없는 워크스페이스(git 저장소가 아님)에서는 **재사용도 저장도 하지 않는다** —
   * 같은지 판정할 방법이 없는데 재사용하면 "모른다"를 "같다"로 읽는 것이다.
   */
  async ensureIndex(bridge: ToolBridge, workspaceId: string): Promise<WorkspaceIndex> {
    const cached = await bridge.loadCachedIndex().catch(() => ({ fingerprint: null, index: null }));
    const key = cached.fingerprint;

    // 1) 이 프로세스가 이미 들고 있는 것. **지문이 없으면 재사용하지 않는다** —
    //    `null === null`이 참이라는 이유로 통과시키면 판정 없이 재사용하게 된다.
    if (key !== null && this.index && this.indexKey === key && this.index.workspaceId === workspaceId) {
      return this.index;
    }

    // 2) 저장된 것. Rust가 지문을 확인한 뒤에만 준다.
    if (key !== null && isWorkspaceIndex(cached.index) && cached.index.workspaceId === workspaceId) {
      this.index = cached.index;
      this.indexKey = key;
      return this.index;
    }

    const startedAt = Date.now();
    const listing = await bridge.listFiles(".");
    // porcelain을 한 번만 읽는다 — 증분 판정(어떤 파일이 더러운가)과 인덱스 지문이 같은
    // 출력을 쓰므로, 두 번 부르면 그 사이에 바뀐 상태로 서로 다른 답을 낼 수 있다.
    const porcelain = (await bridge.gitStatus().catch(() => ({ stdout: "", exitCode: null }))).stdout;
    const scanned: { path: string; language: string | null; sizeBytes: number }[] = [];
    const excluded: { path: string; reason: string }[] = [];

    for (const entry of listing.entries) {
      if (entry.isDir) continue;
      if (scanned.length >= this.maxIndexedFiles) {
        excluded.push({ path: entry.path, reason: `인덱싱 상한(${this.maxIndexedFiles}개) 초과` });
        continue;
      }
      const verdict = classifyFile(entry.path, entry.sizeBytes);
      if (verdict.excluded) {
        excluded.push({ path: entry.path, reason: verdict.reason ?? "제외됨" });
        continue;
      }
      scanned.push({ path: entry.path, language: languageOf(entry.path), sizeBytes: entry.sizeBytes });
    }

    // **이 프로세스가 들고 있던 인덱스가 있으면 증분으로 간다** — 6절 표 2·3행.
    // 심볼 층이 붙기 전에는 전체 재구축이 파일 트리 워크 한 번이라 쌌지만, 이제 파일을
    // 전부 읽고 파싱하는 비용이 붙는다. 지문이 바뀔 때마다 그 값을 다시 내는 것은
    // "증분 갱신이 필요하다"는 6절의 전제 그대로다.
    const previous = this.index && this.index.workspaceId === workspaceId ? this.index : null;
    const changed = previous ? changedPaths(previous, scanned, porcelain) : null;
    const incremental =
      previous !== null && changed !== null && changed.size <= this.maxIncrementalFiles ? { previous, changed } : null;

    const fileTree: WorkspaceIndexFileEntry[] = [];
    const targets: IndexTarget[] = [];
    const previousStatus = new Map(incremental?.previous.fileTree.map((f) => [f.path, f]) ?? []);
    for (const entry of scanned) {
      const carried = incremental && !incremental.changed.has(entry.path) ? previousStatus.get(entry.path) : undefined;
      if (carried) {
        fileTree.push({ ...carried, sizeBytes: entry.sizeBytes });
        continue;
      }
      targets.push({ path: entry.path, language: entry.language });
      fileTree.push({
        path: entry.path,
        language: entry.language,
        sizeBytes: entry.sizeBytes,
        // sha256은 Rust가 파일을 쓸 때만 계산한다. 인덱싱 단계에서 전 파일 해시를 구하려면
        // 전부 읽어야 하고 그건 3절이 피하려는 비용이다. 빈 문자열이 아니라 명시적으로 비워둔다.
        sha256: "",
        // 아래 `indexSymbols`가 덮어쓴다. 여기 값이 그대로 남으면 파서가 이 파일을 보지
        // 못했다는 뜻이므로 "읽지 못함"이 맞다.
        symbolStatus: "unreadable",
      });
    }

    const livePaths = new Set(fileTree.map((f) => f.path));
    const outcome = await indexSymbols({
      targets,
      knownPaths: livePaths,
      read: (path) => bridge.tryReadFile(path),
      grammars: this.grammars,
    });
    for (const entry of fileTree) {
      const status = outcome.statuses.get(entry.path);
      if (status !== undefined) entry.symbolStatus = status;
    }

    const graph = incremental
      ? mergeSymbolIndex(
          {
            symbols: incremental.previous.symbols,
            edges: incremental.previous.dependencyEdges,
            report: incremental.previous.symbolIndex,
          },
          incremental.changed,
          outcome,
          livePaths
        )
      : { symbols: outcome.symbols, edges: outcome.edges, report: outcome.report };

    // 프로젝트 메타는 매니페스트/규칙 파일이 바뀌었을 때만 다시 읽는다 — CLAUDE.md 전문을
    // 매번 다시 읽는 것이 증분에서 가장 큰 읽기다.
    const projectMeta =
      incremental && ![...PROJECT_RULE_FILES, ...MANIFEST_FILES, ...PYTEST_FILES].some((f) => incremental.changed.has(f))
        ? incremental.previous.projectMeta
        : await this.detectProjectMeta(bridge, fileTree);

    const now = new Date().toISOString();
    const gitHead = gitHeadFingerprint(porcelain);
    const built: WorkspaceIndex = {
      workspaceId,
      gitHeadAtIndex: gitHead,
      fileTree,
      symbols: graph.symbols,
      dependencyEdges: graph.edges,
      projectMeta,
      excluded,
      symbolIndex: recountReport(graph.report, fileTree),
      // **잘린 목록으로 만든 인덱스라는 사실이 인덱스에 남아야 한다**(18절). 스냅샷을 만들
      // 때 다시 물을 수 없기 때문이다 — 인덱스는 캐시에서 올 수 있고, 그때는 `list_files`를
      // 부르지도 않는다.
      listingTruncated: listing.truncated,
      builtAt: incremental ? incremental.previous.builtAt : now,
      lastIncrementalUpdateAt: now,
    };
    this.index = built;
    this.indexKey = key;

    // 지문이 없으면 저장하지 않는다 — 어떤 상태의 인덱스인지 말할 수 없는 것을 저장하면
    // 다음에 그걸 꺼내 쓸 때 무엇과 비교해야 할지 알 수 없다.
    //
    // **저장 실패는 태스크를 막지 않는다.** 이건 캐시이고, 없으면 다시 만들면 된다 —
    // 캐시를 못 썼다고 작업을 세우는 것은 꼬리가 몸통을 흔드는 것이다.
    if (key !== null) {
      await bridge.saveCachedIndex(key, built, Date.now() - startedAt).catch(() => undefined);
    }
    return built;
  }

  /**
   * **실재가 확인된 경로 전부.** 스냅샷의 `relevantFiles`가 아니라 인덱스가 본 목록이다.
   *
   * 기준↔테스트 연결(state-machine 17.9.1절)이 "이 경로가 실재하는가"를 물을 때 스냅샷을 보면
   * 답이 틀린다 — 스냅샷은 토큰 예산이 고른 **부분집합**이라, 예산에 밀린 테스트가 "없는 파일"이
   * 된다. 인덱스의 하드 필터 제외 목록도 함께 준다: 제외했다는 것은 **봤다는 뜻**이므로
   * 존재의 증거다.
   *
   * 인덱스가 없으면 빈 배열이다. 그 빈 배열은 "워크스페이스가 비었다"가 아니라 "아직 모른다"이며,
   * 읽는 쪽이 그것을 "없다"로 말하지 않는 것이 이 값의 사용 조건이다.
   */
  knownFilePaths(): string[] {
    if (!this.index) return [];
    return [...this.index.fileTree.map((f) => f.path), ...this.index.excluded.map((e) => e.path)];
  }

  /**
   * 태스크 스코프 스냅샷. 인덱스에서 고르고 읽어 패키징만 한다 (2절 — 태스크당 비용이 낮은 이유).
   */
  async createSnapshot(
    bridge: ToolBridge,
    input: {
      workspaceId: string;
      userMessage: string;
      tokenBudgets: TokenBudget[];
    }
  ): Promise<WorkspaceSnapshot> {
    const index = await this.ensureIndex(bridge, input.workspaceId);
    const gitStatus = await bridge.gitStatus().catch(() => ({ stdout: "", exitCode: null }));
    const diffSummary = await bridge.gitDiff({ statOnly: true }).catch(() => "");

    // 명시 지목됐지만 제외 규칙에 걸린 파일은 사용자에게 알린다 (7절 마지막 문단).
    const excludedNotes = this.notesForMentionedButExcluded(index, input.userMessage);
    // **파일에 대한 노트와 따로 모은다**(17절). 검색이 못 본 범위는 파일이 아니고, 같은
    // 목록에 넣으면 `(search: foo)`가 파일 이름으로 프롬프트와 화면에 나간다.
    const coverageNotes: CoverageNote[] = [];
    // **인덱스가 전부를 봤는지 말한다**(18절). 이 노트가 없으면 잘린 목록으로 만든 인덱스와
    // 온전한 인덱스가 프롬프트에서도 화면에서도 **똑같아 보인다** — 그리고 인덱스는
    // 캐시되므로 그 침묵이 다음 태스크들로 이어진다.
    const listingNote = listingCoverageNote(index.listingTruncated);
    if (listingNote) coverageNotes.push(listingNote);
    // **grammar를 못 실었다는 사실은 침묵하면 안 된다.** 폴백(ripgrep)이 있으므로 태스크는
    // 정상으로 보이는데, 실제로는 `symbol-match`/`dependency`가 통째로 빠진 채 돈다.
    // 스냅샷에 남겨야 화면과 프롬프트가 그 사실을 말할 수 있다(22절).
    //
    // **커버리지 노트다 — 파일 노트가 아니다**(17절). 아래 `grammarNotes` 머리말 참조.
    coverageNotes.push(...grammarNotes(index));

    const candidates = await this.selectRelevantFiles(
      bridge,
      index,
      input.userMessage,
      excludedNotes,
      coverageNotes
    );

    // 기본값은 **비용 추정과 같은 상수**를 읽는다. 여기에 숫자를 직접 적으면 예산 원장의
    // 보수적 추정이 실제 요청과 조용히 어긋난다 — 예약이 실제 청구를 감당하지 못하는 상태다.
    const primaryBudget = input.tokenBudgets[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
    const relevantFiles: RelevantFile[] = [];

    for (const candidate of candidates) {
      const file = await bridge.readFile(candidate.path).catch(() => null);
      if (!file || file.binary || file.content === null) {
        excludedNotes.push({ path: candidate.path, reason: "읽을 수 없거나 바이너리로 판정됨" });
        continue;
      }
      relevantFiles.push({
        path: candidate.path,
        reason: candidate.reason,
        reasonDetail: candidate.reasonDetail,
        ...(candidate.anchorLines && candidate.anchorLines.length > 0
          ? { anchorLines: candidate.anchorLines }
          : {}),
        content: file.content,
        truncated: file.truncated,
        sizeBytes: file.sizeBytes,
        includedBytes: file.content.length,
      });
    }

    // 예산에 맞춰 뒤쪽 우선순위부터 잘라낸다 (8절).
    const packaged = packageFiles(relevantFiles, primaryBudget);
    for (const dropped of packaged.dropped) {
      excludedNotes.push({ path: dropped.path, reason: dropped.reason });
    }

    const folded = foldCoverageNotes(coverageNotes);

    return {
      snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: input.workspaceId,
      gitHead: index.gitHeadAtIndex,
      gitBranch: parseBranch(gitStatus.stdout),
      gitDirty: hasUncommittedChanges(gitStatus.stdout),
      gitDiffSummary: diffSummary.trim() === "" ? undefined : diffSummary.trim(),
      relevantFiles: packaged.files,
      projectMeta: index.projectMeta,
      tokenBudget: input.tokenBudgets.map((b) => ({ modelId: b.modelId as ModelId, maxTokens: b.maxTokens })),
      excludedNotes: excludedNotes.length > 0 ? excludedNotes : undefined,
      // **한 자리에서 접는다**(21절). 노트를 만드는 곳은 여럿이고 앞으로 더 늘어난다 —
      // 만드는 쪽마다 "이미 있나"를 묻게 하면 새 생산자가 그 물음을 빠뜨린다.
      coverageNotes: folded.length > 0 ? folded : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 도구가 파일을 바꾼 뒤의 스냅샷 — context-engine.md 6.1절.
   *
   * # 왜 필요한가
   *
   * 스냅샷은 `SNAPSHOTTING`에서 **한 번** 만들어지고, 그 뒤 `apply_patch`가 파일을 고친다.
   * 그런데 FIX_LOOP는 같은 스냅샷을 다시 실어 보내면서 프롬프트로 이렇게 말한다:
   * *"The patch must apply to the CURRENT state of the files shown above (your previous
   * change is already in them)."* — **거짓이었다.** 보여준 내용은 패치 이전이다.
   * 모델은 자기가 고친 적 없는 코드를 보며 "이미 고쳐진 코드"라고 들었고, 그래서 만든 패치는
   * 문맥이 어긋나 적용에 실패하거나(→ fixLoopRounds 소진) **직전 변경을 되돌린다.**
   *
   * # 다시 고르지 않고 다시 읽는다
   *
   * **선정과 내용은 다른 것이다.** 어떤 파일이 관련 있는가는 태스크 수준의 판단이고 라운드가
   * 바뀐다고 달라질 이유가 없다 — 오히려 라운드마다 달라지면 두 모델의 대조도, 라운드 간
   * 비교도 근거를 잃는다(1절). 내용은 **지금 디스크에 있는 것**이라는 사실이고, 낡으면 안 된다.
   * 그래서 전체 재선정이 아니라 고른 파일의 내용만 다시 읽는다.
   *
   * # 변경이 건드린 파일은 앞으로 온다
   *
   * 예산이 모자라면 `packageFiles`가 뒤에서부터 자른다. FIX_LOOP에서 답이 있는 곳은 변경이
   * 건드린 파일이므로, 그게 잘리면 그 라운드는 처음부터 가망이 없다. 이건 임의의 재정렬이
   * 아니라 **새 정보(무엇이 바뀌었는가)에 따른 것**이며, 프로젝트 규칙 파일은 자리를 지킨다
   * (4절 "우선순위와 별개로 항상 포함").
   *
   * # 제외 규칙은 그대로 걸린다
   *
   * 변경이 건드렸다는 이유로 `.env`가 컨텍스트에 들어오지 않는다. 7절의 하드 필터는 진입
   * 자체를 막는 것이고, 여기는 새로운 진입 지점이다 — 새 문을 내면서 자물쇠를 빼놓지 않는다.
   *
   * # 깨진 중간 상태를 감추지 않는다
   *
   * 다시 읽은 내용이 문법적으로 깨져 있을 수 있다. 그래도 그대로 싣는다 — 스냅샷은 "이 코드가
   * 올바르다"는 주장이 아니라 **"지금 디스크에 이것이 있다"는 사실**이다. 깨진 상태를 감추고
   * 옛 내용을 보여주는 것이 바로 지금 고치는 결함이다.
   */
  async refreshSnapshot(
    bridge: ToolBridge,
    snapshot: WorkspaceSnapshot,
    mutatedPaths: readonly string[]
  ): Promise<SnapshotRefresh> {
    const mutated = new Set(mutatedPaths);
    const previous = new Map(snapshot.relevantFiles.map((f) => [f.path, f.content]));
    const excludedNotes = [...(snapshot.excludedNotes ?? [])];

    const kept: RelevantFile[] = [];
    const removed: string[] = [];
    const unreadable: string[] = [];
    const changed: string[] = [];
    /**
     * 이번에 다시 읽은 내용. **인덱스 증분 갱신이 이걸 그대로 쓴다**(6절 표 1행) —
     * 같은 파일을 인덱스 때문에 한 번 더 읽으면 IPC 왕복이 배가 되고, 무엇보다 두 번 읽는
     * 사이에 파일이 바뀌면 **스냅샷과 인덱스가 서로 다른 내용을 근거로 삼는다.**
     * `null`은 "이번 변경이 지웠다"이다.
     */
    const reread = new Map<string, string | null>();

    for (const file of snapshot.relevantFiles) {
      const read = await bridge.readFile(file.path).catch(() => null);
      if (!read || read.binary || read.content === null) {
        // **"사라졌다"와 "모른다"를 가른다.** 이번 변경이 건드린 파일이 안 읽히면 그건 삭제다 —
        // 없는 파일의 내용을 계속 보여주면 모델이 그 파일을 고치려 든다. 반대로 우리가 건드린
        // 적 없는 파일이 갑자기 안 읽히는 것은 삭제의 증거가 아니라 **읽기 경로가 깨졌다는
        // 신호**에 가깝고, 그때 전부 빼면 모델은 빈 컨텍스트를 받는다. 그 경우는 옛 내용을
        // 남기되 낡았을 수 있다는 사실을 값으로 남긴다.
        if (mutated.has(file.path)) {
          removed.push(file.path);
          reread.set(file.path, null);
          excludedNotes.push({ path: file.path, reason: "이번 변경이 삭제함" });
        } else {
          unreadable.push(file.path);
          kept.push(file);
        }
        continue;
      }
      if (read.content !== file.content) changed.push(file.path);
      if (mutated.has(file.path)) reread.set(file.path, read.content);
      kept.push({
        ...file,
        content: read.content,
        truncated: read.truncated,
        sizeBytes: read.sizeBytes,
        includedBytes: read.content.length,
      });
    }

    // 변경이 만든 파일 — 스냅샷에 없던 것만.
    const added: string[] = [];
    for (const path of mutated) {
      if (previous.has(path) || removed.includes(path)) continue;
      // **읽기 전에 경로로 먼저 판정한다.** 크기는 읽어야 알지만 secret 패턴은 이름으로
      // 알 수 있고, 읽고 나서 버리면 그 내용은 이미 이 프로세스 안에 들어와 있다 —
      // 7절이 "진입 자체를 막는다"고 쓴 이유가 그것이다.
      const byPath = classifyFile(path, 0);
      if (byPath.excluded) {
        excludedNotes.push({ path, reason: byPath.reason ?? "제외됨" });
        continue;
      }
      const read = await bridge.readFile(path).catch(() => null);
      if (!read || read.binary || read.content === null) {
        // 이번 변경이 건드린 파일이 안 읽히면 **삭제다**(위 규칙과 같다). 스냅샷에는 없던
        // 파일이라 뺄 것이 없지만 **인덱스에는 있을 수 있고**, 남겨두면 지워진 파일의 심볼이
        // 남는다 — 6.1절이 금지한 상태다.
        reread.set(path, null);
        continue;
      }
      // 크기 규칙은 읽은 뒤에야 판정할 수 있다.
      const bySize = classifyFile(path, read.sizeBytes);
      if (bySize.excluded) {
        excludedNotes.push({ path, reason: bySize.reason ?? "제외됨" });
        continue;
      }
      added.push(path);
      reread.set(path, read.content);
      kept.push({
        path,
        reason: "recently-changed",
        reasonDetail: "이번 태스크의 변경이 만든 파일",
        content: read.content,
        truncated: read.truncated,
        sizeBytes: read.sizeBytes,
        includedBytes: read.content.length,
      });
    }

    const ordered = [
      ...kept.filter((f) => f.reason === "project-meta"),
      ...kept.filter((f) => f.reason !== "project-meta" && mutated.has(f.path)),
      ...kept.filter((f) => f.reason !== "project-meta" && !mutated.has(f.path)),
    ];

    const budget = snapshot.tokenBudget[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
    const packaged = packageFiles(ordered, budget);
    for (const dropped of packaged.dropped) excludedNotes.push({ path: dropped.path, reason: dropped.reason });

    // **인덱스도 지금의 사실로 바꾼다** — 6절 표 1행("ToolResult가 확정되는 즉시 그 파일만
    // 재파싱"). 여기서 하는 이유는 두 가지다. 첫째, 이 경로는 **단일 비행**이다
    // (`Orchestrator.snapshotForPrompt`가 진행 중인 다시 읽기를 하나의 promise로 합친다) —
    // 인덱스 갱신을 모델 호출마다 게으르게 두면 `Promise.all`로 나가는 초안 둘이 다른
    // 인덱스를 본다(6.1절이 기록한 사고와 같은 자리다). 둘째, 방금 읽은 내용이 손에 있다.
    await this.applyMutationsToIndex(reread);

    // git 상태도 지금의 사실로 바꾼다 — 패치가 적용됐으므로 dirty 여부와 diff 요약이 달라진다.
    const gitStatus = await bridge.gitStatus().catch(() => ({ stdout: "", exitCode: null }));
    const diffSummary = await bridge.gitDiff({ statOnly: true }).catch(() => "");

    // 라운드마다 같은 사유가 다시 붙으면 목록이 길이만 늘어난다 — 그 목록은 프롬프트에도
    // 화면에도 그대로 나가므로 경로당 하나만 남긴다(먼저 붙은 사유를 지킨다).
    const byPathNote = new Map<string, { path: string; reason: string }>();
    for (const note of excludedNotes) if (!byPathNote.has(note.path)) byPathNote.set(note.path, note);
    const notes = [...byPathNote.values()];

    return {
      // **새 스냅샷은 새 id를 갖는다.** 전송 기록은 마지막 `SNAPSHOT_CREATED`를 읽으므로
      // (transmission.rs), id를 물려주면 "지금 무엇이 나가 있는가"에 옛 답이 남는다.
      snapshot: {
        ...snapshot,
        snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        gitBranch: parseBranch(gitStatus.stdout),
        gitDirty: hasUncommittedChanges(gitStatus.stdout),
        gitDiffSummary: diffSummary.trim() === "" ? undefined : diffSummary.trim(),
        relevantFiles: packaged.files,
        excludedNotes: notes.length > 0 ? notes : undefined,
        createdAt: new Date().toISOString(),
      },
      changed,
      added,
      removed,
      unreadable,
    };
  }

  /**
   * 도구가 바꾼 파일만 다시 파싱해 인덱스를 갱신한다 — 6절 표 1행.
   *
   * # 왜 커밋을 기다리지 않는가
   *
   * 6절 표가 이 신호를 "가장 신뢰도 높은 신호"라고 적었다. `apply_patch`가 성공했다는 것은
   * 그 파일이 지금 이렇게 생겼다는 **확정된 사실**이고, git 상태를 다시 재서 유도할 필요가
   * 없다. 그리고 FIX_LOOP는 커밋 전에 돌므로, 커밋을 기다리면 다음 라운드의 선정이 언제나
   * 한 라운드 낡은 인덱스를 본다.
   *
   * # 파싱 실패는 심볼만 잃는다
   *
   * 6.1절의 규칙이 여기서 실제로 쓰인다. 고치는 중의 파일은 문법이 깨져 있는 것이 정상이고,
   * 그때 **낡은 심볼을 남기면 모델이 지금은 없는 함수를 "본다".** 그래서 그 파일의 심볼은
   * 지우되 파일 자체는 인덱스에 남는다 — `symbolStatus`가 `parse-failed`로 그 사실을 나른다.
   *
   * # 인덱스가 없으면 아무 일도 하지 않는다
   *
   * 갱신할 대상이 없다는 뜻이고, 다음 `ensureIndex`가 전부 만든다.
   */
  private async applyMutationsToIndex(reread: ReadonlyMap<string, string | null>): Promise<void> {
    const index = this.index;
    if (!index || reread.size === 0) return;

    const deleted = new Set([...reread].filter(([, content]) => content === null).map(([path]) => path));
    const updated = new Map([...reread].filter((e): e is [string, string] => e[1] !== null));

    const fileTree = index.fileTree.filter((entry) => !deleted.has(entry.path));
    const known = new Set(fileTree.map((f) => f.path));
    for (const [path, content] of updated) {
      // **제외 규칙은 그대로 걸린다.** 변경이 만들었다는 이유로 `.env`가 인덱스에 들어오지
      // 않는다 — `refreshSnapshot`이 스냅샷에 대해 이미 지키는 것과 같은 규칙이다.
      if (classifyFile(path, content.length).excluded) continue;
      if (known.has(path)) continue;
      known.add(path);
      fileTree.push({
        path,
        language: languageOf(path),
        sizeBytes: content.length,
        sha256: "",
        symbolStatus: "unreadable",
      });
    }

    const targets: IndexTarget[] = [];
    for (const entry of fileTree) {
      const content = updated.get(entry.path);
      if (content === undefined) continue;
      entry.sizeBytes = content.length;
      targets.push({ path: entry.path, language: entry.language });
    }

    const outcome = await indexSymbols({
      targets,
      knownPaths: known,
      // 방금 읽은 내용을 쓴다. 여기서 다시 읽으면 스냅샷과 인덱스가 다른 시점을 본다.
      read: async (path) => updated.get(path) ?? null,
      grammars: this.grammars,
    });
    for (const entry of fileTree) {
      const status = outcome.statuses.get(entry.path);
      if (status !== undefined) entry.symbolStatus = status;
    }

    const merged = mergeSymbolIndex(
      { symbols: index.symbols, edges: index.dependencyEdges, report: index.symbolIndex },
      new Set([...updated.keys(), ...deleted]),
      outcome,
      known
    );

    this.index = {
      ...index,
      fileTree,
      symbols: merged.symbols,
      dependencyEdges: merged.edges,
      symbolIndex: recountReport(merged.report, fileTree),
      lastIncrementalUpdateAt: new Date().toISOString(),
    };
    // **캐시 키는 건드리지 않는다.** 파일이 바뀌었으므로 Rust의 지문은 이미 달라졌고,
    // 여기서 키를 옛 값 그대로 두면 다음 `ensureIndex`가 "지문이 다르다"를 보고 증분으로
    // 들어온다 — 그게 맞는 동작이다. 새 지문을 우리가 지어내면 안 된다.
  }

  /**
   * 관련 파일 선정 — 4절 표의 우선순위 순서(mentioned > recently-changed > dependency).
   * `symbol-match`는 심볼 인덱스가 없어 아직 동작하지 않으므로 아예 생성하지 않는다
   * (빈 결과를 만들어 "구현했다"고 보이게 하지 않는다).
   */
  private async selectRelevantFiles(
    bridge: ToolBridge,
    index: WorkspaceIndex,
    userMessage: string,
    notes: { path: string; reason: string }[],
    coverage: CoverageNote[]
  ): Promise<Candidate[]> {
    const selected = new Map<string, Candidate>();

    /**
     * 후보를 더한다. **먼저 들어온 근거를 이긴다** — 우선순위 정렬이 그 근거를 읽기 때문이다.
     *
     * # 그러나 앵커는 합친다 (context-engine 15절)
     *
     * 종전에는 이미 있는 경로면 호출을 통째로 버렸고, 그래서 앵커도 함께 버려졌다. 그 손해가
     * 가장 큰 경우가 **가장 흔한 경우**였다: 사용자가 이름을 댄 파일(2·3단계, 앵커 없음)을
     * 본문 검색이 다시 찾으면(5단계, 앵커 있음) 앵커가 버려져 **앞에서부터 잘렸다.** 즉
     * 사용자가 지목했고 정의도 거기 있는 파일 — 가장 중요한 파일 — 이 14절 이전으로 돌아갔다.
     *
     * 그리고 키워드가 여럿일 때 같은 파일의 두 번째 키워드 매치도 같은 이유로 사라졌다.
     * 앵커를 합치지 않으면 15절의 "가장 많이 덮는 창"은 덮을 것이 하나뿐이라 아무 일도 하지
     * 않는다 — **문을 만들어 놓고 걸어 들어가는 길을 막는 것**이다.
     */
    const add = (path: string, reason: RelevanceReason, reasonDetail: string, anchorLines?: number[]) => {
      const existing = selected.get(path);
      if (existing) {
        if (anchorLines && anchorLines.length > 0) {
          existing.anchorLines = [...new Set([...(existing.anchorLines ?? []), ...anchorLines])].sort((a, b) => a - b);
        }
        return;
      }
      if (selected.size < this.maxRelevantFiles) {
        selected.set(path, { path, reason, reasonDetail, anchorLines });
      }
    };

    // 1) 프로젝트 규칙/매니페스트는 우선순위와 별개로 항상 포함한다 (4절 마지막 문단).
    for (const path of [...PROJECT_RULE_FILES, ...MANIFEST_FILES]) {
      const entry = index.fileTree.find((f) => f.path === path);
      if (entry) add(path, "project-meta", `프로젝트 규칙/매니페스트 — 항상 포함 (${path})`);
    }

    // 2) mentioned: 메시지에서 경로나 파일명을 직접 지목한 경우
    const mentions = extractMentions(userMessage);
    for (const entry of index.fileTree) {
      const base = entry.path.split("/").pop() ?? entry.path;
      const hit = mentions.find((m) => entry.path === m || entry.path.endsWith(`/${m}`) || base === m);
      if (hit) add(entry.path, "mentioned", `요청 메시지가 ${JSON.stringify(hit)}를 직접 지목함`);
    }

    // 3) 키워드 기반: 메시지의 식별자 후보가 파일명에 들어있는 경우.
    //    심볼 테이블이 없으므로 파일명 매칭이 우리가 할 수 있는 최선이며, 그 사실을 reasonDetail에
    //    적어 사용자가 선정 근거의 강도를 판단할 수 있게 한다.
    const keywords = extractKeywords(userMessage);
    for (const keyword of keywords) {
      for (const entry of index.fileTree) {
        const base = (entry.path.split("/").pop() ?? "").toLowerCase();
        if (base.includes(keyword.toLowerCase())) {
          add(entry.path, "mentioned", `파일명이 요청의 키워드 ${JSON.stringify(keyword)}를 포함함`);
        }
      }
    }

    // 4) **심볼 테이블을 본다** — 4절 `symbol-match`, 22절.
    //
    //    여기까지는 파일 **이름**만 봤다. 심볼 인덱스는 "이 식별자의 정의가 여기 있다"를
    //    파서가 아는 근거이고, 그래서 다음 단계(정규식 본문 검색)보다 강하다 — 정규식은
    //    정의와 문자열 리터럴을 구별하지 못한다(13.6절).
    //
    //    이미 들어온 파일(사용자가 이름을 댄 파일)에 대해서는 근거를 덮지 않고 **앵커만
    //    보탠다**(15.2절). 그게 이 층이 그 파일에 주는 실제 이득이다: 지목된 600줄 파일에서
    //    정의가 561번째 줄에 있으면, 앵커가 없을 때는 앞에서부터 잘려 그 정의를 버렸다.
    this.addSymbolMatches(index, keywords, add);

    // 5) **본문을 본다** — state-machine 51절.
    //
    //    여기까지는 파일 **이름**만 봤다. 그래서 `resolveBudget`을 고쳐 달라는 요청에서 그
    //    함수가 `ledger.ts`에 있으면 우리는 그 파일을 영원히 고르지 못하고, 모델은 엉뚱한
    //    컨텍스트로 초안을 쓴다. 그 실패는 "모델이 잘못했다"로 보인다.
    //
    //    `search_text` 도구는 처음부터 있었고 Rust가 구현하고 있었는데 **선정이 한 번도 부르지
    //    않았다.** 문은 있고 길이 없었다.
    await this.addContentMatches(bridge, index, keywords, add, coverage);

    // 6) **의존성을 1~2홉 따라간다** — 4절 `dependency`, 22절.
    //
    //    지금까지 고른 파일이 import하는 것들이다. 4절이 적은 대로 "타입 정의, 유틸 등
    //    컴파일에 필요한 주변 맥락"이며, 직접 매치가 없으므로 우선순위는 가장 뒤다.
    addDependencyNeighbours(index, [...selected.values()], add);

    // 7) 소스로 보이는 파일이 하나도 안 잡혔으면, 최소한 진입점 후보를 넣는다.
    //    빈 컨텍스트로 모델을 부르면 확실히 실패하므로, 못 골랐다는 사실보다 후보를 주는 편이 낫다.
    if ([...selected.values()].every((f) => f.reason === "project-meta")) {
      const sourceFiles = index.fileTree
        .filter((f) => f.language !== null && f.language !== "markdown" && f.language !== "json")
        .slice(0, 5);
      for (const entry of sourceFiles) {
        add(entry.path, "dependency", "요청에서 대상 파일을 특정하지 못해 선택된 소스 후보");
      }
    }

    // 우선순위 정렬 — 예산 부족 시 뒤쪽부터 잘리므로 순서가 곧 정책이다.
    const rank: Record<RelevanceReason, number> = {
      "project-meta": 0,
      mentioned: 1,
      "symbol-match": 2,
      // 본문 검색은 이름 지목보다 약하고 심볼 그래프보다도 약하다. 그런데 **이번 태스크가
      // 방금 고친 파일보다는 앞**이다 — fix loop에서 그 파일들은 이미 컨텍스트에 있었고,
      // 여기서 새로 찾은 것은 아직 한 번도 실리지 않았을 수 있다.
      "content-match": 3,
      "recently-changed": 4,
      dependency: 5,
    };
    return [...selected.values()].sort((a, b) => rank[a.reason] - rank[b.reason]);
  }

  /**
   * 심볼 테이블에서 후보를 더한다 — 4절 `symbol-match`, 22절.
   *
   * # 왜 `mentioned`보다 뒤인가
   *
   * 4절 표의 우선순위가 그렇게 정해져 있고(`mentioned` > `symbol-match`), 그 순서는 근거의
   * 종류가 아니라 **사용자가 직접 말했는가**를 앞에 두는 규칙이다. 심볼 매치는 우리가
   * 유도한 것이므로 사용자가 지목한 것보다 뒤다.
   *
   * # 없으면 아예 만들지 않는다
   *
   * grammar를 못 실었거나 이 저장소가 전부 범위 밖 언어면 `index.symbols`가 비어 있고,
   * 그러면 이 함수는 아무것도 더하지 않는다 — **빈 `symbol-match` 후보를 만들어 "구현했다"고
   * 보이게 하지 않는다**(11절이 정한 규율 그대로). 폴백은 다음 단계의 본문 검색이다.
   */
  private addSymbolMatches(
    index: WorkspaceIndex,
    keywords: readonly string[],
    add: (path: string, reason: RelevanceReason, reasonDetail: string, anchorLines?: number[]) => void
  ): void {
    if (index.symbols.length === 0) return;
    for (const keyword of keywords.slice(0, MAX_SYMBOL_MATCH_KEYWORDS)) {
      const hits = symbolMatchFiles(index.symbols, keyword);
      for (const hit of hits.slice(0, MAX_SYMBOL_MATCH_FILES_PER_KEYWORD)) {
        add(
          hit.path,
          "symbol-match",
          `심볼 인덱스가 ${JSON.stringify(keyword)}의 ${describeKind(hit.kind)} 정의를 이 파일에서 찾음 (Tree-sitter)`,
          hit.anchorLines
        );
      }
    }
  }

  /**
   * 본문 검색으로 후보를 더한다 — state-machine 51절.
   *
   * # 왜 정의 모양을 먼저 찾는가
   *
   * `resolveBudget`을 그냥 찾으면 **부르는 곳이 전부** 걸린다. 그중 고쳐야 할 곳은 대개
   * 정의가 있는 파일 하나이고, 나머지는 예산만 먹는다. 그래서 두 번 찾는다: 정의처럼 보이는
   * 자리를 먼저, 그것이 없을 때만 아무 등장이나.
   *
   * # 근거의 강도를 이름으로 말한다
   *
   * `symbol-match`로 적지 않는다. 그건 심볼 그래프가 있을 때의 근거이고, 여기서 한 것은
   * 정규식이다. 이름이 근거보다 강하면 화면과 감사 기록이 "파서가 확인했다"고 말하게 된다.
   *
   * # 상한
   *
   * 키워드 개수와 키워드당 후보 수 둘 다 묶는다(원칙 5). 검색은 저장소 크기에 비례하고,
   * 상한이 없으면 큰 저장소에서 스냅샷 한 번이 수십 번의 전체 훑기가 된다.
   */
  private async addContentMatches(
    bridge: ToolBridge,
    index: WorkspaceIndex,
    keywords: string[],
    add: (path: string, reason: RelevanceReason, reasonDetail: string, anchorLines?: number[]) => void,
    coverage: CoverageNote[]
  ): Promise<void> {
    const indexed = new Set(index.fileTree.map((f) => f.path));

    for (const keyword of keywords.slice(0, MAX_SEARCHED_KEYWORDS)) {
      const escaped = escapeRegExp(keyword);
      const attempts: { pattern: string; detail: (path: string) => string }[] = [
        {
          pattern: `${DEFINITION_PREFIX}${escaped}\\b`,
          detail: () => `본문에서 ${JSON.stringify(keyword)}의 정의처럼 보이는 자리를 찾음 (정규식 — 심볼 그래프 아님)`,
        },
        {
          pattern: `\\b${escaped}\\b`,
          detail: () => `본문에 ${JSON.stringify(keyword)}가 나타남 (정규식 — 심볼 그래프 아님)`,
        },
      ];

      for (const attempt of attempts) {
        let found: Awaited<ReturnType<ToolBridge["searchText"]>>;
        try {
          found = await bridge.searchText(attempt.pattern);
        } catch (error) {
          // **실패를 "없음"으로 읽지 않는다.** 읽지 못한 것과 없는 것은 다른 사실이고,
          // 뭉개면 컨텍스트가 조용히 좁아진 채 모델이 불린다.
          coverage.push({
            kind: "search_failed",
            scope: `본문 검색: ${keyword}`,
            reason: `검색이 실패해 이 키워드로는 후보를 찾지 못했습니다: ${String(error)}`,
          });
          break;
        }

        const hits = found.matches;

        // **검색이 못 본 것을 기록한다**(58절). 실제 도구는 비밀값 파일을 읽기 전에 건너뛰고
        // 그 개수를 돌려주는데, 종전에는 그 값을 아무도 읽지 않았다 — 그래서 "검색했는데
        // 없다"와 "검색하지 않았다"가 호출부에서 같은 빈 배열이었다.
        //
        // 13절이 검색 **실패**를 "없음"으로 읽지 않게 만든 것과 같은 규율이고, 이쪽은
        // **일부러 안 본** 경우다.
        if (found.skippedSecretFiles !== null && found.skippedSecretFiles > 0) {
          coverage.push({
            kind: "search_secret_skipped",
            scope: `본문 검색: ${keyword}`,
            reason: `비밀값 파일 ${found.skippedSecretFiles}개는 검색하지 않았습니다 — 거기 있었다면 찾지 못했습니다.`,
          });
        }
        // **`null`은 "잘리지 않았다"가 아니다**(18절). 모르는 것을 낙관으로 접지 않는다.
        if (found.truncated !== false) {
          coverage.push({
            // **두 사실을 한 종류로 뭉개지 않는다**(19절). 문장이 다르면 종류도 달라야 한다 —
            // 같은 칸에 세면 "상한을 올려라"와 "호스트를 고쳐라"가 한 숫자가 된다.
            kind: found.truncated === true ? "search_truncated" : "search_unknown",
            scope: `본문 검색: ${keyword}`,
            reason:
              found.truncated === true
                ? "검색 결과가 상한에서 잘렸습니다 — 이 키워드로 찾은 것이 전부가 아닙니다."
                : "검색 결과가 전부인지 호스트가 말하지 않았습니다 — 전부라고 가정할 수 없습니다.",
          });
        }

        // **인덱스에 있는 파일만 받는다.** 검색은 우리 제외 규칙(크기 상한, 하드 제외 목록)을
        // 적용하지 않으므로, 여기서 거르지 않으면 제외했던 파일이 옆문으로 들어온다.
        // (gitignore는 20절 이후 양쪽이 같다 — 그래서 여기서 걸리는 것은 우리 규칙뿐이다.)
        const unique = [...new Set(hits.map((h) => h.path))];
        const paths = unique.filter((p) => indexed.has(p));
        // **버린 것을 말한다**(21절). 검색이 맞혔는데 후보로 올리지 않았다는 것은
        // "검색했는데 없다"와 다른 사실이고, 종전에는 그 차이가 호출부에서 빈 배열 하나로
        // 뭉개졌다 — 16절이 `skippedSecretFiles`에서 본 것과 같은 모양이 한 칸 옆에 있었다.
        const notIndexed = unique.length - paths.length;
        if (notIndexed > 0) {
          coverage.push({
            kind: "search_hit_not_indexed",
            scope: `본문 검색: ${keyword}`,
            reason: `검색이 맞힌 파일 ${notIndexed}개는 인덱스에 없어 후보로 올리지 않았습니다 — 제외 규칙(크기·기본 제외 목록)에 걸린 파일입니다.`,
          });
        }
        if (paths.length === 0) continue;
        // **상한에서 버린 것도 말한다**(21절). 상한이 3이므로 흔한 이름 하나면 바로 걸리는데,
        // 종전에는 그 사실이 어디에도 남지 않아 "이 키워드로 찾은 것은 셋뿐"으로 읽혔다.
        if (paths.length > MAX_MATCHES_PER_KEYWORD) {
          coverage.push({
            kind: "search_hits_capped",
            scope: `본문 검색: ${keyword}`,
            reason: `이 키워드가 맞힌 파일 ${paths.length}개 중 ${MAX_MATCHES_PER_KEYWORD}개만 후보로 올렸습니다 — 나머지는 보지 않았습니다.`,
          });
        }
        for (const path of paths.slice(0, MAX_MATCHES_PER_KEYWORD)) {
          // **줄 번호를 함께 나른다**(14절). 잘라 넣어야 할 때 어디를 남길지가 여기 걸려 있다 —
          // 없으면 앞에서부터 자르고, 파일 뒤쪽에 있는 정의는 찾아 놓고도 잘려 나간다.
          const lines = hits.filter((h) => h.path === path).map((h) => h.line);
          add(path, "content-match", attempt.detail(path), lines);
        }
        // 정의를 찾았으면 넓은 검색은 하지 않는다 — 부르는 곳까지 다 넣으면 예산만 먹는다.
        break;
      }
    }
  }

  private notesForMentionedButExcluded(index: WorkspaceIndex, userMessage: string): { path: string; reason: string }[] {
    const mentions = extractMentions(userMessage);
    const notes: { path: string; reason: string }[] = [];
    for (const mention of mentions) {
      const hit = index.excluded.find((e) => e.path === mention || e.path.endsWith(`/${mention}`));
      if (hit) notes.push({ path: hit.path, reason: hit.reason });
    }
    return notes;
  }


  /**
   * 프로젝트 유형과 검증 명령 감지.
   *
   * 여기서 감지한 명령은 **UI 표시와 모델 컨텍스트용**이다. 실제 검증에 쓰이는 명령은
   * Rust의 `verify.rs`가 독립적으로 감지한다 — Node가 넘긴 명령을 그대로 실행하면
   * "검증 명령을 바꿔치기해 통과시키는" 경로가 열리기 때문이다. 두 곳에 감지 로직이
   * 있는 것은 중복이 아니라 의도된 이중화다.
   */
  private async detectProjectMeta(
    bridge: ToolBridge,
    fileTree: readonly { path: string; language: string | null }[]
  ): Promise<ProjectMeta> {
    const paths = new Set(fileTree.map((f) => f.path));
    const languages = [...new Set(fileTree.map((f) => f.language).filter((l): l is string => l !== null))];

    const meta: ProjectMeta = {
      languages,
      agentsMdPresent: false,
    };

    // 프로젝트 규칙 파일 — 존재하면 내용을 항상 컨텍스트에 넣는다.
    const ruleSources: string[] = [];
    const ruleTexts: string[] = [];
    for (const candidate of PROJECT_RULE_FILES) {
      if (!paths.has(candidate)) continue;
      const content = await bridge.tryReadFile(candidate);
      if (content !== null && content.trim().length > 0) {
        ruleSources.push(candidate);
        ruleTexts.push(`# ${candidate}\n\n${content}`);
        // CLAUDE.md/AGENTS.md만으로 충분하면 README까지 다 넣지 않는다 (예산 절약).
        if (candidate === "CLAUDE.md" || candidate === "AGENTS.md") break;
      }
    }
    if (ruleTexts.length > 0) {
      meta.agentsMdPresent = true;
      meta.agentsMdContent = ruleTexts.join("\n\n---\n\n");
      meta.agentsMdSources = ruleSources;
    }

    if (paths.has("package.json")) {
      const raw = await bridge.tryReadFile("package.json");
      const scripts = parseNpmScripts(raw);
      const npm = (script: string, source: string): DetectedCommand =>
        script === "test"
          ? { program: "npm", args: ["test"], cwd: ".", source }
          : { program: "npm", args: ["run", script], cwd: ".", source };
      if (scripts.has("test")) meta.testCommand = npm("test", "package.json scripts.test");
      if (scripts.has("build")) meta.buildCommand = npm("build", "package.json scripts.build");
      if (scripts.has("lint")) meta.lintCommand = npm("lint", "package.json scripts.lint");
      if (scripts.has("typecheck")) meta.typecheckCommand = npm("typecheck", "package.json scripts.typecheck");
    }

    if (paths.has("Cargo.toml")) {
      meta.testCommand ??= { program: "cargo", args: ["test", "--quiet"], cwd: ".", source: "Cargo.toml" };
      meta.buildCommand ??= { program: "cargo", args: ["build", "--quiet"], cwd: ".", source: "Cargo.toml" };
    }

    const dotnetProject = [...paths].find((p) => /\.(sln|csproj|fsproj)$/i.test(p) && !p.includes("/"));
    if (dotnetProject) {
      meta.testCommand ??= { program: "dotnet", args: ["test"], cwd: ".", source: dotnetProject };
      meta.buildCommand ??= { program: "dotnet", args: ["build"], cwd: ".", source: dotnetProject };
    }

    // ---- Python (state-machine 49절) ----
    //
    // **인터프리터를 여기서 정하지 않는다.** 어느 python으로 도는지는 Rust가 가상환경을 보고
    // 정하고(`python.rs`), 그 판정이 Node에도 있으면 **검증 명령의 출처가 Node가 된다** —
    // 24.5절이 자동 승인의 근거로 삼은 "프로젝트가 선언했고 Rust가 유도했다"가 무너진다.
    //
    // 그래도 여기서 침묵하면 안 된다. 침묵하면 프롬프트가 `(none detected)`라고 적는데,
    // Rust는 실제로 pytest를 돌리므로 **그건 거짓말**이다. 그래서 선언만 옮긴다:
    // 프로그램 이름은 일반형(`python`)이고, 실제로 도는 것은 Rust가 고른 인터프리터다.
    const pytestDeclaration = await detectPytestDeclaration(bridge, paths);
    if (pytestDeclaration) {
      meta.testCommand ??= { program: "python", args: ["-m", "pytest"], cwd: ".", source: pytestDeclaration };
    }

    return meta;
  }
}

/**
 * 이 프로젝트가 pytest를 **선언했는가** — state-machine 49.1절.
 *
 * 판정 규칙은 Rust의 `python.rs`와 같아야 한다. 두 곳에 있는 이유는 24.5절이다: Rust는
 * 실행할 명령을 정하고(그게 자동 승인의 근거다), 여기는 프롬프트에 실을 사실을 정한다.
 * **갈리면 프롬프트가 없는 테스트를 있다고 하거나 있는 테스트를 없다고 한다** —
 * `contextClaim` 검사가 두 목록을 소스에서 유도해 대조한다.
 *
 * `tests/` 디렉터리는 근거가 아니다. unittest·tox를 쓰는 프로젝트에도 있다.
 */
async function detectPytestDeclaration(
  bridge: { tryReadFile(path: string): Promise<string | null> },
  paths: Set<string>
): Promise<string | null> {
  if (paths.has("pytest.ini")) return "pytest.ini";
  for (const [file, section] of PYTEST_SECTIONS) {
    if (!paths.has(file)) continue;
    const raw = await bridge.tryReadFile(file);
    if (raw && declaresSection(raw, section)) return `${file} ${section}`;
  }
  return null;
}

/** `python.rs`의 같은 목록과 대조된다. 순서까지 같아야 한다 — 근거 문자열이 달라지면 안 된다. */
export const PYTEST_SECTIONS: readonly (readonly [string, string])[] = [
  ["pyproject.toml", "[tool.pytest.ini_options]"],
  ["setup.cfg", "[tool:pytest]"],
  ["tox.ini", "[pytest]"],
];

/** 주석 처리된 줄은 선언이 아니다 — 꺼 둔 도구를 우리가 켜게 된다. */
export function declaresSection(text: string, section: string): boolean {
  return text
    .split("\n")
    .map((line) => line.trim())
    .some((line) => !line.startsWith("#") && !line.startsWith(";") && line.startsWith(section));
}

// ---- 순수 함수 (단위 테스트 대상) ----

/** 메시지에서 파일 경로처럼 보이는 토큰을 뽑는다. */
export function extractMentions(message: string): string[] {
  const found = new Set<string>();
  const patterns = [
    // 경로 구분자를 포함하거나 확장자로 끝나는 토큰: src/app.ts, app.tsx
    /[\w./\\-]*[\w-]+\.[a-zA-Z0-9]{1,6}\b/g,
    /[\w-]+\/[\w./-]+/g,
    // dotfile: `.env`, `.env.local`, `.gitignore`. 위 패턴은 점 앞에 단어 문자를 요구하므로
    // 이걸 따로 두지 않으면 `.env` 언급을 놓치고, 그러면 "secret을 제외했다"는 안내도 못 한다.
    /(?:^|[\s"'(])(\.[\w-]+(?:\.[\w-]+)*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const raw = match[1] ?? match[0];
      const token = raw.replace(/\\/g, "/").replace(/^\.\//, "");
      // 문장 끝의 마침표를 경로 일부로 오인하지 않는다.
      const cleaned = token.replace(/\.$/, "");
      if (cleaned.length > 1) found.add(cleaned);
    }
  }
  return [...found];
}

/** 식별자 후보(camelCase, snake_case, 3자 이상 영문 단어)를 뽑는다. */
export function extractKeywords(message: string): string[] {
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "fix", "bug", "please",
    "should", "would", "could", "make", "made", "does", "not", "but", "you", "are", "was", "were", "have",
    "add", "use", "using", "code", "file", "files", "test", "tests", "function", "error", "issue",
  ]);
  const found = new Set<string>();
  for (const match of message.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)) {
    const token = match[0];
    if (stop.has(token.toLowerCase())) continue;
    // camelCase나 snake_case, 혹은 흔치 않은 단어만 남긴다.
    const looksLikeIdentifier = /[A-Z]/.test(token.slice(1)) || token.includes("_") || token.length >= 5;
    if (looksLikeIdentifier) found.add(token);
  }
  return [...found].slice(0, 12);
}

/**
 * grammar 적재 실패를 스냅샷에 남긴다 — 22절.
 *
 * **그 언어의 파일이 실제로 있을 때만 적는다.** Python이 한 줄도 없는 저장소에서 "python
 * grammar를 못 실었습니다"는 사용자가 할 일이 없는 잡음이고, 잡음이 섞이면 정작 읽어야 할
 * 줄이 안 읽힌다.
 *
 * # 왜 `CoverageNote`인가 (17절)
 *
 * 이건 **파일이 아니라 범위**다. 종전에는 `excludedNotes`에 `path: "(symbol-index: python)"`로
 * 들어갔는데, 그 목록은 프롬프트와 화면에서 **파일 이름으로 읽히는** 자리다 — 17절이 검색
 * 노트에 대해 고친 것과 **글자 그대로 같은 결함**이고, 이 자리는 그 뒤에 갈라진 브랜치에서
 * 새로 생겼다. 병합에서야 나란히 놓여 보였다: 한쪽 브랜치만 읽으면 각각은 옳아 보인다.
 * 판정 기준을 사람이 아니라 종류 목록(`COVERAGE_NOTE_KINDS`)이 들고 있는 이유가 이것이다.
 */
function grammarNotes(index: WorkspaceIndex): CoverageNote[] {
  const affected = new Set(
    index.fileTree.filter((f) => f.symbolStatus === "grammar-unavailable").map((f) => f.language)
  );
  return index.symbolIndex.languages
    .filter((entry) => !entry.loaded && affected.has(entry.language))
    .map((entry) => ({
      scope: `심볼 인덱스: ${entry.language}`,
      reason:
        `Tree-sitter ${entry.language} grammar를 싣지 못해 이 언어의 심볼/의존성 선정이 빠졌습니다` +
        ` — 본문 검색(ripgrep) 폴백만 동작합니다: ${entry.error ?? "사유 미상"}`,
      kind: "symbol_grammar_unavailable" as const,
    }));
}

/**
 * 이미 고른 파일들이 **import하는** 파일을 더한다 — 4절 `dependency`, 22절.
 *
 * # 씨앗은 직접 매치된 파일뿐이다
 *
 * `project-meta`(README·package.json)와 이 단계가 스스로 넣은 파일은 씨앗이 아니다. 전자는
 * 관련성이 아니라 규칙 때문에 들어온 파일이고, 후자를 씨앗으로 삼으면 홉 상한이 의미를
 * 잃는다(2홉이 3홉이 된다).
 *
 * # 왜 우선순위가 가장 뒤인가
 *
 * 4절 표가 그렇게 정했다. 직접 매치가 없는 주변 맥락이므로, 예산이 모자라면 여기부터
 * 잘리는 것이 맞다 — 잘려도 모델은 여전히 고칠 파일 자체는 보고 있다.
 */
function addDependencyNeighbours(
  index: WorkspaceIndex,
  selected: readonly { path: string; reason: RelevanceReason }[],
  add: (path: string, reason: RelevanceReason, reasonDetail: string, anchorLines?: number[]) => void
): void {
  if (index.dependencyEdges.length === 0) return;
  const seeds = selected
    .filter((c) => c.reason === "mentioned" || c.reason === "symbol-match" || c.reason === "content-match")
    .map((c) => c.path);
  if (seeds.length === 0) return;

  const indexed = new Set(index.fileTree.map((f) => f.path));
  const neighbours = dependenciesWithinHops(index.dependencyEdges, seeds, DEPENDENCY_MAX_HOPS)
    // 인덱스에 없는 파일은 하드 필터가 막은 것이다. 그래프를 통해 옆문으로 들이지 않는다.
    .filter((n) => indexed.has(n.path))
    .slice(0, MAX_DEPENDENCY_FILES);

  for (const neighbour of neighbours) {
    add(
      neighbour.path,
      "dependency",
      `${neighbour.via}에서 import 그래프로 ${neighbour.hops}홉 (Tree-sitter 의존성 그래프)`
    );
  }
}

/** 화면과 감사 기록에 심볼 종류를 한국어로 적는다. 근거의 강도를 사람이 읽을 수 있어야 한다. */
function describeKind(kind: SymbolEntry["kind"]): string {
  switch (kind) {
    case "function":
      return "함수";
    case "class":
      return "클래스/구조체";
    case "method":
      return "메서드";
    case "interface":
      return "인터페이스/트레이트";
    case "type":
      return "타입";
    case "const":
      return "최상위 상수";
    case "export":
      return "재수출";
  }
}

/**
 * 인덱스가 어느 상태에서 만들어졌는가.
 *
 * porcelain=v1 --branch의 첫 줄은 `## branch...upstream [ahead 1]`이고 HEAD SHA는 없다.
 * 인덱스 기록에 필요한 것은 "무언가 바뀌었는가"이므로 status 출력 전체를 지문으로 쓴다 —
 * SHA를 얻자고 명령을 하나 더 실행할 이유가 없다. (재사용 **판정**의 키는 이것이 아니라
 * Rust의 워크스페이스 지문이다 — 2.1절.)
 */
export function gitHeadFingerprint(porcelain: string): string {
  const branch = parseBranch(porcelain);
  return branch === "(unknown)" ? "(no-git)" : `${branch}@${hashString(porcelain)}`;
}

/**
 * 지난 인덱스 이후 **다시 파싱해야 하는 파일** — 6절 표 2행.
 *
 * # 왜 `git diff <gitHeadAtIndex>..HEAD`가 아닌가
 *
 * 6절 표는 그 명령을 적었지만 Node에게는 그 명령이 없다. HEAD SHA를 주는 도구도, 리비전
 * 범위를 받는 `git_diff`도 없고, **그걸 만들자고 Rust에 임의의 리비전 문자열을 받는 입구를
 * 내는 것**은 읽기 전용 도구 하나를 위해 신뢰 경계에 손대는 일이다(원칙 2).
 *
 * 대신 같은 질문에 우리가 이미 가진 것으로 답한다:
 *
 * - `list_files`가 준 **경로와 크기** — 추가·삭제·크기가 달라진 편집을 전부 잡는다.
 * - `git status`가 준 **더러운 경로** — 크기가 그대로인 편집(한 글자 교체)을 잡는다.
 *
 * 커밋으로 HEAD가 옮겨간 경우는 어떤가? 그 파일들은 커밋되기 전에 더러운 상태였고, 우리
 * 세션 안에서 일어난 변경이면 6절 표 1행(도구 변경 직후 재파싱)이 이미 반영했다. 세션 **밖**
 * 에서 커밋까지 끝난 변경은 이 두 신호에 안 잡히는데, 그 경우 인덱스는 프로세스 메모리에도
 * 없다(sidecar가 워크스페이스마다 새로 뜬다 — process-architecture 11.3절). 즉 증분이 아니라
 * 전체 구축 경로다.
 *
 * 남는 사각은 **같은 세션 안에서 우리 도구를 거치지 않고 편집한 뒤 외부에서 커밋까지** 한
 * 경우 하나다. 그건 6절 표 3행(diff가 크면 전체 재구축)이 겨냥한 상황과 겹치므로, 상한을
 * 넘으면 어차피 전체로 간다.
 */
export function changedPaths(
  previous: WorkspaceIndex,
  scanned: readonly { path: string; sizeBytes: number }[],
  porcelain: string
): Set<string> {
  const before = new Map(previous.fileTree.map((f) => [f.path, f.sizeBytes]));
  const changed = new Set<string>();
  for (const entry of scanned) {
    const size = before.get(entry.path);
    if (size === undefined || size !== entry.sizeBytes) changed.add(entry.path);
  }
  const now = new Set(scanned.map((f) => f.path));
  for (const path of before.keys()) if (!now.has(path)) changed.add(path);
  for (const path of parseDirtyPaths(porcelain)) if (now.has(path)) changed.add(path);
  return changed;
}

/**
 * porcelain=v1의 더러운 경로.
 *
 * 이름 변경(`R  old -> new`)은 **새 이름**을 쓴다 — 다시 파싱해야 하는 것은 지금 있는 파일이고,
 * 없어진 옛 이름은 파일 트리 비교가 이미 잡는다.
 */
export function parseDirtyPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("## ") || line.trim() === "") continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const target = arrow === -1 ? rest : rest.slice(arrow + 4);
    // 특수문자가 있으면 git이 경로를 따옴표로 감싼다.
    paths.push(target.replace(/^"/, "").replace(/"$/, "").trim());
  }
  return paths;
}

export function parseBranch(porcelain: string): string {
  const first = porcelain.split("\n").find((line) => line.startsWith("## "));
  if (!first) return "(unknown)";
  const rest = first.slice(3);
  // "branch...origin/branch [ahead 1]" 또는 "HEAD (no branch)"
  return rest.split(/\.{3}| \[/)[0]?.trim() || "(unknown)";
}

export function hasUncommittedChanges(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .some((line) => line.trim().length > 0 && !line.startsWith("## "));
}

export function parseNpmScripts(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    // 매니페스트가 깨져 있으면 스크립트가 없는 것으로 본다 — 추측해서 명령을 만들지 않는다.
    return new Set();
  }
}

/** 인덱스 무효화 판정용 짧은 지문. 암호학적 용도가 아니다. */
function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 인덱스가 **전부를 봤는지**에 대한 범위 노트 — context-engine 18절.
 *
 * 세 값이 세 문장이다. `false`만 침묵이고, `null`은 침묵이 아니다 — "말하지 않았다"를
 * "안 잘렸다"로 접으면 우리가 모르는 것을 안다고 주장하게 된다(16절의 `null` vs `0` 규칙).
 */
export function listingCoverageNote(truncated: boolean | null | undefined): CoverageNote | null {
  if (truncated === false) return null;
  if (truncated === true) {
    return {
      kind: "listing_truncated",
      scope: "파일 목록",
      reason:
        "워크스페이스 파일 목록이 호스트 상한에서 잘렸습니다 — 여기 없는 파일이 저장소에 있을 수 있습니다.",
    };
  }
  return {
    kind: "listing_unknown",
    scope: "파일 목록",
    reason: "파일 목록이 전부인지 호스트가 말하지 않았습니다 — 전부라고 가정할 수 없습니다.",
  };
}

/**
 * 범위 노트를 **똑같은 것끼리** 접는다 — context-engine 21절.
 *
 * # 왜 생기는가
 *
 * 키워드 하나에 검색 시도가 둘이다(정의 모양 → 아무 등장). 첫 시도가 인덱스에 있는 파일을
 * 하나도 못 집으면 둘째 시도가 이어 돌고, **두 시도가 같은 워크스페이스를 훑으므로 같은
 * 사실을 두 번 보고한다.** 실측으로 `비밀값 파일 1개는 검색하지 않았습니다`가 글자까지
 * 똑같이 둘 나왔다.
 *
 * 파일 노트에는 경로당 하나로 접는 장치가 있었지만(`byPathNote`) 범위 쪽에는 없었다.
 *
 * # "같은 것"을 무엇으로 볼 것인가
 *
 * 17.5절은 이 결정을 어렵게 봤다 — *"`scope`가 같으면 접는 것이 자연스럽지만, '비밀값 3개를
 * 건너뜀'과 '상한에서 잘림'은 같은 `scope`의 다른 사실이다."*
 *
 * **세 값이 모두 같을 때만 접는다**(`kind`·`scope`·`reason`). 그러면 그 걱정이 사라진다:
 * 종류가 다르면 남고, 종류가 같아도 문장이 다르면 남는다. 접히는 것은 **글자까지 같은 중복**
 * 뿐이고, 그건 정의상 사용자에게 새 사실이 아니다.
 *
 * 개수를 합치지 않는 이유도 같다. 두 시도가 각각 "비밀값 1개"를 보고했다고 2개를 건너뛴 것이
 * 아니다 — **같은 파일을 두 번 지나친 것**이다. 합치면 없는 숫자가 생긴다.
 *
 * # 순서는 유지한다
 *
 * 노트는 프롬프트와 화면에 나온 순서대로 읽힌다. 목록 노트가 먼저, 검색 노트가 키워드
 * 순서대로 오는 것이 지금의 배치이고, 접는 일이 그 배치를 바꾸면 안 된다.
 */
export function foldCoverageNotes(notes: CoverageNote[]): CoverageNote[] {
  const seen = new Set<string>();
  const folded: CoverageNote[] = [];
  for (const note of notes) {
    // 구분자는 사용자 문장에 나올 수 없는 값이어야 한다 — 공백으로 이으면 서로 다른 세 값이
    // 우연히 같은 키가 될 수 있다. 소스에 리터럴 NUL을 박으면 그 파일이 grep에서 통째로
    // 사라지므로 이스케이프로 쓴다(CLAUDE.md 함정 기록).
    const key = [note.kind ?? "", note.scope, note.reason].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    folded.push(note);
  }
  return folded;
}
