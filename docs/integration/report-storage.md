# Report storage handoff for the Convex owner

Status: proposed interface, implemented and tested with the Python memory adapter.
No Convex implementation or teammate agreement is claimed. No Convex files changed.

The interface is `backend.report_store.ReportStore`. FastAPI gets it through
`backend.report_tools.get_store`, which currently returns `MemoryReportStore`.
A future adapter replaces that dependency without changing Twilio or Cartesia.

The key is `(cartesia:<configured agent ID>, verified Cartesia call ID)`. The
Cartesia API key scopes verification to its account. The call ID comes from the
runtime system variable, then Get Call verifies both the returned ID and agent.
Do not key by caller phone, model-generated report ID, or Twilio CallSid supplied
by the model. `provider_call_id` stores the Cartesia call ID, not a Twilio SID.

## Adapter operations

- `current(key) -> snapshot | None`: read the latest complete contract snapshot.
- `history(key) -> list[snapshot]`: read immutable snapshots in version order for
  authenticated operator inspection, including after the call ends.
- `receipt(key, operation_id, fingerprint) -> result | None`: return the original
  successful result for an identical operation; reject reuse with different
  content using `StoreConflict`. The operation ID is a retry key, not identity.
- `apply(key, operation_id, fingerprint, expected_version, snapshot) -> result`:
  atomically check receipt, compare current version, append the immutable
  snapshot when changed, and persist the receipt. Exact retries return the
  original result before checking the expected version. A reused key with
  different content or a stale expected version must fail without any mutation.
  An identical snapshot is a no-op but still records a receipt. A changed snapshot
  increments version by exactly one. Absence of a report means version zero.

`result` is `{report_id, version, review_status, storage}`. Memory uses
`storage: "memory"`; the Convex adapter should use `"convex"`. Return copies from
all reads so application code cannot mutate stored history accidentally.

FastAPI constructs and validates the snapshot before `apply`; the compare-and-set
must still happen in the Convex mutation, not as separate query/write requests.
The Python callback is not sent to Convex: the adapter sends a candidate snapshot
and expected version to an atomic mutation. Generate report IDs on the server.
Concurrent initial requests may generate different candidate IDs; only one may
commit. A retry must get the winner's original receipt.

Suggested records (names are suggestions for the teammate, not a Convex schema):

1. Current report indexed uniquely by provider/agent scope and call ID.
2. Immutable full snapshots indexed by report ID and version.
3. Operation receipts indexed uniquely by scope, call ID and operation ID,
   containing the fingerprint and original response.

All three changes must commit in one transaction. Retain receipts with report
history so delayed retries cannot create another revision. Never overwrite prior
transcripts, summaries, revisions, or evidence. Persist `simulated: true`; model
writes cannot set `reviewed`. Review authority remains a separate future action.

## Contract and trust boundary

The canonical schema is `contracts/incident/incident.schema.json`. FastAPI checks
Draft 2020-12 and date-time formats, exact unknown-field coverage, caller-only
source references, basic location/people consistency, and evidence for known
values. It constructs IDs, timestamps, versions, review state and revision lists.
Snapshots preserve the provider transcript prefix; provider rewrites/truncation
fail with 409 rather than replacing prior evidence. The canonical schema and
examples are unchanged.

Fact entailment is not automatic: valid source IDs establish provenance, not
proof that Claude interpreted the speech correctly. Reports require human review.
No in-memory adapter can test durability, Convex authorization, deployment or
multi-process concurrency. The teammate should run the same create/update/correct,
retry, collision, stale-write and concurrency cases against the durable adapter.
