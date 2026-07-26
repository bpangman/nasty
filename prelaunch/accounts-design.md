# NASTY - real accounts (Apple, Google, Facebook, email code) - implementation design

**Revision 2, 2026-07-25.** Revision 1 of this document designed an Apple-only account system.
Stage 1 of it was then BUILT and shipped as commit `3fb8f18` - live in production but completely
inert, because no provider is configured there.

Blake then changed the direction. This revision reflects that, and the server work described
here is **built, tested and committed** (see section 16 for exactly what is and is not done).
The client sign-in screens - iOS and web - are still not built.

Verified against production once, read-only, and never written to:
`GET https://play.nastyboardgame.com/health` -> `{"ok":true,...,"protocolVersion":5}`.

---

## 0. For Blake - what actually changes, in plain terms

Right now NASTY has no accounts. You type a name, and that name is all the leaderboard knows
about you. Anyone can type "Blake" and their wins land on your row. If you play on your iPad and
your phone, the leaderboard only ties those together because you typed the same five letters
both times.

Here is what the family will see once the sign-in screens are built and switched on.

**Nothing is forced. The game still opens straight to the menu and plays with no sign-in.**
Kids, cousins, whoever picks up a phone - they tap Play and go, exactly like today. Offline
games, pass-and-play, saved games, online rooms: all of it works with no account, forever. That
is not going to change.

**There are four ways to sign in, and none of them is a password.** There is no password
anywhere in this system and there never will be:

1. **Sign in with Apple** - the black button, Face ID, done. This one is first on purpose.
2. **Sign in with Google.**
3. **Sign in with Facebook.**
4. **Just an email address** - you type it in, we email you a six-digit number, you type the
   number back. That is the whole thing. It is there for anyone in the family who has none of
   the other three.

**Your account is the same account on your phone and on the website.** Same sign-in, same game
name, same leaderboard row. There is a real technical catch behind that for Apple specifically,
which is why the setup checklist tells you exactly which two identifiers to create and how to
connect them - get that wrong and the phone and the website would look like two different
people. Section 5 explains it and there is a test that fails loudly if it ever breaks.

**The leaderboard becomes account-only, going forward.** This is your call and it is what the
code now does. Playing needs no account. But from the update onward, only signed-in players
build up and appear on the shared family board. A guest's games still count on their own phone;
they just do not post to the shared board.

Two things you should know about that, honestly:

- **Kids in the family who do not have an account will stop appearing on the board.** Under the
  old behavior their games kept landing on a name row. Now they will not. If you want a
  grandchild on the board, someone has to sign them in - and there is a legal wrinkle about
  under-13s having accounts, covered in section 11.
- **It slightly raises the legal/App Store bar**, because "be on the leaderboard" now requires
  creating an account, which means more of the family will actually create one.

**The one-time "is this old history yours?" window.** In the update that introduces accounts,
anyone who signs in and picks a name that already has history on the board gets asked once:
*"There are already 47 games and 19 wins under the name Blake. Is that you?"* Yes moves it onto
their account, permanently, and it can be undone by hand if it goes wrong. **After that window
closes, that question is never asked again** - exactly as you asked for.

**Nothing on the board is ever deleted.** Any old name row nobody claims stays visible as
history. It just stops growing. Your family's real record from before accounts is not going
anywhere - no code path in this design removes it.

**What you have to do that I cannot do for you:** create the sign-in credentials on Apple's,
Google's and Facebook's developer websites, and sign up for one email-sending service. That is
click-by-click, in plain language, in a separate document:
**`blake-signin-setup.md`**, same folder as this one. Be warned up front: Facebook is the most
work by a distance (it needs a business verification and an app review before anyone outside
your own account can use it), and the email service needs a few DNS records on
`nastyboardgame.com`.

---

## 1. What changed from revision 1, and the two reversals

Blake's exact words:

> "For the sign-in claim on the leaderboard, only have that be for this very next update.
> Because then everybody who had been playing before, the account stage will have had the
> opportunity to claim their account. And if they don't, then the leaderboard claim no longer
> exists going forward. But I like the idea of making the account creation, optional and saying
> it's the only way you can get your name on the leaderboard tracker."

> "SSO should be Apple, Google, and Facebook with the option to type in a separate email and get
> a verification email code (still no passwords ever). Also please confirm accounts are the same
> whether accessed via app or web."

Four changes follow from that, and two of them reverse a recommendation revision 1 argued for
at length. Both reversals are Blake's decision, both are implemented, and both are written down
here as reversals rather than quietly swapped.

### 1.1 Four sign-in methods instead of one

Revision 1 section 9 item 1 recommended **against** Google, and item 5 recommended **against**
any email-based method. The reasoning for the Google objection was specifically that a second
provider creates unlinkable duplicate accounts. That objection is answered by the email method
Blake also asked for (see 1.2), so it no longer stands. The Facebook cost - business
verification, app review, a data-deletion callback - is real and is stated plainly in the setup
checklist rather than used to argue him out of it.

Apple stays first and is never removed. App Store guideline 4.8 requires Sign in with Apple to
be offered whenever another third-party login is, so dropping it is not an option.

### 1.2 REVERSAL 1 - a verified email is now stored

**Revision 1 section 4.5 deliberately stored no email at all**, and section 9 item 3 listed
"storing the Apple email" as a bad idea. The reason was privacy-label surface: not collecting it
kept **Contact Info > Email Address** off the App Store privacy questionnaire, which is the most
scrutinized line on that form.

That was the right call for one sign-in method. It is the wrong call for four. With Apple,
Google, Facebook and email all available, the same human will sign in with Apple on their phone
and Google on their laptop, and with nothing to match on, that is silently two accounts, two
game names and two leaderboard rows - the exact problem accounts exist to solve.

**So a verified email is now stored and used as the linking key.** The consequences, stated
plainly:

- The App Store privacy label now needs a **Contact Info > Email Address** entry: Collected =
  Yes, Linked to the user = Yes, Used for tracking = No, Purpose = App Functionality. Section 11
  has the full table.
- The privacy policy needs a sentence saying we store the email address your sign-in method
  gives us, and that deleting your account deletes it.
