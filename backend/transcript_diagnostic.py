"""Read-only Cartesia call probe; prints counts, never speech or credentials.

python -m backend.transcript_diagnostic [--call-id CARTESIA_CALL_ID]
Loads only CARTESIA_API_KEY and CARTESIA_AGENT_ID from ignored .env.
"""

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import shlex
import time

from cartesia import APIError, Cartesia


def load_credentials():
    names = ('CARTESIA_API_KEY', 'CARTESIA_AGENT_ID')
    path = Path(__file__).resolve().parents[1] / '.env'
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith('export '):
                line = line[7:].lstrip()
            key, separator, value = line.partition('=')
            key = key.strip()
            if separator and key in names:
                # Parse literals only. Never source shell code or expand substitutions.
                parts = shlex.split(value, comments=True, posix=True)
                if len(parts) > 1:
                    raise ValueError('Credential assignment must be a single quoted or unquoted value')
                os.environ[key] = parts[0] if parts else ''
    missing = [key for key in names if not os.getenv(key)]
    if missing:
        raise ValueError('Missing variables: ' + ', '.join(missing))
    return os.environ[names[0]], os.environ[names[1]]


class Evidence:
    def __init__(self):
        self.active_samples = 0
        self.live_present = False
        self.live_changed = False
        self.post_present = False
        self.last_live_signature = None

    def observe(self, call):
        rows = call.get('transcript') or []
        spoken = [row for row in rows if row.get('role') in ('user', 'assistant') and isinstance(row.get('text'), str) and row['text'].strip()]
        caller = [row for row in spoken if row['role'] == 'user']
        signature = hashlib.sha256(json.dumps(
            [(row.get('start_timestamp'), row['text']) for row in caller],
            sort_keys=True,
        ).encode()).hexdigest()
        status = call.get('status')
        if status == 'started':
            self.active_samples += 1
            if caller:
                self.live_present = True
                if self.last_live_signature is not None and self.last_live_signature != signature:
                    self.live_changed = True
                self.last_live_signature = signature
        elif status in ('completed', 'failed'):
            self.post_present |= bool(caller)
        return {
            'status': status if status in ('created', 'started', 'completed', 'failed') else 'unknown',
            'transcript_field': 'missing' if 'transcript' not in call else 'null' if call['transcript'] is None else 'present',
            'spoken_turns': len(spoken), 'caller_turns': len(caller),
            'live_caller_changed': self.live_changed,
            'zdr': bool(call.get('zdr_enabled')), 'redacted': bool(call.get('redacted_at')),
        }

    def result(self):
        if self.live_changed:
            return 'LIVE_CALLER_EVIDENCE_PRESENT_AND_UPDATING'
        if self.live_present:
            return 'LIVE_CALLER_EVIDENCE_PRESENT; UPDATING_NOT_OBSERVED'
        if self.active_samples and self.post_present:
            return 'CALLER_EVIDENCE_OBSERVED_ONLY_AFTER_HANGUP_IN_THIS_TEST'
        return 'INCONCLUSIVE; NO_VERIFIED_LIVE_CALLER_EVIDENCE_OBSERVED'


def run(client, agent_id, call_id=None, duration=300, interval=3, post_seconds=60):
    probe = Evidence()
    deadline = time.monotonic() + duration
    active_since = None
    ended_at = None
    second_cue = False
    hangup_cue = False
    # Test access before telling the caller to dial. Do not print call records.
    if call_id is None:
        client.agents.calls.list(agent_id=agent_id, limit=20)
        print('READY: START CALL NOW. Wait for the normal greeting, then the SPEAK FIRST cue.', flush=True)
    while time.monotonic() < deadline:
        if call_id is None:
            page = client.agents.calls.list(agent_id=agent_id, limit=20)
            active = [call for call in page.data if call.status == 'started']
            if len(active) > 1:
                raise ValueError('Multiple active calls; rerun with --call-id from Cartesia Calls')
            if not active:
                time.sleep(interval)
                continue
            call_id = active[0].id
            print('Active call found; tracking this call through hangup.', flush=True)
        call = client.agents.calls.retrieve(call_id).model_dump(mode='json')
        if call.get('id') != call_id or call.get('agent_id') != agent_id:
            raise ValueError('Call identity or configured agent mismatch')
        metrics = probe.observe(call)
        print(json.dumps(metrics), flush=True)
        now = time.monotonic()
        if metrics['status'] == 'started':
            if active_since is None:
                active_since = now
                # Discovery may take most of the initial wait window. Still allow
                # time for speech, hangup, and delayed transcript rechecks.
                deadline = max(deadline, now + 180)
                print('SPEAK FIRST after the greeting: For this demo, water is rising at 18 Juniper Lane in fictional Millhaven. Four people are affected.', flush=True)
            if now - active_since >= 20 and not second_cue:
                second_cue = True
                print('SPEAK SECOND when the assistant pauses: Correction for the demo: the house number is 81 and there are three people, not four.', flush=True)
            if now - active_since >= 45 and not hangup_cue:
                hangup_cue = True
                print('FINISH NOW: Say goodbye and hang up normally. Leave this diagnostic running.', flush=True)
        if metrics['status'] in ('completed', 'failed'):
            if ended_at is None:
                ended_at = now
                print('Hangup detected. Checking transcript for another 60 seconds.', flush=True)
            if now - ended_at >= post_seconds:
                break
        time.sleep(interval)
    print('RESULT: ' + probe.result(), flush=True)
    print(f'active_samples={probe.active_samples}; postcall_caller_evidence={probe.post_present}', flush=True)
    return probe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--call-id')
    args = parser.parse_args()
    # Prevent opt-in SDK debug logging from dumping requests or provider bodies.
    logging.disable(logging.CRITICAL)
    try:
        api_key, agent_id = load_credentials()
        with Cartesia(api_key=api_key, base_url='https://api.cartesia.ai',
                      default_headers={'cartesia-version': '2026-08-14'},
                      timeout=8.0, max_retries=0) as client:
            run(client, agent_id, args.call_id)
    except APIError as error:
        print(f'STOP: provider request failed (HTTP {getattr(error, "status_code", "unavailable")}). No response body printed; result inconclusive.', flush=True)
        return 1
    except ValueError:
        print('STOP: missing/malformed CARTESIA_API_KEY or CARTESIA_AGENT_ID, ambiguous active calls, or identity mismatch. No sensitive values printed; result inconclusive.', flush=True)
        return 1
    except KeyboardInterrupt:
        print('STOP: diagnostic interrupted; result incomplete.', flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
