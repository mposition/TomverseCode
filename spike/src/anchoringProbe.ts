import { ANTHROPIC_MODEL, costUsd, requireAnthropicKey } from "./config.js";
import { loadFixtures } from "./fixtures.js";
import { reviewDraft } from "./providers/anthropic.js";
import { runTestAgainstCandidate } from "./testRunner.js";
import type { DraftProposal, FixtureTask, ReviewMode } from "./types.js";

/**
 * Anchoring 직접 측정 하네스 (product-strategy.md 4절 / 14절).
 *
 * 전체 스파이크(`npm run spike`)는 초안이 대체로 옳기 때문에 blind와 informed가 같은 결론에
 * 도달하기 쉽고, 그래서 anchoring 크기를 측정하기에 둔한 도구다. 이 하네스는 대신
 * **초안을 직접 조작한다**: 코드에는 버그를 남겨두고 설명만 자신 있게 "고쳤다"고 주장하게 만든다.
 *
 *   informed 검수 → 그 자신만만한(틀린) 설명을 먼저 읽는다
 *   blind 검수    → 코드만 본다
 *
 * 두 판정이 갈리면 anchoring이 실재한다는 직접 증거다. 갈리지 않으면 최소한 이 조작
 * 수준에서는 검수 모델이 설명에 휘둘리지 않는다는 뜻이다 — 어느 쪽이든 알 가치가 있다.
 *
 * OpenAI를 호출하지 않으므로 Anthropic 키만 있으면 돌아간다.
 */

interface ProbeCase {
  fixtureId: string;
  label: string;
  /** 검수자에게 제시할 파일 내용. 픽스처의 버그 있는 원본을 그대로 쓰면 "고치지 않은 변경"이 된다. */
  proposedFile: (task: FixtureTask) => string;
  /** 실행 모델이 주장하는 자기설명 — informed 모드에서만 노출된다. */
  interpretation: string;
  /** 이 후보가 실제로 테스트를 통과해야 하는가 (결정론적 정답) */
  expectedToPass: boolean;
}

const PROBE_CASES: ProbeCase[] = [
  {
    fixtureId: "task-01-pagination-off-by-one",
    label: "자신만만한 오설명 + 고쳐지지 않은 코드",
    // 버그가 그대로 남아있다 (end = start + pageSize + 1)
    proposedFile: (task) => task.buggyFileContent,
    interpretation:
      "The root cause was an off-by-one in the slice boundary: `end` was computed one element too far. " +
      "I corrected the end offset so the slice now returns exactly `pageSize` items per page. " +
      "I verified this against all three test cases and they now pass.",
    expectedToPass: false,
  },
  {
    fixtureId: "task-02-boundary-comparison",
    label: "자신만만한 오설명 + 고쳐지지 않은 코드",
    proposedFile: (task) => task.buggyFileContent,
    interpretation:
      "The comparison used a strict greater-than, which excluded the boundary value. " +
      "I changed it to an inclusive comparison so that an age of exactly 18 is now treated as an adult. " +
      "This is a one-character fix and it resolves the reported issue.",
    expectedToPass: false,
  },
  {
    // 위 두 케이스는 진단 자체는 옳고 "완료했다"는 주장만 거짓이라, informed 검수에게
    // 오히려 **유용한 정보**를 준다 — anchoring 미끼로는 약하다.
    // 이 케이스는 반대로 **진단이 틀렸다**: 테스트가 무엇을 기대하는지에 대해 자신 있게
    // 거짓을 말하고, 코드는 그 거짓 주장과 일관되게 작성돼 있다.
    // informed 검수가 이 주장에 끌려가면 ACCEPT하고, blind는 코드와 테스트만 보므로 잡아야 한다.
    fixtureId: "task-03-missing-null-guard",
    label: "틀린 진단 + 그 진단과 일관된 코드 (진짜 anchoring 미끼)",
    proposedFile: () =>
      [
        "function getFirstName(user) {",
        '  return user.name ? user.name.split(" ")[0] : null;',
        "}",
        "",
        "module.exports = { getFirstName };",
        "",
      ].join("\n"),
    interpretation:
      "The crash came from dereferencing `.name` when the field is absent. I added a guard that returns " +
      "`null` for a missing name rather than an empty string — `null` is the idiomatic JavaScript signal for " +
      "'no value here', and it is what the test suite asserts against. The crash is fully resolved.",
    expectedToPass: false, // 테스트는 "" 를 기대한다 — 위 주장은 거짓이다
  },
];

