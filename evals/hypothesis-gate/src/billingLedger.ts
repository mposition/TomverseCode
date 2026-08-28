import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * **미정산 부채 원장** — 과금 여부를 확정할 수 없는 예약을 격리해 보관한다.
 *
 * # 왜 예산 원장과 분리하는가
 *
 * 예산 원장(`budget-events.jsonl`)은 **한 실행의 지출을 상한 안에 묶어두는 장치**다. 그 안에서
 * 과금 여부가 불확실한 예약은 재개를 막는다 — 코드가 알 수 없는 사실을 추측해 넘어가면 돈이
 * 새거나 남은 예산을 잃기 때문이다.
 *
 * 그런데 그 규칙에는 대가가 있다. **불확실한 호출 하나가 그 실행 디렉터리를 영구히 못 쓰게
 * 만든다.** 실측으로 가설 게이트 P1이 그 이유로 네 번 멈췄다. 예산을 지키는 일과 회계를
 * 정확히 하는 일이 한 장치에 묶여 있어서 생긴 문제다.
 *
 * 그래서 둘로 나눈다.
 *
 * - **예산 보호**: 그 금액을 **최대치로 계속 committed에 잡아둔다.** 절대 $0으로 풀지 않는다 —
 *   $0으로 푸는 순간 승인 상한이 실제 노출보다 커진다
 * - **회계**: 이 원장에 **미정산 부채**로 남긴다. 공급자 청구 내역과 대조될 때까지 금액은
 *   확정값이 아니라 **범위**다
 *
 * # 상태 전이
 *
 * ```
 * reserved → billing_unknown_pending → billed | not_billed
 *                                    ↘ billing_unknown  (재조정 기한 경과, 영구 미확정)
 * ```
 *
 * **어떤 전이도 코드가 스스로 하지 않는다.** `billed`/`not_billed`는 사람이 공급자 청구
 * 내역을 보고 근거와 함께 기록하는 것이고, `billing_unknown`은 기한이 지났다는 사실만으로
 * 닫는 것이다 — **닫아도 원장에서 지우지 않는다.**
 *
 * # append-only
 *
 * 상태를 바꿔도 이전 줄을 고치지 않고 새 줄을 붙인다. 현재 상태는 마지막 줄이 말한다.
 * 지우거나 덮어쓰면 "무엇을 알고 있었고 언제 바뀌었는가"가 사라진다.
 */

export const BILLING_LEDGER_FILE = "billing-ledger.jsonl";

/** 공급자 청구 내역의 보고 지연 상한. 이 시간이 지나면 한 번 재조정하고 영구 미확정으로 닫는다. */
export const RECONCILE_DEADLINE_HOURS = 72;

export type BillingStatus =
  /** 과금 여부를 모른다. 금액은 "0 이상 예약액 이하"다. */
  | "billing_unknown_pending"
  /** 사람이 청구 내역에서 확인했다 — 과금됐다. `actualUsd`가 있으면 그 값이 정본이다. */
  | "billed"
  /** 사람이 청구 내역에서 확인했다 — 과금되지 않았다. */
  | "not_billed"
  /** 재조정 기한이 지나도 판별하지 못했다. **영구 미확정.** 지우지 않는다. */
  | "billing_unknown";

export const TERMINAL_BILLING_STATUSES: ReadonlySet<BillingStatus> = new Set([
  "billed",
  "not_billed",
  "billing_unknown",
]);

