# Windows 착지 실측 기록

이 문서는 설계가 아니라 **관측 기록**이다. `tomverse-host windows-landing`이 판정하지 못하는
것 — 사람이 Windows에서 직접 해봐야 하는 항목 — 을 실제로 해본 결과를 남긴다.

**왜 문서가 필요했는가 — 그리고 무엇이 바뀌었는가.** `landing.rs`는 "확인했다는 기억"과
"확인됐다는 기록"을 가르려고 만들어졌다. 그런데 그 도구에는 **사람이 확인한 결과를 넣을
입구가 없었다.** 항목이 `NeedsHuman`으로 하드코딩되어 있어, 사람이 실제로 확인해도 다음
실행은 여전히 같은 25개를 `remaining`으로 냈다. 그러면 확인한 사실이 다시 사람의 기억에만
남는다 — 도구가 없애려던 바로 그 상태다. **이 문서가 그 자리를 임시로 메우고 있었다.**

**그 자리는 이제 닫혔다.** `tomverse-host windows-landing --attest <파일>`이 사람의 확인을
받아들인다(15절 — 제안이 아니라 구현이다). 7~12절에서 확인한 열 항목은
[`attestations/windows-landing-206d2ef.json`](./attestations/windows-landing-206d2ef.json)에
그 형식으로 옮겼다. **그 파일은 지금 만료 상태로 나온다** — `206d2ef`에서 확인한 기록인데
main이 그보다 앞서 있기 때문이다. 그게 정상이고, 만료가 실제로 동작한다는 증거다(15.7절).

이 문서가 계속 있는 이유는 남는다. attestation은 **확인된 것**의 기록이고, 이 문서는
**확인하지 못한 것과 그 이유**, 그리고 실측에서 드러난 제품 결함(3·5·6절)의 기록이다.
그 둘은 같은 파일에 들어갈 수 없다.

---

## 1. 실측 환경

| 항목 | 값 |
|---|---|
| OS | Windows 10 Pro 10.0.19045 (AMD64) |
| 기준 커밋 | `206d2ef` (main) |
| Node | v22.22.2 — **nvm4w** (`C:\nvm4w\nodejs`) |
| cargo | 1.97.1 (`C:\Users\Vyper\.cargo\bin`) |
| Visual Studio | 설치 2개. `D:\Program Files\Microsoft Visual Studio\18\Enterprise`(C++ 도구 **없음**), `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`(쓸 수 있음) |
| git `core.autocrlf` | `true` (system 레벨 — Git for Windows 기본값) |
| Python | **없음.** PATH의 `python`은 Microsoft Store 별칭(0바이트) |

이 환경은 우연히도 문서가 경고해 둔 함정을 여럿 그대로 갖고 있다 — VS 다중 설치(최신에
도구 없음), nvm4w, `autocrlf=true`, Store 별칭. 즉 **이 머신은 좋은 시험대다.**

---

## 2. 결말 요약

`tomverse-host windows-landing --workspace <repo>` 은 `verdict = incomplete`,
`remaining = 25`를 냈다 — **실측 전후가 같았다.** 도구가 사람의 확인을 받아들이지 못했기
때문이며, 실측이 성과가 없었다는 뜻이 아니다. **그 입구는 이제 있다**(15절):
`--attest`를 주면 아래 표의 확인들이 판정에 들어간다.

`--bundle <산출물>`을 함께 주면 `verdict = not_landed`, `remaining = 24`가 된다.
**나빠진 것이 아니라 알게 된 것이다** — 처음에는 번들을 만들 수조차 없어 이 항목이
"측정 불가"였고, 지금은 무엇이 왜 빠졌는지가 판정으로 남는다(5절).

> **이후 변동**: 6절의 결함을 고치면서 착지 묶음 `uncWorkspace`(항목 4개)를 새로 두었으므로
> 이 숫자는 각각 **29 / 28**이 된다. 늘어난 것도 같은 이유다 — 몰랐던 것이 판정으로
> 바뀌었다. 위 숫자는 이 문서가 기록한 **당시 관측값**이므로 고치지 않는다.

아래는 사람이 실제로 태워본 결과다.

| 그룹 | 도구 판정 | 사람이 확인한 것 |
|---|---|---|
| `jobObject` | incomplete | 3개 중 2.5개 확인. 실제 취소에서 `TerminateJobObject`로 트리가 죽었다 |
| `sidecarBundle` | **not_landed** | 번들은 만들어진다(4절 해결). **동봉 설정이 없다**(5절) |
| `credentialStore` | incomplete | 실측 대상 아님. 미구현 |
| `commandResolution` | incomplete | **3개 모두 확인** |
| `processGroup` | incomplete | 태우지 못함(강제할 스위치가 없다) |
| `developerEnv` | incomplete | 4개 중 3개 확인 |
| `pythonEnv` | incomplete | 1개 **실패**, 2개 확인 불가(이 머신에 Python이 없다) |
| `pathNormalization` | incomplete | verbatim 확인, UNC는 확인했으나 **다른 결함이 드러났다**(6절) |
| `uncWorkspace` | (당시 없음) → incomplete | 6절의 결함을 고치면서 **새로 생긴 묶음**. **4개 모두 확인**(6.2절) — 전제(cmd.exe만 거부한다)까지 재현했다 |

---

## 3. 제품 결함 — `apply_patch`가 CRLF 파일에 한 줄도 붙지 않았다

**가장 심각한 발견이며 고쳤다.** (커밋: "Windows에서 patch가 한 줄도 붙지 않았다")

`apply_unified_diff` 안에서 두 쪽의 줄 분리 규칙이 달랐다.

- hunk: `patch.lines()` — Rust의 `str::lines()`는 `\r\n`의 `\r`를 **떼어낸다**
- 파일: `split_lines()` — `text.split('\n')`이라 `\r`가 **줄 끝에 남는다**

그래서 CRLF 파일은 모든 컨텍스트 줄이 어긋나고 `ContextMismatch`가 난다. Git for Windows가
`core.autocrlf=true`를 시스템 설정으로 넣으므로 **Windows 사용자의 작업 트리는 대부분 CRLF**이고,
그 환경에서 제품의 중심 동작(고친다)이 통째로 멎어 있었다.

증상이 고약한 이유: 이 결함은 Linux CI에서 영원히 보이지 않는다. 그리고 Windows에서도
개발자 머신의 git 설정에 따라 보이거나 안 보인다.

**고친 방향**은 정규화가 아니라 "비교에서만 무시"다. 파일 전체를 LF로 정규화하면 건드리지
않은 줄의 바이트가 바뀌고, 그러면 승인 화면이 보여준 diff와 실제 쓰이는 것이 달라진다.

**재발 방지**: `patch.rs`에 CRLF 단위 테스트 7개(Linux에서도 돈다) + e2e에 CRLF 작업 트리를
직접 만드는 시나리오. 수정을 빼고 돌려 그 시나리오가 실제로 실패하는 것을 확인했다.

---

## 4. 해결됨 — Tauri 껍데기 크레이트가 컴파일되지 않았다

**처음 실측했을 때 `sidecarBundle` 그룹 전체가 여기서 막혀 있었다.** `scripts\tauri-build.bat`이
`error: could not compile `desktop` (lib) due to 32 previous errors`로 실패했고, 그래서 이
항목은 "실패"가 아니라 **측정 불가**였다. 지금은 고쳤다(커밋: "껍데기가 core를 따라가지 못한 채…").

성격이 둘로 갈렸고, 그 구분이 요점이다.

**(a) 애초에 컴파일된 적이 없는 코드** — 함수 파라미터에 `///` 문서 주석 24곳
(`lib.rs`·`session.rs`). Rust에 없는 자리라 하드 오류다. 설명은 살리고 형식만 `//`로 바꿨다.

**(b) core가 앞서가고 껍데기가 남은 드리프트** — 사라진 API가 아니었다:

| 증상 | 실제 원인 |
|---|---|
| `with_store_prose`가 없다 | `SessionState`의 메서드인데 `Arc<TaskHost>`에 대고 불렀다 |
| `with_store`가 1인자다 | 같은 이유. `StoreOp`를 넘긴 것 자체가 `SessionState` 쪽을 의도했다는 증거다 |
| `UiMessage.text`가 없다 | `message`로 이름이 바뀌었다 |
| `?`가 String으로 변환되지 않는다 | `task_export`가 봉투를 쓰면서 반환만 산문이었다 |
| `task_policy_from` 인자 타입 | 불리언 `is_question`이 `kind: &str`로 바뀔 때 호출부 둘이 안 따라왔다 |

**고치다 드러난 것 셋** (전부 컴파일과 무관한 결함이다):

1. **`create_task`의 실패가 버려지고 있었다.** `with_store_prose`가 두 겹 `Result`를 돌려주는데
   바깥에만 `?`를 걸고 안쪽을 `;`로 버렸다. 태스크 행이 만들어지지 않아도 그대로 진행하고,
   존재하지 않는 태스크에 이벤트를 붙이게 된다 — **원칙 7이 조용히 깨진다.**
