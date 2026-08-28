import type { DependencyEdge, SymbolEntry } from "@tomverse/protocol";

/**
 * 심볼 테이블·의존성 그래프 조회 — docs/design/context-engine.md 4·22절.
 *
 * 순수 함수만 둔다. 선정(`engine.ts`)은 이 함수들이 무엇을 돌려주는지에만 의존하고, 여기는
 * 브릿지도 인덱스 구축도 모른다 — 그래야 "1~2홉이 실제로 파일을 고르는가"를 파서 없이도
 * 검사할 수 있다.
 */

/**
 * 이름이 정확히 같은 심볼.
 *
 * **부분 일치를 하지 않는다.** `budget`으로 `resolveBudget`까지 걸면 근거의 강도가 정규식
 * 검색과 같아지는데, `symbol-match`라는 이름은 그보다 강한 것을 주장한다(13.3절). 넓게
 * 찾는 일은 `content-match`가 이미 하고 있고, 그 층은 남는다.
 */
export function symbolsNamed(symbols: readonly SymbolEntry[], name: string): SymbolEntry[] {
  return symbols.filter((symbol) => symbol.name === name);
}

/** 정의로서의 강도 순서. 같은 이름이 여러 파일에 있을 때 **무엇을 먼저 실을지**를 정한다. */
const KIND_RANK: Record<SymbolEntry["kind"], number> = {
  class: 0,
  interface: 1,
  function: 2,
  type: 3,
  const: 4,
  method: 5,
  // 재수출은 정의가 아니다 — 이름은 여기 있지만 본문은 다른 파일에 있다.
  export: 6,
};

/**
 * 심볼 매치를 **파일 단위로** 접는다. 한 파일에 같은 이름이 여러 번 나와도 파일은 하나이고,
 * 그 파일의 앵커는 여럿이다(15절 — 앵커는 근거가 아니라 위치이므로 합친다).
 *
 * 정렬은 결정적이어야 한다(같은 입력이 같은 스냅샷을 내야 대조가 성립한다 — 1절):
 * kind 강도 → 줄 번호 → 경로.
 */
export function symbolMatchFiles(
  symbols: readonly SymbolEntry[],
  name: string
): { path: string; kind: SymbolEntry["kind"]; anchorLines: number[] }[] {
  const byPath = new Map<string, { path: string; kind: SymbolEntry["kind"]; anchorLines: number[] }>();
  for (const symbol of symbolsNamed(symbols, name)) {
    const existing = byPath.get(symbol.filePath);
    if (!existing) {
      byPath.set(symbol.filePath, { path: symbol.filePath, kind: symbol.kind, anchorLines: [symbol.startLine] });
      continue;
    }
    existing.anchorLines.push(symbol.startLine);
    if (KIND_RANK[symbol.kind] < KIND_RANK[existing.kind]) existing.kind = symbol.kind;
  }
  return [...byPath.values()]
    .map((hit) => ({ ...hit, anchorLines: [...new Set(hit.anchorLines)].sort((a, b) => a - b) }))
    .sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (a.anchorLines[0] ?? 0) - (b.anchorLines[0] ?? 0) ||
        a.path.localeCompare(b.path)
    );
}

/**
 * 씨앗 파일들이 **import하는** 파일을 홉 수와 함께 돌려준다 (4절 `dependency`).
 *
 * # 왜 나가는 방향만 보는가
 *
 * 4절 표가 `dependency`를 *"선정된 파일들의 import 대상"* 으로 정의했다. 들어오는 방향
 * (이 파일을 import하는 파일)도 쓸모 있어 보이지만 — 호출부는 실제로 관련이 있다 — 그건
 * 5절이 못박은 범위를 넓히는 결정이고 여기서 하지 않는다. 22절 "아직 하지 않은 것"에 적었다.
 *
 * # 왜 홉 수를 함께 주는가
 *
 * 예산이 모자라면 뒤에서부터 잘리므로(8절) 2홉보다 1홉이 앞에 와야 한다. 홉 수는 그
 * 순서를 정하는 값이자, `reasonDetail`이 근거의 거리를 사람에게 말하는 값이다.
 */
export function dependenciesWithinHops(
  edges: readonly DependencyEdge[],
  seeds: readonly string[],
  maxHops: number
): { path: string; hops: number; via: string }[] {
  const outgoing = new Map<string, { to: string; kind: DependencyEdge["kind"] }[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.fromFile);
    if (list) list.push({ to: edge.toFile, kind: edge.kind });
    else outgoing.set(edge.fromFile, [{ to: edge.toFile, kind: edge.kind }]);
  }

  const seen = new Set(seeds);
  const found: { path: string; hops: number; via: string }[] = [];
  let frontier = [...seeds];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    const next: string[] = [];
    // 프론티어를 정렬해서 돈다 — Map의 삽입 순서에 결과가 걸리면 같은 인덱스가 같은 스냅샷을
    // 낸다는 보장이 사라진다.
    for (const from of [...frontier].sort()) {
      const targets = (outgoing.get(from) ?? []).map((t) => t.to).sort();
      for (const to of targets) {
        if (seen.has(to)) continue;
        seen.add(to);
        found.push({ path: to, hops: hop, via: from });
        next.push(to);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return found;
}
