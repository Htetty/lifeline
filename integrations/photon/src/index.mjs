import { configuration } from "./config.mjs";
import { createEchoHandler } from "./echo.mjs";

async function main() {
  const config = configuration();
  if (process.argv.includes("--check")) {
    console.log("Spectrum configuration is present. Credentials have not been verified with Photon.");
    return;
  }
  const { Spectrum } = await import("@spectrum-ts/core");
  const { imessage } = await import("@spectrum-ts/imessage");
  const app = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [imessage.config()],
    telemetry: false,
    options: { logLevel: "warn" },
  });
  const handle = createEchoHandler(config);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
  };
  const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.log("Spectrum initialized. Listening for enrolled iMessage senders; send hi to the assigned line.");
  try {
    for await (const [space, message] of app.messages) {
      if (stopping) break;
      try {
        if (await handle(imessage(space), message)) console.log("Photon accepted an echo reply; check receipt on the phone.");
      } catch {
        console.error("Echo reply failed. Check Photon line health; send a fresh message to retry.");
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stop();
  }
}

main().catch(error => {
  // SDK errors can contain request details. Never dump credentials or message bodies.
  console.error(error?.message?.startsWith("Set ") || error?.message?.startsWith("Use ")
    ? error.message
    : "Spectrum could not start or its stream ended with an error. Check credentials and line health in Photon.");
  process.exitCode = 1;
});
