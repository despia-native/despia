// UIKitCompatibility.swift — warning-clean UIKit shims for the in-app Runtime target.

import UIKit

extension UITraitCollection {
    /// Copy this collection with an elevated interface level. `modifyingTraits` is iOS 17+;
    /// collection merging is its immutable iOS-16 equivalent.
    var dsxElevatedUserInterfaceLevel: UITraitCollection {
        if #available(iOS 17.0, *) {
            return modifyingTraits { $0.userInterfaceLevel = .elevated }
        } else {
            return UITraitCollection(traitsFrom: [
                self,
                UITraitCollection(userInterfaceLevel: .elevated),
            ])
        }
    }
}
