import type { RelevantFile } from "@tomverse/protocol";

/**
 * 토큰 예산 패키징 — docs/design/context-engine.md 8절.
 *
 * # 정확한 토큰 수는 **원리적으로 존재하지 않는다**
 *
 * 이 설계는 **하나의 스냅샷을 모든 공급자에게 보낸다**(`providers/prompts.ts`의 네 빌더가 전부
 * 같은 `renderSnapshot`을 쓴다 — 그게 대조가 성립하는 조건이다). 그런데 같은 텍스트의 토큰
 * 수는 토크나이저마다 다르다. 그러므로 "정확한 카운터를 넣는다"는 목표는 달성 가능한 목표가
 * 아니다 — 공급자 A에게 정확한 수는 공급자 B에게 틀린 수다.
 *
 * 달성 가능한 목표는 **상한**이다. 그래서 이 모듈이 내는 값은 추정이 아니라 "이보다 많지는
 * 않을 것"이고, 이름도 그렇게 붙였다.
 *
 * # 왜 tiktoken을 넣지 않는가
 *
 * 위 이유가 첫째다. 둘째, Anthropic은 오프라인 토크나이저를 배포하지 않는다 — 정확히 세려면
 * **API 호출**이고, 그건 패킹할 때마다 지연과 비용이 붙는다는 뜻이다. 컨텍스트를 꾸리기 위해
 * 유료 호출을 하는 것은 예산 상한(multi-engine-routing.md 10.6절)이 막으려는 것과 같은 종류의
 * 지출이다. 셋째, WASM 로딩 비용과 의존성이 붙는다.
 *
 * # 과소 추정과 과대 추정의 대가는 대칭이 아니다
 *
 * **과대 추정의 대가**: 파일을 덜 싣는다. 모델이 볼 것이 줄어 패치 품질이 떨어지지만,
 * 그 손해는 **보이지 않는다.**
 *
 * **과소 추정의 대가**: 예산보다 많이 보낸다. 종전 주석은 그 대가를 "요청이 거부되고 재시도"로
 * 적었는데, **예산 상한이 붙으면서 달라졌다** — 실제 입력 토큰이 예약의 근거였던 수를 넘으면
 * 실제 비용이 예약액을 넘고, 원장은 `BUDGET_ESTIMATE_BREACH`로 이후 호출을 막는다. 즉 이제
 * 과소 추정은 **돈과 태스크를 함께 잃는다.**
 *
 * 그래서 계수는 보수적으로(=크게 나오게) 잡는다. 다만 최악의 토크나이저를 가정하지는 않는다 —
 * 모든 문자를 1문자=3토큰으로 보면 컨텍스트가 1/3로 줄어 위의 "보이지 않는 손해"가 상시화된다.
 * 우리가 실제로 라우팅하는 토크나이저들에 대해 성립하는 상한이면 되고, **그건 재봐야 안다.**
 *
 * # 그래서 재고 있다
 *
 * 모든 호출이 `meta.estimatedInputTokens`(우리 추정)와 `usage.inputTokens`(공급자가 보고한
 * 실제)를 함께 남긴다. `tomverse-host metrics`의 `tokenEstimate`가 그 비율을 집계하고,
 * **실제가 추정을 넘은 호출 수**를 따로 센다 — 그 수가 0이 아니면 이 모듈은 상한이 아니다.
 * 계수를 고칠 근거는 이 숫자이지 감이 아니다.
 *
 * # 종전 근사가 틀렸던 방향
 *
 * 종전에는 전부 `문자 수 / 3.5`였다. 그 값은 영문 코드에는 대략 맞지만 **한글에는 3~7배
 * 과소 추정**이다(한글 음절은 UTF-8로 3바이트이고 BPE는 바이트 위에서 도므로 보통 음절당
 * 1토큰 이상이다). 이 제품의 사용자는 한국어로 요청을 쓰고 한국어 주석이 달린 코드를 다루므로,
 * 그 오차는 예외적인 경우가 아니라 **기본 경로**에 있었다.
 */

/**
 * ASCII 문자 몇 개가 1토큰인가.
 *
 * **유도하지 못한 상수다.** 영문 산문·코드에서 흔히 관측되는 3.5~4.5보다 작게 잡아 상한 쪽으로
 * 기울였다 — 압축된 코드나 base64 덩어리는 이보다 훨씬 나쁘다.
 */
