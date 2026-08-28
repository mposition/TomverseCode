import type { DispatchState } from "@tomverse/sidecar/budget";

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
  /**
   * 실제 응답에 usage가 없거나 모델 단가를 몰라 비용을 계산할 수 없었다.
   * **모델 실패가 아니다** — 예산 상한을 강제할 수 없다는 하네스/설정 문제이며,
   * 이 값이 나오면 남은 유료 호출을 중단한다.
   */
  "cost_unmeasurable",
  /**
   * 공급자 호출이 타임아웃으로 취소됐다.
   *
   * **모델 품질 실패와 섞지 않는다.** 이건 모델이 틀린 답을 냈다는 뜻이 아니라 우리가 정한
   * 실행 예산 안에서 답을 다 받지 못했다는 뜻이다. 하나로 뭉치면 "이 모델이 어려운 태스크에
   * 약하다"와 "우리가 기다려주지 않았다"가 같은 숫자에 들어간다.
   *
   * 실측(P1, 2026-08-27): 검수 호출 하나가 정확히 120초에 취소됐고 그 요청은 공급자에 도달해
   * **과금됐다**(청구 내역으로 확인). `cost_unmeasurable`로만 적으면 "비용을 못 쟀다"는 사실만
   * 남고 **왜 못 쟀는지**가 사라진다 — 원인이 타임아웃이면 고칠 곳이 설정이지 하네스가 아니다.
   */
  "provider_timeout",
  /**
   * 공급자가 **추론 전에 요청을 반려**했다 (429·401·403이 아닌 4xx).
   *
   * 모델 실패가 아니다 — 모델은 이 요청을 본 적이 없다. 고칠 곳은 우리 요청이며(스키마,
   * 본문 크기, 파라미터) 실패율을 읽는 사람에게도 "모델이 못 풀었다"와는 다른 소식이다.
   *
   * **비용은 0이다.** 생성이 시작되기 전에 반려되므로 과금되지 않는다 — 이 저장소에서
   * 실측으로 확인했다(strict 스키마 400 거절이 공급자 청구 내역에 없었다). 그래서 이 분류는
   * 예약을 해제해도 되는 근거가 되고, 실행을 멈추지 않고 다음 fixture로 넘어간다.
   */
  "invalid_request",
] as const;

export type ModelFailureClass = (typeof MODEL_FAILURE_CLASSES)[number];
export type InfraFailureClass = (typeof INFRA_FAILURE_CLASSES)[number];
export type FailureClass = ModelFailureClass | InfraFailureClass;

export function isInfrastructureFailure(failureClass: string | undefined): boolean {
  return failureClass !== undefined && (INFRA_FAILURE_CLASSES as readonly string[]).includes(failureClass);
}

/**
 * **호출 하나의 사실** (§2.6).
 *
 * # 왜 record 하나에 `returnedModelId` 하나로는 부족한가
 *
 * 한 기록은 executor·reviewer·재시도·revise·fix-loop을 합쳐 여러 번 공급자를 부른다.
 * 그런데 `GateRunRecord`는 `returnedModelId`를 **하나만** 갖고 있었고, 그 값은
 * `DRAFT_RECEIVED.model`(= 어댑터가 자기 요청 ID를 채운 자기보고 값)이었다. 그래서
 *
 *  - reviewer가 다른 모델로 조용히 대체돼도 보이지 않고,
 *  - 재시도한 attempt가 몇 번 나갔는지, 그중 무엇이 과금됐는지 알 수 없고,
 *  - exact-model 검증이 **항상 통과**했다(요청 ID와 요청 ID를 비교하므로).
 *
 * 그래서 호출마다 사실을 남긴다. **응답 원문과 프롬프트는 담지 않는다** — 여기 들어가는 것은
 * 식별자·상태·토큰 수·비용뿐이다.
 */
export interface ProviderCallFact {
  /** 오케스트레이터의 호출 키 ("draft:1", "review:2", "fix:1"). */
  callId: string;
  role: "executor" | "reviewer" | "unknown";
  /** 재시도 번호. 같은 callId의 attempt가 여러 개일 수 있다. */
  attempt: number;
  providerId: string;
  requestedModelId: string;
  /** **응답 envelope이 실어 온** 모델 ID. 없으면 exact-model 검증이 실패한다. */
  providerReportedModelId?: string;
  providerRequestId?: string;
  /** 요청이 실제로 나갔는가 — 과금 가능성 판정의 근거다. */
  dispatchState: DispatchState;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  errorKind?: string;
  status: "succeeded" | "failed" | "unknown";
  startedAt: string;
  completedAt?: string;
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
  /**
   * `DRAFT_RECEIVED.model` — **품질 출력 메타데이터일 뿐이다** (§2.8).
   *
   * 어댑터가 `this.modelId`를 채운 자기보고 값이므로 exact-model 검증의 근거가 되지 못한다.
   * 근거는 `providerCalls[*].providerReportedModelId`(응답 envelope)다.
   */
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

  /**
   * 이 기록이 **어느 실행 승인으로** 만들어졌는가 (§2.3).
   *
   * 없으면 attestation이 "무엇을 증명하는가"를 말할 수 없다 — 명령 시점에 넘겨받은 카드가
   * 실제로 실행된 카드라는 보장이 어디에도 없기 때문이다. fake 실행에는 receipt가 없다.
   */
  receiptId?: string;
  receiptHash?: string;

  /** 이 기록이 실제로 만든 provider 호출 전부. 이벤트를 읽지 못했으면 비어 있다. */
  providerCalls: ProviderCallFact[];
  /**
   * DB 이벤트를 읽을 수 있었는가 (§2.7).
   *
   * **읽지 못한 것 자체가 과금 불확실 상태다** — 호출이 나갔는지 알 수 없으므로 예약을
   * 해제하지 않는다. `false`를 "호출 0회"로 읽으면 안 되므로 별도 축으로 남긴다.
   */
  eventsReadable: boolean;
}

/**
 * 2: `providerCalls`/`eventsReadable`/`receiptId`가 필수가 됐다 (§2.3, §2.6, §2.7).
 * v1 기록은 호출별 사실이 없으므로 exact-model 검증을 할 수 없다.
 */
export const RECORD_SCHEMA_VERSION = 2;

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
  /**
   * **분모에서 빠진 기록이 무엇이었는지.**
   *
   * 개수만 적으면 "23 / 24"의 그 1건이 무엇인지 알 수 없고, 그러면 분모가 arm마다 다른
   * 이유를 리포트만 보고 설명할 수 없다. 성공률과 신뢰구간이 서 있는 바닥이므로 목록으로 낸다.
   */
  excludedRuns: { fixtureId: string; repetition: number; failureClass?: string }[];
  meanCostUsd: number;
  costPerSuccessUsd: number | null;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  retryRate: number;
}
