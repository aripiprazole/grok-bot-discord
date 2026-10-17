// Text helpers: splitting long posts for Discord and rendering API objects for the agent.

export const MESSAGE_LIMIT = 2000;

const FENCE = /^\s*```/;
const CLOSE_FENCE = "\n```";

// Returns the opening fence line (e.g. "```js") if `text` ends inside a code block.
function openFence(text) {
  let open = null;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) open = open === null ? line.trim() : null;
  }
  return open;
}

// Splits text into messages of at most `limit` chars, preferring line breaks, then spaces.
// A code block cut in half is closed at the end of one chunk and reopened in the next.
export function chunkMessage(text, limit = MESSAGE_LIMIT) {
  const chunks = [];
  let rest = text.trimEnd();
  let carry = "";
  while (rest.length > 0) {
    const room = limit - CLOSE_FENCE.length - carry.length;
    let piece;
    if (rest.length <= room) {
      piece = rest;
      rest = "";
    } else {
      let cut = rest.lastIndexOf("\n", room);
      if (cut < room / 2) cut = rest.lastIndexOf(" ", room);
      if (cut < room / 2) cut = room;
      piece = rest.slice(0, cut);
      rest = rest.slice(cut).replace(/^[\n ]/, "");
    }
    let chunk = carry + piece;
    const fence = rest ? openFence(chunk) : null;
    if (fence) {
      chunk += CLOSE_FENCE;
      carry = `${fence}\n`;
    } else {
      carry = "";
    }
    chunks.push(chunk);
  }
  return chunks;
}

export function jumpLink(guildId, channelId, messageId) {
  const base = `https://discord.com/channels/${guildId ?? "@me"}/${channelId}`;
  return messageId ? `${base}/${messageId}` : base;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const indent = (text) => text.replace(/^/gm, "  ");

function authorName(author) {
  if (!author) return "unknown";
  const handle = `@${author.username}`;
  const name = author.global_name ? `${author.global_name} (${handle})` : handle;
  return author.bot ? `${name} [bot]` : name;
}

function formatTime(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const isHumanWithoutText = (m) =>
  !m.author?.bot && !m.content && !m.attachments?.length && !m.embeds?.length && !m.sticker_items?.length;

export function formatMessage(m) {
  const lines = [`[${formatTime(m.timestamp)}] ${authorName(m.author)} · id ${m.id}${m.edited_timestamp ? " · edited" : ""}`];
  if (m.referenced_message) {
    const quoted = truncate(m.referenced_message.content?.replace(/\s+/g, " ") ?? "", 80);
    lines.push(`  ↪ replying to ${authorName(m.referenced_message.author)} (${m.referenced_message.id}): "${quoted}"`);
  } else if (m.type === 19 && m.message_reference?.message_id) {
    lines.push(`  ↪ replying to ${m.message_reference.message_id}`);
  }
  if (m.content) lines.push(indent(m.content));
  else if (m.type !== 0 && m.type !== 19) lines.push(`  (system message, type ${m.type})`);
  for (const a of m.attachments ?? []) lines.push(`  📎 ${a.filename} ${a.url}`);
  for (const e of m.embeds ?? []) {
    const parts = [e.title, e.description && truncate(e.description, 200), e.url].filter(Boolean);
    if (parts.length) lines.push(`  [embed] ${parts.join(" — ")}`);
  }
  if (m.thread) lines.push(`  🧵 thread "${m.thread.name}" · id ${m.thread.id}`);
  if (m.reactions?.length) {
    lines.push(`  reactions: ${m.reactions.map((r) => `${r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name} ${r.count}`).join(", ")}`);
  }
  return lines.join("\n");
}

// `messages` arrive newest-first from the API; output is oldest-first.
export function formatMessages(messages) {
  const body = [...messages].reverse().map(formatMessage).join("\n\n");
  const humans = messages.filter((m) => !m.author?.bot && (m.type === 0 || m.type === 19));
  if (humans.length > 0 && humans.every(isHumanWithoutText)) {
    return `${body}\n\nNote: message text is empty. Enable "Message Content Intent" for the bot (Developer Portal → your app → Bot → Privileged Gateway Intents) so it can read messages.`;
  }
  return body;
}

const CHANNEL_TYPES = { 0: "text", 2: "voice", 5: "announcement", 13: "stage", 15: "forum", 16: "media" };

export function formatChannels(channels, threads = []) {
  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id);
  const threadsByParent = groupBy(threads, (t) => t.parent_id);
  const listed = channels.filter((c) => CHANNEL_TYPES[c.type]).sort(byPosition);
  const categories = channels.filter((c) => c.type === 4).sort(byPosition);

  const render = (c, pad) => {
    const out = [`${pad}#${c.name} (${CHANNEL_TYPES[c.type]}) · id ${c.id}`];
    for (const t of threadsByParent.get(c.id) ?? []) out.push(`${pad}  🧵 ${t.name} · id ${t.id}`);
    return out;
  };

  const lines = listed.filter((c) => !c.parent_id).flatMap((c) => render(c, ""));
  for (const cat of categories) {
    const children = listed.filter((c) => c.parent_id === cat.id);
    if (!children.length) continue;
    lines.push(`📁 ${cat.name}`, ...children.flatMap((c) => render(c, "  ")));
  }
  return lines.join("\n");
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}
