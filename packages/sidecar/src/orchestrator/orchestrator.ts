import type {
  AcceptanceCriterion,
  ComplexityTier,
  CriteriaConflictOutcome,
  CriterionEvaluation,
  Disagreement,
  DraftNarrative,
  DraftProposal,
  ExperimentControls,
  ExecutionPlan,
  FailureReason,
  FinalResult,
  RoutingDecision,
  SingleModelFixResult,
  TaskCounters,
  UserDecisionInput,
  TaskPhase,
  TaskPolicy,
  TaskRequest,
  TaskState,
  ToolRequester,
  VerificationReport,
  WorkspaceSnapshot,
  TaskEventType,
} from "@tomverse/protocol";
import { ValidationError } from "@tomverse/protocol";
import { ContextEngine } from "../context/engine.js";
import type { NdjsonTransport } from "../ipc/transport.js";
import { createRoleAdapters, MissingCredentialError, type AdapterFactoryOptions, type RoleAdapters } from "../providers/factory.js";
import {
  asTimeoutError,
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
import { canonicalText, contrastDrafts, fieldLabel, planQuestionRound } from "./contrast.js";
import {
  describeEvaluations,
  evaluateCriteria,
  findCriteriaConflicts,
  type CriteriaConflict,
  type CriteriaContext,
} from "./criteria.js";
import { InvalidTransitionError, isValidTransition } from "./machine.js";
import { buildCommitMessage, buildCommitPlan, buildExecutionPlan, PlanningError } from "./planner.js";
import { triage, type TriagePolicy, type TriageResult } from "../triage.js";
import { BudgetRefused, TaskBudget } from "./budget.js";
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
const BUDGET_EVENT_NAMES: Record<BudgetEventType, TaskEventType> = {
  approval_created: "BUDGET_APPROVAL_CREATED",
  approval_raised: "BUDGET_APPROVAL_RAISED",
  reservation_opened: "BUDGET_RESERVATION_OPENED",
  reservation_released: "BUDGET_RESERVATION_RELEASED",
  reservation_settled: "BUDGET_RESERVATION_SETTLED",
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
  /** 공급자 호출 1회 타임아웃 */
  providerTimeoutMs?: number;
}

export interface RunInput {
  taskRequest: TaskRequest;
  policy: TaskPolicy;
  availableProviders: string[];
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
        reviseRounds: 0,
        fixLoopRounds: 0,
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
    await this.emit("SNAPSHOT_CREATED", {
      snapshotId: this.snapshot.snapshotId,
      gitBranch: this.snapshot.gitBranch,
      gitDirty: this.snapshot.gitDirty,
      // 어떤 파일이 어느 공급자에 갔는지 표시하기 위한 데이터 (README "데이터 전송 투명성").
      relevantFiles: this.snapshot.relevantFiles.map((f) => ({
        path: f.path,
        reason: f.reason,
        reasonDetail: f.reasonDetail,
        truncated: f.truncated,
      })),
      excludedNotes: this.snapshot.excludedNotes ?? [],
      projectMeta: this.snapshot.projectMeta,
    });

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

    // reviewer가 드롭됐으면 활성 역할이 executor 하나이므로 사실상 simple 경로다.
    // routing이 진실의 원천이므로 tier 변수를 다시 쓰지 않고 routing.activeRoles를 본다.
    const crossVerified = this.routing.activeRoles.includes("reviewer");

    // ---- 실행 전 루프: DRAFTING→REVIEWING 또는 SINGLE_MODEL_FIX ----
    //
    // 바깥 루프가 하나 더 있는 이유: PLANNING의 기준 게이트가 초안을 되돌릴 수 있다(17.3절
    // 규칙 1). "기준과 충돌하는 patch는 FIX_LOOP가 아니라 재요청 대상"이므로 실행 이후의
    // 루프가 아니라 **실행 전 경로로** 돌아가야 하고, 그러려면 여기까지 되감을 자리가 필요하다.
    // 상한은 `reviseRounds`가 진다 — 실행 전 합의 실패에 이미 배정된 예산이다.
    for (;;) {
      let patch: string;
      for (;;) {
        if (await this.cancelledHere()) return this.finish("cancelled", "분석 중 취소됨");

        const outcome = crossVerified ? await this.runCrossVerifiedPath() : await this.runSingleModelPath();

        if (outcome.kind === "patch") {
          patch = outcome.patch;
          break;
        }
        if (outcome.kind === "final") {
          return outcome.result;
        }
        // outcome.kind === "retry" — 사용자 답변을 받아 DRAFTING으로 재진입한다.
      }

      // ---- PLANNING → EXECUTING → VERIFYING (fix loop 포함) ----
      const executed = await this.executeAndVerifyLoop(patch);
      if (executed.kind === "final") return executed.result;
      // executed.kind === "redraft" — 기준 게이트가 되돌렸다. 초안부터 다시.
    }
  }

  /** DRAFTING → REVIEWING (교차검증 경로) */
  private async runCrossVerifiedPath(): Promise<PathOutcome> {
    const adapters = this.requireAdapters();
    if (!adapters.reviewer) {
      // 여기 도달하면 라우터의 불변식과 실제 어댑터가 어긋난 것이다 — 조용히 단일 모델로
      // 넘어가지 않고 실패로 드러낸다. "검증한 척"보다 나쁜 것은 "검증했다고 착각하는 코드"다.
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

    // 재요청 사유는 이번 라운드에서 소비했다. 남겨두면 다음 라운드에도 "직전 초안이
    // 거부됐다"가 붙어 이미 고쳐진 문제를 계속 고치라고 말하게 된다.
    this.criteriaFeedback = [];

    // ---- 구조적 대조 ----
    //
    // 별도 phase를 만들지 않는다(17.1절). 대조는 LLM 호출이 아니라 필드 비교 연산이라
    // 사용자에게 노출할 단계가 아니고, 실패할 수 있는 외부 경계도 없다.
    const contrastOutcome = await this.contrastAndMaybeAsk(proposals);
    if (contrastOutcome.kind !== "proceed") return contrastOutcome;

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
          if (patch.trim().length === 0) {
            return {
              kind: "final",
              result: await this.finish(
                "failed",
                "검수자가 초안을 수락했으나 적용할 patch가 없습니다.",
                "internal_invariant_violated"
              ),
            };
          }
          return { kind: "patch", patch };
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
            return { kind: "patch", patch: revised };
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

    switch (result.verdict) {
      case "ACCEPT": {
        const patch = result.patch ?? "";
        if (patch.trim().length === 0) {
          return {
            kind: "final",
            result: await this.finish("failed", "단일 모델이 ACCEPT했으나 patch가 없습니다.", "internal_invariant_violated"),
          };
        }
        return { kind: "patch", patch };
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
    initialPatch: string
  ): Promise<{ kind: "final"; result: FinalResult } | { kind: "redraft" }> {
    let patch = initialPatch;

    for (;;) {
      if (await this.cancelledHere()) return { kind: "final", result: await this.finish("cancelled", "실행 중 취소됨") };

      // ---- PLANNING ----
      await this.transition("PLANNING");
      let plan: ExecutionPlan;
      try {
        plan = buildExecutionPlan({
          taskId: this.taskId,
          patch,
          plan: [],
          requestedBy: this.executorRequester(),
          attempt: this.state.counters.fixLoopRounds,
        });
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
          // Policy Gate 거부 또는 사용자 승인 거부. 재시도하지 않는다 —
          // 같은 요청을 다시 보내는 것은 승인 피로도를 유발하는 것 말고는 하는 일이 없다.
          const denialReason = result.error ?? policy.reason;
          return {
            kind: "final",
            result: await this.finish(
              policy.decision === "deny" ? "failed" : "cancelled",
              `도구 실행이 거부되었습니다 (${request.tool}): ${denialReason}`,
              policy.decision === "deny" ? "policy_denied" : undefined
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
   * 그래서 두 축을 갈라 둘 다 요구한다. tier는 **교차검증**을, 실행 모드는 **대조**를 켠다.
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

    // 사용자가 UI에서 Verified를 고르면 TRIAGE 결과와 무관하게 standard다.
    if (this.policy.executionMode === "verified") {
      appliedPolicies.push("executionMode=verified — 항상 교차검증 경로");
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
    role: "executor" | "reviewer",
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
    role: "executor" | "reviewer",
    callId: string,
    call: (ctx: ProviderCallContext) => Promise<ProviderResponse<T>>,
    options: { optionalSample?: boolean }
  ): Promise<{ kind: "value"; value: T } | { kind: "final"; result: FinalResult } | { kind: "skipped" }> {
    const retryPolicy = this.deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const timeoutMs = this.deps.providerTimeoutMs ?? 120_000;

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
            if (scoped.timedOut()) throw asTimeoutError(error, timeoutMs);
            throw error;
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

  private async recordUsage<T>(
    adapter: ProviderAdapter,
    role: "executor" | "reviewer",
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

    const targetPhase: TaskPhase =
      status === "completed" ? "COMPLETED" : status === "failed" ? "FAILED" : status === "cancelled" ? "CANCELLED" : "REJECTED";

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

    const eventType =
      status === "completed"
        ? "TASK_COMPLETED"
        : status === "failed"
          ? "TASK_FAILED"
          : status === "cancelled"
            ? "TASK_CANCELLED"
            : "TASK_REJECTED";

    const result: FinalResult = {
      taskId: this.taskId,
      status,
      failureReason,
      summary,
      verificationReport: this.lastReport ?? undefined,
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
        snapshotId: refreshed.snapshot.snapshotId,
        gitBranch: refreshed.snapshot.gitBranch,
        gitDirty: refreshed.snapshot.gitDirty,
        relevantFiles: refreshed.snapshot.relevantFiles.map((f) => ({
          path: f.path,
          reason: f.reason,
          reasonDetail: f.reasonDetail,
          truncated: f.truncated,
        })),
        excludedNotes: refreshed.snapshot.excludedNotes ?? [],
        projectMeta: refreshed.snapshot.projectMeta,
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

type PathOutcome =
  | { kind: "patch"; patch: string }
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
function planPaths(plan: ExecutionPlan): string[] {
  const paths = new Set<string>();
  for (const request of plan.toolRequests) {
    const path = (request.args as { path?: unknown }).path;
    if (typeof path === "string" && path.length > 0) paths.add(path);
  }
  return [...paths];
}

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
