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

from . import convex_store, extraction
from .auth import require_voice
from .voice_provider import CartesiaSpeech

log = logging.getLogger("voice-bridge")
router = APIRouter()
GREETING = ("Hello, this is Lifeline. "
            "Tell me what's happening and where help is needed.")
QUIET_SECONDS = 2.0
# After a reply that asks nothing, how long the caller may stay silent before the agent
# carries on with the follow-up question the model chose for that turn.
FOLLOW_UP_QUIET_S = 5.0
REPEAT = re.compile(r"\brepeat\b|\bsay (?:that|it) again\b|\b(?:did not|didn't|couldn't|could not) hear\b|\bwhat did you say\b", re.I)
TEAM_STATUS = re.compile(r"\b(?:what|which|where|who)\b.{0,80}\b(?:team|assigned|coming)\b|\b(?:is|has)\b.{0,25}\bteam\b", re.I)


def _same_words(a: str, b: str) -> bool:
    words = lambda text: re.findall(r"[a-z0-9']+", text.lower())
    return words(a) == words(b)


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
        # A reply that arrived while a dispatcher update was pending: said after it, unless the
        # caller has spoken again or the location-link state has changed since it was written.
        self.deferred_question = None
        # Location-link state version the latest caller turn's reply was written against.
        self.reply_state = None
        # The question to carry on with if the caller stays silent after a reply that asked
        # nothing; once, and only if nothing else has been said or changed since.
        self.quiet_followup = None
        # Writing the acknowledgement + next question for a location that arrived between turns.
        self.continuing = None
        # Backlog control: caller turns still waiting in the queue, and caller text saved
        # without extraction because a newer caller turn was already queued behind it.
        self.queued_callers = 0
        self.unextracted: list[str] = []
        # Photon location sharing (app/location_share.py); phone calls with a trusted caller number only.
        self.location = None

    def repeat_request(self, text, turn_id):
        """Narrow playback/status intents from verified caller text, not LLM IDs."""
        team = TEAM_STATUS.search(text)
        if not team and not REPEAT.search(text):
            return False
        previous = self.last_audible
        if team:
            # "Which team / is anyone coming?": the latest still-true status update.
            self.requested_repeat = {"kind":"announcement", "id":turn_id, "event_id":None}
        elif previous and previous.event_id:
            # "Say that again" after an update: that same update, if it is still true.
            self.requested_repeat = {"kind":"announcement", "id":turn_id, "event_id":previous.event_id}
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
                self.queued_callers += 1
                await self.queue.put((f"{self.turn_prefix}-{number}", "caller", text, self.generation))
                await self.notify(type="transcript", text=text)

    async def persist(self, item):
        from .main import Utterance, process_utterance
        turn_id, speaker, text, _ = item
        options = {}
        if speaker == "caller":
            self.queued_callers -= 1
            if self.queued_callers > 0:
                # A newer caller turn is already queued: save this one now, in order, and let
                # that turn's extraction (which reads the whole transcript) cover it too.
                options = {"extract": False}
            elif self.unextracted:
                options = {"latest_message": "\n".join([*self.unextracted, text])}
            if options.get("extract") is not False and self.location:
                # The reply may only claim what the link's real status supports.
                await self.location.refresh_now()
                options["conversation_state"] = self.location.state()
                self.reply_state = self.location.version
        # Same sequence and identity on EVERY retry, including lost responses.
        for attempt in range(6):
            try:
                result = await process_utterance(self.call_id, Utterance(
                    speaker=speaker, text=text, turn_id=turn_id, sequence=self.sequence), **options)
                self.sequence += 1
                if speaker == "caller":
                    if options.get("extract") is False:
                        self.unextracted.append(text)
                    else:
                        self.unextracted.clear()
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
                    text = result.reply
                    if result.extraction_error:
                        text = "Your words have been saved for the dispatcher. You can add more details."
                    elif self.location:
                        if self.reply_state != self.location.version:
                            # The link's status changed while the reply was being written (e.g. the
                            # location arrived): its claims may be out of date. The status line covers it.
                            text = None
                        text = self.location.after_turn(result.extraction, text)
                    previous = self.last_audible
                    if text and previous and not previous.event_id and text.rstrip().endswith("?") \
                            and _same_words(text, previous.text):
                        # Never ask the same question twice in a row: the caller moved on. (An answer
                        # to a question they asked again may be repeated.)
                        text = None
                    if text and self.queue.empty() and item[3] == self.generation and not self.open_turn:
                        self.speak(text)
                    # Keep the conversation moving if the reply asked nothing and the caller goes quiet.
                    follow = result.extraction.follow_up_if_quiet if result.extraction and not result.extraction_error else None
                    self.quiet_followup = None
                    if follow and not (text and text.rstrip().endswith("?")) and item[3] == self.generation:
                        self.quiet_followup = {"text": follow, "generation": self.generation, "after": text,
                                               "version": self.location and self.location.version}
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
            return bool(await convex_store.current_announcement(self.call_id, event_id))
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
                # The caller update goes first (e.g. dev's "details received" after the
                # first turn); keep the question for afterwards rather than dropping it.
                self.deferred_question = (text, generation, self.location and self.location.version)
                return
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
            if self.location and not p.event_id:
                self.location.spoken(p.text)
            follow = self.quiet_followup
            if follow and p.text not in (follow["after"], follow["text"]):
                self.quiet_followup = None  # something else was said; that question may no longer fit
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
        try:
            # Resolved per poll (tests patch app.main); inside the handler so a failure here
            # delays announcements instead of ending the call.
            from .calls import _confirmed_status_text
            from .main import announcements
            if self.location:
                self.location.tick()
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
                        return
                    event = await convex_store.current_announcement(self.call_id, request["event_id"])
                    if event and event.get("text"):
                        # Canonical, role-aware wording saved with the update (witness or trapped).
                        request["event_id"] = event["_id"]
                        self.speak(event["text"], event["_id"], replay=event.get("announcedAt") is not None,
                                   request_id=request["id"])
                    else:
                        # Nothing current to repeat (e.g. the team was unassigned or the update
                        # superseded): say only the confirmed stage, never the old update.
                        self.requested_repeat = None
                        self.speak(await _confirmed_status_text(self.call_id), replay=True, request_id=request["id"])
                    return
                pending = await announcements(self.call_id)
                for event in pending:
                    if event["eventId"] not in self.acknowledged:
                        self.speak(event["text"], event["eventId"])
                        return
                question = self.deferred_question
                if question:
                    self.deferred_question = None
                    # Not if the caller spoke again, or the link's status changed since it was written.
                    if question[1] == self.generation and question[2] == (self.location and self.location.version):
                        self.speak(question[0])
                        return
                # Location-link status lines come after dispatcher updates and the pending question.
                if self.location and self.location.wants_continuation() and not (self.audio_task and not self.audio_task.done()):
                    # Snapshot now, not when the task first runs: the caller may start talking first.
                    self.continuing = asyncio.create_task(
                        self.continue_after_location(self.generation, self.location.writing_continuation()))
                line = self.location and self.location.next_line()
                if line:
                    self.speak(line)
                    return
                follow = self.quiet_followup
                if follow and time.monotonic() - max(self.last_speech, self.last_output_end) >= FOLLOW_UP_QUIET_S:
                    self.quiet_followup = None
                    previous = self.last_audible
                    if (follow["generation"] == self.generation
                            and follow["version"] == (self.location and self.location.version)
                            and not (previous and _same_words(follow["text"], previous.text))):
                        self.speak(follow["text"])
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Announcement check delayed (%s)", type(exc).__name__)

    async def continue_after_location(self, generation, version):
        """A location arrived between caller turns: write the acknowledgement and the next
        question from the current transcript and state, without waiting for the caller."""
        location = self.location
        text = None
        try:
            from .calls import _confirmed_status_text
            transcript = await convex_store.transcript_for_call(self.call_id) or ""
            # The only dispatch wording this line may use, in case the caller just asked.
            state = f"{location.state(track=False)}\nDispatch status: {await _confirmed_status_text(self.call_id)}"
            text = await asyncio.wait_for(
                extraction.continue_after_location(transcript, state),
                location.continuation_deadline - location.clock())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Location acknowledgement said without a continuation (%s)", type(exc).__name__)
        # If the caller started speaking meanwhile, their own reply acknowledges it from fresh state.
        location.continued(text, version, still_quiet=generation == self.generation and not self.open_turn)

    async def run(self, socket, sample_rate):
        from .main import end_call
        tasks = []
        try:
            state = await convex_store.start_voice_call(self.call_id)
            self.sequence = state["nextSequence"]
            if self.location:
                self.location.start()
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
            if self.continuing:
                tasks.append(self.continuing)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.location:
                # Withdraw an open link so a late confirmation can't attach to anything.
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.location.close(), 5)
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
