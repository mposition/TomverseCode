import type {
  ComplexityTier,
  Disagreement,
  DisagreementField,
  DisagreementReport,
  DraftProposal,
} from "@tomverse/protocol";
import { DISAGREEMENT_FIELD_RANK } from "@tomverse/protocol";

/**
 * 구조적 대조 — docs/design/state-machine-and-protocol.md 17절.
 *
 * # 이건 판정이 아니라 질문 생성이다
 *
 * 두 초안 중 **어느 쪽이 옳은지 여기서 정하지 않는다.** 그건 모델에게 판정을 시키는 것이고,
 * product-strategy.md 16.1절이 모델에게서 빼앗은 권한이다. 여기가 하는 일은 필드 단위로
 * "갈렸다"를 관측해 사용자에게 올릴 강제 선택 질문을 만드는 것뿐이다.
 *
 * # LLM을 부르지 않는다
 *
 * 대조는 **필드 비교 연산**이다. 그래서 별도 phase(`CONTRASTING`)를 만들지 않았고(17.1절),
 * 이 모듈은 순수 함수다 — 같은 입력이면 같은 출력이고, 외부 경계가 없으므로 실패하지 않는다.
 * blocking 판정도 규칙 기반이다: 모델에게 "이게 심각한가"를 물으면 캘리브레이션되지 않은
 * 모델 의견이 사용자 질문의 게이트가 된다(17.4절).
 *
 * # 일치는 검증이 아니다
 *
 * `agreedFields`는 "두 모델이 같은 말을 했다"일 뿐이다. 상관된 오류는 불일치를 만들지 않으므로
 * (16.5절) **일치를 초록 체크로 그리면 안 된다.** 이 모듈은 그 사실을 강제할 수 없고
 * 소비자(UI)가 지켜야 한다 — 그래서 필드 이름을 `agreedFields`로 두고 `verifiedFields` 같은
 * 이름을 쓰지 않았다.
 */

export interface ContrastInput {
  taskId: string;
  proposals: DraftProposal[];
  /** blocking 판정에 쓰인다 (17.4절 requiredTests 규칙). */
  complexityTier: ComplexityTier;
  /** reportId·disagreementId 생성용 — 라운드마다 다른 id가 필요하다. */
  round: number;
}

/** 필드별로 각 초안이 내놓은 값. 자유 서술도 1개짜리 배열로 정규화해 한 형태로 다룬다. */
type FieldExtractor = (proposal: DraftProposal) => string[];

const EXTRACTORS: Record<DisagreementField, FieldExtractor> = {
  doneCriteria: (p) => p.doneCriteria,
  requiredTests: (p) => p.requiredTests,
  // **patch가 아니라 plan에서 뽑는다.** patch를 파싱하면 diff 형식 해석이 끼어들고, 그건
  // "모델이 어디를 고치려 했는가"가 아니라 "우리 파서가 무엇을 읽었는가"를 재는 것이 된다.
  targetPaths: (p) => p.plan.flatMap((step) => step.targetPaths ?? []),
  interpretation: (p) => [p.interpretation],
  risks: (p) => p.risks,
};

const FIELD_LABEL: Record<DisagreementField, string> = {
  doneCriteria: "완료 기준",
  requiredTests: "필요한 검증",
  targetPaths: "수정 위치",
  interpretation: "원인 진단",
  risks: "위험",
};

const QUESTION_TEXT: Record<DisagreementField, string> = {
  doneCriteria: "무엇을 만족해야 이 작업이 끝난 것입니까?",
  requiredTests: "무엇이 확인되어야 합니까?",
  targetPaths: "두 초안이 서로 다른 파일을 고치려 합니다. 어디를 고쳐야 합니까?",
  interpretation: "두 초안이 원인을 다르게 봤습니다. 어느 쪽입니까?",
  risks: "두 초안이 본 위험이 다릅니다. 어느 쪽을 고려해야 합니까?",
};

/**
 * 초안들을 필드 단위로 대조한다.
 *
 * 초안이 1개 이하이면 대조할 것이 없으므로 빈 리포트를 돌려준다 — **예외를 던지지 않는다.**
 * 라우터가 독립 executor 둘을 배정하지 못해 대조를 드롭한 경우가 정상 경로이기 때문이다(13.2절).
 * 그때도 리포트는 만들어져 이벤트로 남는다: "대조하지 않았다"와 "쟁점이 없었다"를 로그에서
 * 구별하려면 `proposalIds`의 개수가 보여야 한다.
 */
