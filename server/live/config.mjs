// Settings for the live Discord connection, read from the plugin's variables.

import { createHash } from "node:crypto";
import { list, setting } from "../settings.mjs";

export function loadLiveConfig(env = process.env) {
  return {
    token: setting(env.DISCORD_BOT_TOKEN),
    // Optional: needed for voice calls and for instant replies.
    xaiApiKey: setting(env.XAI_API_KEY),
    // "agent": messages wait in the inbox for your agent's routine to answer with its own memory and tools.
    // "instant": Grok answers right away through the xAI API (needs XAI_API_KEY).
    replyMode: setting(env.REPLY_MODE)?.toLowerCase() === "instant" ? "instant" : "agent",
    // A Grok Bot routine with a "When a webhook fires" trigger; called when messages arrive.
    routineWebhook: { url: setting(env.ROUTINE_WEBHOOK_URL), key: setting(env.ROUTINE_WEBHOOK_KEY) },
    // User or role IDs allowed to talk to the bot; empty means everyone.
    allowedIds: new Set(list(env.ALLOWED_IDS)),
    // If set, the bot ignores server channels not listed here (threads count by their parent). DMs aren't affected.
    allowedChannelIds: new Set(list(env.ALLOWED_CHANNEL_IDS)),
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
  return config.token ? null : "Set DISCORD_BOT_TOKEN in the plugin settings.";
}

// Instant replies fall back to the agent inbox when there is no xAI key.
export const effectiveReplyMode = (config) => (config.replyMode === "instant" && config.xaiApiKey ? "instant" : "agent");

// Changes when anything the background process depends on changes, so it can be restarted.
export function configHash(config, version) {
  const plain = {
    ...config,
    allowedIds: [...config.allowedIds].sort(),
    allowedChannelIds: [...config.allowedChannelIds].sort(),
    listenChannelIds: [...config.listenChannelIds].sort(),
    version,
  };
  return createHash("sha256").update(JSON.stringify(plain)).digest("hex").slice(0, 16);
}

// Whether the bot may act in this channel (a thread is judged by its parent channel).
export function channelAllowed(channel, config) {
  if (!config.allowedChannelIds.size || !channel.guild) return true;
  return config.allowedChannelIds.has(channel.id) || (channel.parentId != null && config.allowedChannelIds.has(channel.parentId));
}

export function isAllowed(userId, roleIds, config) {
  if (!config.allowedIds.size) return true;
  if (config.allowedIds.has(userId)) return true;
  for (const id of roleIds) if (config.allowedIds.has(id)) return true;
  return false;
}
