# Voice test script: does the agent keep the caller updated?

A fictional call you speak into the browser voice page while acting as the dispatcher on
the dashboard. At each step it lists what to say, what to click, and what you should hear.

## Setup

1. Backend running (`cd backend && .venv/bin/uvicorn app.main:app --port 8000`) and the
   dashboard (`cd dashboard && npx next dev -p 3100`).
2. Open the dashboard at http://localhost:3100 and the voice page at
   http://localhost:8000/voice in two windows side by side. **Use headphones.**
3. On the voice page, leave the token blank, click **Start microphone**, and allow the microphone.

This uses the **Courtyard hotel**, which has no other reports, so the call isn't
auto-linked to an existing incident. Speak naturally, pause after each line, and wait for
the agent to finish before you reply. Updates are spoken at the next pause, never over you.

## Script

| # | You say (caller) | You do (dashboard) | You should hear / see |
|---|---|---|---|
| 0 | (wait) | — | *"Hello, this is Lifeline. Tell me what's happening and where help is needed."* |
| 1 | "Help, the water's coming up the stairs. We're at the Courtyard hotel in Mission Valley, room 905." | Watch the queue | Incident appears with **Auto-located · confirm**; the Courtyard turns red on the map. The agent asks a follow-up (e.g. how many people). |
| 2 | "There's two of us. My wife can't swim and it's getting really high." | — | The agent responds to what you said (e.g. acknowledges and asks the next detail). No canned "passed your details" line: saving the report isn't announced. Dashboard: 2 people, risk factors listed. |
| 3 | "Is anyone actually coming?" | — | Agent: *"Your details are with the dispatcher, who is confirming your location. No team has been assigned yet."*, then a question. |
| 4 | (wait) | Open the incident → **Confirm location** | Agent: *"The dispatcher has confirmed your location and is arranging a rescue team."* |
| 5 | (wait) | Pick a team → **Approve assignment** | Agent: *"Update from the dispatcher: a rescue team, <team>, has been assigned to you."* |
| 6 | "Okay, are they on their way?" | — | Agent: *"A rescue team (<team>) has been assigned to you. It hasn't been marked as on its way yet."* |
| 7 | (wait) | In **What the caller has heard**, send: "Hang a towel from your window so the boat crew can spot you." | Agent: *"The dispatcher asked me to tell you: Hang a towel from your window…"* Panel shows it as **SPOKEN**. |
| 8 | (wait) | **Mark en route** | Agent: *"The dispatcher has marked the rescue team as on its way to you."* |
| 9 | "How long until they get here?" | — | Agent says the team is on its way and that it has **no arrival time**; it never makes one up. |
| 10 | Click **End session** on the voice page | **Mark resolved** | The incident shows **Call ended** and stays open until you resolve it. Nothing is spoken after hang-up. |

## Optional checks

- **Team change:** after step 5, click **Unassign team**. You should hear *"Update: the
  dispatcher is arranging a different rescue team for you…"*, never the old team's name.
  Assign another team and you hear only the new one.
- **Latest wins:** confirm the location and approve a team within a second or two. You
  should hear only the assignment, not the older "location confirmed".
- **Panic wording:** say "it's up to my neck" or "I can't touch the floor" and check the
  incident turns **CRITICAL** with "water at chest or higher".
- **Correction:** say "sorry, I'm wrong, we're at the Handlery Hotel". The pin moves to
  the Handlery as a new unconfirmed candidate, and the change appears under
  "Changed by caller".

If an update doesn't come, check the incident's **What the caller has heard** panel:
*waiting* means it's queued for the next pause; *replaced* means a newer update took its
place; *not delivered* means the call had already ended.
