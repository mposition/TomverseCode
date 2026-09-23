import type { ChecklistItem, PlanApprovalCardData, VerificationChecklistCardData } from "../types";

/**
 * 게이트 카드가 **무엇을 말하는가** — state-machine 72.4·72.8절.
 *
 * # 왜 화면 밖에 있는가
 *
 * 금액을 어떻게 말할지, 미확인을 어떻게 세는지는 **판정**이고 화면 안에 두면 검증할 방법이
 * 없다(`callPlan.ts`·`approvalQueue.ts`와 같은 자리). `apps/desktop`의 테스트는 `src/lib`의
 * 순수 로직만 컴파일해 DOM 없이 돌린다.
 *
 * # 여기서 하지 않는 것
 *
 * **추정을 실측처럼 보여주지 않는다.** 그리고 **환산되지 않는 배정을 0으로 합산하지
 * 않는다** — 그러면 카드가 "이만큼만 듭니다"라고 거짓을 말한다(72.4절). 그래서 금액은
 * 하나가 아니라 셋이다: 계량 과금분(추정) · 포함된 용량분(환산 불가) · 봉투(상한).
 */

export interface CostLines {
  /** 계량 과금분. **추정임을 문장이 말한다.** */
  metered: string;
  /** 환산되지 않는 배정이 있을 때만. 없으면 `null`이다 — 없는 것을 "0원"으로 적지 않는다. */
  unpriced: string | null;
  /** 봉투의 상한. 금액을 말할 수 없으면 횟수만 말한다. */
  envelope: string;
}

export function costLines(card: PlanApprovalCardData): CostLines {
  const metered =
    `예상 금액 ${formatUsd(card.estimatedCostUsd)} — **추정입니다.** ` +
    "실측 사용량이 도착하면 대체됩니다.";
  const unpriced =
    card.unpricedAssignments.length > 0
      ? `구독에 포함되어 **금액으로 환산되지 않는** 배정이 ${card.unpricedAssignments.length}개 있습니다: ` +
        `${card.unpricedAssignments.join(", ")}. 위 금액에 더하지 않았습니다.`
      : null;
  const envelope =
    card.escalation.budgetUsd === null
      ? `예상 못 한 자리에서 최대 ${card.escalation.maxCalls}회까지 더 부를 수 있습니다 (금액으로 환산되지 않는 경로입니다).`
      : `예상 못 한 자리에서 최대 ${card.escalation.maxCalls}회·${formatUsd(card.escalation.budgetUsd)}까지 더 쓸 수 있습니다.`;
  return { metered, unpriced, envelope };
}

/** `$0.1234` — 0은 "공짜"가 아니라 "계량 과금분이 없다"이므로 그 경우를 문장이 구별한다. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "(알 수 없음)";
  if (usd === 0) return "$0 (계량 과금되는 배정이 없습니다)";
  return `$${usd.toFixed(4)}`;
}

/**
 * 서브태스크 한 줄의 표시 문장.
 *
 * **위험 하한선이 올린 것을 말한다.** 말하지 않으면 사용자는 "왜 이 조각만 비싼가"에
 * 답을 얻지 못하고, `economy`를 골랐는데 `frontier`가 배정된 것을 우리 실수로 읽는다.
 */
export function subtaskLine(subtask: PlanApprovalCardData["subtasks"][number]): string {
  const base = `${subtask.intent} — ${gradeLabel(subtask.grade)}`;
  if (subtask.riskSegments.length === 0) return base;
  return `${base} (위험 경로 ${subtask.riskSegments.join("·")} 때문에 내려가지 않습니다)`;
}

export function gradeLabel(grade: string): string {
  if (grade === "frontier") return "최상급";
  if (grade === "economy") return "경제형";
  // **`unmeasured`를 `economy`로 접지 않는다**(21.4절). 싸다는 것은 가격에 대한 사실이고
  // 등급은 품질에 대한 사실이다.
  if (grade === "unmeasured") return "미측정";
  return grade;
}

/**
 * 체크리스트의 **요약 한 줄** — 72.8절.
 *
 * # 확인된 수를 앞세우지 않는다
 *
 * "3/5 확인됨"으로 적으면 분수가 진행률처럼 읽히고, 나머지 2는 "아직 안 한 것"이 된다.
 * 이 경로에서 미확인은 **정상 상태**다(17.9절: 대부분의 기준이 자동으로 이을 근거가 없다).
 * 그래서 **미확인을 먼저 말한다** — 사용자가 읽어야 하는 것이 그쪽이기 때문이다.
 */
export function checklistSummary(card: VerificationChecklistCardData): string {
  const total = card.items.length;
  if (total === 0) return "확인할 기준이 없습니다 — 이 태스크에는 고정된 기준이 기록되지 않았습니다.";
  const counts = countByGrade(card.items);
  const parts = [`${counts.unverified}건은 **아무도 확인하지 못했습니다**`];
  if (counts.flagged > 0) parts.push(`${counts.flagged}건은 결과 검토가 **지목**했습니다 (확인이 아니라 경고입니다)`);
  if (counts.verified > 0) parts.push(`${counts.verified}건은 결정론적 검증이 확인했습니다`);
  return `기준 ${total}건 중 ${parts.join(", ")}.`;
}

export function countByGrade(items: readonly ChecklistItem[]): {
  verified: number;
  flagged: number;
  unverified: number;
} {
  let verified = 0;
  let flagged = 0;
  let unverified = 0;
  for (const item of items) {
    if (item.grade === "verified") verified += 1;
    else if (item.grade === "flagged_by_review") flagged += 1;
    // **모르는 값은 미확인으로 센다.** 좋은 쪽으로 접으면 화면이 확인되지 않은 것을
    // 확인됐다고 말하게 되고, 그 실패는 "화면이 더 안심시켜 준다"라 아무도 신고하지 않는다.
    else unverified += 1;
  }
  return { verified, flagged, unverified };
}

export function checklistGradeLabel(grade: string): string {
  if (grade === "verified") return "확인됨";
  if (grade === "flagged_by_review") return "검토가 지목";
  return "미확인";
}

/** `AcceptanceCriterion.source` — 출처마다 권위가 다르다(72.2.1절). */
export function sourceLabel(source: string): string {
  if (source === "user_decision") return "사용자가 정함";
  if (source === "plan_outline") return "승인한 계획에서";
  if (source === "draft_proposal") return "모델이 초안에서";
  if (source === "user_message") return "요청 문장에서";
  return source;
}
