# 이관 프롬프트 — M4 `standard` 개발 흐름 구현 시작

로컬 Claude Code 세션에 **이 파일 전체를 붙여넣고 시작한다.** 앞선 설계 세션의 맥락을 모르는
사람(또는 모델)이 이것만 읽고 바로 손을 댈 수 있게 쓰여 있다.

---

## 0. 지금 상태

**설계는 끝났고 코드는 한 줄도 바뀌지 않았다.** PR #29가 `main`에 병합되어 있고
(`docs/design/` 5파일, +2486/−42), 그 위에 후속 커밋 하나가 브랜치에 있다.

| | |
|---|---|
| 병합됨 | `mposition/TomverseCode` PR #29 → `main` (`ad74a0d`) |
| 미병합 | `claude/wonderful-newton-tcavpl`의 `853179d` — 10절 롤백 판정 정정. **먼저 병합하거나 함께 가져갈 것** |
| 검토 | 독립 검토 10라운드, 두 갈래(신규 검토자 + 적대적 사실 검증) 모두 최종 APPROVE |

시작 전에 `853179d`가 `main`에 있는지 확인한다. 없으면 그것부터 올린다 — 그 커밋은
**롤백 판정 기준을 터미널 이름에서 `file_mutations` 기록으로 바꾼 것**이라, 없으면 10절과
72절이 두 말을 하는 상태에서 구현을 시작하게 된다.

## 1. 먼저 읽을 것 — 순서대로

1. **`CLAUDE.md`** — 절대 어기면 안 되는 원칙 일곱. 특히 **1**(결정론적 검증 우선), **2**(Rust가
   신뢰 경계), **4**(검수자는 다른 공급자), **5**(모든 루프에 상한), **6**(`run_command`는 argv
   배열만), **7**(`task_events`가 진실의 원천).
2. **`docs/design/state-machine-and-protocol.md` 72절 전체** — 이번에 구현할 흐름. 9000줄대에 있다.
3. **같은 파일 72.15절** — **이 이관의 실제 작업 목록이다.** "정본 목록"과 "아직 바꾸지 않았고
   구현 시점에 반드시 함께 바꿔야 하는 것" 두 덩어리. 아래 2절이 그것을 순서로 편 것이다.
4. **`docs/design/multi-engine-routing.md` 21절** — 공급자 셋 추가, CLI 로그인 전송, 레지스트리
   키 변경.
5. 2.2절(루프 상한), 7절(스키마·이벤트), 9절(재시도), 10절(롤백) — 72절이 건드린 선행 절들.

**설계 문서가 정본이다. 문서와 코드가 다르면 문서를 의심하기 전에 72.15절을 먼저 볼 것** —
거기 적힌 것은 "아직 안 고친 코드"이고, 거기 없는 불일치는 새 발견이므로 그 표에 줄을 더한다.

## 2. 구현 순서 — 이 순서인 데 이유가 있다

각 단계는 **그 자체로 `npm run verify`를 통과하는 커밋**이어야 한다. 타입을 바꾸면 소비자가
같이 깨지므로 "타입만 먼저 전부" 같은 큰 걸음은 중간에 빨간 상태를 만든다.

### 단계 A — 레지스트리 키 (파급이 가장 넓다, 그래서 혼자 간다)

`packages/protocol/src/registry.ts`의 `ModelEntry` 키를 `modelId`에서 **경로**로 바꾼다:
`(providerId, modelId, transport, cliVendor?)`. `apiBaseUrl`이 필수 `string`이 아니게 되고,
`packages/sidecar/src/routing/registry.ts`의 `providerKindOf`(`entry.apiBaseUrl.startsWith("local://")`)가
**깨진다** — 21.7절이 그 함수의 `real | fake` 2값에 CLI를 접지 않기로 했으므로 **셋째 값을 여기서
정해야 한다.**

> **이 단계를 단계 B와 섞지 말 것.** 키가 바뀌면 레지스트리를 조회하는 모든 자리가 바뀌므로,
> 역할 타입 변경이 키 변경의 노이즈에 묻힌다(72.15절이 적어 둔 이유).

새 축도 여기서 더한다: `grade` / `accounting` / `transport` / `cliVendor` / effort 매핑 /
경로상 관할 **목록** / `gradeInheritedFrom`. **`accounting`을 `transport`의 파생값으로 두지
않는다**(21.4절) — 근거가 거기 있고, 파생으로 두면 사용량 과금 CLI가 나와도 타입이 그 사실을
막는다.

### 단계 B — 역할 타입

