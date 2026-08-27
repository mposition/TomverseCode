import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArtifacts, hostBinaryPath, sidecarEntryPath } from "@tomverse/toolchain";

/**
 * production 실행 경로 호출부.
 *
 * # 이 파일이 하는 일과 하지 않는 일
 *
 * 하는 일: `tomverse-host`를 실제 프로세스로 띄우고, arm 구성을 인자로 넘기고, 결과 JSON과
 * DB에 남은 이벤트를 읽는다.
 *
 * 하지 않는 일: **모델을 직접 부르지 않는다.** OpenAI/Anthropic 클라이언트를 새로 만들지 않고,
 * patch를 직접 적용하지 않고, Policy Gate를 우회하지 않는다. 그래서 이 실험이 측정하는 것은
 * "우리 제품이 실제로 얼마나 잘 하는가"이지 "우리가 만든 별도 파이프라인이 얼마나 잘 하는가"가 아니다.
 *
 * 이 구분이 이 게이트의 신뢰성 전부다. 여기서 지름길을 만들면 결과가 아무것도 말해주지 않는다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 컴파일 후 위치는 evals/hypothesis-gate/dist/src/ 이므로 리포지토리 루트까지 4단계. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// 경로 결정은 `@tomverse/toolchain` 한 곳에만 있다 — sidecar e2e와 같은 함수를 쓴다.
export const HOST_BIN = hostBinaryPath(REPO_ROOT, process.platform);
export const SIDECAR_ENTRY = sidecarEntryPath(REPO_ROOT);

export function artifactsPresent(): { ok: boolean; detail: string } {
  const status = checkArtifacts(REPO_ROOT, process.platform);
  return { ok: status.ok, detail: status.detail };
}

export interface HostRunOptions {
  workspaceRoot: string;
  taskPrompt: string;
  /**
   * 후보 공급자. **arm 자체가 아니라 arm의 축만 받는다** — 이 함수는 arm이라는 개념을 몰라도
   * 되고, TRIAGE 캘리브레이션처럼 arm이 없는 측정도 같은 실행 경로를 쓸 수 있어야 한다.
   */
  providers: string[];
  reviewMode?: "blind" | "informed";
  /**
   * 실행 모드. 기본은 `verified` — 가설 게이트의 모든 arm은 TRIAGE 결과와 무관하게
   * 교차검증 경로를 타야 하기 때문이다.
   *
   * `fast`를 주면 **TRIAGE 규칙이 실제로 판정한다.** 그 판정을 관측하는 것이
   * `triageCalibration`의 전부이며, 규칙은 모델을 부르지 않으므로 유료 호출이 없다.
   */
  executionMode?: "fast" | "verified";
  taskId: string;
  timeoutMs: number;
  /** Arm C/D가 재생할 초안. Rust가 이 파일을 읽어 sidecar에 내용만 넘긴다. */
  replayDraft?: unknown;
  /** fake provider 스크립트 (하네스 자동 테스트 전용). 실제 실험에서는 undefined다. */
  fakeScript?: unknown;
  /**
   * 실행할 호스트 바이너리 경로. **하네스 자동 테스트 전용이며 CLI로는 노출되지 않는다.**
   *
   * 있는 이유: 호스트가 뜨지 못했을 때의 경로(인프라 실패 → 비용 미측정 → 중단)를 검증하려면
   * 실패를 **결정론적으로** 만들 수 있어야 한다. 예전에는 그 실패를 "자격증명이 없으니 공급자
   * 후보가 비어 호스트가 거부한다"로 만들고 있었는데, 그건 검증이 **환경에 의존**한다는 뜻이다 —
   * 키가 있는 기계에서는 실제 호출이 성공해 테스트가 실패하고, 그 과정에서 **실제 돈이 나간다.**
   * 게이트를 돌리려면 반드시 키가 있어야 하므로 하필 그 환경에서만 그렇게 된다.
   */
  hostBin?: string;
  /** 모델 override — Model Registry의 축을 그대로 쓴다. 하드코딩하지 않는다. */
  executorModel?: string;
  reviewerModel?: string;
}

export interface HostRunResult {
  /** 프로세스 종료 코드. -1은 spawn 자체 실패. */
  exitCode: number;
  status: string;
  summary: string;
  failureReason?: string;
  taskId: string;
  mutatedPaths: string[];
  eventTypes: string[];
  dbPath: string;
  stderr: string;
  /** 프로세스를 띄우지도 못한 경우 — 인프라 실패로 분류된다. */
  spawnError?: string;
  wallClockMs: number;
}

