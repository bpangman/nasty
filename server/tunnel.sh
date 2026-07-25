#!/bin/bash
# Starts a cloudflared quick tunnel for the Nasty relay server and publishes the public
# WS URL so the game client (served from GitHub Pages, which can't run its own server)
# can find it. Same ops pattern as the memo-mindmap / cortana-dashboard tunnels on this
# Mac Mini (see ~/Library/LaunchAgents/com.blake.memomindmap-tunnel.plist).
#
# STATUS: RETIRED as of the 2026-07-12 cloud cutover, and stopped + disabled on 2026-07-25.
# The game reaches the cloud relay (wss://play.nastyboardgame.com) via wsurl.json now; this
# Mac's tunnel is not part of how anyone gets to the game. Kept on disk as the rollback path
# (see update_wsurl() below for the exact steps) and because server.js is still the private
# test server every local test recipe spins up.
#
# It USED to rewrite /Users/jarvis/nasty-game/wsurl.json on every new tunnel URL and then
# commit and push it. It no longer writes, commits, or pushes anything - see the warning in
# update_wsurl() below, and do not put that back. The client discovers the server by fetching
# wsurl.json (cache-busted) - see resolveWsUrl() in index.html.

REPO_DIR="/Users/jarvis/nasty-game"
LOG_FILE="$REPO_DIR/tunnel.log"
URL_FILE="$REPO_DIR/wsurl.json"
PORT="${NASTY_PORT:-8484}"

update_wsurl() {
  # ############################################################################
  # DO NOT MAKE THIS SCRIPT COMMIT OR PUSH. EVER.
  # ############################################################################
  #
  # This script is started by a KeepAlive LaunchAgent (com.nasty.tunnel). It
  # restarts itself automatically and runs with nobody watching. Anything it is
  # allowed to do, it will eventually do unattended, at 3 AM, to Blake's LIVE
  # production repo.
  #
  # It used to rewrite wsurl.json and then run `git add` / `git commit` /
  # `git pull --rebase` / `git push origin main`. That body was deleted on
  # 2026-07-25. Do not restore it, do not reimplement it, and do not "just add
  # a small git push here" for convenience.
  #
  # Since the cloud cutover (2026-07-12) the game discovers its server from
  # wsurl.json, which points at the cloud relay wss://play.nastyboardgame.com.
  # This Mac's tunnel is no longer part of how anyone reaches the game.
  #
  # Both LaunchAgents were stopped and DISABLED on 2026-07-25 (they had kept port 8484 open to
  # the internet through a cloudflared quick tunnel for 13 days after the cutover, with nothing
  # pointing at them). The plists and server.js are deliberately kept - they are the rollback
  # path, and every local test recipe still uses server.js as a private test server.
  #
  # ROLLING BACK TO THIS MAC IS A DELIBERATE, HUMAN ACT. It is:
  #   1. re-enable and start the local server + tunnel again. `launchctl load` on its own is NOT
  #      enough now - they are disabled in the per-user override database, and a plain unload
  #      would not have survived a reboot anyway (launchd re-scans ~/Library/LaunchAgents at
  #      every login), which is why they were disabled properly rather than just unloaded:
  #        launchctl enable gui/$(id -u)/com.nasty.server
  #        launchctl enable gui/$(id -u)/com.nasty.tunnel
  #        launchctl load ~/Library/LaunchAgents/com.nasty.server.plist
  #        launchctl load ~/Library/LaunchAgents/com.nasty.tunnel.plist
  #   2. read the new https://<something>.trycloudflare.com URL out of
  #        /Users/jarvis/nasty-game/tunnel.log
  #   3. hand-edit /Users/jarvis/nasty-game/wsurl.json to the wss:// form of it
  #   4. review the diff, then commit and push it yourself, on purpose
  # See HANDOFF.md's "Cloud hosting" section, rollback subsection.
  #
  # All this function does now is note the tunnel URL in the log so a human
  # doing step 2 above can find it.
  echo "[tunnel.sh] Tunnel URL: $1 (informational only - wsurl.json is NOT auto-updated and this script never commits or pushes)." | tee -a "$LOG_FILE"
  return 0
}

/opt/homebrew/bin/cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOG_FILE"
  if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
    update_wsurl "${BASH_REMATCH[0]}"
  fi
done
