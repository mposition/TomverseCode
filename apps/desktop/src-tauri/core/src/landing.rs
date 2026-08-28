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

use crate::landing_attest::{self, AttestationSource, MachineFact};

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
    /// 이 기준을 **사람이 확인하려면** 그 머신에 무엇이 있어야 하는가 (`landing_attest.rs`).
    ///
    /// 기준 옆에 두는 것이 요점이다 — 별도 표로 몰아두면 기준을 고칠 때 요구를 함께
    /// 고치지 않게 되고, 그러면 없는 것으로 확인했다는 기록이 통과한다. 기록 1·10절이
    /// 그 실패를 실제로 보여준다: Python이 없는 머신에서 `pythonEnv`는 확인될 수 없다.
    pub requires: &'static [MachineFact],
    /// 사람의 확인으로 통과했다면 **그 확인의 출처**. 기계가 본 통과와 구별되어야 한다 —
    /// 목적은 숫자를 줄이는 것이 아니라 누가·어디서·언제 확인했는지가 남는 것이다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attestation: Option<AttestedBy>,
}

/// 한 기준이 **사람의 확인으로** 통과했다는 사실과 그 출처.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestedBy {
    pub attestation_id: String,
    pub attested_by: String,
    /// 확인이 이루어진 머신 한 줄 요약.
    pub machine: String,
    pub commit: String,
    pub observed_at: String,
    pub evidence: String,
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

/// attestation 파일이 이번 판정에서 어떻게 됐는가.
///
/// **네 값인 것이 요점이다.** 셋으로 줄이면 다음에 할 일이 다른 상태들이 뭉개진다 —
/// 만료는 "새 커밋에서 다시 확인하라", 거부는 "파일을 고쳐라", 적용 불가는 "저장소 안에서
/// 돌려라"이고, 부분 수용은 "적은 것 중 일부가 통과하지 못했으니 그 줄을 보라"다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttestationStatus {
    /// 적힌 것이 전부 반영됐다.
    Accepted,
    /// 일부만 반영됐다. **나머지가 왜 반영되지 않았는지가 `rejections`에 있다.**
    PartiallyAccepted,
    /// 다른 커밋에서 확인한 기록이다. **아무것도 반영하지 않는다** —
    /// 옛 확인이 새 코드를 통과시키면 이 도구는 착시를 만드는 쪽이 된다.
    Expired,
    /// 지금 커밋을 알 수 없어 만료 여부를 판정할 수 없다. 모르면 반영하지 않는다.
    Inapplicable,
    /// 파일 자체가 기록으로 성립하지 않는다 (해시·모양·빈 근거).
    Rejected,
}

/// 반영하지 **않은** 줄과 그 이유. 조용히 버리지 않는다 — 사람이 적은 것이 반영되지 않았다면
/// 그 사실이 가장 먼저 보여야 한다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationRejection {
    /// `그룹/기준`. 파일 전체가 거부된 경우에는 `-`다.
    pub target: String,
    pub reason: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationReport {
    pub file: String,
    pub status: AttestationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attestation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attested_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// 확인이 이루어진 커밋.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// 지금 워크스페이스의 커밋. 둘이 다르면 만료다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    /// 반영된 `그룹/기준` 목록.
    pub accepted: Vec<String>,
    pub rejections: Vec<AttestationRejection>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LandingReport {
    /// 이 판정이 어느 OS에서 나왔는가. **Windows가 아니면 대부분 볼 수 없다**는 사실이
    /// 보고서 안에 남아야 한다.
    pub platform: String,
    /// 지금 워크스페이스의 커밋. attestation의 만료를 판정하는 기준이다.
    #[serde(rename = "headCommit", skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    pub groups: Vec<Group>,
    /// 전체 결말 — 항목 중 하나라도 `Landed`가 아니면 `Landed`가 아니다.
    pub verdict: Verdict,
    /// 통과 중 **사람의 확인으로** 통과한 것의 수.
    ///
    /// 기계가 본 통과와 같은 칸에 넣지 않는 이유: `remaining`이 줄어드는 것이 이 기능의
    /// 목적이 아니다. 목적은 **누가·어디서·언제 확인했는지가 남는 것**이고, 그러려면
    /// "그중 몇 개가 종이인가"가 보고서 표면에 있어야 한다.
    #[serde(rename = "attestedPasses")]
    pub attested_passes: usize,
    /// 사람이 아직 해야 하는 일. 비어 있지 않으면 그게 다음 할 일 목록이다.
    pub remaining: Vec<String>,
    /// `--attest`를 준 경우에만 있다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attestation: Option<AttestationReport>,
}

/// 판정에 쓰는 관측. **판정 로직을 순수하게 두기 위해** 입력으로 받는다 —
/// 그래야 Windows 없이도 규칙 자체를 테스트할 수 있다.
#[derive(Debug, Clone)]
pub struct Observations {
    pub os: String,
    /// `tauri-build`이 만든 번들 디렉터리. 없으면 번들 기준을 볼 수 없다.
    pub bundle_dir: Option<PathBuf>,
    /// 지금 워크스페이스의 커밋. **`None`이면 만료를 판정할 수 없다** —
    /// 그때는 attestation을 반영하지 않는다(모르는 것을 통과로 세지 않는다).
    pub head_commit: Option<String>,
    /// 사람이 확인한 기록. 읽기(IO)는 호출자가 하고 여기는 판정만 한다.
    pub attestation: Option<AttestationSource>,
}

impl Observations {
    pub fn here(bundle_dir: Option<PathBuf>) -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            bundle_dir,
            head_commit: None,
            attestation: None,
        }
    }

    /// 지금 커밋과 attestation 파일을 붙인다. 둘은 **함께** 온다 —
    /// 커밋 없이 attestation만 주면 만료를 판정할 수 없고, 그 상태를 기본으로 만들지 않는다.
    pub fn with_attestation(mut self, head_commit: Option<String>, attestation: Option<AttestationSource>) -> Self {
        self.head_commit = head_commit;
        self.attestation = attestation;
        self
    }

    fn on_windows(&self) -> bool {
        self.os == "windows"
    }
}

