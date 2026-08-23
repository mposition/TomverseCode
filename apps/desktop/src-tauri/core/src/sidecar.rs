//! Node sidecar와의 로컬 IPC (stdio + NDJSON).
//!
//! docs/design/process-architecture.md 3절. 이 구현은 tokio를 쓰지 않고 std 스레드만 쓴다 —
//! 코어 크레이트가 비동기 런타임에 묶이지 않아야 Tauri(비동기)와 헤드리스 호스트(동기)가
//! 같은 코드를 공유할 수 있다.
//!
//! 방향이 양쪽이라는 점이 중요하다: Rust가 `task.start`를 보내고, 그 처리 중에 Node가
//! `tool.execute`를 되묻는다. 그래서 요청 디스패치가 양방향으로 동작해야 한다.

use crate::time::now_iso;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Node → Rust 한 줄의 최대 바이트 (process-architecture.md 3.1절).
///
/// # 왜 상한이 필요한가 — 성능이 아니라 신뢰 경계다
///
/// 종전 구현은 `BufReader::lines()`였다. 그건 줄바꿈이 나올 때까지 **무한히** 버퍼를 키우므로,
/// Node가 줄바꿈 없이 계속 쓰면 **신뢰 경계 프로세스가 메모리를 다 쓴다.** 원칙 2는 "Node가
/// 완전히 장악당해도 Rust 게이트를 반드시 통과해야 한다"고 말하는데, 게이트에 도달하기 전에
/// 게이트가 죽으면 그 문장은 성립하지 않는다. 문서가 이 항목을 "파싱을 느리게 만들 가능성"으로
/// 적어둔 것은 문제의 성질을 잘못 짚은 것이다.
///
/// # 왜 32 MiB인가
///
/// 정당한 메시지가 크다. Node → Rust 방향에는 초안 patch가 실린 `db.appendEvent`가 있고,
/// 다중 파일 patch는 수 MB가 될 수 있다. 상한을 작게 잡으면 **정상 작업이 프로토콜 위반으로
/// 죽는다.** 반대로 이보다 큰 한 줄은 코딩 에이전트의 IPC 메시지로 설명되지 않는다.
///
/// **유도하지 못한 상수다.** 실사용 메시지 크기 분포를 재기 전까지는 관측이 아니라 판단이다.
pub const MAX_IPC_LINE_BYTES: usize = 32 * 1024 * 1024;

/// 관측 구간의 경계(바이트, 상한 포함). **32 MiB까지 펼친다** — 답해야 하는 질문이
/// "실제 트래픽이 상한에서 얼마나 먼가"이므로, 상한 근처가 비어 있다는 사실 자체가 답이다.
pub const IPC_LINE_BUCKET_LIMITS: [u64; 5] = [
    1024,            // 1 KiB — 대부분의 제어 메시지
    64 * 1024,       // 64 KiB
    1024 * 1024,     // 1 MiB
    8 * 1024 * 1024, // 8 MiB
    MAX_IPC_LINE_BYTES as u64,
];

/// 한 구간의 관측 수.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IpcLineBucket {
    /// 이 구간의 상한(바이트, 포함).
    #[serde(rename = "upToBytes")]
    pub up_to_bytes: u64,
    pub lines: u64,
}

/// 관측 구간 동안 **Node → Rust**로 들어온 한 줄들의 크기 분포.
///
/// # 왜 이 방향만 재는가
///
/// 상한(`MAX_IPC_LINE_BYTES`)이 이 방향에만 있다. 그 상한이 신뢰 경계를 지키는 장치이기
/// 때문이다(원칙 2) — 반대 방향은 우리가 보내는 것이라 같은 위협이 없다. **답해야 하는
/// 질문은 "그 상한이 맞는가"이므로 상한이 있는 방향을 잰다.**
///
/// # 왜 최댓값만이 아니라 분포인가
///
/// 최댓값 하나로는 "3 MiB짜리가 한 번 있었다"와 "3 MiB짜리가 늘 온다"를 구별할 수 없는데,
/// 상한을 낮출 수 있는지는 그 구별에 달려 있다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IpcLineSizes {
    /// 관측한 줄 수. 0이면 아래 값들은 아무것도 말하지 않는다.
    pub lines: u64,
    /// 가장 큰 줄(바이트). **상한을 판단하는 값이다.**
    #[serde(rename = "maxBytes")]
    pub max_bytes: u64,
    pub buckets: Vec<IpcLineBucket>,
}

/// 관측한 줄 크기를 꺼내오는 쪽.
///
/// 트레이트로 두는 이유: `TaskHost`가 `SidecarClient`를 알지 않아야 한다. 호스트는 sidecar가
/// 보내는 요청을 **받는** 쪽이고 클라이언트를 소유하지 않는다.
pub trait IpcLineMeter: Send + Sync {
    /// 직전 호출 이후 관측한 것을 돌려주고 **비운다.**
    ///
    /// 누적이 아니라 구간인 이유: 태스크마다 남기려면 그 태스크의 몫이어야 하는데, 누적값을
    /// 남기면 뒤 태스크일수록 커지기만 해서 분포가 아니라 순번을 재게 된다. **구간의 경계는
    /// 태스크 경계와 정확히 같지 않다** — v1은 워크스페이스당 한 번에 한 태스크만 돌리므로
    /// 실제로는 일치하지만, 그 전제가 깨지면 이 값은 "직전 take 이후"일 뿐이다.
    fn take_line_sizes(&self) -> IpcLineSizes;
}

/// 한 줄을 읽은 결과.
///
/// `Oversized`와 `InvalidUtf8`을 **다른 값으로 두는 것이 이 타입의 요점이다.** 둘 다 "이 줄을
/// 쓸 수 없다"이지만 그 다음이 다르다:
///
/// - `InvalidUtf8`은 줄이 **완결됐다** — 줄바꿈까지 읽었으므로 프레임 동기가 살아 있고, 그 줄만
///   버리면 다음 줄부터 정상이다. 파싱 불가한 JSON을 무시하는 것과 같은 처리를 한다.
/// - `Oversized`는 줄이 **완결되지 않았다** — 상한까지 읽고 멈췄으므로 그 줄의 나머지가 스트림에
///   남아 있고, 다음에 읽는 "줄"은 앞 메시지의 꼬리다. **프레임 동기를 잃은 상태에서 계속
///   파싱하는 것은 멈추는 것보다 나쁘다.**
#[derive(Debug, PartialEq, Eq)]
pub enum FramedLine {
    Line(String),
    /// 상한을 넘겨 줄을 완결하지 못했다. 읽은 바이트 수를 함께 준다 — 사유를 사람이 읽을 때
    /// "얼마나 컸나"가 없으면 상한을 조정할 근거가 없다.
    Oversized {
        bytes: usize,
    },
    /// 줄은 완결됐지만 UTF-8이 아니다.
    InvalidUtf8 {
        bytes: usize,
    },
    Eof,
    ReadError(String),
}

