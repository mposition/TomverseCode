import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 손으로 적은 상태 주장이 낡는 것을 막는다 — product-strategy.md 3.1절.
 *
 * 대상은 셋이다: 전략 문서의 **자기 진단 표**(3절), **출시 기준 표의 상태 행**(8.2절), 그리고
 * **README의 "지금 동작하는 것" / "아직 없는 것"**. 셋 다 같은 마커 규칙과 같은 리더를 쓴다.
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
 * # README가 뒤늦게 들어온 이유
 *
 * 이 검사는 오래 **두 표만** 지켰고, README는 밖에 있었다. 그래서 예언대로 낡았다 —
 * 2026-07-27 이후 손대지 않은 채 M1·M2·M3와 가설 게이트 판정을 전부 지나쳤고, 첫 사용자가
 * 가장 먼저 읽는 문서가 "Tool Runtime(9개 도구)"·"Tree-sitter 없음"·"교차검증은 아직 측정 중"을
 * 말하고 있었다. **검사 밖에 있는 문서는 검사가 있는 문서보다 빨리 낡는 것이 아니라, 낡은
 * 사실이 드러나지 않는다** — 이 저장소가 루트 `test`에서 빠진 워크스페이스로 이미 배운 모양이다.
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
 * 일어나는 낡는 방식(**만들어 놓고 문서를 안 고침**)을 자동으로 막는 것이다.
 *
 * README에는 한 가지가 더 있다. **"만들어졌다"와 "Windows 실기에서 확인됐다"는 다른 사실인데,
 * 뒤의 것은 파일 존재로 판정되지 않는다** — 사람의 확인은 `docs/design/attestations/`의 기록으로
 * 들어가고 그 파일 이름에는 커밋 해시가 붙는다(커밋이 바뀌면 만료되기 때문이다). 그래서
 * 착지 항목의 마커는 "확인됐다"가 아니라 **"판정을 적는 자리가 있다"**만 지킨다. 그 자리를
 * 지우면 이 검사가 실패하고, 확인이 끝났는데 README를 안 고친 것은 여전히 사람이 잡아야 한다.
 *
 * 그리고 **항목을 통째로 지운 것**도 못 잡는다(최소 개수 아래로 내려가기 전까지는). 8.2절 표는
 * 기능 행이 재고 목록이라 "상태 행 없는 기능 행"을 잡을 수 있지만, README에는 무엇이 실려 있어야
 * 하는지 말해주는 목록이 없다 — 그 재고는 8.2절 표이고, 그쪽은 이미 이 파일이 지킨다. 실측으로
 * 확인한 것: 있는 파일을 `absent:`로, 없는 파일을 `present:`로, 마커를 지우고, 절 이름을 바꾸면
 * **넷 다 실패한다.** 항목 하나를 지우는 것만 통과했고, 그것이 이 검사의 경계다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DOC = path.join(REPO_ROOT, "docs", "design", "product-strategy.md");
const README = path.join(REPO_ROOT, "README.md");

interface StatusRow {
  label: string;
  /** 상태를 적은 칸의 원문. 부정 주장을 여기서 찾는다(아래 `NEGATIVE_CLAIMS`). */
  status: string;
  present: string[];
  absent: string[];
}

/**
 * **판정어의 닫힌 집합** — product-strategy 8.2절, state-machine 56절.
 *
 * 상태 칸의 **첫 굵은 글씨**가 그 행의 판정이다(`**부분**(M3) — …`). 나머지는 산문이다.
 *
 * # 왜 산문을 보지 않는가 — 실측
 *
 * 처음에는 산문에서 부정 어휘("없다", "미확인" 등)를 찾았다. **일곱 행이 걸렸고 그중 다섯이
 * 오탐이었다** — "우리는 GitHub에 요청을 보내지 않는다", "정책으로 낮출 수 없다"처럼 완료된
 * 기능을 설명하는 문장에 같은 단어가 들어 있기 때문이다. 검사가 없는 결함을 보고하면 사람은
 * 검사를 고치는 대신 **검사를 약하게 만든다**(53.7절에서 같은 것을 배웠다).
 *
 * 판정어는 산문이 아니라 **값**이다. 닫힌 집합으로 두면 새 판정어를 쓸 때 여기서 막히고,
 * 막히는 자리에서 "이건 긍정인가 부정인가"를 정하게 된다.
 *
 * # 이 검사가 못 잡는 것
 *
 * 판정은 긍정인데 **산문 안에 부정 주장이 있는 경우**는 못 잡는다(Google 행의 "실측
 * 미확인"이 그렇다). 그건 문장을 읽어야 아는 일이고, 이 파일 위쪽 주석이 이미 같은 한계를
 * 적어 두었다 — 목적은 판정을 대신하는 것이 아니라 가장 자주 일어나는 낡는 방식을 막는 것이다.
 */
