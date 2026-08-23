import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  distributionOf,
  loadEasyTasks,
  loadHardTasks,
  observationFromEvents,
  observeTriage,
  summarize,
  sweepThresholds,
  thresholdCandidates,
  type LabeledTask,
  type TriageObservation,
} from "../src/triageCalibration.js";
import { artifactsPresent, REPO_ROOT, type StoredEvent } from "../src/host.js";
import { listFixtureIds } from "../src/manifest.js";

/**
 * TRIAGE 임계값 캘리브레이션 — state-machine-and-protocol.md 12절.
 *
 * 여기서 검증하는 실패는 **표가 그려지기는 한다**: 근거를 못 읽어도, 규칙이 돌지 않은 태스크를
 * 세어도, 공급자 호출이 한 번도 없어도 숫자는 나온다. 틀린 표는 맞는 표와 똑같이 생겼다.
 */

const FIXTURES = path.join(REPO_ROOT, "evals", "hypothesis-gate", "fixtures");
const SPIKE_FIXTURES = path.join(REPO_ROOT, "spike", "fixtures");

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): StoredEvent {
  return { eventId: seq, seq, type, phase: null, payload, createdAt: "2026-01-01T00:00:00Z" };
}

const TASK: LabeledTask = {
  id: "t",
  label: "hard",
  source: "테스트",
  taskPrompt: "x",
  materialize: () => ({ root: "", cleanup: () => undefined }),
};

const FULL_EVIDENCE = {
  complexityTier: "simple",
  appliedPolicies: [],
  workFileCount: 1,
  excludedTestFiles: [],
  riskKeywordMatched: false,
  uncommittedChanges: false,
  tierIfTestsCounted: "simple",
};

// ---- 관측이 관측인가 ----

test("규칙이 판정한 태스크만 관측으로 센다", () => {
  const observed = observationFromEvents(
    TASK,
    [ev(1, "TRIAGE_COMPLETED", FULL_EVIDENCE), ev(2, "PROVIDER_USAGE")],
    10
  );
  assert.equal(observed.tier, "simple");
  assert.equal(observed.decidedBeforeAnyProviderCall, true);
  assert.equal(observed.providerCallObserved, true);
});

test("모드가 강제한 판정은 관측이 아니다 — 세면 분모가 부푼다", () => {
  const observed = observationFromEvents(
    TASK,
    [
      ev(1, "TRIAGE_COMPLETED", {
        complexityTier: "standard",
        appliedPolicies: ["executionMode=verified — 항상 교차검증 경로"],
      }),
    ],
    10
  );
  // tier가 standard로 **찍혀 있는데도** 관측이 아니다. 이 구별이 없으면 verified로 돌린
  // 실행 전부가 "규칙이 standard로 보냈다"로 집계된다.
  assert.equal(observed.tier, null);
  assert.match(observed.notObservedReason ?? "", /규칙이 돌지 않았습니다/);
});

test("근거 없는 판정은 관측이 아니다 — 스윕은 tier가 아니라 근거로 한다", () => {
  const observed = observationFromEvents(
    TASK,
    [ev(1, "TRIAGE_COMPLETED", { complexityTier: "simple", appliedPolicies: [] })],
    10
  );
  assert.equal(observed.tier, null);
  assert.equal(observed.evidence, null);
  assert.match(observed.notObservedReason ?? "", /근거가 없습니다/);
});

test("판정이 공급자 호출보다 뒤에 오면 그 사실이 남는다", () => {
  const observed = observationFromEvents(
    TASK,
    [ev(1, "PROVIDER_USAGE"), ev(2, "TRIAGE_COMPLETED", FULL_EVIDENCE)],
    10
  );
  assert.equal(observed.decidedBeforeAnyProviderCall, false);
  const summary = summarize([observed]);
  assert.equal(summary.modelIndependent, false);
  assert.ok(
    summary.blockers.some((b) => b.includes("모델과 무관하지 않습니다")),
    JSON.stringify(summary.blockers)
  );
});

// ---- 증명이 공허하지 않은가 ----

test("공급자 호출이 한 번도 없으면 순서 증명으로 치지 않는다", () => {
  // 호출이 없으면 "판정이 호출보다 앞섰다"는 언제나 참이다. 그걸 증명이라고 부르면
  // 나중에 규칙이 모델 출력을 보게 되어도 이 검사는 계속 초록색이다.
  const observed = observationFromEvents(TASK, [ev(1, "TRIAGE_COMPLETED", FULL_EVIDENCE)], 10);
  assert.equal(observed.decidedBeforeAnyProviderCall, true);
  assert.equal(observed.providerCallObserved, false);

  const summary = summarize([observed, { ...observed, id: "u", label: "easy" as const }]);
  assert.equal(summary.modelIndependent, true);
  assert.ok(
    summary.blockers.some((b) => b.includes("공허")),
    JSON.stringify(summary.blockers)
  );
});

