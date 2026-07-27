# Tomverse Code — 작업 지침

Windows 데스크톱 AI 코딩 어시스턴트.

**두 가지를 동시에 만족해야 한다** — 자세한 근거는 [docs/design/product-strategy.md](./docs/design/product-strategy.md).

1. **차별화는 검증 신뢰성에서 나온다.** 기능 개수로 GitHub와 싸워 이길 수 없다.
2. **그러나 기능을 포기하지도 않는다.** Copilot 기능 전체 커버가 제품 명제다(8절). 사용자가 쓰던 기능을 포기해야 하면 차별화를 볼 기회조차 없다.

이 둘의 긴장을 푸는 규칙: **커버(범위)와 패리티(깊이)를 분리한다.** 패리티 기능은 "일반 사례 동작 + 한계 명시"로 시작하고, **차별화 기능만 처음부터 깊게** 만든다. 우선순위가 충돌하면 **패리티의 깊이를 희생하고 차별화의 깊이를 지킨다.** 기능별 출시 기준은 product-strategy.md 8.2절 표에 있다 — 새 기능을 만들 때 "어디까지 하면 되는가"는 그 표를 볼 것.

## 설계 문서 지도

코드를 쓰기 전에 해당 영역 문서를 먼저 읽을 것. 문서들은 서로 참조하며 결정과 그 근거를 담고 있다.

| 문서 | 다루는 것 |
|---|---|
| [product-strategy.md](./docs/design/product-strategy.md) | 제품 포지셔닝, **기능 커버 범위와 출시 기준(8절)**, 로드맵(M0~M6), 북극성 지표, **가설 게이트** |
| [state-machine-and-protocol.md](./docs/design/state-machine-and-protocol.md) | 태스크 상태 머신, 공통 프로토콜 타입, Policy Gate, `run_command` allowlist, SQLite 스키마, 롤백 |
| [context-engine.md](./docs/design/context-engine.md) | `WorkspaceIndex`(세션) vs `WorkspaceSnapshot`(태스크), 관련 파일 선정, 토큰 예산, secret 제외 |
| [multi-engine-routing.md](./docs/design/multi-engine-routing.md) | Model Registry, Role 추상화, 검수자 독립성 불변식, 라우터 부트스트랩 |
| [process-architecture.md](./docs/design/process-architecture.md) | UI / Rust core / Node sidecar 3프로세스 구조, stdio+NDJSON IPC, 신뢰 경계 |
| [ui-wireframes.md](./docs/design/ui-wireframes.md) | 화면 인벤토리, `TaskPhase` → 사용자 노출 5단계 매핑 |

## 절대 어기면 안 되는 원칙

이 원칙들은 제품의 정체성이다. 편의를 위해 우회하지 말 것.

1. **결정론적 검증이 모델 의견보다 우선한다.** build/test/lint 결과가 최종 판정자다. LLM 두 개가 합의해도 테스트가 실패하면 실패다. `VERIFYING`은 `complexityTier`와 무관하게 **항상** 실행된다.
2. **Rust가 신뢰 경계다.** Node sidecar는 파일·셸·자격증명에 직접 접근하지 않는다. 요청만 하고, 실행 여부는 Rust의 Policy Gate가 최종 결정한다. Node가 완전히 장악당해도 Rust 게이트를 반드시 통과해야 한다.
3. **UI 프로세스는 API 키도 셸 실행 권한도 갖지 않는다.**
4. **검수자는 실행자와 다른 공급자여야 한다.** 만족시킬 수 없으면 같은 공급자로 "검증한 척"하지 말고, 검수 역할을 드롭한 뒤 그 사실을 사용자에게 표시한다.
5. **모든 루프에는 상한이 있다.** `clarificationRounds` ≤2, `reviseRounds` ≤2, `fixLoopRounds` ≤3, `toolRetries` ≤2, `providerRetries` ≤3. 상한 없는 루프를 새로 만들지 말 것.
6. **`run_command`는 셸 문자열이 아니라 argv 배열만 받는다.** 이 덕분에 승인 모달에 표시되는 명령이 실제 실행되는 것과 100% 일치한다는 보장이 성립한다. 이걸 깨면 보안 모델과 UI 약속이 동시에 무너진다.
7. **`task_events`는 append-only 진실의 원천이다.** `tasks.phase`는 파생 캐시다. 이벤트를 남기지 않고 상태를 바꾸지 말 것.

## 미검증 가설 — 큰 투자 전에 확인할 것

Phase 0 스파이크 실측: 쉬운 버그 5건에서 **교차검증은 정확도 이득 0%, 비용 1.63배, 지연 1.70배**였다(단일 모델도 5/5 통과).

이 결과 때문에 `TRIAGE`가 도입됐다. 하지만 **어려운 태스크에서 교차검증이 이득인지는 아직 검증되지 않았다.** 제품 전략의 상당 부분이 이 가설 위에 서 있으므로, M2(차별화 기능) 이전에 M1(가설 게이트)을 통과해야 한다. 이 게이트를 건너뛰고 교차검증 기반 기능에 크게 투자하지 말 것.

