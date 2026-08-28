import type { WorkspaceIndex } from "@tomverse/protocol";

/**
 * 모델이 "이것도 봐야 한다"고 말한 것을 **우리가 판정해서** 가져온다 —
 * state-machine 57절, context-engine 16절.
 *
 * # 이 자리가 위험한 이유
 *
 * 질문·계획 경로의 모델은 `missingContext`로 무엇이든 요청할 수 있다. 그 요청을 그대로
 * 읽어 주면 **7절의 제외 규칙이 통째로 우회된다** — 컨텍스트 엔진이 secret·바이너리·대용량
 * 파일을 인덱스에서 빼는 이유가 그것인데, 모델이 이름을 대면 옆문으로 들어온다.
 *
 * Rust 게이트가 secret 읽기에 승인을 요구하므로 조용히 새지는 않는다. 그러나 그건
 * **최후의 방어**이고, 여기서 걸러야 하는 이유는 두 가지다: 무인 실행에서는 그 승인이
 * 정지가 되고, 사람이 있어도 답 하나 얻자고 `.env` 승인 모달을 보게 된다.
 *
 * # 그리고 산문을 경로로 착각하지 않는다
 *
 * `missingContext`는 자유 문장이다. `"src/hidden.ts"`도 오지만 `"테스트 파일"`도 온다.
 * 후자를 억지로 경로로 해석하면 엉뚱한 파일이 실린다 — **찾지 못했다고 말하는 것**이
 * 정직하고, 모델은 다음 라운드에서 그 사실을 읽고 다르게 말할 수 있다.
 */

export interface ResolvedRequest {
  /** 모델이 적은 원문. 거절 사유를 이 문자열에 붙여 돌려준다. */
  request: string;
  path: string;
}

export interface RefusedRequest {
  request: string;
  reason: string;
}

export interface Resolution {
  fetch: ResolvedRequest[];
  refused: RefusedRequest[];
}

/**
 * 한 라운드에 가져올 파일 수 상한 (원칙 5).
 *
 * **라운드 상한만으로는 부족하다.** 모델이 한 번에 파일 40개를 요청하면 라운드는 하나인데
 * 컨텍스트가 통째로 밀려난다 — 예산이 뒤쪽 파일을 잘라내므로 **원래 관련 있던 파일이
 * 빠진다.** 요청을 들어주다 원래 답에 필요한 것을 잃는 셈이다.
 */
export const MAX_FOLLOW_UP_FILES = 5;

export function resolveRequests(index: WorkspaceIndex, requests: readonly string[]): Resolution {
  const fetch: ResolvedRequest[] = [];
  const refused: RefusedRequest[] = [];
  const indexed = index.fileTree.map((f) => f.path);
  const excluded = new Map(index.excluded.map((e) => [e.path, e.reason] as const));
  const taken = new Set<string>();

  for (const raw of requests) {
    const request = raw.trim();
    if (request.length === 0) continue;

    // **제외된 파일이 이름으로 들어오는 것을 먼저 막는다.** 인덱스에 없으므로 아래 매칭은
    // 어차피 실패하지만, 그때 사유가 "찾지 못했습니다"가 되면 거짓이다 — 우리는 그 파일이
    // 있다는 것을 알고 **일부러** 뺐다.
    const excludedHit = matchOne([...excluded.keys()], request);
    if (excludedHit) {
      refused.push({
        request,
        reason: `이 파일은 컨텍스트에서 의도적으로 제외됐습니다: ${excluded.get(excludedHit)}`,
      });
      continue;
    }

    const hit = matchOne(indexed, request);
    if (hit === null) {
      refused.push({
        request,
        reason: "워크스페이스에서 이 이름의 파일을 찾지 못했습니다 — 경로가 아니라 설명이라면 경로로 다시 적어 주세요.",
      });
      continue;
    }
    if (hit === AMBIGUOUS) {
      refused.push({ request, reason: "이 이름에 해당하는 파일이 여럿입니다 — 전체 경로로 적어 주세요." });
      continue;
    }
    if (taken.has(hit)) continue;
    if (fetch.length >= MAX_FOLLOW_UP_FILES) {
      // **상한에 걸린 것을 조용히 버리지 않는다.** 버리면 모델은 우리가 읽어 줬다고 믿고,
      // 그 파일에 근거해 답한다.
      refused.push({ request, reason: `한 라운드에 가져올 수 있는 파일은 ${MAX_FOLLOW_UP_FILES}개까지입니다.` });
      continue;
    }
    taken.add(hit);
    fetch.push({ request, path: hit });
  }

  return { fetch, refused };
}

const AMBIGUOUS = Symbol("ambiguous") as unknown as string;

/**
 * 요청 하나를 인덱스의 경로 하나로 맞춘다.
 *
 * **정확 일치 → 경로 접미사 → 파일명** 순서다. 넓은 쪽으로 내려갈수록 여럿에 걸릴 수
 * 있으므로, 여럿이면 고르지 않고 `AMBIGUOUS`를 낸다 — **하나를 고르면 그것이 틀렸을 때
 * 아무도 모른다.**
 */
function matchOne(paths: readonly string[], request: string): string | null {
  const normalized = request.replace(/\\/g, "/").replace(/^\.\//, "");
  if (paths.includes(normalized)) return normalized;

  const bySuffix = paths.filter((p) => p.endsWith(`/${normalized}`));
  if (bySuffix.length === 1) return bySuffix[0] as string;
  if (bySuffix.length > 1) return AMBIGUOUS;

  // 파일명만 적은 경우. 여기까지 왔다는 것은 위 둘이 실패했다는 뜻이므로 더 넓게 본다.
  const base = normalized.split("/").pop() ?? normalized;
  // **경로처럼 생긴 요청은 파일명 매칭으로 내려가지 않는다.** `src/hidden.ts`를 적었는데
  // 다른 디렉터리의 `hidden.ts`가 잡히면, 모델은 자기가 지목한 파일을 받았다고 믿는다.
  if (base !== normalized) return null;
  const byName = paths.filter((p) => (p.split("/").pop() ?? p) === base);
  if (byName.length === 1) return byName[0] as string;
  if (byName.length > 1) return AMBIGUOUS;
  return null;
}

/**
 * 다음 라운드 프롬프트에 붙일 **거절 목록**.
 *
 * 말하지 않으면 모델은 같은 것을 다시 요청하고, 라운드 상한이 그것으로 소진된다.
 * 그리고 우리가 읽어 줬다고 가정한 채 답할 수도 있다 — 그게 더 나쁘다.
 */
export function refusalNote(refused: readonly RefusedRequest[]): string {
  if (refused.length === 0) return "";
  const lines = refused.map((r) => `- ${JSON.stringify(r.request)}: ${r.reason}`);
  return (
    "You asked for more context. These requests were NOT fulfilled — do not assume you have seen them:\n" +
    lines.join("\n")
  );
}
