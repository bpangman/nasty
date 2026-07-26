# NASTY sign-in - what you need to set up

Written for you, not for a developer. Every step says what the thing is called on their website,
roughly where to click, and what to copy back to me.

**Nothing here is urgent and nothing is all-or-nothing.** Each of the four sign-in methods works
on its own. You can do Apple this week and Facebook never, and everything still works - the ones
that are not set up simply do not appear as buttons. My advice on order is at the bottom.

**One rule before you start: never paste a key or a secret into a chat, a document, an email, or
anything that ends up in the Nasty code.** The Nasty code is public on GitHub. When you get to
anything that says "secret" or is a file ending in `.p8`, tell me you have it and I will tell you
where to put it.

---

## The short version

| Sign-in | Cost | Hassle | Waiting on someone else? |
|---|---|---|---|
| **Apple** | free (you already pay the $99 developer fee) | ~30 minutes | no, but changes can take a few hours to go live |
| **Google** | free | ~20 minutes | no |
| **Facebook** | free | ~1-2 hours plus paperwork | **yes** - business verification and an app review |
| **Email codes** | free up to 3,000 emails a month | ~20 minutes plus DNS | no |

---

## 1. Apple - "Sign in with Apple"

This is the important one. It has to be first in the app anyway (Apple's own rules say so if you
offer Google or Facebook), and it is the one where a wrong click causes a real problem.

Go to **developer.apple.com** -> **Account** -> **Certificates, Identifiers & Profiles**.

### 1a. Turn it on for the app itself