export const ASCII_CHARS_PER_TOKEN = 3;

/**
 * ASCII가 아닌 문자 1개가 몇 토큰인가.
 *
 * **유도하지 못한 상수다.** 한글·CJK는 UTF-8로 3바이트이고, 현대 토크나이저는 보통 1~2음절을
 * 1토큰으로 묶는다. 최악(음절당 3토큰, 바이트 단위 분해)을 가정하지 않는 이유는 위 모듈 주석에
 * 있다 — 그러면 컨텍스트가 상시로 줄어든다.
 */
export const NON_ASCII_TOKENS_PER_CHAR = 1;

/**
 * 이 텍스트가 넘지 않을 토큰 수.
 *
 * 코드 포인트 단위로 센다 — `String.length`는 서로게이트 쌍을 2로 세므로 이모지가 든 텍스트에서
 * 문자 수가 실제와 달라진다.
 */
export function estimateTokensUpperBound(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + nonAscii * NON_ASCII_TOKENS_PER_CHAR;
}

/**
 * 추정 토큰이 `maxTokens`를 넘지 않는 **가장 긴 접두사**.
 *
 * 종전에는 `허용 토큰 × 문자당 토큰`으로 자를 문자 수를 역산했다. 계수가 문자 종류마다 다른
 * 지금은 그 역산이 성립하지 않는다 — 한글 구간에서 역산하면 허용치의 3배를 잘라 넣는다.
 * 그래서 앞에서부터 실제로 세면서 자른다.
 *
 * 코드 포인트 단위로 자르므로 **서로게이트 쌍이 반으로 쪼개지지 않는다.** 쪼개지면 잘린 자리에
 * 깨진 문자가 남고, 그건 모델에게도 로그에도 잡음이다.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  let ascii = 0;
  let nonAscii = 0;
  let end = 0;
  for (const ch of text) {
    const nextAscii = ch.codePointAt(0)! < 0x80 ? ascii + 1 : ascii;
    const nextNonAscii = ch.codePointAt(0)! < 0x80 ? nonAscii : nonAscii + 1;
    const cost =
      Math.ceil(nextAscii / ASCII_CHARS_PER_TOKEN) + nextNonAscii * NON_ASCII_TOKENS_PER_CHAR;
    if (cost > maxTokens) break;
    ascii = nextAscii;
    nonAscii = nextNonAscii;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * 앵커 주변의 **연속된** 줄 창 — context-engine 14절.
 *
 * # 왜 앞에서부터 자르면 안 되는가
 *
 * 13절이 본문 검색으로 파일을 고르게 만들었다. 그런데 자르기는 여전히 **접두사**였다 —
 * `resolveBudget`이 800번째 줄에 정의돼 있으면, 우리는 그 파일을 찾아 놓고 그 정의를 잘라
 * 버린 채 모델에게 보낸다. 찾은 값어치가 거기서 사라진다.
 *
 * # 창은 하나다
 *
 * 앵커마다 조각을 떼어 이어 붙이면 본문에 **구멍**이 생기고, 그 구멍은 표시하지 않으면
 * 거짓이고 표시하면 모델이 그 표시를 patch context로 복사한다. 그래서 조각을 잇지 않고
 * **연속된 창 하나**만 낸다 — 그러면 실린 본문은 원본의 조각 그대로다.
 *
 * # 앵커보다 앞을 조금 남긴다
 *
 * 정의는 아래로 읽히지만 그 위에 import·타입·주석이 있고, 그것이 없으면 모델이 이름을
 * 지어낸다. 그래서 예산의 일부를 앞쪽에 쓴다.
 *
 * # 창 하나를 **어디에** 두는가 — 첫 앵커가 아니라 가장 많이 덮는 자리
 *
 * 14절은 창을 첫 앵커에 걸었다. 앵커가 하나면 그것으로 충분하지만, 13절의 본문 검색은
 * 키워드 4개 × 매치 3개까지 내므로 **앵커는 흔히 여럿이다.** 그리고 첫 앵커가 import 줄이고
 * 정작 정의는 800번째 줄인 경우, 첫 앵커에 창을 걸면 14절이 고치려던 바로 그 실패로 돌아간다 —
 * 찾아 놓고 잘라 버리는 것. 다른 것은 잘린 자리가 파일 앞이 아니라 첫 매치 근처라는 점뿐이다.
 *
 * 그래서 앵커마다 창을 하나씩 놓아 보고 **가장 많은 앵커를 덮는 창**을 고른다. 같은 수를
 * 덮으면 앞쪽을 쓴다 — 결정적이어야 하고(같은 입력이 같은 스냅샷을 내야 대조가 성립한다),
 * 앞쪽이 대개 정의 쪽이다.
 *
 * 후보를 전부 만들어도 비싸지 않다: 창의 크기는 예산이 정하므로 각 후보는 파일 전체가 아니라
 * **창 크기**만큼만 훑고, 앵커 수는 12개로 묶여 있다(13절의 상한).
 *
 * # 그리고 몇 개를 놓쳤는지 센다
 *
 * 14.6절은 이 개선의 근거를 "앵커 분포를 봐야 하는데 잰 적이 없다"로 미뤄 두었다. **재는
 * 장치가 없으면 고쳐도 나아졌는지 모르고, 틀려도 드러나지 않는다.** 그래서 창은 덮은 앵커
 * 수와 놓친 수를 함께 낸다. 그 값은 `RelevantFile`에 실려 스냅샷에 남고(=이벤트에 남고),
 * 프롬프트 머리글이 모델에게도 말한다 — 관련 지점이 창 밖에 있다는 것은 모델이 patch를
 * 자신 있게 쓰면 안 되는 이유이기 때문이다.
 */
