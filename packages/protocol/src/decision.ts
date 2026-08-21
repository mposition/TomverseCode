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
