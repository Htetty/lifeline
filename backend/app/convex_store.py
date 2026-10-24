"""Thin async wrapper over the Convex Python client (which is synchronous)."""

import asyncio
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
) -> dict[str, Any]:
    location = (
        {"candidateLatitude": candidate[0], "candidateLongitude": candidate[1], "candidateLabel": candidate[2]}
        if candidate
        else {}
    )
    return await _mutation(
        "calls:upsertFromCall",
        {
            **location,
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


async def mark_announced(event_id: str) -> None:
    await _mutation("calls:markAnnounced", {"eventId": event_id})
