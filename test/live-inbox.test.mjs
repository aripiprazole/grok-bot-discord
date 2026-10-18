import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChannelType } from "discord.js";
import { createAgentInbox } from "../server/live/agent-inbox.mjs";
import { createChatHandler } from "../server/live/chat.mjs";
import { loadLiveConfig } from "../server/live/config.mjs";
import { Inbox, LEASE_MS, MAX_AGE_MS } from "../server/live/inbox.mjs";
import { Waker, checkWebhook } from "../server/live/waker.mjs";

const clock = (t = 1_000_000) => ({ t, now() { return this.t; } });
const msg = (id, extra = {}) => ({ id, authorId: "u1", authorName: "Ana", username: "ana", content: `hi ${id}`, attachments: [], at: "2026-10-17T14:03:00.000Z", url: `https://discord.com/channels/g/c/${id}`, ...extra });

test("inbox groups a conversation, leases claims, expires old items and survives restarts", () => {
  const file = join(mkdtempSync(join(tmpdir(), "inbox-")), "inbox.json");
  const c = clock();
  const inbox = new Inbox({ file, now: () => c.now() });
  const dm = { key: "c:dm1", kind: "dm", channelId: "dm1", place: "DM with Ana" };
  const a = inbox.add(dm, msg("1"));
  assert.equal(inbox.add(dm, msg("2")).id, a.id, "same conversation, one item");
  inbox.add({ key: "m:9", kind: "channel", channelId: "c1", place: "#general" }, msg("9"));
  assert.deepEqual(inbox.waiting(), { count: 2, oldestMs: 0 });

  const claimed = inbox.claim(1);
  assert.deepEqual(claimed.map((i) => i.messages.length), [2]);
  assert.equal(inbox.claim(5).length, 1, "a claimed item isn't handed out twice");
  const later = inbox.add(dm, msg("3"));
  assert.notEqual(later.id, a.id, "messages arriving mid-answer start a new item");

  c.t += LEASE_MS + 1;
  assert.equal(inbox.claim(10).length, 3, "expired leases come back");
  assert.deepEqual(new Inbox({ file }).items.map((i) => i.id), inbox.items.map((i) => i.id), "persisted");

  assert.equal(inbox.take(a.id).id, a.id);
  assert.equal(inbox.take(a.id), null);
  c.t += MAX_AGE_MS + 1;
  assert.equal(inbox.claim(10).length, 0, "day-old items are dropped");
});

test("waker validates the routine webhook", () => {
  assert.equal(checkWebhook({ url: "https://api.cursor.com/automations/webhook/abc123", key: "k" }), null);
  assert.match(checkWebhook({ url: "https://evil.example/hook", key: "k" }), /doesn't look like/);
  assert.match(checkWebhook({ url: "https://api.cursor.com/automations/webhook/a" }), /Both/);
});

test("waker batches bursts, posts with the key, and spaces out wake-ups", async () => {
  const calls = [];
  let pending = 2;
  const waker = new Waker({
    getWebhook: () => ({ url: "https://api.cursor.com/automations/webhook/r1", key: "secret" }),
    pending: () => pending,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(null, { status: 202 });
    },
    log: { warn() {} },
  });
  assert.equal(await waker.fire(), true);
  assert.equal(calls[0].url, "https://api.cursor.com/automations/webhook/r1");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
  assert.deepEqual(calls[0].body, { source: "discord", pending: 2, message: "2 Discord messages are waiting. Run the discord-inbox skill." });

  waker.notify();
  waker.notify();
  assert.ok(waker.timer, "one scheduled wake-up for a burst");
  clearTimeout(waker.timer);

  pending = 0;
  assert.equal(await waker.fire(), false, "nothing waiting, no wake-up");
  pending = 1;
  const failing = new Waker({ getWebhook: () => ({ url: "https://x.y/automations/webhook/r", key: "k" }), pending: () => 1, fetchImpl: async () => new Response("", { status: 401 }), log: { warn() {} } });
  assert.equal(await failing.fire(), false);
  assert.match(failing.status().lastError, /HTTP 401/);
  assert.deepEqual(new Waker({ getWebhook: () => null, pending: () => 1 }).status(), { connected: false });
});

// Minimal discord.js stand-ins.
function fakeDiscord() {
  const BOT = { id: "900000000000000000", username: "Nova", tag: "Nova#0001" };
  const channels = new Map();
  const removedSeen = [];
  function channel({ id, type = ChannelType.GuildText, name = "general", thread = false, history = [] }) {
    const ch = {
      id, type, name, guild: { name: "Team" }, parent: { name: "general" }, ownerId: null, parentId: null,
      sent: [], typing: 0, history,
      isThread: () => thread,
      sendTyping: async () => { ch.typing++; },
      send: async ({ content }) => { const m = { id: String(BigInt(id) + 1000n + BigInt(ch.sent.length)), url: `https://discord.com/channels/g/${id}/${ch.sent.length}`, content }; ch.sent.push(m); return m; },
      messages: {
        fetch: async (q) => {
          if (typeof q === "string") return ch.history.find((m) => m.id === q) ?? null;
          let list = [...ch.history];
          if (q.before) list = list.filter((m) => BigInt(m.id) < BigInt(q.before));
          return new Map(list.slice(-q.limit).reverse().map((m) => [m.id, m]));
        },
      },
    };
    channels.set(id, ch);
    return ch;
  }
  function message(ch, { id, author = "ana", content = "hello", bot = false }) {
    const m = {
      id, channel: ch, system: false, content, cleanContent: content, createdAt: new Date("2026-10-17T14:03:00Z"), url: `https://discord.com/channels/g/${ch.id}/${id}`,
      author: { id: bot ? BOT.id : `${author}-id`, username: bot ? BOT.username : author, displayName: bot ? BOT.username : author.toUpperCase(), bot },
      member: null, attachments: new Map(), hasThread: false, reacted: [],
      mentions: { users: new Map([[BOT.id, BOT]]), repliedUser: null },
      react: async (e) => m.reacted.push(e),
      reactions: { resolve: (e) => (m.reacted.includes(e) ? { users: { remove: async () => removedSeen.push(m.id) } } : null) },
    };
    ch.history.push(m);
    return m;
  }
  const client = { user: BOT, channels: { fetch: async (id) => channels.get(id) ?? null } };
  return { BOT, client, channel, message, removedSeen };
}

