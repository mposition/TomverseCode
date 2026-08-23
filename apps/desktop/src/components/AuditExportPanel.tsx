import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unwrap, type Envelope } from "../lib/envelope";

/**
 * 감사 export — 한 작업의 기록을 형식 버전이 붙은 JSON으로 꺼낸다
 * (product-strategy.md 6.3절).
 *
 * # 왜 버튼을 눌러야 나오는가
 *
 * 전송 패널과 달리 이건 **자동으로 읽지 않는다.** 작업이 끝날 때마다 몇 MB짜리 JSON을 만들어
 * 화면에 들고 있을 이유가 없고, 이 질문("감사에 낼 기록을 다오")은 결과를 확인하는 흐름과
 * 다른 시점에 나온다.
 *
 * # 여기서 파일을 쓰지 않는다
 *
 * UI가 임의 경로에 쓸 수 있게 만들면, 모델 요청이 Policy Gate를 지나야 한다는 규칙과 나란히
 * **게이트를 지나지 않는 두 번째 쓰기 경로**가 생긴다. 그래서 화면은 내용을 보여주고 복사만
 * 하며, 파일로 떨구는 것은 `tomverse-host export`가 한다.
 *
 * # 무엇이 빠졌는지 화면도 말한다
 *
 * 파일 안에도 `guarantees`가 있지만, **파일을 열지 않고 이 화면만 보는 사람**이 있다.
 * artifact 본문이 빠졌다는 사실은 export를 어디에 쓸 수 있는지를 바꾸므로 여기서도 말한다.
 */
export function AuditExportPanel({ taskId }: { taskId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setError(null);
    setCopied(false);
    try {
      // 봉투로 온 실패는 **카탈로그가 문장을 만든다.** 예외는 전송 자체가 실패한 경우다.
      const result = unwrap(await invoke<Envelope<{ export: unknown }>>("task_export", { taskId }));
      if (!result.ok) {
        setText(null);
        setError(result.problem.text);
        return;
      }
      // **봉투를 벗긴 본문만 보여준다.** 감사자가 복사해 가는 것은 우리가 만든 기록이지
      // 이 앱의 응답 형식이 아니다.
      setText(JSON.stringify(result.value.export, null, 2));
    } catch (e) {
      setText(null);
      setError(String(e));
    }
  };

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      // 복사가 막힌 환경이 있다. **조용히 성공한 척하지 않는다** — 감사 기록을 옮기는
      // 중이라고 믿는 사람에게 그건 가장 나쁜 실패다.
      setError(`클립보드에 쓰지 못했습니다: ${e}`);
    }
  };

  return (
    <div className="panel">
      <h2>감사 기록 내보내기</h2>
      <p className="muted small">
        이 작업에서 <strong>무엇이 요청됐고 무엇이 실행됐고 무엇이 검증됐는지</strong>를 형식 버전이 붙은
        JSON으로 꺼냅니다. 도구 인자(argv·patch) 원문과 워크스페이스 지문이 들어갑니다.
      </p>
      <p className="muted small">
        검증 출력 등 <strong>artifact 본문은 들어가지 않습니다</strong> — 참조만 들어가고 본문은 이 컴퓨터에
        남습니다. 그리고 이 파일은 <strong>기록이지 재실행 지시가 아닙니다</strong>: 기록된 patch·명령을 다시
        적용하는 재현은 결정론적이지만, 같은 프롬프트로 모델을 다시 부르는 것은 같은 결과를 보장하지 않습니다.
      </p>
      <div className="row">
        <button type="button" onClick={() => void load()}>
          기록 만들기
        </button>
        {text && (
          <button type="button" onClick={() => void copy()}>
            {copied ? "복사됨" : "복사"}
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
      {text && <pre className="export-json small">{text}</pre>}
    </div>
  );
}
