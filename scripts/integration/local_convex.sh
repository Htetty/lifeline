#!/usr/bin/env bash
# Run a command against a disposable local Convex backend (no account, never the shared
# deployment). Pushes dashboard/convex/*, sets test-only secrets, runs the command, stops.
#
#   scripts/integration/local_convex.sh backend/.venv/bin/python -m unittest discover -s backend/tests -v
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/dashboard"

if grep -qs '^CONVEX_DEPLOYMENT=' .env.local && ! grep -qs '^CONVEX_DEPLOYMENT=anonymous:' .env.local; then
  echo "dashboard/.env.local points at a non-local deployment; refusing to run." >&2
  exit 1
fi
if [ -n "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "CONVEX_DEPLOY_KEY is set; refusing to run so nothing is pushed to a shared deployment." >&2
  exit 1
fi

log="$(mktemp -t lifeline-convex.XXXXXX)"
# Own ports, so another local backend (e.g. a teammate's on 3210) is left alone.
port="${LIFELINE_LOCAL_CONVEX_PORT:-3310}"
config=.convex/local/default/config.json
if [ -f "$config" ]; then  # the CLI reuses saved ports over the flags
  sed -i '' -E "s/\"cloud\":[0-9]+/\"cloud\":$port/; s/\"site\":[0-9]+/\"site\":$((port + 1))/" "$config"
fi
CONVEX_AGENT_MODE=anonymous npx convex dev --tail-logs disable --typecheck disable \
  --local-cloud-port "$port" --local-site-port "$((port + 1))" >"$log" 2>&1 &
convex_pid=$!
storage="$PWD/.convex/local"
stop() {
  kill $convex_pid 2>/dev/null || true; wait $convex_pid 2>/dev/null || true
  # The CLI leaves its backend binary running; stop only the one using this checkout's storage.
  for _ in $(seq 1 20); do
    pkill -f -- "--local-storage $storage" 2>/dev/null || break
    sleep 0.5
  done
  rm -f "$log"
}
trap stop EXIT

for _ in $(seq 1 120); do
  grep -q "Convex functions ready" "$log" && break
  if ! kill -0 $convex_pid 2>/dev/null; then cat "$log" >&2; exit 1; fi
  sleep 1
done
grep -q "Convex functions ready" "$log" || { cat "$log" >&2; exit 1; }

url="$(sed -n 's/^NEXT_PUBLIC_CONVEX_URL=//p' .env.local)"
case "$url" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "Unexpected Convex URL $url" >&2; exit 1 ;; esac

# Test-only values for the throwaway backend.
export CONVEX_URL="$url"
export BACKEND_SECRET="local-test-backend-secret"
export DISPATCHER_TOKEN="local-test-dispatcher"
export VOICE_BRIDGE_TOKEN="local-test-voice-token"
npx convex env set BACKEND_SECRET "$BACKEND_SECRET" >/dev/null
npx convex env set DISPATCHER_TOKEN "$DISPATCHER_TOKEN" >/dev/null

cd "$root"
"$@"
