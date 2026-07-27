import type { RelevantFile } from "@tomverse/protocol";

/**
 * 토큰 예산 패키징 — docs/design/context-engine.md 8절.
 *
 * 정확한 토크나이저를 도입하지 않은 이유(11절 미해결 항목): tiktoken 등을 넣으면 의존성과
 * WASM 로딩 비용이 생기고, 예산 초과의 대가는 "요청이 거부되고 재시도"이지 데이터 손실이 아니다.
 * 문자 수 근사로 시작하고, 실제로 예산 초과가 문제가 되면 그때 정확한 카운터를 넣는다.
 * 근사가 근사임을 숨기지 않기 위해 상수 이름에 APPROX를 붙였다.
 */

/** 영문 코드 기준 대략 1토큰 ≈ 3.5자. 한국어가 섞이면 더 나빠지므로 보수적으로 잡는다. */
export const APPROX_CHARS_PER_TOKEN = 3.5;

export interface TokenBudget {
  modelId: string;
  maxTokens: number;
}

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
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

    const tokens = approximateTokens(file.content);
    const allowance = Math.min(remaining, perFileCap);

    if (tokens <= allowance) {
      out.push(file);
      used += tokens;
      continue;
    }

    const allowedChars = Math.floor(allowance * APPROX_CHARS_PER_TOKEN);
    const truncatedContent = file.content.slice(0, allowedChars);
    out.push({
      ...file,
      content: truncatedContent,
      truncated: true,
      includedBytes: truncatedContent.length,
      reasonDetail: `${file.reasonDetail} (토큰 예산으로 ${file.content.length}자 중 ${truncatedContent.length}자만 포함)`,
    });
    used += approximateTokens(truncatedContent);
  }

  return { files: out, dropped };
}
