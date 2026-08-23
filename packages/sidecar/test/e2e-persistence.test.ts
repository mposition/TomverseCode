import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepo, FIX_PATCH, type FixtureRepo } from "./helpers/fixtureRepo.js";
import { checkArtifacts, hostBinaryPath, sidecarEntryPath } from "@tomverse/toolchain";

/**
 * M0.1 end-to-end 시나리오 — **영속화와 실제 취소**를 실제 구성요소로 검증한다.
 *
 * 여기서 진짜인 것: 실제 `tomverse-host` 프로세스, 실제 SQLite 파일, 실제 자식 프로세스,
 * 실제 SIGKILL, 실제 파일 시스템. 가짜인 것은 LLM 응답 하나뿐이다.
 *
 * 시나리오:
 *  A. 오래 도는 명령 실행 중 취소 → 프로세스 트리가 죽고 CANCELLED, terminal 이벤트는 1개
 *  B. 파일 변경 후 비정상 종료(SIGKILL) → 재시작 시 INTERRUPTED → 롤백으로 파일 복원
 *  C. 정상 완료 → DB를 다시 열어도 상태·이벤트·변경·검증 기록이 순서대로 남아 있다
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// Windows에서는 `tomverse-host.exe`다. 경로 결정은 공용 helper 한 곳에만 있다.
const HOST_BIN = hostBinaryPath(REPO_ROOT, process.platform);
const SIDECAR_ENTRY = sidecarEntryPath(REPO_ROOT);

/** 산출물이 없으면 조용히 통과시키지 않는다 — "건너뜀"이 "통과"로 보이면 안 된다. */
function requireArtifacts(): void {
  const artifacts = checkArtifacts(REPO_ROOT, process.platform);
  assert.ok(artifacts.ok, artifacts.detail);
}

function hostEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TOMVERSE_FAKE_SCRIPT: JSON.stringify({ defaultPatch: FIX_PATCH }),
    TOMVERSE_EXECUTOR_MODEL: "fake-executor",
    TOMVERSE_REVIEWER_MODEL: "fake-reviewer",
    // 실제 공급자가 후보로 끼지 않도록. 테스트가 우연히 네트워크를 타면 안 된다.
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ...extra,
  };
}

interface Ctx {
  repo: FixtureRepo;
  stateDir: string;
  db: string;
  artifacts: string;
}

function withCtx(
  options: { slowTest?: boolean; gitRepo?: boolean },
  fn: (ctx: Ctx) => void | Promise<void>
): Promise<void> {
  const repo = createFixtureRepo({ slowTest: options.slowTest, gitRepo: options.gitRepo });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-m01-"));
  const ctx: Ctx = {
    repo,
    stateDir,
    db: path.join(stateDir, "state.db"),
    artifacts: path.join(stateDir, "artifacts"),
  };
  return Promise.resolve(fn(ctx)).finally(() => {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  });
}

function runArgs(ctx: Ctx, extra: string[]): string[] {
  return [
    "run",
    "--workspace",
    ctx.repo.root,
    "--message",
    "paginate.js 의 페이지 계산이 한 칸 밀려 있습니다. 고쳐주세요.",
    "--mode",
    "fast",
    "--approve",
    "auto",
    "--db",
    ctx.db,
    "--artifacts",
    ctx.artifacts,
    "--sidecar",
    SIDECAR_ENTRY,
    ...extra,
  ];
}

/** DB만 읽는 하위 명령. 호스트를 **새 프로세스로** 띄우므로 "재시작 후에도 남아 있는가"를 검증한다. */
function hostQuery(ctx: Ctx, args: string[]): Record<string, unknown> {
  const result = spawnSync(HOST_BIN, args, { encoding: "utf8", env: hostEnv() });
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  assert.ok(line, `출력이 없습니다 (${args[0]}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

/// export만 **stdout 전체**를 파싱한다. 다른 하위 명령은 한 줄 JSON이라 마지막 줄만 보면
/// 되지만, export는 사람이 읽고 diff하라고 pretty로 나온다 — 마지막 줄만 떼면 `}` 하나가 된다.
/// 그래서 이 헬퍼가 "여러 줄이어야 한다"까지 확인한다: 한 줄로 바뀌면 여기서 걸린다.
function hostExport(ctx: Ctx, args: string[]): Record<string, unknown> {
  const result = spawnSync(HOST_BIN, args, { encoding: "utf8", env: hostEnv() });
  const text = (result.stdout ?? "").trim();
  assert.ok(text, `출력이 없습니다 (export):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(text.includes("\n"), "export가 한 줄로 나왔습니다 — 파일로 저장해 읽는 용도가 아니게 됩니다");
  return JSON.parse(text) as Record<string, unknown>;
}

