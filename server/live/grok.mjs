// xAI Responses API client for text replies.

export const API_BASE = "https://api.x.ai/v1";
const TIMEOUT_MS = 120_000;

export function createGrok({ apiKey, model, tools = [], fetchImpl = globalThis.fetch }) {
  return {
    async reply({ instructions, input }) {
      const res = await fetchImpl(`${API_BASE}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: [{ role: "system", content: instructions }, ...input],
          ...(tools.length ? { tools: tools.map((type) => ({ type })) } : {}),
          store: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = data?.error?.message ?? data?.error ?? data?.message ?? res.statusText;
        throw new Error(`xAI API ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      }
      return parseResponse(data);
    },
  };
}

// Pulls the answer text and cited URLs out of a Responses API result.
export function parseResponse(data) {
  const texts = [];
  const sources = new Map();
  for (const item of data?.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      texts.push(part.text);
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && a.url && !sources.has(a.url)) sources.set(a.url, a.title);
      }
    }
  }
  for (const url of data?.citations ?? []) {
    if (typeof url === "string" && !sources.has(url)) sources.set(url, undefined);
  }
  const text = texts.join("\n\n").trim() || (typeof data?.output_text === "string" ? data.output_text.trim() : "");
  return { text, sources: [...sources].map(([url, title]) => ({ url, title })) };
}
