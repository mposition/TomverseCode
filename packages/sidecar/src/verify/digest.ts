import type { VerificationDigest, VerificationReport } from "@tomverse/protocol";

/**
 * `VerificationReport` → `VerificationDigest` — docs/design/state-machine-and-protocol.md 6절.
 *
 * 전체 로그를 매 FIX_LOOP마다 다시 보내면 토큰 예산이 소진되고 `fixLoopRounds`가 올라갈수록
 * 컨텍스트가 누적 팽창한다. 실패한 체크만 상세히, 통과한 체크는 한 줄로 줄인다.
 */

export interface DigestOptions {
  headLines?: number;
  tailLines?: number;
  /** 다이제스트 전체의 문자 상한. 넘으면 우선순위 낮은 체크의 excerpt부터 줄인다. */
  maxChars?: number;
}

/** 6절: build/test 실패는 마지막까지 보존하고, lint 같은 낮은 우선순위부터 줄인다. */
const PRIORITY: Record<string, number> = { build: 0, test: 1, typecheck: 2, lint: 3, diff_review: 4 };

export function buildDigest(report: VerificationReport, options: DigestOptions = {}): VerificationDigest {
  const headLines = options.headLines ?? 40;
  const tailLines = options.tailLines ?? 40;
  const maxChars = options.maxChars ?? 12_000;

  const preexisting = new Set((report.preexistingFailures ?? []).map(String));

  // 실패한 체크는 pre-existing 여부와 무관하게 모두 전달한다.
  //
  // 처음에는 pre-existing 실패를 제외했는데, 그러면 "실패하는 테스트를 고쳐줘"라는 태스크에서
  // 정작 고쳐야 할 그 실패가 다이제스트에서 빠진다(대상 테스트는 당연히 baseline에서도 실패한다).
  // 모델에게 아무 근거도 주지 않고 수정을 요구하는 셈이므로, 전달하되 어느 것이 이번 변경으로
  // 새로 깨진 것인지를 함께 표시해 우선순위를 판단할 수 있게 한다.
  const failing = report.checks
    .filter((c) => c.status === "FAILED" || c.status === "TIMED_OUT")
    .sort((a, b) => {
      // 새로 깨진 것을 먼저 — 이번 변경이 유발한 회귀가 가장 시급하다.
      const aNew = preexisting.has(String(a.kind)) ? 1 : 0;
      const bNew = preexisting.has(String(b.kind)) ? 1 : 0;
      if (aNew !== bNew) return aNew - bNew;
      return (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9);
    });

  let budget = maxChars;
  const failingChecks: VerificationDigest["failingChecks"] = [];

  for (const check of failing) {
    const detail = check.detail ?? "";
    const excerpt = headTail(detail, headLines, tailLines);
    // 예산이 부족하면 excerpt를 더 줄인다. 체크 자체를 빼지는 않는다 —
    // "실패했다"는 사실이 사라지면 모델이 무엇을 고쳐야 할지 모른다.
    const allowed = Math.max(400, Math.floor(budget / Math.max(1, failing.length - failingChecks.length)));
    const trimmed = excerpt.length > allowed ? headTail(excerpt, 10, 10).slice(0, allowed) : excerpt;
    budget -= trimmed.length;

    failingChecks.push({
      kind: check.kind,
      command: check.command ? [check.command.program, ...check.command.args].join(" ") : undefined,
      exitCode: check.exitCode,
      excerpt: trimmed,
      fileReferences: extractFileReferences(detail),
    });
  }

  const passing = report.checks.filter((c) => c.status === "PASSED").map((c) => `${c.kind}: pass`);
  const notConfigured = report.checks
    .filter((c) => c.status === "NOT_CONFIGURED")
    .map((c) => `${c.kind}: not configured`);

  const preexistingSummary =
    (report.preexistingFailures ?? []).length > 0
      ? `${(report.preexistingFailures ?? []).join(", ")} — 이 체크들은 변경 전에도 실패하고 있었다. ` +
        "태스크가 이걸 고치는 것이었다면 고쳐야 하고, 무관하다면 손대지 말 것."
      : undefined;

  return {
    taskId: report.taskId,
    reportId: report.reportId,
    attemptNumber: report.attemptNumber,
    failingChecks,
    // NOT_CONFIGURED를 "통과"에 섞지 않는다 — 그건 통과가 아니다.
    passingChecksSummary: [...passing, ...notConfigured].join(", "),
    preexistingFailuresSummary: preexistingSummary,
  };
}

/**
 * 컴파일러/테스트 출력에서 `path:line` 형태를 뽑는다 (6절 `fileReferences`).
 * 모델이 어디를 봐야 하는지 알려주는 힌트이며, 정확하지 않아도 해가 없다.
 */
export function extractFileReferences(text: string): { path: string; line?: number }[] {
  const found = new Map<string, { path: string; line?: number }>();
  const patterns = [
    // tsc: src/app.ts(12,5): error TS2345
    /([\w./\\-]+\.[a-zA-Z]{1,5})\((\d+),\d+\)/g,
    // node/jest/rustc/gcc: src/app.ts:12:5 또는 src/app.ts:12
    /([\w./\\-]+\.[a-zA-Z]{1,5}):(\d+)(?::\d+)?/g,
    // rustc: --> src/main.rs:12:5
    /-->\s+([\w./\\-]+\.[a-zA-Z]{1,5}):(\d+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const path = (match[1] as string).replace(/\\/g, "/");
      const line = Number(match[2]);
      const key = `${path}:${line}`;
      if (!found.has(key) && found.size < 20) {
        found.set(key, { path, line: Number.isFinite(line) ? line : undefined });
      }
    }
  }
  return [...found.values()];
}

export function headTail(text: string, head: number, tail: number): string {
  const lines = text.split("\n");
  if (lines.length <= head + tail) return text;
  const omitted = lines.length - head - tail;
  return [...lines.slice(0, head), `… (${omitted} lines omitted) …`, ...lines.slice(lines.length - tail)].join("\n");
}
