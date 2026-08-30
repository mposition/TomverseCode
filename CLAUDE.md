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
| [product-strategy.md](./docs/design/product-strategy.md) | 제품 포지셔닝, **기능 커버 범위와 출시 기준(8절)**, 로드맵(M0~M6), 북극성 지표, **가설 게이트**, **판정 권위의 계층(16절)** |
| [state-machine-and-protocol.md](./docs/design/state-machine-and-protocol.md) | 태스크 상태 머신, 공통 프로토콜 타입, Policy Gate, `run_command` allowlist, SQLite 스키마, 롤백, **사용자 판정의 고정과 수명(17절)** |
| [context-engine.md](./docs/design/context-engine.md) | `WorkspaceIndex`(세션) vs `WorkspaceSnapshot`(태스크), 관련 파일 선정, 토큰 예산, secret 제외 |
| [multi-engine-routing.md](./docs/design/multi-engine-routing.md) | Model Registry, Role 추상화, 검수자 독립성 불변식, 라우터 부트스트랩, **co-executor 배정(13절)** |
| [process-architecture.md](./docs/design/process-architecture.md) | UI / Rust core / Node sidecar 3프로세스 구조, stdio+NDJSON IPC, 신뢰 경계 |
| [ui-wireframes.md](./docs/design/ui-wireframes.md) | 화면 인벤토리, `TaskPhase` → 사용자 노출 5단계 매핑, **불일치 판정 카드(3.9)** |
| [windows-landing-record.md](./docs/design/windows-landing-record.md) | **설계가 아니라 관측 기록.** `windows-landing`이 `NeedsHuman`으로 남기는 항목을 실제 Windows에서 태워본 결과 — 무엇이 확인됐고, 무엇을 **왜 태우지 못했는지**, 그리고 남은 착지 차단 |

## 절대 어기면 안 되는 원칙

이 원칙들은 제품의 정체성이다. 편의를 위해 우회하지 말 것.

1. **결정론적 검증이 모델 의견보다 우선한다.** build/test/lint 결과가 최종 판정자다. LLM 두 개가 합의해도 테스트가 실패하면 실패다. `VERIFYING`은 `complexityTier`와 무관하게 **항상** 실행된다.
   **단, 결정론적 검증이 판정하는 것은 *결과*다.** *요구*에 대한 최종 권위는 사용자이며, 모델은 어느 쪽도 판정하지 않는다 — 모델의 역할은 쟁점 발굴이다. 세 권위의 관할은 product-strategy.md 16절에 있다. 모델 간 합의를 만들어 판정으로 쓰지 말 것: 합의는 사용자에게 올릴 질문을 지운다.
2. **Rust가 신뢰 경계다.** Node sidecar는 파일·셸·자격증명에 직접 접근하지 않는다. 요청만 하고, 실행 여부는 Rust의 Policy Gate가 최종 결정한다. Node가 완전히 장악당해도 Rust 게이트를 반드시 통과해야 한다.
3. **UI 프로세스는 API 키도 셸 실행 권한도 갖지 않는다.**
4. **검수자는 실행자와 다른 공급자여야 한다.** 만족시킬 수 없으면 같은 공급자로 "검증한 척"하지 말고, 검수 역할을 드롭한 뒤 그 사실을 사용자에게 표시한다.
5. **모든 루프에는 상한이 있다.** `clarificationRounds` ≤2, `reviseRounds` ≤2, `fixLoopRounds` ≤3, `toolRetries` ≤2, `providerRetries` ≤3. 상한 없는 루프를 새로 만들지 말 것.
6. **`run_command`는 셸 문자열이 아니라 argv 배열만 받는다.** 이 덕분에 승인 모달에 표시되는 명령이 실제 실행되는 것과 100% 일치한다는 보장이 성립한다. 이걸 깨면 보안 모델과 UI 약속이 동시에 무너진다.
   Windows에서 `npm`이 `npm.cmd`(배치 shim)라는 문제는 **`cmd.exe /c`로 감싸서 풀지 않는다** —
   감싸는 순간 인자의 `&`/`|`/`%`가 셸에 재해석되어 이 보장이 사라진다. 대신
   `tools/program.rs`가 shim이 하는 일을 구조적으로 재현한다(`node.exe npm-cli.js <원래 argv>`).
   구조를 확인할 수 없으면 추측해서 실행하지 않고 실패한다.
7. **`task_events`는 append-only 진실의 원천이다.** `tasks.phase`는 파생 캐시다. 이벤트를 남기지 않고 상태를 바꾸지 말 것.

## 미검증 가설 — 큰 투자 전에 확인할 것

Phase 0 스파이크 실측: 쉬운 버그 5건에서 **교차검증은 정확도 이득 0%, 비용 1.63배, 지연 1.70배**였다(단일 모델도 5/5 통과).

이 결과 때문에 `TRIAGE`가 도입됐다. 하지만 **어려운 태스크에서 교차검증이 이득인지는 아직 검증되지 않았다.** 제품 전략의 상당 부분이 이 가설 위에 서 있으므로, **가설 게이트 G를 통과하기 전에 교차검증 기반 차별화 기능에 크게 투자하지 말 것.**

(이 문단은 한때 "M2(차별화) 이전에 M1(가설 게이트)"이라고 적혀 있었는데, 옛 로드맵 기준이라 지금과 어긋난다. product-strategy.md 13절이 정본이다: **G = 가설 게이트**(병렬 과제), **M1 = 차별화(깊게)**, **M2 = 커버리지 A**.)

**게이트가 실패해도 살아남는 차별화**가 무엇인지는 13절이 미리 정해두었다 — 결정론적 검증, Windows 특화, **전송 투명성**(7절), 커버리지 전반. 게이트를 못 돌리는 동안 차별화를 진행해야 하면 이 목록에서 고를 것.

## 저장소 구조

