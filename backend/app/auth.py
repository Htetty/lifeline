"""Server-only credentials for legacy ingestion and the browser session boundary."""
import os
import secrets
from fastapi import Header, HTTPException
from .config import settings


def check_bearer(value, expected):
    if not expected:
        raise HTTPException(503, "Voice access is not configured")
    if not secrets.compare_digest(value.encode(), f"Bearer {expected}".encode()):
        raise HTTPException(401, "Unauthorized")


def require_backend(authorization: str = Header(default="")):
    check_bearer(authorization, settings.backend_secret)


def require_voice(authorization: str = Header(default="")):
    check_bearer(authorization, os.getenv("VOICE_BRIDGE_TOKEN", ""))
