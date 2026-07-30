# 멀티엔진 라우팅 설계 (제안)

status: **accepted** — 방향 승인됨(2026-07-25). 9절 0단계부터 구현.
관련: [state-machine-and-protocol.md](./state-machine-and-protocol.md) (TRIAGE/13절 스파이크 결과), [process-architecture.md](./process-architecture.md) (Provider Adapter 소유권)

## 1. 검토 결론 요약

제안서의 **중심 주장은 이미 우리 Phase 0 스파이크가 실측으로 증명한 것과 같다.** "모든 요청에 3개 모델을 호출하지 말라"는 제안서의 경고는, 우리가 5개 픽스처에서 교차검증이 정확도 이득 0%에 비용 1.63배·지연 1.70배였음을 확인하고 TRIAGE를 도입한 것과 정확히 동일한 결론이다. 그런 의미에서 제안서의 방향성은 채택할 가치가 있다.

**그러나 같은 스파이크가 제안서의 도입 계획에는 반대 근거도 제공한다.** 우리는 아직 *어려운* 태스크에서 교차검증이 단일 모델보다 나은지조차 검증하지 못했다(state-machine-and-protocol.md 12절 미해결 항목). 2개 엔진의 가치가 미검증인 상태에서 5~10개로 늘리는 것은, 최초 아키텍처 리뷰에서 지적했던 "복잡도 예산 초과"를 반복하는 것이다.

| 구분 | 항목 | 판단 근거 |
|---|---|---|
| **지금 채택** | 능력(capability) 기반 Model Registry | provider를 타입이 아닌 런타임 값으로. 지금 2곳 수정이면 끝나지만, 나중엔 DB 마이그레이션. **Tomverse Insight에 이미 11개 공급자 레지스트리가 있어 카탈로그는 재사용 가능(11절)** |
| **지금 채택** | Role 추상화 (planner/executor/reviewer) | 상태 머신은 거의 안 바뀜(6절) — 이미 잘 분리돼 있었음 |
| **지금 채택** | 검수자 독립성 불변식 | 제안서가 과소평가한 안전 속성. 코드로 강제해야 함(5절) |
| **지금 채택** | 라우팅 결정의 이벤트 로그 기록 | 데이터 기반 라우터의 부트스트랩 전제조건(8절) |
| **다음** | Gemini 어댑터 1개 | 레지스트리 추상화를 *검증*하는 용도. 3번째 구조화 출력 방식이라 추상화가 새는지 바로 드러남 |
| **보류** | Qwen/Mistral/DeepSeek/xAI | 어댑터당 실제 유지보수 비용 발생. 근거 데이터 없이 추가할 이유 없음 |
| **보류** | 데이터 기반 자동 라우터 | 평가 데이터가 없음. 지금 만들면 "추측이 담긴 설정 파일"일 뿐 |
| **보류** | planner/executor 분리 실행 | 표준 태스크당 LLM 호출 3회 = 스파이크가 이미 비싸다고 판정한 방향 |
| **보류** | Private/로컬 모델 모드 | 어댑터가 아니라 별도 제품 라인(GPU 요구사항, 배포, 모델 관리) |
| **반대** | Copilot을 엔진으로 사용 | 제안서 결론에 동의 — 벤치마크 대상이지 통합 대상 아님 |
| **반대** | "지원 엔진 수"를 목표 지표로 | 허영 지표. 경쟁력은 라우팅 품질이지 엔진 개수가 아님 |

## 2. 핵심 판단: 왜 "타입은 지금, 엔진은 나중"인가

두 작업은 비용 곡선이 정반대다.

**타입/추상화 작업은 지금이 최저점이다.** 현재 provider가 하드코딩된 곳은 정확히 2곳이다.

```
packages/protocol/src/snapshot.ts:23  tokenBudget: { provider: "openai" | "anthropic"; ... }[]
packages/protocol/src/tools.ts:18     requestedBy: "openai" | "claude" | "orchestrator"
```

그리고 SQLite 데이터베이스는 아직 **한 번도 생성된 적이 없다**(7절 DDL은 문서상 설계일 뿐). 즉 지금 바꾸면 파일 2개 수정이고, 사용자 데이터가 쌓인 뒤엔 스키마 마이그레이션 + 과거 이벤트 로그 해석 문제가 된다.

