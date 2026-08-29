import Foundation
import UIKit
import SystemConfiguration

/// The kernel's one connectivity primitive: a synchronous "is a route available" flag for kernel
/// callers, which may not import a module. AUTHORS SHOULD NOT READ THIS. The app-facing
/// connectivity plane is `Core/Net` (`dsx.module.net`), which reports link type, metered and
/// constrained state, a debounced change stream and a real captive-portal probe. This flag cannot
/// tell an up interface from a usable one, which is exactly the case a captive portal creates.
public class InternetConnectionManager {


    private init() {

    }

    public static func isConnectedToNetwork() -> Bool {

        var zeroAddress = sockaddr_in()
        zeroAddress.sin_len = UInt8(MemoryLayout.size(ofValue: zeroAddress))
        zeroAddress.sin_family = sa_family_t(AF_INET)
        guard let defaultRouteReachability = withUnsafePointer(to: &zeroAddress, {

            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {

                SCNetworkReachabilityCreateWithAddress(nil, $0)

            }

        }) else {

            return false
        }
        var flags = SCNetworkReachabilityFlags()
        if !SCNetworkReachabilityGetFlags(defaultRouteReachability, &flags) {
            return false
        }
        let isReachable = (flags.rawValue & UInt32(kSCNetworkFlagsReachable)) != 0
        let needsConnection = (flags.rawValue & UInt32(kSCNetworkFlagsConnectionRequired)) != 0
        return (isReachable && !needsConnection)
    }

}
