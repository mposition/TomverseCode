import type { Transmission } from "../types";

/**
 * 데이터 전송 투명성 — **무엇이 어느 공급자로 나갔는가** (product-strategy.md 7절).
 *
 * # 이 화면이 지켜야 하는 두 가지
 *
 * 둘 다 "정직하게 쓰지 않으면 정반대로 읽히는" 자리다.
 *
 * **① 제외된 파일도 이름은 나갔다.** `.env` 같은 파일은 내용이 컨텍스트에 들어가지 않지만,
 * 프롬프트에는 "다음은 일부러 제외했다"는 목록으로 **경로와 사유가 실린다**(모델이 그 파일을
 * 있다고 착각해 추측하는 것을 막기 위해서다). 그래서 "Local only"라고만 쓰면 안 된다 —
 * 경로도 안 나간 것으로 읽힌다.
 *
 * **③ 파일만 보여주면 "이것만 나갔다"로 읽힌다.** 프롬프트에는 프로젝트 규칙 파일의 **전문**과
 * 커밋되지 않은 변경 요약(선정되지 않은 파일의 경로를 포함한다)이 함께 실린다. 한동안 이
 * 화면은 그것들을 말하지 않았고, 그래서 자기 `CLAUDE.md`가 나가지 않았다고 믿게 만들었다
 * (7.2절).
 *
 * **② 마스킹은 저장 기록에만 걸린다.** `secretShapesMaskedInLog`는 DB에 남기기 전에 가린
 * 개수이고, 같은 답변은 프롬프트에 **원문으로** 실려 나갔다(17.11절). 이 숫자를 그냥 올리면
 * "가려져서 안 나갔다"로 읽히는데 정반대다.
 *
 * # 스냅샷이 없는 것과 "아무것도 안 나갔다"를 구별한다
 *
 * 빈 목록이 곧 안전은 아니다. 아직 컨텍스트를 모은 적이 없는 것과 모았는데 아무것도 고르지
 * 않은 것은 다른 사실이고, 화면이 그걸 뭉개면 거짓 안심을 준다.
 */
export function TransmissionPanel({ transmission }: { transmission: Transmission }) {
  const { providers, sentFiles, namedOnlyFiles, sentContext } = transmission;

  if (!transmission.snapshotTaken) {
    return (
      <div className="panel">
        <h2>무엇이 나갔는가</h2>
        <p className="muted small">
          아직 컨텍스트를 모은 적이 없습니다. <strong>"아무것도 나가지 않았다"와는 다른 상태입니다</strong> —
          작업이 컨텍스트 수집 전에 끝났다는 뜻입니다.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>무엇이 나갔는가</h2>
      <p className="muted small">
        이 작업에서 모델 공급자에게 실제로 전송된 것입니다. 모든 호출이 같은 컨텍스트를 싣기 때문에,
        아래 파일은 <strong>각 공급자 모두에게</strong> 갔습니다.
      </p>

      <h3>공급자</h3>
      {providers.length === 0 ? (
        <p className="muted small">호출된 공급자가 없습니다.</p>
      ) : (
        <ul className="transmission-providers">
          {providers.map((p) => (
            <li key={p.providerId}>
              <strong>{p.providerId}</strong> — {p.calls}회 호출, 입력 {p.inputTokens.toLocaleString()} 토큰 / 출력{" "}
              {p.outputTokens.toLocaleString()} 토큰
              <div className="muted small">
                역할: {p.roles.join(", ") || "(없음)"} · 요청한 모델: {p.models.join(", ") || "(없음)"}
              </div>
              {/* **조용한 대체를 화면이 지우지 않는다**(product-strategy 6절). 요청한 모델만
                  보여주면 공급자가 다른 모델로 답한 사실이 사라지는데, 감사 기록에서 그건
                  빠뜨림이 아니라 거짓말에 가깝다. */}
              {p.substituted ? (
                <div className="warn small">
                  <strong>요청한 것과 다른 모델이 응답했습니다</strong> — 실제 응답:{" "}
                  {p.resolvedModels.join(", ")}
                </div>
              ) : (
                p.resolvedModels.length > 0 && (
                  <div className="muted small">응답한 모델: {p.resolvedModels.join(", ")}</div>
                )
              )}
              {/* 비어 있는 것은 "같았다"가 아니라 "모른다"이므로 그렇게 말한다. */}
              {p.resolvedModels.length === 0 && (
                <div className="muted small">
                  응답한 모델을 기록하지 못했습니다 — 같았다는 뜻이 아니라 확인할 수 없다는 뜻입니다.
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>내용까지 나간 파일 ({sentFiles.length}개)</h3>
      {sentFiles.length === 0 ? (
        <p className="muted small">없습니다.</p>
      ) : (
        <ul className="transmission-files">
          {sentFiles.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code>
              {f.truncated && <span className="badge badge-required">일부만</span>}
              <div className="muted small">{f.reason}</div>
            </li>
          ))}
        </ul>
      )}

      {sentContext.length > 0 && (
        <>
          <h3>파일 목록에 없지만 함께 나간 것</h3>
          {/* ③ — 파일 목록이 "전부"로 읽히지 않도록 같은 화면에 둔다. */}
          <p className="muted small">
            아래는 컨텍스트 선정을 거치지 않고 <strong>매 호출에 함께 실리는 내용</strong>입니다.
          </p>
          <ul className="transmission-files">
            {sentContext.map((c) => (
              <li key={c.section}>
                <code>{c.section}</code> <span className="muted small">({c.bytes.toLocaleString()}자)</span>
                <div className="muted small">{c.detail}</div>
                {c.sources.length > 0 && (
                  <div className="muted small">
                    출처: {c.sources.map((p) => <code key={p}>{p}</code>).reduce((a, b) => <>{a}, {b}</>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {namedOnlyFiles.length > 0 && (
        <>
          <h3>이름만 나간 파일 ({namedOnlyFiles.length}개)</h3>
          {/* ① — "Local only"로 뭉뚱그리지 않는다. */}
          <p className="muted small">
            내용은 전송되지 않았습니다. 다만 <strong>경로와 제외 사유는 프롬프트에 포함됩니다</strong> — 모델이 그
            파일이 없다고 보고 내용을 추측하는 것을 막기 위해서입니다.
          </p>
          <ul className="transmission-files">
            {namedOnlyFiles.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <div className="muted small">{f.reason}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {(transmission.freeTextAnswers > 0 || transmission.secretShapesMaskedInLog > 0) && (
        <>
          <h3>직접 입력한 답변</h3>
          {/* ② — 마스킹 수를 "안 나갔다"로 읽히게 두지 않는다. */}
          <p className="muted small">
            사용자가 직접 쓴 답변 {transmission.freeTextAnswers}건이 <strong>원문 그대로</strong> 프롬프트에
            포함됐습니다.
            {transmission.secretShapesMaskedInLog > 0 && (
              <>
                {" "}
                자격증명처럼 보이는 값 {transmission.secretShapesMaskedInLog}개는{" "}
                <strong>저장 기록에서만 가려졌습니다</strong> — 전송된 것은 가려지지 않은 원문입니다.
              </>
            )}
          </p>
        </>
      )}

      <p className="muted small">
        여기까지가 우리가 아는 사실입니다. 공급자가 전송받은 것을 어떻게 보관하거나 학습에 쓰는지는 각 공급자의
        정책에 달려 있고, 이 화면이 답할 수 있는 범위가 아닙니다.
      </p>
    </div>
  );
}
