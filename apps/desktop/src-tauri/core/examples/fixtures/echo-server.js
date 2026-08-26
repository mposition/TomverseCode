// 최소 MCP 서버 — stdio JSON-RPC. 로그를 stdout에 섞어 프레이밍 방어도 함께 확인한다.
//
// **argv[2]가 있으면 그 경로에 표식을 남긴다**(state-machine 64절). "띄우지 않았다"를
// 밖에서 관측할 방법이 달리 없기 때문이다 — 핸드셰이크가 실패하면 세션이 남지 않으므로
// 내부 상태로는 "띄우려다 실패한 것"과 "아예 안 띄운 것"이 같은 모양이 된다.
// 인자로 받는 이유는 이 프로세스의 cwd가 호출자의 것이라 상대 경로를 믿을 수 없어서다.
//
// **`import`다.** 이 파일은 `apps/desktop/package.json`의 `"type": "module"` 아래에 있어
// ESM으로 읽힌다 — `require`는 여기서 정의되지 않고, try/catch로 감싸면 그 실패가 조용히
// 삼켜져 "띄웠는데 표식이 없다"가 된다(실측으로 e2e가 그렇게 실패했다).
import { writeFileSync } from "node:fs";
if (process.argv[2]) {
  writeFileSync(process.argv[2], "spawned\n");
}
process.stdout.write("hello from a chatty server\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", serverInfo: { name: "fake" } });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "echo" }] });
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: `echoed:${JSON.stringify(msg.params.arguments)}` }] });
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } }) + "\n");
  }
});
