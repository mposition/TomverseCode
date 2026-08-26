import test from "node:test";
import assert from "node:assert/strict";
import { planFollowUp } from "../src/lib/followUpRun.js";
import { SCREEN_FLAGS } from "../src/lib/autopilotPreview.js";
import type { BlockedReport } from "../src/lib/blockedAdvice.js";

function report(over: Partial<BlockedReport> = {}): BlockedReport {
  return {
    verdict: "unblockable_by_policy",
    stops: [
      {
        requestId: "r-1",
        tool: "run_tests",
        normalizedTarget: "npm test",
        matchedRule: "verification",
        unblockedBy: "autoApproveVerification",
        rerunFlag: "--auto-approve-verification",
      },
    ],
    rerunFlags: ["--auto-approve-verification"],
    humanOnly: [],
    caveat: "한계",
    ...over,
  };
}

test("정지가 없으면 이어서 돌릴 것도 없다", () => {
  assert.equal(planFollowUp(null).show, false);
  assert.equal(planFollowUp(report({ stops: [], rerunFlags: [] })).show, false);
});

/**
 * **"재개"라고 부르지 않는다** — ui-wireframes 5절 ③, state-machine 62절.
 *
 * 무인 정지는 `FAILED`로 끝나고 그 시점의 초안·검수·계획은 sidecar의 메모리에 있었다.
 * 프로세스가 끝나면 사라지므로 **재개할 상태가 없다.** 재개라고 부르면 사용자는 토큰이
 * 다시 나가지 않는다고 믿는다.
 */
test("재개가 아니라 새 실행이라고 말한다", () => {
  const plan = planFollowUp(report());
  assert.match(plan.notAResume, /재개가 아니라/);
  assert.match(plan.notAResume, /토큰도 다시 나갑니다/);
});

/** **워크스페이스 상태를 말한다.** 앞선 실행의 변경이 그대로 남아 있다. */
test("앞선 변경이 남아 있다는 사실을 말한다", () => {
  assert.match(planFollowUp(report()).workspaceNote, /그대로 남아 있습니다/);
});

/** 켤 것은 **보고서에서 유도한다** — 화면이 손으로 적으면 레버가 늘 때 화면만 뒤처진다. */
test("켤 스위치를 보고서에서 유도한다", () => {
  assert.deepEqual(planFollowUp(report()).grant, ["--auto-approve-verification"]);
  assert.equal(planFollowUp(report()).canRerun, true);
});

/**
 * **켜는 범위를 말한다.** 사용자는 정지 하나 때문에 켜는데 그 스위치는 실행 전체에 적용된다 —
 * 버튼이 생기는 순간 그 한 번의 클릭이 무엇을 넓히는지가 사용자에게서 멀어진다.
 */
test("스위치가 실행 전체에 적용된다고 말한다", () => {
  assert.match(planFollowUp(report()).scopeWarning, /다음 실행 전체/);
});

/**
 * **이 화면에 없는 스위치를 "켜고"라고 말하지 않는다** — 48.3절이 미리보기에서 잡은 것과
 * 같은 거짓말이 버튼 쪽에서 되살아나는 자리다.
 */
test("화면에 토글이 없는 스위치를 갈라낸다", () => {
  const plan = planFollowUp(
    report({ rerunFlags: ["--auto-approve-verification", "--auto-approve-writes"] })
  );
  assert.deepEqual(plan.grant, ["--auto-approve-verification"]);
  assert.deepEqual(plan.cliOnly, ["--auto-approve-writes"]);
  assert.match(plan.scopeWarning, /이 화면에 없는 스위치/);
  assert.match(plan.scopeWarning, /명령줄에서만/);
  // 화면 토글 목록과 실제로 대조하고 있다는 것.
  assert.ok(!SCREEN_FLAGS.includes("--auto-approve-writes"));
});

/**
 * **켤 것이 하나도 없으면 버튼을 주지 않는다.** 같은 설정으로 다시 돌리면 같은 자리에서 또
 * 멈추고, 그건 사용자의 시간과 토큰을 쓰는 것 말고는 하는 일이 없다.
 */
test("켤 것이 없으면 다시 돌릴 수 없다고 말한다", () => {
  const plan = planFollowUp(report({ rerunFlags: [], humanOnly: ["secret_path_write"] }));
  assert.equal(plan.canRerun, false);
  assert.equal(plan.blockedByHumanOnly, true);
});

/** 명령줄에서만 켤 수 있는 것만 남아도 **이 화면에서는** 돌릴 수 없다. */
test("명령줄 전용 스위치만 남으면 이 화면에서는 못 돌린다", () => {
  const plan = planFollowUp(report({ rerunFlags: ["--auto-approve-writes"] }));
  assert.equal(plan.canRerun, false);
  assert.deepEqual(plan.grant, []);
  assert.match(plan.scopeWarning, /이 화면에서 켤 수 있는 스위치가 없습니다/);
});

/**
 * **더 멀리 가지만 끝까지 가지는 못한다**는 것을 함께 말한다. 말하지 않으면 사용자는
 * 켜고 돌렸다가 다른 자리에서 또 멈추고, 그 두 번째 정지를 도구의 오작동으로 읽는다.
 */
test("열 수 없는 정지가 남아 있으면 그 사실을 함께 말한다", () => {
  const plan = planFollowUp(report({ humanOnly: ["secret_path_write"] }));
  assert.equal(plan.canRerun, true);
  assert.match(plan.scopeWarning, /끝까지 가지는 못합니다/);
});
