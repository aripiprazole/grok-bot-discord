// Wakes the agent when Discord messages arrive by firing its Grok Bot routine's webhook
// ("When a webhook fires" trigger): POST <webhook URL> with "Authorization: Bearer <key>".
// Bursts of messages share one wake-up, and wake-ups are spaced out so runs don't pile up.

const DEBOUNCE_MS = 3_000;
const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 15_000;
const ROUTINE_WEBHOOK = /^https:\/\/[^/\s]+\/automations\/webhook\/[^/\s]+$/;

export function checkWebhook({ url, key } = {}) {
  if (!url || !key) return "Both the routine's webhook URL and key are needed.";
  if (!ROUTINE_WEBHOOK.test(url)) return "That doesn't look like a Grok Bot routine webhook URL (https://…/automations/webhook/…).";
  return null;
}

export class Waker {
  constructor({ getWebhook, pending, fetchImpl = globalThis.fetch, now = Date.now, log = console }) {
    Object.assign(this, { getWebhook, pending, fetchImpl, now, log });
    this.timer = null;
    this.lastFiredAt = 0;
    this.lastError = null;
  }

  get connected() {
    return !checkWebhook(this.getWebhook() ?? {});
  }

  // A message arrived: fire soon, but no sooner than the cooldown after the last wake-up.
  notify() {
    if (this.timer || !this.connected) return;
    const wait = Math.max(DEBOUNCE_MS, this.lastFiredAt + COOLDOWN_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire().catch(() => {});
    }, wait);
    this.timer.unref?.();
  }

  async fire() {
    const webhook = this.getWebhook();
    if (checkWebhook(webhook ?? {})) return false;
    const pending = this.pending();
    if (!pending) return false;
    this.lastFiredAt = this.now();
    try {
      const res = await this.fetchImpl(webhook.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${webhook.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "discord",
          pending,
          message: `${pending} Discord message${pending === 1 ? " is" : "s are"} waiting. Run the discord-inbox skill.`,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = `${err.message} (${new Date(this.now()).toISOString()})`;
      this.log.warn(`Couldn't wake the agent: ${err.message}`);
      return false;
    }
  }

  status() {
    if (!this.connected) return { connected: false };
    return { connected: true, lastFiredAt: this.lastFiredAt ? new Date(this.lastFiredAt).toISOString() : null, lastError: this.lastError };
  }
}
