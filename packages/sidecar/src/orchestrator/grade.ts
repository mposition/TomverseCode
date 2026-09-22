import type { ModelGrade, PerformanceProfile, PlanSubtask } from "@tomverse/protocol";
import { riskSegmentsIn } from "../triage.js";

/**
 * 서브태스크의 **최종 등급**을 정한다 — state-machine 72.10절.
 *
 * ```
 * 서브태스크 등급 = clamp( 계획 모델의 판정 , PerformanceProfile )
 *                   단, 경로 기반 위험 하한선 아래로는 내려가지 않는다
 * ```
 *
 * # 이 계산은 **규칙이라 모델을 부르지 않는다**
 *
 * 그래서 승인 카드가 보여주는 것이 "모델이 그렇게 말했다"가 아니라 **계산이 끝난 최종
 * 등급**이 될 수 있다(72.2.2절). 모델이 내는 것은 `proposedGrade`이고 이름 그대로 제안이다.
 *
 * # `PerformanceProfile`은 등급을 고르지 않고 **가둔다**
 *
 * | 프로파일 | clamp | 뜻 |
 * |---|---|---|
 * | `economy` | 위를 `economy`로 막는다 | 계획이 `frontier`라 해도 내린다 |
 * | `balanced` | **막지 않는다** | 계획 모델의 판정을 그대로 쓴다(항등) |
 * | `max` | 아래를 `frontier`로 막는다 | 전부 `frontier` |
 *
 * **내릴 수 있어야 한다는 것이 중요하다.** 내리지 못하면 `economy`/`balanced` 프로파일이
 * 아무 일도 하지 않는다 — 싼 모델에 쉬운 조각을 주는 것이 그 프로파일의 전부이기 때문이다.
 *
 * # 위험 하한선은 clamp보다 세다
 *
 * `economy`를 골라도 `auth/`·`payment/` 경로의 서브태스크는 내려가지 않는다. **사용자가
 * 고르는 것은 비용이지 위험 감수 수준이 아니고**, 후자를 비용 선택에 딸려 보내면 그 선택의
 * 뜻이 달라진다.
 *
 * 하한선의 정본은 TRIAGE의 `riskPathSegments`다 — 여기 목록을 복사하면 두 자리가 갈리고,
 * 갈리는 날 "결제 코드는 올라간다"가 한쪽에서만 참이 된다.
 *
 * # `unmeasured`를 어떻게 다루는가
 *
 * **`economy`로 접지 않는다**(21.4절). 싸다는 것은 가격에 대한 사실이지 품질에 대한 사실이
 * 아니다. clamp에 대해서는 **`frontier`와 같은 쪽으로 취급한다** — `economy` 프로파일이
 * 미측정 모델을 그대로 통과시키면 "싼 것만 쓰겠다"는 선택이 지켜지지 않기 때문이다.
 * 반대로 `max`는 미측정을 `frontier`로 **올리지 않는다**: 올리면 재지 않은 것을 가장 센
 * 등급이라고 말하는 셈이고, 그건 21.4절이 막는 바로 그 세탁이다.
 */
export interface GradeDecision {
  subtaskId: string;
  /** 계획 모델이 제안한 값. 기록에 남는다 — 규칙이 무엇을 바꿨는지 알 수 있어야 한다. */
  proposed: ModelGrade;
  /** clamp와 하한선을 지난 값. 라우팅과 비용이 이것을 쓴다. */
  final: ModelGrade;
  /**
   * 하한선이 올렸다면 **무엇 때문인가** — 경로에서 찾은 위험 세그먼트들.
   *
   * 비어 있으면 하한선이 걸리지 않았다는 뜻이다. 화면이 "왜 이 조각만 비싼가"에 답할 수
   * 있어야 하므로 사유를 값으로 남긴다.
   */
  riskSegments: string[];
  /** 프로파일이 판정을 바꿨는가. `balanced`는 항등이므로 언제나 false다. */
  clamped: boolean;
}

/** `max`가 미측정을 올리지 않는다는 규칙 때문에 순서 비교가 아니라 명시적 표가 낫다. */
function clampByProfile(proposed: ModelGrade, profile: PerformanceProfile): ModelGrade {
  if (profile === "balanced") return proposed;
  if (profile === "economy") {
    // 미측정도 내린다 — 그러지 않으면 "싼 것만 쓰겠다"는 선택이 지켜지지 않는다.
    return "economy";
  }
  // `max`: 아래를 frontier로 막되 **미측정은 올리지 않는다.**
  return proposed === "economy" ? "frontier" : proposed;
}

export function decideGrade(
  subtask: PlanSubtask,
  profile: PerformanceProfile,
  riskPathSegments: readonly string[]
): GradeDecision {
  const clamped = clampByProfile(subtask.proposedGrade, profile);
  const riskSegments = [
    ...new Set(subtask.files.flatMap((f) => riskSegmentsIn(f, riskPathSegments))),
  ].sort();
  // **하한선은 clamp **뒤에** 적용된다.** 앞에 두면 `economy` 프로파일이 하한선을 도로
  // 내려 버린다 — 그 순서가 이 함수에서 유일하게 틀리기 쉬운 자리다.
  const final: ModelGrade = riskSegments.length > 0 ? "frontier" : clamped;
  return {
    subtaskId: subtask.subtaskId,
    proposed: subtask.proposedGrade,
    final,
    riskSegments,
    clamped: clamped !== subtask.proposedGrade,
  };
}

export function decideGrades(
  subtasks: readonly PlanSubtask[],
  profile: PerformanceProfile,
  riskPathSegments: readonly string[]
): GradeDecision[] {
  return subtasks.map((s) => decideGrade(s, profile, riskPathSegments));
}
