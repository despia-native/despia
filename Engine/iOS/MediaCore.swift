//
//  MediaCore.swift
//  DespiaScript
//
//  The shared `media` module core: the pick plan, EXIF orientation normalisation, the
//  manipulate op-chain resolver, the decode hint that keeps a 12 MP photo from ever being
//  allocated whole, and the format/quality fold with its per-platform support table. The law
//  is the corpus, OpenSource/Conformance/media/ (parity/F04-media.md). The twin of :core
//  MediaCore.kt and of the web @despia-native/kernel media-core.ts.
//
//  WHY THESE PARTS AND NOT THE PIXELS. Opening a picker, decoding a JPEG and running a
//  CIFilter chain are entirely platform work (PHPickerViewController, Core Image,
//  AVAssetImageGenerator) and belong in the module facet. What cannot live there is the
//  ARITHMETIC AND THE ORDER:
//
//   * crop-then-resize is not resize-then-crop, and an avatar that comes out 401 px on one
//     platform and 400 on another is a bug the author cannot fix from markup;
//   * a phone photo carries its rotation in EXIF, so a crop rect computed against the stored
//     pixels lands somewhere else than the one the user drew on screen - the "sideways on one
//     platform" bug, which is an ORDERING law, not a decoder setting;
//   * the decode hint is the difference between an error and an OOM kill: decode at the size
//     you need, never full then downscale.
//
//  Everything here is pure arithmetic over plain values. No I/O, no platform types.
//

import Foundation

public enum MediaCore {

    /// The raster formats `manipulate` can be asked to write.
    public static let formats: [String] = ["jpeg", "png", "webp", "heic"]

    /// The resize fits. Deliberately three: the fourth spelling everyone invents ("inside",
    /// "outside", "scale-down") is `contain` with a clamp the caller can do itself.
    public static let resizeFits: [String] = ["contain", "cover", "fill"]

    /// The pixel budget for one manipulation step, and the one number in this file that is a
    /// POLICY rather than arithmetic. It bounds what a caller may ASK FOR - a 20000x20000
    /// render is refused before anything is allocated - and deliberately does NOT bound what
    /// the camera produced: a 48 MP ProRAW photo is over the budget the moment it is opened,
    /// and a framework that refused to rotate it would be refusing the device's own output.
    /// So the check is on GROWTH: a step is `too_large` only when it pushes past the budget
    /// AND makes the image bigger than it already was.
    public static let maxPixels = 40_000_000

    /// The ceiling on one multi-pick. A picker that hands back 400 assets has handed back an
    /// out-of-memory bug; 0 from the caller means "the system's own maximum".
    public static let pickMax = 64

    public static let pickTypes: [String] = ["image", "video", "any"]
    public static let pickSources: [String] = ["library", "camera"]

    /// Whether a renderer can ENCODE a format. `.device` means the hardware decides at runtime
    /// (HEIC on an older iPhone) and the facet must ask.
    public enum Encodability: String, Equatable {
        case always
        case device
        case never
    }

    /// A format that cannot be written falls back to jpeg - lossy but universal - and the
    /// resolve says so rather than lying about the file it produced.
    public static let formatSupport: [String: [String: Encodability]] = [
        "ios":     ["jpeg": .always, "png": .always, "webp": .never,  "heic": .device],
        "android": ["jpeg": .always, "png": .always, "webp": .always, "heic": .device],
        "web":     ["jpeg": .always, "png": .always, "webp": .always, "heic": .never],
    ]

    public struct Box: Equatable {
        public var width: Int
        public var height: Int
        public init(width: Int, height: Int) { self.width = width; self.height = height }
    }

    public struct Rect: Equatable {
        public var x: Int
        public var y: Int
        public var width: Int
        public var height: Int
    }

    /// One resolved step of an op chain: what the image measures after it, and - for the ops
    /// that select a region (crop, and the centre-crop half of `cover`) - the exact rect, in
    /// the coordinate space of the image AS IT WAS WHEN THE STEP RAN.
    public struct Step: Equatable {
        public var op: String
        public var width: Int
        public var height: Int
        public var rect: Rect?
    }

