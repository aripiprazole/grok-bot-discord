import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, createToolContext, loadConfig } from "../server/tools.mjs";

const CHANNEL = "111111111111111111";
const GUILD = "222222222222222222";
const MESSAGE = "333333333333333333";

// Fake Discord API: `routes` maps "METHOD /path" to a response body or (body, url) => body.
function fakeDiscord(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const key = `${init.method} ${pathname.replace("/api/v10", "")}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, query: Object.fromEntries(searchParams), headers: init.headers });
    if (!(key in routes)) return new Response(JSON.stringify({ message: "Unknown route", code: 0 }), { status: 404 });
    const route = routes[key];
    const result = typeof route === "function" ? route(body, calls) : route;
    if (result instanceof Response) return result;
    return result === null ? new Response(null, { status: 204 }) : Response.json(result);
  };
  return { fetchImpl, calls };
}

function context(routes, config = {}) {
  const fake = fakeDiscord(routes);
  const ctx = createToolContext({ token: "Bot abc", ...config }, fake.fetchImpl);
  return { ctx, calls: fake.calls };
}

const channelRoute = { [`GET /channels/${CHANNEL}`]: { id: CHANNEL, type: 0, name: "dev", guild_id: GUILD } };

test("unset or placeholder variables count as missing", () => {
  assert.deepEqual(loadConfig({ DISCORD_BOT_TOKEN: "${DISCORD_BOT_TOKEN}", DISCORD_DEFAULT_CHANNEL_ID: "  " }), {
    token: undefined,
    defaultChannelId: undefined,
  });
});

test("tools explain how to configure a missing token", async () => {
  const result = await callTool("list_servers", {}, createToolContext({}));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DISCORD_BOT_TOKEN/);
});

test("send_message posts to the default channel with safe mentions and auth", async () => {
  const { ctx, calls } = context(
    { ...channelRoute, [`POST /channels/${CHANNEL}/messages`]: { id: MESSAGE } },
    { defaultChannelId: CHANNEL },
  );
  const result = await callTool("send_message", { content: "Shipped **v2** <@444444444444444444>", silent: true }, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, new RegExp(`Sent 1 message to #dev:\\nhttps://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`));
  const post = calls.find((c) => c.key.startsWith("POST"));
  assert.deepEqual(post.body, {
    content: "Shipped **v2** <@444444444444444444>",
    allowed_mentions: { parse: ["users"] },
    flags: 4096,
  });
  assert.equal(post.headers.Authorization, "Bot abc");
});

test("send_message accepts a message link as the reply target and splits long text", async () => {
  let n = 0;
  const { ctx, calls } = context({
    ...channelRoute,
    [`POST /channels/${CHANNEL}/messages`]: () => ({ id: String(900000000000000000n + BigInt(n++)) }),
  });
  const content = Array.from({ length: 120 }, (_, i) => `update line ${i} ${"-".repeat(30)}`).join("\n");
  const result = await callTool(
    "send_message",
    { content, reply_to_message_id: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}` },
    ctx,
  );
  const posts = calls.filter((c) => c.key.startsWith("POST"));
  assert.ok(posts.length > 1);
  assert.deepEqual(posts[0].body.message_reference, { message_id: MESSAGE, fail_if_not_exists: false });
  assert.equal(posts[1].body.message_reference, undefined);
  assert.match(result.content[0].text, /split at Discord's 2000-character limit/);
});

test("missing channel without a default is a clear input error", async () => {
  const { ctx } = context({});
  const result = await callTool("read_messages", {}, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Pass channel_id/);
});

test("numeric IDs are rejected because they lose precision", async () => {
  const { ctx } = context({});
  const result = await callTool("read_messages", { channel_id: 111111111111111111 }, ctx);
  assert.match(result.content[0].text, /must be a string/);
});

test("read_messages formats oldest first and offers paging", async () => {
  const { ctx, calls } = context({
    ...channelRoute,
    [`GET /channels/${CHANNEL}/messages`]: [
      { id: "502", type: 0, timestamp: "2026-10-17T10:00:00+00:00", author: { id: "1", username: "bo" }, content: "second" },
      { id: "501", type: 0, timestamp: "2026-10-17T09:00:00+00:00", author: { id: "1", username: "bo" }, content: "first" },
    ],
  });
  const result = await callTool("read_messages", { channel_id: `<#${CHANNEL}>`, limit: 2 }, ctx);
  const text = result.content[0].text;
  assert.ok(text.indexOf("first") < text.indexOf("second"));
  assert.match(text, /#dev · 2 messages/);
  assert.match(text, /before: "501"/);
  assert.equal(calls.find((c) => c.key.endsWith("/messages")).query.limit, "2");
});

test("rate limits are retried using retry_after", async () => {
  let attempts = 0;
  const { ctx } = context({
    "GET /users/@me": { id: "555555555555555555", username: "helper" },
    "GET /users/@me/guilds": () =>
      ++attempts === 1 ? new Response(JSON.stringify({ retry_after: 0.01, global: false }), { status: 429 }) : [{ id: GUILD, name: "Team" }],
  });
  const result = await callTool("list_servers", {}, ctx);
  assert.equal(attempts, 2);
  assert.match(result.content[0].text, /- Team · id 222222222222222222/);
  assert.match(result.content[0].text, /client_id=555555555555555555&scope=bot&permissions=309237730368/);
});

test("Discord errors come back with a hint", async () => {
  const { ctx } = context({
    [`GET /channels/${CHANNEL}`]: new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), { status: 403 }),
    [`GET /channels/${CHANNEL}/messages`]: [],
  });
  const result = await callTool("read_messages", { channel_id: CHANNEL }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Discord API 403 .*Missing Access \(code 50001\).*View Channel/);
});

