import { ADAPTER_CONTRACT_VERSION, createAdapter, ProviderCallFailure } from "@tomverse/sidecar/providers";
import type { DraftProposal, ModelEntry, ProjectMeta, WorkspaceSnapshot } from "@tomverse/protocol";
import type { ProbeRole, ProbeTransport, RoleProbeOutcome } from "./probeModels.js";

/**
 * production 어댑터로 probe를 보내는 transport (§3, §8).
 *
 * # 왜 별도 파일인가
 *
 * 이 파일만이 실제 네트워크로 나간다. 테스트는 `probeModels.ts`의 `ProbeTransport`를
 * mock으로 채워 검증하고 **이 파일의 `createAdapterProbeTransport`를 부르지 않는다** —
 * 그래야 `npm test`가 실수로 유료 API를 부를 경로가 아예 없다. (아래 timeout 로직은
 * 어댑터를 주입해 테스트하므로, 그 경로도 네트워크를 타지 않는다.)
 *
 * # 왜 production 어댑터인가
 *
 * probe 전용 HTTP 호출을 따로 만들면 확인한 것이 "공급자가 살아있다"뿐이고, 정작 알고 싶은
 * "우리 어댑터가 이 모델과 구조화 출력까지 동작하는가"는 확인되지 않는다. 그래서
 * `createAdapter`가 만든 그 어댑터의 `generateDraft`/`reviewProposal`을 그대로 부른다.
 */

export { ADAPTER_CONTRACT_VERSION };

/** 역할당 한 번만 부른다는 것을 **구조로** 보장한다. */
export class DuplicateProbeError extends Error {
  constructor(role: ProbeRole) {
    super(`${role} 역할을 두 번 probe하려 했습니다 — 역할당 정확히 1회만 허용합니다`);
    this.name = "DuplicateProbeError";
  }
}

/**
 * probe가 보내는 최소 스냅샷.
 *
 * 파일을 하나도 넣지 않는다 — 확인하려는 것은 "부를 수 있는가"이고, 파일을 실으면 그만큼
 * 토큰과 돈이 든다. 그렇다고 완전히 비우지는 않는다: 어댑터의 프롬프트 조립이 스냅샷 구조를
 * 읽으므로, **production이 실제로 다루는 형태**여야 조립 경로까지 확인된다.
 */
function minimalSnapshot(modelId: string, at: string): WorkspaceSnapshot {
  const projectMeta: ProjectMeta = { languages: ["typescript"], agentsMdPresent: false };
  return {
    snapshotId: "probe-snapshot",
    workspaceId: "probe-workspace",
    gitHead: "0000000000000000000000000000000000000000",
    gitBranch: "probe",
    gitDirty: false,
    relevantFiles: [],
    projectMeta,
    tokenBudget: [{ modelId, maxTokens: 2_000 }],
    createdAt: at,
  };
}

/** 검수 요청에 넣을 최소 초안. 내용이 아니라 **형태**가 요점이다. */
function minimalDraft(modelId: string, at: string): DraftProposal {
  return {
    taskId: "probe-task",
    proposalId: "probe-proposal",
    interpretation: "probe: 아무 변경도 하지 않는 초안입니다.",
    relevantFiles: [],
    plan: [{ stepId: "probe-1", description: "아무것도 하지 않는다" }],
    patch: "",
    risks: [],
    requiredTests: [],
    uncertainties: [],
    doneCriteria: ["probe이므로 판정할 것이 없다"],
    model: modelId,
    createdAt: at,
  };
}

/** 타임아웃과 사용자 취소를 **다른 사실로** 구별한다. */
export class ProbeTimeoutError extends ProviderCallFailure {
  constructor(role: ProbeRole, modelId: string, timeoutMs: number) {
    super({
      message: `${role}(${modelId}) probe가 ${timeoutMs}ms 안에 응답하지 않아 요청을 취소했습니다`,
      // **타임아웃은 과금 불확실이다.** 응답이 생성됐지만 우리가 받지 못한 것일 수 있고,
      // 그 경우 공급자는 청구한다. 그래서 not_dispatched가 아니다.
      dispatchState: "dispatched_no_response",
      classification: { kind: "timeout", message: "probe timeout", retryable: false },
    });
    this.name = "ProbeTimeoutError";
  }
}

export class ProbeCancelledError extends ProviderCallFailure {
  constructor(role: ProbeRole, modelId: string) {
    super({
      message: `${role}(${modelId}) probe가 사용자 취소로 중단되었습니다`,
      dispatchState: "dispatched_no_response",
      classification: { kind: "cancelled", message: "probe cancelled", retryable: false },
    });
    this.name = "ProbeCancelledError";
  }
}

