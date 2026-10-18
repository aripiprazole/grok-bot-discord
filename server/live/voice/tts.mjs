// ElevenLabs text-to-speech, streamed as 48 kHz mono PCM so it plays in Discord without resampling.

export const TTS_MODEL = "eleven_flash_v2_5"; // multilingual (Portuguese, English, Spanish, …), low latency
export const TTS_FORMAT = "pcm_48000";
// A premade voice every ElevenLabs account has. ELEVENLABS_VOICE_ID overrides it.
export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const API = "https://api.elevenlabs.io";

// ElevenLabs takes ISO 639-1 codes. Scribe can report ISO 639-3 ("por"); map the common ones.
const ISO3 = { por: "pt", eng: "en", spa: "es", fra: "fr", deu: "de", ita: "it", jpn: "ja", kor: "ko", zho: "zh", cmn: "zh", rus: "ru", pol: "pl", nld: "nl", tur: "tr", hin: "hi", ara: "ar" };
export function ttsLanguage(code) {
  const raw = String(code ?? "").trim().toLowerCase();
  if (!raw) return null;
  const base = raw.split(/[-_]/)[0];
  if (/^[a-z]{2}$/.test(base)) return base;
  return ISO3[base] ?? null;
}

export function ttsRequest({ text, voiceId, model = TTS_MODEL, language = null }) {
  const lang = ttsLanguage(language);
  return {
    url: `${API}/v1/text-to-speech/${encodeURIComponent(voiceId || DEFAULT_VOICE_ID)}/stream?output_format=${TTS_FORMAT}`,
    body: { text, model_id: model, ...(lang ? { language_code: lang } : {}) },
  };
}

// Yields PCM chunks (48 kHz mono s16le) as ElevenLabs streams them.
export async function* synthesize({ apiKey, text, voiceId, model, language, fetchImpl = globalThis.fetch, signal }) {
  if (!apiKey) throw new Error("Voice calls need an ElevenLabs API key: set ELEVENLABS_API_KEY.");
  const { url, body } = ttsRequest({ text, voiceId, model, language });
  let res = await fetchImpl(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/pcm" },
    body: JSON.stringify(body),
    signal,
  });
  // Not every model accepts language_code. Retry once without it rather than going silent.
  if (res.status === 400 && body.language_code) {
    const { language_code: _drop, ...rest } = body;
    res = await fetchImpl(url, { method: "POST", headers: { "xi-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(rest), signal });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs text-to-speech failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  if (!res.body) {
    yield Buffer.from(await res.arrayBuffer());
    return;
  }
  for await (const chunk of res.body) yield Buffer.from(chunk);
}