**반대로 엔진 추가는 지금이 최고점이다.** 어댑터는 한 번 만들면 끝이 아니라 계속 유지해야 한다. 제안서 스스로 지적했듯 "OpenAI 호환 API"라도 tool call ID 연결, 병렬 호출, strict schema 준수, 스트리밍 이벤트, reasoning 보존, 중단·재개, 오류·rate limit 형식이 전부 다르다. 우리는 이미 이 함정을 한 번 밟았다 — `gpt-5`가 Organization Verification을 요구해 스파이크 실행이 막혔고 `gpt-4.1`로 폴백해야 했다(13.3절). 공급자 N개 × 역할 M개 = N×M개의 동작을 검증해야 하는데, 우리는 아직 핵심 루프(Tool 실행, FIX_LOOP)조차 구현 전이다.

**결론: 멀티엔진을 "지원"하는 구조는 지금 만들고, 실제 엔진은 핵심 루프가 동작한 뒤에 하나씩 붙인다.**

## 3. Model Registry

```typescript
type ProviderId = string;   // "openai" | "anthropic" | "google" | ... — 열린 집합
type ModelId = string;      // "gpt-5.1", "claude-sonnet-5", ...

type StructuredOutputMode =
  | "none"
  | "json_mode"          // JSON 강제만, 스키마 미준수 가능
  | "strict_schema"      // OpenAI Responses API text.format json_schema strict
  | "forced_tool_use"    // Anthropic tool_choice: { type: "tool" }
  | "response_schema";   // Gemini responseSchema 계열

// Insight의 실증된 구분을 그대로 채택 (11절) — 어댑터를 모델별로 두지 않고
// "공급자 전용 SDK가 필요한가"로 나눈다.
type WireProtocol = "native" | "openai-compatible";

interface ModelEntry {
  modelId: ModelId;
  providerId: ProviderId;
  protocol: WireProtocol;
  apiBaseUrl: string;              // openai-compatible이면 이 값만 바꿔 공용 어댑터 재사용

  capabilities: {
    toolCalling: "none" | "basic" | "parallel";
    structuredOutput: StructuredOutputMode;
    imageInput: boolean;
    maxContextTokens: number;
    maxOutputTokens: number;
  };

  economics: {
    inputPerMTok: number;
    outputPerMTok: number;
    pricingAsOf: ISODateTime;      // 가격은 빠르게 낡는다 — 언제 기준인지 반드시 기록
  };

  availability: {
    requiresOrgVerification: boolean;  // gpt-5 사건에서 배운 축
    dataRegion?: string;               // 기업/데이터 주권 정책용
    deprecatedAfter?: ISODateTime;
  };

  // 8절 부트스트랩 참조 — 초기엔 비어있고 실제 실행 데이터가 쌓이면 채워진다
  evaluation?: {
    sampleCount: number;
    verificationPassRate: number;      // VERIFYING을 통과한 비율
    medianLatencyMs: number;
    medianCostUsd: number;
    lastUpdatedAt: ISODateTime;
  };
}
```

**레지스트리는 정적 데이터가 아니라 사용자별로 해석된다.** `requiresOrgVerification: true`인 모델은 해당 사용자의 API 키가 실제로 그 모델에 접근 가능한지 확인되기 전까지 "사용 가능"으로 취급하지 않는다. BYOK 환경에서 모델 가용성은 전역 사실이 아니라 자격증명별 사실이다 — 우리가 스파이크에서 겪은 `model_not_found`가 정확히 이 케이스였다.

## 4. Role 추상화와 라우팅

```typescript
type EngineRole = "planner" | "executor" | "reviewer";

interface RoleAssignment {
  role: EngineRole;
  modelId: ModelId;
  providerId: ProviderId;
  reason: string;        // 왜 이 모델이 선택됐는지 — 감사 로그 및 UI 표시용
}

interface RoutingDecision {
  taskId: string;
  complexityTier: ComplexityTier;      // 기존 TRIAGE 결과를 그대로 포함
  activeRoles: EngineRole[];           // simple이면 ["executor"] 하나뿐
  assignments: RoleAssignment[];
  appliedPolicies: string[];           // forceComplexityTier 등 override 흔적
  estimatedCostUsd: number;
  decidedAt: ISODateTime;
}
```

역할 정의:
- **`executor`** — 항상 활성. 실제 수정안(plan + patch)을 만든다. 현재 `DRAFTING`(standard) 또는 `SINGLE_MODEL_FIX`(simple)가 하는 일.
- **`reviewer`** — `complexityTier = standard`일 때만 활성. 현재 `REVIEWING`.
- **`planner`** — **기본 비활성.** 대규모 리팩터링에서 저비용 대용량 컨텍스트 모델이 먼저 계획만 세우는 용도. 역할 시스템에 *표현 가능하게* 두되 **지금은 켜지 않는다** — 표준 태스크당 LLM 호출이 3회가 되는데, 이는 스파이크가 이미 "쉬운 태스크엔 2회도 과하다"고 판정한 방향의 반대다. 실제 데이터로 큰 태스크에서 이득이 확인되면 그때 켠다.

