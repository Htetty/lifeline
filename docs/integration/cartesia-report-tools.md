# Cartesia report-tool checkpoint

The existing Twilio greeting and Managed Agent conversation remain unchanged.
This adds two authenticated FastAPI webhook endpoints and local memory storage.
No provider configuration has been applied, no Convex files changed, and the
existing three modified files under `docs/voice/` are preserved as found.

## Verified provider behavior and limits

Documentation checked October 23, 2026, starting with
[llms.txt](https://docs.cartesia.ai/llms.txt):

- [Webhook tools](https://docs.cartesia.ai/agents/webhook-tools): public HTTPS,
  stored bearer authentication, dynamic headers, response assignments. These
  requests use our tool token; that token is separate from a Cartesia API key.
- [Dynamic variables](https://docs.cartesia.ai/agents/dynamic-variables):
  `system__conversation_id` is the Cartesia call ID. Inject it as a runtime header,
  never as an argument the model chooses. Caller phone numbers are not call IDs.
- [Get Call](https://docs.cartesia.ai/api-reference/agents/calls/get-call): returns
  identity and optional transcript. Roles are `user`, `assistant`, `system`;
  timestamps are seconds relative to call start. Only actual user/assistant text
  becomes contract turns. IDs are derived by the backend; absolute timestamps
  use provider start time plus provider offsets. No speech or timestamp is
  invented from a tool summary. Null text/tool-only/system entries are omitted.
- **Live transcript availability is not guaranteed by these docs.** There is no
  documented automatic full-transcript webhook body or transcript system variable.
  Get Call's transcript can be absent, redacted, or unavailable under ZDR. Local
  tests use explicitly fictional provider fixtures. A real active-call lookup is
  required before claiming this works during a call. If evidence is absent, the
  context tool returns `ready:false, saved:false, retryable:true` and saves nothing.
  The agent should ask the next useful question and retry after the caller's answer,
  rather than invent evidence or loop. The diagnostic has since confirmed live
  transcript availability for this account; see [results](transcript-diagnostic.md).
  Post-call reconciliation is not built.
- [Tool creation schema](https://docs.cartesia.ai/api-reference/agents/tools/create):
  webhook body types are limited and do not express JSON Schema nullable unions.
  Therefore `content_json` is a JSON **string** preserving actual null values,
  validated by our contract after decoding. Runtime-filled fields are excluded
  from the provider's `required` list but required by FastAPI after injection.
- [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions): outbound
  SDK lookups use HTTPS, bearer API-key auth and `Cartesia-Version: 2026-08-14`.
  Provider errors are mapped to a generic 502 without exposing sensitive bodies.

## Run and verify locally

From the repository root:

```bash
source .venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
python -m unittest discover -s backend -v
```

Set three server environment variables through your normal secret manager or
local shell: `REPORT_TOOL_TOKEN`, `CARTESIA_API_KEY`, `CARTESIA_AGENT_ID`. The
commented `.env.example` documents them; `.env` is ignored but is not loaded by
this app. Never paste credentials into chat, commit them, or use NEXT_PUBLIC_*.
Use a long random tool token; enter the same value in Cartesia's stored webhook
bearer secret. The provider API key belongs only on FastAPI, not in the tool body.

Start **one process**, with no reload for a call test:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
ngrok http 8000
```

Run ngrok in a second terminal. Without variables the greeting and health still
work, but report tools return 503. Memory disappears on restart and is separate
in each worker; it is not production or Convex persistence. Keep calls short:
context fails explicitly above 15,000 response bytes to avoid Cartesia's 16 KiB
truncation limit. No report/transcript is exposed by an unauthenticated read.

## Endpoint contract

Both routes require `Authorization: Bearer <REPORT_TOOL_TOKEN>` and
`X-Cartesia-Call-Id: <runtime system__conversation_id>`.

- `GET /tools/report-context`: verifies provider identity and fetches transcript;
  returns `ready:true`, `operation_id`, `expected_version`, `report_id`, `content`,
  `transcript`. Initially unavailable speech instead returns HTTP 200 with
  `ready:false`, `saved:false`, `retryable:true`, a code and retry instructions.
  No operation/version is assigned on that response. This preserves the guidance
  in Cartesia's textual tool result instead of relying on a generic HTTP error.
  Initial `content` is a null/unknown template. Copy its structure and cite the
  returned caller turn IDs. Refresh before each new update, not during an exact
  retry. Report content represents the current snapshot, not unsaved speech.
- `POST /tools/report-update`: accepts `operation_id`, `expected_version`,
  `correction` (boolean), and `content_json` (JSON text). No extra top-level keys.
  Content has exactly `summary`, `reported_location`, `people_affected`, `hazards`,
  `unknown_fields`, with the shapes defined by the incident contract. It is a
  complete replacement of interpreted fields, not a patch: carry forward prior
  facts, uncertainty and references. Do not send transcript, report IDs, provider
  IDs, versions or review state inside content.
- `GET /tools/report-state`: authenticated operator inspection of the current
  stored report and full snapshot history. Uses the same bearer/call-ID headers,
  reads only the existing memory adapter, and makes no provider lookup. It stays
  readable after hangup while this process runs. Do not configure it as an agent
  tool. It returns 404 when no report exists and exposes no unauthenticated data.

The server verifies the call again and copies provider speech, never speech
supplied by the model. It validates source IDs against caller turns in this call.
A changed known value requires additional verified caller evidence. Such changes
are conservatively flagged `needs_review`, even if the model omits the correction
flag; only explicit corrections use revision kind `correction`. Earlier snapshots, transcript and revision
entries remain intact. Caller-derived coordinates need evidence; synthetic fixture
coordinates are prohibited on this live tool. Unknown stays null, not false/zero.

Success is HTTP 200 with `{report_id, version, review_status, storage: "memory"}`.
Exact retries with the same operation key and content return the original result,
even after newer revisions. Key reuse with changed content, stale versions or
changed provider transcript prefixes returns 409. Contract/evidence violations
return 422; authorization failures return 401/403; missing config returns 503;
provider lookup failures return 502. Rejected operations do not mutate storage.
A successful response acknowledges temporary demo storage, not dispatch or human
verification. Missing provider transcript may require a future ingestion design;
never work around it by having the model recreate transcript evidence.

## Exact Cartesia setup after local checks

1. Keep Twilio routing, the existing agent model/voice, welcome message and system
   prompt unchanged. Record the existing agent version for rollback. Ensure the
   backend key can read that agent's calls; check transcript retention/ZDR policy.
2. Generate the two reviewable tool-definition payloads locally:

   ```bash
   python -m backend.tool_config https://YOUR-TUNNEL-HOST
   ```

   This prints placeholders, never reads secrets, and makes no provider requests.
   Each array entry is one body for `POST https://api.cartesia.ai/v1/agents/tools`.
   Alternatively configure the same fields in the Playground Tools UI. Creation
   requests require server-side Cartesia bearer auth and version `2026-08-14`.
3. Create `get_report_context`: method GET, URL ending `/tools/report-context`.
   Set `X-Cartesia-Call-Id` to a **dynamic-variable header** with name
   `system__conversation_id`. Set bearer authentication to the stored tool token.
   Use immediate execution, pre-tool speech off, timeout 20 seconds. Assign the
   response's `expected_version` to `report_version` and `operation_id` to
   `report_operation_id`.
4. Create `update_simulated_report`: method POST, URL ending `/tools/report-update`.
   Use the same header, auth and execution settings. Use the generated body schema:
   `operation_id` comes from dynamic variable `report_operation_id`;
   `expected_version` comes from `report_version`. The model supplies only
   `correction` and `content_json`. Assign successful response `version` back to
   `report_version`. Do not put runtime-filled fields in Cartesia's required list.
5. Attach both new tools to the existing agent, preserving every existing tool
   and the end-call system tool. **Updating `config.tools` replaces its entire
   list.** Do not blindly PATCH a list containing only these two new IDs.
   [Tool attachment semantics](https://docs.cartesia.ai/agents/tools)
6. Use the generated tool descriptions to instruct context-before-write and
   evidence/correction/retry behavior; no rewrite of the working prompt is needed
   for this checkpoint. Actual tool selection and the descriptions' compatibility
   with the current prompt must be confirmed on a call. Do not claim reports are
   durable or dispatch has occurred. A later explicit prompt edit belongs to the
   voice owner; this change does not apply it.
7. Call the existing number. Say: “For the demo, water is rising inside a building
   at 18 Juniper Lane in fictional Millhaven. Four people are affected, including
   one child.” After a follow-up, say: “Correction: the house number is 81, not 18,
   and there are three people, not four. The other details are unchanged.” Finish
   normally. Inspect tool results in Cartesia Calls: same report ID, increasing
   version, correction flagged for review. A subsequent context read during that
   call shows saved content and retained original speech. Replaying the identical
   update must return the same version. The memory adapter retains full snapshots
   for adapter inspection/tests. The operator can read `/tools/report-state` with
   the same authenticated headers; there is no dashboard or unauthenticated API.

If context returns `ready:false` because active-call speech is not yet available,
ask the next useful question and retry after the caller finishes. Do not write
until `ready:true`; never invent evidence. The real transcript diagnostic has
confirmed that this account's caller turns appear during a call and remain after
hangup. If a future test never yields live evidence, check Get Call after hangup
and consider post-call ingestion instead.

## Local coverage and pending integration

Offline tests cover existing TwiML, bearer auth, runtime identity verification,
provider timestamp mapping, missing/redacted/ZDR evidence, contract examples,
partial→complete→corrected snapshots, no-op and exact retries, retry collisions,
stale versions, concurrent delivery, separate calls, fabricated/assistant
references, provider transcript rewrites, and the official SDK's HTTPS path,
bearer and single version header. They do not prove live Cartesia delivery,
transcript freshness, tool schema acceptance, model tool selection, or call audio.

The proposed [storage handoff](report-storage.md) is ready for the Convex owner.
Their atomic adapter, durable receipts/history, authorization and deployment remain
pending; none are simulated as completed here.
