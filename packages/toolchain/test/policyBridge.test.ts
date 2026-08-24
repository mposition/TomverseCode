import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `TaskPolicy`가 신뢰 경계를 넘는 다리를 지킨다 —
 * [state-machine 24.3절](../../../docs/design/state-machine-and-protocol.md).
 *
 * # 왜 이 검사가 필요한가
 *
 * `TaskPolicy`는 Rust 구조체와 TS 인터페이스 양쪽에 있고, 헤드리스 호스트가 sidecar로 보내는
 * policy JSON은 **Rust 구조체를 직렬화한 것이 아니라 손으로 조립한 map**이다. 그래서 세 곳이
 * 조용히 갈라질 수 있다.
 *
 * 실제로 갈라졌다. `unattended`를 Rust `TaskPolicy`에 추가하고 CLI 인자로 세팅했는데 그 map에
 * 넣는 것을 잊었고, sidecar에는 `unattended: false`가 도착했다. **증상이 고약한 이유는 값이
 * 없는 게 아니라 "그럴듯한 기본값"이 도착한다는 점이다** — 무인 실행인데 sidecar는 사람이
 * 있다고 믿었고, 그래서 검증 없이 끝난 작업이 완료로 보고됐다. e2e가 잡았지만, e2e가 그
 * 필드를 보지 않았다면 아무도 못 잡았다.
 *
 * 24.3절은 그 자리에 주석을 남겼다. **주석은 검사가 아니다.**
 *
 * # 판정 기준을 손으로 적지 않는다
 *
 * "이 필드들은 반드시 전달되어야 한다"는 목록을 여기 적으면, 그건 갈라질 수 있는 곳을 셋에서
 * 넷으로 늘리는 것이다. 세 파일에서 **유도한다**:
 *
 *  - Rust `TaskPolicy`의 필드와 serde 이름 (`types.rs`)
 *  - TS `TaskPolicy`의 필드 이름 (`task.ts`)
 *  - 호스트가 실제로 세팅하는 필드와 실제로 보내는 map 키 (`bin/host.rs`)
 *
 * # 왜 map을 파생시키지 않고 검사로 막는가
 *
 * 두 타입의 필드가 일대일이 아니다 — `budgetUsd`·`modelPins`는 TS에만 있고, Rust에만 있는
 * 것도 생길 수 있다(예: 셸 실행 상한처럼 sidecar가 관여하지 않는 값). 그래서 Rust 구조체를
 * 그대로 직렬화해 보낼 수 없고, map은 손으로 남는다. 남는다면 지켜야 한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const RUST_TYPES = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "types.rs");
const SRC_TAURI = path.join(REPO_ROOT, "apps", "desktop", "src-tauri");
const TS_TASK = path.join(REPO_ROOT, "packages", "protocol", "src", "task.ts");

/**
 * `//` 줄 주석을 지운다. 중괄호 매칭과 키 추출 **양쪽**에 필요하다 — 이 저장소의 주석에는
 * 따옴표와 괄호가 흔하게 들어 있고(`// null은 "기본값을 쓰라"가 아니라 ...`), 지우지 않으면
 * 주석 안의 문장이 필드로 읽힌다.
 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** `/* ... *\/` 블록 주석을 지운다 (TS의 JSDoc). */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * `header`가 여는 중괄호부터 짝이 맞는 닫는 중괄호까지를 돌려준다.
 *
 * **찾지 못하면 빈 문자열이 아니라 예외를 던진다.** 이름이 바뀌었을 때 "필드 0개"로 조용히
 * 통과하면, 이 검사는 있는 채로 아무것도 검사하지 않게 된다 — 가장 나쁜 결말이다.
 */
function blockAfter(source: string, header: string, label: string): string {
  const at = source.indexOf(header);
  assert.notEqual(at, -1, `${label}에서 ${JSON.stringify(header)}를 찾지 못했습니다 — 이름이 바뀌었습니까?`);
  const open = source.indexOf("{", at + header.length - 1);
  assert.notEqual(open, -1, `${label}: ${JSON.stringify(header)} 뒤에 여는 중괄호가 없습니다`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`${label}: ${JSON.stringify(header)} 블록이 닫히지 않았습니다`);
}

