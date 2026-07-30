import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BUDGET_EVENT_VERSION, type BudgetEvent } from "@tomverse/sidecar/budget";
import type { GateRunRecord } from "./types.js";

/**
 * 재개 시 **이미 쓴 돈을 복원한다** (§1, §7).
 *
 * # 왜 이것이 P0 결함이었나
 *
 * 예전에는 재개할 때 원장을 `createBudgetLedger(limit)`로 새로 만들었다. `committed`가 0에서
 * 시작하므로 **$25 한도에서 $20을 쓴 뒤 재개하면 추가로 $25를 더 쓸 수 있었다.** 재시작
 * 횟수만큼 한도가 늘어나는 것이므로 "승인 한도"라는 말이 성립하지 않는다.
 *
 * # 그리고 합계만 맞추는 것으로는 부족했다
 *
 * `records.jsonl`의 합과 `reservation_settled`의 합을 비교하는 것만으로는 **열린 예약**이
 * 보이지 않는다. 실행 순서는 (1) 예약 → (2) provider 호출 → (3) 기록 → (4) 정산이고,
 * (1) 이후 어디서든 프로세스가 죽을 수 있다. 그때 남는 것은 `reservation_opened` 하나뿐인데,
 * 그 요청은 **공급자가 처리하고 과금했을 수 있다.** 두 합계가 모두 0이면 "아무것도 안 썼다"로
 * 읽히고, 재개하면 그 돈을 다시 쓸 수 있다.
 *
 * 그래서 이제 이벤트를 **correlationId별 상태 머신**으로 검증한다. 정상 흐름은 둘뿐이다:
 * `opened → settled`, `opened → released`. 그 외는 전부 fail closed다.
 *
 * # 비용의 정본
 *
 * 한 예약의 확정 비용은 그 예약의 **terminal 이벤트**(`reservation_settled`)가 말한다.
 * `records.jsonl`은 실험 기록이며 파생물이다. 둘이 다르면 어느 쪽도 믿지 않고 멈춘다 —
 * 자세한 근거는 `docs/design/multi-engine-routing.md` 10.7절.
 */

export const BUDGET_EVENTS_FILE = "budget-events.jsonl";

/** 게이트가 유료 경로를 막을 때 쓰는 상태 코드. 문장이 아니라 코드로 남겨 테스트가 검증한다. */
export type BudgetBlockedStatus =
  /** 과금 여부를 확정할 수 없는 예약이 남아 있다. */
  | "BLOCKED_UNRESOLVED_RESERVATION"
  /** 이벤트 파일 자체가 해석 불가(모르는 버전, 손상된 중간 줄, 상태 머신 위반). */
  | "BLOCKED_INVALID_BUDGET_EVENTS"
  /** 기록 파일과 이벤트 원장의 비용이 다르다. */
  | "BLOCKED_RECORD_EVENT_MISMATCH"
  /** 기록에서 확정 비용을 복원할 수 없다. */
  | "BLOCKED_UNRECOVERABLE_RECORDS";

export interface RecoveredSpend {
  /** 이전 실행들에서 확정된 유료 비용의 합. */
  historicalUsd: number;
  /** 비용을 세는 데 실제로 쓰인 기록 수. */
  countedRecords: number;
  /** fake provider 기록 수 — 유료 사용액으로 세지 않는다. */
  fakeRecords: number;
}

export type RecoveryOutcome =
  | { ok: true; spend: RecoveredSpend }
  | { ok: false; status: BudgetBlockedStatus; reasons: string[] };

/** 기록 하나가 유료 호출을 실제로 했는가. */
function madePaidCall(record: GateRunRecord): boolean {
  return record.providerKind === "real" && record.providerCallCount > 0;
}