export interface Window {
  text: string;
  /** 1-base, 양끝 포함. */
  startLine: number;
  endLine: number;
  totalLines: number;
  /**
   * 이 창이 덮은 앵커 수와 **범위 안에 있던** 앵커 총수.
   *
   * `total`은 넘겨받은 앵커가 아니라 **파일 범위 안에 있던** 앵커다 — 범위 밖 앵커는 파일이
   * 바뀌었다는 뜻이지 우리가 놓친 것이 아니므로, 함께 세면 "놓쳤다"가 부풀려진다.
   */
  anchors: { covered: number; total: number };
}

/** 창의 앞쪽(앵커 이전)에 쓰는 예산 비율. 나머지는 뒤로 간다. */
const LEAD_SHARE = 0.25;

export function windowAroundLines(text: string, anchors: readonly number[], maxTokens: number): Window {
  const lines = text.split("\n");
  const totalLines = lines.length;

  // **범위 밖 앵커는 버린다.** 검색과 읽기 사이에 파일이 바뀔 수 있고, 그때 앵커를 그대로
  // 믿으면 창이 파일 끝 너머를 가리킨다.
  const valid = anchors.filter((n) => Number.isInteger(n) && n >= 1 && n <= totalLines).sort((a, b) => a - b);
  if (valid.length === 0 || maxTokens <= 0) {
    const head = truncateToTokens(text, maxTokens);
    return {
      text: head,
      startLine: 1,
      endLine: head.length === 0 ? 0 : head.split("\n").length,
      totalLines,
      anchors: { covered: 0, total: valid.length },
    };
  }

  // **중복 앵커를 접는다.** 같은 줄을 두 번 세면 덮은 수가 부풀려져 후보 비교가 틀린다.
  const unique = [...new Set(valid)];

  // 앵커마다 창을 하나씩 놓아 보고 가장 많이 덮는 것을 고른다. 같은 수면 앞쪽(=먼저 나온
  // 후보)을 남긴다 — `>`이지 `>=`가 아닌 이유다.
  let best: { start: number; end: number; covered: number } | null = null;
  for (const anchor of unique) {
    const span = spanFrom(lines, anchor, maxTokens);
    const covered = unique.filter((n) => n >= span.start && n <= span.end).length;
    if (best === null || covered > best.covered) best = { ...span, covered };
    // 전부 덮었으면 더 볼 것이 없다.
    if (best.covered === unique.length) break;
  }
  const chosen = best as { start: number; end: number; covered: number };

  const slice = lines.slice(chosen.start - 1, chosen.end).join("\n");
  const fitted = estimateTokensUpperBound(slice) > maxTokens ? truncateToTokens(slice, maxTokens) : slice;
  return {
    text: fitted,
    startLine: chosen.start,
    endLine: chosen.end,
    totalLines,
    anchors: { covered: chosen.covered, total: unique.length },
  };
}

