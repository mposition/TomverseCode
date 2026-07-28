import type { ArmId, ArmSpec } from "./types.js";

/**
 * 실험 arm 정의.
 *
 * # "단독" arm을 만드는 방법
 *
 * reviewer를 끄는 별도 분기를 만들지 않는다. 대신 **후보 공급자를 하나로 좁힌다.**
 * 그러면 라우터의 검수자 독립성 불변식(multi-engine-routing.md 5절)이 스스로
 * "독립 공급자가 없으므로 reviewer를 드롭한다"고 판단하고 그 사유를 `appliedPolicies`에 남긴다.
 *
 * 이게 중요한 이유: Arm A/B가 **production이 단일 공급자 환경에서 실제로 하는 동작**과
 * 같아진다. 실험용 우회로를 만들면 측정 대상이 production이 아니게 된다.
 *
 * # 초안 공유
 *
 * Arm A가 초안을 생성하고, Arm C/D가 그 초안을 재생한다. 세 arm이 같은 초안을 쓰므로:
 *  - A vs C = **검수 단계의 순효과** (다른 것은 아무것도 다르지 않다)
 *  - C vs D = **review mode(informed/blind)의 순효과**
 *
 * 각 arm이 초안을 새로 생성하면 초안 품질의 분산이 효과 추정에 섞여 들어간다.
 * 부수 효과로 API 비용도 초안 3회 → 1회로 줄어든다.
 *
 * Arm B는 초안을 공유할 수 없다 — 다른 모델이 처음부터 만드는 것이 이 arm의 정의다.
 * "가장 강한 단일 모델"을 찾기 위한 arm이며, 이것 없이는 교차검증의 이득이
 * 파이프라인 효과인지 단순히 Anthropic이 더 나은 것인지 구별할 수 없다.
 */
export const ARMS: readonly ArmSpec[] = Object.freeze([
  {
    arm: "A",
    label: "OpenAI 단독 (초안만, 검수 없음)",
    providers: ["openai"],
    draftSource: "generate",
    primary: true,
  },
  {
    arm: "B",
    label: "Anthropic 단독 (처음부터 생성, 검수 없음)",
    providers: ["anthropic"],
    draftSource: "generate",
    primary: true,
  },
  {
    arm: "C",
    label: "교차검증 (OpenAI 초안 + Anthropic informed 검수)",
    providers: ["openai", "anthropic"],
    reviewMode: "informed",
    draftSource: "replay",
    draftSourceArm: "A",
    primary: true,
  },
  {
    arm: "D",
    label: "교차검증 (같은 초안 + Anthropic blind 검수)",
    providers: ["openai", "anthropic"],
    reviewMode: "blind",
    draftSource: "replay",
    draftSourceArm: "A",
    primary: false,
  },
]);

/** 교차검증 가설의 주 대상 arm. */
export const CROSS_VERIFICATION_ARM: ArmId = "C";

/** "가장 강한 단일 모델"의 후보 — 실제로 어느 쪽이 강한지는 데이터가 결정한다. */
export const SINGLE_MODEL_ARMS: readonly ArmId[] = Object.freeze(["A", "B"]);

export function armSpec(arm: ArmId): ArmSpec {
  const found = ARMS.find((a) => a.arm === arm);
  if (!found) throw new Error(`알 수 없는 arm: ${arm}`);
  return found;
}

/**
 * arm 실행 순서 제약. 초안을 재생하는 arm은 **초안을 만드는 arm 뒤에** 와야 한다.
 *
 * §7이 실행 순서 무작위화를 요구하지만 이 의존성은 무작위화보다 우선한다 — 순서를 섞어도
 * A가 C보다 먼저여야 한다. 그래서 무작위화는 **fixture 순서**에 적용하고, arm 순서는
 * 이 의존성을 만족하는 위상 순서로 고정한다. 그 사실을 리포트에 명시한다.
 */
export function armExecutionOrder(selected: readonly ArmId[]): ArmId[] {
  const wanted = new Set(selected);
  const generators = ARMS.filter((a) => a.draftSource === "generate" && wanted.has(a.arm)).map((a) => a.arm);
  const replayers = ARMS.filter((a) => a.draftSource === "replay" && wanted.has(a.arm)).map((a) => a.arm);

  for (const arm of replayers) {
    const source = armSpec(arm).draftSourceArm;
    if (source && !wanted.has(source)) {
      throw new Error(
        `Arm ${arm}은 Arm ${source}의 초안을 재생하는데 Arm ${source}가 선택되지 않았습니다. ` +
          `같은 초안을 공유해야 paired 비교가 성립하므로 ${source}를 함께 돌려야 합니다.`
      );
    }
  }
  return [...generators, ...replayers];
}
