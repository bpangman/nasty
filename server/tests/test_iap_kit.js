"use strict";
/*
 * 2026-07-30 § REAL MONEY - HELPER, NOT A SUITE. Exports the throwaway "GOOD" signing chain and
 * transaction minting used to exercise Apple In-App Purchase flows WITHOUT EVER CONTACTING
 * APPLE: the server under test is booted with NASTY_IAP_ROOT_CA_B64 pointed at GOOD_ROOT_B64
 * (the same env-stub convention NASTY_APPLE_JWKS_URL established for sign-in), and every
 * "signed transaction" a test presents is minted here with the matching leaf key - the exact
 * JWS shape StoreKit 2's jwsRepresentation has, x5c chain and all.
 *
 * The chain was generated once with openssl (P-256, 20-year validity) and carries Apple's REAL
 * marker OIDs (1.2.840.113635.100.6.11.1 leaf / 1.2.840.113635.100.6.2.1 intermediate, added
 * via extfile) so the servers' production OID checks stay switched on under test.
 *
 * NOTE: test_accounts_iap.js keeps its OWN embedded copy of this chain (plus an "EVIL" second
 * chain for its forged-transaction cases) deliberately - that suite is the security suite and
 * stays fully self-contained. This helper exists for the OTHER suites (UI flows) that just need
 * a valid purchase to exist, not to attack the verifier.
 */
const crypto = require("crypto");
const K = require("./test_accounts_kit.js");

const GOOD_ROOT_B64 =
  "MIIBOjCB4AIJANiOTrKtgf6oMAoGCCqGSM49BAMCMCUxIzAhBgNVBAMMGk5BU1RZIElBUCBUZXN0IFJvb3QgKGdvb2QpMB4X" +
  "DTI2MDczMDIxMzIyNVoXDTQ2MDcyNTIxMzIyNVowJTEjMCEGA1UEAwwaTkFTVFkgSUFQIFRlc3QgUm9vdCAoZ29vZCkwWTAT" +
  "BgcqhkjOPQIBBggqhkjOPQMBBwNCAASEhCCnBLGPPGNrbhXLBre9Lw/ha8CcMHGHDwtKSvnMj9iPgUUbfQijSqKtJNHnEMFz" +
  "PNE12Zuqr6N9pfPkeqzLMAoGCCqGSM49BAMCA0kAMEYCIQDpc9oj1/mRzONvxRGDGdHDGJD0Lm3UQGwM9AtppcfAZAIhANrW" +
  "TeWzN+rDZTwgQs/dBHasqJzzpTpL+ZnDgt2y78xb";
const GOOD_INTER_B64 =
  "MIIBeDCCAR6gAwIBAgIJAM79zxWBwxS6MAoGCCqGSM49BAMCMCUxIzAhBgNVBAMMGk5BU1RZIElBUCBUZXN0IFJvb3QgKGdv" +
  "b2QpMB4XDTI2MDczMDIxMzIyNVoXDTQ2MDcyNTIxMzIyNVowLTErMCkGA1UEAwwiTkFTVFkgSUFQIFRlc3QgSW50ZXJtZWRp" +
  "YXRlIChnb29kKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOg53sa1kLVKvxEnl0o1aycVX7AVo4PvXVyRpJdKgBSoCSY+" +
  "HqoHkVZDxz2ymA+xDwTxFnH5WCQm9xDMWiGtms+jLzAtMAwGA1UdEwQFMAMBAf8wCwYDVR0PBAQDAgIEMBAGCiqGSIb3Y2QG" +
  "AgEEAgUAMAoGCCqGSM49BAMCA0gAMEUCIF52cKgjVXQaPDCCEnLeplrH22HvL3jD2ZTTGNc7jjdpAiEA+jy+2mvAJIWtu2Kt" +
  "A6EOPpyZ3gqkcB6TRcMZtznrnqQ=";
const GOOD_LEAF_B64 =
  "MIIBajCCARGgAwIBAgIJAK8RG+YB30fyMAoGCCqGSM49BAMCMC0xKzApBgNVBAMMIk5BU1RZIElBUCBUZXN0IEludGVybWVk" +
  "aWF0ZSAoZ29vZCkwHhcNMjYwNzMwMjEzMjI1WhcNNDYwNzI1MjEzMjI1WjAoMSYwJAYDVQQDDB1OQVNUWSBJQVAgVGVzdCBT" +
  "aWduaW5nIChnb29kKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJiWrRsUEb0oCZDQAiMCiKxPf0VV/VxIDlBhwYPct6W9" +
  "rtGg0i8SteJPn7WDIn81NWkcblQpUWwX0Py5Ch2yrvOjHzAdMAkGA1UdEwQCMAAwEAYKKoZIhvdjZAYLAQQCBQAwCgYIKoZI" +
  "zj0EAwIDRwAwRAIgKUcmwIiFyKoJ6YqMxWPRllDS2zRtbNUeSX6JqZhbbGECIC7/P1EakuvHddwsjkvijro+JpJ/SiQOfm7L" +
  "AS2hkb9z";
const GOOD_LEAF_KEY_PEM = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEILcFESoTRCZSf+i+fDzMeM4YADXSarW/aLISqBLk0WI4oAoGCCqGSM49",
  "AwEHoUQDQgAEmJatGxQRvSgJkNACIwKIrE9/RVX9XEgOUGHBg9y3pb2u0aDSLxK1",
  "4k+ftYMifzU1aRxuVClRbBfQ/LkKHbKu8w==",
  "-----END EC PRIVATE KEY-----",
].join("\n");
const GOOD_LEAF_KEY = crypto.createPrivateKey(GOOD_LEAF_KEY_PEM);
const GOOD_X5C = [GOOD_LEAF_B64, GOOD_INTER_B64, GOOD_ROOT_B64];

let txnCounter = 0;
function signJws(headerObj, payloadObj, key) {
  const input = K.b64url(JSON.stringify(headerObj)) + "." + K.b64url(JSON.stringify(payloadObj));
  const sig = crypto.sign("sha256", Buffer.from(input, "ascii"), { key, dsaEncoding: "ieee-p1363" });
  return input + "." + K.b64url(sig);
}
// Mints one signed transaction, StoreKit-2-shaped. Every call gets a FRESH transaction id (the
// servers' replay ledger refuses a reused one, exactly as it must in production).
function mintTransaction(opts) {
  const o = opts || {};
  const payload = Object.assign({
    transactionId: o.transactionId !== undefined ? o.transactionId : "8" + Date.now() + "" + (txnCounter++),
    originalTransactionId: "8000000000",
    bundleId: o.bundleId !== undefined ? o.bundleId : "com.pangman.nasty",
    productId: o.productId !== undefined ? o.productId : "com.pangman.nasty.credits50",
    purchaseDate: Date.now(),
    quantity: o.quantity !== undefined ? o.quantity : 1,
    type: "Consumable",
    environment: o.environment !== undefined ? o.environment : "Sandbox",
  }, o.extra || {});
  const header = { alg: "ES256", x5c: o.x5c || GOOD_X5C };
  return { jws: signJws(header, payload, o.signWith || GOOD_LEAF_KEY), payload };
}

module.exports = { GOOD_ROOT_B64, GOOD_INTER_B64, GOOD_LEAF_B64, GOOD_X5C, GOOD_LEAF_KEY, mintTransaction, signJws };
