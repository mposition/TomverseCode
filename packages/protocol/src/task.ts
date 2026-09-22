import type { ComplexityTier, EffortLevel, ISODateTime } from "./common.js";
import type { AcceptanceCriterion, CriterionEvaluation } from "./decision.js";
import type { PlanOutline, QuestionAnswer } from "./proposal.js";
import type { RoutingDecision } from "./registry.js";
import type { CommandPolicy } from "./tools.js";
import type { VerificationReport } from "./verification.js";

export interface TaskRequest {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  userMessage: string;
  attachments?: { path: string; note?: string }[];
  /**
   * 이 요청이 **바꿔 달라는 것인가 물어보는 것인가** (state-machine 51절).
   *
   * 기본값은 `change`다 — 값이 없으면 종전과 한 글자도 다르지 않게 동작한다.
   *
   * **모드가 아니라 요청의 종류다.** `executionMode`(fast/verified)는 같은 일을 얼마나
   * 신중하게 할지를 정하지만 이건 **하는 일이 다르다**: 질문은 patch를 만들지 않고
   * 검증하지 않으며 `COMPLETED`에 도달하지 않는다.
   *
   * `plan`은 세 번째 종류다(53절). 질문과 마찬가지로 파일을 바꾸지 않지만 **답이 아니라
   * 제안**을 내고, 그래서 종착지도 다르다 — 사용자의 다음 행동이 "읽고 끝"이 아니라
   * "그럼 해 줘"이기 때문이다.
   */
  kind?: "change" | "question" | "plan";
  /**
   * 이 실행이 **어느 정지에서 이어졌는가** (state-machine 62절).
   *
   * # 왜 "재개"가 아니라 링크인가
   *
   * 무인 정지는 `FAILED`로 끝나고 그 시점의 초안·검수·계획은 sidecar의 메모리에 있었다 —
   * 프로세스가 끝나면 사라진다. **재개할 상태가 없으므로** 이어서 도는 것은 새 태스크이고,
   * 여기 담기는 것은 그 사실을 감사 기록이 답할 수 있게 하는 **연결**뿐이다.
   *
   * 이 값이 있어도 우리는 앞선 태스크의 무엇도 이 태스크의 근거로 쓰지 않는다. 쓰면
   * "재개했다"는 주장이 성립하는 것처럼 보이고, 그건 27절이 세션 메모리에 대해 막은 것과
   * 같은 종류의 미끄러짐이다(나른 것은 이 태스크의 기준이 아니다).
   */
  followsUp?: string;
  createdAt: ISODateTime;
}

/**
 * docs/design/state-machine-and-protocol.md 2.2절 — 모든 루프 상한은 여기서 읽는다.
 * CLAUDE.md 원칙 5: 상한을 하드코딩하지 않고, 상한 없는 루프를 만들지 않는다.
 */
export interface TaskLoopLimits {
  clarificationRounds: number; // 기본 2
  reviseRounds: number; // 기본 2
  fixLoopRounds: number; // 기본 3
  toolRetries: number; // 기본 2
  providerRetries: number; // 기본 3
  /**
   * 초안이 MCP 도구를 요청해 DRAFTING을 다시 도는 횟수 (state-machine 31절). 기본 1.
   *
   * **기본이 1인 것은 관례가 아니라 판단이다.** 라운드마다 초안 하나가 버려지므로 비용과
   * 지연이 라운드 수만큼 는다. 이 기능의 이득은 아직 측정되지 않았고, 측정되지 않은 이득에
   * 곱셈을 걸지 않는다.
   */
  mcpRounds: number; // 기본 1
  /**
   * 질문·계획 경로가 **모델이 요청한 파일을 읽고 다시 묻는** 라운드 수 (state-machine 57절).
   * 기본 1.
   *
   * `mcpRounds`와 같은 이유로 1이다: 라운드마다 답 하나가 버려지므로 비용과 지연이 라운드
   * 수만큼 늘고, **이 기능의 이득은 아직 측정되지 않았다.** 측정되지 않은 이득에 곱셈을
   * 걸지 않는다.
   */
  contextRounds: number; // 기본 1
  /**
   * **계획을 다시 세우는 횟수** (state-machine 72.11절). 기본 2.
   *
   * `reviseRounds`와 나누는 이유: 후자는 *초안*을 고치는 횟수이고 계획을 다시 세우는 것은
   * 다른 일이다. 한 카운터를 공유하면 초안 수정을 두 번 한 태스크가 계획을 한 번도 고치지
   * 못하게 되는데, 그 둘은 서로를 제약할 이유가 없다.
   *
   * **소비 경로가 셋이고 하나도 빠뜨리면 안 된다**: 계획 승인 카드의 "수정 요청",
   * 검증 체크리스트의 거부 경로 2, 그리고 **B의 쟁점 카드를 보고 계획을 고치는 것.**
   * 셋째가 빠지기 쉽다 — 앞의 둘은 사용자가 먼저 움직이지만 이것은 모델이 올린 쟁점에서
   * 시작하므로 "사용자가 요청한 수정"의 목록에 안 들어간다. 그러나 돌아가는 자리는 같은
   * `OUTLINING`이고, 카운터가 다르면 그 고리만 상한 없이 돈다.
   */
  planRounds: number; // 기본 2
  /**
   * 계획이 만들 수 있는 **서브태스크 수**의 상한 (72.11절). 기본 8.
   *
   * **상한이지 카운터가 아니다** — `TaskCounters`에 대응하는 항목이 없는 유일한 줄이다.
   * 서브태스크는 계획 산출물의 길이이지 반복 횟수가 아니므로 "몇 번 돌았는가"를 셀 것이
   * 없다. 셋을 한 자리에 뭉뚱그리면 `counters_json`이 원칙 7의 파생 캐시라는 성질과 어긋난다.
   */
  maxSubtasks: number; // 기본 8
  /**
   * 런타임 에스컬레이션 호출 수의 **천장** (72.10.2절). 기본 2.
   *
   * **2.2절 표가 값을 적지 않는 유일한 줄에 대응한다** — 실제 상한은 사용자가 승인 카드에서
   * 확정한 `maxCalls`이고, 여기 있는 것은 **제품이 제안하는 값이자 그 제안의 천장**이다.
   * 둘 다 여기 있어야 하는 이유는 원칙 5다: 사용자가 정한 값이 유일한 상한이면 상한이
   * 사용자 입력에 의존하게 되고, **봉투가 무제한이면 상한이 아니다.**
   */
  escalationCalls: number; // 기본 2
}

