//! Windows에서만 확인되는 착지 기준을 **명령이 판정한다.**
//!
//! # 왜 필요한가
//!
//! 세 항목이 "Windows에서 실행해야만 검증된다"로 유보되어 있다 — Job Object
//! (state-machine-and-protocol.md 20.6절), sidecar 동봉(process-architecture.md 10.4절),
//! Credential Store(multi-engine-routing.md 12절). 그 기준들은 **문서의 산문**이었다.
//! 사람이 세 문서에서 아홉 개 남짓한 항목을 읽고, 손으로 해보고, 머릿속에서 판정한다.
//!
//! 그 방식의 실패는 조용하다: 한 항목을 빠뜨려도 아무 일도 일어나지 않고, 나중에
//! "확인했다"는 기억만 남는다. 유도 문턱과 열린 질문에 이미 적용한 규율(표본이 모자라면
//! 답을 내지 않는다)을 여기에도 준다 — **확인하지 못한 것을 통과로 세지 않는다.**
//!
//! # 이 모듈이 판정하지 않는 것
//!
//! 여기가 하는 일은 관측을 기준에 대보는 것뿐이다. 사람이 해야 하는 단계(실제 취소 실행,
//! node 없는 머신에서 설치본 실행)는 **`NeedsHuman`으로 남고 그 사실이 판정에 반영된다.**
//! 자동으로 못 본 것을 통과로 바꾸는 순간 이 도구는 착시를 만드는 쪽이 된다.

use std::path::{Path, PathBuf};

/// 기준 하나의 상태.
///
/// **다섯 값인 것이 요점이다.** 넷으로 줄이면 "확인할 수 없었다"와 "아직 만들지 않았다"가
/// 뭉개지는데, 그 둘은 다음에 할 일이 전혀 다르다 — 앞은 Windows를 구하는 것이고 뒤는
/// 코드를 쓰는 것이다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Passed,
    Failed,
    /// 이 플랫폼/입력에서는 볼 수 없다 (Windows 전용이거나 번들 경로를 안 줬다).
    NotCheckableHere,
    /// 자동으로 볼 수 없다 — 사람이 해야 한다.
    NeedsHuman,
    /// 기능 자체가 아직 없다.
    NotImplemented,
}

