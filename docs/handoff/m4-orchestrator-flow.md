# 이관 프롬프트 — M4 `standard` 흐름, 오케스트레이터부터

로컬 Claude Code 세션에 **이 파일 전체를 붙여넣고 시작한다.** 앞선 세션의 맥락을 모르는
사람(또는 모델)이 이것만 읽고 바로 손을 댈 수 있게 쓰여 있다.

[m4-standard-flow.md](./m4-standard-flow.md)의 **후속**이다. 그쪽은 "설계는 끝났고 코드는 한
줄도 바뀌지 않았다"에서 시작했고, 이 문서는 **단계 A~F1이 끝난 자리**에서 시작한다.
그 문서는 여전히 유효하니 **1절(먼저 읽을 것)·5절(함정)·7절(하지 말 것)은 그대로 읽을 것.**
아래 2절이 그 문서의 2절을 대체한다.

---

## 0. 지금 상태 — 어디까지 됐고 어디가 빨간가

| | |
|---|---|
| 녹색 브랜치 | `claude/lucid-goldberg-l4fj7l` — 커밋 6개, `build`·`typecheck`·`test`·`core:test`·`desktop:check` 전부 통과 |
| **빨간 브랜치** | `claude/lucid-goldberg-l4fj7l-m4-flow` — 위 브랜치 + WIP 커밋 하나. **verify를 통과하지 않는다** |

### 끝난 것 (녹색 브랜치의 커밋 여섯)

| 커밋 | 단계 | 무엇을 |
|---|---|---|
| `6fe3c9d` | A | 레지스트리 키를 `modelId` → **경로**(`providerId, modelId, transport, cliVendor?`) |
| `6f7738a` | B | `EngineRole`에 `planReviewer`·`resultReviewer`, `RoutingDecision`에 검토자 둘의 독립성, `modelPins` 확장 |
| `e8bf90b` | C | `PerformanceProfile`·`EffortLevel`, `planRounds`·`maxSubtasks`·`escalationCalls`를 **TS·Rust·문서 세 사본 모두에** |
| `18ba80d` | D | `PlanOutline`에 `doneCriteria`·`requiredTests`·`subtasks`, `AcceptanceCriterion.source`에 `plan_outline`, `store.rs` 권위 정렬 |
| `e5c4e72` | E | 새 이벤트 여섯, 그중 승인 둘을 `NODE_MAY_NOT_EMIT`에 |
| `732935e` | F1 | 새 phase 다섯의 전이, **종류별 전이 그래프**(`PHASES_BY_KIND`), 등급 clamp(`orchestrator/grade.ts`) |

### 빨간 WIP 커밋 하나 — **이건 결함이 아니라 예고된 결합이다**

`a9c668d`에 라우터의 21.6절 A/B/C 사다리와 Rust 사용자 게이트가 들어 있다. 라우터가
`standard`에서 더 이상 `executor`+`reviewer`를 배정하지 않는데 오케스트레이터는 여전히
`activeRoles.includes("reviewer")`로 경로를 가른다 — **sidecar 테스트 20여 건이 빨갛다.**

단계 B 커밋이 이 결합을 미리 적어 두었다: *"사다리를 여기 넣으면 오케스트레이터가 조용히
검토를 건너뛰게 된다 — 흐름을 바꾸는 커밋과 **같은 커밋**이어야 하는 이유다."* 그 커밋이
아래 2.1절이다.

> **시작하기 전에 그 브랜치를 가져올 것.** 가져오지 않고 녹색 브랜치 위에서 시작하면
> 라우터 사다리와 Rust 게이트를 다시 쓰게 된다.

## 1. 남은 작업 — 이 순서인 데 이유가 있다

### 2.1 오케스트레이터 `standard` 흐름 (F2) — **WIP 커밋과 합쳐 하나의 녹색 커밋으로**

`packages/sidecar/src/orchestrator/orchestrator.ts`. 흐름은 72.2절 그대로다:

