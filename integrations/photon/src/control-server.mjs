import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest();

/** Loopback-only API for the voice backend, authenticated with PHOTON_BRIDGE_TOKEN.
 * Never routed through the public location tunnel (a separate listener and port).
 *
 *   POST /eligibility           {recipient}                     -> {eligible} (enrolled + iMessage-reachable)
 *   POST /requests              {requestId, callId, recipient}  -> request
 *   POST /requests/:id/status   {callId}                        -> request
 *   POST /requests/:id/cancel   {callId}                        -> request
 */
export async function startControlServer({ requests, token, port = 8092, host = "127.0.0.1" }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("Set PHOTON_BRIDGE_TOKEN (32+ random characters) in backend/.env.");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Use a loopback address for the Photon control API.");
  const expected = digest(`Bearer ${token}`);
  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      // Browsers attach Origin; the backend never does. Refuse before reading anything.
      if (req.headers.origin !== undefined) return send(res, 403, { error: "forbidden" });
      if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) return send(res, 401, { error: "unauthorized" });
      if (req.method !== "POST" || req.headers["content-type"]?.split(";")[0] !== "application/json") return send(res, 404, { error: "not_found" });
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 4096) return send(res, 413, { error: "too_large" });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString()) ?? {}; }
      catch { return send(res, 400, { error: "invalid_json" }); }
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/eligibility") {
        try { return send(res, 200, { eligible: await requests.eligible(input.recipient) }); }
        catch { return send(res, 503, { error: "reachability_unknown" }); } // the backend asks again later
      }
      if (path === "/requests") {
        const { code, body } = requests.create(input);
        return send(res, code, body);
      }
      const match = path.match(/^\/requests\/([a-f0-9]{32})\/(status|cancel)$/);
      if (!match) return send(res, 404, { error: "not_found" });
      const { code, body } = match[2] === "status" ? requests.get(match[1], input.callId) : requests.cancel(match[1], input.callId);
      return send(res, code, body);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return {
    origin: `http://${host}:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