/// NDJSON 한 줄을 **상한 안에서** 읽는다.
///
/// `BufRead::read_until`은 상한이 없으므로 `take`로 감싸 이번 호출이 읽을 수 있는 바이트를
/// 묶는다. `max_bytes + 1`을 허용하는 이유: 정확히 `max_bytes`인 줄은 정당하므로, 초과를
/// **판정하려면** 한 바이트를 더 볼 수 있어야 한다.
pub fn read_framed_line<R: BufRead>(reader: R, max_bytes: usize) -> FramedLine {
    let mut buf: Vec<u8> = Vec::new();
    // **리더를 값으로 받는다.** `take`가 값을 가져가므로, 호출자는 `&mut BufReader<...>`를
    // 넘긴다 — 그러면 이 호출이 소비하는 것은 차용이고 리더 자체는 다음 줄을 위해 남는다.
    let read = reader.take(max_bytes as u64 + 1).read_until(b'\n', &mut buf);
    match read {
        Err(e) => FramedLine::ReadError(e.to_string()),
        Ok(0) => FramedLine::Eof,
        Ok(n) => {
            // 줄바꿈으로 끝나지 않았는데 상한을 넘겼다면 줄이 완결되지 않은 것이다.
            // 줄바꿈 없이 끝난 **마지막** 줄(EOF)은 정당하므로 두 경우를 구별해야 한다.
            if n > max_bytes && buf.last() != Some(&b'\n') {
                return FramedLine::Oversized { bytes: n };
            }
            while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                buf.pop();
            }
            match String::from_utf8(buf) {
                Ok(line) => FramedLine::Line(line),
                Err(_) => FramedLine::InvalidUtf8 { bytes: n },
            }
        }
    }
}

/// **우리가 프로토콜 위반으로 닫았다**는 표시.
///
/// 재spawn 판정이 이 표시를 본다. 위반으로 닫은 연결을 다시 띄우면 같은 위반을 반복할 뿐이고,
/// 그게 공격이라면 재시도가 곧 협조다 — 크래시(우리가 닫지 않았는데 끊긴 것)와 구별해야 한다.
pub const PROTOCOL_VIOLATION_PREFIX: &str = "[protocol] ";

/// Node가 Rust에 보낸 요청을 처리하는 쪽. host가 구현한다.
pub trait SidecarHandler: Send + Sync {
    /// `tool.execute`, `db.appendEvent`, `verify.run` 등
    fn handle_request(&self, method: &str, params: &Value) -> Result<Value, String>;
    /// Node가 발행한 이벤트 (응답 없음) — UI 릴레이 + 이벤트 로그
    fn handle_event(&self, task_id: &str, event: &Value);
    /// spawn 직후 클라이언트가 **자기 계측기를 건넨다.** 기본은 무시한다.
    ///
    /// # 왜 여기서 건네는가
    ///
    /// 진입점이 둘이다(Tauri 껍데기, 헤드리스 호스트). 각자 배선하면 반드시 갈라지고,
    /// 이 저장소는 그 갈라짐을 이미 한 번 겪었다(CLAUDE.md의 `_env.bat` 기록).
    /// 둘 다 handler를 넘기므로 **넘기는 그 자리에서** 붙이면 한 곳이 된다.
    ///
    /// # 왜 `Weak`인가
    ///
    /// 클라이언트는 handler를 `Arc`로 들고 있다. handler가 클라이언트를 `Arc`로 되잡으면
    /// **순환 참조가 되어 둘 다 영원히 해제되지 않는다.** 리더 스레드가 `Arc::downgrade`를
    /// 쓰는 것과 같은 이유다.
    fn attach_ipc_meter(&self, _meter: std::sync::Weak<dyn IpcLineMeter>) {}
}

pub struct SidecarClient {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
    child: Mutex<Option<Child>>,
    /// sidecar stdout이 EOF에 도달했는지 (프로세스 종료)
    closed: Arc<AtomicBool>,
    /// 왜 닫혔는지. **정상 종료와 프로토콜 위반을 같은 문장으로 보고하지 않기 위해** 있다.
    close_reason: Arc<Mutex<Option<String>>>,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// 관측한 줄 크기(process-architecture.md 3.1절 — 32 MiB가 맞는 값인지 재는 자리).
    ///
    /// 리더 스레드가 쓰고 태스크가 끝날 때 읽어 비운다. **락이 아니라 atomic인 이유**:
    /// 모든 줄마다 지나는 자리라 여기서 락을 잡으면 계측이 측정 대상을 바꾼다.
    line_sizes: Arc<LineSizeCounters>,
}

/// 리더 스레드가 줄마다 올리는 계수기.
#[derive(Default)]
struct LineSizeCounters {
    lines: AtomicU64,
    max_bytes: AtomicU64,
    buckets: [AtomicU64; IPC_LINE_BUCKET_LIMITS.len()],
}

impl LineSizeCounters {
    fn observe(&self, bytes: u64) {
        self.lines.fetch_add(1, Ordering::Relaxed);
        self.max_bytes.fetch_max(bytes, Ordering::Relaxed);
        // 상한을 넘는 줄은 `Line`이 되지 못하므로 마지막 구간이 언제나 받아준다.
        let index = IPC_LINE_BUCKET_LIMITS
            .iter()
            .position(|limit| bytes <= *limit)
            .unwrap_or(IPC_LINE_BUCKET_LIMITS.len() - 1);
        self.buckets[index].fetch_add(1, Ordering::Relaxed);
    }

    fn take(&self) -> IpcLineSizes {
        IpcLineSizes {
            lines: self.lines.swap(0, Ordering::Relaxed),
            max_bytes: self.max_bytes.swap(0, Ordering::Relaxed),
            buckets: IPC_LINE_BUCKET_LIMITS
                .iter()
                .zip(self.buckets.iter())
                .map(|(limit, count)| IpcLineBucket {
                    up_to_bytes: *limit,
                    lines: count.swap(0, Ordering::Relaxed),
                })
                .collect(),
        }
    }
}

impl IpcLineMeter for SidecarClient {
    fn take_line_sizes(&self) -> IpcLineSizes {
        self.line_sizes.take()
    }
}

pub struct SpawnConfig {
    /// `node` 실행 파일 (또는 번들된 sidecar 바이너리)
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: Option<std::path::PathBuf>,
    /// sidecar에 주입할 환경변수. **API 키가 여기로 들어간다** —
    /// 자격증명은 Rust가 보유하고 Node는 프로세스 시작 시 1회 주입받아 메모리에만 둔다
    /// (process-architecture.md 2절).
    pub env: Vec<(String, String)>,
}