```
TRIAGE → OUTLINING            계획자 1명(fast) 또는 2명(verified, 대조)
       → AWAITING_PLAN_APPROVAL   ← 사용자 게이트 ①
       → PLAN_REVIEWING           B (건너뛸 수 있다)
       → [서브태스크마다] IMPLEMENTING → PLANNING → AWAITING_APPROVAL → EXECUTING
       → VERIFYING ⇄ FIX_LOOP
       → RESULT_REVIEWING         C (드롭됐으면 건너뛴다)
       → AWAITING_USER_VERIFICATION ← 사용자 게이트 ②
       → (커밋) → COMPLETED
```

**이미 있는 것을 다시 만들지 말 것:**

- `decideTier()`/`contrastRequested()`의 뒤집기는 **아직 안 했다.** 그 두 함수와
  이벤트 문자열 `"executionMode=verified — 항상 교차검증 경로"`가 그대로 있고,
  `evals/hypothesis-gate/test/triageCalibration.test.ts`가 그 문자열을 검사한다.
  **문자열이 계약이 된 자리이므로 같이 바꾼다.**
- `TaskPolicy.performanceProfile`/`effortLevel`은 타입·Rust·`host.rs`의 policy map에
  **이미 도착한다.** 읽는 쪽만 없다.
- 등급 계산은 `orchestrator/grade.ts`에 있다(`decideGrade`). **규칙이라 모델을 부르지 않는다.**
- 사용자 게이트는 `transport.request("gate.userDecision", { gate, taskId, card })`로
  Rust에 묻는다. 승인 이벤트는 **Rust가 기록한다** — Node가 내면 `db.appendEvent`가 거절한다.
- `validatePlanOutline`에 `requireSubtasks`·`maxSubtasks`를 넘겨야 `standard`에서 빈 계획이
  실패로 잡힌다. **넘기지 않으면 조용히 통과한다** — 그 책임을 지키는지는 오케스트레이터
  테스트가 봐야 한다(단계 D 커밋이 그렇게 적어 두었다).
- `buildPlanPrompt`에 `forExecution: true`를 넘겨야 모델이 `subtasks`를 낸다.

**주의할 자리:**

- `DRAFT_RECEIVED`에 **`acceptanceCriteriaReplaces`를 달지 않는다**(72.2.2절). 달면
  서브태스크 N개가 서로의 기준을 차례로 덮어써 체크리스트에 마지막 하나만 남는다.
- `fixLoopRounds`의 증가 지점을 **`FIX_LOOP` 진입**으로 바꾼다. 지금은 `VERIFYING` → fail
  판정 시인데, 72.8절 귀환 경로 1은 검증이 **통과한 뒤** 돌아오므로 그 정의로는 영원히 오르지 않는다.
- 서브태스크는 **순차**다(2.4절 결정 참조). `tasks.phase`가 하나뿐이라는 사실과 승인 모달이
  서브태스크마다 뜬다는 사실이 둘 다 그것을 요구한다.

### 2.2 에스컬레이션 봉투 (72.10.2절)

요청은 구현 모델이 산출물에 싣고, 허락은 계획 승인 카드가 하고, 판정은 오케스트레이터가 한다.
**봉투를 넘으면 거절하고 중간에 다시 묻지 않는다** — 되묻는 자리는 검증 체크리스트다.
`ESCALATION_CALLED`/`ESCALATION_REJECTED` 이벤트와 `escalationCalls` 카운터는 **이미 있다.**

거절된 요청의 산출물은 **그대로 쓴다.** 요청은 산출물에 실려 오므로 판정 시점에
`DraftProposal`은 이미 있고 이미 값을 치렀다.

### 2.3 예산을 단계로 나눈다 (72.12절)

| 시점 | 예약하는 것 |
|---|---|
| 태스크 시작 | 계획 단계 호출분 (작다) |
| **계획 승인** | 구현·검토 예산 |

승인으로 되돌아가면(B의 쟁점) 연 예약을 `released`로 닫고 다시 열되, **이미 쓴 것은 해제하지
않는다** — 72.8절 거부 경로 2는 구현이 이미 돈 뒤다. 되돌아가는 경로가 둘인데 한쪽만 보고
규칙을 적으면 나머지 한쪽에서 돈이 사라지거나 두 번 잡힌다.

### 2.4 화면 (단계 G)

