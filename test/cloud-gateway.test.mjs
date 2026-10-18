import assert from "node:assert/strict";
import { test } from "node:test";
import { GATEWAY_INTENTS, GATEWAY_URL, GatewaySession } from "../server/cloud/gateway-session.mjs";

function session(extra = {}) {
  const sent = [];
  const events = [];
  const closes = [];
  const gateway = new GatewaySession({
    token: "bot-token",
    onSend: (payload) => sent.push(payload),
    onDispatch: (event) => events.push(event),
    onClose: (reason) => closes.push(reason),
    schedule: () => 0,
    ...extra,
  });
  return { gateway, sent, events, closes };
}

test("hello identifies and a missed ack closes the socket", () => {
  const { gateway, sent, closes } = session();
  assert.equal(GATEWAY_INTENTS, 37505);
  assert.match(GATEWAY_URL, /encoding=json/);
  gateway.receive({ op: 10, d: { heartbeat_interval: 41250 } });
  assert.equal(sent[0].op, 1);
  assert.equal(sent[1].op, 2);
  assert.equal(sent[1].d.token, "bot-token");
  assert.equal(sent[1].d.intents, 37505);
  gateway.beat();
  gateway.receive({ op: 11 });
  gateway.beat();
  gateway.beat();
  assert.deepEqual(closes, ["HEARTBEAT_MISSED"]);
});

test("ready stores the resume url and the next hello resumes", () => {
  const { gateway, sent, events } = session();
  gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  gateway.receive({ op: 0, t: "READY", s: 1, d: { session_id: "sess", resume_gateway_url: "wss://gateway-east.discord.gg" } });
  assert.equal(events.at(-1).name, "READY");
  assert.deepEqual(gateway.snapshot(), { sessionId: "sess", resumeUrl: "wss://gateway-east.discord.gg", seq: 1 });
  const next = session();
  next.gateway.restore(gateway.snapshot());
  next.gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(next.sent[1].op, 6);
  assert.equal(next.sent[1].d.session_id, "sess");
  assert.equal(sent[1].op, 2);
});

test("invalid session clears resume state", () => {
  const { gateway, events } = session();
  gateway.restore({ sessionId: "sess", resumeUrl: "wss://x", seq: 4 });
  gateway.receive({ op: 9, d: false });
  assert.equal(gateway.snapshot().sessionId, null);
  assert.equal(events[0].type, "INVALID_SESSION");
  gateway.receive({ op: 7 });
  assert.equal(events[1].type, "RECONNECT");
});