export const DEFAULT_LOOP_LIMITS: TaskLoopLimits = {
  clarificationRounds: 2,
  reviseRounds: 2,
  fixLoopRounds: 3,
  toolRetries: 2,
  providerRetries: 3,
  mcpRounds: 1,
  contextRounds: 1,
  planRounds: 2,
  maxSubtasks: 8,
  escalationCalls: 2,
};

/**
 * 사용자가 UI에서 고르는 실행 정책 (state-machine 72.9절, ui-wireframes.md).
 *
 * - `fast`: 계획자를 **하나** 부른다.
 * - `verified`: 계획자를 **둘** 부르고 갈린 지점을 계획 승인 카드에 올린다(대조).
 *
 * 둘 중 어느 쪽이든 `VERIFYING`은 생략되지 않는다(CLAUDE.md 원칙 1).
 *
 * # 이 축은 `complexityTier`를 정하지 않는다
 *
 * 종전 주석은 *"verified: TRIAGE 결과와 무관하게 항상 standard"*라고 적었고 구현도 그랬다.
 * **72.9절이 그것을 뒤집었다.** `verified`인 태스크도 TRIAGE가 `simple`로 분류하면
 * `SINGLE_MODEL_FIX` 한 번으로 끝난다 — `verified`는 **"계획자를 둘 부르라"**는 지시이지
 * "이 태스크를 어렵게 다루라"는 지시가 아니다.
 *
 * 사용자가 tier를 올리고 싶으면 **tier 축에서 올린다**(`forceComplexityTier`와 같은 축).
 * 그 수단을 모드 축에 얹지 않는 것이 요점이다 — 얹으면 17.5절이 고친 혼동이 이름만 바꿔
 * 돌아온다.
 *
 * # 둘이 되는 것은 executor가 아니라 계획자다
 *
 * 종전 주석의 뒷부분(*"대조(executor ×2)는 이 축이 정한다 … tier는 교차검증을, 이 축은
 * 대조를 켠다"*)도 함께 뒤집힌다. 대조가 patch 단계에 있으면 서브태스크 분해가 들어오는
 * 순간 **서브태스크마다 executor ×2**가 되어 N배가 되고, 불일치 카드를 붙일 게이트도 없다.
 * 계획 단계로 옮기면 추가 호출은 1회, **추가 정지는 0**이다("마찰 0"이 아니다 — 카드가
 * 붙으면 읽을 것이 는다).
 *
 * **기본값은 `verified`를 유지한다.** 바꾸지 않는 근거가 아니라 **뜻이 바뀌었다는 것이
 * 근거다**: 종전 기본값은 TRIAGE 판정을 버리고, 게이트가 부정한 단계(patch 검수)를 켜고,
 * 미측정 단계(대조)를 켰다. 재정의 뒤에는 TRIAGE가 살아나고, 부정된 단계는 물러났으며,
 * 켜지는 것은 미측정 단계 하나에 호출 1회다.
 */
export type ExecutionMode = "fast" | "verified";

