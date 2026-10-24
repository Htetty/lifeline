"""Cartesia webhook tools. Provider identity and speech never come from the LLM."""

import hashlib
import json
import math
import os
import re
import secrets
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from cartesia import Cartesia, APIError
from fastapi import APIRouter, Depends, Header, HTTPException
from jsonschema import ValidationError
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from backend.report_contract import CONTENT_FIELDS, CONTENT_VALIDATOR, sources, validate_snapshot
from backend.report_store import MemoryReportStore, ReportStore, StoreConflict

router = APIRouter(prefix='/tools')
store = MemoryReportStore()


class Update(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: str = Field(min_length=1, max_length=128, pattern=r'^\S+$')
    expected_version: StrictInt = Field(ge=0)
    correction: bool = Field(strict=True)
    content_json: str = Field(min_length=2, max_length=32000)


def get_store() -> ReportStore:
    return store


def authorize(authorization: str = Header(default='')):
    token = os.getenv('REPORT_TOOL_TOKEN', '')
    if not token:
        raise HTTPException(503, 'report tools are not configured')
    if not secrets.compare_digest(authorization.encode(), f'Bearer {token}'.encode()):
        raise HTTPException(401, 'invalid tool credential')


def call_identity(
    _=Depends(authorize), x_cartesia_call_id: str = Header(default=''),
):
    agent = os.getenv('CARTESIA_AGENT_ID', '')
    if not agent or not os.getenv('CARTESIA_API_KEY'):
        raise HTTPException(503, 'Cartesia verification is not configured')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', x_cartesia_call_id):
        raise HTTPException(422, 'missing or invalid runtime Cartesia call ID')
    return (f'cartesia:{agent}', x_cartesia_call_id)


def retrieve_call(call_id: str) -> dict:
    # Only this fixed HTTPS endpoint is used; caller input cannot select a host.
    try:
        with Cartesia(
            api_key=os.environ['CARTESIA_API_KEY'],
            default_headers={
                # Match SDK header casing to override, rather than duplicate, its default.
                'cartesia-version': '2026-08-14',
            },
            base_url='https://api.cartesia.ai', max_retries=0, timeout=8.0,
        ) as client:
            return client.agents.calls.retrieve(call_id).model_dump(mode='json')
    except APIError:
        # Do not leak provider bodies, credentials, or transcripts into errors/logs.
        raise HTTPException(502, 'Cartesia call lookup failed; no update committed') from None


def verified_transcript(key):
    call = retrieve_call(key[1])
    if call.get('id') != key[1] or f"cartesia:{call.get('agent_id')}" != key[0]:
        raise HTTPException(403, 'call does not belong to the configured agent')
    if call.get('zdr_enabled') or call.get('redacted_at'):
        raise HTTPException(409, 'provider transcript unavailable under retention settings')
    try:
        start = datetime.fromisoformat(call['start_time'].replace('Z', '+00:00'))
        if start.tzinfo is None:
            raise ValueError()
        transcript = []
        for entry in call.get('transcript') or []:
            if entry.get('role') not in ('user', 'assistant') or not isinstance(entry.get('text'), str) or not entry['text'].strip():
                continue
            offset = entry['start_timestamp']
            if isinstance(offset, bool) or not isinstance(offset, (int, float)) or not math.isfinite(offset) or offset < 0:
                raise ValueError()
            # Hash provider speech and offset, not an LLM-provided turn identifier.
            turn_id = 'turn-' + digest([key[1], entry['role'], float(offset), entry['text']])[:24]
            transcript.append({
                'turn_id': turn_id, 'speaker': 'caller' if entry['role'] == 'user' else 'assistant',
                'recorded_at': (start + timedelta(seconds=offset)).isoformat(),
                'text': entry['text'],
            })
        if not any(t['speaker'] == 'caller' for t in transcript):
            raise ValueError()
        dates = [datetime.fromisoformat(t['recorded_at']) for t in transcript]
        if dates != sorted(dates) or dates[-1] > datetime.now(timezone.utc):
            raise ValueError()
        return transcript
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise HTTPException(409, {
            'code': 'transcript_not_ready', 'retryable': True,
            'message': 'Verified caller speech is not available yet. Continue conversation and retry context after the next caller turn. Do not invent evidence.',
        }) from None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def initial_content():
    content = {
        'summary': {'text': None, 'generated_by': 'model', 'source_turn_ids': []},
        'reported_location': {'description': None, 'precision': 'unknown', 'source_turn_ids': []},
        'people_affected': {'count': None, 'includes_children': None, 'source_turn_ids': []},
        'hazards': {**{name: None for name in ('rising_water', 'fast_moving_water', 'trapped_people', 'electrical_danger')}, 'source_turn_ids': []},
        'unknown_fields': [],
    }
    for group in ('reported_location', 'people_affected', 'hazards'):
        for field in content[group]:
            if field != 'source_turn_ids':
                content['unknown_fields'].append({'field': f'/{group}/{field}', 'reason': 'not_asked', 'source_turn_ids': []})
    content['unknown_fields'].append({'field': '/reported_location/coordinates', 'reason': 'not_available', 'source_turn_ids': []})
    return content


@router.get('/report-context')
def report_context(key=Depends(call_identity), storage: ReportStore = Depends(get_store)):
    try:
        transcript = verified_transcript(key)
    except HTTPException as exc:
        if isinstance(exc.detail, dict) and exc.detail.get('code') == 'transcript_not_ready':
            # Cartesia passes successful response bodies to the LLM. A non-2xx
            # response may only expose a generic tool error, losing retry guidance.
            return {'ready': False, 'saved': False, **exc.detail}
        raise
    current = storage.current(key)
    result = {
        'ready': True,
        'operation_id': str(uuid4()),
        'expected_version': current['version'] if current else 0,
        'report_id': current['report_id'] if current else None,
        'content': {name: current[name] for name in CONTENT_FIELDS} if current else initial_content(),
        'transcript': transcript,
    }
    if len(json.dumps(result).encode()) > 15000:
        raise HTTPException(409, 'context exceeds tool response limit; no truncated evidence returned')
    return result


@router.get('/report-state')
def report_state(key=Depends(call_identity), storage: ReportStore = Depends(get_store)):
    """Authenticated operator inspection, not an agent tool. Never writes storage."""
    current = storage.current(key)
    if current is None:
        raise HTTPException(404, 'no report stored for this call')
    return {'storage': 'memory', 'report': current, 'snapshots': storage.history(key)}


@router.post('/report-update')
def report_update(update: Update, key=Depends(call_identity), storage: ReportStore = Depends(get_store)):
    try:
        proposed_content = json.loads(update.content_json)
        CONTENT_VALIDATOR.validate(proposed_content)
        fingerprint = digest({**update.model_dump(exclude={'content_json'}), 'content': proposed_content})
        saved = storage.receipt(key, update.operation_id, fingerprint)
        if saved is not None:
            return saved
        transcript = verified_transcript(key)

        def build(previous):
            content = deepcopy(proposed_content)
            if content['reported_location'].get('coordinates', {}).get('source') == 'simulation_fixture':
                raise ValueError('live tool cannot supply synthetic fixture coordinates')
            if previous and transcript[:len(previous['transcript'])] != previous['transcript']:
                raise StoreConflict('provider transcript changed or is incomplete; prior evidence retained')
            changed = [f'/{name}' for name in CONTENT_FIELDS if previous is None or content[name] != previous[name]]
            if previous and transcript != previous['transcript']:
                changed.append('/transcript')
            if previous and not changed:
                return previous
            correction = update.correction
            changed_known = False
            if previous:
                old_callers = {t['turn_id'] for t in previous['transcript'] if t['speaker'] == 'caller'}
                for group in ('reported_location', 'people_affected', 'hazards'):
                    old, new = previous[group], content[group]
                    replaced = any(old.get(k) is not None and old.get(k) != 'unknown' and old.get(k) != v for k, v in new.items() if k != 'source_turn_ids')
                    replaced = replaced or ('coordinates' in old and 'coordinates' not in new)
                    if replaced:
                        # Changed known facts require additional caller evidence, not reinterpreted old turns.
                        group_sources = set(sources(new))
                        for item in content['unknown_fields']:
                            if item['field'].startswith(f'/{group}/'):
                                group_sources.update(item['source_turn_ids'])
                        if not group_sources - old_callers:
                            raise ValueError('replacing known facts requires new verified caller evidence')
                        changed_known = True
                location = content['reported_location']
                if location['description'] != previous['reported_location']['description'] and 'coordinates' in location:
                    if not set(location['coordinates']['source_turn_ids']) - old_callers:
                        raise ValueError('changed location needs newly supported coordinates or coordinates omitted')
            now = datetime.now(timezone.utc).isoformat()
            review = 'needs_review' if correction or changed_known or not (
                content['reported_location']['description'] is not None or 'coordinates' in content['reported_location']
            ) or any(u['reason'] == 'conflicting' for u in content['unknown_fields']) else 'pending_review'
            if previous and previous['review_status'] == 'needs_review':
                review = 'needs_review'
            if previous and review != previous['review_status']:
                changed.append('/review_status')
            report = {
                'schema_version': '1.0.0', 'simulated': True,
                'report_id': previous['report_id'] if previous else str(uuid4()),
                'provider_call_id': key[1], 'version': previous['version'] + 1 if previous else 1,
                'created_at': previous['created_at'] if previous else now, 'updated_at': now,
                'transcript': transcript, **content, 'review_status': review,
                'revisions': deepcopy(previous['revisions']) if previous else [],
            }
            if previous is None:
                changed = ['/provider_call_id', '/transcript', *[f'/{n}' for n in CONTENT_FIELDS], '/review_status']
            report['revisions'].append({
                'version': report['version'], 'recorded_at': now,
                'kind': 'created' if previous is None else 'correction' if correction else 'updated',
                'changed_fields': sorted(changed), 'source_turn_ids': sorted(set(sources(content))),
                'note': 'Authenticated simulated intake update; interpretations require human review.',
            })
            validate_snapshot(report)
            return report

        previous = storage.current(key)
        if update.expected_version != (previous['version'] if previous else 0):
            saved = storage.receipt(key, update.operation_id, fingerprint)
            if saved is not None:
                return saved
            raise StoreConflict('stale expected_version; read report context and reconcile')
        snapshot = build(previous)
        return storage.apply(key, update.operation_id, fingerprint, update.expected_version, snapshot)
    except StoreConflict as exc:
        raise HTTPException(409, str(exc)) from None
    except ValidationError as exc:
        raise HTTPException(422, f"incident contract violation at /{'/'.join(map(str, exc.absolute_path))}") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
