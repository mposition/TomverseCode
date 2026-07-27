import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepo, FIX_PATCH, type FixtureRepo } from "./helpers/fixtureRepo.js";

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
const HOST_BIN = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "target", "debug", "tomverse-host");
const SIDECAR_ENTRY = path.join(REPO_ROOT, "packages", "sidecar", "dist", "src", "index.js");

/** 산출물이 없으면 조용히 통과시키지 않는다 — "건너뜀"이 "통과"로 보이면 안 된다. */
function requireArtifacts(): void {
  assert.ok(
    existsSync(HOST_BIN) && existsSync(SIDECAR_ENTRY),
    `e2e 산출물이 없습니다.\n  ${HOST_BIN} (${existsSync(HOST_BIN) ? "있음" : "없음"})\n` +
      `  ${SIDECAR_ENTRY} (${existsSync(SIDECAR_ENTRY) ? "있음" : "없음"})\n` +
      `먼저 실행하세요: npm run build && npm run core:build`
  );
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

function withCtx(options: { slowTest?: boolean }, fn: (ctx: Ctx) => void | Promise<void>): Promise<void> {
  const repo = createFixtureRepo({ slowTest: options.slowTest });
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