**`apps/desktop/src/types.ts`의 `default: return "완료"`를 없애는 것이 첫 작업이다.**
지금 새 phase 다섯이 타입에는 있는데 매핑이 없어 **전부 "완료"로 접힌다.** 아직 그 phase에
진입하는 코드가 없어서 드러나지 않을 뿐이고, 2.1절이 끝나는 순간 **승인을 기다리는 태스크가
끝난 것으로 보인다.**

- `phaseToStage`의 시그니처가 바뀐다 — `AWAITING_APPROVAL`이 경로마다 다른 단계라
  `phase` 하나로는 표현되지 않는다. `stagesFor`와 **같은 자리**에 둔다.
- `STANDARD_STAGE_ORDER`를 만든다(72.2.3절 표). 선택자는 `(kind, complexityTier)`이고,
  tier가 `null`인 동안에는 **공통 접두사만** 그린다.
- `FleetPanel.tsx` — 2.5절 결정 참조.
- `apps/desktop/src/lib/callPlan.ts` — `planFor("verified")`가 `{ perRoundMax: 3, parts:
  ["실행자 2 (대조)", "검수자 1"] }`를 내고 **테스트가 그 옛 계약을 초록색으로 지킨다.**
  새 수는 `1(계획) + 1(대조) + 1(B) + N(구현) + 1(C)`다. `fast`의 2도 같이 틀린다.
  **이 수정은 회귀처럼 보인다 — 커밋 메시지가 그 사실을 적어야 한다.**
- 새 화면 둘: 계획 승인 카드(72.4절에 보여줄 것 명세가 있다)와 검증 체크리스트(72.8절).
  Rust가 `plan-approval-required`/`verification-required` 채널로 emit하고, 답은
  `respond_gate(taskId, gate, choice)` 명령으로 보낸다 — **둘 다 이미 배선돼 있다.**
- `PerformanceProfile`·`EffortLevel`을 고르는 자리(시작 화면의 실행 정책 옆).

### 2.5 계측 (단계 H) — **뒤로 미루지 말 것**

72.14절. **이 흐름이 이득인지 아직 측정되지 않았다.** 계측이 없으면 나중에 답할 수 없고,
답이 없으면 이 흐름을 품질 주장으로 쓸 수 없다.

`metrics.rs`에 **태스크 결말 집계가 없다** — `CANCELLED`/`REJECTED`를 가르지 못한다.
게이트가 둘이 되면서 "사용자가 그만둔 방식"이 처음 의미를 갖는다.

에스컬레이션 행은 **요청 / 호출 / 거절 셋을 따로 센다.** 거절을 세지 않으면 요청 수가 곧
호출 수가 되어 남발이 상한에 가려 보이지 않는다.

### 2.6 문서 (72.15절 표)

**표를 고치는 것으로 끝내지 말고, 고친 사실이 참인지 확인하고 적을 것.** 이 표에는 자동
검사가 없어서 "고쳤다"가 거짓이어도 아무것도 실패하지 않는다.

이번에 실제로 고친 줄: `TaskCounters`/`TaskLoopLimits` 세 사본, 7절 롤백 DDL 주변,
2.2절 `maxSubtasks` 저장 위치. **아직 안 한 줄**: ui-wireframes 3절 화면 인벤토리,
product-strategy 8.2절 Autopilot 행, multi-engine 10.5절·14절, `metrics.rs` 결말 집계.

## 2. 앞선 세션이 **정한 것** — 근거와 함께

원래 이관 문서 3절이 "시작 전에 사람이 정해야 한다"고 남긴 셋이다. **아직 문서에 반영되지
않았으므로 구현과 함께 문서에 남길 것.** 다시 정해도 되지만, 근거가 있는 답이니 먼저 읽을 것.

### ① `FleetPanel` — `FleetMemberStatus`에 `kind`와 `complexityTier`를 싣는다

`phaseToStage`의 시그니처가 바뀌는 근거는 *"같은 phase가 경로마다 다른 단계"*라는 사실이고,
그 사실은 Fleet 구성원에게도 **똑같이 참이다.** 화면마다 다른 매핑을 쓰면 같은 phase가
메인 화면과 Fleet 화면에서 다르게 읽히고, 그건 72.2.3절이 막으려던 오표시와 같은 종류다.

