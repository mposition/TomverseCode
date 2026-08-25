import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAllowedTools,
  describeIsolation,
  describeMcpServer,
  describeVerificationPin,
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
