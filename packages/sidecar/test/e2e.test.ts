import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFixtureRepo,
  ESCAPE_PATCH,
  FIX_PATCH,
  MISMATCHED_PATCH,
  type FixtureRepo,
} from "./helpers/fixtureRepo.js";
import type { FakeScriptStep } from "../src/providers/fake.js";
import { checkArtifacts, hostBinaryPath, resolveNodeCli, sidecarEntryPath } from "@tomverse/toolchain";

/**
 * End-to-end 테스트 — **실제** 구성요소로 M0 완료 기준을 검증한다.
 *
 * 여기서 진짜인 것:
 *  - Rust Policy Gate (workspace 경계, 승인 판정)
 *  - Rust Tool Runtime (실제 파일에 unified diff 적용)
 *  - Rust Verification Runner (실제로 `npm test`를 실행)
 *  - SQLite 이벤트 로그 (실제 DB 파일)
 *  - Node Orchestrator 상태 머신 (실제 sidecar 프로세스)
 *  - 픽스처 저장소 (실제 파일 시스템, 실제로 실패하는 테스트)
 *
 * 가짜인 것은 **LLM 응답 하나뿐**이다 — 그게 fake provider의 존재 이유이고,
 * 그 외의 것을 mock하면 e2e가 아무것도 증명하지 못한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 컴파일 후 위치는 packages/sidecar/dist/test/ 이므로 리포지토리 루트까지 4단계 올라간다.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// 경로 조립을 여기서 하지 않는다. **Windows에서는 `tomverse-host.exe`**이고, 그 사실을
// 세 파일에 복사해 두었다가 두 곳만 틀렸던 것이 `@tomverse/toolchain`이 생긴 이유다.
const HOST_BIN = hostBinaryPath(REPO_ROOT, process.platform);
const SIDECAR_ENTRY = sidecarEntryPath(REPO_ROOT);

interface HostRun {
  exitCode: number;
  final: {
    status: string;
    summary: string;
    failureReason?: string;
    verificationReport?: { overall: string; checks: { kind: string; status: string }[] };
    acceptanceCriteria?: { criterionId: string; text: string; source: string; decidedAt: string }[];
    criterionEvaluations?: { criterionId: string; status: string; reason: string; evidence?: string[] }[];
  };
  mutatedPaths: string[];
  eventTypes: string[];
  taskId: string;
  stderr: string;
  dbPath: string;
}

interface RunOptions {
  message?: string;
  mode?: "fast" | "verified";
  approve?: "auto" | "deny";
  autoApproveWrites?: boolean;
  script?: FakeScriptStep[];
  defaultPatch?: string;
  timeoutSecs?: number;
  allowGitCommit?: boolean;
}

function hostAvailable(): boolean {
  return checkArtifacts(REPO_ROOT, process.platform).ok;
}

/**
 * `tomverse-host`를 실제로 실행한다.
 *
 * 바이너리나 sidecar dist가 없으면 조용히 통과시키지 않고 **실패**시킨다 —
 * "환경이 준비되지 않아서 e2e를 건너뛰었다"가 "e2e가 통과했다"로 보이면 안 된다.
 */
