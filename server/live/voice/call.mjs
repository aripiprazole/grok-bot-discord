// Binds one Discord voice connection to ElevenLabs speech-to-text and text-to-speech.
// The voice side only transcribes and speaks. It never decides what to say: each finished
// utterance goes to the Grok Bot agent, and the agent's answer comes back through say().
// Shared by the local daemon and the Fly.io / Cloudflare voice host.

import { PassThrough } from "node:stream";
import { AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource } from "@discordjs/voice";
import prism from "prism-media";
import { DISCORD_RATE, createUpmixer, discordToEleven } from "./audio.mjs";
import { STT_RATE, connectScribe } from "./scribe.mjs";
import { synthesize } from "./tts.mjs";

// Discord stops sending a person's packets when they go quiet; this much silence ends an utterance.
export const END_OF_SPEECH_MS = 800;
// Very long monologues are cut into segments so the agent hears them while they're still going.
export const MAX_SEGMENT_MS = 30_000;
// Shorter blips (a cough, a click) aren't committed.
export const MIN_SPEECH_MS = 250;
const SEND_BYTES = (STT_RATE / 1000) * 100 * 2; // 100 ms of 16 kHz mono per message
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_MISSED_FRAMES = 250;

const bytesToMs = (bytes) => (bytes / 2 / STT_RATE) * 1000;

/**
 * One speaker's transcription: buffers 16 kHz mono PCM, sends it in 100 ms chunks, and commits
 * at end of speech. Discord- and socket-free so it can be tested with a fake `connect`.
 */
export class SpeakerStream {
  constructor({ userId, connect, onUtterance, onError = () => {}, log = console, now = () => Date.now() }) {
    Object.assign(this, { userId, connect, onUtterance, onError, log, now });
    this.stt = null;
    this.buffer = [];
    this.bufferBytes = 0;
    this.segmentBytes = 0;
    this.lastAudioAt = 0;
  }

  socket() {
    if (this.stt && !this.stt.closed) return this.stt;
    this.stt = this.connect({
      onCommitted: ({ text, language }) => this.onUtterance({ userId: this.userId, text, language }),
      onError: (err) => this.onError(err),
      onClose: () => {
        this.stt = null;
      },
    });
    this.stt.ready?.then(
      () => this.log.info?.(JSON.stringify({ level: "info", message: "stt connected", userId: this.userId })),
      (err) => this.log.warn?.(`Speech-to-text (${this.userId}): ${err.message}`),
    );
    return this.stt;
  }

  push(pcm16k) {
    if (!pcm16k?.length) return;
    this.lastAudioAt = this.now();
    this.buffer.push(pcm16k);
    this.bufferBytes += pcm16k.length;
    this.segmentBytes += pcm16k.length;
    if (this.bufferBytes >= SEND_BYTES) this.flush();
    if (bytesToMs(this.segmentBytes) >= MAX_SEGMENT_MS) this.end();
  }

  flush() {
    if (!this.bufferBytes) return;
    const audio = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferBytes = 0;
    this.socket().send(audio);
  }

  // End of speech: send what's left and commit, unless it was too short to be words.
  end() {
    const speech = bytesToMs(this.segmentBytes);
    if (speech < MIN_SPEECH_MS) {
      this.buffer = [];
      this.bufferBytes = 0;
      this.segmentBytes = 0;
      return false;
    }
    this.flush();
    this.segmentBytes = 0;
    this.socket().commit();
    return true;
  }

  idle(now = this.now()) {
    return !this.segmentBytes && now - this.lastAudioAt > IDLE_CLOSE_MS;
  }

  close() {
    this.stt?.close();
    this.stt = null;
  }
}