## 저장소 구조

```
packages/protocol/   @tomverse/protocol — 공유 타입의 단일 소스 (설계 문서의 코드 블록이 여기 실체가 됨)
packages/sidecar/    Node sidecar — Orchestrator(상태 머신), Provider Adapters, Context Engine, Router
apps/desktop/        Tauri 2 + React
  src/               최소 UI — 단계 표시, 이벤트 로그, 승인 모달, diff, 검증 결과
  src-tauri/         Tauri 껍데기 — command/event 배관과 승인 왕복의 UI 쪽 절반. 보안 로직 없음
    core/            tomverse-core — Rust 신뢰 경계 전체. tauri에 의존하지 않는 별도 크레이트
      src/bin/host.rs  tomverse-host — GUI 없이 코어 루프를 돌리는 헤드리스 호스트(e2e 테스트가 사용)
spike/               Phase 0 가설 검증 하네스 (프로덕션 코드 아님, 실험 기록)
docs/design/         설계 문서
```

**`core/`를 별도 크레이트로 둔 이유**(process-architecture.md 8.1절): `tauri`는 GUI 시스템 라이브러리를
요구하므로, 신뢰 경계 코드가 거기에 묶이면 GUI 없는 환경에서 `cargo test`가 돌지 않는다. 보안 로직의
테스트 가능성을 GUI 툴킷 설치 여부에 인질로 잡히지 않기 위한 분리이며, "보안 로직과 UI 로직을 섞지 않는다"를
구조로 강제하는 장치이기도 하다. `core/`는 자체 워크스페이스 루트다(`[workspace]` 빈 테이블).

## 빌드 및 실행

### Node 쪽 (protocol, sidecar)

```bash
npm install            # 루트에서 (npm workspaces)
npm run typecheck      # 전 워크스페이스
npm run build          # protocol → sidecar → desktop 프런트엔드
npm test               # sidecar 단위 테스트 (상태 머신, 컨텍스트, 공급자, 라우터)

npm run verify         # 전체: 위 + Rust 단위 테스트 + 실제 구성요소 e2e
```

**end-to-end 테스트는 Rust 호스트 바이너리를 요구한다** — `npm run core:build`를 먼저 실행해야
`npm run test:e2e`가 돈다. 산출물이 없으면 조용히 건너뛰지 않고 실패하며, 무엇을 빌드해야 하는지 알려준다.

`node --test <디렉터리>`가 이 Node 버전에서 동작하지 않으므로(아래 함정 기록) 테스트 파일 경로를
`packages/sidecar/package.json`에 직접 나열한다. 새 테스트 파일을 추가하면 그 목록도 갱신할 것.

### Rust 쪽 — **반드시 이 패턴을 쓸 것**

이 환경에서 `cargo`를 직접 호출하면 실패한다. 두 가지 이유가 겹친다:
1. `cargo`/`rustc`가 새 셸의 PATH에 없다(winget 설치 후 PATH가 기존 세션에 반영되지 않음)
2. MSVC 링커 환경변수(INCLUDE/LIB)가 없으면 컴파일은 되지만 **링크 단계에서 실패**한다

**작동하는 패턴**: `.bat` 래퍼를 만들고 PowerShell 도구로 실행한다(Bash→cmd.exe 경유는 `vcvarsall.bat` 경로 인용이 깨진다).

이 패턴은 이제 `scripts/`에 들어 있다 — **매번 재발견하지 말고 이걸 쓸 것.**

| 스크립트 | 하는 일 |
|---|---|
| `scripts\_env.bat` | MSVC 툴체인 + cargo PATH 준비. 나머지가 전부 이걸 call한다 |
| `scripts\core-test.bat` | 신뢰 경계 크레이트 테스트 (가장 자주 도는 검증) |
| `scripts\core-build.bat` | `tomverse-host` 빌드 — e2e가 이 산출물을 요구한다 |
| `scripts\desktop-check.bat` | Tauri 껍데기 크레이트 `cargo check` |
| `scripts\verify.bat` | 전체 검증 (Node 타입/빌드/테스트 + Rust + e2e). 하나라도 실패하면 즉시 멈춘다 |

`.bat`는 반드시 CRLF여야 한다 — LF면 cmd.exe가 `goto :label`을 잘못 읽어 조용히 엉뚱하게 동작한다.
`.gitattributes`가 이걸 강제한다.

**단, 신뢰 경계 크레이트(`core/`)는 이 래퍼가 필요 없는 경우가 많다** — tauri에 의존하지 않으므로
GUI 시스템 라이브러리를 요구하지 않는다. `rusqlite`의 bundled SQLite를 컴파일하려면 C 컴파일러는 필요하다.

```bash
cargo test  --manifest-path apps/desktop/src-tauri/core/Cargo.toml
cargo fmt   --manifest-path apps/desktop/src-tauri/core/Cargo.toml --check
```

