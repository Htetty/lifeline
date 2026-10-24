"""Fictional voice → dashboard → voice walkthrough against running services.

Real: FastAPI backend (with Claude extraction and map search), local Convex, and the
Next.js dashboard clicked through headless Chrome. Not real: audio. Caller speech is
typed text and announcements are printed, standing in for Cartesia STT/TTS.

Run via scripts/integration/e2e_local.sh, which starts everything against a local
Convex backend. Writes trace.json and screenshots to --out.
"""

import argparse
import base64
import itertools
import json
import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import httpx
from websockets.sync.client import connect

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CALLER_1 = (
    "This is a drill for the flood exercise. We're on the second floor of the Days Inn on Hotel Circle South. "
    "There are three of us and water is coming up the stairs."
)
CALLER_2 = "Sorry, I got that wrong. We're actually at the Handlery Hotel, not the Days Inn. And it's two of us, not three."


class Browser:
    def __init__(self, url: str, profile: str):
        self.proc = subprocess.Popen(
            [CHROME, "--headless=new", "--remote-debugging-port=9333", f"--user-data-dir={profile}",
             "--window-size=1440,900", "--no-first-run", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(50):
            try:
                pages = httpx.get("http://127.0.0.1:9333/json").json()
                ws = next(p["webSocketDebuggerUrl"] for p in pages if p["type"] == "page")
                break
            except Exception:
                time.sleep(0.2)
        self.ws = connect(ws, max_size=50_000_000).__enter__()
        self.ids = itertools.count(1)
        self.console: list[str] = []
        self.cmd("Page.enable")
        self.cmd("Runtime.enable")
        self.cmd("Page.navigate", url=url)

    def cmd(self, method, **params):
        msg_id = next(self.ids)
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "Runtime.exceptionThrown":
                self.console.append(msg["params"]["exceptionDetails"].get("exception", {}).get("description", "")[:300])
            elif msg.get("method") == "Runtime.consoleAPICalled" and msg["params"]["type"] in ("error", "warning"):
                self.console.append(" ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"]["args"])[:300])
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def js(self, expression):
        r = self.cmd("Runtime.evaluate", expression=expression, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"])
        return r["result"].get("value")

    def wait(self, expression, timeout=60, what=""):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.js(expression):
                return
            time.sleep(0.3)
        page = self.js("document.body ? document.body.innerText.slice(0, 500) : ''")
        raise TimeoutError(f"Timed out waiting for {what or expression}; page shows: {page!r}")

    def has_text(self, text):
        return self.js(f"document.body.innerText.includes({json.dumps(text)})")

    def click(self, text, tag="button"):
        found = self.js(f"""(() => {{
          const el = [...document.querySelectorAll({json.dumps(tag)})]
            .find(e => e.innerText.includes({json.dumps(text)}) && !e.disabled);
          if (!el) return false; el.click(); return true; }})()""")
        if not found:
            raise RuntimeError(f"No enabled {tag} with text {text!r}")

    def set_value(self, selector, value):
        self.js(f"""(() => {{
          const el = document.querySelector({json.dumps(selector)});
          const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {json.dumps(value)});
          el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {{ bubbles: true }}));
        }})()""")

    def type_passcode(self, value):
        # Until React hydrates, input events are lost.
        self.wait("Object.keys(document.querySelector('input[type=password]')).some(k => k.startsWith('__reactProps'))",
                  240, "React hydration")
        for _ in range(20):
            self.js("(() => { const el = document.querySelector('input[type=password]'); el.focus(); el.select(); })()")
            self.cmd("Input.insertText", text=value)
            if self.js("![...document.querySelectorAll('button')].find(b => b.innerText.includes('Sign in')).disabled"):
                return
            time.sleep(0.3)
        form = self.js("document.querySelector('form') && document.querySelector('form').outerHTML.slice(0, 1500)")
        value = self.js("document.querySelector('input[type=password]').value")
        raise TimeoutError(f"Passcode input never registered; value={value!r} form={form} console: {self.console[-5:]}")

    def screenshot(self, path: Path):
        path.write_bytes(base64.b64decode(self.cmd("Page.captureScreenshot", format="png")["data"]))

    def close(self):
        self.ws.close()
        self.proc.terminate()
        self.proc.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--dashboard", required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    call = f"e2e-{uuid.uuid4().hex[:8]}"
    http = httpx.Client(base_url=args.api, timeout=120,
                        headers={"Authorization": f"Bearer {os.environ['VOICE_BRIDGE_TOKEN']}"})
    trace: list[dict] = []

    def step(name, **data):
        entry = {"t": round(time.time() - start, 1), "step": name, **data}
        trace.append(entry)
        print(json.dumps(entry), flush=True)

    def say(speaker, text):
        r = http.post(f"/calls/{call}/utterances", json={"speaker": speaker, "text": text})
        return r.status_code, r.json()

    def poll():
        return http.get(f"/calls/{call}/announcements").json()

    start = time.time()
    code, body = say("agent", "Lifeline flood line. This is a simulated exercise. Where are you right now?")
    step("agent greeting", http=code, saved=body.get("saved"))

    code, body = say("caller", CALLER_1)
    incident_id = body["incident"]["incidentId"]
    ex = body.get("extraction") or {}
    step("caller report (live Claude)", http=code, saved=body["saved"], address=ex.get("reported_address"),
         people=ex.get("people_count"), position=ex.get("reported_position"), map_match=body.get("location_match"),
         next_question=body.get("next_question"))
    if body.get("next_question"):
        say("agent", body["next_question"])

    code, body = say("caller", CALLER_2)
    ex = body.get("extraction") or {}
    step("caller correction (live Claude)", http=code, saved=body["saved"],
         same_incident=body["incident"]["incidentId"] == incident_id,
         address=ex.get("reported_address"), people=ex.get("people_count"),
         location_changed=ex.get("location_changed"), map_match=body.get("location_match"))
    step("bridge polls before any decision", announcements=poll())

    with tempfile.TemporaryDirectory() as profile:
        b = Browser(args.dashboard, profile)
        try:
            b.wait("!!document.querySelector('input[type=password]')", 180, "passcode form (first compile is slow)")
            b.type_passcode("wrong-passcode")
            b.click("Sign in")
            b.wait("document.body.innerText.includes('Dispatcher passcode required')", what="rejection")
            step("dashboard rejects wrong passcode", shown=True)
            b.type_passcode(os.environ["DISPATCHER_TOKEN"])
            b.click("Sign in")
            b.wait("document.body.innerText.includes('Handlery')", 90, "the call's incident in the queue")
            b.js("window.confirm = () => true")
            b.click("Handlery", tag="li button")
            b.wait("document.body.innerText.includes('Changed by caller')", what="fact history")
            b.click("Changed by caller", tag="summary")
            b.screenshot(args.out / "1-incident-after-correction.png")
            step("dispatcher opens incident", history_shown=b.has_text("was “3”"),
                 transcript_shown=b.has_text("Days Inn"), on_call=b.has_text("Caller on the line"))

            b.click("Confirm location")
            b.wait("!!document.querySelector('select')", what="team picker")
            teams = b.js("[...document.querySelectorAll('select option')].filter(o => o.value).map(o => [o.value, o.text])")
            b.set_value("select", teams[0][0])
            b.click("Approve assignment")
            b.wait("document.body.innerText.includes('Unassign team')", what="assignment saved")
            step("dispatcher confirms location and approves", team=teams[0][1])

            b.click("Unassign team")
            b.wait("!!document.querySelector('select')", what="team picker again")
            b.set_value("select", teams[1][0])
            b.click("Approve assignment")
            b.wait("document.body.innerText.includes('Unassign team')", what="reassignment saved")
            b.screenshot(args.out / "2-reassigned.png")
            step("dispatcher unassigns and picks another team", team=teams[1][1])

            updates = poll()
            step("bridge polls", announcements=[(u["type"], u["text"]) for u in updates])
            first = updates[0]
            step("playback interrupted by caller: no ack; bridge re-polls", same_update=poll() == [first])
            ack = http.post(f"/calls/{call}/announcements/{first['eventId']}/ack").json()
            step("playback completed; ack", ack=ack, pending=poll())

            b.click("Mark en route")
            b.wait("document.body.innerText.includes('Team en route')", what="en route saved")
            updates = poll()
            ack = http.post(f"/calls/{call}/announcements/{updates[0]['eventId']}/ack").json()
            step("dispatcher marks en route; bridge speaks and acks", announcements=[u["text"] for u in updates], ack=ack)

            status = http.get(f"/calls/{call}/status").json()
            step("caller asks 'is someone coming?'; bridge reads confirmed status", status=status)

            http.post(f"/calls/{call}/end")
            b.wait("document.body.innerText.includes('Call ended')", what="call ended badge")
            b.click("Mark resolved")
            b.wait("!document.body.innerText.includes('Mark resolved')", what="resolved")
            b.screenshot(args.out / "3-after-hangup-resolved.png")
            step("caller hangs up; dispatcher resolves", announcements_after_hangup=poll(),
                 status=http.get(f"/calls/{call}/status").json()["status"])
            b.js("1")  # drain pending console events
            step("browser console errors/warnings", console=b.console)
        finally:
            b.close()

    (args.out / "trace.json").write_text(json.dumps({"callId": call, "steps": trace}, indent=2))


if __name__ == "__main__":
    main()