```
packages/protocol/   @tomverse/protocol — 공유 타입의 단일 소스 (설계 문서의 코드 블록이 여기 실체가 됨)
packages/toolchain/  @tomverse/toolchain — 빌드 산출물 위치(Windows는 tomverse-host.exe),
                     MSVC 환경 준비, 워크스페이스 빌드 순서. sidecar e2e·가설 게이트·cargo
                     런처가 **같은 함수**를 쓴다 — 이 지식을 복사해 두었다가 두 곳만 틀려
                     Windows e2e가 깨진 적이 있다
  node-runtime.json  **동봉하는 Node 런타임의 핀.** 설치본에 무엇이 들어가는지의 정본이며,
                     빌드는 여기 적힌 sha256과 정확히 일치하는 바이트만 넣는다. 손으로 고치지
                     말 것 — `npm run node-runtime:pin`이 GPG 서명을 allowlist
                     (`node-signing-keys.json`)로 검증한 뒤에만 다시 쓴다. 근거는
                     process-architecture.md 10.6절
  js/nodeRuntime.mjs,
  js/sidecarStage.mjs  동봉 번들의 **레이아웃과 스테이징 계획**. exec.mjs와 같은 이유로
                     빌드하지 않는 일반 JavaScript다. 레이아웃 상수는 `launcher.rs`(찾는 쪽)와
                     대조되고, 스테이징 자리는 `tauri.conf.json`과 대조된다 —
                     `test/sidecarBundle.test.ts`가 **파일을 직접 읽어** 지킨다. 갈라지면
                     증상이 "설치본이 조용히 PATH의 node로 돈다"라 눈에 띄지 않는다
  js/exec.mjs        **일반 JavaScript다. 빌드하지 않는다.** MSVC 환경 준비와 실행 파일 해석의
                     실제 구현이 여기 있고, src/msvc.ts와 src/nodeCli.ts는 타입만 붙여 재수출한다.
                     TypeScript에 두면 "Rust를 빌드하려면 TypeScript를 먼저 빌드해야 한다"는
                     순환이 생기고 clean clone에서 막다른 길이 된다. package exports의
                     `./exec` 서브패스가 dist를 거치지 않고 이걸 직접 가리킨다
packages/sidecar/    Node sidecar — Orchestrator(상태 머신), Provider Adapters, Context Engine, Router
apps/desktop/        Tauri 2 + React
  src/               최소 UI — 단계 표시, 이벤트 로그, 승인 모달, diff, 검증 결과
  src-tauri/         Tauri 껍데기 — command/event 배관과 승인 왕복의 UI 쪽 절반. 보안 로직 없음
    core/            tomverse-core — Rust 신뢰 경계 전체. tauri에 의존하지 않는 별도 크레이트
    core/src/win_job.rs  Windows Job Object — 프로세스 트리 종료 보장. **Linux에서는 컴파일되지
                     않으므로 여기서 통과한 verify가 이 파일에 대해 말해주는 것이 없다.**
                     별도 크레이트에서 실제 파일을 #[path]로 가리켜 타입 검증만 했다(문서 20.5절)
    core/src/credentials.rs  Credential Store — 키를 앱 안에서 넣고 지운다(multi-engine-routing 20절).
                     저장 계층이 트레이트 뒤에 있고 **폴백은 컴파일러가 막는다**: 개발용
                     `MemoryCredentialStore`는 `cfg(any(test, not(windows)))`라 Windows 릴리스
                     빌드에 타입 자체가 없다. `win_credentials.rs`가 Credential Manager(DPAPI)
                     구현이고 `win_job.rs`와 같은 검증 경계를 갖는다.
                     **저장소가 생겨도 `credential.get`은 되살아나지 않는다** — 주입은 여전히
                     spawn 시 1회다. 그 불변식을
                     `packages/toolchain/test/credentialBoundary.test.ts`가 소스에서 지킨다
      src/bin/host.rs  tomverse-host — GUI 없이 코어 루프를 돌리는 헤드리스 호스트(e2e 테스트가 사용).
                     `run` 외에 읽기 전용 하위 명령이 있다: `tasks`/`show`/`metrics`/`transmission`/`export`/`reproduce`/`fleet-status`/`windows-landing`.
                     `abandon --task <id>`는 읽기 전용이 아니다 — **강제 포기**(화면의 탈출구)를 헤드리스에서
                     부른다. 화면과 **같은 함수**(`TaskHost::force_abandon`)를 타므로 이 명령으로 태운 것이
                     제품 경로를 태운 것이며, 그게 `jobHandleLifetime`의 나머지 절반을 실측할 수 있게 한 이유다.
                     프로세스를 죽이지 않는다(죽일 수 있었으면 이 경로가 필요 없었다). 이미 끝난 태스크에는
                     `abandoned:false`를 내고 **종료 코드는 0이다** — 그건 실패가 아니라 좋은 소식이다.
                     `--no-job-object`는 **Windows에서 Job Object를 만들지 않게 하는 진단 스위치**다.
                     `taskkill` 폴백은 job 생성이 실패해야만 타는 경로라 한 번도 실행된 적이 없었고
                     (기록 12절), 그것을 강제하는 유일한 수단이다. **GUI에는 없고 만들지 말 것** — 켤 수
                     있으면 제품 경로의 종료 보장을 무력화하는 수단이 된다(`proctree.rs`의 소스 검사 테스트가
                     지킨다). 환경변수가 아닌 이유는 상속 때문이다. 켰다는 사실은 결과의
                     `treeKill.jobObjectDisabled`에 남는다 — 그래야 "만들지 못했다"와 구별된다.
                     `fleet`은 **N개 병렬 실행**이다(구성원마다 worktree 하나). 각 구성원은 자기 트리를 게이트
                     루트로 받는 **평범한 태스크**이며 Policy Gate에 분기가 없다. 어려운 것은 병렬 실행이 아니라
                     process-architecture 11.2절의 셋이었다 — 승인 큐(`approvals.rs`), **합계 예산의 예약**
                     (`fleet.rs`: 태스크당 상한과 별개이며, 태스크당 상한 없이는 걸 수 없다), 검증 직렬화
                     (`verify.rs`의 레인 — 언제나 켜져 있다). Fleet 단위 상태는 새 테이블이 아니라
                     `task_events`의 `FLEET_ENROLLED`이고, 그 이벤트는 `NODE_MAY_NOT_EMIT`이라 모델은
                     Fleet을 시작할 수도 기록할 수도 없다.
                     `windows-landing`은 **Windows에서만 검증되는 동작의 착지 판정을 사람 머릿속에서 꺼낸 것**이다 —
                     Job Object·sidecar 번들·Credential Store·명령 해석(npm shim)·프로세스 그룹·경로 정규화·개발자 환경(MSVC)·Python 가상환경 여덟 묶음이고,
                     `cfg(windows)`/`Platform::Windows`를 쓰는 파일이 그 목록에 없으면 테스트가 실패한다.
                     `--attest <파일>`이 **사람이 확인한 결과를 받는 입구**다(`landing_attest.rs`, 기록 15절) —
                     입구가 없으면 확인한 사실이 다시 기억에만 남는다. 다만 사람의 확인은 `needs_human`/
                     `not_checkable_here`만 통과로 바꾼다: **관측된 `failed`도, 아직 없는 기능도 덮지 못하고**,
                     기록된 머신에 없는 것으로 확인했다는 줄도 통과시키지 않는다(Python 없는 머신의 `pythonEnv`).
                     **커밋이 바뀌면 만료된다** — 옛 확인이 새 코드를 통과시키면 안 되기 때문이다.
                     만들어 주는 명령은 없다. 사람이 확인한 것을 사람이 적는 것이 이 기록의 전부다.
                     `metrics`는 저장된 이벤트에서 계측을 집계한다 — 기준 커버리지·충돌 결말과
                     **취소 소요 분포**(강제 포기 탈출구가 뜨는 시점의 근거), 그리고 **모델 정면
                     비교**(`modelEvaluation` — 대조 실행에서 사용자가 어느 모델의 안을 골랐는가.
                     라우팅에 반영해도 되는 유일한 신호다. multi-engine 8.1절).
                     DB는 Rust의 것이므로 집계도 여기 둔다(Node가 SQLite를 직접 열지 않는다).
                     `reproduce`만 예외로 **DB를 열지 않는다** — 감사자에게는 DB가 없고(그래서
                     export 파일이 있다), 열면 없던 state.db가 생긴다. 검사는 아무것도 쓰지 않고
                     `--apply`는 파일을 쓰되 **각 단계가 Policy Gate를 그대로 지난다**(기록에
                     있다는 것은 승인 근거가 아니다). 판정 규칙은 state-machine 21절
spike/               Phase 0 가설 검증 하네스 (프로덕션 코드 아님, 실험 기록 — 보존하되 수정하지 않는다)
evals/hypothesis-gate/  가설 게이트 G — 어려운 태스크에서 교차검증이 실제 이득인지 측정한다.
                     제품 코드가 아니라 **측정 도구**이며, production 실행 경로(tomverse-host)를
                     그대로 태운다. 사전 등록된 판정 기준이 src/criteria.ts에 해시로 봉인되어 있다.
docs/design/         설계 문서
```

