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
  // **체크 단위 이름표는 틀릴 수 있다**(state-machine 54절). 원래 실패하던 테스트가 하나만
  // 있어도 그 체크는 `preexisting`에 들어가고, 이번 변경이 깨뜨린 테스트가 그 안에 숨는다.
  // 이름 단위로 갈린 것이 있으면 그쪽이 정본이다.
  const newTestsByKind = new Map<string, string[]>();
  for (const entry of report.testAttribution ?? []) {
    if (entry.newlyFailing.length > 0) newTestsByKind.set(String(entry.kind), entry.newlyFailing);
  }

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
      // **이름 단위로 새 실패가 있으면 그 체크는 뒤로 밀지 않는다.** 체크 이름표만 보면
      // 회귀가 든 체크가 맨 뒤로 가고, 예산이 모자랄 때 가장 먼저 깎인다.
      const isOld = (k: string) => (preexisting.has(k) && !newTestsByKind.has(k) ? 1 : 0);
      const aNew = isOld(String(a.kind));
      const bNew = isOld(String(b.kind));
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

    const newTests = newTestsByKind.get(String(check.kind));
    failingChecks.push({
      kind: check.kind,
      command: check.command ? [check.command.program, ...check.command.args].join(" ") : undefined,
      exitCode: check.exitCode,
      excerpt: trimmed,
      fileReferences: extractFileReferences(detail),
      // **없으면 키를 두지 않는다.** 빈 배열을 실으면 "새로 깨진 것이 없다"로 읽히는데,
      // 실제로는 "가르지 못했다"일 수 있다(54절).
      ...(newTests ? { newlyFailingTests: newTests } : {}),
    });
  }

  const passing = report.checks.filter((c) => c.status === "PASSED").map((c) => `${c.kind}: pass`);
  const notConfigured = report.checks
    .filter((c) => c.status === "NOT_CONFIGURED")
    .map((c) => `${c.kind}: not configured`);

  // **"손대지 말 것"을 조건 없이 말하지 않는다**(54절).
  //
  // 종전 문장은 체크 단위 이름표만 보고 나왔다. 그래서 원래 실패하던 테스트가 하나 있는
  // 체크에서 이번 변경이 세 개를 더 깨뜨리면, 모델은 **자기가 깨뜨린 세 개를 건드리지
  // 말라고 지시받았다.** 이름 단위로 갈린 것이 있으면 그 사실을 먼저 말한다.
  const stillOld = (report.preexistingFailures ?? []).filter((k) => !newTestsByKind.has(String(k)));
  const mixed = (report.preexistingFailures ?? []).filter((k) => newTestsByKind.has(String(k)));
  const preexistingParts: string[] = [];
  if (stillOld.length > 0) {
    preexistingParts.push(
      `${stillOld.join(", ")} — 이 체크들은 변경 전에도 실패하고 있었다. ` +
        "태스크가 이걸 고치는 것이었다면 고쳐야 하고, 무관하다면 손대지 말 것."
    );
  }
  for (const kind of mixed) {
    preexistingParts.push(
      `${kind} — 변경 전에도 실패하던 것이 있지만, 이번 변경이 새로 깨뜨린 것도 있다: ` +
        `${(newTestsByKind.get(String(kind)) ?? []).join(", ")}. 그 쪽을 먼저 고칠 것.`
    );
  }
  const preexistingSummary = preexistingParts.length > 0 ? preexistingParts.join("\n") : undefined;

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
