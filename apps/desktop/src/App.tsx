import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import {
  phaseToStage,
  STAGE_ORDER,
  type AcceptanceCriterion,
  type ApprovalRequest,
  type CriterionEvaluation,
  type Disagreement,
  type FinalResult,
  type ForceAbandonThreshold,
  type ProviderStatus,
  type RevertOutcome,
  type RoutingInfo,
  type StoredEvent,
  type TaskEvent,
  type TaskPhase,
  type TaskRow,
  type UserDecisionInput,
  type UsageTotals,
  type UserStage,
  type VerificationReport,
  type WorkspaceInfo,
} from "./types";
import { AcceptanceCriteriaPanel } from "./components/AcceptanceCriteriaPanel";
import { ApprovalModal } from "./components/ApprovalModal";
import { DiffPanel } from "./components/DiffPanel";
import { DisagreementCard } from "./components/DisagreementCard";
import { EventLog } from "./components/EventLog";
import { StageBar } from "./components/StageBar";
import { TaskHistory } from "./components/TaskHistory";
import { VerificationPanel } from "./components/VerificationPanel";

/**
 * M0 최소 UI — docs/design/ui-wireframes.md.
 *
 * 완성된 디자인 시스템이나 에디터를 만들지 않는다(작업 지침 4.9절). 목표는 코어 루프를
 * 관측하고 통제할 수 있는 최소 화면이다:
 * 워크스페이스 선택 · 작업 입력 · Fast/Verified · 단계 표시 · 모델 표시 · 실시간 이벤트 로그 ·
 * 승인 모달(argv 표시) · diff · 검증 결과 · 최종 상태 · rollback · API 키 안내.
 *
 * 이 프로세스가 갖지 않는 것: API 키, 셸 실행, 파일 쓰기. 아래 코드에 그런 것이 없다 —
 * 모든 동작은 `invoke`로 Rust에 요청하고, Rust의 Policy Gate가 최종 판단한다.
 */
/**
 * 표본이 없을 때 "취소 중"이 이만큼 이어지면 강제 포기 버튼을 연다.
 *
 * **이 값 자체는 여전히 추정이다.** 달라진 것은 이게 유일한 답이 아니라는 것이다 —
 * 워크스페이스에 취소 기록이 충분히 쌓이면 Rust가 관측된 분포에서 임계값을 유도하고
 * (`force_abandon_threshold`, 16.3절), 화면은 그 값을 쓴다. 여기 남은 상수는 데이터가 없는
 * 첫 사용자를 위한 출발점이며, 종전 동작과 같은 값이어야 한다 — 이 작업의 목적은 값을 바꾸는
 * 것이 아니라 근거를 붙이는 것이다.
 */
