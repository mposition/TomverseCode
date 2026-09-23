import type { ModelGrade } from "./registry.js";

/**
 * 사용자 게이트 둘의 카드와 선택지 — state-machine 72.4·72.8·72.10.2절.
 *
 * # 왜 도구 승인과 다른 타입인가
 *
 * `ToolRequest`의 승인은 **600초 뒤 거부**다(`approvals.rs`). 여기에는 **타임아웃이 없다** —
 * 무응답은 거부가 아니라 대기이고, 그 사실이 이 타입들에 "시간 초과" 값이 없다는 것으로
 * 표현된다(72.12절). 두 승인을 한 타입으로 합치면 그 구별이 사라진다.
 *
 * # 이 파일이 Rust와 **같은 모양**이어야 한다
 *
 * 정본은 `apps/desktop/src-tauri/core/src/types.rs`다 — 왕복 전체를 Rust가 소유하고
 * (`PLAN_APPROVED`·`USER_VERIFICATION_APPROVED`가 `NODE_MAY_NOT_EMIT`이므로 Node에는 기록
 * 경로가 없다), Node는 "이 카드로 물어 달라"고만 말한다. 여기 타입은 그 요청을 만드는 쪽과
 * 화면이 공유하는 사본이며, 갈리면 `packages/sidecar/test/conformance.test.ts`가 잡는다.
 */

/**
 * 런타임 에스컬레이션 **봉투** — 72.10.2절.
 *
 * **제안하는 것은 제품, 정하는 것은 사용자다.** 카드는 계획에서 유도한 값을 제안하고
 * 사용자가 확인하거나 고친다. 기본 제안값과 **천장**은 둘 다 `TaskPolicy`에 있다
 * (`limits.escalationCalls`) — 사용자가 정한 값이 유일한 상한이면 원칙 5가 사용자 입력에
 * 의존하게 된다.
 */
export interface EscalationAllowance {
  /** 이 봉투가 허락하는 **호출 수**. `TaskLoopLimits.escalationCalls`가 천장이다. */
  maxCalls: number;
  /** 어느 등급까지 올릴 수 있는가. */
  grade: ModelGrade;
  /**
   * 이 봉투가 쓸 수 있는 금액의 상한.
   *
   * **환산 불가 경로에서는 `null`이다** — 구독에 포함된 배정에는 토큰 단가가 없으므로
   * 0으로 합산하면 카드가 "이만큼만 듭니다"라고 거짓을 말한다(72.4절).
   */
  budgetUsd: number | null;
}

/**
 * 구현 모델이 **산출물에 실어 보내는 요청** — 72.10.2절.
 *
 * **실행되지 않는다.** `mcpCalls`가 요청이고 실행은 게이트가 정하는 것과 같은 모양이다(31절).
 * 판정은 오케스트레이터가 하고, 봉투를 넘으면 **거절한다** — 중간에 다시 묻지 않는다.
 * 되묻는 자리는 뒤에 있는 검증 체크리스트다(72.8절).
 */
export interface EscalationRequest {
  /** 왜 더 센 모델이 봐야 하는가. 거절돼도 기록에 남는다. */
  reason: string;
  /** 어느 등급을 원하는가. 봉투의 `grade`를 넘으면 거절된다. */
  proposedGrade: ModelGrade;
}

/** 승인 카드가 보여주는 서브태스크 한 줄 — 72.4절. */
export interface PlanApprovalSubtask {
  subtaskId: string;
  intent: string;
  /**
   * **계산이 끝난 최종 등급**이다(72.2.2절).
   *
   * 모델의 `proposedGrade`가 아니라 clamp(`PerformanceProfile`)와 경로 기반 위험 하한선을
   * 지난 값이다 — 그 계산은 규칙이라 모델을 부르지 않는다.
   */
  grade: ModelGrade;
  /** 하한선이 올렸다면 무엇 때문인가. 비어 있으면 걸리지 않았다. */
  riskSegments: string[];
}

