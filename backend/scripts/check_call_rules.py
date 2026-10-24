"""Regression checks for the call/incident rules, against the configured Convex deployment.

    python scripts/check_call_rules.py            # Convex rules only (fast, no Claude)
    python scripts/check_call_rules.py --live     # also run real calls through FastAPI + Claude

Test incidents (call ids starting "check-") are resolved at the end, which frees any team
they used, and then deleted so they don't clutter the shared map.
"""

import argparse
import sys
import time
import uuid
from pathlib import Path

import httpx
from convex import ConvexClient, ConvexError
from dotenv import dotenv_values

env = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
convex = ConvexClient(env["CONVEX_URL"])
SECRET = env["BACKEND_SECRET"]
HANDLERY = (32.761251, -117.172499)
DAYS_INN = (32.759883, -117.167228)

failures: list[str] = []
created: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else f'  ({detail})'}")
    if not ok:
        failures.append(name)


def new_call() -> str:
    return f"check-{uuid.uuid4().hex[:8]}"


def upsert(call_id: str, address: str | None, changed: bool = False, candidate=None) -> dict:
    args = {
        "secret": SECRET, "callId": call_id, "source": "live_demo", "reportedAddress": address,
        "peopleCount": 2.0, "reportedPosition": "[check] roof", "hazards": [], "summary": "[check]",
        "transcript": "Caller: [check]", "locationChanged": changed,
    }
    if candidate:
        args |= {"candidateLatitude": candidate[0], "candidateLongitude": candidate[1], "candidateLabel": "Map search: test"}
    result = convex.mutation("calls:upsertFromCall", args)
    if result["incidentId"] not in created:
        created.append(result["incidentId"])
    return result


def incident(call_id: str) -> dict:
    return next(i for i in convex.query("exercise:get")["incidents"] if i["callId"] == call_id)


def free_team() -> dict:
    return next(t for t in convex.query("exercise:get")["teams"] if t["available"])


def rejected(fn) -> str | None:
    try:
        fn()
    except ConvexError as e:
        return str(e.data)
    return None


def convex_rules() -> None:
    # 1. Rewording the same place keeps the dispatcher's confirmed location.
    c = new_call()
    r = upsert(c, "the Handlery Hotel", candidate=HANDLERY)
    convex.mutation("incidents:verifyLocation", {"incidentId": r["incidentId"]})
    upsert(c, "the Handlery Hotel, room 312")
    i = incident(c)
    check("reworded address keeps confirmed location", i["locationVerified"] and i["latitude"] == HANDLERY[0],
          f"verified={i['locationVerified']} lat={i['latitude']}")

    # 2. A stale 'changed' flag with the same text doesn't reset it either.
    upsert(c, "The Handlery Hotel, room 312", changed=True)
    check("repeated change flag with same place keeps location", incident(c)["locationVerified"])

    # 3. A real correction before dispatch sends it back to review with the new candidate.
    upsert(c, "the Days Inn on Hotel Circle South", changed=True, candidate=DAYS_INN)
    i = incident(c)
    check("real correction resets to needs_review", i["status"] == "needs_review" and not i["locationVerified"]
          and i["latitude"] == DAYS_INN[0], f"status={i['status']} lat={i['latitude']}")

    # 4. First address after the dispatcher already placed the incident doesn't undo the placement.
    c2 = new_call()
    r2 = upsert(c2, None)
    convex.mutation("incidents:verifyLocation", {"incidentId": r2["incidentId"], "latitude": HANDLERY[0], "longitude": HANDLERY[1]})
    upsert(c2, "the Handlery Hotel", changed=True)
    check("first address after manual placement keeps it", incident(c2)["locationVerified"])

    # 5. Status rules: no reopening, unassign frees the team, no moving the pin after dispatch.
    team = free_team()
    convex.mutation("incidents:assignTeam", {"incidentId": r2["incidentId"], "teamId": team["_id"]})
    err = rejected(lambda: convex.mutation(
        "incidents:verifyLocation", {"incidentId": r2["incidentId"], "latitude": DAYS_INN[0], "longitude": DAYS_INN[1]}))
    check("moving location after dispatch is rejected", err is not None)
    upsert(c2, "the Days Inn", changed=True, candidate=DAYS_INN)
    i = incident(c2)
    check("caller correction after dispatch flags, doesn't move pin",
          i["status"] == "assigned" and i["latitude"] == HANDLERY[0], f"status={i['status']} lat={i['latitude']}")
    convex.mutation("incidents:setStatus", {"incidentId": r2["incidentId"], "status": "awaiting_assignment"})
    t = next(x for x in convex.query("exercise:get")["teams"] if x["_id"] == team["_id"])
    i = incident(c2)
    check("unassign frees the team", t["available"] and i["assignedTeamId"] is None)
    convex.mutation("incidents:setStatus", {"incidentId": r2["incidentId"], "status": "resolved"})
    err = rejected(lambda: convex.mutation("incidents:setStatus", {"incidentId": r2["incidentId"], "status": "en_route"}))
    check("resolved incident can't be reopened to en_route", err is not None)

    # 6. Announcements can only be acknowledged by their own call.
    c3 = new_call()
    r3 = upsert(c3, "the Handlery Hotel", candidate=HANDLERY)
    convex.mutation("incidents:verifyLocation", {"incidentId": r3["incidentId"]})
    convex.mutation("incidents:assignTeam", {"incidentId": r3["incidentId"], "teamId": free_team()["_id"]})
    events = convex.query("calls:pendingEvents", {"secret": SECRET, "callId": c3})
    convex.mutation("calls:markAnnounced", {"secret": SECRET, "callId": "someone-else", "eventId": events[0]["_id"]})
    still = convex.query("calls:pendingEvents", {"secret": SECRET, "callId": c3})
    check("other call can't acknowledge an announcement", len(still) == 1)


