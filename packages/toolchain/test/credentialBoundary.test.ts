import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **Credential Store가 생겨도 키가 가는 길은 늘어나지 않는다** —
 * 착지 기준 `injectionStaysOnce`·`uiNeverHoldsTheKey`
 * (docs/design/multi-engine-routing.md 12절, `core/src/landing.rs`).
 *
 * # 왜 이 검사가 필요한가
 *
 * 저장소를 만드는 일은 "키를 읽는 코드"를 처음으로 정당하게 만든다. 그 순간부터
 * **읽는 자리를 하나 더 만들고 싶어진다**: sidecar가 런타임에 물어보게 하면 재spawn이 필요
 * 없고, Tauri command가 값을 돌려주면 화면에서 마스킹해 보여줄 수 있다. 둘 다 그럴듯하고,
 * 둘 다 신뢰 모델을 무너뜨린다 — 앞은 "Node가 장악당해도"를 지우고(process-architecture 2절),
 * 뒤는 "UI 프로세스는 API 키를 갖지 않는다"를 지운다(원칙 3).
 *
 * 착지 기준은 그 자리를 **산문으로** 못박아 두었다. 산문은 검사가 아니다. 이 파일이 검사다.
 *
 * # 무엇을 검사하고 무엇을 검사하지 않는가
 *
 * 검사하는 것: 키를 읽는 코드가 **어디에 있는가**. 값이 흐르는 방향은 소스에서 유도할 수 있다.
 *
 * 검사하지 못하는 것: 값이 **다른 경로로** 새는 것(이벤트 payload에 실린다든가). 그건 Rust
 * 쪽에서 타입이 막고 있고(`Secret`은 `Display`도 `Serialize`도 없다 — 아래에서 그 사실 자체를
 * 확인한다), 여기서 잡을 수 있는 종류가 아니다.
 *
 * # 왜 toolchain에 두는가
 *
 * 대상이 세 워크스페이스에 걸쳐 있다(core Rust / 껍데기 Rust / sidecar TypeScript).
 * 저장소 전체를 대조하는 검사가 이미 여기 있다(`policyBridge.test.ts`, `rustOnlyEvents.test.ts`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const CORE_SRC = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src");
const SHELL_SRC = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "src");
const SIDECAR_SRC = path.join(REPO_ROOT, "packages", "sidecar", "src");

const HOST_RS = path.join(CORE_SRC, "host.rs");
const CREDENTIALS_RS = path.join(CORE_SRC, "credentials.rs");

function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, extensions));
    else if (extensions.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** `//` 줄 주석을 지운다 — 규칙을 **설명하는 주석**이 위반으로 잡히면 안 된다. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
      return line;
    })
    .join("\n");
}

function occurrences(source: string, needle: string): number {
  let count = 0;
  let at = source.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = source.indexOf(needle, at + needle.length);
  }
  return count;
}

test("검사 대상 소스를 실제로 읽는다 — 빈 집합에 대해 통과하지 않는다", () => {
  assert.ok(filesUnder(CORE_SRC, [".rs"]).length > 20, "core 소스를 읽지 못했습니다");
  assert.ok(filesUnder(SHELL_SRC, [".rs"]).length >= 2, "껍데기 소스를 읽지 못했습니다");
  assert.ok(filesUnder(SIDECAR_SRC, [".ts"]).length > 5, "sidecar 소스를 읽지 못했습니다");
});

/**
 * **`credential.get`은 되살아나지 않는다.**
 *
 * process-architecture 8.2절이 지운 메서드다. 저장소가 생기면 "Node가 필요할 때 물어보면
 * 되지 않나"가 자연스러워지는데, 그 순간 "Node가 완전히 장악당해도"라는 전제가 사라진다 —
 * 주입은 우리가 고른 것만 한 번 보내는 것이고, 요청은 Node가 언제든 무엇이든 물을 수 있는 것이다.
 */
test("Rust는 credential.get을 여전히 거절한다", () => {
  const source = readFileSync(HOST_RS, "utf8");
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일이 자기 자신을 세게 된다.
  const method = "credential" + ".get";
  const arm = `"${method}" =>`;
  const at = source.indexOf(arm);
  assert.notEqual(at, -1, `${HOST_RS}에 ${method} 처리가 없습니다 — 지우지 말고 거절을 남겨 두세요`);

  // 그 arm의 본문(다음 `}` 까지)이 오류를 낸다는 것을 확인한다. 조용히 `Ok(...)`로 바뀌면
  // 메서드가 되살아난 것이고, arm이 있다는 사실만으로는 그걸 구별할 수 없다.
  const body = source.slice(at, source.indexOf("\n            }", at));
  assert.ok(body.includes("Err("), `${method} arm이 더 이상 거절하지 않습니다:\n${body}`);
});

