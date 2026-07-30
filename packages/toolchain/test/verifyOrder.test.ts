import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 회귀 테스트 3 — 검증 실행 순서 불변식.
 *
 * # 왜 필요한가
 *
 * `npm test`에는 가설 게이트 통합 테스트가 들어 있고, 그건 **실제 `tomverse-host` 바이너리를
 * 요구한다.** 따라서 `core:build`가 `test`보다 뒤에 있으면 clean clone에서 반드시 실패한다.
 * 로컬에 예전 바이너리가 남아 있으면 이 실수가 몇 주 동안 드러나지 않는다.
 *
 * # 어떻게 테스트하는가
 *
 * 소스 문자열을 통째로 비교하지 않는다(주석 한 줄만 바꿔도 깨지는 테스트는 유지되지 않는다).
 * 대신 **스크립트에서 단계 이름의 등장 순서만 뽑아** 필수 선후 관계를 확인한다.
 * 순서가 뒤집히면 실패하고, 설명이나 주석을 바꾸는 것으로는 실패하지 않는다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/** verify가 반드시 지켜야 하는 선후 관계. */
const REQUIRED_ORDER: { before: string; after: string; why: string }[] = [
  {
    before: "build",
    after: "typecheck",
    why: "sidecar는 protocol의 빌드 산출물(dist)에 대해 타입 검사한다 — 먼저 빌드하지 않으면 낡은 타입을 읽는다",
  },
  {
    before: "core:build",
    after: "test",
    why: "npm test에 포함된 가설 게이트 통합 테스트가 실제 tomverse-host 바이너리를 요구한다",
  },
  {
    before: "core:build",
    after: "test:e2e",
    why: "e2e가 tomverse-host 바이너리를 요구한다",
  },
];

/**
 * 주석을 걷어낸다.
 *
 * `.bat`의 `rem` 줄에는 "왜 이 순서인가"를 설명하느라 단계 이름이 그대로 등장한다.
 * 그걸 실행 단계로 세면 순서 비교가 엉뚱해진다 — 실제로 이 테스트를 처음 돌렸을 때
 * 주석의 `npm test` 언급 때문에 첫 단계가 `test`로 잡혔다.
 */
function stripComments(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((line) => !/^\s*(rem\b|::)/i.test(line))
    .join("\n");
}

/** 스크립트 문자열에서 우리가 아는 단계 이름의 등장 순서를 뽑는다. */
export function extractStepOrder(rawScript: string): string[] {
  const script = stripComments(rawScript);
  const steps: { index: number; name: string }[] = [];
  // 긴 이름을 먼저 찾아 `core:build`가 `build`로 잘못 잡히지 않게 한다.
  const names = ["core:build", "core:test", "test:e2e", "typecheck", "build", "test"];
  const claimed: { start: number; end: number }[] = [];

  for (const name of names) {
    const pattern = new RegExp(`npm (?:run )?${name.replace(":", ":")}(?![\\w:-])`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(script)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // 이미 더 긴 이름이 차지한 구간이면 건너뛴다.
      if (claimed.some((c) => start >= c.start && start < c.end)) continue;
      claimed.push({ start, end });
      steps.push({ index: start, name });
    }
  }
  return steps.sort((a, b) => a.index - b.index).map((s) => s.name);
}

function firstIndexOf(steps: readonly string[], name: string): number {
  return steps.indexOf(name);
}

test("추출기가 단계 이름을 순서대로 뽑는다", () => {
  // 추출기 자체가 틀리면 아래 불변식 검사가 무의미해진다.
  const order = extractStepOrder(
    "npm run build && npm run typecheck && npm run core:build && npm test && npm run core:test && npm run test:e2e"
  );
  assert.deepEqual(order, ["build", "typecheck", "core:build", "test", "core:test", "test:e2e"]);
});

test("추출기가 core:build를 build로 잘못 잡지 않는다", () => {
  assert.deepEqual(extractStepOrder("npm run core:build"), ["core:build"]);
  assert.deepEqual(extractStepOrder("npm run core:test"), ["core:test"]);
  assert.deepEqual(extractStepOrder("npm run test:e2e"), ["test:e2e"]);
});

