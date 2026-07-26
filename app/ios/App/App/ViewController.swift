import UIKit
import Capacitor

/*
 The app's Capacitor view controller.

 It exists for exactly one reason: to register the local Sign in with Apple plugin.

 Capacitor 6 and later build their plugin list from `packageClassList` in the generated
 `ios/App/App/capacitor.config.json`, and that file is rewritten by `npx cap sync` from the
 installed npm packages - so a plugin that lives in this app's own source tree can never be
 listed there, and hand-editing it would be undone by the next sync. The supported hook is
 `capacitorDidLoad()`, which runs after the bridge exists and before the web view loads.

 Main.storyboard points at this class instead of CAPBridgeViewController.
 */
class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppleSignInPlugin())
    }
}
