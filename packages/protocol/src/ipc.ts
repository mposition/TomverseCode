// docs/design/process-architecture.md 3절 — Rust core <-> Node sidecar 로컬 IPC (stdio, NDJSON 프레이밍).
// 요청/응답은 id로 매칭되는 JSON-RPC 스타일, 진행상황은 응답을 기다리지 않는 별도 이벤트로 흐른다.

import type { ISODateTime } from "./common.js";
import type { UserDecisionInput } from "./decision.js";
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
   * 적용된 스킬의 **프롬프트 프리셋과 모델 지정** (state-machine 26절).
   *
   * **도구 허용목록은 여기 오지 않는다.** 그건 `policy.allowedTools`로 오며 강제하는 곳도
   * Rust다 — sidecar가 지키는 규칙으로 두면 장악당한 sidecar에서 그 규칙이 사라진다(원칙 2).
   * 여기 오는 것은 sidecar가 실제로 해야 하는 일(프롬프트에 싣기, 모델 고르기)뿐이다.
   *
   * **역할별 모델 지정도 여기 오지 않는다.** 스킬이 지정한 모델은 Rust가 `policy.modelPins`에
   * 접어 넣는다 — 명시한 CLI 지정이 스킬의 지정을 이긴다는 우선순위를 한 곳에서 정하기
   * 위해서다. 두 곳에서 오면 sidecar가 그 우선순위를 다시 정하게 되고, 그러면 규칙이 둘이 된다.
   *
   * **Rust가 파일을 읽어 채운다.** sidecar가 파일에 직접 접근하지 않는다는 원칙은 여기서도
   * 유지된다.
   */
  skill?: { name: string; instructions: string };
  /**
   * 같은 세션의 앞선 태스크에서 사용자가 정한 것 (state-machine 27절).
   *
   * **Rust가 저장소에서 유도해 채운다.** sidecar가 SQLite를 직접 열지 않는다는 규칙 때문만이
   * 아니다 — "무엇을 나를 수 있는가"(사용자 판정만, 모델 제안은 아님)는 권위에 관한 판정이고,
   * 그 판정이 sidecar에 있으면 장악당한 sidecar가 모델 제안을 사용자 판정으로 나를 수 있다.
   */
  sessionMemory?: { text: string; decisionCount: number; truncated: boolean };
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
  /**
   * 대조(executor ×2)를 켤지 — multi-engine-routing.md 13절.
   *
   * production은 tier가 `standard`면 항상 켜지만(17.5절), **하네스에서는 기본이 꺼짐**이다.
   * arm을 고정해 비교하는 실험에서 호출이 하나 더 생기면 그 차이가 arm 때문인지 대조 때문인지
   * 구별되지 않는다. 켤 때는 하네스가 명시적으로 켠다.
   */
  contrast?: boolean;
}

export interface TaskUserInputParams {
  taskId: string;
  message: string;
  /**
   * 3.9절 불일치 카드의 구조적 답변 (17.2절 `UserDecisionInput`).
   *
   * `message` 하나로 합치지 않는 이유: 감사 로그가 **어떤 쟁점에 대한 답인지**를 남겨야 하는데,
   * 사람이 읽을 문장으로 뭉쳐놓으면 그 대응 관계를 다시 파싱해야 하고 파싱은 틀린다.
   * `message`는 계속 사람이 읽는 요약이고, 이 배열이 기계가 읽는 대응이다.
   *
   * 3.4절 확인 필요 카드(모델이 "모르겠다"고 한 경우)에는 쟁점 id가 없으므로 이 필드가 없다.
   */
  decisions?: UserDecisionInput[];
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
