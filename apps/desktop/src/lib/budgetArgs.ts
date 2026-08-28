/**
 * 화면의 예산 입력 → Rust가 받는 두 값 (`budgetUsd` / `budgetUnlimited`).
 *
 * # 왜 값이 둘인가
 *
 * **"말하지 않은 것"과 "없음"을 구별하기 위해서다**(`budget.rs`의 `resolve_budget`). 인자를
 * 빠뜨린 화면이 상한을 조용히 끄면, 그 순간 예산 상한이라는 기능이 거짓이 된다. 그래서
 * "상한 없음"은 **명시적으로** 말해야 하는 값이고, 화면은 빈 입력을 그렇게 번역한다.
 *
 * # 잘못된 값을 "없음"으로 바꾸지 않는다
 *
 * 오타(`0`, `-1`, `abc`)를 무제한으로 접으면 **오타 하나가 상한을 지운다.** 그대로 보내고
 * Rust가 거부하며, 그 사유가 화면에 뜬다.
 *
 * # 왜 화면 밖에 있는가
 *
 * 종전에는 이 함수가 `App.tsx` 안에 있었고, 그 옆 주석이 이미 *"화면의 입력을 태스크가 받게
 * 될 값으로 바꾸는 곳은 여기 한 곳뿐"*이라고 적고 있었다. Fleet은 상한을 **둘** 받으므로
 * (태스크당·합계) 그 한 곳이 실제로 여러 화면에서 쓰이게 됐고, 화면 안에 있으면 DOM 없이
 * 검증할 방법이 없다.
 */

export interface BudgetArgs {
  budgetUsd: number | null;
  budgetUnlimited: boolean;
}

export function budgetArgs(text: string): BudgetArgs {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { budgetUsd: null, budgetUnlimited: true };
  const value = Number(trimmed);
  // 잘못된 값을 "없음"으로 바꾸지 않는다. Rust가 거부하고 그 사유가 화면에 뜬다 —
  // 여기서 조용히 무제한으로 바꾸면 오타 하나가 상한을 지운다.
  return { budgetUsd: value, budgetUnlimited: false };
}

/**
 * 이 입력이 뜻하는 **상한 값**. `null`이면 상한이 없다.
 *
 * 시작 전 점검(`budgetCheck.ts`)처럼 "상한이 얼마인가"만 필요한 자리가 쓴다.
 */
export function budgetLimitOf(text: string): number | null {
  const args = budgetArgs(text);
  return args.budgetUnlimited ? null : args.budgetUsd;
}
