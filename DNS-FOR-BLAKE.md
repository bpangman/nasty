# DNS records for nastyboardgame.com — paste these into Squarespace

Go to Squarespace → Domains → **nastyboardgame.com** → DNS Settings. Add each row below as
its own record. Squarespace's form asks for Host / Type / Priority / Data — use exactly what's
listed. Don't delete anything already there unless it conflicts with one of these.

## The website (do this now)

Makes `nastyboardgame.com` and `www.nastyboardgame.com` show the same site that's live today
at bpangman.github.io/nasty.

| Host | Type | Priority | Data |
|---|---|---|---|
| `@` | A | — | `185.199.108.153` |
| `@` | A | — | `185.199.109.153` |
| `@` | A | — | `185.199.110.153` |
| `@` | A | — | `185.199.111.153` |
| `www` | CNAME | — | `bpangman.github.io` |

What each does: the four **A** records point the bare `nastyboardgame.com` at GitHub's
servers. The **CNAME** makes `www.nastyboardgame.com` work too, redirecting to the same place.

**After you save these:** it can take anywhere from a few minutes to a few hours for the
internet to catch up (DNS propagation). Once it does, the site will start loading at
`nastyboardgame.com` automatically — nothing else to do on your end. I'll turn on the padlock
(HTTPS) once GitHub confirms it sees the new address.

## The game server (not yet — one more thing needed from me first)

`play.nastyboardgame.com` will be where phones find the online game server, replacing the Mac
Mini eventually. I'm not ready to hand you those DNS lines yet — I need one more login-only
step from you first (see `server/cloud/DEPLOY-STEPS.md`, or just wait for me to ask). Once
that's done, I'll send you 1-2 more lines to add here, the same way as above. **Nothing about
how the game plays changes until then** — online games keep working exactly as they do today.

## Quick reference — what's live where, right now

- Website: still `bpangman.github.io/nasty` today; `nastyboardgame.com` comes online once the
  records above are saved and DNS catches up. Both will work at the same time during the
  switch — nothing breaks.
- Game server: still the Mac Mini at home, unchanged. `play.nastyboardgame.com` is a future
  step, not needed today.
