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

}

// Keep the web business UI intact and provide only the iOS file-export bridge.
class OrderDinnerViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(IosFilesPlugin())
        // The web UI owns its inner scroll areas; the outer viewport must stay fixed.
        webView?.scrollView.bounces = false
        webView?.scrollView.alwaysBounceVertical = false
        webView?.scrollView.alwaysBounceHorizontal = false
        if #available(iOS 16.4, *) { webView?.isInspectable = _isDebugAssertConfiguration() }
    }
}

@objc(IosFilesPlugin)
public class IosFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IosFilesPlugin"
    public let jsName = "IosFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise)
    ]

    @objc func shareFile(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"),
              let base64 = call.getString("base64"),
              let data = Data(base64Encoded: base64) else {
            call.reject("报表内容无效")
            return
        }
        do {
            let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Exports", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let safeName = (filename as NSString).lastPathComponent
            let file = folder.appendingPathComponent(safeName.isEmpty ? "营业统计.csv" : safeName)
            try data.write(to: file, options: .atomic)
            DispatchQueue.main.async { [weak self] in
                guard let controller = self?.bridge?.viewController else {
                    call.reject("无法打开文件分享")
                    return
                }
                let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                if let popover = share.popoverPresentationController {
                    popover.sourceView = controller.view
                    popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                    popover.permittedArrowDirections = []
                }
                share.completionWithItemsHandler = { _, _, _, error in
                    if let error = error { call.reject("导出失败", nil, error) }
                    else { call.resolve() }
                }
                controller.present(share, animated: true)
            }
        } catch {
            call.reject("保存报表失败", nil, error)
        }
    }
}