/** 블록의 **최상위 깊이**에서만 정규식을 적용한다 — 중첩 타입/`match` 안쪽은 필드가 아니다. */
function topLevelLines(block: string): string[] {
  const lines: string[] = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    if (depth === 0) lines.push(line);
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    }
  }
  return lines;
}

/** Rust `TaskPolicy`의 필드 → 실제로 나가는 JSON 키(serde rename이 있으면 그것). */
function rustPolicyFields(): Map<string, string> {
  const source = stripLineComments(readFileSync(RUST_TYPES, "utf8"));
  const block = blockAfter(source, "pub struct TaskPolicy {", "types.rs");
  const fields = new Map<string, string>();
  let pendingRename: string | null = null;
  for (const line of block.split("\n")) {
    const rename = line.match(/#\[serde\([^)]*rename\s*=\s*"([A-Za-z0-9_]+)"/);
    if (rename) {
      pendingRename = rename[1]!;
      continue;
    }
    const field = line.match(/^\s*pub\s+([a-z0-9_]+)\s*:/);
    if (field) {
      // rename이 없으면 serde는 Rust 이름을 그대로 쓴다 — 이 구조체에는 `rename_all`이 없다.
      fields.set(field[1]!, pendingRename ?? field[1]!);
      pendingRename = null;
    }
  }
  return fields;
}

/** TS `TaskPolicy`의 필드 이름. */
function tsPolicyFields(): Set<string> {
  const source = stripBlockComments(stripLineComments(readFileSync(TS_TASK, "utf8")));
  const block = blockAfter(source, "export interface TaskPolicy {", "task.ts");
  const names = new Set<string>();
  for (const line of topLevelLines(block)) {
    const field = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\??\s*:/);
    if (field) names.add(field[1]!);
  }
  return names;
}

/**
 * sidecar로 policy를 보내는 **모든** 자리.
 *
 * 처음에는 헤드리스 호스트 하나만 봤다. **그때 UI 경로가 이미 갈라져 있었다** — `session.rs`가
 * 자기 map을 따로 조립하고 있었고 M3에서 늘어난 필드가 거기에는 없었다. 검사가 한 파일만
 * 보면 "지켜지고 있다"는 인상만 주고 정작 production 경로를 놓친다.
 *
 * 그래서 파일 목록을 적지 않는다. `src-tauri` 아래를 훑어 `"policy": {` 블록을 전부 찾고,
 * 그중 **`TaskPolicy`를 향하는 것**만 고른다 — 판정 기준은 그 블록이 `executionMode`를
 * 담고 있는가다(`PolicyDecision` 응답 map과 구별된다).
 */
function policySites(): { label: string; source: string; block: string }[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "target" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs")) files.push(full);
    }
  };
  walk(SRC_TAURI);

  const sites: { label: string; source: string; block: string }[] = [];
  for (const file of files) {
    const source = stripLineComments(readFileSync(file, "utf8"));
    let at = source.indexOf('"policy": {');
    while (at !== -1) {
      const block = blockFrom(source, at + '"policy":'.length);
      // `PolicyDecision` 응답 map은 `executionMode`를 담지 않는다.
      if (block.includes("executionMode")) {
        sites.push({ label: path.relative(REPO_ROOT, file), source, block });
      }
      at = source.indexOf('"policy": {', at + 1);
    }
  }
  return sites;
}

/** 여는 중괄호부터 짝이 맞는 닫는 중괄호까지. */
function blockFrom(source: string, from: number): string {
  const open = source.indexOf("{", from);
  assert.notEqual(open, -1);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail("policy 블록이 닫히지 않았습니다");
}

/** 한 파일이 Rust `TaskPolicy` 리터럴에서 **명시적으로 세팅하는** 필드. */
function rustFieldsSetIn(source: string, label: string): Set<string> {
  const names = new Set<string>();
  let at = source.indexOf("TaskPolicy {");
  while (at !== -1) {
    for (const line of topLevelLines(blockFrom(source, at + "TaskPolicy".length))) {
      const field = line.match(/^\s*([a-z0-9_]+)\s*:/);
      if (field) names.add(field[1]!);
    }
    at = source.indexOf("TaskPolicy {", at + 1);
  }
  assert.ok(label.length > 0);
  return names;
}

