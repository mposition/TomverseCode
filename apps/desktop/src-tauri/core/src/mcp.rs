//! MCP (Model Context Protocol) — product-strategy.md 8.2절, M2.
//!
//! 출시 기준은 **"MCP 서버 등록, 그 도구가 `ToolRequest`로 변환되어 Policy Gate 통과"** 다.
//!
//! # 왜 Rust가 소유하는가
//!
//! MCP 서버는 **프로세스**다. 그것을 띄우고 stdio로 말하는 것은 정확히 원칙 2가 Node에게
//! 금지한 일이다(`packages/sidecar/test/boundary.test.ts`가 소스 수준에서 강제한다). Node가
//! MCP 클라이언트를 가지면 "Node는 셸을 실행하지 않는다"가 거짓이 된다 — MCP 서버 하나가
//! 곧 임의의 프로그램이기 때문이다.
//!
//! 그래서 Node는 **요청만** 한다: `mcp_call` 도구 하나로 서버 이름·도구 이름·인자를 보내고,
//! 띄울지 말지는 Rust의 Policy Gate가 정한다.
//!
//! # 우리가 보장하는 것과 보장하지 못하는 것
//!
//! **보장한다**: 어떤 서버의 어떤 도구를 어떤 인자로 불렀는지가 승인 화면에 그대로 보이고
//! 이벤트에 그대로 남는다(원칙 6의 MCP판 — 보이는 것이 실제 나가는 것이다).
//!
//! **보장하지 못한다**: 그 서버가 무엇을 하는지. MCP 서버는 우리 Policy Gate 밖에서 파일을
//! 고치고 네트워크를 쓸 수 있다. **서버를 등록하는 순간 사용자는 게이트 밖의 능력을 들여온다.**
//! 그래서 등록은 사용자만 할 수 있고(모델이 서버를 추가하는 경로가 없다), 호출은 언제나
//! 승인을 요구하며, 화면이 이 한계를 문장으로 말해야 한다. 흐리게 말하면 사용자는 우리 게이트가
//! MCP 도구의 행동까지 검사한다고 믿는다.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};

/// 등록된 MCP 서버 하나.
///
/// **셸 문자열이 아니라 argv 배열이다**(원칙 6). 문자열로 받으면 승인 화면에 보인 것과 실제
/// 실행되는 것이 갈라지고, 그 갈라짐은 정확히 이 도구가 위험한 이유가 된다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 이 서버에 넘길 환경변수. **비어 있는 것이 기본이다** — 부모 환경을 통째로 물려주면
    /// API 키가 우리가 모르는 프로세스로 나간다(원칙 3의 정신).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 이 서버에서 **부를 수 있는 도구**를 좁힌다 (state-machine 32절).
    ///
    /// `None`이면 서버가 내놓는 전부다. `Some`이면 그 목록만이고, 목록 밖의 도구는
    /// **승인을 묻지도 않고 게이트가 거부한다** — 물어본 뒤 실패시키면 사용자는 자기 승인이
    /// 의미 없었다고 배운다.
    ///
    /// **빈 목록은 오류다.** "아무것도 부를 수 없는 서버"를 등록하는 것은 등록하지 않는 것과
    /// 같은데, 화면에는 등록된 것으로 보인다 — 스킬의 도구 허용목록과 같은 판단이다(26.3절).
    #[serde(default)]
    pub tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpConfigError {
    EmptyName,
    InvalidName { name: String },
    EmptyProgram { name: String },
    /// 프로그램 자리에 셸 메타문자가 들어왔다 — 문자열 명령을 넣으려는 시도다.
    ShellLike { name: String, program: String },
    Duplicate { name: String },
    /// 도구 허용목록이 비어 있다 — "아무것도 못 부르는 서버"는 등록의 뜻이 아니다.
    EmptyToolAllowlist { name: String },
    /// 허용목록 항목이 비어 있다.
    EmptyToolName { name: String },
}

impl std::fmt::Display for McpConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyName => write!(f, "서버 이름이 비어 있습니다"),
            Self::InvalidName { name } => write!(
                f,
                "서버 이름에 쓸 수 없는 문자가 있습니다 ({name}) — 영숫자와 `-` `_`만 됩니다"
            ),
            Self::EmptyProgram { name } => write!(f, "{name}: 실행할 프로그램이 없습니다"),
            Self::ShellLike { name, program } => write!(
                f,
                "{name}: 프로그램 자리에 셸 명령을 넣을 수 없습니다 ({program}) — program과 args를 나눠서 적으세요"
            ),
            Self::Duplicate { name } => write!(f, "서버 이름이 중복됩니다: {name}"),
            Self::EmptyToolAllowlist { name } => write!(
                f,
                "{name}: 도구 허용목록이 비어 있습니다 — 아무 도구도 부를 수 없는 서버는 등록하지 않는 것과 같습니다. 전부 허용하려면 목록 자체를 비워 두세요"
            ),
            Self::EmptyToolName { name } => write!(f, "{name}: 도구 허용목록에 빈 이름이 있습니다"),
        }
    }
}

/// 등록 목록을 검사한다. **여기서 거부하면 그 서버는 아예 존재하지 않는다.**
pub fn validate_servers(servers: &[McpServerConfig]) -> Result<(), McpConfigError> {
    let mut seen: Vec<&str> = Vec::new();
    for server in servers {
        if server.name.trim().is_empty() {
            return Err(McpConfigError::EmptyName);
        }
        if !server
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err(McpConfigError::InvalidName { name: server.name.clone() });
        }
        if seen.contains(&server.name.as_str()) {
            return Err(McpConfigError::Duplicate { name: server.name.clone() });
        }
        seen.push(&server.name);
        if server.program.trim().is_empty() {
            return Err(McpConfigError::EmptyProgram { name: server.name.clone() });
        }
        // `sh -c "..."`를 program 한 칸에 우겨넣는 것을 막는다. argv 배열이라는 보장은
        // **program 자리도 하나의 실행 파일일 때만** 성립한다.
        if looks_like_command_string(&server.program) {
            return Err(McpConfigError::ShellLike {
                name: server.name.clone(),
                program: server.program.clone(),
            });
        }
        if let Some(tools) = &server.tools {
            if tools.is_empty() {
                return Err(McpConfigError::EmptyToolAllowlist { name: server.name.clone() });
            }
            if tools.iter().any(|t| t.trim().is_empty()) {
                return Err(McpConfigError::EmptyToolName { name: server.name.clone() });
            }
        }
    }
    Ok(())
}

/// program 자리에 **명령 문자열**이 들어왔는가.
///
/// # 공백만으로는 판정할 수 없다
///
/// 처음에는 셸 메타문자(`|&;><`)만 봤는데 `sh -c 'rm -rf /'`가 통과했다 — 거기엔 메타문자가
/// 없다. 그렇다고 공백을 거부할 수도 없다: Windows의 정상적인 실행 파일 경로가
/// `C:\Program Files\nodejs\node.exe`다.
///
/// 그래서 **인자가 붙었다는 표시**를 본다: 따옴표, 그리고 공백 뒤에 오는 `-`(플래그의 모양).
/// 경로에 공백이 있는 것은 괜찮고, 공백 뒤에 플래그가 오는 것은 명령 문자열이다.
///
/// 완벽한 판정이 아니라는 것을 적어 둔다 — `--`가 없는 인자(`sh -c` 대신 `sh script.sh`)는
/// 이 규칙을 지나간다. 그때는 실행이 실패하고 사유가 남는다. **여기서 잡으려는 것은 공격이
/// 아니라 흔한 설정 실수**이고, 공격 쪽은 "등록은 사용자만 한다"가 막는다.
fn looks_like_command_string(program: &str) -> bool {
    if program.chars().any(|c| matches!(c, '|' | '&' | ';' | '>' | '<' | '\n' | '\'' | '"')) {
        return true;
    }
    program.split(' ').skip(1).any(|token| token.starts_with('-'))
}

