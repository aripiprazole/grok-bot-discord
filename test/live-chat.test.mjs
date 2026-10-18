import assert from "node:assert/strict";
import { test } from "node:test";
import { configHash, effectiveReplyMode, isAllowed, loadLiveConfig, missingSettings } from "../server/live/config.mjs";
import { buildInstructions, formatReply, resolveMentions, respondMode, threadName, toInput } from "../server/live/conversation.mjs";
import { createGrok, parseResponse } from "../server/live/grok.mjs";

const ENV = { DISCORD_BOT_TOKEN: "d", XAI_API_KEY: "x" };

test("live config reads plugin variables and ignores unset placeholders", () => {
  assert.equal(missingSettings(loadLiveConfig({ DISCORD_BOT_TOKEN: "${DISCORD_BOT_TOKEN}" })), "Set DISCORD_BOT_TOKEN in the plugin settings.");
  assert.equal(missingSettings(loadLiveConfig({ DISCORD_BOT_TOKEN: "t" })), null, "the xAI key is optional");
  assert.equal(effectiveReplyMode(loadLiveConfig({ DISCORD_BOT_TOKEN: "t" })), "agent");
  assert.equal(effectiveReplyMode(loadLiveConfig({ ...ENV, REPLY_MODE: "Instant" })), "instant");
  assert.equal(effectiveReplyMode(loadLiveConfig({ DISCORD_BOT_TOKEN: "t", REPLY_MODE: "instant" })), "agent", "instant needs a key");
  const c = loadLiveConfig({ ...ENV, ALLOWED_IDS: "1, 2 3,", LISTEN_CHANNEL_IDS: "" });
  assert.deepEqual([...c.allowedIds], ["1", "2", "3"]);
  assert.equal(c.listenChannelIds.size, 0);
  assert.equal(configHash(c, "1"), configHash(loadLiveConfig({ ...ENV, ALLOWED_IDS: "3,2,1" }), "1"), "order doesn't matter");
  assert.notEqual(configHash(c, "1"), configHash(c, "2"), "a plugin update restarts the background process");
  assert.notEqual(configHash(c, "1"), configHash(loadLiveConfig(ENV), "1"));
});

test("allowlist: open by default, otherwise user or role IDs", () => {
  assert.ok(isAllowed("9", [], loadLiveConfig(ENV)));
  const locked = loadLiveConfig({ ...ENV, ALLOWED_IDS: "1,r" });
  assert.ok(isAllowed("1", [], locked));
  assert.ok(isAllowed("2", ["x", "r"], locked));
  assert.ok(!isAllowed("2", ["x"], locked));
});

const base = { authorIsBot: false, isDM: false, inThread: false, threadOwnedByBot: false, mentionsBot: false, channelId: "c", parentId: null };
const ctx = (listen = [], followed = []) => ({ listenChannelIds: new Set(listen), followedThreads: new Set(followed) });

test("responds like the Slack Team Bot", () => {
  assert.equal(respondMode({ ...base, isDM: true }, ctx()), "dm");
  assert.equal(respondMode({ ...base }, ctx()), null, "ignores unmentioned channel messages");
  assert.equal(respondMode({ ...base, mentionsBot: true }, ctx()), "channel");
  assert.equal(respondMode({ ...base }, ctx(["c"])), "channel", "listener channels answer everything");
  assert.equal(respondMode({ ...base, inThread: true, threadOwnedByBot: true }, ctx()), "thread", "follows its own threads");
  assert.equal(respondMode({ ...base, inThread: true }, ctx([], ["c"])), "thread", "follows threads it was pulled into");
  assert.equal(respondMode({ ...base, inThread: true }, ctx()), null);
  assert.equal(respondMode({ ...base, inThread: true, parentId: "p" }, ctx(["p"])), "thread");
  assert.equal(respondMode({ ...base, authorIsBot: true, isDM: true }, ctx()), "dm", "other bots are answered like people");
  assert.equal(respondMode({ ...base, authorIsSelf: true, isDM: true }, ctx()), null, "never its own messages");
});

