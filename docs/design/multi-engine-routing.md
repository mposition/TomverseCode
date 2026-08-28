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

### 8.1 무엇이 "표본"인가 — 임계보다 먼저 답해야 했던 것

12절은 이 항목을 **"표본 몇 개부터 라우팅에 반영할 것인가"** 로 적어두었다. 구현하려고 보니
임계를 정하기 전에 물어야 하는 것이 있었다: **어떤 관측이 애초에 모델 간 비교가 되는가.**

위 목록의 마지막 항목("VERIFYING 최종 통과 여부")은 결정론적 정답이라 비교의 재료처럼 보인다.
그런데 **어떤 모델이 어떤 태스크를 받았는지는 라우터가 정한다.** 통과율은 라우터가 만든 분포
위에서 재는 값이므로, 모델의 능력과 "그 모델에게 배정된 태스크가 쉬웠는지"를 함께 담는다.
표본이 쌓여도 이 편향은 줄지 않는다 — 신뢰구간만 좁아져 **더 그럴듯해진다.** 이 절 서두의
순환이 남긴 잔여물이며, 임계값으로는 풀리지 않는다.

**난이도가 상쇄되는 관측은 하나뿐이다.** 대조 실행(13절 co-executor)에서 두 모델이 **같은
태스크·같은 스냅샷**에 대해 안을 내고 사용자가 고른 결과. 여기서만 두 모델이 같은 문제를
풀었다.

- **표본 단위는 태스크다.** 한 태스크의 쟁점들은 같은 두 초안에서 나오므로 독립이 아니다.
  쟁점으로 세면 쟁점 4개짜리 태스크 하나가 표본 4가 되어 유의성이 부풀려진다. 태스크마다
  다수결로 승자를 하나 정하고 동수는 무승부로 둔다.
- **판정자가 사용자인 것은 약점이 아니다.** 요구에 대한 최종 권위가 사용자이므로
  (product-strategy.md 16절) 이건 대리 지표가 아니라 재려던 것 그 자체다.
- **임계는 상수가 아니라 유도된다.** 승패에 부호 검정(단측)을 걸고, 한쪽이 n번 모두 이길 확률
  `0.5^n`이 유의수준보다 크면 그 표본으로는 무엇을 관측하든 갈릴 수 없다 — α=0.05에서 n=5다.
  이 숫자를 상수로 적어두지 않는 이유는, 적어두면 α를 바꿨을 때 따라오지 않고 그러면
  **유의할 수 없는 표본을 "유의하다"고 통과시키기 때문**이다. 그런 오류는 값이 그럴듯해서
  눈으로 잡히지 않는다.

`ModelEvaluation` 타입을 그 모양으로 갈랐다(`paired` / `unpaired`). **가르지 않으면 언젠가
누군가 `verificationPassRate`로 라우팅을 바꾸고, 왜 틀렸는지는 코드 어디에도 없다.**

집계는 `tomverse-host metrics`의 `modelEvaluation`이 한다. **새 계측을 붙이지 않았다** —
`USER_DECISION_RECORDED.optionId` → `DISAGREEMENT_DETECTED`의 `fromProposalId` →
`DRAFT_RECEIVED.model`로 세 이벤트가 이미 각자 필요한 것을 남기고 있었고, 없던 것은 그 셋을
잇는 일뿐이었다. 그래서 오늘 이전에 쌓인 로그에도 그대로 적용된다.

세 번 잇는 만큼 끊길 자리도 셋이다. 그래서 이을 수 없는 태스크를 **버리지 않고 `unattributed`로
센다** — 조용히 버리면 배선이 끊긴 상태가 "아직 대조를 안 돌렸다"와 똑같이 보이고, 그건 이
집계가 고장 났을 때 정확히 정상처럼 보이는 모양이다. 같은 이유로 무승부·양쪽 거부·판정 없음도
각각 다른 이름으로 센다: 셋은 서로 다른 조치를 부른다(양쪽 거부가 많으면 갈라야 할 것은 모델이
아니라 초안 프롬프트다).

**아직 라우터를 바꾸지 않는다.** v1은 정적 라우팅 그대로이고, 달라진 것은 "언제 바꿔도 되는가"에
답이 나올 수 있게 된 것뿐이다.

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

**결정: 계약은 제품(`packages/sidecar/src/budget/ledger.ts`)에 두고, 제품의 호출 경로가
그것을 강제한다**(`orchestrator/budget.ts`, `Orchestrator.callProvider`).

*왜 제품 패키지인가.* 사용자 돈을 쓰는 것은 제품도 마찬가지다. 측정 도구에만 두면 제품의 유료
호출 경로에는 같은 보호가 없고, 나중에 붙이려 할 때 게이트 전용 가정(기록 단위 예약, JSONL
감사 추적)이 스며든 코드를 옮겨야 한다. 그래서 인터페이스는 처음부터 **호출 단위 예약**으로
두고 — 게이트는 (fixture, arm, 반복) 단위로, 제품은 provider 호출 단위로 예약한다 — 같은
`reserve`/`settle`/`release`로 둘 다 표현된다. 출력 토큰 상한(10.5절)과 컨텍스트 토큰 예산이
같은 모듈에 있는 것도 같은 이유다: 추정과 실제 요청이 **같은 상수**를 읽어야 예약이 실제 청구와
어긋나지 않는다.

### 10.6.1 선행 조건 세 가지의 답

종전에 blocker로 적혀 있던 셋이 이렇게 정해졌다.

**① 상한의 단위는 태스크다.** BYOK이므로 청구는 사용자 계정에서 일어나고, 같은 키를 다른
도구도 쓴다. 우리가 "이번 달 지출"이라고 부를 수 있는 숫자는 **우리가 낸 호출만**의 합이라
실제 청구와 다르고, 그런 숫자를 상한의 근거로 쓰면 **틀린 값이 권위 있게 읽힌다.** 반면
태스크는 사용자가 요청을 적고 시작을 누르는 승인의 단위이며, 그 안의 호출은 전부 우리가 안다.

대가는 명시적이다: **다시 실행하면 상한만큼 다시 쓸 수 있다.** 그건 결함이 아니라 승인 단위가
태스크라는 뜻이고, 화면이 그렇게 말한다(ui-wireframes 3.11절). 그리고 이 결정 덕분에 10.7절의
"재개가 한도를 늘린다" 문제가 제품 경로에는 아예 생기지 않는다 — 재개된 태스크는 새 태스크이고
새 승인이다.

**② 거부는 `budget_exceeded`로 끝난다.** `provider_config_error`와 섞지 않는다: 저쪽은 고칠
것이 설정에 있고, 이쪽은 사용자가 정한 값에 도달한 정상 동작이다. 같은 이름으로 보고하면
사용자가 키나 모델을 의심한다.

**중간에 "상한을 올릴까요?"라고 묻지 않는다.** 매번 물으면 사용자는 누르고, 그 순간 상한은
상한이 아니다. 되돌릴 수 있는 멈춤(다시 실행하면 된다)과 되돌릴 수 없는 지출 중에서 멈춤을
고른다.

**단, 선택적 표본은 태스크를 죽이지 않는다.** co-executor 예약이 거부되면 대조를 잃을 뿐이고,
그건 검수자 독립성을 만족시킬 수 없을 때 검수 역할을 드롭하고 표시하는 것(원칙 4)과 같은
처리다 — 드롭하되 조용히 하지 않는다(`BUDGET_REFUSED { skipped: true }`). 검수자는 반대다:
검수를 돈 때문에 드롭하면 사용자가 고른 verified가 **조용히 verified가 아니게 된다.**

**③ 원장은 `task_events`에 남는다. 별도 테이블을 만들지 않는다.** 이건 종전 메모가 예고했던
`budget_events` 테이블 계획을 **뒤집는 것**이므로 근거를 적는다.

- 원칙 7이 이미 정본을 정해두었다. append-only 진실의 원천은 `task_events`이고, 별도 테이블은
  같은 사실을 두 곳에 두는 것이다(`tool_executions`를 테이블이 아니라 **뷰**로 둔 것과 같은 이유).
- 상태 머신 검증(correlationId별 `opened → settled`)이 필요한 이유는 **재개 시 한도 복원**인데,
  ①에 의해 제품 경로에는 재개가 없다. 필요 없는 검증을 위해 스키마를 늘리지 않는다.
- 나중에 상한의 단위가 바뀌면 그때 **뷰**를 얹는다. 데이터는 이미 이벤트에 있으므로 파생 뷰로
  만들 수 있고, 그게 `tool_executions`와 같은 패턴이다.

### 10.6.2 무엇을 막고 무엇을 막지 못하는가

막는 것은 **우리 코드의 폭주**다. FIX_LOOP가 상한까지 도는 것, 대조로 실행자가 둘이 되는 것,
재시도가 겹치는 것 — 전부 사용자 돈이고 전부 이 경로를 지난다.

**막지 못하는 것은 장악당한 sidecar다.** API 키는 이미 Node 안에 있다(원칙 2가 지키는 것은
파일·셸·자격증명이고, 공급자 HTTP 호출은 Node가 직접 한다). Node가 장악되면 상한도 함께
무너지며, 강제를 Rust로 옮겨도 **Rust가 HTTP를 대신 하지 않는 한** 달라지지 않는다. 이건 보호의
성질이지 구현의 결함이므로 코드 주석과 여기 양쪽에 적어둔다.