**`core/`를 별도 크레이트로 둔 이유**(process-architecture.md 8.1절): `tauri`는 GUI 시스템 라이브러리를
요구하므로, 신뢰 경계 코드가 거기에 묶이면 GUI 없는 환경에서 `cargo test`가 돌지 않는다. 보안 로직의
테스트 가능성을 GUI 툴킷 설치 여부에 인질로 잡히지 않기 위한 분리이며, "보안 로직과 UI 로직을 섞지 않는다"를
구조로 강제하는 장치이기도 하다. `core/`는 자체 워크스페이스 루트다(`[workspace]` 빈 테이블).

## 빌드 및 실행

### CI — 무엇이 자동으로 돌고 무엇이 사람 몫인가

`.github/workflows/ci.yml`이 **리눅스 러너(ubuntu-24.04)에서 `npm run verify`를 끝까지 돌린다** —
`desktop:check`와 `test:e2e`까지다. PR, main push, 주간 schedule, 수동 실행에서 돈다.

**CI는 단계를 다시 나열하지 않는다.** 검증 진입점은 루트 `verify`와 `scripts\verify.bat` 둘이고,
CI가 세 번째 목록이 되면 셋이 갈라진다(이 저장소는 `.bat`만 `_env.bat`을 call해서 **순서는 같은데
환경 준비 의미가 다른** 상태를 이미 겪었다). CI는 `npm run verify` 한 줄만 부르고,
`packages/toolchain/test/verifyOrder.test.ts`가 그 사실을 지킨다. 나머지 약속(락파일이 정본,
Node 하한, 실패를 삼키지 않기, 캐시 없는 경로)은 `packages/toolchain/test/ciWorkflow.test.ts`에 있다.

| 자동으로 돈다 | 여전히 사람 몫이다 |
|---|---|
| `npm ci` — 락파일 누락을 여기서 잡는다 | `scripts\verify.bat`(Windows 진입점) |
| `build`·`typecheck`·`core:build`·`test`·`core:test` | `windows-landing` 착지 판정과 `--attest` — **리눅스 러너가 판정할 수 없는 것들이다**(Job Object, Credential Store, npm shim 해석, MSVC) |
| `desktop:check` — 껍데기/core 드리프트 | `scripts\tauri-build.bat` 릴리스 번들과 `sidecar:stage`(핀된 node.exe가 필요하고 오래 걸린다) |
| `test:e2e` — 실제 sidecar·호스트 왕복 | 가설 게이트 유료 실행(`gate:g:pilot`/`run`) — API 키와 예산 승인이 필요하다 |
| | `cargo fmt --check` — verify에 없다 |

**캐시가 감출 수 있는 것.** npm/cargo 캐시를 쓰지만, 이 저장소는 낡은 산출물 때문에 원인과 먼
오류를 본 적이 있다(낡은 `.d.ts`로 컴파일되던 일). 그래서 **주간 schedule 실행은 캐시를 끄고**
clean clone과 같은 경로로 돈다(`TOMVERSE_CI_CACHE=off`). 캐시 유무로 job을 나누지 않는다 —
같은 job의 같은 단계 목록에서 캐시 **단계만** 건너뛴다. 급하면
`workflow_dispatch`에 `cache: off`로 수동 실행할 수 있다.

**`desktop:check`는 리눅스에서 돈다.** GUI **개발** 패키지(`libgtk-3-dev`,
`libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`, `libsoup-3.0-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`)를 설치하면 된다. `bundle.resources`가 가리키는
`bundle/sidecar`는 **디렉터리만 있으면** 되고 이제 `scripts/ensureBundleSlot.mjs`가 만든다 —
예전에는 그 자리를 `sidecar:stage`(릴리스 앞에서만 돈다)가 만들었기 때문에 clean clone의
`npm run verify`가 여기서 반드시 죽었고, 그것을 "이 환경에서는 원래 실패한다"는 **사람이 기억하는
예외**로 들고 있었다. 그 예외는 이제 없다.

### Node 쪽 (protocol, sidecar)

```bash
npm install            # 루트에서 (npm workspaces). verify는 의존성을 건드리지 않으므로 이건 먼저 해둘 것
npm run build          # protocol → sidecar → desktop 프런트엔드
npm run typecheck      # 전 워크스페이스 (build 다음이다 — 아래 순서 이유 참조)
npm test               # sidecar 단위 테스트 (상태 머신, 컨텍스트, 공급자, 라우터)

npm run verify         # 전체: 위 + Rust 단위 테스트 + 실제 구성요소 e2e
```

**`build`와 `typecheck`는 워크스페이스를 명시적 순서로 돈다** — `--workspaces`는 글롭 확장
순서(`protocol → sidecar → toolchain → …`)로 돌며 의존성을 모른다. sidecar와 가설 게이트는
`@tomverse/toolchain`의 **빌드 산출물**을 import하므로 그 순서는 clean clone에서 실패한다.
순서가 뒤집히면 `packages/toolchain/test/buildOrder.test.ts`가 실패한다 — 판정 기준은 사람이
적은 또 다른 목록이 아니라 **각 워크스페이스 package.json에서 유도한 의존성 그래프**다.
새 워크스페이스를 루트 `build`에 빠뜨려도 같은 테스트가 잡는다.

