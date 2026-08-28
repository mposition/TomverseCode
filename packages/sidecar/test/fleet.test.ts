import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepo, FIX_PATCH, type FixtureRepo } from "./helpers/fixtureRepo.js";
import { checkArtifacts, hostBinaryPath, sidecarEntryPath } from "@tomverse/toolchain";

/**
 * Fleet end-to-end — **여러 프로세스가 실제로 동시에 돈다**는 것이 이 기능의 핵심이고,
 * 그 사실은 단위 테스트로는 잡히지 않는다.
 *
 * 여기서 진짜인 것: 실제 `tomverse-host`, 실제 git worktree N개, 구성원마다 실제 sidecar
 * 프로세스, 실제 `npm test`, 실제 SQLite. 가짜인 것은 LLM 응답 하나뿐이다.
 *
 * # 판정의 분담
 *
 * 순수한 규칙(합계 예산의 예약·고갈, 크기 상한, 검증 레인의 배타성)은 Rust 단위 테스트가
 * 지킨다 — 거기서는 조건을 만들 수 있기 때문이다. 여기서 지키는 것은 **그 규칙이 실제
 * 바이너리에 꽂혀 있는가**이다. 규칙이 있는데 꽂히지 않은 상태는 단위 테스트만으로 통과한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HOST_BIN = hostBinaryPath(REPO_ROOT, process.platform);
const SIDECAR_ENTRY = sidecarEntryPath(REPO_ROOT);

interface MemberReport {
  index: number;
  branch: string;
  taskId: string;
  admitted: boolean;
  worktreePath?: string;
  status: string;
  summary: string;
  costUsd: number;
  reservedUsd?: number;
  startedAt?: string;
  finishedAt?: string;
}

interface FleetRun {
  exitCode: number;
  stderr: string;
  fleet: {
    fleetId: string;
    members: MemberReport[];
    totals: {
      members: number;
      completed: number;
      failed: number;
      cancelled: number;
      rejected: number;
      notStarted: number;
      fleetCostUsd: number;
      fleetCapUsd?: number;
      perTaskCapUsd?: number;
      capEnforced: boolean;
    };
    verificationLane: { acquisitions: number; contended: number; totalWaitMs: number };
  };
  dbPath: string;
}

interface FleetOptions {
  members: { branch: string; message: string }[];
  fleetBudgetUsd?: number;
  /** 생략하면 `--fleet-budget-unlimited`를 준다. 아예 아무것도 주지 않으려면 `none`. */
  budgetMode?: "unlimited" | "none";
  perTaskBudgetUsd?: number;
  cancelFleetAfterMs?: number;
  cancelMemberAfterMs?: { branch: string; ms: number }[];
  timeoutSecs?: number;
}

function requireArtifacts(): void {
  const artifacts = checkArtifacts(REPO_ROOT, process.platform);
  assert.ok(artifacts.ok, artifacts.detail);
}

function fleetArgs(repo: FixtureRepo, stateDir: string, options: FleetOptions): string[] {
  const args = [
    "fleet",
    "--workspace",
    repo.root,
    "--mode",
    "fast",
    "--approve",
    "auto",
    "--db",
    path.join(stateDir, "state.db"),
    "--artifacts",
    path.join(stateDir, "artifacts"),
    "--sidecar",
    SIDECAR_ENTRY,
    "--timeout-secs",
    String(options.timeoutSecs ?? 180),
  ];
  for (const member of options.members) args.push("--member", `${member.branch}=${member.message}`);
  if (options.fleetBudgetUsd !== undefined) args.push("--fleet-budget-usd", String(options.fleetBudgetUsd));
  else if ((options.budgetMode ?? "unlimited") === "unlimited") args.push("--fleet-budget-unlimited");
  if (options.perTaskBudgetUsd !== undefined) args.push("--budget-usd", String(options.perTaskBudgetUsd));
  if (options.cancelFleetAfterMs !== undefined)
    args.push("--cancel-fleet-after-ms", String(options.cancelFleetAfterMs));
  for (const one of options.cancelMemberAfterMs ?? [])
    args.push("--cancel-member-after-ms", `${one.branch}=${one.ms}`);
  return args;
}

