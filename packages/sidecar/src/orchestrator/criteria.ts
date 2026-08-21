import type {
  AcceptanceCriterion,
  CriterionEvaluation,
  VerificationCheck,
  VerificationReport,
} from "@tomverse/protocol";

/**
 * 기준이 실제로 참조되는 자리 — docs/design/state-machine-and-protocol.md 17.3절 규칙 1·2.
 *
 * # 이 모듈이 절대 하지 않는 것
 *
 * **모델에게 "이 기준이 충족됐나"를 묻지 않는다.** 그 순간 product-strategy.md 9절의 순환
 * 의존이 그대로 재현된다 — 검증되지 않은 판정으로 검증을 대신하게 된다. 여기 있는 것은 전부
 * 문자열 일치와 결정론적 검증 결과뿐이고, 그래서 모든 판정에 근거 문장을 붙일 수 있다.
 *
 * # 기본값이 "미확인"인 이유 (fail-closed)
 *
 * 이을 근거가 조금이라도 부족하면 `UNVERIFIED`다. 확인을 넓게 잡으면 화면이 초록색으로
 * 덮이는데, 그 초록색은 우리가 파는 것("검증 신뢰성")을 파는 행위다. 좁게 잡으면 화면이
 * 물음표로 덮이고 그건 그냥 **현재 상태의 정직한 표시**다.
 *
 * # Rust와의 경계
 *
 * 통과/실패라는 사실은 전부 Rust가 만든 `VerificationReport`에서 온다(CLAUDE.md 원칙 1·2).
 * 이 모듈은 그것을 **읽어서 기준에 잇기만** 하고, 검증 결과를 만들어내지 않는다.
 * UI는 이 판정 옆에 Rust의 리포트를 그대로 함께 보여준다 — 이 파생값만 보고 믿지 않도록.
 */

/**
 * 테스트 파일처럼 생긴 토큰. `:41` 같은 줄 번호가 붙어도 잡는다.
 *
 * 확장자 목록을 넓히지 않은 이유: 넓힐수록 평범한 문장이 우연히 걸려 "확인됨"이 늘어난다.
 * 이 정규식이 놓치는 것은 미확인으로 남을 뿐이고, 잘못 잡는 것은 거짓말이 된다.
 */
const TEST_REFERENCE = /[\w./\\-]+\.(?:test|spec)\.[a-z]{1,4}(?::\d+)?/gi;

/** 워크스페이스 상대 경로처럼 생긴 토큰 (확장자가 있는 것만). */
const PATH_REFERENCE = /[\w.\\/-]+\.[a-z]{1,5}(?::\d+)?/gi;

export interface CriteriaContext {
  /** 스냅샷이 본 워크스페이스 파일 목록. **실재하는 경로만** 근거로 쓴다. */
  workspaceFiles: readonly string[];
}

/**
 * 기준 텍스트에서 실재하는 파일 경로만 뽑는다.
 *
 * 워크스페이스에 없는 경로를 근거로 쓰지 않는 이유: 모델도 사용자도 존재하지 않는 파일 이름을
 * 적을 수 있고, 그걸 근거로 "확인됨"을 만들면 근거 자체가 허구가 된다.
 */
function extractExistingPaths(text: string, pattern: RegExp, context: CriteriaContext): string[] {
  const index = new Map<string, string>();
  for (const file of context.workspaceFiles) index.set(canonical(file), file);

  const found = new Set<string>();
  for (const raw of text.match(pattern) ?? []) {
    // `validate.test.ts:41` → `validate.test.ts`
    const withoutLine = raw.replace(/:\d+$/, "");
    const exact = index.get(canonical(withoutLine));
    if (exact) {
      found.add(exact);
      continue;
    }
    // 파일명만 적은 경우(`validate.test.ts`)도 흔하다. **정확히 하나**에만 대응될 때 인정한다 —
    // 여럿이면 어느 것을 가리키는지 모르므로 근거가 되지 못한다.
    const base = canonical(withoutLine).split("/").pop() ?? "";
    if (base.length === 0) continue;
    const matches = context.workspaceFiles.filter((f) => canonical(f).split("/").pop() === base);
    if (matches.length === 1) found.add(matches[0] as string);
  }
  return [...found];
}