impl SidecarClient {
    pub fn spawn(config: SpawnConfig, handler: Arc<dyn SidecarHandler>) -> std::io::Result<Arc<Self>> {
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr는 sidecar 로그 전용 — NDJSON 프로토콜과 섞이지 않는다.
            .stderr(Stdio::inherit());
        if let Some(dir) = &config.working_dir {
            command.current_dir(dir);
        }
        for (k, v) in &config.env {
            command.env(k, v);
        }

        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("sidecar stdin should be piped");
        let stdout = child.stdout.take().expect("sidecar stdout should be piped");

        let pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let close_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let line_sizes = Arc::new(LineSizeCounters::default());

        let client = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            child: Mutex::new(Some(child)),
            closed: closed.clone(),
            close_reason: close_reason.clone(),
            reader: Mutex::new(None),
            line_sizes: line_sizes.clone(),
        });

        // 계측기를 handler에 건넨다. **약한 참조다** — 위 트레이트 주석 참조.
        handler.attach_ipc_meter(Arc::downgrade(&client) as std::sync::Weak<dyn IpcLineMeter>);

        let reader_client = Arc::downgrade(&client);
        let reason_slot = close_reason.clone();
        let reader_sizes = line_sizes.clone();
        let reader = std::thread::spawn(move || {
            let mut buffered = BufReader::new(stdout);
            // **종료 사유를 갖고 나간다.** 종전에는 어떤 이유로 끝나든 대기 중인 요청이
            // "sidecar가 응답 전에 종료됨"을 받았다. 프로토콜 위반과 정상 종료가 같은 문장으로
            // 보고되면, 사용자는 고칠 수 있는 것(상한)과 고칠 수 없는 것(크래시)을 구별하지 못한다.
            let mut exit_reason: Option<String> = None;
            loop {
                let line = match read_framed_line(&mut buffered, MAX_IPC_LINE_BYTES) {
                    FramedLine::Line(line) => line,
                    FramedLine::Eof => break,
                    FramedLine::InvalidUtf8 { bytes } => {
                        // 줄은 완결됐으므로 프레임 동기가 살아 있다 — 파싱 불가한 JSON과 같이
                        // 그 줄만 버린다. 그 줄이 응답이었다면 해당 요청은 타임아웃으로 끝난다.
                        eprintln!("[sidecar] UTF-8이 아닌 {bytes}바이트 줄을 버립니다");
                        continue;
                    }
                    FramedLine::Oversized { bytes } => {
                        // **여기서 멈춘다.** 줄이 완결되지 않았으므로 그 나머지가 스트림에 남아
                        // 있고, 다음에 읽는 것은 앞 메시지의 꼬리다. 동기를 잃은 스트림을 계속
                        // 파싱하면 우리가 해석하는 "메시지"는 아무것도 보장하지 않는다.
                        //
                        // 줄바꿈까지 버려 동기를 되찾는 방법도 있지만 그렇게 하지 않는다:
                        // 32 MiB를 넘는 한 줄은 정상 상태가 아니고, 정상 아닌 것을 조용히
                        // 회복하는 것이 그 상태를 오래 남기는 방식이다.
                        exit_reason = Some(format!(
                            "{PROTOCOL_VIOLATION_PREFIX}sidecar가 한 줄에 {bytes}바이트를 보냈습니다 (상한 {MAX_IPC_LINE_BYTES}).                              프로토콜 위반이므로 연결을 닫습니다."
                        ));
                        break;
                    }
                    FramedLine::ReadError(message) => {
                        exit_reason = Some(format!("sidecar stdout 읽기 실패: {message}"));
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                // **파싱 전에 잰다.** 파싱 불가한 줄도 상한을 지나온 줄이고, 상한이 맞는지를
                // 묻는 질문에는 그것도 관측이다.
                reader_sizes.observe(line.len() as u64);

                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    // 파싱 불가한 줄은 무시한다 (packages/sidecar transport.ts와 동일 원칙).
                    continue;
                };
                match msg.get("kind").and_then(Value::as_str) {
                    Some("response") => {
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        let outcome = if msg.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(msg
                                .get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("unknown sidecar error")
                                .to_string())
                        };
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(outcome);
                        }
                    }
                    Some("request") => {
                        // Node → Rust 요청. 신뢰 경계를 넘는 지점이므로 handler가 전부 재검증한다.
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        let method = msg
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        let response = match handler.handle_request(&method, &params) {
                            Ok(result) => json!({ "kind": "response", "id": id, "ok": true, "result": result }),
                            Err(message) => json!({
                                "kind": "response", "id": id, "ok": false,
                                "error": { "code": "HOST_ERROR", "message": message }
                            }),
                        };
                        if let Some(c) = reader_client.upgrade() {
                            let _ = c.write_raw(&response);
                        }
                    }
                    Some("event") => {
                        let task_id = msg.get("taskId").and_then(Value::as_str).unwrap_or_default();
                        let event = msg.get("event").cloned().unwrap_or(Value::Null);
                        handler.handle_event(task_id, &event);
                    }
                    _ => {}
                }
            }
            // 여기 오는 경로는 셋이다: EOF(정상 종료), 프로토콜 위반, 읽기 실패.
            // 대기 중인 요청을 전부 깨워야 호출자가 영원히 블록되지 않는다.
            let message = exit_reason.unwrap_or_else(|| "sidecar가 응답 전에 종료됨".to_string());
            if let Ok(mut slot) = reason_slot.lock() {
                *slot = Some(message.clone());
            }
            closed.store(true, Ordering::SeqCst);
            let mut guard = pending.lock().unwrap();
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err(message.clone()));
            }
        });

        *client.reader.lock().unwrap() = Some(reader);
        Ok(client)
    }

    fn write_raw(&self, msg: &Value) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "sidecar stdin lock poisoned".to_string())?;
        let line = format!("{msg}\n");
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("sidecar stdin 쓰기 실패: {e}"))?;
        stdin.flush().map_err(|e| format!("sidecar stdin flush 실패: {e}"))
    }

    /// Rust → Node 요청. `timeout`이 지나면 대기를 포기한다 (상한 없는 대기를 만들지 않는다).
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            // **왜 닫혔는지를 함께 말한다.** "실행 중이 아님"만 보고하면 프로토콜 위반으로
            // 우리가 닫은 것과 sidecar가 죽은 것이 같은 문장이 되고, 사용자는 고칠 수 있는
            // 것과 고칠 수 없는 것을 구별하지 못한다.
            return Err(match self.close_reason() {
                Some(reason) => format!("sidecar가 실행 중이 아님: {reason}"),
                None => "sidecar가 실행 중이 아님".to_string(),
            });
        }
        let id = format!("rust-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        self.write_raw(&json!({ "kind": "request", "id": id, "method": method, "params": params }))?;

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "sidecar 요청 {method:?}가 {}초 후 타임아웃됨",
                    timeout.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.pending.lock().unwrap().remove(&id);
                Err("sidecar가 응답 전에 종료됨".to_string())
            }
        }
    }

    /// `ready` 이벤트가 아니라 `ping` 왕복으로 준비 여부를 확인한다 —
    /// 이벤트는 handler로 흘러가므로 여기서 관측할 수 없다.
    pub fn wait_ready(&self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let mut last_error = String::new();
        while Instant::now() < deadline {
            match self.request("ping", json!({}), Duration::from_millis(500)) {
                Ok(v) => return Ok(v),
                Err(e) => {
                    last_error = e;
                    if self.closed.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        Err(format!("sidecar가 준비되지 않음: {last_error}"))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 닫힌 사유. 아직 열려 있으면 `None`이다.
    pub fn close_reason(&self) -> Option<String> {
        self.close_reason.lock().ok().and_then(|g| g.clone())
    }

    /// 정상 종료 (process-architecture.md 5절): shutdown 요청 → 응답 대기 → 강제 종료.
    pub fn shutdown(&self, grace: Duration) {
        let _ = self.request("shutdown", json!({ "at": now_iso() }), grace);
        // stdin을 닫으면 Node 쪽 readline이 EOF를 받고 자연 종료한다.
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                let deadline = Instant::now() + grace;
                loop {
                    match c.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() >= deadline => {
                            let _ = c.kill();
                            let _ = c.wait();
                            break;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                        Err(_) => break,
                    }
                }
            }
        }
    }
}

impl Drop for SidecarClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

/// 워크스페이스 하나가 쓰는 sidecar를 **감독한다** (process-architecture.md 5절).
///
/// # 재spawn이 태스크를 살리지는 못한다
///
/// Node가 죽으면 그 안에 있던 Orchestrator 상태도 함께 사라진다. 새 프로세스는 그 태스크를
/// 모르므로, 재spawn이 하는 일은 **다음 태스크가 가능해지는 것**뿐이다. 진행 중이던 태스크는
/// 재시작 복구 절차와 같이 처리된다(7절) — 그게 5절 표가 두 문장으로 적어둔 이유다.
///
/// 그런데 종전에는 그 "다음"도 없었다: 한 번 닫히면 `closed`가 영원히 true라 워크스페이스를
/// 다시 열기 전까지 모든 요청이 실패했다. 사용자에게는 **앱이 죽은 것처럼 보인다.**
///
/// # 상한은 워크스페이스 세션당이다
///
/// 원칙 5는 모든 루프에 상한을 요구한다. "성공하면 리셋"은 상한이 아니다 — 태스크마다 한 번씩
/// 죽는 sidecar가 영원히 재spawn된다. 그래서 카운터는 **워크스페이스를 여는 동안 누적**되고,
/// 리셋하는 유일한 방법은 사용자가 다시 여는 것이다. 사람을 루프 안에 둔다.
///
/// # 프로토콜 위반은 재spawn하지 않는다
///
/// 우리가 위반으로 닫은 연결을 다시 띄우면 같은 위반을 반복할 뿐이고, 그게 공격이라면
/// 재시도가 곧 협조다. 크래시(우리가 닫지 않았는데 끊긴 것)만 재spawn 대상이다.
pub struct SidecarSupervisor {
    factory: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync>,
    client: Mutex<Arc<SidecarClient>>,
    respawns: AtomicU64,
    max_respawns: u64,
}

/// 재spawn을 하지 않기로 한 이유. **"안 했다"만 알면 사용자는 왜인지 모른다.**
#[derive(Debug, PartialEq, Eq)]
pub enum RespawnOutcome {
    /// sidecar가 살아 있어 할 일이 없었다.
    Alive,
    /// 새로 띄웠다. 몇 번째인지 함께 준다.
    Respawned { attempt: u64 },
    /// 상한에 도달했다.
    LimitReached { attempts: u64 },
    /// 프로토콜 위반으로 우리가 닫았다 — 다시 띄우면 반복될 뿐이다.
    ProtocolViolation { reason: String },
    /// 다시 띄우려 했으나 spawn 자체가 실패했다.
    SpawnFailed { attempt: u64, error: String },
}

/// 워크스페이스 세션 하나에서 허용하는 재spawn 횟수 (5절 표의 "최대 2회").
pub const MAX_SIDECAR_RESPAWNS: u64 = 2;

/// 사용자가 무엇을 할 수 있는가.
///
/// **버튼을 줄지 말지를 화면이 문장에서 읽어내게 두지 않는다.** 안내를 한국어 문장으로만
/// 주면 화면은 그 문장을 문자열로 비교해야 하고, 문구를 다듬는 순간 버튼이 사라진다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Recovery {
    /// 워크스페이스를 다시 열면 감독자가 새로 만들어지고 재spawn 상한이 초기화된다.
    ReopenWorkspace,
    /// 다시 열어도 달라지지 않는다. **버튼을 주지 않는다** — 눌러도 같은 결과가 나오는
    /// 버튼은 목록이 전진하지 않는 "더 보기"와 같은 종류의 거짓말이다.
    None,
}

