# Putting Nasty's online server in the cloud — the one step left for Blake

Right now, online games run through the Mac Mini at home. That's fine, but if the Mac
is ever off or asleep, online play stops working. There's a free cloud version ready
to go — built, tested, AND already switched on and running (2026-07-11). It just needs
one thing from you before it can actually take over: your home internet's security
feature is currently blocking it.

## What's happening

Your Spectrum/Charter internet has a built-in security feature called **Security
Shield** — it watches for shady websites and blocks them automatically. Because the
new cloud address is brand new (it went live today), Security Shield doesn't
recognize it yet and is treating it like a suspicious site, the same way it would
treat an actual scam site it's never seen before. It's not doing anything wrong,
it just needs to be told this one's OK.

I can't fix this myself — it's a setting in an app on your phone, not something in
the code.

## What to do

1. Open the **My Spectrum** app on your phone (or go to spectrum.com and log in).
2. Look for **Security Shield** or **Advanced Security** — it's usually under your
   WiFi or network security settings.
3. Either:
   - Add `dadio.deno.net` as a trusted/allowed site, **or**
   - Turn Security Shield off, let me finish testing everything, then turn it back
     on afterward with that exception saved.
4. Let me know (or I'll notice next time I check in) — once it's unblocked I'll
   finish the rest automatically: double-check everything works from a real phone,
   switch the website over to the cloud server, and keep the home Mac server running
   in the background for about a week as a safety net before fully retiring it.

Nothing about how the game plays changes for anyone — this is just where the
"phone-to-phone" relay lives. See `HANDOFF.md`'s "Cloud hosting" section (under
"The blocker") for the full technical writeup if you ever want it.
