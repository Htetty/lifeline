"""Independent partner-feature smoke checks on the PR #11 combined candidate.

Requires the disposable local Convex runner. Claude is mocked; no audio is played.
The text WebSocket is real loopback TCP on an OS-assigned unused port.
"""
import json
import socket
import threading
import time

import uvicorn
from websockets.sync.client import connect

from test_integration import Base, DISPATCHER, VOICE, convex, facts
from app import main


class PartnerFeaturesQA(Base):
    def test_live_text_stream_witness_messages_history_and_priority_override(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(main.app, log_level="error", access_log=False))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()

        def cleanup():
            server.should_exit = True
            thread.join(timeout=10)
            listener.close()
            self.assertFalse(thread.is_alive(), "QA text server did not stop")

        self.addCleanup(cleanup)
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(server.started)
        self.extract(facts(caller_role="witness", reported_position="room 312", next_question=None,
                           risk_factors=[{"factor": "child", "evidence": "I can see a child"}]))
        with connect(f"ws://127.0.0.1:{port}/calls/{self.call}/stream", additional_headers=VOICE,
                     open_timeout=5, close_timeout=5) as ws:
            ws.send(json.dumps({"type": "utterance", "speaker": "caller",
                                "text": "Fictional witness: three people in room 312; I can see a child."}))
            result = status = details = None
            deadline = time.monotonic() + 8
            while not (result and status and details):
                message = json.loads(ws.recv(timeout=max(.1, deadline - time.monotonic())))
                if message["type"] == "utterance_result":
                    result = message
                elif message["type"] == "status" and message["status"]:
                    status = message["status"]
                elif message["type"] == "announcement" and message["kind"] == "details_received":
                    details = message
            self.assertTrue(result["saved"])
            self.assertEqual(status["callerRole"], "witness")
            self.assertIn("No team has been assigned", status["sayIfAsked"])
            incident = self.incident()
            self.assertEqual(incident["riskFactors"][0]["factor"], "child")
            convex.mutation("incidents:setPriorityOverride", {
                **DISPATCHER, "incidentId": incident["_id"], "tier": "standard", "reason": "Fictional QA override",
            })
            self.assertEqual(self.incident()["priorityOverride"], {"tier": "standard", "reason": "Fictional QA override"})
            words = "This is a fictional dispatcher message."
            convex.mutation("incidents:sendCallerMessage", {
                **DISPATCHER, "incidentId": incident["_id"], "message": words,
            })
            deadline = time.monotonic() + 8
            while True:
                message = json.loads(ws.recv(timeout=max(.1, deadline - time.monotonic())))
                if message["type"] == "announcement" and message["kind"] == "dispatcher_message":
                    break
            self.assertEqual(message["text"], "The dispatcher asked me to tell you: " + words)
            event_id = message["eventId"]
            ws.send(json.dumps({"type": "ack", "eventId": event_id}))  # text-only completion fixture
            deadline = time.monotonic() + 5
            while True:
                history = convex.query("incidents:callerUpdates", {**DISPATCHER, "incidentId": incident["_id"]})
                if any(event["id"] == event_id and event["state"] == "spoken" for event in history):
                    break
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.02)
            convex.mutation("incidents:setPriorityOverride", {
                **DISPATCHER, "incidentId": incident["_id"], "tier": None, "reason": "",
            })
            self.assertIsNone(self.incident()["priorityOverride"])
            self.assertEqual(self.incident()["riskFactors"], incident["riskFactors"])
            ws.send(json.dumps({"type": "end"}))
            deadline = time.monotonic() + 5
            while json.loads(ws.recv(timeout=max(.1, deadline - time.monotonic())))["type"] != "ended":
                pass
            self.assertFalse(self.incident()["callConnected"])
            self.assertEqual(self.incident()["status"], "needs_review")

    def test_dispatcher_link_unlink_and_mark_separate_controls_remain_available(self):
        self.extract(facts(reported_address="Fictional QA Hotel", reported_position="room 312"))
        self.say("Fictional QA report one, room 312.")
        first = self.incident()
        other_call = self.call + "-other"
        self.say("Fictional QA report two, room 312.", call=other_call)
        second = self.incident(other_call)
        self.addCleanup(lambda: convex.mutation("incidents:setStatus", {
            **DISPATCHER, "incidentId": second["_id"], "status": "resolved",
        }))
        convex.mutation("incidents:linkReports", {
            **DISPATCHER, "mainId": first["_id"], "reportIds": [second["_id"]],
        })
        self.assertEqual(self.incident(other_call)["linkedTo"], first["_id"])
        convex.mutation("incidents:unlinkReport", {**DISPATCHER, "reportId": second["_id"]})
        self.assertIsNone(self.incident(other_call)["linkedTo"])
        self.assertIsNone(self.incident(other_call)["assignedTeamId"])
        convex.mutation("incidents:markSeparate", {
            **DISPATCHER, "incidentId": first["_id"], "otherId": second["_id"],
        })
        for incident_id in (first["_id"], second["_id"]):
            convex.mutation("incidents:verifyLocation", {
                **DISPATCHER, "incidentId": incident_id, "latitude": 32.76, "longitude": -117.17,
            })
        # Identical room/address/pin would normally auto-group. Explicit separation wins.
        self.assertIsNone(self.incident().get("linkedTo"))
        self.assertIsNone(self.incident(other_call).get("linkedTo"))
        self.assertIn(second["_id"], self.incident()["separateFrom"])
        self.assertIn(first["_id"], self.incident(other_call)["separateFrom"])