function spawnFleet(repo: FixtureRepo, stateDir: string, options: FleetOptions) {
  requireArtifacts();
  return spawnSync(HOST_BIN, fleetArgs(repo, stateDir, options), {
    encoding: "utf8",
    timeout: (options.timeoutSecs ?? 180) * 1000 + 60_000,
    env: {
      ...process.env,
      TOMVERSE_FAKE_SCRIPT: JSON.stringify({ defaultPatch: FIX_PATCH }),
      TOMVERSE_EXECUTOR_MODEL: "fake-executor",
      TOMVERSE_REVIEWER_MODEL: "fake-reviewer",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
  });
}

function runFleet(repo: FixtureRepo, stateDir: string, options: FleetOptions): FleetRun {
  const result = spawnFleet(repo, stateDir, options);
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  assert.ok(line, `Fleet 결과 JSON이 없습니다.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const parsed = JSON.parse(line) as Omit<FleetRun, "exitCode" | "stderr">;
  return { ...parsed, exitCode: result.status ?? -1, stderr: result.stderr ?? "" };
}

function hostQuery(stateDir: string, args: string[]): Record<string, unknown> {
  const raw = execFileSync(
    HOST_BIN,
    [...args, "--db", path.join(stateDir, "state.db"), "--artifacts", path.join(stateDir, "artifacts")],
    { encoding: "utf8" }
  );
  return JSON.parse(raw.trim().split("\n").pop() as string) as Record<string, unknown>;
}

function withRepo(
  fn: (repo: FixtureRepo, stateDir: string) => void,
  options: { slowTest?: boolean } = {}
): void {
  const repo = createFixtureRepo({ gitRepo: true, slowTest: options.slowTest });
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-fleet-"));
  try {
    fn(repo, stateDir);
  } finally {
    // worktree가 저장소를 참조하므로 트리를 먼저 떼어낸다 — 남기면 다음 테스트의 `git worktree
    // list`에 유령이 남는다(같은 저장소를 쓰지는 않지만, 정리 순서를 규칙으로 둔다).
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repo.root, stdio: "ignore" });
    } catch {
      /* 픽스처 정리 실패가 판정을 바꾸지 않는다 */
    }
    repo.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 두 구간이 겹치는가 — "실제로 동시에 돌았다"의 판정 기준. */
function overlaps(a: MemberReport, b: MemberReport): boolean {
  const s = (v?: string): number => (v ? Date.parse(v) : NaN);
  return s(a.startedAt) < s(b.finishedAt) && s(b.startedAt) < s(a.finishedAt);
}

const THREE = [
  { branch: "fleet-a", message: "paginate.js 의 페이지 계산이 한 칸 밀려 있습니다. 고쳐주세요." },
  { branch: "fleet-b", message: "paginate.js 의 오프바이원을 고쳐주세요." },
  { branch: "fleet-c", message: "1페이지가 첫 항목부터 나오게 고쳐주세요." },
];

// ---- ① 격리: N개가 서로 다른 트리에서 돌고 본체는 바뀌지 않는다 ----

