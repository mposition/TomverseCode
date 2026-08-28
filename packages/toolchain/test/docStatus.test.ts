import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 전략 문서의 자기 진단 표가 낡는 것을 막는다 — product-strategy.md 3.1절.
 *
 * # 왜 이 검사가 필요한가
 *
 * 그 표의 목적은 **"새로 만들 것과 이미 있는 것을 구분해야 낭비가 없다"**이다. 그런데 손으로
 * 적은 상태는 코드가 앞서가면 조용히 낡고, 낡은 상태표는 자기 목적을 정면으로 배신한다 —
 * "미착수"를 읽고 이미 있는 것을 다시 만들게 된다.
 *
 * 실제로 네 행이 틀려 있었고 **전부 같은 방향으로** 틀렸다(있는 것을 없다고 말했다). 방향이
 * 한쪽으로 쏠린 이유는 분명하다: 만들면 코드가 늘고 표는 그대로 남는다.
 *
 * # 왜 toolchain에 두는가
 *
 * 이 검사는 어느 한 워크스페이스의 것이 아니라 **저장소 전체**에 대한 것이다(경로가 Rust와
 * TypeScript 양쪽을 가리킨다). 저장소 구조를 대조하는 검사가 이미 여기 있다
 * (`buildOrder.test.ts`가 루트 `package.json`과 워크스페이스 그래프를 대조한다).
 *
 * # 이 검사가 못 잡는 것
 *
 * 파일이 생기거나 사라진 것은 잡지만, **파일이 남아 있는데 그 안의 기능이 무의미해진 것**은
 * 못 잡는다. 그건 문장을 읽어야 아는 일이다. 목적은 판정을 대신하는 것이 아니라 가장 자주
 * 일어나는 낡는 방식을 자동으로 막는 것이다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DOC = path.join(REPO_ROOT, "docs", "design", "product-strategy.md");

interface StatusRow {
  label: string;
  present: string[];
  absent: string[];
}

/**
 * 마커를 뽑는다. **`|`로 시작하고 `§`가 붙은 행만** 본다 — 같은 문서의 산문에도 마커 형식이
 * 예시로 적혀 있으므로, 파일 전체에서 찾으면 설명문을 검사 대상으로 세게 된다.
 */
function readStatusRows(): StatusRow[] {
  return readRows("| \u00a7");
}

/**
 * 8.2절 기능 표의 **상태 줄**(`↳`).
 *
 * # 왜 이 표도 검사하는가
 *
 * 3.1절 표와 목적이 같다. 8.2절은 "무엇까지 하면 출시 기준을 만족하는가"를 정하는 표이고,
 * 그 아래 `↳` 줄이 **지금 어디까지 왔는가**를 적는다. 그 줄이 낡으면 3.1절이 낡을 때와 같은
 * 대가를 치른다 — 있는 것을 없다고 읽고 다시 만들거나, 없는 것을 있다고 읽고 출시 기준을
 * 충족했다고 믿는다.
 *
 * 그리고 8.2절의 상태 줄은 3.1절보다 더 자주 늘어난다(기능을 하나 닫을 때마다 한 줄).
 * 사람이 지키는 규칙으로 두면 언젠가 마커 없는 줄이 생기고, **마커가 없는 줄은 검사 밖에
 * 있으므로 그 사실이 드러나지 않는다.** 그래서 마커가 없는 것 자체를 실패로 본다.
 */
function readProgressRows(): StatusRow[] {
  return readRows("| \u21b3");
}

function readRows(prefix: string): StatusRow[] {
  const source = readFileSync(DOC, "utf8");
  const rows: StatusRow[] = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const label = line.slice(1).split("|")[0]!.trim();
    rows.push({ label, present: markerPaths(line, "present"), absent: markerPaths(line, "absent") });
  }
  return rows;
}

/** needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일 자체가 검사 대상처럼 보인다. */
function markerPaths(line: string, kind: "present" | "absent"): string[] {
  const open = `<!--${" "}${kind}:`;
  const at = line.indexOf(open);
  if (at === -1) return [];
  const rest = line.slice(at + open.length);
  const end = rest.indexOf("-->");
  assert.notEqual(end, -1, `마커가 닫히지 않았습니다: ${line}`);
  return rest
    .slice(0, end)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

test("자기 진단 표의 모든 행이 반증할 파일을 함께 적는다", () => {
  const rows = readStatusRows();
  // 표를 못 찾았는데 통과하는 것을 막는다 — 제목이 바뀌거나 형식이 달라지면 0행이 된다.
  assert.ok(rows.length >= 5, `상태표 행을 찾지 못했습니다 (${rows.length}행). 표 형식이 바뀌었습니까?`);
  for (const row of rows) {
    assert.ok(
      row.present.length + row.absent.length > 0,
      `"${row.label}" 행에 반증할 파일이 없습니다. 근거 없이 상태만 적는 행은 처음부터 검사 밖에 있습니다`
    );
  }
});

test("있다고 적은 것은 실제로 있고, 없다고 적은 것은 실제로 없다", () => {
  const rows = readStatusRows();
  for (const row of rows) {
    for (const rel of row.present) {
      assert.ok(
        existsSync(path.join(REPO_ROOT, rel)),
        `"${row.label}"이 있다고 적었는데 ${rel}가 없습니다. 옮겼거나 지웠다면 표를 함께 고칠 것`
      );
    }
    for (const rel of row.absent) {
      assert.ok(
        !existsSync(path.join(REPO_ROOT, rel)),
        `"${row.label}"을 미착수로 적었는데 ${rel}가 생겼습니다. 만들었으면 표를 고칠 것 — ` +
          `표가 낡는 방식 중 가장 비싼 것이 "있는 것을 없다고 말하는" 쪽입니다`
      );
    }
  }
});

test("두 방향 모두 실제로 검사되고 있다", () => {
  // 표가 present만 갖게 되면 위 테스트는 절반만 도는데, 그 사실이 어디에도 나타나지 않는다.
  const rows = readStatusRows();
  assert.ok(rows.some((r) => r.present.length > 0), "present 마커가 하나도 없습니다");
  assert.ok(rows.some((r) => r.absent.length > 0), "absent 마커가 하나도 없습니다");

  // 그리고 존재 검사 자체가 두 답을 낼 수 있다는 것 — 언제나 true를 주는 검사로 고장 나면
  // 위 두 테스트가 아무것도 확인하지 못한 채 통과한다.
  assert.equal(existsSync(path.join(REPO_ROOT, "package.json")), true);
  assert.equal(existsSync(path.join(REPO_ROOT, "package.json.nonexistent")), false);
});

test("8.2절 기능 표의 상태 줄도 반증할 파일을 함께 적는다", () => {
  const rows = readProgressRows();
  // 줄을 못 찾았는데 통과하는 것을 막는다 — 표 형식이 바뀌면 0행이 되고, 0행은 언제나 통과한다.
  assert.ok(rows.length >= 10, `8.2절 상태 줄을 찾지 못했습니다 (${rows.length}행). 표 형식이 바뀌었습니까?`);
  for (const row of rows) {
    assert.ok(
      row.present.length + row.absent.length > 0,
      `8.2절의 "${row.label}" 줄에 반증할 파일이 없습니다. 마커가 없는 줄은 처음부터 검사 밖에 있으므로, ` +
        `낡아도 그 사실이 드러나지 않습니다`
    );
  }
});

test("8.2절 상태 줄이 가리키는 파일이 실제로 있다", () => {
  for (const row of readProgressRows()) {
    for (const rel of row.present) {
      assert.ok(
        existsSync(path.join(REPO_ROOT, rel)),
        `8.2절 "${row.label}" 줄이 ${rel}를 가리키는데 그 파일이 없습니다. 옮겼거나 지웠다면 줄을 함께 고칠 것`
      );
    }
    for (const rel of row.absent) {
      assert.ok(
        !existsSync(path.join(REPO_ROOT, rel)),
        `8.2절 "${row.label}" 줄이 ${rel}를 없다고 적었는데 생겼습니다`
      );
    }
  }
});
