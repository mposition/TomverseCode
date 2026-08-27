import type { DependencyEdge, SymbolEntry } from "@tomverse/protocol";
import type { GrammarId, ParsedTree, SyntaxNode } from "./treeSitter.js";

/**
 * Tree-sitter 구문 트리 → 심볼/의존성 — docs/design/context-engine.md 5·16절.
 *
 * # 범위는 5절이 못박았다. 넓히지 않는다
 *
 * - 심볼: 함수/클래스/메서드/인터페이스/타입/최상위 const/export 선언까지.
 *   **변수 스코프 안까지 들어가는 완전한 call graph는 MVP 범위 밖이다.**
 * - 의존성: import/require **파일 단위 엣지**만. 심볼 단위 call graph는 범위 밖.
 *
 * 이 범위를 코드로 강제하는 장치가 "투명 노드" 목록이다. 트리 전체를 훑지 않고 **최상위와
 * 컨테이너 본문(class body, impl body)만** 내려간다 — 함수 본문 안에 선언된 함수는 잡히지
 * 않고, 그건 결함이 아니라 5절이 정한 경계다. 전체 훑기로 바꾸면 범위가 조용히 넓어지고
 * 인덱스 크기와 시간도 함께 넓어진다.
 *
 * # kind는 프로토콜의 7종으로 정규화한다
 *
 * `SymbolEntry.kind`는 닫힌 집합(`function|class|method|interface|type|const|export`)이다.
 * 언어마다 그것과 딱 맞는 개념이 있지는 않으므로 아래처럼 접는다 — **접는 규칙을 여기 한
 * 곳에만 둔다.** 언어별로 흩어지면 화면에 `class`로 나온 것이 무엇이었는지 말할 수 없게 된다.
 *
 * | 언어 | 원래 | kind | 왜 |
 * |---|---|---|---|
 * | TS | `enum` | `type` | 값이자 타입이지만 선정에서 하는 일은 타입 선언과 같다 |
 * | TS | `export {x} from`, `export *` | `export` | **지역 선언이 없다** — 재수출은 "여기서 이름을 다시 내보낸다"는 사실이고, 그 사실이 곧 파일을 고를 근거다 |
 * | Rust | `struct`/`enum`/`union` | `class` | 이름 붙은 데이터 타입 |
 * | Rust | `trait` | `interface` | Rust의 인터페이스 |
 * | Rust | `static` | `const` | 최상위 이름 붙은 값 |
 * | Py | 최상위/클래스 본문 대입 | `const` | 파이썬에 const는 없지만 "최상위 이름 붙은 값"이라는 자리는 같다 |
 */

/** 한 파일에서 뽑아낸 것. `imports`는 아직 **해석되지 않은** 지정자다(파일 경로가 아니다). */
export interface ExtractedFile {
  symbols: SymbolEntry[];
  imports: RawImport[];
}

export interface RawImport {
  /** 소스에 적힌 그대로. `./x.js`, `crate::a::b`, `.pkg.mod` 등. */
  specifier: string;
  kind: DependencyEdge["kind"];
}

/**
 * 파일 하나의 구문 트리에서 심볼과 import를 뽑는다.
 *
 * **파싱 실패는 여기서 다루지 않는다.** `tree.hasError`의 처리 규칙(6.1절 — 심볼을 잃되
 * 파일은 남는다)은 인덱스를 만드는 쪽의 결정이므로 `engine.ts`가 판정한다. 여기까지 온
 * 트리는 "쓸 수 있다고 판정된 트리"다.
 */
export function extractFromTree(input: {
  path: string;
  language: string;
  grammar: GrammarId;
  tree: ParsedTree;
}): ExtractedFile {
  const out: ExtractedFile = { symbols: [], imports: [] };
  const ctx: Ctx = { ...input, out, seq: 0 };
  const children = named(input.tree.rootNode);
  switch (input.grammar) {
    case "typescript":
    case "tsx":
    case "javascript":
      for (const child of children) visitJs(child, ctx, null);
      break;
    case "python":
      for (const child of children) visitPython(child, ctx, null);
      break;
    case "rust":
      for (const child of children) visitRust(child, ctx, null);
      break;
  }
  return out;
}

interface Ctx {
  path: string;
  language: string;
  grammar: GrammarId;
  out: ExtractedFile;
  /** id 충돌 방지용 일련번호. 같은 줄에 같은 이름이 둘 있을 수 있다(오버로드 시그니처). */
  seq: number;
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((n): n is SyntaxNode => n !== null);
}

function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