/// 사용자에게 알려야 하는 백엔드 문제.
///
/// # 왜 문장이 아니라 이 타입인가
///
/// **화면에 그대로 뜨는 문장은 프로세스 경계를 넘지 않는다** — 판정과 파라미터가 넘고 문장은
/// 화면이 만든다(ui-wireframes.md 6절). 문장을 넘기면 그 문장은 영원히 한국어이고, 다국어
/// 카탈로그를 만들어도 **카탈로그 밖에 남는다.** 그러면 언어를 바꿔도 절반만 바뀐다.
///
/// 같은 규칙을 이미 한 번 적용했다: "다시 열기" 버튼을 띄울지를 화면이 문장에서 읽어내지
/// 않게 `recovery`를 값으로 줬다(5.2절). 문장 자체도 같은 이유로 값이 되어야 한다.
///
/// `korean()`을 남겨 두는 이유: 로그와 **화면이 모르는 코드의 대체 표시**다. 화면이 새 코드를
/// 아직 모를 때 빈 문장을 그리는 것보다, 번역되지 않은 원문을 그리는 편이 낫다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendIssue {
    /// 재spawn 상한에 도달했다.
    RespawnLimit { attempts: u64 },
    /// 프로토콜 위반으로 우리가 닫았다.
    ProtocolViolation { reason: String },
    /// 다시 띄우려 했으나 spawn이 실패했다.
    SpawnFailed { attempt: u64, max: u64, error: String },
}

impl crate::uimsg::UserFacing for BackendIssue {
    /// 화면이 문장을 고르는 열쇠. **이 값이 바뀌면 화면의 카탈로그도 바뀌어야 한다.**
    fn code(&self) -> &'static str {
        match self {
            BackendIssue::RespawnLimit { .. } => "respawnLimit",
            BackendIssue::ProtocolViolation { .. } => "protocolViolation",
            BackendIssue::SpawnFailed { .. } => "spawnFailed",
        }
    }

    /// 문장에 끼워 넣을 값들. **문자열로 이어 붙이지 않는다** — 언어마다 어순이 다르므로,
    /// 이미 이어 붙인 문장은 번역할 수 없다.
    fn params(&self) -> Value {
        match self {
            BackendIssue::RespawnLimit { attempts } => json!({ "attempts": attempts }),
            BackendIssue::ProtocolViolation { reason } => json!({ "reason": reason }),
            BackendIssue::SpawnFailed { attempt, max, error } => {
                json!({ "attempt": attempt, "max": max, "error": error })
            }
        }
    }

    /// 원문(한국어). 로그와 **화면이 모르는 코드의 대체 표시**에 쓴다.
    fn korean(&self) -> String {
        match self {
            BackendIssue::RespawnLimit { attempts } => {
                format!("백엔드가 {attempts}번 다시 시작한 뒤에도 계속 종료됩니다.")
            }
            BackendIssue::ProtocolViolation { reason } => format!(
                "백엔드와의 통신이 프로토콜 위반으로 끊겼습니다. 다시 시작하지 않습니다 — 같은 위반이 반복될 뿐입니다. ({reason})"
            ),
            BackendIssue::SpawnFailed { attempt, max, error } => {
                format!("백엔드를 다시 시작할 수 없습니다 ({attempt}/{max}): {error}")
            }
        }
    }
}

