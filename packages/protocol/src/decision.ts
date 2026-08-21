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
export type DisagreementField =
  | "doneCriteria" // 완료 기준 — 갈리면 요구 자체가 모호하다는 뜻 (가장 강한 신호)
  | "requiredTests" // 무엇을 검증해야 하는가
  | "targetPaths" // 어디를 고쳐야 하는가 — 문제의 위치에 대한 이견
  | "interpretation" // 근본 원인 진단
  | "risks"; // 한쪽만 본 위험

/**
 * 예산 초과 시 무엇을 먼저 묻는가 (17.4절). 앞에 올수록 우선.
 *
 * **이 순서는 추정이며 튜닝 대상이다** — 14절 지표(불일치 1건당 사용자가 뒤집은 비율)가
 * 쌓여야 조정 근거가 생긴다. 코드 여러 곳에 흩어놓지 않고 여기 한 줄로 둔 이유는,
 * 튜닝할 때 고칠 자리가 하나여야 하기 때문이다.
 */
export const DISAGREEMENT_FIELD_RANK: readonly DisagreementField[] = [
  "doneCriteria",
  "targetPaths",
  "requiredTests",
  "interpretation",
  "risks",
];

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

export interface DisagreementReport {
  taskId: string;
  reportId: string;
  proposalIds: string[];
  disagreements: Disagreement[];
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