- There is now something to leak. It is one address per account, on Blake's own server, never
  shared, never sold, and deleted on account deletion.

What has NOT changed is the strictness. An address the provider did not vouch for
(`email_verified` false or absent) is never stored and never used as a key. That is asserted by
test B8a / P7b.

### 1.3 REVERSAL 2 - the leaderboard is account-only going forward

**Revision 1 section 9 item 2 recommended "strongly against, at any stage"** requiring an
account to appear on the global board, and section 16 item 11 called keeping unclaimed guest
rows accruing forever "the single best thing about this design".

Blake decided otherwise, and it is implemented. Accounts remain optional for **playing** -
local, pass-and-play and online all work signed out, and nothing in the code gates gameplay on
sign-in. But going forward only a signed-in account accrues on and appears on the shared board.

The two consequences Blake should know about, repeated here because they are the whole cost of
the decision:

1. **Children in the family without an account no longer appear on the board.** This is the
   thing revision 1 was protecting. It is a real loss and it is now the behavior.
2. **The compliance surface grows.** Appearing on the board now requires an account, so more
   people create one, so more of the family is inside the "we hold an identifier and an email
   for this person" category. Section 11 is written accordingly, including the under-13 gate.

### 1.4 The name claim is a one-time migration window

Revision 1 treated the claim as permanent. It is now a window with a hard sunset, after which
the endpoint refuses and the client stops offering it. Unclaimed rows are frozen, never deleted.
Section 6.

---

## 2. The approach in one paragraph

An **optional, guest-first account layer** keyed on a server-minted opaque `uid`, with four
independently-configured sign-in methods each verified **server-side** (OIDC token verification
against the provider's own JWKS for Apple, Google and Facebook Limited Login; Facebook's own
token-inspection endpoint for Facebook's classic web login; a hashed, short-lived, rate-limited
numeric code for the email method). A **verified email links** a returning human to their
existing account instead of creating a second one, with an explicit
"link another sign-in method" action for the case email cannot solve. Account leaderboard rows
live in a **separate storage namespace**, so nothing existing is migrated and reverting is a
flag. `/leaderboard` keeps exactly the flat `{displayName: {stats}}` body it serves today, so
every already-shipped build keeps rendering a correct board through the whole rollout. The
account-only board and the claim sunset are both **environment-variable switches, off/open by
default**, so the code can ship long before the policy does. Never require an account for
anything. Never touch `rejoin`. No new npm or JSR dependency: WebCrypto and core modules only.

---

## 3. Identity model

### 3.1 What is distinct

| Concept | Lifetime | Where it lives | Notes |
|---|---|---|---|
| **Account** (`uid`) | forever | server | opaque 16-byte hex the server mints; the only thing the account leaderboard is keyed on |
| **Identity** (`provider` + `sub`) | forever, several per account | server index | Apple sub, Google sub, Facebook app-scoped id, or a verified email address |
| **Verified email** | changeable | server | the linking key, and nothing else - it is never a login on its own except through the email code method |
| **Game name** | changeable, 30-day cooldown | server, mirrored to client | the 10-char label; unique across accounts by folded form |
| **Room `playerId` + `token`** | one room | server + `localStorage['nasty-net-'+CODE]` | **completely unchanged** |

No provider's identifier is ever the account id. That was true in revision 1 for one provider
and it matters much more with four.

Account record shape as built:

```json
{ "uid":"9f2c...", "provider":"apple", "sub":"001234.abc...",
  "identities":[{"provider":"apple","sub":"001234.abc...","linkedAt":1753400000000},
                {"provider":"google","sub":"1078...","linkedAt":1753400500000}],
  "email":"blake@example.com", "emailSource":"google", "emailPrivateRelay":false,
  "gameName":"Blake", "nameFolded":"blake", "nameChangedAt":0,
  "nameHistory":[], "claimDeclined":false,
  "created":1753400000000, "lastSeen":1753400000000, "refreshToken":null }
```

`provider`/`sub` are kept as their own fields purely so a record written by Stage 1 still reads
correctly; `identities` is the real list, and `accountIdentities()` reads through both shapes.

### 3.2 Name folding - unchanged

`leaderboardNameKey(s) = String(s).toLowerCase()`, already landed in both servers as part of the
2026-07-25 case-fold work, and reused verbatim for account name uniqueness and claim matching.
There is exactly one fold. `normalizeName()` (profanity matching) is a different function and is
deliberately not reused for identity.

### 3.3 Uniqueness and squatting

- **Folded game names are unique across accounts.** First claim wins; the second person picks
  something else. There is no softer rule that actually stops squatting.
- Renaming is allowed with a 30-day cooldown; history is keyed on `uid` so a rename rewrites one
  string and touches no counter. The old folded name is released back into the pool and a
  `nameHistory` entry is kept.
- **Under the account-only board, an unauthenticated submission under a signed-in player's name
  changes nothing.** It is answered `200 {ok:true}` (so no client ever retries forever) and
  simply does not post. Typing someone's name is no longer enough to score on their row - this
  falls out of the account-only switch and is asserted by test Z6/Z6b.

---

## 4. How each provider is verified

Everything is verified on the server. Nothing the client claims about who it is, is ever
believed. There is exactly **one** OIDC verifier, generalized from the Apple-only one Stage 1
shipped - three near-copies is how one of them quietly ends up missing a check.

### 4.1 The shared OIDC path - Apple, Google, Facebook Limited Login

`verifyOidcToken(cfg, token, expectedNonce)`, where `cfg` is `{issuers[], jwksUrl, audiences[]}`.
Checks, in this order, all mandatory:

1. **Nonce first, before any crypto.** The server issued it from `GET /account/nonce`, stored it
   single-use with a 10-minute life, and deletes it on first presentation whether or not it was
   still valid. This is the replay defence. On the Deno side it is consumed with an atomic
   check+delete so two isolates racing one nonce cannot both win.
2. **Size and shape**: exactly three dot-separated segments, at most 8192 characters, so a
   hostile 1 MB "token" is refused before anything parses.