/**
 * `records.jsonl`에서 확정 비용을 복원한다.
 *
 * 엄격 규칙:
 *  - 실제 공급자를 호출한 기록은 `costUsd`가 있어야 한다. 없으면 재개 불가.
 *  - `NaN`/`Infinity`/음수는 거부한다.
 *  - `cost_unmeasurable` 기록이 있으면 재개 불가 — 그건 정의상 비용을 모르는 기록이다.
 *  - 같은 (fixture, arm, 반복)이 두 번 나오면 파일 손상으로 본다. `isDone`이 중복 실행을
 *    막으므로 정상 실행에서는 생길 수 없고, 생겼다면 그 파일의 합계를 신뢰할 수 없다.
 *  - fake 기록은 유료 사용액으로 세지 않는다(단가 0이 정상이다).
 */
export function recoverSpendFromRecords(records: readonly GateRunRecord[]): RecoveryOutcome {
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  let historicalUsd = 0;
  let countedRecords = 0;
  let fakeRecords = 0;

  for (const record of records) {
    const key = `${record.fixtureId}::${record.arm}::${record.repetition}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);

    if (record.providerKind === "fake") {
      fakeRecords += 1;
      // fake 기록에 0이 아닌 비용이 있으면 그 자체가 이상하다 — 조용히 넘기지 않는다.
      if (record.costUsd !== undefined && record.costUsd !== 0) {
        reasons.push(`${key}: fake provider 기록에 0이 아닌 비용이 있습니다 (${record.costUsd})`);
      }
      continue;
    }

    if (record.failureClass === "cost_unmeasurable") {
      reasons.push(
        `${key}: 비용을 측정할 수 없었던 유료 기록입니다 (cost_unmeasurable). ` +
          `이 기록이 얼마를 썼는지 알 수 없으므로 재개할 수 없습니다.`
      );
      continue;
    }

    if (!madePaidCall(record)) {
      // provider를 부르기 전에 끝난 기록(인증 실패, 초안 없음 등)은 비용이 0이다.
      // 다만 비용이 적혀 있다면 그 값을 존중한다.
      if (record.costUsd !== undefined) {
        const validated = validateCost(key, record.costUsd, reasons);
        if (validated !== undefined) {
          historicalUsd += validated;
          countedRecords += 1;
        }
      }
      continue;
    }

    if (record.costUsd === undefined) {
      reasons.push(
        `${key}: 실제 공급자를 ${record.providerCallCount}회 호출했는데 비용이 기록되지 않았습니다. ` +
          `얼마를 썼는지 모르는 상태로 한도를 계산할 수 없습니다.`
      );
      continue;
    }
    const validated = validateCost(key, record.costUsd, reasons);
    if (validated !== undefined) {
      historicalUsd += validated;
      countedRecords += 1;
    }
  }

  for (const [key, count] of seen) {
    if (count > 1) {
      reasons.push(
        `${key}: 같은 조합이 ${count}번 기록되어 있습니다 — 파일이 손상되었을 수 있어 합계를 신뢰할 수 없습니다.`
      );
    }
  }

  if (reasons.length > 0) return { ok: false, status: "BLOCKED_UNRECOVERABLE_RECORDS", reasons };
  return { ok: true, spend: { historicalUsd, countedRecords, fakeRecords } };
}

function validateCost(key: string, value: number, reasons: string[]): number | undefined {
  if (!Number.isFinite(value)) {
    reasons.push(`${key}: 비용이 유한한 수가 아닙니다 (${value})`);
    return undefined;
  }
  if (value < 0) {
    reasons.push(`${key}: 비용이 음수입니다 (${value})`);
    return undefined;
  }
  return value;
}

/**
 * 승인 상한이 **이미 쓴 금액을 감당하는가.**
 *
 * CLI와 테스트가 같은 함수를 쓰게 떼어냈다. 부등호를 두 곳에 적으면 한쪽만 고쳐질 수 있고,
 * 그 한쪽이 유료 실행 경로면 상한이 조용히 무력화된다.
 *
 * `<=`인 이유: 같으면 남은 금액이 0이므로 어떤 호출도 예약할 수 없다. "돌 수 있는 것처럼
 * 시작해서 첫 예약에서 죽는" 것보다 시작 전에 말해주는 편이 낫다.
 */
export function approvalCoversHistorical(
  approvedLimitUsd: number | undefined,
  historicalUsd: number
): { ok: true } | { ok: false; reason: string } {
  if (approvedLimitUsd === undefined) return { ok: true };
  if (approvedLimitUsd <= historicalUsd) {
    return {
      ok: false,
      reason:
        `승인 상한 $${approvedLimitUsd}가 이미 쓴 금액 $${historicalUsd.toFixed(4)} 이하입니다 — ` +
        `새 호출을 할 수 없으므로 시작하지 않습니다.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 감사 추적 (append-only)
// ---------------------------------------------------------------------------

export function budgetEventsPath(runDir: string, fileName: string = BUDGET_EVENTS_FILE): string {
  return path.join(runDir, fileName);
}

/**
 * 예산 이벤트를 append-only JSONL로 남긴다.
 *
 * 기록과 같은 방식(한 줄 append)을 쓰는 이유도 같다 — 프로세스가 어느 순간 죽어도 그 직전까지가
 * 남고, 잘린 마지막 줄 하나를 버리는 것으로 복구가 끝난다.
 */
export function createBudgetEventSink(
  runDir: string,
  fileName: string = BUDGET_EVENTS_FILE
): (event: BudgetEvent) => void {
  mkdirSync(runDir, { recursive: true });
  const file = budgetEventsPath(runDir, fileName);
  return (event) => {
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  };
}

export type EventReadOutcome =
  | { ok: true; events: BudgetEvent[]; truncatedLastLine: boolean }
  | { ok: false; status: "BLOCKED_INVALID_BUDGET_EVENTS"; reasons: string[] };

/**
 * 이벤트 파일을 읽는다. **해석할 수 없으면 빈 목록을 주지 않는다.**
 *
 * 예전에는 손상된 중간 줄에서 예외를 던지고 마지막 줄은 조용히 버렸다. 마지막 줄을 버리는 것은
 * 맞다(중단의 정상적인 흔적이다) — 다만 그 사실을 호출자에게 알려야 한다. 잘린 줄이 있다는 것은
 * **정산 이벤트가 유실됐을 수 있다**는 뜻이고, 그건 열린 예약과 같은 취급을 받아야 한다.
 *
 * 모르는 `eventVersion`도 거부한다. 새 필드를 무시하고 계속하면 "그 필드에 담긴 비용을 못 본
 * 채로 재개"가 가능해진다.
 */
export function readBudgetEvents(runDir: string, fileName: string = BUDGET_EVENTS_FILE): EventReadOutcome {
  const file = budgetEventsPath(runDir, fileName);
  if (!existsSync(file)) return { ok: true, events: [], truncatedLastLine: false };
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  // 마지막 원소가 빈 문자열이면 파일이 개행으로 끝난 것이다 = 마지막 줄이 온전하다.
  const endedCleanly = lines[lines.length - 1] === "";
  const content = lines.filter((l) => l.trim().length > 0);
  const events: BudgetEvent[] = [];
  const reasons: string[] = [];
  let truncatedLastLine = false;

  for (let i = 0; i < content.length; i += 1) {
    const isLast = i === content.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content[i]!);
    } catch {
      if (isLast && !endedCleanly) {
        // 중단으로 잘린 마지막 줄. 버리되 **사실을 남긴다.**
        truncatedLastLine = true;
        continue;
      }
      reasons.push(`예산 이벤트 ${i + 1}번째 줄이 손상되었습니다 (마지막 줄이 아니므로 중단 흔적이 아닙니다)`);
      continue;
    }
    const event = parsed as BudgetEvent;
    if (typeof event.eventVersion !== "number") {
      reasons.push(`예산 이벤트 ${i + 1}번째 줄에 eventVersion이 없습니다 — 해석하지 않습니다`);
      continue;
    }
    if (event.eventVersion > BUDGET_EVENT_VERSION) {
      reasons.push(
        `예산 이벤트 ${i + 1}번째 줄의 버전이 ${event.eventVersion}입니다 (이 코드가 아는 최대 ` +
          `${BUDGET_EVENT_VERSION}) — 모르는 필드에 비용이 담겨 있을 수 있으므로 해석하지 않습니다`
      );
      continue;
    }
    events.push(event);
  }

  if (reasons.length > 0) return { ok: false, status: "BLOCKED_INVALID_BUDGET_EVENTS", reasons };
  return { ok: true, events, truncatedLastLine };
}