/// 사람의 확인을 기준에 **반영한다.** 반영하지 못한 것은 전부 이유와 함께 남는다.
///
/// # 무엇을 덮을 수 있고 무엇을 덮을 수 없는가
///
/// | 관측한 상태 | attestation |
/// |---|---|
/// | `NeedsHuman` | **통과로 바꾼다** — 애초에 사람을 기다리던 자리다 |
/// | `NotCheckableHere` | **통과로 바꾼다** — "여기서는 볼 수 없다"에 대한 답이 바로 다른 머신의 확인이다 |
/// | `Failed` | **덮지 못한다.** 도구가 실제로 관측한 실패를 사람의 종이가 지우지 못한다 |
/// | `NotImplemented` | **덮지 못한다.** 없는 기능을 확인할 수는 없다 |
/// | `Passed` | 덮을 것이 없다. 적혀 있으면 아무 일도 하지 않았다고 알린다 |
fn apply_attestation(groups: &mut [Group], obs: &Observations) -> Option<AttestationReport> {
    let source = obs.attestation.as_ref()?;

    let attestation = match &source.parsed {
        Ok(a) => a,
        Err(reasons) => {
            return Some(AttestationReport {
                file: source.file.clone(),
                status: AttestationStatus::Rejected,
                attestation_id: None,
                attested_by: None,
                machine: None,
                commit: None,
                head_commit: obs.head_commit.clone(),
                accepted: Vec::new(),
                rejections: reasons
                    .iter()
                    .map(|reason| AttestationRejection {
                        target: "-".to_string(),
                        reason: reason.clone(),
                    })
                    .collect(),
            })
        }
    };

    let mut report = AttestationReport {
        file: source.file.clone(),
        status: AttestationStatus::Accepted,
        attestation_id: Some(attestation.attestation_id.clone()),
        attested_by: Some(attestation.attested_by.clone()),
        machine: Some(attestation.machine.summary()),
        commit: Some(attestation.commit.clone()),
        head_commit: obs.head_commit.clone(),
        accepted: Vec::new(),
        rejections: Vec::new(),
    };

    // **만료가 먼저다.** 다른 커밋의 확인은 이 코드에 대한 확인이 아니므로, 항목별로
    // 따질 것도 없이 통째로 반영하지 않는다.
    let Some(head) = obs.head_commit.as_deref() else {
        report.status = AttestationStatus::Inapplicable;
        report.rejections.push(AttestationRejection {
            target: "-".to_string(),
            reason: "지금 커밋을 알 수 없어 만료 여부를 판정할 수 없습니다 — git 저장소 안에서 \
                     돌리세요. 모르는 것을 통과로 세지 않습니다."
                .to_string(),
        });
        return Some(report);
    };
    if !landing_attest::commit_matches(&attestation.commit, head) {
        report.status = AttestationStatus::Expired;
        report.rejections.push(AttestationRejection {
            target: "-".to_string(),
            reason: format!(
                "{}에서 확인한 기록인데 지금은 {}입니다 — 만료되었습니다. 옛 확인이 새 코드를 \
                 통과시키면 이 도구는 착시를 만드는 쪽이 됩니다. 이 커밋에서 다시 확인하세요.",
                attestation.commit, head
            ),
        });
        return Some(report);
    }

    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for attested in &attestation.checks {
        let target = format!("{}/{}", attested.group, attested.check);
        // 클로저로 감싸지 않는다 — `report`를 빌려 잡은 채로 아래에서 다시 쓰게 되고,
        // 그걸 피하려고 구조를 비트는 것보다 이 편이 읽기 쉽다.
        macro_rules! reject {
            ($reason:expr) => {{
                report.rejections.push(AttestationRejection {
                    target: target.clone(),
                    reason: $reason,
                });
                continue;
            }};
        }

        if !seen.insert(target.clone()) {
            reject!("같은 기준이 두 번 적혀 있습니다".to_string());
        }

        let Some(group) = groups.iter_mut().find(|g| g.id == attested.group) else {
            reject!(format!("그런 그룹이 없습니다: {}", attested.group));
        };
        let Some(check) = group.checks.iter_mut().find(|c| c.id == attested.check) else {
            reject!(format!("{} 그룹에 그런 기준이 없습니다: {}", attested.group, attested.check));
        };

        match check.status {
            CheckStatus::Failed => reject!("도구가 **실패로 관측한** 기준입니다 — 사람의 확인은 \
                 확인하지 못한 것을 통과로 바꿀 뿐, 관측된 실패를 지우지 않습니다."
                .to_string()),
            CheckStatus::NotImplemented => {
                reject!("기능이 아직 없습니다 — 확인할 대상이 없는 기준입니다.".to_string())
            }
            CheckStatus::Passed => {
                reject!("이미 기계가 통과로 판정했습니다 — 이 줄은 아무것도 바꾸지 않았습니다.".to_string())
            }
            CheckStatus::NeedsHuman | CheckStatus::NotCheckableHere => {}
        }

        // **머신 사양이 판정에 반영되는 자리.** "Python으로 확인했다"는 Python이 있는
        // 머신에서만 뜻이 있다(기록 1·10절).
        let missing = attestation.machine.missing(check.requires);
        if !missing.is_empty() {
            let names: Vec<&str> = missing.iter().map(|f| f.label()).collect();
            reject!(format!(
                "확인한 머신에 없는 것으로 확인할 수는 없습니다: {} (기록된 머신: {})",
                names.join(", "),
                attestation.machine.summary()
            ));
        }

        // **`detail`도 함께 바꾼다.** 상태만 통과로 바꾸고 "Windows에서 사람이 확인해야
        // 한다"를 그대로 두면, 보고서를 읽는 사람이 통과와 남은 일을 동시에 읽게 된다.
        // 도구가 여전히 보지 못한다는 사실은 지우지 않고 뒤에 남긴다 — 그게 사람의 확인이
        // 기계의 관측과 다른 종류라는 표시다.
        check.detail = format!(
            "사람이 확인함 — {} / {} / 커밋 {} / {}. 근거: {} (도구가 본 것은 그대로다: {})",
            attestation.attested_by,
            attestation.machine.summary(),
            attestation.commit,
            attested.observed_at,
            attested.evidence,
            check.detail
        );
        check.status = CheckStatus::Passed;
        check.attestation = Some(AttestedBy {
            attestation_id: attestation.attestation_id.clone(),
            attested_by: attestation.attested_by.clone(),
            machine: attestation.machine.summary(),
            commit: attestation.commit.clone(),
            observed_at: attested.observed_at.clone(),
            evidence: attested.evidence.clone(),
        });
        report.accepted.push(target);
    }

    for group in groups.iter_mut() {
        group.verdict = verdict_of(&group.checks);
    }

    if !report.rejections.is_empty() {
        report.status = AttestationStatus::PartiallyAccepted;
    }
    Some(report)
}

/// 기본 요구는 **Windows 하나다.** 이 모듈의 모든 기준이 Windows에서만 확인되므로,
/// 요구를 적지 않아도 "아무 머신에서나 확인했다고 적을 수 있다"가 되지는 않는다.
fn check(id: &'static str, criterion: &'static str, status: CheckStatus, detail: impl Into<String>) -> Check {
    Check {
        id,
        criterion,
        status,
        detail: detail.into(),
        requires: &[MachineFact::WindowsOs],
        attestation: None,
    }
}

impl Check {
    /// Windows 외에 **더** 필요한 것을 적는다. 목록에 `WindowsOs`도 함께 적어야 한다 —
    /// 여기서 조용히 더해 주면 "이 기준의 요구가 무엇인가"를 한 자리에서 읽을 수 없다.
    fn requiring(mut self, facts: &'static [MachineFact]) -> Self {
        self.requires = facts;
        self
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
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::NodeAndNpm]),
        check(
            "treeGuaranteedTrue",
            "`TreeKillOutcome.tree_guaranteed`가 Windows에서 true가 되고, 그 값이 UI 문구를 실제로 바꾼다.",
            CheckStatus::NeedsHuman,
            "**절반은 여기서 이미 지킨다** — 값에 따라 문구가 갈리는 것은 플랫폼과 무관한 \
             순수 분기이고 `tools/mod.rs`의 단위 테스트가 그 분기를 태운다. Windows에서 확인할 \
             나머지 절반은 '실제 취소에서 그 값이 true가 되는가'다.",
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::NodeAndNpm]),
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

/// 번들 안에서 sidecar가 놓이는 자리. `launcher.rs`가 찾는 것과 같아야 한다 —
/// 그래서 상수를 다시 적지 않고 거기서 가져온다.
fn sidecar_dir(bundle: &Path) -> PathBuf {
    bundle.join(crate::launcher::BUNDLE_DIR)
}