3. **`header.alg === "RS256"`, as a hardcoded equality check.** The verifier never branches on
   what the token claims its algorithm is, so `alg:"none"` and the classic alg-confusion attack
   (an HS256 token MAC'd with the RSA public key as the shared secret) are closed by
   construction, not by a blocklist. Both are in the test suite.
4. **The signing key comes from that provider's published JWKS**, looked up by `kid`, cached six
   hours **per URL** (Apple, Google and Facebook each publish their own set at their own address
   and rotate on their own schedules, so they cannot share one cache slot). A `kid` we have never
   seen forces exactly **one** refetch, then fails closed. There is deliberately no
   "could not fetch keys, skip the signature" path anywhere.
5. **The RSASSA-PKCS1-v1_5 / SHA-256 signature**, via WebCrypto - `crypto.webcrypto.subtle` on
   Node, `crypto.subtle` on Deno. No JWT library, on either side.
6. **The claims**: `iss` in the provider's allowlist; `aud` in the configured audience list (an
   empty list means that provider is off and everything is refused); `exp` in the future; `iat`
   within ten minutes either way; `nonce` exactly equal to the one just consumed; `sub` a
   non-empty string.

Then, and only from a verified token: `email`, `email_verified` and `is_private_email`. Apple
sends the booleans as the strings `"true"`/`"false"`, Google sends real booleans; both are
handled, and anything ambiguous is treated as unverified.

**Provider specifics:**

| | Apple | Google | Facebook Limited Login |
|---|---|---|---|
| Issuer | `https://appleid.apple.com` | `https://accounts.google.com` **and** `accounts.google.com` (Google uses both spellings) | `https://www.facebook.com` |
| JWKS | `https://appleid.apple.com/auth/keys` | `https://www.googleapis.com/oauth2/v3/certs` | `https://www.facebook.com/.well-known/oauth/openid/jwks/` |
| Audience | the App ID **and** the Services ID | the iOS client ID **and** the web client ID | the Facebook app id |
| `sub` scope | per Apple-developer-team, per app | per Google Account, **the same across every client ID in one project** | app-scoped: one id per person per Facebook app |
| Env vars | `NASTY_APPLE_ISSUER`, `NASTY_APPLE_JWKS_URL`, `NASTY_APPLE_AUDIENCES` | `NASTY_GOOGLE_*` | `NASTY_FACEBOOK_ISSUER`, `NASTY_FACEBOOK_JWKS_URL`, `NASTY_FACEBOOK_APP_ID` |

The nonce is mandatory for all three. That is a real constraint on the client work still to
come: whichever native/web SDK is used must be one that can set a nonce and have the provider
echo it. Apple's `ASAuthorizationAppleIDRequest.nonce`, Google Identity Services' `nonce`
parameter (and any AppTh/ASWebAuthenticationSession OAuth request), and Facebook's
`LoginConfiguration(nonce:)` all do. An exception for any one provider is exactly how a replay
hole gets introduced, so there is none.

### 4.2 Facebook's classic web login - the one that is not OIDC

Facebook's JavaScript SDK on the web returns an **access token**, not a JWT. There is no
signature to check. The correct thing - and what is implemented - is to ask Facebook about it:

```
GET https://graph.facebook.com/v21.0/debug_token
      ?input_token=<the user's access token>
      &access_token=<app id>|<app secret>
```

and then require, from `data`:

- `is_valid === true`
- `app_id === our app id` - **this is the whole point.** Without it, an access token that some
  other app obtained for the same person would be accepted, which is the classic Facebook-login
  confused-deputy hole. Test Q3 asserts it.
- `expires_at` either 0 (never) or in the future
- `user_id` non-empty - this is the app-scoped id, and it is the `sub`

Then one more call, `GET /me?fields=id,email` with the *user's* token, to pick up the email for
linking. The id it returns must match the one `debug_token` reported or nothing is taken from
it. A failure here is not a sign-in failure - the email is a bonus.

This path needs the **app secret** on the server. With the app id configured but no secret, the
Limited Login (iOS) path still works and the access-token (web) path answers `nosecret`; test S5
covers both.

**Honest limit, stated rather than papered over:** the server nonce is still consumed on this
path, so a captured POST cannot simply be resent, but unlike the three OIDC providers the
Facebook access token itself is not cryptographically bound to that nonce. Facebook's own
short-lived-token expiry and the app-id check are what carry the weight there. If that is not
acceptable, the answer is to use Limited Login on the web too when Facebook supports it, not to
weaken anything here.

### 4.3 The email code - and how the mail actually gets sent

This is the part that had to be real rather than hand-waved.

**Where the code lives:** `POST /account/email/start {email}` generates a six-digit code with
rejection sampling (no modulo bias, leading zeros preserved), stores **only**
`SHA-256("<folded email>:<code>")` with a 10-minute expiry, and mails it. `POST
/account/email/verify {email, code}` compares in constant time, allows **five** wrong tries
before the challenge is burned, and is single-use. Burning a challenge deliberately does **not**
delete the record - the hash is wiped and the expiry zeroed, but the "when was one last sent"
and "how many today" counters survive, so the 60-second resend cooldown and the 12-per-day cap
cannot be reset by burning a challenge. `email-codes.json` is in `.gitignore`; the KV twin is
`["emailcode", folded]` with a native 24-hour expiry.

**How it leaves the building.** Production is Deno Deploy: an isolate with outbound HTTPS and no
SMTP. So sending has to be an HTTPS API call.

**Blake's Google Workspace service account (`info@pocketcache.app`) cannot be used.** It is
driven by `gogcli`, a local command-line tool on the Mac Mini. The cloud server cannot shell out
to it, and putting Workspace credentials into a public repo's production server - credentials
that also reach Drive, Calendar and Gmail for a real business - would be a bad trade for a
board game's sign-in codes. It is not an option and is not offered as one.

Implemented senders, chosen by `NASTY_EMAIL_PROVIDER`:

| Value | Endpoint | Auth |
|---|---|---|
| `resend` **(recommended)** | `POST https://api.resend.com/emails` | `Authorization: Bearer <api key>` |
| `postmark` | `POST https://api.postmarkapp.com/email` | `X-Postmark-Server-Token: <token>` |
| `console` | nothing - prints the code to the server log | dev only |
| unset | the email method is simply not offered | - |

