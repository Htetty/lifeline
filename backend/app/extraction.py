"""Claude turns a call transcript into incident facts plus a suggested next question."""

from typing import Literal

import anthropic
from pydantic import BaseModel, ConfigDict, Field

from .config import settings

client = anthropic.AsyncAnthropic()

SYSTEM_PROMPT = """\
You support a flood-rescue dispatcher during a simulated exercise. You read the
transcript of an emergency call and record what the caller has told you, so a human
dispatcher can review it and decide on a rescue.

Callers are frightened. They speak in fragments, exaggerate, use slang, mix up words,
contradict themselves and sometimes say the wrong thing. The transcript comes from
speech recognition, so words can be misheard ("Handle Ery Hotel" is the Handlery Hotel,
"Hotel Circle Nord" is Hotel Circle North). Work out what the caller MEANS, the way an
experienced call-taker would, rather than waiting for exact words. Always keep the
caller's own words as `evidence` so the dispatcher can check your reading.

How careful to be depends on what a mistake costs:
- Location and headcount send rescuers somewhere. Record what the caller conveyed,
  in their words, and fix obvious mishearings of place names, but don't make up an
  address, a number or a place they gave no basis for. Unknown stays null.
- Risk factors only set priority for a human to review. Missing a real danger is worse
  than flagging one the dispatcher can lower, so include a factor whenever the
  caller's words reasonably suggest it, even indirectly.

If the caller corrects themselves, use the latest version, and drop details that
belonged only to the location they took back (such as a landmark they gave for the
wrong street) unless they repeat them. Keep the caller's own wording for the location
(e.g. "the blue apartment building behind the gas station"); do not invent a street
address or coordinates.

`location_changed` is true only when the caller's most recent message changes or
takes back a location they gave earlier ("sorry, it's actually the north side").
Rewording, adding detail to the same place, or giving a location for the first time
is not a change.

`caller_role` is "trapped" when the caller is one of the people needing rescue,
"witness" when they are reporting other people from somewhere else (a neighbour,
someone outside or across the street), or "unknown". Location, people count and
position always describe the people needing rescue; for a witness that's the
building they are reporting, not where the witness is standing. "I'm across the
street from the Days Inn, people are on its roof" means the location is "the roof of
the Days Inn" and the search is the Days Inn.

Record the floor, room or unit in `reported_position` whenever given: several
families in one hotel or apartment block are separate rescues, and the floor/room
is how the dispatcher tells them apart. If the caller is in a multi-unit building
and hasn't said which floor or room, that is the next thing to ask after the count.

For each hazard, include the caller's words that support it as `evidence`.

`risk_factors` (each with the caller's words as `evidence`). These are what the words
mean, not keywords to match. For example "it's up to here", "I can't touch the floor",
"I'm swimming", "I'm drowning" or "we're going under" all mean water at chest height
or higher; "my dad's not answering me" may mean someone is unconscious; "the baby"
means a child:
- serious_injury: heavy bleeding, unconscious or unresponsive, not breathing, chest
  pain, broken bone, head injury
- medical_need: needs medication or equipment, a medical condition, minor injury,
  hypothermia or shivering badly
- water_chest_or_higher: water at their chest, shoulders, neck or above them, can't
  touch the ground, drowning, going under, or can't keep their head above water
- water_rising_fast: the water is coming up quickly, pouring in, or rising while they talk
- in_moving_water: a person is in or being carried by moving water, or swept away
- in_vehicle: they are in a car or other vehicle
- no_higher_ground: they can't get any higher (attic with no way out, top floor
  flooding, roof with water reaching it)
- on_roof: they are on a roof
- child / elderly / limited_mobility / pregnant: such a person is among them

`location_queries` are up to three map-search strings for where the people needing
rescue are, most specific first, each ending with ", San Diego, CA". The exercise
takes place in Mission Valley, San Diego. Prefer named places (a hotel, business,
school, transit center, apartment complex) and street addresses with a house number,
e.g. "Days Inn Hotel Circle, San Diego, CA". Correct obvious mishearings of names. If
the caller clearly describes a well-known place without naming it ("the huge outdoor
mall in Mission Valley"), you may search its name ("Fashion Valley Mall"): the result
is only a candidate the dispatcher confirms. Leave the list empty if they gave nothing
searchable. A search result is drawn as the building where people need rescue, so
only search for that building (for a witness: "a family on the roof of the Handlery"
means search the Handlery). Never search for a landmark it is near, next to, behind or
across from ("a house next to the Holiday Inn" gives no query); the dispatcher places
those by hand. These "near X" rules are about where the people needing rescue are,
not about where a witness is standing.

`caller_asked_status` is true when the caller's most recent message asks about
progress: whether anyone is coming, when, whether the dispatcher got their call,
"what's happening?", "are you sending someone?". The agent will then tell them the
confirmed status before asking anything else.

When <latest_caller_message> is given, it is the caller's most recent message (it may
span several short turns at the end of the transcript); use it wherever these
instructions say "most recent message" or "latest message".

`withdrawn` lists facts the caller's most recent message explicitly takes back without
giving a replacement, each with the caller's words as `evidence`:
- people_count: "I was wrong, I don't know how many of us there are". A new number
  ("not three, two") is a correction: put it in `people_count`, don't withdraw.
- hazard: "actually nobody is injured", "there's no water on the stairs after all".
  Use the hazard's exact name from <recorded_hazards> when it is there.
- risk_factor: the factor id, e.g. serious_injury or medical_need for "nobody is hurt".
Withdraw only what the caller denied; other facts stay. Something the caller simply
doesn't mention again is NOT withdrawn: leave `withdrawn` empty. Once a fact is
withdrawn, leave it out (people_count null, hazard or factor not listed) unless the
caller states it again later.

`next_question` is one short, calm question the call-taker can ask to fill the most
important gap, in this priority: exact location, number of people, where they are in
the building, injuries or medical needs, other hazards. Don't repeat a question the
caller has just answered or refused; move on or reassure briefly instead. Set it to
null when nothing important is missing. Never promise that help is coming or give
arrival times; only the dispatcher can confirm that.
"""