function record(ctx: Ctx, node: SyntaxNode, name: string, kind: SymbolEntry["kind"]): void {
  if (name.trim() === "") return;
  ctx.seq += 1;
  ctx.out.symbols.push({
    id: `${ctx.path}#${kind}:${name}@${node.startPosition.row + 1}.${ctx.seq}`,
    name,
    kind,
    filePath: ctx.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    language: ctx.language,
  });
}

function addImport(ctx: Ctx, specifier: string, kind: DependencyEdge["kind"]): void {
  const trimmed = specifier.trim();
  if (trimmed === "") return;
  ctx.out.imports.push({ specifier: trimmed, kind });
}

/** `"./x.js"` → `./x.js`. Tree-sitter의 string 노드는 따옴표를 포함한다. */
function unquote(text: string): string {
  return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

// ---- JavaScript / TypeScript ----

/**
 * `container`는 **지금 어느 심볼 안에 있는가**다. `null`이면 최상위.
 *
 * 이 값이 5절의 범위를 강제한다: 클래스 본문(`container === "class"`)까지만 내려가고 함수
 * 본문에는 들어가지 않으므로, 지역 함수와 지역 const는 심볼이 되지 않는다.
 */
function visitJs(node: SyntaxNode, ctx: Ctx, container: "class" | null): void {
  switch (node.type) {
    case "export_statement": {
      const declaration = field(node, "declaration");
      if (declaration) {
        visitJs(declaration, ctx, container);
        return;
      }
      // 선언이 없는 export = 재수출이거나 `export default <식>`.
      const source = field(node, "source");
      if (source) addImport(ctx, unquote(source.text), "import");
      recordReExport(node, ctx);
      return;
    }
    // `declare module "x" { ... }` 같은 앰비언트 블록 — 껍데기이므로 통과시킨다.
    case "ambient_declaration":
    case "internal_module":
    case "module":
      for (const child of named(node)) visitJs(child, ctx, container);
      return;

    case "import_statement": {
      const source = field(node, "source");
      if (source) addImport(ctx, unquote(source.text), "import");
      return;
    }

    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, container === "class" ? "method" : "function");
      return;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "class");
      const body = field(node, "body");
      // **클래스 본문까지만 내려간다.** 메서드 본문 안은 5절 범위 밖이다.
      if (body) for (const member of named(body)) visitJs(member, ctx, "class");
      return;
    }

    case "method_definition":
    case "method_signature": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "method");
      return;
    }

    case "interface_declaration": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "interface");
      return;
    }

    case "type_alias_declaration":
    case "enum_declaration": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "type");
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      for (const declarator of named(node)) {
        if (declarator.type !== "variable_declarator") continue;
        const name = field(declarator, "name");
        // 구조 분해(`const { a, b } = x`)는 이름이 하나가 아니므로 심볼로 만들지 않는다 —
        // 억지로 만들면 "이 파일이 `a`를 정의한다"는 틀린 근거가 생긴다.
        if (name && name.type === "identifier") record(ctx, node, name.text, "const");
      }
      // `const x = require("./y")` — CJS는 지금도 쓰인다.
      collectRequires(node, ctx, 0);
      return;
    }

    default:
      // 최상위의 나머지 문장에서도 `require(...)`는 나올 수 있다.
      collectRequires(node, ctx, 0);
  }
}

/**
 * `export { a as b } from "./x"` / `export * from "./x"` / `export default …`.
 *
 * 지역 선언이 없으므로 위 분기들이 아무 심볼도 만들지 않는데, **이름은 여기 있다.**
 * 재수출된 이름으로 파일을 고르는 것은 실제로 흔한 경로다(배럴 파일).
 */
function recordReExport(node: SyntaxNode, ctx: Ctx): void {
  let recorded = false;
  for (const child of named(node)) {
    if (child.type !== "export_clause") continue;
    for (const specifier of named(child)) {
      if (specifier.type !== "export_specifier") continue;
      const alias = field(specifier, "alias");
      const name = alias ?? field(specifier, "name");
      if (name) {
        record(ctx, node, name.text, "export");
        recorded = true;
      }
    }
  }
  if (recorded) return;
  // `export * from "./x"`처럼 이름이 없으면 무엇을 내보내는지 우리가 모른다. 이름을
  // 지어내지 않고(`*`는 식별자가 아니다) 아무것도 남기지 않는다 — 엣지는 이미 남았다.
}

