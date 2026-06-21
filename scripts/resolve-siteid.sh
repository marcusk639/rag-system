#!/usr/bin/env bash
#
# resolve-siteid.sh — resolve a SharePoint site's Graph composite siteId
# (hostname,siteCollectionGuid,siteGuid) using the app-only credentials that
# already live on the rag-worker service. The secret never leaves Railway.
#
# Doubles as the live auth check: a clean siteId means the client-credentials
# token AND admin consent (Sites.Read.All) are both working.
#
# Usage:
#   ./scripts/resolve-siteid.sh <site-url>
#   ./scripts/resolve-siteid.sh https://contoso.sharepoint.com/sites/Finance
#   ./scripts/resolve-siteid.sh https://contoso.sharepoint.com/          # root site
#
set -euo pipefail

SITE_URL="${1:-}"
if [[ -z "$SITE_URL" ]]; then
  echo "usage: $0 <sharepoint-site-url>" >&2
  exit 2
fi

# Parse host + path from the URL (strip scheme, trailing slash, query/fragment).
noscheme="${SITE_URL#http://}"
noscheme="${noscheme#https://}"
HOST="${noscheme%%/*}"
REST="${noscheme#"$HOST"}"
REST="${REST%%\?*}"
REST="${REST%/}" # drop trailing slash
# Keep only up to /sites/<Name> if a deeper path was pasted.
if [[ "$REST" =~ ^(/sites/[^/]+) ]]; then
  SITE_PATH="${BASH_REMATCH[1]}"
elif [[ "$REST" =~ ^(/teams/[^/]+) ]]; then
  SITE_PATH="${BASH_REMATCH[1]}"
else
  SITE_PATH="" # root site
fi

echo "host = $HOST"
echo "path = ${SITE_PATH:-(root site)}"
echo "resolving via rag-worker ..."

# Resolver runs inside the worker container (creds stay in Railway). The Graph
# path differs for root vs named sites: root -> /sites/{host}; named ->
# /sites/{host}:{path}. Shipped as a .cjs (so Node treats it as CommonJS, not
# TypeScript) via base64 to avoid SSH quoting pitfalls.
RESOLVER='
const t=process.env.MS_TENANT_ID, c=process.env.MS_CLIENT_ID, s=process.env.MS_CLIENT_SECRET;
const host=process.env.SP_HOST, path=process.env.SP_PATH||"";
(async()=>{
  const tok=await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:c,client_secret:s,scope:"https://graph.microsoft.com/.default",grant_type:"client_credentials"})
  }).then(r=>r.json());
  if(!tok.access_token){console.log("TOKEN_ERROR",JSON.stringify(tok));process.exit(1);}
  const url = path ? `https://graph.microsoft.com/v1.0/sites/${host}:${path}` : `https://graph.microsoft.com/v1.0/sites/${host}`;
  const site=await fetch(url,{headers:{authorization:`Bearer ${tok.access_token}`}}).then(r=>r.json());
  if(site.error){console.log("GRAPH_ERROR",JSON.stringify(site.error));process.exit(1);}
  console.log("OK siteId =", site.id);
  console.log("   name   =", site.displayName||site.name||"(root)");
  console.log("   webUrl =", site.webUrl);
})().catch(e=>{console.log("EXC",e.message);process.exit(1);});
'
B64=$(printf '%s' "$RESOLVER" | base64 | tr -d '\n')
railway ssh --service rag-worker \
  "echo $B64 | base64 -d > /tmp/_r.cjs && SP_HOST='$HOST' SP_PATH='$SITE_PATH' node /tmp/_r.cjs"
