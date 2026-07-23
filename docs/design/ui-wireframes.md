# UI 와이어프레임

status: draft
관련: [state-machine-and-protocol.md](./state-machine-and-protocol.md) (TaskPhase, ExecutionPlan, VerificationReport), [context-engine.md](./context-engine.md)

## 1. 설계 목표

- 원 아키텍처 제안서의 UI 요구사항을 화면 단위로 구체화한다: 채팅/스트리밍, 프로젝트·브랜치·세션 선택, 단계 표시(분석→검수→승인→실행→검증), diff 미리보기, 명령 실행 승인, 비용/토큰/소요시간 표시, 실패 시 재시도·롤백.
- **UI 프로세스는 API 키도 셸 실행 권한도 갖지 않는다**(원 제안서 원칙) — 여기서 그리는 모든 화면은 Local Orchestrator가 typed IPC로 밀어주는 상태를 그대로 렌더링할 뿐이며, "승인" 버튼을 눌러도 UI가 직접 뭘 실행하지 않고 승인 이벤트만 오케스트레이터에 전달한다.
- `TaskPhase`(14개, state-machine-and-protocol.md 2절)를 사용자에게 그대로 노출하지 않는다 — 원 제안서가 요구한 5단계(분석→검수→승인→실행→검증)로 압축해서 보여주고, 내부 상세는 개발자 모드/로그에서만 노출한다(2절 매핑 표).
- 와이어프레임은 저해상도(그레이박스, 실제 색상/폰트 없음)로 유지한다 — 레이아웃과 상태 전이를 확정하는 단계이지 비주얼 디자인 단계가 아니다.

## 2. `TaskPhase` → 사용자 노출 5단계 매핑

| 사용자에게 보이는 단계 | 내부 `TaskPhase` | 진행 표시 |
|---|---|---|
| 준비 중 | `CREATED`, `SNAPSHOTTING`, `TRIAGE` | 스피너, 보통 1초 미만이라 깜빡임 방지용 최소 표시시간만 둠 |
| 분석 | `DRAFTING`, `SINGLE_MODEL_FIX` | "OpenAI가 초안 작성 중" 또는 (simple tier면) "Claude가 검토 중" — tier에 따라 라벨이 달라짐 |
| 검수 | `REVIEWING` | "Claude가 독립 검토 중" (SINGLE_MODEL_FIX tier에서는 이 단계가 생략되고 바로 승인으로 감 — 3.1절) |
| 확인 필요 | `AWAITING_USER_INPUT` | 별도 강조 상태(파란 배지) — 진행바에서 이탈해 사용자 입력 대기 카드로 전환 |
| 승인 대기 | `PLANNING`, `AWAITING_APPROVAL` | ExecutionPlan 요약 + 승인 필요 항목 개수 |
| 실행 | `EXECUTING` | 현재 진행 중인 `ToolRequest` 설명 (n/총 개수) |
| 검증 | `VERIFYING`, `FIX_LOOP` | build/test/lint 각 체크의 진행 상태. FIX_LOOP면 "검증 실패, 재시도 중 (N/max)" |
| 완료/실패 | `COMPLETED`/`FAILED`/`CANCELLED`/`REJECTED` | 터미널 배지 + 요약 |

개발자 모드(설정에서 토글)에서는 실제 `TaskPhase` 값과 `complexityTier`, 카운터(`reviseRounds` 등)를 진행 표시 아래 작은 텍스트로 노출한다 — 디버깅/신뢰 구축용.

## 3. 화면 인벤토리

| # | 화면 | 대응 상태 |
|---|---|---|
| 3.1 | 메인 작업 화면 (채팅 타임라인 + 단계 표시 + diff 패널) | 전체 라이프사이클 |
| 3.2 | 워크스페이스/세션/브랜치 스위처 | `CREATED` 이전, 언제든 |
| 3.3 | 승인 모달 (명령 실행/파일 삭제 등) | `AWAITING_APPROVAL` |
| 3.4 | 확인 필요 카드 (사용자 재질문) | `AWAITING_USER_INPUT` |
| 3.5 | 비용/토큰/소요시간 위젯 | 상시 (진행 중 태스크 있을 때) |
| 3.6 | 실패/취소 후 롤백 화면 | `FAILED`/`CANCELLED` |
| 3.7 | 검증 결과 패널 | `VERIFYING`/`FIX_LOOP`/`COMPLETED`(마지막 리포트) |