const KNOWN_VERDICTS = ["구현 완료", "충족", "부분", "미착수", "코어 구현 완료, UI 미배선"];

/**
 * 이 판정어들은 **만들면 낡는다.** 반증할 파일을 함께 적어야 한다.
 *
 * `코어 구현 완료, UI 미배선`은 절반이 긍정이지만 **여기 들어간다.** 이 검사가 생긴 계기가
 * 바로 그 문구였다 — 세 행이 "UI 미배선"이라고 적혀 있었고 셋 다 화면이 붙어 있었다.
 * 긍정 절반 때문에 부정 절반이 검사를 빠져나가면 같은 드리프트가 그대로 돌아온다.
 */
const NEGATIVE_VERDICTS = ["부분", "미착수", "코어 구현 완료, UI 미배선"];

/**
 * 마커를 뽑는다. **`|`로 시작하고 `§`가 붙은 행만** 본다 — 같은 문서의 산문에도 마커 형식이
 * 예시로 적혀 있으므로, 파일 전체에서 찾으면 설명문을 검사 대상으로 세게 된다.
 */
function readStatusRows(): StatusRow[] {
  return readRows("| \u00a7");
}

function readRows(prefix: string, file: string = DOC): StatusRow[] {
  const source = readFileSync(file, "utf8");
  const rows: StatusRow[] = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const label = line.slice(1).split("|")[0]!.trim();
    rows.push({
      label,
      status: statusCellOf(line),
      present: markerPaths(line, "present"),
      absent: markerPaths(line, "absent"),
    });
  }
  return rows;
}

/**
 * 8.2절 **출시 기준 표**의 상태 행들 — state-machine 56·66절.
 *
 * # 왜 이 표도 검사하는가
 *
 * 3.1절 표와 목적이 같다. 8.2절은 "무엇까지 하면 출시 기준을 만족하는가"를 정하는 표이고,
 * 그 아래 `↳` 행이 **지금 어디까지 왔는가**를 적는다. 그 행이 낡으면 3.1절이 낡을 때와 같은
 * 대가를 치른다 — 있는 것을 없다고 읽고 다시 만들거나, 없는 것을 있다고 읽고 출시 기준을
 * 충족했다고 믿는다. 실제로 그렇게 낡았다: 세 행이 "UI 미배선"이라고 적혀 있었는데 셋 다
 * 화면이 붙어 있었다.
 *
 * # 왜 `readStatusRows`와 합치지 않는가
 *
 * 행 머리 판정이 다르다(`§` vs `↳`). 합치면 "둘 중 하나로 시작하면"이 되고, 그러면 **어느
 * 표를 몇 행 읽었는지** 알 수 없다 — 표 하나가 통째로 사라져도 다른 쪽 행 수로 최소 개수를
 * 넘길 수 있다.
 *
 * # 왜 `↳`만이 아니라 행 이름까지 보는가
 *
 * 병합에서 이 함수가 **두 벌로 갈라져 있는 것이 드러났다**(`↳`만 보는 것과 행 이름까지 보는
 * 것). 지금은 문서의 상태 행 열아홉 개가 전부 같은 이름을 쓰므로 둘이 같은 집합을 읽는데,
 * 두 벌로 두면 한쪽만 고쳐지고 그 갈라짐은 **양쪽 다 통과하므로 드러나지 않는다.**
 */
function readReleaseRows(): StatusRow[] {
  return readRows("|" + " \u21b3 위 행의 현재 상태");
}

/** 표 행의 **두 번째 칸**(상태 원문). 마커는 주석이므로 그대로 남지만 판정에 영향이 없다. */
function statusCellOf(line: string): string {
  const cells = line.slice(1).split("|");
  return (cells[1] ?? "").trim();
}

