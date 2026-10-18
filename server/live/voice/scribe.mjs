// ElevenLabs Scribe realtime speech-to-text (wss://api.elevenlabs.io/v1/speech-to-text/realtime).
// One socket per speaker. We commit manually when Discord says that person stopped talking,
// so each committed transcript is one utterance with its own detected language.

import WebSocket from "ws";

export const STT_MODEL = "scribe_v2_realtime";
export const STT_RATE = 16_000;
const API = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const CONNECT_TIMEOUT_MS = 15_000;
// committed_transcript arrives first; the *_with_timestamps copy carries language_code. Wait briefly for it.
const LANGUAGE_WAIT_MS = 1_500;

export function scribeUrl({ model = STT_MODEL, language = null, keyterms = [] } = {}) {
  const params = new URLSearchParams({
    model_id: model,
    audio_format: `pcm_${STT_RATE}`,
    commit_strategy: "manual",
    include_timestamps: "true",
    include_language_detection: "true",
  });
  if (language) params.set("language_code", language);
  for (const term of keyterms) params.append("keyterms", term);
  return `${API}?${params}`;
}

// Scribe tags non-speech as "(music)", "[laughs]" and so on. Those aren't words anyone said.
export function cleanTranscript(text) {
  return String(text ?? "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when there is nothing worth handing to the agent (silence, a lone filler, punctuation).
export function isNoise(text) {
  const clean = cleanTranscript(text);
  if (!clean) return true;
  const letters = clean.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < 2) return true;
  return /^(u+h*m*|h+m+|a+h+|e+h+m*|o+h+|m+|hã|ãh)$/iu.test(letters);
}

export function audioChunk(pcm, commit = false) {
  return { message_type: "input_audio_chunk", audio_base_64: pcm.toString("base64"), commit, sample_rate: STT_RATE };
}

const ERRORS = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "invalid_request",
  "chunk_size_exceeded",
  "transcriber_error",
]);
// Committing a stretch with no speech in it. Expected when someone just breathes into the mic.
const QUIET = new Set(["insufficient_audio_activity"]);

/**
 * connectScribe({ apiKey, onCommitted({ text, language }), onError, onClose })
 * Returns { ready, send(pcm16kMono), commit(), close() }. Audio sent before the socket opens is queued.
 */
export function connectScribe({ apiKey, language = null, keyterms = [], onCommitted = () => {}, onPartial = () => {}, onError = () => {}, onClose = () => {}, WebSocketImpl, url, timers = globalThis }) {
  if (!apiKey) throw new Error("Voice calls need an ElevenLabs API key: set ELEVENLABS_API_KEY.");
  const WS = WebSocketImpl ?? WebSocket;
  const ws = new WS(url ?? scribeUrl({ language, keyterms }), { headers: { "xi-api-key": apiKey } });
  const queue = [];
  let open = false;
  let closed = false;
  let pending = null; // { text, timer }

  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = (err) => {
      settle = () => {};
      if (err) reject(err);
      else resolve();
    };
  });
  ready.catch(() => {});
  const timeout = timers.setTimeout(() => settle(new Error("Timed out connecting to ElevenLabs speech-to-text")), CONNECT_TIMEOUT_MS);
  timeout?.unref?.();

  const raw = (message) => {
    if (closed) return;
    if (!open) {
      queue.push(message);
      return;
    }
    ws.send(JSON.stringify(message));
  };

  function emit(text, language) {
    const clean = cleanTranscript(text);
    if (isNoise(clean)) return;
    onCommitted({ text: clean, language: language || null });
  }

  function flushPending(language = null) {
    if (!pending) return;
    timers.clearTimeout(pending.timer);
    const { text } = pending;
    pending = null;
    emit(text, language);
  }

  const on = (event, fn) => (typeof ws.on === "function" ? ws.on(event, fn) : ws.addEventListener(event, fn));
  on("open", () => {
    open = true;
    for (const message of queue.splice(0)) ws.send(JSON.stringify(message));
  });
  on("message", (data) => {
    let event;
    try {
      event = JSON.parse(String(data?.data ?? data));
    } catch {
      return;
    }
    const type = event.message_type;
    if (type === "session_started") {
      timers.clearTimeout(timeout);
      settle(null);
    } else if (type === "partial_transcript") {
      onPartial(event.text ?? "");
    } else if (type === "committed_transcript") {
      flushPending();
      pending = { text: event.text ?? "", timer: timers.setTimeout(() => flushPending(), LANGUAGE_WAIT_MS) };
      pending.timer?.unref?.();
    } else if (type === "committed_transcript_with_timestamps") {
      if (pending && pending.text === (event.text ?? "")) flushPending(event.language_code);
      else {
        flushPending();
        emit(event.text, event.language_code);
      }
    } else if (QUIET.has(type)) {
      // nothing was said
    } else if (ERRORS.has(type)) {
      const err = new Error(`ElevenLabs speech-to-text ${type}: ${event.error ?? "unknown error"}`);
      settle(err);
      onError(err);
    }
  });
  on("error", (err) => {
    timers.clearTimeout(timeout);
    settle(err instanceof Error ? err : new Error("ElevenLabs speech-to-text socket error"));
    onError(err instanceof Error ? err : new Error("ElevenLabs speech-to-text socket error"));
  });
  on("close", (code, reason) => {
    const c = typeof code === "object" ? code.code : code;
    const why = String((typeof code === "object" ? code.reason : reason) ?? "");
    timers.clearTimeout(timeout);
    flushPending();
    closed = true;
    settle(new Error(`ElevenLabs speech-to-text closed (${c}${why ? `: ${why}` : ""})`));
    onClose(c, why);
  });
  if (typeof ws.on === "function") ws.on("unexpected-response", (_req, res) => {
    const err = new Error(`ElevenLabs speech-to-text refused the connection (HTTP ${res.statusCode}).`);
    settle(err);
    onError(err);
  });

  return {
    ready,
    get closed() {
      return closed;
    },
    send(pcm) {
      if (pcm?.length) raw(audioChunk(pcm, false));
    },
    commit() {
      raw(audioChunk(Buffer.alloc(0), true));
    },
    close() {
      if (closed) return;
      closed = true;
      flushPending();
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    },
  };
}
