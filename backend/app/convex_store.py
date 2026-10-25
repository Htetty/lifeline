"""Async wrapper over the Convex Python client: calls run in a thread, subscriptions are awaited."""

import asyncio
import time
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
    caller_role: str | None = None,
    risk_factors: list[dict[str, str]] | None = None,
    water_report: dict[str, Any] | None = None,
    withdrawn: list[dict[str, str | None]] | None = None,
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
            **({"callerRole": caller_role} if caller_role else {}),
            **({"riskFactors": risk_factors} if risk_factors else {}),
            **({"waterReport": _water_report(water_report)} if water_report else {}),
            # Sent only when the caller took something back, so ordinary turns keep the old arguments.
            **({"withdrawn": withdrawn} if withdrawn else {}),
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


def _water_report(report: dict[str, Any]) -> dict[str, Any]:
    # Convex numbers are floats on the wire.
    def num(value: float | int | None) -> float | None:
        return float(value) if value is not None else None

    return {
        "level": report["level"],
        "measuredMeters": num(report.get("measured_meters")),
        "floor": num(report.get("floor")),
        "evidence": report.get("evidence"),
    }


async def check_dispatcher(token: str | None) -> None:
    """Raises ConvexError unless `token` is the dispatcher passcode (or none is configured)."""
    await asyncio.to_thread(_client.query, "exercise:get", {"dispatcherToken": token} if token else {})


async def exercise_area() -> dict[str, float]:
    """Bounds of the exercise's region: west, south, east, north."""
    return await _query("calls:exerciseArea", {})


async def call_ended(call_id: str) -> None:
    await _mutation("calls:callEnded", {"callId": call_id})


async def location_from_phone(call_id: str, request_id: str, location: dict) -> dict:
    """Use a confirmed Photon fix as this call's ordinary incident map candidate."""
    return await _mutation("calls:locationFromPhone", {
        "callId": call_id, "requestId": request_id,
        "latitude": float(location["latitude"]), "longitude": float(location["longitude"]),
        "accuracyMeters": float(location["accuracyMeters"]), "capturedAt": location["capturedAt"],
    })


# Internal bookkeeping, never spoken: a saved report isn't a dispatcher action. Convex still
# queues it on a new incident; filtering here also covers events already in the database.
INTERNAL_UPDATES = {"details_received"}


async def call_state(call_id: str) -> dict[str, Any]:
    """Status card plus updates still worth speaking (what the voice stream pushes)."""
    return _speakable(await _query("calls:callState", {"callId": call_id}))


def _speakable(state):
    if isinstance(state, dict) and isinstance(state.get("pending"), list):
        state = {**state, "pending": [e for e in state["pending"] if e.get("type") not in INTERNAL_UPDATES]}
    return state


async def status_for_call(call_id: str) -> dict[str, Any] | None:
    return await _query("calls:statusForCall", {"callId": call_id})


async def pending_events(call_id: str) -> list[dict[str, Any]]:
    """Current, unspoken updates to speak (empty after hang-up), without internal bookkeeping."""
    events = await _query("calls:pendingEvents", {"callId": call_id})
    return [e for e in events if e.get("type") not in INTERNAL_UPDATES]


async def recorded_hazards(call_id: str) -> list[str]:
    return await _query("calls:recordedHazards", {"callId": call_id})


async def current_announcement(call_id: str, event_id: str | None = None) -> dict[str, Any] | None:
    """A still-true update to replay on request: that event, or the latest status update."""
    return await _query("calls:currentAnnouncement", {"callId": call_id, **({"eventId": event_id} if event_id else {})})


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


async def subscribe_call_state(call_id: str) -> AsyncIterator[dict[str, Any]]:
    """Yield the call's state from Convex every time it changes (pushed, not polled)."""
    subscription = _client.subscribe("calls:callState", {"secret": settings.backend_secret, "callId": call_id})
    try:
        async for snapshot in subscription:
            yield _speakable(snapshot)
    finally:
        subscription.unsubscribe()
