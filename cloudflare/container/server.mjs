// Voice container. HTTP /health keeps the instance counted as busy; /control is the
// WebSocket the gateway Durable Object uses. Do not log the start payload (it holds the API key).
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { startDiscordCall } from "./server/cloud/discord-voice-call.mjs";
import { createVoiceController } from "./server/cloud/voice-controller.mjs";

const server = createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const path = req.url?.split("?")[0];
  if (path !== "/control") {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    console.log(JSON.stringify({ level: "info", message: "voice control connected" }));
    const controller = createVoiceController({
      startCall: (spec, hooks) => startDiscordCall(spec, { ...hooks, log: console }),
    });
    controller.attach(ws);
  });
});

server.listen(8080, "0.0.0.0");
