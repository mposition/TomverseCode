import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ArmId, GateRunRecord } from "./types.js";

/**
 * 실행 기록 저장 — **완료 직후 즉시 append.**
 *
 * # 왜 즉시 쓰는가
 *
 * 실험은 몇 시간 걸리고 중간에 죽는다(네트워크, 예산 소진, 사용자 중단). 전부 끝나고 한 번에
 * 쓰면 그때까지의 실제 API 비용이 통째로 사라진다. 한 줄씩 append하면 프로세스가 어느 순간
 * 죽어도 그 직전까지의 결과가 남고, `--resume`이 이어받을 수 있다.
 *
 * JSONL을 고른 이유: append가 원자적에 가깝고(한 줄 쓰기), 중간에 잘린 마지막 줄을 버리는 것만으로
 * 복구가 끝난다. JSON 배열이면 파일이 통째로 깨진다.
 */

export interface RecordStore {
  readonly filePath: string;
  append(record: GateRunRecord): void;
  all(): GateRunRecord[];
  /** 이미 완료된 (fixture, arm, repetition) 조합인가 — resume이 중복 호출을 피하는 근거. */
  isDone(fixtureId: string, arm: ArmId, repetition: number): boolean;
  count(): number;
}

function key(fixtureId: string, arm: ArmId, repetition: number): string {
  return `${fixtureId}::${arm}::${repetition}`;
}

/**
 * 기존 JSONL을 읽는다. **마지막 줄이 깨져 있으면 조용히 버린다.**
 *
 * 중간에 죽은 실행은 마지막 줄이 잘려 있을 수 있다. 거기서 예외를 던지면 그때까지의
 * 멀쩡한 기록 전부를 못 쓰게 된다 — 잘린 줄 하나를 버리는 편이 명백히 낫다.
 * 다만 **중간 줄**이 깨져 있으면 그건 다른 문제이므로 던진다.
 */
export function parseJsonl(text: string): { records: GateRunRecord[]; droppedTrailing: boolean } {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const records: GateRunRecord[] = [];
  let droppedTrailing = false;
  for (let i = 0; i < lines.length; i += 1) {
    try {
      records.push(JSON.parse(lines[i]!) as GateRunRecord);
    } catch (error) {
      if (i === lines.length - 1) {
        droppedTrailing = true;
        break;
      }
      throw new Error(`실행 기록 ${i + 1}번째 줄이 손상되었습니다: ${String(error)}`);
    }
  }
  return { records, droppedTrailing };
}

export function openRecordStore(filePath: string): RecordStore {
  mkdirSync(path.dirname(filePath), { recursive: true });

  const loaded: GateRunRecord[] = [];
  const done = new Set<string>();
  if (existsSync(filePath)) {
    const { records } = parseJsonl(readFileSync(filePath, "utf8"));
    for (const record of records) {
      loaded.push(record);
      done.add(key(record.fixtureId, record.arm, record.repetition));
    }
  }

  return {
    filePath,
    append(record) {
      appendFileSync(filePath, `${JSON.stringify(record)}\n`);
      loaded.push(record);
      done.add(key(record.fixtureId, record.arm, record.repetition));
    },
    all: () => [...loaded],
    isDone: (fixtureId, arm, repetition) => done.has(key(fixtureId, arm, repetition)),
    count: () => loaded.length,
  };
}

/**
 * 기록에 비밀값이 섞이지 않았는지 확인한다.
 *
 * 이 하네스는 모델 출력과 명령 출력을 다룬다. 그 안에 자격증명이 들어갈 경로가 실제로 있으므로
 * (fixture 테스트가 환경변수를 출력하는 등) 저장 직전에 한 번 더 본다.
 * `oracle.ts`가 자식 환경에서 키를 지우는 것이 1차 방어이고, 이건 2차 방어다.
 */
