/**
 * 자격증명 입력의 **순수 로직** — 화면(tsx)이 아니라 여기서 판정한다.
 *
 * 계산이 화면 안에 있으면 검증할 방법이 없다(`apps/desktop/test`가 도는 이유). 그리고 이
 * 화면의 계산은 **원칙 3의 실체**다: 입력한 키를 언제 버리는가, 화면이 저장소에 대해 무엇을
 * 말하는가.
 *
 * # 이 모듈이 지키는 것
 *
 * 1. **초안은 제출 직후 비운다 — 실패해도.** UI 프로세스가 키를 들고 있는 시간을 요청 한 번의
 *    수명으로 줄이는 것이 목적이다(착지 기준 `uiNeverHoldsTheKey`). 실패 시 남겨 두면 재입력이
 *    편하지만, 그 편의의 대가가 "화면이 키를 계속 들고 있다"이다 — 원칙 3이 그 거래를 이미 정했다.
 * 2. **문구를 저장소 종류에서 유도한다.** 종전 화면은 "개발용 임시 방식"을 **상수로** 띄웠고,
 *    그래서 저장소를 만들어도 그 문장이 남았을 것이다. 사실을 말하지 않는 화면은 없는 것보다 나쁘다.
 */

/** Rust `credentials::StoreKind`의 직렬화 형태. */
export type CredentialStoreKind = "windowsCredentialManager" | "developmentInMemory";

/** Rust `CredentialSource`의 직렬화 형태. */
export type CredentialSource = "store" | "environment";

export interface CredentialStoreInfo {
  kind: CredentialStoreKind;
  label: string;
  /** 화면이 "개발용"이라고 말해야 하는가. **Rust가 저장소 종류에서 유도한다.** */
  isDevelopmentOnly: boolean;
  /** 앱을 다시 켜도 남는가. `false`면 넣은 키가 사라지는 것을 사용자가 버그로 읽는다. */
  survivesRestart: boolean;
}

export interface ProviderCredential {
  providerId: string;
  envName: string;
  configured: boolean;
  /** 어디서 왔는가. 없으면 `null`. */
  source: CredentialSource | null;
  /** 저장소와 환경변수에 **서로 다른 값**이 있다. */
  conflict: boolean;
}

/**
 * 제출 직후의 초안. **언제나 빈 문자열이다.**
 *
 * 함수로 두는 이유는 값을 계산하기 위해서가 아니라 **규칙에 이름을 주기 위해서**다 —
 * 화면에서 `setDraft("")`로 흩어져 있으면 한 자리를 빠뜨려도 아무도 모른다. 실패 경로에서
 * 이 함수를 부르지 않는 것이 정확히 그 실수다.
 */
export function draftAfterSubmit(): string {
  return "";
}

/** 저장 버튼을 누를 수 있는가. 누를 수 없으면 **왜인지** 함께 준다. */
export function submitState(draft: string): { canSubmit: boolean; reason: string | null } {
  if (draft.trim().length === 0) {
    return { canSubmit: false, reason: "키를 입력하세요." };
  }
  return { canSubmit: true, reason: null };
}

/**
 * 저장소에 대해 화면이 말해야 하는 문장. 없으면 `null`.
 *
 * 프로덕션 저장소일 때 아무 말도 하지 않는 것이 의도다 — 정상 상태를 매번 알리면 그 자리가
 * 배경음이 되고, 정작 개발용으로 돌고 있을 때의 경고가 묻힌다.
 */
export function storeNotice(store: CredentialStoreInfo): string | null {
  if (!store.isDevelopmentOnly) return null;
  const persistence = store.survivesRestart
    ? ""
    : " 넣은 키는 **앱을 끄면 사라집니다** — 계속 쓰려면 환경변수를 설정하세요.";
  return `자격증명 저장소가 ${store.label}입니다. 이 플랫폼에는 Windows Credential Manager가 없습니다.${persistence}`;
}

/** 한 공급자의 출처를 사람 말로. */
export function sourceLabel(provider: ProviderCredential): string {
  if (!provider.configured) return "미설정";
  if (provider.source === "store") return "설정됨 (저장소)";
  if (provider.source === "environment") return "설정됨 (환경변수)";
  // 설정됐다는데 출처가 없다 — 사실대로 말한다. 조용히 "설정됨"으로 뭉개면 어느 값이 쓰이는지
  // 알 수 없는 상태를 정상처럼 보여주게 된다.
  return "설정됨 (출처 불명)";
}

/**
 * 저장소와 환경변수가 **다른 값**을 들고 있는 공급자에 대한 경고. 없으면 `null`.
 *
 * 차단하지 않는 이유는 Rust 쪽에 적혀 있다(`CredentialPresence.conflict`): 예전에 설정해 둔
 * 환경변수 하나 때문에 앱이 아무것도 못 하게 되는 편이 나쁘다. 대신 **어느 쪽이 쓰이는지를
 * 말한다** — 그것을 말하지 않으면 "앱에서 키를 바꿨는데 예전 키로 호출된다"는 의심이 남는다.
 */
export function conflictNotice(providers: ProviderCredential[]): string | null {
  const clashing = providers.filter((p) => p.conflict).map((p) => `${p.providerId}(${p.envName})`);
  if (clashing.length === 0) return null;
  return (
    `${clashing.join(", ")}의 키가 저장소와 환경변수에 서로 다른 값으로 있습니다. ` +
    "저장소의 값을 씁니다 — 환경변수를 지우거나 저장소의 키를 지워 하나만 남기세요."
  );
}

/**
 * 저장/삭제 결과를 사람 말로.
 *
 * `appliesToNextSpawn`을 말하지 않으면 **"키를 넣었는데 왜 그대로지"**가 생긴다. 주입은
 * sidecar spawn 시 1회이므로(원칙 2), 이미 떠 있는 백엔드의 환경은 바뀌지 않는다.
 */
export function applyNotice(result: { appliesToNextSpawn?: boolean }): string | null {
  if (!result.appliesToNextSpawn) return null;
  return "다음에 워크스페이스를 열 때부터 적용됩니다 — 자격증명은 백엔드를 띄울 때 한 번만 전달됩니다.";
}
