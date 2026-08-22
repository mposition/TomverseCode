import { useState } from "react";
import { DEFAULT_DIFF_LINE_CAP, summarizeChange, summarizeDiff, visibleDiff } from "../lib/diffSummary";

/**
 * Diff 패널 — docs/design/ui-wireframes.md 3.1절 우측 패널, 3.14절 대용량 변경.
 *
 * M0는 파일 단위 diff만 보여준다(8.2절 출시 기준). hunk 단위 부분 승인은 이후 확장 항목이다.
 *
 * # 이 화면의 목적은 "읽기"가 아니라 "판단"이다
 *
 * 사용자가 여기서 하는 일은 **이 변경을 받아들일지 되돌릴지 정하는 것**이다. 파일 50개를
 * 평평하게 늘어놓으면 그 판단이 쉬워지는 게 아니라 불가능해진다 — 그래서 먼저 요약을 주고,
 * 본문은 편 것만 그린다.
 *
 * # 접힌 파일은 그리지 않는다
 *
 * 종전에는 `<details>` 안에 모든 줄을 미리 넣었다. `<details>`는 접혀 있어도 **내용이 DOM에
 * 있으므로**, 파일 50개짜리 변경에서 수천 개의 노드가 만들어졌다. 지금은 편 것만 그린다.
 */
export function DiffPanel({ diffs, largeChangeFiles }: { diffs: [string, string][]; largeChangeFiles?: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (diffs.length === 0) {
    return (
      <div className="panel">
        <h2>변경된 파일</h2>
        <p className="muted">아직 적용된 변경이 없습니다.</p>
      </div>
    );
  }

  const total = summarizeChange(diffs);
  // 파일이 하나면 펴 둔다 — 한 파일짜리 변경에서 한 번 더 누르게 하는 것은 이유가 없다.
  const isOpen = (key: string) => open[key] ?? diffs.length === 1;
  const large = largeChangeFiles !== undefined && total.files >= largeChangeFiles;

  return (
    <div className="panel">
      <h2>변경된 파일 ({total.files})</h2>
      <p className="muted small">
        +{total.added} −{total.removed} · {total.lines.toLocaleString()}줄
      </p>
      {large && (
        <p className="warn small">
          이 변경은 이 워크스페이스 기준으로 <strong>큽니다</strong> (파일 {total.files}개, 문턱{" "}
          {largeChangeFiles}개). 되돌리기는 <strong>전부 아니면 전무</strong>이므로, 받아들이기 전에 파일 목록을
          훑어보세요.
        </p>
      )}
      {diffs.map(([path, diff], index) => {
        const key = `${path}-${index}`;
        const stat = summarizeDiff(diff);
        const cap = expanded[key] ? Number.POSITIVE_INFINITY : DEFAULT_DIFF_LINE_CAP;
        const shown = isOpen(key) ? visibleDiff(diff, cap) : null;
        return (
          <details
            key={key}
            open={isOpen(key)}
            onToggle={(e) => setOpen((prev) => ({ ...prev, [key]: (e.target as HTMLDetailsElement).open }))}
          >
            <summary>
              <code>{path}</code>{" "}
              <span className="muted small">
                +{stat.added} −{stat.removed}
              </span>
            </summary>
            {/* **편 것만 그린다.** 접힌 `<details>`의 내용도 DOM에 들어가므로, 미리 그리면
                파일이 많을 때 화면이 멈춘다. */}
            {shown && (
              <>
                <pre className="diff">
                  {shown.text.split("\n").map((line, lineIndex) => (
                    <span key={lineIndex} className={diffLineClass(line)}>
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
                {/* **자른 사실을 숨기지 않는다.** 조용히 자르면 사용자는 그게 전부인 줄 알고
                    판단한다. 전체는 감사 export와 이벤트 로그에 그대로 남아 있다. */}
                {shown.hidden > 0 && (
                  <p className="warn small">
                    {stat.lines.toLocaleString()}줄 중 {DEFAULT_DIFF_LINE_CAP.toLocaleString()}줄만 표시했습니다 (
                    {shown.hidden.toLocaleString()}줄 감춤).{" "}
                    <button className="secondary" onClick={() => setExpanded((prev) => ({ ...prev, [key]: true }))}>
                      전부 보기
                    </button>
                  </p>
                )}
              </>
            )}
          </details>
        );
      })}
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-header";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}
