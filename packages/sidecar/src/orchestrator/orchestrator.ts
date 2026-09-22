import type {
  AcceptanceCriterion,
  ComplexityTier,
  CriteriaConflictOutcome,
  CriterionEvaluation,
  Disagreement,
  DraftNarrative,
  EngineRole,
  EscalationAllowance,
  ModelGrade,
  PlanApprovalCard,
  PlanApprovalChoice,
  PlanSubtask,
  UserGateResponse,
  VerificationChecklistCard,
  VerificationChoice,
  DraftProposal,
  ExperimentControls,
  ExecutionPlan,
  FailureReason,
  FileMove,
  FinalResult,
  McpCallRequest,
  PlanOutline,
  QuestionAnswer,
  RelevantFile,
  ReviewDecision,
  RoutingDecision,
  SingleModelFixResult,
  TaskCounters,
  UserDecisionInput,
  TaskPhase,
  TaskPolicy,
  TaskRequest,
  TaskState,
  ToolRequest,
  ToolRequester,
  VerificationReport,
  WorkspaceSnapshot,
  TaskEventType,
} from "@tomverse/protocol";
import { ValidationError } from "@tomverse/protocol";
import { ContextEngine } from "../context/engine.js";
import type { NdjsonTransport } from "../ipc/transport.js";
import { createRoleAdapters, MissingCredentialError, type AdapterFactoryOptions, type RoleAdapters } from "../providers/factory.js";
import { normalizeProviderError } from "../providers/errors.js";
import {
  asTimeoutError,
  attemptFacts,
  callWithRetry,
  DEFAULT_RETRY_POLICY,
  ProviderCallFailed,
  withTimeout,
  type RetryPolicy,
} from "../providers/retry.js";
import type { ProviderAdapter, ProviderCallContext, ProviderResponse } from "../providers/types.js";
import { ModelRegistry, providerKindOf } from "../routing/registry.js";
import { Router, RoutingError, type RouterOptions } from "../routing/router.js";
import { ToolBridge } from "../tools/bridge.js";
import { buildDigest } from "../verify/digest.js";
import { snapshotPayload } from "./snapshotPayload.js";
import { digestSectionSizes } from "../providers/prompts.js";
import { canonicalText, contrastDrafts, contrastPlans, fieldLabel, planQuestionRound } from "./contrast.js";
import { decideGrades, type GradeDecision } from "./grade.js";
import {
  buildPlanApprovalCard,
  buildVerificationChecklist,
  judgeEscalation,
  proposeEscalationAllowance,
  unplannedPaths,
} from "./standard.js";
import {
  describeEvaluations,
  evaluateCriteria,
  findCriteriaConflicts,
  type CriteriaConflict,
  type CriteriaContext,
} from "./criteria.js";
import { InvalidTransitionError, isValidTransition } from "./machine.js";
import { buildCommitMessage, buildCommitPlan, buildExecutionPlan, planPaths, PlanningError } from "./planner.js";
import { refusalNote, resolveRequests } from "../context/followUp.js";
import { DEFAULT_TRIAGE_POLICY, triage, type TriagePolicy, type TriageResult } from "../triage.js";
import { BudgetRefused, TaskBudget } from "./budget.js";
import type { Reservation } from "../budget/ledger.js";
import type { BudgetEventType } from "../budget/ledger.js";

/**
 * 예산 원장의 사실 → `task_events`의 이름.
 *
 * **조립하지 않고 적어 둔다.** 종전에는 `BUDGET_${event.type.toUpperCase()}`였는데, 그러면
 * 이름이 소스에 존재하지 않아 grep으로 찾을 수 없고 `TaskEventType`이 막지도 못한다.
 * 더 나쁜 것은 `BudgetEventType`을 이름만 바꿔도 **이미 저장된 로그가 조회되지 않는 상태**가
 * 조용히 만들어진다는 점이다 — 이름은 append-only 로그에 영구히 남는 값이다(원칙 7).
 *
 * 이 표는 양쪽으로 컴파일러가 지킨다: `Record`가 원장 타입 전부를 요구하고, 값은
 * `TaskEventType`이어야 한다.
 */
/**
 * 결말 하나가 정하는 것 둘: 어떤 phase로 가고 어떤 이벤트를 남기는가 — state-machine 53절.
 *
 * # 왜 표인가
 *
 * 종전에는 삼항 사슬이 **둘** 있었다(phase용, 이벤트용). 51절이 `answered`를 더할 때 두 곳을
 * 함께 고쳤는데, 그건 사람이 기억해서 한 일이다 — 한쪽만 고치면 답변이 `ANSWERED`로 가면서
 * `TASK_REJECTED`를 남기고, 그 어긋남은 감사 기록을 나중에 읽는 사람에게만 보인다.
 *
 * `Record<FinalResult["status"], …>`라 새 결말을 더하면 **컴파일이 막는다.** 사람이 기억할
 * 일을 타입이 대신한다.
 *
 * # 왜 `TASK_COMPLETED`를 나눠 쓰는가
 *
 * 답변도 계획도 감사 기록에서 완료와 구별돼야 한다(51·53절). 같은 이벤트로 남으면
 * "검증을 통과한 변경"과 "아무것도 바꾸지 않은 것"을 사후에 구별할 수 없다.
 */
const TERMINAL_OF: Record<FinalResult["status"], { phase: TaskPhase; event: TaskEventType }> = {
  completed: { phase: "COMPLETED", event: "TASK_COMPLETED" },
  failed: { phase: "FAILED", event: "TASK_FAILED" },
  cancelled: { phase: "CANCELLED", event: "TASK_CANCELLED" },
  rejected: { phase: "REJECTED", event: "TASK_REJECTED" },
  answered: { phase: "ANSWERED", event: "QUESTION_ANSWERED" },
  planned: { phase: "OUTLINED", event: "PLAN_OUTLINED" },
};

const BUDGET_EVENT_NAMES: Record<BudgetEventType, TaskEventType> = {
  approval_created: "BUDGET_APPROVAL_CREATED",
  approval_raised: "BUDGET_APPROVAL_RAISED",
  reservation_opened: "BUDGET_RESERVATION_OPENED",
  reservation_released: "BUDGET_RESERVATION_RELEASED",
  reservation_settled: "BUDGET_RESERVATION_SETTLED",
  reservation_partially_settled: "BUDGET_RESERVATION_PARTIALLY_SETTLED",
  reservation_unresolved: "BUDGET_RESERVATION_UNRESOLVED",
  provider_usage_recorded: "BUDGET_PROVIDER_USAGE_RECORDED",
  budget_estimate_breached: "BUDGET_ESTIMATE_BREACHED",
  run_blocked: "BUDGET_RUN_BLOCKED",
  budget_ledger_invalid: "BUDGET_LEDGER_INVALID",
};

/**
 * Orchestrator — 태스크 하나의 상태 머신을 소유한다.
 *
 * docs/design/process-architecture.md 2절: 상태 머신은 Node의 것이지만 **실행 능력은 없다.**
 * 파일 변경, 명령 실행, 검증, DB 기록은 모두 `ToolBridge`/transport를 통해 Rust에 요청한다.
 *
 * 이 클래스가 지키는 불변식:
 *  - 모든 phase 변경이 `PHASE_CHANGED` 이벤트를 남긴다 (CLAUDE.md 원칙 7)
 *  - 전이 표에 없는 전이는 예외를 던진다 (조용히 진행하지 않는다)
 *  - VERIFYING은 tier와 무관하게 항상 실행된다 (원칙 1)
 *  - 모든 루프에 상한이 있고 상한은 `TaskPolicy`에서 읽는다 (원칙 5)
 */

export interface OrchestratorDeps {
  transport: NdjsonTransport;
  registry?: ModelRegistry;
  routerOptions?: RouterOptions;
  adapterOptions?: AdapterFactoryOptions;
  triagePolicy?: TriagePolicy;
  retryPolicy?: RetryPolicy;
  contextEngine?: ContextEngine;
  /**
   * 공급자 호출 1회 타임아웃. 생략하면 `DEFAULT_PROVIDER_TIMEOUT_MS`.
   *
   * **출력 예산에서 유도하지 않는다.** 유도하면 두 값이 한 손잡이가 되어, 완결성을 위해
   * 기다리는 시간을 늘리려면 요청하는 출력도 함께 늘려야 한다. 둘은 다른 결정이다 —
   * 출력 예산은 "얼마까지 받아줄 것인가"이고 타임아웃은 "얼마나 기다릴 것인가"다.
   */
  providerTimeoutMs?: number;
}

/**
 * 공급자 호출 1회 타임아웃의 기본값.
 *
 * # 이 값은 출력 예산과 독립이지만, 둘의 관계를 알고 정해야 한다
 *
 * 어댑터는 출력을 최대 `effectiveMaxOutputTokens`(현재 16,000)까지 요청한다. 그건 **상한이지
 * 목표가 아니다** — 대부분의 응답은 그 근처에도 가지 않는다. 하지만 상한을 다 쓰는 응답이
 * 나올 수 있고, 그때 이 타임아웃이 그보다 짧으면 그 호출은 **반드시** 죽는다.
 *
 * 실측(가설 게이트 P1, 2026-08-27): `claude-sonnet-5`의 출력 처리량은 57~97 tok/s였다.
 * 최저값 기준으로 16,000토큰은 약 280초다. 종전 기본값 120초는 그 절반도 안 됐고, 실제로
 * 검수 호출 하나가 정확히 120초에 취소됐다. 요청은 공급자에 도달해 **과금됐고**(청구 내역으로
 * 확인), 우리는 응답을 받지 못했다 — 돈만 쓰고 결과가 없는 가장 나쁜 실패다.
 *
 * 그래서 기본값을 상한 응답이 완결될 수 있는 크기로 둔다. 대가는 **멈춘 호출이 실패로
 * 확정되기까지 더 오래 걸린다**는 것이다. 그 대가를 감수하는 이유: 조용히 잘린 응답보다
 * 느린 실패가 낫고, 취소된 호출도 과금은 그대로이기 때문이다.
 *
 * 제품이 응답 시간 SLA를 걸어야 하는 자리에서는 이 값을 **명시적으로 짧게 주입한다.**
 * 기본값을 짧게 두고 그것을 SLA라고 부르지 않는다 — 그러면 SLA가 아니라 사고다.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

/**
 * 한 라운드에 실행하는 MCP 도구 호출의 최대 개수 (state-machine 32절).
 *
 * **유도한 값이 아니라 관례적 선택이다.** 없으면 초안 하나가 임의 개수를 요청할 수 있고,
 * 승인 모달이 그만큼 뜨며 프롬프트가 그만큼 자란다(원칙 5).
 */
export const MAX_MCP_CALLS_PER_ROUND = 5;

/**
 * MCP 응답 하나가 프롬프트에 실릴 수 있는 최대 바이트 (state-machine 32절).
 *
 * 파일에는 컨텍스트 예산이 있는데(context-engine 5절) 여기에는 없었다 — 서버가 큰 응답을
 * 주면 프롬프트가 서버 마음대로 커진다. **우리가 통제하지 못하는 입력에 상한을 두지 않는
 * 것은 상한이 없는 것과 같다.**
 */
export const MAX_MCP_RESULT_BYTES = 8_000;

/**
 * 응답을 상한 안으로 자른다. **자른 사실을 텍스트에 적는다** — 조용히 자르면 모델은 잘린
 * JSON을 완전한 것으로 읽고, 없는 필드를 없다고 단정한다.
 *
 * 스키마와 달리 통째로 빼지 않는 이유: 스키마는 계약이라 일부만 있으면 틀린 계약이 되지만,
 * 응답은 정보라서 앞부분만 있어도 쓸모가 있다.
 */
export function boundMcpBody(body: string): string {
  if (body.length <= MAX_MCP_RESULT_BYTES) return body;
  return (
    body.slice(0, MAX_MCP_RESULT_BYTES) +
    `\n(TRUNCATED: ${MAX_MCP_RESULT_BYTES} of ${body.length} bytes shown. The rest exists — do not assume it is absent.)`
  );
}

export interface RunInput {
  taskRequest: TaskRequest;
  policy: TaskPolicy;
  availableProviders: string[];
  /**
   * 적용된 스킬의 프롬프트 프리셋 (state-machine 26절). **Rust가 파일을 읽어 채운다.**
   *
   * 도구 허용목록은 여기 없다 — `policy.allowedTools`로 오고 강제하는 곳은 Rust다.
   * 모델 지정도 여기 없다 — Rust가 `policy.modelPins`에 접어 넣었다.
   */
  skill?: { name: string; instructions: string };
  /**
   * 같은 세션의 앞선 태스크에서 사용자가 정한 것 (state-machine 27절).
   * **Rust가 저장소에서 유도해 채운다** — 무엇을 나를 수 있는지는 권위에 관한 판정이다.
   */
  sessionMemory?: { text: string; decisionCount: number; truncated: boolean };
  /**
   * 등록된 MCP 서버가 내놓은 도구 목록 (state-machine 31절).
   * **Rust가 서버를 띄워 물어 채운다** — 프로세스를 띄우는 것은 Node에게 금지된 일이다.
   */
  mcpTools?: { text: string; serverCount: number; toolCount: number; truncated: boolean };
  /**
   * 실험 하네스(evals/hypothesis-gate) 전용 제어. **production 경로에서는 항상 undefined다.**
   * Rust가 `task.start` params로 채우며, Node는 이 값을 만들어내지 않는다.
   */
  experiment?: ExperimentControls;
}

interface PendingQuestion {
  questions: string[];
  /** 3.9절 카드로 물은 경우의 쟁점들. 3.4절 확인 필요 카드에서는 빈 배열이다. */
  disagreements: Disagreement[];
  resolve: (answer: UserAnswer) => void;
}

/** 사용자 답변. `decisions`는 3.9절 카드에서만 온다. */
interface UserAnswer {
  message: string;
  decisions?: UserDecisionInput[];
}

