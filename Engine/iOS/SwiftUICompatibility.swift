// SwiftUICompatibility.swift — warning-clean API shims across DSX deployment floors.

import SwiftUI

/// Change observation that keeps the iOS 16 binary floor without producing the legacy-overload
/// deprecation warning under current SDKs. Every call receives only the new value, independent of
/// which platform overload implements it.
extension View {
    @ViewBuilder
    func dsxOnChange<Value: Equatable>(
        of value: Value,
        perform action: @escaping (Value) -> Void
    ) -> some View {
        #if os(watchOS)
        if #available(watchOS 10.0, *) {
            onChange(of: value) { _, newValue in action(newValue) }
        } else {
            onChange(of: value, perform: action)
        }
        #else
        if #available(iOS 17.0, *) {
            onChange(of: value) { _, newValue in action(newValue) }
        } else {
            onChange(of: value, perform: action)
        }
        #endif
    }
}
