import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SecretShapeHit } from "../types";

/**
 * 보내기 **전에** 자격증명처럼 보이는 값을 알린다 —
 * docs/design/state-machine-and-protocol.md 17.11절.
 *
 * # 왜 화면에 있어야 하는가
 *
 * Rust의 `mask_secret_shapes`는 **저장 직전**에 돈다. 그래서 감사 로그는 지키지만, 요청문과
 * 답변이 프롬프트에 실려 **모델 공급자로 나가는 것은 막지 못한다.** 나간 것은 되돌릴 수 없고,
 * 막을 수 있는 것은 보내기 전의 사용자뿐이다. 그러니 알려주는 것 말고 할 수 있는 일이 없다.
 *
 * # 판정은 Rust가 한다
 *
 * 모양 목록을 여기 복사하지 않는다. 두 목록은 반드시 갈라지고, 그러면 화면이 경고하지 않는
 * 것을 Rust가 가리거나 그 반대가 된다 — 둘 다 사용자를 잘못 안심시킨다. UI는 텍스트를 넘기고
 * 이름과 개수만 돌려받는다(**값은 돌려받지 않는다** — 이미 갖고 있고, 경계를 넘길수록 사본만 는다).
 *
 * # 막지 않는다
 *
 * 경고만 하고 전송은 그대로 열어둔다. 자격증명 모양이 진짜 요구의 일부일 수 있고
 * ("`sk-` 로 시작하는 키를 거부해야 한다"), 무엇이 자기 요구인지는 사용자가 판정한다
 * (CLAUDE.md 원칙 1 — 요구에 대한 최종 권위는 사용자다). 대신 버튼 문구를 바꿔
 * **그대로 보내는 중이라는 사실**은 눈에 남긴다.
 */
const DEBOUNCE_MS = 300;

/**
 * 입력이 멈춘 뒤에만 검사한다. 키를 칠 때마다 프로세스 경계를 넘기면 편집 중인 텍스트가
 * 왕복하는 횟수만 늘고, 검사 결과는 어차피 마지막 것만 쓰인다.
 */
export function useSecretShapeScan(text: string): SecretShapeHit[] {
  const [hits, setHits] = useState<SecretShapeHit[]>([]);

  useEffect(() => {
    if (text.trim().length === 0) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<{ hits: SecretShapeHit[] }>("scan_input_for_secret_shapes", { text })
        .then((result) => {
          if (!cancelled) setHits(result.hits ?? []);
        })
        // 검사에 실패해도 입력을 막지 않는다. 이건 편의 경고이고, 실제 방어(저장 시 마스킹)는
        // 여기와 무관하게 Rust에서 돈다 — 실패를 오류로 띄우면 사용자가 할 수 있는 일이 없다.
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  return hits;
}

export function SecretShapeWarning({ hits }: { hits: SecretShapeHit[] }) {
  if (hits.length === 0) return null;
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  return (
    <div className="warn small">
      <p>
        <strong>자격증명처럼 보이는 값이 {total}개 있습니다</strong> (
        {hits.map((hit) => `${hit.label} ${hit.count}개`).join(", ")}).
      </p>
      <p>
        보내면 <strong>모델 공급자에게 그대로 전달됩니다.</strong> 저장 기록에서는 가려지지만, 나간 것은 되돌릴 수
        없습니다. 필요한 값이 아니라면 지우고 다시 쓰세요.
      </p>
      {/* "검사했으니 안전하다"를 만들지 않는다 — 이 목록은 완결되지 않으며, 그 사실을
          경고 안에서 말하지 않으면 경고가 없는 것이 곧 안전으로 읽힌다. */}
      <p className="muted">아는 모양만 찾습니다. 여기 걸리지 않았다고 자격증명이 없는 것은 아닙니다.</p>
    </div>
  );
}