**Recommendation: Resend.** Free tier is 3,000 emails a month / 100 a day, which is orders of
magnitude more than this family will ever use; it is one POST with a Bearer token; and domain
verification is three DNS records. Postmark is the alternative if deliverability ever becomes a
problem (it is the strongest of the transactional providers on that axis) but it is paid from
the start. **What Blake must provide: an API key and a verified sender domain.** Exact steps in
`blake-signin-setup.md` section 4.

`NASTY_EMAIL_API_URL` overrides the endpoint, which is how the test suite points it at a local
stub and reads the code back without sending anything.

### 4.4 Sessions - unchanged from revision 1

Opaque 32-byte hex, minted by the server, 400-day sliding expiry (any authenticated request on a
session older than 30 days silently extends it), sent in the **JSON body as `auth`**, never as a
header - `CORS_HEADERS` allows exactly `content-type, x-admin-token` and a body field needs no
CORS change. `/account/me` and `/account/name-available` are POSTs specifically so a token never
lands in a URL, a log, or a Referer header.

---

## 5. One account, on the phone and on the website

Blake asked for this confirmed. Here it is, per provider, with what makes it true and what would
break it.

### 5.1 Apple - the one that needs configuration to be true

Apple issues a `sub` that is stable **per user, per app, per developer team**. The native iOS
flow authenticates against the **App ID** (`com.pangman.nasty`). The web flow cannot use an App
ID at all - it needs a **Services ID** (e.g. `com.pangman.nasty.web`), and using the App ID as a
web `client_id` produces `invalid_client`.

**They produce the same `sub` only when the Services ID is configured with
`com.pangman.nasty` as its Primary App ID.** If Blake creates a standalone Services ID that is
not grouped under that App ID, the same human signing in on the phone and on the website gets
two different `sub` values, two accounts and two leaderboard rows - and nothing in the server can
detect or fix that. This is the single highest-consequence step in the whole setup checklist and
it is called out there in bold.

The server accepts **both** audiences from **either** claimed platform, deliberately: the
client's `platform` field is unverified hearsay, so coupling `aud` to it would be security
theatre that also breaks legitimate flows.

Test evidence: `test_accounts_linking.js` T1/T2/T3/T3b/T3d - sign in with `aud` = App ID, then
with `aud` = Services ID, same `sub`, and assert the same `uid`, the same `gameName`, and that
the second session resolves to the same account. Two different session tokens, which is correct
(signing out on the phone must not sign you out on the laptop).

### 5.2 Google - true by construction

Google's `sub` identifies the **Google Account**, not the client. The iOS OAuth client ID and
the web OAuth client ID both produce the same `sub` for the same person, provided both client
IDs live in the same Google Cloud project (which is how you would create them anyway). Both go
in `NASTY_GOOGLE_AUDIENCES`.

Test evidence: T4, plus P2 which additionally proves Google's two issuer spellings resolve
identically.

### 5.3 Facebook - true within one Facebook app

Facebook user ids are **app-scoped**: one Facebook app gives one id per person, on iOS and on
the web. So one app = one account. (This breaks only if Blake ever creates a *second* Facebook
app for the website; the setup checklist says not to.)

Test evidence: T5 - a Limited Login id_token (the iOS shape) and an inspected access token (the
web shape) for the same person resolve to the same `uid`. Also Q2c.

### 5.4 The email method

The verified address is the identity, so it is trivially the same everywhere.

### 5.5 And the guarantee that ties it together

`/account/me` on any of those sessions returns the same `uid`, the same `gameName`, and the
account's leaderboard row is keyed on `uid` - so the phone and the website are literally reading
one row. Test T3d.

---

## 6. Linking, and its honest limits

### 6.1 The rule, in order, on every sign-in

1. **If this provider identity is already known, that is the account.** Nothing else is
   consulted. A known identity always wins.
2. **Otherwise, if the provider gave us a VERIFIED, non-relay email we already hold for an
   existing account, the new identity is attached to that account.** Same account, same game
   name, same leaderboard row. The response carries `linkedToExisting: true` so the client can
   say so out loud rather than letting it be spooky.
3. **Otherwise it is a new person, and a new account.**

Unverified addresses are never used as a key - otherwise anyone could take over an account by
typing someone else's address into a provider that does not verify it (test U4).

### 6.2 Apple private relay - the limit that cannot be engineered away

If someone uses **Hide My Email** with Apple, the address is a `@privaterelay.appleid.com` alias
that is real and stable **per app** - so it works perfectly as a key for Apple-to-Apple across
the phone and the website. It will **never** equal that same person's real Gmail, so it cannot
link an Apple sign-in to a Google sign-in.

So: relay addresses **are stored** (they are stable and useful), they are **flagged**
(`emailPrivateRelay: true`), and they are **excluded from cross-provider matching**. Matching on
one would be a coin flip dressed up as a link.

**The consequence, plainly: someone who uses Hide My Email with Apple and then signs in with
Google gets two accounts, and no server-side cleverness fixes that.** Test V2 asserts exactly
that, on purpose, so nobody later "fixes" it into a guess.

**The mitigation** is the one flow that always works, for every combination: an explicit
**"link another sign-in method"** action in the account screen. `POST /account/link {auth,
provider, ...credentials}` verifies the second provider's token exactly the same way and attaches
it to the account you are **already signed in to** - no email matching involved. Afterwards,
signing in with that second method lands on the same account, name and all (test V3/V3b). A
sign-in that already belongs to somebody else is refused with a plain sentence, never stolen
(V4).

`POST /account/unlink {auth, provider}` removes one, and **refuses to remove the last one** - an
account with no way in is not a smaller account, it is a lost one, and the family's leaderboard
history is attached to it (W1).

### 6.3 What the client must show

The account screen needs, at minimum: which methods this account answers to
(`identities: ["apple","google"]` comes back on every account response), an
"Add another way to sign in" button per unconfigured method, and - when `linkedToExisting` comes
back true - a one-line "Signed you in to your existing NASTY account" note. Without that note,
linking looks like magic, and magic in an accounts system reads as a bug.

