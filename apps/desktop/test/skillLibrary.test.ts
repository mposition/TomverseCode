import test from "node:test";
import assert from "node:assert/strict";
import {
  labelEntry,
  summarizeLibrary,
  summarizeProposed,
  type SkillLibraryView,
} from "../src/lib/skillLibrary.js";

function view(overrides: Partial<SkillLibraryView> = {}): SkillLibraryView {
  return { library: [], proposed: [], libraryDir: "skills", ...overrides };
}

/**
 * **읽지 못한 항목을 목록에서 지우지 않는다.** 지우면 사용자는 자기 파일이 왜 안 보이는지
 * 모른다 — "없다"와 "읽지 못했다"는 다른 사실이다.
 */
test("깨진 항목은 사유와 함께 남고 고를 수 없다", () => {
  const label = labelEntry({ file: "bad.json", problem: "JSON이 아닙니다" });
  assert.equal(label.usable, false);
  assert.ok(label.text.startsWith("bad.json"), label.text);
  assert.ok(label.text.includes("JSON이 아닙니다"), label.text);
});

test("정상 항목은 요약을 보여주고 고를 수 있다", () => {
  const label = labelEntry({ file: "a.json", name: "리뷰어", summary: "리뷰어 — 지시문 10자" });
  assert.equal(label.usable, true);
  assert.equal(label.text, "리뷰어 — 지시문 10자");
});

/** **두 수를 따로 센다** — 합치면 "5개 있음"이 거짓이 된다. */
test("고를 수 있는 개수와 읽지 못한 개수를 따로 센다", () => {
  const summary = summarizeLibrary(
    view({
      library: [
        { file: "a.json", name: "A", summary: "A" },
        { file: "b.json", name: "B", summary: "B" },
        { file: "c.json", problem: "깨짐" },
      ],
    })
  );
  assert.equal(summary.usable, 2);
  assert.equal(summary.broken, 1);
  assert.ok(summary.headline.includes("2개"), summary.headline);
  assert.ok(summary.headline.includes("1개"), summary.headline);
});

/** 비어 있을 때 "0개"라고 쓰면 있었는데 사라진 것처럼 읽힌다 — 어디에 두는지를 말한다. */
test("보관함이 비면 개수가 아니라 어디에 두는지를 말한다", () => {
  const summary = summarizeLibrary(view());
  assert.ok(!summary.headline.includes("0개"), summary.headline);
  assert.ok(summary.headline.includes("skills"), summary.headline);
});

/** 제안이 없으면 그 영역 자체를 그리지 않는다. */
test("저장소의 제안이 없으면 영역을 그리지 않는다", () => {
  assert.equal(summarizeProposed(view()).show, false);
  assert.equal(summarizeProposed(null).show, false);
});

/**
 * **"등록되었습니다"가 아니다.** 저장소는 제안했을 뿐이고, 보관함에 들어가는 것은 사용자가
 * 가져오기를 누를 때다.
 */
test("제안 문장이 가져와야 들어간다고 말한다", () => {
  const summary = summarizeProposed(view({ proposed: [{ file: "team.json", name: "팀", summary: "팀" }] }));
  assert.equal(summary.show, true);
  assert.ok(summary.headline.includes("가져와야"), summary.headline);
  assert.equal(summary.importable.length, 1);
});

/**
 * 이미 보관함에 있는 이름은 가져오기를 권하지 않는다 — 덮어쓰지 않으므로 눌러도 거절되고,
 * 누를 이유 없는 버튼은 사용자를 헷갈리게 한다.
 */
test("이미 보관함에 있는 제안은 가져오기 대상이 아니다", () => {
  const summary = summarizeProposed(
    view({
      library: [{ file: "team.json", name: "내 것", summary: "내 것" }],
      proposed: [{ file: "team.json", name: "팀", summary: "팀" }],
    })
  );
  assert.equal(summary.show, true, "이미 있어도 제안 자체는 보여준다");
  assert.deepEqual(summary.importable, []);
});

/** 깨진 제안은 가져오기 대상이 아니다 — 보관함에 문제 항목을 늘릴 뿐이다. */
test("깨진 제안은 가져오기 대상이 아니다", () => {
  const summary = summarizeProposed(view({ proposed: [{ file: "bad.json", problem: "깨짐" }] }));
  assert.equal(summary.show, true);
  assert.deepEqual(summary.importable, []);
});
