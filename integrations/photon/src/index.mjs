import { configuration } from "./config.mjs";
import { createEchoHandler } from "./echo.mjs";
import { startLocationServer } from "./location-server.mjs";
import { startControlServer } from "./control-server.mjs";
import { createLocationRequests } from "./requests.mjs";
import { createDeliveryLookup } from "./delivery.mjs";
import { startQuickTunnel } from "./tunnel.mjs";

async function main() {
  const config = configuration();
  if (process.argv.includes("--check")) {
    console.log("Spectrum configuration is present. Credentials have not been verified with Photon.");
    return;
  }
  const { Spectrum, richlink } = await import("@spectrum-ts/core");
  const { imessage } = await import("@spectrum-ts/imessage");
  const liveStreams = new Set();
  const locationMode = process.argv.includes("--location");
  let locationServer, tunnel, app, requests, control, delivery;
  try {
    if (locationMode) {
      const port = Number(process.env.LOCATION_PORT ?? 8091);
      const controlPort = Number(process.env.PHOTON_CONTROL_PORT ?? 8092);
      if (![port, controlPort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || port === controlPort) {
        throw new Error("Use two different ports between 1024 and 65535 for LOCATION_PORT and PHOTON_CONTROL_PORT.");
      }
      // Cards go only to requests the voice backend made for a specific call.
      delivery = createDeliveryLookup(config);
      requests = createLocationRequests({ ...config,
        issueLink: context => locationServer.issue(context),
        // Documented direct-conversation path: resolve the user by number, create the DM.
        // Needs no earlier incoming message, so a restart doesn't make anyone text first.
        openConversation: async recipient => {
          const platform = imessage(app);
          return platform.space.create(await platform.user(recipient));
        },
        reachable: delivery.reachable,
        sendCard: (space, url) => space.send(richlink(url)),
        lookup: delivery.lookup });
      locationServer = await startLocationServer({ port,
        // Manual --send-location links belong to no call; call links follow their request.
        isActive: context => context.manual === true || requests.isActive(context),
        onConfirmed: (record, context) => {
          if (context.manual) console.log(JSON.stringify(record));
          else requests.confirmed(record, context);
        } });
      control = await startControlServer({ requests, token: process.env.PHOTON_BRIDGE_TOKEN, port: controlPort });
      console.log(`Voice backend control API listening on ${control.origin}.`);
      let origin = process.env.LOCATION_PUBLIC_URL?.trim();
      if (!origin) { tunnel = await startQuickTunnel(locationServer.localOrigin); origin = tunnel.origin; }
      locationServer.setPublicOrigin(origin);
      console.log(`Location page ready at ${origin}. Confirmed coordinates will print here.`);
    }
    app = await Spectrum({
      projectId: config.projectId,
      projectSecret: config.projectSecret,
      providers: [imessage.config({
        onHeartbeat(heartbeat) {
          if (liveStreams.has(heartbeat.stream)) return;
          liveStreams.add(heartbeat.stream);
          console.log(`Photon ${heartbeat.stream} stream heartbeat received.`);
        },
      })],
      telemetry: false,
      options: { logLevel: "warn" },
    });
    const handle = locationMode
      ? async (space, message) => {
        console.log(`Message ignored: ${requests.inbound(space, message)}.`);
        return false; // cards are sent only for the voice backend's requests
      }
      : createEchoHandler({ ...config, onIgnored: reason => console.log(`Message ignored: ${reason}.`) });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
    };
    const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    console.log("Spectrum initialized. Opening message streams for enrolled iMessage senders.");
    try {
      if (process.argv.includes("--send-location")) {
        if (!locationMode || config.allowedSenders.size !== 1) throw new Error("Use --send-location with --location and exactly one allowed sender.");
        const sender = [...config.allowedSenders][0];
        const space = await imessage(app).space.get(`any;-;${sender}`);
        const result = await space.send(richlink(locationServer.issue({ manual: true })));
        if (!result) throw new Error("Location preview did not return a sent-message record");
        console.log("Photon accepted the location preview. Open the card on your phone.");
      }
      for await (const [space, message] of app.messages) {
        if (stopping) break;
        const native = imessage(space);
        console.log(JSON.stringify({ event: "message.received", direction: message.direction,
          content: message.content?.type, spaceType: native.type,
          chatService: ["iMessage", "any", "SMS", "RCS"].includes(native.id?.split(";")[0]) ? native.id.split(";")[0] : "other",
          sharedLine: native.phone === "shared", senderService: message.sender?.service ?? "absent",
          senderAllowed: config.allowedSenders.has(message.sender?.address) }));
        try {
          if (await handle(native, message)) console.log("Photon accepted an echo reply; check receipt on the phone.");
        } catch {
          console.error("Reply failed. Check Photon line health; send a fresh message to retry.");
        }
      }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      await stop();
    }
  } finally {
    tunnel?.close();
    await control?.close();
    await requests?.close();
    await delivery?.close();
    await locationServer?.close();
  }
}

main().catch(error => {
  // SDK errors can contain request details. Never dump credentials or message bodies.
  console.error(error?.message?.startsWith("Set ") || error?.message?.startsWith("Use ") ||
    error?.message?.startsWith("Temporary HTTPS") || error?.message?.startsWith("Set PHOTON_BRIDGE_TOKEN") || error?.message?.startsWith("Install cloudflared")
    ? error.message
    : "Spectrum could not start or its stream ended with an error. Check credentials and line health in Photon.");
  process.exitCode = 1;
});
