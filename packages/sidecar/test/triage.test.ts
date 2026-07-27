import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRIAGE_POLICY, triageTask } from "../src/triage.js";
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