/**
 * 상태 칸의 **첫 굵은 글씨** = 그 행의 판정. 없으면 `null`.
 *
 * 굵은 글씨가 아예 없는 행이 있을 수 있고(Google 행이 그렇다 — 판정이 문장 중간에 있다),
 * 그 경우 `null`을 주고 아래 검사가 그 사실을 따로 다룬다. 첫 굵은 글씨를 **판정이 아닌
 * 것으로 채우면** 이 검사가 조용히 빗나가므로, 알 수 없는 값은 실패로 만든다.
 */
function verdictOf(status: string): string | null {
  const mark = "*" + "*";
  const open = status.indexOf(mark);
  if (open !== 0) return null;
  const close = status.indexOf(mark, open + mark.length);
  if (close === -1) return null;
  return status.slice(open + mark.length, close).trim();
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

/**
 * README의 **항목 목록**을 같은 `StatusRow`로 읽는다.
 *
 * # 왜 표가 아니라 목록인가
 *
 * README는 사람이 읽는 문서라 상태를 표로 쓰지 않는다. 그래서 행 대신 **글머리 항목**을 읽되,
 * 나머지는 두 표와 **같은 규칙·같은 마커 추출기**를 쓴다. 리더를 두 벌로 두면 갈라지고, 그
 * 갈라짐은 **양쪽 다 통과하므로 드러나지 않는다** — 이 파일이 방금 그것을 겪었다(`readReleaseRows`
 * 주석).
 *
 * # 왜 소제목으로 구간을 자르는가
 *
 * README 전체에서 `- `로 시작하는 줄을 세면 설계 원칙·제외 항목처럼 **상태 주장이 아닌 목록**이
 * 함께 걸린다. 그것들에 마커를 요구하면 검사가 없는 결함을 보고하게 되고, 그러면 사람은 검사를
 * 고치는 대신 **검사를 약하게 만든다.** 그래서 상태를 주장하는 두 절만 이름으로 집어 든다.
 *
 * 항목은 여러 줄로 이어질 수 있으므로(마커는 보통 마지막 줄에 있다) 다음 항목이나 구간 끝까지를
 * **한 덩어리**로 모아 하나의 행으로 만든다.
 */
function readReadmeRows(heading: string): StatusRow[] {
  const lines = readFileSync(README, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  assert.notEqual(start, -1, `README에서 "${heading}" 절을 찾지 못했습니다`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("#"));
  // 구간이 파일 끝까지 이어지면 다음 소제목이 없다 — 그건 형식이 바뀐 것이므로 실패로 만든다.
  assert.notEqual(end, -1, `"${heading}" 다음 소제목을 찾지 못했습니다`);

  const rows: StatusRow[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length === 0) return;
    const text = block.join(" ");
    rows.push({
      label: labelOf(block[0]!),
      status: text,
      present: markerPaths(text, "present"),
      absent: markerPaths(text, "absent"),
    });
    block = [];
  };
  for (const line of rest.slice(0, end)) {
    if (line.startsWith("- ")) flush();
    if (line.startsWith("- ") || block.length > 0) block.push(line.trim());
  }
  flush();
  return rows;
}

/** 항목의 첫 줄에서 사람이 알아볼 이름만 — 실패 메시지가 어느 항목인지 말해야 한다. */
function labelOf(first: string): string {
  const mark = "*" + "*";
  const open = first.indexOf(mark);
  if (open !== -1) {
    const close = first.indexOf(mark, open + mark.length);
    if (close !== -1) return first.slice(open + mark.length, close).trim();
  }
  return first.slice(0, 40).trim();
}

/**
 * **근거 없이 상태만 적는 항목은 실패다** — 세 대상이 공유하는 규칙.
 *
 * 마커가 없는 항목은 처음부터 이 검사의 시야 밖에 있고, **보이지 않는 항목은 실패하지 않으므로
 * 빠진 사실도 드러나지 않는다.**
 */
function assertEveryRowHasEvidence(rows: StatusRow[], what: string, least: number): void {
  // 0행인데 통과하는 것을 막는다 — 제목이나 형식이 바뀌면 아래 for가 빈 집합을 돈다.
  assert.ok(rows.length >= least, `${what}을 ${rows.length}개만 읽었습니다. 형식이 바뀌었습니까?`);
  for (const row of rows) {
    assert.ok(
      row.present.length + row.absent.length > 0,
      `${what}에 반증할 파일이 없는 항목이 있습니다: "${row.label}". ` +
        `근거 없이 상태만 적는 항목은 처음부터 검사 밖에 있습니다`
    );
  }
}

/** **있다고 적은 것은 있고, 없다고 적은 것은 없다** — 세 대상이 공유하는 규칙. */
function assertMarkersMatchDisk(rows: StatusRow[], what: string): void {
  for (const row of rows) {
    for (const rel of row.present) {
      assert.ok(
        existsSync(path.join(REPO_ROOT, rel)),
        `${what}: "${row.label}"이 있다고 적었는데 ${rel}가 없습니다. 옮겼거나 지웠다면 문서를 함께 고칠 것`
      );
    }
    for (const rel of row.absent) {
      assert.ok(
        !existsSync(path.join(REPO_ROOT, rel)),
        `${what}: "${row.label}"을 없다고 적었는데 ${rel}가 생겼습니다. 만들었으면 문서를 고칠 것 — ` +
          `문서가 낡는 방식 중 가장 비싼 것이 "있는 것을 없다고 말하는" 쪽입니다`
      );
    }
  }
}

test("자기 진단 표의 모든 행이 반증할 파일을 함께 적는다", () => {
  assertEveryRowHasEvidence(readStatusRows(), "자기 진단 표(3절)의 행", 5);
});

test("있다고 적은 것은 실제로 있고, 없다고 적은 것은 실제로 없다", () => {
  assertMarkersMatchDisk(readStatusRows(), "자기 진단 표(3절)");
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

// ---- 출시 기준 표 (8.2절) — state-machine 56절 ----

/**
 * **모든 기능 행에 상태 행이 있는가** — state-machine 66절.
 *
 * 56절이 만든 검사들은 전부 **상태 행**을 읽는다. 그래서 상태 행이 **아예 없는 기능 행**은
 * 처음부터 그 검사들의 시야 밖이었다 — 그리고 실제로 다섯 개가 그랬다(세션 취소, git 도구,
 * 프로젝트 규칙, Fleet, 승인·경계·secret). 넷은 구현돼 있었는데 표가 말하지 않았고, 하나는
 * 미착수인데 그 사실도 없었다.
 *
 * **빠진 행은 실패하지 않으므로 빠진 사실이 드러나지 않는다.** 이 저장소가 이미 두 번 밟은
 * 모양이다(루트 `test`에서 빠진 워크스페이스, 탐침이 없는 도구).
 *
 * 표는 "최대한의 정지 조건"이라고 적혀 있다. 상태가 없는 행이 있으면 그 표를 **재고 목록으로
 * 읽을 수 없고**, 읽을 수 없는 정지 조건은 정지 조건이 아니다.
 */
function releaseTableLines(): string[] {
  const source = readFileSync(DOC, "utf8").split("\n");
  const head = "|" + " 영역 | 출시 기준";
  const start = source.findIndex((l) => l.startsWith(head));
  assert.notEqual(start, -1, "출시 기준 표의 머리글을 찾지 못했습니다");
  // **다음 소제목에서 끊는다.** 8.3절에도 표가 있고 거기 행들은 상태 행을 갖지 않는다 —
  // 제외 항목이라 "현재 상태"라는 개념이 없다.
  const rest = source.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("###"));
  assert.notEqual(end, -1, "출시 기준 표 다음 소제목을 찾지 못했습니다");
  return rest.slice(0, end);
}

test("출시 기준 표의 모든 기능 행에 상태 행이 있다", () => {
  const lines = releaseTableLines();
  const feature = "|" + " **";
  const status = "|" + " ↳ 위 행의 현재 상태";

  const missing: string[] = [];
  let pending: string | null = null;
  let features = 0;
  for (const line of lines) {
    if (line.startsWith(status)) {
      // 기능 행 없이 상태 행이 오면 그 상태는 무엇에 대한 것인지 알 수 없다.
      assert.notEqual(pending, undefined);
      assert.ok(pending !== null, `기능 행 없이 상태 행이 있습니다: ${line.slice(0, 60)}`);
      pending = null;
      continue;
    }
    if (!line.startsWith(feature)) continue;
    if (pending) missing.push(pending);
    pending = line.slice(1).split("|")[0]!.trim();
    features += 1;
  }
  if (pending) missing.push(pending);

  // 0개면 아래 비교가 빈 집합에 대해 통과한다 — 표 형식이 바뀐 경우다.
  assert.ok(features >= 15, `기능 행을 ${features}개만 읽었습니다`);
  assert.deepEqual(
    missing,
    [],
    `상태 행이 없는 기능 행이 있습니다: ${missing.join(", ")}. ` +
      `상태 행이 없으면 56절의 검사들이 그 행을 **보지 못하고**, 보이지 않는 행은 실패하지 ` +
      `않으므로 빠진 사실도 드러나지 않습니다.`
  );
});

test("출시 기준 표의 상태 행도 반증할 파일을 적는다", () => {
  assertEveryRowHasEvidence(readReleaseRows(), "출시 기준 표(8.2절)의 상태 행", 10);
});

test("출시 기준 표도 있다/없다가 실제와 같다", () => {
  assertMarkersMatchDisk(readReleaseRows(), "출시 기준 표(8.2절)");
});

/**
 * **부정 판정에는 반증할 파일이 붙어야 한다** — state-machine 56절.
 *
 * 이 검사가 없는 동안 8.2절 표의 세 행이 "UI 미배선"이라고 말했고 셋 다 화면이 붙어 있었다.
 * `present:` 마커는 그 드리프트를 잡지 못한다 — 그 마커가 가리키는 것은 **코어 파일**이고,
 * 코어는 UI가 생기든 말든 그대로 있기 때문이다.
 *
 * 부정 판정은 **만들면 낡는다.** 그래서 "무엇이 생기면 이 판정이 거짓이 되는가"를 함께
 * 적게 한다. 그 파일이 생기는 순간 위 검사가 실패한다.
 */
test("부분·미착수 행은 무엇이 생기면 거짓이 되는지 함께 적는다", () => {
  const rows = readReleaseRows();
  const negative = rows.filter((row) => {
    const verdict = verdictOf(row.status);
    return verdict !== null && NEGATIVE_VERDICTS.includes(verdict);
  });
  // **빈 집합에 대한 전칭 명제는 언제나 참이다.** 하나도 안 걸리면 이 검사는 공허하다.
  assert.ok(negative.length > 0, "부정 판정 행을 하나도 찾지 못했습니다 — 판정어가 문서와 갈라졌습니까?");

  for (const row of negative) {
    assert.ok(
      row.absent.length > 0,
      `"${verdictOf(row.status)}" 행에 반증할 파일이 없습니다: "${row.status.slice(0, 60)}…". ` +
        `부정 판정은 만들면 조용히 낡습니다 — 무엇이 생기면 이 판정이 거짓이 되는지 적을 것`
    );
  }
});

/**
 * **판정어는 닫힌 집합이다.** 새 판정어를 쓰면 여기서 막히고, 막히는 자리에서
 * "이건 긍정인가 부정인가"를 정하게 된다 — 정하지 않으면 위 검사가 그 행을 그냥 지나친다.
 */
test("모르는 판정어를 쓰면 막힌다", () => {
  const rows = readReleaseRows();
  const unknown = rows
    .map((row) => ({ row, verdict: verdictOf(row.status) }))
    .filter(({ verdict }) => verdict !== null && !KNOWN_VERDICTS.includes(verdict));
  assert.deepEqual(
    unknown.map(({ verdict }) => verdict),
    [],
    `모르는 판정어가 있습니다. 긍정인지 부정인지 정하고 KNOWN_VERDICTS에 넣을 것 — ` +
      `분류되지 않은 판정어는 "부정 판정에 반증할 파일" 검사를 조용히 지나칩니다`
  );

  // 그리고 **판정어를 실제로 읽고 있다는 것.** 전부 null이면 위 비교가 빈 집합끼리다.
  assert.ok(
    rows.filter((row) => verdictOf(row.status) !== null).length >= 5,
    "판정어를 읽은 행이 너무 적습니다 — 형식이 바뀌었습니까?"
  );
});

/** 판정어 추출이 두 답을 낼 수 있는지 — 언제나 null이면 위 검사들이 공허하다. */
test("판정어 추출이 실제로 값을 가른다", () => {
  const mark = "*" + "*";
  assert.equal(verdictOf(`${mark}부분${mark}(M3) — 어쩌고`), "부분");
  assert.equal(verdictOf("3사 어댑터 " + mark + "구현 완료" + mark), null);
  assert.equal(verdictOf("굵은 글씨가 없는 행"), null);
});

// ---- README — 첫 사용자가 가장 먼저 읽는 문서 ----

/**
 * README의 두 절 이름. **여기서만 적는다** — 절 이름이 바뀌면 리더가 못 찾고 실패하므로,
 * 문서와 검사가 조용히 갈라지지 않는다.
 */
const README_WORKS = "### 지금 동작하는 것";
const README_MISSING = "### 아직 없는 것";

test("README의 상태 항목이 전부 반증할 파일을 함께 적는다", () => {
  assertEveryRowHasEvidence(readReadmeRows(README_WORKS), `README "${README_WORKS}"의 항목`, 8);
  assertEveryRowHasEvidence(readReadmeRows(README_MISSING), `README "${README_MISSING}"의 항목`, 4);
});

test("README가 있다고 적은 것은 있고, 없다고 적은 것은 없다", () => {
  assertMarkersMatchDisk(readReadmeRows(README_WORKS), `README "${README_WORKS}"`);
  assertMarkersMatchDisk(readReadmeRows(README_MISSING), `README "${README_MISSING}"`);
});

/**
 * **두 방향이 README에서도 실제로 돌고 있는가.**
 *
 * "아직 없는 것" 절이 `present:`만 갖게 되면 위 검사는 절반만 도는데, 그 사실이 어디에도
 * 나타나지 않는다 — 두 표에 대해 이미 같은 것을 지키고 있다. `absent:`가 하나도 없다는 것은
 * 보통 "없다고 적은 것을 만들고 README에서 지웠다"가 아니라 **근거를 무른 쪽으로 바꿨다**는
 * 뜻이다.
 */
test("README도 두 방향 모두 실제로 검사되고 있다", () => {
  const works = readReadmeRows(README_WORKS);
  const missing = readReadmeRows(README_MISSING);
  assert.ok(
    works.every((r) => r.present.length > 0),
    `"${README_WORKS}"의 항목은 있다는 주장이므로 present 마커가 있어야 합니다`
  );
  assert.ok(
    missing.some((r) => r.absent.length > 0),
    `"${README_MISSING}"에 absent 마커가 하나도 없습니다 — 없다는 주장을 무엇이 반증합니까?`
  );
});

/**
 * **리더가 실제로 항목을 가르는가.**
 *
 * 여러 줄 항목을 한 덩어리로 모으는 부분이 고장 나면 증상이 조용하다 — 전부 한 행이 되거나
 * 각 줄이 따로 행이 되고, 어느 쪽이든 위 검사들은 그럴듯한 개수를 세며 통과할 수 있다.
 * 그래서 **덩어리 하나가 마커를 실제로 물고 있는지**와 **덩어리 수가 글머리 수와 같은지**를
 * 따로 확인한다.
 */
test("README 리더가 항목 단위로 마커를 문다", () => {
  const rows = readReadmeRows(README_MISSING);
  const bullets = readFileSync(README, "utf8")
    .split("\n")
    .slice(1)
    .join("\n");
  const section = bullets.slice(bullets.indexOf(README_MISSING) + README_MISSING.length);
  const untilNextHeading = section.slice(0, section.indexOf("\n#"));
  const bulletCount = untilNextHeading.split("\n").filter((l) => l.startsWith("- ")).length;

  assert.equal(rows.length, bulletCount, "글머리 수와 읽은 항목 수가 다릅니다 — 덩어리 나누기가 틀렸습니까?");
  assert.ok(
    rows.every((r) => r.label.length > 0),
    "항목 이름을 하나도 읽지 못했습니다 — 실패 메시지가 어느 항목인지 말하지 못하게 됩니다"
  );
});
