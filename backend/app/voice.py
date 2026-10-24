"""Shared browser/phone speech bridge. Only Cartesia turn.end enters extraction.

Audio reception, ordered persistence, and playback are independent tasks. No
Managed Agent lifecycle hooks or model-generated transcript are used here.
"""
import asyncio
import base64
import contextlib
import logging
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from . import convex_store
from .auth import require_voice
from .voice_provider import CartesiaSpeech

log = logging.getLogger("voice-bridge")
router = APIRouter()
GREETING = ("Hello, this is Lifeline, a non-emergency hackathon simulation. "
            "If this is a real emergency, contact local emergency services. "
            "Please describe your fictional flood incident and where you are.")
QUIET_SECONDS = 2.0
REPEAT = re.compile(r"\brepeat\b|\bsay (?:that|it) again\b|\b(?:did not|didn't|couldn't|could not) hear\b|\bwhat did you say\b", re.I)
TEAM_STATUS = re.compile(r"\b(?:what|which|where|who)\b.{0,80}\b(?:team|assigned|coming)\b|\b(?:is|has)\b.{0,25}\bteam\b", re.I)


@dataclass
class Playback:
    id: str
    text: str
    event_id: str | None = None
    phase: str = "offered"
    replay: bool = False
    request_id: str | None = None


