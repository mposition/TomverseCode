import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessDifficulty,
  changedRegions,
  hunksOf,
  summarizeDifficulty,
  type DifficultyResult,
} from "../src/difficulty.js";
import { loadFixture } from "../src/manifest.js";

/**
 * 난이도 판정 — product-strategy.md 12절 "무엇을 어렵다고 정의할 것인가".
 *
 * 여기서 검증하는 실패는 **조용하다**: 판정이 틀려도 명령은 초록색 목록을 그대로 출력하고,
 * 그 라벨 위에 올라간 측정(TRIAGE 캘리브레이션)은 계속 그럴듯한 표를 낸다.
 *
 * 그래서 세 갈래를 **직접 만든 fixture로** 전부 돌린다. 저장소의 24개만 쓰면 그중 없는 갈래는
 * 검사되지 않고, 없는 갈래가 바로 고장 나기 쉬운 쪽이다.
 */

// ---- 줄 diff ----

test("바뀐 것이 없으면 되돌릴 조각도 없다", () => {
  assert.deepEqual(changedRegions(["a", "b"], ["a", "b"]), []);
});

test("떨어져 있는 두 변경은 두 조각이다", () => {
  // 한 조각으로 뭉치면 "하나만 빼먹은 상태"를 만들 수 없어 부분 수정을 영영 못 본다.
  const regions = changedRegions(["a", "b", "c", "d", "e"], ["A", "b", "c", "D", "e"]);
  assert.equal(regions.length, 2, JSON.stringify(regions));
});

test("붙어 있는 변경은 한 조각이다", () => {
  const regions = changedRegions(["a", "b", "c"], ["A", "B", "c"]);
  assert.equal(regions.length, 1, JSON.stringify(regions));
});

test("줄이 늘거나 줄어도 조각을 찾는다", () => {
  assert.equal(changedRegions(["a", "c"], ["a", "b", "c"]).length, 1);
  assert.equal(changedRegions(["a", "b", "c"], ["a", "c"]).length, 1);
});

// ---- 직접 만든 fixture로 세 갈래 ----

interface SyntheticSpec {
  id: string;
  source: string;
  reference: string;
  publicTest: string;
  oracleTest: string;
}

function writeSynthetic(root: string, spec: SyntheticSpec): string {
  const dir = path.join(root, spec.id);
  mkdirSync(path.join(dir, "workspace"), { recursive: true });
  mkdirSync(path.join(dir, "oracle"), { recursive: true });
  writeFileSync(path.join(dir, "workspace", "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFileSync(path.join(dir, "workspace", "lib.js"), spec.source);
  writeFileSync(path.join(dir, "workspace", "public.test.js"), spec.publicTest);
  writeFileSync(path.join(dir, "oracle", "oracle.test.js"), spec.oracleTest);
  writeFileSync(
    path.join(dir, "reference.patch"),
    JSON.stringify({ files: [{ path: "lib.js", content: spec.reference }] })
  );
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      fixtureId: spec.id,
      category: "state_machine_bounds",
      language: "typescript",
      taskPrompt: "고쳐주세요",
      publicVerificationCommands: [{ program: "node", args: ["--test", "public.test.js"] }],
      oracleVerificationCommands: [{ program: "node", args: ["--test", "oracle.test.js"] }],
      forbiddenPaths: ["public.test.js"],
      expectedInvariant: "합성 fixture",
      timeoutMs: 60_000,
    })
  );
  return dir;
}

/** 두 결함(a, b)을 가진 소스. `fixA`/`fixB`로 어느 쪽을 고칠지 정한다. */
function twoBugSource(fixA: boolean, fixB: boolean): string {
  return [
    "function f(x) {",
    `  if (x ${fixA ? ">=" : ">"} 10) return "big";`,
    // **두 결함 사이에 바뀌지 않는 줄을 둔다.** 붙어 있으면 diff가 한 조각으로 뭉쳐서
    // "하나만 빼먹은 상태"를 만들 수 없고, 그러면 부분 수정 갈래가 검사되지 않는다.
    "  const y = x;",
    `  return ${fixB ? "String(y)" : "y"};`,
    "}",
    "module.exports = { f };",
    "",
  ].join("\n");
}

const ASSERT_HEAD = ['const test = require("node:test");', 'const assert = require("node:assert/strict");', 'const { f } = require("./lib.js");', ""].join("\n");

