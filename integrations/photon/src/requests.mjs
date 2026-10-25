import { inboundRejection } from "./echo.mjs";
import { setTimeout as delay } from "node:timers/promises";

const REQUEST_ID = /^[a-f0-9]{32}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const ACTIVE = new Set(["sending", "accepted", "sent", "delivered"]);

/** Location requests made by the voice backend for one call each.
 *
 * The backend names the call, the request ID and the caller's number (from the
 * signed Twilio webhook) once the caller has agreed on the call. The card goes out
 * straight away: the number must be enrolled and live-reachable by iMessage, then
 * its direct conversation is resolved and one rich link is sent. No incoming text
 * is needed, and an incoming text never creates a request or a card. Statuses are
 * the provider's (accepted = send returned a record; sent/delivered = the record
 * says so; unavailable = not reachable by iMessage, nothing sent). Everything is in
 * memory; a restart drops requests and their links.
 */
export function createLocationRequests({ line, allowedSenders, issueLink, sendCard, openConversation,
  reachable, lookup = async () => undefined, now = Date.now, ttlMs = 30 * 60_000,
  statusChecks = [2_000, 5_000, 10_000, 20_000, 40_000], log = value => console.log(JSON.stringify(value)) }) {
  const requests = new Map();
  const jobs = new Set();
  const shutdown = new AbortController();

  const background = task => {
    jobs.add(task);
    void task.catch(() => {}).finally(() => jobs.delete(task));
  };

  const report = (request, event, extra = {}) =>
    log({ event, callId: request.callId, requestId: request.id, status: request.status, ...extra });
  const view = request => ({
    requestId: request.id, callId: request.callId, status: request.status,
    ...(request.location ? { location: request.location } : {}),
  });
  const sweep = () => {
    for (const request of requests.values()) {
      if (!ACTIVE.has(request.status)) continue;
      if (now() >= request.expiresAt) { request.status = "expired"; report(request, "location.request.expired"); }
    }
    for (const [id, request] of requests) if (now() >= request.expiresAt + ttlMs) requests.delete(id);
  };
  const activeFor = (field, value) => [...requests.values()].find(r => r[field] === value && ACTIVE.has(r.status));

  const apply = (request, record) => {
    if (!ACTIVE.has(request.status)) return;
    // A card that left iMessage (SMS/RCS) is not what the caller agreed to receive.
    const status = record?.sendErrorCode || record?.transport ? "failed" : record?.isDelivered ? "delivered" : record?.isSent ? "sent" : null;
    if (!status || status === request.status || (status === "sent" && request.status === "delivered")) return;
    request.status = status;
    report(request, "location.request.status", status === "failed"
      ? { sendErrorCode: record.sendErrorCode, transport: record.transport } : {});
  };

  const fail = (request, status = "failed") => {
    if (request.status !== "sending") return; // cancelled or expired meanwhile
    request.status = status;
    report(request, `location.request.${status}`);
  };

  async function deliver(request) {
    let space;
    try {
      // Live iMessage reachability first; never fall back to SMS/RCS.
      if (!(await reachable(request.recipient))) return fail(request, "unavailable");
      space = await openConversation(request.recipient);
      if (space?.type !== "dm") throw new Error("not a direct conversation");
    } catch {
      return fail(request);
    }
    if (request.status !== "sending") return;
    await send(request, space);
  }

  async function send(request, space) {
    let record;
    try {
      record = await sendCard(space, issueLink({ requestId: request.id, callId: request.callId }));
      if (!record) throw new Error("no sent-message record");
    } catch {
      // Exactly one attempt per request; a new link needs a new request from the backend.
      return fail(request);
    }
    if (request.status !== "sending") return; // cancelled or expired while sending
    request.status = "accepted";
    report(request, "location.request.accepted");
    apply(request, record);
    request.messageId = record.id;
    background(trackStatus(request, space, record.id));
  }

  async function trackStatus(request, space, messageId) {
    for (const waitMs of statusChecks) {
      if (!["accepted", "sent"].includes(request.status)) break;
      try { await delay(waitMs, undefined, { ref: false, signal: shutdown.signal }); }
      catch { return; }
      sweep();
      if (!["accepted", "sent"].includes(request.status)) break;
      try { apply(request, await lookup(space, messageId)); } catch { /* status stays as last reported */ }
    }
  }

  return {
    create({ requestId, callId, recipient }) {
      sweep();
      if (!REQUEST_ID.test(requestId ?? "") || !CALL_ID.test(callId ?? "") || !PHONE.test(recipient ?? "")) {
        return { code: 400, body: { error: "invalid_request" } };
      }
      const existing = requests.get(requestId);
      if (existing) {
        return existing.callId === callId && existing.recipient === recipient
          ? { code: 200, body: view(existing) }
          : { code: 409, body: { error: "request_id_in_use" } };
      }
      if (!allowedSenders.has(recipient)) return { code: 422, body: { error: "recipient_not_eligible" } };
      if (activeFor("callId", callId)) return { code: 409, body: { error: "call_has_active_request" } };
      if (activeFor("recipient", recipient)) return { code: 409, body: { error: "recipient_has_active_request" } };
      if (requests.size >= 1000) return { code: 429, body: { error: "too_many_requests" } };
      const request = { id: requestId, callId, recipient, status: "sending", expiresAt: now() + ttlMs };
      requests.set(requestId, request);
      report(request, "location.request.sending");
      background(deliver(request));
      return { code: 201, body: view(request) };
    },
    get(requestId, callId) {
      sweep();
      const request = requests.get(requestId);
      return request && request.callId === callId ? { code: 200, body: view(request) } : { code: 404, body: { error: "not_found" } };
    },
    cancel(requestId, callId) {
      const request = requests.get(requestId);
      if (!request || request.callId !== callId) return { code: 404, body: { error: "not_found" } };
      if (ACTIVE.has(request.status)) { request.status = "cancelled"; report(request, "location.request.cancelled"); }
      return { code: 200, body: view(request) };
    },
    /** Enrolled and live-reachable by iMessage. Throws if reachability can't be checked. */
    eligible: async recipient => PHONE.test(recipient ?? "") && allowedSenders.has(recipient) && await reachable(recipient),
    /** Incoming texts are only classified for the log: they never create requests or cards. */
    inbound(space, message) {
      return inboundRejection(space, message, { line, allowedSenders }) ?? "not-a-location-request";
    },
    isActive: ({ requestId, callId } = {}) => {
      sweep();
      const request = requests.get(requestId);
      return Boolean(request && request.callId === callId && ACTIVE.has(request.status));
    },
    confirmed(record, { requestId, callId } = {}) {
      const request = requests.get(requestId);
      if (!request || request.callId !== callId || !ACTIVE.has(request.status)) return false;
      request.status = "confirmed";
      request.location = { latitude: record.latitude, longitude: record.longitude,
        accuracyMeters: record.accuracyMeters, capturedAt: record.capturedAt, confirmedAt: record.confirmedAt };
      report(request, "location.confirmed", request.location);
      return true;
    },
    async close() {
      shutdown.abort();
      for (const request of requests.values()) if (ACTIVE.has(request.status)) request.status = "cancelled";
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
  };
}