test("[Fleet] N개가 서로 다른 worktree에서 동시에 돌고 본체 파일은 바뀌지 않는다", () => {
  withRepo((repo, stateDir) => {
    const before = repo.read("paginate.js");
    const run = runFleet(repo, stateDir, { members: THREE });

    assert.equal(run.exitCode, 0, `Fleet이 완료되지 않았습니다:\n${run.stderr.slice(-4000)}`);
    assert.equal(run.fleet.totals.completed, 3, JSON.stringify(run.fleet.totals));

    // 1) 트리가 셋이고 서로 다르다. 같으면 격리가 아니다.
    const paths = run.fleet.members.map((m) => m.worktreePath);
    assert.equal(new Set(paths).size, 3, `트리가 겹칩니다: ${paths.join(", ")}`);

    // 2) **본체는 한 글자도 바뀌지 않았다.** 이것이 격리의 판정 기준이고, 동시에 Policy Gate의
    //    원래 규칙("이 루트를 벗어날 수 없다")이 그대로 지켜졌다는 확인이기도 하다.
    assert.equal(repo.read("paginate.js"), before, "본체 파일이 바뀌었습니다 — 격리가 아닙니다");

    // 3) 결과는 각자의 트리에 있다.
    for (const member of run.fleet.members) {
      const file = path.join(member.worktreePath as string, "paginate.js");
      assert.ok(existsSync(file), `${member.branch}의 트리에 파일이 없습니다: ${file}`);
      assert.match(readFileSync(file, "utf8"), /\(page - 1\)/, `${member.branch}가 고치지 않았습니다`);
    }

    // 4) **실제로 동시에 돌았다.** 순차로 돌았다면 구간이 하나도 겹치지 않는다.
    const [a, b, c] = run.fleet.members;
    assert.ok(
      overlaps(a!, b!) || overlaps(b!, c!) || overlaps(a!, c!),
      `구성원 실행 구간이 하나도 겹치지 않습니다 — 병렬이 아닙니다: ${JSON.stringify(
        run.fleet.members.map((m) => [m.branch, m.startedAt, m.finishedAt])
      )}`
    );

    // 5) 승인 요청이 **어느 트리의 것인지** 실려 나갔다(11.6①). 경로만으로는 화면에서
    //    `tomverse-fleet-a`와 `tomverse-fleet-b`가 구별되지 않는다.
    assert.match(run.stderr, /"origin":\{[^}]*"branch":"fleet-[abc]"/, "승인 요청에 출처가 없습니다");
  });
});

// ---- ② 크기 상한 (원칙 5) ----

test("[Fleet] 크기 상한을 넘으면 아무것도 시작하지 않는다", () => {
  withRepo((repo, stateDir) => {
    const members = Array.from({ length: 9 }, (_, i) => ({ branch: `big-${i}`, message: "고쳐주세요" }));
    const result = spawnFleet(repo, stateDir, { members });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr ?? "", /Fleet 크기 상한/, result.stderr ?? "");

    // **아무것도 만들지 않았다.** 세 번째에서 멈추면 사용자가 절반짜리 Fleet을 수습해야 한다.
    const list = hostQuery(stateDir, ["worktree", "--workspace", repo.root]) as {
      worktrees: { path: string }[];
    };
    assert.equal(list.worktrees.length, 0, `트리가 만들어졌습니다: ${JSON.stringify(list.worktrees)}`);
  });
});

// ---- ③ 합계 예산이 태스크당 상한과 **별개로** 강제된다 ----

test("[Fleet] 합계 상한은 태스크당 상한과 별개이며, 별개라는 사실이 강제된다", () => {
  withRepo((repo, stateDir) => {
    // 1) **합계 상한만으로는 성립하지 않는다.** 태스크당 상한이 없으면 예약할 금액을 모르고,
    //    그러면 "합계 상한이 있다"는 말이 거짓이 된다.
    const unbounded = spawnFleet(repo, stateDir, { members: THREE, fleetBudgetUsd: 5 });
    assert.notEqual(unbounded.status, 0);
    assert.match(unbounded.stderr ?? "", /태스크당 상한도 있어야/, unbounded.stderr ?? "");

    // 2) 합계가 태스크당보다 작으면 **시작 전에** 거부한다.
    const tooSmall = spawnFleet(repo, stateDir, {
      members: THREE,
      fleetBudgetUsd: 0.5,
      perTaskBudgetUsd: 1,
    });
    assert.notEqual(tooSmall.status, 0);
    assert.match(tooSmall.stderr ?? "", /어떤 구성원도 시작할 수 없습니다/, tooSmall.stderr ?? "");

    // 3) **말하지 않은 것을 "상한 없음"으로 읽지 않는다**(budget.rs와 같은 규칙).
    const silent = spawnFleet(repo, stateDir, { members: THREE, budgetMode: "none" });
    assert.notEqual(silent.status, 0);
    assert.match(silent.stderr ?? "", /Fleet 합계 상한/, silent.stderr ?? "");
  });
});

