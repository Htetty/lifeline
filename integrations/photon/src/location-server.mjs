import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const publicDir = new URL("../public/", import.meta.url);
const mapDir = new URL("../node_modules/maplibre-gl/dist/", import.meta.url);
const assets = new Map([
  ["/location.js", [new URL("location.js", publicDir), "text/javascript"]],
  ["/location.css", [new URL("location.css", publicDir), "text/css"]],
  ["/preview.png", [new URL("preview.png", publicDir), "image/png"]],
  ["/maplibre-gl.mjs", [new URL("maplibre-gl.mjs", mapDir), "text/javascript"]],
  ["/maplibre-gl-worker.mjs", [new URL("maplibre-gl-worker.mjs", mapDir), "text/javascript"]],
  ["/maplibre-gl.css", [new URL("maplibre-gl.css", mapDir), "text/css"]],
]);
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self' https://tile.openstreetmap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Ephemeral, terminal-only location links. No dashboard or database writes.
 * `isActive(context)` lets the issuer withdraw a link (call ended, link resent);
 * `onConfirmed(record, context)` receives the context the link was issued with.
 */
export async function startLocationServer({ port = 8091, host = "127.0.0.1", publicOrigin,
  ttlMs = 30 * 60_000, now = Date.now, isActive = () => true,
  onConfirmed = value => console.log(JSON.stringify(value)) } = {}) {
  const sessions = new Map();
  let origin = publicOrigin;
  let localOrigin;
  const html = await readFile(new URL("location.html", publicDir), "utf8");
  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store",
      "content-security-policy": csp, "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=(self)", "x-content-type-options": "nosniff" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const getSession = token => {
    const session = sessions.get(token);
    return session && session.expiresAt > now() ? session : undefined;
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") return send(res, 200, { ok: true });
      if (assets.has(path) && ["GET", "HEAD"].includes(req.method)) {
        const [file, type] = assets.get(path);
        return send(res, 200, req.method === "HEAD" ? "" : await readFile(file), type);
      }
      const match = path.match(/^\/l\/([A-Za-z0-9_-]{43})$/);
      if (match && ["GET", "HEAD"].includes(req.method)) {
        const session = getSession(match[1]);
        if (!session) return send(res, 410, "This location link has expired. Ask for a new one.", "text/plain");
        if (!session.confirmed && !isActive(session.context)) return send(res, 410, "This location link is no longer active.", "text/plain");
        const base = origin ?? localOrigin;
        const page = html.replaceAll("__PUBLIC_ORIGIN__", escape(base));
        return send(res, 200, req.method === "HEAD" ? "" : page, "text/html");
      }
      const api = path.match(/^\/api\/location\/([A-Za-z0-9_-]{43})$/);
      if (!api || req.method !== "POST") return send(res, 404, { error: "Not found" });
      const session = getSession(api[1]);
      if (!session) return send(res, 410, { error: "This location link has expired. Ask for a new one." });
      if (![origin, localOrigin].filter(Boolean).includes(req.headers.origin)) return send(res, 403, { error: "Open this link in your browser to confirm." });
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") return send(res, 415, { error: "Expected JSON" });
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 4096) return send(res, 413, { error: "Request too large" });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return send(res, 400, { error: "Invalid JSON" }); }
      const { latitude, longitude, accuracy, capturedAt } = input ?? {};
      const values = [latitude, longitude, accuracy, capturedAt];
      if (!values.every(value => typeof value === "number" && Number.isFinite(value)) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 20_000_000) {
        return send(res, 400, { error: "A valid device location is required." });
      }
      const fingerprint = JSON.stringify(values);
      if (session.confirmed) {
        return fingerprint === session.fingerprint
          ? send(res, 200, { confirmed: true })
          : send(res, 409, { error: "This link already has a confirmed location." });
      }
      if (!isActive(session.context)) return send(res, 410, { error: "This location link is no longer active." });
      if (capturedAt < now() - 120_000 || capturedAt > now() + 30_000) return send(res, 400, { error: "Location is stale. Find your location again." });
      const record = { event: "location.confirmed", requestId: session.id,
        latitude, longitude, accuracyMeters: accuracy, capturedAt: new Date(capturedAt).toISOString(),
        confirmedAt: new Date(now()).toISOString(),
        appleMapsUrl: `https://maps.apple.com/?ll=${latitude},${longitude}` };
      // No network write: a confirmation is only recorded in this running process
      // and emitted to its terminal. Store before responding so HTTP retries are safe.
      session.confirmed = record;
      session.fingerprint = fingerprint;
      onConfirmed(record, session.context);
      return send(res, 200, { confirmed: true });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "Could not confirm. Please try again." });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  localOrigin = `http://${host}:${server.address().port}`;
  return {
    localOrigin,
    setPublicOrigin(value) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an HTTPS origin for location links.");
      origin = url.origin;
    },
    issue(context = {}) {
      for (const [token, session] of sessions) if (session.expiresAt <= now()) sessions.delete(token);
      if (sessions.size >= 1000) throw new Error("Too many active location links");
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { id: randomUUID(), expiresAt: now() + ttlMs, context });
      return `${origin ?? localOrigin}/l/${token}`;
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
