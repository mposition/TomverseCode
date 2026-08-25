/**
 * 경계 검증.
 *
 * 작업 지침 4.1절: "런타임 입력은 TypeScript 타입만 믿지 말고 경계에서 검증한다."
 * 3.1절: "LLM 출력은 신뢰하지 않는 외부 입력으로 취급한다."
 *
 * zod 같은 라이브러리를 도입하지 않은 이유: 검증해야 하는 형태가 십여 개로 한정되고,
 * 그중 보안에 직결되는 것(RunCommandArgs, 경로 인자)은 어차피 Rust에서 한 번 더 독립적으로
 * 검증되어야 한다(process-architecture.md 2절 — Node의 판단을 Rust가 신뢰하지 않는다).
 * 즉 여기 있는 검증은 "일찍 실패하게 만드는 층"이고 최종 방어선이 아니므로,
 * 의존성을 늘리는 대신 명시적인 작은 함수로 둔다.
 */

import type { ReviewMode, Verdict } from "./common.js";
import type { DraftProposal, PlanStep, ReviewDecision, SingleModelFixResult } from "./proposal.js";
import type { RunCommandArgs } from "./tools.js";

export class ValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(path, `expected an object, got ${describe(value)}`);
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ValidationError(path, `expected a string, got ${describe(value)}`);
  return value;
}

export function requireNonEmptyString(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (s.trim().length === 0) throw new ValidationError(path, "expected a non-empty string");
  return s;
}

export function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, path);
}

export function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ValidationError(path, `expected an array, got ${describe(value)}`);
  return value.map((item, i) => requireString(item, `${path}[${i}]`));
}

export function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requireStringArray(value, path);
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const s = requireString(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new ValidationError(path, `expected one of ${allowed.join(" | ")}, got ${JSON.stringify(s)}`);
  }
  return s as T;
}

