import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// docs/design/process-architecture.md 3절 스모크 테스트 화면 —
// Rust core가 Node sidecar를 spawn하고 ping 왕복이 되는지만 확인한다.
// 실제 채팅/작업 화면은 docs/design/ui-wireframes.md 3.1절 참조 (아직 미구현).

type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; protocolVersion: string }
  | { status: "error"; message: string };

function App() {
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting" });

  useEffect(() => {
    invoke<{ pong: boolean; protocolVersion: string }>("check_sidecar_connection")
      .then((result) => setConnection({ status: "connected", protocolVersion: result.protocolVersion }))
      .catch((err) => setConnection({ status: "error", message: String(err) }));
  }, []);

  return (
    <main className="container">
      <h1>Tomverse Code</h1>
      <p>Node sidecar 연결 상태 (process-architecture.md 스모크 테스트)</p>
      {connection.status === "connecting" && <p>연결 확인 중...</p>}
      {connection.status === "connected" && (
        <p style={{ color: "green" }}>✓ 연결됨 — sidecar 프로토콜 버전 {connection.protocolVersion}</p>
      )}
      {connection.status === "error" && <p style={{ color: "red" }}>✗ 연결 실패: {connection.message}</p>}
    </main>
  );
}

export default App;
