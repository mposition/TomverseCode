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

리눅스에서는 tauri가 GUI 시스템 라이브러리를 요구해 이 단계가 실패한다. 조용히 건너뛰는 것보다
낫다 — 그 환경에서는 앱을 만들 수 없다는 사실이 그대로 드러나야 한다.

---

## 5. `not_landed` — sidecar를 번들에 넣는 설정이 없다

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

`bundleSizeRecorded`는 `passed`로 나오지만 **그 숫자를 믿지 말 것** — `--bundle`에
`target/release`를 주면 빌드 산출물까지 세어 1586.9 MiB가 나온다. 실제 설치본은 위의
5.3/3.6 MiB다. 동봉이 생기면 그때 잴 대상은 설치된 앱 디렉터리다.

---

## 6. 새 결함 — UNC 워크스페이스에서 검증이 "테스트 실패"로 보고된다

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

**결정할 것**: 네트워크 드라이브 워크스페이스를 (a) UNC를 드라이브 문자로 매핑해 지원할지,
(b) 시작 시 명확한 이유와 함께 거절할지. 지금처럼 "사용자 테스트가 깨진 것처럼 보이는" 상태로
두면 안 된다.

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
함께 요구하는 **강제 포기** 경로는 태우지 못했다 — 헤드리스 호스트(`tomverse-host`)에 그
하위 명령이 없고, 강제 포기는 UI 탈출구다.

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

- **`pythonOnPathIsNotTheStoreAlias`** ❌ **실패.** 이 머신의 PATH `python`은
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
  경로이고, 그것을 강제하는 스위치가 없다. 7절의 실측은 언제나 `TerminateJobObject`를 탔다.

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
2. **sidecar 동봉을 설계하고 구현한다**(5절). `sidecarBundle`이 `not_landed`인 유일한 이유다.
3. **node 없는 Windows 머신에서 설치본을 실행한다** — 2가 끝나야 의미가 있다.
   (설치본은 이미 있다: `target\release\bundle\{msi,nsis}`.)
4. **Python이 있는 머신에서 `pythonEnv` 셋을 태운다**(10절). 이 머신에는 Python이 없다.
5. **강제 포기 경로**로 job 핸들 수명을 마저 확인한다(7절) — UI가 필요하다.
6. **`processGroup` 둘**(12절). Ctrl+C 전파는 별도 콘솔에서, taskkill 폴백은 강제할 수단이 필요하다.
7. **UNC 워크스페이스를 어떻게 할지 결정한다**(6절).
8. **`credentialStore`** — 실측이 아니라 개발이다. 만들 때 `injectionStaysOnce` 기준을 먼저 읽을 것.

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
