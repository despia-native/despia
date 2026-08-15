//
//  Color.swift — the `UIColor(hex:)` primitive (kernel-level, names nobody).
//
//  A pure, stateless color helper used by generated config across several packages (StatusBar,
//  BottomBar, PullToRefresh, Splash) and the bootloader's splash background. Because it's shared by
//  4+ consumers it can't live inside any one package without breaking the others when that package is
//  excluded (Article 7, fail-open); and it names no package, so it belongs in the kernel as a generic
//  primitive (Article 1). Relocated from the former `HostGlobals.swift` once that file's last remnant
//  was dissolved — the host now owns no utility code either.
//

import UIKit
import Foundation
import SwiftUI

// MARK: - SwiftUI Color hex init — so a module colors WITHOUT importing UIKit.
public extension Color {
    /// SwiftUI color from "#RRGGBB" / "#RRGGBBAA" hex (delegates to the UIColor primitive).
    init(hex: String) { self.init(UIColor(hex: hex)) }
}

// MARK: - UIColor hex init
extension UIColor {
    /// Color from "#RRGGBB" or "#RRGGBBAA" hex.
    convenience init(hex: String) {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let v = UInt64(s, radix: 16) ?? 0
        let hasAlpha = s.count == 8
        let r = CGFloat((v >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
        let g = CGFloat((v >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
        let b = CGFloat((v >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
        let a = hasAlpha ? CGFloat(v & 0xFF) / 255 : 1
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
