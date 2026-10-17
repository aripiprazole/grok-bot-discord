import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../server/index.mjs", import.meta.url));

// Runs the real server process and exchanges newline-delimited JSON-RPC with it.
async function session(messages) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, DISCORD_BOT_TOKEN: "${DISCORD_BOT_TOKEN}" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = [];
  createInterface({ input: child.stdout }).on("line", (line) => replies.push(JSON.parse(line)));
  for (const m of messages) child.stdin.write(typeof m === "string" ? `${m}\n` : `${JSON.stringify(m)}\n`);
  child.stdin.end();
  await once(child, "exit");
  return replies;
}

test("speaks MCP over stdio", async () => {
  const replies = await session([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_servers", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "resources/list" },
    { jsonrpc: "2.0", id: 6, method: "ping" },
    "{not json",
  ]);
  const byId = new Map(replies.map((r) => [r.id, r]));
  assert.equal(replies.length, 7, "notifications get no reply");

  const init = byId.get(1).result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  assert.equal(init.serverInfo.name, "discord-bot");

  const names = byId.get(2).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["list_servers", "list_channels", "read_messages", "send_message", "edit_message", "add_reaction", "create_thread", "discord_status", "join_voice_channel", "leave_voice_channel", "check_discord_inbox", "reply_on_discord", "skip_discord_message", "set_discord_persona", "connect_discord_routine"]);
  for (const t of byId.get(2).result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.handler, undefined);
  }

  assert.equal(byId.get(3).result.isError, true);
  assert.match(byId.get(3).result.content[0].text, /DISCORD_BOT_TOKEN/);
  assert.equal(byId.get(4).error.code, -32602);
  assert.equal(byId.get(5).error.code, -32601);
  assert.deepEqual(byId.get(6).result, {});
  assert.equal(byId.get(null).error.code, -32700);
});

test("unknown protocol versions get the latest supported one", async () => {
  const [reply] = await session([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }]);
  assert.equal(reply.result.protocolVersion, "2025-11-25");
});