/**
 * 사용자가 고르는 세 번째 축 — **어느 등급의 모델이 구현하는가**(72.9·72.10절).
 *
 * `EffortLevel`과 직교한다: 이쪽은 **모델 교체**, 저쪽은 **같은 모델의 추론 예산**이다.
 *
 * # clamp이지 선택이 아니다
 *
 * 등급을 직접 정하지 않고 **계획 모델의 판정을 어느 범위로 가두는지**만 정한다.
 *
 * - `economy`  위를 `economy`로 막는다 — 계획이 `frontier`라 해도 내린다
 * - `balanced` **막지 않는다** — 계획 모델의 판정을 그대로 쓴다(항등)
 * - `max`      아래를 `frontier`로 막는다 — 전부 `frontier`
 *
 * **위험 하한선은 clamp보다 세다.** `economy`를 골라도 `auth/`·`payment/` 경로의
 * 서브태스크는 내려가지 않는다 — 사용자가 고르는 것은 **비용이지 위험 감수 수준이 아니고**,
 * 후자를 비용 선택에 딸려 보내면 그 선택의 뜻이 달라진다.
 *
 * **계획은 이 축과 무관하게 frontier다.** 계획 호출은 한 번이고 출력이 작은데 그 한 번이
 * 분해·등급·N개의 구현 호출을 전부 결정한다. 그리고 논리가 뒤집혀 있다 — **좋은 계획이 싼
 * 구현을 가능하게 한다.** 계획자는 `economy` 프로파일의 희생자가 아니라 전제 조건이다.
 *
 * **기본값은 `balanced`다.** clamp를 걸지 않는 항등이라 기본값 공백과 동작이 같지만,
 * **동작이 같다는 것이 적지 않아도 된다는 뜻은 아니다** — 적지 않으면 나중에 누가 기본을
 * `economy`로 바꿀 때 그것이 기본값 변경인지 공백을 채우는 것인지 구별할 수 없고, 그 둘은
 * 되돌리기 비용이 다르다. `balanced`를 고른 근거: 등급 판정을 계획 모델에게 맡긴다는 것이
 * 이 설계의 입장이고, 기본값이 clamp를 걸면 제품이 그 입장을 스스로 뒤집는다.
 */
export type PerformanceProfile = "economy" | "balanced" | "max";

/** 72.9절 기본값. 축 둘을 **함께** 넣는다 — 하나만 먼저 넣으면 화면이 "나머지는 어디 있나"를 묻는다. */
export const DEFAULT_PERFORMANCE_PROFILE: PerformanceProfile = "balanced";
/** 72.9절 기본값. 항등에 가장 가까운 값이다. */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "medium";

