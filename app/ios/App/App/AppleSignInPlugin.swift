import Foundation
import UIKit
import AuthenticationServices
import Capacitor

/*
 Sign in with Apple, native, for the NASTY iOS app.

 Why a hand-written plugin instead of a community pod: this needs exactly one thing - hand
 Apple a server-issued nonce, put up the system sheet, and give the resulting identity token
 back to the web layer. That is about seventy lines. A pod would add a dependency, a podspec
 and a release cadence to a family board game for no benefit, and the accounts design doc
 (prelaunch/accounts-design.md section 16) already recommended writing it locally.

 THE NONCE, and why it is passed through verbatim.

 The game server mints the nonce itself (GET /account/nonce), stores it single-use with a
 ten-minute life, and deletes it the moment it is presented. Its verifier
 (verifyOidcToken in server/server.js and server/cloud/server.ts) then requires
 payload.nonce === the nonce the client sent in the request body - an exact string equality
 against the value the server itself issued.

 Apple echoes ASAuthorizationAppleIDRequest.nonce back in the identity token's `nonce` claim
 unchanged. So the correct binding here is: request.nonce = the server's nonce, and the same
 string goes in the POST body. There is deliberately NO SHA256 hashing in this file. Hashing
 is what you do when the party checking the nonce did not mint it (Firebase's flow: hash it
 on the way out, hand the raw value to Firebase, let Firebase hash and compare). Our server
 minted it, so it already knows the value, and hashing here would simply make the two sides
 disagree and every sign-in fail with reason "nonce".

 SCOPES. 2026-08-14: `.fullName` is now requested, and ONLY `.fullName` - never `.email`.
 Without the email scope Apple still puts no `email` claim in the identity token, so the
 server still has nothing to store and the App Store privacy questionnaire stays free of
 Contact Info > Email Address. `.fullName` fixes an App Store rejection (Guideline 4): the
 app was requiring a brand-new account to TYPE a name Apple had already collected during its
 own sign-in sheet. Apple's rule (ASAuthorizationAppleIDCredential.fullName) is that the name
 comes back ONLY on the very first authorization for this app/Apple ID pair - every later
 sign-in on any device gets nil here, which is exactly when the client already has a
 gameName and never shows a name prompt at all. The web layer uses this only to PRE-FILL the
 one-time nickname gate; the player still taps to confirm (or edits first), and a nil name
 falls back to this phone's own current play name, so nothing about the gate being mandatory
 changes.
 */
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    // Exactly one sign-in can be in flight. A second tap while the sheet is up is answered
    // rather than left hanging, so the web layer's promise always settles.
    private var pendingCall: CAPPluginCall?
    private var authController: ASAuthorizationController?

    @objc func isAvailable(_ call: CAPPluginCall) {
        // The deployment target is iOS 15, and Sign in with Apple has been available since
        // iOS 13, so on this app it is always there. Kept as a method so the web layer can
        // ask one question instead of hardcoding a platform assumption.
        call.resolve(["available": true])
    }

    @objc func authorize(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("A sign-in nonce is required.", "nononce")
            return
        }
        DispatchQueue.main.async {
            if self.pendingCall != nil {
                call.reject("A sign-in is already in progress.", "busy")
                return
            }
            self.pendingCall = call
            let request = ASAuthorizationAppleIDProvider().createRequest()
            // .fullName only - never .email. See the SCOPES note at the top of this file.
            request.requestedScopes = [.fullName]
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authController = controller
            controller.performRequests()
        }
    }

    private func finish(_ body: (CAPPluginCall) -> Void) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        authController = nil
        body(call)
    }
}

extension AppleSignInPlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            finish { $0.reject("Apple did not return a sign-in token.", "notoken") }
            return
        }
        // `user` is Apple's stable per-app identifier. It is returned for the client's own
        // bookkeeping only - the server never trusts it and re-derives the same value from the
        // signed token's `sub` claim.
        // `givenName`/`familyName` come from `credential.fullName` (PersonNameComponents) and
        // are non-nil ONLY on this Apple ID's first-ever authorization for this app - see the
        // SCOPES note at the top of this file. Sent as plain strings (or omitted/nil) purely so
        // the web layer can pre-fill the one-time nickname gate; never persisted here, never
        // sent anywhere but back to the JS layer that made this call.
        var result: [String: Any] = ["identityToken": token, "user": credential.user]
        if let given = credential.fullName?.givenName, !given.isEmpty {
            result["givenName"] = given
        }
        if let family = credential.fullName?.familyName, !family.isEmpty {
            result["familyName"] = family
        }
        finish { $0.resolve(result) }
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        // A cancel is not a failure. It gets its own code so the web layer can close quietly
        // instead of showing an error message for something the player chose to do.
        let code = (error as? ASAuthorizationError)?.code
        if code == .canceled {
            finish { $0.reject("Sign-in cancelled.", "canceled") }
            return
        }
        finish { $0.reject(error.localizedDescription, "failed") }
    }
}

extension AppleSignInPlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