/**
 * 계획 승인 카드 — 72.4절이 "한 줄도 적혀 있지 않았다"고 지적한 그 명세다.
 *
 * *"사용자가 비용을 보고 승인한다"*가 이 절과 product-strategy 13.0.2의 뒤집기를 떠받치는
 * 문장인데, 카드가 무엇을 보여주는지 적지 않으면 그 근거는 확인될 수 없다.
 */
export interface PlanApprovalCard {
  /** 승인 대상 그 자체. */
  summary: string;
  steps: string[];
  /** **개수와 각 등급.** 개수만 보여주면 왜 그 금액인지 알 수 없다(72.10절). */
  subtasks: PlanApprovalSubtask[];
  /** 계량 과금분의 **추정** 금액. 실측이 아니라는 것을 화면이 말해야 한다. */
  estimatedCostUsd: number;
  /**
   * **금액으로 환산되지 않는** 배정들.
   *
   * 0으로 합산하지 않는다 — 그래서 카드의 금액은 하나가 아니라 셋이다(계량 과금분 추정 /
   * 포함된 용량분 / 봉투 상한).
   */
  unpricedAssignments: string[];
  /**
   * 추정을 틀리게 만드는 것들 — 서브태스크의 실제 길이, fix loop 횟수, 에스컬레이션 발생,
   * 그리고 **`EffortLevel`**.
   *
   * effort는 방향만 아는 입력이라 **금액에 곱하지 않는다**(72.4절). 모르는 배수를 지어내
   * 곱하면 카드가 정확해 보이는 만큼 정확히 틀린다.
   */
  estimateCaveats: string[];
  /** 에스컬레이션 봉투 — **같이 승인하는 대상이다**(72.10.2절). */
  escalation: EscalationAllowance;
  /**
   * 배정된 모델과 그 성질.
   *
   * `unmeasured` 계획자, effort를 무시하는 모델, 검토 드롭, *"봉투를 넘는 요청은 거절되며
   * 중간에 늘릴 수 없습니다"* — 비용만 보여주고 대가를 감추면 승인이 반쪽이다.
   */
  notes: string[];
  /**
   * 승인 시점의 워크스페이스 지문 (72.5절).
   *
   * **Rust가 찍고 Rust가 기록한다** — 여기 실리는 것은 Node가 본 값이 아니라 화면이 "무엇에
   * 대한 승인인가"를 말하기 위한 사본이다. 없으면 `null`이다.
   */
  workspaceFingerprint: string | null;
}

/**
 * 계획 승인 카드의 **선택지 넷** — 72.4절.
 *
 * **기본값이 없다**(사용자가 매번 고른다). `granted: boolean`으로 뭉치지 않는 이유가
 * 이 넷이다 — 뭉치면 화면이 "승인 + 검토 생략"과 "승인 + 독립 검토"를 구별해 보낼 수 없다.
 */
export type PlanApprovalChoice =
  /** 승인 + 독립 검토 → `PLAN_REVIEWING` */
  | "approve_with_review"
  /** 승인 + 검토 생략 → `IMPLEMENTING`. **생략 사실이 기록되고 체크리스트에 적힌다.** */
  | "approve_skip_review"
  /** 수정 요청 → `OUTLINING` 재진입 (`planRounds` 안에서) */
  | "revise"
  /** 거부 → `REJECTED` */
  | "reject";

/** 검증 체크리스트의 선택지 — 72.8절 귀환 경로 셋 + 승인. */
export type VerificationChoice =
  /** 승인 → (커밋) → `COMPLETED` */
  | "approve"
  /** 지적한 항목으로 `FIX_LOOP` 재진입 (**`fixLoopRounds` 안에서**) */
  | "refix"
  /** 계획으로 되돌아간다 (**`planRounds` 안에서**). 승인이 무효화된다. */
  | "replan"
  /** 변경을 되돌리고 종료 → **`REJECTED`**. 되돌릴 파일이 **있다**(10절이 낡은 이유). */
  | "revert_and_stop";

