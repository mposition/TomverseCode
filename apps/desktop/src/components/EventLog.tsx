import { useEffect, useRef } from "react";
import type { TaskEvent } from "../types";
import { describeDeveloperEnv, toolEventDeservesAttention } from "../lib/developerEnv";

/**
 * 실시간 이벤트 로그.
 *
 * 이건 단순한 디버그 뷰가 아니라 제품의 차별화 지점이다 — README "데이터 전송 투명성",
 * "모든 실행은 로컬 정책 엔진 승인 후에만". 무슨 판단이 어떤 근거로 내려졌는지 사용자가
 * 직접 볼 수 있어야 그 주장이 검증 가능해진다.
 *
 * 기본 모드에서는 의미 있는 이벤트만, 개발자 모드에서는 원본 payload까지 보여준다.
 */
const IMPORTANT: string[] = [
  "TASK_CREATED",
  "SNAPSHOT_CREATED",
  "TRIAGE_COMPLETED",
  "ROUTING_DECIDED",
  "DRAFT_RECEIVED",
  "REVIEW_RECEIVED",
  "PLAN_CREATED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_DENIED",
  "POLICY_DECIDED",
  "FILE_MUTATED",
  "VERIFICATION_COMPLETED",
  "FIX_LOOP_STARTED",
  // 모델이 낡은 파일 내용을 받았다는 뜻이다 — 그 뒤 패치가 어긋난 이유가 여기 있다.
  "SNAPSHOT_REFRESH_FAILED",
  "PROVIDER_RETRY",
  "TOOL_RETRY",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
  "ERROR",
  // 취소는 요청 시점과 실제 종료 시점이 다르다 — 그 사이에 무엇이 건너뛰어졌는지가
  // "취소가 정말 됐나"를 판단하는 근거이므로 기본 모드에서도 보여준다.
  "CANCELLATION_REQUESTED",
  "TOOL_SKIPPED_CANCELLED",
  "VERIFICATION_SKIPPED_CANCELLED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
  "TASK_INTERRUPTED",
  "TASK_REJECTED",
];

/**
 * 실시간 이벤트(`TaskEvent`)와 DB에서 읽어온 이벤트(`StoredEvent`)를 모두 받는다.
 * 차이는 `taskId` 유무뿐이다 — 저장된 이벤트는 이미 어느 작업의 것인지 알고 조회한 것이라 없다.
 */
type DisplayEvent = Omit<TaskEvent, "taskId"> & { taskId?: string };

export function EventLog({ events, devMode }: { events: DisplayEvent[]; devMode: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  // 기본 모드에서는 주요 이벤트만. **예외가 하나 있다**(40절): 개발자 환경을 준비하지 못한
  // 도구 실행은 보여야 한다 — 그 한 줄이 없으면 사용자는 `stdarg.h`만 보게 되고, 그건 원인을
  // 가리키지 않는다. 정상적으로 준비된 실행은 그대로 조용하다.
  const visible = devMode
    ? events
    : events.filter((e) => IMPORTANT.includes(e.type) || toolEventDeservesAttention(e.payload));

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [visible.length]);

  return (
    <section className="panel eventlog">
      <h2>
        이벤트 로그 <span className="muted small">({visible.length}건{devMode ? "" : " — 주요 이벤트만"})</span>
      </h2>
      {visible.length === 0 ? (
        <p className="muted">아직 이벤트가 없습니다.</p>
      ) : (
        <ol>
          {visible.map((event) => (
            <li key={`${event.taskId ?? "stored"}-${event.eventId}`} className={eventClass(event.type)}>
              <span className="event-seq">#{event.seq}</span>
              <span className="event-type">{event.type}</span>
              <span className="event-summary">{summarize(event)}</span>
              {devMode && <pre className="event-payload">{JSON.stringify(event.payload, null, 2)}</pre>}
            </li>
          ))}
        </ol>
      )}
      <div ref={endRef} />
    </section>
  );
}

function eventClass(type: string): string {
  if (type.startsWith("TASK_FAILED") || type === "ERROR" || type === "APPROVAL_DENIED") return "event event-error";
  if (type === "TASK_COMPLETED") return "event event-ok";
  if (type === "CANCELLATION_REQUESTED" || type.endsWith("_SKIPPED_CANCELLED") || type === "TASK_CANCELLED")
    return "event event-cancel";
  if (type === "TASK_INTERRUPTED") return "event event-cancel";
  if (type.startsWith("APPROVAL") || type === "POLICY_DECIDED") return "event event-policy";
  return "event";
}