test("[Fleet] 합계 상한이 남지 않으면 다음 구성원이 시작되지 않는다 (동시에 하나만 예약된다)", () => {
  withRepo((repo, stateDir) => {
    // 합계 $1.00 / 태스크당 $0.60 → 예약은 한 번에 하나뿐이다. 두 번째 구성원은 첫 번째가
    // 정산될 때까지 **시작되지 않는다.**
    //
    // **왜 여기서 "고갈"까지 보지 않는가**: fake 공급자의 비용은 0이 정상이다(레지스트리가
    // 그렇게 정했고, 그래야 "0달러 썼다"가 언제나 통과하지 않는다). 확정 지출이 늘지 않으므로
    // 이 경로로는 상한을 소진시킬 수 없다 — **고갈 시 미시작**은 `fleet.rs`의 단위 테스트가
    // 지킨다. 여기서 확인하는 것은 그 판정이 실제 바이너리에 꽂혀 있다는 것이다.
    const run = runFleet(repo, stateDir, {
      members: THREE,
      fleetBudgetUsd: 1,
      perTaskBudgetUsd: 0.6,
    });
    assert.equal(run.exitCode, 0, `Fleet이 완료되지 않았습니다:\n${run.stderr.slice(-4000)}`);
    assert.equal(run.fleet.totals.capEnforced, true);
    assert.equal(run.fleet.totals.fleetCapUsd, 1);
    assert.equal(run.fleet.totals.perTaskCapUsd, 0.6);

    // 예약이 실제로 걸렸다 — 걸리지 않았으면 상한은 사후 검사일 뿐이다.
    for (const member of run.fleet.members) assert.equal(member.reservedUsd, 0.6);

    // **어느 두 구성원도 겹치지 않는다.** 태스크당 상한만으로는 이런 제약이 생기지 않으므로,
    // 이 사실이 곧 "합계 상한이 별개로 강제된다"의 관측 근거다.
    const members = run.fleet.members;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        assert.ok(
          !overlaps(members[i]!, members[j]!),
          `합계 상한이 하나만 허용하는데 ${members[i]!.branch}와 ${members[j]!.branch}가 동시에 돌았습니다`
        );
      }
    }
  });
});

// ---- ④ 부분 실패: 하나가 실패해도 나머지가 돌고, 결말이 개별로 보고된다 ----

test("[Fleet] 하나가 실패해도 나머지는 계속 돌고 결말은 개별로 보고된다", () => {
  withRepo((repo, stateDir) => {
    // 본체가 이미 체크아웃하고 있는 브랜치로는 worktree를 만들 수 없다(git이 거부한다).
    // **실제로 일어나는 실패**이며, 하나가 실패했을 때 나머지가 어떻게 되는지 볼 수 있다.
    const busy = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo.root,
      encoding: "utf8",
    }).trim();
    const run = runFleet(repo, stateDir, {
      members: [
        { branch: "ok-1", message: "고쳐주세요" },
        { branch: busy, message: "고쳐주세요" },
        { branch: "ok-2", message: "고쳐주세요" },
      ],
    });

    // **부분 실패를 성공으로 접지 않는다.**
    assert.notEqual(run.exitCode, 0, "일부가 실패했는데 성공으로 끝났습니다");
    assert.equal(run.fleet.totals.members, 3);
    assert.equal(run.fleet.totals.completed, 2, JSON.stringify(run.fleet.totals));
    assert.equal(run.fleet.totals.failed, 1, JSON.stringify(run.fleet.totals));

    // 결말이 **구성원별로** 있다. 합계만 있으면 어느 것이 실패했는지 알 수 없다.
    const byBranch = new Map(run.fleet.members.map((m) => [m.branch, m]));
    assert.equal(byBranch.get(busy)?.status, "failed");
    assert.equal(byBranch.get("ok-1")?.status, "completed");
    assert.equal(byBranch.get("ok-2")?.status, "completed");

    // 실패한 하나 때문에 나머지의 결과가 사라지지 않았다.
    for (const branch of ["ok-1", "ok-2"]) {
      const file = path.join(byBranch.get(branch)!.worktreePath as string, "paginate.js");
      assert.match(readFileSync(file, "utf8"), /\(page - 1\)/);
    }
  });
});

