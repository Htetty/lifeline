import { test } from "node:test";
import assert from "node:assert/strict";
import { createEchoHandler } from "../src/echo.mjs";
import { configuration } from "../src/config.mjs";

const line = "+15555550100";
const caller = "+15555550101";
const config = { line, allowedSenders: new Set([caller]) };
const incoming = () => ({ id: "message-1", platform: "imessage", direction: "inbound",
  sender: { address: caller, service: "iMessage" }, content: { type: "text", text: "hi" } });
const chat = send => ({ id: `iMessage;-;${caller}`, type: "dm", phone: line, send });

test("only enrolled inbound iMessage DMs can send replies", async () => {
  const sends = [];
  const space = chat(async text => { sends.push(text); return { id: "reply" }; });
  for (const patch of [
    { direction: "outbound" }, { platform: "local_imessage" },
    { sender: { address: caller, service: "SMS" } },
    { sender: { address: "+15555550102", service: "iMessage" } },
    { sender: undefined }, { content: { type: "attachment" } },
  ]) assert.equal(await createEchoHandler(config)(space, { ...incoming(), ...patch }), false);
  for (const patch of [{ type: "group" }, { phone: "+15555550103" }, { id: `SMS;-;${caller}` }]) {
    assert.equal(await createEchoHandler(config)({ ...space, ...patch }, incoming()), false);
  }
  assert.deepEqual(sends, []);
  assert.equal(await createEchoHandler(config)(space, incoming()), true);
  assert.deepEqual(sends, ["echo: hi"]);
});

test("duplicate and simultaneous deliveries send one reply in a running process", async () => {
  let sends = 0;
  let finish;
  const accepted = new Promise(resolve => { finish = resolve; });
  const space = chat(async () => { sends++; await accepted; return { id: "reply" }; });
  const handle = createEchoHandler(config);
  const first = handle(space, incoming());
  const second = handle(space, incoming());
  finish();
  await Promise.all([first, second]);
  await handle(space, incoming());
  assert.equal(sends, 1);
});

test("failed sends remain retryable", async () => {
  let attempts = 0;
  const space = chat(async () => { if (++attempts === 1) throw new Error("offline"); return { id: "reply" }; });
  const handle = createEchoHandler(config);
  await assert.rejects(handle(space, incoming()));
  assert.equal(await handle(space, incoming()), true);
  assert.equal(attempts, 2);
});

test("a void send result is not counted as acceptance", async () => {
  const handle = createEchoHandler(config);
  await assert.rejects(handle(chat(async () => undefined), incoming()), /sent-message record/);
});

test("Beta credentials and missing configuration fail before connecting", () => {
  const env = { SPECTRUM_PROJECT_ID: "stable-project", SPECTRUM_PROJECT_SECRET: "fixture-secret",
    SPECTRUM_LINE_NUMBER: line, SPECTRUM_ALLOWED_SENDERS: caller };
  assert.equal(configuration(env).line, line);
  assert.throws(() => configuration({}), /Set SPECTRUM_PROJECT_ID/);
  assert.throws(() => configuration({ ...env, SPECTRUM_PROJECT_ID: "pho_prj_beta" }), /Stable Spectrum/);
  assert.throws(() => configuration({ ...env, SPECTRUM_PROJECT_SECRET: "pho_sk_beta" }), /Stable Spectrum/);
  assert.throws(() => configuration({ ...env, SPECTRUM_ALLOWED_SENDERS: "6505550101" }), /E.164/);
});