1. Click **Identifiers** in the left column.
2. Find and click **`com.pangman.nasty`** in the list.
3. Scroll down the list of capabilities to **Sign in with Apple** and tick its checkbox.
4. Leave the "Enable as a primary App ID" option as it is.
5. Click **Save** (top right), then **Continue**/**Confirm** if it asks.

**Send me:** nothing. Just tell me it is done.

### 1b. Create the website identifier - READ THIS ONE CAREFULLY

The app and the website need two different identifiers, and there is one setting that decides
whether they are **the same person** or **two different people**. If it is wrong, you would sign
in on your phone and on the website and the leaderboard would show two Blakes.

1. Still under **Identifiers**, click the blue **+** next to the heading.
2. Choose **Services IDs**, then **Continue**.
3. Description: `Nasty Web`. Identifier: `com.pangman.nasty.web`. Click **Continue**, then
   **Register**.
4. Now click the `com.pangman.nasty.web` entry you just made to edit it.
5. Tick **Sign in with Apple**, then click the **Configure** button next to it.
6. **THE IMPORTANT BIT: "Primary App ID" must be set to `com.pangman.nasty`.** It is a dropdown.
   If it shows anything else, change it. This is the setting that makes the phone and the website
   the same account.
7. **Domains and Subdomains:** `nastyboardgame.com`
8. **Return URLs:** `https://nastyboardgame.com/apple-callback.html`
   (exactly that, `https`, and the capitalisation matters)
9. Click **Next** / **Done**, then **Continue**, then **Save**.

**Send me:** the exact identifier you used, if it is not `com.pangman.nasty.web`.

### 1c. Prove you own the website

On that same **Configure** screen from step 1b:

1. There is a **Download** button that gives you a file called
   `apple-developer-domain-association.txt`.
2. **Send me that file** (it is not a secret - it is a public proof file that has to go on the
   website). I will put it in the right place and push it.
3. I will tell you when it is live. Then come back to that screen and click **Verify**.

### 1d. The key file - NOT needed yet

Only needed later, so Apple can be told "this person deleted their account". Everything works
without it. When you want to do it: **Keys** -> **+** -> name it `Nasty Sign in with Apple` ->
tick **Sign in with Apple** -> **Configure** -> primary App ID `com.pangman.nasty` ->
**Register** -> **Download**.

**That download is a secret and you only get it once.** Save it somewhere safe, tell me you have
it, and also send me the **Key ID** (a 10-character code shown on that page) and your **Team ID**
(top right of the developer site, 10 characters - I believe it is `YJU5U6VX8V`). Do not paste the
file contents anywhere.

---

## 2. Google - "Sign in with Google"

Go to **console.cloud.google.com**.

1. Top left, next to "Google Cloud", there is a **project picker**. Click it -> **New Project**.
   Name it `Nasty`. Create it, then make sure it is the selected project.
2. Left menu -> **APIs & Services** -> **OAuth consent screen**.
   - User Type: **External**. Create.
   - App name: `NASTY`. User support email: your email. Developer contact email: your email.
   - Save and continue through the next screens (you do not need to add any "scopes").
   - On the last screen there is a **Publish app** button. Click it. If it asks about
     verification, you can ignore that for now - we only ask for a name and an email address,
     which does not need Google's verification review.
3. Left menu -> **APIs & Services** -> **Credentials** -> **+ Create Credentials** ->
   **OAuth client ID**. You need to do this **twice**:

   **First one - the website:**
   - Application type: **Web application**
   - Name: `Nasty Web`
   - Under **Authorised JavaScript origins**, add:
     `https://nastyboardgame.com` and `https://bpangman.github.io`
   - Under **Authorised redirect URIs**, add:
     `https://nastyboardgame.com/google-callback.html`
   - Create. A box pops up with a **Client ID** and a **Client secret**.

   **Second one - the iPhone app:**
   - Application type: **iOS**
   - Name: `Nasty iOS`
   - Bundle ID: `com.pangman.nasty`
   - Create. This one gives you a **Client ID** only.

**Send me:** both **Client IDs**. They look like
`1234567890-abcdefg.apps.googleusercontent.com`. **Do not send the Client secret** - we do not
use it and it should stay in Google's console.

*Both client IDs must be in the same project (they will be if you follow the above). That is what
makes your phone and your laptop the same account on Google.*

---

## 3. Facebook - the awkward one

Be warned: this is the only one where **other people have to approve you**, and it can take days.
Everything else in NASTY works while you wait. If you would rather skip Facebook entirely, say
so - nothing breaks.

Go to **developers.facebook.com**.

1. **My Apps** -> **Create App**.
   - "What do you want your app to do?" -> pick **Authenticate and request data from users with
     Facebook Login**.
   - App name: `NASTY`. Contact email: yours.
   - Create app (it will ask for your Facebook password).
2. In the app's dashboard, find **Facebook Login** and click **Set up** -> choose **Web**.
   - Site URL: `https://nastyboardgame.com`
3. Left menu -> **Facebook Login** -> **Settings**:
   - **Valid OAuth Redirect URIs:** `https://nastyboardgame.com/facebook-callback.html`
   - Make sure **Client OAuth Login**, **Web OAuth Login** and
     **Use Strict Mode for Redirect URIs** are all ON.
   - Save changes.
4. Left menu -> **App settings** -> **Basic**:
   - **Privacy Policy URL:** `https://nastyboardgame.com/privacy.html` (required - Facebook will
     not let you go live without it)
   - **User Data Deletion:** choose **Data Deletion Instructions URL** and put
     `https://nastyboardgame.com/privacy.html#delete`. (Facebook requires a way for someone to
     ask you to delete their data. I will make sure that section exists on the page.)
   - **Category:** Games
   - Also on this page: add the iPhone app. Scroll to the bottom, **+ Add Platform** -> **iOS**
     -> Bundle ID `com.pangman.nasty`.
   - Save changes.
5. **App Review** -> **Permissions and Features**. The `email` permission needs **Advanced
   Access**. Click **Request advanced access** next to it. This is where the waiting happens:
   Facebook will ask you to complete **Business Verification** (they want to confirm you are a
   real person or business - usually ID and sometimes a business document) and to record a short
   screen video showing how the login is used in the app. **I can help write what to say, but
   only you can do the identity part.**
   - Until this is approved, Facebook Login only works for **your own** Facebook account and
     anyone you add as a Tester under **App Roles**. That is actually fine for trying it out with
     the family if you add them as testers.

**Send me:**
- the **App ID** (a long number, shown at the top of the dashboard - not a secret)
- tell me you have the **App Secret** (same page, behind a **Show** button). **Do not paste it.**
  I will tell you where to put it. NASTY needs it for the website version of Facebook login; the
  iPhone version works without it.

---

## 4. Email codes - the "just send me a number" option

This is for anyone in the family with no Apple, Google or Facebook account. They type their email
address, we email them a six-digit number, they type it back. **There is no password, ever.**

The catch: the NASTY server runs in the cloud and cannot use your normal email. It needs a
service built for sending this kind of message. I recommend **Resend** - free for 3,000 emails a
month, which is far more than this will ever use.

Go to **resend.com**.

1. **Sign up** (free). Email + password, or sign in with GitHub.
2. Left menu -> **Domains** -> **Add Domain** -> type `nastyboardgame.com` -> Add.
3. It will show you **three DNS records** to add (they will be a `TXT` record and two others).
   **Screenshot that page and send it to me** - the records are not secret. They need to be added
   wherever `nastyboardgame.com` is managed. Tell me where you bought the domain and I will walk
   you through adding them, or do it if you give me access.
4. Once the records are in, come back and click **Verify**. It usually goes green within an hour.
5. Left menu -> **API Keys** -> **Create API Key**. Name it `NASTY`. Permission: **Sending
   access**.
   - **This is a secret and it is shown once.** Copy it somewhere safe, tell me you have it, and
     I will tell you where to put it. Do not paste it into a chat.

**Send me:** confirmation the domain is verified, and tell me what you want the "from" address to
be. My suggestion: `NASTY <hello@nastyboardgame.com>`.

*If you would rather not deal with DNS at all, Resend also gives you a test address that works
immediately without any domain setup - but codes sent from it are much more likely to land in
spam, so it is fine for trying it out and not fine for the family.*

---

## 5. What order I would do this in

1. **Apple** (sections 1a, 1b, 1c). This is the one the App Store requires and the one most of
   your family will actually use. Skip 1d for now.
2. **Google** (section 2). Twenty minutes, no waiting, and it covers anyone on an Android phone
   or a Windows laptop.
3. **Email codes** (section 4). The safety net for everyone else. Do this before you announce
   accounts to the family.
4. **Facebook** (section 3), whenever you feel like dealing with the verification. Or never.

---

## 6. What happens after you send me things

Nothing switches on by accident. Right now the sign-in system is built but completely switched
off in the live game - it does not exist as far as anyone playing is concerned. Turning it on is
a deliberate two-step:

1. I add whichever credentials you have sent to the server's settings. The sign-in buttons for
   those methods start working. Everything else is unchanged.
2. Separately, when you say so, I flip the switch that makes the leaderboard account-only. That
   is the one that changes what the family sees, so it happens on your word, not automatically.

And separately again, I will build the actual sign-in screens in the app and on the website -
that work has not been done yet.

---

## 7. Three things to decide, whenever you like

1. **How long should the one-time "is this old history yours?" window stay open?** After it
   closes, nobody can move an old name onto a new account any more (which is what you asked for).
   Old names that nobody claimed stay on the board as history forever - nothing is ever deleted.
   **My suggestion: six to eight weeks from the update.**
2. **The kids.** Once the leaderboard is account-only, anyone without an account stops appearing
   on it - including the grandchildren. There is also a legal rule that stops us creating
   accounts for under-13s. So they will still be able to play everything and still see their own
   record on their own phone, but they will not be on the shared board. I want to make sure that
   is what you expect before it goes live.
3. **Facebook: yes or no?** It is the only one with real paperwork. If the family are all on
   Apple and Google anyway, saying no costs you nothing.
