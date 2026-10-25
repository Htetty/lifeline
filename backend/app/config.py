import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


@dataclass(frozen=True)
class Settings:
    convex_url: str
    backend_secret: str
    claude_model: str
    # Model for the demo simulation's scripted callers (scripts/demo_sim.py); live calls use claude_model.
    sim_claude_model: str
    extraction_effort: str


def load_settings() -> Settings:
    convex_url = os.environ.get("CONVEX_URL", "")
    backend_secret = os.environ.get("BACKEND_SECRET", "")
    if not convex_url or not backend_secret:
        raise RuntimeError("Set CONVEX_URL and BACKEND_SECRET in backend/.env (see .env.example).")
    return Settings(
        convex_url=convex_url,
        backend_secret=backend_secret,
        claude_model=os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5"),
        sim_claude_model=os.environ.get("SIM_CLAUDE_MODEL", "claude-haiku-5-5"),
        # Extraction is a short structured task that runs during a live call, so favour latency.
        extraction_effort=os.environ.get("EXTRACTION_EFFORT", "low"),
    )


settings = load_settings()
