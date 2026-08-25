//! Windows 개발자 환경 — **명령마다 붙는 세금을 우리가 낸다.**
//!
//! product-strategy 12.3·12.4절이 이 제품의 Windows 해자를 셋으로 좁혔고, 투자 우선순위를
//! "명령 실행 계층 먼저"로 정했다. 그 목록의 첫 줄이 **"개발자 환경 자동 해석 후 명령 실행
//! (vcvarsall 상당, MSVC/GNU 도구 충돌 해소)"** 이다. 이 모듈이 그것이다.
//!
//! # 무엇이 문제인가
//!
//! Windows에서 `cargo build`를 그냥 실행하면 두 가지로 실패한다. 둘 다 이 저장소가 **직접
//! 겪었고** CLAUDE.md에 적혀 있다.
//!
//! - `INCLUDE`/`LIB`가 없으면 컴파일은 되는데 **링크에서** 실패한다. 증상은
//!   `stdarg.h: No such file or directory`이고, 그 문장은 "C 컴파일러가 없다"로 읽힌다 —
//!   실제로는 있는데 헤더 경로를 모르는 것이다.
//! - Git for Windows의 GNU `link.exe`(하드링크 유틸리티)가 PATH에서 MSVC `link.exe`를 **가린다.**
//!   증상은 `link: extra operand`이고, rustc가 붙이는 "C++ 빌드 도구를 설치하세요" 힌트는
//!   이 경우 **오도한다.**
//!
//! 사람이 이걸 푸는 방법은 `vcvarsall.bat`을 거쳐 셸을 여는 것이다. 그런데 그건 **셸 하나에만**
//! 적용된다 — 우리처럼 명령마다 프로세스를 새로 띄우는 실행기에게는 매번 붙는 세금이다.
//!
//! # 무엇을 하고 무엇을 하지 않는가
//!
//! 하는 일: MSVC를 필요로 하는 명령을 알아보고, 그 명령의 **자식 환경에만** 개발자 환경을
//! 넣는다. 우리 프로세스의 환경은 건드리지 않는다 — 건드리면 이 앱이 도는 동안 시작된 모든
//! 것이 조용히 달라진다.
//!
//! 하지 않는 일: **명령을 막지 않는다.** 탐지가 틀릴 수 있고(GNU 툴체인을 쓰는 프로젝트,
//! 링크가 필요 없는 명령), 틀린 판정으로 되는 명령을 막는 것이 못 준비한 채 실행하는 것보다
//! 나쁘다. 준비하지 못했으면 **무엇을 확인했는지 남기고 그대로 실행한다** — 그러면 실패했을 때
//! 사용자가 `stdarg.h` 대신 우리 기록을 읽는다(12.3① 사전 점검 vs 사후 부검).
//!
//! # 원칙 6과의 관계
//!
//! `run_command`가 셸 문자열을 받지 않는다는 약속은 **사용자의 명령**에 대한 것이다. 여기서
//! `cmd.exe`를 부르는 것은 사용자의 명령이 아니라 **우리가 고정한 배치 파일**이고, 그 인자는
//! 전부 우리가 만든다 — 모델도 사용자도 그 문자열에 한 글자도 기여하지 않는다. 사용자의
//! 명령은 여전히 argv 배열 그대로, 셸 없이 실행된다.
//!
//! 그리고 환경은 **argv가 아니다.** 승인 화면이 보여준 argv는 그대로이지만 환경은 달라지므로,
//! 무엇을 넣었는지 기록에 남긴다 — 훅의 `injectedEnv`와 같은 규율이다(33.5절).
//!
//! # 값을 통째로 덤프하지 않는다
//!
//! `set`은 환경 **전체**를 찍는다. 우리 프로세스는 자격증명을 다룰 수 있으므로 그 출력에 키가
//! 섞일 수 있고, 그러면 키가 버퍼에 들어온다(`scripts/msvc-env.bat`이 같은 이유로 전체 덤프를
//! 하지 않는다). 그래서 **필요한 이름만 물어보고**, 파싱도 그 목록 밖은 버린다.
//!
//! # 테스트 가능성
//!
//! 이 저장소의 개발 환경은 Linux이고 대상은 Windows다. `tools/program.rs`가 그랬듯 **바깥
//! 세계를 전부 인자로 받는다** — 환경변수 조회, 파일 존재, vswhere 실행, 서브트리 검색.
//! 그래야 탐지 순서와 실패 문장을 여기서 검증할 수 있다. 실제 실행만 Windows에서 확인된다
//! (landing.rs의 `developerEnv` 묶음).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 이 명령이 MSVC 개발자 환경을 필요로 하는가. **순수 함수다.**
///
/// # 목록을 넓게 잡지 않는다
///
/// 준비는 공짜가 아니다(프로세스 하나를 띄운다). 그리고 **틀리게 넓히면** 관계없는 명령의
/// 환경이 조용히 달라진다. 그래서 "MSVC 링커/헤더를 실제로 지나는 명령"만 넣는다.
///
/// `cargo`는 하위 명령을 가리지 않는다 — `check`조차 build script를 컴파일하면 링크를 지나고,
/// 그 실패는 `cargo check`가 실패한 것으로 보인다. 가리려면 하위 명령별 지식을 우리가 들고
/// 있어야 하는데, 그 목록이 틀리는 쪽이 더 나쁘다.
pub fn needs_msvc(program: &str, _args: &[String]) -> bool {
    let base = crate::policy::command::program_basename(program).to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    matches!(base, "cargo" | "rustc" | "cl" | "link" | "lib" | "nmake" | "msbuild" | "cmake")
}