test("agent mode: 👀 on arrival, the agent sees the conversation, replies land in a new thread", async () => {
  const d = fakeDiscord();
  const general = d.channel({ id: "100000000000000000" });
  d.message(general, { id: "100000000000000001", author: "bo", content: "anyone up?" });
  const mention = d.message(general, { id: "100000000000000002", content: "@Nova what did we decide about the launch?" });
  const thread = d.channel({ id: "200000000000000000", thread: true, name: "launch" });
  mention.startThread = async () => thread;

  let woke = 0;
  const followedThreads = new Set();
  const agentInbox = createAgentInbox({ client: d.client, inbox: new Inbox(), followedThreads, onNewMessage: () => woke++, log: { warn() {} } });
  const onMessage = createChatHandler({ client: d.client, config: loadLiveConfig({ DISCORD_BOT_TOKEN: "t" }), agentInbox, followedThreads });
  await onMessage(mention);
  assert.deepEqual(mention.reacted, ["👀"]);
  assert.equal(woke, 1);

  const view = await agentInbox.check();
  assert.match(view, /1 Discord conversation to answer, as Nova/);
  const id = view.match(/item (\w+) · @mention · #general \(Team\)/)[1];
  assert.match(view, /  \[2026-10-17 14:03 UTC\] BO \(@bo, id bo-id\): anyone up\?/);
  assert.match(view, /→ \[2026-10-17 14:03 UTC\] ANA \(@ana, id ana-id\): @Nova what did we decide about the launch\?/);
  assert.ok(general.typing > 0, "shows typing while the agent works");

  assert.equal(await agentInbox.check(), "The Discord inbox is empty. Nothing to answer.", "claimed items aren't handed out twice");
  const done = await agentInbox.reply({ itemId: id, content: "We ship Friday — I wrote it down." });
  assert.match(done, /^Replied in #general \(Team\): https:/);
  assert.deepEqual(thread.sent.map((m) => m.content), ["We ship Friday — I wrote it down."]);
  assert.ok(followedThreads.has(thread.id), "follow-ups in the thread reach the agent too");
  assert.deepEqual(d.removedSeen, [mention.id], "👀 cleared");
  await assert.rejects(agentInbox.reply({ itemId: id, content: "again" }), /already answered or expired/);
});

test("thread false replies inline in the channel", async () => {
  const d = fakeDiscord();
  const general = d.channel({ id: "100000000000000000" });
  const mention = d.message(general, { id: "100000000000000002", content: "@Nova stay here" });
  mention.reply = async ({ content }) => general.send({ content });
  mention.startThread = async () => {
    throw new Error("should stay inline");
  };
  const agentInbox = createAgentInbox({ client: d.client, inbox: new Inbox(), log: { warn() {} } });
  const onMessage = createChatHandler({ client: d.client, config: loadLiveConfig({ DISCORD_BOT_TOKEN: "t" }), agentInbox });
  await onMessage(mention);
  const id = (await agentInbox.check()).match(/item (\w+)/)[1];
  await agentInbox.reply({ itemId: id, content: "inline", thread: false });
  assert.deepEqual(general.sent.map((m) => m.content), ["inline"]);
});

test("agent mode: DMs reply in place and can be skipped", async () => {
  const d = fakeDiscord();
  const dm = d.channel({ id: "300000000000000000", type: ChannelType.DM });
  const agentInbox = createAgentInbox({ client: d.client, inbox: new Inbox() });
  const onMessage = createChatHandler({ client: d.client, config: loadLiveConfig({ DISCORD_BOT_TOKEN: "t" }), agentInbox });
  await onMessage(d.message(dm, { id: "300000000000000001", content: "yo" }));
  await onMessage(d.message(dm, { id: "300000000000000002", content: "you there?" }));
  const view = await agentInbox.check();
  const id = view.match(/item (\w+) · direct message · DM with ANA/)[1];
  assert.equal((view.match(/^→/gm) ?? []).length, 2, "both new messages in one item");
  await agentInbox.reply({ itemId: id, content: "here!" });
  assert.deepEqual(dm.sent.map((m) => m.content), ["here!"]);

  await onMessage(d.message(dm, { id: "300000000000000003", content: "spam" }));
  const next = (await agentInbox.check()).match(/item (\w+)/)[1];
  assert.equal(await agentInbox.skip({ itemId: next }), "Skipped DM with ANA.");
  assert.equal(dm.sent.length, 1);
});
