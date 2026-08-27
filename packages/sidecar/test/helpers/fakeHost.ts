import type { VerificationReport, VerificationStatus, VerificationKind, ToolRequest, ToolResult } from "@tomverse/protocol";
import type { NdjsonTransport } from "../../src/ipc/transport.js";
import { classifyFile } from "../../src/context/exclude.js";

/**
 * fake의 검색 결과 상한 — 실제 도구의 `MAX_SEARCH_MATCHES`에 대응한다 (58절).
 *
 * **값을 맞추지 않는다.** 실제는 200이고 여기는 훨씬 작다: 상한이 **있다**는 사실을
 * 검사하려면 fixture로 200개를 만들어야 하는데, 그건 검사를 읽을 수 없게 만든다. 맞춰야
 * 하는 것은 숫자가 아니라 **`truncated`가 참이 되는 경로가 존재한다**는 사실이다.
 *
 * **다만 아무 작은 값이나 되는 것은 아니다**(21절). 이 값이 `MAX_MATCHES_PER_KEYWORD`보다
 * 크지 않으면 **엔진의 키워드당 상한에 걸리는 경로가 fake로는 도달할 수 없다** — 실제로
 * 둘 다 3이라 그 상한이 fake로 한 번도 밟히지 않았고, 거기서 버려지는 파일은 어디에도
 * 기록되지 않고 있었다. 낮춘 상한이 **다른 상한을 가린다**는 것이 여기서 배운 것이다.
 * 그 관계는 주석이 아니라 `context.test.ts`가 확인한다.
 */
/**
 * fake의 파일 목록 상한 (18절).
 *
 * 실제는 5000이다. **맞추지 않는 것이 의도다** — 자르는 경로가 존재한다는 사실만 있으면
 * 되고, 5000개짜리 fixture는 읽을 수 없다. 기존 fixture는 전부 이보다 작으므로 걸리지 않는다.
 */
export const FAKE_MAX_LIST_ENTRIES = 50;

export const FAKE_MAX_SEARCH_MATCHES = 8;

/**
 * 비밀값처럼 보이는 경로인가 — **`classifyFile`이 쓰는 것과 같은 규칙**을 지난다 (58절).
 *
 * 손으로 다시 적으면 실제 규칙이 늘 때 fake만 뒤처지고, 그러면 검사가 실제보다 넓은
 * 세계를 지킨다(13.6절). 크기는 여기서 판정하지 않으므로 0을 넘긴다 — 크기 제외는
 * 인덱싱의 일이고 검색 도구가 하는 일이 아니다.
 */
function isSecretLike(path: string): boolean {
  const verdict = classifyFile(path, 0);
  return verdict.excluded && (verdict.reason ?? "").includes("시크릿");
}

function isBinaryLike(path: string): boolean {
  const verdict = classifyFile(path, 0);
  return verdict.excluded && (verdict.reason ?? "").includes("바이너리");
}

/**
 * Orchestrator 단위 테스트용 인-프로세스 Rust 호스트 대역.
 *
 * **범위를 분명히 해둔다:** 이건 상태 머신·루프 상한·취소 같은 Node 쪽 로직을 빠르게
 * 검증하기 위한 것이고, Policy Gate / Tool Runtime / 검증 러너의 동작을 검증하지 **않는다**.
 * 그건 Rust 단위 테스트와 `test/e2e.test.ts`(실제 tomverse-host + 실제 파일 시스템)의 몫이다.
 *
 * 여기서 "정책이 허용했다"고 응답하는 것은 그 사실을 주장하는 것이 아니라, Orchestrator가
 * 허용 응답을 받았을 때 어떻게 행동하는지를 보는 것이다.
 */

