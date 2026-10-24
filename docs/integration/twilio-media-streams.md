# Twilio phone → Lifeline dispatcher bridge

Branch `codex/twilio-media-bridge`, based on dev `6ecdc6a` (merged PR #8).
PR #2 was read as a reference for the earlier greeting, server-side credentials
and diagnostic approach. Its separate FastAPI entrypoint and memory report store
are not imported or merged.

## Architecture and protocol

The existing `app.main:app` now also serves:

| Route | Purpose |
| --- | --- |
| `POST /twilio/voice` | Signed form webhook; returns `<Connect><Stream>` then `<Hangup>` |
| `WSS /twilio/media` | Signed bidirectional Media Stream, with a call-bound lease in Stream custom parameters |
| `GET /health` | Existing health endpoint |

`twilio_media.TwilioTransport` adapts Twilio to the existing `voice.Session`.
Only this transport is new: the same `process_utterance`, Claude extraction,
Convex ordered turn receipts, correction/fact history, advisory classifier,
current-assignment checks and `end_call` persistence are reused. There is no
second report store or conversation controller.

Inbound and outbound audio are headerless **G.711 μ-law, mono, 8000 Hz**.
Cartesia uses Ink-2 with `encoding=pcm_mulaw` and Sonic with
`output_format={container:raw, encoding:pcm_mulaw, sample_rate:8000}`.
No PCM conversion or WAV header is sent to Twilio. Existing voice selection,
Claude model/effort and optional advisory classifier settings are preserved.
Cartesia API requests retain version `2026-08-14` and server-side SDK credentials.

Authentication checks both the HTTP webhook and WSS handshake using the official
Twilio `RequestValidator` and the account Auth Token. The configured public HTTPS
origin is used for validation; untrusted Host/forwarded headers never select the
signature URL. WSS validation accepts the canonical HTTPS-upgrade/WSS forms and
Twilio's documented optional trailing slash. No signature validation bypass exists.

The signed form must match the configured AccountSid and destination number.
Its provider-originated CallSid is the stable Convex call identity. The TwiML
contains a 120-second one-use lease, bound to that CallSid. The signed stream
start must match the account, CallSid, lease and native audio format. Only one
connection can claim it. Caller-provided/model-generated IDs are never identity.
The provider StreamSid prefixes turn IDs, so reconnect attempts cannot collide
with previous stream turn receipts. This prototype does not auto-reconnect calls.

Inbound sequence numbers are checked; duplicate frames are ignored and gaps or
cross-stream data fail closed. Only Cartesia `turn.end` text enters extraction.
Audio receiving, ordered saves, playback control acknowledgements and dispatcher
polling run separately; slow Claude/Convex operations do not block audio transport.

## Playback and interruption

1. Synthesize an offer, then recheck that an announcement is current and that
   queued caller corrections have finished before starting playback.
2. Send raw `media` chunks followed by a unique `mark` name for that playback.
3. Only an incoming matching **pending** mark confirms normal playback completion.
   That completion enters the shared idempotent acknowledgement path.
4. On caller `turn.start` or a stale announcement, invalidate all pending mark
   names **before awaiting network I/O**, then send `clear`.
5. Twilio returns marks for cleared buffered audio as well as naturally completed
   audio. Cleared, unknown and repeated marks cannot acknowledge an announcement.
   An interrupted current update stays pending and can play again at a quiet pause.
6. If an acknowledgement commits but its response is lost, shared completed state
   retries the ack, not the audio. Caller/agent turn persistence uses the existing
   atomic Convex sequence/receipt transaction.

Stop/disconnect drains final STT turns and queued saves within the shared bounds,
closes provider/audio/poll/control tasks and persists `callConnected=false`.
Hangup never resolves the incident. Input-pump cancellation handles a full queue.

## Environment and startup

Keep all values in ignored `backend/.env` or process environment. Never share
secret values in chat. Existing root `.env` speech credentials also remain supported.

| Variable | Use |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Account/subaccount that owns the number |
| `TWILIO_AUTH_TOKEN` | Its account Auth Token for signatures; not an API-key secret |
| `TWILIO_PHONE_NUMBER` | Exact destination in E.164 form |
| `TWILIO_PUBLIC_BASE_URL` | Exact public HTTPS origin, no path/query, standard port 443 |
| `CARTESIA_API_KEY` | Server-side STT/TTS access |
| `CARTESIA_AGENT_ID` | Reads the existing voice; alternatively set actual authorized `CARTESIA_VOICE_ID` and `CARTESIA_TTS_MODEL` |
| `ANTHROPIC_API_KEY` | Existing Claude extraction |
| `CONVEX_URL`, `BACKEND_SECRET` | Matching isolated Convex deployment and backend secret for direct startup |
| `VOICE_BRIDGE_TOKEN` | Existing authenticated voice HTTP/simulator endpoints; not sent by Twilio |
| `DISPATCHER_TOKEN` | Convex dispatcher passcode, entered locally in the existing dashboard |
| `CLAUDE_MODEL`, `EXTRACTION_EFFORT` | Optional existing defaults, unchanged |
| `CLASSIFIER_MODEL_PATH` | Optional existing advisory classifier, unchanged |

Find the Account SID/Auth Token in the [Twilio Console](https://console.twilio.com/)
account information. Use the credentials for the number's actual account/region;
a parent account token is not a substitute for an unrelated subaccount token.

Install and start from repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cd dashboard && npm ci && cd ..

# Terminal 1: independent tunnel, preserves any existing ngrok endpoint.
cloudflared tunnel --url http://127.0.0.1:8020 --no-autoupdate

# Set the printed origin locally, then Terminal 2:
export TWILIO_PUBLIC_BASE_URL=https://YOUR-TUNNEL.trycloudflare.com
backend/.venv/bin/python backend/scripts/run_local_voice.py \
  --convex-port 3320 --convex-site-port 3321 --api-port 8020 --dashboard-port 3100
```

Use `brew install cloudflared` on macOS if needed. Cloudflare Quick Tunnels are
temporary development tunnels; the hostname changes when restarted. Do not use
interactive email/login protection in front of Twilio's non-browser endpoints.
An HTTPS/WSS hosting deployment or another public tunnel can be used instead.

The launcher uses a private temporary local Convex project, matching generated
backend secret and dispatcher passcode, one FastAPI process and the existing
dashboard. The dispatcher passcode is in the printed `dispatcher-token` file;
copy it locally into http://localhost:3100. It overrides child URLs without
editing production `.env` values. Data stays in the printed local state directory.
Ensure another Next dev server for this checkout is stopped first. The launcher
readiness check no longer calls the now-protected dispatcher query without auth.

For an already prepared isolated hosted deployment, use the normal entrypoint:

```bash
cd backend
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8020 --no-access-log
```

Run a **single worker** because stream leases and playback state are process-local.
Terminate TLS at the public tunnel/proxy and allow WSS upgrades. Keep keys and
the Convex backend secret out of browser bundles, logs and query strings.

## Readiness, Console configuration and rollback

Before changing the number, with the same `TWILIO_PUBLIC_BASE_URL` configured:

```bash
backend/.venv/bin/python backend/scripts/check_twilio_setup.py \
  --public --backup-number /PRIVATE/NEW/PATH/twilio-routing-before.json
```

This checks account/number access, saves only routing fields to a new private file,
tests signed/unsigned HTTPS requests and WSS identity rejection, and prints no
credentials or leases. It never modifies routing. Keep a screenshot of the number's
Voice Configuration as well. The backup refuses to overwrite an existing snapshot.

After all checks pass, in Twilio Console → Phone Numbers → Manage → Active numbers
→ the existing number → Voice Configuration:

1. Record the current **Configure with** selection, TwiML application/SIP trunk
   association, incoming URL/method and fallback settings before editing anything.
2. Select the webhook/TwiML option for Programmable Voice. If a Managed Agent
   imported the number through a SIP trunk or TwiML application, switch that
   number's handler deliberately: those associations override `voice_url`.
   Do not delete the trunk, agent, tools, voice, or application.
3. Set **A call comes in** → **Webhook**, URL
   `https://YOUR-PUBLIC-ORIGIN/twilio/voice`, method **HTTP POST**, then Save.
   The stream WSS URL is supplied by TwiML automatically; do not configure it as
   the number's HTTP webhook. No query string is used.
4. Keep unrelated SMS settings, status callback and fallback settings unchanged.
   Make the phone exercise while the tunnel/backend/dashboard remain running.

Rollback: in the same Console restore the previous Configure with selection and
the exact saved trunk/application or webhook URL/method/fallback settings. Restore
associations as well as URLs: a saved SIP trunk can take precedence over a webhook.
Do not re-import/delete the number or recreate the Managed Agent. After confirming
the previous phone experience works, stop this test's tunnel/launcher. Existing
ngrok routing is unaffected. The local incident remains saved after hangup.

## Phone exercise and evidence

Call the existing Twilio number **only after cutover readiness is confirmed**.
If the account is a trial, resolve any Twilio trial announcement/verified-number
requirements before attributing failure to this adapter.

1. Hear the simulation disclosure. Say: “This is a fictional flood. Three people
   are upstairs at 123 Hotel Circle South in Mission Valley. Water is rising on
   the stairs.” Answer a follow-up; keep the call open.
2. Find the connected incident in the dashboard before hangup. Say: “Correction:
   four people at 456 Hotel Circle North, still upstairs.” Verify the **same
   incident ID**, updated fields, earlier transcript and fact history.
3. Place the fictional location if needed, click **Confirm location**, choose an
   available simulated team, and click **Approve assignment**. Before approval
   the assistant must not claim a team is assigned.
4. While the first assignment announcement is speaking, interrupt: “Wait, I am
   still here.” The backend must clear audio and ignore the clear-returned mark.
   The current event must remain unacknowledged. Stay quiet for its retry.
5. Hear the complete update naming the approved team. Confirm it matches the
   dashboard; confirm the completed update does not repeat.
6. Hang up. Verify `callConnected=false`, the incident remains assigned, and
   transcript/history remain readable. Do not resolve the incident to end a call.

### Recorded verification (2026-10-24)

- `backend/.venv/bin/pytest -q backend/tests`: **41 passed, 3 skipped**, plus 17
  subtests. Skips include deployment-only integration and optional real weights.
- Disposable Convex regression: **38 tests, OK, one optional local-model skip**.
- New signed phone-flow test with **real local Convex**: passed creation,
  correction/history, duplicate audio, dispatcher approval, interruption/clear,
  rejected cleared mark, later completion ack and hangup retention. Speech,
  Claude and playback were mocked in this protocol test.
- Dashboard fixture tests: **7 passed**; TypeScript passed.
- `backend/.venv/bin/python backend/scripts/probe_voice_path.py --phone`: live
  Cartesia Ink final turn during an open native μ-law/8 kHz stream; Sonic produced
  35,200 bytes of raw μ-law assignment audio while input remained open. No call.
- Live Claude correction probe: corrected location and four-person count passed.
- Public account/number access, HTTPS health, signed TwiML, unsigned rejection,
  signed WSS upgrade and invalid stream identity rejection: **passed**.
- The number's previous `agents.cartesia.ai` voice webhook was backed up privately
  to `/tmp/lifeline-twilio-number-before.json`, then switched to HTTP POST
  `https://left-care-hidden-nick.trycloudflare.com/twilio/voice`. Captured fallback,
  application/trunk and status-callback fields were read back unchanged. The old
  ngrok endpoint remains untouched. This Cloudflare URL expires when its process stops.
- **Human phone greeting:** user confirmed hearing the Lifeline disclosure;
  Twilio-originated signature and stream identity were accepted, native Sonic
  playback received a natural Twilio completion mark. Call
  `CA5793b974aec81175ef79091a42519aff` ended after 25 seconds without a saved caller
  utterance. Full correction/assignment/interruption/hangup exercise is still
  pending. Do not count synthetic/provider tests as hearing.

Reproduce the deployment-dependent tests only against the disposable runner:

```bash
scripts/integration/local_convex.sh backend/.venv/bin/python -m unittest discover -s backend/tests -v
```

Never run reset/destructive regression scripts against shared team Convex.

## Limits

Twilio's returned mark establishes provider playback completion, not human hearing.
A mark received after a clear is conservatively discarded even if a timing race
means some audio had already played. Abrupt process loss between playback and ack
cannot provide globally exactly-once audible delivery. Committed incidents and
turn receipts persist in Convex; queued raw audio and uncommitted turns do not
survive a process crash. Bounded storage failures may require operator recovery
of the last saved report/end state. The shared session caps calls at 30 minutes.
TTS is generated as raw bytes before sending, not streamed during generation.
Do not treat this simulation as an emergency service.

## Official references

- [Cartesia index](https://docs.cartesia.ai/llms.txt),
  [STT audio input](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input),
  [TTS output formats](https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts-output-audio-format).
- [Twilio Stream TwiML](https://www.twilio.com/docs/voice/twiml/stream),
  [media/mark/clear messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages),
  [signature validation and WSS URL notes](https://www.twilio.com/docs/usage/security).
- [Number handler precedence](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource),
  [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