export interface BillingLedgerEntry {
  schemaVersion: 1;
  /** 이 부채의 식별자. `correlationId`와 실행 디렉터리로 만든다 — 같은 예약이 두 번 등록되지 않게. */
  entryId: string;
  /** 예산 원장에서의 예약 식별자. 대조의 근거다. */
  correlationId: string;
  providerId: string;
  requestedModelId?: string;
  /** 공급자가 준 요청 ID. 청구 내역과 대조할 때 가장 강한 단서다. */
  providerRequestId?: string;
  /** 이 예약이 열려 있던 시간 창 — 청구 내역에서 찾을 구간이다. */
  windowStart: string;
  windowEnd?: string;
  /** 예약액 = **최대 노출액.** 실제 과금액이 아니다. */
  reservedUsd: number;
  /** 부분 정산이 있었으면 그중 확정된 금액. 이 원장이 다루는 것은 나머지다. */
  settledUsd?: number;
  /** 무엇 때문에 확정할 수 없게 됐는가. 사람이 청구 내역을 볼 때 필요한 맥락이다. */
  abortCause: string;
  /** 어느 실행 디렉터리에서 났는가. */
  runDir: string;
  runId?: string;
  stage?: string;
  status: BillingStatus;
  statusSetAt: string;
  /** 누가/무엇이 이 상태를 적었는가. 사람의 확인과 자동 등록을 구별한다. */
  statusSetBy: "auto-register" | "human-attestation" | "deadline-close";
  /** `billed`일 때 사람이 적은 실제 금액. 모르면 생략한다 — 0으로 적지 않는다. */
  actualUsd?: number;
  /** 사람이 무엇을 보고 그렇게 판단했는가. `billed`/`not_billed`에는 필수다. */
  evidence?: string;
  note?: string;
  /** 이 줄이 **어떤 상태를 뒤집은 정정**인가. 최초 판정에는 없다. */
  correctsStatus?: BillingStatus;
}

export function billingLedgerPath(outputRoot: string): string {
  return path.join(outputRoot, BILLING_LEDGER_FILE);
}

/** 원장 전체를 읽는다. 없으면 빈 배열 — "없다"와 "못 읽었다"는 파싱 오류로 구별된다. */
export function readBillingLedger(outputRoot: string): BillingLedgerEntry[] {
  const file = billingLedgerPath(outputRoot);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as BillingLedgerEntry;
    } catch (error) {
      throw new Error(`${file}:${i + 1}행을 파싱할 수 없습니다: ${String(error)}`);
    }
  });
}

/**
 * 항목별 **현재 상태**. append-only이므로 같은 `entryId`의 마지막 줄이 정본이다.
 *
 * 등록 순서를 보존한다 — 리포트가 시간순으로 읽히는 편이 대조에 낫다.
 */
export function currentBillingEntries(entries: readonly BillingLedgerEntry[]): BillingLedgerEntry[] {
  const latest = new Map<string, BillingLedgerEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    if (!latest.has(entry.entryId)) order.push(entry.entryId);
    latest.set(entry.entryId, entry);
  }
  return order.map((id) => latest.get(id)!);
}

