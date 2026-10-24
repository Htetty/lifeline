"""Claude turns a call transcript into incident facts plus a suggested next question."""

import anthropic
from pydantic import BaseModel, Field

from .config import settings

client = anthropic.AsyncAnthropic()

SYSTEM_PROMPT = """\
You support a flood-rescue dispatcher during a simulated exercise. You read the
transcript of an emergency call and record what the caller has said, so a human
dispatcher can review it and decide on a rescue.

Record only what the caller actually stated. If a fact has not been mentioned,
leave it null or empty: an unknown is much safer than a guess, because a wrong
address or headcount sends rescuers to the wrong place. If the caller corrects
themselves, use the latest version, and drop details that belonged only to the
location they took back (such as a landmark they gave for the wrong street) unless
they repeat them. Keep the caller's own wording for the location
(e.g. "the blue apartment building behind the gas station"); do not invent a
street address or coordinates.

`location_changed` is true only when the caller's most recent message changes or
takes back a location they gave earlier ("sorry, it's actually the north side").
Rewording, adding detail to the same place, or giving a location for the first time
is not a change.

For each hazard, include the caller's words that support it as `evidence`.

`location_queries` are up to three map-search strings for the caller's current
location, most specific first, each ending with ", San Diego, CA". The exercise
takes place in Mission Valley, San Diego. Prefer named places the caller mentioned
(a hotel, business, school, apartment complex) and street addresses with a house
number, e.g. "Days Inn Hotel Circle, San Diego, CA". Use only names and streets the
caller actually said; leave the list empty if they gave nothing searchable.
A search result is drawn as the caller's own building, so only search for the place
the caller is IN. Never search for a landmark they are near, next to, behind or
across from ("a house next to the Holiday Inn" gives no query); the dispatcher
places those by hand.

`next_question` is one short, calm question the call-taker can ask to fill the most
important gap, in this priority: exact location, number of people, where they are in
the building, injuries or medical needs, other hazards. Set it to null when nothing
important is missing. Never promise that help is coming or give arrival times; only
the dispatcher can confirm that.
"""


class HazardFact(BaseModel):
    hazard: str = Field(description="Short name of the hazard, e.g. 'Water rising on stairs'")
    evidence: str = Field(description="The caller's words supporting this hazard")


class Extraction(BaseModel):
    reported_address: str | None = Field(description="Caller's description of where they are, in their words")
    people_count: int | None = Field(description="Number of people needing rescue, if stated")
    reported_position: str | None = Field(description="Where they are in the building: floor, roof, attic, vehicle")
    location_queries: list[str] = Field(description="Map-search strings for the current location, most specific first")
    location_changed: bool = Field(description="Caller's latest message changed or took back an earlier location")
    hazards: list[HazardFact]
    summary: str = Field(description="One sentence summarising only the stated facts")
    missing: list[str] = Field(description="Important facts still unknown")
    next_question: str | None


class ExtractionUnavailable(Exception):
    """Claude could not produce an extraction (refusal or invalid output)."""


async def extract_incident(transcript: str) -> Extraction:
    response = await client.messages.parse(
        model=settings.claude_model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        output_config={"effort": settings.extraction_effort},
        messages=[{"role": "user", "content": f"<transcript>\n{transcript}\n</transcript>"}],
        output_format=Extraction,
        # If a safety classifier declines, re-run on Anthropic's recommended fallback model.
        extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise ExtractionUnavailable(f"stop_reason={response.stop_reason}")
    return response.parsed_output
