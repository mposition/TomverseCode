import type { EngineRole, ISODateTime, ModelId, RiskTier } from "./common.js";

export type ToolName =
  | "list_files"
  | "search_text"
  | "read_file"
  | "apply_patch"
  | "create_file"
  | "delete_file"
  /**
   * 파일 하나를 다른 경로로 **옮긴다** (state-machine 44절).
   *
   * # 왜 별도 도구인가
   *
   * `create_file` + `delete_file`로 흉내낼 수는 있다. 그런데 그러려면 모델이 **파일 내용을
   * 통째로 다시 써야 한다** — 2천 줄짜리 파일의 이름을 바꾸는 데 2천 줄을 다시 내보내는 것은
   * 토큰 낭비이자 내용을 망칠 기회다. 그리고 승인이 두 번이고, 그 사이에 파일이 둘이거나
   * 하나도 없는 순간이 생긴다.
   *
   * # 경로가 **둘인 첫 도구**다
   *
   * 다른 파일 도구는 전부 `path` 하나다. 게이트가 두 경로를 **모두** 판정해야 하고, 하나를
   * 빠뜨리면 그게 곧 구멍이다(44.1절).
   */
  | "move_file"
  | "run_command"
  | "git_status"
  | "git_diff"
  | "run_tests"
  /**
   * 등록된 MCP 서버의 도구 하나 (state-machine 23·31절).
   *
   * **닫힌 집합에 문 하나다.** MCP 도구는 서버마다 동적이라 이름을 열면 Policy Gate의
   * exhaustive match가 무너진다. 그래서 칸 하나만 내고, 그 문의 위험도는 "모른다, 그러므로
   * 승인이다"로 고정한다 — 정책으로 낮출 수 없다(23.3절).
   *
   * `git_push`는 여기 없다. 그건 사용자가 부르는 도구이고 모델에게는 경로가 없다(28.2절).
   */
  | "mcp_call";

/**
 * docs/design/multi-engine-routing.md 7절 — 공급자가 아니라 역할로 기록한다.
 * 감사 로그에서 "어떤 역할이 요청했는가"가 "어느 공급자였는가"보다 안정적인 정보다.
 */
export type ToolRequester = { role: EngineRole; modelId: ModelId } | { role: "orchestrator" };

export interface ToolRequest {
  requestId: string;
  taskId: string;
  tool: ToolName;
  args: Record<string, unknown>;
  requestedBy: ToolRequester;
  /**
   * Node가 계산한 1차 분류. Rust Policy Gate는 이 값을 신뢰하지 않고 독립적으로 재평가한다
   * (process-architecture.md 2절: 실행 여부의 최종 게이트는 항상 Rust).
   * 여기 담긴 값은 감사 로그에서 "Node의 판단과 Rust의 판단이 달랐는가"를 보기 위한 기록이다.
   */
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
  /**
   * `cancelled`는 M0.1에서 추가됐다. `timeout`/`denied`와 **반드시 구별해야 한다** —
   * 타임아웃은 재시도 대상이고, denied는 정책 판단이며, cancelled는 사용자의 의사다.
   * 셋을 뭉치면 재시도 정책이 사용자가 멈춘 작업을 다시 실행한다.
   */
  status: "ok" | "error" | "denied" | "timeout" | "cancelled";
  output?: unknown;
  error?: string;
  durationMs: number;
  completedAt: ISODateTime;
  /**
   * `status === "denied"`일 때 **누가 막았는가** (product-strategy 8.2절 Autopilot).
   *
   * 사유 문장으로 구별하게 두지 않는 이유: 소비자가 한국어 산문을 파싱하게 되고, 문구를
   * 다듬는 순간 분기가 조용히 바뀐다.
   *
   * 특히 `user`와 `unattended`는 **다음에 할 일이 다르다**: 전자는 사용자가 그 요청을
   * 원하지 않은 것이고, 후자는 무인 실행이라 물을 사람이 없었을 뿐이라 사람이 붙으면
   * 그대로 진행된다. 뭉개면 최종 보고가 "사용자가 거부했다"고 거짓말한다.
   */
  denialKind?: "policy" | "user" | "unattended";
  /**
   * `status === "error"`일 때 **왜 실패했는가** — 우리가 아는 만큼만 (state-machine 65절).
   *
   * `denialKind`와 같은 이유로 값이다: OS의 오류 문장은 **로케일에 따라 번역되므로**
   * 그것을 파싱하게 만들면 한국어 Windows에서만 분기가 조용히 사라진다.
   *
   * 없으면 그 실패에 대해 **더 말할 것이 없다**는 뜻이다 — "문제가 없다"가 아니다.
   */
  fileFailure?: {
    kind: "locked" | "path_too_long" | "permission_denied";
    /** 무슨 일이 일어났는가. */
    fact: string;
    /** 사람이 해 볼 수 있는 일. **우리가 모르는 것은 모른다고 적혀 있다.** */
    tryThis: string;
    /**
     * 기다렸다 다시 하면 달라질 수 있는가.
     *
     * **재시도 상한을 늘리는 값이 아니다**(원칙 5). `false`일 때 상한을 기다리지 않고 일찍
     * 끝내기 위한 값이며, 좁히는 방향으로만 쓴다.
     */
    retryable: boolean;
  };
}

