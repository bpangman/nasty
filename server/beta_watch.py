#!/usr/bin/env python3
"""Watch the Nasty TestFlight beta review; email Blake both links on approval.
Runs from cron every 30 min. Self-disables (writes a done-marker) after sending.
No Claude involvement - pure API check + gmail_sa.py send.
"""
import base64, json, time, subprocess, sys, os, urllib.request

DONE = '/Users/jarvis/nasty-game/server/.beta_watch_done'
LOG = '/Users/jarvis/nasty-game/server/beta_watch.log'
KEY = '/Users/jarvis/nasty-game/server/AuthKey_4JZ244TV94.p8'
KID, ISS = '4JZ244TV94', '8e4b9c40-3dfe-4cbf-8b12-0e6d6c585cdf'
APP_ID = '6790999186'

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
    # newest beta app review submission for the app's builds
    d = api('/v1/betaAppReviewSubmissions?filter[build]=7a75fd9f-73ff-4c48-870f-f8b31ba9c00f&limit=5')
    states = [(i['attributes']['betaReviewState'], i['id']) for i in d.get('data', [])]
    log(f'states={states}')
    if not any(s == 'APPROVED' for s, _ in states):
        if any(s in ('REJECTED',) for s, _ in states):
            # tell Blake a rejection happened rather than staying silent
            body = '/tmp/nasty_beta_rejected.html'
            open(body, 'w').write(
                '<p>Blake, Apple flagged something in the family beta review (a rejection). '
                'No action needed from you: mention it to Cortana in the Claude session and '
                "she'll read Apple's notes and fix whatever they want changed.</p>")
            subprocess.run(['python3', '/Users/jarvis/clawd/gmail_sa.py', 'send',
                            'blake.pangman@gmail.com', 'NASTY beta: Apple flagged something',
                            body], check=True)
            open(DONE, 'w').write('rejected\n')
        sys.exit(0)

    body = '/tmp/nasty_beta_live.html'
    open(body, 'w').write('''
<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;line-height:1.6">
<h1 style="color:#1a5c38">🎉 Build 24 reached the family</h1>
<p>Apple approved the beta - the family can install the real app right now.</p>
<p>This build fixes the first-game speed pop-up: before, the computer players were already
making moves on the board behind the pop-up while you were still deciding. Now the game
holds completely still - no cards dealt, nobody moves - until you pick your speed, and the
very first deal plays at the pace you chose. Same idea online: the speed question now comes
up before you enter a game room, never on top of a live table.</p>
<h3>📱 The link to text the family:</h3>
<p style="background:#f4f1e8;padding:12px 16px;border-radius:8px;font-size:17px">
<a href="https://testflight.apple.com/join/d79YpZea">https://testflight.apple.com/join/d79YpZea</a></p>
<p>They tap it → install Apple's free "TestFlight" app if asked → tap Install → NASTY is on their phone. Works for up to 10,000 testers, so invite the whole clan.</p>
<h3>💻 The browser link (no install, computers welcome):</h3>
<p style="background:#f4f1e8;padding:12px 16px;border-radius:8px;font-size:17px">
<a href="https://nastyboardgame.com">nastyboardgame.com</a></p>
<p>Same game, same online rooms - app players and browser players share tables with the 4-letter codes.</p>
<p><b>Your own phone:</b> TestFlight will auto-update you to the new build if it hasn't already.</p>
<p>Play hard for a week and send Cortana anything weird. After that: one command from her, one "Release" tap from you, and NASTY is on the App Store.</p>
<p>- Cortana</p></div>''')
    subprocess.run(['python3', '/Users/jarvis/clawd/gmail_sa.py', 'send',
                    'blake.pangman@gmail.com',
                    'NASTY: build 24 is live for the family 🎉', body], check=True)
    open(DONE, 'w').write('approved\n')
    log('APPROVED - email sent, watcher done')
except Exception as e:
    log(f'error: {e}')