/** 초안 1개 생성 결과. `absent`는 "이 자리에 실행자가 배정되지 않았다"이다. */
type DraftOutcome =
  | { kind: "draft"; value: DraftProposal }
  | { kind: "absent" }
  | { kind: "final"; result: FinalResult };

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly registry: ModelRegistry;
  private readonly contextEngine: ContextEngine;
  private readonly abort = new AbortController();

  private state: TaskState;
  private policy: TaskPolicy;
  private snapshot: WorkspaceSnapshot | null = null;
  private routing: RoutingDecision | null = null;
  private adapters: RoleAdapters | null = null;
  private bridge: ToolBridge | null = null;
  private baselineReport: VerificationReport | null = null;
  private lastReport: VerificationReport | null = null;
  /** 질문 경로의 답 — `finish`가 결과에 실어 보낸다 (51절). */
  private pendingAnswer: QuestionAnswer | null = null;
  private pendingPlan: PlanOutline | null = null;
  /**
   * 적용된 변경에 대해 **우리가 실제로 아는 것** — 경로와 크기. diff가 아니다.
   *
   * FIX_LOOP가 이걸 프롬프트에 싣는데, 변경 **내용**은 여기가 아니라 다시 읽은 스냅샷이
   * 나른다(context-engine 6.1절). 그래서 이 목록은 "무엇이 바뀌었나"의 목차 역할만 한다.
   */
  private appliedChangeNotes: string[] = [];
  /**
   * fix loop를 돌게 만든 체크 종류들. **커밋 메시지가 "몇 번 만에 통과했는지"를 말하기 위한
   * 재료**다(19.6절). 중간 시도는 검증에 실패한 상태라 커밋으로 남지 않으므로, 이 흔적이
   * 없으면 세 번 고쳐 통과한 변경과 처음부터 맞았던 변경이 이력에서 같아 보인다.
   *
   * `lastReport`로 대신할 수 없다: 그건 **통과한** 마지막 리포트라 실패 이력이 이미 지워졌다.
   */
  private readonly failedChecksAlongTheWay: string[] = [];
  /**
   * 이 태스크가 실제로 바꾼 워크스페이스 경로. **계획이 아니라 성공한 실행에서만** 쌓인다 —
   * 승인 거부나 실패로 적용되지 않은 파일을 "바꿨다"고 세면 기준 판정의 근거가 허구가 된다.
   * (Rust의 `file_mutations`가 정본이고, 이건 판정에 쓰는 Node 쪽 사본이다.)
   */
  private readonly mutatedPaths: string[] = [];
  /**
   * 마지막으로 확정된 도구 결과가 스냅샷보다 새로운가.
   *
   * 도구가 파일을 바꾸면 스냅샷의 내용은 그 순간 낡는다. 즉시 다시 읽지 않고 표시만 해두는
   * 이유는 **검증을 통과하면 다시 보낼 일이 없기 때문**이다 — 통과 경로에서 파일 12개를
   * 다시 읽는 것은 아무도 보지 않는 일을 하는 것이다.
   */
  private snapshotStale = false;
  /**
   * MCP 라운드 상한을 알렸는가 (31절). **이 플래그가 루프의 종료 논증이다** — 상한을 알린
   * 뒤에도 도구를 요청하면 그 요청을 무시하고 진행한다.
   */
  private mcpBudgetNoticeSent = false;
  /**
   * 진행 중인 다시 읽기.
   *
   * **두 실행자는 `Promise.all`로 동시에 부른다**(13.1절). 각자 새로 만들게 두면 두 모델이
   * **서로 다른 스냅샷**을 받고, 그러면 대조에서 나온 불일치가 모델 차이인지 입력 차이인지
   * 구별되지 않는다(context-engine.md 1절). 검사와 대입 사이에 `await`를 두지 않는 것도
   * 같은 이유다(CLAUDE.md 함정 기록 — `await`가 곧 양보 지점이다).
   */
  private refreshingSnapshot: Promise<WorkspaceSnapshot> | null = null;
  private answers: { question: string; answer: string }[] = [];
  /**
   * 확정된 기준 목록 — 사용자 판정이 프롬프트 문자열로 끝나지 않게 하는 자리(17.3절).
   *
   * `answers`와 별도로 두는 이유: `answers`는 **다음 프롬프트에 넣을 재료**이고 이 목록은
   * **최종 보고가 참조하는 기록**이다. 하나로 합치면 프롬프트 조립 방식이 바뀔 때마다
   * 감사 기록의 모양이 따라 바뀐다.
   */
  private acceptanceCriteria: AcceptanceCriterion[] = [];
  /**
   * 사용자에게 묻지 못한 채 남은 blocking 쟁점 (17.4절).
   *
   * 조용히 버리면 "물어볼 수 없었다"와 "쟁점이 없었다"가 최종 보고에서 구별되지 않는다.
   */
  private unresolvedDisagreements: string[] = [];
  /**
   * 기준별 판정 (17.3절 규칙 2). VERIFYING마다 **다시 계산**된다 — 기준은 사용자가 확정한
   * 사실이고 판정은 매 검증의 파생값이라, 누적하면 낡은 판정이 화면에 남는다.
   */
  private criterionEvaluations: CriterionEvaluation[] = [];
  /** 직전 계획이 기준과 충돌해 다시 요청할 때 모델에게 전달할 사유. 재요청 후 비운다. */
  private criteriaFeedback: string[] = [];
  /**
   * 게이트가 계획을 거부해 다시 요청한 사유 (state-machine 42절).
   *
   * **`criteriaFeedback`과 섞지 않는다.** 기준 충돌은 "사용자가 정한 것과 어긋난다"이고
   * 이건 "우리가 받지 않는 모양이다"이다 — 모델이 고쳐야 할 것이 다르므로 프롬프트에서도
   * 다른 문단으로 간다.
   */
  private gateFeedback: string[] = [];
  /**
   * 재요청을 유발한 충돌. **결말은 다음 라운드에야 정해지므로** 감지 이벤트와 따로 기억한다 —
   * 한 이벤트에 담으려면 미래를 알아야 한다.
   */
  /**
   * 직전 라운드가 재요청을 유발한 충돌 — 다음 라운드에서 **결말을 판정하기 위해** 기억한다.
   *
   * 충돌 목록과 그때의 해석을 **한 필드에 묶어 둔다.** 둘을 따로 두면 한쪽만 세우거나 한쪽만
   * 비우는 경로가 생기고, 그러면 이번 라운드의 결말에 지난 라운드의 해석이 붙는다.
   */
  private pendingConflicts: { conflicts: CriteriaConflict[]; interpretation: string | null } | null = null;

  /**
   * 가장 최근 primary 초안의 해석. `interpretationTextChanged` 계측의 재료다(17.10절 ⑧).
   *
   * 초안 전체를 들고 있지 않는 이유: 필요한 것은 이 한 필드이고, 초안을 통째로 붙들면
   * 나중에 다른 판정에 쓰고 싶은 유혹이 생긴다. 모델 산출물은 판정 근거가 아니다.
   */
  private lastInterpretation: string | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private eventIds: string[] = [];
  /**
   * 터미널에 도달했는지. **완료와 취소가 경쟁할 때 먼저 확정된 쪽만 남긴다**는 규칙의 Node 쪽 절반이다.
   * (다른 절반은 Rust의 `finish_task`가 `WHERE final_status IS NULL`로 원자적으로 처리한다.)
   */
  private terminalReached = false;
  /** 취소가 요청됐는지. abort signal만 보면 타임아웃 abort와 구별되지 않는다. */
  private cancelRequested = false;
  /**
   * 이 태스크의 예산 강제기 (multi-engine-routing.md 10.6절).
   *
   * `drive()` 초입에서 만든다 — 상한이 잘못된 값이면 첫 유료 호출 전에 멈춰야 하고,
   * 그러려면 태스크가 한참 돈 뒤가 아니라 시작 지점에서 검증해야 한다.
   */
  private budget: TaskBudget | null = null;

  // ---- `standard` 흐름의 상태 (state-machine 72절) ----

  /**
   * 사용자가 승인한 계획. **기준의 출처가 되는 권위**다(`plan_outline`).
   *
   * `pendingPlan`(계획 모드의 산출물)과 나눈다 — 저쪽은 읽고 끝나는 경로의 결과라 실행에
   * 쓰이지 않는다. 한 필드로 합치면 "승인을 지났는가"가 값에서 사라진다.
   */
  private approvedPlan: PlanOutline | null = null;
  /** 서브태스크별 **최종** 등급. 규칙이 계산한 값이고 라우팅과 비용이 이것을 쓴다(72.10절). */
  private approvedGrades: GradeDecision[] = [];
  /** 사용자가 함께 승인한 에스컬레이션 봉투 (72.10.2절). 승인 전에는 `null`이다. */
  private escalationAllowance: EscalationAllowance | null = null;
  /** 사용자가 계획 검토(B)를 생략했는가 — **체크리스트에 적힌다**(72.4절). */
  private planReviewSkipped = false;
  /** B가 올린 쟁점. 계획이 바뀌지 않았으면 B를 다시 부르지 않고 이것을 그대로 보여준다(72.11절). */
  private planReviewIssues: string[] = [];
  /**
   * B가 마지막으로 검토한 계획의 지문.
   *
   * **계획이 바뀌지 않았으면 B를 다시 부르지 않는다**(72.11절). 같은 입력에 같은 검토를 다시
   * 시키는 것이므로 새로 얻는 정보가 없고, 부르면 `B 호출만 상한 없이 늘어난다` — 매 회
   * 사용자 클릭이 필요하므로 무인 루프는 아니지만 상한이 없는 것은 같다.
   */
  private reviewedPlanFingerprint: string | null = null;
  /** 이 지문의 쟁점을 사용자에게 이미 보여줬는가. 보여준 뒤 다시 승인하면 그대로 진행한다. */
  private issuesShownFor: string | null = null;
  /** C가 지목한 기준 id들. **경고이지 확인이 아니다**(72.8절). */
  private flaggedCriterionIds: string[] = [];
  /** C가 실제로 돌았는가. 돌지 않았으면 체크리스트가 그 사실을 적는다. */
  private resultReviewRan = false;
  /**
   * **코드를 쓴 공급자들** — 21.6절 불변식 C가 보는 집합.
   *
   * 라우터의 C 배정은 executor 하나만 보고 한 **잠정** 판정이다. 등급별 배정과 에스컬레이션이
   * 실제 구현자를 늘릴 수 있으므로, C를 부르기 전에 이 집합으로 다시 판정한다 — 그래서
   * 기록에 `assigned*`와 `actual*`이 둘 다 남는다(13.5절과 같은 모양).
   */
  private readonly implementerProviders = new Set<string>();
  /** 등급별 구현 어댑터 캐시. 같은 등급의 서브태스크가 매번 새 어댑터를 만들지 않게 한다. */
  private readonly gradeAdapters = new Map<ModelGrade, ProviderAdapter>();
  /**
   * 계획 승인 시점에 연 **구현·검토 단계 예약** — 72.12절.
   *
   * 승인으로 되돌아가면 닫고 다시 연다. 첫 구현 호출 직전에도 닫는다 — 열어 둔 채로 호출
   * 예약이 겹치면 같은 돈이 두 번 잡힌다(`TaskBudget.reserveStage`의 머리말).
   */
  private implementationReservation: Reservation | null = null;

  constructor(private readonly input: RunInput, deps: OrchestratorDeps) {
    this.deps = deps;
    this.registry = deps.registry ?? new ModelRegistry();
    this.contextEngine = deps.contextEngine ?? new ContextEngine();
    this.policy = input.policy;
    this.state = {
      taskId: input.taskRequest.taskId,
      phase: "CREATED",
      complexityTier: null,
      routing: null,
      counters: {
        clarificationRounds: 0,
        mcpRounds: 0,
        contextRounds: 0,
        reviseRounds: 0,
        fixLoopRounds: 0,
        planRounds: 0,
        escalationCalls: 0,
        toolRetries: {},
        providerRetries: {},
      },
    };
  }

  get taskId(): string {
    return this.state.taskId;
  }

  get phase(): TaskPhase {
    return this.state.phase;
  }

  get counters(): TaskCounters {
    return this.state.counters;
  }

  /**
   * 사용자 취소. **실제로 진행 중인 작업을 끊는다** — 플래그만 세우지 않는다.
   *
   * 세 가지를 동시에 해야 한다:
   *  1. AbortController.abort() — 진행 중인 공급자 HTTP 호출을 끊는다
   *  2. 어댑터의 cancel() — SDK 내부에 남은 요청 정리
   *  3. pendingQuestion 해제 — AWAITING_USER_INPUT에서 영원히 멈춰 있지 않게
   *
   * 이미 터미널이면 아무것도 하지 않는다(idempotent, 상태 불변).
   */
  cancel(): boolean {
    if (this.terminalReached) return false;
    if (this.cancelRequested) return true; // idempotent — 재요청도 성공이다
    this.cancelRequested = true;

    this.abort.abort(new Error("사용자가 태스크를 취소했습니다"));
    this.adapters?.executor.cancel();
    this.adapters?.coExecutor?.cancel();
    this.adapters?.reviewer?.cancel();
    // **72절의 역할 넷도 취소한다.** 빠뜨리면 계획이나 검토 호출이 취소 뒤에도 끝까지
    // 돌고, 그 호출은 **취소된 태스크의 돈**이다.
    this.adapters?.planner?.cancel();
    this.adapters?.coPlanner?.cancel();
    this.adapters?.planReviewer?.cancel();
    this.adapters?.resultReviewer?.cancel();
    this.pendingQuestion?.resolve({ message: "" });
    return true;
  }

  get cancellationRequested(): boolean {
    return this.cancelRequested;
  }

  /** 진행 중인 공급자 호출에 전달되는 신호. 테스트가 "실제로 전달됐는가"를 확인한다. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /**
   * AWAITING_USER_INPUT에 대한 사용자 답변 전달.
   *
   * `decisions`는 3.9절 불일치 카드에서만 온다 — 어떤 쟁점에 대한 답인지를 문장 파싱이 아니라
   * id로 남기기 위한 것이다(17.2절 `UserDecisionInput`).
   */
  provideUserInput(message: string, decisions?: UserDecisionInput[]): boolean {
    if (!this.pendingQuestion) return false;
    const pending = this.pendingQuestion;
    this.pendingQuestion = null;
    pending.resolve({ message, decisions });
    return true;
  }

  // ---- 메인 루프 ----

  async run(): Promise<FinalResult> {
    try {
      return await this.drive();
    } catch (error) {
      // 여기까지 올라온 예외는 처리하지 못한 것이다. 조용히 삼키지 않고 실패로 확정한다.
      // **AbortError는 일반 ERROR가 아니라 CANCELLED로 분류한다** — 사용자가 멈춘 것을
      // 실패로 보고하면 "되돌리기 권장" 같은 잘못된 안내가 따라온다.
      if (this.cancelRequested || this.abort.signal.aborted || isAbortError(error)) {
        return await this.finish("cancelled", "사용자가 취소함");
      }
      const reason: FailureReason =
        error instanceof InvalidTransitionError ? "internal_invariant_violated" : "internal_invariant_violated";
      await this.emitError(error);
      return await this.finish("failed", errorMessage(error), reason);
    }
  }

  private async drive(): Promise<FinalResult> {
    this.bridge = new ToolBridge(this.deps.transport, this.taskId);

    // ---- 예산 상한 ----
    //
    // **첫 유료 호출 전에 검증한다.** 상한이 NaN이거나 0 이하인 채로 시작하면 스냅샷·라우팅을
    // 다 돈 뒤 첫 호출에서 죽고, 사용자는 무엇이 잘못됐는지 알 수 없다.
    //
    // 원장 이벤트는 `task_events`로 나간다 — 별도 테이블을 만들지 않는 이유는 10.6절에 있다.
    const budget = TaskBudget.create(this.policy.budgetUsd, {
      taskId: this.taskId,
      onEvent: (event) => {
        void this.emit(BUDGET_EVENT_NAMES[event.type], event);
      },
    });
    if (!budget.ok) {
      return this.finish("failed", `예산 상한이 올바르지 않습니다: ${budget.reason}`, "budget_exceeded");
    }
    this.budget = budget.budget;
    await this.emit("BUDGET_POLICY", {
      limitUsd: this.policy.budgetUsd,
      enforced: this.budget.enforced,
      // 상한이 없다는 사실을 **시작 시점에** 남긴다. 결과에만 담으면 진행 중에는 화면이
      // "상한 안에서 돌고 있다"와 구별할 수 없다.
      note: this.budget.enforced
        ? "이 태스크의 공급자 호출은 상한 안에서만 실행된다"
        : "상한 없이 실행된다 — 지출은 집계하지만 강제하지 않는다",
    });

    // ---- SNAPSHOTTING ----
    await this.transition("SNAPSHOTTING");
    if (await this.cancelledHere()) return this.finish("cancelled", "SNAPSHOTTING 중 취소됨");

    // 태스크 시작 시점의 워크스페이스 지문 (product-strategy 6절).
    //
    // **Rust가 계산하고 Rust가 기록한다.** 여기서 하는 일은 "지금 찍어라"뿐이고 값은 받아서
    // 쓰지 않는다 — Node가 값을 만질 수 있으면 감사 기록이 Node의 정직함에 의존하게 된다.
    // 스냅샷을 만들기 **직전**에 찍는 이유: 스냅샷이 읽는 파일 상태와 최대한 가까워야 한다.
    //
    // 실패해도 태스크를 세우지 않는다. 지문은 감사 재료이지 실행 조건이 아니다 —
    // 그리고 못 찍었다는 사실은 이벤트가 없다는 것으로 드러난다.
    await this.deps.transport
      .request("workspace.fingerprint", { taskId: this.taskId })
      .catch(() => undefined);

    this.snapshot = await this.contextEngine.createSnapshot(this.bridge, {
      workspaceId: this.input.taskRequest.workspaceId,
      userMessage: this.input.taskRequest.userMessage,
      // 라우팅 전이므로 모델별 예산을 아직 모른다. 대표값으로 스냅샷을 만들고,
      // 실제 모델 예산은 라우팅 후 어댑터가 프롬프트를 조립할 때 반영된다.
      tokenBudgets: [{ modelId: "(pending-routing)", maxTokens: 60_000 }],
    });
    // **스냅샷에 얹는다** — 프롬프트에 실리는 것은 스냅샷을 통해 나간다는 규칙(26.2절).
    // 여기서 얹지 않고 빌더마다 따로 실으면 전송 집계가 "각 공급자 모두에게 갔다"고 말할
    // 근거를 잃는다(7.1절).
    if (this.input.skill) {
      this.snapshot.skill = { name: this.input.skill.name, instructions: this.input.skill.instructions };
    }
    if (this.input.sessionMemory) {
      this.snapshot.sessionMemory = this.input.sessionMemory;
    }
    // 등록된 MCP 서버의 도구 목록 (31절). **Rust가 서버를 띄워 물어본 값이고 우리는 옮길
    // 뿐이다** — 여기서 목록을 만들거나 고치면 프롬프트가 실제 서버와 어긋난다.
    if (this.input.mcpTools) {
      this.snapshot.mcpTools = this.input.mcpTools;
    }
    await this.emit("SNAPSHOT_CREATED", snapshotPayload(this.snapshot));

    // ---- 질문이면 여기서 갈라진다 (state-machine 51절) ----
    //
    // **baseline 검증보다 앞이다.** 질문은 파일을 바꾸지 않으므로 "원래 깨져 있던 것"과
    // "이번 변경이 깨뜨린 것"을 구별할 필요가 없고, 그 구별을 위해 사용자의 테스트를 돌리는
    // 것은 답 하나를 얻자고 몇 분을 쓰는 일이다.
    //
    // TRIAGE보다도 앞이다. TRIAGE가 정하는 것은 "교차검증을 할 것인가"인데, 질문에는 검증할
    // 산출물이 없으므로 그 판정에 답이 없다.
    if (this.input.taskRequest.kind === "question") {
      return this.answerQuestion();
    }
    // 계획 모드도 같은 자리에서 갈린다(53절). 이유도 같다 — patch를 만들지 않으므로 baseline도
    // TRIAGE도 답할 것이 없다.
    if (this.input.taskRequest.kind === "plan") {
      return this.outlinePlan();
    }

    // ---- baseline 검증 ----
    // 작업 전 상태를 먼저 측정한다. 이걸 하지 않으면 "원래 깨져 있던 것"과
    // "이번 변경이 깨뜨린 것"을 구별할 수 없다 (작업 지침 3.4절).
    this.baselineReport = await this.runVerification("baseline", 0);
    await this.emit("PHASE_CHANGED_NOTE", {
      note: "baseline 검증 완료",
      overall: this.baselineReport.overall,
    });

    // ---- TRIAGE ----
    await this.transition("TRIAGE");
    if (await this.cancelledHere()) return this.finish("cancelled", "TRIAGE 중 취소됨");

    const tier = this.decideTier();
    this.state.complexityTier = tier.tier;
    // `tier`는 빼고 싣는다. 같은 사실을 `complexityTier`와 두 이름으로 두면 나중에 둘이
    // 어긋났을 때 어느 쪽이 정본인지 알 수 없다.
    const { tier: _sameAsComplexityTier, ...evidence } = tier.evidence ?? ({} as Partial<TriageResult>);
    await this.emit("TRIAGE_COMPLETED", {
      complexityTier: tier.tier,
      appliedPolicies: tier.appliedPolicies,
      // **규칙이 판정을 바꿨는지까지 남긴다.** 이게 없으면 "테스트 파일 제외 규칙이 얼마나
      // 오분류를 내는가"(context-engine.md 11.1절)를 사후에 물어볼 수 없다 —
      // 규칙이 작동하기라도 한 태스크가 어느 것인지 구별되지 않기 때문이다.
      ...evidence,
    });

    // ---- 라우팅 ----
    try {
      // **태스크 정책의 지정이 환경변수 선호보다 우선한다.** 선호는 기본값이고 지정은
      // 이번 태스크에 대한 사용자의 선택이다 — 기본값이 선택을 덮으면 선택이 아니다.
      const routerOptions: RouterOptions = {
        ...this.deps.routerOptions,
        ...(this.policy.modelPins ? { pinned: this.policy.modelPins } : {}),
      };
      this.routing = new Router(this.registry, routerOptions).decide({
        taskId: this.taskId,
        complexityTier: tier.tier,
        availableProviders: this.input.availableProviders,
        appliedPolicies: tier.appliedPolicies,
        contrast: this.contrastRequested(tier.tier),
        // **물러난 파이프라인은 배정도 종전대로 한다**(72.3절). 실험 하네스 전용이며
        // production에서 `experiment`는 언제나 `undefined`다.
        legacyCrossVerification: this.input.experiment?.pipeline === "legacy_cross_verification",
      });
    } catch (error) {
      if (error instanceof RoutingError) {
        return this.finish("failed", error.message, "provider_config_error");
      }
      throw error;
    }
    this.state.routing = this.routing;
    await this.emit("ROUTING_DECIDED", this.routing);

    try {
      this.adapters = createRoleAdapters(
        this.routing.assignments,
        (modelId) => this.registry.get(modelId),
        this.deps.adapterOptions
      );
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        return this.finish("failed", error.message, "provider_config_error");
      }
      throw error;
    }

    /**
     * **"검수자를 구하지 못했다"와 "태스크가 simple하다"는 다른 사실이다.**
     *
     * 예전에는 `routing.activeRoles.includes("reviewer")` 하나로 경로를 갈랐다. 그래서
     * 공급자가 하나뿐이면 tier가 `standard`여도 파이프라인 전체가 `SINGLE_MODEL_FIX`로
     * 바뀌었다 — 초안 프롬프트도, `DraftProposal`도, `DRAFT_RECEIVED`의 patch도 없어진다.
     *
     * 그건 CLAUDE.md 원칙 4의 읽기와 어긋난다. 거기 적힌 것은 **"검수 역할을 드롭한 뒤 그
     * 사실을 사용자에게 표시한다"** 이지 다른 파이프라인으로 가라는 것이 아니다. 역할 하나가
     * 빠진 것과 태스크의 성격이 바뀐 것은 같은 일이 아니며, 뭉개면 사용자가 키를 하나만
     * 넣었다는 이유로 **받는 결과의 종류가 통째로 달라진다.**
     *
     * 가설 게이트가 이걸 드러냈다(2026-08-27 P0): 단독 arm이 초안을 만들지 않으므로
     * 교차검증 arm이 재생할 초안이 없었고, 실험이 재려던 A↔C 비교가 성립하지 않았다.
     * 측정이 막힌 것이 계기였지만 고치는 것은 제품의 동작이다.
     *
     * 이제 경로는 **tier가 정하고**, 검수자가 없으면 REVIEWING만 건너뛴다.
     */
    /**
     * ---- `standard`는 72절 흐름으로 간다 ----
     *
     * `simple`은 바뀌지 않는다(`SINGLE_MODEL_FIX` 그대로) — 작은 수정에 승인 두 번을
     * 요구하면 그 수정을 하지 않게 된다.
     *
     * **예외는 실험 하네스 하나뿐이다.** 가설 게이트 Protocol v1의 arm C·D가 재는 대상이
     * 72.3절에서 물러난 그 파이프라인이라, 축 없이 두면 하네스가 조용히 다른 것을 잰다 —
     * 그 판정 기준이 해시로 봉인된 사전등록이므로 그건 봉인이 지키는 것을 없애는 일이다.
     * production 경로에서 `experiment`는 언제나 `undefined`다.
     */
    if (tier.tier === "standard") {
      if (this.input.experiment?.pipeline === "legacy_cross_verification") {
        await this.emit("PHASE_CHANGED_NOTE", {
          note:
            "실험 하네스가 **물러난 교차검증 파이프라인**(DRAFTING→REVIEWING)을 지정했습니다 — " +
            "production 경로가 아닙니다(72.3절).",
          pipeline: "legacy_cross_verification",
        });
      } else {
        return this.runStandardPath();
      }
    }
    const crossVerified = tier.tier !== "simple";

    // ---- 실행 전 루프: DRAFTING→REVIEWING 또는 SINGLE_MODEL_FIX ----
    //
    // 바깥 루프가 하나 더 있는 이유: PLANNING의 기준 게이트가 초안을 되돌릴 수 있다(17.3절
    // 규칙 1). "기준과 충돌하는 patch는 FIX_LOOP가 아니라 재요청 대상"이므로 실행 이후의
    // 루프가 아니라 **실행 전 경로로** 돌아가야 하고, 그러려면 여기까지 되감을 자리가 필요하다.
    // 상한은 `reviseRounds`가 진다 — 실행 전 합의 실패에 이미 배정된 예산이다.
    for (;;) {
      let patch: string;
      let ops: FileOps | undefined;
      for (;;) {
        if (await this.cancelledHere()) return this.finish("cancelled", "분석 중 취소됨");

        const outcome = crossVerified ? await this.runCrossVerifiedPath() : await this.runSingleModelPath();

        if (outcome.kind === "patch") {
          patch = outcome.patch;
          // **이동과 삭제는 patch와 함께 나른다**(44·45절). 따로 두면 되돌아갔을 때 낡은
          // 초안의 조작이 새 patch에 붙는다.
          ops = outcome.ops;
          break;
        }
        if (outcome.kind === "final") {
          return outcome.result;
        }
        // outcome.kind === "retry" — 사용자 답변을 받아 DRAFTING으로 재진입한다.
      }

      // ---- PLANNING → EXECUTING → VERIFYING (fix loop 포함) ----
      const executed = await this.executeAndVerifyLoop(patch, ops);
      if (executed.kind === "final") return executed.result;
      // executed.kind === "redraft" — 기준 게이트가 되돌렸다. 초안부터 다시.
    }
  }

  /** DRAFTING → REVIEWING (교차검증 경로) */
  private async runCrossVerifiedPath(): Promise<PathOutcome> {
    const adapters = this.requireAdapters();
    /**
     * 라우터가 검수자를 **활성화했는가.** 어댑터 유무와 나눠 본다.
     *
     * - 활성화했는데 어댑터가 없다 → 불변식 위반. 조용히 넘어가지 않고 실패로 드러낸다.
     *   "검증한 척"보다 나쁜 것은 "검증했다고 착각하는 코드"다.
     * - 애초에 드롭했다 → 정상이다. 초안까지는 그대로 만들고 REVIEWING만 건너뛴다.
     */
    const reviewerActive = this.routing?.activeRoles.includes("reviewer") ?? false;
    if (reviewerActive && !adapters.reviewer) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          "라우터가 reviewer를 활성화했으나 어댑터가 없습니다 (내부 불변식 위반)",
          "internal_invariant_violated"
        ),
      };
    }

    await this.transition("DRAFTING");

    // 실험 하네스가 초안을 주입한 경우(Arm C/D가 Arm A의 초안을 공유). production에서는 항상 undefined다.
    // 재질문 왕복이 있었다면 주입된 초안은 그 답변을 반영하지 못하므로 쓰지 않는다.
    const replayed = this.answers.length === 0 ? this.input.experiment?.replayDraft : undefined;
    let proposal: DraftProposal;
    /** 대조 대상 — primary가 첫 번째다. 대조가 드롭됐으면 길이가 1이다. */
    let proposals: DraftProposal[];

    if (replayed) {
      proposal = replayed;
      proposals = [replayed];
    } else {
      const round = this.state.counters.clarificationRounds + 1;
      // **두 실행자는 서로의 산출물을 보지 않는다**(17.1절). 같은 스냅샷·같은 프롬프트로
      // 동시에 부르는 것이 그 독립성의 구현이다 — 순차로 부르면서 앞의 결과를 넘기고 싶은
      // 유혹이 생기지 않도록 구조 자체를 병렬로 둔다. 왕복 합의를 만들면 2라운드째부터
      // 두 산출물이 독립 표본이 아니게 되고, 합의는 사용자에게 올릴 질문을 지운다(16.3절).
      const drafted = await Promise.all([
        this.generateDraft(adapters.executor, `draft:${round}`),
        adapters.coExecutor
          ? this.generateDraft(adapters.coExecutor, `draft-co:${round}`, { optionalSample: true })
          : Promise.resolve<DraftOutcome>({ kind: "absent" }),
      ]);

      // **primary 실패는 실패다.** co-executor 실패는 대조를 잃을 뿐 태스크를 죽이지 않는다 —
      // 대조는 질문을 만드는 장치이지 진행 조건이 아니다.
      const primary = drafted[0];
      if (primary.kind === "final") return primary;
      if (primary.kind === "absent") {
        return {
          kind: "final",
          result: await this.finish(
            "failed",
            "primary executor가 초안을 내지 않았습니다 (내부 불변식 위반)",
            "internal_invariant_violated"
          ),
        };
      }
      proposal = primary.value;
      proposals = [primary.value];

      const co = drafted[1];
      if (co.kind === "draft") {
        proposals.push(co.value);
      } else if (adapters.coExecutor) {
        // co-executor가 배정됐는데 초안이 없다. 취소(`final`)이거나 공급자 실패·예산 거부로
        // 건너뛴 것(`absent`)이며, **어느 쪽이든 태스크는 진행한다.**
        //
        // 조용히 넘기지 않는다: 대조를 하지 못했다는 사실이 로그에 남아야 "쟁점이 없었다"와
        // 구별된다. 대조 없이 나온 "불일치 0"은 정보가 아니라 착시다.
        await this.emit("ERROR", {
          stage: "DRAFTING",
          message: "co-executor 초안을 얻지 못해 이번 라운드는 대조 없이 진행합니다",
        });
      }
    }

    // **기준은 primary 초안에서만 흡수한다.** 두 초안의 doneCriteria를 합치면 사용자가 갈랐다고
    // 알려준 그 두 해석이 나란히 기준 목록에 들어가 서로 모순된다. 대조의 산출물은 기준이
    // 아니라 질문이고, 기준이 되는 것은 사용자의 답이다.
    // 재요청 전후를 비교할 수 있도록 이번 라운드의 해석을 남긴다(17.10절 ⑧).
    this.lastInterpretation = proposal.interpretation;
    const draftCriteria = this.absorbDraftCriteria(proposal);
    for (const [index, p] of proposals.entries()) {
      await this.emitDraftReceived(p, {
        replayed: Boolean(replayed),
        primary: index === 0,
        criteria: index === 0 ? draftCriteria : undefined,
      });
    }

    // ---- MCP 도구 라운드 (31절) ----
    //
    // **대조와 검수 앞이다.** 도구를 요청한 초안은 아직 없는 결과를 전제로 쓰여 있으므로
    // 그것을 대조하거나 검수하는 것은 의미가 없다. primary의 요청만 실행한다 — 이유는
    // `runMcpRound`에 적어두었다.
    //
    // 여기서 `retry`면 `criteriaFeedback`은 **소비되지 않은 채로 남는다.** 이번 초안은
    // 판정된 적이 없으므로 직전 재요청 사유는 아직 유효하다.
    const mcpOutcome = await this.runMcpRound(proposal.mcpCalls);
    if (mcpOutcome.kind === "final") return mcpOutcome;
    if (mcpOutcome.kind === "retry") return { kind: "retry" };

    // 재요청 사유는 이번 라운드에서 소비했다. 남겨두면 다음 라운드에도 "직전 초안이
    // 거부됐다"가 붙어 이미 고쳐진 문제를 계속 고치라고 말하게 된다.
    this.criteriaFeedback = [];
    this.gateFeedback = [];

    // ---- 구조적 대조 ----
    //
    // 별도 phase를 만들지 않는다(17.1절). 대조는 LLM 호출이 아니라 필드 비교 연산이라
    // 사용자에게 노출할 단계가 아니고, 실패할 수 있는 외부 경계도 없다.
    //
    // **비교할 것이 하나뿐이면 대조를 돌리지 않는다.** 빈 리포트를 남기면 "대조했는데 쟁점이
    // 없었다"로 읽히는데, 실제로는 시도조차 하지 않은 것이다(13.2절). 화면은 이벤트가 없는
    // 것과 `contrasted: false`를 같은 결과로 다루므로(`contrastSummary.ts`) 잃는 정보도 없다.
    if (proposals.length >= 2) {
      const contrastOutcome = await this.contrastAndMaybeAsk(proposals);
      if (contrastOutcome.kind !== "proceed") return contrastOutcome;
    }

    // ---- 검수자가 없으면 여기서 끝난다 ----
    //
    // 초안은 그대로 만들었고(프롬프트·`DraftProposal`·`DRAFT_RECEIVED` 전부 standard 경로의
    // 것이다), 다만 검수할 사람이 없다. **그 사실을 로그에 남긴다** — 남기지 않으면 검수를
    // 거친 실행과 구별되지 않고, "교차검증했다"는 주장이 조용히 근거를 잃는다(원칙 4).
    if (!reviewerActive) {
      const patch = proposal.patch ?? "";
      const ops = fileOps(proposal);
      await this.emit("PHASE_CHANGED_NOTE", {
        phase: "REVIEWING",
        skipped: true,
        // 라우터가 남긴 사유를 그대로 옮긴다 — 여기서 다시 문장을 만들면 둘이 갈라진다.
        reason:
          this.routing?.appliedPolicies.find((p) => p.startsWith("reviewer_dropped")) ??
          "reviewer_dropped",
        reviewerIndependent: false,
        note: "검수자를 배정하지 못해 초안을 그대로 최종 후보로 넘깁니다 (교차검증 없음).",
      });
      // ACCEPT 분기와 같은 조건이다. patch가 없어도 조작이 있으면 성립한다(45절).
      if (patch.trim().length === 0 && !hasFileOps(ops)) {
        return {
          kind: "final",
          result: await this.finish("failed", "초안에 적용할 변경이 없습니다.", "internal_invariant_violated"),
        };
      }
      return { kind: "patch", patch, ops };
    }

    // 13.3절 절충: 검수자가 살아남은 초안의 저자와 같은 모델이면 대조 참가자 중 다른 쪽으로
    // 바꿔 낀다. 자기가 쓴 안을 자기가 검수하지 않는다.
    const reviewer = this.selectReviewer(proposal, adapters);
    if (!reviewer) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          "살아남은 초안의 저자가 아닌 검수자를 찾지 못했습니다 — 자기 산출물을 자기가 검수하지 않습니다.",
          "provider_config_error"
        ),
      };
    }

    // ---- REVIEWING ----
    for (;;) {
      await this.transition("REVIEWING");
      const reviewCall = `review:${this.state.counters.reviseRounds + 1}`;
      // Blind Review는 M1 항목이라 production 기본은 informed다. 실험 하네스만 이 축을 고정한다.
      const blind = this.input.experiment?.reviewMode === "blind";
      const reviewSnapshot = await this.snapshotForPrompt();
      const review = await this.callProvider(reviewer, "reviewer", reviewCall, (ctx) =>
        reviewer.reviewProposal(
          {
            snapshot: reviewSnapshot,
            userMessage: this.input.taskRequest.userMessage,
            draft: proposal,
            blind,
            // 17.1절: 검수자의 역할이 "초안이 옳은지"에서 **"사용자가 고정한 기준이
            // 반영됐는지 확인"**으로 좁아졌다. 자유 재량보다 훨씬 검증 가능한 역할이다.
            acceptanceCriteria: this.criteriaForPrompt(),
          },
          ctx
        )
      );
      if (review.kind === "final") return review;
      const decision = review.value;
      await this.emit("REVIEW_RECEIVED", {
        verdict: decision.verdict,
        model: decision.model,
        rationale: decision.rationale,
        // 검수자가 실행자와 다른 공급자였는지 — 차별화 주장의 근거 데이터.
        reviewerIndependent: this.routing?.reviewerIndependent ?? false,
        // 어떤 정보를 보고 판정했는지. blind/informed 불일치율 지표의 근거다
        // (product-strategy.md 14절) — 모델이 주장하는 값이 아니라 우리가 구성한 사실이다.
        reviewMode: decision.reviewMode,
        // 라우터가 배정한 검수자와 **실제로 부른 검수자**가 다를 수 있다(13.3절 절충).
        // 배정만 남기면 로그가 실제로 누가 검수했는지에 답하지 못한다.
        assignedReviewerModel: adapters.reviewerModelId ?? null,
        actualReviewerModel: reviewer.modelId,
        /**
         * **검수자가 내놓은 수정본.** REVISE에서 이 patch가 초안을 그대로 갈아치우고 실행된다.
         *
         * 이걸 남기지 않으면 **실제로 적용된 변경의 출처가 로그에 없다** — `DRAFT_RECEIVED`의
         * patch는 버려졌는데 어디에도 그 사실이 없고, "왜 이 patch가 적용됐나"에 답할 수 없다.
         * `DRAFT_RECEIVED`가 `hasPatch`만 남기던 때와 같은 종류의 구멍이다.
         */
        revisedPatch: decision.revisedPatch ?? null,
        /**
         * 수정본이 초안과 **실제로 다른가.**
         *
         * 여기서 계산하는 이유: 8KB를 넘는 patch는 Rust가 artifact로 밀어내므로 집계 쪽에서
         * 두 payload를 비교하면 **큰 patch에서만 조용히 비교가 실패**한다. 두 문자열을 손에
         * 들고 있는 자리에서 판정해 boolean으로 남긴다.
         *
         * REVISE가 아니거나 수정본이 없으면 `null`이다 — false로 뭉개면 "바꾸지 않았다"와
         * "바꿀 기회가 없었다"가 같은 값이 된다.
         */
        revisionChangedThePatch:
          decision.verdict === "REVISE" && decision.revisedPatch
            ? decision.revisedPatch.trim() !== (proposal.patch ?? "").trim()
            : null,
      });

      switch (decision.verdict) {
        case "ACCEPT": {
          const patch = proposal.patch ?? "";
          const ops = fileOps(proposal);
          // **patch가 없어도 조작이 있으면 성립한다**(45절). "이 파일을 지워라"는 patch 없이
          // 완결되는 요구이고, 여기서 막으면 그 요구는 모델이 무엇을 내든 실패한다.
          if (patch.trim().length === 0 && !hasFileOps(ops)) {
            return {
              kind: "final",
              result: await this.finish(
                "failed",
                "검수자가 초안을 수락했으나 적용할 변경이 없습니다.",
                "internal_invariant_violated"
              ),
            };
          }
          // **이동과 삭제도 함께 나른다**(44·45절). 검수자는 둘 중 어느 것도 거부할 방법이
          // 없지만(44.9절), 게이트가 매번 사용자 승인을 요구하는 것이 그 자리의 backstop이다.
          return { kind: "patch", patch, ops };
        }

        case "REVISE": {
          // 실행 전 REVISE 루프. 상한은 TaskPolicy에서 읽는다.
          this.state.counters.reviseRounds += 1;
          if (this.state.counters.reviseRounds > this.policy.limits.reviseRounds) {
            return {
              kind: "final",
              result: await this.finish(
                "failed",
                `실행자와 검수자가 계획에 합의하지 못했습니다 (REVISE ${this.state.counters.reviseRounds}회, 상한 ${this.policy.limits.reviseRounds}).`,
                "revise_exhausted"
              ),
            };
          }
          const revised = decision.revisedPatch;
          if (revised && revised.trim().length > 0) {
            // 검수자가 수정본을 직접 제시했으면 그것을 쓴다 (문서 4절 revisedPatch).
            // **검수자가 조작을 고쳤으면 그것을 쓴다**(46절). 말하지 않았으면 초안의 것을
            // 그대로 싣는다 — 수정본이 옮긴 뒤/지운 뒤를 기준으로 쓰여 있을 수 있으므로
            // 여기서 떨어뜨리면 그 patch가 깨진다.
            return { kind: "patch", patch: revised, ops: reviewedFileOps(proposal, decision) };
          }
          // 수정본 없이 REVISE만 왔으면 초안을 다시 검토시킬 근거가 없다 — 초안을 그대로
          // 재검토해도 같은 결과가 나오므로 루프를 태우지 않고 실패로 확정한다.
          return {
            kind: "final",
            result: await this.finish(
              "failed",
              "검수자가 REVISE를 판정했으나 수정된 patch를 제시하지 않았습니다.",
              "revise_exhausted"
            ),
          };
        }

        case "REJECT":
          return {
            kind: "final",
            result: await this.finishRejected(decision.rejectionReason ?? decision.rationale),
          };

        case "NEED_USER_INPUT": {
          const clarified = await this.askUser(decision.questionsForUser ?? []);
          if (clarified.kind === "final") return clarified;
          // 14.1절: 사용자 답변 후에는 항상 DRAFTING(standard 경로)으로 재진입한다.
          return { kind: "retry" };
        }
      }
    }
  }

  /** 초안 1개 생성. primary/co-executor가 **같은 입력**으로 이 함수를 지난다 — 13.1절. */
  private async generateDraft(
    adapter: ProviderAdapter,
    callId: string,
    options: { optionalSample?: boolean } = {}
  ): Promise<DraftOutcome> {
    // **두 실행자가 같은 스냅샷을 받아야 한다**(1절). `snapshotForPrompt`는 동시 호출을
    // 하나의 다시 읽기로 합치므로, `Promise.all`로 불러도 두 초안의 입력이 갈리지 않는다.
    const draftSnapshot = await this.snapshotForPrompt();
    const draft = await this.callProviderMaybeOptional(
      adapter,
      "executor",
      callId,
      (ctx) =>
      adapter.generateDraft(
        {
          snapshot: draftSnapshot,
          userMessage: this.input.taskRequest.userMessage,
          userAnswers: this.answers.length > 0 ? this.answers : undefined,
          // 17.3절 규칙 1: 확정된 기준을 프롬프트에 넣는다. 프롬프트가 강제력을 주지는
          // 않지만(그래서 PLANNING 게이트가 따로 있다), 넣지 않으면 강제할 대상조차 없다.
          acceptanceCriteria: this.criteriaForPrompt(),
          criteriaFeedback: this.criteriaFeedback.length > 0 ? [...this.criteriaFeedback] : undefined,
          gateFeedback: this.gateFeedback.length > 0 ? [...this.gateFeedback] : undefined,
        },
          ctx
        ),
      options
    );
    if (draft.kind === "final") return draft;
    // 예산으로 건너뛴 선택적 표본은 **없는 표본**이다 — 실패가 아니라 대조가 줄어든 것이다.
    if (draft.kind === "skipped") return { kind: "absent" };
    return { kind: "draft", value: draft.value };
  }

  private async emitDraftReceived(
    proposal: DraftProposal,
    meta: { replayed: boolean; primary: boolean; criteria?: AcceptanceCriterion[] }
  ): Promise<void> {
    await this.emit("DRAFT_RECEIVED", {
      proposalId: proposal.proposalId,
      model: proposal.model,
      interpretation: proposal.interpretation,
      risks: proposal.risks,
      uncertainties: proposal.uncertainties,
      hasPatch: Boolean(proposal.patch && proposal.patch.trim().length > 0),
      // **초안 본문을 이벤트에 남긴다.** 이전에는 `hasPatch`만 남겨서, 검수자가 REJECT하면
      // "무엇을 제안했는지"가 어디에도 기록되지 않았다 — Agent Trace 투명성의 실제 구멍이었다.
      // 8KB를 넘으면 Rust가 artifact로 밀어내고 참조만 남긴다(store.rs INLINE_PAYLOAD_LIMIT_BYTES).
      patch: proposal.patch ?? null,
      plan: proposal.plan,
      // 주입된 초안인지 — 이 값이 "replayed"인 실행은 실험 하네스가 만든 것이다.
      draftSource: meta.replayed ? "replayed" : "generated",
      // 대조가 켜지면 DRAFT_RECEIVED가 라운드당 둘 나온다. 어느 쪽이 이후 단계로 가는지가
      // 로그만으로 구별되어야 한다 — 아니면 "왜 이 patch가 적용됐나"에 답할 수 없다.
      primaryExecutor: meta.primary,
      // 요구 분석의 결론을 수집만 하고 버리지 않는다(17.3절 구멍 3). Rust가 이 이벤트를
      // 기록하는 **같은 트랜잭션 안에서** acceptance_criteria 캐시를 갱신한다.
      ...(meta.criteria
        ? {
            acceptanceCriteria: meta.criteria,
            // 재질문 뒤 새 초안이 오면 이전 초안의 doneCriteria는 철회된 해석이다 — 쌓지 않고 대체한다.
            acceptanceCriteriaReplaces: "draft_proposal",
          }
        : {}),
    });
  }

  /**
   * 대조 → (필요하면) 사용자 판정 → 진행 여부 결정. 17.3~17.4절.
   *
   * `DISAGREEMENT_DETECTED`는 **불일치 0건이어도 발행한다.** 대조를 돌렸다는 사실 자체가
   * 감사 대상이고, "쟁점이 없었다"와 "대조하지 않았다"는 다른 사실이기 때문이다.
   */
  private async contrastAndMaybeAsk(
    proposals: DraftProposal[]
  ): Promise<{ kind: "proceed" } | PathOutcome> {
    const round = this.state.counters.clarificationRounds + 1;
    const report = contrastDrafts({
      taskId: this.taskId,
      proposals,
      complexityTier: this.state.complexityTier ?? "standard",
      round,
    });
    const { asked, deferred, advisory } = planQuestionRound(report);
    await this.emit("DISAGREEMENT_DETECTED", {
      ...report,
      // 대조를 돌렸는지 자체를 payload가 말해야 한다. proposalIds 길이로도 알 수 있지만,
      // 로그를 읽는 사람이 그 추론을 하도록 두지 않는다.
      contrasted: proposals.length >= 2,
      blockingCount: report.disagreements.filter((d) => d.blocking).length,
      askedCount: asked.length,
      deferredCount: deferred.length,
      // 함께 실은 비-blocking 쟁점 수. 종전에는 이 값이 언제나 0이었고, 그 사실이 어디에도
      // 남지 않아 "갈린 것이 없었다"와 구별되지 않았다.
      advisoryCount: advisory.length,
    });

    // **예산을 넘긴 blocking 쟁점을 조용히 삼키지 않는다**(17.4절).
    for (const d of deferred) this.recordUnresolved(d, "질문 예산(한 화면 상한)을 넘겨 묻지 못함");

    if (asked.length === 0) return { kind: "proceed" };

    // 예산을 소진했으면 **실패시키지 않고** 진행한다(17.4절 마지막 항목). 기존 상한 규칙은
    // "모델이 계속 모호하다고 말하는 경우"를 위한 것이고, 이쪽은 이미 사용자가 답을 준 뒤
    // 남은 쟁점이므로 성질이 다르다.
    if (this.state.counters.clarificationRounds + 1 > this.policy.limits.clarificationRounds) {
      for (const d of asked) this.recordUnresolved(d, "재질문 상한에 걸려 묻지 못함");
      await this.emit("PHASE_CHANGED_NOTE", {
        note: "재질문 상한을 소진해 남은 불일치를 묻지 못한 채 진행합니다",
        unresolved: this.unresolvedDisagreements.length,
      });
      return { kind: "proceed" };
    }

    const clarified = await this.askUser(
      // **질문 목록에는 blocking만 넣는다.** 이 배열이 프롬프트로 들어가므로, 답하지 않아도
      // 되는 쟁점을 여기 넣으면 모델이 "물어본 것"으로 읽는다.
      asked.map((d) => d.question.text),
      // 카드에는 함께 싣는다 — 화면이 blocking과 비-blocking을 따로 그린다(3.9절).
      [...asked, ...advisory],
      // 자유 서술은 **질문이 아니라 참고 자료**로 카드에 실린다(17.12절). 물을 수 없는 것을
      // 질문 목록에 넣지 않으면서도, 두 초안이 문제를 어떻게 봤는지는 볼 수 있게 한다.
      report.narratives
    );
    if (clarified.kind === "final") return clarified;
    // 14.1절: 사용자 답변 후에는 항상 DRAFTING으로 재진입한다. 답변이 반영된 초안을 다시
    // 받아야 하고, 그래야 "판정이 반영됐는가"를 검수자가 확인할 대상이 생긴다.
    return { kind: "retry" };
  }

  /**
   * 실제 검수자 어댑터 선택 — multi-engine-routing.md 13.3절.
   *
   * 공급자가 둘뿐이면 라우터가 검수자를 대조 참가자 중 하나로 **잠정** 배정한다. 여기서
   * "살아남은 초안의 저자가 아닌 쪽"으로 확정한다. 완전한 공급자 독립은 아니지만
   * **자기 산출물 자기 승인**이라는 최악은 피한다.
   */
  private selectReviewer(surviving: DraftProposal, adapters: RoleAdapters): ProviderAdapter | undefined {
    const reviewer = adapters.reviewer;
    if (!reviewer) return undefined;
    if (reviewer.modelId !== surviving.model) return reviewer;
    // 검수자가 살아남은 초안의 저자와 같은 모델이다. 대조 참가자 중 다른 쪽으로 바꿔 끼운다.
    const alternative =
      adapters.coExecutor && adapters.coExecutor.modelId !== surviving.model
        ? adapters.coExecutor
        : adapters.executor.modelId !== surviving.model
          ? adapters.executor
          : undefined;
    // 바꿔 낄 대상이 없으면 **자기 검수를 하지 않는다** — 검수 없이 진행하는 편이
    // "검증한 척"보다 안전하다(CLAUDE.md 원칙 4).
    return alternative;
  }

  /** 못 물어본 blocking 쟁점을 기록한다. "물어볼 수 없었다"와 "쟁점이 없었다"는 다른 사실이다. */
  private recordUnresolved(disagreement: Disagreement, reason: string): void {
    const label = `${fieldLabel(disagreement.field)}: ${disagreement.question.text} (${reason})`;
    if (!this.unresolvedDisagreements.includes(label)) this.unresolvedDisagreements.push(label);
  }

  /** SINGLE_MODEL_FIX (단일 모델 경로) */
  private async runSingleModelPath(): Promise<PathOutcome> {
    const adapters = this.requireAdapters();
    await this.transition("SINGLE_MODEL_FIX");

    const callId = `fix:${this.state.counters.clarificationRounds + 1}`;
    const fixSnapshot = await this.snapshotForPrompt();
    const response = await this.callProvider(adapters.executor, "executor", callId, (ctx) =>
      adapters.executor.singleModelFix(
        {
          snapshot: fixSnapshot,
          userMessage: this.input.taskRequest.userMessage,
          userAnswers: this.answers.length > 0 ? this.answers : undefined,
          acceptanceCriteria: this.criteriaForPrompt(),
          criteriaFeedback: this.criteriaFeedback.length > 0 ? [...this.criteriaFeedback] : undefined,
          gateFeedback: this.gateFeedback.length > 0 ? [...this.gateFeedback] : undefined,
        },
        ctx
      )
    );
    if (response.kind === "final") return response;
    const result: SingleModelFixResult = response.value;

    await this.emit("DRAFT_RECEIVED", {
      model: result.model,
      verdict: result.verdict,
      rationale: result.rationale,
      singleModel: true,
      // 5절: 교차검증 없이 진행됐음을 사용자에게 드러낸다.
      reviewerIndependent: false,
      reviewerDroppedReason: this.routing?.appliedPolicies.find((p) => p.startsWith("reviewer_dropped")) ?? null,
    });

    // 단일 모델 경로에도 같은 라운드를 둔다 (31절). 여기 두지 않으면 `fast` 모드에서만
    // MCP가 조용히 사라지고, 사용자는 같은 서버를 등록해 두고도 모드에 따라 다른 동작을 본다.
    const mcpOutcome = await this.runMcpRound(result.mcpCalls);
    if (mcpOutcome.kind === "final") return mcpOutcome;
    if (mcpOutcome.kind === "retry") return { kind: "retry" };

    switch (result.verdict) {
      case "ACCEPT": {
        const patch = result.patch ?? "";
        const ops = fileOps(result);
        // 대조 경로와 같은 판정이다(45절): patch가 없어도 지우거나 옮길 것이 있으면 성립한다.
        if (patch.trim().length === 0 && !hasFileOps(ops)) {
          return {
            kind: "final",
            result: await this.finish("failed", "단일 모델이 ACCEPT했으나 적용할 변경이 없습니다.", "internal_invariant_violated"),
          };
        }
        // 단일 모델 경로에도 같은 자리를 둔다(44·45절) — 여기 두지 않으면 `fast` 모드에서만
        // 이동과 삭제가 조용히 사라지고, 사용자는 모드에 따라 다른 동작을 본다.
        return { kind: "patch", patch, ops };
      }
      case "REJECT":
        return { kind: "final", result: await this.finishRejected(result.rejectionReason ?? result.rationale) };
      case "NEED_USER_INPUT": {
        const clarified = await this.askUser(result.questionsForUser ?? []);
        if (clarified.kind === "final") return clarified;
        return { kind: "retry" };
      }
    }
  }

  /**
   * PLANNING → (AWAITING_APPROVAL) → EXECUTING → VERIFYING → COMPLETED | FIX_LOOP
   *
   * fix loop 상한이 이 루프의 유일한 종료 보장이다.
   */
  private async executeAndVerifyLoop(
    initialPatch: string,
    initialOps: FileOps | undefined
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "redraft" }> {
    let patch = initialPatch;
    /**
     * 이동과 삭제는 **첫 계획에서만** 실린다 (state-machine 44·45절).
     *
     * fix loop는 같은 초안의 조작을 다시 계획에 넣으면 안 된다 — 이동은 `from`이, 삭제는
     * 지울 파일이 이미 없다. 그 실패는 "고치려는 시도"처럼 보이지만 사실은 우리가 같은 일을
     * 두 번 시킨 것이다. 되돌아가는 경우(redraft)에는 새 초안이 자기 조작을 가지고 온다.
     */
    let ops = initialOps;

    for (;;) {
      if (await this.cancelledHere()) return { kind: "final", result: await this.finish("cancelled", "실행 중 취소됨") };

      // ---- PLANNING ----
      await this.transition("PLANNING");
      let plan: ExecutionPlan;
      try {
        plan = buildExecutionPlan({
          taskId: this.taskId,
          patch,
          requestedBy: this.executorRequester(),
          attempt: this.state.counters.fixLoopRounds,
          moves: ops?.moves,
          deletions: ops?.deletions,
        });
        // 실었으면 비운다. 남겨두면 fix loop가 같은 조작을 다시 시킨다.
        ops = undefined;
      } catch (error) {
        if (error instanceof PlanningError || error instanceof ValidationError) {
          // 모델이 낸 patch가 계획으로 변환되지 않는다. fix loop를 태울 수 있으면 태운다 —
          // 형태가 잘못된 patch는 검증 결과 없이도 모델에게 알려줄 수 있는 실패다.
          const retry = await this.enterFixLoopForBadPatch(error.message);
          if (retry.kind === "final") return retry;
          patch = retry.patch;
          continue;
        }
        throw error;
      }
      await this.emit("PLAN_CREATED", {
        planId: plan.planId,
        toolRequests: plan.toolRequests.map((r) => ({ requestId: r.requestId, tool: r.tool, args: describeArgs(r) })),
        approvalRequired: plan.approvalRequired,
        // 이 계획이 어떤 파일을 건드리는지 — 기준 대조의 근거이므로 로그에도 남는다.
        changedPaths: planPaths(plan),
      });

      // ---- 기준 게이트 (17.3절 규칙 1) ----
      //
      // "확정된 기준을 만족하지 못하는 계획은 만들지 않는다." 판정할 수 있는 것은 **위치**뿐이다
      // (criteria.ts 참조) — 자유 문장의 충족 여부를 여기서 판정하려면 모델을 불러야 하고,
      // 그건 9절 순환 의존이다.
      const gate = await this.checkCriteriaBeforeExecuting(plan);
      if (gate.kind === "final") return gate;
      if (gate.kind === "redraft") return { kind: "redraft" };
      if (gate.kind === "refix") {
        patch = gate.patch;
        continue;
      }

      // ---- 게이트 프리플라이트 (42절) ----
      //
      // **파일을 하나도 건드리기 전에** 계획 전체를 게이트에 태워 본다. 이게 없으면 계획의
      // 세 번째 요청이 거부될 때 앞의 둘은 이미 적용된 채로 태스크가 끝난다 — 반쯤 적용된
      // 워크스페이스는 되돌리기가 있어도(19절) 애초에 만들지 않는 편이 낫다.
      const preflight = await this.preflightPlan(plan);
      if (preflight.kind === "final") return preflight;
      if (preflight.kind === "redraft") return { kind: "redraft" };

      // ---- AWAITING_APPROVAL / EXECUTING ----
      //
      // Rust가 승인 왕복을 소유한다(process-architecture.md 4절). Node는 승인 필요 여부를
      // 예상해 phase를 표시할 뿐이고, 실제 승인 대기는 `tool.execute` 응답이 늦게 오는 형태로
      // 나타난다. 그래서 여기서 phase만 옮기고 UI가 승인 모달을 보여줄 수 있게 한다.
      if (plan.approvalRequired) {
        await this.transition("AWAITING_APPROVAL");
      }
      await this.transition("EXECUTING");

      const execution = await this.executePlan(plan);
      if (execution.kind === "final") return execution;

      // ---- VERIFYING (항상 실행된다 — CLAUDE.md 원칙 1) ----
      await this.transition("VERIFYING");
      const report = await this.runVerification("post", this.state.counters.fixLoopRounds);
      this.lastReport = report;

      // 17.3절 규칙 2: build/test/lint 결과 **옆에** 기준 체크리스트를 함께 낸다.
      // 판정은 전부 결정론적이며, 이을 수 없는 것은 미확인으로 남는다.
      await this.evaluateCriteriaAgainst(report);

      if (report.overall === "pass") {
        // 검증을 통과한 **뒤에만** 커밋한다(12절 "Git commit 오케스트레이터 통합").
        // 통과 전에 커밋하면 "검증이 최종 판정자"라는 원칙 1과 정면으로 어긋난다 —
        // 커밋은 되돌리기 어려운 기록이므로 그 판정을 앞질러 남기지 않는다.
        const commit = await this.maybeCommit(report);
        return {
          kind: "final",
          result: await this.finish("completed", this.describeSuccess(report, commit)),
        };
      }

      // 판정할 수 없었던 경우. 통과로 위장하지 않고, 실패로도 몰지 않는다 — 고칠 근거(실패
      // 로그)가 없으므로 fix loop를 태우는 것은 의미가 없다. 완료로 처리하되 그 사실을 명시한다.
      //
      // **두 경우를 다르게 말한다.** 종전에는 하나로 뭉쳐 언제나 "검증 명령이 없습니다,
      // 스크립트를 추가하세요"라고 안내했는데, 돌리려다 못 돌린 경우(Windows에서 `npm`을
      // 찾지 못하는 결함 등)에는 **그 프로젝트에 스크립트가 있다.** 원인을 잘못 짚은 안내는
      // 침묵보다 나쁘다 — 사용자가 없는 문제를 고치러 간다.
      if (report.overall === "not_configured" || report.overall === "could_not_run") {
        // 확정 기준도 함께 말한다. 검증이 침묵한 자리야말로 "무엇을 요구했는지"만 남는
        // 자리이므로, 여기서 기준을 감추면 보고에 아무 내용이 없게 된다.
        const criteria = this.describeCriteria();
        const blocked = report.checks
          .filter((c) => c.status === "SKIPPED_WITH_REASON")
          .map((c) => `${c.kind}(${c.summary})`)
          .join(", ");
        const explanation =
          report.overall === "not_configured"
            ? "이 프로젝트에서 실행할 수 있는 검증 명령이 없어 **검증되지 않았습니다**. " +
              "build/test/lint 스크립트를 추가하면 다음부터 자동으로 검증됩니다."
            : "검증 명령을 **실행하지 못해** 검증되지 않았습니다" +
              (blocked ? `: ${blocked}` : "") +
              ". 스크립트가 없는 것이 아니라 이번 실행에서 돌리지 못한 것입니다.";
        // **무인 실행에서는 완료로 보고하지 않는다** (8.2절 "검사 실패 시 정지").
        //
        // 사람이 보고 있으면 "검증되지 않았습니다"가 달린 완료는 정직한 보고다 — 읽고
        // 판단할 사람이 있다. 무인이면 그 문장을 읽을 사람이 없고, 검증 없이 끝난 작업이
        // **완료로 기록되어 다음 단계가 그 위에 쌓인다.** 원칙 1이 말하는 최종 판정자가
        // 침묵한 채로 통과하는 경로다.
        if (this.policy.unattended) {
          return {
            kind: "final",
            result: await this.finish(
              "failed",
              `무인 실행이라 ${explanation} 검증되지 않은 결과를 완료로 보고하지 않습니다${criteria ? ` · ${criteria}` : ""}`,
              "unverified_unattended"
            ),
          };
        }
        return {
          kind: "final",
          result: await this.finish("completed", `변경을 적용했으나 ${explanation}${criteria ? ` · ${criteria}` : ""}`),
        };
      }

      // ---- FIX_LOOP ----
      this.state.counters.fixLoopRounds += 1;
      if (this.state.counters.fixLoopRounds > this.policy.limits.fixLoopRounds) {
        await this.transition("FIX_LOOP");
        return {
          kind: "final",
          result: await this.finish(
            "failed",
            `검증이 ${this.policy.limits.fixLoopRounds}회 재시도 후에도 실패했습니다. 변경사항은 그대로 남아 있으며 되돌릴 수 있습니다.`,
            "fix_loop_exhausted"
          ),
        };
      }

      // 무엇 때문에 다시 도는지를 여기서 잡아둔다 — 통과한 뒤에는 이 정보가 남지 않는다.
      for (const check of report.checks) {
        if (check.status === "FAILED" || check.status === "TIMED_OUT") this.failedChecksAlongTheWay.push(check.kind);
      }

      await this.transition("FIX_LOOP");
      await this.emit("FIX_LOOP_STARTED", {
        attempt: this.state.counters.fixLoopRounds,
        max: this.policy.limits.fixLoopRounds,
        newlyFailing: report.newlyFailing ?? null,
        preexistingFailures: report.preexistingFailures ?? null,
      });

      const fixed = await this.requestFix(report);
      if (fixed.kind === "final") return fixed;
      patch = fixed.patch;
    }
  }

  /**
   * PLANNING 기준 게이트 — 17.3절 규칙 1.
   *
   * "확정된 기준을 만족하지 못하는 계획은 만들지 않는다. 기준과 충돌하는 patch가 오면
   * **FIX_LOOP가 아니라 재요청 대상**이다."
   *
   * FIX_LOOP가 아닌 이유를 코드로 옮기면 이렇다: FIX_LOOP의 전제는 "적용된 변경을 검증 결과를
   * 근거로 고친다"인데, 여기서는 **아직 아무것도 적용되지 않았다.** 실행 후 예산(fixLoopRounds)을
   * 실행 전 문제에 쓰면 정작 검증이 실패했을 때 쓸 예산이 줄어든다. 그래서 실행 전 합의 실패의
   * 예산인 `reviseRounds`를 쓰고 초안 단계로 되돌아간다.
   *
   * **단, 이미 실행이 시작된 뒤(fix loop 안)라면 되돌리지 않는다.** 초안을 만든 근거인 스냅샷이
   * 이미 낡았기 때문이다. 그때는 결정론적 사실을 근거로 다시 요청하는 FIX_LOOP 경로가 맞다.
   */
  /**
   * 계획을 실행하기 **전에** 게이트에 태워 본다 — state-machine 42절.
   *
   * # 왜 실행 중간이 아니라 앞인가
   *
   * `executePlan`은 요청을 순서대로 실행하고, 거부를 만나면 그 자리에서 태스크를 끝낸다.
   * 그런데 앞의 요청들은 **이미 적용됐다.** 세 파일짜리 patch에서 세 번째가 막히면 사용자의
   * 워크스페이스는 두 파일만 바뀐 상태로 남는다 — 그 상태는 모델이 만들려던 것도, 사용자가
   * 승인한 것도 아니다.
   *
   * # 게이트를 대체하지 않는다
   *
   * 실행 시점에 게이트는 그대로 다시 돈다. 여기서 보는 것은 **미리 보기**다 — 그 사이에
   * 파일이 생기거나 사라지면 두 판정이 달라질 수 있고, 그때 정본은 실행 시점의 판정이다.
   *
   * # 예측할 수 없는 것
   *
   * **사용자의 거부는 여기서 보이지 않는다.** 승인이 필요한 요청은 `require_user_approval`로
   * 나올 뿐이고, 사용자가 실제로 무엇을 답할지는 물어봐야 안다. 그래서 이 검사는 반쯤 적용된
   * 상태를 **줄이지 없애지는 못한다** — 없애려면 계획 전체의 승인을 한 번에 받아야 하고,
   * 그건 항목별 승인(ui-wireframes 4절)과 같은 자리에서 만나는 별개의 결정이다.
   */
  private async preflightPlan(
    plan: ExecutionPlan
  ): Promise<{ kind: "ok" } | { kind: "redraft" } | { kind: "final"; result: FinalResult }> {
    const bridge = this.requireBridge();
    const denied: { requestId: string; tool: string; reason: string; matchedRule: string; redraftable: boolean }[] = [];

    for (const request of plan.toolRequests) {
      const decision = await bridge.evaluateRequest(request);
      if (decision.decision !== "deny") continue;
      denied.push({
        requestId: request.requestId,
        tool: request.tool,
        reason: decision.reason,
        matchedRule: decision.matchedRule,
        // **모르면 `false`다**(41.4절). 낡은 코어가 보내지 않은 것을 "다시 그리면 된다"로
        // 읽으면 실제 거부를 요청 실수로 보고하게 된다.
        redraftable: decision.redraftable === true,
      });
    }

    await this.emit("PLAN_PREFLIGHTED", {
      planId: plan.planId,
      checked: plan.toolRequests.length,
      denied,
    });
    if (denied.length === 0) return { kind: "ok" };

    // **하나라도 진짜 거부면 다시 그리게 하지 않는다.** 그 초대는 게이트를 두드려 보라는
    // 말이 되고(41.4절), 모델은 같은 벽에 다시 부딪힌다.
    const allRedraftable = denied.every((d) => d.redraftable);
    const summary = denied.map((d) => `${d.tool}(${d.matchedRule}): ${d.reason}`).join(" / ");

    if (!allRedraftable) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `계획이 게이트를 지나지 못해 **아무것도 적용하지 않았습니다**: ${summary}`,
          "policy_denied"
        ),
      };
    }

    // 실행이 시작된 뒤(fix loop 안)라면 초안으로 되돌리지 않는다 — 한 루프를 두 counter가
    // 함께 다스리게 되기 때문이다(`checkCriteriaBeforeExecuting`의 같은 판단).
    if (this.state.counters.fixLoopRounds > 0) {
      const retry = await this.enterFixLoopForBadPatch(summary);
      if (retry.kind === "final") return retry;
      // fix loop가 새 patch를 줬으면 이번 계획은 버린다. 바깥 루프가 다시 계획을 만든다.
      return { kind: "redraft" };
    }

    this.state.counters.reviseRounds += 1;
    if (this.state.counters.reviseRounds > this.policy.limits.reviseRounds) {
      // **상한을 넘기면 진행하지 않는다.** 기준 충돌(휴리스틱)과 달리 이건 게이트의 확정
      // 판정이므로, 그대로 실행하면 반드시 거부된다 — 그때는 반쯤 적용된 상태가 남는다.
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `요청의 모양을 게이트가 받지 않아 ${this.policy.limits.reviseRounds}회 다시 요청했지만 고쳐지지 않았습니다: ${summary}`,
          "request_malformed"
        ),
      };
    }

    this.gateFeedback = denied.map((d) => `${d.tool}: ${d.reason}`);
    return { kind: "redraft" };
  }

  private async checkCriteriaBeforeExecuting(
    plan: ExecutionPlan
  ): Promise<
    | { kind: "ok" }
    | { kind: "redraft" }
    | { kind: "refix"; patch: string }
    | { kind: "final"; result: FinalResult }
  > {
    const changedPaths = planPaths(plan);
    const conflicts = findCriteriaConflicts(this.acceptanceCriteria, changedPaths, this.criteriaContext());

    // 직전 라운드에 재요청을 유발한 충돌이 **어떻게 끝났는지**를 먼저 남긴다.
    // 감지만 세면 "충돌이 몇 번 났는가"밖에 알 수 없고, 우리가 답해야 하는 질문은
    // "그 충돌이 쓸모 있었는가"다(12절 미해결 "위치 충돌 규칙의 오탐률").
    await this.settlePendingConflicts(conflicts);

    if (conflicts.length === 0) return { kind: "ok" };

    await this.emit("CRITERIA_CONFLICT_DETECTED", {
      conflicts,
      // 재요청할지 그대로 진행할지는 예산이 정한다. 그 판단 근거도 로그에 남긴다.
      fixLoopRounds: this.state.counters.fixLoopRounds,
      reviseRounds: this.state.counters.reviseRounds,
    });

    const message = conflicts.map((c) => c.message).join(" ");

    // 실행 이후(fix loop 안)라면 초안으로 되돌리지 않는다.
    //
    // **이유가 바뀌었다.** 종전 주석은 "스냅샷이 낡았다"였고 그건 사실이었지만, 이제
    // `snapshotForPrompt`가 변경 이후 내용을 다시 읽으므로 더 이상 이유가 되지 못한다
    // (context-engine.md 6.1절). 남는 진짜 이유는 **루프 상한**이다: 여기서 초안으로
    // 돌아가면 한 루프를 `reviseRounds`와 `fixLoopRounds` 둘이 함께 다스리게 되고,
    // 그러면 "모든 루프에는 상한이 있다"(원칙 5)의 종료 논증이 두 counter에 걸쳐 흩어진다.
    // 실행이 시작된 뒤로는 fix loop의 예산 하나가 다스린다.
    if (this.state.counters.fixLoopRounds > 0) {
      // 이쪽도 결말을 남겨야 한다. fix loop는 PLANNING으로 되돌아오므로 다음 라운드가 판정한다 —
      // 여기서 기억하지 않으면 감지만 세고 결말이 새어 집계의 두 수가 어긋난다.
      this.pendingConflicts = { conflicts, interpretation: this.lastInterpretation };
      const retry = await this.enterFixLoopForBadPatch(message);
      if (retry.kind === "final") return retry;
      return { kind: "refix", patch: retry.patch };
    }

    this.state.counters.reviseRounds += 1;
    if (this.state.counters.reviseRounds > this.policy.limits.reviseRounds) {
      // **실패시키지 않는다.** 이 충돌 판정은 문자열 대조 기반의 좁은 규칙이라 틀릴 수 있고,
      // 휴리스틱으로 태스크를 죽이는 것이 잘못된 계획을 표시하고 진행하는 것보다 낫다는 보장이
      // 없다. 대신 기준 판정에 `CONFLICTS_WITH_CHANGE`로 남아 최종 보고와 화면에 그대로 나온다.
      await this.emit("PHASE_CHANGED_NOTE", {
        note: "기준 충돌이 남아 있으나 재요청 예산을 소진해 그대로 진행합니다",
        conflicts: conflicts.map((c) => c.criterionId),
      });
      await this.emitConflictOutcomes(conflicts, "proceeded_without_change");
      return { kind: "ok" };
    }

    this.criteriaFeedback = conflicts.map((c) => c.message);
    // 다음 라운드에서 결말을 판정하기 위해 기억해 둔다. 해석을 함께 남기는 이유는 위 필드 주석에.
    this.pendingConflicts = { conflicts, interpretation: this.lastInterpretation };
    return { kind: "redraft" };
  }

  /**
   * 재요청을 유발했던 충돌의 결말을 기록한다 — 12절 미해결 "위치 충돌 규칙의 오탐률".
   *
   * **"이 충돌이 진짜 잘못된 계획이었는가"의 정답은 어디에도 없다.** 사용자가 매번 판정해주지
   * 않는 한 관측 가능한 것은 "재요청했더니 계획이 바뀌었다/안 바뀌었다"뿐이다. 그래서 결말
   * 이름을 추론이 아니라 **일어난 일 그대로** 붙였다 — 지표 이름이 추론을 포함하면 집계를
   * 읽는 사람이 그 추론을 사실로 읽는다.
   */
  private async settlePendingConflicts(current: readonly CriteriaConflict[]): Promise<void> {
    if (this.pendingConflicts === null) return;
    const stillConflicting = new Set(current.map((c) => c.criterionId));
    const { conflicts: pending, interpretation: before } = this.pendingConflicts;
    this.pendingConflicts = null;

    await this.emit("CRITERIA_CONFLICT_RESOLVED", {
      outcomes: pending.map((c) => ({
        criterionId: c.criterionId,
        outcome: stillConflicting.has(c.criterionId) ? "plan_unchanged" : "plan_changed_to_expected",
        expectedPaths: c.expectedPaths,
        // **`plan_unchanged`의 두 원인을 가르는 유일한 관측**(17.10절 ⑧).
        interpretationTextChanged: this.interpretationTextChanged(before),
      })),
    });
  }

  /**
   * 재요청 뒤 초안의 해석 **텍스트**가 달라졌는가. 비교할 짝이 없으면 `null`이다.
   *
   * # 이름이 "understanding"이 아니라 "text"인 이유
   *
   * 우리가 관측할 수 있는 것은 문자열이 달라졌다는 사실뿐이다. 같은 말을 다시 쓴 것도
   * 변경으로 잡히고, 다른 말로 같은 오해를 반복한 것도 변경으로 잡힌다. 의미가 바뀌었는지는
   * 또 하나의 모델 호출이라 하지 않는다(17.8절). 이름이 추론을 포함하면 집계를 읽는 사람이
   * 그 추론을 사실로 읽으므로, 잰 것을 그대로 부른다(17.10절 ③과 같은 규칙).
   *
   * 대조와 **같은 정규화**를 쓴다 — 한쪽이 표기 차이로 보는 것을 다른 쪽이 변경으로 세면
   * 두 지표가 같은 사건에 대해 다른 말을 하게 된다.
   */
  private interpretationTextChanged(before: string | null): boolean | null {
    if (before === null || this.lastInterpretation === null) return null;
    return canonicalText(before) !== canonicalText(this.lastInterpretation);
  }

  /**
   * 재요청이 **일어나지 않은** 결말을 기록한다(예산 소진, 태스크 종료).
   *
   * `interpretationTextChanged`가 언제나 `null`인 이유: 비교할 새 초안이 없다. 여기서 `false`를
   * 쓰면 "다시 물었는데 해석이 그대로였다"로 읽히는데, 다시 묻지도 않았다.
   */
  private async emitConflictOutcomes(
    conflicts: readonly CriteriaConflict[],
    outcome: CriteriaConflictOutcome
  ): Promise<void> {
    await this.emit("CRITERIA_CONFLICT_RESOLVED", {
      outcomes: conflicts.map((c) => ({
        criterionId: c.criterionId,
        outcome,
        expectedPaths: c.expectedPaths,
        interpretationTextChanged: null,
      })),
    });
  }

  /**
   * 기준별 판정을 계산해 이벤트로 남긴다 — 17.3절 규칙 2.
   *
   * **모델을 부르지 않는다.** 판정은 전부 `criteria.ts`의 결정론적 규칙이며, 통과/실패라는
   * 사실은 Rust가 만든 리포트에서만 온다. 이 값은 파생이므로 UI가 Rust의 리포트를 옆에 함께
   * 보여준다 — 이것만 보고 믿지 않도록.
   */
  private async evaluateCriteriaAgainst(report: VerificationReport): Promise<void> {
    if (this.acceptanceCriteria.length === 0) {
      this.criterionEvaluations = [];
      return;
    }
    this.criterionEvaluations = evaluateCriteria({
      criteria: this.acceptanceCriteria,
      report,
      changedPaths: this.mutatedPaths,
      context: this.criteriaContext(),
    });
    await this.emit("CRITERIA_EVALUATED", {
      reportId: report.reportId,
      evaluations: this.criterionEvaluations,
      // 개수를 payload에 함께 남긴다 — 나중에 "확인된 기준이 왜 늘 0인가"를 집계로 물을 수 있어야 한다.
      verified: this.criterionEvaluations.filter((e) => e.status === "VERIFIED_BY_TEST").length,
      unverified: this.criterionEvaluations.filter((e) => e.status === "UNVERIFIED").length,
    });
  }

  /**
   * 프롬프트에 넣을 기준 목록. 비어 있으면 `undefined`를 준다 — 빈 목록을 렌더링하면
   * "기준 없음"이라는 헤더만 남아 모델에게 잡음이 된다.
   *
   * 읽는 쪽에서 재요청 사유(`criteriaFeedback`)를 소비하고 비운다. 남겨두면 다음 라운드에도
   * "직전 초안이 거부됐다"가 붙어, 이미 고쳐진 문제를 계속 고치라고 말하게 된다.
   */
  private criteriaForPrompt(): AcceptanceCriterion[] | undefined {
    return this.acceptanceCriteria.length > 0 ? [...this.acceptanceCriteria] : undefined;
  }

  /** 기준 대조의 근거가 되는 워크스페이스 사실. 실재하지 않는 경로는 근거가 될 수 없다. */
  /**
   * 기준 판정이 "이 경로가 실재하는가"를 물을 때 보는 목록 — 17.9.1절.
   *
   * **종전에는 `snapshot.relevantFiles`뿐이었다.** 그건 워크스페이스가 아니라 토큰 예산이 고른
   * 부분집합이므로, 예산에 밀린 테스트도 이번 변경이 새로 만든 테스트도 전부 "그런 파일이
   * 없습니다"가 됐다. 네 곳을 합친다 — 인덱스가 본 것, 인덱스가 제외한 것, 스냅샷이 뺀 것,
   * 이번 변경이 건드린 것. 뒤의 셋은 **제외/변경 자체가 존재의 증거**다.
   */
  private criteriaContext(): CriteriaContext {
    return {
      knownFiles: [
        ...this.contextEngine.knownFilePaths(),
        ...(this.snapshot?.relevantFiles.map((f) => f.path) ?? []),
        ...(this.snapshot?.excludedNotes?.map((n) => n.path) ?? []),
        // **`coverageNotes`는 여기 들어가지 않는다**(context-engine 17절). 저건 경로가
        // 아니라 우리가 보지 못한 범위이고, 실재의 증거가 될 수 없다. 한동안 검색 쪽 노트가
        // `excludedNotes`에 섞여 있었으므로 `(search: foo)`가 **실재하는 경로**로 읽혔다.
        ...this.mutatedPaths,
      ],
    };
  }

  /** 계획의 ToolRequest를 순차 실행한다. 재시도 상한은 `toolRetries`. */
  private async executePlan(plan: ExecutionPlan): Promise<{ kind: "ok" } | { kind: "final"; result: FinalResult }> {
    const bridge = this.requireBridge();

    for (const request of plan.toolRequests) {
      if (await this.cancelledHere()) {
        return { kind: "final", result: await this.finish("cancelled", "도구 실행 중 취소됨") };
      }

      let attempt = 0;
      for (;;) {
        const { result, policy } = await bridge.executeRequest(request);

        if (result.status === "ok") {
          const applied = describeApplied(result.output);
          if (applied) this.appliedChangeNotes.push(applied);
          const path = (request.args as { path?: unknown }).path;
          // **이동은 `path`를 쓰지 않는다**(44절: `from`/`to`로 받는다). `path`만 보면
          // 이름을 바꾼 파일이 변경 목록에서 통째로 빠지고, 그러면 72.7절의 범위 이탈
          // 판정이 **모델 없이 낼 수 있다고 한 절반**에서 파일을 놓친다.
          for (const key of ["from", "to"] as const) {
            const moved = (request.args as Record<string, unknown>)[key];
            if (typeof moved === "string" && moved.length > 0 && !this.mutatedPaths.includes(moved)) {
              this.mutatedPaths.push(moved);
            }
          }
          if (typeof path === "string" && path.length > 0) {
            if (!this.mutatedPaths.includes(path)) this.mutatedPaths.push(path);
            // 이 순간부터 스냅샷의 파일 내용은 디스크와 다르다.
            this.snapshotStale = true;
          }
          break;
        }

        // Rust가 취소로 보고한 경우 — 재시도하지 않고 태스크를 취소로 끝낸다.
        if (result.status === "cancelled") {
          return {
            kind: "final",
            result: await this.finish("cancelled", `도구 실행이 취소되었습니다 (${request.tool})`),
          };
        }

        if (result.status === "denied") {
          // Policy Gate 거부 / 사용자 승인 거부 / 무인 실행. 재시도하지 않는다 —
          // 같은 요청을 다시 보내는 것은 승인 피로도를 유발하는 것 말고는 하는 일이 없다.
          const denialReason = result.error ?? policy.reason;
          // **세 결말을 뭉개지 않는다.** 사용자가 거부한 것은 사용자의 의사(cancelled)이고,
          // 게이트가 거부한 것은 요청을 다시 생각해야 하는 실패이며, 무인 실행에서 멈춘 것은
          // **사람이 붙으면 그대로 진행되는** 상태다. 같은 이름으로 보고하면 사용자가
          // 정책을 의심하며 고칠 곳을 찾아 헤맨다.
          if (result.denialKind === "unattended") {
            return {
              kind: "final",
              result: await this.finish(
                "failed",
                `무인 실행 중 승인이 필요한 지점에서 멈췄습니다 (${request.tool}): ${denialReason}`,
                "unattended_stop"
              ),
            };
          }
          // **거부에도 두 종류가 있다**(41.4절). 게이트가 "하면 안 된다"고 한 것과 "그렇게
          // 요청하면 안 된다"고 한 것은 사용자가 갈 곳이 다르다 — 뭉개서 "정책이 거부했습니다"로
          // 보고하면 사용자는 정책 설정을 열어 고칠 곳을 찾다가 아무것도 찾지 못한다.
          //
          // **판정은 Rust가 준다.** 규칙 이름으로 여기서 다시 판정하면 두 곳이 갈린다(24.3절).
          if (policy.decision === "deny" && policy.redraftable) {
            return {
              kind: "final",
              result: await this.finish(
                "failed",
                `요청의 모양을 게이트가 받지 않았습니다 (${request.tool}): ${denialReason}`,
                "request_malformed"
              ),
            };
          }
          return {
            kind: "final",
            result: await this.finish(
              policy.decision === "deny" ? "failed" : "cancelled",
              `도구 실행이 거부되었습니다 (${request.tool}): ${denialReason}`,
              policy.decision === "deny" ? "policy_denied" : undefined
            ),
          };
        }

        // **재시도할 값어치가 없는 실패는 여기서 끝낸다**(65절).
        //
        // 아래 백오프에는 근거가 있다 — *"파일 락 같은 일시적 원인이 있을 수 있어 짧게
        // 기다린다."* 맞는 말이지만 **모든 실패에 대해 참은 아니다**: 경로가 길어서 실패한
        // 쓰기는 2.2초를 기다린 뒤에도 같은 이유로 실패하고, 그동안 사용자는 도구가 무언가
        // 하고 있다고 믿는다.
        //
        // **판정은 Rust가 준다.** 오류 문장으로 여기서 다시 판정하면 두 곳이 갈리고(24.3절),
        // 그 문장은 로케일에 따라 번역되므로 한국어 Windows에서만 분기가 사라진다.
        const failure = result.fileFailure;
        if (failure && !failure.retryable) {
          return {
            kind: "final",
            result: await this.finish(
              "failed",
              `${failure.fact} ${failure.tryThis}`,
              "tool_failed_permanently"
            ),
          };
        }

        // error / timeout — 재시도 대상
        attempt += 1;
        this.state.counters.toolRetries[request.requestId] = attempt;
        if (attempt > this.policy.limits.toolRetries) {
          return {
            kind: "final",
            result: await this.finish(
              "failed",
              `도구 실행이 ${this.policy.limits.toolRetries}회 재시도 후에도 실패했습니다 (${request.tool}): ${result.error ?? "사유 없음"}`,
              "tool_retry_exhausted"
            ),
          };
        }
        await this.emit("TOOL_RETRY", {
          requestId: request.requestId,
          attempt,
          max: this.policy.limits.toolRetries,
          error: result.error ?? null,
        });
        // 지수 백오프. 로컬 도구 실패는 대개 즉시 재시도해도 같지만, 파일 락 같은
        // 일시적 원인이 있을 수 있어 짧게 기다린다.
        await sleep(Math.min(200 * 2 ** (attempt - 1), 2_000));
      }
    }
    return { kind: "ok" };
  }

  /** FIX_LOOP에서 모델에게 수정을 요청한다. 근거는 VerificationReport뿐이다. */
  private async requestFix(report: VerificationReport): Promise<{ kind: "patch"; patch: string } | { kind: "final"; result: FinalResult }> {
    const adapters = this.requireAdapters();
    const digest = buildDigest(report);

    // **나가는 것을 기록에 남긴다**(state-machine 67절, product-strategy 7.2절).
    //
    // 이 내용은 공급자로 나가는데 전송 집계가 세지 못하고 있었다 — 값이 메모리에서 태어나
    // 프롬프트로 들어갔다가 사라졌기 때문이다(61절이 `anchorCoverage`에서 본 것과 같다).
    // 그래서 화면의 "무엇이 나갔는가"는 검증 출력에 대해 **아무 말도 하지 않았고**, 그
    // 출력에는 실패한 테스트의 스택 트레이스와 **컨텍스트에 없던 파일의 조각**이 들어간다.
    //
    // **호출 전에** 낸다: 호출이 실패해도 그 내용은 이미 나갔다.
    await this.emit("VERIFICATION_DIGEST_SENT", {
      reportId: digest.reportId,
      attemptNumber: digest.attemptNumber,
      // 재는 값과 나가는 값이 **같은 함수**에서 나온다.
      sections: digestSectionSizes(digest, this.appliedChangeNotes.join("\n")),
      // **우리가 알아본 경로다.** 나간 것의 전부가 아니다 — 출력은 텍스트이고 추출은
      // 정규식이다. 그 한계를 화면이 함께 말한다.
      recognizedPaths: [
        ...new Set(digest.failingChecks.flatMap((c) => c.fileReferences.map((f) => f.path))),
      ].sort(),
    });

    // 여기가 결함이 실제로 나타나던 자리다 — 프롬프트가 "당신의 변경이 이미 반영되어 있다"고
    // 말하는 그 스냅샷이 패치 이전이었다.
    const fixLoopSnapshot = await this.snapshotForPrompt();
    const response = await this.callProvider(
      adapters.executor,
      "executor",
      `fixloop:${this.state.counters.fixLoopRounds}`,
      (ctx) =>
        adapters.executor.continueWithToolResult(
          {
            snapshot: fixLoopSnapshot,
            userMessage: this.input.taskRequest.userMessage,
            appliedChanges: this.appliedChangeNotes.join("\n"),
            digest,
            attemptNumber: this.state.counters.fixLoopRounds,
          },
          ctx
        )
    );
    if (response.kind === "final") return response;
    const result = response.value;

    if (result.verdict === "ACCEPT" && result.patch && result.patch.trim().length > 0) {
      return { kind: "patch", patch: result.patch };
    }
    if (result.verdict === "REJECT") {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `검증 실패를 수정할 수 없다고 판정했습니다: ${result.rejectionReason ?? result.rationale}`,
          "fix_loop_exhausted"
        ),
      };
    }
    // NEED_USER_INPUT은 실행 후 단계에서 처리하지 않는다 — 이미 파일이 바뀐 상태에서
    // 재질문을 시작하면 상태 머신이 실행 전 경로로 되돌아가야 하고, 그건 2절 다이어그램에 없다.
    return {
      kind: "final",
      result: await this.finish(
        "failed",
        `검증 실패 수정 단계에서 수정안을 받지 못했습니다 (verdict=${result.verdict}).`,
        "fix_loop_exhausted"
      ),
    };
  }

  /** 형태가 잘못된 patch도 fix loop로 다룬다 — 상한은 같다. */
  private async enterFixLoopForBadPatch(
    message: string
  ): Promise<{ kind: "patch"; patch: string } | { kind: "final"; result: FinalResult }> {
    this.state.counters.fixLoopRounds += 1;
    await this.emit("ERROR", { stage: "PLANNING", message });

    if (this.state.counters.fixLoopRounds > this.policy.limits.fixLoopRounds) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `모델이 적용 가능한 patch를 만들지 못했습니다 (${this.policy.limits.fixLoopRounds}회 시도): ${message}`,
          "fix_loop_exhausted"
        ),
      };
    }

    await this.transition("FIX_LOOP");
    await this.emit("FIX_LOOP_STARTED", {
      attempt: this.state.counters.fixLoopRounds,
      max: this.policy.limits.fixLoopRounds,
      cause: "patch를 실행 계획으로 변환할 수 없음",
    });

    // 검증 리포트가 없으므로 patch 형태 오류 자체를 다이제스트로 만들어 전달한다.
    const syntheticReport: VerificationReport = {
      taskId: this.taskId,
      reportId: `synthetic-${this.state.counters.fixLoopRounds}`,
      phase: "post",
      attemptNumber: this.state.counters.fixLoopRounds,
      checks: [
        {
          kind: "diff_review",
          status: "FAILED",
          summary: "patch를 적용 계획으로 변환할 수 없음",
          detail: message,
        },
      ],
      overall: "fail",
      createdAt: new Date().toISOString(),
    };
    return this.requestFix(syntheticReport);
  }

  // ---- 보조 ----

  /**
   * 대조(executor ×2)를 요청할 것인가 — 17.5절 게이팅.
   *
   * # 축이 둘인데 하나로 보고 있었다
   *
   * 종전 규칙은 `tier === "standard"` 하나였고, 주석은 *"`verified` 이상에서만 켠다는 것이
   * 규칙이고, tier가 2단계인 현재는 `standard`가 그 자리다"* 라고 적혀 있었다. **그 등치가
   * 틀렸다.** `standard`는 두 경로에서 나온다:
   *
   *  - 사용자가 `verified`를 골랐다 → 언제나 `standard`
   *  - 사용자가 `fast`인데 **TRIAGE 규칙이** `standard`로 분류했다
   *
   * 둘째 경우에도 대조가 켜져 executor 호출이 2배가 되고 있었다 — 17.5절이
   * *"`simple`/`fast`에서 켜지면 13.1절이 측정한 비용 절감이 사라진다"* 고 못박은 바로 그 상황이다.
   * `fast`는 사용자가 **싸게 가겠다고 고른 것**이고, 규칙이 "이 태스크는 어렵다"고 본 것은
   * 교차검증(executor 1 + reviewer 1)을 켜는 근거이지 executor를 하나 더 부르는 근거가 아니다.
   *
   * 그래서 두 축을 갈라 둘 다 요구한다.
   *
   * # 그리고 **둘이 되는 것이 executor가 아니다** — 72.9절
   *
   * 종전 문장은 *"tier는 교차검증을, 실행 모드는 대조를 켠다"*였고 대조의 대상이 executor
   * ×2였다. 서브태스크 분해가 들어오면 그건 **서브태스크마다 ×2**가 되어 N배가 되고,
   * 불일치 카드가 붙을 게이트도 없다 — 구현 중에 사용자를 N번 부를 수는 없다.
   *
   * 계획 단계로 옮기면 정반대가 된다. 계획자를 둘 부르고 갈린 지점을 **이미 사용자가 서 있는
   * 승인 게이트**에 올린다. 추가 호출은 1회, **추가 정지는 0**이다("마찰 0"이 아니다 —
   * 카드가 붙으면 읽을 것은 늘어난다. 없어지는 것은 따로 멈춰 서는 일이다).
   *
   * 그래서 이 함수가 켜는 것은 이제 **계획자 둘**이고, `simple` 경로에 남는 co-executor는
   * **없다**(multi-engine 15.3절: 지정 금지 대상이 co-executor에서 co-planner로 옮겨갔다).
   *
   * **실험 하네스에서는 명시적으로 켜지 않는 한 끈다.** 하네스는 arm을 고정해 비교하는데,
   * 호출이 하나 더 생기면 그게 arm 차이인지 대조 때문인지 구별되지 않는다 — 측정 도구가
   * production 경로를 그대로 타되 축은 하네스가 정한다는 원칙(README)의 연장이다. 다만
   * 하네스 플래그는 **좁히기만 한다**: production이 끄는 자리를 켜지는 못한다.
   */
  private contrastRequested(tier: ComplexityTier): boolean {
    if (tier !== "standard") return false;
    // 비용 2배는 사용자가 고르는 것이지 규칙이 고르는 것이 아니다.
    if (this.policy.executionMode !== "verified") return false;
    const experiment = this.input.experiment;
    if (!experiment) return true;
    return experiment.contrast === true;
  }

  /**
   * 이 태스크의 tier와 그 근거.
   *
   * **규칙이 돌지 않은 경로에는 `evidence`가 없다** — 사용자가 Verified를 고르거나 tier를
   * 강제한 태스크는 TRIAGE의 규칙에 대해 아무것도 말해주지 않으므로, 근거를 만들어 붙이면
   * 집계의 분모가 부풀어 오분류율이 실제보다 낮아 보인다.
   */
  private decideTier(): { tier: ComplexityTier; appliedPolicies: string[]; evidence?: TriageResult } {
    const appliedPolicies: string[] = [];

    /**
     * **`executionMode`는 더 이상 tier를 정하지 않는다** — state-machine 72.9절.
     *
     * 여기 있던 *"사용자가 UI에서 Verified를 고르면 TRIAGE 결과와 무관하게 standard다"*가
     * 72.9절이 뒤집는 바로 그 코드다. `verified`는 **"계획자를 둘 부르라"**는 지시이지
     * "이 태스크를 어렵게 다루라"는 지시가 아니다.
     *
     * 종전 기본값은 세 가지를 한꺼번에 했다: TRIAGE 판정을 버리고, 게이트가 부정한 단계(patch
     * 검수)를 켜고, 미측정 단계(대조)를 켰다. 재정의 뒤에는 TRIAGE가 살아나고, 부정된 단계는
     * 72.3절에서 물러났으며, 켜지는 것은 미측정 단계 하나에 호출 1회다.
     *
     * **그러면 사용자는 어떻게 tier를 올리는가** — tier 축에서 올린다(`forceComplexityTier`).
     * 그 수단을 모드 축에 얹지 않는 것이 72.9절의 요점이며, 얹으면 17.5절이 고친 혼동이
     * 이름만 바꿔 돌아온다.
     *
     * 그리고 이 변경은 **관측의 분모를 넓힌다**: 종전에는 `verified`로 돈 태스크 전부가
     * `appliedPolicies`를 달고 나와 TRIAGE 캘리브레이션의 관측에서 빠졌다(가설 게이트의
     * `observationFromEvents`가 그 배열이 비어 있는지로 판정한다). 이제 규칙이 실제로 돈다.
     */
    /**
     * **물러난 파이프라인은 `standard` 경로의 것이다** — 72.3절.
     *
     * 실험 하네스가 그것을 지정했다는 것은 "그 경로를 태워 달라"는 뜻이므로 tier도 함께
     * 정해진다. 종전에는 `executionMode=verified`가 그 일을 했고(그래서 하네스가 그 값만
     * 주면 됐다), 72.9절이 그 규칙을 없앴으므로 **의지할 자리가 여기로 옮겨온다.**
     *
     * 적지 않으면 하네스의 fixture가 TRIAGE에서 `simple`로 분류되어 `SINGLE_MODEL_FIX`로
     * 끝나고, arm C·D는 **재생할 초안이 없어 아무것도 재지 못한 채 통과한다.**
     *
     * `appliedPolicies`에 남기므로 TRIAGE 캘리브레이션의 관측에서는 빠진다 — 규칙이 돌지
     * 않았으므로 분모에 넣으면 오분류율이 실제보다 낮아 보인다.
     */
    if (this.input.experiment?.pipeline === "legacy_cross_verification") {
      appliedPolicies.push("experiment.pipeline=legacy_cross_verification — 물러난 교차검증 경로(72.3절)");
      return { tier: "standard", appliedPolicies };
    }
    if (this.policy.forceComplexityTier) {
      appliedPolicies.push(`forceComplexityTier=${this.policy.forceComplexityTier}`);
      return { tier: this.policy.forceComplexityTier, appliedPolicies };
    }
    const evidence = triage(this.requireSnapshot(), this.input.taskRequest.userMessage, this.deps.triagePolicy);
    return { tier: evidence.tier, appliedPolicies, evidence };
  }

  /**
   * 공급자 호출 + 재시도 + usage 기록.
   *
   * 재시도(providerRetries)는 의미론적 루프와 별개로 센다 (문서 9절).
   */
  private async callProvider<T>(
    adapter: ProviderAdapter,
    role: EngineRole,
    callId: string,
    call: (ctx: ProviderCallContext) => Promise<ProviderResponse<T>>
  ): Promise<{ kind: "value"; value: T } | { kind: "final"; result: FinalResult }> {
    const outcome = await this.callProviderMaybeOptional(adapter, role, callId, call, {});
    // `optionalSample`을 주지 않았으므로 `skipped`는 나올 수 없다. 조용히 넘기지 않고 드러낸다 —
    // 이 경로가 실제로 실행되면 그건 예산 처리가 필수 호출을 건너뛰었다는 뜻이고, 그때
    // 태스크가 조용히 진행되면 "왜 검수 없이 끝났나"에 답할 수 없다.
    if (outcome.kind === "skipped") {
      throw new Error(`내부 불변식 위반: 필수 공급자 호출(${role}/${callId})이 건너뛰어졌습니다`);
    }
    return outcome;
  }

  private async callProviderMaybeOptional<T>(
    adapter: ProviderAdapter,
    role: EngineRole,
    callId: string,
    call: (ctx: ProviderCallContext) => Promise<ProviderResponse<T>>,
    options: { optionalSample?: boolean }
  ): Promise<{ kind: "value"; value: T } | { kind: "final"; result: FinalResult } | { kind: "skipped" }> {
    const retryPolicy = this.deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const timeoutMs = this.deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

    // **예약은 재시도마다 한다.** 재시도도 유료 호출이므로 한 번 예약하고 세 번 부르면
    // 상한이 최대 세 배까지 새어 나간다.
    const entry = this.registry.get(adapter.modelId);
    const providerKind = entry ? providerKindOf(entry) : "real";
    // **거부 사실을 따로 기억한다.** 던진 예외는 `callWithRetry`가 `ProviderCallFailed`로
    // 감싸므로 catch에서 타입으로는 알아볼 수 없다. 감싸기 전의 사실을 남겨두고 먼저 본다.
    let refusedReason: string | null = null;

    try {
      const { value, attempts } = await callWithRetry(
        async (attempt) => {
          const reserved = this.budget?.reserve(entry, `${role}/${callId}#${attempt}`) ?? {
            ok: true as const,
            reservation: null,
          };
          if (!reserved.ok) {
            refusedReason = reserved.reason;
            throw new BudgetRefused(reserved.reason);
          }

          const scoped = withTimeout(this.abort.signal, timeoutMs);
          // 요청이 실제로 나갔는가 — 나간 뒤의 실패는 과금됐을 수 있으므로 예약을 풀지 않는다.
          let dispatched = false;
          // **호출 직전에 개시를 남긴다** (§2.6). 여기와 terminal 이벤트 사이에서 프로세스가
          // 죽으면 `PROVIDER_CALL_STARTED`만 남고, 그건 "요청이 나갔는지 모른다"는 뜻이다 —
          // 그 상태의 예약을 해제하면 과금됐을 수 있는 돈을 안 쓴 것으로 만든다.
          await this.emit("PROVIDER_CALL_STARTED", {
            taskId: this.taskId,
            callId,
            role,
            attempt,
            providerId: adapter.providerId,
            requestedModelId: adapter.modelId,
            startedAt: new Date().toISOString(),
          });
          try {
            dispatched = true;
            const response = await call({ taskId: this.taskId, callId, signal: scoped.signal, timeoutMs });
            this.budget?.settle(reserved.reservation, {
              costUsd: this.registry.costUsd(adapter.modelId, response.usage),
              usage: response.usage,
              providerKind,
              requestedModelId: response.meta.requestedModelId,
              providerReportedModelId: response.meta.providerReportedModelId,
              providerRequestId: response.meta.providerRequestId,
            });
            await this.recordUsage(adapter, role, callId, response, attempt);
            return response.value;
          } catch (error) {
            // **예약을 여기서 정리한다.** 응답을 받지 못한 실패는 과금 여부를 모르므로
            // 해제가 아니라 미해결이다 — 해제하면 쓴 돈을 안 쓴 것으로 만든다.
            this.budget?.abandon(reserved.reservation, dispatched, errorMessage(error));
            // SDK는 타임아웃과 사용자 취소를 모두 AbortError로 던진다. 둘의 처리가 다르므로
            // (타임아웃은 재시도 후 FAILED, 취소는 즉시 CANCELLED) 신호를 만든 쪽에서 되살린다.
            const raised = scoped.timedOut() ? asTimeoutError(error, timeoutMs) : error;
            await this.recordCallFailure(adapter, role, callId, attempt, error, raised);
            throw raised;
          } finally {
            scoped.dispose();
          }
        },
        retryPolicy,
        {
          onRetry: ({ attempt, delayMs, error }) => {
            this.state.counters.providerRetries[callId] = attempt;
            void this.emit("PROVIDER_RETRY", {
              callId,
              role,
              attempt,
              max: retryPolicy.maxRetries,
              delayMs,
              errorKind: error.kind,
              // 오류 메시지는 남기지만 응답 원문은 남기지 않는다 (작업 지침 4.6절).
              message: error.message,
            });
          },
        }
      );
      if (attempts > 1) this.state.counters.providerRetries[callId] = attempts - 1;
      return { kind: "value", value };
    } catch (error) {
      // 예산 거부는 **공급자 오류가 아니다.** 호출은 나가지 않았고, 고칠 것은 설정이 아니라
      // 사용자가 정한 상한이다. `provider_config_error`로 보고하면 키나 모델을 의심하게 된다.
      if (refusedReason !== null) {
        // **선택적 표본(co-executor)은 돈이 모자란다고 태스크를 죽이지 않는다.** 대조는 질문을
        // 만드는 장치이지 진행 조건이 아니므로, 검수자 독립성을 만족시킬 수 없을 때 검수 역할을
        // 드롭하고 그 사실을 표시하는 것(원칙 4)과 같은 처리를 한다 — 드롭하되 조용히 하지 않는다.
        //
        // 검수자는 반대다. 검수를 돈 때문에 드롭하면 사용자가 고른 verified가 조용히
        // verified가 아니게 된다. 그건 사용자의 요구를 우리가 바꾸는 것이므로 멈춘다.
        await this.emit("BUDGET_REFUSED", {
          callId,
          role,
          reason: refusedReason,
          skipped: options.optionalSample === true,
        });
        if (options.optionalSample) return { kind: "skipped" };
        return { kind: "final", result: await this.finish("failed", refusedReason, "budget_exceeded") };
      }
      if (error instanceof ProviderCallFailed) {
        const { normalized, exhausted } = error;
        if (normalized.kind === "cancelled") {
          return { kind: "final", result: await this.finish("cancelled", "공급자 호출 중 취소됨") };
        }
        const reason: FailureReason = exhausted ? "provider_retry_exhausted" : "provider_config_error";
        await this.emit("ERROR", { stage: role, callId, errorKind: normalized.kind, message: normalized.message });
        // **선택적 표본의 공급자 실패도 태스크를 죽이지 않는다.**
        //
        // 구현하면서 드러난 결함: 종전에는 여기서 `finish("failed")`를 부른 뒤 호출자가
        // "여기서 finish하지 않는다 — 이미 primary 초안이 있으므로 진행할 수 있다"는 주석과
        // 함께 계속 진행했다. 그러면 **태스크는 완료까지 가는데 이벤트 로그에는 TASK_FAILED가
        // 남고**, 마지막 finish는 "(이미 FAILED로 종료된 태스크)"를 돌려준다. 대조 하나를
        // 잃은 것이 태스크 전체의 실패로 기록되는 것이므로, 호출자의 주석이 참이 되게 고친다.
        //
        // 취소는 예외다 — 그건 이 호출만의 문제가 아니라 태스크 전체의 것이고, primary도
        // 같은 신호로 끊긴다.
        if (options.optionalSample) return { kind: "skipped" };
        return {
          kind: "final",
          result: await this.finish("failed", providerFailureMessage(normalized), reason),
        };
      }
      // 구조화 출력 검증 실패(`ValidationError`)는 `normalizeProviderError`가 schema_violation으로
      // 분류하므로 위의 ProviderCallFailed 분기에서 처리된다 — 여기까지 오는 것은 예상치 못한 오류다.
      throw error;
    }
  }

  /**
   * 실패한 호출의 **보존 가능한 사실**을 남긴다 (§2.6).
   *
   * 여기서 남기는 것이 없으면, 실패한 실행에서 "요청이 나갔는가"를 사후에 판단할 근거가
   * 사라진다. 그러면 예약을 해제하는 쪽으로 기울고, 그건 과금됐을 수 있는 돈을 안 쓴 것으로
   * 만드는 것이다.
   *
   * `ProviderCallFailure`가 실어 온 dispatch 상태·usage·응답 모델 ID를 그대로 옮긴다.
   * 평범한 `Error`면 dispatch를 **모르므로 `dispatched_no_response`가 기본이다** —
   * 어댑터 안쪽에서 난 오류는 요청이 나간 뒤일 수 있다.
   */
  private async recordCallFailure(
    adapter: ProviderAdapter,
    role: EngineRole,
    callId: string,
    attempt: number,
    original: unknown,
    raised: unknown
  ): Promise<void> {
    const normalized = normalizeProviderError(raised);
    const facts = attemptFacts(attempt, original, normalized.kind);
    await this.emit("PROVIDER_CALL_FAILED", {
      taskId: this.taskId,
      callId,
      role,
      attempt,
      providerId: adapter.providerId,
      requestedModelId: adapter.modelId,
      ...(facts.providerReportedModelId ? { providerReportedModelId: facts.providerReportedModelId } : {}),
      ...(facts.providerRequestId ? { providerRequestId: facts.providerRequestId } : {}),
      dispatchState: facts.dispatchState,
      errorKind: normalized.kind,
      ...(facts.usage ? { usage: facts.usage } : {}),
      /**
       * **실패한 호출도 과금된다 — 토큰을 알면 비용도 안다.**
       *
       * 응답을 받은 뒤 검증에서 실패한 호출은 usage를 갖고 있다. 그런데 여기서 비용을 싣지
       * 않으면 그 지출이 어디에도 남지 않고, 읽는 쪽은 "얼마인지 모른다"로 처리할 수밖에 없다.
       * 모르는 것과 아는 것을 같은 칸에 넣는 셈이다.
       *
       * 실측(confirmatory, 2026-08-27): `claude-sonnet-5`가 in 2,180 / out 1,402을 쓰고 스키마
       * 위반으로 실패했다. 토큰도 단가도 손에 있었는데 비용이 비어 있어 예약을 정산할 수 없었고,
       * **288건짜리 실행이 2건에서 멈췄다.**
       *
       * 성공 경로(`recordUsage`)와 **같은 함수**로 계산한다 — 두 경로가 다른 방법으로 값을
       * 내면 언젠가 갈라지고, 그때 어느 쪽이 맞는지 알 수 없다.
       */
      ...(facts.usage
        ? (() => {
            const costUsd = this.registry.costUsd(adapter.modelId, facts.usage);
            return costUsd === undefined ? {} : { costUsd };
          })()
        : {}),
      // 오류 메시지는 남기지만 응답 원문은 남기지 않는다 (작업 지침 4.6절).
      message: normalized.message,
      at: new Date().toISOString(),
    });
  }

  private async recordUsage<T>(
    adapter: ProviderAdapter,
    role: EngineRole,
    callId: string,
    response: ProviderResponse<T>,
    attempt: number
  ): Promise<void> {
    const usage = {
      taskId: this.taskId,
      callId,
      role,
      providerId: adapter.providerId,
      modelId: adapter.modelId,
      // **요청한 모델과 공급자가 응답한 모델을 둘 다 남긴다.** 하나만 남기면 조용한 대체를
      // 사후에 감사할 수 없다 — `modelId`는 우리가 요청한 값이므로 항상 우리 기대와 같다.
      requestedModelId: response.meta.requestedModelId,
      resolvedModelId: response.meta.providerReportedModelId,
      ...(response.meta.providerRequestId ? { providerRequestId: response.meta.providerRequestId } : {}),
      usage: response.usage,
      // **우리 추정과 공급자가 보고한 실제를 함께 남긴다.** 하나만 남기면 추정이 상한이라는
      // 주장을 사후에 검증할 수 없고, 계수를 고칠 근거가 감밖에 없다(context/budget.ts).
      ...(response.meta.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: response.meta.estimatedInputTokens }
        : {}),
      costUsd: this.registry.costUsd(adapter.modelId, response.usage),
      latencyMs: response.latencyMs,
      attempt,
      createdAt: new Date().toISOString(),
    };
    // Rust가 provider_usage 테이블에 기록한다 (SQLite writer는 Rust 하나뿐).
    await this.deps.transport.request("usage.record", { usage }).catch(() => undefined);
  }

  /** 결정론적 검증은 Rust에 요청한다 — Node가 "검증했다"고 만들어낼 수 없어야 한다. */
  private async runVerification(phase: "baseline" | "post", attemptNumber: number): Promise<VerificationReport> {
    // 취소된 태스크에서는 Rust가 검증을 거부한다(host.rs). 그 거부를 일반 오류로 흘리면
    // "검증 실패"로 오인되므로 여기서 취소로 변환한다.
    if (await this.cancelledHere()) {
      const error = new Error("태스크가 취소되어 검증을 실행하지 않았습니다");
      error.name = "AbortError";
      throw error;
    }
    const response = await this.deps.transport.request<{ report: VerificationReport }>("verify.run", {
      taskId: this.taskId,
      phase,
      attemptNumber,
    });
    return response.report;
  }

  private async askUser(
    questions: string[],
    disagreements: Disagreement[] = [],
    narratives: DraftNarrative[] = []
  ): Promise<{ kind: "answered" } | { kind: "final"; result: FinalResult }> {
    this.state.counters.clarificationRounds += 1;
    if (this.state.counters.clarificationRounds > this.policy.limits.clarificationRounds) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `요청의 모호함을 해소하지 못했습니다 (재질문 ${this.state.counters.clarificationRounds - 1}회, 상한 ${this.policy.limits.clarificationRounds}).`,
          "clarification_exhausted"
        ),
      };
    }

    await this.transition("AWAITING_USER_INPUT");
    // **3.4절 확인 필요 카드와 3.9절 불일치 카드를 같은 이벤트로 보낸다.** 다른 이벤트를 만들면
    // UI가 둘 중 하나를 놓쳤을 때 화면이 멈춘 것처럼 보인다. 카드 종류는 `disagreements`의
    // 유무로 구별한다 — 모델이 "모르겠다"고 한 경우에는 쟁점 id가 없다.
    await this.emit("APPROVAL_REQUESTED_NOTE", {
      questionsForUser: questions,
      disagreements,
      // **질문과 분리해서 싣는다.** 답할 수 없는 것을 질문과 같은 목록에 두면 화면이 그걸
      // 질문처럼 그리게 되고, 그러면 답할 수 없는 항목이 사용자의 주의를 먹는다(17.12절).
      narratives,
      // 카드 제목을 UI가 추측하지 않도록 종류를 명시한다.
      cardKind: disagreements.length > 0 ? "disagreement" : "clarification",
    });

    const answer = await new Promise<UserAnswer>((resolve) => {
      this.pendingQuestion = { questions, disagreements, resolve };
    });

    const decisions = answer.decisions ?? [];
    // 자유 입력만 온 경우(3.4절 카드)에는 message가 곧 답이다. 3.9절 카드에서는 강제 선택이
    // 답이므로 message가 비어 있어도 취소가 아니다 — 그걸 구별하지 않으면 선택만 하고
    // 보낸 사용자의 판정이 "취소"로 처리된다.
    if (this.abort.signal.aborted || (answer.message.trim().length === 0 && decisions.length === 0)) {
      return { kind: "final", result: await this.finish("cancelled", "사용자 확인 대기 중 취소됨") };
    }

    const answerText =
      decisions.length > 0
        ? decisions.map((d) => d.text.trim()).filter((t) => t.length > 0).join("\n")
        : answer.message;
    this.answers.push({ question: questions.join("\n"), answer: answerText });
    // 프롬프트 주입(answers)과 **별개로** 기준 목록에 고정한다 — 프롬프트는 요청이고
    // 기준은 기록이다. 모델이 프롬프트를 무시해도 기록은 남고 최종 보고가 참조한다.
    await this.recordUserDecision(questions, answerText, decisions, disagreements);
    await this.emit("USER_MESSAGE_RECEIVED", { answerLength: answerText.length });
    return { kind: "answered" };
  }

  /**
   * 사용자 답변을 `AcceptanceCriterion(source = "user_decision")`으로 승격한다(17.3절 구멍 1).
   *
   * 답변 원문을 그대로 기준 텍스트로 쓴다 — 모델에게 "이 답변에서 기준을 뽑아라"고 시키면
   * 사용자의 판정이 다시 모델의 해석을 거치게 되고, 권위를 사용자에게 두기로 한 결정이
   * 그 자리에서 무효가 된다.
   */
  private async recordUserDecision(
    questions: string[],
    answer: string,
    decisions: UserDecisionInput[] = [],
    disagreements: Disagreement[] = []
  ): Promise<void> {
    const decidedAt = new Date().toISOString();
    const round = this.state.counters.clarificationRounds;

    // 3.9절 카드에서 왔으면 **쟁점 하나당 기준 하나**를 만든다. 세 개를 한 문장으로 합치면
    // 최종 보고의 체크리스트가 "사용자가 답한 것 전부"라는 한 줄이 되어 항목별 확인이 불가능해진다.
    const criteria: AcceptanceCriterion[] =
      decisions.length > 0
        ? decisions
            .filter((d) => d.text.trim().length > 0)
            .map((d, index) => ({
              criterionId: `${this.taskId}-user-${round}-${index}`,
              text: d.text.trim(),
              source: "user_decision" as const,
              disagreementId: d.disagreementId,
              decidedAt,
            }))
        : [
            {
              criterionId: `${this.taskId}-user-${round}`,
              text: answer.trim(),
              source: "user_decision" as const,
              decidedAt,
            },
          ];

    this.acceptanceCriteria.push(...criteria);
    // 답을 받은 쟁점은 더 이상 미해결이 아니다.
    const answered = new Set(decisions.map((d) => d.disagreementId));
    for (const d of disagreements) {
      // **비-blocking은 답이 없어도 미해결이 아니다.** 규칙이 "묻지 않아도 된다"고 판정한
      // 것이고 화면도 그렇게 말한다. 여기 넣으면 `unresolvedDisagreements`가 "예산이 모자라
      // 묻지 못한 blocking"이라는 뜻을 잃는다.
      if (!d.blocking) continue;
      if (!answered.has(d.disagreementId) && decisions.length > 0) {
        // 카드에 띄웠는데 답이 오지 않은 항목 — 조용히 넘기지 않는다.
        this.recordUnresolved(d, "카드에 표시했으나 답변이 오지 않음");
      }
    }

    // 카드에서의 자리와 고른 선택지의 순번. **한 카드 질문 상한(4)의 근거를 재기 위한 것**이다
    // (17.10절 ⑨). 지금은 화면 설계에서 나온 추정값이고, 실측 없이 늘리거나 줄일 수 없다.
    const positionOf = new Map(disagreements.map((d, index) => [d.disagreementId, index + 1]));
    const fieldOf = new Map(disagreements.map((d) => [d.disagreementId, d.field]));
    const blockingOf = new Map(disagreements.map((d) => [d.disagreementId, d.blocking]));
    const optionRankOf = (decision: UserDecisionInput): number | null => {
      if (decision.optionId === undefined) return null;
      const options = disagreements.find((d) => d.disagreementId === decision.disagreementId)?.question.options;
      const index = options?.findIndex((o) => o.optionId === decision.optionId) ?? -1;
      return index >= 0 ? index + 1 : null;
    };

    await this.emit("USER_DECISION_RECORDED", {
      questions,
      // 이 카드에 몇 개가 함께 떠 있었는가. 자리(position)만으로는 "3개 중 3번째"와
      // "4개 중 3번째"를 구별할 수 없는데, 스크롤이 생기는지는 카드 크기에 달려 있다.
      cardSize: disagreements.length,
      /**
       * **원문이다.** `answerLength`만 남기면 판정자의 판정이 감사 로그에 없다.
       *
       * 비밀값 모양 마스킹과 8KB 초과분 artifact 밀어내기는 **Rust가** 한다 —
       * Node가 스스로 지키는 규칙은 Node가 장악당하면 사라진다(CLAUDE.md 원칙 2).
       */
      answer,
      // 어떤 쟁점에 대한 답이었는지. 3.4절 확인 필요 카드(모델이 스스로 모호하다고 말한 경우)
      // 에서는 쟁점 id가 없으므로 빈 배열이다 — 그 자체가 "대조에서 나온 질문이 아니었다"는 사실이다.
      decisions: decisions.map((d) => ({
        disagreementId: d.disagreementId,
        optionId: d.optionId ?? null,
        // 자유 입력이었는가. 선택지를 고르지 않았다는 것은 **두 초안 모두 틀렸다**는 뜻이라
        // 나중에 가장 값진 신호가 된다(14절 "불일치 1건당 사용자가 뒤집은 비율").
        freeform: d.optionId === undefined,
        // 카드에서 몇 번째 질문이었는가 (1부터). 답을 자리와 이어야 "아래쪽 질문이 대충
        // 눌리는가"를 물을 수 있다. 카드에서 오지 않은 답(3.4절)에는 자리가 없으므로 null이다.
        cardPosition: positionOf.get(d.disagreementId) ?? null,
        // 고른 선택지가 그 질문에서 몇 번째였는가. 자유 입력이면 null이다.
        optionRank: optionRankOf(d),
        // 어떤 필드의 쟁점이었는가. **랭킹(17.4절)을 튜닝하려면 필드별로 세야 한다** —
        // id에서 파싱할 수도 있지만, 그러면 id 형식을 바꾸는 순간 집계가 조용히 끊긴다.
        field: fieldOf.get(d.disagreementId) ?? null,
        /**
         * 규칙이 이 쟁점을 **막을 만한 것으로 봤는가.**
         *
         * 12절이 남긴 "blocking 판정 규칙 자체"를 물을 수 있게 하는 유일한 축이다. 규칙이
         * "묻지 않아도 된다"고 한 쟁점에서 사용자가 primary가 아닌 것을 골랐다면, 그 판정은
         * 그 태스크에서 틀렸던 것이다. 답이 없으면 이 질문에는 영원히 답할 수 없다.
         */
        blocking: blockingOf.get(d.disagreementId) ?? null,
      })),
      acceptanceCriteria: criteria,
    });
  }

  /**
   * `DraftProposal`의 `doneCriteria`와 `requiredTests`를 기준 목록에 흡수한다(17.3절 구멍 1,
   * 17.9.1절).
   *
   * `DRAFT_SCHEMA`가 required로 강제해서 받아놓고 소비처가 타입 정의뿐이었다 —
   * 요구 분석의 결론이 수집만 되고 버려지고 있었다.
   *
   * **user_decision을 덮지 않는다.** 모델이 낸 기준은 제안이고 사용자가 뒤집을 수 있으므로,
   * 재초안이 와도 갈아치우는 것은 `draft_proposal` 몫뿐이다.
   */
  private absorbDraftCriteria(proposal: DraftProposal): AcceptanceCriterion[] {
    const decidedAt = new Date().toISOString();
    const absorbed: AcceptanceCriterion[] = [
      ...proposal.doneCriteria
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .map((text, index) => ({
          criterionId: `${proposal.proposalId}-done-${index}`,
          text,
          source: "draft_proposal" as const,
          decidedAt,
        })),
      /**
       * `requiredTests`도 함께 흡수한다 — 17.9.1절.
       *
       * **합의하면 사라지는 구조였다.** 이 필드는 대조 가능 필드라서 두 초안이 갈리면
       * 쟁점이 되고 사용자의 답이 기준이 된다. 그런데 둘이 **합의하면** 아무 데도 실리지
       * 않고 사라졌다 — 합의가 검증이 아닌데(17.6절), 합의한 요구만 없어지는 것은 거꾸로다.
       *
       * 그리고 이 필드는 기준↔테스트 연결의 재료 그 자체다. 모델이 "무엇이 확인되어야
       * 하는가"에 답한 유일한 자리이고, 그 답은 대개 **테스트 파일 이름**이라 판정 규칙이
       * 바로 이을 수 있다. 이건 잇는 규칙을 넓히는 것이 아니라, 이을 것을 버리지 않는 것이다.
       */
      ...proposal.requiredTests
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .map((text, index) => ({
          criterionId: `${proposal.proposalId}-test-${index}`,
          text,
          source: "draft_proposal" as const,
          decidedAt,
        })),
    ];
    this.acceptanceCriteria = [
      ...this.acceptanceCriteria.filter((c) => c.source !== "draft_proposal"),
      ...absorbed,
    ];
    return absorbed;
  }

  /**
   * 최종 보고의 기준 체크리스트 한 줄(17.3절 구멍 3 / ui-wireframes 3.10절).
   *
   * 확인된 개수는 `criteria.ts`의 **결정론적 판정**에서 온다 — 모델에게 "이 기준이 충족됐나"를
   * 묻는 순간 product-strategy 9절의 순환 의존이 재현되기 때문이다. 이을 근거가 없으면
   * 미확인으로 남고, 그건 결함이 아니라 현재 상태의 정직한 표시다.
   */
  private describeCriteria(): string | null {
    if (this.acceptanceCriteria.length === 0) return null;
    const userDecided = this.acceptanceCriteria.filter((c) => c.source === "user_decision").length;
    const origin = userDecided > 0 ? `사용자 판정 ${userDecided}개 포함` : "전부 모델 제안";

    // 판정을 아직 계산하지 못한 경우(검증 전에 끝난 태스크)와 "확인된 것이 0개"인 경우는
    // 다른 사실이다. 전자를 후자로 말하면 검증이 돌았다고 오해하게 된다.
    if (this.criterionEvaluations.length === 0) {
      return `기준 ${this.acceptanceCriteria.length}개(${origin}) · 검증 전에 종료되어 기준 판정 없음`;
    }
    return `${describeEvaluations(this.criterionEvaluations)}(${origin})`;
  }

  private executorRequester(): ToolRequester {
    const assignment = this.routing?.assignments.find((a) => a.role === "executor");
    return assignment ? { role: "executor", modelId: assignment.modelId } : { role: "orchestrator" };
  }

  private async transition(to: TaskPhase): Promise<void> {
    const from = this.state.phase;
    if (!isValidTransition(from, to)) {
      throw new InvalidTransitionError(from, to);
    }
    this.state.phase = to;
    // 이벤트를 먼저 기록하고 나서 진행한다 (CLAUDE.md 원칙 7).
    await this.emit("PHASE_CHANGED", { from, to, counters: this.state.counters });
  }

  /**
   * `task_events`에 한 줄 남긴다.
   *
   * **타입이 `TaskEventType`인 것이 요점이다.** 종전에는 `string`이라, 이벤트 이름을 정본으로
   * 선언해 둔 union이 정작 아무것도 막지 못했다 — 실제로 다섯 개가 선언 밖에서 발행되고
   * 있었다. 이름은 **저장된 로그에 영구히 남는 값**이라 나중에 바꾸는 비용이 크고
   * (원칙 7), 집계는 이름으로 이벤트를 찾는다.
   */
  private async emit(type: TaskEventType, payload: unknown): Promise<void> {
    try {
      const result = await this.deps.transport.request<{ eventId: number; seq: number }>("db.appendEvent", {
        taskId: this.taskId,
        type,
        payload,
      });
      this.eventIds.push(String(result.eventId));
    } catch {
      // 이벤트 기록이 실패하면 감사 추적에 구멍이 생긴다. 태스크를 죽이지는 않지만
      // stderr에 남긴다 — 조용히 넘기면 로그가 왜 비어 있는지 알 수 없게 된다.
      process.stderr.write(`[orchestrator] 이벤트 기록 실패: ${type}\n`);
    }
  }

  private async emitError(error: unknown): Promise<void> {
    await this.emit("ERROR", { message: errorMessage(error), name: error instanceof Error ? error.name : "unknown" });
  }

  private async cancelledHere(): Promise<boolean> {
    return this.cancelRequested || this.abort.signal.aborted;
  }

  /**
   * 질문에 답한다 — state-machine 51절.
   *
   * # 이 경로가 하지 않는 것
   *
   * TRIAGE·검수·계획·실행·검증을 하지 않는다. 모델을 **한 번** 부르고 끝난다.
   *
   * 라우팅은 한다 — 어느 모델에게 물을지는 정해야 하고, 그 판정과 기록은 나머지 경로와
   * 같은 자리에 있어야 전송 집계가 성립한다(7.1절).
   *
   * # 왜 `COMPLETED`가 아닌가
   *
   * 상태 머신에 *"`COMPLETED`에 도달하려면 반드시 `VERIFYING`을 지나야 한다"*는 불변식이
   * 있다(원칙 1의 구조적 표현). 답변에는 검증할 것이 없으므로 그 불변식을 **약화시키는 대신
   * 다른 종착지를 만들었다** — `ANSWERED`.
   */
  private async answerQuestion(): Promise<FinalResult> {
    const routed = await this.routeForReadOnly("question_path");
    if (routed.kind === "final") return routed.result;

    await this.transition("ANSWERING");
    if (await this.cancelledHere()) return this.finish("cancelled", "ANSWERING 중 취소됨");

    const executor = this.adapters!.executor;
    let round = 0;
    let answer: QuestionAnswer;
    let refusalNote = "";
    for (;;) {
      const response = await this.callProvider(executor, "executor", `answer:${round + 1}`, (ctx) =>
        executor.answerQuestion(
          {
            snapshot: this.snapshot!,
            userMessage: this.input.taskRequest.userMessage,
            ...(this.answers.length > 0 ? { userAnswers: [...this.answers] } : {}),
            ...(refusalNote ? { contextNote: refusalNote } : {}),
          },
          ctx
        )
      );
      if (response.kind === "final") return response.result;
      answer = response.value;

      // **모델이 요청한 것을 읽고 다시 묻는다**(57절). 상한 안에서만.
      const more = await this.fetchRequestedContext(answer.missingContext, round);
      if (more === null) break;
      refusalNote = more;
      round += 1;
    }
    await this.emit("DRAFT_RECEIVED", {
      model: answer.model,
      // 초안이 아니라는 것을 페이로드가 말한다 — 같은 이벤트 이름을 쓰되 모양이 다르다.
      kind: "question_answer",
      citedFiles: answer.citedFiles,
      // **"모른다"를 세는 자리.** 이 경로에는 결정론적 판정자가 없으므로, 모델이 못 본 것을
      // 말했는지가 사용자가 가진 유일한 방어다(16.1절 — 결과의 오라클이 없다).
      missingContextCount: answer.missingContext.length,
    });

    return this.finishAnswered(answer);
  }

  /**
   * 읽기 전용 경로(질문·계획)의 라우팅. 변경 경로와 **같은 라우터**를 쓰되 tier는 `simple`로
   * 고정한다 — 교차검증을 할 이유가 없고, TRIAGE를 돌리면 없는 질문에 답을 만들게 된다.
   *
   * **두 경로가 한 함수를 쓴다**(53절). 복사해 두면 한쪽만 tier가 바뀌거나 한쪽만 정책 이름을
   * 잃고, 그 어긋남은 라우팅 기록을 나중에 읽는 사람에게만 보인다.
   */
  private async routeForReadOnly(
    appliedPolicy: string
  ): Promise<{ kind: "ok" } | { kind: "final"; result: FinalResult }> {
    try {
      const routerOptions: RouterOptions = {
        ...this.deps.routerOptions,
        ...(this.policy.modelPins ? { pinned: this.policy.modelPins } : {}),
      };
      this.routing = new Router(this.registry, routerOptions).decide({
        taskId: this.taskId,
        complexityTier: "simple",
        availableProviders: this.input.availableProviders,
        appliedPolicies: [appliedPolicy],
        contrast: false,
      });
    } catch (error) {
      if (error instanceof RoutingError) {
        return { kind: "final", result: await this.finish("failed", error.message, "provider_config_error") };
      }
      throw error;
    }
    this.state.routing = this.routing;
    await this.emit("ROUTING_DECIDED", this.routing);

    try {
      this.adapters = createRoleAdapters(
        this.routing.assignments,
        (modelId) => this.registry.get(modelId),
        this.deps.adapterOptions
      );
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        return { kind: "final", result: await this.finish("failed", error.message, "provider_config_error") };
      }
      throw error;
    }
    return { kind: "ok" };
  }

  /**
   * 모델이 요청한 파일을 읽어 스냅샷에 더한다 — state-machine 57절.
   *
   * 다음 라운드를 **돌아야 하면** 프롬프트에 붙일 거절 목록을 돌려주고, 돌 필요가 없거나
   * 돌 수 없으면 `null`을 돌려준다. 반환형이 그 판정을 담는 이유는 호출부가 그것을 다시
   * 계산하지 않게 하기 위해서다 — 두 곳에서 계산하면 상한이 한쪽에서만 지켜진다.
   *
   * # 우리가 판정한다
   *
   * `missingContext`는 자유 문장이므로 무엇이든 들어온다. `context/followUp.ts`가 인덱스와
   * 대조해 **가져올 수 있는 것만** 고르고, 나머지는 사유와 함께 거절한다. 제외 규칙(7절)이
   * 이 경로에서 우회되면 안 되기 때문이다 — 그게 이 함수가 존재하는 이유의 절반이다.
   *
   * # 왜 승인을 따로 묻지 않는가
   *
   * 읽기는 `read_file`이고 그것은 게이트를 그대로 지난다(도구는 이미 읽기 전용으로
   * 좁혀져 있다 — 51.2절). 게이트가 승인을 요구하면 평소 경로로 승인을 묻고, 무인이면
   * 거기서 멈춘다. **이 경로에 별도 승인 규칙을 만들지 않는다**: 만들면 같은 동작에 대한
   * 규칙이 둘이 되고, 둘 중 느슨한 쪽이 우회로가 된다.
   */
  private async fetchRequestedContext(requests: readonly string[], round: number): Promise<string | null> {
    if (requests.length === 0) return null;
    if (round >= this.policy.limits.contextRounds) {
      await this.emit("CONTEXT_ROUND_SKIPPED", {
        reason: "limit_reached",
        limit: this.policy.limits.contextRounds,
        requested: requests.length,
      });
      return null;
    }

    const index = await this.contextEngine.ensureIndex(this.bridge!, this.input.taskRequest.workspaceId);
    const resolution = resolveRequests(index, requests);
    if (resolution.fetch.length === 0) {
      // **가져올 것이 하나도 없으면 라운드를 쓰지 않는다.** 같은 스냅샷으로 다시 물으면
      // 같은 답이 나오고 비용만 는다.
      await this.emit("CONTEXT_ROUND_SKIPPED", {
        reason: "nothing_fetchable",
        refused: resolution.refused,
      });
      return null;
    }

    const added: RelevantFile[] = [];
    for (const item of resolution.fetch) {
      const read = await this.bridge!.readFile(item.path).catch(() => null);
      if (read === null || read.content === null) {
        resolution.refused.push({ request: item.request, reason: "파일을 읽지 못했습니다." });
        continue;
      }
      added.push({
        path: item.path,
        reason: "mentioned",
        reasonDetail: `모델이 ${JSON.stringify(item.request)}로 요청함 (57절)`,
        content: read.content,
        truncated: read.truncated,
        sizeBytes: read.sizeBytes,
      });
    }
    if (added.length === 0) {
      await this.emit("CONTEXT_ROUND_SKIPPED", { reason: "nothing_readable", refused: resolution.refused });
      return null;
    }

    // **이미 있는 파일은 덮지 않는다.** 선정이 고른 것에는 앵커와 창이 붙어 있고(15절),
    // 여기서 통째로 갈아끼우면 그 정보를 잃는다.
    const have = new Set(this.snapshot!.relevantFiles.map((f) => f.path));
    const fresh = added.filter((f) => !have.has(f.path));
    if (fresh.length === 0) {
      // **새로 실린 것이 없으면 라운드를 쓰지 않는다.** 모델이 이미 갖고 있던 파일을
      // 요청한 경우인데, 같은 스냅샷으로 다시 물으면 같은 답이 나오고 비용만 든다.
      // 그리고 그 낭비는 기록에서 "라운드를 돌았다"로만 보여 원인이 드러나지 않는다.
      await this.emit("CONTEXT_ROUND_SKIPPED", {
        reason: "already_in_context",
        requested: resolution.fetch.map((f) => f.path),
        refused: resolution.refused,
      });
      return null;
    }
    this.snapshot = {
      ...this.snapshot!,
      relevantFiles: [...this.snapshot!.relevantFiles, ...fresh],
    };
    this.state.counters.contextRounds += 1;

    await this.emit("CONTEXT_ROUND_COMPLETED", {
      round: this.state.counters.contextRounds,
      limit: this.policy.limits.contextRounds,
      fetched: fresh.map((f) => f.path),
      refused: resolution.refused,
    });

    return refusalNote(resolution.refused);
  }

  /**
   * 계획 경로 — state-machine 53절.
   *
   * `answerQuestion`과 **같은 모양이고, 같아야 한다.** 두 경로가 갈라지면 "파일을 바꾸지
   * 않는다"는 보장이 한쪽에만 있게 되고, 어느 쪽이 보장을 잃었는지는 코드를 읽어야만 안다.
   *
   * # 왜 `AWAITING_USER_INPUT`으로 가지 않는가
   *
   * 모델이 물을 것이 있으면 `openQuestions`로 **값으로 싣고 끝낸다.** 되묻기 루프를 돌면
   * 이 모드가 아끼려는 토큰을 도로 쓰고, 사용자는 "계획을 보려 했는데 심문을 당한" 셈이 된다.
   * 물음은 계획의 일부이지 계획을 막는 관문이 아니다.
   */
  private async outlinePlan(): Promise<FinalResult> {
    const routed = await this.routeForReadOnly("plan_path");
    if (routed.kind === "final") return routed.result;

    await this.transition("OUTLINING");
    if (await this.cancelledHere()) return this.finish("cancelled", "OUTLINING 중 취소됨");

    const executor = this.adapters!.executor;
    let round = 0;
    let plan: PlanOutline;
    let refusal = "";
    for (;;) {
      const response = await this.callProvider(executor, "executor", `plan:${round + 1}`, (ctx) =>
        executor.outlinePlan(
          {
            snapshot: this.snapshot!,
            userMessage: this.input.taskRequest.userMessage,
            ...(this.answers.length > 0 ? { userAnswers: [...this.answers] } : {}),
            ...(refusal ? { contextNote: refusal } : {}),
          },
          ctx
        )
      );
      if (response.kind === "final") return response.result;
      plan = response.value;

      // **계획도 같은 길을 쓴다**(57절). 두 경로가 갈라지면 한쪽만 상한을 잃는다.
      // 계획에서 "더 봐야 할 것"은 `risks`가 아니라 `openQuestions`도 아니다 — 그 둘은
      // 사용자에게 하는 말이고, 컨텍스트 요청은 우리에게 하는 말이라 자리가 다르다.
      const more = await this.fetchRequestedContext(plan.needsContext ?? [], round);
      if (more === null) break;
      refusal = more;
      round += 1;
    }
    await this.emit("DRAFT_RECEIVED", {
      model: plan.model,
      kind: "plan_outline",
      stepCount: plan.steps.length,
      filesToChange: plan.filesToChange,
      // **"틀릴 수 있다"를 세는 자리.** 이 경로에는 결정론적 판정자가 없으므로(만든 것이
      // 없다) 모델이 스스로 말한 위험이 사용자가 가진 유일한 방어다.
      riskCount: plan.risks.length,
      openQuestionCount: plan.openQuestions.length,
    });

    this.pendingPlan = plan;
    return this.finish("planned", plan.summary);
  }

  // ==========================================================================
  // `standard` 개발 흐름 — state-machine 72절
  // ==========================================================================

  /**
   * 72.2절의 흐름 전체.
   *
   * ```
   * OUTLINING → AWAITING_PLAN_APPROVAL → PLAN_REVIEWING
   *   → [서브태스크마다] IMPLEMENTING → PLANNING → AWAITING_APPROVAL → EXECUTING
   *   → VERIFYING ⇄ FIX_LOOP → RESULT_REVIEWING → AWAITING_USER_VERIFICATION → (커밋)
   * ```
   *
   * # 바깥 루프가 세는 것은 `planRounds`다
   *
   * 계획으로 돌아오는 경로는 **셋이고 하나도 빠뜨리면 안 된다**(72.11절):
   * ① 승인 카드의 "수정 요청", ② 체크리스트의 "계획으로 되돌아간다",
   * ③ **B의 쟁점을 보고 계획을 고침**. ③이 빠지기 쉽다 — 앞의 둘은 사용자가 먼저 움직이지만
   * 이것은 모델이 올린 쟁점에서 시작하므로 "사용자가 요청한 수정" 목록에 안 들어간다.
   * 그런데 돌아가는 자리는 같은 `OUTLINING`이고, 카운터가 다르면 그 고리만 상한 없이 돈다.
   *
   * 셋이 **같은 이 루프**를 돌므로 카운터가 갈릴 자리가 없다.
   */
  private async runStandardPath(): Promise<FinalResult> {
    for (;;) {
      if (await this.cancelledHere()) return this.finish("cancelled", "계획 중 취소됨");

      const outlined = await this.outlineForExecution();
      if (outlined.kind === "final") return outlined.result;

      const approved = await this.planApprovalLoop(outlined.plan, outlined.disagreements);
      if (approved.kind === "final") return approved.result;
      if (approved.kind === "replan") continue;

      const built = await this.implementAndVerify(approved.plan);
      if (built.kind === "final") return built.result;
      // built.kind === "replan" — 체크리스트에서 계획으로 되돌아왔다(72.8 귀환 경로 2).
      // **이미 쓴 예산은 해제하지 않는다** — 구현이 이미 돌았고 그 지출은 확정되어 있다.
    }
  }

  /**
   * 실행으로 이어지는 계획을 만든다 — 대조가 켜져 있으면 **계획자를 둘** 부른다(72.9절).
   *
   * 초안 경로의 `runCrossVerifiedPath`와 모양이 같은 것은 우연이 아니다: 옮겨온 것은 대조가
   * 일어나는 **자리**이지 대조 자체가 아니다. 그래서 불일치 카드도 같은 `askUser` 왕복을
   * 쓰고, blocking 판정도 같은 규칙을 지난다.
   */
  private async outlineForExecution(): Promise<
    { kind: "plan"; plan: PlanOutline; disagreements: string[] } | { kind: "final"; result: FinalResult }
  > {
    const adapters = this.requireAdapters();
    // **계획자가 없으면 이 경로가 성립하지 않는다.** 라우터는 `standard`에서 A를 언제나
    // 배정한다(21.6절 사다리에서 A는 필수다) — 없다는 것은 불변식 위반이고, 조용히
    // executor로 대체하면 "계획은 프로파일과 무관하게 frontier"가 거짓이 된다(72.10절).
    const planner = adapters.planner;
    if (!planner) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          "라우터가 계획자를 배정하지 않았습니다 (내부 불변식 위반)",
          "internal_invariant_violated"
        ),
      };
    }

    await this.transition("OUTLINING");
    if (await this.cancelledHere()) {
      return { kind: "final", result: await this.finish("cancelled", "OUTLINING 중 취소됨") };
    }

    const round = this.state.counters.planRounds + 1;
    const plans = await this.callPlanners(planner, adapters.coPlanner, round);
    if (plans.kind === "final") return plans;

    const primary = plans.plans[0]!;
    this.lastInterpretation = primary.summary;

    for (const [index, p] of plans.plans.entries()) {
      await this.emit("DRAFT_RECEIVED", {
        model: p.model,
        kind: "plan_outline",
        primary: index === 0,
        stepCount: p.steps.length,
        subtaskCount: p.subtasks?.length ?? 0,
        filesToChange: p.filesToChange,
        riskCount: p.risks.length,
        openQuestionCount: p.openQuestions.length,
        // **`acceptanceCriteriaReplaces`를 달지 않는다**(72.2.2절). 기준을 정하는 것은
        // 사용자가 승인한 계획이고, 그 승격은 승인 뒤에 한 번만 일어난다.
      });
    }

    // 비교할 것이 하나뿐이면 돌리지 않는다. 빈 리포트를 남기면 "대조했는데 쟁점이 없었다"로
    // 읽히는데 실제로는 시도조차 하지 않은 것이다(13.2절).
    const disagreements = plans.plans.length >= 2 ? await this.contrastPlansForCard(plans.plans) : [];
    return { kind: "plan", plan: primary, disagreements };
  }

  /**
   * 계획자 1~2명 호출 + 컨텍스트 요청 왕복.
   *
   * **둘은 서로의 산출물을 보지 않는다**(17.1절). 같은 스냅샷·같은 프롬프트로 동시에 부르는
   * 것이 그 독립성의 구현이다 — 순차로 부르면서 앞의 결과를 넘기고 싶은 유혹이 생기지 않도록
   * 구조 자체를 병렬로 둔다.
   *
   * **A′ 실패는 대조만 잃는다.** 대조는 질문을 만드는 장치이지 진행 조건이 아니다.
   *
   * `forExecution`과 `maxSubtasks`를 넘기지 않으면 모델이 `subtasks`를 내지 않고 빈 계획이
   * **조용히 통과한다**(72.2.2절) — 둘 다 어댑터가 받아 프롬프트와 검증에 각각 쓴다.
   */
  private async callPlanners(
    planner: ProviderAdapter,
    coPlanner: ProviderAdapter | undefined,
    round: number
  ): Promise<{ kind: "plans"; plans: PlanOutline[] } | { kind: "final"; result: FinalResult }> {
    let refusal = "";
    for (let contextRound = 0; ; contextRound += 1) {
      const snapshot = await this.snapshotForPrompt();
      const input = {
        snapshot,
        userMessage: this.input.taskRequest.userMessage,
        ...(this.answers.length > 0 ? { userAnswers: [...this.answers] } : {}),
        ...(refusal ? { contextNote: refusal } : {}),
        forExecution: true,
        maxSubtasks: this.policy.limits.maxSubtasks,
      };
      const [a, b] = await Promise.all([
        this.callProvider(planner, "planner", `plan:${round}.${contextRound + 1}`, (ctx) =>
          planner.outlinePlan(input, ctx)
        ),
        coPlanner
          ? this.callProviderMaybeOptional(
              coPlanner,
              "planner",
              `plan-co:${round}.${contextRound + 1}`,
              (ctx) => coPlanner.outlinePlan(input, ctx),
              { optionalSample: true }
            )
          : Promise.resolve({ kind: "skipped" as const }),
      ]);
      if (a.kind === "final") return a;
      if (b.kind === "final") return b;
      const plans: PlanOutline[] = [a.value];
      if (b.kind === "value") plans.push(b.value);
      else if (coPlanner) {
        // **조용히 넘기지 않는다.** 대조를 하지 못했다는 사실이 로그에 남아야 "쟁점이
        // 없었다"와 구별된다. 대조 없이 나온 "불일치 0"은 정보가 아니라 착시다.
        await this.emit("ERROR", {
          stage: "OUTLINING",
          message: "대조 계획자의 계획을 얻지 못해 이번 라운드는 대조 없이 진행합니다",
        });
      }

      // **계획도 같은 길을 쓴다**(57절). 두 경로가 갈라지면 한쪽만 상한을 잃는다.
      const more = await this.fetchRequestedContext(plans[0]!.needsContext ?? [], contextRound);
      if (more === null) return { kind: "plans", plans };
      refusal = more;
    }
  }

  /**
   * 계획 대조 — 쟁점을 **승인 카드에 실을 문장으로** 돌려준다(72.9절).
   *
   * # 따로 멈추지 않는다
   *
   * `AWAITING_USER_INPUT`으로 가는 별도 정지를 두지 않는다. 불일치는 **계획 승인 카드의
   * 일부**로 올라가고, 사용자는 72.4절의 같은 선택지 넷 안에서 답한다 — 추가 호출은 1회,
   * **추가 정지는 0**이다.
   *
   * **17.8①의 *목적*은 옮겨오고 *기구*는 옮겨오지 않는다.** 그 절이 "사용자 답변 후 항상
   * 재진입"을 택한 이유는 초안 경로에 **사용자 게이트가 없어서** 답을 작업에 반영할 길이
   * 재실행뿐이었기 때문이다. 계획 경로에는 그 게이트가 바로 거기 있다.
   *
   * 그래서 **`standard` 경로는 `AWAITING_USER_INPUT`을 쓰지 않는다**(72.11절). 쓰면 2.1절
   * 표에 없는 전이(`OUTLINING → AWAITING_USER_INPUT`)를 만들게 된다.
   *
   * 살아남는 계획은 **primary**다 — 사용자가 고르지 않는다(17.8① 그대로). 계획 자체를
   * 고쳐야 하는지는 사용자가 카드에서 "수정 요청"으로 정하고, 그건 72.11절 경로 1이라
   * `planRounds`를 이미 쓴다.
   */
  private async contrastPlansForCard(plans: readonly PlanOutline[]): Promise<string[]> {
    const round = this.state.counters.planRounds + 1;
    const report = contrastPlans({
      taskId: this.taskId,
      plans,
      complexityTier: this.state.complexityTier ?? "standard",
      round,
    });
    await this.emit("DISAGREEMENT_DETECTED", {
      ...report,
      contrasted: plans.length >= 2,
      // **대조의 대상을 payload가 말한다.** 초안 대조와 계획 대조가 같은 이벤트 이름을 쓰므로,
      // 적지 않으면 집계가 둘을 구별하지 못한다 — 72.14절은 계획 대조를 따로 센다.
      contrastOf: "plan_outline",
      blockingCount: report.disagreements.filter((d) => d.blocking).length,
      // **여기서는 질문 예산을 쓰지 않는다.** 한 화면 상한은 "따로 멈춰 물을 때" 화면이
      // 감당할 수 있는 양의 규칙인데, 이 쟁점들은 승인 카드에 함께 실린다. 예산으로 자르면
      // "묻지 못했다"가 아니라 **보여주지 못했다**가 되고, 그건 기록에 남을 사실이 다르다.
      askedCount: 0,
      deferredCount: 0,
      advisoryCount: report.disagreements.filter((d) => !d.blocking).length,
    });

    // 카드에 실을 문장. **어느 쪽이 옳은지 말하지 않는다** — 그건 모델에게 판정을 시키는
    // 것이고, 여기가 하는 일은 사용자가 볼 수 있게 갈린 자리를 보여주는 것뿐이다.
    return report.disagreements.map(
      (d) =>
        `${fieldLabel(d.field)}${d.blocking ? "(중요)" : ""}: ` +
        d.positions.map((p) => (p.value.length > 0 ? p.value.join(" / ") : "(정하지 않음)")).join("  ↔  ")
    );
  }

  /**
   * 계획 승인 게이트 ⇄ B — 72.4·72.6·72.11절.
   *
   * # 승인이 검토보다 먼저다
   *
   * 순서가 뒤집혀 보이지만 그렇지 않다. **사용자 승인**은 *"이게 내가 원하는 것인가"* =
   * 요구에 관한 질문이고 사용자만이 답할 수 있다. **독립 검토**는 *"이 계획이 건전한가"*이고
   * 사용자가 답하지 못할 수도 있다. 뒤집으면 사용자가 자기 관할이 아닌 것까지 떠안는다.
   * 그리고 실무적으로 **사용자가 방향을 거부할 계획에 검토비를 쓰지 않는다.**
   *
   * # B의 쟁점은 승인으로 되돌아간다
   *
   * 검토자는 승인된 계획을 **조용히 바꿀 수 없다**(72.4절). 사용자가 계획 X를 승인했는데
   * 계획 Y가 실행되면 그 승인은 아무것도 뜻하지 않는다. 그래서 쟁점은 카드로 되돌아가고,
   * 사용자가 같은 선택지 넷 안에서 답한다.
   */
  private async planApprovalLoop(
    plan: PlanOutline,
    contrastIssues: readonly string[]
  ): Promise<{ kind: "approved"; plan: PlanOutline } | { kind: "replan" } | { kind: "final"; result: FinalResult }> {
    const subtasks = plan.subtasks ?? [];
    const grades = decideGrades(
      subtasks,
      this.policy.performanceProfile,
      (this.deps.triagePolicy ?? DEFAULT_TRIAGE_POLICY).riskPathSegments
    );
    const escalation = proposeEscalationAllowance({
      limits: this.policy.limits,
      estimatedCostUsd: this.routing?.estimatedCostUsd ?? 0,
      hasUnpricedAssignments: (this.routing?.unpricedAssignments.length ?? 0) > 0,
    });
    const fingerprint = planFingerprint(plan);

    for (;;) {
      if (await this.cancelledHere()) {
        return { kind: "final", result: await this.finish("cancelled", "계획 승인 대기 중 취소됨") };
      }

      const card = buildPlanApprovalCard({
        plan,
        grades,
        routing: this.requireRouting(),
        // **등급별 구현 모델의 단가로 센다.** 라우터의 추정에는 서브태스크가 없다 —
        // 그 시점에 분해가 존재하지 않기 때문이다(72.2.2절).
        implementationCostPerSubtaskUsd: (grade) => this.implementationCostFor(grade),
        escalation,
        effortLevel: this.policy.effortLevel,
        // **Node가 지문을 만들지 않는다.** Rust가 찍고 Rust가 기록하며(72.5절), 승인 이벤트에
        // 남는 값은 Rust가 그 시점에 다시 찍은 것이지 이 값이 아니다.
        workspaceFingerprint: null,
        plannerUnmeasured: this.plannerGrade() === "unmeasured",
        effortIgnoredBy: this.effortIgnoredBy(),
      });
      // 대조와 B의 쟁점을 **같은 카드에** 싣는다(72.9절: 별도 정지를 두지 않는다).
      for (const issue of contrastIssues) card.notes.push(`계획 대조: ${issue}`);
      for (const issue of this.planReviewIssues) card.notes.push(`계획 검토(B): ${issue}`);
      if (this.state.counters.planRounds >= this.policy.limits.planRounds) {
        // **막다른 길을 만들지 않는다**(72.11절). 상한에 걸린 자리가 계획 승인 카드이므로
        // 남는 선택지는 "승인"과 "거부"다 — 코드가 아직 한 줄도 없어 되돌릴 것도 없다.
        card.notes.push(
          `계획 수정 상한(${this.policy.limits.planRounds}회)을 다 썼습니다 — 이제 승인하거나 거부할 수 있습니다.`
        );
      }

      // **자기 자신으로의 전이가 허용된다**(machine.ts). 카드를 다시 묻는 것은 진행바가
      // 뒤로 가는 일이 아니다 — `EXECUTING → EXECUTING`이 "다음 ToolRequest"인 것과 같다.
      await this.transition("AWAITING_PLAN_APPROVAL");
      const response = await this.requestUserGate({ gate: "plan", taskId: this.taskId, card });
      const settled = await this.settleGateResponse(response, "계획 승인");
      if (settled.kind === "final") return settled;

      const choice = settled.choice as PlanApprovalChoice;
      if (choice === "reject") {
        return { kind: "final", result: await this.finishRejected("사용자가 계획을 거부했습니다") };
      }
      if (choice === "revise") {
        if (this.state.counters.planRounds >= this.policy.limits.planRounds) {
          // 상한을 넘겨도 **실패시키지 않는다.** 다시 물으면 카드가 남은 선택지를 적는다.
          await this.emit("PHASE_CHANGED_NOTE", {
            note: "계획 수정 상한을 소진해 더 고칠 수 없습니다 — 승인 또는 거부만 남았습니다",
            planRounds: this.state.counters.planRounds,
            max: this.policy.limits.planRounds,
          });
          continue;
        }
        this.state.counters.planRounds += 1;
        // 쟁점은 계획과 함께 낡는다. 남겨두면 새 계획에 옛 지적이 붙는다.
        this.planReviewIssues = [];
        this.issuesShownFor = null;
        // 기준도 같다 — 승인하지 않은 계획의 요구를 들고 가지 않는다(위 경로와 같은 규칙).
        this.acceptanceCriteria = this.acceptanceCriteria.filter((c) => c.source !== "plan_outline");
        // 이 경로에서는 아직 열린 예약이 없지만(승인 전이다) **규칙을 두 경로에 같이
        // 둔다** — 10.7절이 경계한 자리가 정확히 "되돌아가는 경로가 둘인데 한쪽만 보고
        // 규칙을 적는 것"이다.
        this.releaseImplementationStage("사용자가 계획 수정을 요청했습니다");
        return { kind: "replan" };
      }

      // ---- 승인됐다 ----
      //
      // **예약 시점이 곧 승인 시점이다**(72.12절). 승인 카드가 예상 비용을 보여주는 바로
      // 그 시점에 그 금액이 실제로 남아 있는지 확인한다 — 확인하지 않으면 *"사용자가 비용을
      // 보고 승인한다"*가 절반만 참이 되고, 태스크는 **구현 중간에** 죽는다.
      const staged = await this.reserveImplementationStage(card);
      if (staged.kind === "final") return staged;

      this.approvedPlan = plan;
      this.approvedGrades = grades;
      this.escalationAllowance = escalation;
      this.planReviewSkipped = choice === "approve_skip_review";
      // **기준은 여기서 한 번만 승격된다**(72.2.1절). 구현 모델이 내는 `doneCriteria`는
      // 기준이 되지 않는다 — 받는 쪽이 기준을 다시 쓰게 두면 `source`를 나눈 이유가 사라진다.
      await this.absorbPlanCriteria(plan);

      if (choice === "approve_skip_review" || !this.requireAdapters().planReviewer) {
        if (choice === "approve_with_review") {
          // 사용자는 검토를 골랐는데 배정이 없다. **조용히 넘어가지 않는다** — 라우터가
          // 남긴 드롭 사유를 그대로 옮긴다(여기서 문장을 다시 만들면 둘이 갈라진다).
          await this.emit("PLAN_REVIEW_COMPLETED", {
            ran: false,
            reason:
              this.routing?.appliedPolicies.find((p) => p.startsWith("plan_review_dropped")) ?? "plan_review_dropped",
            independence: this.routing?.planReviewIndependence ?? "not_applicable",
          });
        }
        return { kind: "approved", plan };
      }

      // ---- PLAN_REVIEWING (B) ----
      const reviewed = await this.runPlanReview(plan, fingerprint, grades);
      if (reviewed.kind === "final") return reviewed;

      // 쟁점이 있고 **아직 보여준 적이 없으면** 승인으로 되돌아간다. 승인의 근거가 바뀌었으니
      // 승인을 다시 묻는 것이고, 지문이 바뀌면 승인이 만료되는 것(72.5절)과 같은 모양이다.
      if (this.planReviewIssues.length > 0 && this.issuesShownFor !== fingerprint) {
        this.issuesShownFor = fingerprint;
        // **연 예약을 닫고 다시 연다**(72.12절). 다시 여는 금액이 달라질 수 있기 때문이고
        // (B의 지적으로 분해나 등급이 바뀌면 그렇다), 닫아도 되는 근거는 **그 사이에
        // 구현이 돌지 않았다**는 것이다 — B는 구현 전에 선다.
        this.releaseImplementationStage("계획 검토가 쟁점을 올려 승인으로 되돌아갑니다");
        continue;
      }
      return { kind: "approved", plan };
    }
  }

  /**
   * B — 계획 독립 검토 (72.6절).
   *
   * 산출물은 **verdict가 아니라 쟁점 목록**이다. 카드로 올라가거나 주석으로 남을 뿐이고,
   * 계획을 조용히 바꾸지 못한다.
   *
   * **계획이 바뀌지 않았으면 다시 부르지 않는다**(72.11절). 같은 입력에 같은 검토를 다시
   * 시키면 새로 얻는 정보 없이 호출만 는다 — 사용자 클릭이 매번 필요하므로 무인 루프는
   * 아니지만, 상한이 없는 것은 같다.
   */
  private async runPlanReview(
    plan: PlanOutline,
    fingerprint: string,
    grades: readonly GradeDecision[]
  ): Promise<{ kind: "done" } | { kind: "final"; result: FinalResult }> {
    if (this.reviewedPlanFingerprint === fingerprint) {
      await this.emit("PLAN_REVIEW_COMPLETED", {
        ran: false,
        reason: "plan_unchanged — 계획이 바뀌지 않아 이전 쟁점 목록을 그대로 씁니다",
        issueCount: this.planReviewIssues.length,
      });
      return { kind: "done" };
    }

    const reviewer = this.requireAdapters().planReviewer!;
    await this.transition("PLAN_REVIEWING");
    if (await this.cancelledHere()) {
      return { kind: "final", result: await this.finish("cancelled", "계획 검토 중 취소됨") };
    }

    const before = [...this.planReviewIssues];
    const snapshot = await this.snapshotForPrompt();
    // **B도 선택 호출이다.** 검토자를 부르지 못한 것은 **드롭과 같은 사실**이고(21.6절
    // 사다리가 드롭을 정상 경로로 둔 이유 그대로), 그 사실은 카드와 체크리스트가 말한다.
    // 필수로 두면 부가 검토자의 가용성이 **계획 단계에서 태스크를 죽인다** — 코드를 한 줄도
    // 쓰기 전에.
    const review = await this.callProviderMaybeOptional(
      reviewer,
      "planReviewer",
      `plan-review:${fingerprint.slice(5, 13)}`,
      (ctx) =>
      reviewer.reviewProposal(
        {
          snapshot,
          userMessage: this.input.taskRequest.userMessage,
          // **검토 대상은 계획이다.** `DraftProposal` 모양으로 감싸 보내는 이유는 어댑터가
          // 그 타입 하나만 받기 때문이고, 그 안에서 patch 자리는 비어 있다 — 계획에는
          // patch가 없다(53.5절).
          // **분해와 등급을 함께 보낸다**(72.6절).
          draft: planAsReviewSubject(plan, grades),
          blind: false,
          acceptanceCriteria: this.criteriaForPrompt(),
        },
        ctx
      ),
      { optionalSample: true }
    );
    if (review.kind === "final") return review;
    if (review.kind === "skipped") {
      // 부르지 못했다 — **드롭과 같이 기록한다.** 조용히 넘어가면 "검토했는데 쟁점이
      // 없었다"와 구별되지 않는다.
      this.reviewedPlanFingerprint = fingerprint;
      await this.emit("PLAN_REVIEW_COMPLETED", {
        ran: false,
        reason: "plan_review_skipped:call_failed — 계획 검토자를 부르지 못했습니다(예산·공급자 오류). 코드를 쓰기 전이므로 태스크를 실패시키지 않습니다.",
        independence: this.routing?.planReviewIndependence ?? "not_applicable",
        assignedPlanReviewerModel: this.routing?.assignedPlanReviewer?.modelId ?? null,
        actualPlanReviewerModel: null,
      });
      return { kind: "done" };
    }

    // **verdict를 판정으로 쓰지 않는다**(72.6절). 쟁점만 꺼낸다 — 모델이 판정하지 않고
    // 쟁점을 발굴한다는 product-strategy 16절 그대로다.
    const issues = collectPlanReviewIssues(review.value);
    this.planReviewIssues = issues;
    this.reviewedPlanFingerprint = fingerprint;

    await this.emit("PLAN_REVIEW_COMPLETED", {
      ran: true,
      model: review.value.model,
      independence: this.routing?.planReviewIndependence ?? "not_applicable",
      assignedPlanReviewerModel: this.routing?.assignedPlanReviewer?.modelId ?? null,
      actualPlanReviewerModel: reviewer.modelId,
      issueCount: issues.length,
      issues,
      // **B가 계획을 실제로 바꿨는가**(72.14절 계측). 쟁점 목록이 달라졌는지로 잰다 —
      // 계획 자체는 B가 바꿀 수 없으므로 "바꿨는가"의 관측 가능한 대리값이 이것이다.
      issuesChanged: !sameStrings(before, issues),
      verdict: review.value.verdict,
    });
    return { kind: "done" };
  }

  /**
   * 서브태스크 순차 실행 → 검증 → C → 검증 체크리스트 — 72.2.2·72.7·72.8절.
   *
   * # 왜 순차인가 (72.16절 ③의 답)
   *
   * 셋이 같은 방향을 가리킨다: ① 승인 모달이 서브태스크마다 뜨는데 병렬이면 승인이 동시에
   * 여러 개 뜬다 — Fleet의 승인 큐 문제를 태스크 **안으로** 들여오는 것이다. ② 서브태스크는
   * 같은 워크스페이스를 고치므로 병렬은 쓰기 충돌을 만든다(Fleet이 구성원마다 worktree를
   * 주는 이유이고, **서브태스크에는 그 격리가 없다**). ③ 병렬이 주는 것은 지연 단축인데
   * 이 흐름의 지연은 이미 **사용자 게이트 둘이 지배한다.**
   *
   * 그래서 `tasks.phase`는 진행 중인 서브태스크의 phase다. **몇 번째인가는 phase가 아니라
   * 이벤트와 counters가 말한다** — 파생 캐시에 인덱스를 얹지 않는다(원칙 7).
   */
  private async implementAndVerify(
    plan: PlanOutline
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "replan" }> {
    // **단계 예약은 여기서 닫는다.** 열어 둔 채로 호출 예약이 겹치면 같은 돈이 두 번
    // 잡혀 상한이 사실상 절반이 된다 — 이 예약이 하는 일은 승인 시점의 확인이고,
    // 실제 강제는 그대로 호출 예약이 한다.
    this.releaseImplementationStage("구현을 시작합니다 — 이제부터는 호출 예약이 강제합니다");
    const subtasks = plan.subtasks ?? [];
    const completed: string[] = [];

    for (const [index, subtask] of subtasks.entries()) {
      if (await this.cancelledHere()) {
        return { kind: "final", result: await this.finish("cancelled", "구현 중 취소됨") };
      }
      const built = await this.implementSubtask(plan, subtask, index, subtasks.length, completed);
      if (built.kind === "final") return built;
      completed.push(subtask.intent);
    }

    return this.verifyReviewAndConfirm(plan);
  }

  /** 서브태스크 하나: `IMPLEMENTING → PLANNING → AWAITING_APPROVAL → EXECUTING`. */
  private async implementSubtask(
    plan: PlanOutline,
    subtask: PlanSubtask,
    index: number,
    total: number,
    completed: readonly string[]
  ): Promise<{ kind: "ok" } | { kind: "final"; result: FinalResult }> {
    const decision = this.approvedGrades.find((g) => g.subtaskId === subtask.subtaskId);
    const grade: ModelGrade = decision?.final ?? "frontier";

    await this.transition("IMPLEMENTING");
    const picked = this.adapterForGrade(grade);
    if (picked.kind === "none") {
      return { kind: "final", result: await this.finish("failed", picked.reason, "provider_config_error") };
    }
    let adapter = picked.adapter;

    // **`snapshotForPrompt()`를 지난다.** 서브태스크는 순차로 돌고 앞 조각이 이미 파일을
    // 바꿔 놓았다 — `this.snapshot`을 그대로 주면 후속 모델이 **패치 전 내용**을 보고 patch를
    // 만들고, 그 patch는 적용에 실패하거나 앞 조각을 덮어쓴다. 순차로 돌리는 이유의 절반이
    // 여기서 사라진다.
    const implSnapshot = await this.snapshotForPrompt();
    const drafted = await this.callProvider(adapter, "executor", `impl:${subtask.subtaskId}`, (ctx) =>
      adapter.generateDraft(
        {
          snapshot: implSnapshot,
          userMessage: this.input.taskRequest.userMessage,
          ...(this.answers.length > 0 ? { userAnswers: [...this.answers] } : {}),
          acceptanceCriteria: this.criteriaForPrompt(),
          subtask: {
            intent: subtask.intent,
            files: subtask.files,
            index: index + 1,
            total,
            planSummary: plan.summary,
            completedIntents: [...completed],
          },
        },
        ctx
      )
    );
    if (drafted.kind === "final") return drafted;
    let proposal = drafted.value;
    this.implementerProviders.add(adapter.providerId);

    // ---- 에스컬레이션 (72.10.2절) ----
    const escalated = await this.maybeEscalate(proposal, subtask, grade, plan, index, total, completed);
    if (escalated.kind === "final") return escalated;
    if (escalated.kind === "replaced") {
      proposal = escalated.proposal;
      adapter = escalated.adapter;
      this.implementerProviders.add(adapter.providerId);
    }

    await this.emitDraftReceived(proposal, {
      replayed: false,
      primary: true,
      // **`criteria`를 넘기지 않는다**(72.2.2절). 넘기면 `acceptanceCriteriaReplaces`가 붙어
      // 서브태스크 N개가 서로의 기준을 차례로 덮어쓰고 체크리스트에 마지막 하나만 남는다.
    });

    const mcp = await this.runMcpRound(proposal.mcpCalls);
    if (mcp.kind === "final") return mcp;
    // 도구를 부른 뒤 같은 서브태스크를 다시 구현한다. 상한은 `mcpRounds`가 이미 진다.
    if (mcp.kind === "retry") return this.implementSubtask(plan, subtask, index, total, completed);

    const patch = proposal.patch ?? "";
    const ops = fileOps(proposal);
    if (patch.trim().length === 0 && !hasFileOps(ops)) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `서브태스크 "${subtask.intent}"에 적용할 변경이 없습니다.`,
          "internal_invariant_violated"
        ),
      };
    }

    return this.executeSubtaskPatch(patch, ops, subtask);
  }

  /**
   * 런타임 에스컬레이션 — 72.10.2절. **요청은 모델이, 허락은 카드가, 판정은 여기서.**
   *
   * 봉투를 넘으면 **거절하고 중간에 다시 묻지 않는다.** 그리고 **거절된 요청의 산출물은
   * 그대로 쓴다** — 요청이 산출물에 실려 오므로 판정 시점에 초안은 이미 있고 이미 값을
   * 치렀다. 원래 모델을 다시 부르면 어느 카운터도 세지 않는 호출이 하나 더 생기는데,
   * **거절이 비용을 만드는 셈**이 된다.
   *
   * **거절도 이벤트로 남는다.** 남기지 않으면 "요청이 없었다"와 구별되지 않고, 72.14절의
   * 계측이 분모 셋(요청/호출/거절) 중 하나를 잃는다 — 그러면 남발이 상한에 가려 보이지 않는다.
   */
  private async maybeEscalate(
    proposal: DraftProposal,
    subtask: PlanSubtask,
    grade: ModelGrade,
    plan: PlanOutline,
    index: number,
    total: number,
    completed: readonly string[]
  ): Promise<
    | { kind: "none" }
    | { kind: "replaced"; proposal: DraftProposal; adapter: ProviderAdapter }
    | { kind: "final"; result: FinalResult }
  > {
    const request = proposal.escalationRequest;
    const allowance = this.escalationAllowance;
    if (!request || !allowance) return { kind: "none" };

    const verdict = judgeEscalation({
      request,
      allowance,
      calledSoFar: this.state.counters.escalationCalls,
      currentGrade: grade,
      spentUsd: this.budget?.outcome().spentUsd ?? null,
    });

    if (verdict.kind === "rejected") {
      await this.emit("ESCALATION_REJECTED", {
        subtaskId: subtask.subtaskId,
        requestedGrade: request.proposedGrade,
        reason: request.reason,
        rejectedBecause: verdict.reason,
        calledSoFar: this.state.counters.escalationCalls,
        maxCalls: allowance.maxCalls,
        // **그대로 쓴다**는 사실을 payload가 말한다 — 적지 않으면 나중에 "거절 뒤 무엇을
        // 했는가"에 기록이 답하지 못한다.
        proposalUsedAnyway: true,
      });
      return { kind: "none" };
    }

    const picked = this.adapterForGrade(verdict.grade);
    if (picked.kind === "none") {
      await this.emit("ESCALATION_REJECTED", {
        subtaskId: subtask.subtaskId,
        requestedGrade: request.proposedGrade,
        reason: request.reason,
        rejectedBecause: picked.reason,
        proposalUsedAnyway: true,
      });
      return { kind: "none" };
    }

    this.state.counters.escalationCalls += 1;
    const adapter = picked.adapter;
    // 같은 이유로 최신 스냅샷을 쓴다 — 앞 조각의 변경이 이미 디스크에 있다.
    const escSnapshot = await this.snapshotForPrompt();
    const redrafted = await this.callProvider(adapter, "executor", `impl-esc:${subtask.subtaskId}`, (ctx) =>
      adapter.generateDraft(
        {
          snapshot: escSnapshot,
          userMessage: this.input.taskRequest.userMessage,
          ...(this.answers.length > 0 ? { userAnswers: [...this.answers] } : {}),
          acceptanceCriteria: this.criteriaForPrompt(),
          subtask: {
            intent: subtask.intent,
            files: subtask.files,
            index: index + 1,
            total,
            planSummary: plan.summary,
            completedIntents: [...completed],
          },
        },
        ctx
      )
    );
    if (redrafted.kind === "final") return redrafted;

    await this.emit("ESCALATION_CALLED", {
      subtaskId: subtask.subtaskId,
      fromGrade: grade,
      toGrade: verdict.grade,
      reason: request.reason,
      model: adapter.modelId,
      provider: adapter.providerId,
      callNumber: this.state.counters.escalationCalls,
      maxCalls: allowance.maxCalls,
      // **결과를 바꿨는가**(72.14절). 요청이 늘 봉투를 채우는데 결과가 달라진 적이 없으면
      // 그건 신호가 아니라 습관이다.
      changedThePatch: (redrafted.value.patch ?? "").trim() !== (proposal.patch ?? "").trim(),
    });
    return { kind: "replaced", proposal: redrafted.value, adapter };
  }

  /**
   * 서브태스크 하나의 patch를 실행한다 — `PLANNING → (프리플라이트) → AWAITING_APPROVAL → EXECUTING`.
   *
   * **`VERIFYING`이 여기 없다.** 검증은 서브태스크 전부가 끝난 뒤 한 번 돈다(72.11절) —
   * 그래서 서브태스크별 `FIX_LOOP`가 존재하지 않고, 그 곱을 막는 상한도 필요 없다.
   */
  private async executeSubtaskPatch(
    patch: string,
    ops: FileOps | undefined,
    subtask: PlanSubtask
  ): Promise<{ kind: "ok" } | { kind: "final"; result: FinalResult }> {
    await this.transition("PLANNING");
    let plan: ExecutionPlan;
    try {
      plan = buildExecutionPlan({
        taskId: this.taskId,
        patch,
        requestedBy: this.executorRequester(),
        attempt: this.state.counters.fixLoopRounds,
        moves: ops?.moves,
        deletions: ops?.deletions,
      });
    } catch (error) {
      if (error instanceof PlanningError || error instanceof ValidationError) {
        // **서브태스크 경로에는 되돌아갈 초안 루프가 없다.** 여기서 `reviseRounds`를 태우면
        // 실행 전 합의 예산이 조각 개수만큼 곱해진다(72.11절이 막는 바로 그 곱셈). 형태가
        // 잘못된 patch는 이 조각의 실패이고, 되묻는 자리는 뒤의 체크리스트다.
        return {
          kind: "final",
          result: await this.finish(
            "failed",
            `서브태스크 "${subtask.intent}"의 patch를 계획으로 변환하지 못했습니다: ${error.message}`,
            "internal_invariant_violated"
          ),
        };
      }
      throw error;
    }
    await this.emit("PLAN_CREATED", {
      planId: plan.planId,
      subtaskId: subtask.subtaskId,
      toolRequests: plan.toolRequests.map((r) => ({ requestId: r.requestId, tool: r.tool, args: describeArgs(r) })),
      approvalRequired: plan.approvalRequired,
      changedPaths: planPaths(plan),
    });

    const preflight = await this.preflightPlan(plan);
    if (preflight.kind === "final") return preflight;
    if (preflight.kind === "redraft") {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `서브태스크 "${subtask.intent}"의 계획을 게이트가 거부했습니다.`,
          "policy_denied"
        ),
      };
    }

    // **진행바는 `실행`에 머물고 승인 모달이 그 위에 뜬다**(72.2.3절). `AWAITING_APPROVAL`은
    // 이 경로에서 진행바의 칸이 아니다 — 서브태스크마다 반복되므로 칸으로 두면 진행바가
    // 앞뒤로 움직인다. 그러나 phase 자체는 옮긴다: 화면이 승인 모달을 띄울 근거가 이것이다.
    if (plan.approvalRequired) await this.transition("AWAITING_APPROVAL");
    await this.transition("EXECUTING");

    const execution = await this.executePlan(plan);
    if (execution.kind === "final") return execution;
    return { kind: "ok" };
  }

  /**
   * 검증 → C → 검증 체크리스트 — 72.7·72.8절.
   *
   * **`VERIFYING`은 `complexityTier`와 무관하게 항상 실행된다**(원칙 1). C는 그것이
   * **통과한 뒤에만** 돈다 — 깨진 코드에 C를 태우는 것은 돈만 쓴다.
   */
  private async verifyReviewAndConfirm(
    plan: PlanOutline
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "replan" }> {
    for (;;) {
      await this.transition("VERIFYING");
      const report = await this.runVerification("post", this.state.counters.fixLoopRounds);
      this.lastReport = report;
      await this.evaluateCriteriaAgainst(report);

      if (report.overall !== "pass") {
        const handled = await this.handleFailedVerification(report);
        if (handled.kind === "final") return handled;
        continue; // FIX_LOOP를 돌았다 — 다시 검증한다
      }

      // ---- RESULT_REVIEWING (C) ----
      const reviewed = await this.runResultReview(plan, report);
      if (reviewed.kind === "final") return reviewed;

      // ---- AWAITING_USER_VERIFICATION ----
      const confirmed = await this.confirmWithUser(plan, report);
      if (confirmed.kind !== "refix") return confirmed;
      // refix — 체크리스트에서 `FIX_LOOP`로 되돌아간다(72.8 귀환 경로 1).
      const refixed = await this.enterFixLoopFromChecklist(report);
      if (refixed.kind === "final") return refixed;
    }
  }

  /**
   * 검증이 통과하지 못했다 — `FIX_LOOP`를 돌거나 끝낸다.
   *
   * **`fixLoopRounds`는 `FIX_LOOP`에 진입할 때마다 오른다**(72.11절). 종전 정의(*"`VERIFYING`
   * → fail 판정 시"*)로는 72.8절 귀환 경로 1이 **영원히 카운터를 올리지 않는다** — 그 경로는
   * 검증이 **통과한 뒤** 체크리스트에서 돌아오므로 fail 판정을 한 번도 만들지 않기 때문이다.
   */
  private async handleFailedVerification(
    report: VerificationReport
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "fixed" }> {
    if (report.overall === "not_configured" || report.overall === "could_not_run") {
      // 판정할 수 없었던 경우. 통과로 위장하지 않고 실패로도 몰지 않는다 — 고칠 근거가 없다.
      const criteria = this.describeCriteria();
      const explanation =
        report.overall === "not_configured"
          ? "이 프로젝트에서 실행할 수 있는 검증 명령이 없어 **검증되지 않았습니다**."
          : "검증 명령을 **실행하지 못해** 검증되지 않았습니다.";
      if (this.policy.unattended) {
        return {
          kind: "final",
          result: await this.finish(
            "failed",
            `무인 실행이라 ${explanation} 검증되지 않은 결과를 완료로 보고하지 않습니다${criteria ? ` · ${criteria}` : ""}`,
            "unverified_unattended"
          ),
        };
      }
      return {
        kind: "final",
        result: await this.finish("completed", `변경을 적용했으나 ${explanation}${criteria ? ` · ${criteria}` : ""}`),
      };
    }

    for (const check of report.checks) {
      if (check.status === "FAILED" || check.status === "TIMED_OUT") this.failedChecksAlongTheWay.push(check.kind);
    }

    this.state.counters.fixLoopRounds += 1;
    await this.transition("FIX_LOOP");
    if (this.state.counters.fixLoopRounds > this.policy.limits.fixLoopRounds) {
      // **C를 부르지 않고 그대로 사용자에게 올린다**(72.7절) — 실패 원인은 검증 출력이
      // 이미 말하고 있고, 깨진 코드에 C를 태우는 것은 돈만 쓴다.
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `검증이 ${this.policy.limits.fixLoopRounds}회 재시도 후에도 실패했습니다. 변경사항은 그대로 남아 있으며 되돌릴 수 있습니다.`,
          "fix_loop_exhausted"
        ),
      };
    }
    await this.emit("FIX_LOOP_STARTED", {
      attempt: this.state.counters.fixLoopRounds,
      max: this.policy.limits.fixLoopRounds,
      enteredFrom: "verification_failed",
      newlyFailing: report.newlyFailing ?? null,
      preexistingFailures: report.preexistingFailures ?? null,
    });

    const fixed = await this.requestFix(report);
    if (fixed.kind === "final") return fixed;
    return this.applyFixPatch(fixed.patch);
  }

  /**
   * 체크리스트에서 `FIX_LOOP`로 되돌아왔다 — 72.8절 귀환 경로 1.
   *
   * **검증은 통과한 상태다.** 그래서 이 진입은 "검증이 실패해서 온 것"과 구별되어야 하고,
   * 그 구별이 payload에 없으면 집계가 "검증 실패 횟수"로 이것을 센다.
   */
  private async enterFixLoopFromChecklist(
    report: VerificationReport
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "fixed" }> {
    this.state.counters.fixLoopRounds += 1;
    await this.transition("FIX_LOOP");
    if (this.state.counters.fixLoopRounds > this.policy.limits.fixLoopRounds) {
      // **막다른 길을 만들지 않는다**(72.11절). 상한에 걸린 자리가 체크리스트이므로 남는
      // 선택지는 "되돌리고 종료"다 — 그 사실을 말하고 끝낸다.
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `다시 고치기 상한(${this.policy.limits.fixLoopRounds}회)을 다 썼습니다. 변경사항은 그대로 남아 있으며 되돌릴 수 있습니다.`,
          "fix_loop_exhausted"
        ),
      };
    }
    await this.emit("FIX_LOOP_STARTED", {
      attempt: this.state.counters.fixLoopRounds,
      max: this.policy.limits.fixLoopRounds,
      enteredFrom: "verification_checklist",
      newlyFailing: null,
      preexistingFailures: null,
    });
    const fixed = await this.requestFix(report);
    if (fixed.kind === "final") return fixed;
    return this.applyFixPatch(fixed.patch);
  }

  /** fix loop가 낸 patch를 적용한다. 서브태스크 경로와 같은 실행 단계를 지난다. */
  private async applyFixPatch(patch: string): Promise<{ kind: "final"; result: FinalResult } | { kind: "fixed" }> {
    const applied = await this.executeSubtaskPatch(patch, undefined, {
      subtaskId: "fix-loop",
      intent: "검증 실패를 고친다",
      files: [],
      // **가장 높은 등급으로 돈다**(이관 문서 ②). 검증은 태스크 전체에 대해 한 번 돌고,
      // 실패가 어느 서브태스크의 것인지 결정론적으로 가를 수 없다 — 파일 단위 귀속을
      // 시도하면 "계획에 없던 파일"(72.7절 `unplanned`)에 답이 없다. 위험 하한선이 이미
      // "내려가지 않는다"를 정했고, 실패를 고치는 자리에서 그것을 뒤집을 이유가 없다.
      proposedGrade: "frontier",
    });
    if (applied.kind === "final") return applied;
    return { kind: "fixed" };
  }

  /**
   * C — 결과 검토 (72.7절). **코드 리뷰를 하지 않는다.** 범위는 하나다:
   * *"구현된 것이 사용자가 승인한 계획과 일치하는가?"*
   *
   * 범위를 좁히는 것이 이 단계의 설계 전부다. 열어 두면 게이트가 잰 그 자리(완성된 patch를
   * 보는 검수자)로 되돌아가고, 같은 결과를 기대할 이유가 없다.
   *
   * # 구현자 집합으로 **다시** 판정한다
   *
   * 라우터의 배정은 executor 하나만 보고 한 잠정 판정이다(21.6절). 등급별 배정과
   * 에스컬레이션이 실제 구현자를 늘리므로, 여기서 `implementerProviders`로 다시 본다 —
   * 그래서 기록에 `assigned*`와 `actual*`이 둘 다 남는다.
   */
  private async runResultReview(
    plan: PlanOutline,
    report: VerificationReport
  ): Promise<{ kind: "done" } | { kind: "final"; result: FinalResult }> {
    const assigned = this.requireAdapters().resultReviewer;
    const independentOfImplementers = assigned && !this.implementerProviders.has(assigned.providerId);

    if (!assigned || !independentOfImplementers) {
      this.resultReviewRan = false;
      await this.emit("RESULT_REVIEW_COMPLETED", {
        ran: false,
        reason: assigned
          ? `result_review_dropped:implementer_provider(${assigned.providerId}) — 배정된 결과 검토자가 ` +
            "코드를 쓴 공급자에 포함되어 드롭했습니다. 등급별 배정이나 에스컬레이션이 구현자를 " +
            "늘리면 라우터의 잠정 배정이 뒤집힙니다(21.6절 불변식 C)."
          : (this.routing?.appliedPolicies.find((p) => p.startsWith("result_review_dropped")) ??
            "result_review_dropped"),
        assignedResultReviewerModel: this.routing?.assignedResultReviewer?.modelId ?? null,
        actualResultReviewerModel: null,
        implementerProviders: [...this.implementerProviders],
        // **결정론적 절반은 그대로 동작한다**(72.7절) — 체크리스트가 범위 이탈 파일을 낸다.
        deterministicHalfStillRuns: true,
      });
      return { kind: "done" };
    }

    await this.transition("RESULT_REVIEWING");
    if (await this.cancelledHere()) {
      return { kind: "final", result: await this.finish("cancelled", "결과 검토 중 취소됨") };
    }

    const snapshot = await this.snapshotForPrompt();
    // **C는 태스크를 실패시키지 못한다**(72.7절). 그러므로 그 호출은 **선택 호출**이어야
    // 한다 — 필수로 두면 예산 거부·인증 오류·재시도 소진이 그대로 `TASK_FAILED`가 되고,
    // **결정론적 검증을 통과한 결과가 부가 검토자의 가용성 때문에 실패한다.** 그건 원칙 1이
    // 정한 판정 권위를 C에게 넘기는 것과 같다.
    const review = await this.callProviderMaybeOptional(
      assigned,
      "resultReviewer",
      "result-review:1",
      (ctx) =>
      assigned.reviewProposal(
        {
          snapshot,
          userMessage: this.input.taskRequest.userMessage,
          // **C가 보는 것은 원칙적으로 정의된 blind다**(72.7절): 승인된 계획과 최종 diff와
          // 검증 출력과 기준 목록. 주지 않는 것은 계획자의 `interpretation`·`rationale`,
          // B의 검토 서술, 앞 단계 모델의 이름이다.
          //
          // 4.1절이 blind를 철회한 근거는 **"정보를 숨긴 대가"**였는데 — blind는 세 케이스를
          // 전부 REJECT하고 아무것도 만들지 않았다 — **C는 수리하지 않으므로 그 대가가
          // 발생하지 않는다.** 숨기는 것은 모델의 산문이고 보여주는 것은 사용자가 승인한 것이다.
          draft: planAsReviewSubject(plan),
          blind: true,
          acceptanceCriteria: this.criteriaForPrompt(),
        },
        ctx
      ),
      { optionalSample: true }
    );
    if (review.kind === "final") return review;
    if (review.kind === "skipped") {
      // 부르지 못했다. **조용히 넘어가지 않는다** — 체크리스트가 "3자 검토 없이 만들어졌다"를
      // 적어야 하고, 그 근거가 이 이벤트다.
      this.resultReviewRan = false;
      await this.emit("RESULT_REVIEW_COMPLETED", {
        ran: false,
        reason: "result_review_skipped:call_failed — 결과 검토자를 부르지 못했습니다(예산·공급자 오류). 검증은 이미 통과했으므로 태스크를 실패시키지 않습니다(72.7절).",
        assignedResultReviewerModel: this.routing?.assignedResultReviewer?.modelId ?? null,
        actualResultReviewerModel: null,
        implementerProviders: [...this.implementerProviders],
        deterministicHalfStillRuns: true,
      });
      return { kind: "done" };
    }

    this.resultReviewRan = true;
    // **C는 태스크를 실패시키지 못하고, `unverified`를 `verified`로 바꾸지도 못한다**(72.7절).
    // 그래서 verdict를 판정으로 쓰지 않고 지목만 꺼낸다.
    const issues = collectPlanReviewIssues(review.value);
    this.flaggedCriterionIds = matchCriterionIds(issues, this.acceptanceCriteria);

    await this.emit("RESULT_REVIEW_COMPLETED", {
      ran: true,
      model: review.value.model,
      independence: this.routing?.resultReviewIndependence ?? "not_applicable",
      assignedResultReviewerModel: this.routing?.assignedResultReviewer?.modelId ?? null,
      actualResultReviewerModel: assigned.modelId,
      implementerProviders: [...this.implementerProviders],
      // 72.14절 계측: C가 올린 항목 수. 사용자가 그중 몇을 문제로 봤는지는 체크리스트의
      // 답이 말한다.
      raisedCount: issues.length,
      raised: issues,
      flaggedCriterionCount: this.flaggedCriterionIds.length,
      verificationOverall: report.overall,
      // **판정이 아니다**를 payload가 말한다. verdict를 남기되 그것이 태스크의 결말을 바꾸지
      // 않았다는 사실을 같이 적는다 — 적지 않으면 나중에 이 값이 판정으로 읽힌다.
      verdict: review.value.verdict,
      verdictIsAdvisoryOnly: true,
    });
    return { kind: "done" };
  }

  /**
   * 검증 체크리스트 게이트 — 72.8절. 사용자 게이트 ②.
   *
   * **타임아웃이 없다**(72.12절). 무응답은 거부가 아니라 대기이고, 태스크는 앱을 다시 켜도
   * 그 자리에 있다 — 점심 먹으러 간 사이에 작업이 사라지는 것은 사용자가 고른 적 없는 결말이다.
   */
  private async confirmWithUser(
    plan: PlanOutline,
    report: VerificationReport
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "replan" } | { kind: "refix" }> {
    const unplanned = unplannedPaths(plan.filesToChange, this.mutatedPaths);
    // **소진된 선택지를 카드가 말한다**(72.11절). 화면이 그대로 보여주고 누르면 실패하는
    // 것은 *"상한은 반복을 끊으려는 것이지 태스크를 가두려는 것이 아니다"*와 정면으로
    // 어긋난다 — 그리고 그 실패는 사용자가 방금 고른 동작의 결과로 나타난다.
    const refixLeft = this.policy.limits.fixLoopRounds - this.state.counters.fixLoopRounds;
    const replanLeft = this.policy.limits.planRounds - this.state.counters.planRounds;
    const exhausted: string[] = [];
    if (refixLeft <= 0) {
      exhausted.push(
        `다시 고치기 상한(${this.policy.limits.fixLoopRounds}회)을 다 썼습니다 — 이제 승인하거나 되돌리고 종료할 수 있습니다.`
      );
    }
    if (replanLeft <= 0) {
      exhausted.push(
        `계획을 다시 세우는 상한(${this.policy.limits.planRounds}회)을 다 썼습니다 — 이제 승인하거나 되돌리고 종료할 수 있습니다.`
      );
    }

    const card = buildVerificationChecklist({
      criteria: this.acceptanceCriteria,
      evaluations: this.criterionEvaluations,
      flaggedCriterionIds: this.flaggedCriterionIds,
      unplannedPaths: unplanned,
      resultReviewRan: this.resultReviewRan,
      planReviewSkipped: this.planReviewSkipped,
      extraNotes: [...this.unresolvedDisagreements, ...exhausted],
    });

    await this.transition("AWAITING_USER_VERIFICATION");
    const response = await this.requestUserGate({ gate: "verification", taskId: this.taskId, card });
    const settled = await this.settleGateResponse(response, "검증 확인");
    if (settled.kind === "final") return settled;

    switch (settled.choice as VerificationChoice) {
      case "approve": {
        // 검증을 통과한 **뒤에만** 커밋한다(원칙 1). 그리고 사용자 확인 뒤다.
        const commit = await this.maybeCommit(report);
        return { kind: "final", result: await this.finish("completed", this.describeSuccess(report, commit)) };
      }
      case "refix":
        if (refixLeft <= 0) {
          // **실패시키지 않는다.** 다시 물으면 카드가 남은 선택지를 적는다 — 위 `exhausted`가
          // 그 문장이고, 상한에 걸린 자리에서 사용자가 할 수 있는 일이 남아 있어야 한다.
          await this.emit("PHASE_CHANGED_NOTE", {
            note: "다시 고치기 상한을 소진해 더 고칠 수 없습니다 — 승인 또는 되돌리기만 남았습니다",
            fixLoopRounds: this.state.counters.fixLoopRounds,
            max: this.policy.limits.fixLoopRounds,
          });
          return this.confirmWithUser(plan, report);
        }
        return { kind: "refix" };
      case "replan":
        if (replanLeft <= 0) {
          // 같은 이유로 실패시키지 않는다(72.11절).
          await this.emit("PHASE_CHANGED_NOTE", {
            note: "계획을 다시 세우는 상한을 소진했습니다 — 승인 또는 되돌리기만 남았습니다",
            planRounds: this.state.counters.planRounds,
            max: this.policy.limits.planRounds,
          });
          return this.confirmWithUser(plan, report);
        }
        this.state.counters.planRounds += 1;
        // **승인이 무효화된다.** 쟁점과 검토 지문도 함께 버린다 — 새 계획에 옛 지적이 붙으면
        // 사용자가 이미 지나온 자리를 다시 읽는다.
        this.approvedPlan = null;
        this.planReviewIssues = [];
        this.reviewedPlanFingerprint = null;
        this.issuesShownFor = null;
        // **폐기된 계획의 기준을 들고 가지 않는다.** 이벤트 쪽은 다음 승격이
        // `acceptanceCriteriaReplaces: "plan_outline"`으로 대체하지만, 이 배열은 프롬프트와
        // 체크리스트가 직접 읽으므로 여기서도 버려야 한다 — 남기면 사용자가 승인하지 않은
        // 요구가 새 구현에 그대로 실린다. **사용자 판정은 남는다**(출처가 다르다).
        this.acceptanceCriteria = this.acceptanceCriteria.filter((c) => c.source !== "plan_outline");
        return { kind: "replan" };
      case "revert_and_stop": {
        // **터미널은 `REJECTED`다**(72.8절). 사용자가 중단한 것이 아니라 **결과를 거부한
        // 것**이라 `CANCELLED`가 아니고, 실패한 것이 없어 `FAILED`도 아니다.
        //
        // 되돌리기는 Rust가 게이트 왕복 안에서 수행한다 — 파일을 되돌리는 것은 신뢰 경계의
        // 일이고, Node가 "되돌렸다"를 만들어낼 수 없어야 한다(원칙 2).
        //
        // **그래서 여기서 지어내지 않는다.** 응답이 실어 온 결과를 그대로 말한다 —
        // 되돌리지 못한 파일이 있는데 "되돌렸습니다"라고 보고하면, 사용자는 파일이
        // 복원됐다고 믿은 채 바뀐 워크스페이스를 갖게 된다.
        return { kind: "final", result: await this.finishRejected(describeRollback(response)) };
      }
    }
  }

  // ---- `standard` 흐름의 보조 ----

  /**
   * 등급에 맞는 구현 어댑터를 고른다 — 72.10절.
   *
   * 라우터가 잡은 것은 **기본 구현 모델**이다. 서브태스크는 계획의 산출물이라 라우팅 시점에
   * 존재하지 않으므로(72.2.2절), 등급별 배정은 승인 뒤인 여기서 한다.
   */
  private adapterForGrade(
    grade: ModelGrade
  ): { kind: "adapter"; adapter: ProviderAdapter } | { kind: "none"; reason: string } {
    const cached = this.gradeAdapters.get(grade);
    if (cached) return { kind: "adapter", adapter: cached };

    const candidates = this.registry
      .available(this.input.availableProviders, {
        allowOrgVerified: this.deps.routerOptions?.allowOrgVerified,
        ...(this.deps.routerOptions?.enabledCliVendors
          ? { enabledCliVendors: this.deps.routerOptions.enabledCliVendors }
          : {}),
      })
      .filter((e) => e.grade === grade);

    if (candidates.length === 0) {
      // **등급을 못 채우면 기본 구현 모델로 간다.** 태스크를 죽이지 않는 이유는 그 등급이
      // 승인 카드에 적혀 있었기 때문이다 — 사용자가 본 것과 달라졌다는 사실은 이벤트가
      // 말하고, 여기서 멈추면 "쓸 수 있는 모델이 있는데 안 돈다"가 된다.
      const fallback = this.adapters?.executor;
      if (!fallback) return { kind: "none", reason: `등급 ${grade}의 모델도 기본 구현 모델도 없습니다` };
      void this.emit("PHASE_CHANGED_NOTE", {
        note: `등급 ${grade}에 해당하는 모델이 없어 기본 구현 모델(${fallback.modelId})로 진행합니다`,
        grade,
      });
      this.gradeAdapters.set(grade, fallback);
      return { kind: "adapter", adapter: fallback };
    }

    const entry = candidates[0]!;
    try {
      const adapter = createRoleAdapters(
        [
          {
            role: "executor",
            modelId: entry.modelId,
            providerId: entry.providerId,
            reason: `등급 ${grade} 배정(72.10절)`,
          },
        ],
        (modelId) => this.registry.get(modelId),
        this.deps.adapterOptions
      ).executor;
      this.gradeAdapters.set(grade, adapter);
      return { kind: "adapter", adapter };
    } catch (error) {
      return { kind: "none", reason: `등급 ${grade}의 어댑터를 만들지 못했습니다: ${errorMessage(error)}` };
    }
  }

  /** 사용자 게이트 왕복 — **Rust가 소유한다**(72.4절). Node는 "이 카드로 물어 달라"만 말한다. */
  private async requestUserGate(request: UserGateRequestParams): Promise<UserGateResponse> {
    return this.deps.transport.request<UserGateResponse>("gate.userDecision", request);
  }

  /**
   * 게이트 응답에서 선택지를 꺼내거나 태스크를 끝낸다.
   *
   * **`unattended`를 거부로 뭉개지 않는다.** 뭉개면 최종 보고가 "사용자가 거부했다"고
   * 거짓말하는데 사용자는 아무것도 거부한 적이 없다(24절). 그 결과 **Autopilot의 실질
   * 범위가 `simple` 태스크로 좁아진다** — 부작용이 아니라 이 흐름의 정의에서 따라 나온다.
   */
  private async settleGateResponse(
    response: UserGateResponse,
    label: string
  ): Promise<{ kind: "choice"; choice: string } | { kind: "final"; result: FinalResult }> {
    if (response.outcome === "plan" || response.outcome === "verification") {
      return { kind: "choice", choice: response.choice };
    }
    if (response.outcome === "unattended") {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `${label} 게이트에서 멈췄습니다 — 무인 실행에는 승인할 사람이 없습니다. ` +
            "자동 승인하지 않습니다(72.12절): 이 흐름의 사용자 권위가 사라지기 때문입니다.",
          "unattended_stop"
        ),
      };
    }
    // **취소를 실패로 보고하지 않는다.** 게이트에 타임아웃이 없으므로 대기 중인 태스크를
    // 깨우는 유일한 길이 취소이고(72.11절), Rust는 그것을 `Unavailable`로 돌려준다 —
    // 거부로 뭉개지 않기 위해서다. 여기서 실패로 읽으면 사용자가 누른 취소가 "오류"가 된다.
    if (this.cancelRequested || this.abort.signal.aborted) {
      return { kind: "final", result: await this.finish("cancelled", `${label} 대기 중 취소됨`) };
    }
    return {
      kind: "final",
      result: await this.finish(
        "failed",
        `${label} 게이트를 사용자에게 전달하지 못했습니다: ${response.reason}`,
        "internal_invariant_violated"
      ),
    };
  }

  /**
   * 승인된 계획의 완료 기준을 `plan_outline` 출처로 승격한다 — 72.2.1절.
   *
   * **구현 모델의 `doneCriteria`는 승격되지 않는다**(72.2.2절). 이 경로에서 기준을 정한 것은
   * 사용자가 승인한 계획이고, 구현 모델은 그 기준을 **받아서 일하는 쪽**이다.
   */
  private async absorbPlanCriteria(plan: PlanOutline): Promise<void> {
    const texts = [...(plan.doneCriteria ?? []), ...(plan.requiredTests ?? [])];
    const added: AcceptanceCriterion[] = [];
    for (const text of texts) {
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      if (this.acceptanceCriteria.some((c) => c.source === "plan_outline" && c.text === trimmed)) continue;
      added.push({
        criterionId: `${this.taskId}-plan-${this.acceptanceCriteria.length + added.length + 1}`,
        text: trimmed,
        source: "plan_outline",
        decidedAt: new Date().toISOString(),
      });
    }
    if (added.length === 0) return;
    this.acceptanceCriteria.push(...added);
    // **파생 캐시는 이벤트가 갱신한다**(원칙 7). `acceptanceCriteria`가 payload에 있으면
    // Rust가 이벤트를 기록하는 **같은 트랜잭션 안에서** 캐시를 반영한다 — 이벤트 없이
    // 테이블만 갱신하는 경로를 만들지 않기 위한 장치다.
    //
    await this.emit("PHASE_CHANGED_NOTE", {
      note: "승인된 계획의 완료 기준을 기준으로 승격했습니다 (plan_outline)",
      acceptanceCriteria: this.acceptanceCriteria.filter((c) => c.source === "plan_outline"),
      // **이 출처만 대체한다.** 계획을 다시 세우면 옛 계획의 요구는 **철회된 것**인데,
      // 대체하지 않으면 폐기된 계획의 기준이 새 구현 프롬프트와 최종 체크리스트에 계속
      // 남아 사용자가 승인하지 않은 요구를 구현하게 된다.
      //
      // **사용자 판정은 영향을 받지 않는다** — 대체는 `source`별이고(`store.rs`의
      // `sync_acceptance_criteria_tx`), `user_decision`은 다른 칸이다. 72.2.2절이 금지한
      // 것은 **구현 모델의 `DraftProposal`이 기준을 덮는 것**이지 이 자리가 아니다.
      acceptanceCriteriaReplaces: "plan_outline",
    });
  }

  /** 계획자의 등급. 배정이 없으면 `unmeasured`로 본다 — 모르는 것을 좋게 읽지 않는다. */
  private plannerGrade(): ModelGrade {
    const planner = this.routing?.assignments.find((a) => a.role === "planner");
    if (!planner) return "unmeasured";
    return this.registry.get(planner.modelId)?.grade ?? "unmeasured";
  }

  /** effort 손잡이가 없는 배정들 — 21.4절이 요구한 공개. 카드가 이 사실을 적는다. */
  private effortIgnoredBy(): string[] {
    const seen = new Set<string>();
    for (const a of this.routing?.assignments ?? []) {
      const entry = this.registry.get(a.modelId);
      // `effort.kind === "none"`이 **손잡이가 없다**는 뜻이다(21.4절). 엔트리를 못 찾은
      // 경우는 여기 넣지 않는다 — 모르는 것을 "없다"로 적으면 화면이 확인되지 않은 사실을
      // 단언한다.
      if (entry && entry.effort.kind === "none") seen.add(a.modelId);
    }
    return [...seen].sort();
  }

  /**
   * 구현·검토 예산을 **승인 시점에** 잡는다 — 72.12절.
   *
   * 카드가 보여준 금액 그대로를 예약한다. **환산되지 않는 배정은 더하지 않는다** — 0으로
   * 합산하면 카드가 거짓을 말하는 것과 같은 이유로, 예약도 없는 금액을 잡는 셈이 된다.
   *
   * 예약하지 못하면 **여기서 멈춘다.** 승인한 작업이 구현 중간에 돈이 없어 죽는 것보다
   * 시작 전에 이유를 말하는 편이 낫다(`callPlan.ts`가 적은 그 실패). 사용자는 상한을
   * 올리고 다시 시작할 수 있다.
   */
  private async reserveImplementationStage(
    card: PlanApprovalCard
  ): Promise<{ kind: "ok" } | { kind: "final"; result: FinalResult }> {
    // 이미 열려 있으면 닫고 다시 연다 — 금액이 달라졌을 수 있다.
    this.releaseImplementationStage("승인을 다시 받았습니다 — 금액을 다시 잡습니다");
    const envelope = card.escalation.budgetUsd ?? 0;
    const amount = card.estimatedCostUsd + envelope;
    if (amount <= 0) {
      // 계량 과금되는 배정이 없다. **잡을 것이 없는 것과 못 잡은 것은 다르다** —
      // 0을 예약해 "확인했다"로 만들지 않는다.
      return { kind: "ok" };
    }
    const staged = this.budget?.reserveStage(amount, "plan-approval:implementation");
    if (staged && !staged.ok) {
      return {
        kind: "final",
        result: await this.finish(
          "failed",
          `승인하신 계획의 예상 비용을 예산에 잡을 수 없습니다: ${staged.reason}`,
          "budget_exceeded"
        ),
      };
    }
    this.implementationReservation = staged?.reservation ?? null;
    return { kind: "ok" };
  }

  private releaseImplementationStage(reason: string): void {
    if (!this.implementationReservation) return;
    this.budget?.releaseStage(this.implementationReservation, reason);
    this.implementationReservation = null;
  }

  /**
   * 등급 하나의 **서브태스크 한 개분** 추정 비용 — 72.4·72.10절.
   *
   * 라우터의 대표 토큰 수(8k/2k)를 그대로 쓴다: 카드가 보여주는 다른 금액과 **같은 자로**
   * 재야 합이 뜻을 갖는다. `null`은 "0달러"가 아니라 **"금액으로 말할 수 없다"**이고,
   * 카드가 그 둘을 다른 칸에 적는다.
   */
  private implementationCostFor(grade: ModelGrade): number | null {
    const picked = this.adapterForGrade(grade);
    if (picked.kind === "none") return null;
    const cost = this.registry.costOf(picked.adapter.modelId, { inputTokens: 8_000, outputTokens: 2_000 });
    return cost.kind === "usd" ? cost.usd : null;
  }

  private requireRouting(): RoutingDecision {
    if (!this.routing) throw new Error("라우팅이 아직 결정되지 않았습니다");
    return this.routing;
  }

  /** 답을 실어 종료한다. `finish`를 지나므로 "정확히 한 번" 규칙과 취소 경쟁 처리를 공유한다. */
  private async finishAnswered(answer: QuestionAnswer): Promise<FinalResult> {
    this.pendingAnswer = answer;
    return this.finish("answered", answer.answer);
  }

  private async finish(
    status: FinalResult["status"],
    summary: string,
    failureReason?: FailureReason
  ): Promise<FinalResult> {
    // 터미널 이벤트는 **정확히 한 번만** 기록된다. 경쟁하는 두 경로(정상 완료 / 취소)가
    // 모두 여기 도달할 수 있으므로, 먼저 온 쪽이 확정하고 나중 것은 그 결과를 반환한다.
    if (this.terminalReached) {
      return {
        taskId: this.taskId,
        status: this.state.phase === "COMPLETED" ? "completed" : status,
        summary: `(이미 ${this.state.phase}로 종료된 태스크) ${summary}`,
        auditTrailEventIds: this.eventIds,
        completedAt: new Date().toISOString(),
      };
    }

    // **플래그를 await보다 먼저 세운다.** 대조가 켜지면 executor 호출이 동시에 둘 진행되고,
    // 취소되면 둘 다 여기 도달한다. 검사와 표시 사이에 await가 있으면 두 호출이 모두 검사를
    // 통과해 terminal 이벤트가 두 번 남는다 — 실측으로 `TASK_CANCELLED`가 둘 기록됐다.
    // JS는 단일 스레드지만 await가 곧 양보 지점이므로, 이 구간은 동기여야 한다.
    this.terminalReached = true;

    // **열린 단계 예약을 닫는다** — multi-engine 10.7절.
    //
    // 승인 시점에 연 구현 예약은 첫 구현 호출 직전에 닫히지만, **거기 닿지 못하고 끝나는
    // 경로가 있다**: B 호출이 실패하거나 그 사이에 취소되면 예약이 열린 채로 남고,
    // 그러면 터미널 예산 보고와 원장에 **`opened`만 있고 짝이 없는 예약**이 남는다.
    // 10.7절이 `BLOCKED_UNRESOLVED_RESERVATION`으로 막는 상태가 정확히 그것이다.
    //
    // **`released`가 맞다**: 이 예약으로는 아무 요청도 나가지 않았다.
    this.releaseImplementationStage("태스크가 끝나 열린 단계 예약을 닫습니다");

    // 재요청을 유발한 충돌이 결말 없이 사라지지 않게 한다. 결말을 세는 지표는 결말이
    // **빠짐없이** 남을 때만 의미가 있다 — 감지 N건에 결말 M건(M<N)이면 차이가 어디서
    // 났는지 알 수 없고, 그 차이가 하필 실패한 태스크에 몰려 있으면 지표가 낙관 쪽으로 휜다.
    if (this.pendingConflicts !== null) {
      const pending = this.pendingConflicts.conflicts;
      this.pendingConflicts = null;
      await this.emitConflictOutcomes(pending, "task_ended_before_replan");
    }

    // 취소로 끝나는 경우 CANCELLING을 거친다 — UI가 "취소 중"을 보여줄 수 있어야 하고,
    // 이벤트 로그에도 요청 시점과 완료 시점이 남아야 한다.
    if (status === "cancelled" && this.state.phase !== "CANCELLING" && isValidTransition(this.state.phase, "CANCELLING")) {
      await this.transition("CANCELLING");
    }

    const targetPhase: TaskPhase = TERMINAL_OF[status].phase;

    // 터미널 전이가 표에 없는 상태에서 끝나는 경우(예: AWAITING_APPROVAL에서 REJECTED)를
    // 조용히 넘기지 않고 이벤트로 남긴다. 전이가 불가능하면 phase는 그대로 두고
    // final_status만 기록한다 — 이벤트 로그가 진실이므로 그것만으로 상태 설명이 가능하다.
    if (isValidTransition(this.state.phase, targetPhase)) {
      await this.transition(targetPhase);
    } else {
      await this.emit("ERROR", {
        message: `${this.state.phase}에서 ${targetPhase}로의 직접 전이가 정의되지 않아 phase를 유지합니다`,
      });
      await this.emit("PHASE_CHANGED", { from: this.state.phase, to: targetPhase, forced: true });
      this.state.phase = targetPhase;
    }

    const eventType = TERMINAL_OF[status].event;

    const result: FinalResult = {
      taskId: this.taskId,
      status,
      failureReason,
      summary,
      verificationReport: this.lastReport ?? undefined,
      // **답변은 여기 실린다.** `summary`에만 두면 화면이 요약과 답을 구별하지 못하고,
      // 긴 답이 요약 자리에 들어가 목록이 망가진다.
      ...(this.pendingAnswer ? { answer: this.pendingAnswer } : {}),
      ...(this.pendingPlan ? { plan: this.pendingPlan } : {}),
      auditTrailEventIds: this.eventIds,
      // 성공/실패/취소를 가리지 않고 담는다 — 사용자가 무엇을 결정했는지는 결과와 무관한 사실이고,
      // 실패한 태스크야말로 "무엇을 요구했는지"를 다시 보게 되는 자리다.
      acceptanceCriteria: this.acceptanceCriteria.length > 0 ? [...this.acceptanceCriteria] : undefined,
      unresolvedDisagreements:
        this.unresolvedDisagreements.length > 0 ? [...this.unresolvedDisagreements] : undefined,
      criterionEvaluations:
        this.criterionEvaluations.length > 0 ? [...this.criterionEvaluations] : undefined,
      // 성공·실패를 가리지 않고 담는다 — 돈은 결과와 무관하게 나갔고, 실패한 태스크야말로
      // "얼마를 썼나"를 묻게 되는 자리다.
      budget: this.budget?.outcome(),
      completedAt: new Date().toISOString(),
    };
    await this.emit(eventType, {
      status,
      failureReason: failureReason ?? null,
      summary,
      counters: this.state.counters,
      complexityTier: this.state.complexityTier,
      reviewerIndependent: this.routing?.reviewerIndependent ?? false,
      verificationOverall: this.lastReport?.overall ?? null,
      acceptanceCriteriaCount: this.acceptanceCriteria.length,
      // 확인된 기준 수를 이벤트에도 남긴다. 0인 것이 정상 상태라는 사실을 로그가 말해야
      // 나중에 "왜 전부 미확인이었나"를 되짚을 수 있다.
      acceptanceCriteriaVerifiedCount: this.criterionEvaluations.filter((e) => e.status === "VERIFIED_BY_TEST")
        .length,
      unresolvedDisagreementCount: this.unresolvedDisagreements.length,
      budget: this.budget?.outcome() ?? null,
    });
    return result;
  }

  private async finishRejected(reason: string): Promise<FinalResult> {
    return this.finish("rejected", reason);
  }

  /**
   * 검증 통과 후의 커밋 — 12절 "Git commit 자동 생성의 오케스트레이터 통합".
   *
   * # 실패해도 태스크를 실패로 만들지 않는다
   *
   * 코드 변경은 이미 적용됐고 검증도 통과했다. 커밋은 그 위에 얹는 **선택적 마무리**이므로,
   * 사용자가 승인을 거부했거나 git이 실패했다고 해서 성공한 작업을 실패로 뒤집으면 안 된다.
   * 그래서 이 함수는 `PathOutcome`을 돌려주지 않고 **결과를 서술하는 값**만 돌려준다.
   *
   * # 시도 자체를 opt-in으로 두는 이유
   *
   * `allowGitCommit`이 꺼져 있으면 아예 시도하지 않는다. Policy Gate가 어차피 승인을 요구하므로
   * "시도해 보고 거부당하기"도 가능하지만, 그러면 커밋을 원하지 않는 사용자가 **매 태스크마다**
   * 모달을 닫아야 한다. 승인 피로는 승인을 무의미하게 만든다(product-strategy 9.1절).
   */
  private async maybeCommit(report: VerificationReport): Promise<CommitOutcome> {
    if (!this.policy.allowGitCommit) return { kind: "not_requested" };
    if (this.mutatedPaths.length === 0) return { kind: "nothing_to_commit" };

    // git 저장소가 아니면 커밋할 수 없다. 스냅샷이 브랜치를 알아내지 못한 경우가 그렇다.
    const branch = this.snapshot?.gitBranch ?? "(unknown)";
    if (branch === "(unknown)") return { kind: "not_a_repo" };

    const verifiedChecks = report.checks.filter((c) => c.status === "PASSED").map((c) => c.kind);
    let plan: ExecutionPlan;
    try {
      plan = buildCommitPlan({
        taskId: this.taskId,
        changedPaths: this.mutatedPaths,
        message: buildCommitMessage({
          userMessage: this.input.taskRequest.userMessage,
          changedPaths: this.mutatedPaths,
          verifiedChecks,
          // 태스크 하나가 커밋 하나이므로 중간 시도는 이력에 남지 않는다. 그 사실을 감추지
          // 않고 "몇 번 만에 통과했는지"와 전체 기록을 찾아갈 열쇠를 남긴다(19.6절).
          taskId: this.taskId,
          fixLoopRounds: this.state.counters.fixLoopRounds,
          failedChecks: this.failedChecksAlongTheWay,
        }),
        requestedBy: this.executorRequester(),
      });
    } catch (error) {
      return { kind: "failed", reason: errorMessage(error) };
    }

    await this.emit("PLAN_CREATED", {
      planId: plan.planId,
      toolRequests: plan.toolRequests.map((r) => ({ requestId: r.requestId, tool: r.tool, args: describeArgs(r) })),
      approvalRequired: plan.approvalRequired,
      // 이 계획은 파일을 바꾸지 않는다. 그래서 phase도 EXECUTING으로 옮기지 않는다(아래 주석).
      purpose: "git_commit",
    });

    // **phase를 옮기지 않는다.** VERIFYING → EXECUTING 전이를 열면 그 뒤 COMPLETED로 가기 위해
    // 다시 VERIFYING을 거쳐야 하는데(전이 표), 커밋은 추적 파일의 **내용을 바꾸지 않으므로**
    // 두 번째 검증은 같은 결과만 낼 수밖에 없다. 순전한 낭비를 만들지 않기 위해 phase는 그대로
    // 두고, 무엇이 실행됐는지는 이벤트가 말한다(원칙 7: 이벤트가 진실의 원천이다).
    let sha: string | null = null;
    for (const request of plan.toolRequests) {
      const { result, policy } = await this.requireBridge().executeRequest(request);
      if (result.status === "ok") {
        if (request.requestId.endsWith("-commit-sha")) sha = readStdout(result.output).trim() || null;
        continue;
      }

      if (result.status === "denied") {
        // 거부는 오류가 아니라 **사용자의 결정**이다. 커밋하지 않고 그대로 완료한다.
        return { kind: "declined", reason: result.error ?? policy.reason };
      }
      return { kind: "failed", reason: result.error ?? `git 명령이 실패했습니다 (${request.requestId})` };
    }

    await this.emit("GIT_COMMIT_CREATED", {
      planId: plan.planId,
      branch,
      paths: [...this.mutatedPaths],
      verifiedChecks,
      // **sha가 없으면 되돌리기가 이 커밋을 특정할 수 없다.** null인 것은 실패가 아니라
      // "확인하지 못했다"이며, 그 경우 커밋 되돌리기는 제안되지 않는다(추측으로 이력을
      // 건드리지 않는다).
      sha,
    });
    return { kind: "committed", branch };
  }

  private describeSuccess(report: VerificationReport, commit: CommitOutcome = { kind: "not_requested" }): string {
    const passed = report.checks.filter((c) => c.status === "PASSED").map((c) => c.kind);
    const notConfigured = report.checks.filter((c) => c.status === "NOT_CONFIGURED").map((c) => c.kind);
    const parts = [`검증 통과 (${passed.join(", ") || "실행된 체크 없음"})`];
    if (notConfigured.length > 0) {
      // 통과한 것과 애초에 없던 것을 섞어 말하지 않는다.
      parts.push(`미설정: ${notConfigured.join(", ")}`);
    }
    if ((report.preexistingFailures ?? []).length > 0) {
      parts.push(`변경 전부터 실패 중: ${(report.preexistingFailures ?? []).join(", ")}`);
    }
    if (this.state.counters.fixLoopRounds > 0) {
      parts.push(`수정 재시도 ${this.state.counters.fixLoopRounds}회`);
    }
    if (!this.routing?.reviewerIndependent && this.state.complexityTier === "standard") {
      // 5절: 독립 검수 없이 진행했다는 사실을 성공 요약에서도 감추지 않는다.
      parts.push("교차검증 없이 진행됨(독립 공급자 없음)");
    }
    // 17.3절 구멍 3: build/test/lint만 요약하면 사용자가 무엇을 결정했는지가 최종 보고에서 사라진다.
    const criteria = this.describeCriteria();
    if (criteria) parts.push(criteria);
    // 17.4절: 질문 예산이 모자랐다는 사실을 성공 요약에서 숨기지 않는다.
    if (this.unresolvedDisagreements.length > 0) {
      parts.push(`묻지 못한 쟁점 ${this.unresolvedDisagreements.length}건`);
    }
    const committed = describeCommit(commit);
    if (committed) parts.push(committed);
    return parts.join(" · ");
  }

  private requireSnapshot(): WorkspaceSnapshot {
    if (!this.snapshot) throw new Error("snapshot이 아직 만들어지지 않았습니다");
    return this.snapshot;
  }

  /**
   * **모델에게 보낼 스냅샷은 반드시 이걸 지난다.** 도구가 파일을 바꿨으면 내용을 다시 읽는다.
   *
   * 이 접근자가 없던 동안 FIX_LOOP는 패치 **이전**의 파일을 실어 보내면서 프롬프트로는
   * "당신의 변경이 이미 반영되어 있다"고 말하고 있었다. 모델은 자기가 고친 적 없는 코드를 보고
   * 고쳤고, 그 결과 패치는 문맥이 어긋나 적용에 실패하거나 직전 변경을 되돌렸다.
   *
   * 다시 읽기에 실패하면 **옛 스냅샷을 그대로 쓴다.** 낡은 컨텍스트는 나쁘지만, 컨텍스트 없이
   * 부르는 것보다는 낫고 태스크를 여기서 세울 이유는 없다 — 다만 그 사실을 이벤트로 남긴다.
   */
  /**
   * `SNAPSHOT_CREATED`의 payload.
   *
   * **한 곳에서 만든다.** 이 payload가 전송 화면의 재료이고(transmission.rs가 마지막
   * 스냅샷 이벤트를 읽는다), 스냅샷을 내는 자리가 늘 때마다 필드를 손으로 맞추면 어느
   * 자리에서는 **나간 것을 나가지 않았다고** 말하게 된다.
   */

  // ---- MCP 도구 라운드 (state-machine 31절) ----

  /**
   * 초안이 요청한 MCP 도구를 실행하고, 결과를 스냅샷에 얹어 **DRAFTING을 다시 돌게 한다.**
   *
   * # 왜 초안을 버리는가
   *
   * 도구를 요청한 초안의 `patch`는 아직 없는 결과를 전제로 쓰여 있다. 그걸 그대로 쓰면
   * 모델이 "조회한 뒤에 정하겠다"고 말한 것을 우리가 무시하는 셈이 된다. 재질문 왕복과
   * 같은 모양이다 — 답을 받고 처음부터 다시 그린다.
   *
   * # 왜 primary의 요청만 실행하는가
   *
   * 대조 실행에서는 초안이 둘이고 각자 다른 도구를 요청할 수 있다. 둘 다 실행하면 승인이
   * 두 배가 되고, **부수효과가 있는 도구라면 두 번 일어난다.** 그리고 두 실행자가 서로 다른
   * 결과를 보게 되어 "같은 입력을 받는다"(13.1절)가 깨진다. 그래서 primary만 부르고, 그
   * 결과는 다음 라운드에서 **둘 다** 본다.
   *
   * # 상한에 걸리면 실패시키지 않는다
   *
   * 도구 없이도 초안은 나올 수 있다. 상한을 알리고 한 번 더 요청하며, 그 뒤로도 도구를
   * 요청하면 그 요청을 무시하고 진행한다 — 그래야 이 루프가 끝난다(원칙 5).
   */
  private async runMcpRound(
    calls: readonly McpCallRequest[] | undefined
  ): Promise<{ kind: "none" } | { kind: "retry" } | { kind: "final"; result: FinalResult }> {
    if (!calls || calls.length === 0) return { kind: "none" };

    if (this.state.counters.mcpRounds >= this.policy.limits.mcpRounds) {
      if (this.mcpBudgetNoticeSent) {
        // 이미 알렸는데 또 요청했다. **무시하고 진행한다** — 여기서 다시 재요청하면
        // 종료 논증이 사라진다. 무시했다는 사실은 로그에 남는다.
        await this.emit("ERROR", {
          stage: "DRAFTING",
          message: `MCP 도구 요청 ${calls.length}건을 무시하고 진행합니다 (라운드 상한 ${this.policy.limits.mcpRounds} 소진)`,
        });
        return { kind: "none" };
      }
      this.mcpBudgetNoticeSent = true;
      await this.applyMcpResults(
        `(No tools were run: the tool-call budget for this task is spent — ${this.state.counters.mcpRounds} of ${this.policy.limits.mcpRounds} rounds used.\n` +
          "Do not request more tools. Produce a patch with what you already have.)",
        0
      );
      return { kind: "retry" };
    }

    // **한 라운드에 부를 수 있는 개수에 상한이 있다**(원칙 5). 없으면 초안 하나가 50건을
    // 요청할 수 있고, 승인 모달이 50번 뜨며 프롬프트가 그만큼 자란다.
    const running = calls.slice(0, MAX_MCP_CALLS_PER_ROUND);
    const dropped = calls.length - running.length;
    const rendered: string[] = [];
    for (const [index, call] of running.entries()) {
      if (await this.cancelledHere()) {
        return { kind: "final", result: await this.finish("cancelled", "MCP 도구 실행 중 취소됨") };
      }
      const outcome = await this.runOneMcpCall(call, index);
      if (outcome.kind === "final") return outcome;
      rendered.push(outcome.text);
    }
    if (dropped > 0) {
      // **버린 것을 말한다.** 말하지 않으면 모델은 그 호출이 아무 결과도 내지 않은 것으로
      // 읽고, 없는 결과를 전제로 patch를 쓴다.
      rendered.push(
        `### (not run)\n${dropped} more call(s) were requested but not run — at most ${MAX_MCP_CALLS_PER_ROUND} per round.`
      );
      await this.emit("ERROR", {
        stage: "DRAFTING",
        message: `MCP 도구 요청 ${dropped}건을 실행하지 않았습니다 (라운드당 상한 ${MAX_MCP_CALLS_PER_ROUND})`,
      });
    }

    this.state.counters.mcpRounds += 1;
    await this.applyMcpResults(rendered.join("\n\n"), running.length);
    return { kind: "retry" };
  }

  private async runOneMcpCall(
    call: McpCallRequest,
    index: number
  ): Promise<{ kind: "text"; text: string } | { kind: "final"; result: FinalResult }> {
    const bridge = this.requireBridge();
    const request: ToolRequest = {
      requestId: `${this.taskId}-mcp-${this.state.counters.mcpRounds + 1}-${index}`,
      taskId: this.taskId,
      tool: "mcp_call",
      args: { server: call.server, tool: call.tool, arguments: call.arguments },
      requestedBy: { role: "executor", modelId: this.routing?.assignments.find((a) => a.role === "executor")?.modelId ?? "(unknown)" },
      // Node의 1차 분류일 뿐이다. **최종 판정은 Rust이고 이 도구는 정책으로 낮출 수 없다**(23.3절).
      riskTier: "user_approval",
      createdAt: new Date().toISOString(),
    };

    const { result, policy } = await bridge.executeRequest(request);

    if (result.status === "cancelled") {
      return { kind: "final", result: await this.finish("cancelled", `MCP 도구 실행이 취소되었습니다 (${call.server}/${call.tool})`) };
    }
    if (result.status === "denied") {
      // **거부는 태스크의 실패가 아니다.** 사용자가 이 도구를 부르지 말라고 한 것이며,
      // 모델은 그 사실을 알고 다른 안을 낼 수 있어야 한다. 무인 실행의 정지만 예외다 —
      // 거기엔 답할 사람이 없으므로 24절의 결말로 간다.
      if (result.denialKind === "unattended") {
        return {
          kind: "final",
          result: await this.finish(
            "failed",
            `무인 실행 중 MCP 도구 승인 지점에서 멈췄습니다 (${call.server}/${call.tool})`,
            "unattended_stop"
          ),
        };
      }
      return {
        kind: "text",
        text: `### ${call.server}/${call.tool}\nREFUSED: ${result.error ?? policy.reason}\n(The user declined this call. Do not request it again.)`,
      };
    }
    if (result.status !== "ok") {
      // 실패도 결과다 — 재시도하지 않는다. MCP 도구는 부수효과를 가질 수 있고,
      // 실패한 것처럼 보이는 호출이 실제로는 일어났을 수 있다.
      return {
        kind: "text",
        text: `### ${call.server}/${call.tool}\nFAILED: ${result.error ?? "사유 없음"}`,
      };
    }

    // Rust는 `{ server, tool, result }`로 감싸서 준다. **우리 봉투는 벗기되 서버가 준
    // 내용은 요약하지 않는다** — 요약하면 모델이 본 것과 감사 기록이 갈라진다.
    // 모양이 예상과 다르면 통째로 싣는다: 벗기지 못한 것을 벗긴 척하지 않는다.
    const raw = result.output as { result?: unknown } | string | null | undefined;
    const inner = typeof raw === "object" && raw !== null && "result" in raw ? raw.result : raw;
    const body = typeof inner === "string" ? inner : JSON.stringify(inner ?? null);
    return { kind: "text", text: `### ${call.server}/${call.tool}\n${boundMcpBody(body)}` };
  }

  /**
   * 도구 결과를 스냅샷에 얹고 **새 스냅샷 이벤트를 낸다.**
   *
   * 이벤트를 내지 않으면 전송 화면은 이 텍스트가 공급자로 나간다는 사실을 말할 수 없다 —
   * 집계는 마지막 `SNAPSHOT_CREATED`를 읽는다(transmission.rs).
   */
  private async applyMcpResults(text: string, callCount: number): Promise<void> {
    const before = this.requireSnapshot();
    const previous = before.mcpResults?.text;
    this.snapshot = {
      ...before,
      // 새 내용은 새 스냅샷이다. id를 물려주면 "지금 무엇이 나가 있는가"에 옛 답이 남는다.
      snapshotId: `snap-mcp-${this.state.counters.mcpRounds}-${before.snapshotId}`,
      // 앞 라운드의 결과를 지우지 않는다 — 지우면 모델이 이미 본 것을 다시 요청한다.
      mcpResults: {
        text: previous ? `${previous}\n\n${text}` : text,
        callCount: (before.mcpResults?.callCount ?? 0) + callCount,
      },
      createdAt: new Date().toISOString(),
    };
    await this.emit("SNAPSHOT_CREATED", snapshotPayload(this.snapshot));
  }

  private async snapshotForPrompt(): Promise<WorkspaceSnapshot> {
    if (!this.snapshotStale) return this.requireSnapshot();
    // 검사와 대입 사이에 `await`가 없다 — 동시 호출 둘이 각자 다시 읽으면 두 모델이 다른
    // 스냅샷을 받는다.
    this.refreshingSnapshot ??= this.doRefreshSnapshot();
    return this.refreshingSnapshot;
  }

  private async doRefreshSnapshot(): Promise<WorkspaceSnapshot> {
    const before = this.requireSnapshot();
    try {
      const refreshed = await this.contextEngine.refreshSnapshot(
        this.requireBridge(),
        before,
        this.mutatedPaths
      );
      this.snapshot = refreshed.snapshot;
      this.snapshotStale = false;
      // 새 스냅샷은 새 전송이다. 전송 기록이 마지막 `SNAPSHOT_CREATED`를 읽으므로
      // (core/src/transmission.rs), 이 이벤트를 빠뜨리면 화면은 옛 목록을 계속 보여준다.
      await this.emit("SNAPSHOT_CREATED", {
        ...snapshotPayload(refreshed.snapshot),
        // 무엇이 달라져서 다시 만들었는지. 이게 없으면 같은 태스크에 SNAPSHOT_CREATED가
        // 여러 개 남은 이유를 로그만 보고는 알 수 없다.
        refreshedAfterMutation: {
          changed: refreshed.changed,
          added: refreshed.added,
          removed: refreshed.removed,
          // 비어 있지 않으면 이 스냅샷의 그 파일들은 **낡은 내용**이다.
          unreadable: refreshed.unreadable,
        },
      });
      return refreshed.snapshot;
    } catch (error) {
      await this.emit("SNAPSHOT_REFRESH_FAILED", {
        error: error instanceof Error ? error.message : String(error),
        mutatedPaths: [...this.mutatedPaths],
      });
      return before;
    } finally {
      this.refreshingSnapshot = null;
    }
  }

  private requireAdapters(): RoleAdapters {
    if (!this.adapters) throw new Error("어댑터가 아직 만들어지지 않았습니다");
    return this.adapters;
  }

  private requireBridge(): ToolBridge {
    if (!this.bridge) throw new Error("ToolBridge가 아직 만들어지지 않았습니다");
    return this.bridge;
  }
}

