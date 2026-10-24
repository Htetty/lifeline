# Human phone rehearsal: reconciled candidate

**Status: not performed. Human audio is unverified on this candidate** until the person on the call confirms what
they heard. Automated results are in the PR description. A logged Twilio mark or a simulated `playback_complete` is
not a human pass.

- **Candidate:** `codex/phone-reconciliation`. It combines dev `5cfc7e5`, PR #10 `0822927`, PR #9 `523bffc`,
  QA `836a26c`, and the reconciliation and grouping fixes. Record the exact commit you run: `git rev-parse HEAD`.
- **Owner approval is needed** before the number points at this candidate. Nothing in this branch changes routing.

## Run the candidate beside the working phone, not instead of it

The working phone currently uses Convex 3320/3321, API 8020 and dashboard 3100. Leave those running. Use unused
ports and your own tunnel (check first with `lsof -nP -iTCP:<port> -sTCP:LISTEN`):

```bash
# Terminal 1: a separate quick tunnel for the candidate
cloudflared tunnel --url http://127.0.0.1:8030 --no-autoupdate
# Terminal 2: from this worktree, with the tunnel origin it printed
export TWILIO_PUBLIC_BASE_URL=https://CANDIDATE-TUNNEL.trycloudflare.com
backend/.venv/bin/python backend/scripts/run_local_voice.py \
  --convex-port 3490 --convex-site-port 3491 --api-port 8030 --dashboard-port 3130
```

`run_local_voice.py` creates a fresh local Convex. Credentials come from your private environment; never paste them
into chat or this file.

To point the number at the candidate, follow `twilio-media-streams.md`: "Readiness, Console configuration and
rollback". Back up the current handler first, respect handler precedence, and restore it afterwards. Open the
candidate dashboard at http://localhost:3130.

## Script (fictional details only)

Write down the call ID (CallSid) and keep `backend` logs for the call.

| # | Do | Pass when (you and the dashboard/logs agree) |
| --- | --- | --- |
| 1 | Listen to the simulation disclosure. Say "Three upstairs at 123 Hotel Circle South." Then say "Correction: four at 456 Hotel Circle North." | The intake question after your first turn is still asked, after "I've passed your details…" (a pending update no longer drops it). The dashboard shows **one** incident with count 4 and the North address in needs-review. "Changed by caller" keeps 3 and the South address. |
| 2 | Dispatcher confirms the location and approves one team. As the **first, unacknowledged** assignment starts, say "Wait, hold on." | The audio stops. Logs show a clear and ignored mark. The event stays unacknowledged. |
| 3 | Stay quiet. | You hear the **complete** assignment retry, with no question overlapping it. Say the team name you heard. |
| 4 | Wait at least 10 seconds. | Nothing repeats automatically. |
| 5 | Say "Can you repeat that?" | You hear the same assignment again, completely. The original ack timestamp is unchanged. |
| 6 | Ask again, and interrupt the replay early. | The audio stops. A fresh complete retry follows. No question overlaps it. The ack timestamp is still unchanged. |
| 7 | *(Optional, dev behaviour.)* Dispatcher unassigns the team. Ask "Which team is coming?" | You hear "the dispatcher is arranging a different rescue team…". You never hear the old team name. |
| 8 | Hang up. | No further audio. One disconnected, still-open incident with 4 people, the North address, history, and contiguous turn receipts 1–N. |

## Record

| Item | Value |
| --- | --- |
| Candidate commit | |
| Call ID | |
| Team name heard (step 3) | |
| Each step pass / fail, with what you heard | |
| Observer | |

The human result counts only with the caller's own confirmation of the team heard, completeness, interruption
stopping, and no overlap, alongside matching state and mark evidence. Afterwards, restore the number's previous
handler and stop only this candidate's tunnel and launcher.
