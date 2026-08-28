import type { RelevantFile, WorkspaceSnapshot } from "@tomverse/protocol";

/**
 * `SNAPSHOT_CREATED` 이벤트의 payload — product-strategy 7.2절, state-machine 68절.
 *
 * # 왜 별도 모듈인가
 *
 * 이 함수가 정하는 것은 **무엇이 기록에 남는가**이고, 그건 곧 전송 화면과 감사 export가
 * 말할 수 있는 것의 전부다. 스냅샷에만 있고 여기 없는 값은 **없는 것과 같다** — 61절이
 * `anchorCoverage`에서, 67절이 검증 다이제스트에서 같은 자리를 밟았다.
 *
 * 그래서 검사가 **`WorkspaceSnapshot`의 필드에서 유도해** 대조한다. 오케스트레이터의 private
 * 메서드로 두면 그 대조를 값으로 할 수 없다(타입만 보게 되는데, 타입에 있는데 채우지 않는
 * 코드는 타입 대조를 통과한다).
 *
 * # 싣지 않기로 한 것은 여기 적는다
 *
 * 안 싣는 이유가 코드 어디에도 없으면 **"일부러 뺀 것"과 "빠뜨린 것"이 구별되지 않는다.**
 * 18.3절이 반대 방향(Rust가 내는데 Node가 안 읽는 것)에 만든 장치와 같은 모양이다.
 */

/**
 * 스냅샷에 있지만 **이벤트에 싣지 않는** 필드와 그 이유.
 *
 * 새 필드가 늘면 여기서 결정을 내려야 검사를 지난다 — 싣거나, 안 싣는 이유를 적거나.
 */
export const SNAPSHOT_FIELDS_NOT_RECORDED: Record<string, string> = {
  // 이벤트는 이미 태스크에 매여 있고, 태스크가 워크스페이스를 안다.
  workspaceId: "이벤트가 속한 태스크가 이미 워크스페이스를 가리킨다",
  // 인덱스 무효화용 지문(`브랜치@해시`)이지 커밋 sha가 아니다. 프롬프트로 나가지 않는다.
  gitHead: "인덱스 무효화용 지문이고 프롬프트에 실리지 않는다 — 브랜치와 dirty 여부는 따로 싣는다",
  // 예산은 패키징을 정할 뿐 프롬프트 본문에 렌더링되지 않는다.
  tokenBudget: "패키징 입력이고 프롬프트에 실리지 않는다",
  // 이벤트 자신의 시각이 있다. 두 시각을 나란히 두면 어느 쪽이 정본인지 묻게 된다.
  createdAt: "이벤트가 자기 시각을 갖는다",
};

/**
 * `RelevantFile`에 있지만 **이벤트에 싣지 않는** 필드와 그 이유.
 *
 * `content`가 여기 있는 것이 이 목록의 핵심이다 — 그 결정은 지금까지 코드 어디에도 적혀
 * 있지 않았다.
 */
export const RELEVANT_FILE_FIELDS_NOT_RECORDED: Record<string, string> = {
  // **이벤트는 화면과 감사 export로 흐른다.** 본문을 실으면 파일 내용이 그 경로들로 복제되고,
  // 이미 artifact에 있는 것을 한 벌 더 두는 것이다. 전송 화면이 답해야 하는 질문은
  // "무엇이 나갔는가"이지 "무엇이 나갔는지 여기서 읽자"가 아니다.
  content: "이벤트는 화면·감사 export로 흐른다 — 파일 본문을 복제하지 않는다(원문은 artifact에 있다)",
  sizeBytes: "원본 크기는 전송량이 아니다 — 나간 것은 잘린 뒤의 것이고 그건 truncated가 말한다",
  includedBytes: "위와 같은 이유. 크기를 말해야 하면 truncated와 함께 다시 설계할 자리다",
  // 창을 어디로 잡았는지는 프롬프트 머리글에 실리지만, 그 사실은 truncated로 이미 드러난다.
  anchorLines: "선정 근거의 중간값이고 프롬프트에 실리지 않는다",
  includedRange: "프롬프트 머리글에는 실리지만 전송량이나 대상 파일을 바꾸지 않는다",
};

export function snapshotPayload(snapshot: WorkspaceSnapshot): Record<string, unknown> {
  return {
    snapshotId: snapshot.snapshotId,
    gitBranch: snapshot.gitBranch,
    gitDirty: snapshot.gitDirty,
    // **커밋되지 않은 변경 요약도 프롬프트에 실린다**(`renderSnapshot`의 Repository state).
    // 이걸 이벤트에 넣지 않으면 전송 기록이 그것을 말할 수 없고, 화면은 "선정된 파일만
    // 나갔다"로 읽힌다 — 이 요약에는 선정되지 않은 파일의 경로도 들어간다(7.2절).
    gitDiffSummary: snapshot.gitDiffSummary ?? null,
    // 스킬 지시문도 프롬프트에 실려 나간다 — 전송 집계가 세야 한다(7.2절).
    skill: snapshot.skill ?? null,
    // 앞선 태스크의 판정이 이 태스크의 프롬프트로 넘어간다는 사실도 마찬가지다(27.3절).
    sessionMemory: snapshot.sessionMemory ?? null,
    // MCP 도구 목록과 그 응답도 나간다(31.4절). 응답은 **외부 서버가 준 텍스트**라
    // 특히 세야 한다 — 우리가 만든 것도 사용자가 쓴 것도 아니다.
    mcpTools: snapshot.mcpTools ?? null,
    mcpResults: snapshot.mcpResults ?? null,
    // 어떤 파일이 어느 공급자에 갔는지 표시하기 위한 데이터 (README "데이터 전송 투명성").
    relevantFiles: snapshot.relevantFiles.map((f) => ({
      path: f.path,
      reason: f.reason,
      reasonDetail: f.reasonDetail,
      truncated: f.truncated,
      // **재는 장치의 값이 기록에 닿아야 한다**(state-machine 61절).
      //
      // context-engine 15.3절이 이 값을 만든 이유는 "앵커 분포를 잰 적이 없다"였는데,
      // 스냅샷에만 있고 이벤트에 없으면 **여전히 잰 적이 없다.** 값이 메모리에서 태어나
      // 기록에 닿지 못한 채 사라지는 자리이고, 16.1절이 본 것("값은 있는데 읽는 사람이
      // 없다")보다 한 단계 앞이다.
      //
      // 없으면 키를 두지 않는다 — 잘리지 않은 파일에 `null`을 실으면 "가른 결과가 없다"와
      // "가를 것이 없었다"가 같은 모양이 된다.
      ...(f.anchorCoverage ? { anchorCoverage: f.anchorCoverage } : {}),
    })),
    excludedNotes: snapshot.excludedNotes ?? [],
    coverageNotes: snapshot.coverageNotes ?? [],
    // **파일이 아닌 노트는 따로 나른다**(context-engine 17절). 한 배열에 실으면 화면의
    // "이름만 나간 파일" 목록에 파일이 아닌 것이 섞이고, 개수도 파일 수가 아니게 된다.
    projectMeta: snapshot.projectMeta,
  };
}
