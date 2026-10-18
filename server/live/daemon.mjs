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

function ready() {
  if (!gateway) throw new Error(`The Discord connection isn't ready (${state.status}${state.error ? `: ${state.error}` : ""}).`);
  return gateway;
}

async function handle(method, params) {
  switch (method) {
    case "ping":
      return { configHash: hash };
    case "status":
      return { ...state, ...(gateway ? gateway.status() : {}) };
    case "join":
      return ready().join(params);
    case "leave":
      return ready().leave(params);
    case "voice.say":
      return ready().say(params);
    case "inbox.check":
      return ready().inbox.check(params);
    case "inbox.reply":
      return ready().inbox.reply(params);
    case "inbox.skip":
      return ready().inbox.skip(params);
    case "persona.set":
      return ready().setPersona(params);
    case "routine.set":
      return ready().setRoutineWebhook(params);
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

// A bad token or an old Node.js won't fix itself (new settings restart this process anyway).
// Anything else is retried: network trouble, a Discord outage, or the Message Content Intent
// being off, which people fix in the Developer Portal while this keeps checking.
const FATAL = /token|Node\.js|npm/i;
const INTENT_RETRY_MS = 20_000;

for (let delay = 15_000; ; delay = Math.min(delay * 2, 5 * 60_000)) {
  try {
    const tooOld = nodeTooOld();
    if (tooOld) throw new Error(tooOld);
    state.status = "installing dependencies";
    await installDependencies(ROOT, log);
    state.status = "connecting to Discord";
    const { startGateway } = await import("./gateway.mjs");
    gateway = await startGateway({ config, dataDir: paths.data, log });
    state.status = "online";
    state.error = null;
    break;
  } catch (err) {
    state.status = "error";
    state.error = err.message;
    log.error(err.stack ?? err.message);
    if (FATAL.test(err.message)) break;
    await new Promise((resolve) => setTimeout(resolve, /intent/i.test(err.message) ? INTENT_RETRY_MS : delay));
  }
}
