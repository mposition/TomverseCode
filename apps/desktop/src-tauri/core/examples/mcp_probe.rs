//! MCP **spawn 경로**의 수동 확인기 — mcp.rs, state-machine 23절.
//!
//! # 왜 테스트가 아니라 example인가
//!
//! `McpSession`의 프로토콜 처리는 in-memory 스트림으로 전부 테스트된다(sidecar.rs가 줄 읽기를
//! 순수 함수로 두고 테스트한 것과 같은 방식). 그러나 **프로세스를 실제로 띄우는 부분**은
//! 그렇게 검증되지 않는다: `env_clear` 뒤 PATH 복구, stderr를 물려주지 않는 것, 핸드셰이크가
//! 실패했을 때 프로세스를 남기지 않는 것.
//!
//! 그 부분을 `cargo test`에 넣으면 **신뢰 경계 크레이트가 Node에 의존하게 된다.** `core/`를
//! tauri에서 떼어낸 이유가 "보안 로직의 테스트 가능성을 다른 것의 설치 여부에 인질로 잡히지
//! 않기 위해서"인데(CLAUDE.md), Node를 요구하면 같은 인질이 다른 이름으로 돌아온다.
//!
//! 그래서 Windows 전용 코드와 같은 처리를 한다 — **자동 검증 밖이라는 것을 이름으로 말하고,
//! 사람이 돌리는 확인기를 남긴다.**
//!
//! ```text
//! cargo run --example mcp_probe -- <서버 스크립트 경로>
//! ```
//!
//! 기대 출력은 그 서버가 돌려준 `tools/call` 결과 JSON이다. 실패하면 어느 단계에서
//! 실패했는지가 오류 문구에 들어 있다(띄우기 / 핸드셰이크 / 호출).

fn main() {
    let Some(script) = std::env::args().nth(1) else {
        eprintln!("usage: mcp_probe <서버 스크립트 경로> [도구 이름]");
        std::process::exit(2);
    };
    let tool = std::env::args().nth(2).unwrap_or_else(|| "echo".to_string());

    let config = tomverse_core::mcp::McpServerConfig {
        name: "probe".to_string(),
        program: "node".to_string(),
        args: vec![script],
        env: Default::default(),
    };
    let pool = match tomverse_core::mcp::McpPool::new(vec![config]) {
        Ok(pool) => pool,
        Err(e) => {
            eprintln!("등록 거부: {e}");
            std::process::exit(1);
        }
    };
    let call = tomverse_core::mcp::McpCall {
        server: "probe".to_string(),
        tool,
        arguments: serde_json::json!({ "x": 1 }),
    };
    match pool.call(&call) {
        Ok(value) => println!("{}", serde_json::to_string(&value).unwrap_or_default()),
        Err(e) => {
            eprintln!("{e}");
            pool.shutdown();
            std::process::exit(1);
        }
    }
    // **띄운 서버를 반드시 내린다.** 확인기라도 프로세스를 남기면 안 된다.
    pool.shutdown();
}
