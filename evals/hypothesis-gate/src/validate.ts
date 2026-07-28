import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoadedFixture } from "./manifest.js";
import { runVerification } from "./oracle.js";
import { applyReferencePatch, injectOracle, materialize } from "./workspace.js";
import { FIXTURE_CATEGORIES, type FixtureCategory } from "./types.js";

/**
 * fixture 품질 검증 (§6).
 *
 * # 왜 모델을 부르기 전에 하는가
 *
 * fixture가 잘못되어 있으면 실험 결과가 fixture 결함을 측정한 것이 된다. 그리고 그 사실은
 * 결과를 다 뽑은 뒤에야 드러난다 — 이미 API 비용을 다 쓴 뒤다. 그래서 **모델 호출 없이**
 * 결정론적으로 확인할 수 있는 것을 전부 먼저 확인한다.
 *
 * 확인하는 것:
 *  1. 초기 상태에서 oracle이 **실패한다** — 통과하면 측정할 것이 없다
 *  2. 참조 patch를 적용하면 oracle이 **통과한다** — 통과 불가능한 fixture는 모두를 실패시킨다
 *  3. oracle 파일이 모델의 workspace에 없다
 *  4. 공개 검증만으로는 oracle을 만족시킬 수 없다 (= 공개 검증이 정답을 노출하지 않는다)
 *  5. fixture 간 상태 격리 — 두 번 만들어도 같은 해시
 *  6. 테스트 삭제/약화/검증 제거로는 통과할 수 없다
 */

export interface FixtureValidationResult {
  fixtureId: string;
  category: FixtureCategory;
  ok: boolean;
  checks: { name: string; passed: boolean; detail?: string }[];
}