/** 한 policy map이 실제로 보내는 키. */
function jsonKeysIn(block: string): Set<string> {
  const keys = new Set<string>();
  for (const line of topLevelLines(block)) {
    const key = line.match(/^\s*"([A-Za-z][A-Za-z0-9]*)"\s*:/);
    if (key) keys.add(key[1]!);
  }
  return keys;
}

test("policy를 보내는 자리를 전부 찾을 수 있다", () => {
  const sites = policySites();
  // **최소 둘이다** — 헤드리스 호스트와 UI(`session.rs`). 하나만 찾았다면 스캔이 깨졌거나
  // 한쪽이 사라진 것이고, 어느 쪽이든 아래 검사가 절반만 돌게 된다.
  assert.ok(sites.length >= 2, `policy map을 ${sites.length}곳만 찾았습니다: ${sites.map((s) => s.label).join(", ")}`);
  assert.ok(rustPolicyFields().size >= 5, `Rust TaskPolicy 필드를 ${rustPolicyFields().size}개만 찾았습니다`);
  assert.ok(tsPolicyFields().size >= 5, `TS TaskPolicy 필드를 ${tsPolicyFields().size}개만 찾았습니다`);
});

/**
 * **이것이 실제로 틀렸던 검사다.**
 *
 * 조건이 둘인 이유: Rust에만 있는 정책(sidecar가 관여하지 않는 값)을 넣을 자리를 남겨야 하고,
 * 동시에 "양쪽에 같은 이름이 있다"는 것은 **두 프로세스가 그 값을 함께 쓰기로 했다**는 뜻이다.
 * 함께 쓰기로 한 값을 한쪽에만 세팅하면, 다른 쪽은 기본값을 자기 사실로 믿는다.
 *
 * **자리마다 따로 본다.** 한 자리가 지키고 있어도 다른 자리가 갈라져 있을 수 있고, 실제로
 * 그랬다.
 */
test("정책을 세팅한 자리는 그것을 sidecar로도 보낸다", () => {
  const rust = rustPolicyFields();
  const ts = tsPolicyFields();
  let checked = 0;

  for (const site of policySites()) {
    const setInRust = rustFieldsSetIn(site.source, site.label);
    const sent = jsonKeysIn(site.block);
    for (const field of setInRust) {
      const jsonKey = rust.get(field);
      // `..TaskPolicy::default()`처럼 필드가 아닌 줄은 무시한다.
      if (!jsonKey || !ts.has(jsonKey)) continue;
      checked += 1;
      assert.ok(
        sent.has(jsonKey),
        `${site.label}이 Rust 정책 ${field}를 세팅하지만 sidecar로는 ${jsonKey}를 보내지 않습니다. ` +
          `sidecar는 기본값을 자기 사실로 믿게 됩니다 (state-machine 24.3절)`
      );
    }
  }

  // 공유 필드를 하나도 못 봤으면 위 루프는 아무것도 검사하지 않았다.
  assert.ok(checked >= 5, `양쪽이 함께 아는 정책을 ${checked}번만 확인했습니다`);
});

/**
 * 반대 방향. 오타는 값이 없는 게 아니라 **키가 다른 값**을 만들고, 받는 쪽에서는 그냥
 * `undefined`라 기본값이 적용된다 — 위 검사와 정확히 같은 방식으로 조용하다.
 */
test("보내는 정책 키는 전부 TS TaskPolicy에 있다", () => {
  const ts = tsPolicyFields();
  for (const site of policySites()) {
    for (const key of jsonKeysIn(site.block)) {
      assert.ok(
        ts.has(key),
        `${site.label}이 보내는 policy 키 ${JSON.stringify(key)}가 TS TaskPolicy에 없습니다 — ` +
          `오타이거나, 받는 쪽에서 지워진 필드입니다`
      );
    }
  }
});