그리고 Fleet 구성원은 **"평범한 태스크"**다(CLAUDE.md의 fleet 설명) — 화면만 다른 규칙을
쓰면 그 구조적 사실이 화면에서 거짓이 된다. 싣는 비용은 필드 둘이고, 다른 표시를 만드는
비용은 **매핑을 하나 더 만들어 두 곳이 갈리게 하는 것**이다.

### ② `FIX_LOOP`는 구현자 집합 안에서, 쓰인 등급 중 **가장 높은 것**으로 돈다

- 검증은 태스크 전체에 대해 한 번 돌고, 실패가 **어느 서브태스크의 것인지 결정론적으로 가를
  수 없다.** 파일 단위 귀속을 시도하면 "계획에 없던 파일"(72.7절 `unplanned`)에 답이 없다.
- 가장 높은 등급을 고르는 것은 clamp와 **같은 방향**이다. 위험 하한선이 이미 "내려가지
  않는다"를 정했고, 실패를 고치는 자리에서 그것을 뒤집을 이유가 없다.
- **C의 "구현자 공급자" 집합에 든다.** 21.6절 불변식 C는 "코드를 썼는가"로 판정하지
  "계획에 있었는가"로 판정하지 않으며, `FIX_LOOP`는 정의상 코드를 쓴다. 공급자를 하나 더
  소비하지 않으려면 **이미 구현자 집합에 있는 공급자**를 고르면 되고, 그게 위 배정과 맞는다.

### ③ 서브태스크는 **순차**로 돌고, `tasks.phase`는 진행 중인 서브태스크의 phase다

접는 규칙이 필요 없어진다 — 동시에 진행되는 갈래가 없기 때문이다. 근거 셋:

- 승인 모달이 서브태스크마다 뜨는데(72.2.3절) **병렬이면 승인이 동시에 여러 개 뜬다.**
  그건 Fleet의 승인 큐 문제를 태스크 **안으로** 들여오는 것이다.
- 서브태스크는 같은 워크스페이스를 고치므로 병렬 실행은 쓰기 충돌을 만든다. Fleet이
  구성원마다 worktree를 하나씩 주는 이유가 그것이고, **서브태스크에는 그 격리가 없다.**
- 병렬이 주는 것은 지연 단축인데, 이 흐름의 지연은 이미 **사용자 게이트 둘이 지배한다.**

**몇 번째 서브태스크인가는 phase가 아니라 이벤트와 counters가 말한다** — `tasks.phase`는
파생 캐시이므로 거기에 인덱스를 얹지 않는다(원칙 7).

## 3. 이 세션에서 **새로 밟은 함정**

`CLAUDE.md`의 함정 절이 정본이다. 이번에 새로 드러난 것만 적는다 — **`CLAUDE.md`에 옮겨
적을 것.**

- **프롬프트에 섹션을 하나 더하면 `transmissionClaim.test.ts`가 잡는다.** 프롬프트에 실리는
  것은 전부 공급자로 나가므로 `transmission.rs`의 셋 중 하나로 분류해야 한다
  (화면이 설명하는가 / 우리 지시문인가 / 아직 세지 않는가). 좋은 검사이고, **모르고 만나면
  원인과 먼 실패로 읽힌다.**
- **`OUTLINING`을 두 경로가 공유하면 전이 그래프가 실재하지 않는 경로를 참으로 읽는다.**
  `EXECUTING → … → AWAITING_USER_VERIFICATION → OUTLINING → OUTLINED`가 생기고,
  *"읽기 전용 경로는 파일을 바꾸지 않는다"*가 거짓이 된다. 제외할 간선을 손으로 적는 대신
  **종류별로 지날 수 있는 phase를 적고 간선을 유도**했다(`PHASES_BY_KIND`).
  → 경로를 나누면 불변식이 **약해지기도 쉽다.** 극단적으로 전부 가두면 도달 불가가 되어
  검사가 공허해지므로, "계획 경로에 변경 phase가 없다"와 "변경 경로에 `OUTLINED`가
  **아예 없다**"를 따로 확인한다.
- **`unmeasured`를 B·C에서 막으면 fake 공급자로 그 경로를 태워볼 수 없다.** 카탈로그의
  실제 공급자는 전부 `unmeasured`이기 때문이다(21.8절: 측정 전까지 막혀 있다). fake 셋에
  **fixture 등급**을 붙여 풀었다 — 측정값이 아니고, 실제 공급자가 측정 없이 등급을 얻는
  것은 `registryAxes.test.ts`가 막는다. 라우터가 fake를 특별 취급하게 만드는 쪽이 더 나쁘다.
