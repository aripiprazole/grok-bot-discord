// Command line for agents that can run shell commands but can't install MCP servers
// (for example a personal Grok Bot). Same tools as the MCP server:
//   grok-bot-discord <tool> ['{"json":"arguments"}' | -]
// Settings come from the environment, or from ~/.discord-bot-plugin/.env.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLiveClient } from "./live/client.mjs";
import { resolveSecretRefs } from "./secrets.mjs";
import { SERVER_INFO } from "./server.mjs";
import { TOOLS, callTool, createToolContext, hasTool, loadConfig } from "./tools.mjs";

export const CONFIG_FILE = join(homedir(), ".discord-bot-plugin", ".env");

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function usage() {
  const lines = [
    `grok-bot-discord ${SERVER_INFO.version}: Discord for agents.`,
    "",
    "Usage: grok-bot-discord <tool> ['{\"json\":\"arguments\"}' | -]   (- reads the JSON from stdin)",
    `Settings: DISCORD_BOT_TOKEN (required), XAI_API_KEY, REPLY_MODE, ROUTINE_WEBHOOK_URL/KEY, ALLOWED_IDS, ALLOWED_CHANNEL_IDS, LISTEN_CHANNEL_IDS`,
    `          from the environment or ${CONFIG_FILE}. Values may be 1Password references (op://vault/item/field).`,
    "",
    "Tools:",
  ];
  for (const tool of TOOLS) {
    const props = Object.entries(tool.inputSchema.properties ?? {});
    const required = new Set(tool.inputSchema.required ?? []);
    const args = props.map(([name]) => (required.has(name) ? name : `${name}?`)).join(", ");
    lines.push(`  ${tool.name}${args ? ` {${args}}` : ""}`, `      ${tool.description}`);
  }
  return lines.join("\n");
}

export async function run(command, args) {
  if (existsSync(CONFIG_FILE)) process.loadEnvFile(CONFIG_FILE); // doesn't override variables already set
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (!hasTool(command)) {
    console.error(`Unknown tool "${command}". Run "grok-bot-discord help" for the list.`);
    return 2;
  }
  try {
    Object.assign(process.env, resolveSecretRefs(process.env));
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  let params;
  try {
    params = JSON.parse(args[0] === "-" ? await readStdin() : (args[0] ?? "{}"));
  } catch (err) {
    console.error(`Arguments must be one JSON object: ${err.message}`);
    return 2;
  }
  const live = createLiveClient({ version: SERVER_INFO.version, log: { error: (...a) => console.error(...a) } });
  const result = await callTool(command, params, createToolContext(loadConfig(), undefined, live));
  const text = result.content.map((c) => c.text).join("\n");
  if (result.isError) console.error(text);
  else console.log(text);
  return result.isError ? 1 : 0;
}
