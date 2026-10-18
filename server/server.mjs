// MCP server over stdio. Speaks MCP's newline-delimited JSON-RPC directly, so the tools work
// straight from the cloned plugin; only the live connection (live/) needs npm packages.

import { createInterface } from "node:readline";
import { createHandler } from "./mcp-core.mjs";

export { PROTOCOL_VERSIONS, SERVER_INFO, createHandler } from "./mcp-core.mjs";

export function serve({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const handleLine = createHandler(options);
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    try {
      const reply = await handleLine(line);
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    } catch (err) {
      console.error(`discord-bot: ${err.stack ?? err}`);
    }
  });
  return rl;
}
