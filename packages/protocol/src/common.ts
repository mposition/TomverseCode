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

// docs/design/multi-engine-routing.md 4절 — phase가 어느 모델을 부르는지는 역할로 표현한다.
export type EngineRole = "planner" | "executor" | "reviewer";

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
