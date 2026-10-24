"""Twilio bidirectional transport for the existing voice Session, not a report store.

Signed HTTP -> short-lived call-bound lease -> signed WSS -> provider CallSid.
Only an uncleared Twilio mark can confirm playback in the shared controller.
"""
import asyncio
import base64
import contextlib
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
import re
import secrets
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import Response
from twilio.request_validator import RequestValidator
from twilio.twiml.voice_response import VoiceResponse

from .voice import Session
from .voice_provider import CartesiaSpeech, voice_environment

router = APIRouter()
log = logging.getLogger("twilio-media")
VOICE_PATH = "/twilio/voice"
MEDIA_PATH = "/twilio/media"
SID = re.compile(r"CA[a-zA-Z0-9]{32}\Z")
STREAM_SID = re.compile(r"MZ[a-zA-Z0-9]{32}\Z")


def configuration():
    env = voice_environment()
    names = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TWILIO_PUBLIC_BASE_URL")
    if any(not env.get(name) for name in names):
        raise HTTPException(503, "Configure " + ", ".join(name for name in names if not env.get(name)))
    base = env["TWILIO_PUBLIC_BASE_URL"].rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.port not in (None,443):
        raise HTTPException(503, "TWILIO_PUBLIC_BASE_URL must be an HTTPS origin on port 443")
    return env, base


@dataclass
class Lease:
    token: str
    expires: float
    claimed: bool = False


# Only transport authorization. All incident facts and retry receipts stay in Convex.
_leases: dict[str, Lease] = {}
_active_calls: set[str] = set()


@router.post(VOICE_PATH)
async def incoming_call(request: Request):
    env, base = configuration()
    if request.url.query or request.headers.get("content-type", "").split(";")[0] != "application/x-www-form-urlencoded":
        raise HTTPException(400, "Expected form webhook without query parameters")
    if len(await request.body()) > 32768:
        raise HTTPException(413, "Webhook too large")
    form = await request.form()
    if not RequestValidator(env["TWILIO_AUTH_TOKEN"]).validate(base + VOICE_PATH, form, request.headers.get("x-twilio-signature", "")):
        raise HTTPException(403, "Invalid Twilio signature")
    call_id = str(form.get("CallSid", ""))
    if form.get("AccountSid") != env["TWILIO_ACCOUNT_SID"] or form.get("To") != env["TWILIO_PHONE_NUMBER"] or not SID.fullmatch(call_id):
        raise HTTPException(403, "Unexpected Twilio account, number or call")
    now = time.monotonic()
    for key, lease in list(_leases.items()):
        if lease.expires < now and key not in _active_calls:
            del _leases[key]
    lease = _leases.get(call_id)
    if not lease:
        if len(_leases) >= 1000:
            raise HTTPException(429, "Call capacity exceeded")
        lease = _leases[call_id] = Lease(secrets.token_urlsafe(32), now + 120)
    response = VoiceResponse()
    stream = response.connect().stream(url=base.replace("https://", "wss://", 1) + MEDIA_PATH)
    stream.parameter(name="lease", value=lease.token)
    response.hangup()
    return Response(str(response), media_type="application/xml", headers={"Cache-Control":"no-store"})