class Session:
    def __init__(self, call_id, speech, send):
        self.call_id, self.speech, self.send = call_id, speech, send
        self.queue = asyncio.Queue(maxsize=64)
        self.sequence = 1
        self.turn_number = 0
        self.turn_prefix = "ink"
        self.audio_frame_alignment = 4
        self.open_turn = False
        self.last_speech = time.monotonic()
        self.generation = 0
        self.playback = None
        self.audio_task = None
        self.stopping = False
        self.acknowledged = set()
        self.finished_turns = set()
        self.failure = None
        self.processing = False
        self.completion_lock = asyncio.Lock()
        self.last_output_end = 0.0
        self.last_audible = None
        self.requested_repeat = None

    def repeat_request(self, text, turn_id):
        """Narrow playback/status intents from verified caller text, not LLM IDs."""
        team = TEAM_STATUS.search(text)
        if not team and not REPEAT.search(text):
            return False
        previous = self.last_audible
        if team or (previous and previous.event_id):
            self.requested_repeat = {"kind":"announcement", "id":turn_id, "event_id":None}
        elif previous:
            self.requested_repeat = {"kind":"reply", "id":turn_id, "text":previous.text}
        else:
            self.requested_repeat = {"kind":"reply", "id":turn_id, "text":GREETING}
        return True

    async def notify(self, **message):
        if not self.stopping:
            await self.send(message)

    async def interrupt(self):
        self.generation += 1
        if self.audio_task and not self.audio_task.done():
            self.audio_task.cancel()
            await asyncio.gather(self.audio_task, return_exceptions=True)
        if self.playback and self.playback.phase != "completed":
            await self.notify(type="audio_stop", playback_id=self.playback.id)
            self.playback = None

    async def provider_event(self, event):
        """SDK provider events only; eager/update text is deliberately ignored."""
        kind = event.get("type")
        if kind == "error":
            raise RuntimeError("Cartesia STT failed")
        if kind == "turn.start":
            if not self.open_turn:
                self.turn_number += 1
                self.open_turn = True
            self.last_speech = time.monotonic()
            await self.interrupt()
        elif kind in {"turn.update", "turn.resume", "turn.eager_end"}:
            self.last_speech = time.monotonic()
        elif kind == "turn.end":
            # Ink sends a whole cumulative turn, not incremental text. A second
            # end without a new start is the same provider turn, never new speech.
            number = self.turn_number
            if number in self.finished_turns or not self.open_turn:
                return
            self.finished_turns.add(number)
            self.open_turn = False
            self.last_speech = time.monotonic()
            text = (event.get("transcript") or "").strip()
            if text:
                await self.queue.put((f"{self.turn_prefix}-{number}", "caller", text, self.generation))
                await self.notify(type="transcript", text=text)

    async def persist(self, item):
        from .main import Utterance, process_utterance
        turn_id, speaker, text, _ = item
        # Same sequence and identity on EVERY retry, including lost responses.
        for attempt in range(6):
            try:
                result = await process_utterance(self.call_id, Utterance(
                    speaker=speaker, text=text, turn_id=turn_id, sequence=self.sequence))
                self.sequence += 1
                return result
            except asyncio.CancelledError:
                raise
            except Exception:
                await self.notify(type="notice", text="Saving this turn is delayed; retrying in order.")
                if attempt == 5:
                    raise
                await asyncio.sleep(min(2 ** attempt, 5))

    async def worker(self):
        while True:
            item = await self.queue.get()
            self.processing = True
            try:
                result = await self.persist(item)
                await self.notify(type="saved", incident=result.incident,
                                  extraction_error=result.extraction_error)
                if item[1] == "caller" and not self.stopping:
                    if self.repeat_request(item[2], item[0]) or self.requested_repeat:
                        # Do not answer "repeat that/team?" with an unrelated
                        # intake question. Persistence still happened first.
                        continue
                    text = result.next_question
                    if result.extraction_error:
                        text = "Your words have been saved for the dispatcher. You can add more details."
                    if text and self.queue.empty() and item[3] == self.generation and not self.open_turn:
                        self.speak(text)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.failure = type(exc).__name__
                await self.notify(type="fatal", text="Storage is unavailable. This turn is not confirmed saved. End this session and check the backend.")
                # Do not process the next turn past a failed sequence.
                raise
            finally:
                self.processing = False
                self.queue.task_done()

    async def current(self, event_id, *, include_announced=False):
        if include_announced:
            event = await convex_store.current_announcement(self.call_id)
            return bool(event and event["_id"] == event_id)
        return any(e["_id"] == event_id for e in await convex_store.pending_events(self.call_id))

    def speak(self, text, event_id=None, *, replay=False, request_id=None):
        if self.stopping or self.playback or (self.audio_task and not self.audio_task.done()):
            return False
        self.audio_task = asyncio.create_task(self.offer(text, event_id, replay=replay, request_id=request_id))
        return True

    async def offer(self, text, event_id, *, replay=False, request_id=None):
        generation = self.generation
        p = Playback(uuid.uuid4().hex, text, event_id, "synthesizing", replay, request_id)
        self.playback = p  # reserve the output slot before ANY provider await
        try:
            audio = await self.speech.synthesize(text)
            if self.stopping or generation != self.generation or self.open_turn:
                return
            if event_id and not await self.current(event_id, include_announced=replay):
                return
            if not event_id and not replay and text != GREETING and await convex_store.pending_events(self.call_id):
                return  # approved update wins before a new question starts
            if self.playback is not p or generation != self.generation or self.open_turn:
                return
            p.phase = "offered"
            await self.notify(type="audio_offer", playback_id=p.id, event_id=event_id,
                              replay=replay, text=text, audio=base64.b64encode(audio).decode())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Speech generation failed (%s)", type(exc).__name__)
            await self.notify(type="notice", text="Audio generation failed; approved updates remain pending.")
        finally:
            if self.playback is p and p.phase == "synthesizing":
                self.playback = None

    async def playback_event(self, kind, playback_id):
        p = self.playback
        if not p or p.id != playback_id:
            return
        if kind == "playback_ready" and p.phase == "offered":
            if self.open_turn or self.processing or not self.queue.empty() or (p.event_id and not await self.current(p.event_id, include_announced=p.replay)):
                await self.interrupt()
                return
            if self.playback is not p or self.open_turn or self.processing or not self.queue.empty():
                return
            p.phase = "playing"
            self.last_audible = p
            await self.notify(type="audio_go", playback_id=p.id)
        elif kind == "playback_complete" and p.phase == "playing":
            # Natural browser onended or an uncleared Twilio mark only.
            # Synthesized/received bytes never acknowledge playback.
            p.phase = "completed"
            await self.complete(p)
        elif kind in {"playback_interrupted", "playback_failed"} and p.phase != "completed":
            await self.interrupt()

    async def complete(self, p):
        async with self.completion_lock:
            if self.playback is not p:
                return
            if p.event_id and not p.replay:
                # If this mutation commits but its response is lost, keep phase
                # completed and retry the ack, never the audio.
                await convex_store.mark_announced(self.call_id, p.event_id)
                self.acknowledged.add(p.event_id)
            self.last_output_end = time.monotonic()
            if self.requested_repeat and p.request_id == self.requested_repeat["id"]:
                self.requested_repeat = None
            if not self.stopping and p.text != GREETING:
                await self.queue.put((f"spoken-{p.id}", "agent", p.text, self.generation))
            self.playback = None

    async def poll(self):
        while True:
            await self.poll_once()
            await asyncio.sleep(0.5)

    async def poll_once(self):
        from .main import announcements, ANNOUNCEMENTS
        try:
            p = self.playback
            if p and p.phase == "completed":
                await self.complete(p)
            elif p and p.event_id and not await self.current(p.event_id, include_announced=p.replay):
                await self.interrupt()
            elif not p and not self.open_turn and not self.processing and self.queue.empty() and time.monotonic() - max(self.last_speech, self.last_output_end) >= QUIET_SECONDS:
                request = self.requested_repeat
                if request:
                    if request["kind"] == "reply":
                        self.speak(request["text"], replay=True, request_id=request["id"])
                    else:
                        event = await convex_store.current_announcement(self.call_id)
                        if not event or (request["event_id"] and request["event_id"] != event["_id"]):
                            self.requested_repeat = None
                            self.speak("There is no current dispatcher-approved assignment to repeat.")
                        else:
                            request["event_id"] = event["_id"]
                            text = ANNOUNCEMENTS[event["type"]].format(team=f", {event['teamName']}," if event.get("teamName") else "")
                            self.speak(text, event["_id"], replay=event.get("announcedAt") is not None, request_id=request["id"])
                    return
                pending = await announcements(self.call_id)
                for event in pending:
                    if event["eventId"] not in self.acknowledged:
                        self.speak(event["text"], event["eventId"])
                        break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Announcement check delayed (%s)", type(exc).__name__)

    async def run(self, socket, sample_rate):
        from .main import end_call
        tasks = []
        try:
            state = await convex_store.start_voice_call(self.call_id)
            self.sequence = state["nextSequence"]
            await self.speech.configure()
            async with self.speech.listen(sample_rate) as stt:
                controls = asyncio.Queue(maxsize=32)

                async def handle_controls():
                    while True:
                        data = await controls.get()
                        try:
                            await self.playback_event(data["type"], data.get("playback_id"))
                        except Exception:
                            # Completed playback must only retry its ack.
                            if not self.playback or self.playback.phase != "completed":
                                raise
                        finally:
                            controls.task_done()

                async def receive_provider():
                    async for event in stt:
                        await self.provider_event(event if isinstance(event, dict) else event.model_dump())

                async def receive_browser():
                    while True:
                        message = await socket.receive()
                        if message["type"] == "websocket.disconnect":
                            return
                        if message.get("bytes") is not None:
                            audio = message["bytes"]
                            if len(audio) > 131072 or len(audio) % self.audio_frame_alignment:
                                raise ValueError("Invalid audio frame")
                            await stt.send_raw(audio)
                        elif message.get("text"):
                            import json
                            data = json.loads(message["text"])
                            if data.get("type") == "end":
                                return
                            if data.get("type") in {"playback_ready", "playback_complete", "playback_interrupted", "playback_failed"}:
                                controls.put_nowait(data)

                receiver = asyncio.create_task(receive_provider())
                worker = asyncio.create_task(self.worker())
                poller = asyncio.create_task(self.poll())
                browser = asyncio.create_task(receive_browser())
                control_worker = asyncio.create_task(handle_controls())
                tasks = [receiver, worker, poller, browser, control_worker]
                self.speak(GREETING)
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED, timeout=1800)
                self.stopping = True
                # Marks already received before hangup can finish acknowledgement;
                # incoming audio never waits on these database operations.
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(controls.join(), 5)
                await self.interrupt()
                poller.cancel()
                browser.cancel()
                for task in done:
                    task.result()
                if receiver in done and browser not in done:
                    raise RuntimeError("Speech provider closed during the session")
                # Flush final provider turns on hangup without accepting new audio.
                if not receiver.done():
                    await stt.send({"type": "close"})
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(asyncio.shield(receiver), 5)
                await asyncio.wait_for(self.queue.join(), 60)
                if self.playback and self.playback.phase == "completed":
                    await self.complete(self.playback)
        except (WebSocketDisconnect, asyncio.CancelledError):
            raise
        except Exception as exc:
            log.warning("Voice session ended with %s", type(exc).__name__)
            with contextlib.suppress(Exception):
                await socket.send_json({"type": "fatal", "text": "The bridge disconnected. Check the dashboard for the last saved turn."})
        finally:
            self.stopping = True
            if self.audio_task:
                tasks.append(self.audio_task)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.speech.close()
            try:
                await asyncio.wait_for(end_call(self.call_id), 10)
            except Exception as exc:
                log.error("Call-ended persistence requires retry (%s), call %s", type(exc).__name__, self.call_id)
            with contextlib.suppress(Exception):
                await socket.close()