export function bindVoiceToConnection(connection, opts) {
  const {
    apiKey,
    voiceId = null,
    ttsModel,
    language = null,
    canHear = () => true,
    onUtterance = () => {},
    onSpoken = () => {},
    onError = () => {},
    onLimit = () => {},
    maxMinutes = 60,
    fetchImpl = globalThis.fetch,
    connect = connectScribe,
    speak = synthesize,
    log = console,
  } = opts;

  let stopped = false;
  let lastLanguage = language;
  const speakers = new Map(); // userId → SpeakerStream
  const streams = new Map(); // userId → opus stream
  const queue = [];
  let speaking = false;

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES } });
  player.on("error", (err) => log.warn?.(`Voice playback: ${err.message}`));
  connection.subscribe(player);

  const openStt = (handlers) => connect({ apiKey, language, ...handlers });

  function speaker(userId) {
    let s = speakers.get(userId);
    if (!s) {
      s = new SpeakerStream({
        userId,
        connect: openStt,
        log,
        onError: (err) => onError(err),
        onUtterance: (u) => {
          if (stopped) return;
          if (u.language) lastLanguage = u.language;
          onUtterance(u);
        },
      });
      speakers.set(userId, s);
    }
    return s;
  }

  function hear(userId) {
    if (stopped || streams.has(userId) || !canHear(userId)) return;
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: END_OF_SPEECH_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: DISCORD_RATE, channels: 2, frameSize: 960 });
    streams.set(userId, opus);
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (streams.get(userId) === opus) streams.delete(userId);
      speakers.get(userId)?.end();
      decoder.destroy();
    };
    opus.once("end", cleanup).once("close", cleanup);
    opus.on("error", (err) => log.warn?.(`Voice receive (${userId}): ${err.message}`));
    decoder.on("error", (err) => log.warn?.(`Opus decode (${userId}): ${err.message}`));
    opus.pipe(decoder).on("data", (pcm) => speaker(userId).push(discordToEleven(pcm)));
  }

  connection.receiver.speaking.on("start", (userId) => hear(userId));

  const sweeper = setInterval(() => {
    for (const [id, s] of speakers) if (s.idle()) {
      s.close();
      speakers.delete(id);
    }
  }, 60_000);
  sweeper.unref?.();
  const limit = setTimeout(() => onLimit(`Hit the ${maxMinutes}-minute voice limit. Run /join to start again.`), maxMinutes * 60_000);
  limit.unref?.();

  function idle() {
    return new Promise((resolve) => {
      if (player.state.status === AudioPlayerStatus.Idle) return resolve();
      const done = () => {
        player.off(AudioPlayerStatus.Idle, done);
        resolve();
      };
      player.on(AudioPlayerStatus.Idle, done);
    });
  }

  async function drain() {
    if (speaking) return;
    speaking = true;
    try {
      while (queue.length && !stopped) {
        const { text, language: lang } = queue.shift();
        const out = new PassThrough();
        const upmix = createUpmixer();
        player.play(createAudioResource(out, { inputType: StreamType.Raw }));
        try {
          for await (const chunk of speak({ apiKey, text, voiceId, model: ttsModel, language: lang, fetchImpl })) {
            if (stopped) break;
            out.write(upmix(chunk));
          }
          onSpoken(text);
        } catch (err) {
          log.warn?.(`Text-to-speech: ${err.message}`);
          onError(err);
        } finally {
          out.end();
        }
        await idle();
      }
    } finally {
      speaking = false;
    }
  }

  // Check the key once up front, so a bad key fails /join instead of failing silently later.
  const ready = (async () => {
    const probe = openStt({});
    try {
      await probe.ready;
      log.info?.(JSON.stringify({ level: "info", message: "stt ready", model: "scribe_v2_realtime" }));
    } finally {
      probe.close();
    }
  })();
  ready.catch(() => {});

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(sweeper);
    clearTimeout(limit);
    queue.length = 0;
    for (const stream of streams.values()) stream.destroy();
    streams.clear();
    for (const s of speakers.values()) s.close();
    speakers.clear();
    player.stop(true);
  }

  return {
    ready,
    get language() {
      return lastLanguage;
    },
    say(text, { language: lang } = {}) {
      const content = String(text ?? "").trim();
      if (!content) throw new Error("content must be a non-empty string.");
      if (stopped) throw new Error("The voice call has ended.");
      queue.push({ text: content, language: lang || lastLanguage || null });
      void drain();
    },
    stop,
  };
}
