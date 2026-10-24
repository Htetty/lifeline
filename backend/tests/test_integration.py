"""Cross-component regression tests: real FastAPI app, real Convex functions, mocked Claude.

Run with a disposable local Convex backend (never the shared deployment):

    scripts/integration/local_convex.sh backend/.venv/bin/python -m unittest discover -s backend/tests -v

Mocked here: Claude extraction, map search, the ModernBERT classifier, and all voice audio.
Real: HTTP routes and auth, the Convex client, and every Convex query/mutation and its rules.
Set LIFELINE_TRACE=1 to print the end-to-end walkthrough.
"""

import json
import logging
import os
import sys
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Only the runner's throwaway backend. backend/tests/conftest.py points CONVEX_URL at a
# fixture port that may be someone else's local backend, so the runner's values win.
CONVEX_URL = os.environ.get("LIFELINE_LOCAL_CONVEX_URL", "")
if urlsplit(CONVEX_URL).hostname not in ("127.0.0.1", "localhost"):
    raise unittest.SkipTest("writes data: run via scripts/integration/local_convex.sh (local Convex only)")
for name in ("BACKEND_SECRET", "DISPATCHER_TOKEN", "VOICE_BRIDGE_TOKEN"):
    os.environ[name] = os.environ[f"LIFELINE_LOCAL_{name}"]
os.environ["CONVEX_URL"] = CONVEX_URL
os.environ.setdefault("ANTHROPIC_API_KEY", "not-a-real-key")

from convex import ConvexClient, ConvexError  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import calls, convex_store, extraction, main  # noqa: E402
from app.config import settings  # noqa: E402

if settings.convex_url != CONVEX_URL:
    raise unittest.SkipTest("app settings were loaded for another Convex URL earlier in this process")

SECRET = os.environ["BACKEND_SECRET"]
DISPATCHER = {"dispatcherToken": os.environ["DISPATCHER_TOKEN"]}
VOICE = {"Authorization": f"Bearer {os.environ['VOICE_BRIDGE_TOKEN']}"}
convex = ConvexClient(CONVEX_URL)
TRACE = os.environ.get("LIFELINE_TRACE") == "1"


def facts(**updates) -> extraction.Extraction:
    data = dict(
        reported_address="18 Lantern Lane (fictional)", people_count=3, reported_position="upstairs",
        location_queries=[], location_changed=False, caller_role="trapped", risk_factors=[],
        hazards=[{"hazard": "Water on stairs", "evidence": "water is on the stairs"}],
        summary="Three people upstairs; water on the stairs.", missing=[], next_question="Is anyone hurt?",
    )
    data.update(updates)
    return extraction.Extraction(**data)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if convex.query("exercise:get", DISPATCHER) is None:
            convex.mutation("exercise:ensureSeeded", DISPATCHER)

    def setUp(self):
        self.call = f"itest-{uuid.uuid4().hex[:8]}"
        self.parse = self.enterContext(patch.object(extraction.client.messages, "parse", new_callable=AsyncMock))
        self.enterContext(patch.object(calls, "find_candidate", new_callable=AsyncMock, return_value=None))
        self.enterContext(patch.object(calls, "classify_text_async", None))
        self.http = self.enterContext(TestClient(main.app, raise_server_exceptions=False, headers=VOICE))
        self.extract(facts())

    def tearDown(self):
        # Free any team this test used, so tests don't run out of simulated teams.
        inc = self.incident(missing_ok=True)
        if inc and inc["status"] != "resolved":
            convex.mutation("incidents:setStatus", {**DISPATCHER, "incidentId": inc["_id"], "status": "resolved"})

    def extract(self, value):
        self.parse.side_effect = None
        self.parse.return_value = SimpleNamespace(stop_reason="end_turn", parsed_output=value)

    def say(self, text="Three of us upstairs, water is on the stairs.", speaker="caller", call=None):
        return self.http.post(f"/calls/{call or self.call}/utterances", json={"speaker": speaker, "text": text})

    def incidents(self, call=None):
        state = convex.query("exercise:get", DISPATCHER)
        return [i for i in state["incidents"] if i["callId"] == (call or self.call)]

    def incident(self, call=None, missing_ok=False):
        found = self.incidents(call)
        if not found and missing_ok:
            return None
        self.assertEqual(len(found), 1, f"expected exactly one incident, got {len(found)}")
        return found[0]

    def free_team(self, exclude=()):
        teams = convex.query("exercise:get", DISPATCHER)["teams"]
        return next(t for t in teams if t["available"] and t["_id"] not in exclude)

    def dispatch(self, team=None):
        inc = self.incident()
        convex.mutation("incidents:verifyLocation", {**DISPATCHER, "incidentId": inc["_id"], "latitude": 32.76, "longitude": -117.17})
        team = team or self.free_team()
        convex.mutation("incidents:assignTeam", {**DISPATCHER, "incidentId": inc["_id"], "teamId": team["_id"]})
        return team

    def set_status(self, status):
        convex.mutation("incidents:setStatus", {**DISPATCHER, "incidentId": self.incident()["_id"], "status": status})

    def announcements(self, call=None):
        r = self.http.get(f"/calls/{call or self.call}/announcements")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def ack(self, event_id, call=None):
        r = self.http.post(f"/calls/{call or self.call}/announcements/{event_id}/ack")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["acknowledged"]


