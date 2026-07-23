# Phase 0 스파이크: 교차검증 가설 검증

Tomverse Code의 핵심 아키텍처 가설 — "OpenAI 초안 → Claude 검수" 교차검증이 단일 모델(Claude 단독)보다
실제로 버그를 더 잘 고치는가 — 를 UI/Tauri/Rust 없이 CLI로 빠르게 검증하기 위한 스파이크입니다.
`docs/design/state-machine-and-protocol.md`에서 정의한 프로토콜의 축소판(단일 파일 patch, 단일 검증 라운드,
REVISE 루프 없음)을 사용합니다.

## 무엇을 측정하는가

`fixtures/`에 있는 5개의 작은 버그 픽스처 각각에 대해 두 파이프라인을 돌립니다.

- **dual_verification**: OpenAI가 초안(interpretation + 수정된 파일 전체)을 작성 → Claude가 버그 리포트와
  테스트 파일을 다시 보고 독립적으로 ACCEPT/REVISE/REJECT 판정 → 최종 파일을 적용 → 테스트 실행
- **baseline_single_model**: Claude 혼자 버그 리포트만 보고 바로 수정 → 테스트 실행

각 태스크마다 pass/fail, 비용(USD), 지연시간을 기록하고, 5개 전체에 대한 합산 통계와 "한쪽만 맞춘 케이스"를 리포트합니다.

## 준비

1. Node.js 20+ (이 저장소는 v24로 개발/검증됨)
2. `npm install`
3. `.env.example`을 `.env`로 복사하고 `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`를 채워넣기 (`.env`는 gitignore됨)

```bash
cp .env.example .env
# .env를 열어 키 입력
npm install
```

## 실행

```bash
npm run spike
```

`tsc`로 빌드 후 `dist/index.js`를 실행합니다. 완료되면:
- 콘솔에 태스크별 표와 요약 통계 출력
- `results/run-<timestamp>.json`에 전체 결과(모델 응답 요약, 토큰 사용량, 테스트 출력 포함) 저장 (`results/`는 gitignore됨)

## 예상 비용

기본 모델은 `gpt-5`(초안, $1.25/$10 per 1M 토큰)와 `claude-sonnet-5`(검수+베이스라인, $2/$10 per 1M 토큰,
2026-09-01부터 표준가로 변경 예정)입니다. 태스크 5개 × 호출 3회(초안/검수/베이스라인) 기준으로 파일 크기가
작아 전체 실행 비용은 1달러 미만일 것으로 예상됩니다. `.env`에서 `OPENAI_MODEL`/`ANTHROPIC_MODEL`을
override할 수 있으며, 이 경우 `src/config.ts`의 `PRICING` 테이블에 해당 모델 가격을 추가해야 비용 계산이 정확합니다.

## 픽스처 구조

`fixtures/<task-id>/`마다 3개 파일:
- `task.md` — 사용자 버그 리포트 형태의 태스크 설명(정답을 직접 알려주지 않음)
- `<name>.js` — 버그가 있는 CommonJS 모듈
- `<name>.test.js` — `node:test` 기반 테스트 (버그 버전에서는 실패, 올바른 수정에서는 통과하도록 이미 검증됨)

테스트는 매 실행마다 `os.tmpdir()` 아래 격리된 스크래치 디렉터리에 후보 파일을 복사해 실행되며,
`fixtures/` 원본은 건드리지 않습니다. `fixtures/package.json`의 `"type": "commonjs"`는 상위
`spike/package.json`의 `"type": "module"` 설정이 픽스처에 적용되지 않도록 오버라이드합니다.

## 알려진 스코프 한계 (Phase 0이므로 의도적으로 단순화)

- 파일 전체 교체 방식이며 unified diff/patch 적용이 아님 (설계 문서의 실제 `apply_patch` 방식과 다름)
- REVISE 루프, 재질문(NEED_USER_INPUT), FIX_LOOP 없음 — 검수는 1라운드로 끝
- 태스크당 파일 1개, 함수 1개 수준의 초소형 버그만 다룸 — 실제 리포지토리 규모의 컨텍스트나 심볼 탐색 없음
- 5개 태스크는 통계적으로 유의미한 표본이 아님 — "명백한 방향성"을 빠르게 확인하기 위한 것이며,
  가설이 유의미하게 보이면 태스크 수를 늘려 재실행하는 것을 권장
