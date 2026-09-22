import type {
  AcceptanceCriterion,
  ChecklistItem,
  CriterionEvaluation,
  EscalationAllowance,
  EscalationRequest,
  ModelGrade,
  PlanApprovalCard,
  PlanOutline,
  RoutingDecision,
  TaskLoopLimits,
  VerificationChecklistCard,
} from "@tomverse/protocol";
import type { GradeDecision } from "./grade.js";

/**
 * `standard` 흐름의 **규칙 부분** — state-machine 72.4·72.7·72.8·72.10.2절.
 *
 * # 왜 여기 있는가
 *
 * 이 파일의 함수는 전부 **모델을 부르지 않는다.** 승인 카드의 금액도, 에스컬레이션 봉투의
 * 판정도, 범위 이탈 파일 목록도, 체크리스트의 근거 등급도 계산이다 — 원칙 1대로 결정론적으로
 * 낼 수 있는 것을 모델에게 묻지 않는다.
 *
 * 오케스트레이터 안에 두지 않는 이유는 그 사실을 **테스트가 직접 볼 수 있게** 하기 위해서다.
 * 태스크를 한 바퀴 돌려야만 확인되는 규칙은 실제로는 확인되지 않는다.
 */

/**
 * 계획에서 **제안**할 에스컬레이션 봉투 — 72.10.2절.
 *
 * **제안하는 것은 제품, 정하는 것은 사용자다.** 시작 화면의 예산 상한 입력란과 같은 모양이며
 * (ui-wireframes 3.11절), 제안값은 승인이 아니라 입력란을 채우는 값이다. 천장은
 * `TaskLoopLimits.escalationCalls`이고 **거기 없으면 원칙 5가 사용자 입력에 의존하게 된다.**
 *
 * `budgetUsd`가 `null`이 되는 경우가 있다: 계량 과금되지 않는 배정만 있으면 금액을 말할 수
 * 없다. 0으로 적으면 "공짜"로 읽히는데 그건 72.4절이 금지한 거짓말이다.
 */
export function proposeEscalationAllowance(input: {
  limits: TaskLoopLimits;
  /** 계량 과금분의 추정 금액. 봉투의 상한을 여기서 유도한다. */
  estimatedCostUsd: number;
  /** 금액으로 환산되지 않는 배정이 있는가. */
  hasUnpricedAssignments: boolean;
}): EscalationAllowance {
  const maxCalls = input.limits.escalationCalls;
  // 봉투의 금액은 **이 계획 추정치에 비례**한다. 절대값을 지어내면 큰 태스크에서는 아무것도
  // 못 하고 작은 태스크에서는 상한이 상한이 아니게 된다. 계수 1은 "예상 못 한 자리에 이
  // 계획만큼 더 쓸 수 있다"이고, 숫자는 유도한 값이 아니라 **첫 문턱**이다(72.11절).
  const budgetUsd =
    input.estimatedCostUsd > 0 ? Number(input.estimatedCostUsd.toFixed(6)) : input.hasUnpricedAssignments ? null : 0;
  return { maxCalls, grade: "frontier", budgetUsd };
}

/** 에스컬레이션 판정의 결과. **거절도 이벤트로 남는다**(72.14절 분모가 셋인 이유). */
export type EscalationVerdict =
  | { kind: "allowed"; grade: ModelGrade }
  | { kind: "rejected"; reason: string };

const GRADE_RANK: Record<ModelGrade, number> = {
  // **`unmeasured`를 `economy`로 접지 않는다**(21.4절). 봉투를 넘었는지 판정할 때는
  // `frontier`와 같은 쪽에 둔다 — 재지 않은 것을 "싼 것"으로 통과시키면 봉투가 뜻을 잃는다.
  economy: 0,
  unmeasured: 1,
  frontier: 1,
};

/**
 * 요청이 봉투 안인가 — 72.10.2절.
 *
 * **넘으면 거절하고 중간에 다시 묻지 않는다.** 되묻는 자리를 구현 한복판에 두면 셋이 동시에
 * 깨진다: ① `구현 → 초과 요청 → 승인 → 구현`이 어떤 카운터도 세지 않는 고리가 되고(원칙 5),
 * ② 72.12절의 예약 해제 근거(*"그 사이에 구현이 돌지 않았다"*)가 거짓이 되며,
 * ③ 진행바가 `실행 → 계획 승인`으로 뒤로 간다(72.2.3절).
 *
 * @param calledSoFar 지금까지 **실제로 부른** 횟수 (`TaskCounters.escalationCalls`).
 */
