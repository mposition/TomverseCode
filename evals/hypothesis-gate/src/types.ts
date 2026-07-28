/**
 * 가설 게이트의 데이터 형태.
 *
 * `@tomverse/protocol`에 넣지 않은 이유: 이건 **제품 프로토콜이 아니라 측정 도구의 스키마**다.
 * 제품 타입과 섞으면 "실험용 필드가 제품 계약에 남는" 방향으로 새기 쉽다.
 */

/** 명령은 셸 문자열이 아니라 argv다 — 하네스도 이 계약을 따른다. */
export interface CommandArgv {
  program: string;
  args: string[];
  /** fixture workspace 기준 상대 경로. 생략하면 workspace 루트. */
  cwd?: string;
}

export const FIXTURE_CATEGORIES = [
  "multi_file_contract",
  "async_ordering",
  "state_machine_bounds",
  "security_path_permission",
  "schema_compatibility",
  "error_recovery_rollback",
  "public_api_change",
  "ambiguous_requirement",
] as const;

export type FixtureCategory = (typeof FIXTURE_CATEGORIES)[number];

export const FIXTURE_LANGUAGES = ["typescript", "rust"] as const;
export type FixtureLanguage = (typeof FIXTURE_LANGUAGES)[number];

export interface FixtureManifest {
  fixtureId: string;
  category: FixtureCategory;
  language: FixtureLanguage;
  /** 모델에게 주는 사용자 요청. arm 전체가 **글자 그대로 같은 것**을 받는다. */
  taskPrompt: string;
  /** 의존성 설치 등. 없으면 생략 (fixture는 의존성 없이 도는 것을 원칙으로 한다). */
  setupCommand?: CommandArgv;
  /** 모델이 볼 수 있고 스스로 돌릴 수 있는 검증 — workspace 안에 있다. */
  publicVerificationCommands: CommandArgv[];
  /**
   * 진짜 판정 기준. **모델의 workspace에 존재하지 않는다** — oracle 실행 시점에만 주입된다.
   * 성공 판정은 오직 이것으로 한다. 모델의 verdict는 판정에 쓰지 않는다.
   */
  oracleVerificationCommands: CommandArgv[];
  /** 모델이 건드리면 안 되는 경로 (workspace 상대). 위반하면 실패로 분류한다. */
  forbiddenPaths: string[];
  /** 이 fixture가 지키려는 불변식 — 사람이 읽는 한 줄. 리포트에 그대로 나간다. */
  expectedInvariant: string;
  timeoutMs: number;
}

export type ArmId = "A" | "B" | "C" | "D";

export interface ArmSpec {
  arm: ArmId;
  label: string;
  /** 후보 공급자 — 하나면 라우터가 검수자 독립성 불변식에 따라 reviewer를 스스로 드롭한다. */
  providers: string[];
  reviewMode?: "blind" | "informed";
  /** 이 arm의 초안을 어디서 얻는가. `replay`면 `draftSourceArm`의 초안을 그대로 쓴다. */
  draftSource: "generate" | "replay";
  draftSourceArm?: ArmId;
  /** primary 비교에 들어가는 arm인가 (§13 반복 횟수 기준의 대상) */
  primary: boolean;
}

export type ReviewerContribution =
  | "correction"
  | "harm"
  | "no_measurable_correction"
  | "ineffective";

/** 모델/파이프라인 실패 — 이건 실험 결과다. */
export const MODEL_FAILURE_CLASSES = [
  "wrong_patch",
  "incomplete_fix",
  "schema_violation",
  "reviewer_harm",
  "test_regression",
  "requirement_unmet",
  "policy_denied",
  "forbidden_path_touched",
  "no_change_produced",
] as const;

/** 인프라 실패 — 이건 실험 결과가 **아니다.** 모델 실패로 세면 안 된다. */
export const INFRA_FAILURE_CLASSES = [
  "auth_failure",
  "rate_limit",
  "provider_5xx",
  "network_timeout",
  "host_crash",
  "fixture_setup_failure",
  "oracle_harness_failure",
  "budget_exhausted",
  /**
   * 네이티브 툴체인(Windows MSVC)이 준비되지 않아 Rust fixture를 빌드할 수 없었다.
   * **개발 환경 문제이지 모델 실패가 아니다** — 모델 실패로 세면 "Rust에서 모델이 약하다"는
   * 잘못된 결론이 나온다.
   */
  "toolchain_unavailable",
] as const;

export type ModelFailureClass = (typeof MODEL_FAILURE_CLASSES)[number];
export type InfraFailureClass = (typeof INFRA_FAILURE_CLASSES)[number];
export type FailureClass = ModelFailureClass | InfraFailureClass;

export function isInfrastructureFailure(failureClass: string | undefined): boolean {
  return failureClass !== undefined && (INFRA_FAILURE_CLASSES as readonly string[]).includes(failureClass);
}

/** 한 (fixture, arm, repetition) 실행의 기록. 완료 직후 JSONL로 append된다. */
export interface GateRunRecord {
  schemaVersion: number;
  runId: string;
  fixtureId: string;
  fixtureHash: string;
  category: FixtureCategory;
  repetition: number;
  arm: ArmId;
  seed: number;

  taskId: string;
  providerId: string;
  requestedModelId: string;
  returnedModelId?: string;
  reviewMode?: "blind" | "informed";
  /** 초안을 새로 만들었는지 재생했는지 — arm C/D의 paired 비교가 성립하는 근거다. */
  draftSource?: "generated" | "replayed";

  publicVerificationPassed: boolean;
  oracleVerificationPassed: boolean;
  /** 검수 전 초안만의 oracle 결과 (Arm A의 결과를 paired로 붙인다) */
  draftOraclePassed?: boolean;
  /** 검수 후 결과의 oracle 결과 */
  reviewedOraclePassed?: boolean;

  reviewerVerdict?: string;
  reviewerContribution?: ReviewerContribution;

  inputTokens: number;
  outputTokens: number;
  providerCallCount: number;
  retryCount: number;
  latencyMs: number;
  costUsd?: number;

  failureClass?: FailureClass;
  changedFiles: string[];
  policyDenials: string[];

  promptVersionHash: string;
  startedAt: string;
  completedAt: string;

  /**
   * 이 기록이 실제 API로 만들어진 것인지.
   *
   * **판정에 결정적이다**: fake provider 기록으로 가설을 판정하면 안 되므로, 집계 단계가
   * 이 플래그를 보고 거부한다. 기록 자체에 남겨야 나중에 파일만 봐도 구별된다.
   */
  providerKind: "real" | "fake";
  /** 기록 시점의 판정 기준 해시 — 다른 기준으로 만든 기록과 섞이지 않게 한다. */
  criteriaHash: string;
}

export const RECORD_SCHEMA_VERSION = 1;

export type GateVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface ArmSummary {
  arm: ArmId;
  label: string;
  runs: number;
  /** 인프라 실패를 제외한 유효 실행 수 — 성공률의 분모다 */
  evaluableRuns: number;
  oraclePasses: number;
  oraclePassRate: number;
  publicPasses: number;
  infraFailures: number;
  meanCostUsd: number;
  costPerSuccessUsd: number | null;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  retryRate: number;
}
