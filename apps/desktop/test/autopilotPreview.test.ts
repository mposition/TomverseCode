import test from "node:test";
import assert from "node:assert/strict";
import {
  SCREEN_FLAGS,
  summarizePreview,
  type AutopilotPermission,
  type AutopilotPreview,
} from "../src/lib/autopilotPreview.js";

function stop(over: Partial<AutopilotPermission>): AutopilotPermission {
  return {
    tool: "apply_patch",
    probe: "소스 파일 고치기",
    decision: "require_user_approval",
    matchedRule: "workspace_write_requires_approval",
    fate: { kind: "unattended_stop", lever: "autoApproveWorkspaceWrites" },
    rerunFlag: "--auto-approve-writes",
    ...over,
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
    rerunFlags: [],
    humanOnly: [],
    caveat: "대표 요청에 대한 답입니다",
    ...over,
  };
}

/** 무인 실행을 켜지 않았으면 이 영역은 그리지 않는다 — 그 설정에 대한 답이 아니다. */
test("무인 실행이 꺼져 있으면 미리보기를 그리지 않는다", () => {
  const s = summarizePreview(preview({ switches: { ...preview().switches, unattended: false } }));
  assert.equal(s.show, false);
});

/** **아직 묻지 않음**과 **멈추는 곳 없음**은 다른 사실이다. */
test("묻지 않은 상태와 멈추지 않는 설정을 구별한다", () => {
  assert.equal(summarizePreview(null).show, false);
  const none = summarizePreview(preview());
  assert.equal(none.show, true);
  assert.match(none.headline, /멈추지 않습니다/);
});

/**
 * **이 화면에 없는 스위치를 "켜세요"라고 말하지 않는다** (48.3절).
 *
 * `--auto-approve-writes`는 게이트가 아는 레버지만 화면에 토글이 없다. 켤 수 없는 것을
 * 켜라고 하면 사용자는 없는 체크박스를 찾다가 도구를 의심한다.
 */
test("화면에 토글이 없는 스위치는 명령줄에서만 켤 수 있다고 말한다", () => {
  const s = summarizePreview(preview({ stops: [stop({})] }));
  const line = s.stops[0]!;
  assert.equal(line.kind, "cli_only");
  assert.equal(line.flag, "--auto-approve-writes");
  assert.match(line.detail, /이 화면에는 그 스위치가 없습니다/);
  // 그래도 **무엇을 켜면 되는지는 말한다** — 이름을 감추면 명령줄로도 못 간다.
  assert.match(line.detail, /--auto-approve-writes/);
});

/** 화면에 있는 스위치는 "켜면 지나갑니다"라고 말한다 — 위 검사가 언제나 `cli_only`를 내는 것이 아니다. */
test("화면에 토글이 있는 스위치는 여기서 켜라고 말한다", () => {
  const s = summarizePreview(
    preview({
      stops: [
        stop({
          probe: "프로젝트가 선언한 검증 명령 실행",
          tool: "run_tests",
          fate: { kind: "unattended_stop", lever: "autoApproveVerification" },
          rerunFlag: "--auto-approve-verification",
        }),
      ],
    })
  );
  assert.equal(s.stops[0]?.kind, "toggle_here");
  assert.ok(SCREEN_FLAGS.includes("--auto-approve-verification"));
});

/**
 * **`humanOnly`를 "스위치를 켜세요"로 뭉개지 않는다** (24.8.2절).
 *
 * 같은 목록에 열리는 정지가 함께 있어도 이 판정이 흐려지면 안 된다.
 */
test("사람만 지날 수 있는 정지는 스위치를 권하지 않는다", () => {
  const s = summarizePreview(
    preview({
      stops: [
        stop({}),
        stop({
          probe: "파일 지우기",
          tool: "delete_file",
          matchedRule: "delete_always_requires_approval",
          fate: { kind: "unattended_stop", lever: "humanOnly" },
          rerunFlag: null,
        }),
      ],
    })
  );
  const human = s.stops.find((l) => l.probe === "파일 지우기")!;
  assert.equal(human.kind, "human_only");
  assert.equal(human.flag, null);
  assert.match(human.detail, /어떤 스위치로도 열 수 없습니다/);
  // **막힌 개수를 머리글이 먼저 말한다.** 뒤에 묻으면 "몇 개 켜면 된다"로 읽힌다.
  assert.match(s.headline, /1곳은 어떤 스위치로도 열 수 없습니다/);
});

/**
 * **켜도 열리지 않는 스위치를 권하지 않고, 그 사실을 지우지도 않는다** (47.6절).
 *
 * Rust가 이미 걸러 `leverDoesNotFree`로 넘겨준다. 화면이 그것을 버리면 그 정지에 대해
 * 사용자가 아무 설명도 받지 못한다.
 */
test("켜도 열리지 않는 스위치는 그렇다고 말한다", () => {
  const s = summarizePreview(
    preview({
      stops: [
        stop({
          probe: "git commit 만들기",
          tool: "run_command",
          matchedRule: "git_commit_requires_explicit_approval",
          fate: { kind: "unattended_stop", lever: "allowGitCommit" },
          rerunFlag: null,
          leverDoesNotFree: "--allow-git-commit",
        }),
      ],
    })
  );
  const line = s.stops[0]!;
  assert.equal(line.kind, "lever_does_not_free");
  assert.match(line.detail, /켜도 이 자리는 열리지 않습니다/);
  // **`--allow-git-commit`은 화면에 있는 토글이다.** 그래도 `toggle_here`로 분류하면
  // 화면이 "켜면 지나갑니다"라고 말하게 된다 — 순서가 이 구별을 지킨다.
  assert.ok(SCREEN_FLAGS.includes("--allow-git-commit"));
});

/** 레버를 읽지 못한 정지를 **낙관으로 접지 않는다.** */
test("레버를 읽지 못하면 사람이 필요하다고 말한다", () => {
  const s = summarizePreview(preview({ stops: [stop({ fate: { kind: "unattended_stop" }, rerunFlag: null })] }));
  assert.equal(s.stops[0]?.kind, "human_only");
});

/** 할 수 있는 일 순서로 정렬한다 — `human_only`가 마지막인 이유는 **할 일이 없어서**다. */
test("정지 목록은 할 수 있는 일 순서로 나온다", () => {
  const s = summarizePreview(
    preview({
      stops: [
        stop({ probe: "지우기", fate: { kind: "unattended_stop", lever: "humanOnly" }, rerunFlag: null }),
        stop({
          probe: "commit",
          fate: { kind: "unattended_stop", lever: "allowGitCommit" },
          rerunFlag: null,
          leverDoesNotFree: "--allow-git-commit",
        }),
        stop({ probe: "쓰기" }),
        stop({
          probe: "검증",
          fate: { kind: "unattended_stop", lever: "autoApproveVerification" },
          rerunFlag: "--auto-approve-verification",
        }),
      ],
    })
  );
  assert.deepEqual(
    s.stops.map((l) => l.probe),
    ["검증", "쓰기", "commit", "지우기"]
  );
});

/** 미리보기가 스스로 밝힌 한계를 **화면이 지우지 않는다.** */
test("한계 문장이 그대로 실린다", () => {
  const s = summarizePreview(preview({ stops: [stop({})] }));
  assert.equal(s.caveat, "대표 요청에 대한 답입니다");
});
