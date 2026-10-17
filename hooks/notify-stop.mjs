#!/usr/bin/env node
// `stop` hook: posts "Agent finished in <workspace>" to a Discord webhook when an agent run ends.
// Opt-in: does nothing unless DISCORD_WEBHOOK_URL is set or ~/.cursor/discord-bot.json has "webhookUrl".
// Never blocks the agent: always replies {} and exits within a few seconds.

import { isWebhookUrl, notification, webhookUrl } from "./notify.mjs";

const TIMEOUT_MS = 5_000;

setTimeout(() => {
  process.stdout.write("{}\n");
  process.exit(0);
}, TIMEOUT_MS + 2_000).unref();

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const input = JSON.parse((await readStdin()) || "{}");
  const url = webhookUrl();
  if (!url) return;
  if (!isWebhookUrl(url)) throw new Error("webhook URL must look like https://discord.com/api/webhooks/<id>/<token>");
  const content = notification(input);
  if (!content) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
}

main()
  .catch((err) => console.error(`discord-bot notify hook: ${err.message}`))
  .finally(() => process.stdout.write("{}\n"));
