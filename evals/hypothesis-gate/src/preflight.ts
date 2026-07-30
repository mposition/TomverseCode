import { prepareMsvcEnv, type MsvcResult } from "@tomverse/toolchain";
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
  /** 실제 API 실험을 돌릴 수 있는가. false면 결과는 NOT_RUN이고 게이트는 INCONCLUSIVE다. */
  canRunRealExperiment: boolean;
  lines: string[];
  blockers: string[];
}

const PROVIDER_ENV: { providerId: string; envNames: string[] }[] = [
  { providerId: "openai", envNames: ["OPENAI_API_KEY", "TOMVERSE_OPENAI_API_KEY"] },
  { providerId: "anthropic", envNames: ["ANTHROPIC_API_KEY", "TOMVERSE_ANTHROPIC_API_KEY"] },
];

export function credentialPresent(providerId: string): boolean {
  const entry = PROVIDER_ENV.find((p) => p.providerId === providerId);
  if (!entry) return false;
  return entry.envNames.some((name) => (process.env[name] ?? "").trim().length > 0);
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
    if (!openai) blockers.push("OPENAI_API_KEY가 없습니다 — Arm A/C/D를 실행할 수 없습니다");
    if (!anthropic) blockers.push("ANTHROPIC_API_KEY가 없습니다 — Arm B/C/D를 실행할 수 없습니다");
  }

  return { ok: blockers.length === 0, canRunRealExperiment, lines, blockers };
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
