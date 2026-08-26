import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FOLLOW_UP_FILES, refusalNote, resolveRequests } from "../src/context/followUp.js";
import type { WorkspaceIndex } from "@tomverse/protocol";

function index(paths: string[], excluded: { path: string; reason: string }[] = []): WorkspaceIndex {
  return {
    workspaceId: "ws-1",
    gitHeadAtIndex: "main@a",
    fileTree: paths.map((p) => ({ path: p, language: null, sizeBytes: 10, sha256: "x" })),
    symbols: [],
    dependencyEdges: [],
    projectMeta: { languages: [], agentsMdPresent: false },
    excluded,
    builtAt: "now",
    lastIncrementalUpdateAt: "now",
  };
}

test("정확한 경로는 그대로 가져온다", () => {
  const r = resolveRequests(index(["src/a.ts", "src/b.ts"]), ["src/a.ts"]);
  assert.deepEqual(
    r.fetch.map((f) => f.path),
    ["src/a.ts"]
  );
  assert.deepEqual(r.refused, []);
});

/**
 * **제외 규칙이 이 경로에서 우회되면 안 된다** — state-machine 57절, context-engine 7절.
 *
 * 컨텍스트 엔진이 secret·바이너리·대용량 파일을 인덱스에서 빼는데, 모델이 이름을 대면
 * 옆문으로 들어온다. Rust 게이트가 최후의 방어를 하지만 그건 무인 실행에서 **정지**가 되고,
 * 사람이 있어도 답 하나 얻자고 `.env` 승인 모달을 보게 된다.
 */
test("의도적으로 제외된 파일은 이름을 대도 가져오지 않는다", () => {
  const r = resolveRequests(
    index(["src/a.ts"], [{ path: ".env", reason: "시크릿 패턴에 일치 — 모델 컨텍스트에서 제외됨" }]),
    [".env"]
  );
  assert.deepEqual(r.fetch, []);
  assert.equal(r.refused.length, 1);
  // **"찾지 못했습니다"가 아니다.** 우리는 그 파일이 있다는 것을 알고 일부러 뺐다.
  assert.match(r.refused[0]!.reason, /의도적으로 제외/);
  assert.match(r.refused[0]!.reason, /시크릿/);
});

/**
 * **산문을 경로로 착각하지 않는다.** `missingContext`는 자유 문장이라 "테스트 파일" 같은
 * 것이 온다. 억지로 해석하면 엉뚱한 파일이 실리고, 모델은 자기가 지목한 것을 받았다고 믿는다.
 */
test("경로가 아닌 요청은 찾지 못했다고 말한다", () => {
  const r = resolveRequests(index(["src/a.ts"]), ["테스트 파일 전체", "그 함수를 부르는 곳"]);
  assert.deepEqual(r.fetch, []);
  assert.equal(r.refused.length, 2);
  assert.match(r.refused[0]!.reason, /찾지 못했습니다/);
});

/** 파일명만 적어도 **하나뿐이면** 찾아 준다 — 흔한 경우이고 위험하지 않다. */
test("파일명만 적어도 하나뿐이면 찾는다", () => {
  const r = resolveRequests(index(["src/deep/ledger.ts", "src/a.ts"]), ["ledger.ts"]);
  assert.deepEqual(
    r.fetch.map((f) => f.path),
    ["src/deep/ledger.ts"]
  );
});

/** **여럿이면 고르지 않는다.** 하나를 고르면 그것이 틀렸을 때 아무도 모른다. */
test("같은 이름이 여럿이면 고르지 않는다", () => {
  const r = resolveRequests(index(["a/x.ts", "b/x.ts"]), ["x.ts"]);
  assert.deepEqual(r.fetch, []);
  assert.match(r.refused[0]!.reason, /여럿입니다/);
});

/**
 * **경로처럼 생긴 요청은 파일명으로 내려가지 않는다.**
 *
 * `src/hidden.ts`를 적었는데 `other/hidden.ts`가 잡히면, 모델은 자기가 지목한 파일을
 * 받았다고 믿고 그 내용에 근거해 답한다 — 조용히 틀리는 종류다.
 */
test("디렉터리를 적은 요청이 다른 디렉터리의 같은 이름으로 떨어지지 않는다", () => {
  const r = resolveRequests(index(["other/hidden.ts"]), ["src/hidden.ts"]);
  assert.deepEqual(r.fetch, []);
  assert.match(r.refused[0]!.reason, /찾지 못했습니다/);
});

/**
 * **한 라운드에 가져올 수 있는 수를 묶는다**(원칙 5). 라운드 상한만으로는 부족하다 —
 * 한 번에 40개를 요청하면 라운드는 하나인데 예산이 원래 관련 있던 파일을 밀어낸다.
 */
test("한 라운드의 파일 수에 상한이 있다", () => {
  const paths = Array.from({ length: MAX_FOLLOW_UP_FILES + 3 }, (_u, i) => `src/f${i}.ts`);
  const r = resolveRequests(index(paths), paths);
  assert.equal(r.fetch.length, MAX_FOLLOW_UP_FILES);
  // **상한에 걸린 것을 조용히 버리지 않는다.** 버리면 모델은 읽어 줬다고 믿는다.
  assert.equal(r.refused.length, 3);
  assert.match(r.refused[0]!.reason, /개까지입니다/);
});

/** 같은 파일을 두 번 요청해도 한 번만 센다 — 중복이 상한을 먹으면 안 된다. */
test("중복 요청은 접힌다", () => {
  const r = resolveRequests(index(["src/a.ts"]), ["src/a.ts", "src/a.ts", "a.ts"]);
  assert.equal(r.fetch.length, 1);
});

/**
 * **거절을 말하지 않으면 모델은 같은 것을 다시 요청한다** — 그러면 라운드 상한이 그것으로
 * 소진된다. 더 나쁘게는, 우리가 읽어 줬다고 가정한 채 답할 수 있다.
 */
test("거절 목록이 프롬프트 문장이 된다", () => {
  const note = refusalNote([{ request: ".env", reason: "제외됨" }]);
  assert.match(note, /NOT fulfilled/);
  assert.match(note, /do not assume you have seen them/);
  assert.match(note, /\.env/);
  // 거절이 없으면 문장도 없다 — 언제나 붙으면 신호가 아니라 배경이 된다.
  assert.equal(refusalNote([]), "");
});
