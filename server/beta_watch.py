#!/usr/bin/env python3
"""Watch the Nasty TestFlight beta review; email Blake both links on approval.

HOW THIS ACTUALLY RUNS (corrected 2026-07-25): BY HAND, one run per check. It is NOT on cron
and NOT on a LaunchAgent - `crontab -l` is empty and there is no com.nasty.* plist for it. Run
it yourself after uploading a build, then again every so often until it reports APPROVED:

    python3 /Users/jarvis/nasty-game/server/beta_watch.py

Each run is a single check-and-exit (no loop, no sleep). It self-disables by writing a
done-marker once it has emailed Blake, so re-running after that is a harmless no-op. To arm it
for a NEW build: delete server/.beta_watch_done, update BUILD_SUBMISSION_ID below to the new
build's betaAppReviewSubmissions filter id, and refresh the two "what is in this build" bullets
in the email body.

The build NUMBER in the subject line and the email body is read automatically out of
CURRENT_PROJECT_VERSION in app/ios/App/App.xcodeproj/project.pbxproj, so it cannot drift away
from the build that was actually uploaded. (The submission ID still has to be updated by hand -
Apple mints a fresh one per build and there is no way to derive it locally.)

No Claude involvement - pure API check + gmail_sa.py send.
"""
import base64, json, re, time, subprocess, sys, os, urllib.request

DONE = '/Users/jarvis/nasty-game/server/.beta_watch_done'
LOG = '/Users/jarvis/nasty-game/server/beta_watch.log'
KEY = '/Users/jarvis/nasty-game/server/AuthKey_4JZ244TV94.p8'
PBXPROJ = '/Users/jarvis/nasty-game/app/ios/App/App.xcodeproj/project.pbxproj'
KID, ISS = '4JZ244TV94', '8e4b9c40-3dfe-4cbf-8b12-0e6d6c585cdf'
APP_ID = '6790999186'

# The one thing that must still be updated by hand for each new build (Apple mints it per
# build; it cannot be derived from anything on this Mac).
BUILD_SUBMISSION_ID = '0b12698f-438a-4526-a13d-6c0c4995b071'


def current_build():
    """Read CURRENT_PROJECT_VERSION out of the Xcode project - the single source of truth for
    which build this watcher is talking about. Both the Debug and Release configs carry it and
    the release process keeps them equal; if they ever disagree, that is a real problem, so say
    so rather than guessing."""
    nums = set(re.findall(r'CURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*;', open(PBXPROJ).read()))
    if not nums:
        raise RuntimeError(f'no CURRENT_PROJECT_VERSION found in {PBXPROJ}')
    if len(nums) > 1:
        raise RuntimeError(f'CURRENT_PROJECT_VERSION disagrees between build configs: {sorted(nums)} '
                           '- fix the Xcode project before shipping')
    return nums.pop()

def log(m):
    with open(LOG, 'a') as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {m}\n")

if os.path.exists(DONE):
    sys.exit(0)

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=')

def jwt():
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    key = serialization.load_pem_private_key(open(KEY, 'rb').read(), None)
    hdr = b64u(json.dumps({'alg': 'ES256', 'kid': KID, 'typ': 'JWT'}).encode())
    now = int(time.time())
    pay = b64u(json.dumps({'iss': ISS, 'iat': now, 'exp': now + 900,
                           'aud': 'appstoreconnect-v1'}).encode())
    msg = hdr + b'.' + pay
    der = key.sign(msg, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    sig = b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
    return (msg + b'.' + sig).decode()

def api(path):
    req = urllib.request.Request(f'https://api.appstoreconnect.apple.com{path}',
                                 headers={'Authorization': f'Bearer {jwt()}'})
    return json.load(urllib.request.urlopen(req))

try:
    BUILD = current_build()
    log(f'watching build {BUILD} (from CURRENT_PROJECT_VERSION)')
    # newest beta app review submission for the app's builds
    d = api(f'/v1/betaAppReviewSubmissions?filter[build]={BUILD_SUBMISSION_ID}&limit=5')
    states = [(i['attributes']['betaReviewState'], i['id']) for i in d.get('data', [])]
    log(f'states={states}')
    if not any(s == 'APPROVED' for s, _ in states):
        if any(s in ('REJECTED',) for s, _ in states):
            # tell Blake a rejection happened rather than staying silent
            body = '/tmp/nasty_beta_rejected.html'
            open(body, 'w').write(
                '<p>Blake, Apple flagged something in the beta review (a rejection). '
                'No action needed from you: mention it to Cortana in the Claude session and '
                "she'll read Apple's notes and fix whatever they want changed.</p>")
            subprocess.run(['python3', '/Users/jarvis/clawd/gmail_sa.py', 'send',
                            'blake.pangman@gmail.com', 'NASTY beta: Apple flagged something',
                            body], check=True)
            open(DONE, 'w').write('rejected\n')
        sys.exit(0)

    body = '/tmp/nasty_beta_live.html'
    # 2026-08-02 (v0.67 ship): "what is in this build" bullets rewritten for the Sunset/Forest
    # rename - same pattern every build since 2 has followed (rewrite, do not accumulate old
    # bullets from prior builds).
    open(body, 'w').write(f'''
<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;line-height:1.6">
<h1 style="color:#1a5c38">Build {BUILD} is out there</h1>
<p>Apple approved the beta - everyone can install the real app right now.</p>
<p>What's in this build:</p>
<ul>
<li><b>Two Shop peg palettes got new names.</b> Sunset is now called Marbles, and Forest is now called Patchwork Quilt - the colors themselves haven't changed at all, just the names, so they actually describe what you see on the board.</li>
</ul>
<h3>The link to text everyone:</h3>
<p style="background:#f4f1e8;padding:12px 16px;border-radius:8px;font-size:17px">
<a href="https://testflight.apple.com/join/d79YpZea">https://testflight.apple.com/join/d79YpZea</a></p>
<p>They tap it, install Apple's free "TestFlight" app if asked, tap Install, and NASTY is on their phone. Works for up to 10,000 testers, so invite the whole clan.</p>
<p>(nastyboardgame.com itself is intentionally a coming-soon page right now, not the playable game - all play happens in the app.)</p>
<p><b>Your own phone:</b> TestFlight will auto update you to the new build if it hasn't already.</p>
<p>Play a bit and send Cortana anything weird. When you're ready for the real public launch, that's one command from her plus your own "Release" tap in App Store Connect.</p>
<p>- Cortana</p></div>''')
    subprocess.run(['python3', '/Users/jarvis/clawd/gmail_sa.py', 'send',
                    'blake.pangman@gmail.com',
                    f'NASTY: build {BUILD} is live', body], check=True)
    open(DONE, 'w').write('approved\n')
    log(f'APPROVED - build {BUILD} email sent, watcher done')
except Exception as e:
    log(f'error: {e}')