impl CheckStatus {
    fn is_pass(&self) -> bool {
        matches!(self, CheckStatus::Passed)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Check {
    pub id: &'static str,
    /// **문서에 적힌 기준 문장.** 여기서 바꿔 쓰지 않는다 — 두 곳이 다른 말을 하면
    /// 어느 쪽이 기준인지 알 수 없다.
    pub criterion: &'static str,
    pub status: CheckStatus,
    /// 무엇을 보고 그렇게 판정했는가, 또는 사람이 무엇을 해야 하는가.
    pub detail: String,
}

/// 한 항목(= 문서 한 절)의 결말.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// 기준이 **전부** 통과했다.
    Landed,
    /// 하나라도 실패했다. 통과하지 못한 것이 있는 것과 다르다 — 이건 고칠 것이 있다는 뜻이다.
    NotLanded,
    /// 실패는 없지만 확인하지 못한 것이 남았다. **`Landed`가 아니다.**
    Incomplete,
}

fn verdict_of(checks: &[Check]) -> Verdict {
    if checks.iter().any(|c| c.status == CheckStatus::Failed) {
        return Verdict::NotLanded;
    }
    if checks.iter().all(|c| c.status.is_pass()) {
        return Verdict::Landed;
    }
    Verdict::Incomplete
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Group {
    pub id: &'static str,
    /// 기준이 적힌 곳. 판정을 의심할 때 볼 자리를 알려준다.
    #[serde(rename = "documentedAt")]
    pub documented_at: &'static str,
    pub checks: Vec<Check>,
    pub verdict: Verdict,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LandingReport {
    /// 이 판정이 어느 OS에서 나왔는가. **Windows가 아니면 대부분 볼 수 없다**는 사실이
    /// 보고서 안에 남아야 한다.
    pub platform: String,
    pub groups: Vec<Group>,
    /// 전체 결말 — 항목 중 하나라도 `Landed`가 아니면 `Landed`가 아니다.
    pub verdict: Verdict,
    /// 사람이 아직 해야 하는 일. 비어 있지 않으면 그게 다음 할 일 목록이다.
    pub remaining: Vec<String>,
}

/// 판정에 쓰는 관측. **판정 로직을 순수하게 두기 위해** 입력으로 받는다 —
/// 그래야 Windows 없이도 규칙 자체를 테스트할 수 있다.
#[derive(Debug, Clone)]
pub struct Observations {
    pub os: String,
    /// `tauri-build`이 만든 번들 디렉터리. 없으면 번들 기준을 볼 수 없다.
    pub bundle_dir: Option<PathBuf>,
}

impl Observations {
    pub fn here(bundle_dir: Option<PathBuf>) -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            bundle_dir,
        }
    }

    fn on_windows(&self) -> bool {
        self.os == "windows"
    }
}

fn check(id: &'static str, criterion: &'static str, status: CheckStatus, detail: impl Into<String>) -> Check {
    Check {
        id,
        criterion,
        status,
        detail: detail.into(),
    }
}

/// 디렉터리 아래 파일 크기 합계(바이트). 얕게 훑는다 — 번들 구조는 깊지 않다.
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn job_object_checks(obs: &Observations) -> Vec<Check> {
    let windows = obs.on_windows();
    vec![
        check(
            "coreBuild",
            "`npm run core:build`가 Windows에서 통과한다.",
            if windows {
                CheckStatus::Passed
            } else {
                CheckStatus::NotCheckableHere
            },
            if windows {
                "이 바이너리가 Windows에서 돌고 있다 — 빌드가 통과했다는 증거다.".to_string()
            } else {
                format!("여기는 {}다. Windows에서 다시 돌릴 것.", obs.os)
            },
        ),
        check(
            "e2eScenarioA",
            "e2e 시나리오 A(손자 프로세스가 실제로 죽는가)가 Windows에서 통과한다.",
            CheckStatus::NeedsHuman,
            "Windows에서 `npm run test:e2e`를 돌리고 시나리오 A가 통과하는지 볼 것. \
             종료 코드만으로는 이 기준을 알 수 없다 — 다른 시나리오가 실패해도 같은 코드다.",
        ),
        check(
            "treeGuaranteedTrue",
            "`TreeKillOutcome.tree_guaranteed`가 Windows에서 true가 되고, 그 값이 UI 문구를 실제로 바꾼다.",
            CheckStatus::NeedsHuman,
            "**절반은 여기서 이미 지킨다** — 값에 따라 문구가 갈리는 것은 플랫폼과 무관한 \
             순수 분기이고 `tools/mod.rs`의 단위 테스트가 그 분기를 태운다. Windows에서 확인할 \
             나머지 절반은 '실제 취소에서 그 값이 true가 되는가'다.",
        ),
        check(
            "appNotInJob",
            "앱 자신이 job에 들어가지 않는다 — `AssignProcessToJobObject`는 자식 핸들에만 부른다.",
            CheckStatus::Passed,
            "플랫폼과 무관한 **소스 불변식**이므로 Windows를 기다리지 않는다. \
             `win_job.rs`를 훑는 테스트가 `verify`에서 지킨다.",
        ),
        check(
            "jobHandleLifetime",
            "job 핸들의 수명이 태스크와 같다 — 끝나면 닫히고, 닫히면 남은 프로세스가 죽는다.",
            CheckStatus::NeedsHuman,
            "핸들 수명은 **실행해야만 드러나는 종류**다(CLAUDE.md: 타입 검증은 동작 검증이 \
             아니다). Windows에서 취소·강제 포기를 각각 한 번씩 돌리고 남은 프로세스를 확인할 것.",
        ),
    ]
}

fn bundle_checks(obs: &Observations) -> Vec<Check> {
    let Some(dir) = obs.bundle_dir.as_ref() else {
        return vec![
            check(
                "bundleContents",
                "번들 안에 `sidecar/node.exe`와 `sidecar/index.js`가 있다.",
                CheckStatus::NotCheckableHere,
                "`--bundle <경로>`로 `tauri-build` 산출물을 가리키면 확인한다.",
            ),
            check(
                "runsWithoutNodeOnPath",
                "설치된 앱을 PATH에 node가 없는 머신에서 실행해 sidecar가 뜬다.",
                CheckStatus::NeedsHuman,
                "설치본을 node 없는 Windows에서 실행할 것.",
            ),
            check(
                "sourcesAreBundled",
                "그 실행에서 `ProgramSource`/`EntrySource`가 둘 다 `Bundled`다.",
                CheckStatus::NeedsHuman,
                "앱이 번들이 아닐 때 stderr로 알린다(session.rs) — 그 줄이 없어야 한다.",
            ),
            check(
                "bundleSizeRecorded",
                "번들 크기가 기록된다 — \"크기는 고려하지 않았다\"가 아니라 \"얼마인지 알고 받아들였다\"여야 한다.",
                CheckStatus::NotCheckableHere,
                "`--bundle <경로>`를 주면 재서 적는다.",
            ),
        ];
    };

    let node_exe = dir.join("sidecar").join("node.exe");
    let entry = dir.join("sidecar").join("index.js");
    let has_both = node_exe.is_file() && entry.is_file();
    let size = dir_size(dir);

    vec![
        check(
            "bundleContents",
            "번들 안에 `sidecar/node.exe`와 `sidecar/index.js`가 있다.",
            if has_both {
                CheckStatus::Passed
            } else {
                CheckStatus::Failed
            },
            format!(
                "node.exe={} index.js={} ({})",
                node_exe.is_file(),
                entry.is_file(),
                dir.display()
            ),
        ),
        check(
            "runsWithoutNodeOnPath",
            "설치된 앱을 PATH에 node가 없는 머신에서 실행해 sidecar가 뜬다.",
            CheckStatus::NeedsHuman,
            "번들에 파일이 있다는 것과 그것으로 뜬다는 것은 다른 사실이다.",
        ),
        check(
            "sourcesAreBundled",
            "그 실행에서 `ProgramSource`/`EntrySource`가 둘 다 `Bundled`다.",
            CheckStatus::NeedsHuman,
            "앱이 번들이 아닐 때 stderr로 알린다(session.rs) — 그 줄이 없어야 한다.",
        ),
        check(
            "bundleSizeRecorded",
            "번들 크기가 기록된다 — \"크기는 고려하지 않았다\"가 아니라 \"얼마인지 알고 받아들였다\"여야 한다.",
            if size > 0 {
                CheckStatus::Passed
            } else {
                CheckStatus::Failed
            },
            format!("{size} 바이트 ({:.1} MiB)", size as f64 / (1024.0 * 1024.0)),
        ),
    ]
}

fn credential_checks() -> Vec<Check> {
    // **기준은 있는데 기능이 없다.** 그 사실을 `Failed`로 적으면 "만들었는데 깨졌다"로 읽힌다.
    let why = "아직 환경변수에서 읽는다 — Credential Store는 구현되지 않았다.";
    vec![
        check(
            "storedThroughDpapi",
            "키를 앱 안에서 넣고 지울 수 있고, 저장이 Windows Credential Manager(DPAPI)를 지난다.",
            CheckStatus::NotImplemented,
            why,
        ),
        check(
            "noPlaintextAtRest",
            "저장 후 앱 디렉터리와 설정 어디에도 키 문자열이 평문으로 남지 않는다.",
            CheckStatus::NotImplemented,
            why,
        ),
        check(
            "uiNeverHoldsTheKey",
            "UI 프로세스는 키를 갖지 않는다 — 입력 즉시 Rust로 넘기고 이후 조회는 \"있다/없다\"만 돌려준다(원칙 3).",
            CheckStatus::NotImplemented,
            why,
        ),
        check(
            "injectionStaysOnce",
            "sidecar에는 여전히 spawn 시 1회 주입이고 허용 목록으로 걸러진다 — 저장소가 생겨도 `credential.get`이 되살아나지 않는다.",
            CheckStatus::NotImplemented,
            "8.2절이 지운 메서드다. 저장소를 만들면서 되살리고 싶어지는 자리이므로 기준으로 못박아 둔다.",
        ),
    ]
}

/// 명령 해석 — `tools/program.rs`. **Windows에서만 진짜로 검증된다.**
///
/// # 왜 이 항목이 빠져 있었는가
///
/// `program.rs`는 `cfg!(windows)`를 직접 읽지 않고 `Platform`을 인자로 받는다(그래야 Linux에서
/// 경로 조작을 검증할 수 있다). 그 덕분에 **`cfg(windows)`를 찾는 눈에는 안 보였고**, 착지
/// 목록에서도 빠져 있었다. 정작 CLAUDE.md가 가장 길게 적어둔 Windows 함정이 이것이다.
///
/// # 이 결함의 증상은 조용하다
///
/// `npm`이 `npm.cmd`라 실행에 실패하면 검증이 `SKIPPED_WITH_REASON`이 되고, 그러면 **정상 수정
/// 작업이 검증 없이 완료로 보고된다.** 그 상태는 화면에서 성공과 거의 같아 보인다 — 그래서
/// "돌려보고 괜찮더라"로는 확인되지 않고, **무엇을 봐야 하는지**를 여기 적어둔다.
///
/// 다행히 이제 관측 가능한 값이 하나 있다: 종합 판정이 `could_not_run`인지 여부다
/// (product-strategy 11.1절에서 `not_verified`를 둘로 가르면서 생겼다).
fn command_resolution_checks(obs: &Observations) -> Vec<Check> {
    let on_windows = obs.os == "windows";
    let unavailable = || {
        if on_windows {
            (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
        } else {
            (
                CheckStatus::NotCheckableHere,
                format!("여기는 {} — Windows 셸 해석은 이 플랫폼에서 볼 수 없다.", obs.os),
            )
        }
    };

    let (npm_status, npm_detail) = unavailable();
    let (skip_status, skip_detail) = unavailable();
    let (unknown_status, unknown_detail) = unavailable();

    vec![
        check(
            "npmResolvesToNodeCli",
            "Node 프로젝트에서 `npm test`가 `node.exe <...>\\npm-cli.js test`로 해석되어 실제로 돈다.",
            npm_status,
            format!(
                "{npm_detail} 실행 결과의 `resolvedCommand`에 node.exe와 npm-cli.js가 보여야 한다. \
                 nvm/volta/fnm/Scoop 설치는 구조가 다를 수 있고, 다르면 **추측하지 않고 실패하는** 것이 맞다."
            ),
        ),
        check(
            "verificationIsNotSilentlySkipped",
            "그 태스크의 종합 판정이 `could_not_run`이 아니다.",
            skip_status,
            format!(
                "{skip_detail} 이게 이 함정의 **유일하게 눈에 보이는 증상**이다 — \
                 해석이 실패하면 검증이 SKIPPED_WITH_REASON이 되고 작업이 검증 없이 완료로 보고된다."
            ),
        ),
        check(
            "unknownShimIsRefusedNotGuessed",
            "알려지지 않은 `.cmd`/`.bat`는 셸로 감싸지 않고 실패한다.",
            unknown_status,
            format!(
                "{unknown_detail} `cmd.exe /c`로 감싸면 인자의 `&`/`|`/`%`가 재해석되어 \
                 원칙 6(승인 화면의 argv = 실제 실행)이 무너진다."
            ),
        ),
    ]
}

/// 프로세스 트리 종료의 Windows 쪽 — `proctree.rs`. Job Object와 **다른 항목이다.**
///
/// Job Object는 트리 종료를 보장하고, 여기는 그 앞단(그룹 생성)과 뒤로 남겨둔 taskkill
/// 경로다(16.3절 — Job Object가 Windows에서 확인될 때까지 지우지 않는다).
fn process_group_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.os == "windows" {
        (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — `CREATE_NEW_PROCESS_GROUP`은 이 플랫폼에 없다.", obs.os),
        )
    };
    vec![
        check(
            "childGetsItsOwnProcessGroup",
            "자식이 `CREATE_NEW_PROCESS_GROUP`으로 뜨고, 앱에 Ctrl+C가 전파되지 않는다.",
            status.clone(),
            format!("{detail} 전파되면 사용자의 Ctrl+C가 앱 자체를 죽인다."),
        ),
        check(
            "taskkillFallbackStillWorks",
            "Job Object가 없는 경로에서도 `taskkill /T /F`가 트리를 거둔다.",
            status,
            format!(
                "{detail} taskkill은 **스냅샷 기반**이라 이미 고아가 된 손자를 놓칠 수 있다 — \
                 그 한계를 확인하는 것이지 완전함을 확인하는 것이 아니다."
            ),
        ),
    ]
}

/// 경로 정규화의 Windows 쪽 — `paths.rs`. **Policy Gate가 이 결과로 경계를 판정한다.**
fn path_normalization_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.os == "windows" {
        (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — `\\\\?\\` verbatim 프리픽스는 이 플랫폼에 없다.", obs.os),
        )
    };
    vec![
        check(
            "verbatimPrefixStripped",
            "워크스페이스 루트를 정규화한 결과에 `\\\\?\\`가 남지 않는다.",
            status.clone(),
            format!(
                "{detail} 남으면 게이트가 비교하는 두 문자열의 모양이 달라지고, \
                 **정상 경로가 경계 밖으로 판정될 수 있다.**"
            ),
        ),
        check(
            "uncPathsUntouched",
            "UNC 경로(`\\\\?\\UNC\\server\\share`)는 건드리지 않는다.",
            status,
            format!("{detail} 잘못 벗기면 경로가 깨져 접근 자체가 실패한다. 네트워크 드라이브에서 확인할 것."),
        ),
    ]
}

