# 가설 게이트 G 결과

**판정: ❌ FAIL**

## 검증하려는 가설

> 어려운 코딩 작업에서 OpenAI 초안 + 독립 Anthropic 검수가
> **가장 강한 단일 모델 실행**보다 결정론적 성공률을 의미 있게 높이는가?

## 판정 근거

- oracle pass rate 개선 -15.3%p < 기준 10%p (교차검증 15.3% vs 최강 단일 Arm B 30.6%)
- bootstrap 95% 신뢰구간 하한 -0.292 ≤ 0
- p95 지연 122738ms > 최강 단일 arm의 2.5배

## 실행 메타

| 항목 | 값 |
|---|---|
| runId | `run-d32050f1-eda1-4fd0-a289-8eeda73c4e73` |
| seed | 1 |
| 생성 시각 | 2026-08-27T14:09:37.232Z |
| 판정 기준 해시 | `a089e94b57fd97c4` (protocol v2) |
| 가격 스냅샷 기준일 | 2026-07-01 |
| 전체 기록 | 288건 |
| 실제 API 실행 | 288건 |
| fake provider 실행 | 0건 (판정에서 제외) |
| fixture 수 | 24 |
| primary arm 최소 반복 | 3회 |
| 인프라 실패율 | 0.0% |

## Arm 비교

| Arm | 설명 | 분모 (전체) | oracle 통과 | 통과율 | 평균 비용 | 성공 1건당 비용 | p50 | p95 |
|---|---|---|---|---|---|---|---|---|
| A | OpenAI 단독 (초안만, 검수 없음) | 72 | 5 | 6.9% | $0.0247 | $0.3553 | 23119ms | 41611ms |
| B | Anthropic 단독 (처음부터 생성, 검수 없음) | 72 | 22 | 30.6% | $0.0178 | $0.0582 | 15988ms | 27365ms |
| C | 교차검증 (OpenAI 초안 + Anthropic informed 검수) | 72 | 11 | 15.3% | $0.0324 | $0.2119 | 21412ms | 122738ms |
| D | 교차검증 (같은 초안 + Anthropic blind 검수) | 72 | 8 | 11.1% | $0.0392 | $0.3526 | 22004ms | 144468ms |

가장 강한 단일 모델 arm: **B**

## Paired 비교 (fixture 단위)

승 1 / 패 7 / 무 16

paired bootstrap 95% 신뢰구간: 평균 차이 -0.153, [-0.292, -0.042] (10000회 재추출)

| fixture | 카테고리 | 교차검증 | 최강 단일 | 차이 | 결과 |
|---|---|---|---|---|---|
| amb-01-trim-behavior | ambiguous_requirement | 66.7% | 66.7% | +0.0%p | tie |
| amb-02-timezone-boundary | ambiguous_requirement | 0.0% | 0.0% | +0.0%p | tie |
| amb-03-partial-search | ambiguous_requirement | 0.0% | 0.0% | +0.0%p | tie |
| api-01-deprecate-safely | public_api_change | 0.0% | 0.0% | +0.0%p | tie |
| api-02-return-shape | public_api_change | 0.0% | 0.0% | +0.0%p | tie |
| api-03-callback-to-promise | public_api_change | 100.0% | 66.7% | +33.3%p | win |
| asy-01-concurrent-cache | async_ordering | 33.3% | 100.0% | -66.7%p | loss |
| asy-02-event-ordering | async_ordering | 0.0% | 0.0% | +0.0%p | tie |
| asy-03-retry-backoff | async_ordering | 0.0% | 33.3% | -33.3%p | loss |
| err-01-partial-write | error_recovery_rollback | 0.0% | 0.0% | +0.0%p | tie |
| err-02-cleanup-order | error_recovery_rollback | 0.0% | 0.0% | +0.0%p | tie |
| err-03-transaction-rollback | error_recovery_rollback | 0.0% | 0.0% | +0.0%p | tie |
| mfc-01-pagination-contract | multi_file_contract | 66.7% | 100.0% | -33.3%p | loss |
| mfc-02-currency-units | multi_file_contract | 0.0% | 100.0% | -100.0%p | loss |
| mfc-03-range-endpoints | multi_file_contract | 33.3% | 100.0% | -66.7%p | loss |
| sch-01-migration-additive | schema_compatibility | 0.0% | 0.0% | +0.0%p | tie |
| sch-02-optional-field | schema_compatibility | 0.0% | 0.0% | +0.0%p | tie |
| sch-03-event-replay | schema_compatibility | 0.0% | 0.0% | +0.0%p | tie |
| sec-01-path-traversal | security_path_permission | 33.3% | 33.3% | +0.0%p | tie |
| sec-02-token-compare | security_path_permission | 0.0% | 0.0% | +0.0%p | tie |
| sec-03-workspace-confine | security_path_permission | 0.0% | 0.0% | +0.0%p | tie |
| stm-01-loop-bound | state_machine_bounds | 0.0% | 33.3% | -33.3%p | loss |
| stm-02-terminal-once | state_machine_bounds | 0.0% | 0.0% | +0.0%p | tie |
| stm-03-rate-limiter | state_machine_bounds | 33.3% | 100.0% | -66.7%p | loss |

