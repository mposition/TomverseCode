import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_ONLY_FLAGS,
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
 * `--auto-approve-writes`가 이 갈래의 유일한 실례였고 63절에서 화면에 올라왔다. 그래서
 * 지금 `CLI_ONLY_FLAGS`는 비어 있고, **이 검사는 화면 토글 집합을 명시적으로 넘겨서**
 * 잰다 — 갈래가 사라진 것이 아니라 실례가 사라진 것이기 때문이다. 다음 레버가 생기는 날
 * 이 문장이 다시 필요해지고, 그때 갈래가 없으면 화면은 **켤 수 없는 것을 켜라고 말한다.**
 *
 * (그 "다음 레버"가 조용히 생기지 않는다는 것은 아래 소스 대조 검사가 지킨다.)
 */
test("화면에 토글이 없는 스위치는 명령줄에서만 켤 수 있다고 말한다", () => {
  const s = summarizePreview(preview({ stops: [stop({ rerunFlag: "--not-on-this-screen" })] }), [
    "--auto-approve-verification",
  ]);
  const line = s.stops[0]!;
  assert.equal(line.kind, "cli_only");
  assert.equal(line.flag, "--not-on-this-screen");
  assert.match(line.detail, /이 화면에는 그 스위치가 없습니다/);
  // 그래도 **무엇을 켜면 되는지는 말한다** — 이름을 감추면 명령줄로도 못 간다.
  assert.match(line.detail, /--not-on-this-screen/);
});

/**
 * **게이트가 아는 레버는 전부 둘 중 하나에 들어 있다** — state-machine 63절.
 *
 * `SCREEN_FLAGS`는 손으로 적은 목록이고, 판정 기준(어떤 레버가 있는가)은 Rust에 있다.
 * 두 곳이 갈라지면 증상이 조용하다 — 새 레버가 생겼는데 화면 목록이 낡으면, 미리보기는
 * 그 정지를 "이 화면에는 그 스위치가 없습니다"로 말한다. **없는 것이 아니라 우리가 안
 * 만든 것인데**, 사용자는 그 문장을 우리가 판단해서 적은 것으로 읽는다.
 *
 * 그래서 Rust의 `PolicyLever::rerun_flag`에서 유도해 대조한다. 새 레버가 생기면
 * `SCREEN_FLAGS`(토글을 만든다)와 `CLI_ONLY_FLAGS`(만들지 않기로 한다) 중 **어디에 넣을지
 * 고르지 않고는** 이 검사를 지날 수 없다.
 */
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

/** Rust의 `fn rerun_flag` 본문에 적힌 플래그 리터럴들. */
function gateFlags(): string[] {
  const types = path.join(
    findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))),
    "src-tauri",
    "core",
    "src",
    "types.rs"
  );
  const source = readFileSync(types, "utf8");
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일이 검사 대상처럼 보인다.
  const marker = "fn rerun_flag" + "(";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${types}에서 레버→플래그 표를 찾지 못했습니다`);
  const body = source.slice(at, source.indexOf("\n    }", at));
  return [...body.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1] as string);
}

test("게이트가 아는 플래그를 소스에서 읽을 수 있다", () => {
  // 0개면 아래 비교가 빈 집합에 대한 전칭 명제가 된다 — 형식이 바뀐 경우다.
  assert.ok(gateFlags().length >= 3, `플래그를 ${gateFlags().length}개만 읽었습니다`);
});

test("게이트의 레버는 전부 화면 목록이나 명령줄 전용 목록에 있다", () => {
  const known = new Set([...SCREEN_FLAGS, ...CLI_ONLY_FLAGS]);
  const unclassified = gateFlags().filter((flag) => !known.has(flag));
  assert.deepEqual(
    unclassified,
    [],
    `어느 목록에도 없는 레버가 있습니다: ${unclassified.join(", ")}. ` +
      `화면에 토글을 만들었으면 SCREEN_FLAGS에, 만들지 않기로 했으면 CLI_ONLY_FLAGS에 넣을 것.`
  );
});

test("두 목록에 게이트가 모르는 플래그를 지어내지 않는다", () => {
  const gate = new Set(gateFlags());
  const invented = [...SCREEN_FLAGS, ...CLI_ONLY_FLAGS].filter((flag) => !gate.has(flag));
  assert.deepEqual(invented, [], `게이트가 모르는 플래그: ${invented.join(", ")}`);
  // 그리고 한 플래그가 양쪽에 동시에 있으면 안 된다 — 화면에 있으면서 없을 수는 없다.
  const both = SCREEN_FLAGS.filter((flag) => CLI_ONLY_FLAGS.includes(flag));
  assert.deepEqual(both, [], `두 목록에 동시에 있습니다: ${both.join(", ")}`);
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

/**
 * 할 수 있는 일 순서로 정렬한다 — `human_only`가 마지막인 이유는 **할 일이 없어서**다.
 *
 * 넷째 자리(`cli_only`)에는 **화면 목록에 없는 이름**을 쓴다. 63절 전에는 여기에
 * `--auto-approve-writes`가 들어 있었는데, 그 스위치가 화면에 올라오자 이 검사는 갈래
 * 순서가 아니라 **입력 순서**를 재게 됐다(둘 다 `toggle_here`가 되어 안정 정렬이 그대로
 * 둔다). 실례가 사라진 갈래를 재려면 이름을 만들어 넣어야 한다.
 */
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
        stop({ probe: "화면에 없는 스위치", rerunFlag: "--not-on-this-screen" }),
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
    ["검증", "화면에 없는 스위치", "commit", "지우기"]
  );
  // 네 갈래가 실제로 다 나왔는지 — 하나라도 같은 갈래로 접히면 위 비교는 순서가 아니라
  // 입력 순서를 재게 된다.
  assert.deepEqual(
    s.stops.map((l) => l.kind),
    ["toggle_here", "cli_only", "lever_does_not_free", "human_only"]
  );
});

/** 미리보기가 스스로 밝힌 한계를 **화면이 지우지 않는다.** */
test("한계 문장이 그대로 실린다", () => {
  const s = summarizePreview(preview({ stops: [stop({})] }));
  assert.equal(s.caveat, "대표 요청에 대한 답입니다");
});