**`core:build`/`core:test`는 cargo를 직접 부르지 않고 `scripts/cargo.mjs`를 지난다** —
아래 "Rust 쪽" 절 참조.

**검증 순서는 고정이다. `build` → `typecheck` → `core:build` → `test` → `core:test` → `test:e2e`.**

- **build가 typecheck보다 먼저인 이유**: sidecar는 protocol의 **빌드 산출물**(`dist`)에 대해 타입
  검사한다. clean clone이나 fetch 직후처럼 `dist`가 없거나 낡은 상태에서 typecheck를 먼저 돌리면
  **잘못된 protocol 타입을 읽는다** — 통과해도 통과가 아니고, 실패해도 실패가 아니다.
- **core:build가 `test`보다 먼저인 이유**: `npm test`에 포함된 가설 게이트 통합 테스트가
  **실제 `tomverse-host` 바이너리를 요구한다.** 로컬에 남은 예전 바이너리 덕분에 통과하는 상태를
  허용하지 않는다 — clean clone에서 반드시 실패하기 때문이다.
- e2e도 같은 바이너리를 요구한다. 산출물이 없으면 조용히 건너뛰지 않고 실패하며,
  **검사한 전체 경로**를 알려준다(Windows는 `.exe`가 붙는다).

이 선후 관계는 `packages/toolchain/test/verifyOrder.test.ts`가 루트 `verify`와
`scripts\verify.bat` 양쪽에서 지킨다. 한쪽만 고치면 테스트가 실패한다.

`scripts\verify.bat`과 루트 `package.json`의 `verify`는 **의미상 동일해야 한다.** 한쪽만 고치지 말 것.

**루트의 `build`/`typecheck`에는 `--if-present`를 쓰지 않는다.** 워크스페이스가 스크립트를 잃으면
조용히 통과하는 대신 실패해야 하기 때문이다. `test`는 테스트가 있는 워크스페이스를 명시한다 —
새 워크스페이스에 테스트를 추가하면 루트 `test`에도 넣을 것.

`node --test <디렉터리>`가 이 Node 버전에서 동작하지 않으므로(아래 함정 기록) 테스트 파일 경로를
`packages/sidecar/package.json`에 직접 나열한다. 새 테스트 파일을 추가하면 그 목록도 갱신할 것.
(`evals/hypothesis-gate/package.json`도 같은 방식이다.)

**루트 `test`에 워크스페이스를 빠뜨리는 것은 이제 테스트가 잡는다** —
`packages/toolchain/test/buildOrder.test.ts`가 "테스트가 있는 워크스페이스"와 루트 `test` 목록을
대조한다. 사람이 지키는 규칙으로 두면 언젠가 빠지고, **빠진 테스트는 실패하지 않으므로 빠진
사실이 드러나지 않는다.**

`apps/desktop`도 테스트가 있다(`tsconfig.test.json` → `dist-test`). 화면(tsx)이 아니라
`src/lib`의 순수 로직만 컴파일해 DOM 없이 `node --test`로 돌린다 — 계산이 화면 안에 있으면
검증할 방법이 없다.

### 가설 게이트 G

```bash
npm run gate:g:validate   # fixture 24개 품질 검증 (모델 호출 없음)
npm run gate:g:triage-calibration  # TRIAGE 임계값 표 — fixture 세트를 난이도 라벨로 쓴다 (모델 호출 없음)
npm run gate:g:dry-run    # preflight + 실행 계획 (API 호출 없음)
npm run gate:g:plan-pilot # 단계별(P0/P1) 승인 카드 (API 호출 없음)
npm run gate:g:probe-models  # 역할당 최소 요청 1회로 모델 실제 확인. --max-cost-usd 필수
npm run gate:g:budget-status # 예산 상태 읽기 전용 조회 (열린 예약). 고치지 않는다
npm run gate:g:attest-p0     # P0 결과 검사 → approvals/attestations/<id>.json (API 호출 없음)
npm run gate:g:pilot      # 반복 1회 — 하네스/비용/실패 분류 확인용. PASS를 내지 않는다
npm run gate:g:run        # confirmatory (기본 반복 3회). 실제 API 키가 필요하다
```

**"레지스트리에 있으므로 사용 가능"은 승인 근거가 아니다.** 모델 가용성은 전역 사실이 아니라
자격증명별 사실이므로(gpt-5 사례), 준비성을 축별로 나눠 적고 오프라인 검사는
`credentialPresent`·`liveProbeVerified`·`exactModelIdVerified`를 **true로 만들 수 없다.**
그래서 카드 상태에 `READY_FOR_MODEL_PROBE`가 있고, 유료 pilot 승인은 `probe-models`가
실제 호출로 확인한 뒤에만 가능하다.

**재개가 승인 한도를 늘리지 않는다.** `records.jsonl`에서 확정 비용을 복원해 원장에 넣고,
복원값을 신뢰할 수 없으면(비용 없는 유료 기록, NaN, 중복 기록, 이벤트와 불일치) **재개하지
않는다.** 0으로 보고 계속하는 것이 가장 위험하다 — 그 순간 한도가 사라진다.

**합계 비교만으로는 부족하다 — 열린 예약이 보이지 않는다.** 예약 개시 후 정산 전에 죽으면
`reservation_opened`만 남고 어떤 합계에도 나타나지 않는데, 그 요청은 과금됐을 수 있다. 예산
이벤트를 correlationId별 상태 머신으로 검증하고(허용 흐름 `opened → settled` / `opened → released`),
열린 예약이 있으면 `BLOCKED_UNRESOLVED_RESERVATION`으로 멈춘다. **자동 정리 명령을 만들지 말 것** —
실제 과금 여부는 공급자 청구 내역으로만 확인된다. 근거: multi-engine-routing.md 10.7절.

**승인 아티팩트는 immutable하고, 실행은 receipt로 승인에 묶인다.** 카드·evidence·attestation은
`<output>/approvals/{cards,evidence,attestations}/<id>.json`에 살고 **같은 id에 다른 내용을 쓸 수
없다.** `plan-pilot`을 다시 돌리면 새 id의 새 카드가 생기고 기존 카드는 그대로 남는다.
`pilot`/`run`은 **어댑터를 만들기 전에** `execution-authorizations.jsonl`에 receipt를 append하고,
모든 기록이 `receiptId`를 달고 나온다. 그래서 `attest-p0`는 명령 인자로 받은 카드가 아니라
**기록이 가리키는 receipt**를 정본으로 삼는다. 근거: multi-engine-routing.md 10.10절.

