"""Bearer token for the voice layer's HTTP calls.

Separate from BACKEND_SECRET, which stays between this server and Convex, so a
voice client never holds the secret that unlocks every backend Convex function.
"""

import os
import secrets

from fastapi import Header, HTTPException


def require_voice(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("VOICE_BRIDGE_TOKEN", "")
    if not expected:
        raise HTTPException(503, "Voice access is not configured (set VOICE_BRIDGE_TOKEN)")
    if not secrets.compare_digest(authorization.encode(), f"Bearer {expected}".encode()):
        raise HTTPException(401, "Unauthorized")