function isAlive(pid: number): boolean {
  try {
    // 시그널 0은 아무것도 보내지 않고 존재 여부만 확인한다.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- 시나리오 A: 실행 중 취소 ----

test("[시나리오 A] 오래 도는 명령 실행 중 취소하면 프로세스 트리가 죽고 CANCELLED로 끝난다", async () => {
  requireArtifacts();
  await withCtx({ slowTest: true }, (ctx) => {
    const started = Date.now();
    const result = spawnSync(
      HOST_BIN,
      runArgs(ctx, ["--timeout-secs", "120", "--cancel-after-ms", "2500", "--verbose"]),
      { encoding: "utf8", timeout: 150_000, env: hostEnv() }
    );
    const elapsedMs = Date.now() - started;

    const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    assert.ok(line, `결과 JSON이 없습니다:\n${result.stdout}\n${result.stderr}`);
    const run = JSON.parse(line) as { final: { status: string }; taskId: string; eventTypes: string[] };

    // 1) 취소로 끝났다 — 실패나 타임아웃이 아니다.
    assert.equal(run.final.status, "cancelled", `상태: ${JSON.stringify(run.final)}\n${result.stderr}`);

    // 2) 60초짜리 명령이 실제로 잘렸다. 끝까지 돌았다면 이 시간에 끝날 수 없다.
    assert.ok(elapsedMs < 45_000, `취소가 명령을 끊지 못했습니다 (${elapsedMs}ms 소요)`);

    // 3) 손자 프로세스(npm이 띄운 node)가 실제로 죽었다.
    //    직접 자식만 죽였다면 이 PID가 살아 있다 — proctree.rs가 존재하는 이유.
    const pidFile = path.join(ctx.repo.root, "slow-test.pid");
    assert.ok(existsSync(pidFile), "느린 테스트가 시작되지 않았습니다 — 취소 대상이 없어 시나리오가 성립하지 않습니다");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `PID를 읽을 수 없습니다: ${pid}`);
    assert.ok(!isAlive(pid), `취소 후에도 자식 프로세스 ${pid}가 살아 있습니다`);

    // 4) terminal 이벤트는 정확히 하나다 (완료/취소 경쟁에서 둘 다 기록되면 안 된다).
    const detail = hostQuery(ctx, [
      "show",
      "--workspace",
      ctx.repo.root,
      "--task",
      run.taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);
    const types = detail.eventTypes as string[];
    const terminals = types.filter((t) =>
      ["TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED", "TASK_REJECTED", "TASK_INTERRUPTED"].includes(t)
    );
    assert.deepEqual(terminals, ["TASK_CANCELLED"], `terminal 이벤트가 하나가 아닙니다: ${terminals.join(", ")}`);

    // 5) 취소 요청이 이벤트로 남았고, 요청이 terminal보다 먼저다.
    assert.ok(types.includes("CANCELLATION_REQUESTED"), `취소 요청 이벤트가 없습니다: ${types.join(", ")}`);
    assert.ok(types.indexOf("CANCELLATION_REQUESTED") < types.indexOf("TASK_CANCELLED"));

    // 6) DB의 최종 상태도 CANCELLED다.
    const task = detail.task as { terminalStatus: string; cancellationRequestedAt: string | null };
    assert.equal(task.terminalStatus, "CANCELLED");
    assert.ok(task.cancellationRequestedAt, "취소 요청 시각이 기록되지 않았습니다");

    // 7) 이 취소가 **소요 분포의 표본이 된다** — 16.3절. 강제 포기 노출 시점이 추정이었던
    //    자리를 관측으로 바꾸려면, 실제 실행이 남긴 이벤트에서 간격이 뽑혀야 한다.
    //    Rust 단위 테스트는 직접 만든 타임스탬프를 재지만, 여기서는 진짜 시각이다.
    const metrics = hostQuery(ctx, [
      "metrics",
      "--workspace",
      ctx.repo.root,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]) as {
      cancellation: { settled: number; unresolved: number; forceAbandoned: number; unparsedTimestamps: number; maxMs: number | null };
      forceAbandonThreshold: { ms: number; source: string; sampleCount: number; minSamples: number };
    };
    assert.equal(metrics.cancellation.settled, 1, JSON.stringify(metrics.cancellation));
    assert.equal(metrics.cancellation.unresolved, 0, JSON.stringify(metrics.cancellation));
    assert.equal(metrics.cancellation.forceAbandoned, 0, JSON.stringify(metrics.cancellation));
    // 타임스탬프를 못 읽으면 표본이 조용히 사라진다 — 그 경우를 0이 아닌 값으로 드러낸다.
    assert.equal(metrics.cancellation.unparsedTimestamps, 0, JSON.stringify(metrics.cancellation));
    assert.ok(metrics.cancellation.maxMs !== null, JSON.stringify(metrics.cancellation));

    // 표본 하나로는 임계값을 정하지 않는다. **그리고 그 사실을 source가 말한다** —
    // 숫자만 넘기면 화면이 기본값을 측정값으로 말하게 된다.
    assert.equal(metrics.forceAbandonThreshold.source, "default_insufficient_samples");
    assert.equal(metrics.forceAbandonThreshold.sampleCount, 1);
    assert.equal(metrics.forceAbandonThreshold.ms, 5000);
  });
});

test("[시나리오 A-2] 취소된 뒤에는 새 도구 실행도 검증도 시작되지 않는다", async () => {
  requireArtifacts();
  await withCtx({ slowTest: true }, (ctx) => {
    const result = spawnSync(
      HOST_BIN,
      runArgs(ctx, ["--timeout-secs", "120", "--cancel-after-ms", "2500", "--verbose"]),
      { encoding: "utf8", timeout: 150_000, env: hostEnv() }
    );
    const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    const run = JSON.parse(line as string) as { taskId: string };
    const detail = hostQuery(ctx, [
      "show",
      "--workspace",
      ctx.repo.root,
      "--task",
      run.taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);
    const types = detail.eventTypes as string[];
    const cancelIndex = types.indexOf("CANCELLATION_REQUESTED");
    assert.ok(cancelIndex >= 0);

    // 취소 이후 구간에 FILE_MUTATED가 없어야 한다. 취소가 Policy Gate를 우회해 뭔가
    // 실행하는 경로가 되면 안 되고, 반대로 취소 후 조용히 파일을 바꿔서도 안 된다.
    const after = types.slice(cancelIndex);
    assert.ok(!after.includes("FILE_MUTATED"), `취소 후 파일이 변경되었습니다: ${after.join(", ")}`);

    // 검증 리포트도 취소 이후에 새로 생기지 않는다.
    const checks = detail.verificationChecks as { stage: string }[];
    assert.ok(checks.every((c) => c.stage === "baseline" || c.stage === "post"), "알 수 없는 검증 단계가 있습니다");
  });
});

// ---- 시나리오 B: 비정상 종료 후 복구 ----

/**
 * 호스트를 띄운 뒤 stderr에서 특정 이벤트를 보면 **SIGKILL로 즉시 죽인다.**
 *
 * SIGKILL을 쓰는 이유: SIGTERM은 정리 코드가 돌 수 있어 "비정상 종료"가 아니게 된다.
 * 여기서 검증하려는 것은 정리 코드가 **전혀 돌지 않았을 때** DB가 어떤 상태인가이다.
 */
function runUntilEventThenKill(ctx: Ctx, eventType: string, timeoutMs: number): Promise<{ killed: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(HOST_BIN, runArgs(ctx, ["--timeout-secs", "120", "--verbose"]), { env: hostEnv() });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${eventType} 이벤트를 ${timeoutMs}ms 안에 보지 못했습니다:\n${stderr}`));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!killed && stderr.includes(eventType)) {
        killed = true;
        // 이벤트가 stderr에 나온 시점에는 DB 커밋이 이미 끝나 있다
        // (host.rs는 트랜잭션 커밋 후에 sink로 emit한다).
        child.kill("SIGKILL");
      }
    });
    child.stdout.on("data", () => undefined);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ killed, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("[시나리오 B] 파일 변경 직후 비정상 종료하면 재시작 시 INTERRUPTED가 되고 롤백으로 복원된다", async () => {
  requireArtifacts();
  await withCtx({}, async (ctx) => {
    const before = ctx.repo.read("paginate.js");

    const { killed } = await runUntilEventThenKill(ctx, "FILE_MUTATED", 120_000);
    assert.ok(killed, "FILE_MUTATED를 보기 전에 호스트가 끝났습니다 — 시나리오가 성립하지 않습니다");

    // 1) 파일은 바뀐 채로 남아 있다 (프로세스가 죽어도 디스크 변경은 남는다).
    assert.notEqual(ctx.repo.read("paginate.js"), before, "파일이 변경되지 않아 복구 시나리오가 성립하지 않습니다");

    // 2) 죽기 직전까지의 기록이 DB에 남아 있다. terminal은 아직 없다.
    const tasks = hostQuery(ctx, ["tasks", "--workspace", ctx.repo.root, "--db", ctx.db, "--artifacts", ctx.artifacts])
      .tasks as { taskId: string; terminalStatus: string | null; mutationCount: number }[];
    assert.equal(tasks.length, 1, "작업 기록이 남지 않았습니다");
    const taskId = tasks[0]!.taskId;
    assert.equal(tasks[0]!.terminalStatus, null, "비정상 종료인데 terminal 상태가 기록되어 있습니다");
    assert.ok(tasks[0]!.mutationCount > 0, "파일 변경이 DB에 기록되지 않았습니다");

    // 3) 앱 재시작 = recover. 진행 중이던 작업이 INTERRUPTED로 확정된다.
    const recovery = hostQuery(ctx, [
      "recover",
      "--workspace",
      ctx.repo.root,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);
    assert.deepEqual(recovery.interruptedTasks, [taskId]);

    const detail = hostQuery(ctx, [
      "show",
      "--workspace",
      ctx.repo.root,
      "--task",
      taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);
    assert.equal((detail.task as { terminalStatus: string }).terminalStatus, "INTERRUPTED");
    assert.ok((detail.eventTypes as string[]).includes("TASK_INTERRUPTED"));
    // 자동 재개하지 않았다는 사실이 이벤트에 남는다.
    const interrupted = (detail.events as { type: string; payload: { automaticResume?: boolean } }[]).find(
      (e) => e.type === "TASK_INTERRUPTED"
    );
    assert.equal(interrupted?.payload.automaticResume, false);

    // 4) 두 번째 recover는 아무것도 바꾸지 않는다 (멱등).
    const again = hostQuery(ctx, ["recover", "--workspace", ctx.repo.root, "--db", ctx.db, "--artifacts", ctx.artifacts]);
    assert.deepEqual(again.interruptedTasks, []);

    // 5) 롤백이 INTERRUPTED 작업에서도 동작한다 — 취소/중단된 작업이야말로 되돌릴 대상이다.
    const rollback = JSON.parse(
      execFileSync(
        HOST_BIN,
        ["rollback", "--workspace", ctx.repo.root, "--task", taskId, "--db", ctx.db, "--artifacts", ctx.artifacts],
        { encoding: "utf8", env: hostEnv() }
      )
        .trim()
        .split("\n")
        .pop() as string
    ) as { restored: unknown[]; failed: unknown[] };
    assert.deepEqual(rollback.failed, []);
    assert.equal(ctx.repo.read("paginate.js"), before, "롤백이 원래 내용을 복원하지 못했습니다");

    // 6) 롤백 상태가 mutation 행에 남는다 — 무엇이 아직 남아 있는지 UI가 알 수 있어야 한다.
    const afterRollback = hostQuery(ctx, [
      "show",
      "--workspace",
      ctx.repo.root,
      "--task",
      taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);
    const mutations = afterRollback.mutations as { path: string; rollbackStatus: string }[];
    assert.ok(mutations.length > 0);
    assert.ok(
      mutations.every((m) => m.rollbackStatus === "rolled_back"),
      `롤백 상태가 갱신되지 않았습니다: ${JSON.stringify(mutations)}`
    );
  });
});

// ---- 시나리오 C: 정상 완료 후 재조회 ----

test("[시나리오 C] 정상 완료된 작업은 DB를 다시 열어도 상태·이벤트·변경·검증이 순서대로 남아 있다", async () => {
  requireArtifacts();
  await withCtx({}, (ctx) => {
    const result = spawnSync(HOST_BIN, runArgs(ctx, ["--timeout-secs", "180"]), {
      encoding: "utf8",
      timeout: 210_000,
      env: hostEnv(),
    });
    const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    assert.ok(line, `결과 JSON이 없습니다:\n${result.stdout}\n${result.stderr}`);
    const run = JSON.parse(line) as { final: { status: string }; taskId: string };
    assert.equal(run.final.status, "completed", `${JSON.stringify(run.final)}\n${result.stderr}`);

    // 호스트 프로세스는 이미 종료됐다. 여기서부터는 **새 프로세스가 DB만 열어서** 읽는다.
    const detail = hostQuery(ctx, [
      "show",
      "--workspace",
      ctx.repo.root,
      "--task",
      run.taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);

    // 1) 작업 상태
    const task = detail.task as {
      terminalStatus: string;
      currentPhase: string;
      mode: string;
      workspacePath: string;
      mutationCount: number;
      userMessage: string;
    };
    assert.equal(task.terminalStatus, "COMPLETED");
    assert.equal(task.currentPhase, "COMPLETED");
    assert.equal(task.mode, "fast");
    assert.equal(task.mutationCount, 1);
    assert.ok(task.workspacePath.length > 0, "workspace 경로가 기록되지 않아 목록 필터가 불가능합니다");

    // 2) 이벤트가 seq 순으로 빠짐없이 남아 있다.
    const events = detail.events as { eventId: number; seq: number; type: string; phase: string | null }[];
    assert.ok(events.length > 5, `이벤트가 너무 적습니다: ${events.length}`);
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i),
      "seq가 0부터 연속이 아닙니다"
    );
    assert.ok(events.some((e) => e.phase !== null), "이벤트에 phase가 기록되지 않았습니다");
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf("FILE_MUTATED") < types.indexOf("TASK_COMPLETED"));

    // 3) 변경 기록 — 아직 되돌리지 않았으므로 applied 상태다.
    const mutations = detail.mutations as { path: string; rollbackStatus: string }[];
    assert.deepEqual(
      mutations.map((m) => m.path),
      ["paginate.js"]
    );
    assert.equal(mutations[0]!.rollbackStatus, "applied");

    // 3-1) 확정 기준 테이블 — 실제 DB 파일에서 v3 스키마가 만들어지고 조회된다.
    //      fast 경로는 doneCriteria를 내지 않으므로 **비어 있는 것이 정상**이다.
    //      비어 있음을 확인하는 것이 무의미하지 않은 이유: 테이블이 없으면 조회가 에러로 죽는다.
    assert.ok(Array.isArray(detail.acceptanceCriteria), "acceptance_criteria 조회가 배열을 주지 않았습니다");
    assert.equal(
      (detail.acceptanceCriteria as unknown[]).length,
      0,
      "단일 모델 경로에서 기준이 생겼습니다 — SINGLE_MODEL_FIX는 doneCriteria를 내지 않는다"
    );

    // 4) 도구 실행 내역 — 정책 판단 없이 실행된 도구가 없다.
    const tools = detail.toolExecutions as { tool: string; policyDecision: string | null; executionStatus: string }[];
    assert.ok(tools.length > 0, "도구 실행 기록이 없습니다");
    assert.ok(
      tools.every((t) => t.policyDecision !== null && t.policyDecision.length > 0),
      `정책 판단 없이 기록된 도구가 있습니다: ${JSON.stringify(tools)}`
    );

    // 5) 검증 체크가 baseline/post 양쪽으로 남아 있다 — JSON 파싱 없이 집계 가능해야 한다.
    const checks = detail.verificationChecks as { stage: string; kind: string; status: string }[];
    assert.ok(
      checks.some((c) => c.stage === "baseline"),
      `baseline 검증 기록이 없습니다: ${JSON.stringify(checks)}`
    );
    assert.ok(checks.some((c) => c.stage === "post"));
    assert.ok(
      checks.some((c) => c.kind === "test" && c.status === "PASSED"),
      `통과한 test 체크가 없습니다: ${JSON.stringify(checks)}`
    );

    // 6) 목록 조회에도 잡힌다.
    const tasks = hostQuery(ctx, ["tasks", "--workspace", ctx.repo.root, "--db", ctx.db, "--artifacts", ctx.artifacts])
      .tasks as { taskId: string; terminalStatus: string }[];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.taskId, run.taskId);
    assert.equal(tasks[0]!.terminalStatus, "COMPLETED");

    // 7) 완료된 작업은 recover가 건드리지 않는다.
    const recovery = hostQuery(ctx, [
      "recover",
      "--workspace",
      ctx.repo.root,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]);
    assert.deepEqual(recovery.interruptedTasks, [], "완료된 작업을 INTERRUPTED로 바꿨습니다");
  });
});

test("[시나리오 E] 무엇이 어느 공급자로 나갔는지 사후에 답할 수 있다", async () => {
  // product-strategy 7절 "데이터 전송 투명성". 이 집계가 쓸모 있으려면 **실제 실행이 남긴
  // 이벤트**에서 나와야 한다 — Rust 단위 테스트는 직접 넣은 이벤트를 세지만, 여기서는
  // 스냅샷과 공급자 호출이 실제로 그 모양으로 남는지를 본다.
  requireArtifacts();
  await withCtx({ gitRepo: true }, (ctx) => {
    // `--budget-usd`를 여기서만 준다. **fake 공급자는 단가가 0이라 상한이 무엇도 막지 않으므로**
    // 이 시나리오가 확인하는 것은 강제 동작이 아니라 **배선**이다 — Rust가 받은 값이 정책 JSON을
    // 거쳐 Node의 원장까지 도달하는가. 강제 동작은 가격이 붙은 레지스트리로 단위 테스트가 본다.
    const result = spawnSync(HOST_BIN, runArgs(ctx, [
        "--mode",
        "verified",
        "--timeout-secs",
        "180",
        "--budget-usd",
        "10",
        // 15절 모델 지정. **라우터가 어차피 고를 값을 지정한다** — 확인하려는 것은 배정 결과가
        // 아니라 배선이다(Rust가 받은 값이 정책 JSON을 거쳐 라우터까지 가는가).
        "--pin-executor",
        "fake-executor",
      ]), {
      encoding: "utf8",
      timeout: 210_000,
      env: hostEnv(),
    });
    const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    assert.ok(line, `결과 JSON이 없습니다:\n${result.stdout}\n${result.stderr}`);
    const run = JSON.parse(line) as { final: { status: string }; taskId: string };
    assert.equal(run.final.status, "completed", `${JSON.stringify(run.final)}\n${result.stderr}`);

    // 호스트는 이미 종료됐다. 새 프로세스가 DB만 열어서 답한다 — 앱을 다시 켠 뒤에도
    // 같은 질문에 답할 수 있어야 투명성이다.
    const t = hostQuery(ctx, [
      "transmission",
      "--workspace",
      ctx.repo.root,
      "--task",
      run.taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]) as {
      snapshotTaken: boolean;
      providers: {
        providerId: string;
        calls: number;
        roles: string[];
        inputTokens: number;
        models: string[];
        resolvedModels: string[];
        substituted: boolean;
      }[];
      sentFiles: { path: string }[];
      namedOnlyFiles: { path: string }[];
    };

    assert.equal(t.snapshotTaken, true, JSON.stringify(t));

    // product-strategy 6절: 태스크 시작 시점의 워크스페이스 지문이 남아야 한다.
    // 이 시나리오만 픽스처를 git 저장소로 만든다 — 지문을 **실제로 잴 수 있는 경로**를
    // 확인해야 하고, git이 아니면 available:false가 정답이라 아무것도 검증하지 못한다.
    // **Rust가 쓴 이벤트**이므로 Node를 거치지 않은 사실이다.
    const detail = hostQuery(ctx, [
      "show",
      "--workspace",
      ctx.repo.root,
      "--task",
      run.taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]) as { events: { type: string; payload: Record<string, unknown> }[] };
    // 상한이 Node까지 도달했는가. `enforced: false`면 배선 어딘가에서 값이 사라진 것이고,
    // 그때 사용자는 상한을 걸었다고 믿는 채로 상한 없이 돌게 된다.
    // 지정이 라우터까지 갔는가. 배정된 모델이 같더라도 **사유가 "지정"이어야** 배선이 산 것이다.
    const routing = detail.events.find((e) => e.type === "ROUTING_DECIDED");
    assert.ok(routing, "라우팅 이벤트가 없습니다");
    const primary = (routing!.payload.assignments as { role: string; modelId: string; reason: string }[]).find(
      (a) => a.role === "executor"
    )!;
    assert.equal(primary.modelId, "fake-executor");
    assert.ok(primary.reason.includes("지정"), primary.reason);

    const budgetPolicy = detail.events.find((e) => e.type === "BUDGET_POLICY");
    assert.ok(budgetPolicy, "BUDGET_POLICY 이벤트가 없습니다");
    assert.equal(budgetPolicy!.payload.enforced, true, JSON.stringify(budgetPolicy!.payload));
    assert.equal(budgetPolicy!.payload.limitUsd, 10);

    const fingerprint = detail.events.find((e) => e.type === "WORKSPACE_FINGERPRINT");
    assert.ok(fingerprint, "워크스페이스 지문 이벤트가 없습니다");
    // 픽스처는 git 저장소이므로 잴 수 있어야 한다 — available:false면 그 자체가 결함이다.
    assert.equal(fingerprint!.payload.available, true, JSON.stringify(fingerprint!.payload));
    assert.match(String(fingerprint!.payload.fingerprint), /^sha256:[0-9a-f]{64}$/);
    // 무엇으로 만든 지문인지 남아야 재료가 바뀐 뒤에도 옛 지문을 해석할 수 있다.
    assert.ok(Array.isArray(fingerprint!.payload.inputs), JSON.stringify(fingerprint!.payload));
    assert.ok(t.sentFiles.length > 0, `나간 파일이 없습니다: ${JSON.stringify(t)}`);
    assert.ok(t.providers.length > 0, `호출된 공급자가 없습니다: ${JSON.stringify(t)}`);
    // 역할이 비어 있으면 "누가 무엇으로 불렸는가"를 말할 수 없다.
    assert.ok(
      t.providers.every((p) => p.roles.length > 0 && p.calls > 0),
      JSON.stringify(t.providers)
    );

    // **secret 파일은 내용이 아니라 이름만 나간다.** 픽스처의 .env가 그 자리에 있어야 한다 —
    // 내용이 나간 목록에 있으면 컨텍스트 차단이 뚫린 것이고, 어느 목록에도 없으면
    // 화면이 "이름도 안 나갔다"고 잘못 말하게 된다.
    assert.ok(
      !t.sentFiles.some((f) => f.path.endsWith(".env")),
      `secret 파일 내용이 전송 목록에 있습니다: ${JSON.stringify(t.sentFiles)}`
    );

    // product-strategy 6절: **공급자가 응답했다고 밝힌 모델**이 기록돼야 한다. 요청값만 남기면
    // 조용한 대체가 감사 기록에서 지워진다. fake 공급자는 요청한 모델을 그대로 돌려주므로
    // 여기서는 "기록됐고, 대체는 없었다"가 확인된다 — 기록 자체가 비면 그 구분을 할 수 없다.
    assert.ok(
      t.providers.every((p) => p.resolvedModels.length > 0),
      `응답한 모델이 기록되지 않았습니다: ${JSON.stringify(t.providers)}`
    );
    assert.ok(
      t.providers.every((p) => !p.substituted),
      `대체가 없었는데 대체로 보고됐습니다: ${JSON.stringify(t.providers)}`
    );

    // product-strategy 6절 export — **같은 실행에서** 감사 기록이 나오는지 본다. Rust 단위
    // 테스트는 직접 넣은 행을 읽지만, 여기서는 실제 실행이 남긴 것으로 만들어진다.
    const exported = hostExport(ctx, [
      "export",
      "--workspace",
      ctx.repo.root,
      "--task",
      run.taskId,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]) as {
      formatVersion: number;
      guarantees: Record<string, string>;
      workspaceFingerprint: { fingerprint?: string } | null;
      reproduce: { steps: { tool: string; args: Record<string, unknown>; recordedOutcome: unknown }[] };
      toolRequests: { tool: string; args: Record<string, unknown> }[];
      fileMutations: { path: string; postSha256?: string | null; postExisted?: boolean }[];
    };

    assert.equal(exported.formatVersion, 2);
    // 재현과 재실행이 둘 다 적혀야 한다 — 하나만 적으면 독자가 나머지를 같은 것으로 읽는다.
    assert.ok(exported.guarantees.reproduce && exported.guarantees.reRun, JSON.stringify(exported.guarantees));
    // 재현의 전제가 최상위에 있어야 한다.
    assert.equal(
      exported.workspaceFingerprint?.fingerprint,
      fingerprint!.payload.fingerprint,
      "export의 지문이 이벤트의 지문과 다릅니다"
    );

    // **argv/patch 원문이 있어야 원칙 6의 약속을 사후에 확인할 수 있다.** 실제 실행이 남긴
    // 요청에서 인자가 비어 있으면 감사 기록으로서 쓸모가 없다.
    assert.ok(exported.toolRequests.length > 0, "도구 요청 기록이 비었습니다");
    assert.ok(
      exported.toolRequests.every((r) => r.args !== undefined && r.args !== null),
      `인자 없이 기록된 요청이 있습니다: ${JSON.stringify(exported.toolRequests)}`
    );

    // 재현 목록은 읽기 전용 도구를 빼고, 남은 것에는 기록된 결과가 붙는다.
    assert.ok(exported.reproduce.steps.length > 0, "재현 단계가 비었습니다");
    assert.ok(
      exported.reproduce.steps.every((s) => !["read_file", "search_text", "list_files"].includes(s.tool)),
      `읽기 전용 도구가 재현 목록에 있습니다: ${JSON.stringify(exported.reproduce.steps.map((s) => s.tool))}`
    );
    assert.ok(
      exported.reproduce.steps.every((s) => s.recordedOutcome !== undefined),
      "재현 단계에 기록된 결과가 없습니다 — status만으로는 명령의 성공 여부를 말할 수 없습니다"
    );

    // ---- 그 export를 그대로 재현 러너에 먹인다 (state-machine 12절 판정 규칙) ----
    //
    // Rust 단위 테스트는 손으로 만든 export를 읽는다. 여기서는 **방금 실제 실행이 낸 파일**을
    // 읽으므로, export가 내는 모양과 러너가 기대하는 모양이 갈라지면 여기서 걸린다.
    const exportPath = path.join(ctx.artifacts, "reproduce-input.json");
    writeFileSync(exportPath, JSON.stringify(exported), "utf8");

    // 검사가 정말 아무것도 쓰지 않는지 보려면 **검사 전후를 비교**해야 한다. git status는
    // 내용 변경과 새 파일을 둘 다 잡는다.
    const treeBefore = execFileSync("git", ["-C", ctx.repo.root, "status", "--porcelain", "-uall"], {
      encoding: "utf8",
    });

    const check = hostExport(ctx, [
      "reproduce",
      "--workspace",
      ctx.repo.root,
      "--file",
      exportPath,
    ]) as {
      formatVersion: number;
      taskId: string;
      precondition: { verdict: string; differs?: string[] };
      applyGate: { decision: string };
      reproducibility: string;
      steps: unknown[];
      checks: { check: { status: string } }[];
    };

    assert.equal(check.formatVersion, exported.formatVersion);
    assert.equal(check.taskId, run.taskId);
    assert.equal(check.steps.length, exported.reproduce.steps.length, "계획이 export와 다릅니다");
    assert.equal(check.checks.length, check.steps.length, "검사하지 않은 단계가 있습니다");

    // export의 지문은 **시작 상태**다. 실행이 파일을 바꿨으므로 지금은 달라야 하고, 무엇보다
    // `unknown`이면 안 된다 — `unknown`은 "지문을 비교할 수 없었다"는 뜻이고, 그건 실행이
    // 지문을 제대로 남기지 못했다는 신호다. "다르다"와 "모른다"를 갈라 두는 이유가 이것이다.
    assert.equal(
      check.precondition.verdict,
      "mismatch",
      `시작 상태와 지금이 같거나 비교되지 않았습니다: ${JSON.stringify(check.precondition)}`
    );
    assert.ok(
      (check.precondition.differs ?? []).length > 0,
      "불일치인데 무엇이 다른지 말하지 않았습니다 — 사용자가 맞출 대상을 알 수 없습니다"
    );
    // 불일치에서는 확인 없이 적용을 허용하지 않는다.
    assert.equal(check.applyGate.decision, "needsAcknowledgement", JSON.stringify(check.applyGate));

    // **전제가 어긋나도 검사는 거부하지 않는다.** 각 단계가 판정을 받아야 한다.
    assert.ok(
      check.checks.every((c) => ["applies", "wouldFail", "notDecidable"].includes(c.check.status)),
      `판정되지 않은 단계가 있습니다: ${JSON.stringify(check.checks)}`
    );
    assert.ok(["yes", "no", "unknown"].includes(check.reproducibility), check.reproducibility);

    const treeAfter = execFileSync("git", ["-C", ctx.repo.root, "status", "--porcelain", "-uall"], {
      encoding: "utf8",
    });
    assert.equal(treeAfter, treeBefore, "재현 **검사**가 워크스페이스를 바꿨습니다");

    // ---- 적용: 시작 상태로 되돌린 뒤 기록을 다시 적용한다 ----
    //
    // 이것이 "재현"의 실제 정의다(product-strategy 6.3절). Rust 단위 테스트는 손으로 만든
    // 계획을 적용하지만, 여기서는 **실제 실행이 낸 기록**을 실제 워크스페이스에 적용한다.

    // 재현의 판정 재료가 export에 있어야 한다 — 없으면 아래 판정이 unknown으로 떨어지고,
    // 그러면 이 테스트는 "돌기는 했다"만 확인하게 된다.
    assert.ok(exported.fileMutations.length > 0, "변경 기록이 비었습니다");
    assert.ok(
      exported.fileMutations.some((m) => typeof m.postSha256 === "string"),
      `기록에 내용 해시가 없습니다 — 재현을 판정할 수 없습니다: ${JSON.stringify(exported.fileMutations)}`
    );

    // 시작 상태로 되돌린다. 지문이 시작 상태의 것이므로 이래야 전제가 match가 된다.
    execFileSync("git", ["-C", ctx.repo.root, "checkout", "--", "."], { encoding: "utf8" });
    execFileSync("git", ["-C", ctx.repo.root, "clean", "-qfd"], { encoding: "utf8" });

    const applied = hostExport(ctx, [
      "reproduce",
      "--workspace",
      ctx.repo.root,
      "--file",
      exportPath,
      "--apply",
      "--auto-approve-writes",
      "--artifacts",
      ctx.artifacts,
    ]) as {
      precondition: { verdict: string };
      applyGate: { decision: string };
      completed: boolean;
      outcome: string;
      stoppedAt: { kind: string } | null;
      applied: { tool: string; status: string }[];
      files: { path: string; verdict: { status: string } }[];
    };

    // 되돌렸으므로 전제가 맞아야 한다. mismatch가 나오면 되돌리기가 덜 된 것이고,
    // 그 상태에서 이어지는 판정은 아무것도 말하지 않는다.
    assert.equal(
      applied.precondition.verdict,
      "match",
      `시작 상태로 되돌리지 못했습니다: ${JSON.stringify(applied.precondition)}`
    );
    assert.equal(applied.applyGate.decision, "allowed", JSON.stringify(applied.applyGate));
    assert.equal(
      applied.completed,
      true,
      `적용이 중간에 멈췄습니다: ${JSON.stringify(applied.stoppedAt)}\n${JSON.stringify(applied.applied)}`
    );

    // **판정은 "단계가 다 돌았다"가 아니라 "기록과 같은 내용이 됐다"이다.**
    assert.equal(
      applied.outcome,
      "reproduced",
      `기록과 같은 상태가 아닙니다: ${JSON.stringify(applied.files)}`
    );
    assert.ok(
      applied.files.every((f) => ["matches", "absentAsRecorded"].includes(f.verdict.status)),
      `판정되지 않았거나 어긋난 파일이 있습니다: ${JSON.stringify(applied.files)}`
    );
  });
});

/**
 * 인덱스 캐시가 **프로세스보다 오래 사는가** (context-engine.md 2절, process-architecture.md 11.4절).
 *
 * 이게 이 캐시의 존재 이유다. 프로세스 안 캐시는 이미 있었고, 워크스페이스를 전환하면
 * sidecar가 종료되므로 함께 사라진다 — 전환이 싸지려면 저장된 것이 살아남아야 한다.
 * 여기서는 **호스트를 완전히 새로 띄워서**(새 sidecar, 새 ContextEngine) 그걸 확인한다.
 */
test("[시나리오 F] 인덱스 캐시가 프로세스를 넘어 살아남는다", async () => {
  requireArtifacts();
  // **git 저장소여야 한다.** 지문을 낼 수 없는 워크스페이스에서는 캐시를 쓰지도 저장하지도
  // 않는 것이 규칙이므로, `gitRepo: false`로 돌리면 이 시나리오는 성립하지 않는다.
  await withCtx({ gitRepo: true }, (ctx) => {
    const runOnce = () => {
      const result = spawnSync(HOST_BIN, runArgs(ctx, ["--mode", "fast", "--timeout-secs", "180"]), {
        encoding: "utf8",
        timeout: 210_000,
        env: hostEnv(),
      });
      const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
      assert.ok(line, `결과 JSON이 없습니다:\n${result.stdout}\n${result.stderr}`);
      return JSON.parse(line) as { final: { status: string }; taskId: string; eventTypes: string[] };
    };

    const first = runOnce();
    assert.ok(
      first.eventTypes.includes("WORKSPACE_INDEX_BUILT"),
      `첫 실행이 인덱스를 만들지 않았습니다: ${first.eventTypes.join(", ")}`
    );
    assert.ok(
      !first.eventTypes.includes("WORKSPACE_INDEX_CACHE_HIT"),
      "빈 캐시에서 적중이 났습니다 — 판정이 지문을 보지 않는다는 뜻입니다"
    );

    // 첫 실행이 파일을 바꿨으므로 지문이 달라졌다. 시작 상태로 되돌려야 **같은 상태**가 된다 —
    // 되돌리지 않고 적중이 나면 그건 지문을 보지 않았다는 뜻이므로, 이 복원 자체가 검사의 일부다.
    execFileSync("git", ["-C", ctx.repo.root, "checkout", "--", "."], { encoding: "utf8" });
    execFileSync("git", ["-C", ctx.repo.root, "clean", "-qfd"], { encoding: "utf8" });

    const second = runOnce();
    assert.ok(
      second.eventTypes.includes("WORKSPACE_INDEX_CACHE_HIT"),
      `새 프로세스가 저장된 인덱스를 쓰지 않았습니다: ${second.eventTypes.join(", ")}`
    );
    assert.ok(
      !second.eventTypes.includes("WORKSPACE_INDEX_BUILT"),
      "적중했는데 다시 만들었습니다"
    );
  });
});

test("[시나리오 D] 저장된 이벤트에서 기준 계측을 집계할 수 있다", async () => {
  // 12절 미해결 두 항목("기준↔테스트 연결의 커버리지", "위치 충돌 규칙의 오탐률")은 집계로만
  // 답할 수 있는 질문이다. **실제 DB 파일**에서 그 집계가 나오는지를 여기서 확인한다 —
  // Rust 단위 테스트는 직접 넣은 이벤트를 세지만, 여기서는 실제 실행이 남긴 이벤트를 센다.
  requireArtifacts();
  await withCtx({}, (ctx) => {
    const result = spawnSync(HOST_BIN, runArgs(ctx, ["--mode", "verified", "--timeout-secs", "180"]), {
      encoding: "utf8",
      timeout: 210_000,
      env: hostEnv(),
    });
    const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    assert.ok(line, `결과 JSON이 없습니다:\n${result.stdout}\n${result.stderr}`);
    const run = JSON.parse(line) as { final: { status: string } };
    assert.equal(run.final.status, "completed", `${JSON.stringify(run.final)}\n${result.stderr}`);

    // 호스트는 이미 종료됐다. 새 프로세스가 DB만 열어서 집계한다.
    const metrics = hostQuery(ctx, [
      "metrics",
      "--workspace",
      ctx.repo.root,
      "--db",
      ctx.db,
      "--artifacts",
      ctx.artifacts,
    ]) as {
      tasksScanned: number;
      coverage: { criteria: number; byStatus: Record<string, number>; byCode: Record<string, number> };
      conflicts: { detected: number; settled: number };
      tokenEstimate: { calls: number; callsWithoutEstimate: number; callsWhereActualExceededEstimate: number };
      ipcLineSizes: {
        tasksObserved: number;
        lines: number;
        maxBytes: number;
        maxPercentOfLimit: number | null;
        byUpToBytes: Record<string, number>;
      };
      openQuestions: { id: string; samples: number; readiness: string; denominator: string; actOn: string }[];
    };

    assert.equal(metrics.tasksScanned, 1);

    // context-engine 8절: **우리 토큰 추정이 실제와 함께 기록됐는가.** 추정은 "이보다 많지는
    // 않을 것"이라고 주장하는 값이고, 그 주장은 두 수가 나란히 있어야만 검증된다. fake
    // 공급자는 고정 usage를 보고하므로 비율 자체에 의미는 없지만, **배선이 끊기면 여기서 걸린다.**
    assert.ok(metrics.tokenEstimate.calls > 0, JSON.stringify(metrics.tokenEstimate));
    assert.equal(
      metrics.tokenEstimate.callsWithoutEstimate,
      0,
      `추정 없이 기록된 호출이 있습니다: ${JSON.stringify(metrics.tokenEstimate)}`
    );
    // 교차검증 경로의 초안이 doneCriteria를 내므로 기준이 있고, 판정도 있다.
    assert.ok(metrics.coverage.criteria > 0, JSON.stringify(metrics));
    // 상태별 합계가 기준 총수와 같아야 한다 — 어긋나면 판정이 조용히 빠진 것이다.
    const statusTotal = Object.values(metrics.coverage.byStatus).reduce((a, b) => a + b, 0);
    assert.equal(statusTotal, metrics.coverage.criteria);
    // **사유 코드가 채워져야 집계가 의미를 갖는다.** unknown뿐이면 계측이 끊긴 것이다.
    assert.ok(!("unknown" in metrics.coverage.byCode), JSON.stringify(metrics.coverage.byCode));

    // 이 실행에는 기준 충돌이 없다. 감지와 결말이 둘 다 0이어야 하고, 특히
    // **감지보다 결말이 적으면** 결말이 새고 있다는 뜻이므로 그 불변식을 여기서 고정한다.
    assert.equal(metrics.conflicts.detected, 0);
    assert.ok(metrics.conflicts.settled <= metrics.conflicts.detected);

    // process-architecture 3.1절: **IPC 줄 크기가 실제로 기록되는가.** 계측기는 spawn 시점에
    // handler로 건네지고 태스크가 끝날 때 이벤트가 된다 — 그 사슬 중 하나라도 끊기면 여기서
    // 걸린다. Rust 단위 테스트는 계수기만 보므로 배선은 실제 실행에서만 확인된다.
    assert.ok(metrics.ipcLineSizes.lines > 0, JSON.stringify(metrics.ipcLineSizes));
    assert.ok(metrics.ipcLineSizes.maxBytes > 0, JSON.stringify(metrics.ipcLineSizes));
    // 구간 합계가 줄 수와 같아야 한다 — 어긋나면 어떤 줄이 어느 구간에도 안 들어간 것이다.
    const bucketed = Object.values(metrics.ipcLineSizes.byUpToBytes).reduce((a, b) => a + b, 0);
    assert.equal(bucketed, metrics.ipcLineSizes.lines, JSON.stringify(metrics.ipcLineSizes));

    // **열린 질문 목록이 실제 실행에서도 채워지는가.** 표본이 적으므로 전부
    // insufficient_samples여야 한다 — 한 번 돌린 것으로 답이 나오면 그게 이 가드의 실패다.
    const ipc = metrics.openQuestions.find((q) => q.id === "ipcLineSize");
    assert.ok(ipc, JSON.stringify(metrics.openQuestions.map((q) => q.id)));
    // **표본은 줄이 아니라 태스크다.** 줄로 세면 한 번 돌린 것만으로 최소치를 넘어버린다 —
    // 실제로 이 실행 하나가 43줄을 냈고, 그게 이 단언에 걸려 드러났다.
    assert.equal(metrics.ipcLineSizes.tasksObserved, 1);
    assert.equal(ipc.samples, 1);
    assert.ok(
      metrics.openQuestions.every((q) => q.readiness === "insufficient_samples"),
      JSON.stringify(metrics.openQuestions)
    );
  });
});
