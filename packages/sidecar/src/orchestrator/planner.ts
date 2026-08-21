import type { ExecutionPlan, PlanStep, ToolRequest, ToolRequester } from "@tomverse/protocol";
import { assertRelativeWorkspacePath } from "@tomverse/protocol";

/**
 * 모델 산출물(patch + plan) → `ExecutionPlan`.
 *
 * 이 변환이 신뢰 경계에서 중요한 지점이다: **LLM이 낸 patch는 신뢰하지 않는 외부 입력**이므로
 * 여기서 도구 요청으로 바꿀 때 (a) 대상 경로를 patch 본문에서 추측하지 않고 명시하며
 * (b) 경로 형태를 1차 검증한다. 최종 판단은 Rust Policy Gate가 한다.
 */

export interface PlanInput {
  taskId: string;
  patch: string;
  plan: PlanStep[];
  requestedBy: ToolRequester;
  /** 이번이 몇 번째 계획인지 (fix loop에서 증가) — planId를 안정적으로 만든다 */
  attempt: number;
}

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}

/**
 * unified diff를 파일별로 쪼갠다.
 *
 * 왜 파일별로 쪼개는가: `apply_patch` ToolRequest 하나가 파일 하나를 대상으로 해야
 * (a) Policy Gate가 경로별로 판단할 수 있고 (b) `FileMutationRecord`가 파일별로 남아
 * 롤백이 정확해지고 (c) 승인 모달이 "어떤 파일이 바뀌는가"를 보여줄 수 있다.
 */
export function splitDiffByFile(patch: string): { path: string; patch: string }[] {
  const lines = patch.split("\n");
  const chunks: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    // 새 파일 섹션의 시작. `diff --git`이 없는 diff도 흔하므로 `+++`를 기준으로 잡는다.
    if (line.startsWith("--- ")) {
      const plusLine = lines[i + 1];
      if (plusLine && plusLine.startsWith("+++ ")) {
        const path = parseDiffPath(plusLine) ?? parseDiffPath(line);
        if (path) {
          current = { path, lines: [] };
          chunks.push(current);
          i += 1; // `+++` 줄까지 소비
          continue;
        }
      }
    }

    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode")) {
      // 헤더 줄은 hunk 적용에 필요하지 않다 (Rust의 apply_unified_diff가 무시한다).
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else if (line.startsWith("@@")) {
      // `---`/`+++` 헤더 없이 hunk만 온 patch. 대상 파일을 알 수 없으므로 여기서 실패한다 —
      // 추측해서 엉뚱한 파일에 적용하는 것보다 낫다.
      throw new PlanningError(
        "patch에 파일 헤더(`--- a/path` / `+++ b/path`)가 없어 대상 파일을 특정할 수 없습니다."
      );
    }
  }

  return chunks
    .map((chunk) => ({ path: chunk.path, patch: chunk.lines.join("\n").replace(/\n+$/, "\n") }))
    .filter((chunk) => chunk.patch.includes("@@"));
}