// ---------------------------------------------------------------------------
// 예약 상태 머신
// ---------------------------------------------------------------------------

/** 한 예약이 어떻게 끝났는가. `open`은 **끝나지 않았다**는 뜻이다. */
export type ReservationOutcome = "settled" | "released" | "unresolved" | "open";

export interface ReservationView {
  correlationId: string;
  reservedUsd: number;
  outcome: ReservationOutcome;
  /** 정산된 경우의 확정 비용. */
  actualUsd?: number;
  openedAt: string;
  runId: string;
  stage: string;
  /** 이 예약에서 발견한 상태 머신 위반. */
  problems: string[];
}

export interface EventAnalysis {
  reservations: ReservationView[];
  /** terminal `settled` 이벤트가 말하는 확정 비용의 합. **비용의 정본이다.** */
  settledUsd: number;
  /** 열린 채로 남은 + 미해결로 남은 예약액. 사용 가능한 예산으로 되돌리지 않는다. */
  unresolvedUsd: number;
  /** 상태 머신 위반 전부. 하나라도 있으면 재개하지 않는다. */
  problems: string[];
}

const TERMINAL: ReadonlySet<string> = new Set(["reservation_settled", "reservation_released"]);

/**
 * 예산 이벤트를 correlationId별 상태 머신으로 검증한다.
 *
 * # 왜 상태 머신인가
 *
 * 합계 비교는 "없는 이벤트"를 볼 수 없다. `reservation_opened`만 있고 terminal이 없는 예약은
 * 어떤 합계에도 나타나지 않으므로, 합계만 맞추면 그 예약은 존재하지 않는 것처럼 처리된다.
 * 그런데 그 요청은 공급자가 처리하고 과금했을 수 있다 — 그게 이번에 고친 P0 결함이다.
 *
 * **열린 예약을 자동으로 0원이나 released로 바꾸지 않는다.** 코드가 알 수 없는 사실이고,
 * 틀린 쪽을 고르면 사용자 돈이 새거나 남은 예산을 잃는다. 사람이 확인할 상태다.
 */
