# Protocol v2 — 강한 실행자 가설

> **상태: `DRAFT_NON_EXECUTABLE`**
>
> 이 문서는 **실행 승인이 아니다.** 지표 정의를 confirmatory 결과보다 **먼저** 고정하기 위해
> 존재한다. 결과를 본 뒤 공식이나 성공 기준을 바꾸면 그 순간 이 실험은 측정이 아니라 사후 정당화다.
>
> 실행하려면 별도로 `PROTOCOL_VERSION`을 올리고, 아래 "결과 후에 채울 항목"을 채우고,
> **동결 커밋**을 지정하고, 새 승인 카드를 받아야 한다.

작성 시각: 2026-08-27. Protocol v1 confirmatory가 **도는 중에** 작성됐다 — 그 사실이 이
문서의 요점이다. 결과를 모르는 상태에서 정의를 적어야 사후적으로 유리한 정의를 고를 수 없다.

**이 문서는 v1 confirmatory의 코드·설정·아티팩트를 건드리지 않는다.** 하네스는 기록마다
`tomverse-host`를 새로 띄우고 그때 sidecar 번들을 디스크에서 다시 읽으므로, 실행 중 재빌드는
288건을 서로 다른 코드로 나누는 것이 된다.

---

## 0. 확정된 결정 문구

> **Confirmatory primary endpoint는 deterministic oracle이 판정한 paired
> `netQualityImprovement`로 한다.** 이는 **전체 유효 paired 평가를 공통 분모로** 계산한
> `rescueRate − regressionRate`이며, **기능적 pass-rate delta**를 의미한다.
> 사람 블라인드 평가는 `humanPreferenceDelta`라는 secondary descriptive metric으로 분리하고
> PASS/FAIL 게이트에는 사용하지 않는다. **모델 기반 평가는 게이트 판정에서 제외한다.**

---

## 0.1 이름 충돌 주의 — v1의 "arm"과 v2의 "arm"은 다른 것이다

| | v1 | v2 |
|---|---|---|
| arm이 가리키는 것 | **모델 구성** (A=OpenAI 단독, B=Anthropic 단독, C/D=교차검증) | **프로토콜** (A=동결된 v1, B=v2) |

v2에서는 프로토콜 축을 `ProtocolArm`, 그 안의 모델 구성을 `ModelArm`으로 부른다.
코드와 리포트가 같은 이름을 쓰고, **결과 표기는 두 축을 함께 적는다**:

```
ProtocolArm A / ModelArm A
ProtocolArm A / ModelArm C
ProtocolArm B / ModelArm ...
```

한 축만 적으면 "Arm A"가 문맥에 따라 다른 것을 가리킨다.

---

## 1. 지금 고정하는 것

### 1.1 ProtocolArm

| ProtocolArm | 내용 |
|---|---|
| **A** | **동결된 Protocol v1.** 코드·프롬프트·기준을 동결 커밋에서 그대로 쓴다 |
| **B** | **Protocol v2.** 개입 내용은 confirmatory 이후 확정한다(§3) |

### 1.2 양 arm에서 동일해야 하는 것

하나라도 다르면 그 차이가 개입 효과에 섞인다.

- **시작 commit** — 두 arm이 같은 트리에서 출발한다. 동결 커밋 SHA를 실행 기록에 남긴다
- **모델** — 실행자·검수자 모델 ID와 `acceptedProviderModelIds`
- **도구** — Policy Gate allowlist, MCP 도구 목록, 검증 명령
- **예산** — 기록당 상한과 전체 상한
- **시간 제한** — `providerTimeoutMs`, fixture `timeoutMs`, 전체 wall-clock 상한
- **컨텍스트 예산** — 입력 토큰 상한, 출력 토큰 상한
- **fixture 세트** — 같은 과제, 같은 oracle

### 1.3 paired 단위와 순서 counterbalancing

- **paired 단위는 (fixture, repetition)이다.** 같은 fixture의 같은 반복 인덱스에 대해
  A와 B를 모두 실행하고, 그 쌍을 하나의 관측으로 센다