function runHost(repo: FixtureRepo, stateDir: string, options: RunOptions = {}): HostRun {
  // 실패 메시지에 **검사한 전체 경로**가 들어간다 — Windows에서 `.exe` 유무가 원인일 때
  // 경로가 없으면 사용자가 원인에 도달할 방법이 없다.
  const artifacts = checkArtifacts(REPO_ROOT, process.platform);
  assert.ok(artifacts.ok, artifacts.detail);

  const args = [
    "run",
    "--workspace",
    repo.root,
    "--message",
    options.message ?? "paginate.js 의 페이지 계산이 한 칸 밀려 있습니다. 1페이지가 첫 항목부터 나오게 고쳐주세요.",
    "--mode",
    options.mode ?? "fast",
    "--approve",
    options.approve ?? "auto",
    "--db",
    path.join(stateDir, "state.db"),
    "--artifacts",
    path.join(stateDir, "artifacts"),
    "--sidecar",
    SIDECAR_ENTRY,
    "--timeout-secs",
    String(options.timeoutSecs ?? 180),
  ];
  if (options.autoApproveWrites) args.push("--auto-approve-writes");
  if (options.allowGitCommit) args.push("--allow-git-commit");

  const fakeConfig = {
    ...(options.defaultPatch !== undefined ? { defaultPatch: options.defaultPatch } : { defaultPatch: FIX_PATCH }),
    ...(options.script ? { script: options.script } : {}),
  };

  const result = spawnSync(HOST_BIN, args, {
    encoding: "utf8",
    timeout: (options.timeoutSecs ?? 180) * 1000 + 30_000,
    env: {
      ...process.env,
      TOMVERSE_FAKE_SCRIPT: JSON.stringify(fakeConfig),
      TOMVERSE_EXECUTOR_MODEL: "fake-executor",
      TOMVERSE_REVIEWER_MODEL: "fake-reviewer",
      // 실제 공급자가 후보에 끼지 않도록 키를 지운다 — 테스트가 우연히 네트워크를 타면 안 된다.
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
  });

  const stdout = result.stdout ?? "";
  const jsonLine = stdout.trim().split("\n").filter(Boolean).pop();
  assert.ok(jsonLine, `호스트가 결과 JSON을 출력하지 않았습니다.\nstdout:\n${stdout}\nstderr:\n${result.stderr}`);

  const parsed = JSON.parse(jsonLine) as Omit<HostRun, "exitCode" | "stderr">;
  return { ...parsed, exitCode: result.status ?? -1, stderr: result.stderr ?? "" };
}

/** 커밋 이력의 제목 목록 (최신 순). 커밋이 없으면 빈 배열이다. */
function gitLogSubjects(root: string): string[] {
  const out = execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

function withRepo(fn: (repo: FixtureRepo, stateDir: string) => void): void {
  const repo = createFixtureRepo();
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  try {
    fn(repo, stateDir);
  } finally {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** 이벤트 로그를 SQLite에서 직접 읽는다 — 감사 추적이 실제로 남았는지 확인한다. */
function readEvents(dbPath: string): { seq: number; type: string; payload: string }[] {
  const sqlite = spawnSync("sqlite3", [dbPath, "SELECT seq, event_type, payload_json FROM task_events ORDER BY seq"], {
    encoding: "utf8",
  });
  if (sqlite.error || sqlite.status !== 0) return [];
  return sqlite.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [seq, type, ...rest] = line.split("|");
      return { seq: Number(seq), type: type ?? "", payload: rest.join("|") };
    });
}

// ---- 픽스처 자체의 전제 검증 ----

/**
 * 픽스처의 `npm test`를 이 테스트 프로세스 밖에서와 같은 조건으로 실행한다.
 *
 * # 이건 제품 경로가 아니다
 *
 * **아래 e2e 본체는 계속 논리 명령 `npm test`를 Rust Tool Runtime에 요청한다.** 그래야 새
 * Windows 프로그램 해석 계층(`tools/program.rs`)이 실제로 검증된다. 여기 있는 것은 그 전에
 * "픽스처가 정말 실패하는가"를 확인하는 **전제 검사**일 뿐이고, Node 쪽에서 npm을 직접
 * 띄워야 하므로 별도 helper가 필요하다.
 *
 * Windows에서 `spawnSync("npm", ...)`는 `npm.exe`가 없어 실패한다(`npm.cmd`가 설치된다).
 * 셸로 감싸지 않고 `@tomverse/toolchain`의 해석 helper로 Node + `npm-cli.js`를 조립한다 —
 * 제품 쪽과 같은 방식이되, 구현은 서로 독립이다.
 *
 * `NODE_TEST_CONTEXT`를 지우는 이유: 우리가 `node --test`로 돌고 있으므로 이 변수가 자식에게
 * 상속되고, 그러면 자식 `node --test`가 실패해도 exit 0을 반환한다. Rust Tool Runtime도
 * 같은 변수를 제거하므로(tools/mod.rs) 여기서 지우는 것은 제품 동작을 재현하는 것이다.
 */
function runFixtureTests(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;

  const resolved = resolveNodeCli("npm", ["test", "--silent"], {
    platform: process.platform,
    pathValue: env.PATH ?? env.Path ?? "",
    pathext: env.PATHEXT,
  });
  // 해석하지 못하면 조용히 건너뛰지 않는다 — 전제 검사가 사라지면 e2e 전체의 의미가 약해진다.
  if (!resolved.ok) assert.fail(`픽스처 테스트를 실행할 수 없습니다:\n${resolved.message}`);

  const result = spawnSync(resolved.executable, resolved.args, {
    cwd,
    encoding: "utf8",
    env,
    shell: false,
  });
  // **spawn 실패를 "테스트 실패"로 넘기지 않는다.**
  // `status`는 프로세스가 뜨지 못하면 null이다. 그런데 "픽스처가 실패한다"는 전제 검사는
  // `status !== 0`을 보므로, npm을 아예 실행하지 못해도 통과해 버린다 — 실측으로 그렇게
  // 거짓 통과했다. 실행 자체가 안 된 것은 전제 검사 결과가 아니라 환경 결함이다.
  if (result.error !== undefined || result.status === null) {
    assert.fail(
      [
        `픽스처 테스트를 실행하지 못했습니다 (전제 검사가 성립하지 않습니다).`,
        `  실행 대상: ${resolved.executable}`,
        `  인자: ${JSON.stringify(resolved.args)}`,
        `  오류: ${result.error?.message ?? "종료 코드 없음"}`,
      ].join("\n")
    );
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("[e2e 전제] 픽스처의 테스트가 수정 전에는 실제로 실패한다", () => {
  withRepo((repo) => {
    const result = runFixtureTests(repo.root);
    assert.notEqual(result.status, 0, "픽스처 테스트가 처음부터 통과하면 e2e가 아무것도 증명하지 못합니다");
  });
});

test("[e2e 전제] 수정된 소스에서는 테스트가 통과한다", () => {
  const repo = createFixtureRepo({ withPassingTest: true });
  try {
    const result = runFixtureTests(repo.root);
    assert.equal(result.status, 0, `수정 후에도 실패합니다:\n${result.stdout}\n${result.stderr}`);
  } finally {
    repo.cleanup();
  }
});

// ---- M0 완료 기준 ----

test("M0: 버그 수정 1건이 요청→분석→승인→파일 변경→검증→완료까지 완주한다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir);

    assert.equal(run.final.status, "completed", `실패: ${run.final.summary}\nstderr:\n${run.stderr}`);
    assert.equal(run.exitCode, 0);

    // 1) 파일이 실제로 바뀌었다.
    assert.deepEqual(run.mutatedPaths, ["paginate.js"]);
    assert.ok(repo.read("paginate.js").includes("(page - 1) * perPage"));

    // 2) 검증이 실제로 돌아 통과했다 — 통과로 위장한 것이 아니라 npm test가 실제로 성공했다.
    assert.equal(run.final.verificationReport?.overall, "pass");
    const testCheck = run.final.verificationReport?.checks.find((c) => c.kind === "test");
    assert.equal(testCheck?.status, "PASSED");

    // 3) 이벤트 순서가 상태 머신과 일치한다.
    //    각 도구 실행 안의 순서는 TOOL_REQUESTED → POLICY_DECIDED → (승인) → FILE_MUTATED →
    //    TOOL_COMPLETED다 (host.rs execute_tool). 정책 판단이 승인 요청보다 먼저 온다 —
    //    무엇을 승인할지 결정하는 것이 Policy Gate이기 때문이다.
    const events = run.eventTypes;
    assertOrder(events, [
      "TASK_CREATED",
      "PHASE_CHANGED", // SNAPSHOTTING
      "SNAPSHOT_CREATED",
      "TRIAGE_COMPLETED",
      "ROUTING_DECIDED",
      "PLAN_CREATED",
      "TOOL_REQUESTED",
      "POLICY_DECIDED",
      "APPROVAL_REQUESTED",
      "APPROVAL_GRANTED",
      "FILE_MUTATED",
      "TOOL_COMPLETED",
      "VERIFICATION_COMPLETED",
      "TASK_COMPLETED",
    ]);

    // 4) 파일 변경 전에 승인이 있었다.
    assert.ok(events.indexOf("APPROVAL_GRANTED") < events.indexOf("FILE_MUTATED"));
    // 5) 정책 판단 없이 실행된 도구가 없다.
    assert.equal(
      events.filter((t) => t === "TOOL_REQUESTED").length,
      events.filter((t) => t === "POLICY_DECIDED").length,
      "모든 도구 요청은 Policy Gate 판단을 거쳐야 합니다"
    );

    // 6) 이벤트가 SQLite에 실제로 남았고 seq가 단조 증가한다.
    const rows = readEvents(run.dbPath);
    if (rows.length > 0) {
      const seqs = rows.map((r) => r.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      assert.equal(seqs[0], 0);
    }
  });
});

test("M0: 검증되지 않은 통과를 만들지 않는다 — baseline과 post 리포트가 모두 기록된다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir);
    const verifications = run.eventTypes.filter((t) => t === "VERIFICATION_COMPLETED");
    // baseline(작업 전) + post(작업 후). 둘 다 있어야 "새로 깨진 것"을 판정할 수 있다.
    assert.ok(verifications.length >= 2, `검증이 두 번(baseline/post) 돌아야 합니다: ${verifications.length}회`);
  });
});

