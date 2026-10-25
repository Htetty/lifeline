/** Why an incoming message is not an enrolled sender's direct iMessage text, or null.
 * Shared by the echo probe and location requests; neither accepts SMS/RCS or groups.
 */
export function inboundRejection(space, message, { line, allowedSenders }) {
  if (message.platform !== "imessage" || message.direction !== "inbound") return "not-inbound-imessage";
  // Stable Free/Pro authenticates the project to a shared proxy. Its documented
  // SDK representation uses phone="shared", not the recipient's assigned line.
  // Project authentication + enrolled sender + direct iMessage chat bind that
  // route. Dedicated lines must still match the configured phone exactly.
  // Native service-specific GUIDs and the SDK's service-neutral `any` GUIDs
  // both identify DMs. The sender's service below determines iMessage vs SMS.
  if (space.type !== "dm" || !/^(?:iMessage|any);-;.+$/.test(space.id ?? "")) return "not-direct-imessage";
  if (space.phone !== "shared" && space.phone !== line) return "different-line";
  if (message.sender?.service !== "iMessage") return "not-imessage-service";
  if (!allowedSenders.has(message.sender?.address)) return "sender-not-allowed";
  if (!message.id || message.content?.type !== "text" || !message.content.text?.trim()) return "not-text";
  return null;
}

/** First increment: prove one enrolled person's iMessage can receive a reply.
 * No outbound initiation, SMS/RCS fallback, attachment fetching or incident writes.
 */
export function createEchoHandler({ line, allowedSenders, onIgnored = () => {},
  reply = (_space, message) => `echo: ${message.content.text.trim().slice(0, 500)}` }) {
  const completed = new Set();
  const inFlight = new Map();

  return async function handle(space, message) {
    const rejection = inboundRejection(space, message, { line, allowedSenders });
    if (rejection) { onIgnored(rejection); return false; }
    const key = JSON.stringify([space.phone, space.id, message.sender.address, message.id]);
    if (completed.has(key)) return false;
    if (inFlight.has(key)) return inFlight.get(key);
    const sending = (async () => {
      // The provider may echo outgoing traffic back on its stream; direction above
      // prevents a reply loop. Mark only sends that the provider actually accepted.
      const result = await space.send(await reply(space, message));
      if (!result) throw new Error("Provider did not return a sent-message record");
      completed.add(key);
      // This is a bounded connection probe, not a durable ingestion receipt store.
      if (completed.size > 1000) completed.delete(completed.values().next().value);
      return true;
    })();
    inFlight.set(key, sending);
    try {
      return await sending;
    } finally {
      inFlight.delete(key);
    }
  };
}
