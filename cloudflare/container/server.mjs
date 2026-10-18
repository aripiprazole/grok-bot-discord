// Voice host. HTTP /health stays public and returns no secrets. /control is the
// WebSocket the gateway Durable Object uses. Do not log the start payload (it can hold the API key).
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { startDiscordCall } from "./server/cloud/discord-voice-call.mjs";
import { createVoiceController } from "./server/cloud/voice-controller.mjs";
import { voiceControlAuthorized, withVoiceHostEnv } from "./server/cloud/voice-host.mjs";

const port = Number(process.env.PORT) || 8080;

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
  const url = new URL(req.url, "http://localhost");
  void voiceControlAuthorized({
    authorization: req.headers.authorization,
    token: url.searchParams.get("token"),
    secret: process.env.VOICE_HOST_SECRET,
    flyApp: process.env.FLY_APP_NAME,
  }).then((ok) => {
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      console.log(JSON.stringify({ level: "info", message: "voice control connected" }));
      const controller = createVoiceController({
        startCall: (spec, hooks) => startDiscordCall(withVoiceHostEnv(spec), { ...hooks, log: console }),
      });
      controller.attach(ws);
    });
  }).catch(() => {
    socket.destroy();
  });
});

server.listen(port, "0.0.0.0");
