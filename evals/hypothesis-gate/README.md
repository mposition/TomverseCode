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

## 사용

```bash
npm run gate:g:test       # 하네스 자동 테스트 (실제 API 없음, npm test에도 포함된다)
npm run gate:g:validate   # fixture 품질 검증 (모델 호출 없음)
npm run gate:g:dry-run    # preflight + 실행 계획만
npm run gate:g:plan-pilot # **단계별(P0/P1) 유료 실행 승인 카드** (실제 API 호출 0건)
npm run gate:g:probe-models  # 역할당 **최소 요청 1회**로 모델을 실제 확인 (--max-cost-usd 필수)
npm run gate:g:pilot      # 반복 1회. 하네스·비용·실패 분류 확인용. PASS를 내지 않는다
npm run gate:g:run        # confirmatory (기본 반복 3회)
npm run gate:g:report     # 기존 기록으로 리포트만 재생성
```

옵션: `--fixtures a,b` `--arms A,B,C,D` `--repetitions N` `--seed N`
`--max-cost-usd N` `--max-concurrency 1` `--resume` `--output <run-dir>`
`--stage smoke|pilot|confirmatory` `--executor-model <id>` `--reviewer-model <id>`
`plan-pilot` 전용: `--p0-max-cost-usd N` `--p1-max-cost-usd N`

**진행 순서**: `plan-pilot` → (카드가 `READY_FOR_MODEL_PROBE`면) `probe-models` →
`plan-pilot` 재생성 → P0 카드 승인 → P0 `pilot` 실행 → P0가 완전히 정상 → P1 카드 승인 → P1 실행.

종료 코드: `0`=PASS, `1`=FAIL, `2`=INCONCLUSIVE, `3`=하네스 오류, `4`=툴체인 미준비.

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
| `exactModelIdVerified` | **실제 요청만** (조용한 대체 탐지) |

**오프라인 검사는 뒤 세 축을 true로 만들 수 없다.** `registryReadiness`가 항상 false로 두고,
올리는 경로는 `withCredentialPresence`와 `withLiveProbe` 둘뿐이다.

카드 상태도 그에 맞춰 셋이다:

- `BLOCKED` — 고쳐야 할 것이 있다. probe를 돌려도 해결되지 않는다.
- `READY_FOR_MODEL_PROBE` — 오프라인으로 확인할 수 있는 것은 전부 확인됐다. 다음은
  `gate:g:probe-models`이며 **아직 유료 pilot을 승인할 수 없다.**
- `READY_FOR_PAID_RUN` — 실제 호출로 모델·모델 ID·구조화 출력까지 확인됐다.

### `gate:g:probe-models`

역할당 **정확히 한 번** 최소 요청을 보낸다. 재시도도 fallback도 없다 — "다른 모델로 바꿔서라도
성공"은 이 명령이 대답하려는 질문("이 모델이 되는가")을 지운다. production 어댑터를 그대로
태우므로(`@tomverse/sidecar/providers`) 확인되는 것은 "공급자가 살아있다"가 아니라 **우리 코드
경로가 이 모델과 구조화 출력까지 동작하는가**다. 요청 **전에** 예약하고, 비용을 잴 수 없으면
중단하며, 결과는 `records.jsonl`이 아닌 `model-probe/`에 쓴다.

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

**모델 실제 확인: 미실행.** `probe-models`는 구현되어 있고 mock transport로 검증되지만
**실제로 돌리지 않았다** — 이 저장소에는 자격증명이 없고, 유료 호출은 사용자 승인 사항이다.

**실제 가설 판정: INCONCLUSIVE — API 실험 미실행.** 이 저장소에는 OpenAI/Anthropic 자격증명이
없으므로 pilot도 confirmatory도 돌리지 않았다. 성공률과 비용을 지어내지 않는다.

다음 단계:

```bash
npm run gate:g:plan-pilot -- --p0-max-cost-usd <P0 금액> --p1-max-cost-usd <P1 금액> --output <dir>
npm run gate:g:probe-models -- --max-cost-usd <probe 금액> --output <dir>
```

카드에는 계획 기록 수, **총 provider 호출 상한(executor/reviewer 내역 포함)**, 보수적 최대 비용,
중단 조건, 실행 명령이 들어가고 **실제 API 호출은 0건**이다.
