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

## Location preview → blue dot → incident location

Install `cloudflared` for an automatic temporary HTTPS address, or set
`LOCATION_PUBLIC_URL` to an HTTPS origin you already route to this service.

```sh
npm run location
# Or, for a manual test outside any call, send one preview immediately to the one allowed/enrolled sender:
npm run location -- --send-location
```

The separate location server listens on `127.0.0.1:8091` (`LOCATION_PORT` overrides
the port). The Quick Tunnel exposes only that server; it cannot reach the existing
FastAPI app or the dashboard through this process. No Cloudflare account is needed.
Stop the process to close the tunnel and server.

Cards are sent only for location requests made by the voice backend for a live phone
call (see **Voice call requests** below). An unsolicited text gets no card and no reply.
Each request sends **one `richlink` message**, without accompanying text.
The card's metadata and map artwork preview the location page. Native preview
rendering depends on the receiving Messages client. Opening it requests location
permission and shows the current position with a blue dot and accuracy circle.
The dark page asks **Is this your current location?**, centered above **Confirm**.
The button turns green and says **Confirmed** after a successful confirmation;
an arrow recenters/retries GPS.

The server prints `location.confirmed` with latitude, longitude, accuracy in metres,
capture/confirmation times, and the call and request IDs (manual `--send-location` links
print a request ID and an Apple Maps link instead). The Photon process does not write
to Convex itself: for call-bound requests the voice backend saves the confirmed fix as
the existing incident's map candidate, replacing address lookup. The backend and dashboard
must use the same Convex deployment. Manual links remain terminal-only. The location is the device's reported fix,
not a server-verified position. Coordinates are not sent to this server until the
user explicitly confirms. OpenStreetMap serves the map tiles.

Requests have random 256-bit bearer links, expire after 30 minutes, and are held
only in memory. A restart invalidates them. Preview/HEAD requests never consume a
link. Repeating the same confirmation is idempotent; a different location cannot
overwrite it. Stale/nonfinite/out-of-range fixes and cross-origin POSTs are rejected.
The browser stops location watching on confirmation or page exit.

### Voice call requests

`npm run location` also starts a control API for the voice backend on
`127.0.0.1:8092` (`PHOTON_CONTROL_PORT` overrides it). It is a separate loopback
listener, never behind the tunnel, and every request needs
`Authorization: Bearer $PHOTON_BRIDGE_TOKEN`; requests carrying a browser `Origin`
are refused. Set the same `PHOTON_BRIDGE_TOKEN` (32+ random characters, e.g.
`openssl rand -base64 32`) in `backend/.env`; both processes read that file. The backend
reaches the API at `PHOTON_CONTROL_URL` (default `http://127.0.0.1:8092`, loopback only).
Without the token the backend never offers a link and calls behave as before.

The backend decides when to offer a link (the caller doesn't know or can't clearly give
the address, or asks to share their location; never for a witness somewhere else), asks
for consent, and only then creates a request for that call. The recipient is the
caller's number from the signed Twilio webhook, and it must be an allowed, enrolled
iMessage sender. One request can be active per call and per number.

- After the caller agrees, the card is sent straight away. No incoming text is needed,
  before or after a restart. Photon checks live iMessage reachability for the number
  (`addresses.isIMessageAvailable`, on our own line), then resolves the user and
  creates the direct conversation (`user(number)` → `space.create(user)`), then sends
  one rich link with no accompanying text.
- An `any;-;` chat ID says nothing about transport. If the number isn't reachable by
  iMessage, or reachability can't be checked, nothing is sent (`unavailable` or
  `failed`) and the agent asks for the address verbally. There is no SMS/RCS fallback.
  A provider record placing the sent card in an SMS/RCS conversation counts as a failure.
- Incoming texts never create a request or trigger a card.
- Eligibility (asked at the start of each call) also requires live iMessage reachability,
  so the agent doesn't offer a link it can't send. If reachability can't be checked, the
  answer is "unknown" (503) and the backend asks again later.
- Statuses: `accepted` means the send returned a record. `sent` and `delivered` come
  from the initial record or fresh provider RPC reads, bypassing the SDK's message
  cache. Sends and delivery checks run in the background so they do not hold up
  incoming messages for other calls. The agent gives the map instructions only after `sent`. One send
  attempt is made per request; a failure is reported, and resending takes a new
  request (the old link is withdrawn).
- A confirmation is recorded only for an active request with its own call ID. When
  the call ends, the backend cancels the request, and the page then refuses new
  confirmations (410). The backend gives the confirmed point to that call's
  conversation and saves it on the same incident as the ordinary map candidate. The existing
  dashboard displays the pin, and dispatcher confirmation and assignment work as before.
  A receipt makes database retries idempotent; closed calls and older fixes cannot move the pin.
  A dispatcher-confirmed destination is retained, and explicit spoken corrections still use
  the normal correction path. Caller confirmation is never treated as dispatcher verification.

First contact: Photon's deliverability guidance
(<https://photon.codes/docs/best-practices/imessage-deliverability>) says Apple can
limit link tapping in messages from an unknown sender until the recipient replies.
The card is still sent immediately after verbal consent, and verbal consent does not
lift that restriction. An enrolled phone that already has a conversation with the line
isn't affected. A number messaging the line for the very first time might see a card it
can't open until it replies. In that case the caller can still give the address
verbally, which the agent keeps asking for.

Limitations: requests are held in memory, so restarting this process drops open
requests and their links; the backend then treats an open request as failed. Restarting
doesn't affect later calls: the next consent sends a fresh card with no text first. If
`sent` isn't reported within 20 seconds, the agent says it can't confirm the link was
sent and keeps collecting the address verbally. Browser voice sessions have no trusted
caller number and never offer a link.

### Repeat testing

There is no permanent "already shared" flag on a phone number. Each new phone call
starts with no confirmed location and a fresh limit of three requests. A confirmed
location on an earlier call doesn't stop a later call from the same phone getting and
confirming a new link, even after Photon restarts.

Within one call, a confirmation stops unsolicited offers. Ask "Can you send the
location link again?" and agree to the consent question to get a fresh link, up to
the per-call limit. Reopening the old link does not create another confirmation.
For a full repeat test, hang up and call again. For page-only tests outside a call,
the existing `--send-location` startup option creates a new independent link.

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
