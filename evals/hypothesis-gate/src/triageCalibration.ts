import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComplexityTier } from "@tomverse/protocol";
import { DEFAULT_TRIAGE_POLICY, tierAtThreshold } from "@tomverse/sidecar/triage";
import { readEvents, runHost, type StoredEvent } from "./host.js";
import { listFixtureIds, loadFixture } from "./manifest.js";

/**
 * TRIAGE 임계값 캘리브레이션 — state-machine-and-protocol.md 12절 미해결 항목.
 *
 * # 이 항목은 유료 API를 기다리고 있지 않았다
 *
 * 12절은 이렇게 적혀 있었다: *"13.2절 TRIAGE 규칙의 실제 임계값 — 스파이크의 5개 초소형
 * 태스크만으로는 튜닝 근거가 부족함. **'어려운' 태스크 세트로 스파이크를 재실행**해 규칙을
 * 검증/조정 필요."*
 *
 * 그래서 이 항목은 "유료 API 필요"로 분류되어 있었다. 그런데 **TRIAGE는 모델을 부르지 않는다**
 * (13.2절이 규칙 기반인 이유이자 `triage.ts` 첫 주석). 규칙의 입력은 워크스페이스 스냅샷과
 * 사용자 메시지뿐이고, 둘 다 모델이 한 마디도 하기 전에 정해진다. 재실행이 필요했던 것은
 * **스파이크가 그때 유일한 어려운 태스크 공급원이었기 때문**이지, 판정에 모델이 필요해서가
 * 아니었다.
 *
 * 지금은 어려운 태스크 세트가 따로 있다 — 이 패키지의 fixture 24개이고, `validate`가
 * 오프라인으로 품질을 확인한다. 그러므로 필요한 것은 유료 실행이 아니라 **난이도 라벨이 붙은
 * 태스크에 규칙을 태워 보는 것**이다.
 *
 * # 라벨은 어디서 오는가
 *
 * - **어려움**: 이 패키지의 fixture 24개. 어렵다는 것이 fixture 세트의 정의이고 사전 등록되어 있다.
 * - **쉬움**: Phase 0 스파이크의 5개. 단일 모델이 5/5 통과했다는 실측이 있고(CLAUDE.md),
 *   그래서 "쉽다"가 관측된 사실이다. 스파이크는 **읽기만 한다** — 실험 기록은 수정하지 않는다.
 *
 * 두 라벨이 모두 있어야 하는 이유는 오류가 두 종류이기 때문이다. 어려운 세트만 보면
 * "전부 standard로 보내라"가 만점을 받는데, 그건 TRIAGE를 없애자는 말과 같다.
 *
 * # 왜 fake 공급자로 재도 되는가 — 주장하지 않고 증명한다
 *
 * CLAUDE.md는 **fake provider 결과로 가설을 판정하지 말라**고 못박는다. 그 규칙이 지키는 것은
 * *모델 출력에 의존하는 판정*이고, TRIAGE의 판정은 모델 출력에 의존하지 않는다.
 *
 * 그러나 "의존하지 않는다"를 주석으로 주장하면 나중에 의존하게 되어도 주석은 그대로 남는다.
 * 그래서 관측마다 **이벤트 순서로 증명한다**: `TRIAGE_COMPLETED`의 `seq`가 첫
 * `PROVIDER_USAGE`보다 앞서야 하고, 하나라도 어긋나면 이 캘리브레이션 전체가 무효다.
 */

export type DifficultyLabel = "hard" | "easy";

export interface LabeledTask {
  id: string;
  label: DifficultyLabel;
  /** 라벨의 근거가 어디에 있는지 — 리포트에 그대로 나간다. */
  source: string;
  taskPrompt: string;
  /** workspace를 임시 디렉터리에 만든다. 원본은 건드리지 않는다. */
  materialize(): { root: string; cleanup(): void };
}

function tempWorkspace(label: string, fill: (root: string) => void): { root: string; cleanup(): void } {
  const safe = label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40);
  const root = mkdtempSync(path.join(tmpdir(), `triage-${safe}-`));
  fill(root);
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 정리 실패로 관측을 잃지 않는다.
      }
    },
  };
}