export function appendBillingEntry(outputRoot: string, entry: BillingLedgerEntry): void {
  mkdirSync(outputRoot, { recursive: true });
  appendFileSync(billingLedgerPath(outputRoot), `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * 비용을 **범위로** 낸다.
 *
 * 확정 지출 하나로 보고하면 미정산 부채가 보이지 않고, 최대치 하나로 보고하면 쓰지도 않은
 * 돈을 쓴 것처럼 말하게 된다. 둘 다 사실이 아니므로 셋을 함께 낸다.
 */
export interface BillingExposure {
  /** 청구 내역으로 확인된 과금(`billed`의 `actualUsd` 합). 모르는 금액은 여기 없다. */
  confirmedUsd: number;
  /** 아직 판별되지 않은 최대 노출액. `billing_unknown_pending`과 `billing_unknown`의 합. */
  unsettledMaxUsd: number;
  /**
   * **과금은 확인됐으나 금액을 모르는** 최대 노출.
   *
   * `unsettledMaxUsd`에도 포함되지만 따로 센다 — "과금 여부를 모른다"와 "과금됐는데 얼마인지
   * 모른다"는 다음에 할 일이 다르다. 앞은 청구 내역에서 찾아야 하고, 뒤는 금액만 채우면 된다.
   */
  billedAmountUnknownUsd: number;
  /** 확인 결과 과금되지 않은 것으로 닫힌 금액. 참고용이며 어떤 합계에도 더하지 않는다. */
  clearedUsd: number;
  pendingCount: number;
  permanentUnknownCount: number;
  /** 재조정 기한이 지난 `billing_unknown_pending` 항목 — 닫을지 판단해야 한다. */
  overdue: BillingLedgerEntry[];
}

export function summarizeBillingExposure(
  entries: readonly BillingLedgerEntry[],
  now: Date,
  deadlineHours: number = RECONCILE_DEADLINE_HOURS
): BillingExposure {
  const current = currentBillingEntries(entries);
  let confirmedUsd = 0;
  let unsettledMaxUsd = 0;
  let clearedUsd = 0;
  let billedAmountUnknownUsd = 0;
  let pendingCount = 0;
  let permanentUnknownCount = 0;
  const overdue: BillingLedgerEntry[] = [];

  for (const entry of current) {
    const outstanding = Math.max(0, entry.reservedUsd - (entry.settledUsd ?? 0));
    switch (entry.status) {
      case "billed":
        // **금액을 모르면 확정 합계에 넣지 않는다.** 대신 최대 노출로 남긴다 —
        // "과금됐다"는 알지만 "얼마인지"는 모르는 상태가 실제로 있다.
        if (entry.actualUsd === undefined) {
          unsettledMaxUsd += outstanding;
          billedAmountUnknownUsd += outstanding;
        }
        else confirmedUsd += entry.actualUsd;
        break;
      case "not_billed":
        clearedUsd += outstanding;
        break;
      case "billing_unknown":
        unsettledMaxUsd += outstanding;
        permanentUnknownCount += 1;
        break;
      case "billing_unknown_pending":
        unsettledMaxUsd += outstanding;
        pendingCount += 1;
        if (isOverdue(entry, now, deadlineHours)) overdue.push(entry);
        break;
    }
  }

  return {
    confirmedUsd,
    unsettledMaxUsd,
    billedAmountUnknownUsd,
    clearedUsd,
    pendingCount,
    permanentUnknownCount,
    overdue,
  };
}

/** 시간 창이 끝난 뒤 `deadlineHours`가 지났는가. 끝 시각이 없으면 등록 시각을 쓴다. */
export function isOverdue(entry: BillingLedgerEntry, now: Date, deadlineHours: number): boolean {
  const since = Date.parse(entry.windowEnd ?? entry.statusSetAt);
  if (!Number.isFinite(since)) return false;
  return now.getTime() - since >= deadlineHours * 3600_000;
}

/**
 * 사람의 확인을 기록한다. **근거 없이 상태를 바꿀 수 없다.**
 *
 * 근거를 요구하는 이유: 이 전이는 돈에 대한 주장이고, 나중에 그 주장을 되짚을 수 있어야 한다.
 * "확인함" 한 마디만 남으면 무엇을 보고 그렇게 판단했는지 알 수 없다.
 */
export function attestBillingEntry(
  entry: BillingLedgerEntry,
  input: {
    outcome: "billed" | "not_billed";
    actualUsd?: number;
    evidence: string;
    at: string;
    /**
     * 사람이 내린 판정(`billed`/`not_billed`)을 **뒤집는다**는 명시적 선언.
     *
     * `billing_unknown`에는 필요 없다 — 그건 "판정했다"가 아니라 **"판정을 포기했다"**이므로,
     * 나중에 청구 증거가 나오면 정정하는 것이 원래 의도다. 반면 사람이 확인해 닫은 것을
     * 조용히 덮으면 두 번의 확인 중 어느 쪽이 맞는지 기록만 보고 알 수 없다.
     */
    correct?: boolean;
  }
): BillingLedgerEntry {
  // **영구 미확정은 잠긴 상태가 아니다.** 기한이 지나 판별을 포기한 것일 뿐이고, 나중에
  // 청구 증거가 나오면 정정 이벤트를 붙이는 것이 이 원장의 설계다.
  const isHumanVerdict = entry.status === "billed" || entry.status === "not_billed";
  if (isHumanVerdict && input.correct !== true) {
    throw new Error(
      `${entry.entryId}는 이미 ${entry.status}로 판정됐습니다 — 뒤집으려면 정정임을 명시하세요`
    );
  }
  if (input.evidence.trim().length === 0) {
    throw new Error(`${entry.entryId}: 근거 없이 과금 여부를 기록할 수 없습니다`);
  }
  if (input.outcome === "billed" && input.actualUsd !== undefined) {
    if (!Number.isFinite(input.actualUsd) || input.actualUsd < 0) {
      throw new Error(`${entry.entryId}: 실제 금액이 유효한 수가 아닙니다 (${String(input.actualUsd)})`);
    }
  }
  return {
    ...entry,
    status: input.outcome,
    statusSetAt: input.at,
    statusSetBy: "human-attestation",
    // **무엇을 뒤집었는지 남긴다.** append-only라 이전 줄도 남지만, 현재 줄만 봐도
    // 이것이 정정인지 최초 판정인지 알 수 있어야 한다.
    ...(entry.status !== "billing_unknown_pending" ? { correctsStatus: entry.status } : {}),
    ...(input.actualUsd !== undefined ? { actualUsd: input.actualUsd } : {}),
    evidence: input.evidence,
  };
}

/** 재조정 기한이 지난 항목을 **영구 미확정**으로 닫는다. 지우지 않는다. */
export function closeOverdueEntry(entry: BillingLedgerEntry, at: string): BillingLedgerEntry {
  if (TERMINAL_BILLING_STATUSES.has(entry.status)) {
    throw new Error(`${entry.entryId}는 이미 ${entry.status}로 닫혔습니다`);
  }
  return {
    ...entry,
    status: "billing_unknown",
    statusSetAt: at,
    statusSetBy: "deadline-close",
    note:
      `공급자 청구 내역 보고 지연 상한(${RECONCILE_DEADLINE_HOURS}시간)이 지나도 판별하지 못했습니다. ` +
      `금액은 최대 노출로 남으며 원장에서 삭제하지 않습니다.`,
  };
}

/**
 * 예약 식별자에서 **어느 공급자의 호출이 확정되지 않았는가**를 유도한다.
 *
 * 예산 이벤트의 `reservation_unresolved`에는 `providerId`가 없다 — 예약은 기록 단위이고
 * 한 기록이 두 공급자를 부를 수 있기 때문이다. 그래서 실행 기록에서 **실제로 실패한 호출**을
 * 찾아 그 공급자를 쓴다. 청구 내역과 대조할 때 필요한 것이 바로 그 값이다.
 *
 * 유도하지 못하면 `"unknown"`을 쓴다. 추측한 값을 적으면 대조하는 사람이 엉뚱한 공급자의
 * 내역을 뒤지게 된다 — 모른다고 적는 편이 낫다.
 */
export function deriveFailedCallProvider(
  runDir: string,
  correlationId: string
): { providerId: string; requestedModelId?: string; providerRequestId?: string; windowEnd?: string } {
  const unknown = { providerId: "unknown" };
  // `<fixtureId>/<arm>/rep<N>#<seq>` — `#` 뒤는 ledger가 붙인 순번이다.
  const match = /^(.+)\/([A-D])\/rep(\d+)(?:#\d+)?$/.exec(correlationId);
  if (!match) return unknown;
  const [, fixtureId, arm, repetition] = match;

  const file = path.join(runDir, "records.jsonl");
  if (!existsSync(file)) return unknown;
  let rows: {
    fixtureId?: string; arm?: string; repetition?: number;
    providerCalls?: { providerId?: string; requestedModelId?: string; providerRequestId?: string;
      status?: string; completedAt?: string }[];
  }[];
  try {
    rows = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return unknown;
  }

  const record = rows.find(
    (r) => r.fixtureId === fixtureId && r.arm === arm && String(r.repetition) === repetition
  );
  const failed = record?.providerCalls?.find((c) => c.status !== "succeeded");
  if (!failed?.providerId) return unknown;
  return {
    providerId: failed.providerId,
    ...(failed.requestedModelId ? { requestedModelId: failed.requestedModelId } : {}),
    ...(failed.providerRequestId ? { providerRequestId: failed.providerRequestId } : {}),
    ...(failed.completedAt ? { windowEnd: failed.completedAt } : {}),
  };
}