/// `mcp_call` 요청이 담고 있는 것. 승인 화면과 이벤트가 **이 값 그대로**를 보여준다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct McpCall {
    pub server: String,
    pub tool: String,
    pub arguments: Value,
}

/// 도구 요청 인자에서 `McpCall`을 뽑는다.
///
/// **모르는 모양은 통과시키지 않는다.** 게이트가 승인 화면에 무엇을 보여줄지 정하지 못하는
/// 요청은 승인받을 수 없다 — "무엇을 승인하는지 모르는 승인"은 승인이 아니다.
pub fn parse_call(args: &Value) -> Result<McpCall, String> {
    let server = args
        .get("server")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "mcp_call 요청에 문자열 \"server\" 인자가 없음".to_string())?;
    let tool = args
        .get("tool")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "mcp_call 요청에 문자열 \"tool\" 인자가 없음".to_string())?;
    // `arguments`는 없을 수 있다(인자 없는 도구). 하지만 **객체가 아니면** 거부한다 —
    // MCP는 named arguments를 쓰므로 배열이나 문자열은 우리가 잘못 조립한 것이다.
    let arguments = match args.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(v) if v.is_object() => v.clone(),
        Some(_) => return Err("mcp_call의 \"arguments\"는 객체여야 합니다".to_string()),
    };
    Ok(McpCall {
        server: server.to_string(),
        tool: tool.to_string(),
        arguments,
    })
}

/// 승인 화면에 나갈 한 줄. **인자를 요약하거나 자르지 않는다** — 자르면 사용자가 승인한 것과
/// 실제 나가는 것이 달라지고, 그게 이 도구에서 가장 피해야 할 일이다.
pub fn describe(call: &McpCall) -> String {
    format!(
        "{} 서버의 {} 도구 · 인자 {}",
        call.server,
        call.tool,
        serde_json::to_string(&call.arguments).unwrap_or_else(|_| "(직렬화 불가)".to_string())
    )
}

// ---- JSON-RPC over stdio ----

/// MCP 서버와의 한 세션.
///
/// **스트림에 대해 제네릭이다.** `sidecar.rs`가 줄 읽기를 순수 함수로 두고 테스트한 것과 같은
/// 이유다 — 프로세스를 띄워야만 검증되는 프로토콜 코드는 검증되지 않는 코드가 된다.
pub struct McpSession<R: BufRead, W: Write> {
    reader: R,
    /// 테스트가 **우리가 실제로 보낸 바이트**를 읽는다 — 승인 화면과 같은지 확인하는 자리다.
    pub(crate) writer: W,
    next_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpError {
    Transport(String),
    /// 서버가 JSON-RPC 오류를 돌려줬다. **우리 실패와 구별한다** — 고칠 곳이 다르다.
    Server { code: i64, message: String },
    Protocol(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(m) => write!(f, "MCP 전송 실패: {m}"),
            Self::Server { code, message } => write!(f, "MCP 서버 오류 {code}: {message}"),
            Self::Protocol(m) => write!(f, "MCP 프로토콜 위반: {m}"),
        }
    }
}

/// 한 줄의 상한. `sidecar.rs`의 32 MiB와 같은 이유로 둔다 — 상한이 없으면 상대가
/// **우리 메모리를 무한히 키울 수 있다.** MCP 서버는 우리가 만든 프로그램이 아니다.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

impl<R: BufRead, W: Write> McpSession<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer, next_id: 1 }
    }

    /// 핸드셰이크. 서버가 어떤 프로토콜 버전을 말하는지 그대로 돌려준다 —
    /// **우리가 기대한 값으로 덮지 않는다**(공급자 envelope에서와 같은 규칙).
    pub fn initialize(&mut self, client_name: &str) -> Result<Value, McpError> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": client_name, "version": env!("CARGO_PKG_VERSION") },
            }),
        )
    }

    /// 이 서버가 내놓는 도구 목록.
    pub fn list_tools(&mut self) -> Result<Vec<Value>, McpError> {
        let result = self.request("tools/list", json!({}))?;
        match result.get("tools") {
            Some(Value::Array(tools)) => Ok(tools.clone()),
            // 빈 배열과 "tools 키가 없음"을 뭉개지 않는다 — 전자는 도구가 없는 서버이고
            // 후자는 우리가 MCP 서버가 아닌 것과 말하고 있다는 뜻이다.
            _ => Err(McpError::Protocol("tools/list 응답에 tools 배열이 없습니다".to_string())),
        }
    }

    /// 도구 하나를 부른다. **여기까지 온 요청은 이미 Policy Gate와 사용자 승인을 지났다.**
    pub fn call_tool(&mut self, call: &McpCall) -> Result<Value, McpError> {
        self.request(
            "tools/call",
            json!({ "name": call.tool, "arguments": call.arguments }),
        )
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|e| McpError::Transport(e.to_string()))?;
        self.writer
            .write_all(line.as_bytes())
            .and_then(|()| self.writer.write_all(b"\n"))
            .and_then(|()| self.writer.flush())
            .map_err(|e| McpError::Transport(e.to_string()))?;

        // **우리 id의 응답이 올 때까지 읽는다.** 서버는 알림(notification, id 없음)을 섞어
        // 보낼 수 있고, 그것을 응답으로 착각하면 엉뚱한 값을 결과로 쓰게 된다.
        loop {
            let Some(message) = self.read_message()? else {
                return Err(McpError::Transport("응답을 받기 전에 스트림이 닫혔습니다".to_string()));
            };
            match message.get("id").and_then(Value::as_u64) {
                Some(got) if got == id => {
                    if let Some(error) = message.get("error") {
                        return Err(McpError::Server {
                            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                            message: error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("(메시지 없음)")
                                .to_string(),
                        });
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                // 다른 id의 응답도 무시한다 — 우리는 한 번에 하나만 보내므로 남의 것이다.
                _ => continue,
            }
        }
    }

    /// 한 메시지를 읽는다. 줄 프레이밍은 **`sidecar.rs`의 것을 그대로 쓴다.**
    ///
    /// 두 번째 구현을 만들지 않는 이유: 상한을 넘긴 줄을 어떻게 다룰지(프레임 동기를 잃었으므로
    /// 계속 읽지 않는다)는 이미 한 번 정한 규칙이고, 규칙이 두 곳에 있으면 언젠가 한쪽만 고쳐진다.
    fn read_message(&mut self) -> Result<Option<Value>, McpError> {
        loop {
            match crate::sidecar::read_framed_line(&mut self.reader, MAX_LINE_BYTES) {
                crate::sidecar::FramedLine::Eof => return Ok(None),
                crate::sidecar::FramedLine::ReadError(e) => return Err(McpError::Transport(e)),
                // **상한 초과에서 계속 읽지 않는다.** 그 줄의 나머지가 스트림에 남아 있어
                // 다음 "줄"은 앞 메시지의 꼬리다 — 프레임 동기를 잃은 채 파싱하면 조용히
                // 엉뚱한 값을 결과로 쓴다.
                crate::sidecar::FramedLine::Oversized { bytes } => {
                    return Err(McpError::Transport(format!(
                        "한 줄이 상한({MAX_LINE_BYTES} 바이트)을 넘었습니다: {bytes} 바이트"
                    )))
                }
                crate::sidecar::FramedLine::InvalidUtf8 { bytes } => {
                    return Err(McpError::Protocol(format!("UTF-8이 아닌 줄({bytes} 바이트)")))
                }
                crate::sidecar::FramedLine::Line(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // **파싱 불가한 줄은 무시한다**(sidecar.rs와 같은 원칙). 서버가 stdout에
                    // 로그를 섞어 내는 경우가 흔하고, 그때마다 세션을 죽이면 쓸 수 있는
                    // 서버가 거의 없다.
                    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                        return Ok(Some(value));
                    }
                }
            }
        }
    }
}

