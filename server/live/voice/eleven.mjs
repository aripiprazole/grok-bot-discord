// WebSocket client for ElevenLabs Agents (wss://api.elevenlabs.io/v1/convai/conversation).

import WebSocket from "ws";

const CONNECT_TIMEOUT_MS = 15_000;
const API = "https://api.elevenlabs.io";

export function initiationMessage({ instructions, voiceId } = {}) {
  const override = {};
  if (instructions) override.agent = { prompt: { prompt: instructions } };
  if (voiceId) override.tts = { voice_id: voiceId };
  return {
    type: "conversation_initiation_client_data",
    ...(Object.keys(override).length ? { conversation_config_override: override } : {}),
  };
}

export function connectEleven({
  apiKey,
  agentId,
  voiceId,
  instructions,
  onEvent,
  onClose,
  fetchImpl = globalThis.fetch,
  WebSocketImpl,
}) {
  const WS = WebSocketImpl ?? WebSocket;
  let ws = null;
  const send = (event) => {
    if (ws && (ws.readyState === 1 || ws.readyState === WS.OPEN)) ws.send(JSON.stringify(event));
  };

  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = (err, value) => {
      settle = () => {};
      if (err) reject(err);
      else resolve(value);
    };
  });
  ready.catch(() => {});

  const fail = (err) => {
    settle(err);
    try {
      ws?.close(1000);
    } catch {
      // already closed
    }
  };

  (async () => {
    const timer = setTimeout(() => fail(new Error("Timed out connecting to ElevenLabs")), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    try {
      const url = `${API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
      const res = await fetchImpl(url, { headers: { "xi-api-key": apiKey } });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.signed_url) {
        const detail = data?.detail?.message ?? data?.detail ?? data?.message ?? `HTTP ${res.status}`;
        throw new Error(`ElevenLabs signed URL failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      }
      ws = new WS(data.signed_url);
      ws.on("open", () => send(initiationMessage({ instructions, voiceId })));
      ws.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (event.type === "conversation_initiation_metadata") {
          clearTimeout(timer);
          settle(null, event);
        }
        onEvent(event);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        fail(err);
      });
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        const why = reason?.toString?.() ?? "";
        settle(new Error(`ElevenLabs closed (${code}${why ? `: ${why}` : ""})`));
        onClose?.(code, why);
      });
    } catch (err) {
      clearTimeout(timer);
      fail(err);
    }
  })();

  return { ready, send, close: () => ws?.close(1000) };
}
