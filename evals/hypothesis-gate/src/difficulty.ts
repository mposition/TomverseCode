import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoadedFixture } from "./manifest.js";
import { runVerification } from "./oracle.js";
import { injectOracle, materialize } from "./workspace.js";

/**
 * **무엇을 "어렵다"고 정의할 것인가** — product-strategy.md 12절 미해결 항목.
 *
 * # 라벨이 이미 쓰이고 있었다
 *
 * 이 fixture 세트는 "어려운 태스크 24개"로 불리고, 사전 등록된 판정 기준(`criteria.ts`)에도
 * *"유효한 어려운 fixture 최소 24개"* 라고 적혀 있다. 그런데 `validate`가 확인하는 것은
 * **유효성**이지 난이도가 아니었다 — 풀 수 있는가, oracle이 새는가, 부정행위로 통과되는가.
 * 어려운지는 아무도 검사하지 않았고, 정의조차 어디에도 없었다.
 *
 * 그 사이에 라벨을 쓰는 측정이 하나 생겼다(state-machine-and-protocol.md 13.4절의 TRIAGE
 * 캘리브레이션은 이 24개를 "어려움" 정답지로 쓴다). **근거 없는 라벨 위에 측정이 올라가면,
 * 그 측정의 결론은 라벨만큼만 참이다.**
 *
 * # 정의를 outcome으로 두면 순환이거나 유료다
 *
 * 가장 자연스러운 정의는 "가장 강한 단일 모델이 실패한다"이다. 그런데 그건 (a) 유료 실행을
 * 해야 알 수 있고 (b) 게이트가 재려는 것과 같은 축을 미리 정해버린다. 정의가 실험의 결론을
 * 앞질러서는 안 된다.
 *
 * # 그래서 구조로 정의한다: **눈에 보이는 신호가 정답을 결정하는가**
 *
 * 모델이 관측할 수 있는 것은 태스크 설명과 workspace 안의 공개 검증뿐이다. 그 신호만으로
 * 정답이 결정된다면, 그 태스크는 "돌려보고 고치기"를 반복해서 풀 수 있다 — 어렵지 않다.
 *
 * 신호가 정답을 결정하지 못하는 방식은 둘이다.
 *
 * 1. **증상이 보이지 않는다** — 고치기 전인데 공개 검증이 통과한다. 모델은 문제가 있다는
 *    것조차 관측할 수 없다.
 * 2. **부분적인 수정이 완성처럼 보인다** — 참조 수정의 한 조각을 빼먹어도 공개 검증은
 *    아무 말도 하지 않는데 oracle은 실패한다.
 *
 * 둘 다 아니면 **보이는 신호가 정답을 결정한다**(`fully_visible`).
 *
 * 이 정의는 모델을 부르지 않고, 게이트의 가설과 같은 축을 쓰지 않으며, **fixture에 새 파일을
 * 추가하지 않는다** — 이미 있는 `workspace/`와 `reference.patch`에서 유도된다. 그래서
 * "어렵게 보이도록 자료를 손보는" 경로가 없다.
 *
 * # 이 정의가 말하지 않는 것
 *
 * `hidden_symptom`/`partial_fix_looks_complete`가 **모델이 실패한다**는 뜻은 아니다. 모델은
 * 코드를 읽고 추론하지 실행만 하는 것이 아니다. 여기서 확인하는 것은 **불완전한 요구**라는
 * 구조적 성질이고, 그게 이 제품이 교차검증으로 다루려는 바로 그 성질이다(product-strategy 9절).
 */

export type DifficultyKind = "hidden_symptom" | "partial_fix_looks_complete" | "fully_visible";

/** 참조 수정에서 잘라낸 한 덩어리. 되돌리기의 단위다. */
export interface Hunk {
  file: string;
  /** 참조 내용에서의 시작 줄(0부터). 사람이 읽는 용도. */
  at: number;
  /** 이 덩어리를 되돌리면 몇 줄이 원래대로 돌아가는가. */
  lines: number;
}

export interface Ablation {
  hunk: Hunk;
  publicPassed: boolean;
  oraclePassed: boolean;
  /**
   * **빼먹어도 공개 신호가 아무 말도 하지 않는다.**
   *
   * `publicPassed && !oraclePassed`. 이게 하나라도 있으면 "다 고친 것처럼 보이는데 아니다"가
   * 성립한다.
   */
  invisible: boolean;
}

