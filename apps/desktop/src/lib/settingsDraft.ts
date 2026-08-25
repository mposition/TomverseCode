/**
 * 등록 화면의 **편집 중인 값**을 저장 형식으로 옮긴다 — state-machine 29절.
 *
 * # 왜 화면이 아니라 여기서 하는가
 *
 * 이건 파싱이다: 사용자가 한 줄에 적은 명령을 argv로 나누고, 무엇이 비었는지 판단한다.
 * 계산이 tsx 안에 있으면 DOM 없이 검증할 방법이 없다(CLAUDE.md의 `src/lib` 규칙).
 *
 * # 여기서 검증을 끝내지 않는다
 *
 * 최종 판정은 Rust가 한다(`settings::save`) — phase 이름이 실재하는지, 프로그램 자리에 명령
 * 문자열이 들어왔는지는 거기서 본다. 여기서 하는 것은 **보내기 전에 확실히 틀린 것을 잡는
 * 것**뿐이고, 그래서 같은 규칙을 두 번 적지 않는다.
 *
 * 두 곳에서 판정하면 언젠가 둘이 갈라지고, 갈라진 쪽이 느슨하면 그게 우회 경로가 된다.
 *
 * # argv는 쉼표가 아니라 **줄과 공백**으로 나눈다
 *
 * CLI(`--hook phase=프로그램,인자...`)는 쉼표로 나눴고, 그 한계도 적어 두었다: 쉼표가 든
 * 인자는 등록할 수 없다. 화면에는 그 한계를 물려줄 이유가 없다 — 프로그램과 인자를 **따로 받는다.**
 */

export interface HookDraft {
  phase: string;
  program: string;
  /** 한 줄에 하나씩. 빈 줄은 인자가 아니다. */
  argsText: string;
}

export interface ServerDraft {
  name: string;
  program: string;
  argsText: string;
  /**
   * 부를 수 있는 도구를 좁힌다 (32절). 한 줄에 하나. **비워 두면 좁히지 않는다.**
   *
   * 빈 목록("아무것도 못 부름")은 저장 형식에서 오류이고, 화면에서는 그 상태를 만들 수
   * 없다 — 빈 텍스트는 `undefined`가 된다.
   */
  toolsText: string;
}

export interface StoredHook {
  phase: string;
  program: string;
  args: string[];
}

export interface StoredServer {
  name: string;
  program: string;
  args: string[];
  /** 없으면 서버가 내놓는 전부. 있으면 그 목록만 (32절). */
  tools?: string[];
}

export interface WorkspaceSettings {
  hooks: StoredHook[];
  servers: StoredServer[];
}

export interface DraftResult {
  /** 보낼 수 있으면 값, 아니면 `null`. */
  settings: WorkspaceSettings | null;
  /** 보내기 전에 확실히 틀린 것들. 비어 있으면 보낼 수 있다. */
  problems: string[];
}

/** 여러 줄 텍스트 → argv. 빈 줄과 앞뒤 공백은 버린다. */
export function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function buildSettings(hooks: HookDraft[], servers: ServerDraft[]): DraftResult {
  const problems: string[] = [];

  const builtHooks: StoredHook[] = hooks.map((hook, index) => {
    // **비어 있는 줄을 조용히 버리지 않는다.** 사용자가 추가한 행이 저장에서 사라지면
    // "저장이 안 됐다"로 읽힌다 — 무엇이 빠졌는지 말해야 고칠 수 있다.
    if (hook.phase.trim() === "") problems.push(`훅 ${index + 1}: phase가 비었습니다`);
    if (hook.program.trim() === "") problems.push(`훅 ${index + 1}: 프로그램이 비었습니다`);
    return {
      phase: hook.phase.trim(),
      program: hook.program.trim(),
      args: parseArgs(hook.argsText),
    };
  });

  const builtServers: StoredServer[] = servers.map((server, index) => {
    if (server.name.trim() === "") problems.push(`서버 ${index + 1}: 이름이 비었습니다`);
    if (server.program.trim() === "") problems.push(`서버 ${index + 1}: 프로그램이 비었습니다`);
    const tools = parseArgs(server.toolsText);
    return {
      name: server.name.trim(),
      program: server.program.trim(),
      args: parseArgs(server.argsText),
      // **빈 목록을 보내지 않는다.** Rust는 그것을 오류로 보고, 사용자가 만들려던 상태는
      // "좁히지 않음"이다 — 둘을 뭉개면 빈 칸이 저장 실패가 된다.
      ...(tools.length > 0 ? { tools } : {}),
    };
  });

  // 이름 중복은 Rust도 잡지만, **보내기 전에 잡으면 어느 행인지 말할 수 있다.**
  const seen = new Set<string>();
  for (const [index, server] of builtServers.entries()) {
    if (server.name === "") continue;
    if (seen.has(server.name)) problems.push(`서버 ${index + 1}: 이름이 중복됩니다 (${server.name})`);
    seen.add(server.name);
  }

  return {
    settings: problems.length === 0 ? { hooks: builtHooks, servers: builtServers } : null,
    problems,
  };
}

