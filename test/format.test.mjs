import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMessage, formatChannels, formatMessages } from "../server/format.mjs";

test("short text is one chunk", () => {
  assert.deepEqual(chunkMessage("hello\n\n"), ["hello"]);
});

test("long text splits on line breaks within the limit", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
  const chunks = chunkMessage(lines.join("\n"));
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk of ${c.length}`);
  assert.equal(chunks.join("\n"), lines.join("\n"));
});

test("text without whitespace is hard-cut", () => {
  const chunks = chunkMessage("a".repeat(4500));
  assert.deepEqual(chunks.map((c) => c.length), [1996, 1996, 508]);
});

test("code fences are closed and reopened across chunks", () => {
  const code = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}; // ${"pad".repeat(5)}`).join("\n");
  const chunks = chunkMessage(`Here:\n\`\`\`js\n${code}\n\`\`\`\nDone.`);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 2000);
    assert.equal((c.match(/^```/gm) ?? []).length % 2, 0, `unbalanced fence in:\n${c.slice(0, 80)}`);
  }
  assert.ok(chunks[1].startsWith("```js\n"));
});

const msg = (id, extra = {}) => ({
  id,
  type: 0,
  timestamp: "2026-10-17T14:03:12.345000+00:00",
  author: { id: "1", username: "ana", global_name: "Ana" },
  content: `message ${id}`,
  attachments: [],
  embeds: [],
  ...extra,
});

test("messages render oldest first with replies, attachments and reactions", () => {
  const out = formatMessages([
    msg("3", {
      type: 19,
      referenced_message: msg("2"),
      attachments: [{ filename: "a.png", url: "https://cdn/a.png" }],
      reactions: [{ emoji: { name: "👍", id: null }, count: 2 }],
    }),
    msg("2"),
  ]);
  assert.ok(out.indexOf("id 2") < out.indexOf("id 3"));
  assert.match(out, /\[2026-10-17 14:03 UTC\] Ana \(@ana\) · id 3/);
  assert.match(out, /↪ replying to Ana \(@ana\) \(2\): "message 2"/);
  assert.match(out, /📎 a\.png https:\/\/cdn\/a\.png/);
  assert.match(out, /reactions: 👍 2/);
  assert.doesNotMatch(out, /Message Content Intent/);
});

test("all-empty human messages suggest enabling the Message Content intent", () => {
  const out = formatMessages([msg("2", { content: "" }), msg("1", { content: "" })]);
  assert.match(out, /Message Content Intent/);
});

test("channels group under categories with threads", () => {
  const out = formatChannels(
    [
      { id: "10", type: 4, name: "Work", position: 1 },
      { id: "11", type: 0, name: "dev", parent_id: "10", position: 2 },
      { id: "12", type: 0, name: "general", position: 0 },
      { id: "13", type: 2, name: "Voice", parent_id: "10", position: 3 },
      { id: "14", type: 4, name: "Empty", position: 4 },
    ],
    [{ id: "20", name: "bug-123", parent_id: "11" }],
  );
  assert.equal(
    out,
    ["#general (text) · id 12", "📁 Work", "  #dev (text) · id 11", "    🧵 bug-123 · id 20", "  #Voice (voice) · id 13"].join("\n"),
  );
});
