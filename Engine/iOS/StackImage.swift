//
//  StackImage.swift — the `<image>` APPLE ADAPTER (U05). Every decision lives in the shared core
//  (ImageCore.swift, corpus OpenSource/Conformance/image/resolution.json); this file is the
//  ImageIO / CoreGraphics / SwiftUI plumbing: decode-at-display-size, the placeholder bitmap, the
//  content-mode mapping, the transition descriptor, and the recycling identity.
//
//  WHY THIS IS ITS OWN FILE. The `<image>` component and Stack.swift are shared by every UI
//  workstream, so the call site there is `let plan = StackImage.plan(dsx.attributes, display: …)`
//  and everything else lives here.
//
//  THE ONE THING WORTH THE WHOLE PLAN IS `allowDownscaling`. `CGImageSourceCreateThumbnailAtIndex`
//  with `kCGImageSourceThumbnailMaxPixelSize` decodes the pixels it will PAINT rather than the
//  pixels the file happens to contain: a 4000 px hero in a 48 pt avatar at @2x is 96 px, which is
//  64 KB instead of 64 MB. In a list of forty avatars that is the difference between a feed that
//  scrolls and one that is killed by the jetsam daemon, and it is why this is a five-day plan
//  with an outsized effect.
//
//  NO SDWebImage, NO Kingfisher, NO Nuke. `DSXImageCache` already exists and the lightbox and the
//  content plane share it; adopting a library would fragment the cache and add weight to every
//  app to buy a policy surface that is thirty lines.
//
import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import UIKit

@MainActor
public enum StackImage {

    // ------------------------------------------------------------------ content mode

    /// `contentFit` → the SwiftUI pair. SwiftUI has no `fill` (a non-uniform stretch), so it is
    /// spelled as a resizable image with no aspect constraint, which is the same picture.
    public enum Fit: Equatable {
        case fill                       // stretch to the box, aspect NOT preserved
        case aspectFill                 // cover
        case aspectFit                  // contain
        case none                       // native size, clipped
        case scaleDown                  // contain, but never larger than native
    }

    public static func fit(_ contentFit: String?) -> Fit {
        switch ImageCore.resolveContentFit(contentFit) {
        case "contain": return .aspectFit
        case "fill": return .fill
        case "none": return .none
        case "scaleDown": return .scaleDown
        default: return .aspectFill
        }
    }

    /// The UIKit twin, for the paths that draw into a `UIImageView` rather than a SwiftUI Image.
    /// `contentPosition` rides `Alignment`/the layer's `contentsRect`, not this enum, because
    /// UIKit's `.topLeft` family conflates the fit and the anchor and the corpus separates them.
    public static func uiContentMode(_ contentFit: String?) -> UIView.ContentMode {
        switch ImageCore.resolveContentFit(contentFit) {
        case "contain", "scaleDown": return .scaleAspectFit
        case "fill": return .scaleToFill
        case "none": return .center
        default: return .scaleAspectFill
        }
    }

    /// `contentPosition` → the SwiftUI alignment the drawn rect is anchored at. The core answers
    /// in 0…1 fractions, which is strictly richer than `Alignment`, so an off-grid pair snaps to
    /// the nearest named anchor here and the exact rect stays available via `ImageCore.solveImageRect`
    /// for the paths that can place it precisely.
    public static func alignment(_ contentPosition: String?) -> Alignment {
        let anchor = ImageCore.resolveContentPosition(contentPosition)
        let horizontal: HorizontalAlignment = anchor.x < 0.34 ? .leading : (anchor.x > 0.66 ? .trailing : .center)
        let vertical: VerticalAlignment = anchor.y < 0.34 ? .top : (anchor.y > 0.66 ? .bottom : .center)
        return Alignment(horizontal: horizontal, vertical: vertical)
    }

    // ------------------------------------------------------------------ decode at size

