"""Independent PR #9 QA over real loopback HTTP/WebSocket + disposable Convex.

Run through scripts/integration/local_convex.sh on an unused local port pair.
Speech, Claude and playback marks are fixtures: NO HUMAN HEARING IS TESTED.
The server binds port zero and stops only its own thread/socket.
"""
import base64
import hashlib
import json
import socket
import threading
import time
import uuid
from unittest.mock import patch
from xml.etree import ElementTree

import httpx
import uvicorn
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import connect

from test_integration import Base, SECRET, convex, facts
from test_phone_integration import ProviderFixture, WORDS, ACCOUNT, TOKEN, ORIGIN, STREAM
from app import main, twilio_media as phone
from twilio.request_validator import RequestValidator


class IndependentPhoneQA(Base):
    def setUp(self):
        super().setUp()
        self.call = "CA" + uuid.uuid4().hex
        self.env = {"TWILIO_ACCOUNT_SID": ACCOUNT, "TWILIO_AUTH_TOKEN": TOKEN,
                    "TWILIO_PHONE_NUMBER": "+15555550123", "TWILIO_PUBLIC_BASE_URL": ORIGIN}
        self.enterContext(patch.object(phone, "voice_environment", return_value=self.env))
        self.enterContext(patch.object(phone, "CartesiaSpeech", ProviderFixture))
        ProviderFixture.output = []
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.port = self.listener.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(main.app, log_level="error", access_log=False))
        self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [self.listener]}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.wait(lambda: self.server.started)
        self.net = self.enterContext(httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=5))

    def stop_server(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)
        self.listener.close()
        self.assertFalse(self.thread.is_alive(), "QA server thread leaked")

    def wait(self, predicate):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.02)
        self.fail("Independent loopback phone QA timed out")

    def signed(self, path, form=None, origin=ORIGIN):
        return {"X-Twilio-Signature": RequestValidator(TOKEN).compute_signature(origin + path, form or {})}

    def form(self):
        return {"AccountSid": ACCOUNT, "CallSid": self.call, "To": self.env["TWILIO_PHONE_NUMBER"]}

    def lease(self):
        form = self.form()
        response = self.net.post(phone.VOICE_PATH, data=form, headers=self.signed(phone.VOICE_PATH, form))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(TOKEN, response.text)
        return ElementTree.fromstring(response.text).find("Connect/Stream/Parameter").attrib["value"]

    def ws(self):
        return connect(f"ws://127.0.0.1:{self.port}{phone.MEDIA_PATH}",
                       additional_headers=self.signed(phone.MEDIA_PATH), open_timeout=5, close_timeout=5)

    def start(self, lease):
        return {"event": "start", "sequenceNumber": "1", "streamSid": STREAM, "start": {
            "callSid": self.call, "accountSid": ACCOUNT, "streamSid": STREAM,
            "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1},
            "customParameters": {"lease": lease}}}

    def test_real_http_signature_canonical_origin_and_expired_call_lease(self):
        form = self.form()
        self.assertEqual(self.net.post(phone.VOICE_PATH, data=form).status_code, 403)
        # A forged Host/forwarded header must not choose the signature origin.
        headers = {**self.signed(phone.VOICE_PATH, form, "https://attacker.invalid"),
                   "Host": "attacker.invalid", "X-Forwarded-Host": "attacker.invalid"}
        self.assertEqual(self.net.post(phone.VOICE_PATH, data=form, headers=headers).status_code, 403)
        self.assertEqual(self.net.post(phone.VOICE_PATH, data={**form, "CallSid": "browser-invented"},
                                      headers=self.signed(phone.VOICE_PATH, {**form, "CallSid": "browser-invented"})).status_code, 403)
        with self.assertRaises(InvalidStatus):
            with connect(f"ws://127.0.0.1:{self.port}{phone.MEDIA_PATH}", open_timeout=5):
                self.fail("Unsigned websocket unexpectedly opened")
        lease = self.lease()
        phone._leases[self.call].expires = time.monotonic() - 1
        with self.ws() as ws:
            ws.send(json.dumps(self.start(lease)))
            with self.assertRaises(ConnectionClosed):
                ws.recv(timeout=5)
        self.assertEqual(self.incidents(), [])

    def test_real_socket_correction_clear_retry_replay_receipts_and_stop(self):
        lease = self.lease()
        self.extract(facts(reported_address="123 Hotel Circle South", next_question=None))
        completed = []
        with self.ws() as ws:
            ws.send(json.dumps(self.start(lease)))
            sequence = 1

            def send(kind, **data):
                nonlocal sequence
                sequence += 1
                message = {"event": kind, "sequenceNumber": str(sequence), "streamSid": STREAM, **data}
                ws.send(json.dumps(message))
                return message

            def receive(kind):
                for _ in range(100):
                    message = json.loads(ws.recv(timeout=8))
                    if message["event"] == kind:
                        return message
                self.fail(f"No {kind} message")

            greeting = receive("mark")["mark"]
            send("mark", mark=greeting)  # simulated provider completion, not hearing
            media = {"track": "inbound", "payload": base64.b64encode(bytes([255]) * 160).decode()}
            duplicate = send("media", media=media)
            ws.send(json.dumps(duplicate))
            self.wait(lambda: self.incident(missing_ok=True) is not None)
            original = self.incident()
            self.extract(facts(reported_address="456 Hotel Circle North", people_count=4,
                               location_changed=True, next_question=None))
            send("media", media=media)
            self.wait(lambda: self.incident()["peopleCount"] == 4)
            corrected = self.incident()
            self.assertEqual(corrected["_id"], original["_id"])
            self.assertEqual(corrected["transcript"].count("Caller:"), 2)
            self.assertIn("123 Hotel Circle South", corrected["transcript"])
            self.assertIn("456 Hotel Circle North", corrected["transcript"])
            self.assertTrue(corrected["factHistory"])
            team = self.dispatch()
            first = receive("mark")["mark"]
            self.assertIn(team["name"], ProviderFixture.output[-1])
            self.extract(facts(reported_address="456 Hotel Circle North", people_count=4, next_question=None))
            send("media", media=media)  # interrupt the initial UNACKNOWLEDGED assignment
            receive("clear")
            send("mark", mark=first)
            self.assertEqual(len(self.announcements()), 1)
            retry = receive("mark")["mark"]
            self.assertNotEqual(retry, first)
            self.assertIn(team["name"], ProviderFixture.output[-1])
            completed.append((retry["name"], ProviderFixture.output[-1]))
            send("mark", mark=retry)
            self.wait(lambda: not self.announcements())
            event = convex.query("calls:currentAnnouncement", {"secret": SECRET, "callId": self.call})
            acknowledged_at = event["announcedAt"]
            self.assertIsNotNone(acknowledged_at)
            self.wait(lambda: self.incident()["transcript"].count("Agent:") == 1)
            # Completed assignments must not automatically repeat while quiet.
            with self.assertRaises(TimeoutError):
                ws.recv(timeout=3)
            self.extract(facts(reported_address="456 Hotel Circle North", people_count=4,
                               next_question="Is anyone hurt?"))
            send("media", media=media)  # explicit replay request, already acknowledged
            replay = receive("mark")["mark"]
            self.assertIn(team["name"], ProviderFixture.output[-1])
            self.assertNotEqual(ProviderFixture.output[-1], "Is anyone hurt?")
            self.assertEqual(self.announcements(), [])
            send("media", media=media)  # interrupt requested replay
            receive("clear")
            send("mark", mark=replay)
            final = receive("mark")["mark"]
            self.assertNotEqual(final, replay)
            completed.append((final["name"], ProviderFixture.output[-1]))
            send("mark", mark=final)
            self.wait(lambda: self.incident()["transcript"].count("Agent:") == 2)
            # Verify actual durable receipt identities and exact sequences, including agent speech.
            turns = [
                (f"{STREAM}-1", "caller", WORDS[0]), (f"{STREAM}-2", "caller", WORDS[1]),
                (f"{STREAM}-3", "caller", WORDS[2]), (f"spoken-{completed[0][0]}", "agent", completed[0][1]),
                (f"{STREAM}-4", "caller", WORDS[3]), (f"{STREAM}-5", "caller", WORDS[4]),
                (f"spoken-{completed[1][0]}", "agent", completed[1][1]),
            ]
            for number, (turn_id, speaker, text) in enumerate(turns, 1):
                fingerprint = hashlib.sha256(json.dumps([speaker, text], ensure_ascii=False).encode()).hexdigest()
                receipt = convex.query("calls:turnReceipt", {"secret": SECRET, "callId": self.call,
                                      "turnId": turn_id, "sequence": number, "fingerprint": fingerprint})
                self.assertTrue(receipt["saved"])
                self.assertEqual(receipt["incident"]["incidentId"], original["_id"])
            self.assertEqual(convex.mutation("calls:startVoiceCall", {"secret": SECRET, "callId": self.call})["nextSequence"], 8)
            self.assertEqual(convex.query("calls:currentAnnouncement", {"secret": SECRET, "callId": self.call})["announcedAt"], acknowledged_at)
            send("stop", stop={"callSid": self.call})
            with self.assertRaises(ConnectionClosed):
                ws.recv(timeout=8)
        self.wait(lambda: not self.incident()["callConnected"])
        final_incident = self.incident()
        self.assertEqual(final_incident["_id"], original["_id"])
        self.assertEqual(final_incident["status"], "assigned")
        self.assertEqual(final_incident["peopleCount"], 4)
        self.assertEqual(final_incident["reportedAddress"], "456 Hotel Circle North")
        self.assertEqual(self.announcements(), [])
