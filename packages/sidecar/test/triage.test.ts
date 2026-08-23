import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRIAGE_POLICY, tierAtThreshold, triage, triageTask } from "../src/triage.js";
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

/**
 * product-strategy 5절의 세 신호 중 둘 — state-machine 13.4.1절.
 *
 * `riskKeywords`는 사용자가 **뭐라고 썼는가**를 본다. 같은 작업이라도 "결제 로직 고쳐줘"는
 * standard가 되고 "이 함수 좀 봐줘"는 simple이 됐다. 위험은 표현이 아니라 코드에 있다.
 */
test("경로가 위험 구역을 가리키면 사용자가 아무 말 안 해도 standard다", () => {
  for (const path of ["src/auth/session.ts", "app/payment.ts", "db/migrations/003_add.sql", "lib/crypto.rs"]) {
    const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile({ path })] });
    assert.equal(triageTask(snapshot, "이 함수 좀 봐줘"), "standard", `${path}는 standard여야 합니다`);
  }
});

test("경로 신호는 이름 경계를 지킨다 — author.ts는 auth가 아니다", () => {
  // 단순 포함으로 보면 이 신호는 잡음이 되고, 잡음이 섞이면 전부 standard로 수렴해
  // TRIAGE를 죽이는 것과 같아진다.
  for (const path of ["src/author.ts", "src/tokenizer.ts", "lib/authors/list.ts", "src/migrationless.ts"]) {
    const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile({ path })] });
    assert.equal(triageTask(snapshot, "이 함수 좀 봐줘"), "simple", `${path}는 simple이어야 합니다`);
  }
});

test("경로 신호의 근거는 개수가 아니라 값으로 남는다", () => {
  const snapshot = makeSnapshot({
    relevantFiles: [makeRelevantFile({ path: "src/auth/login.ts" }), makeRelevantFile({ path: "src/util.ts" })],
  });
  const result = triage(snapshot, "고쳐줘");
  assert.equal(result.riskPathMatched, true);
  // 디렉터리와 파일명 양쪽에서 걸린다 — 어느 조각이 걸렸는지가 남아야 판정을 사후에 검증한다.
  assert.deepEqual(result.riskPaths, [{ path: "src/auth/login.ts", segments: ["auth", "login"] }]);
  // **두 신호를 뭉치지 않는다.** 사용자는 위험 단어를 쓰지 않았다.
  assert.equal(result.riskKeywordMatched, false);
});

test("테스트 파일은 개수에서 빠지지만 위험 구역 판정에서는 빠지지 않는다", () => {
  // 두 규칙이 같은 목록을 본다고 해서 같은 것을 묻는 것은 아니다.
  const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile({ path: "src/auth/login.test.ts" })] });
  const result = triage(snapshot, "고쳐줘");
  assert.equal(result.workFileCount, 0);
  assert.deepEqual(result.excludedTestFiles, ["src/auth/login.test.ts"]);
  assert.equal(result.riskPathMatched, true);
});

test("경로 신호를 끄고 다시 계산할 수 있다 — 켠 대가를 재려면 필요하다", () => {
  const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile({ path: "src/auth/login.ts" })] });
  const result = triage(snapshot, "고쳐줘");
  assert.equal(tierAtThreshold(result, DEFAULT_TRIAGE_POLICY.maxRelevantFiles, false, true), "standard");
  assert.equal(tierAtThreshold(result, DEFAULT_TRIAGE_POLICY.maxRelevantFiles, false, false), "simple");
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

/**
 * 기록된 근거만으로 다시 계산한 판정이 **살아 있는 규칙과 같은가.**
 *
 * 이 둘이 갈라지면 임계값 표(state-machine-and-protocol.md 13.4절)는 제품이 실제로 하는 것과
 * 다른 규칙에 대한 표가 된다 — 그리고 표는 여전히 그럴듯하게 그려진다.
 */
test("기록된 근거로 다시 계산한 tier가 규칙의 판정과 같다", () => {
  const cases: { paths: string[]; message: string; dirty: boolean }[] = [];
  for (const paths of [
    ["src/a.ts"],
    ["src/a.ts", "src/b.ts"],
    ["src/a.ts", "src/a.test.ts"],
    ["src/a.ts", "src/b.ts", "tests/c.ts"],
    [],
  ]) {
    for (const message of ["오타 수정", "인증 로직 리팩터링"]) {
      for (const dirty of [false, true]) cases.push({ paths, message, dirty });
    }
  }

  for (const c of cases) {
    const snapshot = makeSnapshot({
      relevantFiles: c.paths.map((path) => makeRelevantFile({ path, reason: "mentioned" })),
      ...(c.dirty ? { gitDiffSummary: " M src/a.ts" } : {}),
    });
    const result = triage(snapshot, c.message);
    const label = `${c.paths.join(",")} / ${c.message} / dirty=${c.dirty}`;
    assert.equal(tierAtThreshold(result, DEFAULT_TRIAGE_POLICY.maxRelevantFiles), result.tier, label);
    assert.equal(
      tierAtThreshold(result, DEFAULT_TRIAGE_POLICY.maxRelevantFiles, true),
      result.tierIfTestsCounted,
      label
    );
  }
});

test("다른 임계값으로 다시 계산해도 다른 이유로 인한 standard는 유지된다", () => {
  const snapshot = makeSnapshot({ relevantFiles: [makeRelevantFile({ path: "src/a.ts" })] });
  const result = triage(snapshot, "결제 모듈 마이그레이션");
  assert.equal(result.riskKeywordMatched, true);
  // 임계값을 아무리 올려도 simple이 되지 않는다. 이걸 놓치면 표가 "3으로 올리면 전부 simple"이라고
  // 말하는데 제품은 그러지 않는다.
  for (const n of [1, 2, 10]) assert.equal(tierAtThreshold(result, n), "standard", `n=${n}`);
});