export interface FakeHostOptions {
  /** list_files 응답 */
  files?: { path: string; isDir: boolean; sizeBytes: number }[];
  /** read_file 응답 (path → content) */
  contents?: Record<string, string>;
  gitStatus?: string;
  gitDiff?: string;
  /**
   * `search_text`가 실패하게 만든다 (51절).
   *
   * **"찾지 못했다"와 "찾지 못한 것이 아니라 못 찾았다"는 다른 사실**이고, 그 구별을 검사하려면
   * 실패를 만들 수 있어야 한다.
   */
  failSearchText?: boolean;
  /** verify.run 응답을 순서대로 소비한다. 첫 호출은 baseline이다. */
  verifyResults?: VerifyStub[];
  /**
   * 인덱스 캐시의 워크스페이스 지문.
   *
   * `null`이면 **지문을 낼 수 없는 워크스페이스**(git 저장소가 아님)를 흉내낸다 —
   * 그 경우 캐시를 쓰지도 저장하지도 않아야 한다. 기본값을 주는 이유: 대부분의 테스트는
   * 캐시를 신경 쓰지 않고 "인덱스를 재사용한다"만 확인한다.
   */
  indexFingerprint?: string | null;
  /**
   * 변경 도구가 성공했을 때 파일 내용을 이렇게 바꾼다 (path → 새 내용, `null`이면 삭제).
   *
   * **fake가 이걸 하지 않으면 검증할 수 없는 것이 있다**: 스냅샷이 변경 이후 내용을 싣는지는
   * 파일이 실제로 달라져야만 물어볼 수 있고, 달라지지 않으면 옛 내용을 실어도 테스트가 통과한다.
   */
  mutationEffects?: Record<string, string | null>;
  /** tool.execute 응답 override (requestId 순서대로) */
  toolResults?: {
    status: "ok" | "error" | "denied" | "timeout" | "cancelled";
    error?: string;
    policyDecision?: string;
    /** 거부가 **요청의 모양** 때문인가 (state-machine 41.4절). Rust가 정하는 값이다. */
    redraftable?: boolean;
    /** 왜 실패했는가 (state-machine 65절). **Rust가 정하는 값이다** — 여기서 다시 판정하지 않는다. */
    fileFailure?: ToolResult["fileFailure"];
  }[];
  /**
   * 계획 프리플라이트 응답 override — 도구 이름별 (state-machine 42절).
   *
   * **`toolResults`와 따로 둔다.** 프리플라이트는 실행하지 않으므로 그 목록을 소비하면
   * 실제 실행이 스텁을 하나씩 잃는다.
   */
  preflight?: Record<string, { decision?: string; reason?: string; matchedRule?: string; redraftable?: boolean }>;
  /**
   * 호출마다 답을 바꿔야 하는 경우 — 되돌린 뒤 두 번째 계획은 지나가야 "되돌린 것이 쓸모
   * 있었다"가 성립한다. `undefined`를 주면 기본값(자동 승인)이다.
   */
  preflightPerCall?: () => { decision?: string; reason?: string; matchedRule?: string; redraftable?: boolean } | undefined;
  /**
   * `mcp_call` 응답 override (호출 순서대로) — state-machine 31절.
   *
   * **변경 도구와 따로 센다.** 한 목록에 섞으면 MCP 호출 하나가 `apply_patch`용 스텁을
   * 먹어치우고, 그 어긋남은 "왜 patch가 실패했지"로 나타난다.
   */
  mcpResults?: {
    status?: "ok" | "error" | "denied" | "cancelled";
    output?: unknown;
    error?: string;
    denialKind?: string;
  }[];
}

export interface VerifyStub {
  overall: "pass" | "fail" | "not_configured" | "could_not_run";
  checks?: { kind: VerificationKind; status: VerificationStatus; summary?: string; detail?: string }[];
  newlyFailing?: VerificationKind[];
  preexistingFailures?: VerificationKind[];
}

export class FakeHost {
  readonly events: { type: string; payload: unknown }[] = [];
  readonly toolRequests: ToolRequest[] = [];
  /** 프리플라이트로 **분류만** 물어본 요청들 — 실행한 것과 따로 센다(42절). */
  readonly policyChecks: ToolRequest[] = [];
  readonly verifyCalls: { phase: string; attemptNumber: number }[] = [];
  readonly usage: unknown[] = [];
  /** 저장된 인덱스 캐시 — Rust의 `workspace_index_cache` 한 행에 해당한다. */
  private cachedIndex: { fingerprint: string; index: unknown; buildMs: number } | null = null;
  /** 캐시 RPC가 몇 번 불렸는지 — 테스트가 "저장하지 않았다"를 확인할 수 있어야 한다. */
  readonly indexSaves: { fingerprint: string; buildMs: number }[] = [];
  private eventSeq = 0;
  private toolCursor = 0;
  private mcpCursor = 0;
  private verifyCursor = 0;

