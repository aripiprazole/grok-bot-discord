import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { INPUT_FRAME_BYTES, Mixer, createUpmixer, discordToEleven, mix, resampleMono, ulawToPcm } from "../server/live/voice/audio.mjs";
import { VoiceBridge } from "../server/live/voice/bridge.mjs";
import { connectEleven, initiationMessage } from "../server/live/voice/eleven.mjs";
import { ensureElevenAgent } from "../server/live/voice/eleven-agent.mjs";
import { ASK_AGENT_RESULT, fireVoiceRequest, speakRequest } from "../server/live/voice/prompt.mjs";

const pcm = (...samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samples = (b) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

test("48 kHz stereo becomes 16 kHz mono by averaging", () => {
  assert.deepEqual(samples(discordToEleven(pcm(100, 300, 200, 400, 500, 600, -8, -8, -8, -8, -8, -8))), [350, -8]);
  assert.equal(discordToEleven(Buffer.alloc(3840)).length, INPUT_FRAME_BYTES, "a 20 ms Discord frame is a 20 ms ElevenLabs frame");
});

test("ulaw silence and 16 kHz to 48 kHz resampling", () => {
  assert.equal(ulawToPcm(Buffer.from([0xff])).readInt16LE(0), 0);
  const up = resampleMono(pcm(1000, -1000), 16_000, 48_000);
  assert.equal(up.length, 12);
  assert.equal(up.readInt16LE(0), 1000);
});

test("upmixer duplicates samples and carries odd bytes", () => {
  const upmix = createUpmixer();
  const whole = pcm(1000, -2);
  assert.deepEqual(samples(upmix(whole.subarray(0, 3))), [1000, 1000]);
  assert.deepEqual(samples(upmix(whole.subarray(3))), [-2, -2]);
});

test("mixing clips instead of wrapping", () => {
  assert.deepEqual(samples(mix([pcm(30000, -30000, 5), pcm(10000, -10000, 5)])), [32767, -32768, 10]);
});

test("mixer frames bursty audio per speaker and mixes one frame from each", () => {
  const m = new Mixer({ frameBytes: 4, maxQueuedFrames: 3 });
  m.push("a", pcm(1, 1, 2));
  m.push("a", pcm(2));
  m.push("b", pcm(10, 10));
  assert.deepEqual(samples(m.next()), [11, 11]);
  assert.deepEqual(samples(m.next()), [2, 2]);
  assert.equal(m.next(), null);
  m.push("c", pcm(1, 1, 2, 2, 3, 3, 4, 4, 5, 5));
  assert.deepEqual(samples(m.next()), [3, 3], "oldest frames dropped past the cap");
});

function bridge(now) {
  const calls = { sent: [], audio: [], interrupts: 0, done: 0, transcripts: [], errors: [], tools: [] };
  const b = new VoiceBridge({
    send: (e) => calls.sent.push(e),
    onAudio: (buf) => calls.audio.push(buf),
    onInterrupt: () => calls.interrupts++,
    onResponseDone: () => calls.done++,
    onTranscript: (t) => calls.transcripts.push(t),
    onError: (e) => calls.errors.push(e.message),
    onFunctionCall: (call) => calls.tools.push(call),
    now: () => now.t,
  });
  return { b, calls };
}

test("bridge streams speech in 100 ms batches, then trailing silence, then goes quiet", () => {
  const now = { t: 0 };
  const { b, calls } = bridge(now);
  b.tick();
  for (let i = 0; i < 10; i++) b.pushUserAudio("u1", Buffer.alloc(3840, 1));
  for (now.t = 20; now.t <= 3000; now.t += 20) b.tick();
  const bytes = calls.sent.map((e) => Buffer.from(e.user_audio_chunk, "base64").length);
  assert.ok(calls.sent.every((e) => e.user_audio_chunk));
  assert.ok(bytes.every((n) => n <= 5 * INPUT_FRAME_BYTES));
  const total = bytes.reduce((a, n) => a + n, 0) / INPUT_FRAME_BYTES;
  assert.ok(total >= 69 && total <= 71, `sent ${total} frames`);
});

test("bridge routes ElevenLabs events and answers pings immediately", () => {
  const { b, calls } = bridge({ t: 0 });
  b.handleEvent({ type: "audio", audio_event: { audio_base_64: pcm(5, 6).toString("base64"), event_id: 1 } });
  b.handleEvent({ type: "interruption" });
  b.handleEvent({ type: "agent_response", agent_response_event: { agent_response: " Hello there " } });
  b.handleEvent({ type: "agent_response_complete" });
  b.handleEvent({ type: "ping", ping_event: { event_id: 7 } });
  b.handleEvent({ type: "client_tool_call", client_tool_call: { tool_name: "ask_agent", tool_call_id: "c1", parameters: { request: "remember this" } } });
  b.handleEvent({ type: "client_tool_call", client_tool_call: { tool_name: "ask_agent", tool_call_id: "c1", parameters: { request: "again" } } });
  b.handleEvent({ type: "error", error: { message: "bad voice" } });
  assert.deepEqual(samples(calls.audio[0]), [5, 6]);
  assert.equal(calls.interrupts, 1);
  assert.deepEqual(calls.transcripts, ["Hello there"]);
  assert.equal(calls.done, 1);
  assert.deepEqual(calls.sent[0], { type: "pong", event_id: 7 });
  assert.equal(calls.tools.length, 1);
  assert.equal(calls.tools[0].callId, "c1");
  assert.deepEqual(calls.errors, ["bad voice"]);
});

test("initiation omits empty overrides and speak requests are user messages", () => {
  assert.deepEqual(initiationMessage({}), { type: "conversation_initiation_client_data" });
  assert.equal(initiationMessage({ instructions: "Be Nova", voiceId: "v" }).conversation_config_override.tts.voice_id, "v");
  assert.match(speakRequest("The answer").text, /From the Grok Bot agent/);
});

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url) {
    super();
    Object.assign(this, { url, readyState: 0, sent: [] });
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  serverSays(event) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}

