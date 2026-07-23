import type { ISODateTime } from "./common.js";

export interface VerificationCheck {
  kind: "build" | "test" | "lint" | "typecheck" | "diff_review";
  command?: string;
  status: "pass" | "fail" | "skipped";
  summary: string;
  detail?: string;
}

export interface VerificationReport {
  taskId: string;
  reportId: string;
  checks: VerificationCheck[];
  overall: "pass" | "fail";
  createdAt: ISODateTime;
}

// docs/design/state-machine-and-protocol.md 6절 — FIX_LOOP에 실제로 재전달되는 축약본.
// 전체 VerificationReport 대신 실패한 체크만 상세히, 통과한 체크는 요약만 담아 토큰 예산을 아낀다.
export interface VerificationDigest {
  taskId: string;
  reportId: string;
  attemptNumber: number; // = fixLoopRounds
  failingChecks: {
    kind: VerificationCheck["kind"];
    command?: string;
    exitCode?: number;
    excerpt: string; // head N줄 + tail M줄 (기본 40/40), 중간 생략 표시
    fileReferences: { path: string; line?: number }[];
  }[];
  passingChecksSummary: string;
}

export interface WorkspaceDelta {
  baseSnapshotId: string;
  changedFiles: { path: string; diff: string }[]; // unified diff, base snapshot 대비
  createdAt: ISODateTime;
}