/**
 * 앵커 하나에 창을 걸었을 때의 줄 범위.
 *
 * **`windowAroundLines`에서 떼어낸 이유는 후보를 여럿 만들어야 하기 때문이다.** 붙여 두면
 * "첫 앵커에 건다"가 구조에 박혀서, 고르는 규칙을 바꾸려면 함수를 통째로 다시 써야 한다.
 */
function spanFrom(lines: readonly string[], anchor: number, maxTokens: number): { start: number; end: number } {
  const totalLines = lines.length;
  const leadBudget = Math.floor(maxTokens * LEAD_SHARE);

  // 앵커에서 **위로** 올라가며 lead 예산을 쓴다.
  let start = anchor;
  let leadUsed = 0;
  while (start > 1) {
    const cost = estimateTokensUpperBound(`${lines[start - 2] as string}\n`);
    if (leadUsed + cost > leadBudget) break;
    leadUsed += cost;
    start -= 1;
  }

  // 남은 예산으로 **아래로** 내려간다. 앵커 줄 자체가 예산을 넘으면 그 줄만 잘라 넣는다 —
  // 빈 창을 내면 "찾았는데 아무것도 안 실었다"가 된다.
  let end = start - 1;
  let used = leadUsed;
  while (end < totalLines) {
    const cost = estimateTokensUpperBound(`${lines[end] as string}\n`);
    if (used + cost > maxTokens && end >= start) break;
    used += cost;
    end += 1;
  }
  if (end < start) end = start;
  return { start, end };
}

export interface TokenBudget {
  modelId: string;
  maxTokens: number;
}

export interface PackagedFiles {
  files: RelevantFile[];
  /** 예산 때문에 아예 빠진 파일과 그 사유 */
  dropped: { path: string; reason: string }[];
}

/**
 * 우선순위 순서로 채우고, 예산이 모자라면 뒤쪽부터 잘라낸다.
 *
 * 파일을 통째로 버리기 전에 먼저 잘라 넣는다(8절 (3)) — 파일 앞부분만이라도 있으면
 * 모델이 구조를 파악할 수 있고, 잘렸다는 사실은 `truncated: true`로 명시된다.
 */
export function packageFiles(files: RelevantFile[], maxTokens: number): PackagedFiles {
  const out: RelevantFile[] = [];
  const dropped: { path: string; reason: string }[] = [];
  let used = 0;

  /** 파일 하나에 예산의 절반 이상을 쓰지 않는다 — 큰 파일 하나가 컨텍스트를 독점하지 않게. */
  const perFileCap = Math.max(1, Math.floor(maxTokens / 2));
  /** 이보다 적게 남으면 잘라 넣어도 의미가 없다. */
  const minUsefulTokens = 200;

  for (const file of files) {
    const remaining = maxTokens - used;
    if (remaining < minUsefulTokens) {
      dropped.push({ path: file.path, reason: "토큰 예산 소진 — 이 파일은 컨텍스트에 포함되지 않음" });
      continue;
    }

    const tokens = estimateTokensUpperBound(file.content);
    const allowance = Math.min(remaining, perFileCap);

    if (tokens <= allowance) {
      out.push(file);
      used += tokens;
      continue;
    }

    // **앵커가 있으면 그 주변을 남긴다**(14절). 없으면 종전대로 앞에서부터다 —
    // 그 경우 파일의 앞부분이 구조를 가장 잘 말해 준다.
    const window = windowAroundLines(file.content, file.anchorLines ?? [], allowance);
    out.push({
      ...file,
      content: window.text,
      truncated: true,
      includedBytes: window.text.length,
      includedRange: {
        startLine: window.startLine,
        endLine: window.endLine,
        totalLines: window.totalLines,
      },
      anchorCoverage: window.anchors,
      reasonDetail: `${file.reasonDetail} (토큰 예산으로 ${window.totalLines}줄 중 ${window.startLine}~${window.endLine}줄만 포함)`,
    });
    used += estimateTokensUpperBound(window.text);
  }

  return { files: out, dropped };
}
