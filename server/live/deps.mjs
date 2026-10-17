// Installs the live connection's npm dependencies into the plugin folder on first run.
// Plugins are installed from git without node_modules, so this replaces a manual `npm install`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";

const REQUIRED = ["discord.js", "@discordjs/voice", "prism-media", "opusscript", "ws"];
const MIN_NODE = [22, 12];

export function nodeTooOld(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]) ? `Node.js ${MIN_NODE.join(".")}+ is required (found ${version}).` : null;
}

export const dependenciesInstalled = (root) => REQUIRED.every((name) => existsSync(join(root, "node_modules", name, "package.json")));

export function installDependencies(root, log) {
  if (dependenciesInstalled(root)) return Promise.resolve();
  log.info("Installing Discord dependencies (first run only)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
      cwd: root,
      // Prefer the npm that ships next to this node binary.
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (err) => reject(new Error(`Couldn't run npm: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0 && dependenciesInstalled(root)) resolve();
      else reject(new Error(`npm ci failed (exit ${code}): ${output.trim().split("\n").slice(-5).join(" ")}`));
    });
  });
}
