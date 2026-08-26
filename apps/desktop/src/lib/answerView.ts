/**
 * 답변을 **화면 문장으로** 옮긴다 — state-machine 51절, ui-wireframes 3.26절.
 *
 * # 이 화면이 하기 쉬운 거짓말
 *
 * **답변을 완료처럼 그리는 것.** 51절은 `COMPLETED`와 `ANSWERED`를 나눴는데, 그 이유는
 * 상태 머신 안쪽에만 있는 사실이 아니다 — 사용자가 "검증을 통과한 변경"과 "아무것도 바꾸지
 * 않은 답변"을 구별해야 하기 때문이다. 화면이 둘을 같은 초록 체크로 그리면 그 구별이 여기서
 * 사라진다.
 *
 * **그리고 변경용 배지를 그대로 쓰는 것.** `resultBasis`는 *"이 **변경**을 무엇이
 * 뒷받침하는가"*에 답하는데, 답변에는 변경이 없다. 그 배지를 붙이면 "뒷받침하는 것이 없다"가
 * 뜨고, 그 문장은 사실이지만 **사고처럼 읽힌다** — 질문 경로에 판정자가 없는 것은 사고가
 * 아니라 그 경로의 성질이다(51.4절).
 *
 * 그래서 답변에는 **다른 문장**을 붙인다: 무엇이 이 답을 뒷받침하지 **않는지**를 말한다.
 */

export interface AnswerLike {
  answer: string;
  citedFiles: string[];
  missingContext: string[];
  model: string;
}

export interface AnswerView {
  /** 이 영역을 그릴 것인가. */
  show: boolean;
  /** 답 본문. */
  answer: string;
  /** 답이 기댄 파일들. 비어 있으면 파일에 기대지 않았다는 뜻이며, 그 사실도 말한다. */
  citedFiles: string[];
  citedNote: string;
  /**
   * 모델이 스스로 밝힌 모자란 컨텍스트. **비어 있는 것과 없는 것을 구별한다** —
   * 비어 있으면 "모델이 부족하다고 말하지 않았다"이지 "부족한 것이 없다"가 아니다.
   */
  missingContext: string[];
  missingNote: string;
  /** 무엇이 이 답을 뒷받침하지 **않는지**. 변경용 배지 대신 붙는다. */
  caveat: string;
  /** 답 옆에 경고 톤을 쓸 것인가 — 모델이 모자란 것을 밝혔을 때. */
  warn: boolean;
}

const CAVEAT =
  "이 답은 검증되지 않았습니다 — 질문에는 실행할 것도 검사할 것도 없으므로 build/test가 판정하지 않습니다. " +
  "모델이 본 것은 이번 태스크의 컨텍스트뿐이며, 그것은 예산이 고른 부분집합입니다.";

export function answerView(answer: AnswerLike | null | undefined): AnswerView {
  if (!answer) {
    return {
      show: false,
      answer: "",
      citedFiles: [],
      citedNote: "",
      missingContext: [],
      missingNote: "",
      caveat: CAVEAT,
      warn: false,
    };
  }

  return {
    show: true,
    answer: answer.answer,
    citedFiles: answer.citedFiles,
    citedNote:
      answer.citedFiles.length > 0
        ? `이 답이 기댄 파일 ${answer.citedFiles.length}개`
        : // **"파일을 보지 않았다"는 사실을 말한다.** 빈 목록을 그냥 숨기면 사용자는 답이
          // 코드에 근거한다고 가정한다.
          "모델이 기댄 파일을 밝히지 않았습니다 — 이 답은 코드에 근거하지 않았을 수 있습니다.",
    missingContext: answer.missingContext,
    missingNote:
      answer.missingContext.length > 0
        ? "모델이 다음을 보지 못했다고 밝혔습니다"
        : // 침묵을 안심으로 바꾸지 않는다.
          "모델이 모자란 것을 밝히지 않았습니다 — 부족한 것이 없다는 뜻은 아닙니다.",
    caveat: CAVEAT,
    warn: answer.missingContext.length > 0,
  };
}
