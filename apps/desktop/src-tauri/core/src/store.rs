//! SQLite 저장 계층.
//!
//! docs/design/state-machine-and-protocol.md 7절 스키마. 핵심 불변식(CLAUDE.md 원칙 7):
//!
//!   `task_events`는 append-only 진실의 원천이고 `tasks.phase`/`counters_json`은 **매 이벤트
//!   삽입과 같은 트랜잭션 안에서** 갱신되는 파생 캐시다.
//!
//! 그래서 이 모듈은 "phase만 바꾸는" 공개 API를 제공하지 않는다 — `append_event`가 phase 갱신의
//! 유일한 경로다. 이벤트 없이 상태를 바꾸는 것이 타입/API 수준에서 불가능해야 한다.
//!
//! Rust가 유일한 writer다(process-architecture.md 2절) — WAL 락 경합을 최소화하고,
//! Node가 감사 로그를 우회해 기록하는 경로를 없앤다.

use crate::artifacts::{ArtifactStore, INLINE_PAYLOAD_LIMIT_BYTES};
use crate::time::now_iso;
use crate::types::{FileMutationRecord, PolicyDecision, ToolRequest, ToolResult, VerificationReport};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::Path;

/// 스키마 버전. 마이그레이션을 추가할 때마다 올리고 `migrate()`에 단계별 DDL을 넣는다.
///
/// v2(M0.1): 작업 영속화에 필요한 컬럼·테이블 추가. **기존 v1 DB를 파괴하지 않고 올라가야 하므로
/// 전부 additive(ALTER TABLE ADD COLUMN / CREATE TABLE)다.** 사용자의 이벤트 로그를 마이그레이션
/// 과정에서 잃는 것은 "append-only 진실의 원천"이라는 약속을 깨는 것이다.
///
/// v3(M1): `acceptance_criteria` — 사용자 판정의 파생 캐시(문서 17.3절). 역시 additive다.
///
/// v8(M3): `acceptance_criteria.withdrawn_at` — 판정을 **거둔 시각**(문서 30절). 컬럼 추가라 additive다.
pub const SCHEMA_VERSION: i64 = 8;

pub struct Store {
    conn: Connection,
    artifacts: ArtifactStore,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendedEvent {
    pub event_id: i64,
    pub seq: i64,
}

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub event_id: i64,
    pub seq: i64,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: String,
    /// 이 이벤트가 발생한 시점의 phase. 나중에 로그만 보고 흐름을 재구성할 때 필요하다.
    pub phase: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("artifact io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invariant(String),
    /// 이미 터미널 상태인 태스크에 다른 터미널 상태를 쓰려 했다.
    ///
    /// 오류로 만든 이유: 조용히 무시하면 호출자가 "내가 기록한 terminal이 반영됐다"고 착각한다.
    /// 완료와 취소가 경쟁할 때 **먼저 확정된 쪽만 남아야** 하고, 진 쪽은 그 사실을 알아야 한다.
    #[error("이미 터미널 상태입니다: {status}")]
    TerminalAlreadySet { status: String },
    /// 형식이 틀린 목록 커서.
    ///
    /// 오류로 만든 이유: "처음부터"로 되읽으면 "더 보기"가 **첫 페이지를 다시 붙인다.**
    /// 사용자에게 그건 오류가 아니라 "작업이 늘어났다"로 읽히고, 목록은 조용히 거짓말을 한다.
    #[error("커서 형식이 올바르지 않습니다: {0}")]
    InvalidCursor(String),
}

/// 저장 계층 실패 중 **화면에 그대로 뜨는 것**.
///
/// # 왜 `StoreError`와 따로 있나
///
/// `StoreError`는 **무엇이 잘못됐는가**(sqlite 오류, io 오류)이고, 이건 **사용자가 무엇을
/// 하려다 실패했는가**다. 화면이 알아야 하는 것은 후자다 — "sqlite: database is locked"만
/// 보여주면 사용자는 할 수 있는 일이 없고, "작업 목록을 읽을 수 없습니다"만 보여주면 원인이
/// 사라진다. 둘을 코드와 파라미터로 나눠 담는다.
///
/// # 왜 core에 있나
///
/// 종전에는 이 문장들이 Tauri 껍데기 크레이트에 `format!`으로 흩어져 있었다. 그 크레이트는
/// 개발 환경에서 **컴파일되지 않으므로** 거기 있는 문장은 검증되지 않고, 무엇보다 화면으로
/// 나가는 문장이므로 카탈로그 밖에 남으면 안 된다(ui-wireframes.md 6절).
///
/// # 여기 있는 것이 전부가 아니다
///
/// **화면에 봉투로 나가는 것만 코드를 갖는다.** 아직 산문으로 나가는 저장 계층 실패
/// (허용 목록 저장, 실행 경로의 태스크 생성 등)에는 코드를 만들지 않는다 — 카탈로그에 있지만
/// 실제로는 도착하지 않는 항목이 생기면, "카탈로그가 코드를 안다"는 검사가 **번역됐다는 뜻이
/// 아니게** 된다. 그 자리들은 `SessionState::with_store_prose`를 쓴다: **고르는 것이 눈에
/// 보이는 자리**여야 빠뜨린 것과 구별된다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreOp {
    /// artifact 저장소를 만들 수 없었다.
    OpenArtifacts,
    /// 로컬 DB를 열 수 없었다.
    OpenDatabase,
    /// 비정상 종료된 작업을 INTERRUPTED로 확정하지 못했다.
    RecoverInterrupted,
    /// 작업 목록을 읽지 못했다.
    ReadTasks,
    /// 작업 하나를 읽지 못했다.
    ReadTask,
    /// 작업의 이벤트 타임라인을 읽지 못했다.
    ReadTaskEvents,
    /// 화면이 쓰는 문턱(강제 포기 시점 등)을 집계하지 못했다.
    ReadThresholds,
    /// 전송 내역을 모으지 못했다.
    ReadTransmission,
    /// 감사 export를 만들지 못했다.
    ReadExport,
    /// 무인 정지의 처방을 모으지 못했다 (state-machine 24.8절).
    ReadBlocked,
    /// 앞선 태스크에서 사용자가 정한 것을 읽지 못했다 (state-machine 27절).
    ReadSessionMemory,
    /// 세션의 사용자 판정 목록을 읽지 못했다 (state-machine 30절).
    ReadDecisions,
}

impl StoreOp {
    /// 테스트가 훑는 목록.
    ///
    /// **모든 variant가 코드를 갖는다는 보장은 이 목록이 아니라 컴파일러가 준다** —
    /// `code()`/`korean()`의 `match`가 exhaustive라 variant를 추가하면 컴파일이 깨진다.
    /// 이 목록은 "코드가 서로 다른가"를 확인하기 위해 훑을 대상일 뿐이다.
    pub const ALL: &'static [StoreOp] = &[
        StoreOp::OpenArtifacts,
        StoreOp::OpenDatabase,
        StoreOp::RecoverInterrupted,
        StoreOp::ReadTasks,
        StoreOp::ReadTask,
        StoreOp::ReadTaskEvents,
        StoreOp::ReadThresholds,
        StoreOp::ReadTransmission,
        StoreOp::ReadExport,
        StoreOp::ReadBlocked,
        StoreOp::ReadSessionMemory,
        StoreOp::ReadDecisions,
    ];
}

/// 어떤 조작이 어떤 이유로 실패했는가.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreIssue {
    pub op: StoreOp,
    /// 원인. **문장에 이어 붙이는 대신 파라미터로 간다.**
    pub detail: String,
}

impl StoreIssue {
    pub fn new(op: StoreOp, detail: impl std::fmt::Display) -> Self {
        Self {
            op,
            detail: detail.to_string(),
        }
    }
}

impl crate::uimsg::UserFacing for StoreIssue {
    fn code(&self) -> &'static str {
        match self.op {
            StoreOp::OpenArtifacts => "storeOpenArtifacts",
            StoreOp::OpenDatabase => "storeOpenDatabase",
            StoreOp::RecoverInterrupted => "storeRecoverInterrupted",
            StoreOp::ReadTasks => "storeReadTasks",
            StoreOp::ReadTask => "storeReadTask",
            StoreOp::ReadTaskEvents => "storeReadTaskEvents",
            StoreOp::ReadThresholds => "storeReadThresholds",
            StoreOp::ReadTransmission => "storeReadTransmission",
            StoreOp::ReadExport => "storeReadExport",
            StoreOp::ReadBlocked => "storeReadBlocked",
            StoreOp::ReadSessionMemory => "storeReadSessionMemory",
            StoreOp::ReadDecisions => "storeReadDecisions",
        }
    }

    fn params(&self) -> serde_json::Value {
        serde_json::json!({ "detail": self.detail })
    }

    fn korean(&self) -> String {
        let what = match self.op {
            StoreOp::OpenArtifacts => "artifact 저장소를 만들 수 없습니다",
            StoreOp::OpenDatabase => "로컬 DB를 열 수 없습니다",
            StoreOp::RecoverInterrupted => "중단된 작업을 정리할 수 없습니다",
            StoreOp::ReadTasks => "작업 목록을 읽을 수 없습니다",
            StoreOp::ReadTask => "작업을 읽을 수 없습니다",
            StoreOp::ReadTaskEvents => "작업의 이벤트를 읽을 수 없습니다",
            StoreOp::ReadThresholds => "화면이 쓰는 문턱을 집계할 수 없습니다",
            StoreOp::ReadTransmission => "전송 내역을 읽을 수 없습니다",
            StoreOp::ReadExport => "감사 기록을 만들 수 없습니다",
            StoreOp::ReadBlocked => "무인 정지의 처방을 읽을 수 없습니다",
            StoreOp::ReadSessionMemory => "앞선 태스크에서 정한 것을 읽을 수 없습니다",
            StoreOp::ReadDecisions => "이 세션에서 정한 것의 목록을 읽을 수 없습니다",
        };
        format!("{what}: {}", self.detail)
    }
}

/// 터미널 상태로 확정하려는 시도의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalOutcome {
    /// 이번 호출이 터미널 상태를 확정했다.
    Recorded { status: String, event: AppendedEvent },
    /// 이미 다른 터미널 상태였다 — 아무것도 바꾸지 않았다.
    AlreadyTerminal { status: String },
}

/// `tasks` 행의 조회 결과 (UI 목록/상세용).
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskRow {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "workspacePath")]
    pub workspace_path: Option<String>,
    pub mode: Option<String>,
    #[serde(rename = "userMessage")]
    pub user_message: String,
    #[serde(rename = "currentPhase")]
    pub current_phase: String,
    #[serde(rename = "terminalStatus")]
    pub terminal_status: Option<String>,
    #[serde(rename = "errorSummary")]
    pub error_summary: Option<String>,
    #[serde(rename = "cancellationRequestedAt")]
    pub cancellation_requested_at: Option<String>,
    #[serde(rename = "mutationCount")]
    pub mutation_count: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// `acceptance_criteria` 한 줄. 프로토콜의 `AcceptanceCriterion`의 Rust 쪽 미러다.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AcceptanceCriterionRow {
    #[serde(rename = "criterionId")]
    pub criterion_id: String,
    pub text: String,
    pub source: String,
    #[serde(rename = "disagreementId", skip_serializing_if = "Option::is_none")]
    pub disagreement_id: Option<String>,
    #[serde(rename = "decidedAt")]
    pub decided_at: String,
    /// 이 판정을 사용자가 거둔 시각 (30절). **행은 남는다** — 그 태스크가 무엇을 기준으로
    /// 판정됐는지는 소급해서 바뀌지 않고, 여기 더해지는 것은 "이후 거뒀다"는 나중의 사실이다.
    #[serde(rename = "withdrawnAt", skip_serializing_if = "Option::is_none")]
    pub withdrawn_at: Option<String>,
}

/// 다음 태스크로 나를 판정 하나 (`session_user_decisions`).
#[derive(Debug, Clone, PartialEq)]
pub struct CarriedDecisionRow {
    pub task_id: String,
    pub criterion_id: String,
    pub text: String,
    pub decided_at: String,
}

/// 사용자에게 보여줄 세션 판정 하나 — 철회된 것도 포함한다 (`session_decision_rows`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionDecisionRow {
    pub task_id: String,
    pub criterion_id: String,
    pub text: String,
    pub decided_at: String,
    pub withdrawn_at: Option<String>,
    pub task_final_status: Option<String>,
}

type Result<T> = std::result::Result<T, StoreError>;

impl Store {
    pub fn open(db_path: impl AsRef<Path>, artifacts: ArtifactStore) -> Result<Self> {
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        Self::init(conn, artifacts)
    }

