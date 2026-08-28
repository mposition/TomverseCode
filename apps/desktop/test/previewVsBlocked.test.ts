import test from "node:test";
import assert from "node:assert/strict";
import { joinPreviewAndBlocked } from "../src/lib/previewVsBlocked.js";
import type { AutopilotPreview } from "../src/lib/autopilotPreview.js";
import type { BlockedReport } from "../src/lib/blockedAdvice.js";

function permission(matchedRule: string, probe = matchedRule) {
  return {
    tool: "apply_patch",
    probe,
    decision: "require_user_approval" as const,
    matchedRule,
    fate: { kind: "unattended_stop" },
    rerunFlag: null,
  };
}

function preview(over: Partial<AutopilotPreview> = {}): AutopilotPreview {
  return {
    switches: {
      unattended: true,
      autoApproveWorkspaceWrites: false,
      autoApproveVerification: false,
      allowGitCommit: false,
    },
    proceeds: [],
    stops: [],
    denied: [],
    caveat: "미리보기의 한계",
    ...over,
  } as AutopilotPreview;
}

function blocked(over: Partial<BlockedReport> = {}): BlockedReport {
  return {
    verdict: "unblockable_by_policy",
    stops: [],
    rerunFlags: [],
    humanOnly: [],
    caveat: "보고서의 한계",
    ...over,
  };
}

function stop(matchedRule: string, requestId = "r-1") {
  return { requestId, tool: "apply_patch", normalizedTarget: "src/a.ts", matchedRule, unblockedBy: "", rerunFlag: null };
}

/** **하나만 있으면 잇지 않는다.** 반쪽을 그리면 없는 쪽에 대해 말하지 않으면서 이어 본 척이 된다. */
test("둘 다 있어야 잇는다", () => {
  assert.equal(joinPreviewAndBlocked(null, blocked()).show, false);
  assert.equal(joinPreviewAndBlocked(preview(), null).show, false);
});

test("예고한 자리에서 멈추면 예고대로라고 말한다", () => {
  const view = joinPreviewAndBlocked(
    preview({ stops: [permission("secret_path_write_requires_approval")] }),
    blocked({ stops: [stop("secret_path_write_requires_approval")] })
  );
  assert.equal(view.stops[0]!.kind, "as_previewed");
  assert.match(view.headline, /전부 미리보기가 예고한 자리/);
});

/**
 * **가장 크게 말해야 하는 경우** — 미리보기가 "지나간다"고 한 자리에서 멈췄다.
 *
 * 이건 짝의 문제가 아니라 예고 자체가 어긋난 것이고, 미리보기를 믿고 무인으로 돌린
 * 사용자가 배신당한 자리다.
 */
test("지나간다고 한 자리에서 멈추면 어긋났다고 말한다", () => {
  const view = joinPreviewAndBlocked(
    preview({ proceeds: [permission("workspace_write_auto_approved")] }),
    blocked({ stops: [stop("workspace_write_auto_approved")] })
  );
  assert.equal(view.stops[0]!.kind, "contradicted");
  assert.match(view.stops[0]!.detail, /예고가 어긋났습니다/);
  // **어긋남을 헤드라인 앞에 둔다.** 뒤에 묻으면 "대체로 맞았다"로 읽힌다.
  assert.match(view.headline, /어긋난 정지가 1곳/);
});

/**
 * **미리보기가 다루지 않은 규칙은 "예고가 틀렸다"가 아니다** — 47.9절.
 *
 * 미리보기는 고정된 probe 집합에 답하고 실행은 모델이 실제로 요청한 것에 대해 벌어진다.
 * 둘은 짝이지 대체재가 아니므로, 뭉치면 도구가 스스로를 못 믿게 만든다.
 */
test("다루지 않은 규칙을 어긋남으로 세지 않는다", () => {
  const view = joinPreviewAndBlocked(preview(), blocked({ stops: [stop("mcp_call_always_approval")] }));
  assert.equal(view.stops[0]!.kind, "not_probed");
  assert.ok(!view.stops[0]!.detail.includes("어긋났"), view.stops[0]!.detail);
  assert.match(view.headline, /다루지 않은 규칙/);
  assert.ok(!view.headline.includes("어긋난"), view.headline);
});

/** 어긋남이 하나라도 있으면 **그것이 헤드라인을 이긴다** — 다른 분류에 묻히면 안 된다. */
test("어긋남이 다른 분류보다 먼저 말해진다", () => {
  const view = joinPreviewAndBlocked(
    preview({ proceeds: [permission("a")] }),
    blocked({ stops: [stop("zzz_not_probed", "r-1"), stop("a", "r-2")] })
  );
  assert.match(view.headline, /어긋난 정지가 1곳/);
});

/**
 * **예고했는데 닿지 않은 자리도 보여준다.** "예고가 틀렸다"가 아니라 대개 실행이 거기까지
 * 가지 않았다는 뜻이고(앞에서 멈췄거나 그 도구를 요청하지 않았다), 다음 실행에서 만날 수 있다.
 */
test("예고했지만 닿지 않은 자리를 따로 보여준다", () => {
  const view = joinPreviewAndBlocked(
    preview({ stops: [permission("a", "apply_patch probe"), permission("b")] }),
    blocked({ stops: [stop("a")] })
  );
  assert.deepEqual(
    view.notReached.map((n) => n.matchedRule),
    ["b"]
  );
});

/** 멈추지 않은 실행에도 예고 목록은 남는다 — 다음 실행에서 만날 수 있는 자리다. */
test("멈추지 않았으면 그렇다고 말하되 예고는 남긴다", () => {
  const view = joinPreviewAndBlocked(preview({ stops: [permission("a")] }), blocked({ verdict: "not_blocked" }));
  assert.equal(view.show, true);
  assert.match(view.headline, /멈추지 않았습니다/);
  assert.deepEqual(
    view.notReached.map((n) => n.matchedRule),
    ["a"]
  );
});

/**
 * **두 한계를 다 싣는다.** 하나만 실으면 이어 본 화면이 두 보고서보다 **더 많이 아는 것처럼**
 * 보인다 — 잇는 행위가 만들어내는 고유한 거짓말이다.
 */
test("두 보고서의 한계를 모두 싣는다", () => {
  const view = joinPreviewAndBlocked(preview(), blocked({ stops: [stop("a")] }));
  assert.deepEqual(view.caveats, ["미리보기의 한계", "보고서의 한계"]);
});

/** `denied`는 어긋남이 아니다 — 거부도 정지이므로 거기서 멈춘 것은 예고와 모순되지 않는다. */
test("거부한다고 한 자리에서 멈춘 것은 어긋남이 아니다", () => {
  const view = joinPreviewAndBlocked(
    preview({ denied: [permission("git_push_denied")] }),
    blocked({ stops: [stop("git_push_denied")] })
  );
  assert.notEqual(view.stops[0]!.kind, "contradicted");
});
