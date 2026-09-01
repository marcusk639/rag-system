#!/usr/bin/env bash
#
# create-sharepoint-source.sh — resolve a SharePoint site URL to its Graph
# composite siteId and create the matching `sources` row, in one step.
#
# Uses the app-only credentials already on the rag-worker service (via
# resolve-siteid.sh, which runs the lookup inside the container so the secret
# never leaves Railway) and an admin bearer token for the rag API.
#
# Usage:
#   ./scripts/create-sharepoint-source.sh <site-url> [flags]
#
#   --name <label>          source name (default: the site's displayName)
#   --folder-path <path>    restrict to a folder inside the drive, e.g. "SOPs/2026"
#   --drive-id <id>         restrict to one document library
#   --token <admin-token>   rag API admin token (else RAG_ADMIN_TOKEN, else Railway)
#   --api <url>             rag API base URL (else RAG_API_URL, else production)
#   --dry-run               resolve and show the request; create nothing
#
# It deliberately does NOT sync. Creating a source is reversible; ingesting is
# not, and `docs/PURGE-RECORD-2026-08-03.md` records a corpus that had to be
# deleted after a screen found TRI. The sync command is printed at the end so
# the decision to ingest stays a separate, deliberate act.
#
# Requires: curl, jq, railway CLI (unless --token and a resolved siteId are given)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

API_URL="${RAG_API_URL:-https://rag-api-production-07b4.up.railway.app}"
ADMIN_TOKEN="${RAG_ADMIN_TOKEN:-}"
SITE_URL=""
NAME=""
FOLDER_PATH=""
DRIVE_ID=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)        NAME="$2";        shift 2 ;;
    --folder-path) FOLDER_PATH="$2"; shift 2 ;;
    --drive-id)    DRIVE_ID="$2";    shift 2 ;;
    --token)       ADMIN_TOKEN="$2"; shift 2 ;;
    --api)         API_URL="$2";     shift 2 ;;
    --dry-run)     DRY_RUN=true;     shift   ;;
    -h|--help)
      awk 'NR==1{next} !/^#/{exit} {sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *)  SITE_URL="$1"; shift ;;
  esac
done

[[ -n "$SITE_URL" ]] || { echo "usage: $0 <sharepoint-site-url> [flags]" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required (brew install jq)" >&2; exit 2; }

# ── 1. resolve the site id ────────────────────────────────────────────────────
# Delegated to resolve-siteid.sh so there is exactly one implementation of the
# token dance and the root-vs-named-site path difference.
echo "== Resolving site id" >&2
RESOLVED="$("$REPO_ROOT/scripts/resolve-siteid.sh" "$SITE_URL")" || {
  echo "resolve-siteid.sh failed — see its output above." >&2
  echo "A GRAPH_ERROR usually means the app registration lacks Sites.Read.All" >&2
  echo "as an APPLICATION permission with admin consent." >&2
  exit 1
}
echo "$RESOLVED" >&2

SITE_ID="$(sed -n 's/^OK siteId = //p' <<<"$RESOLVED" | tr -d '[:space:]')"
SITE_NAME="$(sed -n 's/^ *name *= //p' <<<"$RESOLVED" | sed 's/[[:space:]]*$//')"

# The composite id is "hostname,siteCollectionGuid,siteGuid". Anything without
# two commas is not a site id, and posting it would create a source that fails
# on every sync with an opaque Graph error.
if [[ -z "$SITE_ID" || "$(tr -cd ',' <<<"$SITE_ID" | wc -c)" -ne 2 ]]; then
  echo "ERROR: could not parse a composite siteId from the resolver output." >&2
  exit 1
fi
[[ -n "$NAME" ]] || NAME="${SITE_NAME:-SharePoint site}"

# ── 2. admin token ────────────────────────────────────────────────────────────
if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "== Reading admin token from Railway" >&2
  # API_PRINCIPALS holds RAW tokens; take the entry flagged isAdmin. Never
  # regenerate here — gen-tokens.sh mints fresh tokens for every principal it
  # is given, which would rotate staff tokens as a side effect of this script.
  ADMIN_TOKEN="$(railway variables --service rag-api --kv 2>/dev/null \
    | sed -n 's/^API_PRINCIPALS=//p' \
    | jq -r 'try (fromjson? // .) | .[]? | select(.isAdmin == true) | .token' \
    | head -1)"
fi
if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "ERROR: no admin token. Pass --token, set RAG_ADMIN_TOKEN, or make sure" >&2
  echo "API_PRINCIPALS on rag-api has an entry with isAdmin: true." >&2
  exit 1
fi

# ── 3. refuse to create a duplicate ───────────────────────────────────────────
# GET /sources strips `config`, so an existing row cannot be matched on siteId
# from the API alone. Match on name and surface everything for a human call.
echo "== Existing sources" >&2
EXISTING="$(curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" "$API_URL/sources")" || {
  echo "ERROR: GET /sources failed. Check --api and the token." >&2
  exit 1
}
jq -r '.[]? | "   \(.id)  \(.kind)  \(.name)"' <<<"$EXISTING" >&2 || true