impl BackendIssue {
    /// 사용자가 무엇을 할 수 있는가. **판정은 문제 종류가 정한다** — 화면이 고르지 않는다.
    pub fn recovery(&self) -> Recovery {
        match self {
            BackendIssue::RespawnLimit { .. } | BackendIssue::SpawnFailed { .. } => Recovery::ReopenWorkspace,
            // 다시 열어도 같은 위반이 반복된다.
            BackendIssue::ProtocolViolation { .. } => Recovery::None,
        }
    }
}

/// 감독자의 **현재** 상태. `ensure_alive`와 달리 아무것도 바꾸지 않는다.
///
/// 세 값인 이유: "죽어 있다"가 곧 "사용자가 개입해야 한다"는 아니다. 상한이 남아 있으면
/// 다음 태스크 시작 시 자동으로 다시 뜨므로 **사용자가 할 일이 없다.** 둘을 한 값으로 합치면
/// 화면이 필요 없는 조치를 요구하게 된다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SupervisorStatus {
    Alive,
    /// 죽어 있지만 다음 태스크에서 자동으로 다시 뜬다.
    WillRespawn {
        remaining: u64,
    },
    /// 사용자가 개입해야 한다.
    ///
    /// **문장 대신 코드와 파라미터를 준다.** `message`는 화면이 그 코드를 아직 모를 때의
    /// 대체 표시이지 화면이 쓸 기본값이 아니다.
    Unavailable {
        code: String,
        params: Value,
        message: String,
        recovery: Recovery,
    },
}

impl SupervisorStatus {
    fn unavailable(issue: BackendIssue) -> Self {
        use crate::uimsg::UserFacing;
        let ui = issue.ui();
        SupervisorStatus::Unavailable {
            code: ui.code,
            params: ui.params,
            message: ui.message,
            recovery: issue.recovery(),
        }
    }
}

impl RespawnOutcome {
    /// 실패했다면 그 문제. 성공이면 `None`.
    ///
    /// **한 곳에서 나와야 조회 경로(`status`)와 실행 경로가 갈라지지 않는다.** 그리고 Tauri
    /// 껍데기 크레이트는 이 개발 환경에서 컴파일되지 않으므로, 거기 남는 판정은 검증되지 않는다.
    pub fn failure(&self) -> Option<BackendIssue> {
        match self {
            RespawnOutcome::Alive | RespawnOutcome::Respawned { .. } => None,
            RespawnOutcome::LimitReached { attempts } => Some(BackendIssue::RespawnLimit { attempts: *attempts }),
            RespawnOutcome::ProtocolViolation { reason } => {
                Some(BackendIssue::ProtocolViolation { reason: reason.clone() })
            }
            RespawnOutcome::SpawnFailed { attempt, error } => Some(BackendIssue::SpawnFailed {
                attempt: *attempt,
                max: MAX_SIDECAR_RESPAWNS,
                error: error.clone(),
            }),
        }
    }
}

impl SidecarSupervisor {
    /// `factory`는 **같은 설정으로 다시 띄우는 방법**이다. 설정을 복제해 두는 대신 클로저로
    /// 받는 이유: 자격증명이 그 설정에 들어 있고(2절), 그걸 감독자가 들고 있으면 살아 있는
    /// 사본이 하나 더 생긴다.
    pub fn new(factory: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync>) -> std::io::Result<Self> {
        let client = factory()?;
        Ok(Self {
            factory,
            client: Mutex::new(client),
            respawns: AtomicU64::new(0),
            max_respawns: MAX_SIDECAR_RESPAWNS,
        })
    }

    /// 지금 쓸 수 있는 클라이언트.
    pub fn client(&self) -> Arc<SidecarClient> {
        self.client.lock().unwrap().clone()
    }

    pub fn respawn_count(&self) -> u64 {
        self.respawns.load(Ordering::SeqCst)
    }

    /// 지금 상태를 **바꾸지 않고** 본다. 화면이 "다시 열기" 버튼을 띄울지 정하는 데 쓴다 —
    /// 상태를 물었더니 재spawn이 일어나면 그건 조회가 아니다.
    ///
    /// 판정 규칙은 `ensure_alive`와 같은 순서를 따른다: 프로토콜 위반이 상한보다 먼저다.
    /// 위반으로 닫힌 것은 상한이 남아 있어도 다시 띄우지 않기 때문이다.
    pub fn status(&self) -> SupervisorStatus {
        let guard = self.client.lock().unwrap();
        if !guard.is_closed() {
            return SupervisorStatus::Alive;
        }
        if let Some(reason) = guard.close_reason() {
            if reason.starts_with(PROTOCOL_VIOLATION_PREFIX) {
                return SupervisorStatus::unavailable(
                    RespawnOutcome::ProtocolViolation { reason }
                        .failure()
                        .expect("프로토콜 위반은 실패다"),
                );
            }
        }
        let used = self.respawns.load(Ordering::SeqCst);
        if used >= self.max_respawns {
            return SupervisorStatus::unavailable(
                RespawnOutcome::LimitReached {
                    attempts: self.max_respawns,
                }
                .failure()
                .expect("상한 도달은 실패다"),
            );
        }
        SupervisorStatus::WillRespawn {
            remaining: self.max_respawns - used,
        }
    }

