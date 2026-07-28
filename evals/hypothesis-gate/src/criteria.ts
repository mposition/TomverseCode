/**
 * 가설 게이트 G의 **사전 등록된** 판정 기준.
 *
 * # 왜 코드에 박아두는가
 *
 * 결과를 본 뒤에 기준을 조정하면 그 실험은 아무것도 증명하지 못한다. 그래서 기준을 문서와
 * 코드 양쪽에 두고, **해시로 고정한다.** 리포트에 이 해시가 찍히므로 "어떤 기준으로 판정한
 * 결과인가"가 산출물 자체에 남는다.
 *
 * 기준을 바꾸려면 `PROTOCOL_VERSION`을 올려야 하고, 그건 **새 실험**이다 — 이전 실행 기록과
 * 섞어서 집계하면 안 된다. `assertCriteriaUnchanged()`가 그 규율의 기계적 장치다.
 *
 * # 검증하려는 가설
 *
 * > 어려운 코딩 작업에서 OpenAI 초안 + 독립 Anthropic 검수가
 * > **가장 강한 단일 모델 실행**보다 결정론적 성공률을 의미 있게 높이는가?
 *
 * "가장 강한 단일 모델"이 비교 기준인 것이 핵심이다. 교차검증을 약한 단일 모델과 비교하면
 * 파이프라인 효과와 모델 효과를 구별할 수 없다 — 그래서 Arm A와 Arm B를 모두 돌린다.
 */

import { createHash } from "node:crypto";

/** 기준을 바꾸면 이 값을 올려야 한다. 올리면 이전 실행 기록과 같은 실험이 아니다. */
export const PROTOCOL_VERSION = 1;

export interface GateCriteria {
  protocolVersion: number;
  /** 유효한 "어려운" fixture 최소 개수 */
  minFixtures: number;
  /** primary arm의 fixture당 최소 반복 횟수 */
  minRepetitions: number;
  /** 교차검증이 가장 강한 single arm보다 얼마나 나아야 하는가 (퍼센트 포인트) */
  minOraclePassRateGainPp: number;
  /** paired bootstrap 신뢰구간 수준 */
  bootstrapConfidence: number;
  /** 신뢰구간 하한이 이 값보다 커야 한다 */
  bootstrapLowerBoundAbove: number;
  /** reviewer correction이 harm보다 최소 이 배수만큼 많아야 한다 */
  minCorrectionToHarmRatio: number;
  /** 보안 카테고리에서 single arm 대비 허용되는 regression 개수 */
  maxSecurityRegressions: number;
  /** 비용 상한 배수 (가장 강한 single arm 대비) */
  maxCostMultiplier: number;
  /** p95 지연 상한 배수 (가장 강한 single arm 대비) */
  maxP95LatencyMultiplier: number;
  /** 인프라 실패율 상한 (이보다 높으면 표본을 믿을 수 없다) */
  maxInfrastructureFailureRate: number;
}

/**
 * **결과를 보기 전에 고정된 값들.** 명세 13절과 1:1 대응한다.
 *
 * `Object.freeze`는 실수로 런타임에 고쳐 쓰는 것을 막는다 — 하네스가 스스로 기준을
 * 유리하게 바꾸는 경로를 코드 수준에서 없앤다.
 */
export const CRITERIA: Readonly<GateCriteria> = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  minFixtures: 24,
  minRepetitions: 3,
  minOraclePassRateGainPp: 10,
  bootstrapConfidence: 0.95,
  bootstrapLowerBoundAbove: 0,
  minCorrectionToHarmRatio: 2,
  maxSecurityRegressions: 0,
  maxCostMultiplier: 2,
  maxP95LatencyMultiplier: 2.5,
  maxInfrastructureFailureRate: 0.05,
});

/**
 * 기준의 정본 해시. 리포트에 찍히고 테스트가 고정한다.
 *
 * 값이 바뀌면 테스트가 실패하므로, "조용히 기준을 완화한 뒤 PASS를 받는" 경로가 막힌다.
 * 의도적으로 바꾸는 경우에는 테스트의 기대 해시도 함께 갱신해야 하고, 그 커밋이 곧 기록이 된다.
 */
export function criteriaHash(criteria: Readonly<GateCriteria> = CRITERIA): string {
  const canonical = JSON.stringify(
    Object.keys(criteria)
      .sort()
      .map((k) => [k, (criteria as unknown as Record<string, unknown>)[k]])
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 사람이 읽는 형태 — Markdown 리포트 머리에 그대로 들어간다. */
export function describeCriteria(criteria: Readonly<GateCriteria> = CRITERIA): string[] {
  return [
    `유효한 어려운 fixture 최소 ${criteria.minFixtures}개`,
    `primary arm fixture당 최소 ${criteria.minRepetitions}회 반복`,
    `교차검증이 가장 강한 single arm보다 oracle pass rate 최소 ${criteria.minOraclePassRateGainPp}%p 개선`,
    `paired bootstrap ${Math.round(criteria.bootstrapConfidence * 100)}% 신뢰구간 하한이 ${criteria.bootstrapLowerBoundAbove}보다 큼`,
    `reviewer correction이 harm의 ${criteria.minCorrectionToHarmRatio}배 이상`,
    `보안 카테고리에서 single arm 대비 regression ${criteria.maxSecurityRegressions}건`,
    `비용이 가장 강한 single arm의 ${criteria.maxCostMultiplier}배 이하`,
    `p95 지연이 가장 강한 single arm의 ${criteria.maxP95LatencyMultiplier}배 이하`,
    `인프라 실패율 ${criteria.maxInfrastructureFailureRate * 100}% 미만`,
  ];
}

/**
 * 기준이 실행 중에 바뀌지 않았는지 확인한다.
 *
 * 편집증처럼 보이지만 목적이 분명하다: 실행과 판정 사이에 기준을 바꾸는 것은 이 실험을
 * 무의미하게 만드는 **유일하고 가장 쉬운 방법**이므로, 그 경로에 자물쇠를 하나 걸어둔다.
 */
export function assertCriteriaUnchanged(expectedHash: string): void {
  const actual = criteriaHash();
  if (actual !== expectedHash) {
    throw new Error(
      `판정 기준이 실행 중에 바뀌었습니다 (기록된 해시 ${expectedHash} ≠ 현재 ${actual}).\n` +
        `기준을 바꾸려면 PROTOCOL_VERSION을 올리고 새 실험으로 다시 돌려야 합니다 — ` +
        `이전 기록과 섞어서 집계할 수 없습니다.`
    );
  }
}
