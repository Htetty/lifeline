"""Async wrapper over the Convex Python client: calls run in a thread, subscriptions are awaited."""

import asyncio
from collections.abc import AsyncIterator
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


async def call_state(call_id: str) -> dict[str, Any]:
    return await _query("calls:callState", {"callId": call_id})


async def transcript_for_call(call_id: str) -> str | None:
    return await _query("calls:transcriptForCall", {"callId": call_id})


async def mark_announced(call_id: str, event_id: str) -> None:
    await _mutation("calls:markAnnounced", {"callId": call_id, "eventId": event_id})


async def subscribe_call_state(call_id: str) -> AsyncIterator[dict[str, Any]]:
    """Yield the call's state from Convex every time it changes (pushed, not polled)."""
    subscription = _client.subscribe("calls:callState", {"secret": settings.backend_secret, "callId": call_id})
    try:
        async for snapshot in subscription:
            yield snapshot
    finally:
        subscription.unsubscribe()