class OneCallOneIncident(Base):
    def test_concurrent_first_utterances_create_one_incident(self):
        # Two FastAPI processes would not share the in-process lock; Convex must still dedupe.
        args = {"secret": SECRET, "callId": self.call, "source": "live_demo", "reportedAddress": None,
                "peopleCount": None, "reportedPosition": None, "hazards": [], "summary": None,
                "transcript": "Caller: hello", "locationChanged": False}
        threads = [threading.Thread(target=lambda: ConvexClient(CONVEX_URL).mutation("calls:upsertFromCall", args))
                   for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.incident()

    def test_retry_after_failed_save_does_not_duplicate_the_line(self):
        self.say("First line.")
        with patch.object(convex_store, "upsert_from_call", AsyncMock(side_effect=ConvexError("down", "down"))):
            self.assertEqual(self.say("Second line.").status_code, 502)
        self.assertEqual(self.say("Second line.").status_code, 200)
        transcript = self.incident()["transcript"]
        self.assertEqual(transcript.count("Second line."), 1, transcript)

    def test_agent_greeting_alone_creates_no_incident(self):
        r = self.say("Flood line, this is a simulation.", speaker="agent")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["saved"])
        self.assertEqual(self.incidents(), [])
        self.say()
        self.assertIn("Agent: Flood line", self.incident()["transcript"])


class Corrections(Base):
    def test_correction_updates_same_incident_and_keeps_evidence(self):
        self.say("Three of us at 18 Lantern Lane, water is on the stairs.")
        first = self.incident()
        convex.mutation("incidents:verifyLocation", {**DISPATCHER, "incidentId": first["_id"], "latitude": 32.76, "longitude": -117.17})
        self.extract(facts(reported_address="81 Lantern Lane (fictional)", people_count=2, location_changed=True,
                           hazards=[{"hazard": "Power line down", "evidence": "a power line is down"}]))
        self.say("Sorry, it's 81 Lantern Lane, two of us, and a power line is down.")
        now = self.incident()
        self.assertEqual(now["_id"], first["_id"])
        self.assertEqual((now["reportedAddress"], now["peopleCount"]), ("81 Lantern Lane (fictional)", 2))
        self.assertEqual(now["status"], "needs_review")
        self.assertFalse(now["locationVerified"])
        history = {(h["field"], h["previous"]): h["evidence"] for h in now["factHistory"]}
        self.assertIn(("peopleCount", "3"), history)
        self.assertIn(("reportedAddress", "18 Lantern Lane (fictional)"), history)
        self.assertEqual(history[("hazard", "Water on stairs")], "water is on the stairs")
        self.assertIn(first["transcript"], now["transcript"])

    def test_null_never_erases_a_known_fact(self):
        self.say()
        self.extract(facts(people_count=None, reported_position=None, hazards=[]))
        self.say("I'm not sure about anything else.")
        inc = self.incident()
        self.assertEqual((inc["peopleCount"], inc["reportedPosition"], len(inc["hazards"])), (3, "upstairs", 1))


