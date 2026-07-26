# NASTY prelaunch - things deliberately parked

Work that is BUILT or DESIGNED but intentionally not switched on yet. Nothing here is broken or
half finished. Each item says what is done, what is left, and what Blake has to do.

Tabled 2026-07-25 at Blake's request: "Let's table these other account SSO for now. Save it in a
prelaunch folder to go back to."

---

## 1. Google, Facebook, and email-code sign-in - TABLED

**Status: server side fully built, tested, deployed, and switched off. Nothing to redo.**

All four sign-in methods (Apple, Google, Facebook, passwordless email codes) exist on both game
servers today. They are inert because no provider credentials are configured, so every
`/account/*` request answers "accounts are not set up yet" (HTTP 503). Verified live in
production.

What is left for each is ONLY Blake registering the app with that provider and sending back the
identifiers. Click-by-click steps are in `signin-setup-instructions.md`:

- **Google** - about 20 minutes, free, no waiting, no review. Two OAuth client IDs (one web, one
  iOS) in one Google Cloud project. A personal gmail account is fine. This is the highest value
  one to do next, since it covers anyone on Android or Windows.
- **Email codes** - about 20 minutes plus DNS records. Needs a transactional email service
  (Resend recommended, free tier is far more than enough). The safety net for family members with
  no Apple or Google account.
- **Facebook** - the awkward one. Business verification plus an app review, so days of waiting on
  other people. Everything else works while it sits unfinished, and skipping it forever costs
  nothing.

**Apple is NOT tabled** - it is being switched on for the iPhone app. See item 2.

---

## 2. Apple sign-in on the WEBSITE - TABLED (the app is going ahead)

The iPhone app's Apple sign-in needs only the App ID capability, which Blake has completed.

The WEBSITE flow additionally needs a domain verification file hosted at
`nastyboardgame.com/.well-known/apple-developer-domain-association.txt`. Apple's developer portal
would not surface the Download button for it on 2026-07-25 despite the Services ID being
correctly configured, so this is parked rather than fought.

Already done and confirmed correct:

- App ID `com.pangman.nasty` has the Sign in with Apple capability enabled.
- Services ID `com.pangman.nasty.web` exists, with **Primary App ID set to
  `YJU5U6VX8V.com.pangman.nasty`**. This is the setting that makes the phone and the website the
  same person rather than two accounts. It is correct. Do not change it.
- Domain `nastyboardgame.com` and return URL
  `https://nastyboardgame.com/apple-callback.html` are registered, shown as "2 Website URLs".

Left to do: get the domain association file out of Apple, host it, click Verify. Retry in Safari,
or via the blue **+** next to "Website URLs" in the Web Authentication Configuration panel.

---

## 3. The account-only leaderboard switch - BUILT, OFF, waiting on Blake's word

Blake's decision: accounts stay optional for playing, but going forward only signed-in players
build up and appear on the shared leaderboard.

Implemented behind `NASTY_LEADERBOARD_ACCOUNTS_ONLY`, default OFF. With it off the leaderboard
behaves exactly as it always has, byte for byte. Flipping it is a deliberate, reversible env
change with no redeploy and no data migration.

Do NOT flip this until the sign-in screens actually ship, or people lose their place on the board
with no way to claim it.

---

## 4. The one-time name claim window - BUILT, OFF

So existing players can attach the history they already have to a new account. Blake's rule: the
claim exists for the next update only, then disappears forever. Controlled by
`NASTY_CLAIM_WINDOW_OPEN` and `NASTY_CLAIM_DEADLINE`.

Unclaimed names are never deleted. They stay visible on the board as frozen history.

Must not be opened before the leaderboard read includes the account namespace, or a claimed row
would vanish from view until that lands.

**Blake still to decide:** how long the window stays open. Suggested six to eight weeks.

---

## 5. Compliance work that MUST happen before accounts are announced

- `privacy.html` and `support.html` both currently state the app has no accounts. That becomes
  false the moment sign-in ships, so both need rewriting.
- App Store Connect privacy labels need updating: Identifiers (User ID) and Usage Data (Product
  Interaction), both linked to the user, tracking NO. Contact Info (Email) is added only once a
  provider that returns an email is enabled.
- **The kids question, still open with Blake:** once the leaderboard is account-only, family
  members without accounts stop appearing on it, including the grandchildren, and there are legal
  limits on creating accounts for under-13s. They can still play everything and still see their
  own record on their own phone. Blake should confirm he expects this before it goes live.

---

## Files here

| File | What it is |
|---|---|
| `signin-setup-instructions.md` | Plain-language, click-by-click provider setup written for Blake |
| `accounts-design.md` | The full technical design: verification, linking, storage, staging, rollback |

The server implementation itself lives in `server/server.js` and `server/cloud/server.ts` (search
`/account/`), with test suites `server/tests/test_accounts_*.js`.