    public enum OpsResult: Equatable {
        case value(width: Int, height: Int, steps: [Step])
        /// `error` is `invalid_ops` or `too_large`; `at` is the index of the offending op, -1
        /// when the SOURCE itself was unusable.
        case refused(error: String, at: Int)
    }

    // MARK: - small numeric helpers

    /// Round half away from zero, then floor at one pixel. Every dimension in this file goes
    /// through it so three renderers cannot disagree about 400.5.
    private static func px(_ value: Double) -> Int {
        let rounded = value < 0 ? -(-value + 0.5).rounded(.down) : (value + 0.5).rounded(.down)
        return Swift.max(1, Int(rounded))
    }

    /// JS `Math.round` exactly - floor(x + 0.5), ties toward positive infinity. Distinct from
    /// `px` on purpose: crop origins may be negative and their tie direction is pinned.
    private static func jsRound(_ value: Double) -> Double { (value + 0.5).rounded(.down) }

    private static func finite(_ value: Any?) -> Double? {
        guard let value else { return nil }
        var raw: Double
        if let text = value as? String {
            if text.isEmpty { return nil }
            guard let parsed = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
            raw = parsed
        } else if let number = value as? NSNumber {
            raw = number.doubleValue
        } else {
            return nil
        }
        return raw.isFinite ? raw : nil
    }

    private static func positive(_ value: Any?) -> Double? {
        guard let raw = finite(value), raw > 0 else { return nil }
        return raw
    }

    // MARK: - the format / quality fold

    /// Fold an author's format spelling; nil is `unsupported_format`. An omitted format means
    /// "keep whatever the source was", which the facet answers, so it folds to nil too - the
    /// caller distinguishes the two by whether it passed anything.
    public static func foldFormat(_ name: String?) -> String? {
        var key = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if key.hasPrefix(".") { key.removeFirst() }
        if key.isEmpty { return nil }
        if key == "jpg" { return "jpeg" }
        if key == "heif" { return "heic" }
        return formats.contains(key) ? key : nil
    }

    /// Clamp a quality argument into 0...1, reading a value above 1 as a percent because
    /// everyone confuses the two exactly once. Identical semantics to the capture fold.
    public static func quality(_ value: Any?, fallback: Double = 0.9) -> Double {
        guard let value else { return fallback }
        if let text = value as? String, text.isEmpty { return fallback }
        guard var raw = finite(value) else { return fallback }
        if raw > 1, raw <= 100 { raw /= 100 }
        return Swift.min(Swift.max(raw, 0), 1)
    }

    /// png is lossless, so a quality argument against it is meaningless and is dropped rather
    /// than silently changing nothing - a caller reading the resolve sees the truth.
    public static func formatLossless(_ format: String) -> Bool { format == "png" }

    public struct FormatPlan: Equatable {
        public var format: String
        public var requested: String
        public var fellBack: Bool
        public var lossless: Bool
    }

    public enum FormatPlanResult: Equatable {
        case plan(FormatPlan)
        case refused(String)
    }

    /// Resolve the format a facet will actually write.
    ///
    /// `deviceCanEncode` answers the `.device` rows: the facet asks its platform once (does
    /// this iPhone encode HEIC?) and passes the answer in. An unknown platform is treated as
    /// the web row, which is the conservative one.
    public static func formatPlan(_ requested: String?,
                                  platform: String,
                                  deviceCanEncode: Bool = false,
                                  fallback: String = "jpeg") -> FormatPlanResult {
        guard let format = foldFormat(requested) else { return .refused("unsupported_format") }
        let table = formatSupport[platform] ?? formatSupport["web"]!
        let support = table[format]
        let writable = support == .always || (support == .device && deviceCanEncode)
        if writable {
            return .plan(FormatPlan(format: format, requested: format,
                                    fellBack: false, lossless: formatLossless(format)))
        }
        return .plan(FormatPlan(format: fallback, requested: format,
                                fellBack: true, lossless: formatLossless(fallback)))
    }