/** 어려운 라벨 — 이 패키지의 fixture. */
export function loadHardTasks(fixturesRoot: string, only?: readonly string[]): LabeledTask[] {
  const ids = only && only.length > 0 ? [...only] : listFixtureIds(fixturesRoot);
  return ids.map((id) => {
    const fixture = loadFixture(fixturesRoot, id);
    return {
      id,
      label: "hard" as const,
      source: `gate fixture (${fixture.manifest.category})`,
      taskPrompt: fixture.manifest.taskPrompt,
      materialize: () =>
        tempWorkspace(id, (root) => {
          cpSync(fixture.workspaceDir, root, { recursive: true });
        }),
    };
  });
}

/**
 * 쉬운 라벨 — Phase 0 스파이크 fixture.
 *
 * 디렉터리가 없으면 **빈 배열이 아니라 예외**다. "없는 경로"와 "빈 디렉터리"는 다른 사실이고,
 * 빈 배열로 돌려주면 쉬운 라벨이 통째로 빠진 채 리포트가 조용히 나온다.
 */
export function loadEasyTasks(spikeFixturesRoot: string): LabeledTask[] {
  if (!existsSync(spikeFixturesRoot)) {
    throw new Error(`스파이크 fixture 디렉터리가 없습니다: ${spikeFixturesRoot}`);
  }
  const dirs = readdirSync(spikeFixturesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  return dirs.map((dirName) => {
    const dir = path.join(spikeFixturesRoot, dirName);
    const files = readdirSync(dir);
    const testFile = files.find((f) => f.endsWith(".test.js"));
    const buggyFile = files.find((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    if (!testFile || !buggyFile || !files.includes("task.md")) {
      throw new Error(`스파이크 fixture ${dirName}의 모양이 다릅니다: ${files.join(", ")}`);
    }
    const prompt = readFileSync(path.join(dir, "task.md"), "utf8").trim();
    return {
      id: dirName,
      label: "easy" as const,
      source: "Phase 0 스파이크 (단일 모델 5/5 통과 — 쉬움이 관측된 사실이다)",
      taskPrompt: prompt,
      materialize: () =>
        tempWorkspace(dirName, (root) => {
          cpSync(path.join(dir, buggyFile), path.join(root, buggyFile));
          cpSync(path.join(dir, testFile), path.join(root, testFile));
          // 스파이크는 `fixtures/package.json` 하나를 공유한다. 태스크별 workspace로 옮기려면
          // 그 파일을 함께 넣어야 Node가 CommonJS로 읽는다.
          writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
        }),
    };
  });
}

/** 규칙이 남긴 근거. `TRIAGE_COMPLETED` payload에서 그대로 온다. */
export interface TriageEvidence {
  workFileCount: number;
  excludedTestFiles: string[];
  riskKeywordMatched: boolean;
  uncommittedChanges: boolean;
}

export interface TriageObservation {
  id: string;
  label: DifficultyLabel;
  source: string;
  /** 규칙이 실제로 판정한 tier. 관측하지 못했으면 `null`이다. */
  tier: ComplexityTier | null;
  evidence: TriageEvidence | null;
  /** 테스트 파일을 세었더라면 나왔을 tier (규칙이 기록한 반사실). */
  tierIfTestsCounted: ComplexityTier | null;
  /**
   * `TRIAGE_COMPLETED`가 첫 공급자 호출보다 앞섰는가.
   *
   * 공급자 호출이 아예 없었으면 `true`다 — 앞선 것이 맞다.
   */
  decidedBeforeAnyProviderCall: boolean;
  /**
   * 이 실행에서 공급자 호출이 **실제로 일어났는가.**
   *
   * 순서 증명의 강도가 여기에 달려 있다: 호출이 한 번도 없었다면 "판정이 호출보다 앞섰다"는
   * 공허하게 참이다. 그래서 개수를 세어 두고, 전부 0이면 증명으로 치지 않는다.
   */
  providerCallObserved: boolean;
  /** 관측하지 못한 이유. `tier`가 `null`일 때만 채워진다. */
  notObservedReason?: string;
  wallClockMs: number;
}

/**
 * 규칙이 판정하도록 두고(`--mode fast`) 그 판정을 읽는다.
 *
 * `appliedPolicies`가 비어 있지 않으면 **규칙이 돌지 않은 것**이다(모드 강제·tier 강제).
 * 그 경우 tier는 규칙에 대해 아무것도 말하지 않으므로 관측으로 세지 않는다 —
 * 세면 분모가 부풀어 오분류율이 실제보다 낮아 보인다.
 */
export function observationFromEvents(
  task: LabeledTask,
  events: readonly StoredEvent[],
  wallClockMs: number,
  fallbackReason?: string
): TriageObservation {
  const triageEvent = events.find((e) => e.type === "TRIAGE_COMPLETED");
  const firstProviderCall = events.find((e) => e.type === "PROVIDER_USAGE");
  const base = {
    id: task.id,
    label: task.label,
    source: task.source,
    providerCallObserved: firstProviderCall !== undefined,
    wallClockMs,
  };

  const decidedBeforeAnyProviderCall =
    triageEvent !== undefined && (firstProviderCall === undefined || triageEvent.seq < firstProviderCall.seq);

  if (!triageEvent) {
    return {
      ...base,
      tier: null,
      evidence: null,
      tierIfTestsCounted: null,
      decidedBeforeAnyProviderCall: false,
      notObservedReason: fallbackReason ?? "TRIAGE_COMPLETED 이벤트가 없습니다",
    };
  }

  const payload = triageEvent.payload as {
    complexityTier?: string;
    appliedPolicies?: string[];
    workFileCount?: number;
    excludedTestFiles?: string[];
    riskKeywordMatched?: boolean;
    uncommittedChanges?: boolean;
    tierIfTestsCounted?: string;
  };

  const applied = payload.appliedPolicies ?? [];
  if (applied.length > 0) {
    return {
      ...base,
      tier: null,
      evidence: null,
      tierIfTestsCounted: null,
      decidedBeforeAnyProviderCall,
      notObservedReason: `규칙이 돌지 않았습니다: ${applied.join(" / ")}`,
    };
  }

  // 근거 필드가 하나라도 없으면 스윕을 할 수 없다. 그때 `tier` 하나만 들고 통과시키면
  // 임계값 표가 **기본값 한 줄에 대해서만** 맞고 나머지 줄은 조용히 틀린다.
  if (
    typeof payload.workFileCount !== "number" ||
    !Array.isArray(payload.excludedTestFiles) ||
    typeof payload.riskKeywordMatched !== "boolean" ||
    typeof payload.uncommittedChanges !== "boolean"
  ) {
    return {
      ...base,
      tier: null,
      evidence: null,
      tierIfTestsCounted: null,
      decidedBeforeAnyProviderCall,
      notObservedReason: "TRIAGE_COMPLETED에 임계값을 다시 계산할 근거가 없습니다",
    };
  }

  return {
    ...base,
    tier: payload.complexityTier === "standard" ? "standard" : "simple",
    evidence: {
      workFileCount: payload.workFileCount,
      excludedTestFiles: payload.excludedTestFiles,
      riskKeywordMatched: payload.riskKeywordMatched,
      uncommittedChanges: payload.uncommittedChanges,
    },
    tierIfTestsCounted: payload.tierIfTestsCounted === "standard" ? "standard" : "simple",
    decidedBeforeAnyProviderCall,
  };
}

export interface ObserveOptions {
  /** 후보 공급자. 기본은 레지스트리의 fake 항목 — 네트워크로 나가지 않는다. */
  providers?: string[];
  fakeScript?: unknown;
  timeoutMs?: number;
}

/** 하네스 전용 fake 공급자. `local://` 주소라 네트워크로 나가지 않는다(registry.ts). */
export const FAKE_PROVIDERS = Object.freeze(["fake-a", "fake-b"]);

/**
 * fake 초안. **적용될 필요는 없지만 비어 있어서도 안 된다.**
 *
 * TRIAGE는 초안보다 먼저 끝나므로 patch 내용은 판정에 영향이 없다. 그런데 빈 patch는
 * 스키마 위반으로 **공급자 호출이 기록되기 전에** 태스크를 끝내고, 그러면
 * `decidedBeforeAnyProviderCall`이 "호출이 없어서 참"이 된다 — 증명이 공허해진다(실측).
 * 적용에 실패해도 좋으니 호출은 일어나야 한다.
 */
const FAKE_SCRIPT = {
  defaultPatch: ["--- a/none.js", "+++ b/none.js", "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"),
};

export function observeTriage(task: LabeledTask, options: ObserveOptions = {}): TriageObservation {
  const workspace = task.materialize();
  const started = Date.now();
  try {
    const result = runHost({
      workspaceRoot: workspace.root,
      taskPrompt: task.taskPrompt,
      providers: [...(options.providers ?? FAKE_PROVIDERS)],
      // **이 한 줄이 측정 대상이다.** verified를 주면 규칙이 아예 돌지 않는다.
      executionMode: "fast",
      taskId: `triage-${task.id}`,
      timeoutMs: options.timeoutMs ?? 180_000,
      fakeScript: options.fakeScript ?? FAKE_SCRIPT,
    });
    const events = readEvents(result.dbPath, workspace.root, result.taskId);
    const reason = result.spawnError
      ? `호스트를 실행하지 못했습니다: ${result.spawnError}`
      : `호스트가 TRIAGE에 도달하지 못했습니다 (${result.status}: ${result.summary.slice(0, 120)})`;
    return observationFromEvents(task, events, Date.now() - started, reason);
  } finally {
    workspace.cleanup();
  }
}

// ---- 스윕 ----

export interface ThresholdRow {
  maxRelevantFiles: number;
  countTestFiles: boolean;
  /** 어려운 태스크를 단일 모델 경로로 보낸 횟수. 대가는 잘못된 완료 위험이다. */
  hardRoutedSimple: number;
  /** 쉬운 태스크를 교차검증 경로로 보낸 횟수. 대가는 Phase 0 실측(비용 1.63배, 지연 1.70배)이다. */
  easyRoutedStandard: number;
  /** 이 후보를 지배하는 다른 후보가 있는가 — 둘 다 나쁘지 않고 하나는 더 나은 후보. */
  dominated: boolean;
}

/** 라벨별 작업 파일 개수 분포. **축이 라벨을 가르는가**를 표가 아니라 데이터로 말한다. */
export interface CountDistribution {
  /** `workFileCount` → 건수 */
  hard: Record<number, number>;
  easy: Record<number, number>;
  /** 두 라벨이 함께 나타나는 파일 개수 값 — 이 값들에서 축은 아무것도 구별하지 못한다. */
  sharedCounts: number[];
  /** 그 겹치는 값에 들어 있는 태스크 수 */
  indistinguishable: number;
}

export interface CalibrationSummary {
  observations: TriageObservation[];
  hardObserved: number;
  easyObserved: number;
  notObserved: number;
  distribution: CountDistribution;
  /** 공급자 호출이 실제로 일어난 관측 수. 0이면 순서 증명이 공허하다. */
  runsWithProviderCall: number;
  /** 모든 관측에서 판정이 첫 공급자 호출보다 앞섰는가. 거짓이면 이 표를 믿을 수 없다. */
  modelIndependent: boolean;
  /** 현재 기본 정책이 만드는 결과 — 표의 어느 줄인지 가리킨다. */
  current: ThresholdRow | null;
  rows: ThresholdRow[];
  /** 표를 읽을 수 없는 이유. 비어 있어야 한다. */
  blockers: string[];
}

/**
 * 후보 임계값들의 오분류 표.
 *
 * **합계로 순위를 매기지 않는다.** 두 오류의 대가가 다르기 때문이다: 어려운 태스크를 simple로
 * 보내면 검증 없이 완료로 보고될 위험이고, 쉬운 태스크를 standard로 보내면 Phase 0이 실측한
 * 낭비(정확도 이득 0%, 비용 1.63배)다. 두 값을 하나의 점수로 합치려면 교환비가 필요하고,
 * 그 교환비는 아직 아무도 정하지 않았다 — 정한 척하면 표가 사람 대신 결정해 버린다.
 *
 * 대신 **지배 관계만** 표시한다. 이건 교환비가 없어도 성립한다: 두 값이 모두 나쁘지 않고
 * 하나가 더 나은 후보가 있으면, 지배당한 쪽은 어떤 교환비에서도 답이 아니다.
 */
export function sweepThresholds(
  observations: readonly TriageObservation[],
  candidates: readonly number[]
): ThresholdRow[] {
  const usable = observations.filter((o) => o.evidence !== null);
  const rows: ThresholdRow[] = [];
  for (const countTestFiles of [false, true]) {
    for (const maxRelevantFiles of candidates) {
      let hardRoutedSimple = 0;
      let easyRoutedStandard = 0;
      for (const o of usable) {
        const tier = tierAtThreshold(o.evidence!, maxRelevantFiles, countTestFiles);
        if (o.label === "hard" && tier === "simple") hardRoutedSimple += 1;
        if (o.label === "easy" && tier === "standard") easyRoutedStandard += 1;
      }
      rows.push({ maxRelevantFiles, countTestFiles, hardRoutedSimple, easyRoutedStandard, dominated: false });
    }
  }
  for (const row of rows) {
    row.dominated = rows.some(
      (other) =>
        other !== row &&
        other.hardRoutedSimple <= row.hardRoutedSimple &&
        other.easyRoutedStandard <= row.easyRoutedStandard &&
        (other.hardRoutedSimple < row.hardRoutedSimple || other.easyRoutedStandard < row.easyRoutedStandard)
    );
  }
  return rows;
}

/** 후보 임계값 목록 — 관측된 파일 수 범위를 덮는다. 범위 밖 후보는 표에 줄만 늘린다. */
export function thresholdCandidates(observations: readonly TriageObservation[]): number[] {
  const counts = observations
    .filter((o) => o.evidence !== null)
    .map((o) => o.evidence!.workFileCount + o.evidence!.excludedTestFiles.length);
  const max = counts.length > 0 ? Math.max(...counts) : DEFAULT_TRIAGE_POLICY.maxRelevantFiles;
  return Array.from({ length: max + 1 }, (_, i) => i);
}

export function distributionOf(observations: readonly TriageObservation[]): CountDistribution {
  const hard: Record<number, number> = {};
  const easy: Record<number, number> = {};
  for (const o of observations) {
    if (!o.evidence) continue;
    const bucket = o.label === "hard" ? hard : easy;
    bucket[o.evidence.workFileCount] = (bucket[o.evidence.workFileCount] ?? 0) + 1;
  }
  const sharedCounts = Object.keys(hard)
    .map(Number)
    .filter((n) => easy[n] !== undefined)
    .sort((a, b) => a - b);
  const indistinguishable = sharedCounts.reduce((sum, n) => sum + (hard[n] ?? 0) + (easy[n] ?? 0), 0);
  return { hard, easy, sharedCounts, indistinguishable };
}

export function summarize(observations: readonly TriageObservation[]): CalibrationSummary {
  const usable = observations.filter((o) => o.evidence !== null);
  const hardObserved = usable.filter((o) => o.label === "hard").length;
  const easyObserved = usable.filter((o) => o.label === "easy").length;

  const blockers: string[] = [];
  if (hardObserved === 0) blockers.push("어려운 라벨 관측이 없습니다");
  if (easyObserved === 0) {
    blockers.push("쉬운 라벨 관측이 없습니다 — 어려운 쪽만 보면 '전부 standard'가 만점을 받습니다");
  }
  const modelIndependent = observations.every((o) => o.decidedBeforeAnyProviderCall || o.tier === null);
  if (!modelIndependent) {
    blockers.push("TRIAGE 판정이 공급자 호출보다 뒤에 일어난 관측이 있습니다 — 규칙이 모델과 무관하지 않습니다");
  }
  const runsWithProviderCall = observations.filter((o) => o.providerCallObserved).length;
  if (usable.length > 0 && runsWithProviderCall === 0) {
    blockers.push(
      "공급자 호출이 한 번도 일어나지 않아 순서 증명이 공허합니다 — 호출이 없으면 '앞섰다'는 언제나 참입니다"
    );
  }

  const rows = sweepThresholds(observations, thresholdCandidates(observations));
  const current =
    rows.find((r) => r.maxRelevantFiles === DEFAULT_TRIAGE_POLICY.maxRelevantFiles && !r.countTestFiles) ?? null;

  return {
    observations: [...observations],
    hardObserved,
    easyObserved,
    notObserved: observations.length - usable.length,
    distribution: distributionOf(usable),
    runsWithProviderCall,
    modelIndependent,
    current,
    rows,
    blockers,
  };
}

export function renderCalibration(summary: CalibrationSummary): string[] {
  const lines: string[] = [];
  lines.push("TRIAGE 임계값 캘리브레이션 — 유료 호출 없음 (규칙은 모델을 부르지 않는다)");
  lines.push("");
  lines.push(`관측: 어려움 ${summary.hardObserved}건 · 쉬움 ${summary.easyObserved}건 · 관측 실패 ${summary.notObserved}건`);
  lines.push(
    `판정이 모든 공급자 호출보다 앞섰는가: ${summary.modelIndependent ? "예 (이벤트 seq로 확인)" : "아니오"}` +
      ` — 공급자 호출이 실제로 일어난 실행 ${summary.runsWithProviderCall}건에 대해`
  );
  lines.push("");

  for (const o of summary.observations.filter((x) => x.tier === null)) {
    lines.push(`  관측 실패 ${o.id}: ${o.notObservedReason ?? "이유 없음"}`);
  }
  if (summary.notObserved > 0) lines.push("");

  if (summary.blockers.length > 0) {
    lines.push("표를 읽을 수 없습니다:");
    for (const b of summary.blockers) lines.push(`  - ${b}`);
    return lines;
  }

  const current = summary.current;
  if (current) {
    lines.push(
      `현재 기본값(maxRelevantFiles=${current.maxRelevantFiles}, 테스트 파일 제외): ` +
        `어려움→simple ${current.hardRoutedSimple}/${summary.hardObserved} · ` +
        `쉬움→standard ${current.easyRoutedStandard}/${summary.easyObserved}`
    );
    lines.push("");
  }

  lines.push("임계값 후보 (지배당한 줄은 어떤 교환비에서도 답이 아니다):");
  lines.push("  테스트파일  maxFiles  어려움→simple  쉬움→standard  지배당함");
  for (const row of summary.rows) {
    lines.push(
      `  ${row.countTestFiles ? "센다  " : "제외  "}    ${String(row.maxRelevantFiles).padStart(6)}  ` +
        `${String(row.hardRoutedSimple).padStart(11)}  ${String(row.easyRoutedStandard).padStart(12)}  ` +
        `${row.dominated ? "예" : "-"}`
    );
  }
  lines.push("");

  const dist = summary.distribution;
  const render = (b: Record<number, number>): string =>
    Object.keys(b)
      .map(Number)
      .sort((a, c) => a - c)
      .map((n) => `${n}개→${b[n]}건`)
      .join(" · ") || "없음";
  lines.push("작업 파일 개수 분포 — 축이 라벨을 가르는지는 임계값이 아니라 여기서 정해진다:");
  lines.push(`  어려움: ${render(dist.hard)}`);
  lines.push(`  쉬움:   ${render(dist.easy)}`);
  if (dist.sharedCounts.length > 0) {
    lines.push(
      `  두 라벨이 겹치는 값 ${dist.sharedCounts.join(", ")}개에 ${dist.indistinguishable}건이 있다 — ` +
        `이 축은 그 ${dist.indistinguishable}건을 어떤 임계값으로도 구별하지 못한다.`
    );
  }
  lines.push("");
  lines.push("두 오류의 대가가 다르므로 합계로 순위를 매기지 않는다 — 교환비는 사람이 정한다.");
  return lines;
}