`EngineRole`/`RoleAssignment`가 **B(계획 검토)와 C(결과 검토)를 구별하지 못한다.**
`RoutingDecision.reviewerIndependent`도 검토자 **둘**의 드롭을 표현하지 못한다. 요구는
multi-engine 21.6절. 모양은 `activeRoles` 소비처의 파급을 보고 정한다.

`modelPins`도 **같은 커밋에서** 손본다 — 지금 `{ executor?, reviewer? }` 한 자리뿐이라 B·C를
갈라 지정할 수 없고 계획자(A) 자리도 없다. 따로 정하면 두 타입이 다른 역할 분류를 갖게 된다.
주석의 "co-executor는 지정할 수 없다"도 **co-planner**로 바꾼다(대조가 계획 단계로 옮겨갔다).

### 단계 C — 태스크 축과 상한

`packages/protocol/src/task.ts`:

- `PerformanceProfile`(`economy`/`balanced`/`max`, 기본 `balanced`)과
  `EffortLevel`(`low`/`medium`/`high`, 기본 `medium`) **둘 다** 더한다. 하나만 먼저 넣지 않는다.
- `TaskCounters`에 `planRounds`·`escalationCalls`, `TaskLoopLimits`에 그 둘의 천장과
  `maxSubtasks`. **세는 것과 상한을 갈라서 넣는다** — `maxSubtasks`는 상한이지 카운터가 아니다.
- **`apps/desktop/src-tauri/core/src/types.rs`의 `TaskCounters`/`TaskLoopLimits`에 같이 더한다.**
  지금 TS는 7필드, Rust는 5필드로 이미 갈려 있다(`mcpRounds`·`contextRounds`가 Rust에 없다).
  쓰기 경로가 payload를 그대로 넣어서 **이 불일치가 오류 없이 지나간다** — 읽는 자리를 만들기
  전에 맞춰야 한다. 문서 9절의 `TaskState.counters` 블록이 **세 번째 사본**이니 그것도 같이.
- `ExecutionMode` 주석 **두 문장 모두** 고친다: *"verified: TRIAGE 결과와 무관하게 항상
  standard"*와 *"대조(executor ×2)는 이 축이 정한다"*. 앞만 고치면 뒷문장이 옛 설계를 계속 말한다.

### 단계 D — 계획 타입과 판정 저장

- `proposal.ts` — `PlanOutline`에 `doneCriteria`·`requiredTests`·`subtasks`, 새 `PlanSubtask`.
- `validate.ts` — `standard`에서 **빈 `subtasks`를 실패로** 다룬다.
- `decision.ts` — `AcceptanceCriterion.source`에 `plan_outline`.
- `apps/desktop/src-tauri/core/src/store.rs` — `ORDER BY (source = 'user_decision') DESC`
  **한 곳**(72.2.1절이 그 SQL을 인용했다)과 source enum 주석.

### 단계 E — 이벤트와 신뢰 경계

`packages/protocol/src/events.ts`의 `TaskEventType`에 여섯을 더한다:
`PLAN_APPROVED`, `USER_VERIFICATION_APPROVED`, `PLAN_REVIEW_COMPLETED`,
`RESULT_REVIEW_COMPLETED`, 그리고 에스컬레이션 **호출/거절** 둘.

**앞의 둘은 `apps/desktop/src-tauri/core/src/host.rs`의 `NODE_MAY_NOT_EMIT`에 넣는다.**
빠뜨리면 장악당한 sidecar가 **자기 계획을 스스로 승인**하고, 72.12절이 예산 예약을 그 승인에
묶은 뒤로는 **구멍 하나가 둘을 뚫는다**(원칙 2·3). `packages/toolchain/test/rustOnlyEvents.test.ts`가
함께 움직인다.

### 단계 F — 오케스트레이터 (여기가 본체다)

`packages/sidecar/src/orchestrator/orchestrator.ts`:

- `decideTier()`의 *"사용자가 UI에서 Verified를 고르면 TRIAGE 결과와 무관하게 standard다"* —
  **72.9절이 뒤집는 것이 정확히 이 코드다.** `verified`는 "계획자를 둘 부르라"는 지시이지
  "이 태스크를 어렵게 다루라"는 지시가 아니다.
- `contrastRequested()`의 *"tier는 교차검증을, 실행 모드는 대조를 켠다"*.
- 이벤트 문자열 `"executionMode=verified — 항상 교차검증 경로"` — **문자열이 계약이 된 자리**라
  `evals/hypothesis-gate/test/triageCalibration.test.ts`가 그것을 검사한다. 같이 바꾼다.
