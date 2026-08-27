# 가설 게이트 G

> 어려운 코딩 작업에서 OpenAI 초안 + 독립 Anthropic 검수가
> **가장 강한 단일 모델 실행**보다 결정론적 성공률을 의미 있게 높이는가?

이건 제품 코드가 아니라 **측정 도구**다. 제품의 방향(M1 차별화 기능에 투자할지)이 이 질문의 답에
달려 있고, Phase 0 스파이크는 *쉬운* 태스크에서 교차검증의 이득이 **0%**였다고 실측했다
(비용 1.63배, 지연 1.70배). 어려운 태스크에서는 다를 것이라는 가정 위에 제품 전략의 상당 부분이
서 있으므로, 그 가정을 여기서 확인한다.

## 왜 이 실험을 믿을 수 있어야 하는가

측정 도구가 측정 대상과 다르면 아무것도 말해주지 않는다. 그래서:

- **production 실행 경로를 그대로 태운다.** 하네스는 `tomverse-host`를 실제 프로세스로 띄운다.
  별도 OpenAI/Anthropic 클라이언트를 만들지 않고, patch를 직접 적용하지 않고, Policy Gate를
  우회하지 않는다. arm 구성만 인자로 바뀐다.
- **oracle이 판정한다.** 모델의 verdict("이 patch는 옳다")는 성공 판정에 쓰지 않는다.
  측정 대상이 자기 점수를 매기게 하면 측정이 아니다.
- **판정 기준을 결과보다 먼저 고정했다.** `src/criteria.ts`에 있고 해시로 봉인되어 있으며
  리포트에 그 해시가 찍힌다. 바꾸려면 `PROTOCOL_VERSION`을 올려야 하고, 그건 새 실험이다.
- **fake provider 결과로는 판정하지 않는다.** 모든 기록에 `providerKind`가 남고, 집계 단계가
  `fake` 기록만 있으면 무조건 `INCONCLUSIVE`를 낸다.

## 실험 arm

| Arm | 설명 | 공급자 | review mode | 초안 |
|---|---|---|---|---|
| A | OpenAI 단독 | openai | — | 새로 생성 |
| B | Anthropic 단독 | anthropic | — | 새로 생성 |
| C | 교차검증 (informed) | openai + anthropic | informed | **Arm A 재사용** |
| D | 교차검증 (blind) | openai + anthropic | blind | **Arm A 재사용** |

**A/C/D가 같은 초안을 공유한다.** 그래서 A↔C 차이는 검수 단계의 순효과이고, C↔D 차이는
review mode의 순효과다. 각 arm이 초안을 새로 생성하면 초안 품질의 분산이 효과 추정에 섞인다.

**"단독" arm에 별도 분기를 만들지 않았다.** 후보 공급자를 하나로 좁히면 라우터의
검수자 독립성 불변식이 스스로 reviewer를 드롭한다 — 즉 Arm A/B는 **production이 단일 공급자
환경에서 실제로 하는 동작**과 같다.

Arm B가 필요한 이유: 교차검증의 이득이 파이프라인 효과인지 단순히 Anthropic이 더 나은 것인지
구별하려면 두 단일 모델을 모두 재야 한다.

## Fixture

24개, 8개 카테고리 × 3개. **TypeScript 20개 + Rust 4개.**

```
fixtures/<id>/
  manifest.json      과제·검증 명령·금지 경로·불변식
  workspace/         모델이 보는 저장소 (oracle 없음)
  oracle/            숨겨진 판정 테스트 — 실행이 끝난 뒤에만 주입된다
  reference.patch    이 fixture가 풀 수 있음을 증명하는 참조 수정
```

Rust fixture(`cargo test`)는 Windows에서 MSVC 툴체인을 요구한다. 일반 PowerShell에는
`INCLUDE`/`LIB`가 없어 컴파일은 되고 **링크에서** `LNK1104: cannot open file 'msvcrt.lib'`로
실패하므로, `gate:g:validate`가 cargo를 부르기 전에 `scripts/msvc-env.bat`으로 환경을 준비한다.
준비에 실패하면 링크 오류까지 가지 않고 **무엇을 설치해야 하는지 먼저 알려주고 종료 코드 4**로 끝난다.
TypeScript fixture 20개는 MSVC 없이도 그대로 검증된다.

`npm run gate:g:validate`가 모델 호출 없이 다음을 확인한다:

1. 초기 상태에서 oracle이 **실패**한다 (통과하면 측정할 것이 없다)
2. 참조 patch를 적용하면 oracle이 **통과**한다 (풀 수 없는 fixture는 모두를 실패시킨다)
3. oracle 파일이 workspace에 없고, oracle 코드가 workspace에 복사되지도 않았다
4. 두 번 만들어도 같은 내용이고 서로 격리된다
5. **공개 테스트를 전부 지워도 oracle을 통과할 수 없다**

공개 검증이 초기에 통과하는 fixture도 있다 — 그건 결함이 아니라 "공개 테스트로는 드러나지 않는
숨은 불변식 위반" 유형이고, 현장에서 더 어려운 쪽이다.

### 무엇을 "어렵다"고 부르는가

이 세트는 줄곧 "어려운 태스크 24개"로 불렸고 사전 등록된 기준에도 그렇게 적혀 있는데,
**정의도 검사도 없었다.** `validate`가 보는 것은 유효성(풀 수 있는가, oracle이 새는가,
부정행위로 통과되는가)이지 난이도가 아니다. 그 사이 라벨을 쓰는 측정이 하나 생겼다
(state-machine-and-protocol.md 13.4절의 TRIAGE 캘리브레이션은 이 24개를 "어려움" 정답지로 쓴다).