**중요: 이건 제안서의 "Planner ≠ Executor ≠ Reviewer"를 그대로 받는 게 아니라, 역할을 정의하되 기본 활성 조합은 스파이크 결과에 맞춘 것이다.**

## 5. 검수자 독립성 불변식 (제안서가 과소평가한 부분)

제안서는 라우팅 표에서 "실행자와 다른 공급자"를 *권고*로만 적었다. 하지만 이건 권고가 아니라 **제품의 존재 이유를 지탱하는 불변식**이다.

교차검증의 전체 가치는 검수자가 실행자와 *독립적으로* 판단한다는 데서 온다. 라우터가 비용 최적화를 하다가 executor와 reviewer에 같은 공급자(심지어 같은 모델)를 배정하면, 우리는 비용을 2배 쓰면서 독립성은 0인 상태가 된다 — 최악의 조합이다. 설정 실수나 레지스트리 필터링 결과로 조용히 이렇게 될 수 있다.

```
불변식: activeRoles가 executor와 reviewer를 모두 포함하면
        assignment(executor).providerId ≠ assignment(reviewer).providerId
```

**이 불변식은 설정이 아니라 코드로 강제한다.** 레지스트리에서 조건을 만족하는 서로 다른 공급자 조합을 찾지 못하면, 라우터는 같은 공급자를 쓰는 대신:
1. `reviewer` 역할을 **드롭**하고 `complexityTier`를 사실상 simple로 격하시킨 뒤,
2. 그 사유를 `RoutingDecision.appliedPolicies`에 기록하고,
3. UI에 "교차검증 없이 진행됨(사용 가능한 독립 공급자 없음)"을 표시한다.

조용히 같은 공급자로 "검증한 척"하는 것보다, 검증하지 않았음을 드러내는 편이 안전하다. 어떤 경우든 결정론적 VERIFYING(build/test/lint)은 tier와 무관하게 항상 돌기 때문에 최종 안전망은 유지된다.

## 6. 상태 머신 영향 — 놀랍게도 작다

기존 설계가 잘 분리돼 있어서, 상태 자체는 **하나도 추가·삭제되지 않는다.** 바뀌는 건 각 phase가 *어느 모델을 부르는가*가 하드코딩에서 라우팅 결과 참조로 바뀌는 것뿐이다.

| Phase | 현재 | 변경 후 |
|---|---|---|
| `TRIAGE` | `complexityTier` 산출 | `RoutingDecision` 산출 (tier 포함) |
| `DRAFTING` | 항상 OpenAI | `assignment(executor)` 모델 호출 |
| `REVIEWING` | 항상 Claude | `assignment(reviewer)` 모델 호출 |
| `SINGLE_MODEL_FIX` | 항상 Claude | `assignment(executor)` 모델 호출 (reviewer 비활성) |
| `FIX_LOOP` | 항상 Claude | `assignment(executor)` 모델 호출 |

`DRAFTING`/`SINGLE_MODEL_FIX`가 이제 같은 역할(executor)을 부른다는 점에 주목. 둘의 차이는 "검수자가 뒤따르는가"뿐이며, 이는 원래 설계의 의미와 정확히 일치한다. 즉 우리는 이미 역할 기반으로 설계하고 있었고 이름만 공급자에 묶여 있었다.

## 7. 프로토콜 타입 변경 목록

```typescript
// snapshot.ts — provider 유니온 제거
- tokenBudget: { provider: "openai" | "anthropic"; maxTokens: number }[];
+ tokenBudget: { modelId: ModelId; maxTokens: number }[];

// tools.ts — 공급자가 아니라 역할로 기록 (감사 로그에 더 유용)
- requestedBy: "openai" | "claude" | "orchestrator";
+ requestedBy: { role: EngineRole; modelId: ModelId } | { role: "orchestrator" };

// task.ts — 라우팅 결과를 태스크 상태에 보존
  interface TaskState {
    complexityTier: ComplexityTier | null;
+   routing: RoutingDecision | null;
  }
```

SQLite 스키마에는 `routing_decisions` 테이블과 `task_events`의 새 이벤트 타입 `ROUTING_DECIDED`가 추가된다. 앞서 말했듯 DB가 아직 생성 전이라 이건 DDL 문서 수정으로 끝난다.

