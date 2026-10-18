// Streamable HTTP around the existing JSON-RPC handler.
// One POST is one JSON-RPC message. GET is 405: this server doesn't push requests.
// Accept: text/event-stream gets the same reply as a single SSE event.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export async function handleMcpHttp(request, handleLine) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "GET") return json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" } }, 405);
  if (request.method === "DELETE") return json({ ok: true }, 200);
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const reply = await handleLine(await request.text());
  if (reply == null) return new Response(null, { status: 202, headers: CORS });
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
      status: 200,
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
  return json(reply, 200);
}