export interface TaskPolicy {
  limits: TaskLoopLimits;
  /** state-machine-and-protocol.md 13.2절 — 워크스페이스별 tier 강제 */
  forceComplexityTier: ComplexityTier | null;
  /** run_command allowlist/denylist. 비어 있으면 Rust의 기본 정책이 쓰인다. */
  commandPolicy?: CommandPolicy;
  /** 파일 생성·수정을 승인 없이 허용할지. 삭제는 이 값과 무관하게 항상 승인이다. */
  autoApproveWorkspaceWrites: boolean;
  /** git commit 자동 생성 허용 여부. 기본 false — 사용자가 명시적으로 승인해야 한다. */
  allowGitCommit: boolean;
  /** 단일 명령 실행 상한 (ms) */
  commandTimeoutMs: number;
  executionMode: ExecutionMode;
  /**
   * 어느 등급의 모델이 **구현**하는가 (72.9절). 기본 `balanced`.
   *
   * **`effortLevel`과 함께 들어왔다.** 축을 하나만 먼저 넣지 않는 이유는 화면이
   * "나머지는 어디 있나"를 묻는 상태로 커밋되기 때문이다(72.15절).
   */
  performanceProfile: PerformanceProfile;
  /**
   * 고른 모델을 **얼마나 깊게** 굴리는가 (72.9절). 기본 `medium`.
   *
   * **역할별로 나누지 않는다 — 태스크 하나에 값 하나다.** 근거는 "그 자리들을 사용자가 못
   * 고르니까"가 **아니다**(검수자는 지정할 수 있다). 진짜 근거는 더 단순하다: **축 하나를
   * 넷으로 쪼개는 값어치를 우리가 모른다.** 역할별 effort가 결과를 바꾸는지는 재지 않았고,
   * 축은 늘리기보다 줄이기가 비싸다. 여기서 미루는 것은 축 자체가 아니라 **축의 분해능**이다.
   *
   * **손잡이가 없는 모델이 있다**(`ModelEntry.effort`가 `{ kind: "none" }`). 그 경우 이 축은
   * 아무것도 하지 않으며, **그 사실이 화면에 있어야 한다** — 없으면 사용자는 올린 슬라이더만큼
   * 더 생각한 결과를 받았다고 읽는다.
   *
   * **비용에 대해 말할 수 있는 것은 방향뿐이다.** effort를 올리면 추론 토큰이 늘어 비용이
   * 늘지만 **얼마나 느는지는 호출 전에 모른다.** 그래서 승인 카드는 이 축을 금액에 곱하지
   * 않는다 — 모르는 배수를 지어내 곱하면 카드가 정확해 보이는 만큼 정확히 틀린다.
   */
  effortLevel: EffortLevel;
  /**
   * **무인 실행인가** (Autopilot — product-strategy 8.2절, state-machine 24절).
   *
   * 오케스트레이터가 이 값을 보는 이유는 하나다: 8.2 기준의 **"검사 실패 시 정지"** 는
   * 사람이 있을 때와 없을 때 뜻이 다르다. 사람이 보고 있으면 "검증되지 않았습니다"라는
   * 문장이 달린 완료가 정직한 보고지만, **무인 실행에서는 그 문장을 읽을 사람이 없다** —
   * 검증 없이 완료된 작업이 완료로 기록되고 다음 단계가 그 위에 쌓인다.
   */
  unattended: boolean;
  /**
   * 프로젝트가 매니페스트에 **선언해 둔** 검증 명령을 매번 묻지 않고 실행한다
   * (state-machine 24.5절).
   *
   * 오케스트레이터는 이 값을 읽지 않는다 — 판단은 전부 Rust에서 일어난다. 여기 있는 이유는
   * 정책이 한 덩어리로 오가기 때문이고, **읽지 않는다는 사실 자체가 중요하다**: Node가
   * 장악당해도 이 값으로 승인을 우회할 수 없다. 자동 승인의 대상 집합은 Rust가 태스크 시작
   * 시점의 매니페스트에서 유도해 고정한다.
   */
  autoApproveVerification: boolean;
  /**
   * 스킬이 **좁힌** 도구 집합 (state-machine 26절). 없으면 좁히지 않는다.
   *
   * **sidecar는 이것을 지키지 않는다** — 강제하는 곳은 Rust의 Policy Gate다. 여기 있는 이유는
   * 화면이 "이 스킬이 무엇을 좁혔는가"를 말할 수 있어야 하기 때문이고, **지키지 않는다는
   * 사실이 중요하다**: Node가 장악당해도 이 값을 바꿔 도구를 늘릴 수 없다.
   */
  allowedTools?: string[];
  /**
   * 이 **태스크 하나**가 공급자 호출에 쓸 수 있는 상한(USD). `null`이면 상한이 없다.
   *
   * # 왜 태스크당인가 (multi-engine-routing.md 10.6절)
   *
   * BYOK이므로 청구는 사용자 계정에서 일어나고, 같은 키를 다른 도구도 쓴다. 우리가 "이번 달
   * 지출"이라고 부를 수 있는 숫자는 **우리가 낸 호출만**의 합이라 실제 청구와 다르고, 그런
   * 숫자를 상한의 근거로 쓰면 틀린 값이 권위 있게 읽힌다. 반면 태스크는 사용자가 요청을 적고
   * 시작을 누르는 **승인의 단위**이며, 그 안에서 일어나는 호출은 전부 우리가 안다.
   *
   * 대가는 명시적이다: **다시 실행하면 상한만큼 다시 쓸 수 있다.** 그건 결함이 아니라 승인
   * 단위가 태스크라는 뜻이고, 화면이 그렇게 말해야 한다.
   *
   * # `null`을 남겨두는 이유
   *
   * 가격을 모르는 모델(레지스트리에 없거나 단가가 비어 있는)에는 상한을 강제할 수 없다.
   * 그때 우리가 할 수 있는 것은 둘뿐이다 — 호출을 거부하거나, 상한 없이 도는 것이다.
   * 사용자가 자기 키로 자기 모델을 쓰겠다는 것을 우리가 막는 것은 요구의 최종 권위를
   * 뒤집는 것이므로(원칙 1), **선택지로 남기고 그 사실을 기록한다.**
   */
  budgetUsd: number | null;
  /**
   * 역할별 **모델 지정** (multi-engine-routing.md 15절).
   *
   * # 선호(preference)와 지정(pin)은 다르다
   *
   * 라우터에는 이미 환경변수로 오는 `preferred`가 있고, 그건 **쓸 수 없으면 조용히 다른 걸
   * 쓴다**(사유는 `reason`에 남는다). 기본값에는 그게 맞다.
   *
   * 여기 있는 것은 **사용자가 이번 태스크에 대해 고른 값**이다. 쓸 수 없을 때 다른 모델로
   * 대체하면, 사용자는 자기가 고르지 않은 모델에 자기 돈이 나간 것을 나중에 안다.
   * 그래서 지정은 대체하지 않고 **멈춘다**(`RoutingError`).
   *
   * # co-planner는 지정할 수 없다
   *
   * 대조용 두 번째 **계획자**의 유일한 일이 primary와 다른 것이다(13.1절). 그걸 사용자가
   * 고르게 하면 둘을 같게 만들 수 있고, 그 순간 "불일치 없음"은 정보가 아니라 착시가 된다.
   *
   * **한때 이 문단은 co-executor를 기준으로 적혀 있었다.** 72.9절이 대조를 patch 단계에서
   * 계획 단계로 옮겼으므로 금지 대상도 함께 옮겨간다(multi-engine 15.3절). `simple`·`fast`에
   * 남는 co-executor는 **없다** — 그 두 경로는 애초에 실행자를 둘 부르지 않는다.
   *
   * # 검수자는 지정할 수 있다 — 독립성을 깨면 **막히는 것이 아니라 드롭된다**
   *
   * 15.2절 규칙이다. 지정한 검수자가 실행자와 같은 공급자면 다른 모델로 바꾸지 않고
   * (그러면 "지정은 대체하지 않는다"가 깨진다) 검수 역할을 드롭하고 그 사실을 표시한다.
   *
   * **그러려면 어느 검토자인지를 말할 수 있어야 한다.** `reviewer` 한 자리뿐이면 72절
   * 흐름에서 그 드롭 규칙이 **B와 C 중 어디에 걸리는지 정해지지 않는다.** 그래서 자리가
   * 갈렸고, 계획자(A) 자리도 생겼다 — 이 변경은 `EngineRole`이 B와 C를 구별하게 되는
   * 변경과 **같은 커밋에서** 정해야 한다. 따로 정하면 두 타입이 다른 역할 분류를 갖는다.
   */
  modelPins?: {
    /** A — 주 계획자. 대조용 두 번째(A′)는 지정할 수 없다. */
    planner?: string;
    /** 구현 모델. 72절 흐름에서는 서브태스크의 등급이 정한 자리를 이 지정이 덮는다. */
    executor?: string;
    /** 종전 `REVIEWING`의 초안 검수자. 72.3절에서 standard 경로가 물러났다. */
    reviewer?: string;
    /** B — 계획 검토자. */
    planReviewer?: string;
    /** C — 결과 검토자. */
    resultReviewer?: string;
  };
}

