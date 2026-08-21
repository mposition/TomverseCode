import type { ISODateTime } from "./common.js";

/**
 * 사용자 판정의 고정 — docs/design/state-machine-and-protocol.md 17.2절.
 *
 * # 왜 이 타입이 필요한가
 *
 * 요구에 대한 최종 권위는 사용자다(product-strategy.md 16.1절). 그런데 권위를 세우려면
 * 그 판정이 **소비되는 자리**가 있어야 한다. 이 타입이 생기기 전에는 사용자의 답변이
 * `answers[]`에 담겨 다음 프롬프트 문자열로만 주입됐고, 모델이 무시하면 그만이었다.
 * 프롬프트는 요청이지 기록이 아니다 — 기록이 있어야 나중 단계가 참조할 수 있다.
 */
export interface AcceptanceCriterion {
  criterionId: string;
  text: string;
  /**
   * 이 기준이 어디서 왔는가. **`user_decision`만이 권위를 갖는다** —
   * 나머지는 모델이 제안한 것이고 사용자가 뒤집을 수 있다.
   *
   * `user_message`는 타입 정의에는 있으나 현재 아무도 생성하지 않는다. 최초 요청 문장을
   * 통째로 기준으로 승격하면 체크리스트가 "요청 다시 읽기"가 되어 정보가 없기 때문이다.
   * 요청에서 기준을 뽑아내는 것은 모델의 해석이므로 `draft_proposal`로 들어온다.
   */
  source: "user_decision" | "draft_proposal" | "user_message";
  /** source = user_decision일 때, 어떤 불일치에 대한 답이었는지 */
  disagreementId?: string;
  decidedAt: ISODateTime;
}

/**
 * 이벤트 payload가 파생 캐시(`acceptance_criteria` 테이블)를 갱신할 때 쓰는 형태.
 *
 * **이벤트 없이 테이블만 갱신하는 경로를 만들지 않기 위한 장치다**(CLAUDE.md 원칙 7).
 * Rust는 이 필드가 붙은 이벤트를 기록하는 **같은 트랜잭션 안에서** 캐시를 갱신한다.
 * `tasks.counters_json`이 `payload.counters`로 갱신되는 것과 같은 규칙이다.
 */
export interface AcceptanceCriteriaCarrier {
  acceptanceCriteria: AcceptanceCriterion[];
  /**
   * 지정하면 그 source의 기존 행을 지우고 이번 목록으로 대체한다.
   *
   * 재질문 왕복 뒤 새 초안이 오면 이전 초안의 `doneCriteria`는 **철회된 해석**이다.
   * 그대로 쌓아두면 최종 보고가 아무도 지지하지 않는 기준을 사용자에게 보여준다.
   * 캐시를 지우는 것은 append-only 규칙과 충돌하지 않는다 — 지워지는 것은 파생 캐시이고,
   * 대체가 일어났다는 사실 자체는 이 이벤트로 로그에 남는다.
   */
  acceptanceCriteriaReplaces?: AcceptanceCriterion["source"];
}

// ---- 구조적 대조 결과 (DRAFTING에서 N=2일 때만 생성) ----
//
// docs/design/state-machine-and-protocol.md 17.2절. 근거는 product-strategy.md 16절:
// **모델은 판정자가 아니라 쟁점 발굴기다.** 두 실행자의 산출물이 갈렸다는 것은 모델의 주관적
// 감지가 아니라 **관측된 모호함**이고, 한 모델만 돌렸다면 영원히 묻지 않았을 질문이 여기서 나온다.

/** 대조 가능한 필드. DraftProposal의 부분집합이며, 자유 서술 필드는 제외한다. */
/**
 * **판정 가능한** 필드만 여기 있다 — 사용자에게 "어느 쪽입니까"를 물을 수 있는 것들.
 *
 * `interpretation`/`risks`는 여기 없다. 자유 서술이라 표현만 달라도 갈린 것으로 보이고,
 * 그래서 "갈렸다"는 관측이 거의 언제나 참이 되어 아무것도 구별해주지 않는다.
 * 그것들은 `NarrativeField`로 따로 다룬다 — 근거는 17.12절.
 */