## 8. 부트스트랩 순환 문제 (제안서에 빠진 부분)

제안서의 다이어그램에는 `EVAL[평가 점수·비용·지연 데이터] --> R[Router]`가 있지만, **그 데이터가 어디서 오는지가 없다.** 순환이다:

```
데이터 기반 라우터 ← 평가 데이터 ← 실제 태스크 실행 ← 라우터
```

해결: **결정은 지금 정적으로, 기록은 지금부터 전부.**

- v1 라우터는 정적 설정(공급자 우선순위 + 능력 필터 + 5절 불변식)으로만 동작한다. 추측이 담긴 "지능형" 점수 계산은 넣지 않는다.
- 대신 모든 태스크에서 `RoutingDecision`, 실제 사용 토큰/비용/지연, 그리고 **VERIFYING 최종 통과 여부**를 이벤트 로그에 기록한다. 마지막 항목이 핵심이다 — 이게 "이 모델 조합이 실제로 작동했는가"의 결정론적 정답이며, 우리 아키텍처가 이미 갖고 있는 자산이다.
- 표본이 의미 있게 쌓이면 `ModelEntry.evaluation`을 채우고, 그때 라우터를 데이터 기반으로 전환한다.

기록을 나중에 붙이면 그 시점부터 데이터가 쌓이기 시작해 몇 달을 잃는다. 그래서 **기록만은 지금 해야 한다.**

## 9. 도입 순서

| 단계 | 내용 | 전제조건 |
|---|---|---|
| 0 (지금) | Model Registry + Role 추상화 + 독립성 불변식 + 라우팅 기록. **엔진은 여전히 OpenAI/Anthropic 2개.** | 없음 — 지금이 최저 비용 시점 |
| 1 | 핵심 루프 완성 (Tool Runtime, Policy Gate, FIX_LOOP, Context Engine) | 0단계 |
| 2 | **어려운 픽스처로 스파이크 재실행** — 교차검증이 실제로 이득인지 검증 | 1단계 |
| 3 | Gemini 어댑터 추가 (+ 11.4절 AI SDK 채택 여부 결정) | 2단계에서 교차검증 가치가 확인될 것. 세 번째 구조화 출력 방식이라 레지스트리 추상화 검증용으로 최적. Insight가 `@ai-sdk/google`을 이미 프로덕션에서 쓰고 있어 위험이 일부 해소됨(11절) |
| 4 | 평가 데이터 기반 라우터 전환 | 표본 축적 |
| 5+ | 추가 공급자(Qwen/Mistral/기타) | 각각 구체적 사용 사례가 있을 때만 |

**2단계를 3단계 앞에 둔 것이 이 순서의 핵심이다.** 교차검증이 어려운 태스크에서도 이득이 없다면, 3번째 엔진을 추가할 이유 자체가 사라지고 제품 포지셔닝을 다시 생각해야 한다. 그 답을 모른 채 엔진을 늘리는 건 순서가 뒤바뀐 것이다.

## 10. 채택하지 않는 것과 근거

- **공급자 5~10개 로드맵**: 어댑터는 자산이 아니라 부채다(유지보수, 호환성 테스트, 회귀). 각 공급자는 "이 태스크 유형에 이 모델이 유의미하게 낫다"는 근거가 생겼을 때만 추가한다.
- **제안서의 6×3 라우팅 표**: 채울 데이터가 없다. 지금 넣으면 검증되지 않은 추측이 코드에 굳는다.
- **planner/executor 분리 실행(기본값)**: 5절/9절 참조. 표현은 가능하게, 실행은 데이터 확인 후.
- **Private/로컬 모델 모드**: GPU 요구사항, 모델 배포·버전 관리, 성능 기대치 조정이 얽힌 별도 제품 결정. 어댑터 추가로 끝나지 않는다.
- **Copilot 백엔드 통합**: 제안서 결론에 동의.

## 10.5 출력 토큰 상한 — 모델 최대치를 요청하지 않는다

어댑터는 `max_output_tokens`(OpenAI) / `max_tokens`(Anthropic)에 `entry.capabilities.maxOutputTokens`를
그대로 넘겼다. gpt-4.1은 32,768, claude-sonnet-5는 64,000이다.

**그 값이 비용 상한을 지배한다.** 가설 게이트 P1의 보수적 최대 비용을 실제로 계산해 보니
출력 토큰이 약 85%를 차지했고, 전체가 $292였다. 우리가 요청하는 것은 patch가 담긴 JSON
하나이므로 6만 토큰 출력은 필요하지 않다. 지연에도 불리하다 — 출력 토큰 수가 곧 생성 시간이다.