**유료 실행은 Run Card 없이 시작할 수 없다.** `pilot`/`run`은 `--run-card`를 필수로 받고,
어댑터를 만들기 전에 카드 해시·단계·경로·인자·예산·probe evidence·자격증명 binding·만료를
확인한다. 우회 플래그를 추가하지 말 것.

**exact-model 검증은 호출별 응답 envelope만 본다.** `DraftProposal.model`/`ReviewDecision.model`은
어댑터가 `this.modelId`를 넣은 값이라 비교하면 항상 통과한다 — 조용한 대체를 잡지 못한다.
기록의 `providerCalls[*].providerReportedModelId`를 쓰고, alias는 prefix 비교가 아니라
`ModelEntry.acceptedProviderModelIds` 목록으로 다룬다(10.8절). 역할 배정은 arm마다 다르므로
(Arm B는 anthropic 하나뿐이라 reviewer 모델이 executor 자리에 앉는다) 배정 규칙은
`arms.ts`의 `modelForRole` 하나에만 둔다.

**exact-model 검증은 응답 envelope만 본다.** `DraftProposal.model`/`ReviewDecision.model`은
어댑터가 `this.modelId`를 넣은 값이라 비교하면 항상 통과한다 — 조용한 대체를 잡지 못한다.
`ProviderResponse.meta.providerReportedModelId`를 쓰고, alias는 prefix 비교가 아니라
`ModelEntry.acceptedProviderModelIds` 목록으로 다룬다(10.8절).

**fake provider 결과로 가설을 판정하지 않는다** — 모든 기록에 `providerKind`가 남고, 집계가
`fake` 기록만 있으면 무조건 `INCONCLUSIVE`를 낸다. 자세한 것은
[evals/hypothesis-gate/README.md](./evals/hypothesis-gate/README.md).

**단, 그 규칙이 지키는 것은 *모델 출력에 의존하는 판정*이다.** TRIAGE 임계값은 거기 해당하지
않는다(규칙 기반이라 모델을 부르지 않는다) — 그래서 `triage-calibration`은 fake 공급자로 재고,
**해당하지 않는다는 사실을 주석이 아니라 이벤트 순서로 증명한다**: `TRIAGE_COMPLETED`가 첫
`PROVIDER_USAGE`보다 앞서야 하고, 공급자 호출이 아예 없으면 그 비교는 공허하므로 증명으로
치지 않는다. 새로 "fake로 재도 되는" 측정을 만들면 같은 증명을 함께 만들 것.

### Rust 쪽 — **반드시 이 패턴을 쓸 것**

이 환경에서 `cargo`를 직접 호출하면 실패한다. 두 가지 이유가 겹친다:
1. `cargo`/`rustc`가 새 셸의 PATH에 없다(winget 설치 후 PATH가 기존 세션에 반영되지 않음)
2. MSVC 링커 환경변수(INCLUDE/LIB)가 없으면 컴파일은 되지만 **링크 단계에서 실패**한다

**모든 cargo 호출은 `scripts/cargo.mjs` 런처를 지난다.** 루트 `npm run core:build`도,
`.bat` 래퍼도 마찬가지다 — 한때 `.bat`만 `_env.bat`을 call해서 **단계 순서는 같은데 환경 준비
의미가 다른** 상태였고, 그래서 `scripts\verify.bat`은 통과하는데 일반 PowerShell의
`npm run verify`는 `stdarg.h: No such file or directory`로 죽었다. 진입점이 둘이면 반드시 갈라진다.

런처는 컴파일이 필요 없는 일반 JavaScript다(`packages/toolchain/js/exec.mjs`를 import한다).
TypeScript로 두면 "Rust를 빌드하려면 TypeScript를 먼저 빌드해야 한다"는 순환이 생긴다.

| 스크립트 | 하는 일 |
|---|---|
| `scripts\_env.bat` | MSVC 툴체인 + cargo PATH 준비. **Visual Studio 탐지는 여기에만 있다** |
| `scripts\msvc-doctor.bat` | MSVC 탐지 진단 — 무엇을 어디까지 확인했는지 읽기 전용으로 출력. `npm run msvc:doctor` |
| `scripts\assertDepsFresh.mjs` | 의존 워크스페이스의 `dist`가 소스보다 낡았는지 확인. 낡은 `.d.ts`로 컴파일해 원인과 먼 오류가 쏟아지는 것을 막는다 |
| `scripts\cargo.mjs` | cargo 실행 런처 — MSVC 환경 준비 + cargo 실행 파일 탐색 + 종료 코드 보존. 나머지 cargo 진입점이 전부 이걸 지난다 |
| `scripts\cargo-test-core.bat` | 신뢰 경계 크레이트 테스트 (가장 자주 도는 검증) |
| `scripts\cargo-build-core.bat` | `tomverse-host` 빌드 — e2e가 이 산출물을 요구한다 |
| `scripts\cargo-check-desktop.bat` | Tauri 껍데기 크레이트 `cargo check` |
| `scripts\msvc-env.bat` | `_env.bat`을 call한 뒤 **필요한 변수만** 출력. `set`으로 전체를 덤프하면 API 키가 버퍼에 들어간다 |
| `scripts\stage-sidecar.mjs` | 동봉 sidecar 스테이징 — 핀된 node.exe + sidecar dist + production 의존성. 끝나면 **그 트리로 sidecar를 실제로 띄워** ping 왕복을 받는다(잘라내기의 안전망). `npm run sidecar:stage` |
| `scripts\pin-node-runtime.mjs` | 동봉 런타임 핀 회전. **gpg가 필요하다** — 빌드는 아니다(10.6절) |
| `scripts\tauri-build.bat` | Windows 배포 번들(.msi/.exe). 프런트엔드 빌드와 **sidecar 스테이징**을 먼저 돌린다 — `bundle.resources`가 가리키는 디렉터리를 그 단계가 만들기 때문이다 |
| `scripts\verify.bat` | 전체 검증 (Node 빌드/타입/테스트 + Rust + e2e). 하나라도 실패하면 즉시 멈춘다. **`_env.bat`을 call하지 않는다** — 미리 준비해 버리면 루트 `verify`와의 차이가 다시 감춰진다 |

`tauri-build.bat`을 `verify.bat`에 넣지 않은 이유: 번들 빌드는 훨씬 오래 걸려서 매번 도는
검증에 섞으면 개발 루프가 느려진다. 릴리스 전에 따로 돌린다.

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
- **Visual Studio 설치 경로를 후보 목록으로 쫓아가려 하지 말 것.** 실측 사례는
  `D:\Program Files\Microsoft Visual Studio\18\Enterprise` 였다 — 드라이브도, 버전
  디렉터리(`2022`가 아니라 `18`)도, 에디션도 하드코딩 후보와 전부 달랐다. 설치 위치는
  사용자가 고르는 값이라 목록으로는 영원히 못 따라잡는다. `_env.bat`은 **vswhere.exe**로
  묻는다(Installer가 `%ProgramFiles(x86)%\Microsoft Visual Studio\Installer`에 항상 둔다).
  참고로 `cc-rs`는 자체 vswhere 탐지로 `cl.exe`를 **찾아낸다** — 그래서 증상이
  "컴파일러 없음"이 아니라 `stdarg.h: No such file or directory`(=INCLUDE 미설정)로 나온다.
