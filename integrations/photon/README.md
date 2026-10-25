# Photon iMessage: first increment

Stable Spectrum at <https://app.photon.codes>, using `@spectrum-ts/core` and
`@spectrum-ts/imessage` 12.14.0. This is separate from the Beta SMS project at
`app.beta.photon.codes`. The deprecated `@photon-ai/advanced-imessage-kit` is not used.

This increment replies `echo: hi` when an enrolled, explicitly allowed sender texts
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
can reply again to replayed traffic. Durable intake/outbox receipts belong in the
next increment before incident creation, location links or dispatcher updates.

Free/Pro shared proxy events use the SDK's `phone="shared"` sentinel. Dedicated
events must match the configured line. Both require an allowed sender and an
inbound direct iMessage conversation. Logs include stream heartbeats and rejection
reason codes, without message text, sender addresses, or credentials.

Dependency check: the pinned SDK currently brings a moderate OpenTelemetry baggage
allocation advisory through `@photon-ai/otel` (`@opentelemetry/core <2.8.0`). Telemetry
is disabled here. Do not force npm's proposed SDK downgrade; recheck the upstream
dependency before enabling telemetry or adding an HTTP ingress.

## Next increment

Add a location page and send it with `richlink(url)`. The phone needs a reachable
HTTPS URL, which can be a temporary tunnel during development. Link preview bots
must not submit or consume a location request. The user explicitly permits location
access, reviews/moves the pin, and submits. Submitted coordinates remain unverified
until the dispatcher reviews them. Native `app(url)` cards can be added separately;
the current docs describe a Spectrum extension installation on first use.

## Provider references

- <https://photon.codes/docs/spectrum-ts/getting-started>
- <https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing>
- <https://photon.codes/docs/spectrum-ts/content/rich-links>
- <https://photon.codes/docs/spectrum-ts/content/app>
