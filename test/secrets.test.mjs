import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChannelType } from "discord.js";
import { createChatHandler } from "../server/live/chat.mjs";
import { channelAllowed, loadLiveConfig } from "../server/live/config.mjs";
import { resolveSecretRefs } from "../server/secrets.mjs";

const TOKEN_REF = "op://Shared with Grok Bot/Gigaclanker/discord bot token";
const CHANNELS_REF = "op://Shared with Grok Bot/Gigaclanker/allowed channel ids";

test("op:// settings are read with the 1Password CLI; plain values pass through", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { [TOKEN_REF]: "tok-123\n", [CHANNELS_REF]: "111,222" }[args[2]];
  };
  const env = resolveSecretRefs({ DISCORD_BOT_TOKEN: TOKEN_REF, ALLOWED_CHANNEL_IDS: ` ${CHANNELS_REF} `, XAI_API_KEY: "plain", HOME: "/h" }, { exec });
  assert.equal(env.DISCORD_BOT_TOKEN, "tok-123");
  assert.equal(env.ALLOWED_CHANNEL_IDS, "111,222");
  assert.equal(env.XAI_API_KEY, "plain");
  assert.deepEqual(calls, [
    ["op", "read", "--no-newline", TOKEN_REF],
    ["op", "read", "--no-newline", CHANNELS_REF],
  ]);
  const noRefs = { DISCORD_BOT_TOKEN: "x" };
  assert.equal(resolveSecretRefs(noRefs, { exec: () => assert.fail("op not needed") }), noRefs);
});

test("1Password failures name the setting and the reason", () => {
  const missing = () => Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" });
  assert.throws(() => resolveSecretRefs({ DISCORD_BOT_TOKEN: TOKEN_REF }, { exec: () => { throw missing(); } }), /DISCORD_BOT_TOKEN.*1Password CLI \(op\) isn't installed/);
  const denied = () => Object.assign(new Error("exit 1"), { stderr: "[ERROR] could not find item Gigaclanker in vault\nmore" });
  assert.throws(() => resolveSecretRefs({ DISCORD_BOT_TOKEN: TOKEN_REF }, { exec: () => { throw denied(); } }), /could not find item Gigaclanker in vault$/);
});

test("the CLI resolves references from ~/.discord-bot-plugin/.env before running a tool", () => {
  const home = mkdtempSync(join(tmpdir(), "op-home-"));
  const bin = join(home, "op");
  // Fake op: prints a token for the token reference and nothing else.
  writeFileSync(bin, `#!/bin/sh\n[ "$3" = "${TOKEN_REF}" ] && printf 'from-1password' && exit 0\necho "[ERROR] not found" >&2; exit 1\n`);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, ".discord-bot-plugin"));
  writeFileSync(join(home, ".discord-bot-plugin", ".env"), `DISCORD_BOT_TOKEN="${TOKEN_REF}"\nOP_CLI_PATH=${bin}\n`);
  const entry = fileURLToPath(new URL("../server/index.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [entry, "read_messages", '{"channel_id": 1}'], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", timeout: 15_000 });
  assert.match(run.stderr, /must be a string/, "got past configuration, so the token resolved");

  writeFileSync(join(home, ".discord-bot-plugin", ".env"), `DISCORD_BOT_TOKEN="op://nope/x/y"\nOP_CLI_PATH=${bin}\n`);
  const bad = spawnSync(process.execPath, [entry, "list_servers"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", timeout: 15_000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Couldn't read DISCORD_BOT_TOKEN from 1Password \(op:\/\/nope\/x\/y\): \[ERROR\] not found/);
});

test("allowed channels: listed channels and their threads only; DMs unaffected", () => {
  const config = loadLiveConfig({ DISCORD_BOT_TOKEN: "t", ALLOWED_CHANNEL_IDS: "111, 222" });
  const guild = { name: "Team" };
  assert.ok(channelAllowed({ id: "111", guild }, config));
  assert.ok(channelAllowed({ id: "999", parentId: "222", guild }, config), "thread in an allowed channel");
  assert.ok(!channelAllowed({ id: "333", parentId: null, guild }, config));
  assert.ok(channelAllowed({ id: "dm" }, config), "DMs have no guild");
  assert.ok(channelAllowed({ id: "333", guild }, loadLiveConfig({ DISCORD_BOT_TOKEN: "t" })), "no list means everywhere");
});

test("messages in other channels never reach the inbox", async () => {
  const enqueued = [];
  const onMessage = createChatHandler({
    client: { user: { id: "BOT" } },
    config: loadLiveConfig({ DISCORD_BOT_TOKEN: "t", ALLOWED_CHANNEL_IDS: "111" }),
    agentInbox: { enqueue: async (m) => enqueued.push(m.id) },
  });
  const message = (id, channelId) => ({
    id, system: false, author: { id: "u", bot: false }, member: null,
    channel: { id: channelId, type: ChannelType.GuildText, guild: {}, parentId: null, isThread: () => false },
    mentions: { users: new Map([["BOT", {}]]), repliedUser: null },
  });
  await onMessage(message("a", "333"));
  await onMessage(message("b", "111"));
  assert.deepEqual(enqueued, ["b"]);
});
