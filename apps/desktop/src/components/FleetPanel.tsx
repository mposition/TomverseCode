import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { unwrap, type Envelope } from "../lib/envelope";
import { budgetArgs } from "../lib/budgetArgs";
import { reviewFleetDraft, type FleetMemberDraft } from "../lib/fleetDraft";
import { summarizeFleetOutcome, summarizeFleetSpend } from "../lib/fleetSpend";
import type { FleetStatus, FleetStatusView } from "../types";

/**
 * Fleet — **worktree 격리 기반 N개 병렬 실행**(product-strategy 8.2절, process-architecture 11.6절).
 *
 * # 이 화면이 반드시 말해야 하는 것
 *
 * ① **합계는 합계라고 말한다.** 한 숫자를 크게 그리면서 그것이 무엇의 합인지 말하지 않으면,
 *    그 숫자는 참이지만 답이 아니다(11.6②). 문장은 `fleetSpend.ts`가 만든다.
 * ② **부분 실패를 "완료"로 접지 않는다.** N개 중 셋이 실패하면 결말을 개별로 보여준다.
 * ③ **미시작은 실패가 아니다.** 사용자가 다음에 할 일이 다르다.
 *
 * # 상태를 폼에서 읽지 않는다
 *
 * 진행과 결말은 화면이 보낸 값이 아니라 **Rust가 고정한 이벤트에서 유도한 것**을 읽는다
 * (`fleet_status` → `fleet::collect_status`, state-machine 37절). 요청한 것과 적용된 것은
 * 갈릴 수 있다 — 합계 상한이 남지 않아 시작조차 못 한 구성원이 그렇다.
 *
 * 그래서 `fleet-event`는 **다시 읽으라는 신호**로만 쓴다. 이벤트에서 상태를 조립하면 앱을 다시
 * 켠 뒤에는 아무것도 말할 수 없고, 놓친 이벤트 하나가 화면을 영원히 어긋나게 만든다.
 */
export interface FleetPolicySwitches {
  mode: "fast" | "verified";
  allowGitCommit: boolean;
  unattended: boolean;
  autoApproveVerification: boolean;
  autoApproveWrites: boolean;
  deadlineSecs: number | null;
  modelPins?: { executor?: string; reviewer?: string };
}

