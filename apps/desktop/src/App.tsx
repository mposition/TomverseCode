import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import {
  phaseToStage,
  stagesFor,
  type AcceptanceCriterion,
  type ApprovalRequest,
  type CriterionEvaluation,
  type Disagreement,
  type DraftNarrative,
  type FinalResult,
  type DerivedThresholds,
  type ForceAbandonThreshold,
  type LargeChangeThreshold,
  type ProviderStatus,
  type RevertOutcome,
  type SecretShapeHit,
  type Transmission,
  type RoutingInfo,
  type StoredEvent,
  type TaskEvent,
  type TaskPhase,
  type AvailableModel,
  type CredentialCheck,
  type TaskBudgetThreshold,
  type TaskRow,
  type UserDecisionInput,
  type UsageTotals,
  type TaskKind,
  type UserStage,
  type VerificationReport,
  type WorkspaceInfo,
} from "./types";
import { AcceptanceCriteriaPanel } from "./components/AcceptanceCriteriaPanel";
import { resultBasis } from "./lib/resultBasis";
import { summarizeContrast, type ContrastInput } from "./lib/contrastSummary";
import { describeCallPlan } from "./lib/callPlan";
import { ApprovalModal } from "./components/ApprovalModal";
import { DiffPanel } from "./components/DiffPanel";
import { DisagreementCard } from "./components/DisagreementCard";
import { SecretShapeWarning, useSecretShapeScan } from "./components/SecretShapeWarning";
import { TransmissionPanel } from "./components/TransmissionPanel";
import { BudgetPanel } from "./components/BudgetPanel";
import { precheckBudget } from "./lib/budgetCheck";
import { readDeadline } from "./lib/deadline";
import { AuditExportPanel } from "./components/AuditExportPanel";
import { BlockedPanel } from "./components/BlockedPanel";
import { WorkspaceSettingsPanel } from "./components/WorkspaceSettingsPanel";
import { CarriedDecisionsPanel } from "./components/CarriedDecisionsPanel";
import { WorktreePanel } from "./components/WorktreePanel";
import { AutopilotPreviewPanel } from "./components/AutopilotPreviewPanel";
import { AnswerPanel } from "./components/AnswerPanel";
import { SkillLibraryPicker } from "./components/SkillLibraryPicker";
import { EffectiveConfigPanel } from "./components/EffectiveConfigPanel";
import { PullRequestPanel } from "./components/PullRequestPanel";
import { EventLog } from "./components/EventLog";
import { StageBar } from "./components/StageBar";
import { TaskHistory } from "./components/TaskHistory";
import { bannerFor, reopenTarget, type BackendStatus } from "./lib/backendStatus";
import { unwrap, type Envelope } from "./lib/envelope";

import {
  EMPTY_TASK_LIST,
  TASK_PAGE_SIZE,
  appendPage,
  countLabel,
  firstPage,
  hasMore,
  type TaskListState,
  type TaskPage,
} from "./lib/taskPaging";
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

/**
 * 표본이 없을 때 "큰 변경"으로 볼 파일 수 (19.6절).
 *
 * **Rust의 `DEFAULT_LARGE_CHANGE_FILES`와 같은 값이어야 한다.** 두 곳에 두는 이유는 문턱을
 * 읽지 못했을 때도 화면이 동작해야 하기 때문이고, 값이 갈리면 같은 상황에서 안내가 떴다
 * 안 떴다 한다. 한쪽을 고칠 때 다른 쪽도 볼 것.
 */
const DEFAULT_LARGE_CHANGE_FILES = 8;

/**
 * 입력란의 문자열을 `start_task`의 두 인자로 바꾼다.
 *
 * **비어 있는 것과 "상한 없음"을 여기서만 잇는다.** 두 인자로 보내는 이유는 Rust 쪽 주석에
 * 있다 — 인자를 빠뜨린 화면이 상한을 조용히 끄지 못하게 하기 위해서다. 그러려면 화면도
 * "없음"을 명시적으로 말해야 하고, 그 변환 지점이 한 곳뿐이어야 한다.
 */
/**
 * 화면의 선택을 `start_task`의 `modelPins`로 바꾼다.
 *
 * **비어 있으면 키를 넣지 않는다.** 빈 문자열을 그대로 보내면 "그런 모델 ID를 지정했다"가
 * 되어 라우터가 멈춘다 — 사용자는 아무것도 고르지 않았는데.
 */
function modelPins(executor: string, reviewer: string): { executor?: string; reviewer?: string } | undefined {
  const pins: { executor?: string; reviewer?: string } = {};
  if (executor) pins.executor = executor;
  if (reviewer) pins.reviewer = reviewer;
  return Object.keys(pins).length > 0 ? pins : undefined;
}