test("루트 package.json의 verify가 필수 선후 관계를 지킨다", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const verify = pkg.scripts.verify;
  assert.ok(typeof verify === "string" && verify.length > 0, "루트에 verify 스크립트가 없습니다");

  const steps = extractStepOrder(verify);
  for (const { before, after, why } of REQUIRED_ORDER) {
    const beforeIndex = firstIndexOf(steps, before);
    const afterIndex = firstIndexOf(steps, after);
    assert.ok(beforeIndex >= 0, `verify에 ${before} 단계가 없습니다: ${steps.join(" → ")}`);
    assert.ok(afterIndex >= 0, `verify에 ${after} 단계가 없습니다: ${steps.join(" → ")}`);
    assert.ok(
      beforeIndex < afterIndex,
      `verify 순서 위반: ${before}가 ${after}보다 뒤에 있습니다.\n이유: ${why}\n현재 순서: ${steps.join(" → ")}`
    );
  }
});

test("scripts/verify.bat이 루트 verify와 같은 순서다", () => {
  // 두 진입점이 갈라지면 "Windows에서만 깨지는" 상태가 만들어진다.
  const bat = readFileSync(path.join(REPO_ROOT, "scripts", "verify.bat"), "utf8");
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  const batSteps = extractStepOrder(bat);
  const pkgSteps = extractStepOrder(pkg.scripts.verify!);
  assert.deepEqual(
    batSteps,
    pkgSteps,
    `scripts\\verify.bat과 루트 verify의 순서가 다릅니다.\n  bat: ${batSteps.join(" → ")}\n  pkg: ${pkgSteps.join(" → ")}`
  );
});

test("scripts/verify.bat이 CRLF를 유지한다", () => {
  // LF면 cmd.exe가 `goto :label`을 잘못 읽어 조용히 엉뚱하게 동작한다(CLAUDE.md 함정 기록).
  const raw = readFileSync(path.join(REPO_ROOT, "scripts", "verify.bat"));
  const text = raw.toString("utf8");
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  assert.equal(lfOnly, 0, `verify.bat에 CRLF가 아닌 줄바꿈이 ${lfOnly}개 있습니다`);
});

test("MSVC 환경 스크립트도 CRLF다", () => {
  const raw = readFileSync(path.join(REPO_ROOT, "scripts", "msvc-env.bat"), "utf8");
  const lfOnly = (raw.match(/(?<!\r)\n/g) ?? []).length;
  assert.equal(lfOnly, 0, `msvc-env.bat에 CRLF가 아닌 줄바꿈이 ${lfOnly}개 있습니다`);
});

test("msvc-env.bat이 전체 환경을 덤프하지 않는다", () => {
  // `set` 한 줄이면 OPENAI_API_KEY까지 전부 stdout으로 나온다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "msvc-env.bat"), "utf8");
  const dumpsEverything = /^\s*set\s*$/m.test(script);
  assert.equal(dumpsEverything, false, "msvc-env.bat이 전체 환경을 출력합니다 — 자격증명이 새어나갑니다");
  // MSVC 탐지는 _env.bat에만 있어야 한다. 여기에 Visual Studio 경로가 있으면 중복이다.
  assert.ok(
    !/Program Files/i.test(script),
    "msvc-env.bat에 Visual Studio 경로가 하드코딩되어 있습니다 — 탐지는 _env.bat 한 곳에만 있어야 합니다"
  );
  assert.ok(script.includes("_env.bat"), "msvc-env.bat이 _env.bat을 호출하지 않습니다");
});

test("_env.bat이 절대 경로를 하드코딩하되 사용자별 경로는 쓰지 않는다", () => {
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "_env.bat"), "utf8");
  // 표준 설치 위치를 후보로 두는 것은 정상이다. 특정 사용자 홈은 아니다.
  assert.ok(
    !/C:\\Users\\[A-Za-z0-9_.-]+\\/i.test(script),
    "_env.bat에 특정 사용자 머신의 절대 경로가 있습니다"
  );
  assert.ok(script.includes("%USERPROFILE%"), "cargo 경로는 %USERPROFILE%로 풀어야 합니다");
});

