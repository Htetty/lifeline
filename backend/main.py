"""FloodLine's first inbound voice checkpoint."""

from fastapi import FastAPI, Response
from twilio.twiml.voice_response import VoiceResponse

from backend.report_tools import router as report_router

app = FastAPI(title="FloodLine")
app.include_router(report_router)

GREETING = (
    "Hello, you’ve reached FloodLine, a non-emergency hackathon demonstration. "
    "This call is a simulation. If you are experiencing a real emergency, "
    "hang up and contact local emergency services. Our voice assistant will "
    "be available soon. Thank you for testing."
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/voice/inbound")
async def inbound_voice() -> Response:
    response = VoiceResponse()
    response.say(GREETING, language="en-US")
    response.hangup()
    return Response(content=str(response), media_type="application/xml")
