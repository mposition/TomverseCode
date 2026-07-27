/**
 * Diff 패널 — docs/design/ui-wireframes.md 3.1절 우측 패널.
 *
 * M0는 파일 단위 diff만 보여준다(8.2절 출시 기준: "파일 단위 diff"). hunk 단위 부분 승인은
 * 이후 깊이 확장 항목이다.
 */
export function DiffPanel({ diffs }: { diffs: [string, string][] }) {
  if (diffs.length === 0) {
    return (
      <div className="panel">
        <h2>변경된 파일</h2>
        <p className="muted">아직 적용된 변경이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>변경된 파일 ({diffs.length})</h2>
      {diffs.map(([path, diff], index) => {
        const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        return (
          <details key={`${path}-${index}`} open={diffs.length === 1}>
            <summary>
              <code>{path}</code>{" "}
              <span className="muted small">
                +{added} −{removed}
              </span>
            </summary>
            <pre className="diff">
              {diff.split("\n").map((line, lineIndex) => (
                <span key={lineIndex} className={diffLineClass(line)}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
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