test("_env.bat이 Visual Studio를 vswhere로 찾는다", () => {
  // 실측 사례: 사용자의 VS는 D:\Program Files\Microsoft Visual Studio\18\Enterprise 였다.
  // 후보 경로를 하드코딩하면 드라이브·버전·에디션 중 하나만 달라도 빗나가고, 목록을 늘리는
  // 방식으로는 영원히 못 쫓아간다. vswhere.exe는 Installer가 고정 위치에 두는 조회 도구다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "_env.bat"), "utf8");
  assert.ok(script.includes("vswhere.exe"), "_env.bat이 vswhere를 쓰지 않습니다");
  assert.ok(
    /-property\s+installationPath/.test(script),
    "_env.bat이 vswhere에 설치 경로를 묻지 않습니다"
  );
  // 안전망(서브트리 검색)이 vswhere보다 먼저 오면 vswhere가 사실상 죽는다.
  assert.ok(
    script.indexOf("vswhere.exe") < script.indexOf(":find_vcvars"),
    "안전망 검색이 vswhere보다 먼저 시도됩니다"
  );

  // 버전·에디션을 목록으로 적는 방식으로 돌아가지 않는다. "2022"나 특정 에디션 이름이
  // 후보로 등장하면 그 목록은 새 버전이 나오는 순간 틀린다(실측: VS 18 Enterprise).
  assert.ok(
    !/Microsoft Visual Studio\\20\d\d\\/.test(script),
    "_env.bat에 연도 기반 설치 경로 후보가 다시 들어왔습니다 — 목록이 아니라 검색을 쓸 것"
  );

  // 탐지가 전부 실패했을 때 **사용자가 직접 지정할 수 있는 탈출구**가 있어야 한다.
  // "설치되지 않은 것으로 보입니다"만 말하면 설치되어 있는 사용자가 할 수 있는 일이 없다.
  assert.ok(
    script.includes("TOMVERSE_VCVARSALL"),
    "탐지 실패 시 사용자가 vcvarsall.bat 위치를 지정할 방법이 없습니다"
  );
  // PATH에 단독 설치된 vswhere도 정당한 조회 도구다.
  assert.ok(/where\s+vswhere\.exe/.test(script), "_env.bat이 PATH의 vswhere를 보지 않습니다");
});

