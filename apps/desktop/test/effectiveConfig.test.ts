import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAllowedTools,
  describeDeadline,
  describeIsolation,
  describeMcpServer,
  describeVerificationPin,
  pinnedChanges,
  switchLines,
  type PinnedConfig,
} from "../src/lib/effectiveConfig.js";

/**
 * **`null`과 빈 배열을 뭉개지 않는다.** 전자는 "좁히지 않았다"이고 후자는 "아무 도구도 못
 * 쓴다"인데, 뭉개면 정반대로 읽힌다.
 */
test("허용목록 없음과 빈 허용목록이 다른 문장이 된다", () => {
  const none = describeAllowedTools({});
  const empty = describeAllowedTools({ allowedTools: [] });
  assert.ok(none.includes("좁히지 않았습니다"), none);
  assert.ok(empty.includes("없습니다"), empty);
  assert.notEqual(none, empty);
});

test("좁혀진 허용목록은 개수와 이름을 함께 말한다", () => {
  const text = describeAllowedTools({ allowedTools: ["read_file", "run_tests"] });
  assert.ok(text.includes("2개"), text);
  assert.ok(text.includes("read_file"), text);
});

/**
 * **비어 있는 고정 집합은 설정이 아니라 프로젝트의 사실이다.** 이유를 말하지 않으면 사용자는
 * 자동 승인 스위치가 고장 났다고 읽는다.
 */
test("검증 명령이 없으면 자동 승인이 무의미하다고 말한다", () => {
  const text = describeVerificationPin({ verificationPin: [] });
  assert.ok(text.includes("자동 승인될 명령이 없습니다"), text);
});

test("고정된 검증 명령은 argv 그대로 보인다", () => {
  const text = describeVerificationPin({ verificationPin: [{ program: "npm", args: ["test"] }] });
  assert.ok(text.includes("npm test"), text);
});

/** **끈 것도 보여준다** — 안 보이면 "켰다고 생각했는데"를 확인할 수 없다. */
test("스위치는 꺼진 것도 줄로 남는다", () => {
  const lines = switchLines({ executionMode: "fast", unattended: false });
  const unattended = lines.find((l) => l.label === "무인 실행")!;
  assert.equal(unattended.value, "꺼짐");
  assert.equal(unattended.enabled, false);
  // 모르는 값을 지어내지 않는다.
  const lines2 = switchLines({});
  assert.equal(lines2.find((l) => l.label === "실행 모드")!.value, "(모름)");
});

/** MCP는 **좁혀졌는지를 함께 말한다** — 이름만 보면 무엇이든 부를 수 있다고 읽는다. */
test("MCP 서버 줄이 좁혀졌는지를 말한다", () => {
  const open = describeMcpServer({ name: "notes", program: "node", args: ["s.js"] });
  const narrowed = describeMcpServer({ name: "notes", program: "node", args: ["s.js"], tools: ["read"] });
  assert.ok(open.includes("도구 전부"), open);
  assert.ok(narrowed.includes("1개로 제한"), narrowed);
  assert.ok(narrowed.includes("read"), narrowed);
  // 실행될 명령이 그대로 보인다 (원칙 6).
  assert.ok(open.includes("node s.js"), open);
});

/** 빈 설정에서도 문장이 만들어져야 한다 — 이벤트가 낡은 형식이면 화면이 죽으면 안 된다. */
test("모르는 값이 있어도 문장이 만들어진다", () => {
  const empty: PinnedConfig = {};
  assert.ok(switchLines(empty).length > 0);
  assert.ok(describeAllowedTools(empty).length > 0);
  assert.ok(describeVerificationPin(empty).length > 0);
});

/**
 * 격리 실행의 줄 (38절). **"격리했다"만으로는 부족하다** — 사용자가 다음에 하는 일은 결과를
 * 여는 것이고, 그러려면 경로가 있어야 한다.
 */
test("격리 실행은 브랜치와 경로를 함께 말한다", () => {
  const text = describeIsolation({
    isolation: {
      repo: "/repo",
      branch: "feature",
      path: "/state/worktrees/tomverse-feature",
      reused: false,
      mainTreeDirty: false,
    },
  });
  assert.ok(text.includes("feature"), text);
  assert.ok(text.includes("tomverse-feature"), text);
});

