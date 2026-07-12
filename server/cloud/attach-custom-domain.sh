#!/bin/bash
# Attach play.nastyboardgame.com to the nasty-relay-cloud Deno Deploy app — the ONE-TIME,
# fully-scripted finish to the DNS/domain cutover. See HANDOFF.md's "Cloud hosting" section,
# "Custom domain — play.nastyboardgame.com" subsection, for the full writeup of why this needs
# an org access token instead of the regular deploy token, and what each phase below does.
#
# PREREQUISITE (the one thing that needs a human with a browser — nothing else in this repo's
# domain setup does): an Organization Access Token from the Deno Deploy dashboard.
#   1. Log into https://console.deno.com with the bpangman GitHub account (same one already
#      used for the CLI deploy token).
#   2. Go to the "dadio" org → Settings → Access Tokens → Create Token (org-scoped, prefix
#      "ddo_" — NOT the personal "ddp_" deploy token already saved in
#      server/deno-deploy-token.txt; that one is rejected by api.deno.com, confirmed 2026-07-11).
#   3. Save the value to server/deno-deploy-org-token.txt (chmod 600; already gitignored,
#      matching the existing deno-deploy-token.txt pattern). One line, no quotes, no trailing
#      content besides the token itself.
#
# Usage, in order (each phase is idempotent — safe to re-run):
#   ./attach-custom-domain.sh register   # do this FIRST — prints the exact DNS records for
#                                         # DNS-FOR-BLAKE.md / Squarespace. Run this before DNS
#                                         # is even live; it just registers the hostname and
#                                         # returns what to publish.
#   ./attach-custom-domain.sh status     # check verification/cert status any time after
#   ./attach-custom-domain.sh verify     # re-run once Blake confirms the DNS records are saved
#                                         # in Squarespace (DNS can take minutes to propagate —
#                                         # rerun `status`/`verify` if the first attempt says not
#                                         # yet verified, no need to re-register)
#   ./attach-custom-domain.sh attach     # bind the verified domain to the app's current
#                                         # production revision (do this once verify succeeds)
#   ./attach-custom-domain.sh provision  # request the Let's Encrypt cert (auto, ~90s)
#
# After all five steps: curl -I https://play.nastyboardgame.com/health should return 200.
# Only THEN flip wsurl.json (see HANDOFF.md's cutover checklist) — TLS must be live first or
# every client's wss:// connection will fail the handshake.

set -euo pipefail
cd "$(dirname "$0")"

ORG_TOKEN_FILE="../deno-deploy-org-token.txt"
DOMAIN="play.nastyboardgame.com"
APP="nasty-relay-cloud"
ORG="dadio"

if [ ! -f "$ORG_TOKEN_FILE" ]; then
  echo "Missing $ORG_TOKEN_FILE — see the prerequisite comment at the top of this script." >&2
  exit 1
fi
ORG_TOKEN="$(cat "$ORG_TOKEN_FILE")"

api() {
  # $1 = method, $2 = path, $3 = optional JSON body
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "https://api.deno.com${path}" \
      -H "Authorization: Bearer ${ORG_TOKEN}" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "https://api.deno.com${path}" \
      -H "Authorization: Bearer ${ORG_TOKEN}"
  fi
}

case "${1:-}" in
  register)
    echo "Registering ${DOMAIN} (base_only)..."
    api POST "/v2/domains" "{\"domain\":\"${DOMAIN}\",\"kind\":\"base_only\"}" | tee /tmp/nasty-domain-register.json
    echo
    echo "^^ Copy the dns_records array above into DNS-FOR-BLAKE.md — publish ONE complete"
    echo "   option (all records in a single inner array), not a mix across options."
    ;;
  status)
    api GET "/v2/domains/${DOMAIN}" | tee /tmp/nasty-domain-status.json
    ;;
  verify)
    echo "Re-checking DNS ownership verification for ${DOMAIN}..."
    api POST "/v2/domains/${DOMAIN}/verify"
    ;;
  attach)
    echo "Looking up the current production revision for ${APP}..."
    REV=$(deno deploy apps get --app "$APP" --org "$ORG" --json --non-interactive --token "$(cat ../deno-deploy-token.txt)" | python3 -c "import json,sys; print(json.load(sys.stdin)['productionRevisionId'])")
    echo "Production revision: ${REV}"
    echo "Attaching ${DOMAIN} to it..."
    api PUT "/v2/revisions/${REV}/domains" "{\"production\":[\"${DOMAIN}\"]}"
    echo "Done (204 = no output means success)."
    ;;
  provision)
    echo "Requesting automatic TLS provisioning for ${DOMAIN}..."
    api POST "/v2/domains/${DOMAIN}/certificates/provision"
    echo
    echo "Poll: $0 status   (look for provisioning_status.code == \"success\", usually <90s)"
    ;;
  *)
    echo "Usage: $0 {register|status|verify|attach|provision}" >&2
    exit 2
    ;;
esac