/** 이벤트별 한 줄 요약. 원본을 보고 싶으면 개발자 모드를 켠다. */
function summarize(event: DisplayEvent): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "SNAPSHOT_CREATED": {
      const files = (p.relevantFiles as { path: string }[] | undefined) ?? [];
      const excluded = (p.excludedNotes as unknown[] | undefined) ?? [];
      // 같은 태스크에 이 이벤트가 여러 개 남는 이유를 한 줄로 말해준다 — 없으면 왜 두 번
      // 찍혔는지 알 수 없고, 두 번째가 첫 번째를 대체한다는 사실도 보이지 않는다.
      const refreshed = p.refreshedAfterMutation as
        | { changed?: string[]; added?: string[]; removed?: string[] }
        | undefined;
      const mark = refreshed
        ? `(변경 이후 다시 읽음 — 바뀜 ${refreshed.changed?.length ?? 0} · 추가 ${
            refreshed.added?.length ?? 0
          } · 빠짐 ${refreshed.removed?.length ?? 0}) `
        : "";
      return `${mark}모델에 전달된 파일 ${files.length}개${excluded.length > 0 ? `, 제외 ${excluded.length}개` : ""}: ${files
        .map((f) => f.path)
        .join(", ")}`;
    }
    case "SNAPSHOT_REFRESH_FAILED":
      return `변경 이후 파일을 다시 읽지 못해 이전 내용으로 진행합니다: ${String(p.error)}`;
    case "TRIAGE_COMPLETED":
      return `복잡도 ${String(p.complexityTier)}`;
    case "ROUTING_DECIDED": {
      const assignments = (p.assignments as { role: string; modelId: string }[] | undefined) ?? [];
      return `${assignments.map((a) => `${a.role}=${a.modelId}`).join(", ")}${
        p.reviewerIndependent === false ? " (독립 검수 없음)" : ""
      }`;
    }
    case "POLICY_DECIDED":
      return `${String(p.decision)} — ${String(p.normalizedTarget)} (${String(p.matchedRule)})`;
    case "APPROVAL_REQUESTED": {
      const items = (p.items as { tool: string }[] | undefined) ?? [];
      return `${items.map((i) => i.tool).join(", ")}`;
    }
    case "FILE_MUTATED":
      return String(p.path);
    case "VERIFICATION_COMPLETED":
      return `${String(p.phase)}: ${String(p.overall)}`;
    case "FIX_LOOP_STARTED":
      return `재시도 ${String(p.attempt)}/${String(p.max)}`;
    case "PROVIDER_RETRY":
      return `${String(p.callId)} 재시도 ${String(p.attempt)}/${String(p.max)} (${String(p.errorKind)})`;
    case "REVIEW_RECEIVED":
      return `${String(p.verdict)} — ${truncate(String(p.rationale ?? ""), 120)}`;
    case "DRAFT_RECEIVED":
      return truncate(String(p.interpretation ?? p.rationale ?? ""), 120);
    case "CANCELLATION_REQUESTED":
      return `취소 요청됨 — ${String(p.reason ?? "")}`;
    case "TOOL_COMPLETED": {
      // **개발자 환경 준비 결과를 여기서 말한다**(40절). 준비하지 못한 채 `cargo build`가
      // 실패하면 사용자가 보는 것은 `stdarg.h` 한 줄이고, 그 문장은 원인을 가리키지 않는다.
      // 판정과 문장은 화면 밖(src/lib)에 있다.
      const env = describeDeveloperEnv((p.output as Record<string, unknown> | undefined)?.developerEnv);
      const exit = p.exitCode ?? (p.output as Record<string, unknown> | undefined)?.exitCode;
      const head = `${String(p.tool ?? "")}${exit === undefined || exit === null ? "" : ` (exit ${String(exit)})`}`;
      return env ? `${head} — ${env}` : head;
    }
    case "TOOL_SKIPPED_CANCELLED":
      return `취소로 건너뜀: ${String(p.tool ?? "")}`;
    case "VERIFICATION_SKIPPED_CANCELLED":
      return `취소로 검증을 시작하지 않았습니다 (${String(p.phase ?? "")})`;
    case "TASK_INTERRUPTED":
      return `${String(p.interruptedAtPhase ?? "")} 단계에서 중단 — ${String(p.reason ?? "")}`;
    case "TASK_COMPLETED":
    case "TASK_FAILED":
    case "TASK_CANCELLED":
    case "TASK_REJECTED":
      return String(p.summary ?? "");
    case "ERROR":
      return String(p.message ?? "");
    default:
      return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
