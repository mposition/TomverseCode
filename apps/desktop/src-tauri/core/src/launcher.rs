//! sidecar를 **무엇으로** 띄울 것인가 — process-architecture.md 9절 패키징 항목.
//!
//! # 문제는 배포 크기가 아니라 신뢰 경계다
//!
//! 종전 문항은 "pkg로 단일 바이너리화 vs 시스템 Node.js 요구 vs 런타임 임베딩"이었고, 판단
//! 기준으로 **배포 크기와 'Node 20+ 필요' 노출 여부**를 적어두었다. 둘 다 실재하는 고려지만
//! 결정적인 것은 따로 있다.
//!
//! 구현은 `Command::new("node")`였다. 즉 **PATH가 인터프리터를 고른다.** 그 프로세스는 API 키가
//! 주입되고 신뢰 경계와 대화하는 프로세스다. PATH를 바꿀 수 있는 사람은 누구든 그 프로세스를
//! 바꿀 수 있고, 그건 원칙 2("Node가 완전히 장악당해도 Rust 게이트를 통과해야 한다")가 다루는
//! 상황보다 한 칸 앞이다 — 장악당한 Node가 아니라 **우리가 부른 적 없는 Node**다.
//!
//! 이 저장소는 같은 계열의 사고를 이미 겪었다: Git for Windows의 GNU `link.exe`가 MSVC
//! `link.exe`를 PATH에서 가려 링크가 깨졌다(CLAUDE.md 함정 기록). 그건 빌드가 깨지는 것으로
//! 끝났고 증상도 요란했다. 여기서는 조용하다.
//!
//! # 결정: 런타임을 동봉하고 절대 경로로 부른다
//!
//! - **시스템 Node를 요구하지 않는다.** 데스크톱 앱 사용자에게 "Node 20+를 설치하세요"는
//!   설치 과제이고, 만족되지 않았을 때의 증상이 이해 불가능하다.
//! - **`pkg`는 쓰지 않는다** — 아카이브된 프로젝트다. 남은 단일 바이너리 수단은 Node SEA인데,
//!   SEA로 묶어도 런타임 크기는 그대로 지불한다. 그러면 **동봉 + 절대 경로 실행**이 더 단순하고,
//!   더 중요하게는 **sidecar JS가 파일로 남는다** — 감사자가 실제로 실행되는 코드를 읽을 수 있다.
//!   SEA는 그걸 blob 안으로 감춘다. 투명성이 이 제품의 명제다.
//!
//! 배포판 레이아웃:
//!
//! ```text
//! <실행 파일 디렉터리>/
//!   tomverse-code.exe
//!   sidecar/
//!     node.exe      ← 동봉 런타임
//!     index.js      ← sidecar 진입점 (빌드 산출물 그대로)
//! ```
//!
//! # 어디서 온 것인지 조용하지 않게
//!
//! 해석 결과에는 **인터프리터와 진입점의 출처를 따로** 담는다. 하나로 합치면 "번들 진입점을
//! PATH의 node로 돌고 있다"는 상태가 표현되지 않는데, 그게 정확히 위험한 상태다.
//! 배포판에서 `PathLookup`이 나오면 그건 번들이 깨진 것이고, 그 사실이 보여야 한다.

use std::path::{Path, PathBuf};

/// 동봉 런타임과 sidecar가 들어가는 디렉터리 이름.
pub const BUNDLE_DIR: &str = "sidecar";
/// sidecar 진입점 파일 이름.
pub const ENTRY_FILE: &str = "index.js";

/// 인터프리터를 어디서 얻었는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgramSource {
    /// 앱과 함께 배포된 런타임. **배포판은 반드시 이것이어야 한다.**
    Bundled,
    /// 환경변수로 명시됐다. 개발·테스트용이며 사용자가 스스로 지정한 것이다.
    Override,
    /// PATH에서 찾는다. 우리가 고른 것이 아니다 — 개발 트리에서만 허용한다.
    PathLookup,
}

/// 진입점을 어디서 얻었는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntrySource {
    Bundled,
    Override,
    /// 저장소 안의 빌드 산출물(`packages/sidecar/dist/src/index.js`).
    DevelopmentTree,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launcher {
    pub program: PathBuf,
    pub entry: PathBuf,
    pub program_source: ProgramSource,
    pub entry_source: EntrySource,
    /// 해석하면서 **확인한 경로 전부.** 성공해도 남긴다 — 실패했을 때만 남기면
    /// "왜 개발 트리 쪽이 선택됐는가"를 물을 때 답할 것이 없다.
    pub checked: Vec<String>,
}

