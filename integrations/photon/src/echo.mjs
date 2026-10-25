/** First increment: prove one enrolled person's iMessage can receive a reply.
 * No outbound initiation, SMS/RCS fallback, attachment fetching or incident writes.
 */
export function createEchoHandler({ line, allowedSenders }) {
  const completed = new Set();
  const inFlight = new Map();

  return async function handle(space, message) {
    if (message.platform !== "imessage" || message.direction !== "inbound") return false;
    if (space.type !== "dm" || space.phone !== line || !space.id?.startsWith("iMessage;-;")) return false;
    if (message.sender?.service !== "iMessage" || !allowedSenders.has(message.sender?.address)) return false;
    if (!message.id || message.content?.type !== "text" || !message.content.text?.trim()) return false;
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
