import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BudgetEvent } from "@tomverse/sidecar/budget";
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
 * # 왜 fail closed인가
 *
 * 복원값이 수상하면 "0으로 보고 계속"이 가장 위험하다 — 그 순간 한도가 사라진다. 그래서
 * 비용을 확정할 수 없는 유료 기록이 하나라도 있으면 재개를 막는다. 사용자가 원장을 확인하고
 * 새 디렉터리로 시작하거나 상한을 다시 승인하는 것이 옳은 다음 행동이다.
 */

export const BUDGET_EVENTS_FILE = "budget-events.jsonl";

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
  | { ok: false; reasons: string[] };

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

  if (reasons.length > 0) return { ok: false, reasons };
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

export function readBudgetEvents(runDir: string, fileName: string = BUDGET_EVENTS_FILE): BudgetEvent[] {
  const file = budgetEventsPath(runDir, fileName);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const events: BudgetEvent[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      events.push(JSON.parse(lines[i]!) as BudgetEvent);
    } catch (error) {
      // 마지막 줄이 잘린 것은 정상적인 중단 흔적이다. 중간 줄이 깨졌으면 그건 다른 문제다.
      if (i === lines.length - 1) break;
      throw new Error(`예산 이벤트 ${i + 1}번째 줄이 손상되었습니다: ${String(error)}`);
    }
  }
  return events;
}

/**
 * 이벤트 원장과 기록 파일의 누적 비용이 일치하는지 확인한다.
 *
 * **불일치하면 한쪽을 골라 계속하지 않는다.** 어느 쪽이 맞는지 코드가 알 수 없고, 틀린 쪽을
 * 믿으면 한도를 넘겨 쓰거나 남은 예산을 잃는다. 사용자가 확인해야 하는 상태다.
 *
 * 허용 오차를 두는 이유: 부동소수 합산 순서 차이로 마지막 자리가 흔들릴 수 있다.
 * 센트의 100분의 1보다 작은 차이는 같은 값으로 본다.
 */
export function reconcile(
  recordsUsd: number,
  events: readonly BudgetEvent[]
): { ok: true } | { ok: false; reason: string } {
  const settled = events
    .filter((e) => e.type === "reservation_settled")
    .reduce((sum, e) => sum + (e.actualUsd ?? 0), 0);
  if (events.length === 0) return { ok: true };
  const delta = Math.abs(settled - recordsUsd);
  if (delta > 0.0001) {
    return {
      ok: false,
      reason:
        `예산 이벤트의 정산 합계 $${settled.toFixed(4)}와 기록 파일의 비용 합계 ` +
        `$${recordsUsd.toFixed(4)}가 다릅니다 (차이 $${delta.toFixed(4)}). ` +
        `어느 쪽이 맞는지 알 수 없으므로 재개하지 않습니다 — 두 파일을 확인하세요.`,
    };
  }
  return { ok: true };
}