    // MARK: - EXIF orientation

    /// The transform that turns STORED pixels into what the photographer saw. `rotate` is
    /// clockwise degrees; `mirrored` is a horizontal flip applied BEFORE the rotation; `swaps`
    /// says whether the two axes trade places, which is the whole reason a portrait photo
    /// reports 4032x3024.
    public struct ExifTransform: Equatable {
        public var rotate: Int
        public var mirrored: Bool
        public var swaps: Bool
    }

    /// The eight EXIF orientation values.
    ///
    /// This table is the fix for the classic bug: one platform's decoder applies the tag and
    /// another hands back raw pixels, so the same crop rect selects a different region. The
    /// law that makes them agree is not "everyone applies the tag" - it is that the tag is
    /// applied FIRST and the op chain then runs against normalised pixels on every renderer.
    public static let exifTransforms: [Int: ExifTransform] = [
        1: ExifTransform(rotate: 0,   mirrored: false, swaps: false),
        2: ExifTransform(rotate: 0,   mirrored: true,  swaps: false),
        3: ExifTransform(rotate: 180, mirrored: false, swaps: false),
        4: ExifTransform(rotate: 180, mirrored: true,  swaps: false),
        5: ExifTransform(rotate: 90,  mirrored: true,  swaps: true),
        6: ExifTransform(rotate: 90,  mirrored: false, swaps: true),
        7: ExifTransform(rotate: 270, mirrored: true,  swaps: true),
        8: ExifTransform(rotate: 270, mirrored: false, swaps: true),
    ]

    public struct Orientation: Equatable {
        public var orientation: Int
        public var width: Int
        public var height: Int
        public var rotate: Int
        public var mirrored: Bool
        public var swaps: Bool
    }

    /// Normalise stored dimensions by an EXIF orientation tag. An absent, zero or out-of-range
    /// tag is orientation 1 (the identity) rather than a refusal: a file with no EXIF block is
    /// ordinary, not broken.
    public static func exifNormalise(width: Any?, height: Any?, orientation: Any?) -> Orientation {
        let w = positive(width) ?? 1
        let h = positive(height) ?? 1
        let raw = finite(orientation)
        var tag = 1
        if let raw, raw == raw.rounded(.down), raw >= 1, raw <= 8 { tag = Int(raw) }
        let transform = exifTransforms[tag]!
        return Orientation(orientation: tag,
                           width: transform.swaps ? px(h) : px(w),
                           height: transform.swaps ? px(w) : px(h),
                           rotate: transform.rotate,
                           mirrored: transform.mirrored,
                           swaps: transform.swaps)
    }

    // MARK: - the op chain

    private struct StepResult {
        var width: Int
        var height: Int
        var rect: Rect?
    }

    private static func opEntry(_ op: Any?) -> (name: String, spec: Any?)? {
        guard let map = op as? [String: Any] else { return nil }
        let keys = map.keys.filter { !$0.hasPrefix("_") }
        // Exactly one verb per entry. Two keys is an ambiguity about ORDER, and order is the
        // one thing this resolver exists to make unambiguous.
        guard keys.count == 1, let name = keys.first else { return nil }
        return (name, map[name])
    }