- **vswhere도 만능이 아니다.** Visual Studio가 설치된 머신에서 `vswhere.exe가 없습니다`가 나온
  실측 사례가 있다(Installer 디렉터리를 두 고정 위치에서 못 찾음). 그래서 탐지를 네 겹으로 둔다:
  `TOMVERSE_VCVARSALL` override → vswhere(고정 2곳 + PATH) → `VSINSTALLDIR` →
  `Microsoft Visual Studio` 서브트리 **검색**(목록이 아니다). 그리고 전부 실패하면 **확인한 것을
  전부 출력한다** — "설치되어 있지 않은 것으로 보입니다"만 말하면 설치되어 있는 사용자가 할 수
  있는 일이 없다. 상태를 보려면 `npm run msvc:doctor`.
- **vswhere에 `-latest`를 쓰면 쓸 수 있는 설치를 놓친다.** 실측 머신에 설치가 둘 있었고
  **최신(VS 18 Enterprise)에 C++ 빌드 도구가 없었다** — 도구가 있는 것은 더 오래된
  2022 BuildTools였다. `-latest`는 가장 새 설치 하나만 주므로 그것이 쓸 수 없으면 나머지를
  보지 않고 실패한다. `-all`로 전부 받아 **`vcvarsall.bat`이 실제로 있는** 첫 항목을 쓸 것.
  `-requires`도 최종 판정이 아니다 — 새 버전이 컴포넌트 ID를 바꾸면 빗나간다. 파일 존재가 정본이다.
- **콘솔에 직접 쓰는 `.bat`은 한글이 깨진다.** npm/node 파이프를 거치는 출력은 UTF-8로 나오지만,
  `cmd /c script.bat`처럼 콘솔에 직접 쓰면 코드 페이지(949/437)로 해석되어 읽을 수 없다.
  진단 스크립트는 목적이 "읽히는 것"이므로 `chcp 65001`로 바꾸고 **끝나면 되돌린다**
  (chcp는 `setlocal`로 스코프되지 않는다).
- **괄호가 든 변수 이름을 괄호 블록 안에서 쓰면 cmd 파서가 블록을 일찍 닫는다.**
  `%ProgramFiles(x86)%`가 그렇다. `if ... (` 안에서 쓰기 전에 평범한 이름으로 옮길 것.
  `echo` 텍스트의 괄호도 `^(`/`^)`로 escape한다.
- **Git for Windows의 GNU `link.exe`가 MSVC `link.exe`를 PATH에서 가린다.** Rust 링크 실패 시 `link: extra operand ... Try 'link --help'`가 나오면 이건 MSVC가 아니라 **coreutils의 하드링크 유틸리티**가 호출된 것이다. rustc가 붙이는 "Visual Studio에서 C++ 빌드 도구를 선택하라"는 힌트는 이 경우 오도할 수 있다. `vcvarsall.bat`를 거치면 MSVC 경로가 앞에 오므로 해결된다.
- **Bash를 먼저 잡는 습관을 경계할 것.** 이 저장소에서 Windows 네이티브 툴체인(MSVC/MSBuild/VS)을 다룰 때는 PowerShell + `.bat` 래퍼가 기본이다. Bash(MinGW)를 쓰면 위 `link.exe` 같은 Unix 도구 충돌에 걸린다 — 이 편향은 product-strategy.md 12.3절이 우리 제품에서 구조적으로 교정하려는 대상이기도 하다.
- **파일이 LF로 저장되면 git이 CRLF 경고를 낸다** — 정상이며 무시해도 된다. 단 `.bat`만은 예외로 CRLF를 강제한다(`.gitattributes`).
- **`record_*_with_event` 계열은 `append_event`를 거치지 않는다.** 레코드와 이벤트를 한 트랜잭션에 쓰기 위한 설계인데, 그 대가로 **sink(UI) 릴레이가 빠진다.** DB에는 남는데 화면에는 안 보이는, 찾기 어려운 종류의 누락이다. 새로 이런 메서드를 만들면 커밋 후 `TaskHost::relay`를 반드시 부를 것.
- **Windows의 `npm`은 `npm.exe`가 아니라 `npm.cmd`다.** `Command::new("npm")`/`spawnSync("npm")`은
  `program not found`로 실패한다. 증상이 고약한 이유는 그 다음이다 — Verification Runner가
  테스트를 못 돌려 `SKIPPED_WITH_REASON` → `could_not_run`이 되고, **정상 수정 작업이 검증 없이
  완료로 보고**된다. `tools/program.rs`(제품)와 `@tomverse/toolchain`의 `resolveNodeCli`(테스트
  하네스)가 각각 이걸 처리한다. 둘을 섞지 말 것 — e2e 본체는 반드시 논리 명령 `npm test`를
  Rust에 요청해야 해석 계층이 실제로 검증된다.
- **`std::path`와 Node의 `path`는 실행 중인 OS의 구분자만 안다.** Linux에서
  `Path::new(r"C:\a\b").parent()`는 `""`를, `path.join("C:\\a", "b")`는 `C:\a/b`를 준다.
  Windows 분기를 Linux에서 검증하려면 경로 조작을 **대상 플랫폼 기준으로** 해야 한다
  (`path.win32` / 문자열 직접 처리). 이걸 안 해서 `.exe` 결함이 살아남았다.
- **`new URL(import.meta.url).pathname`은 Windows에서 깨진다.** 드라이브 문자 앞에 슬래시가
  붙어 `/C:/Users/...`가 되고, `path.resolve`가 그걸 이어붙이면 존재하지 않는 경로가 된다.
  **`fileURLToPath`만 쓸 것** — 플랫폼별 규칙을 아는 유일한 변환이다. 증상이 고약한 이유는
  경로가 깨지면 fixture/파일 목록이 **조용히 0개**가 되어 그 위의 검사들이 빈 집합에 대해
  통과하거나 원인과 먼 실패를 내기 때문이다. 그래서 `listFixtureIds`는 디렉터리가 없으면
  빈 배열이 아니라 예외를 던진다 — "없는 경로"와 "빈 디렉터리"는 다른 사실이다.