impl Launcher {
    /// 배포판으로서 온전한가. 둘 다 번들이어야 참이다.
    pub fn is_bundled(&self) -> bool {
        self.program_source == ProgramSource::Bundled && self.entry_source == EntrySource::Bundled
    }

    /// spawn이 실패했을 때 붙일 설명. **무엇을 어디서 찾았는지**를 말한다 —
    /// `No such file or directory`만 보여주면 사용자가 할 수 있는 일이 없다.
    pub fn describe_failure(&self) -> String {
        let program = if self.program_source == ProgramSource::PathLookup {
            format!("PATH에서 `{}`를 찾습니다", self.program.display())
        } else {
            format!("`{}`", self.program.display())
        };
        format!(
            "인터프리터: {program} (출처: {:?})\n진입점: `{}` (출처: {:?})\n확인한 경로:\n  {}",
            self.program_source,
            self.entry.display(),
            self.entry_source,
            self.checked.join("\n  ")
        )
    }
}

/// 해석에 필요한 바깥 세상. **주입하는 이유는 테스트다** —
/// Windows 배포 레이아웃을 Linux 개발 환경에서 검증할 방법이 이것뿐이다.
pub struct Context<'a> {
    /// 앱 실행 파일이 있는 디렉터리.
    pub exe_dir: &'a Path,
    /// 저장소 루트(개발 모드에서만 있다).
    pub repo_root: Option<&'a Path>,
    /// 대상 플랫폼이 Windows인가 — `.exe` 접미사를 정한다.
    pub windows: bool,
    /// 호출자가 명시한 진입점(`--sidecar`). 환경변수와 같은 등급의 **명시적 지정**이다.
    pub entry_override: Option<PathBuf>,
    pub var: &'a dyn Fn(&str) -> Option<String>,
    pub exists: &'a dyn Fn(&Path) -> bool,
}

/// sidecar가 요구하는 최소 Node 메이저 버전.
///
/// **루트 `package.json`의 `engines.node`와 같아야 한다.** 선언과 강제가 갈라지면 "요구한다고
/// 적어둔 버전"과 "실제로 막는 버전"이 달라지고, 그 차이는 아무도 모르는 채로 남는다 —
/// `packages/toolchain/test/nodeVersion.test.ts`가 둘을 대조한다.
pub const MIN_NODE_MAJOR: u32 = 20;

/// 동봉 런타임이 sidecar를 돌릴 수 있는가.
///
/// **세 값이다.** "모른다"를 "괜찮다"나 "너무 낮다" 어느 쪽에도 넣지 않는다 — 전자면 조용히
/// 죽고, 후자면 우리가 필드 이름을 바꾼 것만으로 앱이 안 뜬다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NodeVersionCheck {
    Ok {
        version: String,
    },
    TooOld {
        found: String,
        #[serde(rename = "requiredMajor")]
        required_major: u32,
    },
    /// 확인할 수 없었다. **막지 않는다** — Node와 Rust는 같은 배포판 안에서 버전이 고정되므로
    /// 이 값이 없다는 것은 대개 우리가 필드를 바꿨다는 뜻이고, 그때 앱이 안 뜨면 안 된다.
    /// 프로토콜 버전 불일치는 이미 별도로 막는다.
    Unknown {
        reason: String,
    },
}

/// sidecar가 보고한 `process.versions.node`를 본다.
///
/// # 왜 이 검사가 필요한가
///
/// 동봉 런타임의 버전이 sidecar가 요구하는 것보다 낮으면 **증상이 "sidecar가 조용히 죽는다"**다.
/// 최신 문법·API를 파싱하다 죽으므로 오류가 사용자에게 닿지도 않는다. 번들을 만드는 쪽에서
/// 실수하기 쉬운 자리이기도 하다(런타임을 따로 복사해 넣는다).
///
/// **막는 것은 Rust다.** Node가 자기 버전을 속일 수는 있지만, 그건 여기서 다루는 문제가 아니다 —
/// 속인 Node는 어차피 실행 중에 죽는다. 이 검사의 목적은 보안이 아니라 **이해 가능한 실패**다.
pub fn check_node_version(reported: Option<&str>) -> NodeVersionCheck {
    let Some(raw) = reported.map(str::trim).filter(|v| !v.is_empty()) else {
        return NodeVersionCheck::Unknown {
            reason: "sidecar가 Node 버전을 보고하지 않았습니다".to_string(),
        };
    };
    // `v22.1.0`처럼 접두사가 붙는 경우도 받는다 — `process.versions.node`는 붙이지 않지만
    // `process.version`은 붙이고, 둘을 헷갈려 보내는 것은 막을 이유가 없는 실수다.
    let trimmed = raw.strip_prefix('v').unwrap_or(raw);
    let Some(major) = trimmed.split('.').next().and_then(|m| m.parse::<u32>().ok()) else {
        return NodeVersionCheck::Unknown {
            reason: format!("Node 버전을 해석할 수 없습니다: {raw}"),
        };
    };
    if major < MIN_NODE_MAJOR {
        NodeVersionCheck::TooOld {
            found: raw.to_string(),
            required_major: MIN_NODE_MAJOR,
        }
    } else {
        NodeVersionCheck::Ok {
            version: raw.to_string(),
        }
    }
}