/**
 * fake 실행에서 arm의 실제 공급자를 대신할 로컬 가짜 공급자.
 *
 * # 왜 필요한가 — fake 모드가 실제 돈을 쓸 수 있었다
 *
 * `host.rs`는 fake 모드에서 후보에 `fake-a/b/c`를 **더하기만** 하고, 그 다음 `--providers`가
 * 후보를 **좁힌다.** 그래서 arm A가 `--providers openai`를 주면 교집합이 `["openai"]`가 되어
 * 가짜 항목이 전부 탈락하고 **실제 `gpt-4.1`이 선택된다.** `TOMVERSE_FAKE_SCRIPT`는
 * `apiBaseUrl`이 `local://`인 항목에만 적용되므로(`providers/factory.ts`) 진짜 어댑터가 만들어져
 * 실제 요청이 나간다.
 *
 * 증상이 환경에 따라 갈려서 오래 보이지 않았다: 키가 없는 기계에서는 후보가 가짜뿐이라
 * 정상 동작하고, **키가 있는 기계에서만** 실제 호출이 된다. 그리고 게이트를 돌리려면
 * 반드시 키가 있어야 하므로, 하필 실행하려는 환경에서만 새어 나간다.
 *
 * 새는 것이 돈만이 아니다. fake 실행은 `--max-cost-usd`와 `--run-card`를 면제받고(`cli.ts`)
 * 예산 원장도 타지 않으므로, **유료 실행 안전장치 전체를 우회한 실제 호출**이 된다.
 * 게다가 그 기록은 `providerKind: "fake"`로 남는다.
 *
 * 그래서 "fake 실행"이라는 선언이 곧 "실제 공급자에 닿을 수 없다"가 되도록 여기서 이름을
 * 바꾼다. 공급자 **개수**는 그대로이므로 검수자 독립성 판단(단독 arm은 reviewer 드롭,
 * 교차검증 arm은 독립 reviewer 배정)도 그대로다 — arm의 의미는 바뀌지 않는다.
 *
 * `arms.ts`를 고치지 않는 이유: 그 파일의 공급자 이름은 비용 추정·attestation·preflight가
 * 함께 읽는 값이고, 그것들이 각자 fake를 다시 해석하면 반드시 갈라진다(`modelForRole` 주석).
 * 바꿔야 하는 것은 **이번 실행이 무엇에 닿는가** 하나뿐이라 호출 경계에서만 바꾼다.
 */
const FAKE_PROVIDER_FOR = Object.freeze<Record<string, string>>({
  openai: "fake-a",
  anthropic: "fake-b",
});

/**
 * fake 실행이면 실제 공급자 이름을 가짜 항목으로 바꾼다. 이미 가짜이거나 모르는 이름은
 * 그대로 둔다 — `triageCalibration`은 처음부터 `fake-a/fake-b`를 넘긴다.
 */
export function resolveProviderArgs(providers: readonly string[], usingFake: boolean): string[] {
  if (!usingFake) return [...providers];
  return providers.map((p) => FAKE_PROVIDER_FOR[p] ?? p);
}

/**
 * 실행. **arm 구성만 인자로 바뀌고 나머지는 production과 동일하다.**
 */
