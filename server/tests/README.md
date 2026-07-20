# v0.15 test suites (server-authoritative online rebuild)

Every script here launches its OWN private server instance (random port, scratch
`NASTY_ROOMS_DIR`/`NASTY_KV_PATH`, throwaway admin token) - none of them ever touch the
production LaunchAgent, the real rooms dir, `server/leaderboard.json`, or the default KV.
Playwright is loaded from `/Users/jarvis/clawd/node_modules/playwright` (this machine's
existing install, same as every prior release's test tooling).

Run everything from this directory with plain `node <script>`; scripts that support the Deno
server take `SERVER=deno` as an env var.

| Script | What it proves | How to run |
|---|---|---|
| `../test-engine-sync.js` | generated engine files match index.html (run via `npm test` in `server/`) | `cd .. && npm test` |
| `../test-engine-headless.js` | full CPU-vs-CPU games straight against the engine module | (same `npm test`) |
| `smoke_server.js` | raw wire-protocol basics vs the Node server (protocol handshake, unattended all-CPU game, illegal-move rejection, tableSpeed) | `node smoke_server.js` |
| `smoke_deno.js` | same vs the Deno server + KV snapshot-size check | `node smoke_deno.js` |
| `restart_deno.js` | SIGKILL the Deno server mid-game, restart on the same KV path, game continues from the KV snapshot | `node restart_deno.js` |
| `protocol_checklist.js` | the FULL protocol surface, 53 checks as of v0.23.1 (version handshake incl. protocol 1/2/3 lockouts, lobby flows, reclaim incl. contested approve/deny, pause, presence, nudge, leaderboard/solo-result/epoch, admin god-mode, CORS, rate limit, AASA, /join redirect) | `node protocol_checklist.js node` / `node protocol_checklist.js deno` |
| `chaos_v15.js` | Playwright chaos scenarios: `full` (clean game), `hostbg` (THE host-background repro of Blake's bug), `chaos N` (N full games with realistic random background/reconnect cycles + convergence after every cycle) | `node chaos_v15.js full` / `hostbg` / `chaos 3`; prefix `SERVER=deno` for the Deno server |
| `reconnect_storm.js` | the v0.7.4/v0.9-era kick-harness recipe on the new architecture: 4 human seats, rotate dropping/reconnecting one per cycle mid-play, convergence after every cycle | `node reconnect_storm.js 18` / `SERVER=deno node reconnect_storm.js 18` |
| `test_leaderboard_scenarios.js` | leaderboard exactly-once: solo w/ server reachable, solo w/ server down then queue drain, online game server-side recording + reconnect-no-double | `node test_leaderboard_scenarios.js` |
| `test_leaderboard_split.js` | v0.21 solo/teams point split: new-style client writes hptsS/hptsT directly, a legacy (pre-split) client's plain hpts delta gets attributed to the right bucket (plus a non-win and an orphan-hpts edge case), and the boot/startup migration derives split keys from pre-existing legacy-only data (unambiguous + genuinely-ambiguous wins-ratio cases, mirrors real production shape) - idempotent across a second boot | `node test_leaderboard_split.js node` / `node test_leaderboard_split.js deno` |
| `test_leaderboard_ui_split.js` | v0.21 leaderboard Solo/Teams tab UI: tab math + exact empty-state copy for each tab (direct renderLb()/setLbTab() calls), the v0.19.1 fixed-layout table still fits at 320px with zero wrapped cells on BOTH tabs, and an end-to-end pass against a real global board (default tab is Solo, switching tabs filters correctly, reopening resets to Solo, admin panel's split-points editor unlock/edit/save reflected back in the tabs) | `node test_leaderboard_ui_split.js` |
| `soak_offline.js` | the standing offline soak recipe (`#autotest` 4P / `#autotest6` 6P), bit-identical-offline regression check | `node soak_offline.js both` |
| `test_v16_features.js` | v0.16 items 2/4/6: ready-up gate, "Leave for good" CPU takeover + leaderboard exclusion, non-host pauseToggle reaching everyone | `node test_v16_features.js node` / `node test_v16_features.js deno` |
| `test_push_notifications.js` | v0.16 item 5: `registerPush` accepted + persisted, no push while connected, exactly-once would-send-push log on disconnect (with the right token/name), no push for a seat with no registered token | `node test_push_notifications.js node` / `node test_push_notifications.js deno` |
| `test_recalibration.js` | v0.20: the "resync" wire message (live-connection fresh snapshot, no presence ripple, silently ignored if never identified); the ACTUAL root-cause reproduction (silent background-freeze drift + genuine table idle, no self-heal without this fix); input lock during recalibration; the failure path + tap-to-reset recovery; killing the server mid-recalibration then restarting and recovering via Reset connection; a pre-v0.20 client (never sends "resync") still playing normally against the new server | `node test_recalibration.js node` / `node test_recalibration.js deno` |

Expected results as of v0.15 (2026-07-16) are recorded in HANDOFF.md's v0.15 section - if a
run here diverges from those numbers, treat it as a regression until proven otherwise.