export function FleetPanel({
  disabled,
  // **화면의 실행 스위치를 그대로 쓴다.** 여기에 두 번째 스위치 묶음을 만들면 사용자는
  // 어느 쪽이 적용되는지 알 수 없고, 두 벌은 갈라진다. 무엇이 적용됐는지는 끝난 뒤
  // "이 작업에 적용된 것"(3.23절)이 태스크마다 답한다.
  policy,
}: {
  disabled: boolean;
  policy: FleetPolicySwitches;
}) {
  const [rows, setRows] = useState<FleetMemberDraft[]>([
    { branch: "", message: "" },
    { branch: "", message: "" },
  ]);
  const [perTaskText, setPerTaskText] = useState("");
  const [fleetCapText, setFleetCapText] = useState("");
  const [status, setStatus] = useState<FleetStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<{ allCompleted: boolean; notices: string[] } | null>(null);

  const load = useCallback(() => {
    invoke<Envelope<FleetStatusView>>("fleet_status", { fleetId: null })
      .then((envelope) => {
        const read = unwrap(envelope);
        // **읽지 못한 것을 "Fleet이 없다"로 읽지 않는다.** 앞은 사실이고 뒤는 모른다는 뜻이다.
        if (read.ok) setStatus(read.value);
        else setError(read.problem.text);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    // 이벤트는 **다시 읽으라는 신호**다. 이벤트에서 상태를 조립하지 않는다 — 위 주석 참조.
    const unlisten = listen("fleet-event", () => load());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [load]);

  const draft = useMemo(
    () =>
      reviewFleetDraft({
        members: rows,
        // **상한은 Rust가 보내준 값이다.** 아직 못 받았으면 크기를 판정하지 않는다.
        maxFleetSize: status?.maxFleetSize ?? null,
        perTaskText,
        fleetCapText,
      }),
    [rows, status?.maxFleetSize, perTaskText, fleetCapText]
  );

  const runningId = status?.runningFleetId ?? null;
  const fleets = status?.fleets ?? [];

  const start = (): void => {
    setError(null);
    setResult(null);
    setStarting(true);
    const perTask = budgetArgs(perTaskText);
    const cap = budgetArgs(fleetCapText);
    invoke<{ allCompleted: boolean; notices: string[] }>("start_fleet", {
      members: draft.members,
      mode: policy.mode,
      allowGitCommit: policy.allowGitCommit,
      budgetUsd: perTask.budgetUsd,
      budgetUnlimited: perTask.budgetUnlimited,
      fleetBudgetUsd: cap.budgetUsd,
      fleetBudgetUnlimited: cap.budgetUnlimited,
      modelPins: policy.modelPins ?? null,
      unattended: policy.unattended,
      autoApproveVerification: policy.autoApproveVerification,
      autoApproveWrites: policy.autoApproveWrites,
      deadlineSecs: policy.deadlineSecs,
    })
      .then((value) => setResult({ allCompleted: value.allCompleted, notices: value.notices }))
      // **Rust가 거부한 문장을 그대로 낸다.** 화면이 다시 판정하면 두 규칙이 생긴다.
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setStarting(false);
        load();
      });
  };

  return (
    <div className="panel">
      <h3>Fleet — 여러 브랜치에서 동시에</h3>
      <p className="muted small">
        구성원마다 <strong>격리된 작업 트리</strong>를 하나씩 만들고 그 안에서 평범한 작업을 돌립니다. 승인은
        구성원마다 따로 뜨고, 도착한 순서대로 하나씩 답합니다.
        <br />
        구성원은 <strong>훅과 MCP 등록을 쓰지 않습니다</strong> — 헤드리스 <code>fleet</code>과 같습니다.
        <br />
        실행 스위치(실행 정책 · 커밋 · 무인 실행 · 자동 승인 · 시한)는 <strong>위에서 고른 것을 그대로
        씁니다</strong> — 구성원마다 따로 고르지 않습니다.
      </p>

      {rows.map((row, index) => (
        <div key={index} className="settings-row">
          <input
            value={row.branch}
            placeholder="브랜치"
            spellCheck={false}
            disabled={starting}
            onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, branch: e.target.value } : r)))}
          />
          <input
            value={row.message}
            placeholder="이 브랜치에서 무엇을 할까요"
            disabled={starting}
            onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, message: e.target.value } : r)))}
          />
          <button type="button" disabled={starting} onClick={() => setRows(rows.filter((_, i) => i !== index))}>
            빼기
          </button>
        </div>
      ))}
      <button
        type="button"
        // **상한보다 큰 값을 받아 놓고 나중에 거부하지 않는다.** 자리가 없으면 줄이 늘지 않는다.
        disabled={starting || draft.remainingSlots === 0}
        onClick={() => setRows([...rows, { branch: "", message: "" }])}
      >
        + 구성원
      </button>
      {status && (
        <p className="muted small">
          최대 {status.maxFleetSize}개까지입니다
          {draft.remainingSlots !== null ? ` (남은 자리 ${draft.remainingSlots})` : ""} — 상한이 없으면 오타 하나가
          비용과 프로세스를 동시에 폭발시킵니다.
        </p>
      )}

      <div className="settings-row">
        <label className="small">
          작업당 상한 $
          <input
            value={perTaskText}
            placeholder="비우면 없음"
            spellCheck={false}
            disabled={starting}
            onChange={(e) => setPerTaskText(e.target.value)}
          />
        </label>
        <label className="small">
          Fleet 합계 상한 $
          <input
            value={fleetCapText}
            placeholder="비우면 없음"
            spellCheck={false}
            disabled={starting}
            onChange={(e) => setFleetCapText(e.target.value)}
          />
        </label>
      </div>

      {draft.problems.map((problem) => (
        <p key={problem} className="error small">
          {problem}
        </p>
      ))}
      {draft.notices.map((notice) => (
        <p key={notice} className="muted small">
          {notice}
        </p>
      ))}

      <button type="button" disabled={disabled || starting || !draft.canStart || runningId !== null} onClick={start}>
        {starting ? "도는 중… (승인 모달이 뜹니다)" : `Fleet 시작 (${draft.members.length}개)`}
      </button>
      {runningId !== null && (
        <button type="button" onClick={() => void invoke("cancel_fleet").then(load).catch((e) => setError(String(e)))}>
          Fleet 전체 취소
        </button>
      )}

      {error && <p className="error small">{error}</p>}

      {result && (
        <>
          {/* **부분 실패를 완료로 접지 않는다.** `allCompleted`는 전부 완료됐을 때만 참이다. */}
          <p className={result.allCompleted ? "small" : "error small"}>
            {result.allCompleted ? "구성원 전부가 완료됐습니다." : "일부 구성원이 완료되지 않았습니다 — 아래 결말을 보세요."}
          </p>
          {result.notices.map((notice) => (
            <p key={notice} className="muted small">
              {notice}
            </p>
          ))}
        </>
      )}

      {fleets.length === 0 && <p className="muted small">아직 돌린 Fleet이 없습니다.</p>}
      {fleets.map((fleet) => (
        <FleetOutcome key={fleet.fleetId} fleet={fleet} running={fleet.fleetId === runningId} onChanged={load} />
      ))}
    </div>
  );
}