// ---- 스윕 ----

function obs(id: string, label: "hard" | "easy", workFileCount: number, extra: Partial<{
  excludedTestFiles: string[];
  riskKeywordMatched: boolean;
  uncommittedChanges: boolean;
}> = {}): TriageObservation {
  return {
    id,
    label,
    source: "테스트",
    tier: "simple",
    tierIfTestsCounted: "simple",
    evidence: {
      workFileCount,
      excludedTestFiles: extra.excludedTestFiles ?? [],
      riskKeywordMatched: extra.riskKeywordMatched ?? false,
      uncommittedChanges: extra.uncommittedChanges ?? false,
    },
    decidedBeforeAnyProviderCall: true,
    providerCallObserved: true,
    wallClockMs: 1,
  };
}

test("임계값을 올리면 어려움→simple이 늘고 쉬움→standard가 준다", () => {
  const observations = [obs("h1", "hard", 2), obs("h2", "hard", 3), obs("e1", "easy", 2)];
  const rows = sweepThresholds(observations, [1, 2, 3]);
  const at = (n: number): { hardRoutedSimple: number; easyRoutedStandard: number } =>
    rows.find((r) => r.maxRelevantFiles === n && !r.countTestFiles)!;

  assert.deepEqual(at(1), { ...at(1), hardRoutedSimple: 0, easyRoutedStandard: 1 });
  assert.equal(at(2).hardRoutedSimple, 1);
  assert.equal(at(2).easyRoutedStandard, 0);
  assert.equal(at(3).hardRoutedSimple, 2);
});

test("다른 이유로 standard인 태스크는 임계값을 아무리 올려도 simple이 되지 않는다", () => {
  // 이걸 놓치면 표가 "임계값을 3으로 올리면 전부 simple"이라고 말하는데, 실제 규칙은
  // 위험 키워드를 보고 standard를 유지한다 — 표와 제품이 갈라진다.
  const observations = [obs("h1", "hard", 1, { riskKeywordMatched: true })];
  const rows = sweepThresholds(observations, [1, 5]);
  for (const row of rows) assert.equal(row.hardRoutedSimple, 0, JSON.stringify(row));
});

test("테스트 파일을 세는 쪽은 제외하는 쪽보다 절대 simple이 늘지 않는다", () => {
  const observations = [obs("h1", "hard", 1, { excludedTestFiles: ["a.test.js", "b.test.js"] })];
  const rows = sweepThresholds(observations, [1, 2, 3]);
  for (const n of [1, 2, 3]) {
    const excluded = rows.find((r) => r.maxRelevantFiles === n && !r.countTestFiles)!;
    const counted = rows.find((r) => r.maxRelevantFiles === n && r.countTestFiles)!;
    assert.ok(counted.hardRoutedSimple <= excluded.hardRoutedSimple, `n=${n}`);
  }
});

test("지배 판정은 교환비 없이 성립한다 — 두 값이 모두 나쁘지 않은 후보만 남는다", () => {
  const observations = [obs("h1", "hard", 2), obs("e1", "easy", 5)];
  const rows = sweepThresholds(observations, [1, 2, 3]);
  // 1과 2는 쉬움 쪽 결과가 같고 어려움 쪽이 1에서 더 낫다 → 2는 지배당한다.
  assert.equal(rows.find((r) => r.maxRelevantFiles === 1 && !r.countTestFiles)!.dominated, false);
  assert.equal(rows.find((r) => r.maxRelevantFiles === 2 && !r.countTestFiles)!.dominated, true);
});

test("후보 범위는 관측된 파일 수를 덮는다 — 표 밖에 답이 있으면 표가 거짓말한다", () => {
  const candidates = thresholdCandidates([obs("h", "hard", 3, { excludedTestFiles: ["x.test.js"] })]);
  assert.equal(Math.max(...candidates), 4);
  assert.equal(Math.min(...candidates), 0);
});

// ---- 축이 라벨을 가르는가 ----

test("두 라벨이 같은 파일 개수에 겹치면 그 건수를 말한다", () => {
  const dist = distributionOf([obs("h1", "hard", 1), obs("h2", "hard", 2), obs("e1", "easy", 1)]);
  assert.deepEqual(dist.sharedCounts, [1]);
  // 겹치는 값에 있는 태스크는 어떤 임계값으로도 갈리지 않는다 — 임계값 표만 보면
  // 이 사실이 보이지 않는다.
  assert.equal(dist.indistinguishable, 2);
});

// ---- 라벨 세트 ----

test("두 라벨이 다 있어야 표를 읽는다", () => {
  const onlyHard = summarize([obs("h1", "hard", 1)]);
  assert.ok(
    onlyHard.blockers.some((b) => b.includes("쉬운 라벨")),
    JSON.stringify(onlyHard.blockers)
  );
});