class NoFalseSuccess(Base):
    def test_convex_rejection_is_502_and_never_saved(self):
        with patch.object(convex_store, "upsert_from_call", AsyncMock(side_effect=ConvexError("bad", "bad"))):
            with self.assertLogs("flood-backend", logging.WARNING) as logs:
                r = self.say()
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("saved", r.json())
        self.assertIn("Not stored", r.json()["detail"])
        self.assertFalse(any("transcript saved" in line.lower() for line in logs.output), logs.output)
        self.assertEqual(self.incidents(), [])

    def test_unreachable_storage_is_503_not_a_bare_crash(self):
        with patch.object(convex_store, "upsert_from_call", AsyncMock(side_effect=OSError("offline"))):
            r = self.say()
        self.assertEqual(r.status_code, 503)
        self.assertIn("Not stored", r.json()["detail"])

    def test_extraction_failure_still_saves_and_says_so_only_after_saving(self):
        self.parse.side_effect = extraction.ExtractionUnavailable("mock refusal")
        r = self.say("I can't tell where I am.")
        body = r.json()
        self.assertTrue(body["saved"])
        self.assertIsNone(body["next_question"])
        self.assertIn("can't tell", self.incident()["transcript"])


class Announcements(Base):
    def test_unassigned_team_is_never_announced(self):
        self.say()
        self.dispatch()
        self.set_status("awaiting_assignment")
        # The withdrawn assignment is never spoken; the caller only hears that a new team is being arranged.
        self.assertEqual([a["type"] for a in self.announcements()], ["assignment_changed"])

    def test_reassignment_announces_only_the_current_team(self):
        self.say()
        first = self.dispatch()
        stale = self.announcements()[0]
        self.set_status("awaiting_assignment")
        second = self.free_team(exclude={first["_id"]})
        convex.mutation("incidents:assignTeam", {**DISPATCHER, "incidentId": self.incident()["_id"], "teamId": second["_id"]})
        pending = self.announcements()
        self.assertEqual(len(pending), 1)
        self.assertIn(second["name"], pending[0]["text"])
        self.assertFalse(self.ack(stale["eventId"]), "a superseded update must not be acked as heard")

    def test_superseded_updates_are_skipped(self):
        self.say()
        self.dispatch()
        self.set_status("en_route")
        self.set_status("resolved")
        self.assertEqual([a["type"] for a in self.announcements()], ["rescue_resolved"])

    def test_location_correction_after_dispatch_withholds_assignment_update(self):
        self.say()
        self.dispatch()
        self.extract(facts(reported_address="81 Lantern Lane (fictional)", location_changed=True))
        self.say("Wait, we're at 81 Lantern Lane, not 18.")
        self.assertEqual(self.announcements(), [])
        self.assertEqual(self.incident()["status"], "assigned")  # flagged for the dispatcher, not silently moved

    def test_interrupted_playback_is_not_acknowledged(self):
        self.say()
        self.dispatch()
        update = self.announcements()[0]
        # Bridge started playing, caller barged in: no ack. The update must come back.
        self.assertEqual(self.announcements(), [update])
        self.assertFalse(self.ack(update["eventId"], call="itest-someone-else"))
        self.assertTrue(self.ack(update["eventId"]))
        self.assertTrue(self.ack(update["eventId"]))  # idempotent
        self.assertEqual(self.announcements(), [])

    def test_malformed_event_id_is_404(self):
        self.assertEqual(self.http.post(f"/calls/{self.call}/announcements/not-an-id/ack").status_code, 404)


