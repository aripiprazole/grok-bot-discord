import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../server/index.mjs", import.meta.url));
const cli = (args, { home = mkdtempSync(join(tmpdir(), "cli-home-")), input } = {}) =>
  spawnSync(process.execPath, [ENTRY, ...args], { env: { PATH: process.env.PATH, HOME: home }, input, encoding: "utf8", timeout: 15_000 });

test("help lists every tool with its arguments", () => {
  const run = cli(["help"]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage: grok-bot-discord <tool>/);
  assert.match(run.stdout, /reply_on_discord \{item_id, content\?/);
  assert.match(run.stdout, /check_discord_inbox \{limit\?\}/);
});

test("bad tool names and bad JSON are rejected", () => {
  assert.equal(cli(["nope"]).status, 2);
  const bad = cli(["read_messages", "{oops"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /one JSON object/);
});

test("tool errors exit 1 with the message on stderr", () => {
  const run = cli(["list_servers"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /DISCORD_BOT_TOKEN/);
});

test("settings are read from ~/.discord-bot-plugin/.env and JSON can come from stdin", () => {
  const home = mkdtempSync(join(tmpdir(), "cli-home-"));
  mkdirSync(join(home, ".discord-bot-plugin"));
  writeFileSync(join(home, ".discord-bot-plugin", ".env"), "DISCORD_BOT_TOKEN=abc\n");
  // A token is configured now, so the failure is about the channel, not the token.
  const run = cli(["read_messages", "-"], { home, input: '{"channel_id": 5}' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /must be a string/);
});