function budgetArgs(text: string): { budgetUsd: number | null; budgetUnlimited: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { budgetUsd: null, budgetUnlimited: true };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    // 잘못된 값을 "없음"으로 바꾸지 않는다. Rust가 거부하고 그 사유가 화면에 뜬다 —
    // 여기서 조용히 무제한으로 바꾸면 오타 하나가 상한을 지운다.
    return { budgetUsd: value, budgetUnlimited: false };
  }
  return { budgetUsd: value, budgetUnlimited: false };
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  /**
   * 격리 실행의 브랜치 (state-machine 38절). 비어 있으면 본체에서 돈다.
   *
   * **여는 시점에 정한다.** 태스크마다 바꿀 수 없는 이유는 게이트 루트가 sidecar 수명과
   * 묶여 있기 때문이고, 그건 화면이 정할 수 있는 것이 아니다(38.1절).
   */
  const [isolateBranch, setIsolateBranch] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  /**
   * 허용 목록 변경 안내 (multi-engine-routing.md 16절).
   *
   * **즉시 적용되지 않는다.** 강제는 sidecar spawn 시 자격증명을 거르는 것으로 일어나므로
   * 이미 떠 있는 백엔드에는 예전 키가 들어 있다. 몰래 재시작하면 진행 중인 작업이 죽는다.
   */
  const [allowlistNotice, setAllowlistNotice] = useState<string | null>(null);
  /** 자격증명 확인 결과 (17절). `null`은 아직 확인하지 않은 것이며 "문제없음"이 아니다. */
  const [credentialChecks, setCredentialChecks] = useState<CredentialCheck[] | null>(null);
  const [probing, setProbing] = useState(false);
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
   * 바꿔 달라는 것인가 물어보는 것인가 (state-machine 51절).
   *
   * **사용자의 문장을 보고 우리가 추측하지 않는다.** 추측하면 "고쳐 달라"는 요청에 답만 하거나
   * 그 반대가 되고, 둘 다 사용자가 원한 것이 아니다.
   */
  const [taskKind, setTaskKind] = useState<TaskKind>("change");
  /**
   * 무인 실행 (state-machine 24절)과 그 짝인 검증 명령 자동 승인(24.5절).
   *
   * **두 스위치를 따로 둔다.** 무인 실행만 켜면 태스크는 검증 명령 승인에서 멈추고, 그건
   * 버그가 아니라 24.4절이 정한 동작이다. 하나로 합치면 "무인을 켰더니 검증 명령이 자동
   * 승인됐다"가 되는데, 그 둘은 사용자가 따로 판단할 일이다.
   */
  const [unattended, setUnattended] = useState(false);
  /**
   * 무인 실행의 시한 — 분 단위 문자열. **기본값을 채우지 않는다**(state-machine 39절):
   * 예산 상한과 같은 규칙으로, 코드가 만들어낸 승인은 승인이 아니다.
   */
  const [deadlineText, setDeadlineText] = useState("");
  const [autoApproveVerification, setAutoApproveVerification] = useState(false);
  /** 스킬 파일 경로 (26절). **Rust가 읽는다** — 화면은 경로만 넘긴다. */
  const [skillPath, setSkillPath] = useState("");
  /**
   * 이 작업의 예산 상한 (multi-engine-routing.md 10.6절).
   *
   * `""`(빈 문자열)는 **상한 없음**이다. `0`이나 `null`로 표현하지 않는 이유: 입력란을 비운
   * 것과 0을 적은 것은 사용자에게 다른 행동이고, 0은 "아무것도 못 도는 상한"이라 우리가
   * 그것을 "무제한"으로 읽으면 정반대로 해석하는 것이다.
   */
  const [budgetText, setBudgetText] = useState<string>("");
  const [budgetSuggestion, setBudgetSuggestion] = useState<TaskBudgetThreshold | null>(null);
  /**
   * 역할별 모델 지정 (multi-engine-routing.md 15절). 빈 문자열은 **"라우터가 정한다"**이다.
   *
   * co-executor는 없다 — 대조 표본의 유일한 일이 primary와 다른 것이라, 고르게 하면 둘을
   * 같게 만들 수 있고 그 순간 "불일치 없음"은 착시가 된다(13.1절).
   */
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [pinExecutor, setPinExecutor] = useState("");
  const [pinReviewer, setPinReviewer] = useState("");
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
  // 자유 서술은 질문이 아니라 참고 자료다 — 별도 상태로 두는 것이 그 사실의 표현이다(17.12절).
  const [narratives, setNarratives] = useState<DraftNarrative[]>([]);
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
  const [largeChange, setLargeChange] = useState<LargeChangeThreshold | null>(null);
  /**
   * 이번 계획이 건드리는 파일 — 19.6절 "커밋 단위"의 남은 항목.
   *
   * **계획 시점에 잡는다.** 커밋을 보고 "컸네"라고 말하는 것은 이미 늦었다 — 그때는 파일이
   * 다 바뀐 뒤라 쪼갤 수 있는 것이 없다. 쪼개려면 실행 전이어야 한다.
   */
  const [plannedPaths, setPlannedPaths] = useState<string[]>([]);
  /**
   * 이 작업에서 무엇이 어느 공급자로 나갔는가 (7절).
   *
   * **끝난 뒤에 읽는다.** 진행 중에 조금씩 채우면 화면이 "지금까지 나간 것"과 "전부 나간 것"을
   * 구별해 말해야 하는데, 사용자가 묻는 시점은 끝난 뒤다. 저장된 이벤트에서 만들므로 앱을
   * 다시 켠 뒤에도 같은 답이 나온다.
   */
  const [transmission, setTransmission] = useState<Transmission | null>(null);
  // 실제로 쓰는 문턱. 측정값이 없으면 기본값이며, **그 사실은 개발자 모드에서만 노출한다** —
  // 일반 사용자에게 "이 숫자가 어디서 왔는가"는 필요 없는 정보다.
  const largeChangeFiles = largeChange?.files ?? DEFAULT_LARGE_CHANGE_FILES;
  /**
   * 시작 전 예산 점검 (multi-engine-routing.md 10.6·15절).
   *
   * 상한이 한 호출의 최대 비용보다 작으면 첫 호출부터 거부된다 — 종전에는 스냅샷과 라우팅을
   * 마친 뒤에야 오류로 나왔다. 두 값을 같은 화면에서 받으므로 시작 전에 말할 수 있다.
   */
  const budgetLimit = useMemo(() => {
    const args = budgetArgs(budgetText);
    return args.budgetUnlimited ? null : args.budgetUsd;
  }, [budgetText]);
  const budgetPrecheck = useMemo(
    () =>
      precheckBudget({
        // 화면의 입력을 태스크가 받게 될 값으로 바꾸는 곳은 `budgetArgs` 한 곳뿐이다 —
        // 점검이 다른 규칙으로 읽으면 "경고는 없는데 시작하면 거부"가 생긴다.
        budgetUsd: budgetLimit,
        models,
        pinExecutor,
        pinReviewer,
      }),
    [budgetLimit, models, pinExecutor, pinReviewer]
  );
  // 보내기 전 자격증명 경고(17.11절). 요청문과 답변은 **그대로 프롬프트에 실려 나가므로**,
  // 저장 시 마스킹으로는 막을 수 없다 — 막을 수 있는 것은 보내기 전의 사용자뿐이다.
  const messageSecrets: SecretShapeHit[] = useSecretShapeScan(message);
  const answerSecrets: SecretShapeHit[] = useSecretShapeScan(answer);
  // 목록은 커서 페이지네이션이다 — 한 번에 전부 읽지 않는다(5절). 이어 붙이는 규칙은
  // 화면 밖 순수 함수에 있다: 중복과 전진하지 않는 커서는 화면에서 정상으로 보인다.
  const [taskList, setTaskList] = useState<TaskListState>(EMPTY_TASK_LIST);
  const tasks = taskList.tasks;
  const [historyBusy, setHistoryBusy] = useState(false);
  const [selectedTask, setSelectedTask] = useState<{
    task: TaskRow;
    events: StoredEvent[];
    criteria: AcceptanceCriterion[];
    evaluations: CriterionEvaluation[];
  } | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  // 백엔드 상태. **조회는 아무것도 다시 띄우지 않는다** — 물었더니 재spawn이 일어나면 조회가 아니다.
  const [backend, setBackend] = useState<BackendStatus | null>(null);

  const startedAt = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const refreshBackend = useCallback(async () => {
    try {
      setBackend(await invoke<BackendStatus>("backend_status"));
    } catch {
      // 상태를 못 읽은 것을 고장으로 보고하지 않는다 — 모르는 것과 죽은 것은 다르다.
      setBackend(null);
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const result = unwrap(await invoke<Envelope<TaskPage>>("list_tasks", { limit: TASK_PAGE_SIZE }));
      // 저장 계층이 아직 안 열렸거나 열지 못한 상태. 새 작업 실행은 가능해야 하므로
      // 화면을 막지 않고 사유만 보여준다.
      if (!result.ok) return setStoreError(result.problem.text);
      // 새로고침은 **이미 읽은 페이지를 버린다.** 1페이지만 갈아 끼우면 위쪽은 새 상태,
      // 아래쪽은 옛 상태가 되어 어느 시점에도 존재한 적 없는 목록이 만들어진다.
      setTaskList(firstPage(result.value));
      setStoreError(null);
    } catch (error) {
      // 여기까지 오는 것은 **전송 자체가 실패한 경우**다. 봉투로 온 실패는 위에서 끝났다.
      setStoreError(String(error));
    }
  }, []);

  const loadMoreTasks = useCallback(async () => {
    // 커서가 없으면 마지막 페이지다. 커서를 **화면이 지어내지 않는다** — 형식은 Rust의 것이다.
    if (!hasMore(taskList)) return;
    setHistoryBusy(true);
    try {
      const result = unwrap(
        await invoke<Envelope<TaskPage>>("list_tasks", {
          limit: TASK_PAGE_SIZE,
          cursor: taskList.cursor,
        })
      );
      if (!result.ok) return setStoreError(result.problem.text);
      setTaskList((prev) => appendPage(prev, result.value));
      setStoreError(null);
    } catch (error) {
      setStoreError(String(error));
    } finally {
      setHistoryBusy(false);
    }
  }, [taskList]);

  useEffect(() => {
    void invoke<ProviderStatus>("provider_status").then(setProviderStatus).catch(() => undefined);
    void invoke<WorkspaceInfo | null>("current_workspace").then((info) => info && setWorkspace(info));
    void refreshTasks();
  }, [refreshTasks]);

  // 앱 시작 시 저장 계층이 열리고 **중단된 작업이 INTERRUPTED로 확정되는** 시점.
  // 그 직후에 목록을 다시 읽어야 중단된 작업이 "진행 중"으로 남아 보이지 않는다.
  useEffect(() => {
    // 이벤트도 명령과 **같은 봉투**로 온다. 종전에는 이것만 `message` 대신 `error` 키를
    // 써서 화면에 이 경계 전용 읽기가 하나 더 있었다.
    type StoreReady = Envelope<{ recovery?: { interruptedTasks?: string[] } }>;
    const unlisten = listen<StoreReady>("store-ready", (event) => {
      const result = unwrap(event.payload);
      if (!result.ok) {
        setStoreError(result.problem.text);
        return;
      }
      const interrupted = result.value.recovery?.interruptedTasks ?? [];
      if (interrupted.length > 0) {
        setNotice(
          `이전 실행에서 완료되지 않은 작업 ${interrupted.length}건을 '중단됨'으로 표시했습니다. 자동으로 다시 실행하지 않습니다.`
        );
      }
      void refreshTasks();
    });
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
        const note = payload.payload as {
          questionsForUser?: string[];
          disagreements?: Disagreement[];
          narratives?: DraftNarrative[];
        };
        if (note.questionsForUser && note.questionsForUser.length > 0) setQuestions(note.questionsForUser);
        setDisagreements(note.disagreements ?? []);
        setNarratives(note.narratives ?? []);
      }
      if (payload.type === "USER_MESSAGE_RECEIVED" || payload.type === "USER_DECISION_RECORDED") {
        setQuestions(null);
        setDisagreements([]);
        setNarratives([]);
      }
      // terminal 이벤트가 오면 "취소 중"을 푼다. 타이머로 추측하지 않는다 —
      // 프로세스가 실제로 죽었다는 사실은 호스트만 알고, 그 사실이 이벤트로 온다.
      if (payload.type.startsWith("TASK_") && payload.type !== "TASK_CREATED") setCancelling(false);
      // 확인 카드가 떠 있는 채로 취소되면 답변 입력창이 남는다.
      if (payload.type === "PLAN_CREATED") {
        const plan = payload.payload as { changedPaths?: string[]; purpose?: string };
        // 커밋 계획은 파일을 바꾸지 않는다 — 여기 섞으면 "이 작업이 무엇을 바꾸는가"가 흐려진다.
        if (plan.purpose !== "git_commit") setPlannedPaths(plan.changedPaths ?? []);
      }
      if (payload.type === "GIT_COMMIT_CREATED") {
        const p = payload.payload as { sha?: string | null; branch?: string };
        setCommit({ sha: p.sha ?? null, branch: p.branch ?? "(unknown)" });
      }
      if (payload.type === "CANCELLATION_REQUESTED") {
        setQuestions(null);
        setDisagreements([]);
        setNarratives([]);
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
      const info = await invoke<WorkspaceInfo>("open_workspace", {
        path: workspacePath,
        // 빈 문자열은 **격리하지 않음**이다. 그대로 넘기면 이름 없는 브랜치를 만들려다 거절된다.
        isolateBranch: isolateBranch.trim() === "" ? null : isolateBranch.trim(),
      });
      setWorkspace(info);
      // 다시 열었으면 감독자가 새로 만들어졌다 — 옛 배너를 그대로 두면 고쳐졌는데도 고장으로 보인다.
      void refreshBackend();
      // 임계값은 워크스페이스를 열 때 한 번만 읽는다. 취소마다 다시 계산하면 탈출구가 뜨는
      // 시점이 매번 달라지는데, 그 흔들림 자체가 사용자에게는 불안이다.
      //
      // **실패해도 작업을 막지 않는다.** 이건 편의 값이고, 없으면 기본값으로 돌아가면 된다 —
      // 계측을 읽지 못했다고 워크스페이스를 못 열게 하는 것은 꼬리가 몸통을 흔드는 것이다.
      try {
        const result = unwrap(
          await invoke<Envelope<DerivedThresholds>>("derived_thresholds", { workspacePath: info.rootPath })
        );
        // 실패는 조용히 기본값으로 돌아간다(아래 catch와 같은 처리). 이 값은 편의이고,
        // 못 읽었다고 화면에 경고를 띄우면 사용자가 할 수 있는 일이 없다.
        if (!result.ok) throw new Error(result.problem.text);
        const measured = result.value;
        setForceAbandonAfter(measured.forceAbandon ?? null);
        setLargeChange(measured.largeChange ?? null);
        // **제안은 승인이 아니다.** 입력란을 채우기만 하고, 강제되는 것은 사용자가 확인한 값이다.
        setBudgetSuggestion(measured.taskBudget ?? null);
        setBudgetText(measured.taskBudget ? String(measured.taskBudget.usd) : "");
      } catch {
        setForceAbandonAfter(null);
        setLargeChange(null);
        setBudgetSuggestion(null);
        setBudgetText("");
      }
      // 모델 목록도 워크스페이스를 열 때 한 번 읽는다. **실패해도 작업을 막지 않는다** —
      // 목록이 없으면 지정 없이(라우터가 정하는 대로) 실행되며, 그건 종전 동작이다.
      try {
        const listed = await invoke<{ models: AvailableModel[] }>("list_models", {});
        setModels(listed.models ?? []);
      } catch {
        setModels([]);
      }
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setOpening(false);
    }
  }, [workspacePath, isolateBranch, refreshBackend]);

  // 배너의 "다시 열기". 대상 경로는 **지금 열려 있는 워크스페이스**이지 입력란의 값이 아니다 —
  // 입력란은 사용자가 다른 경로를 타이핑하던 중일 수 있고, 그러면 엉뚱한 곳이 열린다.
  // 시한 입력의 판정은 **화면 밖**에 있다(39절). 시작 버튼과 안내 문장이 같은 값을 본다 —
  // 두 번 계산하면 "시작할 수 없다"와 "문제 없다"가 동시에 보일 수 있다.
  const deadline = readDeadline(deadlineText, unattended);
  const banner = bannerFor(backend);
  // **저장소 경로로 다시 연다.** 격리 실행에서 `rootPath`는 격리 트리이고, 그걸 저장소로 주면
  // 트리가 저장소가 되어 격리가 조용히 사라진다 — 게다가 workspace_id가 바뀌어 등록도 사라진다.
  const reopenPath = reopenTarget(banner, workspace?.repoPath ?? workspace?.rootPath ?? null);
  const reopenBranch = workspace?.isolation?.branch ?? null;
  const reopenBackend = useCallback(async () => {
    if (!reopenPath) return;
    setOpening(true);
    try {
      // **같은 격리로 다시 연다.** 떨어뜨리면 sidecar가 죽었다 살아난 뒤부터 본체에 파일을 쓴다.
      setWorkspace(
        await invoke<WorkspaceInfo>("open_workspace", { path: reopenPath, isolateBranch: reopenBranch })
      );
      await refreshBackend();
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setOpening(false);
    }
  }, [reopenPath, reopenBranch, refreshBackend]);

  const toggleProvider = useCallback(
    async (providerId: string, enable: boolean) => {
      if (!workspace || !providerStatus) return;
      // 제한이 없던 상태에서 하나를 끄면 **나머지 전부를 명시한 목록**이 된다.
      // "이것만 빼고"를 저장할 방법이 없으므로, 끄는 순간 목록이 생긴다.
      const current = workspace.allowedProviders ?? providerStatus.providers.map((p) => p.providerId);
      const next = enable
        ? [...new Set([...current, providerId])]
        : current.filter((id) => id !== providerId);
      // 전부 켜진 상태는 "제한 없음"으로 되돌린다 — 모든 공급자를 나열한 목록과 제한 없음은
      // 지금은 같지만, 나중에 공급자가 늘면 다르다. 사용자가 의도한 것은 후자다.
      const all = providerStatus.providers.map((p) => p.providerId);
      const allowed = next.length === all.length ? null : next;
      try {
        const saved = await invoke<{ note: string }>("set_allowed_providers", { allowed });
        setWorkspace({ ...workspace, allowedProviders: allowed, providersBlockedByPolicy: [] });
        setAllowlistNotice(saved.note);
      } catch (error) {
        setAllowlistNotice(String(error));
      }
    },
    [workspace, providerStatus]
  );

  const probeProviders = useCallback(async () => {
    setProbing(true);
    try {
      const result = await invoke<{ checks: CredentialCheck[] }>("probe_providers", {});
      setCredentialChecks(result.checks);
    } catch (error) {
      // 확인 자체가 실패한 것과 "키가 나쁘다"는 다른 사실이다 — 결과 자리에 오류를 섞지 않고
      // 안내 줄에 둔다.
      setAllowlistNotice(`자격증명 확인에 실패했습니다: ${error}`);
    } finally {
      setProbing(false);
    }
  }, []);

  const runTask = useCallback(async () => {
    if (!workspace || message.trim().length === 0) return;
    setRunning(true);
    setCancelling(false);
    setEvents([]);
    setFinalResult(null);
    setCommit(null);
    setQuestions(null);
    setNotice(null);
    setPlannedPaths([]);
    setTransmission(null);
    setSelectedTask(null);
    setPhase("CREATED");
    startedAt.current = Date.now();
    setElapsedMs(0);
    try {
      const result = await invoke<FinalResult>("start_task", {
        message,
        mode,
        allowGitCommit,
        ...budgetArgs(budgetText),
        modelPins: modelPins(pinExecutor, pinReviewer),
        unattended,
        autoApproveVerification,
        // 빈 문자열은 "경로 없음"이지 "빈 경로"가 아니다.
        skillPath: skillPath.trim() === "" ? null : skillPath.trim(),
        // **질문인가**(51절). 이 값이 정하는 것은 경로만이 아니다 — Rust가 이걸 보고 도구를
        // 읽기 전용으로 좁혀 게이트에 꽂는다(51.2절).
        question: taskKind === "question",
        // 시한의 판정은 화면 밖(src/lib)에 있다 — 계산이 화면 안에 있으면 검증할 방법이 없다.
        deadlineSecs: readDeadline(deadlineText, unattended).secs,
      });
      setFinalResult(result);
      // 전송 내역은 **끝난 뒤에** 읽는다. 실패해도 결과 화면을 막지 않는다 — 이건 사후 조회이고,
      // 읽지 못했다는 사실은 패널이 스스로 말한다(패널이 없으면 그냥 없는 것이다).
      try {
        const sent = unwrap(await invoke<Envelope<Transmission>>("task_transmission", { taskId: result.taskId }));
        setTransmission(sent.ok ? sent.value : null);
      } catch {
        setTransmission(null);
      }
      setTaskId(result.taskId);
    } catch (error) {
      setFinalResult({ taskId: taskId ?? "(unknown)", status: "failed", summary: String(error) });
    } finally {
      setRunning(false);
      setCancelling(false);
      void refreshTasks();
      // 작업이 끝난 **뒤에** 본다. 실패의 원인이 백엔드였다면 여기서 드러나고, 아니었다면
      // `alive`가 나와 배너가 뜨지 않는다.
      void refreshBackend();
    }
  }, [workspace, message, mode, taskId, refreshTasks, refreshBackend]);

  const respondApproval = useCallback(
    async (granted: boolean) => {
      if (!approval) return;
      const current = approval;
      setApproval(null);
      try {
        // **실패도 `Ok` 봉투로 온다**(ui-wireframes 6절). Tauri의 `Err`는 문자열 하나뿐이라
        // 구조가 들어갈 자리가 없고, 문자열에 구조를 실으면 화면이 문장을 파싱하게 된다.
        const result = unwrap(
          await invoke<Envelope<Record<string, never>>>("respond_approval", {
            approvalId: current.approvalId,
            granted,
            note: granted ? null : "사용자가 승인을 거부했습니다",
          })
        );
        if (!result.ok) setNotice(`승인 응답 실패: ${result.problem.text}`);
      } catch (error) {
        // 여기 걸리는 것은 명령 자체가 실패한 경우(워크스페이스 없음 등)다 — 아직 코드가
        // 붙지 않은 경계이므로 원문을 그대로 보여준다.
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
      const [detailResponse, eventsResponse] = await Promise.all([
        invoke<Envelope<{ task: TaskRow | null; acceptanceCriteria: AcceptanceCriterion[] | null }>>("get_task", {
          taskId: id,
        }),
        invoke<Envelope<{ events: StoredEvent[] }>>("get_task_events", { taskId: id }),
      ]);
      const detailResult = unwrap(detailResponse);
      const eventsResult = unwrap(eventsResponse);
      // **틀을 여기서 다시 씌우지 않는다.** 종전에는 화면이 "작업을 읽을 수 없습니다: "를
      // 앞에 붙였는데 Rust도 같은 말을 붙이고 있어 문장이 두 번 겹쳤다.
      if (!detailResult.ok) return setNotice(detailResult.problem.text);
      if (!eventsResult.ok) return setNotice(eventsResult.problem.text);
      const detail = detailResult.value;
      const storedEvents = eventsResult.value.events;
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
      // 전송 자체가 실패한 경우. 봉투로 온 실패는 위에서 끝났다.
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
        // 다시 실행은 **새 승인**이다 — 지금 입력란에 있는 값이 이 실행의 상한이다.
        const result = await invoke<FinalResult>("restart_task", {
          taskId: id,
          ...budgetArgs(budgetText),
          modelPins: modelPins(pinExecutor, pinReviewer),
        });
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
  // **끝난 태스크의 단계도 phase에서 읽는다.** 종전에는 결과가 있으면 무조건 "완료"였는데,
  // 답변은 완료가 아니다(51절) — 그 구별이 여기서 사라지면 종착지를 나눈 이유도 사라진다.
  // 그래서 결과 유무로 갈라지 않는다: phase 하나가 답한다.
  const stage: UserStage = phaseToStage(phase);
  const stages = stagesFor(taskKind);

  const noProviders = providerStatus?.providers.every((p) => !p.configured) ?? false;

  return (
    <main className="app">
      <header className="topbar">
        <h1>Tomverse Code</h1>
        <div className="topbar-meta">
          {workspace ? (
            <span title={workspace.rootPath}>
              워크스페이스: <strong>{workspace.name}</strong>
              {/* **격리는 이름 옆에 붙인다.** 어디에 파일이 쓰이는지는 매 순간의 사실이고,
                  패널을 펼쳐야 보이면 잊힌다. */}
              {workspace.isolation && <span className="chip"> 격리: {workspace.isolation.branch}</span>}
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
          {/* 16절 워크스페이스 공급자 제한. **"키가 없다"와 "정책이 막았다"를 갈라 말한다** —
              뭉개면 사용자는 없는 키를 찾아 헤매거나 자기가 건 제한을 잊는다. */}
          {workspace && (
            <div className="chips">
              {providerStatus.providers.map((p) => {
                const blocked = workspace.providersBlockedByPolicy.includes(p.providerId);
                const allowed = workspace.allowedProviders === null || workspace.allowedProviders.includes(p.providerId);
                return (
                  <label key={`allow-${p.providerId}`} className="chip">
                    <input
                      type="checkbox"
                      checked={allowed}
                      disabled={running}
                      onChange={(e) => void toggleProvider(p.providerId, e.target.checked)}
                    />
                    이 워크스페이스에서 {p.providerId} 허용
                    {blocked && p.configured && <strong> (키는 있지만 정책이 막음)</strong>}
                  </label>
                );
              })}
            </div>
          )}
          {workspace?.allowedProviders?.length === 0 && (
            <p className="warn small">
              이 워크스페이스는 <strong>어떤 공급자도 허용하지 않습니다.</strong> 작업을 시작할 수 없습니다 — 위에서
              하나 이상을 켜세요.
            </p>
          )}
          {allowlistNotice && <p className="warn small">{allowlistNotice}</p>}

          {/* 17절 자격증명 확인. **무료 조회만 하므로 눌러도 돈이 나가지 않는다** —
              그 사실을 버튼 옆에 적는다. 안 적으면 예산 상한을 건 사용자가 누르기를 망설인다. */}
          {workspace && (
            <div className="row">
              <button className="secondary" onClick={() => void probeProviders()} disabled={probing}>
                {probing ? "확인 중..." : "자격증명 확인"}
              </button>
              <span className="muted small">무료 조회만 합니다 — 누른다고 비용이 나가지 않습니다.</span>
            </div>
          )}
          {credentialChecks?.map((c) => (
            <p key={c.providerId} className={c.status === "listed" ? "muted small" : "warn small"}>
              <strong>{c.providerId}</strong>{" "}
              {c.status === "listed"
                ? `조회됨 (${c.modelId})`
                : c.status === "auth_failed"
                  ? "키가 거부됐습니다"
                  : c.status === "model_unavailable"
                    ? "키는 받아들여졌지만 그 모델이 없습니다"
                    : "확인할 수 없었습니다 (네트워크)"}{" "}
              — {c.detail}
            </p>
          ))}
          {credentialChecks && credentialChecks.some((c) => c.status === "listed") && (
            <p className="muted small">
              <strong>"조회됨"은 "호출된다"가 아닙니다.</strong> 조직 인증이 필요한 모델은 조회는 되고 실제 호출에서
              실패합니다 — 이 확인은 키가 틀렸거나 만료된 경우를 잡습니다.
            </p>
          )}
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

      {/* 격리 실행이 **말하지 않으면 정반대로 읽히는 것들**(22.5절). 배너 자리인 이유:
          "결과가 본체에 없다"는 사실은 결과를 볼 때가 아니라 **작업을 시작하기 전에** 알아야
          한다. 문장은 Rust가 만든다 — 헤드리스는 stderr로 같은 것을 낸다. */}
      {(workspace?.isolationNotices?.length ?? 0) > 0 && (
        <section className="banner banner-warn">
          <ul className="small">
            {workspace?.isolationNotices?.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
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

          {/* 격리 실행 (state-machine 22·38절). **여는 시점에 정한다** — 게이트 루트가 sidecar
              수명과 묶여 있어 태스크마다 바꿀 수 없다. */}
          <fieldset className="policy">
            <legend>격리 실행 (선택)</legend>
            <div className="row">
              <input
                value={isolateBranch}
                onChange={(e) => setIsolateBranch(e.target.value)}
                placeholder="브랜치 이름 (비우면 본체에서 작업)"
                spellCheck={false}
              />
            </div>
            <p className="muted small">
              브랜치 이름을 적으면 <strong>같은 저장소의 별도 작업 트리</strong>에서 돕니다. 본체 파일은 바뀌지
              않고, 결과는 그 트리에 남습니다. 트리는 저장소 <strong>밖</strong>(앱 상태 디렉터리)에 만들어집니다 —
              안에 만들면 본체에서 도는 작업이 그 파일을 고칠 수 있어 격리가 아니게 됩니다.
            </p>
            {/* 22.4절: 못 받는 이름을 **조용히 바꾸지 않는다**. 미리 말한다. */}
            <p className="muted small">
              쓸 수 있는 이름: 영숫자와 <code>-</code> <code>_</code> <code>.</code>. <code>feature/x</code>처럼
              <code>/</code>가 든 이름은 받지 않습니다 — 이름을 우리가 바꾸면 사용자가 만든 브랜치와 다른 브랜치가
              생깁니다.
            </p>
          </fieldset>
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
            <SecretShapeWarning hits={messageSecrets} />
            <div className="row">
              {/* **바꿔 달라는 것인가 물어보는 것인가** (state-machine 51절).
                  사용자의 문장을 보고 우리가 추측하지 않는다 — 추측하면 "고쳐 달라"는 요청에
                  답만 하거나 그 반대가 되고, 둘 다 사용자가 원한 것이 아니다. */}
              <fieldset className="modes" disabled={running}>
                <legend>무엇을 할까요</legend>
                <label>
                  <input type="radio" checked={taskKind === "change"} onChange={() => setTaskKind("change")} />
                  고치기 — 계획하고 실행하고 검증합니다
                </label>
                <label>
                  <input type="radio" checked={taskKind === "question"} onChange={() => setTaskKind("question")} />
                  물어보기 — 파일을 바꾸지 않고 답만 합니다
                </label>
                {taskKind === "question" && (
                  // **검증되지 않는다는 사실을 미리 말한다.** 답을 받은 뒤에 알면 그건
                  // 도구가 숨긴 것으로 읽힌다(51.4절 — 이 경로에는 판정자가 없다).
                  <p className="muted small">
                    질문에는 실행할 것도 검사할 것도 없으므로 <strong>build/test가 판정하지 않습니다</strong>.
                  </p>
                )}
              </fieldset>
              <fieldset className="modes" disabled={running || taskKind === "question"}>
                <legend>실행 정책</legend>
                <label>
                  <input type="radio" checked={mode === "fast"} onChange={() => setMode("fast")} />
                  Fast — 쉬운 작업은 단일 모델
                </label>
                <label>
                  <input type="radio" checked={mode === "verified"} onChange={() => setMode("verified")} />
                  Verified — 항상 독립 검수 <span className="muted">(실행자를 둘 부릅니다)</span>
                </label>
                {/* **모드가 바꾸는 것은 대부분 비용인데 이름이 그걸 말하지 않고 있었다.**
                    경고가 아니라 사실 나열이다 — 계산은 화면 밖(lib/callPlan.ts)에 있고,
                    "모자랄 수 있습니다" 같은 예측은 하지 않는다(budgetCheck.ts의 규율). */}
                {describeCallPlan(mode, budgetLimit, models).map(
                  (line) => (
                    <p key={line} className="muted small">
                      {line}
                    </p>
                  )
                )}
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
              {/* 훅·MCP 등록 (29절). **워크스페이스 수명의 설정**이라 태스크 옵션과 나란히
                  두지 않는다 — 여기 두면 "이번 작업에만 적용되는가"로 읽힌다. */}
              {workspace && <WorkspaceSettingsPanel />}
              {/* 이 세션에서 정한 것과 그것을 거두는 자리 (30절). **세션 수명**이라 태스크
                  옵션이 아니라 워크스페이스 설정 옆에 둔다 — 태스크 옵션 자리에 있으면
                  "이번 작업에만 적용된다"로 읽히는데, 실제로는 다음 태스크들에 실린다. */}
              {workspace && <CarriedDecisionsPanel />}
              {/* 격리 트리 (22.6·38절). **워크스페이스 수명**이라 여기 둔다 — 태스크 옵션
                  자리에 있으면 "이번 작업만 격리한다"로 읽히는데, 격리는 여는 시점에 정해진다. */}
              {workspace && <WorktreePanel isolatedPath={workspace.isolation?.path ?? null} />}
              {/* 무인 실행 (state-machine 24절). **켜도 승인 정책은 그대로다** — 달라지는 것은
                  승인이 필요한 지점에서 묻는 대신 멈춘다는 것뿐이고, 그 정지는 사용자 거부로
                  기록되지 않는다(24.2절). */}
              <fieldset className="modes" disabled={running}>
                <legend>무인 실행</legend>
                <label>
                  <input type="checkbox" checked={unattended} onChange={(e) => setUnattended(e.target.checked)} />
                  승인을 묻지 않고, 필요한 지점에서 멈춤
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={autoApproveVerification}
                    onChange={(e) => setAutoApproveVerification(e.target.checked)}
                  />
                  프로젝트가 선언한 검증 명령은 묻지 않고 실행
                </label>
                {/* 무인 실행이 **어디서 멈추는지 미리** 말한다 — 멈춘 뒤에 알면 그건 도구의
                    오작동으로 읽힌다(24.5절). 종전에는 이 자리에 손으로 적은 문장 하나가
                    있었고("검증에서 멈춥니다"), 그건 여섯 개 정지 중 하나만 말한 것이었다.
                    이제 게이트에 물어서 전부 보여준다(47·48절). */}
                <AutopilotPreviewPanel
                  unattended={unattended}
                  mode={mode}
                  allowGitCommit={allowGitCommit}
                  autoApproveVerification={autoApproveVerification}
                  skillPath={skillPath.trim() === "" ? null : skillPath.trim()}
                  deadlineSecs={deadline.secs}
                  ready={Boolean(workspace)}
                />

                {/* 시한 (39절). **여기 두는 이유**: 시한이 필요한 까닭이 "물을 사람이 없다"는
                    것이므로, 무인 실행 스위치와 같은 자리에 있어야 한다. */}
                <div className="row">
                  <label htmlFor="deadline">시한 (분, 비우면 상한 없음)</label>
                  <input
                    id="deadline"
                    value={deadlineText}
                    onChange={(e) => setDeadlineText(e.target.value)}
                    placeholder="예: 30"
                    spellCheck={false}
                  />
                </div>
                {/* 읽지 못한 입력은 **상한 없음이 아니라 거부**다 — 바꿔치면 사용자는 상한을
                    걸었다고 믿는데 실행은 끝없이 돈다. */}
                {deadline.problem ? (
                  <p className="error small">{deadline.problem}</p>
                ) : (
                  <p className="muted small">{deadline.notice}</p>
                )}
              </fieldset>
              {/* 스킬 (26절). 파일을 **Rust가 읽는다** — 도구 허용목록의 출처가 화면이 되면
                  장악당한 화면이 "허용목록은 전부입니다"라고 말할 수 있다. */}
              <fieldset className="modes" disabled={running}>
                <legend>스킬 (비우면 사용 안 함)</legend>
                <label className="pin-row">
                  <input
                    value={skillPath}
                    onChange={(e) => setSkillPath(e.target.value)}
                    placeholder="skill.json 경로 (워크스페이스 밖)"
                    spellCheck={false}
                  />
                </label>
                <p className="muted small">
                  지시문은 프롬프트에 실리고 <strong>전송 내역에 집계됩니다</strong>. 도구 허용목록은 좁히기만
                  하며, 검증 명령은 적지 않아도 남습니다.
                </p>
                {/* 34절. **미리 말한다** — 거부된 뒤에 알면 사용자는 경로 오타를 의심한다. */}
                <p className="muted small">
                  스킬 파일은 <strong>워크스페이스 밖</strong>에 있어야 합니다. 워크스페이스 안의 파일은 모델이
                  고칠 수 있고, 그러면 모델이 자기 프롬프트에 지시문을 심거나 좁혀 둔 허용목록을 되돌릴 수 있습니다.
                </p>
                {/* 보관함에서 고르기 (36절). **직접 경로 입력을 없애지 않는다** — 보관함에
                    넣을 수 없는 상황에서 기능 자체를 못 쓰게 되기 때문이다. 목록은 더 쉬운
                    길이지 유일한 길이 아니다. */}
                {workspace && (
                  <SkillLibraryPicker value={skillPath} onPick={setSkillPath} disabled={running} />
                )}
              </fieldset>
              {/* 역할별 모델 지정 (multi-engine-routing.md 15절).
                  **목록이 비면 이 블록 자체를 그리지 않는다** — 빈 select는 "고를 것이 없다"와
                  "목록을 못 읽었다"를 구별하지 못하고, 어느 쪽이든 사용자가 할 일은 없다. */}
              {models.length > 0 && (
                <fieldset className="modes" disabled={running}>
                  <legend>모델 지정 (비우면 자동)</legend>
                  <label className="pin-row">
                    실행자
                    <select value={pinExecutor} onChange={(e) => setPinExecutor(e.target.value)}>
                      <option value="">자동</option>
                      {models.map((m) => (
                        <option key={m.modelId} value={m.modelId}>
                          {m.modelId} · ${m.inputPerMTok}/${m.outputPerMTok} per MTok
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="pin-row">
                    검수자
                    <select value={pinReviewer} onChange={(e) => setPinReviewer(e.target.value)}>
                      <option value="">자동</option>
                      {models.map((m) => (
                        <option key={m.modelId} value={m.modelId}>
                          {m.modelId} · ${m.inputPerMTok}/${m.outputPerMTok} per MTok
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted small">
                    지정한 모델은 <strong>다른 모델로 대체하지 않습니다</strong> — 쓸 수 없으면 시작하지 않고 이유를
                    알려줍니다. 그리고 지정한 검수자가 실행자와 같은 공급자면{" "}
                    <strong>검수를 드롭합니다</strong>: 같은 공급자로 "검증한 척"하지 않는 것이 이 도구가 파는 것입니다.
                  </p>
                  <p className="muted small">
                    대조용 두 번째 실행자는 고를 수 없습니다 — 그 표본의 유일한 일이 첫 번째와 다른 것이라, 둘을 같게
                    만들면 "불일치 없음"이 정보가 아니라 착시가 됩니다.
                  </p>
                </fieldset>
              )}

              {/* 예산 상한 (multi-engine-routing.md 10.6절).
                  **비워 두면 상한 없음이고, 화면이 그렇게 말한다.** 0을 "무제한"으로 읽지
                  않는 이유는 budgetArgs 주석에 있다. */}
              <fieldset className="modes" disabled={running}>
                <legend>이 작업의 예산 상한</legend>
                <label className="budget-input">
                  $
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={budgetText}
                    placeholder="비우면 상한 없음"
                    onChange={(e) => setBudgetText(e.target.value)}
                  />
                </label>
                {budgetText.trim().length === 0 ? (
                  <p className="small warn">
                    <strong>상한 없이 실행합니다.</strong> 공급자 호출은 사용자 키로 청구되며, 이 앱은 그것을
                    막지 않습니다.
                  </p>
                ) : (
                  <p className="muted small">
                    이 작업 하나에만 적용됩니다 — 다시 실행하면 상한만큼 다시 쓸 수 있습니다.
                    {budgetSuggestion &&
                      (budgetSuggestion.source === "measured"
                        ? ` 제안값은 이 워크스페이스의 지난 작업 ${budgetSuggestion.sampleCount}건에서 유도했습니다(p90 × ${budgetSuggestion.headroomMultiplier}).`
                        : ` 제안값은 아직 관측이 부족해(${budgetSuggestion.sampleCount}/${budgetSuggestion.minSamples}건) 기본값입니다.`)}
                  </p>
                )}
                {/* **확실할 때만 말한다.** "비쌀 수도 있습니다"는 하지 않는다 — 틀릴 수 있는
                    경고는 몇 번 지나면 읽히지 않고, 그러면 맞는 경고도 함께 묻힌다. */}
                {budgetPrecheck.certainRefusal && (
                  <p className="warn small">
                    <strong>이 상한으로는 첫 호출부터 거부됩니다.</strong> {budgetPrecheck.basisModelId} 한 번
                    호출의 최대 비용이 ${budgetPrecheck.requiredUsd?.toFixed(4)}인데 상한이 그보다 작습니다 — 상한을
                    올리거나 더 싼 모델을 고르세요.
                  </p>
                )}
              </fieldset>
              {/* 막지 않고 문구만 바꾼다. 자격증명 모양이 진짜 요구의 일부일 수 있고
                  ("sk-로 시작하는 키를 거부해야 한다"), 무엇이 자기 요구인지는 사용자가
                  판정한다(원칙 1). 대신 그대로 보내는 중이라는 사실은 눈에 남긴다. */}
              {/* 읽지 못한 시한으로는 시작하지 않는다 — "상한을 걸었다"고 믿는 채로 상한 없이
                  도는 것이 이 입력에서 가장 나쁜 결말이다(39절). */}
              <button
                onClick={runTask}
                disabled={running || message.trim().length === 0 || noProviders || deadline.problem !== undefined}
              >
                {running ? "실행 중..." : messageSecrets.length > 0 ? "그대로 실행" : "실행"}
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

          {/* **커밋이 커서 문제라면 고칠 곳은 커밋이 아니라 요청 단위다**(19.6절).
              커밋을 보고 "컸네"라고 말하는 것은 이미 늦다 — 그때는 파일이 다 바뀐 뒤라
              쪼갤 수 있는 것이 없다. 그래서 계획 시점에, 아직 취소할 수 있을 때 말한다.

              **막지 않는다.** 파일 30개를 건드리는 이름 바꾸기는 정당하게 한 작업이고,
              무엇이 한 작업인지는 우리가 판정할 수 없다. 사실만 말하고 판단은 넘긴다. */}
          {running && allowGitCommit && plannedPaths.length >= largeChangeFiles && (
            <div className="warn small">
              <p>
                이 계획은 <strong>{plannedPaths.length}개 파일</strong>을 바꿉니다. 검증을 통과하면{" "}
                <strong>커밋 하나</strong>로 남고, 나중에 되돌릴 때도 전부 아니면 전무입니다.
              </p>
              <p>
                관심사가 섞여 있다면 지금 취소하고 더 작게 나눠 요청하는 편이 낫습니다 — 커밋을 쪼개는 것은 이 앱이
                하지 않습니다. 조각마다 테스트를 돌린 적이 없어 <strong>"검증 통과"를 말할 수 없기</strong> 때문입니다.
              </p>
              {devMode && (
                <p className="muted">
                  문턱 {largeChangeFiles}개 —{" "}
                  {largeChange?.source === "measured"
                    ? `이 워크스페이스의 커밋 ${largeChange.sampleCount}건에서 유도(p90)`
                    : `표본 부족(${largeChange?.sampleCount ?? 0}/${largeChange?.minSamples ?? 0})으로 기본값`}
                </p>
              )}
            </div>
          )}

          <StageBar current={stage} stages={stages} phase={phase} devMode={devMode} />
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
                    <ContrastNote events={events} appliedPolicies={routing.appliedPolicies} />
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

              {/* 37절: **이 태스크가 무엇을 가지고 도는가.** "이번 태스크" 바로 아래에 둔다 —
                  경과·비용은 얼마나 썼는가이고, 이건 무엇을 켠 채로 쓰고 있는가다. 그리고
                  화면 입력칸이 아니라 Rust가 고정한 이벤트에서 읽으므로, 요청과 적용이
                  갈렸을 때 갈린 쪽을 보여준다. */}
              <EffectiveConfigPanel events={events} />

              {/* 3.9절 불일치 카드가 3.4절 확인 필요 카드를 **대체한다** — 같이 뜨면
                  사용자가 같은 질문에 두 번 답하게 된다. 두 상황이 다르므로 카드도 다르다. */}
              {questions && disagreements.length > 0 && (
                <DisagreementCard
                  disagreements={disagreements}
                  narratives={narratives}
                  onSubmit={submitDecisions}
                  devMode={devMode}
                />
              )}

              {questions && disagreements.length === 0 && (
                <div className="panel highlight">
                  <h2>확인이 필요합니다</h2>
                  <ul>
                    {questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                  <SecretShapeWarning hits={answerSecrets} />
                  <div className="row">
                    <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="답변 입력" />
                    <button onClick={submitAnswer} disabled={answer.trim().length === 0}>
                      {answerSecrets.length > 0 ? "그대로 전송" : "전송"}
                    </button>
                  </div>
                </div>
              )}

              {/* 답변은 완료가 아니다 — 다른 패널로 그린다(51절, ui-wireframes 3.26절). */}
              <AnswerPanel answer={finalResult?.answer} />

              {finalResult && finalResult.status !== "answered" && (
                <div className={`panel result result-${finalResult.status}`}>
                  <h2>{statusLabel(finalResult.status)}</h2>
                  {/* **무엇이 이 결과를 뒷받침하는가** — product-strategy.md 11절·16.5절.
                      완료 표시 옆에 이게 없으면, 검증이 침묵한 작업이 통과한 작업과 같은
                      신뢰 수준으로 읽힌다. 계산은 화면 밖(src/lib)에 있다. */}
                  {(() => {
                    const basis = resultBasis({
                      overall: [...reports].reverse().find((r) => r.phase === "post")?.overall,
                      criteria: finalResult.acceptanceCriteria,
                      evaluations: finalResult.criterionEvaluations,
                    });
                    return (
                      <p className={`basis basis-${basis.kind}`}>
                        <span className={`badge badge-basis-${basis.deterministic ? "deterministic" : "weak"}`}>
                          {basis.label}
                        </span>{" "}
                        <span className="muted small">{basis.detail}</span>
                      </p>
                    );
                  })()}
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

              {/* 7절 데이터 전송 투명성. 결과 **아래**에 두는 이유: 사용자가 먼저 묻는 것은
                  "됐는가"이고, "무엇이 나갔는가"는 그 다음이다. 위에 두면 매번 그 다음 질문이
                  먼저 눈에 들어와, 정작 결과를 읽기 전에 스크롤하게 된다. */}
              {/* 비용은 전송 내역보다 **위**다. "무엇이 나갔는가"보다 "얼마가 나갔는가"를
                  먼저 묻고, 특히 상한 없이 돌았다면 그 사실이 눈에 먼저 들어와야 한다. */}
              {finalResult?.budget && <BudgetPanel budget={finalResult.budget} />}

              {transmission && <TransmissionPanel transmission={transmission} />}

              {/* 6.3절 감사 export. 전송 패널보다 **아래**에 둔다 — "무엇이 나갔는가"는 이 작업을
                  보는 사람의 질문이고, "감사에 낼 기록을 다오"는 다른 시점의 질문이다. */}
              {finalResult && <AuditExportPanel taskId={finalResult.taskId} />}
              {/* 무인 정지의 처방(24.8절)과 PR 올리기(28절). 둘 다 **끝난 작업에 대한 질문**이라
                  결과 옆에 둔다 — 진행 중에는 답이 아직 없다. */}
              {finalResult && <BlockedPanel taskId={finalResult.taskId} />}
              {finalResult && <PullRequestPanel taskId={finalResult.taskId} />}
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
              <DiffPanel diffs={diffs} largeChangeFiles={largeChangeFiles} />
            </div>
          </section>

          <EventLog events={events} devMode={devMode} />
        </>
      )}

      {/* 히스토리는 워크스페이스 선택 여부와 무관하게 보인다 — 앱을 켜자마자
          중단된 작업이 있는지 알아야 하기 때문이다. */}
      {/* 백엔드가 사용자 개입을 요구하는 상태일 때만 뜬다. 자동으로 복구될 상태에서는 뜨지
          않는다 — 필요 없는 조치를 요구하면 사용자는 배너를 무시하는 법을 배운다. */}
      {banner && (
        // `data-untranslated`는 **개발자용 표시다.** 카탈로그가 모르는 코드가 원문으로 떨어진
        // 상태이며, 눈에 보이는 처리는 두 번째 언어가 생길 때 정한다(ui-wireframes 6절).
        // 지금은 언어가 하나뿐이라 원문과 번역이 같은 문장이다.
        <p className="error" data-untranslated={banner.untranslated || undefined}>
          {banner.message}
          {reopenPath && (
            <button className="secondary tiny" onClick={() => void reopenBackend()} disabled={opening || running}>
              워크스페이스 다시 열기
            </button>
          )}
        </p>
      )}
      {storeError && <p className="error">작업 기록을 읽을 수 없습니다: {storeError}</p>}
      <TaskHistory
        tasks={tasks}
        selectedId={selectedTask?.task.taskId ?? null}
        busy={historyBusy || running}
        onSelect={(id) => void selectTask(id)}
        onRollback={(id) => void rollbackTask(id)}
        onRestart={(id) => void restartTask(id)}
        onRefresh={() => void refreshTasks()}
        hasMore={hasMore(taskList)}
        countLabel={countLabel(taskList)}
        onLoadMore={() => void loadMoreTasks()}
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
          {/* 지난 작업에도 같은 질문이 있다 — **그때 무엇을 가지고 돌았는가.** 그 답이 여기
              없으면 사용자는 지금의 설정으로 지난 결과를 읽는다. 이 이벤트가 없던 시절의
              기록에서는 패널이 스스로 사라진다(지어내지 않는다). */}
          <EffectiveConfigPanel events={selectedTask.events} />
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
    // **"완료"라고 쓰지 않는다** — 51절이 종착지를 나눈 이유가 화면에서 사라진다.
    // 이 자리는 실제로는 쓰이지 않는다(답변은 `AnswerPanel`이 그린다) — 그래도 적어 둔다:
    // 나중에 이 함수를 다른 자리에서 쓰면 그때 기본값이 "완료"가 되기 때문이다.
    case "answered":
      return "답변함";
  }
}

function currentTaskId(events: TaskEvent[], fallback: string | null): string | null {
  const last = events[events.length - 1];
  return last?.taskId ?? fallback;
}

/**
 * 대조가 무엇을 말했는가 — **조용한 것도 주장이다**(state-machine 17절).
 *
 * 갈린 것이 있을 때만 카드가 뜨므로, "대조했는데 같았다"와 "대조하지 않았다"가 사용자에게는
 * 똑같이 빈 화면이었다. 그 침묵이 하필 가장 위험한 쪽으로 읽힌다 — 두 모델이 같은 방식으로
 * 틀리면 불일치가 생기지 않기 때문이다(product-strategy 9.2-B).
 *
 * **초록색을 쓰지 않는다.** 판정은 `lib/contrastSummary.ts`가 하고 여기서는 그리기만 한다.
 */
function ContrastNote({ events, appliedPolicies }: { events: TaskEvent[]; appliedPolicies: string[] }) {
  const summary = summarizeContrast({ detected: findContrast(events), appliedPolicies });
  if (!summary) return null;
  return (
    <div className={`contrast-note contrast-${summary.kind}`}>
      <p className="small">{summary.note}</p>
      {summary.kind === "disagreed" && (
        <p className="muted small">
          답을 요구한 항목 {summary.askedCount}건 · 함께 실은 참고 항목 {summary.advisoryCount}건
        </p>
      )}
      {summary.agreedFields.length > 0 && (
        <p className="muted small">같았던 항목: {summary.agreedFields.join(", ")}</p>
      )}
    </div>
  );
}

/** 마지막 `DISAGREEMENT_DETECTED` — 대조를 돌렸는지와 그 결과. */
function findContrast(events: TaskEvent[]): ContrastInput["detected"] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "DISAGREEMENT_DETECTED") {
      return events[i]!.payload as unknown as ContrastInput["detected"];
    }
  }
  return undefined;
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