- **순서를 번갈아 준다.** 반복 인덱스가 짝수면 A→B, 홀수면 B→A. 순서 효과(캐시 워밍,
  공급자 부하 변동, rate limit 누적)가 한 arm에만 실리지 않게 한다
- 순서는 `seed`로 재현 가능해야 하고, **실제 실행 순서를 기록에 남긴다** — 계획만 남기면
  중단·재개 후 실제 순서를 알 수 없다

### 1.4 원시 이벤트와 집계 코드의 버전

모든 기록에 다음을 싣는다. 하나라도 다르면 **같은 파일에 섞지 않는다.**

- `protocolVersion` (v2)
- `criteriaHash` — 이 문서가 고정한 지표 정의의 해시
- `frozenCommit` — 동결 커밋 SHA
- `recordSchemaVersion`
- `aggregatorVersion` — 집계 코드의 버전. **원시 이벤트와 따로 센다**: 같은 기록을 다른
  집계 코드로 다시 돌리면 다른 숫자가 나올 수 있고, 그때 어느 리포트가 어느 코드에서
  나왔는지 알 수 없으면 재현이 불가능하다
- `registrySnapshotHash`, `adapterContractVersion`

### 1.5 v1 confirmatory와 v2 평가 세트의 완전 분리

- **다른 디렉터리, 다른 원장, 다른 승인 카드.** 재개도 서로를 이어받지 않는다
- v1 기록을 v2 집계에 넣지 않는다. `protocolVersion`이 다르면 집계가 거부한다
- **ProtocolArm 선택이 confirmatory 결과에 의존한다면**(§3), v2는 반드시 **새로운 독립
  fixture 세트**에서 평가한다 — 같은 세트에서 고르고 같은 세트에서 검증하면 그 결과는
  그 세트에 맞춘 것이지 일반화된 것이 아니다

---

## 2. 지표 — 위계와 정의

```
Primary:
  netQualityImprovement        (= deterministicNetPassDelta)

Safety gate:
  regressionRate

Key secondary:
  costToGreen
  timeToGreen

Diagnostic:
  rescueRate
  firstAttemptPassRate
  changedLines
```

**7개다.** 비용과 시간을 하나의 합성 점수로 묶지 않는다 — 묶으면 가중치가 곧 결론이 되고,
그 가중치를 정당화할 근거가 없다. 둘은 서로 다른 제약이므로 따로 본다.

### 2.0 공통 정의

- **green** = **oracle 검증 통과.** 모델의 verdict도 공개 검증도 green의 근거가 아니다
  (측정 대상이 자기 점수를 매기게 하면 측정이 아니다)
- **유효 paired 평가(valid paired evaluation)** = A와 B가 **모두** 유효한 (fixture, repetition)
  쌍. 아래 모든 paired 지표의 **공통 분모 N**이 이것이다
- **`INVALID`로 제외하는 것은 인프라 오류뿐이다.** 인프라 오류의 정의는 v1의
  `INFRA_FAILURE_CLASSES`를 따른다
- **모델이 정상 접수한 뒤 발생한 것은 원칙적으로 실패다** — timeout, 불완전 응답,
  스키마 위반, 잘못된 패치. 요청이 공급자에 도달해 처리가 시작된 뒤의 일이므로 **파이프라인의
  결과**이지 인프라 사고가 아니다. green이 아닌 것으로 분모에 남는다
- **`not_dispatched`는 품질 분모에서 제외하고 별도로 집계한다.** 요청이 나가지 않았으면
  그 과제에 대해 모델은 아무것도 하지 않았다 — 실패로 세면 그 arm이 부당하게 나빠진다.
  다만 **제외한 건수와 사유를 반드시 별도 표로 낸다**: 조용히 빠지면 분모가 왜 줄었는지
  설명할 수 없고, 그 방향의 누락은 **통과율을 올린다**

### 2.1 `netQualityImprovement` — Primary

**의미: `deterministicNetPassDelta`.** "품질" 전반이 아니라 **oracle이 판정할 수 있는 기능적
성공률의 순변화**다. 이름을 유지하되 이 사실을 문서와 리포트에 함께 적는다.

```
                        N(single fail → cross pass) − N(single pass → cross fail)
netQualityImprovement = ────────────────────────────────────────────────────────
                                  N(valid paired evaluations)
```

