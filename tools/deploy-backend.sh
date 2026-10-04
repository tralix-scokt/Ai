#!/usr/bin/env bash
# ============================================================================
# Deploy the TRALIX backend without CI.
#
#   ./tools/deploy-backend.sh                 # Cloudflare Workers (default)
#   ./tools/deploy-backend.sh --node          # print the self-host command
#
# The OpenAI key must already be in the environment. This script never writes it
# to a file and never echoes it.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGIN="${TRALIX_ALLOWED_ORIGINS:-https://tralix-scokt.github.io}"

if [ "${1:-}" = "--node" ]; then
  cat <<EOF
Self-host the TRALIX backend (no Cloudflare account needed):

  OPENAI_API_KEY=… TRALIX_ALLOWED_ORIGINS="$ORIGIN" node server/node.js --static

Then set the same URL in ./backend.json ({"url": "https://your-host"}) and push.
EOF
  exit 0
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "error: OPENAI_API_KEY is not set in this shell." >&2
  echo "       export it first (it is never written to disk by this script)." >&2
  exit 1
fi

cd "$ROOT/server"

echo "→ deploying the worker (allowed origins: $ORIGIN)"
npx --yes wrangler deploy worker.js \
  --name tralix-backend \
  --var "TRALIX_ALLOWED_ORIGINS:$ORIGIN" \
  --var "TRALIX_ENABLE_WEB_SEARCH:${TRALIX_ENABLE_WEB_SEARCH:-false}"

echo "→ storing the key as an encrypted worker secret"
printf '%s' "$OPENAI_API_KEY" | npx --yes wrangler secret put OPENAI_API_KEY

echo
echo "→ verifying"
npx --yes wrangler deployments list | head -5
echo
echo "Now put the worker URL in $ROOT/backend.json (\"url\") and push."
