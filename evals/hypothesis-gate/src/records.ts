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
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:AWS|aws)_SECRET_ACCESS_KEY\s*[=:]\s*\S+/,
  /ghp_[A-Za-z0-9]{20,}/,
];

export function findSecretLike(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0].slice(0, 12) + "…";
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
