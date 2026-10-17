import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isWebhookUrl, notification, webhookUrl } from "../hooks/notify.mjs";

const HOOK = fileURLToPath(new URL("../hooks/notify-stop.mjs", import.meta.url));

test("notification text by status", () => {
  const roots = { workspace_roots: ["/Users/me/code/api-server"] };
  assert.equal(notification({ ...roots, status: "completed", model: "grok-5" }, {}), "✅ Agent finished in `api-server` · grok-5");
  assert.equal(notification({ ...roots, status: "error" }, {}), "⚠️ Agent stopped with an error in `api-server`");
  assert.equal(notification({ ...roots, status: "aborted" }, {}), null);
  assert.equal(notification({ status: "completed" }, { CURSOR_PROJECT_DIR: "/tmp/web" }), "✅ Agent finished in `web`");
});

test("webhook URL comes from env, then the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-bot-"));
  const file = join(dir, "discord-bot.json");
  assert.equal(webhookUrl({}, file), undefined);
  writeFileSync(file, JSON.stringify({ webhookUrl: " https://discord.com/api/webhooks/1/abc " }));
  assert.equal(webhookUrl({}, file), "https://discord.com/api/webhooks/1/abc");
  assert.equal(webhookUrl({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/2/x" }, file), "https://discord.com/api/webhooks/2/x");
});

test("only Discord webhook URLs are accepted", () => {
  assert.ok(isWebhookUrl("https://discord.com/api/webhooks/123/AbC-_9"));
  assert.ok(isWebhookUrl("https://ptb.discord.com/api/v10/webhooks/123/tok?thread_id=456"));
  assert.ok(!isWebhookUrl("https://evil.example/api/webhooks/123/tok"));
  assert.ok(!isWebhookUrl("http://discord.com/api/webhooks/123/tok"));
  assert.ok(!isWebhookUrl("https://discord.com.evil.example/api/webhooks/123/tok"));
});

test("hook is a silent no-op without a webhook", () => {
  const home = mkdtempSync(join(tmpdir(), "discord-bot-home-"));
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ status: "completed", workspace_roots: ["/x/y"] }),
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "{}\n");
  assert.equal(run.stderr, "");
});

test("hook reports a bad webhook URL but still succeeds", () => {
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ status: "completed" }),
    env: { PATH: process.env.PATH, DISCORD_WEBHOOK_URL: "https://example.com/hook" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "{}\n");
  assert.match(run.stderr, /webhook URL must look like/);
});
