import test from "node:test";
import assert from "node:assert/strict";
import { adviseOnBlocked, type BlockedReport } from "../src/lib/blockedAdvice.js";

function report(over: Partial<BlockedReport> = {}): BlockedReport {
  return {
    verdict: "unblockable_by_policy",
    stops: [
      {
        requestId: "req-1",
        tool: "apply_patch",
        normalizedTarget: "src/app.ts",
        matchedRule: "workspace_write_requires_approval",
        unblockedBy: "autoApproveWorkspaceWrites",
        rerunFlag: "--auto-approve-writes",
      },
    ],
    rerunFlags: ["--auto-approve-writes"],
    humanOnly: [],
    caveat: "이 목록은 이번 실행이 실제로 도달한 승인 지점까지입니다",
    ...over,
  };
}

test("정지가 없으면 이 영역을 그리지 않는다", () => {
  const advice = adviseOnBlocked(report({ verdict: "not_blocked", stops: [], rerunFlags: [] }));
  assert.equal(advice.show, false);
});

test("보고서가 없어도 무너지지 않는다", () => {
  // 아직 조회하지 않은 상태와 "정지가 없었다"는 다른 사실이지만, 화면이 그릴 것이 없는 것은 같다.
  assert.equal(adviseOnBlocked(null).show, false);
});

test("정책으로 열리는 정지는 켤 것을 알려준다", () => {
  const advice = adviseOnBlocked(report());
  assert.equal(advice.show, true);
  assert.equal(advice.needsHuman, false);
  assert.deepEqual(advice.flags, ["--auto-approve-writes"]);
  assert.match(advice.headline, /다시 돌리면/);
});

/**
 * **이 화면에서 가장 하기 쉬운 거짓말을 막는다.**
 *
 * 열리는 플래그가 있으면 그것만 보여주고 싶어지는데, 그러면 사용자는 켜고 다시 돌렸다가 같은
 * 자리에서 또 멈춘다. `humanOnly`가 하나라도 있으면 화면이 그 사실을 먼저 말해야 한다.
 */
test("정책으로 못 여는 정지가 있으면 플래그를 보여주더라도 그 사실을 먼저 말한다", () => {
  const advice = adviseOnBlocked(
    report({
      verdict: "requires_human",
      humanOnly: ["req-2"],
      rerunFlags: ["--auto-approve-writes"],
      stops: [
        ...report().stops,
        {
          requestId: "req-2",
          tool: "mcp_call",
          normalizedTarget: "s.t",
          matchedRule: "mcp_always_requires_approval",
          unblockedBy: "humanOnly",
          rerunFlag: null,
        },
      ],
    })
  );
  assert.equal(advice.needsHuman, true);
  assert.match(advice.headline, /정책으로 열 수 없습니다/);
  // 열리는 쪽은 그래도 알려준다 — 사람이 붙어도 그 왕복은 줄어든다.
  assert.deepEqual(advice.flags, ["--auto-approve-writes"]);
});

/** 보고서가 스스로 밝힌 한계를 화면이 지우지 않는다. */
test("한계 문장이 그대로 전달된다", () => {
  const advice = adviseOnBlocked(report());
  assert.equal(advice.caveat, report().caveat);
});