/** 본체에서 돌았다는 것도 **말한다** — 침묵하면 사용자는 격리됐다고 가정할 수 없다. */
test("격리하지 않은 실행도 어디서 돌았는지 말한다", () => {
  const text = describeIsolation({});
  assert.ok(text.includes("본체"), text);
});

/** 이어 쓴 트리와 더러웠던 본체는 **다른 문장이 된다** — 뭉개면 결과 diff를 오독한다. */
test("이어 쓴 트리와 더러웠던 본체가 문장에 남는다", () => {
  const base = { repo: "/r", branch: "b", path: "/p", reused: false, mainTreeDirty: false };
  const plain = describeIsolation({ isolation: base });
  const reused = describeIsolation({ isolation: { ...base, reused: true } });
  const dirty = describeIsolation({ isolation: { ...base, mainTreeDirty: true } });
  assert.ok(reused.includes("이어 썼습니다"), reused);
  assert.ok(dirty.includes("포함되지 않았습니다"), dirty);
  assert.notEqual(plain, reused);
  assert.notEqual(plain, dirty);
});

/** **상한이 없다는 것도 사실이다.** 침묵하면 사용자는 기본 상한이 있다고 가정한다. */
test("시한이 없으면 없다고 말하고, 무인 실행이면 그 결과까지 말한다", () => {
  const attended = describeDeadline({});
  const unattended = describeDeadline({ unattended: true });
  assert.ok(attended.includes("시한 없음"), attended);
  assert.ok(unattended.includes("끝날 때까지"), unattended);
  assert.notEqual(attended, unattended);
});

test("시한은 분으로 보이고, 사용자 취소와 다르다는 것을 말한다", () => {
  const text = describeDeadline({ deadlineMs: 1_800_000 });
  assert.ok(text.includes("30분"), text);
  assert.ok(text.includes("다른 사유"), text);
});

/** 1분 미만을 "0분"으로 반올림하지 않는다 — 0은 "즉시 멈춘다"로 읽힌다. */
test("1분 미만의 시한을 0분으로 뭉개지 않는다", () => {
  const text = describeDeadline({ deadlineMs: 500 });
  assert.ok(!text.includes("0분"), text);
});

// ---- 시작 이후의 변화 (state-machine 37.8절, ui-wireframes 3.23절) ----

function withdrawn(kind: string, times = 1) {
  return Array.from({ length: times }, () => ({
    type: "PRE_APPROVAL_WITHDRAWN",
    payload: { wouldHaveBeen: kind, requestId: "r", reason: "매니페스트가 바뀜" },
  }));
}

/**
 * **값을 고쳐 쓰지 않는다.**
 *
 * 스위치는 여전히 켜져 있다 — 바뀐 것은 "그 스위치가 답할 수 있는가"이지 스위치가 아니다.
 * "꺼짐"으로 고쳐 쓰면 새 거짓말이 하나 생긴다: 사용자는 끈 적이 없고, 매니페스트가
 * 안정되면 같은 설정이 다시 답한다.
 */
test("사전 승인 철회는 스위치 값을 바꾸지 않고 그 줄에 붙는다", () => {
  const changes = pinnedChanges(withdrawn("APPROVAL_AUTO_VERIFICATION", 2));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.target, "verification");
  assert.equal(changes[0]!.count, 2, "횟수를 세지 않습니다 — 한 번과 여러 번은 다른 사실입니다");
  assert.match(changes[0]!.note, /스위치는 그대로/);
  // **다음에 무슨 일이 일어나는지 말한다.** "성립하지 않았다"만으로는 사용자가 할 일을 모른다.
  assert.match(changes[0]!.note, /무인 실행이면 거기서 멈춥니다/);

  // 그리고 스위치 줄 자체는 그대로다.
  const lines = switchLines({ autoApproveVerification: true });
  const line = lines.find((l) => l.label === "검증 명령 자동 승인");
  assert.equal(line?.value, "켜짐", "값을 고쳐 썼습니다");
  assert.equal(line?.enabled, true);
});

