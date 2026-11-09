// Wakes the agent when Discord messages arrive by firing its Grok Bot routine's webhook
// ("When a webhook fires" trigger): POST <webhook URL> with "Authorization: Bearer <key>".
//
// Two kinds of wake:
// - urgent (mentions, DMs, replies, components): fire soon, covering any pending ambient too.
// - ambient (LISTEN_CHANNEL_IDS chatter with no ping): debounce — fire after AMBIENT_IDLE_MS of
//   quiet, or after AMBIENT_MAX_MS of continuous chatter, whichever comes first.
// Bursts of the same kind share one timer, and wake-ups are spaced by COOLDOWN_MS.

export const URGENT_DEBOUNCE_MS = 3_000;
export const COOLDOWN_MS = 60_000;
export const AMBIENT_IDLE_MS = 45_000;
export const AMBIENT_MAX_MS = 3 * 60_000;
const TIMEOUT_MS = 15_000;
const ROUTINE_WEBHOOK = /^https:\/\/[^/\s]+\/automations\/webhook\/[^/\s]+$/;

export function checkWebhook({ url, key } = {}) {
  if (!url || !key) return "Both the routine's webhook URL and key are needed.";
  if (!ROUTINE_WEBHOOK.test(url)) return "That doesn't look like a Grok Bot routine webhook URL (https://…/automations/webhook/…).";
  return null;
}

export function ambientDueAt({ firstAt, lastAt }, idleMs = AMBIENT_IDLE_MS, maxMs = AMBIENT_MAX_MS) {
  return Math.min(lastAt + idleMs, firstAt + maxMs);
}