test("sidecar는 credential.get을 부르지 않는다", () => {
  const method = "credential" + ".get";
  const offenders: string[] = [];
  for (const file of filesUnder(SIDECAR_SRC, [".ts"])) {
    if (withoutComments(readFileSync(file, "utf8")).includes(method)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `sidecar가 자격증명을 런타임에 요청하고 있습니다: ${offenders.join(", ")} — ` +
      "주입은 spawn 시 1회여야 합니다(착지 기준 injectionStaysOnce)"
  );
});

/**
 * **값을 읽는 자리가 하나뿐이다.**
 *
 * 트레이트 메서드 이름이 `read_for_injection`인 것은 그 자체가 규칙이다 — 유일한 정당한
 * 호출자(주입 지점)를 이름이 가리킨다. 정의와 구현이 사는 두 파일 밖에서 부르는 곳은
 * `lib.rs`의 주입 경로 하나여야 한다.
 */
test("read_for_injection을 부르는 곳은 주입 지점 하나뿐이다", () => {
  const method = "read_for_" + "injection";
  // **호출 모양으로 찾는다.** 이름만 찾으면 `landing.rs`의 기준 문장처럼 규칙을 **적어 둔**
  // 곳이 위반으로 잡힌다 — 그러면 규칙을 문서에 쓸수록 검사가 시끄러워지고, 결국 규칙을
  // 안 쓰게 된다. 주석은 이미 지웠지만 문자열 리터럴은 지울 수 없다(지우면 안 된다).
  const callShapes = [`.${method}(`, `::${method}(`];
  // 정의(트레이트)와 구현(개발용·Windows)이 사는 파일은 대상이 아니다.
  const definitionFiles = new Set(["credentials.rs", "win_credentials.rs"]);

  const callers: string[] = [];
  for (const file of [...filesUnder(CORE_SRC, [".rs"]), ...filesUnder(SHELL_SRC, [".rs"])]) {
    if (definitionFiles.has(path.basename(file))) continue;
    const source = withoutComments(readFileSync(file, "utf8"));
    if (callShapes.some((shape) => source.includes(shape))) callers.push(path.basename(file));
  }

  assert.deepEqual(
    callers,
    ["lib.rs"],
    `자격증명 값을 읽는 자리가 늘었습니다: ${callers.join(", ")} — ` +
      "읽기는 sidecar 주입 지점 하나여야 합니다(착지 기준 uiNeverHoldsTheKey)"
  );

  // **빈 집합에 대해 통과하지 않는다**: 이름을 바꾸면 위 검사가 조용히 초록이 된다.
  const definition = readFileSync(CREDENTIALS_RS, "utf8");
  assert.ok(definition.includes(`fn ${method}`), `${method} 정의를 찾지 못했습니다`);
});

/**
 * **껍데기 크레이트는 값에 닿을 수 없다** — 원칙 3.
 *
 * 절반은 컴파일러가 이미 지킨다(`CredentialInjection::into_pairs`가 `pub(crate)`이므로
 * 다른 크레이트에서는 컴파일되지 않는다). 나머지 절반이 여기다: `Secret::expose`는 `pub`이라
 * 껍데기에서도 부를 수 있고, 부르는 순간 화면으로 나가는 길이 열린다.
 *
 * **이 크레이트는 이 개발 환경에서 컴파일되지 않을 수 있으므로**(GUI 시스템 라이브러리 부재 —
 * CLAUDE.md) 타입 검사에 기댈 수 없다. 소스를 읽는 검사가 유일한 그물이다.
 */
test("Tauri 껍데기는 자격증명 값을 꺼내지 않는다", () => {
  const forbidden = [
    { needle: "expose" + "(", why: "Secret의 값을 꺼낸다" },
    { needle: "into_" + "pairs", why: "주입 봉투를 연다" },
    { needle: "read_for_" + "injection", why: "저장소에서 값을 읽는다" },
  ];
  const violations: string[] = [];
  for (const file of filesUnder(SHELL_SRC, [".rs"])) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const [index, line] of source.split("\n").entries()) {
      for (const rule of forbidden) {
        if (line.includes(rule.needle)) {
          violations.push(`${path.basename(file)}:${index + 1} — ${rule.why}\n    ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "껍데기 크레이트가 자격증명 값에 닿고 있습니다 — 화면으로 나가는 길이 열립니다:\n" + violations.join("\n")
  );
});

/**
 * **`Secret`은 인쇄될 수 없다.**
 *
 * `Debug`는 가리도록 손으로 구현되어 있고, `Display`와 `Serialize`는 **없어야** 한다.
 * 하나라도 붙으면 `format!`/`json!`/`{}`가 값을 흘리는 경로가 되고, 그 경로는 로그·이벤트·
 * 오류 메시지 어디에나 있다. 이 저장소에는 이미 Rust 쪽 독립 secret 필터가 있지만
 * (`policy/secrets.rs`), 그건 **경로 이름과 알려진 모양**을 다루지 우리 타입을 알지 못한다.
 */
test("Secret에는 Display도 Serialize도 없다", () => {
  const source = readFileSync(CREDENTIALS_RS, "utf8");

  const debugImpl = "impl fmt::Debug for " + "Secret";
  assert.ok(source.includes(debugImpl), "Secret의 Debug 구현이 사라졌습니다 — 파생 Debug는 값을 인쇄합니다");

  for (const forbidden of ["impl fmt::Display for " + "Secret", "impl std::fmt::Display for " + "Secret"]) {
    assert.ok(!source.includes(forbidden), `Secret에 Display가 붙었습니다: ${forbidden}`);
  }

  // 파생 목록에 Serialize가 섞이는 것이 실제로 일어나는 방식이다 — 다른 타입에 붙이다가
  // 이 타입에도 붙인다. `Secret` 선언 **바로 앞의 `#[derive(...)]`**만 본다.
  // 주석을 지우고 보는 이유: 바로 위 문서 주석이 "`Serialize`도 없다"고 **설명**한다.
  const code = withoutComments(source);
  const at = code.indexOf("pub struct " + "Secret");
  assert.notEqual(at, -1, "Secret 선언을 찾지 못했습니다");
  const derive = code.slice(0, at).trimEnd();
  const lastDerive = derive.slice(derive.lastIndexOf("#[derive("));
  assert.ok(!lastDerive.includes("Serialize"), `Secret이 직렬화됩니다:\n${lastDerive}`);
});

/**
 * **주입 봉투를 여는 자리도 하나뿐이다.**
 *
 * `into_pairs`가 `pub(crate)`라 다른 크레이트는 못 열지만, core 안에서는 열 수 있다.
 * 여는 곳이 늘어나면 값이 core 안에서 흘러 다니게 되고, 그때는 컴파일러가 도와주지 않는다.
 */
test("주입 봉투를 여는 곳은 spawn 설정 조립 하나뿐이다", () => {
  const method = "into_" + "pairs";
  // 위와 같은 이유로 **호출 모양**을 본다.
  const callShapes = [`.${method}(`, `::${method}(`];
  const callers: string[] = [];
  for (const file of filesUnder(CORE_SRC, [".rs"])) {
    if (path.basename(file) === "credentials.rs") continue; // 정의와 그 단위 테스트
    const source = withoutComments(readFileSync(file, "utf8"));
    if (callShapes.some((shape) => source.includes(shape))) callers.push(path.basename(file));
  }
  assert.deepEqual(callers, ["launcher.rs"], `주입 봉투를 여는 자리가 늘었습니다: ${callers.join(", ")}`);
});

/**
 * **개발용 저장소가 프로덕션에서 조용히 쓰이지 않는다.**
 *
 * 절반은 컴파일러가 지킨다: `MemoryCredentialStore`가 `cfg(any(test, not(windows)))`이므로
 * Windows 릴리스 빌드에는 타입 자체가 없다. 그런데 그 cfg를 넓히는 것은 한 줄짜리 수정이고,
 * 넓히면 **아무 테스트도 실패하지 않는다** — 조용한 폴백은 그렇게 생긴다.
 */
test("개발용 저장소는 Windows 릴리스 빌드에서 컴파일되지 않는다", () => {
  const source = readFileSync(CREDENTIALS_RS, "utf8");
  const guard = "#[cfg(any(test, not(" + "windows)))]";
  const type = "pub struct " + "MemoryCredentialStore";

  const at = source.indexOf(type);
  assert.notEqual(at, -1, "개발용 저장소 선언을 찾지 못했습니다");
  const before = source.slice(Math.max(0, at - 400), at);
  assert.ok(
    before.includes(guard),
    `개발용 저장소가 Windows 빌드에서도 존재합니다 — 조용한 폴백이 가능해집니다:\n${before}`
  );

  // 그 구현들도 같은 가드 뒤에 있어야 한다. 하나라도 빠지면 타입만 없고 impl이 남아
  // 컴파일이 깨지거나(좋은 경우), 다른 타입에 붙어(나쁜 경우) 통과한다.
  const guards = occurrences(source, guard);
  assert.ok(guards >= 4, `개발용 저장소 가드가 ${guards}개뿐입니다 — 선언·Default·inherent·trait impl 전부 필요합니다`);
});
