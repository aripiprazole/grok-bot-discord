// One Durable Object holds the Discord gateway, the inbox, and the voice-call control sockets.
import { DurableObject } from "cloudflare:workers";
import { createCloudBot } from "../../server/cloud/bot.mjs";
import { FATAL_CLOSE_CODES, GATEWAY_URL, GatewaySession } from "../../server/cloud/gateway-session.mjs";
import { annotateVoiceStatus, flyControlUrl, voiceHosting } from "../../server/cloud/voice-host.mjs";
import { createClient } from "../../server/discord.mjs";
import { loadLiveConfig } from "../../server/live/config.mjs";
import { Inbox } from "../../server/live/inbox.mjs";
import { createUtteranceBatcher, fireVoiceRequest } from "../../server/live/voice/prompt.mjs";

const ALARM_MS = 30_000;

// GATEWAY_ENABLED=false keeps the Durable Object off the Discord gateway (REST tools still work).
// Use it while another process (e.g. the box daemon) is running with the same bot token.
export function gatewayEnabled(env) {
  return !/^(false|0|off|no)$/i.test(String(env?.GATEWAY_ENABLED ?? "true").trim());
}

export class DiscordGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.session = null;
    this.bot = null;
    this.sockets = new Map();
    this.health = new Map();
    this.batchers = new Map();
    this.fatal = null;
    this.fatalToken = null;
    this.sql = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    });
  }

  log(level, message, extra = {}) {
    console.log(JSON.stringify({ level, message, ...extra, ts: new Date().toISOString() }));
  }

  read(key) {
    const row = [...this.ctx.storage.sql.exec("SELECT value FROM kv WHERE key = ?", key)][0];
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  write(key, value) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  persist() {
    if (!this.bot) return;
    this.write("state", {
      inbox: this.bot.inbox.items,
      bot: this.bot.snapshot(),
      resume: this.session?.snapshot() ?? null,
      fatal: this.fatal,
      fatalToken: this.fatalToken,
    });
  }

  async boot() {
    await this.sql;
    if (this.bot) return;
    const stored = this.read("state") ?? {};
    const config = loadLiveConfig(this.env);
    const inbox = new Inbox({
      items: stored.inbox ?? [],
      now: () => Date.now(),
      persist: () => this.persist(),
    });
    this.bot = createCloudBot({
      config,
      inbox,
      log: {
        info: (message) => this.log("info", String(message)),
        warn: (message) => this.log("warn", String(message)),
        error: (message) => this.log("error", String(message)),
      },
      onEffects: (effects) => this.applyEffects(effects),
      // The Fly machine holds ELEVENLABS_API_KEY. The Container path still injects it from this Worker.
      requireElevenKey: voiceHosting(this.env) !== "fly",
    });
    this.bot.restore(stored.bot ?? {});
    // Items still waiting from before a restart or deploy get one wake-up, as if they had just arrived.
    if (this.bot.inbox.waiting().count) this.bot.waker.notify();
    this.session = new GatewaySession({
      token: config.token,
      onSend: (payload) => this.sendGateway(payload),
      onDispatch: (event) => this.onSession(event),
      onClose: (reason) => this.dropGateway(reason),
    });
    if (stored.resume) this.session.restore(stored.resume);
    this.fatal = stored.fatal ?? null;
    this.fatalToken = stored.fatalToken ?? null;
    if (this.fatalToken && this.fatalToken !== config.token) this.fatal = null;
  }

  sendGateway(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  onSession(event) {
    if (event.type === "RECONNECT" || event.type === "INVALID_SESSION") {
      this.dropGateway(event.type === "RECONNECT" ? "reconnect" : "invalid session");
      return;
    }
    if (event.type === "DISPATCH") {
      this.ctx.waitUntil(
        this.bot
          .dispatch(event.name, event.data)
          .then(() => this.persist())
          .catch((err) => this.log("error", "gateway dispatch failed", { error: err.message })),
      );
    }
  }

  dropGateway(reason) {
    this.log("warn", "discord gateway closed", { reason });
    this.session?.stop();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    if (gatewayEnabled(this.env)) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 5_000));
  }

  async ensureConnected() {
    await this.boot();
    if (!gatewayEnabled(this.env)) {
      if (this.ws) {
        try {
          this.ws.close(1000, "gateway disabled");
        } catch {
          // already closed
        }
        this.ws = null;
        this.session?.stop();
      }
      await this.ctx.storage.deleteAlarm();
      return { ok: false, disabled: true, error: "Gateway disabled (GATEWAY_ENABLED=false)." };
    }
    if (!this.env.DISCORD_BOT_TOKEN) return { ok: false, error: "DISCORD_BOT_TOKEN is not set." };
    if (this.fatal) return { ok: false, error: this.fatal };
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
      return { ok: true };
    }
    const url = this.session.resumeUrl ? `${String(this.session.resumeUrl).replace(/\/$/, "")}/?v=10&encoding=json` : GATEWAY_URL;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.session.receive(payload);
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws === ws) this.ws = null;
      this.session?.stop();
      if (FATAL_CLOSE_CODES.has(ev.code)) {
        this.fatalToken = this.env.DISCORD_BOT_TOKEN;
        this.fatal = ev.code === 4004 ? "Discord rejected the bot token." : "Discord refused the gateway. Turn on Message Content Intent, then redeploy or update the token.";
        this.persist();
        this.log("error", "discord gateway fatal close", { code: ev.code });
        return;
      }
      if (gatewayEnabled(this.env)) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 5_000));
    });
    ws.addEventListener("error", () => {});
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    return { ok: true };
  }

  async alarm() {
    await this.ensureConnected();
    for (const guildId of this.sockets.keys()) this.keepVoice(guildId);
  }

  async handle(method, params) {
    const gateway = await this.ensureConnected();
    let result = await this.bot.handle(method, params ?? {});
    if (method === "status" && result && typeof result === "object") {
      result = annotateVoiceStatus(result, this.env);
      result = gateway.disabled
        ? { ...result, status: "gateway disabled", gateway: "disabled", error: result.error ?? "GATEWAY_ENABLED=false, so REST tools work but there are no live events or inbox" }
        : { ...result, gateway: gateway.ok ? "enabled" : "error", gatewayError: gateway.ok ? null : gateway.error };
    }
    this.persist();
    return result;
  }

  async applyEffects(effects) {
    for (const effect of effects) {
      if (effect.type === "voice_start") await this.openVoice(effect.spec);
      else if (effect.type === "voice_stop") this.closeVoice(effect.guildId, effect.reason);
      else if (effect.type === "voice_packet") {
        const type = effect.packet.t === "VOICE_SERVER_UPDATE" ? "voice_server" : "voice_state";
        this.voiceSend(effect.guildId, { type, data: effect.packet.d });
      } else if (effect.type === "voice_say") this.voiceSend(effect.guildId, { type: "say", content: effect.content, language: effect.language ?? null });
    }
  }

  voiceSend(guildId, message) {
    const ws = this.sockets.get(guildId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  async openVoice(spec) {
    const hosting = voiceHosting(this.env);
    if (hosting === "container") await this.openContainerVoice(spec);
    else if (hosting === "fly") await this.openFlyVoice(spec);
    else throw new Error("Voice hosting isn't configured.");
  }

  async openContainerVoice(spec) {
    const stub = this.env.VOICE_HOST.getByName(spec.guildId);
    const res = await stub.fetch("https://voice/control", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) throw new Error("Voice container did not accept a control socket.");
    ws.accept();
    this.bindVoiceSocket(spec.guildId, ws, spec);
  }

  async openFlyVoice(spec) {
    const response = await fetch(flyControlUrl(this.env), {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${this.env.VOICE_HOST_SECRET}`,
      },
    });
    const ws = response.webSocket;
    if (!ws) {
      throw new Error(`Fly voice host refused the control socket (${response.status}).`);
    }
    ws.accept();
    this.bindVoiceSocket(spec.guildId, ws, spec);
  }

  bindVoiceSocket(guildId, ws, spec) {
    this.sockets.set(guildId, ws);
    ws.addEventListener("message", (ev) => {
      this.ctx.waitUntil(this.onVoiceMessage(guildId, ev.data));
    });
    ws.addEventListener("close", () => {
      if (this.sockets.get(guildId) === ws) {
        this.sockets.delete(guildId);
        this.stopHealth(guildId);
      }
    });
    // The API key rides this socket only. Do not log `start`.
    ws.send(JSON.stringify({
      type: "start",
      ...spec,
      elevenApiKey: this.env.ELEVENLABS_API_KEY || null,
      voiceId: this.env.ELEVENLABS_VOICE_ID || null,
      ttsModel: this.env.ELEVENLABS_TTS_MODEL || null,
    }));
    this.keepVoice(guildId);
  }

  async onVoiceMessage(guildId, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "gateway" && msg.payload) this.sendGateway(msg.payload);
    else if (msg.type === "utterance" && msg.text) {
      const speaker = await this.bot.memberName(guildId, msg.userId).catch(() => null);
      this.log("info", "voice utterance", { guildId, language: msg.language ?? null, chars: String(msg.text).length });
      this.batcher(guildId).add({ speaker: speaker ?? "someone", speakerId: msg.userId ?? null, text: String(msg.text), language: msg.language ?? null, at: msg.at ?? new Date().toISOString() });
    } else if (msg.type === "status") {
      this.log(msg.state === "ready" ? "info" : "warn", "voice status", { guildId, state: msg.state, error: msg.error ?? null });
    } else if (msg.type === "transcript" && msg.text && this.env.DISCORD_BOT_TOKEN) {
      const call = this.bot.calls.get(guildId);
      if (!call) return;
      const client = createClient({ token: this.env.DISCORD_BOT_TOKEN });
      await client
        .post(`/channels/${call.channelId}/messages`, {
          content: `🔊 **${call.botName}:** ${msg.text}`.slice(0, 2000),
          allowed_mentions: { parse: [] },
        })
        .catch((err) => this.log("warn", "voice transcript post failed", { error: err.message }));
    } else if (msg.type === "ended") {
      this.sockets.delete(guildId);
      this.stopHealth(guildId);
    }
  }

  // Finished utterances from one call, grouped briefly, then handed to the agent's routine.
  batcher(guildId) {
    let batcher = this.batchers.get(guildId);
    if (!batcher) {
      batcher = createUtteranceBatcher({
        onFlush: (utterances) => {
          const config = loadLiveConfig(this.env);
          const stored = this.bot.snapshot().webhook;
          const webhook = config.routineWebhook?.url ? config.routineWebhook : stored;
          this.ctx.waitUntil(
            fireVoiceRequest({
              webhook,
              utterances,
              call: this.bot.calls.get(guildId) ?? null,
              log: { warn: (message) => this.log("warn", String(message)) },
            }),
          );
        },
      });
      this.batchers.set(guildId, batcher);
    }
    return batcher;
  }

  keepVoice(guildId) {
    if (this.health.has(guildId)) return;
    // The container sleeps without traffic. Fly stays up; the ping only keeps the proxy from idling the socket.
    const timer = this.env.VOICE_HOST
      ? setInterval(() => {
          this.env.VOICE_HOST.getByName(guildId).fetch("https://voice/health").catch(() => {});
        }, 20_000)
      : setInterval(() => this.voiceSend(guildId, { type: "ping" }), 20_000);
    this.health.set(guildId, timer);
  }

  stopHealth(guildId) {
    const timer = this.health.get(guildId);
    if (timer) clearInterval(timer);
    this.health.delete(guildId);
  }

  closeVoice(guildId, reason) {
    this.voiceSend(guildId, { type: "stop", reason: reason ?? null });
    try {
      this.sockets.get(guildId)?.close();
    } catch {
      // already closed
    }
    this.sockets.delete(guildId);
    this.stopHealth(guildId);
  }
}
