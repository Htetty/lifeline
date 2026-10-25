"""Find candidate coordinates for a caller's location with OpenStreetMap Nominatim.

Only matches that are a specific building or named place (a hotel, shop, business,
house address) are used. A street or a large area would put the pin on an
arbitrary building, so those are left for the dispatcher to place. Candidates are
never treated as verified, and never as the caller confirming their location.

A search that can't stand for one place the caller described is reported, not pinned:
several matches far apart, or a match in another city or at another house number
than the caller gave. The agent then asks the caller to clarify.

Nominatim's usage policy: at most 1 request per second and an identifying
User-Agent. Fine for a demo; switch to a commercial geocoder for real traffic.
"""

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass
from typing import Literal

import httpx

log = logging.getLogger("flood-backend.geocode")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "lifeline-flood-dispatcher-hackathon/0.1"
# Demo area (Mission Valley, San Diego): west, north, east, south.
VIEWBOX = "-117.185,32.776,-117.135,32.752"

# OSM categories that point at a specific building or venue.
PLACE_CATEGORIES = {"building", "tourism", "amenity", "shop", "office", "healthcare", "craft", "leisure", "man_made"}
# Named stops and stations are precise points too, even though OSM files some under
# "highway"/"railway". Roads in those categories (primary, residential, ...) stay rejected.
POINT_TYPES = {
    "highway": {"bus_stop", "platform"},
    "railway": {"station", "halt", "tram_stop", "platform", "stop"},
    "public_transport": {"station", "platform", "stop_position", "stop_area"},
    "place": {"house"},
}
# Precise matches further apart than this are different places, not one building's OSM parts.
AMBIGUOUS_METERS = 200


def _is_precise(hit: dict) -> bool:
    category, kind = hit.get("category"), hit.get("type")
    return category in PLACE_CATEGORIES or kind in POINT_TYPES.get(category, set())


@dataclass(frozen=True)
class Candidate:
    latitude: float
    longitude: float
    label: str
    query: str
    # Set when this match can't be used as the caller's location; it is then never pinned.
    issue: Literal["ambiguous", "conflict"] | None = None
    # For the dispatcher, e.g. "2 map matches far apart: Starbucks, Starbucks".
    note: str | None = None


_lock = asyncio.Lock()
_last_request = 0.0
_cache: dict[str, list[dict]] = {}


async def _search(http: httpx.AsyncClient, query: str) -> list[dict]:
    """Precise hits for the query (cached)."""
    global _last_request
    if query in _cache:
        return _cache[query]
    async with _lock:
        wait = 1.0 - (time.monotonic() - _last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request = time.monotonic()
        r = await http.get(
            NOMINATIM_URL,
            params={"q": query, "format": "jsonv2", "limit": 5, "viewbox": VIEWBOX, "bounded": 1, "addressdetails": 1},
        )
    r.raise_for_status()
    _cache[query] = [hit for hit in r.json() if _is_precise(hit)]
    return _cache[query]


def _label(hit: dict) -> str:
    return (hit.get("display_name") or "").split(",")[0] or hit.get("name") or "map match"


def _meters(a: dict, b: dict) -> float:
    lat = math.radians((float(a["lat"]) + float(b["lat"])) / 2)
    dy = (float(a["lat"]) - float(b["lat"])) * 111_320
    dx = (float(a["lon"]) - float(b["lon"])) * 111_320 * math.cos(lat)
    return math.hypot(dx, dy)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[.,]", " ", text.lower())).strip()


def _conflict(hit: dict, city: str | None, house_number: str | None) -> str | None:
    """Why this hit isn't the place the caller described, if it clearly isn't."""
    if city and _norm(city) not in _norm(hit.get("display_name") or ""):
        return f"Map match {_label(hit)} is not in {city}"
    found = (hit.get("address") or {}).get("house_number")
    if house_number and found and found != house_number:
        return f"Map match {_label(hit)} is number {found}, not {house_number}"
    return None


def _pick(hits: list[dict], query: str, city: str | None, house_number: str | None) -> Candidate:
    def candidate(hit: dict, **issue) -> Candidate:
        return Candidate(float(hit["lat"]), float(hit["lon"]), _label(hit), query, **issue)

    fitting = [hit for hit in hits if not _conflict(hit, city, house_number)]
    if not fitting:
        return candidate(hits[0], issue="conflict", note=_conflict(hits[0], city, house_number))
    far = [hit for hit in fitting[1:] if _meters(fitting[0], hit) > AMBIGUOUS_METERS]
    if far:
        names = ", ".join(_label(hit) for hit in [fitting[0], *far])
        return candidate(fitting[0], issue="ambiguous", note=f"{1 + len(far)} map matches far apart: {names}")
    return candidate(fitting[0])


async def find_candidate(queries: list[str], city: str | None = None, location: str | None = None) -> Candidate | None:
    """Search the queries, most specific first; the first one with any precise hit decides.

    `city` and `location` are what the caller said; a match that contradicts them, or
    several far-apart matches, comes back with an `issue` instead of being chosen.
    Returns None if nothing precise matched.
    """
    if not queries:
        return None
    number = re.match(r"\s*(\d+)\b", location or "")
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": USER_AGENT}) as http:
            for query in queries[:3]:
                hits = await _search(http, query)
                if hits:
                    return _pick(hits, query, city, number and number.group(1))
    except Exception:  # map search is best-effort and must never block saving a report
        log.exception("geocoding failed for %r", queries)
    return None
