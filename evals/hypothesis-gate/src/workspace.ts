import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoadedFixture } from "./manifest.js";

/**
 * arm 실행용 격리 workspace.
 *
 * # 왜 arm마다 새로 만드는가 (§7 실행 공정성)
 *
 * 한 디렉터리를 재사용하고 `git checkout`으로 되돌리면 (a) 이전 arm이 만든 미추적 파일이 남고
 * (b) 되돌리기 실패가 조용히 다음 arm의 최초 상태를 오염시킨다. 그러면 "같은 최초 상태에서
 * 시작했다"는 전제가 무너지고, 그 전제 없이는 arm 간 비교가 아무 의미도 없다.
 *
 * 그래서 매번 fixture를 새 임시 디렉터리로 복사한다. 복사 후 해시를 다시 계산해
 * **실제로 같은 상태인지 확인**한다 — 복사가 조용히 실패하는 경우까지 잡는다.
 */

export interface MaterializedWorkspace {
  root: string;
  /** 정리. 실패해도 예외를 던지지 않는다 — 실험 결과가 정리 실패로 사라지면 안 된다. */
  cleanup(): void;
}

export function materialize(fixture: LoadedFixture, label: string): MaterializedWorkspace {
  const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40);
  const root = mkdtempSync(path.join(tmpdir(), `gate-${safeLabel}-`));
  cpSync(fixture.workspaceDir, root, { recursive: true });

  // fixture가 git 저장소가 아니어도 돌아야 한다(Rust의 list_files가 .require_git(false)).
  // 다만 .gitignore가 있으면 존중되므로 fixture 쪽에서 필요한 것만 넣는다.
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 정리 실패는 무시한다 — 임시 디렉터리는 OS가 결국 회수하고,
        // 여기서 던지면 이미 얻은 실험 결과를 잃는다.
      }
    },
  };
}

/**
 * oracle 파일을 workspace에 **주입한다.**
 *
 * 모델의 실행이 완전히 끝난 뒤에만 호출된다. 그전에 넣으면 모델이 정답 테스트를 읽고
 * 그것에 맞춰 코드를 쓸 수 있어 측정이 무의미해진다.
 *
 * 주입 시점에 workspace에 같은 이름이 이미 있으면 **덮어쓰지 않고 실패한다**:
 * 모델이 oracle 파일 이름을 추측해 만들어 두었을 수 있고, 그걸 덮어쓰면
 * "모델이 무엇을 했는지"가 기록에서 사라진다.
 */
export function injectOracle(fixture: LoadedFixture, workspaceRoot: string): { collisions: string[] } {
  const collisions: string[] = [];
  const walk = (from: string, relPrefix: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      const target = path.join(workspaceRoot, rel);
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true });
        walk(path.join(from, entry.name), rel);
        continue;
      }
      if (safeExists(target)) collisions.push(rel);
      cpSync(path.join(from, entry.name), target, { force: true });
    }
  };
  walk(fixture.oracleDir, "");
  return { collisions };
}

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 참조 patch 적용 — fixture가 실제로 풀 수 있는지 증명하는 데만 쓴다. */
export function applyReferencePatch(fixture: LoadedFixture, workspaceRoot: string): void {
  const patch = JSON.parse(readFileSync(fixture.referencePatchPath, "utf8")) as {
    files: { path: string; content: string }[];
  };
  if (!Array.isArray(patch.files) || patch.files.length === 0) {
    throw new Error(`${fixture.manifest.fixtureId}: reference.patch에 files가 없습니다`);
  }
  for (const file of patch.files) {
    if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) {
      throw new Error(`${fixture.manifest.fixtureId}: reference.patch가 workspace 밖을 가리킵니다: ${file.path}`);
    }
    const target = path.join(workspaceRoot, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

/** 실행 후 실제로 바뀐 파일 목록 (원본 fixture 대비). */
export function changedFilesSince(fixture: LoadedFixture, workspaceRoot: string): string[] {
  const before = new Map<string, string>();
  const collect = (dir: string, prefix: string, into: Map<string, string>): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        collect(path.join(dir, entry.name), rel, into);
      } else if (entry.isFile()) {
        into.set(rel, readFileSync(path.join(dir, entry.name), "utf8"));
      }
    }
  };
  collect(fixture.workspaceDir, "", before);
  const after = new Map<string, string>();
  collect(workspaceRoot, "", after);

  const changed = new Set<string>();
  for (const [rel, content] of after) {
    if (!before.has(rel) || before.get(rel) !== content) changed.add(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changed.add(rel);
  }
  return [...changed].sort();
}

/** 금지 경로를 건드렸는지. 건드렸다면 oracle 통과 여부와 무관하게 실패다. */
export function touchedForbiddenPaths(forbidden: readonly string[], changed: readonly string[]): string[] {
  const normalized = forbidden.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
  return changed.filter((c) =>
    normalized.some((f) => (f.endsWith("/") ? c.startsWith(f) : c === f || c.startsWith(`${f}/`)))
  );
}
