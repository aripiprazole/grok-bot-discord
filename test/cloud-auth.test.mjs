import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeBearer, tokensMatch } from "../server/cloud/auth.mjs";
import { handleMcpHttp } from "../server/cloud/mcp-http.mjs";
import { createHandler } from "../server/mcp-core.mjs";

test("bearer auth fails closed and accepts the header or query token", async () => {
  assert.equal(await tokensMatch("same", "same"), true);
  assert.equal(await tokensMatch("same", "other"), false);
  const missing = await authorizeBearer(new Request("https://bot.example/mcp"), "");
  assert.equal(missing.status, 503);
  const bad = await authorizeBearer(new Request("https://bot.example/mcp", { headers: { Authorization: "Bearer nope" } }), "secret");
  assert.equal(bad.status, 401);
  const query = await authorizeBearer(new Request("https://bot.example/mcp?token=secret"), "secret");
  assert.equal(query.ok, true);
});

test("mcp http speaks json and a single sse event", async () => {
  const handleLine = createHandler({ config: { token: "t" }, live: { disabled: "off", call: async () => {} } });
  const init = await handleMcpHttp(
    new Request("https://bot.example/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    }),
    handleLine,
  );
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.version, "0.4.0");

  const sse = await handleMcpHttp(
    new Request("https://bot.example/mcp", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    handleLine,
  );
  const sseText = await sse.text();
  assert.match(sseText, /event: message\ndata: /);
  assert.match(sseText, /say_in_voice_call/);
  assert.equal((await handleMcpHttp(new Request("https://bot.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), handleLine)).status, 202);
  assert.equal((await handleMcpHttp(new Request("https://bot.example/mcp"), handleLine)).status, 405);
});
