// Used by each MCP server process: makes sure the background process is running with the
// current settings, and forwards voice/status calls to it.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configHash, loadLiveConfig, missingSettings } from "./config.mjs";
import { livePaths, request } from "./ipc.mjs";

const DAEMON = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
const START_WAIT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLiveClient({ env = process.env, version, spawnImpl = spawn, log = console }) {
  const config = loadLiveConfig(env);
  const disabled = missingSettings(config);
  const paths = config.token ? livePaths(config.token) : null;
  const hash = configHash(config, version);
  let starting = null;

  async function ping() {
    try {
      return await request(paths.socket, "ping", {}, 2_000);
    } catch {
      return null;
    }
  }

  function launch() {
    const out = openSync(paths.log, "a");
    const child = spawnImpl(process.execPath, [DAEMON], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...env, DISCORD_BOT_PLUGIN_VERSION: version },
    });
    child.unref();
  }

  // Starts the background process, or restarts it if it runs with different settings or version.
  async function ensure() {
    if (disabled) throw new Error(disabled);
    const running = await ping();
    if (running?.configHash === hash) return;
    if (running) {
      log.error("discord-bot: settings changed, restarting the background process");
      await request(paths.socket, "shutdown", { reason: "settings changed" }).catch(() => {});
      await sleep(500);
    }
    launch();
    for (let waited = 0; waited < START_WAIT_MS; waited += 250) {
      await sleep(250);
      if ((await ping())?.configHash === hash) return;
    }
    throw new Error(`The Discord background process didn't start. Log: ${paths.log}`);
  }

  return {
    disabled,
    logPath: paths?.log,

    // Fire-and-forget at MCP startup so the bot comes online without waiting for a tool call.
    start() {
      starting ??= ensure().catch((err) => {
        log.error(`discord-bot: ${err.message}`);
        starting = null;
      });
      return starting;
    },

    async call(method, params = {}, timeoutMs = 30_000) {
      await ensure();
      return request(paths.socket, method, params, timeoutMs);
    },
  };
}
