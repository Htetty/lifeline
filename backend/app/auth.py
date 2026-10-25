"""Optional bearer token for the voice layer (off by default for the demo).

Set VOICE_BRIDGE_TOKEN to require `Authorization: Bearer <token>` on /calls/* and
/voice/sessions. Separate from BACKEND_SECRET, which stays between this server and
Convex, so a voice client never holds the secret that unlocks backend Convex functions.
"""

import os
import secrets

from fastapi import Header, HTTPException


def require_voice(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("VOICE_BRIDGE_TOKEN", "")
    if not expected:
        return  # open demo: no token configured
    if not secrets.compare_digest(authorization.encode(), f"Bearer {expected}".encode()):
        raise HTTPException(401, "Unauthorized")


def voice_token_ok(authorization: str, token: str | None = None) -> bool:
    """Same check for WebSockets, which can't use FastAPI header dependencies the same way."""
    expected = os.environ.get("VOICE_BRIDGE_TOKEN", "")
    if not expected:
        return True  # open demo: no token configured
    if token is not None and secrets.compare_digest(token.encode(), expected.encode()):
        return True
    return secrets.compare_digest(authorization.encode(), f"Bearer {expected}".encode())