/// Python 가상환경 해석 (`python.rs`, state-machine 49절).
///
/// `msvc.rs`와 같은 자리다: **판정 로직은 여기서 검증되지만**(바깥 세계를 전부 인자로 받는다)
/// **그 경로가 실제로 실행되는지는 Windows에서만 확인된다.** 가상환경의 인터프리터 자리가
/// 플랫폼마다 다르고(bin/python vs Scripts/python.exe), 그 차이가 이 기능의 전부다.
fn python_env_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.os == "windows" {
        (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — Scripts/python.exe 레이아웃이 이 플랫폼에 없다.", obs.os),
        )
    };
    vec![
        check(
            "venvInterpreterRunsWithoutActivation",
            "활성화하지 않은 .venv의 Scripts/python.exe가 -m pytest를 실제로 돌린다.",
            status.clone(),
            format!(
                "{detail} 이 기능의 전제가 그것이다 — 활성화가 하는 일은 PATH 조작뿐이므로                  인터프리터를 직접 부르면 같은 결과가 나온다는 것. 틀리면 증상은                  `No module named pytest`이고, 그 문장은 사용자의 설치 문제로 읽힌다."
            ),
        ),
        check(
            "pythonOnPathIsNotTheStoreAlias",
            "PATH의 python이 Microsoft Store 별칭이 아니다.",
            status.clone(),
            format!(
                "{detail} Windows는 `python`/`python3`를 Store 설치 별칭으로 두는 경우가 있고,                  그것을 실행하면 프로그램이 아니라 **스토어 창이 뜬다** — 명령은 걸린 채로 끝나지 않는다.                  그래서 PATH 후보에서 `python3`를 뺐지만, `python` 쪽은 같은 위험이 남는다."
            ),
        ),
        check(
            "venvPathWithSpacesOrDriveLetterSurvives",
            "공백이나 드라이브 문자가 든 가상환경 경로가 그대로 실행된다.",
            status,
            format!(
                "{detail} C:/Users/내 문서/proj/.venv 처럼 공백이 든 경로가 흔하고,                  argv로 넘기므로 인용이 필요 없지만 **그 사실이 실제로 성립하는지는 실행해야 안다**."
            ),
        ),
    ]
}

