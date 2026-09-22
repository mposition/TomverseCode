import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **Fleet 합계 예약의 단계 분할은 두 루프에서 같아야 한다** — state-machine 72.12·72.16절.
 *
 * # 왜 이 검사가 필요한가
 *
 * 스케줄링 루프가 둘이다: 화면(`apps/desktop/src-tauri/src/session.rs`)과 헤드리스
 * (`core/src/bin/host.rs`). 72.16절이 이 변경을 "한 번에" 하라고 적은 이유가 그것이고,
 * 근거는 **두 곳을 다르게 고치면 화면과 헤드리스의 예산이 갈린다**는 것이다.
 *
 * 갈린 예산은 **화면에서 드러나지 않는다.** 둘 다 각자 그럴듯한 숫자를 말하고, 어느 쪽이
 * 틀렸는지는 공급자 청구 내역을 봐야 안다. 그래서 이 검사는 "한 번에 고쳤다"를 지금 확인하는
 * 것이 아니라, **다음에 한쪽만 고치는 것**을 막는다.
 *
 * # 무엇을 검사하는가
 *
 * 판정이 `fleet.rs` 하나에만 있다는 것. 구체적으로:
 *
 * 1. 두 루프 모두 `PlanApprovalWatch`를 지나 승인을 관측한다 — 자기 자리에서 `PLAN_APPROVED`
 *    문자열을 직접 찾지 않는다. 직접 찾기 시작하면 payload를 읽는 규칙(`unpricedAssignments`를
 *    "모르는 것"으로 다루는 것)이 두 벌이 되고, 둘 중 하나는 언젠가 덜 조심스러워진다.
 * 2. 두 루프 모두 `reserve_implementation`을 부른다 — 예약 산수를 자기 자리에서 하지 않는다.
 * 3. 어느 루프도 `PLANNING_SHARE`를 직접 쓰지 않는다. 쓰기 시작하면 비율이 상한의 뜻을
 *    정하게 되고, 그것이 이 분할의 첫 판이 실패한 이유다(`fleet.rs`의 머리말).
 *
 * # 무엇을 검사하지 못하는가
 *
 * 두 루프가 **같은 순간에** 그 함수를 부르는가. 호출 시점은 글자가 아니라 제어 흐름의 문제이고,
 * 그건 `fleet.rs`의 단위 테스트와 Fleet e2e가 각자의 자리에서 본다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 컴파일된 자리는 `packages/toolchain/dist/test`다 — 소스 트리가 아니라 그곳에서 센다.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const LOOPS = {
  "session.rs (화면)": path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "src", "session.rs"),
  "bin/host.rs (헤드리스)": path.join(
    REPO_ROOT,
    "apps",
    "desktop",
    "src-tauri",
    "core",
    "src",
    "bin",
    "host.rs"
  ),
} as const;

const FLEET_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "fleet.rs");

/** 검사 대상 토큰을 assertion 안에 그대로 적으면 자기 자신을 센다 — 런타임에 조립한다. */
const APPROVAL_EVENT = "PLAN" + "_APPROVED";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * 줄 주석을 뺀 소스. **주석이 검사에 걸리면 안 된다** — 이 파일이 막으려는 것은 승인을
 * *찾아내는 코드*이지, 무엇을 받았는지 설명하는 문장이 아니다. 문장까지 막으면 다음 사람이
 * 검사를 통과시키려고 **설명을 지우게** 되고, 그건 이 저장소가 정확히 반대로 하려는 일이다.
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

test("두 스케줄링 루프가 같은 감시를 쓴다 — 승인을 각자 찾아내지 않는다", () => {
  for (const [label, file] of Object.entries(LOOPS)) {
    const source = read(file);
    assert.ok(
      source.includes("PlanApprovalWatch::new"),
      `${label}가 공유 감시(PlanApprovalWatch)를 쓰지 않습니다 — 승인 관측이 두 벌이 됩니다`
    );
    assert.ok(
      !codeOnly(source).includes(APPROVAL_EVENT),
      `${label}가 승인 이벤트 이름을 직접 봅니다 — payload를 읽는 규칙이 두 벌이 됩니다`
    );
  }
});

test("두 스케줄링 루프가 예약 산수를 하지 않는다 — 원장이 한다", () => {
  for (const [label, file] of Object.entries(LOOPS)) {
    const source = read(file);
    assert.ok(
      source.includes("reserve_implementation("),
      `${label}가 구현 예약을 원장에 맡기지 않습니다`
    );
    assert.ok(
      !codeOnly(source).includes("PLANNING_SHARE"),
      `${label}가 계획 몫 비율을 직접 씁니다 — 측정하지 않은 상수가 상한의 뜻을 정하게 됩니다`
    );
  }
});

test("상한 판정은 계획 몫이 아니라 태스크당 상한 전부를 본다", () => {
  // 첫 판이 이것을 어겼고 `the_aggregate_cap_is_never_exceeded…`가 잡았다. 그 사실을
  // 소스에서도 고정해 둔다 — `try_admit`이 거부를 판정할 때 쓰는 값은 `per_task`다.
  const source = read(FLEET_RS);
  const admit = source.slice(source.indexOf("pub fn try_admit("));
  const body = admit.slice(0, admit.indexOf("\n    }\n"));
  assert.ok(
    body.includes("+ per_task > cap"),
    "try_admit이 태스크당 상한 전부로 판정하지 않습니다 — 분할이 상한을 느슨하게 만듭니다"
  );
  assert.ok(
    !body.includes("planning > cap") && !body.includes("+ planning >"),
    "try_admit이 계획 몫으로 판정합니다 — 상한이 PLANNING_SHARE만큼 느슨해집니다"
  );
});

test("구현 예약은 거절하지 않는다 — 승인된 작업을 예산으로 멈추지 않기 때문이다(72.12절)", () => {
  const source = read(FLEET_RS);
  const fn = source.slice(source.indexOf("pub fn reserve_implementation("));
  const body = fn.slice(0, fn.indexOf("\n    }\n"));
  // 거절 경로가 생기면 그 자리에 교착이 함께 생긴다(모두가 서로의 정산을 기다린다).
  assert.ok(
    !body.includes("Refused"),
    "구현 예약이 거절할 수 있게 됐습니다 — 승인된 작업이 서고, 교착이 생깁니다"
  );
});