export class Waker {
  constructor({
    getWebhook,
    pending,
    pendingDetail = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    log = console,
    onScheduleChange = null,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    Object.assign(this, { getWebhook, pending, pendingDetail, fetchImpl, now, log, onScheduleChange, setTimer, clearTimer });
    this.urgentTimer = null;
    this.ambientTimer = null;
    this.ambient = null; // { firstAt, lastAt } while ambient messages wait for a wake
    this.lastFiredAt = 0;
    this.lastError = null;
  }

  // Back-compat with older code that read `waker.timer`.
  get timer() {
    return this.urgentTimer ?? this.ambientTimer;
  }

  get connected() {
    return !checkWebhook(this.getWebhook() ?? {});
  }

  /**
   * A message arrived.
   * @param {{ kind?: "urgent" | "ambient" }} [opts] — default "urgent". Ambient chatter uses
   *   "ambient"; pings/DMs/replies/components use "urgent" (and cancel any ambient wait).
   */
  notify(opts = {}) {
    if (!this.connected) return;
    if (opts.kind === "ambient") this.scheduleAmbient();
    else this.scheduleUrgent();
  }

  scheduleUrgent() {
    this.clearAmbient(false);
    if (this.urgentTimer) return;
    const wait = Math.max(URGENT_DEBOUNCE_MS, this.lastFiredAt + COOLDOWN_MS - this.now());
    this.urgentTimer = this.setTimer(() => {
      this.urgentTimer = null;
      this.fire().catch(() => {});
    }, wait);
    this.urgentTimer?.unref?.();
    this.emitSchedule();
  }

  scheduleAmbient() {
    if (this.urgentTimer) return; // an urgent wake is already pending and will cover these
    const t = this.now();
    if (!this.ambient) this.ambient = { firstAt: t, lastAt: t };
    else this.ambient.lastAt = t;
    this.armAmbientTimer();
    this.emitSchedule();
  }

  armAmbientTimer() {
    if (this.ambientTimer) {
      this.clearTimer(this.ambientTimer);
      this.ambientTimer = null;
    }
    if (!this.ambient || this.urgentTimer) return;
    const due = ambientDueAt(this.ambient);
    const wait = Math.max(0, Math.max(due, this.lastFiredAt + COOLDOWN_MS) - this.now());
    this.ambientTimer = this.setTimer(() => {
      this.ambientTimer = null;
      this.fire().catch(() => {});
    }, wait);
    this.ambientTimer?.unref?.();
  }

  clearAmbient(emit = true) {
    if (this.ambientTimer) {
      this.clearTimer(this.ambientTimer);
      this.ambientTimer = null;
    }
    this.ambient = null;
    if (emit) this.emitSchedule();
  }

  // True when an ambient batch is waiting to wake (timer armed or due). Used by the DO alarm.
  ambientPending() {
    return Boolean(this.ambient);
  }

  ambientDue() {
    return this.ambient ? ambientDueAt(this.ambient) : null;
  }

  // Called from the Durable Object's periodic alarm: fire if ambient wait is over.
  tick() {
    if (!this.ambient || this.urgentTimer) return;
    if (this.now() >= Math.max(ambientDueAt(this.ambient), this.lastFiredAt + COOLDOWN_MS)) {
      if (this.ambientTimer) {
        this.clearTimer(this.ambientTimer);
        this.ambientTimer = null;
      }
      this.fire().catch(() => {});
    }
  }

  async fire() {
    if (this.urgentTimer) {
      this.clearTimer(this.urgentTimer);
      this.urgentTimer = null;
    }
    this.clearAmbient(false);
    const webhook = this.getWebhook();
    if (checkWebhook(webhook ?? {})) {
      this.emitSchedule();
      return false;
    }
    const pending = this.pending();
    if (!pending) {
      this.emitSchedule();
      return false;
    }
    this.lastFiredAt = this.now();
    const detail = this.pendingDetail?.() ?? null;
    const body = {
      source: "discord",
      pending,
      message: wakeMessage(pending, detail),
      ...(detail ? { detail } : {}),
    };
    try {
      // Call fetch unbound: Workers throw "Illegal invocation" when fetch runs with `this` set to another object.
      const doFetch = this.fetchImpl;
      const res = await doFetch(webhook.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${webhook.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
      this.lastError = null;
      this.emitSchedule();
      return true;
    } catch (err) {
      this.lastError = `${err.message} (${new Date(this.now()).toISOString()})`;
      this.log.warn(`Couldn't wake the agent: ${err.message}`);
      this.emitSchedule();
      return false;
    }
  }

  status() {
    if (!this.connected) return { connected: false };
    return {
      connected: true,
      lastFiredAt: this.lastFiredAt ? new Date(this.lastFiredAt).toISOString() : null,
      lastError: this.lastError,
      ambient: this.ambient ? { firstAt: this.ambient.firstAt, lastAt: this.ambient.lastAt, dueAt: ambientDueAt(this.ambient) } : null,
    };
  }

  snapshot() {
    return {
      lastFiredAt: this.lastFiredAt,
      lastError: this.lastError,
      ambient: this.ambient ? { firstAt: this.ambient.firstAt, lastAt: this.ambient.lastAt } : null,
    };
  }

  restore(state = {}) {
    if (typeof state.lastFiredAt === "number") this.lastFiredAt = state.lastFiredAt;
    if (state.lastError != null) this.lastError = state.lastError;
    if (state.ambient?.firstAt && state.ambient?.lastAt) {
      this.ambient = { firstAt: state.ambient.firstAt, lastAt: state.ambient.lastAt };
      this.armAmbientTimer();
    }
  }

  emitSchedule() {
    this.onScheduleChange?.(this.snapshot());
  }
}

export function wakeMessage(pending, detail) {
  const n = Number(pending) || 0;
  const ambient = detail?.ambient ?? 0;
  const urgent = detail?.urgent ?? Math.max(0, n - ambient);
  if (!ambient) return `${n} Discord message${n === 1 ? " is" : "s are"} waiting. Run the discord-inbox skill.`;
  if (!urgent) {
    return `${n} Discord message${n === 1 ? "" : "s"} from listen channels waiting (nobody pinged you). Run the discord-inbox skill — reply only when something is for you, otherwise skip.`;
  }
  return `${n} Discord conversations waiting (${urgent} ping${urgent === 1 ? "" : "s"}, ${ambient} from listen channels). Run the discord-inbox skill.`;
}
