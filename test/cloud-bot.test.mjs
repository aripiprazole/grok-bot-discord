import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudBot, withoutVoiceHost } from "../server/cloud/bot.mjs";
import { loadLiveConfig } from "../server/live/config.mjs";
import { buildEmbeds, buildPoll, richFields } from "../server/cloud/rich.mjs";

const GUILD = "100000000000000001";
const GENERAL = "100000000000000002";
const VOICE = "100000000000000003";
const BOT = "900000000000000000";

function fakeClient() {
  const calls = [];
  const client = {
    calls,
    async get(path) {
      calls.push({ method: "GET", path });
      if (path.endsWith("/messages")) return [];
      return [];
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      if (path.includes("/threads")) return { id: "200000000000000010", name: body.name };
      if (path.includes("/callback")) return null;
      return { id: "300000000000000010", channel_id: GENERAL };
    },
    async put(path, body) {
      calls.push({ method: "PUT", path, body });
      return null;
    },
    async patch(path, body) {
      calls.push({ method: "PATCH", path, body });
      return null;
    },
    async delete(path) {
      calls.push({ method: "DELETE", path });
      return null;
    },
  };
  return client;
}

function bot(client, env = {}) {
  const effects = [];
  const config = loadLiveConfig({
    DISCORD_BOT_TOKEN: "token",
    ELEVENLABS_API_KEY: "eleven",
    ROUTINE_WEBHOOK_URL: "https://api.cursor.com/automations/webhook/abc",
    ROUTINE_WEBHOOK_KEY: "key",
    ...env,
  });
  const created = createCloudBot({
    config,
    client,
    log: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => new Response("ok"),
    onEffects: async (batch) => effects.push(...batch),
  });
  return { bot: created, effects };
}

async function online(client, created) {
  await created.dispatch("READY", { user: { id: BOT, username: "Nova", bot: true }, application: { id: "app" }, session_id: "s", resume_gateway_url: "wss://gateway.discord.gg" });
  await created.dispatch("GUILD_CREATE", {
    id: GUILD,
    name: "Team",
    channels: [
      { id: GENERAL, name: "general", type: 0 },
      { id: VOICE, name: "Talk", type: 2 },
    ],
    voice_states: [{ user_id: "111111111111111111", channel_id: VOICE }],
  });
}

test("mentions land in the inbox and an inline reply does not start a thread", async () => {
  const client = fakeClient();
  const { bot: created } = bot(client);
  await online(client, created);
  await created.dispatch("MESSAGE_CREATE", {
    id: "400000000000000001",
    type: 0,
    channel_id: GENERAL,
    guild_id: GUILD,
    timestamp: "2026-10-18T01:00:00.000Z",
    content: "hello nova",
    author: { id: "111111111111111111", username: "ana", global_name: "Ana" },
    mentions: [{ id: BOT }],
  });
  const view = await created.handle("inbox.check", {});
  const id = view.match(/item (\w+)/)[1];
  await created.handle("inbox.reply", { itemId: id, content: "inline", thread: false });
  assert.equal(client.calls.some((call) => call.path.includes("/threads")), false);
  const posted = client.calls.find((call) => call.method === "POST" && call.path === `/channels/${GENERAL}/messages`);
  assert.equal(posted.body.message_reference.message_id, "400000000000000001");
  assert.equal(posted.body.content, "inline");
});

