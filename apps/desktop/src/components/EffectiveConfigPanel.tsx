import {
  describeAllowedTools,
  describeIsolation,
  describeMcpServer,
  describeVerificationPin,
  switchLines,
  type PinnedConfig,
} from "../lib/effectiveConfig";

/**
 * 이 태스크가 **무엇을 가지고 도는가** — state-machine 37절.
 *
 * # 폼이 아니라 이벤트에서 읽는다
 *
 * 입력칸은 사용자가 **무엇을 요청했는가**이고, 이 패널이 답하는 것은 **무엇이 고정됐는가**다.
 * 둘은 갈릴 수 있으므로(스킬이 좁히고, 등록은 워크스페이스를 열 때 붙고, 검증 명령 집합은
 * 매니페스트에서 유도된다) 폼으로 만들면 **틀린 답을 자신 있게 말한다.**
 *
 * # 시작 시점의 사실이라고 말한다
 *
 * 이후의 변화는 각자의 이벤트로 남는다. 이 패널로 "지금 상태"를 말하면 그 뒤의 이벤트를
 * 무시하게 되므로, 범위를 문장으로 밝힌다.
 */
/**
 * 실시간 이벤트(`TaskEvent`)와 저장된 이벤트(`StoredEvent`)는 **다른 타입이다** — 후자에는
 * `taskId`가 없다. 이 패널이 쓰는 것은 두 필드뿐이므로 그 둘만 요구한다. 한쪽 타입으로
 * 못박으면 같은 질문("무엇을 가지고 돌았는가")에 대한 답이 지난 작업 기록에서는 안 보인다.
 */
type ConfigEvent = { type: string; payload: Record<string, unknown> };

export function EffectiveConfigPanel({ events }: { events: ConfigEvent[] }) {
  // **마지막 것을 쓴다.** 다시 실행하면 같은 화면에 두 태스크의 기록이 섞이고, 사용자가
  // 묻는 것은 언제나 지금 도는 것이다.
  const pinned = [...events].reverse().find((e) => e.type === "TASK_CONFIG_PINNED");
  if (!pinned) return null;
  const config = pinned.payload as PinnedConfig;

  const skill = config.skill;
  const hooks = config.hooks ?? [];
  const servers = config.mcpServers ?? [];

  return (
    <div className="panel">
      <h3>이 작업에 적용된 것</h3>
      <p className="muted small">
        태스크를 시작할 때 <strong>고정된</strong> 값입니다 — 화면에 입력한 값이 아니라 실제로 적용된 값이고,
        이후의 변화(사전 승인 철회 같은 것)는 아래 이벤트 로그에 따로 남습니다.
      </p>

      <ul className="transmission-files">
        {switchLines(config).map((line) => (
          <li key={line.label} className="small">
            {line.label}: <strong>{line.value}</strong>
          </li>
        ))}
      </ul>

      {/* **어디서 도는가도 "무엇을 가지고 도는가"의 한 줄이다**(38절). 격리 실행의 결과는
          본체에 없으므로, 이 줄이 없으면 사용자는 결과를 본체에서 찾는다. */}
      <p className="muted small">{describeIsolation(config)}</p>
      {/* 스킬은 **이름과 요약을 함께** 낸다 — 이름만 보면 무엇이 좁혀졌는지 모른다. */}
      <p className="muted small">{skill ? `스킬: ${skill.summary}` : "스킬을 쓰지 않습니다."}</p>
      <p className="muted small">{describeAllowedTools(config)}</p>
      {/* 24.5절의 고정을 눈에 보이게 한다. 비어 있는 것은 설정이 아니라 프로젝트의 사실이다. */}
      <p className="muted small">{describeVerificationPin(config)}</p>

      <p className="muted small">
        {hooks.length === 0
          ? "등록된 훅이 없습니다."
          : `등록된 훅 ${hooks.length}개 — 실패해도 작업의 판정을 바꾸지 않습니다.`}
      </p>
      {hooks.map((hook, index) => (
        <p key={`${hook.phase}-${index}`} className="muted small">
          {hook.phase}: {hook.command}
        </p>
      ))}

      <p className="muted small">
        {servers.length === 0
          ? "등록된 MCP 서버가 없습니다."
          : `등록된 MCP 서버 ${servers.length}개 — 도구 호출은 매번 승인을 요구합니다.`}
      </p>
      {servers.map((server) => (
        <p key={server.name} className="muted small">
          {describeMcpServer(server)}
        </p>
      ))}
    </div>
  );
}
