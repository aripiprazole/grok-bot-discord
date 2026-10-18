// Speaks the control protocol between the gateway Durable Object and the voice container.
// One WebSocket, JSON messages. The API key arrives on `start` and is never logged.

export function createVoiceController({ startCall }) {
  let session = null;

  function send(ws, message) {
    if (ws.readyState != null && ws.readyState !== 1 && ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  function attach(ws) {
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }
      if (msg.type === "start") {
        session?.stop("replaced");
        session = startCall(msg, {
          sendPayload: (payload) => send(ws, { type: "gateway", payload }),
          onEnded: (reason) => send(ws, { type: "ended", reason: reason ?? null }),
          onStatus: (state) => send(ws, { type: "status", state }),
          onAgentRequest: ({ request, call }) => send(ws, { type: "agent_request", request, call }),
          onTranscript: (text) => send(ws, { type: "transcript", text }),
        });
        return;
      }
      if (!session) return;
      if (msg.type === "voice_state") session.feed({ t: "VOICE_STATE_UPDATE", d: msg.data });
      else if (msg.type === "voice_server") session.feed({ t: "VOICE_SERVER_UPDATE", d: msg.data });
      else if (msg.type === "say") {
        try {
          session.say(msg.content);
        } catch (err) {
          send(ws, { type: "status", state: "error", error: err.message });
        }
      } else if (msg.type === "stop") {
        session.stop(msg.reason ?? null);
        session = null;
      } else if (msg.type === "ping") send(ws, { type: "pong" });
    };
    if (typeof ws.on === "function") ws.on("message", onMessage);
    else ws.addEventListener("message", (ev) => onMessage(ev.data));
    return { get session() { return session; } };
  }

  return { attach };
}
