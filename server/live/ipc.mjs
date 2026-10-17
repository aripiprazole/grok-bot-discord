// Local socket between MCP server processes and the one background process per bot token.
// Newline-delimited JSON: {id, method, params} → {id, result} | {id, error}.

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function livePaths(token, dir = tmpdir()) {
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return {
    socket: process.platform === "win32" ? `\\\\.\\pipe\\discord-bot-${id}` : join(dir, `discord-bot-${id}.sock`),
    log: join(dir, `discord-bot-${id}.log`),
  };
}

function serve(path, handler) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        Promise.resolve()
          .then(() => handler(msg.method, msg.params ?? {}))
          .then(
            (result) => ({ id: msg.id, result: result ?? null }),
            (err) => ({ id: msg.id, error: err?.message ?? String(err) }),
          )
          .then((reply) => socket.writable && socket.write(`${JSON.stringify(reply)}\n`));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export function request(path, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    let buffer = "";
    const done = (fn, value) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error(`No answer from the Discord background process (${method})`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (err) => done(reject, err));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const reply = JSON.parse(buffer.slice(0, newline));
      if (reply.error) done(reject, new Error(reply.error));
      else done(resolve, reply.result);
    });
  });
}

/**
 * Listens on `path` unless another live process already answers there. A socket file left
 * behind by a crashed process is removed. Returns the server, or null if someone else owns it.
 */
export async function claim(path, handler) {
  try {
    return await serve(path, handler);
  } catch (err) {
    if (err.code !== "EADDRINUSE") throw err;
  }
  try {
    await request(path, "ping", {}, 2_000);
    return null;
  } catch {
    if (process.platform !== "win32") {
      try {
        unlinkSync(path);
      } catch {}
    }
    try {
      return await serve(path, handler);
    } catch (err) {
      if (err.code === "EADDRINUSE") return null; // lost a race with another process
      throw err;
    }
  }
}
