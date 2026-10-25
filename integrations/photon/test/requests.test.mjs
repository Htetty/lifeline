import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocationRequests } from "../src/requests.mjs";
import { startControlServer } from "../src/control-server.mjs";
import { startLocationServer } from "../src/location-server.mjs";

const line = "+15555550100";
const caller = "+15555550101";
const other = "+15555550102";
const call = "CA" + "b".repeat(32);
const secondCall = "CA" + "c".repeat(32);
const id = n => String(n).repeat(32).slice(0, 32);
const text = (sender = caller, messageId = "m1") => ({ id: messageId, platform: "imessage", direction: "inbound",
  sender: { address: sender, service: "iMessage" }, content: { type: "text", text: "hi" } });
const dm = (sender = caller) => ({ type: "dm", id: `any;-;${sender}`, phone: "shared" });
const settled = () => new Promise(setImmediate);

// A fresh fixture is a freshly started Photon process: nothing remembered from before.
function fixture(options = {}) {
  const sent = [];
  const opened = [];
  const checked = [];
  const events = [];
  const unreachable = new Set(options.unreachable ?? []);
  let now = 1_000_000;
  const requests = createLocationRequests({ line, allowedSenders: new Set([caller, other]),
    issueLink: context => `https://location.example/l/${context.requestId}`,
    reachable: async recipient => { checked.push(recipient); return !unreachable.has(recipient); },
    openConversation: async recipient => { opened.push(recipient); return dm(recipient); },
    sendCard: async (space, url) => { sent.push({ to: space.id, content: { type: "richlink", url } }); return { id: `out-${sent.length}`, isSent: true }; },
    now: () => now, statusChecks: [], log: value => events.push(value), ...options });
  return { requests, sent, opened, checked, events, advance: ms => { now += ms; } };
}

test("consent sends one card straight to the caller's conversation, with no prior text", async () => {
  const { requests, sent, opened, checked } = fixture();
  const created = requests.create({ requestId: id(1), callId: call, recipient: caller });
  assert.equal(created.code, 201);
  assert.deepEqual(created.body, { requestId: id(1), callId: call, status: "sending" });
  await settled();
  assert.deepEqual(checked, [caller]); // live iMessage reachability before anything is sent
  assert.deepEqual(opened, [caller]);
  assert.deepEqual(sent, [{ to: `any;-;${caller}`, content: { type: "richlink", url: `https://location.example/l/${id(1)}` } }]);
  assert.equal(requests.get(id(1), call).body.status, "sent");
});

test("after a restart an existing user still gets the card without texting first", async () => {
  // First process: a call, then the process stops.
  const before = fixture();
  before.requests.create({ requestId: id(1), callId: call, recipient: caller });
  await settled();
  await before.requests.close();
  // Restarted process: no incoming message has been seen at all.
  const after = fixture();
  after.requests.create({ requestId: id(2), callId: secondCall, recipient: caller });
  await settled();
  assert.equal(after.sent.length, 1);
  assert.equal(after.requests.get(id(2), secondCall).body.status, "sent");
  assert.equal(after.requests.get(id(1), call).code, 404); // old requests are gone, not resumed
});

test("incoming texts never create requests or cards, whatever they say", async () => {
  const { requests, sent, opened } = fixture();
  assert.equal(requests.inbound(dm(), text()), "not-a-location-request");
  assert.equal(requests.inbound(dm(), { ...text(), sender: { address: caller, service: "SMS" } }), "not-imessage-service");
  assert.equal(requests.inbound({ ...dm(), type: "group", id: "any;+;group" }, text()), "not-direct-imessage");
  await settled();
  assert.deepEqual(sent, []);
  // Even with a request in flight, a text changes nothing.
  requests.create({ requestId: id(1), callId: call, recipient: caller });
  requests.inbound(dm(), text(caller, "m2"));
  await settled();
  assert.equal(sent.length, 1);
  assert.equal(opened.length, 1);
});

test("unenrolled or iMessage-unreachable numbers get nothing, with no SMS/RCS fallback", async () => {
  const { requests, sent, opened } = fixture({ unreachable: [other] });
  assert.equal(requests.create({ requestId: id(1), callId: call, recipient: "+15555550109" }).code, 422);
  assert.equal(await requests.eligible("+15555550109"), false);
  assert.equal(await requests.eligible(other), false);
  assert.equal(await requests.eligible(caller), true);
  requests.create({ requestId: id(2), callId: secondCall, recipient: other });
  await settled();
  assert.equal(requests.get(id(2), secondCall).body.status, "unavailable");
  assert.deepEqual(sent, []);
  assert.deepEqual(opened, []); // not even a conversation is opened
  // A reachability check that can't run is a failure, not a guess.
  const broken = fixture({ reachable: async () => { throw new Error("rpc down"); } });
  broken.requests.create({ requestId: id(3), callId: call, recipient: caller });
  await settled();
  assert.equal(broken.requests.get(id(3), call).body.status, "failed");
  await assert.rejects(broken.requests.eligible(caller));
  assert.deepEqual(broken.sent, []);
});