export type DisagreementField =
  | "doneCriteria" // 완료 기준 — 갈리면 요구 자체가 모호하다는 뜻 (가장 강한 신호)
  | "requiredTests" // 무엇을 검증해야 하는가
  | "targetPaths"; // 어디를 고쳐야 하는가 — 문제의 위치에 대한 이견

/**
 * 자유 서술 필드. **비교하지 않고 나란히 보여줄 뿐**이다.
 *
 * 두 초안의 서술은 거의 언제나 다르다. 그걸 "불일치"라고 부르면 이름이 발견을 주장하는데
 * 실제로는 아무것도 발견하지 않은 것이고, 매번 채워지는 목록은 곧 읽히지 않는다(17.12절).
 */
export type NarrativeField =
  | "interpretation" // 근본 원인 진단
  | "risks"; // 한쪽만 본 위험

/**
 * 예산 초과 시 무엇을 먼저 묻는가 (17.4절). 앞에 올수록 우선.
 *
 * **이 순서는 추정이며 튜닝 대상이다** — 14절 지표(불일치 1건당 사용자가 뒤집은 비율)가
 * 쌓여야 조정 근거가 생긴다. 코드 여러 곳에 흩어놓지 않고 여기 한 줄로 둔 이유는,
 * 튜닝할 때 고칠 자리가 하나여야 하기 때문이다.
 *
 * 자유 서술이 빠지면서 이 순서에서 뒤 두 자리가 사라졌다. 그것들은 질문이 된 적이 없으므로
 * **예산을 다투는 목록에 있을 이유도 없었다** — 있는 동안은 지표의 분모만 부풀렸다.
 */
export const DISAGREEMENT_FIELD_RANK: readonly DisagreementField[] = [
  "doneCriteria",
  "targetPaths",
  "requiredTests",
];

/** 자유 서술의 표시 순서. 랭킹이 아니다 — 자를 일이 없으므로 우선순위가 없다. */
export const NARRATIVE_FIELD_ORDER: readonly NarrativeField[] = ["interpretation", "risks"];

export interface Disagreement {
  disagreementId: string;
  field: DisagreementField;
  /** 각 초안의 해당 필드 값. proposalId → 값. */
  positions: { proposalId: string; value: string[] }[];
  /**
   * blocking이면 사용자 판정 없이 진행하지 않는다.
   * 판정 기준은 17.4절 — 모델에게 "심각한가"를 묻지 않는다(그건 또 하나의 모델 의견이다).
   */
  blocking: boolean;
  /** blocking/비-blocking 판정의 근거 문장. 규칙 기반이므로 항상 설명할 수 있어야 한다. */
  blockingReason: string;
  /** 강제 선택 질문. 개방형 확인("이렇게 이해했는데 맞나요?")을 만들지 않는다 — 16.2절 ②. */
  question: {
    text: string;
    /** 각 선택지는 어느 초안에서 왔는지 추적 가능해야 한다. */
    options: { optionId: string; label: string; fromProposalId: string }[];
    /** 둘 다 아닐 수 있으므로 자유 입력을 항상 허용한다. */
    allowFreeform: true;
  };
}

/**
 * 각 초안의 자유 서술. **차이를 주장하지 않는다.**
 *
 * `Disagreement`와 달리 `blocking`도 `question`도 없다. 물을 수 없는 것에 질문 구조를 달아두면
 * 언젠가 누군가 "이것도 보여주자"며 카드에 넣게 되고, 그러면 답할 수 없는 질문이 예산을 먹는다.
 */
export interface DraftNarrative {
  field: NarrativeField;
  positions: { proposalId: string; value: string[] }[];
}

