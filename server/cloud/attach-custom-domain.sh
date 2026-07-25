#!/bin/bash
# Attach play.nastyboardgame.com to the nasty-relay-cloud Deno Deploy app - the ONE-TIME,
# fully-scripted finish to the DNS/domain cutover. See HANDOFF.md's "Cloud hosting" section,
# "Custom domain - play.nastyboardgame.com" subsection, for the full writeup of why this needs
# an org access token instead of the regular deploy token, and what each phase below does.
#
# PREREQUISITE (the one thing that needs a human with a browser - nothing else in this repo's
# domain setup does): an Organization Access Token from the Deno Deploy dashboard.
#   1. Log into https://console.deno.com with the bpangman GitHub account (same one already
#      used for the CLI deploy token).
#   2. Go to the "dadio" org → Settings → Access Tokens → Create Token (org-scoped, prefix
#      "ddo_" - NOT the personal "ddp_" deploy token already saved in
#      server/deno-deploy-token.txt; that one is rejected by api.deno.com, confirmed 2026-07-11).
#   3. Save the value to server/deno-deploy-org-token.txt (chmod 600; already gitignored,
#      matching the existing deno-deploy-token.txt pattern). One line, no quotes, no trailing
#      content besides the token itself.
#
# Usage, in order (each phase is idempotent - safe to re-run):
#   ./attach-custom-domain.sh register   # do this FIRST - prints the exact DNS records for
#                                         # DNS-FOR-BLAKE.md / Squarespace. Run this before DNS
#                                         # is even live; it just registers the hostname and
#                                         # returns what to publish.
#   ./attach-custom-domain.sh status     # check verification/cert status any time after
#   ./attach-custom-domain.sh verify     # re-run once Blake confirms the DNS records are saved
#                                         # in Squarespace (DNS can take minutes to propagate -
#                                         # rerun `status`/`verify` if the first attempt says not
#                                         # yet verified, no need to re-register)
#   ./attach-custom-domain.sh attach [REV]  # bind the verified domain to a revision. With no
#                                         # argument it looks the revision up; pass one
#                                         # explicitly right after a deploy (deploy.sh does).
#                                         # Verifies the API really returned HTTP 204.
#   ./attach-custom-domain.sh provision  # request the Let's Encrypt cert (auto, ~90s)
#
# After all five steps: curl -I https://play.nastyboardgame.com/health should return 200.
# Only THEN flip wsurl.json (see HANDOFF.md's cutover checklist) - TLS must be live first or
# every client's wss:// connection will fail the handshake.

set -euo pipefail
cd "$(dirname "$0")"

ORG_TOKEN_FILE="../deno-deploy-org-token.txt"
DOMAIN="play.nastyboardgame.com"
APP="nasty-relay-cloud"
ORG="dadio"

if [ ! -f "$ORG_TOKEN_FILE" ]; then
  echo "Missing $ORG_TOKEN_FILE - see the prerequisite comment at the top of this script." >&2
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
    echo "^^ Copy the dns_records array above into DNS-FOR-BLAKE.md - publish ONE complete"
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
    # Usage: ./attach-custom-domain.sh attach [REVISION_ID]
    #
    # Pass the revision id explicitly when you already know it (deploy.sh does - it reads it
    # straight out of the `deno deploy` output). Otherwise we look it up.
    #
    # WHY THE LOOKUP IS NOT ENOUGH ON ITS OWN (learned the hard way, 2026-07-25): immediately
    # after a deploy, `productionRevisionId` can legitimately still be null/absent - production
    # is not pinned to the new revision until the domain is attached, which is the exact
    # chicken-and-egg the DEPLOY GOTCHA describes. Parsing null gave the literal string "None",
    # which was then PUT to /v2/revisions/None/domains and came back REVISION_NOT_FOUND. So we
    # fall back to the Preview timeline's activeRevisionId, which IS the new revision at that
    # moment, and we validate the shape before using it.
    REV="${2:-}"
    if [ -z "$REV" ]; then
      echo "Looking up the current revision for ${APP}..."
      APP_JSON="$(deno deploy apps get --app "$APP" --org "$ORG" --json --non-interactive \
                    --token "$(cat ../deno-deploy-token.txt)" 2>/dev/null)"
      REV="$(printf '%s' "$APP_JSON" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
r=d.get("productionRevisionId")
if not r:
    # production not pinned yet - the newest Preview revision is the one we just deployed
    for t in d.get("timelines") or []:
        if (t.get("partition") or "").startswith("Preview") and t.get("activeRevisionId"):
            r=t["activeRevisionId"]; break
print(r or "")
')"
    fi

    case "$REV" in
      ""|None|null)
        echo "ERROR: could not determine which revision to attach ${DOMAIN} to." >&2
        echo "       Pass it explicitly:  $0 attach <REVISION_ID>" >&2
        echo "       (the id is in the deploy output's build/preview URL)" >&2
        exit 1 ;;
      *[!a-z0-9]*)
        echo "ERROR: '${REV}' does not look like a revision id (expected lowercase letters/digits)." >&2
        exit 1 ;;
    esac

    echo "Attaching ${DOMAIN} to revision ${REV}..."
    BODY_FILE="$(mktemp)"
    STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X PUT \
      "https://api.deno.com/v2/revisions/${REV}/domains" \
      -H "Authorization: Bearer ${ORG_TOKEN}" -H "Content-Type: application/json" \
      -d "{\"production\":[\"${DOMAIN}\"]}" || echo "000")"
    BODY="$(cat "$BODY_FILE")"; rm -f "$BODY_FILE"

    # A 204 with an empty body is the ONLY success. This used to print "Done (204 = no output
    # means success)" unconditionally - including when the API had just returned
    # REVISION_NOT_FOUND - which is precisely the silent-stale-domain failure this whole script
    # exists to prevent. Never report success without checking the status code.
    if [ "$STATUS" != "204" ] || [ -n "$BODY" ]; then
      echo "ERROR: attach FAILED (HTTP ${STATUS})." >&2
      if [ -n "$BODY" ]; then echo "       API said: ${BODY}" >&2; fi
      echo "       ${DOMAIN} is still pointing at the PREVIOUS revision - the deploy is NOT live." >&2
      exit 1
    fi
    echo "Attached (HTTP 204). ${DOMAIN} now serves revision ${REV}."
    ;;
  provision)
    echo "Requesting automatic TLS provisioning for ${DOMAIN}..."
    api POST "/v2/domains/${DOMAIN}/certificates/provision"
    echo
    echo "Poll: $0 status   (look for provisioning_status.code == \"success\", usually <90s)"
    ;;
  *)
    echo "Usage: $0 {register|status|verify|attach [REVISION_ID]|provision}" >&2
    exit 2
    ;;
esac