### 10.6.3 가격을 모르면 강제할 수 없다

레지스트리에 없는 모델이나 단가가 비어 있는 모델은 최대 비용을 계산할 수 없다. 그때
**0으로 대체하지 않는다** — 0은 "공짜"라는 뜻이고 그 순간 상한이 아무것도 막지 못하는데
사용자에게는 상한이 걸린 것으로 보인다. 상한이 설정되어 있으면 거부하고(fail closed),
상한이 없으면 진행하되 그 호출을 센다(`unpricedCalls`). 후자에서 보고되는 지출은 **하한이다.**

`null`(상한 없음)을 선택지로 남기는 이유: 사용자가 자기 키로 자기 모델을 쓰겠다는 것을 우리가
막는 것은 요구의 최종 권위를 뒤집는 것이다(원칙 1). 대신 **상한 없이 돌았다는 사실이 데이터로
남는다** — `TaskBudgetOutcome.state = "not_enforced"`는 `"ok"`와 다른 값이고, 화면이 둘을 같은
색으로 그리지 않는다.

**인자를 빠뜨린 화면이 상한을 조용히 끄지 못하게 한다.** Tauri command는 값과 "상한 없음"을
**두 인자로** 받고, 둘 다 없으면 태스크를 시작하지 않는다(`core/src/budget.rs`). `Option` 하나로
받으면 `null`이 "사용자의 선택"인지 "화면이 안 보냈다"인지 알 수 없고, 그 차이는 사용자 돈이다.

### 10.6.4 상한의 기본값은 관측에서 유도한다

첫 사용자에게는 관측할 과거가 없으므로 기본값 $5로 시작하고, 실사용 비용이 쌓이면
`tomverse-host metrics`의 `taskCosts`에서 유도한다(`suggest_task_budget_usd`). 값과 함께
`source`를 돌려주는 것은 강제 포기 문턱(state-machine 16.3절), "큰 변경" 문턱(19.6절)과 같다.

**여유 배수(×3)는 아직 유도하지 못한 상수다.** 필요한 이유는 분명하다: 예약은 그 호출의
**최대** 비용으로 열리고 확정은 **실제** 비용으로 되므로, 상한을 과거 실제 지출에 맞추면 남은
예산이 다음 호출의 최대치를 못 덮어 정상 태스크가 거부된다. 그 간극은 이제 측정할 수 있다 —
`BUDGET_RESERVATION_OPENED`의 `reservedUsd`와 `BUDGET_RESERVATION_SETTLED`의 `actualUsd`가
같은 이벤트 로그에 함께 쌓인다.

**하한 $1은 임의의 값이 아니다.** 가장 비싼 등록 모델의 한 호출 최대 비용이 약 $2이므로, 그보다
낮은 상한은 첫 호출부터 거부되어 아무것도 돌지 않는다. 값싼 태스크만 쌓인 워크스페이스에서
유도값이 그 아래로 내려가면 사용자는 이유를 모른 채 막힌다.

### 10.6.5 미해결 예약을 제품에서는 차단 사유로 쓰지 않는다

10.7절의 규칙("과금 여부가 불확실한 실패는 해제하지 않는다")은 그대로다. 달라지는 것은
**그 다음에 무엇을 하는가**이고, 두 사용처가 다른 것을 지키기 때문에 갈린다.

- **게이트는 막는다.** 그 실행은 측정이고, 장부가 깨끗하지 않은 채 얻은 숫자는 판정에 쓸 수 없다.
  게다가 게이트는 프로세스를 넘어 재개하므로 미해결을 안고 계속하면 재시작마다 같은 예산을
  다시 쓸 수 있다.
- **제품은 막지 않는다.** 제품에서 미해결을 만드는 가장 흔한 원인은 **타임아웃**이고, 타임아웃은
  재시도 대상으로 설계된 정상적 실패다(원칙 5). 한 번의 타임아웃이 남은 호출을 전부 막으면
  사용자는 "예산이 모자랍니다"라는 **틀린 이유**로 실패한 태스크를 본다(실측으로 기존 타임아웃
  테스트가 그렇게 깨졌다).

막지 않아도 상한은 지켜진다: 미해결액은 `available()`에서 계속 빠져 있으므로 그 돈은 이미 쓴
것으로 취급된다. **막는 것과 빼두는 것은 다른 보호이고, 제품에 필요한 것은 후자다.**
기본값은 여전히 "막는다"이며(`blockOnUnresolved`), 제품만 그것을 끈다.

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

## 10.9 승인 아티팩트의 무결성 — 해시가 무엇을 지키고 무엇을 지키지 않는가

### 실측으로 확인된 결함: 해시가 최상위 스칼라만 지키고 있었다

승인 아티팩트(Run Card, ProbeEvidence, P0 Attestation)의 해시는 이렇게 계산됐다.

```ts
JSON.stringify(value, Object.keys(value).sort())
```

`JSON.stringify`의 **array replacer는 property whitelist**이고, 그 whitelist는 **모든 깊이에**
적용된다. 최상위 key만 목록에 넣었으므로 중첩 객체의 key는 하나도 살아남지 못하고 `{}`가 된다.

```
{a:1, nested:{x:1}, arr:[{h:"aaa"}]}  →  {"a":1,"arr":[{}],"nested":{}}
{a:1, nested:{x:9}, arr:[{h:"bbb"}]}  →  {"a":1,"arr":[{}],"nested":{}}   ← 같다
```

그래서 `models.executor.modelId`, `stage.fixtureIds`, `stage.callBudget`,
`fixtureHashes[*].hash`, `arms[*].providers`, `readiness` 내부, attestation의 `checks[*]`를
**아무리 바꿔도 해시가 그대로였다.** 승인 절차가 지키던 것은 사실상 최상위 스칼라뿐이었다.

### 규칙

- 정규 직렬화는 `evals/hypothesis-gate/src/canonical.ts` **하나**다. key를 모든 깊이에서
  재귀 정렬하고, 배열 순서는 보존하며, `undefined`·`NaN`·`Infinity`·함수·symbol·bigint·
  `toJSON` 객체를 **경로와 함께 예외로 거부한다**(조용히 지우면 "해시는 같은데 내용이 다른"
  두 문서가 생긴다).
- 해시 대상에서 제외하는 것은 **해시 필드 자신뿐**이다. 예전처럼 대상 필드를 손으로 나열하면
  새 필드를 목록에 넣는 것을 잊는 순간 그 필드가 조용히 해시 밖으로 빠진다.
- SHA-256은 **64 hex 전체**를 저장한다. 32자리로 자르던 시절의 아티팩트는 형식 검사에서 먼저 걸린다.
- 스키마 버전을 올리고 **이전 버전은 fail-closed로 거부한다.** 자동 마이그레이션하지 않는다 —
  v1 해시는 중첩 필드를 덮지 않았으므로 "해시가 맞다"가 아무것도 보증하지 않는다.

### 위협 모델 — 이건 전자서명이 아니다

이 해시는 **무결성 검사**이지 위조 방지가 아니다. 로컬에서 코드를 실행할 수 있는 사용자는
내용을 바꾼 뒤 같은 함수로 해시를 다시 계산해 넣으면 된다. 비밀 키가 없으므로 막을 수단이 없고,
막으려면 서명 키를 사용자가 접근할 수 없는 곳(HSM, 원격 서명 서비스)에 두어야 한다.

그 한계를 알고도 두는 이유: 이 절차가 막으려는 것은 **공격자가 아니라 사고**다.
"plan-pilot을 다시 돌려서 카드가 바뀐 줄 몰랐다", "evidence 파일을 편집기로 열었다가 저장했다",
"다른 실행의 attestation을 복사해 왔다" — 해시가 정확히 잡는 것은 이것들이다.

## 10.10 승인은 immutable하고, 실행은 receipt로 승인에 묶인다

### immutable 승인 아티팩트

승인 아티팩트는 `<output-root>/approvals/{cards,evidence,attestations}/<id>.json`에 산다.

- **같은 id에 다른 내용을 쓸 수 없다.** 같은 내용의 재저장만 idempotent하게 허용한다
  (비교는 바이트가 아니라 canonical JSON — 들여쓰기 차이로 실패하면 사람이 고칠 수 없다).
- `plan-pilot`을 다시 돌리면 **새 id의 새 카드**가 생기고, 이미 실행에 쓰인 카드는 그대로 남는다.
- 덮어쓰이는 `*.pointer.json`은 **안내용**이며 Run Card 형태가 아니다. 실수로 `--run-card`에
  넘겨도 카드로 해석되지 않는다. 승인의 대상이 시간에 따라 달라지면 "이것을 승인했다"는 말이
  성립하지 않기 때문이다.
- 카드는 자기 immutable 경로를 기록하고, 다른 경로에서 읽힌 카드는 **사본으로 보고 거부한다.**

### Execution Authorization Receipt

`pilot`/`run`은 **어댑터를 만들기 전에** `execution-authorizations.jsonl`에 receipt를 append한다.
저장에 실패하면 유료 호출을 시작하지 않는다.