    /// 죽어 있으면 다시 띄운다. **호출자가 부르는 시점을 정한다** — 태스크를 시작하기 전이지,
    /// 태스크 도중이 아니다. 도중에 바꿔치기하면 진행 중인 요청이 어느 프로세스의 것인지
    /// 알 수 없게 된다.
    pub fn ensure_alive(&self) -> RespawnOutcome {
        let mut guard = self.client.lock().unwrap();
        if !guard.is_closed() {
            return RespawnOutcome::Alive;
        }
        if let Some(reason) = guard.close_reason() {
            if reason.starts_with(PROTOCOL_VIOLATION_PREFIX) {
                return RespawnOutcome::ProtocolViolation { reason };
            }
        }
        let attempt = self.respawns.load(Ordering::SeqCst) + 1;
        if attempt > self.max_respawns {
            return RespawnOutcome::LimitReached {
                attempts: self.max_respawns,
            };
        }
        match (self.factory)() {
            Ok(fresh) => {
                *guard = fresh;
                self.respawns.store(attempt, Ordering::SeqCst);
                RespawnOutcome::Respawned { attempt }
            }
            Err(e) => {
                // **실패한 시도도 센다.** 세지 않으면 spawn이 계속 실패하는 환경에서
                // 상한이 없는 것과 같아진다.
                self.respawns.store(attempt, Ordering::SeqCst);
                RespawnOutcome::SpawnFailed {
                    attempt,
                    error: e.to_string(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 평범한 줄은 그대로 나오고, `\r\n`도 벗겨진다(Windows에서 온 줄을 그대로 파싱하면
    /// JSON 뒤에 `\r`이 붙어 파싱이 실패한다).
    #[test]
    fn reads_lines_and_strips_terminators() {
        let mut input = Cursor::new(b"{\"a\":1}\n{\"b\":2}\r\n".to_vec());
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("{\"a\":1}".to_string())
        );
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("{\"b\":2}".to_string())
        );
        assert_eq!(read_framed_line(&mut input, MAX_IPC_LINE_BYTES), FramedLine::Eof);
    }

    /// **정확히 상한인 줄은 정당하다.** 경계를 초과로 판정하면 상한이 실제로는 하나 작은 값이 된다.
    #[test]
    fn a_line_exactly_at_the_limit_is_accepted() {
        let mut data = vec![b'x'; 16];
        data.push(b'\n');
        let mut input = Cursor::new(data);
        assert_eq!(read_framed_line(&mut input, 16), FramedLine::Line("x".repeat(16)));
    }

    /// 줄바꿈 없이 끝난 **마지막** 줄은 정당하다 — EOF는 프레임 위반이 아니다.
    #[test]
    fn a_final_line_without_a_newline_is_accepted() {
        let mut input = Cursor::new(b"{\"a\":1}".to_vec());
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("{\"a\":1}".to_string())
        );
    }

    /// **상한을 넘기면 메모리를 계속 키우지 않는다.** 종전 `BufReader::lines()`는 줄바꿈이
    /// 나올 때까지 무한히 버퍼를 키웠고, 그건 신뢰 경계 프로세스를 Node가 죽일 수 있다는 뜻이다.
    ///
    /// 입력을 실제로 크게 만들지 않고 확인한다 — 끝없는 바이트 스트림을 주고, 함수가
    /// **돌아오는지**를 본다. 상한이 없으면 이 테스트는 끝나지 않는다.
    #[test]
    fn an_endless_line_is_bounded_instead_of_growing_forever() {
        // `repeat`은 Read이지 BufRead가 아니므로 BufReader로 감싼다 — 감싸는 버퍼는 고정
        // 크기이고, 무한히 커질 수 있는 것은 우리가 만드는 줄 버퍼뿐이다.
        let mut endless = BufReader::new(std::io::repeat(b'x'));
        match read_framed_line(&mut endless, 1_024) {
            FramedLine::Oversized { bytes } => assert_eq!(bytes, 1_025, "상한+1까지만 읽어야 한다"),
            other => panic!("초과를 감지하지 못했습니다: {other:?}"),
        }
    }

    /// **초과와 완결 불가를 구별해야 다음 처리가 갈린다.** 완결된 줄(UTF-8 위반)은 프레임
    /// 동기가 살아 있어 그 줄만 버리면 되지만, 초과는 나머지가 스트림에 남아 동기를 잃는다.
    #[test]
    fn invalid_utf8_is_distinguished_from_oversize() {
        // 0xFF는 어떤 UTF-8 시퀀스에도 나타나지 않는다.
        let mut input = Cursor::new(vec![0xFF, 0xFE, b'\n', b'o', b'k', b'\n']);
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::InvalidUtf8 { bytes: 3 }
        );
        // 그 줄만 버리면 다음 줄은 정상이다 — 이것이 초과와 다른 점이다.
        assert_eq!(
            read_framed_line(&mut input, MAX_IPC_LINE_BYTES),
            FramedLine::Line("ok".to_string())
        );
    }

    /// 초과 뒤의 스트림은 **앞 메시지의 꼬리**다. 그 사실을 이 테스트가 고정한다 —
    /// 계속 읽으면 우리가 "메시지"라고 부르는 것이 아무것도 보장하지 않는다.
    #[test]
    fn after_an_oversized_line_the_stream_is_desynchronized() {
        let mut input = Cursor::new(b"aaaaaaaaaa{\"tail\":1}\n{\"next\":2}\n".to_vec());
        assert!(matches!(read_framed_line(&mut input, 4), FramedLine::Oversized { .. }));
        // 다음에 읽히는 것은 온전한 메시지가 아니라 앞 줄의 나머지다.
        match read_framed_line(&mut input, MAX_IPC_LINE_BYTES) {
            FramedLine::Line(line) => {
                assert_ne!(line, "{\"next\":2}", "동기가 유지된 것처럼 보입니다");
                assert!(line.ends_with("{\"tail\":1}"), "실제로 읽힌 줄: {line}");
            }
            other => panic!("예상치 못한 결과: {other:?}"),
        }
    }
}

#[cfg(test)]
mod supervisor_tests {
    use super::*;
    use crate::uimsg::UserFacing;
    use std::sync::atomic::AtomicUsize;

    struct NoopHandler;
    impl SidecarHandler for NoopHandler {
        fn handle_request(&self, _method: &str, _params: &Value) -> Result<Value, String> {
            Ok(Value::Null)
        }
        fn handle_event(&self, _task_id: &str, _event: &Value) {}
    }

    /// 즉시 죽는 sidecar. **실제 프로세스를 띄운다** — mock 클라이언트로 확인하면 "죽었다"의
    /// 판정 자체(EOF 감지)가 검증에서 빠진다.
    fn dying_factory(spawns: Arc<AtomicUsize>) -> Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> {
        Box::new(move || {
            spawns.fetch_add(1, Ordering::SeqCst);
            SidecarClient::spawn(
                SpawnConfig {
                    program: "node".to_string(),
                    args: vec!["-e".to_string(), "process.exit(0)".to_string()],
                    working_dir: None,
                    env: Vec::new(),
                },
                Arc::new(NoopHandler),
            )
        })
    }

    fn wait_closed(client: &SidecarClient) {
        for _ in 0..200 {
            if client.is_closed() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("sidecar가 종료를 보고하지 않았습니다");
    }

    /// **상한이 있고, 그 상한이 워크스페이스 세션당이다.** "성공하면 리셋"은 상한이 아니다 —
    /// 태스크마다 한 번씩 죽는 sidecar가 영원히 재spawn된다.
    #[test]
    fn respawns_up_to_the_limit_and_then_stops() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();

        for attempt in 1..=MAX_SIDECAR_RESPAWNS {
            wait_closed(&supervisor.client());
            assert_eq!(supervisor.ensure_alive(), RespawnOutcome::Respawned { attempt });
        }

        wait_closed(&supervisor.client());
        assert_eq!(
            supervisor.ensure_alive(),
            RespawnOutcome::LimitReached {
                attempts: MAX_SIDECAR_RESPAWNS
            }
        );
        // 상한에 도달한 뒤에는 **더 띄우지 않는다.** 최초 1회 + 재spawn 2회.
        assert_eq!(spawns.load(Ordering::SeqCst), (MAX_SIDECAR_RESPAWNS + 1) as usize);
    }

    /// 살아 있으면 아무것도 하지 않는다 — 멀쩡한 sidecar를 바꿔치기하면 진행 중인 요청이
    /// 어느 프로세스의 것인지 알 수 없게 된다.
    #[test]
    fn a_live_sidecar_is_left_alone() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let long_lived: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> = {
            let spawns = spawns.clone();
            Box::new(move || {
                spawns.fetch_add(1, Ordering::SeqCst);
                SidecarClient::spawn(
                    SpawnConfig {
                        program: "node".to_string(),
                        args: vec!["-e".to_string(), "setTimeout(() => {}, 60000)".to_string()],
                        working_dir: None,
                        env: Vec::new(),
                    },
                    Arc::new(NoopHandler),
                )
            })
        };
        let supervisor = SidecarSupervisor::new(long_lived).unwrap();
        assert_eq!(supervisor.ensure_alive(), RespawnOutcome::Alive);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(supervisor.respawn_count(), 0);
    }

    /// **프로토콜 위반은 재spawn하지 않는다.** 다시 띄우면 같은 위반을 반복할 뿐이고,
    /// 그게 공격이라면 재시도가 곧 협조다.
    #[test]
    fn a_protocol_violation_is_not_respawned() {
        let spawns = Arc::new(AtomicUsize::new(0));
        // 상한을 넘는 한 줄을 뱉고 죽는 sidecar를 흉내내는 대신, 종료 사유를 직접 만든다 —
        // 32 MiB를 실제로 쓰는 테스트는 느리고, 여기서 확인하려는 것은 **판정 규칙**이다.
        // (상한 감지 자체는 `read_framed_line` 테스트가 확인한다.)
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();
        wait_closed(&supervisor.client());
        {
            let client = supervisor.client();
            let mut slot = client.close_reason.lock().unwrap();
            *slot = Some(format!("{PROTOCOL_VIOLATION_PREFIX}한 줄이 너무 깁니다"));
        }
        match supervisor.ensure_alive() {
            RespawnOutcome::ProtocolViolation { reason } => {
                assert!(reason.contains("너무 깁니다"), "{reason}");
            }
            other => panic!("위반인데 재spawn했습니다: {other:?}"),
        }
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "다시 띄우면 안 됩니다");
    }