/// 동봉 런타임의 파일 이름. **플랫폼별 규칙을 한 곳에 둔다** —
/// `.exe`를 붙이는 자리가 둘이 되면 한쪽만 고쳐진다.
pub fn runtime_file_name(windows: bool) -> &'static str {
    if windows {
        "node.exe"
    } else {
        "node"
    }
}

/// 개발 모드에서의 저장소 루트.
///
/// `CARGO_MANIFEST_DIR`은 `apps/desktop/src-tauri/core`이므로 **`..`이 네 번**이다.
/// 개수가 하나 틀리면 존재 확인이 실패해 조용히 PATH/번들 쪽으로 떨어지고, 그 증상은
/// "개발 중인데 sidecar를 못 찾는다"로만 보인다 — 아래 테스트가 그 개수를 지킨다.
pub fn development_repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("..")
}

/// 개발 트리의 sidecar 진입점.
pub fn dev_tree_entry(repo_root: &Path) -> PathBuf {
    repo_root
        .join("packages")
        .join("sidecar")
        .join("dist")
        .join("src")
        .join("index.js")
}

/// 무엇으로 sidecar를 띄울지 정한다.
///
/// 진입점을 찾지 못하면 **오류다.** 없는 진입점으로 spawn을 시도하면 오류가
/// `ENOENT` 하나로 뭉개져서, 무엇을 어디까지 찾았는지가 사라진다.
///
/// 인터프리터는 찾지 못해도 오류가 아니다 — PATH에 있을 수 있고, 그건 여기서 확인할 수 없다.
/// 대신 그 사실이 `ProgramSource::PathLookup`으로 남고, spawn이 실패하면
/// [`Launcher::describe_failure`]가 설명한다. **모르는 것을 없다고 말하지 않는다.**
pub fn resolve(ctx: &Context) -> Result<Launcher, String> {
    let mut checked = Vec::new();
    let bundle = ctx.exe_dir.join(BUNDLE_DIR);

    // ---- 인터프리터 ----
    let bundled_program = bundle.join(runtime_file_name(ctx.windows));
    let (program, program_source) = if let Some(explicit) = (ctx.var)("TOMVERSE_SIDECAR_NODE") {
        checked.push(format!("TOMVERSE_SIDECAR_NODE={explicit} (지정됨)"));
        (PathBuf::from(explicit), ProgramSource::Override)
    } else if (ctx.exists)(&bundled_program) {
        checked.push(format!("{} (동봉 런타임, 있음)", bundled_program.display()));
        (bundled_program, ProgramSource::Bundled)
    } else {
        checked.push(format!("{} (동봉 런타임, 없음)", bundled_program.display()));
        (PathBuf::from("node"), ProgramSource::PathLookup)
    };

    // ---- 진입점 ----
    let bundled_entry = bundle.join(ENTRY_FILE);
    let explicit_entry = ctx
        .entry_override
        .clone()
        .or_else(|| (ctx.var)("TOMVERSE_SIDECAR_ENTRY").map(PathBuf::from));
    let (entry, entry_source) = if let Some(explicit) = explicit_entry {
        // **명시적 지정도 존재를 확인한다.** 지정한 사람은 그 경로가 맞다고 믿고 있으므로,
        // 틀렸을 때 조용히 spawn 실패로 넘기면 오타 하나가 "sidecar가 죽었다"로 읽힌다.
        let found = (ctx.exists)(&explicit);
        checked.push(format!(
            "{} (명시적 지정, {})",
            explicit.display(),
            if found { "있음" } else { "없음" }
        ));
        if !found {
            return Err(format!(
                "지정한 sidecar 진입점이 없습니다.\n확인한 경로:\n  {}",
                checked.join("\n  ")
            ));
        }
        (explicit, EntrySource::Override)
    } else if (ctx.exists)(&bundled_entry) {
        checked.push(format!("{} (동봉 진입점, 있음)", bundled_entry.display()));
        (bundled_entry, EntrySource::Bundled)
    } else {
        checked.push(format!("{} (동봉 진입점, 없음)", bundled_entry.display()));
        match ctx.repo_root {
            Some(root) => {
                let dev = dev_tree_entry(root);
                let found = (ctx.exists)(&dev);
                checked.push(format!(
                    "{} (개발 트리, {})",
                    dev.display(),
                    if found { "있음" } else { "없음" }
                ));
                if !found {
                    return Err(format!(
                        "sidecar 진입점을 찾을 수 없습니다.\n확인한 경로:\n  {}\n\
                         개발 중이라면 `npm run build`로 sidecar를 먼저 빌드하세요.",
                        checked.join("\n  ")
                    ));
                }
                (dev, EntrySource::DevelopmentTree)
            }
            None => {
                return Err(format!(
                    "sidecar 진입점을 찾을 수 없습니다.\n확인한 경로:\n  {}",
                    checked.join("\n  ")
                ))
            }
        }
    };

    Ok(Launcher {
        program,
        entry,
        program_source,
        entry_source,
        checked,
    })
}