class TwilioTransport:
    """Translate shared Session playback offers into Twilio media/mark/clear.

    Session's extraction worker and provider receiver remain unchanged. The
    input pump keeps receiving audio while a completed mark's ack is retried.
    """
    def __init__(self, socket, call_id, stream_id, start_sequence):
        self.socket, self.call_id, self.stream_id = socket, call_id, stream_id
        self.sequence = start_sequence
        self.inbox = asyncio.Queue(maxsize=256)
        self.send_lock = asyncio.Lock()
        self.offers = {}
        self.marks = {}  # name -> pending | cleared | complete
        self.labels = {}
        self.queued_at = {}
        self.reader = None

    async def wire(self, message):
        await self.socket.send_json({"streamSid":self.stream_id, **message})

    async def send(self, message):
        kind = message["type"]
        name = message.get("playback_id")
        if kind == "audio_offer":
            self.offers[name] = message["audio"]
            self.labels[name] = ("announcement-replay" if message.get("replay") else "announcement") if message.get("event_id") else "reply"
            await self.inbox.put({"type":"websocket.receive", "text":json.dumps({"type":"playback_ready", "playback_id":name})})
        elif kind == "audio_go":
            audio = self.offers.pop(name, None)
            if audio is None:
                return
            self.marks[name] = "pending"
            # Raw mulaw bytes only; no WAV headers, no PCM conversion.
            raw = base64.b64decode(audio, validate=True)
            if not raw:
                raise ValueError("No synthesized phone audio")
            async with self.send_lock:
                for offset in range(0, len(raw), 800):
                    if self.marks.get(name) != "pending":
                        return
                    await self.wire({"event":"media", "media":{"payload":base64.b64encode(raw[offset:offset+800]).decode()}})
                if self.marks.get(name) == "pending":
                    await self.wire({"event":"mark", "mark":{"name":name}})
                    self.queued_at[name] = time.monotonic()
                    log.info("call %s: playback queued (%s) kind=%s bytes=%s at=%s", self.call_id, name[:8], self.labels.get(name), len(raw), datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
        elif kind == "audio_stop":
            self.offers.pop(name, None)
            # Invalidate BEFORE awaiting the clear write. Any already in-flight
            # or clear-induced mark is conservatively treated as interrupted.
            for pending, state in list(self.marks.items()):
                if state == "pending":
                    self.marks[pending] = "cleared"
            async with self.send_lock:
                await self.wire({"event":"clear"})
            log.info("call %s: playback cleared at=%s", self.call_id, datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
        elif kind in {"notice", "fatal"}:
            log.warning("call %s: %s", self.call_id, kind)
        elif kind == "saved":
            log.info("call %s: incident turn saved", self.call_id)

    async def pump(self):
        try:
            while True:
                data = await self.socket.receive_json()
                seq = int(data.get("sequenceNumber", 0))
                if seq <= self.sequence:
                    continue  # duplicate provider frame, never duplicate speech
                if seq != self.sequence + 1 or data.get("streamSid") != self.stream_id:
                    raise ValueError("Stream identity or ordering mismatch")
                self.sequence = seq
                kind = data.get("event")
                if kind == "media":
                    if data["media"].get("track") != "inbound":
                        raise ValueError("Unexpected track")
                    raw = base64.b64decode(data["media"]["payload"], validate=True)
                    if not raw or len(raw) > 65536:
                        raise ValueError("Invalid media frame")
                    await self.inbox.put({"type":"websocket.receive", "bytes":raw})
                elif kind == "mark":
                    name = data.get("mark", {}).get("name")
                    if self.marks.get(name) == "pending":
                        self.marks[name] = "complete"
                        log.info("call %s: playback mark completed (%s) kind=%s elapsed_ms=%s at=%s", self.call_id, str(name)[:8], self.labels.get(name), round((time.monotonic()-self.queued_at.get(name,time.monotonic()))*1000), datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
                        await self.inbox.put({"type":"websocket.receive", "text":json.dumps({"type":"playback_complete", "playback_id":name})})
                    elif self.marks.get(name) == "cleared":
                        log.info("call %s: cleared mark ignored (%s) kind=%s at=%s", self.call_id, str(name)[:8], self.labels.get(name), datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
                elif kind == "stop":
                    if data["stop"].get("callSid") != self.call_id:
                        raise ValueError("Stop call identity mismatch")
                    break
                elif kind != "dtmf":
                    raise ValueError("Unexpected stream event")
        except Exception as exc:
            # Disconnect is expected; malformed streams fail closed. No payloads
            # or signatures appear in diagnostics.
            log.info("call %s: input ended (%s)", self.call_id, type(exc).__name__)
        finally:
            if not asyncio.current_task().cancelling():
                await self.inbox.put({"type":"websocket.disconnect"})

    async def receive(self):
        if self.reader is None:
            self.reader = asyncio.create_task(self.pump())
        return await self.inbox.get()

    async def send_json(self, data):
        # Session.run diagnostics; no browser protocol is sent into Twilio.
        if data.get("type") == "fatal":
            log.warning("call %s: bridge failure", self.call_id)

    async def close(self):
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        self.offers.clear()
        with contextlib.suppress(Exception):
            await self.socket.close()


@router.websocket(MEDIA_PATH)
async def media_stream(socket: WebSocket):
    transport = None
    owned_call = None
    try:
        env, base = configuration()
        validator = RequestValidator(env["TWILIO_AUTH_TOKEN"])
        # Validate only configured canonical origin, never Host/X-Forwarded-Host.
        # WSS is an HTTP upgrade; accept either documented URL representation,
        # including Twilio's documented trailing-slash signing variation.
        urls = [base + MEDIA_PATH, base.replace("https://", "wss://", 1) + MEDIA_PATH]
        signature = socket.headers.get("x-twilio-signature", "")
        if socket.url.query or not any(validator.validate(url + slash, {}, signature) for url in urls for slash in ("", "/")):
            await socket.close(code=4403)
            return
        await socket.accept()
        async with asyncio.timeout(10):
            start = await socket.receive_json()
            if start.get("event") == "connected":
                start = await socket.receive_json()
        info = start.get("start", {})
        call_id, stream_id = info.get("callSid", ""), info.get("streamSid", "")
        lease = _leases.get(call_id)
        if (start.get("event") != "start" or not SID.fullmatch(call_id) or not STREAM_SID.fullmatch(stream_id)
            or start.get("streamSid") != stream_id or info.get("accountSid") != env["TWILIO_ACCOUNT_SID"]
            or info.get("mediaFormat") != {"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1}
            or call_id in _active_calls or not lease or lease.claimed or lease.expires < time.monotonic()
            or not secrets.compare_digest(str(info.get("customParameters",{}).get("lease","")), lease.token)):
            await socket.close(code=4403)
            return
        lease.claimed = True  # no await between checking and consuming this lease
        _active_calls.add(call_id)
        owned_call = call_id
        transport = TwilioTransport(socket, call_id, stream_id, int(start["sequenceNumber"]))
        speech = CartesiaSpeech(input_encoding="pcm_mulaw", output_format={"container":"raw","encoding":"pcm_mulaw","sample_rate":8000})
        session = Session(call_id, speech, transport.send)
        session.turn_prefix = stream_id
        session.audio_frame_alignment = 1
        log.info("call %s: authenticated phone stream connected", call_id)
        await session.run(transport, 8000)
    except Exception as exc:
        log.warning("Twilio stream ended (%s)", type(exc).__name__)
    finally:
        if owned_call:
            _active_calls.discard(owned_call)
        if transport:
            await transport.close()
        else:
            with contextlib.suppress(Exception):
                await socket.close(code=4403)
