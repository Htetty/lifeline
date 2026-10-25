import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryLookup } from "../src/delivery.mjs";

const space = { id: "any;-;+15555550101", phone: "shared" };
const record = { guid: "out", isFromMe: true, chatGuids: ["iMessage;-;+15555550101"], isSent: true };

test("delivery lookup reads fresh provider state and renews credentials without opening another channel", async t => {
  let now = 0, issued = 0, reads = 0, closed = false;
  const channels = [], usedTokens = [];
  const delivery = createDeliveryLookup({ projectId: "fixture", projectSecret: "fixture",
    now: () => now,
    issueTokens: async () => ({ type: "shared", token: `token-${++issued}`, expiresIn: 10 }),
    makeClient: options => {
      channels.push(options.address);
      return { messages: { get: async id => {
        assert.equal(id, "out");
        usedTokens.push(await options.token());
        return { ...record, isDelivered: ++reads > 1 };
      } }, close: () => { closed = true; } };
    } });
  t.after(() => delivery.close());
  assert.equal((await delivery.lookup(space, "out")).isDelivered, false);
  now = 8_001;
  assert.equal((await delivery.lookup(space, "out")).isDelivered, true);
  assert.equal(reads, 2);
  assert.deepEqual(usedTokens, ["token-1", "token-2"]);
  assert.deepEqual(channels, ["imessage.spectrum.photon.codes:443"]);
  await delivery.close();
  assert.equal(closed, true);
  await assert.rejects(delivery.lookup(space, "out"), /closed/);
});

test("dedicated delivery queries use only the matching line and reject foreign records", async t => {
  let returned = record;
  const channels = [];
  const delivery = createDeliveryLookup({ projectId: "fixture", projectSecret: "fixture",
    issueTokens: async () => ({ type: "dedicated", expiresIn: 60,
      numbers: { first: "+15555550100", other: "+15555550199" }, auth: { first: "first-token", other: "other-token" } }),
    makeClient: options => {
      channels.push(options.address);
      return { messages: { get: async () => returned }, close() {} };
    } });
  t.after(() => delivery.close());
  const dedicated = { ...space, phone: "+15555550100" };
  assert.equal((await delivery.lookup(dedicated, "out")).isSent, true);
  assert.deepEqual(channels, ["first.imsg.photon.codes:443"]);
  await assert.rejects(delivery.lookup(space, "out"), /matching line/);
  await assert.rejects(delivery.lookup({ ...space, phone: "+15555550198" }, "out"), /matching line/);
  for (const patch of [{ guid: "other" }, { isFromMe: false }, { chatGuids: ["any;-;+15555550102"] }]) {
    returned = { ...record, ...patch };
    await assert.rejects(delivery.lookup(dedicated, "out"), /does not match/);
  }
});

test("iMessage reachability is checked live on our own line, shared or dedicated", async t => {
  const asked = [];
  let available = true;
  const make = tokens => createDeliveryLookup({ projectId: "fixture", projectSecret: "fixture", line: "+15555550100",
    issueTokens: async () => tokens,
    makeClient: options => ({ addresses: { isIMessageAvailable: async address => { asked.push([options.address, address]); return available; } },
      messages: { get: async () => record }, close() {} }) });
  const shared = make({ type: "shared", token: "shared-token", expiresIn: 60 });
  const dedicated = make({ type: "dedicated", expiresIn: 60, numbers: { first: "+15555550100" }, auth: { first: "t" } });
  t.after(() => Promise.all([shared.close(), dedicated.close()]));
  assert.equal(await shared.reachable("+15555550101"), true);
  assert.equal(await dedicated.reachable("+15555550101"), true);
  available = "yes"; // anything but a literal true is not reachable
  assert.equal(await shared.reachable("+15555550101"), false);
  assert.deepEqual(asked.map(([address]) => address),
    ["imessage.spectrum.photon.codes:443", "first.imsg.photon.codes:443", "imessage.spectrum.photon.codes:443"]);
  const elsewhere = make({ type: "dedicated", expiresIn: 60, numbers: { other: "+15555550199" }, auth: { other: "t" } });
  await assert.rejects(elsewhere.reachable("+15555550101"), /matching line/);
});

test("a sent record in an SMS or RCS conversation is reported as leaving iMessage", async t => {
  let chats = ["any;-;+15555550101"];
  const delivery = createDeliveryLookup({ projectId: "fixture", projectSecret: "fixture",
    issueTokens: async () => ({ type: "shared", token: "t", expiresIn: 60 }),
    makeClient: () => ({ messages: { get: async () => ({ ...record, chatGuids: chats }) }, close() {} }) });
  t.after(() => delivery.close());
  assert.equal((await delivery.lookup(space, "out")).transport, undefined);
  for (const service of ["SMS", "RCS"]) {
    chats = [`${service};-;+15555550101`];
    assert.equal((await delivery.lookup(space, "out")).transport, service);
  }
});