/// 이 명령에 개발자 환경을 붙이는가 — 플랫폼까지 포함한 판정.
///
/// **`Platform`을 인자로 받는다.** `cfg!(windows)`를 여기서 읽으면 이 판정이 Linux에서
/// 검증되지 않고, 그러면 "Windows에서만 도는 코드"가 아무 검사 없이 늘어난다
/// (`tools/program.rs`가 같은 이유로 같은 모양이다).
pub fn applies(platform: crate::tools::program::Platform, program: &str, args: &[String]) -> bool {
    platform == crate::tools::program::Platform::Windows && needs_msvc(program, args)
}

/// vcvarsall.bat을 **어떻게** 찾았는가. 기록에 남는다 — 못 찾았을 때 사용자가 확인할 곳이
/// 어디인지가 여기서 갈린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum How {
    /// `TOMVERSE_VCVARSALL` — 탐지가 실패하는 머신의 최종 답.
    Override,
    VsWhere,
    /// 이미 VS 개발자 셸 안에서 앱이 시작된 경우.
    VsInstallDir,
    /// Program Files 아래 서브트리 **검색**. 목록이 아니다.
    Search,
}

/// 탐지 과정에서 **확인한 것 하나**.
///
/// 실패했을 때 "설치되어 있지 않은 것으로 보입니다"만 말하면 설치되어 있는 사용자가 할 수
/// 있는 일이 없다. 무엇을 어디까지 봤는지 전부 남긴다(`msvc-doctor`가 우리에게 하는 일).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub what: &'static str,
    pub value: String,
    pub result: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub vcvarsall: Option<PathBuf>,
    pub how: Option<How>,
    pub checked: Vec<Checked>,
}

/// 탐지에 필요한 바깥 세계. **전부 주입한다** — 그래야 Windows 분기를 Linux에서 검증할 수 있다.
pub struct Probe<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub is_file: &'a dyn Fn(&Path) -> bool,
    /// vswhere에 인자를 주고 설치 경로 목록을 받는다. 실행할 수 없으면 빈 목록.
    pub vswhere: &'a dyn Fn(&Path, &[&str]) -> Vec<String>,
    /// 이 디렉터리 아래 `Microsoft Visual Studio` 서브트리에서 vcvarsall.bat을 찾는다.
    pub search: &'a dyn Fn(&Path) -> Option<PathBuf>,
}

/// 설치 경로에서 vcvarsall.bat의 자리. **경로 조립을 한 곳에 둔다** — 두 곳에 적으면
/// 한쪽만 고쳐진다.
pub fn vcvarsall_in(install_dir: &str) -> PathBuf {
    Path::new(install_dir).join("VC").join("Auxiliary").join("Build").join("vcvarsall.bat")
}

/// vswhere에 넘기는 질의들. **`-latest`를 쓰지 않는다.**
///
/// 실측 머신에 설치가 둘 있었고 **최신(VS 18 Enterprise)에 C++ 빌드 도구가 없었다** — 도구가
/// 있는 것은 더 오래된 2022 BuildTools였다. `-latest`는 가장 새 설치 하나만 주므로 그것이 쓸
/// 수 없으면 나머지를 보지 않고 실패한다. `-all`로 전부 받아 **vcvarsall.bat이 실제로 있는**
/// 첫 항목을 쓴다.
///
/// 그리고 `-requires`도 최종 판정이 아니다. 새 버전이 컴포넌트 ID를 바꾸면 빗나가므로,
/// 워크로드 선언과 무관하게 받는 질의를 마지막에 둔다 — **파일 존재가 정본이다.**
const VSWHERE_QUERIES: &[&[&str]] = &[
    &[
        "-all",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
    ],
    &[
        "-all",
        "-prerelease",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
    ],
    &["-all", "-prerelease", "-products", "*", "-property", "installationPath"],
];