// ---- ⑤ 취소: 전체와 하나는 다른 요청이다 ----

test("[Fleet] 전체 취소가 모든 구성원에 닿고 프로세스 트리가 죽는다", () => {
  withRepo(
    (repo, stateDir) => {
      const run = runFleet(repo, stateDir, {
        members: THREE.slice(0, 2),
        cancelFleetAfterMs: 4000,
        timeoutSecs: 120,
      });

      // **전부** 취소로 끝났다. 하나라도 completed면 취소가 그 구성원에 닿지 않은 것이다.
      assert.equal(run.fleet.totals.cancelled, 2, `${JSON.stringify(run.fleet.totals)}\n${run.stderr.slice(-3000)}`);
      assert.equal(run.fleet.totals.completed, 0);
      assert.notEqual(run.exitCode, 0, "취소로 끝났는데 성공으로 보고했습니다");

      // 느린 테스트가 띄운 손자 프로세스가 실제로 죽었다(proctree.rs). 검증은 직렬화되므로
      // 그 시점에 레인 안에 있던 구성원만 pid 파일을 남긴다 — **남긴 것은 전부 죽어 있어야 한다.**
      let checked = 0;
      for (const member of run.fleet.members) {
        const pidFile = path.join(member.worktreePath as string, "slow-test.pid");
        if (!existsSync(pidFile)) continue;
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        assert.ok(Number.isInteger(pid) && pid > 0, `PID를 읽을 수 없습니다: ${pid}`);
        assert.ok(!isAlive(pid), `취소 후에도 ${member.branch}의 자식 ${pid}가 살아 있습니다`);
        checked += 1;
      }
      assert.ok(checked >= 1, "취소 대상 프로세스가 하나도 없었습니다 — 시나리오가 성립하지 않습니다");
    },
    { slowTest: true }
  );
});

test("[Fleet] 전체 취소는 아직 시작하지 않은 구성원에도 닿는다", () => {
  withRepo(
    (repo, stateDir) => {
      // 합계 상한이 **한 번에 하나만** 허용하므로 셋째는 취소 시점에 아직 대기열에 있다.
      // 도는 것만 멈추고 대기열을 그대로 두면, 취소를 누른 **뒤에** 새 태스크가 시작된다 —
      // 사용자가 요청한 것의 정반대다.
      const run = runFleet(repo, stateDir, {
        members: THREE,
        fleetBudgetUsd: 1,
        perTaskBudgetUsd: 0.6,
        cancelFleetAfterMs: 3000,
        timeoutSecs: 120,
      });

      assert.equal(run.fleet.totals.completed, 0, `${JSON.stringify(run.fleet.totals)}`);
      // 시작하지 못한 구성원이 있고, 그 사유가 **예산이 아니라 취소**다.
      const unstarted = run.fleet.members.filter((m) => m.status === "not_started");
      assert.ok(unstarted.length >= 1, `대기 중이던 구성원이 없습니다: ${JSON.stringify(run.fleet.members)}`);
      for (const member of unstarted) {
        assert.match(member.summary, /취소/, member.summary);
        // 시작하지 않았으므로 격리 트리도 만들지 않는다.
        assert.equal(member.worktreePath, undefined);
      }
      // **미시작을 실패로 세지 않는다** — 사용자가 다음에 할 일이 다르다.
      assert.equal(run.fleet.totals.failed, 0, JSON.stringify(run.fleet.totals));
    },
    { slowTest: true }
  );
});

