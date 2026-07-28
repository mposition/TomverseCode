import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOrder, dependencyGraph, type WorkspaceManifest } from "../src/buildOrder.js";

/**
 * clean clone 빌드 순서 회귀 테스트.
 *
 * # 무엇을 막는가
 *
 * 루트 `build`가 `npm run build --workspaces`였을 때 관측된 순서는
 * `protocol → sidecar → toolchain → desktop → hypothesis-gate`다. sidecar 테스트와
 * hypothesis-gate가 `@tomverse/toolchain`의 **빌드 산출물**을 import하는데 toolchain이 뒤에
 * 있으므로, 이전 `dist`가 전혀 없는 clean clone에서 첫 빌드가 실패할 수 있다.
 *
 * 그래서 순서를 루트 `package.json`에 명시했고, 이 테스트가 그 명시된 순서를 **각 워크스페이스의
 * package.json에서 유도한 의존성 그래프**와 대조한다. 사람이 손으로 적은 목록은 언젠가
 * 틀리므로, 판정 기준은 손으로 적은 또 다른 목록이 아니라 그래프여야 한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

interface RawManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 루트 `workspaces` 글롭을 펼쳐 실제 매니페스트를 읽는다. */
function readWorkspaces(): WorkspaceManifest[] {
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  const manifests: WorkspaceManifest[] = [];
  for (const pattern of root.workspaces) {
    assert.ok(pattern.endsWith("/*"), `이 테스트는 'dir/*' 형태만 다룹니다: ${pattern}`);
    const parent = path.join(REPO_ROOT, pattern.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(parent, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as RawManifest;
      if (raw.name === undefined) continue;
      manifests.push({
        name: raw.name,
        directory: path.relative(REPO_ROOT, path.dirname(manifestPath)),
        scripts: raw.scripts ?? {},
        dependencies: raw.dependencies ?? {},
        devDependencies: raw.devDependencies ?? {},
      });
    }
  }
  assert.ok(manifests.length >= 4, `워크스페이스를 찾지 못했습니다: ${manifests.length}개`);
  return manifests;
}

/** 루트 스크립트에서 `--workspace=<이름>`의 등장 순서를 뽑는다. */
export function workspaceOrderIn(script: string): string[] {
  return [...script.matchAll(/--workspace=(\S+)/g)].map((m) => m[1]!);
}

function rootScript(name: string): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts[name];
  assert.ok(typeof script === "string" && script.length > 0, `루트에 ${name} 스크립트가 없습니다`);
  return script;
}

test("의존성 그래프가 워크스페이스 간 관계만 남긴다", () => {
  const graph = dependencyGraph([
    {
      name: "@x/a",
      directory: "a",
      scripts: {},
      dependencies: { "@x/b": "*", react: "^19" },
      devDependencies: {},
    },
    { name: "@x/b", directory: "b", scripts: {}, dependencies: {}, devDependencies: {} },
  ]);
  assert.deepEqual([...graph.get("@x/a")!], ["@x/b"]);
  assert.deepEqual([...graph.get("@x/b")!], []);
});

test("devDependencies도 순서에 반영된다", () => {
  // sidecar는 @tomverse/toolchain을 devDependency로 갖지만 **테스트가 그 빌드 산출물을
  // import한다.** "런타임 의존이 아니니 순서와 무관하다"는 추론이 이 결함을 만들었다.
  const graph = dependencyGraph([
    { name: "@x/a", directory: "a", scripts: {}, dependencies: {}, devDependencies: { "@x/b": "*" } },
    { name: "@x/b", directory: "b", scripts: {}, dependencies: {}, devDependencies: {} },
  ]);
  assert.deepEqual([...graph.get("@x/a")!], ["@x/b"]);
});

test("순환이 있으면 조용히 아무 순서나 내지 않는다", () => {
  assert.throws(
    () =>
      buildOrder([
        { name: "@x/a", directory: "a", scripts: {}, dependencies: { "@x/b": "*" }, devDependencies: {} },
        { name: "@x/b", directory: "b", scripts: {}, dependencies: { "@x/a": "*" }, devDependencies: {} },
      ]),
    /순환/
  );
});