// ---- 프로세스로 띄운 세션 ----

/// 등록된 서버들을 띄우고 재사용한다.
///
/// **`ToolRuntime`이 아니라 여기가 세션을 소유한다.** 런타임은 요청 하나를 실행하는 순수한
/// 자리이고, 프로세스 수명은 태스크 수명에 걸린다 — 요청마다 서버를 새로 띄우면 MCP 서버가
/// 들고 있는 상태(연결·캐시)가 매번 사라진다.
pub struct McpPool {
    servers: Vec<McpServerConfig>,
    sessions: std::sync::Mutex<BTreeMap<String, SpawnedSession>>,
}

struct SpawnedSession {
    child: std::process::Child,
    session: McpSession<std::io::BufReader<std::process::ChildStdout>, std::process::ChildStdin>,
}

impl McpPool {
    /// **검사를 통과한 목록만 받는다.** 통과하지 못한 서버는 아예 존재하지 않는다.
    pub fn new(servers: Vec<McpServerConfig>) -> Result<Self, McpConfigError> {
        validate_servers(&servers)?;
        Ok(Self { servers, sessions: std::sync::Mutex::new(BTreeMap::new()) })
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    pub fn names(&self) -> Vec<String> {
        self.servers.iter().map(|s| s.name.clone()).collect()
    }

    /// 등록 요약 — 이름과 **좁혀진 도구** (state-machine 37절).
    ///
    /// 도구 목록을 함께 내는 이유: "서버 3개 등록됨"만 보면 사용자는 그 서버들이 무엇이든
    /// 부를 수 있다고 읽는다. 좁혔다는 사실은 좁힌 사람에게도 잊힌다.
    pub fn summary(&self) -> Vec<Value> {
        self.servers
            .iter()
            .map(|s| {
                json!({
                    "name": s.name,
                    "program": s.program,
                    "args": s.args,
                    "tools": s.tools,
                })
            })
            .collect()
    }

    /// 도구 하나를 부른다. 서버가 아직 안 떠 있으면 띄우고 핸드셰이크한다.
    pub fn call(&self, call: &McpCall) -> Result<Value, McpError> {
        let config = self
            .servers
            .iter()
            .find(|s| s.name == call.server)
            // **등록되지 않은 서버는 프로토콜 위반이 아니라 설정 문제다.** 사용자가 고칠 곳이
            // 다르므로 사유에 등록된 이름을 함께 낸다.
            .ok_or_else(|| {
                McpError::Protocol(format!(
                    "등록되지 않은 MCP 서버입니다: {} (등록된 것: {})",
                    call.server,
                    if self.servers.is_empty() { "없음".to_string() } else { self.names().join(", ") }
                ))
            })?;

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| McpError::Transport("세션 잠금이 오염되었습니다".to_string()))?;
        if !sessions.contains_key(&call.server) {
            sessions.insert(call.server.clone(), spawn_session(config)?);
        }
        let entry = sessions
            .get_mut(&call.server)
            .ok_or_else(|| McpError::Transport("세션을 만들지 못했습니다".to_string()))?;
        entry.session.call_tool(call)
    }

    /// 이 호출이 **등록의 범위 안인가** (state-machine 32절).
    ///
    /// # 왜 게이트가 이걸 묻는가
    ///
    /// 실행 직전에 물으면 사용자는 이미 승인을 누른 뒤다. **승인을 물은 뒤에 거부하면
    /// 사용자는 자기 승인이 의미 없었다고 배우고**, 그 학습은 진짜 승인 화면에도 옮는다.
    ///
    /// # 이 함수는 좁히기만 한다
    ///
    /// 돌려주는 것은 `Ok`(=원래대로 승인을 묻는다) 아니면 `Err`(=거부)뿐이다. **자동 허용을
    /// 만들 수 있는 반환값이 없다** — 23.3절의 "정책으로 낮출 수 없다"가 여기서도 유지되는
    /// 이유는 게이트가 이 값을 안 보기 때문이 아니라, 이 값이 낮출 수 있는 모양이 아니기
    /// 때문이다.
    pub fn gate_check(&self, call: &McpCall) -> Result<(), McpRefusal> {
        let Some(config) = self.servers.iter().find(|s| s.name == call.server) else {
            return Err(McpRefusal::UnknownServer {
                server: call.server.clone(),
                registered: self.names(),
            });
        };
        match &config.tools {
            None => Ok(()),
            Some(allowed) if allowed.iter().any(|t| t == &call.tool) => Ok(()),
            Some(allowed) => Err(McpRefusal::ToolNotAllowed {
                server: call.server.clone(),
                tool: call.tool.clone(),
                allowed: allowed.clone(),
            }),
        }
    }

