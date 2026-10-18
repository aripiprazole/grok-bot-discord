// How a voice call talks to the Grok Bot agent. The voice side is only ears and a mouth:
// finished utterances go to the routine webhook (source "discord-voice"), and the agent
// answers by calling say_in_voice_call, which is spoken with ElevenLabs text-to-speech.

import { checkWebhook } from "../waker.mjs";

// Utterances that end within this window of each other go to the agent together.
export const BATCH_MS = 1_500;
const MAX_BATCH = 12;

const LANGUAGE_NAMES = { pt: "Portuguese", en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", ja: "Japanese", ko: "Korean", zh: "Chinese", ru: "Russian" };
export function languageName(code) {
  const base = String(code ?? "").toLowerCase().split(/[-_]/)[0];
  const iso3 = { por: "pt", eng: "en", spa: "es", fra: "fr", deu: "de", ita: "it", jpn: "ja", kor: "ko", zho: "zh", rus: "ru" };
  const two = iso3[base] ?? base;
  return LANGUAGE_NAMES[two] ?? (two || null);
}

// The language most of the batch was spoken in (the latest wins a tie).
export function dominantLanguage(utterances) {
  const counts = new Map();
  let best = null;
  for (const u of utterances) {
    if (!u.language) continue;
    const n = (counts.get(u.language) ?? 0) + 1;
    counts.set(u.language, n);
    if (!best || n >= counts.get(best)) best = u.language;
  }
  return best;
}

export function transcriptLines(utterances) {
  return utterances.map((u) => `${u.speaker ?? "someone"}${u.speakerId ? ` (id ${u.speakerId})` : ""}${u.language ? ` [${u.language}]` : ""}: ${u.text}`);
}

export function voiceWakeBody({ utterances, call }) {
  const list = (utterances ?? []).filter((u) => u?.text?.trim());
  const where = call?.place ?? "a Discord voice call";
  const language = dominantLanguage(list);
  const lang = languageName(language);
  const lines = transcriptLines(list);
  return {
    source: "discord-voice",
    kind: "voice_transcript",
    language,
    utterances: list.map((u) => ({ speaker: u.speaker ?? null, speakerId: u.speakerId ?? null, text: u.text, language: u.language ?? null, at: u.at ?? null })),
    request: list.map((u) => u.text).join(" "),
    call: call ?? null,
    message: [
      `Live transcript from ${where} (speech-to-text, may have small mistakes):`,
      ...lines.map((l) => `  ${l}`),
      "",
      "You're in this call. Not every line needs an answer: reply when someone talks to you, asks something, or a reply clearly fits; otherwise do nothing.",
      `To answer out loud, call say_in_voice_call with short, spoken-style text${lang ? ` in ${lang}, the language they spoke` : " in the language they spoke"}. Use your tools first if you need them.`,
    ].join("\n"),
  };
}

export async function fireVoiceRequest({ webhook, utterances, call, fetchImpl = globalThis.fetch, log = console }) {
  const problem = checkWebhook(webhook ?? {});
  if (problem) return { ok: false, error: problem };
  try {
    const res = await fetchImpl(webhook.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${webhook.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(voiceWakeBody({ utterances, call })),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn?.(`Couldn't hand the voice transcript to the agent: HTTP ${res.status}`);
      return { ok: false, error: `webhook returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    log.warn?.(`Couldn't hand the voice transcript to the agent: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Groups utterances that land close together (two people talking over each other, a sentence
// split by a breath) into one webhook call.
export function createUtteranceBatcher({ onFlush, delayMs = BATCH_MS, timers = globalThis }) {
  let batch = [];
  let timer = null;
  const flush = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (!batch.length) return;
    const out = batch;
    batch = [];
    onFlush(out);
  };
  return {
    add(utterance) {
      batch.push(utterance);
      if (batch.length >= MAX_BATCH) return flush();
      if (timer) timers.clearTimeout(timer);
      timer = timers.setTimeout(flush, delayMs);
      timer?.unref?.();
    },
    flush,
    get size() {
      return batch.length;
    },
  };
}
