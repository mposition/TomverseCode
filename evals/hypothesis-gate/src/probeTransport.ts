import { createAdapter } from "@tomverse/sidecar/providers";
import type {
  DraftProposal,
  ModelEntry,
  ProjectMeta,
  WorkspaceSnapshot,
} from "@tomverse/protocol";
import type { ProbeRole, ProbeTransport, RoleProbeOutcome } from "./probeModels.js";

/**
 * production 어댑터로 probe를 보내는 transport (§3).
 *
 * # 왜 별도 파일인가
 *
 * 이 파일만이 실제 네트워크로 나간다. 테스트는 `probeModels.ts`의 `ProbeTransport`를
 * mock으로 채워 검증하고 **이 파일을 import하지 않는다** — 그래야 `npm test`가 실수로
 * 유료 API를 부를 경로가 아예 없다.
 *
 * # 왜 production 어댑터인가
 *
 * probe 전용 HTTP 호출을 따로 만들면 확인한 것이 "공급자가 살아있다"뿐이고, 정작 알고 싶은
 * "우리 어댑터가 이 모델과 구조화 출력까지 동작하는가"는 확인되지 않는다. 그래서
 * `createAdapter`가 만든 그 어댑터의 `generateDraft`/`reviewProposal`을 그대로 부른다.
 * 구조화 출력 성립 여부는 별도 검사가 아니라 **어댑터가 스키마를 만족하는 값을 만들어냈는가**로
 * 판정된다 — 실패하면 어댑터가 예외를 던진다.
 */

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

export interface AdapterProbeTransportOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => string;
}

/**
 * 실제 요청을 보내는 transport.
 *
 * 재시도하지 않는다 — 어댑터의 `providerRetries`를 타지 않도록 호출 1회로 끝낸다.
 * "다시 해보면 될지도"는 이 명령의 질문이 아니고, 재시도는 곧 예약하지 않은 돈이다.
 */
export function createAdapterProbeTransport(options: AdapterProbeTransportOptions = {}): ProbeTransport {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? ((): string => new Date().toISOString());
  const probed = new Set<ProbeRole>();

  return {
    async probe(role: ProbeRole, entry: ModelEntry): Promise<RoleProbeOutcome> {
      if (probed.has(role)) throw new DuplicateProbeError(role);
      probed.add(role);

      const adapter = createAdapter(
        entry,
        { role, modelId: entry.modelId, providerId: entry.providerId, reason: "model probe" },
        { ...(options.env ? { env: options.env } : {}) }
      );
      const at = now();
      const controller = new AbortController();
      const ctx = {
        taskId: "probe-task",
        callId: `probe:${role}`,
        signal: controller.signal,
        timeoutMs,
      };

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
          returnedModelId: decision.model,
          usage: response.usage,
          latencyMs: response.latencyMs,
          // 구조화 출력이 성립했는지는 **필수 필드가 채워졌는지**로 본다.
          structuredOutputOk: typeof decision.verdict === "string" && decision.verdict.length > 0,
          evidence: `verdict=${decision.verdict}, reviewMode=${decision.reviewMode}`,
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
        returnedModelId: draft.model,
        usage: response.usage,
        latencyMs: response.latencyMs,
        structuredOutputOk: typeof draft.proposalId === "string" && draft.proposalId.length > 0,
        evidence: `proposalId 있음, plan ${draft.plan.length}단계`,
      };
    },
  };
}