- **분자**: (A 실패 ∧ B green) 수 − (A green ∧ B 실패) 수
- **분모**: 유효 paired 평가 수 **N** (§2.0)
- 값 범위 [−1, +1]. 양수면 B가 순이득

**두 비율이 같은 분모를 쓰는 것이 요점이다.** 각각 "기준선 실패 건수"와 "기준선 성공 건수"를
분모로 쓰면 두 값을 빼도 통과율 차이가 되지 않는다. 공통 분모에서는 다음이 **항등식으로**
성립한다:

```
netQualityImprovement = crossPassRate − singlePassRate
```

(B가 green인 경우는 "A도 green" 또는 "A는 실패"로 정확히 나뉘고, A가 green인 경우도 마찬가지다.
공통항이 상쇄되어 분자가 `N(B green) − N(A green)`과 같아진다.)

### 2.2 `regressionRate` — Safety gate

- **분자**: A가 green인데 B가 green이 아닌 과제 수
- **분모**: **N** (유효 paired 평가 전체 — §2.1과 같은 분모)
- **게이트**: 상한을 넘으면 다른 지표가 아무리 좋아도 **채택하지 않는다.** 상한값은 §3에서
  확정한다

> **상한을 정할 때 주의**: 공통 분모 비율은 조건부 비율보다 **작게 나온다**(분모가 크므로).
> v1의 조건부 관측치를 그대로 상한으로 옮기면 실제보다 훨씬 느슨한 게이트가 된다.
> 상한은 반드시 **공통 분모 기준으로** 다시 계산해 정한다.

### 2.3 `rescueRate` — Diagnostic

- **분자**: A가 green이 아닌데 B가 green인 과제 수
- **분모**: **N** (§2.1과 같은 분모)

### 2.3.1 조건부 비율 — 보조 지표로 **별도 보고**

해석에는 조건부 비율이 더 직관적이므로 함께 낸다. 다만 **primary 계산에는 쓰지 않는다.**

| 이름 | 분자 | 분모 |
|---|---|---|
| `conditionalRescueRate` | A 실패 ∧ B green | **A가 green이 아닌** 유효 paired 수 |
| `conditionalRegressionRate` | A green ∧ B 실패 | **A가 green인** 유효 paired 수 |

이 둘의 차는 pass-rate delta가 **아니다.** 리포트에 그 사실을 각주로 적는다.

### 2.4 `firstAttemptPassRate` — Diagnostic

- **분자**: **수정 재시도 없이** 첫 검증에서 green인 과제 수. `fixLoopRounds == 0`이고
  `reviseRounds == 0`이며 첫 `VERIFICATION_COMPLETED`가 통과인 경우
- **분모**: 그 arm의 **유효 과제 전체** (paired가 아니다 — arm 내부 성질이다)

### 2.5 `costToGreen` — Key secondary

- **값**: 실행 시작부터 **최초 green까지** 발생한 **모든 모델 호출 비용.** 재시도·fix
  loop·검수·대조를 전부 포함한다
- 과제별 값이고, 집계는 **중앙값과 사분위**로 낸다(평균은 꼬리에 끌린다)
- **green에 도달하지 못한 실행을 제외하지 않는다.** `notGreenWithinBudget = true`로 남기고
  **검열값(censored)** 으로 처리한다 — 그 과제의 비용은 "예산 상한 이상"이다.
  제외하면 **실패가 비싼 arm이 싸 보인다.** 집계는 셋을 함께 낸다:
  - 검열되지 않은 과제만의 중앙값
  - 검열 비율
  - 검열값을 상한으로 대체한 **보수적 중앙값**

### 2.6 `timeToGreen` — Key secondary

- **값**: 실행 시작부터 최초 green까지의 **wall-clock**. 모델 대기·도구 실행·검증을 전부
  포함한다(사용자가 실제로 기다리는 시간이 그것이다)
- `costToGreen`과 **같은 검열 규칙.** 시간 상한이 검열점이다
- 순차 실행을 전제한다(`--max-concurrency 1`)

### 2.7 `changedLines` — Diagnostic

