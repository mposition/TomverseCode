/**
 * Fleet 합계 지출 — **태스크 단위에서 Fleet 단위로 올라가는 자리**
 * (process-architecture.md 11.6②).
 *
 * # 무엇이 문제였나
 *
 * `BudgetPanel`은 지금도 정확히 이렇게 말한다: *"상한은 **이 작업 하나**에만 적용됩니다."*
 * 태스크가 하나뿐일 때 그 문장은 참이면서 충분하다. N개가 동시에 돌면 **참이지만 답이
 * 아니게 된다** — 사용자가 실제로 부담하는 것은 N배인데 화면은 그중 하나를 보여준다.
 *
 * # 그래서 이 모듈이 하는 일
 *
 * 구성원별 금액을 합치는 것이 전부가 아니다. **그 합계가 무엇의 합인지 말하는 문장**을 함께
 * 만든다. 숫자만 크게 그리면 사용자는 그것을 "이 작업의 비용"으로 읽고, 그러면 태스크 단위
 * 화면보다 더 틀린 화면이 된다.
 *
 * # 계산이 화면 안에 있으면 검증할 방법이 없다
 *
 * 그래서 순수 함수다(`src/lib`의 규칙). 화면은 이 결과를 그리기만 한다.
 */

export interface FleetMemberSpend {
  branch: string;
  /** 이 구성원 하나의 지출. **합계가 아니다.** */
  costUsd: number;
  /**
   * `completed` | `failed` | `cancelled` | `rejected` | `interrupted` | `not_started` | `running` | `unknown`
   *
   * **판정은 Rust가 한다**(`fleet::member_status`). 화면이 `finalStatus`를 다시 해석하면
   * "시작조차 못 한 것"과 "거부된 것"이 다시 뭉쳐진다 — 사용자가 다음에 할 일이 다른데도.
   */
  status: string;
  /** 가격을 모르는 모델로 나간 호출 수. 있으면 그 구성원의 금액은 **하한이다.** */
  unpricedCalls?: number;
}

export interface FleetSpendInput {
  members: readonly FleetMemberSpend[];
  /** Fleet **합계** 상한. `null`이면 합계 상한이 없었다. */
  fleetCapUsd: number | null;
  /** 태스크당 상한. `null`이면 태스크당 상한이 없었다. */
  perTaskCapUsd: number | null;
}

