import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType } from "discord.js";
import { createChatHandler } from "../server/live/chat.mjs";
import { loadLiveConfig } from "../server/live/config.mjs";

const BOT = { id: "BOT", username: "Grok" };
const guild = { name: "Team" };
const quietLog = { error() {}, warn() {} };

function channel({ type = ChannelType.GuildText, id = "chan", thread = false, ownerId, parent, history = [] } = {}) {
  const sent = [];
  return {
    id,
    type,
    name: thread ? "a-thread" : "general",
    guild,
    ownerId,
    parentId: parent?.id ?? null,
    parent,
    sent,
    isThread: () => thread,
    sendTyping: async () => {},
    send: async (opts) => sent.push(opts),
    messages: { fetch: async () => new Map([...history].reverse().map((m) => [m.id, m])) },
    fetchStarterMessage: async () => null,
  };
}

function message({ id = "m1", author = "ana", content = "hi", ch, mentions = true, roles = [] }) {
  const replies = [];
  const reactions = [];
  const msg = {
    id,
    system: false,
    author: { id: author, bot: false, username: author, displayName: author.toUpperCase() },
    member: { displayName: `${author}!`, roles: { cache: new Map(roles.map((r) => [r, {}])) } },
    channel: ch,
    cleanContent: content,
    attachments: new Map(),
    mentions: { users: new Map(mentions ? [[BOT.id, BOT]] : []), repliedUser: null },
    reference: null,
    hasThread: false,
    replies,
    reactions,
    reply: async (opts) => replies.push(opts),
    react: async (emoji) => reactions.push(emoji),
  };
  return msg;
}

function setup(env = {}, answer = { text: "Hello!", sources: [] }) {
  const calls = [];
  const grok = {
    reply: async (req) => {
      calls.push(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const config = loadLiveConfig({ DISCORD_BOT_TOKEN: "d", XAI_API_KEY: "x", ...env });
  return { calls, onMessage: createChatHandler({ client: { user: BOT }, config, grok, log: quietLog }) };
}

test("a mention in a channel starts a thread and answers there without pinging", async () => {
  const { calls, onMessage } = setup();
  const ch = channel();
  const thread = channel({ id: "t1", thread: true, ownerId: BOT.id, parent: ch });
  const msg = message({ content: "@Grok summarize the outage", ch });
  let threadName;
  msg.startThread = async ({ name }) => {
    threadName = name;
    return thread;
  };
  await onMessage(msg);
  assert.equal(threadName, "@Grok summarize the outage");
  assert.deepEqual(calls[0].input, [{ role: "user", content: "ana!: @Grok summarize the outage" }]);
  assert.match(calls[0].instructions, /in a thread in #general on the "Team" server/);
  assert.deepEqual(thread.sent, [{ content: "Hello!", allowedMentions: { parse: [], repliedUser: false } }]);
  assert.equal(ch.sent.length + msg.replies.length, 0);

  // Follow-ups in that thread need no mention and include the thread history.
  const bot = { ...message({ id: "m2", author: BOT.id, content: "Hello!", ch: thread }), author: { id: BOT.id, bot: true, username: "Grok" } };
  const followUp = message({ id: "m3", author: "bo", content: "and the root cause?", ch: thread, mentions: false });
  thread.messages.fetch = async () => new Map([followUp, bot].map((m) => [m.id, m]));
  await onMessage(followUp);
  assert.deepEqual(calls[1].input, [
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "bo!: and the root cause?" },
  ]);
  assert.equal(thread.sent.length, 2);
});

test("without thread permission it replies inline", async () => {
  const { onMessage } = setup();
  const ch = channel();
  const msg = message({ ch });
  msg.startThread = async () => {
    throw new Error("Missing Permissions");
  };
  await onMessage(msg);
  assert.equal(msg.replies.length, 1);
  assert.equal(msg.replies[0].content, "Hello!");
});

test("DMs answer every message with DM history", async () => {
  const { calls, onMessage } = setup();
  const dm = channel({ type: ChannelType.DM, id: "dm" });
  const msg = message({ content: "yo", ch: dm, mentions: false });
  dm.messages.fetch = async () => new Map([[msg.id, msg]]);
  await onMessage(msg);
  assert.match(calls[0].instructions, /in a direct message/);
  assert.equal(dm.sent[0].content, "Hello!");
});

test("ignores unmentioned channel chatter and blocks people off the allowlist", async () => {
  const { calls, onMessage } = setup({ ALLOWED_IDS: "staff" });
  await onMessage(message({ ch: channel(), mentions: false, roles: ["staff"] }));
  const outsider = message({ ch: channel(), roles: ["guest"] });
  await onMessage(outsider);
  assert.equal(calls.length, 0);
  assert.deepEqual(outsider.reactions, ["🔒"]);
});

test("long answers are split and errors are reported in the conversation", async () => {
  const long = setup({}, { text: "word ".repeat(900), sources: [{ url: "https://example.com" }] });
  const dm = channel({ type: ChannelType.DM });
  const msg = message({ ch: dm, mentions: false });
  dm.messages.fetch = async () => new Map([[msg.id, msg]]);
  await long.onMessage(msg);
  assert.equal(dm.sent.length, 3);
  assert.ok(dm.sent.every((m) => m.content.length <= 2000));
  assert.match(dm.sent.at(-1).content, /-# Sources: \[example\.com\]\(<https:\/\/example\.com>\)$/);

  const failing = setup({}, new Error("xAI API 429: rate limited"));
  const dm2 = channel({ type: ChannelType.DM });
  const msg2 = message({ ch: dm2, mentions: false });
  dm2.messages.fetch = async () => new Map([[msg2.id, msg2]]);
  await failing.onMessage(msg2);
  assert.equal(dm2.sent[0].content, "⚠️ Couldn't get a reply from Grok: xAI API 429: rate limited");
});
