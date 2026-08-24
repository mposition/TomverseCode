// 최소 MCP 서버 — stdio JSON-RPC. 로그를 stdout에 섞어 프레이밍 방어도 함께 확인한다.
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
