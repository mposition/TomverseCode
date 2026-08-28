/**
 * Fleet 시작 폼 — **보내기 전에 말하는 것**(ui-wireframes 3.30절).
 *
 * # 이 모듈이 판정하지 않는다
 *
 * 크기 상한도, 브랜치 이름 규칙도, 예산의 짝 조건도 **Rust가 정하고 거부한다**
 * (`fleet::plan`). 여기 있는 것은 그 거부를 **미리 말하는 것**뿐이고, 두 곳이 어긋나면
 * 이기는 쪽은 언제나 Rust다 — 화면이 통과시킨 것을 호스트가 거절하면 그 문장이 그대로 뜬다.
 *
 * 그래도 미리 말하는 이유는 하나다: **화면이 상한보다 큰 값을 받아 놓고 나중에 거부하면 안
 * 된다.** 구성원 열둘을 적어 넣고 시작을 누른 뒤에 "최대 여덟"을 듣는 것은, 사용자가 넷을
 * 지우기 전에 이미 열둘을 적었다는 뜻이다.
 *
 * # 상한 숫자를 여기 적지 않는다
 *
 * `maxFleetSize`는 **Rust가 보내준 값**이다(`fleet_status`). 여기 `8`을 적으면 상한이 두
 * 벌이 되고, 두 벌은 갈라진다 — 그리고 갈라진 화면은 자기가 아는 숫자를 자신 있게 말한다.
 * 그 값을 받지 못했으면(`null`) 크기를 판정하지 않는다: **모르는 것을 통과로도 실패로도
 * 접지 않는다.**
 */

import { budgetArgs } from "./budgetArgs.js";

export interface FleetMemberDraft {
  branch: string;
  message: string;
}

export interface FleetDraftInput {
  members: readonly FleetMemberDraft[];
  /** Rust가 보내준 크기 상한. `null`이면 아직 받지 못했다 — 그때는 크기를 판정하지 않는다. */
  maxFleetSize: number | null;
  /** 태스크당 상한 입력(원문). */
  perTaskText: string;
  /** 합계 상한 입력(원문). */
  fleetCapText: string;
}

export interface FleetDraftView {
  /** 실제로 보낼 구성원 — 양쪽이 다 비어 있는 줄은 **입력하지 않은 줄**이므로 뺀다. */
  members: FleetMemberDraft[];
  /** 시작을 누를 수 있는가. 거짓이면 아래 `problems`가 왜인지 말한다. */
  canStart: boolean;
  /** 지금 보내면 Rust가 거부할 것들. */
  problems: string[];
  /** 거부는 아니지만 사용자가 알아야 하는 것들. */
  notices: string[];
  /** 화면이 더 넣을 수 있는 줄 수. 상한을 모르면 `null`. */
  remainingSlots: number | null;
}

function isBlank(row: FleetMemberDraft): boolean {
  return row.branch.trim().length === 0 && row.message.trim().length === 0;
}

export function reviewFleetDraft(input: FleetDraftInput): FleetDraftView {
  const members = input.members
    .filter((row) => !isBlank(row))
    .map((row) => ({ branch: row.branch.trim(), message: row.message.trim() }));

  const problems: string[] = [];
  const notices: string[] = [];

  if (members.length === 0) {
    // 빈 Fleet을 성공으로 돌려주면 "돌았는데 아무 일도 없었다"가 된다(`fleet::plan`).
    problems.push("구성원이 없습니다. 브랜치와 요청을 한 줄 이상 적으세요.");
  }
  if (input.maxFleetSize !== null && members.length > input.maxFleetSize) {
    problems.push(
      `구성원이 ${members.length}개입니다 — 최대 ${input.maxFleetSize}개입니다. ` +
        `상한이 없으면 오타 하나가 비용과 프로세스를 동시에 폭발시킵니다.`
    );
  }

  const seen = new Set<string>();
  for (const member of members) {
    if (member.branch.length === 0) {
      problems.push("브랜치 이름이 빈 구성원이 있습니다.");
    } else if (seen.has(member.branch)) {
      // 같은 브랜치가 둘이면 두 구성원이 같은 트리를 쓴다 — **격리가 아니게 된다.**
      problems.push(`브랜치 ${member.branch}가 두 번 있습니다 — 두 구성원이 같은 트리를 쓰면 격리가 아닙니다.`);
    } else {
      seen.add(member.branch);
    }
    if (member.message.length === 0) {
      problems.push(`${member.branch || "이름 없는 구성원"}에 요청 내용이 없습니다.`);
    }
  }

  const perTask = budgetArgs(input.perTaskText);
  const fleetCap = budgetArgs(input.fleetCapText);
  const perTaskUsd = perTask.budgetUnlimited ? null : perTask.budgetUsd;
  const fleetCapUsd = fleetCap.budgetUnlimited ? null : fleetCap.budgetUsd;

  if (perTaskUsd !== null && (!Number.isFinite(perTaskUsd) || perTaskUsd <= 0)) {
    problems.push("태스크당 상한이 수가 아닙니다. 비워 두면 상한이 없습니다.");
  }
  if (fleetCapUsd !== null && (!Number.isFinite(fleetCapUsd) || fleetCapUsd <= 0)) {
    problems.push("합계 상한이 수가 아닙니다. 비워 두면 상한이 없습니다.");
  }

  if (fleetCapUsd !== null && perTaskUsd === null) {
    // **합계 상한은 태스크당 상한을 요구한다.** 구성원 하나가 얼마를 쓸지 모르면 예약할
    // 금액이 없고, 그러면 "합계 상한이 있다"는 말이 거짓이 된다.
    problems.push(
      "합계 상한을 걸려면 태스크당 상한도 있어야 합니다. 구성원 하나가 얼마를 쓸지 모르면 " +
        "예약할 금액이 없고, 그러면 합계 상한은 지켜지지 않습니다."
    );
  }
  if (
    fleetCapUsd !== null &&
    perTaskUsd !== null &&
    Number.isFinite(fleetCapUsd) &&
    Number.isFinite(perTaskUsd) &&
    perTaskUsd > fleetCapUsd
  ) {
    problems.push(
      `합계 상한($${fleetCapUsd})이 태스크당 상한($${perTaskUsd})보다 작아 어떤 구성원도 시작할 수 없습니다.`
    );
  }

  if (fleetCapUsd === null) {
    // **"상한 안에서 끝났다"와 "상한이 없었다"는 정반대의 사실이다.** 시작 전에도 같다.
    notices.push(
      perTaskUsd === null
        ? "이 Fleet에는 상한이 없습니다. 구성원 수만큼 비용이 나갑니다."
        : `태스크당 상한 $${perTaskUsd}은 구성원 **각각**에 걸립니다 — 합계는 그만큼 곱해집니다. ` +
            `총지출을 막으려면 합계 상한을 함께 거세요.`
    );
  }

  return {
    members,
    canStart: problems.length === 0,
    problems,
    notices,
    remainingSlots: input.maxFleetSize === null ? null : Math.max(input.maxFleetSize - members.length, 0),
  };
}