export function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(path, `expected a finite number, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

const VERDICTS: readonly Verdict[] = ["ACCEPT", "REVISE", "REJECT", "NEED_USER_INPUT"];
const TOOL_HINTS = ["apply_patch", "create_file", "delete_file", "run_command", "run_tests"] as const;

function validatePlanSteps(value: unknown, path: string): PlanStep[] {
  if (!Array.isArray(value)) throw new ValidationError(path, `expected an array, got ${describe(value)}`);
  return value.map((raw, i) => {
    const step = requireObject(raw, `${path}[${i}]`);
    const toolHintRaw = step.toolHint;
    return {
      stepId: requireNonEmptyString(step.stepId ?? `step-${i + 1}`, `${path}[${i}].stepId`),
      description: requireNonEmptyString(step.description, `${path}[${i}].description`),
      toolHint:
        toolHintRaw === undefined || toolHintRaw === null
          ? undefined
          : requireEnum(toolHintRaw, TOOL_HINTS, `${path}[${i}].toolHint`),
      targetPaths: optionalStringArray(step.targetPaths, `${path}[${i}].targetPaths`),
    };
  });
}

/**
 * 모델이 반환한 구조화 출력을 DraftProposal로 확정한다.
 * 스키마를 강제해도(strict_schema / forced_tool_use) 모델이 필드를 비우거나 타입을 어길 수 있으므로
 * 파싱 직후 여기를 통과해야만 오케스트레이터가 값을 본다.
 */
export function validateDraftProposal(
  raw: unknown,
  ctx: { taskId: string; proposalId: string; model: string; createdAt: string }
): DraftProposal {
  const o = requireObject(raw, "draftProposal");
  return {
    taskId: ctx.taskId,
    proposalId: ctx.proposalId,
    interpretation: requireNonEmptyString(o.interpretation, "draftProposal.interpretation"),
    relevantFiles: Array.isArray(o.relevantFiles)
      ? o.relevantFiles.map((f, i) => {
          const rf = requireObject(f, `draftProposal.relevantFiles[${i}]`);
          return {
            path: requireNonEmptyString(rf.path, `draftProposal.relevantFiles[${i}].path`),
            reason: requireString(rf.reason ?? "", `draftProposal.relevantFiles[${i}].reason`),
          };
        })
      : [],
    plan: o.plan === undefined ? [] : validatePlanSteps(o.plan, "draftProposal.plan"),
    patch: optionalString(o.patch, "draftProposal.patch"),
    risks: optionalStringArray(o.risks, "draftProposal.risks") ?? [],
    requiredTests: optionalStringArray(o.requiredTests, "draftProposal.requiredTests") ?? [],
    uncertainties: optionalStringArray(o.uncertainties, "draftProposal.uncertainties") ?? [],
    doneCriteria: optionalStringArray(o.doneCriteria, "draftProposal.doneCriteria") ?? [],
    mcpCalls: validateMcpCalls(o.mcpCalls),
    moves: validateMoves(o.moves),
    model: ctx.model,
    createdAt: ctx.createdAt,
  };
}

/**
 * 초안이 요청한 파일 이동 — state-machine 44절.
 *
 * **형태가 틀린 항목을 버리지 않고 오류로 만든다**(`mcpCalls`와 같은 이유). 조용히 버리면
 * 모델은 파일을 옮겼다고 믿고 그 다음 patch를 **새 경로 기준으로** 쓰는데, 실제로는 옮겨지지
 * 않았으므로 그 patch는 없는 파일에 적용된다.
 *
 * 두 경로가 같은 것도 여기서 거부한다 — 그건 이동이 아니고, 게이트까지 갈 이유가 없다.
 */
function validateMoves(raw: unknown): DraftProposal["moves"] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ValidationError("draftProposal.moves", "expected an array");
  if (raw.length === 0) return [];
  return raw.map((item, i) => {
    const move = requireObject(item, `draftProposal.moves[${i}]`);
    const from = requireNonEmptyString(move.from, `draftProposal.moves[${i}].from`);
    const to = requireNonEmptyString(move.to, `draftProposal.moves[${i}].to`);
    if (from === to) {
      throw new ValidationError(`draftProposal.moves[${i}]`, "from and to are the same path");
    }
    return { from, to };
  });
}

/**
 * 초안이 요청한 MCP 도구 호출 — state-machine 31절.
 *
 * **형태가 틀린 항목은 버리지 않고 오류로 만든다.** 조용히 버리면 모델은 도구를 요청했다고
 * 믿고 결과를 기다리는데 아무 일도 일어나지 않으며, 그 초안의 patch는 있지도 않은 결과를
 * 전제로 쓰여 있다.
 *
 * `arguments`가 객체여야 한다는 것도 여기서 본다. MCP는 named arguments를 쓰므로 배열이면
 * 우리가 잘못 조립한 것이고(23.4절), **무엇을 승인하는지 정하지 못하는 요청은 승인 대상이
 * 아니라 거부 대상**이다.
 */
function validateMcpCalls(raw: unknown): DraftProposal["mcpCalls"] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ValidationError("draftProposal.mcpCalls", "expected an array");
  if (raw.length === 0) return [];
  return raw.map((item, i) => {
    const call = requireObject(item, `draftProposal.mcpCalls[${i}]`);
    const args = call.arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      throw new ValidationError(`draftProposal.mcpCalls[${i}].arguments`, "expected an object (MCP uses named arguments)");
    }
    return {
      server: requireNonEmptyString(call.server, `draftProposal.mcpCalls[${i}].server`),
      tool: requireNonEmptyString(call.tool, `draftProposal.mcpCalls[${i}].tool`),
      arguments: (args ?? {}) as Record<string, unknown>,
      reason: optionalString(call.reason, `draftProposal.mcpCalls[${i}].reason`),
    };
  });
}

/**
 * `reviewMode`는 **호출자가 준다 — 모델이 주지 않는다.**
 *
 * "어떤 정보를 보고 판정했는가"는 우리가 프롬프트를 어떻게 구성했는지에 대한 사실이다.
 * 모델의 응답에서 읽으면 모델이 "blind로 봤다"고 주장할 수 있게 되고, 그러면 blind/informed
 * 불일치율 지표(product-strategy.md 14절)가 근거를 잃는다. 그래서 ctx의 필수 필드다.
 */
export function validateReviewDecision(
  raw: unknown,
  ctx: { taskId: string; proposalId: string; model: string; createdAt: string; reviewMode: ReviewMode }
): ReviewDecision {
  const o = requireObject(raw, "reviewDecision");
  const verdict = requireEnum(o.verdict, VERDICTS, "reviewDecision.verdict");
  const decision: ReviewDecision = {
    taskId: ctx.taskId,
    proposalId: ctx.proposalId,
    reviewMode: ctx.reviewMode,
    verdict,
    rationale: requireNonEmptyString(o.rationale, "reviewDecision.rationale"),
    revisedPlan: o.revisedPlan === undefined || o.revisedPlan === null
      ? undefined
      : validatePlanSteps(o.revisedPlan, "reviewDecision.revisedPlan"),
    revisedPatch: optionalString(o.revisedPatch, "reviewDecision.revisedPatch"),
    questionsForUser: optionalStringArray(o.questionsForUser, "reviewDecision.questionsForUser"),
    rejectionReason: optionalString(o.rejectionReason, "reviewDecision.rejectionReason"),
    model: ctx.model,
    createdAt: ctx.createdAt,
  };
  assertVerdictConsistency(verdict, decision.questionsForUser, "reviewDecision");
  return decision;
}

export function validateSingleModelFixResult(
  raw: unknown,
  ctx: { taskId: string; model: string; createdAt: string }
): SingleModelFixResult {
  const o = requireObject(raw, "singleModelFixResult");
  // 4b절: REVISE는 이 경로에 존재하지 않는다 — 검토할 초안이 없으므로 "수정 요청"이 성립하지 않는다.
  const verdict = requireEnum(
    o.verdict,
    ["ACCEPT", "REJECT", "NEED_USER_INPUT"] as const,
    "singleModelFixResult.verdict"
  );
  const result: SingleModelFixResult = {
    taskId: ctx.taskId,
    verdict,
    rationale: requireNonEmptyString(o.rationale, "singleModelFixResult.rationale"),
    plan: o.plan === undefined || o.plan === null ? undefined : validatePlanSteps(o.plan, "singleModelFixResult.plan"),
    patch: optionalString(o.patch, "singleModelFixResult.patch"),
    questionsForUser: optionalStringArray(o.questionsForUser, "singleModelFixResult.questionsForUser"),
    rejectionReason: optionalString(o.rejectionReason, "singleModelFixResult.rejectionReason"),
    mcpCalls: validateMcpCalls(o.mcpCalls),
    model: ctx.model,
    createdAt: ctx.createdAt,
  };
  assertVerdictConsistency(verdict, result.questionsForUser, "singleModelFixResult");
  // **도구를 요청했으면 patch가 없어도 된다** (state-machine 31절). 그 patch는 어차피
  // 버려지며, 여기서 거부하면 도구를 요청하는 응답이 검증 단계에서 죽어 라운드가
  // 시작조차 하지 못한다 — 증상은 "모델이 잘못된 응답을 냈다"로 보인다.
  if (verdict === "ACCEPT" && !result.patch && (result.mcpCalls ?? []).length === 0) {
    throw new ValidationError("singleModelFixResult.patch", "verdict=ACCEPT requires a patch");
  }
  return result;
}

function assertVerdictConsistency(verdict: Verdict, questions: string[] | undefined, path: string): void {
  // NEED_USER_INPUT인데 질문이 없으면 AWAITING_USER_INPUT에서 사용자에게 빈 카드를 보여주게 된다.
  if (verdict === "NEED_USER_INPUT" && (questions === undefined || questions.length === 0)) {
    throw new ValidationError(`${path}.questionsForUser`, "verdict=NEED_USER_INPUT requires at least one question");
  }
}

/**
 * run_command 인자 정규화 + 검증.
 *
 * 여기서 거부하는 것은 Rust Policy Gate가 거부하는 것의 부분집합이다 — 같은 규칙을 두 번
 * 구현하는 게 아니라, 명백히 잘못된 요청이 IPC를 타고 넘어가기 전에 걸러 이벤트 로그를
 * 깨끗하게 유지하기 위한 것이다. 최종 판단은 항상 Rust다.
 */
export function normalizeRunCommandArgs(raw: unknown, path = "runCommandArgs"): RunCommandArgs {
  const o = requireObject(raw, path);

  // 설계 문서 5절은 executable, 작업 지침 3.2절은 program을 쓴다. 둘 다 받고 program으로 정규화한다.
  const programRaw = o.program ?? o.executable;
  const program = requireNonEmptyString(programRaw, `${path}.program`);

  // 셸 문자열을 program 필드에 밀어넣는 우회를 막는다. argv 배열이라는 약속이 깨지면
  // 승인 모달의 표시와 실제 실행이 달라질 수 있다(CLAUDE.md 원칙 6).
  if (/[\s;&|><`$\n\r]/.test(program)) {
    throw new ValidationError(
      `${path}.program`,
      `program must be a bare executable name, not a shell string (got ${JSON.stringify(program)})`
    );
  }

  if (o.shell !== undefined && o.shell !== false) {
    throw new ValidationError(`${path}.shell`, "shell execution is not supported; pass argv instead");
  }
  if (typeof o.command === "string") {
    throw new ValidationError(`${path}.command`, "shell command strings are not accepted; pass program + args");
  }

  const args = o.args === undefined ? [] : requireStringArray(o.args, `${path}.args`);
  const cwd = o.cwd === undefined || o.cwd === null || o.cwd === "" ? "." : requireString(o.cwd, `${path}.cwd`);

  const result: RunCommandArgs = { program, args, cwd };
  if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
    result.timeoutMs = requireFiniteNumber(o.timeoutMs, `${path}.timeoutMs`);
  }
  return result;
}

/**
 * workspace 상대경로로 쓰일 문자열의 1차 검증.
 * canonicalize와 symlink 판정은 Rust만 할 수 있으므로(파일 시스템 접근 권한이 Rust에만 있다)
 * 여기서는 명백한 형태만 거른다.
 */
export function assertRelativeWorkspacePath(value: unknown, path = "path"): string {
  const p = requireNonEmptyString(value, path);
  if (p.includes("\0")) throw new ValidationError(path, "path contains a NUL byte");
  const normalized = p.replace(/\\/g, "/");
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new ValidationError(path, `path must not contain ".." segments (got ${JSON.stringify(p)})`);
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new ValidationError(path, `path must be relative to the workspace root (got ${JSON.stringify(p)})`);
  }
  return normalized;
}
