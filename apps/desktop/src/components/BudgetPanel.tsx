import type { TaskBudgetOutcome } from "../types";

/**
 * 이 작업이 공급자 호출에 **얼마를 썼는가** (multi-engine-routing.md 10.6절).
 *
 * # 네 상태를 같은 색으로 그리지 않는다
 *
 * **"상한 안에서 끝났다"와 "상한이 없었다"는 정반대의 사실이다.** 둘 다 조용한 초록으로
 * 보이면 이 화면이 거짓 안심을 준다 — 상한을 끈 사용자야말로 그 사실을 봐야 한다.
 *
 * # 하한을 정확한 값처럼 쓰지 않는다
 *
 * 가격을 모르는 호출이 있으면 합계는 **하한이다.** 모르는 비용을 0으로 더하면 이 숫자가
 * "썼는데 안 썼다"고 말하게 되므로 더하지 않고, 대신 몇 건인지를 함께 보여준다.
 */
export function BudgetPanel({ budget }: { budget: TaskBudgetOutcome }) {
  const approximate = budget.unpricedCalls > 0;
  return (
    <div className="panel">
      <h2>이 작업이 쓴 비용</h2>
      <p className="budget-amount">
        {approximate ? "≥ " : ""}${budget.spentUsd.toFixed(4)}
        {budget.limitUsd !== null && <span className="muted"> / 상한 ${budget.limitUsd.toFixed(2)}</span>}
      </p>

      {budget.state === "not_enforced" && (
        <p className="small warn">
          <strong>이 작업에는 상한이 없었습니다.</strong> 위 금액은 집계한 지출이며, 무언가가 그것을 막고 있었다는
          뜻이 아닙니다.
        </p>
      )}
      {budget.state === "limit_reached" && (
        <p className="small warn">
          남은 예산으로 다음 호출을 예약할 수 없어 <strong>일부 호출을 하지 않았습니다.</strong> 상한을 올려 다시
          실행하면 그 호출부터 다시 시도합니다.
        </p>
      )}
      {budget.state === "blocked" && (
        <p className="small warn">
          예산 원장을 신뢰할 수 없어 이후 호출을 막았습니다{budget.detail ? ` (${budget.detail})` : ""}. 비용을
          확인할 수 없는 상태에서 유료 호출을 계속하는 것은 상한이 없는 것과 같습니다.
        </p>
      )}
      {approximate && (
        <p className="small warn">
          가격을 모르는 모델로 나간 호출이 {budget.unpricedCalls}건 있습니다 —{" "}
          <strong>위 금액은 실제 청구의 하한입니다.</strong>
        </p>
      )}
      {budget.unresolvedUsd > 0 && (
        <p className="small warn">
          과금 여부를 확인할 수 없는 예약이 ${budget.unresolvedUsd.toFixed(4)} 남아 있습니다. 요청이 나간 뒤 응답을
          받지 못한 경우이며, <strong>실제 과금 여부는 공급자 청구 내역으로만 확인됩니다.</strong>
        </p>
      )}

      <p className="muted small">
        상한은 <strong>이 작업 하나</strong>에만 적용됩니다. 다시 실행하면 상한만큼 다시 쓸 수 있습니다 — 승인의
        단위가 작업이기 때문입니다. 그리고 이 금액은 <strong>이 앱이 낸 호출만</strong>의 합계이므로, 같은 키를
        쓰는 다른 도구의 지출은 여기 없습니다.
      </p>
    </div>
  );
}
