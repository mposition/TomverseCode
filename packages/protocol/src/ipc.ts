// docs/design/process-architecture.md 3절 — Rust core <-> Node sidecar 로컬 IPC (stdio, NDJSON 프레이밍).
// 요청/응답은 id로 매칭되는 JSON-RPC 스타일, 진행상황은 응답을 기다리지 않는 별도 이벤트로 흐른다.

export interface IpcRequest<TParams = unknown> {
  kind: "request";
  id: string;
  method: string; // 예: "provider.draft", "tool.execute", "policy.evaluate", "task.start"
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
export type RustToNodeMethod = "task.start" | "task.cancel" | "task.userInput";

// Node -> Rust 요청 method 이름
export type NodeToRustMethod = "tool.execute" | "policy.evaluate" | "db.appendEvent" | "credential.get";