const DEFAULT_FORCE_ABANDON_AFTER_MS = 5_000;

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"fast" | "verified">("verified");
  /**
   * 검증 통과 후 커밋을 **제안할지**. 기본은 꺼짐이다.
   *
   * 이 토글은 승인 등급을 낮추지 않는다 — 켜져 있어도 Policy Gate는 `git commit`을 승인
   * 대상으로 다룬다. 토글이 정하는 것은 "매 태스크마다 커밋 승인 모달을 띄울 것인가"뿐이다.
   */
  const [allowGitCommit, setAllowGitCommit] = useState(false);
  /**
   * 이 작업이 만든 커밋. **되돌리기 화면의 선택지가 이 값에 달려 있다** —
   * 커밋이 없으면 파일 되돌리기 하나뿐이고, 있으면 사용자가 무엇을 되돌릴지 골라야 한다.
   */
  const [commit, setCommit] = useState<{ sha: string | null; branch: string } | null>(null);

  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<TaskPhase>("CREATED");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);
  const [questions, setQuestions] = useState<string[] | null>(null);
  /**
   * 3.9절 불일치 카드로 물은 쟁점들. 비어 있으면 3.4절 확인 필요 카드다.
   *
   * 한 상태에 합치지 않는 이유: 두 카드는 사용자에게 **다른 상황**이고(모델이 모르겠다고 한
   * 경우 vs 두 모델이 다른 답을 낸 경우), 같은 컴포넌트로 그리면 그 구별이 사라진다.
   */
  const [disagreements, setDisagreements] = useState<Disagreement[]>([]);
  const [answer, setAnswer] = useState("");
  const [devMode, setDevMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 취소는 즉시 끝나지 않는다. 버튼을 누른 순간부터 terminal 이벤트가 올 때까지가 "취소 중"이고,
  // 그 사이에 버튼을 다시 누를 수 있으면 안 된다(요청 자체는 멱등이지만 사용자에게 혼란스럽다).
  const [cancelling, setCancelling] = useState(false);
  /**
   * 취소를 요청한 시각. **"취소 중"이 얼마나 이어졌는지를 화면이 알아야** 탈출구를 언제
   * 보여줄지 정할 수 있다(12절 미해결 "취소 중 상한").
   */
  const cancelStartedAt = useRef<number | null>(null);
  const [cancelElapsedMs, setCancelElapsedMs] = useState(0);
  const [forceAbandonAfter, setForceAbandonAfter] = useState<ForceAbandonThreshold | null>(null);
  // 실제로 쓰는 값. 측정값이 없으면 기본값으로 돌아간다 — 화면이 임계값 없이 도는 상태를
  // 만들지 않기 위해서다(탈출구가 아예 안 뜨는 것이 이 기능이 고치려던 문제였다).
  const forceAbandonMs = forceAbandonAfter?.ms ?? DEFAULT_FORCE_ABANDON_AFTER_MS;
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [selectedTask, setSelectedTask] = useState<{
    task: TaskRow;
    events: StoredEvent[];
    criteria: AcceptanceCriterion[];
    evaluations: CriterionEvaluation[];
  } | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);

  const startedAt = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const refreshTasks = useCallback(async () => {
    try {
      const result = await invoke<{ tasks: TaskRow[] }>("list_tasks", { limit: 50 });
      setTasks(result.tasks);
      setStoreError(null);
    } catch (error) {
      // 저장 계층이 아직 안 열렸거나 열지 못한 상태. 새 작업 실행은 가능해야 하므로
      // 화면을 막지 않고 사유만 보여준다.
      setStoreError(String(error));
    }
  }, []);

  useEffect(() => {
    void invoke<ProviderStatus>("provider_status").then(setProviderStatus).catch(() => undefined);
    void invoke<WorkspaceInfo | null>("current_workspace").then((info) => info && setWorkspace(info));
    void refreshTasks();
  }, [refreshTasks]);

  // 앱 시작 시 저장 계층이 열리고 **중단된 작업이 INTERRUPTED로 확정되는** 시점.
  // 그 직후에 목록을 다시 읽어야 중단된 작업이 "진행 중"으로 남아 보이지 않는다.
  useEffect(() => {
    const unlisten = listen<{ ok: boolean; error?: string; recovery?: { interruptedTasks?: string[] } }>(
      "store-ready",
      (event) => {
        if (!event.payload.ok) {
          setStoreError(event.payload.error ?? "저장 계층을 열 수 없습니다");
          return;
        }
        const interrupted = event.payload.recovery?.interruptedTasks ?? [];
        if (interrupted.length > 0) {
          setNotice(
            `이전 실행에서 완료되지 않은 작업 ${interrupted.length}건을 '중단됨'으로 표시했습니다. 자동으로 다시 실행하지 않습니다.`
          );
        }
        void refreshTasks();
      }
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshTasks]);

  // 경과 시간 표시 (ui-wireframes.md 3.5절)
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (startedAt.current !== null) setElapsedMs(Date.now() - startedAt.current);
    }, 200);
    return () => clearInterval(timer);
  }, [running]);

  // 취소 경과 시간. 정상 취소는 1초 안에 끝나므로 이 값이 커지는 것 자체가 신호다.
  useEffect(() => {
    if (!cancelling) {
      cancelStartedAt.current = null;
      setCancelElapsedMs(0);
      return;
    }
    if (cancelStartedAt.current === null) cancelStartedAt.current = Date.now();
    const timer = setInterval(() => {
      if (cancelStartedAt.current !== null) setCancelElapsedMs(Date.now() - cancelStartedAt.current);
    }, 200);
    return () => clearInterval(timer);
  }, [cancelling]);

  // Rust가 릴레이하는 이벤트 구독. 진행 상태 표시는 전부 여기서 파생된다 —
  // UI가 독자적으로 진행 상태를 추측하지 않는다.
  useEffect(() => {
    const unlistenEvent = listen<TaskEvent>("task-event", (event) => {
      const payload = event.payload;
      setEvents((prev) => [...prev, payload].slice(-500));
      if (payload.type === "PHASE_CHANGED") {
        const to = (payload.payload as { to?: TaskPhase }).to;
        if (to) setPhase(to);
      }
      if (payload.type === "APPROVAL_REQUESTED_NOTE") {
        const note = payload.payload as { questionsForUser?: string[]; disagreements?: Disagreement[] };
        if (note.questionsForUser && note.questionsForUser.length > 0) setQuestions(note.questionsForUser);
        setDisagreements(note.disagreements ?? []);
      }
      if (payload.type === "USER_MESSAGE_RECEIVED" || payload.type === "USER_DECISION_RECORDED") {
        setQuestions(null);
        setDisagreements([]);
      }
      // terminal 이벤트가 오면 "취소 중"을 푼다. 타이머로 추측하지 않는다 —
      // 프로세스가 실제로 죽었다는 사실은 호스트만 알고, 그 사실이 이벤트로 온다.
      if (payload.type.startsWith("TASK_") && payload.type !== "TASK_CREATED") setCancelling(false);
      // 확인 카드가 떠 있는 채로 취소되면 답변 입력창이 남는다.
      if (payload.type === "GIT_COMMIT_CREATED") {
        const p = payload.payload as { sha?: string | null; branch?: string };
        setCommit({ sha: p.sha ?? null, branch: p.branch ?? "(unknown)" });
      }
      if (payload.type === "CANCELLATION_REQUESTED") {
        setQuestions(null);
        setDisagreements([]);
      }
    });
    const unlistenApproval = listen<ApprovalRequest>("approval-required", (event) => {
      setApproval(event.payload);
    });
    return () => {
      void unlistenEvent.then((fn) => fn());
      void unlistenApproval.then((fn) => fn());
    };
  }, []);

  const openWorkspace = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      const info = await invoke<WorkspaceInfo>("open_workspace", { path: workspacePath });
      setWorkspace(info);
      // 임계값은 워크스페이스를 열 때 한 번만 읽는다. 취소마다 다시 계산하면 탈출구가 뜨는
      // 시점이 매번 달라지는데, 그 흔들림 자체가 사용자에게는 불안이다.
      //
      // **실패해도 작업을 막지 않는다.** 이건 편의 값이고, 없으면 기본값으로 돌아가면 된다 —
      // 계측을 읽지 못했다고 워크스페이스를 못 열게 하는 것은 꼬리가 몸통을 흔드는 것이다.
      try {
        const measured = await invoke<{ threshold: ForceAbandonThreshold }>("force_abandon_threshold", {
          workspacePath: info.rootPath,
        });
        setForceAbandonAfter(measured.threshold ?? null);
      } catch {
        setForceAbandonAfter(null);
      }
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setOpening(false);
    }
  }, [workspacePath]);

  const runTask = useCallback(async () => {
    if (!workspace || message.trim().length === 0) return;
    setRunning(true);
    setCancelling(false);
    setEvents([]);
    setFinalResult(null);
    setCommit(null);
    setQuestions(null);
    setNotice(null);
    setSelectedTask(null);
    setPhase("CREATED");
    startedAt.current = Date.now();
    setElapsedMs(0);
    try {
      const result = await invoke<FinalResult>("start_task", { message, mode, allowGitCommit });
      setFinalResult(result);
      setTaskId(result.taskId);
    } catch (error) {
      setFinalResult({ taskId: taskId ?? "(unknown)", status: "failed", summary: String(error) });
    } finally {
      setRunning(false);
      setCancelling(false);
      void refreshTasks();
    }
  }, [workspace, message, mode, taskId, refreshTasks]);

  const respondApproval = useCallback(
    async (granted: boolean) => {
      if (!approval) return;
      const current = approval;
      setApproval(null);
      try {
        await invoke("respond_approval", {
          approvalId: current.approvalId,
          granted,
          note: granted ? null : "사용자가 승인을 거부했습니다",
        });
      } catch (error) {
        setNotice(`승인 응답 실패: ${String(error)}`);
      }
    },
    [approval]
  );

  const cancel = useCallback(async () => {
    const id = currentTaskId(events, taskId);
    if (!id) return;
    setCancelling(true);
    try {
      const result = await invoke<{ accepted: boolean; outcome?: string }>("cancel_task", { taskId: id });
      switch (result.outcome) {
        // 이미 끝난 작업을 취소한 것은 오류가 아니다 — 사용자가 결과를 아직 못 본 것뿐이다.
        case "already_terminal":
          setNotice("이미 종료된 작업입니다.");
          setCancelling(false);
          break;
        case "already_requested":
          setNotice("이미 취소를 요청했습니다 — 실행 중인 명령을 정리하는 중입니다.");
          break;
        case "unknown_task":
          setNotice("취소할 작업을 찾을 수 없습니다.");
          setCancelling(false);
          break;
        default:
          setNotice("취소를 요청했습니다. 실행 중인 명령을 종료하는 중입니다.");
      }
    } catch (error) {
      setCancelling(false);
      setNotice(`취소 실패: ${String(error)}`);
    }
  }, [events, taskId]);

  const submitAnswer = useCallback(async () => {
    const id = currentTaskId(events, taskId);
    if (!id || answer.trim().length === 0) return;
    try {
      await invoke("provide_user_input", { taskId: id, message: answer });
      setAnswer("");
      setQuestions(null);
      setDisagreements([]);
    } catch (error) {
      setNotice(`답변 전달 실패: ${String(error)}`);
    }
  }, [events, taskId, answer]);

  /** 3.9절 카드의 답변. 어떤 쟁점에 대한 답인지를 id로 함께 보낸다 — 문장 파싱은 틀린다. */
  const submitDecisions = useCallback(
    async (decisions: UserDecisionInput[]) => {
      const id = currentTaskId(events, taskId);
      if (!id) return;
      try {
        await invoke("provide_user_input", {
          taskId: id,
          // 사람이 읽는 요약. 기계가 읽는 대응은 decisions가 담는다.
          message: decisions.map((d) => d.text).join("\n"),
          decisions,
        });
        setQuestions(null);
        setDisagreements([]);
      } catch (error) {
        setNotice(`판정 전달 실패: ${String(error)}`);
      }
    },
    [events, taskId]
  );

  /**
   * 강제 포기 — 기다리기를 그만둔다.
   *
   * **취소를 취소하는 것이 아니다.** 죽이려는 시도는 계속되고, 사용자를 "취소 중" 화면에서
   * 놓아줄 뿐이다. 그래서 안내 문구가 "정리됐습니다"가 아니라 "남아 있을 수 있습니다"다.
   */
  const forceAbandon = useCallback(async () => {
    const id = currentTaskId(events, taskId);
    if (!id) return;
    try {
      const result = await invoke<{ abandoned: boolean; status: string; reason?: string }>("force_abandon_task", {
        taskId: id,
      });
      setCancelling(false);
      setNotice(
        result.abandoned
          ? "작업을 강제로 종료했습니다. 실행 중이던 프로세스가 남아 있을 수 있으니 확인이 필요할 수 있습니다."
          : `기다리는 사이에 작업이 ${result.status}로 끝났습니다.`
      );
    } catch (error) {
      setNotice(`강제 포기 실패: ${String(error)}`);
    }
  }, [events, taskId]);

  /**
   * 커밋 되돌리기 — `git revert`. **파일 되돌리기와 다른 동작**이라 버튼도 따로다.
   *
   * 결과가 넷이고, **넷을 같은 문장으로 말하면 안 된다**(19.3절):
   *
   * 1. 되돌렸다 — 되돌리는 커밋이 새로 생겼다.
   * 2. 시작조차 못 했다 — 저장소는 누르기 전과 같다. 사유를 그대로 보여준다.
   * 3. 충돌해서 **원래대로 돌려놓았다** — 저장소는 누르기 전과 같다. 사용자가 할 일은 없고,
   *    직접 되돌리고 싶다면 충돌 파일 목록이 출발점이다.
   * 4. 충돌했는데 **원상복구까지 실패했다** — 저장소가 revert 진행 중으로 남았다. 사용자가
   *    지금 손대야 하는 유일한 상태다. 3번과 같은 톤으로 말하면 "아무것도 안 바뀌었습니다"로
   *    읽히고, 사용자는 저장소가 그 상태로 남은 줄 모른 채 다음 작업을 시작한다.
   */
  const revertCommit = useCallback(async () => {
    const id = finalResult?.taskId ?? taskId;
    if (!id) return;
    try {
      const result = await invoke<RevertOutcome>("revert_task_commit", { taskId: id });
      if (result.reverted) {
        setNotice(
          `커밋 ${(result.sha ?? "").slice(0, 8)}를 되돌리는 커밋을 만들었습니다. 이력에는 두 커밋이 모두 남습니다.`
        );
        return;
      }
      const conflicts = result.conflicts ?? [];
      const conflictList = conflicts.length > 0 ? ` (${conflicts.join(", ")})` : "";
      if (result.conflicted && result.cleanedUp === false) {
        // 앱이 만든 상태이므로 앱이 사실을 그대로 말한다. 남은 일이 무엇인지까지.
        setNotice(
          `되돌리기가 충돌했고 원상복구도 실패했습니다 — 저장소가 revert 진행 중 상태입니다${conflictList}. ` +
            `직접 \`git revert --abort\`를 실행하세요. ${result.reason ?? ""}`
        );
        return;
      }
      if (result.conflicted) {
        setNotice(`되돌리기가 충돌해서 저장소를 원래대로 돌려놓았습니다 — 바뀐 것은 없습니다${conflictList}.`);
        return;
      }
      setNotice(`커밋을 되돌리지 못했습니다: ${result.reason ?? "사유 없음"}`);
    } catch (error) {
      setNotice(`커밋 되돌리기 실패: ${String(error)}`);
    }
  }, [finalResult, taskId]);

  const rollback = useCallback(async () => {
    const id = finalResult?.taskId ?? taskId;
    if (!id) return;
    try {
      const result = await invoke<{ restored: unknown[]; failed: unknown[] }>("rollback_task", { taskId: id });
      setNotice(
        result.failed.length === 0
          ? `${result.restored.length}개 파일을 되돌렸습니다.`
          : `${result.restored.length}개 되돌림, ${result.failed.length}개 실패: ${JSON.stringify(result.failed)}`
      );
    } catch (error) {
      setNotice(`되돌리기 실패: ${String(error)}`);
    }
  }, [finalResult, taskId]);

  /** 저장된 작업 선택 — 그 작업의 이벤트 타임라인을 DB에서 읽어온다. */
  const selectTask = useCallback(async (id: string) => {
    setHistoryBusy(true);
    try {
      const [detail, storedEvents] = await Promise.all([
        invoke<{ task: TaskRow | null; acceptanceCriteria: AcceptanceCriterion[] | null }>("get_task", { taskId: id }),
        invoke<StoredEvent[]>("get_task_events", { taskId: id }),
      ]);
      // 지난 작업을 다시 열 때도 "무엇을 결정했는가"가 보여야 한다. 여기에는 FinalResult가
      // 없으므로 DB의 파생 캐시를 읽는다 — 이벤트를 재생하지 않는 것이 그 캐시의 존재 이유다.
      if (detail.task) {
        setSelectedTask({
          task: detail.task,
          events: storedEvents,
          criteria: detail.acceptanceCriteria ?? [],
          // **판정은 저장 테이블이 아니라 이벤트 로그에서 복원한다.** 판정은 매 검증의 파생값이라
          // 캐시 테이블에 두면 어느 시점의 것인지 모호해진다 — 이벤트가 진실의 원천이므로
          // 마지막 `CRITERIA_EVALUATED`가 그 작업의 최종 판정이다(CLAUDE.md 원칙 7).
          evaluations: lastCriterionEvaluations(storedEvents),
        });
      }
    } catch (error) {
      setNotice(`작업을 읽을 수 없습니다: ${String(error)}`);
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  /** 히스토리에서 되돌리기 — 진행 중 작업의 되돌리기와 같은 경로(Policy Gate 통과)를 쓴다. */
  const rollbackTask = useCallback(
    async (id: string) => {
      setHistoryBusy(true);
      try {
        const result = await invoke<{ restored: unknown[]; failed: unknown[] }>("rollback_task", { taskId: id });
        setNotice(
          result.failed.length === 0
            ? `${result.restored.length}개 파일을 되돌렸습니다.`
            : `${result.restored.length}개 되돌림, ${result.failed.length}개 실패: ${JSON.stringify(result.failed)}`
        );
        await refreshTasks();
      } catch (error) {
        setNotice(`되돌리기 실패: ${String(error)}`);
      } finally {
        setHistoryBusy(false);
      }
    },
    [refreshTasks]
  );

  const restartTask = useCallback(
    async (id: string) => {
      if (running) return;
      setRunning(true);
      setCancelling(false);
      setEvents([]);
      setFinalResult(null);
      setSelectedTask(null);
      setNotice(null);
      setPhase("CREATED");
      startedAt.current = Date.now();
      setElapsedMs(0);
      try {
        const result = await invoke<FinalResult>("restart_task", { taskId: id });
        setFinalResult(result);
        setTaskId(result.taskId);
      } catch (error) {
        setNotice(`다시 실행 실패: ${String(error)}`);
      } finally {
        setRunning(false);
        setCancelling(false);
        void refreshTasks();
      }
    },
    [running, refreshTasks]
  );

  const routing = useMemo(() => findRouting(events), [events]);
  const usage = useMemo(() => sumUsage(events), [events]);
  const reports = useMemo(() => findReports(events), [events]);
  const diffs = useMemo(() => finalResult?.diffs ?? [], [finalResult]);
  const stage: UserStage = finalResult ? "완료" : phaseToStage(phase);

  const noProviders = providerStatus?.providers.every((p) => !p.configured) ?? false;

  return (
    <main className="app">
      <header className="topbar">
        <h1>Tomverse Code</h1>
        <div className="topbar-meta">
          {workspace ? (
            <span title={workspace.rootPath}>
              워크스페이스: <strong>{workspace.name}</strong>
            </span>
          ) : (
            <span>워크스페이스가 선택되지 않았습니다</span>
          )}
          <label className="devtoggle">
            <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
            개발자 모드
          </label>
        </div>
      </header>

      {/* API 키 상태 — 값이 아니라 설정 여부만 표시된다. */}
      {providerStatus && (
        <section className={noProviders ? "banner banner-warn" : "banner"}>
          <div className="chips">
            {providerStatus.providers.map((p) => (
              <span key={p.providerId} className="chip">
                {p.providerId}: {p.configured ? "설정됨" : "미설정"} <code>{p.envName}</code>
              </span>
            ))}
          </div>
          {noProviders && (
            <p>
              API 키가 설정되지 않았습니다. <code>OPENAI_API_KEY</code> 또는 <code>ANTHROPIC_API_KEY</code> 환경변수를
              설정한 뒤 앱을 다시 실행하세요.
            </p>
          )}
          {!noProviders && !providerStatus.crossVerificationPossible && (
            <p>
              공급자가 하나뿐입니다 — <strong>교차검증(독립 검수) 없이 진행됩니다.</strong> 빌드·테스트 검증은 그대로
              수행됩니다.
            </p>
          )}
          {providerStatus.isDevelopmentOnly && (
            <p className="muted small">
              자격증명을 환경변수에서 읽고 있습니다 — <strong>개발용 임시 방식</strong>입니다. Windows Credential
              Manager 연동은 아직 구현되지 않았습니다.
            </p>
          )}
        </section>
      )}

      {!workspace && (
        <section className="panel">
          <h2>워크스페이스 선택</h2>
          <p className="muted">
            작업할 프로젝트 폴더의 절대 경로를 입력하세요. 이후 모든 파일 접근이 이 폴더 안으로 제한됩니다.
          </p>
          <div className="row">
            <input
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="C:\Users\you\Documents\my-project"
              spellCheck={false}
            />
            <button onClick={openWorkspace} disabled={opening || workspacePath.trim().length === 0}>
              {opening ? "여는 중..." : "열기"}
            </button>
          </div>
          {openError && <p className="error">{openError}</p>}
        </section>
      )}

      {workspace && (
        <>
          <section className="panel">
            <h2>작업 요청</h2>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="예: src/login.ts 에서 이메일 검증이 빈 문자열을 통과시킵니다. 고쳐주세요."
              rows={3}
              disabled={running}
            />
            <div className="row">
              <fieldset className="modes" disabled={running}>
                <legend>실행 정책</legend>
                <label>
                  <input type="radio" checked={mode === "fast"} onChange={() => setMode("fast")} />
                  Fast — 쉬운 작업은 단일 모델
                </label>
                <label>
                  <input type="radio" checked={mode === "verified"} onChange={() => setMode("verified")} />
                  Verified — 항상 독립 검수
                </label>
              </fieldset>
              {/* 커밋은 **되돌리기가 파일만 복원하고 커밋은 남기는** 유일한 단계라 별도 스위치다.
                  켜도 승인 없이 커밋되지 않는다 — 승인 모달이 실제 argv를 그대로 보여준다. */}
              <fieldset className="modes" disabled={running}>
                <legend>검증 통과 후</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={allowGitCommit}
                    onChange={(e) => setAllowGitCommit(e.target.checked)}
                  />
                  변경을 git에 커밋 (매번 승인을 묻습니다)
                </label>
              </fieldset>
              <button onClick={runTask} disabled={running || message.trim().length === 0 || noProviders}>
                {running ? "실행 중..." : "실행"}
              </button>
              {running && (
                <button className="secondary" onClick={cancel} disabled={cancelling}>
                  {cancelling ? "취소 중..." : "취소"}
                </button>
              )}
            </div>
            <p className="muted small">
              어느 정책을 골라도 빌드·테스트 검증은 생략되지 않습니다. Fast는 LLM 두 개의 상호 검토만 건너뜁니다.
            </p>
            {cancelling && (
              <div className="warn small">
                <p>
                  취소를 요청했습니다 — 실행 중인 명령을 종료하고 남은 단계를 건너뛰는 중입니다 (
                  {(cancelElapsedMs / 1000).toFixed(1)}초 경과). 이미 변경된 파일은 자동으로 되돌아가지 않습니다.
                  아래 결과에서 되돌리기를 선택할 수 있습니다.
                </p>
                {/* 이 시간을 넘겼다는 것은 죽지 않는 프로세스가 있거나 sidecar가 응답하지
                    않는다는 뜻이므로 탈출구를 연다 — 탈출구가 없으면 사용자에게는 앱이 멈춘
                    것과 구별되지 않는다. 시점은 이 워크스페이스에서 **실제로 관측된** 취소
                    소요에서 온다(16.3절). 표본이 부족하면 기본값으로 돌아간다. */}
                {cancelElapsedMs >= forceAbandonMs && (
                  <div className="row">
                    <button className="secondary" onClick={forceAbandon}>
                      강제 포기
                    </button>
                    <span>
                      예상보다 오래 걸리고 있습니다. 강제 포기는 <strong>기다리기를 그만두는 것</strong>이지 프로세스를
                      죽이는 것이 아닙니다 — 실행 중이던 명령이 계속 돌고 있을 수 있습니다.
                    </span>
                  </div>
                )}
                {/* 개발 모드에서만 근거를 노출한다. 일반 사용자에게 "이 숫자가 어디서 왔는가"는
                    필요 없는 정보지만, 임계값이 이상하게 느껴질 때 확인할 곳은 있어야 한다. */}
                {devMode && (
                  <p className="muted small">
                    탈출구 시점 {(forceAbandonMs / 1000).toFixed(1)}초 —{" "}
                    {forceAbandonAfter?.source === "measured"
                      ? `관측 ${forceAbandonAfter.sampleCount}건에서 유도`
                      : `표본 부족(${forceAbandonAfter?.sampleCount ?? 0}/${
                          forceAbandonAfter?.minSamples ?? 0
                        })으로 기본값`}
                  </p>
                )}
              </div>
            )}
          </section>

          <StageBar current={stage} stages={STAGE_ORDER} phase={phase} devMode={devMode} />
          {notice && <p className="notice">{notice}</p>}

          <section className="grid">
            <div className="column">
              <div className="panel">
                <h2>모델</h2>
                {routing ? (
                  <>
                    <ul className="assignments">
                      {routing.assignments.map((a) => (
                        <li key={a.role}>
                          <strong>{a.role}</strong> — {a.modelId} <span className="muted">({a.providerId})</span>
                          <div className="muted small">{a.reason}</div>
                        </li>
                      ))}
                    </ul>
                    <p className={routing.reviewerIndependent ? "ok small" : "warn small"}>
                      {routing.reviewerIndependent
                        ? "독립 검수: 검수자가 실행자와 다른 공급자입니다."
                        : "독립 검수 없음 — 사용 가능한 독립 공급자가 없어 검수 단계를 생략했습니다."}
                    </p>
                    {routing.appliedPolicies.length > 0 && (
                      <ul className="muted small">
                        {routing.appliedPolicies.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="muted">아직 라우팅되지 않았습니다.</p>
                )}
              </div>

              <div className="panel">
                <h2>이번 태스크</h2>
                <dl className="stats">
                  <dt>경과</dt>
                  <dd>{(elapsedMs / 1000).toFixed(1)}s</dd>
                  <dt>토큰</dt>
                  <dd>
                    {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out
                  </dd>
                  <dt>비용</dt>
                  <dd>${usage.costUsd.toFixed(4)}</dd>
                  <dt>모델 호출</dt>
                  <dd>{usage.calls}회</dd>
                </dl>
                {routing?.complexityTier === "simple" && (
                  <p className="muted small">단일 모델 처리 중 — 교차검증 생략</p>
                )}
              </div>

              {/* 3.9절 불일치 카드가 3.4절 확인 필요 카드를 **대체한다** — 같이 뜨면
                  사용자가 같은 질문에 두 번 답하게 된다. 두 상황이 다르므로 카드도 다르다. */}
              {questions && disagreements.length > 0 && (
                <DisagreementCard disagreements={disagreements} onSubmit={submitDecisions} devMode={devMode} />
              )}

              {questions && disagreements.length === 0 && (
                <div className="panel highlight">
                  <h2>확인이 필요합니다</h2>
                  <ul>
                    {questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                  <div className="row">
                    <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="답변 입력" />
                    <button onClick={submitAnswer} disabled={answer.trim().length === 0}>
                      전송
                    </button>
                  </div>
                </div>
              )}

              {finalResult && (
                <div className={`panel result result-${finalResult.status}`}>
                  <h2>{statusLabel(finalResult.status)}</h2>
                  <p>{finalResult.summary}</p>
                  {finalResult.failureReason && <p className="muted small">사유 코드: {finalResult.failureReason}</p>}
                  {(finalResult.mutatedPaths?.length ?? 0) > 0 && (
                    <>
                      <p>이 작업이 변경한 파일 ({finalResult.mutatedPaths!.length}개)</p>
                      <ul>
                        {finalResult.mutatedPaths!.map((p) => (
                          <li key={p}>
                            <code>{p}</code>
                          </li>
                        ))}
                      </ul>
                      <button className={finalResult.status === "failed" ? "" : "secondary"} onClick={rollback}>
                        {commit ? "파일만 되돌리기" : "되돌리기"}
                      </button>
                      {/* 커밋이 있으면 되돌리기가 두 가지 뜻을 갖는다. 어느 쪽인지 **사용자가
                          고르게 한다** — 공유된 브랜치인지 아닌지는 우리가 알 수 없고,
                          그 답에 따라 옳은 선택이 달라지기 때문이다(19절). */}
                      {commit && (
                        <button className="secondary" onClick={revertCommit} disabled={!commit.sha}>
                          커밋 되돌리기 (revert)
                        </button>
                      )}
                      {finalResult.status === "failed" && (
                        <p className="muted small">
                          실패한 작업은 되돌리기가 기본 권장입니다 — 깨진 상태를 방치하지 않기 위해서입니다.
                        </p>
                      )}
                      {commit && (
                        <div className="warn small">
                          <p>
                            이 작업은 <code>{commit.branch}</code>에 커밋했습니다
                            {commit.sha && <> ({commit.sha.slice(0, 8)})</>}.
                          </p>
                          <ul>
                            <li>
                              <strong>파일만 되돌리기</strong> — 파일 내용을 작업 전으로 복원합니다.{" "}
                              <strong>커밋은 그대로 남고</strong> 워킹 트리가 커밋과 달라집니다.
                            </li>
                            <li>
                              <strong>커밋 되돌리기(revert)</strong> — 그 커밋을 취소하는 **새 커밋**을 만듭니다.
                              이력이 다시 쓰이지 않으므로 이미 공유(push)한 브랜치에서도 안전합니다.
                            </li>
                          </ul>
                          {/* 이력 재작성을 우리가 대신 하지 않는 이유를 화면에서도 말한다. */}
                          <p>
                            커밋 자체를 이력에서 지우는 것(<code>git reset</code>)은 이 앱이 하지 않습니다 — 되돌릴 수
                            없고, 그 커밋을 이미 다른 사람이 받았는지 알 수 없기 때문입니다. 필요하면 직접 실행하세요.
                          </p>
                          {!commit.sha && (
                            <p className="error">
                              커밋 sha를 확인하지 못해 커밋 되돌리기를 제안할 수 없습니다. 추측으로 이력을 건드리지
                              않습니다.
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="column">
              {/* 3.10절: 검증 결과 **위에** 사용자가 정한 기준이 먼저 온다.
                  build/test/lint만 보고하면 사용자가 무엇을 결정했는지가 최종 화면에서 사라진다. */}
              {finalResult && (
                <AcceptanceCriteriaPanel
                  criteria={finalResult.acceptanceCriteria ?? []}
                  evaluations={finalResult.criterionEvaluations}
                  unresolvedDisagreements={finalResult.unresolvedDisagreements}
                />
              )}
              <VerificationPanel reports={reports} />
              <DiffPanel diffs={diffs} />
            </div>
          </section>

          <EventLog events={events} devMode={devMode} />
        </>
      )}

      {/* 히스토리는 워크스페이스 선택 여부와 무관하게 보인다 — 앱을 켜자마자
          중단된 작업이 있는지 알아야 하기 때문이다. */}
      {storeError && <p className="error">작업 기록을 읽을 수 없습니다: {storeError}</p>}
      <TaskHistory
        tasks={tasks}
        selectedId={selectedTask?.task.taskId ?? null}
        busy={historyBusy || running}
        onSelect={(id) => void selectTask(id)}
        onRollback={(id) => void rollbackTask(id)}
        onRestart={(id) => void restartTask(id)}
        onRefresh={() => void refreshTasks()}
      />

      {selectedTask && (
        <section className="panel">
          <h2>
            저장된 작업 기록{" "}
            <span className="muted small">
              {selectedTask.task.taskId} · {selectedTask.task.terminalStatus ?? selectedTask.task.currentPhase}
            </span>
            <button className="secondary tiny" onClick={() => setSelectedTask(null)}>
              닫기
            </button>
          </h2>
          <p className="muted small">{selectedTask.task.userMessage}</p>
          <AcceptanceCriteriaPanel criteria={selectedTask.criteria} evaluations={selectedTask.evaluations} />
          {/* 실시간 로그와 다른 패널에 그린다 — 같은 목록에 섞으면 이벤트가 두 번 보인다. */}
          <EventLog events={selectedTask.events} devMode={devMode} />
        </section>
      )}

      {approval && <ApprovalModal request={approval} onRespond={respondApproval} />}
    </main>
  );
}

/**
 * 저장된 이벤트에서 마지막 기준 판정을 복원한다.
 *
 * fix loop를 돌면 `CRITERIA_EVALUATED`가 여러 번 나온다. 최종 보고가 쓰는 것은 마지막 것이고,
 * 앞의 것들은 "도중에 무엇이 확인/반증됐는가"의 기록이므로 여기서는 마지막만 본다.
 */
function lastCriterionEvaluations(events: StoredEvent[]): CriterionEvaluation[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== "CRITERIA_EVALUATED") continue;
    const evaluations = (event.payload as { evaluations?: CriterionEvaluation[] }).evaluations;
    if (Array.isArray(evaluations)) return evaluations;
  }
  return [];
}

function statusLabel(status: FinalResult["status"]): string {
  switch (status) {
    case "completed":
      return "✓ 완료";
    case "failed":
      return "✗ 실패";
    case "cancelled":
      return "취소됨";
    case "rejected":
      return "거부됨";
  }
}

function currentTaskId(events: TaskEvent[], fallback: string | null): string | null {
  const last = events[events.length - 1];
  return last?.taskId ?? fallback;
}

function findRouting(events: TaskEvent[]): RoutingInfo | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "ROUTING_DECIDED") return events[i]!.payload as unknown as RoutingInfo;
  }
  return null;
}

function findReports(events: TaskEvent[]): VerificationReport[] {
  return events
    .filter((e) => e.type === "VERIFICATION_COMPLETED")
    .map((e) => e.payload as unknown as VerificationReport);
}

function sumUsage(events: TaskEvent[]): UsageTotals {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  for (const event of events) {
    if (event.type !== "PROVIDER_USAGE") continue;
    const payload = event.payload as { usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number };
    totals.inputTokens += payload.usage?.inputTokens ?? 0;
    totals.outputTokens += payload.usage?.outputTokens ?? 0;
    totals.costUsd += payload.costUsd ?? 0;
    totals.calls += 1;
  }
  return totals;
}