---

## 7. The claim, and its sunset

### 7.1 The flow, while the window is open

Unchanged from revision 1: after picking a game name, if there is existing unclaimed history
under that folded name, the server **reports** it and moves nothing:

`POST /account/name` -> `200 {gameName, pendingClaim:{games,wins,points,koDealt,koTaken}, claimWindow}`

The client shows *"There are already 47 games and 19 wins on the board under the name Blake. Is
that you?"* with **Yes, that's me** / **No, start fresh**. Yes runs `POST /account/claim`; No
runs `POST /account/claim {decline:true}`. An automatic merge on a name match would silently
hand one relative another relative's record; the confirm costs one tap and makes the decision
explicit and attributable.

### 7.2 The merge - journalled, idempotent, individually reversible

Unchanged and still the only destructive operation anywhere in this design:

1. Snapshot every unclaimed leaderboard row whose folded name matches.
2. **Write the journal first and flush it**, carrying both the source snapshot AND the account
   row's pre-claim values. That is what makes step 3 a **pure function of the journal**, so a
   crash anywhere can re-run it any number of times without double-counting.
3. account row := `pre + sum(snapshot)`.
4. Delete the source rows.
5. Mark the journal `done`.

A journal already `done` short-circuits at the top. Deno uses `kv.atomic().check()` on the
journal key so two concurrent claims cannot both take a snapshot, and writes the account row
with `set`, never `sum` (`Deno.KvU64` is unsigned; a rollback that lowers a counter would throw
on a sum). `POST /admin/claim/undo {uid}` restores the source rows from the journal - verbatim
into a vacant name, **added** into one that has been written to since, so a rollback never
destroys newer data - and resets the account row. Journals are never deleted.

### 7.3 The sunset

Two independent shut-offs, either of which closes the window, both settable **without a
redeploy** (a Deno Deploy environment-variable change):

```
NASTY_CLAIM_WINDOW_OPEN=0        close it right now
NASTY_CLAIM_DEADLINE=<ISO date>  close it automatically at a moment in time
```

Default: open, with no deadline - because the window has not started. **Blake sets
`NASTY_CLAIM_DEADLINE` when the accounts update ships**, to something like six to eight weeks
out, which is generous for a family that plays in bursts.

Once closed:

- `POST /account/claim` -> **410** `{error:"claimclosed", message:"The one-time window for
  moving an older name onto an account has closed. Older names stay on the board as history -
  new games count on your account from here."}` Declining is refused too; there is nothing left
  to decline.
- `POST /account/name` returns `pendingClaim: null`, so the client never shows the question.
- Every account response carries `claimWindow: {open, closesAt}`, so the client knows without
  having to try and fail.
- **An already-completed claim stays idempotent.** A retry still answers `200 {alreadyDone:true}`
  rather than erroring, because a client retry after a flaky connection must not look like a
  failure (test Y4b). And `/admin/claim/undo` still works afterwards (Y4c).

### 7.4 What happens to still-unclaimed rows - the important part

**They are kept, visible, forever, as frozen historical entries.** They stop accruing anything
new; they are never deleted, never hidden, never merged into anything.

Concretely, once the account-only board is on, `/leaderboard` serves the union of:

- **account rows**, displayed under that account's game name; and
- **every remaining name row**, displayed exactly as it reads today.

If an account's folded game name matches a historical row, the account row **shadows** it, and
the historical numbers are **folded into the displayed total** rather than dropped - so somebody
who claimed their old name shows one row of 48, not two rows or a reset (tests Z7, Z8). If they
explicitly *declined* the history, it is not folded in and the old row stays where it is.

`/leaderboard/v2` (additive, new) reports the same rows with `{account: bool, frozen: bool}` so
a client can label the frozen ones as history. `/leaderboard` itself keeps the identical flat
`{name:{stats}}` body, so no already-shipped build breaks.

I looked for a reason to do something else with unclaimed rows - archive them, roll them into an
"Old board" tab, expire them. There is no good one. They are a few hundred bytes, they are the
family's actual record going back to a wooden board from 1993, and losing them would be
unacceptable. Freezing costs nothing.

---

## 8. The account-only leaderboard

### 8.1 How it is gated

`accountsOnlyBoard()` is true only when **all three** hold:

1. `NASTY_ACCOUNTS_ENABLED` is on (the kill switch, default on),
2. at least one provider is configured (production: none), and
3. `NASTY_LEADERBOARD_ACCOUNTS_ONLY=1` (**default OFF**).

With it off, `boardRowsForDisplay()` returns the existing board object itself, so
`/leaderboard` serializes byte-for-byte what it always has. That is what lets this ship today
and switch on later.

### 8.2 What it does when on

- **`POST /solo-result`** (offline, solo and pass-and-play): resolves the `auth` session and
  credits **only the signed-in account's own game name** to the account row. Every other entry
  is a guest result: not posted. The response is still a plain `200 {ok:true}` so the client's
  offline queue always reaches a final answer and never retries forever, and the device's own
  local `nasty-stats` still counted the game either way.
  - **A signed-in session can only ever credit its own name**, never anyone else's, even in the
    same submission (test Z5b). That closes the "sign in once, then post everyone's results"
    hole that would otherwise replace the name-typing one.
  - **Pass-and-play consequence, accepted and documented:** two signed-in family members on one
    phone in one pass-and-play game means only the one whose session was sent gets credited. The
    alternative (crediting by name lookup) reintroduces exactly the squatting problem accounts
    exist to fix. If this becomes a real annoyance, the right fix is a client-side
    "who is playing this seat" account picker, not a server-side name guess.
- **Online games** (`finishGame` / `recordFinishedGame`): attribution comes from the room's own
  stored `player.accountId`, captured **once at the front door** and read back at game end -
  never from the typed seat name, never from anything the client sends at game end. A guest's
  online game finishes normally and simply does not post.
- **`/leaderboard`** serves the union described in 7.4.

### 8.3 The `acct` field - the only wire change in the whole batch

