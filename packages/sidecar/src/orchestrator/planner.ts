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