/// vcvarsall.bat을 찾는다. 순서는 `scripts/_env.bat`과 **같아야 한다** — 제품과 우리 빌드
/// 스크립트가 다른 설치를 고르면, 우리 환경에서 되는 것이 사용자 환경에서 안 되는 상태가 된다.
pub fn detect(probe: &Probe<'_>) -> Detection {
    let mut checked = Vec::new();
    let mut note = |what: &'static str, value: String, result: String| {
        checked.push(Checked { what, value, result });
    };

    // ---- 1) 명시적 override. 탐지가 실패하는 머신의 최종 답이다. ----
    let override_path = (probe.env)("TOMVERSE_VCVARSALL");
    match &override_path {
        Some(path) if (probe.is_file)(Path::new(path)) => {
            note("TOMVERSE_VCVARSALL", path.clone(), "찾음".to_string());
            return Detection {
                vcvarsall: Some(PathBuf::from(path)),
                how: Some(How::Override),
                checked,
            };
        }
        Some(path) => note("TOMVERSE_VCVARSALL", path.clone(), "그 경로에 파일이 없음".to_string()),
        None => note("TOMVERSE_VCVARSALL", String::new(), "설정되지 않음".to_string()),
    }

    // ---- 2) vswhere ----
    let program_dirs: Vec<String> = ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(|name| (probe.env)(name))
        .collect();
    let mut vswhere_path: Option<PathBuf> = None;
    for dir in &program_dirs {
        let candidate = Path::new(dir).join("Microsoft Visual Studio").join("Installer").join("vswhere.exe");
        if (probe.is_file)(&candidate) {
            vswhere_path = Some(candidate);
            break;
        }
    }
    // PATH에 단독 설치된 vswhere도 정당한 조회 도구다.
    if vswhere_path.is_none() {
        if let Some(found) = (probe.env)("TOMVERSE_VSWHERE").filter(|p| (probe.is_file)(Path::new(p))) {
            vswhere_path = Some(PathBuf::from(found));
        }
    }

    match &vswhere_path {
        None => note(
            "vswhere.exe",
            program_dirs.join(", "),
            "Installer 고정 위치에서 찾지 못함".to_string(),
        ),
        Some(vswhere) => {
            note("vswhere.exe", vswhere.display().to_string(), "찾음".to_string());
            for query in VSWHERE_QUERIES {
                for install in (probe.vswhere)(vswhere, query) {
                    let candidate = vcvarsall_in(&install);
                    if (probe.is_file)(&candidate) {
                        note("vswhere가 알려준 설치", install, "vcvarsall.bat 있음".to_string());
                        return Detection {
                            vcvarsall: Some(candidate),
                            how: Some(How::VsWhere),
                            checked,
                        };
                    }
                    note("vswhere가 알려준 설치", install, "vcvarsall.bat 없음".to_string());
                }
            }
            note(
                "vswhere 조회 결과",
                String::new(),
                "vcvarsall.bat이 있는 설치를 알려주지 않음".to_string(),
            );
        }
    }

    // ---- 3) 이미 VS 개발자 셸 안인 경우 ----
    match (probe.env)("VSINSTALLDIR") {
        Some(dir) => {
            let candidate = vcvarsall_in(&dir);
            if (probe.is_file)(&candidate) {
                note("VSINSTALLDIR", dir, "찾음".to_string());
                return Detection {
                    vcvarsall: Some(candidate),
                    how: Some(How::VsInstallDir),
                    checked,
                };
            }
            note("VSINSTALLDIR", dir, "그 아래에 vcvarsall.bat이 없음".to_string());
        }
        None => note("VSINSTALLDIR", String::new(), "설정되지 않음".to_string()),
    }

    // ---- 4) 서브트리 검색. **목록이 아니라 검색이다** ----
    for dir in &program_dirs {
        if let Some(found) = (probe.search)(Path::new(dir)) {
            note("Program Files 검색", dir.clone(), "찾음".to_string());
            return Detection {
                vcvarsall: Some(found),
                how: Some(How::Search),
                checked,
            };
        }
        note("Program Files 검색", dir.clone(), "찾지 못함".to_string());
    }

    Detection {
        vcvarsall: None,
        how: None,
        checked,
    }
}

