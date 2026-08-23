import type { AcceptanceCriterion, CriterionEvaluation, VerificationReport } from "../types";

/**
 * **이 결과를 무엇이 뒷받침하는가** — product-strategy.md 11절 배지 규칙 + 16.5절 마지막 항목.
 *
 * # 문항은 "문서 태스크의 배지 문구"였다
 *
 * 16.5절이 남긴 항목은 이렇게 적혀 있었다: *"산출물이 코드가 아니면 결과 판정자가 없다.
 * 명세·설계 문서를 산출하는 경우 `VERIFYING`이 침묵하므로 '이 결과는 사용자 확인에만 근거함'을
 * 명시해야 한다."* 그래서 남은 일이 **문서 태스크용 배지 문구를 정하는 것**처럼 보였다.
 *
 * 그런데 그렇게 만들면 두 가지가 어긋난다.
 *
 * 1. **태스크가 문서 산출인지 판정해야 한다** — 그건 또 하나의 추측이고, 틀리면 배지가 틀린다.
 * 2. 더 중요하게, **같은 처지의 코드 태스크를 놓친다.** 테스트 스크립트가 없는 저장소에서
 *    코드를 고친 태스크는 문서 태스크와 **인식론적으로 정확히 같은 자리**에 있다 —
 *    `VERIFYING`이 침묵했고, 결과를 뒷받침하는 것은 사용자 확인뿐이다. 산출물 종류로 가르면
 *    그쪽은 "코드 태스크"라는 이유로 검증된 것처럼 읽힌다.
 *
 * 그래서 축을 바꾼다. **배지는 산출물의 종류가 아니라 판정의 출처를 말한다.** 문서 태스크는
 * 이 규칙의 한 사례일 뿐이고, 따로 다룰 것이 없어진다.
 *
 * # 검수 모델은 여기 들어오지 않는다
 *
 * 11절: *"검수 모델이 통과시켰다는 사실은 결정론적 검사와 동급으로 표시하지 않는다."*
 * 이 함수의 입력에 검수 결과가 **아예 없는 것**이 그 규칙의 구조적 표현이다. 필드를 두고
 * "쓰지 않는다"고 적어두면 언젠가 누군가 쓴다.
 */

export type ResultBasisKind = "deterministic_pass" | "deterministic_fail" | "user_only" | "nothing";

export interface ResultBasis {
  kind: ResultBasisKind;
  /** 배지에 들어가는 짧은 문장. */
  label: string;
  /** 무엇이 뒷받침하고 무엇이 뒷받침하지 않는지 — 한 문장으로. */
  detail: string;
  /**
   * 결정론적 근거가 **실제로** 있는가.
   *
   * UI가 "검증됨" 톤(초록 배지)을 쓸 수 있는 유일한 조건이다. 이 값을 boolean 하나로 두는
   * 이유는, 화면 쪽에서 `kind`를 문자열 비교로 다시 판정하기 시작하면 그 비교가 여러 곳에
   * 생기고 언젠가 하나가 틀리기 때문이다.
   */
  deterministic: boolean;
}

export interface ResultBasisInput {
  /** 작업 후 리포트의 종합 판정. 리포트 자체가 없으면 `undefined`. */
  overall?: VerificationReport["overall"];
  /** 이 태스크에서 확정된 기준. */
  criteria?: Pick<AcceptanceCriterion, "source">[];
  /** 기준별 결정론적 판정. */
  evaluations?: Pick<CriterionEvaluation, "status">[];
}

/**
 * **사용자가 직접 판정한 기준만 센다.**
 *
 * `draft_proposal`은 모델이 스스로 적은 완료 기준이다. 그걸 "사용자 확인"으로 세면 모델이
 * 자기 산출물을 자기가 승인한 것을 근거로 내놓게 된다 — 원칙 4가 검수자에 대해 막는 것과
 * 같은 종류의 자기 승인이다.
 */
function userConfirmedCount(criteria: readonly Pick<AcceptanceCriterion, "source">[]): number {
  return criteria.filter((c) => c.source === "user_decision").length;
}

export function resultBasis(input: ResultBasisInput): ResultBasis {
  const criteria = input.criteria ?? [];
  const evaluations = input.evaluations ?? [];
  const confirmed = userConfirmedCount(criteria);
  const verifiedByTest = evaluations.filter((e) => e.status === "VERIFIED_BY_TEST").length;

  if (input.overall === "pass") {
    return {
      kind: "deterministic_pass",
      label: "검증 통과",
      detail:
        `build/test/lint가 실제로 실행되어 통과했습니다.` +
        (evaluations.length > 0
          ? ` 확정 기준 ${evaluations.length}개 중 ${verifiedByTest}개가 테스트로 확인됐습니다.`
          : ""),
      deterministic: true,
    };
  }

  if (input.overall === "fail") {
    return {
      kind: "deterministic_fail",
      label: "검증 실패",
      detail: "실행된 검증 중 실패한 것이 있습니다.",
      deterministic: false,
    };
  }

  // 여기부터는 `VERIFYING`이 침묵한 자리다 — 명령이 없었든, 돌리지 못했든, 리포트가 아예
  // 없든. **셋 중 어느 것이든 결과를 뒷받침하는 결정론적 근거는 없다**는 점은 같고,
  // 무엇이 침묵의 원인이었는지는 검증 패널이 따로 말한다(그건 사용자가 할 일이 달라지는 축이다).
  if (confirmed > 0) {
    return {
      kind: "user_only",
      label: "사용자 확인에만 근거함",
      detail:
        `결정론적 검증이 이 결과를 뒷받침하지 않습니다. 근거는 사용자가 확정한 기준 ${confirmed}개뿐이며, ` +
        `검증을 통과한 코드 작업과 같은 수준으로 읽으면 안 됩니다.`,
      deterministic: false,
    };
  }

  return {
    kind: "nothing",
    label: "뒷받침하는 근거 없음",
    detail:
      "결정론적 검증도 실행되지 않았고 사용자가 확정한 기준도 없습니다. " +
      "이 결과가 옳다고 말해주는 것이 아무것도 없습니다.",
    deterministic: false,
  };
}
