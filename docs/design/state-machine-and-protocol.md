# 크로스 검증 상태 머신 & 공통 프로토콜 스키마

status: draft
관련: [../architecture-overview.md](./architecture-overview.md) (아직 없음 — 전체 개요 문서화 시 링크)

## 1. 설계 목표

- 하나의 TaskRequest가 시작부터 끝까지 거치는 **단일 상태 머신**을 정의한다. OpenAI/Claude 각각의 내부 루프가 아니라, 오케스트레이터가 소유하는 전역 상태다.
- 모든 루프(재질문, 수정 요청, 검증 실패 후 재수정)는 **상한이 있는 카운터**로 제어한다. 상한 없는 루프는 허용하지 않는다.
- LLM이 반환하는 값과 오케스트레이터/도구 런타임이 다루는 값을 분리한다. Rust 코어는 `ToolRequest`/`ToolResult`/`PolicyDecision`처럼 **정책 판단에 필요한 타입만 강하게 타이핑**하고, `DraftProposal`/`ReviewDecision`처럼 UI 렌더링용 콘텐츠는 opaque JSON으로 통과시킨다. 이렇게 하면 OpenAI/Anthropic 응답 포맷이 바뀌어도 Rust 코어를 건드릴 일이 줄어든다.
- 스키마의 단일 소스는 TypeScript(Node sidecar가 이 타입들을 직접 다루므로)로 두고, Rust 쪽은 필요한 필드만 `serde`로 부분 역직렬화한다. 향후 스키마가 안정되면 JSON Schema로 승격해 codegen(`typify` 등)을 고려한다.

## 2. 상태 머신

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> SNAPSHOTTING
    SNAPSHOTTING --> TRIAGE

    TRIAGE --> DRAFTING: complexityTier = standard
    TRIAGE --> SINGLE_MODEL_FIX: complexityTier = simple

    DRAFTING --> REVIEWING: 대조 결과 blocking 불일치 없음
    DRAFTING --> AWAITING_USER_INPUT: blocking 불일치 (17.1절, clarificationRounds++)

    SINGLE_MODEL_FIX --> PLANNING: ACCEPT
    SINGLE_MODEL_FIX --> REJECTED: REJECT
    SINGLE_MODEL_FIX --> AWAITING_USER_INPUT: NEED_USER_INPUT (clarificationRounds++, tier를 standard로 승격)

    REVIEWING --> PLANNING: ACCEPT
    REVIEWING --> PLANNING: REVISE (reviseRounds++)
    REVIEWING --> REJECTED: REJECT
    REVIEWING --> AWAITING_USER_INPUT: NEED_USER_INPUT (clarificationRounds++)

    AWAITING_USER_INPUT --> DRAFTING: 사용자 응답 수신 (이후 항상 standard 경로)
    AWAITING_USER_INPUT --> CANCELLED: 사용자 취소

    PLANNING --> AWAITING_APPROVAL: 승인 필요 ToolRequest 존재
    PLANNING --> EXECUTING: 전부 auto_approve
    PLANNING --> DRAFTING: 계획이 확정 기준과 충돌 (17.3절 규칙 1, reviseRounds++)
    PLANNING --> SINGLE_MODEL_FIX: 같은 이유, 단일 모델 경로

    AWAITING_APPROVAL --> EXECUTING: 사용자 승인
    AWAITING_APPROVAL --> CANCELLED: 사용자 거부

    EXECUTING --> EXECUTING: 다음 ToolRequest
    EXECUTING --> VERIFYING: 계획된 ToolRequest 모두 완료
    EXECUTING --> FAILED: 재시도 상한 초과 (toolRetries)

    VERIFYING --> COMPLETED: overall = pass
    VERIFYING --> FIX_LOOP: overall = fail (fixLoopRounds++)

    FIX_LOOP --> PLANNING: fixLoopRounds <= max
    FIX_LOOP --> FAILED: fixLoopRounds > max

    CREATED --> CANCELLING
    TRIAGE --> CANCELLING
    DRAFTING --> CANCELLING
    SINGLE_MODEL_FIX --> CANCELLING
    REVIEWING --> CANCELLING
    PLANNING --> CANCELLING
    EXECUTING --> CANCELLING
    VERIFYING --> CANCELLING

    CANCELLING --> CANCELLED
    CANCELLING --> FAILED

    COMPLETED --> [*]
    FAILED --> [*]
    CANCELLED --> [*]
    REJECTED --> [*]
    INTERRUPTED --> [*]
```

`CANCELLING`(비터미널)과 `INTERRUPTED`(터미널)는 M0.1에서 추가됐다 — 16절 참조. 취소는 순간이 아니라
자식 프로세스가 죽기를 기다리는 **구간**이고, 앱이 비정상 종료된 작업은 완료도 실패도 취소도 아니다.

`TRIAGE`/`SINGLE_MODEL_FIX`는 13절(Phase 0 스파이크 결과 반영)에서 추가된 상태다 — 원래 설계에는 없었고, 스파이크가 "쉬운 태스크에서는 교차검증이 정확도 이득 없이 비용/지연만 늘린다"는 걸 실측으로 보여준 뒤 반영되었다. `SINGLE_MODEL_FIX`의 verdict 처리(REJECT/NEED_USER_INPUT 분기, tier 승격 규칙)는 14.1절에서 마무리했다.

### 2.1 Phase 설명 및 종료 조건

| Phase | 담당 | 진입 조건 | 종료/전이 |
|---|---|---|---|
| `CREATED` | Orchestrator | TaskRequest 수신 | 즉시 SNAPSHOTTING |
| `SNAPSHOTTING` | Context Engine | - | WorkspaceSnapshot 생성 완료 → TRIAGE |
| `TRIAGE` | Orchestrator | WorkspaceSnapshot 완료 | 13.2절 규칙으로 `complexityTier` 결정 → standard면 DRAFTING, simple이면 SINGLE_MODEL_FIX |
| `DRAFTING` | OpenAI Provider | Snapshot + (재질문 시) 사용자 답변 | DraftProposal 수신 → REVIEWING |
| `SINGLE_MODEL_FIX` | Claude Provider | Snapshot (OpenAI 초안 없음) | `SingleModelFixResult.verdict`(REVISE 없이 ACCEPT/NEED_USER_INPUT/REJECT 중 하나)에 따라 PLANNING/AWAITING_USER_INPUT/REJECTED로 분기 |
| `REVIEWING` | Claude Provider | DraftProposal + 동일 Snapshot | ReviewDecision.verdict에 따라 4갈래 분기 |
| `AWAITING_USER_INPUT` | UI | verdict = NEED_USER_INPUT (REVIEWING 또는 SINGLE_MODEL_FIX 양쪽에서 진입 가능) | 사용자 응답 → DRAFTING(항상 standard 경로, 14.1절), 취소 → CANCELLED |
| `PLANNING` | Orchestrator | ACCEPT/REVISE 확정, SINGLE_MODEL_FIX 완료, 또는 FIX_LOOP에서 복귀 | 결과를 ExecutionPlan(ToolRequest[])으로 변환 |
| `AWAITING_APPROVAL` | Policy Gate + UI | ExecutionPlan 내 riskTier != auto | 사용자 승인/거부 |
| `EXECUTING` | Tool Runtime | 승인 완료 | 각 ToolRequest 순차 실행, 전부 완료 시 VERIFYING |
| `VERIFYING` | Verify 서브시스템 | ExecutionPlan 적용 완료 | build/test/lint/diff 결과 종합 |
| `FIX_LOOP` | Claude Provider | VerificationReport.overall = fail | VerificationReport를 Claude에 다시 전달, 수정된 결과 요청 (원래 tier와 무관하게 항상 Claude 단독 호출이므로 tier 재분류 불필요) |
| `CANCELLING` | Orchestrator + Rust | 취소 요청 접수 | 자식 프로세스 트리 종료·남은 단계 건너뛰기 완료 → CANCELLED (정리 중 오류면 FAILED) |
| `COMPLETED` / `FAILED` / `CANCELLED` / `REJECTED` | - | 터미널 상태 | FinalResult 생성, UI에 전달 |
| `INTERRUPTED` | Rust (앱 시작 시) | 앱 재시작 시 `final_status IS NULL`로 발견됨 | 터미널. 자동 재개하지 않고 사용자에게 되돌리기/다시 실행 선택을 준다 (16.1절) |

### 2.2 루프 상한 (기본값, 설정 가능해야 함)

| 카운터 | 어디서 증가 | 기본 상한 | 초과 시 |
|---|---|---|---|
| `clarificationRounds` | NEED_USER_INPUT 진입 시 | 2 | AWAITING_USER_INPUT에서 더 이상 재질문하지 않고, 사용자에게 "모호함을 해소하지 못함"으로 FAILED 전환 |
| `reviseRounds` | REVISE verdict 수신 시 (실행 전 단계) | 2 | 강제로 REJECTED 처리, "OpenAI/Claude가 계획에 합의하지 못함" 사유 기록 |
| `fixLoopRounds` | VERIFYING → fail 판정 시 | 3 | FAILED, 마지막 diff/로그를 사용자에게 제시하고 수동 개입 요청 |
| `toolRetries[requestId]` | ToolResult.status = timeout/transient error | 2 (지수 백오프) | 해당 ToolRequest를 `error`로 확정, EXECUTING 전체를 FAILED로 전이 |

모든 상한 값은 `TaskPolicy` 설정(워크스페이스별 override 가능)에서 읽는다. 하드코딩하지 않는다.

### 2.2 터미널 목록은 경계 양쪽에 하나씩 있다 — 그리고 부탁으로 지켜지고 있었다 (M1)

"어떤 phase가 터미널인가"는 **두 곳**에 적혀 있다: `packages/protocol/src/task.ts`의
`TERMINAL_PHASES`와 `core/src/store.rs`의 `is_terminal_phase()`. 하나로 합칠 수 없는 이유는
구조적이다 — Rust는 TypeScript를 import할 수 없고, 이 판정은 Node가 죽어 있을 때도 Rust가
혼자 내려야 한다(앱 시작 시 `INTERRUPTED` 확정이 정확히 그 경우다).

문제는 그 중복이 **부탁으로만 지켜지고 있었다**는 것이다. Rust 쪽 주석은 "한쪽만 고치면
갈라진다 — 함께 유지할 것"이라고 적어두었을 뿐 대조하는 검사가 없었다.

**갈라지면 무엇이 깨지는가.** Node가 터미널로 보는 phase를 Rust가 아니라고 보면 Rust는 그
태스크를 "아직 진행 중"으로 취급해 앱 재시작 때 `INTERRUPTED`로 확정하려 든다. 반대 방향이면
Node가 계속 돌리려는 태스크를 Rust가 이미 끝난 것으로 보고 이벤트를 거부한다. 둘 다 "정확히
한 번"이라는 terminal 규칙이 겨냥하는 바로 그 상태다.

**부탁이 이미 한 번 어긋나 있었다.** 그 주석은 목록이 `orchestrator/machine.ts`에 있다고
가리켰는데 거기 없다 — 실제 위치는 protocol이다. **손으로 유지하는 포인터는 손으로 유지하는
목록보다 먼저 낡는다**, 그리고 포인터가 낡으면 "함께 유지하라"는 지시는 따를 수 없는 지시가 된다.

`packages/sidecar/test/terminalPhases.test.ts`가 대조한다. **기대 목록을 테스트에 적지 않는
것이 핵심이다** — 적으면 목록이 셋이 되고, 셋이 되면 갈라질 자리도 셋이 된다. TypeScript 쪽은
import로, Rust 쪽은 `matches!` 팔을 소스에서 읽어 가져온다. Rust에서 하나도 못 읽으면 그것도
실패다: 빈 집합끼리는 언제나 같기 때문이다. 주석의 포인터가 실제 위치를 가리키는지도 함께 본다.

## 3. 프로토콜 스키마 (TypeScript, 단일 소스)

Node sidecar와 UI가 공유하는 정식 타입. Rust 코어는 `ToolRequest`, `ToolResult`, `PolicyDecision`, `TaskState`(카운터/phase만)를 제외한 나머지는 `serde_json::Value`로 그대로 통과시킨다.

```typescript
// ---- 공통 ----
type ISODateTime = string;
type Verdict = "ACCEPT" | "REVISE" | "REJECT" | "NEED_USER_INPUT";
type RiskTier = "auto" | "conditional" | "user_approval" | "blocked";

// ---- 1. TaskRequest ----
interface TaskRequest {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  userMessage: string;
  attachments?: { path: string; note?: string }[];
  createdAt: ISODateTime;
}

// ---- 2. WorkspaceSnapshot ----
interface WorkspaceSnapshot {
  snapshotId: string;
  workspaceId: string;
  gitHead: string;
  gitBranch: string;
  gitDirty: boolean;
  gitDiffSummary?: string;
  relevantFiles: {
    path: string;
    reason: "mentioned" | "symbol-match" | "recently-changed" | "dependency";
    content: string;
    truncated: boolean;
  }[];
  projectMeta: {
    languages: string[];
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    agentsMdPresent: boolean;
  };
  tokenBudget: { provider: "openai" | "anthropic"; maxTokens: number }[];
  createdAt: ISODateTime;
}

// ---- 3. DraftProposal (OpenAI 산출물) ----
interface PlanStep {
  stepId: string;
  description: string;
  toolHint?: "apply_patch" | "create_file" | "delete_file" | "run_command" | "run_tests";
  targetPaths?: string[];
}

interface DraftProposal {
  taskId: string;
  proposalId: string;
  interpretation: string;
  relevantFiles: { path: string; reason: string }[];
  plan: PlanStep[];
  patch?: string; // unified diff
  risks: string[];
  requiredTests: string[];
  uncertainties: string[];
  doneCriteria: string[];
  model: string;
  createdAt: ISODateTime;
}

// ---- 4. ReviewDecision (Claude 산출물) ----
interface ReviewDecision {
  taskId: string;
  proposalId: string;
  verdict: Verdict;
  rationale: string;
  revisedPlan?: PlanStep[];
  revisedPatch?: string;
  questionsForUser?: string[]; // verdict = NEED_USER_INPUT
  rejectionReason?: string;    // verdict = REJECT
  model: string;
  createdAt: ISODateTime;
}

// ---- 4b. SingleModelFixResult (SINGLE_MODEL_FIX 산출물, 13.2절 TRIAGE로 진입) ----
// ReviewDecision과 구조는 비슷하지만 리뷰 대상 DraftProposal이 없으므로 별도 타입으로 둔다.
// verdict는 REVISE를 쓰지 않는다 — 검토할 초안이 없으므로 "수정 요청"이라는 개념 자체가 성립하지 않고,
// Claude가 곧바로 최종안(ACCEPT)이거나 모호함(NEED_USER_INPUT)이거나 불가/위험(REJECT) 중 하나로 판정한다.
interface SingleModelFixResult {
  taskId: string;
  verdict: Exclude<Verdict, "REVISE">;
  rationale: string;
  plan?: PlanStep[];           // verdict = ACCEPT
  patch?: string;               // verdict = ACCEPT
  questionsForUser?: string[];  // verdict = NEED_USER_INPUT
  rejectionReason?: string;     // verdict = REJECT
  model: string;
  createdAt: ISODateTime;
}

// ---- 5. ExecutionPlan / ToolRequest (오케스트레이터 소유, Rust가 강타입으로 다룸) ----
interface ToolRequest {
  requestId: string;
  taskId: string;
  tool: "list_files" | "search_text" | "read_file" | "apply_patch"
      | "create_file" | "delete_file" | "run_command"
      | "git_status" | "git_diff" | "run_tests";
  args: Record<string, unknown>;
  requestedBy: "openai" | "claude" | "orchestrator";
  riskTier: RiskTier;
  createdAt: ISODateTime;
}

interface ExecutionPlan {
  taskId: string;
  planId: string;
  toolRequests: ToolRequest[];
  approvalRequired: boolean;
}

interface ToolResult {
  requestId: string;
  status: "ok" | "error" | "denied" | "timeout";
  output?: unknown;
  error?: string;
  durationMs: number;
  completedAt: ISODateTime;
}

interface PolicyDecision {
  requestId: string;
  decision: "auto_approve" | "require_user_approval" | "deny";
  matchedRule: string;
  reason: string;
}

// ---- 6. VerificationReport ----
interface VerificationCheck {
  kind: "build" | "test" | "lint" | "typecheck" | "diff_review";
  command?: string;
  status: "pass" | "fail" | "skipped";
  summary: string;
  detail?: string;
}

interface VerificationReport {
  taskId: string;
  reportId: string;
  checks: VerificationCheck[];
  overall: "pass" | "fail";
  createdAt: ISODateTime;
}

// ---- 7. TaskState (오케스트레이터 내부 상태, append-only 이벤트 로그와 함께 저장) ----
type TaskPhase =
  | "CREATED" | "SNAPSHOTTING" | "TRIAGE" | "DRAFTING" | "SINGLE_MODEL_FIX" | "REVIEWING"
  | "AWAITING_USER_INPUT" | "PLANNING" | "AWAITING_APPROVAL"
  | "EXECUTING" | "VERIFYING" | "FIX_LOOP"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "REJECTED";

type ComplexityTier = "simple" | "standard";

interface TaskState {
  taskId: string;
  phase: TaskPhase;
  complexityTier: ComplexityTier | null; // TRIAGE 완료 전에는 null
  counters: {
    clarificationRounds: number;
    reviseRounds: number;
    fixLoopRounds: number;
    toolRetries: Record<string, number>;
  };
}

// ---- 8. FinalResult ----
type FailureReason =
  | "clarification_exhausted"    // AWAITING_USER_INPUT 재질문 상한 초과
  | "revise_exhausted"           // 실행 전 REVISE 루프 상한 초과
  | "fix_loop_exhausted"         // 검증 실패 후 수정 루프 상한 초과
  | "tool_retry_exhausted"       // 도구 실행 재시도 상한 초과 (7절 toolRetries)
  | "provider_retry_exhausted"   // LLM 호출 인프라 재시도 상한 초과 (9절 providerRetries)
  | "provider_config_error"      // API 키/설정 오류 등 재시도 무의미한 오류
  | "app_restart_interrupted"    // EXECUTING 도중 앱 재시작으로 중단 (10절)
  // 이 태스크의 예산 상한에 도달해 **호출하지 않고** 멈췄다
  // (multi-engine-routing.md 10.6절). provider_config_error와 섞지 않는다 —
  // 저쪽은 고칠 것이 설정에 있고, 이쪽은 사용자가 정한 값에 도달한 정상 동작이다.
  | "budget_exceeded";

interface FinalResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "rejected";
  failureReason?: FailureReason; // status = "failed"일 때만
  summary: string;
  // finalDiff는 제거했다 — 3.2절.
  verificationReport?: VerificationReport;
  auditTrailEventIds: string[];
  // 이 태스크가 공급자 호출에 실제로 쓴 돈. **성공·실패를 가리지 않고 담는다** —
  // 돈은 결과와 무관하게 나갔고, 실패한 태스크야말로 "얼마를 썼나"를 묻게 되는 자리다.
  // state가 "not_enforced"이면 상한 없이 돌았다는 뜻이며 "ok"와 다른 사실이다.
  budget?: TaskBudgetOutcome;
  completedAt: ISODateTime;
}
```

### 3.2 `FinalResult.finalDiff`를 제거했다 (M1)

**소비자가 없었고, 있는 편이 오히려 나빴다.**

이 필드는 sidecar가 적용된 patch들을 이어 붙여 만들었고(`appliedDiffs.join`), 저장소 전체에서
읽는 곳이 **한 군데도 없었다** — 화면도, Rust도, export도, 재현도, 테스트도. 화면이 실제로
그리는 diff는 Rust가 경로별로 들고 있는 `collected_diffs`이며, Tauri 계층이 최종 결과 객체에
`diffs`로 얹어 준다.

없애는 이유가 "안 쓰니까"만은 아니다. **같은 사실의 사본이 둘이고 그중 하나가 신뢰 경계 밖에서
왔다.** 적용된 diff를 만든 것은 Rust의 Tool Runtime인데, 감사 기록에 실리는 사본 하나는 Node를
한 바퀴 돌아 온 것이다. Node가 장악당하면 그 사본은 실제 적용된 것과 다를 수 있고, 그러면
기록을 읽는 사람은 어느 쪽이 정본인지 알 수 없다(원칙 2). `command`/`resolvedCommand`를 **둘 다**
남기는 것과는 다른 경우다 — 그 둘은 서로 다른 사실이고, 이건 같은 사실이다.

크기도 공짜가 아니었다. 모든 patch를 이어 붙인 문자열이 NDJSON **한 줄**에 실려 신뢰 경계를
건너고(3.1절의 32 MiB 상한이 지키는 그 줄이다) 최종 결과 payload에 들어간다.

**되살아나지 않게 검사를 둔다.** 최종 결과 JSON에 diff처럼 생긴 것(`--- a/`, `+++ b/`, `@@ -`)이
나타나면 e2e가 실패한다 — 필드 이름을 검사하면 다른 이름으로 같은 것이 다시 들어올 때 통과하므로,
이름이 아니라 **모양**을 본다.

#### 3.2.1 지우려고 열어보니 그것은 diff가 아니었다

`finalDiff`를 만들던 `extractDiff()`는 **diff를 만든 적이 없다.** Rust는 diff를 돌려주지 않고
이벤트에만 담으므로, 그 함수가 `apply_patch` 결과에서 얻을 수 있는 것은 경로와 크기뿐이었다.
실제 값은 이렇다:

```
# applied to paginate.js (173 → 179 bytes)
```

함수 안의 주석은 그 사실을 정확히 적어두었는데(**"경로 정보만 얻어"**) 이름이 반대로 말하고
있었고, 이름을 믿은 소비자가 둘 있었다.

**그리고 둘째가 진짜 결함이다.** FIX_LOOP 프롬프트가 이 값을 이렇게 렌더링하고 있었다:

````
## Changes that were applied
```diff
# applied to paginate.js (173 → 179 bytes)
```
````

제목도 fence도 diff라고 말하는데 내용은 **바이트 수 한 줄**이다. 모델은 "당신이 적용한 변경"을
보라는 지시를 받고 크기 보고서를 읽는다. context-engine 6.1절이 이미 같은 자리의 절반을 고쳤다 —
*"FIX_LOOP가 패치 이전의 파일 내용을 실어 보내면서 프롬프트로는 '당신의 변경이 이미 반영되어
있다'고 말하고 있었다."* 스냅샷 절반은 그때 고쳤고, **프롬프트 절반이 남아 있었다.**

고친 방식은 없는 diff를 만들어 채우는 것이 아니라 **부르는 이름을 사실에 맞추는 것**이다
(`extractDiff` → `describeApplied`, `appliedDiff` → `appliedChanges`). 변경 **내용**은 6.1절이
정한 대로 다시 읽은 스냅샷이 나르므로 프롬프트에 diff가 따로 필요하지 않다. 대신 그 절이
목차라는 것을 문장으로 말한다 — "이 섹션은 색인이지 diff가 아니고, 현재 내용은 위 스냅샷에
이미 반영되어 있다."

diff를 진짜로 싣고 싶다면 `git_diff`를 한 번 더 부르면 된다. 하지만 그건 도구 호출 한 번을
더 쓰는 결정이고, 스냅샷이 이미 적용 후 내용을 나르는 지금은 **같은 사실의 두 번째 사본**이다 —
3.2절이 `finalDiff`를 지운 것과 같은 이유로 하지 않는다.

## 4. Policy Gate 기본 매핑 (초안)

`ToolRequest.tool` → 기본 `riskTier`. 워크스페이스 설정으로 override 가능해야 하며, `blocked`는 override로도 못 푼다(예: workspace 바깥 경로 쓰기).

| tool | 기본 riskTier | 비고 |
|---|---|---|
| `list_files`, `search_text`, `read_file`, `git_status`, `git_diff` | `auto` | 읽기 전용 |
| `apply_patch`, `create_file` | `conditional` | workspace 내부 경로면 auto, 아니면 `blocked` |
| `delete_file` | `user_approval` | |
| `run_tests` | `conditional` | 프로젝트 정의 test 커맨드면 auto, 임의 커맨드면 `user_approval` |
| `run_command` | `user_approval` | allowlist(예: `git`, 프로젝트 package manager) 매칭 시 `conditional`로 완화 가능, 그 외 항상 승인 |
| workspace 외부 경로 대상 모든 tool | `blocked` | 정책으로도 해제 불가 |

## 5. `run_command` allowlist 문법

**전제: `run_command`의 `args`는 셸 문자열이 아니라 argv 배열이다.**

```typescript
interface RunCommandArgs {
  executable: string;      // "git", "npm", "pytest" — PATH에서 resolve, basename 비교
  args: string[];          // ["status", "--short"] — shell 파싱 없음
  cwd: string;             // workspace root 기준 상대경로, ".." 세그먼트 금지
  shell?: false;            // true를 요청하면 allowlist 무시하고 항상 user_approval (파이프/리다이렉트 등은 신뢰 불가)
}
```

셸 문자열(`"git status && rm -rf /"` 같은) 형태의 명령을 애초에 도구 인터페이스에서 받지 않는다. 이렇게 하면 셸 메타문자 인젝션 문제 자체가 없어지고, allowlist 매칭이 결정론적이 된다.

### 5.1 Rule 스키마

```typescript
interface CommandRule {
  executable: string;
  argPattern?: string[];      // 위치 기반 glob. "*" = 인자 1개, "**" = 나머지 전부 (마지막 세그먼트에만 허용)
  cwdMustBeWorkspaceRoot?: boolean; // 기본 true
  effect: "auto" | "conditional";   // conditional = UI에 원클릭 승인으로 노출(사유 요약 포함), auto = 무음 허용
}

interface CommandPolicy {
  allow: CommandRule[];   // 순서대로 first-match
  deny: CommandRule[];    // allow보다 항상 우선 평가, 매치 시 riskTier = "blocked" (override 불가)
}
```

매칭 순서: **deny 규칙을 먼저 전체 스캔** → 하나라도 매치하면 `blocked` 확정, 더 볼 것 없음. 그다음 `allow`를 순서대로 first-match. 아무 규칙도 안 맞으면 도구 기본값(`run_command` = `user_approval`)으로 폴백.

### 5.2 기본 워크스페이스 정책 예시

```json
{
  "deny": [
    { "executable": "sudo" },
    { "executable": "runas" },
    { "executable": "reg" },
    { "executable": "netsh" },
    { "executable": "powershell", "argPattern": ["-enc", "**"] },
    { "executable": "git", "argPattern": ["push", "--force", "**"] },
    { "executable": "git", "argPattern": ["push", "-f", "**"] }
  ],
  "allow": [
    { "executable": "git", "argPattern": ["status", "**"], "effect": "auto" },
    { "executable": "git", "argPattern": ["diff", "**"], "effect": "auto" },
    { "executable": "git", "argPattern": ["log", "**"], "effect": "auto" },
    { "executable": "git", "argPattern": ["show", "**"], "effect": "auto" },
    { "executable": "git", "argPattern": ["branch", "--list"], "effect": "auto" },
    { "executable": "git", "argPattern": ["add", "**"], "effect": "conditional" },
    { "executable": "git", "argPattern": ["commit", "**"], "effect": "conditional" },
    { "executable": "npm", "argPattern": ["test"], "effect": "conditional" },
    { "executable": "npm", "argPattern": ["run", "*"], "effect": "conditional" },
    { "executable": "pytest", "argPattern": ["**"], "effect": "conditional" }
  ]
}
```

`npm run *`처럼 스크립트명이 와일드카드인 규칙은 Context Engine이 `package.json`의 `scripts` 키를 미리 인덱싱해서, 실제 정의된 스크립트명과 일치할 때만 `conditional`로 허용하고 그 외엔 `user_approval`로 떨어뜨린다 (임의 스크립트 주입 방지).

경로 인자(파일/디렉터리로 보이는 인자)는 별도로 workspace root 기준 canonicalize 후, root 바깥으로 벗어나면 규칙 매치 여부와 무관하게 `blocked` — 이건 Policy Gate가 `CommandRule` 매칭과 별개로 항상 적용하는 하드 체크다. **`--out=../../etc/passwd`처럼 플래그 값에 숨은 경로도 검사한다** — `-`로 시작하는 인자를 통째로 건너뛰면 그 경로로 탈출할 수 있다(M0 구현에서 발견해 보완).

### 5.3 이 allowlist가 보장하지 않는 것

정직하게 적어둔다. 파일 도구(`read_file`/`apply_patch`/`create_file`/`delete_file`)의 workspace 경계는 강한 보장이다 — 경로를 canonicalize해 루트 밖이면 실행 자체를 하지 않는다.

**그러나 `run_command`로 실행된 프로세스가 그 안에서 무엇을 하는지는 통제할 수 없다.** `npm test`가 workspace 밖 파일을 쓰거나 네트워크를 타는 것을 Policy Gate는 막지 못한다 — 그건 프로세스 샌드박싱(Windows job object, seccomp, 컨테이너)의 문제이고 M0 범위 밖이다.

따라서 **"Policy Gate가 있으니 임의 코드 실행이 안전하다"는 주장은 하지 않는다.** 참인 주장은 세 가지다: (a) 실행될 명령이 사용자에게 정확히 보이고(argv 계약), (b) allowlist 밖 명령은 기본 거부되며, (c) 무엇이 실행됐는지 이벤트 로그로 감사 가능하다.

**이 한계는 "아직 안 한 것"이 아니라 "의도적으로 하지 않는 것"이다**(20.2절). 파일·네트워크를 실제로 제한하는 수단은 전부 사용자의 개발 환경을 다른 환경으로 바꾸는데, 그러면 "사용자의 환경에서 실제로 통과했다"는 판정의 의미가 약해진다 — 그게 이 제품이 파는 것이다. 격리를 얻고 판정을 잃는 교환이라 판정을 지킨다. 트리 종료 보장(Job Object)은 이것과 **다른 문제**이며 12절에 별도 항목으로 있다.

## 6. FIX_LOOP 재전달 페이로드

전체 로그를 매번 다시 보내면 토큰 예산이 빠르게 소진되고, `fixLoopRounds`가 올라갈수록 컨텍스트가 누적 팽창한다. 두 가지로 분리한다.

- **`VerificationReport`**: 감사/UI용 전체 기록. SQLite/artifact store에 그대로 저장.
- **`VerificationDigest`**: Claude에게 실제로 보내는 축약본. 실패한 체크만 상세, 통과한 체크는 한 줄 요약.

```typescript
interface VerificationDigest {
  taskId: string;
  reportId: string;
  attemptNumber: number;              // = fixLoopRounds
  failingChecks: {
    kind: VerificationCheck["kind"];
    command?: string;
    exitCode?: number;
    excerpt: string;                  // head N줄 + tail M줄 (기본 40/40), 중간 생략 표시
    fileReferences: { path: string; line?: number }[]; // 컴파일러/테스트 출력에서 정규식으로 추출
  }[];
  passingChecksSummary: string;       // 예: "lint: pass, typecheck: pass"
}
```

FIX_LOOP에서 Claude 호출 시 함께 보내는 것:

1. 원본 `TaskRequest`, `WorkspaceSnapshot`(참조로, 재전송 아님 — provider가 대화 상태를 유지하지 않는다면 필요한 부분만 재삽입)
2. 직전 `ReviewDecision`
3. **`WorkspaceDelta`** — 전체 스냅샷이 아니라 EXECUTING 단계에서 실제로 바뀐 파일의 diff만

```typescript
interface WorkspaceDelta {
  baseSnapshotId: string;
  changedFiles: { path: string; diff: string }[]; // unified diff, base snapshot 대비
  createdAt: ISODateTime;
}
```

4. `VerificationDigest`

토큰 예산 규칙: `VerificationDigest` + `WorkspaceDelta` 합이 태스크 잔여 예산의 30%를 넘으면, 실패 체크 중 우선순위 낮은 것(예: lint)의 `excerpt`부터 줄인다. `build`/`test` 실패는 마지막까지 보존한다.

## 7. 이벤트 로그 & SQLite 스키마

설계 원칙: `task_events`가 append-only 진실의 원천이고, `tasks.phase`/`counters`는 매 이벤트 삽입과 같은 트랜잭션 안에서 갱신되는 파생 캐시다. 이렇게 하면 (a) UI가 히스토리를 재생할 수 있고 (b) 앱이 크래시돼도 재시작 시 마지막 이벤트+카운터로 진행 중이던 태스크 상태를 복원할 수 있다.

큰 콘텐츠(파일 전체 내용, patch, 전체 로그)는 `payload_json`에 인라인하지 않는다. 8KB 넘는 페이로드는 `%APPDATA%/Tomverse Code/artifacts/<taskId>/<eventId>.blob` 파일로 쓰고 JSON에는 경로+해시만 남긴다. SQLite WAL 비대화를 막기 위함이다.

```sql
CREATE TABLE workspaces (
  workspace_id   TEXT PRIMARY KEY,
  root_path      TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  policy_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  title          TEXT,
  started_at     TEXT NOT NULL
);

CREATE TABLE tasks (
  task_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(session_id),
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_message   TEXT NOT NULL,
  phase          TEXT NOT NULL,       -- TaskPhase
  counters_json  TEXT NOT NULL,       -- { clarificationRounds, reviseRounds, fixLoopRounds, toolRetries }
  final_status   TEXT,                -- null 이면 아직 진행 중
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE task_events (
  event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  seq            INTEGER NOT NULL,    -- task 내 순번, (task_id, seq) unique
  event_type     TEXT NOT NULL,       -- 아래 이벤트 타입 목록
  payload_json   TEXT NOT NULL,       -- 8KB 초과분은 artifact 참조로 대체
  created_at     TEXT NOT NULL,
  UNIQUE(task_id, seq)
);
CREATE INDEX idx_task_events_task ON task_events(task_id, seq);

CREATE TABLE tool_requests (
  request_id     TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  plan_id        TEXT NOT NULL,
  tool           TEXT NOT NULL,
  args_json      TEXT NOT NULL,
  risk_tier      TEXT NOT NULL,
  requested_by   TEXT NOT NULL,       -- openai | claude | orchestrator
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_tool_requests_task ON tool_requests(task_id);

CREATE TABLE tool_results (
  request_id     TEXT PRIMARY KEY REFERENCES tool_requests(request_id),
  status         TEXT NOT NULL,       -- ok | error | denied | timeout
  output_ref     TEXT,                -- artifact 경로 또는 인라인 JSON (짧은 경우)
  error          TEXT,
  duration_ms    INTEGER NOT NULL,
  completed_at   TEXT NOT NULL
);

CREATE TABLE verification_reports (
  report_id      TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_number INTEGER NOT NULL,    -- = fixLoopRounds 당시 값
  overall        TEXT NOT NULL,       -- pass | fail
  checks_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_verification_reports_task ON verification_reports(task_id);

CREATE TABLE snapshots (
  snapshot_id    TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  git_head       TEXT NOT NULL,
  meta_json      TEXT NOT NULL,       -- projectMeta, tokenBudget 등. relevantFiles 본문은 artifact로
  created_at     TEXT NOT NULL
);

-- 10절 FileMutationRecord — 롤백 UX가 조회하는 테이블. request_id 1개당 파일 1개.
CREATE TABLE file_mutations (
  request_id       TEXT NOT NULL REFERENCES tool_requests(request_id),
  path             TEXT NOT NULL,
  pre_existed      INTEGER NOT NULL,   -- boolean (0/1)
  pre_content_ref  TEXT,               -- artifact 경로, pre_existed=0이면 NULL
  post_existed     INTEGER NOT NULL,
  post_content_ref TEXT,
  PRIMARY KEY (request_id, path)
);
CREATE INDEX idx_file_mutations_request ON file_mutations(request_id);
```

롤백(10절)은 `tool_requests.task_id`로 해당 태스크의 모든 `request_id`를 찾고, `file_mutations`를 조인해 `path`별 최신 `pre_image`를 역방향 patch로 변환한다.

`task_events.event_type` 값: `TASK_CREATED`, `SNAPSHOT_CREATED`, `DRAFT_RECEIVED`, `REVIEW_RECEIVED`, `PLAN_CREATED`, `APPROVAL_REQUESTED`, `APPROVAL_GRANTED`, `APPROVAL_DENIED`, `TOOL_REQUESTED`, `TOOL_COMPLETED`, `VERIFICATION_COMPLETED`, `FIX_LOOP_STARTED`, `PHASE_CHANGED`, `USER_MESSAGE_RECEIVED`, `TASK_COMPLETED`, `TASK_FAILED`, `TASK_CANCELLED`, `TASK_REJECTED`, `DISAGREEMENT_DETECTED`, `USER_DECISION_RECORDED`(17.3절).

재시작 복구 절차: 앱 기동 시 `final_status IS NULL`인 `tasks` 행을 찾고, 각각의 최신 `task_events` 행 하나를 읽어 `phase`/`counters_json`이 이벤트 로그와 일치하는지 검증한다(불일치 시 이벤트 로그가 우선하며 `tasks` 행을 재계산). `EXECUTING` 중 크래시난 태스크는 재개하지 않고 `FAILED`(사유: "앱 재시작으로 중단됨")로 확정한 뒤 사용자에게 재시도를 맡긴다 — 부분 실행된 `ToolRequest`의 실행 재개는 멱등성 보장이 안 되면 위험하므로 MVP 범위에서는 자동 재개를 하지 않는다.

## 8. Context Engine 스크립트 인덱싱

5절의 `run_command` allowlist(`npm run *` 등)가 실제 프로젝트에 정의된 스크립트인지 확인할 때 쓰는 인덱스. 모노레포를 고려해 workspace root 하나가 아니라 **매니페스트 단위(package)**로 인덱싱한다.

```typescript
interface ScriptIndex {
  workspaceId: string;
  packages: PackageScripts[];
  indexedAt: ISODateTime;
  sourceHash: string; // 모든 매니페스트 파일 해시 — 캐시 무효화 판단용
}

interface PackageScripts {
  manifestPath: string;      // "packages/api/package.json"
  packageRoot: string;       // 매니페스트가 있는 디렉터리, workspace root 기준 상대경로
  ecosystem: "npm" | "python" | "cargo" | "dotnet";
  scripts: {
    name: string;             // "test", "build", "lint"
    command: string;          // 매니페스트 원문 그대로 — 감사/표시용, 절대 이 문자열을 셸로 실행하지 않음
    parsedExecutable?: string; // best-effort 파싱 (예: "jest --coverage" → "jest")
    suspicious: boolean;      // 휴리스틱: curl|sh, rm -rf, sudo, 알 수 없는 호스트로 네트워크 호출 등
  }[];
}
```

- **탐색 대상(v1)**: `package.json`(scripts), `pyproject.toml`(`[project.scripts]`/`[tool.poetry.scripts]`), `Cargo.toml`(사용자 정의 스크립트 없음 — cargo 표준 서브커맨드는 4절 allowlist에서 별도 규칙으로 다룸), `.csproj`/`.sln`은 v1 범위에서 스크립트 개념이 약해 제외.
- **재인덱싱 트리거**: 스냅샷 생성 시 1회, 이후 매니페스트 파일이 git diff에 포함될 때 증분 재인덱싱.
- **suspicious 판정**: `Policy Gate`가 이 플래그를 보고 `effect: "conditional"`을 절대 부여하지 않는다 — suspicious=true인 스크립트는 이름이 allowlist 패턴과 맞아도 항상 `user_approval`로 떨어진다.
- Policy Gate 매칭 시점에는 `ToolRequest.args.cwd`와 일치하는 `packageRoot`를 가진 `PackageScripts`에서만 스크립트명을 찾는다 (다른 패키지의 `test` 스크립트를 엉뚱한 디렉터리에서 실행 허용하는 것 방지).

## 9. Provider 호출 재시도 (인프라 재시도 vs 의미론적 루프 분리)

`toolRetries`(7절)는 로컬 도구 실행 실패에 대한 재시도다. 이것과 완전히 다른 축으로, **LLM API 호출 자체의 인프라 재시도**가 필요하다 — rate limit(429), 5xx, 네트워크 타임아웃 같은 건 모델의 판단과 무관한 전송 계층 문제이므로 `reviseRounds`/`fixLoopRounds`(의미론적 루프, 모델이 실제로 판정을 내린 횟수)와 섞으면 안 된다.

```typescript
interface TaskState {
  taskId: string;
  phase: TaskPhase;
  complexityTier: ComplexityTier | null;
  counters: {
    clarificationRounds: number;
    reviseRounds: number;
    fixLoopRounds: number;
    toolRetries: Record<string, number>;
    providerRetries: Record<string, number>; // key = "draft:1", "review:2", "fix:1" 등 호출 식별자
  };
}
```

| 오류 유형 | 재시도 정책 | 최대 시도 |
|---|---|---|
| 429 (rate limit) | `Retry-After` 헤더 우선 존중, 없으면 지수 백오프(base 2s, cap 60s) | 3 |
| 5xx / 네트워크 타임아웃 | 지수 백오프(base 1s, cap 30s) | 3 |
| 4xx (429 제외: 인증 오류, 잘못된 요청, 콘텐츠 정책 위반) | 재시도 안 함 — 일시적 문제가 아님 | 즉시 실패 |
| 스트리밍 중 연결 끊김 | 부분 응답 폐기, 프롬프트 그대로 1회 재호출 (resume 아님 — provider가 이어받기를 지원하지 않음) | 위 표의 해당 오류 유형 카운트에 포함 |

`providerRetries`가 상한(3)을 넘으면 `FAILED`, `failureReason: "provider_retry_exhausted"`. 인증 오류 등 4xx는 재시도 없이 즉시 `FAILED`, `failureReason: "provider_config_error"` — 사용자가 API 키를 고치기 전엔 재시도해봐야 소용없으므로 루프를 태우지 않는다.

## 10. REJECTED/FAILED 종료 시 롤백 UX

**REJECTED는 되돌릴 파일이 없다** — REJECT 판정은 REVIEWING 단계(PLANNING/EXECUTING 이전)에서만 나오므로 아직 아무 파일도 건드리지 않은 상태다. 롤백이 실제로 필요한 건 `FAILED`(EXECUTING/VERIFYING 중 발생 가능)와 `CANCELLED`(EXECUTING 도중 취소) 뿐이다.

**git stash 대신 태스크 단위 파일 되돌리기를 쓴다.** git stash는 사용자가 Tomverse Code와 무관하게 작업 중이던 uncommitted 변경사항까지 전부 쓸어담아 혼란을 준다. 대신 Tool Runtime이 파일을 변경하는 모든 `ToolRequest`(`apply_patch`/`create_file`/`delete_file`) 결과에 이미 diff 표시를 위해 필요한 pre-image/post-image를 남기므로, 이걸 재사용해 **이 태스크가 건드린 파일만** 정확히 원상복구한다.

```typescript
interface FileMutationRecord {
  requestId: string;
  path: string;
  preImage: { existed: boolean; contentRef?: string };  // artifact 참조, 없었으면 existed=false
  postImage: { existed: boolean; contentRef?: string };
}
```

- `ToolResult.output`이 아니라 별도 `file_mutations` 테이블에 저장(7절 스키마에 DDL 포함, `request_id`로 `tool_requests`와 조인).
- UI: `FAILED`/`CANCELLED` 화면에 "이 작업이 변경한 N개 파일" 목록과 "되돌리기" 버튼. `FAILED`는 되돌리기가 기본 추천(깨진 상태 방치 방지), `CANCELLED`는 사용자 선택에 맡긴다(부분 진행 결과를 원할 수도 있음).
- **되돌리기도 일반 `ToolRequest` 경로를 그대로 탄다** — pre-image를 역방향 patch로 만들어 `apply_patch`/`create_file`/`delete_file`을 다시 큐잉하고 정상적으로 이벤트 로그에 남긴다. 감사 추적에 예외가 없어야 한다.

## 11. Artifact 디렉터리 GC 정책

저장 위치: `%APPDATA%/Tomverse Code/artifacts/<taskId>/...` (7절에서 정의한 8KB 초과 payload들).

- **활성 태스크(터미널 상태 아님)는 절대 GC 대상 아님.**
- **터미널 태스크**(`COMPLETED`/`FAILED`/`CANCELLED`/`REJECTED`)는 기본 30일 보관(설정 가능) 후 정리 대상.
- **디스크 용량 상한**(기본 2GB, 설정 가능)을 넘으면 30일이 안 지났어도 `completed_at` 기준 오래된 터미널 태스크부터 GC — 단, 사용자가 현재 UI에 열어둔 세션의 태스크는 터미널 상태여도 건드리지 않는다.
- GC는 태스크 디렉터리 통째로 삭제. **[context-engine.md](./context-engine.md)에서 결론**: 태스크 artifact로 저장되는 `WorkspaceSnapshot`(선택·패키징 결과, 이 GC 대상)과 세션 스코프로 증분 갱신되는 `WorkspaceIndex`(심볼/의존성 그래프 등 비싼 인덱스, 워크스페이스 단위로 별도 보관되며 이 GC 대상이 아님)는 서로 다른 저장 단위다. 따라서 "스냅샷은 태스크 전용"이라는 가정은 `WorkspaceSnapshot`에 한해 여전히 유효하며, 멀티턴 세션의 재사용/증분 갱신은 `WorkspaceIndex` 쪽에서 이미 반영되었다(context-engine.md 2~3절) — dangling reference 걱정 없음.
- artifact가 지워져도 `tasks`/`task_events`/`verification_reports`의 경량 메타데이터(pass/fail, phase, 타임스탬프)는 영구 보관(작아서 비용이 적고, 세션 히스토리/통계에 필요). `tasks`에 `artifacts_purged BOOLEAN` 컬럼을 추가해 UI가 "로그가 정리됨"을 깨진 링크 대신 표시하게 한다.
- 트리거: 앱 시작 시 1회 + 실행 중 6시간마다, 사용자 액션을 막지 않는 백그라운드 작업으로. 설정 화면에 "지금 정리" 수동 버튼도 둔다.

## 12. 다음으로 구체화할 것

- ~~멀티턴 세션에서 `WorkspaceSnapshot`을 태스크마다 새로 만들지, 세션 내에서 재사용/증분 갱신할지~~ → [context-engine.md](./context-engine.md)에서 "세션 스코프 `WorkspaceIndex` + 태스크 스코프 `WorkspaceSnapshot`" 2계층 구조로 해결
- ~~OpenAI Responses API / Anthropic Messages API 필드를 `DraftProposal`/`ReviewDecision`으로 매핑하는 실제 어댑터 계약~~ → 13.3절에서 Phase 0 스파이크 코드로 검증 완료
- ~~`file_mutations` 테이블 DDL과 7절 스키마 통합~~ → 7절에 DDL 추가 완료(14.2절)
- ~~`SINGLE_MODEL_FIX`가 모호성을 감지했을 때 어떻게 할지~~ → 14.1절에서 `SingleModelFixResult` verdict로 해결
- ~~UI 와이어프레임 (단계 표시, diff 미리보기, 승인 모달)~~ → [ui-wireframes.md](./ui-wireframes.md), M0에서 구현됨
- ~~13.2절 TRIAGE 규칙의 실제 임계값(파일 개수, 키워드 목록) — "어려운" 태스크 세트로 스파이크를 재실행해 규칙을 검증/조정 필요~~ → 13.4절에서 측정했다. **이 항목은 유료 API를 기다리고 있지 않았다**: TRIAGE는 모델을 부르지 않으므로 재실행이 필요했던 이유는 판정이 아니라 **어려운 태스크 세트가 없어서**였고, 그 세트는 이제 가설 게이트 fixture 24개로 존재한다. `npm run gate:g:triage-calibration`이 라벨이 붙은 29개에 production 경로로 규칙을 태우고, fake 공급자로 재도 되는 근거를 **이벤트 순서로 증명한다**. 결과가 문항을 바꿨다 — 임계값이 잘못 맞춰진 것이 아니라 **파일 개수라는 축이 두 라벨을 가르지 못한다**(겹치는 값 하나에 29건 중 26건). 남은 것: **임계값을 지금 바꾸지 않는다.** 어려움 24건 중 20건을 `simple`로 보내는 것의 대가는 "어려운 태스크에서 교차검증이 이득인가"에 달려 있고 그건 게이트 G가 같은 fixture에 대해 재는 값이다 — 유료로 남은 질문은 튜닝이 아니라 **그 20건의 대가**다
- ~~앱 재시작 후 진행 중이던 태스크의 복구 UX~~ → M0.1에서 `INTERRUPTED` 터미널 + 최근 작업 목록 + 되돌리기/다시 실행 버튼으로 해결(16.1, 16.6절)
- ~~**프로세스 샌드박싱 — 파일·네트워크 접근 제한**~~ (5.3절) — 20.2절에서 **하지 않기로 결정**. 조사 결과 Job Object에는 파일·네트워크 제한 기능이 아예 없고("Job Object가 이 항목도 닫는다"던 종전 메모가 틀렸다), 실제로 제한하는 수단(AppContainer·제한된 토큰·컨테이너)은 전부 **사용자의 실제 개발 환경을 다른 환경으로 바꾼다.** 그러면 "사용자의 환경에서 실제로 통과했다"는 판정의 의미가 약해지는데, 그게 이 제품이 파는 것이다(원칙 1). 격리를 얻고 판정을 잃는 교환이라 판정을 지킨다. 5.3절의 한계 진술은 그대로 유지하되, 이제 "아직 안 한 것"이 아니라 **"의도적으로 하지 않는 것"**이다
- **Windows Job Object로 프로세스 트리 종료를 보장한다** — 위 항목에서 갈라져 나왔다(20절). **구현했다**(`win_job.rs`, 20.5절): spawn 직후 배정 → 취소 시 `TerminateJobObject` → Drop 시 `CloseHandle`로 남은 것 정리. 16.3절 `taskkill /T`의 스냅샷 한계와 아래 "강제 포기 이후 정리"를 둘 다 닫는다. **남은 것은 검증이다**: 이 저장소의 개발 환경은 Linux라 `cfg(windows)` 의존성이 해석조차 되지 않으므로 **여기서 통과한 verify는 이 코드에 대해 아무것도 말하지 않는다.** 별도 크레이트에서 실제 파일을 `#[path]`로 가리켜 타입 검증만 했고, 동작은 20.6절 착지 기준을 Windows에서 통과시켜야 확인된다. 그때까지 taskkill 경로를 지우지 않는다
- ~~취소 중 UI가 "정리 중"에서 얼마나 기다려야 하는지에 대한 상한 — 응답 없는 프로세스에 대한 사용자 탈출구(강제 포기)가 없다~~ → 16.3절에서 해결. 자식 수거에 `REAP_TIMEOUT`(2초) 상한을 두고 넘기면 살아남은 PID를 보고하며, `force_abandon`이 "기다리기를 그만두는" 탈출구다(프로세스를 죽이지는 않고 그 사실을 기록한다)
- ~~**강제 포기 노출 시점(5초)의 근거**~~ — 16.3절에서 해결. 실제 취소 소요 분포를 집계해 임계값을 유도하고(`tomverse-host metrics`의 `cancellation`, Tauri `force_abandon_threshold`), 값과 함께 그 출처(`measured` / `default_insufficient_samples`)를 돌려준다. 5초는 지워진 것이 아니라 **표본이 부족할 때의 기본값으로 밀려났다.** 남은 것: 유도 규칙(정상 취소의 max × 1.5, 하한 3초·상한 30초, 최소 표본 10)의 상수들은 여전히 관례적 선택이다 — 실사용 분포가 쌓이면 p50/p90/p95를 함께 보고 다시 볼 것
- ~~**강제 포기 이후 남은 프로세스의 정리**~~ — 두 플랫폼에서 성격이 달랐고, 둘 다 닫혔다. **Windows**: Job Object 핸들의 Drop이 커널에게 정리를 맡긴다(20.4절) — 다만 그 구현은 아직 Windows에서 검증되지 않았다(20.5절). **Unix**: 프로세스 그룹은 핸들처럼 닫히지 않으므로 "우리가 대신 죽인다"는 불가능하고 필요하지도 않다 — SIGKILL은 이미 걸려 있어 다시 보낼 것이 없다. 실제 구멍은 다른 데 있었다: 포기한 자식을 버리면 좀비가 남고, `is_alive`가 `kill(pid, 0)`이라 **좀비를 살아 있다고 보고해 "남아 있을 수 있습니다"가 영원히 참으로 남는다.** 이제 소유권을 넘겨 계속 거둔다(`adopt_orphan`, 16.3절). 남은 것: 거둔 뒤에 "정리됐습니다"를 화면에 되돌려주지는 않는다 — 그러려면 이미 터미널인 태스크에 이벤트를 덧붙여야 하고, 그 값어치는 실제로 이 상황이 얼마나 나오는지 봐야 안다: Job Object를 쓰면 추적할 것이 없다(`KILL_ON_JOB_CLOSE` job의 핸들을 놓으면 커널이 전부 죽인다). 따라서 이 항목은 독립적으로 풀 문제가 아니라 위 Job Object 항목에 딸려 닫힌다 — "이미 우리 손을 떠난 프로세스를 추적한다"는 문제 자체가 사라진다
- ~~Git commit 자동 생성의 오케스트레이터 통합 — Policy Gate(항상 승인)와 도구는 있으나 `ExecutionPlan`에 commit 단계를 넣는 로직이 없다~~ → 18절에서 해결
- ~~**커밋 뒤 되돌리기의 의미** — `git revert`를 제안할지, 커밋 이전으로 되돌릴지는 사용자의 워크플로에 달려 있어 우리가 정할 수 없다 — 되돌리기 화면에서 선택지로 물어야 하는지 검토 필요~~ → 19절에서 해결: **묻는다.** 다만 선택지는 우리가 안전하게 수행할 수 있는 둘(파일 복원 / `git revert`)뿐이고, 이력 재작성은 제안도 실행도 하지 않는다
- ~~**충돌하는 revert의 처리**~~ — 19.3절에서 해결. 전제였던 "`--abort`도 승인을 받아야 한다"가 틀렸다: `--abort`는 우리가 시작해 실패한 작업의 원상복구이므로 "되돌리기" 한 번의 승인 범위 안이다. 지금은 충돌을 감수하고 시도하되 실패하면 우리가 치우고, **네 결말을 구별해서** 보고한다. 남은 것: 원상복구까지 실패한 경우(저장소가 revert 진행 중)를 화면이 문장으로만 알린다 — 그 상태에서 빠져나오는 버튼을 둘지는 실제로 그 상황이 얼마나 나오는지 보고 정한다
- ~~**커밋 단위**~~ — 19.6절에서 해결. **취향의 문제가 아니었다**: 항목이 두 축을 섞고 있었고, 나눠 보니 둘 다 쪼갤 수 없었다. 시도별로 쪼개면 검증에 실패한 상태를 커밋하게 되어 "이 도구가 만든 커밋은 검증을 통과했다"는 성질이 깨지고, 주제별로 쪼개면 각 조각이 검증된 적이 없다. "무엇을 시도했는지 잃는다"는 걱정은 사실이 아니다 — 잃는 것이 아니라 `task_events`에 있고, 이제 커밋이 그곳을 가리킨다(재시도 횟수는 본문에, 태스크 id는 trailer에). 남은 것: 기본 문턱 8개는 **유도하지 못한 상수**다(첫 사용자에게는 관측할 과거가 없다). 실사용 분포가 쌓이면 `commitSizes`를 보고 다시 볼 것 — 그때 물을 것은 "8이 맞았나"가 아니라 "기본값이 필요한 구간이 얼마나 길었나"다
- **17.4절 blocking 판정 규칙과 랭킹 순서의 임계값** — 조정 근거가 될 계측이 17.10절 ⑩에서 붙었다(`field`, `metrics`의 `cardAnswers`). **비율 자체는 실사용 데이터가 있어야 나오므로 이 항목은 열려 있다.** 다만 문항을 두 번 고쳤다. (1) **랭킹의 "예산 초과 시 무엇을 먼저 묻는가"는 발생하지 않는다** — 필드가 3개라 상한 4를 넘을 수 없다(17.4.2절). 랭킹이 실제로 하는 일은 카드 안의 **자리 순서**뿐이다. (2) 그래서 읽는 법이 "필드끼리 비교"가 아니다 — 랭킹이 고정이라 **필드와 자리가 교락되어 있고**, `byPosition`/`byField`는 그 두 축의 주변 분포라 따로 보면 어느 쪽 때문인지 가를 수 없다. `byFieldAndPosition`(결합 분포)에서 **한 필드 안의 자리별 차이**를 본다 — 카드에는 갈린 필드만 실리므로 같은 필드가 카드마다 다른 자리에 오고, 그 변이가 자리 효과를 분리해 준다(무작위화가 필요 없다). 튜닝할 때 고칠 자리는 여전히 `DISAGREEMENT_FIELD_RANK` 한 줄이다. ~~남은 것: **blocking 판정 규칙 자체**는 이 계측이 답하지 못한다 — 그걸 재려면 비-blocking 쟁점도 한 번은 물어보는 실험이 필요하다~~ → 17.4.1절에서 해결. **실험을 만들 필요가 없었다**: 17.4절이 이미 "표시만"이라고 정해두었고 카드 화면에도 접힌 영역이 있었는데 **구현이 카드에 싣지도 않고 있었다.** 원래 하기로 한 표시를 하니 데이터가 생긴다. 답은 선택이고 왕복 횟수는 늘지 않는다(카드가 이미 뜰 때만, 예산을 넘긴 blocking이 없을 때만). `decisions[].blocking`과 `cardAnswers.byBlocking`이 그 답을 갈라 센다. **비율 자체는 여전히 실사용 데이터가 쌓여야 나온다**
- ~~**자유 서술 필드(`interpretation`/`risks`)의 대조 정확도**~~ — 17.12절에서 해결. **문제는 정확도가 아니라 이름이었다**: 서술은 거의 언제나 다르므로 "불일치"라는 이름이 발견을 주장하는데 실제로는 아무것도 발견하지 않은 것이다. 의미 비교는 여전히 하지 않고(17.8절 그대로), 대신 `NarrativeField`로 타입을 갈라 `blocking`/`question`이 달리지 않게 했다. 부수 효과로 14절 지표의 분모에서 **물어본 적 없어 뒤집힐 수도 없는 항목**이 빠졌다. 남은 것: 서술을 읽을 가치가 있는 순서로 정렬하지 않는다 — 그 판정에는 의미 비교가 필요하고 그건 모델 호출이다
- **한 카드 질문 상한 4개의 근거** — 물을 수 있게 하는 계측이 17.10절 ⑨에서 붙었다(`cardPosition`·`optionRank`·`cardSize`, `metrics`의 `cardAnswers`). **그런데 상한이 지금은 구속하지 않는다**: 대조는 필드당 쟁점을 하나만 만들고 판정 가능한 필드가 3개라 한 카드는 최대 3개다(17.4.2절). 그러므로 "4가 맞는 수인가"는 **지금 답할 필요가 없는 질문**이고, `deferred`도 production에서는 언제나 비어 있다. 필드가 늘어 상한을 넘기는 순간 `contrast.test.ts`의 검사가 실패해 이 항목이 자동으로 다시 열린다 — 사람이 기억하는 규칙으로 두면 언젠가 잊는다. 남은 것: **자리 효과 자체는 여전히 열려 있다**(상한과 무관하게 아래쪽 질문이 대충 눌리는가). 읽는 법은 아래 랭킹 항목과 같다 — `byFieldAndPosition`을 본다. 남은 계측 공백: 질문당 머문 시간을 재지 않는다 — 그걸 재려면 편집 중인 입력을 추적해야 하고, 그건 17.11절이 하지 않기로 한 것과 같은 성질의 기록이다
- ~~**기준 충족 여부의 자동 판정 범위**(17.3) — `AcceptanceCriterion`에 대응하는 테스트가 존재하는지를 어떻게 자동으로 잇는가~~ → 17.9절에서 **좁게** 닫혔다: 기준 문장이 실재하는 테스트 파일을 지목하고 그 파일이 검증 출력에 나타났을 때만 확인이다. 나머지는 미확인으로 남는다
- ~~**기준↔테스트 연결의 커버리지**~~ / ~~**위치 충돌 규칙의 오탐률**~~ → 두 질문에 답할 **계측**이 17.10절에서 붙었다(`tomverse-host metrics`). 데이터는 실사용이 있어야 쌓이므로 아래 두 항목이 그 자리를 이어받는다
- **커버리지 실측과 그에 따른 결정** — `no_test_reference`가 압도적일 것으로 예상하지만 확인된 바 없다. 실측 후 결정할 것: (a) 기준을 적을 때 테스트를 함께 적도록 프롬프트/카드를 바꿀지, (b) 잇는 규칙을 넓힐지. **(b)를 먼저 하고 싶은 유혹을 경계할 것** — 규칙을 넓히면 확인이 늘어 보이지만 늘어난 확인이 근거 있는 것인지는 같은 규칙으로 검사할 수 없다
- **충돌 결말 실측** — 두 원인을 가를 계측이 17.10절 ⑧에서 붙었다(`interpretationTextChanged`, `metrics`의 `planUnchangedByInterpretation`). **비율 자체는 실사용 데이터가 있어야 나오므로 이 항목은 열려 있다.** 다만 이제 답이 나올 수 있는 형태다: `plan_unchanged`가 해석이 그대로인 쪽에 몰리면 고칠 곳은 프롬프트, 해석이 달라진 쪽에 몰리면 게이트가 잡은 것이 실제 문제였는지를 봐야 한다. 남은 계측 공백: 해석이 **의미상** 바뀌었는지는 재지 않는다 — 그건 모델 호출이라 하지 않는다(17.8절)
- ~~**17.3절 세 구멍의 구현** — 사용자 답변 승격, `USER_DECISION_RECORDED` 원문 기록, `doneCriteria` 소비~~ → 구현 완료. 구현이 드러낸 문서의 틀린 부분과 새로 정한 규칙은 17.7절에 있다
- ~~**자유 텍스트 비밀값 마스킹의 모양 목록**(17.7)~~ — 17.11절에서 입력 시점 경고를 붙였다. 구현하면서 **17.7①의 위험 평가가 틀렸다는 것이 드러났다**: 마스킹은 저장 직전에 돌아 감사 로그만 지키고, 답변은 프롬프트에 실려 **모델 공급자로 그대로 나간다.** 그 경로에서 입력 시점 경고는 보완이 아니라 유일한 통제다. 막지는 않는다 — 자격증명 모양이 진짜 요구일 수 있고 요구의 최종 권위는 사용자다(원칙 1). 남은 것: **목록 자체는 여전히 완결되지 않는다.** 달라진 것은 사용자가 그 사실을 보내기 전에 안다는 것뿐이고, 그래서 경고 문구가 "아는 모양만 찾습니다"를 함께 말한다
- ~~**제품 유료 호출의 예산 상한**~~ — [multi-engine-routing.md 10.6절](./multi-engine-routing.md)에서 해결. `FailureReason`에 `budget_exceeded`가, `FinalResult`에 `budget`이 붙었고(3절), 원장 이벤트는 별도 테이블이 아니라 `task_events`에 남는다 — **원칙 7이 이미 정본을 정해두었고**, 별도 테이블이 필요했던 이유(재개 시 한도 복원)가 태스크당 상한에서는 발생하지 않는다. 구현이 드러낸 것 둘: (a) 타임아웃이 남긴 미해결 예약으로 원장을 차단하면 정상적인 재시도가 "예산 부족"이라는 **틀린 이유**로 실패한다(실측으로 기존 타임아웃 테스트가 깨졌다) — 제품은 차단하지 않고 금액만 빼둔다, (b) **co-executor 호출 실패가 태스크를 FAILED로 기록하고 있었다** — 호출부는 "진행할 수 있다"며 계속 갔으므로 완료된 태스크의 로그에 `TASK_FAILED`가 남는 상태였고, 예산 거부에 같은 경로를 붙이면서 드러나 함께 고쳤다
- **재현 러너** — ~~만들 때 먼저 정해야 하는 것은 기능이 아니라 판정 규칙이다~~ → 21절에서 규칙을 정하고 **검사까지** 구현했다(`tomverse-host reproduce`). **문항 자체에 답을 막는 전제가 둘 있었다**(21.1절): 불일치를 한 비트로 본 것과, 재현을 한 동작으로 본 것. 재현을 "쓰지 않는 검사"와 "쓰는 적용"으로 가르면 **재현을 돌리는 사람이 누구인지 추측할 필요가 없어진다** — 상태를 만들 수 없는 감사자는 검사가 줄 수 있는 것을 전부 받고(patch가 붙는지까지), 원본을 든 사람은 적용을 받는다. 적용기도 21.5절에서 구현했다(`--apply`). **적용기를 만들자 감사 기록의 구멍 둘이 드러났다**(21.6절): 최종 내용 해시가 export에서 빠져 있어 "기록과 같아졌는가"를 물을 수 없었고, 종료 코드가 대부분의 명령에서 사라지고 있었다 — 기록을 읽기만 하는 도구로는 보이지 않던 것들이다. 아래는 그 결정 당시의 기록이다 ↓
  - 원래 문항(보존): "재현은 워크스페이스가 `workspaceFingerprint`와 같은 상태일 때만 의미가 있는데, 다르면 (a) 거부할지 (b) 경고 후 진행할지가 갈린다. 지금 답하지 않는 이유는 근거가 없어서다 — 감사에서 재현을 돌리는 사람이 대개 **같은 상태를 만들 수 없는** 머신에 있는지, 아니면 원본 저장소를 그대로 들고 있는지에 따라 답이 반대가 된다." 이 문항을 지우지 않고 남겨 둔다: **근거가 없어서 못 푼 문제가 아니라 질문이 두 동작을 묶고 있어서 못 푼 문제**였고, 그 구별이 다음에 같은 모양의 항목을 만났을 때 쓸 정보다

## 15. M0 구현에서 드러난 설계 보완

구현이 문서의 빈틈을 세 군데 드러냈다. 셋 다 "결정론적 검증이 최종 판정자"라는 원칙에 직결되므로 기록해 둔다.

### 15.1 `PLANNING → FIX_LOOP` 전이 추가

2절 다이어그램은 **"patch가 적용 계획으로 변환되지 않는 경우"를 다루지 않았다.** 파일 헤더 없는 diff는
LLM의 흔한 실패 모드인데, 이걸 즉시 `FAILED`로 만들면 한 번의 재요청으로 회복 가능한 오류에 태스크 전체를 버린다.

`FIX_LOOP`를 재사용하는 것이 타당하다: FIX_LOOP의 전제는 "결정론적 증거를 근거로 다시 요청한다"이고
patch 파싱 실패는 모델 의견이 아니라 결정론적 사실이다. 3절 `VerificationKind`에 이미 `diff_review`가 있어
이 실패를 리포트로 표현할 수 있고, 상한도 `fixLoopRounds`를 공유하므로 새 무한 루프가 생기지 않는다.

### 15.2 `VerificationCheck.status`를 3값에서 5값으로

원래 `pass | fail | skipped`였다. `skipped` 하나에 "프로젝트에 명령이 없음", "정책상 건너뜀", "타임아웃"이
뭉쳐 있으면 리포트가 통과로 위장할 여지가 생긴다. 지금은
`PASSED | FAILED | NOT_CONFIGURED | SKIPPED_WITH_REASON | TIMED_OUT`이고,
`VerificationReport.overall`에도 "통과가 아님"이 추가됐다 — 실행된 검증이 하나도 없는 것은 통과가 아니다.
**나중에 그 값을 다시 둘로 갈랐다**(`not_configured` / `could_not_run`): 하나로 두는 동안 "돌릴 명령이 없었다"와 "돌리려다 못 돌렸다"가 같은 값이 되어, 화면과 요약이 언제나 전자를 단정했다. 근거는 product-strategy.md 11.1절.

### 15.3 baseline 대비 판정 규칙: "여전히 실패 중이면 실패"

처음에는 "baseline에도 있던 실패는 이번 변경의 책임이 아니므로 pass"로 구현했다. e2e 테스트가 그 규칙의
치명적 결과를 드러냈다: **"실패하는 테스트를 고쳐줘"라는 태스크에서 모델이 아무것도 고치지 못했는데
`COMPLETED`가 나온다.** 그 테스트는 당연히 baseline에서도 실패했으므로 "새로 깨진 것 없음 → pass"가 되기 때문이다.

지금 규칙: **현재 실패 중인 체크가 하나라도 있으면 `fail`.** baseline 비교 결과는 판정을 바꾸지 않고
`newlyFailing`/`preexistingFailures`로 따로 보고한다. 대가는 오래전부터 lint가 깨져 있던 저장소에서
무관한 수정도 실패로 나오는 것인데, "거짓 성공"과 "설명이 붙은 실패" 중에서는 후자가 제품 명제에 맞다.

**이 규칙이 12절의 TRIAGE 튜닝 항목을 더 시급하게 만든다** — 실패한 태스크는 FIX_LOOP를 태우므로,
분류 정확도가 비용에 직접 반영된다. (13.4절에서 실제로 재 보았고, 시급한 것은 임계값 조정이
아니라 **축을 바꾸는 일**이라는 것이 드러났다 — 파일 개수는 이 세트의 어려움을 보지 못한다.)

### 15.4 검증 명령의 실행 환경 통제

실측으로 확인한 문제: `NODE_TEST_CONTEXT`가 설정된 셸에서 앱을 실행하면 `node --test`가 자신을 테스트 러너의
자식으로 취급해 **실패해도 exit code 0을 반환한다.** 그러면 검증 러너가 실패한 테스트를 통과로 보고한다.

따라서 Tool Runtime이 명령을 실행할 때 테스트 러너 제어 변수(`NODE_TEST_CONTEXT`, `NODE_OPTIONS`,
`NODE_V8_COVERAGE`)를 제거한다. 공급자 API 키를 제거하는 것과 같은 자리에서 같은 이유로 처리한다 —
**결정론적 검증은 실행 환경을 통제해야 성립한다.** 다른 생태계(pytest의 `PYTEST_CURRENT_TEST`,
.NET의 `DOTNET_*`)에도 유사한 변수가 있으므로 언어 지원을 넓힐 때 함께 확인해야 한다.

### 15.5 Windows 프로그램 해석 — argv 계약을 지키면서 `npm.cmd`를 실행하는 법

Windows의 npm은 `npm.exe`가 아니라 **`npm.cmd`(배치 shim)**다. Tool Runtime이
`Command::new("npm")`으로 실행하면 `program not found`로 실패한다.

증상이 나쁜 이유는 실패 자체가 아니라 그 다음이다. Verification Runner가 테스트를 돌리지 못해
`SKIPPED_WITH_REASON`이 되고, 그러면 **정상 수정 작업이 검증 없이 완료로 보고**되며 FIX_LOOP도
돌지 않는다. 결정론적 검증을 제품 명제로 내건 이상 이건 "Windows에서 명령 하나가 안 된다"가 아니라
제품 명제가 무너지는 결함이다.

**`cmd.exe /c`로 감싸지 않는다.** 감싸면 실행은 되지만 그 순간 5절의 argv 계약이 사라진다 —
인자의 `&`, `|`, `>`, `%`, `^`가 셸에 재해석되므로 "승인 모달에 보인 명령 = 실제 실행"이라는
보장이 깨진다. 보안 모델과 UI 약속이 동시에 무너지는 거래는 하지 않는다.

대신 shim이 실제로 하는 일을 구조적으로 재현한다:

```text
요청:  npm test --silent
실행:  <node.exe> <...\node_modules\npm\bin\npm-cli.js> test --silent
```

요청 인자는 **가공 없이** 그대로 뒤에 붙고, 셸이 개입하지 않으므로 메타문자는 언제나 리터럴이다.

지켜야 하는 경계:

- **해석은 Policy Gate 판정 이후에 일어난다.** 판정 대상은 언제나 요청된 argv이고, 해석이
  그 정체성을 바꾸지 못한다. `npm`은 `node.exe`로 실행되지만 첫 인자가 `npm-cli.js`임을
  구조적으로 확인하며, 해석 결과가 `node`가 아니면 실행하지 않는다.
- **알려진 shim만 변환한다** (`npm`, `npx`). 그 밖의 `.cmd`/`.bat`은 조용히 셸로 돌리지 않고
  거부한다 — 목록을 넓히는 것은 곧 배치 실행 경로를 넓히는 것이다.
- **구조를 확인할 수 없으면 추측하지 않고 실패한다.** `npm.cmd`는 있는데 `npm-cli.js`가 없으면
  다른 npm을 찾아 쓰지 않는다. 사용자가 승인한 것과 다른 것을 실행하는 것보다 멈추는 편이 낫다.
- **요청 argv와 실제 argv를 모두 결과에 남긴다** (`command` / `resolvedCommand`). 둘이 다를 수
  있게 된 이상, 사후에 대응을 확인할 수 없으면 감사 추적이 성립하지 않는다.

함께 강화한 것: **돌려고 했는데 돌지 못한 체크가 하나라도 있으면 `overall`은 `pass`가 될 수 없다**
(`NOT_VERIFIED`). 예전 규칙은 "실패가 없고 통과가 하나라도 있으면 pass"였는데, 그러면 build만
통과하고 test는 실행조차 못한 상태가 pass가 된다 — 이번 결함이 만든 상황이 정확히 그것이다.
`NOT_CONFIGURED`는 여기 해당하지 않는다. "돌릴 것이 없었다"와 "돌리지 못했다"는 다르고, 전자까지
막으면 lint 스크립트가 없는 프로젝트가 영원히 pass 불가가 된다.

## 16. M0.1 — 작업 영속화와 실제 취소

M0의 취소는 "요청을 받아 두었다가 다음 단계에서 확인"하는 협조적 취소였고, 실행 중인 `npm test`는
끝까지 돌았다. 저장도 이벤트 로그만 있고 작업 목록·복구 경로가 없었다. M0.1은 이 둘을 채운다.

### 16.1 `CANCELLING`과 `INTERRUPTED` — 터미널을 늘린 이유

취소는 순간이 아니라 **구간**이다. 사용자가 버튼을 누른 시각과 자식 프로세스가 실제로 죽는 시각
사이에 실행 중인 명령이 있다. 그 구간을 `CANCELLED`로 표시하면 아직 프로세스가 살아 있는 동안
"취소됨"이라고 말하게 되고, 이전 phase로 표시하면 취소 요청이 접수됐다는 사실이 보이지 않는다.
그래서 비터미널 phase `CANCELLING`을 두고, 취소 가능한 모든 phase에서 여기로 들어온다.

`INTERRUPTED`는 **앱이 비정상 종료된 작업**의 터미널이다. 완료도 실패도 취소도 아니다 —
사용자가 *되돌릴지 다시 실행할지 결정해야 하는* 상태이며, 다른 터미널로 뭉뚱그리면 그 구별이 사라진다.
Node는 이 상태로 전이하지 않는다(`INTERRUPTED: []`). 앱 시작 시 Rust가 DB를 보고 확정하는 상태이기 때문이다.

```mermaid
stateDiagram-v2
    CANCELLING --> CANCELLED: 정리 완료
    CANCELLING --> FAILED: 정리 중 오류
    [*] --> INTERRUPTED: 앱 재시작 시 final_status IS NULL인 작업
    INTERRUPTED --> [*]: 사용자가 되돌리기 / 다시 실행 선택
```

**자동 재개하지 않는다.** 부분 실행된 `ToolRequest`의 재개는 멱등성 보장이 없으면 위험하다
(patch가 반쯤 적용된 파일에 같은 patch를 다시 적용하면 실패하거나, 더 나쁘게는 이중 적용된다).
"다시 실행"은 **새 `task_id`로 같은 요청 문구를 처음부터** 돌리는 것이지 중단 지점 이어가기가 아니다.

### 16.2 취소가 전파되는 경로

취소는 **양쪽 모두** 필요하다. 한쪽만 하면 절반만 취소된다.

| 방향 | 담당 | 끊는 것 | 안 하면 |
|---|---|---|---|
| Rust | `CancellationRegistry` → `CancellationToken` | 실행 중인 자식 **프로세스 트리**, 이후 도구 실행, 이후 검증 시작 | 이미 시작된 `npm test`가 끝까지 돈다 |
| Node | `AbortController` → `AbortSignal` | 진행 중인 공급자 HTTP 호출 | 모델 호출이 계속 돌아 비용이 발생한다 |

순서는 **Rust 먼저**다. 토큰이 켜져야 진행 중인 프로세스가 죽고 새 도구가 시작되지 않는다.

`CancellationToken::cancel()`은 `compare_exchange`로 **정확히 한 호출자에게만** `true`를 준다.
취소 버튼 연타나 Rust/Node 양쪽 도착이 `CANCELLATION_REQUESTED` 이벤트를 두 번 남기지 않게 하는 장치다.
터미널 여부는 메모리 토큰이 아니라 **DB에서 읽는다** — SQLite가 진실의 원천이므로,
둘이 어긋나면 DB를 믿는다.

**취소는 Policy Gate를 우회하는 통로가 아니다.** 취소된 태스크의 도구 요청은 `cancelled` 상태로
거부되고 `TOOL_SKIPPED_CANCELLED` 이벤트가 남는다(`denied`와 구별해야 오케스트레이터가 정책 거부와
헷갈리지 않는다). 롤백만은 예외적으로 **새 토큰**으로 실행한다 — 취소·중단된 작업이야말로 되돌리기가
가장 필요한 순간이기 때문이다. 다만 롤백도 Policy Gate는 그대로 지나므로 workspace 경계 보장은 유지된다.

### 16.3 프로세스 트리 종료와 그 한계

직접 자식만 죽이는 것으로는 부족하다. `npm test`는 `node`를 자식으로 띄우므로 npm만 죽으면
실제 테스트 프로세스가 고아로 살아남는다. 따라서:

- **Unix**: `process_group(0)`으로 자식을 프로세스 그룹 리더로 만들고 `killpg(SIGTERM)` → 300ms 유예 → `killpg(SIGKILL)`
- **Windows**: `CREATE_NEW_PROCESS_GROUP` + `taskkill /T /F`

**정직하게 남겨두는 한계** (5.3절 "이 allowlist가 보장하지 않는 것"의 연장):

- Windows의 `taskkill /T`는 **스냅샷 기반**이다. 이미 고아가 된 손자나 종료 직전에 새로 spawn된
  프로세스는 놓칠 수 있다. Job Object가 정답이지만 `windows`/`winapi` 크레이트와 unsafe 핸들 관리가
  필요해 M0.1에서는 미뤘다.
- **spawn된 프로세스는 스스로 추가 프로세스를 만들거나 파일을 바꿀 수 있다.** 취소는 프로세스를
  죽일 뿐 그때까지의 파일 변경을 되돌리지 않는다. 되돌리기는 별도의 명시적 동작이다.
- 취소 시점에 이미 디스크에 쓰인 변경은 남는다. UI는 이걸 숨기지 않고 "이미 변경된 파일은 자동으로
  되돌아가지 않습니다"라고 표시한다.

**M1에서 닫은 구멍: 무한히 기다리던 자리** (12절 미해결 "취소 중 상한"). `killpg(SIGKILL)` 뒤
`Child::wait()`을 불렀는데 그건 **시간 제한이 없다.** 보통은 즉시 끝나지만 uninterruptible
sleep(D 상태)에 들어간 프로세스는 SIGKILL로도 즉시 죽지 않고 — 응답 없는 네트워크 파일 시스템이나
멈춘 드라이버를 기다리는 경우가 실제로 그렇다 — 그러면 "취소 중"이 영원히 끝나지 않는다.
사용자에게 그건 앱이 멈춘 것과 구별되지 않는다.

`REAP_TIMEOUT`(2초) 안에 자식이 사라지지 않으면 **기다리기를 포기하고 그 사실을 올려보낸다**:
`TreeKillOutcome.child_still_running`과 `surviving_pid`, 그리고 도구 결과의 `treeKill.survivingPid`.
죽지 않은 것을 죽었다고 보고하는 것이 이 기능에서 할 수 있는 가장 나쁜 일이므로, 상한을 넘긴
경우의 메시지는 "중단됨"이 아니라 **"종료 상한 안에 끝나지 않았습니다 … 직접 확인이 필요합니다"**다.
PID를 함께 남기는 이유: "뭔가 남았을 수 있습니다"만으로는 사용자가 할 수 있는 일이 없다.

#### 포기한 자식을 버리지 않는다 — 좀비와 틀린 보고

`REAP_TIMEOUT`을 넘겨 포기한 자식을 그냥 놓으면 두 가지가 남는다.

첫째, **좀비**다. Rust의 `Child::drop`은 기다리지도 죽이지도 않으므로(문서화된 동작), 그
프로세스가 나중에 죽을 때 우리 앱이 부모인 채로 좀비가 되고 앱이 살아 있는 한 사라지지 않는다.
취소를 여러 번 하면 그만큼 쌓인다.

둘째 — 이쪽이 더 나쁘다 — **우리 보고가 영원히 틀린 채로 남는다.** `is_alive`는 `kill(pid, 0)`이라
**좀비를 살아 있다고 보고한다.** 사용자에게 "PID 1234가 남아 있을 수 있으니 직접 확인하세요"라고
말해 놓고, 사용자가 확인하면 계속 살아 있는 것으로 보인다. 실제로는 그 프로세스가 이미 죽었고
**우리가 거두지 않아서** 그렇게 보이는 것인데도.

그래서 포기한 자식은 버리지 않고 **소유권을 넘긴다**(`adopt_orphan`). 백그라운드에서 계속
거두다가 상한(5분)을 넘기면 그만둔다 — 끝나지 않는 스레드를 명령마다 하나씩 만드는 것은
그 자체가 누수이고, 우리가 고치려던 누수와 성질이 같다(원칙 5).

**이것은 프로세스를 죽이지 않는다.** SIGKILL은 이미 보냈고 그 시그널은 **걸려 있다** —
D 상태에서 빠져나오는 순간 적용되므로 다시 보낼 것이 없다. 이 경로가 하는 일은 죽이는 것이
아니라 **죽었을 때 뒷정리를 하는 것**이다. 그래서 12절 "강제 포기 이후 남은 프로세스의 정리"가
Unix에서 답하는 것은 "우리가 정리해준다"가 아니라 **"우리 때문에 안 사라지는 일은 없게 한다"**이다.

**그리고 상한이 있어도 탈출구는 따로 필요하다.** 멈추는 자리가 자식 프로세스만은 아니다 —
sidecar가 응답하지 않거나 공급자 호출이 abort를 무시할 수도 있다. `force_abandon`은 태스크를
CANCELLED로 **확정**해 사용자를 놓아준다. 프로세스를 죽이지는 **않는다** — 죽일 수 있었으면 이
경로가 필요하지 않았다. 그래서 "정리됐다"고 말하지 않고 `forceAbandoned`와 함께 "남아 있을 수
있다"를 기록한다. `finish_task`의 원자적 경로를 그대로 쓰므로, 기다리는 사이에 정상 종료됐으면
그쪽이 남고 강제 포기는 아무것도 덮어쓰지 않는다.

#### 탈출구가 뜨는 시점 — 추정에서 관측으로

버튼을 여는 시점(5초)은 **실측이 아니라 추정**이었다(12절 미해결). 너무 짧으면 정상 취소 중에
탈출구가 떠서 불안을 만들고, 너무 길면 탈출구가 없는 것과 같다. 그리고 그 답에 필요한 데이터는
**이미 이벤트 로그에 있었다** — `CANCELLATION_REQUESTED`와 그 뒤 첫 터미널 이벤트의 시각.

`tomverse-host metrics`가 그 간격을 집계하고, `force_abandon_threshold`(Tauri 명령)가 화면에
전달한다. 상수는 지웠다기보다 **기본값으로 밀려났다**: 표본이 부족하면 종전과 같은 5초다.
이 작업의 목적은 값을 바꾸는 것이 아니라 근거를 붙이는 것이므로, 데이터가 없을 때의 동작은
종전과 같아야 한다.

**세 갈래를 섞으면 숫자가 자기 자신을 먹는다.**

| 갈래 | 분포에 넣는가 | 이유 |
|---|---|---|
| 정상 종료 | **넣는다** | 이것만이 "취소가 얼마나 걸리는가"의 표본이다 |
| 강제 포기 | 넣지 않는다 | 그 간격은 소요 시간이 아니라 **임계값 + 사용자의 반응 시간**이다 |
| 터미널 없음 | 넣지 않는다(따로 센다) | 유한한 소요 시간이 **없다** |

강제 포기를 넣으면 임계값이 자기 자신을 근거로 매번 커지는 되먹임이 생긴다 — **탈출구를 쓸수록
탈출구가 늦게 뜬다.** 반대로 끝나지 않은 취소를 조용히 빼면 분포가 실제보다 건강해 보인다.
그건 탈출구가 존재하는 이유 그 자체이므로 개수를 따로 보고한다.

**p95가 아니라 max에 여유를 곱한다.** 탈출구가 답해야 하는 질문은 "이 취소가 비정상인가"이지
"느린 편인가"가 아니다. p95를 쓰면 정상 취소 20번에 한 번은 탈출구가 떠서, 곧 정상적으로 끝날
작업에 대고 "예상보다 오래 걸리고 있습니다"라고 말하게 된다. 그건 탈출구가 없는 것과는 다른
종류의 거짓말이다. 대신 p50/p90/p95도 함께 보고하므로, 이 규칙이 틀렸을 때 사람이 다시 판단할
재료는 남는다.

상·하한이 있는 이유는 서로 반대다. 하한(3초)은 `REAP_TIMEOUT`(2초)보다 커야 한다 — 그 안에서는
정상 취소가 **아직 진행 중**이라 탈출구가 뜨면 거짓 경보다. 상한(30초)은 이상치 하나가 max를
끌어올려 탈출구가 사실상 사라지는 것을 막는다. 탈출구가 없는 것이 이 기능이 고치려던 문제였다.

**표본이 `MIN_LATENCY_SAMPLES`(10) 미만이면 측정값을 쓰지 않는다.** 한 번의 실행이 앞으로의 모든
취소를 지배하면 그건 측정이 아니라 우연이다. 그리고 값과 함께 `source`를 돌려준다
(`measured` / `default_insufficient_samples`) — 숫자만 넘기면 읽는 쪽이 기본값을 측정값으로 읽고,
12절 항목이 지적한 문제가 정확히 그것이었다.

임계값은 워크스페이스를 열 때 한 번만 읽는다. 취소마다 다시 계산하면 탈출구가 뜨는 시점이 매번
달라지는데, **그 흔들림 자체가 사용자에게는 불안이다.**

### 16.4 스키마 v2 — 추가만 하는 마이그레이션

`SCHEMA_VERSION = 2`. v2 DDL은 **전부 추가 연산**이다(`ALTER TABLE ADD COLUMN` / `CREATE TABLE` /
`CREATE VIEW`). 기존 v1 이벤트 로그를 재작성하지 않는다 — `task_events`가 append-only 진실의 원천이라는
원칙(CLAUDE.md 7)은 스키마 업그레이드에서도 깨지면 안 된다.

| 대상 | 추가 | 이유 |
|---|---|---|
| `tasks` | `workspace_path`, `mode`, `error_summary`, `cancellation_requested_at` | 워크스페이스별 목록 필터와 "왜 실패했나"를 이벤트 파싱 없이 |
| `task_events` | `phase` | 로그만으로 흐름을 재구성하려면 각 이벤트가 어느 단계 것인지 필요 |
| `tool_requests` | `approval_status`, `execution_status`, `started_at` | 승인/실행 상태 추적 |
| (뷰) `tool_executions` | `tool_requests` ⋈ `tool_results` | **테이블이 아니라 뷰다.** 별도 테이블이면 같은 사실이 두 곳에 저장되어 어긋날 수 있다. 뷰는 정의상 어긋나지 않는다 |
| `file_mutations` | `mutation_id`, `rollback_status`, `rolled_back_at` | 무엇이 아직 남아 있고 무엇이 되돌려졌는지 |
| (신규) `verification_checks` | 체크별 행 | "test가 몇 번 실패했나"를 JSON 파싱 없이 질의 |

#### 스키마 v4 — 응답한 모델 (M1)

`SCHEMA_VERSION = 4`. 역시 **전부 추가 연산**이다.

| 대상 | 추가 | 이유 |
|---|---|---|
| `provider_usage` | `requested_model_id`, `resolved_model_id`, `provider_request_id` | 요청한 모델만 남기면 **조용한 대체가 기록에서 지워진다**(product-strategy 6.1절). 공급자 요청 id는 감사에서 상대 로그와 대조할 유일한 열쇠다 |

기존 행의 새 컬럼은 NULL이고, **NULL은 "같았다"가 아니라 "기록하기 전이었다"**를 뜻한다.
집계가 그 구별을 지키지 않으면 옛 기록이 전부 "대체 없음"으로 보고된다.

#### 스키마 v5 — 우리가 추정했던 입력 토큰 (M1)

`SCHEMA_VERSION = 5`. 역시 **전부 추가 연산**이다.

| 대상 | 추가 | 이유 |
|---|---|---|
| `provider_usage` | `estimated_input_tokens` | 컨텍스트 패킹은 토큰 수를 **상한 추정**으로 다루는데(context-engine.md 8.1절), 그 추정이 정말 상한이었는지는 공급자가 보고한 실제와 나란히 놓아야만 알 수 있다. 하나만 남기면 계수를 고칠 근거가 감밖에 없다 |

여기서도 **NULL은 0이 아니다.** 0으로 채우면 집계가 그것을 "추정이 0이었다"로 읽고, 그건 어떤
실제 값에 대해서도 무한대 배 과소 추정으로 잡힌다. 비교할 수 없는 행은 비율에서 빼고
`callsWithoutEstimate`로 따로 센다.

#### 스키마 v6 — 워크스페이스별 공급자 허용 목록 (M1)

`SCHEMA_VERSION = 6`. 역시 **전부 추가 연산**이다.

| 대상 | 추가 | 이유 |
|---|---|---|
| `workspaces` | `allowed_providers` | 이 워크스페이스에서 쓸 수 있는 공급자. 강제는 **자격증명 주입 지점**에서 일어난다(multi-engine-routing.md 16절) |

**여기서 NULL은 "제한 없음"이고 `'[]'`는 "아무것도 허용하지 않음"이다.** 둘을 같게 다루면 빈
목록을 저장한 사용자에게 전부 허용되는데, 그건 사용자가 지시한 것의 정반대다.

**저장소 안의 파일이 아니라 이 테이블인 이유**: 워크스페이스 파일은 태스크가 고치는 대상이므로,
거기 정책을 두면 정책을 지키는 주체가 정책을 수정할 수 있다.

### 16.5 트랜잭션 규칙

**레코드와 그 이벤트는 같은 트랜잭션에 쓴다.** 이벤트 없이 상태가 바뀌거나, 상태 없이 이벤트만
남는 중간 상태를 만들지 않기 위해서다. `record_tool_result_with_event` / `record_file_mutation_with_event` /
`record_verification_with_event` / `finish_task`가 그 형태다.

터미널 상태는 `UPDATE tasks SET final_status = ? WHERE task_id = ? AND final_status IS NULL`로 확정한다.
영향받은 행이 0이면 경쟁에서 진 것이고, **아무것도 바꾸지 않는다.** 완료와 취소가 동시에 도착해도
터미널 이벤트는 정확히 하나만 남는다.

한 가지 함정을 기록해 둔다: 이 `record_*_with_event` 계열은 한 트랜잭션에 쓰기 위해 `append_event`를
거치지 않는다. 그러면 **UI 릴레이(sink)가 빠져서 DB에는 남는데 화면에는 안 보이는** 누락이 생긴다.
커밋 후 명시적으로 릴레이해야 하며, `combined_writes_are_relayed_to_the_ui_not_only_to_the_database`
테스트가 이걸 못박는다.

### 16.6 복구 절차

앱 시작 시 `mark_unfinished_as_interrupted()`가 `final_status IS NULL`인 작업을 전부 `INTERRUPTED`로
확정한다. 멱등이다 — 두 번 돌려도 두 번째는 아무것도 바꾸지 않는다.

이 시점을 지나야 "실행 중"으로 보이는 유령 작업이 사라진다. 실패해도 앱을 죽이지 않는다:
이력을 못 봐도 새 작업은 할 수 있어야 하므로, UI에 사유를 표시하고 계속 진행한다.

### 16.7 비밀값이 이벤트 로그에 남지 않게 하는 것 — Rust 쪽 독립 판정

M0.1을 마무리하면서 발견한 구멍이다. secret 필터가 **Node에만** 있었다
(`packages/sidecar/src/context/exclude.ts`). 그건 Node가 스스로 지키는 규칙이므로,
process-architecture.md 2절의 신뢰 모델("Node가 완전히 장악당해도 Rust 게이트를 통과해야 한다")을
만족하지 못한다. 장악당한 Node는 컨텍스트 필터를 우회해 그냥 도구를 요청할 수 있었다.

구체적으로 두 경로가 열려 있었다:

| 경로 | 무엇이 일어났나 |
|---|---|
| `read_file(".env")` | Policy Gate가 `read_only_within_workspace`로 **자동 허용**하고, 내용이 `TOOL_COMPLETED` 이벤트 payload에 인라인되어 DB와 UI에 남았다 |
| `search_text(pattern: "sk-")` | 자동 승인 도구이고 `hidden(false)`로 `.env`까지 훑으므로, **승인 절차 없이** 매칭된 줄(=키 값)을 그대로 돌려줬다 |

`policy/secrets.rs`에 Rust 자체 분류를 두고 다음을 적용했다.

- **읽기**: 비밀값 경로는 자동 허용이 아니라 `RequireUserApproval`(High). 거부가 아니라 승인인 이유는
  사용자가 정말로 `.env`를 고쳐달라고 요청하는 경우가 있기 때문이다. 원천 차단하면 도구가 쓸모없어진다.
- **쓰기**: `auto_approve_workspace_writes`가 켜져 있어도 승인을 요구한다. **정책으로 끌 수 없다** —
  `.env`를 조용히 덮어써서 잃는 것(되돌릴 수 없는 자격증명)이 일반 소스 파일과 비교할 수 없이 크다.
- **검색**: 비밀값 파일은 **읽기 전에** 건너뛴다. 자동 승인 도구라 승인으로 막을 수 없고, 유출되는 것이
  검색 대상이 아닌 다른 파일의 내용이라 경로 기반 redaction으로도 막을 수 없다.
  건너뛴 개수를 `skippedSecretFiles`로 보고한다 — 조용히 빼면 "검색했는데 없다"와 구별되지 않는다.
- **이벤트**: 승인을 받아도 **값은 이벤트에 남기지 않는다.** 승인은 "모델이 이번 판단에 쓰는 것"에 대한
  동의이고 "감사 로그 영구 보관"에 대한 동의가 아니다. 경로·도구·판정은 남고 본문만 빠진다.
  `APPROVAL_REQUESTED` 이벤트의 `preview`도 같은 이유로 덜어낸다(모달에는 그대로 보여준다 —
  무엇을 승인하는지 모르면 승인이 의미가 없다).

**목록이 Node와 Rust 양쪽에 있는 것은 중복이 아니라 독립 검증이다.** 한쪽을 고칠 때 다른 쪽도 함께
봐야 하며, 그 사실을 양쪽 주석에 적어뒀다.

이 분류가 하는 일은 **경로 이름 판정**뿐이다. 파일 내용에서 비밀값을 찾지 않는다 — 내용 기반 탐지는
원리적으로 불완전하고(모든 키 형식을 알 수 없다), 통과했을 때 "검사했으니 안전하다"는 잘못된 확신을 준다.

이 판단은 M1에서도 유지된다. 다만 **경로가 아예 없는 자유 텍스트**(사용자 판정 원문)에는 적용할
대상이 없어서 별도 완화를 두었다 — 17.7절 ①. 그것은 이 절의 경로 판정을 대체하지 않고,
"안전하다"를 주장하지도 않는다.

**남아 있는 유출 경로 (정직하게 적어둔다):**

- `git_diff`가 추적 중인 비밀값 파일의 변경을 출력하면 그 내용이 이벤트에 들어간다. 보통 `.env`는
  gitignore되지만 실수로 커밋된 저장소에서는 새는 길이다. 파일별로 diff를 쪼개 걸러야 하므로 미뤘다.
- `run_command`가 실행한 프로세스의 stdout에 비밀값이 있으면 막을 방법이 없다
  (`printenv`류가 allowlist에 없다는 것이 유일한 방어이며, 5.3절의 한계와 같은 성질이다).

## 13. Phase 0 스파이크 결과 반영

`spike/`(커밋 `b3eaf87`)에서 CLI 하네스로 실측한 결과를 바탕으로 한 설계 변경. 원본 스파이크 코드는 저장소의 `spike/src/`에 있다.

### 13.1 측정 결과

작은 단일 파일·단일 함수 버그 5개(오프바이원, 경계값 비교, null 가드 누락, `await` 누락, 불리언 역전)에 대해 `gpt-4.1`(초안) + `claude-sonnet-5`(검수) 교차검증과 `claude-sonnet-5` 단독 수정을 비교:

| | 통과율 | 총비용 | 총지연시간 |
|---|---|---|---|
| dual_verification (초안+검수) | 100% (5/5) | $0.0324 | 24.7s |
| baseline_single_model (Claude 단독) | 100% (5/5) | $0.0198 | 14.5s |

두 파이프라인 모두 5개 전부 통과 — 이 난이도에서는 교차검증이 정확도를 전혀 끌어올리지 못했고, 비용은 1.63배, 지연시간은 1.70배로만 늘었다. `docs/design/state-machine-and-protocol.md`를 처음 설계하기 전 아키텍처 리뷰에서 지적했던 우려("교차검증의 가치가 검증되지 않았다")가 부분적으로 확인된 셈이다 — 다만 이건 가설 기각이 아니라 "쉬운 태스크에는 교차검증이 안 맞는다"는 훨씬 실행 가능한 결론이다. 단일 모델이 실제로 틀릴 만한 난이도(다중 파일, 모호한 요구사항, 미묘한 경계값)의 태스크로 재실험해야 가설의 진짜 검증이 된다 (12절 미해결 항목).

### 13.2 설계 반영: TRIAGE 단계와 `complexityTier`

13.1의 실측을 반영해 상태 머신에 `TRIAGE`/`SINGLE_MODEL_FIX`를 추가했다(2절). 핵심 원칙:

- **결정론적 검증(VERIFYING)은 절대 생략하지 않는다.** TRIAGE가 건너뛰는 건 OpenAI 초안 + Claude 검수라는 "LLM 대 LLM" 이중 판단뿐이다. build/test/lint 같은 제3의 판정자는 tier와 무관하게 항상 돈다 — 프로젝트의 핵심 원칙("재현 가능한 검증이 모델 의견보다 우선")을 TRIAGE가 훼손하지 않는다.
- **TRIAGE는 LLM 호출이 아니라 규칙 기반 휴리스틱이다.** 분류 자체에 모델을 쓰면 모든 태스크에 세 번째 호출이 추가되어 "쉬운 태스크의 비용 절감"이라는 목적과 모순된다. SNAPSHOTTING 완료 시점에 이미 있는 신호(`WorkspaceSnapshot.relevantFiles.length`, `gitDiffSummary` 유무, `TaskRequest.userMessage`의 키워드 매칭)만으로 판정한다.
  - 기본 규칙(초안, 12절에서 튜닝 필요 표시): `relevantFiles.length <= 1` AND 다른 미커밋 변경 없음(`gitDiffSummary` 비어있음) AND userMessage가 고위험 키워드(아키텍처/리팩터/마이그레이션/보안/인증/결제/삭제 등)에 매칭되지 않음 → `simple`. 그 외 전부 `standard`.
- **잘못된 `simple` 분류는 VERIFYING이 걸러낸다.** `simple`로 분류됐지만 `SINGLE_MODEL_FIX`의 결과가 테스트를 통과하지 못하면 FIX_LOOP로 빠지고, FIX_LOOP는 (13.1 이전부터) 항상 Claude를 다시 호출해 VerificationReport 기반으로 수정한다 — 이 시점부터는 사실상 "실패를 알고 재시도하는 Claude"이므로 tier를 다시 매길 필요가 없다. 즉 분류 오류의 비용은 재시도 1회로 국한되고, 최종 결과의 정확성은 tier 판정 정확도에 의존하지 않는다.
- **사용자가 정책으로 override 가능해야 한다.** `TaskPolicy`에 `forceComplexityTier: "standard" | null` 같은 옵션을 두어, 특정 워크스페이스(예: 프로덕션 결제 코드)는 TRIAGE 결과와 무관하게 항상 `standard`로 강제할 수 있게 한다(4절 Policy Gate와 같은 워크스페이스별 override 패턴).

### 13.3 Provider 어댑터 계약 (스파이크 코드로 검증됨)

12절에 있던 미해결 항목("실제 어댑터 계약")이 스파이크 구현으로 해소되었다. 실제 동작이 검증된 패턴:

- **OpenAI (초안/DRAFTING, SINGLE_MODEL_FIX 아님):** Responses API, `text.format = { type: "json_schema", strict: true, schema: {...} }`로 구조화된 JSON 출력을 강제. `response.output_text`에서 파싱(`spike/src/providers/openai.ts`).
- **Anthropic (검수/REVIEWING, SINGLE_MODEL_FIX):** Messages API, `tool_choice: { type: "tool", name: "..." }`로 특정 도구 호출을 강제해 구조화된 판정(`verdict`/`rationale`/`finalFile`)을 받음(`spike/src/providers/anthropic.ts`). REJECT일 때 `finalFile`을 생략할 수 있도록 스키마의 `required`에서 제외.
- **모델 선택 관련 실전 이슈:** `gpt-5`/`gpt-5.5` 같은 reasoning 모델은 OpenAI Organization Verification이 필요해 계정에 따라 즉시 사용이 막힐 수 있다(스파이크 실행 중 실제로 발생). 프로덕션에서는 조직 인증 여부를 사전에 확인하거나, 인증이 안 된 조직을 위한 폴백 모델(`gpt-4.1` 등)을 Provider Adapter 레벨에서 자동 선택하는 로직이 필요 — 단순 설정값이 아니라 "인증 상태에 따른 모델 가용성"이라는 새로운 축으로 다뤄야 한다.
- ~~**아직 스파이크가 다루지 않은 것:** `apply_patch`(unified diff), `ToolRequest`/`ToolResult` 루프, REVISE 다회차, FIX_LOOP는 실제 구현 전이라 여전히 설계 단계~~ → **넷 다 구현·검증됐다.** `apply_patch`는 Rust `tools/patch.rs`가 unified diff를 적용하고 e2e가 실제 파일 변경까지 확인한다(문서 21.4절의 순차 적용 흉내가 그 위에 서 있다). `ToolRequest`/`ToolResult` 루프는 Policy Gate를 지나는 제품의 주 경로이고, REVISE 다회차는 `reviseRounds ≤ 2`로, FIX_LOOP는 `fixLoopRounds ≤ 3`으로 각각 상한과 테스트가 있다. **이 문장을 그대로 두면 문서가 거짓을 말한다** — 열린 항목보다 틀린 항목이 나쁘다.

### 13.4 TRIAGE 임계값 캘리브레이션 — 유료 실행을 기다리고 있지 않았다

12절은 이 항목을 *"'어려운' 태스크 세트로 스파이크를 재실행"* 이라고 적어두었고, 그래서
**유료 API 대기**로 분류되어 있었다. 그 분류가 틀렸다.

**TRIAGE는 모델을 부르지 않는다**(13.2절이 규칙 기반인 이유). 규칙의 입력은 워크스페이스
스냅샷과 사용자 메시지뿐이고 둘 다 모델이 한 마디 하기 전에 정해진다. 재실행이 필요했던 것은
**그때 스파이크가 유일한 어려운 태스크 공급원이었기 때문**이지 판정에 모델이 필요해서가 아니다.
지금은 어려운 태스크 세트가 따로 있다 — 가설 게이트의 fixture 24개이며 사전 등록되어 있고
`gate:g:validate`가 오프라인으로 품질을 확인한다.

`npm run gate:g:triage-calibration`은 난이도 라벨이 붙은 태스크 29개(어려움 24 = 게이트 fixture,
쉬움 5 = Phase 0 스파이크)에 **production 경로 그대로** 규칙을 태운다. 공급자는 레지스트리의
`local://` fake 항목이라 네트워크로 나가지 않는다. fake로 재도 되는 근거는 주석이 아니라
**이벤트 순서**다: `TRIAGE_COMPLETED`의 `seq`가 첫 `PROVIDER_USAGE`보다 앞서야 하고, 공급자
호출이 한 번도 없었으면 그 순서 비교는 공허하므로 증명으로 치지 않는다.

**실측 결과 (기본 정책 `maxRelevantFiles=1`)**

| | 어려움 → `simple` | 쉬움 → `standard` |
|---|---|---|
| 현재 기본값 | **20 / 24** | 1 / 5 |
| `maxRelevantFiles=0` | 0 / 24 | 5 / 5 |

지배당하지 않는 후보가 이 둘뿐이다. 그리고 `maxRelevantFiles=0`은 **모든 태스크를 standard로
보내는 것** — TRIAGE를 끄는 것과 같다. 임계값을 2 이상으로 올리는 줄은 전부 지배당한다.

**그래서 답은 "임계값이 잘못 맞춰졌다"가 아니다. 축이 라벨을 가르지 못한다.** 작업 파일 개수
분포가 그것을 직접 말한다:

- 어려움: 1개 → 21건, 2개 → 2건, 3개 → 1건
- 쉬움: 1개 → 5건
- 두 라벨이 겹치는 값 `1`에 **26건**이 몰려 있다. 이 26건은 어떤 임계값으로도 갈리지 않는다.

이건 측정의 결함이 아니라 규칙이 무엇을 볼 수 있는지에 대한 사실이다. 파일 개수는 **여러 파일에
걸친 어려움**을 잡고, 게이트 fixture가 대표하는 종류의 어려움(비동기 순서, 경계 조건, 스키마
호환성)은 **한 파일 안에서 의미적으로** 어렵다. 13.2절은 "관련 파일 개수 ≈ 복잡도"를 가정했는데
그 가정이 이 세트에서는 성립하지 않는다.

**그렇다고 지금 임계값을 바꾸지 않는다.** 13.2절대로 잘못된 `simple`의 대가는 FIX_LOOP 1회로
국한되며, 그 대가가 교차검증 비용(Phase 0 실측: 정확도 이득 0%, 비용 1.63배)보다 큰지는
**어려운 태스크에서 교차검증이 이득인가**에 달려 있다 — 그게 정확히 가설 게이트 G가 재는 값이다.
즉 이 항목에 남은 유료 부분은 "임계값을 튜닝하라"가 아니라 **"위 20건의 대가가 얼마인가"** 하나로
좁혀졌고, 그 답은 게이트 G가 같은 fixture에 대해 이미 내게 되어 있다. 게이트가 이득 없음을
확인하면 20건은 손실이 아니라 절약이다.

또 하나: 테스트 파일을 **세는** 쪽은 어떤 임계값에서도 제외하는 쪽보다 나은 줄을 만들지 못했다
(전부 지배당하거나 동률). context-engine.md 11.1절의 제외 규칙은 이 세트에서 해롭지 않다.

### 13.4.1 축을 하나 더 만들었다 — 위험은 표현이 아니라 코드에 있다 (M1)

13.4절의 결과는 **파일 개수라는 축이 두 라벨을 가르지 못한다**였다(겹치는 값 하나에 29건 중
26건). 그러면 다음 할 일은 임계값을 만지는 것이 아니라 **다른 축을 찾는 것**이다.

product-strategy 5절이 이미 후보를 적어두었다: *"TRIAGE 판정 신호에 §5의 항목을 추가 — 인증·결제·
암호화 코드 경로 여부, DB migration 여부, public API 변경 여부."* 이건 tier를 4단계로 늘리는
것과 **독립된 항목**이라 지금 할 수 있다.

**기존 위험 신호는 사용자의 표현에 의존하고 있었다.** `riskKeywords`가 보는 것은
`userMessage`다. 그래서 같은 코드를 고치는 같은 작업이라도 "결제 로직 고쳐줘"는 `standard`가
되고 "이 함수 좀 봐줘"는 `simple`이 됐다. **위험은 표현이 아니라 코드에 있는데 판정은 표현에
달려 있었다** — 오분류 분자가 모델의 선택에 달려 있던 것(context-engine 11.1.1절)과 같은 모양의
결함이다. 경로는 사용자가 고르는 값이 아니므로 그 의존이 없다.

`riskPathSegments`를 추가했고 **`riskKeywordMatched`와 뭉치지 않는다**. 둘은 서로 다른 것에
의존하므로 한 값으로 합치면 "이 태스크가 왜 standard였나"에 답할 수 없고, 무엇보다 **어느 신호가
실제로 일하는지 잴 수 없다.** 근거도 개수가 아니라 `{경로, 걸린 조각}` 목록으로 남긴다.

**경계를 지킨다.** 단순 포함으로 보면 `auth`가 `author.ts`에, `token`이 `tokenizer.ts`에 걸린다.
잡음이 섞이면 이 신호는 "전부 standard"로 수렴하고, 그건 TRIAGE를 죽이는 것과 같다. 디렉터리
조각이 정확히 같거나 파일명을 `.`/`-`/`_`로 자른 조각이 같을 때만 인정한다.

**`public API 변경`은 넣지 않았다.** 심볼 분석이 있어야 판정할 수 있는데 Tree-sitter는 아직
없다(context-engine 9절). 경로 이름으로 흉내 내면 맞을 때보다 틀릴 때가 많다 — 없는 신호를
있는 척하지 않는다.

**켜는 근거는 실측이다.** 같은 29개 세트에 스윕 축을 하나 더 붙여 재봤다.

| 경로 신호 | maxFiles | 어려움→simple | 쉬움→standard |
|---|---|---|---|
| 안 씀 | 1 | 20/24 | 1/5 |
| **쓴다** | 1 | **19/24** | **1/5** |

한쪽을 개선하고 다른 쪽을 악화시키지 않으므로 **교환비를 정하지 않고도** 답이 된다 — 이 표가
쓰는 지배 관계 그대로다(그래서 `안 씀` 줄이 이제 `지배당함`으로 표시된다).

**이득이 크다는 뜻은 아니다.** 24건 중 1건이고, 대가가 0인 것은 **이 세트의 쉬운 태스크에 위험
경로가 없기 때문**이기도 하다. 실사용에서 `auth/` 아래의 쉬운 태스크는 `standard`로 갈 것이고
그 대가는 여기서 관측되지 않는다. 그리고 파일 개수 축이 26/29를 못 가르는 문제는 **그대로다** —
축을 하나 더한 것이지 그 문제를 푼 것이 아니다.

### 13.4.2 그런데 4단계 확장은 지금 하지 않는다

product-strategy 5절은 `simple | standard`를 `fast | balanced | verified | critical` 4단계로
확장한다고 적었고 13절 로드맵은 그것을 M1 항목으로 둔다. **지금 하지 않는다.** 이유가 둘이고
각각 독립적으로 충분하다.

**① 그 이름들이 17.5절이 갈라놓은 두 축을 다시 합친다.** 17.5절이 고친 실제 결함은 tier와 실행
모드를 뭉갠 것이었다 — `standard` tier가 "사용자가 `verified`를 골랐다"와 "`fast`인데 규칙이
그렇게 분류했다" **둘 다**에서 나오는데 구현이 tier만 보고 있어서 `fast` 모드에서도 실행자를
두 번 부르고 있었다(비용 2배). 5절의 제안은 tier에 `fast`/`verified`라는 **실행 모드와 같은
이름**을 붙이고 "사용자에게 노출되는 품질 정책 이름과 내부 tier를 일치시킨다"고 말한다. 그러면
`tier=verified, mode=fast`라는 상태를 사람이 읽을 수 없게 되고, 방금 고친 혼동이 이름 층위에서
되살아난다.

**② 가를 축이 없다.** 13.4절 실측대로 지금 판정에 쓰는 축은 두 라벨을 가르지 못한다. 그 위에서
tier를 넷으로 늘리면 **이름만 넷이고 규칙은 여전히 두 답만 낼 수 있다.** 사용자에게 네 단계를
보여주면서 실제로는 두 개만 구별하는 것은 화면이 거짓말을 하는 쪽이다.

**그래서 이 항목의 선행 조건을 다시 적는다.** "4단계로 확장"은 구현 작업이 아니라 **(a) tier와
실행 모드를 이름으로 합치지 않는 명명, (b) 네 단계를 실제로 가르는 축**을 먼저 갖는 일이다.
13.4.1이 (b)를 향한 첫 걸음이고, `critical`을 가르는 축(Arena 대상 판정)은 M4에 딸린다.

## 14. 남은 간극 마무리: `SINGLE_MODEL_FIX` 모호성 처리 & `file_mutations` DDL

12절에 남아있던 두 개의 작은 미해결 항목을 정리한다.

### 14.1 `SINGLE_MODEL_FIX`의 모호성 처리

TRIAGE가 추가되면서 생긴 구멍: `SINGLE_MODEL_FIX`가 verdict 개념이 없으면, 원래 `REVIEWING`이라면 `NEED_USER_INPUT`으로 재질문했을 모호한 요청도 그냥 밀어붙여 수정을 시도하게 된다. 이건 REVIEWING 경로가 갖고 있던 안전장치를 TRIAGE가 우회시키는 셈이라 그대로 둘 수 없었다.

**해결:** `SINGLE_MODEL_FIX`도 3절의 `SingleModelFixResult`를 통해 `REVIEWING`과 동일한 3가지 종결 방식을 갖는다 — `ACCEPT`(수정안 확정 → PLANNING), `NEED_USER_INPUT`(모호함 → AWAITING_USER_INPUT), `REJECT`(불가능/위험한 요청 → REJECTED). `REVISE`만 없다 — 검토 대상 초안이 없으므로 "수정 요청"이 성립하지 않는다(2절 상태 다이어그램 갱신 완료).

**tier 승격 규칙:** 일단 `NEED_USER_INPUT`을 거치면(REVIEWING에서든 SINGLE_MODEL_FIX에서든), 사용자 응답 후 재시도는 항상 `DRAFTING`(즉 `standard` 경로)으로 간다 — `TRIAGE`로 돌아가 재분류하지 않는다. 근거: 사용자에게 재질문이 필요할 정도로 모호했다는 사실 자체가 "이 태스크는 애초에 simple이 아니었다"는 강한 신호이므로, 같은 휴리스틱으로 다시 TRIAGE했다가 또 simple로 잘못 분류될 위험을 감수할 이유가 없다. 이 규칙은 `TaskState`에 별도 필드 없이도 구현 가능하다 — `AWAITING_USER_INPUT`에서 나가는 전이가 항상 `DRAFTING` 하나뿐이므로(2절), tier를 명시적으로 덮어쓸 필요 없이 상태 머신 구조 자체가 승격을 강제한다.

### 14.2 `file_mutations` 테이블

10절의 `FileMutationRecord`를 저장할 DDL을 7절 SQLite 스키마에 추가했다 — `tool_requests.request_id`를 외래키로 갖는 `(request_id, path)` 복합 PK 테이블. 롤백 시 태스크의 모든 `tool_requests`를 조회한 뒤 조인해서 각 파일의 `pre_image`를 역방향으로 적용한다(7절/10절 참조).

## 17. 판정 권위의 프로토콜 반영 (요구 오라클 = 사용자)

근거와 기각된 대안은 [product-strategy.md 16절](./product-strategy.md)에 있다. 요약: **요구에 대한 최종 권위는 사용자이고, 모델은 판정자가 아니라 쟁점 발굴기다.** 이 절은 그 결정이 상태 머신·프로토콜·스키마에서 무엇을 바꾸는지 적는다.

### 17.1 상태는 하나도 추가되지 않는다

multi-engine-routing.md 6절과 같은 결론이다. 바뀌는 것은 **`DRAFTING`이 executor를 몇 번 부르는가**와 **`AWAITING_USER_INPUT`이 무엇 때문에 진입하는가** 둘뿐이다.

| Phase | 기존 | 변경 후 |
|---|---|---|
| `DRAFTING` | executor 1회 호출 → `DraftProposal` | executor N회(=1 또는 2) **독립** 호출 → `DraftProposal[]`. N=2면 대조 후 `DisagreementReport` 생성 |
| `AWAITING_USER_INPUT` | verdict = `NEED_USER_INPUT`일 때만 진입 | **+ 해소되지 않은 blocking 불일치가 있을 때도 진입** |
| `REVIEWING` | 초안이 옳은지 판단 | + **사용자가 고정한 `acceptanceCriteria`가 반영됐는지** 확인 |

**상태는 늘지 않지만 전이는 하나 는다:** `DRAFTING → AWAITING_USER_INPUT`. 검수까지 간 뒤에 묻지 않는 이유는 위 표의 세 번째 행이다 — 검수자의 역할이 "사용자가 고정한 `acceptanceCriteria`가 반영됐는지 확인"으로 바뀌었으므로, 기준이 아직 없는 상태에서 검수를 돌리면 확인할 대상이 없다.

`DRAFTING`에 별도 phase(`CONTRASTING` 같은 것)를 만들지 않는 이유: 대조는 LLM 호출이 아니라 **필드 비교 연산**이라 사용자에게 노출할 단계가 아니고, 실패할 수 있는 외부 경계도 없다. 상태를 늘리면 2절 다이어그램과 UI 매핑(ui-wireframes.md 2절)만 복잡해지고 얻는 것이 없다.

**N=2일 때 두 executor는 서로의 산출물을 보지 않는다.** 왕복 합의를 만들지 않는 이유는 product-strategy 16.3절 참조 — 라운드가 늘수록 두 산출물이 독립 표본이 아니게 되고, 합의는 사용자에게 올릴 질문을 지운다.

### 17.2 추가되는 타입

```typescript
// ---- 9. 구조적 대조 결과 (DRAFTING에서 N=2일 때만 생성) ----

/** 대조 가능한 필드. DraftProposal의 부분집합이며, 자유 서술 필드는 제외한다. */
type DisagreementField =
  | "doneCriteria"      // 완료 기준 — 갈리면 요구 자체가 모호하다는 뜻 (가장 강한 신호)
  | "requiredTests"     // 무엇을 검증해야 하는가
  | "targetPaths"       // 어디를 고쳐야 하는가 — 문제의 위치에 대한 이견
  | "interpretation"    // 근본 원인 진단
  | "risks";            // 한쪽만 본 위험

interface Disagreement {
  disagreementId: string;
  field: DisagreementField;
  /** 각 초안의 해당 필드 값. proposalId → 값. */
  positions: { proposalId: string; value: string[] }[];
  /**
   * blocking이면 사용자 판정 없이 진행하지 않는다.
   * 판정 기준은 17.4절 — 모델에게 "심각한가"를 묻지 않는다(그건 또 하나의 모델 의견이다).
   */
  blocking: boolean;
  /** 강제 선택 질문. 개방형 확인("이렇게 이해했는데 맞나요?")을 만들지 않는다 — 16.2절 ②. */
  question: {
    text: string;
    /** 각 선택지는 어느 초안에서 왔는지 추적 가능해야 한다. */
    options: { optionId: string; label: string; fromProposalId: string }[];
    /** 둘 다 아닐 수 있으므로 자유 입력을 항상 허용한다. */
    allowFreeform: true;
  };
}

interface DisagreementReport {
  taskId: string;
  reportId: string;
  proposalIds: string[];
  disagreements: Disagreement[];
  /** 대조했으나 일치한 필드. **검증이 아니다** — 상관된 오류는 불일치를 만들지 않는다(16.5절). */
  agreedFields: DisagreementField[];
  createdAt: ISODateTime;
}

// ---- 10. 사용자 판정의 고정 ----

interface AcceptanceCriterion {
  criterionId: string;
  text: string;
  /**
   * 이 기준이 어디서 왔는가. **`user_decision`만이 권위를 갖는다** —
   * 나머지는 모델이 제안한 것이고 사용자가 뒤집을 수 있다.
   */
  source: "user_decision" | "draft_proposal" | "user_message";
  /** source = user_decision일 때, 어떤 불일치에 대한 답이었는지 */
  disagreementId?: string;
  decidedAt: ISODateTime;
}
```

`FinalResult`에 필드 두 개를 추가한다:

```typescript
interface FinalResult {
  // ... 기존 필드 ...
  /** 이 태스크에서 확정된 기준. 최종 보고가 이걸 체크리스트로 제시한다(17.3). */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** 사용자에게 묻지 못한 채 남은 blocking 불일치 — 있으면 보고에 반드시 표시한다. */
  unresolvedDisagreements?: string[];
}
```

### 17.3 판정의 수명 — 프롬프트 문자열로 끝나면 안 된다

**이 절이 17절 전체에서 가장 중요하다.** 사용자를 판정자로 세우려면 그 판정이 **소비되는 자리**가 있어야 한다. 현재 구현에는 없다:

| 구멍 | 현재 | 결과 |
|---|---|---|
| 사용자 답변의 수명 | `answers[]`에 담겨 다음 프롬프트 문자열로만 주입됨 (`orchestrator.ts:331`, `458`) | 모델이 무시하면 그만. 강제력이 0이다 |
| 감사 추적 | `USER_MESSAGE_RECEIVED` 이벤트에 **`answerLength`만** 기록 (`orchestrator.ts:913`) | **판정자의 판정이 감사 로그에 없다.** 6절 Agent Trace의 실제 구멍 |
| `doneCriteria`/`requiredTests` | `DRAFT_SCHEMA`가 required로 강제해서 받아놓고(`prompts.ts:265`) 소비처가 protocol 타입 정의뿐 | 요구 분석의 결론이 수집만 되고 버려진다 |

**규칙:** 사용자 답변은 `AcceptanceCriterion(source = "user_decision")`으로 승격되고, 이후 세 곳이 반드시 참조한다.

1. **`PLANNING`** — 확정된 기준을 만족하지 못하는 계획은 만들지 않는다. 기준과 충돌하는 patch가 오면 `FIX_LOOP`가 아니라 재요청 대상이다.
2. **`VERIFYING`** — build/test/lint 결과 옆에 기준 체크리스트를 함께 낸다. **단, 기준 충족 여부를 모델이 판정하게 하지 않는다.** 자동 판정이 가능한 것(대응하는 테스트가 존재)과 불가능한 것을 나눠 표시하고, 후자는 "미확인"으로 남긴다 — 여기서 모델에게 판정을 맡기면 9절 순환 의존이 그대로 재현된다.
3. **`FinalResult`** — "사용자가 정한 기준 N개 중 M개가 테스트로 확인됨, K개 미확인"을 보고한다. 지금처럼 build/test/lint 결과만 요약하면 **사용자가 무엇을 결정했는지가 최종 보고에서 사라진다.**

**이벤트 타입 추가** (7절 목록에 더한다):

| 이벤트 | 언제 | payload |
|---|---|---|
| `DISAGREEMENT_DETECTED` | 대조 완료 시 (불일치 0건이어도 기록 — 대조를 돌렸다는 사실 자체가 감사 대상) | `DisagreementReport` |
| `USER_DECISION_RECORDED` | 사용자 답변 수신 시 | **답변 원문**, `disagreementId`, 선택한 `optionId` 또는 자유 입력 |

`USER_DECISION_RECORDED`는 `answerLength`가 아니라 원문을 남긴다. 8KB를 넘으면 7절 규칙대로 artifact로 밀어낸다.

**비밀값 처리는 16.7절 필터를 "그대로 적용"할 수 없다** — 이 문장은 구현하면서 틀린 것으로 드러났고 아래로 고친다. 16.7절의 판정은 **경로 이름** 기반인데(그 절이 "파일 내용에서 비밀값을 찾지 않는다"를 명시적 결정으로 적어두었다), 사용자 답변에는 검사할 경로가 아예 없다. 그런데 사용자가 답변에 토큰을 붙여넣는 경우는 실제로 있으므로 아무것도 하지 않을 수는 없다. 구현은 17.7절의 `mask_secret_shapes`로 간다 — **경로 판정을 대체하는 것이 아니라, 경로가 없는 자유 텍스트에만 적용되는 별도의 완화**이며 "안전하다"를 주장하지 않는다.

**SQLite 스키마 추가** (`SCHEMA_VERSION = 3`, 16.4절과 같이 추가 전용 마이그레이션):

```sql
CREATE TABLE acceptance_criteria (
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  criterion_id   TEXT NOT NULL,
  text           TEXT NOT NULL,
  source         TEXT NOT NULL,       -- user_decision | draft_proposal | user_message
  disagreement_id TEXT,               -- source = user_decision 일 때
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, criterion_id)
);
```

`task_events`가 진실의 원천이고 이 테이블은 **파생 캐시**다(7번 원칙). `VERIFYING`과 최종 보고가 매번 이벤트를 재생하지 않도록 두는 것이며, `tasks.phase`와 같은 성격이다. 이벤트 없이 이 테이블만 갱신하는 경로를 만들지 말 것.

### 17.4 질문 예산 — 상한은 그대로, 랭킹을 추가한다

`clarificationRounds ≤ 2`(2.2절)는 **바꾸지 않는다.** 사용자가 위임한 이유는 그 일을 하기 싫어서이고, 무제한 질문은 제품 가치를 직접 깎는다. 대신 예산이 유한하므로 **무엇을 먼저 물을지**를 정해야 한다.

- **한 라운드에 여러 불일치를 묶어서 묻는다.** 라운드 = 왕복 횟수이지 질문 개수가 아니다. 사용자에게는 한 화면에 강제 선택 3~4개가 낫지, 세 번 깨우는 것이 최악이다.
- **blocking 판정은 규칙 기반이다.** 모델에게 "이게 심각한가"를 묻지 않는다 — 그러면 또 하나의 캘리브레이션 안 된 모델 의견이 게이트가 된다. 초안 규칙:
  - `doneCriteria` 불일치 → 항상 blocking
  - `targetPaths`가 **서로소**(겹치는 파일이 하나도 없음) → blocking. 두 모델이 문제의 위치 자체를 다르게 봤다는 뜻이다
  - `requiredTests` 불일치 → `verified` 이상에서 blocking, 그 아래는 비-blocking
  - `interpretation`/`risks` 불일치 → 비-blocking (표시만 — 17.12절에서 아예 `narratives`로 분리됐다)
- **비-blocking 쟁점은 카드에 함께 싣되 답은 선택이다.** "표시만"이라고 적어두었지만 구현은
  카드에 싣지도 않았다(아래 17.4.1절). 함께 실으면 왕복 횟수는 그대로이고, 두 가지가 생긴다:
  사용자가 갈린 것을 보고 고칠 방법, 그리고 **규칙 자체를 검증할 데이터.**
- **랭킹 순서**(예산 초과 시): `doneCriteria` > `targetPaths` > `requiredTests` > `interpretation` > `risks`. **이 순서는 추정이며 튜닝 대상이다**(12절 미해결에 추가).
- **못 물어본 blocking 불일치는 조용히 삼키지 않는다.** `FinalResult.unresolvedDisagreements`에 남기고 보고에 표시한다. "물어볼 수 없었다"와 "쟁점이 없었다"는 다른 사실이다.
- 예산을 소진해도 `clarification_exhausted`로 곧장 FAILED 하지 않는다 — 기존 상한 규칙(재질문 상한 초과 시 FAILED)은 **모델이 계속 모호하다고 말하는 경우**를 위한 것이고, 이쪽은 사용자가 이미 답을 준 뒤 남은 저순위 쟁점이므로 진행하되 표시한다.

#### 17.4.1 비-blocking 쟁점이 어디에도 가지 않고 있었다

17.4절은 비-blocking을 "표시만"으로 정했고 카드 화면(ui-wireframes 3.9절)에도 **접힌 영역이
준비되어 있었다.** 그런데 `planQuestionRound`가 blocking만 돌려주는 바람에 그 영역은 한 번도
채워진 적이 없다. 갈렸다고 판정해 놓고 사용자에게 보여주지도 않은 것이다.

결과가 둘이었다.

1. **사용자가 고칠 수 없었다.** 규칙이 "묻지 않아도 된다"고 판정한 것이지 사용자가 그렇게
   판정한 것이 아닌데, 화면에 없으니 뒤집을 방법이 없다. 요구의 최종 권위가 사용자라는 규칙과
   어긋난다(product-strategy 16절).
2. **규칙 자체를 검증할 데이터가 없었다.** 12절이 "비-blocking 쟁점도 한 번은 물어보는 실험이
   필요하다"고 적어둔 것이 이것인데, 실험을 따로 만들 필요가 없었다 — **원래 하기로 한 표시를
   하지 않고 있었을 뿐이다.**

이제 카드에 함께 싣는다. 조건은 둘이고 **둘 다 왕복 횟수를 늘리지 않기 위한 것**이다.

- **카드가 이미 뜰 때만.** 비-blocking 하나 때문에 라운드를 열면 사용자를 한 번 더 깨우게 되고,
  그건 17.4절이 질문 상한을 그대로 두기로 한 이유와 정면으로 어긋난다.
- **예산을 넘긴 blocking이 없을 때만.** 물어야 할 것이 밀려난 카드에 참고 항목을 올리면
  예산이라는 개념이 무너진다.

그리고 **답은 선택이다.** 답하지 않아도 진행하고, 답하지 않은 것을 `unresolvedDisagreements`에
넣지 않는다 — 물었고 사용자가 건너뛴 것이라, 거기 넣으면 그 목록이 "예산이 모자라 묻지 못한
blocking"이라는 뜻을 잃는다.

`USER_DECISION_RECORDED.decisions[].blocking`이 규칙의 판정을 함께 남기고, `metrics`의
`cardAnswers.byBlocking`이 그것으로 갈라 센다. 읽는 법: `non_blocking` 칸의
`pickedOther`+`freeform` 비율이 `blocking` 칸과 비슷하거나 높으면, 규칙이 막지 않기로 한 쟁점도
실제로는 판정이 갈리는 쟁점이었다는 뜻이다. **절대값이 아니라 두 칸의 비교를 본다** — 자리·필드
편향은 양쪽에 똑같이 걸린다.

이 축이 붙기 전 기록은 `unknown`이며 어느 쪽에도 합치지 않는다. 합치면 그 칸의 비율이 과거
데이터로 희석된다.

#### 17.4.2 질문 예산은 지금 구속하지 않는다

`MAX_QUESTIONS_PER_ROUND = 4`인데, 대조는 **필드당 쟁점을 하나만** 만들고 판정 가능한 필드는
셋(`doneCriteria`/`targetPaths`/`requiredTests`)이다. 그러므로 한 카드의 강제 선택은 최대 3개이고
**상한을 넘길 수 없다.**

따라오는 것이 둘이다.

- `deferred`("예산을 넘겨 묻지 못함")는 production에서 **언제나 빈 배열**이다. 코드는 남겨둔다 —
  필드가 늘면 바로 필요해지고, 지우면 그때 다시 만들어야 한다.
- **랭킹의 "무엇을 먼저 버릴 것인가"도 발생하지 않는다.** 랭킹이 실제로 하는 일은 카드 안의
  자리 순서뿐이고, 12절의 두 항목(상한 4의 근거, 랭킹 임계)은 그 사실 위에서 다시 읽어야 한다.

이 사실은 **테스트가 지킨다**: `MAX_QUESTIONS_PER_ROUND >= DISAGREEMENT_FIELD_RANK.length`가
깨지는 순간 실패하고, 그러면 두 항목이 자동으로 다시 열린다. 그리고 상수 비교만으로는
"대조가 필드당 둘 이상 만들기 시작하는" 변화를 못 잡으므로, 세 필드가 모두 갈린 리포트를
실제로 만들어 개수를 함께 확인한다.

### 17.5 tier 게이팅

executor를 2회 부르는 것은 비용이 2배다. `simple`/`fast`에서 켜지면 13.1절이 측정한 비용 절감이 사라진다.

**게이트는 축이 둘이다 — 한동안 하나로 보고 있었다.** 종전 문장은 *"`complexityTier`가 4단계로 확장되면 `verified` 이상에서만 켠다. 현재의 2단계에서는 `standard`가 그 자리다"* 였고 구현도 tier만 봤다. 그런데 `standard`는 **두 경로에서 나온다**:

- 사용자가 `executionMode: "verified"`를 골랐다 → TRIAGE와 무관하게 언제나 `standard`
- 사용자가 `fast`인데 **TRIAGE 규칙이** `standard`로 분류했다

둘째 경우에도 대조가 켜져 executor 호출이 2배가 되고 있었다 — 이 절이 금지한 바로 그 상황이다. `fast`는 사용자가 **싸게 가겠다고 고른 것**이고, 규칙이 "이 태스크는 어렵다"고 본 것은 교차검증(executor 1 + reviewer 1)을 켜는 근거이지 executor를 하나 더 부르는 근거가 아니다.

그래서 **둘 다 요구한다**: tier가 `standard`이고 **동시에** `executionMode`가 `verified`일 때만 대조를 켠다. 규칙이 켜는 것과 사용자가 켜는 것을 갈라둔 것이며, tier가 4단계로 확장되어도 이 분리는 그대로다.

라우터가 독립적인 두 executor를 배정하지 못하면 — 5절 불변식과 같은 처리다 — **같은 공급자로 두 번 부르지 않는다.** 대조 자체를 드롭하고 사유를 `RoutingDecision.appliedPolicies`에 남긴다([multi-engine-routing.md 13절](./multi-engine-routing.md)). 같은 모델을 두 번 부른 "불일치 없음"은 정보가 아니라 착시다.

### 17.6 이 설계가 만들지 않는 보장

- **일치는 검증이 아니다.** 두 초안이 모든 필드에서 일치해도 둘 다 틀렸을 수 있다(상관된 오류, 9.2-B). `agreedFields`를 UI에서 초록색 체크로 그리면 안 된다.
- **사용자 판정이 옳다는 보장은 없다.** 우리가 보장하는 것은 판정이 *기록되고 이후 단계가 그것을 참조한다*는 것뿐이다.
- **`VERIFYING`을 대체하지 않는다.** 사용자는 의도의 오라클이지 결과의 오라클이 아니다(16.1절).

### 17.7 17.3절 구현에서 정해진 것 (M1)

세 구멍(사용자 답변 승격 / 감사 추적 / 최종 보고가 기준 참조)을 구현하면서 문서가 미리 정하지
못했거나 **틀리게 정해둔** 것이 네 가지 드러났다. 상태는 하나도 늘지 않았고(17.1절 그대로),
대조 로직·`DisagreementReport`·co-executor 배정은 아직 들어오지 않았다.

**① 비밀값 필터 — 16.7절을 "그대로 적용"할 수 없었다.**

17.3절은 "비밀값 필터(16.7절)는 그대로 적용된다"고 적었으나 그럴 수 없다. 16.7절 필터는
**경로 이름** 판정이고, 그 절 자체가 "내용 기반 탐지는 원리적으로 불완전하고 통과했을 때
잘못된 확신을 준다"를 **명시적 결정**으로 적어두었다. 사용자 답변에는 경로가 없으므로 적용할
대상이 없다.

선택지는 셋이었다.

| 안 | 결과 |
|---|---|
| 원문을 통째로 버린다 | 판정자의 판정이 감사 로그에서 **다시 사라진다** — 이번 작업이 고치려던 구멍 그 자체 |
| 원문을 그대로 남긴다 | 알려진 모양조차 막지 않는다. 붙여넣은 토큰이 DB에 영구히 박힌다 |
| **알려진 모양만 가린다** (채택) | 완결되지 않지만, 위 둘보다 낫다 |

채택안은 `policy/secrets.rs`의 `mask_secret_shapes`다. **경로 판정을 대체하지 않으며**, 경로가
없는 자유 텍스트에만 쓰는 별도 완화다. 16.7절의 "내용 기반 탐지를 하지 않는다"는 판단은
그대로 유효하다 — 이 함수는 **"검사했으니 안전하다"를 주장하지 않기 때문에** 그 판단과
충돌하지 않는다. 그래서 마스킹 **개수**(`secretShapesMasked`)를 이벤트에 남긴다.
그 수가 말하는 것은 "가린 것이 있었다"이지 "남은 것이 없다"가 아니다.

적용 범위를 `USER_DECISION_RECORDED` 하나로 좁힌 것도 결정이다. 모든 이벤트에 걸면
`DRAFT_RECEIVED.patch`처럼 **원문 그대로여야 의미가 있는** 기록이 변형되고, 그러면 감사 로그의
patch가 실제 적용된 patch와 달라져 감사에 쓸 수 없게 된다.

마스킹은 **Rust에서** 일어난다. Node가 가리고 보내주기를 기대하면 장악당한 Node에서 그 규칙이
사라진다(2번 원칙). Node는 원문을 보내고, 저장 직전 Rust가 가린 뒤 DB와 UI 릴레이 **양쪽**에
가려진 값을 보낸다.

**이 절은 위험을 절반만 봤다.** 마스킹은 저장 직전에 도는 것이라 감사 로그만 지키고, 같은
답변이 프롬프트에 실려 모델 공급자로 나가는 것은 막지 못한다. 그 절반은 17.11절에서 다룬다.

**② 파생 캐시를 갱신하는 유일한 경로 — payload가 실어 나른다.**

`acceptance_criteria`는 파생 캐시이므로 "이벤트 없이 이 테이블만 갱신하는 경로를 만들지 말 것"이
17.3절의 규칙이었다. 그것을 **주석이 아니라 구조로** 강제한다: 테이블을 쓰는 코드가
`append_event`의 트랜잭션 안에 한 곳뿐이고, 재료는 이벤트 payload의 `acceptanceCriteria` 키로만
들어온다. `tasks.counters_json`이 `payload.counters`로 갱신되는 기존 규칙과 같은 모양이다.

그래서 `record_*_with_event` 계열 메서드를 **새로 만들지 않았다** — 그 계열은 `append_event`를
우회하므로 sink 릴레이가 빠지고, "DB엔 남는데 화면엔 안 보이는" 누락을 다시 만든다.

**③ 철회된 해석은 대체한다 — `acceptanceCriteriaReplaces`.**

재질문 왕복 뒤 새 초안이 오면 이전 초안의 `doneCriteria`는 **철회된 해석**이다. 그대로 쌓으면
최종 보고가 아무도 지지하지 않는 기준을 사용자에게 보여준다. payload에
`acceptanceCriteriaReplaces: "draft_proposal"`이 있으면 그 source의 행을 먼저 지운다.

**파생 캐시를 지우는 것은 append-only 규칙과 충돌하지 않는다** — 지워지는 것은 캐시이고,
대체가 일어났다는 사실 자체는 그 이벤트로 로그에 남는다. `tasks.phase`가 덮어써지는 것과 같다.
대상이 source별인 이유는 권위가 다르기 때문이다: 모델 산출물은 `user_decision`을 덮을 수 없다.

**④ "미확인"을 타입 수준에서 굳혔다.**

`AcceptanceCriterion`에 충족 여부 필드를 두지 않았다. 필드가 있으면 언젠가 누군가(십중팔구
모델이) 그것을 채우게 되고, 그 순간 미확인이 확인으로 둔갑한다. 확인된 기준이 0개라는 사실은
"`verified: false`"가 아니라 **"그런 필드가 없음"**으로 표현된다. 기준↔테스트를 자동으로 잇는
방법이 생기면 그때 필드를 추가하는 것이 옳은 순서다(12절 미해결 항목).

최종 보고 요약과 3.10절 화면 둘 다 "기준 N개 중 확인된 것 0개 · N개 미확인"을 말한다.
기준이 하나도 없으면 그 문장을 **넣지 않는다** — 없는 것을 "0개 확인됨"으로 말하면 있었는데
전부 실패한 것처럼 읽힌다.

**`USER_MESSAGE_RECEIVED`는 지우지 않았다.** 답변 한 번에 이벤트가 둘 생기지만 역할이 다르다 —
`USER_MESSAGE_RECEIVED`는 "답변이 도착했다"는 신호(UI가 질문 카드를 닫는 데 쓴다)이고,
`USER_DECISION_RECORDED`가 **판정의 기록**이다. 감사 로그의 의미는 후자가 지고, 전자는
`answerLength`만 남기던 원래 역할 그대로다. 저장된 로그의 이벤트 타입을 없애면 기존 DB의
타임라인 해석이 바뀌므로, 역할이 겹치지 않는 한 지우지 않는다.

~~**아직 발행하지 않는 이벤트.** `DISAGREEMENT_DETECTED`는 타입만 추가하고 아무도 발행하지 않는다.~~
→ 대조 로직 구현과 함께 발행된다(17.8절).

### 17.8 대조 로직과 3.9절 카드 구현에서 정해진 것 (M1)

`contrastDrafts`(순수 함수) + co-executor 배정 + 3.9절 카드를 구현하면서 문서가 정하지 못했던
것들이다. 상태는 여전히 하나도 늘지 않았고, **전이는 하나 늘었다**(`DRAFTING → AWAITING_USER_INPUT`,
17.1절).

**① 살아남는 초안은 primary다 — 사용자 선택으로 고르지 않는다.**

13.3절이 "살아남지 않은 쪽 초안의 저자"를 말하므로 어느 초안이 살아남는지를 정해야 했다.
사용자가 고른 선택지의 `fromProposalId`를 따라가는 방법을 검토했고 **기각했다**: 쟁점이 여럿일 때
사용자가 A 초안의 답과 B 초안의 답을 섞어 고를 수 있고, 자유 입력이면 어느 쪽도 아니다.
"과반이 나온 쪽"류의 규칙을 만들면 그건 우리가 지어낸 판정이 된다.

채택: **사용자 답변 후 항상 DRAFTING으로 재진입하고**(14.1절 기존 규칙), 재초안의 primary가
살아남는다. 판정은 초안을 고르는 데 쓰이지 않고 `acceptanceCriteria`로 고정되어 **다음 초안의
입력**이 된다. 사용자가 고른 것은 "어느 초안"이 아니라 "어느 요구"이므로 이게 더 정확하다.

**② 기준은 primary 초안에서만 흡수한다.**

두 초안의 `doneCriteria`를 모두 흡수하면, 사용자가 방금 갈렸다고 답한 그 두 해석이 나란히 기준
목록에 들어가 서로 모순된다. 대조의 산출물은 기준이 아니라 **질문**이고, 기준이 되는 것은
사용자의 답이다.

**③ 예산 초과는 실패가 아니다 — 두 자리에서.**

17.4절의 "예산을 소진해도 곧장 FAILED 하지 않는다"를 두 경로에 적용했다:
한 카드에 담을 수 있는 수(4개)를 넘긴 쟁점과, `clarificationRounds` 상한에 걸려 아예 묻지 못한
쟁점. 둘 다 `unresolvedDisagreements`에 남고 최종 요약이 "묻지 못한 쟁점 N건"을 말한다.
카드에 띄웠는데 답이 오지 않은 항목도 같은 자리에 들어간다.

**④ 자유 입력이 가장 값진 신호다.**

`USER_DECISION_RECORDED`에 `freeform: true`를 남긴다. 선택지를 고르지 않았다는 것은 **두 초안이
모두 틀렸다**는 뜻이고, 14절 지표("불일치 1건당 사용자가 뒤집은 비율")가 재려는 것이 정확히
그 빈도다. 이걸 남기지 않으면 "두 초안 중 하나가 맞았다"와 구별되지 않는다.

**⑤ 대조를 켜는 결정은 라우터가 하지 않는다.**

라우터의 `decide()`가 `contrast` 인자를 받는다. 켜면 LLM 호출이 3회가 되므로(13.4절) 이건 비용에
관한 결정이고, 그 근거(tier, 실험 하네스 여부)는 라우터가 모른다. 라우터는 **배정 가능성**만
판단한다 — 독립 공급자가 없으면 `contrast_dropped`를 남기고 드롭한다.

실험 하네스에서는 기본이 꺼짐이다(`ExperimentControls.contrast`). arm을 고정해 비교하는데 호출이
하나 더 생기면 그 차이가 arm 때문인지 대조 때문인지 구별되지 않는다.

**⑥ `requiredTests` blocking 규칙은 현재 사실상 무조건이다.**

17.4절은 "`verified` 이상에서 blocking"이라 적었고 17.5절은 "현재의 2단계에서는 `standard`가
그 자리"라고 적었다. 그런데 **대조 자체가 `standard`에서만 돌므로** 이 조건은 지금 언제나 참이다.
조건을 지우지 않은 이유는 tier가 4단계로 늘어날 때 되살아나야 하는 규칙이기 때문이다 —
지우면 그 사실 자체가 잊힌다. 지금은 "대조가 돌면 검증 항목 이견도 묻는다"로 읽으면 된다.

**⑦ 병렬 호출이 터미널 가드를 깨뜨렸다 (실측).**

두 실행자를 `Promise.all`로 부르자 취소 시 `TASK_CANCELLED`가 **두 번** 기록됐다. `finish()`가
`terminalReached`를 검사한 뒤 `await`를 하고 나서 플래그를 세웠기 때문이다. JS는 단일
스레드지만 `await`가 곧 양보 지점이므로, 검사와 표시 사이에 `await`가 있으면 동시 호출이 둘 다
통과한다. 플래그를 `await`보다 먼저 세우도록 고쳤다. **동시에 진행되는 공급자 호출이 처음
생겼기 때문에 드러난 결함**이고, 앞으로 병렬 호출을 늘릴 때 같은 종류를 먼저 의심할 것.

**⑧ fake provider에 모델별 스크립트가 필요했다.**

`FakeProviderOptions.script` 하나로는 대조를 테스트할 수 없다 — 어댑터 인스턴스가 둘이라 커서도
따로이고, 둘 다 스크립트를 처음부터 소비해 **언제나 같은 초안**이 나온다. 실측으로 그렇게 대조
테스트가 조용히 통과했다. `scriptByModel`을 추가했고, `proposalId`에도 모델 ID를 넣었다
(둘 다 cursor가 1이라 id가 겹쳐 `positions`의 출처 추적이 깨졌다).

### 17.9 기준이 참조되는 자리 — PLANNING / VERIFYING (M1)

17.3절 규칙 1·2의 구현이다. 규칙 3(`FinalResult`)은 17.7절에서 이미 닫혔다.

**① 자동 판정은 두 가지 사실에만 기댄다.**

기준은 자유 문장이라 "이 patch가 이 문장을 만족하는가"는 일반적으로 판정할 수 없다.
판정하려면 모델을 불러야 하고 그건 product-strategy 9절의 순환 의존이다. 결정론적으로 이을 수
있는 것은 둘뿐이다.

| 무엇 | 어떻게 | 결과 |
|---|---|---|
| **위치** | 기준 문장이 지목한 **실재하는** 경로 ↔ 계획이 바꾸는 경로 | `CONFLICTS_WITH_CHANGE` |
| **테스트** | 기준 문장이 지목한 **실재하는** 테스트 파일 ↔ Rust 리포트의 `test` 체크 | `VERIFIED_BY_TEST` / `CONTRADICTED_BY_TEST` |

그 밖에는 전부 `UNVERIFIED`이며 **실제로 대부분이 여기다.** 상태를 4값으로 나눈 것은
`VerificationStatus`를 3값에서 5값으로 늘린 것과 같은 이유다 — "확인하지 못했다"를 "충족했다"로도
"위반했다"로도 뭉개지 않기 위해서다.

**② `test`가 통과했다는 것만으로 확인을 주장하지 않는다 (fail-closed).**

기준이 `validate.test.ts`를 지목했고 `test` 체크가 통과해도, **러너가 그 파일을 포함하지 않았을
수 있다.** 그러면 "통과"는 그 기준과 아무 상관이 없다. 그래서 검증 출력에 그 파일이 나타났는지를
함께 확인하고, 출력을 얻지 못하면 확인이 아니라 미확인으로 떨어진다.

확인을 넓게 잡으면 화면이 초록색으로 덮이는데, 그 초록색은 우리가 파는 것을 파는 행위다.
좁게 잡으면 화면이 물음표로 덮이고 그건 그냥 현재 상태의 정직한 표시다.

**③ 테스트 파일은 변경 대상이 아니라 근거다 (실측).**

위치 충돌 규칙을 처음 구현했을 때 "빈 문자열을 거부한다 (validate.test.ts:41)" 같은 기준이
**전부 충돌로 잡혔다.** 근거로 적은 테스트 파일을 "여기를 고쳐라"로 읽었기 때문이다. 충돌 판정에서
테스트 파일 경로를 제외했다 — 근거를 적은 기준이 정상 작업을 막으면 기준을 적지 않는 편이
유리해지고, 그건 정확히 반대 방향의 유인이다.

**④ 충돌은 FIX_LOOP가 아니라 재요청이다.**

17.3절이 그렇게 정한 이유를 코드로 옮기면: FIX_LOOP의 전제는 "적용된 변경을 검증 결과를 근거로
고친다"인데 이 시점에는 **아직 아무것도 적용되지 않았다.** 실행 후 예산(`fixLoopRounds`)을 실행
전 문제에 쓰면 정작 검증이 실패했을 때 쓸 예산이 줄어든다. 그래서 실행 전 합의 실패의 예산인
`reviseRounds`를 쓰고 초안 단계로 되돌아간다(전이 `PLANNING → DRAFTING`/`SINGLE_MODEL_FIX` 추가,
상한은 그대로라 새 무한 루프는 없다).

**단, 이미 fix loop 안이라면 되돌리지 않는다.** 초안을 만든 근거인 스냅샷이 낡았기 때문이다.
그때는 결정론적 사실을 근거로 다시 요청하는 FIX_LOOP 경로가 맞다.

**⑤ 재요청 예산을 소진해도 실패시키지 않는다.**

이 충돌 판정은 문자열 대조 기반의 좁은 규칙이라 틀릴 수 있다. 휴리스틱으로 태스크를 죽이는 것이
잘못된 계획을 **표시하고** 진행하는 것보다 낫다는 보장이 없다. 대신 기준 판정에
`CONFLICTS_WITH_CHANGE`로 남아 최종 보고와 3.10절 화면에 그대로 나온다.

**⑥ 판정은 기준 타입에 넣지 않고 별도 배열로 둔다.**

`FinalResult.criterionEvaluations`를 추가했다(17.2절이 정한 두 필드에 더해서). 기준은 사용자가
확정한 **사실**이고 판정은 매 검증마다 다시 계산되는 **파생값**이다. 한 타입에 섞으면 "사용자가
정한 것"과 "우리가 계산한 것"의 경계가 흐려지고, 언젠가 모델이 그 필드를 채우게 된다.

**⑦ 프롬프트에도 기준을 넣지만, 그게 강제력은 아니다.**

executor와 reviewer 프롬프트에 `user_decision` 기준을 "반박 불가"로 따로 렌더링한다. 모델 제안과
한 목록에 섞으면 둘 다 참고 사항으로 읽히는데 권위가 다르기 때문이다. 다만 **프롬프트는 요청이지
보장이 아니다** — 그래서 PLANNING 게이트가 따로 있다. 넣지 않으면 강제할 대상조차 없다는 것이
넣는 이유이지, 넣었으니 됐다는 뜻이 아니다.

검수자 프롬프트가 바뀐 것은 17.1절 표의 세 번째 행("사용자가 고정한 `acceptanceCriteria`가
반영됐는지 확인")이 실체를 얻은 것이다.

**⑧ 판정은 저장 테이블에 두지 않는다.**

`acceptance_criteria` 테이블에 판정 컬럼을 붙이지 않았다. 기준은 확정되면 바뀌지 않는 사실이고
판정은 매 검증마다 다시 계산되는 파생값이라, 같은 테이블에 두면 "어느 시점의 판정인가"가
모호해진다. 판정은 `CRITERIA_EVALUATED` 이벤트로만 남고, 지난 작업 화면은 **마지막 이벤트를
재생해** 복원한다 — 이벤트가 진실의 원천이라는 규칙(7번 원칙)이 여기서도 그대로 적용된다.

### 17.9.1 `?`가 대부분인 이유 — 잇지 못해서가 아니라 실재 판정이 틀려서 (M1)

ui-wireframes 5절 미해결은 이렇게 적혀 있었다: *"어떤 테스트가 어떤 기준을 확인했는지 자동으로
잇지 못하는 경우가 대부분일 때 화면이 `?`로 뒤덮이는 문제."* 그리고 표시만 다듬는 것은 문제를
감추는 쪽이라고 함께 적어두었다. 그 판단은 맞았지만, **전제가 틀렸다.**

`?`의 상당수는 이을 근거가 없어서가 아니라 **"이 파일이 실재하는가"에 우리가 잘못 답해서**였다.
판정이 실재의 정본으로 삼던 것은 `CriteriaContext.workspaceFiles`인데, 거기 담기던 값은
`snapshot.relevantFiles` — **토큰 예산이 고른 부분집합**이다. 그래서 세 경우가 구조적으로 언제나
미확인이었다.

| 경우 | 왜 언제나 미확인이었나 |
|---|---|
| 예산에 밀려 스냅샷에서 빠진 테스트 | 실재하는데 목록에 없다 |
| **이번 변경이 새로 만든 테스트** | 스냅샷은 패치 **이전**에 찍힌다 — 가장 확인되기 쉬운 경우가 구조적으로 확인 불가였다 |
| 러너가 실제로 실행한 테스트 | 실행됐다는 가장 강한 증거를 들고 왔는데, 목록에 없다는 이유로 버렸다 |

게다가 화면 문장이 **거짓이었다**: "기준이 지목한 테스트 파일이 워크스페이스에 없어 근거로 쓸 수
없습니다." 우리가 아는 것은 "우리 목록에 없다"뿐이다.

**고친 것 셋.**

**① 실재의 정본을 인덱스로 옮긴다.** `workspaceFiles` → `knownFiles`로 이름을 바꾸고 네 곳을
합친다 — 인덱스의 파일 목록, 인덱스가 하드 필터로 제외한 목록, 스냅샷이 예산에 밀려 뺀 목록,
이번 변경이 건드린 경로. 뒤의 셋은 **제외·변경 자체가 존재의 증거다** — 없는 파일은 제외할 일도
변경할 일도 없다. 이름을 바꾼 이유는 잘못된 이름이 잘못된 판정을 불렀기 때문이다.

**② "없다"를 "모른다"로 정정한다.** 인덱스에도 상한(`maxIndexedFiles`)이 있으므로 목록에 없다는
것이 부재의 증명이 되지 못한다. 집계 코드 `test_reference_not_found`를
**`test_reference_unresolved`로 바꿨다.** 코드는 문구가 바뀌어도 과거와 이어지라고 둔 것이지만,
이 이름은 **단언을 포함하고 있었다** — 그대로 두면 커버리지 집계를 읽는 사람이 "모델이 이름을
지어낸다"로 읽고 고칠 자리를 잘못 찾는다. 뜻이 바뀌었으면 이름도 바뀌어야 한다.

**③ 러너의 실행 증거를 실재 증거로 쓴다.** `test` 체크의 argv와 출력에 그 파일이 나타났다면 그
파일은 실재하고 실행됐다. 목록 조회보다 **강한** 근거다.

**이건 "잇는 규칙을 넓히는 것"이 아니다.** `metrics`의 열린 질문이 경고하는 (b)는 *증거의 기준을
낮추는 것*이고, 그 경고는 유효하다. 여기서 바뀐 것은 증거의 기준이 아니라 **실재 판정의 오류**다.
넘어야 할 문턱은 그대로다: 이름을 지목했고, 그 파일이 실행됐다는 근거가 있고, `test` 체크가
통과해야 `✓`다. 실행 근거가 없으면 파일이 실재해도 여전히 미확인이라는 것을 테스트가 고정한다.

**부수 효과 하나를 적어둔다.** ①은 PLANNING 위치 충돌 게이트에도 적용되므로, 스냅샷에 안 실렸다는
이유로 **조용히 넘어가던 충돌이 이제 잡힌다.** 재요청이 늘 수 있다. 그건 규칙이 세진 것이 아니라
지금까지 못 보던 것을 보게 된 것이며, 오탐률은 이미 `criteriaConflict` 집계가 재고 있다.

**④ `requiredTests`를 버리지 않는다.** 이 필드는 대조 가능 필드라 두 초안이 **갈리면** 쟁점이 되어
사용자의 답이 기준이 되는데, **합의하면 아무 데도 실리지 않고 사라졌다.** 합의는 검증이 아닌데
(17.6절) 합의한 요구만 없어지는 것은 거꾸로다. 그리고 이 필드는 기준↔테스트 연결의 재료 그
자체다 — 모델이 "무엇이 확인되어야 하는가"에 답한 유일한 자리이고 답은 대개 테스트 파일
이름이다. `doneCriteria`와 같은 자리에서 `draft_proposal` 기준으로 흡수한다(17.3절 구멍 1과 같은
모양의 구멍이었다). 이것은 열린 질문이 권하는 **(a) 기준을 적을 때 테스트를 함께 적게 한다**에
해당한다.

**남는 것은 여전히 남는다.** `doneCriteria`가 테스트를 언급하지 않는 경우
(`no_test_reference`)는 이 셋 어느 것으로도 줄지 않는다. 그건 잇는 쪽의 문제가 아니라 **기준을
적는 방식**의 문제이고, 실제 비율은 `metrics`의 `coverage.by_code`가 실사용에서 답한다.

### 17.10 두 지표를 실제로 셀 수 있게 만들기 (M1)

12절이 연 두 질문 — "기준↔테스트를 **얼마나** 이을 수 있는가", "위치 충돌 규칙이 **쓸모 있는가**" —
은 집계로만 답할 수 있다. 이벤트는 이미 쌓이고 있었지만 그 이벤트로는 답이 나오지 않았다.
이 절은 **무엇을 더 남겨야 답이 나오는가**를 정한 기록이다.

**① 사유를 코드로 남긴다 — 집계가 한국어 문장을 파싱하지 않도록.**

`CriterionEvaluation.reason`은 화면에 그대로 보여줄 한국어 문장이다. 집계가 그걸 파싱하면
**문구를 다듬는 순간 과거 데이터와 끊긴다.** 그래서 `code`를 따로 둔다.

특히 `UNVERIFIED`를 한 덩어리로 두면 답이 나오지 않는다. `no_test_reference`(기준 문장에 테스트
이름이 아예 없음)와 `no_run_evidence`(이름은 있고 통과했는데 실행 근거가 없음)는 **고쳐야 할 곳이
서로 다르다** — 전자는 기준을 적는 방식의 문제이고 후자는 잇는 규칙의 문제다. 뭉쳐서 "커버리지
20%"만 보면 어느 쪽도 고칠 수 없다.

`test_reference_unresolved`(이름은 있는데 아는 목록에서도 검증 출력에서도 못 찾음)를 따로 둔 것도
같은 이유다. 그건 커버리지 실패가 아니라 **"근거를 확인하지 못하면 쓰지 않는다"는 규칙이 작동한
것**이므로, 실패로 세면 규칙을 느슨하게 만들 유인이 생긴다.

~~이 코드의 이름은 `test_reference_not_found`였고 설명은 "지어낸 파일 이름"이었다~~ →
**17.9.1절에서 바꿨다.** 우리는 그 파일이 없다는 것을 알 수 없으므로(인덱스에 상한이 있다)
그 이름은 우리가 아는 것보다 많이 말하고 있었고, 그 초과분이 곧 잘못된 처방으로 이어진다.

**② 충돌은 감지가 아니라 결말을 세야 한다.**

`CRITERIA_CONFLICT_DETECTED`만 있으면 "충돌이 몇 번 났는가"밖에 셀 수 없는데, 우리가 묻는 것은
"그 충돌이 쓸모 있었는가"다. 그래서 `CRITERIA_CONFLICT_RESOLVED`를 따로 둔다 — 결말은 **다음
라운드에야 정해지므로** 한 이벤트에 담을 수 없다(담으려면 미래를 알아야 한다).

**결말이 빠짐없이 남아야 한다.** 재요청 뒤 계획 단계에 다시 도달하지 못한 채 태스크가 끝나는
경우(거부·취소·실패)를 위해 `task_ended_before_replan`을 뒀다. 이게 없으면 그런 충돌은 결말 없이
사라지고, 집계가 "감지 N건, 결말 M건(M<N)"이 되어 차이가 어디서 났는지 알 수 없다. 더 나쁜 것은
**그 차이가 하필 실패한 태스크에 몰려 있으면 지표가 낙관 쪽으로 휜다**는 점이다.

**③ "오탐률"이라는 이름을 쓰지 않는다.**

12절 항목은 "오탐률"이라고 적었지만 그 값은 **관측할 수 없다.** 충돌이 진짜 잘못된 계획을
잡았는지의 정답은 사용자만 알고, 사용자는 매번 판정해주지 않는다. 관측 가능한 것은 셋뿐이다:

| 결말 | 뜻 |
|---|---|
| `plan_changed_to_expected` | 재요청 뒤 계획이 사용자가 지목한 파일을 건드리게 바뀌었다 |
| `plan_unchanged` | 재요청했는데도 여전히 다른 곳을 고친다 |
| `proceeded_without_change` | 예산을 소진해 충돌을 안은 채 진행했다 |

이름을 추론이 아니라 **일어난 일 그대로** 붙인 이유: 지표 이름이 추론을 포함하면 집계를 읽는
사람이 그 추론을 사실로 읽는다. `proceeded_without_change`인데 태스크가 통과했다는 것도 오탐의
증거가 아니라 정황이다 — 사용자가 지목한 곳을 고치지 않고도 기존 테스트는 통과한다.

**④ 집계는 Rust에 둔다.**

DB는 Rust의 것이다(process-architecture.md 2절 — Rust가 유일한 writer이고 Node는 DB에 직접
접근하지 않는다). 집계는 읽기 전용이지만 Node가 SQLite 파일을 직접 열기 시작하면 그 경계가
흐려진다. `tomverse-host metrics`가 GUI 없이 돌고 e2e가 실제 DB로 검증한다.

**⑤ 집계는 태스크당 마지막 판정만 센다.**

fix loop를 돌면 `CRITERIA_EVALUATED`가 여러 번 나온다. 전부 세면 **재시도가 많은 태스크가 집계를
좌우**하고, "기준 하나가 어떻게 끝났는가"라는 질문의 답이 아니게 된다. 중간 판정은 로그에 그대로
남아 "도중에 무엇이 확인/반증됐는가"를 볼 수 있다.

같은 이유로 `list_tasks`(UI용, 상한 200)를 쓰지 않고 별도 조회를 뒀다. 집계에 상한이 걸리면 오래된
태스크가 조용히 빠지는데, **표본이 잘렸다는 것을 모르는 지표는 틀린 답을 자신 있게 말한다.**

**⑥ 지금 이 지표들은 전부 0에 가깝다.** 실사용 데이터가 없기 때문이다. 계측을 먼저 붙인 이유는
14절이 이미 적어둔 것과 같다 — 나중에 붙이면 그 사이의 데이터를 통째로 잃는다.

**⑦ 같은 집계에 취소 소요 분포가 붙었다.** 12절의 "강제 포기 노출 시점의 근거"도 형태가 같은
질문이라 같은 자리에 둔다(16.3절). 다만 앞의 두 지표와 결정적으로 다른 점이 하나 있다:
**이 지표는 제품 동작에 되먹임된다.** 커버리지 숫자는 사람이 읽고 판단할 재료지만, 취소 분포는
탈출구가 뜨는 시점을 직접 정한다. 그래서 이 지표만 "무엇을 표본에서 빼는가"가 정확성이 아니라
**안정성** 문제가 된다 — 강제 포기를 표본에 넣으면 임계값이 스스로를 키우는 되먹임이 생긴다.

**⑧ `plan_unchanged`는 한 덩어리로 두면 답이 나오지 않는다.**

"재요청했는데 계획이 그대로다"에는 **원인이 둘 섞여 있고, 고칠 곳이 서로 다르다.**

| 해석 텍스트 | 읽는 법 | 고칠 곳 |
|---|---|---|
| 그대로 | 모델이 피드백을 반영하지 않은 쪽에 가깝다 | 프롬프트 |
| 달라짐 | 읽고도 같은 곳을 고르겠다고 했다 | 게이트가 잡은 것이 실제 문제였는지 |
| 비교 불가(`null`) | 재요청 자체가 없었다(예산 소진·태스크 종료) | — |

비율만 보면 이 둘이 뭉쳐 "게이트가 예산만 쓴다"로도 "모델이 말을 안 듣는다"로도 읽히는데,
그 둘은 같은 숫자로 구별되지 않는다. 그래서 `CRITERIA_CONFLICT_RESOLVED`의 결말마다
`interpretationTextChanged`를 함께 남긴다.

**이름이 `text`인 이유**: 우리가 관측할 수 있는 것은 문자열이 달라졌다는 사실뿐이다. 같은 말을
다시 쓴 것도 변경으로 잡히고, 다른 말로 같은 오해를 반복한 것도 변경으로 잡힌다. 의미가
바뀌었는지는 또 하나의 모델 호출이고(17.8절), 잰 것을 그대로 부르는 것이 ③과 같은 규칙이다.

**`null`을 `false`로 뭉개지 않는다.** 재요청이 없었던 결말(`proceeded_without_change`,
`task_ended_before_replan`)에 `false`를 쓰면 "다시 물었는데 해석이 그대로였다"로 읽히는데,
다시 묻지도 않았다. 재요청조차 못 한 것과 재요청했는데 그대로인 것은 다른 사실이다.

분해는 **`plan_unchanged`에만** 붙인다. 계획이 바뀐 건에도 세면 "해석이 바뀌었다"가 두 결말에
걸쳐 세어져, 원인을 가르려던 분해가 다시 뭉개진다. 집계는 분해의 합이 `plan_unchanged` 개수와
같은지를 테스트로 지킨다 — 어긋나면 어느 쪽이 맞는지 알 수 없다.

그리고 이 분해는 **재료이지 판정이 아니다.** 어느 칸이 크든 "규칙이 틀렸다"의 증거는 아니고,
사람이 다음에 무엇을 볼지 정하는 데 쓴다.

**⑨ 카드 답변은 자리별로 세야 상한 4를 물을 수 있다.**

한 카드 질문 상한 4는 3.9절 화면 설계에서 나온 값이고 실측이 아니다(12절). 그 값을 의심하려면
"아래쪽 질문이 그럴듯하면 아무거나 눌리는가"를 물어야 하는데, 지금 남는 기록으로는 물을 수
없었다 — 무엇을 골랐는지는 남지만 **그것이 카드에서 몇 번째였는지**가 없었다.

그래서 `USER_DECISION_RECORDED`에 `cardSize`와, 결정마다 `cardPosition`·`optionRank`를 남긴다.
`cardSize`를 결정 개수로 추론하지 않는 이유: 답이 오지 않은 항목이 있으면 둘이 달라지고,
스크롤이 생기는지를 정하는 것은 **띄운 개수**다.

**첫 선택지를 골랐다는 것은 부주의의 증거가 아니다.** 그 선택지가 맞았을 수도 있다. 그래서
집계 이름이 `careless`가 아니라 `firstOption`이다(③과 같은 규칙).

이 집계를 쓸 수 있게 만드는 것은 **한 카드 안에서 자리끼리 비교한다**는 점이다. 선택지 1번은
언제나 primary 실행자의 값이라 자리와 무관하게 한쪽으로 치우칠 수 있는데, **그 치우침은 한
카드 안의 모든 질문에 똑같이 걸린다.** 따라서 자리에 따라 비율이 달라지면 그건 모델 품질이
아니라 자리 때문이다. 그것이 "아래쪽은 대충 눌린다"는 가설이 예측하는 모양이고, 상한 4를
물을 수 있는 유일한 관측이다.

3.4절 확인 필요 카드(모델이 스스로 모호하다고 말한 경우)는 **다른 화면**이라 자리가 없다.
집계에 섞지 않는다 — 섞으면 자리 없는 답이 전부 `unknown`으로 쌓여 자리별 비율의 분모가
부풀려진다.

그리고 이것도 **신호이지 판정이 아니다.** 비율이 자리에 따라 올라간다고 상한 4가 틀렸다는
증명은 아니다. 사람이 다음에 무엇을 볼지 정하는 재료다.

**⑩ 랭킹을 튜닝하려면 필드별로 세야 한다.**

`DISAGREEMENT_FIELD_RANK`의 순서(`doneCriteria` > `targetPaths` > `requiredTests`)는 추정이고,
14절이 그 조정 근거로 지목한 것은 "불일치 1건당 사용자가 뒤집은 비율"이다(12절). 그런데 그
비율을 **필드별로** 낼 방법이 없었다 — 무엇을 골랐는지는 남았지만 그것이 어느 필드의 쟁점
이었는지가 없었다.

그래서 결정마다 `field`를 남기고, 집계가 `byField`로 쪼갠다. **id에서 파싱하지 않는다**
(`disagreementId`가 필드 이름을 담고 있긴 하다) — id 형식을 바꾸는 순간 집계가 조용히 끊기고,
끊긴 집계는 0으로 보인다.

| 답 | 뜻 |
|---|---|
| `pickedPrimary` | 선택지 1번, 즉 **아무것도 묻지 않았어도 적용됐을 값**을 골랐다 |
| `pickedOther` | 다른 초안의 값을 골랐다 — 물어서 실제로 달라졌다 |
| `freeform` | 둘 다 아니라 직접 적었다 — **두 초안이 모두 틀렸다**는 가장 강한 신호 |

**`pickedPrimary`가 많다고 그 질문이 쓸모없었다는 뜻은 아니다.** 사용자가 확인해준 것이고 확인은
공짜가 아니다. 그래서 이름이 `wasted`가 아니다(③과 같은 규칙). 랭킹 조정에 쓸 수 있는 것은
**필드끼리의 비교**다 — 어떤 필드가 다른 필드보다 자주 뒤집히는가.

⑨의 자리별 집계와 **축이 다르다.** 자리는 "화면의 어디에 있었나", 필드는 "무엇을 물었나"다.
한 축으로 합치면 비율을 움직인 것이 위치인지 내용인지 알 수 없는데, 랭킹이 튜닝해야 하는 것은
내용 쪽이다. 두 집계의 합계가 서로 같은지를 테스트로 지킨다 — 어긋나면 한쪽이 답을 흘리고 있다.

선택지 1번이 언제나 primary 실행자의 값이라는 점은 ⑨에서와 같은 편향을 만들지만, 여기서도
**한 카드 안의 필드끼리 비교**하면 그 편향이 상쇄된다(같은 primary 모델이 모든 필드에 걸린다).

### 17.11 나가는 것은 마스킹으로 막을 수 없다 — 보내기 전에 알린다 (M1)

12절 미해결이었다: "`mask_secret_shapes`는 알려진 접두사만 안다. 목록을 늘려도 완결되지 않는다.
근본 해법(입력 시점에 되묻기)은 UI 작업이라 미뤘다."

**구현하면서 17.7①의 위험 평가가 틀렸다는 것이 드러났다.** 거기서는 문제를 "붙여넣은 토큰이
DB에 영구히 박힌다"로 적었다. 그건 문제의 절반이다. 사용자 답변은 `userAnswers`로 **다음
프롬프트에 그대로 실려 모델 공급자에게 나간다.** 마스킹은 저장 직전에 도는 것이라 감사 로그만
지키고, 나가는 것은 조금도 막지 않는다. 그리고 나간 것은 우리가 되돌릴 수 없다.

그래서 입력 시점 경고는 마스킹의 **보완**이 아니다. 그 경로에서는 **유일한 통제**다.

#### 왜 나가는 쪽을 우리가 가리지 않는가

기술적으로는 프롬프트를 만들 때 가릴 수 있다. 하지 않는 이유가 둘이다.

- **그러면 사용자가 요청한 것과 다른 것을 모델에게 묻게 된다.** "`sk-`로 시작하는 키를 거부해야
  한다" 같은 요구에서 그 모양은 요구 그 자체다. 가리면 요구가 사라진 채 작업이 돈다.
- **요구에 대한 최종 권위는 사용자다**(CLAUDE.md 원칙 1). 무엇이 자기 요구인지, 무엇을 보내도
  되는지는 사용자가 판정한다. 우리가 대신 정하면 그 판정을 지우는 것이고, 그건 이 제품이
  모델에게도 허용하지 않는 일이다.

덧붙여 그 마스킹은 Node에서 일어날 텐데, 장악당한 Node에서 사라지는 규칙은 통제가 아니다
(원칙 2). 저장 쪽 마스킹이 Rust에 있는 것과 같은 이유다.

#### 그래서 막지 않고 알린다

경고만 띄우고 전송은 그대로 열어둔다. 대신 버튼 문구를 "실행"/"전송"/"확인"에서
**"그대로 실행"/"그대로 전송"/"그대로 확인"**으로 바꾼다 — 클릭 한 번이 더 필요하지도 않고,
무엇을 하고 있는지는 눈에 남는다. 모달로 막지 않는 이유는 거짓 경보가 반드시 있기 때문이다.
매번 막히면 사용자는 경고를 읽지 않게 되고, 그 순간 경고는 없는 것보다 나쁘다(승인 피로).

#### 목록은 하나다

`SECRET_SHAPES`(Rust)가 유일한 목록이고 UI는 복사하지 않는다. 두 목록은 반드시 갈라지며,
갈라지면 **경고하지 않고 가리거나, 가리지 않고 경고하는** 상태가 생긴다. 둘 다 사용자를 잘못
안심시킨다. UI는 텍스트를 넘기고 **이름과 개수만** 돌려받는다.

값을 돌려주지 않는 이유: UI는 이미 그 텍스트를 갖고 있어 필요가 없고, 프로세스 경계를 넘는
곳마다 자격증명 사본이 하나씩 늘어나는 것은 그 자체로 노출면이다. 같은 이유로 검사는 **아무것도
저장하지 않는다** — 편집 중인 입력을 기록하기 시작하면 이 기능이 막으려는 것을 이 기능이 한다.

개수는 결합 정규식에서 센다. 모양별로 따로 세면 겹치는 모양(`Bearer` 안의 JWT)이 두 번 세어져
**경고에 적힌 개수와 실제로 가려질 개수가 어긋나고**, 사용자는 하나를 지운 뒤에도 경고가 남는
이유를 알 수 없다. 이름은 반대로 바깥 모양으로 붙인다(모양별 정규식의 양끝을 고정한다) —
`Bearer eyJ…`를 "JWT"라고 부르면 사용자가 엉뚱한 곳을 본다.

#### 이 작업이 해결하지 못한 것

**목록은 여전히 완결되지 않는다.** 새 공급자가 새 접두사를 쓰면 여기 없다. 달라진 것은 그
사실을 사용자가 언제 아느냐뿐이다 — 이제 보내기 전에 알고, 지울 기회가 있다.

그래서 경고 문구 안에 "아는 모양만 찾습니다. 여기 걸리지 않았다고 자격증명이 없는 것은
아닙니다"를 넣는다. 이 문장이 없으면 **경고가 없는 것이 안전으로 읽힌다** — 이 모듈이 처음부터
피하려던 잘못된 확신(16.7절, "통과했을 때 잘못된 확신을 준다")을 경고 UI가 다시 만들게 된다.

### 17.12 자유 서술은 불일치가 아니다 (M1)

12절 미해결이었다: "`interpretation`/`risks`는 표현만 달라도 갈린 것으로 보이므로 거의 언제나
불일치가 잡힌다. 접힌 영역이 매번 채워지는 것 자체가 잡음일 수 있다. 의미 비교는 또 하나의
모델 호출이라 하지 않았다."

**의미 비교를 하지 않기로 한 판단은 그대로다**(17.8절: 대조는 판정이 아니다). 고친 것은 비교
방법이 아니라 **결과를 뭐라고 부르는가**다.

#### 문제는 정확도가 아니라 이름이었다

두 초안의 서술은 거의 언제나 다르다. 그걸 "불일치"라고 부르면 **이름이 발견을 주장하는데 실제로는
아무것도 발견하지 않은 것**이다. 17.10절 ③이 "오탐률"이라는 이름을 거부한 것과 같은 문제다 —
지표든 화면이든, 이름이 추론을 포함하면 읽는 사람이 그 추론을 사실로 읽는다.

그리고 언제나 참인 관측은 목록으로 쌓이는 순간 읽히지 않는다. "두 초안의 전체 차이 보기"가
매번 채워져 있으면, 사용자는 그 영역을 여는 것을 그만둔다 — 진짜 볼 것이 거기 들어가는 날에도.

#### 타입에서 가른다

`DisagreementField`에서 `interpretation`/`risks`를 빼고 `NarrativeField`로 옮겼다.
`DisagreementReport`는 `disagreements`와 `narratives`를 따로 싣는다.

필터로 거르지 않고 **타입을 나눈** 이유: `Disagreement`에는 `blocking`과 `question`이 달려 있다.
물을 수 없는 것에 질문 구조가 남아 있으면 언젠가 누군가 "이것도 보여주자"며 카드에 넣게 되고,
그러면 답할 수 없는 항목이 질문 예산과 사용자의 주의를 먹는다. `DraftNarrative`에는 그 두 필드가
아예 없어서 그 경로가 닫힌다.

#### 부수 효과: 지표의 분모가 정직해졌다

14절 지표는 "불일치 1건당 사용자가 뒤집은 비율"이다. 자유 서술은 **물어본 적이 없으므로 뒤집힐
수도 없는데** 분모에는 들어가 있었다. 태스크마다 최대 2건씩 쌓이므로 그 오염은 작지 않다.
17.4절의 랭킹(`DISAGREEMENT_FIELD_RANK`)에서도 뒤 두 자리가 사라졌다 — 질문이 된 적이 없으니
예산을 다투는 목록에 있을 이유도 없었다.

#### 일치도 세지 않는다

서술이 우연히 같아도 `agreedFields`에 넣지 않는다. 넣으면 "두 모델이 동의했다"로 읽히는데,
상관된 오류는 불일치를 만들지 않으므로(16.5절) 일치는 검증이 아니다. 갈렸다고도 같다고도
주장하지 않는 것이 이 필드들에 대해 유일하게 정직한 태도다.

#### 그래도 버리지는 않는다

두 초안이 문제를 어떻게 봤는지는 사용자가 읽을 가치가 있다. 그래서 접힌 영역에 남기되
**"두 초안이 각각 어떻게 봤는지"**로 부르고, "비교 결과가 아니라 서술을 그대로 옮긴 것"임을
그 자리에 적는다. 그리고 규칙이 판정한 것(갈렸지만 묻지 않은 쟁점)과 **다른 영역으로 나눈다** —
판정한 것과 판정하지 않은 것을 한 목록에 섞으면 목록 전체가 "그냥 참고"로 읽힌다.

#### 남는 것

서술을 **읽을 가치가 있는 순서로** 정렬하지 않는다. 지금은 항상 원인 진단 → 위험 순이고,
어느 쪽이 더 볼 만한지는 판정하지 않는다. 그 판정에는 의미 비교가 필요하고, 그건 여전히
모델 호출이다.

## 18. 검증 통과 후 커밋 (M1)

12절 미해결 항목이었다. Policy Gate 규칙(`git commit`은 항상 승인)과 `run_command` 도구는 M0부터
있었지만, **커밋을 요청하는 코드가 없었다.**

### 18.1 언제 커밋하는가 — `overall === "pass"`일 때만

검증을 통과한 뒤에만 커밋한다. 통과 전에 커밋하면 "결정론적 검증이 최종 판정자"라는 1번 원칙과
정면으로 어긋난다 — 커밋은 되돌리기 어려운 기록이므로 그 판정을 앞질러 남기지 않는다.

`not_configured`(프로젝트에 검증 명령이 없음)·`could_not_run`(돌리지 못함) 어느 쪽에서도 커밋하지 **않는다.** "검증되지 않았다"를
"통과했다"처럼 다루면 검증 없는 변경이 이력에 박힌다 — `VerificationStatus`를 5값으로 나눈 것과
같은 이유이며, 여기서 뭉개면 그 분리가 무의미해진다.

### 18.2 `git add -A`를 쓰지 않는다

사용자에게는 이 태스크와 무관한 미커밋 변경이 있을 수 있다. `-A`는 그걸 전부 우리 커밋에
쓸어담는데, 그건 사용자가 승인 모달에서 본 것과 **다른 일**이다. "승인 화면에 보이는 argv가 실제
실행되는 것과 100% 일치한다"는 보장(6번 원칙)은 경로를 명시할 때만 성립한다.

스테이징 대상은 **성공한 실행에서 온 경로**다(계획이 아니라). 승인 거부나 실패로 적용되지 않은
파일을 "바꿨다"고 세면 커밋 범위가 사실과 달라진다.

`add`와 `commit`을 한 요청으로 합치지 않는 이유도 같다. `git commit -a`는 범위가 넓고,
`git add ... && git commit ...`은 셸 문자열이라 argv 계약이 깨진다. 두 개의 `run_command`로
나누면 Policy Gate가 각각을 독립적으로 판정하고 승인 모달도 각각을 보여준다.

### 18.3 실패해도 태스크를 실패로 만들지 않는다

코드 변경은 이미 적용됐고 검증도 통과했다. 커밋은 그 위에 얹는 **선택적 마무리**이므로, 사용자가
승인을 거부했거나 git이 실패했다고 해서 성공한 작업을 실패로 뒤집으면 안 된다.

결과를 성공/실패 두 값으로 두지 않은 것도 그래서다. "요청되지 않음"·"저장소가 아님"·"커밋할 것
없음"·"거부됨"·"실패"는 사용자에게 전혀 다른 사실이고, 뭉치면 최종 보고가 "커밋 안 됨"이라고만
말하게 된다. 다만 **`not_requested`만은 아무 말도 하지 않는다** — 켜지 않은 기능을 매번 언급하면
요약이 잡음으로 덮인다.

### 18.4 phase를 옮기지 않는다

`VERIFYING → EXECUTING` 전이를 열지 않았다. 열면 그 뒤 `COMPLETED`로 가기 위해 다시 `VERIFYING`을
거쳐야 하는데(전이 표), 커밋은 **추적 파일의 내용을 바꾸지 않으므로** 두 번째 검증은 같은 결과만
낼 수밖에 없다. 순전한 낭비를 만들지 않기 위해 phase는 `VERIFYING`에 둔 채 실행하고, 무엇이
실행됐는지는 이벤트가 말한다(7번 원칙: 이벤트가 진실의 원천이고 phase는 파생 캐시다).

`ExecutionPlan`은 그대로 쓴다(`buildCommitPlan`). 도구 실행 경로를 따로 만들면 Policy Gate·승인·
`tool_executions` 기록이 갈라진다.

### 18.5 시도 자체를 opt-in으로 두는 이유

`allowGitCommit`이 꺼져 있으면 아예 시도하지 않는다. Policy Gate가 어차피 승인을 요구하므로
"시도해 보고 거부당하기"도 가능하지만, 그러면 커밋을 원하지 않는 사용자가 **매 태스크마다** 모달을
닫아야 한다. 승인 피로는 승인을 무의미하게 만든다(product-strategy.md 9.1절).

**UI 토글은 승인 등급을 낮추지 않는다.** 데스크톱의 Rust `TaskPolicy`는 워크스페이스를 열 때
고정되고 태스크마다 바뀌지 않으므로, 토글이 켜져도 Policy Gate는 `git commit`을 High 승인으로
다룬다. **UI에서 켠 스위치가 신뢰 경계의 위험 등급을 낮출 수 있으면 그건 게이트가 아니다**
(2·3번 원칙). 토글이 정하는 것은 "제안할 것인가"뿐이다.

재실행(`restart_task`)은 커밋을 제안하지 않는다. 저장된 작업 행에 그 토글이 남아 있지 않고,
기억나지 않는 설정으로 저장소 이력을 바꾸는 것보다 제안하지 않는 편이 안전하다.

### 18.6 커밋 메시지는 검증된 것 이상을 말하지 않는다

제목은 사용자의 요청문(줄바꿈 제거, 72자)이고 본문은 변경 파일 목록과 **실제로 통과한 체크**다.
통과한 체크가 없으면 "검증 통과"가 아니라 "검증: 실행된 체크 없음"으로 적는다.

모델 이름을 넣지 않는다. 커밋 로그는 저장소에 영구히 남는 기록인데 어떤 모델이 썼는지는 그 시점의
라우팅 결정일 뿐이라 재현되지 않는다. 그 정보가 필요하면 `task_events`에 있다.

"그 정보가 필요하면 `task_events`에 있다"는 말은 **거기로 갈 수 있을 때만** 참이다. 그래서
`Tomverse-Task` trailer와 재시도 흔적을 함께 남긴다 — 근거는 19.6절(커밋 단위)에 있다.

### 18.7 되돌리기와의 관계 — 숨기지 않는다

되돌리기는 파일 내용을 복원할 뿐 **커밋을 지우지 않는다.** 최종 요약이 그 사실을 함께 말한다.
`GIT_COMMIT_CREATED` 이벤트를 따로 남기는 것도 같은 이유다 — 시도와 거부는 이미 `TOOL_*`와
`POLICY_DECIDED`에 다 있고, 이 이벤트는 "이 태스크가 저장소 이력을 바꿨다"는 **되돌리기 어려운
사실**의 표식이다.

## 19. 커밋 뒤의 되돌리기 (M1)

18절이 커밋을 만들면서 **되돌리기의 뜻이 둘로 갈렸다.** 그 전까지 되돌리기는 하나였다 —
파일 내용을 작업 전으로 복원한다. 커밋이 생기면 그것만으로는 부족하다: 커밋은 저장소에 남고,
파일만 복원하면 워킹 트리가 HEAD와 달라진다.

### 19.1 결론: 묻는다. 단, 우리가 안전하게 할 수 있는 것만 제안한다

어느 쪽이 옳은지는 **우리가 알 수 없는 사실**에 달려 있다 — 그 브랜치를 이미 공유(push)했는가,
동료가 그 커밋을 받았는가. 그래서 고르지 않고 묻되, 선택지는 우리가 **끝까지 책임질 수 있는
것**으로 제한한다.

| 선택지 | 하는 일 | 남는 것 |
|---|---|---|
| 파일만 되돌리기 | 저장된 이전 내용으로 파일 복원 | 커밋은 그대로. 워킹 트리가 HEAD와 달라진다 |
| 커밋 되돌리기(`git revert`) | 그 커밋을 취소하는 **새 커밋**을 만든다 | 이력에 두 커밋이 모두 남는다. 공유된 브랜치에서도 안전 |

### 19.2 `git reset`은 제안하지 않는다 — 목록에도, 코드에도

`reset --hard`는 (a) 커밋되지 않은 작업을 **복구 불가능하게** 지우고 (b) 이력을 다시 쓴다.
(b)가 안전한지는 "이 커밋을 아직 아무도 받지 않았는가"에 달려 있는데, **그건 우리가 확인할 수
없다.** upstream을 조회해도 동료의 로컬 클론까지는 알 수 없다.

되돌릴 수 없는 동작을, 안전 조건을 확인할 수 없는 채로 우리가 대신 실행하지 않는다. allowlist에
`git reset`을 넣지 않은 것이 그 결정의 구조적 표현이다 — 정책 파일에 없으면 Policy Gate가
막으므로, 나중에 누가 UI 버튼만 추가해도 실행되지 않는다. 화면은 이 선택지가 **존재한다는 사실과
왜 우리가 하지 않는지**를 함께 적고 사용자에게 넘긴다.

### 19.3 충돌하면 우리가 치운다 — 미리 배제하지 않는다

처음에는 **충돌이 불가능한 경우에만** revert했다. 두 조건 — 그 커밋이 아직 `HEAD`이고, 커밋한
경로의 워킹 트리가 깨끗할 때 — 을 확인하고, 아니면 아무것도 하지 않고 사유를 돌려줬다. 근거는
"충돌하면 `git revert --abort`도 승인을 받아야 하는데 사용자가 거부하면 충돌 마커가 박힌 채로
남는다"였다.

**그 근거가 틀렸다.** `--abort`는 새로운 작업이 아니라 **우리가 시작해서 실패한 작업의
원상복구**다. 사용자는 "커밋 되돌리기"를 누르며 그 작업 하나를 승인했고, 실패했을 때 원래대로
돌려놓는 것까지가 그 한 번의 승인 범위다. 다시 묻는 쪽이 오히려 위험했다 — 거부당하면 **우리가
만든** 충돌 상태를 사용자에게 떠넘기게 된다. 승인은 "무엇을 할 것인가"를 위한 것이지,
우리가 저지른 일의 뒷정리를 사용자에게 미루는 통로가 아니다.

그래서 HEAD 조건을 버렸다. 그 위에 다른 커밋이 쌓여 있어도 대부분은 깨끗하게 되돌아가고,
안 되면 되돌려 놓으면 된다. "직접 `git revert`를 실행하세요"라고 미루던 경우의 대부분이 사실은
우리가 해줄 수 있는 일이었다.

#### 워킹 트리 조건만 남긴다

커밋한 경로에 저장되지 않은 변경이 있으면 여전히 시작하지 않는다. 그건 실패했을 때 **사용자가
아직 저장하지 않은 작업**이 위험해지는 유일한 경우이고, `--abort`가 그것까지 지켜준다고 보장할
수 없다. 두 조건의 운명을 가른 것은 이 비대칭이다: **우리가 만든 상태는 우리가 되돌릴 수 있지만,
사용자가 만든 상태는 되돌릴 수 없다.**

#### 남의 revert 위에서는 시작하지 않는다

시작 전에 `REVERT_HEAD`가 이미 있으면 거부한다. 진행 중인 revert가 있다는 뜻이고, 그 위에서
우리가 실패해 `--abort`를 부르면 **사용자가 손으로 풀던 충돌이 사라진다.** 실패한 뒤에도 같은
것을 다시 확인해서, 그 `REVERT_HEAD`가 **이번 실행이 만든 것일 때만** 치운다. `.git/REVERT_HEAD`
파일을 직접 보지 않고 `git rev-parse --verify --quiet REVERT_HEAD`로 묻는 이유: worktree나
`--git-dir`에서 그 경로가 달라진다.

이 검사는 워킹 트리 검사보다 **먼저**다. 순서가 뒤집히면 "진행 중인 revert가 있다"는 상황이
"워킹 트리가 지저분하다"로 보고되어, 사용자가 무엇을 해야 하는지 알 수 없게 된다.

#### 네 결말을 구별해서 말한다

| 결말 | `reverted` / `conflicted` / `cleanedUp` | 저장소 상태 | 사용자가 할 일 |
|---|---|---|---|
| 되돌렸다 | `true` / — / — | 되돌리는 커밋이 하나 늘었다 | 없음 |
| 시작조차 못 했다 | `false` / `false` / `true` | 시작 전 그대로 | 사유를 보고 판단 |
| 충돌 → 원상복구 성공 | `false` / `true` / `true` | 시작 전 그대로 | 없음. 직접 하려면 `conflicts`가 출발점 |
| 충돌 → 원상복구 실패 | `false` / `true` / `false` | **revert 진행 중으로 남음** | `git revert --abort` |

`conflicted`와 `cleanedUp`을 **따로 두는 이유**: "충돌했다"와 "그래서 저장소가 어떤 상태인가"는
다른 사실이다. 하나의 불리언으로 합치면 화면이 마지막 줄을 셋째 줄처럼 말하게 된다 — 사용자가
지금 손대야 하는 유일한 상태를 "아무것도 안 바뀌었습니다"로 보고하는 것이 가장 나쁜 결과다.
헤드리스 호스트의 종료 코드가 셋인 것도 같은 이유다 — `0`(되돌림) / `1`(되돌리지 않음, 저장소는 그대로) /
`2`(revert 진행 중으로 남음). 가운데 둘을 같은 `1`로 합칠 수 있는 것은 저장소 상태가 같기 때문이고,
마지막 것은 합칠 수 없다.

`conflicts` 목록은 **`--abort` 전에** 읽어야 남는다(`git diff --name-only --diff-filter=U`).
abort 뒤에는 어떤 파일이 충돌했는지 알 방법이 없고, 그 목록이 사용자가 직접 되돌릴 때의
유일한 출발점이다.

되돌리지 못한 두 결말은 `ROLLBACK_FAILED` 이벤트를 남긴다. **저장소가 시작 전과 같다는 것은
아무 일도 없었다는 뜻이 아니다** — 사용자가 되돌리기를 눌렀고 우리가 하지 못했다. 특히 마지막
줄(원상복구 실패)은 저장소가 그 상태로 남은 이유를 나중에 되짚을 수 있는 유일한 기록이다.

#### 성공 판정은 `exitCode`까지 봐야 한다

`run_command`는 0이 아닌 종료 코드를 "도구 실행 실패"가 아니라 **"명령이 실패했다"는 사실**로
다루기 때문에 `ToolStatus`는 `Ok`로 두고 `exitCode`만 남긴다(검증 러너가 그 구분을 필요로 한다).
그래서 `status`만 보는 코드는 **충돌한 revert를 "되돌렸습니다"로 보고한다.** 이전 구현에 실제로
있던 결함이고, "tip 커밋만 되돌린다"는 조건이 우연히 가리고 있었다 — 조건을 없애는 순간
드러났을 것이다. 이제 git 호출은 `git_try`가 `(성공, stdout, stderr)`로 감싸고, 성공 판정은
`exitCode == 0`이다.

모든 git 호출은 여전히 **Policy Gate와 Tool Runtime을 그대로 지난다.** Rust가 자기 편의로
게이트를 우회하기 시작하면 게이트의 의미가 사라진다. 다만 감사 로그에 남기는 것은 **저장소를
바꾸는 명령**(`revert`, `revert --abort`)뿐이다 — 상태를 묻기만 하는 조회까지 남기면 이벤트
로그가 사용자가 읽을 수 없는 것으로 가득 찬다.

### 19.4 커밋 sha는 이벤트에서 찾는다

`GIT_COMMIT_CREATED`에 `sha`를 남긴다(커밋 직후 `git rev-parse HEAD`). 이게 없으면 "이 태스크가
만든 커밋"을 특정할 수 없고, 그러면 revert를 제안할 수조차 없다. 시각이나 메시지로 추측하는
방법은 있지만 **추측으로 저장소 이력을 건드리지 않는다** — sha가 없으면 화면이 그 사실을 말하고
커밋 되돌리기 버튼을 열지 않는다.

별도 컬럼에 저장하지 않는 이유: 이벤트가 진실의 원천이고(7번 원칙) sha는 이미 거기 있다. 같은
사실을 두 곳에 두면 어긋날 수 있다.

### 19.5 두 되돌리기를 한 버튼으로 합치지 않는다

"알아서 적절한 쪽을 고르는" 버튼을 만들지 않았다. 그러면 사용자는 자기가 무엇을 눌렀는지 모른 채
이력이 바뀌는 것을 본다. 저장소에 남기는 결과가 다른 두 동작은 버튼도 달라야 한다 —
승인 모달이 실제 argv를 보여주는 것과 같은 이유다.

### 19.6 커밋 단위 — 태스크 하나가 커밋 하나다

12절 미해결 항목이었다: "fix loop를 여러 번 돈 태스크도 커밋은 하나라 중간 시도는 이력에 남지
않는데, 그게 바람직한지(깨끗한 이력) 아닌지(무엇을 시도했는지 잃음)는 사용자 취향의 문제다."

**취향의 문제가 아니었다.** 항목이 두 축을 섞고 있었고, 나눠 보면 한쪽은 이미 정해져 있었다.

#### 축 1: 시도별로 쪼갤 것인가 — 아니다. 쪼갤 수 없다

중간 시도는 **검증에 실패한 상태**다. 그걸 커밋하면 18.1절("`overall === "pass"`일 때만
커밋한다")과 정면으로 어긋난다. 더 중요한 것은 그때 깨지는 성질이다 — *이 도구가 만든 커밋은
검증을 통과했다*. 그게 우리가 파는 것이고(CLAUDE.md 원칙 1), 이력의 예쁨과 맞바꿀 수 있는
종류의 것이 아니다.

"작업 중" 커밋에 그 성질을 면제해 주는 방법도 있지만 — 접두사, 별도 브랜치 — 그러면 저장소를
받은 사람이 커밋마다 그 규칙을 알아야 한다. 규칙을 알아야만 안전한 이력은 안전하지 않다.

#### 축 2: 결과를 주제별로 쪼갤 것인가 — 아니다. 쪼갠 조각은 검증된 적이 없다

"12개 파일을 한 커밋으로 남기지 말고 관심사별로 나눠라"는 다른 요구다. 그러나 우리가 검증한
것은 **전체 변경 하나**뿐이다. 조각마다 테스트를 돌린 적이 없으므로 조각의 메시지에 "검증
통과"를 적을 수 없고, 적지 않으면 축 1과 같은 문제로 돌아온다. 조각을 하나씩 적용하며 매번
검증하는 것은 가능하지만 그건 커밋을 쪼개는 일이 아니라 **태스크를 쪼개는 일**이다.
커밋이 커서 문제라면 고칠 곳은 요청 단위다.

#### 그러면 "무엇을 시도했는지 잃는다"는?

**잃지 않는다. git이 아닌 곳에 있다** — `task_events`, 검증 출력 artifact, `file_mutations`의
pre-image. 잃는 것과 다른 곳에 있는 것은 다르다.

다만 그 주장이 성립하려면 **커밋에서 그곳으로 갈 수 있어야 한다.** 그래서 두 가지를 남긴다.

| 남기는 것 | 자리 | 이유 |
|---|---|---|
| `재시도: 2회 (도중 실패: test)` | 본문 | 없으면 세 번 고쳐 통과한 변경과 처음부터 맞았던 변경이 이력에서 같아 보인다. 그 둘은 나중에 이 커밋을 의심할 이유가 다르다 |
| `Tomverse-Task: <taskId>` | trailer | 전체 기록으로 가는 열쇠 |

재시도가 0이면 그 줄을 적지 않는다 — "재시도: 0회"는 참이지만 모든 커밋에 붙으면 아무것도
구별해주지 않으면서 메시지만 길어진다. 실패한 체크를 모르면 횟수만 적는다. **모르는 것을
지어내지 않는다**는 규칙이 커밋 메시지에서도 같다(18.6절).

**trailer의 한계를 숨기지 않는다.** `taskId`는 이 기계의 로컬 기록(`state.db`)을 가리키는
열쇠라 저장소를 받은 다른 사람에게는 아무 뜻이 없다. 그걸 알면서도 남기는 이유는 이 커밋을
만든 사람에게는 그것이 유일한 다리이기 때문이고, **본문 산문이 아니라 trailer에 두는 이유**가
그 한계다 — trailer는 관례상 도구용이라 읽는 사람이 무시해도 되는 자리다. 본문에 문장으로
적으면 따라갈 수 있는 것으로 오해된다.

#### 커밋이 커서 문제라면 고칠 곳은 요청 단위다 — 그걸 언제 말하는가

두 축이 다 막혀 있으므로 남는 답은 "태스크를 쪼개라"인데, **그걸 사용자가 알아챌 장치가
없었다.**

**계획 시점에 말한다.** 커밋을 보고 "컸네"라고 말하는 것은 이미 늦다 — 그때는 파일이 다 바뀐
뒤라 쪼갤 수 있는 것이 없다. `PLAN_CREATED`가 건드릴 파일을 이미 싣고 있고, 그 시점에는 아직
취소하고 더 작게 다시 요청할 수 있다.

**막지 않는다.** 파일 30개를 건드리는 이름 바꾸기는 정당하게 한 작업이고, **무엇이 한 작업인지는
우리가 판정할 수 없다.** 사실(파일 수, 그것이 커밋 하나가 된다는 것, 되돌리기가 전부-아니면-전무
라는 것)만 말하고 판단은 넘긴다. 모달로 막으면 정당한 큰 작업마다 걸리고, 그러면 안내가 읽히지
않게 된다.

`allowGitCommit`이 꺼져 있으면 띄우지 않는다. 그때는 커밋이 없으므로 "커밋 하나로 남는다"가
틀린 말이 된다 — 안내의 근거가 성립하지 않는 자리에 안내를 띄우지 않는다.

**문턱은 이 워크스페이스의 커밋 크기 분포에서 유도한다**(`metrics`의 `commitSizes`,
`largeChangeThreshold`). 16.3절 강제 포기 시점과 같은 장치이지만 **백분위 선택이 다르다**:

| | 재는 것 | 쓰는 값 | 이유 |
|---|---|---|---|
| 강제 포기(16.3) | 취소 소요 | max × 1.5 | "이 취소가 **비정상**인가" — 정상 취소 중에 뜨면 거짓 경보다 |
| 큰 변경(여기) | 커밋 파일 수 | p90 | "이 작업이 **큰 편인가**" — 큰 편인 것은 비정상이 아니고, 안내는 막지 않으므로 가끔 떠도 손해가 작다 |

max를 쓰면 지금까지 가장 컸던 작업보다 커야만 떠서 사실상 뜨지 않는다. 반대로 p90은 이상치
하나에 끌려가지 않는다 — 한 번의 큰 작업이 앞으로의 모든 안내를 꺼버리지 않는다는 뜻이고,
그 성질을 테스트로 고정했다.

모집단은 **커밋한 태스크뿐**이다. 커밋하지 않은 태스크를 넣으면 분포가 작은 쪽으로 휘어 문턱이
낮아지고, 안내가 아무 때나 뜬다.

표본이 부족할 때의 기본값(8개)은 **유도하지 못한 유일한 상수**다. 취소 소요와 달리 첫 사용자에게는
관측할 과거가 없고, 그때 쓸 숫자가 필요하다. 승인 모달에서 눈으로 훑을 수 있는 크기를 어림한
것이며 실측이 아니다 — 그 사실을 Rust 상수와 화면 상수 양쪽 주석에 적어둔다. **근거 없는 숫자는
근거 있는 숫자와 코드에서 구별되지 않기 때문이다.**

## 20. 프로세스 샌드박싱 조사 — Job Object는 절반만 닫는다 (M1)

12절 항목은 이렇게 적혀 있었다: "**프로세스 샌드박싱**(5.3절) — `run_command`가 실행한 프로세스의
파일·네트워크 접근 제한. Windows job object / 컨테이너 중 무엇을 쓸지 … 조사 필요.
**M0.1에서 Windows Job Object가 이 항목과 합류했다 — 16.3절의 `taskkill /T` 한계도 같은 해법으로
닫힌다.**"

**마지막 문장이 틀렸다.** 한 항목에 답이 다른 두 문제가 묶여 있었다.

### 20.1 Job Object가 하는 일과 하지 않는 일

Win32 Job Object가 거는 제한은 **프로세스 수, 메모리, CPU 시간/비율, UI 핸들**, 그리고
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`다. **파일시스템과 네트워크에 대한 제한은 없다.**

| 문제 | Job Object로 닫히는가 |
|---|---|
| 프로세스 트리 종료 보장 (16.3절 `taskkill /T`의 스냅샷 한계) | **닫힌다.** 커널이 job 안의 모든 프로세스를 죽인다 |
| 강제 포기 이후 남은 프로세스 정리 (12절) | **닫힌다.** 아래 20.4 |
| 파일·네트워크 접근 제한 (5.3절의 원래 요구) | **닫히지 않는다.** Job Object에 그런 기능이 없다 |

세 번째가 이 항목의 제목이었으므로, 제목만 보고 "Job Object를 넣으면 끝"이라고 읽으면 안 된다.

### 20.2 파일·네트워크 제한: 하지 않기로 한다 — 어려워서가 아니다

Windows에서 실제로 파일·네트워크를 제한하는 수단과, 그것이 개발 도구와 부딪히는 지점:

| 수단 | 파일 | 네트워크 | 개발 도구와의 충돌 |
|---|---|---|---|
| Job Object | ✗ | ✗ | 없음 — 그래서 부작용 없이 도입할 수 있다 |
| AppContainer / 제한된 토큰 | ○ | ○ | **크다.** 테스트 러너가 `%LOCALAPPDATA%`·`%TEMP%`·npm/cargo 캐시에 쓴다. 패키지 설치·원격 fixture는 네트워크가 필요하다. capability를 하나씩 열다 보면 결국 "거의 전부 허용"이 되고, 그때 남는 보장은 이름뿐이다 |
| 컨테이너 / Windows Sandbox | ○ | ○ | **가장 크다.** 워크스페이스를 마운트하고 툴체인을 안에 다시 깔아야 한다. 설치된 SDK·사내 인증서·프록시 설정이 사용자의 것과 달라진다 |

**결정: 하지 않는다.** 근거는 난이도가 아니라 **제품 명제와의 충돌**이다.

이 제품의 차별화는 "사용자의 실제 환경에서 실제 빌드·테스트를 돌리고 그 결과를 최종 판정자로
쓴다"이다(CLAUDE.md 원칙 1). 샌드박스는 그 환경을 **다른 환경으로 바꾼다.** 샌드박스 안에서
통과한 테스트가 사용자의 기계에서도 통과한다는 보장은 없고, 그러면 우리가 파는 판정의 의미가
그만큼 약해진다. 격리를 얻고 판정을 잃는 교환이며, 우리는 판정을 지킨다.

그래서 5.3절의 정직한 한계 진술은 **그대로 유지된다.** "Policy Gate가 있으니 임의 코드 실행이
안전하다"는 주장은 앞으로도 하지 않는다. 바뀐 것은 그 한계가 "아직 안 한 것"이 아니라
**"의도적으로 하지 않는 것"**이 됐다는 점이고, 화면도 그렇게 말해야 한다.

### 20.3 Job Object 도입의 실제 난점 — 정지·재개

경쟁 조건 없이 하려면 자식을 **정지 상태로 띄우고**(`CREATE_SUSPENDED`) job에 배정한 뒤
재개해야 한다. spawn 직후에 배정하면 그 사이에 자식이 만든 손자는 job 밖에 남는다.

그런데 `std::process::Command`는 `creation_flags`로 `CREATE_SUSPENDED`를 줄 수는 있어도
**재개에 필요한 스레드 핸들을 돌려주지 않는다.** Toolhelp 스냅샷으로 그 pid의 스레드를 찾아
`ResumeThread`를 부르는 우회가 필요하고, 그건 취소 경로에 들어가는 `unsafe` 코드의 양을 늘린다.

배정을 spawn 직후로 하면 `unsafe`가 훨씬 작아지고 남는 경쟁 창은 마이크로초 단위다.
그리고 **어느 쪽을 골라도 지금(taskkill 스냅샷)보다 나빠지지 않는다.** 이 선택은 착지할 때
정하되, 고른 쪽과 그 이유를 코드 주석에 남긴다.

### 20.4 강제 포기 항목은 Job Object가 그냥 닫는다

12절의 "강제 포기 이후 남은 프로세스의 정리"는 "앱이 대신 정리하려면 그 PID를 계속 추적해야
한다"고 적어두었다. Job Object에서는 **추적할 것이 없다.** `KILL_ON_JOB_CLOSE`가 걸린 job의
마지막 핸들을 놓으면 커널이 안에 있는 것을 전부 죽인다. "이미 우리 손을 떠난 프로세스를
추적한다"는 문제 자체가 사라진다.

### 20.5 구현했다 — 그리고 어디까지 검증됐는지

`win_job.rs`와 `proctree.rs`의 Windows 분기에 구현되어 있다. 구조는 이렇다.

| 시점 | 하는 일 |
|---|---|
| spawn 직후 | job 생성 → `KILL_ON_JOB_CLOSE` 설정 → **자식만** 배정 (`adopt`) |
| 취소·타임아웃 | `TerminateJobObject` → 자식 수거 (`terminate_tree`) |
| 스코프 이탈 | `CloseHandle` → 커널이 남은 것을 죽인다 (`Drop`) |

세 번째 줄이 20.4절(강제 포기 이후 정리)을 닫는다. 그리고 **정상 종료한 명령이 뒤에 남긴
백그라운드 프로세스도 이때 죽는다** — allowlist가 빌드·테스트·lint용이라 그 편이 맞다고 보았고,
남겨야 할 프로세스가 생기면 이 결정을 다시 봐야 한다.

실패하면 `None`을 돌려 taskkill로 물러선다. **취소를 실패시키지 않는 것이 트리를 보장하는
것보다 우선한다.** 그래서 taskkill 경로를 지우지 않았다 — 구형 Windows나 이미 다른 job에 속한
환경에서 중첩 배정이 거절될 수 있고, 그때 `tree_guaranteed`는 거짓이 되어 화면이 그 사실을
그대로 말한다.

#### 검증 경계 — 여기서 통과한 verify는 이 코드에 대해 아무것도 말하지 않는다

이 저장소의 개발 환경은 Linux다. `[target.'cfg(windows)'.dependencies]`는 Linux에서 아예
해석되지 않으므로, `npm run verify`가 초록이어도 **이 코드는 한 줄도 컴파일되지 않았다.**

한 것: `win_job.rs`와 `proctree.rs`를 그대로 담은 별도 크레이트에서
`cargo check --target x86_64-pc-windows-msvc`로 **타입 검증**(`tomverse-core` 전체는
`rusqlite`의 bundled SQLite가 `lib.exe`를 요구해 그 방식으로 검사할 수 없다). 복사본이 아니라
`#[path]`로 **실제 파일을 가리켜** 검사했다 — 복사본을 검사하면 옮겨 적는 과정의 오류를 놓친다.

하지 못한 것: **동작.** 그리고 이 자리에서 컴파일되는 Win32 코드가 틀리는 흔한 방식은 핸들
수명이며, 그 결과가 "취소가 안 된다"가 아니라 **"앱이 스스로 죽는다"**일 수 있다
(`KILL_ON_JOB_CLOSE`가 걸린 job에 우리 프로세스가 들어가면 그렇다). 그래서 20.6절의 착지
기준을 Windows에서 통과시키기 전에는 이 경로를 신뢰하지 않는다.

### 20.6 착지 기준 — Windows에서 아직 확인되지 않았다

**아래가 전부 참으로 확인되기 전까지 이 경로는 "구현됨"이지 "검증됨"이 아니다.**
taskkill 경로는 어느 경우에도 남겨둔다(20.5절).

**판정은 이제 명령이 한다** — `tomverse-host windows-landing`(process-architecture.md 12절).
사람이 이 목록을 읽고 머릿속에서 판정하면 하나를 빠뜨려도 아무 일도 일어나지 않는다.
그리고 4번은 **Windows를 기다리지 않는다**: 플랫폼과 무관한 소스 불변식이라 테스트가 지킨다.

1. `npm run core:build`가 Windows에서 통과한다.
2. e2e 시나리오 A(**손자 프로세스가 실제로 죽는가**)가 Windows에서 통과한다.
3. `TreeKillOutcome.tree_guaranteed`가 Windows에서 `true`가 되고, 그 값이 UI 문구를 실제로
   바꾼다 — 지금 화면은 `false`일 때 "하위 프로세스 종료를 보장하지 못함"을 말한다.
4. **앱 자신이 job에 들어가지 않는다.** `AssignProcessToJobObject`는 자식 핸들에만 부른다.
5. job 핸들의 수명이 태스크와 같다 — 태스크가 끝나면 닫히고, 닫히면 남은 프로세스가 죽는다.
   강제 포기도 이 경로를 그대로 탄다(20.4).

#### 20.6.1 Job Object만 Windows를 기다리는 것이 아니었다

착지 목록을 만들 때는 이 절(Job Object)과 sidecar 번들·Credential Store 셋만 들어 있었다.
훑어보니 **Windows에서만 진짜로 검증되는 동작이 셋 더 있었고 아무 목록에도 없었다.**

- **명령 해석**(`tools/program.rs`) — `npm`이 `npm.cmd`라 생기는 그 함정이다. CLAUDE.md가 가장
  길게 적어둔 항목인데도 빠져 있었고, **빠진 이유가 시사적이다**: 이 파일은 `cfg!(windows)`를
  직접 읽지 않고 `Platform`을 인자로 받으므로(그래야 Linux에서 경로 조작을 검증할 수 있다)
  `cfg(windows)`를 찾는 눈에는 보이지 않았다. 증상도 조용하다 — 해석이 실패하면 검증이
  `SKIPPED_WITH_REASON`이 되어 **정상 수정 작업이 검증 없이 완료로 보고**된다. 다행히 이제
  볼 수 있는 값이 하나 있다: 종합 판정이 `could_not_run`인지 여부다(product-strategy 11.1절).
- **프로세스 그룹**(`proctree.rs`) — `CREATE_NEW_PROCESS_GROUP`과, Job Object가 확인될 때까지
  남겨두는 `taskkill` 경로. Job Object와 **다른 항목**이다.
- **경로 정규화**(`paths.rs`) — `\\?\` verbatim 프리픽스 제거. **Policy Gate가 이 결과로
  경계를 판정하므로**, 남으면 정상 경로가 경계 밖으로 판정될 수 있다. UNC는 건드리지 않아야
  한다.

셋 다 `windows-landing`에 들어갔다(`commandResolution`/`processGroup`/`pathNormalization`).

그리고 **같은 누락을 막는 그물을 함께 두었다**: `core/src`에서 `cfg(windows)` 또는
`Platform::Windows`를 쓰는 파일이 `landing.rs`에 언급되지 않으면 테스트가 실패한다. 면제하려면
`WINDOWS_FILES_WITHOUT_LANDING`에 **이유를 적어야** 한다. 두 표식 없이 들어오는 Windows 전용
동작은 이 그물도 놓친다 — 타입 검사의 대체물이 아니라 그물이라는 것을 그대로 적어둔다.


## 21. 재현 러너의 판정 규칙 (M1)

12절 항목("재현 러너")은 **기능보다 판정 규칙을 먼저 정하라**고 적어두었다. 그 규칙이 여기 있고,
구현은 `apps/desktop/src-tauri/core/src/reproduce.rs`와 `tomverse-host reproduce`다.
재현/재실행의 구분과 export가 담는 재료는 [product-strategy.md 6.3절](./product-strategy.md).

### 21.1 종전 문항에는 답을 막는 전제가 둘 있었다

문항은 이랬다: **"워크스페이스가 `workspaceFingerprint`와 다르면 (a) 거부할지 (b) 경고 후
진행할지."** 답하지 못한 이유로는 "재현을 돌리는 사람이 같은 상태를 만들 수 없는 머신에 있는지,
원본 저장소를 그대로 들고 있는지에 따라 답이 반대가 된다"고 적혀 있었다.

그런데 그 문항 안에 전제가 둘 들어 있고, 둘 다 사실이 아니다.

**전제 ① — 불일치가 한 비트다.** 지문은 세 재료(HEAD·status·diff)의 해시다. 해시가 다르다는
사실 하나로는 **"기반 커밋이 아예 다르다"**와 **"같은 커밋인데 워킹 트리가 더럽다"**가 구별되지
않는다. 뒤쪽은 사용자가 stash 한 번으로 없앨 수 있는 차이인데, 한 비트로 뭉치면 그 사실을
말해줄 방법이 없다. 그리고 더 나쁜 것: **"다르다"와 "잴 수 없었다"까지 같은 칸에 들어간다.**
git 저장소가 아니어서 지문이 없는 경우를 "달라졌다"로 보고하면, 사용자는 맞출 대상이 없는
상태를 맞추려 든다.

**전제 ② — 재현이 한 동작이다.** 실제로는 둘이다. 아무것도 쓰지 않는 **검사**와 파일을 쓰는
**적용**. 거부할 것이 있는 쪽은 후자뿐이다.

전제를 풀면 "재현을 돌리는 사람이 누구인가"를 추측할 필요가 사라진다. **같은 상태를 만들 수 없는
머신의 감사자는 검사가 줄 수 있는 것을 전부 받고**(patch가 실제로 붙는지까지), **원본 저장소를
들고 있는 사람은 적용을 받는다.** 우리가 고를 것이 남지 않는다 — 답이 사람에 따라 갈리던 이유는
질문이 두 동작을 하나로 묶고 있었기 때문이다.

### 21.2 규칙

1. **입력은 export 파일이고, 그 파일은 신뢰되지 않는다.** 재현을 돌리는 사람에게는 대개 DB가
   없다 — 그래서 export가 있는 것이다. 태스크 id로 DB를 읽는 러너는 **이미 DB를 가진 사람**만
   섬긴다. 그리고 파일은 밖에서 온다: 아는 `formatVersion`이 아니면 읽지 않고, 파싱 실패를
   빈 계획으로 넘기지 않는다(빈 계획은 "재현할 것이 없다"로 읽힌다).
2. **전제는 세 값이다** — `match` / `mismatch` / `unknown`. `unknown`은 지문이 없거나,
   기록 당시 잴 수 없었거나, 지금 잴 수 없거나, **재료(`inputs`)가 달라 비교가 성립하지 않는**
   경우다. 마지막은 값이 우연히 같아도 `unknown`이다.
3. **불일치는 무엇이 다른지까지 말한다** — `gitHead`인지 `workingTree`인지. 사용자가 할 수 있는
   일이 다르기 때문이다.
4. **검사는 어떤 전제에서도 거부하지 않는다.** 쓰지 않으므로 거부할 것이 없다.
5. **적용은 `match`가 아니면 자동으로 진행하지 않는다.** `mismatch`는 **기대 지문을 명시하는**
   확인으로 넘을 수 있다(`--accept-fingerprint`). 플래그 하나로 넘을 수 있으면 "무엇이 다른지
   보지 않고 강행"이 가능해지고, 그러면 3번 규칙이 무의미해진다. **`unknown`은 확인이 있어도
   넘지 못한다** — 볼 수 없는 차이에 대한 확인은 아무 내용도 담지 않는다.
6. **재현 단계도 Policy Gate를 그대로 지난다**(적용기를 만들 때). 기록에 있다는 것이 승인
   근거가 되면 export 파일 하나로 임의 명령을 돌리는 경로가 생긴다.

### 21.3 검사는 지문 비교로 끝나지 않는다 — patch가 붙는지까지 본다

지문이 다르다는 사실만으로 "재현 불가"라고 말하면 실제로는 붙을 수 있는 기록까지 버린다.
그래서 검사는 각 단계를 **정적으로 확인**한다. 여기서 지켜야 하는 것이 둘이다.

- **순차 적용을 흉내 낸다.** patch 2는 patch 1이 적용된 결과에 붙는다. 각 patch를 디스크의
  현재 내용에 대고 검사하면 **같은 파일을 두 번 고친 기록이 전부 거짓 실패**로 나온다.
  메모리에 겹침을 두고 앞 단계의 결과를 반영해 가며 검사한다(디스크는 건드리지 않는다).
- **명령을 만나면 흉내를 멈춘다.** `run_command`가 무엇을 바꾸는지는 실행해야 안다. 그 뒤의
  단계는 **실패가 아니라 판정 불가**다. 실패로 부르면 "명령이 만들어 낸 파일에 붙는 patch"가
  전부 재현 불가로 뒤집힌다 — 모르는 것을 아니라고 말하지 않는다.

한 줄 판정에서는 **확실한 실패가 판정 불가를 이긴다.** 하나라도 붙지 않으면 그 계획은 그대로
재현되지 않고, 나머지를 몰라도 그 사실은 이미 확정이다.

기록에서 **실패했던 단계**는 계획에 남되 그렇게 표시한다. 재현이 같은 종료 코드를 내면 그건
재현 성공이지 실패가 아니다 — 표시가 없으면 읽는 사람이 반대로 읽는다. (종료 코드가 **없는**
것은 실패가 아니다. 종료 코드를 갖지 않는 도구가 있다.)

### 21.4 지문 조립은 한 곳에만 둔다

재현 검사는 **태스크 없이** 지문을 내야 한다(감사자에게는 DB도 태스크도 없다). 그래서 지문
계산을 `TaskHost`에서 떼어 `reproduce::fingerprint`로 옮기고, **git 호출만 호출자가 준다.**
`TaskHost`는 Policy Gate를 지나는 러너를 넘기고, 태스크 없는 경로는 읽기 전용 러너를 넘긴다.

조립을 두 벌 두지 않는 이유: 같은 워크스페이스가 경로에 따라 다른 지문을 내면 **비교 자체가
무너진다.** 그리고 게이트를 지나지 않는 경로가 생긴 이상, 그 경로가 쓸 수 없다는 것이 주석이
아니라 **코드에서 확인 가능해야** 한다 — 읽기 전용 러너는 `rev-parse`/`status`/`diff` 외의
하위 명령을 거부한다.

### 21.5 적용기 — 판정은 "단계가 다 돌았다"가 아니다

`tomverse-host reproduce --file <export.json> --apply`. 검사가 기본이고 적용이 플래그인 이유:
쓰는 쪽이 기본이면 실수의 대가가 남의 워크스페이스에 남는다.

**① 각 단계는 Policy Gate를 그대로 지난다.** 기록에서 온 요청도 새 요청과 같은 판정을 받고,
승인이 필요한 단계는 승인을 받는다. 이게 없으면 **조작된 export 파일 하나가 임의 경로에 쓰거나
임의 명령을 돌리는 경로**가 된다 — 워크스페이스 밖 경로를 담은 export가 실제로 막히는지를
테스트가 확인한다. 같은 이유로 **모르는 도구 이름은 추측해서 실행하지 않고 멈춘다.**

**② 인자는 기록된 것을 그대로 쓴다.** 새로 조립하면 원칙 6의 보장("승인 화면에 보인 argv가
실제 실행된 것")이 재현에서 깨진다.

**③ 첫 실패에서 멈추고, 스스로 되돌리지 않는다.** 실패 뒤에도 계속 적용하면 기록과도 다르고
시작 상태와도 다른 제3의 상태가 남는다. 되돌리기를 자동으로 하지 않는 이유는 **되돌릴 대상이
분명하지 않기 때문**이다 — 불일치를 확인으로 넘겨 시작했다면 워크스페이스에는 이미 남의 변경이
있었고, 우리가 아는 "시작 상태"는 지문 하나(내용이 아니다)뿐이다. 대신 어디까지 갔는지와 각
단계의 pre-image 참조를 보고에 남긴다. 되돌리는 것은 사용자의 판단이고 우리는 재료를 준다.

**④ 종료 코드는 기록과 견준다.** `ToolStatus::Ok`은 "명령이 성공했다"가 아니므로, 기록이 1이면
재현도 1이어야 **같은 것을 재현한 것**이다. 기록에 종료 코드가 없으면 비교할 수 없으므로 0이
아닌 것만 보고 멈추고, 멈춘 이유에 둘 다 실어 "비교하지 못했다"가 드러나게 한다.

**⑤ 판정은 완주가 아니라 대조다.** `completed`(단계가 다 돌았다)와 `outcome`(기록과 같은 내용이
됐다)은 **다른 사실**이고, 한 값으로 합치면 돌기만 하고 결과가 다른 재현이 성공으로 읽힌다.
대조는 기록된 각 경로의 최종 내용 해시와 디스크를 견주며, `Diverged`가 `Unknown`을 이긴다.
**대조할 것이 하나도 없으면 성공이 아니라 `Unknown`이다** — 빈 집합에 대해 참인 명제를 성공으로
보고하면 기록이 비어 있을수록 재현이 잘된 것처럼 보인다.

### 21.6 적용기를 만들자 감사 기록의 구멍 둘이 드러났다

적용기가 "기록과 같아졌는가"를 물으려 하자, 기록에 그 질문의 답이 없었다.

**① 최종 내용이 기록되지 않고 있었다.** `file_mutations` 테이블에는 `post_sha256`이 있는데
export가 그걸 빼고 내보냈다. 그래서 재현기가 말할 수 있는 것은 "단계가 다 돌았다"뿐이었고,
그건 6.3절이 약속한 "최종 상태 복원"의 확인이 아니다 — **확인할 수 없는 약속은 약속이 아니다.**
export 형식을 v2로 올려 내용 해시와 존재 여부를 담는다(본문은 여전히 담지 않는다 — 해시는
판정에 충분하고, 본문은 밖으로 나가면 안 된다). v1 기록도 계속 읽되, 그 경우 결과 판정은
`Unknown`이다. 읽기를 거부하지 않는 이유: v1으로도 **적용까지는 정확히** 할 수 있고, 못 하는
것은 판정뿐이다.

**② 종료 코드가 대개 사라지고 있었다.** export의 `recordedOutcome.exitCode`는 출력 artifact에서
꺼내는데, 명령 출력이 16KB 이하면 **artifact가 아예 만들어지지 않는다.** 게다가 이벤트 쪽
요약(`summarize_output`)이 4KB를 넘는 출력을 자르면서 `exitCode`를 함께 버리고 있었다. 즉
"명령이 실패했다는 사실"을 감사 기록이 대부분의 경우 담지 못했다 — 6.3절이 exitCode를 넣은
이유를 정면으로 어긴다.

고친 방향은 둘 다 **없는 것을 새로 저장하는 대신 있는 곳에서 읽는 것**이다. `task_events`가
진실의 원천이므로(원칙 7) `TOOL_COMPLETED` 페이로드에서 종료 코드를 읽고, 요약은 잘라도
정수 하나는 남긴다. **요약은 크기를 줄이는 것이지 사실을 줄이는 것이 아니다.**

이 둘은 재현기를 만들지 않았으면 드러나지 않았을 것이다. 기록을 **읽기만 하는** 도구는
기록이 비어 있어도 잘 돌기 때문이다 — 기록으로 무언가를 **하려고** 해야 빈 곳이 보인다.

### 21.7 판정을 종료 코드에 싣지 않는다

검사도 적용도 종료 코드는 "명령이 판정을 냈는가"만 말한다. 판정에 실으면 **"오류"와
"재현 불가"가 같은 값**이 되고, 그 둘은 읽는 사람이 해야 할 일이 전혀 다르다.
판정은 JSON 안에 있다.

**DB는 검사도 적용도 열지 않는다.** 재현은 태스크가 아니고 태스크 상태를 바꾸지도 않는다.
여는 순간 감사자의 머신에 없던 `state.db`가 생긴다.

## 22. worktree 격리 — 루트를 바꾸는 것이 전부다 (M2)

product-strategy 8.2절 "Git worktree · 브랜치별 격리"의 출시 기준은 **생성·격리 실행·정리**다.

### 22.1 Policy Gate에 분기를 만들지 않는다

격리 실행은 `WorkspaceRoot`를 worktree 경로로 주는 것이 전부다. 게이트 코드는 자기가 worktree
안에 있는지조차 알 필요가 없다.

**"worktree 모드"라는 분기를 만들지 않은 것이 요점이다.** 분기를 만들면 게이트가 두 규칙을 갖게
되고, 두 규칙 중 하나는 언젠가 덜 검사된다 — 그 순간 그 분기가 우회 지점이 된다. 지금은 e2e가
본체 파일이 바뀌지 않았다는 것으로 격리를 확인하는데, 그 확인이 게이트의 **원래 규칙**을 확인하는
것이기도 하다.

### 22.2 저장소 **안에** 만들지 않는다

안에 만들면 부모 워크스페이스의 게이트 루트가 그 디렉터리를 포함한다. 그러면 본체에서 도는
태스크가 격리된 트리의 파일을 고칠 수 있고, **격리라고 부르는 것이 격리가 아니게 된다.**
상태 디렉터리(`--db`가 사는 곳) 아래 `worktrees/`에 만든다 — 태스크 기록과 수명이 같아 정리
시점도 같다.

### 22.3 모델은 worktree를 만들 수 없다

`worktree.rs`에는 `ToolRequest`가 없다. Node도 모델도 이 코드를 호출할 수 없고 호스트(사람이
시작한 명령)만 부른다. 이유는 원칙 2다 — worktree 생성은 새 경로를 만들고 **그 경로가 곧 다음
태스크의 게이트 루트가 된다.** 모델이 루트를 고를 수 있으면 게이트는 게이트가 아니다.

### 22.4 브랜치 이름은 인자이자 경로 조각이다

argv 배열을 쓰는 것(원칙 6)만으로는 부족하다. 원칙 6이 막는 것은 **셸 재해석**이고,
`--force` 같은 이름이 인자 자리에 오는 것은 **git 자신의 옵션 해석**이다. 그래서 두 가지를
따로 막는다.

- `-`로 시작하는 이름 거부 + 호출부에서 `--`로 옵션 끝 표시(방어 두 겹).
- `/`·`..`·`\` 거부 — 파생 디렉터리 이름이 상위로 탈출하면 격리가 깨진다.

git이 허용하는 이름 전부를 받지는 않는다(`feature/x`는 못 받는다). **못 받는 것을 조용히 바꾸지
않고 거부한다** — 이름을 우리가 바꾸면 사용자가 만든 브랜치와 다른 브랜치가 생긴다.

### 22.5 말하지 않으면 사용자가 정반대로 읽는 두 가지

**① 본체의 커밋되지 않은 변경은 따라오지 않는다.** worktree는 커밋에서 시작한다. 말하지 않으면
사용자는 자기가 방금 고친 코드에 대해 태스크가 돈다고 믿고, 결과 diff를 보고 **"모델이 내
수정을 되돌렸다"** 고 읽는다. 그래서 본체가 더러울 때만 그 사실을 알린다(깨끗하면 말할 것이 없다).

**② 재사용은 재사용이라고 말한다.** 같은 브랜치로 다시 돌리면 기존 트리를 쓰는데, 거기에는
이전 실행의 잔해가 있을 수 있다. "새로 만들었다"로 보고하면 깨끗한 상태를 가정하게 된다.

### 22.6 정리는 기본적으로 지우지 않는다

- **더러운 트리는 거부한다.** `--force`는 사용자의 커밋되지 않은 작업을 버리는 행위라 우리가
  대신 고를 수 없다. 그리고 그 거부는 **도구의 실패가 아니므로** 종료 코드에 싣지 않는다 —
  실으면 "git이 깨졌다"와 "사용자가 정할 일이 남았다"가 같은 값이 된다(`reproduce`와 같은 규칙).
- **우리가 만든 것만 정리 대상이다.** `git worktree list`에는 사용자가 손으로 만든 것도 나온다.
  접두사 `tomverse-`로 구별하며, 목록 출력은 남의 트리도 함께 보여주되 `ours` 필드로 가른다.
- **판정할 수 없으면 더럽다고 본다.** git 상태를 읽지 못하는 트리를 깨끗한 것으로 간주해 지우는
  것보다, 남겨두고 사람이 보게 하는 편이 낫다(fail-closed).

### 22.7 아직 하지 않은 것

- ~~**UI 배선.**~~ → 38절. 그런데 막고 있던 것은 화면이 아니라 **격리의 수명**이었다 — 게이트
  루트가 sidecar 수명과 묶여 있어 태스크마다 바꿀 수 없으므로, 여는 시점에 고른다(38.1절).
  그리고 루트를 그대로 바꾸면 `workspace_id`가 따라 바뀌어 등록이 사라진다(38.2절).
- **고아 트리 회수.** 앱이 비정상 종료되면 트리가 남는다. `INTERRUPTED` 확정과 같은 자리에서
  `ours`를 훑어 목록에 올리는 것이 자연스럽지만, **자동으로 지우지는 않는다** — 그 안에 사용자가
  꺼내야 할 변경이 있을 수 있고, 22.6의 규칙이 여기에도 그대로 걸린다. (38절이 목록과 정리를
  화면에 냈으므로 **사람이 지울 수는 있다**. 자동으로 찾아 올리는 것만 남았다.)
- ~~**태스크 기록과의 연결.**~~ → 38.3절. 37절이 만든 자리에 그대로 들어갔다 — **어디서 도는가도
  "무엇을 가지고 도는가"의 한 줄이다.**

## 23. MCP — 문 하나를 두고 그 문의 위험도를 안다 (M2)

product-strategy 8.2절 기준: **"MCP 서버 등록, 그 도구가 `ToolRequest`로 변환되어 Policy Gate 통과"**.

### 23.1 Rust가 소유한다 — 선택이 아니라 원칙 2의 결과

MCP 서버는 **프로세스**다. 그것을 띄우고 stdio로 말하는 것은 정확히 원칙 2가 Node에게 금지한
일이고, `packages/sidecar/test/boundary.test.ts`가 소스 수준에서 막고 있다. Node가 MCP 클라이언트를
가지면 "Node는 셸을 실행하지 않는다"가 거짓이 된다 — **MCP 서버 하나가 곧 임의의 프로그램**이기
때문이다. 그래서 Node는 `mcp_call` 도구로 요청만 하고, 띄울지는 Rust가 정한다.

### 23.2 닫힌 집합에 문 하나만 낸다

MCP 도구는 서버마다 동적이다. 그것을 `ToolName`으로 열면 Policy Gate의 exhaustive match가
무너지고 **"분류되지 않은 도구"** 가 생긴다. 대신 `mcp_call` 한 칸을 내고, 그 문의 위험도는
우리가 안다: **모른다, 그러므로 승인이다.**

`ToolName`에 변형을 추가하자 컴파일러가 결정해야 할 두 자리(게이트 분류, 런타임 dispatch)를
정확히 지목했다. 닫힌 집합을 유지하는 값이 여기서 그대로 나온다.

### 23.3 정책으로 낮출 수 없다

`mcp_call`은 언제나 `RequireUserApproval`이며 **`task_policy`를 보지 않는다.** 보면 언젠가
누군가 완화 조건을 넣는다.

특히 `auto_approve_workspace_writes`가 여기 걸리면 안 된다. 그 스위치의 뜻은 "내 저장소 안의
편집을 자동 승인"인데, MCP 도구는 **워크스페이스 안에서 도는지조차 우리가 모른다.** 걸리게
두면 사용자는 저장소 편집을 승인한다고 생각하면서 게이트 밖의 임의 도구를 자동 승인하게 된다.
`run_command`의 allowlist 완화 경로도 두지 않는다 — allowlist는 "이 명령이 무엇을 하는지 안다"에
기대는데 그 전제가 여기서는 성립하지 않는다.

### 23.4 보이는 것이 나가는 것이다 (원칙 6의 MCP판)

승인 화면이 보는 `normalizedTarget`에 **서버·도구·인자가 그대로** 들어간다. 요약하거나 자르지
않는다 — 자르면 사용자가 승인한 것과 실제 나가는 것이 달라지고, 그게 이 도구에서 가장 피해야 할
일이다. 그리고 **무엇을 승인하는지 정하지 못하는 요청은 승인 대상이 아니라 거부 대상**이다
(`arguments`가 객체가 아니면 거부한다 — MCP는 named arguments를 쓰므로 배열이면 우리가 잘못
조립한 것이다).

### 23.5 우리가 보장하지 못하는 것을 화면이 말해야 한다

**보장한다**: 어떤 서버의 어떤 도구를 어떤 인자로 불렀는지가 승인 화면에 보이고 이벤트에 남는다.

**보장하지 못한다**: 그 서버가 무엇을 하는지. MCP 서버는 우리 게이트 밖에서 파일을 고치고
네트워크를 쓸 수 있다. **서버를 등록하는 순간 사용자는 게이트 밖의 능력을 들여온다.** 이걸
흐리게 말하면 사용자는 우리 게이트가 MCP 도구의 행동까지 검사한다고 믿는다 — 전송 투명성에서
"Local only"가 경로 이름까지 안 나간 것으로 읽히던 것과 같은 종류의 거짓말이다.

그래서 **등록은 사용자만** 한다. 모델이 서버를 추가하는 경로는 없고, 그것이 이 기능의 안전
모델 전부다.

### 23.6 프로그램 자리에 명령 문자열을 넣을 수 없다

`program`과 `args`를 나눠 받는다(원칙 6). 처음에는 셸 메타문자(`|&;><`)만 봤는데
`sh -c 'rm -rf /'`가 통과했다 — 거기엔 메타문자가 없다. 그렇다고 공백을 거부할 수도 없다:
Windows의 정상적인 경로가 `C:\Program Files\nodejs\node.exe`다.

그래서 **인자가 붙었다는 표시**를 본다: 따옴표, 그리고 공백 뒤의 `-`. 완벽한 판정이 아니라는
것도 적어 둔다 — 여기서 잡으려는 것은 공격이 아니라 흔한 설정 실수이고, 공격 쪽은 23.5의
"등록은 사용자만 한다"가 막는다.

### 23.7 환경은 비우고 **이름을 대서** 되돌린다

부모 환경을 물려주면 API 키가 우리가 모르는 프로세스로 나간다. 그래서 `env_clear()`인데,
그것만 하면 PATH가 없어 `node`·`npx`를 찾지 못한다(실측으로 `No such file or directory`가
났고, 그 오류는 "서버 설정이 틀렸다"로 읽히기 쉽다).

되돌리는 것은 `PATH`·`SystemRoot`·`PATHEXT`·`TEMP`·`TMP`뿐이다. 목록에 없는 것은 넘어가지
않으므로 `OPENAI_API_KEY` 같은 값은 서버가 보지 못하며, 그 사실을 테스트가 확인한다.
stderr도 물려주지 않는다 — 서버 로그가 우리 stdout에 섞이면 NDJSON 프레임이 깨진다.

### 23.8 줄 프레이밍은 두 번 만들지 않았다

MCP도 NDJSON이므로 `sidecar.rs`의 `read_framed_line`을 그대로 쓴다. 상한을 넘긴 줄에서 **계속
읽지 않는다**는 규칙(프레임 동기를 잃은 채 파싱하면 조용히 엉뚱한 값을 쓴다)은 이미 한 번 정한
것이고, 규칙이 두 곳에 있으면 언젠가 한쪽만 고쳐진다.

그리고 **알림을 응답으로 착각하지 않는다.** 서버는 id 없는 notification과 로그를 섞어 보내며,
그것을 결과로 쓰면 조용히 틀린다. 우리 id의 응답이 올 때까지 읽고, 파싱 불가한 줄은 무시한다
(서버가 stdout에 로그를 섞는 일이 흔하고, 그때마다 세션을 죽이면 쓸 수 있는 서버가 거의 없다).

### 23.9 spawn 경로는 자동 검증 밖이다

프로토콜 처리는 in-memory 스트림으로 전부 테스트된다. 그러나 **프로세스를 실제로 띄우는
부분**(env 복구, stderr 차단, 핸드셰이크 실패 시 정리)은 그렇지 않다. `cargo test`에 넣으면
신뢰 경계 크레이트가 Node에 의존하게 되는데, `core/`를 tauri에서 떼어낸 이유가 바로 그런
인질을 피하는 것이었다.

그래서 Windows 전용 코드와 같은 처리를 한다 — 자동 검증 밖이라는 것을 이름으로 말하고 사람이
돌리는 확인기를 남긴다: `cargo run --example mcp_probe -- examples/fixtures/echo-server.js`.
실측으로 통과했고(서버가 stdout에 섞어 보낸 로그 줄도 프레이밍이 건너뛰었다), 그 실행이
23.7의 PATH 문제를 드러냈다.

### 23.10 아직 하지 않은 것

- ~~**UI 등록 화면.**~~ → 29절. 화면은 프로그램과 인자를 따로 받으므로 쉼표 한계를
  물려받지 않는다.
- ~~**도구 목록을 모델에게 보여주는 것.**~~ → 31절. 막고 있던 전송 집계 배선이 7.2절에서
  생겼으므로 이제 싣는다. **그리고 이 항목은 미해결로 적혀 있는 동안 더 큰 사실을 가리고
  있었다**: 목록이 없으면 모델은 `mcp_call`을 부를 수 없고, 그래서 서버를 등록해도 아무 일도
  일어나지 않았다(31.1절).
- ~~**서버별 도구 허용목록.**~~ → 32절. **완화책으로 든 "승인은 매번 받는다"가 충분하지
  않았다** — 매번 묻는 것은 매번 예라고 누르게 만든다. 목록 밖은 묻지 않고 거부하며,
  프롬프트에 실리는 집합도 같은 곳에서 좁아진다.
- **원격(HTTP/SSE) 서버.** 8.2 표의 "이후 깊이 확장" 열에 있다.

## 24. Autopilot — 무인 실행, 그리고 "물을 사람이 없다"는 사실 (M3)

product-strategy 8.2절 기준: **"무인 실행하되 검사 실패 시 정지. 승인 정책은 그대로 적용"**.

### 24.1 `--approve auto`는 Autopilot이 아니다

헤드리스 호스트에는 원래 모든 승인을 그대로 통과시키는 `--approve auto`가 있었다. 무인 실행을
붙이라는 요구를 받았을 때 가장 가까이 있던 것이 그것이었고, 그대로 이름만 바꾸면 하루 만에
"Autopilot"이 생긴다.

그러나 그건 8.2절이 말한 기능이 아니다. **"승인 정책은 그대로 적용"** 이라고 적혀 있고,
전부 승인하는 모드에서는 Policy Gate의 `RequireUserApproval`이 아무 뜻도 갖지 않는다 —
MCP 호출까지 포함해서(23.3절). `auto`는 테스트 하네스가 승인 왕복을 건너뛰기 위한 도구이며
**제품의 실행 모드가 아니다.** 코드 주석과 usage 양쪽에 그렇게 적었다.

Autopilot의 바른 해석은 반대다: **게이트 분류는 그대로 두고, 승인이 필요한 지점에 닿으면
멈춘다.** 사람이 없다는 것은 "아무나 대신 승인해도 된다"가 아니라 "그 질문에 답할 수 있는
권위가 지금 없다"는 뜻이다(product-strategy 16절 — 요구에 대한 최종 권위는 사용자다).

### 24.2 멈춘 것을 "거부"라고 부르지 않는다

`ApprovalGateway`가 `Granted`/`Denied` 둘뿐이었으므로, 무인 정지를 붙이는 가장 짧은 길은
`Denied`를 반환하는 것이었다. 그렇게 하면 감사 로그에 `APPROVAL_DENIED`가 남고 최종 보고가
**"사용자가 거부했습니다"** 라고 말한다. 사용자는 그 자리에 없었다.

그래서 세 자리에서 두 사실을 나눴다. 나누는 비용은 컴파일 오류 몇 개고, 뭉개는 비용은
기록이 거짓말하는 것이다:

| 층 | 나눈 것 |
|---|---|
| `ApprovalOutcome` | `Denied { note }` vs `Unattended` |
| `ApprovalState` | `DeniedByUser` vs `Unattended` (그리고 `NotRequired`, `GrantedByPolicy`) |
| `ToolResult` | `denialKind: "policy" \| "user" \| "unattended"` |
| 이벤트 | `APPROVAL_DENIED` vs `APPROVAL_UNATTENDED` vs `APPROVAL_AUTO_VERIFICATION` |
| `FailureReason` | `unattended_stop` vs `unverified_unattended` |

`ApprovalState`가 `bool`을 대신한 것도 같은 이유다. `approved: bool`은 "승인됐다/안 됐다"만
말할 수 있어서 **"물을 일이 아니었다"(`NotRequired`)와 "물었는데 거부됐다"가 같은 값**이 된다.
`false`가 두 사실을 겸하면 결과 기록이 어느 쪽인지 잃는다.

승인 결과를 받는 자리도 `match`의 **값**으로 바꿨다. 왕복 전에 `DeniedByUser`를 미리 넣어 두는
방어 코드가 있었는데, 그건 "어떤 경로로도 승인 없이 빠져나가지 않는다"를 사람이 지키는 규칙으로
만든다. 값을 match에서 받으면 `ApprovalOutcome`에 변형이 늘 때 컴파일러가 여기를 지목한다.

### 24.3 정책은 Rust와 TS 양쪽에 손으로 조립된다 — 그리고 그게 실제로 틀렸다

`TaskPolicy`는 Rust 구조체와 TS 타입 양쪽에 있고, 헤드리스 호스트가 sidecar로 보내는 policy
JSON은 **Rust 구조체를 직렬화한 것이 아니라 손으로 조립한 map**이다. `unattended`를 Rust에
추가하고 그 map에 넣는 것을 잊었고, sidecar에는 `unattended: false`가 도착했다. e2e가 잡았다.

증상이 고약한 이유는 값이 **없는** 게 아니라 그럴듯한 기본값이 도착한다는 점이다. sidecar는
사람이 있다고 믿었고, 그래서 24.4절의 결함이 그 위에서 났다. e2e가 잡았지만 그건 우연이다 —
e2e가 그 필드를 보지 않았다면 아무도 못 잡았다.

파생시키지 않은 이유는 두 타입의 필드가 일대일이 아니기 때문이다(`budgetUsd`·`modelPins`처럼
TS에만 있는 것이 있고, sidecar가 관여하지 않는 Rust 전용 값도 생길 수 있다). 그래서 map은
손으로 남는다. **남는다면 지켜야 한다** — 처음에는 그 자리에 주석만 두었는데, 주석은 검사가
아니다. `packages/toolchain/test/policyBridge.test.ts`가 세 파일에서 **유도한** 두 규칙으로
지킨다:

- **호스트가 Rust 정책에 세팅한 필드 중, 그 serde 이름이 TS `TaskPolicy`에도 있는 것은 반드시
  map에 있어야 한다.** 조건이 둘인 이유가 중요하다 — Rust에만 있는 정책을 넣을 자리를 남기되,
  *양쪽에 같은 이름이 있다*는 것은 두 프로세스가 그 값을 함께 쓰기로 했다는 뜻이고, 함께 쓰기로
  한 값을 한쪽에만 세팅하면 다른 쪽은 기본값을 자기 사실로 믿는다.
- **map의 모든 키는 TS `TaskPolicy`에 있어야 한다.** 오타는 값을 비우지 않고 *다른 키*를
  만들며, 받는 쪽에서는 `undefined`라 기본값이 적용된다 — 위와 정확히 같은 방식으로 조용하다.

판정 기준을 목록으로 적지 않은 이유는 늘 같다: 손으로 적은 목록은 **갈라질 수 있는 곳을 셋에서
넷으로 늘린다.** 파서가 대상을 못 찾으면 빈 집합이 아니라 예외를 던진다 — "필드 0개"로 조용히
통과하면 검사가 있는 채로 아무것도 검사하지 않게 된다.

### 24.4 검증이 침묵한 결과를 완료로 보고하지 않는다

여기서 실제 결함이 하나 나왔다. 무인 실행에서 patch는 적용됐는데 검증 명령은 승인을 못 받아
돌지 못했고, 태스크는 **`completed`로 보고됐다**. 검증 리포트는 `could_not_run`이었다.

이건 CLAUDE.md가 npm shim 사례에서 이미 경고한 결말 그대로다 — *"정상 수정 작업이 검증 없이
완료로 보고"*. 사람이 보고 있으면 "검증되지 않았습니다"가 달린 완료도 정직한 보고지만,
**무인 실행에는 그 문장을 읽을 사람이 없고** 그 결과 위에 다음 단계가 쌓인다.

그래서 `policy.unattended`일 때 검증이 `not_configured`/`could_not_run`이면 완료로 보고하지
않고 `unverified_unattended`로 실패시킨다. **`unattended_stop`과 나눈다**: 저쪽은 승인
지점에서 멈춰 아무것도 바꾸지 않은 것이고, 이쪽은 바꿨는데 검증을 못 돌린 것이다 — 사용자가
해야 할 일이 다르다(전자는 승인, 후자는 워크스페이스 확인).

이것이 8.2절 **"검사 실패 시 정지"** 의 실제 구현이다. "검사가 실패하면"에는 **검사가 돌지
못한 경우가 포함된다** — 포함시키지 않으면 검사를 못 돌리는 것이 검사를 통과하는 가장 쉬운
길이 된다.

### 24.5 그래서 Autopilot은 끝까지 가지 못했다 — 남은 조각은 명령의 **출처**였다

24.4의 규칙을 넣고 나니 Autopilot은 **언제나** 검증에서 멈췄다. 검증 명령(`npm test` 등)은
게이트에서 `allowlist conditional`로 분류되어 승인을 요구하고, 무인이므로 거기서 끝난다.
"아무것도 못 하거나, 해도 완료되지 않는" 기능은 8.2절이 말한 Autopilot이 아니다.

레버를 하나 더 만드는 것은 위험한 방향이다 — 승인 우회 플래그는 이 저장소가 반복해서 거부해 온
것이다. 그런데 검증 명령에는 다른 기능에 없는 성질이 하나 있다: **모델이 고르지 않는다.**
`verify::detect_commands`가 `package.json`·`Cargo.toml`·`.sln`에서 유도하며, 그렇게 만든 이유는
원래 "Node가 넘긴 명령을 그대로 실행하면 검증 명령을 바꿔치기해 통과시키는 경로가 열린다"였다.
그 성질이 여기서 그대로 근거가 된다.

그래서 `autoApproveVerification`은 우회 플래그가 아니라 **출처가 확인된 명령에 대한 사용자의
사전 승인**이다. 게이트 분류는 바뀌지 않는다 — 바뀌는 것은 "누가 답하는가"뿐이고, 그 답은
`APPROVAL_AUTO_VERIFICATION`으로 남되 `APPROVAL_GRANTED`로 남지 **않는다**(24.2의 규칙이 여기도
적용된다: 사람이 이 요청을 보고 답한 것이 아니다).

**그런데 "모델이 고를 수 없다"는 그대로는 참이 아니다.** 모델은 명령을 지어낼 수 없지만
**매니페스트를 고칠 수 있다.** `scripts.test`를 바꿔 놓고 검증을 부르면 모델이 고른 명령이
무인 자동 승인을 받는다. 그래서 자동 승인의 대상 집합은 **태스크 시작 시점에 고정**한다
(`TaskProfile::new`에서 `detect_commands`를 한 번 부르고 그 결과를 들고 있는다).

**한동안 그 고정이 실제로는 태스크 시작 시점이 아니었다.** `TaskHost::new`에서 일어났고,
헤드리스 호스트는 태스크마다 새로 만들어지므로 같은 말이었지만 호스트가 워크스페이스 수명을
갖는 UI 경로에서는 "워크스페이스를 열 때"였다. 정책의 수명을 태스크로 옮기면서 함께 고쳤다
(ui-wireframes 3.16.2절) — 둘 다 "정책과 그로부터 유도된 것의 수명이 태스크가 아니었다"는
하나의 사실이었다. 실행 중에
매니페스트가 바뀌면 새 명령은 자동 승인되지 않고, 그 태스크는 무인에서 멈춘다 — 그게 맞다.

매칭은 세 축을 **전부** 본다. 하나라도 느슨하면 레버가 검증 밖으로 샌다:

- 도구가 `run_tests`인가 (검증 러너가 쓰는 이름이다 — 같은 argv라도 `run_command`로 오면 아니다)
- cwd가 워크스페이스 루트인가 (탐지된 명령은 전부 루트에서 돈다)
- program과 args가 **완전히** 같은가 (prefix 비교였다면 `npm test --ignore-scripts`가 딸려 온다)

세 축과 고정 시점을 각각 깨 보고 테스트가 실패하는 것을 확인했다. e2e도 같은 방식으로 확인했다 —
`is_pinned_verification`을 항상 `false`로 만들면 그 실행은 `unverified_unattended`로 끝난다.

### 24.6 완료를 "완료됐다"로만 확인하지 않는다

이 기능의 최악의 결말은 **검증을 건너뛰고 완료로 보고하는 것**이다. 그러므로 Autopilot의
성공 경로 테스트가 `status == "completed"`만 본다면, 그 테스트는 바로 그 결말을 통과시킨다.
e2e는 `verificationReport.overall == "pass"`와 **`test` 체크가 실제로 `PASSED`인지**까지 본다.

### 24.7 아직 하지 않은 것

- ~~**UI 배선.**~~ 화면에 무인 실행 토글이 있고(3.16.2절), 무인 정지의 처방은 24.8절이 만든
  패널이 보여준다. 시한 입력도 같은 자리에 붙였다(39.4절).
  ~~특히 `unattended_stop`으로 멈춘 태스크를 **사람이 이어받아 승인하고 재개하는 경로**가 없다 —
  지금은 다시 돌려야 한다.~~ → 24.8절에서 **문항을 갈라 절반을 닫았다.** 재개(진행 중 상태
  복원)는 여전히 없지만, "무엇을 켜면 지나가는가"는 `tomverse-host blocked`가 기록에서 유도한다.
- **`--auto-approve-writes`와의 관계를 사용자에게 설명하는 것.** 무인에서 의미 있는 실행을
  하려면 쓰기 정책도 미리 넓혀야 하는데, 두 스위치가 함께 켜졌을 때 무엇이 허용되는지는
  지금 usage 텍스트에 흩어져 있다.
- ~~**정책 map의 필드 동기화 검사** (24.3절).~~ → 24.3절에서 해결(`policyBridge.test.ts`).
  실제로 났던 결함 재현·오타·파서 실패 셋을 각각 심어 검사가 실패하는 것을 확인했다.
- ~~**시간 상한.**~~ → 39절. 그런데 그 문장은 절반만 맞았다 — 상한이 없던 것이 아니라 있던
  상한이 **기다리기를 그만두는 시각**이었고, 그 시각이 지나도 태스크는 계속 돌고 있었다(39.2절).
  **횟수 상한은 그대로 남아 있다**(39.8절).

## 24.8 무인 정지의 처방 — "재개"는 두 가지를 묶은 말이었다

24.7절은 이 자리를 *"사람이 이어받아 승인하고 **재개**하는 경로가 없다"* 라고 적었다. 그
문장이 하나의 기능처럼 읽혀서 크고 비싼 일로 보였는데, 나눠 보니 둘이었다 — 21.1절 재현
러너에서 만난 것과 같은 모양이다:

1. **멈춘 지점에서 이어서 계속하기.** 오케스트레이터의 진행 중 상태(초안, 계획, 루프 카운터)를
   지속화해야 한다. 프로세스 경계를 넘는 되돌리기 비싼 결정이고, 지금 그 값어치를 모른다.
2. **사람이 무엇을 승인해야 하는지 알기.** 이미 `task_events`에 있다. 유도하면 된다.

2를 하면 1의 압박이 대부분 사라진다: 다시 돌리는 대가가 *"무엇을 바꿔야 할지 모른 채
돌리는 것"* 에서 *"정책 하나 켜고 돌리는 것"* 으로 줄어든다. 그리고 1을 하더라도 2는 어차피
필요하다. 그래서 2를 먼저 한다 — `tomverse-host blocked --task <id>`(읽기 전용).

### 24.8.1 처방은 게이트가 판정하는 **그 자리**에서 나온다

"어떤 규칙이면 어떤 스위치"를 표로 따로 적으면, 규칙이 바뀔 때 표가 조용히 어긋난다. 대신
승인 결정 자체가 자기를 넓힐 레버를 함께 말한다(`PolicyLever`, `PolicyDecision.unblockedBy`).

그리고 승인 결정을 만드는 길을 **하나로 좁혔다**(`Outcome::needs_approval`). 필드를 직접 채워
만들 수 있게 두면 새 승인 자리를 만든 사람이 레버를 정하지 않고 지나갈 수 있는데, 컴파일러는
필드가 다 찼는지만 보므로 그때 아무 말도 하지 않는다. 인자로 받으면 매번 답을 요구한다 —
**"생각해 보니 사람만"도 `HumanOnly`라고 적어야 하는 답이다.** 그 좁힘이 유지되는지는 소스를
훑는 검사가 지킨다(`the_only_way_to_require_approval_is_the_constructor`).

### 24.8.2 `HumanOnly`가 이 타입의 핵심이다

어떤 승인은 **어떤 정책으로도 낮출 수 없다**: 비밀값 파일 읽기·쓰기, 삭제, MCP(23.3절),
네트워크를 탈 수 있는 명령. 그런 자리에 "이 스위치를 켜세요"를 제안하면 거짓말이고, 사용자는
켜 놓고 다시 돌렸다가 같은 자리에서 또 멈춘다.

그래서 판정에서 **`HumanOnly` 하나가 나머지 전부를 이긴다.** 열리는 것만 세어 처방을 내면
보고서는 "이것만 켜면 됩니다"라고 말하는데 그건 참이 아니다. 열리는 쪽의 플래그는 그래도
알려준다 — 사람이 붙어도 그 왕복은 줄어든다.

한 가지 예외 처리가 있다. 게이트는 conditional allowlist 명령에 `HumanOnly`밖에 말할 수 없다 —
그 명령이 프로젝트가 선언해 둔 검증 명령인지는 고정 집합을 든 `TaskHost`만 안다(24.5절).
게이트에 고정 집합을 넘기지 않는 이유는 게이트를 순수하게 두기 위해서다: 게이트가 태스크
시작 시점의 상태를 들고 있으면 *"args만 보고 처음부터 다시 판정한다"* 가 깨진다. 그래서 아는
쪽이 무인 정지 시점에 고쳐 적는다.

### 24.8.3 읽지 못한 레버를 "사람이 필요하다"로 접지 않는다

레버 필드가 없던 시절의 이벤트를 `HumanOnly`로 접으면, **파싱 실패가 판정을 만든다.** 근거
없이 사용자를 막는 판정이다. 그런 기록은 정지 목록에 남되(정지가 있었다는 것은 사실이다)
판정에는 들어가지 않고, 플래그는 `null`로 남는다 — `null`은 "켤 것이 없다"는 사실이고, 키를
빼면 "아직 안 적었다"와 구별되지 않는다.

### 24.8.4 한계를 적었는데 그 한계가 틀렸다

처음 적은 한계는 *"무인 실행은 **첫** 승인 지점에서 끝나므로 그 뒤는 기록에 없다"* 였다.
**e2e가 그 문장을 반증했다.** 실제 실행의 첫 정지는 baseline 검증 명령이었고 태스크는 거기서
끝나지 않았다 — 검증 거부는 `SKIPPED_WITH_REASON`이 되어(통과로 위장하지 않는다) 실행이
계속되고, 태스크를 끝낸 것은 그 다음의 patch 거부였다. **정지가 둘 기록된다.**

한계는 여전히 있지만 이유가 다르다: 끝나서가 아니라 **경로가 달라져서** 모른다. 막힌 지점
뒤로는 진행이 달라지므로, 플래그를 켜고 다시 돌리면 이번에 도달하지 못한 새 지점에서 또
멈출 수 있다. 그리고 그 한계는 **보고서 안에** 있다(`caveat` 필드) — 모듈 주석은 이 JSON을
먹는 쪽에 도달하지 않는다.

### 24.8.5 처방이 맞는지는 문자열이 아니라 실행으로 본다

배선이 하나라도 끊기면 보고서는 조용히 "켤 것이 없다"고 말하는데, 그건 *사람이 필요하다*는
뜻이므로 **틀린 방향으로 조용하다.** 그래서 e2e는 보고서가 시키는 플래그를 그대로 붙여 다시
돌리고, **그 정지가 사라지는지**를 본다. 남은 처방이 그대로 나오는 것까지 확인한다.

### 24.8.6 아직 하지 않은 것

- **진행 중 상태의 복원**(위 1). 값어치를 알려면 무인 정지가 실제로 얼마나 자주, 어느 단계에서
  나는지를 봐야 한다 — `blocked`가 그 데이터를 만든다.
- **UI에서의 처방 표시.** 지금은 CLI JSON이다.
- **정지 지점에서의 부분 승인.** 사람이 붙었을 때 그 요청 하나만 승인하고 나머지는 무인으로
  두는 것 — M3의 "부분 승인"과 같은 자리에서 만난다.

## 25. Hooks — phase 전환에 사용자 명령을 태운다 (M3)

product-strategy 8.2절 기준: **"주요 phase 전환에 사용자 스크립트 실행. 스크립트 실행도 Policy
Gate 적용"**.

### 25.1 트리거를 Rust가 잡는다 — 그리고 그 자리가 이미 있었다

phase 전환은 Node의 오케스트레이터가 만들지만, 그 사실은 `PHASE_CHANGED` 이벤트가 되어
`db.appendEvent` 요청으로 `TaskHost::append_event`를 지난다. **신뢰 경계 안이다.** 훅을 거기
걸면 Node가 훅이 도는 것을 막을 수 없다 — 막으려면 phase 전환 자체를 보고하지 않아야 하는데,
그러면 태스크가 아무 데도 가지 못한다.

Node에 훅 실행을 맡기는 선택지는 없다. 훅은 임의의 프로그램이고, 그러면 "Node는 셸을 실행하지
않는다"가 거짓이 된다 — MCP에서 정한 것과 같은 규칙이다(23.1절).

훅은 이벤트가 **기록된 뒤에** 돈다. 먼저 돌리면 훅이 실패했을 때 phase 전환 자체가 기록되지
않을 수 있고, 그러면 `task_events`가 진실의 원천이라는 성질이 깨진다(원칙 7).

### 25.2 걸 수 있는 phase를 좁혔다, 그리고 그 좁힘이 조용히 낡을 수 있다

`HOOKABLE_PHASES`는 `TaskPhase`의 부분집합이다 — 사용자가 걸 만한 자리(시작, 실행, 검증, 그리고
끝나는 방식 셋)만 연다. phase는 우리 내부 구현이고 일부는 이름이 바뀔 수 있으므로, 전부를
사용자 계약으로 만들면 이름 하나 바꿀 때마다 계약이 깨진다.

**그 목록이 낡으면 조용하다.** 이름이 바뀐 phase에 걸린 훅은 등록은 되는데 영원히 안 돌고,
사용자에게는 "훅이 동작하지 않는다"로만 보인다. 등록 시점 검증도 이걸 못 잡는다 —
`HOOKABLE_PHASES`와 대조할 뿐이고 낡은 쪽이 바로 그 목록이기 때문이다. 그래서
`packages/sidecar/test/hookPhases.test.ts`가 **양쪽 소스에서 유도해** 부분집합인지 확인한다
(터미널 목록에 대해 2.2절이 하는 것과 같은 처리다).

### 25.3 등록이 승인이다 — 그러나 게이트는 그대로 돈다

훅은 매 phase 전환마다 돈다. 그때마다 승인을 물으면 쓸 수 없는 기능이고, 아무 때나 통과시키면
게이트가 무의미하다. 가르는 근거는 **argv의 출처**다: 훅의 argv는 사용자가 등록할 때 적은
그대로이며 모델은 그 내용에 관여하지 않는다. 24.5절의 검증 명령과 같은 논리인데, 훅 쪽이 더
직접적이다 — 매니페스트에서 유도한 것이 아니라 사용자가 직접 적었다.

그래서 승인이 필요한 분류는 **등록된 argv와 완전히 같을 때만** 통과하고, 그 사실은
`APPROVAL_REGISTERED_HOOK`으로 남는다. `APPROVAL_GRANTED`로 남기지 않는다 — 사람이 그 요청을
보고 답한 것이 아니다(24.2절의 규칙이 여기도 적용된다). `APPROVAL_AUTO_VERIFICATION`과도
나눈다: 잘못 걸렸을 때 고칠 자리가 다르다(저쪽은 정책 스위치, 이쪽은 훅 등록).

판정 근거는 argv뿐이고 `requested_by`는 보지 않는다 — 그건 IPC로 들어오는 값이라 Node가
지어낼 수 있다. **그래서 모델이 같은 argv를 요청하면 이것도 통과한다.** 숨기지 않는다:
사용자가 "이 명령을 매 phase 전환마다 자동으로 돌려라"라고 등록한 이상, 같은 명령이 한 번 더
도는 것은 그 승인의 범위 안이다.

### 25.4 훅은 관찰자다 — 판정을 바꾸지 않는다

실패한 훅은 기록되지만 태스크의 결과를 바꾸지 않는다. 원칙 1이 정한 판정자는 결정론적 검증이고
사용자 훅은 검증이 아니다. 훅이 판정에 끼어들 수 있으면 *"이 도구가 완료라고 한 것은
build/test/lint를 통과했다는 뜻"* 이라는 성질이 훅마다 달라진다.

그리고 **실패한 훅이 뒤따르는 훅을 중단시키지도 않는다.** 등록 순서가 실행 순서이고, 중간
하나가 실패했다고 나머지를 건너뛰면 사용자가 적은 것과 실제 동작이 달라진다.

`ToolStatus::Ok`은 "명령이 성공했다"가 아니므로(CLAUDE.md 함정 기록) `HOOK_EXECUTED`는 종료
코드를 함께 남긴다. 그리고 `affectsVerdict: false`도 같이 남긴다 — 나중에 이 기록을 읽는 사람이
"왜 실패했는데 완료인가"를 묻지 않도록.

이 한계는 **기능이 얕다는 뜻이기도 하다.** 차단형 훅(pre-commit처럼 진행을 막는 것)은 하지
않는다. 패리티 기능은 "일반 사례 동작 + 한계 명시"로 시작한다(8.1절).

### 25.5 게이트를 그대로 적용했더니 훅이 안 돌았다

첫 e2e는 `--hook COMPLETED=node,hook.js`로 걸었고 **훅이 실행되지 않았다.** 원인은 버그가
아니라 설계대로였다: allowlist에 없는 프로그램은 게이트가 기본 거부한다(정책 5절).
`node --test **`는 있지만 `node hook.js`는 없다.

여기서 레버를 만들 수도 있었다 — "등록된 훅은 allowlist를 건너뛴다". 만들지 않았다. 그러면
훅 등록이 **임의 프로그램 실행 경로**가 되고, 게이트의 기본 거부가 이 문에서만 사라진다.
대신 사용자가 지나는 길을 그대로 두었다: 스크립트를 `package.json`에 넣고 `npm run <스크립트>`로
건다. 부수적으로 그 편이 낫다 — 훅이 저장소 안에 남아 팀이 공유하고 이력에 남는다.

그러나 **거부를 실행 시점에 조용히 쌓게 두지는 않는다.** 등록 시점에 게이트에 미리 태워 보고,
확실히 거부될 훅은 그 자리에서 거절하며 지나는 길을 함께 말한다. 이건 미리보기이지 판정이
아니다 — 실제 결정은 실행 시점에 다시 내려진다(그게 신뢰 경계의 규칙이다).

### 25.6 "판정을 바꾸지 않는다"를 e2e로 증명하지 못했다

25.4를 확인하려고 실패하는 훅을 걸고 태스크가 완료되는지 봤다. 그런데 **그 단언은 공허했다.**

처음에는 `COMPLETED`에 걸었는데, 그때는 판정이 이미 정해져 있어서 무엇을 해도 바뀌지 않는다.
`VERIFYING`으로 옮겨도 마찬가지였다 — 훅 실패가 태스크를 실패시키는 코드와 phase 전환을 막는
코드를 각각 심어 봤지만 **둘 다 테스트를 통과했다**(후자는 Node의 `emit`이 이벤트 기록 실패를
삼키기 때문이다). 훅 결과가 판정에 닿는 경로가 지금 아예 없으므로, 이 단언을 깨려면 그 경로를
새로 만들어야 한다.

그래서 **깨질 수 있는 성질로 바꿨다**: 실패하는 훅을 **먼저** 걸고, 뒤따르는 훅이 남긴 파일로
"실패가 나머지를 중단시키지 않는다"를 확인한다. 실패에서 루프를 빠져나가는 구현을 심으면 그
파일이 생기지 않고 테스트가 실패한다. 완료 단언은 남겨 두되 **지금 무엇을 증명하지 않는지**를
테스트 주석에 적었다 — 나중에 그 경로가 생겼을 때 걸리게 하기 위한 것이지, 증거가 아니다.

### 25.7 아직 하지 않은 것

- **차단형 훅.** 25.4의 결정이며, 바꾸려면 "완료 = 검증 통과"의 의미부터 다시 정해야 한다.
- ~~**UI 등록 화면.**~~ → 29절. 화면은 프로그램과 인자를 따로 받으므로 쉼표 한계를
  물려받지 않는다.
- ~~**훅에 컨텍스트를 넘기는 것.**~~ → 33절. 환경변수로 넘기되 **식별자만** 넘기고,
  무엇을 넘겼는지는 `HOOK_EXECUTED`에 남긴다. 프로바이더 전송 집계와는 다른 자리다 —
  훅으로 나가는 것은 공급자로 나가는 것이 아니다.
- ~~**워크스페이스별 훅 등록.**~~ → 29절. 등록은 상태 디렉터리에 남고 워크스페이스를 열 때 붙는다.

## 26. Skills · 커스텀 에이전트 (얕은 버전) — 세 조각이 사는 곳이 다르다 (M3)

product-strategy 8.2절 기준: **"얕은 버전 — 이름 붙인 프롬프트 프리셋 + 도구 허용목록 + 역할별
모델 지정"**.

기준이 셋을 한 줄에 적어 두어 한 기능처럼 보이는데, 강제되는 자리가 셋 다 다르다.

| 조각 | 어디서 강제되는가 | 왜 거기인가 |
|---|---|---|
| 도구 허용목록 | **Rust (Policy Gate)** | Node가 지키면 장악당한 Node에서 그 규칙이 사라진다(원칙 2) |
| 프롬프트 프리셋 | Node (프롬프트 조립) | 프롬프트를 만드는 곳이 거기다 |
| 역할별 모델 지정 | Node (라우터) | 이미 `modelPins`가 하던 일이다 |

### 26.1 파일은 Rust가 읽는다

`--skill <파일.json>`을 Node가 읽어 넘기면 **도구 허용목록의 출처가 Node**가 되고, 그러면
장악당한 Node가 "허용목록은 전부입니다"라고 말할 수 있다. Rust가 읽어 자기 게이트에 꽂고,
Node에는 그쪽이 실제로 해야 하는 일(프롬프트에 싣기)만 넘긴다.

모델 지정도 Node로 따로 보내지 않는다. Rust가 `policy.modelPins`에 접어 넣는다 — **명시한
`--pin-*`가 스킬의 지정을 이긴다**는 우선순위를 한 곳에서 정하기 위해서다. 두 곳에서 오면
Node가 그 우선순위를 다시 정하게 되고, 그러면 규칙이 둘이 된다.

`policy.allowedTools`는 Node에도 간다. **그런데 Node는 그것을 지키지 않는다** — 화면이 "이
스킬이 무엇을 좁혔는가"를 말할 수 있어야 해서 보낼 뿐이고, 지키지 않는다는 사실이 중요하다:
Node가 장악당해도 그 값을 바꿔 도구를 늘릴 수 없다.

### 26.2 프리셋은 스냅샷을 통해 나간다

스킬 지시문은 워크스페이스에서 모은 것이 아니라 사용자 설정이므로 `WorkspaceSnapshot`에 두는
것이 어색해 보인다. 그래도 거기 둔다.

전송 투명성이 *"이 내용이 각 공급자 **모두에게** 갔다"* 고 말할 수 있는 근거는 하나다:
**모든 프롬프트 빌더가 같은 스냅샷을 싣는다**(7.1절, `transmissionClaim.test.ts`가 지킨다).
지시문을 스냅샷 밖에 두고 빌더마다 실으면 그 근거가 그 자리에서 사라진다. 그래서 규칙을
뒤집지 않고 지킨다 — **나가는 것은 스냅샷을 통해 나간다.**

그리고 나가는 이상 **집계가 센다**(7.2절). 23.10절이 MCP 도구 목록에 대해 *"싣는 순간 전송
투명성이 그것을 세야 하므로 그 배선 없이 먼저 싣지 않는다"* 고 적었는데, 여기서 그 규칙을
그대로 지켰다 — 그 배선을 먼저 만들고(7.2절) 나서 실었다.

### 26.3 허용목록은 **좁히기만** 한다

스킬이 도구를 늘릴 수는 없다. 게이트의 분류는 그대로이고 허용목록은 그 앞에서 한 겹 더 막을
뿐이다. 넓히는 방향을 열면 "스킬 파일 하나로 정책을 푼다"가 되고, 그건 이 저장소가 반복해서
거부해 온 우회 경로다(24.5절, 25.3절과 같은 판단이다).

**분류보다 먼저 본다.** 뒤에 두면 도구별 분기마다 같은 검사를 되풀이해야 하고 하나를 빠뜨리면
그 도구만 조용히 새어 나간다. 앞에 두어도 안전한 이유는 이 검사가 좁히기만 하기 때문이다 —
어떤 도구도 새로 허용되지 않는다. 그리고 목록에 **있어도** 게이트의 분류를 그대로 지난다:
삭제와 비밀값 쓰기는 허용목록에 적어도 여전히 승인이 필요하다.

허용목록 밖의 도구는 **승인 필요가 아니라 거부**다. 사용자에게 물으면, 자기가 고른 스킬이 왜
안 쓰기로 한 도구를 요구하는지 알 수 없다. 대신 거부 사유가 **무엇이 허용됐는지 함께** 말한다.

### 26.4 검증은 스킬이 끌 수 없다

`run_tests`는 허용목록에 적지 않아도 남는다. 이 목록이 좁히는 것은 **모델이 쓸 수 있는
도구**이고, 검증은 모델의 도구가 아니라 우리의 판정자다(원칙 1).

좁힐 수 있게 두면 스킬 파일 한 줄로 `VERIFYING`이 조용히 꺼진다. 그리고 그 결말은 **정상
동작처럼 보인다** — 리포트가 `could_not_run`이 되는 것은 "스킬이 도구를 좁혔다"의 자연스러운
결과로 읽힌다. 빠뜨렸다고 꺼지는 것이 아니라 **애초에 끌 수 없어야 한다.**

보정은 목록을 만드는 쪽(`skills::validate`)이 하지만, **게이트가 그 사실에 기대고 있다는 것을
게이트 쪽 테스트가 고정한다** — 정책을 다른 경로로 만들면 그 보정이 없기 때문이다.

### 26.5 조용한 실패를 만들 수 있는 자리 셋을 등록에서 막는다

세 가지가 전부 "사용자는 좁혔다고 믿는데 정반대"가 되는 모양이다.

- **오타 난 도구 이름**을 무시하면 좁히려던 도구가 그대로 열린다. 거부하고, 쓸 수 있는 이름을
  함께 보여준다.
- **빈 허용목록**을 "제한 없음"으로 읽지 않는다. 좁히려다 비운 사용자에게 정반대를 준다.
  키가 아예 없는 것("좁히지 않는다")과는 다른 사실이므로 다르게 다룬다.
- **아무것도 하지 않는 스킬**(이름만 있는 것)은 거절한다. 통과시키면 사용자는 무언가 적용됐다고
  믿는다.

`ALL_TOOLS`는 손으로 적은 목록이라 `ToolName`에 변형이 늘면 낡을 수 있다. 낡으면 새 도구가
스킬 파일에서 "알 수 없는 도구"가 되고, 사용자는 **우리 누락을 자기 오타로 읽는다.** 그래서
`ToolName::as_str`의 매치 팔에서 이름을 유도해 대조한다 — `as_str`은 exhaustive match라 변형이
늘면 컴파일러가 그쪽을 먼저 잡아 주므로, 거기가 가장 앞선 정본이다.

### 26.6 아직 하지 않은 것

- **스킬을 여러 개 겹치는 것.** 지금은 태스크당 하나다. 겹치면 허용목록의 교집합/합집합과
  지시문 순서를 정해야 하는데, 그 답은 실제로 스킬을 여러 개 쓰는 사용을 봐야 안다.
- ~~**UI 선택 화면.**~~ → 36절. 막고 있던 것은 화면이 아니라 "스킬이 어디 사는가"였고,
  34절이 절반을(워크스페이스 안은 아니다) 36절이 나머지 절반을(상태 디렉터리의 보관함)
  정했다. **무엇이 적용됐는지**를 실행 중에 보여주는 것도 → 37절.
- **스킬별 프롬프트 위치 조정.** 지시문은 프로젝트 규칙 다음, 파일 앞에 고정이다.
- **역할별 지시문.** executor와 reviewer에게 다른 지시문을 주는 것 — 지금은 같은 스냅샷을
  싣는다는 규칙(26.2절)과 정면으로 부딪히므로, 하려면 전송 집계를 역할별로 나눠야 한다.

## 27. 세션 메모리 — 무엇을 나르는가보다 **무엇을 나르지 않는가**가 설계다 (M3)

product-strategy 8.2절 기준: **"세션 내 대화·결정 유지"**.

### 27.1 유도는 Rust가 한다 — SQLite 때문만이 아니다

sidecar가 SQLite를 직접 열지 않는다는 규칙이 이미 있으므로 Rust가 읽는 것은 자연스럽다.
그런데 더 중요한 이유가 있다: **"무엇을 나를 수 있는가"는 권위에 관한 판정**이다(16.1절).
그 판정이 sidecar에 있으면 장악당한 sidecar가 **모델 제안을 사용자 판정으로 나를 수 있다.**

같은 이유로 질의 자체를 `source = 'user_decision'`으로 좁힌다. 모델 제안까지 주고 부르는 쪽이
거르게 하면, 한 번 빠뜨렸을 때 제안이 요구로 세탁된다. **걸러야 할 것을 애초에 주지 않는다.**

### 27.2 사용자 판정만 나른다

두 값의 권위가 다르다. 하나는 사용자가 정한 요구이고 다른 하나는 모델이 낸 후보다. 후보를
세션 너머로 나르면 사용자는 **한 번도 동의한 적 없는 문장**을 다음 태스크에서 "이미 정해진
것"으로 보게 된다.

대화 원문도 나르지 않는다. 나를 수 있는 것은 저장된 판정뿐이고 그건 **마스킹을 거친 값**이다
(`redact_user_decision`). 원문을 따로 들고 나르면 17.11절이 지적한 노출이 태스크 수만큼 늘어난다 —
그 답변은 원래 한 태스크의 프롬프트에만 실렸다.

### 27.3 나른 것은 이 태스크의 **기준이 아니다**

앞선 판정은 맥락이지 이번 태스크의 `doneCriteria`가 아니다. 섞으면 17.9절의 기준 평가가
**사용자가 이번에 말한 적 없는 요구**로 태스크를 판정한다. 그래서 프롬프트에서도 자리를
나누고(`## Decisions carried from earlier tasks` vs `## Acceptance criteria`), 이 모듈은
`acceptance_criteria`에 아무것도 쓰지 않는다.

프롬프트 문장이 그 구별을 **말한다**: *"still in force … NOT this task's acceptance criteria —
do not treat them as things to verify."* 권위만 적고 성격을 안 적으면 모델이 이것들을 이번에
검증할 목록으로 읽는다.

### 27.4 상한이 있고, 잘렸다는 사실을 낸다

세션이 길어지면 프롬프트가 무한정 자란다(원칙 5). 최근 것부터 상한까지만 나른다.

**잘린 사실을 프롬프트 문장에 적는다.** 구조체 필드는 모델이 읽지 않는다 — 조용히 자르면
모델은 이 목록이 전부라고 보고 목록에 없는 앞선 판정과 충돌하는 안을 자신 있게 낸다.

상한값 10은 **유도한 값이 아니라 관례적 선택이다.** 실사용에서 세션당 판정이 몇 건이나
쌓이는지 아직 모른다.

### 27.5 나가는 것이므로 집계가 센다

앞선 태스크에만 실렸던 판정이 **다른 태스크의 프롬프트로 넘어간다.** 그건 전송의 사실이므로
화면이 말해야 한다(7.2절). 스킬과 같은 길을 지난다 — 스냅샷을 통해 나가고, 전송 집계의
`REPORTED_SECTIONS`에 등록된다. 26.2절의 규칙("나가는 것은 스냅샷을 통해 나간다")이 여기서
두 번째로 적용됐다.

### 27.6 양성 경로는 e2e로 만들 수 없다 — 그래서 나눠서 본다

사용자 판정은 판정 카드나 재질문에 사람이 답해야 생기는데, **헤드리스 호스트는 카드에 답할 수
없다.** 그래서 "앞선 판정이 실제로 넘어간다"를 실제 실행으로 만들 수 없다.

여기서 테스트용 주입 플래그를 만들 수도 있었다. 만들지 않았다 — 제품 코드에 테스트 전용
경로를 내는 것은 이 저장소가 반복해서 거부해 온 것이고, `--approve auto`가 이미 그렇게
오해된 적이 있다(24.1절). 대신 사슬을 **겹치는 조각으로** 나눠 본다:

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 수집 규칙 | Rust 단위 | 사용자 판정만, 다른 세션 제외, 자기 자신 제외, 상한과 절단 표시 |
| 프롬프트 도달 | sidecar 단위 | `RunInput` → 스냅샷 → **모든** 프롬프트에 실린다 |
| 넘지 않아야 할 것 | e2e | 세션을 이어도 모델 제안은 다음 태스크로 넘어가지 않는다 |

가운데 조각을 굳이 만든 이유는 **바로 그 배선이 한 번 끊겨 있었기 때문이다**: 스킬을 붙일 때
`index.ts`가 params에서 값을 꺼내지 않아 프리셋이 스냅샷에 닿지 않았다. 그때는 e2e가 잡았지만
세션 메모리에는 그 e2e가 없다.

e2e 쪽은 **첫 태스크가 모델 제안 기준을 실제로 만들었는지 먼저 확인한다.** 안 만들었으면
"나를 것이 없어서" 통과하고 아무것도 검증하지 않는다.

### 27.7 아직 하지 않은 것

- ~~**판정 사이의 충돌.**~~ → 30절. **이 항목의 진단이 틀렸다** — 막힌 곳은 "마음을 바꾼 것과
  잊은 것의 구별"이 아니라, 구별한 뒤에도 사용자가 앞선 판정을 **거둘 수 없다**는 것이었다.
  30절이 그 레버를 만들고, 충돌 감지 자체는 30.7절에 미해결로 남는다.
- **판정의 수명.** 세션이 끝나면 사라진다. 프로젝트 수준으로 남기는 것은 8.2 표의 "장기
  프로젝트 메모리"이고, 그때는 **어디까지가 이 저장소의 사실인지**를 다시 정해야 한다.
- **상한값의 근거**(27.4절).
- ~~**UI에서 무엇이 넘어왔는지 보여주는 것.**~~ → 30절. 목록이 화면에 있고, 거기서 거둘 수 있다.

## 28. PR 연동 — 브랜치를 올리고, 폼은 사용자의 브라우저가 연다 (M3)

product-strategy 8.2절 기준: **"GitHub PR 생성"**.

### 28.1 우리는 GitHub에 요청을 보내지 않는다

자연스러운 구현은 GitHub API를 호출하는 것이고, 그러면 토큰이 필요하다. 그 길을 가지 않았다.

`compare` URL은 제목과 본문을 쿼리로 미리 채운 **PR 생성 폼**을 연다. 그 요청을 보내는 것은
사용자의 브라우저이고 우리는 URL 한 줄을 낸다. 얻는 것이 셋이다:

- **자격증명이 없다.** 저장할 토큰이 없으면 샐 토큰도 없다.
- **전송 투명성이 깨지지 않는다**(7절). 우리가 어디로도 코드를 보내지 않는다 — push는
  사용자가 이미 설정해 둔 remote로 간다.
- **마지막 확인이 사람에게 남는다.** 제목·본문·대상 브랜치를 사용자가 폼에서 보고 누른다.

대가도 적어 둔다: **PR 번호를 돌려받지 못하고, 열렸는지도 모른다.** 그걸 알아야 하는 기능
(리뷰 코멘트 반영)은 8.2 표의 "이후 깊이 확장"이고 그때 이 결정을 다시 본다.

이건 "API를 못 불러서 대신 하는 것"이 아니다. **못 만든 것과 안 만든 것을 뭉개지 않기 위해**
적어 둔다: 검증할 수 없는 HTTP 클라이언트를 쓰고 "구현 완료"라고 적는 쪽이 더 나빴다(Google
어댑터에서 "구현됨"과 "검증됨"을 가른 것과 같은 판단이다 — multi-engine 19.4절).

### 28.2 문을 연 것이 아니라 **좁혔다**

`run_command`의 `git push`는 deny 목록에 있었고 사유는 *"M0 범위 밖"* 이었다. 그건 범위
표시였지 판단이 아니다. PR을 붙이려면 그 자리를 다시 봐야 했는데, 결론은 **여는 것이 아니라
좁히는 것**이었다.

deny를 풀면 `--force`와 임의 refspec이 함께 열린다. 대신 `git_push` 도구를 따로 냈다 —
`mcp_call`과 같은 처리이고(23.2절), 다른 점은 **여기서는 우리가 argv를 조립한다**는 것이다.
`remote`와 `branch`를 이름으로만 받고(옵션도 refspec도 거부), 실행되는 argv는
`git push <remote> <branch>` 셋뿐이다. `--force`는 **만들 방법이 없다** — 19.2절이
`git reset --hard`에 대해 내린 판단과 같다: 되돌릴 수 없는 동작을 우리가 대신 실행하지 않는다.

같은 동작에 대한 두 규칙이 아니라 **다른 능력**이다. 넓은 문은 닫혀 있고 좁은 문만 열려 있다.
그리고 좁은 문도 언제나 승인이며 정책으로 낮출 수 없다(`HumanOnly`) — 자동으로 밀어도 되는
push는 없다. 무엇이 올라가는지는 매번 다르고, 올라간 뒤에는 우리 손을 떠난다.

### 28.3 곁가지로 네트워크 분류가 과했다는 것이 드러났다

remote URL을 읽으려면 `git remote get-url`이 필요한데, 그건 `.git/config`를 읽을 뿐인데도
`is_network_capable`이 `remote` 전체를 네트워크로 보고 있었다. 로컬 조회에 승인을 요구하면
사용자는 승인을 **습관으로** 누르게 되고, 그러면 정작 네트워크를 타는 요청도 같이 지나간다.

하위 명령을 보도록 좁혔다(`update`/`prune`만 네트워크). 넓히는 방향이지만 **allowlist가 먼저
막는다** — 이 분류에 닿는 것은 이미 허용된 명령뿐이고, 우리가 연 것은 `remote get-url` 하나다.

### 28.4 사용자 명령이지만 승인은 건너뛰지 않는다

`pr`은 모델의 도구가 아니라 사용자가 부르는 하위 명령이다. 되돌리기(19절)와 같은 자리다.

**그러나 되돌리기와 다르게 승인 왕복을 지난다.** 되돌리기는 사용자가 "되돌려"를 누른 것 자체가
그 동작의 승인이지만, push는 *무엇이* 올라가는지가 매번 다르다. 그래서 승인 화면이 실제
argv를 보여주고 사용자가 그걸 보고 답한다.

### 28.5 검증한 것과 검증하지 못한 것

e2e는 remote를 **로컬 bare 저장소**로 두고 push 경로 전체(게이트 분류·승인·argv·실제 전송)를
태운다. 네트워크가 없어도 되고, 올라갔는지는 우리 보고가 아니라 **bare 저장소에 브랜치가
생겼는지**로 본다.

`compareUrl`이 `null`인 것도 보지만 **그 단언의 범위는 좁다**: remote가 로컬 경로라 어떤
규칙으로도 slug가 나오지 않는다. 실제로 `github_slug`를 "무엇이든 통과"로 고쳐 심었더니
그 e2e는 그대로 통과했고 Rust 단위 테스트만 실패했다. 호스팅처럼 생겼지만 GitHub이 아닌
remote는 단위 테스트가 본다 — e2e에서 그걸 확인하려면 네트워크가 필요하다.

**공허했던 검사를 하나 옮겼다.** "모델은 임의 argv의 push를 낼 수 없다"를 e2e로 쓰려 했는데,
그 요청이 애초에 만들어지지 않았다 — `DraftProposal`에 명령 필드가 없고 planner가 patch에서
argv를 조립하므로 **모델이 임의 명령을 낼 경로가 없다.** 빈 집합에 대한 전칭 명제라 deny를
지우는 probe를 심어도 통과했다. 규칙이 사는 곳(게이트 단위 테스트)으로 옮겼다.

같은 방식으로 잡은 것이 하나 더 있다: 게이트의 레버 표에 `git_push`가 없어서 **"push를 자동
허용으로 바꾼다"는 probe가 통과했다.** 표에 없는 도구에 대해 그 검사는 아무 말도 하지 않는다.

### 28.6 아직 하지 않은 것

- **PR이 열렸는지 아는 것.** 28.1의 대가다. 리뷰 코멘트 반영을 하려면 이 결정을 다시 본다.
- **GitHub 외 호스팅.** compare URL 모양을 모르므로 만들지 않는다 — 8.2 표의 "타 호스팅".
- **base 브랜치 자동 판정.** 지금은 `--base`(기본 `main`)다. remote의 기본 브랜치를 물으려면
  네트워크를 타거나 `origin/HEAD`가 로컬에 있어야 하는데 둘 다 보장되지 않는다.
- **UI 배선.** 지금은 `tomverse-host pr`뿐이다.

## 29. 훅·MCP 등록 화면 — 설정 파일을 **어디에 두는가**가 이 기능이다 (M3)

23.10절과 25.7절이 각각 *"설정 파일이 생기면 그때 넓힌다"* 고 미뤄 둔 자리다. 둘을 같은
파일·같은 화면에 두는 이유는 **수명이 같기 때문**이다: 태스크가 아니라 워크스페이스의
설정이고, 앱을 다시 켜도 남아야 한다(ui-wireframes 3.16.2절).

### 29.1 워크스페이스 **안**에 두면 모델이 등록한다

자연스러운 자리는 `<workspace>/.tomverse/settings.json`이다 — 팀이 공유하고 이력에 남고,
훅을 `npm run <스크립트>`로 걸게 한 것과 같은 논리다(25.5절).

그런데 **Policy Gate가 파일 쓰기를 워크스페이스 안으로 가둔다.** 그 말은 워크스페이스 안의
파일이 곧 **모델이 쓸 수 있는 파일**이라는 뜻이다. 거기에 등록을 두면 모델이 MCP 서버나 훅을
스스로 등록할 수 있고, 그 순간 23.5절의 안전 모델 전부 — *"등록은 사용자만 한다"* — 가
무너진다. MCP 서버 하나는 곧 임의의 프로그램이다.

그래서 등록은 **상태 디렉터리**에 둔다. 게이트가 그 경로에 대한 쓰기를 애초에 허용하지 않는다.

잃는 것도 적어 둔다: **팀이 공유하지 못하고 이력에도 남지 않는다.** 공유하려면 워크스페이스
안의 파일을 *읽어서 제안*하고 사용자가 승인하는 경로가 필요하고, 그건 별개의 기능이다 —
"읽어서 제안"과 "읽어서 적용"의 차이가 이 절 전체다.

### 29.2 검증은 저장보다 먼저, 그리고 읽을 때 다시

저장 뒤에 검증하면 잘못된 설정이 파일에 남고, 다음에 앱을 켤 때 워크스페이스가 열리지
않는다 — 사용자가 그 파일을 손으로 고쳐야 빠져나온다.

읽을 때도 다시 검증한다. 파일은 사용자가 손으로 고칠 수 있고, 그때 앱이 **조용히 잘못된
등록으로 도는 것보다 열리지 않는 편이 낫다.** 훅은 등록 시점에 게이트에도 태워 본다(25.5절).

화면 쪽 검사는 **같은 규칙을 다시 적지 않는다.** phase 이름이 실재하는지는 Rust가 보고,
화면은 "비어 있는 칸"과 "이름 중복"처럼 **어느 행인지 말할 수 있는 것**만 본다. 두 곳에서
판정하면 언젠가 둘이 갈라지고, 갈라진 쪽이 느슨하면 그게 우회 경로가 된다.

### 29.3 화면을 만들다 구멍이 하나 드러났다 — **argv를 고정해도 본문은 고정되지 않는다**

24.5절은 검증 명령 자동 승인의 대상을 태스크 시작 시점에 고정한다. 그 고정이 지키는 것은
명령의 **이름**이다: 모델이 `scripts.lint`를 새로 추가해도 그 명령은 집합에 없다.

**그런데 `npm test`의 argv를 그대로 두고 `scripts.test`의 본문을 바꾸면, 고정된 argv가 다른
프로그램을 돌린다.** 25.3절의 훅도 같다 — 등록된 `npm run fmt`의 본문이 바뀌면 등록이 승인한
것과 실제로 도는 것이 달라진다.

이건 이 저장소가 이미 두 번 세운 규칙("모델은 매니페스트를 고칠 수 있다")의 **세 번째
얼굴**이었고, 앞의 두 번은 이름만 지켰다. 등록 화면을 만들며 "무엇을 등록하는 것인가"를
다시 물었을 때 드러났다.

고치는 방법은 막는 것이 아니라 **사람에게 되돌리는 것**이다: 프로필이 매니페스트 내용의
지문을 함께 들고, 사전 승인 시점에 달라졌으면 그 승인을 **철회**한다(`PRE_APPROVAL_WITHDRAWN`).
그러면 평소대로 묻고, 무인 실행이면 멈춘다(24.4절). 명령을 금지하는 것이 아니라 **자동 승인의
근거가 사라진 것**이므로, 이 처리가 정확하다.

지문이 읽는 파일 목록은 손으로 적혀 있고 `detect_commands`가 읽는 것과 같아야 한다. 새
매니페스트를 지원할 때 함께 늘지 않으면 그 매니페스트의 본문 변경이 보이지 않으므로,
테스트가 파일마다 지문이 실제로 달라지는지 확인한다.

### 29.4 저장이 즉시 반영되지 않는다

훅 레지스트리와 MCP 풀은 `TaskHost`를 만들 때 붙으므로, 바뀐 등록은 **워크스페이스를 다시
열어야** 적용된다. 공급자 허용 목록이 sidecar 재spawn을 기다리는 것과 같은 성질이다(16절).

**그 사실을 화면이 말한다.** 말하지 않으면 저장했는데 아무 일도 일어나지 않고, 사용자는
저장이 실패했다고 읽는다.

### 29.5 아직 하지 않은 것

- ~~**워크스페이스 안의 설정을 읽어 제안하는 것**~~ → 35절. `.tomverse/proposal.json`을
  **읽어서 보여줄 뿐** 등록하지 않는다 — 등록으로 가는 지름길을 만들지 않는 것이 그 설계의 전부다.
- **MCP 서버별 도구 허용목록**(23.10절)과 **서버 환경변수**. 지금은 이름·프로그램·인자뿐이다.
- **등록을 바꾸면 다시 열라고 시키는 것 이상**. 지금은 문장으로 알릴 뿐이고, 화면이 대신
  다시 열어주지는 않는다.

## 30. 판정의 철회 — 27.7절이 짚은 자리는 감지가 아니라 **레버**였다 (M3)

product-strategy 8.2절 기준: **"세션 내 대화·결정 유지"**의 두 번째 조각. 27절이 판정을
나르기 시작했고, 이 절이 그것을 거두는 길을 만든다.

### 30.1 27.7절의 진단이 틀렸다

27.7절은 미해결 항목을 이렇게 적었다.

> **판정 사이의 충돌.** 앞선 판정과 이번 요청이 부딪히면 지금은 둘 다 프롬프트에 실린다.
> 누가 이기는지는 정하지 않았다 — 정하려면 "사용자가 마음을 바꾼 것"과 "잊은 것"을 구별해야
> 하고, 그건 물어봐야 아는 일이다.

마지막 문장은 맞다. 그런데 **막힌 곳을 잘못 짚었다.** 구별이 없어서 막힌 것이 아니다.
구별한 뒤에도 사용자가 **할 수 있는 일이 없어서** 막혀 있었다 — 마음이 바뀌었다는 것을 알아도
앞선 판정을 거둘 방법이 없었고, 세션이 끝날 때까지 그 문장은 모든 프롬프트에 실렸다.

그래서 이 절은 감지를 만들지 않고 **레버**를 만든다. 감지가 필요해지는 것은 그 다음이다.

### 30.2 우리는 충돌을 판정하지 않는다

자연스러운 구현은 모델에게 "앞선 판정과 이번 요청이 충돌하는가"를 묻고, 충돌이면 앞선 것을
자동으로 거두는 것이다. 그 길을 가지 않았다.

그 대답은 **또 하나의 모델 의견**이고, 그것으로 사용자 판정을 지우면 16절의 관할이 뒤집힌다.
요구에 대한 최종 권위는 사용자이고 모델은 어느 쪽도 판정하지 않는다 — 발굴은 해도 되지만,
**발굴을 판정으로 쓰는 순간 사용자에게 올라갈 질문이 지워진다.**

그래서 화면에는 목록과 버튼만 있다. 무엇이 실리는지 보이고, 거두는 것은 사람이 누른다.

같은 이유로 철회 대상은 `source = user_decision`뿐이다. 모델 제안은 애초에 나르지 않으므로
거둘 것이 없고, 목록에 띄우면 사용자는 그것들도 자기가 정한 것으로 읽는다.

### 30.3 철회는 삭제가 아니다 — **바뀌는 것은 나르는가 하나다**

거둬도 세 가지가 그대로 남는다.

| 남는 것 | 왜 |
|---|---|
| `task_events`의 `USER_DECISION_RECORDED` | append-only다(원칙 7). 지우는 API가 없고 만들지 않는다 |
| 그 태스크의 `acceptance_criteria` 행 | **그 태스크는 그 기준으로 판정됐다.** 지우면 끝난 태스크의 최종 보고가 소급해서 바뀌고, 감사 기록이 "그때 무엇을 기준으로 삼았는가"에 답하지 못한다 |
| 이미 나간 프롬프트 | 되돌릴 수 없다. 전송은 일어난 사실이다(7절) |

그래서 스키마 변경은 행 삭제가 아니라 **컬럼 추가**다(`acceptance_criteria.withdrawn_at`,
`SCHEMA_VERSION = 8`). 그리고 두 질의가 같은 행에 대해 다른 답을 낸다 — 그 차이가 이 기능이다.

| 질의 | 거둔 행을 | 쓰는 곳 |
|---|---|---|
| `session_user_decisions` | **뺀다** | 다음 태스크로 나를 것(27절) |
| `session_decision_rows` | 넣는다 | 사용자에게 보여줄 목록 |
| `acceptance_criteria(task_id)` | 넣는다(+`withdrawnAt`) | 그 태스크의 기록·감사 export |

목록에서까지 지우지 않는 이유: 지우면 **"사라졌다"와 "거뒀다"가 화면에서 같은 모양**이 되고,
사용자는 자기가 무엇을 거뒀는지 확인할 방법이 없다.

**모델에게는 말하지 않는다.** 잘린 판정은 "더 있다"고 알려야 하지만(27.4절) 거둔 판정은
언급 자체가 그것을 되살린다 — 잘린 것은 *유효한데 안 보낸 것*이고 거둔 것은 *유효하지 않은
것*이라, 같은 "빠짐"이 아니다.

**export 형식은 3으로 올린다.** v2 파일에 `withdrawnAt`이 없는 것을 "거두지 않았다"로 읽으면
조용히 틀린 해석이 된다 — 그 형식에는 거둘 방법 자체가 없었으므로 "없음"이 아니라
**"알 수 없음"**이다.

### 30.4 이 경로에는 sidecar가 없다 — 그래서 Node가 이 이벤트를 낼 수 없다

철회는 사용자가 화면이나 CLI에서 직접 부르는 동작이고, 그 사이 어디에도 오케스트레이터가
없다. `revert`·`pr`과 같은 자리다.

그런데 `db.appendEvent`는 Node가 **아무 이벤트나** 남길 수 있는 통로였다. 그대로 두면
장악당한 Node가 `USER_DECISION_WITHDRAWN`을 남겨 **사용자가 하지 않은 철회로 앞선 판정을
조용히 지울 수 있다.** 그래서 거절 목록(`NODE_MAY_NOT_EMIT`)을 만들었다.

**목록의 근거는 "Rust가 낸다"가 아니다.** 그런 목록이면 Node가 정당하게 내는 것까지 섞인다 —
`USER_DECISION_RECORDED`가 그 예다. 사용자가 답했다는 기록이지만 오케스트레이터가 던진
질문의 회신이므로 그 경로를 지나는 것이 맞고, 막으면 재질문 왕복 자체가 성립하지 않는다.

근거는 **"오케스트레이터가 관여하지 않는 사용자 행위인가"**이고, 지금 그에 해당하는 것은
철회와 롤백 기록이다. Node가 낼 이유가 없으므로 거절해도 잃는 것이 없다.

그 성질이 참이라는 증거는 sidecar 소스에 있다(그 이벤트를 낼 코드가 없다). 그래서
`packages/toolchain/test/rustOnlyEvents.test.ts`가 두 소스를 대조한다 — 목록에 있는데
sidecar가 실제로 내고 있으면 이 거부는 보안 장치가 아니라 **기능을 조용히 끄는 버그**다.

### 30.5 무엇을 어디서 검증했는가

27.6절과 같은 제약이 그대로 있다: **사용자 판정은 사람이 카드에 답해야 생기므로 헤드리스
호스트가 만들 수 없다.** 그래서 양성 경로(실제로 거두는 것)를 e2e로 만들 수 없고, 사슬을
겹치는 조각으로 나눠 본다.

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 거두는 규칙 | Rust 단위 (`decisions.rs`) | 끝난 태스크만, 이미 거둔 것은 거절, `(taskId, criterionId)`가 열쇠 |
| 거둔 뒤의 효과 | Rust 단위 | 나르지 않는다 / 목록에는 남는다 / 그 태스크의 기록은 그대로 |
| 이벤트로만 사라진다 | Rust 단위 (`store.rs`) | payload 키가 없으면 캐시는 그대로, 거둘 것이 없으면 트랜잭션째 실패 |
| Node가 못 내는 것 | Rust 단위 + toolchain | 거절되고, 그 거절이 모든 이벤트를 막지 않는다 |
| CLI 배관 | e2e | 모델 제안은 목록에 없고, 가리켜도 `not_found`로 거절되며 종료 코드가 0이 아니다 |
| 화면 문장 | desktop 단위 | 거둔 것이 목록에 남고, 이유마다 다른 문장이 되고, "삭제"라고 쓰지 않는다 |

**목록에서 유도한 검사는 목록이 줄어드는 것을 잡지 못한다.** 처음에는 거절 검사를
`NODE_MAY_NOT_EMIT`을 훑는 루프 하나로 썼는데, 목록에서 `USER_DECISION_WITHDRAWN`을 지우는
probe가 **그대로 통과했다** — 훑을 것이 사라지면 그 루프는 아무것도 검사하지 않는다.
이 저장소가 반복해 온 "판정 기준을 손으로 적지 않는다"와 정면으로 부딪히는 것처럼 보이지만
그렇지 않다: **수단은 유도하고, 주장은 적는다.** 지켜야 하는 것은 "철회는 Node를 지나지
않는다"는 주장이므로 그 문장은 목록과 무관하게 적히고, 목록 전체가 실제로 거절되는지는 따로
훑는다. 두 검사가 말하는 것이 다르다.

**열쇠가 `(taskId, criterionId)`인 것은 정확성 문제다.** `acceptance_criteria`의 기본 키가
그 둘이므로 `criterionId` 하나는 세션 안에서 유일하지 않고, 그것만으로 가리키면 같은 id를 쓰는
다른 태스크의 판정을 거둔다 — 되돌리는 경로가 없으므로 잘못 가리키는 것이 특히 나쁘다.

### 30.6 진행 중인 태스크의 기준은 거둘 수 없다

거두면 **그 태스크가 무엇으로 판정되는지가 실행 도중 바뀐다.** 17.9절의 기준 평가와 최종
보고가 시작 시점과 다른 목록을 보게 되고, 그 태스크의 결과는 어느 쪽으로도 해석할 수 없게 된다.

이번 태스크의 기준을 고치는 길은 철회가 아니라 **재질문**이다(17.1절). 그래서 거절 사유를
"안 됨"으로 뭉개지 않고 `task_still_running`으로 따로 낸다 — 사용자가 할 일은 기다리는 것이고,
그건 "이미 거뒀다"와 전혀 다른 다음 행동이다.

### 30.7 아직 하지 않은 것

- **충돌 감지.** 30.2절대로 모델에게 판정을 맡기지 않기로 했으므로, 남는 길은 사용자가 목록을
  보고 스스로 알아채는 것이다. 규칙 기반 감지(같은 파일·같은 낱말)를 붙일 수는 있으나
  오탐률을 모른 채 "충돌입니다"라고 띄우면 사용자가 목록을 무시하게 된다 — 12절의 "위치 충돌
  규칙의 오탐률"과 같은 미해결이다.
- **거둔 것을 되살리는 것.** 되살리기는 "다시 정하는 것"이므로 새 판정이어야 하는데, 그러려면
  판정 카드 없이 판정을 만드는 경로가 필요하다. 그 경로는 만들지 않았다.
- **판정의 수명이 세션을 넘는 것.** 27.7절 그대로 남아 있다. 프로젝트 수준으로 남기려면
  "어디까지가 이 저장소의 사실인가"를 다시 정해야 한다(8.2 표의 "장기 프로젝트 메모리").
- **상한값 10의 근거**(27.4절).
- **여러 건을 한 번에 거두는 것.** 지금은 한 건씩이다. 이벤트도 한 건씩 남는다.

## 31. MCP — 등록한 문에 **걸어 들어갈 길**을 낸다 (M3)

product-strategy 8.2절 기준: **"MCP 서버 등록, 그 도구가 `ToolRequest`로 변환되어 Policy Gate 통과"**.
23절이 그 문을 프로세스 경계까지 만들었고, 29절이 등록 화면을 만들었다. 이 절은 그 문에 닿는
경로를 만든다.

### 31.1 문은 있는데 걸어 들어갈 길이 없었다

23.2절은 이렇게 적었다: *"Node는 `mcp_call` 도구로 요청만 하고, 띄울지는 Rust가 정한다."*

**그 문장의 앞 절반이 코드에 없었다.** `mcp_call`은 Rust의 `ToolName`에만 있었고 TypeScript
쪽 `ToolName`에는 없었다. sidecar 어디에도 그 도구를 요청하는 코드가 없었고, 애초에 요청할
방법도 없었다 — 초안에 도구를 요청할 칸이 없었고, 등록된 서버가 무슨 도구를 내놓는지 모델이
알 방법도 없었다.

그래서 **서버를 등록해도 아무 일도 일어나지 않았다.** 문서에는 구현된 것으로 적혀 있었고,
`tools/list`도 구현되어 있었지만 아무도 부르지 않았다(23.10절이 "프롬프트에 싣지 않았다"고
적어둔 그 자리다).

싣지 않은 이유도 그 절에 있다: *"싣는 순간 스냅샷에 없던 내용이 공급자로 나가므로 전송
투명성이 그것을 세야 한다 — 그 배선 없이 먼저 싣지 않는다."* **그 배선은 7.2절에서 생겼다.**
막고 있던 것이 사라졌으므로 이제 싣는다.

### 31.2 길은 세 조각이다

| 조각 | 어디 | 무엇 |
|---|---|---|
| 알기 | Rust `McpPool::catalog()` → `task.start`의 `mcpTools` → 스냅샷 → **모든 프롬프트** | 등록된 서버가 실제로 내놓는 도구의 이름·설명·인자 스키마 |
| 부르기 | `DraftProposal.mcpCalls[]` → `mcp_call` `ToolRequest` → Policy Gate → 승인 → 실행 | 초안이 "이 도구가 먼저 필요하다"고 말하는 칸 |
| 보기 | 결과 → 스냅샷의 `mcpResults` → 다음 초안 프롬프트 | 부른 결과를 모델이 실제로 읽는 자리 |

**목록을 Rust가 모은다.** MCP 서버는 프로세스이고 그것을 띄우는 것은 Node에게 금지된
일이다(원칙 2) — 23.1절과 같은 이유이며, 여기서 예외를 두면 그 원칙이 "도구 실행에만
적용된다"로 좁아진다.

### 31.3 도구를 요청한 초안은 **버린다**

그 초안의 `patch`는 아직 없는 결과를 전제로 쓰여 있다. 그대로 쓰면 모델이 "조회한 뒤에
정하겠다"고 말한 것을 우리가 무시하는 셈이다. 그래서 재질문 왕복과 **같은 모양**으로 돈다:
도구를 실행하고, 결과를 스냅샷에 얹고, 처음부터 다시 그린다.

**대조 실행에서는 primary의 요청만 실행한다.** 둘 다 실행하면 승인이 두 배가 되고, 부수효과가
있는 도구라면 그 효과가 두 번 일어난다. 그리고 두 실행자가 서로 다른 결과를 보게 되어
"두 실행자는 같은 입력을 받는다"(13.1절)가 깨진다. primary가 부르고, 결과는 다음 라운드에서
둘 다 본다.

**상한은 `mcpRounds`(기본 1)다.** 라운드마다 초안 하나가 버려지므로 비용과 지연이 라운드
수만큼 는다 — 측정되지 않은 이득에 곱셈을 걸지 않는다. 상한에 걸려도 **실패시키지 않는다**:
도구 없이도 초안은 나올 수 있으므로, 상한을 알리고 한 번 더 요청하고, 그 뒤로도 요청하면
그 요청을 무시하고 진행한다.

**상태는 늘지 않았고 전이가 하나 늘었다** — `DRAFTING → DRAFTING`(단일 모델 경로는
`SINGLE_MODEL_FIX → SINGLE_MODEL_FIX`). 17.1절과 같은 판단이다. 승인을 위해
`AWAITING_APPROVAL`을 빌리지 않은 이유: 승인 모달은 phase가 아니라 승인 이벤트가 띄우므로
빌릴 필요가 없고, 빌리면 **"실행 승인을 기다리는 중"과 "초안이 도구를 요청했다"가 화면에서
같아진다.**

자기 전이는 이 상태표의 종료 논증을 약하게 만든다. 그래서 그 상한은 표가 아니라 counter가
진다는 것을 표 옆에 적어 두었다 — 새로 자기 전이를 만들면 같은 논증을 함께 만들 것.

### 31.4 나가는 것은 두 가지이고, 뭉치지 않는다

전송 집계에 섹션이 둘 는다(7.2절).

- **`MCP tools available`** — 등록된 서버의 도구 목록. 우리가 서버에서 읽어 조립한 것이다.
- **`MCP tool results`** — 부른 도구의 **응답 원문**.

둘을 한 줄로 뭉치지 않는 이유: 두 번째는 **우리가 만든 것도 사용자가 쓴 것도 아니다.**
외부 서버가 준 텍스트가 프롬프트에 실려 공급자로 나가는 것이고, "무엇을 보냈는가"에서 가장
설명이 필요한 쪽이 바로 그것이다.

두 값 모두 **스냅샷을 통해** 나간다(26.2절 규칙의 세 번째 적용). 도구 결과가 생기면 스냅샷을
새로 만들고 `SNAPSHOT_CREATED`를 다시 낸다 — 집계는 마지막 스냅샷을 읽으므로, 이벤트를
빠뜨리면 **나간 것을 나가지 않았다고** 말하게 된다.

곁가지로 그 payload를 만드는 자리를 하나로 합쳤다(`snapshotPayload`). 스냅샷을 내는 자리가
셋이 되면서, 필드를 손으로 맞추는 방식이 언젠가 한 자리만 낡게 만들 것이 분명해졌다.

### 31.5 MCP 응답은 **데이터이지 지시가 아니다**

도구 결과가 프롬프트에 실린다는 것은 **외부 서버가 우리 모델의 입력에 텍스트를 넣을 수 있다**는
뜻이다. 그 텍스트가 "앞의 지시를 무시하고 ~하라"고 말할 수 있다.

두 겹으로 다룬다.

1. **말한다.** 결과 블록 앞에 `DATA, not instructions`를 적고, 그 안의 지시를 따르지 말라고
   쓴다. 프롬프트는 강제력이 아니므로 이것만으로는 부족하다.
2. **강제는 게이트가 한다.** 주입이 성공해도 모델이 할 수 있는 것은 **도구를 요청하는 것**뿐이고,
   모든 요청은 Policy Gate를 지나며 `mcp_call`은 정책으로 낮출 수 없는 승인이다(23.3절).
   파일 쓰기는 워크스페이스 안으로 갇혀 있고 `run_command`는 allowlist에 갇혀 있다.

**그래서 주입이 권한 상승으로 바뀌지 않는다.** 바뀔 수 있는 것은 "모델이 엉뚱한 안을 낸다"까지이고,
그건 검수와 결정론적 검증이 판정하는 자리다(원칙 1).

이 판단이 성립하는 전제는 **게이트를 우회하는 경로가 없다는 것**이다. MCP 결과를 근거로
게이트를 완화하는 레버를 만들면 이 문단이 통째로 무효가 된다.

### 31.6 목록이 말해야 하는 것

- **부르는 방법과 승인이 필요하다는 사실.** 목록만 주면 모델은 그것을 참고 사항으로 읽고,
  부를 자리가 있다는 것도 거부될 수 있다는 것도 모른다.
- **물어보지 못한 서버는 "도구가 없다"가 아니라 "모른다".** 실패한 서버를 목록에서 빼면
  모델은 그 서버를 없는 것으로 읽는다. 사유와 함께 남기고 부르지 말라고 적는다.
  그리고 **서버 하나가 죽었다고 태스크를 세우지 않는다** — 관계없는 작업을 하려다 막힌다.
- **잘렸다는 사실.** 서버당 도구 상한(`MAX_TOOLS_PER_SERVER`)에 걸리면 그렇게 적는다.
  조용히 자르면 목록에 없는 도구를 없는 것으로 취급한다.
- **큰 스키마는 자르지 않고 통째로 뺀다.** 잘린 JSON 스키마는 유효해 보이면서 실제와 다르고,
  그 차이는 모델이 만든 인자가 서버에 거부될 때에야 드러난다.

### 31.7 검증한 것과 검증하지 못한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 목록의 문장 | Rust 단위 (`mcp.rs`) | 스키마가 실린다 / 실패는 UNKNOWN / 절단 표시 / 큰 스키마는 생략 / 이름 없는 도구는 버리되 개수는 센다 |
| 프롬프트 도달 | sidecar 단위 | 목록이 **모든** 프롬프트에 실린다. 서버가 없으면 섹션도 없다 |
| 왕복 | sidecar 단위 | 요청 → 실행 → 결과가 **나중** 프롬프트에만 있다 / 상한 / 거부는 텍스트가 되고 태스크를 죽이지 않는다 |
| spawn·게이트·승인 | e2e | 실제 fixture 서버를 띄워 핸드셰이크하고, `mcp_call`이 도구 실행 기록에 남고, 우리가 보낸 인자가 서버에 도달한다 |
| 전송 집계 | e2e | 두 섹션이 나가고 **bytes가 0이 아니다** |

**e2e가 여기서 특히 값이 나가는 이유**: 23.9절이 "프로세스를 실제로 띄우는 부분은 자동 검증
밖"이라고 적어 두었는데, 이제 도구 목록 조회가 **태스크 시작마다** 그 경로를 지난다.

검증하지 못한 것: 실제 MCP 서버들의 다양성(스키마 크기, 도구 개수, 응답 모양). fixture 서버는
설명도 스키마도 없는 최소 서버이고, 그건 "흔한 서버"의 한 극단일 뿐이다.

### 31.8 아직 하지 않은 것

- ~~**서버별 도구 허용목록**~~ → 32절. 여기 미리 적어둔 조건("보여주는 집합과 부를 수 있는
  집합이 갈리면 모델이 거부될 것을 요청한다")이 그 절의 32.4가 됐다.
- **서버 환경변수.** 23.7절이 환경을 비워 두는 이유가 그대로 남아 있다. 사용자가 서버에
  토큰을 주려면 그 토큰이 어디에 저장되는지부터 정해야 하고, 그건 자격증명 저장의 문제다.
- **여러 라운드의 이득 측정.** `mcpRounds` 기본 1은 관례적 선택이며, 라운드를 늘리는 것이
  이득인지 아직 재지 않았다.
- ~~**도구 결과의 크기 상한.**~~ → 32.6절. 응답 하나의 바이트와 한 라운드의 호출 개수
  둘 다에 상한이 생겼고, 넘으면 그 사실을 프롬프트에 적는다.
- **원격(HTTP/SSE) 서버** (23.10절 그대로).

## 32. MCP를 좁히는 두 가지 — **무엇을 부를 수 있는가**와 **얼마나 실리는가** (M3)

31절이 문에 닿는 길을 냈다. 그 길이 생기자마자 두 가지가 무제한이 됐다: 등록된 서버의 **모든**
도구를 부를 수 있고, 서버가 준 응답이 **얼마든지** 프롬프트에 실린다. 이 절이 둘 다 좁힌다.

### 32.1 허용목록은 게이트가 강제한다 — 승인을 묻기 **전에**

23.10절이 "서버별 도구 허용목록"을 미해결로 적으며 그 자리의 완화책으로 "승인은 매번 받는다"를
들었다. 그건 사실이지만 충분하지 않다: **매번 묻는 것은 매번 예라고 누르게 만든다.** 좁혀 둘 수
있으면 물어볼 일 자체가 줄어든다.

`McpServerConfig.tools`가 `Some`이면 그 목록만 부를 수 있다. 목록 밖의 도구와 등록되지 않은
서버는 **묻지 않고 거부**다. 실행 직전에 막는 방법도 있었지만 그러면 사용자는 이미 승인을 누른
뒤다 — **승인을 물은 뒤에 거부하면 사용자는 자기 승인이 의미 없었다고 배우고**, 그 학습은 진짜
승인 화면에도 옮는다.

**빈 목록은 오류다.** 아무 도구도 부를 수 없는 서버를 등록하는 것은 등록하지 않는 것과 같은데
화면에는 등록된 것으로 보인다 — 26.3절이 스킬의 허용목록에 대해 내린 판단과 같다. "좁히지
않음"은 `None`이고 `[]`가 아니다.

### 32.2 23.3절의 문장을 고친다 — 이유가 바뀌었다

23.3절은 이렇게 적었다: *"`mcp_call`은 언제나 `RequireUserApproval`이며 `task_policy`를 **보지
않는다.** 보면 언젠가 누군가 완화 조건을 넣는다."*

**`task_policy`를 보지 않는다는 것은 그대로 참이다** — 게이트가 새로 보는 것은 정책이 아니라
**등록**이고, 그 둘은 다르다. 정책은 사용자가 이 태스크에 대해 고르는 값이고 등록은 어떤 서버가
존재하는가에 대한 사실이다.

그런데 원래 문장이 기대던 논증은 "아무것도 안 보므로 낮출 수 없다"였고, 그 논증은 이제
쓸 수 없다. 대신 **결과의 모양**이 보장한다: `classify_mcp`가 낼 수 있는 것은 거부 아니면
`HumanOnly` 승인 셋뿐이고, **자동 허용이 나오는 갈래가 없다.** 등록 목록이 무엇이든 결과가
느슨해질 수 없다.

이 성질은 주석이 아니라 테스트가 지킨다(`no_registration_can_turn_an_mcp_call_into_an_auto_approval`) —
여러 등록·정책 조합을 훑어 자동 허용이 하나도 나오지 않는지 보고, **승인이 실제로 한 번은
나오는지도 함께 확인한다.** 전부 거부되는 상태에서는 그 전칭 명제가 아무 말도 하지 않는다.

### 32.3 게이트와 실행 경로가 **같은 목록**을 본다

허용목록을 `TaskPolicy`에 복사해 넣을 수도 있었다. 그러면 등록과 게이트가 갈라질 수 있고,
갈라진 쪽이 느슨하면 그게 우회 경로가 된다.

대신 `PolicyGate`가 `McpPool`을 그대로 들고 본다 — `ToolRuntime`이 도구를 부를 때 보는 것과
**같은 객체**다. 복사가 없으면 어긋남도 없다.

그 대가로 프로필을 만드는 자리마다 풀을 붙여야 한다. `TaskHost::with_mcp`가 기본 프로필의
게이트도 다시 만드는 이유가 그것이다 — 붙이지 않으면 태스크에 속하지 않는 요청의 게이트만
등록을 모른 채 남아 모든 `mcp_call`을 거부하고, 증상은 "가끔 MCP가 안 된다"로 보인다.

### 32.4 보여주는 집합과 부를 수 있는 집합은 **같은 곳에서 나온다**

허용목록은 카탈로그에도 적용된다. 게이트가 거부할 도구를 프롬프트에 실으면 **모델이 거부될
것을 요청하고**, 사용자는 이유 없는 거부 모달을 본다. 31.8절이 이 항목을 남기며 미리 적어둔
조건이 이것이었다.

좁혀졌다는 사실은 목록에도 적는다 — 적지 않으면 모델은 이 서버가 원래 도구가 적은 것으로 읽고,
없는 도구를 찾다 포기하는 대신 목록 밖의 것을 요청한다.

### 32.5 오타는 조용히 사라지지 않는다

허용목록에 `raed`라고 적으면 그 도구는 목록에도 없고 부르면 거부되는데, **사용자는 자기가
허용해 두었다고 믿는다.** 어디서도 원인을 볼 수 없는 상태다.

그래서 카탈로그를 모을 때 "허용목록에 있는데 서버가 내놓지 않은 도구"를 함께 세고,
`MCP_CATALOG_COLLECTED` 이벤트로 남긴다. **프롬프트에는 싣지 않는다** — 모델에게는 잡음이고
사용자에게는 원인이라, 실리는 자리가 다르다.

이 이벤트는 `TaskHost::mcp_catalog` 안에서 발행한다. 카탈로그를 모으는 경로가 둘(헤드리스
호스트·데스크톱)이므로 부르는 쪽에 맡기면 언젠가 한쪽만 남긴다.

### 32.6 서버가 준 응답에도 상한이 있다

파일에는 컨텍스트 예산이 있는데(context-engine 5절) MCP 응답에는 없었다 — **우리가 통제하지
못하는 입력에 상한을 두지 않는 것은 상한이 없는 것과 같다.** 서버가 큰 응답을 주면 프롬프트가
서버 마음대로 커진다.

둘을 좁힌다.

| 무엇 | 상한 | 넘으면 |
|---|---|---|
| 응답 하나의 바이트 | `MAX_MCP_RESULT_BYTES` | 자르고 **잘랐다고 적는다** |
| 한 라운드의 호출 개수 | `MAX_MCP_CALLS_PER_ROUND` | 실행하지 않고 **실행하지 않았다고 적는다** |

**스키마와 달리 응답은 자른다**(31.6절은 큰 스키마를 통째로 뺐다). 스키마는 계약이라 일부만
있으면 틀린 계약이 되지만, 응답은 정보라서 앞부분만 있어도 쓸모가 있다. 대신 잘린 사실을
적는다 — 조용히 자르면 모델은 잘린 JSON을 완전한 것으로 읽고 없는 필드를 없다고 단정한다.

호출 개수 상한이 없으면 초안 하나가 임의 개수를 요청할 수 있고, 승인 모달이 그만큼 뜨며
프롬프트가 그만큼 자란다(원칙 5). 버린 요청도 **말한다** — 말하지 않으면 모델은 그 호출이
아무 결과도 내지 않은 것으로 읽고, 없는 결과를 전제로 patch를 쓴다.

두 상한 모두 **유도한 값이 아니라 관례적 선택이다.** 실사용에서 서버가 얼마나 큰 응답을 주는지,
초안이 몇 건을 요청하는지 아직 모른다.

### 32.7 곁가지: 거부 사유의 이름이 거짓말을 하고 있었다

처음에는 등록 밖 호출을 `deny_malformed`로 냈고, 감사 기록의 `matchedRule`이
`malformed_tool_args`, 대상이 `(malformed)`가 됐다. **요청의 모양은 멀쩡했다** — 틀린 것은
등록이거나 도구 이름이다. e2e를 쓰면서 그 payload를 실제로 읽고 나서야 드러났다.

`mcp_not_registered`로 따로 내고, 대상에는 **무엇을 부르려 했는지**를 남긴다. 감사 기록이
원인을 엉뚱한 곳으로 가리키면 그 로그는 감사에 쓸 수 없다.

같은 자리에서 e2e의 단언 하나도 고쳤다. `tool_executions`는 **요청도 담는 뷰**이므로 행이
있다는 것만으로는 실행됐다는 뜻이 아니다 — 31절의 e2e가 그 구별 없이 통과하고 있었고,
그 단언은 "요청이 만들어졌다"까지만 말하고 있었다.

### 32.8 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 등록 검사 | Rust 단위 (`mcp.rs`) | 빈 목록·빈 이름 거부 / 두 거부 사유가 서로 다른 문장 |
| 한 소스 | Rust 단위 | 카탈로그에 남은 도구와 게이트가 통과시키는 도구가 **같다** |
| 오타 | Rust 단위 | 서버가 내놓지 않은 허용 항목이 따로 세어진다 |
| 게이트 | Rust 단위 (`policy/mod.rs`) | 등록 밖 서버·목록 밖 도구는 **묻지 않고 거부** / 어떤 등록으로도 자동 허용이 나오지 않는다 |
| 상한 | sidecar 단위 | 큰 응답이 잘리고 잘렸다고 말한다 / 라운드당 개수 상한과 버린 것의 보고 |
| 실제 차단 | e2e | 허용목록 밖 호출이 **실행되지 않고**, `mcp_not_registered`로 거부되며, 오타가 감사 이벤트에 남고, 모델은 거부를 결과로 본다 |

### 32.9 아직 하지 않은 것

- **서버 환경변수** (23.10절 그대로). 사용자가 서버에 토큰을 주려면 그 토큰이 어디에 저장되는지부터
  정해야 하고, 그건 자격증명 저장의 문제다.
- **오타 난 허용목록을 화면이 보여주는 것.** 지금은 이벤트 로그에만 있다. 등록 화면이
  "지금 물어보기"를 할 수 있으면 등록 시점에 알릴 수 있지만, 그건 등록 화면이 프로세스를
  띄우게 되는 별개의 결정이다.
- **상한값의 근거** (32.6절).
- **원격(HTTP/SSE) 서버** (23.10절 그대로).

## 33. 훅에 문맥을 넘긴다 — **식별자만, 환경변수로** (M3)

25.7절이 미해결로 남긴 것: *"지금 훅은 인자를 받지 않으므로 '어느 태스크의 어느 phase인가'를
모른다."* 그 상태의 훅은 **"무언가 일어났다"밖에 모른다** — 알림 훅조차 쓸 수 없다.

### 33.1 인자가 아니라 환경변수다

등록된 argv는 **승인의 근거**다(25.3절): 실행되는 것이 등록된 것과 같아야 한다. 여기에 인자를
덧붙이면 그 등식이 깨지고, 사용자가 등록한 명령과 실제로 도는 명령이 달라진다. 그래서 argv는
손대지 않고 환경으로 넘긴다.

### 33.2 식별자만 넘긴다 — 내용은 넘기지 않는다

넘기는 것은 셋뿐이다.

| 변수 | 값 |
|---|---|
| `TOMVERSE_TASK_ID` | 태스크 id |
| `TOMVERSE_PHASE` | 이 훅이 걸린 phase |
| `TOMVERSE_HOOK` | `1` — 같은 스크립트를 훅과 수동 실행 양쪽에 쓸 수 있게 |

**사용자 요청문·patch·기준·검증 출력은 넘기지 않는다.** 그것들은 *내용*이고, 훅은 게이트 밖의
임의 프로그램이다(25.5절) — 내용을 넘기는 순간 **훅 등록이 곧 그 태스크 내용에 대한 접근
허가**가 된다. 등록은 "이 프로그램을 이 시점에 돌려라"였지 "이 작업의 내용을 이 프로그램에
줘라"가 아니었다.

식별자만으로도 훅은 할 일을 안다. 그리고 **성패는 phase가 말한다** —
`COMPLETED`/`FAILED`/`CANCELLED`가 종료 phase이므로 별도의 성공/실패 변수를 두지 않는다.

같은 이름이 부모 환경에 이미 있으면 **우리 값이 이긴다.** 모호하면 중첩 실행에서 훅이 바깥
실행의 태스크를 이번 태스크로 착각한다.

### 33.3 이 필드를 Node가 채울 수 없다는 것이 보안 모델 전부다

환경변수는 `ToolRequest.injected_env`로 실린다. 그 필드는 **`skip_deserializing`이다** — Node가
보내는 JSON에서 읽지 않는다.

읽으면 장악당한 sidecar가 **임의 명령에 임의 환경변수를 넣을 수 있고**, 그건 argv를 고정해 얻은
보장(원칙 6)을 옆문으로 무효화한다: 승인 화면은 argv만 보여주는데 동작은 환경이 바꾼다.
`PATH`를 바꿔 `npm`이 다른 프로그램을 가리키게 만드는 것이 가장 단순한 예다.

**직렬화는 한다.** 감사 기록이 "무엇이 넘어갔는가"에 답해야 하기 때문이다.

주석이 아니라 테스트가 지킨다: `injectedEnv`가 든 JSON을 파싱해 비어 있는지 보고, **같은
JSON의 다른 필드는 실제로 읽히는지도 함께** 확인한다 — 파싱 자체가 깨져 있으면 앞 단언은
아무 말도 하지 않는다.

### 33.4 넣는 순서가 제거보다 뒤다

`run_process`는 알려진 공급자 키와 테스트 러너 제어 변수를 `env_remove`로 지운다. 주입은
**그 다음에** 한다. 순서가 반대면 제거 목록이 우리가 넣은 값을 지울 수 있고, 그러면 "넘겼다고
기록했는데 도착하지 않은" 상태가 된다 — 감사 기록이 거짓이 되는 방향이다.

### 33.5 25.7절이 요구한 투명성

그 절은 "무엇이 넘어가는지가 전송 투명성의 대상이 된다"며 배선 없이 넘기지 않겠다고 적었다.
값이 식별자뿐이라 **`HOOK_EXECUTED` payload에 그대로 남긴다** — 넘긴 것을 기록하지 않으면
"훅에 무엇을 줬나"에 답할 수 없다.

프로바이더 전송 집계(7.2절)에는 넣지 않는다. 훅으로 나가는 것은 **공급자로 나가는 것이
아니다** — 한 화면에 섞으면 "모델에게 무엇이 갔나"라는 질문의 답이 흐려진다.

### 33.6 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 무엇을 넘기는가 | Rust 단위 (`hooks.rs`) | 키가 셋뿐이다 / 종료 phase가 실제로 그 값에 온다 |
| 실제 도착 | Rust 단위 (`tools/mod.rs`) | 자식 프로세스가 값을 읽는다 / 주입하지 않으면 그 변수가 **없다** |
| Node 차단 | Rust 단위 | JSON의 `injectedEnv`가 무시되고, 같은 JSON의 다른 필드는 읽힌다 |
| 끝에서 끝까지 | e2e | 실제 훅 프로세스가 태스크 id와 phase를 파일로 적어낸다 / 그 값이 `HOOK_EXECUTED`에도 남는다 |

**"주입하지 않으면 없다"를 따로 재는 이유**: 있으면 부모 환경이 새고 있다는 뜻이고, 그때 훅은
바깥 실행의 태스크를 이번 태스크로 착각한다. 도착 여부만 재면 그 상태가 통과한다.

### 33.7 아직 하지 않은 것

- **내용을 넘기는 경로.** 33.2의 결정이며, 바꾸려면 "등록이 무엇에 대한 허가인가"부터 다시
  정해야 한다. 요약 한 줄이라도 넘기려면 그것이 훅으로 나가는 사실을 화면이 말해야 한다.
- **훅이 결과를 돌려주는 것.** 훅은 관찰자이므로(25.4절) 출력은 기록만 되고 아무 데도 쓰이지
  않는다. 쓰려면 차단형 훅과 같은 질문을 지난다.
- **`TOMVERSE_*` 이름의 안정성.** 지금은 우리가 정한 값이고 문서에만 있다 — 등록 화면이
  이 목록을 보여주면 사용자가 무엇을 쓸 수 있는지 알 수 있다.

## 34. 스킬 파일은 **모델이 쓸 수 있는 자리**에서 오면 안 된다 (M3)

29.1절이 등록 설정에 대해 내린 판단을 스킬에 두 번째로 적용한다. **그리고 이번에는 이미
있는 결함을 고치는 것이다** — 26절이 만든 `--skill <파일>`은 경로를 가리지 않았다.

### 34.1 무엇이 새어 있었는가

Policy Gate는 파일 쓰기를 워크스페이스 안으로 가둔다. 뒤집으면 **워크스페이스 안의 파일은
모델이 쓸 수 있는 파일**이라는 뜻이다(29.1절과 같은 문장).

스킬 파일은 두 가지를 정한다.

| 조각 | 모델이 그 파일을 고치면 |
|---|---|
| `instructions` | **자기 다음 프롬프트에 지시문을 심는다.** 그 블록은 사용자가 고른 것으로 표시되어 실린다 |
| `allowedTools` | **자기가 좁혀 둔 것을 스스로 되돌린다.** 허용목록을 지우면 좁히기가 사라진다 |

두 번째가 특히 나쁘다. 26.3절은 "허용목록은 좁히기만 한다"를 불변식으로 세웠는데, 그 불변식은
**허용목록 자체가 사용자의 것일 때만** 의미가 있다. 파일이 모델의 손에 있으면 좁히기는
모델이 언제든 취소할 수 있는 자기 규율이 된다.

경로는 이렇다: 태스크 1이 워크스페이스 쓰기 권한으로 그 파일을 고치고(무인 실행 +
`--auto-approve-writes`면 아무도 보지 않는다), 태스크 2가 **같은 스킬을 골랐는데** 다른 내용을
받는다. 사용자는 자기가 고른 스킬이 그대로라고 믿는다.

### 34.2 고치는 방법은 위치를 판정하는 것이다

`skills::load`가 워크스페이스 루트를 함께 받아, 그 안의 경로를 **읽기 전에 거부한다.**

**규칙이 임의적이지 않다는 것이 요점이다.** "워크스페이스 밖"은 우리가 고른 경계가 아니라
**게이트가 이미 지키고 있는 경계의 여집합**이다 — 모델이 쓸 수 있는 곳이 워크스페이스 안이므로,
그 밖에서 오는 것만 "사용자의 것"이라고 말할 수 있다. 상태 디렉터리든 홈 디렉터리든 상관없다.

`WorkspaceRoot::contains`는 **canonical로 비교한다.** `..`이나 심링크로 우회할 수 있으면 이
판정의 답이 거짓이 되고, 그 거짓은 "안전한 자리에서 읽었다"는 결론으로 이어진다. 워크스페이스
안의 심링크가 밖을 가리키면 실체가 밖이므로 통과하고, 모델이 그 심링크를 다시 안쪽으로 돌리면
canonical이 안이 되어 걸린다.

존재하지 않는 경로는 "안이 아니다"로 답한다. 없는 파일은 **읽기 실패**로 보고되어야 한다 —
위치 검사가 그 원인을 가리면 사용자는 경로 오타를 "워크스페이스 안이라서"로 읽는다.

### 34.3 잃는 것 — 저장소에 스킬을 두고 팀이 공유하는 것

29.1절이 설정에 대해 적은 것과 같은 대가다. 그리고 **같은 길로 되찾는다**: 워크스페이스 안의
파일을 *읽어서 제안*하고 사용자가 승인하는 경로(29.5절). 그 경로가 생기면 설정과 스킬이 함께
지나간다 — 두 기능이 같은 이유로 막혀 있으므로 해법도 하나다.

그때까지의 우회는 단순하다: **워크스페이스 밖으로 복사한다.** 거부 사유가 그 문장을 담는다 —
거부만 하면 사용자는 자기 파일이 왜 안 되는지 모른 채 경로를 의심한다.

### 34.4 화면은 미리 말한다

거부된 뒤에 알면 사용자는 경로 오타를 의심한다. 스킬 입력 옆에 **왜** 밖이어야 하는지를 함께
적는다 — "밖에 두세요"만 적으면 임의의 규칙으로 읽히고, 임의의 규칙은 우회할 방법을 찾게 만든다.

### 34.5 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 위치 판정 | Rust 단위 (`skills.rs`) | 루트 바로 아래·하위 디렉터리·`..` 우회가 모두 거부된다 |
| 공허하지 않음 | Rust 단위 | **밖에 있으면 실제로 읽힌다** — 없으면 위 검사들은 "언제나 거부"로도 통과한다 |
| 원인 분리 | Rust 단위 | 없는 파일은 위치가 아니라 **읽기 실패**로 보고된다 |
| 끝에서 끝까지 | e2e | 워크스페이스 안의 스킬로 실행하면 **태스크가 시작되기 전에** 0이 아닌 종료 코드로 거부되고, 사유가 고치는 방법을 말한다 |

### 34.6 같은 질문을 지나는 다른 파일들

| 파일 | 어디서 오는가 | 상태 |
|---|---|---|
| 훅·MCP 등록 설정 | 상태 디렉터리 | 29.1절에서 이미 밖이다 |
| 스킬 | 사용자가 고른 경로 | **이 절에서 밖으로 강제한다** |
| Run Card(가설 게이트) | 해시로 봉인 | 내용이 바뀌면 해시가 어긋난다 |
| export 파일(`reproduce --file`) | 사용자가 고른 경로 | **아직 가리지 않는다** — 34.7절 |

### 34.7 아직 하지 않은 것

- **`reproduce --file`의 위치.** 워크스페이스 안의 export 파일을 가리킬 수 있다. 스킬만큼
  나쁘지는 않다 — 재현의 각 단계가 Policy Gate를 그대로 지나고 승인도 받기 때문이다(21절).
  그래도 "모델이 쓴 파일을 감사 기록으로 읽는다"는 모양은 남아 있다.
- ~~**저장소 안의 스킬을 읽어서 제안하는 것**~~ → 36.3절. 승인된 사본이 사는 자리(보관함)를
  정하고 나니 35절과 같은 모양이 됐다 — 읽어서 보여주고, 가져오기를 누르면 **사본**이 들어간다.
- ~~**적용된 스킬을 화면이 보여주는 것**~~ → 37절. 스킬만 따로 보여주는 대신 **고정된 설정
  전체**를 한 자리에 냈다 — 사용자가 묻는 것은 "스킬이 걸렸나"가 아니라 "무엇을 켠 채로
  도는가"이고, 스킬은 그 답의 한 줄이다.

## 35. 저장소가 **제안하고** 사용자가 등록한다 (M3)

29.5절과 34.3절이 같은 자리에 같은 미해결을 남겼다: *"워크스페이스 안의 설정을 읽어 제안하는
것. 팀 공유는 그 경로로만 가능하다."* 두 기능이 같은 이유로 막혀 있었으므로 해법도 하나다.

### 35.1 무엇이 막고 있었는가

29.1절의 판단: 등록 설정을 워크스페이스 안에 두면 **모델이 자기 훅과 자기 MCP 서버를 등록할
수 있다.** 34절이 스킬에 같은 판단을 적용했다.

그 판단은 옳지만 대가가 있었다 — 팀이 저장소에 설정을 두고 공유할 수 없다. 이 절이 그 대가를
치르지 않고 공유를 되찾는다.

### 35.2 읽는 것과 등록하는 것을 나눈다

`.tomverse/proposal.json`은 **제안**이다. 우리가 그 파일로 하는 일은 하나뿐이다: **화면에
문장을 띄운다.**

| 단계 | 누가 | 어디에 |
|---|---|---|
| 제안을 둔다 | 저장소(=사람이든 모델이든) | 워크스페이스 안 |
| 읽어서 보여준다 | Rust → 화면 | 아무 데도 쓰지 않는다 |
| 입력칸에 채운다 | 사용자가 누른다 | 화면의 draft |
| 등록한다 | 사용자가 저장을 누른다 | **상태 디렉터리** (기존 `save` 경로) |

**등록으로 가는 지름길을 만들지 않는 것이 이 설계의 전부다.** 읽은 값으로 곧장 등록하는 함수를
하나라도 만들면 그 순간 모델이 자기 훅을 등록할 수 있게 되고, 29.1절의 판단이 무효가 된다.

그래서 승인은 **기존 저장 경로를 그대로 지난다** — 제안이 있든 없든 `set_workspace_settings`가
하는 일은 같다. 새 쓰기 경로가 없으므로 새로 지켜야 할 규칙도 없다.

### 35.3 그래도 검증은 읽는 자리에서 한다

화면에 띄우기 전에 형식을 확인한다. 잘못된 제안을 그대로 띄우면 사용자는 저장을 누른 뒤에야
거절당하고, **그 거절의 원인이 자기 편집인지 저장소의 제안인지 구별할 수 없다.**

읽지 못한 것과 없는 것도 뭉개지 않는다. 형식이 틀린 제안을 조용히 "없음"으로 만들면 저장소가
제안을 두었는데 화면에는 아무것도 안 뜬다.

그리고 제안을 읽지 못했다고 **등록 편집까지 막지 않는다** — 저장소의 파일 하나가 이 화면
전체를 못 쓰게 만들면 안 된다.

### 35.4 세 상태를 뭉개지 않는다

`Absent` / `SameAsRegistered` / `Differs`. 사용자가 할 일이 각각 다르고, 특히 마지막은
**저장소가 바뀌었다**는 신호다 — 등록은 그대로인데 제안이 달라졌다는 뜻이므로, 팀이 설정을
고쳤거나 모델이 그 파일을 건드렸다.

이미 등록과 같으면 불러오기 버튼을 그리지 않는다. 누를 이유 없는 버튼은 사용자를 헷갈리게 한다.

### 35.5 화면이 반드시 말해야 하는 것

- **"등록되었습니다"가 아니다.** 저장소는 아무것도 등록하지 않았다 — 불러오기는 입력칸을
  채울 뿐이고, 등록은 사용자가 저장을 누를 때 일어난다.
- **출처.** 이 내용은 워크스페이스 안의 파일에서 왔고, 그 파일은 모델이 쓸 수 있다(34.1절).
  말하지 않으면 사용자는 팀이 적어둔 것이라고 읽는다.
- 경로는 **호스트가 준 값**을 그대로 쓴다. 화면이 지어내면 사용자를 없는 파일로 보낸다.

### 35.6 이것이 막지 못하는 것

**설득은 막지 못한다.** 모델이 `safe-formatter`라는 이름으로 위험한 프로그램을 제안하고
사용자가 확인 없이 저장을 누르면 등록된다. 우리가 하는 것은 그 내용을 **argv 그대로** 보여주고
출처를 말하는 것까지다(원칙 6과 23.4절의 연장).

`validate_servers`의 셸 문자열 거부(23.6절)가 한 겹 더 있지만, 그건 공격이 아니라 흔한 설정
실수를 잡는 장치라고 이미 적어두었다. **여기서 우리가 주장할 수 있는 것은 "자동으로 등록되지
않는다"이지 "위험한 등록이 불가능하다"가 아니다.**

### 35.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 읽기가 등록이 아니다 | Rust 단위 | 제안을 읽어도 등록 파일이 **생기지 않는다** |
| 없는 것은 오류가 아니다 | Rust 단위 | 파일이 없으면 `Absent` |
| 먼저 검증한다 | Rust 단위 | 잘못된 제안은 화면에 닿기 전에 오류 |
| 상태 구별 | Rust 단위 | 같음과 다름이 다른 값이다 |
| 경로의 단일 출처 | Rust 단위 | 표시용 경로가 **실제로 여는 경로**와 같다 |
| 화면 문장 | desktop 단위 | "아직 등록되지 않았습니다" / 같으면 불러오기를 권하지 않는다 / 호스트가 준 경로를 그대로 쓴다 |

### 35.8 아직 하지 않은 것

- ~~**스킬의 공유.**~~ → 36절. 승인된 사본이 사는 자리를 정하자 같은 모양이 됐다.
- **제안과 등록의 차이를 항목별로 보여주는 것.** 지금은 "다르다"까지만 말한다.
- **제안 파일의 이력.** 저장소가 언제 바꿨는지는 git이 알지만 우리는 묻지 않는다.

## 36. 스킬 보관함 — 고를 목록이 있어야 고를 수 있다 (M3)

26.6절의 "UI 선택 화면"은 오래 미해결이었는데, 막고 있던 것은 화면이 아니라 **"스킬이 어디
사는가"** 였다. 34절이 절반을 정했고(워크스페이스 안은 아니다) 이 절이 나머지 절반을 정한다.

### 36.1 자리를 고르면 규칙이 따라온다

보관함은 **상태 디렉터리의 `skills/`** 다. 모델이 쓸 수 없는 곳이므로 34절의 규칙을
**자리 선택으로 만족한다** — 규칙을 한 번 더 적고 지키는 대신, 규칙을 만족하는 자리를 고른다.

그래서 보관함의 스킬은 아무 조건 없이 태스크에 쓸 수 있다. `load`가 워크스페이스 안을 거부해도
보관함은 애초에 밖이다.

### 36.2 깨진 항목을 목록에서 지우지 않는다

읽지 못한 파일도 목록에 남고 사유가 붙는다. 지우면 사용자는 **자기 파일이 왜 안 보이는지
모른다** — 31.6절이 "물어보지 못한 서버"에 대해 내린 판단과 같다: 없는 것과 읽지 못한 것은
다른 사실이다.

다만 고를 수는 없다. 고르게 두면 태스크 시작에서 거절되고, 그 거절은 이 목록이 이미 아는
사실을 뒤늦게 말하는 것이다.

정렬은 파일 이름 순이다. 디렉터리 순회 순서는 OS가 정하므로 그대로 두면 화면이 실행마다 흔들린다.

### 36.3 저장소의 스킬은 **제안**이다 (35절의 두 번째 적용)

`.tomverse/skills/*.json`을 읽어 보여주지만 **보관함에 넣지는 않는다.** 가져오기를 누르면
그때 **사본**이 보관함에 들어간다.

**사본이라는 것이 요점이다.** 참조로 두면 34.1절의 구멍이 그대로 남는다 — 모델이 저장소의
파일을 고치면 다음 태스크가 다른 내용을 받는다. 복사한 뒤에는 저장소가 바뀌어도 사본은 그대로다.

**덮어쓰지 않는다.** 같은 이름이 이미 있으면 거절한다 — 덮어쓰면 사용자가 손으로 고쳐 둔
보관함의 스킬이 조용히 사라진다. 지우고 다시 가져오는 것은 사용자가 정한다.

가져오기 **전에** 검증한다. 깨진 파일을 넣으면 보관함에 문제 항목이 늘 뿐이다.

### 36.4 이름은 이름이고 경로가 아니다

보관함 항목은 **파일 이름**으로 가리킨다. 경로 조각(`../`, `sub/`)이 들어오면 보관함 밖의
파일을 읽거나 지울 수 있으므로, 이름 검사가 그것을 막는다 — `.json`으로 끝나는 순수한 파일
이름만 통과한다.

**경로 조립은 Rust가 한다.** 화면이 조립하게 두면 보관함의 자리가 화면에도 적히고, 옮길 때
한쪽만 고쳐진다. 화면은 이름을 주고 절대 경로를 받는다.

`file`이 열쇠이고 스킬의 `name`이 아닌 이유: **이름은 중복될 수 있다.** 두 파일이 같은 이름을
쓰면 어느 것을 골랐는지 정해지지 않는다.

### 36.5 직접 경로 입력을 없애지 않는다

목록은 **더 쉬운 길**이지 유일한 길이 아니다. 보관함에 넣을 수 없는 상황(읽기 전용 설치,
다른 도구가 관리하는 스킬 디렉터리)에서 기능 자체를 못 쓰게 되면 안 된다.

### 36.6 화면이 반드시 말해야 하는 것

- **"가져왔습니다"는 "적용했습니다"가 아니다.** 가져오기는 보관함에 사본을 만들 뿐이고,
  태스크에 쓰이는 것은 그 다음에 고를 때다.
- **보관함과 제안을 섞지 않는다.** 하나는 이미 승인된 것이고 다른 하나는 아직 아무것도 아니다.
  섞으면 사용자는 저장소가 둔 것을 자기가 승인한 것으로 읽는다.
- **비었을 때 "0개"라고 쓰지 않는다.** 있었는데 사라진 것처럼 읽힌다 — 어디에 두는지를 말한다.
- 이미 보관함에 있는 제안은 가져오기를 권하지 않는다. 덮어쓰지 않으므로 눌러도 거절된다.

### 36.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 목록 | Rust 단위 | 없으면 빈 목록 / 깨진 항목이 사유와 함께 남는다 / 파일 이름 순 |
| 이름 검사 | Rust 단위 | 경로 조각·확장자 없는 이름을 거부하고, **평범한 이름은 통과한다** |
| 제안이 가져오기가 아니다 | Rust 단위 | 목록을 읽어도 보관함은 그대로다 |
| 사본 | Rust 단위 | 가져온 뒤 저장소를 바꿔도 보관함의 내용이 그대로다 |
| 덮어쓰지 않는다 | Rust 단위 | 같은 이름이면 거절하고 기존 내용이 남는다 |
| 자리 선택 | Rust 단위 | 보관함 경로는 `load`(34절의 거부)를 그대로 지난다 |
| 화면 문장 | desktop 단위 | 두 수를 따로 센다 / "가져와야 들어갑니다" / 이미 있거나 깨진 제안은 가져오기 대상이 아니다 |

### 36.8 아직 하지 않은 것

- ~~**적용된 스킬을 실행 중에 보여주는 것**~~ → 37절. 고정된 설정 전체를 한 패널에 냈고,
  스킬은 그 안의 한 줄이다.
- **스킬을 여러 개 겹치는 것**(26.6절 그대로). 보관함이 생겼으니 겹치기가 자연스러워 보이지만,
  허용목록의 교집합과 지시문 순서를 정해야 하고 그 답은 실제 사용을 봐야 안다.
- **보관함에서 스킬을 만들거나 고치는 것.** 지금은 파일을 손으로 두거나 가져오는 것뿐이다.
- **이름 충돌을 화면에서 푸는 것.** 지금은 "이미 있습니다"로 거절하고 사용자가 지워야 한다.

## 37. 이 태스크가 **무엇을 가지고 도는가** (M3)

26.6절·34.7절·36.8절이 같은 항목을 세 번 적었다 — "적용된 것을 실행 중에 보여주는 것". 세 번
적혔다는 것은 자리가 없다는 뜻이다. 화면에는 모델·경과·비용·단계가 있는데, **무엇을 켠 채로
돌고 있는가**에 답하는 자리가 하나도 없었다.

### 37.1 요청한 것과 적용된 것은 **다른 사실이다**

화면이 자기 폼 상태로 이 답을 만들 수 있어 보인다. 스위치를 아는 것은 화면이니까. 그런데 그
답은 **틀릴 수 있고, 틀려도 자신 있게 말한다**:

- 스킬이 도구를 좁힌다(26.1절). 사용자는 아무것도 고르지 않았지만 허용목록이 생긴다.
- MCP 등록은 워크스페이스를 열 때 붙는다(32절). 태스크 시작 화면에는 나타나지 않는다.
- 훅도 마찬가지다(25절).
- 검증 명령의 고정 집합은 태스크 시작 시점의 **매니페스트에서 유도된다**(24.5절). 폼에는
  자동 승인 스위치만 있고, 그 스위치가 실제로 무엇을 자동 승인하는지는 폼이 모른다.

그래서 답은 **Rust가 고정한 것**에서 와야 한다. `begin_task`가 `TaskProfile`을 만드는 그
순간이 유일하게 "적용된 것"이 전부 모이는 지점이고, 거기서 `TASK_CONFIG_PINNED`를 남긴다.

### 37.2 시작 시점의 사실이라고 **말한다**

이 이벤트는 태스크가 시작될 때 한 번 남는다. 이후의 변화 — 사전 승인 철회(24.7절), 판정의
철회(30절) — 는 각자의 이벤트로 남는다.

한 패널이 "지금 적용된 것"이라고 주장하면 그 뒤의 이벤트를 무시하게 되고, 화면이 낡은 사실을
현재형으로 말한다. 그래서 **패널 문장이 범위를 밝힌다**: "태스크를 시작할 때 고정된 값이고,
이후의 변화는 이벤트 로그에 따로 남습니다."

시작 시점을 고른 것은 게으름이 아니라 이 이벤트가 답하는 질문이 그것이기 때문이다 — 실행이
끝난 뒤 결과를 읽을 때 알아야 하는 것은 **그 실행이 무엇을 가지고 돌았는가**다.

### 37.3 `null`과 빈 배열을 뭉개지 않는다

허용목록에서 이 구별이 정반대로 읽힌다:

| 값 | 뜻 |
|---|---|
| `null` | 좁히지 않았다 — 게이트의 기본 분류가 그대로 적용된다 |
| `[]` | 허용된 도구가 없다 |

`Option<Vec<..>>`를 `unwrap_or_default()`로 펴면 전자가 후자로 바뀐다. 그러면 화면이 "아무
도구도 못 씁니다"라고 말하는데 실제로는 전부 쓸 수 있다. 그래서 요약은 `Option`을 그대로
직렬화하고, 화면도 두 문장을 따로 만든다.

검증 명령의 빈 집합도 같은 종류다. 비어 있는 것은 **설정이 아니라 프로젝트의 사실이다** —
매니페스트에 선언된 명령이 없으면 자동 승인을 켜도 자동 승인될 것이 없다. 문장이 그 이유를
말하지 않으면 사용자는 스위치가 고장 났다고 읽는다.

### 37.4 끈 것도 보여준다

켜진 것만 나열하는 편이 짧다. 하지만 이 패널을 보는 이유의 절반은 **"켰다고 생각했는데"**를
확인하는 것이다. 없는 줄은 "끄셨습니다"가 아니라 "이 화면이 말하지 않았습니다"로 읽힌다.

MCP 서버도 같은 이유로 이름만 내지 않는다. 좁혀진 도구 목록을 함께 낸다 — "서버 3개 등록됨"만
보면 그 서버들이 무엇이든 부를 수 있다고 읽고, 좁혔다는 사실은 좁힌 사람에게도 잊힌다.

### 37.5 잠금을 놓고 나서 기록한다

`begin_task`는 `profiles` 잠금을 쥔 채로 프로필을 넣는다. 그 자리에서 이벤트를 남기면
`append_event`가 훅을 부를 수 있고(25절), 훅 경로가 프로필을 다시 읽으면 같은 잠금에서
교착한다. 그래서 삽입 → 잠금 해제 → 기록 순서다.

이벤트 기록 실패로 태스크 시작을 막지는 않는다. 이 이벤트는 **투명성**이지 게이트가 아니다 —
못 남겼다고 실행을 거부하면, 보여주려고 만든 것이 실행을 막는 새 실패 원인이 된다.

### 37.6 지난 작업 기록에도 같은 패널이 뜬다

같은 질문("무엇을 가지고 돌았는가")은 실행 중보다 **끝난 뒤**에 더 자주 나온다. 그래서
저장된 작업 기록에도 같은 패널을 그린다. 이 이벤트가 없던 시절의 기록에서는 패널이 스스로
사라진다 — 없는 값을 기본값으로 채우면 화면이 **하지 않은 설정을 했다고 말한다.**

이 때문에 패널의 prop 타입은 실시간 `TaskEvent`도 저장된 `StoredEvent`도 아닌, 둘이 공통으로
가진 두 필드다. 한쪽으로 못박으면 지난 기록에서 같은 답을 볼 수 없다.

### 37.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 기록된다 | Rust 단위 | `begin_task`가 스위치·허용목록을 남기고 **sink(화면)에도 간다** |
| 좁힘의 구별 | Rust 단위 | 좁히지 않은 태스크는 `allowedTools`가 `null`이지 `[]`가 아니다 |
| 검증 고정 | Rust 단위 | 매니페스트에 `test`가 있으면 고정 집합이 요약에 들어간다 |
| 등록 | Rust 단위 | 등록된 훅이 phase와 함께 요약에 들어간다 |
| 화면 문장 | desktop 단위 | `null`/`[]`가 다른 문장이 된다 / 빈 고정 집합이 이유를 말한다 / 끈 스위치도 줄로 남는다 / MCP가 좁혀졌는지를 말한다 / 빈 payload에서도 문장이 만들어진다 |

### 37.8 아직 하지 않은 것

- **시작 이후의 변화를 이 패널에 합치는 것.** 지금은 시작 시점만 말하고 나머지는 이벤트
  로그에 흩어져 있다. 합치려면 어떤 이벤트가 이 요약의 어느 줄을 바꾸는지를 정해야 하고,
  그 목록이 틀리면 화면이 다시 자신 있게 틀린 답을 한다 — 잘못 합치느니 범위를 밝히는 편이 낫다.
- **왜 그 값이 됐는지.** 허용목록이 스킬 때문에 좁혀졌다는 것은 스킬 줄과 목록 줄을 함께
  봐야 알 수 있다. 값마다 출처를 달려면 `TaskPolicy`가 출처를 들고 다녀야 한다.
- **모델 지정.** 라우팅 결과는 별도 패널(모델)에 이미 있어서 중복을 만들지 않았다. 두 패널이
  갈리는 경우(스킬의 모델 지정이 화면 지정에 지는 26.1절)가 실제로 헷갈리는지는 사용을 봐야 안다.

## 38. 격리 실행을 화면에서 — 막고 있던 것은 화면이 아니었다 (M3)

22.7절이 "UI 배선"과 "태스크 기록과의 연결"을 남겨두었다. 배선을 하려고 보니 **배선이 문제가
아니었다.**

### 38.1 격리는 태스크가 아니라 **여는 시점**에 정해진다

헤드리스 호스트에서는 `--worktree`가 태스크 단위처럼 보인다. 그건 그 프로세스가 태스크 하나만
돌기 때문이지 설계가 태스크 단위여서가 아니다.

데스크톱에서 게이트 루트는 `TaskHost`가 만들어질 때 정해지고, **sidecar가 그 호스트에 묶여
뜬다**(process-architecture 5절). 태스크마다 루트를 바꾸려면 태스크마다 sidecar를 다시 띄우거나
루트를 갈아끼워야 하는데, 후자는 원칙 2가 막는 바로 그 모양이다 — 게이트 루트를 나중에 바꿀 수
있으면 게이트가 아니다.

그래서 격리는 **워크스페이스를 여는 시점**에 고른다. 화면이 정할 수 없는 것을 화면에 두지
않는다.

### 38.2 게이트 루트와 **신원 루트**가 갈린다

"루트를 바꾸는 것이 전부다"(22.1절)를 그대로 옮기면 조용한 결함이 생긴다. `workspace_id`가
루트 경로에서 유도되므로, 격리 트리를 루트로 주면 **id가 바뀐다.** 그 id에 매달린 것들이 함께
사라진다:

- 등록한 훅과 MCP 서버(29절) — 설정 파일이 `workspace_id`로 키잉되어 있다.
- 작업 기록과 세션 메모리가 나르는 판정(27절).

사용자에게는 "격리를 켰더니 등록이 없어졌다"로 보이고, 그건 격리가 약속한 것이 아니다. 격리가
약속한 것은 **본체 파일을 건드리지 않는 것** 하나다.

그래서 경로를 둘로 나눈다. 판정은 `worktree::roots`에 있다 — 화면이나 세션 코드가 각자 정하면
언젠가 한쪽만 고쳐진다.

| | 무엇인가 | 격리하면 |
|---|---|---|
| **게이트 루트** | 파일이 실제로 바뀌는 곳 | 격리 트리 |
| **신원 루트** | `workspace_id`와 거기 매달린 설정이 따라가는 곳 | **그대로 저장소** |

작업 기록에 적히는 경로도 저장소다. 격리 트리를 적으면 트리를 정리한 뒤 그 기록이 없는 경로를
가리킨다.

### 38.3 어디서 돌았는지가 **기록에 남는다**

22.7절의 "태스크 기록과의 연결"은 37절이 만든 자리에 그대로 들어갔다 — **어디서 도는가도
"무엇을 가지고 도는가"의 한 줄이다.** `TASK_CONFIG_PINNED`에 격리 사실이 실린다.

stderr 한 줄로 두면 안 되는 이유는 그것이 **흘러가기 때문**이다. 지난 작업 기록을 여는 사람에게
그 줄은 없고, 그 사람이 묻는 것이 정확히 "결과가 어디 있는가"다. 없으면 본체에서 결과를 찾다가
"아무것도 안 바뀌었다"고 읽는다 — 격리가 성공했다는 바로 그 사실 때문에.

격리하지 않은 실행은 `null`이다. 언제나 채우면 화면이 모든 작업에 "격리 실행"이라고 말한다.

### 38.4 말하지 않으면 정반대로 읽히는 것 **셋**

22.5절이 둘을 적었다(본체의 변경이 따라오지 않는다 / 재사용은 재사용이다). 화면을 만들며 셋째가
드러났고, 그건 **조건이 없다**:

> 결과는 본체가 아니라 격리 트리에 남습니다.

앞의 둘은 조건부다(본체가 더러울 때 / 이어 쓸 때). 셋째는 격리를 켠 사람이 **언제나** 하는 일에
대한 것이다 — 결과를 본체에서 찾는 것.

문장은 `Isolation::notices()`가 만든다. 헤드리스는 stderr로, 데스크톱은 배너로 내되 **조건은 한
곳에서 정한다** — 각자 적으면 한쪽 사용자만 듣게 된다.

### 38.5 다시 열기가 격리를 조용히 떨어뜨리고 있었다

sidecar가 죽으면 배너의 "다시 열기"가 같은 워크스페이스를 다시 연다. 그 코드는 `rootPath`를
넘겼는데, 격리 실행에서 `rootPath`는 **격리 트리**다. 트리를 저장소로 주면:

- 격리가 사라지고 그 뒤부터 본체에 파일을 쓴다 (트리 안에서 트리가 게이트 루트가 되므로 정확히는
  트리를 본체로 삼아 돈다 — 어느 쪽이든 사용자가 고른 격리가 아니다).
- `workspace_id`가 트리 경로에서 유도되어 등록이 사라진다(38.2절과 같은 결함).

그래서 다시 열기는 **저장소 경로 + 같은 브랜치**로 연다. 이 결함은 화면 코드에만 있었고 — 이
환경에서는 tauri 껍데기가 컴파일되지 않으므로 — 컴파일러가 잡아 줄 수 있는 것도 아니었다.

### 38.6 정리는 화면에 있어야 한다

22.6절은 "기본적으로 지우지 않는다"를 정했다. 그 결과 트리는 **쌓인다.** 지우는 길이 CLI에만
있으면 사용자는 쌓이는 것을 모르고, 같은 브랜치로 다시 격리하려 할 때 "이미 체크아웃되어
있습니다"로 막힌다 — 그 이유를 볼 자리가 화면에 없다.

목록은 **남의 트리도 보여주되 가른다**(22.6절 그대로). 목록에서 빼면 "왜 이 브랜치를 못
쓰는가"의 답이 사라지고, 정리 대상에 넣으면 남의 작업을 지운다.

두 가지를 화면이 **미리** 말한다. 누른 뒤에 거절당하는 것은 알린 것이 아니다.

- **더러운 트리를 지우면 무엇이 사라지는가.** 확인 문구가 브랜치 이름만 말하면 사용자는 "빈
  트리를 치운다"로 읽는다.
- **지금 도는 트리는 정리 대상이 아니다.** 지우면 게이트 루트가 사라진 채로 세션이 살아 있다.
  Rust도 막지만(막지 않으면 git이 성공시킬 수도 있다), 막힌 뒤에 알리는 것은 알린 것이 아니다.

### 38.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 두 루트 | Rust 단위 | 격리하면 게이트 루트만 바뀌고 **신원 루트는 그대로다** |
| 알림 셋 | Rust 단위 | 조건 없는 것 하나 + 조건부 둘이 **서로 다른 문장**이 된다 |
| 자리를 정하는 곳 | Rust 단위 | 소스를 훑어 `worktrees` 디렉터리를 **한 곳만** 정한다 — 데스크톱 껍데기까지 본다(여기서 컴파일되지 않으므로) |
| 기록 | Rust 단위 + e2e | 격리 실행은 브랜치와 경로를 `TASK_CONFIG_PINNED`에 남기고, **본체 실행은 `null`이다** |
| 화면 문장 | desktop 단위 | 도는 트리·남의 트리는 정리 대상이 아니다 / 더러운 트리는 버릴 것을 먼저 말한다 / 두 수를 따로 센다 / 격리 줄이 경로를 함께 낸다 |

### 38.8 아직 하지 않은 것

- **기준 커밋 고르기.** 지금은 체크아웃된 곳에서 시작한다(`base = None`). 고르게 하려면 화면이
  "무엇에서 시작하는가"를 말해야 하고, 그건 브랜치 입력 하나로 끝나지 않는다.
- **고아 트리 회수**(22.7절 그대로). 목록에는 보이므로 사람이 지울 수는 있게 됐지만, 앱이
  비정상 종료된 트리를 **자동으로** 찾아 올리지는 않는다.
- **격리 중에 본체를 함께 보는 것.** 지금은 한 번에 하나의 워크스페이스만 열린다. 격리 결과를
  본체와 비교하려면 사용자가 다시 열어야 한다.
- **트리에서 본체로 가져오는 것.** 격리 결과를 본체에 반영하는 길은 지금 git(merge·cherry-pick)
  뿐이다. 우리가 대신 하려면 "무엇을 가져오는가"를 판정해야 하고, 그건 되돌리기(19절)와 같은
  종류의 질문을 지난다.

## 39. 무인 실행의 **시한** — 기다리기를 그만두는 것과 멈추는 것 (M3)

24.7절이 남긴 항목: "무인 실행에 '언제까지'가 없다. `--timeout-secs`는 있지만 그건 하네스의
상한이지 제품의 정책이 아니다."

붙이려고 보니 그 문장은 **절반만 맞았다.** 상한이 없는 것이 아니라, 있는 상한이 **다른 것을
재고 있었다.**

### 39.1 시계도 판정도 Rust가 갖는다

Node가 시한을 지키면 장악당한 Node에서 시한이 사라진다 — 도구 허용목록을 Node가 지키게 두는
것과 같은 종류의 약속이다(원칙 2·26.3절). 그래서 `deadlineMs`는 **sidecar로 보내지 않는다.**
Node가 알아야 할 이유가 없고, 알면 언젠가 Node가 집행자가 된다.

집행은 **새 정지 메커니즘을 만들지 않는다.** 시한이 지나면 우리가 대신 취소를 누른다 — 취소
경로는 이미 세 성질을 만족하도록 만들어져 있고(cancel.rs: idempotent · terminal 이후 무효 ·
취소 이후 실행 금지) 프로세스 트리 종료까지 지난다. 새 경로를 만들면 그 셋을 다시 증명해야 한다.

**기본값을 만들지 않는다.** 예산 상한과 같은 규칙이다 — 코드가 만들어낸 승인은 승인이 아니다.
상한 없이 도는 것은 사용자가 고를 수 있는 선택이고, 화면은 그 선택의 **결과**를 말한다:
"아무도 멈추지 않으므로 끝날 때까지 돕니다."

### 39.2 있던 상한은 **기다리기를 그만두는 시각**이었다

`--timeout-secs`(그리고 데스크톱의 같은 값)는 호스트가 `task.start` 응답을 기다리는 시간이다.
지나면 호스트는 태스크를 FAILED로 적었다. 그런데 **sidecar에게는 아무 말도 하지 않았다.**

데스크톱에서 그 결과는 이렇다: 15분이 지나면 화면은 실패라고 말하는데 태스크는 계속 돈다 —
모델을 부르고, 도구를 요청하고, **파일을 쓴다.** 감독자가 sidecar를 살려 두기 때문이다
(헤드리스는 곧바로 프로세스를 내리므로 증상이 드러나지 않았다).

그래서 이제 적기 **전에** 멈춘다(`abandon_unanswered`). 터미널은 여전히 FAILED다 — 취소가
아니다: 사용자도 시한도 아니고 백엔드가 답하지 않은 것이며, 그건 우리 쪽 고장이다. CANCELLED로
적으면 고장이 정상 종료로 읽힌다.

### 39.3 곁가지: 게이트가 본 것은 터미널이 아니라 **취소 신호**였다

위를 고치면서 드러난 것: 취소 토큰을 세워도 그 다음이 성립하지 않았다. `finish_task`가 터미널을
확정하며 **토큰을 정리하고**(`release_task`), 그 뒤에 온 도구 요청은 `cancels.token()`이 새
토큰을 만들어 **그대로 실행됐다.**

즉 "취소 이후 실행 금지"는 취소된 채로 살아 있는 태스크에만 성립했고, **끝난 태스크에는 아무
규칙도 없었다.** 그래서 형제 규칙을 하나 세웠다:

> 터미널에 도달한 태스크에 대한 **Node의** 도구 요청은 실행하지 않는다.

**Node의 요청에만 건다.** 호스트가 시작하는 도구는 끝난 태스크에 대해 도는 것이 정상이다 —
되돌리기(19절)·PR 올리기(28절)·훅이 그렇고, 그것들은 사용자가 누른 것이다. 가르는 자리는
`handle_request("tool.execute")`이며, 그게 Node의 유일한 도구 입구다.

### 39.4 사람이 붙어 있으면 시계를 걸지 않는다

시한이 필요한 까닭은 **"물을 사람이 없다"**는 것이다(24.1절). 사람이 있으면 취소 버튼이 곧
시한이고, 그 상태에서 시계를 돌리면 **사용자가 답을 쓰는 동안**에도 시간이 간다 — 그건 태스크의
시간이 아니라 사용자의 시간이다.

대기 시간을 빼는 방법도 있지만 그러려면 "무엇이 대기인가"를 판정해야 하고, 무인 실행에는 대기가
없으므로 그 복잡도를 살 이유가 없다. 그래서 화면은 무인 실행이 아닐 때 **적어 둔 시한을 보내지
않고, 그 사실을 말한다** — 침묵하면 사용자는 걸렸다고 믿는다.

CLI는 이 규칙을 강제하지 않는다(`--deadline-secs`는 무인이 아니어도 받는다). 거기서는 사람이
붙어 있어도 승인 대기가 곧 그 사람의 부재이고, 무엇보다 스크립트가 부르는 자리이기 때문이다.
**그래서 시계는 승인 대기 중에도 돈다** — 이 한계는 지금 그대로 남아 있다.

### 39.5 왜 멈췄는가를 뭉개지 않는다

24.2절이 "멈춘 것을 거부라고 부르지 않는다"를 정한 것과 같은 이유로, 정지의 **사유**를 셋으로
나눈다. 셋은 사용자가 다음에 할 일이 서로 다르다.

| 사유 | 무엇이 일어났나 | 사용자가 할 일 |
|---|---|---|
| `사용자 요청` | 취소 버튼을 눌렀다 | — |
| `시한 초과` | 정해 둔 시간이 지났다 | 시한을 올리거나, 왜 오래 걸렸는지 본다 |
| `백엔드 무응답` | sidecar가 답하지 않았다 | 우리 쪽 고장이다 |

그리고 시한에는 이벤트를 하나 더 남긴다(`TASK_DEADLINE_EXCEEDED`: `limitMs`·`elapsedMs`).
사유 문자열만으로는 **상한값을 알 수 없고**, 상한값이 없으면 사용자는 다음에 얼마로 올려야
하는지 모른다.

### 39.6 곁가지: 취소 요청이 화면에 가지 않고 있었다

`record_cancellation_request`는 `append_event`를 거치지 않으므로 sink 릴레이가 빠진다 —
CLAUDE.md에 적혀 있는 함정이고, `cancel_task`가 정확히 거기 빠져 있었다. DB에는 남는데 화면은
모르는 상태였고, **실제로 화면은 그 이벤트로 열려 있던 질문 카드를 닫는다.**

고치면서 payload를 둘로 만들지 않았다: 저장하는 쪽이 만든 payload를 그대로 돌려받아 릴레이한다.
릴레이하는 쪽이 다시 조립하면 `requestedAt`이 기록과 갈리고, 감사 화면과 DB가 다른 시각을 말한다.

### 39.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 판정 규칙 | Rust 단위 | 끝난 태스크가 시한보다 **먼저다** / 남은 시간이 짧으면 그만큼만 잔다 |
| 실제 정지 | Rust 단위 | 시한이 지나면 **취소되고** 상한값이 이벤트에 남으며 화면에도 간다 |
| 반대편 | Rust 단위 | 시한 없는 태스크는 아무도 멈추지 않고, 끝난 태스크는 시한 초과로 기록되지 않는다 |
| 무응답 | Rust 단위 | 적기 전에 멈춘다 — 그 뒤 Node의 요청이 **파일을 쓰지 않는다** |
| 터미널 이후 | Rust 단위 | 살아 있는 태스크의 요청은 **그대로 실행된다**(위 규칙이 전면 차단이 아니다) |
| 릴레이 | Rust 단위 | 취소 요청이 화면에 간다 |
| 실행 전체 | e2e | 60초짜리 명령이 3초 시한에 잘리고, 사유가 **사용자 취소와 다르다** |
| 화면 문장 | desktop 단위 | 비우면 상한 없음을 말한다 / 무인이 아니면 걸지 않고 그 사실을 말한다 / 읽지 못한 입력은 **거부**다 / 1분 미만을 0분으로 뭉개지 않는다 |

### 39.8 아직 하지 않은 것

- **승인 대기 시간을 빼는 것**(39.4절). CLI에서는 시계가 대기 중에도 돈다.
- **횟수 상한**(24.7절의 나머지 절반). 루프마다 상한은 있지만(원칙 5) "이 태스크가 모델을 몇 번
  부를 수 있는가"라는 축은 없다. 예산 상한이 그 역할을 절반 하고 있고, 가격을 모르는 모델에서는
  그 절반도 없다.
- **시한이 다가온다는 예고.** 지금은 지나야 안다. 무인 실행에는 볼 사람이 없으므로 예고의 값어치는
  "끝난 뒤에 읽는 기록"이 얼마나 부족한지를 봐야 정해진다.
- **시한 도달 시 부분 결과를 살리는 것.** 지금은 취소와 같아서 되돌리기 제안으로 간다. 살리려면
  "어디까지가 온전한가"를 판정해야 하고, 그건 19절과 같은 종류의 질문이다.

## 40. Windows 개발자 환경 — 명령마다 붙는 세금을 우리가 낸다 (M3)

product-strategy 12.4절이 Windows 해자의 투자 우선순위를 정해 두었다: **"명령 실행 계층 먼저,
설정 마법사는 나중."** 그 목록의 첫 줄이 "개발자 환경 자동 해석 후 명령 실행(vcvarsall 상당,
MSVC/GNU 도구 충돌 해소)"이고, 이 절이 그것이다.

### 40.1 이 결함은 우리가 직접 겪었다

CLAUDE.md의 함정 기록 두 줄이 그대로 사용자의 것이다.

- `INCLUDE`/`LIB`가 없으면 컴파일은 되는데 **링크에서** 실패한다. 증상은
  `stdarg.h: No such file or directory`이고, 그 문장은 "C 컴파일러가 없다"로 읽힌다 —
  실제로는 있는데 헤더 경로를 모르는 것이다. (`cc-rs`가 자체 vswhere 탐지로 `cl.exe`를
  **찾아내기 때문에** 증상이 "컴파일러 없음"으로 나오지 않는다.)
- Git for Windows의 GNU `link.exe`가 PATH에서 MSVC `link.exe`를 **가린다.** 증상은
  `link: extra operand`이고, rustc가 붙이는 "C++ 빌드 도구를 설치하라"는 힌트는 이 경우
  **오도한다.**

사람이 푸는 방법은 `vcvarsall.bat`을 거쳐 셸을 여는 것이다. 그런데 그건 **셸 하나에만**
적용된다 — 명령마다 프로세스를 새로 띄우는 실행기에게는 12.3②가 말한 "명령마다 붙는 세금"이다.

### 40.2 막지 않는다 — 준비하고, 못 했으면 말한다

가장 그럴듯한 오답은 "MSVC가 없으면 명령을 거부한다"이다. 사전 점검(12.3①)이 이 제품의
차별화라고 적어 두었으니 더 그렇게 보인다.

그런데 **탐지가 틀릴 수 있다.** GNU 툴체인을 쓰는 프로젝트, 링크를 지나지 않는 명령, 우리가
모르는 설치 구조 — 그 경우 막는 것은 **되는 명령을 막는 것**이고, 그건 못 준비한 채 실행하는
것보다 나쁘다. 우리 판정이 사용자의 툴체인을 이기게 두지 않는다.

그래서 준비하지 못하면 **그대로 실행하고 확인한 것을 결과에 남긴다.** 그러면 명령이 실패했을 때
사용자가 읽는 것이 `stdarg.h` 한 줄이 아니라 우리 기록이 된다 — 사전 점검의 값어치는 거기서
나온다.

### 40.3 어떤 명령에 붙이는가 — 넓히지 않는다

준비는 공짜가 아니고(프로세스 하나), **틀리게 넓히면 관계없는 명령의 환경이 조용히 달라진다.**
그래서 MSVC 링커/헤더를 실제로 지나는 것만 넣는다: `cargo`·`rustc`·`cl`·`link`·`lib`·
`nmake`·`msbuild`·`cmake`.

`cargo`는 하위 명령을 가리지 않는다. `check`조차 build script를 컴파일하면 링크를 지나고, 그
실패는 "`cargo check`가 실패했다"로 보인다. 가리려면 하위 명령별 지식을 우리가 들고 있어야
하는데 **그 목록이 틀리는 쪽이 더 나쁘다.**

### 40.4 탐지 순서는 `scripts/_env.bat`과 **같아야 한다**

우리 빌드 스크립트가 이미 네 겹으로 탐지한다(override → vswhere → `VSINSTALLDIR` → 서브트리
검색). 제품이 다른 순서를 쓰면 **우리 환경에서 되는 것이 사용자 환경에서 안 되는** 상태가
된다 — 그 차이는 우리가 가장 늦게 발견하는 종류다.

그 스크립트가 실측으로 배운 것 셋이 그대로 옮겨 왔다.

- **`-latest`를 쓰지 않는다.** 실측 머신에 설치가 둘 있었고 최신(VS 18 Enterprise)에 C++ 도구가
  없었다. 필요한 것은 "가장 새 것"이 아니라 **vcvarsall.bat이 실제로 있는 것**이다.
- **`-requires`도 최종 판정이 아니다.** 새 버전이 컴포넌트 ID를 바꾸면 빗나간다. 워크로드 선언과
  무관하게 받는 질의를 마지막에 두고, **파일 존재를 정본으로** 삼는다.
- **마지막 겹은 목록이 아니라 검색이다.** 드라이브도 버전 디렉터리(`2022`가 아니라 `18`)도
  에디션도 하드코딩 후보와 전부 다를 수 있다.

전부 실패하면 **확인한 것을 전부 낸다.** "설치되어 있지 않은 것으로 보입니다"만 말하면 설치되어
있는 사용자가 할 수 있는 일이 없다. 그리고 두 실패의 **처방이 다르다** — vswhere가 설치를
알려줬는데 vcvarsall이 없으면 워크로드가 빠진 것이고, vswhere 자체가 없으면 우리가 못 찾은 것이다.

### 40.5 원칙 6과의 관계 — 셸을 부르지만 사용자의 명령이 아니다

`run_command`가 셸 문자열을 받지 않는다는 약속은 **사용자의 명령**에 대한 것이다. 여기서
`cmd.exe`를 부르는 것은 우리가 고정한 배치 파일이고 인자는 전부 우리가 만든다 — 모델도
사용자도 그 문자열에 한 글자도 기여하지 않는다. 사용자의 명령은 여전히 argv 배열 그대로,
셸 없이 실행된다.

**환경은 argv가 아니다.** 승인 화면이 보여준 argv는 그대로인데 환경은 달라지므로, 무엇을
넣었는지(또는 왜 못 넣었는지) 결과에 남긴다 — 훅의 `injectedEnv`와 같은 규율이다(33.5절).

### 40.6 값을 통째로 덤프하지 않는다

`set`은 환경 **전체**를 찍는다. 우리 프로세스는 자격증명을 다룰 수 있으므로 그 출력에 키가
섞이고, 그러면 키가 버퍼에 들어온다 — `scripts/msvc-env.bat`이 같은 이유로 전체 덤프를 하지
않는다. 그래서 **필요한 이름만 물어보고**(`set NAME`), 파싱도 목록 밖은 버린다. 두 겹인 이유는
한 겹이 뚫렸을 때 다른 겹이 남기 위해서다.

`PATH`는 넘겨준다. vcvarsall이 만드는 PATH가 **우리 PATH 앞에 MSVC를 붙인 것**이어야 GNU
`link.exe` 가림이 풀리기 때문이다.

### 40.7 0으로 끝나도 준비되지 않았을 수 있다

vcvarsall이 성공 코드를 내고도 환경을 잡지 못하는 일이 있다(설치 손상, 아키텍처 불일치).
`scripts/_env.bat`이 `INCLUDE`의 존재로 그걸 거른다. 여기서도 같다 — **종료 코드가 아니라
`INCLUDE`가 판정 기준이다.** 거르지 않으면 나중에 `stdarg.h` 없음이라는 **원인과 먼 증상**으로만
드러난다.

그래서 결말이 셋이다: `prepared` / `notFound`(설치를 못 찾음) / `broken`(찾았는데 환경이 안 잡힘).
사용자가 다음에 할 일이 셋 다 다르다.

### 40.8 한 번만 판정한다 — 그 대가도 말한다

준비는 프로세스를 하나 띄우는 일이다. 명령마다 하면 **그것이 새 세금이 된다** — 이 기능이
없애려는 바로 그것이다. 그래서 성공도 실패도 프로세스 수명 동안 캐시한다.

대가는 **VS를 설치한 뒤 앱을 다시 시작해야 한다는 것**이고, 그 사실을 실패 문장이 말한다.

### 40.9 곁가지: 잘라내는 조건과 읽어야 하는 조건이 겹쳐 있었다

큰 출력은 이벤트에서 잘린다(`summarize_output`). 그 코드에는 이미 "잘라도 `exitCode`만은
남긴다"는 예외가 있었다 — 없으면 목록 전체가 "성공한 단계들"로 읽히기 때문이다.

개발자 환경 기록도 정확히 같은 처지다. **이 기록이 필요한 순간은 명령이 실패한 때이고, 실패한
빌드는 출력이 길다.** 즉 잘라내는 조건과 읽어야 하는 조건이 겹친다. 예외에 한 줄을 더했다.

### 40.10 화면에서는 **조용한 것이 기본이다**

이벤트 로그의 기본 모드는 주요 이벤트만 보여준다. `TOOL_COMPLETED`를 전부 보이면 목록이
`read_file`로 덮이고, 정작 읽어야 할 한 줄이 그 안에 묻힌다. 그렇다고 전부 감추면 준비 실패가
**개발자 모드에서만** 보이는데, 그건 이 기능이 도우려는 사용자가 켜지 않는 모드다.

그래서 필터에 예외를 하나 둔다: **개발자 환경을 준비하지 못한 도구 실행은 기본 모드에서도
보인다.** 정상적으로 준비된 실행은 그대로 조용하다.

### 40.11 검증한 것 — 그리고 여기서 확인되지 **않는** 것

판정은 전부 Linux에서 검증된다(바깥 세계를 인자로 받는다 — `tools/program.rs`와 같은 모양).
**실제 동작은 Windows에서만 확인된다.**

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 대상 명령 | Rust 단위 | `cargo`·`msbuild`는 붙고 `npm`·`git`·`node`는 안 붙는다 / 경로·확장자·대소문자를 가리지 않는다 |
| 플랫폼 | Rust 단위 | Windows가 아니면 아무것도 붙지 않는다 |
| 탐지 순서 | Rust 단위 | override가 이긴다 / 깨진 override는 넘어가고 그 사실이 남는다 / **최신 설치가 아니라 쓸 수 있는 설치**를 고른다 / 서브트리 검색이 마지막 겹이다 |
| 실패 보고 | Rust 단위 | 확인한 것을 전부 남긴다 / 두 실패의 **처방이 다르다** |
| 환경 읽기 | Rust 단위 | 이름을 하나씩 묻는다(전체 덤프가 아니다) / 목록 밖은 버린다 / 값 안의 `=`에서 자르지 않는다 |
| 준비 판정 | Rust 단위 | `INCLUDE` 없이는 `broken`이고, 그때 변수를 넣지 않는다 |
| 배선 | Rust 단위 | 사용자 명령 실행 경로가 실제로 준비를 부른다(소스에서 유도) |
| 잘림 | Rust 단위 | 출력이 잘려도 개발자 환경 기록은 남는다 |
| 화면 | desktop 단위 | 필요 없던 명령에는 아무 말도 하지 않는다 / 실패는 처방과 "그대로 실행했다"를 함께 말한다 / 성공은 조용하다 |
| **실제 실행** | **landing.rs `developerEnv`** | 실제 설치에서의 탐지, `cargo build` 링크 성공, `link.exe` 가림 해소, 준비 실패가 명령을 막지 않는 것 — **넷 다 `NeedsHuman`이다** |

마지막 줄이 이 절의 정직한 한계다. `msvc.rs`는 `cfg(windows)`도 `Platform::Windows`도 쓰지
않으므로(그래야 Linux에서 검증된다) **Windows 전용 코드를 찾는 그물에 걸리지 않는다** —
그래서 착지 묶음을 손으로 추가했고, 그 사실을 그 함수의 주석에 적어 두었다.

### 40.12 아직 하지 않은 것

- **아키텍처 선택.** `x64` 고정이다. 고르게 하려면 "무엇을 빌드하는가"를 알아야 하고, 그건 명령
  문자열에서 유도할 수 없다.
- **PowerShell 명령 의미 분석**(12.4절 우선순위의 둘째 줄). 아직 손대지 않았다.
- **설정 마법사**(12.4절이 "나중"이라고 정한 것). 지금은 실패 문장이 `TOMVERSE_VCVARSALL`을
  안내하는 데서 끝난다.
- **툴체인 종류 판정.** GNU 툴체인(`*-pc-windows-gnu`)을 쓰는 프로젝트에는 MSVC 환경이 필요
  없는데, 지금은 그 구별 없이 준비한다(붙여도 해롭지 않으므로 막지 않는 쪽과 같은 판단이다).
- **`.NET`/`dotnet`.** 자체 SDK 해석을 하므로 목록에 넣지 않았는데, 실측으로 확인하지 않았다.

## 41. 모델의 셸 습관 — 그리고 거부에도 두 종류가 있다 (M3)

product-strategy 12.4절 우선순위의 둘째 줄("PowerShell 명령 의미 분석")을 향해 한 걸음. 다만
실제로 손댄 것은 셸 방언 해석이 아니라 **그 앞에 있는 것**이다 — 12.3③이 적어둔
"모델의 prior가 Unix로 기울어 있다".

### 41.1 모델은 두 가지를 자연스럽게 한다

- `ls`·`cat`·`grep`·`rm`을 요청한다. Windows에는 대개 없다.
- `&&`로 명령을 잇는다. 우리는 **셸을 쓰지 않으므로**(원칙 6) 그 토큰은 인자로 전달된다.

둘 다 지금은 **원인과 먼 실패**가 됐다. 앞은 `program not found`이고, 뒤는 프로그램이 이상한
인자를 받아 내는 알 수 없는 오류다.

### 41.2 우리 도구 집합이 이미 답을 갖고 있다

권하는 대체는 전부 **닫힌 도구 집합 안**이다: `ls`→`list_files`, `cat`→`read_file`,
`grep`→`search_text`, `rm`→`delete_file`, `sed`→`apply_patch`, `diff`→`git_diff`.

그래서 이 교정은 Windows 교정이면서 동시에 **보안·감사 이득**이다. 셸로 파일을 지우는 것보다
`delete_file`이 낫다 — 게이트가 경로를 알고, 승인 화면이 무엇이 지워지는지 보여주며, 롤백이 그
변경을 안다.

목록의 판정 기준을 손으로 적지 않는다. 오른쪽은 전부 `ToolName`에 실재해야 하고, 테스트가
그것을 `ToolName`에서 유도해 대조한다 — **없는 도구를 권하면 모델이 그것을 요청하고 게이트가
거부한다.** 도우려던 것이 새 실패를 만든다.

그리고 `mv`·`cp`·`chmod`·`curl`처럼 대응이 없는 것에는 **아무것도 지어내지 않는다.** 그 경우
모델이 받는 것은 "PATH에서 못 찾았다"라는 사실 그대로이고, 그게 정확하다.

### 41.3 거짓 양성이 이 검사에서 가장 비싼 실패다

셸 연산자 검사는 **`&&`와 `||`만** 본다. 다른 메타문자는 정당한 인자일 수 있다:

- `;`는 `find . -exec cmd {} \;`에서 **인자로** 온다.
- `|`는 `awk -F '|'`·`cut -d '|'`에서 구분자 값이다.
- `>`를 값으로 받는 CLI가 있다.

되는 명령을 막으면 사용자는 우리가 고장 났다고 읽는다. `&&`/`||`가 독립 인자로 오는 정당한
경우는 찾지 못했지만, **못 찾았다는 것이 없다는 증거는 아니므로** 판정을 이 둘로 좁히고
나머지는 보지 않는다.

### 41.4 곁가지: "정책이 거부했습니다"가 사용자를 엉뚱한 곳으로 보내고 있었다

체이닝 거부를 붙이고 보니 최종 보고가 **"도구 실행이 거부되었습니다 … policy_denied"** 였다.
그 문장을 읽은 사용자는 정책 설정을 열고 고칠 곳을 찾는다 — 그리고 아무것도 찾지 못한다.
고칠 것은 정책이 아니라 **모델이 요청한 모양**이기 때문이다.

두 사실을 갈랐다. 24.2절이 "멈춘 것을 거부라고 부르지 않는다"를 정한 것과 같은 이유다.

| 거부 | 무엇을 말하는가 | 사용자가 갈 곳 |
|---|---|---|
| `policy_denied` | **그건 하면 안 된다** (워크스페이스 밖 쓰기, `git push --force`) | 정책 설정 |
| `request_malformed` | **그렇게 요청하면 안 된다** (셸 문자열, argv에 든 `&&`) | 없다 — 모델이 다시 그려야 한다 |

판정은 **Rust가 준다**(`PolicyDecision.redraftable`). 규칙 이름으로 TS가 다시 판정하면 두 곳이
갈린다 — 24.3절이 실제로 겪은 그 결함이다. 그리고 `Outcome`마다 필드를 채우게 두지 않고 한
곳에서 유도한다: 새 거부를 만든 사람이 정하지 않고 지나갈 수 있기 때문이다.

**목록을 좁게 둔다.** 경계 위반은 여기 넣지 않는다. 다시 그리면 지나갈 수 있는 것은 맞지만,
그 초대는 **게이트를 두드려 보라는 말**이 된다.

### 41.5 우리는 사용자의 환경을 이기지 않는다

`ls`가 PATH에 실제로 있으면(Git for Windows가 깔린 머신이 그렇다) 그대로 실행된다. 안내는
**해석이 실패한 뒤에만** 붙는다 — 40.2절이 개발자 환경 준비 실패에도 명령을 막지 않는 것과 같은
판단이고, 이 저장소에서 세 번째로 같은 모양이다(22.6절의 "판정할 수 없으면 지우지 않는다"도
같은 가족이다).

### 41.6 이 문장을 지금 **누가 읽는가** — 정직하게

모듈을 쓰면서 "이 메시지의 주 독자는 모델"이라고 적었다가 고쳤다. 코드를 따라가 보니 **이번
태스크의 모델은 이 문장을 보지 못한다.**

- 게이트 거부는 태스크를 **끝낸다**(`executePlan`의 `denied` 분기). 거부된 요청을 다시 보내는
  것이 승인 피로도만 유발한다는 판단이었고, 승인 거부에 대해서는 옳다.
- 도구 오류는 **같은 요청을 기계적으로 재시도**하고(`toolRetries`) 소진되면 끝낸다. 모델이
  다시 그리는 경로가 아니다.

그래서 지금 이 문장이 하는 일은 둘이다: ① 최종 보고에 실려 **사용자가 어디를 볼지** 알려주고,
② 기록에 남아 다음에 우리가 고칠 근거가 된다. 그 이상을 주장하지 않는다.

**모델이 다시 그리게 하는 것**은 아래 미해결에 남긴다. 작아 보이지만 작지 않다 — 거부가 모델
호출로 이어지는 새 루프이고, 상한과 phase 전이를 정해야 하며(원칙 5), "거부는 태스크를
끝낸다"는 지금의 규칙을 바꾸는 일이다.

### 41.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 대체 목록 | Rust 단위 | 권하는 도구가 **실재한다**(`ToolName`에서 유도) / 없는 대안을 지어내지 않는다 |
| 안내 문장 | Rust 단위 | 경로·확장자·대소문자를 벗겨 본다 / "무엇을 하라"까지 말한다 |
| 거짓 양성 | Rust 단위 + 게이트 | `find -exec … ;`·`awk -F '|'`·커밋 메시지 속 `&&`를 오인하지 않는다 |
| 게이트 | Rust 단위 | `&&`가 든 요청이 거부되고 규칙 이름과 처방이 남는다 / 정책으로 열 수 없다 |
| 두 거부 | Rust 단위 | 모양 문제는 `redraftable`, 경계 위반은 아니다 / 거부가 아닌 결정에는 붙지 않는다 |
| 환경 존중 | Rust 단위 | `ls`가 PATH에 있으면 그대로 실행된다 |
| 보고 | sidecar 단위 | `request_malformed`로 갈려 나오고 요약이 어디를 볼지 말한다 |

### 41.8 아직 하지 않은 것

- ~~**모델이 다시 그리게 하는 것**~~ → 42절. 새 루프를 만들지 않았다 — 이미 있던 되돌리기
  자리(`checkCriteriaBeforeExecuting`) 옆에 한 칸 더 놓고 그 상한을 함께 쓴다. 그리고 실행
  **중간**이 아니라 **앞**에서 잡는다: 중간에 잡으면 앞의 요청이 이미 적용된 뒤다(42.1절).
- ~~**PowerShell cmdlet**~~ → 43.3절. 그런데 41절의 안내가 **닿지 않는 자리에 있었다** —
  게이트가 먼저 거부하고, 그 문장이 틀린 처방을 하고 있었다(43.1절). 파이프라인의 의미
  분석은 아직 하지 않았다(43.8절).
- **`;`·`|`까지 판정하는 것**(41.3절). 정당한 인자와 구별하려면 인자의 **의미**를 알아야 하고,
  그건 프로그램별 지식이다.
- **`mv`·`cp`.** 대응 도구가 없다. 만들면 게이트가 아는 이동/복사가 생기지만, 두 경로를 한
  요청에 담는 첫 도구가 된다(지금 도구는 전부 경로가 하나다).

## 42. 계획을 실행하기 **전에** 게이트에 태워 본다 (M3)

41.8절이 "모델이 다시 그리게 하는 것"을 남겼다. 그걸 하려고 실행 경로를 다시 읽다가 **더 급한
것**을 찾았다.

### 42.1 반쯤 적용된 워크스페이스가 남고 있었다

`executePlan`은 계획의 요청을 순서대로 실행하고, 거부를 만나면 그 자리에서 태스크를 끝낸다.
그런데 **앞의 요청들은 이미 적용됐다.** 세 파일짜리 patch에서 세 번째가 막히면 사용자의
워크스페이스는 두 파일만 바뀐 상태로 남는다 — 그 상태는 모델이 만들려던 것도, 사용자가 승인한
것도 아니다.

도달 가능한 경로가 여럿이다: 스킬이 좁힌 도구 집합에 없는 도구(26.3절), 디렉터리에 대한
`delete_file`, 심볼릭 링크로 경계를 벗어나는 경로.

되돌리기가 있지만(19절), **애초에 만들지 않는 편이 낫다.**

### 42.2 미리 태워 보는 자리는 이미 있었다

`policy.evaluate`는 "이 요청이 어떻게 분류되나"를 실행 없이 묻는 IPC이고, **Node에서 아무도
부르지 않고 있었다.** 31절이 MCP에서 겪은 것과 같은 모양이다 — 문은 있는데 걸어 들어갈 길이
없었다.

그리고 되돌리는 자리도 이미 있었다. `checkCriteriaBeforeExecuting`이 실행 전에 계획을 보고
`redraft`를 돌려주는 구조를 만들어 두었으므로, 게이트 프리플라이트는 그 옆에 한 칸 더 놓는
일이다. 상한도 그 자리의 것(`reviseRounds`)을 그대로 쓴다 — **한 루프는 한 counter가
다스린다**는 그 절의 판단이 여기에도 그대로 걸린다.

### 42.3 게이트를 대체하지 않는다

실행 시점에 게이트는 **그대로 다시 돈다.** 프리플라이트가 받은 답은 미리 보기이며, 그 사이에
파일이 생기거나 사라지면 두 판정이 달라질 수 있다. 대체하려고 들면 "미리 본 것"이 실행 근거가
되고, 그건 게이트를 Node가 대신하는 것이다(원칙 2).

### 42.4 예측할 수 없는 것 — 사용자의 거부

승인이 필요한 요청은 `require_user_approval`로 나올 뿐이고, **사용자가 실제로 무엇을 답할지는
물어봐야 안다.** 그래서 이 검사는 반쯤 적용된 상태를 **줄이지 없애지는 못한다.**

없애려면 계획 전체의 승인을 한 번에 받아야 하고, 그건 항목별 승인(ui-wireframes 4절)과 같은
자리에서 만나는 별개의 결정이다. 이 한계를 적어 두는 이유는, 적지 않으면 "프리플라이트가 있으니
반쯤 적용될 일은 없다"로 읽히기 때문이다.

### 42.5 되돌리는 것과 멈추는 것을 가른다

41.4절이 만든 구별이 여기서 처음 쓰인다.

- **전부 `redraftable`이면** 모델에게 되돌린다. 게이트가 "그렇게 요청하면 안 된다"고 말한
  것은 모델이 고칠 수 있다.
- **하나라도 진짜 거부면** 되돌리지 않는다. 그 초대는 **게이트를 두드려 보라는 말**이 되고,
  모델은 같은 벽에 다시 부딪힌다. 아무것도 적용하지 않고 멈추며, 무엇이 막았는지를 보고한다.

상한을 넘기면 **진행하지 않고 멈춘다.** 기준 충돌은 상한을 넘겨도 그대로 진행했는데(그건
문자열 대조 기반의 좁은 규칙이라 틀릴 수 있어서), 이건 게이트의 확정 판정이라 그대로 실행하면
**반드시** 거부된다 — 그러면 반쯤 적용된 상태가 남는다.

### 42.6 되돌릴 때 **왜인지를 함께 준다**

게이트 사유는 `criteriaFeedback`과 **다른 문단**으로 프롬프트에 간다. 저쪽은 "사용자가 정한
것과 어긋난다"이고 이건 "우리가 받지 않는 모양이다" — 모델이 고쳐야 할 것이 다르다. 그리고 두
문단 모두 **아직 아무것도 적용되지 않았다**는 사실을 먼저 말한다: FIX_LOOP 문구처럼 읽히면
모델이 없는 변경을 되돌리려 한다.

이 문단이 실제로 실리는지는 **따로 검사한다.** 프롬프트에서 지워 보니 오케스트레이터 검사가
전부 통과했다 — 되돌리기는 돌지만 모델은 왜인지 모르는, 눈을 가린 루프가 된다.

그리고 새 문단은 전송 분류를 지난다(7.2절). 우리 문장이지만 게이트 사유에 **경로가 들어갈 수
있어** 지시문으로 접지 않고 `UNREPORTED_SECTIONS`에 넣었다 — 검사가 그것을 강제한다.

### 42.7 검증한 것

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 아무것도 적용하지 않는다 | sidecar 단위 | 거부될 계획에서 `apply_patch`가 **한 번도 실행되지 않는다** — 그리고 검사는 실제로 돌았다 |
| 되돌리기 | sidecar 단위 | 모양 문제면 다시 그리고, 다시 그린 계획이 적용된다 |
| 되돌리지 않는 경우 | sidecar 단위 | 진짜 거부가 섞여 있으면 한 번만 보고 멈춘다 |
| 상한 | sidecar 단위 | 고쳐지지 않으면 상한에서 멈춘다(시간 상한을 명시했다 — 상한이 깨지면 매달리기 때문에) |
| 조용한 경우 | sidecar 단위 | 거부가 없으면 그대로 실행되고, **검사한 사실은 남는다** |
| 프롬프트 | sidecar 단위 | 사유가 실린다 / 없으면 문단도 없다 / 기준 충돌과 다른 문단이다 |
| 전송 분류 | sidecar 단위 | 새 섹션이 분류되지 않으면 실패한다(기존 검사가 잡았다) |

### 42.8 아직 하지 않은 것

- **사용자 거부에서의 부분 적용**(42.4절). 계획 전체를 한 번에 승인받는 것은 별개의 결정이다.
- **되돌린 계획이 나아졌는지 세는 것.** 기준 충돌은 결말을 집계하는데(`CRITERIA_CONFLICT_RESOLVED`)
  게이트 되돌리기는 아직 그런 짝이 없다. "되돌린 것이 쓸모 있었는가"는 실사용을 봐야 답할 수 있다.
- **프리플라이트 비용.** 계획의 요청 수만큼 IPC 왕복이 는다. 로컬이고 읽기 전용이라 지금은
  재지 않았는데, 계획이 수십 개가 되는 태스크에서 다시 볼 일이다.
- **커밋 계획**(`buildCommitPlan`)은 프리플라이트를 지나지 않는다. 그쪽은 검증 통과 뒤에 돌고
  거부되어도 파일이 바뀌지 않으므로(add/commit/rev-parse) 반쯤 적용될 것이 없다.

## 43. 거부가 틀린 처방을 하고 있었다 (M3)

41절이 `ls`·`grep`·`rm`에 대체 도구를 안내하는 코드를 실행 경로(`tools/program.rs`)에 두었다.
그런데 그 자리에 **닿지 않는다.**

### 43.1 게이트가 먼저 걸린다

`ls`는 기본 allowlist에 없다. 그래서 해석기에 닿기 전에 게이트의 `no_rule_matched_default_deny`가
먼저 거부하고, 그 문장은 이렇게 말한다:

> `"ls"`에 매치되는 allowlist 규칙이 없음 — 분류 불가한 명령은 기본 거부.
> **필요하면 워크스페이스 정책에 규칙을 추가할 것**

**그건 틀린 처방이다.** 사용자가 `ls`를 allowlist에 넣을 일이 아니라 모델이 `list_files`를 쓸
일이다. 41절의 안내는 allowlist에 **있는데 설치되지 않은** 프로그램(`npm`이 없는 머신)에만
닿고 있었다 — 즉 가장 흔한 경우를 놓치고 있었다.

### 43.2 두 거부를 가른다

`NoMatch`를 하나로 두면 이 구별을 담을 수 없다(판정이 규칙 이름에서 유도되기 때문이다 —
41.4절). 그래서 이름을 나눴다.

| 규칙 | 언제 | 처방 | 다시 그리면 지나가는가 |
|---|---|---|---|
| `no_rule_matched_but_a_tool_does_it` | 우리가 **대체 도구를 아는** 명령 | 그 도구 이름 | **예** |
| `no_rule_matched_default_deny` | 그냥 모르는 프로그램 | 정책에 규칙 추가 | 아니오 |

두 번째를 되돌리지 않는 이유: 다시 그려도 지나가지 않는다. 사용자가 규칙을 추가해야 하는
일이고, 모델에게 되돌리는 것은 같은 벽에 다시 부딪히게 하는 것이다(41.4절).

### 43.3 PowerShell cmdlet은 **추가할 수 있는 실행 파일도 아니다**

12.4절 우선순위의 둘째 줄("PowerShell 명령 의미 분석")이 여기서 한 걸음 나간다.

`Get-ChildItem`·`Remove-Item`·`Select-String`은 실행 파일이 아니라 `powershell.exe` **안에 사는
이름**이다. PATH에 없으므로 위와 같은 거부에 걸리는데, 그때의 "정책에 규칙을 추가하라"는
Unix 명령보다 더 틀린 말이다 — 추가할 대상 자체가 없다.

그래서 cmdlet도 같은 표에 넣었다. `Get-ChildItem`→`list_files`, `Get-Content`→`read_file`,
`Select-String`→`search_text`, `Remove-Item`→`delete_file`, `New-Item`/`Set-Content`→`create_file`.
`Copy-Item`처럼 **대응이 없는 것은 넣지 않는다**(41.2절 그대로).

### 43.4 셸을 여는 요청 — 거부는 그대로, 처방만 붙는다

게이트는 `cmd`·`powershell`·`bash`를 거부한다. argv 약속을 무의미하게 만드는 경로이기
때문이고(원칙 6), **그 판단은 바뀌지 않았다.** 바뀐 것은 그 거부가 이제 무엇을 하라고
말한다는 것뿐이다.

그리고 이 거부는 **다시 그리면 지나간다.** 답이 언제나 같기 때문이다 — 셸 말고 도구를 쓰라.
경계 위반과 달리 이 초대는 게이트를 두드려 보라는 말이 아니다.

**셸이 아닌 deny 규칙에는 붙지 않는다.** `sudo`에 "도구를 쓰세요"는 거짓말이고, 다시 그리라고
초대해서도 안 된다.

### 43.5 명령 문자열의 **첫 토큰만** 본다

`-Command`/`-c`/`/c` 다음 인자의 첫 낱말이 우리가 아는 것이면 그 도구를 이름으로 말한다.
파이프라인도 인용도 해석하지 않는다.

깊게 보면 **틀린 처방이 나온다**: `bash -c "npm run build 2>&1 | grep error"`에서 `grep`을
집어 "`search_text`를 쓰세요"라고 말하면, 하려던 일(빌드)과 아무 상관 없는 문장이 된다.
알아보지 못하면 "셸 말고 도구를 쓰라"까지만 말한다 — 그건 언제나 참이다.

### 43.6 처방 목록과 거부 목록이 갈리지 않게

처방을 준비한 셸 목록(`SHELL_LAUNCHERS`)과 게이트가 실제로 거부하는 것이 갈리면 **처방 없는
거부가 조용히 생긴다.** 판정 기준을 손으로 적지 않고 **기본 정책에 물어본다** — 목록의 모든
항목이 실제로 `Denied`여야 한다.

### 43.7 검증한 것 — 그리고 프로브가 잡아낸 약점

| 조각 | 어디서 | 무엇을 |
|---|---|---|
| 두 거부 | Rust 단위 | 아는 명령은 도구 이름을, 모르는 프로그램은 정책 안내를 받는다 / 앞만 다시 그린다 |
| 셸 실행기 | Rust 단위 | 거부는 그대로, 처방이 붙고 다시 그릴 수 있다 |
| 셸이 아닌 deny | Rust 단위 | `sudo`에는 붙지 않고 초대하지도 않는다 |
| 첫 토큰 | Rust 단위 | 뒤쪽 토큰이 처방을 가로채지 않는다 |
| 목록 일치 | Rust 단위 | 처방을 준비한 셸은 **실제로 거부된다**(기본 정책에서 유도) |

프로브가 두 번 약점을 찾았다.

- `sudo rm -rf /`로 쓴 검사는 **deny 규칙에 닿지도 않았다.** 인자의 경로가 워크스페이스를
  벗어나 그 검사가 먼저 걸렸고, 그래서 "모든 deny를 다시 그리게 한다"는 결함을 놓쳤다.
  규칙 이름을 함께 확인하도록 고쳤다 — 어느 경로를 검사했는지 모르는 검사는 그 경로를
  검사하지 않은 것이다.
- "첫 토큰만 본다"는 규칙에 **검사가 없었다.** 모든 토큰을 훑도록 바꿔도 아무것도 실패하지
  않았다. 위의 `grep` 사례를 검사로 만들었다.

### 43.8 아직 하지 않은 것

- **파이프라인의 의미 분석.** 첫 토큰 이상은 보지 않는다. 보려면 셸 문법을 우리가 해석해야
  하고, 그 해석이 틀리면 처방도 틀린다.
- **`Copy-Item`·`Move-Item`·`mv`·`cp`.** 대응 도구가 없다(41.8절 그대로).
- **cmdlet 별칭 전부.** `ls`/`dir`이 PowerShell에서 `Get-ChildItem`의 별칭인 것처럼 별칭이
  많은데, 흔한 것 몇 개만 넣었다. 전부 넣으려면 PowerShell의 별칭 표를 우리가 들고 있어야 한다.
- **거부가 실제로 모델을 고치는지.** 42절이 되돌리는 길을 냈지만, 되돌린 계획이 나아졌는지는
  집계하지 않는다(42.8절 그대로).