    pub fn open_in_memory(artifacts: ArtifactStore) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, artifacts)
    }

    fn init(conn: Connection, artifacts: ArtifactStore) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        // 크래시 시 마지막 몇 이벤트를 잃는 것보다 매 이벤트 fsync 비용이 더 아프다는 판단은
        // 하지 않았다 — 감사 로그가 진실의 원천이므로 기본 동기화 수준을 유지한다.
        let mut store = Self { conn, artifacts };
        store.migrate()?;
        Ok(store)
    }

    pub fn artifacts(&self) -> &ArtifactStore {
        &self.artifacts
    }

    fn migrate(&mut self) -> Result<()> {
        let current: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current >= SCHEMA_VERSION {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        if current < 1 {
            tx.execute_batch(SCHEMA_V1)?;
        }
        if current < 2 {
            tx.execute_batch(SCHEMA_V2)?;
        }
        if current < 3 {
            tx.execute_batch(SCHEMA_V3)?;
        }
        if current < 4 {
            tx.execute_batch(SCHEMA_V4)?;
        }
        if current < 5 {
            tx.execute_batch(SCHEMA_V5)?;
        }
        if current < 6 {
            tx.execute_batch(SCHEMA_V6)?;
        }
        if current < 7 {
            tx.execute_batch(SCHEMA_V7)?;
        }
        if current < 8 {
            tx.execute_batch(SCHEMA_V8)?;
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    // ---- workspace / session / task ----

    pub fn upsert_workspace(&self, workspace_id: &str, root_path: &str, name: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO workspaces (workspace_id, root_path, name, policy_json, created_at)
             VALUES (?1, ?2, ?3, '{}', ?4)
             ON CONFLICT(workspace_id) DO UPDATE SET root_path = ?2, name = ?3",
            params![workspace_id, root_path, name, now_iso()],
        )?;
        Ok(())
    }

    /// 이 워크스페이스에서 쓸 수 있는 공급자 목록을 정한다 (multi-engine-routing.md 16절).
    ///
    /// `None`은 제한 없음, `Some(&[])`는 아무것도 허용하지 않음이다 — **다른 사실이므로 다른
    /// 값으로 저장한다.**
    pub fn set_allowed_providers(&self, workspace_id: &str, allowed: Option<&[String]>) -> Result<()> {
        let json = match allowed {
            Some(list) => Some(serde_json::to_string(list)?),
            None => None,
        };
        self.conn.execute(
            "UPDATE workspaces SET allowed_providers = ?2 WHERE workspace_id = ?1",
            params![workspace_id, json],
        )?;
        Ok(())
    }

    /// 저장된 허용 목록. `None`이면 제한이 없다.
    ///
    /// **깨진 JSON을 "제한 없음"으로 읽지 않는다.** 그러면 저장이 망가진 순간 제한이
    /// 조용히 사라지고, 사용자는 자기가 건 제한이 걸려 있다고 믿는다. 읽지 못하면
    /// 오류를 올려 호출자가 멈추게 한다.
    pub fn allowed_providers(&self, workspace_id: &str) -> Result<Option<Vec<String>>> {
        let raw: Option<String> = self.conn.query_row(
            "SELECT allowed_providers FROM workspaces WHERE workspace_id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )?;
        match raw {
            None => Ok(None),
            Some(text) => Ok(Some(serde_json::from_str::<Vec<String>>(&text)?)),
        }
    }

    pub fn upsert_session(&self, session_id: &str, workspace_id: &str, title: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (session_id, workspace_id, title, started_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO NOTHING",
            params![session_id, workspace_id, title, now_iso()],
        )?;
        Ok(())
    }

    /// 태스크 생성 + `TASK_CREATED` 이벤트를 한 트랜잭션에 기록한다.
    /// 이벤트 없이 태스크 행만 생기는 상태를 만들지 않기 위해 두 동작을 분리하지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &mut self,
        task_id: &str,
        session_id: &str,
        workspace_id: &str,
        workspace_path: &str,
        mode: &str,
        user_message: &str,
    ) -> Result<AppendedEvent> {
        let now = now_iso();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO tasks (task_id, session_id, workspace_id, workspace_path, mode, user_message,
                                phase, counters_json, final_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'CREATED', ?7, NULL, ?8, ?8)",
            params![
                task_id,
                session_id,
                workspace_id,
                workspace_path,
                mode,
                user_message,
                serde_json::to_string(&crate::types::TaskCounters::default())?,
                now
            ],
        )?;
        let appended = append_event_tx(
            &tx,
            &self.artifacts,
            task_id,
            "TASK_CREATED",
            // userMessage는 사용자가 직접 쓴 것이므로 secret이 들어갈 수 있다는 걱정이 있으나,
            // 이미 tasks.user_message에 저장되어야 하는 값이고(작업 목록 표시에 필요) 파일 내용이나
            // 환경변수처럼 우리가 수집한 것이 아니다. 길이만 제한한다.
            &serde_json::json!({ "userMessage": truncate_for_event(user_message, 2_000) }),
        )?;
        tx.commit()?;
        Ok(appended)
    }

    /// append-only 이벤트 기록. `PHASE_CHANGED`면 같은 트랜잭션에서 `tasks.phase`를 갱신한다.
    ///
    /// 이게 상태 변경의 유일한 경로다 — 이벤트를 남기지 않고 phase를 바꾸는 API는 없다.
    pub fn append_event(
        &mut self,
        task_id: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<AppendedEvent> {
        let tx = self.conn.transaction()?;

        // PHASE_CHANGED가 터미널을 향하면 **먼저** 원자적으로 자리를 잡는다.
        // 이벤트를 먼저 쓰고 나중에 상태를 갱신하면, 경쟁에서 진 쪽의 이벤트가 로그에 남아
        // "COMPLETED 다음에 CANCELLED"처럼 모순된 기록이 만들어진다.
        let mut phase_override: Option<&str> = None;
        if event_type == "PHASE_CHANGED" {
            let to = payload
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or_else(|| StoreError::Invariant("PHASE_CHANGED payload에 \"to\"가 없음".to_string()))?;
            phase_override = Some(to);

            if is_terminal_phase(to) {
                let changed = tx.execute(
                    "UPDATE tasks SET final_status = ?1, phase = ?1, updated_at = ?2
                     WHERE task_id = ?3 AND final_status IS NULL",
                    params![to, now_iso(), task_id],
                )?;
                if changed == 0 {
                    // 이미 다른 터미널 상태다. 트랜잭션을 롤백하고 호출자에게 알린다.
                    let existing: Option<String> = tx
                        .query_row(
                            "SELECT final_status FROM tasks WHERE task_id = ?1",
                            params![task_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .flatten();
                    drop(tx);
                    return Err(StoreError::TerminalAlreadySet {
                        status: existing.unwrap_or_else(|| "unknown".to_string()),
                    });
                }
            } else {
                // 비터미널 전이는 터미널에 도달한 뒤에는 허용하지 않는다 —
                // 터미널 상태에서 다시 진행 중으로 되돌아가는 전이는 없다.
                let changed = tx.execute(
                    "UPDATE tasks SET phase = ?1, updated_at = ?2
                     WHERE task_id = ?3 AND final_status IS NULL",
                    params![to, now_iso(), task_id],
                )?;
                if changed == 0 {
                    let existing: Option<String> = tx
                        .query_row(
                            "SELECT final_status FROM tasks WHERE task_id = ?1",
                            params![task_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .flatten();
                    if let Some(status) = existing {
                        drop(tx);
                        return Err(StoreError::TerminalAlreadySet { status });
                    }
                }
            }
        }

        let appended = append_event_tx_with_phase(&tx, &self.artifacts, task_id, event_type, payload, phase_override)?;

        if let Some(counters) = payload.get("counters") {
            tx.execute(
                "UPDATE tasks SET counters_json = ?1, updated_at = ?2 WHERE task_id = ?3",
                params![serde_json::to_string(counters)?, now_iso(), task_id],
            )?;
        }

        // 사용자 판정의 파생 캐시. `counters`와 같은 규칙으로, **이벤트를 쓰는 같은 트랜잭션
        // 안에서만** 갱신된다 — 이벤트 없이 기준이 생기는 경로를 만들지 않기 위해서다(원칙 7).
        sync_acceptance_criteria_tx(&tx, task_id, payload)?;

        tx.commit()?;
        Ok(appended)
    }

    pub fn task_phase(&self, task_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT phase FROM tasks WHERE task_id = ?1", params![task_id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?)
    }

    pub fn task_final_status(&self, task_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT final_status FROM tasks WHERE task_id = ?1",
                params![task_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn events(&self, task_id: &str) -> Result<Vec<StoredEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT event_id, seq, event_type, payload_json, created_at, phase
             FROM task_events WHERE task_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(StoredEvent {
                event_id: r.get(0)?,
                seq: r.get(1)?,
                event_type: r.get(2)?,
                payload: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(serde_json::Value::Null),
                created_at: r.get(4)?,
                phase: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn event_types(&self, task_id: &str) -> Result<Vec<String>> {
        Ok(self.events(task_id)?.into_iter().map(|e| e.event_type).collect())
    }

    // ---- tool requests / results ----

    pub fn record_tool_request(&self, request: &ToolRequest, plan_id: &str, decision: &PolicyDecision) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tool_requests (request_id, task_id, plan_id, tool, args_json, risk_tier,
                                        requested_by, policy_decision, policy_reason, approval_status,
                                        execution_status, started_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                     CASE WHEN ?8 = 'require_user_approval' THEN 'pending' ELSE 'not_required' END,
                     'started', ?10, ?10)
             ON CONFLICT(request_id) DO NOTHING",
            params![
                request.request_id,
                request.task_id,
                plan_id,
                request.tool.as_str(),
                serde_json::to_string(&request.args)?,
                serde_json::to_string(&decision.risk_level)?.trim_matches('"'),
                serde_json::to_string(&request.requested_by)?,
                serde_json::to_string(&decision.decision)?.trim_matches('"'),
                decision.reason,
                request.created_at.clone().unwrap_or_else(now_iso),
            ],
        )?;
        Ok(())
    }

    pub fn record_tool_result(&self, result: &ToolResult, output_ref: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tool_results (request_id, status, output_ref, error, duration_ms, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(request_id) DO UPDATE SET
               status = ?2, output_ref = ?3, error = ?4, duration_ms = ?5, completed_at = ?6",
            params![
                result.request_id,
                serde_json::to_string(&result.status)?.trim_matches('"'),
                output_ref,
                result.error,
                result.duration_ms as i64,
                result.completed_at,
            ],
        )?;
        Ok(())
    }

    // ---- file mutations (롤백) ----

    pub fn record_file_mutation(&self, record: &FileMutationRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO file_mutations (request_id, task_id, path, pre_existed, pre_content_ref, pre_sha256,
                                         post_existed, post_content_ref, post_sha256, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(request_id, path) DO UPDATE SET
               post_existed = ?7, post_content_ref = ?8, post_sha256 = ?9",
            params![
                record.request_id,
                record.task_id,
                record.path,
                record.pre_image.existed as i32,
                record.pre_image.content_ref,
                record.pre_image.sha256,
                record.post_image.existed as i32,
                record.post_image.content_ref,
                record.post_image.sha256,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    /// 롤백용: 이 태스크가 건드린 파일별 **최초** pre-image.
    ///
    /// 같은 파일을 여러 번 고쳤을 수 있으므로 가장 이른 기록을 쓴다 — 마지막 pre-image로
    /// 되돌리면 태스크 중간 상태로 되돌아가고, 그건 "이 태스크를 없앤 것"이 아니다.
    pub fn rollback_targets(&self, task_id: &str) -> Result<Vec<FileMutationRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT request_id, path, pre_existed, pre_content_ref, pre_sha256,
                    post_existed, post_content_ref, post_sha256
             FROM file_mutations fm
             WHERE task_id = ?1
               AND rowid = (SELECT MIN(rowid) FROM file_mutations WHERE task_id = ?1 AND path = fm.path)
             ORDER BY path ASC",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(FileMutationRecord {
                request_id: r.get(0)?,
                task_id: task_id.to_string(),
                path: r.get(1)?,
                pre_image: crate::types::ImageRef {
                    existed: r.get::<_, i32>(2)? != 0,
                    content_ref: r.get(3)?,
                    sha256: r.get(4)?,
                },
                post_image: crate::types::ImageRef {
                    existed: r.get::<_, i32>(5)? != 0,
                    content_ref: r.get(6)?,
                    sha256: r.get(7)?,
                },
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mutated_paths(&self, task_id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT path FROM file_mutations WHERE task_id = ?1 ORDER BY path ASC")?;
        let rows = stmt.query_map(params![task_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 이 태스크에 고정된 기준. **파생 캐시를 읽을 뿐이고, 여기서 만들어지지 않는다.**
    ///
    /// 정렬을 `source` 우선으로 하는 이유: 권위를 가진 것(`user_decision`)이 먼저 보여야
    /// 최종 보고 화면에서 사용자가 자기 판정을 먼저 읽는다. 알파벳 순으로 `draft_proposal`이
    /// 앞서므로 명시적으로 뒤집는다.
    /// 이 세션의 **다른** 태스크에서 사용자가 정한 것들 — 최신순 (session_memory.rs, 27절).
    ///
    /// **`source = 'user_decision'`으로 좁히는 것이 이 질의의 전부다.** 모델 제안까지 주면
    /// 부르는 쪽이 그것을 다시 걸러야 하고, 한 번 빠뜨리면 제안이 요구로 세탁된다(16.1절).
    /// 걸러야 할 것을 애초에 주지 않는다.
    pub fn session_user_decisions(
        &self,
        session_id: &str,
        exclude_task_id: &str,
    ) -> Result<Vec<CarriedDecisionRow>> {
        // **철회된 것은 여기서 사라진다.** 이 질의가 "다음 태스크로 나를 것"의 정의이고,
        // 철회의 효력은 정확히 그것뿐이다(30절) — 아래 `session_decision_rows`는 같은 행을
        // 여전히 돌려준다. 두 질의가 다른 답을 내는 것이 기능이다.
        let mut stmt = self.conn.prepare(
            "SELECT c.task_id, c.criterion_id, c.text, c.decided_at
             FROM acceptance_criteria c
             JOIN tasks t ON t.task_id = c.task_id
             WHERE t.session_id = ?1 AND c.task_id != ?2 AND c.source = 'user_decision'
               AND c.withdrawn_at IS NULL
             ORDER BY c.decided_at DESC, c.rowid DESC",
        )?;
        let rows = stmt.query_map(params![session_id, exclude_task_id], |r| {
            Ok(CarriedDecisionRow {
                task_id: r.get(0)?,
                criterion_id: r.get(1)?,
                text: r.get(2)?,
                decided_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 이 세션에서 사용자가 정한 것 **전부** — 철회된 것도 포함한다 (30절).
    ///
    /// 나를 것을 고르는 질의가 아니라 **사용자에게 보여줄 목록**이다. 철회한 것을 목록에서까지
    /// 지우면 사용자는 자기가 무엇을 거뒀는지 확인할 방법이 없고, 그러면 "사라졌다"와
    /// "거뒀다"가 화면에서 같은 모양이 된다.
    ///
    /// 소유 태스크가 아직 끝나지 않았는지도 함께 낸다 — 철회할 수 있는지를 정하는 사실이다.
    pub fn session_decision_rows(&self, session_id: &str) -> Result<Vec<SessionDecisionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.task_id, c.criterion_id, c.text, c.decided_at, c.withdrawn_at, t.final_status
             FROM acceptance_criteria c
             JOIN tasks t ON t.task_id = c.task_id
             WHERE t.session_id = ?1 AND c.source = 'user_decision'
             ORDER BY c.decided_at DESC, c.rowid DESC",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(SessionDecisionRow {
                task_id: r.get(0)?,
                criterion_id: r.get(1)?,
                text: r.get(2)?,
                decided_at: r.get(3)?,
                withdrawn_at: r.get(4)?,
                task_final_status: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn acceptance_criteria(&self, task_id: &str) -> Result<Vec<AcceptanceCriterionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT criterion_id, text, source, disagreement_id, decided_at, withdrawn_at
             FROM acceptance_criteria WHERE task_id = ?1
             ORDER BY (source = 'user_decision') DESC, decided_at ASC, criterion_id ASC",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(AcceptanceCriterionRow {
                criterion_id: r.get(0)?,
                text: r.get(1)?,
                source: r.get(2)?,
                disagreement_id: r.get(3)?,
                decided_at: r.get(4)?,
                withdrawn_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- verification ----

    pub fn record_verification_report(&self, report: &VerificationReport) -> Result<()> {
        self.conn.execute(
            "INSERT INTO verification_reports (report_id, task_id, phase, attempt_number, overall,
                                               checks_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(report_id) DO NOTHING",
            params![
                report.report_id,
                report.task_id,
                serde_json::to_string(&report.phase)?.trim_matches('"'),
                report.attempt_number as i64,
                serde_json::to_string(&report.overall)?.trim_matches('"'),
                serde_json::to_string(&report.checks)?,
                report.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn verification_report_count(&self, task_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM verification_reports WHERE task_id = ?1",
            params![task_id],
            |r| r.get(0),
        )?)
    }

    // ---- provider usage (북극성 지표의 원천 데이터) ----

    /// API 키나 프롬프트 원문은 저장하지 않는다 — 토큰 수/비용/지연시간만 기록한다
    /// (작업 지침 4.4절: secret 원문을 DB나 로그에 남기지 않는다).
    pub fn record_provider_usage(&self, usage: &serde_json::Value) -> Result<()> {
        let get_str = |k: &str| usage.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        // 없는 값은 NULL이다 — 아래 INSERT 주석 참조.
        let opt_str = |k: &str| {
            usage
                .get(k)
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        };
        let get_u64 = |path: &[&str]| -> i64 {
            let mut cur = usage;
            for key in path {
                match cur.get(key) {
                    Some(next) => cur = next,
                    None => return 0,
                }
            }
            cur.as_i64().unwrap_or(0)
        };
        self.conn.execute(
            "INSERT INTO provider_usage (task_id, call_id, role, provider_id, model_id,
                                         input_tokens, output_tokens, cost_usd, latency_ms, attempt, created_at,
                                         requested_model_id, resolved_model_id, provider_request_id,
                                         estimated_input_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                get_str("taskId"),
                get_str("callId"),
                get_str("role"),
                get_str("providerId"),
                get_str("modelId"),
                get_u64(&["usage", "inputTokens"]),
                get_u64(&["usage", "outputTokens"]),
                usage.get("costUsd").and_then(|v| v.as_f64()),
                get_u64(&["latencyMs"]),
                get_u64(&["attempt"]),
                now_iso(),
                // **빈 문자열이 아니라 NULL로 둔다.** 빈 문자열은 "그런 모델 이름"이 되어
                // 집계에 섞이지만, NULL은 "모른다"로 남아 구별된다.
                opt_str("requestedModelId"),
                opt_str("resolvedModelId"),
                opt_str("providerRequestId"),
                // **없으면 NULL이다.** `get_u64`는 없는 값을 0으로 주므로 여기서는 쓰지 않는다 —
                // 0은 "추정이 0이었다"는 뜻이 되고, 그건 어떤 실제 값에 대해서도 무한대 배
                // 과소 추정으로 집계된다.
                usage.get("estimatedInputTokens").and_then(|v| v.as_i64()),
            ],
        )?;
        Ok(())
    }

    /// 공급자별 전송 집계 — product-strategy 7절 "데이터 전송 투명성".
    ///
    /// SQL로 묶는 이유: 호출 수가 태스크당 수십 개까지 갈 수 있고, 화면이 필요로 하는 것은
    /// 공급자별 합계 하나다. 행을 전부 올려 Rust에서 접는 것보다 여기서 접는 편이 싸고,
    /// **역할·모델 목록은 중복 없이 정렬해야** 화면 문구가 실행마다 흔들리지 않는다.
    pub fn provider_transmission(&self, task_id: &str) -> Result<Vec<crate::transmission::ProviderTransmission>> {
        let mut stmt = self.conn.prepare(
            "SELECT provider_id,
                    COUNT(*),
                    SUM(input_tokens),
                    SUM(output_tokens),
                    COALESCE(SUM(cost_usd), 0.0),
                    GROUP_CONCAT(DISTINCT role),
                    GROUP_CONCAT(DISTINCT model_id),
                    GROUP_CONCAT(DISTINCT resolved_model_id),
                    GROUP_CONCAT(DISTINCT provider_request_id),
                    -- **둘 다 아는 행에서만** 대체를 센다. 한쪽이 NULL이면 모르는 것이고,
                    -- 모름을 대체로 보고하면 진짜 대체가 그 안에 묻힌다.
                    SUM(CASE WHEN resolved_model_id IS NOT NULL
                              AND requested_model_id IS NOT NULL
                              AND resolved_model_id <> requested_model_id
                             THEN 1 ELSE 0 END)
             FROM provider_usage
             WHERE task_id = ?1
             GROUP BY provider_id
             ORDER BY provider_id",
        )?;
        let rows = stmt.query_map(params![task_id], |row| {
            let split = |v: Option<String>| {
                let mut items: Vec<String> = v
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                items.sort();
                items.dedup();
                items
            };
            Ok(crate::transmission::ProviderTransmission {
                provider_id: row.get(0)?,
                calls: row.get::<_, i64>(1)? as u64,
                input_tokens: row.get::<_, i64>(2)? as u64,
                output_tokens: row.get::<_, i64>(3)? as u64,
                cost_usd: row.get(4)?,
                roles: split(row.get(5)?),
                models: split(row.get(6)?),
                resolved_models: split(row.get(7)?),
                provider_request_ids: split(row.get(8)?),
                substituted: row.get::<_, i64>(9)? > 0,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn provider_usage_count(&self, task_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM provider_usage WHERE task_id = ?1",
            params![task_id],
            |r| r.get(0),
        )?)
    }

    // ---- 원자적 결합 기록 (M0.1 트랜잭션 규칙) ----
    //
    // 각 메서드가 "레코드 + 대응 이벤트"를 하나의 트랜잭션에 쓴다. 두 번의 호출로 나누면
    // 그 사이에 프로세스가 죽었을 때 레코드는 있고 이벤트는 없는(또는 반대) 상태가 남고,
    // 그러면 이벤트 로그만으로 상태를 설명할 수 없게 된다.

    /// 도구 실행 결과 + `TOOL_COMPLETED` 이벤트.
    pub fn record_tool_result_with_event(
        &mut self,
        result: &ToolResult,
        output_ref: Option<&str>,
        task_id: &str,
        event_payload: &serde_json::Value,
    ) -> Result<AppendedEvent> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO tool_results (request_id, status, output_ref, error, duration_ms, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(request_id) DO UPDATE SET
               status = ?2, output_ref = ?3, error = ?4, duration_ms = ?5, completed_at = ?6",
            params![
                result.request_id,
                result.status.as_str(),
                output_ref,
                result.error,
                result.duration_ms as i64,
                result.completed_at,
            ],
        )?;
        // tool_executions 뷰가 실행 상태를 읽는 곳이므로 요청 행에도 반영한다.
        tx.execute(
            "UPDATE tool_requests SET execution_status = ?1 WHERE request_id = ?2",
            params![result.status.as_str(), result.request_id],
        )?;
        let appended = append_event_tx(&tx, &self.artifacts, task_id, "TOOL_COMPLETED", event_payload)?;
        tx.commit()?;
        Ok(appended)
    }

    /// 파일 변경 기록 + `FILE_MUTATED` 이벤트.
    pub fn record_file_mutation_with_event(
        &mut self,
        record: &FileMutationRecord,
        event_payload: &serde_json::Value,
    ) -> Result<AppendedEvent> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO file_mutations (mutation_id, request_id, task_id, path, pre_existed, pre_content_ref,
                                         pre_sha256, post_existed, post_content_ref, post_sha256,
                                         rollback_status, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'applied', ?11)
             ON CONFLICT(request_id, path) DO UPDATE SET
               post_existed = ?8, post_content_ref = ?9, post_sha256 = ?10",
            params![
                format!("mut-{}", uuid::Uuid::new_v4()),
                record.request_id,
                record.task_id,
                record.path,
                record.pre_image.existed as i32,
                record.pre_image.content_ref,
                record.pre_image.sha256,
                record.post_image.existed as i32,
                record.post_image.content_ref,
                record.post_image.sha256,
                now_iso(),
            ],
        )?;
        let appended = append_event_tx(&tx, &self.artifacts, &record.task_id, "FILE_MUTATED", event_payload)?;
        tx.commit()?;
        Ok(appended)
    }

    /// 검증 리포트 + 체크별 행 + `VERIFICATION_COMPLETED` 이벤트.
    pub fn record_verification_with_event(
        &mut self,
        report: &VerificationReport,
        event_payload: &serde_json::Value,
    ) -> Result<AppendedEvent> {
        let stage = serde_json::to_string(&report.phase)?.trim_matches('"').to_string();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO verification_reports (report_id, task_id, phase, attempt_number, overall,
                                               checks_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(report_id) DO NOTHING",
            params![
                report.report_id,
                report.task_id,
                stage,
                report.attempt_number as i64,
                serde_json::to_string(&report.overall)?.trim_matches('"'),
                serde_json::to_string(&report.checks)?,
                report.created_at,
            ],
        )?;
        // 체크별 행 — UI와 통계가 "어떤 검증이 어떤 상태였나"를 JSON 파싱 없이 조회할 수 있어야 한다.
        for check in &report.checks {
            tx.execute(
                "INSERT INTO verification_checks (report_id, task_id, stage, check_kind, status,
                                                  command_json, summary, exit_code, duration_ms, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    report.report_id,
                    report.task_id,
                    stage,
                    check.kind.as_str(),
                    serde_json::to_string(&check.status)?.trim_matches('"'),
                    // 명령은 argv 구조를 그대로 보존한다 — 나중에 "무엇이 실행됐나"를 재구성할 수 있어야 한다.
                    check
                        .command
                        .as_ref()
                        .map(|c| serde_json::to_string(c).unwrap_or_default()),
                    check.summary,
                    check.exit_code,
                    check.duration_ms.map(|d| d as i64),
                    report.created_at,
                ],
            )?;
        }
        let appended = append_event_tx(
            &tx,
            &self.artifacts,
            &report.task_id,
            "VERIFICATION_COMPLETED",
            event_payload,
        )?;
        tx.commit()?;
        Ok(appended)
    }

    /// 취소 요청 기록 + `CANCELLATION_REQUESTED` 이벤트.
    ///
    /// idempotent: 이미 기록되어 있으면 `None`을 반환하고 이벤트를 남기지 않는다.
    /// 터미널 상태면 `TerminalAlreadySet`을 반환한다 — 상태를 바꾸지 않는다.
    /// **payload도 함께 돌려준다.** 이 이벤트는 화면으로 릴레이되어야 하는데(append_event를
    /// 거치지 않으므로 자동으로 가지 않는다 — CLAUDE.md의 기록), 릴레이하는 쪽이 payload를
    /// 다시 조립하면 `requestedAt`이 저장된 값과 갈린다. 같은 사실을 두 번 만들지 않는다.
    pub fn record_cancellation_request(
        &mut self,
        task_id: &str,
        reason: &str,
    ) -> Result<Option<(AppendedEvent, serde_json::Value)>> {
        let tx = self.conn.transaction()?;
        let existing: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT final_status, cancellation_requested_at FROM tasks WHERE task_id = ?1",
                params![task_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let Some((final_status, already_requested)) = existing else {
            drop(tx);
            return Err(StoreError::Invariant(format!("알 수 없는 taskId: {task_id}")));
        };
        if let Some(status) = final_status {
            drop(tx);
            return Err(StoreError::TerminalAlreadySet { status });
        }
        if already_requested.is_some() {
            drop(tx);
            return Ok(None);
        }

        let now = now_iso();
        tx.execute(
            "UPDATE tasks SET cancellation_requested_at = ?1, updated_at = ?1 WHERE task_id = ?2",
            params![now, task_id],
        )?;
        let payload = serde_json::json!({ "requestedAt": now, "reason": reason });
        let appended = append_event_tx(&tx, &self.artifacts, task_id, "CANCELLATION_REQUESTED", &payload)?;
        tx.commit()?;
        Ok(Some((appended, payload)))
    }

    /// 터미널 상태 확정 + 해당 이벤트를 한 트랜잭션에.
    ///
    /// 완료와 취소가 경쟁할 때 **먼저 원자적으로 확정된 쪽만 남는다.** `WHERE final_status IS NULL`이
    /// 그 원자성의 실체다 — 두 스레드가 동시에 들어와도 UPDATE는 하나만 성공한다.
    pub fn finish_task(
        &mut self,
        task_id: &str,
        terminal_status: &str,
        event_type: &str,
        error_summary: Option<&str>,
        payload: &serde_json::Value,
    ) -> Result<TerminalOutcome> {
        if !is_terminal_phase(terminal_status) {
            return Err(StoreError::Invariant(format!(
                "{terminal_status}는 터미널 상태가 아닙니다"
            )));
        }
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE tasks SET final_status = ?1, phase = ?1, error_summary = ?2, updated_at = ?3
             WHERE task_id = ?4 AND final_status IS NULL",
            params![terminal_status, error_summary, now_iso(), task_id],
        )?;
        if changed == 0 {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT final_status FROM tasks WHERE task_id = ?1",
                    params![task_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            drop(tx);
            return Ok(TerminalOutcome::AlreadyTerminal {
                status: existing.unwrap_or_else(|| "unknown".to_string()),
            });
        }
        let event = append_event_tx_with_phase(
            &tx,
            &self.artifacts,
            task_id,
            event_type,
            payload,
            Some(terminal_status),
        )?;
        tx.commit()?;
        Ok(TerminalOutcome::Recorded {
            status: terminal_status.to_string(),
            event,
        })
    }

    /// 롤백 완료를 mutation 행에 표시한다.
    pub fn mark_mutation_rolled_back(&self, task_id: &str, path: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE file_mutations SET rollback_status = 'rolled_back', rolled_back_at = ?1
             WHERE task_id = ?2 AND path = ?3",
            params![now_iso(), task_id, path],
        )?;
        Ok(())
    }

    // ---- 조회 (UI가 Tauri command를 통해서만 접근한다) ----

    /// 집계용 전체 태스크 목록 (task_id, terminal_status).
    ///
    /// `list_tasks`를 쓰지 않는 이유: 그쪽은 **UI 목록용**이라 상한 200으로 잘린다(의도된
    /// 제한이다 — 화면이 전체 이력을 한 번에 끌어오지 못하게 한다). 집계에 그 상한이 걸리면
    /// 오래된 태스크가 조용히 빠지고, 그 사실이 결과 어디에도 나타나지 않는다. 지표는 표본이
    /// 잘렸다는 것을 모르는 순간 틀린 답을 자신 있게 말한다.
    pub fn all_tasks_for_metrics(&self, workspace_path: Option<&str>) -> Result<Vec<(String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, final_status FROM tasks
             WHERE (?1 IS NULL OR workspace_path = ?1)
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![workspace_path], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 목록 페이지 하나 (ui-wireframes.md 3.8절).
    ///
    /// # 커서는 `(created_at, task_id)` 쌍이다
    ///
    /// 시각 하나로 자르면 **같은 시각의 행이 통째로 사라진다.** 마지막 행의 시각으로
    /// `< cursor`를 하면 그 시각을 공유하는 다른 행도 함께 잘리기 때문이다. 목록에서 사라진
    /// 작업은 사용자에게 "없는 작업"이고, 그건 목록의 목적을 정면으로 어긴다.
    ///
    /// 그래서 정렬과 비교를 둘 다 같은 쌍으로 한다 — `task_id`가 유일하므로 쌍은 전순서가
    /// 되고, 어떤 행도 건너뛰거나 두 번 나오지 않는다.
    ///
    /// # 그 쌍이 `updated_at`이 아니라 `created_at`인 이유 (3.8.1절)
    ///
    /// **커서 페이징은 정렬 키가 움직이지 않을 때만 성립한다.** `updated_at`으로 정렬하면,
    /// 페이지 사이에 갱신된 작업이 커서 **위로** 올라가 아직 안 읽은 페이지에서 빠진다.
    /// 그 행은 어떤 페이지에도 나오지 않으므로 사용자에게는 존재하지 않는 작업이 된다.
    /// `created_at`은 생성 시각이라 production 경로 어디서도 UPDATE되지 않는다 — 키가
    /// 움직이지 않으면 스냅샷 없이도 페이징이 안정하다.
    ///
    /// 곁들여 **화면과도 맞는다.** 목록 행이 찍는 시각은 `createdAt`이었으므로, 정렬이
    /// `updated_at`이던 동안 화면은 13:40이 14:02 위에 오는 목록을 그릴 수 있었다.
    ///
    /// **커서 형식은 호출자에게 불투명하다.** 화면이 커서를 만들면 정렬 기준이 바뀔 때
    /// 화면과 질의가 조용히 갈라진다 — 실제로 그렇게 갈라져 있었다.
    pub fn list_tasks(&self, workspace_path: Option<&str>, limit: i64, cursor: Option<&str>) -> Result<Vec<TaskRow>> {
        let limit = limit.clamp(1, 200);
        let (cursor_created, cursor_id) = match cursor {
            Some(raw) => match raw.split_once('|') {
                Some((created, id)) => (Some(created.to_string()), Some(id.to_string())),
                // 형식이 틀린 커서를 "처음부터"로 읽지 않는다 — 그러면 "더 보기"가 첫 페이지를
                // 다시 붙여 목록이 반복되고, 사용자는 그걸 데이터가 늘어난 것으로 읽는다.
                None => return Err(StoreError::InvalidCursor(raw.to_string())),
            },
            None => (None, None),
        };
        let mut stmt = self.conn.prepare(
            "SELECT t.task_id, t.session_id, t.workspace_id, t.workspace_path, t.mode, t.user_message,
                    t.phase, t.final_status, t.error_summary, t.cancellation_requested_at,
                    (SELECT COUNT(DISTINCT path) FROM file_mutations m WHERE m.task_id = t.task_id),
                    t.created_at, t.updated_at
             FROM tasks t
             WHERE (?1 IS NULL OR t.workspace_path = ?1)
               AND (?2 IS NULL OR (t.created_at, t.task_id) < (?2, ?3))
             ORDER BY t.created_at DESC, t.task_id DESC
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![workspace_path, cursor_created, cursor_id, limit], map_task_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 이 행 다음 페이지를 가리키는 커서. **질의가 정렬에 쓰는 것과 같은 필드로 만든다.**
    pub fn cursor_for(row: &TaskRow) -> String {
        format!("{}|{}", row.created_at, row.task_id)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.task_id, t.session_id, t.workspace_id, t.workspace_path, t.mode, t.user_message,
                    t.phase, t.final_status, t.error_summary, t.cancellation_requested_at,
                    (SELECT COUNT(DISTINCT path) FROM file_mutations m WHERE m.task_id = t.task_id),
                    t.created_at, t.updated_at
             FROM tasks t WHERE t.task_id = ?1",
        )?;
        Ok(stmt.query_row(params![task_id], map_task_row).optional()?)
    }

    // ---- WorkspaceIndex 캐시 ----

    /// 이 워크스페이스의 캐시된 인덱스. **지문이 맞을 때만 준다.**
    ///
    /// 맞지 않으면 `None`이다 — 맞지 않는 인덱스를 주고 호출자가 판단하게 하면, 그 판단이
    /// 한 곳만 틀려도 **낡은 파일 목록으로 모델을 부르게** 된다. 그건 조용히 틀린 답을 만든다.
    pub fn cached_workspace_index(&self, workspace_id: &str, fingerprint: &str) -> Result<Option<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT payload_json, built_at, build_ms FROM workspace_index_cache
             WHERE workspace_id = ?1 AND fingerprint = ?2",
        )?;
        let row = stmt
            .query_row(params![workspace_id, fingerprint], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .optional()?;
        let Some((payload, built_at, build_ms)) = row else {
            return Ok(None);
        };
        // 저장된 것이 JSON이 아니면 **캐시가 없는 것으로 다룬다.** 캐시는 잃어도 되는 데이터이고,
        // 깨진 값으로 오류를 올리면 고칠 수 없는 파일 하나가 워크스페이스를 못 열게 만든다.
        let Ok(index) = serde_json::from_str::<serde_json::Value>(&payload) else {
            return Ok(None);
        };
        Ok(Some(serde_json::json!({
            "index": index,
            "builtAt": built_at,
            "buildMs": build_ms,
        })))
    }

    /// 인덱스를 캐시에 넣는다. 워크스페이스당 한 행이므로 **이전 것을 덮어쓴다.**
    pub fn save_workspace_index(
        &self,
        workspace_id: &str,
        fingerprint: &str,
        git_head: Option<&str>,
        index: &serde_json::Value,
        build_ms: Option<i64>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO workspace_index_cache (workspace_id, fingerprint, git_head, payload_json, built_at, build_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(workspace_id) DO UPDATE SET
               fingerprint = ?2, git_head = ?3, payload_json = ?4, built_at = ?5, build_ms = ?6",
            params![
                workspace_id,
                fingerprint,
                git_head,
                serde_json::to_string(index)?,
                now_iso(),
                build_ms
            ],
        )?;
        Ok(())
    }

    /// 증분 조회 — UI가 이미 받은 이벤트를 다시 받지 않도록 `after_event_id` 이후만 반환한다.
    pub fn events_after(&self, task_id: &str, after_event_id: Option<i64>) -> Result<Vec<StoredEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT event_id, seq, event_type, payload_json, created_at, phase
             FROM task_events
             WHERE task_id = ?1 AND (?2 IS NULL OR event_id > ?2)
             ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![task_id, after_event_id], |r| {
            Ok(StoredEvent {
                event_id: r.get(0)?,
                seq: r.get(1)?,
                event_type: r.get(2)?,
                payload: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(serde_json::Value::Null),
                created_at: r.get(4)?,
                phase: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 앱 시작 시 복구: 터미널이 아닌 태스크를 `INTERRUPTED`로 확정한다.
    ///
    /// **자동으로 재실행하지 않는다** (state-machine-and-protocol.md 7절): 부분 실행된
    /// `ToolRequest`의 재개는 멱등성 보장이 없으면 위험하다. 사용자에게 되돌리기/재실행 선택을 준다.
    pub fn mark_unfinished_as_interrupted(&mut self) -> Result<Vec<String>> {
        let pending = self.unfinished_tasks()?;
        let mut marked = Vec::new();
        for (task_id, phase) in pending {
            match self.finish_task(
                &task_id,
                "INTERRUPTED",
                "TASK_INTERRUPTED",
                Some("앱이 비정상 종료되어 작업이 중단되었습니다"),
                &serde_json::json!({
                    "interruptedAtPhase": phase,
                    "reason": "앱 재시작 시 진행 중이던 작업으로 발견됨",
                    "automaticResume": false,
                }),
            ) {
                Ok(TerminalOutcome::Recorded { .. }) => marked.push(task_id),
                // 경쟁으로 이미 확정됐으면 건너뛴다.
                Ok(TerminalOutcome::AlreadyTerminal { .. }) => {}
                Err(StoreError::TerminalAlreadySet { .. }) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(marked)
    }

    /// 도구 실행 내역 — `tool_executions` 뷰를 그대로 읽는다.
    ///
    /// 감사용이므로 `args_json`은 저장된 그대로(=sanitize된 상태) 나온다.
    /// 인자 sanitize는 기록 시점(`record_tool_request`)에 끝났고 여기서 다시 하지 않는다.
    pub fn tool_executions(&self, task_id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT request_id, tool_name, policy_decision, approval_status, execution_status,
                    requested_at, started_at, completed_at, duration_ms, error_summary,
                    output_artifact_path
             FROM tool_executions WHERE task_id = ?1 ORDER BY requested_at, request_id",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(serde_json::json!({
                "requestId": r.get::<_, String>(0)?,
                "tool": r.get::<_, String>(1)?,
                "policyDecision": r.get::<_, Option<String>>(2)?,
                "approvalStatus": r.get::<_, Option<String>>(3)?,
                "executionStatus": r.get::<_, Option<String>>(4)?,
                "requestedAt": r.get::<_, Option<String>>(5)?,
                "startedAt": r.get::<_, Option<String>>(6)?,
                "completedAt": r.get::<_, Option<String>>(7)?,
                "durationMs": r.get::<_, Option<i64>>(8)?,
                "error": r.get::<_, Option<String>>(9)?,
                // 본문이 아니라 **참조**다. 감사 export가 종료 코드 하나를 꺼내려면 이게 필요하고,
                // 본문을 export에 싣지 않겠다는 결정은 그대로 유지된다.
                "outputRef": r.get::<_, Option<String>>(10)?,
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 도구 요청 **원문** — `args_json`까지 포함한다.
    ///
    /// `tool_executions` 뷰가 args를 빼는 이유는 진단 화면이 그걸 필요로 하지 않기 때문이지만,
    /// **감사 export에는 반드시 있어야 한다.** 이 제품이 약속하는 것이 "승인 화면에 보인 argv가
    /// 실제 실행된 것과 같다"인데(원칙 6), argv가 빠진 기록으로는 그 약속을 사후에 확인할 수 없다.
    /// 그리고 재현의 재료도 이 args다.
    pub fn tool_requests_full(&self, task_id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT request_id, plan_id, tool, args_json, risk_tier, requested_by,
                    policy_decision, policy_reason, created_at
             FROM tool_requests WHERE task_id = ?1 ORDER BY created_at, request_id",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            let args: String = r.get(3)?;
            Ok(serde_json::json!({
                "requestId": r.get::<_, String>(0)?,
                "planId": r.get::<_, String>(1)?,
                "tool": r.get::<_, String>(2)?,
                // 파싱에 실패하면 원문 문자열로 남긴다 — 감사 기록에서 값을 버리지 않는다.
                "args": serde_json::from_str::<serde_json::Value>(&args)
                    .unwrap_or(serde_json::Value::String(args)),
                "riskTier": r.get::<_, String>(4)?,
                "requestedBy": r.get::<_, String>(5)?,
                "policyDecision": r.get::<_, String>(6)?,
                "policyReason": r.get::<_, String>(7)?,
                "createdAt": r.get::<_, String>(8)?,
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 공급자 호출 **한 건씩**. 집계(`provider_transmission`)와 달리 감사용 원본이다.
    pub fn provider_usage_rows(&self, task_id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT call_id, role, provider_id, model_id, requested_model_id, resolved_model_id,
                    provider_request_id, input_tokens, output_tokens, cost_usd, latency_ms, attempt, created_at,
                    estimated_input_tokens
             FROM provider_usage WHERE task_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(serde_json::json!({
                "callId": r.get::<_, String>(0)?,
                "role": r.get::<_, String>(1)?,
                "providerId": r.get::<_, String>(2)?,
                "modelId": r.get::<_, String>(3)?,
                "requestedModelId": r.get::<_, Option<String>>(4)?,
                // null은 "같았다"가 아니라 "기록하기 전이었다"다 (스키마 v4).
                "resolvedModelId": r.get::<_, Option<String>>(5)?,
                "providerRequestId": r.get::<_, Option<String>>(6)?,
                "inputTokens": r.get::<_, i64>(7)?,
                "outputTokens": r.get::<_, i64>(8)?,
                "costUsd": r.get::<_, Option<f64>>(9)?,
                "latencyMs": r.get::<_, i64>(10)?,
                "attempt": r.get::<_, i64>(11)?,
                "createdAt": r.get::<_, String>(12)?,
                // 우리가 보낸다고 생각했던 양. 실제와 나란히 있어야 감사에서 "예약이 왜
                // 실제와 어긋났나"에 답할 수 있다. null은 비교할 수 없었다는 뜻이다.
                "estimatedInputTokens": r.get::<_, Option<i64>>(13)?,
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 추정 입력 토큰과 **공급자가 보고한 실제**의 쌍 — 둘 다 아는 호출만.
    ///
    /// 한쪽이 NULL인 행을 빼는 이유: 비율을 만들려면 두 수가 다 있어야 하고, 없는 쪽을 0이나
    /// 추정값으로 채우면 그 순간 비율이 1이 되어 **"추정이 맞았다"는 결론이 데이터 없이 나온다.**
    /// 빠진 행이 몇 개인지는 호출자가 전체 개수와 비교해 알 수 있다.
    pub fn token_estimate_pairs(&self, task_id: &str) -> Result<(Vec<(i64, i64)>, u64)> {
        let mut stmt = self.conn.prepare(
            "SELECT estimated_input_tokens, input_tokens
             FROM provider_usage WHERE task_id = ?1",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut pairs = Vec::new();
        let mut without = 0u64;
        for row in rows {
            let (estimated, actual) = row?;
            match estimated {
                Some(e) if e > 0 => pairs.push((e, actual)),
                // NULL도 0도 "비교할 수 없다"는 같은 사실이다. 0을 분모로 쓰면 비율이 무한대가 된다.
                _ => without += 1,
            }
        }
        Ok((pairs, without))
    }

    /// 한 작업이 공급자 호출에 쓴 비용 — `(합계, 호출 수, 비용을 모르는 호출 수)`.
    ///
    /// **`cost_usd`가 NULL인 행을 0으로 더하지 않는다.** 0은 "공짜"라는 뜻이고, 모르는 것을
    /// 0으로 더하면 그 합계가 "썼는데 안 썼다"고 말한다. 그래서 개수로 따로 돌려주고,
    /// 그 수가 0이 아니면 합계는 **하한**이다.
    pub fn task_cost_usd(&self, task_id: &str) -> Result<(f64, u64, u64)> {
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(SUM(cost_usd), 0.0), COUNT(*),
                    SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)
             FROM provider_usage WHERE task_id = ?1",
        )?;
        let row = stmt.query_row(params![task_id], |r| {
            Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        Ok((row.0, row.1.max(0) as u64, row.2.max(0) as u64))
    }

    /// 검증 체크 행 — JSON을 파싱하지 않고 "무엇이 몇 번 실패했나"를 물을 수 있어야 한다.
    pub fn verification_checks(&self, task_id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT report_id, stage, check_kind, status, summary, exit_code, duration_ms, created_at
             FROM verification_checks WHERE task_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(serde_json::json!({
                "reportId": r.get::<_, String>(0)?,
                "stage": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "status": r.get::<_, String>(3)?,
                "summary": r.get::<_, String>(4)?,
                "exitCode": r.get::<_, Option<i64>>(5)?,
                "durationMs": r.get::<_, Option<i64>>(6)?,
                "createdAt": r.get::<_, String>(7)?,
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 파일 변경 내역 + 롤백 상태. 되돌릴 것이 남아 있는지 판단하는 근거다.
    /// 이 태스크가 바꾼 파일들. **내용 해시를 함께 준다.**
    ///
    /// 해시를 넣는 이유는 진단이 아니라 **재현의 판정**이다. 감사 export가 이걸 담아야
    /// 재현기가 "단계가 다 돌았다"가 아니라 **"기록과 같은 내용이 됐다"**를 말할 수 있다.
    /// 그게 없으면 재현은 확인할 수 없는 약속이 되고, product-strategy 6.3절이 "재현은
    /// 결정론적이고 보장 가능"이라고 적은 근거가 사라진다.
    ///
    /// 본문(`*_content_ref`)은 주지 않는다 — export는 밖으로 나가는 파일이고, 본문을 실으면
    /// artifact를 빼기로 한 결정이 무의미해진다. 해시는 판정에 충분하다.
    pub fn mutation_records(&self, task_id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, pre_existed, post_existed, rollback_status, rolled_back_at, recorded_at,
                    pre_sha256, post_sha256
             FROM file_mutations WHERE task_id = ?1 ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            let pre: i64 = r.get(1)?;
            let post: i64 = r.get(2)?;
            Ok(serde_json::json!({
                "path": r.get::<_, String>(0)?,
                // 되돌리기 UI는 "무엇을 되돌리는가"를 말해야 한다: 생성인지 수정인지 삭제인지.
                "operation": match (pre != 0, post != 0) {
                    (false, true) => "create",
                    (true, false) => "delete",
                    _ => "modify",
                },
                "rollbackStatus": r.get::<_, String>(3)?,
                "rolledBackAt": r.get::<_, Option<String>>(4)?,
                "recordedAt": r.get::<_, String>(5)?,
                // **존재 여부와 해시를 둘 다 준다.** 삭제된 파일은 "해시가 없다"가 아니라
                // "파일이 없다"이고, 둘을 해시 하나로 표현하면 구별되지 않는다.
                "preExisted": pre != 0,
                "postExisted": post != 0,
                "preSha256": r.get::<_, Option<String>>(6)?,
                "postSha256": r.get::<_, Option<String>>(7)?,
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 재시작 복구(7절): `final_status IS NULL`인 태스크를 찾는다.
    pub fn unfinished_tasks(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, phase FROM tasks WHERE final_status IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// 터미널 phase 판정. Rust와 TypeScript 양쪽에 같은 목록이 있으므로 한쪽만 고치면 갈라진다 —
/// `packages/protocol/src/task.ts`의 `TERMINAL_PHASES`와 짝이다.
///
/// **"함께 유지할 것"이라고만 적혀 있었고 검사가 없었다.** 그 부탁은 이미 한 번 어긋나 있었다:
/// 종전 주석은 목록이 `machine.ts`에 있다고 가리켰는데 거기 없다. 손으로 유지하는 포인터는
/// 손으로 유지하는 목록보다 먼저 낡는다. 이제 `packages/sidecar/test/terminalPhases.test.ts`가
/// 양쪽을 **소스에서 유도해** 대조한다(2.2절).
///
/// `INTERRUPTED`는 M0.1에서 추가됐다: 앱이 비정상 종료된 태스크는 완료도 실패도 취소도 아니고,
/// **사용자가 되돌릴지 재실행할지 결정해야 하는 상태**다. 다른 터미널로 뭉뚱그리면 그 구별이 사라진다.
pub fn is_terminal_phase(phase: &str) -> bool {
    matches!(
        phase,
        "COMPLETED" | "FAILED" | "CANCELLED" | "REJECTED" | "INTERRUPTED" | "ANSWERED"
    )
}

fn map_task_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        task_id: r.get(0)?,
        session_id: r.get(1)?,
        workspace_id: r.get(2)?,
        workspace_path: r.get(3)?,
        mode: r.get(4)?,
        user_message: r.get(5)?,
        current_phase: r.get(6)?,
        terminal_status: r.get(7)?,
        error_summary: r.get(8)?,
        cancellation_requested_at: r.get(9)?,
        mutation_count: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

/// 이벤트 payload에 들어가는 사용자 문자열의 길이 상한.
fn truncate_for_event(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…(truncated)", &text[..end])
}

/// 이벤트 payload가 실어온 `acceptanceCriteria`를 파생 캐시에 반영한다.
///
/// **payload에 그 키가 없으면 아무것도 하지 않는다** — 대부분의 이벤트가 그렇다.
///
/// `acceptanceCriteriaReplaces`가 있으면 그 source의 기존 행을 먼저 지운다. 재질문 왕복 뒤
/// 새 초안이 오면 이전 초안의 `doneCriteria`는 **철회된 해석**이고, 그대로 쌓아두면 최종 보고가
/// 아무도 지지하지 않는 기준을 사용자에게 보여준다. 캐시를 지우는 것은 append-only 규칙과
/// 충돌하지 않는다 — 지워지는 것은 파생 캐시이고 대체 사실 자체는 이벤트로 남는다.
///
/// 형태가 잘못된 항목은 조용히 건너뛰지 않고 오류로 만든다. 감사 기록의 캐시가 조용히
/// 비는 것은 "기준이 없었다"와 구별되지 않기 때문이다.
fn sync_acceptance_criteria_tx(
    tx: &Transaction<'_>,
    task_id: &str,
    payload: &serde_json::Value,
) -> std::result::Result<(), StoreError> {
    // **철회도 이 한 곳을 지난다** (30절). 파생 캐시를 바꾸는 경로를 늘리지 않기 위해서다 —
    // "이벤트 없이 기준이 생기거나 사라지는 길은 없다"가 유지되려면 사라지는 쪽도 여기 있어야 한다.
    if let Some(raw) = payload.get("acceptanceCriteriaWithdrawn") {
        let ids = raw
            .as_array()
            .ok_or_else(|| StoreError::Invariant("acceptanceCriteriaWithdrawn는 배열이어야 합니다".to_string()))?;
        let withdrawn_at = payload
            .get("withdrawnAt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StoreError::Invariant("철회 이벤트에 \"withdrawnAt\"이 없음".to_string()))?;
        for id in ids {
            let criterion_id = id
                .as_str()
                .ok_or_else(|| StoreError::Invariant("acceptanceCriteriaWithdrawn 항목은 문자열이어야 합니다".to_string()))?;
            // **`source = 'user_decision'`만 거둘 수 있다.** 모델 제안은 애초에 나르지 않으므로
            // 거둘 대상이 아니고, 대상을 넓히면 "무엇을 거뒀는가"가 권위와 무관해진다.
            let changed = tx.execute(
                "UPDATE acceptance_criteria SET withdrawn_at = ?1
                 WHERE task_id = ?2 AND criterion_id = ?3 AND source = 'user_decision' AND withdrawn_at IS NULL",
                params![withdrawn_at, task_id, criterion_id],
            )?;
            // 0건이면 이벤트와 캐시가 어긋난다 — "철회했다고 적혀 있는데 여전히 나르는" 상태다.
            // 조용히 넘기면 그 어긋남이 로그에서 보이지 않으므로 트랜잭션째 되돌린다.
            if changed == 0 {
                return Err(StoreError::Invariant(format!(
                    "거둘 수 있는 사용자 판정이 없습니다: {task_id}/{criterion_id}"
                )));
            }
        }
    }

    let Some(raw) = payload.get("acceptanceCriteria") else {
        return Ok(());
    };
    let items = raw
        .as_array()
        .ok_or_else(|| StoreError::Invariant("acceptanceCriteria는 배열이어야 합니다".to_string()))?;

    if let Some(source) = payload.get("acceptanceCriteriaReplaces").and_then(|v| v.as_str()) {
        tx.execute(
            "DELETE FROM acceptance_criteria WHERE task_id = ?1 AND source = ?2",
            params![task_id, source],
        )?;
    }

    for item in items {
        let field = |name: &str| -> std::result::Result<String, StoreError> {
            item.get(name)
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| StoreError::Invariant(format!("AcceptanceCriterion에 \"{name}\"이 없음")))
        };
        let criterion_id = field("criterionId")?;
        let text = field("text")?;
        let source = field("source")?;
        let decided_at = field("decidedAt")?;
        let disagreement_id = item.get("disagreementId").and_then(|v| v.as_str());

        tx.execute(
            "INSERT INTO acceptance_criteria (task_id, criterion_id, text, source, disagreement_id, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(task_id, criterion_id) DO UPDATE SET
               text = ?3, source = ?4, disagreement_id = ?5, decided_at = ?6",
            params![task_id, criterion_id, text, source, disagreement_id, decided_at],
        )?;
    }
    Ok(())
}

/// 트랜잭션 안에서의 이벤트 삽입. `seq`는 (task_id, seq) unique 제약과 함께 순번을 보장한다.
fn append_event_tx(
    tx: &Transaction<'_>,
    artifacts: &ArtifactStore,
    task_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> std::result::Result<AppendedEvent, StoreError> {
    append_event_tx_with_phase(tx, artifacts, task_id, event_type, payload, None)
}

/// `phase_override`가 있으면 그 값을, 없으면 `tasks.phase` 캐시를 이벤트에 기록한다.
fn append_event_tx_with_phase(
    tx: &Transaction<'_>,
    artifacts: &ArtifactStore,
    task_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
    phase_override: Option<&str>,
) -> std::result::Result<AppendedEvent, StoreError> {
    let phase: Option<String> = match phase_override {
        Some(p) => Some(p.to_string()),
        None => tx
            .query_row("SELECT phase FROM tasks WHERE task_id = ?1", params![task_id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?,
    };

    let next_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), -1) + 1 FROM task_events WHERE task_id = ?1",
        params![task_id],
        |r| r.get(0),
    )?;

    let serialized = serde_json::to_string(payload)?;
    // 8KB 초과 페이로드는 artifact로 밀어내고 참조만 남긴다 (문서 7절).
    let stored_payload = if serialized.len() > INLINE_PAYLOAD_LIMIT_BYTES {
        let stored = artifacts.put_text(task_id, &format!("event-{next_seq}-{event_type}.json"), &serialized)?;
        serde_json::to_string(&serde_json::json!({
            "artifactRef": stored.artifact_ref,
            "sha256": stored.sha256,
            "sizeBytes": stored.size_bytes,
            "preview": serialized.chars().take(512).collect::<String>(),
        }))?
    } else {
        serialized
    };

    tx.execute(
        "INSERT INTO task_events (task_id, seq, event_type, payload_json, phase, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![task_id, next_seq, event_type, stored_payload, phase, now_iso()],
    )?;

    Ok(AppendedEvent {
        event_id: tx.last_insert_rowid(),
        seq: next_seq,
    })
}

const SCHEMA_V1: &str = r#"
CREATE TABLE workspaces (
  workspace_id   TEXT PRIMARY KEY,
  root_path      TEXT NOT NULL,
  name           TEXT NOT NULL,
  policy_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  title          TEXT,
  started_at     TEXT NOT NULL
);

CREATE TABLE tasks (
  task_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(session_id),
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_message   TEXT NOT NULL,
  phase          TEXT NOT NULL,
  counters_json  TEXT NOT NULL,
  final_status   TEXT,
  artifacts_purged INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE task_events (
  event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  seq            INTEGER NOT NULL,
  event_type     TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(task_id, seq)
);
CREATE INDEX idx_task_events_task ON task_events(task_id, seq);

-- append-only 강제: UPDATE/DELETE를 트리거로 막는다.
-- 코드 규율에만 의존하면 나중에 "한 줄만 고치면 되는데"가 반드시 생긴다.
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task_events is append-only');
END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task_events is append-only');
END;

CREATE TABLE tool_requests (
  request_id       TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(task_id),
  plan_id          TEXT NOT NULL,
  tool             TEXT NOT NULL,
  args_json        TEXT NOT NULL,
  risk_tier        TEXT NOT NULL,
  requested_by     TEXT NOT NULL,
  policy_decision  TEXT NOT NULL,
  policy_reason    TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_tool_requests_task ON tool_requests(task_id);

CREATE TABLE tool_results (
  request_id     TEXT PRIMARY KEY REFERENCES tool_requests(request_id),
  status         TEXT NOT NULL,
  output_ref     TEXT,
  error          TEXT,
  duration_ms    INTEGER NOT NULL,
  completed_at   TEXT NOT NULL
);

CREATE TABLE file_mutations (
  request_id       TEXT NOT NULL REFERENCES tool_requests(request_id),
  task_id          TEXT NOT NULL REFERENCES tasks(task_id),
  path             TEXT NOT NULL,
  pre_existed      INTEGER NOT NULL,
  pre_content_ref  TEXT,
  pre_sha256       TEXT,
  post_existed     INTEGER NOT NULL,
  post_content_ref TEXT,
  post_sha256      TEXT,
  recorded_at      TEXT NOT NULL,
  PRIMARY KEY (request_id, path)
);
CREATE INDEX idx_file_mutations_request ON file_mutations(request_id);
CREATE INDEX idx_file_mutations_task ON file_mutations(task_id);

CREATE TABLE verification_reports (
  report_id      TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  phase          TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  overall        TEXT NOT NULL,
  checks_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_verification_reports_task ON verification_reports(task_id);

CREATE TABLE snapshots (
  snapshot_id    TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  git_head       TEXT NOT NULL,
  meta_json      TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- docs/design/multi-engine-routing.md 8절 — 라우팅 결정 기록 (데이터 기반 라우터의 부트스트랩 전제).
CREATE TABLE routing_decisions (
  task_id            TEXT PRIMARY KEY REFERENCES tasks(task_id),
  complexity_tier    TEXT NOT NULL,
  assignments_json   TEXT NOT NULL,
  applied_policies   TEXT NOT NULL,
  reviewer_independent INTEGER NOT NULL,
  decided_at         TEXT NOT NULL
);

-- 북극성 지표(product-strategy.md 14절)의 원천. secret이나 프롬프트 원문은 담지 않는다.
CREATE TABLE provider_usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,
  call_id        TEXT NOT NULL,
  role           TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_usd       REAL,
  latency_ms     INTEGER NOT NULL,
  attempt        INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_provider_usage_task ON provider_usage(task_id);
"#;

/// v2 (M0.1) — 작업 영속화. **전부 additive**: 기존 v1 DB의 이벤트를 하나도 잃지 않고 올라간다.
const SCHEMA_V2: &str = r#"
-- tasks: 목록 표시와 복구에 필요한 정보. 기존 컬럼은 그대로 두고 추가만 한다.
--   phase          → current_phase 역할
--   final_status   → terminal_status 역할 (INTERRUPTED 포함)
ALTER TABLE tasks ADD COLUMN workspace_path TEXT;
ALTER TABLE tasks ADD COLUMN mode TEXT;
ALTER TABLE tasks ADD COLUMN error_summary TEXT;
ALTER TABLE tasks ADD COLUMN cancellation_requested_at TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_path ON tasks(workspace_path, updated_at DESC);

-- 이벤트가 어느 phase에서 발생했는지. 로그만으로 흐름을 재구성하려면 필요하다.
ALTER TABLE task_events ADD COLUMN phase TEXT;

-- 도구 실행의 승인/실행 상태. 기존 tool_requests에 추가한다.
ALTER TABLE tool_requests ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE tool_requests ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'started';
ALTER TABLE tool_requests ADD COLUMN started_at TEXT;

-- 요구 스펙의 `tool_executions`를 **뷰**로 제공한다.
-- 별도 테이블로 만들면 tool_requests/tool_results와 같은 사실이 두 곳에 저장되어 어긋날 수 있다.
-- 뷰는 정의상 어긋날 수 없으므로, 정보 손실 없이 중복 저장을 피하는 방법이다.
CREATE VIEW IF NOT EXISTS tool_executions AS
SELECT
  req.request_id            AS request_id,
  req.task_id               AS task_id,
  req.tool                  AS tool_name,
  req.args_json             AS sanitized_args_json,
  req.policy_decision       AS policy_decision,
  req.approval_status       AS approval_status,
  COALESCE(res.status, req.execution_status) AS execution_status,
  -- 뷰에는 rowid가 없으므로 정렬 기준이 컬럼으로 있어야 한다.
  req.created_at            AS requested_at,
  req.started_at            AS started_at,
  res.completed_at          AS completed_at,
  res.duration_ms           AS duration_ms,
  res.error                 AS error_summary,
  res.output_ref            AS output_artifact_path
FROM tool_requests req
LEFT JOIN tool_results res ON res.request_id = req.request_id;

-- 롤백 상태 추적. 어떤 변경이 아직 남아 있고 어떤 것이 되돌려졌는지 알아야
-- INTERRUPTED 작업의 "되돌리기" 버튼이 정확해진다.
ALTER TABLE file_mutations ADD COLUMN mutation_id TEXT;
ALTER TABLE file_mutations ADD COLUMN rollback_status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE file_mutations ADD COLUMN rolled_back_at TEXT;

-- 검증 체크별 행. verification_reports.checks_json은 원본 보존용으로 남기고,
-- 조회·집계는 이 테이블을 쓴다 (JSON 파싱 없이 "test가 몇 번 실패했나"를 물을 수 있어야 한다).
CREATE TABLE IF NOT EXISTS verification_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id      TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  stage          TEXT NOT NULL,   -- baseline | post
  check_kind     TEXT NOT NULL,   -- build | test | lint | typecheck | diff_review
  status         TEXT NOT NULL,   -- PASSED | FAILED | NOT_CONFIGURED | SKIPPED_WITH_REASON | TIMED_OUT
  command_json   TEXT,            -- 실행된 argv (셸 문자열이 아니다)
  summary        TEXT NOT NULL,
  exit_code      INTEGER,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_checks_task ON verification_checks(task_id);
"#;

const SCHEMA_V3: &str = r#"
-- 사용자 판정의 고정 (docs/design/state-machine-and-protocol.md 17.3절).
--
-- `task_events`가 진실의 원천이고 이 테이블은 **파생 캐시**다(CLAUDE.md 원칙 7).
-- VERIFYING과 최종 보고가 매번 이벤트를 재생하지 않도록 두는 것이며 `tasks.phase`와 같은 성격이다.
-- 그래서 이 테이블을 갱신하는 유일한 경로가 `append_event`의 트랜잭션 안에 있다 —
-- 이벤트 없이 이 테이블만 바꾸는 공개 API는 만들지 않는다.
CREATE TABLE IF NOT EXISTS acceptance_criteria (
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  criterion_id   TEXT NOT NULL,
  text           TEXT NOT NULL,
  source         TEXT NOT NULL,       -- user_decision | draft_proposal | user_message
  disagreement_id TEXT,               -- source = user_decision 일 때
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_task ON acceptance_criteria(task_id);
"#;

/// v4 (M1) — **공급자가 실제로 응답한 모델**. product-strategy 6절 "Agent Trace 완성".
///
/// # 왜 필요한가 — 요청한 모델만 남기면 감사 기록이 거짓말을 한다
///
/// `model_id`는 우리가 **요청한** 값이라 언제나 우리 기대와 같다. 그걸로 "이 모델이 답했다"고
/// 기록하면, 공급자가 조용히 다른 모델로 대체했을 때 로그가 그 사실을 지운다. sidecar는 이미
/// 응답 envelope에서 `providerReportedModelId`를 뽑아 보내고 있었는데(`usage.record` payload),
/// **DB 경계에서 버려지고 있었다.** 보내는 쪽은 맞았고 받는 쪽이 빠져 있었다.
///
/// `provider_request_id`를 함께 두는 이유: 감사에서 공급자 로그와 대조할 열쇠가 그것뿐이다.
/// 우리 `call_id`는 우리만 아는 값이라 상대에게 물을 수 없다.
///
/// **전부 추가 연산이다**(16.4절 규칙). 기존 행은 NULL로 남고, NULL은 "다른 모델이었다"가
/// 아니라 **"기록하기 전이었다"**를 뜻한다 — 그 구별을 집계가 지켜야 한다.
const SCHEMA_V4: &str = r#"
ALTER TABLE provider_usage ADD COLUMN requested_model_id TEXT;
ALTER TABLE provider_usage ADD COLUMN resolved_model_id  TEXT;
ALTER TABLE provider_usage ADD COLUMN provider_request_id TEXT;
"#;

/// v5: **우리가 추정했던 입력 토큰**을 공급자가 보고한 실제 옆에 둔다.
///
/// 컨텍스트 패킹은 토큰 수를 추정으로 다루고(정확한 수는 토크나이저마다 다르므로 원리적으로
/// 하나가 아니다 — context-engine.md 8절), 그 추정은 **상한이라고 주장**한다. 주장이 참인지는
/// 두 수를 나란히 놓아야만 알 수 있다.
///
/// NULL을 허용한다. v5 이전 행과 추정하지 않은 경로는 **모르는 것**이고, 0으로 채우면 집계가
/// 그걸 "추정이 0이었다"(=무한대 배 과소 추정)로 읽는다.
const SCHEMA_V5: &str = r#"
ALTER TABLE provider_usage ADD COLUMN estimated_input_tokens INTEGER;
"#;

/// v6: 워크스페이스별 **공급자 허용 목록** (multi-engine-routing.md 16절).
///
/// # 왜 저장소 안의 파일이 아니라 여기인가
///
/// 워크스페이스 안의 설정 파일에 두면 **모델이 고칠 수 있는 파일이 자기 데이터가 어디로
/// 나갈지를 정하게 된다.** 이 앱의 태스크는 워크스페이스 파일을 바꾸는 것이 일이므로, 그건
/// "정책을 지키는 주체가 정책을 수정할 수 있는" 구조다. 앱의 상태 DB는 Rust의 것이고
/// 어떤 도구도 여기 쓰지 못한다.
///
/// NULL은 **제한 없음**이고 빈 JSON 배열(`[]`)은 **아무것도 허용하지 않음**이다. 둘을 같게
/// 다루면 빈 목록을 저장한 사용자가 전부 허용된다.
const SCHEMA_V6: &str = r#"
ALTER TABLE workspaces ADD COLUMN allowed_providers TEXT;
"#;

/// `WorkspaceIndex` 캐시 (context-engine.md 2절, process-architecture.md 11.4절).
///
/// **워크스페이스당 한 행이다.** 여러 지문의 인덱스를 쌓아두지 않는 이유: 쓸 수 있는 것은
/// 언제나 "지금 상태와 같은" 하나뿐이고, 나머지는 영원히 안 맞는 항목으로 남아 자란다.
///
/// 캐시이므로 **잃어도 정확성이 상하지 않는다** — 없으면 다시 만든다. 그래서 `task_events`와
/// 달리 append-only가 아니고, 지워도 되는 유일한 테이블이다.
/// v8 (M3) — **판정의 철회**(문서 30절).
///
/// 컬럼 하나를 더한다. 행을 지우지 않는 이유가 이 기능의 핵심이다: 철회는 "그때 그 기준이
/// 없었다"가 아니라 **"앞으로는 나르지 않는다"**이므로, 그 태스크가 무엇을 기준으로 판정됐는지는
/// 그대로 남아야 한다. 지우면 끝난 태스크의 감사 기록이 소급해서 바뀐다.
const SCHEMA_V8: &str = r#"
ALTER TABLE acceptance_criteria ADD COLUMN withdrawn_at TEXT;
"#;

const SCHEMA_V7: &str = r#"
CREATE TABLE workspace_index_cache (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  -- 이 인덱스가 유효한 워크스페이스 상태. HEAD 하나가 아니라 **지문**이다:
  -- HEAD가 같아도 워킹 트리가 다르면 파일 집합이 다르고, 그러면 인덱스도 다르다.
  fingerprint    TEXT NOT NULL,
  git_head       TEXT,
  payload_json   TEXT NOT NULL,
  built_at       TEXT NOT NULL,
  -- 인덱스를 만드는 데 실제로 걸린 시간. **캐시의 이득을 재는 유일한 근거다** —
  -- 이 값이 없으면 "캐시가 필요한가"라는 질문에 영원히 추정으로 답하게 된다.
  build_ms       INTEGER
);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ImageRef, ToolStatus};

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();
        let store = Store::open_in_memory(artifacts).unwrap();
        (dir, store)
    }

    fn seeded() -> (tempfile::TempDir, Store) {
        let (dir, mut store) = store();
        store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        store
            .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "verified", "fix the bug")
            .unwrap();
        (dir, store)
    }

    #[test]
    fn migration_from_v1_preserves_existing_events() {
        // v1 DB를 만든 뒤 v2로 올려도 이벤트가 하나도 사라지지 않아야 한다.
        // append-only 진실의 원천이라는 약속은 마이그레이션에도 적용된다.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();

        {
            // v1 스키마만 적용한 DB를 손으로 만든다.
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.pragma_update(None, "user_version", 1i64).unwrap();
            conn.execute(
                "INSERT INTO workspaces VALUES ('ws-1', '/tmp/ws', 'ws', '{}', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions VALUES ('sess-1', 'ws-1', NULL, '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tasks (task_id, session_id, workspace_id, user_message, phase, counters_json,
                                    final_status, artifacts_purged, created_at, updated_at)
                 VALUES ('old-task', 'sess-1', 'ws-1', 'legacy', 'EXECUTING', '{}', NULL, 0,
                         '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_events (task_id, seq, event_type, payload_json, created_at)
                 VALUES ('old-task', 0, 'TASK_CREATED', '{}', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&db, artifacts).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let events = store.events("old-task").unwrap();
        assert_eq!(events.len(), 1, "마이그레이션이 기존 이벤트를 잃었습니다");
        assert_eq!(events[0].event_type, "TASK_CREATED");
        // 새 컬럼은 NULL이지만 행은 살아 있어야 한다.
        let task = store.get_task("old-task").unwrap().unwrap();
        assert_eq!(task.current_phase, "EXECUTING");
        assert!(task.workspace_path.is_none());
    }

    /// v3 DB를 v4로 올려도 기존 사용량 기록이 살아 있어야 한다. 그리고 **새 컬럼은 NULL**이며,
    /// NULL은 "요청한 모델과 같았다"가 아니라 **"기록하기 전이었다"**를 뜻한다 —
    /// 그 구별을 집계가 지키지 않으면 옛 기록이 전부 "대체 없음"으로 보고된다.
    #[test]
    fn migration_from_v3_keeps_usage_rows_and_leaves_new_columns_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.execute_batch(SCHEMA_V3).unwrap();
            conn.pragma_update(None, "user_version", 3i64).unwrap();
            conn.execute(
                "INSERT INTO workspaces VALUES ('ws-1', '/tmp/ws', 'ws', '{}', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions VALUES ('sess-1', 'ws-1', NULL, '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO provider_usage (task_id, call_id, role, provider_id, model_id,
                                             input_tokens, output_tokens, cost_usd, latency_ms, attempt, created_at)
                 VALUES ('old-task', 'c1', 'executor', 'openai', 'gpt-old', 10, 5, 0.1, 20, 1,
                         '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&db, artifacts).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let rows = store.provider_transmission("old-task").unwrap();
        assert_eq!(rows.len(), 1, "마이그레이션이 기존 사용량 기록을 잃었습니다");
        assert_eq!(rows[0].models, vec!["gpt-old"]);
        assert!(
            rows[0].resolved_models.is_empty(),
            "옛 행에 응답 모델이 있을 수 없습니다"
        );
        assert!(!rows[0].substituted, "모르는 것을 대체로 보고했습니다");
    }

    #[test]
    fn migration_from_v2_preserves_existing_data() {
        // v2 DB를 v3로 올려도 기존 이벤트/작업이 살아 있어야 한다. 새 테이블 추가가
        // 사용자의 감사 로그를 지우는 마이그레이션이 되면 "append-only 진실의 원천"이라는
        // 약속이 깨진다 — v1→v2에서 지킨 것과 같은 규칙이다(문서 16.4절).
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();

        {
            // v1 + v2까지만 적용한 DB를 손으로 만든다.
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch(SCHEMA_V2).unwrap();
            conn.pragma_update(None, "user_version", 2i64).unwrap();
            conn.execute(
                "INSERT INTO workspaces (workspace_id, root_path, name, created_at)
                 VALUES ('ws-old', '/tmp/old', 'old', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (session_id, workspace_id, started_at)
                 VALUES ('sess-old', 'ws-old', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tasks (task_id, session_id, workspace_id, user_message, phase,
                                    counters_json, created_at, updated_at)
                 VALUES ('v2-task', 'sess-old', 'ws-old', 'v2에서 만든 작업', 'VERIFYING', '{}',
                         '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_events (task_id, seq, event_type, payload_json, phase, created_at)
                 VALUES ('v2-task', 0, 'TASK_CREATED', '{}', 'CREATED', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let mut store = Store::open(&db, artifacts).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

        let events = store.events("v2-task").unwrap();
        assert_eq!(events.len(), 1, "마이그레이션이 기존 이벤트를 잃었습니다");
        assert_eq!(events[0].event_type, "TASK_CREATED");
        let task = store.get_task("v2-task").unwrap().unwrap();
        assert_eq!(task.current_phase, "VERIFYING");
        assert_eq!(task.user_message, "v2에서 만든 작업");

        // 새 테이블은 비어 있고, 바로 쓸 수 있어야 한다.
        assert!(store.acceptance_criteria("v2-task").unwrap().is_empty());
        store
            .append_event(
                "v2-task",
                "USER_DECISION_RECORDED",
                &serde_json::json!({
                    "answer": "빈 문자열은 거부",
                    "acceptanceCriteria": [{
                        "criterionId": "c-1", "text": "빈 문자열은 거부",
                        "source": "user_decision", "decidedAt": "2020-01-02T00:00:00Z"
                    }],
                }),
            )
            .unwrap();
        assert_eq!(store.acceptance_criteria("v2-task").unwrap().len(), 1);
    }

    #[test]
    fn acceptance_criteria_are_only_written_by_events() {
        // 파생 캐시는 이벤트를 쓰는 **같은 트랜잭션**에서만 갱신된다(원칙 7).
        // 이벤트가 실어오지 않으면 캐시는 비어 있어야 한다 — 다른 경로가 없다는 뜻이다.
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "DRAFT_RECEIVED", &serde_json::json!({ "model": "m" }))
            .unwrap();
        assert!(store.acceptance_criteria("task-1").unwrap().is_empty());

        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &serde_json::json!({
                    "acceptanceCriteria": [{
                        "criterionId": "u-1", "text": "빈 문자열 이메일은 거부한다",
                        "source": "user_decision", "decidedAt": "2024-01-01T00:00:00Z"
                    }],
                }),
            )
            .unwrap();
        let rows = store.acceptance_criteria("task-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "user_decision");
        assert_eq!(rows[0].text, "빈 문자열 이메일은 거부한다");
    }

    #[test]
    fn a_new_draft_replaces_only_its_own_criteria() {
        // 재초안이 오면 이전 초안의 doneCriteria는 철회된 해석이라 대체된다.
        // 그러나 사용자 판정은 모델 산출물이 덮을 수 없다 — 권위가 다르다.
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &serde_json::json!({
                    "acceptanceCriteria": [{
                        "criterionId": "u-1", "text": "사용자 판정",
                        "source": "user_decision", "decidedAt": "2024-01-01T00:00:00Z"
                    }],
                }),
            )
            .unwrap();
        store
            .append_event(
                "task-1",
                "DRAFT_RECEIVED",
                &serde_json::json!({
                    "acceptanceCriteria": [{
                        "criterionId": "d-1", "text": "1차 초안 기준",
                        "source": "draft_proposal", "decidedAt": "2024-01-01T00:01:00Z"
                    }],
                    "acceptanceCriteriaReplaces": "draft_proposal",
                }),
            )
            .unwrap();
        store
            .append_event(
                "task-1",
                "DRAFT_RECEIVED",
                &serde_json::json!({
                    "acceptanceCriteria": [{
                        "criterionId": "d-2", "text": "2차 초안 기준",
                        "source": "draft_proposal", "decidedAt": "2024-01-01T00:02:00Z"
                    }],
                    "acceptanceCriteriaReplaces": "draft_proposal",
                }),
            )
            .unwrap();

        let rows = store.acceptance_criteria("task-1").unwrap();
        let texts: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, vec!["사용자 판정", "2차 초안 기준"]);
        // 권위를 가진 것이 먼저 나와야 한다 — 최종 보고 화면이 이 순서를 그대로 쓴다.
        assert_eq!(rows[0].source, "user_decision");
    }

    #[test]
    fn malformed_criteria_fail_loudly() {
        // 조용히 건너뛰면 "기준이 없었다"와 "기록에 실패했다"가 구별되지 않는다.
        let (_d, mut store) = seeded();
        let err = store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &serde_json::json!({ "acceptanceCriteria": [{ "text": "criterionId가 없다" }] }),
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Invariant(_)), "{err:?}");
    }

    #[test]
    fn events_record_the_phase_they_happened_in() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "EXECUTING" }))
            .unwrap();
        store
            .append_event(
                "task-1",
                "TOOL_REQUESTED",
                &serde_json::json!({ "tool": "apply_patch" }),
            )
            .unwrap();

        let events = store.events("task-1").unwrap();
        let tool_event = events.iter().find(|e| e.event_type == "TOOL_REQUESTED").unwrap();
        assert_eq!(tool_event.phase.as_deref(), Some("EXECUTING"));
    }

    #[test]
    fn terminal_transition_is_atomic_and_rejects_second_terminal() {
        let (_d, mut store) = seeded();
        let first = store
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, &serde_json::json!({}))
            .unwrap();
        assert!(matches!(first, TerminalOutcome::Recorded { .. }));

        let second = store
            .finish_task("task-1", "CANCELLED", "TASK_CANCELLED", None, &serde_json::json!({}))
            .unwrap();
        assert!(matches!(second, TerminalOutcome::AlreadyTerminal { .. }));
        assert_eq!(store.task_final_status("task-1").unwrap().as_deref(), Some("COMPLETED"));
    }

    #[test]
    fn phase_change_after_terminal_is_rejected() {
        let (_d, mut store) = seeded();
        store
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, &serde_json::json!({}))
            .unwrap();
        let err = store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "EXECUTING" }))
            .unwrap_err();
        assert!(matches!(err, StoreError::TerminalAlreadySet { .. }));
        assert_eq!(store.task_phase("task-1").unwrap().as_deref(), Some("COMPLETED"));
    }

    #[test]
    fn cancellation_request_is_recorded_once() {
        let (_d, mut store) = seeded();
        let first = store.record_cancellation_request("task-1", "사용자 요청").unwrap();
        assert!(first.is_some());
        let second = store.record_cancellation_request("task-1", "사용자 요청").unwrap();
        assert!(second.is_none(), "두 번째 요청은 이벤트를 남기지 않아야 합니다");

        let count = store
            .event_types("task-1")
            .unwrap()
            .into_iter()
            .filter(|t| t == "CANCELLATION_REQUESTED")
            .count();
        assert_eq!(count, 1);
        assert!(store
            .get_task("task-1")
            .unwrap()
            .unwrap()
            .cancellation_requested_at
            .is_some());
    }

    #[test]
    fn cancellation_request_on_terminal_task_is_rejected() {
        let (_d, mut store) = seeded();
        store
            .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, &serde_json::json!({}))
            .unwrap();
        let err = store.record_cancellation_request("task-1", "사용자 요청").unwrap_err();
        assert!(matches!(err, StoreError::TerminalAlreadySet { .. }));
        assert!(store
            .get_task("task-1")
            .unwrap()
            .unwrap()
            .cancellation_requested_at
            .is_none());
    }

    #[test]
    fn unfinished_tasks_become_interrupted_on_restart() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();

        {
            let mut store = Store::open(&db, artifacts.clone()).unwrap();
            store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
            store.upsert_session("sess-1", "ws-1", None).unwrap();
            store
                .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "verified", "fix")
                .unwrap();
            store
                .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "EXECUTING" }))
                .unwrap();
            // 여기서 앱이 죽었다고 가정한다 — 터미널 이벤트가 없다.
        }

        // 새 인스턴스로 다시 연다 (앱 재시작).
        let mut restarted = Store::open(&db, artifacts).unwrap();
        let marked = restarted.mark_unfinished_as_interrupted().unwrap();
        assert_eq!(marked, vec!["task-1".to_string()]);

        let task = restarted.get_task("task-1").unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("INTERRUPTED"));
        // 어느 phase에서 끊겼는지가 남아야 사용자가 판단할 수 있다.
        let event = restarted
            .events("task-1")
            .unwrap()
            .into_iter()
            .find(|e| e.event_type == "TASK_INTERRUPTED")
            .unwrap();
        assert_eq!(event.payload["interruptedAtPhase"].as_str().unwrap(), "EXECUTING");
        assert_eq!(event.payload["automaticResume"].as_bool().unwrap(), false);

        // 두 번 돌려도 중복 표시하지 않는다.
        assert!(restarted.mark_unfinished_as_interrupted().unwrap().is_empty());
    }

    #[test]
    fn records_survive_reopening_the_database() {
        // 시나리오 C의 저장 계층 부분: 재시작 후에도 모든 기록과 순서가 유지되어야 한다.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();

        {
            let mut store = Store::open(&db, artifacts.clone()).unwrap();
            store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
            store.upsert_session("sess-1", "ws-1", None).unwrap();
            store
                .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "fast", "fix")
                .unwrap();
            store
                .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "EXECUTING" }))
                .unwrap();
            store
                .finish_task("task-1", "COMPLETED", "TASK_COMPLETED", None, &serde_json::json!({}))
                .unwrap();
        }

        let reopened = Store::open(&db, artifacts).unwrap();
        let task = reopened.get_task("task-1").unwrap().unwrap();
        assert_eq!(task.terminal_status.as_deref(), Some("COMPLETED"));
        assert_eq!(task.mode.as_deref(), Some("fast"));
        assert_eq!(task.workspace_path.as_deref(), Some("/tmp/ws"));

        let seqs: Vec<i64> = reopened.events("task-1").unwrap().iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2], "이벤트 순서가 유지되어야 합니다");

        let listed = reopened.list_tasks(Some("/tmp/ws"), 10, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].task_id, "task-1");
        // 다른 워크스페이스로 필터하면 나오지 않는다.
        assert!(reopened.list_tasks(Some("/other"), 10, None).unwrap().is_empty());
    }

    #[test]
    fn events_after_returns_only_new_events() {
        let (_d, mut store) = seeded();
        let first = store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "TRIAGE" }))
            .unwrap();
        store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "PLANNING" }))
            .unwrap();

        let new_only = store.events_after("task-1", Some(first.event_id)).unwrap();
        assert_eq!(new_only.len(), 1);
        assert_eq!(new_only[0].payload["to"].as_str().unwrap(), "PLANNING");
        // 커서가 없으면 전부 반환한다.
        assert_eq!(store.events_after("task-1", None).unwrap().len(), 3);
    }

    /// **제한 없음과 빈 목록이 저장을 왕복해도 구별되어야 한다.**
    ///
    /// 어느 한쪽이 다른 쪽으로 접히면 그 순간 사용자가 건 제한이 사라지거나(빈 목록 → 전부 허용)
    /// 아무것도 못 쓰게 된다(제한 없음 → 전부 차단). 저장 계층은 이 구별을 잃으면 안 된다.
    #[test]
    fn an_empty_allowlist_survives_a_round_trip_as_empty() {
        let (_d, store) = seeded();
        // 기본값은 제한 없음이다 — 기존 워크스페이스가 갑자기 막히지 않는다.
        assert_eq!(store.allowed_providers("ws-1").unwrap(), None);

        store.set_allowed_providers("ws-1", Some(&[])).unwrap();
        assert_eq!(store.allowed_providers("ws-1").unwrap(), Some(vec![]));

        store
            .set_allowed_providers("ws-1", Some(&["anthropic".to_string()]))
            .unwrap();
        assert_eq!(
            store.allowed_providers("ws-1").unwrap(),
            Some(vec!["anthropic".to_string()])
        );

        // 제한을 다시 푸는 것도 가능해야 한다.
        store.set_allowed_providers("ws-1", None).unwrap();
        assert_eq!(store.allowed_providers("ws-1").unwrap(), None);
    }

    /// **깨진 기록을 "제한 없음"으로 읽지 않는다.** 그러면 저장이 망가진 순간 제한이 조용히
    /// 사라지고, 사용자는 자기가 건 제한이 걸려 있다고 믿는다.
    #[test]
    fn a_corrupt_allowlist_is_an_error_not_unrestricted() {
        let (_d, store) = seeded();
        store
            .conn
            .execute(
                "UPDATE workspaces SET allowed_providers = '{not a list}' WHERE workspace_id = 'ws-1'",
                [],
            )
            .unwrap();
        assert!(store.allowed_providers("ws-1").is_err());
    }

    #[test]
    fn tool_executions_view_joins_request_and_result() {
        let (_d, mut store) = seeded();
        let request = ToolRequest {
            request_id: "r1".into(),
            task_id: "task-1".into(),
            tool: crate::types::ToolName::RunCommand,
            args: serde_json::json!({ "program": "npm", "args": ["test"] }),
            risk_tier: None,
            requested_by: serde_json::json!({ "role": "orchestrator" }),
            created_at: None,
            injected_env: Default::default(),
        };
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::RequireUserApproval,
            risk_level: crate::types::RiskLevel::Medium,
            matched_rule: "allow:npm test".into(),
            reason: "1클릭 승인".into(),
            requires_user_approval: true,
            normalized_target: "npm test".into(),
            unblocked_by: crate::types::PolicyLever::NotApplicable,
            redraftable: false,
            decided_at: now_iso(),
        };
        store.record_tool_request(&request, "plan-1", &decision).unwrap();
        store
            .record_tool_result_with_event(
                &ToolResult {
                    request_id: "r1".into(),
                    status: ToolStatus::Cancelled,
                    output: None,
                    error: Some("사용자 취소".into()),
                    duration_ms: 42,
                    completed_at: now_iso(),
                    denial_kind: None,
                },
                None,
                "task-1",
                &serde_json::json!({ "requestId": "r1" }),
            )
            .unwrap();

        let (tool_name, policy, approval, execution, duration): (String, String, String, String, i64) = store
            .conn
            .query_row(
                "SELECT tool_name, policy_decision, approval_status, execution_status, duration_ms
                 FROM tool_executions WHERE request_id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(tool_name, "run_command");
        assert_eq!(policy, "require_user_approval");
        assert_eq!(approval, "pending");
        assert_eq!(execution, "cancelled");
        assert_eq!(duration, 42);
    }

    #[test]
    fn verification_checks_are_queryable_per_check() {
        let (_d, mut store) = seeded();
        let report = VerificationReport {
            task_id: "task-1".into(),
            report_id: "rep-1".into(),
            phase: crate::types::VerificationPhase::Post,
            attempt_number: 0,
            checks: vec![
                crate::types::VerificationCheck {
                    kind: crate::types::VerificationKind::Test,
                    command: Some(crate::types::RunCommandArgs {
                        program: "npm".into(),
                        args: vec!["test".into()],
                        cwd: ".".into(),
                        timeout_ms: None,
                    }),
                    status: crate::types::VerificationStatus::Passed,
                    summary: "통과".into(),
                    detail: None,
                    detail_ref: None,
                    exit_code: Some(0),
                    duration_ms: Some(120),
                },
                crate::types::VerificationCheck {
                    kind: crate::types::VerificationKind::Lint,
                    command: None,
                    status: crate::types::VerificationStatus::NotConfigured,
                    summary: "없음".into(),
                    detail: None,
                    detail_ref: None,
                    exit_code: None,
                    duration_ms: None,
                },
            ],
            newly_failing: None,
            preexisting_failures: None,
            overall: crate::types::Overall::Pass,
            created_at: now_iso(),
        };
        store
            .record_verification_with_event(&report, &serde_json::json!({ "reportId": "rep-1" }))
            .unwrap();

        let (kind, status, command): (String, String, Option<String>) = store
            .conn
            .query_row(
                "SELECT check_kind, status, command_json FROM verification_checks
                 WHERE report_id = 'rep-1' AND check_kind = 'test'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "test");
        assert_eq!(status, "PASSED");
        // 명령은 argv 구조로 보존된다 — 나중에 무엇이 실행됐는지 재구성할 수 있어야 한다.
        assert!(command.unwrap().contains("\"program\":\"npm\""));

        let not_configured: String = store
            .conn
            .query_row(
                "SELECT status FROM verification_checks WHERE report_id = 'rep-1' AND check_kind = 'lint'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(not_configured, "NOT_CONFIGURED", "미설정을 통과로 저장하면 안 됩니다");
    }

    #[test]
    fn mutation_rollback_status_is_tracked() {
        let (_d, mut store) = seeded();
        let request = ToolRequest {
            request_id: "r1".into(),
            task_id: "task-1".into(),
            tool: crate::types::ToolName::ApplyPatch,
            args: serde_json::json!({ "path": "src/a.ts" }),
            risk_tier: None,
            requested_by: serde_json::json!({ "role": "orchestrator" }),
            created_at: None,
            injected_env: Default::default(),
        };
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::AutoApprove,
            risk_level: crate::types::RiskLevel::Low,
            matched_rule: "t".into(),
            reason: "t".into(),
            requires_user_approval: false,
            normalized_target: "src/a.ts".into(),
            unblocked_by: crate::types::PolicyLever::NotApplicable,
            redraftable: false,
            decided_at: now_iso(),
        };
        store.record_tool_request(&request, "plan-1", &decision).unwrap();
        store
            .record_file_mutation_with_event(
                &FileMutationRecord {
                    request_id: "r1".into(),
                    task_id: "task-1".into(),
                    path: "src/a.ts".into(),
                    pre_image: ImageRef {
                        existed: true,
                        content_ref: Some("task-1/pre.txt".into()),
                        sha256: None,
                    },
                    post_image: ImageRef {
                        existed: true,
                        content_ref: None,
                        sha256: None,
                    },
                },
                &serde_json::json!({ "path": "src/a.ts" }),
            )
            .unwrap();

        let status: String = store
            .conn
            .query_row(
                "SELECT rollback_status FROM file_mutations WHERE task_id = 'task-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "applied");

        store.mark_mutation_rolled_back("task-1", "src/a.ts").unwrap();
        let (status, at): (String, Option<String>) = store
            .conn
            .query_row(
                "SELECT rollback_status, rolled_back_at FROM file_mutations WHERE task_id = 'task-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "rolled_back");
        assert!(at.is_some());

        // mutation과 이벤트가 같은 트랜잭션에 기록됐는지 — 둘 다 있어야 한다.
        assert!(store
            .event_types("task-1")
            .unwrap()
            .contains(&"FILE_MUTATED".to_string()));
    }

    #[test]
    fn secrets_are_not_stored_in_events_by_the_store() {
        // Store는 넘겨받은 payload를 그대로 쓴다. 그래서 "secret을 넣지 않는다"는 책임은
        // 호출자(host.rs의 redact_args)에 있고, 여기서는 **user_message 길이 상한**만 검증한다.
        // 실제 secret 차단은 host 계층과 e2e에서 검증된다.
        let (_d, mut store) = store();
        store.upsert_workspace("ws-1", "/tmp/ws", "ws").unwrap();
        store.upsert_session("sess-1", "ws-1", None).unwrap();
        let long = "x".repeat(10_000);
        store
            .create_task("task-1", "sess-1", "ws-1", "/tmp/ws", "fast", &long)
            .unwrap();
        let event = store.events("task-1").unwrap().pop().unwrap();
        let stored = event.payload["userMessage"].as_str().unwrap_or_default();
        assert!(stored.len() < 3_000, "이벤트 payload가 무제한으로 커지면 안 됩니다");
    }

    #[test]
    fn migration_sets_schema_version() {
        let (_d, store) = store();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn migration_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();
        {
            let s = Store::open(&db, artifacts.clone()).unwrap();
            assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        }
        // 두 번째 open이 DDL을 다시 실행하려 하면 "table already exists"로 실패한다.
        let s2 = Store::open(&db, artifacts).unwrap();
        assert_eq!(s2.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn create_task_emits_event_and_sets_phase() {
        let (_d, store) = seeded();
        assert_eq!(store.task_phase("task-1").unwrap().as_deref(), Some("CREATED"));
        assert_eq!(store.event_types("task-1").unwrap(), vec!["TASK_CREATED"]);
    }

    #[test]
    fn phase_change_updates_derived_cache_in_same_transaction() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "PHASE_CHANGED",
                &serde_json::json!({ "from": "CREATED", "to": "SNAPSHOTTING" }),
            )
            .unwrap();
        assert_eq!(store.task_phase("task-1").unwrap().as_deref(), Some("SNAPSHOTTING"));
    }

    #[test]
    fn terminal_phase_sets_final_status() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "COMPLETED" }))
            .unwrap();
        // final_status는 phase 이름을 그대로 쓴다 (소문자로 바꾸지 않는다) —
        // INTERRUPTED가 추가되면서 phase 값과 표기를 통일하는 편이 혼란이 적다.
        assert_eq!(store.task_final_status("task-1").unwrap().as_deref(), Some("COMPLETED"));
        assert!(store.unfinished_tasks().unwrap().is_empty());
    }

    #[test]
    fn phase_changed_without_to_is_rejected() {
        let (_d, mut store) = seeded();
        let err = store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({}))
            .unwrap_err();
        assert!(matches!(err, StoreError::Invariant(_)));
        // 트랜잭션이 롤백됐으므로 이벤트도 남지 않아야 한다.
        assert_eq!(store.event_types("task-1").unwrap(), vec!["TASK_CREATED"]);
    }

    #[test]
    fn events_are_append_only() {
        let (_d, mut store) = seeded();
        store
            .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": "TRIAGE" }))
            .unwrap();

        // 저장 API는 수정 경로를 제공하지 않는다. DB 수준에서도 막혀 있는지 직접 확인한다.
        let update = store.conn.execute(
            "UPDATE task_events SET event_type = 'FORGED' WHERE task_id = 'task-1'",
            [],
        );
        assert!(update.is_err(), "UPDATE on task_events must be rejected");
        let delete = store
            .conn
            .execute("DELETE FROM task_events WHERE task_id = 'task-1'", []);
        assert!(delete.is_err(), "DELETE on task_events must be rejected");
    }

    #[test]
    fn event_seq_is_monotonic_per_task() {
        let (_d, mut store) = seeded();
        for phase in ["SNAPSHOTTING", "TRIAGE", "PLANNING"] {
            store
                .append_event("task-1", "PHASE_CHANGED", &serde_json::json!({ "to": phase }))
                .unwrap();
        }
        let seqs: Vec<i64> = store.events("task-1").unwrap().iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2, 3]);
    }

    #[test]
    fn large_payload_is_offloaded_to_artifact() {
        let (_d, mut store) = seeded();
        let big = "x".repeat(INLINE_PAYLOAD_LIMIT_BYTES + 100);
        store
            .append_event("task-1", "TOOL_COMPLETED", &serde_json::json!({ "output": big }))
            .unwrap();
        let event = store.events("task-1").unwrap().pop().unwrap();
        let artifact_ref = event.payload.get("artifactRef").and_then(|v| v.as_str()).unwrap();
        assert!(event.payload.get("preview").is_some());
        let restored = store.artifacts().read_text(artifact_ref).unwrap();
        assert!(restored.contains(&big));
    }

    #[test]
    fn rollback_targets_use_earliest_pre_image() {
        let (_d, mut store) = seeded();
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::AutoApprove,
            risk_level: crate::types::RiskLevel::Low,
            matched_rule: "t".into(),
            reason: "t".into(),
            requires_user_approval: false,
            normalized_target: "src/a.ts".into(),
            unblocked_by: crate::types::PolicyLever::NotApplicable,
            redraftable: false,
            decided_at: now_iso(),
        };
        for (rid, pre) in [("r1", "v0"), ("r2", "v1")] {
            let mut req = ToolRequest {
                request_id: rid.to_string(),
                task_id: "task-1".into(),
                tool: crate::types::ToolName::ApplyPatch,
                args: serde_json::json!({ "path": "src/a.ts" }),
                risk_tier: None,
                requested_by: serde_json::json!({ "role": "orchestrator" }),
                created_at: None,
                injected_env: Default::default(),
            };
            req.request_id = rid.to_string();
            let mut d = decision.clone();
            d.request_id = rid.to_string();
            store.record_tool_request(&req, "plan-1", &d).unwrap();
            store
                .record_file_mutation(&FileMutationRecord {
                    request_id: rid.to_string(),
                    task_id: "task-1".into(),
                    path: "src/a.ts".into(),
                    pre_image: ImageRef {
                        existed: true,
                        content_ref: Some(format!("task-1/{pre}.blob")),
                        sha256: None,
                    },
                    post_image: ImageRef {
                        existed: true,
                        content_ref: None,
                        sha256: None,
                    },
                })
                .unwrap();
        }
        let targets = store.rollback_targets("task-1").unwrap();
        assert_eq!(targets.len(), 1);
        // 두 번 고쳤어도 되돌릴 대상은 태스크 시작 시점의 내용이어야 한다.
        assert_eq!(targets[0].pre_image.content_ref.as_deref(), Some("task-1/v0.blob"));
    }

    #[test]
    fn tool_result_is_recorded() {
        let (_d, store) = seeded();
        let req = ToolRequest {
            request_id: "r1".into(),
            task_id: "task-1".into(),
            tool: crate::types::ToolName::ReadFile,
            args: serde_json::json!({ "path": "a" }),
            risk_tier: None,
            requested_by: serde_json::json!({ "role": "orchestrator" }),
            created_at: None,
            injected_env: Default::default(),
        };
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::AutoApprove,
            risk_level: crate::types::RiskLevel::None,
            matched_rule: "read_only".into(),
            reason: "ok".into(),
            requires_user_approval: false,
            normalized_target: "a".into(),
            unblocked_by: crate::types::PolicyLever::NotApplicable,
            redraftable: false,
            decided_at: now_iso(),
        };
        store.record_tool_request(&req, "plan-1", &decision).unwrap();
        store
            .record_tool_result(
                &ToolResult {
                    request_id: "r1".into(),
                    status: ToolStatus::Ok,
                    output: None,
                    error: None,
                    duration_ms: 5,
                    completed_at: now_iso(),
                    denial_kind: None,
                },
                None,
            )
            .unwrap();
        let status: String = store
            .conn
            .query_row("SELECT status FROM tool_results WHERE request_id='r1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "ok");
    }

    #[test]
    fn provider_usage_records_tokens_without_secrets() {
        let (_d, store) = seeded();
        store
            .record_provider_usage(&serde_json::json!({
                "taskId": "task-1",
                "callId": "draft:1",
                "role": "executor",
                "providerId": "fake",
                "modelId": "fake-executor",
                "usage": { "inputTokens": 100, "outputTokens": 20 },
                "costUsd": 0.001,
                "latencyMs": 42,
                "attempt": 0
            }))
            .unwrap();
        assert_eq!(store.provider_usage_count("task-1").unwrap(), 1);
    }

    // ---- 목록 페이지네이션 ----

    /// 시각을 직접 지정해 태스크를 만든다. `created_at`과 `updated_at`을 **따로** 받는 이유는
    /// 둘이 갈라진 상태를 재현해야 하기 때문이다 — 실제 결함이 거기 있었다.
    fn seed_task(store: &mut Store, task_id: &str, created_at: &str, updated_at: &str) {
        store
            .create_task(task_id, "sess-1", "ws-1", "/tmp/ws", "verified", "msg")
            .unwrap();
        store
            .conn
            .execute(
                "UPDATE tasks SET created_at = ?2, updated_at = ?3 WHERE task_id = ?1",
                params![task_id, created_at, updated_at],
            )
            .unwrap();
    }

    /// 커서만으로 끝까지 넘긴 결과를 모은다 — 화면의 "더 보기"가 하는 일 그대로.
    fn page_through(store: &Store, limit: i64) -> Vec<String> {
        let mut seen = Vec::new();
        let mut cursor: Option<String> = None;
        // 상한을 두는 이유: 커서가 전진하지 않으면 테스트가 영원히 돈다.
        for _ in 0..50 {
            let rows = store.list_tasks(Some("/tmp/ws"), limit, cursor.as_deref()).unwrap();
            if rows.is_empty() {
                return seen;
            }
            let full = rows.len() as i64 == limit;
            let last = Store::cursor_for(rows.last().unwrap());
            seen.extend(rows.into_iter().map(|r| r.task_id));
            if !full {
                return seen;
            }
            cursor = Some(last);
        }
        panic!("커서가 전진하지 않아 페이지가 끝나지 않았습니다");
    }

    /// 시각이 같은 행이 여럿일 때 **어느 것도 사라지지 않아야** 한다.
    ///
    /// 시각 하나로만 자르면 마지막 행과 시각을 공유하는 행이 통째로 잘린다. 사용자에게
    /// 목록에서 사라진 작업은 없는 작업이므로, 이건 표시 문제가 아니라 데이터 손실로 읽힌다.
    #[test]
    fn list_tasks_paging_keeps_rows_that_share_a_timestamp() {
        let (_d, mut store) = seeded();
        // seeded()가 만든 task-1까지 포함해 7건이 **전부 같은 시각**을 갖게 한다.
        store
            .conn
            .execute(
                "UPDATE tasks SET created_at = '2030-01-01T00:00:00Z', updated_at = '2030-01-01T00:00:00Z'",
                [],
            )
            .unwrap();
        for i in 2..=7 {
            seed_task(
                &mut store,
                &format!("task-{i}"),
                "2030-01-01T00:00:00Z",
                "2030-01-01T00:00:00Z",
            );
        }

        let seen = page_through(&store, 2);
        let mut sorted = seen.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), seen.len(), "같은 행이 두 페이지에 나왔습니다: {seen:?}");
        assert_eq!(sorted.len(), 7, "페이지 경계에서 행이 사라졌습니다: {seen:?}");
    }

    /// 커서와 질의가 **같은 필드**를 봐야 한다.
    ///
    /// 이 테스트가 잡는 실제 결함: 한때 커서는 `created_at`으로 만들면서 질의는 `updated_at`으로
    /// 잘랐다. 두 값이 같은 동안에는 통과하므로 **일부러 반대 순서로** 만들어야만 드러난다.
    /// 정렬 키가 `created_at`으로 바뀐 지금도 같은 함정이 반대 방향으로 존재하므로 그대로 둔다.
    #[test]
    fn list_tasks_cursor_uses_the_same_field_the_query_orders_by() {
        let (_d, mut store) = seeded();
        // seeded()가 만든 task-1은 양쪽 기준 모두에서 가장 오래된 것으로 밀어둔다.
        store
            .conn
            .execute(
                "UPDATE tasks SET created_at = '2029-01-01T00:00:00Z', updated_at = '2029-01-01T00:00:00Z'
                 WHERE task_id = 'task-1'",
                [],
            )
            .unwrap();
        // created_at 오름차순과 updated_at 내림차순이 정확히 반대가 되도록 만든다.
        for i in 0..6 {
            seed_task(
                &mut store,
                &format!("p-{i}"),
                &format!("2030-01-0{}T00:00:00Z", i + 1),
                &format!("2030-02-0{}T00:00:00Z", 6 - i),
            );
        }

        let seen = page_through(&store, 2);
        assert_eq!(
            seen,
            vec!["p-5", "p-4", "p-3", "p-2", "p-1", "p-0", "task-1"],
            "페이지를 이어 붙인 순서가 created_at 내림차순과 다릅니다"
        );
    }

    /// **페이지 사이에 갱신된 작업이 목록에서 사라지지 않아야 한다** (3.8.1절).
    ///
    /// 이것이 종전에 "고치지 않은 것"으로 적혀 있던 결함이다. `updated_at`으로 정렬하면
    /// 아직 안 읽은 페이지에 있던 행이 커서 **위로** 올라가 어떤 페이지에도 나오지 않는다.
    /// 사용자에게 목록에서 사라진 작업은 없는 작업이다.
    ///
    /// 스냅샷 조회가 필요하다고 적어두었지만 필요한 것은 스냅샷이 아니라 **움직이지 않는
    /// 정렬 키**였다.
    #[test]
    fn list_tasks_does_not_drop_rows_updated_between_pages() {
        let (_d, mut store) = seeded();
        store
            .conn
            .execute(
                "UPDATE tasks SET created_at = '2030-01-09T00:00:00Z', updated_at = '2030-01-09T00:00:00Z'",
                [],
            )
            .unwrap();
        for i in 0..6 {
            let at = format!("2030-01-0{}T00:00:00Z", i + 1);
            seed_task(&mut store, &format!("p-{i}"), &at, &at);
        }

        // 1페이지를 읽는다.
        let first = store.list_tasks(Some("/tmp/ws"), 3, None).unwrap();
        assert_eq!(first.len(), 3);
        let cursor = Store::cursor_for(first.last().unwrap());

        // 그 사이 **아직 안 읽은** 작업 하나가 갱신된다 (phase 전이가 하는 일 그대로).
        store
            .conn
            .execute(
                "UPDATE tasks SET updated_at = '2031-12-31T00:00:00Z' WHERE task_id = 'p-0'",
                [],
            )
            .unwrap();

        let mut seen: Vec<String> = first.into_iter().map(|r| r.task_id).collect();
        let mut next = Some(cursor);
        while let Some(c) = next {
            let rows = store.list_tasks(Some("/tmp/ws"), 3, Some(&c)).unwrap();
            let full = rows.len() == 3;
            next = if full { Some(Store::cursor_for(rows.last().unwrap())) } else { None };
            seen.extend(rows.into_iter().map(|r| r.task_id));
        }

        assert!(seen.contains(&"p-0".to_string()), "갱신된 작업이 목록에서 사라졌습니다: {seen:?}");
        assert_eq!(seen.len(), 7, "행이 빠지거나 겹쳤습니다: {seen:?}");
    }

    /// 정렬 키가 **움직이지 않는다**는 것이 위 테스트의 전제다. 그 전제를 코드에서 확인한다 —
    /// production 경로가 `created_at`을 UPDATE하기 시작하면 페이징은 다시 조용히 깨진다.
    /// (테스트 fixture는 시각을 직접 심어야 하므로 `mod tests` 아래는 검사 대상이 아니다.)
    #[test]
    fn production_code_never_updates_the_sort_key() {
        let source = include_str!("store.rs");
        let production = source.split("mod tests").next().expect("mod tests 앞부분");
        // needle을 런타임에 조립한다 — 리터럴로 적으면 이 assertion 자체가 검사에 걸린다.
        let sort_key = format!("created_at{}", " =");
        let touched = format!("updated_at{}", " =");
        // UPDATE 문의 **대입부만** 본다. 컬럼 이름은 INSERT 목록과 SELECT에도 나오므로
        // 파일 전체에서 찾으면 언제나 걸린다.
        let assignments: Vec<&str> = production
            .split("UPDATE ")
            .skip(1)
            .map(|chunk| chunk.split("WHERE").next().unwrap_or(chunk))
            .collect();
        for stmt in &assignments {
            assert!(
                !stmt.contains(&sort_key),
                "production 경로가 created_at을 UPDATE합니다 — 정렬 키가 움직이면 3.8.1절이 무효가 됩니다: {stmt}"
            );
        }
        // 이 검사가 공허하지 않다는 것: 같은 방식으로 찾으면 updated_at 대입은 실제로 잡힌다.
        assert!(
            assignments.iter().any(|stmt| stmt.contains(&touched)),
            "UPDATE 문을 하나도 찾지 못했습니다 — 검사 방식이 아무것도 보지 않고 있습니다"
        );
    }

    /// 형식이 틀린 커서는 **오류**다. 처음부터 되읽으면 "더 보기"가 첫 페이지를 다시 붙이고,
    /// 사용자는 그걸 작업이 늘어난 것으로 읽는다 — 조용한 거짓말이 오류보다 나쁘다.
    #[test]
    fn list_tasks_rejects_malformed_cursor() {
        let (_d, store) = seeded();
        let err = store.list_tasks(None, 10, Some("2030-01-01T00:00:00Z")).unwrap_err();
        assert!(matches!(err, StoreError::InvalidCursor(_)), "예상과 다른 오류: {err:?}");
        // 정상 커서는 그대로 동작한다 — 위 거부가 모든 커서를 막는 것이 아님을 확인한다.
        let rows = store.list_tasks(None, 10, None).unwrap();
        let cursor = Store::cursor_for(rows.last().unwrap());
        assert!(store.list_tasks(None, 10, Some(&cursor)).is_ok());
    }

    // ---- WorkspaceIndex 캐시 ----

    fn index_payload(paths: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "workspaceId": "ws-1",
            "fileTree": paths.iter().map(|p| serde_json::json!({ "path": p })).collect::<Vec<_>>(),
            "projectMeta": {},
        })
    }

    /// **지문이 맞을 때만 준다.** 맞지 않는 인덱스를 주고 호출자가 판단하게 하면, 그 판단이
    /// 한 곳만 틀려도 낡은 파일 목록으로 모델을 부르게 된다.
    #[test]
    fn the_index_cache_only_answers_for_a_matching_fingerprint() {
        let (_d, store) = seeded();
        store
            .save_workspace_index("ws-1", "sha256:aaa", None, &index_payload(&["src/app.ts"]), Some(42))
            .unwrap();

        let hit = store.cached_workspace_index("ws-1", "sha256:aaa").unwrap();
        assert!(hit.is_some(), "지문이 같은데 캐시를 주지 않았습니다");
        assert_eq!(
            hit.as_ref().unwrap()["index"]["fileTree"][0]["path"],
            serde_json::json!("src/app.ts")
        );
        assert_eq!(hit.as_ref().unwrap()["buildMs"], serde_json::json!(42));

        assert!(
            store.cached_workspace_index("ws-1", "sha256:다름").unwrap().is_none(),
            "지문이 다른데 캐시를 줬습니다"
        );
        assert!(
            store.cached_workspace_index("ws-없음", "sha256:aaa").unwrap().is_none(),
            "다른 워크스페이스의 캐시를 줬습니다"
        );
    }

    /// **워크스페이스당 한 행이다.** 지문마다 쌓아두면 영원히 안 맞는 항목이 늘어나기만 한다.
    #[test]
    fn saving_again_replaces_the_row_instead_of_accumulating() {
        let (_d, store) = seeded();
        store
            .save_workspace_index("ws-1", "sha256:aaa", None, &index_payload(&["a.ts"]), Some(1))
            .unwrap();
        store
            .save_workspace_index("ws-1", "sha256:bbb", None, &index_payload(&["b.ts"]), Some(2))
            .unwrap();

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM workspace_index_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "지문마다 행이 쌓였습니다");
        // 옛 지문은 더 이상 맞지 않는다.
        assert!(store.cached_workspace_index("ws-1", "sha256:aaa").unwrap().is_none());
        assert!(store.cached_workspace_index("ws-1", "sha256:bbb").unwrap().is_some());
    }

    /// 저장된 값이 깨졌으면 **캐시가 없는 것으로 다룬다.** 캐시는 잃어도 되는 데이터이고,
    /// 깨진 값으로 오류를 올리면 고칠 수 없는 행 하나가 워크스페이스를 못 열게 만든다.
    #[test]
    fn a_corrupted_cache_row_reads_as_a_miss_not_an_error() {
        let (_d, store) = seeded();
        store
            .conn
            .execute(
                "INSERT INTO workspace_index_cache (workspace_id, fingerprint, git_head, payload_json, built_at, build_ms)
                 VALUES ('ws-1', 'sha256:aaa', NULL, '{ not json', '2030-01-01T00:00:00Z', 1)",
                [],
            )
            .unwrap();
        assert!(store.cached_workspace_index("ws-1", "sha256:aaa").unwrap().is_none());
    }

    /// v6 DB를 v7로 올려도 기존 데이터가 살아 있고, 캐시 테이블이 생긴다.
    /// **캐시는 비어 있는 채로 시작한다** — 마이그레이션이 지어낼 수 있는 값이 아니다.
    #[test]
    fn migration_from_v6_adds_an_empty_index_cache() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            for batch in [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6] {
                conn.execute_batch(batch).unwrap();
            }
            conn.pragma_update(None, "user_version", 6i64).unwrap();
            conn.execute(
                "INSERT INTO workspaces VALUES ('ws-1', '/tmp/ws', 'ws', '{}', '2020-01-01T00:00:00Z', NULL)",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&db, artifacts).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM workspace_index_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        // 기존 워크스페이스 행은 그대로다.
        let name: String = store
            .conn
            .query_row("SELECT name FROM workspaces WHERE workspace_id = 'ws-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name, "ws");
    }

    /// v7 DB를 v8로 올려도 **이미 정해진 기준은 그대로 유효하다.**
    ///
    /// 마이그레이션이 컬럼을 추가하면서 기존 행을 "거둔 것"으로 만들면, 앱을 새 버전으로
    /// 켠 순간 사용자가 정한 것이 조용히 사라진다 — 사용자에게는 판정이 증발한 것으로 보인다.
    #[test]
    fn migration_from_v7_leaves_existing_decisions_in_force() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        let artifacts = ArtifactStore::new(dir.path().join("artifacts")).unwrap();
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            for batch in [
                SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7,
            ] {
                conn.execute_batch(batch).unwrap();
            }
            conn.pragma_update(None, "user_version", 7i64).unwrap();
            conn.execute(
                "INSERT INTO workspaces VALUES ('ws-1', '/tmp/ws', 'ws', '{}', '2020-01-01T00:00:00Z', NULL)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (session_id, workspace_id, title, started_at) VALUES ('sess-1', 'ws-1', NULL, '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tasks (task_id, session_id, workspace_id, user_message, phase, counters_json, final_status, created_at, updated_at)
                 VALUES ('old-task', 'sess-1', 'ws-1', 'fix', 'COMPLETED', '{}', 'COMPLETED', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO acceptance_criteria (task_id, criterion_id, text, source, disagreement_id, decided_at)
                 VALUES ('old-task', 'c-1', '예전 판정', 'user_decision', NULL, '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&db, artifacts).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let carried = store.session_user_decisions("sess-1", "other").unwrap();
        assert_eq!(carried.len(), 1, "{carried:?}");
        assert_eq!(carried[0].text, "예전 판정");
        assert!(store.acceptance_criteria("old-task").unwrap()[0].withdrawn_at.is_none());
    }

    /// **철회는 이벤트를 지나야만 일어난다.** payload 키가 없으면 캐시는 그대로다 —
    /// 이벤트 없이 기준이 사라지는 길이 있으면 원칙 7이 무너진다.
    #[test]
    fn a_decision_is_only_withdrawn_through_an_event_payload() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &serde_json::json!({ "acceptanceCriteria": [{
                    "criterionId": "c-1", "text": "기준", "source": "user_decision",
                    "decidedAt": "2026-01-01T00:00:00Z",
                }] }),
            )
            .unwrap();

        // 철회 키가 없는 이벤트는 아무것도 거두지 않는다.
        store
            .append_event("task-1", "USER_DECISION_WITHDRAWN", &serde_json::json!({ "criterionId": "c-1" }))
            .unwrap();
        assert!(store.acceptance_criteria("task-1").unwrap()[0].withdrawn_at.is_none());

        store
            .append_event(
                "task-1",
                "USER_DECISION_WITHDRAWN",
                &serde_json::json!({
                    "withdrawnAt": "2026-02-02T00:00:00Z",
                    "acceptanceCriteriaWithdrawn": ["c-1"],
                }),
            )
            .unwrap();
        assert_eq!(
            store.acceptance_criteria("task-1").unwrap()[0].withdrawn_at.as_deref(),
            Some("2026-02-02T00:00:00Z")
        );
    }

    /// 거둘 것이 없는데 철회 이벤트가 오면 **오류다.** 조용히 넘기면 "철회했다고 적혀 있는데
    /// 여전히 나르는" 상태가 로그에 남고, 그 어긋남은 화면 어디에도 보이지 않는다.
    #[test]
    fn withdrawing_something_that_is_not_a_user_decision_fails_the_transaction() {
        let (_d, mut store) = seeded();
        store
            .append_event(
                "task-1",
                "USER_DECISION_RECORDED",
                &serde_json::json!({ "acceptanceCriteria": [{
                    "criterionId": "p-1", "text": "모델 후보", "source": "draft_proposal",
                    "decidedAt": "2026-01-01T00:00:00Z",
                }] }),
            )
            .unwrap();

        let err = store
            .append_event(
                "task-1",
                "USER_DECISION_WITHDRAWN",
                &serde_json::json!({
                    "withdrawnAt": "2026-02-02T00:00:00Z",
                    "acceptanceCriteriaWithdrawn": ["p-1"],
                }),
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Invariant(_)), "예상과 다른 오류: {err:?}");
        // **이벤트도 남지 않았다** — 트랜잭션째 되돌아가므로 로그와 캐시가 갈라지지 않는다.
        assert!(!store
            .event_types("task-1")
            .unwrap()
            .contains(&"USER_DECISION_WITHDRAWN".to_string()));
    }

    // ---- 화면에 뜨는 저장 계층 실패 ----

    /// **코드가 서로 달라야** 화면이 문장을 고를 수 있고, **원인은 파라미터로** 가야
    /// 어순이 다른 언어에서도 자리를 옮길 수 있다.
    #[test]
    fn every_store_op_has_its_own_code_and_carries_the_cause_as_a_parameter() {
        use crate::uimsg::UserFacing;
        let issues: Vec<StoreIssue> = StoreOp::ALL
            .iter()
            .map(|op| StoreIssue::new(op.clone(), "database is locked"))
            .collect();

        let codes: std::collections::BTreeSet<&str> = issues.iter().map(|i| i.code()).collect();
        assert_eq!(codes.len(), StoreOp::ALL.len(), "코드가 겹칩니다: {codes:?}");

        for issue in &issues {
            assert_eq!(issue.params()["detail"], serde_json::json!("database is locked"));
            // 원문에도 원인이 들어 있다 — 대체 표시용이지 화면이 파싱할 것이 아니다.
            assert!(issue.korean().contains("database is locked"), "{}", issue.korean());
            // 그리고 **무엇을 하려다 실패했는지**가 원문에 있어야 한다. 원인만 보여주면
            // 사용자는 할 수 있는 일이 없다.
            assert!(
                issue.korean().len() > "database is locked".len() + 2,
                "{}",
                issue.korean()
            );
        }
    }

    /// `StoreError`에서 바로 만들 수 있어야 한다 — 호출부가 문자열을 조립하기 시작하면
    /// 문장이 다시 껍데기로 새어 나간다.
    #[test]
    fn an_issue_can_be_built_from_a_store_error() {
        use crate::uimsg::UserFacing;
        let error = StoreError::Invariant("깨진 불변식".to_string());
        let issue = StoreIssue::new(StoreOp::ReadTasks, error);
        assert_eq!(issue.params()["detail"], serde_json::json!("깨진 불변식"));
        assert_eq!(issue.code(), "storeReadTasks");
    }
}
