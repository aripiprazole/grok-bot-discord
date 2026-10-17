#!/usr/bin/env node
// Background process that keeps the bot online in Discord. One runs per bot token; the plugin's MCP
// server starts it (detached) and talks to it over a local socket. It outlives individual agent
// sessions so @mentions and voice calls work whenever the computer is on.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configHash, loadLiveConfig, missingSettings } from "./config.mjs";
import { installDependencies, nodeTooOld } from "./deps.mjs";
import { claim, livePaths } from "./ipc.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const VERSION = process.env.DISCORD_BOT_PLUGIN_VERSION ?? "dev";
const UNINSTALL_CHECK_MS = 5 * 60_000;

const stamp = () => new Date().toISOString();
const log = {
  info: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), "warn:", ...args),
  error: (...args) => console.error(stamp(), "error:", ...args),
};

const config = loadLiveConfig(process.env);
const problem = missingSettings(config);
if (problem) {
  log.error(problem);
  process.exit(1);
}

const hash = configHash(config, VERSION);
const state = { pid: process.pid, configHash: hash, version: VERSION, status: "starting", error: null, startedAt: stamp() };
let gateway = null;

async function shutdown(reason) {
  log.info(`Shutting down: ${reason}`);
  await gateway?.stop("I'm restarting. Be right back.").catch(() => {});
  process.exit(0);
}

async function handle(method, params) {
  switch (method) {
    case "ping":
      return { configHash: hash };
    case "status":
      return { ...state, ...(gateway ? gateway.status() : {}) };
    case "join":
      if (!gateway) throw new Error(`The Discord connection isn't ready (${state.status}${state.error ? `: ${state.error}` : ""}).`);
      return gateway.join(params);
    case "leave":
      if (!gateway) throw new Error("The Discord connection isn't ready.");
      return gateway.leave(params);
    case "shutdown":
      setTimeout(() => shutdown(params.reason ?? "requested"), 50);
      return "ok";
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

const paths = livePaths(config.token);
const server = await claim(paths.socket, handle);
if (!server) {
  log.info("Another background process already serves this bot; exiting.");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown(signal));

// Exit if the plugin was uninstalled (its files are gone).
setInterval(() => existsSync(SELF) || shutdown("plugin removed"), UNINSTALL_CHECK_MS).unref();

// Settings problems won't fix themselves; anything else (network, Discord outage) is retried.
const FATAL = /token|intent|Node\.js|npm/i;

for (let delay = 15_000; ; delay = Math.min(delay * 2, 5 * 60_000)) {
  try {
    const tooOld = nodeTooOld();
    if (tooOld) throw new Error(tooOld);
    state.status = "installing dependencies";
    await installDependencies(ROOT, log);
    state.status = "connecting to Discord";
    const { startGateway } = await import("./gateway.mjs");
    gateway = await startGateway({ config, log });
    state.status = "online";
    state.error = null;
    break;
  } catch (err) {
    state.status = "error";
    state.error = err.message;
    log.error(err.stack ?? err.message);
    if (FATAL.test(err.message)) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
