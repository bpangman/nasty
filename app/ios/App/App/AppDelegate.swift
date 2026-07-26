import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    /* ------------------------------------------------------------------------------------
     * PUSH NOTIFICATIONS - "It's your turn in NASTY" (root cause of Blake's "I never get
     * push notifications still", found 2026-07-26).
     *
     * These two methods are the REQUIRED setup step from @capacitor/push-notifications'
     * README ("After enabling the Push Notifications capability, add the following to your
     * app's AppDelegate.swift"). They had never been added - this file was still the stock
     * template `npx cap add ios` generated on 2026-06-19.
     *
     * Why their absence killed the whole feature, silently:
     *   - index.html's registerPushIfGranted() calls PushNotifications.register().
     *   - The plugin's register() calls UIApplication.shared.registerForRemoteNotifications().
     *   - iOS gets a device token from APNs and hands it to THIS app delegate, right here.
     *   - The plugin never sees that token directly. It only listens on NotificationCenter
     *     for .capacitorDidRegisterForRemoteNotifications (see PushNotificationsPlugin's
     *     load()), and Capacitor does NOT swizzle the app delegate to post it for you.
     *   - With no one posting it, the plugin's 'registration' listener never fired, so
     *     index.html's PUSH_TOKEN stayed null forever, so sendPushToken() was a permanent
     *     no-op, so no player record on either server ever had a pushToken, so
     *     maybeSendTurnPush() always took its "no token registered" early return.
     *
     * Nothing downstream was broken: the APNs key, team id, topic and production host all
     * verify against Apple. The chain simply had no token to send to. Do not remove these.
     * ---------------------------------------------------------------------------------- */
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
