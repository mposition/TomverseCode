import type {
  ComplexityTier,
  DraftProposal,
  ExecutionPlan,
  FailureReason,
  FinalResult,
  RoutingDecision,
  SingleModelFixResult,
  TaskCounters,
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
}

interface PendingQuestion {
  questions: string[];
  resolve: (answer: string) => void;
}

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
    this.adapters?.reviewer?.cancel();
    this.pendingQuestion?.resolve("");
    return true;
  }

  get cancellationRequested(): boolean {
    return this.cancelRequested;
  }

  /** 진행 중인 공급자 호출에 전달되는 신호. 테스트가 "실제로 전달됐는가"를 확인한다. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** AWAITING_USER_INPUT에 대한 사용자 답변 전달. */
  provideUserInput(message: string): boolean {
    if (!this.pendingQuestion) return false;
    const pending = this.pendingQuestion;
    this.pendingQuestion = null;
    pending.resolve(message);
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
    const reviewer = adapters.reviewer;
    if (!reviewer) {
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
    const draftCall = `draft:${this.state.counters.clarificationRounds + 1}`;
    const draft = await this.callProvider(adapters.executor, "executor", draftCall, (ctx) =>
      adapters.executor.generateDraft(
        {
          snapshot: this.requireSnapshot(),
          userMessage: this.input.taskRequest.userMessage,
          userAnswers: this.answers.length > 0 ? this.answers : undefined,
        },
        ctx
      )
    );
    if (draft.kind === "final") return draft;
    const proposal: DraftProposal = draft.value;
    await this.emit("DRAFT_RECEIVED", {
      proposalId: proposal.proposalId,
      model: proposal.model,
      interpretation: proposal.interpretation,
      risks: proposal.risks,
      uncertainties: proposal.uncertainties,
      hasPatch: Boolean(proposal.patch && proposal.patch.trim().length > 0),
    });

    // ---- REVIEWING ----
    for (;;) {
      await this.transition("REVIEWING");
      const reviewCall = `review:${this.state.counters.reviseRounds + 1}`;
      const review = await this.callProvider(reviewer, "reviewer", reviewCall, (ctx) =>
        reviewer.reviewProposal(
          {
            snapshot: this.requireSnapshot(),
            userMessage: this.input.taskRequest.userMessage,
            draft: proposal,
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
        return this.finish(
          "completed",
          "변경을 적용했으나 이 프로젝트에서 실행할 수 있는 검증 명령이 없어 **검증되지 않았습니다**. " +
            "build/test/lint 스크립트를 추가하면 다음부터 자동으로 검증됩니다."
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

  private async askUser(questions: string[]): Promise<{ kind: "answered" } | { kind: "final"; result: FinalResult }> {
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
    await this.emit("APPROVAL_REQUESTED_NOTE", { questionsForUser: questions });

    const answer = await new Promise<string>((resolve) => {
      this.pendingQuestion = { questions, resolve };
    });

    if (this.abort.signal.aborted || answer.trim().length === 0) {
      return { kind: "final", result: await this.finish("cancelled", "사용자 확인 대기 중 취소됨") };
    }

    this.answers.push({ question: questions.join("\n"), answer });
    await this.emit("USER_MESSAGE_RECEIVED", { answerLength: answer.length });
    return { kind: "answered" };
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

    // 취소로 끝나는 경우 CANCELLING을 거친다 — UI가 "취소 중"을 보여줄 수 있어야 하고,
    // 이벤트 로그에도 요청 시점과 완료 시점이 남아야 한다.
    if (status === "cancelled" && this.state.phase !== "CANCELLING" && isValidTransition(this.state.phase, "CANCELLING")) {
      await this.transition("CANCELLING");
    }

    this.terminalReached = true;

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