/** 훅 쪽은 **다른 줄**이다 — 어느 줄인지는 이벤트의 `wouldHaveBeen`이 말한다. */
test("훅의 사전 승인 철회는 훅 줄로 간다", () => {
  const changes = pinnedChanges(withdrawn("APPROVAL_REGISTERED_HOOK"));
  assert.deepEqual(changes.map((c) => c.target), ["hooks"]);
  assert.match(changes[0]!.note, /등록은 그대로/);
});

/**
 * **모르는 것을 아는 줄에 붙이지 않는다.**
 *
 * 새 사전 승인 종류가 생기면 어느 줄인지 우리가 모른다. 아무 데나 붙이면 그 줄의 문장이
 * 무엇도 뜻하지 않게 되고, 버리면 "아무 일도 없었다"가 된다 — 둘 다 틀리다.
 */
test("모르는 종류의 철회는 자기 자리를 갖는다", () => {
  const changes = pinnedChanges(withdrawn("APPROVAL_SOMETHING_NEW"));
  assert.deepEqual(changes.map((c) => c.target), ["unknown"]);
  assert.match(changes[0]!.note, /알지 못합니다/);
  // 아는 줄에 섞이지 않았다.
  assert.ok(!changes.some((c) => c.target === "verification" || c.target === "hooks"));
});

/** 아무 일도 없었으면 **아무것도 붙이지 않는다** — 언제나 붙으면 신호가 아니라 배경이 된다. */
test("철회가 없으면 붙는 문장도 없다", () => {
  assert.deepEqual(pinnedChanges([{ type: "TASK_CONFIG_PINNED", payload: {} }]), []);
});

/** 순서가 실행마다 달라지면 같은 사실이 달라 보인다. */
test("여러 종류가 섞여도 순서가 고정된다", () => {
  const events = [
    ...withdrawn("APPROVAL_REGISTERED_HOOK"),
    ...withdrawn("APPROVAL_SOMETHING_NEW"),
    ...withdrawn("APPROVAL_AUTO_VERIFICATION"),
  ];
  assert.deepEqual(
    pinnedChanges(events).map((c) => c.target),
    ["verification", "hooks", "unknown"]
  );
});

// ---- 무엇이 좁혔는가 (state-machine 70절) ----

/**
 * **목록만 보면 왜 짧은지 모른다.** 좁히는 주체가 둘이라(스킬, 읽기 전용 종류) 스킬 줄과
 * 목록 줄을 함께 봐도 추측이 된다 — 질문·계획 태스크는 스킬이 없어도 좁아진다.
 */
test("허용목록 줄이 무엇이 좁혔는지 말한다", () => {
  const line = describeAllowedTools({
    allowedTools: ["read_file", "list_files"],
    allowedToolsNarrowedBy: ["read_only_kind"],
  });
  assert.match(line, /2개/);
  assert.match(line, /읽기 전용 종류/);
  // 스킬이 아니라는 것이 드러나야 한다 — 사용자가 자기 스킬을 의심하지 않도록.
  assert.ok(!line.includes("스킬"), line);
});

/** **둘 다일 수 있다.** 하나만 말하면 사용자는 나머지를 자기 설정 탓으로 돌린다. */
test("둘 다 좁혔으면 둘 다 말한다", () => {
  const line = describeAllowedTools({
    allowedTools: ["read_file"],
    allowedToolsNarrowedBy: ["skill", "read_only_kind"],
  });
  assert.match(line, /스킬/);
  assert.match(line, /읽기 전용 종류/);
});

/**
 * **좁혀졌는데 이유가 없는 것은 "아무도 안 좁혔다"와 다른 사실이다.**
 *
 * 이 값이 생기기 전의 태스크가 그렇다. 침묵하면 화면이 "그냥 짧다"로 보이는데, 그건 우리가
 * 아는 사실이 아니다.
 */
test("좁혀졌는데 출처가 없으면 그 사실을 말한다", () => {
  const line = describeAllowedTools({ allowedTools: ["read_file"] });
  assert.match(line, /기록에 없습니다/);
});

/** 좁히지 않았으면 출처 문장도 없다 — 붙일 것이 없다. */
test("좁히지 않았으면 출처를 말하지 않는다", () => {
  const line = describeAllowedTools({});
  assert.match(line, /좁히지 않았습니다/);
  assert.ok(!line.includes("좁힌 것"), line);
  assert.ok(!line.includes("기록에 없습니다"), line);
});