- 새 phase 다섯과 그 전이. `fixLoopRounds`의 증가 지점을 *"`VERIFYING` → fail 판정 시"*에서
  **"`FIX_LOOP`에 진입할 때마다"**로 바꾼다(72.11절 — 그 변경만으로 72.8절 귀환 경로 1이 닫힌다).

### 단계 G — 화면

- `apps/desktop/src/types.ts` — `phaseToStage`의 **`default: return "완료"`를 없애는 것이 첫
  작업이다.** 새 phase를 더하고 매핑을 잊으면 **승인 대기 중인 태스크가 "완료"로 표시된다.**
  그리고 시그니처가 바뀐다 — `AWAITING_APPROVAL`이 경로마다 다른 단계라 `phase` 하나로는
  표현되지 않는다.
- **호출자가 둘이다.** `App.tsx`는 `taskKind`와 `routing?.complexityTier`를 넘길 수 있는데
  `FleetPanel.tsx`는 `FleetMemberStatus`에 그 둘이 **없다.** 아래 3절의 미결정 사항이다.
- `apps/desktop/src/lib/callPlan.ts` — `planFor("verified")`가 `{ perRoundMax: 3, parts: ["실행자 2 (대조)", "검수자 1"] }`를
  내고 **테스트가 그것을 초록색으로 지킨다**(`apps/desktop/test/callPlan.test.ts`의
  *"verified는 실행자를 둘 부른다"*). 새 호출 수는 `1(계획) + 1(대조) + 1(B) + N(구현) + 1(C)`다.
  **이 수정은 회귀처럼 보인다 — 커밋 메시지가 그 사실을 적어야 한다.** `fast`의 2도 같이 틀린다.
- 새 화면 둘: **계획 승인 카드**(72.4절에 보여줄 것 명세가 있다)와 **검증 체크리스트**(72.8절).
  `PerformanceProfile`·`EffortLevel`을 고르는 자리도 있어야 한다(시작 화면의 실행 정책 옆).
- `metrics.rs`에 **태스크 결말 집계**가 없다 — `CANCELLED`/`REJECTED`를 가르지 못한다. 게이트가
  둘이 되면서 "사용자가 그만둔 방식"이 처음 의미를 가진다. 72.14 계측과 함께.

### 단계 H — 계측 (뒤로 미루지 말 것)

72.14절. **이 흐름이 이득인지 아직 측정되지 않았다.** 계측이 없으면 나중에 답할 수 없고,
답이 없으면 이 흐름을 품질 주장으로 쓸 수 없다. 에스컬레이션 행은 **요청 / 호출 / 거절 셋을
따로 센다** — 거절을 세지 않으면 요청 수가 곧 호출 수가 되어 남발이 상한에 가려 보이지 않는다.

## 3. 시작 전에 사람이 정해야 하는 것

구현 중에 만나면 멈추게 되는 것들이다. 설계가 **일부러** 비워 둔 자리이고 72.16절에 근거가 있다.

1. **`FleetPanel`을 어떻게 할 것인가** — `FleetMemberStatus`에 `kind`/`complexityTier`를 실을
   것인가, 아니면 Fleet 화면이 다른 표시를 쓸 것인가. **Fleet 화면이 구성원별 진행 단계를 얼마나
   자세히 보여야 하는지**가 먼저 정해져야 답이 나온다.
2. **`FIX_LOOP`가 어느 등급·공급자로 도는가** — 서브태스크마다 등급이 다른데 검증은 태스크
   전체에 대해 한 번 돈다. 그리고 그 모델이 **C의 "구현자 공급자" 집합에 드는지**도 정해야 한다.
   들지 않으면 C가 고치지 않은 코드를 검토하는 셈이고, 든다면 공급자가 하나 더 소비된다.
3. **서브태스크가 N개일 때 `tasks.phase`가 무엇을 뜻하는가** — 파생 캐시는 값 하나인데 구현은
   여러 갈래다. 접는 규칙이 없으면 화면이 "무엇을 하는 중인가"에 답하지 못한다(원칙 7).

## 4. 확인하지 않은 외부 사실 — CLI 어댑터를 쓰기 전에

문서가 **스스로 미확인이라 선언한** 것이다. 추측으로 채우지 말 것(21.3절 규칙: 확인 날짜와 함께 적는다).