export function contrastDrafts(input: ContrastInput): DisagreementReport {
  const { taskId, proposals, complexityTier, round } = input;
  const disagreements: Disagreement[] = [];
  const agreedFields: DisagreementField[] = [];

  if (proposals.length >= 2) {
    // 랭킹 순서대로 만든다 — 예산에 맞춰 자를 때 앞에서부터 자르면 되도록.
    for (const field of DISAGREEMENT_FIELD_RANK) {
      const positions = proposals.map((p) => ({
        proposalId: p.proposalId,
        value: normalizeValues(EXTRACTORS[field](p)),
      }));

      // 양쪽 다 비어 있으면 "갈렸다"가 아니라 "둘 다 말하지 않았다"이다. 이걸 일치로 세면
      // agreedFields가 침묵을 동의로 보고하게 된다.
      if (positions.every((p) => p.value.length === 0)) continue;

      if (allEqual(positions.map((p) => p.value))) {
        agreedFields.push(field);
        continue;
      }

      const verdict = judgeBlocking(
        field,
        positions.map((p) => p.value),
        complexityTier
      );
      disagreements.push({
        disagreementId: `${taskId}-r${round}-${field}`,
        field,
        positions,
        blocking: verdict.blocking,
        blockingReason: verdict.reason,
        question: buildQuestion(field, positions),
      });
    }
  }

  return {
    taskId,
    reportId: `${taskId}-contrast-${round}`,
    proposalIds: proposals.map((p) => p.proposalId),
    disagreements,
    agreedFields,
    createdAt: new Date().toISOString(),
  };
}

/**
 * blocking 판정 — 17.4절의 규칙을 그대로 옮긴 것이다. 모델에게 묻지 않는다.
 *
 * `requiredTests`가 tier를 보는 이유와 그 현재 한계는 17.8절에 적어두었다: tier가 2단계인
 * 지금 대조 자체가 `standard`에서만 돌므로 이 조건은 **현재 언제나 참**이다. 조건을 지운 것과
 * 결과는 같지만 지우지 않은 이유는, tier가 4단계로 늘어날 때 되살아나야 하는 규칙이기
 * 때문이다. 조건이 사라지면 그 사실 자체가 잊힌다.
 */
function judgeBlocking(
  field: DisagreementField,
  values: string[][],
  complexityTier: ComplexityTier
): { blocking: boolean; reason: string } {
  switch (field) {
    case "doneCriteria":
      // 완료 기준이 갈렸다 = 요구 자체가 모호하다. 가장 강한 신호이므로 조건 없이 blocking이다.
      return { blocking: true, reason: "완료 기준이 갈리면 요구 자체가 모호하다는 뜻입니다" };

    case "targetPaths":
      // **다르다고 전부 blocking이 아니다.** 겹치는 파일이 하나라도 있으면 두 초안이 같은
      // 문제를 보고 범위만 다르게 잡은 것이다. 하나도 겹치지 않을 때만 "문제의 위치 자체를
      // 다르게 봤다"가 성립한다.
      return isPairwiseDisjoint(values)
        ? { blocking: true, reason: "두 초안이 겹치는 파일 없이 서로 다른 위치를 고치려 합니다" }
        : { blocking: false, reason: "수정 범위는 다르지만 겹치는 파일이 있어 같은 위치를 보고 있습니다" };

    case "requiredTests":
      return complexityTier === "standard"
        ? { blocking: true, reason: "교차검증 tier에서는 무엇을 검증할지의 이견을 넘기지 않습니다" }
        : { blocking: false, reason: "이 tier에서는 검증 항목 차이를 표시만 합니다" };

    case "interpretation":
    case "risks":
      // 자유 서술이라 표현만 달라도 갈린 것으로 보인다. 이걸 blocking으로 만들면 거의 모든
      // 태스크가 질문을 만들어내고, 질문 예산이 진짜 쟁점에 도달하기 전에 소진된다.
      return { blocking: false, reason: "자유 서술 필드이므로 표시만 합니다" };
  }
}

