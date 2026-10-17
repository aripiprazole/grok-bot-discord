// Text chat: answers DMs, mentions and followed threads with Grok, Slack-style.

import { ChannelType, ThreadAutoArchiveDuration } from "discord.js";
import { chunkMessage } from "../format.mjs";
import { isAllowed } from "./config.mjs";
import { ERROR_PREFIX, buildInstructions, formatReply, respondMode, threadName, toInput } from "./conversation.mjs";

const TYPING_REFRESH_MS = 8_000;
const NO_PINGS = { parse: [], repliedUser: false };
const THREADABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function keepTyping(channel) {
  const ping = () => channel.sendTyping().catch(() => {});
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}

export function createChatHandler({ client, config, grok, log = console }) {
  const followedThreads = new Set();
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

  async function startThread(message) {
    if (message.hasThread) return message.thread;
    if (!THREADABLE.has(message.channel.type)) return null;
    return message
      .startThread({ name: threadName(message.cleanContent), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay })
      .catch((err) => {
        log.warn(`Couldn't start a thread in #${message.channel.name}: ${err.message}`);
        return null;
      });
  }

  function place(channel) {
    if (channel.type === ChannelType.DM) return "in a direct message";
    const where = channel.isThread() ? `a thread in #${channel.parent?.name ?? "unknown"}` : `#${channel.name}`;
    return `in ${where} on the "${channel.guild.name}" server`;
  }

  async function respond(message, mode) {
    const thread = mode === "channel" ? await startThread(message) : null;
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
          instructions: buildInstructions({ botName: client.user.username, place: place(target), extra: config.systemPrompt }),
          input: toInput(messages.map(normalize)),
        });
      } finally {
        stopTyping();
      }

      const chunks = chunkMessage(formatReply(answer.text, answer.sources));
      for (const [i, content] of chunks.entries()) {
        // Without a thread (DM fallback or no thread permission), reply to the message for context.
        if (i === 0 && !thread && mode === "channel") await message.reply({ content, allowedMentions: NO_PINGS });
        else await target.send({ content, allowedMentions: NO_PINGS });
      }
    } catch (err) {
      log.error(err);
      const detail = err.message?.slice(0, 300) ?? "unknown error";
      await target.send({ content: `${ERROR_PREFIX}Couldn't get a reply from Grok: ${detail}`, allowedMentions: NO_PINGS }).catch(() => {});
    }
  }

  return async function onMessage(message) {
    if (message.author.bot || message.system) return;
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
    await enqueue(mode === "channel" ? message.id : channel.id, () => respond(message, mode));
  };
}