if jq -e --arg n "$NAME" '.[]? | select(.name == $n)' >/dev/null <<<"$EXISTING"; then
  echo "" >&2
  echo "ERROR: a source named \"$NAME\" already exists (listed above)." >&2
  echo "There is no PATCH endpoint: a source's siteId cannot be repointed." >&2
  echo "If that row targets the OLD site, DELETE it (cascades to its documents," >&2
  echo "chunks and jobs) and re-run, or pass a different --name." >&2
  exit 1
fi

# ── 4. build and send ─────────────────────────────────────────────────────────
CONFIG="$(jq -n --arg s "$SITE_ID" '{siteId: $s}')"
[[ -n "$DRIVE_ID" ]]    && CONFIG="$(jq --arg d "$DRIVE_ID"    '.driveId = $d'    <<<"$CONFIG")"
[[ -n "$FOLDER_PATH" ]] && CONFIG="$(jq --arg f "$FOLDER_PATH" '.folderPath = $f' <<<"$CONFIG")"
BODY="$(jq -n --arg n "$NAME" --argjson c "$CONFIG" \
  '{kind: "sharepoint", name: $n, config: $c}')"

echo "" >&2
echo "== POST $API_URL/sources" >&2
jq . <<<"$BODY" >&2

if [[ -n "$FOLDER_PATH" ]]; then
  echo "" >&2
  echo "NOTE: folderPath is honored on the INITIAL (cursor-less) sync only." >&2
  echo "Delta syncs inherit the scope of the first run, so this is the one" >&2
  echo "chance to scope this source without deleting and recreating it." >&2
fi

if $DRY_RUN; then
  echo "" >&2
  echo "--dry-run: nothing created." >&2
  exit 0
fi

CREATED="$(curl -fsS -X POST "$API_URL/sources" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d "$BODY")" || {
  echo "ERROR: POST /sources failed. A 403 means the token is not an admin" >&2
  echo "principal (source creation is admin-only)." >&2
  exit 1
}

NEW_ID="$(jq -r '.id' <<<"$CREATED")"
echo "" >&2
echo "Created source $NEW_ID" >&2
jq . <<<"$CREATED" >&2

cat >&2 <<EOF

Not synced — on purpose. Creating a source is reversible; ingesting is not.

Before you sync, two things are worth knowing:

  * data_class defaults to "general", so every document is stamped Class A
    regardless of content.
  * The ingest-time gates are unbuilt (content-boundary Phases 2 and 4), so
    nothing screens documents on the way in. The TRI pre-flight added later
    guards GENERATION — it stops a prompt reaching a hosted model. It does not
    stop content reaching the index.

  docs/PURGE-RECORD-2026-08-03.md has the background.

When you are ready:

  curl -X POST "$API_URL/sources/$NEW_ID/sync" \\
    -H "authorization: Bearer \$ADMIN_TOKEN"
EOF