receipt가 담는 것: 카드 id/hash/경로, evidence id/hash/경로, (P1이면) attestation id/hash/경로,
protocol/criteria hash, registry snapshot hash, adapter contract version, stage/output,
**실행 직전의 fixture 내용 해시 전부**, arms/repetitions/seed/concurrency, 역할별 provider·model,
승인 상한, 정규화된 실행 argv, 자격증명 binding 다이제스트와 **환경변수 이름**.

담지 않는 것: API 키 원문·prefix·suffix·길이, Authorization 헤더, 전체 환경변수.

모든 `GateRunRecord`가 `receiptId`/`receiptHash`를 달고 나온다. 그래서 `attest-p0`는
**명령 인자로 받은 카드가 아니라 기록이 가리키는 receipt**를 정본으로 삼는다 — 예전에는
`plan-pilot` 재실행으로 카드 파일이 바뀌면 실제로 실행된 것과 다른 카드로 attestation을 만들 수 있었다.

재개는 조건 해시가 같을 때만 기존 receipt를 이어받는다. 예산을 올렸든 fixture 내용이 바뀌었든
조건이 다르면 **새 승인**이며, 새 카드와 새 receipt와 새 출력 디렉터리를 요구한다.

### 호출별 dispatch 상태와 crash 복구

`records.jsonl`의 각 기록은 `providerCalls[]`를 갖는다. 그 값은 DB 이벤트에서 만들어진다.

| 이벤트 | 의미 | dispatch |
|---|---|---|
| `PROVIDER_CALL_STARTED` | adapter 호출 직전 | (terminal이 없으면) `dispatched_no_response` |
| `PROVIDER_USAGE` | usage를 받은 성공 | `response_received_with_usage` |
| `PROVIDER_CALL_FAILED` | 실패 + 어댑터가 아는 사실 | 어댑터가 실은 값 |

불변식:

- **`auth_failure`·`rate_limit`·`provider_5xx`는 HTTP 분류일 뿐 dispatch 사실이 아니다.**
  429나 5xx를 받았다는 것은 요청이 공급자에게 도달했다는 뜻이고, 그 앞 호출이 과금됐을 수 있다.
- 해제(`not_dispatched`)는 **적극적 증거**가 있을 때만이다: 이벤트를 읽을 수 있었고,
  호출 개시 이벤트가 하나도 없으며, 실패가 호출 이전 단계(자격증명 없음, fixture 준비 실패,
  툴체인 미준비)에서 났을 때.
- **이벤트를 읽지 못한 것 자체가 과금 불확실 상태다.** "모른다"를 "안 썼다"로 읽지 않는다.
- 공급자별 비과금 거부 상태를 두고 싶다면 검증 가능한 계약과 별도 상태와 테스트가 필요하다.
  근거가 없으면 `unresolved`가 기본이다.

### known spend와 maximum unresolved exposure는 다른 숫자다

한 기록에서 executor는 성공(과금 확정)하고 reviewer는 5xx로 실패할 수 있다. 그때
**전액 해제하면 쓴 돈이 사라지고, 전액 정산하면 불확실한 과금이 사라진다.** 둘 다 사실과 다르다.

그래서 세 번째 종결 방식을 둔다: `reservation_partially_settled`. 확정분은 누적하고 나머지는
미해결로 남기며, 그 디렉터리는 자동 재개가 불가능해진다.

`gate:g:budget-status`는 두 숫자를 **분리해서** 보여준다.

- **알려진 지출(known spend)**: 이미 확정된 돈. terminal 이벤트가 말하는 값이다.
- **최대 미해결 노출(maximum unresolved exposure)**: 과금됐을 **수 있는** 금액.
  그만큼 과금됐다는 뜻이 아니다. 실제 여부는 공급자 청구 내역으로만 확인된다.

### 자격증명 resolver는 하나다

`preflight`, 모델 준비성, ProbeEvidence binding, receipt binding, 어댑터 factory, 유료 실행
authorization이 전부 `resolveCredential` 하나를 지난다. 후보는 레지스트리의 `apiKeyEnvName`과
`TOMVERSE_` 접두 별칭 둘뿐이고, **값이 다른 별칭이 둘 다 있으면 조용히 고르지 않고 차단한다** —
그 상태에서는 probe가 확인한 키와 실행이 쓰는 키가 다를 수 있다.

credential binding의 HMAC은 **API 키를 HMAC 키로** 쓰고 salt/purpose/provider/envName을
메시지로 쓴다. 예전에는 반대(salt가 키, API 키가 메시지)였고, salt가 공개값이므로 HMAC의
"키를 모르면 다이제스트를 만들 수 없다"는 성질이 성립하지 않았다.

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

## 18. Credential Store 착지 기준

12절 항목이 "Job Object와 같은 모양이어야 한다"고만 적어둔 자리다. **모양만 말하고 내용을
적지 않으면 기준이 없는 것과 같다** — Windows 앞에 앉은 사람이 무엇을 확인해야 하는지 알 수
없기 때문이다.

**아래가 전부 참으로 확인되기 전까지 이 항목은 "구현됨"이지 "검증됨"이 아니다.**

1. 키를 앱 안에서 넣고 지울 수 있고, 저장이 **Windows Credential Manager(DPAPI)를 지난다.**
2. 저장 후 앱 디렉터리와 설정 어디에도 **키 문자열이 평문으로 남지 않는다.** 이건 1번과 다른
   기준이다 — DPAPI로 저장하면서 로그나 캐시에 원문을 흘리는 것이 가능하다.
3. **UI 프로세스는 키를 갖지 않는다**(원칙 3). 입력 즉시 Rust로 넘기고, 이후 조회는
   "있다/없다"만 돌려준다. 저장소가 생기면 "설정 화면에서 지금 키를 보여주자"가 자연스러워
   보이는데, 그 순간 원칙 3이 깨진다.
4. sidecar에는 여전히 **spawn 시 1회 주입**이고 허용 목록으로 걸러진다(16절). 저장소가
   생겨도 `credential.get`이 되살아나지 않는다 — 8.2절이 지운 메서드이고, 저장소를 만들면서
   되살리고 싶어지는 자리이므로 기준으로 못박아 둔다.
5. 키가 없을 때의 실패가 "개발용 임시 방식" 문구가 아니라 **정상적인 안내**다. 그 문구가
   남아 있으면 전환이 끝나지 않은 것이다.

판정은 `tomverse-host windows-landing`이 한다(process-architecture.md 12절).

### 18.1 만든 뒤 — 다섯 기준이 두 종류로 갈렸다

**구현했다**(20절). 그리고 만들고 나서야 분명해진 것이 있다: **위 다섯 중 둘은 Windows를
기다릴 이유가 없다.**

| 기준 | landing id | 지금 상태 | 왜 |
|---|---|---|---|
| 1 | `storedThroughDpapi` | `needs_human` | Win32 API의 **동작**. Linux에서는 한 줄도 컴파일되지 않는다 |
| 2 | `noPlaintextAtRest` | `needs_human` | 같음. 그리고 "무엇이 어디에 쓰였는가"는 그 머신에서만 볼 수 있다 |
| 3 | `uiNeverHoldsTheKey` | **`passed`** | **소스 불변식**이다 — 아래 참조 |
| 4 | `injectionStaysOnce` | **`passed`** | 같음 |
| 5 | `productionStoreIsNotTheDevelopmentOne` | `needs_human` | 절반은 컴파일러가 지키고, 나머지 절반(실제로 그 종류가 열리는가)은 실행해야 안다 |

3·4가 `passed`인 것은 `jobObject`의 `appNotInJob`과 같은 자리다. 다만 **그 둘이 통과라고
말하려면 검사가 있어야 한다** — 산문으로 두면 다음 사람이 되살린다. 그래서 셋을 두었다:

- `packages/toolchain/test/credentialBoundary.test.ts` — `credential.get`이 여전히 거절되는가,
  sidecar가 그것을 부르지 않는가, 값을 읽는 자리(`read_for_injection`)와 봉투를 여는
  자리(`into_pairs`)가 각각 하나인가, 껍데기 크레이트가 값에 닿지 않는가, `Secret`에
  `Display`/`Serialize`가 없는가, 개발용 저장소가 Windows 빌드에서 컴파일되지 않는가
- `apps/desktop/test/frontendTrust.test.ts` — 화면이 브라우저 영속 저장소를 쓰지 않는가,
  값을 되읽는 명령을 부르지 않는가
- `apps/desktop/test/credentialDraft.test.ts` — 입력한 키를 제출 직후 버리는가(**실패해도**),
  화면 문구가 저장소 종류에서 유도되는가(기준 5의 문구 절반)

**기준 5의 문구 절반은 여기서 닫힌다.** 종전 화면은 `isDevelopmentOnly: true`를 **상수로**
받았다. 그대로 두면 저장소를 만들어도 "개발용 임시 방식"이 남고, 사실을 말하지 않는 화면은
없는 것보다 나쁘다. 이제 Rust가 `StoreKind::is_production()`에서 유도한다.

### 18.2 확인하면 어디에 적는가

**문서가 아니라 attestation 파일이다**([windows-landing-record.md 15절](./windows-landing-record.md)).
`needs_human` 셋은 사람의 확인으로 통과가 되고, 그 확인은 **그 커밋에서만** 유효하다.
`passed` 둘은 적을 필요가 없다 — 적으면 "이미 기계가 통과로 판정했다"고 거절된다.

