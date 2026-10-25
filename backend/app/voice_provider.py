"""Cartesia speech APIs only. The existing Managed Agent is never modified."""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from cartesia import AsyncCartesia
from dotenv import dotenv_values

VERSION = "2026-08-14"


def voice_environment():
    root = Path(__file__).resolve().parents[2]
    # Empty example placeholders must not hide existing root-file credentials.
    root_env = {k: v for k, v in dotenv_values(root / ".env").items() if v}
    backend_env = {k: v for k, v in dotenv_values(root / "backend/.env").items() if v}
    return {**root_env, **backend_env, **os.environ}


class CartesiaSpeech:
    def __init__(self, *, input_encoding="pcm_f32le", output_format=None, turn=None):
        env = voice_environment()
        if not env.get("CARTESIA_API_KEY"):
            raise RuntimeError("Set CARTESIA_API_KEY in backend/.env")
        self.client = AsyncCartesia(
            api_key=env["CARTESIA_API_KEY"], base_url="https://api.cartesia.ai",
            default_headers={"cartesia-version": VERSION}, max_retries=0, timeout=20,
        )
        self.agent_id = env.get("CARTESIA_AGENT_ID")
        self.voice = env.get("CARTESIA_VOICE_ID")
        self.model = env.get("CARTESIA_TTS_MODEL")
        self.input_encoding = input_encoding
        self.output_format = output_format
        self.turn = turn or {}  # Cartesia turn-detection overrides, e.g. {"turn_end_threshold": 0.15}

    async def configure(self):
        if not self.voice or not self.model:
            if not self.agent_id:
                raise RuntimeError("Set CARTESIA_AGENT_ID or both CARTESIA_VOICE_ID and CARTESIA_TTS_MODEL")
            agent = await self.client.agents.retrieve(self.agent_id)
            self.voice = self.voice or agent.tts_voice
            # Managed Agents may expose no standalone speech-model ID. For this
            # separate browser flow use the documented Sonic model, without
            # changing the phone agent's configuration.
            self.model = self.model or agent.tts_model or "sonic-3.6"
        if not self.voice or not self.model:
            raise RuntimeError("Existing agent does not expose a voice/model; set CARTESIA_VOICE_ID and CARTESIA_TTS_MODEL")

    @asynccontextmanager
    async def listen(self, sample_rate):
        async with self.client.stt.auto_finalize.websocket(
            model="ink-2", encoding=self.input_encoding, sample_rate=sample_rate,
            extra_query={"cartesia_version": VERSION}, max_retries=0, **self.turn,
        ) as connection:
            yield connection

    async def synthesize(self, text, raw=False):
        await self.configure()
        response = await self.client.tts.generate(
            model_id=self.model, voice=self.voice, transcript=text, language="en",
            output_format=self.output_format or {"container": "raw" if raw else "wav", "encoding": "pcm_s16le", "sample_rate": 16000},
        )
        return await response.read()

    async def close(self):
        await self.client.close()
