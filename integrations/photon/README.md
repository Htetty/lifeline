# Photon iMessage and location test

Stable Spectrum at <https://app.photon.codes>, using `@spectrum-ts/core` and
`@spectrum-ts/imessage` 12.14.0. This is separate from the Beta SMS project at
`app.beta.photon.codes`. The deprecated `@photon-ai/advanced-imessage-kit` is not used.

`npm start` replies `echo: hi` when an enrolled, explicitly allowed sender texts
`hi` to the assigned line over iMessage. It does not initiate messages, use carrier
SMS/RCS, process attachments, or write incidents. Twilio/Cartesia routing is untouched.

## Run

From this directory, with Node.js 22.9 or newer:

```sh
npm ci
cp .env.example .env
# Fill .env privately using the Stable project's Settings and Users pages.
npm run check
npm start
```

The launcher also reads this checkout's `backend/.env`, if present. This directory's
`.env` overrides file values; exported environment variables override both files.
Do not copy a shared Convex environment into this integration just to run the echo.

- `SPECTRUM_PROJECT_ID`: Stable project ID from Settings.
- `SPECTRUM_PROJECT_SECRET`: that project's secret, not a Beta API key.
- `SPECTRUM_LINE_NUMBER`: the Users page's **Texts on** number, in E.164 format.
- `SPECTRUM_ALLOWED_SENDERS`: enrolled **Own number** values, comma separated.

Keep the process running, then send `hi` **from an enrolled phone** to its assigned
**Texts on** line. Confirm the message is iMessage (blue), then check for `echo: hi`.
An SDK send acknowledgement is acceptance, not evidence the phone received it.
No webhook or public URL is required for this streaming connection probe.

`npm run check` validates configuration locally without contacting Photon.
`npm test` uses fixture messages; it never connects to a provider or sends real texts.
Successful message IDs are deduplicated in memory (last 1000 per process); a restart
can reply again to replayed traffic. This remains a terminal-only test; durable
intake/outbox receipts are required before incident creation or dispatcher updates.

Free/Pro shared proxy events use the SDK's `phone="shared"` sentinel. Dedicated
events must match the configured line. Both require an allowed sender and an
inbound direct iMessage conversation. Shared direct chat IDs use `any;-;...`;
the sender's `service` determines whether the message is iMessage or SMS. Do not
infer transport solely from the chat ID prefix. Logs include stream heartbeats and rejection
reason codes, without message text, sender addresses, or credentials.

Live verification (2026-10-25): recovered the enrolled user's received `hi` from
the shared proxy's chat history, processed it with the same echo handler, and
queried the resulting reply through the provider. It transitioned from
`isSent=true, isDelivered=false` to `isSent=true, isDelivered=true`, with
`sendErrorCode=0`. Provider delivery is distinct from the user confirming receipt.

Dependency check: the pinned SDK currently brings a moderate OpenTelemetry baggage
allocation advisory through `@photon-ai/otel` (`@opentelemetry/core <2.8.0`). Telemetry
is disabled here. Do not force npm's proposed SDK downgrade; recheck the upstream
dependency before enabling telemetry or adding an HTTP ingress.

## Location preview → blue dot → terminal

Install `cloudflared` for an automatic temporary HTTPS address, or set
`LOCATION_PUBLIC_URL` to an HTTPS origin you already route to this service.

```sh
npm run location
# Or explicitly send one preview immediately to the one allowed/enrolled sender:
npm run location -- --send-location
```

The separate location server listens on `127.0.0.1:8091` (`LOCATION_PORT` overrides
the port). The Quick Tunnel exposes only that server; it cannot reach the existing
FastAPI app or the dashboard through this process. No Cloudflare account is needed.
Stop the process to close the tunnel and server.

Each received text gets **one `richlink` message**, without accompanying text.
The card's metadata and map artwork preview the location page. Native preview
rendering depends on the receiving Messages client. Opening it requests location
permission and shows the current position with a blue dot and accuracy circle.
The only primary action is **Confirm location**; an arrow recenters/retries GPS.

The server prints `location.confirmed` with latitude, longitude, accuracy in metres,
capture/confirmation times, a request ID, and an Apple Maps link. It does not write
to Convex or the dispatcher dashboard. The location is the device's reported fix,
not a server-verified position. Coordinates are not sent to this server until the
user explicitly confirms. OpenStreetMap serves the map tiles.

Requests have random 256-bit bearer links, expire after 30 minutes, and are held
only in memory. A restart invalidates them. Preview/HEAD requests never consume a
link. Repeating the same confirmation is idempotent; a different location cannot
overwrite it. Stale/nonfinite/out-of-range fixes and cross-origin POSTs are rejected.
The browser stops location watching on confirmation or page exit.

`npm run test:ui` launches an isolated headless Chrome profile (or `CHROME_BIN`),
uses a fictional location fix, checks map tiles and the blue dot in a 390×844
viewport, confirms exactly once, and checks denied-permission handling. It never
sends an iMessage. Screenshots go to `/tmp/lifeline-location-{ready,confirmed}.png`.

Native `app(url)` cards can be added separately; the current docs describe a
Spectrum extension installation on first use. This increment uses ordinary rich
links so it does not depend on that extension.

## Provider references

- <https://photon.codes/docs/spectrum-ts/getting-started>
- <https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing>
- <https://photon.codes/docs/spectrum-ts/content/rich-links>
- <https://photon.codes/docs/spectrum-ts/content/app>
