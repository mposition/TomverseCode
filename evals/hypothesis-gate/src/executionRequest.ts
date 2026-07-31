import type { Stage } from "./stage.js";
import type { ArmId } from "./types.js";

/**
 * 실행 요청의 **정본 표현과 argv 생성기** (§2.9).
 *
 * # 무엇을 고쳤나
 *
 * 카드가 출력하는 명령과 카드를 검증하는 코드가 **서로 다른 규칙**을 갖고 있었다. 카드의
 * `runArgv`에는 `--executor-model`, `--reviewer-model`, `--probe-evidence`가 없었고,
 * P1의 attestation 경로도 없었다. 그래서 기본 모델이 아닌 override로 카드를 만들면,
 * **그 카드가 출력한 명령을 그대로 실행했을 때 그 카드의 검증에서 거부되는** 상태가 됐다 —
 * 승인 절차가 자기 자신을 통과하지 못한다.
 *
 * # 규칙
 *
 * 만드는 쪽과 검증하는 쪽이 **이 파일 하나**를 쓴다. argv를 두 곳에서 조립하면 그 둘은
 * 반드시 갈라지고, 갈라지는 순간 "카드와 실행이 같다"는 검증이 거짓이 된다.
 *
 * 그리고 문자열이 아니라 **배열이 정본**이다. 검증이 문자열을 다시 파싱하면 인용 규칙을 두 번
 * 구현하게 되고, 그 둘이 갈라지면 같은 문제가 다시 생긴다. 셸 문자열은 사람이 복사하기 위한
 * **파생물**이며 비교에 쓰지 않는다.
 */

export interface ExecutionRequestSpec {
  stage: Stage;
  /** **항상 명시한다.** 기본값에 기대면 fixture 목록이 바뀌었을 때 같은 명령이 다른 실험이 된다. */
  fixtureIds: string[];
  arms: ArmId[];
  repetitions: number;
  maxConcurrency: number;
  seed: number;
  outputDir: string;
  /** 이 단계의 승인 상한. 없는 카드는 승인 대상이 아니므로 자리표시자가 들어간다. */
  approvedLimitUsd?: number;
  executorModelId: string;
  reviewerModelId: string;
  /** immutable Run Card의 정확한 경로. */
  runCardPath: string;
  /** immutable probe evidence의 정확한 경로. */
  probeEvidencePath: string;
  /** P1에만 있다 — immutable P0 attestation의 정확한 경로. */
  p0AttestationPath?: string;
}

/** 승인 금액이 아직 없는 카드의 자리표시자. 이 값이 들어간 명령은 그대로 실행되지 않는다. */
export const PENDING_LIMIT_PLACEHOLDER = "<이 단계의 승인 금액>";

/** 단계 → 실행 스크립트. `smoke`도 pilot 스크립트를 쓰되 `--stage`로 구별된다. */
export function scriptForStage(stage: Stage): string {
  return stage === "confirmatory" ? "gate:g:run" : "gate:g:pilot";
}

/**
 * CLI가 받는 **플래그 부분만**. `parseArgs`가 그대로 먹는 배열이다.
 *
 * 순서를 고정하는 이유: 배열 비교가 정본이므로, 같은 계획이 다른 순서로 나오면 비교가 실패한다.
 * fixture id도 정렬한다 — 실행 순서는 seed가 정하므로 목록 순서는 의미가 없고,
 * 정렬해 두어야 같은 집합이 항상 같은 배열이 된다.
 */
export function executionCliArgv(spec: ExecutionRequestSpec): string[] {
  const argv: string[] = [];
  argv.push("--stage", spec.stage);
  argv.push("--fixtures", [...spec.fixtureIds].sort().join(","));
  argv.push("--arms", [...spec.arms].sort().join(","));
  argv.push("--repetitions", String(spec.repetitions));
  argv.push("--max-concurrency", String(spec.maxConcurrency));
  argv.push("--seed", String(spec.seed));
  argv.push("--output", spec.outputDir);
  argv.push(
    "--max-cost-usd",
    spec.approvedLimitUsd === undefined ? PENDING_LIMIT_PLACEHOLDER : String(spec.approvedLimitUsd)
  );
  // **모델을 항상 명시한다.** 레지스트리 기본값에 기대면, 기본값이 바뀐 뒤 같은 명령이 다른
  // 모델을 부른다 — 카드가 승인한 것과 다른 실험이 된다.
  argv.push("--executor-model", spec.executorModelId);
  argv.push("--reviewer-model", spec.reviewerModelId);
  argv.push("--run-card", spec.runCardPath);
  argv.push("--probe-evidence", spec.probeEvidencePath);
  if (spec.p0AttestationPath !== undefined) argv.push("--p0-attestation", spec.p0AttestationPath);
  return argv;
}

/** 사람이 실행하는 전체 명령의 argv. 앞의 네 원소는 npm 호출부다. */
export function executionArgv(spec: ExecutionRequestSpec): string[] {
  return ["npm", "run", scriptForStage(spec.stage), "--", ...executionCliArgv(spec)];
}

/** 재개 명령 — 같은 조건에 `--resume`만 붙는다. */
export function resumeArgv(spec: ExecutionRequestSpec): string[] {
  return [...executionArgv(spec), "--resume"];
}

/**
 * 두 argv 배열의 차이를 사람이 읽는 문장으로 만든다.
 *
 * "다릅니다"만 말하면 사용자가 무엇을 고쳐야 하는지 모른다 — 승인 게이트에서 가장 자주 보게 되는
 * 메시지이므로 **어느 플래그가 어떻게 다른지**까지 말한다.
 */
export function diffArgv(expected: readonly string[], actual: readonly string[]): string[] {
  const toMap = (argv: readonly string[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i]!;
      if (!token.startsWith("--")) continue;
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        map.set(token, [...(map.get(token) ?? []), value]);
        i += 1;
      } else {
        map.set(token, [...(map.get(token) ?? []), "(플래그만)"]);
      }
    }
    return map;
  };

  const left = toMap(expected);
  const right = toMap(actual);
  const differences: string[] = [];
  for (const flag of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(flag);
    const b = right.get(flag);
    if (a === undefined) {
      differences.push(`${flag}가 카드에 없는데 실행 요청에 있습니다 (요청 ${b!.join(",")})`);
      continue;
    }
    if (b === undefined) {
      differences.push(`${flag}가 카드에 있는데 실행 요청에 없습니다 (카드 ${a.join(",")})`);
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push(`${flag}가 다릅니다 (카드 ${a.join(",")} / 요청 ${b.join(",")})`);
    }
  }
  return differences;
}