    /// **띄우는 방법이 없는 읽기 전용 뷰** (state-machine 64절).
    ///
    /// 미리보기는 등록을 알아야 하지만 서버를 띄우면 안 된다 — "아무것도 쓰지 않는다"는
    /// 약속(47절)은 프로세스를 하나 띄우는 것만으로도 깨진다. 그 규칙을 주석으로 두면
    /// 언젠가 누가 더 정확한 탐침을 만들려고 `catalog()`를 부른다.
    ///
    /// 그래서 뷰를 따로 낸다. 이 타입에는 `spawn`으로 가는 길이 **없으므로**, 미리보기가
    /// 서버를 띄우지 않는다는 것은 검사가 지키는 성질이 아니라 **컴파일러가 지키는 성질**이다.
    ///
    /// 복사본이 아니라 빌린 것이다(32절: "목록을 복사해 넣으면 등록과 게이트가 갈라진다").
    pub fn registration(&self) -> Registration<'_> {
        Registration { servers: &self.servers }
    }

    /// 등록된 서버들이 **실제로 내놓는 도구 목록**을 모은다 (state-machine 31절).
    ///
    /// # 왜 이게 필요한가
    ///
    /// 이것이 없으면 모델은 `mcp_call`을 부를 수 없다 — 서버 이름도 도구 이름도 인자 모양도
    /// 모르기 때문이다. 등록만 해두고 이 목록을 내지 않으면 **문은 있는데 걸어 들어갈 길이
    /// 없는 상태**가 된다.
    ///
    /// # 실패한 서버를 목록에서 지우지 않는다
    ///
    /// 지우면 "도구가 없는 서버"와 "물어보지 못한 서버"가 같은 모양이 되고, 모델은 그 서버를
    /// 없는 것으로 읽는다. 사유를 담아 남긴다.
    ///
    /// # 서버를 띄운다 — 그래서 실패가 태스크를 죽이면 안 된다
    ///
    /// 이 호출은 등록된 서버를 실제로 spawn하고 핸드셰이크한다. 서버 하나가 죽어 있다고
    /// 태스크가 시작되지 못하면, 사용자는 관계없는 작업을 하려다 막힌다.
    pub fn catalog(&self) -> Catalog {
        let mut servers = Vec::new();
        for config in &self.servers {
            servers.push(self.catalog_one(config));
        }
        Catalog::new(servers)
    }

    fn catalog_one(&self, config: &McpServerConfig) -> ServerCatalog {
        let mut sessions = match self.sessions.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return ServerCatalog::failed(&config.name, "세션 잠금이 오염되었습니다");
            }
        };
        if !sessions.contains_key(&config.name) {
            match spawn_session(config) {
                Ok(session) => {
                    sessions.insert(config.name.clone(), session);
                }
                Err(e) => return ServerCatalog::failed(&config.name, &e.to_string()),
            }
        }
        let Some(entry) = sessions.get_mut(&config.name) else {
            return ServerCatalog::failed(&config.name, "세션을 만들지 못했습니다");
        };
        match entry.session.list_tools() {
            // **허용목록을 여기서 적용한다**(32절). 게이트가 거부할 도구를 목록에 실으면
            // 모델은 거부될 것을 요청하고, 사용자는 이유 없는 거부 모달을 본다 —
            // 보여주는 집합과 부를 수 있는 집합은 같은 곳에서 나와야 한다.
            Ok(tools) => ServerCatalog::listed(&config.name, tools, config.tools.as_deref()),
            Err(e) => ServerCatalog::failed(&config.name, &e.to_string()),
        }
    }

    /// 띄운 서버를 모두 종료한다. **태스크가 끝나면 반드시 부른다** — 남기면 사용자가 모르는
    /// 프로세스가 계속 돈다.
    pub fn shutdown(&self) {
        let Ok(mut sessions) = self.sessions.lock() else { return };
        for (_, mut entry) in std::mem::take(&mut *sessions) {
            let _ = entry.child.kill();
            let _ = entry.child.wait();
        }
    }
}

/// 등록을 **읽기만** 하는 뷰 — state-machine 64절.
///
/// `McpPool`을 그대로 넘기면 받는 쪽이 `catalog()`를 부를 수 있고, 그건 서버를 띄운다.
/// 미리보기처럼 "아무것도 하지 않는다"를 약속한 자리에는 그 능력이 아예 없어야 한다.
pub struct Registration<'a> {
    servers: &'a [McpServerConfig],
}

impl Registration<'_> {
    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    pub fn names(&self) -> Vec<String> {
        self.servers.iter().map(|s| s.name.clone()).collect()
    }

    /// **`gate_check`를 통과하는 호출 하나** — 미리보기의 대표 요청에 쓴다.
    ///
    /// 등록된 서버가 없으면 `None`이다. 도구 허용목록이 있으면 그 안에서 고른다 — 목록 밖
    /// 이름을 쓰면 그 탐침은 "등록 밖 거부"가 되어 **등록되지 않은 경우와 구별되지 않는다.**
    ///
    /// 허용목록이 없으면 아무 이름이나 통과하므로 대표적인 이름을 쓴다. 이 이름은 서버가
    /// 실제로 내놓는 도구가 아닐 수 있다 — **그래도 상관없다**: 여기서 묻는 것은 "이 서버의
    /// 도구를 부르면 무인에서 어떻게 되는가"이고, 게이트의 답은 도구 이름이 실재하는지에
    /// 달려 있지 않다. 실재를 확인하려면 서버를 띄워야 하고, 그건 이 타입이 할 수 없는 일이다.
    pub fn probe_call(&self) -> Option<(String, String)> {
        let server = self.servers.first()?;
        let tool = match &server.tools {
            // 빈 허용목록은 `validate_servers`가 막지만, 막는 쪽이 바뀌어도 여기서 없는
            // 이름을 지어내지 않는다 — 지어내면 그 탐침이 조용히 틀린 답을 보고한다.
            Some(allowed) => allowed.first()?.clone(),
            None => "any".to_string(),
        };
        Some((server.name.clone(), tool))
    }
}

/// 등록의 범위를 벗어난 호출 (state-machine 32절).
///
/// **"안 된다"만 말하지 않는다** — 사용자가 다음에 할 일이 이유마다 다르다. 서버 이름이
/// 틀린 것과 도구가 목록 밖인 것은 고칠 곳이 서로 다르다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpRefusal {
    UnknownServer { server: String, registered: Vec<String> },
    ToolNotAllowed { server: String, tool: String, allowed: Vec<String> },
}

impl std::fmt::Display for McpRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownServer { server, registered } => write!(
                f,
                "등록되지 않은 MCP 서버입니다: {server} (등록된 것: {}) — 등록은 사용자만 할 수 있습니다",
                if registered.is_empty() { "없음".to_string() } else { registered.join(", ") }
            ),
            Self::ToolNotAllowed { server, tool, allowed } => write!(
                f,
                "{server} 서버에서 허용된 도구가 아닙니다: {tool} (허용: {})",
                allowed.join(", ")
            ),
        }
    }
}

/// 한 서버가 내놓은 도구 하나.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolEntry {
    pub name: String,
    pub description: String,
    /// 인자 모양. **이게 없으면 모델은 인자 이름을 추측하고, 서버가 거부한다.**
    pub input_schema: Value,
}

/// 한 서버의 조회 결과. **성공과 실패가 같은 타입에 있다** — 실패한 서버를 목록에서 빼면
/// "도구가 없는 서버"와 구별되지 않는다.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerCatalog {
    pub server: String,
    pub tools: Vec<ToolEntry>,
    /// 물어보지 못했다면 왜인가. `Some`이면 `tools`는 "없다"가 아니라 **"모른다"**이다.
    pub error: Option<String>,
    /// 상한에 걸려 일부만 담겼는가.
    pub truncated: bool,
    /// 상한 전에 이 서버가 내놓은 도구 수. **허용목록으로 걸러내기 전의 수다.**
    pub listed_count: usize,
    /// 사용자가 허용목록에 적었는데 **서버가 내놓지 않은** 도구 (32절).
    ///
    /// 대개 오타다. 조용히 넘기면 그 도구는 목록에도 없고 부르면 거부되는데, 사용자는
    /// 자기가 허용해 두었다고 믿는다 — 어디서도 원인을 볼 수 없는 상태가 된다.
    pub unknown_allowlisted: Vec<String>,
    /// 허용목록으로 좁혀졌는가.
    pub narrowed: bool,
}

