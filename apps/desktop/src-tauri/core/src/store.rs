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
pub const SCHEMA_VERSION: i64 = 1;

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
    pub fn create_task(
        &mut self,
        task_id: &str,
        session_id: &str,
        workspace_id: &str,
        user_message: &str,
    ) -> Result<AppendedEvent> {
        let now = now_iso();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO tasks (task_id, session_id, workspace_id, user_message, phase, counters_json,
                                final_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'CREATED', ?5, NULL, ?6, ?6)",
            params![
                task_id,
                session_id,
                workspace_id,
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
            &serde_json::json!({ "userMessage": user_message }),
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
        let appended = append_event_tx(&tx, &self.artifacts, task_id, event_type, payload)?;

        if event_type == "PHASE_CHANGED" {
            let to = payload
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or_else(|| StoreError::Invariant("PHASE_CHANGED payload에 \"to\"가 없음".to_string()))?;
            tx.execute(
                "UPDATE tasks SET phase = ?1, updated_at = ?2 WHERE task_id = ?3",
                params![to, now_iso(), task_id],
            )?;
            if matches!(to, "COMPLETED" | "FAILED" | "CANCELLED" | "REJECTED") {
                let final_status = to.to_ascii_lowercase();
                tx.execute(
                    "UPDATE tasks SET final_status = ?1 WHERE task_id = ?2",
                    params![final_status, task_id],
                )?;
            }
        }

        if let Some(counters) = payload.get("counters") {
            tx.execute(
                "UPDATE tasks SET counters_json = ?1, updated_at = ?2 WHERE task_id = ?3",
                params![serde_json::to_string(counters)?, now_iso(), task_id],
            )?;
        }

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
            "SELECT event_id, seq, event_type, payload_json, created_at
             FROM task_events WHERE task_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok(StoredEvent {
                event_id: r.get(0)?,
                seq: r.get(1)?,
                event_type: r.get(2)?,
                payload: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(serde_json::Value::Null),
                created_at: r.get(4)?,
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
                                        requested_by, policy_decision, policy_reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
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

    /// 재시작 복구(7절): `final_status IS NULL`인 태스크를 찾는다.
    pub fn unfinished_tasks(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, phase FROM tasks WHERE final_status IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// 트랜잭션 안에서의 이벤트 삽입. `seq`는 (task_id, seq) unique 제약과 함께 순번을 보장한다.
fn append_event_tx(
    tx: &Transaction<'_>,
    artifacts: &ArtifactStore,
    task_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> std::result::Result<AppendedEvent, StoreError> {
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
        "INSERT INTO task_events (task_id, seq, event_type, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task_id, next_seq, event_type, stored_payload, now_iso()],
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
        store.create_task("task-1", "sess-1", "ws-1", "fix the bug").unwrap();
        (dir, store)
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
        assert_eq!(store.task_final_status("task-1").unwrap().as_deref(), Some("completed"));
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
