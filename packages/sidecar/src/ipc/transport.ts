import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { IpcEvent, IpcMessage, IpcRequest, IpcResponse } from "@tomverse/protocol";

// docs/design/process-architecture.md 3절: Rust <-> Node는 stdio + NDJSON(줄바꿈으로 구분된 JSON)으로
// 통신한다. 이 클래스는 어느 쪽에서도(Rust 시뮬레이터, 테스트, 실제 sidecar) 재사용 가능하도록
// 구체적인 stdin/stdout이 아니라 임의의 Readable/Writable을 받는다.

type RequestHandler = (params: unknown) => Promise<unknown>;
type EventListener = (event: IpcEvent) => void;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: { code: string; message: string }) => void;
}

export class NdjsonTransport {
  private readonly output: Writable;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 1;

  constructor(input: Readable, output: Writable) {
    this.output = output;
    // 상대 프로세스(Rust core)가 먼저 종료되면 stdout 쓰기가 EPIPE로 실패할 수 있다 —
    // 처리하지 않으면 Node의 기본 동작은 uncaught 'error'로 프로세스 전체를 죽이는 것이므로,
    // 조용히 무시한다(이 시점부터 이 transport로는 더 이상 아무것도 보낼 수 없을 뿐).
    this.output.on("error", () => {});
    const rl = createInterface({ input });
    rl.on("line", (line) => this.handleLine(line));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onEvent(listener: EventListener): void {
    this.eventListeners.add(listener);
  }

  emitEvent(taskId: string, event: unknown): void {
    const msg: IpcEvent = { kind: "event", taskId, event };
    this.write(msg);
  }

  request<TResult = unknown>(method: string, params: unknown): Promise<TResult> {
    const id = String(this.nextId++);
    const msg: IpcRequest = { kind: "request", id, method, params };
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.write(msg);
    });
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let msg: IpcMessage;
    try {
      msg = JSON.parse(line) as IpcMessage;
    } catch {
      // 프로토콜 위반(파싱 불가) 줄은 무시한다 — 상대 프로세스의 stderr 출력이 실수로 섞여 들어온
      // 경우를 포함해, 연결 자체를 끊지 않는다.
      return;
    }

    if (msg.kind === "request") {
      void this.dispatchRequest(msg);
    } else if (msg.kind === "response") {
      this.dispatchResponse(msg);
    } else if (msg.kind === "event") {
      for (const listener of this.eventListeners) listener(msg);
    }
  }

  private async dispatchRequest(req: IpcRequest): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.write({
        kind: "response",
        id: req.id,
        ok: false,
        error: { code: "METHOD_NOT_FOUND", message: `No handler registered for "${req.method}"` },
      } satisfies IpcResponse);
      return;
    }
    try {
      const result = await handler(req.params);
      this.write({ kind: "response", id: req.id, ok: true, result } satisfies IpcResponse);
    } catch (err) {
      this.write({
        kind: "response",
        id: req.id,
        ok: false,
        error: { code: "HANDLER_ERROR", message: err instanceof Error ? err.message : String(err) },
      } satisfies IpcResponse);
    }
  }

  private dispatchResponse(res: IpcResponse): void {
    const call = this.pending.get(res.id);
    if (!call) return; // 이미 타임아웃되었거나 알 수 없는 응답 — 무시
    this.pending.delete(res.id);
    if (res.ok) {
      call.resolve(res.result);
    } else {
      call.reject(res.error ?? { code: "UNKNOWN", message: "Request failed with no error detail" });
    }
  }

  private write(msg: IpcMessage): void {
    this.output.write(JSON.stringify(msg) + "\n");
  }
}