## 12. 미해결

- ~~라우터가 `RoutingDecision`을 만들 때 사용자에게 모델 선택권을 얼마나 노출할지~~ → 15절에서 해결: **역할별 수동 지정을 태스크 단위로 노출하되, 지정은 힌트가 아니라 요구로 다룬다.** 지정과 예산 상한의 상호작용은 15.5절에서 닫았다 — 확실히 거부되는 조합은 **시작 전에** 말한다
- ~~공급자별 어댑터 호환성 테스트 스위트 형태~~ → 14절에서 해결(`packages/sidecar/test/conformance.test.ts`). 스파이크 하네스를 확장하는 대신 **같은 표를 모든 어댑터에 돌리는** 형태로 만들었고, `fetch`를 주입해 **네트워크 없이 실제 어댑터를 태운다**. 첫 실행에서 실제 갈라짐 하나를 잡았다(14.2절). ~~남은 것: 새 공급자를 추가할 때 `ADAPTERS` 표에 넣는 것을 강제하는 장치는 없다~~ → 14.5절에서 닫았다. 모델 레지스트리에서 유도한 대조로 막고(표 누락 + 팩토리 분기 누락), **그 대조가 실제로 잡는지를 확인하는 검사**를 함께 둔다 — 대조 검사는 언제나 통과하는 방식으로 고장 나기 때문이다
- ~~**BYOK에서 공급자 6개 = 자격증명 6개일 때 Rust 쪽 Credential Store / 가용성 확인 UX**~~ — **둘 다 닫혔다.** 가용성 확인은 17절(무료 조회로 자격증명을 확인하고, "조회된다"와 "호출된다"를 구별해서 말한다), Credential Store는 **20절에서 구현했다**(`core/src/credentials.rs`, `core/src/win_credentials.rs`). 착지 기준은 18절에 있고, 그중 셋은 여전히 Windows에서 사람이 확인해야 한다 — Job Object와 같은 성질이다(state-machine 20.5절). 남은 것은 **그 확인이고, 확인은 문서가 아니라 attestation 파일에 적는다**(18.2절).
  되돌리기 비싼 결정 둘(**저장 형식**과 **트레이트 경계**)의 근거는 20.1·20.2절에 있다
- ~~`evaluation` 데이터의 통계적 유의성 판단 기준 (표본 몇 개부터 라우팅에 반영할 것인가)~~ → 8.1절에서 해결. **문항이 임계를 물었지만 먼저 답해야 하는 것은 '무엇이 표본인가'였다**: `verificationPassRate`는 라우터가 만든 분포 위에서 재는 값이라 표본이 쌓여도 편향이 줄지 않고 신뢰구간만 좁아진다. 난이도가 상쇄되는 관측은 대조 실행에서의 정면 비교 하나뿐이며, 표본 단위는 쟁점이 아니라 **태스크**다(한 태스크의 쟁점들은 같은 두 초안에서 나오므로 독립이 아니다). 임계는 상수가 아니라 부호 검정에서 유도된다(α=0.05에서 n=5). `ModelEvaluation`을 `paired`/`unpaired`로 갈랐고 집계는 `tomverse-host metrics`의 `modelEvaluation`이 한다 — **새 계측 없이** 기존 세 이벤트를 이었으므로 과거 로그에도 적용된다. 남은 것: **라우터를 바꾸는 일 자체는 아직 하지 않았다** — `verdict`가 `separated`인 쌍이 실제로 생겼을 때가 그 시점이다
- ~~사용자 워크스페이스별 공급자 허용 목록(기업용 데이터 주권 요구)이 Policy Gate와 어떻게 맞물리는지~~ → 16절에서 해결. 답은 **맞물리지 않는다**였다: 공급자 호출은 Policy Gate를 지나지 않으므로(HTTP는 Node가 직접 한다) 게이트에 규칙을 얹을 자리가 없고, 대신 **자격증명 주입 지점**이 게이트 역할을 한다. 남은 것: **이건 기업 통제가 아니라 사용자 자신의 가드레일이다**(BYOK에서는 사용자가 관리자다). 조직이 강제하는 정책이 되려면 라이선스/정책 백엔드가 목록을 내려줘야 하고, 그건 11절의 HTTP 계약(M6)에 딸린다
- **13.3절 절충의 실제 비용** — 공급자 2개 환경에서 reviewer가 대조 참가자와 공급자를 공유할 때 검수
  품질이 실제로 떨어지는가. 3공급자 환경과 비교해 재야 하며 현재는 추정이다. **무료로 확인할 수 있는
  절반은 이미 닫혀 있다**: 라우터가 실제로 두 환경에서 다르게 배정하는지(2개면
  `reviewer_shares_provider_with_contrast_participant`가 붙고 3개면 붙지 않는지)는 결정론적이며
  `packages/sidecar/test/disagreement.test.ts`가 양방향으로 확인한다. 그러므로 이 항목을 다시 열 때
  **배정을 다시 검사하지 말 것** — 남은 것은 품질 차이 하나다. 게이트 G의 arm에 얹을 수 없다:
  arm을 늘리면 `PROTOCOL_VERSION`이 올라가 **다른 실험**이 되므로 별도 사전 등록이 필요하다.
  ~~그리고 이 항목은 자격증명을 기다리는 것이 아니다 — 선행 조건은 어댑터 추가다~~ →
  **그 어댑터가 생겼다(19절, M2).** 예고한 대로 `budget.test.ts`의 가드가 발동해 이 항목을 다시
  열었다 — 사람이 기억하기로 뒀다면 세 번째 공급자를 추가하고도 실험을 떠올리지 못했을 것이다.
  **남은 선행 조건은 이제 둘뿐이다**: 세 공급자의 자격증명, 그리고 별도 사전 등록. 발동한 가드는
  자리를 비우지 않고 후속 불변식으로 바꿨다 — **레지스트리에 공급자가 늘어도 자격증명이 둘뿐인
  사용자의 배정은 달라지지 않는다**(배정은 `availableProviders`가 정한다는 규칙을 사실로 확인한다)
