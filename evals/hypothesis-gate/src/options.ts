import path from "node:path";
import { ARMS } from "./arms.js";
import type { ArmId } from "./types.js";

/**
 * CLI 옵션 파싱과 검증 (§1, §4).
 *
 * # 왜 파싱 단계에서 막는가
 *
 * 잘못된 예산 값이나 지원하지 않는 동시성으로 실험을 시작하면, 그 사실이 드러날 때쯤에는
 * 이미 유료 호출이 나가 있다. **API를 부르기 전에** 끝내는 것이 이 모듈의 목적이다.
 *
 * # 왜 환경변수에서 예산을 추측하지 않는가
 *
 * 예산은 사용자가 이 실행에 대해 명시적으로 승인한 값이어야 한다. 환경에 남아 있던 값을
 * 주워 쓰면 "승인했다"는 말이 성립하지 않는다.
 */

export interface CliOptions {
  command: string;
  fixtures: string[];
  arms: ArmId[];
  repetitions: number;
  seed: number;
  maxCostUsd?: number;
  maxConcurrency: number;
  resume: boolean;
  output: string;
  executorModel?: string;
  reviewerModel?: string;
}

export class OptionError extends Error {}

/**
 * 예산 값 파싱. **엄격한 숫자 문법만 받는다.**
 *
 * `Number.parseFloat`을 그대로 쓰면 `"5달러"`가 5로, `"1e999"`가 Infinity로 통과한다.
 * 둘 다 사용자가 의도한 값일 리 없고, 유료 실행에서 그런 값을 조용히 받아들이면 안 된다.
 */
export function parseCostLimit(raw: string): number {
  const text = raw.trim();
  if (text.length === 0) throw new OptionError(usageForCost("빈 값은 예산 상한이 될 수 없습니다"));
  // 부호 없는 십진수만. 지수 표기(1e999)와 뒤에 붙은 문자열을 모두 배제한다.
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new OptionError(usageForCost(`숫자로 해석할 수 없습니다: ${JSON.stringify(raw)}`));
  }
  const value = Number(text);
  if (!Number.isFinite(value)) throw new OptionError(usageForCost(`유한한 수가 아닙니다: ${raw}`));
  if (value <= 0) throw new OptionError(usageForCost(`0보다 커야 합니다 (받은 값: ${raw})`));
  return value;
}

function usageForCost(problem: string): string {
  return [
    `--max-cost-usd: ${problem}`,
    "",
    "올바른 사용 예:",
    "  --max-cost-usd 25        # 최대 $25까지 승인",
    "  --max-cost-usd 12.50     # 소수점 가능",
    "",
    "0, 음수, NaN, Infinity, 숫자 뒤에 문자가 붙은 값은 받지 않습니다.",
  ].join("\n");
}

/**
 * protocol v1은 **순차 실행만** 지원한다.
 *
 * 판정 기준에 p95 지연이 있고, 그 비교는 순차 실행을 전제로 한다. 동시에 돌리면 rate limit과
 * 머신 부하가 지연에 섞여 들어가 비교가 성립하지 않는다. 예전에는 1보다 큰 값을 받아
 * 경고만 하고 **실제로는 무시**했는데, 그건 CLI가 거짓 계약을 내건 것이다.
 */
export function parseConcurrency(raw: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new OptionError(concurrencyUsage(`정수가 아닙니다: ${JSON.stringify(raw)}`));
  }
  const value = Number(text);
  if (value !== 1) throw new OptionError(concurrencyUsage(`받은 값: ${raw}`));
  return 1;
}

function concurrencyUsage(problem: string): string {
  return [
    `--max-concurrency: ${problem}`,
    "",
    "protocol v1은 **순차 실행만** 지원합니다 — 판정 기준의 p95 지연 비교가 순차를 전제로 하기 때문입니다.",
    "  --max-concurrency 1",
    "",
    "병렬 실행은 별도 protocol 버전에서 다룹니다.",
  ].join("\n");
}

/** 실제 공급자를 쓰는 유료 명령인가. fake와 dry-run은 여기 해당하지 않는다. */
export function isPaidCommand(command: string, usingFakeProvider: boolean): boolean {
  if (usingFakeProvider) return false;
  return command === "pilot" || command === "run";
}

export function parseArgs(argv: string[], defaultOutput: string): CliOptions {
  const options: CliOptions = {
    command: argv[0] ?? "help",
    fixtures: [],
    arms: ARMS.map((a) => a.arm),
    repetitions: 3,
    seed: 1,
    maxConcurrency: 1,
    resume: false,
    output: defaultOutput,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new OptionError(`${flag}에 값이 필요합니다`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--fixtures":
        options.fixtures = next().split(",").map((f) => f.trim()).filter(Boolean);
        break;
      case "--arms":
        options.arms = next().split(",").map((a) => a.trim().toUpperCase() as ArmId).filter(Boolean);
        break;
      case "--repetitions":
        options.repetitions = Number.parseInt(next(), 10);
        break;
      case "--seed":
        options.seed = Number.parseInt(next(), 10);
        break;
      case "--max-cost-usd":
        options.maxCostUsd = parseCostLimit(next());
        break;
      case "--max-concurrency":
        options.maxConcurrency = parseConcurrency(next());
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--output":
        options.output = path.resolve(next());
        break;
      case "--executor-model":
        options.executorModel = next();
        break;
      case "--reviewer-model":
        options.reviewerModel = next();
        break;
      default:
        throw new OptionError(`알 수 없는 옵션: ${flag}`);
    }
  }
  if (!Number.isFinite(options.repetitions) || options.repetitions < 1) {
    throw new OptionError("--repetitions는 1 이상의 정수여야 합니다");
  }
  return options;
}

/**
 * 유료 실행에는 예산 상한이 **필수**다.
 *
 * 우회 옵션을 만들지 않는다. "이번만 상한 없이"를 허용하는 순간 그게 기본 사용법이 된다.
 */
export function requireCostLimitForPaidRun(options: CliOptions, usingFakeProvider: boolean): void {
  if (!isPaidCommand(options.command, usingFakeProvider)) return;
  if (options.maxCostUsd !== undefined) return;
  throw new OptionError(
    [
      `${options.command}는 실제 공급자를 호출하므로 --max-cost-usd가 필수입니다.`,
      "",
      "올바른 사용 예:",
      `  npm run gate:g:${options.command} -- --max-cost-usd 25 --output <run-dir>`,
      "",
      "먼저 계획을 확인하세요:",
      "  npm run gate:g:plan-pilot -- --max-cost-usd 25 --output <run-dir>",
      "",
      "예산 상한 없이 유료 실행하는 방법은 제공하지 않습니다.",
    ].join("\n")
  );
}