- **기준**: fixture 원본 workspace 대비 최종 상태의 unified diff, `git diff --no-index` 기본 알고리즘
- **whitespace**: 무시하지 않는다. 다만 `추가+삭제` 합계와 **whitespace-only 변경을 뺀 합계를
  둘 다** 낸다 — 포매터 차이로 숫자가 부풀지 않았는지 확인할 수 있어야 한다
- **생성 파일 제외**: 최상위 `target/`, `node_modules/`, `.git/`, `dist/`, `build/`.
  v1의 `GENERATED_DIRS`와 같은 목록을 쓰고 **한 곳에만 둔다**
- **바이너리**: 줄 수 대신 "변경된 바이너리 파일 수"로 따로 낸다
- **이동**: rename 탐지를 켜고, 이동만 있고 내용이 같으면 0줄

### 2.8 `humanPreferenceDelta` — Secondary descriptive (게이트 제외)

oracle이 포착하기 어려운 축을 본다: **구현 품질, 코드 명료성, 유지보수성, 변경 범위의 적절성,
설계 일관성.**

- **PASS/FAIL 게이트에 넣지 않는다.** 평가자 수·일치도·표본설계가 동결되지 않은 상태에서
  confirmatory 판정에 쓰면 그 판정을 방어할 수 없다
- 쓰려면 먼저 고정해야 하는 것: 평가자 수, 블라인딩 절차, 평가자 간 일치도 기준, 표본 수
- **모델 판정은 이번 프로토콜에서 제외한다.** 향후 쓰더라도 **품질 판정자가 아니라 사람이
  검토할 후보를 분류하는 보조 수단**으로만 둔다 — 판정으로 쓰면 측정 대상이 자기 점수를
  매기는 것이고, 모델 간 합의는 사용자에게 올릴 질문을 지운다(작업 지침 원칙 1)

### 2.9 통계 — 군집화와 신뢰구간

- **반복 실행을 독립 표본으로 단순 취급하지 않는다.** 같은 fixture의 반복은 서로 상관되어
  있다(같은 과제·같은 프롬프트). 독립으로 세면 유효 표본 수가 부풀고 **신뢰구간이 실제보다
  좁아진다** — 없는 유의성이 생긴다
- **fixture 단위로 군집화**한다. 신뢰구간은 **fixture-cluster bootstrap**(fixture를 통째로
  재추출)으로 계산한다. 대안을 쓰려면 **사전에 지정된 paired 방법**이어야 한다
- 재추출 횟수·신뢰수준·난수 seed를 기록에 남긴다

### 2.10 PASS/FAIL 임계값

**기존 사전 등록값을 그대로 사용한다.** 이 문서는 지표의 **정의**를 고정하는 것이지 임계값을
새로 정하는 것이 아니다. 임계값을 바꾸려면 별도의 사전 등록이 필요하다.

### 2.11 실패·중단·미완료 처리

| 상황 | 처리 |
|---|---|
| 인프라 실패 | `INVALID` — 유효 과제에서 제외. **제외 목록을 리포트에 명시**(arm·fixture·분류) |
| `not_dispatched` | 품질 분모에서 제외하고 **별도 집계.** 건수와 사유를 표로 낸다 |
| timeout·불완전 응답·스키마 위반·잘못된 패치 | **실패.** 분모에 남는다 |
| 예산 상한 도달 | `notGreenWithinBudget`. 비용·시간은 **검열값** |
| 시간 상한 도달 | 같음 |
| 프로세스 중단 | **미완료.** green도 실패도 아니며, 재개하거나 **그 쌍 전체를 버린다** |
| 미해결 예약 | v1과 같은 규칙: 자동 정리 없음, 청구 내역으로만 확인 |

**한 arm이 중단되면 그 (fixture, repetition)의 paired 쌍 전체를 무효로 한다.** 한쪽만 남기면
남은 쪽이 유리하게 보인다.

---

## 3. 결과 후에 채울 항목

confirmatory 결과를 본 뒤에만 정할 수 있는 것들이다. **지표 공식과 성공 기준은 여기 없다** —
그건 위에서 이미 고정됐다.

