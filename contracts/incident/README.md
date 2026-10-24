# FloodLine incident contract 1.0.0

This contract describes **simulated, fictional flood reports only**. It is a
data boundary for a future phone assistant, independent of storage, transport,
voice providers, and model vendors. It defines no endpoints or database.

[`incident.schema.json`](incident.schema.json) uses JSON Schema Draft 2020-12.
Validate full report snapshots with date-time format checking enabled. Unknown
properties are rejected to catch misspellings and accidental provider payloads.
`schema_version` identifies this contract; `version` counts changes to one report.

## Values and evidence

- Required answer fields use `null` for unknown. `false` means an explicit
  negative answer; `0` means an explicit count of none. Never default an unasked
  question to either. `count: 0` and `includes_children: false` are valid together.
- `unknown_fields` lists each unresolved incident field exactly once with its
  reason and any supporting caller turns. Include null answer fields, precision
  equal to `unknown`, and omitted coordinates. Do not list known values. It does
  not track metadata or the absence of a generated summary.
- Coordinates are optional: omit the whole object when unavailable. If supplied,
  both latitude and longitude are required. Never use `(0, 0)` as an unknown
  sentinel. Coordinates must be explicitly spoken by the caller or supplied as
  synthetic simulation fixture data; this contract makes no geocoder choice.
- Location precision describes specificity, not reliability. A reported address
  can have `address` precision without coordinates or verification. Use
  `coordinates` for a coordinate-only location; use `unknown` when neither a
  usable description nor coordinates exist. A caller saying “I don't know where
  I am” belongs in the transcript, with location description `null`.
- Preserve caller wording in `transcript` with `speaker: "caller"`. Assistant
  questions remain separate turns. A transcript is recognized speech, not a
  guarantee of transcription accuracy. `summary` is explicitly model-generated;
  facts are current interpretations linked to caller evidence via
  `source_turn_ids`. These group-level references can support several fields.
  Known caller-derived values need supporting caller turns. Synthetic fixture
  coordinates can have empty references. Unresolved conflicts become `null`
  (or omitted coordinates), with reason `conflicting` and all relevant evidence.
- `pending_review` is the default. Use `needs_review` for corrections, unresolved
  conflicts, or unusable locations. Only an explicit human action sets `reviewed`.
  New evidence after review returns the report to `pending_review` or
  `needs_review`. No review status promises verification or emergency response.

## Creation and updates

1. Assign an opaque `report_id` when a simulated report is started. Create version
   1 with `simulated: true`, timestamps, one `created` revision, unknown answers,
   and `pending_review` (or `needs_review` if already flagged). Empty transcript
   and `summary.text: null` are allowed
   before speech. `provider_call_id` is an opaque correlation string, or `null`
   until received. Correlate within the integration's provider/account scope;
   do not deduplicate unrelated calls using an unscoped provider ID.
2. For new evidence, load the current snapshot, append turns with stable unique
   IDs, update interpreted fields, regenerate the summary from cited caller
   turns, and recompute unknowns. Increment `version` by one, set `updated_at`,
   and append one revision listing exactly the changed content fields. Keep
   `report_id`, `created_at`, all earlier turns and all earlier revisions intact.
   A provider call ID may transition from null to a known value; once assigned,
   it is stable for this report. This initial contract covers one report per call.
3. A caller correction updates the **same report**. Append their correction as a
   new turn, point current facts and the revised summary at the correcting
   evidence, append a `correction` revision, and set `needs_review`. Earlier
   statements stay verbatim even when wrong. Retain each previous full snapshot
   so prior facts, model summaries and review decisions remain inspectable.
   Do not infer a correction from a conflicting answer without resolving it;
   preserve both turns and mark the affected value unknown instead.
4. Apply updates only against the expected current version. A stale writer must
   reload and reconcile rather than overwrite newer evidence. Retries of the
   same input must not duplicate turns or create extra versions. The integration
   chooses how to achieve this; the contract assumes no persistence mechanism.

Schema validation checks shape, types, enums and ranges. Consumers must also
check the following semantic rules, which JSON Schema alone cannot express:

- Turn IDs are unique; every source reference resolves to a caller turn in the
  same snapshot. Transcript order and timestamps follow conversation order.
- Unknown-field pointers are unique and exactly match unresolved values.
  Precision is consistent with the available location evidence. A zero people
  count cannot coexist with children or trapped people reported as present.
- Revision versions are consecutive from 1 through `version`; only the first
  revision is `created`. Revision times are nondecreasing; `created_at` equals
  the first revision time and `updated_at` equals the last. Each revision cites
  only evidence available by that revision and lists the fields it changed.
- Across snapshots, identifiers and creation time stay stable, prior transcript
  and revision entries remain unchanged, updates increment by one, and earlier
  snapshots remain available. Review authority and retry handling belong to the
  integration, not the schema validator.

## Fictional examples

Every example has `simulated: true`, synthetic identifiers, invented speech and
fictional locations. Coordinates are deliberately synthetic and must not be
used for navigation or dispatch. They are not a verified address match.

| File | Demonstrates |
| --- | --- |
| [`examples/partial-report.json`](examples/partial-report.json) | Version 1: street only, most answers unknown. |
| [`examples/complete-report.json`](examples/complete-report.json) | Version 2 of the same report: all contract questions answered, including explicit false flags and synthetic coordinates. “Complete” describes data coverage, not verification or closure. |
| [`examples/corrected-report.json`](examples/corrected-report.json) | Version 3 of the same report: caller corrects the house number and people count. Prior turns and revisions remain; unsupported coordinates are removed. |
| [`examples/unknown-location.json`](examples/unknown-location.json) | Separate report: caller cannot identify their location; description is null, precision unknown, coordinates omitted, human review needed. |

For example, in an environment providing Python's `jsonschema[format]` package
(the format extra supplies date-time validation):

```python
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

root = Path("contracts/incident")
schema = json.loads((root / "incident.schema.json").read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema, format_checker=FormatChecker())
for path in sorted((root / "examples").glob("*.json")):
    validator.validate(json.loads(path.read_text()))
```

This validates snapshot structure; apply the semantic and update checks above
as well when integrating. No repository dependency changes are required here.
