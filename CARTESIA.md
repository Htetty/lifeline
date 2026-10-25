# Lifeline voice experience

Lifeline gives a flood caller a spoken path from reporting a situation to hearing an approved dispatcher update. Cartesia processes audio input and generates response audio throughout that flow.

## Speech features used

| Contribution | Evidence |
| --- | --- |
| Streaming speech recognition with automatic turn detection; the code requests `ink-2` | [voice_provider.py](backend/app/voice_provider.py) |
| Speech synthesis through the Cartesia Python SDK; configured voice/model or existing agent settings, with `sonic-3.6` as the model fallback | [voice_provider.py](backend/app/voice_provider.py) |
| Caller speech interrupts playback; finalized turns enter an ordered persistence and extraction worker | [voice.py](backend/app/voice.py) |
| Mono G.711 mu-law telephone audio at 8 kHz, with a tuned phone end-of-turn threshold | [twilio_media.py](backend/app/twilio_media.py) |
| Browser microphone capture and playback-completion messages | [voice.html](backend/app/static/voice.html), [capture.js](backend/app/static/capture.js) |

The application uses direct Cartesia speech APIs. It can read an existing Managed Agent's voice settings; our backend and Claude control the conversation. Custom voice cloning and multilingual support are not implemented. Model strings describe code defaults and fallbacks, not every account's live configuration.

Reference: [Cartesia documentation](https://docs.cartesia.ai/get-started/overview) and [voice playground](https://play.cartesia.ai).

## Setup

Follow [the root README](README.md#run-locally) to install dependencies and start an isolated exercise. It lists credential names without publishing values. The launcher requires a bridge token even though direct server startup permits an open demo when no token is configured.

Open the browser voice entry point alongside the console. Start the microphone, describe a fictional incident in the selected exercise area, and leave the call open. The assistant asks for missing details; the console receives the saved report. Confirm its location and approve a team to hear the resulting announcement.

Provider credentials stay on the backend. Browser sessions use short-lived, single-use tickets and a same-origin WebSocket check. The controller checks that announcements are current before playback and acknowledges completion separately from synthesis. Interrupted output is not treated as completed delivery.

## Phone entry point

`POST /twilio/voice` and `WSS /twilio/media` share the browser flow's conversation controller, Cartesia adapter, incident store, and dispatcher confirmation rules.

Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, and `TWILIO_PUBLIC_BASE_URL` privately on the backend. The public base must be an HTTPS origin forwarding to that backend with WebSocket upgrades enabled. Use one worker: call leases and playback state are process-local.

Before directing a test number to the transport, run the existing readiness checker with the same backend configuration:

```sh
backend/.venv/bin/python backend/scripts/check_twilio_setup.py --public
```

The checker validates readiness; it does not change routing. Configure the test number's incoming-call webhook to the public backend's `/twilio/voice` path using POST. The transport validates Twilio signatures and call identity. Consent-based iMessage location sharing requires [Photon setup](integrations/photon/README.md).

## Two-minute presentation

| Time | Show and say |
| --- | --- |
| 0:00–0:25 | Start a microphone or test phone session. Report a fictional location, headcount, and rising water; let Lifeline ask a follow-up. |
| 0:25–0:45 | Correct a detail or interrupt a response. Show the updated transcript and incident in the console. |
| 0:45–1:15 | Confirm the location, review a team and route, and approve the assignment. Keep the call connected so the caller hears the update. |
| 1:15–1:30 | Show team progress and incident status. Explain that travel and flooding are simulated. |
| 1:30–1:45 | Explain the problem: incoming flood reports need to become clear, reviewable rescue information. |
| 1:45–2:00 | Explain the build: Cartesia handles speech, Claude structures the conversation, Convex synchronizes the console, and a dispatcher approves assignments. State a prototype limitation. |

Rehearse the exact location and team flow before recording. The dashboard's text simulation can populate a busier queue, but a Cartesia demonstration needs actual speech and audible output. A failed provider request or unplayed update should not be presented as a completed call.

## Known limitations

- The TTS adapter awaits generated audio before offering it to the caller. The repository does not establish an end-to-end latency guarantee.
- Use headphones: speaker audio can be transcribed as caller speech. Browser microphone permission, network access, and provider credentials are required.
- Decision checks, playback acknowledgements, and retries reduce stale or repeated announcements. Disconnects and crashes prevent a universal exactly-once audible-delivery guarantee.
- Phone leases, pending location links, and active sessions are held in process memory. Restarts can interrupt calls or invalidate links.
- Speech and location can be wrong. Dispatcher confirmation, preserved unknowns, and correction history support review; they do not establish operational safety.
- Transcripts are stored and providers process speech and text. Use fictional reports and obtain demonstration consent. Full privacy, retention, accessibility, multilingual, and call-surge evaluation remain unfinished.

Fixture coverage: [voice](backend/tests/test_voice.py), [phone transport](backend/tests/test_twilio_media.py), [replay](backend/tests/test_replay.py), and [location sharing](backend/tests/test_location_share.py). A working demo still needs a complete live voice rehearsal.
