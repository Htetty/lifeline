import { cloud } from "@spectrum-ts/core";
import { createClient } from "@photon-ai/advanced-imessage/grpc";

const directRecipient = chat => /^(?:any|iMessage);-;(.+)$/.exec(chat ?? "")?.[1];
// The provider may report the outgoing message's conversation under any service.
const recordRecipient = chat => /^(?:any|iMessage|SMS|RCS);-;(.+)$/.exec(chat ?? "")?.[1];

/** Read iMessage reachability and delivery flags through the provider RPC, bypassing
 * Spectrum's message cache. Uses the same Stable project and phone routing as the
 * sending SDK. Tokens are renewed lazily; this client never sends messages or
 * subscribes to conversations.
 */
export function createDeliveryLookup({ projectId, projectSecret, line,
  issueTokens = cloud.issueImessageTokens, makeClient = createClient, now = Date.now }) {
  const clients = new Map();
  const shutdown = new AbortController();
  let tokens, refreshAt = 0, refreshing;

  async function credentials() {
    if (shutdown.signal.aborted) throw new Error("Delivery lookup is closed");
    if (tokens && now() < refreshAt) return tokens;
    if (!refreshing) {
      refreshing = (async () => {
        const fresh = await issueTokens(projectId, projectSecret,
          AbortSignal.any([shutdown.signal, AbortSignal.timeout(5_000)]));
        if (!Number.isFinite(fresh.expiresIn) || fresh.expiresIn <= 0) throw new Error("Invalid token lifetime");
        tokens = fresh;
        refreshAt = now() + fresh.expiresIn * 800;
        return fresh;
      })().finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  function route(data, phone) {
    if (data.type === "shared" && phone === "shared" && data.token) {
      return { address: "imessage.spectrum.photon.codes:443", token: data.token };
    }
    if (data.type === "dedicated") {
      const entry = Object.entries(data.numbers).find(([, number]) => number === phone);
      if (entry && data.auth[entry[0]]) return {
        address: `${entry[0]}.imsg.photon.codes:443`, token: data.auth[entry[0]],
      };
    }
    throw new Error("Delivery lookup has no matching line");
  }

  async function clientFor(phone) {
    const target = route(await credentials(), phone);
    if (shutdown.signal.aborted) throw new Error("Delivery lookup is closed");
    let client = clients.get(target.address);
    if (!client) {
      client = makeClient({ address: target.address, tls: true, retry: false, timeout: 5_000,
        token: async () => {
          const fresh = route(await credentials(), phone);
          if (fresh.address !== target.address) throw new Error("Delivery lookup line changed");
          return fresh.token;
        } });
      clients.set(target.address, client);
    }
    return client;
  }

  return {
    /** Live iMessage reachability of an address from our line. An `any;-;` chat ID
     * proves nothing about transport, so cards are sent only after this is true. */
    async reachable(address) {
      const data = await credentials();
      const client = await clientFor(data.type === "shared" ? "shared" : line);
      return (await client.addresses.isIMessageAvailable(address)) === true;
    },
    async lookup(space, messageId) {
      const recipient = directRecipient(space.id);
      if (!recipient || !messageId) throw new Error("Delivery lookup needs a direct conversation and message ID");
      const client = await clientFor(space.phone);
      const record = await client.messages.get(messageId);
      if (record.guid !== messageId || !record.isFromMe ||
          !record.chatGuids?.some(chat => recordRecipient(chat) === recipient)) {
        throw new Error("Delivery record does not match the outgoing conversation");
      }
      // A conversation the provider names as SMS/RCS means the card left iMessage.
      const fallback = record.chatGuids.find(chat => /^(?:SMS|RCS);-;/.test(chat));
      return { id: messageId, isSent: record.isSent, isDelivered: record.isDelivered,
        sendErrorCode: record.sendErrorCode, ...(fallback ? { transport: fallback.split(";")[0] } : {}) };
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled([...clients.values()].map(client => client.close()));
      clients.clear();
    },
  };
}
