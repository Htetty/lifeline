import { test } from "node:test";
import assert from "node:assert/strict";
import { startLocationServer } from "../src/location-server.mjs";
import { createEchoHandler } from "../src/echo.mjs";

async function fixture(t, options = {}) {
  const records = [];
  const service = await startLocationServer({ port: 0, onConfirmed: record => records.push(record), ...options });
  t.after(() => service.close());
  const link = service.issue();
  const token = link.split("/").pop();
  const fix = () => ({ latitude: 37.4275, longitude: -122.1697, accuracy: 12, capturedAt: Date.now() });
  const post = (data, origin = service.localOrigin) => fetch(`${service.localOrigin}/api/location/${token}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(data),
  });
  return { service, records, link, token, fix, post };
}

test("preview and HEAD reads never confirm or consume the request", async t => {
  const { link, records, post, fix } = await fixture(t);
  for (const method of ["GET", "HEAD", "GET"]) {
    const response = await fetch(link, { method, headers: { "user-agent": "Applebot" } });
    assert.equal(response.status, 200);
    if (method === "GET") assert.match(await response.text(), /og:image/);
  }
  assert.deepEqual(records, []);
  assert.equal((await post(fix())).status, 200);
  assert.equal(records.length, 1);
});

test("confirm prints the reported location once; exact HTTP retries are idempotent", async t => {
  const { records, post, fix } = await fixture(t);
  const value = fix();
  assert.deepEqual(await (await post(value)).json(), { confirmed: true });
  assert.deepEqual(await (await post(value)).json(), { confirmed: true });
  assert.equal(records.length, 1);
  assert.equal(records[0].latitude, value.latitude);
  assert.equal(records[0].accuracyMeters, 12);
  assert.equal((await post({ ...value, latitude: 38 })).status, 409);
  assert.equal(records.length, 1);
});

test("expired, invalid, stale and cross-origin submissions do not print coordinates", async t => {
  const { records, post, fix, service } = await fixture(t);
  for (const patch of [{ latitude: 91 }, { longitude: -181 }, { accuracy: -1 }, { latitude: "37" },
    { capturedAt: Date.now() - 180000 }, { capturedAt: Date.now() + 60000 }]) {
    assert.equal((await post({ ...fix(), ...patch })).status, 400);
  }
  assert.equal((await post(fix(), "https://unrelated.example")).status, 403);
  const missing = await fetch(`${service.localOrigin}/api/location/${"a".repeat(43)}`, {
    method: "POST", headers: { "content-type": "application/json", origin: service.localOrigin }, body: JSON.stringify(fix()),
  });
  assert.equal(missing.status, 410);
  assert.deepEqual(records, []);
  let now = Date.now();
  const expired = await fixture(t, { now: () => now, ttlMs: 100 });
  now += 101;
  assert.equal((await fetch(expired.link)).status, 410);
  assert.equal((await expired.post(fix())).status, 410);
  assert.deepEqual(expired.records, []);
});

test("only fixed static assets are served; metadata uses the configured public origin", async t => {
  const { service, link } = await fixture(t);
  service.setPublicOrigin("https://location.example");
  const html = await (await fetch(link)).text();
  assert.match(html, /https:\/\/location.example\/preview.png/);
  assert.equal((await fetch(`${service.localOrigin}/preview.png`)).headers.get("content-type"), "image/png; charset=utf-8");
  assert.equal((await fetch(`${service.localOrigin}/.env`)).status, 404);
  assert.throws(() => service.setPublicOrigin("http://example.com"));
});

test("location handler sends exactly one card with no accompanying text", async () => {
  const sent = [];
  const handler = createEchoHandler({ line: "+15555550100", allowedSenders: new Set(["+15555550101"]),
    reply: () => ({ type: "richlink", url: "https://location.example/l/token" }) });
  const space = { type: "dm", id: "any;-;+15555550101", phone: "shared",
    send: async content => { sent.push(content); return { id: "card" }; } };
  await handler(space, { platform: "imessage", direction: "inbound", id: "incoming",
    sender: { service: "iMessage", address: "+15555550101" }, content: { type: "text", text: "hi" } });
  assert.deepEqual(sent, [{ type: "richlink", url: "https://location.example/l/token" }]);
});