class Termination(Base):
    def test_hangup_stops_announcements_and_preserves_incident(self):
        self.say()
        self.dispatch()
        self.assertEqual(len(self.announcements()), 1)
        self.assertEqual(self.http.post(f"/calls/{self.call}/end").status_code, 200)
        self.assertEqual(self.announcements(), [])
        inc = self.incident()
        self.assertEqual(inc["status"], "assigned")
        self.assertFalse(inc["callConnected"])

    def test_late_utterance_after_hangup_is_saved_but_does_not_reopen_the_call(self):
        self.say()
        self.dispatch()
        self.http.post(f"/calls/{self.call}/end")
        self.assertEqual(self.say("(late transcript line)").status_code, 200)
        inc = self.incident()
        self.assertFalse(inc["callConnected"])
        self.assertIn("late transcript line", inc["transcript"])
        self.assertEqual(self.announcements(), [])


class AccessControl(Base):
    def test_voice_routes_require_the_bridge_token(self):
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": f"Bearer {SECRET}"}):
            r = self.http.post(f"/calls/{self.call}/utterances", json={"speaker": "caller", "text": "x"},
                               headers={"Authorization": ""} | headers)
            self.assertEqual(r.status_code, 401, headers)
        self.assertEqual(self.http.get(f"/calls/{self.call}/announcements", headers={"Authorization": ""}).status_code, 401)
        self.assertEqual(self.incidents(), [])

    def test_voice_routes_are_open_when_no_token_is_configured(self):
        # Open demo by default (team decision); a configured token is enforced (test above).
        with patch.dict(os.environ, {"VOICE_BRIDGE_TOKEN": ""}):
            self.http.headers.pop("Authorization", None)
            self.assertEqual(self.say().status_code, 200)

    def test_dispatcher_functions_require_the_passcode(self):
        self.say()
        inc = self.incident()
        for token in ("", "wrong", SECRET):
            for name, args in (
                ("incidents:verifyLocation", {"incidentId": inc["_id"], "latitude": 1.0, "longitude": 1.0}),
                ("incidents:setStatus", {"incidentId": inc["_id"], "status": "resolved"}),
                ("exercise:reset", {}),
            ):
                with self.assertRaisesRegex(ConvexError, "passcode"):
                    convex.mutation(name, {"dispatcherToken": token, **args})
            with self.assertRaisesRegex(ConvexError, "passcode"):
                convex.query("exercise:get", {"dispatcherToken": token})
        self.assertEqual(self.incident()["status"], "needs_review")

    def test_backend_functions_require_the_backend_secret(self):
        with self.assertRaisesRegex(ConvexError, "Unauthorized"):
            convex.query("calls:pendingEvents", {"secret": os.environ["DISPATCHER_TOKEN"], "callId": self.call})


class AdvisoryTags(Base):
    def classifier(self, result=None, error=None):
        async def classify(text):
            self.classified.append(text)
            if error:
                raise error
            return result
        self.classified = []
        self.enterContext(patch.object(calls, "classify_text_async", classify))
        self.enterContext(patch.dict(os.environ, {"CLASSIFIER_MODEL_PATH": "/fake/model"}))

    def settle(self):
        # The background write runs on TestClient's event loop thread.
        for _ in range(100):
            if not calls._background:
                return
            threading.Event().wait(0.05)

    def test_tags_are_stored_separately_and_never_change_facts(self):
        self.classifier({"status": "ok", "scores": {"floods": 0.9, "medical_help": 0.8},
                         "predicted_tags": ["floods", "medical_help"], "threshold": 0.5, "model_version": "sha256:test"})
        self.extract(facts(hazards=[]))
        self.say("Agent line first?", speaker="agent", call=self.call)  # no incident yet: no classification
        self.say("We're upstairs. Someone needs a doctor.")
        self.settle()
        inc = self.incident()
        self.assertEqual(inc["advisoryTags"]["tags"], ["floods", "medical_help"])
        self.assertEqual(inc["advisoryTags"]["basedOnVersion"], inc["version"])
        self.assertEqual(inc["hazards"], [])
        self.assertEqual(inc["status"], "needs_review")
        self.assertEqual(self.classified, ["We're upstairs. Someone needs a doctor."])  # caller words only

    def test_classifier_failure_or_absence_never_fails_the_call(self):
        for setup in (lambda: self.classifier(error=RuntimeError("torch missing")),
                      lambda: self.classifier({"status": "unavailable", "scores": None, "predicted_tags": None,
                                               "threshold": None, "model_version": None})):
            setup()
            self.assertEqual(self.say().status_code, 200)
            self.settle()
        self.assertNotEqual(self.incident()["advisoryTags"]["status"], "ok")

    def test_late_result_for_older_version_is_ignored(self):
        self.say()
        self.say("More detail.")
        version = int(self.incident()["version"])
        newer = {"status": "ok", "tags": ["floods"], "modelVersion": "m", "basedOnVersion": float(version), "at": 2.0}
        older = {**newer, "tags": ["request"], "basedOnVersion": float(version - 1), "at": 3.0}
        self.assertTrue(convex.mutation("calls:setAdvisoryTags", {"secret": SECRET, "callId": self.call, "tags": newer}))
        self.assertFalse(convex.mutation("calls:setAdvisoryTags", {"secret": SECRET, "callId": self.call, "tags": older}))
        self.assertEqual(self.incident()["advisoryTags"]["tags"], ["floods"])