/// 실제 프로세스에서 해석한다. 개발 트리 루트는 컴파일 시점에 박히므로 배포 바이너리에서도
/// 그 경로가 문자열로 남지만, **존재 확인을 통과해야만** 쓰인다 — 사용자 머신에는 없다.
pub fn detect() -> Result<Launcher, String> {
    detect_with_entry(None)
}

/// 진입점을 호출자가 지정할 수 있는 형태(`tomverse-host --sidecar`).
pub fn detect_with_entry(entry_override: Option<PathBuf>) -> Result<Launcher, String> {
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일 경로를 알 수 없습니다: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "실행 파일의 디렉터리를 알 수 없습니다".to_string())?
        .to_path_buf();
    let repo_root = development_repo_root();
    resolve(&Context {
        exe_dir: &exe_dir,
        repo_root: Some(&repo_root),
        entry_override,
        windows: cfg!(windows),
        var: &|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()),
        exists: &|path| path.exists(),
    })
}

/// 준비 왕복에서 런타임 버전을 강제한다. 통과하면 `Ok`, 막아야 하면 사용자에게 보일 문장.
///
/// **어디서 온 런타임인지 함께 말한다.** 고칠 방법이 다르기 때문이다 — 동봉 런타임이 낮으면
/// 번들이 깨진 것이고(사용자가 할 일은 재설치), PATH에서 주워온 것이면 설치된 Node가 낮은 것이다.
///
/// `Unknown`은 막지 않는다(`check_node_version` 참조). 다만 조용히 넘기지도 않는다.
pub fn require_supported_node(reported: Option<&str>, launcher: &Launcher) -> Result<(), String> {
    match check_node_version(reported) {
        NodeVersionCheck::Ok { .. } => Ok(()),
        NodeVersionCheck::Unknown { reason } => {
            eprintln!("[sidecar] Node 버전을 확인하지 못했습니다: {reason}");
            Ok(())
        }
        NodeVersionCheck::TooOld { found, required_major } => Err(format!(
            "백엔드 런타임의 Node 버전이 낮습니다 (발견: {found}, 필요: {required_major} 이상).\n{}",
            launcher.describe_failure()
        )),
    }
}

/// 해석 + spawn 설정 조립을 **한 곳에서** 한다.
///
/// Tauri 껍데기와 헤드리스 호스트가 각자 조립하면 갈라진다 — 이 저장소는 이미 같은 사고를
/// 겪었다(`.bat`만 `_env.bat`을 call해서 진입점 둘의 환경 준비 의미가 달랐던 일). 게다가
/// 껍데기 크레이트는 GUI 라이브러리를 요구해 이 개발 환경에서 **컴파일조차 되지 않으므로**,
/// 거기 있는 코드는 여기서 검증되지 않는다. 검증할 수 있는 쪽으로 옮긴다.
pub fn spawn_config(
    env: crate::credentials::CredentialInjection,
) -> Result<(crate::sidecar::SpawnConfig, Launcher), String> {
    let launcher = detect()?;
    Ok((config_from(&launcher, env), launcher))
}

