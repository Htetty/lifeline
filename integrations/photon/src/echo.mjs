/** First increment: prove one enrolled person's iMessage can receive a reply.
 * No outbound initiation, SMS/RCS fallback, attachment fetching or incident writes.
 */
export function createEchoHandler({ line, allowedSenders, onIgnored = () => {} }) {
  const completed = new Set();
  const inFlight = new Map();

  return async function handle(space, message) {
    const ignore = reason => { onIgnored(reason); return false; };
    if (message.platform !== "imessage" || message.direction !== "inbound") return ignore("not-inbound-imessage");
    // Stable Free/Pro authenticates the project to a shared proxy. Its documented
    // SDK representation uses phone="shared", not the recipient's assigned line.
    // Project authentication + enrolled sender + direct iMessage chat bind that
    // route. Dedicated lines must still match the configured phone exactly.
    // Native service-specific GUIDs and the SDK's service-neutral `any` GUIDs
    // both identify DMs. The sender's service below determines iMessage vs SMS.
    if (space.type !== "dm" || !/^(?:iMessage|any);-;.+$/.test(space.id ?? "")) return ignore("not-direct-imessage");
    if (space.phone !== "shared" && space.phone !== line) return ignore("different-line");
    if (message.sender?.service !== "iMessage") return ignore("not-imessage-service");
    if (!allowedSenders.has(message.sender?.address)) return ignore("sender-not-allowed");
    if (!message.id || message.content?.type !== "text" || !message.content.text?.trim()) return ignore("not-text");
    const key = JSON.stringify([space.phone, space.id, message.sender.address, message.id]);
    if (completed.has(key)) return false;
    if (inFlight.has(key)) return inFlight.get(key);
    const sending = (async () => {
      // The provider may echo outgoing traffic back on its stream; direction above
      // prevents a reply loop. Mark only sends that the provider actually accepted.
      const result = await space.send(`echo: ${message.content.text.trim().slice(0, 500)}`);
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
