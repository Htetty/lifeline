"""Photon location sharing for one phone call.

The backend decides when to offer a location link and Cartesia speaks it; the Photon
process (integrations/photon) sends the card and receives the caller's confirmation.
The recipient is only ever the caller's number from the signed Twilio webhook, and
request IDs are generated here, never by the model. The model only reports what the
caller said (location clarity, whether they are with the people needing help, their
answer to the consent question).

Terminal-only: a confirmed location is given to this call's conversation and logged.
It is never written to the incident, moved on the map, or treated as verified.
"""

import asyncio
import contextlib
import ipaddress
import logging
import math
import re
import time
import uuid
from urllib.parse import urlsplit

import httpx

from .voice_provider import voice_environment

log = logging.getLogger("location-share")

SAME_PLACE = "Are you at the same location as the people who need help?"
CONSENT = "Can I send you a link in Messages to share your current location?"
INSTRUCTIONS = "Open the map, allow location access, and tap Confirm if the blue dot shows where you are."
RECEIVED = "I've received the location you shared."
ASK_VERBALLY = "Can you tell me the address, or a landmark near you?"
FAILED = "I couldn't send the link. " + ASK_VERBALLY
UNCONFIRMED = "I can't confirm the link has been sent yet. While we wait, can you tell me the address, or a landmark near you?"
EXPIRED = "That link has expired. " + ASK_VERBALLY
UNAVAILABLE = "I can't send a link to this phone. " + ASK_VERBALLY
NOT_REACHABLE = "I can't reach this phone by iMessage right now, so I haven't sent the link. " + ASK_VERBALLY

PHONE = re.compile(r"\+[1-9]\d{6,14}")
NEEDS_LINK = {"unknown_to_caller", "vague", "contradictory"}
PENDING = {"creating", "sending"}  # nothing the caller can open yet
ACTIVE = PENDING | {"accepted", "sent", "delivered"}
# unavailable: Photon found the number isn't reachable by iMessage, so nothing was sent.
STATUSES = ACTIVE | {"failed", "unavailable", "expired", "cancelled", "confirmed"}
MAX_OFFERS = 2  # unprompted; an explicit caller request can always be offered
MAX_REQUESTS = 3
UNCONFIRMED_AFTER_S = 20
# How long the acknowledgement may wait for its written continuation before it is said alone.
CONTINUE_WAIT_S = 6.0
REFRESH_S = 1.0


class PhotonBridge:
    """Authenticated client for the Photon process's loopback control API."""

    def __init__(self, url: str, token: str):
        self.url, self.token = url.rstrip("/"), token

    @classmethod
    def from_env(cls) -> "PhotonBridge | None":
        env = voice_environment()
        token = env.get("PHOTON_BRIDGE_TOKEN", "")
        if len(token) < 32:
            return None  # location sharing is off; calls behave exactly as before
        url = env.get("PHOTON_CONTROL_URL") or "http://127.0.0.1:8092"
        parts = urlsplit(url)
        try:
            loopback = parts.scheme == "http" and ipaddress.ip_address(parts.hostname or "").is_loopback
        except ValueError:
            loopback = False
        if not loopback or parts.path not in ("", "/"):
            log.warning("PHOTON_CONTROL_URL must be a loopback http origin; location sharing is off")
            return None
        return cls(url, token)

    async def post(self, path: str, body: dict) -> tuple[int, dict]:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.post(self.url + path, json=body, headers={"Authorization": f"Bearer {self.token}"})
        try:
            data = response.json()
        except ValueError:
            data = {}
        return response.status_code, data if isinstance(data, dict) else {}