/// 해석된 launcher로 spawn 설정을 만든다. `spawn_config`에서 갈라낸 이유는 테스트다 —
/// `detect()`는 실제 프로세스 경로를 보므로 주입할 수 없다.
pub fn config_from(launcher: &Launcher, env: crate::credentials::CredentialInjection) -> crate::sidecar::SpawnConfig {
    crate::sidecar::SpawnConfig {
        program: launcher.program.to_string_lossy().to_string(),
        args: vec![launcher.entry.to_string_lossy().to_string()],
        working_dir: None,
        // **봉투를 여는 자리가 이 크레이트 안에 하나뿐이다**(credentials.rs `into_pairs`는
        // `pub(crate)`). 껍데기 크레이트는 봉투를 만드는 곳에서 여기까지 옮길 수만 있고,
        // 값을 들여다볼 수단이 없다 — 원칙 3이 규율이 아니라 가시성으로 지켜지는 자리다.
        env: env.into_pairs(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(
        exe_dir: &'a Path,
        repo_root: Option<&'a Path>,
        windows: bool,
        vars: &'a [(&'a str, &'a str)],
        present: &'a [PathBuf],
    ) -> Context<'a> {
        Context {
            exe_dir,
            repo_root,
            windows,
            entry_override: None,
            var: Box::leak(Box::new(move |name: &str| {
                vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
            })),
            exists: Box::leak(Box::new(move |p: &Path| present.iter().any(|q| q == p))),
        }
    }

    /// 배포 레이아웃이 갖춰지면 **PATH를 보지 않는다.** 이게 이 모듈의 존재 이유다 —
    /// 자격증명이 주입되는 프로세스의 인터프리터를 PATH가 정하게 두지 않는다.
    #[test]
    fn a_complete_bundle_never_falls_back_to_path() {
        let exe_dir = PathBuf::from("/app");
        let present = vec![
            exe_dir.join(BUNDLE_DIR).join("node.exe"),
            exe_dir.join(BUNDLE_DIR).join(ENTRY_FILE),
        ];
        let c = ctx(&exe_dir, None, true, &[], &present);
        let launcher = resolve(&c).unwrap();

        assert_eq!(launcher.program_source, ProgramSource::Bundled);
        assert_eq!(launcher.entry_source, EntrySource::Bundled);
        assert!(launcher.is_bundled());
        assert_eq!(launcher.program, exe_dir.join(BUNDLE_DIR).join("node.exe"));
    }

    /// **Windows 배포 레이아웃을 Linux에서 검증한다.** `.exe`를 붙이는 판단이 실행 플랫폼이
    /// 아니라 대상 플랫폼을 따라야 하고, 그 분기는 여기서만 확인할 수 있다.
    /// (경로 구분자까지 흉내 내지는 않는다 — `std::path`는 실행 중인 OS의 것만 안다.)
    #[test]
    fn the_runtime_file_name_follows_the_target_platform_not_the_host() {
        assert_eq!(runtime_file_name(true), "node.exe");
        assert_eq!(runtime_file_name(false), "node");

        let exe_dir = PathBuf::from("/app");
        // Windows 이름만 있는데 비-Windows로 해석하면 번들을 못 본다 — 접미사가 뒤집히면
        // 배포판이 조용히 PATH로 떨어진다는 뜻이다.
        let present = vec![exe_dir.join(BUNDLE_DIR).join("node.exe")];
        let c = ctx(&exe_dir, None, false, &[], &present);
        assert_eq!(resolve(&c).unwrap_err().contains("진입점"), true);
    }

    /// 번들 진입점은 있는데 런타임이 없으면 **부분 성공이 아니라 그 사실이 보여야 한다.**
    /// 두 출처를 한 값으로 합치면 "번들 진입점을 PATH의 node로 돌고 있다"가 표현되지 않는다.
    #[test]
    fn a_broken_bundle_is_visible_rather_than_collapsed() {
        let exe_dir = PathBuf::from("/app");
        let present = vec![exe_dir.join(BUNDLE_DIR).join(ENTRY_FILE)];
        let c = ctx(&exe_dir, None, true, &[], &present);
        let launcher = resolve(&c).unwrap();

        assert_eq!(launcher.entry_source, EntrySource::Bundled);
        assert_eq!(launcher.program_source, ProgramSource::PathLookup);
        assert!(!launcher.is_bundled(), "깨진 번들이 온전한 것으로 보고됐습니다");
    }

    /// 개발 트리는 번들이 없을 때만 쓰인다. 그리고 그 사실이 출처에 남는다.
    #[test]
    fn the_development_tree_is_used_only_when_no_bundle_exists() {
        let exe_dir = PathBuf::from("/target/debug");
        let repo = PathBuf::from("/repo");
        let present = vec![dev_tree_entry(&repo)];
        let c = ctx(&exe_dir, Some(&repo), false, &[], &present);
        let launcher = resolve(&c).unwrap();

        assert_eq!(launcher.entry_source, EntrySource::DevelopmentTree);
        assert_eq!(launcher.program_source, ProgramSource::PathLookup);
        assert!(!launcher.is_bundled());
    }

    /// 명시적 지정이 가장 세다 — 사용자가 스스로 고른 것이기 때문이다.
    /// 그리고 **지정됐다는 사실이 출처에 남는다**(PATH에서 주워온 것과 구별된다).
    #[test]
    fn explicit_overrides_win_and_are_labelled_as_such() {
        let exe_dir = PathBuf::from("/app");
        let present = vec![
            exe_dir.join(BUNDLE_DIR).join("node"),
            exe_dir.join(BUNDLE_DIR).join(ENTRY_FILE),
            PathBuf::from("/work/dist/index.js"),
        ];
        let vars = [
            ("TOMVERSE_SIDECAR_NODE", "/opt/node22/bin/node"),
            ("TOMVERSE_SIDECAR_ENTRY", "/work/dist/index.js"),
        ];
        let c = ctx(&exe_dir, None, false, &vars, &present);
        let launcher = resolve(&c).unwrap();

        assert_eq!(launcher.program, PathBuf::from("/opt/node22/bin/node"));
        assert_eq!(launcher.entry, PathBuf::from("/work/dist/index.js"));
        assert_eq!(launcher.program_source, ProgramSource::Override);
        assert_eq!(launcher.entry_source, EntrySource::Override);
        assert!(!launcher.is_bundled(), "지정된 경로를 번들로 보고했습니다");
    }

    /// **`..` 개수가 맞는지 확인한다.** 틀리면 존재 확인이 실패해 개발 모드가 조용히
    /// 번들/PATH 쪽으로 떨어지고, 증상은 "sidecar를 못 찾는다"로만 보인다.
    /// 저장소 루트의 표지로 `package.json`(npm workspaces 루트)을 쓴다.
    #[test]
    fn the_development_repo_root_actually_points_at_the_repository() {
        let root = development_repo_root();
        assert!(
            root.join("package.json").exists(),
            "저장소 루트가 아닙니다: {} — `..` 개수를 확인하세요",
            root.display()
        );
        assert!(root.join("packages").join("sidecar").exists(), "{}", root.display());
    }

    /// 명시적으로 지정한 진입점이 없으면 **거기서 멈춘다.** 지정한 사람은 그 경로가 맞다고
    /// 믿고 있으므로, 조용히 다른 후보로 넘어가면 오타 하나가 "왜 옛 코드가 도나"가 된다.
    #[test]
    fn an_explicit_entry_that_does_not_exist_is_an_error_not_a_fallback() {
        let exe_dir = PathBuf::from("/app");
        let repo = PathBuf::from("/repo");
        // 번들과 개발 트리는 멀쩡하다 — 그래도 지정이 틀리면 실패해야 한다.
        let present = vec![exe_dir.join(BUNDLE_DIR).join(ENTRY_FILE), dev_tree_entry(&repo)];
        let mut c = ctx(&exe_dir, Some(&repo), false, &[], &present);
        c.entry_override = Some(PathBuf::from("/typo/index.js"));

        let err = resolve(&c).unwrap_err();
        assert!(err.contains("/typo/index.js"), "{err}");
    }

    /// 기대 경로도 **실행 중인 OS의 구분자로** 만든다.
    ///
    /// 이 모듈의 로직은 `windows`를 인자로 받으므로 플랫폼 독립인데, `Path::join`이 만드는
    /// **문자열**은 그렇지 않다. 기대값을 `/`로 적어두면 Linux에서만 맞고, 그래서 아래 세
    /// 테스트는 Windows에서 launcher를 **한 번도 검증하지 못한 채 실패만** 하고 있었다
    /// (CLAUDE.md: `std::path`는 실행 중인 OS의 구분자만 안다).
    fn joined(parts: &[&str]) -> String {
        let mut path = PathBuf::from(parts[0]);
        for part in &parts[1..] {
            path.push(part);
        }
        path.to_string_lossy().to_string()
    }

    /// 진입점을 못 찾으면 **확인한 경로를 전부** 말한다. "실행할 수 없습니다"만 말하면
    /// 무엇을 놓쳤는지 알 방법이 없다 — MSVC 탐지에서 같은 실수를 이미 했다.
    #[test]
    fn a_missing_entry_reports_everything_it_looked_at() {
        let exe_dir = PathBuf::from("/app");
        let repo = PathBuf::from("/repo");
        let c = ctx(&exe_dir, Some(&repo), true, &[], &[]);
        let err = resolve(&c).unwrap_err();

        assert!(err.contains(&joined(&["/app", BUNDLE_DIR, ENTRY_FILE])), "{err}");
        assert!(
            err.contains(&joined(&["/repo", "packages", "sidecar", "dist", "src", ENTRY_FILE])),
            "{err}"
        );
        assert!(err.contains("npm run build"), "개발자가 할 일을 말하지 않습니다: {err}");
    }

    /// 최소 버전 이상이면 통과, 미만이면 막는다. 경계값(정확히 최소 버전)은 **통과**다 —
    /// 초과로 판정하면 실제 요구 버전이 선언보다 하나 높아진다.
    #[test]
    fn the_minimum_node_major_is_inclusive() {
        assert!(matches!(
            check_node_version(Some(&format!("{MIN_NODE_MAJOR}.0.0"))),
            NodeVersionCheck::Ok { .. }
        ));
        assert!(matches!(
            check_node_version(Some(&format!("{}.99.9", MIN_NODE_MAJOR - 1))),
            NodeVersionCheck::TooOld { .. }
        ));
        assert!(matches!(
            check_node_version(Some(&format!("{}.0.0", MIN_NODE_MAJOR + 5))),
            NodeVersionCheck::Ok { .. }
        ));
    }

    /// `v` 접두사가 붙어 와도 받는다 — `process.version`과 `process.versions.node`를 헷갈리는
    /// 것은 막을 이유가 없는 실수다.
    #[test]
    fn a_leading_v_is_accepted() {
        assert!(matches!(
            check_node_version(Some(&format!("v{MIN_NODE_MAJOR}.1.0"))),
            NodeVersionCheck::Ok { .. }
        ));
    }

    /// **"모른다"는 "너무 낮다"가 아니다.** 여기서 막으면 우리가 필드 이름을 바꾼 것만으로
    /// 앱이 안 뜬다. 반대로 "괜찮다"로 세면 조용히 죽는 상태를 통과시킨다.
    #[test]
    fn an_unreported_version_is_neither_ok_nor_too_old() {
        for reported in [None, Some(""), Some("   "), Some("nightly")] {
            let verdict = check_node_version(reported);
            assert!(
                matches!(verdict, NodeVersionCheck::Unknown { .. }),
                "{reported:?} → {verdict:?}"
            );
        }
    }

    /// 판정에 **찾은 값과 요구 값이 둘 다** 들어가야 한다 — 하나만 있으면 사용자가
    /// 무엇을 어디까지 올려야 하는지 모른다.
    #[test]
    fn the_verdict_names_both_what_was_found_and_what_is_required() {
        match check_node_version(Some("18.20.0")) {
            NodeVersionCheck::TooOld { found, required_major } => {
                assert_eq!(found, "18.20.0");
                assert_eq!(required_major, MIN_NODE_MAJOR);
            }
            other => panic!("{other:?}"),
        }
    }

    /// spawn 설정은 **해석된 절대 경로를 그대로** 쓴다. 여기서 다시 "node"로 되돌리면
    /// 위의 모든 해석이 무의미해진다.
    #[test]
    fn the_spawn_config_uses_the_resolved_interpreter() {
        let exe_dir = PathBuf::from("/app");
        let present = vec![
            exe_dir.join(BUNDLE_DIR).join("node"),
            exe_dir.join(BUNDLE_DIR).join(ENTRY_FILE),
        ];
        let c = ctx(&exe_dir, None, false, &[], &present);
        let launcher = resolve(&c).unwrap();
        let mut env = crate::credentials::CredentialInjection::new();
        env.push_plain("K", "V");
        let config = config_from(&launcher, env);

        assert_eq!(config.program, joined(&["/app", BUNDLE_DIR, "node"]));
        assert_eq!(config.args, vec![joined(&["/app", BUNDLE_DIR, ENTRY_FILE])]);
        assert_eq!(config.env, vec![("K".to_string(), "V".to_string())]);
    }

    /// **스테이징이 만든 실제 디렉터리를 해석한다.**
    ///
    /// 위의 테스트들은 `exists`를 주입하므로 "우리가 있다고 말한 것"을 해석할 뿐이다. 동봉이
    /// 실패하는 방식은 대부분 그 층 아래에 있다 — 파일이 한 칸 다른 디렉터리에 놓이거나,
    /// `.exe`가 붙지 않거나, 진입점이 하위 폴더에 남는 것. 그건 **실제 파일시스템**에 대고
    /// 물어야만 드러나고, 그때 나오는 답은 조용하다: 배포판이 `PathLookup`으로 떨어져도
    /// 개발 머신에는 PATH에 node가 있으므로 아무 일도 없는 것처럼 보인다.
    ///
    /// 여기서 만드는 것은 `scripts/stage-sidecar.mjs`가 만드는 것과 **같은 모양**이며,
    /// 그 합의는 `packages/toolchain/test/sidecarBundle.test.ts`가 상수 대조로 지킨다.
    #[test]
    fn a_staged_layout_on_a_real_filesystem_resolves_to_bundled() {
        let root = std::env::temp_dir().join(format!("tomverse-stage-{}", std::process::id()));
        let exe_dir = root.join("app");
        let bundle = exe_dir.join(BUNDLE_DIR);
        std::fs::create_dir_all(&bundle).unwrap();

        // 대상 플랫폼은 이 테스트가 도는 플랫폼이다 — 파일을 실제로 만들어야 하므로
        // 이름을 `cfg!(windows)`에 맞춘다. `.exe` 분기 자체는 위 테스트가 따로 지킨다.
        let windows = cfg!(windows);
        std::fs::write(bundle.join(runtime_file_name(windows)), b"not really node").unwrap();
        std::fs::write(bundle.join(ENTRY_FILE), b"// sidecar").unwrap();

        let launcher = resolve(&Context {
            exe_dir: &exe_dir,
            // 개발 트리가 **있어도** 번들이 이긴다. 배포판에서 개발 트리 경로가 우연히
            // 존재하는 상황(같은 머신에서 개발하고 설치했다)에서 조용히 그쪽으로 가면 안 된다.
            repo_root: Some(&development_repo_root()),
            windows,
            entry_override: None,
            var: &|_| None,
            exists: &|path| path.exists(),
        })
        .unwrap();

        assert!(
            launcher.is_bundled(),
            "스테이징된 레이아웃이 번들로 읽히지 않았습니다:\n{}",
            launcher.describe_failure()
        );
        assert_eq!(launcher.program, bundle.join(runtime_file_name(windows)));
        assert_eq!(launcher.entry, bundle.join(ENTRY_FILE));

        std::fs::remove_dir_all(&root).ok();
    }

    /// **런타임만 빠져도 번들은 깨진 것이다** — 그리고 그 상태가 실제 파일시스템에서도
    /// 보여야 한다. 실측에서 `not_landed`였던 것이 정확히 이 모양이다(기록 5절):
    /// 설치본은 나왔는데 그 안에 sidecar가 없었다.
    #[test]
    fn a_staged_layout_missing_the_runtime_is_not_bundled() {
        let root = std::env::temp_dir().join(format!("tomverse-stage-broken-{}", std::process::id()));
        let exe_dir = root.join("app");
        let bundle = exe_dir.join(BUNDLE_DIR);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join(ENTRY_FILE), b"// sidecar").unwrap();

        let launcher = resolve(&Context {
            exe_dir: &exe_dir,
            repo_root: None,
            windows: cfg!(windows),
            entry_override: None,
            var: &|_| None,
            exists: &|path| path.exists(),
        })
        .unwrap();

        assert_eq!(launcher.entry_source, EntrySource::Bundled);
        assert_eq!(launcher.program_source, ProgramSource::PathLookup);
        assert!(!launcher.is_bundled());

        std::fs::remove_dir_all(&root).ok();
    }

    /// 성공한 해석도 확인한 경로를 들고 있어야 한다 — 왜 이 조합이 골라졌는지 물을 수 있어야 한다.
    #[test]
    fn a_successful_resolution_still_carries_what_it_checked() {
        let exe_dir = PathBuf::from("/app");
        let present = vec![
            exe_dir.join(BUNDLE_DIR).join("node"),
            exe_dir.join(BUNDLE_DIR).join(ENTRY_FILE),
        ];
        let c = ctx(&exe_dir, None, false, &[], &present);
        let launcher = resolve(&c).unwrap();
        assert!(!launcher.checked.is_empty());
        assert!(launcher
            .describe_failure()
            .contains(&joined(&["/app", BUNDLE_DIR, "node"])));
    }
}
