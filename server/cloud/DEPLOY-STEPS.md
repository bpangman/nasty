# Putting Nasty's online server in the cloud — one step left for Blake

Right now, online games run through the Mac Mini at home. That's fine, but if the Mac
is ever off or asleep, online play stops working. There's a free cloud version ready
to go — built, tested, and running. Now that you own `nastyboardgame.com`, the plan
changed (in a good way): instead of asking your home internet to trust a random
Deno-owned address, the game will reach the cloud server at your own address,
`play.nastyboardgame.com`. See `DNS-FOR-BLAKE.md` at the top of the repo for the
Squarespace DNS records — that's the main thing to paste in.

## The other thing needed — a login, once, ~5 minutes

To finish wiring up `play.nastyboardgame.com` on Deno's side (the company hosting the
server), I need one more permission that only you can grant — a login-only step, no
typing DNS records or anything technical:

1. Go to **https://console.deno.com** and sign in the same way you did before
   (continue with GitHub).
2. Open the **dadio** organization → **Settings** → **Access Tokens** → **Create
   Token**.
3. Copy the token it gives you and send it to me (Cortana) — I'll save it the same
   way I saved the last one.

That's it — once I have that, I finish everything else myself: registering the
subdomain, giving you the exact DNS lines for Squarespace, waiting for it to verify,
and switching the site over. No further logins needed after this one, for this or
anything else Deno-related in the future.

## Heads-up for later

`nastyboardgame.com` is a brand-new domain too, so it's possible (not guaranteed) some
home network's security software flags it as "unfamiliar" for the first little while,
the same way Spectrum's Security Shield did with the old address. If that ever
happens, the fix is the same one-click "trust this site" step in whatever security
app is doing the blocking — I'll let you know if and when it comes up.

See `HANDOFF.md`'s "Cloud hosting" section (the "Custom domain cutover" part) for the
full technical writeup if you ever want it.