- **`exports` 맵 안에 `"//"` 주석 키를 두면 서브패스 import가 전부 깨진다.** `package.json`의
  `exports`는 키가 모두 `.`로 시작해야 하고, 하나라도 아니면 **맵 전체가 무효**가 된다.
  증상이 고약한 이유는 오류가 그 파일을 가리키지 않는다는 점이다 — `@tomverse/sidecar/budget`을
  import하는 **모든 파일**에서 `TS2307 Cannot find module`이 나므로, 방금 고친 코드나
  빌드 순서를 의심하게 된다. 주석은 `exports` **밖에** 둘 것(루트의 `"//exports"`).
- **`createBudgetLedger(limit)`를 재개 때 새로 만들면 승인 한도가 재시작마다 초기화된다.**
  `committed`가 0에서 시작하므로 $25 한도에서 $20을 쓴 뒤 재개하면 $25를 더 쓸 수 있었다.
  이미 쓴 금액을 복원해 `initialCommittedUsd`로 넘겨야 하고, 상한과 비교하는 값은 이번 프로세스의
  지출이 아니라 **누적**이다. 지출을 `spentUsd` 하나로 부르면 로그에서 그 숫자가 session인지
  전체인지 구별되지 않으므로 이름을 셋으로 나눈다(historical/session/cumulative).
- **`String.raw` 템플릿은 trailing backslash로 끝낼 수 없다.** 백틱을 escape해 버려서
  `String.raw`C:\temp\`` 는 문자열이 닫히지 않는다. 그리고 trailing backslash는 Windows 경로
  인용 테스트가 **반드시 확인해야 하는 경우**다 — 백슬래시를 이중화한 일반 문자열을 쓸 것.
- **CLI를 하위 프로세스로 돌리는 테스트에 Rust fixture를 쓰지 말 것.** preflight는 Rust
  fixture가 하나라도 있으면 MSVC를 요구하고 없으면 blocker로 막는데, 그 차단이 **검증하려는
  게이트보다 먼저** 일어난다. Visual Studio가 없는 Windows에서 "카드가 없어서 거부"를 기대한
  테스트가 "MSVC가 없어서 거부"로 실패했다 — Linux는 `not_needed`를 주므로 드러나지 않는다.
  fixture를 TypeScript로 좁히고, **"네이티브 fixture 0개"를 테스트가 확인**해서 나중에 Rust가
  다시 섞이면 Linux에서도 실패하게 할 것.
- **소스를 검사하는 테스트는 자기 자신을 센다.** 검사 대상 토큰을 assertion 안에 그대로 적으면
  개수 비교가 언제나 어긋난다. needle을 런타임에 조립하거나(`"foo" + "("`) 괄호 깊이로 호출
  범위를 잘라낼 것.
- **한 워크스페이스만 빌드하면 낡은 `.d.ts`에 대해 컴파일된다.** 워크스페이스들은 서로의
  **`dist`** 에 대해 타입 검사하므로(위 "검증 순서" 절), `git pull`로 sidecar 공개 타입이 바뀐
  직후 `npm run gate:g:*`이나 `npm test --workspace=@tomverse/hypothesis-gate`를 돌리면
  **예전 `.d.ts`** 를 읽는다. 실측으로 `TS2305 has no exported member`가 71개 나왔고, 그 오류는
  원인을 가리키지 않는다 — 방금 받은 코드가 잘못됐다고 읽힌다. 이제 두 겹으로 막는다:
  루트 `gate:g:build`가 체인을 함께 빌드하고, dist를 소비하는 워크스페이스의 `build`가
  `scripts/assertDepsFresh.mjs`로 산출물 신선도를 먼저 확인한다. 두 장치를
  `packages/toolchain/test/buildOrder.test.ts`가 지킨다.
- **동시에 두 공급자 호출을 띄우면 "정확히 한 번" 가드가 깨진다.** `terminalReached`를 검사한 뒤
  `await`를 하고 나서 플래그를 세우면, 두 호출이 취소될 때 **둘 다 검사를 통과**해
  `TASK_CANCELLED`가 두 번 기록된다(대조로 executor를 둘 부르면서 실측). JS가 단일 스레드라는
  것은 위안이 되지 않는다 — `await`가 곧 양보 지점이다. 검사와 표시 사이에 `await`를 두지 말 것.
- **fake provider의 스크립트는 어댑터 인스턴스별로 소비된다.** 그래서 `script` 하나로 두 실행자를
  다르게 만들 수 없다 — 둘 다 처음부터 소비해 **언제나 같은 산출물**이 나오고, 대조 테스트가
  아무것도 검증하지 못한 채 통과한다. 모델별로 나누려면 `scriptByModel`을 쓸 것. 같은 이유로
  `proposalId`에도 모델 ID가 들어간다(둘 다 cursor가 1이라 id가 겹쳤다).
- **`ToolStatus::Ok`은 "명령이 성공했다"가 아니다.** `run_command`는 0이 아닌 종료 코드를 "도구 실행 실패"가 아니라 **"명령이 실패했다"는 사실**로 다뤄 `status`를 `Ok`로 두고 `exitCode`만 남긴다(검증 러너가 그 구분을 필요로 하기 때문이다). `status`만 보고 성공을 판정하면 **실패한 명령이 성공으로 읽힌다** — `revert_commit`이 실제로 그랬고, "tip 커밋만 되돌린다"는 우연한 조건이 그 결함을 가리고 있었다. git 호출은 `git_try`가 `(성공, stdout, stderr)`로 감싸고 성공 판정은 `exitCode == 0`이다.
- **소스에 리터럴 NUL 문자를 박으면 그 파일이 검색에서 통째로 사라진다.** `join("\0")`처럼 구분자로 쓸 일이 있는데, grep·ripgrep 계열이 그 파일을 **바이너리로 분류해 결과에서 빼기** 때문에 파일을 찾는 사람에게는 없는 것과 같다. git은 텍스트로 다루므로 diff에서는 드러나지 않아 더 오래 남는다. `\u0000` 이스케이프를 쓸 것 — 의미는 같고 소스는 ASCII로 남는다.
- **Windows 전용 코드를 이 환경에서 타입 검증할 수는 있지만, `tomverse-core` 전체는 안 된다.** `rustup target add x86_64-pc-windows-msvc` 뒤 `cargo check --target x86_64-pc-windows-msvc`는 순수 Rust 크레이트(`windows-sys` 등)에는 통하지만, core는 `rusqlite`의 bundled SQLite가 `lib.exe`를 요구해 `failed to find tool "lib.exe"`로 멈춘다. Windows 코드 조각을 검증하려면 그 조각만 담은 별도 크레이트에서 검사할 것. **그리고 타입 검증은 동작 검증이 아니다** — Win32에서 컴파일되는 코드가 틀리는 흔한 방식은 핸들 수명이고, 그건 실행해야만 드러난다.
- **`JSON.stringify(v, Object.keys(v).sort())`는 중첩 객체를 통째로 지운다.** array replacer는
  property whitelist이고 그 whitelist가 **모든 깊이에** 적용되므로, 최상위 key만 넣으면 중첩
  객체가 전부 `{}`가 된다. 승인 아티팩트의 해시가 이 방식이었고, 그래서 `models.executor.modelId`,
  `stage.fixtureIds`, `fixtureHashes[*].hash`, attestation의 `checks[*]`를 **아무리 바꿔도 해시가
  그대로였다.** 증상이 고약한 이유: 검증은 통과하고 아무 오류도 나지 않으므로, 해시가 있다는
  사실이 곧 "지켜진다"로 읽힌다. 정규 직렬화는 `evals/hypothesis-gate/src/canonical.ts` 하나를 쓴다.
