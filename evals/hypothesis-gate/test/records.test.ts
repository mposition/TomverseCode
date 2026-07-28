import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { criteriaHash } from "../src/criteria.js";
import { appendChecked, assertNoSecrets, findSecretLike, openRecordStore, parseJsonl } from "../src/records.js";
import { RECORD_SCHEMA_VERSION, type ArmId, type GateRunRecord } from "../src/types.js";

function record(fixtureId: string, arm: ArmId, repetition: number, extra: Partial<GateRunRecord> = {}): GateRunRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId: "r",
    fixtureId,
    fixtureHash: "h",
    category: "multi_file_contract",
    repetition,
    arm,
    seed: 1,
    taskId: "t",
    providerId: "openai",
    requestedModelId: "m",
    publicVerificationPassed: true,
    oracleVerificationPassed: true,
    inputTokens: 1,
    outputTokens: 1,
    providerCallCount: 1,
    retryCount: 0,
    latencyMs: 1,
    changedFiles: [],
    policyDenials: [],
    promptVersionHash: "p",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    providerKind: "real",
    criteriaHash: criteriaHash(),
    ...extra,
  } as GateRunRecord;
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-records-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("기록은 append 즉시 파일에 남는다", () => {
  withDir((dir) => {
    const file = path.join(dir, "records.jsonl");
    const store = openRecordStore(file);
    store.append(record("a", "A", 1));
    // 프로세스가 여기서 죽어도 남아 있어야 한다 — 그게 즉시 flush의 요점이다.
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
    store.append(record("b", "A", 1));
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  });
});

test("resume은 완료된 조합을 다시 실행하지 않는다", () => {
  withDir((dir) => {
    const file = path.join(dir, "records.jsonl");
    const first = openRecordStore(file);
    first.append(record("a", "A", 1));
    first.append(record("a", "C", 1));

    // 새 프로세스가 같은 파일을 연 상황.
    const resumed = openRecordStore(file);
    assert.equal(resumed.count(), 2);
    assert.equal(resumed.isDone("a", "A", 1), true);
    assert.equal(resumed.isDone("a", "C", 1), true);
    assert.equal(resumed.isDone("a", "A", 2), false, "다른 반복을 완료로 오인했습니다");
    assert.equal(resumed.isDone("b", "A", 1), false);
  });
});

test("중간에 잘린 마지막 줄은 버리고 나머지를 살린다", () => {
  withDir((dir) => {
    const file = path.join(dir, "records.jsonl");
    const store = openRecordStore(file);
    store.append(record("a", "A", 1));
    store.append(record("b", "A", 1));
    // 실험이 쓰다 죽은 상황을 그대로 재현한다.
    appendFileSync(file, '{"schemaVersion":1,"fixtureId":"c","ar');

    const recovered = openRecordStore(file);
    assert.equal(recovered.count(), 2, "잘린 줄 하나 때문에 멀쩡한 기록을 잃었습니다");
    assert.equal(recovered.isDone("a", "A", 1), true);
  });
});

test("중간 줄이 손상되면 조용히 넘어가지 않는다", () => {
  withDir((dir) => {
    const file = path.join(dir, "records.jsonl");
    writeFileSync(file, `{"broken":\n${JSON.stringify(record("a", "A", 1))}\n`);
    assert.throws(() => openRecordStore(file), /손상되었습니다/);
  });
});

test("parseJsonl이 잘린 마지막 줄을 보고한다", () => {
  const text = `${JSON.stringify(record("a", "A", 1))}\n{"partial":`;
  const parsed = parseJsonl(text);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.droppedTrailing, true);
});

// ---- secret redaction ----

test("비밀값처럼 보이는 값이 기록에 있으면 저장을 거부한다", () => {
  withDir((dir) => {
    const store = openRecordStore(path.join(dir, "records.jsonl"));
    const leaky = record("a", "A", 1, {
      policyDenials: ["명령 출력: OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345"],
    });
    assert.throws(() => appendChecked(store, leaky), /비밀값/);
    assert.equal(store.count(), 0, "거부했는데 기록이 남았습니다");
  });
});

test("여러 형태의 자격증명을 잡는다", () => {
  assert.ok(findSecretLike("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(findSecretLike("sk-ant-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(findSecretLike("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(findSecretLike("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"));
  assert.ok(findSecretLike("ghp_abcdefghijklmnopqrstuvwxyz0123"));
});

test("정상 기록은 통과시킨다", () => {
  // 과하게 잡으면 실험 기록이 전부 거부되어 하네스가 못 돈다.
  assert.equal(findSecretLike(record("a", "A", 1)), undefined);
  assert.equal(findSecretLike("src/app.ts를 수정했습니다"), undefined);
  assert.equal(findSecretLike("skip-this-test"), undefined);
  assert.doesNotThrow(() => assertNoSecrets(record("a", "A", 1)));
});
