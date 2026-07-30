import { ARMS } from "./arms.js";
import { maxCallsPerRecord } from "./models.js";
import type { ArmId } from "./types.js";

/**
 * provider 호출 수 상한 — **한 곳에서만 계산한다** (§9).
 *
 * # 고친 문제
 *
 * Run Card는 reviewer를 포함한 총상한을 계산했지만 preflight/dry-run은 executor 호출만 셌고,
 * 그 값을 **"최대 API 호출 수"**로 표시했다. confirmatory dry-run에서 화면에는 1,152가 찍혔고
 * 실제 상한은 1,584였다(executor 1,152 + reviewer 432). 사용자가 보는 "최대"가 실제 최대보다
 * 27% 작으면 그 숫자는 승인 근거로 쓸 수 없다.
 *
 * 같은 수를 두 곳에서 따로 세면 반드시 갈라진다. 그래서 계산은 이 파일에만 있고,
 * preflight·dry-run·Run Card가 **같은 함수**를 부른다.
 *
 * # 이름이 사실을 말해야 한다
 *
 * `total`은 executor + reviewer다. executor만 센 값을 `total`이나 `maximum`이라고 부르지 않는다 —
 * 그 이름이 곧 이번 결함의 원인이었다.
 */

export interface CallBudget {
  /** executor 파이프라인(초안 1 + fix loop 3)이 낼 수 있는 최대 호출 수. */
  executor: number;
  /** 검수자(검수 1 + revise 2)가 낼 수 있는 최대 호출 수. 단독 arm은 0이다. */
  reviewer: number;
  /** **진짜 총 상한** = executor + reviewer. 사용자에게 "최대"로 보여주는 값. */
  total: number;
  /** 계획된 기록 수 = fixture × arm × 반복. */
  records: number;
  /** arm별 내역 — 어느 arm이 얼마를 차지하는지 보여준다. */
  perArm: { arm: ArmId; executor: number; reviewer: number; total: number }[];
}

/**
 * fixture 수 × arm 집합 × 반복 수에서 호출 상한을 유도한다.
 *
 * 상수를 적어두지 않는 이유: arm을 추가하거나 루프 상한(CLAUDE.md 원칙 5)을 바꾸면 이 숫자가
 * 따라 움직여야 한다. 하드코딩하면 카드가 조용히 틀린 수를 말한다.
 */
export function computeCallBudget(input: {
  fixtureCount: number;
  arms: readonly ArmId[];
  repetitions: number;
}): CallBudget {
  const specs = ARMS.filter((a) => input.arms.includes(a.arm));
  const recordsPerArm = input.fixtureCount * input.repetitions;
  const perArm = specs.map((spec) => {
    const calls = maxCallsPerRecord(spec.arm, spec.providers.length);
    const executor = calls.executor * recordsPerArm;
    const reviewer = calls.reviewer * recordsPerArm;
    return { arm: spec.arm, executor, reviewer, total: executor + reviewer };
  });
  const executor = perArm.reduce((sum, a) => sum + a.executor, 0);
  const reviewer = perArm.reduce((sum, a) => sum + a.reviewer, 0);
  return {
    executor,
    reviewer,
    total: executor + reviewer,
    records: recordsPerArm * specs.length,
    perArm,
  };
}

/**
 * 사람이 읽는 형태. **총 상한이 먼저 나오고 내역이 뒤에 붙는다.**
 *
 * 순서에 의미가 있다: 먼저 나오는 숫자가 사용자가 기억하는 숫자다. executor 수치를 먼저
 * 보여주면 그것이 "최대"로 읽힌다.
 */
export function describeCallBudget(budget: CallBudget, indent = ""): string[] {
  return [
    `${indent}최대 provider 호출 수(총 상한): ${budget.total.toLocaleString()}회`,
    `${indent}    내역 — executor(초안 1 + fix loop 3): ${budget.executor.toLocaleString()}회`,
    `${indent}    내역 — reviewer(검수 1 + revise 2): ${budget.reviewer.toLocaleString()}회`,
  ];
}