export interface DisagreementReport {
  taskId: string;
  reportId: string;
  proposalIds: string[];
  /** **판정 가능한** 쟁점만. 자유 서술은 `narratives`에 있다(17.12절). */
  disagreements: Disagreement[];
  /**
   * 각 초안이 원인과 위험을 어떻게 서술했는가. 비교 결과가 아니라 **원문 나열**이다.
   *
   * 여기 있는 것이 `disagreements`에 없는 이유: 이 필드들은 거의 언제나 다르므로 "갈렸다"가
   * 정보가 되지 않는다. 그렇다고 버리지도 않는다 — 두 초안이 문제를 어떻게 봤는지는 사용자가
   * 읽을 가치가 있고, 다만 **발견으로 포장하지 않을 뿐**이다.
   */
  narratives: DraftNarrative[];
  /** 대조했으나 일치한 필드. **검증이 아니다** — 상관된 오류는 불일치를 만들지 않는다(16.5절). */
  agreedFields: DisagreementField[];
  createdAt: ISODateTime;
}

/**
 * 3.9절 카드에서 사용자가 고른 답 하나. UI → Rust → sidecar로 그대로 전달된다.
 *
 * `text`를 optionId와 **함께** 싣는 이유: optionId는 이번 실행 안에서만 의미가 있는 식별자이고,
 * 감사 로그가 나중에 답해야 하는 질문은 "무엇을 골랐는가"이지 "어떤 id를 골랐는가"가 아니다.
 */
export interface UserDecisionInput {
  disagreementId: string;
  /** 고른 선택지. 자유 입력이면 없다. */
  optionId?: string;
  /** 고른 선택지의 라벨 또는 자유 입력 원문 — 판정의 실제 내용. */
  text: string;
}

// ---- 11. 기준이 실제로 참조되는 자리 (PLANNING / VERIFYING) ----
//
// docs/design/state-machine-and-protocol.md 17.3절 규칙 1·2. 사용자 판정을 기록만 하고
// 이후 단계가 보지 않으면, 그 판정은 여전히 "소비되는 자리"가 없는 것이다.

/**
 * 기준 하나에 대한 **결정론적** 판정. 모델 의견은 여기 들어오지 않는다.
 *
 * 값이 5개인 이유는 `VerificationStatus`가 3값에서 5값으로 늘어난 것과 같다 —
 * "확인하지 못했다"를 "충족했다"로도 "위반했다"로도 뭉개지 않기 위해서다.
 */
export type CriterionCheckStatus =
  /** 기준이 지목한 테스트가 실제로 실행됐고, 그 검증이 통과했다. */
  | "VERIFIED_BY_TEST"
  /** 기준이 지목한 테스트가 있는데 그 검증이 실패했다. */
  | "CONTRADICTED_BY_TEST"
  /** 기준이 지목한 파일을 이번 변경이 하나도 건드리지 않았다 (PLANNING 게이트가 잡는다). */
  | "CONFLICTS_WITH_CHANGE"
  /**
   * 자동으로 이을 근거가 없다. **대부분의 기준이 여기다.**
   *
   * 이걸 `VERIFIED_BY_TEST`로 만드는 유일한 방법이 모델에게 묻는 것인데, 그 순간
   * product-strategy.md 9절의 순환 의존이 그대로 재현된다.
   */
  | "UNVERIFIED";

/**
 * 판정의 **기계가 읽는** 사유. `reason`(한국어 문장)과 짝을 이룬다.
 *
 * # 왜 문장만으로 부족한가
 *
 * 12절 미해결 항목이 묻는 것은 "기준↔테스트를 **얼마나** 이을 수 있는가"이고, 그 답은 집계로만
 * 나온다. 그런데 사유가 사람이 읽는 문장뿐이면 집계가 **한국어 문장을 파싱**해야 하고, 문구를
 * 다듬는 순간 과거 데이터와 끊긴다. 문장은 화면용, 이 코드는 집계용이다.
 *
 * 특히 `UNVERIFIED`를 한 덩어리로 두면 "기준에 테스트 이름이 없었다"와 "이름은 있는데 실행
 * 근거가 없었다"가 구별되지 않는데, 그 둘은 **고쳐야 할 곳이 서로 다르다** —
 * 전자는 기준을 적는 방식의 문제이고 후자는 잇는 규칙의 문제다.
 */
