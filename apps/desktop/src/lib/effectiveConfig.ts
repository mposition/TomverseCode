/**
 * 이 태스크가 **무엇을 가지고 도는가** — state-machine 37절.
 *
 * # 왜 폼 상태로 만들지 않는가
 *
 * 화면의 입력칸은 사용자가 **무엇을 요청했는가**이고, 여기 오는 값은 **무엇이 고정됐는가**다.
 * 둘은 갈릴 수 있다 — 스킬이 도구를 좁히고, 등록은 워크스페이스를 열 때 붙고, 검증 명령
 * 집합은 태스크 시작 시점의 매니페스트에서 유도된다(24.5절).
 *
 * 폼으로 만들면 화면이 **틀린 답을 자신 있게 말한다.** 그래서 이 모듈은 `TASK_CONFIG_PINNED`
 * 이벤트의 payload만 읽고, 없는 값을 지어내지 않는다.
 *
 * # 시작 시점의 사실이다
 *
 * 이후의 변화(사전 승인 철회 같은 것)는 각자의 이벤트로 남는다. 이 하나로 "지금 상태"를
 * 말하면 그 뒤의 이벤트를 무시하게 되므로, 화면 문장이 그 범위를 밝힌다.
 */

export interface PinnedConfig {
  executionMode?: string;
  unattended?: boolean;
  autoApproveWorkspaceWrites?: boolean;
  autoApproveVerification?: boolean;
  allowGitCommit?: boolean;
  skill?: { name: string; summary: string } | null;
  allowedTools?: string[] | null;
  verificationPin?: { program: string; args: string[] }[];
  hooks?: { phase: string; command: string }[];
  mcpServers?: { name: string; program: string; args: string[]; tools?: string[] | null }[];
  /** 격리 실행 (38절). `null`이면 본체에서 돌았다. */
  isolation?: {
    repo: string;
    branch: string;
    path: string;
    reused: boolean;
    mainTreeDirty: boolean;
  } | null;
  /** 무인 실행의 시한(ms) — 39절. `null`이면 상한 없이 돈다. */
  deadlineMs?: number | null;
}

export interface ConfigLine {
  label: string;
  value: string;
  /** 사용자가 켠 것인가 — 화면이 강조할지 정하는 데 쓴다. */
  enabled: boolean;
}

/** 켜고 끄는 스위치들. **끈 것도 보여준다** — 안 보이면 "켰다고 생각했는데"를 확인할 수 없다. */
export function switchLines(config: PinnedConfig): ConfigLine[] {
  const on = (v: boolean | undefined): string => (v ? "켜짐" : "꺼짐");
  return [
    { label: "실행 모드", value: config.executionMode ?? "(모름)", enabled: true },
    { label: "무인 실행", value: on(config.unattended), enabled: Boolean(config.unattended) },
    {
      label: "워크스페이스 쓰기 자동 승인",
      value: on(config.autoApproveWorkspaceWrites),
      enabled: Boolean(config.autoApproveWorkspaceWrites),
    },
    {
      label: "검증 명령 자동 승인",
      value: on(config.autoApproveVerification),
      enabled: Boolean(config.autoApproveVerification),
    },
    { label: "git 커밋 허용", value: on(config.allowGitCommit), enabled: Boolean(config.allowGitCommit) },
  ];
}

/**
 * 도구 허용목록 한 줄.
 *
 * **`null`과 빈 배열을 뭉개지 않는다.** 전자는 "좁히지 않았다"이고 후자는 "아무 도구도 못
 * 쓴다"인데, 뭉개면 정반대로 읽힌다.
 */
export function describeAllowedTools(config: PinnedConfig): string {
  const tools = config.allowedTools;
  if (tools === undefined || tools === null) return "도구를 좁히지 않았습니다 — 게이트의 기본 분류가 그대로 적용됩니다.";
  if (tools.length === 0) return "허용된 도구가 없습니다.";
  return `이 태스크가 쓸 수 있는 도구 ${tools.length}개: ${tools.join(", ")}`;
}