export interface DifficultyResult {
  fixtureId: string;
  kind: DifficultyKind;
  /**
   * 이 환경에서 판정할 수 있었는가.
   *
   * 네이티브 툴체인이 없으면 Rust fixture는 명령이 실행조차 되지 않는다. 그때
   * **`fully_visible`로 떨어뜨리지 않는다** — "쉽다"와 "못 쟀다"는 다른 사실이고,
   * 뭉개면 툴체인이 없는 기계에서 fixture 세트가 조용히 쉬워 보인다.
   */
  measured: boolean;
  notMeasuredReason?: string;
  /** 고치기 전에 공개 검증이 통과했는가 — `hidden_symptom`의 근거. */
  publicPassesBeforeFix: boolean;
  hunks: number;
  ablations: Ablation[];
}

// ---- 줄 단위 diff ----

/**
 * 두 줄 목록의 최장 공통 부분열을 구해 **바뀐 구간**만 돌려준다.
 *
 * 파일이 수십 줄이므로 O(n·m) DP로 충분하다. 라이브러리를 쓰지 않는 이유는 이 패키지가
 * 의존성 없이 도는 것을 원칙으로 하기 때문이다(fixture도 같은 원칙이다).
 */
export function changedRegions(
  original: readonly string[],
  reference: readonly string[]
): { refStart: number; refEnd: number; origStart: number; origEnd: number }[] {
  const n = original.length;
  const m = reference.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = original[i] === reference[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const regions: { refStart: number; refEnd: number; origStart: number; origEnd: number }[] = [];
  let i = 0;
  let j = 0;
  let pending: { refStart: number; origStart: number } | null = null;
  const close = (): void => {
    if (pending && (pending.refStart !== j || pending.origStart !== i)) {
      regions.push({ refStart: pending.refStart, refEnd: j, origStart: pending.origStart, origEnd: i });
    }
    pending = null;
  };
  while (i < n && j < m) {
    if (original[i] === reference[j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    pending ??= { refStart: j, origStart: i };
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
    else j += 1;
  }
  if (i < n || j < m) {
    pending ??= { refStart: j, origStart: i };
    i = n;
    j = m;
  }
  close();
  return regions;
}

interface PatchFile {
  path: string;
  content: string;
}

function readReferenceFiles(fixture: LoadedFixture): PatchFile[] {
  const parsed = JSON.parse(readFileSync(fixture.referencePatchPath, "utf8")) as { files?: PatchFile[] };
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`${fixture.manifest.fixtureId}: reference.patch에 files가 없습니다`);
  }
  return parsed.files;
}

function originalContent(fixture: LoadedFixture, relPath: string): string | null {
  const full = path.join(fixture.workspaceDir, relPath);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/** 참조 수정을 되돌리기 단위로 쪼갠다. */
export function hunksOf(fixture: LoadedFixture): { hunk: Hunk; write: (root: string) => void }[] {
  const out: { hunk: Hunk; write: (root: string) => void }[] = [];
  const files = readReferenceFiles(fixture);

  for (const file of files) {
    const before = originalContent(fixture, file.path);
    if (before === null) {
      // 참조 수정이 새로 만든 파일. 되돌리기 = 만들지 않기. 한 덩어리다.
      out.push({
        hunk: { file: file.path, at: 0, lines: file.content.split("\n").length },
        write: (root) => {
          for (const other of files) {
            if (other.path === file.path) continue;
            writeFile(root, other.path, other.content);
          }
          const target = path.join(root, file.path);
          if (existsSync(target)) rmSync(target, { force: true });
        },
      });
      continue;
    }

    const originalLines = before.split("\n");
    const referenceLines = file.content.split("\n");
    for (const region of changedRegions(originalLines, referenceLines)) {
      const reverted = [
        ...referenceLines.slice(0, region.refStart),
        ...originalLines.slice(region.origStart, region.origEnd),
        ...referenceLines.slice(region.refEnd),
      ].join("\n");
      out.push({
        hunk: {
          file: file.path,
          at: region.refStart,
          lines: Math.max(region.refEnd - region.refStart, region.origEnd - region.origStart),
        },
        // **다른 파일은 참조 그대로 쓴다.** 한 덩어리만 빼먹은 상태를 만드는 것이 목적이므로,
        // 나머지가 원본이면 그건 "덜 고친" 것이 아니라 "거의 안 고친" 것이 된다.
        write: (root) => {
          for (const other of files) {
            writeFile(root, other.path, other.path === file.path ? reverted : other.content);
          }
        },
      });
    }
  }
  return out;
}

function writeFile(root: string, relPath: string, content: string): void {
  const target = path.join(root, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * fixture 하나의 난이도를 판정한다. **모델 호출 없음.**
 */
export function assessDifficulty(fixture: LoadedFixture): DifficultyResult {
  const manifest = fixture.manifest;

  // ---- 1. 증상이 보이는가 ----
  const asIs = materialize(fixture, `${manifest.fixtureId}-difficulty-initial`);
  let publicPassesBeforeFix = false;
  let toolchainError: string | undefined;
  try {
    const outcome = runVerification(manifest.publicVerificationCommands, asIs.root, manifest.timeoutMs);
    publicPassesBeforeFix = outcome.passed;
    toolchainError = outcome.toolchainError;
  } finally {
    asIs.cleanup();
  }

  if (toolchainError !== undefined) {
    return {
      fixtureId: manifest.fixtureId,
      kind: "fully_visible",
      measured: false,
      notMeasuredReason: `툴체인이 없어 공개 검증을 실행하지 못했습니다: ${toolchainError}`,
      publicPassesBeforeFix: false,
      hunks: 0,
      ablations: [],
    };
  }

  if (publicPassesBeforeFix) {
    // 고치기 전인데 공개 검증이 통과한다 — 모델은 문제가 있다는 것조차 관측할 수 없다.
    // 부분 되돌리기를 더 볼 필요가 없다: 이미 신호가 정답을 결정하지 못한다.
    return {
      fixtureId: manifest.fixtureId,
      kind: "hidden_symptom",
      measured: true,
      publicPassesBeforeFix: true,
      hunks: 0,
      ablations: [],
    };
  }

  // ---- 2. 부분적인 수정이 완성처럼 보이는가 ----
  const ablations: Ablation[] = [];
  const pieces = hunksOf(fixture);
  for (const piece of pieces) {
    const work = materialize(fixture, `${manifest.fixtureId}-ablate-${piece.hunk.at}`);
    try {
      piece.write(work.root);
      const publicOutcome = runVerification(manifest.publicVerificationCommands, work.root, manifest.timeoutMs);
      injectOracle(fixture, work.root);
      const oracleOutcome = runVerification(manifest.oracleVerificationCommands, work.root, manifest.timeoutMs);
      ablations.push({
        hunk: piece.hunk,
        publicPassed: publicOutcome.passed,
        oraclePassed: oracleOutcome.passed,
        invisible: publicOutcome.passed && !oracleOutcome.passed,
      });
    } finally {
      work.cleanup();
    }
  }

  return {
    fixtureId: manifest.fixtureId,
    kind: ablations.some((a) => a.invisible) ? "partial_fix_looks_complete" : "fully_visible",
    measured: true,
    publicPassesBeforeFix: false,
    hunks: pieces.length,
    ablations,
  };
}

/** 세트 전체의 요약. */
export interface DifficultySummary {
  results: DifficultyResult[];
  hard: number;
  fullyVisible: number;
  notMeasured: number;
}

export function summarizeDifficulty(results: readonly DifficultyResult[]): DifficultySummary {
  return {
    results: [...results],
    hard: results.filter((r) => r.measured && r.kind !== "fully_visible").length,
    fullyVisible: results.filter((r) => r.measured && r.kind === "fully_visible").length,
    notMeasured: results.filter((r) => !r.measured).length,
  };
}

export function describeDifficulty(kind: DifficultyKind): string {
  switch (kind) {
    case "hidden_symptom":
      return "증상이 보이지 않음 (고치기 전에도 공개 검증이 통과)";
    case "partial_fix_looks_complete":
      return "부분 수정이 완성처럼 보임 (한 조각을 빼먹어도 공개 검증이 통과)";
    case "fully_visible":
      return "보이는 신호가 정답을 결정함";
  }
}