function parseDiffPath(line: string): string | null {
  const raw = line.slice(4).trim();
  if (raw === "/dev/null") return null;
  // `a/src/app.ts` 또는 `b/src/app.ts`에서 접두사를 벗긴다. 탭 뒤의 타임스탬프도 버린다.
  const withoutTimestamp = raw.split("\t")[0] as string;
  const stripped = withoutTimestamp.replace(/^[ab]\//, "");
  return stripped.length > 0 ? stripped : null;
}

export interface CommitPlanInput {
  taskId: string;
  /** 이 태스크가 실제로 바꾼 워크스페이스 상대 경로. **계획이 아니라 성공한 실행에서 온다.** */
  changedPaths: readonly string[];
  message: string;
  requestedBy: ToolRequester;
}

/**
 * 검증 통과 후의 커밋 계획 — state-machine-and-protocol.md 12절 "Git commit 오케스트레이터 통합".
 *
 * # `git add -A`를 쓰지 않는다
 *
 * 사용자에게는 이 태스크와 무관한 미커밋 변경이 있을 수 있다. `-A`는 그걸 전부 우리 커밋에
 * 쓸어담는데, 그건 사용자가 승인 모달에서 본 것과 **다른 일**이다. 승인 화면에 보이는 argv가
 * 실제 실행되는 것과 100% 일치한다는 보장(CLAUDE.md 원칙 6)은 경로를 명시할 때만 성립한다.
 *
 * `--`로 경로 목록을 끊는 이유: `-`로 시작하는 파일명이 옵션으로 해석되지 않게 한다.
 * 셸을 거치지 않으므로 인용은 필요 없지만, 옵션/경로 경계는 git 자체의 파싱 문제라 남는다.
 *
 * # 두 단계를 한 요청으로 합치지 않는다
 *
 * `git commit -a`나 `git add ... && git commit ...` 같은 형태를 쓰지 않는다. 전자는 위에서 말한
 * 이유로 범위가 넓고, 후자는 셸 문자열이라 argv 계약이 깨진다. 두 개의 `run_command`로 나누면
 * Policy Gate가 각각을 독립적으로 판정하고, 승인 모달도 각각을 보여준다.
 */
export function buildCommitPlan(input: CommitPlanInput): ExecutionPlan {
  if (input.changedPaths.length === 0) {
    throw new PlanningError("변경된 파일이 없어 커밋할 것이 없습니다.");
  }
  if (input.message.trim().length === 0) {
    throw new PlanningError("커밋 메시지가 비어 있습니다.");
  }

  const paths = input.changedPaths.map((path, index) =>
    assertRelativeWorkspacePath(path, `commit.changedPaths[${index}]`)
  );
  const createdAt = new Date().toISOString();

  return {
    taskId: input.taskId,
    planId: `${input.taskId}-commit`,
    toolRequests: [
      {
        requestId: `${input.taskId}-commit-add`,
        taskId: input.taskId,
        tool: "run_command",
        args: { program: "git", args: ["add", "--", ...paths], cwd: "." },
        requestedBy: input.requestedBy,
        riskTier: "conditional",
        createdAt,
      },
      {
        requestId: `${input.taskId}-commit-commit`,
        taskId: input.taskId,
        tool: "run_command",
        args: { program: "git", args: ["commit", "-m", input.message], cwd: "." },
        requestedBy: input.requestedBy,
        // git commit은 Rust가 별도 게이트를 하나 더 통과시킨다. Node의 분류는 그 사실을
        // 미리 반영해 두지만, **최종 판정은 언제나 Rust다.**
        riskTier: "user_approval",
        createdAt,
      },
    ],
    approvalRequired: true,
  };
}

/**
 * 커밋 메시지. **검증된 것 이상을 말하지 않는다.**
 *
 * 요약에 "테스트 통과"를 적을 수 있는 것은 `VerificationReport.overall === "pass"`일 때뿐이고,
 * 이 함수는 그 경우에만 호출된다. 메시지에 모델 이름을 넣지 않는 이유: 커밋 로그는 저장소에
 * 영구히 남는 기록이고, 어떤 모델이 썼는지는 그 시점의 라우팅 결정일 뿐이라 재현되지 않는다.
 * 그 정보가 필요하면 `task_events`에 있다.
 */
export function buildCommitMessage(input: {
  userMessage: string;
  changedPaths: readonly string[];
  verifiedChecks: readonly string[];
}): string {
  // 첫 줄은 50~72자 관례를 따른다. 사용자의 요청문을 그대로 쓰되 줄바꿈을 없앤다 —
  // 여러 줄이 첫 줄에 들어가면 git log --oneline이 읽을 수 없게 된다.
  const subject = truncate(input.userMessage.replace(/\s+/g, " ").trim(), 72);
  const body = [
    "",
    `변경한 파일 (${input.changedPaths.length}개):`,
    ...input.changedPaths.map((p) => `- ${p}`),
    "",
    input.verifiedChecks.length > 0
      ? `검증 통과: ${input.verifiedChecks.join(", ")}`
      : "검증: 실행된 체크 없음",
  ];
  return [subject, ...body].join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function buildExecutionPlan(input: PlanInput): ExecutionPlan {
  const files = splitDiffByFile(input.patch);
  if (files.length === 0) {
    throw new PlanningError("patch에 적용할 hunk가 없습니다 — 변경 없이 완료로 처리하지 않습니다.");
  }

  const toolRequests: ToolRequest[] = files.map((file, index) => {
    // 경로 형태 1차 검증. Rust가 canonicalize로 최종 판단하지만, 여기서 걸러야
    // 이벤트 로그에 명백히 잘못된 요청이 쌓이지 않는다.
    const path = assertRelativeWorkspacePath(file.path, `patch.files[${index}].path`);
    return {
      requestId: `${input.taskId}-plan${input.attempt}-apply-${index + 1}`,
      taskId: input.taskId,
      tool: "apply_patch",
      args: { path, patch: file.patch },
      requestedBy: input.requestedBy,
      riskTier: "conditional",
      createdAt: new Date().toISOString(),
    };
  });

  // `delete_file`을 요청하는 PlanStep이 있으면 반영한다. patch로는 파일 삭제를 표현하기
  // 어렵고(`+++ /dev/null`), 삭제는 항상 승인이 필요한 별개의 위험 등급이므로 명시적으로 다룬다.
  for (const [index, step] of input.plan.entries()) {
    if (step.toolHint !== "delete_file") continue;
    for (const target of step.targetPaths ?? []) {
      const path = assertRelativeWorkspacePath(target, `plan[${index}].targetPaths`);
      toolRequests.push({
        requestId: `${input.taskId}-plan${input.attempt}-delete-${toolRequests.length + 1}`,
        taskId: input.taskId,
        tool: "delete_file",
        args: { path },
        requestedBy: input.requestedBy,
        riskTier: "user_approval",
        createdAt: new Date().toISOString(),
      });
    }
  }

  return {
    taskId: input.taskId,
    planId: `${input.taskId}-plan${input.attempt}`,
    toolRequests,
    // Node의 예상값이다. 실제 승인 필요 여부는 Rust Policy Gate가 결정한다.
    approvalRequired: toolRequests.some((r) => r.riskTier !== "auto"),
  };
}
