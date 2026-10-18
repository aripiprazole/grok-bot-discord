// Makes sure an ElevenLabs agent exists and has the ask_agent client tool attached.
// The owner can pass ELEVENLABS_AGENT_ID. Otherwise we reuse or create an agent named grok-bot-discord.

import { ASK_AGENT_TOOL_CONFIG, DEFAULT_VOICE_PROMPT } from "./prompt.mjs";

const API = "https://api.elevenlabs.io";
export const MANAGED_AGENT_NAME = "grok-bot-discord";

async function api(fetchImpl, apiKey, path, { method = "GET", body } = {}) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { "xi-api-key": apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail?.message ?? data?.detail ?? data?.message ?? `HTTP ${res.status}`;
    throw new Error(`ElevenLabs ${method} ${path} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return data;
}

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

export async function ensureElevenAgent({ apiKey, agentId = null, voiceId = null, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("Voice calls need an ElevenLabs API key: set ELEVENLABS_API_KEY.");
  const toolId = await ensureTool(fetchImpl, apiKey);
  const id = agentId || (await findOrCreateAgent(fetchImpl, apiKey, toolId, voiceId));
  await attachTool(fetchImpl, apiKey, id, toolId);
  return { agentId: id, toolId };
}

async function ensureTool(fetchImpl, apiKey) {
  const existing = listOf(await api(fetchImpl, apiKey, "/v1/convai/tools"), "tools").find((tool) => tool.tool_config?.name === ASK_AGENT_TOOL_CONFIG.name || tool.name === ASK_AGENT_TOOL_CONFIG.name);
  if (existing?.id) return existing.id;
  const created = await api(fetchImpl, apiKey, "/v1/convai/tools", { method: "POST", body: { tool_config: ASK_AGENT_TOOL_CONFIG } });
  if (!created?.id) throw new Error("ElevenLabs did not return an id for the ask_agent tool.");
  return created.id;
}

async function findOrCreateAgent(fetchImpl, apiKey, toolId, voiceId) {
  const found = listOf(await api(fetchImpl, apiKey, "/v1/convai/agents"), "agents").find((agent) => agent.name === MANAGED_AGENT_NAME);
  if (found?.agent_id) return found.agent_id;
  const created = await api(fetchImpl, apiKey, "/v1/convai/agents/create", {
    method: "POST",
    body: {
      name: MANAGED_AGENT_NAME,
      conversation_config: {
        agent: {
          prompt: { prompt: DEFAULT_VOICE_PROMPT, tool_ids: [toolId] },
          first_message: "",
        },
        ...(voiceId ? { tts: { voice_id: voiceId } } : {}),
      },
      // Lets each call pass the Discord persona and an optional voice without editing the agent.
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: { prompt: { prompt: true }, first_message: true },
            tts: { voice_id: true },
          },
        },
      },
    },
  });
  if (!created?.agent_id) throw new Error("ElevenLabs did not return an agent id.");
  return created.agent_id;
}

async function attachTool(fetchImpl, apiKey, agentId, toolId) {
  const agent = await api(fetchImpl, apiKey, `/v1/convai/agents/${agentId}`);
  const prompt = agent?.conversation_config?.agent?.prompt ?? {};
  const toolIds = new Set(prompt.tool_ids ?? []);
  if (toolIds.has(toolId)) return;
  toolIds.add(toolId);
  const next = { tool_ids: [...toolIds] };
  if (typeof prompt.prompt === "string") next.prompt = prompt.prompt;
  if (prompt.llm) next.llm = prompt.llm;
  await api(fetchImpl, apiKey, `/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    body: { conversation_config: { agent: { prompt: next } } },
  });
}
