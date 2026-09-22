import { test } from "node:test";
import assert from "node:assert/strict";
import { modelPathKey, participantKey, type ModelEntry } from "@tomverse/protocol";
import { BUILTIN_MODELS, providerKindOf } from "../src/routing/registry.js";

/**
 * 레지스트리 축의 **소스 검사** — multi-engine-routing.md 21.4·21.5·21.7절.
 *
 * 21.5절이 강제를 두 겹으로 둔 이유가 여기 있다. ①타입은 `endpointRegion`을 리터럴 하나로
 * 고정하고 CLI 엔트리에서 필드를 없애지만, **`local://fake` 쪽 절반은 가르지 못한다** —
 * `transport`가 `http`이고 fake를 가리는 것은 주소 스킴이라 런타임 값이지 타입 판별자가
 * 아니기 때문이다. ②가 그 절반을 맡는다.
 *
 * denylist가 완전하지 않다는 것은 인정하고 시작한다. 그래도 두는 이유는 `docStatus.test.ts`가
 * 자기 경계에 대해 적은 말 그대로다 — **검사의 목적은 판정을 대신하는 것이 아니라 가장 자주
 * 일어나는 실수를 자동으로 막는 것**이고, 여기서 가장 자주 일어날 실수는 "공급자 문서에서 첫
 * 번째로 나온 baseUrl을 복사하는 것"이다.
 */

/**
 * 알려진 국내(중국) 엔드포인트 호스트. **국제 엔드포인트만 쓴다**(21.5절).
 *
 * needle을 런타임에 조립하지 않아도 되는 이유: 이 테스트가 세는 것은 자기 소스가 아니라
 * `BUILTIN_MODELS`의 **데이터**다(CLAUDE.md 함정 기록의 "소스를 검사하는 테스트는 자기 자신을
 * 센다"는 소스 텍스트를 훑는 검사에 걸리는 이야기다).
 */
const DOMESTIC_HOSTS = [
  "dashscope.aliyuncs.com",
  "api.moonshot.cn",
  "open.bigmodel.cn",
  "api.deepseek.cn",
  "ark.cn-beijing.volces.com",
  "qianfan.baidubce.com",
  "api.baichuan-ai.com",
  "spark-api.xf-yun.com",
];

test("국내 엔드포인트를 카탈로그에 적지 않는다", () => {
  for (const entry of BUILTIN_MODELS) {
    const url = entry.apiBaseUrl ?? "";
    for (const host of DOMESTIC_HOSTS) {
      assert.ok(
        !url.includes(host),
        `${entry.modelId}의 apiBaseUrl이 국내 호스트 ${host}를 가리킵니다 — 21.5절은 국제 엔드포인트만 씁니다`
      );
    }
  }
});

/**
 * 21.5절 ②의 나머지 절반. `local://` 엔트리에 `endpointRegion`이 있으면 **그 값이 뜻을 잃는다** —
 * "확인된 국제 엔드포인트"가 아니라 "확인할 것이 없었다"이기 때문이다.
 */
test("네트워크로 나가지 않는 엔트리는 접속점 축을 갖지 않는다", () => {
  for (const entry of BUILTIN_MODELS.filter((e) => providerKindOf(e) === "fake")) {
    assert.equal(entry.endpointRegion, undefined, `${entry.modelId}: local:// 엔트리에 endpointRegion이 있습니다`);
    assert.equal(
      entry.providerJurisdiction,
      undefined,
      `${entry.modelId}: local:// 엔트리에 providerJurisdiction이 있습니다 — 나가지 않으므로 관할이 없습니다`
    );
  }
});

test("실제로 나가는 HTTP 엔트리는 접속점과 관할을 둘 다 적는다", () => {
  const real = BUILTIN_MODELS.filter((e) => providerKindOf(e) === "real");
  assert.ok(real.length > 0, "실제 공급자가 하나도 없으면 이 검사가 공허합니다");
  for (const entry of real) {
    assert.equal(entry.endpointRegion, "international", `${entry.modelId}: 접속점이 international이 아닙니다`);
    assert.ok(
      (entry.providerJurisdiction ?? []).length > 0,
      `${entry.modelId}: 관할 목록이 비어 있습니다 — 우리가 못 고르는 사실이지만 표시는 해야 합니다`
    );
  }
});

/**
 * 21.7절의 하드 규칙 셋. **`BUILTIN_MODELS`에 CLI 줄이 아직 없어도 검사한다** — 카탈로그가
 * 비어 있다고 규칙을 검사하지 않으면, CLI 줄을 추가하는 사람이 규칙이 있다는 사실조차 모른다.
 * 비어 있는 동안 이 테스트는 합성 엔트리 없이 "없다"만 확인하고, 줄이 들어오는 순간 발동한다.
 */