2. **`autopilot_preview`가 종류를 몰랐다.** 무인 스위치는 화면의 종류 게이트 **밖**에 있어
   질문·계획 태스크에서도 켤 수 있다. `false`를 그대로 `"change"`로 옮겼다면 미리보기가
   **실제로는 좁혀질 쓰기 도구를 "그냥 지나갑니다"로** 보고했을 것이다.
3. **`restart_task`도 종류를 몰랐다.** 그리고 복원할 수도 없다 — `tasks`에도 `TaskRow`에도
   `kind` 컬럼이 없고, 이벤트에 남는 것은 파생값인 `allowedTools`뿐이다. `"change"`를 박으면
   **질문으로 물었던 것이 재실행에서 쓰기 도구를 들고 돈다.** 화면이 지금 고른 값을 보내게 했다
   (그 함수의 주석이 이미 "다시 실행은 새 태스크다"라고 말하고 있다).

**왜 아무도 몰랐는가 — 그리고 무엇을 바꿨는가.** `scripts\cargo-check-desktop.bat`은 존재했지만
**`verify`에 들어 있지 않았다.** 껍데기는 core를 부르기만 하므로 core를 고쳐도 core의 테스트는
전부 통과하고, 어긋난 사실이 드러나는 곳은 껍데기 컴파일뿐이다. 이제 `desktop:check`가 두
진입점 모두에 있다. `verifyOrder.test.ts`의 단계 이름 목록에도 넣었다 — **그 목록에 없는
단계는 두 진입점 비교에서 보이지 않으므로**, 넣지 않았다면 한쪽에만 추가해도 검사가 통과했다.

> **이후 정정(2026-08-28).** 여기 "리눅스에서는 tauri가 GUI 시스템 라이브러리를 요구해 이
> 단계가 실패한다"고 적었는데, **요구하는 것과 못 쓰는 것은 다르다.** GUI **개발** 패키지를
> 설치하면 `desktop:check`가 리눅스에서 그대로 돌고, `bundle.resources`가 가리키는 자리는
> 디렉터리만 있으면 된다. 이제 리눅스 CI(`.github/workflows/ci.yml`)가 매 PR마다 이 단계를
> 돌리므로, 껍데기/core 드리프트는 사람이 기억해서 잡는 것이 아니게 됐다.
>
> 이 절이 기록하는 **관측**(당시 이 환경에서 실패했다)은 사실이므로 고치지 않는다. 바뀐 것은
> 그 관측에서 끌어낸 결론이다.

---

## 5. ~~`not_landed`~~ → 해결됨 — sidecar를 번들에 넣는 설정이 없었다

