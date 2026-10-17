// Settings for the live Discord connection, read from the plugin's variables.

import { createHash } from "node:crypto";
import { list, setting } from "../settings.mjs";

export function loadLiveConfig(env = process.env) {
  return {
    token: setting(env.DISCORD_BOT_TOKEN),
    xaiApiKey: setting(env.XAI_API_KEY),
    // User or role IDs allowed to talk to the bot; empty means everyone.
    allowedIds: new Set(list(env.ALLOWED_IDS)),
    // Channels where the bot answers every message, not only @mentions.
    listenChannelIds: new Set(list(env.LISTEN_CHANNEL_IDS)),
    model: setting(env.GROK_MODEL) ?? "grok-4.7",
    tools: ["web_search", "x_search"],
    systemPrompt: setting(env.SYSTEM_PROMPT),
    historyLimit: 40,
    voice: {
      model: setting(env.GROK_VOICE_MODEL) ?? "grok-voice-latest",
      voice: setting(env.GROK_VOICE) ?? "eve",
      transcripts: true,
      maxMinutes: 60,
    },
  };
}

// Why the live connection can't start, or null when it can.
export function missingSettings(config) {
  const missing = [!config.token && "DISCORD_BOT_TOKEN", !config.xaiApiKey && "XAI_API_KEY"].filter(Boolean);
  return missing.length ? `Set ${missing.join(" and ")} in the plugin settings.` : null;
}

// Changes when anything the background process depends on changes, so it can be restarted.
export function configHash(config, version) {
  const plain = { ...config, allowedIds: [...config.allowedIds].sort(), listenChannelIds: [...config.listenChannelIds].sort(), version };
  return createHash("sha256").update(JSON.stringify(plain)).digest("hex").slice(0, 16);
}

export function isAllowed(userId, roleIds, config) {
  if (!config.allowedIds.size) return true;
  if (config.allowedIds.has(userId)) return true;
  for (const id of roleIds) if (config.allowedIds.has(id)) return true;
  return false;
}