/**
 * 상한을 유도할 과거가 없을 때의 기본값(USD).
 *
 * **유도하지 못한 상수다.** 첫 사용자에게는 관측할 과거가 없다. 실사용 비용이 쌓이면
 * `tomverse-host metrics`의 `taskCosts`에서 유도하고(`derived_thresholds`), 이 값은 지워지는
 * 대신 **표본이 부족할 때의 기본값으로 밀려난다** — 강제 포기 문턱(16.3절)과 같은 취급이다.
 *
 * 5달러인 이유는 "충분히 크다"가 아니라 **한 번의 호출 최대 비용보다 확실히 크다**는 조건에서
 * 왔다. 상한이 한 호출의 최대 예약보다 작으면 첫 호출부터 거부되어 아무것도 돌지 않는다.
 * 가장 비싼 등록 모델의 한 호출 최대치가 약 $2이므로 그보다 여유를 둔다.
 */
export const DEFAULT_TASK_BUDGET_USD = 5;

export const DEFAULT_TASK_POLICY: TaskPolicy = {
  limits: DEFAULT_LOOP_LIMITS,
  forceComplexityTier: null,
  autoApproveWorkspaceWrites: false,
  allowGitCommit: false,
  commandTimeoutMs: 120_000,
  executionMode: "verified",
  // 72.9절의 축 둘. **함께 적는다** — `balanced`/`medium`은 항등에 가장 가까운 값이고,
  // 기본값 공백과 동작이 같더라도 적어 두어야 나중에 누가 바꿀 때 그것이 **변경인지
  // 공백 채우기인지** 구별된다. 그 둘은 되돌리기 비용이 다르다.
  performanceProfile: DEFAULT_PERFORMANCE_PROFILE,
  effortLevel: DEFAULT_EFFORT_LEVEL,
  // **기본은 사람이 있다고 본다.** 무인이 기본이면 UI 경로가 실수로 무인 규칙을 타게 되고,
  // 그건 완료로 보고돼야 할 것을 실패로 만든다.
  unattended: false,
  // 검증 명령도 기본은 물어본다. "프로젝트가 선언했다"는 것은 안전의 근거이지 사용자가
  // 그렇게 하기로 정했다는 뜻이 아니다.
  autoApproveVerification: false,
  budgetUsd: DEFAULT_TASK_BUDGET_USD,
};