function assessSynthetic(spec: SyntheticSpec): DifficultyResult {
  const root = mkdtempSync(path.join(tmpdir(), "difficulty-"));
  try {
    writeSynthetic(root, spec);
    return assessDifficulty(loadFixture(root, spec.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("공개 검증이 놓치는 조각이 있으면 '부분 수정이 완성처럼 보임'이다", () => {
  const result = assessSynthetic({
    id: "synthetic-partial",
    source: twoBugSource(false, false),
    reference: twoBugSource(true, true),
    // 공개 테스트는 결함 a만 본다 — b를 빼먹어도 아무 말도 하지 않는다.
    publicTest: `${ASSERT_HEAD}test("경계", () => { assert.equal(f(10), "big"); });\n`,
    oracleTest: `${ASSERT_HEAD}test("경계", () => { assert.equal(f(10), "big"); });\ntest("문자열", () => { assert.equal(f(1), "1"); });\n`,
  });
  assert.equal(result.measured, true, result.notMeasuredReason ?? "");
  assert.equal(result.kind, "partial_fix_looks_complete", JSON.stringify(result.ablations));
  assert.equal(result.ablations.filter((a) => a.invisible).length, 1, JSON.stringify(result.ablations));
});

test("공개 검증이 모든 조각을 잡으면 '보이는 신호가 정답을 결정함'이다", () => {
  const result = assessSynthetic({
    id: "synthetic-visible",
    source: twoBugSource(false, false),
    reference: twoBugSource(true, true),
    // 공개 테스트가 oracle과 같은 것을 본다 — 빼먹으면 바로 걸린다.
    publicTest: `${ASSERT_HEAD}test("경계", () => { assert.equal(f(10), "big"); });\ntest("문자열", () => { assert.equal(f(1), "1"); });\n`,
    oracleTest: `${ASSERT_HEAD}test("경계", () => { assert.equal(f(10), "big"); });\ntest("문자열", () => { assert.equal(f(1), "1"); });\n`,
  });
  assert.equal(result.kind, "fully_visible", JSON.stringify(result.ablations));
  // 조각을 실제로 둘로 쪼갰는지까지 본다 — 하나로 뭉쳤다면 위 테스트가 통과한 것이 우연이다.
  assert.equal(result.hunks, 2, JSON.stringify(result.ablations));
});

test("고치기 전에 공개 검증이 통과하면 '증상이 보이지 않음'이다", () => {
  const result = assessSynthetic({
    id: "synthetic-hidden",
    source: twoBugSource(false, true),
    reference: twoBugSource(true, true),
    // 결함을 건드리지 않는 공개 테스트 — 모델은 문제가 있다는 것조차 관측할 수 없다.
    publicTest: `${ASSERT_HEAD}test("작은 값", () => { assert.equal(f(1), "1"); });\n`,
    oracleTest: `${ASSERT_HEAD}test("경계", () => { assert.equal(f(10), "big"); });\n`,
  });
  assert.equal(result.kind, "hidden_symptom");
  // 이미 신호가 정답을 결정하지 못하므로 조각을 더 볼 필요가 없다.
  assert.equal(result.ablations.length, 0);
});

test("되돌릴 때 다른 파일은 참조 그대로 둔다", () => {
  // 나머지를 원본으로 되돌리면 그건 "덜 고친" 것이 아니라 "거의 안 고친" 것이고,
  // 그러면 거의 모든 조각이 공개 검증에 걸려 부분 수정을 영영 못 본다.
  const root = mkdtempSync(path.join(tmpdir(), "difficulty-hunks-"));
  try {
    const dir = writeSynthetic(root, {
      id: "synthetic-hunks",
      source: twoBugSource(false, false),
      reference: twoBugSource(true, true),
      publicTest: `${ASSERT_HEAD}test("x", () => { assert.ok(true); });\n`,
      oracleTest: `${ASSERT_HEAD}test("x", () => { assert.ok(true); });\n`,
    });
    const pieces = hunksOf(loadFixture(root, "synthetic-hunks"));
    assert.equal(pieces.length, 2);
    const work = path.join(dir, "probe");
    mkdirSync(work, { recursive: true });
    pieces[0]!.write(work);
    const written = readFileSync(path.join(work, "lib.js"), "utf8");
    // 첫 조각은 되돌아갔고, 둘째 조각은 참조 그대로여야 한다.
    assert.ok(written.includes("x > 10"), written);
    assert.ok(written.includes("String(y)"), written);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 요약 ----

test("판정하지 못한 fixture를 쉬운 쪽으로 세지 않는다", () => {
  // 못 잰 것과 쉬운 것을 뭉개면 툴체인이 없는 기계에서 세트가 조용히 쉬워 보인다.
  const summary = summarizeDifficulty([
    { fixtureId: "a", kind: "fully_visible", measured: false, publicPassesBeforeFix: false, hunks: 0, ablations: [] },
    { fixtureId: "b", kind: "hidden_symptom", measured: true, publicPassesBeforeFix: true, hunks: 0, ablations: [] },
  ]);
  assert.equal(summary.notMeasured, 1);
  assert.equal(summary.fullyVisible, 0);
  assert.equal(summary.hard, 1);
});