/** 테스트 파일처럼 생겼는가. `TEST_REFERENCE`와 같은 판정을 경로 하나에 적용한다. */
function looksLikeTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[a-z]{1,4}$/i.test(path);
}

function canonical(value: string): string {
  return value.replace(/[\\]/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

// ---- PLANNING 게이트 (17.3절 규칙 1) ----

export interface CriteriaConflict {
  criterionId: string;
  /** 기준이 지목한 파일들 (실재하는 것만). */
  expectedPaths: string[];
  /** 이번 계획이 실제로 건드리는 파일들. */
  actualPaths: string[];
  message: string;
}

/**
 * "확정된 기준을 만족하지 못하는 계획"을 **결정론적으로 잡을 수 있는 한 가지 경우**를 잡는다:
 * 사용자가 고른 파일을 계획이 하나도 건드리지 않는 경우.
 *
 * # 왜 이 한 가지뿐인가
 *
 * 기준은 자유 문장이므로 "이 patch가 이 문장을 만족하는가"는 일반적으로 판정할 수 없다.
 * 판정하려면 모델을 불러야 하고 그건 9절 순환 의존이다. 그런데 **위치에 대한 판정**만은
 * 예외다 — 3.9절 `targetPaths` 카드에서 사용자가 고르는 선택지가 곧 파일 경로 목록이라,
 * 기준 텍스트와 계획의 대상 경로를 문자열로 비교할 수 있다.
 *
 * # 오탐을 막는 조건 (전부 만족해야 충돌이다)
 *
 * 1. `source === "user_decision"`인 기준만 본다 — 모델 제안은 사용자가 뒤집을 수 있는 후보다.
 * 2. 기준 텍스트가 지목한 경로가 **워크스페이스에 실재**해야 한다.
 * 3. 계획이 파일을 하나라도 바꿔야 한다 (빈 계획은 비교 대상이 없다).
 * 4. 지목된 경로와 변경 경로의 교집합이 **완전히 비어야** 한다. 하나라도 겹치면 범위 차이일
 *    뿐이고, 범위 차이를 충돌로 부르면 정상 작업이 매번 막힌다.
 */
export function findCriteriaConflicts(
  criteria: readonly AcceptanceCriterion[],
  changedPaths: readonly string[],
  context: CriteriaContext
): CriteriaConflict[] {
  if (changedPaths.length === 0) return [];
  const changed = new Set(changedPaths.map(canonical));

  const conflicts: CriteriaConflict[] = [];
  for (const criterion of criteria) {
    if (criterion.source !== "user_decision") continue;
    // **테스트 파일은 변경 대상이 아니라 근거다.** "빈 문자열을 거부한다 (validate.test.ts:41)"
    // 에서 그 파일은 "여기를 고쳐라"가 아니라 "이걸로 확인된다"는 뜻이다. 구별하지 않으면
    // 근거를 적은 기준이 전부 충돌로 잡혀 정상 작업을 막는다(실측으로 그렇게 잡혔다).
    const expected = extractExistingPaths(criterion.text, PATH_REFERENCE, context).filter(
      (path) => !looksLikeTestFile(path)
    );
    if (expected.length === 0) continue;
    if (expected.some((p) => changed.has(canonical(p)))) continue;

    conflicts.push({
      criterionId: criterion.criterionId,
      expectedPaths: expected,
      actualPaths: [...changedPaths],
      message:
        `사용자가 확정한 기준은 ${expected.join(", ")}을(를) 지목했는데 ` +
        `이번 계획은 ${changedPaths.join(", ")}만 변경합니다.`,
    });
  }
  return conflicts;
}

// ---- VERIFYING 체크리스트 (17.3절 규칙 2) ----

export interface EvaluateInput {
  criteria: readonly AcceptanceCriterion[];
  /** Rust가 만든 검증 리포트. 없으면 전부 미확인이다. */
  report: VerificationReport | null;
  /** 이번 태스크가 실제로 바꾼 파일 — PLANNING 게이트가 놓친 충돌을 여기서도 표시한다. */
  changedPaths: readonly string[];
  context: CriteriaContext;
}

/**
 * 기준별 판정. **모든 기준에 대해 정확히 하나씩** 결과를 만든다 — 빠뜨리면 화면에서
 * 그 기준이 사라지고, 사라진 기준은 "충족했다"로 읽힌다.
 */
export function evaluateCriteria(input: EvaluateInput): CriterionEvaluation[] {
  const { criteria, report, changedPaths, context } = input;
  const testCheck = report?.checks.find((c) => c.kind === "test");
  const conflicts = new Map(
    findCriteriaConflicts(criteria, changedPaths, context).map((c) => [c.criterionId, c])
  );

  return criteria.map((criterion) => {
    const conflict = conflicts.get(criterion.criterionId);
    if (conflict) {
      return {
        criterionId: criterion.criterionId,
        status: "CONFLICTS_WITH_CHANGE" as const,
        code: "changed_paths_disjoint" as const,
        reason: conflict.message,
        evidence: conflict.expectedPaths,
      };
    }

    const named = extractExistingPaths(criterion.text, TEST_REFERENCE, context);
    if (named.length === 0) {
      // **"이름이 없었다"와 "이름은 있는데 그런 파일이 없다"를 나눈다.** 고쳐야 할 곳이 다르다 —
      // 전자는 기준을 적는 방식의 문제이고, 후자는 지어낸 이름을 근거로 쓰지 않는 규칙이
      // 제대로 작동한 것이다. 한 덩어리로 세면 커버리지가 왜 낮은지 알 수 없다.
      const mentioned = (criterion.text.match(TEST_REFERENCE) ?? []).length > 0;
      return {
        criterionId: criterion.criterionId,
        status: "UNVERIFIED" as const,
        code: mentioned ? ("test_reference_not_found" as const) : ("no_test_reference" as const),
        // 이유를 적어두지 않으면 화면의 물음표가 결함처럼 보인다.
        reason: mentioned
          ? "기준이 지목한 테스트 파일이 워크스페이스에 없어 근거로 쓸 수 없습니다."
          : "이 기준이 어떤 테스트로 확인되는지 자동으로 이을 수 없습니다 (기준 문장에 테스트 파일이 언급되지 않음).",
      };
    }

    return evaluateNamedTest(criterion, named, testCheck, report !== null);
  });
}

/**
 * 기준이 테스트 파일을 지목한 경우의 판정.
 *
 * **"테스트 파일이 실재하고 test 체크가 통과했다"만으로 확인됨을 주장하지 않는다.** 그 테스트가
 * 실제로 실행됐다는 근거가 따로 있어야 한다 — 러너가 그 파일을 포함하지 않았을 수 있고,
 * 그러면 "통과"는 그 기준과 아무 상관이 없다. 그래서 검증 출력에 그 파일이 나타났는지를
 * 함께 확인하고, 출력을 얻지 못하면 확인이 아니라 미확인으로 떨어진다(fail-closed).
 */
function evaluateNamedTest(
  criterion: AcceptanceCriterion,
  named: string[],
  testCheck: VerificationCheck | undefined,
  hasReport: boolean
): CriterionEvaluation {
  const base = { criterionId: criterion.criterionId, evidence: named };

  if (!testCheck) {
    return {
      ...base,
      status: "UNVERIFIED",
      code: hasReport ? "test_check_missing" : "no_verification_report",
      reason: hasReport ? "검증 리포트에 test 체크가 없습니다." : "검증이 아직 실행되지 않았습니다.",
    };
  }
  if (testCheck.status === "NOT_CONFIGURED") {
    return {
      ...base,
      status: "UNVERIFIED",
      code: "test_not_configured",
      reason: "이 프로젝트에 테스트 명령이 없어 지목된 테스트를 실행하지 못했습니다.",
    };
  }
  if (testCheck.status === "FAILED" || testCheck.status === "TIMED_OUT") {
    // 실패는 확인의 반대가 아니라 **반증**이다. 미확인으로 뭉개면 실패가 침묵으로 보인다.
    return {
      ...base,
      status: "CONTRADICTED_BY_TEST",
      code: "named_test_check_failed",
      reason: `이 기준이 지목한 ${named.join(", ")}를 포함한 검증(test)이 실패했습니다.`,
    };
  }
  if (testCheck.status !== "PASSED") {
    return {
      ...base,
      status: "UNVERIFIED",
      code: "test_check_inconclusive",
      reason: `test 체크가 ${testCheck.status} 상태라 확인 근거가 되지 못합니다.`,
    };
  }

  // 실행 근거는 세 곳에서 찾는다. **실행된 argv가 가장 강한 근거다** — 러너가 그 파일을 인자로
  // 받았다면 그 파일은 실행됐다. 출력은 러너 형식에 따라 파일명을 안 찍을 수도 있어 보조다.
  const commandLine = testCheck.command ? [testCheck.command.program, ...testCheck.command.args].join(" ") : "";
  const output = `${commandLine}\n${testCheck.detail ?? ""}\n${testCheck.summary}`;
  const ran = named.filter((path) => outputMentions(output, path));
  if (ran.length === 0) {
    return {
      ...base,
      status: "UNVERIFIED",
      code: "no_run_evidence",
      reason:
        `test 체크는 통과했지만 실행 명령과 출력 어디에서도 ${named.join(", ")}가 실제로 실행된 근거를 ` +
        "찾지 못했습니다 (러너가 그 파일을 포함하지 않았을 수 있습니다).",
    };
  }
  return {
    ...base,
    status: "VERIFIED_BY_TEST",
    code: "verified_named_test_ran",
    reason: `${ran.join(", ")}가 실행됐고 test 체크가 통과했습니다. 이 기준을 그 테스트가 확인했다는 뜻이 아니라, 그 테스트가 실행되어 통과했다는 뜻입니다.`,
    evidence: ran,
  };
}

/** 출력에 그 파일이 언급됐는가. 경로 구분자와 대소문자 차이는 무시한다. */
function outputMentions(output: string, path: string): boolean {
  const haystack = canonical(output);
  const needle = canonical(path);
  if (haystack.includes(needle)) return true;
  const base = needle.split("/").pop() ?? "";
  return base.length > 0 && haystack.includes(base);
}

/**
 * 최종 보고 한 줄. 상태별 개수를 **뭉치지 않고** 센다.
 *
 * 확인된 것이 0개인 것은 정상 상태이지만, 그 사실을 말하지 않으면 화면이 "다 됐다"로 읽힌다.
 */
export function describeEvaluations(evaluations: readonly CriterionEvaluation[]): string | null {
  if (evaluations.length === 0) return null;
  const count = (status: CriterionEvaluation["status"]) =>
    evaluations.filter((e) => e.status === status).length;

  const parts = [`기준 ${evaluations.length}개`];
  const verified = count("VERIFIED_BY_TEST");
  const contradicted = count("CONTRADICTED_BY_TEST");
  const conflicting = count("CONFLICTS_WITH_CHANGE");
  const unverified = count("UNVERIFIED");

  parts.push(`테스트로 확인 ${verified}개`);
  if (contradicted > 0) parts.push(`테스트가 반증 ${contradicted}개`);
  if (conflicting > 0) parts.push(`변경과 충돌 ${conflicting}개`);
  parts.push(`미확인 ${unverified}개`);
  return parts.join(" · ");
}