export type TaskPhase =
  | "CREATED"
  | "SNAPSHOTTING"
  | "TRIAGE"
  | "DRAFTING"
  | "SINGLE_MODEL_FIX"
  | "REVIEWING"
  | "AWAITING_USER_INPUT"
  | "PLANNING"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "FIX_LOOP"
  /**
   * 취소 요청을 받고 정리 중. M0.1에서 추가됐다.
   *
   * 왜 별도 phase가 필요한가: 취소는 즉시 일어나지 않는다 — 실행 중인 자식 프로세스를 죽이고
   * 진행 중인 모델 호출을 끊는 데 시간이 걸린다. 그 사이 UI가 "실행 중"으로 보이면 사용자는
   * 취소 버튼이 동작하지 않았다고 생각하고 다시 누른다.
   */
  | "CANCELLING"
  /**
   * 질문에 답하는 중 — state-machine-and-protocol.md 51절.
   *
   * **파일을 바꾸지 않는 경로다.** 스냅샷을 만들고 모델을 한 번 부르고 끝난다.
   */
  | "ANSWERING"
  /**
   * 계획을 세우는 중 — state-machine 53절.
   *
   * **`PLANNING`이 아니다.** 그 이름은 이미 "patch를 도구 호출로 쪼개는" 단계가 쓰고 있고,
   * 이 경로는 patch를 만들지 **않는다.** 비슷한 이름을 재활용하면 둘 중 하나를 읽는 사람이
   * 다른 쪽 의미로 읽는다 — 그리고 그 오해의 방향이 하필 "이건 실행할 수 있는 계획이다"다.
   */
  | "OUTLINING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REJECTED"
  /**
   * 앱이 비정상 종료되어 중단됨. **Node 상태 머신은 이 상태로 전이하지 않는다** —
   * 호스트(Rust)가 앱 시작 시 터미널이 아닌 태스크를 발견해 확정한다.
   * 완료도 실패도 취소도 아니고, 사용자가 되돌릴지 재실행할지 결정해야 하는 상태다.
   */
  | "INTERRUPTED"
  /**
   * 질문에 답했다 — **완료가 아니다** (51절).
   *
   * `COMPLETED`를 쓰지 않는 것이 이 상태의 존재 이유다. 상태 머신에는
   * *"`COMPLETED`에 도달하려면 반드시 `VERIFYING`을 지나야 한다"*는 불변식이 있고
   * (`canReachCompletedWithoutVerifying`), 그건 CLAUDE.md 원칙 1의 구조적 표현이다.
   * 답변에는 검증할 것이 없으므로 그 불변식을 **약화시키는 대신 다른 종착지를 만들었다.**
   *
   * 그 덕분에 배지 규칙(product-strategy 11절)도 따로 손볼 것이 없다: 답변은 애초에
   * "완료된 변경"으로 읽히지 않는다.
   */
  | "ANSWERED"
  /**
   * 계획을 냈다 — **완료도 답변도 아니다** (53절).
   *
   * `ANSWERED`와 나누는 이유는 **사용자의 다음 행동이 다르기 때문**이다. 답변을 읽은 사용자는
   * 대개 거기서 끝내지만, 계획을 읽은 사용자는 "그럼 해 줘"라고 말한다 — 그 후속은 새
   * 태스크이고, 화면이 둘을 같은 종착지로 그리면 그 다음 걸음이 어디 있는지 사라진다.
   *
   * `COMPLETED`가 아닌 이유는 `ANSWERED`와 같다: 검증을 지나지 않았고 바꾼 것이 없다.
   */
  | "OUTLINED";

export const TERMINAL_PHASES: readonly TaskPhase[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "INTERRUPTED",
  "ANSWERED",
  "OUTLINED",
];