export function analyzeBudgetEvents(events: readonly BudgetEvent[]): EventAnalysis {
  const byId = new Map<string, ReservationView>();
  const terminals = new Map<string, string[]>();
  const usageByIdUsd = new Map<string, number>();
  const problems: string[] = [];

  for (const event of events) {
    const id = event.correlationId;
    if (event.type === "reservation_opened") {
      if (id === undefined) {
        problems.push("reservation_opened 이벤트에 correlationId가 없습니다 — 어느 예약인지 알 수 없습니다");
        continue;
      }
      if (byId.has(id)) {
        problems.push(`${id}: reservation_opened가 두 번 있습니다 — 이벤트 파일을 신뢰할 수 없습니다`);
        continue;
      }
      const reserved = event.reservedUsd;
      if (typeof reserved !== "number" || !Number.isFinite(reserved) || reserved < 0) {
        problems.push(`${id}: 예약액이 유효한 수가 아닙니다 (${String(reserved)})`);
        continue;
      }
      byId.set(id, {
        correlationId: id,
        reservedUsd: reserved,
        outcome: "open",
        openedAt: event.at,
        runId: event.runId,
        stage: event.stage,
        problems: [],
      });
      continue;
    }

    if (event.type === "provider_usage_recorded" && id !== undefined && typeof event.actualUsd === "number") {
      // 예전 버전이 남긴 별도 usage 이벤트. 정산 비용과 다르면 어느 쪽이 맞는지 알 수 없다.
      usageByIdUsd.set(id, (usageByIdUsd.get(id) ?? 0) + event.actualUsd);
      continue;
    }

    if (!TERMINAL.has(event.type) && event.type !== "reservation_unresolved") continue;

    if (id === undefined) {
      problems.push(`${event.type} 이벤트에 correlationId가 없습니다`);
      continue;
    }
    const view = byId.get(id);
    if (!view) {
      // opened 없이 terminal — 파일이 잘린 것이 아니라 순서가 깨진 것이다.
      problems.push(`${id}: reservation_opened 없이 ${event.type}이 있습니다`);
      continue;
    }
    const seen = terminals.get(id) ?? [];
    if (seen.length > 0) {
      problems.push(
        `${id}: 종결 이벤트가 두 번 이상입니다 (${[...seen, event.type].join(" + ")}) — ` +
          `한 예약은 정산 또는 해제 중 하나로만 끝나야 합니다`
      );
      continue;
    }
    terminals.set(id, [...seen, event.type]);

    if (typeof event.reservedUsd === "number" && Math.abs(event.reservedUsd - view.reservedUsd) > 1e-9) {
      view.problems.push(
        `종결 이벤트의 예약액 $${event.reservedUsd}가 개시 이벤트의 $${view.reservedUsd}와 다릅니다`
      );
    }

    if (event.type === "reservation_settled") {
      if (typeof event.actualUsd !== "number" || !Number.isFinite(event.actualUsd) || event.actualUsd < 0) {
        view.problems.push(`정산 이벤트의 실제 비용이 유효한 수가 아닙니다 (${String(event.actualUsd)})`);
        view.outcome = "unresolved";
        continue;
      }
      view.outcome = "settled";
      view.actualUsd = event.actualUsd;
      continue;
    }
    if (event.type === "reservation_released") {
      view.outcome = "released";
      continue;
    }
    view.outcome = "unresolved";
    view.problems.push(event.reason ?? "과금 여부를 확정할 수 없는 상태로 종료되었습니다");
  }

  // provider usage 이벤트와 정산 비용의 일치 확인.
  for (const [id, usageUsd] of usageByIdUsd) {
    const view = byId.get(id);
    if (!view) {
      problems.push(`${id}: reservation_opened 없이 provider_usage_recorded가 있습니다`);
      continue;
    }
    if (view.outcome === "settled" && Math.abs((view.actualUsd ?? 0) - usageUsd) > 1e-9) {
      view.problems.push(
        `provider usage 이벤트의 비용 $${usageUsd.toFixed(6)}가 정산 비용 ` +
          `$${(view.actualUsd ?? 0).toFixed(6)}와 다릅니다`
      );
    }
  }

  let settledUsd = 0;
  let unresolvedUsd = 0;
  for (const view of byId.values()) {
    if (view.outcome === "settled") settledUsd += view.actualUsd ?? 0;
    if (view.outcome === "open" || view.outcome === "unresolved") {
      unresolvedUsd += view.reservedUsd;
      view.problems.push(
        view.outcome === "open"
          ? "종결 이벤트가 없습니다 — 공급자가 이 요청을 처리하고 과금했을 수 있습니다"
          : "과금 여부가 확정되지 않았습니다"
      );
    }
    for (const problem of view.problems) problems.push(`${view.correlationId}: ${problem}`);
  }

  return { reservations: [...byId.values()], settledUsd, unresolvedUsd, problems };
}

