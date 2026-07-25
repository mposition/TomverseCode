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