class EndToEnd(Base):
    """Fictional call → dashboard decisions → spoken updates → hang-up, as the bridge would drive it."""

    def test_fictional_voice_to_dashboard_to_voice(self):
        trace = []

        def log(step, **data):
            trace.append({"step": step, **data})

        self.say("Flood line. This is a simulated exercise. Where are you?", speaker="agent")
        log("agent greeting", incidents=len(self.incidents()))

        r = self.say("Three of us upstairs at 18 Lantern Lane, water is on the stairs.").json()
        log("caller report", saved=r["saved"], incident=r["incident"]["incidentId"], next_question=r["next_question"])
        incident_id = r["incident"]["incidentId"]

        self.extract(facts(reported_address="81 Lantern Lane (fictional)", people_count=2, location_changed=True))
        r = self.say("Sorry, 81 Lantern Lane, and it's two of us, not three.").json()
        inc = self.incident()
        log("caller correction", same_incident=inc["_id"] == incident_id, people=inc["peopleCount"],
            address=inc["reportedAddress"], history=[(h["field"], h["previous"]) for h in inc["factHistory"]])

        log("before dispatcher", announcements=self.announcements())
        team = self.dispatch()
        log("dispatcher confirms location and assigns", team=team["name"], status=self.incident()["status"])

        update = self.announcements()[0]
        log("bridge polls", type=update["type"], text=update["text"])
        log("playback interrupted (no ack); bridge re-polls", same_update_returned=self.announcements() == [update])
        log("playback completes; ack", acknowledged=self.ack(update["eventId"]), pending=self.announcements())

        self.set_status("en_route")
        en_route = self.announcements()[0]
        log("dispatcher marks en route", type=en_route["type"], acknowledged=self.ack(en_route["eventId"]))

        self.http.post(f"/calls/{self.call}/end")
        self.set_status("awaiting_assignment")
        self.set_status("resolved")
        inc = self.incident()
        log("hang-up, then dispatcher changes", announcements=self.announcements(),
            status=inc["status"], call_connected=inc["callConnected"])

        self.assertEqual(len(self.incidents()), 1)
        self.assertEqual(trace[0]["incidents"], 0)
        self.assertTrue(trace[2]["same_incident"])
        self.assertEqual(trace[3]["announcements"], [])
        self.assertTrue(trace[6]["same_update_returned"])
        self.assertEqual(trace[7]["pending"], [])
        self.assertEqual(trace[-1]["announcements"], [])
        self.assertEqual(inc["status"], "resolved")
        if TRACE:
            print("\nMOCKED VOICE TEXT, REAL BACKEND + LOCAL CONVEX — no audio, no Claude, no shared deployment")
            print(json.dumps(trace, indent=2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