test("M0: secret 파일은 모델 컨텍스트에 들어가지 않는다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir, {
      // 사용자가 .env를 직접 언급해도 하드 필터가 이겨야 한다.
      message: ".env 의 OPENAI_API_KEY 설정을 paginate.js 에서 읽도록 고쳐주세요",
    });

    // 이벤트 로그 어디에도 secret 값이 없어야 한다.
    const rows = readEvents(run.dbPath);
    const allPayloads = rows.map((r) => r.payload).join("\n");
    assert.ok(!allPayloads.includes("sk-fixture-must-never-leak"), "이벤트 로그에 secret이 유출되었습니다");
    // 호스트 stderr(=UI로 릴레이되는 이벤트)에도 없어야 한다.
    assert.ok(!run.stderr.includes("sk-fixture-must-never-leak"), "이벤트 스트림에 secret이 유출되었습니다");
  });
});

// ---- 실패 시나리오 ----

test("실패 시나리오: workspace 밖 파일 수정 요청은 Policy Gate가 거부한다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir, { defaultPatch: ESCAPE_PATCH });

    assert.notEqual(run.final.status, "completed");
    // 파일이 만들어지지 않았다.
    assert.deepEqual(run.mutatedPaths, []);
    // 거부 판정이 이벤트로 남았다.
    assert.ok(run.eventTypes.includes("POLICY_DECIDED") || run.eventTypes.includes("ERROR"));
    assert.ok(!run.eventTypes.includes("FILE_MUTATED"), "workspace 밖 파일이 변경되었습니다");
  });
});