export type ReconcileOutcome =
  | { ok: true; analysis: EventAnalysis }
  | { ok: false; status: BudgetBlockedStatus; reasons: string[]; analysis: EventAnalysis };

/**
 * 기록 파일과 이벤트 원장이 같은 사실을 말하는지 확인한다.
 *
 * **불일치하면 한쪽을 골라 계속하지 않는다.** 어느 쪽이 맞는지 코드가 알 수 없고, 틀린 쪽을
 * 믿으면 한도를 넘겨 쓰거나 남은 예산을 잃는다. 사용자가 확인해야 하는 상태다.
 *
 * 허용 오차를 두는 이유: 부동소수 합산 순서 차이로 마지막 자리가 흔들릴 수 있다.
 * 센트의 100분의 1보다 작은 차이는 같은 값으로 본다.
 */
export function reconcileBudget(input: {
  recordsUsd: number;
  events: readonly BudgetEvent[];
  /** 잘린 마지막 줄이 있었는가. 정산 이벤트가 유실됐을 수 있으므로 열린 예약과 같이 다룬다. */
  truncatedLastLine?: boolean;
}): ReconcileOutcome {
  const analysis = analyzeBudgetEvents(input.events);
  const reasons: string[] = [...analysis.problems];

  if (input.truncatedLastLine) {
    reasons.push(
      "예산 이벤트 파일의 마지막 줄이 잘려 있습니다 — 정산 이벤트가 유실됐을 수 있으므로 " +
        "합계를 신뢰할 수 없습니다"
    );
  }

  if (input.events.length === 0) {
    // 이 기능 이전에 만든 실행 디렉터리. 이벤트가 없다는 것은 불일치가 아니다.
    return { ok: true, analysis };
  }

  if (reasons.length === 0) {
    const delta = Math.abs(analysis.settledUsd - input.recordsUsd);
    if (delta > 0.0001) {
      return {
        ok: false,
        status: "BLOCKED_RECORD_EVENT_MISMATCH",
        analysis,
        reasons: [
          `예산 이벤트의 정산 합계 $${analysis.settledUsd.toFixed(4)}와 기록 파일의 비용 합계 ` +
            `$${input.recordsUsd.toFixed(4)}가 다릅니다 (차이 $${delta.toFixed(4)}). ` +
            `어느 쪽이 맞는지 알 수 없으므로 재개하지 않습니다 — 두 파일을 확인하세요.`,
        ],
      };
    }
    return { ok: true, analysis };
  }

  const hasUnresolved = analysis.reservations.some((r) => r.outcome === "open" || r.outcome === "unresolved");
  return {
    ok: false,
    status: hasUnresolved || input.truncatedLastLine
      ? "BLOCKED_UNRESOLVED_RESERVATION"
      : "BLOCKED_INVALID_BUDGET_EVENTS",
    analysis,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 상태 조회 (read-only)
// ---------------------------------------------------------------------------

export interface BudgetStatusReport {
  runDir: string;
  approvedLimitUsd?: number;
  /** 기록 파일에서 복원한 확정 비용. 복원 불가면 undefined. */
  recordsCommittedUsd?: number;
  /** 이벤트 원장의 정산 합계. **비용의 정본이다.** */
  eventsSettledUsd?: number;
  unresolvedUsd: number;
  openReservations: ReservationView[];
  settledReservations: number;
  releasedReservations: number;
  recordsAndEventsAgree: boolean;
  resumable: boolean;
  blockedStatus?: BudgetBlockedStatus;
  reasons: string[];
}

/**
 * 실행 디렉터리의 예산 상태를 **읽기만** 한다 (§1).
 *
 * # 왜 자동 복구 명령을 만들지 않는가
 *
 * "열린 예약을 정리한다"는 명령은 결국 "과금됐을 수 있는 돈을 안 쓴 것으로 만든다"는 뜻이다.
 * 그 판단은 공급자 콘솔의 실제 청구를 봐야 할 수 있고, 코드가 대신할 수 없다. 잘못 쓰기 쉬운
 * 위험한 명령을 두는 것보다, 무엇이 남았는지 정확히 보여주고 사람이 결정하게 하는 편이 낫다.
 */
export function budgetStatus(input: {
  runDir: string;
  records: readonly GateRunRecord[];
  eventRead: EventReadOutcome;
  approvedLimitUsd?: number;
}): BudgetStatusReport {
  const reasons: string[] = [];
  if (!input.eventRead.ok) {
    return {
      runDir: input.runDir,
      ...(input.approvedLimitUsd !== undefined ? { approvedLimitUsd: input.approvedLimitUsd } : {}),
      unresolvedUsd: 0,
      openReservations: [],
      settledReservations: 0,
      releasedReservations: 0,
      recordsAndEventsAgree: false,
      resumable: false,
      blockedStatus: input.eventRead.status,
      reasons: input.eventRead.reasons,
    };
  }

  const recovery = recoverSpendFromRecords(input.records);
  const recordsUsd = recovery.ok ? recovery.spend.historicalUsd : undefined;
  if (!recovery.ok) reasons.push(...recovery.reasons);

  const reconciled = reconcileBudget({
    recordsUsd: recordsUsd ?? 0,
    events: input.eventRead.events,
    truncatedLastLine: input.eventRead.truncatedLastLine,
  });
  if (!reconciled.ok) reasons.push(...reconciled.reasons);

  const analysis = reconciled.analysis;
  const coverage = approvalCoversHistorical(input.approvedLimitUsd, recordsUsd ?? 0);
  if (!coverage.ok) reasons.push(coverage.reason);

  const blockedStatus: BudgetBlockedStatus | undefined = !recovery.ok
    ? recovery.status
    : !reconciled.ok
      ? reconciled.status
      : undefined;

  return {
    runDir: input.runDir,
    ...(input.approvedLimitUsd !== undefined ? { approvedLimitUsd: input.approvedLimitUsd } : {}),
    ...(recordsUsd !== undefined ? { recordsCommittedUsd: recordsUsd } : {}),
    ...(input.eventRead.events.length > 0 ? { eventsSettledUsd: analysis.settledUsd } : {}),
    unresolvedUsd: analysis.unresolvedUsd,
    openReservations: analysis.reservations.filter((r) => r.outcome === "open" || r.outcome === "unresolved"),
    settledReservations: analysis.reservations.filter((r) => r.outcome === "settled").length,
    releasedReservations: analysis.reservations.filter((r) => r.outcome === "released").length,
    recordsAndEventsAgree: reconciled.ok,
    resumable: recovery.ok && reconciled.ok && coverage.ok,
    ...(blockedStatus !== undefined ? { blockedStatus } : {}),
    reasons,
  };
}

export function renderBudgetStatus(report: BudgetStatusReport): string[] {
  const money = (v: number | undefined): string => (v === undefined ? "(알 수 없음)" : `$${v.toFixed(6)}`);
  const lines: string[] = [];
  lines.push("=== 예산 상태 (읽기 전용, API 호출 없음) ===");
  lines.push(`실행 디렉터리: ${report.runDir}`);
  lines.push(`승인 상한: ${report.approvedLimitUsd === undefined ? "(이 조회에 지정되지 않음)" : `$${report.approvedLimitUsd}`}`);
  lines.push(`기록 파일 확정 비용: ${money(report.recordsCommittedUsd)}`);
  lines.push(`이벤트 원장 정산 합계(정본): ${money(report.eventsSettledUsd)}`);
  lines.push(`records/events 일치: ${report.recordsAndEventsAgree ? "일치" : "불일치"}`);
  lines.push(`정산된 예약: ${report.settledReservations}건 / 해제된 예약: ${report.releasedReservations}건`);
  lines.push(`미해결 예약: ${report.openReservations.length}건, 합계 ${money(report.unresolvedUsd)}`);
  for (const open of report.openReservations) {
    lines.push(`  - ${open.correlationId}`);
    lines.push(`      예약액 $${open.reservedUsd.toFixed(6)} / 상태 ${open.outcome}`);
    lines.push(`      실행 ${open.runId} / 단계 ${open.stage} / 개시 ${open.openedAt}`);
  }
  lines.push("");
  lines.push(`재개 가능: ${report.resumable ? "가능" : "불가"}`);
  if (report.blockedStatus) lines.push(`상태 코드: ${report.blockedStatus}`);
  if (report.reasons.length > 0) {
    lines.push("");
    lines.push("사용자가 확인해야 하는 것:");
    for (const reason of report.reasons) lines.push(`  - ${reason}`);
  }
  if (report.openReservations.length > 0) {
    lines.push("");
    lines.push("미해결 예약은 **자동으로 정리하지 않습니다.** 그 요청이 실제로 과금됐는지는");
    lines.push("공급자 콘솔의 청구 내역으로만 확인할 수 있고, 코드가 대신 판단하면 사용자 돈이");
    lines.push("새거나 남은 예산을 잃습니다. 확인 후 새 --output 디렉터리로 시작하거나,");
    lines.push("실제 청구액을 반영한 상한을 새로 승인하세요.");
  }
  return lines;
}
