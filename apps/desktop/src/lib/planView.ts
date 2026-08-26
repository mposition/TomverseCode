/**
 * 계획을 **화면 문장으로** 옮긴다 — state-machine 53절, ui-wireframes 3.27절.
 *
 * # 이 화면이 하기 쉬운 거짓말
 *
 * **계획을 완료처럼 그리는 것** — 3.26절이 답변에 대해 말한 것과 같다.
 *
 * **그리고 `filesToChange`를 "바뀔 파일"로 그리는 것.** 그건 아직 아무것도 바뀌지 않았다는
 * 사실을 지운다. 더 나쁜 것은 그 목록이 **추정**이라는 점이다: 모델이 본 것은 예산이 고른
 * 부분집합이고, 관련 지점이 창 밖에 남아 있을 수 있다(context-engine 15절). 확정된 목록처럼
 * 그리면 사용자는 "여기만 바뀌는구나"로 읽는다.
 *
 * **그리고 빈 `risks`를 안심으로 읽는 것.** 이 경로에는 결정론적 판정자가 없다 — 만든 것이
 * 없으므로 검증할 것도 없다. 모델이 위험을 말하지 않은 것은 위험이 없다는 뜻이 아니다.
 */

export interface PlanLike {
  summary: string;
  steps: { intent: string; files: string[] }[];
  filesToChange: string[];
  risks: string[];
  openQuestions: string[];
  model: string;
}

export interface PlanView {
  show: boolean;
  summary: string;
  steps: { n: number; intent: string; files: string[] }[];
  /** 건드릴 것으로 **보이는** 파일들. 확정이 아니다. */
  filesToChange: string[];
  filesNote: string;
  risks: string[];
  riskNote: string;
  openQuestions: string[];
  /** 무엇이 이 계획을 뒷받침하지 **않는지**. 변경용 배지 대신 붙는다. */
  caveat: string;
  /** 다음 걸음이 있다는 것을 말한다 — 계획은 종착이지만 이야기의 끝은 아니다. */
  nextStep: string;
  /** 경고 톤 — 모델이 위험이나 열린 질문을 말했을 때. */
  warn: boolean;
}

const CAVEAT =
  "이 계획은 검증되지 않았습니다 — 아직 아무것도 만들지 않았으므로 build/test가 판정할 대상이 없습니다. " +
  "모델이 본 것은 이번 태스크의 컨텍스트뿐이며, 그것은 예산이 고른 부분집합입니다.";

/**
 * **다음 걸음을 말한다.** 계획은 종착 상태이지만 사용자의 이야기는 여기서 끝나지 않는다 —
 * 답변과 계획을 다른 종착지로 나눈 이유가 바로 이것이고(53절), 화면이 그 걸음을 말하지
 * 않으면 나눈 이유가 화면에서 사라진다.
 *
 * **그리고 "승인" 버튼을 두지 않는다.** 계획을 승인해서 실행이 이어지면, 사용자가 승인한 것은
 * 계획이고 실제로 도는 것은 그 계획으로 만든 patch다 — 둘 사이에 아무 보장이 없다. 실행은
 * 새 태스크로 시작하고 거기서 평소의 승인 경로를 지난다.
 */
const NEXT_STEP =
  "이 계획대로 진행하려면 새 작업을 \"고치기\"로 시작하세요. 계획을 그대로 실행하는 버튼은 " +
  "없습니다 — 승인한 계획과 실제로 적용되는 patch 사이에 보장이 없기 때문입니다.";

export function planView(plan: PlanLike | null | undefined): PlanView {
  if (!plan) {
    return {
      show: false,
      summary: "",
      steps: [],
      filesToChange: [],
      filesNote: "",
      risks: [],
      riskNote: "",
      openQuestions: [],
      caveat: CAVEAT,
      nextStep: NEXT_STEP,
      warn: false,
    };
  }

  return {
    show: true,
    summary: plan.summary,
    steps: plan.steps.map((step, i) => ({ n: i + 1, intent: step.intent, files: step.files })),
    filesToChange: plan.filesToChange,
    filesNote:
      plan.filesToChange.length > 0
        ? // **"바뀔 파일"이라고 쓰지 않는다.** 아직 아무것도 바뀌지 않았고, 이 목록은 추정이다.
          `건드릴 것으로 **보이는** 파일 ${plan.filesToChange.length}개 — 확정이 아닙니다.`
        : "모델이 건드릴 파일을 대지 않았습니다 — 이 계획은 코드에 근거하지 않았을 수 있습니다.",
    risks: plan.risks,
    riskNote:
      plan.risks.length > 0
        ? "모델이 다음을 위험으로 밝혔습니다"
        : // 침묵을 안심으로 바꾸지 않는다 — 3.26.3절과 같은 규칙이다.
          "모델이 위험을 밝히지 않았습니다 — 위험이 없다는 뜻은 아닙니다.",
    openQuestions: plan.openQuestions,
    caveat: CAVEAT,
    nextStep: NEXT_STEP,
    warn: plan.risks.length > 0 || plan.openQuestions.length > 0,
  };
}
