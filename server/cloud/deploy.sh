#!/bin/bash
# deploy.sh - the whole cloud deploy, in one command, with the easy-to-forget step built in.
#
#   cd /Users/jarvis/nasty-game/server/cloud && ./deploy.sh
#
# WHY THIS EXISTS
#   `deno deploy` publishes a NEW revision, but it does NOT move the custom domain. Every time,
#   play.nastyboardgame.com kept serving the OLD revision until somebody remembered to re-attach
#   it. The old runbook had a human read a revision id off the screen and paste it into a curl,
#   which is exactly the kind of step that gets skipped at 11pm. This script does that reading
#   and pasting itself, and then checks that it actually worked. It chains the three things that
#   must always happen together:
#
#     1. deno deploy                      publish the new revision, and read the new revision id
#                                         straight out of the deploy output
#     2. attach-custom-domain.sh attach   point play.nastyboardgame.com at THAT revision, and
#                                         verify the API really returned HTTP 204
#     3. verify                           GET /health over the REAL domain and check two things:
#                                           - ok is true
#                                           - protocolVersion matches PROTOCOL_VERSION in
#                                             server.ts (i.e. the domain really is serving the
#                                             code we just deployed, not the previous revision)
#
#   Steps 2 and 3 are the whole point. A green "deployed!" with the domain still on last week's
#   build is the failure this script is here to make impossible to miss. Every one of those
#   checks exits nonzero and says so loudly on failure - none of them just prints and carries on.
#
# TWO BUGS FOUND ON THE FIRST REAL RUN (2026-07-25), both fixed here - do not reintroduce:
#   1. The script never exported DENO_DEPLOY_TOKEN, so `deno deploy` died with "This command
#      requires interactive input, but stdin is not a terminal." It now reads the token file
#      itself and fails clearly if that file is missing or empty.
#   2. The attach step printed "Done (204 = no output means success)" UNCONDITIONALLY - it said
#      that even when the API had returned REVISION_NOT_FOUND, because the revision lookup had
#      produced the literal string "None". Two fixes: the revision id now comes from the deploy
#      output (the lookup is only a fallback, since productionRevisionId is legitimately null
#      until the domain is attached), and the attach checks the real HTTP status code.
#
# WHAT IT NEEDS - two DIFFERENT tokens, not interchangeable:
#   ../deno-deploy-token.txt       personal ddp_ token, for deploying (gitignored)
#   ../deno-deploy-org-token.txt   org ddo_ token, for the domain attach (gitignored)
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
    -h|--help)    sed -n '2,54p' "$0"; exit 0 ;;
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
  echo "  1. export DENO_DEPLOY_TOKEN from ../deno-deploy-token.txt, then"
  echo "     deno deploy . --org dadio --app nasty-relay-cloud --prod --non-interactive"
  echo "     (in $(pwd)), and read the new revision id from its output"
  echo "  2. ./attach-custom-domain.sh attach <that revision>   -> must return HTTP 204"
  echo "  3. curl https://${DOMAIN}/health  -> expect ok:true and protocolVersion:${EXPECTED_PV}"
  echo
  echo "Nothing was deployed, attached, or contacted."
  exit 0
fi

if [ "$CHECK_ONLY" != "1" ]; then
  # TWO DIFFERENT TOKENS, and they are not interchangeable:
  #   deno-deploy-token.txt      personal "ddp_" token - deploying (the deno CLI)
  #   deno-deploy-org-token.txt  org "ddo_" token      - the domain attach (api.deno.com)
  [ -s ../deno-deploy-token.txt ] || die "missing or empty ../deno-deploy-token.txt (the personal ddp_ token used to deploy). Get a fresh one from the Deno Deploy dashboard (Settings, Access Tokens), save it there, chmod 600."
  [ -s ../deno-deploy-org-token.txt ] || die "missing or empty ../deno-deploy-org-token.txt (the ORG ddo_ token used for the domain attach - a different token from the one above; see attach-custom-domain.sh's header)."

  # `deno deploy` does NOT read the token file by itself. Without this it dies with
  # "This command requires interactive input, but stdin is not a terminal", which is exactly
  # what happened on the first real run of this script (2026-07-25).
  DENO_DEPLOY_TOKEN="$(cat ../deno-deploy-token.txt)"
  export DENO_DEPLOY_TOKEN

  say "1/3  Deploying to Deno Deploy"
  DEPLOY_LOG="$(mktemp)"
  # 2026-07-28: --json is REQUIRED here, not a nicety. Without it the CLI renders its
  # interactive progress view, and on this machine that path failed SIX times in a row with
  # "The build for this revision is no longer active. Re-run the deploy to start a new build."
  # while the byte-identical command WITH --json succeeded first try. HANDOFF used to describe
  # this as "Deno Deploy stalls intermittently, just retry" - it is not intermittent and
  # retrying does not help. Do not remove this flag.
  if ! deno deploy . --org dadio --app nasty-relay-cloud --prod --non-interactive --json 2>&1 | tee "$DEPLOY_LOG"; then
    rm -f "$DEPLOY_LOG"
    die "deno deploy failed - nothing was attached, the live domain is untouched"
  fi

  # Take the revision id from the deploy output itself. It appears in the build URL
  # (.../builds/<rev>) and in the preview host (nasty-relay-cloud-<rev>.dadio.deno.net).
  # This is the PRIMARY source on purpose: right after a deploy the app's
  # productionRevisionId can still be null, because production is not pinned until the
  # domain is attached - the chicken-and-egg the DEPLOY GOTCHA is about.
  # With --json the CLI emits one JSON object carrying revisionId directly, so read that first.
  # The old grep over the build URL / preview host stays as the fallback, so this keeps working
  # even if the JSON shape ever changes.
  REV="$(python3 -c "
import json,sys
try:
    for line in open(sys.argv[1]):
        line=line.strip()
        if line.startswith('{'):
            r=json.loads(line).get('revisionId')
            if r: print(r); break
except Exception: pass
" "$DEPLOY_LOG" 2>/dev/null)"
  if [ -z "$REV" ]; then
    REV="$(grep -oE '(builds/|nasty-relay-cloud-)[a-z0-9]{6,}' "$DEPLOY_LOG" \
            | sed -E 's#^(builds/|nasty-relay-cloud-)##' | tail -1)"
  fi
  rm -f "$DEPLOY_LOG"
  if [ -n "$REV" ]; then
    echo "  new revision (from the deploy output): ${REV}"
  else
    echo "  could not read a revision id out of the deploy output - falling back to the API lookup"
  fi

  say "2/3  Pointing ${DOMAIN} at the new revision"
  # attach-custom-domain.sh checks the real HTTP status and exits nonzero on anything that is
  # not a bare 204, so a failure here genuinely stops the script.
  ./attach-custom-domain.sh attach ${REV:+"$REV"} \
    || die "attach FAILED - a NEW revision is deployed but ${DOMAIN} is still serving the OLD one, so the deploy is not live. Fix, then: ./attach-custom-domain.sh attach ${REV:-<revision id>}"

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
