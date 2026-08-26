import { prepareMsvcEnv, type MsvcResult } from "@tomverse/toolchain";
import { credentialUsable, resolveCredential } from "@tomverse/sidecar/providers";
import { computeCallBudget, describeCallBudget } from "./callBudget.js";
import { artifactsPresent, REPO_ROOT } from "./host.js";
import { CRITERIA, criteriaHash, describeCriteria } from "./criteria.js";
import type { ArmId } from "./types.js";

/**
 * 실행 전 확인 (§9).
 *
 * # 왜 미리 보여주는가
 *
 * 실제 API 실험은 돈과 시간을 쓴다. "돌려놓고 나중에 보니 키가 없어서 전부 실패"가 가장 흔한
 * 실패 모드이고, 그때 이미 몇 시간이 지나 있다. 그래서 **API 호출을 시작하기 전에**
 * 무엇이 없는지, 얼마나 부를 것인지, 최대 얼마가 들 것인지 전부 보여준다.
 *
 * # 자격증명을 어떻게 확인하는가
 *
 * 값을 읽지 않고 **존재 여부만** 본다. 이 하네스는 키를 로그·리포트·기록 어디에도 남기지 않는다.
 *
 * # 그리고 확인하지 **않은** 것을 함께 말한다
 *
 * 종전에는 "막는 요인" 목록만 냈고, 그 목록이 완전한 것처럼 읽혔다. 실제로는 존재 여부만
 * 보므로 **키가 있는데도 실행이 안 되는 경우가 셋** 남는다: 그 호스트에 닿지 않거나(프록시·
 * 방화벽·오프라인), 조직 인증이 없어 그 모델을 못 부르거나(gpt-5 사례), 키가 만료됐거나.
 *
 * 이 세 가지는 **실제 호출을 해야만** 알 수 있고 그게 `probe-models`의 일이다. 여기서 할 일은
 * 그 사실을 말해서 "키만 넣으면 된다"로 읽히지 않게 하는 것이다 — 실측 사례가 있다: 이
 * 저장소의 개발 환경은 `OPENAI_API_KEY`가 있는데도 egress 프록시가 `api.openai.com`을 막는다.
 */

export interface PreflightInput {
  fixtureCount: number;
  arms: ArmId[];
  repetitions: number;
  maxCostUsd?: number;
  executorModel?: string;
  reviewerModel?: string;
  usingFakeProvider: boolean;
  /** Rust fixture 개수 — 0이면 MSVC가 없어도 무방하다. */
  nativeFixtureCount?: number;
  /** 툴체인 상태 주입 (테스트용). 없으면 실제로 확인한다. */
  msvc?: MsvcResult;
}

export interface PreflightReport {
  ok: boolean;
  /**
   * 실제 API 실험을 돌릴 수 있는가.
   *
   * **"막는 것이 없다"이지 "된다"가 아니다.** 아래 `notChecked`가 남은 거리를 말한다.
   */
  canRunRealExperiment: boolean;
  lines: string[];
  blockers: string[];
  /**
   * 이 점검이 **보지 않은 것**. 비어 있으면 안 된다 — 이 점검은 원리적으로 전부 볼 수 없다.
   *
   * 목록으로 내는 이유: 산문에 섞어 두면 blockers만 읽고 "이제 되겠구나"로 넘어간다.
   */
  notChecked: string[];
}

/**
 * 공급자별 정본 환경변수 이름 — Model Registry의 `apiKeyEnvName`과 같아야 한다.
 *
 * 별칭(`TOMVERSE_` 접두)은 여기서 나열하지 않는다. 그 규칙은 `resolveCredential` 하나에만 있다.
 */
const PROVIDER_PRIMARY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * 자격증명을 **쓸 수 있는 상태인가** — 값은 읽지 않는다.
 *
 * # 무엇을 고쳤나 (§2.10)
 *
 * 예전에는 이 함수가 자체 별칭 목록을 갖고 `some(name => env[name])`으로 판정했다. 어댑터
 * factory는 레지스트리 이름 하나만 읽었으므로, 별칭만 설정한 환경에서 **"자격증명 있음"으로
 * 승인 카드가 나오는데 실행은 `MissingCredentialError`로 죽었다.** 그리고 두 변수에 다른 키가
 * 있으면 어느 것으로 확인했는지 알 수 없었다.
 *
 * 이제 factory와 **같은 resolver**를 쓴다. 별칭 충돌은 `false`다 — "있지만 쓸 수 없다"를
 * "있다"로 보고하면 실행되지 않을 계획을 승인 가능으로 표시하게 된다.
 */
export function credentialPresent(providerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const primary = PROVIDER_PRIMARY_ENV[providerId];
  if (primary === undefined) return false;
  return credentialUsable(providerId, primary, env);
}

/** 왜 쓸 수 없는지 — 없음과 충돌은 사용자가 해야 하는 일이 다르다. */
export function credentialProblem(providerId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const primary = PROVIDER_PRIMARY_ENV[providerId];
  if (primary === undefined) return `${providerId}: 이 하네스가 아는 공급자가 아닙니다`;
  const resolved = resolveCredential(providerId, primary, env);
  return resolved.ok ? undefined : resolved.reason;
}

/**
 * 가격 스냅샷 기준일.
 *
 * 비용 추정은 Model Registry의 단가로 계산되며, 그 단가는 특정 시점의 공개 가격표를 옮겨온
 * 것이다. 시간이 지나면 실제 청구액과 벌어지므로 **기준일을 리포트에 명시한다** —
 * "비용이 2배 이하"라는 판정이 언제 기준인지 모르면 그 판정을 재현할 수 없다.
 */
export const PRICING_SNAPSHOT_DATE = "2026-07-01";

