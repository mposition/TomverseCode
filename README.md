# Tomverse Code

Windows 데스크톱 AI 코딩 어시스턴트.

**핵심 명제: "AI가 코드를 고쳐준다"가 아니라 "그 결과를 신뢰할 근거를 남긴다".**

대부분의 AI 코딩 도구는 모델의 출력을 그대로 제안한다. Tomverse Code는 **작업의 위험도에 맞춰 검증 강도를 정하고, 최종 판정을 LLM이 아니라 테스트·빌드·타입체크에 맡기며, 무엇을 근거로 그렇게 판정했는지를 되돌려 볼 수 있는 형태로 남긴다.**

포지셔닝은 **`Evidence-first Adaptive Verification`**이다. 한때 `Cross-Verification-first`였고, 그것을 바꾼 것은 우리가 직접 돌린 측정 결과다 — 아래 [측정 결과를 공개해 둡니다](#우리-가설의-측정-결과를-공개해-둡니다).

**동시에 기능을 포기하지 않는다.** GitHub Copilot이 제공하는 기능(MCP, Hooks, 커스텀 에이전트, Plan·Autopilot, worktree 격리, 병렬 실행, PR 연동 등)을 기본적으로 모두 커버하는 것을 제품 명제로 삼는다. 검증 우위를 얻기 위해 이미 쓰던 기능을 포기해야 하는 도구는 애초에 선택지가 되지 못하기 때문이다.

## 무엇이 다른가

| | 일반적인 AI 코딩 도구 | Tomverse Code |
|---|---|---|
| 최종 판정자 | 모델 자신 (또는 사용자의 눈) | **테스트·빌드·타입체크.** 모델이 합의해도 테스트가 실패하면 실패다 |
| 모델이 서로 다른 답을 냈을 때 | 메인 에이전트가 하나를 골라 넘어감 | **합의를 만들어 지우지 않고** 불일치를 사용자에게 강제 선택으로 올린다 |
| 검수 경로 | 있어도 같은 모델이거나 초안의 설명을 본 상태 | 다른 공급자 + `blind` 모드(초안 작성자의 자기설명을 숨김)가 **있다.** 다만 **기본 실행 경로가 아니다** — 우리 실측이 그 이득을 지지하지 않았다 |
| 모델 선택 | 범용 벤치마크 기준 | 이 저장소에서의 실제 성공률 — **집계까지 되어 있고, 라우터가 그 값을 쓰는 것은 아직이다** |
| 데이터 전송 | 불투명 | **어느 공급자에 어떤 파일·규칙·검증 출력이 갔는지 표시** |
| 실행 권한 | 에이전트가 직접 파일·셸 조작 | **모든 실행은 로컬 정책 엔진 승인 후에만** |

## 설계 원칙

- **결정론적 검증이 모델 의견보다 우선.** 두 모델이 합의해도 테스트가 실패하면 실패다.
- **로컬 우선.** 소스 코드·인덱스·셸 실행·세션 기록·API 키가 전부 사용자 PC에 남는다. Tomverse 서버가 코드를 중계하지 않는다.
- **BYOK.** 사용자가 자기 API 키를 연결하고 공급자에 직접 지불한다.
- **최소 권한.** LLM은 구조화된 도구 호출만 요청하고, 실제 실행은 Rust 신뢰 경계가 승인한 뒤에만 일어난다.
- **비용 통제.** 모든 요청에 여러 모델을 부르지 않는다. 위험도에 따라 검증 수준을 조절한다.

## 기술 스택

Tauri 2 + React (데스크톱 UI) · Rust (정책·실행·저장 신뢰 경계) · Node.js 20+ TypeScript sidecar (오케스트레이션·모델 어댑터·컨텍스트 엔진) · SQLite (로컬 상태·감사 로그) · ripgrep + Tree-sitter (코드 검색·인덱싱)

3프로세스 구조와 그 근거는 [docs/design/process-architecture.md](./docs/design/process-architecture.md).

## 기능 범위

출시(v1) 목표는 Copilot 기능 영역 전체를 **커버**하는 것이다. 단 "커버"와 "패리티"를 구분한다 — 각 기능은 *일반적인 사용 사례에서 동작*하는 수준으로 출시하고, 엣지 케이스까지의 깊이는 실사용이 요구할 때 채운다.

기능별 "출시 기준"과 **각 기능이 지금 어디까지 왔는지**는 [product-strategy.md 8.2절](./docs/design/product-strategy.md)의 표가 정본이다. 그 표는 이 README에 복사하지 않는다 — 같은 사실의 사본이 둘이면 둘은 갈라지고, 갈라진 쪽을 읽은 사람이 손해를 본다.

의도적으로 넣지 않는 것은 **클라우드 실행**(로컬 우선 약속과 충돌)과 **인라인 자동완성**(사실상 다른 제품 형태) 둘이며, 그 근거도 같은 문서 8.3절에 적혀 있다.

## 현재 상태

**M0~M3이 들어왔다.** 자연어 요청 한 건이 스냅샷 → 분류 → 모델 수정안 → 정책 판단 → 사용자 승인 →
파일 변경 → 결정론적 검증 → (통과 시) 커밋 → 최종 판정까지 완주하고, 모든 단계가 append-only
이벤트로 남으며, 그 기록으로 나중에 재현 검사를 돌릴 수 있다.

출시 기준 열아홉 행 중 **열일곱 행이 기준을 만족했고 두 행이 `부분`**이다(Git 도구 — 브랜치 생성이 없다,
Windows 특화 — 12.4절 우선순위의 첫 항목까지). 행별 판정과 그 근거는 위에 링크한 8.2절 표에 있다.

**"만들어졌다"와 "Windows에서 확인됐다"는 다른 사실이다.** 아래 목록은 앞의 것을 말한다.
Windows 실기에서 무엇이 실제로 태워졌는지는 [windows-landing-record.md](./docs/design/windows-landing-record.md)가
따로 기록하며, 사람이 확인한 것만 `docs/design/attestations/`의 파일로 들어간다 — 그 확인은
**커밋이 바뀌면 만료된다.**

### 지금 동작하는 것

- **결정론적 검증이 최종 판정자다.** `VERIFYING`은 `complexityTier`와 무관하게 항상 돈다. npm·pytest·cargo·dotnet
  네 러너를 프로젝트에서 감지해 실행하고, 변경 전 baseline과 대조해 **신규 실패와 원래 실패를 가른다.**
  <!-- present: apps/desktop/src-tauri/core/src/verify.rs, apps/desktop/src-tauri/core/src/testnames.rs, packages/sidecar/src/orchestrator/machine.ts -->
- **Rust 신뢰 경계.** Policy Gate가 도구 실행이 반드시 지나는 단일 지점이고, Tool Runtime의 도구는 열세 개다
  (목록·검색·읽기·patch·생성·삭제·이동·명령·테스트·`git status`·`git diff`·MCP 호출·`git push`). `run_command`는
  셸 문자열이 아니라 argv 배열만 받으므로 승인 화면에 보인 것과 실제 실행이 같고, workspace 경계는 `..`뿐 아니라
  심볼릭 링크 탈출까지 본다. secret은 읽기·쓰기·이동 세 방향 모두 사람만 승인할 수 있다.
  <!-- present: apps/desktop/src-tauri/core/src/policy/mod.rs, apps/desktop/src-tauri/core/src/tools/mod.rs -->
- **Tree-sitter 심볼·의존성 그래프.** JS/TS·Python·Rust 세 언어에서 함수·클래스·메서드·인터페이스·타입·최상위
  const·재수출이 심볼로 뽑히고, import/require/`use`/`mod`가 파일 단위 엣지가 된다. 파서가 실패하면 ripgrep으로
  폴백한다.
  <!-- present: packages/sidecar/src/context/symbolIndex.ts, packages/sidecar/src/context/treeSitter.ts, packages/sidecar/src/context/graph.ts -->
- **3사 어댑터와 키 보관.** OpenAI·Anthropic·Google 어댑터가 있고(**Google은 아직 실측 미확인**이다 —
  multi-engine-routing 19.4절이 착지 기준을 따로 두고 있다), 키는 Windows Credential Manager(DPAPI)에 저장된다.
  개발용 메모리 저장소는 `cfg`로 Windows 릴리스 빌드에 **타입 자체가 없다.** 키 주입은 sidecar spawn 시 1회이며
  모델에게 키를 읽는 경로는 없다.
  <!-- present: packages/sidecar/src/providers/factory.ts, packages/sidecar/src/providers/gemini.ts, apps/desktop/src-tauri/core/src/credentials.rs, apps/desktop/src-tauri/core/src/win_credentials.rs -->
- **작업 모드 — Chat · Plan · Interactive · Autopilot.** Chat은 patch를 만들지 않고 답으로 끝나고, 계획은
  실행 전에 통째로 게이트를 지난다. Autopilot은 무인으로 돌되 승인이 필요한 지점에서 **멈추며**, 그 정지를
  사용자 거부로 기록하지 않는다 — "검사 실패 시 정지"에는 **검사가 돌지 못한 경우**도 포함된다.
  <!-- present: apps/desktop/src-tauri/core/src/autopilot.rs, apps/desktop/src-tauri/core/src/deadline.rs, packages/sidecar/src/orchestrator/orchestrator.ts -->
- **커버리지 기능이 코어와 화면 양쪽에 있다.** MCP 서버 등록과 `mcp_call`(언제나 승인이며 정책으로 낮출 수 없다),
  phase 전환 Hooks(등록된 argv 그대로 게이트를 지난다), Skills·커스텀 에이전트의 얕은 버전(도구 허용목록은
  **좁히기만** 하고 Rust가 강제한다), 프로젝트 규칙 자동 로드, PR 생성, 세션 메모리, worktree 격리, Fleet 병렬 실행.
  <!-- present: apps/desktop/src-tauri/core/src/mcp.rs, apps/desktop/src-tauri/core/src/hooks.rs, apps/desktop/src-tauri/core/src/skills.rs, apps/desktop/src-tauri/core/src/pr.rs, apps/desktop/src-tauri/core/src/session_memory.rs, apps/desktop/src-tauri/core/src/worktree.rs, apps/desktop/src-tauri/core/src/fleet.rs, packages/sidecar/src/context/engine.ts -->
- **Git 커밋은 검증을 통과한 뒤에만 만들어진다.** 통과 전에 커밋하면 "검증이 최종 판정자"라는 원칙과 정면으로
  어긋나기 때문이다. 그리고 `allowGitCommit`이 켜져 있어도 **여전히 1클릭 승인**이다 — 정책이 승인 등급을 낮추지 않는다.
  <!-- present: packages/sidecar/src/orchestrator/orchestrator.ts -->
- **취소가 실제로 프로세스를 죽이고, 비정상 종료는 복구된다.** 취소 버튼이 실행 중인 자식 **프로세스 트리**를
  내리고(Windows는 Job Object) 진행 중인 공급자 HTTP 호출을 abort한다. 앱이 비정상 종료하면 다음 실행 때 그
  작업이 `INTERRUPTED`로 확정되고, 되돌리기/다시 실행은 사용자가 고른다 — **자동 재개하지 않는다.**
  <!-- present: apps/desktop/src-tauri/core/src/cancel.rs, apps/desktop/src-tauri/core/src/proctree.rs, apps/desktop/src-tauri/core/src/win_job.rs -->
- **전송 투명성 · 감사 export · 재현 러너.** 어느 공급자에 어떤 파일이 갔는지에 더해, 매 호출에 함께 실리는
  **프로젝트 규칙 전문·커밋되지 않은 변경 요약·검증 출력**까지 화면과 CLI가 센다. 감사 export는 무엇을 보장하는지
  파일 안에 적고, `reproduce`는 **DB 없이** 기록을 검사하며 `--apply`는 각 단계를 Policy Gate에 그대로 태운다 —
  기록에 있다는 것이 승인 근거가 되지는 않는다.
  <!-- present: apps/desktop/src-tauri/core/src/transmission.rs, apps/desktop/src-tauri/core/src/export.rs, apps/desktop/src-tauri/core/src/reproduce.rs, apps/desktop/src/components/TransmissionPanel.tsx, apps/desktop/src/components/AuditExportPanel.tsx -->
- **모델이 갈렸을 때 합의를 만들지 않는다.** 불일치는 표가 아니라 **강제 선택 카드**로 올라간다. 모델이 판정하게
  두면 사용자에게 올릴 질문이 지워지기 때문이다.
  <!-- present: apps/desktop/src/components/DisagreementCard.tsx -->
- **화면이 코어를 따라와 있다.** 단계 표시, 이벤트 로그, 승인 큐(요청이 여러 개여도 덮이지 않는다), diff,
  검증 결과, 되돌리기, 워크스페이스 설정, 스킬 보관함, worktree 선택, PR 올리기, Fleet, 이어받은 판정, 예산.
  화면 안의 계산은 `src/lib`의 순수 로직으로 빼서 DOM 없이 테스트한다.
  <!-- present: apps/desktop/src/lib/approvalQueue.ts, apps/desktop/src/components/FleetPanel.tsx, apps/desktop/src/components/PullRequestPanel.tsx, apps/desktop/src/components/WorkspaceSettingsPanel.tsx, apps/desktop/src/components/SkillLibraryPicker.tsx, apps/desktop/src/components/CarriedDecisionsPanel.tsx -->
- **헤드리스 호스트.** `tomverse-host`가 GUI 없이 같은 코어 루프를 돌린다. e2e 테스트가 이걸 쓰고, 읽기 전용
  하위 명령(`tasks`/`show`/`metrics`/`transmission`/`export`/`reproduce`/`fleet-status`/`windows-landing`)이 붙어 있다.
  <!-- present: apps/desktop/src-tauri/core/src/bin/host.rs -->
- **Windows 특화 — 만들어진 것.** `npm.cmd` shim을 `cmd.exe`로 감싸지 않고 `node.exe npm-cli.js`로 구조를 재현하는
  명령 해석, MSVC 개발자 환경 자동 준비(vswhere로 묻고, 실패하면 **확인한 것을 전부 출력한다**), verbatim·UNC 경로
  정규화, Python 가상환경 인터프리터 직접 호출, Job Object, Credential Manager. **어디까지 Windows 실기에서
  태워졌는지는 아래 목록이 따로 말한다.**
  <!-- present: apps/desktop/src-tauri/core/src/tools/program.rs, apps/desktop/src-tauri/core/src/msvc.rs, apps/desktop/src-tauri/core/src/unc.rs, apps/desktop/src-tauri/core/src/python.rs, apps/desktop/src-tauri/core/src/file_errors.rs -->

### 아직 없는 것

- **Windows 실기에서 아직 확인하지 못한 착지 네 건.** 코드는 있고 Linux에서 타입 검증도 되지만, 사람이 실제
  Windows에서 태운 기록은 아직 없다: ① node가 PATH에 없는 머신에 **설치본을 설치해 실행**하는 것
  (`runsWithoutNodeOnPath`·`sourcesAreBundled`, 그리고 같은 자리에서 자격증명 배너 — 셋 다 `desktop.exe`를 띄워야 한다),
  ② `pythonEnv` 셋(기록을 남긴 머신에 Python이 없었다), ③ **강제 포기 경로**에서의 job 핸들 수명, ④ `processGroup` 둘
  (Ctrl+C 전파와 taskkill 폴백 — 강제할 수단이 필요하다). 판정과 절차는 착지 기록 14절에 있고, 확인하면 문서가
  아니라 attestation 파일로 들어간다.
  <!-- present: docs/design/windows-landing-record.md, apps/desktop/src-tauri/core/src/landing_attest.rs -->
- **Candidate Arena — 복수 구현 경쟁과 선택(M4).** 선행 조건인 worktree 격리와 Fleet 병렬 실행은 갖춰졌지만,
  후보를 겨루게 하고 고르는 로직 자체가 없다. 이것이 왜 순환 의존 위험을 안고 있는지는 product-strategy 9절.
  <!-- absent: apps/desktop/src-tauri/core/src/arena.rs -->
- **실측 기반 학습 라우터(M5).** 무엇을 표본으로 셀지는 정했고 집계(`tomverse-host metrics`의 `modelEvaluation`)까지
  만들었지만, **라우터가 그 값으로 모델을 고르지는 않는다.** 대조 실행에서 판정이 실제로 갈린 쌍이 쌓였을 때가 그
  시점이다.
  <!-- present: apps/desktop/src-tauri/core/src/metrics.rs, packages/sidecar/src/routing/router.ts -->
- **Git 브랜치 생성.** `git status`·`git diff`·커밋·`git push`는 있지만 브랜치를 만드는 도구가 없다.
  <!-- absent: apps/desktop/src-tauri/core/src/branch.rs -->
- **Windows 특화의 나머지(12절 전체).** PowerShell 특화 도구를 비롯해 우선순위 첫 항목 뒤의 것들이 남아 있다.
  <!-- absent: apps/desktop/src-tauri/core/src/tools/powershell.rs -->
- **기업 기능(M6).** 조직 정책, 모델 허용 목록, 데이터 지역.
  <!-- absent: apps/desktop/src-tauri/core/src/org_policy.rs -->

### 의도적으로 하지 않는 것

- **프로세스 샌드박싱(파일·네트워크 제한).** Job Object는 프로세스 트리 종료를 보장하지만 파일·네트워크는
  제한하지 않으며, 그걸 제한하는 수단(AppContainer, 컨테이너)은 **사용자의 환경을 다른 환경으로 바꾼다.**
  이 제품이 파는 것은 "사용자의 실제 환경에서 돌린 실제 빌드·테스트"이므로, 격리를 얻고 판정을 잃는 교환은 하지
  않는다. 근거는 [state-machine-and-protocol.md 20.2절](./docs/design/state-machine-and-protocol.md).
  그래서 **"Policy Gate가 있으니 임의 코드 실행이 안전하다"는 주장은 하지 않는다** — 실행된 프로세스는 스스로
  추가 프로세스를 만들고 파일을 바꿀 수 있다.
- **클라우드 실행**과 **인라인 자동완성.** 야심이 아니라 정의의 문제다(product-strategy 8.3절).

### 이 목록이 다시 낡지 않게 하는 장치

위 두 목록의 각 항목은 **그 주장을 반증할 파일**을 마커로 함께 적는다 — `<!-- present: 경로 -->`는
"있다고 말했으니 그 파일이 있어야 한다", `<!-- absent: 경로 -->`는 "없다고 말했으니 그 파일이 없어야 한다".
`packages/toolchain/test/docStatus.test.ts`가 대조하고, **마커가 없는 항목도 실패다.**

이 README가 M1·M2·M3와 가설 게이트 판정을 통째로 지나친 채 2026-07-27의 사실을 말하고 있었던 이유가 바로
이것이다 — product-strategy의 두 표는 같은 검사가 지키고 있었는데 README는 그 검사 밖에 있었다.
**검사가 잡는 것과 못 잡는 것의 구별**은 그 파일 머리 주석에 적혀 있다. 요약하면, 파일이 생기거나 사라진 것은
잡지만 파일이 남아 있는데 그 안의 기능이 무의미해진 것은 못 잡고, **Windows 실기에서 확인됐는지도 못 잡는다** —
그건 파일 존재로 판정되지 않는다.

전체 검증: `npm run verify` (Node 빌드·타입체크·단위 테스트 + Rust 단위 테스트 + 실제 구성요소 e2e).
로드맵(M0~M6)과 각 단계의 완료 기준은 [product-strategy.md 13절](./docs/design/product-strategy.md).

### 검증을 통과로 위장하지 않기 위해 고친 것

구현하면서 설계 문서가 다루지 않았던 두 가지를 고쳤고, 둘 다 "통과로 위장하지 않는다"는 원칙에 직결된다.

1. **`NODE_TEST_CONTEXT`가 설정된 환경에서는 `node --test`가 실패해도 exit 0을 반환한다.** 검증 러너가
   테스트 실패를 통과로 보고하게 되는 문제라, Tool Runtime이 검증 명령의 환경에서 테스트 러너 제어 변수를
   제거한다. 결정론적 검증은 실행 환경을 통제해야 성립한다.
2. **"변경 전에도 실패했으니 이번 변경 책임이 아니다 → 통과"는 위험한 규칙이었다.** 그러면 "실패하는 테스트를
   고쳐줘"라는 태스크가 아무것도 고치지 않고 성공한다. 지금은 현재 실패 중인 체크가 있으면 실패로 판정하고,
   "당신 변경 때문이 아니다"는 별도로 보고한다.

### 우리 가설의 측정 결과를 공개해 둡니다

이 제품의 전제는 "측정하지 않은 것을 검증됐다고 말하지 않는다"이다. 그 기준을 우리 자신의 가설에도 적용했고,
**결과는 우리에게 불리했다.** 그래서 여기에 적는다.

초기 실험(쉬운 버그 5건)에서 교차 검증은 단일 모델 대비 **정확도 이득이 없었고 비용만 1.63배**였다. 우리는
그것을 "픽스처가 너무 쉬웠기 때문"으로 해석하고, 어려운 태스크로 다시 재기 위해 사전 등록된 가설 게이트를 세웠다.

**2026-08-27에 그 게이트가 답을 냈다.** 어려운 fixture 24개 × 4 arm × 3회 = **288건**을 실제 모델로 돌렸다
(인프라 실패 0.0%, 실지출 $8.21).

| Arm | 통과율 | 평균 비용 | p95 지연 |
|---|---|---|---|
| OpenAI 단독 | 6.9% | $0.0247 | 41.6s |
| **Anthropic 단독** | **30.6%** | **$0.0178** | **27.4s** |
| 교차검증 (informed) | 15.3% | $0.0324 | 122.7s |
| 교차검증 (blind) | 11.1% | $0.0392 | 144.5s |

`netQualityImprovement` **−15.3%p**, paired bootstrap 95% 신뢰구간 **[−0.292, −0.042]**(구간 전체가 0 미만),
p95 지연 **4.49배**. 사전 등록 기준 9개 중 6개 충족, 3개 미달 — 판정은 **Protocol v1 FAIL**이다.

**검수는 288건 중 한 번도 망가뜨리지 않았다**(harm 0). 그러나 실패한 초안 67건 중 **61건에서 아무것도 바꾸지
못했다.** 안전하지만 무력했다.

판정의 범위를 넓히지 않는 것이 중요하므로 나눠 적는다.

| | 내용 |
|---|---|
| **확정됨** | **Protocol v1 FAIL.** 약한 실행자(`gpt-4.1`)의 초안을 강한 검수자(`claude-sonnet-5`)가 독립 검수하는 이 파이프라인은 가장 강한 단일 모델보다 **기능적 성공률이 낮다** |
| **확정되지 않음** | **교차검증 일반의 무효성.** 이 실험이 잰 것은 "약한 실행자 + 강한 검수자"다. 교차검증이라는 개념 자체에 대한 판정이 아니다 |
| **다음 가설** | 강한 실행자와 다른 공급자의 독립 검수를 조합하면 단일 강한 모델보다 유리한가 (Protocol v2, 별도 게이트) |
| **바뀌지 않는 것** | 로컬 실행, 정책 게이트, 결정론적 검증, 추적성 |

**그래서 포지셔닝을 옮겼다: `Cross-Verification-first` → `Evidence-first Adaptive Verification`.** 제품의 중심
문장이 *"두 모델이 서로 검토한다"* 에서 *"위험에 맞춰 가장 신뢰할 수 있는 증거를 구성한다"* 로 이동한다. 이번
데이터가 그 이동을 뒷받침한다 — 검수는 61건에서 무력했지만 **결정론적 판정은 288건 전부에서 작동했다.**

교차검증은 지우지 않고 **`Verified`/`Critical` 작업의 선택 경로로 남긴다.** harm 0이 실측으로 확인됐고 비용
1.82배는 사용자가 고를 수 있는 값이기 때문이다. 기본값이 아니라 선택지이며, **Protocol v2가 통과하기 전까지
교차검증을 품질 주장으로 쓰지 않는다.**

전문은 [product-strategy.md 13.0절](./docs/design/product-strategy.md)과
[evals/hypothesis-gate/README.md](./evals/hypothesis-gate/README.md),
[결과 리포트](./evals/hypothesis-gate/results-2026-08-27-confirmatory.md).

## 문서

`docs/design/` 아래에 설계 결정과 그 근거가 있습니다. 개발 지침은 [CLAUDE.md](./CLAUDE.md).

## 라이선스

미정.
