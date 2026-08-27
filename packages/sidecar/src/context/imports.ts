import type { RawImport } from "./symbols.js";

/**
 * import 지정자 → **워크스페이스 안의 파일 경로** — docs/design/context-engine.md 5·16절.
 *
 * # 왜 `node:path`를 쓰지 않는가
 *
 * 워크스페이스 경로는 Rust가 항상 `/`로 정규화해서 준다(`to_forward_slashes`). 그런데
 * `node:path`는 **실행 중인 OS의 구분자**만 알기 때문에, Windows에서 `path.join("src", "a")`는
 * `src\a`를 만들어 파일 트리의 `src/a`와 맞지 않는다. CLAUDE.md에 이미 이 함정이 기록돼
 * 있고(`.exe` 결함이 그래서 살아남았다), 여기는 같은 실수가 **조용히** 나타나는 자리다 —
 * 경로가 어긋나면 엣지가 0개가 되고, 0개인 그래프는 "이 파일은 아무것도 import하지 않는다"로
 * 읽힌다. 그래서 POSIX 규칙을 직접 구현한다.
 *
 * # 못 맞추면 엣지를 만들지 않는다
 *
 * 후보가 여럿이면(파이썬의 절대 import가 그렇다) **아무것도 고르지 않는다.** 추측한 엣지는
 * 없는 엣지보다 나쁘다 — 선정이 엉뚱한 파일을 컨텍스트에 넣고, 그 실패는 "모델이 잘못했다"로
 * 보인다(13.1절과 같은 종류의 오해).
 *
 * # 범위 밖인 것
 *
 * - **bare 지정자**(`react`, `@tomverse/protocol`, `std::fmt`): 워크스페이스 패키지 해석은
 *   package.json workspaces·tsconfig paths·Cargo 워크스페이스를 읽어야 하고, 그건 5절이 정한
 *   "import/require 파싱으로 파일 단위 엣지" 범위 밖이다. 16절 "아직 하지 않은 것"에 적었다.
 */

export interface ResolveInput {
  /** import를 적은 파일 (워크스페이스 상대, `/` 구분자) */
  fromPath: string;
  language: string;
  specifier: string;
  kind: RawImport["kind"];
  /** 인덱스에 있는 경로 전부. **여기 없는 파일로는 엣지를 만들지 않는다**(7절 제외 규칙 유지). */
  paths: ReadonlySet<string>;
}

export function resolveImport(input: ResolveInput): string | null {
  switch (input.language) {
    case "typescript":
    case "javascript":
      return resolveJs(input);
    case "python":
      return resolvePython(input);
    case "rust":
      return resolveRust(input);
    default:
      return null;
  }
}

// ---- POSIX 경로 (node:path를 쓰지 않는 이유는 위 주석) ----