test("_env.bat이 vswhere에 -latest가 아니라 -all을 쓴다", () => {
  // 실측 머신에 설치가 둘 있었다: 최신 VS 18 Enterprise에는 C++ 빌드 도구가 없고, 도구가 있는
  // 것은 더 오래된 2022 BuildTools였다. `-latest`는 "가장 새 설치 하나"만 주므로 그 하나가
  // 쓸 수 없으면 나머지를 보지 않고 실패한다. 필요한 것은 "가장 새 것"이 아니라
  // **vcvarsall.bat이 실제로 있는 것**이다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "_env.bat"), "utf8");
  const queries = script.split(/\r?\n/).filter((line) => line.includes("-property installationPath"));
  assert.ok(queries.length >= 2, `vswhere 조회가 예상보다 적습니다: ${queries.length}`);
  for (const query of queries) {
    assert.ok(!/\s-latest\b/.test(query), `-latest는 쓸 수 있는 설치를 놓칠 수 있습니다: ${query.trim()}`);
    assert.ok(/\s-all\b/.test(query), `-all이 없습니다: ${query.trim()}`);
  }
  // 그리고 각 후보마다 vcvarsall.bat 존재를 **파일로** 확인해야 한다 — 선언만으로는 부족하다.
  const checks = script.split(/\r?\n/).filter((line) => /if exist "%%i\\VC\\Auxiliary/.test(line));
  assert.equal(checks.length, queries.length, "vswhere 조회 수와 vcvarsall.bat 확인 수가 다릅니다");
});

test("탐지 실패 메시지가 확인한 것을 전부 알려준다", () => {
  // 실측: Visual Studio가 설치된 머신에서 "설치되어 있지 않은 것으로 보입니다"가 나왔다.
  // 그 메시지로는 사용자도 우리도 다음에 무엇을 볼지 알 수 없다 — 무엇을 어디까지 확인했는지가
  // 함께 나와야 추측 없이 원인을 좁힐 수 있다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "_env.bat"), "utf8");
  for (const fact of ["ProgramFiles", "VSINSTALLDIR", "TOMVERSE_VCVARSALL", "msvc:doctor"]) {
    assert.ok(script.includes(fact), `탐지 실패 안내에 ${fact}가 없습니다`);
  }

  // 진단 명령은 읽기 전용이며, 전체 환경을 덤프하지 않는다(키가 버퍼에 들어간다).
  const doctor = readFileSync(path.join(REPO_ROOT, "scripts", "msvc-doctor.bat"), "utf8");
  assert.ok(doctor.includes("_env.bat"), "진단이 실제 탐지 경로를 실행하지 않습니다");
  assert.ok(
    !/^\s*set\s*$/m.test(doctor),
    "진단이 전체 환경을 덤프합니다 — API 키가 출력에 들어갑니다"
  );

  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.ok(root.scripts["msvc:doctor"]?.includes("msvc-doctor.bat"), "msvc:doctor 스크립트가 없습니다");
});

test("msvc-doctor.bat이 읽을 수 있는 출력을 내고 셸 상태를 되돌린다", () => {
  // 실측: 진단 출력이 전부 깨져 나왔다. 이 스크립트의 출력은 npm/node의 UTF-8 파이프를 지나지
  // 않고 콘솔에 직접 가므로, 파일이 UTF-8인데 콘솔 코드 페이지가 cp949/437이면 한글이 깨진다.
  // 그리고 코드 페이지는 setlocal로 스코프되지 않으므로 **직접 되돌려야** 한다 — 진단 명령이
  // 사용자의 셸 상태를 바꿔 놓고 끝나면 안 된다.
  const doctor = readFileSync(path.join(REPO_ROOT, "scripts", "msvc-doctor.bat"), "utf8");
  assert.ok(/chcp\s+65001/.test(doctor), "진단이 UTF-8 코드 페이지를 설정하지 않습니다 — 한글이 깨집니다");
  assert.ok(
    /chcp\s+%OLD_CP%/.test(doctor),
    "진단이 코드 페이지를 되돌리지 않습니다 — 사용자의 셸이 65001로 남습니다"
  );

  // 설치 경로만 나열하면 "둘 다 있는데 왜 실패하나"로 읽힌다. 실측 머신은 최신 설치에
  // C++ 빌드 도구가 없고 더 오래된 설치에만 있었다 — 그 차이가 출력에 보여야 한다.
  assert.ok(
    doctor.includes("VC\\Auxiliary\\Build\\vcvarsall.bat"),
    "진단이 설치별 vcvarsall.bat 존재를 확인하지 않습니다"
  );
});

test("_env.bat이 드라이브 문자를 하드코딩하지 않는다", () => {
  // VS가 D: 드라이브에 설치된 실제 사례가 있었다. Program Files 위치는 환경변수로 푼다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "_env.bat"), "utf8");
  const hardcoded = script
    .split(/\r?\n/)
    .filter((line) => !/^\s*rem\b/i.test(line))
    .filter((line) => /[A-Za-z]:\\/.test(line));
  assert.deepEqual(
    hardcoded,
    [],
    `_env.bat의 실행 줄에 드라이브 문자가 하드코딩되어 있습니다:\n${hardcoded.join("\n")}`
  );
});

test("_env.bat이 vcvarsall 성공을 INCLUDE로 확인한다", () => {
  // vcvarsall이 0으로 끝나도 변수가 안 잡히는 경우가 있다. 여기서 안 걸르면
  // stdarg.h 없음 / LNK1104라는 훨씬 먼 증상으로만 드러난다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "_env.bat"), "utf8");
  assert.ok(
    /if not defined INCLUDE/i.test(script),
    "_env.bat이 vcvarsall 실행 후 INCLUDE를 확인하지 않습니다"
  );
});