# Tickets expire quickly, are single use, and never contain provider credentials.
_tickets = {}


@router.get("/voice")
async def page():
    return FileResponse(Path(__file__).parent / "static/voice.html", headers={"Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:"})


@router.get("/voice/capture.js")
async def capture_processor():
    return FileResponse(Path(__file__).parent / "static/capture.js",
                        media_type="text/javascript", headers={"Cache-Control": "no-store"})


@router.post("/voice/sessions", dependencies=[Depends(require_voice)])
async def create_session():
    now = time.monotonic()
    for token, entry in list(_tickets.items()):
        if entry[1] < now:
            del _tickets[token]
    if len(_tickets) > 100:
        raise HTTPException(429, "Too many pending sessions")
    ticket = secrets.token_urlsafe(32)
    call_id = f"browser-{uuid.uuid4()}"
    _tickets[ticket] = (call_id, now + 60)
    return {"call_id": call_id, "ticket": ticket}


@router.websocket("/voice/socket")
async def socket_endpoint(socket: WebSocket):
    origin = socket.headers.get("origin", "")
    from urllib.parse import urlsplit
    if urlsplit(origin).netloc != socket.headers.get("host"):
        await socket.close(code=4403)
        return
    protocols = socket.scope.get("subprotocols", [])
    entry = _tickets.pop(protocols[0], None) if len(protocols) == 1 else None
    if not entry or entry[1] < time.monotonic():
        await socket.close(code=4401)
        return
    await socket.accept(subprotocol=protocols[0])
    try:
        hello = await asyncio.wait_for(socket.receive_json(), 10)
        sample_rate = hello.get("sample_rate")
        if hello.get("type") != "start" or sample_rate not in (16000, 24000, 44100, 48000):
            await socket.close(code=4400)
            return
        session = Session(entry[0], CartesiaSpeech(), socket.send_json)
        await session.run(socket, sample_rate)
    except Exception as exc:
        log.warning("Voice setup failed (%s)", type(exc).__name__)
        with contextlib.suppress(Exception):
            await socket.close(code=1011)
