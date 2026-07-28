/**
 * 하드 제외 규칙 — docs/design/context-engine.md 7절.
 *
 * "시크릿·대용량·바이너리 파일은 애초에 인덱스에 들어가지 않는다 — 이후 유출 여부를 반복
 * 체크하는 게 아니라 진입 자체를 막는다."
 *
 * `.gitignore` 준수는 Rust의 `list_files`가 처리한다(ignore 크레이트). 여기서는 그것만으로
 * 부족한 것 — git이 추적하고 있는 secret 파일, 바이너리, 대용량 — 을 막는다.
 *
 * **Rust에 같은 성질의 목록이 따로 있다**(`apps/desktop/src-tauri/core/src/policy/secrets.rs`).
 * 중복이 아니라 독립 검증이다: 여기 있는 필터는 Node가 스스로 지키는 규칙이고, Node가 장악당하면
 * 우회할 수 있다. 그래서 Rust가 도구 요청 시점에 한 번 더 판정한다
 * (state-machine-and-protocol.md 16.7절). **한쪽을 고칠 때 다른 쪽도 함께 볼 것.**
 */

/** 기본 500KB 초과 파일은 인덱싱하지 않는다 (7절). */
export const MAX_INDEXED_FILE_BYTES = 500 * 1024;

/**
 * 시크릿 패턴. 워크스페이스 정책으로 확장 가능해야 하므로 목록을 상수로 노출한다.
 *
 * `.env.example`을 제외 대상에서 빼지 않은 이유: 이름만으로 "예시 파일이므로 안전"을
 * 판정할 수 없고(실제로 키를 적어두는 경우가 흔하다), 컨텍스트에 없어서 잃는 것보다
 * 잘못 보내서 잃는 것이 크다.
 */
export const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.envrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /(^|\/)id_dsa/i,
  /(^|\/)credentials(\.json|\.yml|\.yaml)?$/i,
  // 접두사가 붙은 형태(`gcp-service-account-prod.json`)도 잡아야 한다 — 실제로 흔한 이름이다.
  /service[-_]account.*\.json$/i,
  /(^|[-_.])gcp[-_]key.*\.json$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|ini)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
];

/**
 * `.gitignore`에 없어도 항상 제외하는 디렉터리 (7절 하드코딩 기본 목록).
 * 언어별 빌드 산출물 관례를 포함한다.
 */
export const EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  "vendor",
  "coverage",
  ".tomverse",
];

/** 텍스트로 취급하지 않는 확장자 — Rust의 NUL 바이트 휴리스틱보다 먼저 걸러 읽기 자체를 아낀다. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff",
  "pdf", "zip", "gz", "tar", "bz2", "xz", "7z", "rar",
  "exe", "dll", "so", "dylib", "pdb", "lib", "a", "o", "obj",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "avi", "mov", "webm", "flac", "ogg",
  "class", "jar", "pyc", "pyo", "wasm", "node",
  "sqlite", "db", "bin", "dat", "lock",
]);

export interface ExclusionResult {
  excluded: boolean;
  reason?: string;
}

export function classifyFile(path: string, sizeBytes: number): ExclusionResult {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");

  for (const dir of EXCLUDED_DIRECTORIES) {
    if (segments.slice(0, -1).includes(dir)) {
      return { excluded: true, reason: `제외 디렉터리 "${dir}" 하위` };
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(normalized)) {
      return { excluded: true, reason: "시크릿 패턴에 일치 — 모델 컨텍스트에서 제외됨" };
    }
  }

  const ext = extensionOf(normalized);
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return { excluded: true, reason: `바이너리 확장자 ".${ext}"` };
  }

  if (sizeBytes > MAX_INDEXED_FILE_BYTES) {
    return {
      excluded: true,
      // 7절: mentioned로 명시 지목되어도 제외하고, 그 사실을 사용자에게 알린다.
      reason: `파일이 너무 큼 (${Math.round(sizeBytes / 1024)}KB > ${MAX_INDEXED_FILE_BYTES / 1024}KB) — 컨텍스트에 포함할 수 없음`,
    };
  }

  return { excluded: false };
}

export function extensionOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return null;
  return base.slice(idx + 1).toLowerCase();
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  cs: "csharp",
  fs: "fsharp",
  rb: "ruby",
  php: "php",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  html: "html",
  css: "css",
  scss: "css",
  sql: "sql",
};

export function languageOf(path: string): string | null {
  const ext = extensionOf(path);
  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? null) : null;
}
