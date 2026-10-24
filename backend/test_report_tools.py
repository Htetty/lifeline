"""Offline contract, trust-boundary, concurrency, and retry checks."""

import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import httpx
from cartesia import Cartesia
from fastapi.testclient import TestClient
from fastapi import HTTPException

from backend.main import app
from backend.report_contract import CONTENT_FIELDS, VALIDATOR, validate_snapshot
from backend.report_store import MemoryReportStore
from backend.report_tools import get_store, retrieve_call
from backend.tool_config import definitions

ROOT = Path(__file__).resolve().parents[1] / 'contracts/incident/examples'


def fixture(name):
    return json.loads((ROOT / f'{name}.json').read_text())


def provider_call(report):
    from datetime import datetime
    start = datetime.fromisoformat('2026-10-23T18:00:00+00:00')
    return {
        'id': 'call-test', 'agent_id': 'agent-test', 'agent_version_id': 'version-test',
        'status': 'started', 'zdr_enabled': False, 'start_time': start.isoformat(),
        'transcript': [{
            'role': 'user' if t['speaker'] == 'caller' else 'assistant',
            'start_timestamp': (datetime.fromisoformat(t['recorded_at'].replace('Z', '+00:00')) - start).total_seconds(),
            'end_timestamp': (datetime.fromisoformat(t['recorded_at'].replace('Z', '+00:00')) - start).total_seconds() + 1,
            'text': t['text'],
        } for t in report['transcript']],
    }


class ReportToolsTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            'REPORT_TOOL_TOKEN': 'test-tool-token', 'CARTESIA_API_KEY': 'test-provider-key',
            'CARTESIA_AGENT_ID': 'agent-test',
        })
        self.env.start()
        self.storage = MemoryReportStore()
        app.dependency_overrides[get_store] = lambda: self.storage
        self.client = TestClient(app)
        self.headers = {'Authorization': 'Bearer test-tool-token', 'X-Cartesia-Call-Id': 'call-test'}
        self.provider = patch('backend.report_tools.retrieve_call', return_value=provider_call(fixture('partial-report')))
        self.lookup = self.provider.start()
        self.addCleanup(self.provider.stop)
        self.addCleanup(self.env.stop)
        self.addCleanup(app.dependency_overrides.clear)

    def context(self):
        return self.client.get('/tools/report-context', headers=self.headers)

    def payload(self, name='partial-report', version=0, operation='operation-1'):
        report = fixture(name)
        self.lookup.return_value = provider_call(report)
        context = self.context()
        self.assertEqual(context.status_code, 200, context.text)
        mapping = {old['turn_id']: new['turn_id'] for old, new in zip(report['transcript'], context.json()['transcript'])}
        content = {name: deepcopy(report[name]) for name in CONTENT_FIELDS}

        def remap(value):
            if isinstance(value, dict):
                if 'source_turn_ids' in value:
                    value['source_turn_ids'] = [mapping[item] for item in value['source_turn_ids']]
                for child in value.values():
                    remap(child)
            elif isinstance(value, list):
                for child in value:
                    remap(child)
        remap(content)
        if 'coordinates' in content['reported_location']:
            del content['reported_location']['coordinates']
            content['unknown_fields'].append({'field': '/reported_location/coordinates', 'reason': 'not_available', 'source_turn_ids': []})
        return {'operation_id': operation, 'expected_version': version, 'correction': name == 'corrected-report', 'content': content}

    def post(self, payload):
        wire = {k: v for k, v in payload.items() if k != 'content'}
        wire['content_json'] = json.dumps(payload['content'])
        return self.client.post('/tools/report-update', headers=self.headers, json=wire)

    def test_authentication_and_disabled_configuration(self):
        self.assertEqual(self.client.get('/tools/report-context').status_code, 401)
        self.assertEqual(self.client.post('/tools/report-update', json=self.payload(), headers={'Authorization': 'Bearer wrong'}).status_code, 401)
        self.lookup.reset_mock()
        with patch.dict(os.environ, {'REPORT_TOOL_TOKEN': ''}):
            self.assertEqual(self.context().status_code, 503)
        self.lookup.assert_not_called()

    def test_runtime_identity_and_agent_are_verified(self):
        self.lookup.return_value['agent_id'] = 'another-agent'
        self.assertEqual(self.context().status_code, 403)
        self.lookup.return_value['agent_id'] = 'agent-test'
        self.lookup.return_value['id'] = 'different-call'
        self.assertEqual(self.context().status_code, 403)
        self.headers.pop('X-Cartesia-Call-Id')
        self.assertEqual(self.context().status_code, 422)

    def test_missing_redacted_or_zdr_evidence_fails_closed(self):
        for changes in [{'transcript': None}, {'transcript': []}, {'start_time': None}, {'zdr_enabled': True}, {'redacted_at': '2026-10-23T18:00:00Z'}]:
            self.lookup.return_value = {**provider_call(fixture('partial-report')), **changes}
            response = self.context()
            if changes.get('zdr_enabled') or changes.get('redacted_at'):
                self.assertEqual(response.status_code, 409)
            else:
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.json()['ready'])
                self.assertTrue(response.json()['retryable'])
        self.assertIsNone(self.storage.current(('cartesia:agent-test', 'call-test')))

    def test_initially_null_transcript_recovers_after_more_conversation(self):
        self.lookup.return_value['transcript'] = None
        pending = self.context()
        self.assertFalse(pending.json()['ready'])
        self.assertFalse(pending.json()['saved'])
        self.assertNotIn('operation_id', pending.json())
        self.assertIsNone(self.storage.current(('cartesia:agent-test', 'call-test')))
        payload = self.payload()
        self.assertTrue(self.context().json()['ready'])
        self.assertEqual(self.post(payload).status_code, 200)

    def test_authenticated_report_remains_readable_without_provider_after_hangup(self):
        self.assertEqual(self.post(self.payload()).status_code, 200)
        self.lookup.side_effect = RuntimeError('stored report inspection must not call provider')
        response = self.client.get('/tools/report-state', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['snapshots']), 1)
        self.assertEqual(response.json()['report']['version'], 1)
        self.assertEqual(self.client.get('/tools/report-state').status_code, 401)

    def test_model_cannot_supply_identity_transcript_or_review_authority(self):
        for name, value in [('call_id', 'invented'), ('transcript', []), ('report_id', 'invented'), ('review_status', 'reviewed')]:
            payload = self.payload()
            payload[name] = value
            self.assertEqual(self.post(payload).status_code, 422)
        payload = self.payload()
        payload['content']['review_status'] = 'reviewed'
        self.assertEqual(self.post(payload).status_code, 422)

    def test_create_preserves_provider_speech_and_contract(self):
        payload = self.payload()
        response = self.post(payload)
        self.assertEqual(response.status_code, 200, response.text)
        current = self.storage.current(('cartesia:agent-test', 'call-test'))
        validate_snapshot(current)
        self.assertEqual(current['provider_call_id'], 'call-test')
        self.assertTrue(current['simulated'])
        self.assertEqual(current['transcript'][1]['text'], fixture('partial-report')['transcript'][1]['text'])
        self.assertEqual(current['transcript'][1]['recorded_at'], '2026-10-23T18:00:08+00:00')
        self.assertIsNone(current['people_affected']['count'])

    def test_partial_complete_and_correction_keep_one_report_and_all_snapshots(self):
        responses = []
        for index, name in enumerate(['partial-report', 'complete-report', 'corrected-report']):
            response = self.post(self.payload(name, index, f'op-{index}'))
            self.assertEqual(response.status_code, 200, response.text)
            responses.append(response.json())
        history = self.storage.history(('cartesia:agent-test', 'call-test'))
        self.assertEqual(len({r['report_id'] for r in responses}), 1)
        self.assertEqual([r['version'] for r in history], [1, 2, 3])
        self.assertEqual(history[2]['transcript'][:4], history[1]['transcript'])
        self.assertEqual(history[2]['revisions'][:-1], history[1]['revisions'])
        self.assertEqual(history[2]['people_affected']['count'], 3)
        self.assertEqual(history[2]['reported_location']['description'], '81 Juniper Lane, fictional Millhaven')
        self.assertEqual(history[2]['review_status'], 'needs_review')
        for report in history:
            validate_snapshot(report)

    def test_exact_retry_returns_original_receipt_even_after_correction(self):
        first = self.payload()
        response = self.post(first)
        self.post(self.payload('complete-report', 1, 'op-2'))
        self.lookup.side_effect = RuntimeError('retry should not need provider lookup')
        retry = self.post(first)
        self.assertEqual(retry.json(), response.json())
        self.assertEqual(len(self.storage.history(('cartesia:agent-test', 'call-test'))), 2)

    def test_retry_key_collision_and_stale_update(self):
        payload = self.payload()
        self.assertEqual(self.post(payload).status_code, 200)
        collision = deepcopy(payload)
        collision['correction'] = True
        self.assertEqual(self.post(collision).status_code, 409)
        payload['operation_id'] = 'another-operation'
        self.assertEqual(self.post(payload).status_code, 409)
        payload['expected_version'] = 1
        self.assertEqual(self.post(payload).status_code, 200)  # no-op, no new version
        self.assertEqual(len(self.storage.history(('cartesia:agent-test', 'call-test'))), 1)

    def test_concurrent_retries_create_one_snapshot(self):
        payload = self.payload()
        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda _: self.post(payload), range(12)))
        self.assertTrue(all(r.status_code == 200 for r in responses), [r.text for r in responses])
        self.assertEqual(len(self.storage.history(('cartesia:agent-test', 'call-test'))), 1)

    def test_two_calls_never_share_report(self):
        first = self.post(self.payload()).json()
        self.headers['X-Cartesia-Call-Id'] = 'second-call'
        self.lookup.return_value['id'] = 'second-call'
        # Same content and operation key are scoped to the verified call.
        payload = {'operation_id': 'operation-1', 'expected_version': 0, 'correction': False,
                   'content': {name: fixture('partial-report')[name] for name in CONTENT_FIELDS}}
        context = self.context().json()
        caller_id = context['transcript'][1]['turn_id']
        for group in ('summary', 'reported_location', 'hazards'):
            payload['content'][group]['source_turn_ids'] = [caller_id]
        second = self.post(payload)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertNotEqual(first['report_id'], second.json()['report_id'])

    def test_rejects_assistant_or_invented_evidence_and_bad_unknowns(self):
        for reference in ['invented', 'assistant']:
            payload = self.payload()
            payload['content']['summary']['source_turn_ids'] = [self.context().json()['transcript'][0]['turn_id'] if reference == 'assistant' else reference]
            self.assertEqual(self.post(payload).status_code, 422)
        payload = self.payload()
        payload['content']['unknown_fields'] = []
        self.assertEqual(self.post(payload).status_code, 422)
        self.assertEqual(self.storage.history(('cartesia:agent-test', 'call-test')), [])

    def test_no_rewriting_or_truncating_saved_transcript(self):
        self.assertEqual(self.post(self.payload()).status_code, 200)
        payload = self.payload('complete-report', 1, 'op-2')
        self.lookup.return_value['transcript'][1]['text'] = 'Provider revised old text'
        self.assertEqual(self.post(payload).status_code, 409)
        self.assertEqual(len(self.storage.history(('cartesia:agent-test', 'call-test'))), 1)

    def test_known_fact_replacement_without_new_evidence_is_rejected(self):
        payload = self.payload('complete-report')
        self.assertEqual(self.post(payload).status_code, 200)
        payload.update(operation_id='op-2', expected_version=1)
        payload['content']['people_affected']['count'] = 17
        self.assertEqual(self.post(payload).status_code, 422)

    def test_unresolved_conflict_remains_unknown_and_is_not_called_a_correction(self):
        self.assertEqual(self.post(self.payload('complete-report')).status_code, 200)
        payload = self.payload('corrected-report', 1, 'conflict-update')
        payload['correction'] = False
        self.lookup.return_value['transcript'][-1]['text'] = 'One person says three people, another says four. I cannot resolve the conflict.'
        context = self.context().json()
        last_caller = context['transcript'][-1]['turn_id']
        old_caller = context['transcript'][3]['turn_id']
        payload['content']['summary']['source_turn_ids'] = [old_caller, last_caller]
        payload['content']['reported_location'] = deepcopy(self.storage.current(('cartesia:agent-test', 'call-test'))['reported_location'])
        payload['content']['people_affected'].update(count=None, source_turn_ids=[old_caller, last_caller])
        payload['content']['unknown_fields'] = [
            {'field': '/reported_location/coordinates', 'reason': 'not_available', 'source_turn_ids': []},
            {'field': '/people_affected/count', 'reason': 'conflicting', 'source_turn_ids': [old_caller, last_caller]},
        ]
        response = self.post(payload)
        self.assertEqual(response.status_code, 200, response.text)
        report = self.storage.current(('cartesia:agent-test', 'call-test'))
        self.assertIsNone(report['people_affected']['count'])
        self.assertEqual(report['revisions'][-1]['kind'], 'updated')
        self.assertEqual(report['review_status'], 'needs_review')

    def test_coordinates_cannot_be_synthetic_and_known_facts_need_evidence(self):
        payload = self.payload('complete-report')
        payload['content']['reported_location']['coordinates'] = fixture('complete-report')['reported_location']['coordinates']
        payload['content']['unknown_fields'] = []
        self.assertEqual(self.post(payload).status_code, 422)
        payload = self.payload('complete-report')
        payload['content']['people_affected']['source_turn_ids'] = []
        self.assertEqual(self.post(payload).status_code, 422)

    def test_schema_examples_remain_valid(self):
        for path in ROOT.glob('*.json'):
            VALIDATOR.validate(json.loads(path.read_text()))

    def test_concurrent_distinct_writes_cannot_overwrite_each_other(self):
        first = self.payload()
        second = deepcopy(first)
        second['operation_id'] = 'different-operation'
        second['content']['summary']['text'] = 'A different interpretation of the same fictional caller evidence.'
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(self.post, [first, second]))
        self.assertEqual(sorted(r.status_code for r in responses), [200, 409])
        self.assertEqual(len(self.storage.history(('cartesia:agent-test', 'call-test'))), 1)

    def test_missing_malformed_json_and_strict_types(self):
        payload = self.payload()
        wire = {k: v for k, v in payload.items() if k != 'content'}
        for text in ['{invalid', 'null', '[]', '123']:
            wire['content_json'] = text
            self.assertEqual(self.client.post('/tools/report-update', headers=self.headers, json=wire).status_code, 422)
        for key, value in [('expected_version', True), ('correction', 'false')]:
            malformed = deepcopy(payload)
            malformed[key] = value
            self.assertEqual(self.post(malformed).status_code, 422)
        self.assertEqual(self.storage.history(('cartesia:agent-test', 'call-test')), [])

    def test_provider_failure_returns_error_without_commit(self):
        payload = self.payload()
        self.lookup.side_effect = HTTPException(502, 'Cartesia call lookup failed; no update committed')
        self.assertEqual(self.post(payload).status_code, 502)
        self.assertEqual(self.storage.history(('cartesia:agent-test', 'call-test')), [])

    def test_tool_definitions_use_supported_schema_and_runtime_identity(self):
        tools = definitions('https://example.test')
        self.assertEqual([tool['api_schema']['method'] for tool in tools], ['GET', 'POST'])
        for tool in tools:
            self.assertLessEqual(len(tool['description']), 2000)
            self.assertEqual(tool['api_schema']['request_headers']['X-Cartesia-Call-Id'],
                             {'type': 'dynamic_variable', 'name': 'system__conversation_id'})
        body = tools[1]['api_schema']['request_body_schema']
        self.assertEqual(body['properties']['content_json']['type'], 'string')
        self.assertLessEqual(len(body['properties']['content_json']['description']), 1000)
        self.assertNotIn('expected_version', body['required'])
        self.assertNotIn('operation_id', body['required'])
        with self.assertRaises(ValueError):
            definitions('http://example.test')

    def test_official_sdk_lookup_uses_https_bearer_version_and_actual_path(self):
        seen = []
        def handler(request):
            seen.append(request)
            return httpx.Response(200, json=provider_call(fixture('partial-report')))
        def factory(**kwargs):
            return Cartesia(**kwargs, http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        with patch('backend.report_tools.Cartesia', side_effect=factory):
            result = retrieve_call('call-test')
        self.assertEqual(result['id'], 'call-test')
        self.assertEqual(str(seen[0].url), 'https://api.cartesia.ai/agents/calls/call-test')
        self.assertEqual(seen[0].headers['Authorization'], 'Bearer test-provider-key')
        self.assertEqual(seen[0].headers['Cartesia-Version'], '2026-08-14')


if __name__ == '__main__':
    unittest.main()
