"""Use the agreed JSON Schema, plus the semantic rules documented beside it."""

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[1] / 'contracts/incident/incident.schema.json').read_text()
)
CONTENT_FIELDS = ('summary', 'reported_location', 'people_affected', 'hazards', 'unknown_fields')
CONTENT_SCHEMA = {
    '$schema': SCHEMA['$schema'], '$defs': SCHEMA['$defs'], 'type': 'object',
    'additionalProperties': False, 'required': list(CONTENT_FIELDS),
    'properties': {name: SCHEMA['properties'][name] for name in CONTENT_FIELDS},
}
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
CONTENT_VALIDATOR = Draft202012Validator(CONTENT_SCHEMA, format_checker=FormatChecker())


def sources(value):
    if isinstance(value, dict):
        yield from value.get('source_turn_ids', [])
        for child in value.values():
            yield from sources(child)
    elif isinstance(value, list):
        for child in value:
            yield from sources(child)


def validate_snapshot(report):
    VALIDATOR.validate(report)
    turns = report['transcript']
    callers = {t['turn_id'] for t in turns if t['speaker'] == 'caller'}
    if len({t['turn_id'] for t in turns}) != len(turns):
        raise ValueError('duplicate transcript turn IDs')
    if not set(sources(report)) <= callers:
        raise ValueError('evidence must reference verified caller turns from this call')
    unresolved = set()
    for group in ('reported_location', 'people_affected', 'hazards'):
        for field, value in report[group].items():
            if value is None or (field == 'precision' and value == 'unknown'):
                unresolved.add(f'/{group}/{field}')
    location = report['reported_location']
    if 'coordinates' not in location:
        unresolved.add('/reported_location/coordinates')
    pointers = [item['field'] for item in report['unknown_fields']]
    if len(set(pointers)) != len(pointers) or set(pointers) != unresolved:
        raise ValueError('unknown_fields must exactly match unresolved incident fields')
    for item in report['unknown_fields']:
        if item['reason'] not in ('not_asked', 'not_available') and not item['source_turn_ids']:
            raise ValueError('caller uncertainty or conflict needs verified caller evidence')
    has_location = location['description'] is not None or 'coordinates' in location
    if (location['precision'] == 'unknown') == has_location:
        raise ValueError('location precision does not match available location')
    if location['precision'] == 'coordinates' and 'coordinates' not in location:
        raise ValueError('coordinate precision requires coordinates')
    if location['precision'] not in ('unknown', 'coordinates') and location['description'] is None:
        raise ValueError('descriptive location precision requires a description')
    if has_location and not location['source_turn_ids']:
        raise ValueError('known location needs caller evidence')
    for name in ('people_affected', 'hazards'):
        group = report[name]
        if any(v is not None for k, v in group.items() if k != 'source_turn_ids') and not group['source_turn_ids']:
            raise ValueError(f'{name} needs caller evidence')
    if report['people_affected']['count'] == 0 and (
        report['people_affected']['includes_children'] is True or report['hazards']['trapped_people'] is True
    ):
        raise ValueError('zero people conflicts with children or trapped people')
    coords = location.get('coordinates')
    if coords and coords['source'] == 'caller' and not coords['source_turn_ids']:
        raise ValueError('caller coordinates need caller evidence')