function buildQuestion(
  field: DisagreementField,
  positions: { proposalId: string; value: string[] }[]
): Disagreement["question"] {
  return {
    text: QUESTION_TEXT[field],
    // **선택지 라벨에 모델 이름을 넣지 않는다**(ui-wireframes 3.9절). 사용자가 요구가 아니라
    // 모델 선호로 판단하게 되기 때문이다. `fromProposalId`는 추적용으로만 남는다.
    options: positions.map((p, index) => ({
      optionId: `${field}-${index + 1}`,
      label: p.value.length > 0 ? p.value.join(" / ") : `${FIELD_LABEL[field]}를 정하지 않음`,
      fromProposalId: p.proposalId,
    })),
    // 둘 다 아닐 수 있다. 강제 선택이 기본이되 자유 입력은 항상 열어둔다(16.2절 ②).
    allowFreeform: true,
  };
}

/** 사람이 읽을 필드 이름. 카드 제목과 감사 로그 요약이 같은 말을 쓰도록 여기서만 정한다. */
export function fieldLabel(field: DisagreementField): string {
  return FIELD_LABEL[field];
}

/** 표기 차이를 갈림으로 세지 않기 위한 정규화. 순서는 의미가 없으므로 정렬한다. */
function normalizeValues(values: string[]): string[] {
  const normalized = values.map((v) => v.trim()).filter((v) => v.length > 0);
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
}

/** 비교는 정규화된 텍스트로 한다 — 대소문자·공백·경로 구분자 차이는 이견이 아니다. */
function comparisonKey(values: string[]): string {
  return values.map(canonical).sort((a, b) => a.localeCompare(b)).join(" ");
}

function canonical(value: string): string {
  return value.replace(/[\\]/g, "/").replace(/\s+/g, " ").trim().toLowerCase();
}

function allEqual(values: string[][]): boolean {
  const first = comparisonKey(values[0] ?? []);
  return values.every((v) => comparisonKey(v) === first);
}

/** 어느 두 초안 사이에도 겹치는 항목이 없는가. */
function isPairwiseDisjoint(values: string[][]): boolean {
  const sets = values.map((v) => new Set(v.map(canonical)));
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      for (const item of sets[i]!) {
        if (sets[j]!.has(item)) return false;
      }
    }
  }
  return true;
}

/**
 * 한 카드에 넣을 강제 선택의 상한.
 *
 * 4인 근거는 실측이 아니라 3.9절 화면 설계다 — 그 이상은 한 화면에 들어가지 않고, 스크롤이
 * 생기는 순간 아래쪽 질문은 "그럴듯하면 아무거나" 눌리는 대상이 된다. 튜닝 대상이다.
 */
export const MAX_QUESTIONS_PER_ROUND = 4;

/**
 * 이번 라운드에 물을 것과 못 물을 것을 나눈다 (17.4절).
 *
 * **여러 불일치를 한 라운드에 묶는다.** 라운드는 왕복 횟수이지 질문 개수가 아니고,
 * 사용자를 세 번 깨우는 것이 최악이다. 한 화면에 강제 선택 3~4개가 낫다.
 *
 * 넘치는 것을 조용히 버리지 않고 `deferred`로 돌려주는 이유: "물어볼 수 없었다"와
 * "쟁점이 없었다"는 다른 사실이고, 전자는 최종 보고에 표시되어야 한다.
 */
export function planQuestionRound(
  report: DisagreementReport,
  maxQuestions = MAX_QUESTIONS_PER_ROUND
): { asked: Disagreement[]; deferred: Disagreement[] } {
  // contrastDrafts가 이미 랭킹 순으로 만들지만 여기서 다시 정렬한다 — 이 함수가 다른 곳에서
  // 만들어진 리포트를 받아도 순서 보장이 깨지지 않아야 한다.
  const blocking = report.disagreements
    .filter((d) => d.blocking)
    .sort((a, b) => DISAGREEMENT_FIELD_RANK.indexOf(a.field) - DISAGREEMENT_FIELD_RANK.indexOf(b.field));
  return { asked: blocking.slice(0, maxQuestions), deferred: blocking.slice(maxQuestions) };
}