test("어려운 라벨과 쉬운 라벨이 실제 저장소에서 온다", () => {
  const hard = loadHardTasks(FIXTURES);
  const easy = loadEasyTasks(SPIKE_FIXTURES);
  // 사전 등록된 최소 개수(criteria.minFixtures = 24)와 스파이크의 5건.
  assert.ok(hard.length >= 24, `어려운 라벨 ${hard.length}건`);
  assert.equal(easy.length, 5);
  for (const task of [...hard, ...easy]) {
    assert.ok(task.taskPrompt.trim().length > 0, `${task.id}: 프롬프트가 비어 있습니다`);
  }
});

test("스파이크 디렉터리가 없으면 빈 배열이 아니라 예외다", () => {
  // 빈 배열이면 쉬운 라벨이 통째로 빠진 채 표가 조용히 나온다.
  assert.throws(() => loadEasyTasks(path.join(SPIKE_FIXTURES, "없는-경로")), /없습니다/);
});

/**
 * 이 세트가 **답할 수 없는 질문**을 못 박아 둔다 — context-engine 11.1.1절.
 *
 * TRIAGE 임계값은 이 fixture 세트로 재진다(라벨이 있고 규칙이 모델을 부르지 않는다). 그래서
 * "테스트 파일 제외 규칙의 오분류"도 같은 방식으로 앞당길 수 있는지 확인해봤고, **없다.**
 * 오분류의 분자는 "제외한 테스트 파일이 실제 작업 대상이었는가"인데, 24개 fixture의 정답
 * 패치가 **전부 소스 파일**을 고친다. 반례를 담을 수 없는 세트에서 분자 0을 보고하면 그건
 * "규칙이 완벽하다"로 읽힌다 — 문서가 경고한 조용한 실패 그대로다.
 *
 * 그래서 이 사실을 산문이 아니라 검사로 둔다. fixture의 정답 대상이 테스트 파일이 되는 순간
 * 이 세트는 그 질문에 답할 수 있게 되므로, 그때 실패해서 항목을 다시 열게 한다.
 */
test("정답 패치가 테스트 파일을 고치는 fixture는 없다 — 그래서 이 세트는 11.1의 오분류를 재지 못한다", () => {
  const ids = listFixtureIds(FIXTURES);
  assert.ok(ids.length >= 24, `fixture를 찾지 못했습니다 (${ids.length}개)`);

  const looksLikeTest = (p: string): boolean => /\.(?:test|spec)\.[a-z]{1,4}$/i.test(p);
  let targets = 0;
  for (const id of ids) {
    const patchPath = path.join(FIXTURES, id, "reference.patch");
    const parsed = JSON.parse(readFileSync(patchPath, "utf8")) as { files?: { path: string }[] };
    assert.ok(Array.isArray(parsed.files) && parsed.files.length > 0, `${id}: reference.patch에 files가 없습니다`);
    for (const file of parsed.files) {
      targets += 1;
      assert.ok(
        !looksLikeTest(file.path),
        `${id}의 정답 패치가 테스트 파일(${file.path})을 고칩니다. ` +
          "이제 이 세트로 context-engine 11.1의 오분류를 잴 수 있으므로 그 항목을 다시 열 것"
      );
    }
  }
  // 대상이 0개면 위 반복이 한 번도 돌지 않은 것이고, 그러면 이 검사는 아무것도 말하지 않는다.
  assert.ok(targets >= 24, `정답 대상 경로를 ${targets}개밖에 못 읽었습니다`);
});

// ---- production 경로를 실제로 태운다 ----

test("실제 tomverse-host가 TRIAGE 규칙을 돌리고 근거를 남긴다 (모델 호출 없음)", () => {
  const artifacts = artifactsPresent();
  assert.ok(artifacts.ok, `e2e 산출물이 없습니다.\n${artifacts.detail}`);

  const [task] = loadHardTasks(FIXTURES, ["stm-01-loop-bound"]);
  const observed = observeTriage(task!);

  assert.notEqual(observed.tier, null, observed.notObservedReason ?? "");
  assert.notEqual(observed.evidence, null);
  // 근거가 실제로 채워져야 스윕이 성립한다.
  assert.equal(typeof observed.evidence!.workFileCount, "number");
  assert.equal(typeof observed.evidence!.riskKeywordMatched, "boolean");
  // **여기가 이 측정의 전부다**: 판정이 공급자 호출보다 앞섰고, 호출은 실제로 일어났다.
  assert.equal(observed.providerCallObserved, true, "공급자 호출이 없어 순서 증명이 공허합니다");
  assert.equal(observed.decidedBeforeAnyProviderCall, true);
});
