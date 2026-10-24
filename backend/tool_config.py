"""Print reviewable Cartesia tool definitions with placeholders, never live secrets.

Usage: python -m backend.tool_config https://YOUR-TUNNEL-HOST
No provider configuration is changed by this command.
"""

import json
import sys
from urllib.parse import urlsplit

def definitions(base_url):
    parsed = urlsplit(base_url)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('supply only a public HTTPS origin')
    common = {
        'type': 'webhook', 'pre_tool_speech': 'off',
        'execution_mode': 'immediate', 'response_timeout_secs': 20,
    }
    api = {
        'request_headers': {
            'X-Cartesia-Call-Id': {'type': 'dynamic_variable', 'name': 'system__conversation_id'},
        },
        'authentication': {
            'mode': 'bearer', 'token': {'type': 'secret', 'secret_value': 'REPLACE_WITH_REPORT_TOOL_TOKEN'},
        },
    }
    return [
        {
            **common, 'name': 'get_report_context',
            'description': 'Read verified caller transcript and current simulated report after the first incident details and before each update or correction. Never invent transcript, turn IDs, or call IDs. If ready=false, nothing was saved: ask the next useful intake question, wait for the caller to finish, then retry this tool. Do not call the update tool until ready=true, and do not loop on unavailable evidence.',
            'api_schema': {**api, 'url': base_url.rstrip('/') + '/tools/report-context', 'method': 'GET'},
            'assignments': [
                {'dynamic_variable': 'report_version', 'value_path': 'expected_version'},
                {'dynamic_variable': 'report_operation_id', 'value_path': 'operation_id'},
            ],
        },
        {
            **common, 'name': 'update_simulated_report',
            'description': 'After get_report_context succeeds, send a complete replacement of interpreted content using only verified caller turn IDs from that result. Carry forward unchanged facts and evidence. Unknown is null, never zero or false. Use correction=true for explicit caller corrections. This saves a temporary demo report for review; it never dispatches help. On errors do not claim success; on 409 refresh context and reconcile. Retry an uncertain request unchanged before starting another update.',
            'api_schema': {
                **api, 'url': base_url.rstrip('/') + '/tools/report-update', 'method': 'POST',
                'request_body_schema': {
                    'type': 'object',
                    'properties': {
                        'operation_id': {'type': 'string', 'dynamic_variable': 'report_operation_id'},
                        'expected_version': {'type': 'integer', 'dynamic_variable': 'report_version'},
                        'correction': {'type': 'boolean', 'description': 'True only for an explicit caller correction; unresolved conflicts remain unknown with reason conflicting.'},
                        # Cartesia's WebhookBodyParam has no nullable/anyOf type.
                        # Send JSON text so nulls reach the contract validator intact.
                        'content_json': {
                            'type': 'string',
                            'description': 'JSON text of the complete content object returned by get_report_context, edited using verified caller evidence only. Keep keys summary, reported_location, people_affected, hazards, unknown_fields. Keep summary.generated_by=model. Set each source_turn_ids to IDs of actual caller turns from context. Unknown answers are JSON null. unknown_fields must list every unresolved field once using JSON Pointer, a reason (not_asked, caller_unsure, unintelligible, conflicting, not_available), and source_turn_ids. Remove entries when known; omitted coordinates need /reported_location/coordinates, reason not_available. Omit coordinates unless explicitly spoken. Never invent transcript or report metadata; never include review_status. Preserve prior details unless corrected. This parameter is a JSON string, not an object.',
                        },
                    },
                    # Runtime-filled fields are omitted from required per Cartesia docs.
                    'required': ['correction', 'content_json'],
                },
            },
            'assignments': [{'dynamic_variable': 'report_version', 'value_path': 'version'}],
        },
    ]


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python -m backend.tool_config https://YOUR-TUNNEL-HOST')
    print(json.dumps(definitions(sys.argv[1]), indent=2))
