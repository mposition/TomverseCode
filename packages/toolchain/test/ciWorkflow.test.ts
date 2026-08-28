import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI 워크플로가 지켜야 하는 것들 — **약속을 주석이 아니라 검사로 둔다.**
 *
 * # 왜 필요한가
 *
 * CI는 "누군가 검증을 돌리는 것을 기억하는 것"을 없애려고 만들었다. 그런데 CI 자체는
 * 아무도 검증하지 않는다 — 초록불은 "돌았다"가 아니라 **"실패하지 않았다"**만 말하고,
 * 조용히 건너뛴 단계도 초록불을 낸다. 그래서 이 저장소가 CI에 요구하는 것들을 여기에
 * 고정한다: 락파일이 정본인가, Node 하한을 지키는가, 실패를 삼키지 않는가, 캐시 없이
 * 도는 경로가 있는가.
 *
 * # 왜 여기(toolchain)에 두는가
 *
 * 저장소 전체의 구조를 대조하는 검사가 이미 여기 있다(`buildOrder.test.ts`가 루트
 * `package.json`과 워크스페이스 그래프를, `verifyOrder.test.ts`가 두 검증 진입점을 대조한다).
 * CI는 그 진입점들과 같은 종류의 사실이다.
 *
 * # 여기에 없는 것
 *
 * "CI가 verify의 단계를 다시 나열하지 않는다"는 `verifyOrder.test.ts`에 있다 —
 * 그 파일이 진입점 갈라짐을 다루는 자리이고, 단계 이름 추출기도 거기 있기 때문이다.
 *
 * # 이 검사가 못 잡는 것
 *
 * YAML을 정식으로 파싱하지 않는다(런타임 의존성이 없는 워크스페이스다). 들여쓰기와
 * 키 이름을 문자열로 읽으므로, 워크플로 구조를 크게 바꾸면 검사가 **찾지 못해** 실패한다.
 * 조용히 통과하는 쪽보다 낫다 — 못 찾은 것과 없는 것을 같게 두지 않는다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

function readWorkflow(): string {
  assert.ok(existsSync(WORKFLOW), `CI 워크플로가 없습니다: ${WORKFLOW}`);
  return readFileSync(WORKFLOW, "utf8");
}

/** `#` 주석 줄을 걷어낸다 — 머리말이 설명하느라 쓴 낱말을 설정으로 세지 않기 위해. */
function withoutComments(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** `run:` 블록의 실제 명령 줄만 모은다(블록 스칼라 `|` 포함). */
function runLines(yaml: string): string[] {
  const lines = withoutComments(yaml).split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const inline = /^\s*(?:- )?run:\s*(\S.*)$/.exec(lines[i]!);
    if (inline && inline[1] !== "|" && inline[1] !== ">") {
      out.push(inline[1]!.trim());
      continue;
    }
    if (!/^\s*(?:- )?run:\s*[|>]-?\s*$/.test(lines[i]!)) continue;
    const indent = /^\s*/.exec(lines[i]!)![0].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      if (/^\s*/.exec(line)![0].length <= indent) break;
      out.push(line.trim());
    }
  }
  return out;
}

test("CI가 락파일을 정본으로 쓴다", () => {
  const yaml = withoutComments(readWorkflow());
  const commands = runLines(yaml);
  assert.ok(
    commands.some((c) => /^npm ci\b/.test(c)),
    `CI가 \`npm ci\`를 쓰지 않습니다: ${commands.join(" / ")}`
  );
  // `npm install`은 빠진 의존성을 락파일에 **써 넣으며** 통과한다. 그러면 락파일 누락이
  // CI에서도 드러나지 않는다 — 이 저장소는 그 누락을 두 번 고쳤다(게이트→sidecar,
  // desktop→@types/node).
  const installs = commands.filter((c) => /\bnpm\s+(?:i|install)\b/.test(c));
  assert.deepEqual(installs, [], `CI가 npm install을 씁니다 — 락파일이 정본이 아니게 됩니다: ${installs.join(" / ")}`);
  assert.ok(existsSync(path.join(REPO_ROOT, "package-lock.json")), "락파일이 저장소에 없습니다");
});