    private static func resizeStep(_ box: Box, _ spec: Any?) -> StepResult? {
        guard let s = spec as? [String: Any] else { return nil }
        let tw = positive(s["width"])
        let th = positive(s["height"])
        if tw == nil, th == nil { return nil }

        let fit = ((s["fit"] as? String) ?? "contain")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard resizeFits.contains(fit) else { return nil }

        // One dimension given: the aspect ratio decides the other, whatever `fit` says. There
        // is no box to fit inside, so `cover` and `contain` cannot differ.
        guard let targetW = tw else {
            let targetH = th!
            return StepResult(width: px(Double(box.width) * (targetH / Double(box.height))),
                              height: px(targetH), rect: nil)
        }
        guard let targetH = th else {
            return StepResult(width: px(targetW),
                              height: px(Double(box.height) * (targetW / Double(box.width))),
                              rect: nil)
        }

        if fit == "fill" { return StepResult(width: px(targetW), height: px(targetH), rect: nil) }

        let scale = fit == "cover"
            ? Swift.max(targetW / Double(box.width), targetH / Double(box.height))
            : Swift.min(targetW / Double(box.width), targetH / Double(box.height))
        let scaledW = px(Double(box.width) * scale)
        let scaledH = px(Double(box.height) * scale)
        if fit == "contain" { return StepResult(width: scaledW, height: scaledH, rect: nil) }

        // cover: fill the box, then take the CENTRE of the overflow. Floor the offsets so a one
        // pixel remainder always lands on the bottom/right, identically on three renderers.
        let outW = Swift.min(px(targetW), scaledW)
        let outH = Swift.min(px(targetH), scaledH)
        return StepResult(width: outW, height: outH,
                          rect: Rect(x: (scaledW - outW) / 2, y: (scaledH - outH) / 2,
                                     width: outW, height: outH))
    }

    private static func cropStep(_ box: Box, _ spec: Any?) -> StepResult? {
        guard let s = spec as? [String: Any],
              let w = positive(s["width"]),
              let h = positive(s["height"]) else { return nil }
        let x = finite(s["x"]) ?? 0
        let y = finite(s["y"]) ?? 0

        // A crop that hangs off the edge is INTERSECTED with the image, not refused: the caller
        // drew a rect on a screen, and a two pixel overhang from a rounding difference must not
        // lose the whole operation. A crop with no overlap at all IS refused - it selects
        // nothing, and silently handing back a 1x1 image is the worse answer.
        let x0 = Int(Swift.min(Swift.max(jsRound(x), 0), Double(box.width)))
        let y0 = Int(Swift.min(Swift.max(jsRound(y), 0), Double(box.height)))
        let x1 = Int(Swift.min(Swift.max(jsRound(x + w), 0), Double(box.width)))
        let y1 = Int(Swift.min(Swift.max(jsRound(y + h), 0), Double(box.height)))
        let cw = x1 - x0
        let ch = y1 - y0
        if cw < 1 || ch < 1 { return nil }
        return StepResult(width: cw, height: ch, rect: Rect(x: x0, y: y0, width: cw, height: ch))
    }

    private static func rotateStep(_ box: Box, _ spec: Any?) -> StepResult? {
        guard let deg = finite(spec) else { return nil }
        let normal = ((Int(jsRound(deg)) % 360) + 360) % 360
        // Only right angles. An arbitrary angle changes the canvas shape and needs a fill
        // colour and a resampling policy; refusing is honest, and `manipulate` is not an editor.
        if normal % 90 != 0 { return nil }
        return normal == 90 || normal == 270
            ? StepResult(width: box.height, height: box.width, rect: nil)
            : StepResult(width: box.width, height: box.height, rect: nil)
    }

