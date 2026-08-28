import test from "node:test";
import assert from "node:assert/strict";

import {
  applyNotice,
  conflictNotice,
  draftAfterSubmit,
  sourceLabel,
  storeNotice,
  submitState,
  type CredentialStoreInfo,
  type ProviderCredential,
} from "../src/lib/credentialDraft.js";

function store(kind: CredentialStoreInfo["kind"]): CredentialStoreInfo {
  return kind === "windowsCredentialManager"
    ? {
        kind,
        label: "Windows Credential Manager (DPAPI)",
        isDevelopmentOnly: false,
        survivesRestart: true,
      }
    : {
        kind,
        label: "개발용 메모리 저장소 — 디스크에 쓰지 않고 앱을 끄면 사라진다",
        isDevelopmentOnly: true,
        survivesRestart: false,
      };
}

function provider(over: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    providerId: "openai",
    envName: "OPENAI_API_KEY",
    configured: false,
    source: null,
    conflict: false,
    ...over,
  };
}

/**
 * **초안은 언제나 비워진다.**
 *
 * 규칙에 이름이 있어야 실패 경로에서 빠뜨리지 않는다 — 실패 시 값을 남기면 재입력은 편하지만
 * UI 프로세스가 키를 계속 들고 있게 되고, 그건 원칙 3이 이미 거절한 거래다.
 */
test("제출 후 초안은 성공·실패와 무관하게 빈 문자열이다", () => {
  assert.equal(draftAfterSubmit(), "");
});

test("빈 초안은 제출할 수 없고, 왜인지 말한다", () => {
  assert.deepEqual(submitState(""), { canSubmit: false, reason: "키를 입력하세요." });
  assert.deepEqual(submitState("   "), { canSubmit: false, reason: "키를 입력하세요." });
  assert.deepEqual(submitState("sk-x"), { canSubmit: true, reason: null });
});

/**
 * **문구가 저장소 종류에서 유도된다.**
 *
 * 종전 화면은 "개발용 임시 방식"을 상수로 띄웠다. 그래서 저장소를 만들어도 그 문장이 남았을
 * 것이고, 사실을 말하지 않는 화면은 없는 것보다 나쁘다.
 */
test("프로덕션 저장소에서는 개발용 경고를 하지 않는다", () => {
  assert.equal(storeNotice(store("windowsCredentialManager")), null);
});

test("개발용 저장소에서는 그 사실과 사라진다는 것을 함께 말한다", () => {
  const notice = storeNotice(store("developmentInMemory"));
  assert.ok(notice, "개발용인데 아무 말도 하지 않았습니다");
  assert.ok(notice.includes("앱을 끄면 사라집니다"), notice);
});

test("출처를 뭉개지 않는다 — 저장소와 환경변수는 다른 사실이다", () => {
  assert.equal(sourceLabel(provider()), "미설정");
  assert.equal(sourceLabel(provider({ configured: true, source: "store" })), "설정됨 (저장소)");
  assert.equal(sourceLabel(provider({ configured: true, source: "environment" })), "설정됨 (환경변수)");
  // 설정됐다는데 출처가 없으면 그 사실을 말한다 — 정상처럼 보여주지 않는다.
  assert.equal(sourceLabel(provider({ configured: true, source: null })), "설정됨 (출처 불명)");
});

/**
 * **충돌은 조용하지 않다.**
 *
 * 저장소를 쓴다는 사실을 말하지 않으면 "앱에서 키를 바꿨는데 예전 키로 호출된다"는 의심이
 * 남고, 그 의심은 확인할 방법이 없다.
 */
test("충돌이 없으면 아무 말도 하지 않는다", () => {
  assert.equal(conflictNotice([provider({ configured: true, source: "store" })]), null);
});

test("충돌하면 어느 공급자인지와 어느 쪽을 쓰는지를 말한다", () => {
  const notice = conflictNotice([
    provider({ configured: true, source: "store", conflict: true }),
    provider({ providerId: "anthropic", envName: "ANTHROPIC_API_KEY", configured: true, source: "store" }),
  ]);
  assert.ok(notice, "충돌인데 아무 말도 하지 않았습니다");
  assert.ok(notice.includes("openai"), notice);
  assert.ok(!notice.includes("anthropic"), `충돌하지 않은 공급자가 섞였습니다: ${notice}`);
  assert.ok(notice.includes("저장소의 값을 씁니다"), notice);
});

/**
 * **주입이 1회라는 사실을 화면이 말한다.**
 *
 * 말하지 않으면 "키를 넣었는데 왜 그대로지"가 생기고, 사용자는 자기가 뭔가 잘못했다고 믿는다.
 */
test("저장 결과는 언제부터 적용되는지를 말한다", () => {
  assert.ok(applyNotice({ appliesToNextSpawn: true })?.includes("워크스페이스를 열 때"));
  assert.equal(applyNotice({}), null);
});
