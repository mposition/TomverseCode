//! Tomverse Code — Rust 신뢰 경계.
//!
//! 이 크레이트가 담는 것 (docs/design/process-architecture.md 2절, 7절):
//!  - **Policy Gate**: 도구 실행 여부의 최종 판단
//!  - **Tool Runtime**: 파일 I/O와 프로세스 실행. Node에는 이 능력이 없다
//!  - **Store**: SQLite. Rust가 유일한 writer이며 `task_events`는 append-only
//!  - **Verification Runner**: 결정론적 판정자. Node가 검증했다고 주장할 수 없다
//!  - **Sidecar IPC**: Node sidecar spawn 및 NDJSON 왕복
//!
//! 담지 않는 것: UI, LLM 호출, 오케스트레이션 상태 머신. 앞의 둘은 각각 Tauri 웹뷰와
//! Node sidecar의 몫이고, 상태 머신은 Node가 소유한다.
//!
//! `tauri`에 의존하지 않으므로 GUI 시스템 라이브러리 없이 `cargo test`가 돌아간다.

pub mod artifacts;
pub mod cancel;
pub mod host;
pub mod metrics;
pub mod paths;
pub mod policy;
pub mod proctree;
pub mod sidecar;
pub mod store;
pub mod time;
pub mod tools;
pub mod types;
pub mod verify;
#[cfg(windows)]
pub(crate) mod win_job;

pub use artifacts::ArtifactStore;
pub use cancel::{CancelOutcome, CancellationRegistry, CancellationToken};
pub use host::{ApprovalGateway, ApprovalOutcome, AutoApprove, EventSink, TaskHost};
pub use paths::{PathViolation, SafePath, WorkspaceRoot};
pub use policy::PolicyGate;
pub use sidecar::{SidecarClient, SidecarHandler, SpawnConfig};
pub use store::{Store, SCHEMA_VERSION};
pub use tools::ToolRuntime;
pub use verify::VerificationRunner;

/// Node sidecar와 맞춰야 하는 프로토콜 버전 (process-architecture.md 5절).
/// `packages/sidecar/src/index.ts`의 `PROTOCOL_VERSION`과 같아야 한다.
pub const PROTOCOL_VERSION: &str = "0.2.0";

/// 자격증명 환경변수 이름 → 공급자 id.
///
/// M0에서는 Windows Credential Manager 연동 대신 환경변수를 지원한다(작업 지침 4.9절).
/// 이 값들은 sidecar spawn 시 자식 환경으로 주입되고, UI에는 "설정됨/미설정"만 노출된다 —
/// 값 자체는 UI로도 로그로도 나가지 않는다.
pub const PROVIDER_ENV_VARS: &[(&str, &str)] = &[("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY")];

/// 어떤 공급자의 키가 실제로 존재하는지. 값은 반환하지 않는다.
pub fn available_providers() -> Vec<String> {
    PROVIDER_ENV_VARS
        .iter()
        .filter(|(_, env)| std::env::var(env).map(|v| !v.trim().is_empty()).unwrap_or(false))
        .map(|(id, _)| (*id).to_string())
        .collect()
}

/// sidecar에 주입할 자격증명 환경변수 쌍. 존재하는 것만 담는다.
pub fn credential_env() -> Vec<(String, String)> {
    PROVIDER_ENV_VARS
        .iter()
        .filter_map(|(_, env)| {
            std::env::var(env)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|v| ((*env).to_string(), v))
        })
        .collect()
}
