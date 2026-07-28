/**
 * 워크스페이스 빌드 순서 — **의존성 그래프에서 유도한다.**
 *
 * # 왜 필요한가
 *
 * 루트 `build`는 `npm run build --workspaces`였다. npm이 워크스페이스를 열거하는 순서는
 * 글롭 확장 순서이고, 의존성과 무관하다. 실제로 관측된 순서는
 * `protocol → sidecar → toolchain → desktop → hypothesis-gate`였다 —
 * **sidecar가 toolchain보다 먼저다.** sidecar와 hypothesis-gate는 `@tomverse/toolchain`의
 * **빌드 산출물**(`dist`)을 import하므로, 이전 `dist`가 전혀 없는 clean clone에서는
 * 첫 빌드가 실패할 수 있다.
 *
 * 우연히 통과하는 순서에 기대지 않으려면 순서를 명시해야 하고, 명시한 순서가 다시 뒤집히면
 * 실패해야 한다. 그 판정 기준이 여기 있다.
 *
 * # 왜 "생성"이 아니라 "검증"인가
 *
 * 루트 `package.json`의 스크립트를 이 코드가 생성하면, 스크립트를 읽는 사람이 실제 실행
 * 순서를 알 수 없게 된다. 순서는 `package.json`에 사람이 읽을 수 있게 적어 두고,
 * 이 모듈은 그것이 그래프와 모순되지 않는지 **판정만** 한다.
 */

export interface WorkspaceManifest {
  /** `package.json`의 `name` — 루트 스크립트가 `--workspace=`로 지목하는 이름이다. */
  name: string;
  /** 저장소 루트 기준 디렉터리 (오류 메시지용). */
  directory: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/**
 * 워크스페이스 간 의존 관계만 남긴 그래프.
 *
 * `devDependencies`도 포함한다 — sidecar는 `@tomverse/toolchain`을 devDependency로 갖지만
 * **테스트가 그 빌드 산출물을 import한다.** "런타임 의존이 아니니 순서와 무관하다"는 추론이
 * 정확히 이 결함을 만들었다.
 *
 * @returns 패키지 이름 → 먼저 빌드되어야 하는 패키지 이름 집합
 */
export function dependencyGraph(manifests: readonly WorkspaceManifest[]): Map<string, Set<string>> {
  const names = new Set(manifests.map((m) => m.name));
  const graph = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const internal = new Set<string>();
    for (const dep of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) {
      if (names.has(dep) && dep !== manifest.name) internal.add(dep);
    }
    graph.set(manifest.name, internal);
  }
  return graph;
}

/**
 * 그래프를 만족하는 결정론적 빌드 순서.
 *
 * 동률일 때는 이름순으로 자른다 — 같은 입력에서 항상 같은 답이 나와야
 * "순서가 뒤집혔다"를 판정할 수 있다.
 *
 * 순환이 있으면 조용히 아무 순서나 돌려주지 않고 던진다. 워크스페이스 순환은 빌드가
 * 성립하지 않는다는 뜻이므로 감출 이유가 없다.
 */
export function buildOrder(manifests: readonly WorkspaceManifest[]): string[] {
  const graph = dependencyGraph(manifests);
  const remaining = new Map([...graph].map(([name, deps]) => [name, new Set(deps)]));
  const ordered: string[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(`워크스페이스 의존성에 순환이 있습니다: ${[...remaining.keys()].sort().join(", ")}`);
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
    for (const deps of remaining.values()) {
      for (const name of ready) deps.delete(name);
    }
  }
  return ordered;
}