test("[Fleet] 구성원 하나의 취소는 Fleet 전체의 취소가 아니다", () => {
  withRepo((repo, stateDir) => {
    const run = runFleet(repo, stateDir, {
      members: THREE,
      cancelMemberAfterMs: [{ branch: "fleet-b", ms: 150 }],
      timeoutSecs: 120,
    });

    const byBranch = new Map(run.fleet.members.map((m) => [m.branch, m.status]));
    assert.equal(byBranch.get("fleet-b"), "cancelled", JSON.stringify([...byBranch]));
    // **나머지는 계속 돈다.** 하나를 취소하는 것과 전체를 취소하는 것이 같은 일이면
    // 사용자는 하나를 멈출 방법을 잃는다.
    assert.equal(byBranch.get("fleet-a"), "completed", JSON.stringify([...byBranch]));
    assert.equal(byBranch.get("fleet-c"), "completed", JSON.stringify([...byBranch]));
  });
});

// ---- ⑥ 검증 직렬화 ----

test("[Fleet] 검증이 레인을 지나며, 동시에 도는 구성원들이 실제로 그 레인에서 기다린다", () => {
  withRepo((repo, stateDir) => {
    const run = runFleet(repo, stateDir, { members: THREE });
    const lane = run.fleet.verificationLane;

    // **레인을 지나지 않은 검증이 없다.** 구성원 셋이 각각 `VERIFYING`을 지나므로 최소 3이다.
    assert.ok(
      lane.acquisitions >= run.fleet.totals.members,
      `검증이 레인을 지나지 않았습니다: ${JSON.stringify(lane)}`
    );
    // 셋이 동시에 도는데 경합이 0이면, 레인이 실제로 잠그고 있지 않거나 병렬이 아니다.
    // (배타성 자체는 `verify.rs`의 단위 테스트가 겹침으로 판정한다.)
    assert.ok(lane.contended >= 1, `검증 경합이 관측되지 않았습니다: ${JSON.stringify(lane)}`);
  });
});

// ---- ⑦ 기록: 크래시 후 "무엇이 돌고 있었나"에 답할 수 있다 ----

test("[Fleet] Fleet 단위 상태가 task_events에 남아 새 프로세스가 답할 수 있다", () => {
  withRepo((repo, stateDir) => {
    const run = runFleet(repo, stateDir, { members: THREE });

    // **새 프로세스가 DB만 열어서** 답한다 — 메모리에 들고 있었다면 여기서 아무것도 나오지 않는다.
    const status = hostQuery(stateDir, [
      "fleet-status",
      "--workspace",
      repo.root,
      "--fleet",
      run.fleet.fleetId,
    ]) as {
      members: { branch: string; taskId: string; fleetId: string; finalStatus: string | null; admitted: boolean }[];
      fleetCostUsd: number;
      unfinishedTaskIds: string[];
    };

    assert.equal(status.members.length, 3, JSON.stringify(status.members));
    assert.deepEqual(
      status.members.map((m) => m.branch).sort(),
      ["fleet-a", "fleet-b", "fleet-c"]
    );
    for (const member of status.members) {
      assert.equal(member.fleetId, run.fleet.fleetId);
      assert.equal(member.admitted, true);
      assert.equal(member.finalStatus, "COMPLETED");
    }
    // 끝났으므로 "돌고 있던 것"은 없다. 크래시했다면 여기 남는다.
    assert.deepEqual(status.unfinishedTaskIds, []);
    // **합계는 합계라고 부른다.** 태스크 하나의 지출과 같은 이름이면 화면이 둘을 구별할 수 없다.
    assert.equal(typeof status.fleetCostUsd, "number");
  });
});