/// 탐지 실패를 사용자가 **할 수 있는 일**로 옮긴다.
///
/// 두 경우의 답이 다르다 — vswhere가 설치를 알려줬는데 vcvarsall이 없으면 워크로드가 빠진
/// 것이고, vswhere 자체가 없으면 우리가 못 찾은 것이다.
pub fn advice(detection: &Detection) -> String {
    let saw_vswhere = detection
        .checked
        .iter()
        .any(|c| c.what == "vswhere.exe" && c.result == "찾음");
    if saw_vswhere {
        "Visual Studio는 찾았지만 C++ 빌드 도구가 있는 설치를 찾지 못했습니다. \
         Visual Studio Installer에서 \"C++를 사용한 데스크톱 개발\" 워크로드를 추가하세요."
            .to_string()
    } else {
        "Visual Studio 설치를 찾지 못했습니다. 설치되어 있다면 위치를 직접 알려주세요: \
         환경변수 TOMVERSE_VCVARSALL 에 <설치 경로>\\VC\\Auxiliary\\Build\\vcvarsall.bat 를 넣고 앱을 다시 시작하세요."
            .to_string()
    }
}

/// vcvarsall이 설정한 것 중 **우리가 가져가는 변수**.
///
/// 전체를 가져가지 않는 이유는 모듈 문서에 있다 — 우리 프로세스의 환경에는 자격증명이 있을 수
/// 있고, 전체 덤프는 그것을 버퍼로 옮긴다.
pub const CAPTURED: &[&str] = &[
    "PATH",
    "INCLUDE",
    "LIB",
    "LIBPATH",
    "VSINSTALLDIR",
    "VCINSTALLDIR",
    "VCToolsInstallDir",
    "WindowsSdkDir",
    "WindowsSDKVersion",
];

/// 환경을 물어보는 명령. **인자를 전부 우리가 만든다** — 모델도 사용자도 기여하지 않는다.
///
/// `set` 전체가 아니라 이름을 하나씩 묻는 이유는 위와 같다. `set NAME`은 그 접두사로 시작하는
/// 변수만 찍으므로, 우리가 아는 이름만 버퍼에 들어온다.
pub fn probe_argv(vcvarsall: &Path, arch: &str) -> Vec<String> {
    let mut script = format!("\"{}\" {arch}", vcvarsall.display());
    for name in CAPTURED {
        script.push_str(&format!(" && set {name}"));
    }
    vec!["/c".to_string(), script]
}

/// `set NAME` 출력들을 파싱한다. **목록 밖의 이름은 버린다.**
///
/// 값에 `=`가 들어갈 수 있으므로 첫 `=`에서만 자른다(PATH가 그렇다). 이름 비교는 대소문자를
/// 무시한다 — Windows 환경변수는 대소문자를 가리지 않고, `cmd`가 찍는 표기는 설정한 쪽을 따른다.
pub fn parse_env_dump(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let Some(canonical) = CAPTURED.iter().find(|c| c.eq_ignore_ascii_case(name)) else {
            continue;
        };
        let value = value.trim_end_matches(['\r', '\n']);
        if value.is_empty() {
            continue;
        }
        out.insert((*canonical).to_string(), value.to_string());
    }
    out
}

/// 준비의 결말. **셋을 뭉개지 않는다** — 사용자가 다음에 할 일이 서로 다르다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preparation {
    Prepared {
        how: How,
        from: PathBuf,
        /// 넣은 변수의 **이름만**. 값은 경로라 길고, 기록에서 읽을 것은 "무엇이 붙었는가"다.
        names: Vec<String>,
        #[serde(skip)]
        vars: BTreeMap<String, String>,
    },
    /// 설치를 찾지 못했다. 확인한 것을 전부 담는다.
    NotFound { checked: Vec<Checked>, advice: String },
    /// vcvarsall은 있는데 환경이 잡히지 않았다.
    ///
    /// **이 경우를 따로 두는 이유**: vcvarsall이 0으로 끝나고도 `INCLUDE`가 비는 일이 실제로
    /// 있다(설치 손상, 아키텍처 불일치). 여기서 거르지 않으면 나중에 `stdarg.h` 같은 **원인과
    /// 먼 증상**으로만 드러난다.
    Broken { from: PathBuf, detail: String },
}

impl Preparation {
    pub fn vars(&self) -> BTreeMap<String, String> {
        match self {
            Self::Prepared { vars, .. } => vars.clone(),
            _ => BTreeMap::new(),
        }
    }

    /// 화면과 기록에 한 줄로 남길 문장.
    pub fn summary(&self) -> String {
        match self {
            Self::Prepared { from, names, .. } => {
                format!("개발자 환경을 준비했습니다 ({} 개 변수, {})", names.len(), from.display())
            }
            Self::NotFound { advice, .. } => {
                format!("개발자 환경을 준비하지 못했습니다 — 그대로 실행합니다. {advice}")
            }
            Self::Broken { from, detail } => {
                format!("개발자 환경 준비가 불완전합니다 ({}): {detail} — 그대로 실행합니다.", from.display())
            }
        }
    }
}

