import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotateVoiceStatus,
  flyControlUrl,
  voiceControlAuthorized,
  voiceHosting,
  withVoiceHostEnv,
} from "../server/cloud/voice-host.mjs";

test("the container binding wins over a Fly URL", () => {
  assert.equal(voiceHosting({ VOICE_HOST: {}, VOICE_HOST_URL: "https://voice.fly.dev", VOICE_HOST_SECRET: "s" }), "container");
  assert.equal(voiceHosting({ VOICE_HOST_URL: "https://voice.fly.dev", VOICE_HOST_SECRET: "s" }), "fly");
  assert.equal(voiceHosting({ VOICE_HOST_URL: "https://voice.fly.dev" }), null);
  assert.equal(voiceHosting({}), null);
});

test("fly control url is https /control", () => {
  assert.equal(flyControlUrl({ VOICE_HOST_URL: "wss://grok-bot-discord-voice.fly.dev/ignored?x=1" }), "https://grok-bot-discord-voice.fly.dev/control");
  assert.throws(() => flyControlUrl({ VOICE_HOST_URL: "http://voice.fly.dev" }), /https/);
});

test("status names Fly when that host is configured and a missing host when it is not", () => {
  const keyed = { voiceEnabled: true };
  assert.deepEqual(annotateVoiceStatus(keyed, { VOICE_HOST_URL: "https://voice.fly.dev", VOICE_HOST_SECRET: "s" }), {
    voiceEnabled: true,
    voiceHost: "fly",
  });
  assert.equal(annotateVoiceStatus({ voiceEnabled: false }, { VOICE_HOST_URL: "https://voice.fly.dev", VOICE_HOST_SECRET: "s" }).voiceEnabled, true);
  assert.equal(annotateVoiceStatus(keyed, { VOICE_HOST: {} }).voiceHost, "container");
  assert.equal(annotateVoiceStatus(keyed, {}).voiceUnavailable, "the voice host isn't deployed");
  assert.equal(annotateVoiceStatus({ voiceEnabled: false }, {}).voiceUnavailable, undefined);
});

test("the voice host fills a missing ElevenLabs key from its own environment", () => {
  assert.equal(withVoiceHostEnv({ elevenApiKey: "from-worker" }, { ELEVENLABS_API_KEY: "from-fly" }).elevenApiKey, "from-worker");
  assert.equal(withVoiceHostEnv({ elevenApiKey: null }, { ELEVENLABS_API_KEY: "from-fly" }).elevenApiKey, "from-fly");
  assert.equal(withVoiceHostEnv({}, { ELEVENLABS_TTS_MODEL: "eleven_multilingual_v2" }).ttsModel, "eleven_multilingual_v2");
  assert.equal(withVoiceHostEnv({}, { ELEVENLABS_API_KEY: "from-fly", ELEVENLABS_VOICE_ID: "voice" }).voiceId, "voice");
});

test("control auth fails closed on Fly and accepts the bearer or query token", async () => {
  assert.equal(await voiceControlAuthorized({ secret: "", flyApp: "" }), true);
  assert.equal(await voiceControlAuthorized({ secret: "", flyApp: "grok-bot-discord-voice" }), false);
  assert.equal(await voiceControlAuthorized({ authorization: "Bearer secret", secret: "secret", flyApp: "app" }), true);
  assert.equal(await voiceControlAuthorized({ token: "secret", secret: "secret", flyApp: "app" }), true);
  assert.equal(await voiceControlAuthorized({ authorization: "Bearer no", secret: "secret", flyApp: "app" }), false);
});
