# NASTY — App Store submission handoff

Everything below is what's LEFT once Blake has an Apple Developer account. Everything up to
that point (the Capacitor iOS project, icons/splash, in-app fixes for running as a real app)
is already done and lives in this repo — see HANDOFF.md's "iOS app" section for how it's put
together and how to rebuild/relaunch it.

## What's already done (nothing to redo)

- Capacitor iOS project at `app/` (bundle id `com.pangman.nasty`, display name "Nasty"),
  wrapping the exact same `index.html` the website serves (never a duplicated copy — `app/www`
  is regenerated from the repo root by `npm run build:www` before every sync/build).
- App icon + launch screen generated from `icon.png` (felt-green background matching the
  game's own look).
- Verified in the iOS Simulator: menu loads, a full offline CPU game plays with animations,
  save/resume survives an app relaunch, and an online room can be hosted/joined through the
  real tunnel server from inside the app.
- `privacy.html` and `support.html` published at the repo root (live at
  `https://bpangman.github.io/nasty/privacy.html` and `.../support.html`) — ready to paste into
  the two listing fields Apple requires.

## Step 1 — Apple Developer account (Blake, ~15 min + $99/year)

Only needed once — the same account covers every app (Nasty, Balance, etc.).

1. On developer.apple.com, sign in with your regular Apple ID → **Account** → **Enroll**.
2. Choose **Individual** (not Organization — no business paperwork, faster approval).
3. Pay the $99/year fee. Apple usually approves within a day or two.

## Step 2 — Add the signing team in Xcode (once Blake has the account)

1. Open `app/ios/App/App.xcworkspace` in Xcode — the WORKSPACE, not the `.xcodeproj` (this
   project uses CocoaPods, and only the workspace includes the Pods project). On a fresh
   clone where `app/ios/App/Pods/` doesn't exist yet, run `cd app && npm install && npm run
   sync` first to restore it.
2. Select the **App** target → **Signing & Capabilities** tab.
3. Under **Team**, sign in with Blake's Apple ID (Xcode → Settings → Accounts → **+**) and pick
   his new team from the dropdown. Xcode will auto-manage the provisioning profile.
4. Bump `MARKETING_VERSION` / build number if this isn't the very first submission.

## Step 3 — Archive and upload

1. In Xcode, set the run destination to **Any iOS Device (arm64)** (not a simulator — archives
   can't be built for the simulator).
2. **Product → Archive**. This takes a few minutes.
3. When the Organizer window opens, select the new archive → **Distribute App** →
   **App Store Connect** → **Upload**. Keep the default options (automatic signing, include
   bitcode/symbols prompts can stay at their defaults).
4. Wait for Apple's processing email (usually 10-30 minutes) before the build is selectable in
   App Store Connect.

## Step 4 — App Store Connect listing

Create the app at appstoreconnect.apple.com (**My Apps → +** → **New App**), bundle ID
`com.pangman.nasty`, then fill in:

| Field | Value |
|---|---|
| **Name** | Nasty — Family Board Game |
| **Subtitle** | Cards, tees & takeouts |
| **Category** | Games → Board |
| **Price** | Free |
| **Age rating** | 4+ (uses a standard deck of playing cards, no gambling — rates clean on the questionnaire) |
| **Copyright** | © 2026 Blake Pangman |
| **Privacy Policy URL** | https://bpangman.github.io/nasty/privacy.html |
| **Support URL** | https://bpangman.github.io/nasty/support.html |

**Promotional text** (top of the listing, editable without a new review):
> The Pangman family's homemade 1993 board game, finally in your pocket. Race your tees home,
> kick your cousins back to start, and stay snug.

**Description** (paste-ready):
> Invented at the Pangman family table in 1993 and played on a homemade wooden board ever
> since, NASTY is the card-driven race game your family will fight about at Thanksgiving — in
> a good way.
>
> Race your five tees around the board and bring them all home. Every card in a standard deck
> moves you differently — Kings and Aces break you out, Queens charge twelve holes, Jacks swap
> tees with your opponents, and threes back you up (sometimes right into trouble). Land on
> somebody and they go ALL the way back. That's not mean. That's Nasty.
>
> • 4-player and 6-player boards, free-for-all or teams
> • Play solo against three levels of computer opponents — Easy, Tricky, and Nasty
> • Pass-and-play with the family on one phone, hands stay private
> • Big, satisfying animations — flying cards, hopping tees, and a full fireworks blast every
>   takeout
> • Family leaderboard with games, wins, and win percentage
> • No ads, no accounts, no in-app purchases. Just the game.
>
> Thirty years of house rules, one app. Please drive carefully.

**Keywords** (100 char limit):
> board game,family,cards,marbles,pegs,aggravation,sorry,trouble,race,party,classic,wahoo

**Screenshots**: the gallery at https://bpangman.github.io/nasty/appstore/ (setup screen,
4-player board, card path preview, the NASTY! takeout blast, the win screen, 6-player teams
board) — resize to Apple's required exact iPhone dimensions (6.9" and 6.5" display sizes are
the mandatory set as of iOS 26) before uploading; App Store Connect will reject anything off
by a pixel.

## Step 5 — Age rating questionnaire

A short yes/no form in App Store Connect (violence, gambling, mature content, etc.) — answer
"no" across the board; this is a card/board game with no gambling mechanics, so it lands at 4+.

## Step 6 — TestFlight (recommended before public launch)

1. After the first build finishes processing, add it to a TestFlight **Internal Testing**
   group and invite the family by email/Apple ID.
2. Play a full week of real games across everyone's actual phones before submitting for
   public review — this is where the family finds real bugs, not App Review.

## Step 7 — Submit for review

Back in App Store Connect, attach the processed build to the version, fill in the "notes for
review" (mention it's a free family board game, no login required — reviewers sometimes get
stuck if they expect an account), and hit **Submit for Review**. Typical turnaround is 1-3
days; a rejection just means answering a question and resubmitting, not starting over.

## Known gaps / things to revisit before or shortly after submission

- **Deep links / Universal Links** (`nasty://` or `https://bpangman.github.io/nasty/?join=CODE`
  opening the installed app directly) are NOT wired up yet — that needs the paid developer
  account (an Associated Domains entitlement + an `apple-app-site-association` file hosted on
  the website) which didn't exist while this was built. For now, the in-app "Join a game" /
  "Enter code" screen covers the same need (a guest just types the 4-letter code by hand) —
  see HANDOFF.md's "iOS app" section. Add Universal Links once the account exists, then the
  "Text an invite" link can open the app directly on a guest's phone instead of the website.
- **App icon source is low-res.** `icon.png` (the only master that exists) is 360×360, not the
  1024×1024 Apple wants for a crisp App Store icon — it was upscaled to 1024 to generate the
  icon set. It looks fine (it's a simple sign graphic) but if a true 1024 master ever gets
  made, regenerate with `cd app && npm run assets`.
- **Free vs. paid** — Blake's decision, flagged in the original planning email: ship free
  forever, or free now with the option to add a price/IAP later? (Recommendation from that
  email: keep it free — easier to add a price later than to walk one back after people already
  paid.)
- **The 5 open rule questions in RULES.md** should get a final answer from Blake before this
  becomes the "official" App Store version of the rules.
