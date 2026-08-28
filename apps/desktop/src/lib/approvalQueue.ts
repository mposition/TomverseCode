/**
 * 승인 큐 — **여러 요청이 동시에 밀려 있을 때 무엇을 그리는가**
 * (process-architecture.md 11.6①, ui-wireframes.md 3.3절).
 *
 * # 무엇이 문제였나
 *
 * 승인 모달은 하나다. 태스크가 하나뿐일 때는 그것으로 충분했다 — 밀릴 것이 없기 때문이다.
 * Fleet에서는 N개가 동시에 승인을 요구하고, 그때 화면이 "3개 대기 중"이라고 쓰고 하나만
 * 보여주면 **사용자는 자기가 지금 어느 트리의 명령을 승인하는지 알 수 없다.**
 *
 * 원칙 6은 "승인 화면에 보인 argv가 실제 실행되는 것과 같다"를 약속한다. 그런데 **같은
 * argv라도 대상 트리가 다르면 다른 동작**이므로, 트리가 빠지면 그 약속은 절반만 성립한다.
 * `npm run migrate` 세 개가 나란히 떠 있을 때 어느 것이 어느 브랜치의 것인지 구별되지 않으면,
 * 사용자는 사실상 무작위로 승인하는 것이다.
 *
 * # 그래서 구별은 경로가 아니라 **자리**로 한다
 *
 * 트리 경로는 서로 한 글자만 다르고(`tomverse-feat-a` / `tomverse-feat-b`) 화면에서 길이도
 * 비슷하다. Rust가 실어 보내는 `origin`(몇 번째 구성원, 어느 브랜치)이 사람이 실제로 읽을 수
 * 있는 구별이다. **경로도 함께 보여주되** 그건 근거이지 구별이 아니다.
 */

// **타입을 두 벌로 두지 않는다.** 승인 요청의 모양은 Rust가 정하고 화면의 계약은
// `types.ts` 하나다 — 여기 같은 이름의 두 번째 정의가 있으면 필드가 하나 늘 때 한쪽만
// 갱신되고, 갈라진 쪽을 쓰는 화면이 조용히 옛 모양을 그린다.
import type { ApprovalOrigin } from "../types";

export type { ApprovalOrigin };

export interface PendingApproval {
  approvalId: string;
  taskId: string;
  /** Policy Gate가 제한하는 바로 그 루트. */
  workspaceRoot: string;
  origin?: ApprovalOrigin;
  createdAt: string;
}

export interface ApprovalQueueEntry {
  approvalId: string;
  taskId: string;
  workspaceRoot: string;
  /** 화면이 그리는 짧은 구별 — "2/4 · feat-b". Fleet이 아니면 워크스페이스 이름이다. */
  label: string;
  /** 큐에서 몇 번째인가(1부터). 0이 아닌 이유: 화면에 그대로 나가는 숫자다. */
  position: number;
  /** 지금 모달이 그리고 있는 것인가. */
  active: boolean;
}

export interface ApprovalQueueView {
  entries: ApprovalQueueEntry[];
  /** 지금 답해야 하는 것. 큐가 비면 `undefined`. */
  active?: ApprovalQueueEntry;
  waiting: number;
  /**
   * 큐가 **서로 다른 트리**를 담고 있는가.
   *
   * 참이면 화면은 트리 표시를 숨길 수 없다 — 같은 명령이 두 저장소에 대해 떠 있을 수 있고,
   * 그때 트리를 지우면 원칙 6의 약속이 깨진다.
   */
  spansMultipleRoots: boolean;
  notices: string[];
}

function lastSegment(root: string): string {
  const parts = root.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? root;
}

function labelFor(approval: PendingApproval): string {
  if (approval.origin) {
    return `${approval.origin.memberIndex}/${approval.origin.fleetSize} · ${approval.origin.branch}`;
  }
  return lastSegment(approval.workspaceRoot);
}

/**
 * 큐를 만든다. **도착 순서대로** 답한다.
 *
 * 다른 순서(위험도순 등)를 쓰지 않는 이유: 승인을 기다리는 태스크는 그동안 멈춰 있고,
 * 순서를 우리가 정하면 어떤 태스크는 계속 뒤로 밀린다. 그리고 사용자가 방금 본 것이 다음에
 * 뜨는 것과 다르면 연타로 잘못 승인하기 쉬워진다.
 */
export function buildApprovalQueue(pending: readonly PendingApproval[]): ApprovalQueueView {
  const sorted = [...pending].sort((a, b) =>
    a.createdAt === b.createdAt ? a.approvalId.localeCompare(b.approvalId) : a.createdAt.localeCompare(b.createdAt)
  );
  const entries: ApprovalQueueEntry[] = sorted.map((approval, i) => ({
    approvalId: approval.approvalId,
    taskId: approval.taskId,
    workspaceRoot: approval.workspaceRoot,
    label: labelFor(approval),
    position: i + 1,
    active: i === 0,
  }));

  const roots = new Set(entries.map((e) => e.workspaceRoot));
  const spansMultipleRoots = roots.size > 1;
  const notices: string[] = [];
  if (entries.length > 1) {
    notices.push(
      `승인 요청 ${entries.length}건이 밀려 있습니다. 도착한 순서대로 하나씩 답합니다 — ` +
        `답하기 전까지 그 작업들은 멈춰 있습니다.`
    );
  }
  if (spansMultipleRoots) {
    // **같은 argv라도 대상 트리가 다르면 다른 동작이다.**
    notices.push(
      `이 요청들은 서로 다른 작업 트리의 것입니다. 명령이 같아 보여도 실행되는 곳이 다르므로, ` +
        `승인하기 전에 어느 트리인지 확인하세요.`
    );
  }

  return {
    entries,
    active: entries[0],
    waiting: Math.max(entries.length - 1, 0),
    spansMultipleRoots,
    notices,
  };
}

/**
 * 지금 화면이 붙어 있는 루트들 — **응답이 이 목록 안의 것일 때만 전달된다**(`approvals.rs`).
 *
 * 화면이 이 목록을 만들 때 자기가 그리고 있는 것만 넣어야 한다. 넓게 잡으면(예: "전부")
 * 낡은 모달에서 누른 승인이 사용자가 보고 있지 않은 저장소에서 명령을 돌린다 — 11.5절이
 * 닫은 구멍이 그것이다.
 */
export function activeRootsFor(queue: ApprovalQueueView): string[] {
  return [...new Set(queue.entries.map((e) => e.workspaceRoot))];
}
