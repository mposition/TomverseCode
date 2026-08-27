import type {
  DependencyEdge,
  SymbolEntry,
  SymbolIndexReport,
  SymbolIndexStatus,
  WorkspaceIndexFileEntry,
} from "@tomverse/protocol";
import { resolveImport } from "./imports.js";
import { extractFromTree } from "./symbols.js";
import {
  grammarForPath,
  loadGrammars,
  SUPPORTED_LANGUAGES,
  type GrammarSet,
} from "./treeSitter.js";

/**
 * 심볼/의존성 인덱스 구축 — docs/design/context-engine.md 5·6·16절.
 *
 * `engine.ts`에서 떼어낸 이유: 전체 구축(2절)과 증분 갱신(6절 표)이 **같은 규칙**을 써야
 * 하는데, 두 곳에 파싱과 상태 판정을 복사하면 언젠가 갈라지고 갈라진 쪽은 조용히 틀린
 * 심볼을 남긴다("낡은 심볼을 남기면 모델이 지금은 없는 함수를 본다" — 6.1절).
 */

/**
 * 인덱스 **모양**의 버전 (2.1절 "모양이 다르면 없는 것으로 다룬다").
 *
 * 심볼 층이 붙으면서 `WorkspaceIndexFileEntry`에 `symbolStatus`가 늘었다. 옛 캐시 행에는
 * 그 필드가 없고, 없는 것을 그대로 쓰면 모든 파일이 "상태를 모르는 파일"이 되는데 그건
 * 화면과 이벤트에서 "심볼이 없는 파일"과 구별되지 않는다. 숫자를 올리면 옛 행은 버려진다.
 */
export const SYMBOL_INDEX_VERSION = 1;

/**
 * 파서에 넣을 파일 수 상한 (원칙 5).
 *
 * **시간 예산이 아니라 개수 예산인 이유**: 시간으로 자르면 같은 워크스페이스가 실행마다
 * 다른 인덱스를 낸다. 그러면 두 실행자가 같은 스냅샷을 받는다는 전제(1절)가 "대개 같다"로
 * 약해지고, 대조에서 나온 차이가 모델 차이인지 인덱스 차이인지 구별되지 않는다.
 * 파일 트리 순서는 결정적이므로 개수로 자르면 결과도 결정적이다.
 */
export const MAX_SYMBOL_INDEXED_FILES = 4_000;

export interface SymbolIndexOutcome {
  symbols: SymbolEntry[];
  edges: DependencyEdge[];
  /** 경로 → 이 파일이 어디까지 갔는가. `fileTree`에 되돌려 적는다. */
  statuses: Map<string, SymbolIndexStatus>;
  report: SymbolIndexReport;
}

export interface IndexTarget {
  path: string;
  language: string | null;
}

/** 파일 내용을 가져오는 함수. **`ToolBridge.tryReadFile`이 들어온다** — 여기서 fs를 열지 않는다. */
export type ReadFile = (path: string) => Promise<string | null>;

/**
 * 파일 목록을 파싱해 심볼과 엣지를 만든다.
 *
 * `knownPaths`는 **엣지의 착지점을 제한한다.** 인덱스에 없는 파일(비밀값·대용량·gitignore로
 * 걸러진 것)로 가는 엣지를 만들면 7절의 하드 필터가 그래프를 통해 옆문으로 뚫린다 —
 * 13.4절이 본문 검색에 대해 이미 닫은 것과 같은 문이다.
 */
