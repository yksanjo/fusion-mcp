// No-mock tests: a real local HTTP server stands in for OpenRouter, and a real
// child-process MCP server is driven over real stdio. Nothing internal is mocked.
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// --- a tiny fake OpenRouter that records what it received --------------------
let lastBody = null;
const fake = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    lastBody = JSON.parse(data);
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.writeHead(401).end(JSON.stringify({ error: "no key" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: "openrouter/fusion",
      choices: [{ message: { role: "assistant", content: "FUSED ANSWER" } }],
      usage: { total_tokens: 1234, cost: 0.0042 },
    }));
  });
});
await new Promise((r) => fake.listen(0, r));
const port = fake.address().port;

// --- drive the MCP server over stdio ----------------------------------------
function startServer(env) {
  const child = spawn("node", ["server.mjs"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, OPENROUTER_BASE_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const queue = [];
  let waiters = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg);
      else queue.push(msg);
    }
  });
  const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res)));
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  return { child, next, send };
}

// --- run --------------------------------------------------------------------
const s = startServer({ OPENROUTER_API_KEY: "test-key" });

s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
let r = await s.next();
assert.equal(r.id, 1);
assert.equal(r.result.serverInfo.name, "fusion-mcp");
assert.ok(r.result.capabilities.tools);
ok("initialize returns serverInfo + tools capability");

s.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
r = await s.next();
assert.equal(r.result.tools.length, 1);
assert.equal(r.result.tools[0].name, "fusion_ask");
assert.deepEqual(r.result.tools[0].inputSchema.required, ["prompt"]);
ok("tools/list exposes fusion_ask with required prompt");

s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
  name: "fusion_ask",
  arguments: { prompt: "what is the capital of France?", analysis_models: ["a/b", "c/d"], judge_model: "e/f", max_tool_calls: 4 },
}});
r = await s.next();
assert.ok(!r.result.isError, "call should succeed");
assert.match(r.result.content[0].text, /FUSED ANSWER/);
assert.match(r.result.content[0].text, /1234/); // usage surfaced
ok("tools/call returns synthesized answer + usage");

// verify the request we built actually reached "OpenRouter" correctly
assert.equal(lastBody.model, "openrouter/fusion");
assert.equal(lastBody.messages[0].content, "what is the capital of France?");
assert.equal(lastBody.plugins[0].id, "fusion");
assert.deepEqual(lastBody.plugins[0].analysis_models, ["a/b", "c/d"]);
assert.equal(lastBody.plugins[0].model, "e/f");
assert.equal(lastBody.plugins[0].max_tool_calls, 4);
ok("outgoing request carries the fusion plugin config");

s.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
r = await s.next();
assert.ok(r.result.isError);
ok("unknown tool returns isError");

s.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fusion_ask", arguments: {} } });
r = await s.next();
assert.ok(r.result.isError);
assert.match(r.result.content[0].text, /prompt/);
ok("missing prompt returns isError");

// notification (no id) yields no response; ping after it proves the stream is intact
s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
s.send({ jsonrpc: "2.0", id: 6, method: "ping" });
r = await s.next();
assert.equal(r.id, 6);
ok("notification produces no reply; stream stays intact");

s.child.stdin.end();

// --- no-key path: a fresh server with OPENROUTER_API_KEY removed ------------
const s2 = startServer({ OPENROUTER_API_KEY: "" });
s2.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fusion_ask", arguments: { prompt: "hi" } } });
r = await s2.next();
assert.ok(r.result.isError);
assert.match(r.result.content[0].text, /OPENROUTER_API_KEY/);
ok("missing API key returns a clear isError");
s2.child.stdin.end();

fake.close();
console.log(`\n${passed} tests passed`);
