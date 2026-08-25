/**
 * 스킬 보관함을 **화면 문장으로** 옮긴다 — state-machine 36절.
 *
 * # 이 자리에서 하기 쉬운 거짓말
 *
 * ① **깨진 항목을 목록에서 지우는 것.** 지우면 사용자는 자기 파일이 왜 안 보이는지 모른다 —
 *    "없다"와 "읽지 못했다"는 다른 사실이다.
 *
 * ② **저장소의 제안을 보관함과 한 목록에 섞는 것.** 하나는 이미 승인된 것이고 다른 하나는
 *    아직 아무것도 아니다. 섞으면 사용자는 저장소가 둔 것을 자기가 승인한 것으로 읽는다.
 *
 * ③ **"가져왔습니다"를 "적용했습니다"로 쓰는 것.** 가져오기는 보관함에 사본을 만들 뿐이고,
 *    태스크에 쓰이는 것은 그 다음에 고를 때다.
 */

export interface LibraryEntry {
  file: string;
  name?: string;
  summary?: string;
  problem?: string;
}

export interface SkillLibraryView {
  library: LibraryEntry[];
  proposed: LibraryEntry[];
  libraryDir: string;
}

export interface EntryLabel {
  file: string;
  /** 화면에 보일 한 줄. */
  text: string;
  /** 고를 수 있는가 — 읽지 못한 항목은 고를 수 없다. */
  usable: boolean;
}

/** 보관함 항목 하나의 표시 문장. */
export function labelEntry(entry: LibraryEntry): EntryLabel {
  if (entry.problem) {
    // **파일 이름을 앞에 둔다.** 사용자가 고칠 대상은 파일이고, 이름은 읽지 못해서 없다.
    return { file: entry.file, text: `${entry.file} — 읽지 못했습니다: ${entry.problem}`, usable: false };
  }
  return { file: entry.file, text: entry.summary ?? entry.file, usable: true };
}

export interface LibrarySummary {
  /** 고를 수 있는 항목 수. */
  usable: number;
  /** 읽지 못한 항목 수. **따로 센다** — 합치면 "5개 있음"이 거짓이 된다. */
  broken: number;
  headline: string;
}

export function summarizeLibrary(view: SkillLibraryView | null): LibrarySummary {
  const entries = view?.library ?? [];
  const broken = entries.filter((e) => e.problem).length;
  const usable = entries.length - broken;
  if (entries.length === 0) {
    // **"0개"라고 쓰지 않는다** — 있었는데 사라진 것처럼 읽힌다. 어디에 두는지를 말한다.
    return {
      usable,
      broken,
      headline: `보관함이 비어 있습니다. 스킬 파일을 상태 디렉터리의 \`${view?.libraryDir ?? "skills"}\` 안에 두거나, 저장소의 제안을 가져오세요.`,
    };
  }
  const brokenNote = broken > 0 ? ` (읽지 못한 것 ${broken}개)` : "";
  return { usable, broken, headline: `보관함에 스킬 ${usable}개${brokenNote}` };
}

export interface ProposalSummary {
  show: boolean;
  headline: string;
  /** 아직 보관함에 없는 것들 — 가져오기를 권할 대상. */
  importable: LibraryEntry[];
}

/**
 * 저장소가 제안한 스킬.
 *
 * **이미 보관함에 있는 이름은 가져오기를 권하지 않는다.** 덮어쓰지 않으므로 눌러도 거절되고,
 * 누를 이유 없는 버튼은 사용자를 헷갈리게 한다.
 */
export function summarizeProposed(view: SkillLibraryView | null): ProposalSummary {
  const proposed = view?.proposed ?? [];
  if (proposed.length === 0) return { show: false, headline: "", importable: [] };
  const have = new Set((view?.library ?? []).map((e) => e.file));
  const importable = proposed.filter((e) => !have.has(e.file) && !e.problem);
  return {
    show: true,
    // **"등록되었습니다"가 아니다.** 저장소는 제안했을 뿐이다.
    headline: `저장소가 스킬 ${proposed.length}개를 제안합니다 — 가져와야 보관함에 들어갑니다.`,
    importable,
  };
}
