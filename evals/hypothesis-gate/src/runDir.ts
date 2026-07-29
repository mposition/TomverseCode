import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 실행 디렉터리 계약 (§5).
 *
 * # 고친 문제
 *
 * 예전에는 최초 실행이 `<output>/<uuid>.jsonl`에 쓰고, `--resume`은 `<output>/records.jsonl`을
 * 찾았다. 그래서 **사용자가 중단한 뒤 같은 명령에 `--resume`만 붙이면 처음부터 다시 돌았다.**
 * 몇 시간과 실제 돈이 든 기록을 못 찾고 다시 쓰는 것이므로, 이건 편의 문제가 아니라 사고다.
 *
 * # 계약
 *
 * `--output <dir>`는 **하나의 실험 실행 디렉터리**다.
 *
 * ```text
 * <run-dir>/
 *   run.json        메타데이터 — 무엇을 어떤 조건으로 돌렸는가
 *   records.jsonl   실행 기록 (최초 실행과 재개가 같은 파일을 쓴다)
 *   report.md, summary.json, ...
 * ```
 *
 * 재개할 때 조건이 달라졌으면 **거부한다.** 다른 조건의 기록을 한 파일에 섞으면 집계가
 * 조용히 틀리고, 그 틀림은 리포트를 봐서는 드러나지 않는다.
 */

export const RECORDS_FILE = "records.jsonl";
export const META_FILE = "run.json";

/** 재개 가능 여부를 판정하는 데 쓰는 값들. 하나라도 다르면 같은 실험이 아니다. */
export interface RunMeta {
  metaVersion: number;
  /** pilot / run / smoke — 서로 섞이면 안 된다. */
  stage: string;
  protocolVersion: number;
  criteriaHash: string;
  /** fixtureId → fixtureHash. 내용이 바뀐 fixture로 재개하면 비교가 성립하지 않는다. */
  fixtureHashes: Record<string, string>;
  arms: string[];
  repetitions: number;
  seed: number;
  executorModelId: string;
  reviewerModelId: string;
  /** 사용자가 승인한 예산 상한의 이력 — 올릴 때마다 새 승인으로 기록한다. */
  approvals: { approvedLimitUsd: number; at: string; note: string }[];
  createdAt: string;
}

export const META_VERSION = 1;

export function runDirPaths(runDir: string): { records: string; meta: string } {
  return { records: path.join(runDir, RECORDS_FILE), meta: path.join(runDir, META_FILE) };
}

export function readMeta(runDir: string): RunMeta | undefined {
  const { meta } = runDirPaths(runDir);
  if (!existsSync(meta)) return undefined;
  return JSON.parse(readFileSync(meta, "utf8")) as RunMeta;
}

export function writeMeta(runDir: string, meta: RunMeta): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runDirPaths(runDir).meta, `${JSON.stringify(meta, null, 2)}\n`);
}

export interface CompatibilityResult {
  ok: boolean;
  /** 재개를 막는 이유. 비어 있으면 재개 가능하다. */
  conflicts: string[];
  /** 예산 상한이 올라갔는가 — 새 사용자 승인으로 기록해야 한다. */
  budgetRaised: boolean;
  /** 이미 쓴 금액보다 낮은 상한으로 재개하려 하는가 — 즉시 중단해야 한다. */
  budgetBelowSpent: boolean;
}

/**
 * 기존 실행에 이어붙일 수 있는가.
 *
 * 비교하는 것: stage, protocol version, criteria hash, fixture hash, arm 집합, seed, 모델 ID.
 * **반복 횟수는 늘릴 수 있다** — 3회로 늘리는 것은 같은 실험을 더 모으는 것이므로 정당하다.
 * 줄이는 것도 막지 않는다(이미 있는 기록이 그냥 남는다).
 *
 * 예산은 특별하게 다룬다:
 *  - 낮추는 것 자체는 허용한다(더 조심하겠다는 뜻이므로).
 *  - 다만 **이미 쓴 금액보다 낮으면** 즉시 중단해야 한다 — 새 호출을 할 수 없기 때문이다.
 *  - 올리는 것은 새 사용자 승인이므로 `approvals`에 한 줄 더 남긴다.
 */
export function checkCompatibility(
  existing: RunMeta,
  incoming: Omit<RunMeta, "approvals" | "createdAt" | "metaVersion">,
  budget: { approvedLimitUsd: number; alreadySpentUsd: number }
): CompatibilityResult {
  const conflicts: string[] = [];
  const compare = (label: string, a: unknown, b: unknown): void => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    if (left !== right) conflicts.push(`${label}이(가) 다릅니다: 기존 ${left} / 요청 ${right}`);
  };

  compare("stage", existing.stage, incoming.stage);
  compare("protocol version", existing.protocolVersion, incoming.protocolVersion);
  compare("판정 기준 해시", existing.criteriaHash, incoming.criteriaHash);
  compare("seed", existing.seed, incoming.seed);
  compare("arm 집합", [...existing.arms].sort(), [...incoming.arms].sort());
  compare("executor 모델", existing.executorModelId, incoming.executorModelId);
  compare("reviewer 모델", existing.reviewerModelId, incoming.reviewerModelId);

  // fixture는 **요청한 것만** 비교한다. 일부 fixture만 재개하는 것은 정당하고,
  // 그때 기존 메타에 있는 다른 fixture까지 비교하면 불필요하게 막힌다.
  for (const [id, hash] of Object.entries(incoming.fixtureHashes)) {
    const known = existing.fixtureHashes[id];
    if (known === undefined) {
      conflicts.push(`fixture ${id}는 기존 실행에 없습니다 — 다른 실험의 결과를 섞지 않습니다`);
    } else if (known !== hash) {
      conflicts.push(`fixture ${id}의 내용이 바뀌었습니다 (해시 ${known} → ${hash})`);
    }
  }

  const lastApproved = existing.approvals[existing.approvals.length - 1]?.approvedLimitUsd ?? 0;
  return {
    ok: conflicts.length === 0 && budget.approvedLimitUsd > budget.alreadySpentUsd,
    conflicts,
    budgetRaised: budget.approvedLimitUsd > lastApproved,
    budgetBelowSpent: budget.approvedLimitUsd <= budget.alreadySpentUsd,
  };
}

/** 승인 이력에 한 줄 추가. 상한을 올린 사실이 기록에 남아야 사후에 설명할 수 있다. */
export function withApproval(meta: RunMeta, approvedLimitUsd: number, at: string, note: string): RunMeta {
  return { ...meta, approvals: [...meta.approvals, { approvedLimitUsd, at, note }] };
}