export function judgeEscalation(input: {
  request: EscalationRequest;
  allowance: EscalationAllowance;
  calledSoFar: number;
  /** 이 서브태스크에 이미 배정된 등급. 올라가지 않는 요청은 부를 이유가 없다. */
  currentGrade: ModelGrade;
  /** 봉투 금액 중 이미 쓴 것. `null`이면 금액으로 판정하지 않는다(환산 불가). */
  spentUsd?: number | null;
}): EscalationVerdict {
  const { request, allowance, calledSoFar, currentGrade } = input;
  if (calledSoFar >= allowance.maxCalls) {
    return {
      kind: "rejected",
      reason: `에스컬레이션 봉투를 다 썼습니다 (${calledSoFar}/${allowance.maxCalls}회). 봉투는 중간에 늘릴 수 없습니다.`,
    };
  }
  if (GRADE_RANK[request.proposedGrade] > GRADE_RANK[allowance.grade]) {
    return {
      kind: "rejected",
      reason: `요청 등급 ${request.proposedGrade}가 승인된 봉투의 ${allowance.grade}를 넘습니다.`,
    };
  }
  if (GRADE_RANK[request.proposedGrade] <= GRADE_RANK[currentGrade]) {
    return {
      kind: "rejected",
      reason: `이미 ${currentGrade} 등급으로 배정된 서브태스크라 ${request.proposedGrade}로 올릴 것이 없습니다.`,
    };
  }
  if (allowance.budgetUsd !== null && input.spentUsd != null && input.spentUsd >= allowance.budgetUsd) {
    return {
      kind: "rejected",
      reason: `에스컬레이션 봉투의 금액 상한($${allowance.budgetUsd})을 이미 썼습니다.`,
    };
  }
  return { kind: "allowed", grade: request.proposedGrade };
}

/**
 * 계획 승인 카드를 만든다 — 72.4절.
 *
 * **금액이 하나가 아니라 셋이다**: 계량 과금분(추정) · 포함된 용량분(환산 불가) · 봉투(상한).
 * 하나로 합치면 셋 중 어느 것도 정확히 말하지 못한다.
 */
