# Reconnect Research for Nasty (iOS backgrounding, real-game patterns, testing)

Research date: 2026-07-18. Scope: no code changes, research only. Written against the actual
architecture as of v0.20 (HANDOFF.md v0.15/v0.16/v0.20 sections + index.html's § NET block):
server-authoritative Deno Deploy websocket server, thin renderer clients (Capacitor WKWebView app
+ mobile Safari), snapshot-based reconnect (`bootGameFromSnapshot()`), unconditional foreground
recalibration (`triggerRecalibration()` -> `resync` -> `sync` snapshot), problem-only
`#connIndicator`, manual "Reset connection", "Leave for good" CPU takeover, turn push
notifications, and the confirmed relic: `hostStatus` broadcasts + the blocking `#waitHostOverlay`
("PAUSED - waiting for host") at index.html ~line 1090 / `case 'hostStatus'` ~line 5019.

No em or en dashes appear anywhere in this document (standing rule) - plain hyphens only.

---

## (a) What actually happens to a WKWebView app when iOS backgrounds it - the facts

**1. The whole JS runtime freezes, and it freezes fast.**
When an iOS app leaves the foreground, the system suspends it shortly after - unless the app
holds a `beginBackgroundTask` grant, which is ~30 seconds max on modern iOS (it used to be 180s;
iOS 13 cut it to 30s, and the amount is never guaranteed)
(https://developer.apple.com/forums/thread/85066,
https://www.appsonair.com/blogs/background-execution-limits-in-ios-what-every-developer-must-know).
A suspended app executes zero code: no JS, no timers, no `setInterval` heartbeats, no `onmessage`
callbacks. Apple engineers state this plainly for WKWebView: JS execution pauses in the
background and resumes on foreground, "for the same reasons any app that is suspended no longer
gets to execute code" (https://developer.apple.com/forums/thread/64150). Capacitor does nothing
to change this - it IS a WKWebView.

**2. The TCP socket under a WebSocket enters an undefined half-open state, and close events are
NOT reliably delivered.**
Apple's own guidance: the distinction that matters is running vs suspended, not foreground vs
background - a suspended app's network connections are not gracefully torn down on its behalf,
they just stop being serviced (https://developer.apple.com/forums/thread/716118). Depending on
how long the app was gone, the carrier NAT, and iOS version, on return the socket may be:
- genuinely still alive (short background stints - pings will round-trip),
- dead at the TCP level but still reporting `readyState === OPEN` to JS (no `onclose` ever
  fired because JS was frozen when the teardown happened, and WebKit does not synthesize one
  on resume),
- alive at the TCP level but with messages that were broadcast during the freeze permanently
  lost to this client (delivered to a frozen page, never queued for replay).

That third shape is exactly what v0.20's root-cause writeup found independently ("ping succeeds
but the client is still stale"). It is a known, externally documented failure class, not
something unique to Nasty.

**3. iOS 15 made it worse: WKWebView WebSockets moved to NSURLSession and got new bugs.**
WebKit bug 228296 (https://bugs.webkit.org/show_bug.cgi?id=228296, also
https://developer.apple.com/forums/thread/685403) documents the NSURLSessionWebSocketTask-backed
implementation: connections that go bad after backgrounding/sleep, close events that never fire,
sockets stuck "connecting" after resume, and in bad cases an inability to reconnect at all until
the page is reloaded. The workaround developers converged on in that thread: proactively CLOSE
the socket on `visibilitychange: hidden` and rebuild it from scratch on return, instead of
letting the OS half-kill it - "closing the WebSocket connection manually when the page is
backgrounded prevents this issue". Partial fixes shipped in iOS 15.4 but reports continued.
Takeaway: never trust a socket that lived through a backgrounding, and consider not letting it
live through one at all.

**4. None of the foreground events is individually reliable; production apps fire on all of them
and make the handler idempotent.**
- `visibilitychange` / `pageshow`: WebKit has a long history of missing or mis-ordered
  visibility events on iOS, especially in standalone/wrapped contexts
  (https://bugs.webkit.org/show_bug.cgi?id=202399,
  https://bugs.webkit.org/show_bug.cgi?id=199854,
  https://github.com/w3c/page-visibility/issues/59). Firefox is the only browser that fires
  visibilitychange reliably in all cases; Safari is a known laggard.
- Capacitor's `appStateChange`/`resume` (bridged from native
  `UIApplication.didBecomeActiveNotification`, https://capacitorjs.com/docs/apis/app) has its
  own gotchas: it can fire spuriously when native UI (dialogs, pickers) covers the webview
  (https://github.com/ionic-team/capacitor/issues/5320), and after a webview process kill it
  can fire BEFORE the reloaded webview is ready to receive it, so the JS handler never runs
  (https://github.com/ionic-team/capacitor-plugins/issues/2357).
- The nuclear case: under memory pressure iOS kills the WKWebView CONTENT PROCESS of a
  backgrounded app. On return, `webViewWebContentProcessDidTerminate` fires natively and
  Capacitor reloads the page from scratch - the JS world is brand new, no foreground event of
  the old world ever fires, and users see a white screen or a cold boot
  (https://github.com/ionic-team/capacitor/discussions/7097,
  https://github.com/ionic-team/capacitor/discussions/5488). Any resume design must treat
  "cold page load with a live room in localStorage" as just another resume path.

Nasty already listens on all three (v0.16: `visibilitychange` + `pageshow` + Capacitor `resume`)
plus a 45s silence watchdog, which matches best practice. The cold-reload path is the one that
deserves a fresh look (see recommendations).

**5. What production apps do instead of trusting events or readyState:**
- Bridge the NATIVE lifecycle signal to JS (Capacitor does this for you) and treat it as the
  primary signal, browser events as backup.
- On every resume: assume nothing, verify liveness with an application-level ping with a short
  ack timeout, or skip verification entirely and rebuild the socket + refetch full state
  unconditionally (https://websocket.org/guides/heartbeat/,
  https://websocket.org/guides/reconnection/). The heartbeat guide's mobile section says it
  directly: send an immediate heartbeat on foreground, treat a missed pong as "reconnect now".
- Never use `readyState` as proof of anything except "definitely dead" (CLOSED means dead;
  OPEN means nothing).
- Do NOT try to keep the socket alive in the background with audio/VoIP background modes: App
  Review rejects background modes without a user-visible feature that requires them (guideline
  2.5.4, https://developer.apple.com/documentation/xcode/configuring-background-execution-modes,
  https://developer.apple.com/forums/thread/66157,
  https://github.com/daltoniam/Starscream/issues/455). Community plugins that do this exist
  (https://github.com/bokolob/capacitor-websocket) and are exactly the App Store risk a family
  game should not take. The sanctioned pattern for "something happened while you were away" is
  a push notification - which Nasty already built in v0.16 item 5.

---

## (b) Patterns from real server-authoritative turn games, mapped to Nasty

**Pattern 1 - session identity separate from connection identity; full snapshot on every
(re)connect.**
Colyseus: `reconnectionToken` changes per connection but `sessionId` persists; the reconnecting
client gets current state, not history (https://docs.colyseus.io/room/reconnection).
websocket.org's reconnection guide: issue session IDs, present them on reconnect, resume state
server-side (https://websocket.org/guides/reconnection/). Lichess versions every game event and
can replay from version v, but the client's join always starts from a full current-state fetch
with the event buffer only covering the small race window
(https://www.davidreis.me/2024/what-happens-when-you-make-a-move-in-lichess,
https://github.com/lichess-org/lila-ws).
*Nasty today:* already does this well - rejoin tokens + `gameSnapshotFields()` full snapshot,
no log replay (v0.15), `resync` for the socket-still-open case (v0.20). For a game whose whole
state serializes to ~2.9KB, snapshot-always is strictly simpler and safer than sequence-numbered
replay buffers; replay buffers earn their complexity only when state is huge or bandwidth is
scarce. Keep snapshot-always. The `seq`/`appliedSeq` machinery Nasty keeps is for digest
checkpointing and in-flight ordering, not replay - that is the right scope for it.

**Pattern 2 - the server never pauses for a disconnected NON-current player; presence is a
passive indicator, not a blocking overlay.**
Colyseus docs for turn-based games: mark the player disconnected IN STATE "so other clients can
show appropriate UI" and let the game proceed (https://docs.colyseus.io/room/reconnection,
https://docs.colyseus.io/faq). Nakama match handlers keep running even with zero connected
presences (https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative/). Lichess and
chess.com show a small "opponent disconnected/reconnecting" line, never a modal that blocks the
connected player's own view.
*Nasty today:* v0.15 made the ENGINE never pause for a gone host, but the UI still has the
relic: `hostStatus{connected:false}` -> full-screen `#waitHostOverlay` "PAUSED - waiting for
host" on every client, which is false (the server is running the game) and blocking. This is
the single clearest gap vs the industry pattern. Presence data already exists (`NET.presence`,
green/gray dots in the reunion lobby) - the board just never uses it passively.

**Pattern 3 - when the CURRENT player is gone: grace period, then an explicit escalation ladder,
sized to the game's stakes.**
Chess.com (competitive, rated): forfeit timer of 10% of base time, min 30s max 3min, starting
only when it becomes the disconnected player's turn
(https://support.chess.com/en/articles/8593801-how-does-game-abandonment-work). Colyseus
suggests ~5 minutes of reconnection allowance for turn-based games. Words With Friends sits at
the far end: fully async, turns wait days, presence is irrelevant. A family game belongs near
the async end: no forced forfeits, but visible progress signals and a manual escape hatch.
*Nasty today:* already has the right pieces - the server just waits (correct), a turn push
notification fires when the on-turn player is disconnected (v0.16 item 5), Nudge exists in the
reunion lobby, and "Leave for good" is the terminal CPU-takeover. What is missing is the middle
of the ladder: the OTHER players currently see nothing telling them why the table is idle or
what is being done about it, and there is no way to move the game along without the missing
player permanently giving up their seat.

**Pattern 4 - treat every resume as a cold rejoin: rebuild-and-resnapshot unconditionally.**
The WebKit bug 228296 community workaround (close on hide, rebuild on show), websocket.org's
mobile guidance (immediate heartbeat on foreground, reconnect on any doubt), and the general
"never trust readyState" rule all converge on: on resume, do not diagnose, just resynchronize.
*Nasty today:* v0.20 already implements exactly this (unconditional `triggerRecalibration()` on
every foreground, input locked during the window, `bootGameFromSnapshot()` at the end of both
paths). Two refinements remain: (1) the socket-looks-open path sends `resync` into a possibly
frozen socket and waits the full `RECAL_FAIL_MS` (6000ms) before involving the user - real apps
put a short ack timeout (~2s) on that first request and then AUTOMATICALLY tear down and
reconnect before ever showing a failure message; (2) consider the 228296-style stronger form on
iOS: proactively close the socket on `visibilitychange: hidden` so resume is ALWAYS the clean
"socket dead, full rejoin" path and the half-open zombie shape can never occur. That trades a
tiny reconnect cost (~95-150ms measured in Nasty's own reconnect_storm numbers) for eliminating
the least-testable failure mode entirely.

**Pattern 5 - heartbeats sized to mobile NAT, both directions, with fast zombie verdicts.**
Cellular NAT gateways drop idle mappings in as little as 30s; the common recommendation is an
app-level heartbeat every ~25-30s (75% of the shortest infrastructure timeout), pong timeout
~10s, 2-3 missed beats = dead, reconnect immediately (https://websocket.org/guides/heartbeat/,
https://websocket.org/guides/troubleshooting/timeout/,
https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view). Browsers cannot send
protocol-level pings from JS, so app-level `{"type":"ping"}` messages are the standard (Nasty's
Deno server already does exactly this because Deno Deploy exposes no frame-level ping).
*Nasty today:* server-side keepalive exists on both servers (v0.16); client-side the mid-game
silence watchdog is 45s. 45s of silence is longer than the 30s NAT floor - if the server's own
ping cadence is slower than ~25s, an idle table on cellular can lose its NAT mapping before
either side notices. Worth checking the actual server ping interval and tightening so that SOME
message crosses the wire at least every ~25s in each direction during idle play.

**Pattern 6 - exponential backoff with jitter, reset on user-visible retry and on foreground.**
Standard: start ~500-1000ms, double, cap (Nasty caps at 8s - fine), add jitter to avoid
thundering herd (matters little at family scale, costs one line), cap total automatic retry
time and then hand control to the user (https://websocket.org/guides/reconnection/).
*Nasty today:* v0.20 already fixed the important half (manual "Reset connection" resets
`NET.backoff` to the floor). The remaining nit: a FOREGROUND event should also reset the backoff
- if the app comes forward while a previous background-era retry streak has escalated to 8s,
the user stares at "Recalibrating..." for up to 8s for no reason. Resume is a user-visible
retry; treat it like the tap.

**Pattern 7 - notify the away player out-of-band instead of holding the table.**
The sanctioned iOS pattern (see (a)5): push notification on "it is your turn and you are not
here". Colyseus/Nakama games do this via their notification services; chess.com does it; Words
With Friends is built entirely on it.
*Nasty today:* built (v0.16 item 5) but INERT - the APNs key was still Blake's outstanding
manual step as of the v0.16 writeup. Until that `.p8` lands, the single most effective
"current player is gone" mitigation is switched off. Zero engineering, pure ops.

**Pattern 8 - reject the "keep it alive in the background" temptation entirely.**
Some shipped apps hold sockets open with audio/VoIP background modes; App Review rejects this
when discovered (guideline 2.5.4 - background modes must serve a user-visible feature), and it
burns battery in a way families notice
(https://developer.apple.com/documentation/xcode/configuring-background-execution-modes,
https://developer.apple.com/forums/thread/66157). Correct for Nasty: design for death, not
survival - which v0.15/v0.20 already did. No change needed; recorded so no future session
"discovers" this hack.

---

## (c) Prioritized recommendations for Nasty

**P0 - Kill the host-pause relic (`#waitHostOverlay` + client `hostStatus` handling).**
The overlay contradicts the v0.15 architecture: the server runs every CPU turn, deal, and
bow-out regardless of the host. What should replace it:
- Client: delete the `$('waitHostOverlay').classList.toggle(...)` line in `case 'hostStatus'`
  (index.html ~5019) and the overlay markup (~1090) for the IN-GAME case. Keep
  `NET.hostConnected` if anything still reads it (setTableSpeed hostness, lobby UI).
- Replace with the passive presence pattern (Pattern 2): grey/dim the disconnected player's
  name plate (any player, not just host - `NET.presence` already has the data via the existing
  `presence` broadcasts) plus at most a small one-line toast "X lost connection" /
  "X is back". No modal, no input block, nothing that stops a connected player from playing
  their own turn.
- Server: `hostStatus` broadcasts can stay (they are informational and old clients expect
  them); the fix is purely how clients render it. A later protocol pass can fold host presence
  into the general `presence` map and retire `hostStatus`.
- The ONE case where a host-gone overlay was arguably useful - a lobby that has not started -
  is not a game; the lobby can keep whatever messaging it wants.
- Safety: this is a client-render-only change, no engine or wire change, deployable website-
  first (old app builds keep showing the overlay until their next build, which is only
  cosmetically wrong, not a compatibility break).

**P1 - Wire the APNs key (ops, not code).** The turn-push system is the industry-standard
answer to "current player backgrounded" and it is fully built but keyless. Get the `.p8` + Key
ID from Blake, drop per the v0.16 runbook (`server/apns-key.p8`, `server/apns-key-id.txt`,
`NASTY_APNS_KEY`/`NASTY_APNS_KEY_ID` secrets on Deno Deploy). Everything downstream activates
automatically.

**P2 - Harden the resume flow end to end.** Target state, every path:
1. App comes forward (any of the three events, or a cold page load after a webview process
   kill - see step 5). Handler is idempotent; multiple events collapsing into one
   recalibration is already how v0.20 works (`recalStartedAt` anchors the streak).
2. Reset `NET.backoff` to its floor on foreground (Pattern 6) before anything else.
3. iOS app (IS_APP) or any WKWebView context: skip the "socket looks open" optimism -
   proactively `ws.close()` and go straight to `scheduleReconnect()` -> rejoin -> snapshot
   (Pattern 4 strong form, per WebKit 228296). Plain desktop browser can keep the lightweight
   `resync` path. Alternatively (weaker but smaller change): keep `resync` first but arm a
   ~2s ack timer - no `sync` back in 2s means auto `hardResetConnection()`, no user
   involvement; `RECAL_FAIL_MS` then only ever gates the message that asks the user to act.
4. Snapshot lands -> `bootGameFromSnapshot()` (unchanged) -> unlock input, hide chip. The
   "Recalibrating..." lock plus sub-second convergence already reads as a blip; keep it.
5. Cold-reload path: if the page boots with a live `nasty-last-room` pointer and a rejoin
   token for a STARTED room, silently rejoin to the board (no resume-tile tap, no reunion
   lobby, no auto-pause). Today a webview process kill lands the player on the menu, and the
   tile path (`enteringViaResume`) auto-pauses the whole room - a memory kill on one phone
   should never pause the family's table. Reserve the reunion/auto-pause flow for a
   deliberate next-day "Resume Saved Game" tap (heuristic if wanted: silent rejoin when the
   room was live within the last few minutes, reunion lobby otherwise).
6. Keep the manual escape hatches exactly as v0.20 built them (tappable chip +
   `btnResetConnection` in the pause menu, backoff floor reset on tap).
7. Ship the v0.20 post-ship lobby-lock fix (currently website-only, latent in build 27) with
   the next app build - it is part of this same resume story.

**P3 - Current-player-disconnected policy (family-appropriate escalation ladder).**
Recommended: no automatic forfeit, no automatic permanent CPU conversion (chess.com-style
timers are wrong for a living-room game; Colyseus's own turn-based guidance is minutes, not
seconds, and "mark disconnected in state, let others see it").
- 0-30s: nothing special. Their plate greys out (P0's passive presence). Server waits, as
  today.
- ~30s disconnected AND on turn: push notification fires (P1 - already the server's trigger
  logic). Other players see a passive line under the greyed plate: "Waiting for X. We sent
  their phone a nudge." Any player being able to re-trigger a nudge (rate-limited) reuses the
  existing Nudge machinery outside the reunion lobby.
- ~2-3 min disconnected AND on turn: offer the TABLE (any connected player, host not special)
  a non-destructive option: "Have the computer play this one turn for X" - single-turn CPU
  move via the existing `chooseAI()` on the server, seat stays human, X can return any time.
  This is the piece that unblocks a family game where someone fell asleep, without the
  finality of takeover.
- Permanent: "Leave for good" stays the player's OWN choice, as designed in v0.16. Optionally
  a table-side twin ("Replace X with a computer for good") behind a confirm, for the
  fell-asleep-for-the-night case; it can reuse the same `seatToCpu` action.
- Explicitly rejected: auto-timeout takeover (v0.16's own reasoning stands - false positives
  against a rare case a manual button covers), and background-mode socket keepalive (App
  Store risk, Pattern 8).

**P4 - Heartbeat tuning (small).** Verify both servers' keepalive cadence and the client
watchdog against the 25-30s mobile NAT reality (Pattern 5): server ping every ~25s, client
treats ~2 missed intervals as dead (i.e. tighten the 45s watchdog toward ~30s, or leave the
watchdog and rely on the server's cadence, but make sure SOMETHING crosses the wire every ~25s
in each direction on an idle table). Add jitter to `scheduleReconnect()` if it is one line.

---

## (d) Testing recipe that actually simulates iOS backgrounding

The core reason Playwright passed while iPhones failed: Playwright can fire `visibilitychange`
and monkey-patch sockets, but it cannot freeze the entire JS runtime, half-kill a TCP socket at
the OS level, or kill a webview process. The acceptance harness needs three layers.

**Layer 1 - socket-level chaos against the real client (fast, CI-able, no Mac GUI).**
Nasty's client already supports `?ws=` URL override (resolveWsUrl(), § NET) - point it at a
toxiproxy (https://github.com/shopify/toxiproxy) that forwards to a private local server
instance (`NASTY_PORT`/`NASTY_ROOMS_DIR` or `NASTY_KV_PATH`, never prod):
```bash
brew install toxiproxy       # or download the binary
toxiproxy-server &
toxiproxy-cli create -l 127.0.0.1:26379 -u 127.0.0.1:<NASTY_PORT> nasty
# freeze without closing (the WKWebView zombie shape, at the network layer this time,
# stronger than the existing monkey-patch because the client code path is 100% untouched):
toxiproxy-cli toxic add -t timeout -a timeout=0 nasty        # data silently stops flowing
sleep 20
toxiproxy-cli toxic remove -n timeout_downstream nasty       # un-freeze
# other useful toxics: latency (+jitter), reset_peer (RST, the fast-fail shape),
# slow_close, bandwidth
```
Drive the game with the existing Playwright harnesses (`chaos_v15.js`, `test_recalibration.js`
patterns) but with the guest's page loaded via `?ws=ws://127.0.0.1:26379`. Acceptance: during
the freeze the other seats keep advancing; after un-freeze + a fired foreground event, the
frozen client converges (normalized G fingerprint) within N seconds with zero user action; with
the freeze extended past the ack window, the client must AUTO reset the socket (P2.3) rather
than sit until the failure message.

**Layer 2 - real lifecycle on the Simulator (catches event plumbing, not true suspension).**
Known caveat first: the Simulator does not faithfully reproduce suspend/resume or background
socket teardown (https://forums.developer.apple.com/thread/14855) - use this layer to verify
the EVENT and RELOAD plumbing, not freeze semantics.
```bash
cd /Users/jarvis/nasty-game/app
npx cap sync ios   # already `npm run sync` per repo convention
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' \
  ios/App/App/Info.plist 2>/dev/null || grep -m1 PRODUCT_BUNDLE_IDENTIFIER \
  ios/App/App.xcodeproj/project.pbxproj | sed 's/.*= //;s/;//')
xcrun simctl boot "iPhone 16"                       # any installed runtime
xcrun xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath /tmp/nasty-sim build
xcrun simctl install booted <path-to-built .app>
xcrun simctl launch booted "$BUNDLE_ID"
# background the app by foregrounding another one (there is no simctl "suspend" verb):
xcrun simctl launch booted com.apple.Preferences
sleep 30
xcrun simctl launch booted "$BUNDLE_ID"             # returns Nasty to foreground
# webview/process kill path (the P2.5 cold reload):
xcrun simctl terminate booted "$BUNDLE_ID" && xcrun simctl launch booted "$BUNDLE_ID"
# push-notification path once APNs is wired (P1) - simulator accepts synthetic pushes:
xcrun simctl push booted "$BUNDLE_ID" payload.json
```
Pair it with `xcrun simctl openurl booted "https://nastyboardgame.com/join/CODE"` for the
Universal Link join flow. Assert via the server side (private instance logs / admin API) plus
`xcrun simctl spawn booted log stream --predicate 'processImagePath contains "App"'`.

**Layer 3 - real device, real suspension (the only faithful reproduction).**
This is the layer that would have caught what Playwright missed. Two options, both driven from
this Mac Mini:
- XCUITest (works on simulator AND a cable-connected/wifi-paired iPhone):
  `XCUIDevice.shared.press(.home)` then `XCTAssert(app.wait(for: .runningBackground,
  timeout: 5))`, `sleep(60)`, `app.activate()` (https://useyourloaf.com/blog/ui-testing-quick-guide/).
  Run via `xcodebuild test -workspace ios/App/App.xcworkspace -scheme App -destination
  'platform=iOS,name=<Blake's test iPhone>'`. A minimal UITest target with one test
  (launch -> join room by deep link -> home -> wait 60-120s -> activate -> screenshot +
  assert the board shows the expected turn banner) is enough; game-state assertions can come
  from the SERVER (the harness asks the private server for G and compares) so the UI test
  stays dumb.
- On-device manual checklist (zero infra, what a "family acceptance pass" means): a scripted
  4-seat game on the live site + one TestFlight phone: (1) background the phone 10s mid-CPU
  run, (2) background 2 min while it becomes the phone's turn (expect push once P1 lands),
  (3) lock the phone 5 min, (4) force-quit and relaunch, (5) airplane-mode 30s and back,
  (6) let iOS memory-kill the webview by opening the camera + 3 heavy apps, return. After
  every step: board converges within a few seconds, no blocking overlay, other phones never
  stalled, no stuck "Recalibrating...".
Add Network Link Conditioner (Settings > Developer on device / Xcode additional tools on the
simulator host) for the flaky-LTE variants of steps 1-2.

**Regression guard to keep from v0.20:** the socket monkey-patch freeze in
`server/tests/test_recalibration.js` stays the fast CI approximation of the zombie shape; the
toxiproxy layer checks the same shape without touching client internals; the device layer is
the ship gate for anything that changes § NET, § RECALIBRATION, or the Capacitor shell.

---

## Source list (primary sources first)

- https://bugs.webkit.org/show_bug.cgi?id=228296 (iOS 15 WKWebView websocket regressions, close-on-hide workaround)
- https://developer.apple.com/forums/thread/685403 (iOS 15 WKWebView websocket behavior)
- https://developer.apple.com/forums/thread/716118 (sockets vs suspension: running vs suspended is what matters)
- https://developer.apple.com/forums/thread/64150 (WKWebView JS pauses when backgrounded)
- https://developer.apple.com/forums/thread/85066 (beginBackgroundTask ~30s, subject to change)
- https://developer.apple.com/documentation/xcode/configuring-background-execution-modes (background modes must match a real feature)
- https://developer.apple.com/forums/thread/66157 (websockets in background: rejected without a qualifying feature)
- https://forums.developer.apple.com/thread/14855 (Simulator does not faithfully simulate suspend/resume)
- https://capacitorjs.com/docs/apis/app (appStateChange/resume bridged from UIApplication notifications)
- https://github.com/ionic-team/capacitor-plugins/issues/2357 (resume fires before reloaded webview is ready)
- https://github.com/ionic-team/capacitor/issues/5320 (appStateChange fires on native UI overlays)
- https://github.com/ionic-team/capacitor/discussions/7097 (white screen restoring from background)
- https://github.com/ionic-team/capacitor/discussions/5488 (webViewWebContentProcessDidTerminate on return to foreground)
- https://github.com/bokolob/capacitor-websocket (background-keepalive plugin, the pattern to avoid)
- https://github.com/daltoniam/Starscream/issues/455 (native socket libs cannot survive backgrounding either)
- https://bugs.webkit.org/show_bug.cgi?id=202399 and https://github.com/w3c/page-visibility/issues/59 (visibilitychange unreliability on iOS)
- https://websocket.org/guides/reconnection/ (backoff+jitter, session identity, replay vs snapshot)
- https://websocket.org/guides/heartbeat/ (25-45s heartbeats, 75% rule, zombie detection, foreground heartbeat)
- https://websocket.org/guides/troubleshooting/timeout/ (30s cellular NAT floor)
- https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view (25s interval, 3 missed = dead)
- https://docs.colyseus.io/room/reconnection and https://docs.colyseus.io/faq (allowReconnection, turn-based minutes-scale timeouts, mark-disconnected-in-state)
- https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative/ (match runs with zero presences; explicit rejoin)
- https://github.com/boardgameio/boardgame.io/issues/713 (re-sync on reconnect fix; master state on server)
- https://www.davidreis.me/2024/what-happens-when-you-make-a-move-in-lichess and https://github.com/lichess-org/lila-ws (versioned event buffer + state fetch on join)
- https://support.chess.com/en/articles/8593801-how-does-game-abandonment-work (disconnect forfeit timer: 10% base, 30s-3min, starts on the disconnected player's turn)
- https://github.com/shopify/toxiproxy (timeout/latency/reset_peer toxics for socket chaos)
- https://www.iosdev.recipes/simctl/ (simctl command reference)
- https://useyourloaf.com/blog/ui-testing-quick-guide/ (XCUIDevice press(.home), wait for .runningBackground, activate())