`MAX_OUTPUT_TOKENS_PER_CALL = 16_000`으로 상한을 두고, 모델 최대치와 더 작은 쪽을 요청한다
(`effectiveMaxOutputTokens`). 결과: P1 $292 → $139, P0 $24 → $12.

세 가지를 의도적으로 그렇게 했다:

- **더 낮추지 않았다.** 출력이 잘리면 구조화 출력이 스키마를 만족하지 못하고
  `schema_violation` → 재시도가 된다. 돈과 정확도를 함께 잃는 실패이고, 게이트에서는
  모델 실패로 오분류될 수 있다. 16,000 토큰은 수백 줄 규모의 다중 파일 patch에 여유가 있다.
- **역할별로 다르게 하지 않았다.** 검수 응답은 초안보다 짧지만, arm마다 다른 상한을 주면
  A와 C/D 비교에 상한이라는 교란 변수가 들어간다. 모든 역할·모든 arm이 같은 값을 쓴다.
- **상한을 한 곳에만 뒀다.** 어댑터와 가설 게이트의 비용 추정기가 같은 상수를 읽는다.
  한쪽만 바꾸면 예약이 실제 청구와 조용히 어긋나므로, 회귀 테스트가 어댑터가 모델 최대치를
  직접 쓰지 않는지 확인한다.

남은 비용 동인은 **입력 쪽**이다. 추정은 컨텍스트 엔진의 토큰 예산(60,000)을 상한으로 쓰는데,
작은 fixture에서 실제 입력은 그보다 훨씬 적다. 다만 그건 예약의 **상한**이므로 낮추려면
프롬프트 오버헤드를 측정해야 하고, 측정 없이 줄이면 예약이 실제보다 작아질 위험이 있다.
P0에서 실제 usage를 얻은 뒤에 다루는 것이 옳은 순서다.

## 10.6 예산 원장(BudgetLedger)의 적용 범위 — 결정과 현재 상태

`BudgetLedger`는 유료 호출 **전에** 그 호출이 낼 수 있는 최대 비용을 예약하고, 예약할 수 없으면
호출하지 않는다. 사후 검사만으로는 마지막 호출 하나의 비용만큼 승인 상한을 넘길 수 있고,
호출 하나가 $2인 실험에서 그건 "상한을 지켰다"고 말할 수 없는 크기다.

**결정: 계약은 제품(`packages/sidecar/src/budget/ledger.ts`)에 두고, 지금 그것을 강제하는 것은
가설 게이트뿐이다.** 두 부분을 나눠 적는 이유는 이 둘이 다른 사실이기 때문이다.

*왜 제품 패키지인가.* 사용자 돈을 쓰는 것은 제품도 마찬가지다. 측정 도구에만 두면 제품의 유료
호출 경로에는 같은 보호가 없고, 나중에 붙이려 할 때 게이트 전용 가정(기록 단위 예약, JSONL
감사 추적)이 스며든 코드를 옮겨야 한다. 그래서 인터페이스는 처음부터 **호출 단위 예약**으로
두고 — 게이트는 (fixture, arm, 반복) 단위로, 제품은 provider 호출 단위로 예약한다 — 같은
`reserve`/`settle`/`release`로 둘 다 표현된다. 출력 토큰 상한(10.5절)과 컨텍스트 토큰 예산이
같은 모듈에 있는 것도 같은 이유다: 추정과 실제 요청이 **같은 상수**를 읽어야 예약이 실제 청구와
어긋나지 않는다.

*그런데 제품은 아직 이걸 쓰지 않는다.* `Orchestrator`의 provider 호출 경로에는 예약이 없다.
파일이 제품 패키지에 있다는 것만으로 "제품이 보호된다"고 읽으면 안 되므로 여기 명시한다.

**남은 후속 작업(명시적 blocker).** 제품의 유료 호출에 상한을 강제하려면 이것들이 필요하고,
그 전까지 제품은 예산 상한 없이 호출한다:

- 사용자 승인 상한을 어디서 받는가 — BYOK이므로 청구는 사용자 계정에서 일어난다. 태스크당
  상한인지 세션당인지 월별인지가 UI 결정이며, 이건 `ui-wireframes.md`에 속한다.
- 상한을 넘겨 예약이 거부됐을 때 태스크 상태 머신이 어떻게 끝나는가 — 새 `FinalResult` 사유가
  필요하다(`state-machine-and-protocol.md`).
