import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRIAGE_POLICY, triage, triageTask } from "../src/triage.js";
import { makeRelevantFile, makeSnapshot } from "./helpers/fixtures.js";

test("단일 파일 + 깨끗한 git + 위험 키워드 없음 → simple", () => {
  const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile()] });
  assert.equal(triageTask(snapshot, "로그인 버튼 오타 수정해줘"), "simple");
});

test("여러 작업 파일 → standard", () => {
  const snapshot = makeSnapshot({
    relevantFiles: [
      makeRelevantFile({ path: "src/a.ts" }),
      makeRelevantFile({ path: "src/b.ts" }),
      makeRelevantFile({ path: "src/c.ts" }),
    ],
  });
  assert.equal(triageTask(snapshot, "버그 수정"), "standard");
});

test("미커밋 변경 존재 → standard", () => {
  const snapshot = makeSnapshot({ gitDiffSummary: " src/other.ts | 3 +-" });
  assert.equal(triageTask(snapshot, "간단한 오타 수정"), "standard");
});

test("위험 키워드 매칭 → 파일이 하나여도 standard", () => {
  for (const message of [
    "결제 처리 로직을 리팩터링 해줘",
    "auth flow refactor",
    "security 취약점 고쳐줘",
    "이 마이그레이션 스크립트 수정",
  ]) {
    assert.equal(triageTask(makeSnapshot(), message), "standard", `${message}는 standard여야 합니다`);
  }
});

test("project-meta 파일은 복잡도 신호로 세지 않는다", () => {
  // README/package.json/CLAUDE.md는 4절 규칙에 따라 항상 포함되므로, 이걸 세면
  // 모든 태스크가 standard가 되어 TRIAGE 자체가 무의미해진다.
  const snapshot = makeSnapshot({
    relevantFiles: [
      makeRelevantFile({ path: "README.md", reason: "project-meta" }),
      makeRelevantFile({ path: "package.json", reason: "project-meta" }),
      makeRelevantFile({ path: "CLAUDE.md", reason: "project-meta" }),
      makeRelevantFile({ path: "src/app.ts", reason: "mentioned" }),
    ],
  });
  assert.equal(triageTask(snapshot, "app.ts의 오타 수정"), "simple");
});

test("정책의 임계값과 키워드를 override할 수 있다", () => {
  const snapshot = makeSnapshot({
    relevantFiles: [makeRelevantFile({ path: "src/a.ts" }), makeRelevantFile({ path: "src/b.ts" })],
  });
  // 기본 정책이면 standard지만 임계값을 올리면 simple이다 — 하드코딩되지 않았음을 확인한다.
  assert.equal(triageTask(snapshot, "수정"), "standard");
  assert.equal(triageTask(snapshot, "수정", { ...DEFAULT_TRIAGE_POLICY, maxRelevantFiles: 3 }), "simple");
});

test("빈 gitDiffSummary는 깨끗한 상태로 취급한다", () => {
  assert.equal(triageTask(makeSnapshot({ gitDiffSummary: "   " }), "오타 수정"), "simple");
});

// ---- 오분류를 셀 수 있는 형태인가 (context-engine.md 11.1절) ----
//
// 이 항목이 오래 열려 있던 이유는 **측정할 수 없어서**였다. `tier` 하나만 남기면 어떤
// 태스크에서 규칙이 작동하기라도 했는지 알 수 없고, 그러면 분모를 만들 수 없다.

test("테스트 파일을 세었더라면 달라졌을 판정을 함께 남긴다", () => {
  const snapshot = makeSnapshot({
    relevantFiles: [
      makeRelevantFile({ path: "README.md", reason: "project-meta" }),
      makeRelevantFile({ path: "src/paginate.ts", reason: "mentioned" }),
      makeRelevantFile({ path: "src/paginate.test.ts", reason: "mentioned" }),
    ],
  });
  const result = triage(snapshot, "paginate 고쳐줘");

  assert.equal(result.workFileCount, 1);
  assert.deepEqual(result.excludedTestFiles, ["src/paginate.test.ts"]);
  assert.equal(result.tier, "simple");
  // 둘이 다르다 = 이 태스크에서 규칙이 **실제로 판정을 바꿨다.** 오분류율의 분모에 들어간다.
  assert.equal(result.tierIfTestsCounted, "standard");
});

test("다른 이유로 이미 standard면 규칙은 아무것도 하지 않은 것이다", () => {
  // 위험 키워드로 이미 standard인 태스크는 이 규칙에 대해 아무것도 말해주지 않는다.
  // 반사실이 같은 값이 되어 집계에서 저절로 빠진다 — 분모를 부풀리지 않는다.
  const snapshot = makeSnapshot({
    relevantFiles: [
      makeRelevantFile({ path: "src/auth.ts", reason: "mentioned" }),
      makeRelevantFile({ path: "src/auth.test.ts", reason: "mentioned" }),
    ],
  });
  const result = triage(snapshot, "인증 로직 리팩터링");
  assert.equal(result.tier, "standard");
  assert.equal(result.tierIfTestsCounted, "standard");
  // 제외는 여전히 일어났다 — "제외했다"와 "제외가 판정을 바꿨다"는 다른 사실이다.
  assert.deepEqual(result.excludedTestFiles, ["src/auth.test.ts"]);
});

test("제외할 테스트 파일이 없으면 반사실도 같다", () => {
  const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile({ path: "src/a.ts" })] });
  const result = triage(snapshot, "오타 수정");
  assert.deepEqual(result.excludedTestFiles, []);
  assert.equal(result.tier, result.tierIfTestsCounted);
});

test("triageTask는 triage와 같은 판정을 낸다", () => {
  // 판정 로직이 두 벌이 되면 둘이 갈라져도 아무도 모른다.
  const snapshot = makeSnapshot({
    relevantFiles: [makeRelevantFile({ path: "src/a.ts" }), makeRelevantFile({ path: "src/a.test.ts" })],
  });
  for (const message of ["오타 수정", "보안 점검", "리팩터링"]) {
    assert.equal(triageTask(snapshot, message), triage(snapshot, message).tier, message);
  }
});
