/**
 * 응답 envelope에서 **공급자가 말한 사실**을 뽑는다.
 *
 * # 왜 공유 모듈인가
 *
 * 이 함수는 openai.ts와 anthropic.ts에 **글자 그대로 복사되어 있었다.** 두 벌이 있으면 언젠가
 * 한쪽만 고쳐지고, 그 순간 "어댑터는 서로 바꿔 끼울 수 있다"는 전제가 조용히 깨진다 —
 * 가설 게이트의 비교는 그 전제 위에 서 있다(multi-engine-routing.md 2절).
 *
 * # 요청 ID로 대체하지 않는다
 *
 * envelope에 model이 없으면 `undefined`다. 우리가 요청한 ID로 채우면 exact-model 검증이
 * **항상 통과한다** — 즉 조용한 대체를 절대 잡지 못한다(10.8절). 모르는 것은 모르는 채로 둔다.
 */
export function envelopeIdentity(envelope: unknown): {
  providerReportedModelId?: string;
  providerRequestId?: string;
} {
  const candidate = envelope as { model?: unknown; id?: unknown };
  const out: { providerReportedModelId?: string; providerRequestId?: string } = {};
  if (typeof candidate.model === "string" && candidate.model.length > 0) {
    out.providerReportedModelId = candidate.model;
  }
  if (typeof candidate.id === "string" && candidate.id.length > 0) out.providerRequestId = candidate.id;
  return out;
}