  constructor(private options: FakeHostOptions = {}) {}

  /** Orchestrator는 transport의 `request`만 쓰므로 그 형태만 만족시킨다. */
  asTransport(): NdjsonTransport {
    return { request: (method: string, params: unknown) => this.handle(method, params) } as unknown as NdjsonTransport;
  }

  /** 지금 워크스페이스 지문. 테스트가 도중에 바꿔 "상태가 변했다"를 만들 수 있다. */
  private indexFingerprint(): string | null {
    return this.options.indexFingerprint === undefined ? "sha256:fake" : this.options.indexFingerprint;
  }

  /** 테스트에서 워크스페이스가 변한 상황을 만든다. */
  setIndexFingerprint(value: string | null): void {
    this.options.indexFingerprint = value;
  }

  eventTypes(): string[] {
    return this.events.map((e) => e.type);
  }

  phaseSequence(): string[] {
    return this.events
      .filter((e) => e.type === "PHASE_CHANGED")
      .map((e) => (e.payload as { to: string }).to);
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "db.appendEvent": {
        const { type, payload } = params as { type: string; payload: unknown };
        this.events.push({ type, payload });
        this.eventSeq += 1;
        return { eventId: this.eventSeq, seq: this.eventSeq - 1 };
      }

      case "usage.record": {
        this.usage.push((params as { usage: unknown }).usage);
        return { recorded: true };
      }

      case "verify.run": {
        const { taskId, phase, attemptNumber } = params as {
          taskId: string;
          phase: string;
          attemptNumber: number;
        };
        this.verifyCalls.push({ phase, attemptNumber });
        const stub = this.options.verifyResults?.[this.verifyCursor];
        this.verifyCursor += 1;
        return { report: this.buildReport(taskId, phase, attemptNumber, stub) };
      }

      // 실제 Rust는 지문을 스스로 계산하고 워크스페이스 id도 자기 루트에서 유도한다.
      // 여기서는 그 **계약**만 흉내낸다: 지문이 맞을 때만 캐시를 준다.
      case "index.load": {
        const fingerprint = this.indexFingerprint();
        if (fingerprint === null) return { fingerprint: null, index: null };
        const hit = this.cachedIndex?.fingerprint === fingerprint ? this.cachedIndex : null;
        return {
          fingerprint,
          index: hit?.index ?? null,
          buildMs: hit?.buildMs ?? null,
        };
      }

      case "index.save": {
        const { fingerprint, index, buildMs } = params as {
          fingerprint: string;
          index: unknown;
          buildMs: number;
        };
        this.indexSaves.push({ fingerprint, buildMs });
        // Rust는 저장 시점에 지문을 다시 재서 그 사이 바뀌었으면 저장하지 않는다.
        if (fingerprint !== this.indexFingerprint()) return { saved: false, reason: "그 사이 바뀜" };
        this.cachedIndex = { fingerprint, index, buildMs };
        return { saved: true, fingerprint };
      }

      case "tool.execute": {
        const { request } = params as { request: ToolRequest };
        this.toolRequests.push(request);
        return this.handleTool(request);
      }

      // 계획 프리플라이트 (state-machine 42절). **실행하지 않고 분류만 답한다.**
      case "policy.evaluate": {
        const { request } = params as { request: ToolRequest };
        this.policyChecks.push(request);
        const stub = this.options.preflightPerCall?.() ?? this.options.preflight?.[request.tool];
        return {
          requestId: request.requestId,
          decision: stub?.decision ?? "auto_approve",
          riskLevel: "none",
          matchedRule: stub?.matchedRule ?? "fake-preflight",
          reason: stub?.reason ?? "fake",
          requiresUserApproval: false,
          normalizedTarget: String((request.args as { path?: unknown }).path ?? ""),
          redraftable: stub?.redraftable ?? false,
          decidedAt: new Date().toISOString(),
        };
      }

      default:
        throw new Error(`FakeHost가 다루지 않는 method: ${method}`);
    }
  }

  private handleTool(request: ToolRequest): unknown {
    const ok = (output: unknown) => ({
      result: {
        requestId: request.requestId,
        status: "ok" as const,
        output,
        durationMs: 1,
        completedAt: new Date().toISOString(),
      },
      policy: {
        decision: "auto_approve",
        riskLevel: "none",
        reason: "fake host",
        matchedRule: "fake",
        normalizedTarget: String(request.args.path ?? ""),
      },
    });

    switch (request.tool) {
      // **상한을 흉내 낸다**(18절). 자르는 경로가 fake에 없으면 `truncated`를 읽는 코드도,
      // 그 값이 만드는 범위 노트도 단위 테스트로는 검증되지 않는다 — 16.2절이 검색에서
      // 배운 것과 같다.
      //
      // **숫자는 실제(5000)와 맞추지 않는다.** 맞춰야 하는 것은 숫자가 아니라 자르는 경로가
      // 존재한다는 사실이고, 5000개짜리 fixture는 검사를 읽을 수 없게 만든다. 기존
      // fixture들이 걸리지 않을 만큼 크되 테스트로 넘길 수 있을 만큼 작게 잡는다.
      case "list_files": {
        const all = this.options.files ?? [];
        const truncated = all.length > FAKE_MAX_LIST_ENTRIES;
        return ok({
          entries: truncated ? all.slice(0, FAKE_MAX_LIST_ENTRIES) : all,
          truncated,
          root: ".",
        });
      }
      case "read_file": {
        const path = String(request.args.path);
        const content = this.options.contents?.[path];
        if (content === undefined) {
          return {
            result: {
              requestId: request.requestId,
              status: "error" as const,
              error: `fake host에 ${path} 내용이 없습니다`,
              durationMs: 1,
              completedAt: new Date().toISOString(),
            },
            policy: { decision: "auto_approve", riskLevel: "none", reason: "", matchedRule: "", normalizedTarget: path },
          };
        }
        // **실제 도구가 내는 키를 전부 낸다**(18절). Node가 읽지 않기로 한 값이라도 fake가
        // 내지 않으면 "안 읽는다"와 "낼 수 없다"가 구별되지 않는다.
        return ok({
          path,
          binary: false,
          content,
          sizeBytes: content.length,
          includedBytes: content.length,
          truncated: false,
        });
      }
      // **진짜로 찾는다**(51절). 빈 배열을 돌려주면 본문 기반 선정이 "찾지 못했다"로 돌고,
      // 그 검사는 무엇도 검사하지 못한 채 통과한다 — fake가 게으르면 검사도 게을러진다.
      case "search_text": {
        // 검색 자체가 실패하는 경우 — "찾지 못했다"와 구별되어야 한다.
        if (this.options.failSearchText) {
          return {
            result: {
              requestId: request.requestId,
              status: "error" as const,
              error: "fake search failure",
              durationMs: 1,
              completedAt: new Date().toISOString(),
            },
            policy: { decision: "auto_approve", riskLevel: "none", reason: "", matchedRule: "", normalizedTarget: "" },
          };
        }
        const pattern = new RegExp(String(request.args.pattern));
        const matches: { path: string; line: number; text: string }[] = [];
        // **실제 도구가 내는 세 값을 모두 낸다**(58절). fake가 게으르면 검사도 게을러진다:
        // `skippedSecretFiles`를 내지 않으면 "건너뛴 것이 있다"는 경로가 fake로는 검증되지
        // 않고, 그러면 그 사실을 읽는 코드를 지워도 아무 검사도 실패하지 않는다.
        let skippedSecretFiles = 0;
        let truncated = false;
        for (const [path, content] of Object.entries(this.options.contents ?? {})) {
          // 비밀값 파일은 **읽기 전에** 건너뛴다 — 실제 도구가 그렇게 한다(tools/mod.rs).
          //
          // **판정을 여기서 다시 적지 않는다.** 종전에는 `.env`만 보는 정규식이 손으로
          // 적혀 있었고, 그러면 실제 규칙이 늘 때 fake만 뒤처져 **검사가 실제보다 넓은
          // 세계를 지키게 된다**(13.6절이 적어 둔 갈림).
          if (isSecretLike(path)) {
            skippedSecretFiles += 1;
            continue;
          }
          if (isBinaryLike(path)) continue;
          for (const [i, text] of content.split("\n").entries()) {
            if (!pattern.test(text)) continue;
            if (matches.length >= FAKE_MAX_SEARCH_MATCHES) {
              truncated = true;
              break;
            }
            matches.push({ path, line: i + 1, text: text.slice(0, 400) });
          }
          if (truncated) break;
        }
        return ok({ matches, truncated, skippedSecretFiles });
      }
      case "git_status":
        return ok({ stdout: this.options.gitStatus ?? "## main", exitCode: 0 });
      case "git_diff":
        return ok({ stdout: this.options.gitDiff ?? "", exitCode: 0 });
      case "mcp_call": {
        const stub = this.options.mcpResults?.[this.mcpCursor];
        this.mcpCursor += 1;
        const status = stub?.status ?? "ok";
        if (status === "ok") {
          return ok(stub?.output ?? { content: [{ type: "text", text: `echoed:${request.args.tool}` }] });
        }
        return {
          result: {
            requestId: request.requestId,
            status,
            error: stub?.error ?? "fake mcp failure",
            ...(stub?.denialKind ? { denialKind: stub.denialKind } : {}),
            durationMs: 1,
            completedAt: new Date().toISOString(),
          },
          policy: {
            decision: status === "denied" ? "deny" : "require_user_approval",
            riskLevel: "medium",
            reason: stub?.error ?? "fake",
            matchedRule: "mcp_call",
            normalizedTarget: `${request.args.server}/${request.args.tool}`,
          },
        };
      }
      default: {
        // 변경 도구 — 스크립트된 응답을 순서대로 소비한다.
        const stub = this.options.toolResults?.[this.toolCursor];
        this.toolCursor += 1;
        if (!stub || stub.status === "ok") {
          this.applyMutationEffect(String(request.args.path ?? ""));
          return ok({ path: request.args.path, bytesBefore: 10, bytesAfter: 12 });
        }
        return {
          result: {
            requestId: request.requestId,
            status: stub.status,
            error: stub.error ?? "fake failure",
            durationMs: 1,
            completedAt: new Date().toISOString(),
            // **없으면 키를 두지 않는다.** `undefined`를 실으면 "판정이 없다"와 "판정이
            // undefined다"가 같아 보이는데, 전자가 뜻하는 것은 "더 말할 것이 없다"이다.
            ...(stub.fileFailure ? { fileFailure: stub.fileFailure } : {}),
          },
          policy: {
            decision: stub.policyDecision ?? (stub.status === "denied" ? "deny" : "auto_approve"),
            riskLevel: "medium",
            reason: stub.error ?? "fake",
            matchedRule: "fake",
            normalizedTarget: String(request.args.path ?? ""),
            redraftable: stub.redraftable ?? false,
          },
        };
      }
    }
  }

  /** 성공한 변경 도구가 디스크에 남긴 결과를 흉내낸다. */
  private applyMutationEffect(path: string): void {
    const effect = this.options.mutationEffects?.[path];
    if (effect === undefined) return;
    this.options.contents ??= {};
    if (effect === null) delete this.options.contents[path];
    else this.options.contents[path] = effect;
  }

  private buildReport(
    taskId: string,
    phase: string,
    attemptNumber: number,
    stub: VerifyStub | undefined
  ): VerificationReport {
    const overall = stub?.overall ?? "pass";
    const checks = stub?.checks ?? [
      {
        kind: "test" as VerificationKind,
        status: (overall === "pass" ? "PASSED" : overall === "fail" ? "FAILED" : "NOT_CONFIGURED") as VerificationStatus,
        summary: "fake check",
        detail: overall === "fail" ? "AssertionError: expected 1 to equal 2\n  at src/app.ts:12:3" : undefined,
      },
    ];
    return {
      taskId,
      reportId: `verify-${phase}-${attemptNumber}-${this.verifyCursor}`,
      phase: phase as "baseline" | "post",
      attemptNumber,
      checks: checks.map((c) => ({
        kind: c.kind,
        status: c.status,
        summary: c.summary ?? "",
        detail: c.detail,
      })),
      newlyFailing: stub?.newlyFailing,
      preexistingFailures: stub?.preexistingFailures,
      overall,
      createdAt: new Date().toISOString(),
    };
  }
}

/** 테스트에서 쓰는 최소한의 유효 unified diff. */
export const VALID_PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,1 +1,1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
  "",
].join("\n");
