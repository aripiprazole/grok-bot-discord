import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { INVITE_PERMISSIONS } from "../server/cloud/commands.mjs";
import { startDiscordCall } from "../server/cloud/discord-voice-call.mjs";
import { createVoiceController } from "../server/cloud/voice-controller.mjs";

test("invite permissions include connect and speak", () => {
  const bits = (1n << 6n) | (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 20n) | (1n << 21n) | (1n << 35n) | (1n << 38n);
  assert.equal(INVITE_PERMISSIONS, bits.toString());
});

test("voice control starts a call synchronously and forwards only the bot's voice state", async () => {
  const started = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const controller = createVoiceController({
    startCall(spec, hooks) {
      const connection = { destroyed: false, destroy() { this.destroyed = true; } };
      const methods = { states: [], servers: [] };
      const session = startDiscordCall(spec, hooks, {
        joinVoiceChannel({ adapterCreator }) {
          adapterCreator({
            onVoiceStateUpdate: (data) => methods.states.push(data),
            onVoiceServerUpdate: (data) => methods.servers.push(data),
            destroy() {},
          });
          return connection;
        },
        entersState: () => held,
        VoiceConnectionStatus: { Ready: "ready", Disconnected: "disconnected", Signalling: "signalling", Connecting: "connecting", Destroyed: "destroyed" },
        bind() {
          return { ready: Promise.resolve(), say(text) { started.push(text); }, stop() {} };
        },
      });
      session.methods = methods;
      session.connection = connection;
      return session;
    },
  });
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  const attached = controller.attach(ws);
  ws.emit("message", JSON.stringify({
    type: "start",
    guildId: "g1",
    channelId: "c1",
    userId: "bot",
    elevenApiKey: "secret",
  }));
  assert.ok(attached.session, "the call is registered before ElevenLabs is ready");
  attached.session.feed({ t: "VOICE_STATE_UPDATE", d: { guild_id: "g1", user_id: "someone", session_id: "nope" } });
  attached.session.feed({ t: "VOICE_STATE_UPDATE", d: { guild_id: "g1", user_id: "bot", session_id: "yes" } });
  attached.session.feed({ t: "VOICE_SERVER_UPDATE", d: { guild_id: "g1", token: "voice", endpoint: "x" } });
  assert.deepEqual(attached.session.methods.states.map((state) => state.user_id), ["bot"]);
  assert.equal(attached.session.methods.servers.length, 1);
  assert.equal(attached.session.ready instanceof Promise, true);
  release();
  await attached.session.ready;
  ws.emit("message", JSON.stringify({ type: "say", content: "hello there" }));
  assert.deepEqual(started, ["hello there"]);
  ws.emit("message", JSON.stringify({ type: "ping" }));
  assert.equal(ws.sent.at(-1).type, "pong");
  const connection = attached.session.connection;
  ws.emit("message", JSON.stringify({ type: "stop", reason: "done" }));
  assert.equal(connection.destroyed, true);
});
