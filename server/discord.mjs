// Minimal Discord REST (v10) client: bot-token auth, rate-limit retry, readable errors.

export const API_BASE = "https://discord.com/api/v10";

const USER_AGENT = "DiscordBot (https://github.com/aripiprazole/grok-bot-discord, 0.3.0)";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_S = 10;

const HINTS = {
  401: "The bot token was rejected. Update DISCORD_BOT_TOKEN in the plugin settings (Plugins → Configure).",
  403: "The bot is missing permissions here. It needs View Channel, Send Messages and Read Message History in this channel (plus Create Public Threads / Add Reactions for those actions).",
  404: "Not found. Check the ID, and that the bot has been invited to that server (list_servers shows an invite link).",
};

export class DiscordError extends Error {
  constructor(status, data, route) {
    const detail = data?.message ?? "request failed";
    const code = data?.code ? ` (code ${data.code})` : "";
    const fields = data?.errors ? ` ${JSON.stringify(data.errors).slice(0, 500)}` : "";
    const hint = HINTS[status] ? ` ${HINTS[status]}` : "";
    super(`Discord API ${status} on ${route}: ${detail}${code}.${fields}${hint}`);
    this.status = status;
    this.code = data?.code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

export function createClient({ token, fetchImpl = globalThis.fetch, wait = sleep }) {
  const auth = `Bot ${token.replace(/^Bot\s+/i, "").trim()}`;

  async function request(method, path, { body, query } = {}) {
    let url = API_BASE + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: auth,
          "User-Agent": USER_AGENT,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = res.status === 204 ? "" : await res.text();
      const data = text ? parseJson(text) : null;

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(data?.retry_after ?? res.headers.get("retry-after") ?? 1);
        if (retryAfter <= MAX_RETRY_WAIT_S) {
          await wait(retryAfter * 1000);
          continue;
        }
      }
      if (!res.ok) throw new DiscordError(res.status, data, `${method} ${path}`);
      return data;
    }
  }

  return {
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
    patch: (path, body) => request("PATCH", path, { body }),
    put: (path) => request("PUT", path),
  };
}
