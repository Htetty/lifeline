"""Find candidate coordinates for a caller's location with OpenStreetMap Nominatim.

Only matches that are a specific building or named place (a hotel, shop, business,
house address) are used. A street or a large area would put the pin on an
arbitrary building, so those are left for the dispatcher to place. Candidates are
never treated as verified.

Nominatim's usage policy: at most 1 request per second and an identifying
User-Agent. Fine for a demo; switch to a commercial geocoder for real traffic.
"""

import asyncio
import logging
import time
from dataclasses import dataclass

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


def _is_precise(hit: dict) -> bool:
    category, kind = hit.get("category"), hit.get("type")
    return category in PLACE_CATEGORIES or kind in POINT_TYPES.get(category, set())


@dataclass(frozen=True)
class Candidate:
    latitude: float
    longitude: float
    label: str
    query: str


_lock = asyncio.Lock()
_last_request = 0.0
_cache: dict[str, Candidate | None] = {}


async def _search(http: httpx.AsyncClient, query: str) -> Candidate | None:
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
            params={"q": query, "format": "jsonv2", "limit": 5, "viewbox": VIEWBOX, "bounded": 1},
        )
    r.raise_for_status()
    match = next((hit for hit in r.json() if _is_precise(hit)), None)
    result = (
        Candidate(float(match["lat"]), float(match["lon"]), match.get("display_name", query).split(",")[0], query)
        if match
        else None
    )
    _cache[query] = result
    return result


async def find_candidate(queries: list[str]) -> Candidate | None:
    """Try each search query, most specific first. Returns None if nothing precise matched."""
    if not queries:
        return None
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": USER_AGENT}) as http:
            for query in queries[:3]:
                candidate = await _search(http, query)
                if candidate:
                    return candidate
    except Exception:  # map search is best-effort and must never block saving a report
        log.exception("geocoding failed for %r", queries)
    return None
