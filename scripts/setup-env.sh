#!/usr/bin/env bash
#
# SafeSurf Phase 0 — Ollama environment.
#
# Sets the env vars the plan requires, blocks cloud routing, and tells you to
# restart the Ollama app (the vars only reach processes launched afterwards).
#
#   ./scripts/setup-env.sh
#
# Safe to re-run. Nothing here touches your models.

set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
MODEL='gemma4:e4b'

echo "${BOLD}SafeSurf — Ollama setup${OFF}"
echo ""

# --- env vars --------------------------------------------------------------
echo "Setting launchd environment variables…"

# REQUIRED. A browser extension is an opaque origin; without this every fetch 403s.
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*,safari-web-extension://*"

# Default num_ctx is 4096, too small for a page-level injection scan.
launchctl setenv OLLAMA_CONTEXT_LENGTH 16384

# Enforces the thesis: no accidental fallback to a :cloud variant.
launchctl setenv OLLAMA_NO_CLOUD 1

# One model -> deterministic memory, no swap thrash.
launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
launchctl setenv OLLAMA_NUM_PARALLEL 1

# Avoids a multi-second model load on first use.
launchctl setenv OLLAMA_KEEP_ALIVE 30m

echo "  ${GREEN}✓${OFF} OLLAMA_ORIGINS, OLLAMA_CONTEXT_LENGTH, OLLAMA_NO_CLOUD"
echo "  ${GREEN}✓${OFF} OLLAMA_MAX_LOADED_MODELS, OLLAMA_NUM_PARALLEL, OLLAMA_KEEP_ALIVE"
echo ""

# --- server.json -----------------------------------------------------------
echo "Disabling cloud inference…"
mkdir -p "${HOME}/.ollama"
printf '%s' '{"disable_ollama_cloud": true}' > "${HOME}/.ollama/server.json"
echo "  ${GREEN}✓${OFF} ~/.ollama/server.json"
echo ""

# --- model -----------------------------------------------------------------
echo "Checking model ${MODEL}…"
# Note: not `grep -q`. Under `set -o pipefail`, grep -q exits on first match,
# ollama takes a SIGPIPE, and the pipeline reports failure for a model that is
# present. Capture first, then match.
MODELS="$(ollama list 2>/dev/null || true)"
if printf '%s\n' "$MODELS" | grep -q "^${MODEL}"; then
  echo "  ${GREEN}✓${OFF} ${MODEL} already pulled"
else
  echo "  ${YELLOW}!${OFF} not found. Run: ${BOLD}ollama pull ${MODEL}${OFF}"
fi
echo ""

# --- verify ----------------------------------------------------------------
echo "${BOLD}Verify after restarting Ollama${OFF}"
cat <<'EOF'

  1. Quit the Ollama app completely (⌘Q) and reopen it.
     The env vars above only reach processes launched *after* they are set.

  2. Confirm it loaded on GPU:

       ollama ps          # PROCESSOR should read 100% GPU

  3. Load the extension:

       chrome://extensions → Developer mode → Load unpacked → extension/

  4. Run the full check:

       npm run verify

  5. Prove the deterministic layer works with the model stopped:

       npm run test:golden

EOF