export interface FleetSpendView {
  /** 구성원 지출의 합. */
  fleetCostUsd: number;
  /** 이 숫자가 실제 청구의 **하한**인가 (가격을 모르는 호출이 있었다). */
  approximate: boolean;
  memberCount: number;
  /** 시작조차 하지 않은 구성원 수. **실패와 다른 결말이다.** */
  notStartedCount: number;
  /** 아직 도는 구성원 수. **결말이 아니다** — 이걸 완료로도 실패로도 세지 않는다. */
  runningCount: number;
  /** 완료되지 않은 구성원 수(진행 중·실패·취소·거부·미시작 전부). */
  unfinishedCount: number;
  /** 합계 상한을 실제로 강제했는가. */
  capEnforced: boolean;
  /**
   * 화면이 **반드시 말해야 하는 문장들**. 첫 줄은 언제나 "이것은 합계다"이다 —
   * 그 문장이 없으면 큰 숫자 하나가 태스크 하나의 비용으로 읽힌다.
   */
  notices: string[];
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function summarizeFleetSpend(input: FleetSpendInput): FleetSpendView {
  const members = input.members;
  const fleetCostUsd = members.reduce((sum, m) => sum + (Number.isFinite(m.costUsd) ? m.costUsd : 0), 0);
  const approximate = members.some((m) => (m.unpricedCalls ?? 0) > 0);
  const notStartedCount = members.filter((m) => m.status === "not_started").length;
  const runningCount = members.filter((m) => m.status === "running").length;
  const unfinishedCount = members.filter((m) => m.status !== "completed").length;
  const capEnforced = input.fleetCapUsd !== null;

  const notices: string[] = [
    `${approximate ? "≥ " : ""}${money(fleetCostUsd)}는 구성원 ${members.length}개의 합계입니다 — ` +
      `어느 한 작업의 금액이 아닙니다.`,
  ];

  if (capEnforced) {
    notices.push(
      `Fleet 합계 상한 $${(input.fleetCapUsd as number).toFixed(2)}을 강제했습니다` +
        (input.perTaskCapUsd !== null ? ` (작업당 상한 $${input.perTaskCapUsd.toFixed(2)})` : "") +
        `. 남은 예산으로 작업 하나를 예약할 수 없으면 새 작업을 시작하지 않습니다.`
    );
  } else {
    // **"상한 안에서 끝났다"와 "상한이 없었다"는 정반대의 사실이다** — `BudgetPanel`과 같은 규율.
    notices.push(
      `이 Fleet에는 합계 상한이 없었습니다. 위 금액은 집계한 지출이며, 무언가가 그것을 막고 있었다는 뜻이 아닙니다.` +
        (input.perTaskCapUsd !== null
          ? ` 작업당 상한 $${input.perTaskCapUsd.toFixed(2)}은 걸려 있었지만, 그것은 ${members.length}개가 각각 지킨 상한이므로 합계를 통제하지 않습니다.`
          : "")
    );
  }

  if (approximate) {
    notices.push("가격을 모르는 모델로 나간 호출이 있어 위 금액은 실제 청구의 하한입니다.");
  }
  if (notStartedCount > 0) {
    // **사유를 단정하지 않는다.** 미시작은 합계 상한이 남지 않은 경우와 Fleet이 취소된
    // 경우 둘 다이고, 여기서 앞엣것으로 단정하면 취소한 사용자에게 예산 이야기를 한다.
    notices.push(
      `${notStartedCount}개 작업은 **시작되지 않았습니다**(합계 상한이 남지 않았거나 Fleet이 취소되었습니다) — ` +
        `실패와 다른 결말입니다.`
    );
  }
  if (runningCount > 0) {
    // **아직 끝나지 않은 것을 결말로 접지 않는다.** 위 금액도 그만큼 아직 자란다.
    notices.push(
      `${runningCount}개 작업이 아직 돌고 있습니다 — 위 금액은 지금까지의 합계이며 아직 늘어납니다.`
    );
  }

  return {
    fleetCostUsd,
    approximate,
    memberCount: members.length,
    notStartedCount,
    runningCount,
    unfinishedCount,
    capEnforced,
    notices,
  };
}

/**
 * 결말을 **개별로** 센다.
 *
 * N개 중 3개가 실패했을 때 화면이 "완료"로 접으면 이 제품이 파는 것을 파는 행위다. 그래서
 * "완료"는 **전부 완료됐을 때만** 참이다.
 */
export interface FleetOutcomeSummary {
  allCompleted: boolean;
  /** 아직 결말이 없는 구성원이 있는가. **"완료가 아니다"와 다른 사실이다.** */
  stillRunning: boolean;
  counts: Record<string, number>;
  /** 화면 배지에 그대로 쓰는 한 줄. */
  headline: string;
}

/** 사람이 읽는 이름. **모르는 값은 지우지 않고 그대로 센다** — 지우면 개수가 구성원 수와 어긋난다. */
const OUTCOME_LABELS: Record<string, string> = {
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  rejected: "거부",
  interrupted: "중단됨",
  not_started: "미시작",
  running: "진행 중",
  unknown: "알 수 없음",
};

export function summarizeFleetOutcome(members: readonly FleetMemberSpend[]): FleetOutcomeSummary {
  const counts: Record<string, number> = {};
  for (const member of members) counts[member.status] = (counts[member.status] ?? 0) + 1;
  const completed = counts.completed ?? 0;
  const allCompleted = members.length > 0 && completed === members.length;
  const stillRunning = (counts.running ?? 0) > 0;

  // **자주 쓰는 다섯은 0이어도 적는다** — 화면의 칸이 실행마다 달라지면 사용자가 그 줄을
  // 읽는 법을 배울 수 없다. 나머지는 실제로 있을 때만 는다.
  const always = ["completed", "failed", "cancelled", "rejected", "not_started"];
  const extra = Object.keys(counts)
    .filter((status) => !always.includes(status))
    .sort();
  const parts = [...always, ...extra].map(
    (status) => `${OUTCOME_LABELS[status] ?? status} ${counts[status] ?? 0}`
  );
  return {
    allCompleted,
    stillRunning,
    counts,
    headline: allCompleted ? `${members.length}개 모두 완료` : parts.join(" · "),
  };
}
