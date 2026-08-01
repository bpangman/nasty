# Nasty - How to get it live on the App Store

Written 2026-07-31. Everything that could be prepared has been. What is left is listed below.
Steps 1 to 3 are yours and cannot be done for you. Step 5 is mine.

Current state: iOS build 80, approved and in TestFlight. Listing copy, 10 screenshots,
reviewer notes, technical declarations and all 4 credit packs are staged and ready.

---

## STEP 1 - Confirm banking is Active (do this first)

Nothing about real money works until this says Active. It is the only true blocker.

1. Go to appstoreconnect.apple.com and sign in.
2. Click **Business** in the top nav (older accounts show it as "Agreements, Tax, and Banking").
3. Find the **Paid Apps** agreement row.
4. You need a green **Active** next to BOTH **Banking** and **Tax**, not just the agreement itself.

If either still says Pending, you are waiting on Apple, not on anything technical. Banking can
take a few days if they verify with your bank. Nothing else in this document matters until
this is done, so check it before spending time on the rest.

---

## STEP 2 - Test one real purchase (do this before submitting, not after)

The purchase chain has been tested against a stand-in for Apple, never against Apple itself.
Find that out now, on a fake $5, not after launch on a real one.

1. Once Step 1 says Active, wait a few hours. Products do not appear instantly.
2. Open TestFlight on your iPhone, install build 80.
3. Go to Shop. The credit packs should now show real prices ($4.99 / $9.99 / $24.99 / $49.99).
   If they say "not available", the agreement has not propagated yet. Wait, do not debug.
4. Buy the $4.99 pack. In TestFlight this is a sandbox purchase - no real money leaves you.
5. Confirm 50 credits land in your balance.
6. Tell me what happened. I will check the server logs.

If this does not work, do not submit. Tell me and I will fix it.

---

## STEP 3 - Redo the App Privacy questionnaire

**IMPORTANT ORDERING CHANGE (2026-07-31):** do this step AFTER the free-month anti-abuse
work ships, not before. That change makes the app keep a scrambled record about someone even
after they delete their account, which is exactly the kind of thing this questionnaire and the
privacy policy have to disclose. If you already answered it, revisit it once that build lands.


You answered this in July, before accounts, Sign in with Apple, the leaderboard and real money
existed. Apple takes this section seriously. Click by click:

1. appstoreconnect.apple.com > **My Apps** > **NASTY**.
2. **App Privacy** in the left sidebar.
3. Check the **Privacy Policy URL** at the top reads `https://nastyboardgame.com/privacy.html`.
   That page is live and already describes everything below, including the scrambled
   post-deletion record. If the box is empty, paste that URL in.
4. Next to **Data Collection**, click **Edit**. Answer **Yes** to "Do you or your third-party
   partners collect data from this app?"
5. Apple shows a long checklist of data types. Tick exactly these five, leave everything else
   unticked:

   | Tick this | Why it applies to NASTY |
   |---|---|
   | Identifiers > **User ID** | Apple's anonymous ID that recognises a returning player |
   | Identifiers > **Device ID** | the push notification token |
   | Purchases > **Purchase History** | credit pack purchases |
   | Usage Data > **Product Interaction** | wins, points and knockouts for the leaderboard |
   | User Content > **Other User Content** | the nickname a player types in |

6. Apple then asks the same three questions about each one. The answers are identical for all
   five:
   - Used for **App Functionality** (not analytics, not advertising, not personalization)
   - **Linked** to the user's identity: **Yes**
   - Used for **tracking**: **NO**, for every single one. Apple defines tracking as sharing data
     with other companies for advertising. NASTY has no ad networks, no analytics SDK and no
     data brokers. Nothing is shared with anyone.

7. Say **NO** to everything else, in particular:
   - **Email Address** - the app deliberately asks Apple for no personal details at sign-in,
     so none is ever received or stored.
   - **Payment Info** - Apple processes the money; the app never sees a card number.
   - Location, Contacts, Health, Photos, Browsing History, Search History, Diagnostics,
     Sensitive Info - none are touched.

8. Click **Publish**.

**If you are unsure about any item, tick it.** Over-declaring is harmless. Under-declaring is
what gets apps pulled.

9. While you are in there, give **Pricing and Availability** a 30 second glance - confirm the
   price is Free and the territories look right. Not expected to be a problem.

---

## STEP 4 - Submit for review

1. App Store Connect > your app > the **1.0.0** version page.
2. Scroll to **In-App Purchases** and make sure all four credit packs are ticked into this
   submission. They ride along with the app version - if you skip this, the app goes live
   without anything to buy.
3. Click **Add for Review**, then **Submit to App Review**.
4. Review usually takes 24 to 48 hours. Apple emails you either way.

If they reject it, send me exactly what they wrote. Rejections are normal and usually a small
fix, not a rebuild.

---

## STEP 5 - The moment it is approved (my step)

Tell me it is approved. I do three things, in this order:

1. **Back up every account and the leaderboard**, so the wipe below is recoverable if anything
   goes wrong.
2. **Run the launch wipe** (Blake, 2026-07-31: "when the app officially launches on the app
   store, I want everyone to start from square 1 - meaning even having to make new accounts").
   This deletes every account, wallet, owned item and leaderboard row, and ALSO clears the
   free-month records so everyone who signs up after launch gets their full free month. It is
   ONE-SHOT and guarded so it can never run twice or fire accidentally once real players exist.

   **Built and shipped in v0.68 - steps 1 and 2 are now ONE command:**

   ```
   cd /Users/jarvis/nasty-game/server && ./launch-reset.sh
   ```

   It downloads the full backup to a local file first (and refuses to continue without it),
   asks for the phrase `WIPE EVERYTHING FOR LAUNCH` typed by hand, runs the wipe, and then
   verifies the leaderboard and account list really are empty. The server keeps its own copy
   of the backup too, and refuses a second run forever. The Apple purchase ledger is
   deliberately NOT wiped - that is what stops an old receipt being replayed against a new
   account for free credits. `./launch-reset.sh --status` is a safe read-only check any time.
3. **Flip the website live**: `NASTY_APPSTORE_LIVE` in index.html goes `false` to `true`,
   nastyboardgame.com changes from "coming soon" to "now live on the App Store". The QR already
   points at apps.apple.com/app/id6790999186 and is verified to scan.

Takes about a minute. Do not flip before approval or the QR leads to a dead page.

**Why the wipe has to happen at launch and not later:** right now nobody has spent real money
(TestFlight purchases are sandbox and free), so wiping destroys nothing of value. Once real
customers exist, wiping accounts would destroy credits people actually paid for. This is the
last safe moment.

**You will have to make a new account too**, and so will everyone in the family. That is the
point of it.

---

## After launch - worth watching

- **TestFlight testers get free credits.** While sandbox buying is on, a tester's purchase
  costs them nothing but credits their real account. Decide whether to turn that off
  (`NASTY_IAP_ALLOW_SANDBOX=0`) or just accept it for family.
- **Refunds** claw back credits but do not repossess items already bought with them, and the
  balance floors at zero rather than going negative. Known and accepted.
- **The refund notification URL** must be set or a refunded pack quietly keeps its credits.
  App Store Connect > App Information > App Store Server Notifications, both Production and
  Sandbox pointing at https://play.nastyboardgame.com/appstore/notifications