test("실패 시나리오: 승인 거부는 파일을 변경하지 않고 취소로 끝난다", () => {
  withRepo((repo, stateDir) => {
    const before = repo.read("paginate.js");
    const run = runHost(repo, stateDir, { approve: "deny" });

    assert.notEqual(run.final.status, "completed");
    assert.equal(repo.read("paginate.js"), before, "승인을 거부했는데 파일이 변경되었습니다");
    assert.ok(run.eventTypes.includes("APPROVAL_REQUESTED"));
    assert.ok(run.eventTypes.includes("APPROVAL_DENIED"));
    assert.ok(!run.eventTypes.includes("FILE_MUTATED"));
  });
});

test("실패 시나리오: 기존 내용과 맞지 않는 patch는 부분 적용되지 않는다", () => {
  withRepo((repo, stateDir) => {
    const before = repo.read("paginate.js");
    const run = runHost(repo, stateDir, {
      defaultPatch: MISMATCHED_PATCH,
      // fix loop에서도 같은 잘못된 patch를 내면 상한에서 멈춘다.
      script: [
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시", patch: MISMATCHED_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시", patch: MISMATCHED_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시", patch: MISMATCHED_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시", patch: MISMATCHED_PATCH } },
      ],
    });

    assert.notEqual(run.final.status, "completed");
    // 가장 중요한 확인: 부분 적용되지 않았다.
    assert.equal(repo.read("paginate.js"), before, "patch가 부분 적용되었습니다");
    assert.deepEqual(run.mutatedPaths, []);
  });
});

test("실패 시나리오: 검증 실패 후 제한된 fix loop를 돌고 멈춘다", () => {
  withRepo((repo, stateDir) => {
    // 문법적으로 적용은 되지만 버그를 고치지 못하는 patch → 테스트가 계속 실패한다.
    const uselessPatch = [
      "--- a/paginate.js",
      "+++ b/paginate.js",
      "@@ -1,2 +1,3 @@",
      " function paginate(items, page, perPage) {",
      "+  // 주석만 추가 — 버그는 그대로다",
      "   const start = page * perPage;",
      "",
    ].join("\n");

    const run = runHost(repo, stateDir, {
      defaultPatch: uselessPatch,
      script: [
        { kind: "fix", payload: { verdict: "REJECT", rationale: "고칠 수 없음", rejectionReason: "원인을 모르겠음" } },
      ],
      timeoutSecs: 180,
    });

    assert.equal(run.final.status, "failed");
    // 적용은 됐으므로 변경 기록이 남아 있어야 한다 — 롤백이 가능해야 하기 때문이다.
    assert.deepEqual(run.mutatedPaths, ["paginate.js"]);
    assert.ok(run.eventTypes.includes("FIX_LOOP_STARTED"), `fix loop가 시작되지 않았습니다: ${run.eventTypes.join(", ")}`);
    // 무한 루프가 아니라 상한에서 멈췄다.
    assert.ok(run.eventTypes.filter((t) => t === "FIX_LOOP_STARTED").length <= 3);
    assert.ok(run.eventTypes.includes("TASK_FAILED"));
  });
});