/// 탐지 + 실행 + 파싱. `run`이 `cmd.exe` 실행을 대신한다(테스트가 통째로 준다).
pub fn prepare(probe: &Probe<'_>, arch: &str, run: &dyn Fn(&Path, &[String]) -> Option<String>) -> Preparation {
    let detection = detect(probe);
    let Some(vcvarsall) = detection.vcvarsall.clone() else {
        let advice = advice(&detection);
        return Preparation::NotFound {
            checked: detection.checked,
            advice,
        };
    };
    let how = detection.how.unwrap_or(How::Search);

    let Some(output) = run(&vcvarsall, &probe_argv(&vcvarsall, arch)) else {
        return Preparation::Broken {
            from: vcvarsall,
            detail: "vcvarsall.bat을 실행하지 못했습니다".to_string(),
        };
    };
    let vars = parse_env_dump(&output);
    // **`INCLUDE`가 판정 기준이다.** 이게 없으면 준비됐다고 말할 수 없다 — 그 상태로
    // 진행하면 정확히 `stdarg.h` 없음으로 실패한다.
    if !vars.contains_key("INCLUDE") {
        return Preparation::Broken {
            from: vcvarsall,
            detail: "실행은 됐지만 INCLUDE가 설정되지 않았습니다".to_string(),
        };
    }
    let names = vars.keys().cloned().collect();
    Preparation::Prepared {
        how,
        from: vcvarsall,
        names,
        vars,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    struct World {
        env: BTreeMap<String, String>,
        files: BTreeSet<String>,
        /// vswhere가 알려주는 설치 경로들 (질의와 무관하게 같은 답).
        installs: Vec<String>,
        /// 서브트리 검색이 찾는 것.
        search_hit: Option<String>,
    }

    impl World {
        fn empty() -> Self {
            Self {
                env: BTreeMap::new(),
                files: BTreeSet::new(),
                installs: Vec::new(),
                search_hit: None,
            }
        }

        fn with_env(mut self, name: &str, value: &str) -> Self {
            self.env.insert(name.to_string(), value.to_string());
            self
        }

        fn with_file(mut self, path: &str) -> Self {
            self.files.insert(path.to_string());
            self
        }

        /// **경로 조립을 테스트가 따로 하지 않는다** — 제품과 같은 함수를 쓴다. 손으로 적으면
        /// Linux의 `/`와 Windows의 `\`가 갈려서 검사가 언제나 통과하거나 언제나 실패한다.
        fn with_install(mut self, dir: &str) -> Self {
            self.installs.push(dir.to_string());
            self.files.insert(vcvarsall_in(dir).display().to_string());
            self
        }

        /// 설치는 있는데 C++ 도구가 없는 경우 — vcvarsall.bat을 만들지 않는다.
        fn with_toolless_install(mut self, dir: &str) -> Self {
            self.installs.push(dir.to_string());
            self
        }

        fn detect(&self) -> Detection {
            let env = |name: &str| self.env.get(name).cloned();
            let is_file = |p: &Path| self.files.contains(&p.display().to_string());
            let vswhere = |_: &Path, _: &[&str]| self.installs.clone();
            let search = |_: &Path| self.search_hit.clone().map(PathBuf::from);
            super::detect(&Probe {
                env: &env,
                is_file: &is_file,
                vswhere: &vswhere,
                search: &search,
            })
        }
    }

    /// vswhere가 사는 자리. 테스트가 이 경로를 손으로 적지 않도록 한 곳에 둔다.
    fn vswhere_in(program_files: &str) -> String {
        Path::new(program_files)
            .join("Microsoft Visual Studio")
            .join("Installer")
            .join("vswhere.exe")
            .display()
            .to_string()
    }

    // ---- 어떤 명령이 환경을 필요로 하는가 ----

    #[test]
    fn only_commands_that_actually_touch_msvc_get_the_environment() {
        assert!(needs_msvc("cargo", &[]));
        assert!(needs_msvc("cargo.exe", &["build".to_string()]));
        // 대소문자를 가리지 않는다 — Windows에서 `CARGO.EXE`도 같은 프로그램이다.
        assert!(needs_msvc("CARGO.EXE", &[]));
        assert!(needs_msvc(r"C:\Users\me\.cargo\bin\cargo.exe", &[]));
        assert!(needs_msvc("msbuild", &[]));

        // **넓히지 않는다.** 관계없는 명령의 환경이 조용히 달라지면 그게 더 나쁘다.
        assert!(!needs_msvc("npm", &["test".to_string()]));
        assert!(!needs_msvc("git", &["status".to_string()]));
        assert!(!needs_msvc("node", &[]));
        assert!(!needs_msvc("python", &[]));
    }

    /// **다른 플랫폼에서는 아무것도 붙지 않는다.** 붙이면 Unix 환경에 Windows 경로가 들어간다.
    #[test]
    fn nothing_is_prepared_off_windows() {
        use crate::tools::program::Platform;
        assert!(applies(Platform::Windows, "cargo", &[]));
        assert!(!applies(Platform::Unix, "cargo", &[]));
        assert!(!applies(Platform::Windows, "npm", &["test".to_string()]));
    }

    /// **준비를 부르는 자리가 사용자 명령 실행 경로에 있다.**
    ///
    /// 이 검사가 없으면 배선을 지워도 Linux에서 아무것도 실패하지 않는다 — 여기서는 판정이
    /// 언제나 "붙이지 않음"이라 단위 테스트가 전부 통과하기 때문이다. 실제 동작은 Windows에서만
    /// 확인되므로(landing.rs `developerEnv`), 최소한 **호출이 존재한다는 것**은 여기서 지킨다.
    #[test]
    fn the_command_path_actually_asks_for_the_environment() {
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("tools").join("mod.rs"),
        )
        .expect("tools/mod.rs를 읽지 못했습니다");

        // 사용자 명령을 실행하는 함수의 본문만 잘라낸다 — 파일 어딘가에 이름이 있는 것으로는
        // 배선을 확인할 수 없다.
        let marker = format!("fn run_{}(", "command");
        let at = source.find(&marker).expect("run_command를 찾지 못했습니다");
        let body = brace_body(&source[at..]);
        assert!(body.len() > 200, "본문을 제대로 잘라내지 못했습니다: {}", body.len());
        // needle을 런타임에 조립한다 — 그대로 적으면 이 파일이 자기 자신을 센다.
        let needle = format!("developer_env_{}(", "for");
        assert!(body.contains(&needle), "run_command가 개발자 환경을 준비하지 않습니다");
    }

    /// 여는 중괄호부터 짝이 맞는 닫는 중괄호까지.
    fn brace_body(text: &str) -> String {
        let open = text.find('{').expect("여는 중괄호가 없습니다");
        let mut depth = 0usize;
        for (i, c) in text[open..].char_indices() {
            if c == '{' {
                depth += 1;
            } else if c == '}' {
                depth -= 1;
                if depth == 0 {
                    return text[open + 1..open + i].to_string();
                }
            }
        }
        panic!("중괄호가 닫히지 않았습니다");
    }

    // ---- 탐지 순서 ----

    /// **override가 먼저다.** 탐지가 실패하는 머신의 최종 답이므로, 다른 것이 있어도 이긴다.
    #[test]
    fn the_explicit_override_wins() {
        let world = World::empty()
            .with_env("TOMVERSE_VCVARSALL", "/opt/mine/vcvarsall.bat")
            .with_file("/opt/mine/vcvarsall.bat")
            .with_env("ProgramFiles", "/pf")
            .with_install("/pf/Microsoft Visual Studio/2022/BuildTools");
        let found = world.detect();
        assert_eq!(found.how, Some(How::Override));
        assert_eq!(found.vcvarsall, Some(PathBuf::from("/opt/mine/vcvarsall.bat")));
    }

    /// override가 가리키는 파일이 없으면 **넘어간다** — 있다고 우기지 않는다. 그리고 그
    /// 사실이 확인 목록에 남는다: 오타 난 override는 사용자가 가장 먼저 의심할 곳이다.
    #[test]
    fn a_broken_override_falls_through_and_says_so() {
        let world = World::empty()
            .with_env("TOMVERSE_VCVARSALL", "/opt/typo/vcvarsall.bat")
            .with_env("ProgramFiles", "/pf")
            .with_file(vswhere_in("/pf").as_str())
            .with_install("/pf/Microsoft Visual Studio/2022/BuildTools");
        let found = world.detect();
        assert_eq!(found.how, Some(How::VsWhere));
        assert!(
            found
                .checked
                .iter()
                .any(|c| c.what == "TOMVERSE_VCVARSALL" && c.result.contains("파일이 없음")),
            "{:?}",
            found.checked
        );
    }

    /// **가장 새 설치가 아니라 쓸 수 있는 설치를 고른다.** 실측 머신에서 최신 VS 18에는 C++
    /// 도구가 없었고 도구가 있는 것은 더 오래된 BuildTools였다 — `-latest`였다면 실패했다.
    #[test]
    fn the_newest_installation_does_not_win_if_it_cannot_build() {
        let world = World::empty()
            .with_env("ProgramFiles", "/pf")
            .with_file(vswhere_in("/pf").as_str())
            .with_toolless_install("/pf/Microsoft Visual Studio/18/Enterprise")
            .with_install("/pf/Microsoft Visual Studio/2022/BuildTools");
        let found = world.detect();
        assert_eq!(found.how, Some(How::VsWhere));
        assert_eq!(
            found.vcvarsall,
            Some(vcvarsall_in("/pf/Microsoft Visual Studio/2022/BuildTools"))
        );
        // 왜 첫 번째를 안 썼는지가 기록에 남는다.
        assert!(
            found
                .checked
                .iter()
                .any(|c| c.value.contains("18/Enterprise") && c.result.contains("없음")),
            "{:?}",
            found.checked
        );
    }

    /// vswhere가 없어도 포기하지 않는다 — VS가 설치된 머신에서 Installer를 못 찾은 실측 사례가
    /// 있다. 서브트리 **검색**이 마지막 겹이다(목록이 아니다).
    #[test]
    fn the_subtree_search_is_the_last_layer() {
        let mut world = World::empty().with_env("ProgramFiles", "/pf");
        world.search_hit = Some("/pf/Microsoft Visual Studio/2019/Community/VC/vcvarsall.bat".to_string());
        let found = world.detect();
        assert_eq!(found.how, Some(How::Search));
    }

    /// **전부 실패하면 확인한 것을 전부 남긴다.** "설치되어 있지 않은 것으로 보입니다"만
    /// 말하면 설치되어 있는 사용자가 할 수 있는 일이 없다.
    #[test]
    fn a_failed_detection_reports_everything_it_looked_at() {
        let world = World::empty().with_env("ProgramFiles", "/pf");
        let found = world.detect();
        assert_eq!(found.vcvarsall, None);
        let names: Vec<&str> = found.checked.iter().map(|c| c.what).collect();
        assert!(names.contains(&"TOMVERSE_VCVARSALL"), "{names:?}");
        assert!(names.contains(&"vswhere.exe"), "{names:?}");
        assert!(names.contains(&"VSINSTALLDIR"), "{names:?}");
        assert!(names.contains(&"Program Files 검색"), "{names:?}");
    }

    /// 두 실패의 **처방이 다르다** — 워크로드를 추가하는 것과 위치를 알려주는 것.
    #[test]
    fn the_advice_depends_on_how_far_we_got() {
        let no_vs = World::empty().with_env("ProgramFiles", "/pf").detect();
        let toolless = World::empty()
            .with_env("ProgramFiles", "/pf")
            .with_file(vswhere_in("/pf").as_str())
            .with_toolless_install("/pf/Microsoft Visual Studio/18/Enterprise")
            .detect();

        assert!(advice(&no_vs).contains("TOMVERSE_VCVARSALL"), "{}", advice(&no_vs));
        assert!(advice(&toolless).contains("워크로드"), "{}", advice(&toolless));
        assert_ne!(advice(&no_vs), advice(&toolless));
    }

    // ---- 환경을 읽어오는 것 ----

    /// **아는 이름만 버퍼에 들어온다.** 우리 프로세스에는 자격증명이 있을 수 있고, 전체 덤프는
    /// 그것을 옮긴다.
    #[test]
    fn the_probe_asks_for_named_variables_not_the_whole_environment() {
        let argv = probe_argv(Path::new("/vs/vcvarsall.bat"), "x64");
        let script = argv.last().expect("스크립트가 없습니다");
        assert!(script.contains("set INCLUDE"), "{script}");
        assert!(script.contains("set LIB"), "{script}");
        // 전체 덤프를 부르지 않는다. `set` 뒤에 이름 없이 끝나는 자리가 있으면 안 된다.
        assert!(!script.contains("&& set\n") && !script.ends_with("&& set"), "{script}");
        // 아키텍처가 실제로 실린다 — 빠지면 vcvarsall이 기본값으로 돌고 x86 환경이 잡힌다.
        assert!(script.contains("x64"), "{script}");
    }

    /// 목록 밖의 이름은 **버린다.** 파싱이 관대하면 위 규칙이 무의미해진다.
    #[test]
    fn parsing_keeps_only_the_names_we_asked_for() {
        let dump = "INCLUDE=C:\\vs\\include;C:\\sdk\\include\r\n\
                    OPENAI_API_KEY=sk-must-not-survive\r\n\
                    LIB=C:\\vs\\lib\r\n";
        let vars = parse_env_dump(dump);
        assert_eq!(vars.get("INCLUDE").map(String::as_str), Some("C:\\vs\\include;C:\\sdk\\include"));
        assert_eq!(vars.get("LIB").map(String::as_str), Some("C:\\vs\\lib"));
        assert!(!vars.contains_key("OPENAI_API_KEY"), "{vars:?}");
        assert_eq!(vars.len(), 2, "{vars:?}");
    }

    /// 값 안의 `=`에서 자르지 않는다 — PATH에 `=`가 들어가는 경우가 있다.
    #[test]
    fn only_the_first_equals_splits() {
        let vars = parse_env_dump("PATH=C:\\a;C:\\b=c\n");
        assert_eq!(vars.get("PATH").map(String::as_str), Some("C:\\a;C:\\b=c"));
    }

    /// 이름 비교는 대소문자를 무시하되 **키는 우리 표기로 정규화한다** — 소비자가 두 표기를
    /// 다 알아야 하면 언젠가 한쪽만 읽는다.
    #[test]
    fn names_are_matched_case_insensitively_and_normalized() {
        let vars = parse_env_dump("include=C:\\x\nPath=C:\\y\n");
        assert!(vars.contains_key("INCLUDE"), "{vars:?}");
        assert!(vars.contains_key("PATH"), "{vars:?}");
    }

    // ---- 준비의 결말 ----

    fn prepared_world() -> World {
        World::empty()
            .with_env("ProgramFiles", "/pf")
            .with_file(vswhere_in("/pf").as_str())
            .with_install("/pf/Microsoft Visual Studio/2022/BuildTools")
    }

    fn prepare_with(world: &World, output: Option<&str>) -> Preparation {
        let env = |name: &str| world.env.get(name).cloned();
        let is_file = |p: &Path| world.files.contains(&p.display().to_string());
        let vswhere = |_: &Path, _: &[&str]| world.installs.clone();
        let search = |_: &Path| world.search_hit.clone().map(PathBuf::from);
        let probe = Probe {
            env: &env,
            is_file: &is_file,
            vswhere: &vswhere,
            search: &search,
        };
        let owned = output.map(str::to_string);
        prepare(&probe, "x64", &|_, _| owned.clone())
    }

    #[test]
    fn a_successful_preparation_carries_the_variables_and_where_they_came_from() {
        let out = prepare_with(&prepared_world(), Some("INCLUDE=C:\\i\nLIB=C:\\l\nPATH=C:\\vs\\bin;C:\\old\n"));
        match &out {
            Preparation::Prepared { how, names, .. } => {
                assert_eq!(*how, How::VsWhere);
                assert!(names.contains(&"INCLUDE".to_string()), "{names:?}");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(out.vars().len(), 3);
        assert!(out.summary().contains("준비했습니다"), "{}", out.summary());
    }

    /// **0으로 끝나도 환경이 안 잡히는 경우가 있다**(설치 손상, 아키텍처 불일치). 여기서
    /// 거르지 않으면 나중에 `stdarg.h` 없음이라는 **원인과 먼 증상**으로만 드러난다.
    #[test]
    fn running_without_include_is_broken_not_prepared() {
        let out = prepare_with(&prepared_world(), Some("LIB=C:\\l\n"));
        assert!(matches!(out, Preparation::Broken { .. }), "{out:?}");
        assert!(out.vars().is_empty(), "깨진 준비의 변수를 넣으면 안 됩니다");
    }

    #[test]
    fn a_failed_run_is_broken_too() {
        let out = prepare_with(&prepared_world(), None);
        assert!(matches!(out, Preparation::Broken { .. }), "{out:?}");
    }

    /// 설치를 못 찾은 것과 준비가 깨진 것은 **다른 결말이다** — 사용자가 할 일이 다르다.
    #[test]
    fn not_found_carries_the_checklist() {
        let out = prepare_with(&World::empty().with_env("ProgramFiles", "/pf"), Some("INCLUDE=x\n"));
        match out {
            Preparation::NotFound { checked, advice } => {
                assert!(!checked.is_empty());
                assert!(!advice.is_empty());
            }
            other => panic!("{other:?}"),
        }
    }

    /// 어느 결말이든 **그대로 실행한다**는 사실이 문장에 있어야 한다 — 막았다고 읽히면
    /// 사용자는 명령이 돌지 않았다고 생각한다.
    #[test]
    fn every_failure_says_the_command_still_runs() {
        for out in [
            prepare_with(&World::empty(), Some("x")),
            prepare_with(&prepared_world(), Some("LIB=C:\\l\n")),
        ] {
            assert!(out.summary().contains("그대로 실행"), "{}", out.summary());
        }
    }
}
