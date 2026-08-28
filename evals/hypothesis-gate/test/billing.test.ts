import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendBillingEntry,
  attestBillingEntry,
  closeOverdueEntry,
  currentBillingEntries,
  isOverdue,
  readBillingLedger,
  RECONCILE_DEADLINE_HOURS,
  summarizeBillingExposure,
  type BillingLedgerEntry,
} from "../src/billingLedger.js";

const base = (over: Partial<BillingLedgerEntry> = {}): BillingLedgerEntry => ({
  schemaVersion: 1,
  entryId: "run::corr#1",
  correlationId: "corr#1",
  providerId: "anthropic",
  windowStart: "2026-08-27T00:00:00.000Z",
  windowEnd: "2026-08-27T00:02:00.000Z",
  reservedUsd: 1.832,
  abortCause: "dispatched_no_response",
  runDir: "/run",
  status: "billing_unknown_pending",
  statusSetAt: "2026-08-27T00:02:00.000Z",
  statusSetBy: "auto-register",
  ...over,
});

test("미정산 부채는 자동으로 $0이 되지 않는다", () => {
  // 이 원장이 존재하는 이유 전부다. 자동으로 풀면 승인 상한이 실제 노출보다 커진다.
  const e = summarizeBillingExposure([base()], new Date("2026-08-27T01:00:00.000Z"));
  assert.equal(e.confirmedUsd, 0);
  assert.equal(e.unsettledMaxUsd, 1.832);
  assert.equal(e.pendingCount, 1);
});

test("append-only — 마지막 줄이 현재 상태다", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "billing-"));
  try {
    appendBillingEntry(dir, base());
    appendBillingEntry(dir, base({ status: "not_billed", statusSetBy: "human-attestation", evidence: "확인함" }));
    const all = readBillingLedger(dir);
    assert.equal(all.length, 2, "이전 줄이 사라졌습니다 — append-only가 아닙니다");
    const current = currentBillingEntries(all);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.status, "not_billed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("근거 없이 과금 여부를 기록할 수 없다", () => {
  // 이 전이는 돈에 대한 주장이다. 나중에 되짚을 수 없으면 주장이 아니라 소문이다.
  assert.throws(
    () => attestBillingEntry(base(), { outcome: "not_billed", evidence: "  ", at: "2026-08-27T02:00:00.000Z" }),
    /근거 없이/
  );
});

test("사람이 판정한 항목은 조용히 뒤집히지 않는다", () => {
  const closed = base({ status: "billed", evidence: "청구 내역 확인" });
  assert.throws(
    () => attestBillingEntry(closed, { outcome: "not_billed", evidence: "번복", at: "2026-08-27T02:00:00.000Z" }),
    /정정임을 명시하세요/
  );
});

test("과금됐지만 금액을 모르면 확정 합계에 넣지 않는다", () => {
  // "과금 여부를 모른다"와 "과금됐는데 얼마인지 모른다"는 다음에 할 일이 다르다.
  const billedUnknown = base({ status: "billed", evidence: "청구 내역에 있음", statusSetBy: "human-attestation" });
  const e = summarizeBillingExposure([billedUnknown], new Date("2026-08-27T01:00:00.000Z"));
  assert.equal(e.confirmedUsd, 0, "금액을 모르는데 확정 합계에 넣었습니다");
  assert.equal(e.billedAmountUnknownUsd, 1.832);
  assert.equal(e.unsettledMaxUsd, 1.832);

  const billedKnown = base({ status: "billed", actualUsd: 0.1145, evidence: "청구 내역 $0.1145" });
  const e2 = summarizeBillingExposure([billedKnown], new Date("2026-08-27T01:00:00.000Z"));
  assert.equal(e2.confirmedUsd, 0.1145);
  assert.equal(e2.unsettledMaxUsd, 0);
});

test("재조정 기한이 지나면 닫을 수 있고, 닫아도 금액은 남는다", () => {
  const entry = base();
  const before = new Date("2026-08-27T01:00:00.000Z");
  const after = new Date(Date.parse(entry.windowEnd!) + RECONCILE_DEADLINE_HOURS * 3600_000 + 1000);
  assert.equal(isOverdue(entry, before, RECONCILE_DEADLINE_HOURS), false);
  assert.equal(isOverdue(entry, after, RECONCILE_DEADLINE_HOURS), true);

  const closed = closeOverdueEntry(entry, after.toISOString());
  assert.equal(closed.status, "billing_unknown");
  assert.equal(closed.statusSetBy, "deadline-close");
  // **닫아도 노출액은 사라지지 않는다.** 지우는 것이 아니라 판별을 포기하는 것이다.
  const e = summarizeBillingExposure([closed], after);
  assert.equal(e.unsettledMaxUsd, 1.832);
  assert.equal(e.permanentUnknownCount, 1);
});

test("부분 정산의 확정분은 부채에서 뺀다", () => {
  const partial = base({ reservedUsd: 1.832, settledUsd: 0.5 });
  const e = summarizeBillingExposure([partial], new Date("2026-08-27T01:00:00.000Z"));
  assert.equal(Math.round(e.unsettledMaxUsd * 1e6) / 1e6, 1.332);
});

test("영구 미확정은 잠긴 상태가 아니다 — 나중에 증거가 나오면 정정한다", () => {
  // `close-overdue`는 "$0 판정"이 아니라 **판별을 포기한 상태**다. 잠그면 뒤늦게 나온 청구
  // 증거를 원장에 반영할 방법이 없어지고, 그러면 원장이 사실과 어긋난 채로 굳는다.
  const closed = base({ status: "billing_unknown", statusSetBy: "deadline-close" });
  const corrected = attestBillingEntry(closed, {
    outcome: "billed",
    actualUsd: 0.42,
    evidence: "뒤늦게 도착한 공급자 청구 내역에서 확인",
    at: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(corrected.status, "billed");
  assert.equal(corrected.actualUsd, 0.42);
  // 무엇을 뒤집었는지 현재 줄만 봐도 알 수 있어야 한다.
  assert.equal(corrected.correctsStatus, "billing_unknown");
});

test("사람이 내린 판정은 명시적 정정으로만 뒤집는다", () => {
  // 조용히 덮으면 두 번의 확인 중 어느 쪽이 맞는지 기록만 보고 알 수 없다.
  const verdict = base({ status: "not_billed", statusSetBy: "human-attestation", evidence: "청구 내역에 없음" });
  assert.throws(
    () => attestBillingEntry(verdict, { outcome: "billed", evidence: "다시 보니 있음", at: "2026-09-01T00:00:00.000Z" }),
    /정정임을 명시하세요/
  );
  const corrected = attestBillingEntry(verdict, {
    outcome: "billed",
    evidence: "다시 보니 있음 — 청구 주기가 늦게 반영됨",
    correct: true,
    at: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(corrected.status, "billed");
  assert.equal(corrected.correctsStatus, "not_billed");
});
