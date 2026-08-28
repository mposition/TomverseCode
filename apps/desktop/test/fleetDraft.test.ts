import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewFleetDraft } from "../src/lib/fleetDraft.js";

/** 저장소의 소스를 찾는다 — `frontendTrust.test.ts`와 같은 방법(표식 디렉터리를 위로 찾는다). */
function findUp(name: string, from: string): string {
  let current = from;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, name))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`${from}에서 ${name}을 가진 디렉터리를 찾지 못했습니다`);
}

/**
 * Fleet 시작 폼이 **보내기 전에 말하는 것** — ui-wireframes 3.30절.
 *
 * 판정은 Rust가 한다(`fleet::plan`). 여기서 재는 것은 "화면이 상한보다 큰 값을 받아 놓고
 * 나중에 거부하지 않는가"이고, 그 상한이 **화면의 상수가 아니라 Rust가 보내준 값**인가다.
 */

const BASE = { perTaskText: "", fleetCapText: "" };

test("빈 줄은 구성원이 아니다 — 그리고 하나도 없으면 시작할 수 없다", () => {
  const view = reviewFleetDraft({
    ...BASE,
    maxFleetSize: 8,
    members: [
      { branch: "", message: "" },
      { branch: " feat-a ", message: " 고쳐줘 " },
      { branch: "", message: "" },
    ],
  });
  assert.deepEqual(view.members, [{ branch: "feat-a", message: "고쳐줘" }]);
  assert.equal(view.canStart, true);

  const empty = reviewFleetDraft({ ...BASE, maxFleetSize: 8, members: [{ branch: "", message: "" }] });
  assert.equal(empty.canStart, false);
  assert.match(empty.problems.join("\n"), /구성원이 없습니다/);
});

/** **화면이 상한보다 큰 값을 받아 놓고 나중에 거부하면 안 된다.** */
test("크기 상한을 넘으면 시작 전에 막고, 남은 자리를 말한다", () => {
  const members = Array.from({ length: 9 }, (_, i) => ({ branch: `m${i}`, message: "x" }));
  const view = reviewFleetDraft({ ...BASE, maxFleetSize: 8, members });
  assert.equal(view.canStart, false);
  assert.match(view.problems.join("\n"), /최대 8개/);
  assert.equal(view.remainingSlots, 0);

  const room = reviewFleetDraft({ ...BASE, maxFleetSize: 8, members: members.slice(0, 3) });
  assert.equal(room.remainingSlots, 5);
});

/**
 * **모르는 것을 통과로도 실패로도 접지 않는다.** 상한을 아직 받지 못했으면 크기를 판정하지
 * 않는다 — 화면이 자기가 아는 숫자를 지어내면 그 숫자는 Rust와 갈라진다.
 */
test("상한을 받지 못했으면 크기를 판정하지 않는다", () => {
  const members = Array.from({ length: 20 }, (_, i) => ({ branch: `m${i}`, message: "x" }));
  const view = reviewFleetDraft({ ...BASE, maxFleetSize: null, members });
  assert.equal(view.remainingSlots, null);
  assert.equal(view.problems.filter((p) => p.includes("최대")).length, 0);
});

/** 같은 브랜치가 둘이면 두 구성원이 같은 트리를 쓴다 — **격리가 아니게 된다.** */
test("같은 브랜치를 두 번 적으면 막는다", () => {
  const view = reviewFleetDraft({
    ...BASE,
    maxFleetSize: 8,
    members: [
      { branch: "a", message: "x" },
      { branch: "a", message: "y" },
    ],
  });
  assert.equal(view.canStart, false);
  assert.match(view.problems.join("\n"), /격리가 아닙니다/);
});

test("요청 내용이 없는 구성원을 막는다", () => {
  const view = reviewFleetDraft({
    ...BASE,
    maxFleetSize: 8,
    members: [{ branch: "a", message: "" }],
  });
  assert.equal(view.canStart, false);
  assert.match(view.problems.join("\n"), /요청 내용이 없습니다/);
});

/**
 * **합계 상한은 태스크당 상한을 요구한다.** 예약할 금액을 모르면 "합계 상한이 있다"는 말이
 * 거짓이 된다(`fleet::FleetError::BudgetUnbounded`).
 */
test("합계 상한만 걸면 시작 전에 그 사실을 말한다", () => {
  const view = reviewFleetDraft({ maxFleetSize: 8, members: [{ branch: "a", message: "x" }], perTaskText: "", fleetCapText: "10" });
  assert.equal(view.canStart, false);
  assert.match(view.problems.join("\n"), /태스크당 상한도 있어야 합니다/);
});

test("어떤 구성원도 시작할 수 없는 상한을 막는다", () => {
  const view = reviewFleetDraft({
    maxFleetSize: 8,
    members: [{ branch: "a", message: "x" }],
    perTaskText: "5",
    fleetCapText: "3",
  });
  assert.equal(view.canStart, false);
  assert.match(view.problems.join("\n"), /어떤 구성원도 시작할 수 없습니다/);
});

/**
 * **"상한 안에서 끝났다"와 "상한이 없었다"는 정반대의 사실이다** — 시작 전에도 같다.
 * 그리고 태스크당 상한을 합계로 오인하지 않게 한다(11.2②가 지적한 그 착각).
 */
test("합계 상한이 없으면 태스크당 상한이 합계를 통제하지 않는다고 말한다", () => {
  const withPerTask = reviewFleetDraft({
    maxFleetSize: 8,
    members: [{ branch: "a", message: "x" }],
    perTaskText: "2",
    fleetCapText: "",
  });
  assert.equal(withPerTask.canStart, true);
  assert.match(withPerTask.notices.join("\n"), /각각.*곱해집니다/s);

  const none = reviewFleetDraft({ ...BASE, maxFleetSize: 8, members: [{ branch: "a", message: "x" }] });
  assert.match(none.notices.join("\n"), /상한이 없습니다/);
});

/**
 * **상한 숫자를 화면에 적지 않는다.** 적으면 상한이 두 벌이 되고, 두 벌은 갈라진다 —
 * 그리고 갈라진 화면은 자기가 아는 숫자를 자신 있게 말한다.
 */
test("크기 상한이 화면 소스에 상수로 박혀 있지 않다", () => {
  // **컴파일된 위치가 아니라 저장소의 소스를 본다.** 이 테스트는 `dist-test/test/`에서 돌므로
  // `../src`는 산출물(.js)을 가리키고, 그러면 이 검사는 없는 파일에 대해 실패하거나(지금)
  // 다른 파일을 세게 된다 — `frontendTrust.test.ts`와 같은 방법으로 저장소 표식을 찾는다.
  const source = readFileSync(
    path.join(findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))), "src", "lib", "fleetDraft.ts"),
    "utf8"
  );
  // 주석의 "여기 `8`을 적으면"이라는 설명까지 걸리지 않도록, 값이 쓰이는 자리만 본다.
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(/\bMAX_FLEET_SIZE\b/.test(code), false, "화면이 상한을 자기 상수로 들고 있습니다");
  assert.ok(code.includes("input.maxFleetSize"), "상한을 Rust가 보내준 값에서 읽지 않습니다");
});