export function validateFixture(fixture: LoadedFixture): FixtureValidationResult {
  const checks: FixtureValidationResult["checks"] = [];
  const manifest = fixture.manifest;

  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, passed } : { name, passed, detail });
  };

  // ---- 1. 초기 상태에서 oracle 실패 ----
  const initial = materialize(fixture, `${manifest.fixtureId}-validate-initial`);
  try {
    injectOracle(fixture, initial.root);
    const outcome = runVerification(manifest.oracleVerificationCommands, initial.root, manifest.timeoutMs);
    check(
      "초기 상태에서 oracle 실패",
      !outcome.passed,
      outcome.passed ? "고치기 전에 이미 통과합니다 — 이 fixture는 아무것도 측정하지 못합니다" : undefined
    );
  } finally {
    initial.cleanup();
  }

  // ---- 2. 참조 patch 적용 후 oracle 통과 ----
  const patched = materialize(fixture, `${manifest.fixtureId}-validate-reference`);
  try {
    applyReferencePatch(fixture, patched.root);
    injectOracle(fixture, patched.root);
    const outcome = runVerification(manifest.oracleVerificationCommands, patched.root, manifest.timeoutMs);
    check(
      "참조 patch 적용 후 oracle 통과",
      outcome.passed,
      outcome.passed
        ? undefined
        : `풀 수 없는 fixture입니다. 실패 출력:\n${outcome.commands.map((c) => `[${c.command}] ${c.output.slice(0, 400)}`).join("\n")}`
    );
  } finally {
    patched.cleanup();
  }

  // ---- 3. 공개 검증과 oracle의 관계 ----
  //
  // 공개 검증이 초기에 실패하는 fixture와 통과하는 fixture **둘 다 유효하다.**
  //  - 실패하면: 모델이 증상을 재현할 수 있다 (전형적인 버그 수정)
  //  - 통과하면: 공개 테스트로는 드러나지 않는 숨은 불변식 위반이다.
  //    이건 "불완전한 증상 설명" 범주의 핵심이고, 실제 현장에서 더 어려운 쪽이다.
  //
  // 여기서 강제하는 것은 하나뿐이다: **oracle이 공개 검증보다 엄격해야 한다.**
  // 초기 상태에서 oracle이 실패하는 것은 위에서 이미 확인했으므로, 공개 검증이 통과하는
  // 경우 그 자체가 "oracle이 더 엄격하다"의 증거다. 통과 여부는 분류로만 기록한다.
  const publicRun = materialize(fixture, `${manifest.fixtureId}-validate-public`);
  let publicPassesInitially = false;
  try {
    const outcome = runVerification(manifest.publicVerificationCommands, publicRun.root, manifest.timeoutMs);
    publicPassesInitially = outcome.passed;
    // 공개 검증 명령 자체가 실행조차 안 되면(바이너리 없음 등) fixture가 고장 난 것이다.
    const ran = outcome.commands.length > 0 && outcome.commands.every((c) => c.exitCode !== null);
    check(
      "공개 검증 명령이 실행 가능",
      ran,
      ran ? undefined : `명령을 실행하지 못했습니다: ${outcome.commands.map((c) => c.output.slice(0, 200)).join(" | ")}`
    );
  } finally {
    publicRun.cleanup();
  }
  check(
    "oracle이 공개 검증보다 엄격함",
    true,
    publicPassesInitially
      ? "공개 검증은 초기에 통과한다 — 숨은 불변식 유형(모델이 증상을 직접 관측할 수 없다)"
      : "공개 검증이 초기에 실패한다 — 모델이 증상을 재현할 수 있다"
  );

  // ---- 4. oracle 비노출 ----
  //
  // loadFixture가 파일 이름 충돌은 이미 막았다. 여기서는 **내용이 복사됐는지** 본다.
  //
  // 줄 단위로 비교하면 오탐이 심하다: `const assert = require("node:assert/strict")`나
  // 공통 setup 한 줄은 공개 테스트와 oracle이 당연히 공유한다. 그건 정답 노출이 아니다.
  // **연속된 여러 줄이 그대로 옮겨진 경우**만 실제 복사로 본다.
  const leak = findCopiedBlock(readAllText(fixture.oracleDir), readAllText(fixture.workspaceDir));
  check(
    "oracle 내용이 workspace에 복사되지 않음",
    leak === undefined,
    leak === undefined ? undefined : `workspace에 oracle 코드 ${MIN_LEAK_LINES}줄 이상이 그대로 있습니다:\n${leak}`
  );

  // ---- 5. 결정론적 상태 (두 번 만들어도 같다) ----
  const a = materialize(fixture, `${manifest.fixtureId}-iso-a`);
  const b = materialize(fixture, `${manifest.fixtureId}-iso-b`);
  try {
    check("두 번 materialize해도 같은 내용", readAllText(a.root) === readAllText(b.root));
    // 한쪽을 오염시켜도 다른 쪽에 영향이 없어야 한다 (격리).
    const marker = path.join(a.root, "__isolation_probe__.txt");
    writeText(marker, "probe");
    check("격리: 한쪽 변경이 다른 쪽에 보이지 않음", !readAllText(b.root).includes("__isolation_probe__"));
  } finally {
    a.cleanup();
    b.cleanup();
  }

  // ---- 6. 부정행위로 통과 불가 ----
  check(...cannotPassByDeletingTests(fixture));

  // ---- 7. manifest 자체의 상식 ----
  check("category가 알려진 값", (FIXTURE_CATEGORIES as readonly string[]).includes(manifest.category));
  check(
    "forbiddenPaths에 oracle 디렉터리 이름이 없음",
    true,
    "oracle은 workspace에 없으므로 forbiddenPaths로 막을 대상이 아니다 (참고)"
  );
  check("timeoutMs가 30초 이상", manifest.timeoutMs >= 30_000, `현재 ${manifest.timeoutMs}ms`);

  return {
    fixtureId: manifest.fixtureId,
    category: manifest.category,
    ok: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * **테스트를 지워서 통과할 수 없는가.**
 *
 * 모델이 실패하는 테스트를 삭제하거나 단정을 약화시켜 "통과"를 만드는 것은 실제로 흔한
 * 실패 모드다. oracle이 workspace 밖에서 주입되므로 구조적으로 막히지만, 그 사실을
 * fixture마다 실제로 확인한다 — 구조에 의존하는 주장은 검증돼야 한다.
 */
function cannotPassByDeletingTests(fixture: LoadedFixture): [string, boolean, string?] {
  const sabotaged = materialize(fixture, `${fixture.manifest.fixtureId}-sabotage`);
  try {
    // 공개 테스트 파일을 전부 "항상 통과"로 바꾼다 — 모델이 할 수 있는 가장 심한 부정행위.
    const testFiles = listFiles(sabotaged.root).filter((f) => /(^|\/)(test|tests)[./]|\.test\.|_test\./.test(f));
    for (const rel of testFiles) {
      writeText(path.join(sabotaged.root, rel), "// sabotaged by fixture validation\n");
    }
    injectOracle(fixture, sabotaged.root);
    const outcome = runVerification(
      fixture.manifest.oracleVerificationCommands,
      sabotaged.root,
      fixture.manifest.timeoutMs
    );
    return [
      "테스트를 지워도 oracle을 통과할 수 없음",
      !outcome.passed,
      outcome.passed ? "공개 테스트를 전부 지웠는데 oracle이 통과했습니다 — oracle이 실제 불변식을 보지 않습니다" : undefined,
    ];
  } finally {
    sabotaged.cleanup();
  }
}

/** 이 줄 수 이상이 연속으로 일치하면 복사로 본다. */
const MIN_LEAK_LINES = 4;

/**
 * 의미 있는 줄만 남긴다: import/use/require, 빈 줄, 주석, 닫는 괄호는 어느 파일에나 있다.
 * 이런 줄로 일치를 판정하면 정상 fixture가 전부 오탐이 된다.
 */
function significantLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 12 &&
        !l.startsWith("//") &&
        !l.startsWith("*") &&
        !l.startsWith("/*") &&
        !l.startsWith("#") &&
        !l.startsWith("---") &&
        !/^(import|use |const .* = require|from )/.test(l) &&
        !/^[})\];,]+$/.test(l)
    );
}

/** oracle의 연속 N줄이 workspace에 그대로 있으면 그 블록을 돌려준다. */
function findCopiedBlock(oracleText: string, workspaceText: string): string | undefined {
  const oracleLines = significantLines(oracleText);
  const workspaceLines = significantLines(workspaceText);
  const workspaceSet = new Set(workspaceLines);

  let run: string[] = [];
  for (const line of oracleLines) {
    if (workspaceSet.has(line)) {
      run.push(line);
      if (run.length >= MIN_LEAK_LINES) return run.join("\n");
    } else {
      run = [];
    }
  }
  return undefined;
}

// ---- 파일 유틸 (하네스 전용) ----

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function readAllText(dir: string): string {
  return listFiles(dir)
    .sort()
    .map((rel) => {
      try {
        return `--- ${rel}\n${readFileSync(path.join(dir, rel), "utf8")}`;
      } catch {
        return `--- ${rel}\n(binary)`;
      }
    })
    .join("\n");
}

function writeText(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function validateAll(fixtures: readonly LoadedFixture[]): FixtureValidationResult[] {
  return fixtures.map(validateFixture);
}
