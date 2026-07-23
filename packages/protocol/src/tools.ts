import type { ISODateTime, RiskTier } from "./common.js";

export interface ToolRequest {
  requestId: string;
  taskId: string;
  tool:
    | "list_files"
    | "search_text"
    | "read_file"
    | "apply_patch"
    | "create_file"
    | "delete_file"
    | "run_command"
    | "git_status"
    | "git_diff"
    | "run_tests";
  args: Record<string, unknown>;
  requestedBy: "openai" | "claude" | "orchestrator";
  riskTier: RiskTier;
  createdAt: ISODateTime;
}

export interface ExecutionPlan {
  taskId: string;
  planId: string;
  toolRequests: ToolRequest[];
  approvalRequired: boolean;
}

export interface ToolResult {
  requestId: string;
  status: "ok" | "error" | "denied" | "timeout";
  output?: unknown;
  error?: string;
  durationMs: number;
  completedAt: ISODateTime;
}

export interface PolicyDecision {
  requestId: string;
  decision: "auto_approve" | "require_user_approval" | "deny";
  matchedRule: string;
  reason: string;
}

// docs/design/state-machine-and-protocol.md 5절 — run_command는 셸 문자열이 아니라
// argv 배열만 받는다 (셸 메타문자 인젝션을 인터페이스 수준에서 차단).
export interface RunCommandArgs {
  executable: string;
  args: string[];
  cwd: string;
  shell?: false;
}

// docs/design/state-machine-and-protocol.md 10절 — 롤백 UX가 사용하는 파일 변경 기록
export interface FileMutationRecord {
  requestId: string;
  path: string;
  preImage: { existed: boolean; contentRef?: string };
  postImage: { existed: boolean; contentRef?: string };
}
