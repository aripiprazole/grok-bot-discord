// One container per guild. Discord voice is UDP, which Workers cannot send, so the
// container runs @discordjs/voice and the ElevenLabs Agents socket.
import { DurableObject } from "cloudflare:workers";

const INACTIVITY_MS = 5 * 60 * 1000;
const PORT = 8080;

const wait = (ms) => (typeof scheduler !== "undefined" && scheduler.wait ? scheduler.wait(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

export class VoiceHost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.starting = null;
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
  }

  async fetch(request) {
    await this.ensureStarted();
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  async ensureStarted() {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("Voice needs Cloudflare Containers. Deploy on a Workers plan that includes Containers. wrangler deploy builds the image with local Docker.");
    }
    if (!this.starting) {
      const pending = this.start().catch((err) => {
        if (this.starting === pending) this.starting = null;
        throw err;
      });
      this.starting = pending;
    }
    await this.starting;
  }

  async start() {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        image: container.images.voice,
        instance: "basic",
        enableInternet: true,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_MS);
    const port = container.getTcpPort(PORT);
    let lastError = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await port.fetch("http://container/health", { signal: AbortSignal.timeout(1_000) });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`Health check returned ${response.status}`);
      } catch (err) {
        lastError = err;
      }
      await wait(200);
    }
    throw new Error(`Voice container did not become ready (${lastError?.message ?? "unknown"}).`);
  }
}