- **`desktop:check`는 이 환경에서 실제로 돈다.** GUI **개발** 패키지를 설치하면 된다
  (CLAUDE.md에 이미 적혀 있고, 이번에 다시 확인했다). 껍데기 드리프트는 **거기서만 보인다.**
- **`Record<TaskPhase, …>`는 새 phase를 컴파일로 잡지만 `phaseToStage`의 `default`는 안 잡는다.**
  같은 변경에서 한쪽은 빨개지고 한쪽은 조용하다.

## 4. 독립 검토 — **이 원격 환경에서는 Cursor CLI를 쓸 수 없다**

`cursor.com`·`downloads.cursor.com`·`api.cursor.sh`가 전부 네트워크 정책에 막혀 있어
(프록시가 CONNECT에 403) 설치 자체가 되지 않는다. npm의 `cursor-agent`는 **동명이인**이고
Cursor의 공식 CLI가 아니다.

**로컬에서는 될 가능성이 높다.** 로컬 세션에서 독립 검토를 돌릴 때:

```bash
cursor-agent --version          # 설치 확인
cursor-agent -p "..."           # non-interactive
```

디렉터리 신뢰를 물으면 허용한다(사용자가 이미 그렇게 지시했다). 검토 대상은
**빨간 WIP 커밋이 아니라 그것을 녹색으로 만든 커밋**이어야 한다 — 중간 상태를 검토시키면
"테스트가 깨져 있다"가 발견의 전부가 된다.

## 5. 검증

```bash
npm install          # verify는 의존성을 건드리지 않는다
npm run verify       # build → typecheck → core:build → test → core:test → desktop:check → test:e2e
scripts\verify.bat   # Windows 진입점 — 루트 verify와 **의미상 동일해야 한다**
```

리눅스에서 `desktop:check`를 돌리려면:

```bash
apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
                   libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev
```

**사람 몫으로 남는 것**은 원래 문서 6절 그대로다: `windows-landing` 착지 판정과 `--attest`,
릴리스 번들, 가설 게이트 유료 실행.

## 6. 하지 말 것 — 원래 문서 7절에 더해서

- **빨간 WIP 커밋을 녹색 브랜치에 그대로 병합하지 말 것.** 오케스트레이터 흐름과 **합쳐서**
  하나의 녹색 커밋이 되어야 한다.
- **사용자 게이트에 타임아웃을 붙이지 말 것.** 도구 승인의 600초/무응답=거부를 여기
  가져오면 72.5절(자리를 비운 사이)과 72.12절(예약이 잠긴 시간)이 둘 다 무효가 되고,
  점심 먹으러 간 사이에 작업이 `REJECTED`로 사라진다. 상한은 **사용자의 탈출구**가 진다 —
  취소는 새 다섯 phase 전부에서 들어오고, 무인 실행은 39절의 시한이 다룬다.
- **게이트 응답을 `granted: boolean`으로 뭉치지 말 것.** 선택지가 넷이고 카드마다 다른
  넷이다. 뭉치면 화면이 "승인 + 검토 생략"과 "승인 + 독립 검토"를 구별해 보낼 수 없다.
- **`unmeasured`를 `economy`로 접지 말 것.** 싸다는 것은 가격에 대한 사실이고 등급은
  품질에 대한 사실이다.
- **이 흐름을 품질 주장으로 쓰지 말 것.** 가설 게이트 G의 Protocol v1은 **FAIL**이었고
  (288회, $8.21, 실패한 초안 67건 중 61건이 그대로), 72절은 그 결과 **위에** 세운
  설계이지 그것을 뒤집은 설계가 아니다.

## 7. 커밋과 문서

- 커밋 메시지는 **무엇을 했는지보다 왜 그렇게 했는지**를 적는다.
- 설계 결정을 바꾸면 문서에 남긴다. 되돌리기 비싼 결정(프로세스 경계, 스키마, 보안 모델)은 반드시.
- 응답은 한국어로.