/**
 * # 왜 JSON 문자열 전체가 아니라 토큰을 보는가
 *
 * 원래는 기록을 `JSON.stringify`한 뒤 `/sk-[A-Za-z0-9_-]{16,}/`로 훑었다. 그게
 * **`task-<uuid>`를 자격증명으로 오탐했다** — `"taskId":"task-367002d2-..."` 안에는
 * `ta`**`sk-`**`367002d2-...`가 들어 있고, 호스트는 taskId를 받지 못하면 `task-{uuid}`를
 * 스스로 만든다(`bin/host.rs`).
 *
 * 오탐의 대가가 크다: `assertNoSecrets`가 던지면 **그 기록이 저장되지 않고** 실행이 멈춘다.
 * 유료 실행 중이라면 돈은 썼는데 결과가 사라지고 재개할 근거도 남지 않는다.
 *
 * 처음 고칠 때는 `sk-` 앞에 영숫자가 오면 매치하지 않게 했는데, 그러면 **개행 뒤의 키를
 * 놓쳤다** — JSON은 개행을 `\` + `n` 두 글자로 쓰므로 앞 문자가 `n`이 되어 걸러진다.
 * 앞 문자를 보는 방식 자체가 직렬화 형식에 의존하는 것이 문제였다.
 *
 * 그래서 **실제 문자열 값들을 순회하며 토큰 단위로** 본다. 토큰은 키에 쓰일 수 있는 문자
 * (`[A-Za-z0-9_-]`)의 연속이고, 패턴을 토큰 **시작**에 앵커한다:
 *  - `task-367002d2-...`는 토큰 하나 → `^sk-`가 맞지 않는다 (오탐 없음)
 *  - `OPENAI_API_KEY=sk-...`는 `=`에서 갈라져 `sk-...`가 토큰이 된다 (탐지됨)
 *  - 개행·인용부호·공백 뒤의 키도 마찬가지로 토큰 시작이다 (탐지됨)
 *
 * **탐지를 약화시킨 것이 아니라 직렬화에 의존하지 않게 만든 것이다.** 여러 단어에 걸치는
 * 패턴(private key 헤더, AWS 변수 대입)은 토큰으로 쪼개면 안 되므로 문자열 전체로 본다.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^sk-ant-[A-Za-z0-9_-]{16,}/,
  /^ghp_[A-Za-z0-9]{20,}/,
];

const TEXT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:AWS|aws)_SECRET_ACCESS_KEY\s*[=:]\s*\S+/,
];

/** 값 안의 모든 문자열을 모은다. 필드 이름은 우리가 정한 것이므로 보지 않는다. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function truncate(match: string): string {
  return `${match.slice(0, 12)}…`;
}

export function findSecretLike(value: unknown): string | undefined {
  const strings: string[] = [];
  collectStrings(value, strings);

  for (const text of strings) {
    for (const pattern of TEXT_PATTERNS) {
      const match = pattern.exec(text);
      if (match) return truncate(match[0]);
    }
    // 키에 쓰일 수 있는 문자의 연속을 토큰으로 본다. `-`와 `_`는 키의 일부이므로 자르지 않는다.
    for (const token of text.split(/[^A-Za-z0-9_-]+/)) {
      if (token.length === 0) continue;
      for (const pattern of TOKEN_PATTERNS) {
        const match = pattern.exec(token);
        if (match) return truncate(match[0]);
      }
    }
  }
  return undefined;
}

export function assertNoSecrets(record: GateRunRecord): void {
  const found = findSecretLike(record);
  if (found) {
    throw new Error(
      `실행 기록에 비밀값처럼 보이는 값이 있습니다 (${found}). 기록을 저장하지 않았습니다. ` +
        `fixture나 oracle 명령이 자격증명을 출력하고 있는지 확인하세요.`
    );
  }
}

/** 저장 전 항상 이걸 통과시킨다. */
export function appendChecked(store: RecordStore, record: GateRunRecord): void {
  assertNoSecrets(record);
  store.append(record);
}