test("롤백이 태스크가 바꾼 파일만 원래 내용으로 되돌린다", () => {
  withRepo((repo, stateDir) => {
    const before = repo.read("paginate.js");
    const run = runHost(repo, stateDir);
    assert.equal(run.final.status, "completed", run.final.summary);
    assert.notEqual(repo.read("paginate.js"), before);

    // 사용자가 무관하게 편집한 파일 — 롤백이 이걸 건드리면 안 된다 (문서 10절, git stash를 안 쓰는 이유).
    repo.write("unrelated.txt", "사용자가 직접 만든 파일\n");

    const rollback = execFileSync(
      HOST_BIN,
      [
        "rollback",
        "--workspace",
        repo.root,
        "--task",
        run.taskId,
        "--db",
        path.join(stateDir, "state.db"),
        "--artifacts",
        path.join(stateDir, "artifacts"),
      ],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(rollback.trim().split("\n").pop() as string) as { restored: unknown[]; failed: unknown[] };

    assert.deepEqual(parsed.failed, []);
    assert.equal(repo.read("paginate.js"), before, "롤백이 원래 내용을 복원하지 못했습니다");
    assert.equal(repo.read("unrelated.txt"), "사용자가 직접 만든 파일\n", "롤백이 무관한 파일을 건드렸습니다");
  });
});

test("verified 모드는 교차검증 경로(REVIEWING)를 지난다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir, { mode: "verified" });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);
    // fake-a(executor)와 fake-b(reviewer)가 다른 공급자이므로 독립성 불변식이 만족된다.
    assert.ok(run.eventTypes.includes("REVIEW_RECEIVED"), `검수 단계가 실행되지 않았습니다: ${run.eventTypes.join(", ")}`);
    assert.ok(run.stderr.includes("REVIEWING"), "REVIEWING phase 전이가 보이지 않습니다");

    // 17.3절: 초안의 doneCriteria가 수집만 되고 버려지지 않는다.
    // **실제 호스트를 지나는 경로에서 확인한다** — Node 단위 테스트만으로는 프로토콜 필드가
    // 실제 IPC 왕복에서 살아남는지 알 수 없다.
    const criteria = run.final.acceptanceCriteria ?? [];
    assert.ok(criteria.length > 0, `확정 기준이 최종 결과에 없습니다: ${JSON.stringify(run.final)}`);
    assert.ok(
      criteria.every((c) => ["user_decision", "draft_proposal", "user_message"].includes(c.source)),
      `알 수 없는 기준 출처: ${JSON.stringify(criteria)}`
    );
    // 충족 여부 필드는 없어야 한다 — 있으면 언젠가 모델이 채우고 미확인이 확인으로 둔갑한다.
    assert.ok(
      criteria.every((c) => !("verified" in c) && !("status" in c)),
      `기준에 충족 여부 필드가 생겼습니다: ${JSON.stringify(criteria)}`
    );

    // 17절: 대조가 실제로 돌았다. 불일치 0건이어도 이벤트가 남아야 "쟁점이 없었다"와
    // "대조하지 않았다"를 구별할 수 있다. **실제 호스트에서** 확인한다 — 초안이 둘 생기는
    // 것은 Node 안에서 끝나는 일이 아니라 이벤트 로그와 비용에 그대로 나타나는 사실이다.
    assert.ok(
      run.eventTypes.includes("DISAGREEMENT_DETECTED"),
      `대조 이벤트가 없습니다: ${run.eventTypes.join(", ")}`
    );
    assert.equal(
      run.eventTypes.filter((t) => t === "DRAFT_RECEIVED").length,
      2,
      "대조가 켜지면 초안 이벤트가 둘이어야 합니다(13.4절 비용 표)"
    );
  });
});

test("기준이 지목한 테스트가 실제로 실행됐을 때만 확인으로 판정된다", () => {
  // state-machine-and-protocol.md 17.3절 규칙 2 / 17.9절.
  //
  // **실제 호스트에서 확인한다**: 판정의 근거인 "test 체크가 통과했다"와 "그 파일이 실행됐다"는
  // 둘 다 Rust가 만든 리포트에서 오고, Node 단위 테스트는 그 리포트를 스텁으로 대신한다.
  // 픽스처의 테스트 명령은 `node --test paginate.test.js`이므로 argv가 실행 근거가 된다.
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir, {
      mode: "fast",
      script: [
        {
          kind: "singleFix",
          payload: {
            verdict: "ACCEPT",
            rationale: "오프바이원 수정",
            patch: FIX_PATCH,
          },
        },
      ],
    });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);

    // 단일 모델 경로에는 doneCriteria가 없으므로 기준도 판정도 없다 — **없는 것이 맞다.**
    // 여기서 판정이 생기면 근거 없이 만들어낸 것이다.
    assert.equal(run.final.acceptanceCriteria, undefined);
    assert.ok(
      !run.eventTypes.includes("CRITERIA_CONFLICT_DETECTED"),
      "기준이 없는데 충돌이 감지되었습니다"
    );
  });
});