export function preflight(input: PreflightInput): PreflightReport {
  const lines: string[] = [];
  const blockers: string[] = [];

  const artifacts = artifactsPresent();
  if (!artifacts.ok) blockers.push(`실행에 필요한 산출물이 없습니다:\n${artifacts.detail}`);

  // 네이티브 툴체인. **링크 오류까지 가기 전에** 여기서 알린다 —
  // `LNK1104: cannot open file 'msvcrt.lib'`는 원인에서 너무 먼 증상이다.
  const nativeFixtures = input.nativeFixtureCount ?? 0;
  const msvc = input.msvc ?? prepareMsvcEnv(REPO_ROOT, process.platform);
  lines.push(`네이티브(Rust) fixture: ${nativeFixtures}개`);
  lines.push(`MSVC 툴체인: ${describeMsvc(msvc)}`);
  if (nativeFixtures > 0 && msvc.kind === "unavailable") {
    blockers.push(
      `Rust fixture ${nativeFixtures}개를 빌드할 수 없습니다 (MSVC 미준비).\n${indent(msvc.message)}`
    );
  }

  const openai = credentialPresent("openai");
  const anthropic = credentialPresent("anthropic");

  lines.push(`판정 기준 해시: ${criteriaHash()} (protocol v${CRITERIA.protocolVersion})`);
  lines.push(`가격 스냅샷 기준일: ${PRICING_SNAPSHOT_DATE}`);
  lines.push(`fixture ${input.fixtureCount}개 × arm ${input.arms.length}개 × 반복 ${input.repetitions}회`);
  lines.push(`OpenAI 자격증명: ${openai ? "있음" : "없음"}`);
  lines.push(`Anthropic 자격증명: ${anthropic ? "있음" : "없음"}`);
  lines.push(`executor 모델 override: ${input.executorModel ?? "(Model Registry 기본값)"}`);
  lines.push(`reviewer 모델 override: ${input.reviewerModel ?? "(Model Registry 기본값)"}`);

  // 공급자 독립성 — 이게 성립하지 않으면 Arm C는 "교차검증"이 아니다.
  const independence = openai && anthropic;
  lines.push(
    `공급자 독립성(검수자 ≠ 실행자): ${independence ? "성립" : "불성립 — 교차검증 arm을 돌릴 수 없습니다"}`
  );

  // **호출 수는 공용 계산기에서 온다** (§9).
  //
  // 예전에는 여기서 `fixture × arm × 반복 × 4`로 executor 호출만 세고 그 값을
  // "최대 API 호출 수"로 표시했다. confirmatory에서 화면에는 1,152가 찍혔고 실제 상한은
  // 1,584였다(executor 1,152 + reviewer 432). 같은 수를 두 곳에서 세면 반드시 갈라진다.
  const callBudget = computeCallBudget({
    fixtureCount: input.fixtureCount,
    arms: input.arms,
    repetitions: input.repetitions,
  });
  for (const line of describeCallBudget(callBudget)) lines.push(line);
  lines.push(`예산 상한: ${input.maxCostUsd === undefined ? "(미지정 — 상한 없이 진행)" : `$${input.maxCostUsd}`}`);

  if (input.usingFakeProvider) {
    lines.push("");
    lines.push("**fake provider 모드** — 하네스 자체를 검증하는 실행입니다.");
    lines.push("이 실행의 결과로는 가설을 판정하지 않습니다 (기록에 providerKind=fake로 남습니다).");
  }

  lines.push("");
  lines.push("사전 등록된 판정 기준:");
  for (const line of describeCriteria()) lines.push(`  - ${line}`);

  const canRunRealExperiment =
    artifacts.ok &&
    openai &&
    anthropic &&
    !input.usingFakeProvider &&
    !(nativeFixtures > 0 && msvc.kind === "unavailable");
  if (!input.usingFakeProvider) {
    // 이유를 그대로 옮긴다 — "없음"과 "별칭 충돌"은 사용자가 해야 하는 일이 다르다(§2.10).
    if (!openai) blockers.push(`${credentialProblem("openai") ?? "openai 자격증명 문제"} — Arm A/C/D를 실행할 수 없습니다`);
    if (!anthropic) {
      blockers.push(`${credentialProblem("anthropic") ?? "anthropic 자격증명 문제"} — Arm B/C/D를 실행할 수 없습니다`);
    }
  }

  // **확인하지 않은 것.** 자격증명 존재만 봤으므로 여기부터는 실제 호출이 필요하다.
  const notChecked = [
    "그 키로 공급자 호스트에 **닿는가** — 프록시·방화벽·오프라인은 여기서 보이지 않는다 (이 저장소의 개발 환경이 실제로 그렇다: 키가 있는데 egress가 막는다)",
    "그 키가 그 **모델을 부를 수 있는가** — 조직 인증이 필요한 모델은 조회는 되고 추론에서 죽는다(multi-engine 17절, gpt-5 사례)",
    "그 키가 **유효한가** — 만료·오타·다른 프로젝트의 키는 존재 여부로 구별되지 않는다",
  ];
  // **`lines`에 넣지 않는다.** 출력 자리는 호출부가 정한다 — 여기 넣으면 dry-run과
  // pilot이 각각 한 번씩, 합쳐서 두 번 찍힌다.

  return { ok: blockers.length === 0, canRunRealExperiment, lines, blockers, notChecked };
}

function describeMsvc(result: MsvcResult): string {
  switch (result.kind) {
    case "not_needed":
      return "해당 없음 (Windows가 아님)";
    case "ready":
      return "준비됨";
    case "unavailable":
      return `준비 실패 (종료 코드 ${result.exitCode})`;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