`host` and `join` may carry an **optional** `acct` session token. The server resolves it (or
ignores it entirely if absent or invalid) and stores `player.accountId`, which is persisted in
`roomToDisk()` / `RoomMeta` alongside the existing id/token/name fields so a server restart
mid-game cannot turn a signed-in player back into a guest.

Deliberate properties:

- **`rejoin` is not touched at all.** It never re-asserts identity, so an expired session
  mid-game cannot cost anyone their stats.
- **An invalid `acct` is silently ignored, not an error.** A sign-in problem must never stop
  somebody joining a family game (test AC1).
- **When `acct` is absent, no storage is touched and the code path is byte-identical** - which is
  every client that has ever shipped.

`reclaim` was deliberately **not** changed to prefer `accountId` over the existing lowercased
name match. It is a strictly-better change on paper, but `reclaim`/`rejoin` are the most
repeatedly hard-won code paths in this project, and there was no need to touch them in a batch
that is meant to be provably inert. Left as a future item.

---

## 9. PROTOCOL_VERSION: no bump. Reasoning.

The bar, quoted from `index.html`: *"An old client can never get stuck waiting on a reply it
doesn't know how to interpret, which is the actual bar for a bump."*

| Change | Old client -> new server | New client -> old server | Bump? |
|---|---|---|---|
| New HTTP endpoints (`/account/*`, `/leaderboard/v2`, 2 admin routes) | never called | `404`; client treats any non-200 as "accounts unavailable, stay a guest" | no |
| Optional `acct` on `host`/`join` | never sent -> guest, identical to today | old server ignores unknown fields (as it did `diff`, `teams`, `speed`) -> name attribution, degrades gracefully | no |
| Optional `auth` in `/solo-result` | never sent -> name path | old server ignores it | no |
| `accountId` on the room player record | server-internal, never on the wire | n/a | no |
| `/leaderboard` body shape | **unchanged**, before and after the account-only switch | unchanged | no |

Same additive shape as `hkoDealt`/`hkoTaken` and `hptsS`/`hptsT`, both of which the version
comment block explicitly declined to bump for. **PROTOCOL_VERSION stays at 5.**

The one change that WOULD require a bump is making `acct` **required** on `host` or `join`.
Never do that; it is written into both servers' comments so a future session does not "tidy it
up" into a requirement.

---

## 10. What is dormant, and how that is proven

With no provider configured - which is production today - every `/account/*` route answers
`503 {"error":"accounts unavailable","message":"Signing in isn't set up yet. You can keep playing
without an account."}` and touches no storage. Each provider is gated **independently**, so
Apple can go live months before Facebook does.

`NASTY_ACCOUNTS_ENABLED=0` removes the whole layer: `/account/*` and `/leaderboard/v2` fall
through to the same plain 404 they hit today, both new admin routes disappear, the `acct` field
is ignored, and nothing is written. That is the revert - an environment-variable change, no
redeploy, no data restore.

`test_accounts_dormant.js` proves it four ways, on both servers:

- **G** - kill switch, with **all four providers configured**: every new route is the same plain
  404, no storage file is created, no email is sent.
- **H** - two servers booted side by side, one with accounts off and one with **all four
  providers fully on**, and the same 23-request script run against both. Every response body and
  every header that matters compared **byte for byte**: `/health`, `/leaderboard`, the epoch
  header, the CORS preflight, the AASA file, the `/join` redirect page, the 404 page, every
  `/solo-result` answer including its error cases (and one carrying the new `auth` field), and
  every `/admin/leaderboard` route including reset.
- **I** - `protocol_checklist.js` (54 checks) run against accounts-off and accounts-fully-on, and
  required to report **identical** numbers.
- **J** - with an account signed in and a name claimed, an ordinary guest still lands on the
  board exactly as today, because the account-only switch defaults off.

---

## 11. Privacy and App Store compliance

This is the highest-rejection-risk area, and reversal 1 makes it more so than revision 1
predicted.

### 11.1 `privacy.html` - required changes

`privacy.html:37` currently says the app *"doesn't have accounts, ads, analytics, or trackers"*,
and `support.html:36` says *"no account to manage"*. **Both sentences become false.** Required:

1. **Opening correction:** "NASTY has no ads, no analytics, and no trackers. Signing in is
   optional - the whole game works without an account."
2. **A "Signing in (optional)" section**, listing all four methods, and stating exactly:
   - what we receive from each: a stable identifier, and - **this is the new part** - your email
     address where the sign-in method provides one, or the address you type if you use the email
     code;
   - **that there is no password, anywhere, ever**;
   - what we store linked to it: your chosen game name and your games/wins/points/knockout
     counts;
   - where: on the developer's own server; not sold, not shared, no third parties, no analytics;
   - how long: until you delete your account.
3. **A "Signing in with more than one method" section** - short, plain: if two of your sign-ins
   share a verified email we treat them as one account; you can also link them yourself; if you
   used Apple's Hide My Email we may not be able to match them automatically.
4. **A "Deleting your account" section**: where the button is, what is deleted (every linked
   sign-in, the email address, the sessions), what remains by default (the game name and counters
   on the shared family board) and how to remove that too, plus the
   Settings > Apple ID > Sign in with Apple note.
5. **A "Children" section**, written honestly - see 11.4.
6. **A "Leaderboard" section** stating plainly that from this version, only signed-in players
   appear on the shared board, and that guests' games still count on their own device. This is a
   user-visible behavior change and it belongs in the policy, not just the release notes.
7. Bump "Last updated".

`support.html` needs its opener replaced plus three FAQ entries: "Do I have to sign in?", "How do
I get on the leaderboard?", and "How do I delete my account?" (reviewers do look for the deletion
path being discoverable).

### 11.2 App Store Connect - data collection disclosures

| Data type | Collected | Linked to user | Tracking | Purpose |
|---|---|---|---|---|
| Identifiers > **User ID** | Yes | **Yes** | No | App Functionality |
| **Contact Info > Email Address** | **Yes** | **Yes** | No | App Functionality |
| Usage Data > Product Interaction | Yes | Yes | No | App Functionality |

The **Email Address** row is new, and is the direct cost of reversal 1. Under-disclosing it is a
rejection; over-disclosing costs nothing.