export function buildPlanApprovalCard(input: {
  plan: PlanOutline;
  grades: readonly GradeDecision[];
  routing: RoutingDecision;
  /**
   * 서브태스크 **하나**를 구현하는 호출의 추정 비용 — 등급별로 다르다.
   *
   * 라우터의 `estimatedCostUsd`는 **역할 배정마다 대표 호출 한 번**을 더한 값이다. 서브태스크
   * 개수는 라우팅 시점에 존재하지 않으므로(72.2.2절: 계획의 산출물이다) 거기 들어갈 수 없고,
   * 그대로 카드에 실으면 **N개짜리 계획의 금액이 1개짜리와 같아진다.** 72.12절이 예약을 이
   * 금액에 묶은 뒤로는 그 차이가 그대로 "승인한 금액과 실제 지출의 간극"이 된다.
   */
  implementationCostPerSubtaskUsd: (grade: ModelGrade) => number | null;
  escalation: EscalationAllowance;
  effortLevel: string;
  /** 승인 시점의 워크스페이스 지문 (72.5절). 못 찍었으면 `null`이다. */
  workspaceFingerprint: string | null;
  /** 계획자가 `unmeasured` 등급인가 (21.6절 — A는 그 필터를 쓰지 않는다). */
  plannerUnmeasured: boolean;
  /** effort를 무시하는 배정이 있으면 그 모델들 (21.4절이 요구한 공개). */
  effortIgnoredBy: readonly string[];
}): PlanApprovalCard {
  const subtaskById = new Map((input.plan.subtasks ?? []).map((s) => [s.subtaskId, s]));
  const notes: string[] = [];

  if (input.plannerUnmeasured) {
    notes.push(
      "이 계획을 세운 모델은 **아직 측정되지 않은 등급**입니다 — 승인하시는 판단이 어떤 급의 " +
        "것인지 알 수 없습니다(21.6절)."
    );
  }
  if (input.effortIgnoredBy.length > 0) {
    notes.push(
      `다음 모델은 실행 강도(effort) 손잡이가 없습니다: ${input.effortIgnoredBy.join(", ")} — ` +
        "올린 만큼 더 생각한 결과가 오지 않습니다."
    );
  }
  // **드롭된 검토 자리를 카드가 말한다.** 비용만 보여주고 무엇이 빠졌는지 감추면 승인이
  // 반쪽이다. 라우터가 남긴 사유를 그대로 옮긴다 — 여기서 문장을 다시 만들면 둘이 갈라진다.
  for (const policy of input.routing.appliedPolicies) {
    if (
      policy.startsWith("plan_review_dropped") ||
      policy.startsWith("result_review_dropped") ||
      policy.startsWith("contrast_dropped") ||
      policy.startsWith("plan_reviewer_was_contrast_participant") ||
      policy.startsWith("result_reviewer_shares_provider_with_plan_reviewer")
    ) {
      notes.push(policy);
    }
  }
  notes.push(
    "예상 못 한 자리에서 더 센 모델이 필요하면 봉투 안에서만 부릅니다. " +
      "**봉투를 넘는 요청은 거절되며 중간에 늘릴 수 없습니다.**"
  );
  notes.push(
    "에스컬레이션이 일어나면 **결과 검토(C)가 빠질 수 있습니다** — 코드를 쓴 공급자가 늘어나면 " +
      "그와 다른 검토자를 찾지 못할 수 있기 때문입니다."
  );

  // **서브태스크 개수와 등급이 금액을 정한다**(72.10절). 라우터의 추정에 구현 호출분을
  // 더한다 — 라우터는 대표 호출 한 번만 더했고 그 자리에는 분해가 없었다.
  let implementationUsd = 0;
  const unpriced = [...input.routing.unpricedAssignments];
  for (const g of input.grades) {
    const per = input.implementationCostPerSubtaskUsd(g.final);
    if (per === null) {
      // **0으로 더하지 않는다.** 모르는 것을 0으로 합산하면 카드가 "이만큼만 듭니다"라고
      // 거짓을 말한다 — 환산 불가 배정과 같은 규칙이다.
      unpriced.push(`구현(${g.subtaskId}, 등급 ${g.final}): 단가를 알 수 없습니다`);
      continue;
    }
    implementationUsd += per;
  }

  return {
    summary: input.plan.summary,
    steps: input.plan.steps.map((s) => s.intent),
    subtasks: input.grades.map((g) => ({
      subtaskId: g.subtaskId,
      intent: subtaskById.get(g.subtaskId)?.intent ?? g.subtaskId,
      grade: g.final,
      riskSegments: g.riskSegments,
    })),
    estimatedCostUsd: input.routing.estimatedCostUsd + implementationUsd,
    unpricedAssignments: unpriced,
    // **effort는 금액에 곱하지 않는다.** 승인 시점에 "얼마나 늘어난다"를 말할 근거가 없다 —
    // 추론 토큰 수는 호출 전에 알 수 없다. 모르는 배수를 지어내 곱하면 카드가 정확해 보이는
    // 만큼 정확히 틀린다(72.4절).
    estimateCaveats: [
      "서브태스크의 실제 길이",
      "검증 실패로 고치기를 반복하는 횟수",
      "에스컬레이션 발생 여부",
      `실행 강도 ${input.effortLevel} — 추정이 그만큼 헐거워집니다(금액에 곱하지 않았습니다)`,
    ],
    escalation: input.escalation,
    notes,
    workspaceFingerprint: input.workspaceFingerprint,
  };
}

/**
 * 계획에 없던 파일 — 72.7절의 **모델 없이 내는 절반**.
 *
 * `filesToChange`와 실제 diff의 파일 목록은 둘 다 우리가 갖고 있다. 그래서 이 판정은
 * 결정론적이고, **C를 드롭한 사용자에게도 동작한다.**
 *
 * **위반이 아니라 체크리스트 항목이다.** `filesToChange`는 그 타입 주석이 이미 "확정이 아니다,
 * 창 밖에 관련 지점이 남아 있을 수 있다"고 경고한 값이므로 판정하지 않고 보여준다.
 */
