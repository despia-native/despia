import UIKit

extension UIApplication
{
    class func topViewController(_ viewController: UIViewController? = nil) -> UIViewController? {
        let viewController = viewController ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController

        if let nav = viewController as? UINavigationController {
            return topViewController(nav.visibleViewController)
        }
        if let tab = viewController as? UITabBarController {
            if let selected = tab.selectedViewController {
                return topViewController(selected)
            }
        }
        if let presented = viewController?.presentedViewController {
            return topViewController(presented)
        }
        return viewController
    }
    
    class var appDetails: String {
        get {
            if let dict = Bundle.main.infoDictionary {
                if let shortVersion = dict["CFBundleShortVersionString"] as? String,
                    let mainVersion = dict["CFBundleVersion"] as? String,
                    let appName = dict["CFBundleName"] as? String {
                    return "You're using \(appName) Version: \(mainVersion) (Build \(shortVersion))."
                }
            }
            return ""
        }
    }
    
    class var countryCode : String{
        if let countryCode = (Locale.current as NSLocale).object(forKey: .countryCode) as? String {
            return countryCode
        }else{
            return ""
        }
    }
    
    class var appName: String {
        get {
            let mainBundle = Bundle.main
            let displayName = mainBundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            let name = mainBundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
            return displayName ?? name ?? "Unknown"
        }
    }
    
    class var versionString: String {
        get {
            let mainBundle = Bundle.main
            let buildVersionString = mainBundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            let version = mainBundle.object(forInfoDictionaryKey: kCFBundleVersionKey as String) as? String
            return buildVersionString ?? version ?? "Unknown Version"
        }
    }
    class var shortVersionString: String {
        get {
            let mainBundle = Bundle.main
            let buildVersionString = mainBundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            let version = mainBundle.object(forInfoDictionaryKey: kCFBundleVersionKey as String) as? String
            return buildVersionString ?? version ?? "Unknown Version"
        }
    }
}

/// The kernel's application window — `UIWindow` plus ONE bus relay: a shake gesture
/// (`motionEnded(.motionShake)`, the end of the responder chain) fires the named kernel
/// event `"lifecycle.motionShake"`, so any package can `dsx.delegate.listen("lifecycle.motionShake")` (the DevSettings
/// panel, bug reporters, QA overlays). The kernel names no package (Article 1); no
/// subscribers ⇒ a silent no-op, fail-open like every bus event. The bootloader creates
/// this instead of a bare `UIWindow` — the one-line host swap (Article 6: a missing OS
/// callback earns exactly one translation line).
public final class DSXWindow: UIWindow {
    public override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { ModuleRegistry.shared.dispatch("lifecycle.motionShake", nil, .void) }
        super.motionEnded(motion, with: event)
    }
}