- **User ID** covers the account identifier and the player-chosen game name (Apple treats a
  screen name as a User ID).
- **Tracking: No** on everything. There is no ad network and no cross-app anything.
- **"Sign in required?" must be answered No.** It genuinely is not - and with the account-only
  leaderboard, expect this to be looked at more closely, so the review notes below matter more.

### 11.3 Review guidelines that apply

- **5.1.1(v)** - *"If your app doesn't include significant account-based features, let people use
  it without a login... If your app supports account creation, you must also offer account
  deletion within the app."* Guest-first satisfies the first half; `POST /account/delete`
  satisfies the second, and it works from day one even without Apple's revocation key (Apple's
  own guidance explicitly allows completing a deletion without it, directing the user to revoke
  access manually - and the response says exactly that).
  **Write review notes**: *"The game is fully playable without signing in - local, pass-and-play
  and online. Signing in only affects the shared leaderboard. Account deletion is at
  Leaderboard -> your name -> Delete account."*
- **4.8** - bites the moment Google or Facebook is offered. Sign in with Apple must be present,
  **listed first, and no less prominent**. It is first everywhere in this design by construction.
- **5.1.4** - children's privacy statutes apply; see 11.4.
- **1.3 Kids Category** - not applicable and must stay that way. Do not opt in.

### 11.4 COPPA, and the part that got harder

A **persistent identifier** is personal information under COPPA. An account is a persistent
identifier, and now an email address goes with it. So if a 9-year-old signs in, we are collecting
personal information from a child, and verifiable parental consent would be required - which is
not realistically obtainable for a one-person family app.

**Recommendation, unchanged and now more important: a neutral age gate in front of sign-in.**
Before any provider sheet appears, a neutral birth-year screen. Neutral means it does not say
"you must be 13", does not pre-fill, and does not let you go back and try again (store the
answer). Under 13 -> a friendly card: *"You don't need an account to play - everything works
without one."* No account is created and nothing is sent to the server. The birth year is stored
**on the device only** and never transmitted, so the gate itself collects nothing.

**What is different now, and Blake needs to hear it plainly:** under the old design, kids who
stayed guests still appeared on the family board. Under the account-only board, **they do not**.
The honest options are (a) accept that the under-13s are not on the shared board, or (b) a parent
signs in on the child's behalf on their own account, which is a fudge and puts the child's games
on the parent's row. There is no third option that is both COPPA-clean and puts a 9-year-old's
own name on a shared internet leaderboard. **Recommend (a)**, with the local per-device stats
screen (which is untouched and still shows their own record) as the thing you point the kids at.

Also note: Apple child accounts *can* use Sign in with Apple, so "Apple will stop them" is false.
The age gate is the only thing that does.

**Facebook adds two more obligations** that Apple and Google do not: a public privacy-policy URL
on the Facebook app (there is one), and a **Data Deletion Callback or instructions URL** -
Facebook requires a way for a user to request deletion of data obtained via Facebook Login. The
cheapest compliant answer is the "Data Deletion Instructions URL" option pointing at a section of
`privacy.html` that explains the in-app delete button. That must exist before Facebook Login
passes review.

---

## 12. Storage

**Node (`server/`)** - six JSON files became seven, all env-overridable so tests point them at
scratch paths, all debounce-persisted like the leaderboard, all in `.gitignore`:

| Thing | File | Env override |
|---|---|---|
| Accounts | `accounts.json` | `NASTY_ACCOUNTS_FILE` |
| Identity + email + name index | `account-index.json` | `NASTY_ACCOUNT_INDEX_FILE` |
| Sessions | `sessions.json` | `NASTY_SESSIONS_FILE` |
| Sign-in nonces | `auth-nonces.json` | `NASTY_AUTH_NONCES_FILE` |
| Account leaderboard | `accounts-leaderboard.json` | `NASTY_ACCOUNTS_LEADERBOARD_FILE` |
| Claim journal | `claims.json` | `NASTY_ACCOUNT_CLAIMS_FILE` |
| **Email code challenges** | **`email-codes.json`** | **`NASTY_EMAIL_CODES_FILE`** |

Index keys inside `account-index.json` / the `["acctidx", ...]` KV prefix:

```
apple:<sub>        google:<sub>        facebook:<app-scoped id>       email:<address>
mail:<address>     the verified-email LINKING index - deliberately a different word from the
                   provider named "email", so two indexes never share one key space
name:<folded>      game-name uniqueness, unchanged
```

**Deno KV**: `["account",uid]`, `["acctidx",provider,sub]`, `["session",token]` (native
`expireIn`), `["authnonce",nonce]` (native `expireIn`), `["lbacct",uid,statKey]` (`Deno.KvU64`),
`["claimjournal",uid]`, `["emailcode",folded]` (native `expireIn`).

**Secrets** follow `server/apns.js`'s precedent exactly - environment variable first, then a file
on disk next to the dev server, and the whole feature no-ops gracefully when neither exists.
`.gitignore` covers `server/apple-key.p8`, `server/apple-key-id.txt`,
`server/facebook-app-secret.txt`, `server/email-api-key.txt`. **The repo is public; no key may
ever be committed.**

A "new season" reset (`POST /admin/leaderboard/reset`) wipes both the name rows and the account
rows and bumps the epoch, but deliberately leaves accounts, sessions and the name index alone -
after a reset you are still signed in and still own your name.

---

## 13. Test plan, as built

Every suite launches its own private server on a random port with scratch storage and a throwaway
admin token, and never touches production. **Nothing contacts Apple, Google, Facebook or a mail
provider**: `test_accounts_kit.js` generates its own RSA keys, serves its own JWKS on a local
port, stands up a stub Facebook Graph API (`/debug_token` + `/me`, with registerable tokens so
"valid", "issued for a different app", "expired" and "unknown" are all reproducible), and a stub
transactional-email API that captures the code and can simulate an outage.

