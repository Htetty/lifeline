from fastapi.testclient import TestClient

from app.main import app


def test_voice_worklet_is_served_from_same_origin_before_session_creation():
    with TestClient(app) as client:
        page = client.get("/voice")
        assert page.status_code == 200
        assert "script-src 'self' 'unsafe-inline'" in page.headers["content-security-policy"]
        assert 'audioWorklet.addModule("/voice/capture.js")' in page.text
        assert page.text.index("audioWorklet.addModule") < page.text.index('fetch("/voice/sessions"')
        assert "createObjectURL" not in page.text

        processor = client.get("/voice/capture.js")
        assert processor.status_code == 200
        assert processor.headers["content-type"].startswith("text/javascript")
        assert 'registerProcessor("capture", Capture)' in processor.text
