// WebSocket client for Grok realtime voice (wss://api.x.ai/v1/realtime).

import WebSocket from "ws";

const CONNECT_TIMEOUT_MS = 15_000;

export function connectRealtime({ apiKey, model, session, onEvent, onClose, WebSocketImpl = WebSocket }) {
  const ws = new WebSocketImpl(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const send = (event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  let settle;
  // Resolves once Grok accepts the session config; rejects if the connection fails first.
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Grok voice")), CONNECT_TIMEOUT_MS);
    settle = (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
  });
  ready.catch(() => {}); // callers await it; a late failure must not become an unhandled rejection

  ws.on("open", () => send({ type: "session.update", session }));
  ws.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (event.type === "session.updated") settle();
    else if (event.type === "error") settle(new Error(event.error?.message ?? "Grok voice rejected the session"));
    onEvent(event);
  });
  ws.on("error", (err) => settle(err));
  ws.on("close", (code, reason) => {
    settle(new Error(`Grok voice closed (${code}${reason.length ? `: ${reason}` : ""})`));
    onClose(code, reason.toString());
  });

  return { ready, send, close: () => ws.close(1000) };
}