/** 주입 가능한 timer — 테스트가 실제 시간을 기다리지 않아야 한다. */
export interface TimerApi {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: TimerApi = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 어댑터 하나에서 한 역할을 probe하는 최소 계약. 실제 어댑터가 이 모양을 만족한다. */
export interface ProbeCapableAdapter {
  generateDraft(
    input: { snapshot: WorkspaceSnapshot; userMessage: string },
    ctx: { taskId: string; callId: string; signal: AbortSignal; timeoutMs: number }
  ): Promise<{
    value: { proposalId: string; plan: unknown[] };
    usage: { inputTokens: number; outputTokens: number };
    latencyMs: number;
    meta: { providerReportedModelId?: string };
  }>;
  reviewProposal(
    input: { snapshot: WorkspaceSnapshot; userMessage: string; draft: DraftProposal },
    ctx: { taskId: string; callId: string; signal: AbortSignal; timeoutMs: number }
  ): Promise<{
    value: { verdict: string; reviewMode: string };
    usage: { inputTokens: number; outputTokens: number };
    latencyMs: number;
    meta: { providerReportedModelId?: string };
  }>;
}

export interface AdapterProbeTransportOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => string;
  /** 시간을 주입한다 — 테스트가 60초를 기다리지 않아야 한다. */
  timers?: TimerApi;
  /** 외부 취소 신호(사용자 Ctrl+C 등). 타임아웃과 구별해 기록한다. */
  externalSignal?: AbortSignal;
  /**
   * 어댑터 주입 — **테스트 전용 경계**다. production CLI는 이 옵션을 넘기지 않으므로
   * `createAdapter`가 실제 어댑터를 만든다. bypass 플래그가 아니라 함수 인자이며,
   * CLI 옵션으로 노출되지 않는다.
   */
  adapterFactory?: (entry: ModelEntry, role: ProbeRole) => ProbeCapableAdapter;
}

/**
 * 실제 요청을 보내는 transport.
 *
 * 재시도하지 않는다 — 어댑터의 `providerRetries`를 타지 않도록 호출 1회로 끝낸다.
 * "다시 해보면 될지도"는 이 명령의 질문이 아니고, 재시도는 곧 예약하지 않은 돈이다.
 *
 * # timeout이 실제로 취소한다
 *
 * 예전에는 `timeoutMs`를 ctx에 넣어 전달만 하고 timer를 만들지 않았다. 어댑터는 그 값을
 * 쓰지 않으므로 **타임아웃이 아무 일도 하지 않았다** — 응답이 오지 않으면 무한히 기다렸다.
 * 이제 timer가 `AbortController`를 실제로 abort하고, 그 결과를 **과금 불확실**로 처리한다.
 */
export function createAdapterProbeTransport(options: AdapterProbeTransportOptions = {}): ProbeTransport {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? ((): string => new Date().toISOString());
  const timers = options.timers ?? REAL_TIMERS;
  const probed = new Set<ProbeRole>();

  return {
    async probe(role: ProbeRole, entry: ModelEntry): Promise<RoleProbeOutcome> {
      if (probed.has(role)) throw new DuplicateProbeError(role);
      probed.add(role);

      const adapter: ProbeCapableAdapter = options.adapterFactory
        ? options.adapterFactory(entry, role)
        : (createAdapter(
            entry,
            { role, modelId: entry.modelId, providerId: entry.providerId, reason: "model probe" },
            { ...(options.env ? { env: options.env } : {}) }
          ) as unknown as ProbeCapableAdapter);

      const at = now();
      const controller = new AbortController();
      let timedOut = false;
      let cancelled = false;

      const onExternalAbort = (): void => {
        cancelled = true;
        controller.abort();
      };
      options.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      const handle = timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const ctx = { taskId: "probe-task", callId: `probe:${role}`, signal: controller.signal, timeoutMs };

      try {
        if (role === "reviewer") {
          const response = await adapter.reviewProposal(
            {
              snapshot: minimalSnapshot(entry.modelId, at),
              userMessage: "이 초안은 아무 변경도 하지 않습니다. 형식만 확인하는 probe입니다.",
              draft: minimalDraft(entry.modelId, at),
            },
            ctx
          );
          const decision = response.value;
          return {
            ...(response.meta.providerReportedModelId
              ? { providerReportedModelId: response.meta.providerReportedModelId }
              : {}),
            usage: response.usage,
            latencyMs: response.latencyMs,
            // 구조화 출력이 성립했는지는 **필수 필드가 채워졌는지**로 본다.
            structuredOutputOk: typeof decision.verdict === "string" && decision.verdict.length > 0,
            evidence: `verdict=${decision.verdict}, reviewMode=${decision.reviewMode}`,
            dispatchState: "response_received_with_usage",
          };
        }

        const response = await adapter.generateDraft(
          {
            snapshot: minimalSnapshot(entry.modelId, at),
            userMessage: "아무것도 바꾸지 마세요. 응답 형식만 확인하는 probe입니다.",
          },
          ctx
        );
        const draft = response.value;
        return {
          ...(response.meta.providerReportedModelId
            ? { providerReportedModelId: response.meta.providerReportedModelId }
            : {}),
          usage: response.usage,
          latencyMs: response.latencyMs,
          structuredOutputOk: typeof draft.proposalId === "string" && draft.proposalId.length > 0,
          evidence: `proposalId 있음, plan ${draft.plan.length}단계`,
          dispatchState: "response_received_with_usage",
        };
      } catch (error) {
        // 취소를 타임아웃보다 먼저 본다 — 외부 취소가 먼저 도착했으면 그것이 원인이다.
        if (cancelled) throw new ProbeCancelledError(role, entry.modelId);
        if (timedOut) throw new ProbeTimeoutError(role, entry.modelId, timeoutMs);
        throw error;
      } finally {
        // **완료 시 timer를 정리한다.** 안 하면 프로세스가 timeout만큼 살아 있고,
        // 이미 끝난 호출의 controller를 나중에 abort한다.
        timers.clearTimeout(handle);
        options.externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}
