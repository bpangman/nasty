#!/usr/bin/env python3
"""Create/inspect the NASTY credit-pack In-App Purchase products in App Store Connect.

2026-07-30, part of Blake's real-money ask ("purchase things outright with real money ...
Make 10 credits be $1"). The four CONSUMABLE products this script manages are the exact
CREDIT_PACKS ladder in server/server.js + server/cloud/server.ts - if that ladder ever
changes, change PACKS below to match and rerun.

HOW IT RUNS: by hand, idempotently - safe to rerun any number of times. Each run walks every
pack through four steps and only does what is missing:
  1. create the consumable IAP product itself
  2. add the en-US localization (display name + description players see on the payment sheet)
  3. set the price schedule (base territory USA, the Apple price tier for each pack)
  4. upload a review screenshot (required before the product can reach "Ready to Submit";
     uses appstore/menu.png as a stand-in until a real Shop screenshot exists - Apple only
     looks at it during review, players never see it)
  5. set territory availability (all territories + automatically available in new ones) -
     discovered the hard way 2026-07-30: WITHOUT this the product sits in MISSING_METADATA
     forever with no hint about what is missing; setting it is what flips READY_TO_SUBMIT

    python3 /Users/jarvis/nasty-game/server/asc_iap_setup.py            # do everything
    python3 /Users/jarvis/nasty-game/server/asc_iap_setup.py --status  # report only, change nothing

WHAT THIS SCRIPT CANNOT DO, no matter what: sign the Paid Applications Agreement or enter
banking/tax info. Only Blake (the Account Holder) can, in App Store Connect > Business.
Until that agreement is Active, products created here sit in "Missing Metadata"/"Prepare
for Submission" and CANNOT be bought, not even in TestFlight sandbox. The run report says
loudly whether that wall was hit.

Same credentials as every unattended upload this repo does (see HANDOFF.md's release
recipe): the App Store Connect API key at server/AuthKey_4JZ244TV94.p8. JWT code copied
from beta_watch.py, which has been exercising it since build 2.
"""
import base64
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request

KEY = '/Users/jarvis/nasty-game/server/AuthKey_4JZ244TV94.p8'
KID, ISS = '4JZ244TV94', '8e4b9c40-3dfe-4cbf-8b12-0e6d6c585cdf'
APP_ID = '6790999186'
SCREENSHOT = '/Users/jarvis/nasty-game/appstore/menu.png'

# The ladder - keep byte-for-byte in step with CREDIT_PACKS in both servers.
# `tier` is the USD customer price the price-point lookup matches on.
# Apple caps the IAP description at 55 characters - keep these short.
PACKS = [
    {'productId': 'com.pangman.nasty.credits50',  'name': '50 Credits',  'tier': '4.99',
     'desc': '50 shop credits. 10 credits = $1.'},
    {'productId': 'com.pangman.nasty.credits110', 'name': '110 Credits', 'tier': '9.99',
     'desc': '110 shop credits - a 10% bonus pack.'},
    {'productId': 'com.pangman.nasty.credits280', 'name': '280 Credits', 'tier': '24.99',
     'desc': '280 shop credits - a 12% bonus pack.'},
    {'productId': 'com.pangman.nasty.credits600', 'name': '600 Credits', 'tier': '49.99',
     'desc': '600 shop credits - a 20% bonus pack.'},
]

STATUS_ONLY = '--status' in sys.argv


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=')


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


def api(method, path, body=None, raw_url=None, headers=None, data_bytes=None):
    """One App Store Connect API call. Returns (status, parsed-json-or-None)."""
    url = raw_url or f'https://api.appstoreconnect.apple.com{path}'
    h = {'Authorization': f'Bearer {jwt()}'}
    if body is not None:
        h['Content-Type'] = 'application/json'
        data_bytes = json.dumps(body).encode()
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data_bytes, headers=h, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read()
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, {'raw': text.decode('utf-8', 'replace')}


def errors_of(resp):
    return '; '.join(f"{er.get('status')} {er.get('code')}: {er.get('detail') or er.get('title')}"
                     for er in (resp or {}).get('errors', []))