test("history becomes model input with names, rejoined replies, no error or source lines", () => {
  const input = toInput([
    { isBot: false, authorName: "Ana", content: "@Grok what's new in Node 26?", attachments: [] },
    { isBot: true, authorName: "Grok", content: "Part one", attachments: [] },
    { isBot: true, authorName: "Grok", content: "part two\n-# Sources: [nodejs.org](<https://nodejs.org>)", attachments: [] },
    { isBot: true, authorName: "Grok", content: "⚠️ Couldn't get a reply from Grok: boom", attachments: [] },
    { isBot: false, authorName: "Bo", content: "", attachments: [{ name: "log.txt", url: "https://cdn/log.txt" }] },
    { isBot: false, authorName: "Cy", content: "  ", attachments: [] },
  ]);
  assert.deepEqual(input, [
    { role: "user", content: "Ana: @Grok what's new in Node 26?" },
    { role: "assistant", content: "Part one\npart two" },
    { role: "user", content: "Bo: [attachment: log.txt https://cdn/log.txt]" },
  ]);
});

test("reply formatting and thread names", () => {
  assert.equal(formatReply("Hi", []), "Hi");
  assert.equal(
    formatReply("Answer ", [{ url: "https://www.example.com/a" }, { url: "https://x.com/b" }]),
    "Answer\n-# Sources: [example.com](<https://www.example.com/a>) · [x.com](<https://x.com/b>)",
  );
  assert.equal(formatReply("  "), "I don't have an answer for that.");
  assert.equal(threadName("\n  @Grok fix the build <:ok:123>\nmore"), "@Grok fix the build");
  assert.equal(threadName("a".repeat(200)).length, 90);
  assert.equal(threadName(""), "Chat");
  const lookup = { user: (id) => ({ 1: "Gigaclanker", 2: "Gabi" })[id] ?? null, role: (id) => (id === "5" ? "Mods" : null), channel: (id) => (id === "9" ? "general" : null) };
  assert.equal(threadName("<@1> hey <@!2>, check <#9> with <@&5>", lookup), "hey @Gabi, check #general with @Mods");
  assert.equal(threadName("<@1>\nwhat about <@777>?", lookup), "what about @someone?", "skips the bare ping and never shows raw ids");
  assert.equal(threadName("<@1>", lookup), "@Gigaclanker");
  assert.doesNotMatch(threadName("<@1561130358152499222> o que vc acha disso", {}), /<@|\d{6,}/);
  const long = threadName(`fala ${"palavra ".repeat(30)}`);
  assert.ok(long.length <= 90 && long.endsWith("…") && !long.includes("palavra …"), long);
  assert.equal(resolveMentions("<@3> in <#4> <@&6>"), "@someone in #channel @role");
  assert.match(buildInstructions({ botName: "Grok", place: "in #dev" }), /language the person wrote in/);
  assert.match(buildInstructions({ botName: "Grok", place: "in #dev", extra: "Be nice." }), /chatting on Discord in #dev[\s\S]*Be nice\.$/);
});

test("parses Responses API output, annotations and citations", () => {
  const parsed = parseResponse({
    output: [
      { type: "reasoning", summary: [] },
      { type: "web_search_call" },
      {
        type: "message",
        content: [{ type: "output_text", text: "Node 26 is out.", annotations: [{ type: "url_citation", url: "https://nodejs.org", title: "Node" }] }],
      },
    ],
    citations: ["https://nodejs.org", "https://x.com/nodejs"],
  });
  assert.deepEqual(parsed, {
    text: "Node 26 is out.",
    sources: [
      { url: "https://nodejs.org", title: "Node" },
      { url: "https://x.com/nodejs", title: undefined },
    ],
  });
});

test("grok client sends model, system prompt, tools and surfaces API errors", async () => {
  let sent;
  const ok = createGrok({
    apiKey: "k",
    model: "grok-4.7",
    tools: ["web_search"],
    fetchImpl: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "hey" }] }] });
    },
  });
  const res = await ok.reply({ instructions: "sys", input: [{ role: "user", content: "Ana: hi" }] });
  assert.equal(res.text, "hey");
  assert.equal(sent.url, "https://api.x.ai/v1/responses");
  assert.equal(sent.init.headers.Authorization, "Bearer k");
  assert.deepEqual(sent.body, {
    model: "grok-4.7",
    input: [
      { role: "system", content: "sys" },
      { role: "user", content: "Ana: hi" },
    ],
    tools: [{ type: "web_search" }],
    store: false,
  });

  const bad = createGrok({ apiKey: "k", model: "m", fetchImpl: async () => Response.json({ code: "bad", error: "Incorrect API key" }, { status: 401 }) });
  await assert.rejects(bad.reply({ instructions: "s", input: [] }), /xAI API 401: Incorrect API key/);
});