**정의를 outcome으로 두면 유료이거나 순환이다.** 가장 자연스러운 정의("가장 강한 단일 모델이
실패한다")는 유료 실행을 해야 알 수 있고, 사전에 쓰면 게이트가 재려는 축을 미리 정해버린다.

그래서 **둘로 나눈다.**

| | 정의 | 언제 아는가 |
|---|---|---|
| **필요조건** | 보이는 신호(태스크 설명 + 공개 검증)가 정답을 결정하지 않는다 | 지금, 무료 |
| **충분조건** | 가장 강한 단일 모델이 실패한다 | 게이트 실행이 내놓는 값 |

필요조건은 구조로 판정한다. 신호가 정답을 결정하지 못하는 방식은 둘이다.

1. **증상이 보이지 않는다** — 고치기 전인데 공개 검증이 통과한다.
2. **부분 수정이 완성처럼 보인다** — 참조 수정의 한 조각을 되돌려도 공개 검증은 통과하는데
   oracle은 실패한다.

```bash
npm run gate:g:difficulty   # 모델 호출 없음
```

참조 수정을 줄 단위 조각으로 쪼개 **하나씩만 되돌려** 공개/oracle을 다시 돌린다.
**fixture에 새 파일을 추가하지 않는다** — `workspace/`와 `reference.patch`에서 유도되므로
"어렵게 보이도록 자료를 손보는" 경로가 없다.

**실측: 24개 중 21개가 필요조건을 만족한다.** 전부 `증상이 보이지 않음` 유형이고,
`mfc-01-pagination-contract`·`mfc-02-currency-units`·`sec-01-path-traversal` 셋은 공개 검증이
모든 조각을 잡는다. **셋을 실격시키지는 않는다** — 이 판정이 재는 것은 신호의 불완전성이지
난이도 전부가 아니고, 세트의 성질을 알고 결과를 읽는 것이 목적이다.

판정하지 못한 fixture는 **쉬운 쪽으로 세지 않는다.** 툴체인이 없어 명령이 돌지 않으면
`판정 못 함`이고, 뭉개면 그런 기계에서 세트가 조용히 쉬워 보인다.

## 사용

```bash
npm run gate:g:test       # 하네스 자동 테스트 (실제 API 없음, npm test에도 포함된다)
npm run gate:g:validate   # fixture 품질 검증 (모델 호출 없음)
npm run gate:g:difficulty # fixture가 실제로 "어려운지" 구조로 판정 (모델 호출 없음)
npm run gate:g:triage-calibration  # TRIAGE 임계값 표 (모델 호출 없음 — 아래 참조)
npm run gate:g:dry-run    # preflight + 실행 계획만 ("확인하지 않은 것"을 함께 낸다 — 아래)
npm run gate:g:plan-pilot # **단계별(P0/P1) 유료 실행 승인 카드** (실제 API 호출 0건)
npm run gate:g:probe-models  # 역할당 **최소 요청 1회**로 모델을 실제 확인 (--max-cost-usd 필수)
npm run gate:g:budget-status # 예산 상태 **읽기 전용** 조회 (열린 예약 확인. 고치지 않는다)
npm run gate:g:attest-p0     # P0 결과를 검사해 attestation 생성 (API 호출 없음)
npm run gate:g:pilot      # 반복 1회. 하네스·비용·실패 분류 확인용. PASS를 내지 않는다
npm run gate:g:run        # confirmatory (기본 반복 3회)
npm run gate:g:report     # 기존 기록으로 리포트만 재생성
```

옵션: `--fixtures a,b` `--arms A,B,C,D` `--repetitions N` `--seed N`
`--max-cost-usd N` `--max-concurrency 1` `--resume` `--output <run-dir>`
`--stage smoke|pilot|confirmatory` `--executor-model <id>` `--reviewer-model <id>`
`plan-pilot` 전용: `--p0-max-cost-usd N` `--p1-max-cost-usd N`
유료 실행 필수: `--run-card <path>` (선택: `--probe-evidence <path>`)

### preflight의 "막는 요인 없음"은 "실행할 수 있다"가 아니다

`dry-run`의 preflight가 보는 것은 **자격증명이 존재하는가** 하나뿐이다. 그래서 blocker 목록이
비어도 실행이 되리라고 말할 수 없고, blocker가 하나면 "그것 하나만 넣으면 된다"고도 말할 수 없다.
실측 사례가 이 저장소 개발 환경에 있다 — `OPENAI_API_KEY`가 설정되어 있는데 egress 프록시가
공급자 호스트를 막는다. 존재만 본 점검은 그 사실을 볼 방법이 없다.

그래서 preflight는 **확인하지 않은 것**을 함께 낸다(`PreflightReport.notChecked`), 그리고
**막는 요인이 없어도 낸다**:

- 그 키로 공급자 호스트에 **닿는가** (프록시·방화벽·오프라인)
- 그 키가 그 **모델을 부를 수 있는가** (조직 인증 — `gpt-5` 사례)
- 그 키가 **유효한가** (만료·오타·다른 프로젝트의 키)

셋 다 실제 호출로만 답이 나오고, 그 호출을 하는 것이 `probe-models`다. 유료 pilot이 probe
evidence 없이 승인되지 않는 이유가 이것이다.

**진행 순서** — 각 단계가 다음 단계의 **입력**이다:

```
plan-pilot            카드 상태 READY_FOR_MODEL_PROBE (자격증명은 있으나 실제 확인이 없음)
  ↓
probe-models          역할당 요청 1회 → model-probe/probe-evidence.json
  ↓
plan-pilot            evidence를 읽어 P0 카드 = READY_FOR_P0_APPROVAL, 카드 파일 저장
  ↓
pilot --run-card ...  카드 해시·인자·예산·evidence·자격증명 binding 확인 후 P0 실행
  ↓
attest-p0             8건 전부 정상인지 검사 → p0-attestation.json
  ↓
plan-pilot            attestation을 읽어 P1 카드 = READY_FOR_P1_APPROVAL
  ↓
pilot --run-card ...  P1 실행
```

카드 상태는 곧 다음 행동이다:

| 상태 | 뜻 |
|---|---|
| `BLOCKED_MISSING_CREDENTIALS` | 키가 없다. probe도 실행도 불가능하다 |
| `READY_FOR_MODEL_PROBE` | 오프라인으로 확인할 수 있는 것은 다 됐다. 다음은 probe |
| `BLOCKED_INVALID_PROBE_EVIDENCE` | evidence가 손상·불일치·만료됐다 |
| `BLOCKED_PENDING_P0_RESULT` | P1인데 P0 attestation이 없다 |
| `READY_FOR_P0_APPROVAL` / `READY_FOR_P1_APPROVAL` | 유료 실행을 승인할 수 있다 |

종료 코드: `0`=PASS, `1`=FAIL, `2`=INCONCLUSIVE, `3`=하네스 오류, `4`=툴체인 미준비.

## fixture 세트의 두 번째 쓸모 — TRIAGE 임계값 캘리브레이션

이 fixture 24개는 **난이도 라벨이 붙은 태스크 세트**이기도 하다. 그게 게이트 G 말고 다른 질문
하나를 공짜로 닫는다.

state-machine-and-protocol.md 12절은 TRIAGE 임계값 튜닝을 *"'어려운' 태스크 세트로 스파이크를
재실행"* 이라고 적어두었고 그래서 **유료 API 대기**로 분류되어 있었다. 그런데 TRIAGE는 모델을
부르지 않는다 — 재실행이 필요했던 이유는 판정이 아니라 **어려운 태스크 세트가 없어서**였다.
지금은 여기 있다.

```bash
npm run gate:g:triage-calibration
```

- 어려움 24건(이 fixture) + 쉬움 5건(Phase 0 스파이크, **읽기만 한다**)에 규칙을 태운다
- `tomverse-host`를 `--mode fast`로 띄운다 — **규칙이 실제로 판정하게 두는 유일한 모드**다
  (게이트 arm이 쓰는 `verified`는 TRIAGE 결과와 무관하게 항상 교차검증 경로다)
- 공급자는 레지스트리의 `local://` fake 항목이라 네트워크로 나가지 않는다
- 임계값 후보를 스윕해 두 종류의 오분류를 표로 낸다. **합계로 순위를 매기지 않는다** —
  두 오류의 대가가 다르고 그 교환비는 아직 아무도 정하지 않았다. 지배 관계만 표시한다

### fake로 재도 되는 근거를 주석에 두지 않는다

CLAUDE.md는 fake provider 결과로 가설을 판정하지 말라고 못박는다. 그 규칙이 지키는 것은
*모델 출력에 의존하는 판정*이고 TRIAGE는 거기 해당하지 않는다 — 그러나 "해당하지 않는다"를
주석으로 적으면 나중에 해당하게 되어도 주석은 그대로 남는다.

그래서 관측마다 **이벤트 순서로 증명한다**: `TRIAGE_COMPLETED.seq` < 첫 `PROVIDER_USAGE.seq`.
그리고 공급자 호출이 한 번도 없었다면 그 비교는 공허하게 참이므로 **증명으로 치지 않는다**
(실측으로 빈 patch를 주면 스키마 위반이 호출보다 먼저 나서 그렇게 된다).

`appliedPolicies`가 비어 있지 않은 실행은 규칙이 돌지 않은 것이므로 관측에서 뺀다 — 세면
분모가 부풀어 오분류율이 실제보다 낮아 보인다.

### 결과는 문항을 바꿨다

기본값에서 어려움 24건 중 **20건이 `simple`** 로 갔다. 그런데 임계값을 바꿔도 나아지지 않는다 —
지배당하지 않는 후보가 둘뿐이고 그중 하나(`maxRelevantFiles=0`)는 TRIAGE를 끄는 것과 같다.
작업 파일 개수 분포를 보면 이유가 보인다: 두 라벨이 값 `1`에 겹쳐 **29건 중 26건**이 거기 있다.

**임계값이 잘못 맞춰진 것이 아니라 축이 라벨을 가르지 못한다.** 자세한 것은
state-machine-and-protocol.md 13.4절.

## 유료 실행 안전장치

실제 공급자를 쓰는 실험은 시작하면 되돌릴 수 없다. 그래서 돈이 나가기 전에 막는다.

**`--max-cost-usd`는 유료 `pilot`/`run`에 필수다.** 우회 옵션은 없다. fake provider와
`dry-run`은 면제된다(단가 0이거나 아예 호출하지 않으므로). `0`·음수·`NaN`·`Infinity`·
`5달러` 같은 값은 **파싱 단계에서** 거부된다 — API를 부른 뒤에 알면 늦다.

**비용은 호출 전에 예약한다.** 예전에는 기록이 끝난 뒤 누적 비용을 검사했는데, 그러면
마지막 한 건의 비용만큼 상한을 넘길 수 있었다. 이제 각 기록의 보수적 최대 비용을 먼저
예약하고, 예약할 수 없으면 **호출하지 않는다.** 완료 후 실제 usage로 정산하고, 오류·취소·
타임아웃이면 예약을 해제한다. ledger 구현은 제품 코드(`@tomverse/sidecar/budget`)에 있다 —
측정 도구에만 두면 제품의 유료 호출 경로에는 같은 보호가 없게 되기 때문이다.

**재시작이 승인 상한을 늘리지 않는다.** 예전에는 재개할 때 원장을 `createBudgetLedger(limit)`로
새로 만들어 `committed`가 0에서 시작했다. **$25 한도에서 $20을 쓴 뒤 재개하면 $25를 더 쓸 수
있었다** — 재시작 횟수만큼 한도가 늘어나는 것이므로 "승인 한도"라는 말이 성립하지 않는다.
이제 `records.jsonl`에서 확정 비용을 복원해 `initialCommittedUsd`로 넘기고, 승인 상한과 비교되는
값은 **누적**(이전 + 이번)이다. 로그도 `이전 실행 확정` / `이번 실행 확정` / `전체 누적`을
따로 적는다 — "누적 비용" 한 줄로 뭉치면 그 숫자가 session인지 전체인지 알 수 없다.

**복원값이 수상하면 재개하지 않는다(fail closed).** 유료 호출을 했는데 비용이 없는 기록,
`NaN`/`Infinity`/음수, `cost_unmeasurable` 기록, 같은 (fixture, arm, 반복)이 두 번 있는 파일 —
어느 경우든 합계를 신뢰할 수 없으므로 멈춘다. "0으로 보고 계속"이 가장 위험하다: 그 순간
한도가 사라진다. `budget-events.jsonl`(append-only)과 기록 파일의 합계가 다르면 **한쪽을 골라
계속하지 않는다** — 어느 쪽이 맞는지 코드가 알 수 없다.

**열린 예약을 0원으로 재개하지 않는다.** 실행 순서는 (1) 예약 → (2) provider 호출 → (3) 기록 →
(4) 정산이고, (1) 이후 어디서든 프로세스가 죽을 수 있다. 예전 대조 검사는 정산 합계와 기록 합계만
비교했으므로 **개시만 있고 종결이 없는 예약이 어떤 합계에도 나타나지 않았다** — 두 합계가 0이면
"안 썼다"로 읽히고 재개가 허용됐다. 그 요청은 공급자가 처리하고 과금했을 수 있다. 이제 이벤트를
correlationId별 상태 머신으로 검증하고(허용 흐름은 `opened → settled`, `opened → released` 둘뿐),
열린 예약이 있으면 `BLOCKED_UNRESOLVED_RESERVATION`으로 멈춘다. 그 금액은 사용 가능한 예산으로
되돌리지 않으며, **자동으로 정리하는 명령도 만들지 않는다** — 실제 과금 여부는 공급자 청구 내역으로만
확인되고 코드가 대신 판단하면 돈이 새거나 예산을 잃는다. 근거는
[multi-engine-routing.md 10.7절](../../docs/design/multi-engine-routing.md).

**과금 여부가 불확실한 실패는 해제하지 않는다.** provider 실패를 네 상태로 나눈다 —
`not_dispatched`(해제), `response_received_with_usage`(실제 비용으로 정산),
`dispatched_no_response`·`response_received_without_usage`(미해결로 남기고 중단). 공급자가 응답을
만들고 과금한 뒤 파싱에서 실패하는 경우가 있으므로 "예외가 났으니 해제"는 쓴 돈을 안 쓴 것으로
만드는 것이다. 네트워크 타임아웃도 불확실이다(응답이 생성됐지만 못 받은 것일 수 있다).

**NaN·Infinity·음수·측정 실패는 0으로 정산되지 않는다.** 타입 수준에서 "0달러"와 "모른다"를
구별한다(`CostMeasurement`/`UsageMeasurement`). 실공급자 응답의 입력·출력 토큰이 **둘 다 0**인 것도
측정 실패로 본다 — 실제 호출이 0 토큰을 쓰는 일은 없다. 이런 값이 오면 예약을 풀지 않고 원장을
`BUDGET_LEDGER_INVALID`로 전환해 이후 유료 호출을 차단한다.

**비용을 잴 수 없으면 경고가 아니라 중단이다.** 실제 응답에 usage가 없거나 모델 단가를
모르면 그 기록을 `cost_unmeasurable` 인프라 실패로 남기고 **남은 유료 호출을 멈춘다.**
비용을 0으로 대체하지 않는다 — 0은 fake에만 참이고, 모르는 것을 0으로 적으면 예산 상한이
아무것도 막지 못한다.

**`--max-concurrency`는 1만 받는다.** 판정 기준의 p95 지연 비교가 순차 실행을 전제하기
때문이다. 예전에는 1보다 큰 값을 받아 경고만 하고 실제로는 무시했는데, 그건 CLI가 거짓
계약을 내건 것이다. 병렬 실행은 별도 protocol 버전에서 다룬다.

## 실행 디렉터리와 재개

`--output <dir>`는 **하나의 실험 실행 디렉터리**다.

```
<run-dir>/
  run.json              메타데이터 — 무엇을 어떤 조건으로 돌렸는가 (stage 포함)
  records.jsonl         실행 기록 (최초 실행과 재개가 같은 파일을 쓴다)
  budget-events.jsonl   예산 원장 감사 추적 (append-only, 8가지 이벤트)
  model-probe/          probe 결과 — **게이트 기록과 분리된다** (probe는 실험 표본이 아니다)
  report.md, summary.json, ...
```

예전에는 최초 실행이 `<uuid>.jsonl`에, 재개가 `records.jsonl`에 붙어서 **중단 후
`--resume`만 추가하면 처음부터 다시 돌았다.** 몇 시간과 실제 돈이 든 기록을 못 찾는 것이므로
편의 문제가 아니라 사고였다.

재개할 때 stage·protocol version·criteria hash·fixture hash·arm·seed·모델 ID 중 하나라도
다르면 **거부한다.** 다른 조건의 기록을 한 파일에 섞으면 집계가 조용히 틀린다.
예산은 낮춰서 재개할 수 있지만 이미 쓴 금액보다 낮으면 즉시 중단하고, 올리면 새 사용자
승인으로 `run.json`에 기록된다. P0와 P1은 **다른 디렉터리**를 쓴다.

## 모델 준비성 — "레지스트리에 있으므로 사용 가능"은 사실이 아니다

`gpt-5`는 Model Registry에 있는데 미인증 계정에서 `model_not_found`로 실패한다. 모델 가용성은
전역 사실이 아니라 **자격증명별 사실**이고, 그것을 확인하는 방법은 실제로 부르는 것뿐이다.
그래서 하나의 `available` 필드 대신 **출처가 다른 사실들을 축별로** 적는다.

| 축 | 누가 아는가 |
|---|---|
| `catalogKnown` | Model Registry |
| `pricingKnown` | Model Registry (기준일 있는 단가) |
| `structuredOutputDeclared` | Model Registry — **선언**이며 동작 확인이 아니다 |
| `credentialPresent` | 환경 (값은 읽지 않고 존재만 본다) |
| `liveProbeVerified` | **실제 요청만** |
| `exactModelIdVerified` | **실제 요청만** — 응답 envelope의 `model` 필드로만 판정 |

**오프라인 검사는 뒤 세 축을 true로 만들 수 없다.** `registryReadiness`가 항상 false로 두고,
올리는 경로는 `withCredentialPresence`와 `withLiveProbe` 둘뿐이다.

`exactModelIdVerified`는 **응답 envelope의 `model` 필드만** 본다. `DraftProposal.model`과
`ReviewDecision.model`은 어댑터가 `this.modelId`를 넣은 값이므로 그것으로 비교하면 항상 통과하고,
즉 조용한 대체를 절대 잡지 못한다. alias는 정규화가 아니라 레지스트리의 명시적 허용 목록
(`acceptedProviderModelIds`)으로 다룬다 — prefix 비교는 `claude-sonnet-5`가
`claude-sonnet-5.5`의 prefix이므로 **다른 모델을 통과시킨다.**

카드 상태도 그에 맞춰 셋이다:

- `BLOCKED` — 고쳐야 할 것이 있다. probe를 돌려도 해결되지 않는다.
- `READY_FOR_MODEL_PROBE` — 오프라인으로 확인할 수 있는 것은 전부 확인됐다. 다음은
  `gate:g:probe-models`이며 **아직 유료 pilot을 승인할 수 없다.**
- `READY_FOR_PAID_RUN` — 실제 호출로 모델·모델 ID·구조화 출력까지 확인됐다.

### Probe Evidence와 Run Card

`probe-models`는 확인 결과를 `model-probe/probe-evidence.json`에 남긴다. 이 파일은 **무엇을
무엇으로 확인했는가**에 결합된다: protocol/criteria 해시, Model Registry 스냅샷 해시, 어댑터 계약
버전, 요청·응답 모델 ID, 자격증명 binding, 24시간 유효 기간. 하나라도 다르거나 만료되면 거부한다 —
다른 모델·다른 키·다른 카탈로그에서 얻은 확인은 이 실행을 보증하지 않는다.

자격증명 binding은 **키 원문·prefix·suffix를 저장하지 않는다.** 목적 문자열과 evidence마다 새로
만드는 salt로 HMAC-SHA-256 다이제스트만 남기며, "같은 키인가"만 비교할 수 있다.

`pilot`/`run`은 `--run-card`를 **필수로** 받는다(fake 실행은 면제). 예전에는 카드가 화면에만
출력됐고 실행은 그것을 요구하지 않았으므로, 사용자가 `plan-pilot`을 거치지 않고 곧바로 유료
실행을 시작할 수 있었다 — 승인 절차가 있는 것처럼 보이지만 강제되지 않는 상태였다. 이제
**어댑터를 만들기 전에** 카드 해시·단계·출력 경로·fixture/arm/모델/seed·승인 상한·evidence·
자격증명 binding·만료를 확인하고 하나라도 다르면 거부한다. 우회 플래그는 없다.

카드에는 사람이 복사할 명령과 **argv 배열**이 함께 들어간다. 검증은 문자열을 다시 파싱하지 않고
argv 구조를 비교한다 — 재파싱은 인용 규칙을 두 번 구현하는 것이고, 그 둘이 갈라지면 "카드와
실행이 같다"는 검증이 거짓이 된다. 복사용 문자열은 PowerShell 규칙으로 인용하므로
`C:\Users\...\Tomverse Code\...`처럼 공백·괄호·비ASCII·trailing backslash가 있는 경로도 깨지지 않는다.

### P0 Attestation

P1 카드의 선행 조건은 문장이 아니라 **파일**이다. `attest-p0`가 P0 결과를 검사해
`p0-attestation.json`을 만들고, P1은 그것 없이 실행되지 않는다. 검사 항목: 카드가 요구한 기록 수와
정확히 일치, 전부 실제 공급자 기록, 중복 없음, 인프라·인증·모델·스키마·usage 오류 0건, 모든 비용
측정됨, 열린 예약 0건, 예산 추정 초과 0건, evidence와 같은 모델·자격증명, 응답 envelope 모델 ID
일치, fixture/criteria/카드 해시 일치, secret 미탐지.

**부분 성공에는 attestation을 만들지 않는다.** P0의 목적은 품질 측정이 아니라 실행 경로 확인이므로,
8건 중 7건만 돌았다면 확인되지 않은 경로가 남아 있고 그 경로가 P1에서 96건 규모로 실패할 수 있다.
조건이 어긋나면 `BLOCKED_P0_INCOMPLETE`(기록 부족) 또는 `BLOCKED_P0_FAILED`(기록은 있지만 실패)다.

### `gate:g:probe-models`

역할당 **정확히 한 번** 최소 요청을 보낸다. 재시도도 fallback도 없다 — "다른 모델로 바꿔서라도
성공"은 이 명령이 대답하려는 질문("이 모델이 되는가")을 지운다. production 어댑터를 그대로
태우므로(`@tomverse/sidecar/providers`) 확인되는 것은 "공급자가 살아있다"가 아니라 **우리 코드
경로가 이 모델과 구조화 출력까지 동작하는가**다. 요청 **전에** 예약하고, 비용을 잴 수 없으면
중단하며, 결과는 `records.jsonl`이 아닌 `model-probe/`에 쓴다.

### 승인 아티팩트는 immutable하다 (M0.1)

```text
<output-root>/
  approvals/
    cards/<cardId>.json              ← 승인 근거. 같은 id에 다른 내용을 쓸 수 없다.
    evidence/<evidenceId>.json
    attestations/<attestationId>.json
  p0-smoke/
    p0-run-card.pointer.json         ← **안내용.** 카드가 아니므로 --run-card에 넘길 수 없다.
    execution-authorizations.jsonl   ← 실행 승인 receipt (append-only)
    records.jsonl
    budget-events.jsonl
  p1-pilot/
    ...
```

`plan-pilot`을 다시 돌리면 **새 id의 새 카드**가 생기고 기존 카드는 바이트까지 그대로 남는다.
이미 실행이 근거로 삼은 카드가 조용히 바뀌면 "이것을 승인했다"는 말이 성립하지 않기 때문이다.

카드는 자기 immutable 경로를 기록하고, 다른 경로에서 읽힌 카드는 **사본으로 보고 거부한다.**

### 실행 승인 receipt

`pilot`/`run`은 **어댑터를 만들기 전에** receipt를 append한다. 저장에 실패하면 유료 호출을
시작하지 않는다. 모든 기록이 `receiptId`/`receiptHash`를 달고 나오므로, `attest-p0`는
명령 인자로 받은 카드가 아니라 **기록이 가리키는 receipt**를 따라 카드와 evidence를 찾는다.

재개는 조건 해시가 같을 때만 기존 receipt를 이어받는다. 예산을 올렸든 fixture 내용이 바뀌었든
조건이 다르면 새 승인이며, 새 카드와 새 `--output`을 요구한다.

### 실행 명령은 카드가 만든 것을 그대로 쓴다

카드의 `runArgv`에는 `--stage --fixtures --arms --repetitions --max-concurrency --seed --output
--max-cost-usd --executor-model --reviewer-model --run-card --probe-evidence`(P1은 `--p0-attestation`까지)가
**전부** 들어 있다. 카드를 만든 코드와 실행을 검증하는 코드가 같은 생성기를 쓰므로,
카드가 출력한 명령은 언제나 그 카드의 authorization을 통과한다.

예전에는 모델 override와 evidence 경로가 argv에 없어서, override로 만든 카드의 명령을 그대로
실행하면 그 카드의 검증에서 거부됐다 — 승인 절차가 자기 자신을 통과하지 못하는 상태였다.

### 알려진 지출과 최대 미해결 노출은 다른 숫자다

`gate:g:budget-status`는 둘을 분리해서 보여준다.

- **알려진 지출(known spend)**: 이미 확정된 돈.
- **최대 미해결 노출(maximum unresolved exposure)**: 과금됐을 **수 있는** 금액.
  그만큼 과금됐다는 뜻이 아니며, 실제 여부는 공급자 청구 내역으로만 확인된다.

한 기록에서 executor가 성공(과금 확정)하고 reviewer가 5xx로 실패하면 **전액 해제도 전액 정산도
옳지 않다.** 확정분은 누적하고 나머지는 미해결로 남기며, 그 디렉터리는 자동 재개가 불가능해진다.

## 사전 등록된 판정 기준

**결과를 보기 전에 고정됐다.** 바꾸려면 `PROTOCOL_VERSION`을 올리고 새 실험으로 다시 돌려야 하며,
이전 기록과 섞어 집계할 수 없다.

1. 유효한 어려운 fixture 최소 **24개**
2. primary arm fixture당 최소 **3회** 반복
3. 교차검증이 가장 강한 single arm보다 oracle pass rate 최소 **10%p** 개선
4. paired bootstrap **95%** 신뢰구간 하한이 **0보다 큼**
5. reviewer correction이 harm의 **2배 이상**
6. 보안 카테고리에서 single arm 대비 regression **0건**
7. 비용이 가장 강한 single arm의 **2배 이하**
8. p95 지연이 가장 강한 single arm의 **2.5배 이하**
9. 인프라 실패율 **5% 미만**

표본이 부족하거나 실제 API를 돌리지 않았으면 `INCONCLUSIVE`다. 근거 없는 PASS/FAIL은
근거 없는 판정보다 나쁘다 — 그걸 근거로 M1 방향이 정해지기 때문이다.

### 천장 검사 — 잴 수 없는 것을 "이득 없음"으로 적지 않는다 (v2)

가장 강한 단일 arm이 이미 높게 통과하면 **개선할 여지 자체가 없다.** 그때 나오는 "개선 0%p"는
"교차검증이 이득이 없다"가 아니라 **"이 세트로는 잴 수 없다"**이다. Phase 0이 정확히 그
상황이었고(단일 모델 5/5 통과), 종전 규칙은 그것을 3번 기준 미달 = `FAIL`로 적었을 것이다.

이제 가능한 최대 개선 `(1 − 최강 단일 통과율)`이 3번의 요구 개선폭보다 작으면 `INCONCLUSIVE`다.
**문턱은 새 상수가 아니라 3번에서 유도된다** — 상수로 적어두면 3번을 바꿨을 때 따라오지 않는다.

이 변경은 상수를 건드리지 않지만 **판정 절차를 바꾸므로** `PROTOCOL_VERSION`을 2로 올렸다.
해시가 봉인하는 것은 값이고, 같은 값으로 다른 결론을 내는 규칙을 넣으면 봉인은 아무것도 지키지
못한다. 실행 기록이 하나도 없는 시점이라 이전 기록과 섞일 여지는 없다.

**그리고 그 봉인이 실제로는 걸려 있지 않았다.** `criteria.test.ts`가 기대 해시를
`criteriaHash()`를 호출해 채우고 있어서 기준을 어떻게 바꾸든 함께 움직였다 — 파일 첫 주석이
약속하는 것을 하나도 지키지 못한 채 언제나 통과했다(`PROTOCOL_VERSION`을 올렸을 때 아무 말도
하지 않았다). 리터럴로 바꿨다.

## 검수 기여 — 여기서만 결정론적으로 갈린다

product-strategy.md 14절 표에는 **"검수 모델이 실제 결함을 발견한 비율"** 과 **"잘못된 검수
경고 비율"** 이 있었는데, 그 둘은 **제품에서 관측할 수 없다**(14.2절): 어떤 지적이 옳았다고
말하려면 *그 지적을 반영하지 않은 초안*의 검증 결과가 있어야 하는데, production은 한 태스크에
한 경로만 태운다.

여기서는 있다. Arm A와 Arm C가 **같은 초안**을 쓰고 C만 검수를 태우므로, oracle 결과 두 개로
네 갈래가 결정론적으로 갈린다.

| 초안 oracle | 검수 후 oracle | 분류 |
|---|---|---|
| 실패 | 통과 | `correction` — 검수가 고쳤다 |
| 통과 | 실패 | `harm` — 검수가 망가뜨렸다 |
| 통과 | 통과 | `no_measurable_correction` |
| 실패 | 실패 | `ineffective` |

**모델의 verdict는 쓰지 않는다.** 검수자가 무엇을 주장했는지는 이 분류에 영향을 주지 않는다 —
판정 근거는 oracle뿐이다. 그래서 이 값이 제품 지표로 옮겨갈 수 없다는 사실 자체가, 이 하네스가
왜 필요한지에 대한 답이기도 하다.

## 실패 분류

**모델/파이프라인 실패**(실험 결과)와 **인프라 실패**(실험 결과가 아님)를 구분한다.
인프라 실패는 성공률 분모에서 빠지고, 대신 인프라 실패율이 5%를 넘으면 표본 전체를
믿을 수 없다고 보고 `INCONCLUSIVE`가 된다. 유리한 결과가 나올 때까지 재실행하는 것을 막기 위해
제품의 재시도 상한(`providerRetries`)을 그대로 쓴다.

## 보안과 한계

**이 하네스가 지키는 것:**

- oracle 실행 시 자식 환경에서 API 키를 제거한다 (fixture 테스트가 키를 출력할 수 있다)
- `NODE_TEST_CONTEXT` 등 테스트 러너 제어 변수를 제거한다 — 남아 있으면 `node --test`가
  **실패해도 exit 0**을 반환해 oracle이 실패를 통과로 보고한다
- 명령은 argv로만 실행한다 (`shell: false`). manifest의 셸 메타문자는 로딩 단계에서 거부된다
- 저장 직전에 기록을 훑어 자격증명처럼 보이는 값이 있으면 **저장을 거부한다**
- 명령 출력은 상한(4KB)까지만 보관한다 — 무제한 stdout을 결과 파일에 남기지 않는다
- `reports/`는 gitignore된다. 저장소에는 fixture·하네스·기준·집계 리포트만 커밋한다

**하네스가 파일 시스템과 프로세스를 직접 만지는 것에 대해:** 제품에서는 Node가 그렇게 하지
않는다(process-architecture.md 2절). 이 하네스는 제품이 아니라 측정 도구이고,
`packages/sidecar/test/helpers/fixtureRepo.ts`가 이미 같은 예외를 쓴다. 중요한 것은
**측정 대상인 실행 경로**가 신뢰 경계를 그대로 지나는 것이며, 그건 `host.ts`가
`tomverse-host`를 그대로 부르는 방식으로 보장된다.

**해결되지 않은 한계** (제품 쪽과 공유한다 — state-machine-and-protocol.md 16.7절):

- 추적 중인 secret 파일에 대한 `git_diff` 출력은 여전히 이벤트에 들어갈 수 있다
- `run_command`가 실행한 프로세스가 stdout에 직접 출력한 임의의 비밀값은 막을 방법이 없다

이 둘은 이번 작업에서 해결하지 않았고, "해결됨"으로 보고하지 않는다.

## 현재 상태

**하네스: 완료.** fixture 24개가 검증을 통과하고, 실제 `tomverse-host`로 도는 자동 테스트가
전부 통과한다.

**유료 실행 안전장치: 완료.** 비용 상한 강제, 호출 전 예약, 측정 불가 시 중단, 순차 실행
계약, 실행 디렉터리 기반 재개, **재개 시 예산 복구(재시작이 한도를 늘리지 않는다)**,
append-only 예산 감사 추적, 모델 준비성 축 분리, 단계별(P0/P1) 승인 카드가 모두 들어갔다.

**crash-safe 재개 / 증거 체인: 완료 — 단, ⑧→⑨가 한 번 끊겨 있었다.** 열린 예약 상태 머신,
읽기 전용 예산 조회, provider envelope 모델 ID 검증, ProbeEvidence, Run Card 강제,
P0 attestation, 불확실 과금 처리, 실제 timeout abort, 공용 호출 수 계산기, PowerShell 경로
인용이 들어갔다.

그런데 실제로 순서를 이어보려 하자 `attest-p0`와 `plan-pilot`이 **승인 번들을 서로 다른 곳에서
찾고 있었다.** `attest-p0 --output`은 P0 **실행** 디렉터리여야 하는데(`records.jsonl`이 거기
있다) 같은 값으로 번들 위치까지 계산해서, attestation이 `<run-dir>/approvals/`에 떨어졌다 —
P1 카드를 만드는 `plan-pilot --output <root>`이 보는 `<root>/approvals/attestations/`가 아니다.
번들 위치의 정본을 **카드의 `approvalsDir`** (카드 해시 안에 있고 `writeRunCard`가 이미 쓰는
값)로 바꿨고, 테스트 75가 CLI를 하위 프로세스로 돌려 지킨다.

**이건 코드를 읽어서는 잘 드러나지 않는 종류였다.** `attest-p0`는 exit 0을 내고 파일도 실제로
만들어지므로, 사라지는 것은 결과가 아니라 **다음 단계와의 연결**이다. 게다가 우회로
(`plan-pilot --p0-attestation <경로>`)가 있어서 "그렇게 쓰는 것"으로 굳으면 번들이 갈라진 채
남는다. 단계를 실제로 이어보지 않으면 안 보인다.

**모델 실제 확인: 완료(2026-08-27).** `probe-models`가 실제 호출로 `gpt-4.1`과
`claude-sonnet-5`를 확인했고 구조화 출력까지 동작한다 — `READY_FOR_PAID_RUN`.

**실제 가설 판정: INCONCLUSIVE — 표본 부족(반복 1회).** 그러나 이제는 *실행하지 않아서*가
아니다. P1이 96/96을 완주했고(실지출 $2.67, 미해결 예약 0건) 인프라 실패율은 2.1%다.
미달 기준은 "fixture당 3회 반복" 하나뿐이며 P1은 구조적으로 그것을 만족할 수 없다.
**방향은 이미 분명하다** — 교차검증이 최강 단일보다 28.8%p 낮고 paired bootstrap 신뢰구간이
전부 0 미만이다. 자세한 것은 아래 실행 기록.

### 2026-08-27 실행 시도 — ①~④는 돌았고 ⑤에서 막혔다

무료 단계는 전부 돌았다. **지출 $0, 미해결 예약 0건.**

| 단계 | 결과 |
|---|---|
| `validate` | 24/24 통과 (Rust fixture 4개 포함) |
| `difficulty` | 어려움 21 / 보이는 신호가 정답을 결정함 3 / **판정 못 함 0** |
| `dry-run` | blocker 2개 → `core:build`로 1개 해소, 자격증명 1개 남음 |
| `plan-pilot` | 카드 상태 `BLOCKED_MISSING_CREDENTIALS` |

난이도 판정은 위 "실측: 24개 중 21개"와 **일치했고 실격된 셋도 같았다.** 툴체인이 전부 있는
기계였으므로 `판정 못 함`이 0이다 — 세트가 조용히 쉬워 보이는 경우가 아니라는 뜻이다.

카드가 계산한 보수적 최대 비용:

| 단계 | 기록 수 | provider 호출 상한 | 최대 비용 |
|---|---|---|---|
| P0 smoke | 8건 | 44회 (executor 32 + reviewer 12) | **$11.55** |
| P1 pilot | 96건 | 528회 (executor 384 + reviewer 144) | **$138.62** |

`gpt-4.1` $0.2480/회 + `claude-sonnet-5` $0.2800/회 기준(입력 60,000 상한 + 출력 16,000).

**⑤에서 막은 것은 둘이고, 둘 다 하네스 밖이다.**

1. **`ANTHROPIC_API_KEY`가 없다** — Arm B/C/D, 즉 가설이 재려는 교차검증 전부를 돌릴 수 없다.
2. **`api.openai.com`이 egress에서 차단된다** — 원격 클라우드 세션에서 게이트웨이가 CONNECT에
   403을 냈다. 프록시를 우회한 직접 연결도, 제품 어댑터가 쓰는 Node `fetch`도 같은 403이다.

두 번째가 위 "preflight의 '막는 요인 없음'은 '실행할 수 있다'가 아니다" 절이 예고한 바로 그
상황이다 — **키가 있는데 호스트에 닿지 못하고, 존재만 보는 점검은 그것을 볼 방법이 없다.**
반대로 `api.anthropic.com`은 도달하는데(401) 키가 없다. 어느 arm도 성립하지 않는다.

우회하지 않았고, 다른 모델로 바꿔 성공시키지도 않았다 — 그건 `probe-models`가 답하려는 질문을
지운다. **게이트를 돌리려면 두 공급자에 모두 닿는 환경이 필요하다.**

### 2026-08-27 두 번째 시도 — ⑨까지 갔고 ⑩에서 미해결 예약으로 멈췄다

두 공급자 키가 모두 있는 Windows 기계에서 다시 돌렸다. **①~⑨가 전부 통과했고 P0는
`P0_VERIFIED`를 받았다.** P1이 96건 중 8건에서 멈췄다.

| 단계 | 결과 |
|---|---|
| `validate` | 24/24 통과 |
| `difficulty` | 어려움 **22** / 신호가 정답 결정 2 / 판정 못 함 0 |
| `dry-run` | blocker 0개, 검수자 독립성 성립 |
| `plan-pilot` | `READY_FOR_MODEL_PROBE` → `READY_FOR_P0_APPROVAL` |
| `probe-models` | **`READY_FOR_PAID_RUN`** — 두 모델 실호출 확인, 구조화 출력까지 |
| P0 smoke 8건 | 8/8 실행, 인프라 실패 0건 |
| `attest-p0` | **`P0_VERIFIED`** — 22개 검사 전부 통과 |
| `plan-pilot` | **`READY_FOR_P1_APPROVAL`** — attestation이 카드에 연결됨 |
| P1 pilot 96건 | **8건에서 중단** — 미해결 예약 1건 |

난이도 판정이 문서의 실측(21/3)과 한 건 다르다. `sec-01-path-traversal`의 공개 테스트가
플랫폼 의존이었고 **정답을 벌하고 있었다**(아래 결함 ①). 고친 뒤 두 OS에서 일치한다.

#### 왜 멈췄나 — 미해결 예약 $1.832

`mfc-01-pagination-contract / Arm D`의 reviewer 호출이 **정확히 120초에 취소**됐다
(`errorKind: "cancelled"`, `dispatchState: "dispatched_no_response"`).
`orchestrator.ts`의 `providerTimeoutMs` 기본값이 120초이고, fixture 상한(180초)보다 먼저 건다.

요청이 나갔을 수 있으나 응답이 없어 비용을 확정할 수 없으므로, 하네스는 설계대로
예약을 해제하지 않고 `BLOCKED_UNRESOLVED_RESERVATION`으로 멈췄다. 자동으로 정리하지 않고
공급자 청구 내역으로 확인했다.

**결과: 과금됐다.** 청구 내역이 기록과 자릿수까지 맞는다.

| 청구 시각 | 청구 토큰 | 대응하는 호출 |
|---|---|---|
| 07:49 | 7,030 | `mfc-01/B` executor(3,529) + `mfc-01/C` reviewer(3,501) — 둘 다 이미 정산됨 |
| 07:51 | 13,452 | **취소된 `mfc-01/D` reviewer** — 우리가 응답을 받지 못한 그 호출 |

즉 "요청이 나갔을 수 있다"는 보수적 판정이 옳았다. 해제했다면 실제로 쓴 돈이 승인 예산에서
사라졌을 것이다. **이 사례가 `dispatched_no_response`를 해제하지 않는 규칙의 실증이다.**

입력·출력 분해는 청구 요약에 없으므로 비용은 구간으로만 적는다 — 전부 출력이라고 보면
$0.1345, 관측된 입력 규모(~2,500)를 가정하면 $0.11 안팎이다. **점 추정값을 기록에 적지 않는다.**

| | 금액 |
|---|---|
| 알려진 지출(정본, 전 단계 누계) | **$0.6893** |
| 확정된 추가 과금(취소된 호출) | **≤ $0.1345** |
| 미해결로 남은 금액 | **없음 — 청구 확인으로 해소** |

**카드 상한이 얼마나 보수적인지가 실측으로 나왔다.** P0는 상한 $11.55에 대해 실지출
$0.168(**1.5%**), P1은 8건에 $0.1348이므로 96건 완주 시 $1.6 안팎으로 추정된다 —
상한 $138.62의 **약 1%**다.

#### 실행 경로에서 찾은 결함 7개

게이트가 처음으로 실제 모델을 태우면서, **fake provider로는 드러나지 않던 결함**이 줄줄이 나왔다.
공통 모양이 하나 있다: **fake에서는 통과하고 실제 공급자에서만 깨진다.** 그래서 하네스 자동
테스트가 전부 초록인 채로 오래 살아남았다.

| # | 어디 | 무엇 |
|---|---|---|
| ① | fixture | `sec-01` 공개 테스트가 구분자를 문자열로 비교해 Windows에서 공허했고, **참조 수정을 적용하면 TypeError로 실패**했다 — 정답을 벌하고 있었다 |
| ② | 하네스 | fake 실행이 `--providers openai`로 좁혀지며 **실제 gpt-4.1을 호출**했다. `--max-cost-usd`·`--run-card`를 면제받는 경로라 유료 안전장치 전체를 우회한 실제 과금이었다(실측 $0.0226) |
| ③ | 하네스 | safety 5번 테스트가 "자격증명이 없다"는 환경 사실에 기대 실패를 만들고 있었다 — 키가 있는 기계에서는 실제 호출이 나간다 |
| ④ | 하네스 | `provider_5xx`를 호스트 stderr 전체의 `/5dd/`로 판정했다. 호출이 전부 성공한 기록 둘이 인프라 실패가 됐고, **early return이라 oracle 검증 자체를 건너뛰었다** |
| ⑤ | 하네스 | `changedFiles`에 `target/` 빌드 산출물 수백 개가 실렸다. "모델이 아무것도 바꾸지 않았다" 검사가 네이티브 fixture에서 영원히 발동하지 않는다 |
| ⑥ | 하네스 | 8KB를 넘는 이벤트 payload는 DB에 `artifactRef`만 남는데 되읽지 않았다. **실제 초안은 항상 8KB를 넘으므로 초안을 한 번도 읽은 적이 없었다** |
| ⑦ | 하네스 | `draftKey`에 arm이 없어 **Arm B가 Arm A의 초안을 덮어썼다.** C/D가 B의 초안을 검수하면 A↔C 차이가 검수의 순효과가 아니게 된다 |

#### 제품에서 고친 것 3개

| # | 무엇 |
|---|---|
| ⓐ | **OpenAI strict 스키마가 400으로 거절됐다.** `mcpCalls[].arguments`가 자유 객체라 strict 모드로 표현할 수 없다 — 초안 생성이 실제 API에 대해 **한 번도 동작한 적이 없었다.** OpenAI 어댑터 안에서만 문자열로 파생시켜 보내고 받은 뒤 되돌린다 |
| ⓑ | `gpt-4.1`은 별칭이고 `gpt-4.1-2025-04-14`로 응답한다. 관측한 ID 하나만 `acceptedProviderModelIds`에 적었다 |
| ⓒ | **검수자 드롭이 파이프라인 교체를 뜻하고 있었다.** 공급자가 하나면 tier가 standard여도 `SINGLE_MODEL_FIX`로 갈아타 초안 프롬프트도 `DraftProposal`도 없어졌다. 이제 경로는 tier가 정하고 REVIEWING만 건너뛴다(`DRAFTING → PLANNING` 전이 추가) |

⑦은 **attestation이 잡았다.** 덮어써진 초안의 저자가 검수자와 같은 공급자가 되자 라우터의
13.3절 절충이 발동해 검수자가 executor 모델로 바뀌었고, "응답 envelope 모델 ID가 배정과 일치"
검사가 그것을 잡아 P1을 막았다 — 안전장치가 설계대로 작동한 사례다.

#### 아직 판정하지 않은 것

P1이 8건에서 멈췄으므로 **가설에 대해서는 아무것도 말하지 않는다.** 사전 등록 기준은 유효
fixture 24개와 fixture당 3회 반복을 요구하고, 여기 있는 것은 fixture 4개 × 1회다.

기록에 남은 사실만 적는다. 조건이 갖춰진 실행(P0 최종 8건 + P1 7건)에서 oracle을 통과한 것은
**Arm B 두 건뿐**이다(`amb-01`, `mfc-01` — 둘 다 `claude-sonnet-5` 단독). 교차검증
arm(C/D)이 통과한 경우는 없고, 같은 초안을 쓴 A와 C/D의 결과가 갈린 경우도 없다 — 즉
**correction도 harm도 0건**이고, 검수 기여를 판정할 표본이 아직 만들어지지 않았다.

앞선 시도들에서 본 수치는 여기 쓰지 않는다. 결함을 고칠 때마다 조건이 달라졌으므로
**그 기록들은 판정에 쓸 수 없다.**

#### 다음 사람이 할 일

1. ~~미해결 예약을 청구 내역으로 확인한다~~ — **확인 완료. 과금됐다**(위 표).
   `p1-pilot` 디렉터리는 `BLOCKED_UNRECOVERABLE_RECORDS`로 남으므로 재개하지 않고
   새 `--output`을 쓴다. 그 기록은 사고 증거로 보존한다.
2. **`providerTimeoutMs`가 우리가 요청하는 출력 예산을 감당하지 못한다.** 어댑터는 출력을
   16,000토큰까지 요청하는데 타임아웃은 120초 고정이다. 이 실행에서 잰 `claude-sonnet-5`
   처리량은 57~97 tok/s였고, 최저값으로도 16,000토큰은 **약 280초**다 — 출력 한도를 다 쓰는
   호출은 **반드시** 죽는다. 상수를 올리는 문제가 아니라 **두 값이 서로 모순**인 것이며,
   96건·288건 규모에서는 이 취소가 반복되어 매번 실행이 멈춘다.
3. 그 뒤 새 `--output`으로 P1을 다시 돌린다. Run Card와 probe evidence는 24시간 만료다.


### 2026-08-27 P1 완주 — 96/96, 실지출 $2.67

**하네스가 처음으로 완주했다.** 예약 96건 전부 정산, 미해결 0건, `records/events 일치`.
인프라 실패율 **2.1%** 로 사전 등록 기준 9번(5% 미만)을 통과했다.

판정은 `INCONCLUSIVE`이고 **그것이 예정된 결과다** — 미달 기준이 "fixture당 3회 반복" 하나뿐이며,
P1은 반복 1회이므로 구조적으로 이 기준을 만족할 수 없다. PASS/FAIL은 confirmatory에서만 나온다.

#### Arm 비교 (24 fixture × 1회)

| Arm | 구성 | 유효 | oracle 통과 | 통과율 | 평균 비용 | p50 | p95 |
|---|---|---|---|---|---|---|---|
| A | OpenAI 단독 | 23 | 0 | **0.0%** | $0.0232 | 19.1s | 38.4s |
| B | Anthropic 단독 | 24 | 9 | **37.5%** | $0.0193 | 16.7s | 27.9s |
| C | 교차검증 (informed) | 23 | 2 | 8.7% | $0.0387 | 19.6s | **162.1s** |
| D | 교차검증 (blind) | 24 | 4 | 16.7% | $0.0314 | 22.0s | 53.4s |

가장 강한 단일 arm은 **B**(`claude-sonnet-5` 단독)다.

#### 사전 등록 기준 대조 — 판정은 아니지만 방향은 분명하다

| # | 기준 | 실측 | |
|---|---|---|---|
| 1 | 유효 fixture ≥ 24 | 24 | ✅ |
| 2 | fixture당 반복 ≥ 3 | 1 | ❌ **구조적** |
| 3 | 교차검증이 최강 단일보다 ≥ +10%p | **−28.8%p** (8.7 vs 37.5) | ❌ |
| 4 | paired bootstrap 95% CI 하한 > 0 | **[−0.478, −0.043]** | ❌ 구간 **전체가 0 미만** |
| 5 | correction ≥ harm × 2 | 2 vs 0 | ✅ |
| 6 | 보안 카테고리 regression 0건 | `sec-01` 1건 | ❌ |
| 7 | 비용 ≤ 최강 단일의 2배 | **2.005배** | ❌ 경계 |
| 8 | p95 지연 ≤ 최강 단일의 2.5배 | **5.80배** | ❌ |
| 9 | 인프라 실패율 < 5% | 2.1% | ✅ |

**천장 검사는 발동하지 않았다.** 최강 단일이 37.5%이므로 가능한 최대 개선은 62.5%p이고
기준 3번의 10%p보다 훨씬 크다 — 즉 **이 세트는 질문을 잴 수 있다.** Phase 0이 단일 모델 5/5로
"잴 수 없음"이었던 것과 다른 상황이며, 그래서 이 수치는 판정이 아니어도 정보다.

paired 결과는 **승 1 / 패 7 / 무 15**다.

#### 검수 기여 — 여기서만 결정론적으로 갈린다

| 분류 | 건수 |
|---|---|
| `correction` (초안 실패 → 검수 후 성공) | **2** |
| `harm` (초안 성공 → 검수 후 실패) | **0** |
| `no_measurable_correction` | 0 |
| `ineffective` (초안 실패 → 검수 후 실패) | **21** |

검수는 **망가뜨리지 않았다**(harm 0). 다만 23건 중 21건에서 아무것도 바꾸지 못했다.

blind vs informed: verdict 불일치율 26.1%, **oracle 결과 불일치율 13.0%**.

#### 이 숫자를 읽을 때의 단서

- **Arm A가 0/23이다.** `gpt-4.1`이 이 세트에서 하나도 풀지 못했고, C/D는 그 초안을 재생하므로
  검수가 매번 맨바닥에서 고쳐야 했다. 그래서 이 결과는 "교차검증이 나쁘다"보다
  **"약한 실행자 + 강한 검수자"가 "강한 모델 단독"보다 나쁘다**에 더 가깝다.
  실행자를 바꾸면 달라지는지는 **사전 등록되지 않은 다른 질문**이며, 이 기록으로 답하지 않는다.
- 반복 1회라 fixture별 분산을 모른다. `100%`/`0%`는 1건의 결과일 뿐이다.
- 인프라 실패 2건(`mfc-03`의 A·C)은 `auth_failure`로 적혔지만 실제 호출 오류는
  `schema_violation`이었다 — 재시도 불가 오류가 `provider_config_error`로 묶이면서 생긴
  **라벨 부정확**이다. 실행에는 영향이 없었고 circuit breaker도 (`errorKind`를 보므로) 열리지
  않았다. 남은 과제로 적어둔다.

#### confirmatory는 싸다

실지출 $2.6726 / 96건 = 건당 **$0.0278**. 288건이면 **약 $8**이고 카드 상한은 $416이다.
"비싸서 신중해야 한다"는 전제는 실측으로 성립하지 않는다 — 남은 제약은 **시간**(96건에 약 1시간)이다.

#### 완주까지 걸린 것 — 다섯 번의 P1

| 시도 | 도달 | 멈춘 이유 |
|---|---|---|
| 1차 | 8/96 | 120초 타임아웃 → **과금 확인됨** |
| 2차 | 20/96 | 실행자가 프로세스를 죽임(도구 시간 제한) |
| 3차 | 7/96 | 출력 상한 초과 → 잘림 → usage 유실 |
| 4차 | 21/96 | 4xx 반려 → 비용 불확실 |
| **5차** | **96/96** | — |

원인은 매번 달랐지만 결말은 같았다: **비용을 확정할 수 없는 호출 하나가 실행 전체를 멈추고
그 디렉터리를 영구히 재개 불가로 만든다.** 약 20건마다 한 번씩 나오므로 96건·288건 규모에서는
이 성질 자체가 완주를 막는다. 그래서 고친 것은 개별 버그가 아니라 **"모른다"의 범위**다 —
아는 것(추론 전 반려는 과금 없음, 타임아웃은 설정 문제, 검증 실패해도 usage는 손에 있음)을
모르는 것으로 적지 않게 만들었다.


### 다음 단계

```bash
# 무료 — 견적과 카드 상태 확인
npm run gate:g:dry-run
npm run gate:g:plan-pilot -- --output <root>

# 유료 — 역할당 1회. 여기서 처음 실제 호출이 나간다
npm run gate:g:probe-models -- --max-cost-usd <probe 금액> --output <root>

# 무료 — evidence를 읽어 P0 카드를 확정한다. **금액을 여기서 넣어야**
# 카드의 실행 명령에 --max-cost-usd가 채워져 그대로 복사할 수 있다.
# 이 시점의 exit code는 2가 정상이다 — P1은 아직 attestation이 없다.
npm run gate:g:plan-pilot -- --p0-max-cost-usd <P0 금액> --p1-max-cost-usd <P1 금액> --output <root>

# 유료 — **카드가 출력한 명령을 그대로** 쓴다. 손으로 조립하면 argv가 달라져 거부된다.
# 카드는 <root>/approvals/cards/<cardId>.json 이다.
# <root>/p0-smoke/p0-run-card.pointer.json 은 **안내용이고 카드가 아니다** — 넘기면 거부된다.

# 무료 — --output은 P0 **실행** 디렉터리다(records.jsonl 위치). 카드를 인자로 받지 않는다.
npm run gate:g:attest-p0 -- --output <root>/p0-smoke
```

각 유료 단계 뒤에는 `gate:g:budget-status`로 **알려진 지출**과 **최대 미해결 노출**을 따로
읽는다. 둘은 다른 숫자다.

Run Card와 probe evidence는 **24시간 만료**다. ⑤~⑩을 하루 안에 끝내지 못하면 probe부터
다시 돌아야 한다.

카드에는 계획 기록 수, **총 provider 호출 상한(executor/reviewer 내역 포함)**, 보수적 최대 비용,
중단 조건, 실행 명령이 들어가고 **실제 API 호출은 0건**이다.

**P1은 PASS를 내지 않는다.** 반복 1회는 사전 등록 기준 2번(fixture당 최소 3회)을 만족하지
못하므로 구조적으로 항상 `INCONCLUSIVE`다. PASS/FAIL은 confirmatory(3반복 = 288건)에서만 나온다.
