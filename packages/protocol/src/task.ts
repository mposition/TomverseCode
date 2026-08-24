import type { ComplexityTier, ISODateTime } from "./common.js";
import type { AcceptanceCriterion, CriterionEvaluation } from "./decision.js";
import type { RoutingDecision } from "./registry.js";
import type { CommandPolicy } from "./tools.js";
import type { VerificationReport } from "./verification.js";

export interface TaskRequest {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  userMessage: string;
  attachments?: { path: string; note?: string }[];
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
}

export const DEFAULT_LOOP_LIMITS: TaskLoopLimits = {
  clarificationRounds: 2,
  reviseRounds: 2,
  fixLoopRounds: 3,
  toolRetries: 2,
  providerRetries: 3,
};

/**
 * 사용자가 UI에서 고르는 실행 정책 (ui-wireframes.md / 작업 지침 4.9절).
 * - fast: TRIAGE가 simple로 분류하면 단일 모델 경로를 그대로 쓴다.
 * - verified: TRIAGE 결과와 무관하게 항상 standard(교차검증) 경로 — forceComplexityTier와 같다.
 *
 * 둘 중 어느 쪽이든 VERIFYING은 생략되지 않는다(CLAUDE.md 원칙 1).
 *
 * **대조(executor ×2)는 이 축이 정한다.** `complexityTier`가 아니다 — `standard`는 사용자가
 * `verified`를 고른 경우와 `fast`인데 TRIAGE가 그렇게 분류한 경우 **둘 다**에서 나오고,
 * 후자에서 executor를 하나 더 부르면 `fast`를 고른 뜻이 사라진다
 * (state-machine-and-protocol.md 17.5절). tier는 교차검증을, 이 축은 대조를 켠다.
 */
export type ExecutionMode = "fast" | "verified";

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
   * # co-executor는 지정할 수 없다
   *
   * 대조용 두 번째 실행자의 **유일한 일이 primary와 다른 것**이다(13.1절). 그걸 사용자가
   * 고르게 하면 둘을 같게 만들 수 있고, 그 순간 "불일치 없음"은 정보가 아니라 착시가 된다.
   * 그래서 지정 가능한 것은 primary executor와 reviewer뿐이다.
   */
  modelPins?: { executor?: string; reviewer?: string };
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
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REJECTED"
  /**
   * 앱이 비정상 종료되어 중단됨. **Node 상태 머신은 이 상태로 전이하지 않는다** —
   * 호스트(Rust)가 앱 시작 시 터미널이 아닌 태스크를 발견해 확정한다.
   * 완료도 실패도 취소도 아니고, 사용자가 되돌릴지 재실행할지 결정해야 하는 상태다.
   */
  | "INTERRUPTED";

export const TERMINAL_PHASES: readonly TaskPhase[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "INTERRUPTED",
];

export function isTerminalPhase(phase: TaskPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export interface TaskCounters {
  clarificationRounds: number;
  reviseRounds: number;
  fixLoopRounds: number;
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
  | "provider_retry_exhausted"
  | "provider_config_error"
  | "app_restart_interrupted"
  /** Policy Gate가 계획의 필수 도구를 거부해 계획 자체를 실행할 수 없는 경우 */
  | "policy_denied"
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
  status: "completed" | "failed" | "cancelled" | "rejected";
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