- [ ] **정확한 v2 개입 내용.** 유력한 후보: 실행자 `claude-sonnet-5`, 검수자 강한 OpenAI 모델,
      기준선 동일 Claude 단독. 역방향 구성 추가 여부도 여기서 정한다
- [ ] **ProtocolArm 선택이 confirmatory 결과에 의존한다면 그 선택 규칙의 실행 결과.**
      선택 규칙 자체는 실행 전에 적어두고, 어떤 값이 나와서 무엇을 골랐는지 기록한다
- [ ] **분산 추정에 따른 표본 수.** v1 confirmatory의 **fixture 단위 분산**으로 필요한 반복
      수를 계산한다(§2.9). "3회"를 관성으로 가져오지 않는다
- [ ] **`regressionRate` 게이트 상한** — 반드시 **공통 분모 기준으로** 계산한다(§2.2 주의)
- [ ] **최종 비용 상한과 실행 일정**
- [ ] **동결 커밋 SHA**
- [ ] **새 fixture 세트** (arm 선택이 결과에 의존하는 경우 필수)

---

## 4. 미해결

### 4.1 ~~`netQualityImprovement`의 판정자~~ — **확정됨 (2026-08-27)**

**결정론적 oracle.** §0의 결정 문구가 정본이다. 사람 평가는 §2.8의 secondary로 분리하고
게이트에서 제외하며, 모델 판정은 이번 프로토콜에서 제외한다.

### 4.2 `green` 이후를 재지 않는 것이 맞는가

현재 정의는 green에 도달하면 종료다. "green이지만 나쁜 수정"(과도한 변경, 불필요한 의존성
추가)은 `changedLines`로만 잡힌다. 그 이상은 §2.8의 사람 평가 영역이며, 게이트에 넣지 않는다.

### 4.3 v1 동결 arm을 다시 돌리는 비용

ProtocolArm A는 v1을 **다시 실행**한다(v1 confirmatory 기록을 재사용하지 않는다 — 새 fixture
세트라면 재사용이 불가능하고, 같은 세트라도 시점·공급자 상태가 다르다). 즉 v2 실험의 비용은
**두 arm 합계**다. v1 confirmatory 실측(건당 약 $0.028)을 기준으로 예산을 잡는다.

---

## 5. 진행 순서

```
v1 confirmatory 완료
  ↓
정식 PASS/FAIL 기록 (사전 등록 기준 그대로)
  ↓
ProtocolArm 확정 (§3)  ← 결과에 의존하면 새 fixture 세트 필수
  ↓
이 문서 최종 동결 (PROTOCOL_VERSION 상향, criteriaHash 봉인, commit SHA 동결)
  ↓
승인 카드 → 별도 데이터로 실행
```

**이 순서를 지키는 이유**: 결과를 보고 지표를 고르면 그건 측정이 아니라 사후 정당화다.
그리고 결과를 보고 arm을 고르는 것 자체는 정당하지만, **그렇게 고른 arm을 같은 데이터로
검증하면** 그 성능은 그 데이터에 맞춘 것이지 일반화된 것이 아니다.

---

## 부록 A. v1 confirmatory의 동결 커밋

이 문서가 요구하는 "실행 전 commit SHA 동결"을 **현재 도는 v1 confirmatory에 대해서도**
기록한다. 사후에 "무엇으로 돌렸는가"에 답할 수 있어야 하기 때문이다.

| | |
|---|---|
| 동결 커밋 | **`bf21158`** |
| 실행 시작 | 2026-08-27T11:52:07.896Z |
| 이후 변경 | `PROTOCOL-V2-DRAFT.md` 하나뿐 — **문서이며 실행 경로가 읽지 않는다** |
| 판정 기준 해시 | `a089e94b57fd97c4` (protocol v2 of criteria) |

v1의 사전 등록 기준 4번(paired bootstrap 95% CI 하한 > 0)이 계산하는 값은 fixture 단위
pass-rate 차이의 평균이며, **§2.1의 `netQualityImprovement`와 같은 양**이다. 즉 v1 판정과
v2 primary는 같은 원리 위에 있고, 이 문서의 정의는 그것을 명시적으로 적은 것이다.
