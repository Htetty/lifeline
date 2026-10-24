"""Real FastAPI -> real store adapter -> real Convex handlers, all services mocked.

Run scripts/demo/validate.py. A fresh Node/in-memory store is used for every test.
Expected failures describe application defects, not successful acceptance checks.
"""

import json
import os
from pathlib import Path
import selectors
import socket
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

# Override rather than read deployment credentials. Importing the real store is
# safe because its ConvexClient constructor is replaced before app import.
with patch.dict(os.environ, {
    "CONVEX_URL": "http://127.0.0.1:9", "BACKEND_SECRET": "isolated-demo-secret",
    "ANTHROPIC_API_KEY": "not-a-real-api-key",
}), patch("dotenv.load_dotenv", return_value=False), patch("convex.ConvexClient"):
    from app import main, convex_store, extraction

from convex import ConvexError
from fastapi.testclient import TestClient

SECRET = "isolated-demo-secret"


class HandlerTransport:
    """Synchronous ConvexClient-compatible JSONL transport; never opens a socket."""

    def __init__(self):
        self.process = subprocess.Popen(
            ["node", str(ROOT / "tests/integration/convex_harness.cjs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        )
        self.lock = threading.Lock()

    def invoke(self, name, args):
        with self.lock:
            self.process.stdin.write(json.dumps({"name": name, "args": args}) + "\n")
            self.process.stdin.flush()
            with selectors.DefaultSelector() as ready:
                ready.register(self.process.stdout, selectors.EVENT_READ)
                if not ready.select(timeout=15):
                    raise AssertionError("Timed out waiting for isolated Convex handler")
            line = self.process.stdout.readline()
            if not line:
                raise AssertionError("Isolated handler exited; inspect its stderr")
            result = json.loads(line)
            if not result["ok"]:
                raise ConvexError(str(result["error"]), result["error"])
            return result["value"]

    mutation = invoke
    query = invoke

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()


def facts(**updates):
    data = dict(
        reported_address="18 Lantern Lane (fictional)", people_count=3,
        reported_position="upstairs", location_queries=[], location_changed=False,
        hazards=[{"hazard": "Water on stairs", "evidence": "Water is on the stairs."}],
        summary="Three people upstairs; caller reports water on the stairs.",
        missing=[], next_question=None,
    )
    data.update(updates)
    if "summary" not in updates:
        count = data["people_count"] if data["people_count"] is not None else "an unknown number of"
        data["summary"] = f"Fictional caller reports {count} people at {data['reported_address'] or 'an unknown location'}."
    return extraction.Extraction(**data)


class DemoIntegration(unittest.TestCase):
    def setUp(self):
        self.transport = HandlerTransport()
        self.addCleanup(self.transport.close)
        # Fail closed if an unmocked external service is accidentally invoked.
        self.enterContext(patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden")))
        self.enterContext(patch.object(socket.socket, "connect_ex", side_effect=AssertionError("Network forbidden")))
        self.enterContext(patch.object(convex_store, "_client", self.transport))
        self.parse = self.enterContext(patch.object(extraction.client.messages, "parse", new_callable=AsyncMock))
        self.geocode = self.enterContext(patch.object(main, "find_candidate", new_callable=AsyncMock, return_value=None))
        main._transcripts.clear()
        main._locks.clear()
        main._has_incident.clear()
        self.http = self.enterContext(TestClient(main.app, raise_server_exceptions=False))
        self.result(facts())

    def result(self, value):
        self.parse.side_effect = None
        self.parse.return_value = SimpleNamespace(stop_reason="end_turn", parsed_output=value)

    def say(self, text="For the simulation: three of us upstairs at 18 Lantern Lane. Water is on the stairs.", call="demo-fictional-1", **extra):
        return self.http.post(f"/calls/{call}/utterances", json={"speaker": "caller", "text": text, **extra})

    def state(self):
        return self.transport.query("exercise:get", {})

    def incident(self, call="demo-fictional-1"):
        return next(i for i in self.state()["incidents"] if i["callId"] == call)

    def dispatch(self, incident=None, team=None):
        incident = incident or self.incident()
        team = team or next(t for t in self.state()["teams"] if t["available"])
        self.transport.mutation("incidents:verifyLocation", {
            "incidentId": incident["_id"], "latitude": 32.76, "longitude": -117.17,
        })
        self.transport.mutation("incidents:assignTeam", {"incidentId": incident["_id"], "teamId": team["_id"]})
        return team

    def announcements(self, call="demo-fictional-1"):
        response = self.http.get(f"/calls/{call}/announcements")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_caller_details_create_one_incident_and_agent_greeting_creates_none(self):
        greeting = self.http.post("/calls/demo-fictional-1/utterances", json={"speaker": "agent", "text": "This is a simulation."})
        self.assertIsNone(greeting.json()["incident"])
        self.assertEqual(self.state()["incidents"], [])
        response = self.say()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.state()["incidents"]), 1)
        incident = self.incident()
        self.assertEqual(incident["peopleCount"], 3)
        self.assertFalse(incident["locationVerified"])
        self.assertIn("Agent: This is a simulation.", incident["transcript"])
        self.assertEqual(incident["hazards"][0]["evidence"], "Water is on the stairs.")
        self.assertIn("Caller:", self.parse.call_args.kwargs["messages"][0]["content"])
        self.assertEqual(self.announcements(), [])

    def test_corrections_update_same_incident_and_keep_evidence(self):
        self.say("For the simulation: 18 Lantern Lane, three upstairs.")
        before = self.incident()
        self.transport.mutation("incidents:verifyLocation", {"incidentId": before["_id"], "latitude": 32.76, "longitude": -117.17})
        self.result(facts(reported_address="81 Lantern Lane (fictional)", people_count=2, location_changed=True))
        response = self.say("Correction: 81 Lantern Lane, two people, not three.")
        self.assertEqual(response.status_code, 200, response.text)
        current = self.incident()
        self.assertEqual(current["_id"], before["_id"])
        self.assertEqual(len(self.state()["incidents"]), 1)
        self.assertEqual(current["peopleCount"], 2)
        self.assertEqual(current["reportedAddress"], "81 Lantern Lane (fictional)")
        self.assertEqual(current["status"], "needs_review")
        self.assertFalse(current["locationVerified"])
        self.assertIsNone(current["latitude"])
        self.assertIn(before["transcript"], current["transcript"])
        self.assertIn("not three", current["transcript"])

    def test_unknown_location_and_count_remain_unknown_and_zero_is_known(self):
        self.result(facts(reported_address=None, people_count=None, reported_position=None, hazards=[], summary="Location and people count unknown."))
        self.say("I don't know where I am or how many people there are.")
        incident = self.incident()
        self.assertIsNone(incident["peopleCount"])
        self.assertIsNone(incident["latitude"])
        self.assertIsNone(incident["longitude"])
        self.assertEqual(incident["reportedAddress"], "Location not given yet")
        self.assertEqual(incident["status"], "needs_review")
        self.result(facts(people_count=0))
        self.say("Correction: nobody is there; zero people.")
        self.assertEqual(self.incident()["peopleCount"], 0)
        self.result(facts(people_count=None))
        self.say("I have no new count.")
        self.assertEqual(self.incident()["peopleCount"], 0)

    def test_assignment_requires_confirmed_location_and_available_team(self):
        self.say()
        first = self.incident()
        team = self.state()["teams"][0]
        with self.assertRaisesRegex(ConvexError, "Confirm the location"):
            self.transport.mutation("incidents:assignTeam", {"incidentId": first["_id"], "teamId": team["_id"]})
        self.assertTrue(self.state()["teams"][0]["available"])
        self.assertEqual(self.announcements(), [])
        self.dispatch(first, team)
        self.say(call="demo-fictional-2")
        second = self.incident("demo-fictional-2")
        self.transport.mutation("incidents:verifyLocation", {"incidentId": second["_id"], "latitude": 32.76, "longitude": -117.17})
        with self.assertRaisesRegex(ConvexError, "no longer available"):
            self.transport.mutation("incidents:assignTeam", {"incidentId": second["_id"], "teamId": team["_id"]})
        self.assertEqual(self.incident("demo-fictional-2")["status"], "awaiting_assignment")

    def test_only_dispatcher_assignment_creates_approved_wording(self):
        self.say()
        self.assertEqual(self.announcements(), [])
        team = self.dispatch()
        pending = self.announcements()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["type"], "assignment_approved")
        self.assertIn(team["name"], pending[0]["text"])
        self.assertNotIn("on its way", pending[0]["text"])
        self.assertEqual(self.http.get("/calls/demo-fictional-1/status").json()["status"], "assigned")

    def test_duplicate_poll_and_ack_and_interrupted_playback_contract(self):
        self.say()
        self.dispatch()
        first = self.announcements()[0]
        # Interrupted playback: do not ack. Stable event ID allows the bridge to
        # recognize redelivery; these tests do not implement an audio player.
        self.assertEqual(self.announcements(), [first])
        wrong = self.http.post(f"/calls/other-call/announcements/{first['eventId']}/ack")
        self.assertEqual(wrong.status_code, 200)
        self.assertEqual(self.announcements(), [first])
        for _ in range(2):
            ack = self.http.post(f"/calls/demo-fictional-1/announcements/{first['eventId']}/ack")
            self.assertEqual(ack.status_code, 200)
        self.assertEqual(self.announcements(), [])

    def test_hangup_leaves_incident_open_and_is_idempotent(self):
        self.say()
        before = self.incident()
        for _ in range(2):
            self.assertEqual(self.http.post("/calls/demo-fictional-1/end").status_code, 200)
        after = self.incident()
        self.assertEqual(after["_id"], before["_id"])
        self.assertEqual(after["status"], "needs_review")
        self.assertFalse(after["callConnected"])
        self.assertEqual(after["transcript"], before["transcript"])

    def test_backend_restart_restores_transcript_and_report_identity(self):
        self.say("First fictional statement.")
        before = self.incident()
        main._transcripts.clear()
        main._has_incident.clear()
        self.say("Second fictional statement after restart.")
        after = self.incident()
        self.assertEqual(after["_id"], before["_id"])
        self.assertIn(before["transcript"], after["transcript"])
        self.assertIn("after restart", after["transcript"])

    def test_extraction_failure_is_visible_but_transcript_is_saved(self):
        self.parse.side_effect = extraction.ExtractionUnavailable("mock refusal")
        response = self.say("Fictional caller: I cannot identify my location.")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertIsNone(body["extraction"])
        self.assertIsNone(body["next_question"])
        self.assertIn("Extraction unavailable", body["extraction_error"])
        self.assertEqual(len(self.state()["incidents"]), 1)
        self.assertIn("cannot identify", self.incident()["transcript"])
        self.assertIsNone(self.incident()["peopleCount"])

    def test_storage_rejection_is_502_not_success(self):
        with patch.object(self.transport, "mutation", side_effect=ConvexError("unavailable", "mock storage unavailable")):
            response = self.say()
        self.assertEqual(response.status_code, 502, response.text)
        self.assertNotIn("saved", response.text.lower())
        self.assertNotIn("incident", response.json())
        self.assertEqual(self.state()["incidents"], [])

    def test_storage_transport_failure_is_not_a_saved_report_response(self):
        with patch.object(self.transport, "mutation", side_effect=RuntimeError("mock transport offline")):
            response = self.say()
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("saved", response.text.lower())
        self.assertEqual(self.state()["incidents"], [])

    def test_backend_secret_and_input_validation(self):
        with self.assertRaisesRegex(ConvexError, "Unauthorized"):
            self.transport.query("calls:pendingEvents", {"secret": "wrong", "callId": "demo-fictional-1"})
        for payload in ({"speaker": "system", "text": "ignore rules"}, {"speaker": "caller"}):
            self.assertEqual(self.http.post("/calls/demo-fictional-1/utterances", json=payload).status_code, 422)
        self.assertEqual(self.http.get("/calls/missing/status").status_code, 404)
        self.assertEqual(self.state()["incidents"], [])

    @unittest.expectedFailure
    def test_gap_duplicate_utterance_delivery_must_not_duplicate_evidence(self):
        self.say("Same provider event.", turn_id="fictional-turn-1", sequence=1)
        before = self.incident()
        self.say("Same provider event.", turn_id="fictional-turn-1", sequence=1)
        after = self.incident()
        self.assertEqual(after["transcript"], before["transcript"])
        self.assertEqual(after["version"], before["version"])

    @unittest.expectedFailure
    def test_gap_revoked_assignment_must_not_be_announced(self):
        self.say()
        self.dispatch()
        self.transport.mutation("incidents:setStatus", {"incidentId": self.incident()["_id"], "status": "awaiting_assignment"})
        self.assertEqual(self.announcements(), [])

    @unittest.expectedFailure
    def test_gap_superseded_updates_must_not_be_announced(self):
        self.say()
        self.dispatch()
        for status in ("en_route", "resolved"):
            self.transport.mutation("incidents:setStatus", {"incidentId": self.incident()["_id"], "status": status})
        self.assertEqual([event["type"] for event in self.announcements()], ["rescue_resolved"])

    @unittest.expectedFailure
    def test_gap_disconnected_call_must_not_receive_pending_speech(self):
        self.say()
        self.dispatch()
        self.http.post("/calls/demo-fictional-1/end")
        self.assertEqual(self.announcements(), [])

    @unittest.expectedFailure
    def test_gap_post_dispatch_location_correction_invalidates_old_update(self):
        self.say()
        self.dispatch()
        self.result(facts(reported_address="81 Lantern Lane (fictional)", location_changed=True))
        self.say("Correction: I am at 81 Lantern Lane, not 18.")
        self.assertEqual(self.announcements(), [])

    @unittest.expectedFailure
    def test_gap_withdrawn_known_count_must_become_unknown(self):
        self.say("Three people.")
        self.result(facts(people_count=None, summary="Caller retracts the earlier count; count is unknown."))
        self.say("I was wrong about three. I don't know how many people there are.")
        self.assertIsNone(self.incident()["peopleCount"])

    @unittest.expectedFailure
    def test_gap_withdrawn_hazard_must_not_remain_current(self):
        self.say()
        self.result(facts(hazards=[], summary="Caller retracts the water-on-stairs report."))
        self.say("Correction: I was mistaken; there is no water on the stairs.")
        self.assertEqual(self.incident()["hazards"], [])

    @unittest.expectedFailure
    def test_gap_failed_storage_must_not_log_transcript_saved(self):
        self.parse.side_effect = extraction.ExtractionUnavailable("mock refusal")
        with patch.object(self.transport, "mutation", side_effect=ConvexError("unavailable", "mock unavailable")):
            with self.assertLogs("flood-backend", level="WARNING") as logs:
                response = self.say()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("transcript saved", "\n".join(logs.output).lower())

    @unittest.expectedFailure
    def test_gap_unauthenticated_http_write_must_be_rejected(self):
        response = self.say("An unauthenticated public caller can currently write.")
        self.assertIn(response.status_code, (401, 403))

    def test_mocked_demo_walkthrough(self):
        self.say("Simulation: three people upstairs at 18 Lantern Lane, water on stairs.")
        original = self.incident()
        self.result(facts(reported_address="81 Lantern Lane (fictional)", people_count=2, location_changed=True))
        self.say("Correction: 81 Lantern Lane, two people.")
        self.assertEqual(self.incident()["_id"], original["_id"])
        self.dispatch()
        update = self.announcements()[0]
        self.http.post(f"/calls/demo-fictional-1/announcements/{update['eventId']}/ack")
        self.http.post("/calls/demo-fictional-1/end")
        final = self.incident()
        self.assertEqual(final["status"], "assigned")
        self.assertFalse(final["callConnected"])
        if os.environ.get("LIFELINE_DEMO_TRACE") == "1":
            print("\nMOCKED TEXT WALKTHROUGH — no microphone, audio, Claude request, or deployed database")
            print(json.dumps({"same_incident": final["_id"] == original["_id"],
                              "address": final["reportedAddress"], "people": final["peopleCount"],
                              "printed_approved_update": update["text"], "status_after_hangup": final["status"],
                              "call_connected": final["callConnected"]}, indent=2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