- **HTTP 상태 분류(429/5xx/auth)는 dispatch 사실이 아니다.** 429나 5xx를 받았다는 것은 요청이
  공급자에게 **도달했다**는 뜻이므로 "요청이 나가지 않았다"의 근거가 되지 못한다. 실측 시나리오:
  executor가 성공해 과금된 뒤 reviewer가 5xx로 죽으면, 실패 분류를 먼저 하고 DB를 읽지 않는
  순서 때문에 `providerCallCount=0`이 되고 → `not_dispatched` → **예약 전액 해제**로 이미 쓴 돈이
  승인 예산에서 사라졌다. host가 실패했든 아니든 **DB 이벤트를 먼저 읽는다.**
- **`readEvents`가 실패를 빈 배열로 돌려주면 "이벤트가 없다"와 "못 읽었다"가 같아진다.** 앞은
  호출이 없었다는 뜻이고 뒤는 모른다는 뜻인데, 뒤를 앞으로 읽으면 예약을 해제하게 된다.
  `eventsReadable`을 별도 축으로 남긴다.
- **HMAC은 비밀값을 키로 써야 의미가 있다.** credential binding이 salt를 HMAC 키로, API 키를
  메시지로 쓰고 있었다. salt는 공개값이므로 그 배치에서는 "키를 모르면 다이제스트를 만들 수 없다"가
  성립하지 않는다. 키를 HMAC 키로, 나머지를 메시지로 쓴다.
- **저장소 안에서 만든 번들은 "떴다"만으로 검증되지 않는다.** Node의 모듈 해석은 찾을 때까지
  상위 디렉터리를 거슬러 올라가므로, `apps/desktop/src-tauri/bundle/` 아래의 번들은 자기
  `node_modules`가 비어 있어도 **저장소 루트의 것을 집어 정상 동작한다.** 설치본에는 그 상위가
  없으니 거기서만 죽는다. 실측으로 확인했다 — 번들에서 grammar 하나를 지워도 적재가 성공했다.
  판정 기준은 "해석되는가"가 아니라 **"번들 안으로 해석되는가"**여야 한다
  (`scripts/stage-sidecar.mjs`의 `resolutionSmoke`).
- **`tauri.conf.json`에는 `"//"` 주석 키를 둘 수 없다.** tauri의 스키마가
  `additionalProperties`를 **어느 깊이에서도** 막으므로 `bundle` 안에 두든 최상위에 두든
  `Additional properties are not allowed ('//resources' was unexpected)`로 빌드가 죽는다.
  `package.json`의 `exports`와 증상이 반대다 — 저쪽은 조용히 깨지고 이쪽은 요란하게 멈춘다.
  동봉 설정의 근거는 `process-architecture.md` 10.6절과 `scripts/stage-sidecar.mjs` 머리말에 있다.
- **`path.join("C:", "repo")`는 절대 경로가 아니다.** Windows에서 그건 `C:repo`(드라이브
  **상대** 경로)가 되어 `path.relative`가 전혀 다른 답을 낸다. 테스트 픽스처에서 이걸 쓰면
  Linux에서는 통과하고 Windows에서만 실패한다. 실행 중인 OS의 규칙으로 절대 경로를 만들려면
  `path.resolve(path.sep, "...")`를 쓸 것.
- **경로를 나누는 정규식의 `[\\/]`는 한 겹 벗겨지기 쉽고, 벗겨지면 Windows만 조용히 깨진다.**
  `/[\/]/`가 되면 `\`로 이어진 경로가 **하나도 나뉘지 않아** 모든 항목이 "경로가 아니다"로
  걸러진다 — 스테이징에서 실제로 그렇게 됐고, 계획은 성공을 돌려주고 복사할 것만 0개가 됐다.
  `sidecarStage.mjs`의 `splitPath`처럼 `path.sep`과 `/`를 명시적으로 쪼개는 함수를 쓸 것.
- **프로세스 전역 카운터를 `==`로 비교하는 테스트는 병렬 실행에서 간헐적으로 깨진다.**
  `cargo test`는 **한 프로세스 안에서** 테스트를 병렬로 돌리므로, `before`를 읽고 무언가를
  한 뒤 `before + 1`과 같은지 보면 그 사이에 다른 테스트가 같은 카운터를 올릴 수 있다.
  `verify.rs`의 레인 계측이 그랬고 실측으로 `left: 4 / right: 3`으로 실패했다 —
  같은 파일의 이웃 테스트가 스레드 4개로 레인을 지나기 때문이다. 카운터가 줄지 않는다면
  `>=`가 확인하려는 사실("이 호출이 계측을 지났다")을 정확히 말한다.
  **간헐적이라서 더 나쁘다**: `verify`가 가끔 빨간색이 되면 사람이 "다시 돌려 보자"를 배우고,
  그 습관이 진짜 회귀를 지나가게 만든다.
- **SQLite 뷰에는 `rowid`가 없다.** `tool_executions`처럼 뷰를 조회할 때 `ORDER BY rowid`는 런타임 오류다 — 정렬 기준이 될 컬럼을 뷰에 포함시켜야 한다.
- **껍데기 크레이트를 이 환경에서 검사할 수 없다는 것은 사실이 아니었다.** GUI **개발
  라이브러리**(`libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`)를 설치하면 `npm run desktop:check`가 Linux에서 그대로 돈다. 빌드 스크립트가
  `bundle/sidecar`(스테이징 산출물)를 요구하므로 **디렉터리만 있으면** 되고(`mkdir -p`),
  핀된 node.exe는 타입 검사에 필요 없다. 몰라서 치른 대가가 있다 — 껍데기가 **컴파일되지
  않는 채로** 커밋돼 있었다(`restart_task`가 13개를 받는 `start_task`에 11개를 넘기고 있었다).
  소스를 읽는 검사는 그 종류를 잡지 못한다: 인자 개수는 글자가 아니라 타입의 문제다.

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