    private static func flipStep(_ box: Box, _ spec: Any?) -> StepResult? {
        let word = ((spec as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let known = word == "h" || word == "v" || word == "horizontal" || word == "vertical"
        return known ? StepResult(width: box.width, height: box.height, rect: nil) : nil
    }

    private static func blurStep(_ box: Box, _ spec: Any?) -> StepResult? {
        guard let radius = finite(spec), radius >= 0, radius <= 100 else { return nil }
        return StepResult(width: box.width, height: box.height, rect: nil)
    }

    private static func runStep(_ name: String, _ box: Box, _ spec: Any?) -> StepResult? {
        switch name {
        case "resize": return resizeStep(box, spec)
        case "crop":   return cropStep(box, spec)
        case "rotate": return rotateStep(box, spec)
        case "flip":   return flipStep(box, spec)
        case "blur":   return blurStep(box, spec)
        default:       return nil
        }
    }

    /// Run an op list over a source box and report the geometry at every step.
    ///
    /// The ops are applied IN ORDER, which is the contract: `[crop, resize]` and
    /// `[resize, crop]` are different pictures and both must be exact. The budget is checked
    /// after each step, so a chain that would blow up in the middle is refused before the facet
    /// allocates anything.
    public static func resolveOps(source: Box, ops: Any?, maxPixels: Int = MediaCore.maxPixels) -> OpsResult {
        guard let sw = positive(source.width), let sh = positive(source.height) else {
            return .refused(error: "invalid_ops", at: -1)
        }
        var list: [Any] = []
        if let ops {
            guard let array = ops as? [Any] else { return .refused(error: "invalid_ops", at: -1) }
            list = array
        }

        var box = Box(width: px(sw), height: px(sh))
        var steps: [Step] = []

        for index in list.indices {
            guard let entry = opEntry(list[index]) else { return .refused(error: "invalid_ops", at: index) }
            guard let next = runStep(entry.name, box, entry.spec) else {
                return .refused(error: "invalid_ops", at: index)
            }
            let after = next.width * next.height
            if after > maxPixels, after > box.width * box.height {
                return .refused(error: "too_large", at: index)
            }
            box = Box(width: next.width, height: next.height)
            steps.append(Step(op: entry.name, width: box.width, height: box.height, rect: next.rect))
        }

        return .value(width: box.width, height: box.height, steps: steps)
    }

    // MARK: - the decode hint

    /// `sampleSize` is the power-of-two subsampling factor; 1 means "decode whole". Android
    /// passes it straight to BitmapFactory.Options.inSampleSize; iOS and the web use
    /// `width`/`height` as the downsample target (kCGImageSourceThumbnailMaxPixelSize).
    public struct DecodeHint: Equatable {
        public var sampleSize: Int
        public var width: Int
        public var height: Int
    }

    /// The largest the source needs to be decoded at for this chain to be exact.
    ///
    /// A 12 MP photo resized to 400 px wide never needs 12 MP in memory: decoding at
    /// sampleSize 8 gives 500x375, which still has more pixels than the output asks for, and
    /// costs 0.2 MB instead of 48 MB.
    ///
    /// The factor is taken at the FIRST resize, relative to the box that reaches it: a crop
    /// before the resize means the resize sees fewer pixels, so MORE of the source is needed
    /// per output pixel, and the hint gets conservatively larger. A chain with no resize needs
    /// the source whole - unless the source alone breaks the budget, in which case the hint
    /// subsamples until it fits, because refusing to open a photo the camera produced is not an
    /// option a framework has.
    public static func decodeHint(source: Box, ops: Any?, maxPixels: Int = MediaCore.maxPixels) -> DecodeHint {
        let sw = px(positive(source.width) ?? 1)
        let sh = px(positive(source.height) ?? 1)
        let list = (ops as? [Any]) ?? []

        var box = Box(width: sw, height: sh)
        var needed = 1.0
        for op in list {
            guard let entry = opEntry(op) else { break }
            if entry.name == "resize" {
                guard let step = resizeStep(box, entry.spec) else { break }
                // `cover` crops after scaling, so the SCALED box is what the decode must reach.
                let scaledW = step.rect == nil ? step.width : Swift.max(step.width, step.rect!.width)
                let scaledH = step.rect == nil ? step.height : Swift.max(step.height, step.rect!.height)
                needed = Swift.max(Double(scaledW) / Double(box.width), Double(scaledH) / Double(box.height))
                break
            }
            guard let step = runStep(entry.name, box, entry.spec) else { break }
            box = Box(width: step.width, height: step.height)
        }

        var sampleSize = 1
        if needed < 1 {
            let wantW = Int((Double(sw) * needed).rounded(.up))
            let wantH = Int((Double(sh) * needed).rounded(.up))
            while sampleSize < 32, sw / (sampleSize * 2) >= wantW, sh / (sampleSize * 2) >= wantH {
                sampleSize *= 2
            }
        }
        // Whatever the chain asked for, never hand back a decode that breaks the budget.
        while sampleSize < 32, ceilDiv(sw, sampleSize) * ceilDiv(sh, sampleSize) > maxPixels {
            sampleSize *= 2
        }
        return DecodeHint(sampleSize: sampleSize,
                          width: ceilDiv(sw, sampleSize),
                          height: ceilDiv(sh, sampleSize))
    }

    private static func ceilDiv(_ value: Int, _ divisor: Int) -> Int { (value + divisor - 1) / divisor }

    // MARK: - the pick plan

    public struct PickPlan: Equatable {
        public var type: String
        public var source: String
        public var limit: Int
        public var multiple: Bool
        public var ordered: Bool
        /// `true` when the plan can run on the PERMISSION-FREE system picker. This is the whole
        /// privacy posture in one boolean: library picks never ask, camera picks do.
        public var permissionFree: Bool
    }

    public enum PickPlanResult: Equatable {
        case plan(PickPlan)
        case refused(String)
    }

    /// Fold pick arguments into the plan a facet executes.
    ///
    /// The rules exist because every one of them is a shape a caller gets wrong:
    ///  - `multiple: false` pins the limit to 1 whatever `limit` says;
    ///  - a `limit` above 1 IMPLIES multiple, because passing one without the other is what a
    ///    caller means and refusing it teaches nothing;
    ///  - `limit: 0` means "the system's own maximum", which is not the same as one;
    ///  - the camera returns one shot per presentation, so `source: "camera"` is always limit 1;
    ///  - `ordered` is only meaningful for a multi-pick and is folded off otherwise, so a facet
    ///    never has to decide what an ordered single selection means.
    public static func pickPlan(_ args: [String: Any]?) -> PickPlanResult {
        let a = args ?? [:]
        let typeRaw = text(a["type"], fallback: "any").lowercased()
        let type = typeRaw.isEmpty ? "any" : (typeRaw == "photo" ? "image" : typeRaw)
        guard pickTypes.contains(type) else { return .refused("unsupported_format") }

        let sourceRaw = text(a["source"], fallback: "library").lowercased()
        let source = sourceRaw.isEmpty ? "library" : sourceRaw
        guard pickSources.contains(source) else { return .refused("invalid_source") }

        let askedLimit = finite(a["limit"])
        // An explicit `multiple: false` always wins: a caller who wrote it means it. A limit
        // above one with no `multiple` at all IMPLIES it, because that is what the caller means
        // and refusing the shorthand teaches nothing.
        let impliedMultiple = a["multiple"] == nil && (askedLimit ?? 0) > 1
        var multiple = isTrue(a["multiple"]) || impliedMultiple
        var limit: Int
        if !multiple {
            limit = 1
        } else if let askedLimit, askedLimit > 0 {
            limit = Swift.min(Int(askedLimit.rounded(.down)), pickMax)
            if limit == 1 { multiple = false }
        } else {
            limit = 0
        }
        if source == "camera" { multiple = false; limit = 1 }

        return .plan(PickPlan(type: type, source: source, limit: limit, multiple: multiple,
                              ordered: multiple && isTrue(a["ordered"]),
                              permissionFree: source == "library"))
    }

    /// A strict `=== true`: only a real boolean counts. Numeric NSNumber bridging is exact
    /// in Swift, so a `1` or a `"true"` never silently turns a single pick into a multi-pick.
    private static func isTrue(_ value: Any?) -> Bool {
        if let flag = value as? Bool { return flag }
        return false
    }

    /// `String(value ?? fallback)` with the JS fold: an absent value becomes the fallback, and
    /// anything else is described rather than refused, so an unknown word reaches the
    /// vocabulary check and is named in the refusal.
    private static func text(_ value: Any?, fallback: String) -> String {
        guard let value else { return fallback }
        if let string = value as? String {
            return string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The MIME filter a facet hands its picker. `any` is an empty list, which every picker
    /// reads as "no filter" - a list of every type it might see would be wrong the first time
    /// a new codec shipped.
    public static func pickMimeTypes(_ type: String) -> [String] {
        if type == "image" { return ["image/*"] }
        if type == "video" { return ["video/*"] }
        return []
    }
}