test("CLI 엔트리는 접속점을 고르지 못하므로 그 축을 적지 않는다", () => {
  for (const entry of BUILTIN_MODELS.filter((e) => e.transport === "cli")) {
    assert.equal(
      entry.endpointRegion,
      undefined,
      `${entry.modelId}: CLI 엔트리에 endpointRegion이 있습니다 — 어디로 보내는지는 그 CLI가 정합니다`
    );
    assert.equal(entry.apiBaseUrl, undefined, `${entry.modelId}: CLI 엔트리에 apiBaseUrl이 있습니다`);
    assert.ok(entry.cliVendor, `${entry.modelId}: CLI 엔트리에 cliVendor가 없으면 경로 키가 결정되지 않습니다`);
    assert.equal(
      (entry.providerJurisdiction ?? []).length,
      2,
      `${entry.modelId}: 중개자는 관할을 하나 더 만듭니다 — [중개자, 공급자] 둘이어야 합니다(21.7절)`
    );
  }
});

/**
 * **CLI 엔트리에 독립된 `providerId`를 주지 않는다**(21.7절 첫머리).
 *
 * 주면 독립성 불변식이 `"anthropic ≠ claude-code-cli"`를 참으로 읽고, 같은 모델에게 초안과
 * 검수를 맡기고 "독립 검증"이라고 기록한다. **이 오독은 조용하다** — 원칙 4가 깨져도 화면은
 * "독립 검증함"을 표시한다.
 */
test("CLI 이름이 providerId로 새어 들어오지 않는다", () => {
  const httpProviders = new Set(
    BUILTIN_MODELS.filter((e) => e.transport === "http").map((e) => e.providerId)
  );
  for (const entry of BUILTIN_MODELS.filter((e) => e.transport === "cli")) {
    assert.ok(
      httpProviders.has(entry.providerId),
      `${entry.modelId}: CLI 엔트리의 providerId(${entry.providerId})가 HTTP 경로에 없습니다 — ` +
        "CLI는 전송 수단이지 공급자가 아닙니다(21.7절)"
    );
    for (const vendor of ["codex", "claude-code", "cursor", "cli"]) {
      assert.ok(
        !entry.providerId.includes(vendor),
        `${entry.modelId}: providerId에 CLI 이름(${vendor})이 들어 있습니다`
      );
    }
  }
});

/** 경로가 키다 — 같은 키가 두 줄이면 어느 쪽이 쓰이는지 정해지지 않는다(21.4절). */
test("경로 키가 카탈로그 안에서 유일하다", () => {
  const seen = new Map<string, string>();
  for (const entry of BUILTIN_MODELS) {
    const key = modelPathKey(entry);
    const prev = seen.get(key);
    assert.equal(prev, undefined, `경로 키가 겹칩니다: ${entry.modelId} (이미 ${prev})`);
    seen.set(key, entry.modelId);
  }
});

/**
 * 21.7절: **등급은 HTTP 경로에서 재고 CLI 경로는 물려받는다.**
 *
 * 물려받았다는 사실을 적어두지 않으면 나중에 CLI 실행 기록이 측정에 섞인다 — 게이트가 fake
 * 기록을 섞지 않으려고 `providerKind`를 남긴 것과 같은 걱정이고, 같은 수법으로 막는다.
 */
test("CLI 경로의 등급은 물려받은 것임을 적는다", () => {
  const byParticipant = new Map<string, ModelEntry[]>();
  for (const entry of BUILTIN_MODELS) {
    const key = participantKey(entry);
    byParticipant.set(key, [...(byParticipant.get(key) ?? []), entry]);
  }
  for (const entry of BUILTIN_MODELS.filter((e) => e.transport === "cli")) {
    if (entry.grade === "unmeasured") continue;
    assert.ok(
      entry.gradeInheritedFrom,
      `${entry.modelId}(${entry.cliVendor}): CLI 경로에 등급이 붙어 있는데 어디서 물려받았는지가 없습니다`
    );
    const source = byParticipant
      .get(participantKey(entry))
      ?.find((e) => modelPathKey(e) === entry.gradeInheritedFrom);
    assert.ok(
      source && source.transport === "http",
      `${entry.modelId}: gradeInheritedFrom이 가리키는 HTTP 경로가 카탈로그에 없습니다`
    );
    assert.equal(source.grade, entry.grade, `${entry.modelId}: 물려받은 등급이 원본과 다릅니다`);
  }
});

/**
 * 21.4절: 확인하지 않은 값을 적지 않는다.
 *
 * effort 파라미터의 공급자별 이름·단위·허용값은 **아직 확인되지 않았다**(21.9절). 확인 전에는
 * `{ kind: "none" }`이고, 매핑을 적으려면 **확인 날짜**가 함께 있어야 한다 — `pricingAsOf`와
 * 같은 취급이다.
 */
test("effort 매핑에는 확인 날짜가 붙는다", () => {
  for (const entry of BUILTIN_MODELS) {
    if (entry.effort.kind === "none") continue;
    assert.ok(
      entry.effort.verifiedAsOf && !Number.isNaN(Date.parse(entry.effort.verifiedAsOf)),
      `${entry.modelId}: effort 매핑에 확인 날짜가 없습니다 — 추측한 파라미터는 조용히 무시됩니다`
    );
    for (const level of ["low", "medium", "high"] as const) {
      assert.ok(level in entry.effort.values, `${entry.modelId}: effort 매핑에 ${level}이 없습니다`);
    }
  }
});