/**
 * 검증 명령 고정 집합 한 줄 — 24.5절의 고정을 눈에 보이게 한다.
 *
 * **비어 있는 것은 설정이 아니라 프로젝트의 사실이다.** 자동 승인을 켜도 아무것도 자동
 * 승인되지 않는데, 그 이유를 말하지 않으면 사용자는 스위치가 고장 났다고 읽는다.
 */
export function describeVerificationPin(config: PinnedConfig): string {
  const pin = config.verificationPin ?? [];
  if (pin.length === 0) {
    return "이 프로젝트가 매니페스트에 선언해 둔 검증 명령이 없습니다 — 자동 승인을 켜도 자동 승인될 명령이 없습니다.";
  }
  const shown = pin.map((c) => [c.program, ...c.args].join(" ")).join(", ");
  return `태스크 시작 시점에 고정된 검증 명령 ${pin.length}개: ${shown}`;
}

/** MCP 등록 한 줄. **좁혀졌는지를 함께 말한다** — 이름만 보면 무엇이든 부를 수 있다고 읽는다. */
export function describeMcpServer(server: {
  name: string;
  program: string;
  args: string[];
  tools?: string[] | null;
}): string {
  const command = [server.program, ...server.args].join(" ");
  const tools =
    server.tools === undefined || server.tools === null
      ? "도구 전부"
      : `도구 ${server.tools.length}개로 제한 (${server.tools.join(", ")})`;
  return `${server.name} — ${command} · ${tools}`;
}

/**
 * 어디서 돌았는가 한 줄 — 38절.
 *
 * **"격리했다"만 말하지 않는다.** 사용자가 다음에 하는 일은 결과를 여는 것이고, 그러려면
 * 경로가 필요하다. 그리고 이 줄은 지난 작업 기록에서도 읽히므로, 그때는 트리가 이미 정리돼
 * 사라졌을 수도 있다 — 그래도 **어디였는지**는 사실이다.
 */
export function describeIsolation(config: PinnedConfig): string {
  const iso = config.isolation;
  if (iso === undefined || iso === null) return "본체 작업 트리에서 돌았습니다.";
  const reused = iso.reused ? " (이미 있던 트리를 이어 썼습니다)" : "";
  // **본체가 더러웠다는 사실을 함께 남긴다.** 그 변경은 이 실행에 포함되지 않았고, 그걸 모르면
  // 결과 diff를 "모델이 내 수정을 되돌렸다"로 읽는다.
  const dirty = iso.mainTreeDirty
    ? " 시작 시점에 본체에 커밋되지 않은 변경이 있었고, 그 변경은 이 실행에 포함되지 않았습니다."
    : "";
  return `격리 실행 — ${iso.branch} 브랜치, ${iso.path}${reused}.${dirty}`;
}

/**
 * 언제까지 도는가 한 줄 — 39절.
 *
 * **상한이 없다는 것도 사실이다.** 침묵하면 사용자는 어딘가에 기본 상한이 있다고 가정하고,
 * 그 가정은 무인 실행에서 가장 비싸게 틀린다.
 */
export function describeDeadline(config: PinnedConfig): string {
  const ms = config.deadlineMs;
  if (ms === undefined || ms === null) {
    return config.unattended
      ? "시한 없음 — 아무도 멈추지 않으므로 끝날 때까지 돕니다."
      : "시한 없음 (사람이 붙어 있는 실행입니다).";
  }
  const minutes = Math.round(ms / 60_000);
  // 1분 미만을 "0분"으로 반올림하지 않는다 — 0은 "즉시 멈춘다"로 읽힌다.
  return minutes >= 1
    ? `시한 ${minutes}분 — 지나면 멈추고, 사용자 취소와 다른 사유로 기록됩니다.`
    : `시한 ${ms}ms — 지나면 멈추고, 사용자 취소와 다른 사유로 기록됩니다.`;
}