- 원장을 어디에 영속하는가 — 게이트는 JSONL을 쓰지만 제품은 SQLite이므로 `budget_events`
  테이블과 append-only 규칙(원칙 7)에 맞춘 설계가 필요하다.

이 세 가지가 정해지기 전에 제품 경로에 예약을 끼워 넣으면, "상한을 넘어 거부됐는데 태스크가
조용히 실패로 끝나는" 동작을 먼저 만들게 된다. 그건 지금 없는 보호보다 나쁘다.

## 10.7 비용의 정본은 예약의 terminal 이벤트다 (crash-safe 재개)

실행 순서는 (1) `reservation_opened` → (2) provider 호출 → (3) `records.jsonl` 기록 →
(4) `reservation_settled`다. **(1) 이후 어디서든 프로세스가 죽을 수 있다.**

예전 대조 검사는 `reservation_settled`의 합계와 기록 파일의 비용 합계만 비교했다. 그러면
개시만 있고 종결이 없는 예약은 **어떤 합계에도 나타나지 않는다.** 두 합계가 모두 0이면
"아무것도 안 썼다"로 읽히고 재개가 허용되는데, 그 요청은 공급자가 처리하고 과금했을 수 있다.
즉 프로세스를 죽였다 되살리는 것만으로 같은 예산을 다시 쓸 수 있었다.

**결정: 한 예약의 확정 비용은 그 예약의 terminal 이벤트가 말한다.** `records.jsonl`은 실험
기록이며 파생물이다. 정본을 이벤트 쪽에 두는 이유는 셋이다.

1. 기록은 **실험 단위**(fixture × arm × 반복)이고 예약도 같은 단위지만, 예약은 기록이 만들어지기
   **전에** 열린다. 기록만 보면 "열렸지만 기록되지 않은" 상태를 표현할 수 없다.
2. 이벤트는 append-only이고 correlationId로 이어지므로, 상태 머신으로 검증할 수 있다.
   허용되는 흐름은 `opened → settled`와 `opened → released` 둘뿐이며 나머지는 전부 fail closed다.
3. 기록 파일은 리포트 생성이 다시 쓰기도 하는 파생 산출물이다. 돈의 정본을 파생물에 두면
   파이프라인 어딘가의 재생성이 장부를 바꾼다.

두 값이 다르면 **어느 쪽도 믿지 않고 멈춘다.** 어느 쪽이 맞는지 코드가 알 수 없고, 틀린 쪽을
믿으면 한도를 넘겨 쓰거나 남은 예산을 잃는다.

**정산은 이벤트 하나다.** 예전에는 `reservation_settled` + `provider_usage_recorded` 두 개였고
그 사이가 crash window였다("정산은 됐는데 usage는 모르는" 상태). 이제 비용·usage·응답 모델 ID를
`reservation_settled` 하나에 담는다. `provider_usage_recorded`는 읽기 호환을 위해 남아 있고,
있으면 정산 비용과 일치하는지 검사하지만 **비용의 정본은 아니다.**

**열린 예약을 자동으로 정리하지 않는다.** 그 요청이 실제로 과금됐는지는 공급자 콘솔의 청구
내역으로만 확인되고, 코드가 대신 판단하면 사용자 돈이 새거나 남은 예산을 잃는다. 그래서
자동 복구 명령을 만들지 않고 읽기 전용 조회(`gate:g:budget-status`)만 둔다. 열린 예약액은
사용 가능한 예산으로 되돌리지 않고 상한에서 계속 빼둔다 — 재시작 횟수만큼 그 금액을 다시 쓸 수
있게 되는 것이 이번에 고친 결함이기 때문이다.

**과금 여부가 불확실한 실패는 해제하지 않는다.** provider 호출 실패를 네 상태로 나눈다:
`not_dispatched`(해제 가능), `response_received_with_usage`(실제 비용으로 정산),
`dispatched_no_response`·`response_received_without_usage`(미해결로 남기고 중단). 공급자가 응답을
생성하고 과금한 뒤 우리 쪽 파싱이나 스키마 검증에서 실패하는 경우가 있으므로, "예외가 났으니
해제"는 쓴 돈을 안 쓴 것으로 만드는 것이다. 네트워크 타임아웃도 여기 속한다 — 응답이 생성됐지만
받지 못한 것일 수 있고 그건 청구된다. 반대로 인증 실패·모델 미지원·rate limit·5xx는 공급자가
요청을 거절한 것이므로 청구되지 않는다. 이 선을 더 보수적으로 그으면(모든 실패를 불확실로)
일시적 5xx 하나가 실행 디렉터리를 영구히 막고, 그건 보호가 아니라 사용 불가다.