test("list_channels picks the only server when none is given", async () => {
  const { ctx } = context({
    "GET /users/@me/guilds": [{ id: GUILD, name: "Team" }],
    [`GET /guilds/${GUILD}/channels`]: [{ id: CHANNEL, type: 0, name: "dev", position: 0 }],
    [`GET /guilds/${GUILD}/threads/active`]: new Response("{}", { status: 403 }),
  });
  const result = await callTool("list_channels", {}, ctx);
  assert.equal(result.content[0].text, `Channels in server ${GUILD}:\n#dev (text) · id ${CHANNEL}`);
});

test("add_reaction encodes custom emoji and takes the channel from a message link", async () => {
  const { ctx, calls } = context({
    [`PUT /channels/${CHANNEL}/messages/${MESSAGE}/reactions/${encodeURIComponent("ship:777777777777777777")}/@me`]: null,
  });
  const result = await callTool(
    "add_reaction",
    { message_id: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`, emoji: "<:ship:777777777777777777>" },
    ctx,
  );
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(calls.length, 1);
});

test("create_thread in a forum sends the first post with the thread", async () => {
  const { ctx, calls } = context({
    [`GET /channels/${CHANNEL}`]: { id: CHANNEL, type: 15, name: "ideas", guild_id: GUILD },
    [`POST /channels/${CHANNEL}/threads`]: { id: "666666666666666666", name: "Plan" },
  });
  const noContent = await callTool("create_thread", { channel_id: CHANNEL, name: "Plan" }, ctx);
  assert.match(noContent.content[0].text, /Forum channels need `content`/);

  const result = await callTool("create_thread", { channel_id: CHANNEL, name: "Plan", content: "Kickoff" }, ctx);
  assert.match(result.content[0].text, /Created thread "Plan" in #ideas/);
  const post = calls.find((c) => c.key === `POST /channels/${CHANNEL}/threads`);
  assert.deepEqual(post.body, { name: "Plan", message: { content: "Kickoff", allowed_mentions: { parse: ["users"] } } });
});

test("discord_status distinguishes a missing voice container from a missing ElevenLabs key", async () => {
  const routes = { "GET /users/@me": { id: "555555555555555555", username: "helper" } };
  const status = {
    status: "online",
    startedAt: "t",
    servers: [],
    replyMode: "agent",
    inbox: { pending: 0 },
    persona: false,
    wake: { connected: false },
    voice: [],
  };
  const live = (extra) => ({ logPath: "test", call: async () => ({ ...status, ...extra }) });
  const missingKey = await callTool("discord_status", {}, createToolContext({ token: "Bot abc" }, fakeDiscord(routes).fetchImpl, live({ voiceEnabled: false })));
  assert.match(missingKey.content[0].text, /needs ELEVENLABS_API_KEY/);
  assert.doesNotMatch(missingKey.content[0].text, /voice container/);
  const missingContainer = await callTool(
    "discord_status",
    {},
    createToolContext({ token: "Bot abc" }, fakeDiscord(routes).fetchImpl, live({ voiceEnabled: false, voiceUnavailable: "the voice host isn't deployed" })),
  );
  assert.match(missingContainer.content[0].text, /Voice calls: off \(the voice host isn't deployed\)/);
  assert.doesNotMatch(missingContainer.content[0].text, /ELEVENLABS_API_KEY/);
  const fly = await callTool(
    "discord_status",
    {},
    createToolContext({ token: "Bot abc" }, fakeDiscord(routes).fetchImpl, live({ voiceEnabled: true, voiceHost: "fly" })),
  );
  assert.match(fly.content[0].text, /Voice calls: on \(Fly\.io\)/);
});
