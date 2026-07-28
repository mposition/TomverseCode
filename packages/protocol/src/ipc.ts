// docs/design/process-architecture.md 3절 — Rust core <-> Node sidecar 로컬 IPC (stdio, NDJSON 프레이밍).
// 요청/응답은 id로 매칭되는 JSON-RPC 스타일, 진행상황은 응답을 기다리지 않는 별도 이벤트로 흐른다.

import type { ISODateTime } from "./common.js";
import type { TaskEventType } from "./events.js";
import type { DraftProposal } from "./proposal.js";
import type { TaskPolicy, TaskRequest } from "./task.js";
import type { ToolRequest, ToolResult } from "./tools.js";
import type { VerificationPhase, VerificationReport } from "./verification.js";

export interface IpcRequest<TParams = unknown> {
  kind: "request";
  id: string;
  method: string; // 예: "task.start", "tool.execute", "verify.run"
  params: TParams;
}

export interface IpcResponse<TResult = unknown> {
  kind: "response";
  id: string; // 대응하는 IpcRequest.id
  ok: boolean;
  result?: TResult;
  error?: { code: string; message: string };
}

export interface IpcEvent<TPayload = unknown> {
  kind: "event";
  taskId: string;
  event: TPayload; // state-machine-and-protocol.md 7절 task_events의 event_type/payload와 동일 형태
}

export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;

// Rust -> Node 요청 method 이름 (process-architecture.md 3절)
export type RustToNodeMethod = "task.start" | "task.cancel" | "task.userInput" | "ping" | "shutdown";

// Node -> Rust 요청 method 이름
export type NodeToRustMethod =
  | "tool.execute"
  | "policy.evaluate"
  | "db.appendEvent"
  | "credential.get"
  /**
   * 결정론적 검증은 Rust가 실행한다 — Node가 "검증했다"고 주장할 수 없어야 하기 때문이다
   * (CLAUDE.md 원칙 1 + 2). Node는 언제 돌릴지만 요청하고, 어떤 명령이 실제로 돌았는지와
   * 그 결과는 Rust가 만들어 verification_reports에 직접 기록한다.
   */
  | "verify.run"
  /** 공급자 사용량/비용 기록 */
  | "usage.record";

// ---- 각 method의 params/result 형태 ----

export interface TaskStartParams {
  taskRequest: TaskRequest;
  policy: TaskPolicy;
  /** 워크스페이스 루트의 표시용 이름. sidecar는 경로로 파일에 직접 접근하지 않는다. */
  workspaceName: string;
  /** 사용 가능한 공급자 (자격증명이 실제로 있는 것만 Rust가 알려준다) */
  availableProviders: string[];
  /**
   * 실험 제어 — **평가 하네스 전용**이며 UI 경로에서는 항상 비어 있다.
   *
   * 왜 프로토콜에 두는가: 가설 게이트(evals/hypothesis-gate)는 production 실행 경로를 그대로
   * 태워야 의미가 있다. 하네스가 별도 파이프라인을 만들면 "production이 이렇게 동작한다"를
   * 측정하지 못한다. 그래서 arm 구성만 주입하고 나머지는 전부 같은 코드가 처리한다.
   *
   * **Rust가 채운다.** 값이 파일에서 오는 경우(replayDraft)도 파일을 읽는 것은 Rust다 —
   * sidecar가 파일에 직접 접근하지 않는다는 원칙(process-architecture.md 2절)은 여기서도 유지된다.
   */
  experiment?: ExperimentControls;
}

/** 가설 게이트의 arm을 결정하는 값들. production 기본값은 "전부 미지정"이다. */
export interface ExperimentControls {
  /**
   * Blind Review 여부를 명시적으로 고정한다.
   *
   * production에서는 아직 informed가 기본이고 이 축은 M1 항목이다. 하네스는 같은 초안에 대해
   * 두 모드를 비교해야 하므로(anchoring 효과 측정) 여기서 강제할 수 있어야 한다.
   */
  reviewMode?: "blind" | "informed";
  /**
   * 초안을 새로 생성하지 않고 **주어진 것을 그대로 쓴다.**
   *
   * Arm C(informed)와 Arm D(blind)가 각각 초안을 새로 생성하면 두 arm의 차이가 review mode인지
   * 초안 품질의 분산인지 구별할 수 없다. 같은 초안을 공유해야 paired 비교가 성립한다.
   *
   * 이건 fake provider가 **아니다**: 실제 OpenAI가 실제로 만든 초안이며, 이후 검수·계획·정책
   * 판단·도구 실행·검증은 전부 실제 경로를 탄다. 기록에 `draftSource: "replayed"`로 남는다.
   */
  replayDraft?: DraftProposal;
}

export interface TaskUserInputParams {
  taskId: string;
  message: string;
}

export interface ToolExecuteParams {
  request: ToolRequest;
}

export interface ToolExecuteResult {
  result: ToolResult;
  /** Rust Policy Gate가 내린 최종 판단 — Node의 riskTier와 다를 수 있다. */
  policy: {
    decision: string;
    riskLevel: string;
    reason: string;
    matchedRule: string;
    normalizedTarget: string;
  };
}

export interface AppendEventParams {
  taskId: string;
  type: TaskEventType;
  payload: unknown;
}

export interface AppendEventResult {
  eventId: number;
  seq: number;
}

export interface VerifyRunParams {
  taskId: string;
  phase: VerificationPhase;
  attemptNumber: number;
}

export interface VerifyRunResult {
  report: VerificationReport;
}

export interface CredentialGetParams {
  providerId: string;
}

export interface CredentialGetResult {
  /** 실제 키 값. sidecar는 메모리에만 두고 디스크에 쓰지 않는다. 없으면 null. */
  apiKey: string | null;
  source: "credential_manager" | "env" | "none";
}

export interface ReadyEvent {
  type: "ready";
  protocolVersion: string;
  startedAt: ISODateTime;
}
