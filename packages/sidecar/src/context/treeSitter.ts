import { createRequire } from "node:module";
import type { SymbolIndexReport } from "@tomverse/protocol";

/**
 * Tree-sitter grammar 적재 — docs/design/context-engine.md 5·9·16절.
 *
 * # 왜 WASM인가 (되돌리기 비싼 결정)
 *
 * Tree-sitter의 Node 바인딩은 두 갈래다.
 *
 * - **네이티브(`tree-sitter` + `tree-sitter-<lang>`)**: node-gyp로 C++를 빌드한다. 즉 사용자
 *   머신에 **MSVC가 있어야** 하거나 우리가 Node ABI × 플랫폼마다 prebuild를 배포해야 한다.
 *   이 저장소의 CLAUDE.md 함정 기록 절반이 Windows에서 MSVC를 찾는 이야기다 — 그 문제를
 *   Rust 빌드에서 겨우 닫아 놓고 **사용자 설치 경로에 다시 들이는 것**이 이 선택의 값이다.
 * - **WASM(`web-tree-sitter` + `.wasm` grammar)**: 파일 하나가 모든 플랫폼에서 돈다.
 *   빌드 도구도, ABI 짝맞추기도 없다.
 *
 * 데스크톱 앱에 sidecar를 번들해 배포하는 제품에서 전자는 배포 실패 모드를 하나 더 만든다.
 * 그래서 **WASM을 쓴다.** 대가는 파싱 속도(네이티브보다 느리다)와 grammar 파일 크기(5개 약
 * 6.7MB)이고, 그 대가는 16절이 실측해서 적어 두었다.
 *
 * # 버전을 고정한다 (rusqlite 0.37과 같은 이유)
 *
 * `web-tree-sitter` **0.26**은 `tree-sitter-wasms` 0.1.13이 배포하는 grammar를 거부한다
 * (emscripten dylink 메타데이터가 갈렸다 — `Language.load`가 그냥 `Error`를 던진다).
 * 그래서 `^0.25.10`이다. 올리려면 grammar 쪽 ABI를 **먼저** 확인할 것.
 *
 * # 신뢰 경계를 뚫지 않는다
 *
 * 이 모듈은 **워크스페이스 파일을 읽지 않는다.** 여는 것은 우리 자신의 `node_modules` 안에
 * 있는 grammar 바이너리이고, 그건 `openai` 패키지를 import하는 것과 같은 범주다 — 원칙 2가
 * 막는 것은 *사용자의 워크스페이스*에 대한 직접 접근(파일·셸·자격증명)이다. 워크스페이스
 * 파일 내용은 언제나 `ToolBridge.readFile`(= Rust Tool Runtime)을 지나 이 모듈에 **인자로**
 * 들어온다. 그 사실을 검사로 지킨다(`test/symbols.test.ts`의 "grammar 경로는 워크스페이스에서
 * 오지 않는다").
 */

/** 우리가 grammar를 가진 파서 종류. 언어(`languageOf`)와 다르다 — `.tsx`는 별도 grammar다. */
export type GrammarId = "typescript" | "tsx" | "javascript" | "python" | "rust";

/** MVP 언어 범위 (9절) — 이 셋 밖은 `unsupported-language`이고 폴백은 ripgrep이다(5절). */
export const SUPPORTED_LANGUAGES = ["typescript", "javascript", "python", "rust"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * 확장자로 grammar를 고른다.
 *
 * `languageOf`는 `.ts`와 `.tsx`를 모두 `typescript`로 접는데, Tree-sitter는 둘을 **다른
 * grammar**로 다룬다(JSX 문법 때문이다). 여기서 접힌 것을 다시 편다 — 접힌 채로 `.tsx`를
 * typescript grammar에 넣으면 파일 전체가 `parse-failed`가 되고, 그 실패는 "이 파일에는
 * 심볼이 없다"처럼 보인다.
 */
export function grammarForPath(path: string): GrammarId | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".jsx")) return "tsx"; // JSX는 tsx grammar가 가장 넓게 받는다
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  return null;
}

/** grammar가 속한 언어 — 보고서(`SymbolIndexReport.languages`)는 언어 단위로 적는다. */
export function languageOfGrammar(grammar: GrammarId): SupportedLanguage {
  switch (grammar) {
    case "typescript":
    case "tsx":
      return "typescript";
    case "javascript":
      return "javascript";
    case "python":
      return "python";
    case "rust":
      return "rust";
  }
}

/**
 * Tree-sitter 노드 중 **우리가 쓰는 부분만.**
 *
 * `web-tree-sitter`의 타입을 그대로 흘려보내지 않는 이유: 이 인터페이스가 있으면 추출 로직
 * (`symbols.ts`)이 tree-sitter 없이도 테스트된다 — 파서가 없는 환경에서 폴백만 검사하는
 * 것과, 추출 규칙 자체를 검사하는 것은 다른 일이다.
 */
