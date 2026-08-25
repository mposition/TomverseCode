import type { ExecutionPlan, FileMove, PlanStep, ToolRequest, ToolRequester } from "@tomverse/protocol";
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
  /** 이 초안이 옮기려는 파일들 (state-machine 44절). */
  moves?: FileMove[];
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
      {
        // 만든 커밋의 sha를 확인한다. 읽기 전용이라 자동 승인이다.
        //
        // 왜 필요한가: 이게 없으면 나중에 "이 태스크가 만든 커밋"을 특정할 수 없고, 그러면
        // 커밋 되돌리기(`git revert <sha>`)를 제안할 수조차 없다. 시각이나 메시지로 추측하는
        // 방법은 있지만 추측으로 저장소 이력을 건드리지 않는다.
        requestId: `${input.taskId}-commit-sha`,
        taskId: input.taskId,
        tool: "run_command",
        args: { program: "git", args: ["rev-parse", "HEAD"], cwd: "." },
        requestedBy: input.requestedBy,
        riskTier: "auto",
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
 *
 * # 재시도 흔적을 본문에 남기는 이유 — 19.6절 "커밋 단위"
 *
 * 태스크 하나가 커밋 하나이므로 **fix loop의 중간 시도는 git 이력에 남지 않는다.** 그건
 * 의도된 것이다(중간 시도는 검증에 **실패한** 상태이고, 그걸 커밋하면 "이 저장소의 커밋은
 * 검증을 통과했다"는 성질이 깨진다). 다만 "무엇을 시도했는지 잃는다"는 걱정은 남는데,
 * 실제로는 잃는 것이 아니라 **git이 아닌 곳에 있다** — `task_events`와 검증 출력 artifact.
 *
 * 그 주장이 성립하려면 커밋에서 그곳으로 갈 수 있어야 한다. 그래서 두 가지를 남긴다:
 * 몇 번 만에 통과했는지(누구나 읽을 수 있는 본문)와 태스크 id(trailer).
 */
export function buildCommitMessage(input: {
  userMessage: string;
  changedPaths: readonly string[];
  verifiedChecks: readonly string[];
  /** 이 태스크가 만든 기록을 찾아갈 열쇠. trailer로 남긴다 (아래 주석). */
  taskId?: string;
  /** fix loop를 돈 횟수. 0이면 첫 시도에 통과했다는 뜻이라 아무것도 적지 않는다. */
  fixLoopRounds?: number;
  /** 도중에 실패했던 체크 종류. 중복은 부른 쪽이 아니라 여기서 지운다. */
  failedChecks?: readonly string[];
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

  const rounds = input.fixLoopRounds ?? 0;
  if (rounds > 0) {
    // **"몇 번 만에"가 없으면 한 번에 통과한 것과 구별되지 않는다.** 커밋이 남기는 것은
    // 최종 상태뿐이라, 이 한 줄이 없으면 세 번 고쳐서 통과한 변경과 처음부터 맞았던 변경이
    // 이력에서 같아 보인다. 그 둘은 나중에 이 커밋을 의심할 이유가 서로 다르다.
    const failed = [...new Set(input.failedChecks ?? [])].filter((c) => c.length > 0);
    body.push(failed.length > 0 ? `재시도: ${rounds}회 (도중 실패: ${failed.join(", ")})` : `재시도: ${rounds}회`);
  }

  if (input.taskId && input.taskId.trim().length > 0) {
    // **trailer로 두는 이유**: 이 id는 이 기계의 로컬 기록(`state.db`)을 가리키는 열쇠라
    // 저장소를 받은 다른 사람에게는 아무 뜻이 없다. 본문 산문으로 적으면 읽는 사람이
    // 따라갈 수 있는 것으로 오해하지만, trailer는 관례상 도구용이라 무시해도 되는 자리다.
    body.push("", `Tomverse-Task: ${input.taskId.trim()}`);
  }

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

  // **이동을 patch보다 먼저 낸다**(44절). 순서가 뒤집히면 새 경로에 대한 patch가 아직 그
  // 자리에 없는 파일에 적용된다 — 모델은 옮긴 뒤를 기준으로 쓰기 때문이다.
  //
  // 이동이 patch와 같은 파일을 건드리는 경우는 여기서 판정하지 않는다: 그건 `from`이 사라진
  // 뒤 `to`에 대한 hunk가 오는 정상 흐름이고, 어긋나면 patch 적용이 실패한다(그리고 그
  // 실패는 fix loop가 받는다).
  const moves: ToolRequest[] = (input.moves ?? []).map((move, index) => ({
    requestId: `${input.taskId}-plan${input.attempt}-move-${index + 1}`,
    taskId: input.taskId,
    tool: "move_file" as const,
    args: {
      // 두 경로 모두 형태를 검사한다 — 게이트가 최종 판정하지만, 명백히 잘못된 요청이
      // 이벤트 로그에 쌓이지 않게 한다(위 `apply_patch`와 같은 이유).
      from: assertRelativeWorkspacePath(move.from, `moves[${index}].from`),
      to: assertRelativeWorkspacePath(move.to, `moves[${index}].to`),
    },
    requestedBy: input.requestedBy,
    riskTier: "user_approval" as const,
    createdAt: new Date().toISOString(),
  }));
  toolRequests.unshift(...moves);

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
