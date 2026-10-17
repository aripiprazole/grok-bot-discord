// Discord messages waiting for the agent to answer. Saved to disk so nothing is lost when the
// background process restarts. One item per conversation; the agent claims items with a lease so
// two overlapping routine runs don't answer the same thing.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LEASE_MS = 10 * 60_000;
export const MAX_AGE_MS = 24 * 60 * 60_000;

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export class Inbox {
  constructor({ file = null, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.items = file ? (readJson(file, {}).items ?? []) : [];
  }

  save() {
    if (this.file) writeJson(this.file, { items: this.items });
  }

  isClaimed(item) {
    return item.claimedUntil > this.now();
  }

  /**
   * entry: { key, kind, channelId, place } identifies the conversation; message is a plain
   * { id, authorId, authorName, username, content, attachments, at, url }. New messages join the
   * conversation's waiting item unless the agent is already working on it.
   */
  add(entry, message) {
    let item = this.items.find((i) => i.key === entry.key && !this.isClaimed(i));
    if (!item) {
      item = { id: randomUUID().slice(0, 8), ...entry, messages: [], createdAt: this.now(), claimedUntil: 0 };
      this.items.push(item);
    }
    item.messages.push(message);
    this.save();
    return item;
  }

  // Oldest unclaimed items (or ones whose lease ran out), leased to the caller. Drops day-old items.
  claim(limit = 10) {
    const cutoff = this.now() - MAX_AGE_MS;
    this.items = this.items.filter((i) => i.createdAt >= cutoff);
    const ready = this.items.filter((i) => !this.isClaimed(i)).slice(0, limit);
    for (const item of ready) item.claimedUntil = this.now() + LEASE_MS;
    this.save();
    return ready;
  }

  get(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  // Removes and returns an item once it has been answered or skipped.
  take(id) {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) return null;
    const [item] = this.items.splice(index, 1);
    this.save();
    return item;
  }

  // Conversations nobody is working on, and how long the oldest has waited.
  waiting() {
    const open = this.items.filter((i) => !this.isClaimed(i));
    const oldest = open.reduce((min, i) => Math.min(min, i.createdAt), Infinity);
    return { count: open.length, oldestMs: open.length ? this.now() - oldest : 0 };
  }

  stats() {
    const oldest = this.items.reduce((min, i) => Math.min(min, i.createdAt), Infinity);
    return { pending: this.items.length, oldestMinutes: this.items.length ? Math.round((this.now() - oldest) / 60_000) : null };
  }
}
