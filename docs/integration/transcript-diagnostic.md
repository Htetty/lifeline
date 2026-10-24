# Live transcript diagnostic

Run from the repository root:

```bash
.venv/bin/python -u -m backend.transcript_diagnostic
# Or track a specific Cartesia call, rather than discover an active call:
.venv/bin/python -u -m backend.transcript_diagnostic --call-id YOUR_CARTESIA_CALL_ID
```

The diagnostic loads only `CARTESIA_API_KEY` and `CARTESIA_AGENT_ID` from the
ignored root `.env`, falling back to process environment variables. Values are
parsed as literals; shell commands and variable substitution are not executed.
No tool token, FastAPI server, tunnel, or reporting tool configuration is needed.
It uses the official Cartesia SDK with HTTPS, bearer authentication and version
`2026-08-14`. Only List Calls and Get Call are used. No storage is imported.

Wait for **READY: START CALL NOW**, call the existing number, and follow the
printed speech cues after the greeting and when the assistant pauses. The first
utterance describes a fictional flood; the second corrects the address and count.
At the finish cue, say goodbye and hang up normally. Leave the process running
for the post-call checks. If several calls are active, supply the intended call
ID explicitly; it must belong to the configured agent.

Output is limited to call state, transcript availability, turn counts, a flag
indicating changing caller speech, retention flags, and a final classification.
No transcript text, phone numbers, API credentials, or provider error bodies are
printed or written. Text fingerprints exist only in process memory. An error or
timeout is inconclusive, not evidence that the provider lacks live transcripts.

## Observed real-call result

During the developer's test on October 23, 2026 (Pacific time), SDK Get Call
responses showed:

- An active call with an initially null transcript.
- A transcript appearing while status remained `started`.
- Caller turns increasing from zero to one, two, three, and four during that call;
  the diagnostic detected changes in caller speech before hangup.
- After status became `completed`, nine spoken turns including four caller turns
  remained available. ZDR and redaction flags were false.

**Live caller transcript evidence is available for this account and agent.** It
does not appear instantaneously at call start. This observation does not establish
turn finalization guarantees, immutable transcript prefixes, report-tool selection,
report writes, or Convex persistence. Those require separate checks.

If a future account or agent yields speech only after hangup, the smallest
alternative is post-call polling through the same documented Get Call API, then
building a report from the returned provider transcript. Do not invent live
transcript evidence from model tool arguments. Call-event webhook availability
must be checked separately before using it instead of polling.

Official references: [List Calls](https://docs.cartesia.ai/api-reference/agents/calls/list-calls),
[Get Call](https://docs.cartesia.ai/api-reference/agents/calls/get-call),
[API conventions](https://docs.cartesia.ai/use-the-api/api-conventions).