/**
 * 체크리스트 항목의 **근거 등급** — 72.8절.
 *
 * `flagged_by_review`는 **확인이 아니라 경고**이고, C가 "괜찮아 보입니다"라고 한 것은
 * `verified`가 아니라 `unverified`로 남는다 — 17.9절이 정한 확인의 정의는 **검증 출력에
 * 나타났는가**이고 모델 의견은 거기 해당하지 않는다.
 */
export type ChecklistGrade = "verified" | "flagged_by_review" | "unverified";

export interface ChecklistItem {
  text: string;
  grade: ChecklistGrade;
  /** `AcceptanceCriterion.source`. 사용자가 자기가 정한 것과 모델이 추측한 것을 구별해야 한다. */
  source: string;
}

/**
 * 검증 체크리스트 — 72.8절. **17.9절이 이미 계산하던 여집합의 화면**이다.
 *
 * 새 판정 로직이 아니라 이미 계산되던 것을 사람에게 넘기는 것이다.
 */
export interface VerificationChecklistCard {
  items: ChecklistItem[];
  /**
   * C가 없었으면 **그 사실도 적는다** — "이 목록은 3자 검토 없이 만들어졌습니다".
   * 짧아진 목록을 그냥 보여주면 사용자는 확인할 것이 적다고 읽는다.
   */
  notes: string[];
  /**
   * 계획에 없던 파일들 — **판정하지 않고 보여준다**(72.7절).
   *
   * 이 절반은 **모델 없이** 낸다(`filesToChange`와 실제 diff는 둘 다 우리가 갖고 있다).
   * 그래서 **C를 드롭한 사용자에게도 동작한다.**
   */
  unplannedPaths: string[];
}

/** Node가 Rust에게 **사용자에게 물어 달라고** 요청하는 것. `gate.userDecision`의 params다. */
export type UserGateRequest =
  | { gate: "plan"; taskId: string; card: PlanApprovalCard }
  | { gate: "verification"; taskId: string; card: VerificationChecklistCard };

/**
 * 사용자의 답. **무응답은 거부가 아니라 대기다**(72.12절) — 이 합집합에 "시간 초과"가 없는
 * 것이 그 결정의 구조적 표현이다.
 */
export type UserGateResponse =
  | { outcome: "plan"; choice: PlanApprovalChoice }
  | {
      outcome: "verification";
      choice: VerificationChoice;
      /**
       * `revert_and_stop`을 골랐을 때 **실제로 되돌린 결과** — 72.8절 귀환 경로 3.
       *
       * 이 선택지의 이름이 약속하는 것이 되돌리기이고, Rust가 게이트 왕복 안에서 수행한다
       * (파일을 되돌리는 것은 신뢰 경계의 일이다 — 원칙 2). **되돌리지 못한 파일이 있으면
       * 그 사실이 여기 실려 온다**: 삼키면 최종 보고가 "되돌렸습니다"라고 거짓을 말한다.
       *
       * 다른 선택지에서는 `null`이다.
       */
      rollback?: { restored?: unknown[]; failed?: unknown[]; ok?: boolean; reason?: string } | null;
    }
  /**
   * **물을 사람이 없다** — 무인 실행(Autopilot)이 이 게이트에 닿았다.
   *
   * `reject`로 뭉개지 않는다. 뭉개면 최종 보고가 "사용자가 거부했다"고 거짓말하는데 사용자는
   * 아무것도 거부한 적이 없다. 그 결과 **Autopilot의 실질 범위가 `simple` 태스크로 좁아진다**:
   * 부작용이 아니라 이 흐름의 정의에서 따라 나오는 것이다.
   */
  | { outcome: "unattended" }
  /** UI에 전달할 수 없었다. **오류이지 사용자의 판정이 아니다.** */
  | { outcome: "unavailable"; reason: string };
