/**
 * 무인 실행의 **시한** 입력 — state-machine 39절.
 *
 * # 이 자리에서 하기 쉬운 거짓말
 *
 * ① **기본값을 채워 넣는 것.** 예산 상한과 같은 규칙이다 — 코드가 만들어낸 승인은 승인이
 *    아니다. 상한 없이 도는 것은 사용자가 고를 수 있는 선택이고, 그 사실을 말해야 한다.
 *
 * ② **사람이 붙어 있는 실행에도 시계를 거는 것.** 시한이 필요한 이유는 "물을 사람이 없다"는
 *    것이다. 사람이 있으면 취소 버튼이 곧 시한이고, 그 상태에서 시계를 돌리면 **사용자가
 *    답을 쓰는 동안**에도 시간이 간다 — 그건 태스크의 시간이 아니라 사용자의 시간이다.
 *
 * ③ **못 읽은 값을 "없음"으로 넘기는 것.** `"삼십"`을 상한 없음으로 바꾸면 사용자는 상한을
 *    걸었다고 믿는데 실행은 끝없이 돈다. 읽지 못한 것은 **거부**한다.
 */

export interface DeadlineChoice {
  /** Rust로 보낼 값. `null`이면 상한 없이 돈다. */
  secs: number | null;
  /** 읽지 못한 입력. 있으면 시작할 수 없다. */
  problem?: string;
  /** 화면이 **미리** 말해야 하는 사실. */
  notice: string;
}

/** 분 단위로 받는다 — 초로 받으면 사용자가 3600 같은 숫자를 계산하게 된다. */
export function readDeadline(text: string, unattended: boolean): DeadlineChoice {
  const trimmed = text.trim();

  if (!unattended) {
    return {
      secs: null,
      // **적어 둔 값이 무시된다는 사실을 말한다.** 침묵하면 사용자는 걸렸다고 믿는다.
      notice:
        trimmed === ""
          ? "사람이 붙어 있는 실행에는 시한을 걸지 않습니다 — 취소 버튼이 곧 시한입니다."
          : "무인 실행이 아니므로 시한을 걸지 않습니다 — 사용자가 답을 쓰는 동안에도 시계가 돌면 그건 태스크의 시간이 아닙니다.",
    };
  }

  if (trimmed === "") {
    return {
      secs: null,
      // **기본값을 만들지 않는다.** 대신 그 선택의 결과를 말한다.
      notice: "언제까지 돌지 정하지 않았습니다 — 아무도 멈추지 않으므로 상한 없이 돕니다.",
    };
  }

  // 소수점·부호·공백이 섞인 입력을 조용히 반올림하지 않는다.
  if (!/^\d+$/.test(trimmed)) {
    return { secs: null, problem: `시한을 읽을 수 없습니다: ${trimmed} (분 단위 정수)`, notice: "" };
  }
  const minutes = Number(trimmed);
  if (minutes === 0) {
    // 0은 "즉시 멈춘다"이고, 그건 시한이 아니라 실행하지 않는 것이다.
    return { secs: null, problem: "시한은 1분 이상이어야 합니다.", notice: "" };
  }
  return {
    secs: minutes * 60,
    notice: `${minutes}분이 지나면 이 작업을 멈춥니다. 사용자가 취소한 것과 다른 사유로 기록됩니다.`,
  };
}
