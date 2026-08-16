//
//  LoadingIndicator.swift — the native page-load overlay (kernel surface chrome).
//
//  A cross-cutting SURFACE concern, not a renderer: a package publishes `global.ui.loading` (e.g. the
//  Spinner package) and this draws over WHATEVER the kernel host is showing (web or native) — so no
//  package ever reaches into the web view. The kernel host (RouterHost) overlays it on the whole
//  surface, so every app — web or native — gets it. Style + tint come from the global store
//  (`ui.indicator.progressBar` / `ui.indicator.color`, seeded by the loading-UI package): a top
//  linear bar, else a centered spinner. The kernel reads ONLY its own store (constitution Art. 1) —
//  never a ClosedSource config symbol.
//

import SwiftUI

struct LoadingIndicator: View {
    let showing: Bool
    var body: some View {
        if showing {
            if Self.useProgressBar {
                ProgressView()
                    .progressViewStyle(.linear)
                    .tint(Self.tint)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            } else {
                ProgressView()
                    .progressViewStyle(.circular)
                    .scaleEffect(1.4)
                    .tint(Self.tint)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
            }
        }
    }

    // Indicator STYLE from the global store, seeded by the loading-UI package (Spinner). The kernel
    // reads its own store, never ClosedSource config (Art. 1). Absent (the package is excluded) →
    // defaults, but then nothing publishes ui.loading=true so the indicator never renders anyway.
    private static var useProgressBar: Bool { (DSX.state.getPath("ui.indicator.progressBar") as? Bool) ?? false }
    private static var tint: Color { color(DSX.state.getPath("ui.indicator.color") as? String) }

    /// "#RRGGBB" / "#RRGGBBAA" → Color (the engine's hex idiom, as in Stack / StackWidgetKit); a
    /// missing / non-hex value falls back to a neutral tint (unreached when the indicator shows).
    private static func color(_ s: String?) -> Color {
        guard var hex = s.map({ $0.hasPrefix("#") ? String($0.dropFirst()) : $0 }) else { return .gray }
        if hex.count == 6 { hex = "FF" + hex }
        guard hex.count == 8, let v = UInt64(hex, radix: 16) else { return .gray }
        return Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255,
                     blue: Double(v & 0xFF) / 255, opacity: Double((v >> 24) & 0xFF) / 255)
    }
}
