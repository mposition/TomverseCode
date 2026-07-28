import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CommandArgv } from "./types.js";

/**
 * oracle 실행기 — **이 실험의 측정 도구**다.
 *
 * # 왜 Rust Verification Runner를 쓰지 않는가
 *
 * 제품의 Verification Runner는 "모델이 만든 변경이 프로젝트의 공개 검증을 통과하는가"를 판정한다.
 * oracle은 다른 것을 판정한다: **우리가 숨겨둔 진짜 불변식을 만족하는가.** 이건 제품의 관심사가
 * 아니라 실험자의 관심사이고, 제품 경로에 넣으면 "제품이 정답을 알고 있다"는 잘못된 구조가 된다.
 *
 * 그래서 oracle은 하네스가 직접 돌린다. 다만 규율은 그대로 지킨다:
 *  - **argv만 실행한다** — 셸 문자열을 만들지 않는다(`shell: false`가 기본이다)
 *  - cwd는 workspace 안으로 제한한다
 *  - 출력은 상한을 두고 자른다 — 무제한 stdout을 결과 파일에 남기지 않는다
 *  - 테스트 러너 제어 환경변수를 제거한다 (아래 상세)
 *  - API 키를 자식에게 물려주지 않는다
 *
 * # oracle이 판정자인 이유
 *
 * 모델의 verdict("이 patch는 옳다")는 성공 판정에 쓰지 않는다. 그건 측정 대상이 스스로
 * 점수를 매기는 것이다. oracle 명령의 종료 코드만 본다.
 */

/** 결과 파일에 남길 출력의 상한. 무제한 stdout을 저장하지 않는다(§3). */
const MAX_CAPTURED_OUTPUT = 4_000;

/**
 * 자식에게 물려주지 않는 환경변수.
 *
 * - `NODE_TEST_CONTEXT` 등: 설정된 셸에서 `node --test`를 돌리면 **실패해도 exit 0**이 된다.
 *   그러면 oracle이 실패를 통과로 보고한다 — 이 실험 전체를 무의미하게 만드는 종류의 버그다.
 *   Tool Runtime이 같은 변수를 제거하는 것과 같은 이유다(state-machine-and-protocol.md 15.4절).
 * - API 키: fixture의 테스트 코드가 우연히든 의도적으로든 키를 읽어 출력할 수 있다.
 *   oracle 출력은 결과 파일에 남으므로 애초에 물려주지 않는다.
 */
const STRIPPED_ENV = [
  "NODE_TEST_CONTEXT",
  "NODE_OPTIONS",
  "NODE_V8_COVERAGE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TOMVERSE_OPENAI_API_KEY",
  "TOMVERSE_ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

export interface CommandOutcome {
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  /** 상한까지 자른 출력. 실패 원인 분류에만 쓴다. */
  output: string;
  durationMs: number;
}

export interface VerificationOutcome {
  passed: boolean;
  commands: CommandOutcome[];
  /** 하네스 자체가 실패한 경우 (명령을 실행조차 못 함) — 모델 실패로 세면 안 된다. */
  harnessError?: string;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  // 색상 코드가 출력 비교/저장을 오염시키지 않게 한다.
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

export function runCommand(command: CommandArgv, workspaceRoot: string, timeoutMs: number): CommandOutcome {
  const cwd = command.cwd ? path.join(workspaceRoot, command.cwd) : workspaceRoot;
  const started = Date.now();
  const result = spawnSync(command.program, command.args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: childEnv(),
    // 명시적으로 끈다: 셸을 거치면 argv 계약이 깨지고, 인자가 셸에 해석될 수 있다.
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, MAX_CAPTURED_OUTPUT);

  return {
    command: `${command.program} ${command.args.join(" ")}`.trim(),
    exitCode: result.status,
    // 실행 자체가 실패했으면(바이너리 없음 등) 통과가 아니다.
    passed: result.error === undefined && result.status === 0,
    timedOut,
    output: result.error !== undefined ? `${output}\n[하네스] 실행 오류: ${result.error.message}` : output,
    durationMs,
  };
}

/**
 * 명령들을 순서대로 실행한다. **하나라도 실패하면 전체 실패.**
 *
 * 첫 실패에서 멈추지 않고 전부 돌리는 이유: 무엇이 왜 실패했는지 분류하려면 모든 결과가 필요하다.
 * 다만 타임아웃이 발생하면 그 뒤는 돌리지 않는다 — 이미 시간 예산을 초과한 상태다.
 */
export function runVerification(
  commands: readonly CommandArgv[],
  workspaceRoot: string,
  timeoutMs: number
): VerificationOutcome {
  if (commands.length === 0) {
    return { passed: false, commands: [], harnessError: "실행할 검증 명령이 없습니다" };
  }
  const outcomes: CommandOutcome[] = [];
  for (const command of commands) {
    const outcome = runCommand(command, workspaceRoot, timeoutMs);
    outcomes.push(outcome);
    if (outcome.timedOut) break;
  }
  return { passed: outcomes.length === commands.length && outcomes.every((o) => o.passed), commands: outcomes };
}

/**
 * oracle 실패의 원인을 분류한다.
 *
 * 여기서 하는 것은 **분류**이고 판정이 아니다. 통과/실패는 이미 종료 코드로 정해졌다.
 * 분류는 리포트에서 "무엇이 왜 실패했나"를 읽을 수 있게 하려는 것뿐이다.
 */
export function classifyOracleFailure(outcome: VerificationOutcome): string | undefined {
  if (outcome.passed) return undefined;
  if (outcome.harnessError) return "oracle_harness_failure";
  const failed = outcome.commands.find((c) => !c.passed);
  if (!failed) return "oracle_harness_failure";
  if (failed.timedOut) return "network_timeout";
  // 컴파일/타입 오류는 "고치려다 깨뜨린 것"이므로 잘못된 patch다.
  if (/error TS\d+|error\[E\d+]|SyntaxError|cannot find module|error: could not compile/i.test(failed.output)) {
    return "wrong_patch";
  }
  if (/assert|expected|AssertionError|panicked at/i.test(failed.output)) return "requirement_unmet";
  return "incomplete_fix";
}
