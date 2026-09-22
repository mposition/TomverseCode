/**
 * 실행 정책이 **몇 번 부르는가** — product-strategy.md 8.6절, ui-wireframes 3.11절.
 *
 * # 사용자가 고르는 것은 모드인데, 그 모드가 바꾸는 것은 대부분 비용이다
 *
 * 화면의 실행 정책은 "Fast — 쉬운 작업은 단일 모델" / "Verified — 항상 독립 검수"라고만
 * 적혀 있었다. 가장 비싼 결과가 이름에 없었다.
 *
 * # 72절이 이 수를 통째로 바꿨다 — **이 수정은 회귀처럼 보인다**
 *
 * 종전 이 파일은 `verified`를 `{ perRoundMax: 3, parts: ["실행자 2 (대조)", "검수자 1"] }`로
 * 적었고, 테스트가 *"verified는 실행자를 둘 부른다"*라는 이름으로 그 계약을 **초록색으로
 * 지키고 있었다.** state-machine 72.9절이 그 둘을 다 뒤집는다:
 *
 * - **둘이 되는 것은 실행자가 아니라 계획자다.** 대조가 계획 단계로 옮겨왔다.
 * - **`fast`의 2도 틀렸다.** `fast`인데 TRIAGE가 `standard`로 분류하면 `REVIEWING`이 아니라
 *   72절 흐름 전체가 돈다.
 *
 * 새 수는 `1(계획) + 1(대조) + 1(B) + N(구현) + 1(C)`이다.
 *
 * # "라운드"가 더 이상 단위가 아니다
 *
 * 72절 흐름은 같은 라운드를 반복하지 않는다. 구간이 둘이고 **그 사이에 사용자 승인이 있다**:
 *
 * | 구간 | 무엇이 부르는가 | 시작 시점에 아는가 |
 * |---|---|---|
 * | 계획 승인 **전** | 계획 1~2 + 계획 검토 1 | **안다** |
 * | 계획 승인 **후** | 서브태스크마다 1 + 결과 검토 1 | **모른다** — 개수는 계획이 정한다 |
 *
 * 예산 점검(`budgetCheck.ts`)도 **한 호출**이 예약될 수 있는지만 봤다. 상한이 한 번은 되고 세
 * 번은 안 되는 값이면 태스크는 시작해서 돈을 쓰고 도중에 멈춘다 — 시작 전에 거부되는 것보다
 * 나쁜 결말이다.
 *
 * # 그래도 "멈출 수 있습니다"라고 말하지 않는다
 *
 * `budgetCheck.ts`가 정한 규율("확실할 때만 말한다")이 여기에도 걸린다. 라우터가 대조나 검수를
 * 드롭할 수 있고, tier가 갈리고, fix loop가 몇 번 돌지 모른다 — 그러므로 "예산이 모자랄
 * 겁니다"는 **틀릴 수 있는 경고**이고, 틀릴 수 있는 경고는 몇 번 지나면 맞는 경고까지 함께
 * 묻어버린다.
 *
 * 대신 **사실을 나란히 놓는다**: 승인 전 구간의 호출 수 범위, 승인 후 구간의 식, 그리고 지금
 * 상한으로 부를 수 있는 호출 수. 셋 다 산수이고 셋 다 참이다. 판단은 사용자가 한다 —
 * 큰 변경 안내(19.6절)에서 이미 쓴 규칙과 같다: **사실만 말하고 막지 않는다.**
 */

export type ExecutionMode = "fast" | "verified";

export interface CallPlan {
  /**
   * 계획 승인 **전**까지 부르는 공급자 호출 수의 **상한**.
   *
   * 재시도는 빠져 있다 — 몇 번 돌지 알 수 없고, 모르는 것을 더하면 이 수가 추정이 된다.
   */
  beforeApprovalMax: number;
  /**
   * 같은 구간의 **하한.** 라우터가 독립 공급자를 찾지 못하면 대조와 계획 검토가 드롭되어
   * 여기까지 줄어든다(multi-engine 21.6절 사다리). 하한만 적으면 비용이 작아 보이고,
   * 상한만 적으면 언제나 그만큼 나가는 것처럼 읽힌다.
   */
  beforeApprovalMin: number;
  /** 상한이 무엇으로 이루어져 있는지 — 근거 없는 숫자는 사용자가 검증할 수 없다. */
  beforeApprovalParts: string[];
  /**
   * 승인 **후** 구간에서 서브태스크 하나당 부르는 수. 지금은 1이다 — 구현 단계에서는
   * 초안이 하나이고 대조하지 않는다(72.2.2절).
   *
   * **개수를 곱해 두지 않는다.** 서브태스크 개수는 계획이 정하므로 시작 시점에 알 수 없다.
   */
  perSubtask: number;
  /** 승인 후 구간의 **고정분**: 결과 검토(C) 1회. 드롭되면 0이 된다. */
  afterApprovalFixedMax: number;
}

