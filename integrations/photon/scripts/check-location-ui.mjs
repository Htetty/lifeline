// Isolated mobile Chromium check. Never attaches to a signed-in browser profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startLocationServer } from "../src/location-server.mjs";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(join(tmpdir(), "lifeline-location-browser-"));
const records = [];
const server = await startLocationServer({ port: 0, onConfirmed: record => records.push(record) });
let browser, socket;
try {
  browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await delay(100); }
  }
  assert.ok(port, "Chromium did not start");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0, tileResponses = 0;
  const pending = new Map(), exceptions = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (message.method === "Network.responseReceived" && message.params.response.url.startsWith("https://tile.openstreetmap.org/") && message.params.response.status === 200) tileResponses++;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(150); }
    throw new Error(`UI condition did not become true: ${expression}`);
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await send("Browser.grantPermissions", { origin: server.localOrigin, permissions: ["geolocation"] });
  await send("Emulation.setGeolocationOverride", { latitude: 37.4275, longitude: -122.1697, accuracy: 12 });
  await send("Page.navigate", { url: server.issue() });
  await until("document.querySelector('.user-dot') && document.querySelector('#confirm')?.disabled === false");
  assert.equal(records.length, 0, "Opening the page must not submit a location");
  await until("document.body.dataset.mapReady === 'true'");
  for (let i = 0; i < 80 && tileResponses < 2; i++) await delay(150);
  assert.ok(tileResponses >= 2, "Actual map tiles must load");
  assert.deepEqual(exceptions, [], "No browser script exceptions");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile("/tmp/lifeline-location-ready.png", Buffer.from(screenshot.data, "base64"));
  await evaluate("document.querySelector('#confirm').click()");
  await until("document.querySelector('#title')?.textContent === 'Location confirmed'");
  assert.equal(records.length, 1);
  assert.equal(records[0].latitude, 37.4275);
  const confirmed = await send("Page.captureScreenshot", { format: "png" });
  await writeFile("/tmp/lifeline-location-confirmed.png", Buffer.from(confirmed.data, "base64"));
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "denied", origin: server.localOrigin });
  await send("Page.navigate", { url: server.issue() });
  await until("document.querySelector('#status')?.textContent.includes('Allow location access')");
  assert.equal(await evaluate("document.querySelector('#confirm').disabled"), true);
  assert.equal(records.length, 1);
  console.log(JSON.stringify({ mobileViewport: "390×844", blueDot: true, mapTilesLoaded: tileResponses,
    confirmationLoggedOnce: true, deniedPermissionHandled: true, browserExceptions: exceptions.length,
    screenshots: ["/tmp/lifeline-location-ready.png", "/tmp/lifeline-location-confirmed.png"] }));
  await send("Browser.close");
} finally {
  socket?.close(); browser?.kill("SIGTERM");
  await server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
