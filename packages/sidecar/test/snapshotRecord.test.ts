import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEVANT_FILE_FIELDS_NOT_RECORDED,
  SNAPSHOT_FIELDS_NOT_RECORDED,
  snapshotPayload,
} from "../src/orchestrator/snapshotPayload.js";
import { makeSnapshot } from "./helpers/fixtures.js";

/**
 * **스냅샷에만 있고 이벤트에 없는 값은 없는 것과 같다** — state-machine 68절.
 *
 * 이 저장소는 같은 결함을 네 번 찾았다.
 *
 * | 어디 | 무엇 |
 * |---|---|
 * | 16.1절 | Rust가 `skippedSecretFiles`를 내는데 Node가 읽지 않았다 |
 * | 18.1절 | Rust가 `truncated`를 내는데 브리지가 버렸다 |
 * | 61절 | `anchorCoverage`가 스냅샷에만 있고 이벤트에 없었다 |
 * | 67절 | 검증 다이제스트가 프롬프트로만 가고 이벤트를 지나지 않았다 |
 *
 * 앞의 둘에는 18.3절이 장치를 만들었다(`UNREAD_TOOL_FACTS`). 뒤의 둘은 **반대 방향**이고
 * 장치가 없었다 — 둘 다 사람이 우연히 발견했다.
 *
 * # 판정 기준은 타입이 아니라 **실행 결과**다
 *
 * 필드 이름은 프로토콜 소스에서 유도하고, 실린 키는 함수를 **돌려서** 본다. 타입 선언을
 * 파싱하면 "타입에 있는데 채우지 않는 코드"를 통과시킨다 — 그게 정확히 61절의 결함이었다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_TS = path.resolve(
  // **`__dirname`은 실행 시점에 `dist/test`다.** 소스 기준으로 세면 없는 경로가 나온다.
  __dirname,
  "..",
  "..",
  "..",
  "protocol",
  "src",
  "snapshot.ts"
);

/** 프로토콜의 인터페이스 하나에서 필드 이름을 유도한다. */
function fieldsOf(name: string): string[] {
  const source = readFileSync(SNAPSHOT_TS, "utf8");
  const marker = `export interface ${name} {`;
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${name} 정의를 찾지 못했습니다`);
  const body = source.slice(at + marker.length, source.indexOf("\n}", at));
  // 주석 줄과 중첩 블록을 세지 않으려고 **줄 맨 앞 두 칸 들여쓰기**만 본다.
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1] as string);
}

/** 모든 선택 필드를 채운 스냅샷 — **빠진 키가 "안 실었다"로 보이지 않게** 한다. */
function fullSnapshot() {
  return makeSnapshot({
    gitDiffSummary: " src/a.ts | 1 +",
    skill: { name: "s", instructions: "i" },
    sessionMemory: { text: "t", decisionCount: 1, truncated: false },
    mcpTools: { text: "t", serverCount: 1, toolCount: 1, truncated: false },
    mcpResults: { text: "r", callCount: 1 },
    excludedNotes: [{ path: ".env", reason: "비밀값" }],
    coverageNotes: [{ kind: "listing_truncated", scope: "파일 목록", reason: "잘림" }],
    relevantFiles: [
      {
        path: "src/a.ts",
        reason: "content-match",
        reasonDetail: "본문에서 찾음",
        content: "const a = 1;\n",
        truncated: true,
        sizeBytes: 12,
        includedBytes: 12,
        anchorLines: [1],
        includedRange: { startLine: 1, endLine: 1, totalLines: 3 },
        anchorCoverage: { covered: 1, total: 2 },
      },
    ],
  });
}

test("스냅샷의 필드와 결정 목록을 소스에서 읽을 수 있다", () => {
  // 0개면 아래 비교가 빈 집합에 대해 통과한다 — 형식이 바뀐 경우다.
  assert.ok(fieldsOf("WorkspaceSnapshot").length >= 10, fieldsOf("WorkspaceSnapshot").join(", "));
  assert.ok(fieldsOf("RelevantFile").length >= 8, fieldsOf("RelevantFile").join(", "));
});

test("스냅샷의 모든 필드가 실리거나, 안 싣는 이유가 적혀 있다", () => {
  const recorded = new Set(Object.keys(snapshotPayload(fullSnapshot())));
  const declared = new Set(Object.keys(SNAPSHOT_FIELDS_NOT_RECORDED));

  const undecided = fieldsOf("WorkspaceSnapshot").filter((f) => !recorded.has(f) && !declared.has(f));
  assert.deepEqual(
    undecided,
    [],
    `스냅샷에 있는데 이벤트에 싣지도, 안 싣는다고 적지도 않은 필드가 있습니다: ${undecided.join(", ")}. ` +
      `스냅샷에만 있고 이벤트에 없는 값은 **없는 것과 같습니다** — 61·67절이 그 자리를 두 번 밟았습니다.`
  );

  // 반대 방향: 목록이 낡으면 "안 싣기로 했다"가 계속 남는다.
  const known = new Set(fieldsOf("WorkspaceSnapshot"));
  const stale = [...declared].filter((f) => !known.has(f));
  assert.deepEqual(stale, [], `스냅샷에 없는 필드가 결정 목록에 남아 있습니다: ${stale.join(", ")}`);

  // 그리고 **둘 다에 있으면 안 된다** — 싣기로 했으면서 안 싣는다고 적을 수는 없다.
  const both = [...declared].filter((f) => recorded.has(f));
  assert.deepEqual(both, [], `싣고 있는데 안 싣는다고 적혀 있습니다: ${both.join(", ")}`);
});

test("선정된 파일의 모든 필드가 실리거나, 안 싣는 이유가 적혀 있다", () => {
  const files = snapshotPayload(fullSnapshot()).relevantFiles as Record<string, unknown>[];
  assert.equal(files.length, 1, "fixture가 파일을 싣지 않았습니다 — 아래 비교가 공허합니다");
  const recorded = new Set(Object.keys(files[0]!));
  const declared = new Set(Object.keys(RELEVANT_FILE_FIELDS_NOT_RECORDED));

  const undecided = fieldsOf("RelevantFile").filter((f) => !recorded.has(f) && !declared.has(f));
  assert.deepEqual(
    undecided,
    [],
    `선정된 파일에 있는데 이벤트에 싣지도, 안 싣는다고 적지도 않은 필드가 있습니다: ${undecided.join(", ")}`
  );

  const known = new Set(fieldsOf("RelevantFile"));
  const stale = [...declared].filter((f) => !known.has(f));
  assert.deepEqual(stale, [], `없는 필드가 결정 목록에 남아 있습니다: ${stale.join(", ")}`);
});

/**
 * **본문은 절대 싣지 않는다.**
 *
 * 이벤트는 화면과 감사 export로 흐른다. 본문을 실으면 파일 내용이 그 경로들로 복제되고,
 * 이미 artifact에 있는 것을 한 벌 더 두는 것이다 — 그리고 그 복제본은 `.env` 같은 파일이
 * 컨텍스트에 들어온 적이 없다는 보장과 **다른 층에서** 새 유출 경로가 된다.
 *
 * 위 검사는 "결정이 적혀 있는가"만 본다. 이 검사는 그 결정이 **지켜지는가**를 본다.
 */
test("파일 본문은 이벤트에 실리지 않는다", () => {
  const marker = "SNAPSHOT_CONTENT_MUST_NOT_LEAK";
  const snapshot = fullSnapshot();
  snapshot.relevantFiles[0]!.content = `const a = "${marker}";\n`;
  const serialized = JSON.stringify(snapshotPayload(snapshot));
  assert.ok(!serialized.includes(marker), `이벤트 payload에 파일 본문이 들어갔습니다: ${serialized.slice(0, 200)}`);
});
