import type { ISODateTime } from "./common.js";

export type VerificationKind = "build" | "test" | "lint" | "typecheck" | "diff_review";

/**
 * 작업 지침 4.8절 / CLAUDE.md 원칙 1 — "명령이 없어서 실행하지 않음"과 "통과함"을 구별한다.
 *
 * 설계 문서(state-machine-and-protocol.md 3절)는 원래 pass|fail|skipped 3값이었다.
 * skipped 하나에 "프로젝트에 명령이 없음", "정책상 건너뜀", "타임아웃"이 뭉쳐 있으면
 * 검증 리포트가 통과로 위장할 여지가 생기므로 5값으로 분리했다.
 */
export type VerificationStatus =
  | "PASSED"
  | "FAILED"
  | "NOT_CONFIGURED" // 프로젝트에 이 검증에 해당하는 명령이 없음
  | "SKIPPED_WITH_REASON" // 실행 가능했지만 의도적으로 건너뜀 (사유 필수)
  | "TIMED_OUT";

export interface VerificationCheck {
  kind: VerificationKind;
  /** 실제 실행된 argv (셸 문자열이 아니다). 명령이 없으면 undefined. */
  command?: { program: string; args: string[]; cwd: string };
  status: VerificationStatus;
  summary: string;
  detail?: string;
  /** detail이 커서 artifact로 밀어낸 경우의 참조 경로 */
  detailRef?: string;
  exitCode?: number;
  durationMs?: number;
}

/**
 * baseline(작업 전)과 post(작업 후)를 구분한다 — 변경 전부터 실패하던 것을 이번 변경의
 * 실패로 오인하면 FIX_LOOP가 고칠 수 없는 것을 고치려 든다.
 */
export type VerificationPhase = "baseline" | "post";

export interface VerificationReport {
  taskId: string;
  reportId: string;
  phase: VerificationPhase;
  /** = 이 리포트가 만들어진 시점의 fixLoopRounds */
  attemptNumber: number;
  checks: VerificationCheck[];
  /**
   * baseline 대비 새로 실패한 체크. post 리포트에서만 채워진다.
   * baseline이 없으면(=처음부터 실패 여부를 모름) 빈 배열이 아니라 undefined다.
   */
  newlyFailing?: VerificationKind[];
  /** baseline에서도 실패하던 체크 — 이번 변경의 책임이 아니다. */
  preexistingFailures?: VerificationKind[];
  /**
   * 종합 판정. 실행할 검증이 없었다는 사실을 통과로 위장하지 않는다.
   *
   * # `not_verified`를 둘로 갈랐다
   *
   * 종전 3값에서 `not_verified` 하나가 **성질이 다른 두 상황**을 담고 있었다:
   *
   * - 프로젝트에 돌릴 명령이 아예 없다 → `not_configured`
   * - 돌리려 했는데 돌지 못했다(`SKIPPED_WITH_REASON`) → `could_not_run`
   *
   * 둘째는 실제로 일어난 결함에서 나왔다. Windows에서 `npm`이 `npm.cmd`라 실행에 실패하면
   * 테스트가 `SKIPPED_WITH_REASON`이 되는데(CLAUDE.md 함정 기록), 뭉쳐 있는 동안 제품은
   * 사용자에게 **"이 프로젝트에는 검증 명령이 없습니다. 스크립트를 추가하세요"** 라고 말했다.
   * 그 프로젝트에는 스크립트가 있었다 — 우리가 못 돌린 것이다. 원인을 잘못 짚은 안내는
   * 침묵보다 나쁘다: 사용자가 없는 문제를 고치러 간다.
   *
   * `VerificationStatus`를 3값에서 5값으로 가른 것과 같은 이유이며, 그때 **종합 판정 쪽에는
   * 같은 규율을 주지 않았던 것**을 지금 맞춘다.
   */
  overall: "pass" | "fail" | "not_configured" | "could_not_run";
  createdAt: ISODateTime;
}

// docs/design/state-machine-and-protocol.md 6절 — FIX_LOOP에 실제로 재전달되는 축약본.
// 전체 VerificationReport 대신 실패한 체크만 상세히, 통과한 체크는 요약만 담아 토큰 예산을 아낀다.
export interface VerificationDigest {
  taskId: string;
  reportId: string;
  attemptNumber: number; // = fixLoopRounds
  failingChecks: {
    kind: VerificationKind;
    command?: string;
    exitCode?: number;
    excerpt: string; // head N줄 + tail M줄 (기본 40/40), 중간 생략 표시
    fileReferences: { path: string; line?: number }[];
  }[];
  passingChecksSummary: string;
  /** baseline에서도 실패하던 항목 — 모델이 이걸 고치려 시도하지 않도록 명시적으로 알린다. */
  preexistingFailuresSummary?: string;
}

export interface WorkspaceDelta {
  baseSnapshotId: string;
  changedFiles: { path: string; diff: string }[]; // unified diff, base snapshot 대비
  createdAt: ISODateTime;
}
