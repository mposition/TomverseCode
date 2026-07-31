import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical.js";

/**
 * 승인 아티팩트의 **immutable 저장소** (§2.2).
 *
 * # 무엇을 고쳤나
 *
 * 예전에는 Run Card가 `<stage-dir>/p0-run-card.json` 하나에 **덮어쓰기**로 저장됐다. 그래서
 * `plan-pilot`을 다시 돌리면 (예산을 바꿔서든, evidence가 갱신돼서든) 그 파일이 조용히 다른
 * 내용이 됐다. 승인 절차가 "이 카드를 승인했다"고 말하는데 그 카드가 가리키는 파일은 시간에
 * 따라 달라지는 상태였고, 실행 기록은 자기가 어느 카드로 시작됐는지 남기지 않았다.
 *
 * # 구조
 *
 * ```text
 * <approvals-root>/
 *   cards/<cardId>.json
 *   evidence/<evidenceId>.json
 *   attestations/<attestationId>.json
 * ```
 *
 * # 불변식
 *
 * - **같은 id에 다른 내용을 쓸 수 없다.** 시도하면 `ArtifactConflictError`다.
 * - 같은 id에 **정확히 같은 내용**을 다시 쓰는 것은 허용한다(idempotent) — 재실행이나 중복
 *   호출이 실패로 끝나면 정상 흐름이 취약해지고, 내용이 같다면 잃는 것이 없다.
 * - 비교는 바이트가 아니라 **canonical JSON**으로 한다. 들여쓰기나 key 순서만 다른 재저장을
 *   "다른 내용"으로 보면 사람이 고칠 수 없는 실패가 생긴다.
 * - `id`는 파일 이름이 되므로 경로 구분자·`..`을 허용하지 않는다. 승인 아티팩트의 id는 우리가
 *   만들지만, 파일에서 읽은 id로 경로를 만드는 경로가 있으므로 여기서 막는다.
 */

export const APPROVALS_DIR = "approvals";
export const CARDS_DIR = "cards";
export const EVIDENCE_DIR = "evidence";
export const ATTESTATIONS_DIR = "attestations";

export class ArtifactConflictError extends Error {
  constructor(readonly file: string, message: string) {
    super(message);
    this.name = "ArtifactConflictError";
  }
}

export class ArtifactIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIdError";
  }
}

export interface ApprovalPaths {
  root: string;
  cards: string;
  evidence: string;
  attestations: string;
}

/**
 * 승인 번들의 위치.
 *
 * P0와 P1이 **같은 번들**을 공유한다 — evidence 하나가 두 단계의 근거이고, P1 카드가 P0
 * attestation을 가리키기 때문이다. 단계별 실행 디렉터리는 그 아래가 아니라 형제로 둔다.
 */
export function approvalPaths(outputRoot: string): ApprovalPaths {
  const root = path.join(outputRoot, APPROVALS_DIR);
  return {
    root,
    cards: path.join(root, CARDS_DIR),
    evidence: path.join(root, EVIDENCE_DIR),
    attestations: path.join(root, ATTESTATIONS_DIR),
  };
}

/** 파일 이름으로 쓸 수 있는 id인가. 경로를 벗어나는 값을 거부한다. */
export function assertSafeArtifactId(id: string): void {
  if (id.length === 0 || id.length > 200) {
    throw new ArtifactIdError(`아티팩트 id의 길이가 올바르지 않습니다 (${id.length}자)`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new ArtifactIdError(
      `아티팩트 id에 파일 경로로 쓸 수 없는 문자가 있습니다: ${JSON.stringify(id)} ` +
        `(허용: 영숫자와 . _ -)`
    );
  }
}

export function artifactPath(dir: string, id: string): string {
  assertSafeArtifactId(id);
  return path.join(dir, `${id}.json`);
}

export type StoreOutcome =
  /** 새로 썼다. */
  | { ok: true; created: true; file: string }
  /** 이미 같은 내용이 있었다. 아무것도 바꾸지 않았다. */
  | { ok: true; created: false; file: string };

/**
 * 승인 아티팩트를 **덮어쓰지 않고** 저장한다.
 *
 * 같은 내용의 재저장은 성공(idempotent), 다른 내용은 `ArtifactConflictError`.
 */
export function storeApprovalArtifact(dir: string, id: string, payload: unknown): StoreOutcome {
  const file = artifactPath(dir, id);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  if (existsSync(file)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new ArtifactConflictError(
        file,
        `이미 있는 승인 아티팩트를 읽을 수 없습니다: ${file} (${String(error).slice(0, 200)}). ` +
          `덮어쓰지 않았습니다 — 이 파일이 무엇이었는지 확인하세요.`
      );
    }
    if (canonicalJson(existing) !== canonicalJson(payload)) {
      throw new ArtifactConflictError(
        file,
        `같은 id(${id})로 **다른 내용**을 저장하려 했습니다: ${file}\n` +
          `승인 아티팩트는 만들어진 뒤 바뀌지 않습니다 — 이미 실행이 이 파일을 근거로 삼았을 수 ` +
          `있기 때문입니다. 새 계획이면 새 id로 만드세요.`
      );
    }
    return { ok: true, created: false, file };
  }

  mkdirSync(dir, { recursive: true });
  // `wx`: 파일이 이미 있으면 실패한다. 위 존재 검사와 이 쓰기 사이에 다른 프로세스가 만든
  // 경우를 잡는다 — 검사만으로는 그 창을 닫을 수 없다.
  try {
    writeFileSync(file, serialized, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // 경쟁하는 쪽이 방금 만들었다. 내용이 같으면 idempotent, 다르면 충돌이다.
      return storeApprovalArtifact(dir, id, payload);
    }
    throw error;
  }
  return { ok: true, created: true, file };
}

export type ArtifactLoad =
  | { found: true; raw: unknown; file: string }
  | { found: false; file: string; reason: string };

export function loadApprovalArtifact(dir: string, id: string): ArtifactLoad {
  let file: string;
  try {
    file = artifactPath(dir, id);
  } catch (error) {
    return { found: false, file: path.join(dir, id), reason: String(error) };
  }
  return loadApprovalArtifactByPath(file);
}

export function loadApprovalArtifactByPath(file: string): ArtifactLoad {
  if (!existsSync(file)) return { found: false, file, reason: `승인 아티팩트가 없습니다: ${file}` };
  try {
    return { found: true, raw: JSON.parse(readFileSync(file, "utf8")) as unknown, file };
  } catch (error) {
    return { found: false, file, reason: `승인 아티팩트를 읽을 수 없습니다: ${String(error).slice(0, 200)}` };
  }
}

/**
 * 사람이 "가장 최근 것"을 찾을 수 있게 하는 **안내용** 포인터.
 *
 * # 왜 이건 승인 근거가 아닌가
 *
 * 이 파일은 덮어쓰이므로 시간에 따라 내용이 달라진다. 승인의 대상이 시간에 따라 달라지면
 * "이것을 승인했다"는 말이 성립하지 않는다. 그래서 포인터는 **Run Card 형태가 아니다** —
 * 실수로 `--run-card`에 넘겨도 카드로 해석되지 않고 거부된다.
 */
export interface ApprovalPointer {
  kind: "approval-pointer";
  note: string;
  stage: string;
  artifactId: string;
  artifactHash: string;
  immutablePath: string;
  updatedAt: string;
}

export function writeApprovalPointer(file: string, pointer: ApprovalPointer): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`);
  return file;
}