### 3.1 메인 작업 화면 (레이아웃)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [≡] Tomverse Code        워크스페이스: my-app ▾   브랜치: main ▾    [⚙] │
├───────────────┬─────────────────────────────────────┬───────────────────┤
│ 세션 목록      │  채팅 타임라인                        │  Diff / 검증 패널  │
│               │                                       │                   │
│ ● 세션 A (진행)│  User: 로그인 버튼이 안 눌려요          │  변경된 파일 (2)   │
│   세션 B      │                                       │  ├ src/Login.tsx  │
│   세션 C      │  ● 분석 ✓ ─ 검수 ✓ ─ 확인필요 ─         │  │  +12 −3        │
│               │    승인 ─ 실행 ─ 검증                  │  └ src/api.ts     │
│               │                                       │     +4 −0         │
│ [+ 새 세션]    │  Claude: 버튼 클릭 시 어떤 폼 필드를    │                   │
│               │  검증해야 하는지 명확하지 않습니다.      │  [파일 클릭 시     │
│               │  이메일만 확인하면 될까요, 비밀번호도    │   전체 diff 표시]  │
│               │  포함해야 할까요?                       │                   │
│               │                                       ├───────────────────┤
│               │  [답변 입력______________] [전송]       │ 비용 $0.02 · 8.4s │
│               │                                       │ 토큰 1.2k/0.6k    │
└───────────────┴─────────────────────────────────────┴───────────────────┘
```

- 단계 표시기(2절 매핑)는 채팅 타임라인 상단에 가로 스텝퍼로 고정되며, 현재 단계가 강조된다.
- Diff 패널은 `ExecutionPlan`이 확정되기 전(`PLANNING` 이전)에는 비어있고 "아직 변경 계획이 없습니다"를 표시 — `DraftProposal.patch`/`ReviewDecision.revisedPatch`가 나온 시점부터 미리보기용으로 먼저 채워질 수 있다(승인 전 미리보기, 아직 적용은 안 됨을 명확히 구분하는 라벨 필요).
- 비용/토큰 위젯(3.5)은 우측 패널 하단에 상시 고정.

### 3.2 워크스페이스/세션/브랜치 스위처

- 상단 바의 드롭다운. 워크스페이스 전환 시 [context-engine.md](./context-engine.md) 2절의 `WorkspaceIndex` 전환/로딩이 발생하므로, 인덱스가 아직 없는 워크스페이스는 "처음 여는 프로젝트라 인덱싱 중..." 로딩 상태를 보여준다(첫 오픈만 느림, 3절 근거).
- 브랜치 전환은 `git checkout`을 UI가 직접 실행하지 않고 `run_command` `ToolRequest`로 오케스트레이터에 요청 → Policy Gate가 `git checkout`을 allowlist 정책(state-machine-and-protocol.md 5절)에 따라 자동/승인 처리.

### 3.3 승인 모달

```
┌───────────────────────────────────────────┐
│  승인이 필요합니다                          │
│                                             │
│  ⚠ run_command                             │
│    git commit -m "fix login validation"    │
│    실행 위치: my-app/                       │
│                                             │
│  ⚠ delete_file                             │
│    src/LoginOld.tsx                        │
│                                             │
│         [거부]              [모두 승인]      │
└───────────────────────────────────────────┘
```

- `ExecutionPlan.toolRequests` 중 `riskTier != "auto"`인 항목만 나열(state-machine-and-protocol.md 4절). `auto`는 조용히 실행되어 모달에 나타나지 않는다 — 원 제안서의 "승인 피로도" 우려를 반영.
- 항목별 개별 승인/거부는 v1 범위에서 제외하고 "모두 승인" / "거부"(전체 취소, `CANCELLED`)만 지원 — 부분 승인은 ExecutionPlan의 순서 의존성 문제를 일으킬 수 있어 이후 검토(6절 미해결).
- `run_command`는 실제 실행될 argv를 그대로 노출한다(5절 allowlist가 shell string을 받지 않으므로 이 표시가 곧 실제 실행 내용과 100% 일치 — 셸 인젝션으로 표시와 실행이 달라질 수 없음).

### 3.4 확인 필요 카드

`AWAITING_USER_INPUT` 진입 시 채팅 타임라인 안에 인라인으로 나타난다(별도 모달 아님 — 대화의 자연스러운 일부로 취급). `ReviewDecision.questionsForUser` 또는 `SingleModelFixResult.questionsForUser`(state-machine-and-protocol.md 3/4b절)를 그대로 렌더링. 답변 전송 시 `DRAFTING`으로 재진입(14.1절 tier 승격 규칙에 따라 이후 항상 standard 경로).

### 3.5 비용/토큰/소요시간 위젯

```
┌─────────────────────────┐
│ 이번 태스크               │
│  비용     $0.0068        │
│  토큰     1.2k in/0.6k out│
│  경과     4.2s            │
│  예상 남은 시간  ~3s (평균 기반) │
└─────────────────────────┘
```

- "예상 남은 시간"은 현재 phase의 과거 평균 소요시간(같은 워크스페이스의 최근 태스크 이력에서 계산, `task_events` 조회)을 기반으로 한 근사치이며 확정값이 아님을 라벨로 명시.
- tier가 `simple`이면(TRIAGE 13.2절) 비용 위젯에 "단일 모델 처리 중 — 교차검증 생략"을 작게 표시해, 왜 이번 태스크가 더 빠른지 사용자가 이해할 수 있게 한다.

### 3.6 실패/취소 후 롤백 화면

state-machine-and-protocol.md 10절 롤백 UX의 화면 구현:

```
┌─────────────────────────────────────────────┐
│  ✗ 작업 실패 (검증 3회 재시도 후 중단)         │
│                                               │
│  이 작업이 변경한 파일 (2개)                   │
│   ☑ src/Login.tsx                            │
│   ☑ src/api.ts                               │
│                                               │
│  [변경사항 보기]     [되돌리기]   [그대로 두기] │
└─────────────────────────────────────────────┘
```

- `FAILED`는 "되돌리기"가 사전 체크된 기본값, `CANCELLED`는 체크 해제 상태로 시작(10절 원칙 그대로).
- "변경사항 보기"는 3.1의 diff 패널로 스크롤/포커스 이동.

### 3.7 검증 결과 패널

`VerificationReport.checks[]`(state-machine-and-protocol.md 3절)를 체크리스트로:

```
검증 결과
 ✓ build     (2.1s)
 ✓ typecheck (0.8s)
 ✗ test      (3.4s) — 2개 실패
 – lint      (skipped)

