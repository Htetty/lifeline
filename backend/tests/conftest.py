"""Never import the developer's configured shared deployment during tests."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["CONVEX_URL"] = "http://127.0.0.1:3210"
os.environ["BACKEND_SECRET"] = "fixture-backend-secret"
os.environ["VOICE_BRIDGE_TOKEN"] = "fixture-voice-token"
os.environ["ANTHROPIC_API_KEY"] = "fixture-not-a-key"
