import { configuration } from "./config.mjs";
import { createEchoHandler } from "./echo.mjs";
import { startLocationServer } from "./location-server.mjs";
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
  let locationServer, tunnel, app;
  try {
    if (locationMode) {
      const port = Number(process.env.LOCATION_PORT ?? 8091);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a location port between 1024 and 65535.");
      locationServer = await startLocationServer({ port });
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
    const handle = createEchoHandler({ ...config,
      onIgnored: reason => console.log(`Message ignored: ${reason}.`),
      ...(locationMode ? { reply: (space, message) => richlink(locationServer.issue({
        chat: space.id, sender: message.sender.address, messageId: message.id,
      })) } : {}),
    });
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
        const result = await space.send(richlink(locationServer.issue({ chat: space.id, sender })));
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
          if (await handle(native, message)) console.log(locationMode
            ? "Photon accepted a location preview; open the card on your phone."
            : "Photon accepted an echo reply; check receipt on the phone.");
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
    await locationServer?.close();
  }
}

main().catch(error => {
  // SDK errors can contain request details. Never dump credentials or message bodies.
  console.error(error?.message?.startsWith("Set ") || error?.message?.startsWith("Use ") ||
    error?.message?.startsWith("Temporary HTTPS") || error?.message?.startsWith("Install cloudflared")
    ? error.message
    : "Spectrum could not start or its stream ended with an error. Check credentials and line health in Photon.");
  process.exitCode = 1;
});
