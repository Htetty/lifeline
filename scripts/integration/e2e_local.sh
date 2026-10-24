#!/usr/bin/env bash
# Start the backend and dashboard against a disposable local Convex backend, then run the
# fictional end-to-end walkthrough. Uses live Claude and map search; ANTHROPIC_API_KEY must be
# exported (it is never written to disk or logged). Output goes to the directory given as $1.
#
#   ANTHROPIC_API_KEY=... scripts/integration/e2e_local.sh /path/to/output
set -euo pipefail
out="${1:?output directory}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
: "${ANTHROPIC_API_KEY:?export ANTHROPIC_API_KEY for live extraction}"

exec "$root/scripts/integration/local_convex.sh" bash -c '
  set -euo pipefail
  api_port=8110; web_port=3300
  mkdir -p "'"$out"'"
  (cd backend && exec .venv/bin/uvicorn app.main:app --port $api_port) >"'"$out"'/backend.log" 2>&1 &
  api=$!
  (cd dashboard && exec npx next dev -p $web_port) >"'"$out"'/dashboard.log" 2>&1 &
  web=$!
  trap "kill $api $web 2>/dev/null || true; pkill -f \"next dev -p $web_port\" 2>/dev/null || true" EXIT
  backend/.venv/bin/python -c "
from convex import ConvexClient; import os
c = ConvexClient(os.environ[\"CONVEX_URL\"]); t = {\"dispatcherToken\": os.environ[\"DISPATCHER_TOKEN\"]}
c.mutation(\"exercise:reset\", t)"  # local throwaway data only (see local_convex.sh)
  for _ in $(seq 1 90); do
    curl -sf localhost:$api_port/health >/dev/null && curl -sf -o /dev/null localhost:$web_port && break
    sleep 1
  done
  backend/.venv/bin/python scripts/integration/e2e_flow.py \
    --api http://localhost:$api_port --dashboard http://localhost:$web_port --out "'"$out"'"
'