export function isTerminalPhase(phase: TaskPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export interface TaskCounters {
  clarificationRounds: number;
  reviseRounds: number;
  fixLoopRounds: number;
  /** 초안의 요청으로 MCP 도구를 실행한 라운드 수 (state-machine 31절). */
  mcpRounds: number;
  /** 모델의 요청으로 파일을 더 읽고 다시 물은 라운드 수 (state-machine 57절). */
  contextRounds: number;
  /**
   * 계획을 다시 세운 횟수 (72.11절). **경로 셋이 같은 카운터를 쓴다.**
   *
   * 계획을 **고치지 않고** 다시 승인하는 고리는 이 값을 올리지 않는다 — `OUTLINING`을
   * 지나지 않기 때문이다. 그 고리가 B 호출만 늘리는 것은 "계획이 바뀌지 않았으면 B를 다시
   * 부르지 않는다"가 막는다(계획 지문으로 판정한다).
   */
  planRounds: number;
  /**
   * 런타임 에스컬레이션을 **실제로 부른** 횟수 (72.10.2절).
   *
   * **요청 수가 아니다.** 요청/호출/거절 셋은 서로 다른 수이고, 거절을 세지 않으면
   * "요청 수"가 곧 "부른 수"가 되어 **남발이 상한에 가려 보이지 않는다**(72.14절).
   * 요청과 거절은 이벤트로 남고 이 카운터는 **봉투와 비교되는 값**이라 호출만 센다.
   */
  escalationCalls: number;
  toolRetries: Record<string, number>;
  providerRetries: Record<string, number>;
}

export interface TaskState {
  taskId: string;
  phase: TaskPhase;
  complexityTier: ComplexityTier | null;
  /** docs/design/multi-engine-routing.md 7절 — 라우팅 결과를 태스크 상태에 보존 */
  routing: RoutingDecision | null;
  counters: TaskCounters;
}

export type FailureReason =
  | "clarification_exhausted"
  | "revise_exhausted"
  | "fix_loop_exhausted"
  | "tool_retry_exhausted"
  /**
   * 도구가 실패했고 **재시도할 값어치가 없었다** (state-machine 65절).
   *
   * `tool_retry_exhausted`와 뭉개지 않는다: 저쪽은 여러 번 해 봤는데 안 된 것이고 이쪽은
   * 한 번 만에 "다시 해도 같다"를 안 것이다. 사용자가 할 일도 다르다 — 저쪽은 대개
   * 기다리거나 다시 돌리면 되고, 이쪽은 **먼저 무언가를 고쳐야 한다.**
   */
  | "tool_failed_permanently"
  | "provider_retry_exhausted"
  | "provider_config_error"
  | "app_restart_interrupted"
  /** Policy Gate가 계획의 필수 도구를 거부해 계획 자체를 실행할 수 없는 경우 */
  | "policy_denied"
  /**
   * 게이트가 거부했지만 **고칠 것이 정책이 아니라 요청의 모양**인 경우 (state-machine 41.4절).
   *
   * `policy_denied`와 나누는 이유는 사용자가 갈 곳이 다르기 때문이다 — 저쪽은 정책을 보고,
   * 이쪽은 볼 것이 없다(모델이 셸 문법을 argv에 넣는 등, 우리가 받지 않는 모양으로 요청했다).
   */
  | "request_malformed"
  /** 내부 불변식 위반 (잘못된 상태 전이 등) — 조용히 넘기지 않고 실패로 드러낸다 */
  | "internal_invariant_violated"
  /**
   * 이 태스크의 예산 상한을 넘겨 **호출을 하지 않고** 멈췄다.
   *
   * `provider_config_error`와 섞지 않는 이유: 저쪽은 고칠 것이 설정에 있고, 이쪽은 사용자가
   * 정한 값에 도달한 정상 동작이다. 같은 이름으로 보고하면 사용자가 키나 모델을 의심한다.
   */
  | "budget_exceeded"
  /**
   * 무인 실행(Autopilot) 중 **승인이 필요한 지점에 닿아** 멈췄다 (8.2절, state-machine 24절).
   *
   * `policy_denied`와 섞지 않는다: 저쪽은 게이트가 **거부**한 것이고 요청 자체를 다시 생각해야
   * 한다. 이쪽은 게이트가 "사람에게 물어라"라고 했는데 물을 사람이 없었던 것이며, 사람이
   * 붙으면 그대로 진행된다. 뭉개면 사용자가 정책을 의심하며 고칠 곳을 찾아 헤맨다.
   */
  | "unattended_stop"
  /**
   * 무인 실행에서 **검증이 돌지 않았는데** 변경이 적용된 상태로 끝났다 (8.2절).
   *
   * `unattended_stop`과 나눈다: 저쪽은 승인 지점에서 멈춰 **아무것도 바꾸지 않은** 것이고,
   * 이쪽은 바꿨는데 검증이 침묵한 것이다. 되돌릴 것이 있는지가 다르므로 다음에 할 일이 다르다.
   */
  | "unverified_unattended";

/**
 * 이 태스크가 공급자 호출에 **실제로 쓴 돈**과 상한이 강제됐는지 여부.
 *
 * 상한이 없어도 지출은 보고한다 — "얼마를 썼는가"는 상한과 무관한 사실이고, 상한을 끄는
 * 선택을 한 사용자야말로 그 숫자를 봐야 한다.
 */
export interface TaskBudgetOutcome {
  /** 사용자가 승인한 상한. `null`이면 이 태스크는 **상한 없이** 돌았다. */
  limitUsd: number | null;
  /**
   * 확정 지출. 가격을 아는 호출만 더한 값이므로 `unpricedCalls > 0`이면 **하한이다.**
   * 모르는 것을 0으로 더하면 이 숫자가 "썼는데 안 썼다"고 말하게 된다.
   */
  spentUsd: number;
  /** 과금 여부가 불확실해 미해결로 남은 예약액. 사용 가능한 예산으로 돌아오지 않는다. */
  unresolvedUsd: number;
  /** 비용을 계산할 수 없었던 호출 수. 0이 아니면 `spentUsd`는 하한이다. */
  unpricedCalls: number;
  state: TaskBudgetState;
  /**
   * `state`가 뭉뚱그린 원장 상태의 원래 이름(`BUDGET_ESTIMATE_BREACH` 등).
   *
   * 화면은 네 가지만 구별하면 되지만 감사에서는 어느 이유로 막혔는지가 다른 사실이다.
   */
  detail?: string;
}

/**
 * 예산 상태의 **제품 수준 분류.** 원장의 다섯 상태를 화면이 구별해야 하는 넷으로 접는다.
 *
 * `not_enforced`를 `ok`와 같은 값으로 접지 않는 것이 요점이다 — "상한 안에서 끝났다"와
 * "상한이 없었다"는 정반대의 사실인데 둘 다 초록색으로 보이면 화면이 거짓 안심을 준다.
 */
export type TaskBudgetState =
  /** 상한이 없었거나(사용자 선택) 강제할 수 없었다. */
  | "not_enforced"
  | "ok"
  /** 남은 예산으로 다음 호출을 예약할 수 없어 멈췄다. */
  | "limit_reached"
  /** 원장을 신뢰할 수 없어 이후 호출을 막았다(추정 초과·비용 측정 불가 등). */
  | "blocked";

export interface FinalResult {
  taskId: string;
  /**
   * `answered`가 따로 있는 이유는 `TaskPhase.ANSWERED`와 같다 — **답변은 완료가 아니다**(51절).
   * 하나로 뭉치면 "검증을 통과한 변경"과 "아무것도 바꾸지 않은 답변"이 같은 값이 된다.
   */
  status: "completed" | "failed" | "cancelled" | "rejected" | "answered" | "planned";
  failureReason?: FailureReason;
  summary: string;
  /**
   * ~~`finalDiff`~~ — 제거했다(state-machine 3.2절).
   *
   * **소비자가 없었고, 있는 편이 오히려 나빴다.** 적용된 diff를 만든 것은 Rust의 Tool
   * Runtime이고 Rust가 이미 경로별로 들고 있다(`collected_diffs` — 화면이 실제로 그리는 것도
   * 그쪽이다). 여기 담긴 것은 그 사실을 **Node가 한 바퀴 돌려 만든 사본**이었다: 감사 기록에
   * 같은 사실의 사본이 둘 생기고 그중 하나가 신뢰 경계 밖에서 온다(원칙 2). 값도 크다 —
   * 모든 patch를 이어 붙인 문자열이 NDJSON 한 줄에 실린다.
   */
  verificationReport?: VerificationReport;
  /**
   * 질문에 대한 답 (51절). `status === "answered"`일 때만 있다.
   *
   * **`summary`와 따로 둔다.** 요약 자리에 넣으면 화면이 둘을 구별하지 못하고, 긴 답이
   * 목록의 한 줄 자리에 들어간다.
   */
  answer?: QuestionAnswer;
  /**
   * 계획 (53절). `status === "planned"`일 때만 있다.
   *
   * `answer`와 나란히 두되 다른 필드다 — 같은 자리에 넣으면 화면이 "읽고 끝"과
   * "그럼 해 줘"를 구별하지 못한다.
   */
  plan?: PlanOutline;
  auditTrailEventIds: string[];
  /** 이 태스크가 변경한 파일 목록 (롤백 UX가 쓴다 — state-machine-and-protocol.md 10절) */
  mutatedPaths?: string[];
  /**
   * 이 태스크에서 확정된 기준. 최종 보고가 이걸 체크리스트로 제시한다(17.3절).
   *
   * **충족 여부를 담는 필드가 없는 것은 누락이 아니라 설계다.** 기준↔테스트 자동 연결 방법이
   * 아직 없으므로 현재 확인된 기준은 0개이고, 그 사실은 "확인됨 필드가 비어 있음"이 아니라
   * "확인 여부를 말하는 필드 자체가 없음"으로 표현된다. 모델에게 판정을 맡기면
   * product-strategy.md 9절의 순환 의존이 그대로 재현된다.
   */
  acceptanceCriteria?: AcceptanceCriterion[];
  /**
   * 기준별 판정 결과 (17.3절 규칙 2·3).
   *
   * **`AcceptanceCriterion`에 상태 필드를 넣지 않고 별도 배열로 둔 이유**: 기준은 사용자가
   * 확정한 사실이고 판정은 매 검증마다 다시 계산되는 파생값이다. 한 타입에 섞으면 "사용자가
   * 정한 것"과 "우리가 계산한 것"의 경계가 흐려지고, 언젠가 모델이 그 필드를 채우게 된다.
   *
   * 비어 있거나 없으면 **아무것도 확인되지 않았다는 뜻**이다 — 충족했다는 뜻이 아니다.
   */
  criterionEvaluations?: CriterionEvaluation[];
  /**
   * 이 태스크의 예산 결말. **성공·실패를 가리지 않고 담는다** — 돈은 결과와 무관하게 나갔다.
   */
  budget?: TaskBudgetOutcome;
  /**
   * 사용자에게 묻지 못한 채 남은 blocking 불일치 — 있으면 보고에 반드시 표시한다.
   * "물어볼 수 없었다"와 "쟁점이 없었다"는 다른 사실이다(17.4절).
   */
  unresolvedDisagreements?: string[];
  completedAt: ISODateTime;
}
