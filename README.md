# FloodLine

Hackathon prototype for simulated flood-report calls. Checkpoint 1 answers a call,
reads the fixed demonstration greeting using Twilio `<Say>`, then executes
`<Hangup>`. No caller input is collected or stored.

The existing Next.js frontend lives in `src/`; the Python FastAPI service lives
in `backend/` and runs independently.

## Run the voice server

From the repository root, with Python 3.10+:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

No environment variables are required. `.env.example` intentionally contains
only comments. No Account SID, Auth Token, API key, or phone number is needed by
this service because it makes no Twilio REST API calls. Keep future credentials
server-side in ignored `.env` files; never use `NEXT_PUBLIC_*` for secrets.

Endpoints:

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health` | `{"status":"ok"}` |
| POST | `/voice/inbound` | `application/xml`: `<Response><Say ...>…</Say><Hangup /></Response>` |

The greeting is:

> Hello, you’ve reached FloodLine, a non-emergency hackathon demonstration. This call is a simulation. If you are experiencing a real emergency, hang up and contact local emergency services. Our voice assistant will be available soon. Thank you for testing.

## Local verification

With the server running:

```bash
curl --fail-with-body http://127.0.0.1:8000/health
curl --fail-with-body -sS -X POST http://127.0.0.1:8000/voice/inbound \
  -d 'CallSid=CA_test' -o /tmp/floodline-voice.xml
python -c 'import xml.etree.ElementTree as E; r=E.parse("/tmp/floodline-voice.xml").getroot(); assert r.tag == "Response"; assert [e.tag for e in r] == ["Say", "Hangup"]; assert r[0].text; print("Valid XML with Say followed by Hangup")'
```

This checks XML parsing and the expected TwiML structure, not Twilio execution or
telephone audio. The automated checks also assert the full greeting and XML
content type:

```bash
python -m pip install -r backend/requirements-dev.txt
python -m unittest discover -s backend -v
```

## Expose the webhook over public HTTPS

Install [ngrok](https://ngrok.com/docs/getting-started/) and complete its account
and authentication setup. In a second terminal, run:

```bash
ngrok http 8000
```

Keep both the server and tunnel running. Copy ngrok's **HTTPS forwarding URL**,
for example `https://example.ngrok-free.app`. Test the public route too:

```bash
curl --fail-with-body -i -X POST https://example.ngrok-free.app/voice/inbound
```

Replace the example hostname with your actual tunnel hostname. Expect HTTP 200
and XML, with no redirect or login page. If the tunnel hostname changes, update
Twilio's webhook URL. Twilio cannot reach your `localhost` directly.

This small demo webhook is public and does not validate Twilio request signatures;
it returns only static TwiML and performs no privileged operations. Add signature
validation before introducing sensitive data or side effects.

## Configure Twilio and make the actual call

1. Sign in to the [Twilio Console](https://console.twilio.com/). Select the account
   containing your **Voice-capable** Twilio number. Obtain a Voice-capable number
   if you do not already have one; complete any country-specific regulatory setup.
2. Open **Phone Numbers → Manage → Active numbers**, select the number, and open
   its **Configure** / **Voice Configuration** section. Console labels may vary
   between the new and legacy Console; search for Active Numbers if necessary.
3. Set **Configure with** to **Webhook, TwiML Bin, Function, Studio Flow, Proxy
   Service** (the Webhooks/TwiML option). Under **A call comes in**, choose
   **Webhook**, enter `https://YOUR-TUNNEL-HOST/voice/inbound`, and set the HTTP
   method to **POST**. Save the configuration. Use the incoming-call handler,
   rather than the call status callback or messaging webhook.
   In the new Console, the equivalent route is **Numbers & senders → your number
   → Configuration details → Voice and emergency address → Edit configuration
   details**. Select the region, the Webhook/TwiML option, then **Use Webhooks**;
   enter the same full URL with `/voice/inbound`, select **POST**, and save.
4. Call that Twilio number from your phone. Allow any trial announcement to finish
   and follow its prompt if one is played. Hear the complete FloodLine greeting,
   then verify the call disconnects normally. This is the acceptance test.
5. If it fails, inspect **Monitor → Logs → Calls** (or Voice Logs in the new
   Console), select the call, and inspect webhook requests/responses and Debugger
   errors. Check the URL, POST method, server, tunnel, and HTTP/XML response.

Twilio's [incoming-call tutorial](https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls)
explains the public webhook and number configuration. Its official
[Say reference](https://www.twilio.com/docs/voice/twiml/say) and
[Hangup reference](https://www.twilio.com/docs/voice/twiml/hangup) define the two
instructions used here.

### Account and trial considerations

- Use a real Voice-enabled number and an active account with remaining minutes
  or balance. Local requests do not place calls or consume Twilio minutes;
  actual calls can incur charges and your carrier's normal rates.
- Current [Voice trial documentation](https://www.twilio.com/docs/usage/trials/try-out-voice)
  requires verified caller numbers for inbound trial testing, limits calls to
  your country, and allows custom `<Say>` and `<Hangup>` instructions. Verify
  your calling phone in the Console; the sign-up number is normally verified.
  For the new trial UI, use **Communications → Voice → Overview → Try out Voice**,
  select **Inbound**, select your verified **From** number, and choose the
  **Custom** scenario for your webhook, then save. Use the trial Voice number
  shown for that scenario. If your trial UI does not expose a custom webhook,
  upgrade and configure an owned Voice number using the steps above.
- Current trials expire after 30 days and provide 75 voice minutes, with a
  10-minute per-call cap. Check the Console for your account's available units
  and eligibility; older accounts may have a different trial experience.
  See the [trial overview](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account).
- Twilio's [trial limitations](https://help.twilio.com/hc/en-us/articles/360036052753-Twilio-Free-Trial-Limitations)
  describe an extra trial announcement before application TwiML. That announcement
  is controlled by Twilio and may precede FloodLine's greeting.

Official Twilio references checked October 23, 2026. Local XML and HTTP checks
cannot confirm account eligibility, Console settings, speech playback, or normal
phone disconnection. An actual phone-call test remains required.

## Existing frontend

To run the Next.js frontend separately:

```bash
npm install
npm run dev
```

Open http://localhost:3000. The voice checkpoint does not depend on the frontend.
