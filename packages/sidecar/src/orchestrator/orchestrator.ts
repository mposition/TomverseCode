import type {
  AcceptanceCriterion,
  ComplexityTier,
  Disagreement,
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
import { ModelRegistry } from "../routing/registry.js";
import { Router, RoutingError, type RouterOptions } from "../routing/router.js";
import { ToolBridge } from "../tools/bridge.js";
import { buildDigest } from "../verify/digest.js";
import { contrastDrafts, fieldLabel, planQuestionRound } from "./contrast.js";
import { InvalidTransitionError, isValidTransition } from "./machine.js";
import { buildExecutionPlan, PlanningError } from "./planner.js";
import { triageTask, type TriagePolicy } from "../triage.js";

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
  private appliedDiffs: string[] = [];
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
  private pendingQuestion: PendingQuestion | null = null;
  private eventIds: string[] = [];
  /**
   * 터미널에 도달했는지. **완료와 취소가 경쟁할 때 먼저 확정된 쪽만 남긴다**는 규칙의 Node 쪽 절반이다.
   * (다른 절반은 Rust의 `finish_task`가 `WHERE final_status IS NULL`로 원자적으로 처리한다.)
   */
  private terminalReached = false;
  /** 취소가 요청됐는지. abort signal만 보면 타임아웃 abort와 구별되지 않는다. */
  private cancelRequested = false;

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

    // ---- SNAPSHOTTING ----
    await this.transition("SNAPSHOTTING");
    if (await this.cancelledHere()) return this.finish("cancelled", "SNAPSHOTTING 중 취소됨");

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
    await this.emit("TRIAGE_COMPLETED", { complexityTier: tier.tier, appliedPolicies: tier.appliedPolicies });

    // ---- 라우팅 ----
    try {
      this.routing = new Router(this.registry, this.deps.routerOptions).decide({
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
    return this.executeAndVerifyLoop(patch);
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
          ? this.generateDraft(adapters.coExecutor, `draft-co:${round}`)
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
      } else if (co.kind === "final") {
        // 여기서 finish하지 않는다 — 이미 primary 초안이 있으므로 진행할 수 있다.
        // 다만 조용히 넘기지 않는다: 대조를 하지 못했다는 사실이 로그에 남아야
        // "쟁점이 없었다"와 구별된다.
        await this.emit("ERROR", {
          stage: "DRAFTING",
          message: "co-executor 초안 생성에 실패해 이번 라운드는 대조 없이 진행합니다",
        });
      }
    }

    // **기준은 primary 초안에서만 흡수한다.** 두 초안의 doneCriteria를 합치면 사용자가 갈랐다고
    // 알려준 그 두 해석이 나란히 기준 목록에 들어가 서로 모순된다. 대조의 산출물은 기준이
    // 아니라 질문이고, 기준이 되는 것은 사용자의 답이다.
    const draftCriteria = this.absorbDraftCriteria(proposal);
    for (const [index, p] of proposals.entries()) {
      await this.emitDraftReceived(p, {
        replayed: Boolean(replayed),
        primary: index === 0,
        criteria: index === 0 ? draftCriteria : undefined,
      });
    }

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
      const review = await this.callProvider(reviewer, "reviewer", reviewCall, (ctx) =>
        reviewer.reviewProposal(
          {
            snapshot: this.requireSnapshot(),
            userMessage: this.input.taskRequest.userMessage,
            draft: proposal,
            blind,
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
  private async generateDraft(adapter: ProviderAdapter, callId: string): Promise<DraftOutcome> {
    const draft = await this.callProvider(adapter, "executor", callId, (ctx) =>
      adapter.generateDraft(
        {
          snapshot: this.requireSnapshot(),
          userMessage: this.input.taskRequest.userMessage,
          userAnswers: this.answers.length > 0 ? this.answers : undefined,
        },
        ctx
      )
    );
    if (draft.kind === "final") return draft;
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
    const { asked, deferred } = planQuestionRound(report);
    await this.emit("DISAGREEMENT_DETECTED", {
      ...report,
      // 대조를 돌렸는지 자체를 payload가 말해야 한다. proposalIds 길이로도 알 수 있지만,
      // 로그를 읽는 사람이 그 추론을 하도록 두지 않는다.
      contrasted: proposals.length >= 2,
      blockingCount: report.disagreements.filter((d) => d.blocking).length,
      askedCount: asked.length,
      deferredCount: deferred.length,
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
      asked.map((d) => d.question.text),
      asked
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
    const response = await this.callProvider(adapters.executor, "executor", callId, (ctx) =>
      adapters.executor.singleModelFix(
        {
          snapshot: this.requireSnapshot(),
          userMessage: this.input.taskRequest.userMessage,
          userAnswers: this.answers.length > 0 ? this.answers : undefined,
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
  private async executeAndVerifyLoop(initialPatch: string): Promise<FinalResult> {
    let patch = initialPatch;

    for (;;) {
      if (await this.cancelledHere()) return this.finish("cancelled", "실행 중 취소됨");

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
          if (retry.kind === "final") return retry.result;
          patch = retry.patch;
          continue;
        }
        throw error;
      }
      await this.emit("PLAN_CREATED", {
        planId: plan.planId,
        toolRequests: plan.toolRequests.map((r) => ({ requestId: r.requestId, tool: r.tool, args: describeArgs(r) })),
        approvalRequired: plan.approvalRequired,
      });

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
      if (execution.kind === "final") return execution.result;

      // ---- VERIFYING (항상 실행된다 — CLAUDE.md 원칙 1) ----
      await this.transition("VERIFYING");
      const report = await this.runVerification("post", this.state.counters.fixLoopRounds);
      this.lastReport = report;

      if (report.overall === "pass") {
        return this.finish("completed", this.describeSuccess(report));
      }

      // not_verified: 검증 명령이 없어서 판정할 수 없었던 경우.
      // 통과로 위장하지 않고, 실패로도 몰지 않는다 — 고칠 근거(실패 로그)가 없으므로
      // fix loop를 태우는 것은 의미가 없다. 완료로 처리하되 그 사실을 명시한다.
      if (report.overall === "not_verified") {
        // 확정 기준도 함께 말한다. 검증 명령이 없는 프로젝트야말로 "무엇을 요구했는지"만
        // 남는 자리이므로, 여기서 기준을 감추면 보고에 아무 내용이 없게 된다.
        const criteria = this.describeCriteria();
        return this.finish(
          "completed",
          "변경을 적용했으나 이 프로젝트에서 실행할 수 있는 검증 명령이 없어 **검증되지 않았습니다**. " +
            "build/test/lint 스크립트를 추가하면 다음부터 자동으로 검증됩니다." +
            (criteria ? ` · ${criteria}` : "")
        );
      }

      // ---- FIX_LOOP ----
      this.state.counters.fixLoopRounds += 1;
      if (this.state.counters.fixLoopRounds > this.policy.limits.fixLoopRounds) {
        await this.transition("FIX_LOOP");
        return this.finish(
          "failed",
          `검증이 ${this.policy.limits.fixLoopRounds}회 재시도 후에도 실패했습니다. 변경사항은 그대로 남아 있으며 되돌릴 수 있습니다.`,
          "fix_loop_exhausted"
        );
      }

      await this.transition("FIX_LOOP");
      await this.emit("FIX_LOOP_STARTED", {
        attempt: this.state.counters.fixLoopRounds,
        max: this.policy.limits.fixLoopRounds,
        newlyFailing: report.newlyFailing ?? null,
        preexistingFailures: report.preexistingFailures ?? null,
      });

      const fixed = await this.requestFix(report);
      if (fixed.kind === "final") return fixed.result;
      patch = fixed.patch;
    }
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
          const diff = extractDiff(result.output);
          if (diff) this.appliedDiffs.push(diff);
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

    const response = await this.callProvider(
      adapters.executor,
      "executor",
      `fixloop:${this.state.counters.fixLoopRounds}`,
      (ctx) =>
        adapters.executor.continueWithToolResult(
          {
            snapshot: this.requireSnapshot(),
            userMessage: this.input.taskRequest.userMessage,
            appliedDiff: this.appliedDiffs.join("\n"),
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
   * 대조(executor ×2)를 요청할 것인가 — 17.5절 tier 게이팅.
   *
   * `verified` 이상에서만 켠다는 것이 규칙이고, tier가 2단계인 현재는 `standard`가 그 자리다.
   * `simple`에서 켜면 13.1절 스파이크가 측정한 비용 절감이 통째로 사라진다.
   *
   * **실험 하네스에서는 명시적으로 켜지 않는 한 끈다.** 하네스는 arm을 고정해 비교하는데,
   * 호출이 하나 더 생기면 그게 arm 차이인지 대조 때문인지 구별되지 않는다 — 측정 도구가
   * production 경로를 그대로 타되 축은 하네스가 정한다는 원칙(README)의 연장이다.
   */
  private contrastRequested(tier: ComplexityTier): boolean {
    if (tier !== "standard") return false;
    const experiment = this.input.experiment;
    if (!experiment) return true;
    return experiment.contrast === true;
  }

  private decideTier(): { tier: ComplexityTier; appliedPolicies: string[] } {
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
    const tier = triageTask(this.requireSnapshot(), this.input.taskRequest.userMessage, this.deps.triagePolicy);
    return { tier, appliedPolicies };
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
    const retryPolicy = this.deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const timeoutMs = this.deps.providerTimeoutMs ?? 120_000;

    try {
      const { value, attempts } = await callWithRetry(
        async (attempt) => {
          const scoped = withTimeout(this.abort.signal, timeoutMs);
          try {
            const response = await call({ taskId: this.taskId, callId, signal: scoped.signal, timeoutMs });
            await this.recordUsage(adapter, role, callId, response, attempt);
            return response.value;
          } catch (error) {
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
      if (error instanceof ProviderCallFailed) {
        const { normalized, exhausted } = error;
        if (normalized.kind === "cancelled") {
          return { kind: "final", result: await this.finish("cancelled", "공급자 호출 중 취소됨") };
        }
        const reason: FailureReason = exhausted ? "provider_retry_exhausted" : "provider_config_error";
        await this.emit("ERROR", { stage: role, callId, errorKind: normalized.kind, message: normalized.message });
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
    disagreements: Disagreement[] = []
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
      if (!answered.has(d.disagreementId) && decisions.length > 0) {
        // 카드에 띄웠는데 답이 오지 않은 항목 — 조용히 넘기지 않는다.
        this.recordUnresolved(d, "카드에 표시했으나 답변이 오지 않음");
      }
    }

    await this.emit("USER_DECISION_RECORDED", {
      questions,
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
      })),
      acceptanceCriteria: criteria,
    });
  }

  /**
   * `DraftProposal.doneCriteria`를 기준 목록에 흡수한다(17.3절 구멍 1).
   *
   * `DRAFT_SCHEMA`가 required로 강제해서 받아놓고 소비처가 타입 정의뿐이었다 —
   * 요구 분석의 결론이 수집만 되고 버려지고 있었다.
   *
   * **user_decision을 덮지 않는다.** 모델이 낸 기준은 제안이고 사용자가 뒤집을 수 있으므로,
   * 재초안이 와도 갈아치우는 것은 `draft_proposal` 몫뿐이다.
   */
  private absorbDraftCriteria(proposal: DraftProposal): AcceptanceCriterion[] {
    const decidedAt = new Date().toISOString();
    const absorbed: AcceptanceCriterion[] = proposal.doneCriteria
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text, index) => ({
        criterionId: `${proposal.proposalId}-done-${index}`,
        text,
        source: "draft_proposal" as const,
        decidedAt,
      }));
    this.acceptanceCriteria = [
      ...this.acceptanceCriteria.filter((c) => c.source !== "draft_proposal"),
      ...absorbed,
    ];
    return absorbed;
  }

  /**
   * 최종 보고의 기준 체크리스트 한 줄(17.3절 구멍 3 / ui-wireframes 3.10절).
   *
   * **확인된 기준 수를 세지 않고 0으로 고정한다.** 기준↔테스트 자동 연결 방법이 아직 없고,
   * 모델에게 "이 기준이 충족됐나"를 묻는 순간 product-strategy 9절의 순환 의존이 재현된다.
   * "확인하지 못했다"를 "충족했다"로 바꾸는 것이 이 제품이 팔려는 것을 파는 행위다.
   */
  private describeCriteria(): string | null {
    if (this.acceptanceCriteria.length === 0) return null;
    const userDecided = this.acceptanceCriteria.filter((c) => c.source === "user_decision").length;
    const total = this.acceptanceCriteria.length;
    const origin = userDecided > 0 ? `사용자 판정 ${userDecided}개 포함` : "전부 모델 제안";
    return `기준 ${total}개(${origin}) 중 테스트로 확인된 것 0개 · ${total}개 미확인(기준↔테스트 자동 연결 미구현)`;
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

  private async emit(type: string, payload: unknown): Promise<void> {
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
      finalDiff: this.appliedDiffs.length > 0 ? this.appliedDiffs.join("\n") : undefined,
      verificationReport: this.lastReport ?? undefined,
      auditTrailEventIds: this.eventIds,
      // 성공/실패/취소를 가리지 않고 담는다 — 사용자가 무엇을 결정했는지는 결과와 무관한 사실이고,
      // 실패한 태스크야말로 "무엇을 요구했는지"를 다시 보게 되는 자리다.
      acceptanceCriteria: this.acceptanceCriteria.length > 0 ? [...this.acceptanceCriteria] : undefined,
      unresolvedDisagreements:
        this.unresolvedDisagreements.length > 0 ? [...this.unresolvedDisagreements] : undefined,
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
      acceptanceCriteriaVerifiedCount: 0,
      unresolvedDisagreementCount: this.unresolvedDisagreements.length,
    });
    return result;
  }

  private async finishRejected(reason: string): Promise<FinalResult> {
    return this.finish("rejected", reason);
  }

  private describeSuccess(report: VerificationReport): string {
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
    return parts.join(" · ");
  }

  private requireSnapshot(): WorkspaceSnapshot {
    if (!this.snapshot) throw new Error("snapshot이 아직 만들어지지 않았습니다");
    return this.snapshot;
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

type PathOutcome =
  | { kind: "patch"; patch: string }
  | { kind: "retry" }
  | { kind: "final"; result: FinalResult };

function extractDiff(output: unknown): string | null {
  // Rust는 diff를 별도로 돌려주지 않고 이벤트에만 담는다. patch 적용 결과에서
  // 경로 정보만 얻어 delta 요약에 쓴다 — 전체 diff는 git_diff로 다시 얻을 수 있다.
  if (typeof output !== "object" || output === null) return null;
  const record = output as { path?: unknown; bytesBefore?: unknown; bytesAfter?: unknown };
  if (typeof record.path !== "string") return null;
  return `# applied to ${record.path} (${String(record.bytesBefore)} → ${String(record.bytesAfter)} bytes)`;
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
