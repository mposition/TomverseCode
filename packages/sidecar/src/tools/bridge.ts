import type {
  EngineRole,
  ModelId,
  PolicyDecision,
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

  // ---- WorkspaceIndex 캐시 (context-engine.md 2절) ----
  //
  // 도구 요청이 아니라 캐시 RPC지만 여기 두는 이유: transport와 taskId를 이미 들고 있고,
  // Context Engine이 받는 것도 이 브릿지 하나다. 캐시를 위해 Context Engine에 transport를
  // 넘기기 시작하면 **`node:fs`가 없는 것과 같은 이유의 경계**가 흐려진다.

  /**
   * 캐시된 인덱스를 읽는다.
   *
   * `fingerprint`가 `null`이면 **캐시를 쓸 수 없다**(지문을 낼 수 없는 워크스페이스).
   * 그건 "캐시가 비었다"와 다른 사실이므로 호출자가 구별해야 한다 — 전자는 저장도 하면 안 된다.
   */
  async loadCachedIndex(): Promise<{
    fingerprint: string | null;
    index: unknown | null;
    builtAt?: string | null;
    buildMs?: number | null;
  }> {
    const response = await this.transport.request<{
      fingerprint: string | null;
      index: unknown | null;
      builtAt?: string | null;
      buildMs?: number | null;
    }>("index.load", { taskId: this.taskId });
    return response;
  }

  /**
   * 인덱스를 캐시에 넣는다. `fingerprint`는 `loadCachedIndex`가 준 값을 그대로 돌려준다 —
   * Rust가 저장 시점에 다시 재서 **그 사이 워크스페이스가 바뀌었으면 저장하지 않는다.**
   */
  async saveCachedIndex(
    fingerprint: string,
    index: unknown,
    buildMs: number
  ): Promise<{ saved: boolean; reason?: string }> {
    return this.transport.request<{ saved: boolean; reason?: string }>("index.save", {
      taskId: this.taskId,
      fingerprint,
      index,
      buildMs,
    });
  }

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
      // 이동은 **원본을 지운다** — 되돌리기 비용이 삭제와 같으므로 등급도 같다(44절).
      case "move_file":
        return "user_approval";
      case "run_command":
      case "run_tests":
        return "user_approval";
      // **닫힌 집합의 값이 여기서 나온다.** `mcp_call`을 `ToolName`에 더하자 컴파일러가
      // 이 자리를 지목했다 — 분류되지 않은 도구가 조용히 생기지 않는다(23.2절).
      // 그리고 이 문의 위험도는 우리가 안다: **모른다, 그러므로 승인이다.**
      case "mcp_call":
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

  /**
   * 이 요청이 **어떻게 분류되는지만** 묻는다 — 실행하지 않는다 (state-machine 42절).
   *
   * # 게이트를 대체하지 않는다
   *
   * 실행 시점에 게이트는 그대로 다시 돈다. 여기서 받은 답은 **미리 보기**이며, 그 사이에
   * 파일이 생기거나 사라지면 두 판정이 달라질 수 있다. 대체하려고 들면 "미리 본 것"이
   * 실행 근거가 되고, 그건 게이트를 Node가 대신하는 것이다(원칙 2).
   */
  async evaluateRequest(request: ToolRequest): Promise<PolicyDecision> {
    return this.transport.request<PolicyDecision>("policy.evaluate", { request });
  }

  // ---- 읽기 헬퍼 (Context Engine이 쓴다) ----

  /**
   * 파일 목록 — **잘렸는지도 함께 돌려준다** (context-engine 18절).
   *
   * 종전에는 배열만 돌려줬다. 실제 도구는 5000개에서 자르고 `truncated`를 함께 내는데
   * **여기서 그 값을 버렸으므로**, 인덱스가 워크스페이스의 일부만 담은 채 만들어져도
   * 그 사실이 아무 데도 남지 않았다 — 16절이 `search_text`에서 고친 것과 같은 모양이고,
   * 이쪽이 더 넓게 퍼진다: 인덱스는 캐시에 저장되고 다음 태스크가 그대로 쓴다.
   */
  async listFiles(path = "."): Promise<ListResult> {
    const { result } = await this.execute("list_files", { path });
    const output = expectOk(result, "list_files") as { entries?: unknown; truncated?: unknown };
    const entries = Array.isArray(output.entries)
      ? (output.entries as { path: string; isDir: boolean; sizeBytes: number }[])
      : [];
    return {
      entries,
      // **`null`과 `false`는 다르다.** 말하지 않은 호스트를 "안 잘렸다"로 읽으면 우리가
      // 모르는 것을 안다고 주장하게 된다(16절이 개수에 대해 세운 규칙과 같다).
      truncated: typeof output.truncated === "boolean" ? output.truncated : null,
    };
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

  /**
   * 본문 검색 — **무엇을 못 봤는지도 함께 돌려준다** (state-machine 58절).
   *
   * # 왜 배열이 아닌가
   *
   * 종전에는 `matches` 배열만 돌려줬다. 그런데 실제 도구는 `skippedSecretFiles`와 `truncated`를
   * 함께 내고, **그 값들의 목적이 정확히 이 자리에 있다** — `tools/mod.rs`의 주석이 그렇게
   * 적어 두었다: *"오케스트레이터가 '여기 없으니 없다'고 결론 내리는 것을 막고."*
   *
   * 배열만 받으면 그 목적이 성립할 수 없다. 검색이 비밀값 파일 열 개를 건너뛰었어도
   * 호출부가 보는 것은 빈 배열이고, 빈 배열은 "없다"로 읽힌다.
   *
   * 13절이 검색 **실패**를 "없음"으로 읽지 않게 만든 것과 같은 규율이다. 저쪽은 못 읽은
   * 경우이고 이쪽은 **일부러 안 본** 경우이며, 둘 다 "없다"와 다른 사실이다.
   */
  async searchText(pattern: string, path = "."): Promise<SearchResult> {
    const { result } = await this.execute("search_text", { pattern, path });
    const output = expectOk(result, "search_text") as {
      matches?: unknown;
      truncated?: unknown;
      skippedSecretFiles?: unknown;
    };
    const matches = Array.isArray(output.matches)
      ? (output.matches as { path: string; line: number; text: string }[])
      : [];
    return {
      matches,
      // **`null`과 `false`를 뭉개지 않는다.** 16절은 이 규칙을 개수(`skippedSecretFiles`)에만
      // 적용하고 불리언은 `=== true`로 접었다 — 말하지 않은 호스트가 "안 잘렸다"고 주장하는
      // 셈이었고, 그건 같은 거짓말이 옆칸에서 살아남은 것이다(18절).
      truncated: typeof output.truncated === "boolean" ? output.truncated : null,
      // **없는 것과 0은 다르다.** 필드를 내지 않는 구현(옛 호스트)에서 0으로 위장하면
      // "건너뛴 것이 없다"가 되고, 그건 우리가 아는 사실이 아니다.
      skippedSecretFiles: typeof output.skippedSecretFiles === "number" ? output.skippedSecretFiles : null,
    };
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

/** `list_files`의 결과 — 본 것과 **다 봤는지**를 함께 담는다 (context-engine 18절). */
export interface ListResult {
  entries: { path: string; isDir: boolean; sizeBytes: number }[];
  /**
   * 목록이 호스트의 상한에서 잘렸는가.
   *
   * `null`은 **"호스트가 말하지 않았다"**이고 `false`는 "안 잘렸다"이다. 뭉개면 옛 호스트가
   * 조용히 "이게 전부다"라고 주장하게 된다.
   */
  truncated: boolean | null;
}

/** `search_text`의 결과 — 찾은 것과 **못 본 것**을 함께 담는다 (58절). */
export interface SearchResult {
  matches: { path: string; line: number; text: string }[];
  /**
   * 결과가 상한에서 잘렸는가. 잘렸으면 "여기 없다"는 결론이 성립하지 않는다.
   * `null`은 호스트가 말하지 않은 경우다 — `false`(안 잘렸다)와 다른 사실이다.
   */
  truncated: boolean | null;
  /**
   * 검색이 **읽지 않고 건너뛴** 비밀값 파일 수.
   *
   * `null`은 "호스트가 이 사실을 말하지 않았다"이고 `0`은 "건너뛴 것이 없다"이다.
   * 뭉개면 옛 호스트나 fake가 조용히 "건너뛴 것 없음"을 주장하게 된다.
   */
  skippedSecretFiles: number | null;
}

/**
 * 실제 도구가 내는데 **브리지가 일부러 꺼내지 않는** 값들 — context-engine 18절.
 *
 * # 왜 목록으로 적어 두는가
 *
 * 16.1절과 18.1절이 같은 결함을 두 번 찾았다: Rust가 사실을 하나 내는데 Node 쪽에서 그 값을
 * 읽는 코드가 없고, **읽지 않는다는 사실이 아무 데도 적혀 있지 않다.** 그러면 "일부러 안
 * 읽는 것"과 "빠뜨린 것"이 코드에서 구별되지 않고, 빠뜨린 쪽은 아무도 알아채지 못한다.
 *
 * 그래서 결정을 여기 적는다. `packages/sidecar/test/contextClaim.test.ts`가 Rust의 응답
 * 조립부에서 키를 유도해 대조하므로, **새 사실이 늘면 여기서 결정을 내려야 통과한다** —
 * 꺼내 쓰거나, 안 쓰는 이유를 적거나.
 */
export const UNREAD_TOOL_FACTS: Record<string, readonly string[]> = {
  // 목록을 요청한 경로(정규화된 값). 우리는 언제나 `"."`로 부르므로 답이 정해져 있다.
  list_files: ["root"],
  // 호스트가 실제로 실은 **바이트 수**. 쓰지 않는 이유는 단위가 섞이기 때문이다 —
  // Node 쪽 `includedBytes`는 예산 계산과 함께 `string.length`(UTF-16 단위)로 다시
  // 계산되고(`budget.ts`), 한 필드에 두 단위가 섞이면 그 숫자는 무엇도 뜻하지 않게 된다.
  // 바이트로 통일하려면 예산 계산까지 바꿔야 하고, 그건 이 결정과 별개다.
  read_file: ["includedBytes", "path"],
  search_text: [],
};

function expectOk(result: ToolResult, tool: string): unknown {
  if (result.status !== "ok") {
    throw new Error(`${tool} 실패 (${result.status}): ${result.error ?? "사유 없음"}`);
  }
  // 큰 출력은 Rust가 artifact로 밀어내고 참조만 준다. Context Engine은 그런 경우
  // 전체 내용을 다시 요청하지 않고 있는 것만 쓴다 — sidecar는 artifact 파일에 직접 접근할 수 없다.
  return result.output ?? {};
}