/// 개발자 환경 준비 (`msvc.rs`, product-strategy 12.4절).
///
/// **이 묶음은 그물이 놓친 자리에서 왔다.** 위 검사(`windows_only_code_has_a_landing_check`)는
/// `cfg(windows)`나 `Platform::Windows`를 표식으로 삼는데, `msvc.rs`는 둘 다 쓰지 않는다 —
/// 바깥 세계를 전부 인자로 받아 Linux에서 검증할 수 있게 만들었기 때문이다. 그래서 표식이
/// 없고, 그물에도 안 걸린다. **판정 로직이 여기서 검증된다는 것과 그 동작이 Windows에서
/// 확인됐다는 것은 다른 사실이다.**
fn developer_env_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.os == "windows" {
        (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — vcvarsall.bat도 MSVC도 이 플랫폼에 없다.", obs.os),
        )
    };
    vec![
        check(
            "vcvarsallIsFoundOnARealMachine",
            "실제 설치에서 vcvarsall.bat을 찾는다 — 그리고 찾지 못하면 확인한 것을 전부 낸다.",
            status.clone(),
            format!(
                "{detail} 탐지 순서(override → vswhere → VSINSTALLDIR → 서브트리 검색)는 Linux에서 검증되지만,                  **실제 설치 구조는 여기서 볼 수 없다** — 실측 머신의 경로는 드라이브도 버전 디렉터리도                  하드코딩 후보와 전부 달랐다."
            ),
        ),
        check(
            "cargoBuildLinksWithoutADeveloperShell",
            "개발자 셸이 아닌 곳에서 시작한 앱이 `cargo build`를 링크까지 성공시킨다.",
            status.clone(),
            format!(
                "{detail} 이게 이 기능의 **유일하게 눈에 보이는 증상**이다 — 준비가 안 되면                  `stdarg.h: No such file or directory`로 실패하고, 그 문장은 \"C 컴파일러가 없다\"로 읽힌다."
            ),
        ),
        check(
            "msvcLinkWinsOverGitLink",
            "Git for Windows가 PATH에 있어도 `link.exe`가 MSVC의 것으로 해석된다.",
            status.clone(),
            format!(
                "{detail} 준비한 PATH가 우리 PATH **앞에** 와야 성립한다. 증상은                  `link: extra operand`이고, rustc가 붙이는 힌트는 이 경우 오도한다."
            ),
        ),
        check(
            "aFailedPreparationDoesNotBlockTheCommand",
            "준비하지 못해도 명령은 그대로 실행되고, 확인 목록이 결과에 남는다.",
            status,
            format!(
                "{detail} 막지 않는 이유는 탐지가 틀릴 수 있기 때문이다(GNU 툴체인 프로젝트).                  **막았는데 틀린 경우**가 못 준비한 채 실행하는 것보다 나쁘다."
            ),
        ),
    ]
}