export interface SyntaxNode {
  readonly type: string;
  /**
   * 이 노드 아래 어딘가에 `ERROR`/`MISSING`이 있는가.
   *
   * **`Tree`가 아니라 `Node`의 속성이다.** web-tree-sitter의 `Tree`에는 이 이름이 없어서
   * `tree.hasError`는 조용히 `undefined`가 되고, 그러면 문법이 깨진 파일이 전부 `indexed`로
   * 기록된다 — 6.1절이 금지한 "낡은(그리고 틀린) 심볼"이 그 경로로 들어온다.
   */
  readonly hasError: boolean;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildren: (SyntaxNode | null)[];
  childForFieldName(field: string): SyntaxNode | null;
}

export interface ParsedTree {
  readonly rootNode: SyntaxNode;
}

export interface GrammarSet {
  /** `null`이면 이 grammar를 싣지 못했다 — 조용히 "심볼 없음"이 되지 않도록 상태로 구분한다. */
  parse(grammar: GrammarId, source: string): ParsedTree | null;
  /** grammar별 적재 결과. 실패는 사유와 함께 남는다(침묵 금지). */
  report(): SymbolIndexReport["languages"];
  /** 하나라도 실었는가. 전부 실패면 심볼 선정 자체를 만들지 않는다. */
  anyLoaded(): boolean;
}

/** grammar wasm 파일 이름. `tree-sitter-wasms` 패키지의 배치와 1:1이다. */
const WASM_BASENAME: Record<GrammarId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
};

/**
 * grammar wasm의 **절대 경로**.
 *
 * 워크스페이스가 아니라 우리 패키지에서 유도한다 — `import.meta.url` 기준 모듈 해석이므로
 * 사용자 입력이 이 값에 닿는 경로가 없다. 이 함수가 던지면 그 grammar는 `loaded=false`다.
 */
export function resolveGrammarPath(grammar: GrammarId): string {
  const require = createRequire(import.meta.url);
  return require.resolve(`tree-sitter-wasms/out/${WASM_BASENAME[grammar]}`);
}

/**
 * grammar를 적재한다. **실패해도 던지지 않는다** — 폴백(ripgrep)이 있으므로 태스크는 계속
 * 돌아야 하고, 대신 실패한 사실이 반환값에 남아 인덱스와 이벤트로 나간다.
 *
 * 적재는 프로세스당 한 번이다(모듈 스코프 캐시). 워크스페이스가 바뀌어도 grammar는 그대로다.
 */
let cached: Promise<GrammarSet> | null = null;

export function loadGrammars(): Promise<GrammarSet> {
  cached ??= buildGrammarSet();
  return cached;
}

/** 테스트가 적재 실패 경로를 만들 수 있어야 한다 — 캐시를 비운다. */
export function resetGrammarCacheForTest(): void {
  cached = null;
}

async function buildGrammarSet(): Promise<GrammarSet> {
  const languages = new Map<GrammarId, unknown>();
  const failures = new Map<SupportedLanguage, string>();

  let parserModule: {
    Parser: { init(): Promise<void>; new (): { setLanguage(l: unknown): void; parse(s: string): unknown } };
    Language: { load(input: string): Promise<unknown> };
  };
  try {
    // **동적 import다.** 의존성이 없거나 wasm 런타임이 없는 환경에서 sidecar 자체가 뜨지
    // 못하면 안 된다 — 심볼 인덱스는 있으면 좋은 층이지 프로세스의 전제가 아니다.
    parserModule = (await import("web-tree-sitter")) as unknown as typeof parserModule;
    await parserModule.Parser.init();
  } catch (error) {
    const reason = `web-tree-sitter를 초기화하지 못했습니다: ${describe(error)}`;
    for (const language of SUPPORTED_LANGUAGES) failures.set(language, reason);
    return makeSet(languages, failures, null);
  }

  for (const grammar of Object.keys(WASM_BASENAME) as GrammarId[]) {
    try {
      languages.set(grammar, await parserModule.Language.load(resolveGrammarPath(grammar)));
    } catch (error) {
      const language = languageOfGrammar(grammar);
      // 같은 언어의 grammar가 둘(typescript/tsx)이면 **처음 실패한 사유를 남긴다.**
      if (!failures.has(language)) failures.set(language, `${grammar}: ${describe(error)}`);
    }
  }

  return makeSet(languages, failures, parserModule);
}

function makeSet(
  languages: Map<GrammarId, unknown>,
  failures: Map<SupportedLanguage, string>,
  parserModule: { Parser: new () => { setLanguage(l: unknown): void; parse(s: string): unknown } } | null
): GrammarSet {
  return {
    parse(grammar, source) {
      const language = languages.get(grammar);
      if (!language || !parserModule) return null;
      const parser = new parserModule.Parser();
      parser.setLanguage(language);
      const tree = parser.parse(source) as ParsedTree | null;
      if (!tree) return null;
      return tree;
    },
    report() {
      return SUPPORTED_LANGUAGES.map((language) => {
        const failure = failures.get(language);
        return failure === undefined
          ? { language, loaded: true }
          : { language, loaded: false, error: failure };
      });
    },
    anyLoaded() {
      return languages.size > 0;
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // web-tree-sitter의 wasm 적재 실패는 message가 빈 `Error`로 온다 — 빈 문자열을 그대로
    // 흘리면 "실패했다"만 남고 무엇이 실패했는지가 사라진다.
    return error.message.trim() === "" ? `${error.name}(메시지 없음)` : error.message;
  }
  return String(error);
}