export type CriterionCheckCode =
  /** 지목한 테스트가 실행됐고 test 체크가 통과했다. */
  | "verified_named_test_ran"
  /** 지목한 테스트를 포함한 test 체크가 실패/타임아웃했다. */
  | "named_test_check_failed"
  /** 사용자가 지목한 파일을 이번 변경이 하나도 건드리지 않았다. */
  | "changed_paths_disjoint"
  /** 기준 문장에 테스트 파일처럼 생긴 것이 아예 없다. **커버리지의 주 병목**이다. */
  | "no_test_reference"
  /** 테스트 파일을 적었으나 워크스페이스에 그런 파일이 없다 (모델/사용자가 지어낸 이름). */
  | "test_reference_not_found"
  /** 실재하는 테스트를 지목했고 통과했지만, 그것이 실제로 실행됐다는 근거가 없다. */
  | "no_run_evidence"
  /** 프로젝트에 테스트 명령이 없다. */
  | "test_not_configured"
  /** 리포트에 test 체크 자체가 없다. */
  | "test_check_missing"
  /** test 체크가 통과도 실패도 아닌 상태(건너뜀 등)라 근거가 되지 못한다. */
  | "test_check_inconclusive"
  /** 검증 리포트가 아직 없다 (검증 전에 끝난 태스크). */
  | "no_verification_report";

export interface CriterionEvaluation {
  criterionId: string;
  status: CriterionCheckStatus;
  /** 집계용 사유 코드. 문구가 바뀌어도 과거 데이터와 이어진다. */
  code: CriterionCheckCode;
  /**
   * 왜 그 판정인지. **결정론적 근거만 들어간다** — "모델이 그렇게 판단함"은 근거가 아니다.
   * 화면이 이 문장을 그대로 보여준다.
   */
  reason: string;
  /** 판정의 근거가 된 구체적 값(테스트 파일 경로, 변경된 파일 경로 등). */
  evidence?: string[];
}

/**
 * 기준 충돌(PLANNING 게이트)이 **어떻게 끝났는가** — 12절 미해결 "위치 충돌 규칙의 오탐률".
 *
 * # 관측할 수 없는 것을 관측한 척하지 않는다
 *
 * "이 충돌이 진짜 잘못된 계획이었는가"의 정답은 **어디에도 없다.** 사용자가 매번 판정해주지
 * 않는 한 우리가 아는 것은 "재요청했더니 계획이 바뀌었다/안 바뀌었다"와 "그대로 진행했더니
 * 검증이 통과했다/실패했다"뿐이다. 그래서 이름을 "false positive"가 아니라 **일어난 일 그대로**
 * 붙였다 — 지표 이름이 추론을 포함하면 집계를 읽는 사람이 그 추론을 사실로 읽는다.
 */
export type CriteriaConflictOutcome =
  /** 재요청 뒤 계획이 사용자가 지목한 파일을 건드리게 바뀌었다. */
  | "plan_changed_to_expected"
  /** 재요청했는데도 여전히 다른 곳을 고친다. */
  | "plan_unchanged"
  /** 재요청 예산을 소진해 충돌을 안은 채 진행했다. */
  | "proceeded_without_change"
  /**
   * 재요청 뒤 계획 단계에 다시 도달하지 못한 채 태스크가 끝났다 (거부·취소·실패 등).
   *
   * 이 값을 둔 이유: 이게 없으면 그런 충돌은 **결말 없이 사라지고**, 집계가 "감지 N건,
   * 결말 M건(M<N)"이 되어 차이가 어디서 났는지 알 수 없다. 결말을 세는 지표는 결말이
   * 빠짐없이 남을 때만 의미가 있다.
   */
  | "task_ended_before_replan";