/// **가리킨 곳이 설치본이 아니라 빌드 트리인가.**
///
/// 실측에서 `--bundle target/release`를 주는 바람에 `bundleSizeRecorded`가 1586.9 MiB를
/// "기록됨"으로 통과시켰다(기록 5절). 그 숫자는 배포되는 크기가 아니라 **컴파일 중간
/// 산출물의 크기**이고, 통과 표시가 붙어 있으니 아무도 다시 보지 않는다. cargo가 반드시
/// 만드는 디렉터리로 그 상황을 구조적으로 가려낸다.
fn looks_like_a_build_tree(dir: &Path) -> bool {
    ["build", "deps", ".fingerprint", "incremental"]
        .iter()
        .filter(|name| dir.join(name).is_dir())
        .count()
        >= 2
}

/// 번들 안 `sidecar/manifest.json`이 적어 둔 런타임 해시.
fn manifest_node_sha256(sidecar: &Path) -> Option<String> {
    let text = std::fs::read_to_string(sidecar.join("manifest.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("node")?.get("sha256")?.as_str().map(str::to_string)
}

fn sha256_file(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

fn bundle_checks(obs: &Observations) -> Vec<Check> {
    let Some(dir) = obs.bundle_dir.as_ref() else {
        return vec![
            check(
                "bundleContents",
                "번들 안에 `sidecar/node.exe`와 `sidecar/index.js`가 있고, 런타임이 핀된 해시와 일치한다.",
                CheckStatus::NotCheckableHere,
                "`--bundle <경로>`로 **설치된 앱 디렉터리**를 가리키면 확인한다.",
            ),
            check(
                "runsWithoutNodeOnPath",
                "설치된 앱을 PATH에 node가 없는 머신에서 실행해 sidecar가 뜬다.",
                CheckStatus::NeedsHuman,
                "설치본을 node 없는 Windows에서 실행할 것.",
            )
            .requiring(&[MachineFact::WindowsOs, MachineFact::InstalledBundle]),
            check(
                "sourcesAreBundled",
                "그 실행에서 `ProgramSource`/`EntrySource`가 둘 다 `Bundled`다.",
                CheckStatus::NeedsHuman,
                "앱이 번들이 아닐 때 stderr로 알린다(session.rs) — 그 줄이 없어야 한다.",
            )
            .requiring(&[MachineFact::WindowsOs, MachineFact::InstalledBundle]),
            check(
                "bundleSizeRecorded",
                "**설치된 앱 디렉터리**의 크기가 기록된다 — \"크기는 고려하지 않았다\"가 아니라 \"얼마인지 알고 받아들였다\"여야 한다.",
                CheckStatus::NotCheckableHere,
                "`--bundle <경로>`를 주면 재서 적는다. 빌드 트리(`target/release`)가 아니라 설치본을 가리킬 것.",
            ),
        ];
    };

    let sidecar = sidecar_dir(dir);
    let windows_runtime = crate::launcher::runtime_file_name(true);
    let node_exe = sidecar.join(windows_runtime);
    let entry = sidecar.join(crate::launcher::ENTRY_FILE);
    // `package.json`이 빠지면 Node가 진입점을 CommonJS로 읽어 **첫 줄에서** 죽는다.
    // 파일이 다 있는데도 sidecar가 안 뜨는 상태라 증상만으로는 원인에 닿기 어렵다.
    let esm_anchor = sidecar.join("package.json");
    let license = sidecar.join("node.LICENSE");
    let present: Vec<(&str, bool)> = vec![
        (windows_runtime, node_exe.is_file()),
        (crate::launcher::ENTRY_FILE, entry.is_file()),
        ("manifest.json", sidecar.join("manifest.json").is_file()),
        ("package.json", esm_anchor.is_file()),
        ("node.LICENSE", license.is_file()),
    ];
    let all_present = present.iter().all(|(_, ok)| *ok);

    // **파일이 있다는 것과 그것이 우리가 승인한 바이트라는 것은 다른 사실이다.**
    // manifest가 적어둔 해시로 실제 node.exe를 다시 잰다 — 스테이징이 핀을 검증한 것은
    // 빌드 머신에서의 일이고, 설치본이 그 결과를 담고 있는지는 여기서만 확인된다.
    let integrity = if !node_exe.is_file() {
        None
    } else {
        match (manifest_node_sha256(&sidecar), sha256_file(&node_exe)) {
            (Some(expected), Some(actual)) => Some((expected == actual, expected, actual)),
            _ => None,
        }
    };
    let contents_ok = all_present && matches!(integrity, Some((true, _, _)));

    let size = dir_size(dir);
    let sidecar_size = if sidecar.is_dir() { dir_size(&sidecar) } else { 0 };
    let build_tree = looks_like_a_build_tree(dir);

    vec![
        check(
            "bundleContents",
            "번들 안에 `sidecar/node.exe`와 `sidecar/index.js`가 있고, 런타임이 핀된 해시와 일치한다.",
            if contents_ok {
                CheckStatus::Passed
            } else {
                CheckStatus::Failed
            },
            format!(
                "{} ({})\n  런타임 무결성: {}",
                present
                    .iter()
                    .map(|(name, ok)| format!("{name}={ok}"))
                    .collect::<Vec<_>>()
                    .join(" "),
                sidecar.display(),
                match &integrity {
                    Some((true, expected, _)) => format!("일치 (manifest {expected})"),
                    Some((false, expected, actual)) =>
                        format!("**불일치** — manifest {expected} / 실제 {actual}"),
                    None => "확인 불가 (manifest.json 또는 node.exe를 읽지 못했습니다)".to_string(),
                }
            ),
        ),
        check(
            "runsWithoutNodeOnPath",
            "설치된 앱을 PATH에 node가 없는 머신에서 실행해 sidecar가 뜬다.",
            CheckStatus::NeedsHuman,
            "번들에 파일이 있다는 것과 그것으로 뜬다는 것은 다른 사실이다.",
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::InstalledBundle]),
        check(
            "sourcesAreBundled",
            "그 실행에서 `ProgramSource`/`EntrySource`가 둘 다 `Bundled`다.",
            CheckStatus::NeedsHuman,
            "앱이 번들이 아닐 때 stderr로 알린다(session.rs) — 그 줄이 없어야 한다.",
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::InstalledBundle]),
        check(
            "bundleSizeRecorded",
            "**설치된 앱 디렉터리**의 크기가 기록된다 — \"크기는 고려하지 않았다\"가 아니라 \"얼마인지 알고 받아들였다\"여야 한다.",
            if build_tree || size == 0 {
                CheckStatus::Failed
            } else {
                CheckStatus::Passed
            },
            if build_tree {
                // 실측에서 실제로 일어난 일이다(기록 5절). 통과로 두면 그 숫자를 아무도
                // 다시 보지 않는다 — "얼마인지 알고 받아들였다"의 반대가 된다.
                format!(
                    "**빌드 트리를 가리키고 있습니다** ({}) — {:.1} MiB는 배포 크기가 아니라 \
                     컴파일 중간 산출물입니다. 설치된 앱 디렉터리를 가리키세요.",
                    dir.display(),
                    size as f64 / (1024.0 * 1024.0)
                )
            } else {
                format!(
                    "앱 {size} 바이트 ({:.1} MiB) / 그중 sidecar 동봉 {:.1} MiB ({})",
                    size as f64 / (1024.0 * 1024.0),
                    sidecar_size as f64 / (1024.0 * 1024.0),
                    dir.display()
                )
            },
        ),
    ]
}

/// Credential Store (`credentials.rs`, `win_credentials.rs`) — multi-engine-routing.md 12절.
///
/// # 네 기준이 두 종류로 갈린다
///
/// 앞의 둘(`storedThroughDpapi`·`noPlaintextAtRest`)은 **Windows API의 동작**이다.
/// `win_credentials.rs`는 Linux에서 한 줄도 컴파일되지 않으므로(`win_job.rs`와 같은 성질 —
/// state-machine 20.5절) 여기서 통과한 `verify`가 그 코드에 대해 말해주는 것이 없다.
///
/// 뒤의 둘(`uiNeverHoldsTheKey`·`injectionStaysOnce`)은 **플랫폼과 무관한 소스 불변식**이다.
/// `appNotInJob`과 같은 자리이므로 Windows를 기다리지 않는다 — 대신 검사가 `verify`에서 돈다
/// (`packages/toolchain/test/credentialBoundary.test.ts`,
/// `apps/desktop/test/frontendTrust.test.ts`). 산문으로만 두면 다음 사람이 되살린다.
fn credential_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.on_windows() {
        (CheckStatus::NeedsHuman, "Windows에서 사람이 확인해야 한다.".to_string())
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — DPAPI도 Credential Manager도 이 플랫폼에 없다.", obs.os),
        )
    };

    vec![
        check(
            "storedThroughDpapi",
            "키를 앱 안에서 넣고 지울 수 있고, 저장이 Windows Credential Manager(DPAPI)를 지난다.",
            status.clone(),
            format!(
                "{detail} 앱에서 키를 넣은 뒤 `control keymgr.dll`(자격 증명 관리자 → Windows 자격 증명)에 \
                 `TomverseCode/<공급자>` 항목이 생기는지, 앱에서 지우면 그 항목이 사라지는지 볼 것. \
                 항목이 보이는 것 자체가 DPAPI를 지났다는 표시다 — Credential Manager는 blob을 그 위에 저장한다."
            ),
        ),
        check(
            "noPlaintextAtRest",
            "저장 후 앱 디렉터리와 설정 어디에도 키 문자열이 평문으로 남지 않는다.",
            status.clone(),
            format!(
                "{detail} 키를 넣은 뒤 상태 디렉터리(`%APPDATA%`의 앱 폴더: state.db·settings·artifacts·로그)와 \
                 번들 디렉터리에서 그 문자열을 찾을 것 — 0건이어야 한다. \
                 **이 경로에는 우리가 만드는 자격증명 파일이 아예 없다**(win_credentials.rs 모듈 주석): \
                 저장은 Credential Manager가 하고 우리는 파일을 만들지 않는다."
            ),
        ),
        check(
            "uiNeverHoldsTheKey",
            "UI 프로세스는 키를 갖지 않는다 — 입력 즉시 Rust로 넘기고 이후 조회는 \"있다/없다\"만 돌려준다(원칙 3).",
            CheckStatus::Passed,
            "플랫폼과 무관한 **소스 불변식**이므로 Windows를 기다리지 않는다. 세 겹으로 지킨다: \
             (1) 값 꺼내기(`CredentialInjection::into_pairs`)가 `pub(crate)`라 껍데기 크레이트는 \
             **꺼낼 수단이 없다** — 컴파일러가 막는다. (2) `Secret`은 `Debug`가 값을 가리고 \
             `Display`/`Serialize`가 없다. (3) 어떤 Tauri command도 값을 돌려주지 않는다는 것을 \
             `credentialBoundary.test.ts`가 소스에서 확인한다.",
        ),
        check(
            "injectionStaysOnce",
            "sidecar에는 여전히 spawn 시 1회 주입이고 허용 목록으로 걸러진다 — 저장소가 생겨도 `credential.get`이 되살아나지 않는다.",
            CheckStatus::Passed,
            "process-architecture 8.2절이 지운 메서드다. 저장소를 만들면서 되살리고 싶어지는 자리이므로 \
             기준으로 못박아 두었고, 이제 **검사가 지킨다**: `host.rs`의 `credential.get`이 여전히 거절하는가, \
             sidecar 소스에 그 메서드를 부르는 곳이 없는가, `read_for_injection`을 부르는 곳이 \
             주입 지점 하나뿐인가 — `credentialBoundary.test.ts`가 셋 다 본다. \
             저장소는 주입 지점 **앞**에 놓이는 것이지 그 경로를 바꾸지 않는다.",
        ),
        check(
            "productionStoreIsNotTheDevelopmentOne",
            "Windows에서 열리는 저장소가 개발용 메모리 저장소로 조용히 물러서지 않는다.",
            status,
            format!(
                "{detail} 앱을 띄우고 자격증명 배너의 저장소 표시가 \"Windows Credential Manager (DPAPI)\"인지 볼 것. \
                 **절반은 여기서 이미 지킨다**: 개발용 구현은 `cfg(any(test, not(windows)))`라 \
                 Windows 릴리스 빌드에 타입 자체가 없고, 폴백을 쓰려면 그 cfg를 고쳐야 한다. \
                 나머지 절반은 '실제로 그 종류가 열리는가'다."
            ),
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
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::NodeAndNpm]),
        check(
            "verificationIsNotSilentlySkipped",
            "그 태스크의 종합 판정이 `could_not_run`이 아니다.",
            skip_status,
            format!(
                "{skip_detail} 이게 이 함정의 **유일하게 눈에 보이는 증상**이다 — \
                 해석이 실패하면 검증이 SKIPPED_WITH_REASON이 되고 작업이 검증 없이 완료로 보고된다."
            ),
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::NodeAndNpm]),
        check(
            "unknownShimIsRefusedNotGuessed",
            "알려지지 않은 `.cmd`/`.bat`는 셸로 감싸지 않고 실패한다.",
            unknown_status,
            format!(
                "{unknown_detail} `cmd.exe /c`로 감싸면 인자의 `&`/`|`/`%`가 재해석되어 \
                 원칙 6(승인 화면의 argv = 실제 실행)이 무너진다."
            ),
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::NodeAndNpm]),
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