class LocationShare:
    def __init__(self, call_id: str, recipient: str | None, bridge: PhotonBridge, clock=time.monotonic):
        self.call_id, self.bridge, self.clock = call_id, bridge, clock
        self.recipient = recipient if recipient and PHONE.fullmatch(recipient) else None
        self.eligible: bool | None = None
        self.same_place_asks = 0  # chosen; at most two, and none once it was heard in full
        self.same_place_heard = False
        self.awaiting_answer = False  # the consent question was spoken in full
        self.offers = 0
        self.declined = False
        self.unavailable_said = False
        self.request: dict | None = None
        self.requests = 0
        self.location: dict | None = None
        self.at_location = "unknown"
        # Changes whenever what the agent may truthfully say about the link changes; a reply
        # written against an older version is not spoken.
        self.version = 0
        self.ack_in_state = False  # the latest state() asked the reply to say the location arrived
        self.ack_reply: str | None = None  # that reply: once heard in full, the separate ack is dropped
        # Continuation for a location that arrived between caller turns: None, "wanted",
        # "writing" (with a deadline), "ready" or "plain".
        self.continuation: str | None = None
        self.continuation_deadline = 0.0
        self.outbox: list[tuple[str, str]] = []  # (kind, text), each said once
        self.tasks: set[asyncio.Task] = set()
        self.refreshing: asyncio.Task | None = None
        self.last_refresh = 0.0
        self.closed = False

    @classmethod
    def for_call(cls, call_id: str, recipient: str | None) -> "LocationShare | None":
        bridge = PhotonBridge.from_env()
        return cls(call_id, recipient, bridge) if bridge else None

    # Lifecycle ------------------------------------------------------------------

    def start(self):
        if self.recipient and self.eligible is None:
            self._spawn(self._check_eligibility())

    async def close(self):
        """The call ended: withdraw any open request so a late confirmation is refused."""
        self.closed = True
        self.outbox.clear()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.request and self.request["status"] in ACTIVE:
            await self._cancel(self.request["id"])
            self.request["status"] = "cancelled"

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def _check_eligibility(self):
        try:
            code, body = await self.bridge.post("/eligibility", {"recipient": self.recipient})
        except Exception as exc:
            log.warning("call %s: Photon is unreachable for location sharing (%s)", self.call_id, type(exc).__name__)
            return  # stays unknown; checked again when a link is needed
        if code == 401:
            log.warning("call %s: Photon refused PHOTON_BRIDGE_TOKEN; location sharing is off for this call", self.call_id)
        if code == 503:
            return  # iMessage reachability couldn't be checked; stays unknown and is checked again
        self.eligible = code == 200 and body.get("eligible") is True
        log.info("call %s: location link %s for this caller", self.call_id, "available" if self.eligible else "not available")

    # Decisions after each extracted caller turn ------------------------------------

    def available(self) -> bool:
        return bool(self.recipient) and self.eligible is True and not self.closed

    def after_turn(self, extraction, question: str | None) -> str | None:
        """What to say after this caller turn: the intake question or a location prompt."""
        if extraction is None or self.closed:
            return question
        self.at_location = extraction.caller_at_rescue_location
        if self.ack_in_state and question:
            self.ack_reply = question
        status = self.request["status"] if self.request else None
        answer = extraction.location_link_answer if self.awaiting_answer else None
        self.awaiting_answer = False
        if answer == "yes":
            # Consent covers one send, only to someone with the people needing help.
            if self.at_location == "yes" and self.available() and status not in PENDING and self.requests < MAX_REQUESTS:
                self._start_request()
            return question
        if answer == "no":
            self.declined = True
            return question
        asked = extraction.wants_location_link
        if not (asked or extraction.location_status in NEEDS_LINK) or self.at_location == "no":
            return question  # a clear address, or a witness: their phone isn't the rescue location
        if (self.declined or self.location or status in ACTIVE) and not asked:
            return question  # don't push the link again
        if status in PENDING:
            return question
        if not self.available():
            if self.recipient and self.eligible is None:
                self.start()  # Photon was unreachable; check again for next time
            if asked and not self.unavailable_said:
                self.unavailable_said = True
                return UNAVAILABLE
            return question
        if self.at_location != "yes":
            if self.same_place_heard or self.same_place_asks >= 2:
                return question
            self.same_place_asks += 1
            return SAME_PLACE
        if self.requests >= MAX_REQUESTS or (self.offers >= MAX_OFFERS and not asked):
            return question
        self.offers += 1
        return CONSENT

    def state(self, track: bool = True) -> str:
        """What the agent may truthfully say about the link and the shared location, for this
        call's extraction only. Built from Photon's reported status, never from the caller's
        claims ("I confirmed it" is not a confirmation)."""
        request = self.request
        status = request["status"] if request else None
        lines = []
        if self.closed or not self.recipient or self.eligible is False:
            lines.append("Location link: not available on this call; no link can be sent to this phone.")
        elif self.eligible is None:
            lines.append("Location link: not available right now; no link has been sent.")
        elif status in {"creating", "sending", "cancelled"}:
            lines.append("Location link: the caller agreed and it is being sent. It has not been confirmed as "
                         "sent yet; don't say it was sent.")
        elif status == "accepted":
            lines.append("Location link: handed to the messaging service, but not yet confirmed as sent.")
        elif status in {"sent", "delivered"}:
            lines.append(f"Location link: {'delivered' if status == 'delivered' else 'sent'} to the caller's phone. "
                         "No location has been received from it yet: the caller needs to open it, allow location "
                         "access and tap Confirm.")
        elif status == "failed":
            lines.append("Location link: sending failed; nothing was sent.")
        elif status == "unavailable":
            lines.append("Location link: this phone can't be reached by iMessage; nothing was sent.")
        elif status == "expired":
            lines.append("Location link: it expired before a location was received.")
        elif self.awaiting_answer:
            lines.append("Location link: the agent just asked permission to send it; the system acts on the "
                         "caller's answer. If they agree, acknowledge briefly without saying it was sent.")
        elif self.requests >= MAX_REQUESTS:
            lines.append("Location link: the limit for this call has been reached; no more links can be sent.")
        elif status != "confirmed":
            lines.append("Location link: can be offered; the system asks the caller's permission itself."
                         + (" The caller declined it earlier." if self.declined else ""))
        untold = bool(self.location) and any(kind == "received" for kind, _ in self.outbox)
        if track:
            self.ack_in_state = untold
        if self.location:
            loc = self.location
            lines.append(
                f"Shared location: received from the caller's phone (they opened the link and tapped Confirm). "
                f"A GPS point with reported accuracy of about {loc['accuracyMeters']:.0f} metres "
                f"({loc['accuracyMeters'] * 3.28084:.0f} feet), captured {loc['capturedAt']}; latitude "
                f"{loc['latitude']:.6f}, longitude {loc['longitude']:.6f}. No street address or place name is "
                f"known for this point. It isn't shown to or verified by the dispatcher.")
            if self.at_location == "no":
                lines.append("The caller now says they aren't with the people needing help, so this point is "
                             "not the rescue location.")
            if untold:
                lines.append("The caller hasn't been told it arrived yet: start the reply by saying you've "
                             "received the location they shared.")
        return "\n".join(lines)

    async def refresh_now(self, timeout=1.0):
        """Before writing a reply: pick up a confirmation that already reached Photon."""
        request = self.request
        if self.closed or not request or request["status"] not in ACTIVE - {"creating"}:
            return
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._refresh(request["id"]), timeout)

    # Speech ----------------------------------------------------------------------------

    def next_line(self) -> str | None:
        if self.closed or not self.outbox:
            return None
        kind, text = self.outbox[0]
        if kind == "received" and self.continuation in {"wanted", "writing"}:
            if self.clock() < self.continuation_deadline:
                return None  # the continuation is still being written from the current state
            self.continuation = "plain"  # too late now: a continuation arriving later is discarded
        return text

    def wants_continuation(self) -> bool:
        """A received location waiting at the head of the queue with no continuation started."""
        return (not self.closed and self.continuation == "wanted"
                and bool(self.outbox) and self.outbox[0][0] == "received")

    def writing_continuation(self):
        self.continuation = "writing"
        return self.version

    def continued(self, text: str | None, version: int, still_quiet: bool):
        """The written acknowledgement + next question. Used only if nothing changed while it
        was written; otherwise the plain acknowledgement stands (the caller's own turn, if
        any, acknowledges it from fresh state instead)."""
        head = self.outbox[0] if self.outbox else None
        if (text and still_quiet and self.continuation == "writing" and version == self.version
                and head and head[0] == "received"):
            self.outbox[0] = ("received", text)
            self.continuation = "ready"
        elif self.continuation == "writing":
            self.continuation = "plain"

    def spoken(self, text: str):
        """A reply played to completion (never an interrupted one)."""
        if text == CONSENT:
            self.awaiting_answer = True
        elif text == SAME_PLACE:
            self.same_place_heard = True
        if self.ack_reply and text == self.ack_reply:
            # The caller heard the reply that told them it arrived; don't say it again.
            self.ack_reply = None
            self._unsay("received")
            self.continuation = None
        if self.outbox and self.outbox[0][1] == text:
            if self.outbox[0][0] == "received":
                self.continuation = None
            self.outbox.pop(0)

    def _say(self, kind, text):
        if all(k != kind for k, _ in self.outbox):
            self.outbox.append((kind, text))

    def _unsay(self, *kinds):
        self.outbox = [entry for entry in self.outbox if entry[0] not in kinds]

    # Requests ----------------------------------------------------------------------------

    def _start_request(self):
        previous = self.request
        request_id = uuid.uuid4().hex
        self.request = {"id": request_id, "status": "creating", "since": self.clock(), "said": set()}
        self.requests += 1
        self.version += 1
        self._unsay("instructions", "unconfirmed", "failed", "expired")
        self._spawn(self._create(request_id, previous))

    async def _create(self, request_id, previous):
        if previous and previous["status"] in ACTIVE:
            await self._cancel(previous["id"])  # a resend replaces the old link
            previous["status"] = "cancelled"
        try:
            code, body = await self.bridge.post("/requests", {
                "requestId": request_id, "callId": self.call_id, "recipient": self.recipient})
        except Exception as exc:
            code, body = 0, {"error": type(exc).__name__}
        if code not in (200, 201):
            log.warning("call %s: location request %s not created (%s)", self.call_id, request_id, body.get("error", code))
            body = {"requestId": request_id, "callId": self.call_id, "status": "failed"}
        self.apply(body)

    async def _cancel(self, request_id):
        try:
            await self.bridge.post(f"/requests/{request_id}/cancel", {"callId": self.call_id})
        except Exception as exc:
            log.warning("call %s: couldn't withdraw location request %s (%s)", self.call_id, request_id, type(exc).__name__)

    def tick(self):
        """From the voice poll loop: refresh the open request's status without blocking speech."""
        request = self.request
        if self.closed or not request or request["status"] not in ACTIVE - {"creating"}:
            return
        now = self.clock()
        if request["status"] in {"sending", "accepted"} and now - request["since"] >= UNCONFIRMED_AFTER_S and "unconfirmed" not in request["said"]:
            request["said"].add("unconfirmed")
            self._say("unconfirmed", UNCONFIRMED)
        if now - self.last_refresh >= REFRESH_S and not (self.refreshing and not self.refreshing.done()):
            self.last_refresh = now
            self.refreshing = self._spawn(self._refresh(request["id"]))

    async def _refresh(self, request_id):
        try:
            code, body = await self.bridge.post(f"/requests/{request_id}/status", {"callId": self.call_id})
        except Exception:
            return  # transient; the next tick asks again
        if code == 404:  # the Photon process restarted: that link no longer works
            body = {"requestId": request_id, "callId": self.call_id, "status": "failed"}
        elif code != 200:
            return
        self.apply(body)

    def apply(self, body: dict):
        """A status from Photon, accepted only for this call's current request."""
        request = self.request
        status = body.get("status")
        if (self.closed or not request or body.get("requestId") != request["id"] or body.get("callId") != self.call_id
                or status not in STATUSES or status == request["status"] or request["status"] not in ACTIVE):
            return
        if status == "confirmed" and not self._accept_location(body.get("location")):
            return
        request["status"], request["since"] = status, self.clock()
        self.version += 1
        log.info("call %s: location request %s %s", self.call_id, request["id"], status)
        if status in {"sent", "delivered"}:
            self._unsay("unconfirmed")
            if "instructions" not in request["said"]:
                request["said"].add("instructions")
                self._say("instructions", INSTRUCTIONS)
        elif status in {"failed", "unavailable", "expired"}:
            self._unsay("instructions", "unconfirmed")
            if status == "unavailable":
                self.eligible = False  # don't offer again on this call
                self.unavailable_said = True  # this line already says so
            self._say("failed", {"failed": FAILED, "unavailable": NOT_REACHABLE, "expired": EXPIRED}[status])
        elif status == "confirmed":
            self._unsay("instructions", "unconfirmed", "failed", "expired")
            self._say("received", RECEIVED)
            self.continuation, self.continuation_deadline = "wanted", self.clock() + CONTINUE_WAIT_S
            loc = self.location
            log.info("call %s: location request %s confirmed by caller: %.6f, %.6f (±%.0f m) captured %s; not dispatcher-verified",
                     self.call_id, request["id"], loc["latitude"], loc["longitude"], loc["accuracyMeters"], loc["capturedAt"])

    def _accept_location(self, location) -> bool:
        if not isinstance(location, dict):
            return False
        values = [location.get(k) for k in ("latitude", "longitude", "accuracyMeters")]
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values):
            return False
        latitude, longitude, accuracy = values
        if abs(latitude) > 90 or abs(longitude) > 180 or accuracy < 0 or not isinstance(location.get("capturedAt"), str):
            return False
        self.location = {"latitude": latitude, "longitude": longitude, "accuracyMeters": accuracy,
                         "capturedAt": location["capturedAt"][:40]}
        return True
