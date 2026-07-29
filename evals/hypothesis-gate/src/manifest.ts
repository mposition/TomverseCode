import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  FIXTURE_CATEGORIES,
  FIXTURE_LANGUAGES,
  type CommandArgv,
  type FixtureCategory,
  type FixtureLanguage,
  type FixtureManifest,
} from "./types.js";

/**
 * fixture manifest 로딩과 검증.
 *
 * # 하네스가 파일 시스템을 직접 만지는 것에 대해
 *
 * 제품에서는 Node가 파일에 직접 접근하지 않는다(process-architecture.md 2절). 그러나 이
 * 하네스는 **제품이 아니라 측정 도구**다 — `packages/sidecar/test/helpers/fixtureRepo.ts`가
 * 이미 같은 예외를 쓰고 있고 같은 근거다: 테스트 환경을 준비하는 것은 Rust의 역할이 아니라
 * 실험자의 역할이다. 중요한 것은 **측정 대상인 실행 경로**가 신뢰 경계를 그대로 지나는 것이고,
 * 그건 `host.ts`가 `tomverse-host`를 그대로 부르는 방식으로 보장된다.
 */

export interface LoadedFixture {
  manifest: FixtureManifest;
  /** fixture 디렉터리 절대 경로 */
  dir: string;
  /** 모델이 보게 될 원본 workspace 디렉터리 */
  workspaceDir: string;
  /** oracle 검증 파일 디렉터리 — workspace에 복사되지 않는다 */
  oracleDir: string;
  /** fixture가 풀 수 있음을 증명하는 참조 patch */
  referencePatchPath: string;
  /**
   * 내용 해시. arm/반복 간에 **같은 최초 상태**였음을 증명한다.
   * 파일 timestamp가 아니라 내용으로 계산한다 — timestamp는 체크아웃마다 달라진다.
   */
  fixtureHash: string;
}

export class FixtureError extends Error {
  constructor(fixtureId: string, message: string) {
    super(`fixture ${fixtureId}: ${message}`);
    this.name = "FixtureError";
  }
}

function requireString(value: unknown, label: string, fixtureId: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FixtureError(fixtureId, `${label}가 비어 있거나 문자열이 아닙니다`);
  }
  return value;
}