/// UNC 워크스페이스에서의 검증 정직성 (`unc.rs`, state-machine 55절).
///
/// # 왜 별도 묶음인가
///
/// `pathNormalization`과 붙여 두고 싶은 유혹이 있다 — 실제로 이 결함은 그 항목을 태우다
/// 드러났다(windows-landing-record 6절). 그러나 묻는 것이 다르다. 저쪽은 **"경로가 깨지지
/// 않는가"**이고, 여기는 **"결과를 정직하게 보고하는가"**다. 저쪽은 이미 ✅였는데 이쪽이
/// 거짓말하고 있었으므로, 한 묶음이었다면 통과가 실패를 가렸을 것이다.
///
/// # Linux에서 확인되는 것과 되지 않는 것
///
/// 판정 로직(`unc::check`)은 바깥 세계를 전부 인자로 받으므로 여기서 검증된다. **그러나
/// 그 판정이 실제 실행 경로에 걸려 있는지, 그리고 cmd.exe가 정말 UNC를 거부하는지는
/// Windows에서만 확인된다** — `msvc.rs`·`python.rs`와 같은 자리다.
fn unc_workspace_checks(obs: &Observations) -> Vec<Check> {
    let (status, detail) = if obs.os == "windows" {
        (
            CheckStatus::NeedsHuman,
            "UNC 워크스페이스에서 사람이 확인해야 한다.".to_string(),
        )
    } else {
        (
            CheckStatus::NotCheckableHere,
            format!("여기는 {} — UNC도 cmd.exe도 이 플랫폼에 없다.", obs.os),
        )
    };
    vec![
        check(
            "npmIsNotSpawnedOnUnc",
            "UNC 워크스페이스의 `npm test`는 **시작되지 않는다** — 결과에 `spawned: false`가 남고 exit code가 없다.",
            status.clone(),
            format!(
                "{detail} 돌려 보고 판정하면 cmd.exe가 `C:\\Windows`로 떨어진 뒤 우연히 낸 \
                 exit 0이 **가짜 통과**가 된다."
            ),
        ),
        check(
            "theReportSaysCouldNotRunNotFailed",
            "그 태스크의 검증 종합 판정이 `could_not_run`이고, 화면이 \"실패\"라고 말하지 않는다.",
            status.clone(),
            format!(
                "{detail} 이 결함의 전부가 이 한 줄이다 — 러너가 테스트 파일을 찾지도 못했는데 \
                 화면이 사용자에게 \"당신의 테스트가 실패했다\"고 말했다."
            ),
        ),
        check(
            "theOpenBannerWarnsBeforeWork",
            "워크스페이스를 **열 때** 경고가 뜬다 — 무엇이 안 도는지, 실패가 아니라는 것, `net use` 안내까지.",
            status.clone(),
            format!(
                "{detail} 결과에서 처음 알면 이미 모델 호출 비용을 쓴 뒤다(격리 실행 공지가 \
                 배너 자리에 있는 것과 같은 이유)."
            ),
        ),
        check(
            "aLocalWorkspaceIsUnaffected",
            "드라이브 문자 워크스페이스(`C:\\...`, 매핑된 `X:\\...`)에서는 npm이 종전과 똑같이 돈다.",
            status,
            format!(
                "{detail} **반대 방향의 거짓말을 확인하는 항목이다** — 로컬 경로를 UNC로 잘못 \
                 읽으면 정상 워크스페이스에서 검증이 통째로 막힌다. `\\\\?\\C:\\`가 `\\\\`로 \
                 시작한다는 사실이 그 함정이다."
            ),
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
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::Python]),
        check(
            "pythonOnPathIsNotTheStoreAlias",
            "PATH의 python이 Microsoft Store 별칭이 아니다.",
            status.clone(),
            format!(
                "{detail} Windows는 `python`/`python3`를 Store 설치 별칭으로 두는 경우가 있고,                  그것을 실행하면 프로그램이 아니라 **스토어 창이 뜬다** — 명령은 걸린 채로 끝나지 않는다.                  그래서 PATH 후보에서 `python3`를 뺐지만, `python` 쪽은 같은 위험이 남는다."
            ),
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::Python]),
        check(
            "venvPathWithSpacesOrDriveLetterSurvives",
            "공백이나 드라이브 문자가 든 가상환경 경로가 그대로 실행된다.",
            status,
            format!(
                "{detail} C:/Users/내 문서/proj/.venv 처럼 공백이 든 경로가 흔하고,                  argv로 넘기므로 인용이 필요 없지만 **그 사실이 실제로 성립하는지는 실행해야 안다**."
            ),
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::Python]),
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
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::VisualStudioWithCxx]),
        check(
            "cargoBuildLinksWithoutADeveloperShell",
            "개발자 셸이 아닌 곳에서 시작한 앱이 `cargo build`를 링크까지 성공시킨다.",
            status.clone(),
            format!(
                "{detail} 이게 이 기능의 **유일하게 눈에 보이는 증상**이다 — 준비가 안 되면                  `stdarg.h: No such file or directory`로 실패하고, 그 문장은 \"C 컴파일러가 없다\"로 읽힌다."
            ),
        )
        .requiring(&[MachineFact::WindowsOs, MachineFact::VisualStudioWithCxx]),
        check(
            "msvcLinkWinsOverGitLink",
            "Git for Windows가 PATH에 있어도 `link.exe`가 MSVC의 것으로 해석된다.",
            status.clone(),
            format!(
                "{detail} 준비한 PATH가 우리 PATH **앞에** 와야 성립한다. 증상은                  `link: extra operand`이고, rustc가 붙이는 힌트는 이 경우 오도한다."
            ),
        )
        .requiring(&[
            MachineFact::WindowsOs,
            MachineFact::VisualStudioWithCxx,
            MachineFact::GitForWindows,
        ]),
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
pub fn assess(obs: &Observations) -> LandingReport {
    let mut groups = vec![
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
            let checks = credential_checks(obs);
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
            let checks = unc_workspace_checks(obs);
            Group {
                id: "uncWorkspace",
                documented_at: "state-machine-and-protocol.md 55절 (`unc.rs`)",
                verdict: verdict_of(&checks),
                checks,
            }
        },
    ];

    // **사람의 확인은 기계의 관측 다음에 온다.** 순서가 반대면 관측이 확인을 덮게 되고,
    // 그러면 `Failed`가 통과로 바뀌는 길이 열린다.
    let attestation = apply_attestation(&mut groups, obs);

    let all: Vec<&Check> = groups.iter().flat_map(|g| g.checks.iter()).collect();
    let verdict = if all.iter().any(|c| c.status == CheckStatus::Failed) {
        Verdict::NotLanded
    } else if all.iter().all(|c| c.status.is_pass()) {
        Verdict::Landed
    } else {
        Verdict::Incomplete
    };

    let attested_passes = all.iter().filter(|c| c.attestation.is_some()).count();
    let remaining = all
        .iter()
        .filter(|c| !c.status.is_pass())
        .map(|c| format!("[{}] {} — {}", c.id, c.criterion, c.detail))
        .collect();

    LandingReport {
        platform: obs.os.clone(),
        head_commit: obs.head_commit.clone(),
        groups,
        verdict,
        attested_passes,
        remaining,
        attestation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux() -> Observations {
        Observations {
            os: "linux".to_string(),
            bundle_dir: None,
            head_commit: None,
            attestation: None,
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
            head_commit: None,
            attestation: None,
        };
        let report = assess(&obs);
        let bundle = report.groups.iter().find(|g| g.id == "sidecarBundle").unwrap();
        let contents = bundle.checks.iter().find(|c| c.id == "bundleContents").unwrap();
        assert_eq!(contents.status, CheckStatus::Failed);
        assert_eq!(bundle.verdict, Verdict::NotLanded);
    }

    /// `scripts/stage-sidecar.mjs`가 만드는 것과 같은 모양을 만든다.
    /// `runtime`을 바꾸면 manifest에 적힌 해시와 어긋나게 할 수 있다.
    fn staged_bundle(dir: &Path, runtime: &[u8], manifest_sha: Option<&str>) {
        use sha2::{Digest, Sha256};
        let sidecar = dir.join("sidecar");
        std::fs::create_dir_all(&sidecar).unwrap();
        std::fs::write(sidecar.join("node.exe"), runtime).unwrap();
        std::fs::write(sidecar.join("index.js"), "console.log(1);").unwrap();
        std::fs::write(sidecar.join("package.json"), r#"{"type":"module"}"#).unwrap();
        std::fs::write(sidecar.join("node.LICENSE"), "MIT").unwrap();
        let sha = manifest_sha
            .map(str::to_string)
            .unwrap_or_else(|| format!("{:x}", Sha256::digest(runtime)));
        std::fs::write(
            sidecar.join("manifest.json"),
            format!(r#"{{"node":{{"version":"v24.20.0","sha256":"{sha}"}}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn a_bundle_with_the_runtime_passes_and_records_its_size() {
        let dir = tempfile::tempdir().unwrap();
        staged_bundle(dir.path(), &vec![0u8; 2048], None);

        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
            head_commit: None,
            attestation: None,
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
        // 앱 전체와 동봉분을 **따로** 적는다 — 합계만 있으면 동봉이 얼마를 차지하는지 모른다.
        assert!(size.detail.contains("sidecar 동봉"), "{}", size.detail);
    }

    /// **파일이 있다는 것과 그것이 우리가 승인한 바이트라는 것은 다른 사실이다.**
    ///
    /// 스테이징이 핀을 검증한 것은 빌드 머신에서의 일이고, 설치본이 그 결과를 담고 있는지는
    /// 설치본을 봐야 안다. 여기가 갈라지는 경로는 실재한다 — 스테이징 후 `tauri build` 전에
    /// 누가 파일을 갈아 끼우거나, 이전 빌드의 잔여물이 섞이는 것.
    #[test]
    fn a_runtime_that_does_not_match_the_manifest_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        staged_bundle(
            dir.path(),
            b"different bytes",
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        );

        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
            head_commit: None,
            attestation: None,
        };
        let report = assess(&obs);
        let check = status_of(&report, "sidecarBundle", "bundleContents");
        assert_eq!(check.status, CheckStatus::Failed);
        assert!(check.detail.contains("불일치"), "{}", check.detail);
    }

    /// `package.json`이 없으면 Node가 진입점을 CommonJS로 읽어 **첫 줄에서** 죽는다.
    /// 파일이 대부분 있으므로 "번들은 됐다"로 읽히기 쉬운 자리다.
    #[test]
    fn a_bundle_without_the_esm_anchor_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        staged_bundle(dir.path(), &vec![0u8; 16], None);
        std::fs::remove_file(dir.path().join("sidecar").join("package.json")).unwrap();

        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
            head_commit: None,
            attestation: None,
        };
        let report = assess(&obs);
        let check = status_of(&report, "sidecarBundle", "bundleContents");
        assert_eq!(check.status, CheckStatus::Failed);
        assert!(check.detail.contains("package.json=false"), "{}", check.detail);
    }

    /// **빌드 트리를 배포 크기로 세지 않는다.**
    ///
    /// 실측에서 `--bundle target/release`를 준 탓에 1586.9 MiB가 "기록됨"으로 통과했다
    /// (기록 5절). 통과 표시가 붙으면 그 숫자를 아무도 다시 보지 않으므로,
    /// "얼마인지 알고 받아들였다"라는 기준이 정확히 거꾸로 뒤집힌다.
    #[test]
    fn pointing_at_a_build_tree_is_not_a_recorded_bundle_size() {
        let dir = tempfile::tempdir().unwrap();
        staged_bundle(dir.path(), &vec![0u8; 64], None);
        for name in ["build", "deps", ".fingerprint"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        std::fs::write(dir.path().join("deps").join("big.rlib"), vec![0u8; 4096]).unwrap();

        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
            head_commit: None,
            attestation: None,
        };
        let report = assess(&obs);
        let size = status_of(&report, "sidecarBundle", "bundleSizeRecorded");
        assert_eq!(size.status, CheckStatus::Failed);
        assert!(size.detail.contains("빌드 트리"), "{}", size.detail);
    }

    /// 번들 안의 자리는 `launcher.rs`가 찾는 곳과 **같은 상수**에서 온다.
    /// 여기서 문자열을 다시 적으면 갈라지고, 갈라진 결과는 조용하다.
    #[test]
    fn the_bundle_layout_comes_from_the_launcher_constants() {
        let bundle = Path::new("/app");
        assert_eq!(sidecar_dir(bundle), bundle.join(crate::launcher::BUNDLE_DIR));
        assert_eq!(crate::launcher::ENTRY_FILE, "index.js");
        assert_eq!(crate::launcher::runtime_file_name(true), "node.exe");
    }

    /// **Credential Store의 기준은 두 종류다** — 그리고 그 구분이 보고서에 남아야 한다.
    ///
    /// 소스 불변식(`uiNeverHoldsTheKey`·`injectionStaysOnce`)은 플랫폼과 무관하므로 Linux에서
    /// 통과한다. Windows API의 동작(DPAPI 저장·평문 미잔존·실제로 열리는 저장소 종류)은
    /// 여기서 볼 수 없다. **둘을 같은 상태로 적으면 어느 쪽이 남은 일인지 알 수 없다.**
    #[test]
    fn the_credential_store_separates_source_invariants_from_windows_behaviour() {
        let report = assess(&linux());
        let cred = report.groups.iter().find(|g| g.id == "credentialStore").unwrap();

        for id in ["uiNeverHoldsTheKey", "injectionStaysOnce"] {
            let c = cred.checks.iter().find(|c| c.id == id).unwrap();
            assert_eq!(c.status, CheckStatus::Passed, "{id}는 소스 불변식이라 Linux에서 판정된다");
        }
        for id in ["storedThroughDpapi", "noPlaintextAtRest", "productionStoreIsNotTheDevelopmentOne"] {
            let c = cred.checks.iter().find(|c| c.id == id).unwrap();
            assert_eq!(c.status, CheckStatus::NotCheckableHere, "{id}는 Windows에서만 확인된다");
        }

        // 소스 불변식이 통과했다고 묶음이 착지한 것은 아니다.
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

    // ---- 사람의 확인을 받아들이는 입구 (기록 15절) ----
    //
    // 여기서 지키는 것은 "숫자가 줄어든다"가 아니다. **줄어들면 안 되는 자리에서 줄어들지
    // 않는 것**이다 — 관측된 실패, 없는 기능, 없는 머신, 다른 커밋.

    use crate::landing_attest::{AttestationSource, MachineSpec};
    use serde_json::{json, Value};

    const HEAD: &str = "206d2ef3678c13722f29cb025693f2e6ad8b8307";

    /// 실측 머신(기록 1절)을 그대로 옮긴 사양 — **Python이 없다.**
    fn measured_machine() -> Value {
        json!({
            "os": "windows",
            "osVersion": "10.0.19045",
            "nodeVersion": "v22.22.2",
            "npmShim": "C:\\nvm4w\\nodejs\\npm.CMD",
            "visualStudio": "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
            "gitForWindows": "C:\\Program Files\\Git",
            "gitAutocrlf": "true",
            "python": null,
            "installedBundle": null
        })
    }

    fn attestation_for(commit: &str, machine: Value, checks: Value) -> AttestationSource {
        let mut raw = json!({
            "schemaVersion": crate::landing_attest::SCHEMA_VERSION,
            "kind": crate::landing_attest::KIND,
            "attestationId": "test",
            "attestedBy": "Vyper",
            "createdAt": "2026-08-27T00:00:00Z",
            "commit": commit,
            "machine": machine,
            "checks": checks,
            "attestationHash": ""
        });
        let hash = crate::landing_attest::hash_excluding_field(&raw, crate::landing_attest::HASH_FIELD).expect("해시");
        raw[crate::landing_attest::HASH_FIELD] = json!(hash);
        AttestationSource {
            file: "test.json".to_string(),
            parsed: crate::landing_attest::parse(&raw),
        }
    }

    fn attested(group: &str, check: &str) -> Value {
        json!([{
            "group": group,
            "check": check,
            "observedAt": "2026-08-27T00:00:00Z",
            "evidence": "실행 기록에서 직접 확인했다"
        }])
    }

    fn windows_with(attestation: AttestationSource, head: Option<&str>) -> Observations {
        Observations {
            os: "windows".to_string(),
            bundle_dir: None,
            head_commit: head.map(|h| h.to_string()),
            attestation: Some(attestation),
        }
    }

    fn status_of<'a>(report: &'a LandingReport, group: &str, check: &str) -> &'a Check {
        report
            .groups
            .iter()
            .find(|g| g.id == group)
            .unwrap_or_else(|| panic!("그룹이 없습니다: {group}"))
            .checks
            .iter()
            .find(|c| c.id == check)
            .unwrap_or_else(|| panic!("기준이 없습니다: {check}"))
    }

    /// **입구가 실제로 열린다.** 사람이 확인한 것은 통과가 되고, **누가·어디서·언제·무엇을
    /// 보고** 확인했는지가 보고서에 남는다 — 숫자가 줄어드는 것이 아니라 이게 목적이다.
    #[test]
    fn a_human_check_lands_with_its_provenance_attached() {
        let obs = windows_with(
            attestation_for(HEAD, measured_machine(), attested("commandResolution", "npmResolvesToNodeCli")),
            Some(HEAD),
        );
        let report = assess(&obs);

        let check = status_of(&report, "commandResolution", "npmResolvesToNodeCli");
        assert_eq!(check.status, CheckStatus::Passed);
        let by = check.attestation.as_ref().expect("출처가 남지 않았습니다");
        assert_eq!(by.attested_by, "Vyper");
        assert_eq!(by.commit, HEAD);
        assert!(by.machine.contains("10.0.19045"), "{}", by.machine);
        assert!(!by.evidence.trim().is_empty());

        // 기계가 본 통과와 **같은 칸에 넣지 않는다.**
        assert_eq!(report.attested_passes, 1);
        let att = report.attestation.as_ref().expect("attestation 보고가 없습니다");
        assert_eq!(att.status, AttestationStatus::Accepted);
        assert_eq!(att.accepted, vec!["commandResolution/npmResolvesToNodeCli".to_string()]);
    }

    /// **커밋이 바뀌면 만료된다.** 옛 확인이 새 코드를 통과시키면 이 도구가 착시를 만든다.
    #[test]
    fn an_attestation_from_another_commit_expires_and_changes_nothing() {
        let old = "206d2ef";
        let now = "f9767a3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let obs = windows_with(
            attestation_for(old, measured_machine(), attested("commandResolution", "npmResolvesToNodeCli")),
            Some(now),
        );
        let report = assess(&obs);

        assert_eq!(status_of(&report, "commandResolution", "npmResolvesToNodeCli").status, CheckStatus::NeedsHuman);
        assert_eq!(report.attested_passes, 0);
        let att = report.attestation.as_ref().unwrap();
        assert_eq!(att.status, AttestationStatus::Expired);
        assert!(att.accepted.is_empty());
        assert!(att.rejections[0].reason.contains("만료"), "{:?}", att.rejections);
    }

    /// 짧게 적은 커밋이 지금 커밋의 접두사면 같은 커밋이다 — 사람은 7자리로 적는다.
    #[test]
    fn a_short_commit_that_prefixes_head_is_not_expired() {
        let obs = windows_with(
            attestation_for("206d2ef", measured_machine(), attested("commandResolution", "npmResolvesToNodeCli")),
            Some(HEAD),
        );
        let report = assess(&obs);
        assert_eq!(report.attestation.as_ref().unwrap().status, AttestationStatus::Accepted);
    }

    /// 지금 커밋을 모르면 **반영하지 않는다.** 만료 여부를 판정할 수 없는데 통과시키면
    /// 만료가 있으나 마나다.
    #[test]
    fn without_a_head_commit_nothing_is_applied() {
        let obs = windows_with(
            attestation_for(HEAD, measured_machine(), attested("commandResolution", "npmResolvesToNodeCli")),
            None,
        );
        let report = assess(&obs);
        assert_eq!(report.attested_passes, 0);
        assert_eq!(report.attestation.as_ref().unwrap().status, AttestationStatus::Inapplicable);
    }

    /// **attestation은 `Failed`를 덮지 못한다.**
    ///
    /// 기록 5절이 바로 이 자리다: 번들에 sidecar가 없다는 것은 도구가 **봤고**, 그 사실을
    /// 사람의 종이가 지워서는 안 된다.
    #[test]
    fn an_attestation_cannot_erase_an_observed_failure() {
        let dir = tempfile::tempdir().unwrap();
        let obs = Observations {
            os: "windows".to_string(),
            bundle_dir: Some(dir.path().to_path_buf()),
            head_commit: Some(HEAD.to_string()),
            attestation: Some(attestation_for(
                HEAD,
                measured_machine(),
                attested("sidecarBundle", "bundleContents"),
            )),
        };
        let report = assess(&obs);

        let check = status_of(&report, "sidecarBundle", "bundleContents");
        assert_eq!(check.status, CheckStatus::Failed);
        assert!(check.attestation.is_none());
        assert_eq!(report.verdict, Verdict::NotLanded);

        let att = report.attestation.as_ref().unwrap();
        assert_eq!(att.status, AttestationStatus::PartiallyAccepted);
        assert!(att.rejections[0].reason.contains("실패로 관측"), "{:?}", att.rejections);
    }

    /// **없는 기능은 확인할 수 없다.** `NotImplemented`도 덮이지 않는다 —
    /// 덮이면 "만들었는데 확인했다"가 된다.
    ///
    /// # 왜 실제 보고서가 아니라 만든 묶음으로 재는가
    ///
    /// 종전에는 `credentialStore/storedThroughDpapi`로 쟀다. 그 기능을 만드는 순간 이 테스트가
    /// 깨졌는데, **깨진 것이 규칙이 아니라 예시였다.** 규칙을 그때그때 남아 있는 미구현 기능에
    /// 묶으면 마지막 하나를 만들 때 이 규칙을 검사할 방법이 사라진다 — 그때 규칙을 지우고
    /// 싶어지고, 그러면 다음에 `NotImplemented`가 생겼을 때 아무도 막지 않는다.
    #[test]
    fn an_attestation_cannot_pass_an_unbuilt_feature() {
        let mut groups = vec![Group {
            id: "credentialStore",
            documented_at: "테스트용",
            checks: vec![check(
                "storedThroughDpapi",
                "아직 만들지 않은 기능",
                CheckStatus::NotImplemented,
                "테스트용",
            )],
            verdict: Verdict::Incomplete,
        }];
        let obs = windows_with(
            attestation_for(HEAD, measured_machine(), attested("credentialStore", "storedThroughDpapi")),
            Some(HEAD),
        );

        let report = apply_attestation(&mut groups, &obs).unwrap();

        assert_eq!(groups[0].checks[0].status, CheckStatus::NotImplemented);
        assert!(groups[0].checks[0].attestation.is_none());
        assert!(report.accepted.is_empty());
        assert!(report.rejections[0].reason.contains("기능이 아직 없습니다"), "{report:?}");
    }

    /// **머신 사양이 판정에 반영된다.**
    ///
    /// 실측 머신에는 Python이 없었다(기록 1·10절). "Python으로 확인했다"는 Python이 있는
    /// 머신에서만 뜻이 있으므로, 같은 문장을 적어도 그 머신에서는 통과하지 않는다.
    #[test]
    fn a_machine_without_python_cannot_attest_the_python_criteria() {
        let obs = windows_with(
            attestation_for(
                HEAD,
                measured_machine(),
                attested("pythonEnv", "venvInterpreterRunsWithoutActivation"),
            ),
            Some(HEAD),
        );
        let report = assess(&obs);

        assert_eq!(
            status_of(&report, "pythonEnv", "venvInterpreterRunsWithoutActivation").status,
            CheckStatus::NeedsHuman
        );
        assert_eq!(report.attested_passes, 0);
        let rejection = &report.attestation.as_ref().unwrap().rejections[0];
        assert!(rejection.reason.contains("Python"), "{}", rejection.reason);

        // **같은 문장이 Python이 있는 머신에서는 통과한다.** 아니면 이 검사는 "pythonEnv는
        // 영원히 통과하지 못한다"를 확인한 것이지 머신 사양을 확인한 것이 아니다.
        let mut with_python = measured_machine();
        with_python["python"] = json!("C:\\Python312\\python.exe");
        let ok = windows_with(
            attestation_for(HEAD, with_python, attested("pythonEnv", "venvInterpreterRunsWithoutActivation")),
            Some(HEAD),
        );
        assert_eq!(assess(&ok).attested_passes, 1);
    }

    /// Windows가 아닌 머신의 확인은 Windows 기준의 확인이 아니다 — 기본 요구가 그것이다.
    #[test]
    fn a_non_windows_machine_cannot_attest_anything_here() {
        let mut linux_machine = measured_machine();
        linux_machine["os"] = json!("linux");
        let obs = windows_with(
            attestation_for(HEAD, linux_machine, attested("processGroup", "childGetsItsOwnProcessGroup")),
            Some(HEAD),
        );
        let report = assess(&obs);
        assert_eq!(report.attested_passes, 0);
        assert!(report.attestation.as_ref().unwrap().rejections[0].reason.contains("Windows"));
    }

    /// **모든 기준에 요구가 붙어 있고, 그 요구는 Windows를 포함한다.**
    ///
    /// 빈 목록을 허용하면 새 기준을 추가할 때 요구를 적지 않는 것이 가장 쉬운 길이 되고,
    /// 그러면 아무 머신에서 확인했다고 적어도 통과한다.
    #[test]
    fn every_criterion_declares_what_the_machine_must_have() {
        let report = assess(&linux());
        for group in &report.groups {
            for check in &group.checks {
                assert!(
                    check.requires.contains(&crate::landing_attest::MachineFact::WindowsOs),
                    "{}/{}의 요구에 Windows가 없습니다: {:?}",
                    group.id,
                    check.id,
                    check.requires
                );
            }
        }
    }

    /// 여기서는 볼 수 없는 것(`NotCheckableHere`)이 다른 머신의 확인으로 채워진다 —
    /// 그게 이 입구의 용도다. Linux에서 Windows 기준을 판정하는 유일한 정당한 길이다.
    #[test]
    fn an_attestation_answers_what_this_platform_cannot_see() {
        let obs = Observations {
            os: "linux".to_string(),
            bundle_dir: None,
            head_commit: Some(HEAD.to_string()),
            attestation: Some(attestation_for(
                HEAD,
                measured_machine(),
                attested("pathNormalization", "verbatimPrefixStripped"),
            )),
        };
        let report = assess(&obs);
        let check = status_of(&report, "pathNormalization", "verbatimPrefixStripped");
        assert_eq!(check.status, CheckStatus::Passed);
        assert_eq!(check.attestation.as_ref().unwrap().attested_by, "Vyper");
    }

    /// 없는 기준을 적으면 **조용히 넘어가지 않는다.** 오타 하나가 아무 말 없이 사라지면
    /// 사람은 확인이 반영된 줄 안다.
    #[test]
    fn an_unknown_criterion_is_reported_not_ignored() {
        let obs = windows_with(
            attestation_for(HEAD, measured_machine(), attested("commandResolution", "noSuchCheck")),
            Some(HEAD),
        );
        let att = assess(&obs).attestation.expect("보고가 없습니다");
        assert_eq!(att.status, AttestationStatus::PartiallyAccepted);
        assert!(att.rejections[0].reason.contains("그런 기준이 없습니다"), "{:?}", att.rejections);
    }

    /// 읽히지 않는 파일은 **없는 것으로 치지 않는다** — 왜 못 읽었는지가 남는다.
    #[test]
    fn a_broken_file_is_reported_not_treated_as_absent() {
        let obs = windows_with(
            AttestationSource {
                file: "broken.json".to_string(),
                parsed: Err(vec!["attestation이 JSON이 아닙니다".to_string()]),
            },
            Some(HEAD),
        );
        let att = assess(&obs).attestation.expect("보고가 없습니다");
        assert_eq!(att.status, AttestationStatus::Rejected);
        assert_eq!(att.rejections.len(), 1);
    }

    /// **저장소에 커밋된 실측 기록**(기록 8~12절을 옮긴 것)이 형식으로 성립한다.
    ///
    /// 그리고 그 파일은 지금 커밋에서 **만료**다 — `206d2ef`에서 확인한 것이기 때문이다.
    /// 그게 정상이고, 만료가 실제로 동작한다는 증거다.
    #[test]
    fn the_recorded_measurement_parses_and_is_scoped_to_its_commit() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../docs/design/attestations/windows-landing-206d2ef.json");
        let source = crate::landing_attest::read_file(&file);
        let attestation = match &source.parsed {
            Ok(a) => a,
            Err(reasons) => panic!("커밋된 실측 기록이 읽히지 않습니다 ({}): {reasons:?}", file.display()),
        };
        assert_eq!(attestation.commit, "206d2ef");

        // 실측 머신에는 Python이 없었다. **그러므로 pythonEnv를 적어서는 안 된다** —
        // 적혀 있으면 이 기록이 실측과 어긋난 것이다.
        let machine: &MachineSpec = &attestation.machine;
        assert!(machine.python.is_none(), "실측 머신에는 Python이 없었습니다");
        assert!(
            !attestation.checks.iter().any(|c| c.group == "pythonEnv"),
            "확인할 수 없었던 pythonEnv가 기록에 들어 있습니다"
        );

        // 그 커밋에서는 반영되고, 다른 커밋에서는 만료된다.
        let at_206 = assess(&Observations {
            os: "windows".to_string(),
            bundle_dir: None,
            head_commit: Some("206d2ef3678c13722f29cb025693f2e6ad8b8307".to_string()),
            attestation: Some(source.clone()),
        });
        // **적은 것이 전부 반영되어야 한다.** `> 0`으로 두면 id 오타 하나가 조용히 지나간다 —
        // 거부는 보고서에 남지만, 테스트가 그것을 보지 않으면 아무도 보지 않는다.
        let applied = at_206.attestation.as_ref().expect("보고가 없습니다");
        assert_eq!(applied.status, AttestationStatus::Accepted, "{:?}", applied.rejections);
        assert_eq!(applied.accepted.len(), attestation.checks.len());
        assert_eq!(at_206.attested_passes, attestation.checks.len());

        let elsewhere = assess(&Observations {
            os: "windows".to_string(),
            bundle_dir: None,
            head_commit: Some("0000000000000000000000000000000000000000".to_string()),
            attestation: Some(source),
        });
        assert_eq!(elsewhere.attested_passes, 0);
        assert_eq!(elsewhere.attestation.unwrap().status, AttestationStatus::Expired);
    }
}
