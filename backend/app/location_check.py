"""Caller location confirmation: read the location back, accept only an explicit yes to it.

After the caller gives a location the agent says "I have <location>. Is that correct?".
The location counts as caller-confirmed only when the caller's next words, straight after
that read-back was actually spoken, are an explicit yes and change nothing. Silence,
hedges, a yes to any other question, or a yes to a read-back the caller never heard do
not count. Convex re-checks every confirmation against the saved transcript and keeps
a confirmed location from being silently replaced (dashboard/convex/callerLocation.ts).

This is separate from the map search (geocode.py) and from the dispatcher's own check of
the pin (`locationVerified`). Questions here are capped, so an unconfirmed location never
holds up the rest of the call.
"""

import re
from dataclasses import dataclass
from typing import Literal

from .extraction import Extraction
from .geocode import Candidate

# How many times the same location is read back before the call moves on unconfirmed.
MAX_READBACKS = 2
ASK = "Is that correct?"
CORRECT_ADDRESS = "Sorry about that. What is the correct address, with the city and any apartment number?"

_FILLER = re.compile(r"^(?:(?:um+|uh+|er+|erm|oh|ah|ok(?:ay)?|so|well)\b[\s,.!-]*)+", re.I)
_YES = re.compile(
    r"^(?:yes|yeah|yep|yup|yea|correct|right|exactly|affirmative|that's (?:right|correct|it)|that is (?:right|correct)"
    r"|it is|you got it)\b",
    re.I,
)
_NO = re.compile(r"^(?:no|nope|nah|wrong|incorrect|not (?:quite|right|correct)|that's (?:wrong|not right|incorrect))\b", re.I)
# Anything that takes back or hedges the yes makes the answer unclear.
_DOUBT = re.compile(
    r"\b(?:no|nope|wrong|incorrect|actually|wait|but|except|instead|sorry|maybe|perhaps|probably|guess|think|"
    r"not (?:sure|quite|right|correct|exactly|that)|isn't|it's not)\b",
    re.I,
)


def same(a: str, b: str) -> bool:
    """Same place, ignoring case, spacing and punctuation (same as sameLocation in Convex)."""
    norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[.,]", " ", s.lower())).strip()  # noqa: E731
    return norm(a) == norm(b)


def compose(address: str | None, unit: str | None, city: str | None) -> str | None:
    """The full location as the caller gave it: place, then unit and city if they said them."""
    if not address or not address.strip():
        return None
    location = address.strip().rstrip(".")
    for detail in (unit, city):
        if detail and detail.strip() and detail.strip().lower() not in location.lower():
            location += f", {detail.strip()}"
    return location


def readback(location: str) -> str:
    """Exact words; Convex looks for them in the transcript (readBack in callerLocation.ts)."""
    return f"I have {location}. {ASK}"


def reply_to(lines: list[str], question: str) -> str | None:
    """The caller's words straight after `question`, if it is the last thing the agent said."""
    reply: list[str] = []
    for line in reversed(lines):
        if line.startswith("Caller: "):
            reply.insert(0, line[len("Caller: "):])
            continue
        return "\n".join(reply) if reply and line.startswith("Agent: ") and line.endswith(question) else None
    return None


def answer(reply: str) -> Literal["yes", "no", "unclear"]:
    """Only a plain yes is a yes. A hedge, a question or a yes-but is unclear."""
    text = _FILLER.sub("", reply.strip()).strip()
    if _YES.match(text) and not _DOUBT.search(text) and "?" not in text:
        return "yes"
    if _NO.match(text):
        return "no"
    return "unclear"


def _asked(lines: list[str], question: str) -> int:
    return sum(1 for line in lines if line.startswith("Agent: ") and line.endswith(question))


def _missing_question(location: str, missing: list[str]) -> str | None:
    asks = {"city": "What city is that in", "unit": "what's the apartment or unit number"}
    parts = [asks[m] for m in ("city", "unit") if m in missing]
    if not parts:
        return None
    question = ", and ".join(parts)
    return f"I have {location}. {question[0].upper()}{question[1:]}?"


def _map_question(location: str, match: Candidate, city: str | None) -> str:
    if match.issue == "ambiguous":
        return f"I found more than one place matching {location}. What street is it on, or what's a nearby cross street?"
    where = f" in {city}" if city else ""
    return f"I couldn't match {location}{where} on the map. Can you give me a nearby cross street or landmark?"


@dataclass
class LocationTurn:
    # Location to save for this turn (the read-back form), or None to keep what's saved.
    location: str | None
    # {"location", "evidence"} when the caller just confirmed it; Convex re-checks it.
    confirmation: dict | None
    # Asked instead of the extractor's next question.
    question: str | None
    confirmed: bool


def plan(
    stored: dict | None, extraction: Extraction | None, lines: list[str], match: Candidate | None
) -> LocationTurn:
    """What this caller turn means for the location, and what to ask about it next.

    `stored` is the saved state before this turn (Convex calls:callerLocationForCall);
    `lines` is the transcript including this turn.
    """
    stored = stored or {}
    confirmed_at = stored.get("address") if stored.get("status") == "confirmed" else None
    # The location waiting for the caller's yes, if any.
    awaiting = stored.get("pending") if confirmed_at else stored.get("address")
    before = awaiting or confirmed_at
    new = compose(extraction.reported_address, extraction.location_unit, extraction.location_city) if extraction else None
    if new and before and same(new, before):
        new = before  # a rewording: keep the words already read back

    reply = reply_to(lines, readback(awaiting)) if awaiting else None
    said = answer(reply) if reply is not None else None
    confirm = said == "yes" and new in (None, awaiting)
    location = awaiting if confirm else (new or before)
    confirmed = confirm or bool(confirmed_at and location and same(location, confirmed_at))

    question = None
    city = extraction.location_city if extraction else None
    map_question = _map_question(location, match, city) if location and match and match.issue else None
    if location and not confirmed:
        if said == "no" and new in (None, awaiting) and _asked(lines, CORRECT_ADDRESS) < MAX_READBACKS:
            question = CORRECT_ADDRESS
        else:
            # Missing details and map problems first (each asked once), so the read-back is complete.
            missing = _missing_question(location, extraction.location_missing) if extraction else None
            once = [q for q in (missing, map_question) if q and not _asked(lines, q)]
            if once:
                question = once[0]
            elif _asked(lines, readback(location)) < MAX_READBACKS:
                question = readback(location)
    elif location and map_question and not _asked(lines, map_question):
        # Confirmed by the caller, but the map disagrees or can't tell which place.
        question = map_question
    return LocationTurn(
        location=location,
        confirmation={"location": awaiting, "evidence": reply} if confirm else None,
        question=question,
        confirmed=confirmed,
    )
