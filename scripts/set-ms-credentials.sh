#!/usr/bin/env bash
#
# set-ms-credentials.sh — set Microsoft Graph (SharePoint/Outlook) credentials
# on Railway services, then redeploy so they pick up the new env.
#
# Required by the SharePoint connector (packages/connectors/src/factory.ts):
#   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET  (all three or none)
#
# Only `rag-worker` actually builds the connector today. `rag-api` is optional
# (it only enqueues sync jobs). Pass --with-api to also set it.
#
# Secrets are NEVER hardcoded here. Values come from your environment if already
# exported, otherwise you are prompted (the client secret is read hidden).
#
# Usage:
#   ./scripts/set-ms-credentials.sh                 # set on rag-worker only
#   ./scripts/set-ms-credentials.sh --with-api      # also set on rag-api
#   ./scripts/set-ms-credentials.sh --no-redeploy   # set vars, skip redeploy
#   MS_TENANT_ID=... MS_CLIENT_ID=... MS_CLIENT_SECRET=... \
#     ./scripts/set-ms-credentials.sh               # non-interactive (CI)
#
set -euo pipefail

WITH_API=0
REDEPLOY=1
for arg in "$@"; do
  case "$arg" in
    --with-api) WITH_API=1 ;;
    --no-redeploy) REDEPLOY=0 ;;
    -h | --help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

command -v railway >/dev/null 2>&1 || {
  echo "error: railway CLI not found on PATH" >&2
  exit 1
}

# Confirm the repo is linked to the right project/environment before mutating.
if ! railway status >/dev/null 2>&1; then
  echo "error: not linked to a Railway project (run 'railway link')" >&2
  exit 1
fi
echo "Railway context:"
railway status 2>/dev/null | grep -iE "Project:|Environment:" || true
echo

# --- Gather credentials (env first, then prompt) ---
prompt_visible() { # var_name human_label
  local current="${!1:-}"
  if [[ -n "$current" ]]; then
    echo "$current"
    return
  fi
  local val=""
  read -r -p "$2: " val </dev/tty
  echo "$val"
}

prompt_secret() { # var_name human_label
  local current="${!1:-}"
  if [[ -n "$current" ]]; then
    echo "$current"
    return
  fi
  local val=""
  read -r -s -p "$2 (hidden): " val </dev/tty
  echo >&2 # newline after hidden input
  echo "$val"
}

MS_TENANT_ID="$(prompt_visible MS_TENANT_ID 'MS_TENANT_ID (Directory/tenant ID)')"
MS_CLIENT_ID="$(prompt_visible MS_CLIENT_ID 'MS_CLIENT_ID (Application/client ID)')"
MS_CLIENT_SECRET="$(prompt_secret MS_CLIENT_SECRET 'MS_CLIENT_SECRET (client secret Value)')"

for pair in "MS_TENANT_ID:$MS_TENANT_ID" "MS_CLIENT_ID:$MS_CLIENT_ID" "MS_CLIENT_SECRET:$MS_CLIENT_SECRET"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [[ -z "$value" ]]; then
    echo "error: $name is empty — all three are required" >&2
    exit 1
  fi
done

# --- Target services ---
SERVICES=(rag-worker)
if [[ "$WITH_API" -eq 1 ]]; then
  SERVICES+=(rag-api)
fi

echo
echo "Setting MS_* on: ${SERVICES[*]}"
for svc in "${SERVICES[@]}"; do
  echo "== $svc =="
  railway variables --service "$svc" \
    --set "MS_TENANT_ID=$MS_TENANT_ID" \
    --set "MS_CLIENT_ID=$MS_CLIENT_ID" \
    --set "MS_CLIENT_SECRET=$MS_CLIENT_SECRET" >/dev/null
  echo "  set ✓"
done

if [[ "$REDEPLOY" -eq 1 ]]; then
  echo
  for svc in "${SERVICES[@]}"; do
    echo "Redeploying $svc ..."
    railway redeploy --service "$svc" --yes
  done
fi

echo
echo "Done. Verify (values shown masked by Railway):"
echo "  railway variables --service rag-worker | grep -i MS_"
echo
echo "NOTE: for hardened hygiene, also seal these in the Railway dashboard"
echo "(Service → Variables → seal). CLI-set values may appear in shell history."
