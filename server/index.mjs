#!/usr/bin/env node
// With no arguments: the MCP server (stdio). With a tool name: the command line (see cli.mjs).

const [command, ...args] = process.argv.slice(2);

if (command) {
  const { run } = await import("./cli.mjs");
  process.exit(await run(command, args));
} else {
  const { resolveSecretRefs } = await import("./secrets.mjs");
  let startupError = null;
  try {
    Object.assign(process.env, resolveSecretRefs(process.env));
  } catch (err) {
    startupError = err.message;
    console.error(`discord-bot: ${startupError}`);
  }
  const { createLiveClient } = await import("./live/client.mjs");
  const { SERVER_INFO, serve } = await import("./server.mjs");
  // Keeps the bot online in Discord (inbox, voice) in a background process.
  const live = createLiveClient({ version: SERVER_INFO.version });
  if (!live.disabled && !startupError) live.start();
  serve({ live, startupError });
}
