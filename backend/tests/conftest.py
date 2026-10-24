"""Never import the developer's configured shared deployment during tests."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Unroutable on purpose: 3210 is often a teammate's running local backend, and a unit
# test that forgets a mock must fail fast rather than reach any live service.
os.environ["CONVEX_URL"] = "http://127.0.0.1:9"
os.environ["BACKEND_SECRET"] = "fixture-backend-secret"
os.environ["VOICE_BRIDGE_TOKEN"] = "fixture-voice-token"
os.environ["ANTHROPIC_API_KEY"] = "fixture-not-a-key"


import pytest  # noqa: E402


class _NoConvex:
    """Fails at once, like an unreachable deployment, without any network or retries."""

    def query(self, *args, **kwargs):
        raise ConnectionRefusedError("unit tests never reach Convex; mock the convex_store call")

    mutation = query


@pytest.fixture(autouse=True)
def _no_live_convex(monkeypatch):
    # Real-Convex suites run under scripts/integration/local_convex.sh, which sets this.
    if os.environ.get("LIFELINE_LOCAL_CONVEX_URL"):
        return
    from app import convex_store

    monkeypatch.setattr(convex_store, "_client", _NoConvex())