/**
 * 커밋 시도의 결과. **성공/실패 두 값이 아닌 이유**: "요청되지 않음"과 "거부됨"과 "실패"는
 * 사용자에게 전혀 다른 사실이고, 뭉치면 최종 보고가 "커밋 안 됨"이라고만 말하게 된다.
 */
type CommitOutcome =
  | { kind: "not_requested" }
  | { kind: "not_a_repo" }
  | { kind: "nothing_to_commit" }
  | { kind: "committed"; branch: string }
  | { kind: "declined"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * 최종 요약에 붙일 커밋 한 줄. `not_requested`는 **아무 말도 하지 않는다** —
 * 켜지 않은 기능을 매번 언급하면 요약이 잡음으로 덮인다.
 */
function describeCommit(outcome: CommitOutcome): string | null {
  switch (outcome.kind) {
    case "not_requested":
      return null;
    case "not_a_repo":
      return "git 저장소가 아니어서 커밋하지 않음";
    case "nothing_to_commit":
      return "변경된 파일이 없어 커밋하지 않음";
    case "committed":
      // **되돌리기와의 관계를 명시한다.** 되돌리기는 파일 내용을 복원할 뿐 커밋을 지우지 않는다.
      return `${outcome.branch}에 커밋함 (되돌리기는 파일만 복원하며 커밋은 남는다)`;
    case "declined":
      return `커밋을 승인하지 않아 건너뜀 (${outcome.reason})`;
    case "failed":
      // 실패를 조용히 넘기지 않는다 — 사용자는 커밋됐다고 믿을 수 있다.
      return `커밋 실패: ${outcome.reason}`;
  }
}

/**
 * patch가 표현하지 못하는 파일 조작 — 이동(44절)과 삭제(45절).
 *
 * **둘을 한 값으로 묶는다.** 같은 규칙이 둘 모두에 걸리기 때문이다: *첫 계획에만 싣는다.*
 * 두 번째 계획에서 이동은 `from`이 이미 없어서, 삭제는 지울 파일이 이미 없어서 게이트가
 * 거부하고, 프리플라이트가 거부하면 계획 전체가 서지 않는다(42절). 따로 두면 한쪽만 비우는
 * 실수가 컴파일러에 보이지 않는다 — 그리고 그 실수의 증상은 "모델이 이상한 계획을 냈다"다.
 */
export interface FileOps {
  moves?: FileMove[];
  deletions?: string[];
}

/** 조작이 하나라도 있는가. patch 없는 초안이 성립하는지 판정하는 유일한 자리다. */
function hasFileOps(ops: FileOps): boolean {
  return (ops.moves ?? []).length > 0 || (ops.deletions ?? []).length > 0;
}

/**
 * 검수자의 수정을 반영한 조작 (46절).
 *
 * **`undefined`와 `[]`가 다르다.** 검수자가 말하지 않았으면(`undefined`) 초안의 것을 그대로
 * 싣고, 빈 배열을 보냈으면 하지 않는다. 하나로 뭉개면 아무 말도 하지 않은 검수자가 초안의
 * 삭제를 취소한 것이 되고 — 그러면 사용자가 요청한 삭제가 조용히 사라진다 — 그 반대도 같다.
 *
 * `??`가 그 구별을 그대로 표현한다는 것이 이 함수가 짧은 이유다. 짧다고 인라인하지 않는
 * 이유는, 이 구별을 아는 곳이 하나여야 다음에 조작이 하나 더 늘어도 같은 규칙이 적용되기
 * 때문이다.
 */
function reviewedFileOps(proposal: DraftProposal, decision: ReviewDecision): FileOps {
  return {
    moves: decision.revisedMoves ?? proposal.moves,
    deletions: decision.revisedDeletions ?? proposal.deletions,
  };
}

/** 초안/수정 결과에서 patch 밖 조작만 꺼낸다. 두 경로가 같은 값을 만들도록 한 곳에 둔다. */
function fileOps(source: { moves?: FileMove[]; deletions?: string[] }): FileOps {
  return { moves: source.moves, deletions: source.deletions };
}

/** `gate.userDecision`의 params. Rust의 `UserGateRequest`와 **같은 모양이어야 한다**(72.4절). */
type UserGateRequestParams =
  | { gate: "plan"; taskId: string; card: PlanApprovalCard }
  | { gate: "verification"; taskId: string; card: VerificationChecklistCard };

/**
 * 계획의 **지문** — 72.5절과 같은 재료를 쓴다.
 *
 * B를 다시 부를지(72.11절)와 쟁점을 다시 보여줄지가 이 값으로 갈린다. **실행에 영향을 주는
 * 필드만 넣는다**: 요약과 서술이 바뀌었다고 다시 검토할 이유가 없고, 넣으면 모델이 문장을
 * 다듬을 때마다 B 호출이 하나씩 늘어난다.
 */
function planFingerprint(plan: PlanOutline): string {
  const material = JSON.stringify({
    steps: plan.steps.map((s) => ({ intent: s.intent, files: [...s.files].sort() })),
    filesToChange: [...plan.filesToChange].sort(),
    doneCriteria: [...(plan.doneCriteria ?? [])].sort(),
    requiredTests: [...(plan.requiredTests ?? [])].sort(),
    subtasks: (plan.subtasks ?? []).map((s) => ({
      intent: s.intent,
      files: [...s.files].sort(),
      proposedGrade: s.proposedGrade,
    })),
  });
  // 암호학적 요구가 없다 — 필요한 것은 "같은 계획인가"뿐이고, 이 값은 어디에도 권한을
  // 주지 않는다(승인의 권한은 Rust가 찍는 워크스페이스 지문이 진다).
  let hash = 0;
  for (let i = 0; i < material.length; i += 1) hash = (Math.imul(31, hash) + material.charCodeAt(i)) | 0;
  return `plan-${(hash >>> 0).toString(16).padStart(8, "0")}-${material.length}`;
}

/**
 * 계획을 검토 어댑터가 받는 모양으로 감싼다 — B와 C가 같은 `reviewProposal` 입구를 쓴다.
 *
 * **patch 자리는 비어 있다.** 계획에는 patch가 없고(53.5절), 있는 척하면 검토자가 없는
 * 코드를 판정한다. 그래서 `plan`에 단계를 싣고 `doneCriteria`·`requiredTests`를 그대로 옮긴다 —
 * 검토 대상이 **계획**이라는 사실이 payload에서 드러나야 한다.
 */
function planAsReviewSubject(plan: PlanOutline, grades: readonly GradeDecision[] = []): DraftProposal {
  const finalGrade = new Map(grades.map((g) => [g.subtaskId, g]));
  return {
    taskId: plan.taskId,
    proposalId: `${plan.taskId}-plan`,
    interpretation: plan.summary,
    relevantFiles: plan.filesToChange.map((path) => ({ path, reason: "계획이 건드릴 것으로 본 파일" })),
    /**
     * **서술 뒤에 실행 단위를 붙인다** — 72.6절이 *"검토 항목에 분해와 등급 배정을 명시적으로
     * 포함한다"*고 정했기 때문이다. 거기서 돈과 품질이 동시에 결정되는데, 보여주지 않으면
     * **그 결정만 검토 밖에 남는다.**
     *
     * 등급은 **계산이 끝난 최종 값**이다(72.2.2절) — 모델의 제안이 아니라 clamp와 위험
     * 하한선을 지난 값이어야 B가 검토하는 것이 실제로 돌 배정이 된다.
     */
    plan: [
      ...plan.steps.map((step, i) => ({
        stepId: `plan-step-${i + 1}`,
        description: step.intent,
        targetPaths: step.files,
      })),
      ...(plan.subtasks ?? []).map((subtask) => {
        const decision = finalGrade.get(subtask.subtaskId);
        const risk = decision && decision.riskSegments.length > 0 ? ` · 위험 경로 ${decision.riskSegments.join("·")}` : "";
        return {
          stepId: `subtask:${subtask.subtaskId}`,
          description:
            `[실행 단위] ${subtask.intent} — 배정 등급 ${decision?.final ?? subtask.proposedGrade}` +
            (decision && decision.final !== decision.proposed ? ` (계획 제안 ${decision.proposed})` : "") +
            risk,
          targetPaths: subtask.files,
        };
      }),
    ],
    risks: plan.risks,
    requiredTests: plan.requiredTests ?? [],
    uncertainties: plan.openQuestions,
    doneCriteria: plan.doneCriteria ?? [],
    model: plan.model,
    createdAt: plan.createdAt,
  };
}

/**
 * 검토 결과에서 **쟁점만** 꺼낸다 — 72.6·72.7절.
 *
 * **verdict를 판정으로 쓰지 않는다.** B의 산출물은 verdict가 아니라 쟁점 목록이고(72.6절),
 * C는 태스크를 실패시키지 못한다(72.7절). 모델이 판정하지 않고 쟁점을 발굴한다는
 * product-strategy 16절 그대로다.
 *
 * `ACCEPT`이면서 할 말이 있는 경우도 있으므로 verdict로 걸러내지 않는다 — 걸러내면 "괜찮은데
 * 이건 봐 두세요"가 사라진다.
 */
function collectPlanReviewIssues(decision: ReviewDecision): string[] {
  const issues: string[] = [];
  for (const q of decision.questionsForUser ?? []) {
    const t = q.trim();
    if (t.length > 0) issues.push(t);
  }
  if (decision.rejectionReason && decision.rejectionReason.trim().length > 0) {
    issues.push(decision.rejectionReason.trim());
  }
  // `ACCEPT`의 rationale은 "문제 없음"인 경우가 대부분이라 쟁점으로 올리지 않는다.
  if (decision.verdict !== "ACCEPT" && decision.rationale.trim().length > 0) {
    issues.push(decision.rationale.trim());
  }
  return [...new Set(issues)];
}

/**
 * C가 올린 쟁점이 **어느 기준을 지목했는가** — 72.8절의 `flagged_by_review`.
 *
 * 텍스트 포함으로 잇는다. 모델에게 기준 id를 달라고 하면 없는 id를 지어내고, 그러면 화면이
 * 존재하지 않는 항목을 경고한다. **이을 수 없으면 잇지 않는다** — 지목되지 않은 기준은
 * `unverified`로 남고, 그건 거짓이 아니다.
 */
function matchCriterionIds(issues: readonly string[], criteria: readonly AcceptanceCriterion[]): string[] {
  const matched = new Set<string>();
  const haystack = issues.map((i) => i.toLowerCase());
  for (const c of criteria) {
    const needle = c.text.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (haystack.some((i) => i.includes(needle))) matched.add(c.criterionId);
  }
  return [...matched];
}

/**
 * 되돌리기 결과를 **관측된 것만으로** 문장으로 만든다 — 72.8절 귀환 경로 3.
 *
 * Rust가 실제로 무엇을 복원했는지가 응답에 실려 온다. **지어내지 않는다**: 결과가 없으면
 * "되돌렸다"고 말하지 않고, 실패한 파일이 있으면 그 수를 말한다.
 */
function describeRollback(response: UserGateResponse): string {
  const base = "사용자가 결과를 거부했습니다";
  if (response.outcome !== "verification") return base;
  const rollback = response.rollback;
  if (!rollback) {
    // 되돌리기 결과가 오지 않았다. **"되돌렸다"고 말하지 않는다** — 옛 호스트이거나
    // 배선이 끊긴 경우이고, 둘 다 "복원됐다"의 근거가 아니다.
    return `${base}. 변경은 그대로 남아 있을 수 있습니다 — 되돌리기 결과를 받지 못했습니다.`;
  }
  const restored = Array.isArray(rollback.restored) ? rollback.restored.length : 0;
  const failed = Array.isArray(rollback.failed) ? rollback.failed.length : 0;
  if (rollback.ok === false || failed > 0) {
    const reason = rollback.reason ? ` (${rollback.reason})` : "";
    return `${base}. 파일 ${restored}개를 되돌렸고 ${failed}개는 되돌리지 못했습니다${reason}.`;
  }
  return `${base}. 변경한 파일 ${restored}개를 되돌렸습니다.`;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

type PathOutcome =
  // **이동과 삭제는 patch와 함께 나온다**(44·45절). unified diff가 둘 다 표현하지 못하므로
  // 따로 나르되, 같은 초안에서 나온 것이라는 사실이 타입에 남아야 한다 — 따로 두면 되돌아갔을
  // 때 낡은 초안의 조작이 새 patch에 붙는다.
  | { kind: "patch"; patch: string; ops?: FileOps }
  | { kind: "retry" }
  | { kind: "final"; result: FinalResult };

/** `run_command` 결과에서 stdout만 꺼낸다. 형태가 다르면 빈 문자열이다 — 추측하지 않는다. */
function readStdout(output: unknown): string {
  if (typeof output !== "object" || output === null) return "";
  const stdout = (output as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : "";
}

function describeApplied(output: unknown): string | null {
  // **이 함수는 diff를 만들지 않는다.** Rust는 diff를 돌려주지 않고 이벤트에만 담으므로,
  // 여기서 얻을 수 있는 것은 경로와 크기뿐이다. 한때 이름이 `extractDiff`였고 결과가
  // `appliedDiffs`에 쌓여 FIX_LOOP 프롬프트에 ```diff 블록으로 실렸다 — 모델은 "당신이 적용한
  // 변경"이라는 제목 아래 바이트 수 한 줄을 받았다(3.2절). 이름이 거짓말을 하면 소비자가
  // 없는 것을 있다고 믿는다.
  if (typeof output !== "object" || output === null) return null;
  const record = output as { path?: unknown; bytesBefore?: unknown; bytesAfter?: unknown };
  if (typeof record.path !== "string") return null;
  return `# applied to ${record.path} (${String(record.bytesBefore)} → ${String(record.bytesAfter)} bytes)`;
}

/**
 * 이 계획이 건드리는 워크스페이스 상대 경로.
 *
 * patch 본문을 다시 파싱하지 않고 **ToolRequest에서 읽는다** — planner가 이미 파일별로 쪼개
 * 경로를 명시했고(planner.ts), 같은 사실을 두 곳에서 계산하면 어긋날 수 있다.
 */
function describeArgs(request: { tool: string; args: Record<string, unknown> }): Record<string, unknown> {
  const { patch, content, ...rest } = request.args as { patch?: string; content?: string };
  return {
    ...rest,
    ...(typeof patch === "string" ? { patchBytes: patch.length } : {}),
    ...(typeof content === "string" ? { contentBytes: content.length } : {}),
  };
}

function providerFailureMessage(normalized: { kind: string; message: string }): string {
  switch (normalized.kind) {
    case "auth":
      return `공급자 인증에 실패했습니다. API 키를 확인하세요. (${normalized.message})`;
    // **키를 의심하게 만들지 않는다.** 요청이 반려된 것이므로 고칠 곳은 우리가 보낸 요청이다.
    case "rejected":
      return `공급자가 요청을 반려했습니다 (요청 형식·크기·파라미터를 확인하세요). ${normalized.message}`;
    case "model_unavailable":
      // gpt-5 사건: 키는 유효하지만 그 모델을 쓸 수 없다. 사용자가 할 일이 다르므로 구별해 알린다.
      return `이 자격증명으로는 해당 모델을 사용할 수 없습니다 (조직 인증 필요 또는 모델 미지원). ${normalized.message}`;
    case "rate_limit":
      return `공급자 rate limit을 재시도 상한까지 만났습니다. 잠시 후 다시 시도하세요. (${normalized.message})`;
    case "timeout":
      return `공급자 호출이 타임아웃되었습니다. (${normalized.message})`;
    case "schema_violation":
      return `모델 응답이 요구한 스키마를 만족하지 않습니다: ${normalized.message}`;
    default:
      return `공급자 호출에 실패했습니다: ${normalized.message}`;
  }
}

/**
 * AbortError 판정. SDK와 fetch가 취소를 이 형태로 던진다.
 * 취소를 일반 오류로 분류하면 재시도 정책이 사용자 의사를 무시하고 다시 호출한다.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if (error.name === "ProviderCallFailed" && error instanceof ProviderCallFailed) {
      return error.normalized.kind === "cancelled";
    }
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
