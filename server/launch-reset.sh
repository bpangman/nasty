#!/bin/bash
# launch-reset.sh - THE one-shot launch wipe, with the backup step built in so it cannot be
# skipped. 2026-07-31 v0.68.
#
#   cd /Users/jarvis/nasty-game/server && ./launch-reset.sh
#
# WHAT THIS IS
#   Blake, verbatim: "when the app officially launches on the app store, I want everyone to
#   start from square 1 - meaning even having to make new accounts!" This script runs that
#   wipe against the LIVE cloud server (play.nastyboardgame.com) the moment Apple approves,
#   as an explicit human-triggered step - Blake's chosen mechanism: "I back everything up
#   first, then run it as an explicit step the moment Apple approves, alongside the website
#   switch. Guarded so it can never run twice or fire by accident after real players exist."
#
# WHAT IT DOES, IN ORDER - and it stops dead at the first failure:
#   1. GET /admin/launch-reset          confirms the wipe has NOT already run (a second run is
#                                       refused by the server anyway; this just fails sooner)
#   2. GET /admin/launch-reset/backup   downloads everything the wipe would delete and writes
#                                       it to launch-reset-backup-<timestamp>.json HERE, next
#                                       to this script; verifies the JSON parses and prints
#                                       the record counts. NOTHING has been deleted yet.
#   3. asks you to type: WIPE EVERYTHING FOR LAUNCH
#   4. POST /admin/launch-reset         the wipe itself. The server takes its OWN backup into
#                                       KV first, claims the one-shot marker atomically, then
#                                       deletes. The response (with the server-side backup
#                                       embedded) is saved to launch-reset-result-<ts>.json.
#   5. verifies: /leaderboard is empty, /admin/accounts is empty, and the done marker is set.
#
# WHAT IT DELETES (server-side, all backed up first): every account, sign-in index, session,
# leaderboard row (account + name + monthly), name reservation, claim journal, pending email
# code, purchase-dedupe record, room, and every free-month tombstone (so post-launch signups
# all get their full free month - Blake's decision).
# WHAT SURVIVES: the Apple IAP transaction replay ledger (so an old receipt can never be
# replayed against a new account for free credits), the IAP notification audit log, the
# solo-result replay guard, and the tombstone salt.
#
# THE GUARD: the server refuses a second run FOREVER (HTTP 409) - the marker is claimed with
# an atomic KV commit before anything is deleted, so even two racing invocations cannot both
# wipe. There is deliberately no un-arm switch.
#
# OPTIONS
#   --base URL     target a different server (default https://play.nastyboardgame.com).
#                  For a local rehearsal: ./launch-reset.sh --base http://localhost:8484
#   --status       step 1 only - read-only, safe any time.
#
# Needs: curl, python3, and admin-token.txt next to this script (the same token the
# production NASTY_ADMIN_TOKEN secret was set from).

set -euo pipefail
cd "$(dirname "$0")"

BASE="https://play.nastyboardgame.com"
STATUS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
say() { printf '\n=== %s\n' "$*"; }

[ -s admin-token.txt ] || die "missing server/admin-token.txt (the admin token)"
TOKEN="$(tr -d '[:space:]' < admin-token.txt)"

say "1/5  Checking ${BASE} - has the launch reset already run?"
STATUS="$(curl -sS --max-time 20 -H "x-admin-token: ${TOKEN}" "${BASE}/admin/launch-reset")" \
  || die "could not reach ${BASE}/admin/launch-reset"
echo "  ${STATUS}"
DONE="$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("done"))' 2>/dev/null || echo parseerror)"
[ "$DONE" = "False" ] || {
  [ "$DONE" = "True" ] && die "the launch reset ALREADY RAN on ${BASE} - it is one-shot and will not run again"
  die "unexpected status response (wrong admin token?): ${STATUS}"
}
echo "  not yet run - good."
[ "$STATUS_ONLY" = "1" ] && { echo; echo "(--status: stopping here, nothing changed)"; exit 0; }

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="launch-reset-backup-${TS}.json"
say "2/5  Downloading the full pre-wipe backup to ${BACKUP_FILE}"
curl -sS --max-time 120 -H "x-admin-token: ${TOKEN}" "${BASE}/admin/launch-reset/backup" -o "${BACKUP_FILE}" \
  || die "backup download failed - NOTHING has been deleted"
python3 - "$BACKUP_FILE" <<'EOF' || exit 1
import json, sys
try:
    b = json.load(open(sys.argv[1]))
except Exception as e:
    print("FAILED: backup file is not valid JSON (%s) - NOTHING has been deleted" % e); sys.exit(1)
if "counts" not in b or "data" not in b:
    print("FAILED: backup file has no counts/data - NOTHING has been deleted"); sys.exit(1)
print("  backup verified. Record counts:")
for k, v in sorted(b["counts"].items()):
    print("    %-20s %s" % (k, v))
EOF

say "3/5  Point of no return"
echo "  This deletes EVERY account and leaderboard row on ${BASE}, permanently."
echo "  The backup above is your only way back."
printf '  Type exactly: WIPE EVERYTHING FOR LAUNCH\n  > '
read -r PHRASE
[ "$PHRASE" = "WIPE EVERYTHING FOR LAUNCH" ] || die "phrase did not match - nothing was deleted"

say "4/5  Running the wipe"
RESULT_FILE="launch-reset-result-${TS}.json"
HTTP="$(curl -sS --max-time 300 -o "${RESULT_FILE}" -w '%{http_code}' \
  -H "x-admin-token: ${TOKEN}" -H "content-type: application/json" \
  -X POST -d '{"confirm":"WIPE EVERYTHING FOR LAUNCH"}' "${BASE}/admin/launch-reset")" \
  || die "the wipe POST itself failed - check ${BASE} and ${RESULT_FILE} before retrying"
[ "$HTTP" = "200" ] || die "wipe refused or failed (HTTP ${HTTP}) - see ${RESULT_FILE}"
echo "  wipe reported OK. Full result (with the server's own embedded backup): ${RESULT_FILE}"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("  deleted:", json.dumps(r.get("deleted"))); print("  new leaderboard epoch:", r.get("epoch"))' "${RESULT_FILE}"

say "5/5  Verifying square one"
LB="$(curl -sS --max-time 20 "${BASE}/leaderboard")" || die "could not read /leaderboard back"
[ "$LB" = "{}" ] || die "/leaderboard is NOT empty after the wipe: ${LB}"
echo "  /leaderboard: {}  (empty - good)"
ACCTS="$(curl -sS --max-time 30 -H "x-admin-token: ${TOKEN}" "${BASE}/admin/accounts")" || die "could not read /admin/accounts back"
[ "$ACCTS" = "[]" ] || die "/admin/accounts is NOT empty after the wipe: ${ACCTS}"
echo "  /admin/accounts: []  (empty - good)"
FINAL="$(curl -sS --max-time 20 -H "x-admin-token: ${TOKEN}" "${BASE}/admin/launch-reset")"
echo "  marker: ${FINAL}"

say "Done. Everyone starts from square one. Keep ${BACKUP_FILE} and ${RESULT_FILE} safe."