/**
 * 모드가 만드는 호출 계획.
 *
 * **모드가 정하는 것은 계획자를 둘 부르는가 하나뿐이다**(72.9절). 계획 검토(B)와 결과
 * 검토(C)는 모드와 무관하게 사다리가 배정하고, tier는 TRIAGE가 정한다 — **모드는 더 이상
 * tier를 정하지 않는다.**
 */
export function planFor(mode: ExecutionMode): CallPlan {
  const contrast = mode === "verified";
  return {
    beforeApprovalMax: contrast ? 3 : 2,
    // 공급자가 하나뿐이면 대조도 계획 검토도 드롭되고 계획 1회만 남는다.
    beforeApprovalMin: 1,
    beforeApprovalParts: contrast ? ["계획 2 (대조)", "계획 검토 1"] : ["계획 1", "계획 검토 1"],
    perSubtask: 1,
    afterApprovalFixedMax: 1,
  };
}

export interface Affordability {
  /** 지금 상한으로 부를 수 있는 호출 수. 상한이 없거나 단가를 모르면 `null`이다. */
  calls: number | null;
  /** 그 수가 어느 모델 단가에서 나왔는지. */
  basisModelId?: string;
}

/**
 * 상한으로 몇 번 부를 수 있는가.
 *
 * **가장 싼 모델을 기준으로 잡는다.** 그러면 이 수는 **상한(최대로 이만큼)** 이 되고,
 * "이보다 많이 부를 수는 없다"는 확실한 사실이 된다. 가장 비싼 모델로 잡으면 하한이 되어
 * "적어도 이만큼은 된다"가 되는데, 사용자가 알고 싶은 것은 모자랄 위험 쪽이다.
 */
export function affordableCalls(
  budgetUsd: number | null,
  models: readonly { modelId: string; maxCallCostUsd?: number }[]
): Affordability {
  if (budgetUsd === null) return { calls: null };
  const priced = models.filter(
    (m): m is { modelId: string; maxCallCostUsd: number } => typeof m.maxCallCostUsd === "number" && m.maxCallCostUsd > 0
  );
  if (priced.length === 0) return { calls: null };
  const cheapest = priced.reduce((min, m) => (m.maxCallCostUsd < min.maxCallCostUsd ? m : min));
  return { calls: Math.floor(budgetUsd / cheapest.maxCallCostUsd), basisModelId: cheapest.modelId };
}

/**
 * 화면에 나가는 문장들. **경고가 아니라 사실 나열이다.**
 *
 * 승인 후 구간을 **수가 아니라 식으로** 적는다 — 서브태스크 개수는 계획이 정하므로 시작
 * 시점에 알 수 없고, 지어낸 개수를 곱하면 화면이 정확해 보이는 만큼 정확히 틀린다.
 * 실제 수는 **계획 승인 카드**가 보여준다(72.4절): 이 화면보다 나중에, 그리고 더 정확하게.
 *
 * 마지막 문장은 상한이 설정되고 단가를 아는 경우에만 나온다 — 모르면서 아는 척하지 않는다.
 */
export function describeCallPlan(
  mode: ExecutionMode,
  budgetUsd: number | null,
  models: readonly { modelId: string; maxCallCostUsd?: number }[]
): string[] {
  const plan = planFor(mode);
  const lines = [
    `계획을 세우고 승인을 받기까지 공급자를 최대 ${plan.beforeApprovalMax}회 부릅니다 ` +
      `(${plan.beforeApprovalParts.join(" + ")}). 독립 공급자를 배정하지 못하면 ` +
      `${plan.beforeApprovalMin}회까지 줄어듭니다.`,
    `승인하시면 서브태스크마다 ${plan.perSubtask}회와 결과 검토 ${plan.afterApprovalFixedMax}회가 더 듭니다. ` +
      "서브태스크 개수는 계획이 정하므로 지금은 알 수 없고, 승인 카드가 개수와 예상 금액을 보여줍니다. " +
      "재시도와 수정 루프는 여기 포함되지 않습니다.",
  ];
  const afford = affordableCalls(budgetUsd, models);
  if (afford.calls !== null) {
    lines.push(
      `지금 상한으로는 최대 ${afford.calls}회 부를 수 있습니다 (가장 싼 ${afford.basisModelId} 기준).`
    );
  }
  return lines;
}
