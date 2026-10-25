"""Start and stop the demo simulation (scripts/demo_sim.py) from the dashboard.

One run at a time, as a child process of this server, talking back to this server the same
way it does from a terminal. Starting and stopping need the dispatcher passcode (checked by
Convex, like every dashboard action); status is open so the dashboard can show it.
"""

import asyncio
import signal
import sys
import time
from collections import deque
from pathlib import Path
from typing import Literal

from convex import ConvexError
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import convex_store

router = APIRouter(prefix="/simulation")

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "demo_sim.py"


class _Run:
    def __init__(self, process: asyncio.subprocess.Process, region: str, calls: int):
        self.process, self.region, self.calls = process, region, calls
        self.started_at = time.time()
        self.lines: deque[str] = deque(maxlen=40)
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        assert self.process.stdout
        async for raw in self.process.stdout:
            self.lines.append(raw.decode(errors="replace").rstrip())

    @property
    def running(self) -> bool:
        return self.process.returncode is None


_run: _Run | None = None
_lock = asyncio.Lock()


class StartRequest(BaseModel):
    region: Literal["mission-valley", "sf-waterfront"]
    calls: int = Field(default=11, ge=1, le=46)


async def _require_dispatcher(authorization: str) -> None:
    token = authorization.removeprefix("Bearer ").strip() or None
    try:
        await convex_store.check_dispatcher(token)
    except ConvexError as e:
        raise HTTPException(401, "Dispatcher passcode required") from e


def _status() -> dict:
    if _run is None:
        return {"running": False}
    return {
        "running": _run.running,
        "region": _run.region,
        "calls": _run.calls,
        "startedAt": _run.started_at,
        "exitCode": _run.process.returncode,
        # The run's summary once it's out, else its latest progress line ("[ 12.0s] ☎ …").
        "lastLine": next((line for line in reversed(_run.lines) if "calls placed" in line), None)
        or next((line for line in reversed(_run.lines) if line.lstrip().startswith("[")), None),
    }


@router.get("")
async def status():
    return _status()


@router.post("/start")
async def start(body: StartRequest, request: Request, authorization: str = Header(default="")):
    global _run
    await _require_dispatcher(authorization)
    async with _lock:
        if _run and _run.running:
            raise HTTPException(409, "A simulation is already running")
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", str(SCRIPT),
            "--region", body.region, "--calls", str(body.calls), "--api", str(request.base_url).rstrip("/"),
            cwd=SCRIPT.parents[1], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        _run = _Run(process, body.region, body.calls)
    return _status()


@router.post("/stop")
async def stop(authorization: str = Header(default="")):
    await _require_dispatcher(authorization)
    if _run and _run.running:
        # Same as Ctrl+C in a terminal: stops placing calls and hangs up the ones in progress.
        _run.process.send_signal(signal.SIGINT)
        try:
            await asyncio.wait_for(_run.process.wait(), timeout=15)
        except TimeoutError:
            _run.process.kill()
    return _status()
