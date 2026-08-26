/**
 * 실험 단계.
 *
 * `runCard.ts`에서 떼어낸 이유는 순환 import 하나뿐이다: `executionRequest.ts`가 이 타입을
 * 필요로 하고, `runCard.ts`가 `executionRequest.ts`를 필요로 한다. 타입 하나를 위해 모듈이
 * 서로를 부르게 두면, 나중에 값(런타임 상수)을 추가하는 순간 초기화 순서 문제로 바뀐다.
 */

export type Stage = "smoke" | "pilot" | "confirmatory";

export const STAGES: readonly Stage[] = Object.freeze(["smoke", "pilot", "confirmatory"]);

/** P0(smoke)와 P1(pilot/confirmatory)은 서로 다른 승인·디렉터리·attestation 요구를 갖는다. */
export function requiresP0Attestation(stage: Stage): boolean {
  return stage !== "smoke";
}
