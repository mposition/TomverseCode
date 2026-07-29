import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  clearMsvcCache,
  interpretMsvcOutcome,
  msvcEnvScriptPath,
  MSVC_ENV_ALLOWLIST,
  needsNativeToolchain,
  parseMsvcEnv,
  prepareMsvcEnv,
  shellExecutablePath,
  withMsvcEnv,
  type ScriptRunner,
} from "../src/msvc.js";

/**
 * 회귀 테스트 4·5·6 — MSVC 환경 준비.
 *
 * 실행기를 주입하므로 **Linux에서도 Windows 분기를 전부 검증한다.**
 * (실제 `cmd.exe` 실행은 이 환경에서 불가능하고, 그건 보고서에 미검증으로 남긴다.)
 */

const REPO = path.join(path.sep, "repo");
const SCRIPT = msvcEnvScriptPath(REPO);

function runnerReturning(outcome: { status: number | null; stdout?: string; stderr?: string }): ScriptRunner {
  return () => ({ status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
}

const GOOD_STDOUT = [
  "TOMVERSE_MSVC_OK=1",
  "PATH=C:\\VS\\bin;C:\\Windows\\system32",
  "INCLUDE=C:\\VS\\include;C:\\SDK\\ucrt",
  "LIB=C:\\VS\\lib\\x64;C:\\SDK\\um\\x64",
  "LIBPATH=C:\\VS\\lib\\x64",
  "VSCMD_ARG_TGT_ARCH=x64",
].join("\r\n");

test("비 Windows에서는 아무것도 하지 않는다", () => {
  clearMsvcCache();
  let called = false;
  const runner: ScriptRunner = () => {
    called = true;
    return { status: 0, stdout: "", stderr: "" };
  };
  for (const platform of ["linux", "darwin"] as const) {
    const result = prepareMsvcEnv(REPO, platform, runner, { useCache: false });
    assert.equal(result.kind, "not_needed");
  }
  assert.equal(called, false, "비 Windows에서 배치를 실행했습니다");
});

test("Windows에서 준비에 성공하면 환경을 돌려준다", () => {
  clearMsvcCache();
  const result = prepareMsvcEnv(REPO, "win32", runnerReturning({ status: 0, stdout: GOOD_STDOUT }), {
    useCache: false,
  });
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.ok(result.env.INCLUDE?.includes("ucrt"));
  assert.ok(result.env.LIB?.includes("x64"));
  assert.equal(result.env.VSCMD_ARG_TGT_ARCH, "x64");
});

test("고정된 프로그램과 argv로만 실행한다 (셸 문자열 조합 없음)", () => {
  clearMsvcCache();
  let seen: { program: string; args: readonly string[] } | undefined;
  const runner: ScriptRunner = (program, args) => {
    seen = { program, args };
    return { status: 0, stdout: GOOD_STDOUT, stderr: "" };
  };
  prepareMsvcEnv(REPO, "win32", runner, { useCache: false });

  // 프로그램은 cmd.exe이되 경로는 %ComSpec%에서 온다 — PATH에 System32가 없는 환경에서
  // `spawnSync cmd.exe ENOENT`가 나고, 그 증상이 "MSVC 준비 실패"로 보고되면 원인에서 멀다.
  assert.ok(seen !== undefined);
  assert.equal(seen!.program.split(/[\\/]/).pop()!.toLowerCase(), "cmd.exe");
  assert.deepEqual(seen?.args, ["/d", "/c", SCRIPT]);
  // 인자에 셸 메타문자가 없어야 한다 — 있으면 셸 조합을 하고 있다는 뜻이다.
  for (const arg of seen!.args) {
    assert.ok(!/[&|;><]/.test(arg), `argv에 셸 메타문자가 있습니다: ${arg}`);
  }
});

test("셸 경로는 PATH가 아니라 %ComSpec%에서 얻는다", () => {
  assert.equal(shellExecutablePath({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }), "C:\\Windows\\System32\\cmd.exe");
  // 대소문자 변형도 받는다 — Windows가 어느 철자로 줄지 보장되지 않는다.
  assert.equal(shellExecutablePath({ COMSPEC: "D:\\alt\\cmd.exe" }), "D:\\alt\\cmd.exe");
  // ComSpec이 없으면 SystemRoot로 조립한다.
  assert.equal(shellExecutablePath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(shellExecutablePath({ SystemRoot: "C:\\Windows\\" }), "C:\\Windows\\System32\\cmd.exe");
  // 둘 다 없으면 이름으로 시도한다 — 여기까지 오면 환경이 이미 비정상이다.
  assert.equal(shellExecutablePath({}), "cmd.exe");
  // 빈 값은 설정되지 않은 것으로 본다.
  assert.equal(shellExecutablePath({ ComSpec: "   ", SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\cmd.exe");
});

// ---- 회귀 4: _env.bat 실패 코드 보존 ----

test("_env.bat의 실패 종료 코드를 보존한다", () => {
  clearMsvcCache();
  const result = prepareMsvcEnv(
    REPO,
    "win32",
    runnerReturning({
      status: 1,
      stdout: "[tomverse] MSVC 빌드 도구를 찾지 못했습니다.",
    }),
    { useCache: false }
  );
  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.equal(result.exitCode, 1, "_env.bat의 종료 코드가 뭉개졌습니다");
  // _env.bat이 출력한 안내가 그대로 전달돼야 사용자가 무엇을 설치할지 알 수 있다.
  assert.ok(result.message.includes("MSVC 빌드 도구를 찾지 못했습니다"));
  assert.ok(result.message.includes(SCRIPT), "어떤 스크립트가 실패했는지 없습니다");
});

test("다른 실패 코드도 그대로 전달된다", () => {
  clearMsvcCache();
  for (const status of [2, 9009, 255]) {
    const result = prepareMsvcEnv(REPO, "win32", runnerReturning({ status }), { useCache: false });
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") assert.equal(result.exitCode, status);
  }
});

test("cmd.exe를 실행조차 못하면 별도로 보고한다", () => {
  clearMsvcCache();
  const result = prepareMsvcEnv(REPO, "win32", runnerReturning({ status: null, stderr: "ENOENT" }), {
    useCache: false,
  });
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.equal(result.exitCode, -1);
    assert.ok(result.message.includes("실행하지 못했습니다"));
  }
});

test("0으로 끝나도 준비 표식이 없으면 진행하지 않는다", () => {
  // 출력이 잘리거나 배치가 바뀐 경우. 여기서 통과시키면 LNK1104로만 드러난다.
  clearMsvcCache();
  const result = prepareMsvcEnv(REPO, "win32", runnerReturning({ status: 0, stdout: "PATH=C:\\x" }), {
    useCache: false,
  });
  assert.equal(result.kind, "unavailable");
});

test("INCLUDE/LIB가 비어 있으면 링크 실패 전에 막는다", () => {
  clearMsvcCache();
  const result = prepareMsvcEnv(
    REPO,
    "win32",
    runnerReturning({ status: 0, stdout: "TOMVERSE_MSVC_OK=1\r\nPATH=C:\\x\r\nINCLUDE=\r\nLIB=" }),
    { useCache: false }
  );
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    // 실제로 무엇이 일어날지 알려준다 — 그게 actionable의 의미다.
    assert.ok(result.message.includes("LNK1104"), result.message);
  }
});

// ---- 회귀 5: 자격증명 비노출 ----

test("allowlist 밖 변수는 버린다 — 자격증명이 흘러들 수 없다", () => {
  const stdout = [
    "TOMVERSE_MSVC_OK=1",
    "INCLUDE=C:\\VS\\include",
    "LIB=C:\\VS\\lib",
    // 배치가 실수로 더 출력하더라도 여기서 막혀야 한다.
    "OPENAI_API_KEY=sk-should-never-be-captured-0123456789",
    "ANTHROPIC_API_KEY=sk-ant-should-never-be-captured",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
  ].join("\n");
  const parsed = parseMsvcEnv(stdout);

  assert.equal(parsed.ready, true);
  assert.equal(Object.keys(parsed.env).includes("OPENAI_API_KEY"), false);
  const serialized = JSON.stringify(parsed.env);
  assert.ok(!serialized.includes("sk-"), `캡처된 환경에 자격증명이 있습니다: ${serialized}`);
  assert.ok(!serialized.includes("wJalrXUtnFEMI"));
});

test("실패 메시지에도 자격증명이 섞이지 않는다", () => {
  clearMsvcCache();
  // 배치가 어떤 이유로 환경을 흘렸다고 가정해도, 우리가 만드는 메시지는 stdout을 그대로
  // 옮기므로 이 테스트는 "그런 일이 생기면 드러난다"는 경보 역할을 한다.
  const result = prepareMsvcEnv(REPO, "win32", runnerReturning({ status: 1, stdout: "설치가 필요합니다" }), {
    useCache: false,
  });
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.ok(!/sk-[A-Za-z0-9]/.test(result.message));
  }
});

test("allowlist에 자격증명 계열 이름이 없다", () => {
  // 목록에 키 이름이 추가되는 실수를 구조적으로 막는다.
  for (const name of MSVC_ENV_ALLOWLIST) {
    assert.ok(!/KEY|TOKEN|SECRET|PASSWORD/i.test(name), `allowlist에 위험한 이름이 있습니다: ${name}`);
  }
});

// ---- 파싱 세부 ----

test("값에 = 가 있어도 첫 구분자에서만 자른다", () => {
  const parsed = parseMsvcEnv("TOMVERSE_MSVC_OK=1\nINCLUDE=C:\\a=b\\include\nLIB=C:\\lib");
  assert.equal(parsed.env.INCLUDE, "C:\\a=b\\include");
});

test("빈 값은 병합하지 않는다", () => {
  // 빈 문자열로 기존 PATH를 덮으면 자식 프로세스가 아무 명령도 못 찾는다.
  const parsed = parseMsvcEnv("TOMVERSE_MSVC_OK=1\nINCLUDE=C:\\i\nLIB=C:\\l\nPATH=");
  assert.equal(parsed.env.PATH, undefined);
});

test("CRLF와 LF를 모두 다룬다", () => {
  const crlf = parseMsvcEnv("TOMVERSE_MSVC_OK=1\r\nINCLUDE=C:\\i\r\nLIB=C:\\l");
  const lf = parseMsvcEnv("TOMVERSE_MSVC_OK=1\nINCLUDE=C:\\i\nLIB=C:\\l");
  assert.deepEqual(crlf, lf);
});

test("변수 이름의 대소문자를 구별하지 않는다", () => {
  // Windows 환경변수는 대소문자를 구별하지 않는다. `Path=`로 나와도 받아야 한다.
  const parsed = parseMsvcEnv("TOMVERSE_MSVC_OK=1\nPath=C:\\x\nInclude=C:\\i\nLib=C:\\l");
  assert.equal(parsed.env.PATH, "C:\\x");
  assert.equal(parsed.env.INCLUDE, "C:\\i");
});

test("환경 병합은 준비된 경우에만 일어난다", () => {
  const base = { EXISTING: "1", PATH: "/usr/bin" };
  assert.deepEqual(withMsvcEnv(base, { kind: "not_needed" }), base);
  assert.deepEqual(withMsvcEnv(base, { kind: "unavailable", exitCode: 1, message: "x" }), base);

  const merged = withMsvcEnv(base, { kind: "ready", env: { PATH: "C:\\vs", LIB: "C:\\lib" } });
  assert.equal(merged.EXISTING, "1", "기존 변수를 잃었습니다");
  assert.equal(merged.PATH, "C:\\vs");
  assert.equal(merged.LIB, "C:\\lib");
});

test("대소문자만 다른 기존 키를 남기지 않는다", () => {
  // Windows의 process.env는 `Path`로 온다. 여기에 `PATH`를 그냥 더하면 **두 키가 모두**
  // 자식에게 전달되고, 어느 쪽이 이길지 정해져 있지 않다. 지면 방금 준비한 MSVC 경로가
  // 통째로 무시되어 다시 링크에서 실패한다 — 실측으로 자식이 System32를 잃는 것을 확인했다.
  const base = { Path: "C:\\old", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const merged = withMsvcEnv(base, { kind: "ready", env: { PATH: "C:\\vs", INCLUDE: "C:\\i" } });

  const pathKeys = Object.keys(merged).filter((k) => k.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["PATH"], `PATH 계열 키가 여럿입니다: ${pathKeys.join(", ")}`);
  assert.equal(merged.PATH, "C:\\vs");
  // 무관한 변수는 그대로 남는다.
  assert.equal(merged.ComSpec, "C:\\Windows\\System32\\cmd.exe");
});

// ---- 회귀 6: 툴체인 실패와 모델/API 실패의 구별 ----

test("네이티브 툴체인이 필요한 명령만 구별한다", () => {
  assert.equal(needsNativeToolchain("cargo"), true);
  assert.equal(needsNativeToolchain("cargo.exe"), true);
  assert.equal(needsNativeToolchain("C:\\Users\\me\\.cargo\\bin\\cargo.exe"), true);
  assert.equal(needsNativeToolchain("rustc"), true);
  // TypeScript fixture는 MSVC 없이도 돌아야 한다 — 전부 막으면 20개를 검증할 기회를 잃는다.
  assert.equal(needsNativeToolchain("node"), false);
  assert.equal(needsNativeToolchain("npm"), false);
});

test("결과 종류가 세 갈래로 구별된다", () => {
  // 툴체인 실패(unavailable)와 정상 준비(ready)와 해당 없음(not_needed)이 섞이면
  // "왜 실패했는가"를 사용자에게 말해줄 수 없다.
  clearMsvcCache();
  const kinds = new Set([
    prepareMsvcEnv(REPO, "linux", runnerReturning({ status: 0 }), { useCache: false }).kind,
    prepareMsvcEnv(REPO, "win32", runnerReturning({ status: 0, stdout: GOOD_STDOUT }), { useCache: false }).kind,
    prepareMsvcEnv(REPO, "win32", runnerReturning({ status: 1 }), { useCache: false }).kind,
  ]);
  assert.deepEqual([...kinds].sort(), ["not_needed", "ready", "unavailable"]);
});

test("결과는 캐시된다 (fixture마다 배치를 다시 돌리지 않는다)", () => {
  clearMsvcCache();
  let calls = 0;
  const runner: ScriptRunner = () => {
    calls += 1;
    return { status: 0, stdout: GOOD_STDOUT, stderr: "" };
  };
  prepareMsvcEnv(REPO, "win32", runner);
  prepareMsvcEnv(REPO, "win32", runner);
  prepareMsvcEnv(REPO, "win32", runner);
  assert.equal(calls, 1, "배치를 여러 번 실행했습니다 — 검증 시간이 배수로 늘어납니다");
  clearMsvcCache();
});

test("스크립트 경로는 scripts/msvc-env.bat이다", () => {
  assert.ok(msvcEnvScriptPath(REPO).endsWith(path.join("scripts", "msvc-env.bat")));
});