    /// spawn 자체가 실패한 시도도 **센다.** 세지 않으면 실행 파일이 없는 환경에서 상한이
    /// 없는 것과 같아진다 — `ensure_alive`를 부를 때마다 새로 시도하게 된다.
    #[test]
    fn a_failed_spawn_still_counts_against_the_limit() {
        let calls = Arc::new(AtomicUsize::new(0));
        let factory: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> = {
            let calls = calls.clone();
            Box::new(move || {
                // 첫 호출만 성공한다(그리고 바로 죽는다). 이후 재spawn은 전부 실패한다.
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                SidecarClient::spawn(
                    SpawnConfig {
                        program: if first { "node" } else { "tomverse-not-a-real-program" }.to_string(),
                        args: if first {
                            vec!["-e".to_string(), "process.exit(0)".to_string()]
                        } else {
                            Vec::new()
                        },
                        working_dir: None,
                        env: Vec::new(),
                    },
                    Arc::new(NoopHandler),
                )
            })
        };

        let supervisor = SidecarSupervisor::new(factory).unwrap();
        wait_closed(&supervisor.client());

        for attempt in 1..=MAX_SIDECAR_RESPAWNS {
            match supervisor.ensure_alive() {
                RespawnOutcome::SpawnFailed { attempt: got, .. } => assert_eq!(got, attempt),
                other => panic!("spawn이 실패했는데 다른 결과가 나왔습니다: {other:?}"),
            }
        }
        // 실패한 시도가 세어졌으므로 상한에 도달한다 — 세지 않았다면 영원히 재시도했을 것이다.
        assert_eq!(
            supervisor.ensure_alive(),
            RespawnOutcome::LimitReached {
                attempts: MAX_SIDECAR_RESPAWNS
            }
        );
    }

    /// **"죽어 있다"가 곧 "사용자가 개입해야 한다"는 아니다.** 상한이 남아 있으면 다음
    /// 태스크에서 자동으로 다시 뜨므로 화면은 아무 조치도 요구하면 안 된다.
    #[test]
    fn a_dead_sidecar_with_attempts_left_asks_nothing_of_the_user() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();
        wait_closed(&supervisor.client());

