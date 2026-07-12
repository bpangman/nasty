#!/bin/bash
# Starts a cloudflared quick tunnel for the Nasty relay server and publishes the public
# WS URL so the game client (served from GitHub Pages, which can't run its own server)
# can find it. Same ops pattern as the memo-mindmap / cortana-dashboard tunnels on this
# Mac Mini (see ~/Library/LaunchAgents/com.blake.memomindmap-tunnel.plist).
#
# Every time cloudflared reports a (new) public URL, this script rewrites
# /Users/jarvis/nasty-game/wsurl.json to point at it (as a wss:// URL, since the tunnel
# terminates TLS) and commits + pushes so GitHub Pages serves the new value within a
# minute. The client fetches that file (cache-busted) to discover the server — see the
# resolveWsUrl() function in index.html.

REPO_DIR="/Users/jarvis/nasty-game"
LOG_FILE="$REPO_DIR/tunnel.log"
URL_FILE="$REPO_DIR/wsurl.json"
PORT="${NASTY_PORT:-8484}"

update_wsurl() {
  # GATED (cloud cutover, 2026-07-12): wsurl.json now points at the cloud relay
  # (wss://play.nastyboardgame.com), and the site discovers the server from THAT file, not
  # this Mac's tunnel anymore. Left this function and its call site intact (not deleted) so
  # a rollback is just deleting the two lines below and un-commenting nothing else -- the
  # tunnel/server themselves keep running in drain mode so any game already in flight here
  # finishes normally. See HANDOFF.md's "Cloud hosting" section, rollback subsection.
  echo "[tunnel.sh] Cloud cutover is live -- skipping wsurl.json auto-republish (would overwrite the cloud URL with a stale tunnel URL)." | tee -a "$LOG_FILE"
  return 0
  local https_url="$1"
  local wss_url="${https_url/https:\/\//wss://}"
  echo "[tunnel.sh] New tunnel URL: $https_url -> $wss_url" | tee -a "$LOG_FILE"
  local tmp
  tmp=$(mktemp)
  printf '{"url":"%s","updated":"%s"}\n' "$wss_url" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv "$tmp" "$URL_FILE"
  cd "$REPO_DIR" || return
  git add wsurl.json
  if ! git diff --cached --quiet; then
    git commit -m "chore: update online-play server URL to ${wss_url}" >> "$LOG_FILE" 2>&1
    git pull --rebase >> "$LOG_FILE" 2>&1
    git push origin main >> "$LOG_FILE" 2>&1
    echo "[tunnel.sh] wsurl.json committed and pushed." | tee -a "$LOG_FILE"
  fi
}

/opt/homebrew/bin/cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOG_FILE"
  if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
    update_wsurl "${BASH_REMATCH[0]}"
  fi
done