## 10.8 exact-model 검증은 응답 envelope만 본다

`DraftProposal.model`과 `ReviewDecision.model`은 어댑터가 `this.modelId`를 **우리가 넣는** 값이다.
그건 요청한 모델 ID이므로, 그 값으로 "요청한 모델이 그대로 왔다"를 판정하면 **항상 통과한다** —
즉 조용한 대체를 절대 잡지 못하는 검증이었다.

이제 `ProviderResponse.meta`가 응답 envelope의 `model` 필드(`providerReportedModelId`)와
요청 ID, 공급자 요청 ID, dispatch 상태를 실어 나른다. envelope에 모델이 없으면 `undefined`이며
**요청 ID로 채우지 않는다.** 모르는 것을 아는 것처럼 적으면 검증이 무의미해진다.

alias 문제는 정규화가 아니라 **명시적 허용 목록**으로 푼다(`ModelEntry.acceptedProviderModelIds`).
prefix 비교를 쓰면 `claude-sonnet-5`가 `claude-sonnet-5.5`의 prefix이므로 **다른 모델을
통과시킨다.** 목록이 비어 있으면 정확히 일치만 허용한다 — 기본값이 느슨한 쪽이면 이 축이 있으나
마나다. 실험에서는 alias보다 pinned(dated) 모델 ID를 우선한다.

## 11. Tomverse Insight의 기존 자산 재사용

**3절의 Model Registry를 백지에서 만들 필요가 없다.** Tomverse Insight(`H:\Project\ai-chat-hub`, 리포지토리 `mposition/Tomverse`)에 이미 동등한 구조가 프로덕션에서 돌고 있다.

- `lib/modelRegistryShared.ts` — **11개 공급자**(openai, anthropic, google, groq, xai, deepseek, mistral, moonshot, qwen, zhipu, perplexity)의 `baseUrl` / `apiKeyEnvName` / **`protocol: "native" | "openai-compatible"`** 매핑. 제안서가 경고한 "OpenAI 호환이라고 진짜 호환은 아니다"를 Insight는 이미 타입 수준에서 구분하고 있다.
- `lib/models.ts` — 모델 카탈로그, `ModelInputCapabilities`(image/nativePdf/maxImages/payload 상한), 상태(`enabled`/`limited`/`disabled`/`coming-soon`).
- `lib/providerModelCatalogMonitor.ts`, `lib/providerHealthPolicyCore.ts` — 공급자 카탈로그 변화 감시, 헬스 정책.

**따라서 3절의 `adapterKind`를 Insight의 `protocol` 개념으로 대체한다** — 어댑터를 모델마다 두는 게 아니라, `native`(공급자 전용 SDK 필요)와 `openai-compatible`(공용 어댑터 + baseUrl 교체)로 나누는 편이 실증된 구분이다.

### 11.1 무엇을 재사용하고 무엇을 재사용하지 않는가

**두 제품의 과금 모델이 근본적으로 다르다는 점이 경계선이다.** Insight는 Tomverse가 API 키를 보유하고 사용자는 크레딧을 구매하는 클라우드 SaaS다. Tomverse Code는 사용자가 자기 키를 가져오는 로컬 우선 BYOK다.

| Insight 자산 | Code에서 | 이유 |
|---|---|---|
| `modelRegistryShared.ts`의 공급자 표 | **재사용(데이터로 복사)** | 순수 상수. Prisma/Next 의존 없음 |
| `models.ts`의 카탈로그·capability 정의 | **재사용(데이터로 복사)** | "이 모델이 이미지를 받는가"는 두 제품에 동일한 사실 |
| `modelRegistry.ts` | **재사용 안 함** | `server-only` + Prisma. Code는 DB가 아니라 로컬 설정에서 해석 |
| `MODEL_USAGE_CREDIT_WEIGHTS`, `ModelTier`, `ModelMinimumPlan` | **재사용 안 함** | Insight의 크레딧 과금 개념. BYOK엔 크레딧이 없다 |
| `modelAvailability.ts` | **재사용 안 함 (질문이 다름)** | Insight: "이 요금제에서 이 모델이 켜져 있나". Code: "사용자 *본인의* 키로 이 모델이 실제로 호출되나"(gpt-5 org verification 사건). 같은 이름의 다른 문제다 |