export type PolicyRiskLevel = "none" | "low" | "medium" | "high" | "prohibited";

export interface PolicyDecision {
  requestId: string;
  decision: "auto_approve" | "require_user_approval" | "deny";
  /** 사람이 읽을 수 있는 위험도 — UI 승인 모달의 강조 수준을 정한다. */
  riskLevel: PolicyRiskLevel;
  matchedRule: string;
  reason: string;
  /** decision === "require_user_approval"과 동치. UI가 파생 계산하지 않도록 명시한다. */
  requiresUserApproval: boolean;
  /**
   * 정규화된 대상: 파일 도구면 canonicalize된 workspace 상대경로, run_command면
   * "program arg arg (cwd)". Rust가 실제로 무엇에 대해 판단했는지를 드러낸다 —
   * 승인 모달에 표시되는 값과 실행되는 값이 같다는 보장의 근거.
   */
  normalizedTarget: string;
  /**
   * 이 거부가 **요청의 모양** 때문인가 (state-machine 41.4절).
   *
   * "그건 하면 안 된다"(워크스페이스 밖 쓰기)와 "그렇게 **요청하면** 안 된다"(argv에 든 `&&`)는
   * 다른 사실이다. 뭉개면 최종 보고가 "정책이 거부했습니다"가 되고, 사용자는 정책 설정을 열어
   * 고칠 곳을 찾다가 아무것도 찾지 못한다 — 고칠 것은 정책이 아니라 모델이 요청한 모양이다.
   *
   * **Rust가 정한다.** 규칙 이름으로 TS가 다시 판정하면 두 곳이 갈린다(24.3절의 교훈).
   */
  redraftable?: boolean;
  decidedAt: ISODateTime;
}

/**
 * docs/design/state-machine-and-protocol.md 5절 — run_command는 셸 문자열이 아니라
 * argv 배열만 받는다 (셸 메타문자 인젝션을 인터페이스 수준에서 차단).
 *
 * `program`은 문서 5절의 `executable`과 같은 뜻이다. 작업 지침 3.2절이 program/args/cwd를,
 * 설계 문서가 executable을 쓰므로 경계에서 두 이름 모두 수용하되(validate.ts의
 * normalizeRunCommandArgs) 정규화된 형태는 `program`이다.
 */
export interface RunCommandArgs {
  program: string;
  args: string[];
  /** workspace root 기준 상대경로. ".." 세그먼트 금지, 절대경로는 workspace 내부만 허용. */
  cwd: string;
  /**
   * shell 실행은 지원하지 않는다. 이 필드가 존재하고 false가 아니면 Policy Gate가 거부한다 —
   * 타입으로만 막는 것으로는 부족하다(LLM 출력은 타입을 존중하지 않는다).
   */
  shell?: false;
  timeoutMs?: number;
}

export interface CommandRule {
  /** 문서 5.1절의 executable. basename 비교. */
  program: string;
  /** 위치 기반 glob. "*" = 인자 1개, "**" = 나머지 전부 (마지막 세그먼트에만 허용) */
  argPattern?: string[];
  cwdMustBeWorkspaceRoot?: boolean;
  effect: "auto" | "conditional";
}

export interface CommandPolicy {
  /** allow보다 항상 우선 평가. 매치 시 riskTier = "blocked" (override 불가) */
  deny: Omit<CommandRule, "effect">[];
  allow: CommandRule[];
}

/**
 * docs/design/ui-wireframes.md 3.3절 — 승인 모달이 렌더링하는 것.
 * Rust가 만들고 UI로 직접 전달한다(Node를 거치지 않는다 — process-architecture.md 4절).
 */
export interface ApprovalRequestItem {
  requestId: string;
  tool: ToolName;
  riskLevel: PolicyRiskLevel;
  reason: string;
  /** run_command일 때만 채워지며, 실제 실행되는 argv와 정확히 같다. */
  command?: { program: string; args: string[]; cwd: string };
  /** 파일 도구일 때 대상 경로(workspace 상대) */
  path?: string;
  /** apply_patch/create_file의 변경 미리보기 (크면 잘림) */
  preview?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  /**
   * 이 명령이 실행될 워크스페이스 루트 (Policy Gate가 제한하는 그 루트).
   *
   * **같은 argv라도 대상 저장소가 다르면 다른 동작이다.** 원칙 6의 "보인 것과 실행되는 것이
   * 같다"는 워크스페이스까지 보여야 완성되고, 이 값은 표시용만이 아니라 **응답이 활성
   * 워크스페이스의 것인지 검사하는 기준**이기도 하다(process-architecture.md 11절).
   */
  workspaceRoot: string;
  items: ApprovalRequestItem[];
  createdAt: ISODateTime;
}

export interface ApprovalResponse {
  approvalId: string;
  granted: boolean;
  /** 거부 사유(선택) — 이벤트 로그에 남는다. */
  note?: string;
  respondedAt: ISODateTime;
}

// docs/design/state-machine-and-protocol.md 10절 — 롤백 UX가 사용하는 파일 변경 기록
export interface FileMutationRecord {
  requestId: string;
  taskId: string;
  /** workspace 상대경로 */
  path: string;
  preImage: { existed: boolean; contentRef?: string; sha256?: string };
  postImage: { existed: boolean; contentRef?: string; sha256?: string };
}
