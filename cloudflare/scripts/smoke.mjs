// In-process smoke test for the pieces that do not need Discord, ElevenLabs, or Cloudflare.
import assert from "node:assert/strict";
import { authorizeBearer } from "../../server/cloud/auth.mjs";
import { GATEWAY_INTENTS, GatewaySession } from "../../server/cloud/gateway-session.mjs";
import { handleMcpHttp } from "../../server/cloud/mcp-http.mjs";
import { createVoiceController } from "../../server/cloud/voice-controller.mjs";
import { createHandler } from "../../server/mcp-core.mjs";

const handleLine = createHandler({ config: { token: "t" }, live: { disabled: "off", call: async () => {} } });
const init = await handleMcpHttp(
  new Request("https://bot.example/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  }),
  handleLine,
);
assert.equal(init.status, 200);
const listed = await (
  await handleMcpHttp(
    new Request("https://bot.example/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    handleLine,
  )
).json();
const tools = listed.result.tools;
assert.ok(tools.some((tool) => tool.name === "say_in_voice_call"));
const reply = tools.find((tool) => tool.name === "reply_on_discord");
assert.ok(reply.inputSchema.properties.thread);
assert.ok(reply.inputSchema.properties.embeds);
assert.ok(reply.inputSchema.properties.components);
assert.ok(reply.inputSchema.properties.poll);
assert.equal((await authorizeBearer(new Request("https://bot.example/mcp"), "")).status, 503);

const sent = [];
const gateway = new GatewaySession({ token: "t", onSend: (payload) => sent.push(payload), schedule: () => 0 });
gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
assert.equal(sent[1].op, 2);
assert.equal(sent[1].d.intents, GATEWAY_INTENTS);

const controller = createVoiceController({
  startCall(spec) {
    assert.equal(spec.channelId, "c");
    return { feed() {}, say() {}, stop() {} };
  },
});
const ws = {
  readyState: 1,
  sent: [],
  send(data) {
    this.sent.push(JSON.parse(data));
  },
  on(_event, fn) {
    this.handler = fn;
  },
};
controller.attach(ws);
ws.handler(JSON.stringify({ type: "start", channelId: "c", guildId: "g" }));
ws.handler(JSON.stringify({ type: "ping" }));
assert.equal(ws.sent.at(-1).type, "pong");

console.log("smoke ok");