- CLI 실행 파일 이름(`codex` / `claude` / `cursor-agent`)과 **Cursor가 여러 공급자를 중개한다**는 성질
- 각 사 **약관**이 서드파티 제품의 자동 호출을 허용하는지 — 인용해서 적는다
- effort 파라미터의 공급자별 **이름·단위·허용값** — 확인 전에는 `effort: "none"`으로 둔다
- **추론 토큰이 출력 예산에서 나가는 공급자가 있는가** — 있으면 10.5절 상한 계산에 effort가
  들어가야 하고, 없으면 자리만 비워 둔다

## 5. 이 환경에서 이미 밟은 함정 — 다시 밟지 말 것

`CLAUDE.md`의 "이 환경에서 이미 밟은 함정" 절이 정본이다. **이번 작업에 직접 걸리는 것만** 추린다.

- **한 워크스페이스만 빌드하면 낡은 `.d.ts`에 대해 컴파일된다.** protocol 타입을 바꾸는 작업이라
  이게 계속 걸린다. 검증 순서 `build → typecheck → core:build → test → core:test → test:e2e`는
  고정이고 이유가 있다.
- **`node --test <디렉터리>`가 동작하지 않는다.** 새 테스트 파일을 만들면 `package.json`의 목록에
  직접 추가한다.
- **`cargo`를 직접 부르지 말 것.** `scripts/cargo.mjs`를 지난다(MSVC 환경 + PATH).
- **Windows `npm`은 `npm.cmd`다.** `Command::new("npm")`은 실패하고, 증상이 고약하다 — 검증
  러너가 테스트를 못 돌려 **정상 수정이 검증 없이 완료로 보고**된다.
- **`ToolStatus::Ok`은 "명령이 성공했다"가 아니다.** 종료 코드를 따로 본다.
- **소스를 검사하는 테스트는 자기 자신을 센다.** needle을 런타임에 조립한다.
- **`.bat`는 CRLF여야 한다.**

## 6. 검증

```bat
scripts\verify.bat
```

루트 `npm run verify`와 **의미상 동일해야 한다.** 한쪽만 고치면
`packages/toolchain/test/verifyOrder.test.ts`가 실패한다.

리눅스 CI가 `npm run verify`를 끝까지 돌리지만, **사람 몫으로 남는 것**이 있다:
`windows-landing` 착지 판정과 `--attest`(Job Object·Credential Store·npm shim 해석·MSVC는
리눅스 러너가 판정할 수 없다), 릴리스 번들, 가설 게이트 유료 실행.

## 7. 하지 말 것

- **`run_command` allowlist에 CLI를 넣지 않는다.** 제품이 부르는 경로와 모델이 부를 수 있는
  경로는 **다른 문이어야 한다**(21.7절).
- **CLI 엔트리에 독립된 `providerId`를 주지 않는다.** 주면 독립성 불변식이
  `"anthropic ≠ claude-code-cli"`를 참으로 읽고, 같은 모델에게 초안과 검수를 맡기고 "독립
  검증"이라고 기록한다.
- **`apiBaseUrl` 덮어쓰기 경로를 만들지 않는다**(21.5절). 국제 엔드포인트 정책이 설정 한 줄로
  우회된다.
- **상한 없는 루프를 새로 만들지 않는다.** 봉투를 넘는 에스컬레이션은 **거절**이고, 되묻는
  자리는 검증 체크리스트다(72.10.2절).
- **`effort`가 통과율을 바꾼다고 주장하지 않는다.** 노출하는 것과 효과를 주장하는 것은 다른
  일이고, 후자만 측정을 요구한다.
- **이 흐름을 품질 주장으로 쓰지 않는다** — 가설 게이트 G의 Protocol v1은 **FAIL**이었다
  (288회, $8.21, 교차검증 informed 15.3% vs blind 11.1%, **실패한 초안 67건 중 61건이 그대로**).
  72절은 그 결과 **위에** 세운 설계이지 그것을 뒤집은 설계가 아니다.

## 8. 커밋과 문서

- 커밋 메시지는 **무엇을 했는지보다 왜 그렇게 했는지**를 적는다.
- 설계 결정을 바꾸면 문서에 남긴다. 되돌리기 비싼 결정(프로세스 경계, 스키마, 보안 모델)은 반드시.
- **72.15절 표를 고치는 것으로 끝내지 말고, 고친 사실이 참인지 확인하고 적는다.** 이 표에는
  자동 검사가 없어서 "고쳤다"가 거짓이어도 아무것도 실패하지 않는다 — 설계 세션에서 실제로
  한 번 그랬다.
- 응답은 한국어로.