export function dirnamePosix(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function basenamePosix(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** `a/b` + `../c` → `a/c`. 루트 위로 올라가면 `null`(워크스페이스 밖이다). */
export function joinPosix(base: string, relative: string): string | null {
  const segments = base === "" ? [] : base.split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

// ---- JavaScript / TypeScript ----

/**
 * TS 소스는 `./x.js`라고 쓰고 실제 파일은 `x.ts`다(NodeNext). 그래서 확장자를 **바꿔서도**
 * 찾아야 한다 — 이 저장소 자신이 그 표기를 쓰므로, 안 하면 우리 코드베이스에서 엣지가
 * 거의 하나도 생기지 않는다.
 */
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const JS_REWRITES: [RegExp, string[]][] = [
  [/\.js$/, [".ts", ".tsx", ".js"]],
  [/\.mjs$/, [".mts", ".mjs"]],
  [/\.cjs$/, [".cts", ".cjs"]],
  [/\.jsx$/, [".tsx", ".jsx"]],
];

function resolveJs(input: ResolveInput): string | null {
  const { specifier, paths } = input;
  // bare 지정자(`react`, `node:fs`, `@scope/pkg`)는 파일이 아니다 — 범위 밖.
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const base = dirnamePosix(input.fromPath);
  const joined = joinPosix(base, specifier.replace(/^\//, ""));
  if (joined === null) return null;

  const candidates: string[] = [joined];
  for (const [pattern, replacements] of JS_REWRITES) {
    if (!pattern.test(joined)) continue;
    for (const replacement of replacements) candidates.push(joined.replace(pattern, replacement));
  }
  for (const extension of JS_EXTENSIONS) candidates.push(`${joined}${extension}`);
  for (const extension of JS_EXTENSIONS) candidates.push(`${joined}/index${extension}`);

  return firstExisting(candidates, paths);
}

// ---- Python ----

function resolvePython(input: ResolveInput): string | null {
  const { specifier, paths } = input;
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;

  if (leadingDots > 0) {
    // `.mod` = 같은 디렉터리, `..mod` = 한 단계 위. 점 하나가 "현재"이므로 올라가는 횟수는
    // `leadingDots - 1`이다.
    let base: string | null = dirnamePosix(input.fromPath);
    for (let up = 1; up < leadingDots; up += 1) {
      base = base === null ? null : joinPosix(base, "..");
    }
    if (base === null) return null;
    const rest = specifier.slice(leadingDots);
    const joined = rest === "" ? base : joinPosix(base, rest.split(".").join("/"));
    if (joined === null) return null;
    return firstExisting([`${joined}.py`, `${joined}/__init__.py`, `${joined}.pyi`], paths);
  }

  // 절대 import. 어디가 sys.path 루트인지 우리는 모르므로 **꼬리 일치**로 찾고,
  // 후보가 여럿이면 고르지 않는다.
  const tail = specifier.split(".").join("/");
  const suffixes = [`${tail}.py`, `${tail}/__init__.py`];
  const matches = new Set<string>();
  for (const path of paths) {
    for (const suffix of suffixes) {
      if (path === suffix || path.endsWith(`/${suffix}`)) matches.add(path);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

// ---- Rust ----

const RUST_MODULE_FILES = ["mod.rs", "lib.rs", "main.rs"];

/** 이 파일의 **하위 모듈이 사는 디렉터리**. `mod.rs`는 자기 디렉터리, 그 밖은 파일명 디렉터리. */
export function rustChildrenDir(fromPath: string): string {
  const dir = dirnamePosix(fromPath);
  const base = basenamePosix(fromPath);
  if (RUST_MODULE_FILES.includes(base)) return dir;
  return dir === "" ? base.replace(/\.rs$/, "") : `${dir}/${base.replace(/\.rs$/, "")}`;
}

/** `super::`가 가리키는 디렉터리. `mod.rs`면 한 단계 위, 그 밖은 자기 디렉터리. */
export function rustSuperDir(fromPath: string): string | null {
  const dir = dirnamePosix(fromPath);
  const base = basenamePosix(fromPath);
  return RUST_MODULE_FILES.includes(base) ? joinPosix(dir, "..") : dir;
}

/**
 * 크레이트 루트 디렉터리 = 이 파일을 감싸는 가장 안쪽 `src/`.
 *
 * Cargo.toml을 읽어 `[lib] path`를 보는 쪽이 정확하지만, 그건 워크스페이스 매니페스트 해석
 * (범위 밖)이고 관례에서 벗어난 배치는 드물다. 못 찾으면 `null`이고, 그때는 엣지를 만들지
 * 않는다 — 틀린 엣지보다 없는 엣지가 낫다.
 */
export function rustCrateRoot(fromPath: string): string | null {
  const segments = fromPath.split("/");
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i] === "src") return segments.slice(0, i + 1).join("/");
  }
  return null;
}

function resolveRust(input: ResolveInput): string | null {
  const { specifier, paths } = input;

  // `mod x;` — 다른 파일을 이 모듈 트리에 끌어들인다.
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice("mod:".length);
    const dir = rustChildrenDir(input.fromPath);
    return firstExisting([`${dir}/${name}.rs`, `${dir}/${name}/mod.rs`], paths);
  }

  const segments = specifier.split("::").map((s) => s.trim()).filter((s) => s !== "");
  const head = segments[0];
  if (head === undefined) return null;

  let base: string | null;
  if (head === "crate") base = rustCrateRoot(input.fromPath);
  else if (head === "self") base = rustChildrenDir(input.fromPath);
  else if (head === "super") base = rustSuperDir(input.fromPath);
  // `std::`, 외부 크레이트 — 워크스페이스 파일이 아니다.
  else return null;
  if (base === null) return null;

  // `crate::a::b::C`에서 어디까지가 모듈이고 어디부터가 항목인지 우리는 모른다.
  // **긴 쪽부터** 실제 파일이 있는지 보고 첫 번째를 쓴다.
  const rest = segments.slice(1);
  for (let take = rest.length; take >= 1; take -= 1) {
    const prefix = rest.slice(0, take).join("/");
    const hit = firstExisting([`${base}/${prefix}.rs`, `${base}/${prefix}/mod.rs`], paths);
    if (hit) return hit;
  }
  return null;
}

function firstExisting(candidates: readonly string[], paths: ReadonlySet<string>): string | null {
  for (const candidate of candidates) {
    if (candidate !== "" && paths.has(candidate)) return candidate;
  }
  return null;
}
