import type { VerificationReport, VerificationStatus, VerificationKind, ToolRequest } from "@tomverse/protocol";
import type { NdjsonTransport } from "../../src/ipc/transport.js";

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
  /** verify.run 응답을 순서대로 소비한다. 첫 호출은 baseline이다. */
  verifyResults?: VerifyStub[];
  /** tool.execute 응답 override (requestId 순서대로) */
  toolResults?: {
    status: "ok" | "error" | "denied" | "timeout" | "cancelled";
    error?: string;
    policyDecision?: string;
  }[];
}

export interface VerifyStub {
  overall: "pass" | "fail" | "not_verified";
  checks?: { kind: VerificationKind; status: VerificationStatus; summary?: string; detail?: string }[];
  newlyFailing?: VerificationKind[];
  preexistingFailures?: VerificationKind[];
}

export class FakeHost {
  readonly events: { type: string; payload: unknown }[] = [];
  readonly toolRequests: ToolRequest[] = [];
  readonly verifyCalls: { phase: string; attemptNumber: number }[] = [];
  readonly usage: unknown[] = [];
  private eventSeq = 0;
  private toolCursor = 0;
  private verifyCursor = 0;

  constructor(private readonly options: FakeHostOptions = {}) {}

  /** Orchestrator는 transport의 `request`만 쓰므로 그 형태만 만족시킨다. */
  asTransport(): NdjsonTransport {
    return { request: (method: string, params: unknown) => this.handle(method, params) } as unknown as NdjsonTransport;
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

      case "tool.execute": {
        const { request } = params as { request: ToolRequest };
        this.toolRequests.push(request);
        return this.handleTool(request);
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
      case "list_files":
        return ok({ entries: this.options.files ?? [], truncated: false });
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
        return ok({ path, binary: false, content, sizeBytes: content.length, truncated: false });
      }
      case "search_text":
        return ok({ matches: [], truncated: false });
      case "git_status":
        return ok({ stdout: this.options.gitStatus ?? "## main", exitCode: 0 });
      case "git_diff":
        return ok({ stdout: this.options.gitDiff ?? "", exitCode: 0 });
      default: {
        // 변경 도구 — 스크립트된 응답을 순서대로 소비한다.
        const stub = this.options.toolResults?.[this.toolCursor];
        this.toolCursor += 1;
        if (!stub || stub.status === "ok") {
          return ok({ path: request.args.path, bytesBefore: 10, bytesAfter: 12 });
        }
        return {
          result: {
            requestId: request.requestId,
            status: stub.status,
            error: stub.error ?? "fake failure",
            durationMs: 1,
            completedAt: new Date().toISOString(),
          },
          policy: {
            decision: stub.policyDecision ?? (stub.status === "denied" ? "deny" : "auto_approve"),
            riskLevel: "medium",
            reason: stub.error ?? "fake",
            matchedRule: "fake",
            normalizedTarget: String(request.args.path ?? ""),
          },
        };
      }
    }
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
