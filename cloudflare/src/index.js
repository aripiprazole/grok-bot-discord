// Cloudflare Worker: remote MCP, Discord gateway Durable Object, voice containers.
import { authorizeBearer } from "../../server/cloud/auth.mjs";
import { handleMcpHttp } from "../../server/cloud/mcp-http.mjs";
import { createHandler } from "../../server/mcp-core.mjs";
import { DiscordGateway } from "./gateway-do.js";
import { VoiceHost } from "./voice-do.js";

export { DiscordGateway, VoiceHost };

function cloudLive(env) {
  return {
    logPath: "Cloudflare Durable Object (discord-gateway)",
    call(method, params) {
      return env.DISCORD_GATEWAY.getByName("bot").handle(method, params ?? {});
    },
  };
}

function mcpHandler(env) {
  return createHandler({
    config: { token: env.DISCORD_BOT_TOKEN, defaultChannelId: env.DISCORD_DEFAULT_CHANNEL_ID },
    live: cloudLive(env),
  });
}

function mcpSocket(request, env, ctx) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const handleLine = mcpHandler(env);
  server.addEventListener("message", (ev) => {
    const pending = handleLine(String(ev.data)).then((reply) => {
      if (reply) server.send(JSON.stringify(reply));
    });
    ctx.waitUntil(pending);
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "grok-bot-discord" });
    }
    if (url.pathname === "/mcp" || url.pathname === "/mcp/ws") {
      const auth = await authorizeBearer(request, env.MCP_AUTH_TOKEN);
      if (!auth.ok) {
        return Response.json({ error: auth.error }, { status: auth.status, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      if (url.pathname === "/mcp/ws") return mcpSocket(request, env, ctx);
      return handleMcpHttp(request, mcpHandler(env));
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(env.DISCORD_GATEWAY.getByName("bot").ensureConnected());
  },
};
