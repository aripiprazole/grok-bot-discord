// Text chat, Slack-style: DMs, @mentions (answered in a new thread), and threads the bot is in.
// In agent mode messages go to the inbox for the agent; in instant mode Grok answers right away.

import { ChannelType, ThreadAutoArchiveDuration } from "discord.js";
import { chunkMessage } from "../format.mjs";
import { channelAllowed, isAllowed } from "./config.mjs";
import { ERROR_PREFIX, buildInstructions, formatReply, respondMode, threadName, toInput } from "./conversation.mjs";

const TYPING_REFRESH_MS = 8_000;
export const NO_PINGS = { parse: [], repliedUser: false };
const THREADABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

// Shows "Bot is typing…" until stopped, or until `maxMs` passes.
export function keepTyping(channel, maxMs = Infinity) {
  const ping = () => channel.sendTyping().catch(() => {});
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  timer.unref?.(); // never the reason a process stays alive
  const stop = () => clearInterval(timer);
  if (Number.isFinite(maxMs)) setTimeout(stop, maxMs).unref?.();
  return stop;
}

// The thread to answer a channel @mention in, or null where threads aren't possible.
export async function startThread(message, log = console) {
  if (message.hasThread) return message.thread;
  if (!THREADABLE.has(message.channel.type)) return null;
  return message
    .startThread({ name: threadName(message.cleanContent), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay })
    .catch((err) => {
      log.warn(`Couldn't start a thread in #${message.channel.name}: ${err.message}`);
      return null;
    });
}

// Posts `text` (split at Discord's limit) to `target`; the first part replies to `replyTo` if given.
export async function post(target, text, replyTo = null, extras = null) {
  const sent = [];
  const chunks = text?.trim() ? chunkMessage(text) : extras ? [""] : [];
  for (const [i, content] of chunks.entries()) {
    const payload = { ...(content ? { content } : {}), allowedMentions: NO_PINGS, ...(i === 0 && extras ? extras : {}) };
    sent.push(i === 0 && replyTo ? await replyTo.reply(payload) : await target.send(payload));
  }
  return sent;
}

export function createChatHandler({ client, config, grok, agentInbox, followedThreads = new Set(), getPersona = () => null, log = console }) {
  const queues = new Map();

  // One reply at a time per conversation, so quick follow-ups don't interleave.
  async function enqueue(key, task) {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(key, next);
    try {
      return await next;
    } finally {
      if (queues.get(key) === next) queues.delete(key);
    }
  }

  const normalize = (m) => ({
    isBot: m.author.id === client.user.id,
    authorName: m.member?.displayName ?? m.author.displayName ?? m.author.username,
    content: m.cleanContent ?? "",
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
  });

  async function history(channel) {
    const fetched = await channel.messages.fetch({ limit: config.historyLimit });
    const messages = [...fetched.values()].reverse().filter((m) => !m.system);
    if (channel.isThread() && fetched.size < config.historyLimit) {
      const starter = await channel.fetchStarterMessage().catch(() => null);
      if (starter && !messages.some((m) => m.id === starter.id)) messages.unshift(starter);
    }
    return messages;
  }

  function place(channel) {
    if (channel.type === ChannelType.DM) return "in a direct message";
    const where = channel.isThread() ? `a thread in #${channel.parent?.name ?? "unknown"}` : `#${channel.name}`;
    return `in ${where} on the "${channel.guild.name}" server`;
  }

  async function respondInstantly(message, mode) {
    const thread = mode === "channel" ? await startThread(message, log) : null;
    const target = thread ?? message.channel;
    try {
      let messages;
      if (mode === "channel") {
        messages = [message];
        const ref = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
        if (ref) messages.unshift(ref);
      } else {
        messages = await history(message.channel);
      }
      if (target.isThread()) followedThreads.add(target.id);

      const stopTyping = keepTyping(target);
      let answer;
      try {
        answer = await grok.reply({
          instructions: buildInstructions({ botName: client.user.username, place: place(target), extra: [getPersona(), config.systemPrompt].filter(Boolean).join("\n") }),
          input: toInput(messages.map(normalize)),
        });
      } finally {
        stopTyping();
      }
      // Without a thread (no permission, or a voice channel's chat), reply to the message for context.
      await post(target, formatReply(answer.text, answer.sources), !thread && mode === "channel" ? message : null);
    } catch (err) {
      log.error(err);
      const detail = err.message?.slice(0, 300) ?? "unknown error";
      await target.send({ content: `${ERROR_PREFIX}Couldn't get a reply from Grok: ${detail}`, allowedMentions: NO_PINGS }).catch(() => {});
    }
  }

  return async function onMessage(message) {
    if (message.author.bot || message.system) return;
    if (!channelAllowed(message.channel, config)) return;
    const me = client.user.id;
    const { channel } = message;
    const mode = respondMode(
      {
        authorIsBot: message.author.bot,
        isDM: channel.type === ChannelType.DM,
        inThread: channel.isThread(),
        threadOwnedByBot: channel.isThread() && channel.ownerId === me,
        mentionsBot: message.mentions.users.has(me) || message.mentions.repliedUser?.id === me,
        channelId: channel.id,
        parentId: channel.parentId ?? null,
      },
      { listenChannelIds: config.listenChannelIds, followedThreads },
    );
    if (!mode) return;
    if (!isAllowed(message.author.id, message.member?.roles.cache.keys() ?? [], config)) {
      if (mode !== "thread" || message.mentions.users.has(me)) await message.react("🔒").catch(() => {});
      return;
    }
    if (agentInbox) return agentInbox.enqueue(message, mode);
    await enqueue(mode === "channel" ? message.id : channel.id, () => respondInstantly(message, mode));
  };
}
