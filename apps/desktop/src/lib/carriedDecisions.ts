/**
 * 세션 판정 목록을 **화면 문장으로** 옮긴다 — state-machine 30절.
 *
 * # 이 자리에서 하기 쉬운 거짓말 셋
 *
 * ① **거둔 것을 목록에서 지우는 것.** 지우면 "사라졌다"와 "거뒀다"가 화면에서 같은 모양이 되고,
 *    사용자는 자기가 무엇을 거뒀는지 확인할 수 없다.
 *
 * ② **거둘 수 없는 이유를 "안 됨"으로 뭉개는 것.** 이유마다 사용자가 다음에 할 일이 다르다 —
 *    진행 중이면 기다리면 되고, 이미 거둔 것이면 할 일이 없다.
 *
 * ③ **철회를 "삭제"라고 부르는 것.** 지워지지 않는다. 그 태스크의 기준 기록은 남고, 바뀌는 것은
 *    다음 태스크로 나르는가 하나다. "삭제"라고 쓰면 사용자는 감사 기록에서도 사라진다고 믿는다.
 *
 * # 판정 자체는 여기서 하지 않는다
 *
 * `withdrawable`과 `refusal`은 Rust가 정해서 보낸다(`decisions::list`). 여기서 다시 계산하면
 * 두 곳이 갈라지고, **갈라진 쪽이 느슨하면 화면이 허용한 것을 호스트가 거절한다.**
 */

export type Refusal = "not_found" | "already_withdrawn" | "task_still_running";

export interface DecisionRow {
  taskId: string;
  criterionId: string;
  text: string;
  decidedAt: string;
  withdrawnAt?: string;
  inForce: boolean;
  withdrawable: boolean;
  refusal?: Refusal;
}

export interface DecisionView extends DecisionRow {
  /** 지금 상태를 한 낱말로. */
  status: "in_force" | "withdrawn";
  /** 거둘 수 없다면 그 이유의 문장. 거둘 수 있으면 `null`. */
  blockedReason: string | null;
}

const REFUSAL_TEXT: Record<Refusal, string> = {
  not_found: "이 세션에 없는 판정입니다",
  already_withdrawn: "이미 거둔 판정입니다",
  task_still_running: "이 판정을 만든 태스크가 아직 진행 중입니다 — 끝난 뒤에 거둘 수 있습니다",
};

export function toViews(rows: DecisionRow[]): DecisionView[] {
  return rows.map((row) => ({
    ...row,
    status: row.inForce ? "in_force" : "withdrawn",
    blockedReason: row.refusal ? REFUSAL_TEXT[row.refusal] : null,
  }));
}

export interface DecisionSummary {
  /** 다음 태스크의 프롬프트에 실릴 개수. */
  inForce: number;
  /** 거둔 개수. **따로 센다** — 합쳐서 "N건"만 보이면 무엇이 실리는지 알 수 없다. */
  withdrawn: number;
  /** 화면 첫 줄. */
  headline: string;
}

export function summarize(rows: DecisionRow[]): DecisionSummary {
  const inForce = rows.filter((row) => row.inForce).length;
  const withdrawn = rows.length - inForce;
  if (rows.length === 0) {
    // **"0건이 실립니다"라고 쓰지 않는다.** 있었는데 전부 빠진 것처럼 읽힌다.
    return { inForce, withdrawn, headline: "이 세션에서 사용자가 정한 것이 아직 없습니다." };
  }
  const carried = `다음 태스크의 프롬프트에 ${inForce}건이 실립니다`;
  return {
    inForce,
    withdrawn,
    headline: withdrawn === 0 ? `${carried}.` : `${carried} (거둔 ${withdrawn}건은 실리지 않습니다).`,
  };
}

/**
 * 철회 결과를 문장으로. **"삭제했습니다"가 아니다.**
 */
export function describeWithdrawal(result: { withdrawn?: boolean; detail?: string }): string {
  if (result.withdrawn) {
    return "거뒀습니다. 다음 태스크부터 이 판정은 실리지 않습니다 — 이 판정을 만든 태스크의 기록은 그대로 남습니다.";
  }
  // 원인을 지어내지 않는다. 호스트가 사유를 줬으면 그대로 쓰고, 없으면 없다고 쓴다.
  return result.detail ?? "거두지 못했습니다 (사유가 기록되지 않았습니다).";
}