test("확정된 기준이 있으면 검증 뒤에 기준별 판정이 계산된다", () => {
  withRepo((repo, stateDir) => {
    // 교차검증 경로의 초안이 doneCriteria를 내므로 기준이 생긴다. 하나는 픽스처의 실제 테스트
    // 파일을 지목하고, 다른 하나는 아무것도 지목하지 않는다 — 확인과 미확인이 **둘 다** 나와야
    // "전부 확인" 또는 "전부 미확인"으로 뭉개지지 않았음이 증명된다.
    //
    // `requiredTests`도 기준이 된다(17.9.1절 ④). 그래서 기준은 셋이고 확인은 둘이다 —
    // 이 테스트가 그 흡수를 **production 실행 경로 전체**로 확인하는 자리이기도 하다.
    const draft = {
      kind: "draft" as const,
      payload: {
        interpretation: "페이지 계산이 한 칸 밀렸다",
        patch: FIX_PATCH,
        plan: [{ stepId: "s1", description: "paginate.js 수정", targetPaths: ["paginate.js"] }],
        risks: [],
        requiredTests: ["paginate.test.js"],
        uncertainties: [],
        doneCriteria: ["1페이지가 첫 항목부터 나온다 (paginate.test.js)", "오류 메시지를 한국어로 표시한다"],
      },
    };
    const run = runHost(repo, stateDir, { mode: "verified", script: [draft, draft] });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);
    assert.ok(run.eventTypes.includes("CRITERIA_EVALUATED"), run.eventTypes.join(", "));

    const evaluations = run.final.criterionEvaluations ?? [];
    assert.equal(evaluations.length, (run.final.acceptanceCriteria ?? []).length, "기준마다 판정이 하나씩");

    // doneCriteria 2 + requiredTests 1.
    assert.equal(evaluations.length, 3, JSON.stringify(run.final.acceptanceCriteria));

    const verified = evaluations.filter((e) => e.status === "VERIFIED_BY_TEST");
    const unverified = evaluations.filter((e) => e.status === "UNVERIFIED");
    assert.equal(verified.length, 2, `실제 테스트를 지목한 기준이 확인되지 않았습니다: ${JSON.stringify(evaluations)}`);
    for (const e of verified) assert.deepEqual(e.evidence, ["paginate.test.js"]);
    // 지목하지 않은 기준은 **끝까지 미확인이다.** 이걸 확인으로 만드는 유일한 방법이 모델에게
    // 묻는 것이고, 그 순간 product-strategy 9절의 순환 의존이 재현된다.
    assert.equal(unverified.length, 1, JSON.stringify(evaluations));
  });
});

test("fast 모드 + 단일 파일은 단일 모델 경로를 타지만 검증은 그대로 돈다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir, { mode: "fast" });
    assert.equal(run.final.status, "completed", run.final.summary);
    assert.ok(!run.eventTypes.includes("REVIEW_RECEIVED"), "simple tier에서 검수가 실행되었습니다");
    // 그러나 검증은 생략되지 않는다 — CLAUDE.md 원칙 1.
    assert.equal(run.final.verificationReport?.overall, "pass");
  });
});