export function runHost(options: HostRunOptions): HostRunResult {
  const stateDir = mkdtempSync(path.join(tmpdir(), "gate-state-"));
  const dbPath = path.join(stateDir, "state.db");
  const args = [
    "run",
    "--workspace",
    options.workspaceRoot,
    "--message",
    options.taskPrompt,
    // 기본은 verified = TRIAGE 결과와 무관하게 항상 standard(교차검증) 경로.
    // arm A/B는 공급자가 하나뿐이라 라우터가 스스로 reviewer를 드롭한다 — 별도 분기가 아니다.
    "--mode",
    options.executionMode ?? "verified",
    "--approve",
    "auto",
    "--db",
    dbPath,
    "--artifacts",
    path.join(stateDir, "artifacts"),
    "--sidecar",
    SIDECAR_ENTRY,
    "--providers",
    resolveProviderArgs(options.providers, options.fakeScript !== undefined).join(","),
    "--timeout-secs",
    String(Math.ceil(options.timeoutMs / 1000)),
    // 파일 변경을 자동 승인한다: 이 실험은 승인 UX가 아니라 수정 품질을 측정한다.
    // Policy Gate는 그대로 지나며 workspace 경계와 allowlist는 유지된다.
    "--auto-approve-writes",
    "--verbose",
  ];
  if (options.reviewMode) args.push("--review-mode", options.reviewMode);

  if (options.replayDraft !== undefined) {
    const draftPath = path.join(stateDir, "replay-draft.json");
    writeFileSync(draftPath, JSON.stringify(options.replayDraft));
    args.push("--replay-draft", draftPath);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (options.fakeScript !== undefined) {
    env.TOMVERSE_FAKE_SCRIPT = JSON.stringify(options.fakeScript);
  }
  if (options.executorModel) env.TOMVERSE_EXECUTOR_MODEL = options.executorModel;
  if (options.reviewerModel) env.TOMVERSE_REVIEWER_MODEL = options.reviewerModel;

  const started = Date.now();
  const result = spawnSync(options.hostBin ?? HOST_BIN, args, {
    encoding: "utf8",
    // 호스트 자체 타임아웃보다 넉넉하게 — 호스트가 스스로 정리할 기회를 준다.
    timeout: options.timeoutMs + 60_000,
    env,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  const wallClockMs = Date.now() - started;
  const stderr = (result.stderr ?? "").slice(-20_000);

  if (result.error) {
    return {
      exitCode: -1,
      status: "failed",
      summary: result.error.message,
      taskId: options.taskId,
      mutatedPaths: [],
      eventTypes: [],
      dbPath,
      stderr,
      spawnError: result.error.message,
      wallClockMs,
    };
  }

  const jsonLine = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!jsonLine) {
    return {
      exitCode: result.status ?? -1,
      status: "failed",
      summary: "호스트가 결과 JSON을 출력하지 않았습니다",
      taskId: options.taskId,
      mutatedPaths: [],
      eventTypes: [],
      dbPath,
      stderr,
      spawnError: "no_stdout_json",
      wallClockMs,
    };
  }

  let parsed: {
    final?: { status?: string; summary?: string; failureReason?: string };
    mutatedPaths?: string[];
    eventTypes?: string[];
    taskId?: string;
  };
  try {
    parsed = JSON.parse(jsonLine);
  } catch (error) {
    return {
      exitCode: result.status ?? -1,
      status: "failed",
      summary: `결과 JSON 파싱 실패: ${String(error)}`,
      taskId: options.taskId,
      mutatedPaths: [],
      eventTypes: [],
      dbPath,
      stderr,
      spawnError: "unparseable_stdout",
      wallClockMs,
    };
  }

  const out: HostRunResult = {
    exitCode: result.status ?? -1,
    status: parsed.final?.status ?? "failed",
    summary: parsed.final?.summary ?? "",
    taskId: parsed.taskId ?? options.taskId,
    mutatedPaths: parsed.mutatedPaths ?? [],
    eventTypes: parsed.eventTypes ?? [],
    dbPath,
    stderr,
    wallClockMs,
  };
  if (parsed.final?.failureReason) out.failureReason = parsed.final.failureReason;
  return out;
}

export interface StoredEvent {
  eventId: number;
  seq: number;
  type: string;
  phase: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * 실행이 끝난 뒤 DB에서 이벤트를 읽는다.
 *
 * **새 프로세스가 DB만 열어서 읽는다** — 실행 중 메모리에 있던 값을 재사용하지 않는다.
 * 그래야 "기록이 실제로 남았는가"까지 함께 확인된다.
 */
export function readEvents(dbPath: string, workspaceRoot: string, taskId: string): StoredEvent[] {
  const result = spawnSync(
    HOST_BIN,
    ["show", "--workspace", workspaceRoot, "--task", taskId, "--db", dbPath],
    { encoding: "utf8", shell: false, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }
  );
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!line) return [];
  try {
    const parsed = JSON.parse(line) as { events?: StoredEvent[] };
    return parsed.events ?? [];
  } catch {
    return [];
  }
}

/** 이벤트에서 특정 타입의 마지막 payload를 꺼낸다. */
export function lastPayload(events: readonly StoredEvent[], type: string): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === type) return events[i]!.payload;
  }
  return undefined;
}

export function allPayloads(events: readonly StoredEvent[], type: string): Record<string, unknown>[] {
  return events.filter((e) => e.type === type).map((e) => e.payload);
}