    /// Decode `data` at the size it will be PAINTED. Returns nil when the bytes are not an image
    /// this device can read — never a zero-size placeholder that would read as a successful load.
    ///
    /// `kCGImageSourceCreateThumbnailFromImageAlways` is deliberate: an embedded EXIF thumbnail is
    /// often 160 px of the wrong crop, and silently painting it instead of the photo is a bug that
    /// only shows up on the photos that have one.
    public static func decode(
        data: Data, contentFit: String?, display: CGSize, scale: CGFloat,
        allowDownscaling: Bool = true
    ) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [
            kCGImageSourceShouldCache: false,
        ] as CFDictionary) else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let sourceWidth = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
        let sourceHeight = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        let plan = ImageCore.resolveDecodeSize(
            fit: contentFit,
            source: ImageCore.Size(width: sourceWidth, height: sourceHeight),
            display: ImageCore.Size(width: Double(display.width), height: Double(display.height)),
            scale: Double(scale),
            allowDownscaling: allowDownscaling
        )
        guard plan.width > 0, plan.height > 0 else { return nil }
        if !plan.downscaled {
            guard let full = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
            return UIImage(cgImage: full, scale: scale, orientation: .up)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(plan.width, plan.height),
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: thumbnail, scale: scale, orientation: .up)
    }

    /// The media type `on:load` reports, sniffed from the container rather than from the URL,
    /// because a CDN that serves WebP from a `.jpg` path is common and the URL would lie.
    public static func mediaType(data: Data) -> String {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let uti = CGImageSourceGetType(source) as String? else { return "unknown" }
        // The UTI's own last component is the container word ImageCore already maps.
        let word = uti.split(separator: ".").last.map(String.init) ?? ""
        let resolved = ImageCore.imageMediaType(word)
        return resolved == "unknown" ? ImageCore.imageMediaType(uti) : resolved
    }

    // ------------------------------------------------------------------ placeholder

    /// A decoded blurhash/thumbhash as a real `UIImage`. Built straight from the core's RGBA
    /// rather than through a CIFilter, so the placeholder a device paints is byte-identical to
    /// the one the corpus pins and the one the other two renderers paint.
    public static func placeholderImage(_ placeholder: String?, width: Int = 32, height: Int = 32) -> UIImage? {
        let resolved = ImageCore.classifyPlaceholder(placeholder)
        guard resolved.kind == "blurhash" || resolved.kind == "thumbhash" else { return nil }
        guard let pixels = ImageCore.decodePlaceholder(resolved, width: width, height: height) else { return nil }
        var bytes = [UInt8](repeating: 0, count: pixels.rgba.count)
        for index in 0..<pixels.rgba.count {
            let value = pixels.rgba[index]
            bytes[index] = UInt8(value < 0 ? 0 : (value > 255 ? 255 : value))
        }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let cgImage = CGImage(
                width: pixels.width,
                height: pixels.height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: pixels.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: true,
                intent: .defaultIntent
              ) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    /// The colour a `placeholder="#rrggbb"` / semantic word resolves to, or nil when the
    /// placeholder is not a colour at all.
    public static func placeholderColor(_ placeholder: String?) -> Color? {
        let resolved = ImageCore.classifyPlaceholder(placeholder)
        guard resolved.kind == "color" else { return nil }
        return StackStyle.color(resolved.value)
    }

    // ------------------------------------------------------------------ the fold

    /// The whole `<image>` attribute table, resolved once. A view reads this instead of parsing
    /// attributes on every body evaluation, and the fields are the corpus's own vocabulary so a
    /// reader can check the renderer against the fixture line by line.
    public struct Plan {
        public var fit: Fit
        public var contentFit: String
        public var alignment: Alignment
        public var cache: ImageCore.CacheResolution
        public var transition: ImageCore.Transition
        public var priority: String
        public var allowDownscaling: Bool
        public var placeholder: ImageCore.Placeholder
        public var recyclingKey: String
        public var blurRadius: CGFloat
        public var tint: Color?
        public var fallback: String?
        public var decorative: Bool
    }

    public static func plan(_ attributes: [String: String], rowKey: String? = nil, previousKey: String? = nil) -> Plan {
        let contentFit = ImageCore.resolveContentFit(attributes["contentFit"])
        let recycling = ImageCore.resolveRecycling(
            recyclingKey: attributes["recyclingKey"], rowKey: rowKey,
            src: attributes["src"], asset: attributes["asset"], previousKey: previousKey
        )
        let blur = Double(attributes["blurRadius"] ?? "") ?? 0
        let tint = attributes["tint"]
        return Plan(
            fit: fit(contentFit),
            contentFit: contentFit,
            alignment: alignment(attributes["contentPosition"]),
            cache: ImageCore.resolveCachePolicy(attributes["cachePolicy"], cache: attributes["cache"]),
            transition: ImageCore.resolveTransition(attributes["transition"]),
            priority: ImageCore.resolveImagePriority(attributes["priority"]),
            // Absent is TRUE: decoding at display size is the behaviour an author should have to
            // opt OUT of, because the opt-in version is the one nobody remembers to write.
            allowDownscaling: (attributes["allowDownscaling"] ?? "true") != "false",
            placeholder: ImageCore.classifyPlaceholder(attributes["placeholder"]),
            recyclingKey: recycling.key,
            blurRadius: CGFloat(blur.isFinite && blur > 0 ? blur : 0),
            tint: (tint == nil || tint!.isEmpty) ? nil : StackStyle.color(tint!),
            fallback: attributes["fallback"],
            decorative: attributes["a11yLabel"] == nil
        )
    }

    /// THE RULE THAT MAKES A FAST APP LOOK FAST, as the animation a view should actually run.
    /// nil means "appear in this frame" — an image already decoded in memory must not fade, and
    /// fading it is the tell that an app is doing theatre instead of work.
    public static func appearance(_ plan: Plan, cacheType: String) -> Animation? {
        guard ImageCore.shouldTransition(plan.transition, cacheType: cacheType) else { return nil }
        let seconds = Double(plan.transition.duration) / 1000.0
        // Only the cross-dissolve is a real SwiftUI opacity animation. The flips and curls are
        // UIView transitions with no SwiftUI twin, so they DEGRADE to the dissolve rather than
        // being silently dropped — the same value on a slower path, never a missing animation.
        return .easeInOut(duration: seconds)
    }

    /// `on:load`'s payload, assembled by the core so all three renderers report the same shape.
    public static func loadPayload(image: UIImage, data: Data?, cacheType: String) -> [String: Any] {
        let type = data.map { mediaType(data: $0) } ?? "unknown"
        return ImageCore.loadPayload(
            width: Double(image.size.width * image.scale),
            height: Double(image.size.height * image.scale),
            mediaType: type,
            cacheType: cacheType
        )
    }
}

