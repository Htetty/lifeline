import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve4 } from "node:dns/promises";
import { get } from "node:https";

async function health(origin) {
  // A just-created name can be negatively cached by macOS's getaddrinfo even
  // after DNS is published. Resolve this one hostname directly for this probe;
  // preserve normal HTTPS hostname/certificate validation and system settings.
  const { hostname } = new URL(origin);
  const addresses = await resolve4(hostname);
  return new Promise((resolve, reject) => {
    const request = get(`${origin}/health`, {
      lookup: (_name, options, callback) => options?.all
        ? callback(null, addresses.map(address => ({ address, family: 4 })))
        : callback(null, addresses[0], 4),
      timeout: 3000,
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error("Unexpected health response")); });
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).ok === true); }
        catch { resolve(false); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("HTTPS health probe timed out")));
    request.on("error", reject);
  });
}

export async function startQuickTunnel(localOrigin) {
  const child = spawn("cloudflared", ["tunnel", "--config", "/dev/null", "--no-autoupdate", "--protocol", "http2", "--url", localOrigin],
    { stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Temporary HTTPS tunnel timed out")), 30_000);
      const clean = () => { clearTimeout(timer); child.stdout.off("data", onData); child.stderr.off("data", onData); };
      let output = "";
      const onData = chunk => {
        output = (output + chunk).slice(-16_384);
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
        if (match) { clean(); resolve(match[0]); }
      };
      child.once("error", () => { clean(); reject(new Error("Install cloudflared or set LOCATION_PUBLIC_URL to an existing HTTPS origin.")); });
      child.once("exit", () => { clean(); reject(new Error("Temporary HTTPS tunnel exited before startup")); });
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
    });
    // Keep pipe readers attached after URL discovery, without printing connector logs.
    child.stdout.resume(); child.stderr.resume();
    console.log(`Temporary HTTPS address created: ${origin}; checking reachability.`);
    let lastProbe = "no response";
    for (let i = 0; i < 60; i++) {
      if (exited) throw new Error("Temporary HTTPS tunnel exited");
      try {
        if (await health(origin)) return { origin, close: () => child.kill("SIGTERM") };
        lastProbe = "HTTP health not ready";
      } catch (error) { lastProbe = error.code ?? error.cause?.code ?? error.name; }
      await delay(1000);
    }
    throw new Error(`Temporary HTTPS address is not reachable yet (${lastProbe})`);
  } catch (error) { child.kill("SIGTERM"); throw error; }
}