def main():
    print(f"== NASTY credit packs in App Store Connect (app {APP_ID}) =="
          + (' [STATUS ONLY - changing nothing]' if STATUS_ONLY else ''))

    st, existing = api('GET', f'/v1/apps/{APP_ID}/inAppPurchasesV2?limit=200')
    if st != 200:
        print(f'FATAL: could not list existing in-app purchases ({st}): {errors_of(existing)}')
        sys.exit(1)
    by_product = {d['attributes']['productId']: d for d in existing.get('data', [])}

    walls = []
    for pack in PACKS:
        pid = pack['productId']
        print(f'\n-- {pid} ({pack["name"]}, ${pack["tier"]})')
        iap = by_product.get(pid)

        # 1. the product itself
        if iap:
            print(f'   product exists: id={iap["id"]} state={iap["attributes"].get("state")}')
        elif STATUS_ONLY:
            print('   product MISSING (would create)')
            continue
        else:
            st, resp = api('POST', '/v2/inAppPurchases', {
                'data': {
                    'type': 'inAppPurchases',
                    'attributes': {
                        'name': f'NASTY {pack["name"]}',
                        'productId': pid,
                        'inAppPurchaseType': 'CONSUMABLE',
                        'reviewNote': ('A pack of credits for the in-game shop (cosmetics, '
                                       'nickname changes, monthly online access). 10 credits = $1; '
                                       'larger packs carry a small bonus. Credits can also be '
                                       'earned free by playing.'),
                    },
                    'relationships': {'app': {'data': {'type': 'apps', 'id': APP_ID}}},
                },
            })
            if st == 201:
                iap = resp['data']
                by_product[pid] = iap
                print(f'   product CREATED: id={iap["id"]}')
            else:
                msg = errors_of(resp)
                print(f'   product creation FAILED ({st}): {msg}')
                if 'agreement' in msg.lower() or 'contract' in msg.lower() or st == 403:
                    walls.append(msg)
                continue
        iap_id = iap['id']

        # 2. en-US localization
        st, locs = api('GET', f'/v2/inAppPurchases/{iap_id}/inAppPurchaseLocalizations?limit=10')
        have_en = st == 200 and any(d['attributes'].get('locale') == 'en-US' for d in locs.get('data', []))
        if have_en:
            print('   en-US localization exists')
        elif STATUS_ONLY:
            print('   en-US localization MISSING (would create)')
        else:
            st, resp = api('POST', '/v1/inAppPurchaseLocalizations', {
                'data': {
                    'type': 'inAppPurchaseLocalizations',
                    'attributes': {'locale': 'en-US', 'name': pack['name'], 'description': pack['desc']},
                    'relationships': {'inAppPurchaseV2': {'data': {'type': 'inAppPurchases', 'id': iap_id}}},
                },
            })
            print(f'   en-US localization {"CREATED" if st == 201 else f"FAILED ({st}): {errors_of(resp)}"}')

        # 3. price schedule
        st, sched = api('GET', f'/v2/inAppPurchases/{iap_id}/iapPriceSchedule')
        if st == 200 and (sched or {}).get('data'):
            print('   price schedule exists')
        elif STATUS_ONLY:
            print('   price schedule MISSING (would set)')
        else:
            # find the USA price point whose customer price is exactly the pack's tier
            point_id = None
            url = (f'https://api.appstoreconnect.apple.com/v2/inAppPurchases/{iap_id}/pricePoints'
                   f'?filter[territory]=USA&limit=200')
            while url and not point_id:
                st, pts = api('GET', None, raw_url=url)
                if st != 200:
                    print(f'   price point lookup FAILED ({st}): {errors_of(pts)}')
                    break
                for d in pts.get('data', []):
                    if d['attributes'].get('customerPrice') == pack['tier']:
                        point_id = d['id']
                        break
                url = (pts.get('links') or {}).get('next')
            if not point_id:
                print(f'   NO USA price point with customerPrice={pack["tier"]} found - price NOT set')
            else:
                st, resp = api('POST', '/v1/inAppPurchasePriceSchedules', {
                    'data': {
                        'type': 'inAppPurchasePriceSchedules',
                        'relationships': {
                            'inAppPurchase': {'data': {'type': 'inAppPurchases', 'id': iap_id}},
                            'baseTerritory': {'data': {'type': 'territories', 'id': 'USA'}},
                            'manualPrices': {'data': [{'type': 'inAppPurchasePrices', 'id': '${price1}'}]},
                        },
                    },
                    'included': [{
                        'id': '${price1}',
                        'type': 'inAppPurchasePrices',
                        'attributes': {'startDate': None},
                        'relationships': {
                            'inAppPurchasePricePoint': {'data': {'type': 'inAppPurchasePricePoints', 'id': point_id}},
                        },
                    }],
                })
                print(f'   price schedule {"SET" if st == 201 else f"FAILED ({st}): {errors_of(resp)}"}')

        # 4. review screenshot (stand-in image; see the file header)
        st, shot = api('GET', f'/v2/inAppPurchases/{iap_id}/appStoreReviewScreenshot')
        shot_state = ''
        if st == 200 and (shot or {}).get('data'):
            shot_state = ((shot['data']['attributes'].get('assetDeliveryState') or {}).get('state')) or ''
        if shot_state == 'COMPLETE':
            print('   review screenshot exists (COMPLETE)')
        elif STATUS_ONLY:
            print(f'   review screenshot not delivered (state={shot_state or "none"}; would upload)')
        else:
            # A stale half-done reservation (AWAITING_UPLOAD / UPLOAD_COMPLETE / FAILED) cannot
            # be resumed cleanly - its upload operations were only issued at reservation time -
            # so it is deleted and redone from scratch. Idempotent either way.
            if shot_state:
                dst, dresp = api('DELETE', f"/v1/inAppPurchaseAppStoreReviewScreenshots/{shot['data']['id']}")
                print(f'   stale screenshot reservation (state={shot_state}) deleted: {dst}')
            png = open(SCREENSHOT, 'rb').read()
            st, resp = api('POST', '/v1/inAppPurchaseAppStoreReviewScreenshots', {
                'data': {
                    'type': 'inAppPurchaseAppStoreReviewScreenshots',
                    'attributes': {'fileName': 'shop.png', 'fileSize': len(png)},
                    'relationships': {'inAppPurchaseV2': {'data': {'type': 'inAppPurchases', 'id': iap_id}}},
                },
            })
            if st != 201:
                print(f'   screenshot reservation FAILED ({st}): {errors_of(resp)}')
            else:
                shot_id = resp['data']['id']
                ok = True
                for op in resp['data']['attributes'].get('uploadOperations') or []:
                    chunk = png[op['offset']:op['offset'] + op['length']]
                    # The asset upload goes to Apple's storage service with ONLY the headers the
                    # reservation handed back - adding the App Store Connect JWT here is what a
                    # first attempt did, and the storage service answers 400 to it.
                    hdrs = {h['name']: h['value'] for h in op.get('requestHeaders') or []}
                    ureq = urllib.request.Request(op['url'], data=chunk, headers=hdrs, method=op['method'])
                    try:
                        with urllib.request.urlopen(ureq) as ur:
                            ust = ur.status
                    except urllib.error.HTTPError as ue:
                        ust = ue.code
                    if ust not in (200, 201):
                        ok = False
                        print(f'   screenshot chunk upload FAILED ({ust})')
                if ok:
                    st, resp = api('PATCH', f'/v1/inAppPurchaseAppStoreReviewScreenshots/{shot_id}', {
                        'data': {
                            'type': 'inAppPurchaseAppStoreReviewScreenshots',
                            'id': shot_id,
                            'attributes': {'uploaded': True,
                                           'sourceFileChecksum': hashlib.md5(png).hexdigest()},
                        },
                    })
                    print(f'   review screenshot {"UPLOADED" if st == 200 else f"commit FAILED ({st}): {errors_of(resp)}"}')

        # 5. territory availability - the step whose absence keeps state at MISSING_METADATA
        st, avail = api('GET', f'/v2/inAppPurchases/{iap_id}/inAppPurchaseAvailability')
        if st == 200 and (avail or {}).get('data'):
            print('   availability exists')
        elif STATUS_ONLY:
            print('   availability MISSING (would set: all territories)')
        else:
            st, terr = api('GET', '/v1/territories?limit=200')
            terr_ids = [t['id'] for t in (terr or {}).get('data', [])]
            st, resp = api('POST', '/v1/inAppPurchaseAvailabilities', {
                'data': {
                    'type': 'inAppPurchaseAvailabilities',
                    'attributes': {'availableInNewTerritories': True},
                    'relationships': {
                        'inAppPurchase': {'data': {'type': 'inAppPurchases', 'id': iap_id}},
                        'availableTerritories': {'data': [{'type': 'territories', 'id': i} for i in terr_ids]},
                    },
                },
            })
            print(f'   availability {"SET (all territories)" if st == 201 else f"FAILED ({st}): {errors_of(resp)}"}')

    print('\n== final state ==')
    st, existing = api('GET', f'/v1/apps/{APP_ID}/inAppPurchasesV2?limit=200')
    for d in (existing or {}).get('data', []):
        a = d['attributes']
        print(f"   {a['productId']}: state={a.get('state')}")
    if walls:
        print('\n!! BLOCKED BY APP STORE CONNECT - almost certainly the unsigned Paid Applications')
        print('!! Agreement. Only Blake can fix this (App Store Connect > Business). Details:')
        for w in walls:
            print(f'!!   {w}')


if __name__ == '__main__':
    main()
