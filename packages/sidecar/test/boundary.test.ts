import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 신뢰 경계 불변식을 소스 코드 수준에서 강제한다.
 *
 * docs/design/process-architecture.md 7절이 주장하는 것: sidecar는 파일 시스템, 셸, SQLite에
 * **직접 접근하지 않는다.** 이 주장은 코드 리뷰 규율만으로 유지되지 않는다 — 언젠가 누군가
 * "여기서 파일 하나만 읽으면 되는데"라고 생각하는 순간 무너지고, 그때 아무 테스트도 실패하지 않는다.
 *
 * 그래서 문서의 주장을 실행 가능한 검사로 만든다. `test/`는 예외다 — 테스트 하네스는 Rust 쪽
 * 역할(픽스처 준비, 프로세스 spawn)을 대신하므로 이 규칙의 대상이 아니다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 컴파일 후 위치는 dist/test/ 이므로 소스 트리를 직접 본다 — 컴파일 결과가 아니라
// 사람이 쓰는 코드에 우회가 들어왔는지를 확인해야 한다.
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

/** sidecar가 가지면 신뢰 경계가 무너지는 능력들. */
const FORBIDDEN = [
  { pattern: /from\s+["']node:fs["']|require\(["']node:fs["']\)|from\s+["']fs["']/, why: "파일 시스템 직접 접근" },
  { pattern: /from\s+["']node:fs\/promises["']/, why: "파일 시스템 직접 접근" },
  {
    pattern: /from\s+["']node:child_process["']|require\(["']child_process["']\)/,
    why: "프로세스 직접 실행",
  },
  { pattern: /from\s+["']node:worker_threads["']/, why: "워커를 통한 우회" },
  { pattern: /\bexecSync\b|\bspawnSync\b|\bexecFile\b/, why: "프로세스 직접 실행" },
  { pattern: /from\s+["']better-sqlite3["']|from\s+["']node:sqlite["']/, why: "SQLite 직접 쓰기" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("sidecar 소스는 파일 시스템·셸·SQLite에 직접 접근하지 않는다", () => {
  const files = sourceFiles(SRC_ROOT);
  assert.ok(files.length > 5, `소스 파일을 찾지 못했습니다 (${SRC_ROOT})`);

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      // 주석은 건너뛴다 — 이 규칙을 설명하는 주석 자체가 위반으로 잡히면 안 된다.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          violations.push(`${path.relative(SRC_ROOT, file)}:${index + 1} — ${rule.why}\n    ${trimmed}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "신뢰 경계 위반: sidecar는 Rust에 ToolRequest를 보내야 하며 직접 실행할 수 없습니다.\n" +
      violations.join("\n")
  );
});

test("sidecar 소스는 API 키를 파일로 쓰지 않는다", () => {
  // process-architecture.md 2절: Node는 API 키를 디스크에 저장하지 않고 메모리에만 보관한다.
  // 파일 쓰기 능력 자체가 없으므로(위 테스트) 이건 이중 확인이지만, 키를 로그로 흘리는 경로는 별개다.
  const files = sourceFiles(SRC_ROOT);
  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      // 키 값을 로그로 내보내는 패턴
      if (/console\.(log|info|warn|error)/.test(line) && /apiKey|API_KEY/i.test(line)) {
        violations.push(`${path.relative(SRC_ROOT, file)}:${index + 1} — ${trimmed}`);
      }
      if (/stderr\.write|stdout\.write/.test(line) && /apiKey/i.test(line)) {
        violations.push(`${path.relative(SRC_ROOT, file)}:${index + 1} — ${trimmed}`);
      }
    }
  }
  assert.deepEqual(violations, [], `자격증명이 로그로 나갈 수 있습니다:\n${violations.join("\n")}`);
});

test("sidecar 소스는 stdout에 직접 쓰지 않는다", () => {
  // stdout은 NDJSON 프로토콜 전용이다(process-architecture.md 3절). 여기에 로그를 흘리면
  // Rust 쪽 파서가 깨지고, 그건 디버깅하기 아주 어려운 형태로 나타난다.
  // 로그는 stderr로 보낸다.
  const files = sourceFiles(SRC_ROOT);
  const violations: string[] = [];
  for (const file of files) {
    // transport가 프로토콜 메시지를 쓰는 것은 정당하다 — 그게 그 모듈의 일이다.
    if (file.endsWith(path.join("ipc", "transport.ts"))) continue;
    const content = readFileSync(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (/console\.log|process\.stdout\.write/.test(line)) {
        violations.push(`${path.relative(SRC_ROOT, file)}:${index + 1} — ${trimmed}`);
      }
    }
  }
  assert.deepEqual(violations, [], `stdout은 NDJSON 전용입니다. stderr를 쓰세요:\n${violations.join("\n")}`);
});