test("an edit updates the inbox text and a delete is marked deleted", async () => {
  const client = fakeClient();
  const { bot: created } = bot(client);
  await online(client, created);
  await created.dispatch("MESSAGE_CREATE", {
    id: "400000000000000002",
    type: 0,
    channel_id: GENERAL,
    guild_id: GUILD,
    timestamp: "2026-10-18T01:00:00.000Z",
    content: "ship Friday",
    author: { id: "111111111111111111", username: "ana" },
    mentions: [{ id: BOT }],
  });
  await created.dispatch("MESSAGE_UPDATE", {
    id: "400000000000000002",
    channel_id: GENERAL,
    content: "ship Monday",
    edited_timestamp: "2026-10-18T02:00:00.000Z",
    author: { id: "111111111111111111", username: "ana" },
  });
  let view = await created.handle("inbox.check", {});
  assert.match(view, /ship Monday \(edited\)/);
  await created.dispatch("MESSAGE_DELETE", { id: "400000000000000002", channel_id: GENERAL });
  const notes = await created.handle("messages.revisions", { channelId: GENERAL, ids: ["400000000000000002"] });
  assert.equal(notes.byId["400000000000000002"].deleted, true);
  assert.equal(notes.byId["400000000000000002"].content, "ship Monday");
  view = created.inbox.items[0].messages[0];
  assert.equal(view.deleted, true);
  assert.equal(view.content, "ship Monday");
});

test("component presses are acknowledged and queued", async () => {
  const client = fakeClient();
  const { bot: created } = bot(client);
  await online(client, created);
  await created.dispatch("INTERACTION_CREATE", {
    type: 3,
    id: "500000000000000001",
    token: "tok",
    guild_id: GUILD,
    channel_id: GENERAL,
    data: { custom_id: "approve", component_type: 2 },
    member: { user: { id: "111111111111111111", username: "ana" }, nick: "Ana", roles: [] },
    message: { id: "400000000000000009", components: [{ type: 1, components: [{ type: 2, custom_id: "approve", label: "Approve" }] }] },
  });
  const ack = client.calls.find((call) => call.path.includes("/callback"));
  assert.equal(ack.body.type, 6);
  const view = await created.handle("inbox.check", {});
  assert.match(view, /component/);
  assert.match(view, /pressed button "Approve"/);
});

test("joining voice emits a start effect and say speaks into that call", async () => {
  const client = fakeClient();
  const { bot: created, effects } = bot(client);
  await online(client, created);
  const text = await created.handle("join", { channelId: VOICE, listenToUserId: null });
  assert.match(text, /Joined 🔊 Talk in Team/);
  assert.equal(effects.at(-1).type, "voice_start");
  assert.equal(effects.at(-1).spec.guildId, GUILD);
  assert.equal(await created.handle("voice.say", { content: "On my way." }), "Speaking in 🔊 Talk.");
  assert.equal(effects.at(-1).type, "voice_say");
  await created.dispatch("VOICE_STATE_UPDATE", { guild_id: GUILD, user_id: "111111111111111111", channel_id: null });
  assert.equal(effects.at(-1).type, "voice_stop");
});

test("rich send payload builds an embed, buttons, a select menu, and a poll", () => {
  const fields = richFields({
    embeds: [{ title: "Ship", description: "Monday", color: "#336699", fields: [{ name: "PR", value: "42", inline: true }] }],
    components: [
      { buttons: [{ label: "Approve", custom_id: "approve", style: "success" }, { label: "Docs", style: "link", url: "https://example.com" }] },
      { select: { custom_id: "pick", placeholder: "Choose", options: [{ label: "A", value: "a" }] } },
    ],
    poll: { question: "When?", answers: ["Monday", { text: "Tuesday", emoji: "📅" }], duration_hours: 8 },
  });
  assert.equal(fields.embeds[0].color, 0x336699);
  assert.equal(fields.components[0].components[0].custom_id, "approve");
  assert.equal(fields.components[0].components[1].url, "https://example.com");
  assert.equal(fields.components[1].components[0].type, 3);
  assert.equal(buildPoll({ question: "Q", answers: ["A"] }).duration, 24);
  assert.equal(buildEmbeds([{ title: "T" }])[0].title, "T");
});

test("a missing voice container is not reported as a missing ElevenLabs key", () => {
  const withKey = { voiceEnabled: true, persona: true };
  assert.deepEqual(withoutVoiceHost(withKey), {
    voiceEnabled: false,
    persona: true,
    voiceUnavailable: "the voice container isn't deployed",
  });
  const missingKey = { voiceEnabled: false };
  assert.equal(withoutVoiceHost(missingKey), missingKey);
});