| Suite | Covers | node | deno |
|---|---|---|---|
| `test_accounts_apple.js` | Apple verifier, every negative case, sessions, sliding expiry, the email storage rules | 54 | 54 |
| `test_accounts_names.js` | game names, uniqueness, rename cooldown, the claim merge, crash recovery, admin undo, deletion | 60 | 60 |
| `test_accounts_dormant.js` | the dormancy proof (kill switch, byte-identical HTTP, protocol checklist, guest path) | 16 | 16 |
| `test_accounts_providers.js` | Google, Facebook (both shapes), the email code, per-provider gating | 45 | 45 |
| `test_accounts_linking.js` | app-vs-web one account per provider, email linking, private relay, link/unlink, deletion cleanup | 31 | 31 |
| `test_accounts_policy.js` | the claim sunset, frozen historical rows, the account-only board | 39 | 39 |
| `test_accounts_online.js` | real online games: the `acct` field, account attribution, guests not posting | 10 | 10 |
| | **total** | **255** | **255** |

Regressions re-run and green: `protocol_checklist.js` (54, both servers, inside the dormancy
proof), `test_leaderboard_scenarios.js` (13), `test_leaderboard_names_and_deltas.js` (35),
`test_knockout_leaderboard.js` (14), `test_reconnect_retry.js` (8), `restart_deno.js` (4),
`reconnect_storm.js 18` (18/18 cycles clean).

---

## 14. Things that are still bad ideas

1. **Making `acct` required on any websocket message, or letting the account layer near
   `rejoin`.** This would put the most fragile, most-iterated code path in the project behind a
   brand-new auth dependency.
2. **A password, ever.** Blake said it, and it is right. Running password storage, reset flows
   and breach exposure for a family board game is a liability with no upside. The email code is
   strictly better in every dimension.
3. **Using an unverified email as a linking key.** That is account takeover by typing.
4. **Matching Apple private-relay addresses across providers.** A guess wearing a link's clothes.
5. **Crediting an online or solo result by looking up which account owns that typed name.** It
   would be convenient and it would reintroduce exactly the squatting problem accounts exist to
   fix.
6. **Syncing `nasty-stats` (the local device board) across devices.** It is a device cache by
   design, and the last attempt at cleverness there caused a real double-count bug.
7. **A JWT/JWKS npm or JSR dependency.** WebCrypto does this in both runtimes.
8. **Putting the app in the App Store Kids Category.** Different from a 4+ age rating; opting in
   triggers guideline 1.3 and would make an account feature far harder to justify.
9. **Deleting unclaimed leaderboard rows after the sunset.** Non-negotiable.
10. **A second Facebook app for the website.** It would give the same person two different
    app-scoped ids and break the one-account guarantee.

---

## 15. What could go wrong

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Services ID **not** grouped under the App ID -> phone and website are two accounts | **med** | **high** | called out in bold in the setup checklist; test T3 proves the code half; verify with one real sign-in on each before announcing |
| Facebook app review rejected or slow | high | med | independently gated - ship Apple + Google + email and add Facebook later with an env-var change |
| Facebook business verification demands documents Blake does not want to provide | med | med | same: Facebook is optional and separable |
| Email domain not verified -> codes land in spam | med | med | Resend's DNS records must be in place before switching the method on; test with the real family addresses first |
| Mail provider outage during a sign-in | low | low | answers "we couldn't send that code right now, try Apple/Google/Facebook", stores nothing |
| A relative uses Hide My Email then Google -> two accounts | med | low | documented; "link another sign-in method" fixes it in two taps |
| Kids drop off the leaderboard and Blake is surprised | **med** | **med** | it is section 0, section 1.3 and section 11.4 of this document; make sure he has actually read it before the switch is flipped |
| Someone misses the claim window and their old row is stranded | med | low | the row stays visible as history forever; `/admin/claim/undo` plus an admin re-attribution can still fix a genuine mistake by hand |
| Provider JWKS unreachable on a cold start | med | med | six-hour in-memory cache per URL; on fetch failure return 503 "accounts unavailable", never a partial verify; client falls back to guest |
| Provider rotates a signing key | low | med | one forced refetch on a `kid` miss, then fail closed |
| Deno KV eventual consistency during the claim merge | low | high | `kv.atomic().check()` on the journal key; the merge is a pure function of the journal so a retry is safe |
| `Deno.KvU64` underflow on rollback | low | med | rollback uses `set`, clamped at 0, never `sum` with a negative |
| App Store rejection: privacy label mismatch (email) | **med** | **high** | section 11.2 - the Email Address row is not optional now |
| App Store rejection: cannot find account deletion | med | high | review notes + a discoverable button + support.html FAQ |
| App Store rejection: 4.8, Apple not prominent enough | low | high | Apple first everywhere, same size, same position |
| Blake changes Apple developer team someday | very low | catastrophic | Apple `sub` is per-team; every Apple identity would orphan. Google/Facebook/email identities would survive and could re-link. Do not change teams. |

---

## 16. Status - what is built, what is not

**Built, tested, committed:**

- Both servers: all four providers verified server-side, the linking model, `/account/link` and
  `/account/unlink`, the email code flow with a real HTTPS sender, the claim sunset, the
  account-only leaderboard switch, `/leaderboard/v2`, the optional `acct` field on `host`/`join`
  with `accountId` persisted, admin listing and claim undo.
- Seven test suites, 255 checks each on Node and on Deno, plus the regression set.
- Byte-for-byte parity between `server/server.js` and `server/cloud/server.ts`.

**Not built, deliberately:**

- **Any client UI.** `index.html` is untouched. No sign-in button, no name step, no claim
  prompt, no account screen. That is the next stage.
- The iOS native sign-in plugins (a small local Swift plugin for Apple is still the
  recommendation over a third-party pod; Google and Facebook will each need one).
- The web sign-in flows, `apple-callback.html`, and the domain-verification file.
- `privacy.html` / `support.html` rewrites and the App Store Connect privacy label update.
- The neutral age gate.
- `reclaim` preferring `accountId` (deliberately deferred, section 8.3).

**Not deployed.** A cloud deploy of `server/cloud/server.ts` is required and has not been run.

**Blocking on Blake:** everything in `blake-signin-setup.md`. Nothing here can be switched on
until at least one provider's credentials exist.
