"""Thin async wrapper over the Convex Python client (which is synchronous)."""

import asyncio
import time
from typing import Any

from convex import ConvexClient

from .config import settings

_client = ConvexClient(settings.convex_url)


async def _mutation(name: str, args: dict[str, Any]) -> Any:
    return await asyncio.to_thread(_client.mutation, name, {"secret": settings.backend_secret, **args})


async def _query(name: str, args: dict[str, Any]) -> Any:
    return await asyncio.to_thread(_client.query, name, {"secret": settings.backend_secret, **args})


async def upsert_from_call(
    call_id: str,
    source: str,
    transcript: str,
    reported_address: str | None = None,
    people_count: int | None = None,
    reported_position: str | None = None,
    hazards: list[dict[str, str | None]] | None = None,
    summary: str | None = None,
    candidate: tuple[float, float, str] | None = None,
    location_changed: bool = False,
    turn: dict | None = None,
    response: dict | None = None,
) -> dict[str, Any]:
    location = (
        {"candidateLatitude": candidate[0], "candidateLongitude": candidate[1], "candidateLabel": candidate[2]}
        if candidate
        else {}
    )
    return await _mutation(
        "calls:upsertFromCall",
        {
            **(turn or {}),
            **({"response": response} if turn else {}),
            **location,
            "locationChanged": location_changed,
            "callId": call_id,
            "source": source,
            "transcript": transcript,
            "reportedAddress": reported_address,
            # Convex numbers are floats on the wire.
            "peopleCount": float(people_count) if people_count is not None else None,
            "reportedPosition": reported_position,
            "hazards": hazards or [],
            "summary": summary,
        },
    )


async def call_ended(call_id: str) -> None:
    await _mutation("calls:callEnded", {"callId": call_id})


async def status_for_call(call_id: str) -> dict[str, Any] | None:
    return await _query("calls:statusForCall", {"callId": call_id})


async def pending_events(call_id: str) -> list[dict[str, Any]]:
    return await _query("calls:pendingEvents", {"callId": call_id})


async def current_announcement(call_id: str) -> dict[str, Any] | None:
    return await _query("calls:currentAnnouncement", {"callId": call_id})


async def transcript_for_call(call_id: str) -> str | None:
    return await _query("calls:transcriptForCall", {"callId": call_id})


async def mark_announced(call_id: str, event_id: str) -> dict[str, bool]:
    return await _mutation("calls:markAnnounced", {"callId": call_id, "eventId": event_id})


async def set_advisory_tags(
    call_id: str, status: str, tags: list[str], model_version: str | None, based_on_version: int
) -> bool:
    return await _mutation(
        "calls:setAdvisoryTags",
        {
            "callId": call_id,
            "tags": {
                "status": status,
                "tags": tags,
                "modelVersion": model_version,
                "basedOnVersion": float(based_on_version),
                "at": time.time() * 1000,
            },
        },
    )


async def start_voice_call(call_id: str) -> dict:
    return await _mutation("calls:startVoiceCall", {"callId": call_id})


async def turn_receipt(call_id: str, turn: dict) -> dict | None:
    return await _query("calls:turnReceipt", {"callId": call_id, **turn})
