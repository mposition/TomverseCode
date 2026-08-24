/**
 * PR 결과를 **화면 문장으로** 옮긴다 — state-machine 28절.
 *
 * # 이 자리에서 가장 하기 쉬운 거짓말
 *
 * **"PR을 만들었습니다"라고 쓰는 것.** 우리는 PR을 만들지 않았다 — 브랜치를 올리고 폼 URL을
 * 냈을 뿐이고, 그 폼을 여는 것은 사용자의 브라우저다(28.1절). 만들었다고 쓰면 사용자는 GitHub에
 * 가서 없는 PR을 찾는다.
 *
 * 두 번째는 **`compareUrl`이 없는 것을 실패로 보이게 하는 것.** push는 성공했고 URL만 못 만든
 * 것이며, 그건 remote가 GitHub이 아니라는 사실이다. 그때 사용자가 할 일은 "다시 시도"가 아니라
 * "직접 PR을 여는 것"이다.
 */

export interface PrResult {
  pushed: boolean;
  branch: string;
  remote: string;
  base?: string;
  title?: string;
  body?: string;
  compareUrl: string | null;
  status?: string;
  exitCode?: number | null;
  reason?: string | null;
}

export interface PrOutcome {
  kind: "pushed_with_form" | "pushed_no_form" | "failed";
  headline: string;
  detail: string;
  /** 열 수 있는 링크. 없으면 `null`이며 그건 **정보다**. */
  url: string | null;
}

export function describePrOutcome(result: PrResult): PrOutcome {
  if (!result.pushed) {
    return {
      kind: "failed",
      headline: `브랜치를 올리지 못했습니다 (${result.branch} → ${result.remote}).`,
      // **원인을 지어내지 않는다.** 종료 코드와 사유가 있으면 그대로 보여주고, 없으면 없다고 쓴다.
      detail:
        result.reason ??
        (result.exitCode != null ? `git push가 종료 코드 ${result.exitCode}로 끝났습니다.` : "사유가 기록되지 않았습니다."),
      url: null,
    };
  }

  if (!result.compareUrl) {
    return {
      kind: "pushed_no_form",
      headline: `브랜치를 올렸습니다: ${result.branch} → ${result.remote}`,
      // push는 성공이다. 못 한 것은 URL을 만드는 일뿐이고 그 이유를 말한다.
      detail:
        "PR 생성 폼 주소는 만들지 못했습니다 — 이 remote가 GitHub이 아니거나 우리가 아는 모양이 아닙니다. " +
        "호스팅에서 직접 PR을 여세요.",
      url: null,
    };
  }

  return {
    kind: "pushed_with_form",
    headline: `브랜치를 올렸습니다: ${result.branch} → ${result.remote}`,
    // **"만들었습니다"가 아니다.** 폼을 여는 것은 사용자이고, 우리는 거기까지 가지 않았다.
    detail: `아래를 열면 제목과 본문이 채워진 PR 생성 폼이 뜹니다 (base: ${result.base ?? "?"}). 아직 PR은 만들어지지 않았습니다.`,
    url: result.compareUrl,
  };
}
