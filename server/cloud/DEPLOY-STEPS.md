# Putting Nasty's online server in the cloud — 5-minute step for Blake

Right now, online games run through the Mac Mini at home. That's fine, but if the Mac
is ever off or asleep, online play stops working. There's a free cloud version ready
to go (built and fully tested) — it just needs YOU to sign in once with your GitHub
account (the "bpangman" one that owns the Nasty code) so the cloud service knows who
you are. After this one sign-in, every future update deploys automatically — no more
manual steps.

I can't do this step for you — it's a security sign-in screen only a real person can
click through (no password saved anywhere for me to use).

## What to do

1. Open Terminal on the Mac Mini and paste this exactly, then press Enter:

   ```bash
   cd /Users/jarvis/nasty-game/server/cloud
   export PATH="$HOME/.deno/bin:$PATH"
   deployctl deploy --project=nasty-relay --entrypoint=server.ts --prod \
     --env=NASTY_ADMIN_TOKEN="$(cat ../admin-token.txt)"
   ```

2. It will print a line that looks like:

   `Authorization URL: https://dash.deno.com/signin/cli?claim_challenge=...`

   Open that link (copy/paste it into a browser — Safari, Chrome, whatever's handy,
   on the Mac or even your phone).

3. You'll land on a "Sign in" page for Deno Deploy. There's a "Verify you are human"
   checkbox — check it, then click **"Sign in with GitHub."**

4. GitHub will ask you to log in (if you're not already) — use your normal `bpangman`
   GitHub username/password. Then click **"Authorize"** on the permissions screen.

5. That's it — go back to Terminal. It finishes on its own within a few seconds of
   you clicking Authorize, uploads the server, and prints a web address ending in
   `.deno.dev` (probably `https://nasty-relay.deno.dev`). That address is now live.

6. One more small thing so it keeps working on future updates: go to
   https://dash.deno.com, open the `nasty-relay` project → **Settings** →
   **Environment Variables**, add a new one named `NASTY_ADMIN_TOKEN`, and for the
   value run `cat /Users/jarvis/nasty-game/server/admin-token.txt` in Terminal and
   paste what it prints. Check the "secret" box, then Save.

Once you've done this, just let me know (or I'll notice next time I check) and I'll
finish the rest automatically — switching the live site over to the cloud server,
double-checking everything still works, and keeping the home Mac server running
as a safety net in the background for about a week before fully retiring it.

Nothing about how the game plays changes for anyone — this is just where the
"phone-to-phone" relay lives.