/// 한 서버에서 프롬프트에 실을 수 있는 도구의 최대 개수.
///
/// **유도한 값이 아니라 관례적 선택이다.** 서버가 도구를 몇 개 내놓는지는 서버마다 다르고,
/// 실사용 분포를 아직 모른다. 상한이 없으면 프롬프트가 서버 설정에 따라 무한정 자란다(원칙 5).
pub const MAX_TOOLS_PER_SERVER: usize = 20;

/// 도구 하나의 인자 스키마를 프롬프트에 실을 때의 최대 바이트.
///
/// 넘으면 **자르지 않고 통째로 뺀다.** 잘린 JSON 스키마는 읽는 쪽에서 유효한 스키마처럼
/// 보이면서 실제와 다르고, 그 차이는 모델이 만든 인자가 거부될 때에야 드러난다.
pub const MAX_SCHEMA_BYTES: usize = 1_200;

#[derive(Debug, Clone, PartialEq)]
pub struct Catalog {
    pub servers: Vec<ServerCatalog>,
}

impl ServerCatalog {
    fn failed(server: &str, detail: &str) -> Self {
        Self {
            server: server.to_string(),
            tools: Vec::new(),
            error: Some(detail.to_string()),
            truncated: false,
            listed_count: 0,
            unknown_allowlisted: Vec::new(),
            narrowed: false,
        }
    }

    /// `allowed`가 `Some`이면 그 목록 밖의 도구는 **목록에서 빠진다**(32절).
    fn listed(server: &str, raw: Vec<Value>, allowed: Option<&[String]>) -> Self {
        let offered: Vec<String> = raw
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        let unknown_allowlisted: Vec<String> = allowed
            .map(|list| {
                list.iter()
                    .filter(|t| !offered.iter().any(|o| o == *t))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let raw: Vec<Value> = match allowed {
            None => raw,
            Some(list) => raw
                .into_iter()
                .filter(|t| {
                    t.get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| list.iter().any(|a| a == name))
                })
                .collect(),
        };
        let listed_count = raw.len();
        let tools: Vec<ToolEntry> = raw
            .into_iter()
            .take(MAX_TOOLS_PER_SERVER)
            .filter_map(|tool| {
                // 이름 없는 도구는 부를 수 없다 — 목록에 넣으면 모델이 부르려다 실패한다.
                let name = tool.get("name").and_then(Value::as_str)?.to_string();
                Some(ToolEntry {
                    name,
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("(설명 없음)")
                        .to_string(),
                    input_schema: tool.get("inputSchema").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        Self {
            server: server.to_string(),
            truncated: listed_count > MAX_TOOLS_PER_SERVER,
            listed_count,
            tools,
            error: None,
            unknown_allowlisted,
            narrowed: allowed.is_some(),
        }
    }
}

impl Catalog {
    pub fn new(servers: Vec<ServerCatalog>) -> Self {
        Self { servers }
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    pub fn server_count(&self) -> usize {
        self.servers.len()
    }

    pub fn tool_count(&self) -> usize {
        self.servers.iter().map(|s| s.tools.len()).sum()
    }

    pub fn truncated(&self) -> bool {
        self.servers.iter().any(|s| s.truncated)
    }

    /// 감사 이벤트에 남길 요약 (32절). **프롬프트에 실리는 텍스트와 다른 것을 담는다** —
    /// 오타 난 허용목록처럼 모델에게는 잡음이고 사용자에게는 원인인 사실이 여기 있다.
    pub fn audit(&self) -> Value {
        Value::Array(
            self.servers
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "server": s.server,
                        "toolCount": s.tools.len(),
                        "listedCount": s.listed_count,
                        "truncated": s.truncated,
                        "narrowed": s.narrowed,
                        // 비어 있지 않으면 **사용자가 고칠 것이 있다는 뜻이다.**
                        "unknownAllowlisted": s.unknown_allowlisted,
                        "error": s.error,
                    })
                })
                .collect(),
        )
    }

    /// 프롬프트에 실릴 문장.
    ///
    /// **부르는 방법을 함께 적는다.** 목록만 주면 모델은 그것을 참고 사항으로 읽고, 부를
    /// 자리(`mcpCalls`)가 있다는 것을 모른다.
    ///
    /// **승인이 필요하다는 것도 적는다.** 적지 않으면 모델은 도구가 즉시 실행된다고 가정하고
    /// 계획을 세우며, 거부됐을 때의 대안을 내놓지 않는다.
    pub fn render(&self) -> String {
        let mut lines = vec![
            "These MCP servers are registered by the USER. You may request their tools via `mcpCalls`.".to_string(),
            "Every call is judged by the Policy Gate and requires the user's approval — it may be refused.".to_string(),
            "Requesting a tool DISCARDS this draft: the tools run, their results are added, and you are asked again.".to_string(),
            "Leave `mcpCalls` empty unless you actually need one.".to_string(),
        ];
        for server in &self.servers {
            lines.push(String::new());
            lines.push(format!("### server: {}", server.server));
            if let Some(error) = &server.error {
                // **"도구가 없다"가 아니라 "모른다"라고 적는다.**
                lines.push(format!(
                    "(could NOT be queried: {error} — its tools are UNKNOWN, not absent. Do not call it.)"
                ));
                continue;
            }
            if server.tools.is_empty() {
                lines.push("(this server reports no tools)".to_string());
                continue;
            }
            if server.narrowed {
                // **좁혀졌다는 사실을 적는다.** 적지 않으면 모델은 이 서버가 원래 도구가
                // 적은 것으로 읽고, 없는 도구를 찾다 포기하는 대신 목록 밖의 것을 요청한다.
                lines.push("(the user restricted this server to the tools listed below)".to_string());
            }
            if server.truncated {
                lines.push(format!(
                    "(NOTE: {} of {} tools shown — the rest are omitted. Do not assume the omitted ones do not exist.)",
                    server.tools.len(),
                    server.listed_count
                ));
            }
            for tool in &server.tools {
                lines.push(format!("- {}: {}", tool.name, tool.description));
                let schema = serde_json::to_string(&tool.input_schema).unwrap_or_default();
                if tool.input_schema.is_null() {
                    lines.push("  arguments: (the server did not declare a schema)".to_string());
                } else if schema.len() > MAX_SCHEMA_BYTES {
                    // 자른 스키마를 주지 않는다 — 유효해 보이면서 실제와 다르다.
                    lines.push(format!(
                        "  arguments: (schema omitted — {} bytes, over the {MAX_SCHEMA_BYTES}-byte limit)",
                        schema.len()
                    ));
                } else {
                    lines.push(format!("  arguments: {schema}"));
                }
            }
        }
        lines.join("\n")
    }
}

impl Drop for McpPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 환경을 비운 뒤 **되돌려주는 최소 집합**.
///
/// `env_clear()`만 하면 `node`·`npx` 같은 이름을 찾을 수 없다(PATH가 없으므로). 실측으로
/// `No such file or directory`가 났다 — 그리고 그 오류는 "서버 설정이 틀렸다"로 읽히기 쉽다.
///
/// 그래서 **이름을 대고** 되돌려준다. 목록에 없는 것은 넘어가지 않으므로 `OPENAI_API_KEY`
/// 같은 값은 서버가 보지 못한다. Windows 항목이 함께 있는 이유는 그쪽에서 이 둘이 없으면
/// 프로세스 생성 자체가 실패하기 때문이다.
fn minimal_env() -> Vec<(String, String)> {
    ["PATH", "SystemRoot", "PATHEXT", "TEMP", "TMP"]
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| ((*key).to_string(), value)))
        .collect()
}