`rusqlite`는 0.37로 고정되어 있다 — 0.38 이상은 build script가 unstable `cfg_select`를 써서
현재 툴체인에서 컴파일되지 않는다. 올리기 전에 툴체인을 먼저 확인할 것.

## 이 환경에서 이미 밟은 함정

같은 문제를 두 번 디버깅하지 않기 위한 기록.

- **`node --test <디렉터리>`가 동작하지 않는다.** 이 Node 버전은 디렉터리를 `require()`하려 시도하다 `MODULE_NOT_FOUND`로 실패한다. 테스트 파일 경로를 직접 지정할 것 (`node --test dist/test/smoke.test.js`).
- **Tauri `setup()` 훅 안에서 `tokio::spawn`은 패닉한다** ("there is no reactor running"). `tauri::async_runtime::spawn`을 쓸 것.
- **Node의 stdout 쓰기 실패(EPIPE)는 프로세스 전체를 죽인다.** 상대(Rust)가 먼저 종료되면 발생하므로 스트림에 `.on("error", () => {})`가 필요하다.
- **`gpt-5`/`gpt-5.5`는 OpenAI Organization Verification이 필요하다.** 미인증 계정에서 `model_not_found`로 실패한다 — 모델 가용성이 전역 사실이 아니라 **자격증명별 사실**이라는 뜻이고, 이게 Model Registry에 `requiresOrgVerification` 축이 있는 이유다.
- **Git for Windows의 GNU `link.exe`가 MSVC `link.exe`를 PATH에서 가린다.** Rust 링크 실패 시 `link: extra operand ... Try 'link --help'`가 나오면 이건 MSVC가 아니라 **coreutils의 하드링크 유틸리티**가 호출된 것이다. rustc가 붙이는 "Visual Studio에서 C++ 빌드 도구를 선택하라"는 힌트는 이 경우 오도할 수 있다. `vcvarsall.bat`를 거치면 MSVC 경로가 앞에 오므로 해결된다.
- **Bash를 먼저 잡는 습관을 경계할 것.** 이 저장소에서 Windows 네이티브 툴체인(MSVC/MSBuild/VS)을 다룰 때는 PowerShell + `.bat` 래퍼가 기본이다. Bash(MinGW)를 쓰면 위 `link.exe` 같은 Unix 도구 충돌에 걸린다 — 이 편향은 product-strategy.md 12.3절이 우리 제품에서 구조적으로 교정하려는 대상이기도 하다.
- **파일이 LF로 저장되면 git이 CRLF 경고를 낸다** — 정상이며 무시해도 된다. 단 `.bat`만은 예외로 CRLF를 강제한다(`.gitattributes`).
- **`record_*_with_event` 계열은 `append_event`를 거치지 않는다.** 레코드와 이벤트를 한 트랜잭션에 쓰기 위한 설계인데, 그 대가로 **sink(UI) 릴레이가 빠진다.** DB에는 남는데 화면에는 안 보이는, 찾기 어려운 종류의 누락이다. 새로 이런 메서드를 만들면 커밋 후 `TaskHost::relay`를 반드시 부를 것.
- **SQLite 뷰에는 `rowid`가 없다.** `tool_executions`처럼 뷰를 조회할 때 `ORDER BY rowid`는 런타임 오류다 — 정렬 기준이 될 컬럼을 뷰에 포함시켜야 한다.

## 관련 프로젝트

**Tomverse Insight** (`H:\Project\ai-chat-hub`, 리포 `mposition/Tomverse`) — 같은 사용자의 첫 제품, Next.js 클라우드 SaaS. **별도 리포지토리이고 합치지 않는다.**

- Insight의 `lib/modelRegistryShared.ts`에 11개 공급자 레지스트리가 프로덕션에서 돌고 있다. **카탈로그 데이터는 재사용**하되(복사 + 출처 주석), `modelRegistry.ts`(server-only + Prisma)나 크레딧 과금 로직은 재사용하지 않는다 — Insight는 크레딧 SaaS, Code는 BYOK라서 "이 모델을 쓸 수 있나"가 서로 다른 질문이다.
- 라이선스·구독 백엔드는 나중에 **HTTP 계약**으로 연결한다. Insight 모듈을 import하지 않는다.
- 자세한 경계는 [multi-engine-routing.md 11절](./docs/design/multi-engine-routing.md).

## 작업 방식

- 응답은 한국어로.
- 설계 결정은 근거와 함께 문서에 남긴다. 특히 **되돌리기 비싼 결정**(프로세스 경계, 스키마, 보안 모델)은 반드시.
- 문서의 "다음으로 구체화할 것" 절이 미해결 항목의 정본이다. 해결되면 취소선과 함께 어디서 해결됐는지 링크한다.
- 커밋 메시지는 무엇을 했는지보다 **왜 그렇게 했는지**를 적는다.
