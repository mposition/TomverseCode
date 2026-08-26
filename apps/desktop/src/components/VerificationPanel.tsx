import { attributionView, mixedLabel } from "../lib/verifyAttribution";
import type { VerificationCheck, VerificationReport, VerificationStatus } from "../types";

/**
 * 검증 결과 패널 — docs/design/ui-wireframes.md 3.7절.
 *
 * 여기서 중요한 것은 **5가지 상태를 뭉개지 않는 것**이다. "명령이 없어서 실행하지 않음"을
 * 통과 표시(✓)로 보여주면 UI가 사용자에게 거짓말을 하게 된다 — 이 제품의 명제가 무너지는 지점이다.
 */
export function VerificationPanel({ reports }: { reports: VerificationReport[] }) {
  if (reports.length === 0) {
    return (
      <div className="panel">
        <h2>검증 결과</h2>
        <p className="muted">아직 검증이 실행되지 않았습니다.</p>
      </div>
    );
  }

  const baseline = reports.find((r) => r.phase === "baseline");
  const post = [...reports].reverse().find((r) => r.phase === "post");

  return (
    <div className="panel">
      <h2>검증 결과</h2>

      {baseline && (
        <section className="verify-block">
          <h3>
            작업 전 (baseline) <OverallBadge overall={baseline.overall} />
          </h3>
          <CheckList checks={baseline.checks} />
        </section>
      )}

      {post ? (
        <section className="verify-block">
          <h3>
            작업 후 {post.attemptNumber > 0 && <span className="muted">(재시도 {post.attemptNumber}회차)</span>}{" "}
            <OverallBadge overall={post.overall} />
          </h3>
          <CheckList checks={post.checks} />
          <Attribution report={post} />
        </section>
      ) : (
        <p className="muted small">작업 후 검증은 아직 실행되지 않았습니다.</p>
      )}
    </div>
  );
}

/**
 * 실패의 귀속 — state-machine 54절, ui-wireframes 3.28절.
 *
 * 종전에는 두 줄이었고 둘 다 **체크 이름**만 실었다. 그래서 원래 실패하는 테스트가 하나 있는
 * 체크에서 이번 변경이 셋을 더 깨뜨리면 사용자는 그 체크가 "변경 전부터 실패 중"이라고만
 * 읽었다 — 54절이 모델에게 하던 거짓말과 같고, 청중만 다르다.
 *
 * 판정은 여기서 하지 않는다: `lib/verifyAttribution.ts`가 갈라 준다.
 */
function Attribution({ report }: { report: VerificationReport }) {
  const view = attributionView(report);
  if (!view.show) return null;

  return (
    <div className="attribution">
      {view.brokeOnly.length > 0 && (
        <>
          <p className="error small">이번 변경으로 새로 실패</p>
          {view.brokeOnly.map((g) => (
            <TestGroup key={g.kind} kind={g.kind} tests={g.newTests} split={g.split} tone="error" />
          ))}
        </>
      )}

      {/* **여기가 종전에 사라지던 자리다.** 섞인 체크를 따로 묶지 않으면 두 줄에 다 나와
          자기모순으로 읽히고, 이름을 보여 주지 않으면 어느 쪽이 내 책임인지 알 수 없다. */}
      {view.mixed.map((g) => (
        <div key={g.kind} className="attribution-mixed">
          <p className="error small">{mixedLabel(g)}</p>
          {g.split && (
            <>
              <TestGroup kind="이번 변경이 깨뜨림" tests={g.newTests} split tone="error" />
              <TestGroup kind="변경 전부터 실패" tests={g.oldTests} split tone="warn" />
            </>
          )}
        </div>
      ))}

      {view.oldOnly.length > 0 && (
        <>
          <p className="warn small">변경 전부터 실패 중이던 항목 — 이번 변경과 무관합니다</p>
          {view.oldOnly.map((g) => (
            <TestGroup key={g.kind} kind={g.kind} tests={g.oldTests} split={g.split} tone="warn" />
          ))}
        </>
      )}

      {/* **고친 것도 말한다**(54.4절). 새 실패만 보여 주면 사용자는 변경이 순전히 나빴다고 읽는다. */}
      {view.fixed.map((f) => (
        <TestGroup key={`fixed-${f.kind}`} kind={`${f.kind} — 이번 변경으로 통과로 바뀜`} tests={f.tests} split tone="muted" />
      ))}

      {view.unsplitNote && <p className="muted small">{view.unsplitNote}</p>}
    </div>
  );
}

/** 이름 목록 한 묶음. **가르지 못했으면 목록 자체를 그리지 않는다** — 빈 목록은 "없다"로 읽힌다. */
function TestGroup({
  kind,
  tests,
  split,
  tone,
}: {
  kind: string;
  tests: string[];
  split: boolean;
  tone: "error" | "warn" | "muted";
}) {
  if (!split || tests.length === 0) {
    return <p className={`${tone} small`}>{kind}</p>;
  }
  return (
    <div className="attribution-group">
      <p className={`${tone} small`}>
        {kind} ({tests.length})
      </p>
      <ul className="transmission-files">
        {tests.map((name) => (
          <li key={name}>
            <code>{name}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckList({ checks }: { checks: VerificationCheck[] }) {
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={`${check.kind}-${check.status}`} className={`check check-${check.status}`}>
          <span className="check-mark">{statusMark(check.status)}</span>
          <span className="check-kind">{check.kind}</span>
          <span className="check-summary">{check.summary}</span>
          {check.durationMs !== undefined && <span className="muted small">{(check.durationMs / 1000).toFixed(1)}s</span>}
          {check.command && (
            <code className="muted small">{[check.command.program, ...check.command.args].join(" ")}</code>
          )}
          {check.detail && (
            <details>
              <summary>출력 보기</summary>
              <pre>{check.detail}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 5가지 상태를 각각 다르게 표시한다. NOT_CONFIGURED는 통과가 아니다. */
function statusMark(status: VerificationStatus): string {
  switch (status) {
    case "PASSED":
      return "✓";
    case "FAILED":
      return "✗";
    case "TIMED_OUT":
      return "⏱";
    case "NOT_CONFIGURED":
      return "–";
    case "SKIPPED_WITH_REASON":
      return "⊘";
  }
}

/**
 * 종합 판정 4값. **"검증되지 않음"의 원인을 단정하지 않는다.**
 *
 * 종전에는 `not_verified` 하나에 "명령이 없음"과 "돌리지 못함"이 뭉쳐 있었고, 라벨은 언제나
 * 전자를 단정했다 — 스크립트가 있는데 실행에 실패한 사용자에게 "명령이 없습니다"라고 말한 것이다.
 * 원인이 다르면 **사용자가 할 일이 다르므로** 라벨도 달라야 한다.
 */
function OverallBadge({ overall }: { overall: VerificationReport["overall"] }) {
  const label = overallLabel(overall);
  return <span className={`badge badge-overall-${overall}`}>{label}</span>;
}

function overallLabel(overall: VerificationReport["overall"]): string {
  switch (overall) {
    case "pass":
      return "통과";
    case "fail":
      return "실패";
    case "not_configured":
      return "검증되지 않음 (실행할 검증 명령이 없음)";
    case "could_not_run":
      return "검증되지 않음 (명령을 실행하지 못함)";
  }
}
