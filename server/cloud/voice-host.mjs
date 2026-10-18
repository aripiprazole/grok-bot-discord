// Chooses where a voice call runs, and checks the shared secret on the voice host.
// The Cloudflare Container binding wins when it is present. Otherwise VOICE_HOST_URL
// plus VOICE_HOST_SECRET mean the Fly.io machine.

import { tokensMatch } from "./auth.mjs";
import { setting } from "../settings.mjs";

// A key with nowhere to run the call is not a missing key.
export function withoutVoiceHost(status) {
  if (!status || typeof status !== "object" || !status.voiceEnabled) return status;
  return { ...status, voiceEnabled: false, voiceUnavailable: "the voice host isn't deployed" };
}

export function annotateVoiceStatus(status, env) {
  if (!status || typeof status !== "object") return status;
  const host = voiceHosting(env);
  if (host === "fly") return { ...status, voiceEnabled: true, voiceHost: "fly" };
  if (host === "container") return { ...status, voiceHost: "container" };
  return withoutVoiceHost(status);
}

export function voiceHosting(env) {
  if (env?.VOICE_HOST) return "container";
  if (setting(env?.VOICE_HOST_URL) && setting(env?.VOICE_HOST_SECRET)) return "fly";
  return null;
}

export function flyControlUrl(env) {
  const raw = setting(env?.VOICE_HOST_URL);
  if (!raw) throw new Error("VOICE_HOST_URL is not set.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("VOICE_HOST_URL must be an https URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") throw new Error("VOICE_HOST_URL must be an https URL.");
  url.protocol = "https:";
  url.pathname = "/control";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// A Fly deploy can hold the ElevenLabs key. A start message from the Worker wins when it has one.
export function withVoiceHostEnv(spec, env = process.env) {
  return {
    ...spec,
    elevenApiKey: spec?.elevenApiKey || setting(env.ELEVENLABS_API_KEY) || "",
    agentId: spec?.agentId || setting(env.ELEVENLABS_AGENT_ID) || null,
    voiceId: spec?.voiceId || setting(env.ELEVENLABS_VOICE_ID) || null,
  };
}

// No secret is allowed only off Fly (the Cloudflare container network is private).
// Fly injects FLY_APP_NAME, so a Fly machine without VOICE_HOST_SECRET refuses /control.
export async function voiceControlAuthorized({ authorization, token, secret, flyApp }) {
  const expected = setting(secret);
  if (!expected) return !setting(flyApp);
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1] ?? "";
  if (bearer && (await tokensMatch(bearer, expected))) return true;
  if (token && (await tokensMatch(token, expected))) return true;
  return false;
}