test("CI의 Node 버전이 engines.node 하한을 지킨다", () => {
  const yaml = withoutComments(readWorkflow());
  const match = /node-version:\s*["']?(\d+)/.exec(yaml);
  assert.ok(match, "CI에서 node-version을 찾지 못했습니다 — setup-node 설정이 바뀌었습니까?");
  const ciMajor = Number(match[1]);

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;
  assert.ok(range, "루트 package.json에 engines.node가 없습니다");
  // nodeVersion.test.ts와 같은 방식으로 읽는다 — 범위 문법 전부가 아니라 우리가 쓰는 형태만.
  const declared = /^>=?\s*(\d+)|^(\d+)\./.exec(range.trim());
  assert.ok(declared, `engines.node를 해석할 수 없습니다: ${range}`);
  const minMajor = Number(declared[1] ?? declared[2]);

  assert.ok(
    ciMajor >= minMajor,
    `CI가 Node ${ciMajor}로 도는데 저장소는 ${minMajor} 이상을 요구합니다`
  );
});

test("CI가 실패를 삼키지 않는다", () => {
  const yaml = withoutComments(readWorkflow());
  // 어떤 단계가 러너에서 못 돌면 덮지 말고 실패하게 둔다. `continue-on-error`는 초록불로
  // 거짓 확신을 주는 가장 흔한 방법이다.
  assert.ok(
    !/continue-on-error/.test(yaml),
    "CI에 continue-on-error가 있습니다 — 실패한 단계가 초록불로 보고됩니다"
  );
  const swallowed = runLines(yaml).filter((c) => /\|\|\s*(true|:|exit\s+0)/.test(c));
  assert.deepEqual(swallowed, [], `실패를 삼키는 명령이 있습니다: ${swallowed.join(" / ")}`);
});

test("캐시 없이 도는 경로가 정기적으로 있다", () => {
  const yaml = withoutComments(readWorkflow());
  // 이 저장소는 낡은 산출물 때문에 원인과 먼 오류를 본 적이 있다(낡은 .d.ts로 컴파일되던 일).
  // 캐시가 clean clone의 깨짐을 감추면 CI의 초록불이 그 사고를 되풀이한다.
  assert.ok(/^\s*schedule:/m.test(yaml), "정기 실행(schedule) 트리거가 없습니다");
  assert.ok(/cron:/.test(yaml), "schedule에 cron이 없습니다");

  const flag = /TOMVERSE_CI_CACHE:\s*(.+)/.exec(yaml);
  assert.ok(flag, "캐시 스위치(TOMVERSE_CI_CACHE)를 찾지 못했습니다");
  assert.ok(
    /schedule/.test(flag[1]!) && /'off'/.test(flag[1]!),
    `정기 실행에서 캐시가 꺼지지 않습니다: ${flag[1]!.trim()}`
  );

  // 캐시 단계가 그 스위치를 실제로 본다. 스위치만 있고 아무도 읽지 않으면 아무 일도 안 한다.
  const cacheSteps = yaml.split(/\r?\n/).filter((line) => /uses:\s*actions\/cache@/.test(line));
  assert.ok(cacheSteps.length >= 1, "캐시 단계가 없습니다 — 스위치가 가리킬 대상이 없습니다");
  const guards = yaml.split(/\r?\n/).filter((line) => /if:\s*env\.TOMVERSE_CI_CACHE\s*==\s*'on'/.test(line));
  assert.equal(
    guards.length,
    cacheSteps.length,
    `캐시 단계 ${cacheSteps.length}개 중 ${guards.length}개만 스위치를 봅니다 — 나머지는 정기 실행에서도 캐시를 씁니다`
  );
});

test("캐시 유무가 단계 목록을 갈라놓지 않는다", () => {
  const yaml = withoutComments(readWorkflow());
  // 캐시 있는 실행과 없는 실행을 서로 다른 job으로 두면 그 둘이 갈라진다 — 이 저장소가
  // 진입점에 대해 반복해서 겪은 일이다. 같은 job에서 캐시 **단계만** 건너뛴다.
  // `on:` 아래의 트리거 이름도 2칸 들여쓰기라 그것까지 세면 안 된다 — `jobs:` 뒤만 본다.
  const afterJobs = yaml.split(/^jobs:\s*$/m)[1];
  assert.ok(afterJobs, "워크플로에서 jobs 블록을 찾지 못했습니다");
  const jobNames = afterJobs
    .split(/\r?\n/)
    .filter((line) => /^ {2}[A-Za-z][\w-]*:\s*$/.test(line))
    .map((line) => line.trim().replace(":", ""));
  assert.deepEqual(jobNames, ["verify"], `job이 하나가 아닙니다: ${jobNames.join(", ")}`);
  assert.ok(
    !/^\s*strategy:/m.test(yaml),
    "matrix로 job을 나눕니다 — 캐시 유무가 단계 목록을 둘로 만들면 그 둘이 갈라집니다"
  );
});

test("CI가 껍데기 타입 검사에 필요한 것을 실제로 설치한다", () => {
  const yaml = withoutComments(readWorkflow());
  const commands = runLines(yaml).join("\n");
  // `desktop:check`는 GUI **개발** 라이브러리를 요구한다. 없으면 gdk-3.0을 못 찾아
  // `gdk-sys` 빌드 스크립트에서 멈춘다 — 실측으로 확인한 증상이다.
  assert.ok(/apt-get install/.test(commands), "네이티브 개발 패키지를 설치하지 않습니다");
  for (const pkg of ["libgtk-3-dev", "libwebkit2gtk-4.1-dev"]) {
    assert.ok(commands.includes(pkg), `CI가 ${pkg}를 설치하지 않습니다 — desktop:check가 여기서 멈춥니다`);
  }
  // 러너 이미지를 latest로 두면 개발 패키지 버전이 예고 없이 바뀐다. 실패했을 때
  // "우리가 바꾼 것"과 "이미지가 바뀐 것"을 구별할 수 있어야 한다.
  const runner = /runs-on:\s*(\S+)/.exec(yaml);
  assert.ok(runner, "runs-on을 찾지 못했습니다");
  assert.ok(
    !/latest/.test(runner[1]!),
    `러너를 고정하지 않았습니다(${runner[1]}) — 이미지가 바뀌면 원인이 우리 변경인지 알 수 없습니다`
  );
});

test("desktop:check가 번들 자리를 스스로 만든다", () => {
  // CI가 `mkdir`을 따로 알 필요가 없어야 한다 — 알아야 하면 그 지식이 CI에만 있고,
  // clean clone에서 `npm run verify`를 돌리는 사람은 여전히 기억에 의존하게 된다.
  // `bundle/sidecar`는 gitignore되어 있고 만드는 것은 릴리스 앞에서만 도는 sidecar:stage다.
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const step = pkg.scripts["desktop:check"];
  assert.ok(step, "desktop:check 스크립트가 없습니다");
  assert.ok(
    step.includes("ensureBundleSlot"),
    `desktop:check가 번들 자리를 만들지 않습니다: ${step}`
  );
  // 두 진입점이 갈라지지 않게 `.bat` 래퍼도 같은 것을 지난다.
  const bat = readFileSync(path.join(REPO_ROOT, "scripts", "cargo-check-desktop.bat"), "utf8");
  assert.ok(
    bat.includes("ensureBundleSlot"),
    "scripts\\cargo-check-desktop.bat이 번들 자리를 만들지 않습니다 — 두 진입점이 갈라집니다"
  );
  assert.ok(existsSync(path.join(REPO_ROOT, "scripts", "ensureBundleSlot.mjs")), "ensureBundleSlot.mjs가 없습니다");
});

test("run 블록 추출기가 실제로 명령을 읽는다", () => {
  // 추출기가 0개를 돌려주면 위의 "삼키지 않는다"·"npm ci를 쓴다" 검사가 빈 집합에 대해
  // 통과하거나 엉뚱하게 실패한다. 못 읽은 것과 없는 것을 같게 두지 않는다.
  const commands = runLines(readWorkflow());
  assert.ok(commands.length >= 3, `run 명령을 ${commands.length}개만 읽었습니다 — 추출기가 구조를 놓쳤습니까?`);
  assert.ok(commands.some((c) => c.includes("npm run verify")), "verify 호출을 읽지 못했습니다");
});
