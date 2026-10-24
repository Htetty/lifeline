import unittest
from xml.etree import ElementTree

from fastapi.testclient import TestClient

from backend.main import app


class VoiceCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_incoming_call_says_complete_greeting_then_hangs_up(self):
        response = self.client.post(
            "/voice/inbound",
            data={"CallSid": "CA_test", "From": "+15555550100", "To": "+15555550101"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("application/xml"))
        root = ElementTree.fromstring(response.content)
        self.assertEqual(root.tag, "Response")
        self.assertEqual([child.tag for child in root], ["Say", "Hangup"])
        self.assertEqual(
            root[0].text,
            "Hello, you’ve reached FloodLine, a non-emergency hackathon demonstration. "
            "This call is a simulation. If you are experiencing a real emergency, "
            "hang up and contact local emergency services. Our voice assistant will "
            "be available soon. Thank you for testing.",
        )
        self.assertEqual(root[0].attrib, {"language": "en-US"})
        self.assertEqual(len(root[1]), 0)

    def test_voice_requires_post(self):
        self.assertEqual(self.client.get("/voice/inbound").status_code, 405)


if __name__ == "__main__":
    unittest.main()
