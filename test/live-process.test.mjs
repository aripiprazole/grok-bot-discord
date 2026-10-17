import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLiveClient } from "../server/live/client.mjs";
import { configHash, loadLiveConfig } from "../server/live/config.mjs";
import { nodeTooOld } from "../server/live/deps.mjs";
import { claim, livePaths, request } from "../server/live/ipc.mjs";

const DAEMON = fileURLToPath(new URL("../server/live/daemon.mjs", import.meta.url));
const shortDir = () => mkdtempSync(join(tmpdir(), "db-"));

test("one process per socket; a stale socket file is taken over", async () => {
  const path = join(shortDir(), "s.sock");
  const first = await claim(path, async (method, params) => (method === "echo" ? params : { configHash: "a" }));
  assert.ok(first);
  assert.equal(await claim(path, async () => null), null, "second claimant backs off while the first answers");
  assert.deepEqual(await request(path, "echo", { hi: 1 }), { hi: 1 });
  await assert.rejects(request(join(shortDir(), "missing.sock"), "ping", {}, 500));

  // Simulate a crash: the server stops answering but its socket file stays behind.
  await new Promise((resolve) => first.close(resolve));
  const second = await claim(path, async () => "new owner");
  assert.ok(second);
  assert.equal(await request(path, "anything"), "new owner");
  second.close();
});

test("paths are per bot token", () => {
  assert.notEqual(livePaths("a").socket, livePaths("b").socket);
  assert.match(livePaths("a", "/t").log, /^\/t\/discord-bot-[0-9a-f]{16}\.log$/);
});

test("node version check", () => {
  assert.equal(nodeTooOld("22.12.0"), null);
  assert.equal(nodeTooOld("26.1.0"), null);
  assert.match(nodeTooOld("20.18.1"), /22\.12\+ is required/);
});

test("live client starts the background process, and restarts it when settings change", async () => {
  const dir = shortDir();
  const env = { DISCORD_BOT_TOKEN: `t-${Date.now()}`, XAI_API_KEY: "x", TMPDIR: dir };
  const { socket } = livePaths(env.DISCORD_BOT_TOKEN);
  const servers = [];
  let launches = 0;
  // Stand-in for spawning daemon.mjs: serve the socket in-process with the hash the client expects.
  const spawnImpl = (_node, _args, opts) => {
    launches++;
    const hash = configHash(loadLiveConfig(opts.env), opts.env.DISCORD_BOT_PLUGIN_VERSION);
    claim(socket, async (method) => {
      if (method === "shutdown") servers.shift()?.close();
      return method === "ping" ? { configHash: hash } : `handled ${method}`;
    }).then((s) => s && servers.push(s));
    return { unref() {} };
  };
  const quiet = { error() {} };

  const v1 = createLiveClient({ env, version: "1", spawnImpl, log: quiet });
  assert.equal(await v1.call("status"), "handled status");
  assert.equal(await v1.call("status"), "handled status");
  assert.equal(launches, 1, "reuses the running process");

  const v2 = createLiveClient({ env: { ...env, ALLOWED_IDS: "123" }, version: "1", spawnImpl, log: quiet });
  assert.equal(await v2.call("status"), "handled status");
  assert.equal(launches, 2, "new settings → new process");
  for (const s of servers) s.close();

  const off = createLiveClient({ env: { DISCORD_BOT_TOKEN: "t" }, version: "1", spawnImpl, log: quiet });
  assert.equal(off.disabled, "Set XAI_API_KEY in the plugin settings.");
  await assert.rejects(off.call("status"), /XAI_API_KEY/);
});

test("background process refuses to start without settings", () => {
  const run = spawnSync(process.execPath, [DAEMON], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Set DISCORD_BOT_TOKEN and XAI_API_KEY/);
});
