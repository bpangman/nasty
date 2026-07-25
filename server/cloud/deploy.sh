#!/bin/bash
# deploy.sh - the whole cloud deploy, in one command, with the easy-to-forget step built in.
#
#   cd /Users/jarvis/nasty-game/server/cloud && ./deploy.sh
#
# WHY THIS EXISTS
#   `deno deploy` publishes a NEW revision, but it does NOT move the custom domain. Every time,
#   play.nastyboardgame.com kept serving the OLD revision until somebody remembered to re-attach
#   it. The old runbook had a human read a revision id off the screen and paste it into a curl,
#   which is exactly the kind of step that gets skipped at 11pm. attach-custom-domain.sh already
#   looks the current production revision up by itself, so there is nothing left for a human to
#   copy. This script chains the three things that must always happen together:
#
#     1. deno deploy                      publish the new revision
#     2. attach-custom-domain.sh attach   point play.nastyboardgame.com at it
#     3. verify                           GET /health over the REAL domain and check two things:
#                                           - ok is true
#                                           - protocolVersion matches PROTOCOL_VERSION in
#                                             server.ts (i.e. the domain really is serving the
#                                             code we just deployed, not the previous revision)
#
#   Step 3 is the whole point. A green "deployed!" with the domain still on last week's build
#   is the failure this script is here to make impossible to miss. If either check fails, this
#   exits nonzero and says so loudly.
#
# WHAT IT NEEDS
#   ../deno-deploy-token.txt       personal ddp_ token (gitignored)
#   ../deno-deploy-org-token.txt   org ddo_ token, used by attach-custom-domain.sh (gitignored)
#   deno on PATH, plus curl and python3
#
# OPTIONS
#   --dry-run     print exactly what would run, change nothing, contact nothing. Use this to
#                 sanity-check the script without touching production.
#   --check-only  skip the deploy and the attach; just run the /health verification against
#                 whatever is live right now. Read-only and safe at any time.
#
# SAFETY
#   Everything before step 3 is a real production change - only run this when you actually mean
#   to ship. Step 3 on its own (--check-only) is a plain GET and is always safe.
#
# See HANDOFF.md's "Cloud hosting" section for the background, and DEPLOY-STEPS.md for the
# one-time domain setup that already happened.

set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="play.nastyboardgame.com"
DRY_RUN=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    -h|--help)    sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n=== %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# The expected protocol version, read straight out of the source we are deploying. Single
# source of truth - nobody has to remember what the number is this month.
EXPECTED_PV="$(grep -E '^const PROTOCOL_VERSION *= *[0-9]+;' server.ts | grep -oE '[0-9]+' | head -1)"
[ -n "$EXPECTED_PV" ] || die "could not read PROTOCOL_VERSION out of server.ts"
echo "PROTOCOL_VERSION in server.ts: ${EXPECTED_PV}"

if [ "$DRY_RUN" = "1" ]; then
  say "DRY RUN - nothing below actually runs"
  echo "  1. deno deploy                       (in $(pwd))"
  echo "  2. ./attach-custom-domain.sh attach"
  echo "  3. curl https://${DOMAIN}/health  -> expect ok:true and protocolVersion:${EXPECTED_PV}"
  echo
  echo "Nothing was deployed, attached, or contacted."
  exit 0
fi

if [ "$CHECK_ONLY" != "1" ]; then
  [ -f ../deno-deploy-token.txt ] || die "missing ../deno-deploy-token.txt (personal ddp_ token)"
  [ -f ../deno-deploy-org-token.txt ] || die "missing ../deno-deploy-org-token.txt (org ddo_ token)"

  say "1/3  Deploying to Deno Deploy"
  deno deploy || die "deno deploy failed - nothing was attached, the live domain is untouched"

  say "2/3  Pointing ${DOMAIN} at the new production revision"
  ./attach-custom-domain.sh attach || die "attach failed - a NEW revision is live but ${DOMAIN} is still serving the OLD one. Re-run ./attach-custom-domain.sh attach."

  # Give the domain binding a moment to take effect before we judge it.
  sleep 5
else
  say "check-only - skipping deploy and attach"
fi

say "3/3  Verifying https://${DOMAIN}/health"
HEALTH=""
for attempt in 1 2 3 4 5 6; do
  HEALTH="$(curl -sS --max-time 15 "https://${DOMAIN}/health" || true)"
  if [ -n "$HEALTH" ] && printf '%s' "$HEALTH" | grep -q '"ok"'; then break; fi
  echo "  (attempt ${attempt}: no usable response yet, retrying in 5s)"
  sleep 5
done
[ -n "$HEALTH" ] || die "no response at all from https://${DOMAIN}/health"
echo "  $HEALTH"

OK_VAL="$(printf '%s' "$HEALTH"    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))' 2>/dev/null || echo "")"
LIVE_PV="$(printf '%s' "$HEALTH"   | python3 -c 'import json,sys; print(json.load(sys.stdin).get("protocolVersion"))' 2>/dev/null || echo "")"

[ "$OK_VAL" = "True" ] || die "/health did not report ok:true (got ok=${OK_VAL:-<unparseable>})"
echo "  ok: true"

if [ "$LIVE_PV" != "$EXPECTED_PV" ]; then
  die "protocol version mismatch. server.ts says ${EXPECTED_PV}, but ${DOMAIN} is serving ${LIVE_PV:-<missing>}.
       That almost always means the domain is still attached to the PREVIOUS revision.
       Fix: ./attach-custom-domain.sh attach   then re-run: ./deploy.sh --check-only"
fi
echo "  protocolVersion: ${LIVE_PV}  (matches server.ts)"

say "Done - ${DOMAIN} is live on the current revision, protocol ${LIVE_PV}."
