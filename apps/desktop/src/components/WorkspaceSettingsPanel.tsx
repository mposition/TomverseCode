import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  buildSettings,
  toDrafts,
  type HookDraft,
  type ServerDraft,
  type WorkspaceSettings,
} from "../lib/settingsDraft";

/**
 * 훅과 MCP 서버 **등록** — state-machine 29절.
 *
 * # 왜 한 화면인가
 *
 * 둘은 수명이 같다: 태스크가 아니라 **워크스페이스**의 설정이고, 앱을 다시 켜도 남아야 한다.
 * 그리고 둘 다 같은 성질을 갖는다 — **등록하는 순간 게이트 밖의 능력이 들어온다**(23.5절).
 * 그 문장을 한 번만 쓰려면 한 화면이어야 한다.
 *
 * # 이 화면이 반드시 말해야 하는 것
 *
 * **등록은 사용자만 한다.** 모델이 서버나 훅을 추가하는 경로는 없고, 그것이 이 기능의 안전
 * 모델 전부다. 설정 파일을 워크스페이스 **밖**에 두는 이유도 그것이다 — 안에 두면 모델이
 * 쓸 수 있는 파일이 된다.
 *
 * 그리고 **저장이 즉시 반영되지 않는다.** 훅 레지스트리와 MCP 풀은 워크스페이스를 열 때
 * 붙으므로 다시 열어야 적용된다. 이 사실을 말하지 않으면 사용자는 저장이 실패했다고 읽는다.
 */
export function WorkspaceSettingsPanel() {
  const [hooks, setHooks] = useState<HookDraft[]>([]);
  const [servers, setServers] = useState<ServerDraft[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    invoke<WorkspaceSettings>("workspace_settings")
      .then((settings) => {
        const drafts = toDrafts(settings);
        setHooks(drafts.hooks);
        setServers(drafts.servers);
        setLoaded(true);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const save = (): void => {
    setNote(null);
    setError(null);
    const result = buildSettings(hooks, servers);
    setProblems(result.problems);
    // **보낼 수 없으면 보내지 않는다.** 확실히 틀린 것을 왕복시키면 사용자는 같은 말을
    // 두 번 기다린다.
    if (!result.settings) return;
    invoke<{ note: string }>("set_workspace_settings", { settings: result.settings })
      .then((r) => setNote(r.note))
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    <div className="panel">
      <h2>등록 (훅 · MCP 서버)</h2>
      <p className="muted small">
        <strong>등록은 사용자만 합니다.</strong> 모델이 훅이나 서버를 추가하는 경로는 없습니다 — 설정은
        워크스페이스 <strong>밖</strong>에 저장되며, 워크스페이스 안의 파일은 모델이 쓸 수 있기 때문입니다.
      </p>
      <p className="muted small">
        등록하면 <strong>게이트 밖의 능력이 들어옵니다.</strong> MCP 서버와 훅은 우리 Policy Gate 밖에서
        파일을 고치고 네트워크를 쓸 수 있습니다. 훅은 실패해도 작업의 판정을 바꾸지 않으며, MCP 도구
        호출은 매번 승인을 요구합니다.
      </p>

      {!loaded && !error && <p className="muted small">읽는 중…</p>}
      {error && <p className="error small">{error}</p>}

      <h3>phase 훅</h3>
      <p className="muted small">
        allowlist에 없는 프로그램은 게이트가 거부합니다 — 스크립트를 <code>package.json</code>에 넣고
        <code> npm run &lt;스크립트&gt;</code>로 거는 것이 지나는 길입니다.
      </p>
      {hooks.map((hook, index) => (
        <div key={index} className="pin-row">
          <input
            value={hook.phase}
            placeholder="phase (예: VERIFYING)"
            onChange={(e) => setHooks(hooks.map((h, i) => (i === index ? { ...h, phase: e.target.value } : h)))}
            spellCheck={false}
          />
          <input
            value={hook.program}
            placeholder="프로그램 (예: npm)"
            onChange={(e) => setHooks(hooks.map((h, i) => (i === index ? { ...h, program: e.target.value } : h)))}
            spellCheck={false}
          />
          <textarea
            value={hook.argsText}
            placeholder={"인자 (한 줄에 하나)\nrun\nfmt"}
            onChange={(e) => setHooks(hooks.map((h, i) => (i === index ? { ...h, argsText: e.target.value } : h)))}
            spellCheck={false}
          />
          <button type="button" onClick={() => setHooks(hooks.filter((_, i) => i !== index))}>
            제거
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setHooks([...hooks, { phase: "", program: "", argsText: "" }])}>
        훅 추가
      </button>

      <h3>MCP 서버</h3>
      {servers.map((server, index) => (
        <div key={index} className="pin-row">
          <input
            value={server.name}
            placeholder="이름"
            onChange={(e) => setServers(servers.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)))}
            spellCheck={false}
          />
          <input
            value={server.program}
            placeholder="프로그램"
            onChange={(e) => setServers(servers.map((s, i) => (i === index ? { ...s, program: e.target.value } : s)))}
            spellCheck={false}
          />
          <textarea
            value={server.argsText}
            placeholder={"인자 (한 줄에 하나)"}
            onChange={(e) => setServers(servers.map((s, i) => (i === index ? { ...s, argsText: e.target.value } : s)))}
            spellCheck={false}
          />
          <button type="button" onClick={() => setServers(servers.filter((_, i) => i !== index))}>
            제거
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setServers([...servers, { name: "", program: "", argsText: "" }])}>
        서버 추가
      </button>

      {problems.length > 0 && (
        <ul className="transmission-files">
          {problems.map((problem) => (
            <li key={problem} className="error small">
              {problem}
            </li>
          ))}
        </ul>
      )}

      <button type="button" onClick={save} disabled={!loaded}>
        저장
      </button>
      {/* **즉시 반영되지 않는다는 것을 말한다.** 말하지 않으면 저장이 실패했다고 읽힌다. */}
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