/** 저장된 값 → 편집 중인 값. */
export function toDrafts(settings: WorkspaceSettings): { hooks: HookDraft[]; servers: ServerDraft[] } {
  return {
    hooks: settings.hooks.map((hook) => ({
      phase: hook.phase,
      program: hook.program,
      argsText: hook.args.join("\n"),
    })),
    servers: settings.servers.map((server) => ({
      name: server.name,
      program: server.program,
      argsText: server.args.join("\n"),
      toolsText: (server.tools ?? []).join("\n"),
    })),
  };
}

// ---- 저장소의 제안 (state-machine 35절) ----

export type ProposalStatus = "absent" | "same_as_registered" | "differs";

export interface ProposalView {
  path: string;
  status: ProposalStatus;
  proposal: WorkspaceSettings | null;
}

export interface ProposalNotice {
  /** 이 영역을 그리는가. 제안이 없으면 아무것도 그리지 않는다. */
  show: boolean;
  headline: string;
  /** 불러오기 버튼을 그리는가 — 등록과 이미 같으면 할 일이 없다. */
  offerLoad: boolean;
  /** 몇 건을 불러오는가. **두 수를 따로 낸다** — 합치면 무엇이 들어오는지 알 수 없다. */
  hookCount: number;
  serverCount: number;
}

/**
 * 제안을 화면 문장으로.
 *
 * # 이 자리에서 하기 쉬운 거짓말
 *
 * **"저장소가 설정했습니다"라고 쓰는 것.** 저장소는 아무것도 설정하지 않았다 — 제안은 화면의
 * 입력칸을 채울 뿐이고, 등록은 사용자가 저장을 누를 때 일어난다.
 *
 * 그리고 **출처를 흐리지 않는다.** 이 내용은 워크스페이스 안의 파일에서 왔고, 그 파일은
 * 모델이 쓸 수 있다(34.1절). 그 사실을 말하지 않으면 사용자는 팀이 적어둔 것이라고 읽는다.
 */
export function describeProposal(view: ProposalView | null): ProposalNotice {
  const empty: ProposalNotice = { show: false, headline: "", offerLoad: false, hookCount: 0, serverCount: 0 };
  if (!view || view.status === "absent" || !view.proposal) return empty;

  const hookCount = view.proposal.hooks.length;
  const serverCount = view.proposal.servers.length;
  if (view.status === "same_as_registered") {
    return {
      show: true,
      headline: `${view.path}의 제안이 지금 등록과 같습니다.`,
      offerLoad: false,
      hookCount,
      serverCount,
    };
  }
  return {
    show: true,
    // **"등록되었습니다"가 아니다.** 불러오기는 입력칸을 채울 뿐이다.
    headline: `${view.path}가 훅 ${hookCount}개와 MCP 서버 ${serverCount}개를 제안합니다 — 아직 등록되지 않았습니다.`,
    offerLoad: true,
    hookCount,
    serverCount,
  };
}