/**
 * Fleet 하나의 결말 — **구성원별로** 보여준다.
 *
 * 합계 한 줄만 보여주면 셋이 실패한 Fleet과 전부 성공한 Fleet이 같은 모양이 된다.
 */
function FleetOutcome({
  fleet,
  running,
  onChanged,
}: {
  fleet: FleetStatus;
  running: boolean;
  onChanged: () => void;
}) {
  const members = fleet.members.map((member) => ({
    branch: member.branch,
    costUsd: member.costUsd,
    status: member.status,
    unpricedCalls: member.unpricedCalls,
  }));
  const spend = summarizeFleetSpend({
    members,
    // **기록에서 읽은 상한이다.** 읽지 못했으면 아래에서 그 사실을 말한다 —
    // "상한이 없었다"로 단정하지 않는다.
    fleetCapUsd: fleet.capsRecorded ? fleet.fleetCapUsd ?? null : null,
    perTaskCapUsd: fleet.capsRecorded ? fleet.perTaskCapUsd ?? null : null,
  });
  const outcome = summarizeFleetOutcome(members);

  return (
    <div className="fleet-outcome">
      <h4>
        {fleet.fleetId}
        {running ? " · 도는 중" : ""}
      </h4>
      <p className={outcome.allCompleted ? "small" : "small warn"}>{outcome.headline}</p>

      <ul className="transmission-files">
        {fleet.members.map((member) => (
          <li key={member.taskId} className="small">
            <strong>
              {member.memberIndex}/{member.fleetSize} · {member.branch}
            </strong>{" "}
            — {member.status} ({member.phase}) · ${member.costUsd.toFixed(4)}
            {member.status === "running" && (
              <button
                type="button"
                onClick={() =>
                  void invoke("cancel_fleet_member", { taskId: member.taskId })
                    .then(onChanged)
                    .catch(() => onChanged())
                }
              >
                이 구성원만 취소
              </button>
            )}
            {member.worktreePath && (
              <>
                <br />
                <code className="muted">{member.worktreePath}</code>
              </>
            )}
          </li>
        ))}
      </ul>

      {/* 문장은 `fleetSpend.ts`가 만든다 — 첫 줄은 언제나 "이것은 합계다"이다. */}
      {spend.notices.map((notice) => (
        <p key={notice} className="muted small">
          {notice}
        </p>
      ))}
      {!fleet.capsRecorded && (
        // **읽지 못한 것과 없었던 것은 다른 사실이다.** 상한을 남기기 전의 기록이 여기 걸린다.
        <p className="muted small">
          이 기록에는 상한이 남아 있지 않습니다 — <strong>상한이 없었다는 뜻이 아니라</strong>, 이 기록이 상한을
          남기기 전의 것입니다.
        </p>
      )}
    </div>
  );
}
