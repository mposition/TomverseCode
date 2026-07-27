import { useEffect, useRef } from "react";
import type { TaskEvent } from "../types";

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
  "PROVIDER_RETRY",
  "TOOL_RETRY",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
  "ERROR",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
  "TASK_REJECTED",
];

export function EventLog({ events, devMode }: { events: TaskEvent[]; devMode: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const visible = devMode ? events : events.filter((e) => IMPORTANT.includes(e.type));

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
            <li key={`${event.taskId}-${event.seq}`} className={eventClass(event.type)}>
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
  if (type.startsWith("APPROVAL") || type === "POLICY_DECIDED") return "event event-policy";
  return "event";
}

/** 이벤트별 한 줄 요약. 원본을 보고 싶으면 개발자 모드를 켠다. */
function summarize(event: TaskEvent): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "SNAPSHOT_CREATED": {
      const files = (p.relevantFiles as { path: string }[] | undefined) ?? [];
      const excluded = (p.excludedNotes as unknown[] | undefined) ?? [];
      return `모델에 전달된 파일 ${files.length}개${excluded.length > 0 ? `, 제외 ${excluded.length}개` : ""}: ${files
        .map((f) => f.path)
        .join(", ")}`;
    }
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