즉 **공유되는 것은 카탈로그 사실이지 자격 판정 로직이 아니다.** 3절의 `availability.requiresOrgVerification`은 Insight엔 없는 Code 고유 축이고, 반대로 Insight의 크레딧 가중치는 Code에 무의미하다.

### 11.2 코드 공유 방식 — 지금은 복사, 나중에 추출

두 제품은 **별도 리포지토리**(`mposition/Tomverse` vs `mposition/TomverseCode`)이고 릴리스 주기도 다르다(웹 연속 배포 vs 데스크톱 버전 설치본). 지금 공유 패키지를 만들어 양쪽에 릴리스 마찰을 추가할 이유가 없다.

- **지금**: 공급자 표·카탈로그를 Code 쪽 레지스트리에 **출처 주석과 함께 복사**한다. 카탈로그는 코드가 아니라 데이터이므로 복사 비용이 낮다.
- **나중에**: 양쪽이 실제로 같은 데이터를 서로 다르게 고치기 시작하면(= 드리프트가 실제 비용이 되면) 그때 `@tomverse/model-catalog` 같은 공유 패키지로 추출한다. 그 전까지는 조기 추상화다.

### 11.3 별도 축: 라이선스·구독 백엔드 (런타임 의존)

Code의 설계 문서가 말하는 "선택적 Tomverse 백엔드"(라이선스·구독·팀 정책·사용량 집계)는 Insight가 이미 갖고 있다(Stripe, NextAuth, Prisma 사용자, `billingEntitlements.ts`, `adminAudit*`).

**이건 코드 공유가 아니라 런타임 HTTP 계약 의존이다.** 11.2의 카탈로그 복사와 완전히 다른 종류이며, 다르게 다뤄야 한다:
- Code는 Insight의 내부 모듈을 import하지 않는다. 버전이 명시된 HTTP API만 호출한다.
- 이 경계는 Code의 로컬 우선 원칙과도 맞다 — 라이선스 확인은 네트워크가 끊겨도 유예 기간 동안 동작해야 하며, 소스 코드는 절대 이 경로로 나가지 않는다.
- 계약이 실제로 필요해지는 시점(유료화 시점)에 별도 설계 문서로 다룬다. MVP에서는 불필요.

### 11.4 미결정: Vercel AI SDK 채택 여부

Insight는 `ai` + `@ai-sdk/{openai,anthropic,google}`를 쓰고, Code는 공급자 공식 SDK(`openai`, `@anthropic-ai/sdk`)를 직접 쓴다. 멀티엔진으로 가면서 이 분기를 유지할지 결정해야 한다.

- **AI SDK 채택 근거**: 11개 공급자 통합 인터페이스가 이미 Insight 프로덕션에서 검증됨. 어댑터 작성 비용 대폭 절감.
- **직접 SDK 유지 근거**: 13.3절에서 우리가 검증한 건 *공급자별* 구조화 출력 메커니즘(OpenAI `json_schema` strict, Anthropic 강제 `tool_choice`)이다. AI SDK는 이걸 추상화하는데, 제안서가 경고한 "추상화 누수"가 정확히 이 지점에서 발생한다. 도구 루프와 스트리밍을 정밀 제어해야 하는 Code의 요구와 충돌할 수 있다.

**결정 시점**: 3번째 엔진(Gemini)을 추가하는 9절 3단계. 그때 두 방식으로 같은 어댑터를 짜보고 구조화 출력·도구 호출 충실도를 비교한다. 그 전에 미리 정할 필요 없다.

## 12. 미해결

- 라우터가 `RoutingDecision`을 만들 때 사용자에게 모델 선택권을 얼마나 노출할지 (완전 자동 vs. 역할별 수동 지정 vs. 힌트만)
- 공급자별 어댑터 호환성 테스트 스위트 형태 — Phase 0 스파이크 하네스를 conformance suite로 확장하는 방안
- BYOK에서 공급자 6개 = 자격증명 6개일 때 Rust 쪽 Credential Store / 가용성 확인 UX
- `evaluation` 데이터의 통계적 유의성 판단 기준 (표본 몇 개부터 라우팅에 반영할 것인가)
- 사용자 워크스페이스별 공급자 허용 목록(기업용 데이터 주권 요구)이 Policy Gate와 어떻게 맞물리는지
- **제품 유료 호출 경로에 `BudgetLedger` 적용** — 10.6절에 결정과 선행 조건 세 가지가 있다.
  현재 예약을 강제하는 것은 가설 게이트뿐이며, 제품은 예산 상한 없이 호출한다.