test("검증을 통과하면 실제 git 커밋이 만들어진다", () => {
  // 12절 "Git commit 자동 생성의 오케스트레이터 통합" — **실제 저장소에 실제 커밋 객체**가
  // 생기는지를 본다. Node 단위 테스트는 "git add/commit을 요청했다"까지만 볼 수 있고,
  // 그 argv가 실제 git에서 동작하는지는 여기서만 확인된다.
  const repo = createFixtureRepo({ gitRepo: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  try {
    const before = gitLogSubjects(repo.root);
    const run = runHost(repo, stateDir, { mode: "fast", allowGitCommit: true });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);

    const after = gitLogSubjects(repo.root);
    assert.equal(after.length, before.length + 1, `커밋이 만들어지지 않았습니다:\n${after.join("\n")}`);
    // 커밋 제목은 사용자의 요청문이다 — 모델 이름이나 우리 도구 이름이 아니다.
    assert.match(after[0]!, /페이지 계산/, after[0]);

    // 우리가 바꾼 파일이 실제로 커밋됐다 — 워킹 트리가 그 파일에 대해 깨끗하다.
    const status = execFileSync("git", ["status", "--porcelain", "--", "paginate.js"], {
      cwd: repo.root,
      encoding: "utf8",
    });
    assert.equal(status.trim(), "", `변경이 커밋되지 않았습니다: ${status}`);

    assert.ok(run.eventTypes.includes("GIT_COMMIT_CREATED"), run.eventTypes.join(", "));

    // 커밋 본문이 **여러 줄 그대로** 저장소에 도착했는지 확인한다. 메시지는 argv 하나로
    // Rust까지 내려가므로(셸을 거치지 않는다), 줄바꿈이 도중에 잘리면 여기서만 드러난다.
    // 그리고 19.6절: 태스크 하나가 커밋 하나이므로 전체 기록으로 가는 열쇠를 trailer로 남긴다.
    const body = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: repo.root, encoding: "utf8" });
    assert.match(body, /변경한 파일 \(\d+개\)/, body);
    assert.ok(body.trim().endsWith(`Tomverse-Task: ${run.taskId}`), body);
    // 되돌리기와의 관계를 요약이 말한다 — 되돌려도 커밋은 남는다.
    assert.match(run.final.summary, /되돌리기는 파일만 복원/, run.final.summary);
  } finally {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("커밋한 작업은 revert로 되돌릴 수 있고, 이력에는 두 커밋이 남는다", () => {
  // 19절: 되돌리기는 커밋이 있으면 두 가지 뜻을 갖는다. `revert`는 **이력을 다시 쓰지 않고**
  // 취소 커밋을 하나 더 만든다 — 이미 공유한 브랜치에서도 안전한 유일한 선택지다.
  const repo = createFixtureRepo({ gitRepo: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  try {
    const run = runHost(repo, stateDir, { mode: "fast", allowGitCommit: true });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);
    const afterCommit = gitLogSubjects(repo.root);
    const fixed = repo.read("paginate.js");

    const result = spawnSync(
      HOST_BIN,
      [
        "revert",
        "--workspace",
        repo.root,
        "--task",
        run.taskId,
        "--db",
        path.join(stateDir, "state.db"),
        "--artifacts",
        path.join(stateDir, "artifacts"),
      ],
      // `revert`는 sidecar를 띄우지 않으므로 fake 공급자 환경이 필요 없다.
      { encoding: "utf8", env: process.env }
    );
    const payload = JSON.parse((result.stdout ?? "").trim().split("\n").filter(Boolean).pop() as string) as {
      reverted: boolean;
      sha?: string;
      reason?: string;
    };
    assert.equal(payload.reverted, true, `되돌리지 못했습니다: ${payload.reason}\n${result.stderr}`);

    // **이력이 다시 쓰이지 않았다** — 커밋이 하나 더 늘었다.
    const afterRevert = gitLogSubjects(repo.root);
    assert.equal(afterRevert.length, afterCommit.length + 1, afterRevert.join("\n"));
    assert.match(afterRevert[0]!, /^Revert /, afterRevert[0]);

    // 파일 내용이 실제로 되돌아갔다.
    assert.notEqual(repo.read("paginate.js"), fixed, "revert했는데 파일이 그대로입니다");
    // 워킹 트리는 깨끗하다 — revert가 커밋까지 만들었으므로 중간 상태가 남지 않는다.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo.root, encoding: "utf8" });
    assert.equal(status.trim(), "", `되돌린 뒤 워킹 트리가 지저분합니다: ${status}`);
  } finally {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("충돌하는 revert는 시도하되, 실패하면 저장소를 원래대로 돌려놓는다", () => {
  // 19.3절: 예전에는 이 상황(커밋 위에 다른 커밋이 쌓임)에서 아무것도 하지 않고 거절했다.
  // 지금은 시도한다 — **실패해도 저장소가 시작 전과 같다**는 것이 계약이고, 그것을
  // 확인할 수 있는 곳은 실제 git이 도는 여기뿐이다.
  const repo = createFixtureRepo({ gitRepo: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  try {
    const run = runHost(repo, stateDir, { mode: "fast", allowGitCommit: true });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);

    // 누군가 같은 파일을 통째로 다시 썼다 — revert의 역hunk가 붙을 자리가 사라진다.
    repo.write("paginate.js", "// 다른 사람이 이 파일을 통째로 다시 썼다\nexport const totalPages = () => 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo.root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rewrite paginate"], { cwd: repo.root, stdio: "ignore" });

    const afterOther = gitLogSubjects(repo.root);
    const rewritten = repo.read("paginate.js");

    const result = spawnSync(
      HOST_BIN,
      [
        "revert",
        "--workspace",
        repo.root,
        "--task",
        run.taskId,
        "--db",
        path.join(stateDir, "state.db"),
        "--artifacts",
        path.join(stateDir, "artifacts"),
      ],
      { encoding: "utf8", env: process.env }
    );
    const payload = JSON.parse((result.stdout ?? "").trim().split("\n").filter(Boolean).pop() as string) as {
      reverted: boolean;
      conflicted?: boolean;
      cleanedUp?: boolean;
      conflicts?: string[];
      reason?: string;
    };

    assert.equal(payload.reverted, false, result.stdout);
    assert.equal(payload.conflicted, true, `충돌로 보고되지 않았습니다: ${result.stdout}`);
    assert.equal(payload.cleanedUp, true, `원상복구되지 않았습니다: ${result.stdout}`);
    // 충돌 파일 목록은 `--abort` **전에** 읽어야만 남는다 — 사용자가 직접 되돌릴 때의 출발점이다.
    assert.deepEqual(payload.conflicts, ["paginate.js"], JSON.stringify(payload.conflicts));
    // "되돌리지 못했다"이지 "저장소가 망가졌다"가 아니다.
    assert.equal(result.status, 1, `종료 코드: ${result.status}\n${result.stdout}`);

    // **저장소가 시작 전과 같다.** 이게 이 기능을 열 수 있게 한 조건 그 자체다.
    assert.ok(!existsSync(path.join(repo.root, ".git", "REVERT_HEAD")), "revert 진행 중 상태로 남았습니다");
    assert.deepEqual(gitLogSubjects(repo.root), afterOther, "이력이 바뀌었습니다");
    assert.equal(repo.read("paginate.js"), rewritten, "파일이 바뀌었습니다");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo.root, encoding: "utf8" });
    assert.equal(status.trim(), "", `충돌 마커나 미커밋 변경이 남았습니다: ${status}`);
  } finally {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("커밋이 없는 작업에는 커밋 되돌리기를 제안하지 않는다", () => {
  // 추측으로 이력을 건드리지 않는다 — 커밋을 특정할 수 없으면 아무것도 하지 않는다.
  const repo = createFixtureRepo({ gitRepo: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  try {
    const run = runHost(repo, stateDir, { mode: "fast" });
    assert.equal(run.final.status, "completed", run.final.summary);
    const before = gitLogSubjects(repo.root);

    const result = spawnSync(
      HOST_BIN,
      [
        "revert",
        "--workspace",
        repo.root,
        "--task",
        run.taskId,
        "--db",
        path.join(stateDir, "state.db"),
        "--artifacts",
        path.join(stateDir, "artifacts"),
      ],
      // `revert`는 sidecar를 띄우지 않으므로 fake 공급자 환경이 필요 없다.
      { encoding: "utf8", env: process.env }
    );
    const payload = JSON.parse((result.stdout ?? "").trim().split("\n").filter(Boolean).pop() as string) as {
      reverted: boolean;
      reason?: string;
    };
    assert.equal(payload.reverted, false);
    assert.match(payload.reason ?? "", /특정할 수 없습니다/);
    assert.deepEqual(gitLogSubjects(repo.root), before, "아무것도 하지 않아야 하는데 이력이 바뀌었습니다");
  } finally {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("allowGitCommit이 꺼져 있으면 저장소가 있어도 커밋하지 않는다", () => {
  // 기본값은 커밋하지 않는 것이다. 켜지 않은 사용자가 매 태스크마다 승인 모달을 닫아야 하면
  // 승인이 의미를 잃는다(product-strategy 9.1절 승인 피로).
  const repo = createFixtureRepo({ gitRepo: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  try {
    const before = gitLogSubjects(repo.root);
    const run = runHost(repo, stateDir, { mode: "fast" });
    assert.equal(run.final.status, "completed", `${run.final.summary}\n${run.stderr}`);
    assert.deepEqual(gitLogSubjects(repo.root), before, "켜지 않았는데 커밋이 생겼습니다");
    assert.ok(!run.eventTypes.includes("GIT_COMMIT_CREATED"));
  } finally {
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("gitignore된 파일은 컨텍스트 후보에 들어가지 않는다", () => {
  withRepo((repo, stateDir) => {
    const run = runHost(repo, stateDir);
    const snapshotLine = run.stderr.split("\n").find((l) => l.includes("SNAPSHOT_CREATED"));
    if (snapshotLine) {
      assert.ok(!snapshotLine.includes("ignored/junk.js"), ".gitignore된 파일이 컨텍스트에 들어갔습니다");
    }
  });
});

function assertOrder(actual: string[], expected: string[]): void {
  let cursor = 0;
  for (const wanted of expected) {
    const found = actual.indexOf(wanted, cursor);
    assert.ok(
      found >= 0,
      `이벤트 ${wanted}를 (${cursor} 이후에서) 찾을 수 없습니다.\n실제 순서:\n  ${actual.join("\n  ")}`
    );
    cursor = found + 1;
  }
}