export async function indexSymbols(input: {
  targets: readonly IndexTarget[];
  knownPaths: ReadonlySet<string>;
  read: ReadFile;
  maxFiles?: number;
  /** 테스트가 grammar 적재 실패를 만들 수 있어야 한다. */
  grammars?: GrammarSet;
}): Promise<SymbolIndexOutcome> {
  const startedAt = Date.now();
  const grammars = input.grammars ?? (await loadGrammars());
  const languageReport = grammars.report();
  const failedLanguages = new Set(languageReport.filter((l) => !l.loaded).map((l) => l.language));
  const maxFiles = input.maxFiles ?? MAX_SYMBOL_INDEXED_FILES;

  const symbols: SymbolEntry[] = [];
  const edges: DependencyEdge[] = [];
  const statuses = new Map<string, SymbolIndexStatus>();
  let bytesParsed = 0;
  let attempted = 0;

  for (const target of input.targets) {
    const grammar = target.language === null ? null : grammarForPath(target.path);
    if (grammar === null) {
      // 9절 범위 밖. **빈 심볼 배열을 넣지 않는다** — "심볼이 없다"가 아니라 "파서가 없다"다.
      statuses.set(target.path, "unsupported-language");
      continue;
    }
    if (failedLanguages.has(target.language as (typeof SUPPORTED_LANGUAGES)[number])) {
      statuses.set(target.path, "grammar-unavailable");
      continue;
    }
    if (attempted >= maxFiles) {
      statuses.set(target.path, "skipped-budget");
      continue;
    }
    attempted += 1;

    const source = await input.read(target.path);
    if (source === null) {
      statuses.set(target.path, "unreadable");
      continue;
    }

    const tree = grammars.parse(grammar, source);
    if (tree === null) {
      // grammar는 실렸는데 이 파일에서 파서가 트리를 못 냈다 — 적재 실패와 다른 사실이다.
      statuses.set(target.path, "parse-failed");
      continue;
    }
    bytesParsed += source.length;

    if (tree.rootNode.hasError) {
      // **6.1절의 규칙 그대로**: 심볼을 잃되 파일이 사라지지는 않는다. 반쯤 맞는 심볼을
      // 남기면 모델이 지금은 없는 함수를 "본다" — 그 오류는 화면에 아무 흔적도 남기지 않는다.
      statuses.set(target.path, "parse-failed");
      continue;
    }

    const extracted = extractFromTree({
      path: target.path,
      language: target.language as string,
      grammar,
      tree,
    });
    symbols.push(...extracted.symbols);
    for (const raw of extracted.imports) {
      const to = resolveImport({
        fromPath: target.path,
        language: target.language as string,
        specifier: raw.specifier,
        kind: raw.kind,
        paths: input.knownPaths,
      });
      // 자기 자신을 가리키는 엣지는 순회에서 할 일이 없다.
      if (to === null || to === target.path) continue;
      edges.push({ fromFile: target.path, toFile: to, kind: raw.kind });
    }
    statuses.set(target.path, "indexed");
  }

  return {
    symbols,
    edges: dedupeEdges(edges),
    statuses,
    report: {
      version: SYMBOL_INDEX_VERSION,
      languages: languageReport,
      filesIndexed: count(statuses, "indexed"),
      filesParseFailed: count(statuses, "parse-failed"),
      filesSkipped: count(statuses, "skipped-budget"),
      filesUnreadable: count(statuses, "unreadable"),
      symbolCount: symbols.length,
      edgeCount: dedupeEdges(edges).length,
      durationMs: Date.now() - startedAt,
      bytesParsed,
    },
  };
}

/**
 * 이미 있는 인덱스에 **바뀐 파일만** 다시 반영한다 — 6절 표의 1·2행.
 *
 * 규칙 하나가 전부다: **그 파일이 낸 것만 지우고 그 파일이 낸 것만 넣는다.** 지우지 않으면
 * 삭제된 함수의 심볼이 남고(6.1절이 금지한 상태), 통째로 다시 만들면 증분이 아니다.
 */
export function mergeSymbolIndex(
  previous: { symbols: readonly SymbolEntry[]; edges: readonly DependencyEdge[]; report: SymbolIndexReport },
  changedPaths: ReadonlySet<string>,
  update: SymbolIndexOutcome,
  /** 지금 인덱스에 있는 경로. 여기 없는 파일로 가는 엣지는 버린다(삭제된 파일). */
  livePaths: ReadonlySet<string>
): { symbols: SymbolEntry[]; edges: DependencyEdge[]; report: SymbolIndexReport } {
  const symbols = previous.symbols
    .filter((symbol) => !changedPaths.has(symbol.filePath) && livePaths.has(symbol.filePath))
    .concat(update.symbols);
  const edges = previous.edges
    .filter(
      (edge) =>
        !changedPaths.has(edge.fromFile) && livePaths.has(edge.fromFile) && livePaths.has(edge.toFile)
    )
    .concat(update.edges.filter((edge) => livePaths.has(edge.toFile)));

  const deduped = dedupeEdges(edges);
  return {
    symbols,
    edges: deduped,
    report: {
      ...previous.report,
      // grammar 적재 결과는 프로세스 단위 사실이므로 최신 것으로 덮는다.
      languages: update.report.languages,
      symbolCount: symbols.length,
      edgeCount: deduped.length,
      // 증분에서 다시 센 파일 상태는 `fileTree`가 들고 있으므로, 보고서의 파일 수는
      // 호출자가 트리에서 다시 센다(여기서 더하면 같은 파일이 두 번 세어진다).
    },
  };
}

/** `fileTree`의 상태를 다시 세어 보고서의 파일 수를 맞춘다. 두 값이 갈리면 보고가 거짓이 된다. */
export function recountReport(
  report: SymbolIndexReport,
  fileTree: readonly WorkspaceIndexFileEntry[]
): SymbolIndexReport {
  const tally = (status: SymbolIndexStatus) => fileTree.filter((f) => f.symbolStatus === status).length;
  return {
    ...report,
    filesIndexed: tally("indexed"),
    filesParseFailed: tally("parse-failed"),
    filesSkipped: tally("skipped-budget"),
    filesUnreadable: tally("unreadable"),
  };
}

function count(statuses: ReadonlyMap<string, SymbolIndexStatus>, status: SymbolIndexStatus): number {
  let total = 0;
  for (const value of statuses.values()) if (value === status) total += 1;
  return total;
}

/**
 * 같은 (from, to, kind) 엣지는 하나다. `import x from "./a"`가 두 번 나오는 파일이 있고,
 * 중복이 남으면 `dependencyEdges.length`가 그래프 크기가 아니라 문장 수를 세게 된다.
 */
function dedupeEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
  const seen = new Set<string>();
  const out: DependencyEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromFile} ${edge.toFile} ${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}