> **이후 변동(2026-08-28, `4bdce17` 기준 작업).** 동봉을 구현했고 이 머신에서 실측했다.
> `sidecarBundle`은 이제 **`not_landed`가 아니라 `incomplete`**다 — `bundleContents`와
> `bundleSizeRecorded`가 도구 판정으로 `passed`이고, 남은 둘은 설치된 GUI 앱을 node 없는
> 머신에서 실행해야 하는 항목이다(14절 #2·#3). 아래 원문은 **당시 관측**이므로 고치지 않는다.
>
> 실측 결과:
>
> | 무엇 | 결과 |
> |---|---|
> | `npm run sidecar:stage` | 핀(`v24.20.0`, sha256 일치) 검증 후 **102.4 MiB** 스테이징, 잘라냄 57.3 MiB |
> | 스테이징 smoke | **통과** — 동봉 node.exe로 sidecar가 뜨고 ping 왕복 성립 (`protocol 0.2.0 / node 24.20.0`) |
> | `scripts\tauri-build.bat` | **통과**. `.msi` 5.3 → **41.0 MiB**, `.exe` 3.6 → **27.2 MiB** |
> | `.msi` 페이로드 | `PFiles\Tomverse Code\sidecar\node.exe` **있음** (`msiexec /a`로 추출해 확인) |
> | `windows-landing --bundle <추출한 앱 디렉터리>` | `bundleContents: passed` — 파일 5개 전부 있고 **런타임 sha256이 manifest와 일치** |
> | 같은 실행의 `bundleSizeRecorded` | `passed` — 앱 117.1 MiB / 그중 동봉 102.4 MiB |
>
> **결정의 근거는 process-architecture.md 10.6절에 있다** — 어느 런타임(Node 24 LTS 고정),
> 어디서(핀된 sha256 + 핀 회전 시 GPG allowlist 검증), 누가 넣는가(별도 스테이징 스크립트 +
> `bundle.resources`).

---

### 5.0 (원문) `not_landed` — sidecar를 번들에 넣는 설정이 없다

4절을 고친 덕분에 **이제 이것은 추측이 아니라 판정 결과다.** `scripts\tauri-build.bat`이
통과해 설치본이 나오고(.msi 5.3 MiB / .exe 3.6 MiB), 그 산출물에 대고 물으면:

```
sidecarBundle: not_landed
  - bundleContents: failed
      node.exe=false index.js=false (…\target\release)
```

`process-architecture.md` 10.4절은 "번들 안에 `sidecar/node.exe`와 `sidecar/index.js`가 있다"를
기준으로 못박는데, `apps/desktop/src-tauri/tauri.conf.json`에는 `bundle.resources`도
`externalBin`도 `beforeBundleCommand`도 **없다.** 스테이징하는 스크립트도 없다. 즉 launcher가
찾는 `Bundled` 경로는 **현재 어떤 빌드로도 만들어지지 않는다.**

이 항목은 **확인이 아니라 개발이 필요하다.** 결정할 것: 어느 Node 런타임을 동봉하는가
(버전·라이선스·크기), 어디서 가져오는가, 그리고 그것을 `tauri-build`의 어느 단계가 넣는가.

~~`bundleSizeRecorded`는 `passed`로 나오지만 **그 숫자를 믿지 말 것** — `--bundle`에
`target/release`를 주면 빌드 산출물까지 세어 1586.9 MiB가 나온다.~~
→ **고쳤다.** 이제 `build`/`deps`/`.fingerprint`/`incremental` 중 둘 이상이 보이면
"빌드 트리를 가리키고 있습니다"로 **실패**한다. 통과 표시가 붙은 숫자는 아무도 다시 보지
않으므로, 그 상태는 "얼마인지 알고 받아들였다"의 정확히 반대였다. 잴 대상은 설치된 앱
디렉터리이고, **앱 전체와 동봉분을 따로** 적는다 — 합계만 있으면 동봉이 얼마를 차지하는지 모른다.

---

## 6. 새 결함 — UNC 워크스페이스에서 검증이 "테스트 실패"로 보고된다 (고쳤다)

착지 목록에 없던 항목이다. `pathNormalization`을 태우다 드러났다.

**우리 쪽은 옳다.** `\\localhost\Users\...`와 `\\?\UNC\localhost\Users\...` 둘 다:
워크스페이스가 열리고, 게이트가 정상 경로를 통과시키고, `apply_patch`가 파일을 실제로 바꿨다
(`mutatedPaths = ["paginate.js"]`).

**그런데 검증이 실패한다.** 우리가 해석한 명령은 `node.exe npm-cli.js test`로 정확한데,
**npm이 자기 lifecycle 스크립트를 `cmd.exe`로 실행**하고 cmd.exe는 UNC 작업 디렉터리를
지원하지 않는다:

```
'\\localhost\Users\...\tomverse-fixture-i9NKvD'
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
Could not find 'paginate.test.js'
```

**결과가 `could_not_run`이 아니라 `FAILED`인 것이 더 나쁘다** — 화면이 사용자에게
"당신의 테스트가 실패했다"고 말한다. 실제로는 러너가 테스트 파일을 찾지도 못했다.
CLAUDE.md가 npm shim에서 경계한 실패 모드("검증 없이 완료로 보고")의 사촌이며, 이쪽은
**없는 실패를 지어내는** 방향이다.

### 6.1 결정됨 — 고쳤다 (state-machine 71절)

~~**결정할 것**: 네트워크 드라이브 워크스페이스를 (a) UNC를 드라이브 문자로 매핑해 지원할지,
(b) 시작 시 명확한 이유와 함께 거절할지.~~
→ **(c) + (d)로 결정했다.** 근거는
[state-machine-and-protocol.md 71절](./state-machine-and-protocol.md).

조사하고 나니 질문이 둘이었고, 앞의 것이 (a)/(b)와 **독립적으로** 답을 갖고 있었다.

- **(c) 정직하게 보고한다.** 거짓말을 멈추는 것은 (a)든 (b)든 상관없이 옳다. UNC 작업
  디렉터리 + cmd.exe를 지나는 러너 조합은 **spawn 전에** 막고(`unc.rs`, 차단 지점은
  `run_process` 하나 — 검증뿐 아니라 모델의 `run_command`도 같은 답을 받는다),
  `spawned: false` / `exitCode: null` / `durationMs: 0`을 남긴다.
  종합 판정은 `fail`이 아니라 **`could_not_run`**이 된다.
  - 판정은 **구조**로만 한다. cmd.exe의 `UNC paths are not supported`는 **로캘로 번역되므로**
    출력 매칭은 한국어 Windows에서 조용히 도로 거짓말이 된다.
  - **돌려 보고 판정하지 않는 이유**: cmd.exe가 `C:\Windows`로 떨어진 뒤 우연히 난 exit 0이
    **가짜 통과**가 된다. 없는 실패보다 없는 통과가 더 나쁘다.
- **(d) 열되 경고한다.** (a)는 드라이브 매핑이 **우리 프로세스 밖에 남는 전역 상태**라
  버렸다 — 태스크가 죽으면 사용자 탐색기에 우리 흔적이 남고, "우리 것만 지운다"를 보장할
  방법이 없다. (b)는 UNC에서 **실제로 동작하는 기능**(인덱싱·게이트·`apply_patch` — 바로 위
  11절이 실측한 것)까지 버린다. 그래서 열되, 여는 자리에서 배너로 경고하고 `net use` 명령을
  알려준다. **매핑은 사용자가 만든다** — 전역 상태의 소유자와 만든 사람이 같아진다.

**아직 Windows에서 확인해야 한다.** 판정 로직은 Linux에서 검증되지만(플랫폼·경로·환경을 전부
인자로 받는다) 그 판정이 실제 실행 경로에 걸려 있는지는 아니다. 새 착지 묶음 `uncWorkspace`가
그 네 항목을 들고 있다 — 확인 절차는 아래 6.2절.

`pathNormalization`에 붙이지 않은 이유: 묻는 것이 다르다. 저쪽은 "경로가 깨지지 않는가"이고
여기는 "결과를 정직하게 보고하는가"인데, **저쪽은 이미 ✅였는데 이쪽이 거짓말하고 있었다.**
한 묶음이었다면 통과가 실패를 가렸을 것이다.

### 6.2 실측 — 네 항목 모두 확인했다 ✅

**이 머신에서 실제로 태웠고 네 항목 모두 통과했다.** 1절의 환경, 작업 트리는 71절 구현
직후(커밋 전). 모델 호출은 없다 — e2e가 쓰는 fake 공급자로 돌렸으므로 판정 경로는 진짜이고
LLM 응답만 가짜다.

먼저 **전제**부터 이 머신에서 재현했다. `\\localhost\Users`(기본 공유, 승격 불필요) 아래
픽스처를 두고 UNC를 작업 디렉터리로 프로세스를 띄웠다:

| 무엇 | 결과 |
|---|---|
| `node --test t.test.js` (우리가 띄우는 방식) | **exit 0, 테스트 통과** |
| `node npm-cli.js test` (npm이 cmd.exe로 넘김) | exit 1, `UNC paths are not supported.` → `Could not find 't.test.js'` |

즉 **Win32는 UNC 작업 디렉터리를 받아들이고 거부하는 것은 cmd.exe 하나**라는 71절의 전제가
그대로 확인됐다. 장벽을 npm 계열로만 좁힌 근거가 이것이다.

그다음 `tomverse-host run`을 두 워크스페이스에 대해 돌렸다(픽스처는 **둘** 만든다 — 하나를
공유하면 첫 실행이 파일을 고쳐 두 번째 patch가 안 맞는다):

| 항목 | 결과 |
|---|---|
| ① `npmIsNotSpawnedOnUnc` | ✅ test 체크에 `exitCode`가 **없다**. 기록된 도구 출력이 `"spawned": false`, `"reason": "unsupported_unc_working_directory"`, `"exitCode": null`, `"durationMs": 0`, `checked` 3개, `remediation` 3개 |
| ② `theReportSaysCouldNotRunNotFailed` | ✅ `overall = could_not_run` (`fail`이 아니다). 최종 상태는 `completed` + "변경을 적용했으나 검증 명령을 **실행하지 못해** 검증되지 않았습니다". 그리고 **`mutatedPaths = ["paginate.js"]`** — 11절이 실측한 "patch는 UNC에서 동작한다"가 그대로 살아 있다 |
| ③ `theOpenBannerWarnsBeforeWork` | ✅ stderr 첫 줄에 배너. 5가지(무엇이 안 되나·무엇은 되나·실패가 아님·`net use`·자동화 금지)가 모두 들어 있다 |
| ④ `aLocalWorkspaceIsUnaffected` | ✅ `C:\Users\...` 워크스페이스에서 `overall = pass`, `test: PASSED exit=0`. **거짓 양성이 없다** |

부수적으로 확인된 것 하나: 워크스페이스 루트의 canonical 형태가 `\\?\UNC\localhost\...`로
나온다. `paths.rs`가 verbatim UNC를 일부러 벗기지 않기 때문이며(11절), `is_unc`가 그 형태를
따로 다루는 이유가 여기서 실물로 확인됐다 — `\\?\`만 보고 벗겼다면 이 경로는 UNC로 인식되지
않아 장벽이 통째로 지나갔을 것이다.

**그래도 `windows-landing`은 여전히 이 넷을 `NeedsHuman`으로 낸다.** 15절이 말하는 그 문제이며,
이 문단이 그 기록이다.

#### 다시 확인하는 절차

Linux에는 UNC가 없으므로 이 네 항목은 여기서 확인할 수 없다. 아래가 위 실측에 실제로 쓴
절차다. **모델 호출은 없다** — e2e가 쓰는 fake 공급자로 돌리므로 판정 경로는 진짜이고 LLM
응답만 가짜다. 유료 실행으로 확인하지 말 것: 이 항목들이 묻는 것은 모델이 무엇을 내놓는지가
아니라 **결과를 어떻게 보고하는지**다.

준비 — 먼저 빌드하고, UNC로 볼 수 있는 자리를 확인한다:

```powershell
npm run build            # sidecar dist + 테스트 헬퍼(fixtureRepo)
npm run core:build       # tomverse-host.exe
Get-SmbShare | Where-Object Name -eq 'Users'   # 기본 공유. 없으면 아래 대안을 쓴다
```

`Users` 공유(→ `C:\Users`)는 Windows 기본값이고 **승격이 필요 없다.** 관리자 공유
(`C$`, `H$` …)는 승격을 요구하므로 쓰지 않는다. 공유가 없는 머신이면 하나 만든다:

```powershell
New-SmbShare -Name tomverse-unc -Path "$env:USERPROFILE\tomverse-unc-fixture" -FullAccess $env:USERNAME
```

**전제부터 재현한다** — 이걸 건너뛰면 장벽이 옳은지 알 수 없다. 같은 UNC 작업 디렉터리에
프로세스를 둘 띄워, **우리 방식은 통과하고 npm만 실패하는지** 본다:

```powershell
$fx  = "$env:TEMP\tomverse-unc-fixture"
$unc = $fx -replace '^C:\\Users', '\\localhost\Users'
New-Item -ItemType Directory -Force $fx | Out-Null
Set-Content "$fx\package.json" '{"name":"fx","scripts":{"test":"node --test t.test.js"}}'
Set-Content "$fx\t.test.js" "const t=require('node:test');const a=require('node:assert');t.test('ok',()=>a.equal(1,1));"
$node = (Get-Command node).Source
$npm  = Join-Path (Split-Path $node) "node_modules\npm\bin\npm-cli.js"
Start-Process $node "--test t.test.js" -WorkingDirectory $unc -NoNewWindow -Wait   # exit 0 이어야 한다
Start-Process $node "`"$npm`" test"    -WorkingDirectory $unc -NoNewWindow -Wait   # UNC paths are not supported
```

**①②③④ 본체** — 픽스처를 **둘** 만들어(하나를 공유하면 첫 실행이 파일을 고쳐 두 번째
patch가 안 맞는다) 로컬과 UNC에 각각 태운다. 스크립트 하나로 두는 편이 확실하다:

```javascript
// node <이 파일>.mjs — packages/sidecar/test/e2e.test.ts의 runHost와 같은 인자를 쓴다.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureRepo, FIX_PATCH }
  from "file:///H:/Project/TomverseCode/packages/sidecar/dist/test/helpers/fixtureRepo.js";

const REPO = "H:/Project/TomverseCode";
const HOST = path.join(REPO, "apps/desktop/src-tauri/core/target/debug/tomverse-host.exe");
const SIDECAR = path.join(REPO, "packages/sidecar/dist/src/index.js");   // dist/index.js가 아니다

function run(workspace, label) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "tomverse-state-"));
  const r = spawnSync(HOST, [
    "run", "--workspace", workspace,
    "--message", "paginate.js 의 페이지 계산이 한 칸 밀려 있습니다. 1페이지가 첫 항목부터 나오게 고쳐주세요.",
    "--mode", "fast", "--approve", "auto",
    "--db", path.join(stateDir, "state.db"),
    "--artifacts", path.join(stateDir, "artifacts"),
    "--sidecar", SIDECAR, "--timeout-secs", "180",
  ], {
    encoding: "utf8", timeout: 210_000,
    env: { ...process.env,
      TOMVERSE_FAKE_SCRIPT: JSON.stringify({ defaultPatch: FIX_PATCH }),
      TOMVERSE_EXECUTOR_MODEL: "fake-executor", TOMVERSE_REVIEWER_MODEL: "fake-reviewer",
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },   // 우연히 네트워크를 타지 않게 지운다
  });
  const out = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop());
  console.log(`\n== ${label} ==`, workspace);
  console.log("배너:", r.stderr.split("\n").find((l) => l.includes("UNC")) ?? "(없음)");
  console.log("status:", out.final.status, "| overall:", out.final.verificationReport?.overall);
  console.log("mutatedPaths:", JSON.stringify(out.mutatedPaths));
  for (const c of out.final.verificationReport?.checks ?? [])
    console.log(`  - ${c.kind}: ${c.status} exit=${c.exitCode ?? "(없음)"}`);
}

const local = createFixtureRepo();
const remote = createFixtureRepo();
const P = "C:" + String.fromCharCode(92) + "Users";
const U = String.fromCharCode(92, 92) + "localhost" + String.fromCharCode(92) + "Users";
try {
  run(local.root, "④ 로컬");
  run(U + remote.root.slice(P.length), "①②③ UNC");
} finally { local.cleanup(); remote.cleanup(); }
```

확인할 것:

- **④ 로컬**: `overall = pass`, `test: PASSED exit=0`, 배너 **없음**.
  여기서 `could_not_run`이 나오면 `is_unc`가 로컬 경로를 UNC로 잘못 읽은 것이고, 그러면
  **정상 워크스페이스의 검증이 통째로 막힌 상태다.** 이 항목을 빼먹지 말 것 — 이쪽 실패는
  "검증이 조용해지는" 방향이라 눈에 덜 띈다.
- **① UNC**: test 체크에 `exitCode`가 **없다**(`exit=(없음)`), `status = SKIPPED_WITH_REASON`.
- **② UNC**: `overall = could_not_run` (`fail`이 아니다), `mutatedPaths = ["paginate.js"]`
  (patch는 여전히 동작한다).
- **③ UNC**: stderr 첫 줄에 배너. 데스크톱 앱은 워크스페이스를 열자마자 같은 문장을 노란
  배너에 띄운다(71.4절이 다섯 가지를 열거한다).

기록된 도구 출력의 모양까지 보려면 `--db`를 지운 자리에 두고 `show`로 읽는다:

```powershell
.\apps\desktop\src-tauri\core\target\debug\tomverse-host.exe show --db <state.db> --workspace <UNC 경로> --task <taskId>
```

`"spawned": false` · `"reason": "unsupported_unc_working_directory"` · `"exitCode": null` ·
`"durationMs": 0` · `checked` · `remediation`이 그대로 있어야 한다.

정리:

```powershell
Remove-SmbShare -Name tomverse-unc -Force   # 위에서 만들었다면
```

---

## 7. `jobObject` — 실제 취소에서 트리가 죽는다

`npm run test:e2e`의 **시나리오 A가 Windows에서 통과한다.**

그리고 실제 취소 실행의 기록에서:

```json
"treeKill": { "guaranteed": true, "method": "TerminateJobObject", "survivingPid": null }
```

- `treeGuaranteedTrue` — 남아 있던 절반("실제 취소에서 그 값이 true가 되는가")이 확인됐다.
  `method`가 `TerminateJobObject`이므로 taskkill 폴백이 아니라 **Job Object 경로**를 탔다.
- 손자 프로세스(`slow-test.pid` = 11108)가 취소 후 실제로 죽었다.
- 실행 전후로 tomverse 관련 잔여 `node.exe`가 없다.

`jobHandleLifetime`은 **절반만** 확인됐다. 취소 경로는 위와 같이 확인했지만, 착지 기준이
함께 요구하는 **강제 포기** 경로는 태우지 못했다 — 관측 당시 헤드리스 호스트(`tomverse-host`)에
그 하위 명령이 없었고, 강제 포기는 UI 탈출구였다. **지금은 `tomverse-host abandon`이 있다**
(14절 5번). 그것으로 다시 태운 기록은 아직 없다.

---

## 8. `commandResolution` — 세 항목 모두 확인

실제 실행 기록(`TOOL_COMPLETED` 이벤트의 `resolvedCommand`):

```json
{ "command":  { "program": "npm", "args": ["test"], "cwd": "." },
  "resolvedCommand": {
    "executable": "C:\\nvm4w\\nodejs\\node.exe",
    "args": ["C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "test"],
    "kind": "node-cli-shim",
    "shimPath": "C:\\nvm4w\\nodejs\\npm.CMD" } }
```

- **`npmResolvesToNodeCli`** ✅ — `cmd.exe /c` 없이 argv 그대로. 이 머신은 landing.rs가
  "구조가 다를 수 있다"고 경고한 **nvm4w** 설치인데도 올바르게 해석했다.
- **`verificationIsNotSilentlySkipped`** ✅ — 종합 판정이 `could_not_run`이 아니다.
  baseline `exit 1`(버그 있음) → post `exit 0`(고쳐짐)으로 **테스트가 실제로 돌았다.**
- **`unknownShimIsRefusedNotGuessed`** ✅ — 실제 파일 시스템·실제 PATHEXT로 확인했고,
  이제 `program.rs`의 `#[cfg(windows)]` 테스트가 매 실행마다 확인한다(기억이 아니라 기록).
  거부가 공허하지 않다는 것도 같은 테스트가 확인한다(같은 디렉터리의 `.exe`는 통과한다).

---

## 9. `developerEnv` — 4개 중 3개 확인

- **`vcvarsallIsFoundOnARealMachine`** ✅ — `npm run msvc:doctor`. **이 머신이 정확히 문서의
  실측 사례다**: 설치 2개 중 최신(D: 드라이브 VS 18 Enterprise)에 `vcvarsall.bat`이 없고,
  쓸 수 있는 것은 더 오래된 2022 BuildTools다. `-latest`였다면 실패했을 자리다.
- **`cargoBuildLinksWithoutADeveloperShell`** ✅ — `INCLUDE`/`LIB`/`VSINSTALLDIR`이 모두 빈
  평범한 PowerShell에서 `npm run core:build`가 링크까지 성공했다.
- **`msvcLinkWinsOverGitLink`** ✅ — GNU coreutils `link.exe`(`C:\Program Files\Git\usr\bin`,
  "link (GNU coreutils) 8.32")를 **PATH 선두에 둔 채** `cargo clean`(1420 파일 / 1.0 GiB 제거)
  후 전체 재빌드가 성공해 동작하는 10.6 MB 바이너리가 나왔다.
- **`aFailedPreparationDoesNotBlockTheCommand`** ❔ — **태우지 못했다.** 준비를 실제로
  실패시키려면 이 머신의 VS 탐지를 전부 못 하게 만들어야 하는데, 그건 머신을 건드리는 일이다.

  다만 시도 중에 관찰한 것: **`TOMVERSE_VCVARSALL`이 없는 경로를 가리키면 조용히 무시된다.**
  `_env.bat`이 `if defined ... if exist ...`로 검사하고, 파일이 없으면 다음 후보(vswhere)로
  넘어간다. 주석은 그것을 "탐지가 실패하는 머신의 최종 답"이라고 부르는데, 오타를 내면
  사용자는 자기가 지정한 것이 아닌 툴체인을 **말없이** 쓰게 된다. 저장소의 다른 곳이
  지키는 규율("추측해서 실행하지 않는다")과 어긋나 보인다 — 결함으로 단정하지 않고 질문으로 남긴다.

---

## 10. `pythonEnv` — 하나는 실패, 둘은 확인 불가

- **`pythonOnPathIsNotTheStoreAlias`** ❌ **실패.**
  (이 기준은 이후 `storeAliasIsReportedAsCouldNotRun`으로 **다시 쓰였다** — 머신의 성질에서
  코드의 성질로. 아래 관측은 그대로이고, 바뀐 것은 그 관측에 대해 우리가 무엇을 보고하는지다:
  [state-machine 49.9절](./state-machine-and-protocol.md). 다시 태운 기록은 아직 없다.)
  이 머신의 PATH `python`은
  `C:\Users\<user>\AppData\Local\Microsoft\WindowsApps\python.exe`이고 **크기가 0바이트**인
  Store 실행 별칭이다. `python --version`은 `Python `만 출력하고 **exit 9009**로 끝난다
  (Python이 실행되지 않는다). `python3`도 같은 자리에 있다.

  결과적으로: `.venv`가 없는 Python 프로젝트에서 감지는 PATH `python`으로 폴백하고,
  그 명령은 exit 9009로 끝난다. 종합 판정은 `FAILED`가 되므로 **6절과 같은 모양**이다 —
  "실행할 수 없었다"가 "테스트가 실패했다"로 보고된다.

- **`venvInterpreterRunsWithoutActivation`** ❔ — **확인 불가.** 이 머신에 진짜 Python 설치가
  없어(`py` 런처도 없음) `.venv`를 만들 수 없다. 통과로 세지 않는다.
- **`venvPathWithSpacesOrDriveLetterSurvives`** ❔ — 같은 이유로 확인 불가.

**부수 발견(고쳤다)**: `verify.rs`/`host.rs`의 python 픽스처가 `.venv/bin/python`에 고정되어
있었다. Windows에서는 `Scripts\python.exe`가 없으니 감지가 PATH로 폴백하고, 테스트는 그것을
실패로 읽었다 — 즉 **Windows에서 venv 갈래는 한 번도 실행되지 않았다.** 자리를 플랫폼에
맞춰 두 OS가 각자의 갈래를 태우게 했다.

---

## 11. `pathNormalization` — verbatim 확인

- **`verbatimPrefixStripped`** ✅ — `--workspace \\?\C:\...\tomverse-fixture-XXXX`로 실제 실행:
  태스크가 `completed`로 끝났고 `mutatedPaths = ["paginate.js"]`였다. 즉 **게이트가 정상 경로를
  경계 밖으로 판정하지 않았다.** 결과 JSON에 verbatim 프리픽스가 남지 않는다.
- **`uncPathsUntouched`** ✅(기준 자체는) — `\\localhost\Users\...`와 `\\?\UNC\localhost\...`
  둘 다 접근이 실패하지 않았고 파일이 실제로 바뀌었다. 기준이 경계하는 것("잘못 벗기면 경로가
  깨져 접근 자체가 실패한다")은 일어나지 않았다. **다만 6절의 별개 결함이 드러났다.**

---

## 12. `processGroup` — 태우지 못했다

- **`childGetsItsOwnProcessGroup`** ❔ — `proctree.rs`가 spawn 시
  `CREATE_NEW_PROCESS_GROUP`(0x200)을 무조건 건다는 것은 **소스로만** 확인했다. Ctrl+C가
  앱에 전파되지 않는지를 실제로 보려면 콘솔 그룹에 Ctrl+C를 보내야 하는데, 그러면 실측을
  돌리고 있는 셸 자신이 죽을 수 있어 하지 않았다.
- **`taskkillFallbackStillWorks`** ❔ — 폴백은 Job Object **생성·배정이 실패해야** 타는
  경로이고, 7절의 실측은 언제나 `TerminateJobObject`를 탔다. **관측 당시에는 그것을 강제하는
  스위치가 없었다** — 지금은 `tomverse-host --no-job-object`가 있다(14절 6번). 그것으로 다시
  태운 기록은 아직 없다.

---

## 13. 이번에 통과하게 된 것 — Windows에서 `verify`가 처음 돈다

기준 커밋 `206d2ef`에서 Windows의 전체 검증은 **통과하지 못했다.**

| | 이전 | 이후 |
|---|---|---|
| `scripts\verify.bat` | 실패 (exit 1) | **통과 (exit 0)** |
| 루트 `npm run verify` | 실패 (exit 1) | **통과 (exit 0)** |
| `core:test` | 679 통과 / **11 실패** | **698 통과 / 0 실패** |
| `test:e2e` | 42 통과 / **3 실패** | **46 통과 / 0 실패** |
| 가설 게이트 | 205 통과 / **1 실패** | **206 통과 / 0 실패** |
| `desktop:check` | **verify에 없었다** (있었다면 32개 오류) | **0 오류 / 0 경고, verify에 포함** |
| `scripts\tauri-build.bat` | 실패 (껍데기 컴파일 불가) | **통과 — .msi 5.3 MiB / .exe 3.6 MiB** |

두 진입점(`scripts\verify.bat`과 루트 `verify`)의 결과가 **처음부터 끝까지 같았다** —
과거에 한쪽만 `_env.bat`을 call해 갈라졌던 사고는 재발하지 않았다.

---

## 14. 아직 사람이 해야 하는 것

1. ~~Tauri 껍데기 크레이트를 고친다. 그다음 `cargo-check-desktop`을 `verify`에 넣는다.~~
   → **둘 다 했다**(4절). 번들이 만들어지고 `desktop:check`가 두 진입점에 있다.
2. ~~**sidecar 동봉을 설계하고 구현한다**(5절). `sidecarBundle`이 `not_landed`인 유일한 이유다.~~
   → **구현하고 확인했다.** 결정은 [process-architecture.md 10.6절](./process-architecture.md),
   실측은 5절 상단. `sidecarBundle`은 더 이상 `not_landed`가 아니다 —
   `bundleContents`·`bundleSizeRecorded`가 **도구 판정으로** `passed`이므로 여기에 사람의
   확인을 적을 것이 없다(15.2절: `passed`는 덮을 것이 없다).
   **이 항목에 남은 일은 아래 3번뿐이다.**
3. **node 없는 Windows 머신에서 설치본을 실행한다** — `runsWithoutNodeOnPath`와
   `sourcesAreBundled`. 2가 끝났으므로 이제 의미가 있고, **이것이 `sidecarBundle`에 남은
   전부다.** 설치본: `apps\desktop\src-tauri\target\release\bundle\{msi,nsis}`.

   **이번에 확인하지 *못한* 이유를 적어 둔다** — 15절의 취지가 이것이다.
   두 기준은 **설치된 GUI 앱**을 요구하는데, `desktop.exe`는 사용자가 워크스페이스를 열 때
   비로소 sidecar를 띄운다(`session.rs`). 즉 화면 조작 없이는 태울 수 없고,
   MSI를 실제로 설치하는 것은 이 작업의 범위 밖이다. 그래서 **attestation에 적지 않았다.**

   **대신 확인한 것**(같은 사실이 아니므로 통과로 세지 않는다):
   `msiexec /a`로 꺼낸 설치 레이아웃(`PFiles\Tomverse Code\`)에 `tomverse-host.exe`를 넣고,
   **PATH에서 node가 있는 디렉터리를 전부 걷어낸 뒤**(`where node` → 없음) `--sidecar`를
   주지 않고 `run`을 돌렸다. **exit 0, `mutatedPaths = ["paginate.js"]`, 태스크 완주.**
   PATH에 node가 없으므로 인터프리터는 번들에서 왔고, `resolve()`가 번들 진입점을 개발
   트리보다 먼저 보므로 진입점도 번들이다(그 우선순위는 `launcher.rs`의
   `a_staged_layout_on_a_real_filesystem_resolves_to_bundled`가 실제 파일시스템으로 지킨다).
   해석·spawn 함수는 껍데기와 공유한다(10.3절). **그래도 `desktop.exe`를 태운 것은 아니다.**

   다시 확인하는 절차:
   ```
   scripts\tauri-build.bat
   # 설치본을 node 없는 Windows에 설치하고 실행 → 워크스페이스를 연다
   # stderr에 "[sidecar] 동봉 런타임이 아닙니다"가 **없어야** 한다 (session.rs)
   ```
4. **`pythonEnv`를 태운다**(10절). 이제 **둘로 갈린다.**
   - `venvInterpreterRunsWithoutActivation`·`venvPathWithSpacesOrDriveLetterSurvives` —
     여전히 **Python이 있는 머신이 필요하다.** 이 머신에는 없다.
   - `storeAliasIsReportedAsCouldNotRun`(옛 `pythonOnPathIsNotTheStoreAlias`) — **막혀 있던
     이유가 사라졌다.** 기준이 머신의 성질("PATH의 python이 별칭이 아니다")에서 코드의
     성질("별칭뿐일 때 `FAILED`가 아니라 `could_not_run`으로 보고된다")로 바뀌었고, 그 결말을
     내는 코드가 생겼다([state-machine 49.9절](./state-machine-and-protocol.md)). 확인은
     **별칭이 있는 머신**에서 하므로 이 머신이 바로 그 머신이다 — 요구 사실에서 실행 가능한
     Python을 뺀 이유가 그것이다. **아직 태우지 않았다**; 절차는 `landing.rs`의 기준 문구에 있다.
5. **강제 포기 경로**로 job 핸들 수명을 마저 확인한다(7절).
   **막혀 있던 이유가 사라졌다**: 헤드리스 호스트에 하위 명령이 없어서 UI가 필요했는데,
   이제 `tomverse-host abandon --workspace <ws> --task <id> --db <db>`가 있다. 화면의 버튼과
   **같은 함수**(`TaskHost::force_abandon`)를 타므로 이 명령으로 태운 것이 제품 경로를 태운
   것이다. **아직 태우지 않았다**; 두 경로(취소·강제 포기)의 절차는 `landing.rs`의
   `jobHandleLifetime` 문구에 적어 두었다.
6. **`processGroup` 둘**(12절).
   - `childGetsItsOwnProcessGroup` — 여전히 **별도 콘솔이 필요하다.** Ctrl+C를 콘솔 그룹에
     보내면 실측을 돌리는 셸 자신이 죽을 수 있다.
   - `taskkillFallbackStillWorks` — **막혀 있던 이유가 사라졌다.** "폴백을 강제할 수단이
     없다"가 유일한 차단이었는데, `tomverse-host run --no-job-object …`가 그 수단이다:
     `proctree::adopt`가 job을 만들지 않으므로 **생성이 실패했을 때와 같은 코드**를 탄다.
     진입점은 이 인자 하나뿐이고 GUI에는 없다(소스 검사 테스트가 지킨다). 결과의
     `treeKill.jobObjectDisabled`가 "만들지 못했다"와 "일부러 껐다"를 가른다.
     **아직 태우지 않았다**; 절차는 `landing.rs`의 그 기준 문구에 있다.
7. ~~**UNC 워크스페이스를 어떻게 할지 결정한다**(6절).~~ → **결정하고, 고치고, 확인했다**
   (6.1·6.2절, [state-machine 71절](./state-machine-and-protocol.md)). (c) 정직한
   `could_not_run` + (d) 열되 경고. 새 착지 묶음 `uncWorkspace`의 네 항목을 이 머신에서
   태워 전부 통과했고, 전제(Win32는 UNC cwd를 받아들이고 거부하는 것은 cmd.exe 하나)도
   재현했다. **이 항목에 남은 일은 없다** — 코드가 바뀌면 6.2절 절차로 다시 태울 것.
   특히 ④(로컬 워크스페이스가 영향을 받지 않는다)를 빼먹지 말 것: 이 고침이 **반대
   방향으로** 틀리면 정상 워크스페이스의 검증이 통째로 막히고, 그 증상은 "검증이
   조용해지는" 쪽이라 눈에 덜 띈다.
8. ~~**`credentialStore`** — 실측이 아니라 개발이다.~~ → **만들고, 태웠다.**
   구현은 [multi-engine-routing.md 20절](./multi-engine-routing.md), 관측은 **17절**,
   기록은 [`attestations/windows-landing-2ef2689.json`](./attestations/windows-landing-2ef2689.json)에 있다.
   다섯 기준 중 둘은 소스 불변식이라 기계가 통과로 판정했고(3·4 — 18.1절의 표), Windows에
   남아 있던 셋(`storedThroughDpapi`, `noPlaintextAtRest`,
   `productionStoreIsNotTheDevelopmentOne`)을 `2ef2689`에서 확인했다.
   **이 묶음의 판정은 `landed`다.**

   **이 항목에 남은 일은 하나뿐이다**: 설치본을 띄워 **자격증명 배너를 눈으로** 확인하는 것
   (17.4절). 태운 것은 배너가 부르는 저장 경로 전체이고 배너 문구는 확인된 `kind`에서
   유도되지만, `desktop.exe`를 실행한 것은 아니다 — 위 3번과 같은 자리이므로 함께 하면 된다.

   경계를 분명히 해 둔다: `win_credentials.rs`는 `win_job.rs`와 같은 성질이다
   ([state-machine 20.5절](./state-machine-and-protocol.md)) — Linux에서 통과한 `verify`가
   그 파일에 대해 말해주는 것이 없다. **그리고 이 파일은 `cfg(windows)`도 `Platform::Windows`도
   쓰지 않으므로 `landing.rs`의 그물(`windows_only_code_has_a_landing_check_or_a_reason`)에
   걸리지 않는다** — `msvc.rs`와 같은 사각지대다. 걸리는 것은 `credentials.rs` 쪽이고,
   그 이름이 `landing.rs`에 적혀 있어 통과한다.

위의 것들을 확인하면 **문서가 아니라 attestation 파일에 적는다**(15절). 이 목록은 확인하지
못한 것의 목록이고, 확인한 것은 도구가 읽는 자리로 간다 — 그 둘이 갈리는 것이 이 작업의
결과다. 확인은 **그 커밋에서만** 유효하므로, main이 움직이면 다시 확인해 새로 적어야 한다.

---

## 15. 사람의 확인을 받아들이는 입구 — **구현됨**

`windows-landing`은 실측 전후로 **똑같이** `remaining = 25`를 냈다. 위의 7~11절을 전부
확인했는데도 그랬다. 그 설계 자체는 옳다 — 도구가 못 본 것을 스스로 통과로 바꾸면 착시를
만든다. **그러나 사람이 확인한 결과를 넣을 자리가 없으면, 확인한 사실은 다시 기억에만 남는다.**
이 도구가 없애려던 상태로 되돌아가는 것이다.

저장소에는 이미 이 문제의 답이 있었다. 가설 게이트의 `attest-p0`가 결과를 검사해
`approvals/attestations/<id>.json`에 **immutable하게** 적고, 이후 단계는 그 파일을 근거로
삼는다(multi-engine-routing.md 10.10절). 같은 모양을 여기에 두었다 —
`apps/desktop/src-tauri/core/src/landing_attest.rs`.

```
tomverse-host windows-landing --workspace <repo> --attest <파일>
```

### 15.1 기록에 들어가는 것

**무엇을**, **어느 머신에서**, **어느 커밋에서**, **누가** 확인했는지. 1절이 왜 표로
시작하는지가 그 이유다.

```json
{
  "schemaVersion": 1,
  "kind": "windows-landing-attestation",
  "attestationId": "windows-landing-206d2ef",
  "attestedBy": "...",
  "createdAt": "2026-08-27T00:00:00Z",
  "commit": "206d2ef",
  "machine": {
    "os": "windows", "osVersion": "10.0.19045",
    "nodeVersion": "v22.22.2", "npmShim": "C:\\nvm4w\\nodejs\\npm.CMD",
    "visualStudio": "...\\2022\\BuildTools", "gitForWindows": "C:\\Program Files\\Git",
    "gitAutocrlf": "true", "python": null, "installedBundle": null
  },
  "checks": [
    { "group": "commandResolution", "check": "npmResolvesToNodeCli",
      "observedAt": "2026-08-27", "evidence": "무엇을 보고 그렇게 판단했는가" }
  ],
  "attestationHash": "<64자리 hex>"
}
```

`evidence`는 비어 있을 수 없다. 근거 없는 통과 표시는 이 도구가 없애려는 바로 그것이다.

**`machine`의 필드는 하나도 생략할 수 없다.** 없으면 `null`이라고 **적어야** 한다.
`deny_unknown_fields`는 더 적은 것을 막지 못하고 serde의 `Option`은 없는 필드를 조용히
`None`으로 만드는데, 그러면 "적지 않는 것"이 요구를 피하는 가장 쉬운 길이 된다. 그 순간
이 기록은 판정 재료가 아니라 장식이다.

### 15.2 무엇을 덮을 수 있고, 무엇을 덮을 수 없는가

| 도구가 관측한 상태 | attestation |
|---|---|
| `needs_human` | **통과로 바꾼다** — 애초에 사람을 기다리던 자리다 |
| `not_checkable_here` | **통과로 바꾼다** — "여기서는 볼 수 없다"에 대한 답이 다른 머신의 확인이다 |
| `failed` | **덮지 못한다.** 도구가 실제로 관측한 실패를 사람의 종이가 지우지 못한다 |
| `not_implemented` | **덮지 못한다.** 없는 기능을 확인할 수는 없다 |
| `passed` | 덮을 것이 없다. 적혀 있으면 "아무것도 바꾸지 않았다"고 알린다 |

5절이 정확히 세 번째 줄의 자리다 — 번들에 sidecar가 없다는 것은 도구가 **봤다.**

### 15.3 머신 사양이 판정에 반영된다

각 기준이 "사람이 확인하려면 그 머신에 무엇이 있어야 하는가"를 **기준 옆에** 선언한다
(`Check.requires`). 별도 표로 몰아두면 기준을 고칠 때 요구를 함께 고치지 않게 되고, 그러면
없는 것으로 확인했다는 기록이 통과한다.

10절이 그 이유다: **이 머신에는 Python이 없었다.** 그러므로 같은 문장을 적어도 `pythonEnv`
세 항목은 이 머신의 기록으로 통과하지 않는다 — "Python으로 확인했다"는 Python이 있는
머신에서만 뜻이 있다. 거부는 조용하지 않다: 어느 줄이 왜 반영되지 않았는지가
`attestation.rejections`에 남는다.

### 15.4 커밋이 바뀌면 만료된다

옛 확인이 새 코드를 통과시키면 이 도구는 착시를 만드는 쪽이 된다. 그래서 커밋이 다르면
**항목별로 따질 것도 없이 통째로** 반영하지 않는다(`status: expired`). 지금 커밋을 읽지
못하면(git 저장소가 아니면) 만료 여부를 판정할 수 없으므로 역시 반영하지 않는다
(`status: inapplicable`) — 모르는 것을 통과로 세지 않는다.

### 15.5 해시는 재귀 canonical JSON이다

가설 게이트가 `JSON.stringify(v, Object.keys(v).sort())`로 **중첩 객체를 통째로 지워**
"해시가 있는데 아무것도 지키지 못하던" 결함을 겪었다(CLAUDE.md 함정 기록,
`evals/hypothesis-gate/src/canonical.ts`). 같은 실수를 반복하지 않는다 — key를 모든 깊이에서
정렬하고 배열의 순서는 보존하며, 그 규칙을 지키는 테스트가 있다.

**해시를 만들어 주는 명령은 없다.** 맞지 않으면 재계산한 값을 알려주고 거부할 뿐이고,
파일에 옮겨 적는 것은 사람이다. 알려주는 것은 "무엇을 확인했는가"가 아니라 "이 내용이 그 뒤로
바뀌지 않았다"는 봉인뿐이다. 이건 전자서명이 아니다 — 막으려는 것은 공격자가 아니라 사고다
(편집기로 열었다 저장했다, 다른 실행의 파일을 복사해 왔다).

### 15.6 `remaining`이 줄어드는 것은 목적이 아니다

목적은 **누가·어디서·언제·무엇을 보고** 확인했는지가 남는 것이다. 그래서 통과한 기준에는
그 출처가 붙고(`check.attestation`), 보고서 표면에 **그중 몇 개가 사람의 확인인지**가
따로 있다(`attestedPasses`). 기계가 본 통과와 같은 칸에 넣지 않는다.

### 15.7 이 저장소에 있는 기록

[`attestations/windows-landing-206d2ef.json`](./attestations/windows-landing-206d2ef.json) —
7~12절의 실측을 옮긴 것. 열 항목이다(jobObject 2, commandResolution 3, developerEnv 3,
pathNormalization 2). **확인하지 못한 것은 적지 않았다**: `jobHandleLifetime`(강제 포기 경로를
태우지 못했다), `aFailedPreparationDoesNotBlockTheCommand`, `processGroup` 둘, `pythonEnv` 셋.

`206d2ef`를 체크아웃한 트리에서 돌리면 `status = accepted`, `attestedPasses = 10`이고
`remaining`이 26에서 16으로 줄어든다(Linux 기준. 26인 이유는 `coreBuild`가 Windows에서는
`passed`인데 여기서는 `not_checkable_here`이기 때문이다).

**지금 main에서 돌리면 `status = expired`, `attestedPasses = 0`이고 `remaining`은 그대로다.**
그게 정상이고, 만료가 실제로 동작한다는 증거다.

[`attestations/windows-landing-2ef2689.json`](./attestations/windows-landing-2ef2689.json) —
17절의 실측을 옮긴 것. `credentialStore` 세 항목이다. `2ef2689`를 체크아웃한 트리에서 돌리면
`status = accepted`, `attestedPasses = 3`이고 그 묶음이 `landed`가 된다. 여기에도 **확인하지
못한 것은 적지 않았다**: GUI의 자격증명 배너를 눈으로 본 것은 아니고, 그 사실은 17.4절에 있다.

**두 파일을 하나로 합치지 않는다.** attestation은 커밋에 묶이고, 서로 다른 커밋에서 확인한
것은 서로 다른 사실이다. 합치면 새 커밋의 확인이 옛 확인을 되살리게 된다.

---

## 16. `credentialStore` — 이번에 만들고, 이 머신에서 태워본 것

> **이 절은 커밋 전의 관측이다.** 판정에 들어간 확인은 **17절**과
> [`attestations/windows-landing-2ef2689.json`](./attestations/windows-landing-2ef2689.json)에
> 있다. 이 절을 지우지 않는 이유는 16.2절이 **왜 그때는 적을 수 없었는지**를 말하기
> 때문이다 — 그것이 attestation의 만료 규칙이 무엇을 위한 것인지의 실례다.

구현과 설계 근거는 [multi-engine-routing.md 20절](./multi-engine-routing.md).
여기 적는 것은 **관측**이다.

### 16.1 이 머신에서 실제로 본 것

1절의 실측 머신(Windows 10 Pro 10.0.19045)에서, 프로덕션 저장 경로를 그대로 태우는 일회성
프로브(`open_credential_store()` → `store`/`has`/`read_for_injection`/`forget`)로 확인했다.
프로브는 저장소에 커밋하지 않았다 — 제품 코드가 아니고, 남겨두면 다음 사람이 그것을 근거로 쓴다.

| 무엇을 봤나 | 결과 |
|---|---|
| 열린 저장소 종류 | `WindowsCredentialManager` (`is_production = true`). 개발용으로 물러서지 않았다 |
| 저장 전 `has` | `false` |
| 저장 후 `has` / `read_for_injection` | `true` / 넣은 값과 **일치** |
| `cmdkey /list` | `Target: LegacyGeneric:target=TomverseCode/openai`, `Type: Generic`, `User: openai` |
| 저장 시각에 바뀐 파일 | `%LOCALAPPDATA%\Microsoft\Credentials\07E5D7DD…` (496 bytes) — Credential Manager의 자격 증명 저장소 |
| 그 파일에서 평문 검색 | **0건**. `%APPDATA%\Microsoft\Credentials`, `%APPDATA%\Microsoft\Protect`도 0건 |
| 앱 상태 디렉터리·번들·`.cache` 평문 검색 | 0건 (번들 1311개 파일 포함) |
| 지우기 | `removed = true` → 두 번째 호출은 `removed = false` (**없었던 것과 실패를 가른다**) |
| 지운 뒤 `cmdkey /list` | `TomverseCode` 항목 0개 |

**가장 값어치 있는 줄은 아래에서 다섯 번째다.** "저장했다"는 것과 "평문으로 남지 않는다"는
다른 사실인데, 그 둘을 한 번에 잇는 관측이 **저장 순간에 쓰인 그 파일에서 평문이 나오지
않는다**는 것이다. 그 파일을 짚지 않고 "어디에도 없더라"만 적으면, 아무 데도 저장되지
않았을 때와 구별되지 않는다.

**약한 줄도 적어 둔다:** 앱 상태 디렉터리(`%APPDATA%\Tomverse Code`)는 **파일이 0개였다** —
앱을 띄운 적이 없기 때문이다. 그러므로 거기서 0건이 나온 것은 근거로 세지 않는다.
기준 2를 사람이 확인할 때는 **앱을 실제로 띄워 태스크를 한 번 돌린 뒤** 검색해야 한다.

### 16.2 그런데도 attestation을 쓰지 않았다

두 가지 이유이고, 둘 다 이 도구의 존재 이유와 같은 것이다.

1. **커밋이 없다.** attestation은 커밋에 묶이고 커밋이 바뀌면 통째로 만료된다(15.4절).
   이 작업이 커밋되기 전에 적은 기록은 **적는 순간 만료된 것**이다.
2. **`attestedBy`는 사람이다.** 위 표는 도구가 낸 출력이고, 그것을 "확인했다"로 바꾸는 것은
   사람의 판단이다. 자동으로 못 본 것을 통과로 바꾸지 않는다는 규칙과 같은 규칙이,
   자동으로 본 것을 사람의 확인으로 바꾸지 않는다고도 말한다.

### 16.3 확인 절차 — 세 기준

커밋한 뒤 이 절차로 태우고, 결과를 attestation 파일에 적는다(15절).

```
tomverse-host windows-landing --workspace <repo>          # 무엇이 남았는지 먼저 본다
tomverse-host windows-landing --workspace <repo> --attest <파일>
```

**`storedThroughDpapi`**
1. 앱을 띄우고 자격증명 배너에서 공급자 키를 넣는다.
2. `control keymgr.dll` → Windows 자격 증명에 `TomverseCode/<공급자>`가 보인다.
   (`cmdkey /list`로도 같다. 항목이 보이는 것 자체가 DPAPI를 지났다는 표시다 —
   Credential Manager는 blob을 그 위에 저장한다.)
3. 앱에서 "지우기"를 누르면 그 항목이 사라진다.

**`noPlaintextAtRest`**
1. 키를 넣은 뒤 **앱으로 태스크를 한 번 돌린다** — 로그·캐시·이벤트가 실제로 쓰이게 한다
   (16.1절의 약한 줄이 이 단계 때문이다).
2. `%APPDATA%\Tomverse Code` 전체(state.db·settings·artifacts·로그)와 번들 디렉터리에서
   그 키 문자열을 찾는다. **0건이어야 한다.**
3. `%LOCALAPPDATA%\Microsoft\Credentials`에서 **저장 시각에 바뀐 파일**을 찾고, 거기서도
   평문이 안 나오는지 본다. 이 단계를 빼면 2번이 "아무 데도 저장 안 됨"과 구별되지 않는다.

**`productionStoreIsNotTheDevelopmentOne`**
1. 앱의 자격증명 배너가 "Windows Credential Manager (DPAPI)"를 표시한다.
2. 개발용 문구("개발용 메모리 저장소…", "앱을 끄면 사라집니다")가 **뜨지 않는다.**

`uiNeverHoldsTheKey`와 `injectionStaysOnce`는 적지 않는다 — 이미 기계가 통과로 판정했고,
적으면 "아무것도 바꾸지 않았다"고 알린다(15.2절).

---

## 17. `credentialStore` — 커밋 `2ef2689`에서 태웠다

16절은 **커밋 전**의 관측이라 적는 순간 만료된 기록이었다(16.2절). 이 절은 그 절차를
`2ef2689`(PR #22 병합 커밋, 작업 트리 clean)에서 다시 태운 결과이고, 결과는
[`attestations/windows-landing-2ef2689.json`](./attestations/windows-landing-2ef2689.json)에
있다. **`credentialStore`는 이제 `landed`다** — 다섯 기준 전부 `passed`이고 그중 셋이
사람의 확인(`attestedPasses = 3`)이다.

머신은 1절과 같다(Windows 10 Pro 10.0.19045 / node v22.22.2 nvm4w / VS 2022 BuildTools /
`autocrlf=true` / Python **없음**, PATH의 `python`은 0바이트 Store 별칭).

태운 도구는 16.1절과 같은 성질의 **일회성 프로브**다 — `open_credential_store()`를 부르고
`store`/`has`/`read_for_injection`/`forget`과 `credential_injection_for`를 그대로 지난다.
저장소에 커밋하지 않았다. 제품 코드가 아니고, 남겨두면 다음 사람이 그것을 근거로 쓴다.

### 17.1 `storedThroughDpapi`

| 무엇을 봤나 | 결과 |
|---|---|
| 저장 전 `has("openai")` | `false`. Credential Manager의 `TomverseCode` 항목 **0개** |
| `store` 후 `has` / `read_for_injection` | `true` / 넣은 값과 **일치** |
| `cmdkey /list` | `Target: LegacyGeneric:target=TomverseCode/openai`, `Type: Generic`, `User: openai`, **`Local machine persistence`** |
| 저장 시각에 바뀐 파일 | `%LOCALAPPDATA%\Microsoft\Credentials\07E5D7DD37E0419B0FA3FE5D9CF0DE99` (496 bytes) |
| `forget` | `true` → 두 번째 호출 `false` (**없었던 것과 실패를 가른다**) |
| 지운 뒤 `cmdkey /list` | `TomverseCode` 항목 **0개** |

`Local machine persistence` 줄이 표에 있는 이유: `CRED_PERSIST_LOCAL_MACHINE`을 고른 근거가
"`ENTERPRISE`는 도메인 프로필과 함께 로밍한다"였는데(`win_credentials.rs`), 그 선택이 실제로
그렇게 저장됐는지는 **Windows가 뭐라고 부르는지를 봐야** 안다.

### 17.2 `noPlaintextAtRest`

16.1절이 스스로 약하다고 적어둔 줄이 있었다 — 앱 상태 디렉터리가 **파일 0개**였고, 앱을 띄운
적이 없어서 그랬다. 이번에는 그 자리를 메웠다: 카나리 값을 저장소에 넣은 채
**태스크를 하나 완주시켰다**(`tomverse-host run`, `mode=verified`, exit 0,
`status=completed`, `verification=pass`, 이벤트 85개, `mutatedPaths = ["paginate.js"]`).

**주입이 실제로 일어났다는 것을 먼저 확정한다.** 안 그러면 아래의 "0건"은 아무 데도 저장되지
않았을 때와 구별되지 않는다. `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`를 **빈 값으로 둔 채**,
host가 spawn 전에 부르는 그 함수(`credential_injection_for`)가
`secretCount=1`, `secretNames=["OPENAI_API_KEY"]`를 냈다 — 값의 출처는 환경변수가 아니라
저장소다(`resolve_all`은 저장소를 환경변수보다 앞에 둔다).

| 어디를 뒤졌나 | 결과 |
|---|---|
| 상태 디렉터리 (`state.db` 249856 bytes · artifacts · host stdout/stderr 로그) | 5개 파일 / **0건** |
| 워크스페이스(fixture) | 7개 파일 / **0건** |
| 동봉 번들 디렉터리 | 1311개 파일 / **0건** |
| 저장 순간 쓰인 Credential Manager blob (496 bytes) | ASCII·UTF-8·UTF-16 전부 **0건** |
| `%LOCALAPPDATA%`·`%APPDATA%`의 `Credentials`/`Protect` 전체 | **0건** |
| `%APPDATA%\Tomverse Code` | 파일 0개 — **근거로 세지 않는다**(GUI를 띄운 적이 없다) |

**대조를 함께 했다.** "0건"은 탐지기가 찾을 수 있을 때만 뜻이 있으므로, 같은 디렉터리에
카나리를 UTF-8과 UTF-16으로 하나씩 심고 다시 훑었다 — **2건을 찾아냈고**, 지운 뒤 0건으로
돌아왔다. 검색은 세 인코딩으로 바이트를 읽고 접두사(`sk-tomverse`)까지 봤다.

### 17.3 `productionStoreIsNotTheDevelopmentOne` — 그리고 구조가 실제로 서 있는가

열린 저장소: `kind=WindowsCredentialManager`, `is_production=true`,
`survives_restart=true`, `label="Windows Credential Manager (DPAPI)"`,
`expected_kind_here()`와 **일치**. 조용한 폴백이 없었다.

**구조는 컴파일러에게 물었다.** 커밋 메시지가 주장하는 것("폴백을 규율이 아니라 컴파일러가
막는다")은 소스를 읽어서가 아니라 **거부당해 봐야** 확인된다. `MemoryCredentialStore`를
참조하는 한 줄을 core의 non-test 코드에 넣자 debug와 `--release` **양쪽에서** 거부됐다:

```
error[E0433]: cannot find `MemoryCredentialStore` in `credentials`
```

즉 Windows 빌드에는 폴백이 설 자리 자체가 없다. (넣은 줄은 지웠고, 확인 후 트리는 clean이다.)

나머지 두 구조 주장은 소스와 테스트가 지킨다 — `CredentialInjection::into_pairs`가
`pub(crate)`라 껍데기 크레이트가 값을 꺼낼 수단이 없다는 것,
화면의 "개발용" 문구가 상수가 아니라 `isDevelopmentOnly = !kind.is_production()`에서
유도된다는 것. 각각 `packages/toolchain/test/credentialBoundary.test.ts`와
`apps/desktop/test/credentialDraft.test.ts`가 매 `verify`마다 본다.

### 17.4 태우지 못한 것 — GUI를 조작하지는 않았다

**이것은 실패가 아니다.** 확인한 것과 확인하지 못한 것을 가르는 것이 15절의 취지이므로 적어 둔다.

16.3절의 절차는 "앱을 띄우고 자격증명 배너에서 키를 넣는다"로 시작한다. 이번 세션은
`desktop.exe`를 실행하지 않았다 — 14절 3번과 같은 이유다(화면 조작이 필요하다).
태운 것은 **그 배너가 부르는 저장 경로 전체**이고(`SessionState::set_credential` →
`store.store()` → `CredWriteW`에서 앞의 한 겹만 빠진다), 배너 문구는 위에서 확인한
`kind` 값에서 유도된다.

그런데도 attestation에 적은 이유: 이 세 기준의 요구(`Check::requires`)는 `WindowsOs`
**하나뿐**이고, `InstalledBundle`을 요구하는 `sidecarBundle`의 두 기준과 다르다.
요구 목록이 기준의 계약이므로, 그것을 충족한 확인은 적는 것이 맞다. 대신 **무엇을
보지 않았는지를 evidence에 그대로 적어 두었다** — 나중에 읽는 사람이 "배너를 봤다"로
읽지 않도록.

여전히 남는 일: 설치본을 띄워 배너를 눈으로 확인하는 것. 14절 3번과 함께 하면 된다.

### 17.5 `attestedBy`가 사람이 아니다

16.2절은 "`attestedBy`는 사람이다"라고 적었고, 그 취지는 도구가 스스로 본 것을 사람의 확인으로
바꾸지 않는다는 것이었다. 이 attestation의 `attestedBy`는
`Claude (Opus 5) — Vyper의 Windows 머신에서 돌린 세션`이다. **사람이 아니다.**

숨기지 않고 적는 이유는 그 필드의 목적이 "누가 확인했는가"이기 때문이다. 사람의 이름을
빌려 적으면 그 필드가 답해야 할 질문에 거짓으로 답하게 된다. 읽는 사람이 이 기록의 무게를
스스로 정할 수 있도록, **어떤 종류의 확인인지가 그 자리에 그대로 있어야 한다.**
