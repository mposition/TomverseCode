export type ISODateTime = string;

export type Verdict = "ACCEPT" | "REVISE" | "REJECT" | "NEED_USER_INPUT";

export type RiskTier = "auto" | "conditional" | "user_approval" | "blocked";

export type ComplexityTier = "simple" | "standard";

// docs/design/product-strategy.md 4절 — 검수 독립성은 두 축이다.
//   공급자 독립성: 검수자 ≠ 실행자 (multi-engine-routing.md 5절 불변식)
//   서사 독립성:   검수자가 실행자의 자기설명을 보지 않는다 (이 타입)
// blind는 요구사항·저장소 컨텍스트·변경된 코드·테스트 결과만 제공하고,
// 실행 모델의 이름/공급자와 interpretation·rationale은 숨긴다.
//
// **기본값은 `informed`다.** blind를 기본으로 하자는 초기 제안은 실측으로 철회됐다 —
// spike/src/anchoringProbe.ts에서 조작된 초안 3건을 재본 결과 anchoring은 관측되지 않은 반면
// (검수 모델이 확신에 찬 거짓 주장을 명시적으로 반박함), 정보를 숨긴 blind는 지적만 하고
// 수리하지 않아 최종 테스트 통과가 0/3이었다(informed 2/3). 자세한 것은
// docs/design/product-strategy.md 4.1절. n=3 합성 표본이므로 실제 태스크에서 재측정 대상.
export type ReviewMode = "informed" | "blind";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// docs/design/multi-engine-routing.md 3절 — provider/model은 열린 집합이다.
// 유니온 타입으로 고정하면 엔진 추가가 스키마 마이그레이션이 되므로 런타임 값으로 둔다.
export type ProviderId = string;
export type ModelId = string;

/**
 * phase가 어느 모델을 부르는지는 역할로 표현한다 — multi-engine-routing.md 4절·21.6절.
 *
 * # 왜 `reviewer` 하나로는 부족한가
 *
 * 72절 흐름은 검수를 **앞뒤로 나눈다**: B(계획 검토, 코드 전)와 C(결과 검토, 검증 통과 후).
 * 둘 다 `reviewer`로 두면 **어느 검토자가 어느 공급자인가**를 물을 수 없고, 21.6절의 불변식
 * 둘(B는 살아남은 계획의 저자와 달라야 하고, C는 코드를 쓴 어떤 공급자와도 달라야 한다)을
 * **따로 검사할 수 없다.**
 *
 * **`RoleAssignment`에 축을 하나 더하는 대신 값을 더한 이유**: 이 타입은 `activeRoles`와
 * `RoleAssignment.role`만 쓰는 것이 아니라 `ProviderCall.role`·`ToolRequester.role`·
 * `ToolBridge.as(role)`이 함께 쓴다. 축을 더하면 그 셋은 여전히 "reviewer"만 말할 수 있어
 * **72.14절 계측이 B와 C의 호출을 가르지 못한다.** 값을 더하면 그 자리들이 전부 공짜로
 * 구별을 얻는다.
 *
 * **`reviewer`를 지우지 않는다.** `task_events`는 append-only이고 과거 태스크가 그 역할로
 * 호출된 기록이 남아 있다 — 지우면 옛 기록을 읽을 수 없게 된다(72.3절이 `REVIEWING` phase에
 * 대해 적은 것과 같은 구별: 쓰이지 않는 것 / 없는 것).
 *
 * **대조 계획자(A′)에는 이름이 없다.** 하는 일이 A와 완전히 같고 표본이 둘일 뿐이라
 * (13.1절), 이름을 나누면 프롬프트가 갈릴 여지가 생겨 "모델 차이"와 "프롬프트 차이"가 섞인다.
 * `planner` 배정이 둘이고 **순서가 primary를 정한다.**
 */
export type EngineRole =
  | "planner"
  | "executor"
  /** 종전 `REVIEWING`의 초안 검수자. 72.3절에서 standard 경로가 물러났고 기록을 위해 남는다. */
  | "reviewer"
  /** B — 계획 독립 검토자. 살아남은 계획의 저자와 다른 공급자여야 한다(21.6절). */
  | "planReviewer"
  /** C — 결과 검토자. 구현자 공급자 **전부**와 달라야 한다(21.6절). */
  | "resultReviewer";

/**
 * 한 검토 자리가 **어떻게 채워졌는가** — 21.6절 드롭 사다리의 결과.
 *
 * `boolean` 하나로는 "배정됐지만 완전 독립은 아니다"를 말할 수 없다. 21.6절이 그 경우를
 * 명시적으로 남기라고 한 이유는 13.3절보다 정직성이 후퇴하지 않기 위해서다 — B = A′는
 * 자기 계획을 검토하지는 않지만 **같은 스냅샷을 같은 시점에 본 당사자**다.
 */
export type ReviewerIndependence =
  /** 실행자/저자와 다른 공급자로 배정됐다. */
  | "independent"
  /** 배정은 됐으나 완전 독립이 아니다 — 그 사실이 `appliedPolicies`에 남는다. */
  | "shares_provider"
  /** 독립 후보가 없어 드롭했다. **같은 공급자로 "검증한 척"하지 않는다**(원칙 4). */
  | "dropped"
  /** 이 경로에 그 자리가 애초에 없다 (예: `simple`, 또는 72절 흐름 이전의 태스크). */
  | "not_applicable";

/**
 * 사용자가 고르는 네 번째 축 — **고른 모델을 얼마나 깊게 굴리는가**
 * (state-machine-and-protocol.md 72.9절).
 *
 * `PerformanceProfile`과 직교한다: 저쪽은 **어느 모델이 하는가**(모델 교체), 이쪽은
 * **그 모델이 얼마나 하는가**(같은 모델, 추론 예산)다. 한 슬라이더로 합치면
 * `economy` + `high`("싼 모델에게 시간을 더 준다")나 `max` + `low`("가장 센 모델에게 빠르게
 * 묻는다") 중 하나를 표현할 수 없게 되는데, **어느 쪽이 나은지 우리는 모른다.**
 *
 * **닫힌 enum인 것이 중요하다**(multi-engine-routing 21.4절). CLI 경로에서 effort는 명령줄
 * 플래그가 되고, 값의 집합이 유한해야 "실행될 수 있는 argv의 집합이 열거 가능하다"가 유지된다
 * — 여기를 문자열로 열면 원칙 6의 보장이 이 경로에서만 사라진다.
 *
 * **이 축은 `ModelEntry.effort` 매핑표가 각 공급자의 실제 파라미터로 옮긴다.** 매핑이 없는
 * 모델에 `high`를 고르면 아무 일도 일어나지 않으며, **그 사실이 화면에 있어야 한다.**
 *
 * 타입을 `task.ts`가 아니라 여기 두는 이유는 `ComplexityTier`·`ReviewMode`와 같다 —
 * 태스크와 레지스트리가 **둘 다** 쓰는 어휘라 한쪽에 두면 다른 쪽이 거꾸로 import하게 된다.
 */
export type EffortLevel = "low" | "medium" | "high";
