// What the ElevenLabs agent is told, and the messages that connect it to the Grok Bot agent.

import { checkWebhook } from "../waker.mjs";

export const ASK_AGENT_TOOL_NAME = "ask_agent";

export const ASK_AGENT_RESULT =
  'Asked the Grok Bot agent. Keep the conversation going. When a message arrives that starts with "[From the Grok Bot agent", say that text out loud to the people on the call.';

export const ASK_AGENT_TOOL_CONFIG = {
  type: "client",
  name: ASK_AGENT_TOOL_NAME,
  description:
    "Hand a task or question to the Grok Bot agent, who has the owner's memory, tools, and Discord. Use this when someone on the call asks you to remember something, look something up, check on a task, post in Discord, or do anything you cannot do from the call alone. Tell them you're checking, then call this. Their answer arrives later as a message that starts with \"[From the Grok Bot agent\" — say that text out loud.",
  expects_response: true,
  response_timeout_secs: 30,
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "What the caller wants, including names and context from the conversation.",
      },
    },
    required: ["request"],
  },
};

export const DEFAULT_VOICE_PROMPT = [
  "You are talking with people in a Discord voice call.",
  "Speak naturally and keep replies short (one to three sentences) unless someone asks for detail.",
  "You only hear the call. You cannot see the screen or the text chat.",
  `When someone asks you to remember something, look something up, post in Discord, or do anything that needs the owner's memory and tools, call ${ASK_AGENT_TOOL_NAME} and tell them you're checking.`,
  `A later message that starts with "[From the Grok Bot agent" is the answer. Say it out loud, in your voice, briefly.`,
].join(" ");

export function voiceInstructions({ botName, listen, persona, extra }) {
  return [
    persona ? `You are ${botName}. ${persona}` : `You are ${botName}.`,
    `You're talking in a Discord voice call${listen === "everyone" ? " that may include several people" : ""}.`,
    "Speak naturally and keep replies short (one to three sentences) unless someone asks for detail.",
    "You only hear the call; you can't see the screen or the text chat. Stay in character.",
    `When someone asks you to remember something, look something up, post in Discord, or do anything that needs tools or memory, call the ${ASK_AGENT_TOOL_NAME} client tool and tell them you're checking.`,
    `If a message arrives that starts with "[From the Grok Bot agent", say that text out loud to the call.`,
    extra,
  ]
    .filter(Boolean)
    .join("\n");
}

export function toolResult(callId, result, isError = false) {
  return { type: "client_tool_result", tool_call_id: callId, result: String(result), is_error: isError };
}

// A user_message makes the ElevenLabs agent take a turn and speak.
export function speakRequest(content) {
  return {
    type: "user_message",
    text: `[From the Grok Bot agent — say this out loud to the people on the call, in your voice]\n${content}`,
  };
}

export function voiceWakeBody({ request, call }) {
  const where = call?.place ?? "a Discord voice call";
  return {
    source: "discord-voice",
    kind: "voice_request",
    request,
    call: call ?? null,
    message: `Someone in ${where} needs you: ${request}\nUse your tools if you need them, then speak the answer in the call with say_in_voice_call. Do not only reply in text.`,
  };
}

export async function fireVoiceRequest({ webhook, request, call, fetchImpl = globalThis.fetch, log = console }) {
  const problem = checkWebhook(webhook ?? {});
  if (problem) return { ok: false, error: problem };
  try {
    const res = await fetchImpl(webhook.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${webhook.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(voiceWakeBody({ request, call })),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn?.(`Couldn't hand the voice request to the agent: HTTP ${res.status}`);
      return { ok: false, error: `webhook returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    log.warn?.(`Couldn't hand the voice request to the agent: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