test("같은 입력에서 항상 같은 순서가 나온다", () => {
  const manifests = readWorkspaces();
  const first = buildOrder(manifests);
  const shuffled = [...manifests].reverse();
  assert.deepEqual(buildOrder(shuffled), first, "입력 순서에 따라 결과가 달라집니다");
});

// ---- 실제 저장소에 대한 불변식 ----

test("루트 build가 모든 워크스페이스를 명시한다 (--workspaces 열거 순서에 기대지 않는다)", () => {
  const script = rootScript("build");
  assert.ok(
    !script.includes("--workspaces"),
    "루트 build가 --workspaces를 씁니다 — npm의 글롭 확장 순서는 의존성을 모릅니다"
  );

  const listed = workspaceOrderIn(script);
  const buildable = readWorkspaces().filter((m) => m.scripts.build !== undefined);
  assert.deepEqual(
    [...listed].sort(),
    buildable.map((m) => m.name).sort(),
    "루트 build의 워크스페이스 목록이 실제 워크스페이스와 다릅니다 — 새 워크스페이스를 빠뜨렸거나 없는 것을 적었습니다"
  );
});

test("루트 build 순서가 의존성 그래프와 모순되지 않는다", () => {
  const manifests = readWorkspaces();
  const graph = dependencyGraph(manifests);
  const listed = workspaceOrderIn(rootScript("build"));

  for (const [name, deps] of graph) {
    const position = listed.indexOf(name);
    if (position < 0) continue;
    for (const dep of deps) {
      const depPosition = listed.indexOf(dep);
      if (depPosition < 0) continue;
      assert.ok(
        depPosition < position,
        `빌드 순서 위반: ${dep}가 ${name}보다 뒤에 있습니다.\n` +
          `${name}은(는) ${dep}의 빌드 산출물을 import하므로 clean clone에서 실패합니다.\n` +
          `현재 순서: ${listed.join(" → ")}`
      );
    }
  }
});

test("protocol과 toolchain이 소비자보다 먼저 빌드된다", () => {
  // 그래프 검사와 겹치지만, 이 두 패키지는 **모든 소비자의 전제**라 명시적으로 못 박는다.
  const listed = workspaceOrderIn(rootScript("build"));
  const consumers = ["@tomverse/sidecar", "@tomverse/hypothesis-gate"];
  for (const base of ["@tomverse/protocol", "@tomverse/toolchain"]) {
    const basePosition = listed.indexOf(base);
    assert.ok(basePosition >= 0, `${base}가 루트 build에 없습니다: ${listed.join(" → ")}`);
    for (const consumer of consumers) {
      const consumerPosition = listed.indexOf(consumer);
      assert.ok(consumerPosition >= 0, `${consumer}가 루트 build에 없습니다`);
      assert.ok(
        basePosition < consumerPosition,
        `${base}가 ${consumer}보다 뒤입니다: ${listed.join(" → ")}`
      );
    }
  }
});

test("typecheck도 build와 같은 순서다", () => {
  // 타입 검사도 상류의 .d.ts를 읽는다. 순서가 갈라지면 한쪽만 clean clone에서 깨진다.
  assert.deepEqual(
    workspaceOrderIn(rootScript("typecheck")),
    workspaceOrderIn(rootScript("build")),
    "typecheck와 build의 워크스페이스 순서가 다릅니다"
  );
});

test("build/typecheck가 --if-present로 실패를 감추지 않는다", () => {
  for (const name of ["build", "typecheck"]) {
    assert.ok(
      !rootScript(name).includes("--if-present"),
      `루트 ${name}이 --if-present를 씁니다 — 스크립트를 잃은 워크스페이스가 조용히 통과합니다`
    );
  }
});

test("@tomverse/toolchain은 어떤 워크스페이스에도 의존하지 않는다", () => {
  // 의존하면 순환 위험이 생기고, 무엇보다 cargo 런처가 빌드 없이 쓸 수 없게 된다.
  const graph = dependencyGraph(readWorkspaces());
  assert.deepEqual([...(graph.get("@tomverse/toolchain") ?? [])], []);
});
