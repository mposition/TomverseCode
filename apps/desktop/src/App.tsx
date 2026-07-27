import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import {
  phaseToStage,
  STAGE_ORDER,
  type ApprovalRequest,
  type FinalResult,
  type ProviderStatus,
  type RoutingInfo,
  type TaskEvent,
  type TaskPhase,
  type UsageTotals,
  type UserStage,
  type VerificationReport,
  type WorkspaceInfo,
} from "./types";
import { ApprovalModal } from "./components/ApprovalModal";
import { DiffPanel } from "./components/DiffPanel";
import { EventLog } from "./components/EventLog";
import { StageBar } from "./components/StageBar";
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
export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"fast" | "verified">("verified");

  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<TaskPhase>("CREATED");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [answer, setAnswer] = useState("");
  const [devMode, setDevMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const startedAt = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    void invoke<ProviderStatus>("provider_status").then(setProviderStatus).catch(() => undefined);
    void invoke<WorkspaceInfo | null>("current_workspace").then((info) => info && setWorkspace(info));
  }, []);

  // 경과 시간 표시 (ui-wireframes.md 3.5절)
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (startedAt.current !== null) setElapsedMs(Date.now() - startedAt.current);
    }, 200);
    return () => clearInterval(timer);
  }, [running]);

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
        const q = (payload.payload as { questionsForUser?: string[] }).questionsForUser;
        if (q && q.length > 0) setQuestions(q);
      }
      if (payload.type === "USER_MESSAGE_RECEIVED") setQuestions(null);
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
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setOpening(false);
    }
  }, [workspacePath]);

  const runTask = useCallback(async () => {
    if (!workspace || message.trim().length === 0) return;
    setRunning(true);
    setEvents([]);
    setFinalResult(null);
    setQuestions(null);
    setNotice(null);
    setPhase("CREATED");
    startedAt.current = Date.now();
    setElapsedMs(0);
    try {
      const result = await invoke<FinalResult>("start_task", { message, mode });
      setFinalResult(result);
      setTaskId(result.taskId);
    } catch (error) {
      setFinalResult({ taskId: taskId ?? "(unknown)", status: "failed", summary: String(error) });
    } finally {
      setRunning(false);
    }
  }, [workspace, message, mode, taskId]);

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
    try {
      await invoke("cancel_task", { taskId: id });
    } catch (error) {
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
    } catch (error) {
      setNotice(`답변 전달 실패: ${String(error)}`);
    }
  }, [events, taskId, answer]);

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
              <button onClick={runTask} disabled={running || message.trim().length === 0 || noProviders}>
                {running ? "실행 중..." : "실행"}
              </button>
              {running && (
                <button className="secondary" onClick={cancel}>
                  취소
                </button>
              )}
            </div>
            <p className="muted small">
              어느 정책을 골라도 빌드·테스트 검증은 생략되지 않습니다. Fast는 LLM 두 개의 상호 검토만 건너뜁니다.
            </p>
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

              {questions && (
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
                        되돌리기
                      </button>
                      {finalResult.status === "failed" && (
                        <p className="muted small">
                          실패한 작업은 되돌리기가 기본 권장입니다 — 깨진 상태를 방치하지 않기 위해서입니다.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="column">
              <VerificationPanel reports={reports} />
              <DiffPanel diffs={diffs} />
            </div>
          </section>

          <EventLog events={events} devMode={devMode} />
        </>
      )}

      {approval && <ApprovalModal request={approval} onRespond={respondApproval} />}
    </main>
  );
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
