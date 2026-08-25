import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSettings,
  describeProposal,
  parseArgs,
  toDrafts,
  type WorkspaceSettings,
} from "../src/lib/settingsDraft.js";

test("여러 줄 인자가 argv가 된다", () => {
  assert.deepEqual(parseArgs("run\nfmt"), ["run", "fmt"]);
});

/**
 * **쉼표가 든 인자를 등록할 수 있다.** CLI(`--hook phase=프로그램,인자...`)는 쉼표로 나눠서
 * 그게 불가능했고 그 한계를 문서에 적어 두었다. 화면에는 그 한계를 물려줄 이유가 없다 —
 * 이 단언이 없으면 나중에 누가 "CLI와 같은 방식으로" 쉼표 분리를 넣어도 아무도 모른다.
 */
test("쉼표가 든 인자가 쪼개지지 않는다", () => {
  assert.deepEqual(parseArgs('--filter=a,b\n--x'), ["--filter=a,b", "--x"]);
});

test("빈 줄과 앞뒤 공백은 인자가 아니다", () => {
  assert.deepEqual(parseArgs("  run  \n\n  fmt\n"), ["run", "fmt"]);
});

test("정상 입력은 저장 형식이 된다", () => {
  const result = buildSettings(
    [{ phase: "COMPLETED", program: "npm", argsText: "run\nfmt" }],
    [{ name: "echo", program: "node", argsText: "server.js", toolsText: "" }]
  );
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.settings, {
    hooks: [{ phase: "COMPLETED", program: "npm", args: ["run", "fmt"] }],
    servers: [{ name: "echo", program: "node", args: ["server.js"] }],
  });
});

/**
 * **비어 있는 행을 조용히 버리지 않는다.** 사용자가 추가한 행이 저장에서 사라지면 "저장이
 * 안 됐다"로 읽힌다 — 무엇이 빠졌는지 말해야 고칠 수 있다. 그리고 **몇 번째 행인지** 말한다.
 */
test("비어 있는 칸은 어느 행인지와 함께 보고된다", () => {
  const result = buildSettings(
    [
      { phase: "COMPLETED", program: "npm", argsText: "test" },
      { phase: "", program: "", argsText: "" },
    ],
    []
  );
  assert.equal(result.settings, null, "문제가 있는데 보낼 값이 만들어졌습니다");
  assert.ok(result.problems.some((p) => p.includes("훅 2")), result.problems.join(", "));
  assert.ok(result.problems.some((p) => p.includes("phase")), result.problems.join(", "));
  assert.ok(result.problems.some((p) => p.includes("프로그램")), result.problems.join(", "));
});

/** 중복은 Rust도 잡지만, 여기서 잡으면 **어느 행인지** 말할 수 있다. */
test("서버 이름 중복은 행 번호와 함께 보고된다", () => {
  const result = buildSettings(
    [],
    [
      { name: "echo", program: "node", argsText: "a.js", toolsText: "" },
      { name: "echo", program: "node", argsText: "b.js", toolsText: "" },
    ]
  );
  assert.equal(result.settings, null);
  assert.ok(result.problems.some((p) => p.includes("서버 2") && p.includes("중복")), result.problems.join(", "));
});

/**
 * **phase 이름이 실재하는지는 여기서 보지 않는다.** 그 판정은 Rust에 있고(`validate_hooks`),
 * 두 곳에서 판정하면 언젠가 둘이 갈라진다 — 갈라진 쪽이 느슨하면 그게 우회 경로가 된다.
 *
 * 그래서 오타 난 phase는 여기를 **통과한다**. 통과하는 것이 맞고, 거절은 저장할 때 온다.
 */
test("오타 난 phase는 여기서 막지 않는다 — 판정은 Rust의 것이다", () => {
  const result = buildSettings([{ phase: "VERIFYNG", program: "npm", argsText: "test" }], []);
  assert.deepEqual(result.problems, []);
  assert.equal(result.settings?.hooks[0]?.phase, "VERIFYNG");
});