export function unplannedPaths(planned: readonly string[], mutated: readonly string[]): string[] {
  const inPlan = new Set(planned.map(normalizePath));
  return [...new Set(mutated.map(normalizePath))].filter((p) => !inPlan.has(p)).sort();
}

function normalizePath(p: string): string {
  // **경로 구분자를 섞어 비교하지 않는다.** 계획은 모델이 쓴 문자열이고 변경 목록은 도구가
  // 낸 값이라, Windows에서 한쪽만 `\`가 되면 "계획에 없던 파일"이 전부로 부풀어 오른다.
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 검증 체크리스트 — 72.8절. **17.9절이 이미 계산하던 여집합의 화면**이다.
 *
 * 새 판정 로직이 아니다. 여기서 새로 하는 일은 C가 지목한 항목에 `flagged_by_review`를 다는
 * 것뿐이고, **그 등급은 확인이 아니라 경고다.**
 *
 * C가 "괜찮아 보입니다"라고 한 항목은 `verified`가 되지 않는다 — 17.9절이 정한 확인의 정의는
 * **검증 출력에 나타났는가**이고 모델 의견은 거기 해당하지 않는다. 이 자리가 이 단계에서
 * 가장 조용히 썩을 수 있는 곳이다: 뚫리면 "측정하지 않은 것을 검증됐다고 말하지 않는다"가
 * 제품 안에서 깨지는데, 증상이 "화면이 더 안심시켜 준다"라 아무도 신고하지 않는다.
 */
export function buildVerificationChecklist(input: {
  criteria: readonly AcceptanceCriterion[];
  evaluations: readonly CriterionEvaluation[];
  /** C가 지목한 기준 id들. 지목은 **경고이지 확인이 아니다.** */
  flaggedCriterionIds: readonly string[];
  unplannedPaths: readonly string[];
  /** 결과 검토(C)가 돌았는가. 돌지 않았으면 그 사실을 목록에 적는다. */
  resultReviewRan: boolean;
  /** 계획 검토(B)를 사용자가 생략했는가 — 72.4절이 "체크리스트에 적힌다"고 정했다. */
  planReviewSkipped: boolean;
  /** 그 밖에 적을 것 (드롭 사유 등). */
  extraNotes?: readonly string[];
}): VerificationChecklistCard {
  // **`VERIFIED_BY_TEST`만 확인이다**(17.9절). `CONTRADICTED_BY_TEST`는 반증이고
  // `UNVERIFIABLE_AUTOMATICALLY`는 침묵이며, 둘 다 "확인됨"이 아니다.
  const verifiedIds = new Set(
    input.evaluations.filter((e) => e.status === "VERIFIED_BY_TEST").map((e) => e.criterionId)
  );
  const flagged = new Set(input.flaggedCriterionIds);

  const items: ChecklistItem[] = input.criteria.map((c) => ({
    text: c.text,
    // **순서가 규칙이다.** `flagged`를 먼저 보면 검증이 확인한 항목도 경고로 내려간다.
    // 검증이 확인한 것은 확인된 것이고, C의 지적은 그 위에 얹는 말이 아니다(원칙 1).
    grade: verifiedIds.has(c.criterionId) ? "verified" : flagged.has(c.criterionId) ? "flagged_by_review" : "unverified",
    source: c.source,
  }));

  const notes: string[] = [];
  if (!input.resultReviewRan) {
    // **짧아진 목록을 그냥 보여주면 사용자는 확인할 것이 적다고 읽는다**(72.8절).
    notes.push("이 목록은 **3자 검토 없이** 만들어졌습니다 — 결과 검토(C)가 배정되지 않았습니다.");
  }
  if (input.planReviewSkipped) {
    notes.push("계획 승인 시 **독립 검토를 생략**하기로 하셨습니다 — 계획은 검토되지 않았습니다.");
  }
  if (input.unplannedPaths.length > 0) {
    notes.push(
      `계획에 없던 파일 ${input.unplannedPaths.length}개가 변경되었습니다. ` +
        "계획의 파일 목록은 확정이 아니므로 **위반이 아니라 확인 항목**입니다."
    );
  }
  notes.push(...(input.extraNotes ?? []));

  return { items, notes, unplannedPaths: [...input.unplannedPaths] };
}
