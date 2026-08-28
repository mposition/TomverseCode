/**
 * `sidecarStage.mjs`의 타입 선언 — 손으로 쓴다(`nodeRuntime.d.mts`와 같은 이유).
 */

export declare const PRUNED_EXTENSIONS: string[];
export declare const SELF_PACKAGE: string;

export declare function shouldPrune(fileName: string): boolean;

export declare function splitPath(value: string): string[];

export type BundleTargetResult = { ok: true; target: string } | { ok: false; reason: string };

export declare function bundleTargetFor(
  repoRoot: string,
  depPath: string,
  stageBundleDir: string
): BundleTargetResult;

export declare function packageNameFromPath(repoRoot: string, depPath: string): string | null;

export interface StageCopy {
  what: string;
  from: string;
  to: string;
  prune: { extensions: string[]; keepOnly: string[] | null };
}

export interface StageSkip {
  path: string;
  why: string;
}

export interface StagePlan {
  bundleDir: string;
  copies: StageCopy[];
  skipped: StageSkip[];
  required: string[];
}

export interface StageInput {
  repoRoot: string;
  stageRoot: string;
  windows: boolean;
  sidecarDistDir: string;
  depPaths: string[];
  grammarWasmFiles: string[];
}

export declare function planSidecarStage(input: StageInput): StagePlan;

export interface BundlePackageJson {
  name: string;
  private: boolean;
  type: string;
  version: string;
  main: string;
}

export declare function bundlePackageJson(version: string): BundlePackageJson;