        assert_eq!(
            supervisor.status(),
            SupervisorStatus::WillRespawn {
                remaining: MAX_SIDECAR_RESPAWNS
            }
        );
        // 조회가 상태를 바꾸지 않았다 — 물었더니 재spawn이 일어나면 그건 조회가 아니다.
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "status()가 sidecar를 다시 띄웠습니다");
        assert_eq!(supervisor.respawn_count(), 0);
    }

    /// 상한에 도달하면 **다시 열기**를 제안한다 — 다시 열면 감독자가 새로 만들어져
    /// 실제로 달라지기 때문이다.
    #[test]
    fn reaching_the_limit_offers_reopening_the_workspace() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();
        for _ in 0..MAX_SIDECAR_RESPAWNS {
            wait_closed(&supervisor.client());
            supervisor.ensure_alive();
        }
        wait_closed(&supervisor.client());

        match supervisor.status() {
            SupervisorStatus::Unavailable {
                recovery,
                code,
                params,
                message,
            } => {
                assert_eq!(recovery, Recovery::ReopenWorkspace);
                // **코드가 판정이다.** 화면은 이걸로 문장을 고른다.
                assert_eq!(code, "respawnLimit");
                assert_eq!(params["attempts"], json!(MAX_SIDECAR_RESPAWNS));
                // 원문도 함께 온다 — 화면이 코드를 모를 때의 대체 표시다.
                assert!(message.contains("계속 종료"), "{message}");
            }
            other => panic!("상한에 도달했는데 다른 상태입니다: {other:?}"),
        }
    }

    /// **프로토콜 위반에는 버튼을 주지 않는다.** 다시 열어도 같은 위반이 반복되므로,
    /// 눌러도 같은 결과가 나오는 버튼이 남는다 — 그건 안내가 아니라 거짓말이다.
    /// 그리고 위반은 **상한이 남아 있어도** 이 판정을 받는다.
    #[test]
    fn a_protocol_violation_offers_no_button() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();
        wait_closed(&supervisor.client());
        {
            let client = supervisor.client();
            let mut slot = client.close_reason.lock().unwrap();
            *slot = Some(format!("{PROTOCOL_VIOLATION_PREFIX}한 줄이 너무 깁니다"));
        }
        assert_eq!(supervisor.respawn_count(), 0, "상한이 남아 있는 상태여야 합니다");

        match supervisor.status() {
            SupervisorStatus::Unavailable {
                recovery, code, params, ..
            } => {
                assert_eq!(recovery, Recovery::None);
                assert_eq!(code, "protocolViolation");
                // 위반 사유는 **파라미터로** 온다 — 문장에 이어 붙이면 번역할 수 없다.
                assert!(
                    params["reason"].as_str().unwrap_or_default().contains("너무 깁니다"),
                    "{params}"
                );
            }
            other => panic!("위반인데 다른 상태입니다: {other:?}"),
        }
    }

    /// 살아 있으면 살아 있다고 말한다 — 위 세 테스트가 "언제나 Unavailable"로 통과하지 않도록.
    #[test]
    fn a_live_sidecar_reports_alive() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let long_lived: Box<dyn Fn() -> std::io::Result<Arc<SidecarClient>> + Send + Sync> = {
            let spawns = spawns.clone();
            Box::new(move || {
                spawns.fetch_add(1, Ordering::SeqCst);
                SidecarClient::spawn(
                    SpawnConfig {
                        program: "node".to_string(),
                        args: vec!["-e".to_string(), "setTimeout(() => {}, 60000)".to_string()],
                        working_dir: None,
                        env: Vec::new(),
                    },
                    Arc::new(NoopHandler),
                )
            })
        };
        let supervisor = SidecarSupervisor::new(long_lived).unwrap();
        assert_eq!(supervisor.status(), SupervisorStatus::Alive);
    }

    /// 조회와 실행이 **같은 판정**에서 나온다. 두 벌이 되면 화면과 로그가 다른 말을 하고,
    /// 한쪽만 고쳐질 때 그 사실이 드러나지 않는다.
    #[test]
    fn the_verdict_comes_from_one_place() {
        let issue = RespawnOutcome::LimitReached {
            attempts: MAX_SIDECAR_RESPAWNS,
        }
        .failure()
        .unwrap();
        assert_eq!(issue.recovery(), Recovery::ReopenWorkspace);

        let spawns = Arc::new(AtomicUsize::new(0));
        let supervisor = SidecarSupervisor::new(dying_factory(spawns.clone())).unwrap();
        for _ in 0..MAX_SIDECAR_RESPAWNS {
            wait_closed(&supervisor.client());
            supervisor.ensure_alive();
        }
        wait_closed(&supervisor.client());
        match supervisor.status() {
            SupervisorStatus::Unavailable { code, message, .. } => {
                assert_eq!(code, issue.code());
                assert_eq!(message, issue.korean());
            }
            other => panic!("{other:?}"),
        }
    }

    /// **코드가 서로 달라야 한다.** 같으면 화면이 문장을 고를 수 없다.
    #[test]
    fn every_issue_has_its_own_code() {
        let issues = [
            BackendIssue::RespawnLimit { attempts: 2 },
            BackendIssue::ProtocolViolation {
                reason: "x".to_string(),
            },
            BackendIssue::SpawnFailed {
                attempt: 1,
                max: 2,
                error: "y".to_string(),
            },
        ];
        let codes: std::collections::BTreeSet<&str> = issues.iter().map(|i| i.code()).collect();
        assert_eq!(codes.len(), issues.len(), "코드가 겹칩니다: {codes:?}");
        // 그리고 파라미터가 비어 있으면 안 된다 — 문장에 끼울 값이 없으면 이어 붙이기로 되돌아간다.
        for issue in &issues {
            assert!(
                issue.params().as_object().map(|o| !o.is_empty()).unwrap_or(false),
                "{}의 파라미터가 비었습니다",
                issue.code()
            );
            assert!(!issue.korean().is_empty());
        }
    }

    /// **값이 문장에 이어 붙어 있지 않다.** 이어 붙인 문장은 어순이 다른 언어로 옮길 수 없다 —
    /// 파라미터가 원문에 들어 있는지로 그걸 확인한다.
    #[test]
    fn the_values_travel_as_parameters_not_only_inside_the_sentence() {
        let issue = BackendIssue::SpawnFailed {
            attempt: 1,
            max: 2,
            error: "ENOENT".to_string(),
        };
        assert_eq!(issue.params()["attempt"], json!(1));
        assert_eq!(issue.params()["max"], json!(2));
        assert_eq!(issue.params()["error"], json!("ENOENT"));
        // 원문에도 들어 있지만, 그건 대체 표시용이지 화면이 파싱할 것이 아니다.
        assert!(issue.korean().contains("ENOENT"));
    }

    /// 성공한 결과는 실패 문장을 갖지 않는다 — 갖게 되면 화면이 정상 동작에도 배너를 띄운다.
    #[test]
    fn success_has_no_failure_message() {
        assert!(RespawnOutcome::Alive.failure().is_none());
        assert!(RespawnOutcome::Respawned { attempt: 1 }.failure().is_none());
    }
    // ---- IPC 줄 크기 계측 (process-architecture.md 3.1절) ----

    #[test]
    fn every_line_lands_in_the_bucket_that_bounds_it() {
        let counters = LineSizeCounters::default();
        counters.observe(10);
        counters.observe(1024);
        counters.observe(1025);
        counters.observe(MAX_IPC_LINE_BYTES as u64);

        let sizes = counters.take();
        assert_eq!(sizes.lines, 4);
        assert_eq!(sizes.max_bytes, MAX_IPC_LINE_BYTES as u64);
        // 경계값은 **그 구간에 들어간다**(상한 포함). 경계에서 한 칸 밀리면 분포가 통째로 밀린다.
        assert_eq!(sizes.buckets[0].lines, 2, "{:?}", sizes.buckets);
        assert_eq!(sizes.buckets[1].lines, 1, "{:?}", sizes.buckets);
        assert_eq!(sizes.buckets[4].lines, 1, "{:?}", sizes.buckets);
    }

    /// **꺼내면 비워진다.** 누적을 남기면 뒤 태스크일수록 커지기만 해서 분포가 아니라 순번을
    /// 재게 된다.
    #[test]
    fn taking_the_sizes_clears_them() {
        let counters = LineSizeCounters::default();
        counters.observe(500);
        assert_eq!(counters.take().lines, 1);

        let second = counters.take();
        assert_eq!(second.lines, 0);
        assert_eq!(second.max_bytes, 0);
        assert!(second.buckets.iter().all(|b| b.lines == 0), "{:?}", second.buckets);
    }

    /// 구간 상한이 실제 상한까지 덮는가. 마지막 구간이 `MAX_IPC_LINE_BYTES`보다 작으면
    /// **상한 근처의 줄이 어디에도 안 세어진다** — 그러면 "상한이 헐거운가"에 답할 수 없다.
    #[test]
    fn the_buckets_reach_the_limit() {
        assert_eq!(*IPC_LINE_BUCKET_LIMITS.last().unwrap(), MAX_IPC_LINE_BYTES as u64);
        assert!(IPC_LINE_BUCKET_LIMITS.windows(2).all(|w| w[0] < w[1]));
    }
}
