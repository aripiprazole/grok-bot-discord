import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { INPUT_FRAME_BYTES, Mixer, createUpmixer, discordToEleven, mix, resampleMono, ulawToPcm } from "../server/live/voice/audio.mjs";
import { MIN_SPEECH_MS, SpeakerStream } from "../server/live/voice/call.mjs";
import { createUtteranceBatcher, dominantLanguage, fireVoiceRequest, voiceWakeBody } from "../server/live/voice/prompt.mjs";
import { cleanTranscript, connectScribe, isNoise, scribeUrl } from "../server/live/voice/scribe.mjs";
import { DEFAULT_VOICE_ID, TTS_MODEL, synthesize, ttsLanguage, ttsRequest } from "../server/live/voice/tts.mjs";

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

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, opts) {
    super();
    Object.assign(this, { url, opts, readyState: 0, sent: [] });
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

test("scribe url asks for manual commits, timestamps and language detection", () => {
  const url = new URL(scribeUrl());
  assert.equal(url.pathname, "/v1/speech-to-text/realtime");
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
  assert.equal(url.searchParams.get("commit_strategy"), "manual");
  assert.equal(url.searchParams.get("include_language_detection"), "true");
  assert.equal(url.searchParams.get("language_code"), null, "language is detected, not forced");
});

test("noise and non-speech tags are dropped", () => {
  assert.equal(cleanTranscript("(music) oi [laughs] gente"), "oi gente");
  assert.equal(isNoise(""), true);
  assert.equal(isNoise("(background noise)"), true);
  assert.equal(isNoise("uhm"), true);
  assert.equal(isNoise("..."), true);
  assert.equal(isNoise("ok"), false);
  assert.equal(isNoise("tudo bem?"), false);
});

test("scribe client queues audio until open, commits, and reports text with its language", async () => {
  FakeSocket.instances = [];
  const got = [];
  const stt = connectScribe({ apiKey: "k", WebSocketImpl: FakeSocket, onCommitted: (u) => got.push(u) });
  const ws = FakeSocket.instances.at(-1);
  assert.equal(ws.opts.headers["xi-api-key"], "k");
  stt.send(Buffer.alloc(320, 1));
  stt.commit();
  assert.equal(ws.sent.length, 0);
  ws.readyState = 1;
  ws.emit("open");
  assert.deepEqual(ws.sent.map((m) => [m.message_type, m.commit, m.sample_rate]), [["input_audio_chunk", false, 16000], ["input_audio_chunk", true, 16000]]);
  ws.serverSays({ message_type: "session_started", session_id: "s", config: {} });
  await stt.ready;
  ws.serverSays({ message_type: "committed_transcript", text: "Oi, gente, tudo bem?" });
  assert.equal(got.length, 0, "waits for the language");
  ws.serverSays({ message_type: "committed_transcript_with_timestamps", text: "Oi, gente, tudo bem?", language_code: "pt", words: [] });
  assert.deepEqual(got, [{ text: "Oi, gente, tudo bem?", language: "pt" }]);
  ws.serverSays({ message_type: "committed_transcript", text: "(silence)" });
  ws.serverSays({ message_type: "committed_transcript_with_timestamps", text: "(silence)", language_code: "en" });
  assert.equal(got.length, 1, "noise is not an utterance");
  stt.close();
});

test("scribe errors reject ready and quiet commits are ignored", async () => {
  FakeSocket.instances = [];
  const errors = [];
  const stt = connectScribe({ apiKey: "k", WebSocketImpl: FakeSocket, onError: (e) => errors.push(e.message) });
  const ws = FakeSocket.instances.at(-1);
  ws.serverSays({ message_type: "insufficient_audio_activity", error: "quiet" });
  assert.equal(errors.length, 0);
  ws.serverSays({ message_type: "auth_error", error: "bad key" });
  await assert.rejects(stt.ready, /auth_error: bad key/);
  assert.equal(errors.length, 1);
});

function fakeConnect() {
  const sockets = [];
  const connect = (handlers) => {
    const s = { handlers, sent: [], commits: 0, closed: false, ready: Promise.resolve(), send: (pcm) => s.sent.push(pcm.length), commit: () => s.commits++, close: () => (s.closed = true) };
    sockets.push(s);
    return s;
  };
  return { sockets, connect };
}

test("a speaker's audio goes out in 100 ms chunks and is committed at end of speech", () => {
  const { sockets, connect } = fakeConnect();
  const heard = [];
  const s = new SpeakerStream({ userId: "u1", connect, onUtterance: (u) => heard.push(u), log: {} });
  for (let i = 0; i < 16; i++) s.push(Buffer.alloc(640)); // 16 × 20 ms
  assert.deepEqual(sockets[0].sent, [3200, 3200, 3200]);
  assert.equal(s.end(), true);
  assert.deepEqual(sockets[0].sent, [3200, 3200, 3200, 640], "the tail is flushed before the commit");
  assert.equal(sockets[0].commits, 1);
  sockets[0].handlers.onCommitted({ text: "hello", language: "en" });
  assert.deepEqual(heard, [{ userId: "u1", text: "hello", language: "en" }]);
});

test("blips shorter than the minimum are not committed", () => {
  const { sockets, connect } = fakeConnect();
  const s = new SpeakerStream({ userId: "u1", connect, onUtterance() {}, log: {} });
  const bytes = Math.floor((MIN_SPEECH_MS / 1000) * 16_000 * 2) - 640;
  s.push(Buffer.alloc(bytes));
  assert.equal(s.end(), false);
  assert.equal(sockets[0]?.commits ?? 0, 0);
});

test("utterances close together are batched, then flushed after the pause", () => {
  const timers = { fns: [], setTimeout: (fn) => (timers.fns.push(fn), timers.fns.length), clearTimeout: () => {} };
  const flushed = [];
  const b = createUtteranceBatcher({ onFlush: (u) => flushed.push(u), timers });
  b.add({ text: "one" });
  b.add({ text: "two" });
  assert.equal(flushed.length, 0);
  timers.fns.at(-1)();
  assert.deepEqual(flushed, [[{ text: "one" }, { text: "two" }]]);
});

test("voice transcripts name the speaker and language, and ask for an answer in that language", () => {
  const body = voiceWakeBody({
    utterances: [
      { speaker: "Gabi", speakerId: "1", text: "Oi bot, que horas são?", language: "pt" },
      { speaker: "Ana", speakerId: "2", text: "kkkk", language: "pt" },
    ],
    call: { place: "🔊 passando raiva kkk (canudinhos)" },
  });
  assert.equal(body.source, "discord-voice");
  assert.equal(body.kind, "voice_transcript");
  assert.equal(body.language, "pt");
  assert.equal(body.utterances[0].speaker, "Gabi");
  assert.match(body.message, /Gabi \(id 1\) \[pt\]: Oi bot/);
  assert.match(body.message, /in Portuguese/);
  assert.match(body.message, /say_in_voice_call/);
  assert.equal(dominantLanguage([{ language: "en" }, { language: "pt" }, { language: "pt" }]), "pt");
});

test("voice handoff posts the routine webhook", async () => {
  const bodies = [];
  const result = await fireVoiceRequest({
    webhook: { url: "https://api.cursor.com/automations/webhook/abc", key: "secret" },
    utterances: [{ speaker: "Gabi", text: "What did we decide?", language: "en" }],
    call: { place: "🔊 general (Team)", guildId: "g" },
    fetchImpl: async (url, init) => {
      bodies.push({ url, init: { ...init, body: JSON.parse(init.body) } });
      return new Response("ok");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(bodies[0].init.headers.Authorization, "Bearer secret");
  assert.equal(bodies[0].init.body.request, "What did we decide?");
  assert.match(bodies[0].init.body.message, /in English/);
});

test("text-to-speech uses a multilingual model, 48 kHz PCM and the spoken language", async () => {
  assert.equal(ttsLanguage("por"), "pt");
  assert.equal(ttsLanguage("pt-BR"), "pt");
  assert.equal(ttsLanguage(""), null);
  const req = ttsRequest({ text: "Oi", voiceId: null, language: "pt" });
  assert.match(req.url, new RegExp(`/v1/text-to-speech/${DEFAULT_VOICE_ID}/stream\\?output_format=pcm_48000$`));
  assert.deepEqual(req.body, { text: "Oi", model_id: TTS_MODEL, language_code: "pt" });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1 ? new Response("bad", { status: 400 }) : new Response(new Uint8Array([1, 2, 3, 4]));
  };
  const chunks = [];
  for await (const c of synthesize({ apiKey: "k", text: "Oi", language: "pt", model: "other", fetchImpl })) chunks.push(c);
  assert.equal(Buffer.concat(chunks).length, 4);
  assert.equal(calls[1].language_code, undefined, "retries without language_code");
});