test("eleven client fetches a signed url and sends initiation", async () => {
  FakeSocket.instances = [];
  const events = [];
  const fetches = [];
  const rt = connectEleven({
    apiKey: "key",
    agentId: "agent-1",
    instructions: "Be Nova",
    onEvent: (e) => events.push(e.type),
    onClose: () => {},
    fetchImpl: async (url) => {
      fetches.push(url);
      return new Response(JSON.stringify({ signed_url: "wss://signed.example/conversation" }));
    },
    WebSocketImpl: FakeSocket,
  });
  let ws;
  for (let i = 0; i < 20 && !ws; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    ws = FakeSocket.instances.at(-1);
  }
  assert.ok(ws);
  assert.match(fetches[0], /agent_id=agent-1/);
  assert.equal(ws.url, "wss://signed.example/conversation");
  ws.readyState = 1;
  ws.emit("open");
  assert.equal(ws.sent[0].type, "conversation_initiation_client_data");
  ws.serverSays({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { agent_output_audio_format: "pcm_16000" } });
  await rt.ready;
  assert.deepEqual(events, ["conversation_initiation_metadata"]);
  rt.close();
});

test("eleven connection errors reject ready", async () => {
  const rt = connectEleven({
    apiKey: "k",
    agentId: "a",
    onEvent() {},
    onClose() {},
    fetchImpl: async () => new Response("no", { status: 401 }),
    WebSocketImpl: FakeSocket,
  });
  await assert.rejects(rt.ready, /signed URL failed/);
});

test("ensureElevenAgent creates the tool and agent, then attaches the tool", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const method = init.method ?? "GET";
    if (url.endsWith("/v1/convai/tools") && method === "GET") return Response.json({ tools: [] });
    if (url.endsWith("/v1/convai/tools")) return Response.json({ id: "tool-1" });
    if (url.endsWith("/v1/convai/agents") && method === "GET") return Response.json({ agents: [] });
    if (url.endsWith("/agents/create")) return Response.json({ agent_id: "agent-9" });
    if (url.endsWith("/agents/agent-9") && (!init.method || init.method === "GET")) {
      return Response.json({ conversation_config: { agent: { prompt: { prompt: "stay", llm: "glm", tool_ids: [] } } } });
    }
    return Response.json({ ok: true });
  };
  const result = await ensureElevenAgent({ apiKey: "k", fetchImpl });
  assert.deepEqual(result, { agentId: "agent-9", toolId: "tool-1" });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body.conversation_config.agent.prompt.tool_ids, ["tool-1"]);
  assert.equal(patch.body.conversation_config.agent.prompt.prompt, "stay");
});

test("voice handoff posts the routine webhook and does not wait on the agent", async () => {
  const bodies = [];
  const result = await fireVoiceRequest({
    webhook: { url: "https://api.cursor.com/automations/webhook/abc", key: "secret" },
    request: "What did we decide?",
    call: { place: "🔊 general (Team)", guildId: "g" },
    fetchImpl: async (url, init) => {
      bodies.push({ url, init: { ...init, body: JSON.parse(init.body) } });
      return new Response("ok");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(bodies[0].init.headers.Authorization, "Bearer secret");
  assert.equal(bodies[0].init.body.kind, "voice_request");
  assert.match(bodies[0].init.body.message, /say_in_voice_call/);
  assert.equal(ASK_AGENT_RESULT.includes("say that text out loud"), true);
});
