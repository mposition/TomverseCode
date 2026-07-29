/**
 * `exec.mjs`의 타입 선언 — 손으로 쓴다.
 *
 * 구현이 일반 JavaScript인 이유는 `exec.mjs` 상단에 있다(빌드 순환 회피). 그 대가로 타입은
 * 여기서 따로 유지해야 하고, 둘이 갈라지면 타입 검사가 조용히 틀린 답을 낸다. 그래서
 * `test/exec.test.ts`가 **선언된 이름이 실제로 모두 존재하는지** 실행 시점에 확인한다.
 */

export type MsvcResult =
  | { kind: "not_needed" }
  | { kind: "ready"; env: Record<string, string> }
  | { kind: "unavailable"; exitCode: number; message: string };

export interface ScriptRunner {
  (program: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string };
}

export interface ResolveEnv {
  platform: string;
  pathValue?: string;
  pathext?: string;
  isFile?: (p: string) => boolean;
  execPath?: string;
}

export type NodeCliResolution =
  | { ok: true; executable: string; args: string[]; kind: "passthrough" | "node-cli" }
  | { ok: false; message: string };

export declare const MSVC_ENV_ALLOWLIST: readonly string[];
export declare const READY_MARKER: string;
export declare const DEFAULT_PATHEXT: readonly string[];
export declare const defaultRunner: ScriptRunner;

export declare function isWindows(platform: string): boolean;
export declare function msvcEnvScriptPath(repoRoot: string): string;
export declare function shellExecutablePath(env?: Record<string, string | undefined>): string;
export declare function parseMsvcEnv(stdout: string): { ready: boolean; env: Record<string, string> };
export declare function interpretMsvcOutcome(
  outcome: { status: number | null; stdout: string; stderr: string },
  scriptPath: string
): MsvcResult;
export declare function prepareMsvcEnv(
  repoRoot: string,
  platform: string,
  runner?: ScriptRunner,
  options?: { useCache?: boolean }
): MsvcResult;
export declare function clearMsvcCache(): void;
export declare function withMsvcEnv(
  base: Record<string, string | undefined>,
  result: MsvcResult
): Record<string, string | undefined>;
export declare function needsNativeToolchain(program: string): boolean;
export declare function programStem(program: string): string;
export declare function findExecutable(program: string, env: ResolveEnv): string | undefined;
export declare function resolveNodeCli(program: string, args: readonly string[], env: ResolveEnv): NodeCliResolution;