function parseCommand(raw: unknown, label: string, fixtureId: string): CommandArgv {
  if (typeof raw !== "object" || raw === null) {
    throw new FixtureError(fixtureId, `${label}가 객체가 아닙니다`);
  }
  const o = raw as Record<string, unknown>;
  const program = requireString(o.program, `${label}.program`, fixtureId);
  if (!Array.isArray(o.args) || o.args.some((a) => typeof a !== "string")) {
    throw new FixtureError(fixtureId, `${label}.args가 문자열 배열이 아닙니다`);
  }
  // 셸 문자열을 argv로 위장하는 것을 막는다 — 제품의 argv 계약과 같은 규율을 하네스도 지킨다.
  for (const arg of o.args as string[]) {
    if (/[;&|><`$]/.test(arg) && !arg.startsWith("--")) {
      throw new FixtureError(
        fixtureId,
        `${label}.args에 셸 메타문자가 있습니다 (${arg}) — 하네스도 argv만 실행합니다`
      );
    }
  }
  const cwd = o.cwd === undefined ? undefined : requireString(o.cwd, `${label}.cwd`, fixtureId);
  if (cwd && (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes(".."))) {
    throw new FixtureError(fixtureId, `${label}.cwd는 workspace 상대 경로여야 합니다: ${cwd}`);
  }
  return cwd === undefined ? { program, args: o.args as string[] } : { program, args: o.args as string[], cwd };
}

export function parseManifest(raw: unknown, fixtureId: string): FixtureManifest {
  if (typeof raw !== "object" || raw === null) throw new FixtureError(fixtureId, "manifest가 객체가 아닙니다");
  const o = raw as Record<string, unknown>;

  const declaredId = requireString(o.fixtureId, "fixtureId", fixtureId);
  if (declaredId !== fixtureId) {
    throw new FixtureError(fixtureId, `manifest의 fixtureId(${declaredId})가 디렉터리 이름과 다릅니다`);
  }

  const category = requireString(o.category, "category", fixtureId);
  if (!(FIXTURE_CATEGORIES as readonly string[]).includes(category)) {
    throw new FixtureError(fixtureId, `알 수 없는 category: ${category}`);
  }
  const language = requireString(o.language, "language", fixtureId);
  if (!(FIXTURE_LANGUAGES as readonly string[]).includes(language)) {
    throw new FixtureError(fixtureId, `알 수 없는 language: ${language}`);
  }

  if (!Array.isArray(o.publicVerificationCommands) || o.publicVerificationCommands.length === 0) {
    throw new FixtureError(fixtureId, "publicVerificationCommands가 최소 1개 필요합니다");
  }
  if (!Array.isArray(o.oracleVerificationCommands) || o.oracleVerificationCommands.length === 0) {
    throw new FixtureError(fixtureId, "oracleVerificationCommands가 최소 1개 필요합니다");
  }
  if (!Array.isArray(o.forbiddenPaths) || o.forbiddenPaths.some((p) => typeof p !== "string")) {
    throw new FixtureError(fixtureId, "forbiddenPaths가 문자열 배열이 아닙니다");
  }
  if (typeof o.timeoutMs !== "number" || !Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) {
    throw new FixtureError(fixtureId, "timeoutMs가 양의 유한수가 아닙니다");
  }

  const manifest: FixtureManifest = {
    fixtureId: declaredId,
    category: category as FixtureCategory,
    language: language as FixtureLanguage,
    taskPrompt: requireString(o.taskPrompt, "taskPrompt", fixtureId),
    publicVerificationCommands: o.publicVerificationCommands.map((c, i) =>
      parseCommand(c, `publicVerificationCommands[${i}]`, fixtureId)
    ),
    oracleVerificationCommands: o.oracleVerificationCommands.map((c, i) =>
      parseCommand(c, `oracleVerificationCommands[${i}]`, fixtureId)
    ),
    forbiddenPaths: o.forbiddenPaths as string[],
    expectedInvariant: requireString(o.expectedInvariant, "expectedInvariant", fixtureId),
    timeoutMs: o.timeoutMs,
  };
  if (o.setupCommand !== undefined) {
    manifest.setupCommand = parseCommand(o.setupCommand, "setupCommand", fixtureId);
  }
  return manifest;
}

/**
 * 디렉터리 내용의 결정론적 해시.
 *
 * 정렬된 상대 경로 + 내용만 넣는다. mtime/권한을 넣으면 체크아웃마다 값이 달라져
 * "arm 간 같은 최초 상태였는가"를 확인하는 데 쓸 수 없다.
 */
export function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(abs, rel);
      } else if (entry.isFile()) {
        hash.update(`F:${rel}\n`);
        hash.update(readFileSync(abs));
        hash.update("\n");
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex").slice(0, 16);
}

export function loadFixture(fixturesRoot: string, fixtureId: string): LoadedFixture {
  const dir = path.join(fixturesRoot, fixtureId);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new FixtureError(fixtureId, `manifest.json이 없습니다: ${manifestPath}`);

  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")), fixtureId);

  const workspaceDir = path.join(dir, "workspace");
  const oracleDir = path.join(dir, "oracle");
  const referencePatchPath = path.join(dir, "reference.patch");

  for (const [label, p] of [
    ["workspace/", workspaceDir],
    ["oracle/", oracleDir],
    ["reference.patch", referencePatchPath],
  ] as const) {
    if (!existsSync(p)) throw new FixtureError(fixtureId, `${label}가 없습니다`);
  }
  if (!statSync(workspaceDir).isDirectory()) throw new FixtureError(fixtureId, "workspace/가 디렉터리가 아닙니다");
  if (!statSync(oracleDir).isDirectory()) throw new FixtureError(fixtureId, "oracle/가 디렉터리가 아닙니다");

  // **핵심 불변식: oracle 파일이 workspace 안에 있으면 모델이 정답을 볼 수 있다.**
  // 이건 fixture 작성 실수로 아주 쉽게 일어나므로 로딩 단계에서 막는다.
  //
  // **파일 단위로** 비교한다: Rust fixture는 `tests/` 디렉터리를 양쪽이 쓰지만
  // `tests/public.rs`(공개)와 `tests/oracle.rs`(정답)는 서로 다른 파일이다.
  // 디렉터리 이름만 보면 정상 구성을 오탐한다.
  for (const rel of relativeFiles(oracleDir)) {
    if (existsSync(path.join(workspaceDir, rel))) {
      throw new FixtureError(
        fixtureId,
        `oracle 파일 ${rel}이 workspace/에도 있습니다 — 모델이 정답 테스트를 볼 수 있게 됩니다`
      );
    }
  }

  return {
    manifest,
    dir,
    workspaceDir,
    oracleDir,
    referencePatchPath,
    fixtureHash: hashDirectory(workspaceDir),
  };
}

/** 디렉터리 안의 모든 파일을 루트 기준 상대 경로로 나열한다. */
function relativeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...relativeFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * fixture 목록.
 *
 * **디렉터리가 없으면 빈 배열이 아니라 예외다.** 예전에는 `[]`를 돌려줬는데, 그러면 경로가
 * 잘못됐을 때 "fixture 0개"로 조용히 진행하고 그 위의 검사들이 빈 집합에 대해 통과해 버린다.
 * 실측으로 이렇게 걸렸다 — Windows에서 `new URL(import.meta.url).pathname`이
 * `/C:/...`를 주는 바람에 fixture 경로가 깨졌고, 테스트 5개가 서로 무관해 보이는 실패로
 * 나타났다. 존재하지 않는 경로와 비어 있는 디렉터리는 다른 사실이므로 다르게 보고한다.
 */
export function listFixtureIds(fixturesRoot: string): string[] {
  if (!existsSync(fixturesRoot)) {
    throw new Error(`fixture 디렉터리가 없습니다: ${fixturesRoot}`);
  }
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export function loadAllFixtures(fixturesRoot: string, only?: readonly string[]): LoadedFixture[] {
  const ids = only && only.length > 0 ? [...only] : listFixtureIds(fixturesRoot);
  return ids.map((id) => loadFixture(fixturesRoot, id));
}

/** 프롬프트 버전 해시 — 프롬프트가 바뀌면 이전 실행과 같은 실험이 아니다. */
export function promptVersionHash(manifest: FixtureManifest): string {
  return createHash("sha256").update(manifest.taskPrompt).digest("hex").slice(0, 16);
}
