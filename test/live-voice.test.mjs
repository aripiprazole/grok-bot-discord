import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { INPUT_FRAME_BYTES, Mixer, createUpmixer, discordToGrok, mix } from "../server/live/voice/audio.mjs";
import { VoiceBridge, sessionConfig } from "../server/live/voice/bridge.mjs";
import { connectRealtime } from "../server/live/voice/realtime.mjs";

const pcm = (...samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samples = (b) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

test("48 kHz stereo becomes 24 kHz mono by averaging", () => {
  // Two stereo frames (L, R, L, R) → one mono sample.
  assert.deepEqual(samples(discordToGrok(pcm(100, 300, 200, 400, -8, -8, -8, -8))), [250, -8]);
  assert.equal(discordToGrok(Buffer.alloc(3840)).length, INPUT_FRAME_BYTES, "a 20 ms Discord frame is a 20 ms Grok frame");
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
  m.push("a", pcm(1, 1, 2)); // one full frame + one leftover sample
  m.push("a", pcm(2));
  m.push("b", pcm(10, 10));
  assert.deepEqual(samples(m.next()), [11, 11]);
  assert.deepEqual(samples(m.next()), [2, 2]);
  assert.equal(m.next(), null);
  m.push("c", pcm(1, 1, 2, 2, 3, 3, 4, 4, 5, 5));
  assert.deepEqual(samples(m.next()), [3, 3], "oldest frames dropped past the cap");
});

function bridge(now) {
  const calls = { sent: [], audio: [], interrupts: 0, done: 0, transcripts: [], errors: [] };
  const b = new VoiceBridge({
    send: (e) => calls.sent.push(e),
    onAudio: (buf) => calls.audio.push(buf),
    onInterrupt: () => calls.interrupts++,
    onResponseDone: () => calls.done++,
    onTranscript: (t) => calls.transcripts.push(t),
    onError: (e) => calls.errors.push(e.message),
    now: () => now.t,
  });
  return { b, calls };
}

test("bridge streams speech in 100 ms batches, then trailing silence, then goes quiet", () => {
  const now = { t: 0 };
  const { b, calls } = bridge(now);
  b.tick();
  for (let i = 0; i < 10; i++) b.pushUserAudio("u1", Buffer.alloc(3840, 1)); // 200 ms of speech
  for (now.t = 20; now.t <= 3000; now.t += 20) b.tick();
  const bytes = calls.sent.map((e) => Buffer.from(e.audio, "base64").length);
  assert.ok(calls.sent.every((e) => e.type === "input_audio_buffer.append"));
  assert.ok(bytes.every((n) => n <= 5 * INPUT_FRAME_BYTES));
  const total = bytes.reduce((a, n) => a + n, 0) / INPUT_FRAME_BYTES;
  // 10 speech frames + ~1.2 s (60 frames) of trailing silence, then nothing.
  assert.ok(total >= 69 && total <= 71, `sent ${total} frames`);
});

test("bridge routes Grok events", () => {
  const { b, calls } = bridge({ t: 0 });
  b.handleEvent({ type: "response.output_audio.delta", delta: pcm(5, 6).toString("base64") });
  b.handleEvent({ type: "input_audio_buffer.speech_started" });
  b.handleEvent({ type: "response.output_audio_transcript.done", transcript: " Hello there " });
  b.handleEvent({ type: "response.done" });
  b.handleEvent({ type: "error", error: { message: "bad voice" } });
  b.handleEvent({ type: "session.updated" });
  assert.deepEqual(samples(calls.audio[0]), [5, 6]);
  assert.equal(calls.interrupts, 1);
  assert.deepEqual(calls.transcripts, ["Hello there"]);
  assert.equal(calls.done, 1);
  assert.deepEqual(calls.errors, ["bad voice"]);
});

test("session config asks for 24 kHz in, 48 kHz out, server VAD and tools", () => {
  assert.deepEqual(sessionConfig({ voice: "eve", instructions: "hi", tools: ["web_search"] }), {
    voice: "eve",
    instructions: "hi",
    turn_detection: { type: "server_vad" },
    audio: {
      input: { format: { type: "audio/pcm", rate: 24000 } },
      output: { format: { type: "audio/pcm", rate: 48000 } },
    },
    tools: [{ type: "web_search" }],
  });
});

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    Object.assign(this, { url, options, readyState: 0, sent: [] });
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }
  serverSays(event) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}

test("realtime client authenticates, configures the session and reports closes", async () => {
  const events = [];
  const closes = [];
  const rt = connectRealtime({
    apiKey: "key",
    model: "grok-voice-latest",
    session: { voice: "eve" },
    onEvent: (e) => events.push(e.type),
    onClose: (code) => closes.push(code),
    WebSocketImpl: FakeSocket,
  });
  const ws = FakeSocket.instances.at(-1);
  assert.equal(ws.url, "wss://api.x.ai/v1/realtime?model=grok-voice-latest");
  assert.equal(ws.options.headers.Authorization, "Bearer key");
  ws.readyState = 1;
  ws.emit("open");
  assert.deepEqual(ws.sent, [{ type: "session.update", session: { voice: "eve" } }]);
  ws.serverSays({ type: "session.updated" });
  await rt.ready;
  rt.send({ type: "input_audio_buffer.append", audio: "" });
  assert.equal(ws.sent.length, 2);
  rt.close();
  assert.deepEqual(events, ["session.updated"]);
  assert.deepEqual(closes, [1000]);
});

test("realtime connection errors reject ready without crashing", async () => {
  const rt = connectRealtime({ apiKey: "k", model: "m", session: {}, onEvent() {}, onClose() {}, WebSocketImpl: FakeSocket });
  const ws = FakeSocket.instances.at(-1);
  ws.emit("error", new Error("Unexpected server response: 401"));
  ws.emit("error", new Error("second error is fine too"));
  ws.close(1006);
  await assert.rejects(rt.ready, /401/);
});
