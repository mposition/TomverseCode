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
pub const SCHEMA_VERSION: i64 = 3;

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
    pub fn acceptance_criteria(&self, task_id: &str) -> Result<Vec<AcceptanceCriterionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT criterion_id, text, source, disagreement_id, decided_at
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
                                         input_tokens, output_tokens, cost_usd, latency_ms, attempt, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
            ],
        )?;
        Ok(())
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
    pub fn record_cancellation_request(&mut self, task_id: &str, reason: &str) -> Result<Option<AppendedEvent>> {
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
        let appended = append_event_tx(
            &tx,
            &self.artifacts,
            task_id,
            "CANCELLATION_REQUESTED",
            &serde_json::json!({ "requestedAt": now, "reason": reason }),
        )?;
        tx.commit()?;
        Ok(Some(appended))
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

    /// 최근 작업 목록. `cursor`는 `updated_at` 값이며 그보다 오래된 것만 반환한다.
    pub fn list_tasks(&self, workspace_path: Option<&str>, limit: i64, cursor: Option<&str>) -> Result<Vec<TaskRow>> {
        let limit = limit.clamp(1, 200);
        let mut stmt = self.conn.prepare(
            "SELECT t.task_id, t.session_id, t.workspace_id, t.workspace_path, t.mode, t.user_message,
                    t.phase, t.final_status, t.error_summary, t.cancellation_requested_at,
                    (SELECT COUNT(DISTINCT path) FROM file_mutations m WHERE m.task_id = t.task_id),
                    t.created_at, t.updated_at
             FROM tasks t
             WHERE (?1 IS NULL OR t.workspace_path = ?1)
               AND (?2 IS NULL OR t.updated_at < ?2)
             ORDER BY t.updated_at DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![workspace_path, cursor, limit], map_task_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
                    requested_at, started_at, completed_at, duration_ms, error_summary
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
            }))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
    pub fn mutation_records(&self, task_id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, pre_existed, post_existed, rollback_status, rolled_back_at, recorded_at
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
/// `packages/sidecar/src/orchestrator/machine.ts`의 `TERMINAL_PHASES`와 함께 유지할 것.
///
/// `INTERRUPTED`는 M0.1에서 추가됐다: 앱이 비정상 종료된 태스크는 완료도 실패도 취소도 아니고,
/// **사용자가 되돌릴지 재실행할지 결정해야 하는 상태**다. 다른 터미널로 뭉뚱그리면 그 구별이 사라진다.
pub fn is_terminal_phase(phase: &str) -> bool {
    matches!(phase, "COMPLETED" | "FAILED" | "CANCELLED" | "REJECTED" | "INTERRUPTED")
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
        };
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::RequireUserApproval,
            risk_level: crate::types::RiskLevel::Medium,
            matched_rule: "allow:npm test".into(),
            reason: "1클릭 승인".into(),
            requires_user_approval: true,
            normalized_target: "npm test".into(),
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
        };
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::AutoApprove,
            risk_level: crate::types::RiskLevel::Low,
            matched_rule: "t".into(),
            reason: "t".into(),
            requires_user_approval: false,
            normalized_target: "src/a.ts".into(),
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
        };
        let decision = PolicyDecision {
            request_id: "r1".into(),
            decision: crate::types::Decision::AutoApprove,
            risk_level: crate::types::RiskLevel::None,
            matched_rule: "read_only".into(),
            reason: "ok".into(),
            requires_user_approval: false,
            normalized_target: "a".into(),
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
}
