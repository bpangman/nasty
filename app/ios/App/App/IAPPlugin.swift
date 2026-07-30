import Foundation
import Capacitor
import StoreKit

/*
 Real-money credit packs for the NASTY iOS app - StoreKit 2, hand-written.

 2026-07-30, Blake's ask (verbatim): "please add functionality for people to purchase things
 outright with real money (CC transaction) if they don't have enough credits earned or would
 simply just rather purchase instead of earning the credits."

 Why a hand-written plugin instead of a community pod: the same reasoning as
 AppleSignInPlugin.swift next door. This needs exactly four things - list the credit-pack
 products, run a purchase, hand the SIGNED transaction (jwsRepresentation) to the web layer so
 the game server can verify it, and finish transactions the server has confirmed. StoreKit 2
 makes that about a hundred lines. The community Capacitor IAP plugins are built around
 receipts, subscriptions, or a paid third-party service, and none of them hands back the raw
 jwsRepresentation this design needs - the server verifies the signature chain itself and
 trusts NOTHING the client claims about what was bought.

 THE FINISH DISCIPLINE, and why purchase() does not finish the transaction:
 Apple considers a consumable delivered when the app calls finish() - after that the
 transaction stops appearing in Transaction.unfinished, forever. If this plugin finished
 immediately on purchase and the app crashed (or the network died) before the game server
 credited the wallet, the player would have paid real money for nothing, with no record left
 on the device to retry from. So the contract with the web layer is:
   1. purchase() -> returns the signed transaction, NOT finished
   2. web layer POSTs it to /account/iap/verify; the server credits the wallet
   3. web layer calls finish() ONLY after the server said ok (or alreadyProcessed)
 If anything dies between 1 and 3, the transaction is still in Transaction.unfinished on the
 next launch; getPending() hands those back so the web layer can resubmit them. The server's
 replay ledger makes resubmission safe - a transaction can only ever credit once, and a
 resubmission of an already-credited one answers alreadyProcessed:true so the app knows it is
 safe to finish.

 The web layer must degrade gracefully on the website, where none of this exists: it checks
 window.Capacitor?.Plugins?.NastyIAP before offering any real-money button (same pattern as
 the AppleSignIn native path).
 */
@objc(IAPPlugin)
public class IAPPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IAPPlugin"
    public let jsName = "NastyIAP"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise)
    ]

    // Product objects are cached per id after the first fetch - purchase() needs the actual
    // Product instance, and re-fetching on every tap would add a visible delay to the sheet.
    private var productCache: [String: Product] = [:]

    // Both cases of a VerificationResult still carry the underlying transaction. The server
    // does the REAL verification (pinned Apple root, full chain) - this plugin deliberately
    // forwards even an .unverified result rather than second-guessing, because a forged one
    // dies on the server anyway and a false-negative here would eat a real payment.
    private func underlyingTransaction(_ v: VerificationResult<Transaction>) -> Transaction {
        switch v {
        case .verified(let t): return t
        case .unverified(let t, _): return t
        }
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        // canMakePayments is false under parental controls / MDM restrictions - the one case
        // on this iOS-15+ app where the Buy button genuinely should not appear.
        call.resolve(["available": AppStore.canMakePayments])
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let ids = call.getArray("productIds", String.self), !ids.isEmpty else {
            call.reject("productIds is required.", "badargs")
            return
        }
        Task {
            do {
                let products = try await Product.products(for: ids)
                var out: [[String: Any]] = []
                for p in products {
                    self.productCache[p.id] = p
                    out.append([
                        "productId": p.id,
                        "displayName": p.displayName,
                        // displayPrice is the LOCALIZED price string ("$4.99", "CHF 5.00") -
                        // exactly what Apple requires the player to see before confirming.
                        "displayPrice": p.displayPrice,
                        "price": NSDecimalNumber(decimal: p.price).doubleValue,
                    ])
                }
                call.resolve(["products": out])
            } catch {
                call.reject(error.localizedDescription, "fetchfailed")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("productId is required.", "badargs")
            return
        }
        Task { @MainActor in
            do {
                var product = self.productCache[productId]
                if product == nil {
                    product = (try await Product.products(for: [productId])).first
                    if let p = product { self.productCache[p.id] = p }
                }
                guard let product else {
                    call.reject("That product isn't available from the App Store right now.", "noproduct")
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    let txn = self.underlyingTransaction(verification)
                    // NOT finished here - see the finish-discipline note at the top.
                    call.resolve([
                        "state": "purchased",
                        "jws": verification.jwsRepresentation,
                        "transactionId": String(txn.id),
                        "productId": product.id,
                    ])
                case .userCancelled:
                    // A cancel is not a failure - the web layer closes quietly, same
                    // convention as AppleSignInPlugin's "canceled" code.
                    call.resolve(["state": "cancelled"])
                case .pending:
                    // Ask to Buy (a parent has to approve). The transaction arrives later in
                    // Transaction.unfinished; getPending() on a future launch picks it up.
                    call.resolve(["state": "pending"])
                @unknown default:
                    call.resolve(["state": "unknown"])
                }
            } catch {
                call.reject(error.localizedDescription, "failed")
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let idStr = call.getString("transactionId"), let id = UInt64(idStr) else {
            call.reject("transactionId is required.", "badargs")
            return
        }
        Task {
            for await v in Transaction.unfinished {
                let t = self.underlyingTransaction(v)
                if t.id == id {
                    await t.finish()
                    call.resolve(["ok": true])
                    return
                }
            }
            // Already finished (or never existed) - answered as success rather than an error,
            // because the caller's goal ("this transaction must not come back again") is met.
            call.resolve(["ok": true, "alreadyFinished": true])
        }
    }

    @objc func getPending(_ call: CAPPluginCall) {
        Task {
            var out: [[String: Any]] = []
            for await v in Transaction.unfinished {
                let t = self.underlyingTransaction(v)
                out.append([
                    "jws": v.jwsRepresentation,
                    "transactionId": String(t.id),
                    "productId": t.productID,
                ])
            }
            call.resolve(["transactions": out])
        }
    }
}