test("저장된 값과 편집 중인 값을 오갈 수 있다", () => {
  const settings: WorkspaceSettings = {
    hooks: [{ phase: "VERIFYING", program: "npm", args: ["run", "lint"] }],
    servers: [{ name: "s", program: "node", args: ["x.js"], tools: ["read"] }],
  };
  const drafts = toDrafts(settings);
  const back = buildSettings(drafts.hooks, drafts.servers);
  assert.deepEqual(back.settings, settings);
});

/**
 * **비워 두면 좁히지 않는다.** 빈 목록을 보내면 Rust가 오류로 보는데, 사용자가 빈 칸으로
 * 만들려던 상태는 "전부 허용"이다 — 뭉개면 빈 칸이 저장 실패가 된다.
 */
test("도구 칸이 비면 허용목록을 보내지 않는다", () => {
  const result = buildSettings([], [{ name: "s", program: "node", argsText: "x.js", toolsText: "  \n " }]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.settings?.servers[0]?.tools, undefined);
});

test("도구를 적으면 목록으로 간다", () => {
  const result = buildSettings([], [{ name: "s", program: "node", argsText: "x.js", toolsText: "read\nwrite" }]);
  assert.deepEqual(result.settings?.servers[0]?.tools, ["read", "write"]);
});

// ---- 저장소의 제안 (state-machine 35절) ----

const PROPOSAL: WorkspaceSettings = {
  hooks: [{ phase: "COMPLETED", program: "npm", args: ["run", "fmt"] }],
  servers: [{ name: "notes", program: "node", args: ["s.js"] }],
};

/** 제안이 없으면 아무것도 그리지 않는다 — 대부분의 저장소에는 이 파일이 없다. */
test("제안이 없으면 영역 자체를 그리지 않는다", () => {
  assert.equal(describeProposal(null).show, false);
  assert.equal(
    describeProposal({ path: ".tomverse/proposal.json", status: "absent", proposal: null }).show,
    false
  );
});

/**
 * **"등록되었습니다"라고 쓰지 않는다.** 저장소는 아무것도 등록하지 않았다 — 불러오기는
 * 입력칸을 채울 뿐이고 등록은 사용자가 저장을 누를 때 일어난다.
 */
test("제안 문장이 아직 등록되지 않았다고 말한다", () => {
  const notice = describeProposal({ path: ".tomverse/proposal.json", status: "differs", proposal: PROPOSAL });
  assert.equal(notice.show, true);
  assert.equal(notice.offerLoad, true);
  assert.ok(notice.headline.includes("아직 등록되지 않았습니다"), notice.headline);
  assert.ok(!notice.headline.includes("등록되었습니다"), notice.headline);
  // **두 수를 따로 낸다** — 합치면 무엇이 들어오는지 알 수 없다.
  assert.equal(notice.hookCount, 1);
  assert.equal(notice.serverCount, 1);
});

/** 이미 등록과 같으면 불러올 것이 없다 — 버튼을 그리면 누를 이유 없는 버튼이 된다. */
test("제안이 등록과 같으면 불러오기를 권하지 않는다", () => {
  const notice = describeProposal({
    path: ".tomverse/proposal.json",
    status: "same_as_registered",
    proposal: PROPOSAL,
  });
  assert.equal(notice.show, true);
  assert.equal(notice.offerLoad, false);
  assert.ok(notice.headline.includes("같습니다"), notice.headline);
});

/** 경로는 **호스트가 준 값**을 그대로 쓴다 — 화면이 지어내면 사용자를 없는 파일로 보낸다. */
test("문장이 호스트가 준 경로를 그대로 쓴다", () => {
  const notice = describeProposal({ path: "어디/다른/곳.json", status: "differs", proposal: PROPOSAL });
  assert.ok(notice.headline.includes("어디/다른/곳.json"), notice.headline);
});