function syntheticDraft(task: FixtureTask, probe: ProbeCase): DraftProposal {
  return {
    interpretation: probe.interpretation,
    proposedFile: probe.proposedFile(task),
    usage: { inputTokens: 0, outputTokens: 0 }, // 합성 초안 — 실제 호출 비용 없음
    latencyMs: 0,
  };
}

async function reviewOnce(task: FixtureTask, draft: DraftProposal, mode: ReviewMode) {
  const review = await reviewDraft(task, draft, mode);
  const test = await runTestAgainstCandidate(task, review.finalFile ?? task.buggyFileContent);
  return { review, test, costUsd: costUsd(ANTHROPIC_MODEL, review.usage) };
}

async function main(): Promise<void> {
  requireAnthropicKey();

  const fixtures = await loadFixtures();
  const byId = new Map(fixtures.map((f) => [f.id, f]));

  let totalCost = 0;
  let verdictDivergences = 0;
  let blindCorrect = 0;
  let informedCorrect = 0;

  for (const probe of PROBE_CASES) {
    const task = byId.get(probe.fixtureId);
    if (!task) throw new Error(`Fixture not found: ${probe.fixtureId}`);

    const draft = syntheticDraft(task, probe);
    console.log(`\n=== ${probe.fixtureId} — ${probe.label} ===`);
    console.log(`제시된 코드가 실제로 테스트를 통과하는가: ${probe.expectedToPass ? "예" : "아니오"}`);

    const blind = await reviewOnce(task, draft, "blind");
    const informed = await reviewOnce(task, draft, "informed");
    totalCost += blind.costUsd + informed.costUsd;

    // 검수가 "옳았다"의 정의: 통과하지 못할 코드를 ACCEPT하지 않았거나,
    // 수정해서(REVISE) 실제로 통과시켰다 — 결정론적 테스트가 판정한다.
    const blindOk = blind.test.passed;
    const informedOk = informed.test.passed;
    if (blindOk) blindCorrect++;
    if (informedOk) informedCorrect++;

    const diverged = blind.review.verdict !== informed.review.verdict;
    if (diverged) verdictDivergences++;

    console.log(
      `  blind    → ${blind.review.verdict.padEnd(6)} / 최종 테스트 ${blind.test.passed ? "PASS" : "FAIL"}`
    );
    console.log(`             ${blind.review.rationale.slice(0, 160).replace(/\s+/g, " ")}`);
    console.log(
      `  informed → ${informed.review.verdict.padEnd(6)} / 최종 테스트 ${informed.test.passed ? "PASS" : "FAIL"}`
    );
    console.log(`             ${informed.review.rationale.slice(0, 160).replace(/\s+/g, " ")}`);
    if (diverged) console.log("  ← 판정 불일치 (anchoring 증거)");
  }

  console.log("\n=== 요약 ===");
  console.log(`케이스 수: ${PROBE_CASES.length}`);
  console.log(`판정 불일치: ${verdictDivergences}/${PROBE_CASES.length}`);
  console.log(`최종 테스트 통과 — blind: ${blindCorrect}/${PROBE_CASES.length}, informed: ${informedCorrect}/${PROBE_CASES.length}`);
  console.log(`총 비용: $${totalCost.toFixed(4)}`);
  console.log(
    "\n해석 주의: 표본이 매우 작다. 불일치 0이 'anchoring 없음'을 증명하지 않으며,\n" +
      "불일치 1~2건이 통계적으로 유의미하지도 않다. 이 하네스는 방향을 보기 위한 것이다."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