/// Windows 전용 동작이 있는데 **착지 목록에 없어도 되는** 파일과 그 이유.
///
/// 목록으로 두는 이유는 `METRICS_WITHOUT_QUESTION`과 같다: 새로 Windows 분기를 넣을 때
/// "착지 검사를 붙이거나, 여기 이유를 적거나" 둘 중 하나를 하게 만든다. 아무 말 없이
/// 지나가는 길을 없앤다.
pub const WINDOWS_FILES_WITHOUT_LANDING: &[(&str, &str)] = &[(
    "lib.rs",
    "모듈 선언뿐이다 — 동작은 win_job.rs에 있고 그쪽이 착지 목록에 있다",
)];

/// 관측을 기준에 대본다. **아무것도 실행하지 않고 아무것도 쓰지 않는다.**
/// 파일 쓰기 실패의 판정 (`file_errors.rs`, state-machine 65절).
///
/// **판정 로직은 Linux에서 값으로 검증된다** — 플랫폼과 오류를 인자로 받기 때문이다.
/// 그런데 그 인자가 **실제로 그 값으로 오는지**는 Windows에서만 알 수 있고, 그게 이 묶음이
/// 있는 이유다. 코드가 맞아도 실제 오류가 다른 코드로 오면 판정은 조용히 사라진다.
fn file_failure_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.os == "windows" {
        (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — 파일 잠금도 MAX_PATH도 이 플랫폼에 없다.", obs.os),
        )
    };
    vec![
        check(
            "aLockedFileReportsSharingViolation",
            "편집기가 열어 둔 파일에 쓰면 실제로 32번(공유 위반)이 온다.",
            status.clone(),
            format!(
                "{detail} 판정은 이 코드에 걸려 있다. 다른 코드가 오면 처방이 조용히 사라지고,                  남는 것은 다시 OS의 문장 하나다 — 고치기 전과 같은 상태이면서 고쳤다고 믿는 상태다."
            ),
        ),
        check(
            "aTooLongPathReportsFilenameExcedRange",
            "260자를 넘는 경로에 쓰면 206번이 온다 — 접근 거부(5번)가 아니라.",
            status.clone(),
            format!(
                "{detail} 둘 중 무엇이 오는지에 따라 사용자가 받는 처방이 갈린다. 5번이 오면                  \"권한을 확인하세요\"가 나가는데, 그건 경로를 줄여야 하는 사용자에게 틀린 처방이다."
            ),
        ),
        check(
            "theLocaleDoesNotChangeTheVerdict",
            "한국어 Windows에서도 같은 판정이 나온다.",
            status.clone(),
            format!(
                "{detail} 코드로 판정하므로 성립해야 하지만, **그것이 이 판정을 만든 이유**다 —                  문자열로 판정했다면 영어 로케일에서만 동작하고 그 사실은 개발자의 기계에서 드러나지 않는다."
            ),
        ),
        check(
            "aPermanentFailureStopsTheRetryLoop",
            "재시도할 값어치가 없는 실패에서 오케스트레이터가 상한을 기다리지 않는다.",
            status,
            format!(
                "{detail} 판정이 Node까지 닿는지는 e2e가 보지만, **실제 Windows 오류로 그 경로가                  도는지**는 여기서만 확인된다."
            ),
        ),
    ]
}