[실패한 테스트 로그 보기]
```

`FIX_LOOP` 진입 시 이 패널이 "재시도 중 (2/3)"으로 바뀌고, 재시도가 끝나면 다시 최신 결과로 갱신된다.

## 4. 상호작용 규칙 (요약)

- **스트리밍:** `DraftProposal`/`ReviewDecision`/`SingleModelFixResult`의 텍스트 필드(`interpretation`, `rationale` 등)는 Provider가 스트리밍 지원 시 토큰 단위로 채팅 타임라인에 흘려보낸다. `finalFile`/`patch`처럼 구조화 출력의 나머지 필드는 스트리밍 완료 후 한 번에 반영(부분 JSON을 파싱 시도하지 않음 — 깨진 중간 상태를 렌더링하지 않기 위함).
- **취소:** 진행 표시기 옆 "취소" 버튼은 모든 비-터미널 phase에서 노출되며 `CANCELLED`로 전이(2절 상태 다이어그램의 `--> CANCELLED` 전이들과 1:1 대응).
- **재시도 표시:** `reviseRounds`/`fixLoopRounds`가 0보다 크면 단계 표시기에 작은 재시도 카운터 배지(예: "검수 (2/2)")를 추가 — 사용자가 "왜 오래 걸리지"를 이해하게 함.

## 5. 다음으로 구체화할 것

- 부분 승인(ExecutionPlan 항목별 개별 승인/거부) 필요성 — v1 이후 사용자 피드백에 따라 재검토
- diff 패널의 대용량 변경(수십 파일) 처리 UX — 현재는 소수 파일 가정
- 개발자 모드 상세 로그 뷰(`task_events` 원본 타임라인) 레이아웃
- 실제 시각 목업(색상/타이포그래피 적용) — 이 문서는 레이아웃/상태 전이 확정용이며 비주얼 디자인은 별도 패스
- 다국어(한국어/영어) 문자열 카탈로그 분리 시점
