//! Hooks — phase 전환에 사용자가 등록한 명령을 실행한다.
//!
//! product-strategy 8.2절 기준: **"주요 phase 전환에 사용자 스크립트 실행. 스크립트 실행도
//! Policy Gate 적용"**. state-machine-and-protocol.md 25절.
//!
//! # 왜 Rust가 트리거를 잡는가
//!
//! phase 전환은 Node의 오케스트레이터가 만들지만, 그 사실은 `PHASE_CHANGED` 이벤트로
//! `TaskHost::append_event`를 지나 저장된다 — 신뢰 경계 안이다. 훅을 거기서 걸면 Node가
//! **훅이 도는 것을 막을 수 없다**(막으려면 phase 전환 자체를 보고하지 않아야 하는데,
//! 그러면 태스크가 아무 데도 가지 못한다).
//!
//! Node에 훅 실행을 맡기면 원칙 2가 깨진다. 훅은 임의의 프로그램이고, "Node는 셸을 실행하지
//! 않는다"가 거짓이 된다 — MCP에서 정한 것과 같은 규칙이다(23.1절).
//!
//! # 무엇을 보장하고 무엇을 보장하지 않는가
//!
//! **보장한다**: 실행된 argv가 사용자가 등록한 argv와 **정확히 같다**(원칙 6). 모델은 훅을
//! 등록할 수도, 등록된 훅의 argv를 바꿀 수도 없다 — 등록 경로가 사용자에게만 있다. 모든 훅
//! 실행은 Policy Gate를 지나고 도구 실행으로 기록된다.
//!
//! **보장하지 않는다**: 그 프로그램이 무엇을 하는지. 훅은 우리 게이트 밖에서 파일을 고치고
//! 네트워크를 쓸 수 있다 — MCP와 같은 성질이고(23.5절), 같은 이유로 등록은 사용자만 한다.
//!
//! # 훅은 판정을 바꾸지 않는다
//!
//! 실패한 훅은 기록되지만 **태스크의 결과를 바꾸지 않는다.** 원칙 1이 정한 판정자는 결정론적
//! 검증이고, 사용자 훅은 검증이 아니다. 훅이 판정에 끼어들 수 있게 하면 "이 도구가 완료라고
//! 한 것은 build/test/lint를 통과했다는 뜻"이라는 성질이 훅마다 달라진다.
//!
//! 이 한계는 **기능이 얕다는 뜻이기도 하다** — 차단형 훅(pre-commit처럼 진행을 막는 것)은
//! 하지 않는다. 패리티 기능은 "일반 사례 동작 + 한계 명시"로 시작한다(8.1절).

use crate::types::RunCommandArgs;

/// 등록된 훅 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookConfig {
    /// 이 phase로 **들어갈 때** 실행한다.
    pub phase: String,
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HookConfigError {
    #[error("훅의 phase가 비었습니다")]
    EmptyPhase,
    #[error("알 수 없는 phase입니다: {phase} (알려진 phase: {known})")]
    UnknownPhase { phase: String, known: String },
    #[error("훅 {phase}에 프로그램이 없습니다")]
    EmptyProgram { phase: String },
    #[error("훅 {phase}의 프로그램 자리에 명령 문자열이 들어왔습니다: {program:?} — program과 args를 나눠 주세요")]
    LooksLikeCommandString { phase: String, program: String },
}

/// 훅을 걸 수 있는 phase.
///
/// **`TaskPhase`(TypeScript)의 부분집합이며, 여기에만 적혀 있다.** 두 곳에 적으면 갈라지고,
/// 갈라진 쪽이 조용하다 — 오타 난 phase는 그냥 **영원히 안 도는 훅**이 된다. 그래서
/// `packages/sidecar/test/hookPhases.test.ts`가 이 목록이 실제 `TaskPhase`의 부분집합인지를
/// **양쪽 소스에서 유도해** 확인한다(2.2절 터미널 목록과 같은 처리다).
///
/// 전부를 열지 않은 이유: phase는 우리 내부 구현이고 일부는 이름이 바뀔 수 있다. 사용자가
/// 걸 만한 자리만 연다 — 시작, 검증 전후, 그리고 끝나는 방식 세 가지.
pub const HOOKABLE_PHASES: &[&str] = &[
    "PLANNING",
    "EXECUTING",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
];

/// 등록 시점 검증. **여기서 막지 못한 오타는 조용한 훅이 된다.**
pub fn validate_hooks(hooks: &[HookConfig]) -> Result<(), HookConfigError> {
    for hook in hooks {
        if hook.phase.trim().is_empty() {
            return Err(HookConfigError::EmptyPhase);
        }
        if !HOOKABLE_PHASES.contains(&hook.phase.as_str()) {
            return Err(HookConfigError::UnknownPhase {
                phase: hook.phase.clone(),
                known: HOOKABLE_PHASES.join(", "),
            });
        }
        if hook.program.trim().is_empty() {
            return Err(HookConfigError::EmptyProgram {
                phase: hook.phase.clone(),
            });
        }
        // MCP와 같은 검사다(23.6절): `sh -c "..."`를 program 한 칸에 우겨넣는 것을 막는다.
        // 완벽한 판정이 아니라는 것도 같다 — 여기서 잡는 것은 공격이 아니라 흔한 설정 실수다.
        if looks_like_command_string(&hook.program) {
            return Err(HookConfigError::LooksLikeCommandString {
                phase: hook.phase.clone(),
                program: hook.program.clone(),
            });
        }
    }
    Ok(())
}