pub fn assess(obs: &Observations) -> LandingReport {
    let groups = vec![
        {
            let checks = job_object_checks(obs);
            Group {
                id: "jobObject",
                documented_at: "state-machine-and-protocol.md 20.6절",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = bundle_checks(obs);
            Group {
                id: "sidecarBundle",
                documented_at: "process-architecture.md 10.4절",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = credential_checks();
            Group {
                id: "credentialStore",
                documented_at: "multi-engine-routing.md 12절",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = command_resolution_checks(obs);
            Group {
                id: "commandResolution",
                documented_at: "state-machine-and-protocol.md 19절 (`tools/program.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = process_group_checks(obs);
            Group {
                id: "processGroup",
                documented_at: "state-machine-and-protocol.md 16.3절 (`proctree.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = developer_env_checks(obs);
            Group {
                id: "developerEnv",
                documented_at: "product-strategy.md 12.4절 (`msvc.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = python_env_checks(obs);
            Group {
                id: "pythonEnv",
                documented_at: "state-machine-and-protocol.md 49절 (`python.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = path_normalization_checks(obs);
            Group {
                id: "pathNormalization",
                documented_at: "process-architecture.md 4절 (`paths.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
        {
            let checks = file_failure_checks(obs);
            Group {
                id: "fileFailureDiagnosis",
                documented_at: "state-machine-and-protocol.md 65절 (`file_errors.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
    ];

    let all: Vec<&Check> = groups.iter().flat_map(|g| g.checks.iter()).collect();
    let verdict = if all.iter().any(|c| c.status == CheckStatus::Failed) {
        Verdict::NotLanded
    } else if all.iter().all(|c| c.status.is_pass()) {
        Verdict::Landed
    } else {
        Verdict::Incomplete
    };

    let remaining = all
        .iter()
        .filter(|c| !c.status.is_pass())
        .map(|c| format!("[{}] {} — {}", c.id, c.criterion, c.detail))
        .collect();

    LandingReport {
        platform: obs.os.clone(),
        groups,
        verdict,
        remaining,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux() -> Observations {
        Observations {
            os: "linux".to_string(),
            bundle_dir: None,
        }
    }

    /// **확인하지 못한 것은 통과가 아니다.** 이 규칙이 이 모듈의 존재 이유다.
    #[test]
    fn unchecked_criteria_never_add_up_to_landed() {
        let report = assess(&linux());
        assert_eq!(report.verdict, Verdict::Incomplete);
        assert!(!report.remaining.is_empty());
    }

    /// 실패가 하나라도 있으면 "확인 못 함"과 섞이지 않는다 — 고칠 것이 있다는 사실이 이긴다.
    #[test]
    fn a_failure_outranks_the_unchecked_ones() {
        let checks = vec![
            check("a", "c", CheckStatus::Passed, ""),
            check("b", "c", CheckStatus::NeedsHuman, ""),
            check("c", "c", CheckStatus::Failed, ""),
        ];
        assert_eq!(verdict_of(&checks), Verdict::NotLanded);
    }

    #[test]
    fn all_passed_is_the_only_way_to_land() {
        let checks = vec![
            check("a", "c", CheckStatus::Passed, ""),
            check("b", "c", CheckStatus::Passed, ""),
        ];
        assert_eq!(verdict_of(&checks), Verdict::Landed);

        for blocked in [
            CheckStatus::NotCheckableHere,
            CheckStatus::NeedsHuman,
            CheckStatus::NotImplemented,
        ] {
            let mixed = vec![
                check("a", "c", CheckStatus::Passed, ""),
                check("b", "c", blocked.clone(), ""),
            ];
            assert_eq!(verdict_of(&mixed), Verdict::Incomplete, "{blocked:?}");
        }
    }

    /// Linux에서 Windows 전용 기준을 통과로 세면 안 된다. **여기서 통과한 verify가 그 코드에
    /// 대해 아무것도 말하지 않는다**는 사실이 보고서에도 그대로 남아야 한다.
    #[test]
    fn windows_only_criteria_are_not_checkable_on_linux() {
        let report = assess(&linux());
        let job = report.groups.iter().find(|g| g.id == "jobObject").unwrap();
        let build = job.checks.iter().find(|c| c.id == "coreBuild").unwrap();
        assert_eq!(build.status, CheckStatus::NotCheckableHere);
        assert!(build.detail.contains("linux"), "{}", build.detail);
    }

    /// 번들 경로를 주면 볼 수 있는 것이 늘어난다 — 그리고 없는 파일은 **실패**다
    /// ("확인 못 함"이 아니다: 봤는데 없었다).
    #[test]
    fn a_bundle_without_the_runtime_is_a_failure_not_an_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
        };
        let report = assess(&obs);
        let bundle = report.groups.iter().find(|g| g.id == "sidecarBundle").unwrap();
        let contents = bundle.checks.iter().find(|c| c.id == "bundleContents").unwrap();
        assert_eq!(contents.status, CheckStatus::Failed);
        assert_eq!(bundle.verdict, Verdict::NotLanded);
    }

    #[test]
    fn a_bundle_with_the_runtime_passes_and_records_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("sidecar");
        std::fs::create_dir_all(&sidecar).unwrap();
        std::fs::write(sidecar.join("node.exe"), vec![0u8; 2048]).unwrap();
        std::fs::write(sidecar.join("index.js"), "console.log(1);").unwrap();

        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
        };
        let report = assess(&obs);
        let bundle = report.groups.iter().find(|g| g.id == "sidecarBundle").unwrap();
        assert_eq!(
            bundle.checks.iter().find(|c| c.id == "bundleContents").unwrap().status,
            CheckStatus::Passed
        );
        let size = bundle.checks.iter().find(|c| c.id == "bundleSizeRecorded").unwrap();
        assert_eq!(size.status, CheckStatus::Passed);
        // 크기를 **적는다**. "기록된다"가 기준이므로 숫자가 없으면 통과가 아니다.
        assert!(size.detail.contains("2"), "{}", size.detail);
    }

    /// 만들지 않은 것은 실패가 아니다 — 다음에 할 일이 다르다.
    #[test]
    fn an_unbuilt_feature_is_not_a_failure() {
        let report = assess(&linux());
        let cred = report.groups.iter().find(|g| g.id == "credentialStore").unwrap();
        assert!(cred.checks.iter().all(|c| c.status == CheckStatus::NotImplemented));
        assert_eq!(cred.verdict, Verdict::Incomplete);
    }

    /// 기준 문장이 비어 있으면 이 보고서는 id 목록일 뿐이다.
    #[test]
    fn every_check_carries_the_documented_sentence() {
        let report = assess(&linux());
        let mut ids = std::collections::BTreeSet::new();
        for group in &report.groups {
            assert!(!group.documented_at.is_empty(), "{}", group.id);
            for c in &group.checks {
                assert!(!c.criterion.is_empty(), "{}", c.id);
                assert!(!c.detail.is_empty(), "{}", c.id);
                assert!(ids.insert(c.id), "id가 겹칩니다: {}", c.id);
            }
        }
    }
    // ---- 소스 불변식: 앱 자신이 job에 들어가지 않는다 (20.6절 4번) ----
    //
    // `win_job.rs`는 이 규칙을 주석에 적어두고 **"리뷰에서 멈춰야 한다"**고 말한다. 사람이
    // 지키는 규칙은 언젠가 빠지고, 이 규칙이 빠지면 증상은 **앱이 스스로 죽는 것**이다
    // (KILL_ON_JOB_CLOSE job에 우리 프로세스가 들어가면 Drop이 앱을 죽인다).
    //
    // 이 파일은 Linux에서 컴파일되지 않지만 **텍스트로는 읽힌다.** 그래서 Windows를 기다리지
    // 않고 여기서 지킨다 — 착지 보고서가 이 항목을 `Passed`로 적는 근거가 이 테스트다.

    /// **주석을 뺀 코드만** 돌려준다.
    ///
    /// `win_job.rs`는 금지된 심볼의 이름을 주석에 적어 "쓰지 말 것"이라고 말한다. 주석까지
    /// 훑으면 그 금지 문장 자체가 위반으로 잡힌다 — 규칙을 적어두는 것이 규칙을 어기는 것이
    /// 되는 셈이다. CLAUDE.md의 "소스를 검사하는 테스트는 자기 자신을 센다"와 같은 함정이고,
    /// 실제로 이 테스트가 처음에 거기 걸렸다. **규칙은 코드에 대한 것이므로 검사도 코드만 본다.**
    fn win_job_code() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("win_job.rs");
        let source =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}를 읽지 못했습니다: {e}", path.display()));
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_app_never_puts_itself_into_the_job() {
        let source = win_job_code();
        // 빈 문자열에 대해 통과하는 검사를 허용하지 않는다 — 주석을 지우고도 코드가 남아야 한다.
        assert!(source.len() > 500, "win_job.rs 코드를 못 읽었습니다");

        // needle을 런타임에 조립한다 — 이 파일 자신이 검색 대상이 될 때 개수가 어긋난다.
        let forbidden = "GetCurrent".to_string() + "Process";
        assert!(
            !source.contains(&forbidden),
            "{forbidden}가 win_job.rs에 있습니다 — 앱이 자기 job에 들어가면 Drop이 앱을 죽입니다"
        );

        let assign = "AssignProcessTo".to_string() + "JobObject(";
        let calls = source.matches(&assign).count();
        // import 한 번, 호출 한 번. 호출이 늘면 "부르는 곳이 하나뿐"이라는 근거가 사라진다.
        assert_eq!(calls, 1, "job 배정 호출이 {calls}개입니다 — 하나여야 합니다");

        // 그 하나의 인자가 자식 핸들에서 온다.
        //
        // 닫는 괄호로 자르지 않는다 — 인자 안에 `as_raw_handle()`의 괄호가 있어서 첫 `)`는
        // 호출의 끝이 아니다. 줄 끝까지 보는 편이 단순하고 틀리지 않는다.
        let call = source.split(&assign).nth(1).unwrap_or_default();
        let args = call.lines().next().unwrap_or_default();
        assert!(
            args.contains("child.as_raw_handle"),
            "job 배정 인자가 자식 핸들이 아닙니다: {args}"
        );
    }

    /// **Windows 전용 동작에는 착지 검사가 있는가.**
    ///
    /// 이 검사가 없을 때 `tools/program.rs`가 목록에서 빠져 있었다 — 하필 CLAUDE.md가 가장 길게
    /// 적어둔 Windows 함정인데도. 빠진 이유가 시사적이다: 그 파일은 `cfg!(windows)`를 직접 읽지
    /// 않고 `Platform`을 인자로 받으므로(그래야 Linux에서 경로 조작을 검증할 수 있다)
    /// **`cfg(windows)`만 찾는 눈에는 보이지 않았다.** 그래서 두 표식을 함께 본다.
    ///
    /// 이건 타입 검사의 대체물이 아니라 **그물**이다. Windows 전용 동작이 두 표식 없이
    /// 들어오면 이 검사도 놓친다 — 그때는 사람이 알아채는 수밖에 없고, 그 사실을 여기 적어둔다.
    #[test]
    fn windows_only_code_has_a_landing_check_or_a_reason() {
        use std::fs;
        use std::path::PathBuf;

        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let landing = fs::read_to_string(src.join("landing.rs")).expect("landing.rs를 읽지 못했습니다");

        fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).expect("소스 디렉터리를 읽지 못했습니다") {
                let path = entry.expect("항목을 읽지 못했습니다").path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(&src, &mut files);

        // needle을 런타임에 조립한다 — 소스에 그대로 적으면 이 파일이 자기 자신에 걸린다.
        let cfg_needle = format!("cfg({})", "windows");
        let platform_needle = format!("Platform::{}", "Windows");

        let mut windows_files: Vec<String> = Vec::new();
        for file in &files {
            let name = file.file_name().unwrap().to_string_lossy().to_string();
            if name == "landing.rs" {
                continue;
            }
            let text = fs::read_to_string(file).expect("소스를 읽지 못했습니다");
            if text.contains(&cfg_needle) || text.contains(&platform_needle) {
                windows_files.push(name);
            }
        }

        // 빈 집합에 대해 통과하는 검사를 허용하지 않는다 — 스캔이 깨지면 "위반 없음"과
        // "파일 없음"이 같은 초록색으로 보인다.
        assert!(
            windows_files.len() >= 3,
            "Windows 분기가 있는 파일을 읽지 못했습니다: {windows_files:?}"
        );

        let exempt: Vec<&str> = WINDOWS_FILES_WITHOUT_LANDING.iter().map(|(f, _)| *f).collect();
        let orphans: Vec<&String> = windows_files
            .iter()
            .filter(|f| !landing.contains(f.as_str()) && !exempt.contains(&f.as_str()))
            .collect();
        assert!(
            orphans.is_empty(),
            "Windows 전용 동작인데 착지 검사가 없습니다: {orphans:?} — \
             기준을 landing.rs에 적거나 WINDOWS_FILES_WITHOUT_LANDING에 이유를 적을 것"
        );
    }

    #[test]
    fn windows_landing_exemptions_carry_a_reason() {
        for (file, reason) in WINDOWS_FILES_WITHOUT_LANDING {
            assert!(!reason.trim().is_empty(), "{file}의 면제 이유가 비어 있습니다");
        }
    }

}
