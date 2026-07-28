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

24개, 8개 카테고리 × 3개, TypeScript와 Rust 두 스택.

```
fixtures/<id>/
  manifest.json      과제·검증 명령·금지 경로·불변식
  workspace/         모델이 보는 저장소 (oracle 없음)
  oracle/            숨겨진 판정 테스트 — 실행이 끝난 뒤에만 주입된다
  reference.patch    이 fixture가 풀 수 있음을 증명하는 참조 수정
```

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
npm run gate:g:pilot      # 반복 1회. 하네스·비용·실패 분류 확인용. PASS를 내지 않는다
npm run gate:g:run        # confirmatory (기본 반복 3회)
npm run gate:g:report     # 기존 기록으로 리포트만 재생성
```

옵션: `--fixtures a,b` `--arms A,B,C,D` `--repetitions N` `--seed N`
`--max-cost-usd N` `--max-concurrency N` `--resume` `--output <dir>`
`--executor-model <id>` `--reviewer-model <id>`

종료 코드: `0`=PASS, `1`=FAIL, `2`=INCONCLUSIVE, `3`=하네스 오류.

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

**실제 가설 판정: INCONCLUSIVE — API 실험 미실행.** 이 저장소에는 OpenAI/Anthropic 자격증명이
없으므로 pilot도 confirmatory도 돌리지 않았다. 성공률과 비용을 지어내지 않는다.
