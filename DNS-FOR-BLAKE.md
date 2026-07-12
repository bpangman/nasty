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

**Save these right away** — the old `bpangman.github.io/nasty` address already forwards to
`nastyboardgame.com`, so until these records are saved, that forward lands on Squarespace's
"parked domain" page instead of the game. Once you save, it can take a few minutes to a few
hours for the internet to catch up (DNS propagation), then both addresses show the game again.
I'll turn on the padlock (HTTPS) once GitHub confirms it sees the new address.

**One more Squarespace thing while you're in there — IMPORTANT, please double-check this one
(2026-07-11 night check):** if the DNS page already shows records pointing at Squarespace
itself (their "parked page" — A records on `@` with values starting `198.185...` or
`198.49...`, or a `www` CNAME to `ext-sq.squarespace.com`), **delete those.** As of tonight the
new GitHub records ARE saved and correct, but the site is still randomly flipping between the
real game and the Squarespace "Coming Soon" page depending which server answers — that's the
signature of the OLD Squarespace records still sitting there alongside the new ones (both
answering at once, not a simple wait-it-out propagation delay). Please go back into DNS
Settings and remove any leftover `@` A records pointing at `198.185.x.x` / `198.49.x.x`, or a
leftover `www` CNAME to `ext-sq.squarespace.com` — just the new records above should remain.
The padlock (HTTPS) can't turn on until this is clean, since GitHub won't issue a certificate
while it's still seeing inconsistent answers for the domain.

## The game server — DONE, this is already live

`play.nastyboardgame.com` is live and healthy (the online relay server, replacing the Mac
Mini). No DNS action needed from you here — this part is finished.

## Quick reference — what's live where, right now

- Website: `nastyboardgame.com` DNS records are saved and mostly correct, but still flapping
  between the real site and Squarespace's parked page — see the "IMPORTANT" note above, this
  needs the leftover Squarespace records deleted before it's fully stable and before HTTPS can
  turn on.
- Game server: `play.nastyboardgame.com` — done, live, healthy. Online games now run in the
  cloud instead of the Mac Mini.
