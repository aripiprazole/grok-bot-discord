// Helpers for the `stop` notification hook (kept separate from the entry point so they can be tested).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".cursor", "discord-bot.json");

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?(?:\?.*)?$/;

export const isWebhookUrl = (url) => WEBHOOK.test(url);

// DISCORD_WEBHOOK_URL wins; otherwise "webhookUrl" from ~/.cursor/discord-bot.json.
export function webhookUrl(env = process.env, configPath = CONFIG_PATH) {
  const fromEnv = env.DISCORD_WEBHOOK_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return JSON.parse(readFileSync(configPath, "utf8")).webhookUrl?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Message for a `stop` hook payload, or null when nothing should be sent.
export function notification(input, env = process.env) {
  if (input.status === "aborted") return null; // the user stopped it, so they're already watching
  const root = input.workspace_roots?.[0] ?? env.CURSOR_PROJECT_DIR ?? "";
  const workspace = basename(root) || "workspace";
  const failed = input.status === "error";
  const model = input.model ? ` · ${input.model}` : "";
  return `${failed ? "⚠️" : "✅"} Agent ${failed ? "stopped with an error" : "finished"} in \`${workspace}\`${model}`;
}