def live_calls(api: str) -> None:
    with httpx.Client(base_url=api, timeout=120) as http:
        def say(call_id: str, speaker: str, text: str) -> dict:
            r = http.post(f"/calls/{call_id}/utterances", json={"speaker": speaker, "text": text})
            r.raise_for_status()
            return r.json()

        # 7. An agent greeting alone doesn't create an incident.
        c = new_call()
        say(c, "agent", "Flood rescue line, what's your emergency?")
        has = any(i["callId"] == c for i in convex.query("exercise:get")["incidents"])
        check("agent greeting creates no incident", not has)

        # 8. Real extraction: confirming, then the caller adding detail, keeps the location.
        body = say(c, "caller", "We're stuck on the roof of the Days Inn on Hotel Circle South, two of us.")
        created.append(body["incident"]["incidentId"])
        inc = incident(c)
        check("named hotel is auto-located", inc["latitude"] is not None, f"note={inc.get('locationNote')}")
        if inc["latitude"] is not None:
            convex.mutation("incidents:verifyLocation", {"incidentId": inc["_id"]})
        say(c, "caller", "It's the Days Inn near SeaWorld, we're on the part of the roof by the pool.")
        check("caller adding detail keeps confirmed location (live Claude)", incident(c)["locationVerified"])

        # 9. Real correction goes back to review.
        say(c, "caller", "Wait, sorry, I was wrong. We're at the Handlery Hotel, not the Days Inn.")
        inc = incident(c)
        check("caller correction resets review (live Claude)", inc["status"] == "needs_review" and not inc["locationVerified"],
              f"status={inc['status']} address={inc['reportedAddress']!r}")
        transcript_lines = inc["transcript"].count("\n") + 1
        check("transcript keeps every line", transcript_lines == 4, f"{transcript_lines} lines")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--api", default="http://localhost:8000")
    args = parser.parse_args()
    try:
        convex_rules()
        if args.live:
            live_calls(args.api)
    finally:
        for incident_id in created:
            try:
                convex.mutation("incidents:setStatus", {"incidentId": incident_id, "status": "resolved"})
            except ConvexError:
                pass  # already resolved
        convex.mutation("calls:purgeCheckIncidents", {"secret": SECRET})
    print(f"\n{len(failures)} failure(s)" if failures else "\nAll checks passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    start = time.time()
    main()