- ~~**제품 유료 호출 경로에 `BudgetLedger` 적용**~~ — 10.6절에서 해결. 선행 조건 세 가지가
  각각 정해졌고(태스크당 상한 / `budget_exceeded` 종료 / `task_events` 영속), 그중 셋째는
  종전 계획(`budget_events` 테이블)을 **뒤집었다** — 원칙 7이 이미 정본을 정해두었고, 별도
  테이블이 필요했던 이유(재개 시 한도 복원)가 태스크당 상한에서는 발생하지 않는다.
  남은 것: **여유 배수(×3)는 유도하지 못한 상수다.** 예약액과 확정액이 같은 이벤트 로그에 함께
  쌓이므로 간극을 측정할 수 있다고 적어두었는데, **정작 그 이벤트를 읽는 집계가 없었다** —
  실사용이 아무리 쌓여도 아무도 읽지 못하는 상태였다("데이터를 기다린다"와 "데이터를 읽을 수
  없다"는 다른 상태이고, 후자는 기다려도 오지 않는다). 이제 `tomverse-host metrics`의
  `budgetHeadroom`이 `예약/실제`의 백분위를 낸다. **비율 자체는 여전히 실사용 대기다.**
  읽는 법: p90이 300%보다 한참 낮으면 배수를 내린다 — **올리는 쪽이 안전한 방향이 아니다.**
  배수가 작으면 남은 예산이 다음 호출의 최대치를 못 덮어 정상 태스크가 거부된다. 그리고
  `unresolved`가 0이 아니면 그 요청은 과금됐을 수 있으므로(10.7절) 배수보다 그쪽을 먼저 본다

## 13. co-executor — 대조를 위한 두 번째 실행자 (구현됨)

결정의 근거는 [product-strategy.md 16절](./product-strategy.md), 프로토콜/상태 머신 반영은 [state-machine-and-protocol.md 17절](./state-machine-and-protocol.md). 여기서는 **라우터가 무엇을 배정하고 무엇을 거부하는가**만 정한다.

### 13.1 새 역할을 만들지 않는다 — executor 배정이 여러 개가 된다

4절의 `EngineRole`은 그대로 `planner | executor | reviewer`다. `co-executor`라는 이름을 새로 만들지 않는 이유: 두 실행자가 하는 일이 **완전히 같기 때문**이다. 같은 스냅샷, 같은 프롬프트, 같은 출력 스키마로 독립 실행한다. 역할이 다른 게 아니라 표본이 둘인 것이다. 이름을 나누면 프롬프트가 갈라질 여지가 생기고, 그 순간 "모델 차이"와 "프롬프트 차이"가 섞여 측정이 오염된다(`providers/prompts.ts`가 어댑터 간 프롬프트 공유를 강제하는 것과 같은 이유).

따라서 `RoutingDecision.assignments`에 `role: "executor"`인 항목이 **둘** 올 수 있다.

- **순서가 의미를 갖는다.** 첫 번째가 primary executor다. `FIX_LOOP`처럼 하나만 필요한 단계는 primary를 쓴다.
- 기존 코드가 `assignments.find(a => a.role === "executor")`로 첫 항목을 잡는 경로(`orchestrator.ts:918`)는 **그대로 두면 primary를 가리킨다** — 하위 호환이 자연스럽게 성립한다. 이건 우연이 아니라 순서 규칙을 그렇게 정한 이유다.
- `activeRoles`에는 `executor`가 한 번만 들어간다. 개수는 `assignments`가 말한다.

### 13.2 불변식 확장

5절의 불변식에 한 줄이 붙는다.

```
불변식 1 (기존): activeRoles가 executor와 reviewer를 모두 포함하면
                assignment(executor).providerId ≠ assignment(reviewer).providerId

불변식 2 (신규): executor 배정이 둘이면
                executors[0].providerId ≠ executors[1].providerId
```

**같은 공급자를 두 번 불러 만든 "불일치 없음"은 정보가 아니라 착시다.** 대조의 가치 전부가 두 표본이 독립이라는 데서 오므로, 만족시킬 수 없으면 5절과 같은 처리를 한다 — 같은 공급자로 두 번 부르지 않고 **대조 자체를 드롭**한 뒤 사유를 `appliedPolicies`에 남기고 UI에 표시한다.

### 13.3 공급자가 2개뿐일 때 — 대조와 검수가 충돌한다

BYOK 현실에서 흔한 경우다. 공급자가 둘이면 executor 두 자리를 채우는 순간 **reviewer는 반드시 둘 중 하나와 같은 공급자**가 된다. 불변식 1과 2를 동시에 만족시킬 수 없다.

**결정: 대조가 검수보다 우선한다.**

근거는 권위의 계층이다(16.1절). 대조는 **사용자 판정을 위한 질문을 만들고**, 검수는 **모델 의견을 하나 더 얻는다.** 사용자가 상위 권위이므로, 하나를 포기해야 하면 모델 의견 쪽을 포기한다.

다만 검수를 통째로 버리지는 않는다. 이렇게 배정한다:

- reviewer는 **사용자 판정에서 살아남지 않은 쪽 초안의 저자 공급자**에 배정한다. 즉 **자기가 쓴 안을 자기가 검수하지 않는다.**
- 이건 공급자 독립성을 완전히 만족시키지 못한다. "자기 산출물 자기 승인"이라는 최악만 피하는 것이다.
- `appliedPolicies`에 `reviewer_shares_provider_with_contrast_participant`를 남기고 UI에 표시한다. 17.1절에서 reviewer의 역할이 "사용자 기준이 반영됐는지 확인"으로 좁아진 덕분에 이 절충의 대가가 이전보다 작다 — 자유 재량 판단이 아니라 고정된 기준과의 대조이기 때문이다.
- **공급자가 3개 이상이면 이 절충은 필요 없다.** 완전 독립 배정이 가능하고 라우터는 그걸 우선한다.

### 13.4 비용

| tier | LLM 호출 (fix loop 제외) |
|---|---|
| `simple` / `fast` | 1 (executor) |
| `standard` / `verified` (대조 없음, 현행) | 2 (executor + reviewer) |
| `verified` (대조 켜짐) | **3** (executor ×2 + reviewer) |

13.1절 스파이크가 "쉬운 태스크엔 2회도 과하다"고 판정했음을 기억할 것. 3회는 `verified` 이상 전용이며, `RoutingDecision.estimatedCostUsd`가 이 증가를 반영해야 사용자가 tier를 올릴 때 무엇을 지불하는지 보인다.

**planner는 여전히 기본 비활성이다**(4절). 대조가 켜지면 호출이 이미 3회이므로, planner까지 켜서 4회로 만드는 것은 실측 근거가 나오기 전까지 하지 않는다.

### 13.5 구현에서 정해진 것

- **`decide()`가 `contrast` 인자를 받는다.** 라우터가 스스로 켜지 않는 이유: 켜면 호출이 3회가 되므로 이건 비용에 관한 결정이고, 그 근거(tier, 실험 하네스 여부)를 라우터는 모른다. 라우터는 **배정 가능성**만 판단한다.
- **13.3절 절충의 검수자는 REVIEWING 시점에 확정된다.** "살아남은 초안의 저자가 아닌 쪽"은 라우팅 시점에 알 수 없으므로, 라우터는 non-primary를 잠정 배정하고 `RoleAssignment.reason`에 그 사실을 적는다. 오케스트레이터가 살아남은 초안을 보고 바꿔 끼우며, `REVIEW_RECEIVED`에 `assignedReviewerModel`과 `actualReviewerModel`을 **둘 다** 남긴다 — 배정만 남기면 로그가 실제로 누가 검수했는지에 답하지 못한다.
- **바꿔 낄 대상이 없으면 검수를 드롭한다.** 자기가 쓴 안을 자기가 검수하느니 검수 없이 진행하는 편이 안전하다(CLAUDE.md 원칙 4).
- **같은 모델 ID를 두 executor 자리에 넣지 않는다.** 공급자가 달라도 모델이 같으면 표본이 하나다. `pick()`이 co-executor 배정에서 primary의 모델 ID를 후보에서 뺀다 — 설정 override가 두 자리를 같은 모델로 채우는 경우를 막는다.
- **fake 공급자를 셋으로 늘렸다**(`fake-a`/`fake-b`/`fake-c`). 둘뿐이면 13.3절 절충 경로만 테스트하게 된다. 셋이면 "완전 독립 배정"과 "절충 배정"을 둘 다 실제로 돌려볼 수 있다.
## 14. 어댑터 적합성 스위트 (구현됨)

이 제품의 비교는 전부 **"어댑터는 서로 바꿔 끼울 수 있다"**는 전제 위에 서 있다 — 대조(두
실행자), 독립 검수, 가설 게이트의 arm 비교가 모두 그렇다. 어댑터가 공급자마다 다른 것을
정규화하면 **공급자 차이가 모델 차이로 읽힌다.**

### 14.1 왜 공급자별 테스트로는 부족했나

종전 어댑터 테스트는 공급자마다 손으로 쓴 것이었다("OpenAI usage 정규화"와 "Anthropic usage
정규화"가 서로 다른 것을 확인했다). 그러면 **한쪽에만 있는 규칙이 생겨도 아무것도 실패하지
않는다.** 실제로 그 모양으로 두 가지가 벌어져 있었다:

- `envelopeIdentity`가 두 파일에 **글자 그대로 복사**되어 있었다(지금은 `providers/envelope.ts`).
- `estimatedInputTokens`를 붙일 때 두 어댑터를 손으로 똑같이 고쳐야 했다.

그래서 지금은 **같은 표를 모든 어댑터에 돌린다.** 새 공급자는 표에 한 줄을 넣게 되고,
계약을 만족하지 못하면 그 줄 때문에 실패한다.

### 14.2 첫 실행이 잡은 것 — OpenAI가 과금된 응답의 사실을 버리고 있었다

Anthropic 어댑터는 "tool_use 블록이 없음"을 `ProviderCallFailure`로 감싸 **usage·응답 모델
ID·`dispatchState`를 실어** 던졌다. OpenAI 어댑터는 같은 경우(구조화 출력 텍스트 없음)에
평범한 `Error`를 던졌다.

결과가 두 가지로 갈렸다. ① 이미 받은 응답의 usage가 기록에서 사라진다 — 과금됐을 수 있는
호출의 토큰 수를 잃는다. ② 분류가 `schema_violation`이 아니라 `transient`가 된다. 지금은
둘 다 재시도하지 않으므로 동작은 우연히 같지만, **우연히 같은 것은 계약이 아니다.**

### 14.3 네트워크 없이 실제 어댑터를 태운다

`AdapterDeps.fetch`로 SDK의 전송 계층만 바꾼다. 요청 조립·envelope 해석·정규화는 프로덕션
코드 그대로 돈다. 주입하지 않으면 SDK 기본 전송을 쓰므로 **프로덕션 경로는 달라지지 않는다.**

프로덕션 타입에 주입점을 두는 것을 정당화하는 근거는 하나다: 이게 없으면 어댑터 본체는
**네트워크가 있어야만 검증되고**, 그 검증은 실패했을 때 이미 돈을 쓴 뒤다. 전제가 공짜로 자주
검증되지 않으면 그 전제는 실제로는 검증되지 않는 것이다.

### 14.4 fake도 같은 계약을 지킨다

e2e는 fake 위에서 돈다. fake의 계약이 실제 어댑터와 갈라지면 **e2e가 통과해도 그 통과가 실제
경로에 대해 아무것도 말하지 않는다.** HTTP를 타지 않으므로 위 표에는 넣을 수 없지만, 전송과
무관한 부분(오류 분류·usage 정규화·취소 안전성·capabilities)은 **같은 함수로** 확인한다.

### 14.5 표에 넣는 것을 강제한다 — 빠진 검사는 실패하지 않는다

14.1~14.4를 만들고도 구멍이 하나 남아 있었다: **새 공급자를 `ADAPTERS` 표에 넣는 것을
강제하는 장치가 없었다.** 넣지 않으면 그 어댑터에 대해서는 아무 테스트도 돌지 않고, 없는
테스트는 실패하지 않으므로 **실행 결과는 조용히 초록색**이다. 이건 루트 `test`에서
워크스페이스가 빠지던 것과 같은 모양이고(CLAUDE.md), 같은 방식으로 막는다 — 사람이 지키는
규칙이 아니라 **다른 목록에서 유도한 대조**로.

유도의 출발점은 **모델 레지스트리**다. 어댑터 파일이 있어도 레지스트리에 없으면 호출되지
않고, 레지스트리에 있으면 반드시 호출되므로 "제품이 실제로 부르는 공급자"의 정본이 거기다.
`local://` 판별을 여기 복사하지 않고 `providerKindOf`를 쓰는 것도 같은 이유다 — 복사하면
규칙이 바뀔 때 둘이 갈라진다.

검사는 셋이다.

1. **레지스트리의 실제 공급자가 전부 표에 있다.** 빠지면 어느 공급자가 빠졌는지와 함께 실패한다.
2. **팩토리가 그 공급자의 어댑터를 만들 수 있다.** 표에 있는 것만으로는 부족하다 —
   레지스트리에 엔트리를 넣고 `createAdapter`의 분기를 빠뜨리면 실행 시점에야 죽는데,
   그 시점은 사용자가 그 모델을 고른 뒤이고 라우터는 그것을 **고를 수 있는 것으로 이미
   보여준 뒤**다.
3. **이 대조가 실제로 무언가를 잡는다.** 가상의 공급자를 하나 얹어 1번이 그걸 집어내는지
   확인한다. 대조 검사는 대조 대상이 비거나 비교가 어긋나면 **언제나 통과하는 방식으로**
   고장 나고, 그 고장도 초록색으로 보인다.

fake는 요구하지 않는다. 실전 어댑터가 아니고, 요구하면 표가 검사할 수 없는 것(로컬 스크립트)을
떠안는다 — fake의 전송 무관 계약은 14.4절이 이미 같은 함수로 확인한다.

## 15. 역할별 모델 지정 (구현됨)

12절 질문("완전 자동 vs. 역할별 수동 지정 vs. 힌트만")에 대한 답: **역할별 수동 지정을 태스크
단위로 노출하고, 지정은 힌트가 아니라 요구로 다룬다.**

### 15.1 선호(preference)와 지정(pin)은 다른 것이다

라우터에는 이미 `preferred`가 있었다(환경변수 `TOMVERSE_EXECUTOR_MODEL` 등). 그건 **쓸 수
없으면 조용히 다른 걸 쓰고** 사유를 `reason`에 남긴다. 기본값에는 그게 맞다 — 기본값은
"이걸 우선 써보라"는 뜻이다.

`modelPins`는 다르다. **사용자가 이번 태스크에 대해 고른 값**이고, 대체하면 사용자는 자기가
고르지 않은 모델에 자기 돈이 나간 것을 나중에 안다. 그래서 지정은 대체하지 않고 `RoutingError`로
**멈춘다** — 첫 유료 호출 전이다.

거부 사유는 **무엇을 고쳐야 하는지로 갈라 말한다**: 모델 목록에 없음(오타) / 그 공급자의 키가
없음 / 조직 인증 필요 / 지원 종료. gpt-5 사례가 정확히 이것이었다 — 모델 가용성은 전역 사실이
아니라 **자격증명별 사실**이고, "쓸 수 없습니다"만 말하면 사용자가 할 수 있는 일이 없다.

**태스크 정책의 지정이 환경변수 선호보다 우선한다.** 기본값이 선택을 덮으면 선택이 아니다.

### 15.2 불변식이 지정을 이긴다 — 그리고 그 사실을 표시한다

지정한 검수자가 실행자와 **같은 공급자**인 경우가 있다. 선택지가 둘뿐이다:

- 다른 모델로 바꿔 배정한다 → "지정은 대체하지 않는다"가 깨진다.
- 지정대로 쓴다 → 원칙 4("같은 공급자로 검증한 척하지 않는다")가 깨진다.

**원칙 4를 지킨다.** 검수 역할을 드롭하고 `reviewer_dropped:pinned_not_independent`를 남긴다.

근거는 권위의 관할이다(product-strategy 16절): 사용자 권위는 **"무엇을 만들 것인가"**에 대한
것이고, **"우리가 무엇을 검증이라 부를 것인가"는 우리가 파는 것**이다. 사용자가 독립적이지
않은 검수를 원한다고 해서 그것을 독립 검수라고 부를 수는 없다. 대신 드롭 사실과
"결정론적 검증은 그대로 수행된다"를 함께 말한다.

### 15.3 co-executor는 지정할 수 없다

대조용 두 번째 실행자의 **유일한 일이 primary와 다른 것**이다(13.1절). 사용자가 고르게 하면
둘을 같게 만들 수 있고, 그 순간 "불일치 없음"은 정보가 아니라 착시가 된다. 그래서 지정 가능한
것은 primary executor와 reviewer뿐이며, 화면이 그 이유를 적는다.

### 15.4 목록은 Node가 준다

화면이 고르려면 모델 목록이 필요한데 레지스트리는 Node에 있다. `models.list`가 **`available()`을
그대로** 태워 돌려준다 — 전체 카탈로그를 보내고 화면이 거르게 하면 화면과 라우터가 서로 다른
규칙으로 걸러 **"고를 수 있게 보였는데 시작하면 거부되는" 모델**이 생긴다.

단가를 함께 보낸다. 모델 선택은 대부분 비용에 관한 결정이고, 숫자 없이 고르라고 하면 사용자는
이름으로 고른다.

Rust는 이 값을 **해석하지 않고 그대로 넘긴다.** 모델 목록은 Node의 것이므로, Rust가 별도로
검증하면 두 곳이 서로 다른 규칙을 갖게 된다.

### 15.5 확실히 거부되는 조합은 시작 전에 말한다

상한이 **한 호출의 최대 비용보다 작으면 첫 호출부터 거부된다**(10.6.3절). 종전에는 그 사실이
스냅샷을 만들고 라우팅을 마친 **뒤에야** 오류로 나왔다. 모델 선택과 상한을 같은 화면에서 받고
있으므로, 시작하기 전에 말할 수 있다.

**확실할 때만 말한다.** "자동"이면 라우터가 어느 모델을 고를지 화면은 모르므로, 후보 중 **가장
싼** 모델을 기준으로 잡는다 — 그보다 상한이 작으면 **어떤 선택으로도** 거부되므로 그 경고는
추측이 아니라 사실이다. 반대로 "비쌀 수도 있습니다" 같은 경고는 하지 않는다: 틀릴 수 있는
경고는 몇 번 지나면 읽히지 않고, 그러면 맞는 경고도 함께 묻힌다.

**화면이 비용을 계산하지 않는다.** `models.list`가 `maxCallCostUsd`를 함께 보내며, 그 값은
예산 원장이 예약할 때 쓰는 **바로 그 함수**(`estimateCall`)가 낸다. 화면이 같은 공식을 다시
구현하면 두 벌이 생기고, 그 순간 "예상"과 "실제로 예약되는 금액"이 조용히 갈라진다 —
`envelopeIdentity`가 두 파일에 복사돼 있던 것과 같은 모양이다(14.1절).

**가격을 모르는 모델은 기준이 되지 않는다.** 0으로 세면 "가장 싼 모델"이 되어 어떤 상한도
통과하게 되고, 이 점검이 아무것도 막지 못한다.

**막지는 않는다.** 사실만 말하고 실행 버튼은 그대로 둔다 — 17.11절의 자격증명 모양 경고와 같은
처리이며, 요구의 최종 권위는 사용자다(원칙 1).

## 16. 워크스페이스별 공급자 허용 목록 (구현됨)

12절 질문은 "Policy Gate와 어떻게 맞물리는지"였다. **답은 맞물리지 않는다는 것이다.**

### 16.1 게이트에 얹을 자리가 없다 — 그래서 주입 지점이 게이트다

Policy Gate가 판정하는 것은 **도구 요청**이다(파일·셸). 공급자 호출은 거기를 지나지 않는다 —
HTTP는 Node가 직접 한다. 그래서 "이 워크스페이스는 이 공급자만 쓴다"를 게이트에 넣을 자리가
없고, Node 안에서 검사하면 예산 상한과 같은 한계를 갖는다(장악당한 Node는 그 검사를 지운다).

**자격증명 주입 지점은 다르다.** 허용되지 않은 공급자의 키를 애초에 주입하지 않으면 Node는 그
공급자를 호출할 **수단이 없다.** 검사를 지워도 키가 없다. 그래서 필터가 `credential_env_for`에
있고, 그 함수 하나가 이 제한의 강제 전부다.

Rust가 이미 자격증명을 소유하고 sidecar spawn 시 1회 주입한다는 구조(process-architecture 2절)
덕분에 새 강제 장치를 만들 필요가 없었다. **구조가 이미 그 자리를 갖고 있었다.**

### 16.2 `null`과 `[]`는 다른 사실이다

`null`은 **제한 없음**, `[]`는 **아무것도 허용하지 않음**이다. 둘을 같게 다루면 빈 목록을 저장한
사용자에게 전부 허용되는데, 그건 사용자가 지시한 것의 정반대다. 저장(SQLite NULL vs `'[]'`),
읽기, 필터링, 화면이 전부 이 구별을 지킨다.

**깨진 기록을 "제한 없음"으로 읽지 않는다.** 그러면 저장이 망가진 순간 제한이 조용히 사라지고,
사용자는 자기가 건 제한이 걸려 있다고 믿는다. 읽지 못하면 워크스페이스를 열지 않는다.

### 16.3 저장소 안의 파일이 아니라 앱의 상태 DB에 둔다

워크스페이스 안의 설정 파일에 두면 **모델이 고칠 수 있는 파일이 자기 데이터가 어디로 나갈지를
정하게 된다.** 이 앱의 태스크는 워크스페이스 파일을 바꾸는 것이 일이므로, 그건 정책을 지키는
주체가 정책을 수정할 수 있는 구조다. 앱의 상태 DB는 Rust의 것이고 어떤 도구도 여기 쓰지 못한다.

### 16.4 즉시 적용되지 않는다 — 그리고 그렇게 말한다

강제가 spawn 시점의 주입이므로, 이미 떠 있는 sidecar에는 예전 키가 들어 있다. 저장은 하되
**"다시 열어야 적용된다"를 화면이 말한다.** 몰래 sidecar를 재시작하면 진행 중인 태스크가 죽고,
그건 사용자가 요청하지 않은 손실이다.

### 16.5 이건 기업 통제가 아니다

BYOK 데스크톱에서 **사용자가 곧 관리자**다. 자기가 건 제한은 자기가 풀 수 있으므로, 이것은
조직이 강제하는 데이터 주권 통제가 아니라 **사용자 자신의 가드레일**이다("이 저장소는 사내
코드이므로 이 공급자로만 보낸다").

그렇다고 값어치가 없지는 않다 — 실수로 다른 공급자에 사내 코드를 보내는 것을 구조적으로 막고,
그 강제는 UI 토글이 아니라 키의 부재다. 조직이 강제하는 정책이 되려면 라이선스/정책 백엔드가
목록을 내려줘야 하며 그건 11절의 HTTP 계약(M6)에 딸린다. **지금 이것을 기업 기능이라고 부르지
않는 이유**를 여기 적어두는 것은, 나중에 그렇게 부르고 싶은 유혹이 생기기 때문이다.

## 17. 자격증명 확인 — 무료로 알 수 있는 것까지만 (구현됨)

12절의 "가용성 확인 UX" 절반. **키가 틀렸거나 만료됐다는 사실을 태스크 중간이 아니라 시작 전에
알 수 있어야 한다.**

### 17.1 유료 확인을 하지 않는 이유는 비용이 아니라 기록이다

최소 추론 호출로 확인하면 더 강한 사실을 얻는다 — 실제로 가설 게이트의 `probe-models`가 그렇게
한다. 그러나 제품에서 그렇게 하면 **태스크에 속하지 않는 지출**이 생긴다. 그 호출은 예산
원장(10.6절)에도 전송 기록(product-strategy 7절)에도 자리가 없다 — 둘 다 태스크 단위이기 때문이다.

기록되지 않는 지출을 만드는 것은 이 제품이 파는 것과 정면으로 어긋난다. 그래서 제품은 **무료
모델 조회 엔드포인트**만 쓰고, 유료 확인은 Run Card로 승인받는 게이트에 남긴다.

### 17.2 `listed`는 `ok`가 아니다

결과 이름이 `ok`가 아니라 `listed`인 것이 이 기능의 핵심이다.

- **증명하는 것**: 이 키로 이 모델이 조회된다. 키가 틀렸거나 만료됐거나 다른 프로젝트의 것이면
  여기서 걸린다 — 실사용에서 가장 흔한 실패다.
- **증명하지 못하는 것**: 호출이 성공한다는 것. **조직 인증이 필요한 모델은 조회는 되고
  추론에서 `model_not_found`가 난다**(gpt-5 사례).

화면도 같은 말을 한다: "조회됨"은 "호출된다"가 아니라고 적는다. 확인이 보증으로 읽히면,
그 확인은 사용자를 안심시킨 만큼 해롭다.

### 17.3 네 상태를 구별한다

`listed` / `auth_failed` / `model_unavailable` / `unreachable`. 특히 마지막이 중요하다 —
네트워크 문제를 키 문제로 보고하면 사용자는 멀쩡한 키를 다시 만든다.

분류는 **공용 오류 분류기**(`normalizeProviderError`)를 그대로 쓴다. 확인 경로에서 따로
판단하면 같은 401이 호출 경로와 확인 경로에서 다르게 읽힌다. 적합성 스위트(14절)가 모든
어댑터에 대해 이 분류가 같은지 확인한다.

### 17.4 공급자마다 한 번

모델마다 확인하면 호출 수가 모델 수만큼 늘어난다. 여기서 잡으려는 실패(키가 틀렸다·만료됐다)는
**공급자 단위**이므로 공급자당 한 번이면 된다.

어댑터를 만들지도 못한 경우(키 없음 등)도 **결과의 한 종류로 돌려준다.** 예외로 던지면 공급자
하나 때문에 나머지 확인 결과가 통째로 사라진다.

## 19. Gemini 어댑터 — 만든 것과 확인되지 않은 것 (M2)

8.2절의 "멀티프로바이더 + BYOK: OpenAI·Anthropic·**Google** 3사"가 요구하는 세 번째 공급자다.
그리고 13.3절 절충 실험이 기다리던 선행 조건이기도 하다(12절).

### 19.1 구조화 출력은 세 번째 메커니즘을 쓴다

`StructuredOutputMode`에는 처음부터 `response_schema`가 있었다 — Insight 카탈로그에서 온 구분이고
주석도 "Gemini responseSchema 계열"이라고 적어두었다. **축은 설계에 있었고 쓰는 어댑터가 없었을
뿐이다.** 그래서 openai-compatible 엔드포인트로 우회하지 않고 native로 만들었다: 우회하면
`strict_schema`인 척하게 되는데, 그건 실제로 강제되는 것과 다른 값을 레지스트리에 적는 것이다.

세 메커니즘(strict json_schema / 강제 도구 호출 / responseSchema)이 **같은 스키마 객체를
공유한다.** 모델마다 다른 것을 요구하면 대조·검수·게이트가 재는 차이에 "우리가 다르게 물었다"가
섞인다. 적합성 스위트가 이 전제를 지킨다.

### 19.2 SDK를 쓰지 않았다

다른 둘은 공식 SDK를 쓰는데 여기서는 `fetch`를 직접 쓴다. 이유는 의존성 절약이 아니라 **검증
가능성**이다: 적합성 스위트는 `fetch`를 주입해 어댑터 본체(요청 조립 → envelope 해석 → 정규화)를
태우는데, SDK를 한 겹 올리면 그 검증이 SDK 동작에 가려진다. 와이어 형식이 JSON POST 하나라
직접 쓰는 비용도 낮다.

정규화에서 실제로 갈리는 자리가 셋이었다 — 본문은 `candidates[].content.parts[].text`, 모델
식별자는 `model`이 아니라 **`modelVersion`**, 사용량은 `usageMetadata.promptTokenCount` /
`candidatesTokenCount`. 특히 사용량은 이름이 안 맞으면 **비용이 조용히 0이 되고**, 0인 비용은
"안 썼다"로 읽힌다. 공용 `envelopeIdentity`가 `model` 키를 보므로 여기서는 쓰지 않는다 —
요청한 값으로 채우면 exact-model 검증이 언제나 통과해 조용한 대체를 못 잡는다(10.8절).

### 19.3 스키마 변환은 **버리는 쪽**으로 기울인다

Gemini의 `responseSchema`는 JSON Schema 전체가 아니라 OpenAPI 3 스키마의 부분집합이다. 우리
스키마의 `additionalProperties` 같은 키를 그대로 보내면 요청이 거부되고, **그 거부는 모델의 답이
나쁜 것으로 읽히기 쉽다** — 실제로는 우리가 잘못 물은 것이다.

그래서 아는 키만 통과시키고 나머지는 버린다. 버리면 제약이 느슨해지지만 그건 경계의 `validate*`가
잡는다(모든 공급자가 같은 검증을 지난다). 모르는 키를 보내 요청이 통째로 거부되면 아무것도 받지
못한다 — 둘 중 덜 나쁜 쪽이다. `required`는 예외로 그대로 옮긴다: 느슨해지면 안 되는 제약이다.

### 19.4 착지 기준 — 여기서 확인되지 않는 것

Job Object(state-machine 20.6절)·sidecar 번들(process-architecture 10.4절)과 **같은 모양의
유보**다. 요청 조립·envelope 해석·정규화·오류 분류는 주입된 `fetch`로 전부 검증되지만,
**Google이 실제로 이 요청을 받아들이는지는 확인되지 않았다** — 이 저장소의 개발 환경에는
`GEMINI_API_KEY`가 없고 egress도 막혀 있다.

아래가 전부 참으로 확인되기 전까지 이 항목은 "구현됨"이지 "검증됨"이 아니다.

1. `checkCredential`이 실제 키로 `listed`를 돌려준다.
2. `generateDraft`가 실제 호출에서 스키마를 만족하는 JSON을 돌려준다 — 즉 **19.3의 변환이
   Gemini에게 유효한 스키마다.**
3. 응답의 `modelVersion`이 요청한 모델 ID와 대응한다(alias면 `acceptedProviderModelIds`로 다룬다).
4. `usageMetadata`가 실제로 채워져 온다 — 비어 오면 비용이 0으로 집계되므로, 그 경우 "모른다"로
   보고해야 하는지 다시 정해야 한다.

**확인 수단은 이미 있다**: 가설 게이트의 `probe-models`가 역할당 최소 요청 1회로 이 넷 중
1·3을 확인한다("레지스트리에 있으므로 사용 가능"은 승인 근거가 아니다). 2·4는 실제 초안 요청이
필요하므로 pilot 첫 실행에서 확인한다.

**그때까지 라우터가 이 공급자를 고르는 것은 막지 않는다.** BYOK에서 키를 넣은 사용자는 그것을
쓰겠다는 뜻이고, 실패하면 오류 분류가 그 사실을 말한다 — 우리가 대신 "아직 못 쓴다"고 정하면
자격증명을 가진 사용자에게 근거 없는 제한이 된다.

## 20. Credential Store — 만든 것 (M3)

12절이 "데스크톱 사용자가 앱 안에서 키를 넣을 수 없다"로 열어두었던 자리. 착지 기준은 18절,
확인 상태는 [windows-landing-record.md 14절 #8](./windows-landing-record.md).

구조는 세 조각이다.

| 조각 | 파일 | 하는 일 |
|---|---|---|
| 트레이트 | `core/src/credentials.rs` | `store`/`forget`/`has`/`read_for_injection`, `Secret`, 주입 봉투 |
| Windows 구현 | `core/src/win_credentials.rs` | Credential Manager(`CredWriteW`/`CredReadW`/`CredDeleteW`) |
| 주입 지점 | `core/src/lib.rs` | 저장소 → 환경변수 순으로 풀어 **spawn 시 1회** 넘긴다 |

**sidecar가 보는 그림은 하나도 바뀌지 않았다.** 여전히 환경변수를 읽고, 여전히 spawn 시
1회 주입이며, 허용 목록 필터도 같은 자리에 있다(16절). 저장소는 주입 지점 **앞**에 놓인 것이다.

### 20.1 저장 형식 — 되돌리기 비싼 결정

바꾸면 이미 저장한 사용자의 키가 **사라진 것처럼 보인다.** 그래서 값과 근거를 여기 남긴다.

| 무엇 | 값 | 왜 |
|---|---|---|
| 저장 계층 | Windows Credential Manager | 직접 `CryptProtectData`를 부르면 **암호문이지만 파일이 하나 생긴다** — 그 파일의 권한·백업·동기화 폴더 포함 여부를 우리가 관리하게 된다. Credential Manager는 같은 DPAPI 위에 서 있으면서 그 관리를 OS가 하고, **사용자가 목록을 보고 지울 수 있다**(`control keymgr.dll`). 우리가 만든 파일은 앱을 지워도 남는다 |
| `Type` | `CRED_TYPE_GENERIC` | 도메인 자격증명이 아니다. 임의 blob을 담을 수 있는 유일한 종류 |
| `TargetName` | `TomverseCode/<providerId>` | 접두사가 우리 항목을 한 눈에 모은다 |
| `UserName` | `<providerId>` | 자격 증명 관리자 화면에 무엇인지 보인다. **비밀이 아니다** |
| blob | 키의 **UTF-8** 바이트 | UTF-16으로 두면 다른 도구가 읽을 때 인코딩을 추측해야 한다 |
| `Persist` | `CRED_PERSIST_LOCAL_MACHINE` | `ENTERPRISE`는 도메인 프로필과 함께 **로밍한다** — API 키를 사용자 모르게 다른 머신으로 보내지 않는다 |

**`providerId`는 모양을 검사한 뒤에만 이름이 된다**(소문자·숫자·`-`·`_`, 64자 이하).
임의 문자열이 들어오면 Credential Manager의 다른 항목을 가리키는 이름을 만들 수 있다.
"그 공급자가 제품에 있는가"는 저장 계층이 아니라 `PROVIDER_ENV_VARS`가 답한다 —
저장 계층이 제품 표를 알면 저장 계층의 테스트가 제품 표에 묶인다.

**값을 지우지 않는다(zeroization).** `CredReadW`가 준 버퍼를 `CredFree` 전에 0으로 덮는 길이
있지만, 주입하려면 값이 어차피 Rust `String`으로 살아야 하고 그 `String`은 힙에 남으며 페이지
파일로 나갈 수도 있다. 한쪽만 지우면 **지키지 못하는 보장을 약속하게 된다.**
이 저장소가 약속하는 것은 **at rest**이지 in-memory가 아니다.

### 20.2 트레이트 경계 — 그리고 왜 폴백이 없는가

개발은 Linux에서 돌고 DPAPI는 Windows API다. 그래서 저장 계층이 트레이트 뒤에 있다.
**그 구조에서 가장 위험한 것은 조용한 폴백이다**: 개발용 구현이 프로덕션에서 쓰이면
"키가 안전하게 저장된다"가 거짓이 되고, 그 증상은 보이지 않는다.

그래서 폴백을 규율이 아니라 **컴파일러**로 막는다.

- `MemoryCredentialStore`는 `#[cfg(any(test, not(windows)))]`다 — **Windows 릴리스 빌드에
  타입 자체가 없다.** 폴백을 쓰려면 그 cfg를 고쳐야 하고, 그건 눈에 띄는 변경이다.
  그리고 눈에 띄지 않게 넓히는 것을 `credentialBoundary.test.ts`가 막는다.
- `open_credential_store()`는 **`Result`가 아니다.** 여는 데에 얻을 자원이 없기 때문이기도
  하지만, 더 큰 이유는 `Result`로 두면 호출자마다 "열지 못했을 때"라는 분기가 생기고
  **그 분기가 곧 조용한 폴백이 자라는 자리**이기 때문이다. 실패는 `store`/`forget`/`has`에서
  나고, 그 자리가 사용자에게 보일 자리이기도 하다.

**개발용 구현은 메모리에만 있다.** 파일에 쓰면 평문이 디스크에 남고(기준 2가 금지하는 그것),
"직접 암호화한다"는 더 나쁘다 — 키를 어디 둘지가 그대로 남는데 암호화했다는 사실이 잘못된
확신을 준다. 저장하지 않는 쪽을 고르고, **앱을 끄면 사라진다는 사실을 화면이 말한다**
(`StoreKind::survives_restart`).

### 20.3 원칙 3을 가시성으로 강제한다

종전에는 `credential_env_for`가 평문 쌍(`Vec<(String, String)>`)을 그대로 돌려주었고, 그것을
받는 코드가 **`src-tauri` 껍데기 크레이트**였다. 원칙 3("UI 프로세스는 API 키를 갖지 않는다")이
"껍데기가 값을 들여다보지 않는다"는 규율로만 지켜지고 있었던 셈이다.

이제 `CredentialInjection` 봉투로 감싸고 값 꺼내기(`into_pairs`)를 `pub(crate)`로 둔다.
**다른 크레이트는 값을 꺼낼 수단이 없다** — 껍데기는 만드는 곳(`credential_injection_for`)에서
쓰는 곳(`launcher::config_from`)으로 옮길 수만 있고, 옮기는 것 말고 할 수 있는 일이 없다.

같은 이유로 `Secret`에는 `Display`도 `Serialize`도 없고 `Debug`가 값을 가린다.
`format!("{:?}")`이 로그·이벤트·오류 메시지 어디에 있어도 값이 나오지 않는다.

### 20.4 저장소가 환경변수보다 앞이다 — 그리고 충돌은 조용하지 않다

둘 다 있고 값이 **다르면** 저장소를 쓴다. 사용자가 앱 안에서 넣은 것이 최신 의도이고,
환경변수는 몇 달 전에 설정해 두고 잊은 값일 수 있다.

**차단하지 않는다.** sidecar의 `resolveCredential`은 같은 상황을 `ambiguous`로 막는데(§2.10),
거기서 막는 것은 승인과 실행이 다른 키를 쓰는 것을 방지하기 위해서다. 여기서 막으면
**예전에 설정한 환경변수 하나 때문에 앱이 아무것도 못 하게 된다.** 대신 `conflict`를
화면에 올려 **어느 쪽이 쓰이는지 말한다** — 말하지 않으면 "앱에서 키를 바꿨는데 예전 키로
호출된다"는 의심이 남고, 그 의심은 확인할 방법이 없다.

**환경변수 경로는 사라지지 않는다.** 헤드리스 호스트(`tomverse-host`)·e2e·가설 게이트가
계속 쓰고, 그쪽에는 키를 넣을 화면이 없다. 다만 **같은 함수를 지난다** — 진입점이 둘이면
갈라지고, 이 저장소는 그 사고를 이미 겪었다(`.bat`만 `_env.bat`을 call하던 일).

### 20.5 적용 시점 — "키를 넣었는데 왜 그대로지"

주입은 sidecar spawn 시 1회다. 그래서 **이미 떠 있는 백엔드의 환경은 바뀌지 않는다.**
화면이 그 사실을 말하지 않으면 사용자는 자기가 뭔가 잘못했다고 믿는다. 저장·삭제 결과에
`appliesToNextSpawn`이 실리고, 화면이 "다음에 워크스페이스를 열 때부터"라고 적는다.

**몰래 재spawn하지 않는다** — 16절 허용 목록과 같은 이유다: 진행 중인 작업이 죽는다.
