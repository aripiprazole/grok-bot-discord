// When the bot answers, and how Discord history becomes model input. Pure functions, no I/O.

export const ERROR_PREFIX = "⚠️ ";
const SOURCES_PREFIX = "-# Sources:";
const MAX_SOURCES = 5;

/**
 * How to answer a message, mirroring Grok Bot's Slack behavior:
 * DMs always; channels when mentioned (the reply starts a thread); threads the bot
 * started or was pulled into; every message in LISTEN_CHANNEL_IDS.
 * Returns "dm" | "thread" | "channel" | null.
 */
export function respondMode(m, { listenChannelIds, followedThreads }) {
  if (m.authorIsBot) return null;
  if (m.isDM) return "dm";
  if (m.inThread) {
    const follows = m.threadOwnedByBot || followedThreads.has(m.channelId) || listenChannelIds.has(m.parentId);
    return m.mentionsBot || follows ? "thread" : null;
  }
  return m.mentionsBot || listenChannelIds.has(m.channelId) ? "channel" : null;
}

/**
 * history: oldest-first [{ isBot, authorName, content, attachments: [{ name, url }] }]
 * The bot's own messages become assistant turns (split replies are rejoined);
 * everyone else's are user turns prefixed with their display name.
 */
export function toInput(history) {
  const input = [];
  for (const m of history) {
    if (m.isBot) {
      if (m.content.startsWith(ERROR_PREFIX)) continue;
      const content = m.content
        .split("\n")
        .filter((line) => !line.startsWith(SOURCES_PREFIX))
        .join("\n")
        .trim();
      if (!content) continue;
      const last = input[input.length - 1];
      if (last?.role === "assistant") last.content += `\n${content}`;
      else input.push({ role: "assistant", content });
    } else {
      const files = m.attachments.map((a) => `[attachment: ${a.name} ${a.url}]`);
      const content = [m.content.trim(), ...files].filter(Boolean).join("\n");
      if (content) input.push({ role: "user", content: `${m.authorName}: ${content}` });
    }
  }
  return input;
}

export function buildInstructions({ botName, place, now = new Date(), extra }) {
  return [
    `You are ${botName}, an AI assistant powered by Grok, chatting on Discord ${place}.`,
    "Each message from a person starts with their display name; several people may be talking.",
    "Write Discord markdown: short paragraphs, lists, code blocks. Discord does not render tables, so never use them.",
    "Be concise and direct. Never @mention anyone, and never use @everyone or @here.",
    `Current date and time (UTC): ${now.toISOString()}.`,
    extra,
  ]
    .filter(Boolean)
    .join("\n");
}

const hostname = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// Appends compact source links; <url> keeps Discord from expanding each one into an embed.
export function formatReply(text, sources = []) {
  const body = text.trim() || "I don't have an answer for that.";
  const links = sources.slice(0, MAX_SOURCES).map((s) => `[${hostname(s.url).replace(/[[\]]/g, "")}](<${s.url}>)`);
  return links.length ? `${body}\n${SOURCES_PREFIX} ${links.join(" · ")}` : body;
}

export function threadName(text) {
  const firstLine = text
    .replace(/<a?:\w+:\d+>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return "Chat with Grok";
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}
