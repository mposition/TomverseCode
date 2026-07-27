import type {
  EngineRole,
  ModelId,
  RiskTier,
  ToolExecuteResult,
  ToolName,
  ToolRequest,
  ToolRequester,
  ToolResult,
} from "@tomverse/protocol";
import type { NdjsonTransport } from "../ipc/transport.js";

/**
 * Node → Rust 도구 요청 통로.
 *
 * process-architecture.md 2절: **Node는 파일 시스템·셸·git에 직접 접근하지 않는다.**
 * sidecar 안에서 파일을 읽어야 하는 코드(Context Engine 등)는 전부 이 클래스를 지나며,
 * 그래서 sidecar 코드베이스에는 `node:fs` import가 존재하지 않는다 — 편의 우회를
 * 만들지 않는다는 것이 이 파일의 목적이다.
 */
export class ToolBridge {
  private counter = 0;

  constructor(
    private readonly transport: NdjsonTransport,
    private readonly taskId: string,
    private readonly requestedBy: ToolRequester = { role: "orchestrator" }
  ) {}

  /** 특정 역할이 요청한 것으로 기록되는 브릿지를 만든다 (감사 로그용). */
  as(role: EngineRole, modelId: ModelId): ToolBridge {
    return new ToolBridge(this.transport, this.taskId, { role, modelId });
  }

  /**
   * Node가 계산하는 1차 riskTier. Rust는 이 값을 판단 근거로 쓰지 않고 기록만 한다 —
   * 그래서 여기서 잘못 계산해도 보안이 약해지지 않는다. 이 값의 용도는
   * (a) UI가 승인 모달 필요 여부를 미리 예상하는 것과
   * (b) 감사 로그에서 Node와 Rust의 판단이 갈렸는지 보는 것이다.
   */
  private classify(tool: ToolName): RiskTier {
    switch (tool) {
      case "list_files":
      case "search_text":
      case "read_file":
      case "git_status":
      case "git_diff":
        return "auto";
      case "apply_patch":
      case "create_file":
        return "conditional";
      case "delete_file":
        return "user_approval";
      case "run_command":
      case "run_tests":
        return "user_approval";
    }
  }

  build(tool: ToolName, args: Record<string, unknown>): ToolRequest {
    this.counter += 1;
    return {
      requestId: `${this.taskId}-tool-${this.counter}`,
      taskId: this.taskId,
      tool,
      args,
      requestedBy: this.requestedBy,
      riskTier: this.classify(tool),
      createdAt: new Date().toISOString(),
    };
  }

  /** 도구 실행 요청. Rust가 Policy Gate → (승인) → Tool Runtime을 거쳐 결과를 돌려준다. */
  async execute(tool: ToolName, args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const request = this.build(tool, args);
    return this.executeRequest(request);
  }

  async executeRequest(request: ToolRequest): Promise<ToolExecuteResult> {
    return this.transport.request<ToolExecuteResult>("tool.execute", { request });
  }

  // ---- 읽기 헬퍼 (Context Engine이 쓴다) ----

  async listFiles(path = "."): Promise<{ path: string; isDir: boolean; sizeBytes: number }[]> {
    const { result } = await this.execute("list_files", { path });
    const output = expectOk(result, "list_files");
    const entries = (output as { entries?: unknown }).entries;
    return Array.isArray(entries) ? (entries as { path: string; isDir: boolean; sizeBytes: number }[]) : [];
  }

  async readFile(path: string): Promise<{ content: string | null; truncated: boolean; sizeBytes: number; binary: boolean }> {
    const { result } = await this.execute("read_file", { path });
    const output = expectOk(result, "read_file") as {
      content: string | null;
      truncated?: boolean;
      sizeBytes?: number;
      binary?: boolean;
    };
    return {
      content: output.content ?? null,
      truncated: output.truncated ?? false,
      sizeBytes: output.sizeBytes ?? 0,
      binary: output.binary ?? false,
    };
  }

  /** 읽기 실패를 예외로 만들지 않는 변형 — 파일 하나를 못 읽어서 스냅샷 전체가 실패하면 안 된다. */
  async tryReadFile(path: string): Promise<string | null> {
    try {
      const file = await this.readFile(path);
      return file.binary ? null : file.content;
    } catch {
      return null;
    }
  }

  async searchText(pattern: string, path = "."): Promise<{ path: string; line: number; text: string }[]> {
    const { result } = await this.execute("search_text", { pattern, path });
    const output = expectOk(result, "search_text");
    const matches = (output as { matches?: unknown }).matches;
    return Array.isArray(matches) ? (matches as { path: string; line: number; text: string }[]) : [];
  }

  async gitStatus(): Promise<{ stdout: string; exitCode: number | null }> {
    const { result } = await this.execute("git_status", {});
    const output = (result.output ?? {}) as { stdout?: string; exitCode?: number | null };
    return { stdout: output.stdout ?? "", exitCode: output.exitCode ?? null };
  }

  async gitDiff(options: { statOnly?: boolean } = {}): Promise<string> {
    const { result } = await this.execute("git_diff", { statOnly: options.statOnly ?? false });
    const output = (result.output ?? {}) as { stdout?: string };
    return output.stdout ?? "";
  }
}

function expectOk(result: ToolResult, tool: string): unknown {
  if (result.status !== "ok") {
    throw new Error(`${tool} 실패 (${result.status}): ${result.error ?? "사유 없음"}`);
  }
  // 큰 출력은 Rust가 artifact로 밀어내고 참조만 준다. Context Engine은 그런 경우
  // 전체 내용을 다시 요청하지 않고 있는 것만 쓴다 — sidecar는 artifact 파일에 직접 접근할 수 없다.
  return result.output ?? {};
}
