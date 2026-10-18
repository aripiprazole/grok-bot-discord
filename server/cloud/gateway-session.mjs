// Discord gateway session: identify, resume, heartbeat, and voice-state updates.
// The socket itself lives in the caller (a Durable Object, or a test).

export const GATEWAY_INTENTS = (1 << 0) | (1 << 7) | (1 << 9) | (1 << 12) | (1 << 15);
export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export class GatewaySession {
  constructor({ token, intents = GATEWAY_INTENTS, onSend, onDispatch, onClose, schedule = (fn, ms) => setInterval(fn, ms) }) {
    this.token = token;
    this.intents = intents;
    this.onSend = onSend;
    this.onDispatch = onDispatch ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.schedule = schedule;
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
    this.timer = null;
    this.acked = true;
    this.identified = false;
  }

  snapshot() {
    return { sessionId: this.sessionId, resumeUrl: this.resumeUrl, seq: this.seq };
  }

  restore(snap) {
    if (!snap?.sessionId) return;
    this.sessionId = snap.sessionId;
    this.resumeUrl = snap.resumeUrl ?? null;
    this.seq = snap.seq ?? null;
  }

  send(payload) {
    this.onSend(payload);
  }

  identify() {
    this.identified = true;
    this.send({
      op: 2,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: "linux", browser: "grok-bot-discord", device: "grok-bot-discord" },
      },
    });
  }

  resume() {
    this.identified = true;
    this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
  }

  voiceState(guildId, channelId, { selfMute = false, selfDeaf = false } = {}) {
    this.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf } });
  }

  hello(interval) {
    this.acked = true;
    this.arm(interval);
    this.send({ op: 1, d: this.seq });
    if (this.sessionId) this.resume();
    else this.identify();
  }

  arm(interval) {
    if (this.timer) clearInterval(this.timer);
    const handle = this.schedule(() => this.beat(), interval);
    this.timer = handle;
  }

  beat() {
    if (!this.acked) {
      this.onClose("HEARTBEAT_MISSED");
      return;
    }
    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  receive(payload) {
    if (payload.s != null) this.seq = payload.s;
    switch (payload.op) {
      case 10:
        this.hello(payload.d.heartbeat_interval);
        break;
      case 11:
        this.acked = true;
        break;
      case 1:
        this.send({ op: 1, d: this.seq });
        break;
      case 7:
        this.onDispatch({ type: "RECONNECT" });
        break;
      case 9:
        if (!payload.d) {
          this.sessionId = null;
          this.resumeUrl = null;
          this.seq = null;
        }
        this.onDispatch({ type: "INVALID_SESSION", resumable: Boolean(payload.d) });
        break;
      case 0:
        if (payload.t === "READY") {
          this.sessionId = payload.d.session_id;
          this.resumeUrl = payload.d.resume_gateway_url;
        }
        this.onDispatch({ type: "DISPATCH", name: payload.t, data: payload.d });
        break;
      default:
        break;
    }
  }
}