/**
 * `require("...")`를 **깊이 제한**을 두고 찾는다.
 *
 * 제한을 두는 이유는 5절의 범위다. 함수 본문 깊숙한 곳의 조건부 require까지 쫓으면 그건
 * 사실상 전체 트리 훑기이고, 파일 단위 엣지 하나를 더 얻자고 파싱 비용을 배로 만든다.
 * 실제 CJS 모듈의 최상위 `const x = require(...)`는 깊이 3 안에 있다.
 */
function collectRequires(node: SyntaxNode, ctx: Ctx, depth: number): void {
  if (depth > 4) return;
  if (node.type === "call_expression") {
    const callee = field(node, "function");
    const args = field(node, "arguments");
    if (callee && callee.text === "require" && args) {
      const first = named(args)[0];
      if (first && first.type === "string") addImport(ctx, unquote(first.text), "require");
    }
  }
  for (const child of named(node)) collectRequires(child, ctx, depth + 1);
}

// ---- Python ----

function visitPython(node: SyntaxNode, ctx: Ctx, container: "class" | null): void {
  switch (node.type) {
    case "import_statement": {
      for (const child of named(node)) {
        const target = child.type === "aliased_import" ? field(child, "name") : child;
        if (target) addImport(ctx, target.text, "import");
      }
      return;
    }
    case "import_from_statement": {
      const module = field(node, "module_name");
      if (module) addImport(ctx, module.text, "import");
      return;
    }
    case "decorated_definition": {
      const definition = field(node, "definition");
      if (definition) visitPython(definition, ctx, container);
      return;
    }
    case "function_definition": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, container === "class" ? "method" : "function");
      return;
    }
    case "class_definition": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "class");
      const body = field(node, "body");
      if (body) for (const member of named(body)) visitPython(member, ctx, "class");
      return;
    }
    case "expression_statement": {
      for (const child of named(node)) {
        if (child.type !== "assignment") continue;
        const left = field(child, "left");
        if (left && left.type === "identifier") record(ctx, child, left.text, "const");
      }
      return;
    }
    default:
      return;
  }
}

// ---- Rust ----

function visitRust(node: SyntaxNode, ctx: Ctx, container: "impl" | "trait" | null): void {
  switch (node.type) {
    case "use_declaration": {
      const argument = field(node, "argument");
      if (argument) addImport(ctx, rustUsePrefix(argument.text), "import");
      return;
    }
    case "mod_item": {
      const body = field(node, "body");
      if (body) {
        // 인라인 모듈(`mod tests { … }`)은 **같은 파일**이다. 껍데기로 보고 안으로 내려간다 —
        // `#[cfg(test)] mod tests`가 이 저장소에 흔하고, 그 안의 테스트 함수는 실제 심볼이다.
        for (const child of named(body)) visitRust(child, ctx, container);
        return;
      }
      // 본문 없는 `mod x;`는 **다른 파일을 이 모듈 트리에 끌어들인다.** import가 아니라
      // 파일 편입이므로 `reference`로 적는다 — 프로토콜의 세 종류 중 이 자리에 맞는 것이다.
      const name = field(node, "name");
      if (name) addImport(ctx, `mod:${name.text}`, "reference");
      return;
    }
    case "function_item":
    case "function_signature_item": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, container === null ? "function" : "method");
      return;
    }
    case "struct_item":
    case "enum_item":
    case "union_item": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "class");
      return;
    }
    case "trait_item": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "interface");
      const body = field(node, "body");
      if (body) for (const child of named(body)) visitRust(child, ctx, "trait");
      return;
    }
    case "impl_item": {
      const body = field(node, "body");
      if (body) for (const child of named(body)) visitRust(child, ctx, "impl");
      return;
    }
    case "type_item": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "type");
      return;
    }
    case "const_item":
    case "static_item": {
      const name = field(node, "name");
      if (name) record(ctx, node, name.text, "const");
      return;
    }
    // `#[cfg(…)]`가 붙은 항목은 attribute_item과 별도 노드로 나오므로 여기서 할 일이 없다.
    default:
      return;
  }
}

/**
 * `crate::a::{b, c}` → `crate::a`, `crate::a::b as d` → `crate::a::b`.
 *
 * **가장 긴 확실한 경로만 남긴다.** 중괄호 안쪽은 항목일 수도 하위 모듈일 수도 있어서
 * 우리가 판정할 수 없고, 판정할 수 없는 것을 붙이면 없는 파일을 가리키는 엣지가 생긴다.
 */
export function rustUsePrefix(text: string): string {
  const withoutBrace = text.split("{")[0] ?? text;
  const withoutAlias = withoutBrace.split(/\s+as\s+/)[0] ?? withoutBrace;
  return withoutAlias.trim().replace(/::\s*$/, "");
}