## 검수자 기여 (oracle 기준)

| 분류 | 뜻 | 건수 |
|---|---|---|
| correction | 초안 실패 → 검수 후 성공 | 6 |
| harm | 초안 성공 → 검수 후 실패 | 0 |
| no_measurable_correction | 초안 성공 → 검수 후 성공 | 5 |
| ineffective | 초안 실패 → 검수 후 실패 | 61 |

이 분류는 **oracle 결과만으로** 정해진다. 검수자가 무슨 verdict를 냈는지는 판정에 영향을 주지 않는다 —
측정 대상이 자기 점수를 매기게 하면 아무것도 측정하지 못한다.

## 카테고리별 통과율

| 카테고리 | Arm | 통과율 | n |
|---|---|---|---|
| ambiguous_requirement | A | 11.1% | 9 |
| ambiguous_requirement | B | 22.2% | 9 |
| ambiguous_requirement | C | 22.2% | 9 |
| ambiguous_requirement | D | 11.1% | 9 |
| async_ordering | A | 11.1% | 9 |
| async_ordering | B | 44.4% | 9 |
| async_ordering | C | 11.1% | 9 |
| async_ordering | D | 22.2% | 9 |
| error_recovery_rollback | A | 0.0% | 9 |
| error_recovery_rollback | B | 0.0% | 9 |
| error_recovery_rollback | C | 0.0% | 9 |
| error_recovery_rollback | D | 0.0% | 9 |
| multi_file_contract | A | 11.1% | 9 |
| multi_file_contract | B | 100.0% | 9 |
| multi_file_contract | C | 33.3% | 9 |
| multi_file_contract | D | 33.3% | 9 |
| public_api_change | A | 22.2% | 9 |
| public_api_change | B | 22.2% | 9 |
| public_api_change | C | 33.3% | 9 |
| public_api_change | D | 22.2% | 9 |
| schema_compatibility | A | 0.0% | 9 |
| schema_compatibility | B | 0.0% | 9 |
| schema_compatibility | C | 0.0% | 9 |
| schema_compatibility | D | 0.0% | 9 |
| security_path_permission | A | 0.0% | 9 |
| security_path_permission | B | 11.1% | 9 |
| security_path_permission | C | 11.1% | 9 |
| security_path_permission | D | 0.0% | 9 |
| state_machine_bounds | A | 0.0% | 9 |
| state_machine_bounds | B | 44.4% | 9 |
| state_machine_bounds | C | 11.1% | 9 |
| state_machine_bounds | D | 0.0% | 9 |

## Blind vs Informed

- verdict 불일치율: 20.8%
- oracle 결과 불일치율: 12.5%

## 사전 등록된 판정 기준

결과를 보기 전에 고정된 기준이다. 바꾸려면 protocol version을 올리고 새 실험으로 다시 돌려야 한다.

- 유효한 어려운 fixture 최소 24개
- primary arm fixture당 최소 3회 반복
- 교차검증이 가장 강한 single arm보다 oracle pass rate 최소 10%p 개선
- paired bootstrap 95% 신뢰구간 하한이 0보다 큼
- reviewer correction이 harm의 2배 이상
- 보안 카테고리에서 single arm 대비 regression 0건
- 비용이 가장 강한 single arm의 2배 이하
- p95 지연이 가장 강한 single arm의 2.5배 이하
- 인프라 실패율 5% 미만

## Arm 정의

| Arm | 설명 | 공급자 | review mode | 초안 |
|---|---|---|---|---|
| A | OpenAI 단독 (초안만, 검수 없음) | openai | — | 새로 생성 |
| B | Anthropic 단독 (처음부터 생성, 검수 없음) | anthropic | — | 새로 생성 |
| C | 교차검증 (OpenAI 초안 + Anthropic informed 검수) | openai + anthropic | informed | Arm A 재사용 |
| D | 교차검증 (같은 초안 + Anthropic blind 검수) | openai + anthropic | blind | Arm A 재사용 |

Arm A/C/D는 **같은 초안**을 공유한다. 그래서 A↔C 차이는 검수 단계의 순효과이고, C↔D 차이는 review mode의 순효과다.
각 arm이 초안을 새로 생성하면 초안 품질의 분산이 효과 추정에 섞인다.