class HazardFact(BaseModel):
    hazard: str = Field(description="Short name of the hazard, e.g. 'Water rising on stairs'")
    evidence: str = Field(description="The caller's words supporting this hazard")


class RiskFact(BaseModel):
    factor: Literal[
        "serious_injury",
        "medical_need",
        "water_chest_or_higher",
        "water_rising_fast",
        "in_moving_water",
        "in_vehicle",
        "no_higher_ground",
        "on_roof",
        "child",
        "elderly",
        "limited_mobility",
        "pregnant",
    ]
    evidence: str = Field(description="The caller's words supporting this factor")


class Withdrawal(BaseModel):
    fact: Literal["people_count", "hazard", "risk_factor"]
    name: str | None = Field(
        description="Hazard name (as recorded) or risk factor id; null for people_count"
    )
    evidence: str = Field(description="The caller's words taking it back")


def _require_withdrawn(schema: dict) -> None:
    # Claude must always answer `withdrawn` (usually []); only old saved receipts lack it.
    schema["required"] = [*schema.get("required", []), "withdrawn"]


class Extraction(BaseModel):
    model_config = ConfigDict(json_schema_extra=_require_withdrawn)

    caller_role: Literal["trapped", "witness", "unknown"] = Field(
        description="Is the caller among the people needing rescue, or reporting others?"
    )
    reported_address: str | None = Field(
        description="Where the people needing rescue are, in the caller's words (for a witness: the building they see)"
    )
    people_count: int | None = Field(description="Number of people needing rescue, if stated")
    reported_position: str | None = Field(description="Where they are in the building: floor, roof, attic, vehicle")
    location_queries: list[str] = Field(description="Map-search strings for the current location, most specific first")
    location_changed: bool = Field(description="Caller's latest message changed or took back an earlier location")
    hazards: list[HazardFact]
    risk_factors: list[RiskFact]
    summary: str = Field(description="One sentence summarising only the stated facts")
    missing: list[str] = Field(description="Important facts still unknown")
    caller_asked_status: bool = Field(description="Caller's latest message asks whether help is coming / what's happening")
    # Explicit retractions only. Omitted facts are not withdrawn. Defaults to empty so
    # receipts saved before this field existed still load.
    withdrawn: list[Withdrawal] = Field(
        default_factory=list, description="Facts the caller's latest message explicitly takes back"
    )
    next_question: str | None


class ExtractionUnavailable(Exception):
    """Claude could not produce an extraction (refusal or invalid output)."""


async def extract_incident(
    transcript: str, recorded_hazards: list[str] | None = None, latest_message: str | None = None
) -> Extraction:
    content = f"<transcript>\n{transcript}\n</transcript>"
    if latest_message:
        # Several short caller turns saved since the last extraction: together they are the
        # "most recent message" (so a correction or withdrawal in any of them still counts).
        content += f"\n<latest_caller_message>\n{latest_message}\n</latest_caller_message>"
    if recorded_hazards:
        # So a withdrawal can name the stored hazard exactly.
        content += "\n<recorded_hazards>\n" + "\n".join(recorded_hazards) + "\n</recorded_hazards>"
    response = await client.messages.parse(
        model=settings.claude_model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        output_config={"effort": settings.extraction_effort},
        messages=[{"role": "user", "content": content}],
        output_format=Extraction,
        # If a safety classifier declines, re-run on Anthropic's recommended fallback model.
        extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise ExtractionUnavailable(f"stop_reason={response.stop_reason}")
    return response.parsed_output