test("a send the provider reports as leaving iMessage is a failure", async () => {
  const { requests } = fixture({ lookup: async () => ({ id: "out-1", isSent: true, transport: "SMS" }),
    sendCard: async () => ({ id: "out-1" }), statusChecks: [1] });
  requests.create({ requestId: id(1), callId: call, recipient: caller });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.get(id(1), call).body.status, "failed");
});

test("replayed and concurrent create calls send one card", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { requests, sent } = fixture({ sendCard: async (space, url) => { sent.push(url); await gate; return { id: "out" }; } });
  const results = [requests.create({ requestId: id(1), callId: call, recipient: caller }),
    requests.create({ requestId: id(1), callId: call, recipient: caller }),
    requests.create({ requestId: id(2), callId: call, recipient: caller })];
  assert.deepEqual(results.map(r => r.code), [201, 200, 409]);
  await settled();
  release();
  await settled();
  assert.equal(sent.length, 1);
});

test("a slow send and delivery lookup never block other requests or incoming texts", async t => {
  let releaseSend, releaseLookup, lookupStarted;
  const sendGate = new Promise(resolve => { releaseSend = resolve; });
  const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const attempts = [];
  const { requests } = fixture({
    sendCard: async space => {
      attempts.push(space.id);
      if (space.id === dm().id) await sendGate;
      return { id: space.id, isSent: true };
    },
    lookup: async () => { lookupStarted(); await lookupGate; return { isDelivered: true }; },
    statusChecks: [1],
  });
  t.after(async () => { releaseSend(); releaseLookup(); await requests.close(); });
  requests.create({ requestId: id(1), callId: call, recipient: caller });
  requests.create({ requestId: id(2), callId: secondCall, recipient: other });
  await settled();
  assert.equal(requests.get(id(1), call).body.status, "sending");
  assert.equal(requests.get(id(2), secondCall).body.status, "sent");
  assert.equal(attempts.length, 2);
  assert.equal(requests.inbound(dm(), text(caller, "during")), "not-a-location-request");
  releaseSend();
  // Status checks wait on unreferenced timers (they never hold the process open), so
  // keep the loop alive with a referenced deadline while the lookup starts.
  let timeout;
  await Promise.race([started, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Status lookup never started")), 200);
  })]).finally(() => clearTimeout(timeout));
  assert.equal(requests.inbound(dm(), text(caller, "new")), "not-a-location-request");
});

test("the same phone can receive and confirm a fresh link on a later call", async t => {
  const { requests, sent } = fixture();
  t.after(() => requests.close());
  for (const [requestId, callId] of [[id(1), call], [id(2), secondCall]]) {
    assert.equal(requests.create({ requestId, callId, recipient: caller }).code, 201);
    await settled();
    assert.equal(requests.confirmed({ latitude: 32.7, longitude: -117.1, accuracyMeters: 9,
      capturedAt: "fixture" }, { requestId, callId }), true);
    assert.equal(requests.get(requestId, callId).body.status, "confirmed");
  }
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].content.url, sent[1].content.url);
  assert.equal(requests.get(id(1), secondCall).code, 404);
});

test("one active request per call and per recipient; creation is idempotent", () => {
  const { requests } = fixture();
  assert.equal(requests.create({ requestId: id(1), callId: call, recipient: caller }).code, 201);
  assert.equal(requests.create({ requestId: id(1), callId: call, recipient: caller }).code, 200);
  assert.equal(requests.create({ requestId: id(1), callId: secondCall, recipient: caller }).code, 409);
  assert.deepEqual(requests.create({ requestId: id(2), callId: call, recipient: caller }).body, { error: "call_has_active_request" });
  assert.deepEqual(requests.create({ requestId: id(3), callId: secondCall, recipient: caller }).body, { error: "recipient_has_active_request" });
  for (const bad of [{ requestId: "nope", callId: call, recipient: caller }, { requestId: id(4), callId: "x y", recipient: caller },
    { requestId: id(4), callId: call, recipient: "5555550101" }]) assert.equal(requests.create(bad).code, 400);
  // Status and cancel need the owning call.
  assert.equal(requests.get(id(1), secondCall).code, 404);
  assert.equal(requests.cancel(id(1), secondCall).code, 404);
  assert.equal(requests.cancel(id(1), call).body.status, "cancelled");
  assert.equal(requests.create({ requestId: id(2), callId: call, recipient: caller }).code, 201);
});

test("acceptance, sent and delivered are reported separately; failures are not retried", async () => {
  const records = [{ id: "out" }, { id: "out", isSent: true }, { id: "out", isSent: true, isDelivered: true }];
  const { requests } = fixture({ sendCard: async () => records[0], lookup: async () => records.shift() && records[0], statusChecks: [30, 30] });
  requests.create({ requestId: id(1), callId: call, recipient: caller });
  assert.equal(requests.get(id(1), call).body.status, "sending");
  await settled();
  assert.equal(requests.get(id(1), call).body.status, "accepted");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests.get(id(1), call).body.status, "delivered");

  for (const failure of [async () => { throw new Error("offline"); }, async () => undefined, async () => ({ id: "x", sendErrorCode: 22 })]) {
    let attempts = 0;
    const f = fixture({ sendCard: async (...args) => { attempts++; return failure(...args); } });
    f.requests.create({ requestId: id(1), callId: call, recipient: caller });
    await settled();
    assert.equal(f.requests.get(id(1), call).body.status, "failed");
    assert.equal(attempts, 1);
  }
  const noChat = fixture({ openConversation: async () => { throw new Error("no chat"); } });
  noChat.requests.create({ requestId: id(1), callId: call, recipient: caller });
  await settled();
  assert.equal(noChat.requests.get(id(1), call).body.status, "failed");
  assert.deepEqual(noChat.sent, []);
});