fn looks_like_command_string(program: &str) -> bool {
    if program
        .chars()
        .any(|c| matches!(c, '|' | '&' | ';' | '>' | '<' | '\n' | '\'' | '"'))
    {
        return true;
    }
    program.split(' ').skip(1).any(|token| token.starts_with('-'))
}

/// 등록된 훅 모음. 조회만 한다 — 실행은 `TaskHost`가 한다(게이트를 지나야 하므로).
#[derive(Debug, Default)]
pub struct HookRegistry {
    hooks: Vec<HookConfig>,
}

impl HookRegistry {
    pub fn new(hooks: Vec<HookConfig>) -> Self {
        Self { hooks }
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }

    /// 이 phase에 걸린 훅들 — **등록 순서 그대로**. 순서를 바꾸면 사용자가 적은 순서와
    /// 실행 순서가 달라지고, 훅끼리 의존이 있을 때(포맷 후 커밋) 조용히 틀린다.
    pub fn for_phase(&self, phase: &str) -> Vec<&HookConfig> {
        self.hooks.iter().filter(|h| h.phase == phase).collect()
    }

    /// 이 argv가 **등록된 훅과 정확히 같은가**. 승인의 근거가 되므로 완전 일치만 인정한다.
    pub fn matches_registered(&self, program: &str, args: &[String]) -> bool {
        self.hooks.iter().any(|h| h.program == program && h.args == args)
    }
}

impl HookConfig {
    /// 실행할 명령. cwd는 **언제나 워크스페이스 루트**다 — 훅이 하위 디렉터리를 고르게 하면
    /// 등록된 것과 실행되는 것 사이에 축이 하나 늘고, 승인 근거인 "완전 일치"가 흐려진다.
    pub fn command(&self) -> RunCommandArgs {
        RunCommandArgs {
            program: self.program.clone(),
            args: self.args.clone(),
            cwd: ".".to_string(),
            timeout_ms: None,
        }
    }

    /// 사람이 읽는 한 줄. 이벤트에 그대로 들어간다.
    pub fn describe(&self) -> String {
        if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(phase: &str, program: &str, args: &[&str]) -> HookConfig {
        HookConfig {
            phase: phase.to_string(),
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// 오타 난 phase를 통과시키면 **영원히 안 도는 훅**이 된다 — 사용자에게는 "훅이 동작하지
    /// 않는다"로 보이고, 원인이 자기 오타라는 것을 알 방법이 없다.
    #[test]
    fn a_misspelled_phase_is_rejected_at_registration() {
        let err = validate_hooks(&[hook("VERIFYNG", "node", &["x.js"])]).unwrap_err();
        match err {
            HookConfigError::UnknownPhase { phase, known } => {
                assert_eq!(phase, "VERIFYNG");
                // 무엇을 쓸 수 있는지 함께 말한다 — 거부만 하면 사용자가 추측하게 된다.
                assert!(known.contains("VERIFYING"), "{known}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_known_phase_passes() {
        for phase in HOOKABLE_PHASES {
            validate_hooks(&[hook(phase, "node", &["x.js"])]).unwrap();
        }
    }

    /// 23.6절과 같은 검사. 여기서 통과시키면 원칙 6의 보장("보이는 것이 실행되는 것")이
    /// 훅에서만 예외가 된다.
    #[test]
    fn a_command_string_in_the_program_slot_is_rejected() {
        for bad in ["sh -c 'echo hi'", "node x.js && rm -rf /", "npm run a | tee b"] {
            assert!(
                validate_hooks(&[hook("COMPLETED", bad, &[])]).is_err(),
                "명령 문자열이 통과했습니다: {bad}"
            );
        }
        // 공백이 든 정상 경로는 막지 않는다 — Windows의 흔한 설치 경로다.
        validate_hooks(&[hook("COMPLETED", r"C:\Program Files\nodejs\node.exe", &["x.js"])]).unwrap();
    }

    /// 등록 순서가 실행 순서다. 훅끼리 의존이 있을 때(포맷 후 커밋) 이게 뒤집히면 조용히 틀린다.
    #[test]
    fn hooks_run_in_registration_order() {
        let registry = HookRegistry::new(vec![
            hook("COMPLETED", "node", &["first.js"]),
            hook("VERIFYING", "node", &["other.js"]),
            hook("COMPLETED", "node", &["second.js"]),
        ]);
        let selected: Vec<String> = registry.for_phase("COMPLETED").iter().map(|h| h.describe()).collect();
        assert_eq!(selected, vec!["node first.js".to_string(), "node second.js".to_string()]);
    }

    /// 승인의 근거는 **완전 일치**다. 인자가 붙거나 빠진 것은 다른 명령이다.
    #[test]
    fn a_near_miss_is_not_a_registered_hook() {
        let registry = HookRegistry::new(vec![hook("COMPLETED", "node", &["fmt.js"])]);
        assert!(registry.matches_registered("node", &["fmt.js".to_string()]));
        assert!(!registry.matches_registered("node", &["fmt.js".to_string(), "--write".to_string()]));
        assert!(!registry.matches_registered("node", &[]));
        assert!(!registry.matches_registered("npm", &["fmt.js".to_string()]));
    }
}
