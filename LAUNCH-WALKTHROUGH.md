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

You answered this in July, before accounts, Sign in with Apple, the leaderboard and real money
existed. It is almost certainly out of date now, and Apple takes this section seriously.

1. App Store Connect > your app > **App Privacy** (left sidebar).
2. Work through it again. What the app now collects: Apple sign-in identity, your nickname,
   game results for the leaderboard, and purchase history.
3. Also give **Pricing and Availability** a 30 second glance while you are in there - confirm
   the territories look right. Not expected to be a problem.

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

Tell me it is approved. I flip one switch and push:

- `NASTY_APPSTORE_LIVE` in index.html goes from `false` to `true`.
- nastyboardgame.com changes from "coming soon" to "now live on the App Store".
- The QR code on that page already points at your real listing
  (apps.apple.com/app/id6790999186) and has been verified to scan correctly, so it starts
  working the instant Apple flips the app live.

Takes about a minute. Do not flip it before approval or the QR leads to a dead page.

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
