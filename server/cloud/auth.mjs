// Bearer auth for the remote MCP endpoint. Hashes both sides first so a length
// difference isn't visible, then compares with a timing-safe equal.

import { timingSafeEqual } from "node:crypto";

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export async function tokensMatch(a, b) {
  const [left, right] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(left, right);
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function presentedToken(request) {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  const fromHeader = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? "";
  const fromQuery = new URL(request.url).searchParams.get("token") ?? "";
  return fromHeader || fromQuery;
}

// Missing server token is a misconfigured deploy (503). A wrong token is 401.
export async function authorizeBearer(request, expected) {
  if (!expected) return { ok: false, status: 503, error: "MCP_AUTH_TOKEN is not set." };
  const presented = presentedToken(request);
  if (!presented || !(await tokensMatch(presented, expected))) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true };
}