/// `.modifier(StackImagePresentation(plan:cacheType:))` — the visual half of the plan applied to
/// whatever view actually holds the pixels, so the same fade, tint and blur ride the bundled
/// path, the remote path and the placeholder path without any of them reimplementing it.
public struct StackImagePresentation: ViewModifier {
    let plan: StackImage.Plan
    let cacheType: String
    @State private var shown = false

    public init(plan: StackImage.Plan, cacheType: String) {
        self.plan = plan
        self.cacheType = cacheType
    }

    public func body(content: Content) -> some View {
        let animation = StackImage.appearance(plan, cacheType: cacheType)
        return content
            .modifier(StackImageTint(tint: plan.tint))
            .blur(radius: plan.blurRadius)
            .opacity(animation == nil ? 1 : (shown ? 1 : 0))
            .animation(animation, value: shown)
            .onAppear { shown = true }
            .accessibilityHidden(plan.decorative)
    }
}

/// `tint` is template rendering for a non-symbol image: the pixels become a stencil for one
/// colour. Split out because `.renderingMode` has no conditional spelling inside a ViewBuilder
/// chain without re-typing the whole branch.
private struct StackImageTint: ViewModifier {
    let tint: Color?

    func body(content: Content) -> some View {
        if let tint = tint {
            content.foregroundColor(tint)
        } else {
            content
        }
    }
}