fn spawn_session(config: &McpServerConfig) -> Result<SpawnedSession, McpError> {
    let mut command = std::process::Command::new(&config.program);
    command
        .args(&config.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // **stderr는 물려주지 않는다.** 서버 로그가 우리 stdout에 섞이면 NDJSON 프레임이 깨진다.
        .stderr(std::process::Stdio::null())
        // **부모 환경을 물려주지 않는다.** API 키가 우리가 모르는 프로세스로 나가지 않도록,
        // 등록에 적힌 것만 넘긴다(원칙 3의 정신).
        .env_clear()
        .envs(minimal_env())
        .envs(&config.env);
    let mut child = command
        .spawn()
        .map_err(|e| McpError::Transport(format!("{} 서버를 띄우지 못했습니다: {e}", config.name)))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| McpError::Transport("서버 stdout을 열지 못했습니다".to_string()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| McpError::Transport("서버 stdin을 열지 못했습니다".to_string()))?;
    let mut session = McpSession::new(std::io::BufReader::new(stdout), stdin);
    // 핸드셰이크가 실패하면 **프로세스를 남기지 않는다.**
    if let Err(e) = session.initialize("tomverse-code") {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok(SpawnedSession { child, session })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // ---- 등록 뷰 (64절) ----

    fn config(name: &str, tools: Option<Vec<String>>) -> McpServerConfig {
        McpServerConfig {
            name: name.to_string(),
            program: "node".to_string(),
            args: vec!["s.js".to_string()],
            env: Default::default(),
            tools,
        }
    }

    /// **허용목록이 있으면 그 안에서 고른다.** 밖의 이름을 쓰면 게이트가 `ToolNotAllowed`로
    /// 거부하고, 그러면 그 탐침은 **등록되지 않은 경우와 같은 답**을 낸다 — 등록을 반영한
    /// 것이 아니게 된다.
    #[test]
    fn the_probe_call_passes_its_own_gate_check() {
        for tools in [None, Some(vec!["append".to_string(), "read".to_string()])] {
            let pool = McpPool::new(vec![config("notes", tools.clone())]).unwrap();
            let (server, tool) = pool.registration().probe_call().expect("탐침을 만들지 못했습니다");
            assert_eq!(server, "notes");
            // **게이트에 그대로 태워서 확인한다.** 이름 비교로 대신하면 규칙이 바뀔 때
            // 검사가 따라가지 못한다.
            let call = McpCall { server, tool, arguments: json!({}) };
            assert!(pool.gate_check(&call).is_ok(), "{tools:?}에서 만든 탐침이 거부됩니다");
        }
    }

    /// 등록이 없으면 **지어내지 않는다.** 없는 서버 이름으로 만든 탐침은 "등록 밖 거부"가
    /// 되어 등록되지 않은 경우와 구별되지 않는다.
    #[test]
    fn an_empty_registration_has_no_probe_call() {
        let pool = McpPool::new(Vec::new()).unwrap();
        assert!(pool.registration().is_empty());
        assert!(pool.registration().probe_call().is_none());
    }

    // ---- 도구 카탈로그 (31절) ----

    fn tool(name: &str, description: &str, schema: Value) -> Value {
        json!({ "name": name, "description": description, "inputSchema": schema })
    }

    fn tiny_schema() -> Value {
        json!({ "type": "object", "properties": { "text": { "type": "string" } } })
    }

    /// **인자 스키마가 프롬프트에 실려야 한다.** 없으면 모델이 인자 이름을 추측하고, 그
    /// 추측은 서버가 거부할 때에야 드러난다.
    #[test]
    fn the_catalog_carries_the_argument_schema() {
        let catalog = Catalog::new(vec![ServerCatalog::listed(
            "notes",
            vec![tool("append", "노트를 덧붙인다", tiny_schema())],
            None,
        )]);
        let rendered = catalog.render();
        assert!(rendered.contains("### server: notes"), "{rendered}");
        assert!(rendered.contains("append"), "{rendered}");
        assert!(rendered.contains("\"properties\""), "스키마가 실리지 않았습니다: {rendered}");
        assert_eq!(catalog.tool_count(), 1);
    }

    /// **부르는 방법과 승인이 필요하다는 사실을 함께 적는다.** 목록만 주면 모델은 그것을
    /// 참고 사항으로 읽고, 부를 자리가 있다는 것도 거부될 수 있다는 것도 모른다.
    #[test]
    fn the_catalog_says_how_to_call_and_that_approval_is_required() {
        let catalog = Catalog::new(vec![ServerCatalog::listed("notes", vec![tool("append", "d", tiny_schema())], None)]);
        let rendered = catalog.render();
        assert!(rendered.contains("mcpCalls"), "부를 자리를 말하지 않습니다: {rendered}");
        assert!(rendered.contains("approval"), "승인이 필요하다는 것을 말하지 않습니다: {rendered}");
    }

    /// 물어보지 못한 서버는 **"도구가 없다"가 아니라 "모른다"**여야 한다. 목록에서 빼면
    /// 모델은 그 서버를 없는 것으로 읽는다.
    #[test]
    fn a_server_that_could_not_be_queried_is_unknown_not_empty() {
        let catalog = Catalog::new(vec![
            ServerCatalog::failed("broken", "핸드셰이크 실패"),
            ServerCatalog::listed("quiet", vec![], None),
        ]);
        let rendered = catalog.render();
        assert!(rendered.contains("broken"), "{rendered}");
        assert!(rendered.contains("UNKNOWN"), "실패한 서버를 '모른다'로 적지 않았습니다: {rendered}");
        // 도구가 없는 서버는 그렇게 말한다 — 실패와 같은 문장을 쓰지 않는다.
        assert!(rendered.contains("reports no tools"), "{rendered}");
        assert!(!rendered.contains("quiet: (could NOT"), "{rendered}");
    }

    /// 상한에 걸리면 **잘렸다는 사실을 적는다.** 조용히 자르면 모델은 이 목록이 전부라고 보고
    /// 목록에 없는 도구를 없는 것으로 취급한다.
    #[test]
    fn a_truncated_tool_list_says_so() {
        let many: Vec<Value> = (0..(MAX_TOOLS_PER_SERVER + 3))
            .map(|i| tool(&format!("t{i}"), "d", tiny_schema()))
            .collect();
        let entry = ServerCatalog::listed("big", many, None);
        assert_eq!(entry.tools.len(), MAX_TOOLS_PER_SERVER);
        assert!(entry.truncated);
        let rendered = Catalog::new(vec![entry]).render();
        assert!(rendered.contains("tools shown"), "{rendered}");
        assert!(rendered.contains("omitted"), "{rendered}");
    }

    /// **큰 스키마는 자르지 않고 통째로 뺀다.** 잘린 JSON은 유효한 스키마처럼 보이면서
    /// 실제와 다르고, 그 차이는 모델이 만든 인자가 거부될 때에야 드러난다.
    #[test]
    fn an_oversized_schema_is_omitted_rather_than_truncated() {
        let big = json!({ "type": "object", "description": "x".repeat(MAX_SCHEMA_BYTES + 100) });
        let rendered = Catalog::new(vec![ServerCatalog::listed("big", vec![tool("t", "d", big)], None)]).render();
        assert!(rendered.contains("schema omitted"), "{rendered}");
        assert!(!rendered.contains("xxxxxxxxxx"), "잘린 스키마가 실렸습니다");
    }

    /// 이름 없는 도구는 부를 수 없다 — 목록에 넣으면 모델이 부르려다 실패한다.
    #[test]
    fn a_tool_without_a_name_is_dropped() {
        let entry = ServerCatalog::listed("s", vec![json!({ "description": "이름이 없다" })], None);
        assert!(entry.tools.is_empty());
        // **내놓은 개수는 그대로 센다** — 버린 것을 없었던 것으로 만들지 않는다.
        assert_eq!(entry.listed_count, 1);
    }

    // ---- 서버별 도구 허용목록 (32절) ----

    fn allow(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// **보여주는 집합과 부를 수 있는 집합은 같은 곳에서 나온다.** 갈리면 모델이 거부될 것을
    /// 요청하고, 사용자는 이유 없는 거부 모달을 본다.
    #[test]
    fn the_catalog_and_the_gate_agree_on_what_is_allowed() {
        let allowed = allow(&["read"]);
        let entry = ServerCatalog::listed(
            "notes",
            vec![
                tool("read", "읽는다", tiny_schema()),
                tool("write", "쓴다", tiny_schema()),
            ],
            Some(&allowed),
        );
        let names: Vec<&str> = entry.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["read"], "{names:?}");

        let pool = McpPool::new(vec![McpServerConfig {
            name: "notes".to_string(),
            program: "node".to_string(),
            args: vec![],
            env: BTreeMap::new(),
            tools: Some(allowed),
        }])
        .unwrap();
        // 목록에 있는 것은 게이트를 지나고, 없는 것은 지나지 못한다.
        for name in &names {
            assert!(pool
                .gate_check(&McpCall {
                    server: "notes".to_string(),
                    tool: (*name).to_string(),
                    arguments: json!({}),
                })
                .is_ok());
        }
        assert!(pool
            .gate_check(&McpCall {
                server: "notes".to_string(),
                tool: "write".to_string(),
                arguments: json!({}),
            })
            .is_err());
    }

    /// **허용목록에 있는데 서버가 내놓지 않은 도구는 따로 센다.** 대개 오타이고, 조용히
    /// 넘기면 그 도구는 목록에도 없고 부르면 거부되는데 사용자는 허용해 두었다고 믿는다.
    #[test]
    fn a_typo_in_the_allowlist_is_recorded_not_swallowed() {
        let allowed = allow(&["read", "raed"]);
        let entry = ServerCatalog::listed("notes", vec![tool("read", "d", tiny_schema())], Some(&allowed));
        assert_eq!(entry.unknown_allowlisted, vec!["raed".to_string()]);
        assert!(entry.narrowed);
    }

    /// 좁히지 않은 서버는 `narrowed`가 false다 — "전부 허용"과 "하나만 허용"을 화면이
    /// 구별할 수 있어야 한다.
    #[test]
    fn a_server_without_an_allowlist_is_not_narrowed() {
        let entry = ServerCatalog::listed("notes", vec![tool("read", "d", tiny_schema())], None);
        assert!(!entry.narrowed);
        assert!(entry.unknown_allowlisted.is_empty());
    }

    /// 등록되지 않은 서버와 목록 밖 도구는 **다른 사유**다 — 사용자가 고칠 곳이 다르다.
    #[test]
    fn the_two_refusals_say_different_things() {
        let pool = McpPool::new(vec![McpServerConfig {
            name: "notes".to_string(),
            program: "node".to_string(),
            args: vec![],
            env: BTreeMap::new(),
            tools: Some(allow(&["read"])),
        }])
        .unwrap();
        let unknown = pool
            .gate_check(&McpCall { server: "other".to_string(), tool: "read".to_string(), arguments: json!({}) })
            .unwrap_err();
        let not_allowed = pool
            .gate_check(&McpCall { server: "notes".to_string(), tool: "write".to_string(), arguments: json!({}) })
            .unwrap_err();
        assert!(matches!(unknown, McpRefusal::UnknownServer { .. }));
        assert!(matches!(not_allowed, McpRefusal::ToolNotAllowed { .. }));
        assert_ne!(unknown.to_string(), not_allowed.to_string());
        // 등록된 것이 무엇인지 알려준다 — 알려주지 않으면 사용자가 이름을 맞출 방법이 없다.
        assert!(unknown.to_string().contains("notes"), "{unknown}");
    }

    /// **빈 허용목록은 오류다.** 아무 도구도 부를 수 없는 서버를 등록하는 것은 등록하지 않는
    /// 것과 같은데, 화면에는 등록된 것으로 보인다.
    #[test]
    fn an_empty_allowlist_is_rejected_at_registration() {
        let mut config = server("notes", "node");
        config.tools = Some(vec![]);
        assert!(matches!(
            validate_servers(&[config]).unwrap_err(),
            McpConfigError::EmptyToolAllowlist { .. }
        ));
    }

    #[test]
    fn a_blank_tool_name_in_the_allowlist_is_rejected() {
        let mut config = server("notes", "node");
        config.tools = Some(vec!["read".to_string(), "  ".to_string()]);
        assert!(matches!(
            validate_servers(&[config]).unwrap_err(),
            McpConfigError::EmptyToolName { .. }
        ));
    }

    fn server(name: &str, program: &str) -> McpServerConfig {
        McpServerConfig {
            name: name.to_string(),
            program: program.to_string(),
            args: vec![],
            env: BTreeMap::new(),
            tools: None,
        }
    }

    /// **program 자리에 셸 명령을 우겨넣는 것을 막는다.** argv 배열이라는 보장(원칙 6)은
    /// program이 하나의 실행 파일일 때만 성립한다.
    #[test]
    fn a_shell_command_in_the_program_slot_is_refused() {
        for program in ["sh -c 'rm -rf /'", "node a.js | tee x", "a && b", "a > b"] {
            let err = validate_servers(&[server("s", program)]).unwrap_err();
            assert!(matches!(err, McpConfigError::ShellLike { .. }), "{program}: {err:?}");
        }
        // 평범한 프로그램은 통과한다 — 위 거부가 전부를 막는 것이 아님을 확인한다.
        assert!(validate_servers(&[server("s", "node")]).is_ok());
        // **공백만으로 거부하지 않는다.** Windows의 정상적인 경로가 그렇게 생겼다.
        assert!(
            validate_servers(&[server("s", "C:\\Program Files\\nodejs\\node.exe")]).is_ok(),
            "공백이 있는 정상 경로를 거부했습니다"
        );
    }

    #[test]
    fn server_names_are_constrained_and_unique() {
        assert!(matches!(
            validate_servers(&[server("a b", "node")]).unwrap_err(),
            McpConfigError::InvalidName { .. }
        ));
        assert!(matches!(
            validate_servers(&[server("dup", "node"), server("dup", "node")]).unwrap_err(),
            McpConfigError::Duplicate { .. }
        ));
        assert!(validate_servers(&[server("fs-tools", "node"), server("db_2", "node")]).is_ok());
    }

    /// 승인 화면이 무엇을 보여줄지 정하지 못하는 요청은 승인받을 수 없다.
    #[test]
    fn a_call_we_cannot_describe_is_rejected() {
        assert!(parse_call(&json!({ "tool": "x" })).is_err(), "server 없음");
        assert!(parse_call(&json!({ "server": "s" })).is_err(), "tool 없음");
        assert!(parse_call(&json!({ "server": " ", "tool": "x" })).is_err(), "빈 server");
        // arguments는 **객체**여야 한다 — 배열이면 우리가 잘못 조립한 것이다.
        assert!(parse_call(&json!({ "server": "s", "tool": "x", "arguments": [1] })).is_err());
        // 없으면 빈 객체다(인자 없는 도구).
        let call = parse_call(&json!({ "server": "s", "tool": "x" })).unwrap();
        assert_eq!(call.arguments, json!({}));
    }

    /// **인자를 요약하거나 자르지 않는다.** 자르면 사용자가 승인한 것과 실제 나가는 것이 달라진다.
    #[test]
    fn the_approval_text_contains_the_arguments_verbatim() {
        let call = parse_call(&json!({
            "server": "fs",
            "tool": "write_file",
            "arguments": { "path": "/etc/hosts", "contents": "x".repeat(500) }
        }))
        .unwrap();
        let text = describe(&call);
        assert!(text.contains("fs"), "{text}");
        assert!(text.contains("write_file"), "{text}");
        assert!(text.contains("/etc/hosts"), "{text}");
        // 500자가 그대로 들어 있다 — 요약했다면 길이가 줄었을 것이다.
        assert!(text.len() > 500, "인자가 잘렸습니다: {}", text.len());
    }

    fn session_over(script: &str) -> McpSession<Cursor<Vec<u8>>, Vec<u8>> {
        McpSession::new(Cursor::new(script.as_bytes().to_vec()), Vec::new())
    }

    #[test]
    fn a_result_is_returned_for_our_id() {
        let mut s = session_over("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n");
        assert_eq!(s.call_tool(&McpCall {
            server: "s".into(),
            tool: "t".into(),
            arguments: json!({}),
        }).unwrap(), json!({ "ok": true }));
    }

    /// 서버는 알림(id 없음)과 로그를 섞어 보낸다. **그것을 응답으로 착각하면 엉뚱한 값을
    /// 결과로 쓴다** — 조용히 틀리는 종류의 실패다.
    #[test]
    fn notifications_and_noise_are_skipped_until_our_response() {
        let script = concat!(
            "server starting...\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n",
            "\n",
            "{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"other\":true}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"mine\":true}}\n"
        );
        let mut s = session_over(script);
        let got = s
            .call_tool(&McpCall { server: "s".into(), tool: "t".into(), arguments: json!({}) })
            .unwrap();
        assert_eq!(got, json!({ "mine": true }));
    }

    /// 서버가 낸 오류는 **우리 실패와 구별한다** — 고칠 곳이 다르다.
    #[test]
    fn a_server_error_is_its_own_kind() {
        let mut s = session_over("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"no such tool\"}}\n");
        let err = s
            .call_tool(&McpCall { server: "s".into(), tool: "t".into(), arguments: json!({}) })
            .unwrap_err();
        assert!(matches!(err, McpError::Server { code: -32601, .. }), "{err:?}");
    }

    #[test]
    fn a_closed_stream_is_a_transport_error_not_a_hang() {
        let mut s = session_over("");
        let err = s
            .call_tool(&McpCall { server: "s".into(), tool: "t".into(), arguments: json!({}) })
            .unwrap_err();
        assert!(matches!(err, McpError::Transport(_)), "{err:?}");
    }

    /// **상한을 넘긴 줄에서 계속 읽지 않는다.** 그 줄의 나머지가 스트림에 남아 다음 "줄"은
    /// 앞 메시지의 꼬리이므로, 프레임 동기를 잃은 채 파싱하면 조용히 엉뚱한 값을 쓴다.
    #[test]
    fn an_oversized_line_stops_the_session() {
        let huge = format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"{}\"}}\n", "x".repeat(MAX_LINE_BYTES));
        let mut s = session_over(&huge);
        let err = s
            .call_tool(&McpCall { server: "s".into(), tool: "t".into(), arguments: json!({}) })
            .unwrap_err();
        assert!(matches!(err, McpError::Transport(_)), "{err:?}");
    }

    /// 우리가 보낸 것이 JSON-RPC 한 줄이어야 한다 — 서버가 읽는 것은 이 바이트다.
    #[test]
    fn the_request_we_write_is_one_json_line() {
        let mut s = session_over("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
        s.call_tool(&McpCall {
            server: "s".into(),
            tool: "write".into(),
            arguments: json!({ "path": "a" }),
        })
        .unwrap();
        let written = String::from_utf8(s.writer.clone()).unwrap();
        assert_eq!(written.matches('\n').count(), 1, "{written}");
        let parsed: Value = serde_json::from_str(written.trim()).unwrap();
        assert_eq!(parsed["method"], "tools/call");
        // 도구 이름과 인자가 **그대로** 나간다 — 승인 화면이 보여준 것과 같아야 한다.
        assert_eq!(parsed["params"]["name"], "write");
        assert_eq!(parsed["params"]["arguments"], json!({ "path": "a" }));
    }

    #[test]
    fn list_tools_distinguishes_empty_from_missing() {
        let mut ok = session_over("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n");
        assert_eq!(ok.list_tools().unwrap().len(), 0);
        // tools 키가 없으면 MCP 서버가 아닌 것과 말하고 있다는 뜻이다 — 빈 목록과 뭉개지 않는다.
        let mut bad = session_over("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
        assert!(matches!(bad.list_tools().unwrap_err(), McpError::Protocol(_)));
    }

    /// **비운 환경에 되돌려주는 것은 이름을 댄 것뿐이다.** 목록이 넓어지면 API 키가 우리가
    /// 모르는 프로세스로 나간다.
    #[test]
    fn the_minimal_env_carries_no_secrets() {
        // 이 프로세스에 비밀 모양의 값을 심어도 목록에 없으면 넘어가지 않는다.
        std::env::set_var("OPENAI_API_KEY", "sk-should-not-travel");
        let passed = minimal_env();
        assert!(
            !passed.iter().any(|(k, _)| k.contains("API_KEY")),
            "비밀이 넘어갔습니다: {passed:?}"
        );
        // 그리고 실제로 무언가는 넘어간다 — 빈 목록이면 이 검사가 공허하다(그리고 서버가
        // 실행되지 않는다).
        assert!(passed.iter().any(|(k, _)| k == "PATH"), "PATH가 없어 서버를 찾을 수 없습니다");
    }

    /// 등록되지 않은 서버는 **설정 문제**로 말한다 — 등록된 이름을 함께 낸다.
    #[test]
    fn an_unregistered_server_names_what_is_registered() {
        let pool = McpPool::new(vec![server("fs", "node")]).unwrap();
        let err = pool
            .call(&McpCall { server: "db".into(), tool: "q".into(), arguments: json!({}) })
            .unwrap_err();
        match err {
            McpError::Protocol(message) => {
                assert!(message.contains("db"), "{message}");
                assert!(message.contains("fs"), "등록된 이름이 없습니다: {message}");
            }
            other => panic!("{other:?}"),
        }
    }
}
