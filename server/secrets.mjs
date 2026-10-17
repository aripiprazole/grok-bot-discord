// Settings can be 1Password secret references (op://vault/item/field). They're read with the
// 1Password CLI when the plugin starts, so secrets never sit in plain text in settings or files.

import { execFileSync } from "node:child_process";

export const SETTING_KEYS = [
  "DISCORD_BOT_TOKEN",
  "XAI_API_KEY",
  "REPLY_MODE",
  "ROUTINE_WEBHOOK_URL",
  "ROUTINE_WEBHOOK_KEY",
  "ALLOWED_IDS",
  "ALLOWED_CHANNEL_IDS",
  "LISTEN_CHANNEL_IDS",
  "DISCORD_DEFAULT_CHANNEL_ID",
  "SYSTEM_PROMPT",
];

const isReference = (value) => typeof value === "string" && value.trim().startsWith("op://");

// Returns a copy of `env` with every op:// setting replaced by its value. Throws a readable error.
export function resolveSecretRefs(env = process.env, { exec = execFileSync } = {}) {
  const refs = SETTING_KEYS.filter((key) => isReference(env[key]));
  if (!refs.length) return env;
  const op = env.OP_CLI_PATH || "op";
  const resolved = { ...env };
  for (const key of refs) {
    const ref = env[key].trim();
    try {
      resolved[key] = exec(op, ["read", "--no-newline", ref], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], env }).trim();
    } catch (err) {
      const reason =
        err.code === "ENOENT"
          ? "the 1Password CLI (op) isn't installed or isn't on PATH"
          : String(err.stderr || err.message).trim().split("\n")[0];
      throw new Error(`Couldn't read ${key} from 1Password (${ref}): ${reason}`);
    }
  }
  return resolved;
}
