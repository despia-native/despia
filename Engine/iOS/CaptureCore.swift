//
//  CaptureCore.swift
//  DespiaScript
//
//  The shared `capture` module core: the format fold, scale resolution, the pixel budget and
//  the PDF page geometry. The law is the corpus, OpenSource/Conformance/capture/
//  (parity/F11-capture.md). The twin of :core CaptureCore.kt and of the web
//  @despia/kernel capture-core.ts.
//
//  WHY THESE PARTS AND NOT THE RASTERISING. Turning a view into pixels is platform work
//  (UIGraphicsImageRenderer, ImageRenderer, UIGraphicsPDFRenderer) and belongs in the module
//  facet. What cannot live there is the ARITHMETIC: an OG card asked for at 1200x630 must
//  come out at exactly 1200x630 on every renderer, and the guard that refuses a
//  20000x20000 request before the device tries to allocate it has to trip at the same point
//  everywhere.
//

import Foundation

public enum CaptureCore {

    /// The raster formats. webp is offered because it is half the bytes of a png for a share
    /// card, and refused honestly where a platform cannot write it.
    public static let formats: [String] = ["png", "jpeg", "webp"]

    /// The pixel budget for one capture: roughly a 6300x6300 square, or 8000x5000. Larger
    /// than any share card, poster or receipt, and far below where a phone dies allocating
    /// the bitmap. A request past it is `too_large` BEFORE any allocation, which is the
    /// difference between an error and a crash.
    public static let maxPixels = 40_000_000

    /// Named page boxes in PostScript points (72 per inch).
    public static let pdfPageSizes: [String: (width: Double, height: Double)] = [
        "a3": (841.89, 1190.55),
        "a4": (595.28, 841.89),
        "a5": (419.53, 595.28),
        "letter": (612, 792),
        "legal": (612, 1008),
        "tabloid": (792, 1224),
    ]

    /// Fold an author's format spelling; nil is `unsupported_format`.
    public static func foldFormat(_ name: String?) -> String? {
        var key = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if key.hasPrefix(".") { key.removeFirst() }
        if key.isEmpty { return "png" }
        if key == "jpg" { return "jpeg" }
        return formats.contains(key) ? key : nil
    }

    /// Clamp a quality argument into 0...1, reading a value above 1 as a percent because
    /// everyone confuses the two exactly once.
    public static func quality(_ value: Any?, fallback: Double = 0.9) -> Double {
        guard let value else { return fallback }
        var raw: Double
        if let number = value as? NSNumber { raw = number.doubleValue }
        else if let text = value as? String { guard let parsed = Double(text) else { return fallback }; raw = parsed }
        else { return fallback }
        guard raw.isFinite else { return fallback }
        if raw > 1, raw <= 100 { raw /= 100 }
        return Swift.min(Swift.max(raw, 0), 1)
    }

    public enum ScaleResult {
        case value(Double)
        case refused(String)
    }

    /// Resolve `scale`. A number is a multiplier; `device` (and an omitted value) is the
    /// surface's own pixel ratio. Zero, negative and non-numeric are refusals rather than a
    /// silent 1.
    public static func resolveScale(_ scale: Any?, deviceScale: Double) -> ScaleResult {
        let device = (deviceScale.isFinite && deviceScale > 0) ? deviceScale : 1
        if scale == nil { return .value(device) }
        if let text = scale as? String {
            if text.isEmpty || text == "device" { return .value(device) }
            guard let parsed = Double(text) else { return .refused("invalid_scale") }
            return validate(parsed)
        }
        guard let number = scale as? NSNumber else { return .refused("invalid_scale") }
        return validate(number.doubleValue)
    }

    private static func validate(_ raw: Double) -> ScaleResult {
        guard raw.isFinite, raw > 0, raw <= 16 else { return .refused("invalid_scale") }
        return .value(raw)
    }

    public enum SizeResult {
        case value(width: Int, height: Int)
        case refused(String)
    }

    private static func round(_ value: Double) -> Int {
        let scaled = Int(abs(value).rounded())
        return value < 0 ? -scaled : scaled
    }

    /// Point size times scale, rounded to whole pixels per axis, checked against the budget.
    public static func pixelSize(_ pointWidth: Double, _ pointHeight: Double, _ scale: Double,
                                 maxPixels budget: Int = maxPixels) -> SizeResult {
        guard pointWidth.isFinite, pointHeight.isFinite, scale.isFinite else { return .refused("invalid_size") }
        guard pointWidth > 0, pointHeight > 0, scale > 0 else { return .refused("invalid_size") }
        let width = round(pointWidth * scale)
        let height = round(pointHeight * scale)
        guard width >= 1, height >= 1 else { return .refused("invalid_size") }
        guard width * height <= budget else { return .refused("too_large") }
        return .value(width: width, height: height)
    }

    public enum PageResult {
        case value(width: Double, height: Double)
        case refused(String)
    }

    /// A name from the table, `name/landscape` to swap the axes, or an explicit
    /// `{ width, height }` in points. An unknown name is a refusal, not a fallback to A4: a
    /// document silently printed at the wrong size is worse than one that did not print.
    public static func pageSize(_ spec: Any?) -> PageResult {
        guard let spec else {
            let box = pdfPageSizes["a4"]!
            return .value(width: box.width, height: box.height)
        }
        if let box = spec as? [String: Any] {
            guard let width = (box["width"] as? NSNumber)?.doubleValue,
                  let height = (box["height"] as? NSNumber)?.doubleValue,
                  width > 0, height > 0 else { return .refused("invalid_page_size") }
            return .value(width: width, height: height)
        }
        let text = String(describing: spec).trimmingCharacters(in: .whitespaces).lowercased()
        if text.isEmpty {
            let box = pdfPageSizes["a4"]!
            return .value(width: box.width, height: box.height)
        }
        let landscape = text.hasSuffix("/landscape") || text.hasSuffix(" landscape")
        var name = text
        for suffix in ["/landscape", " landscape"] where name.hasSuffix(suffix) {
            name = String(name.dropLast(suffix.count))
        }
        guard let found = pdfPageSizes[name.trimmingCharacters(in: .whitespaces)] else {
            return .refused("invalid_page_size")
        }
        return landscape
            ? .value(width: found.height, height: found.width)
            : .value(width: found.width, height: found.height)
    }

    public struct Margins {
        public let top: Double
        public let right: Double
        public let bottom: Double
        public let left: Double
    }

    /// A bare number is all four sides; an object fills the sides it names and defaults the
    /// rest to the same 36 points (half an inch) an omission gets.
    public static func margins(_ spec: Any?, fallback: Double = 36) -> Margins {
        func of(_ value: Any?, _ or: Double) -> Double {
            var raw: Double
            if let number = value as? NSNumber { raw = number.doubleValue }
            else if let text = value as? String, let parsed = Double(text) { raw = parsed }
            else { return or }
            return (raw.isFinite && raw >= 0) ? raw : or
        }
        if spec is NSNumber || spec is String {
            let all = of(spec, fallback)
            return Margins(top: all, right: all, bottom: all, left: all)
        }
        if let box = spec as? [String: Any] {
            return Margins(top: of(box["top"], fallback), right: of(box["right"], fallback),
                           bottom: of(box["bottom"], fallback), left: of(box["left"], fallback))
        }
        return Margins(top: fallback, right: fallback, bottom: fallback, left: fallback)
    }
}