test("links expire; a request cancelled before its send never sends", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const { requests, sent, advance } = fixture({ ttlMs: 5000,
    reachable: async () => { if (first) { first = false; await gate; } return true; } });
  requests.create({ requestId: id(1), callId: call, recipient: caller });
  requests.cancel(id(1), call);
  release();
  await settled();
  assert.deepEqual(sent, []);
  requests.create({ requestId: id(2), callId: call, recipient: caller });
  await settled();
  assert.equal(requests.get(id(2), call).body.status, "sent");
  advance(5000);
  assert.equal(requests.get(id(2), call).body.status, "expired");
  assert.equal(requests.isActive({ requestId: id(2), callId: call }), false);
});

test("a confirmation is bound to its own call and request; late ones are refused", async t => {
  const { requests, events } = fixture();
  requests.create({ requestId: id(1), callId: call, recipient: caller });
  await settled();
  const service = await startLocationServer({ port: 0, isActive: requests.isActive, onConfirmed: requests.confirmed });
  t.after(() => service.close());
  const link = service.issue({ requestId: id(1), callId: call });
  const stray = service.issue({ requestId: id(1), callId: secondCall });
  const post = (url, fix) => fetch(url.replace("/l/", "/api/location/"), { method: "POST",
    headers: { "content-type": "application/json", origin: service.localOrigin }, body: JSON.stringify(fix) });
  const fix = { latitude: 32.7612, longitude: -117.1675, accuracy: 9, capturedAt: Date.now() };
  assert.equal((await post(stray, fix)).status, 410); // a link for another call never reaches this request
  assert.equal((await post(link, fix)).status, 200);
  assert.equal((await post(link, fix)).status, 200); // idempotent retry
  const confirmed = requests.get(id(1), call).body;
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual([confirmed.location.latitude, confirmed.location.longitude, confirmed.location.accuracyMeters], [32.7612, -117.1675, 9]);
  assert.equal(events.filter(e => e.event === "location.confirmed").length, 1);
  assert.equal(events.find(e => e.event === "location.confirmed").callId, call);

  // Call ended before the caller confirmed: the page and the submission are refused.
  const ended = "CA" + "d".repeat(32);
  requests.create({ requestId: id(2), callId: ended, recipient: other });
  const late = service.issue({ requestId: id(2), callId: ended });
  requests.cancel(id(2), ended);
  assert.equal((await fetch(late)).status, 410);
  assert.equal((await post(late, fix)).status, 410);
  assert.equal(requests.get(id(2), ended).body.status, "cancelled");
});

test("the control API requires the bridge token, refuses browsers and binds loopback only", async t => {
  const { requests } = fixture({ unreachable: [other] });
  const token = "t".repeat(40);
  await assert.rejects(startControlServer({ requests, token: "short", port: 0 }), /PHOTON_BRIDGE_TOKEN/);
  await assert.rejects(startControlServer({ requests, token, port: 0, host: "0.0.0.0" }), /loopback/);
  const control = await startControlServer({ requests, token, port: 0 });
  t.after(() => control.close());
  const post = (origin, path, body, headers = {}) => fetch(origin + path, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  const call_ = (...args) => post(control.origin, ...args);
  assert.equal((await call_("/eligibility", { recipient: caller }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await call_("/eligibility", { recipient: caller }, { origin: "https://evil.example" })).status, 403);
  assert.deepEqual(await (await call_("/eligibility", { recipient: caller })).json(), { eligible: true });
  assert.deepEqual(await (await call_("/eligibility", { recipient: other })).json(), { eligible: false });
  assert.deepEqual(await (await call_("/eligibility", { recipient: "+15555550109" })).json(), { eligible: false });
  assert.equal((await call_("/requests", { requestId: id(1), callId: call, recipient: caller })).status, 201);
  assert.ok(["sending", "sent"].includes((await (await call_(`/requests/${id(1)}/status`, { callId: call })).json()).status));
  assert.equal((await call_(`/requests/${id(1)}/status`, { callId: secondCall })).status, 404);
  assert.equal((await (await call_(`/requests/${id(1)}/cancel`, { callId: call })).json()).status, "cancelled");
  // Reachability that can't be checked is "unknown" (503), never a yes.
  const down = fixture({ reachable: async () => { throw new Error("rpc down"); } });
  const downControl = await startControlServer({ requests: down.requests, token, port: 0 });
  t.after(() => downControl.close());
  assert.equal((await post(downControl.origin, "/eligibility", { recipient: caller })).status, 503);
});
