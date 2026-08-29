//
//  ImageCore.swift — the `<image>` PURE CORE (U05). Everything the three renderers must agree
//  on before a single pixel is drawn: the contentFit x contentPosition geometry solver, the
//  cache-policy ladder (with the legacy binary `cache` folded in), the transition gate, the
//  decode-at-display-size ladder, placeholder classification, the recycling identity, and the
//  blurhash / thumbhash decoders.
//
//  The law is the corpus, `OpenSource/Conformance/image/resolution.json` (parity/U05-image.md);
//  the Kotlin twin is `:core` ImageCore.kt and the web twin is @despia-native/kernel's image-core.ts.
//
//  Everything platform-shaped lives OUTSIDE this file — the network fetch, NSCache, ImageIO,
//  the SwiftUI view. Keeping the DECISION separate from the PLUMBING is what lets one corpus
//  judge three renderers; the Apple-side adapter is StackImage.swift.
//
//  FOUNDATION ONLY, ON PURPOSE. No UIKit, no CoreGraphics, no SwiftUI: this file is meant to sit
//  in `check_swift_parse.rb`'s `engine-kernel` island so Linux can TYPE-CHECK it, not merely
//  parse it, which is the only way a pure core stays honest between mac builds.
//
//  THE TRANSCENDENTALS ARE A KNOWN RISK, NAMED. The two hash decoders quantise a cosine sum into
//  8-bit channels, so a 1-ULP difference in `cos()` could in principle flip a pinned pixel. The
//  Kotlin twin pins StrictMath (fdlibm) for exactly that reason; Darwin's libm is also
//  fdlibm-derived, and the corpus is the check that says so out loud on every record run.
//
//  The decoders are re-implementations of the published BlurHash (Wolt, MIT) and ThumbHash (Evan
//  Wallace, MIT) formats. Nothing is vendored: this is original code reading the same bytes,
//  cross-checked against the reference algorithms and pinned to exact RGBA in the corpus,
//  because a placeholder that differs per platform is worse than no placeholder at all.
//
import Foundation

public enum ImageCore {

    // ------------------------------------------------------------------ vocabularies

    /// The five content modes, `cover` first because it is the default and today's behaviour.
    public static let contentFits: [String] = ["cover", "contain", "fill", "none", "scaleDown"]
    /// The four cache policies. `memoryDisk` is the default; the legacy `cache="none"` folds to `none`.
    public static let cachePolicies: [String] = ["memory", "disk", "memoryDisk", "none"]
    /// Fetch priority. A hero is `high`, an offscreen row is `low`; the queue is per-renderer.
    public static let priorities: [String] = ["low", "normal", "high"]
    /// `crossDissolve` is the default and the only one every target realises natively; the flips
    /// and curls degrade to a cross-dissolve where they cannot.
    public static let transitionEffects: [String] = [
        "none", "crossDissolve", "flipFromLeft", "flipFromRight",
        "flipFromTop", "flipFromBottom", "curlUp", "curlDown",
    ]

    public static let contentFitDefault = "cover"
    public static let contentPositionDefault = "center"
    public static let cachePolicyDefault = "memoryDisk"
    public static let transitionDurationDefault = 200

    // ------------------------------------------------------------------ value types

    public struct Size: Equatable {
        public var width: Double
        public var height: Double
        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }
    }

    public struct Anchor: Equatable {
        public var x: Double
        public var y: Double
        public init(_ x: Double, _ y: Double) {
            self.x = x
            self.y = y
        }
    }

    public struct Rect: Equatable {
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double
        /// The factor the source was multiplied by. 0 for `fill`, whose aspect is not preserved.
        public var scale: Double
        public init(x: Double, y: Double, width: Double, height: Double, scale: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
            self.scale = scale
        }
    }

    /// The named anchors, as fractions of the free space. Twin of the TS/Kotlin tables.
    public static let positionAnchors: [String: Anchor] = [
        "center": Anchor(0.5, 0.5),
        "top": Anchor(0.5, 0.0),
        "bottom": Anchor(0.5, 1.0),
        "leading": Anchor(0.0, 0.5),
        "left": Anchor(0.0, 0.5),
        "trailing": Anchor(1.0, 0.5),
        "right": Anchor(1.0, 0.5),
        "topLeading": Anchor(0.0, 0.0),
        "topTrailing": Anchor(1.0, 0.0),
        "bottomLeading": Anchor(0.0, 1.0),
        "bottomTrailing": Anchor(1.0, 1.0),
    ]

    // ------------------------------------------------------------------ numbers

    private static func clamp01(_ value: Double) -> Double {
        return value < 0.0 ? 0.0 : (value > 1.0 ? 1.0 : value)
    }

    /// `Math.round` in all three languages is `floor(x + 0.5)`, NOT Swift's default
    /// `.toNearestOrAwayFromZero`. The two disagree only on negatives, which sizes never are —
    /// but a twin that "only differs where it cannot happen" is how a divergence gets planted.
    private static func roundHalfUp(_ value: Double) -> Double {
        return (value + 0.5).rounded(.down)
    }

    /// Truncate toward zero into an Int without ever trapping. Every caller's input is bounded
    /// by construction; the guard exists so a future caller's is not silently a crash.
    private static func truncatedInt(_ value: Double) -> Int {
        if !value.isFinite { return 0 }
        if value >= 2_147_483_647.0 { return 2_147_483_647 }
        if value <= -2_147_483_648.0 { return -2_147_483_648 }
        return Int(value)
    }

    // ------------------------------------------------------------------ contentFit / position

    /// Unknown word folds to `cover` — an image is never not drawn because a token was misspelled.
    public static func resolveContentFit(_ fit: String?) -> String {
        let word = (fit ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return contentFits.contains(word) ? word : contentFitDefault
    }

    private static func positionScalar(_ token: String) -> Double? {
        let text = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        let value: Double?
        if text.hasSuffix("%") {
            value = Double(String(text.dropLast())).map { $0 / 100.0 }
        } else {
            value = Double(text)
        }
        guard let resolved = value, resolved.isFinite else { return nil }
        return clamp01(resolved)
    }

    /// `contentPosition` → the anchor fractions the drawn rect is placed at. A named anchor, or
    /// an `x y` pair in percentages or 0…1 fractions. Anything unparseable is `center`, because
    /// an off-screen image is a worse failure than a mis-anchored one.
    public static func resolveContentPosition(_ position: String?) -> Anchor {
        let text = (position ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return Anchor(0.5, 0.5) }
        if let anchor = positionAnchors[text] { return anchor }
        let parts = text.replacingOccurrences(of: ",", with: " ")
            .split(separator: " ").map(String.init).filter { !$0.isEmpty }
        if parts.count == 1 {
            guard let only = positionScalar(parts[0]) else { return Anchor(0.5, 0.5) }
            return Anchor(only, 0.5)
        }
        if parts.count >= 2 {
            guard let x = positionScalar(parts[0]), let y = positionScalar(parts[1]) else {
                return Anchor(0.5, 0.5)
            }
            return Anchor(x, y)
        }
        return Anchor(0.5, 0.5)
    }

    /// THE GEOMETRY SOLVER. Given the source and the container, what rect is drawn?
    ///
    /// A negative x/y is the crop offset `cover` needs — the same sign convention CSS
    /// `object-position` uses, so the web mapping is an identity and the two natives translate
    /// one subtraction. Any non-positive dimension yields the empty rect rather than a NaN that
    /// propagates into a layout pass.
    public static func solveImageRect(
        fit: String?, position: String?, source: Size, container: Size
    ) -> Rect {
        let mode = resolveContentFit(fit)
        let sw = source.width, sh = source.height
        let cw = container.width, ch = container.height
        guard sw > 0.0, sh > 0.0, cw > 0.0, ch > 0.0 else {
            return Rect(x: 0, y: 0, width: 0, height: 0, scale: 0)
        }
        let drawnWidth: Double
        let drawnHeight: Double
        if mode == "fill" {
            drawnWidth = cw
            drawnHeight = ch
        } else {
            let factor: Double
            switch mode {
            case "cover": factor = max(cw / sw, ch / sh)
            case "contain": factor = min(cw / sw, ch / sh)
            case "none": factor = 1.0
            default: factor = min(1.0, min(cw / sw, ch / sh))
            }
            drawnWidth = sw * factor
            drawnHeight = sh * factor
        }
        let anchor = resolveContentPosition(position)
        return Rect(
            x: (cw - drawnWidth) * anchor.x,
            y: (ch - drawnHeight) * anchor.y,
            width: drawnWidth,
            height: drawnHeight,
            // `fill` does not preserve aspect, so a single scale factor is meaningless: 0 says so.
            scale: mode == "fill" ? 0.0 : drawnWidth / sw
        )
    }

    // ------------------------------------------------------------------ cache

    public struct CacheResolution: Equatable {
        public var policy: String
        public var memory: Bool
        public var disk: Bool
        /// `none` means REVALIDATE — the bytes still ride the content plane, never read back.
        public var revalidate: Bool
        public init(policy: String, memory: Bool, disk: Bool, revalidate: Bool) {
            self.policy = policy
            self.memory = memory
            self.disk = disk
            self.revalidate = revalidate
        }
    }

    /// The cache-policy ladder. `cachePolicy` wins when it names one of the four words; otherwise
    /// the legacy binary `cache` decides, so every app written against `cache="none"` keeps its
    /// behaviour byte for byte. An unrecognised `cachePolicy` falls through to the legacy read
    /// rather than disabling caching: a typo must never turn a feed into a download loop.
    public static func resolveCachePolicy(_ cachePolicy: String?, cache: String? = nil) -> CacheResolution {
        let word = (cachePolicy ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let policy: String
        if cachePolicies.contains(word) {
            policy = word
        } else if (cache ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == "none" {
            policy = "none"
        } else {
            policy = cachePolicyDefault
        }
        return CacheResolution(
            policy: policy,
            memory: policy == "memory" || policy == "memoryDisk",
            disk: policy == "disk" || policy == "memoryDisk",
            revalidate: policy == "none"
        )
    }

    /// What `on:load` reports, given where the bytes were actually found.
    public static func cacheTypeFor(_ policy: CacheResolution, inMemory: Bool, onDisk: Bool) -> String {
        if policy.memory && inMemory { return "memory" }
        if policy.disk && onDisk { return "disk" }
        return "none"
    }

    // ------------------------------------------------------------------ transition

    public struct Transition: Equatable {
        public var duration: Int
        public var effect: String
        public init(duration: Int, effect: String) {
            self.duration = duration
            self.effect = effect
        }
    }

    /// Zero duration and `none` are the same statement; keep them from disagreeing.
    private static func normalise(_ duration: Int, _ effect: String) -> Transition {
        if duration == 0 || effect == "none" { return Transition(duration: 0, effect: "none") }
        return Transition(duration: duration, effect: effect)
    }

    /// `transition` accepts a number of ms, a numeric string, an effect word, or a
    /// `{duration, effect}` map. The dictionary overload is the one native callers reach for;
    /// the `Any?` form exists so the corpus runner can hand a decoded JSON value straight in.
    public static func resolveTransition(duration: Double?, effect: String?) -> Transition {
        let ms: Int
        if let value = duration, value.isFinite {
            ms = max(0, truncatedInt(value))
        } else {
            ms = transitionDurationDefault
        }
        let word = (effect ?? "crossDissolve").trimmingCharacters(in: .whitespacesAndNewlines)
        return normalise(ms, transitionEffects.contains(word) ? word : "crossDissolve")
    }

    public static func resolveTransition(_ spec: Any?) -> Transition {
        guard let spec = spec else {
            return Transition(duration: transitionDurationDefault, effect: "crossDissolve")
        }
        if let map = spec as? [String: Any] {
            let raw = map["duration"]
            let duration: Double? = numberValue(raw)
            let word = (map["effect"] as? String) ?? "crossDissolve"
            return resolveTransition(duration: duration, effect: word)
        }
        if let number = numberValue(spec), !(spec is String) {
            if !number.isFinite {
                return Transition(duration: transitionDurationDefault, effect: "crossDissolve")
            }
            return normalise(max(0, truncatedInt(number)), "crossDissolve")
        }
        let text = stringValue(spec).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return Transition(duration: transitionDurationDefault, effect: "crossDissolve")
        }
        if transitionEffects.contains(text) {
            return normalise(text == "none" ? 0 : transitionDurationDefault, text)
        }
        if let numeric = Double(text), numeric.isFinite {
            return normalise(max(0, truncatedInt(numeric)), "crossDissolve")
        }
        return Transition(duration: transitionDurationDefault, effect: "crossDissolve")
    }

    /// Numbers arrive from JSON as `Double`, `Int` or `NSNumber` depending on the decoder. A
    /// `Bool` is deliberately NOT a number here — `true` is not a 1 ms transition — and that is
    /// the Kotlin `is Number` / TS `typeof === "number"` rule spelled for Foundation.
    ///
    /// `objCType` IS THE ONLY RELIABLE DISCRIMINATOR. `value is Bool` answers TRUE for an
    /// NSNumber holding 0 or 1 on both Apple and corelibs Foundation, so the obvious spelling
    /// silently turns `{duration: 0}` into "no duration named" and the transition comes back at
    /// the 200 ms default. Boolean NSNumbers report `c`; every numeric one reports something else.
    private static func numberValue(_ any: Any?) -> Double? {
        guard let any = any else { return nil }
        if let number = any as? NSNumber {
            if String(cString: number.objCType) == "c" { return nil }
            return number.doubleValue
        }
        if let value = any as? Double { return value }
        if let value = any as? Int { return Double(value) }
        if let value = any as? Float { return Double(value) }
        return nil
    }

    private static func stringValue(_ any: Any) -> String {
        if let text = any as? String { return text }
        return String(describing: any)
    }

    /// THE RULE THAT MAKES A FAST APP LOOK FAST: an image already decoded in memory appears in
    /// the same frame, with no fade. Fading in something that was instantly available is the tell
    /// that an app is doing theatre instead of work.
    public static func shouldTransition(_ transition: Transition, cacheType: String) -> Bool {
        return transition.duration > 0 && transition.effect != "none" && cacheType != "memory"
    }

    // ------------------------------------------------------------------ decode at display size

    public struct DecodeSize: Equatable {
        public var width: Int
        public var height: Int
        public var downscaled: Bool
        public init(width: Int, height: Int, downscaled: Bool) {
            self.width = width
            self.height = height
            self.downscaled = downscaled
        }
    }

    /// `allowDownscaling` — decode at display size, the single biggest memory win in list-heavy
    /// apps. A 4000 px hero in a 48 pt avatar decodes at 96 px on a @2x screen: 64 KB instead of
    /// 64 MB. Never upscales, and an unknown display size decodes at source rather than guessing.
    public static func resolveDecodeSize(
        fit: String?, source: Size, display: Size, scale: Double = 1.0, allowDownscaling: Bool = true
    ) -> DecodeSize {
        let sw = source.width, sh = source.height
        guard sw > 0.0, sh > 0.0 else { return DecodeSize(width: 0, height: 0, downscaled: false) }
        let sourceWidth = truncatedInt(roundHalfUp(sw))
        let sourceHeight = truncatedInt(roundHalfUp(sh))
        guard allowDownscaling, display.width > 0.0, display.height > 0.0, scale > 0.0 else {
            return DecodeSize(width: sourceWidth, height: sourceHeight, downscaled: false)
        }
        let targetWidth = display.width * scale
        let targetHeight = display.height * scale
        let required: Double
        switch resolveContentFit(fit) {
        case "cover", "fill": required = max(targetWidth / sw, targetHeight / sh)
        case "none": required = 1.0
        default: required = min(targetWidth / sw, targetHeight / sh)
        }
        let factor = min(1.0, required)
        let width = max(1, truncatedInt(roundHalfUp(sw * factor)))
        let height = max(1, truncatedInt(roundHalfUp(sh * factor)))
        return DecodeSize(width: width, height: height,
                          downscaled: width < sourceWidth || height < sourceHeight)
    }

    // ------------------------------------------------------------------ placeholder

    private static let base83 = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~")
    private static let base64 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

    private static let base83Index: [Character: Int] = {
        var table: [Character: Int] = [:]
        for (index, character) in base83.enumerated() { table[character] = index }
        return table
    }()

    private static let base64Index: [Character: Int] = {
        var table: [Character: Int] = [:]
        for (index, character) in base64.enumerated() { table[character] = index }
        return table
    }()

    /// The semantic colour words `placeholder` may name. Hexes and `rgb(a)()` are read by shape.
    public static let placeholderColorTokens: [String] = [
        "accent", "label", "separator", "white", "black", "clear", "transparent",
        "background", "secondaryLabel", "tertiaryLabel", "systemFill",
    ]

    /// A blurhash carries its own component count, so the length check is exact, not a heuristic.
    public static func isBlurhash(_ text: String) -> Bool {
        let characters = Array(text)
        if characters.count < 6 { return false }
        for character in characters where base83Index[character] == nil { return false }
        guard let flag = base83Index[characters[0]] else { return false }
        let numY = flag / 9 + 1
        let numX = flag % 9 + 1
        return characters.count == 4 + 2 * numX * numY
    }

    /// Byte length of a well-formed base64 payload, or -1. Tells a thumbhash from an asset name.
    public static func base64ByteLength(_ text: String) -> Int {
        let characters = Array(text)
        if characters.count < 8 || characters.count % 4 != 0 { return -1 }
        var body = characters
        while body.last == "=" { body.removeLast() }
        if characters.count - body.count > 2 { return -1 }
        for character in body where base64Index[character] == nil { return -1 }
        return body.count * 3 / 4
    }

    public struct Placeholder: Equatable {
        public var kind: String
        public var value: String
        public init(kind: String, value: String) {
            self.kind = kind
            self.value = value
        }
    }

    /// `placeholder` is one attribute carrying four different things, so the classification has
    /// to be deterministic rather than clever: an explicit `blurhash:` / `thumbhash:` prefix
    /// always wins, then colour by shape, then a blurhash by its self-describing length, then a
    /// thumbhash by being well-formed base64 of at least the 5-byte header, then an asset name.
    public static func classifyPlaceholder(_ value: String?) -> Placeholder {
        let text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return Placeholder(kind: "none", value: "") }
        if text.hasPrefix("blurhash:") {
            return Placeholder(kind: "blurhash", value: String(text.dropFirst(9)))
        }
        if text.hasPrefix("thumbhash:") {
            return Placeholder(kind: "thumbhash", value: String(text.dropFirst(10)))
        }
        if text.hasPrefix("#") || text.hasPrefix("rgb(") || text.hasPrefix("rgba(")
            || placeholderColorTokens.contains(text) {
            return Placeholder(kind: "color", value: text)
        }
        if isBlurhash(text) { return Placeholder(kind: "blurhash", value: text) }
        if base64ByteLength(text) >= 5 { return Placeholder(kind: "thumbhash", value: text) }
        return Placeholder(kind: "asset", value: text)
    }

    // ------------------------------------------------------------------ recycling

    public struct Recycling: Equatable {
        public var key: String
        public var clear: Bool
        public init(key: String, clear: Bool) {
            self.key = key
            self.clear = clear
        }
    }

    /// `recyclingKey` — the fix for the bug every list in every app has: row A shows image 1, the
    /// row is reused for item 47, and image 1 stays on screen under item 47's text until the new
    /// bytes land. The identity ladder is author key → the list's row key (set automatically, so
    /// the correct behaviour is the default) → src → asset.
    public static func resolveRecycling(
        recyclingKey: String? = nil, rowKey: String? = nil,
        src: String? = nil, asset: String? = nil, previousKey: String? = nil
    ) -> Recycling {
        var key = ""
        for candidate in [recyclingKey, rowKey, src, asset] {
            let text = (candidate ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                key = text
                break
            }
        }
        let previous = (previousKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return Recycling(key: key, clear: key != previous)
    }

    // ------------------------------------------------------------------ hash decoders

    public struct Pixels: Equatable {
        public var width: Int
        public var height: Int
        /// Straight RGBA bytes, four per pixel, row-major. `Int` rather than `UInt8` so the twin
        /// comparisons in the corpus runner read the same in all three languages.
        public var rgba: [Int]
        public init(width: Int, height: Int, rgba: [Int]) {
            self.width = width
            self.height = height
            self.rgba = rgba
        }
    }

    private static func srgbToLinear(_ component: Int) -> Double {
        let value = Double(component) / 255.0
        return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }

    private static func linearToSrgb(_ value: Double) -> Int {
        let clamped = value < 0.0 ? 0.0 : (value > 1.0 ? 1.0 : value)
        if clamped <= 0.0031308 { return truncatedInt(clamped * 12.92 * 255.0 + 0.5) }
        return truncatedInt((1.055 * pow(clamped, 1.0 / 2.4) - 0.055) * 255.0 + 0.5)
    }

    private static func signedPow(_ value: Double, _ exponent: Double) -> Double {
        return (value < 0 ? -1.0 : 1.0) * pow(abs(value), exponent)
    }

    private static func decode83(_ characters: ArraySlice<Character>) -> Int {
        var value = 0
        for character in characters {
            guard let digit = base83Index[character] else { return -1 }
            value = value * 83 + digit
        }
        return value
    }

    /// Decode a BlurHash to RGBA at an arbitrary size. Returns nil for a malformed hash rather
    /// than throwing: a bad placeholder must degrade to no placeholder, never to a crashed row.
    public static func decodeBlurhash(
        _ hash: String, width: Int, height: Int, punch: Double = 1.0
    ) -> Pixels? {
        guard isBlurhash(hash), width > 0, height > 0 else { return nil }
        let characters = Array(hash)
        let flag = decode83(characters[0..<1])
        let numY = flag / 9 + 1
        let numX = flag % 9 + 1
        let maximum = (Double(decode83(characters[1..<2])) + 1.0) / 166.0 * punch

        var colors = [[Double]](repeating: [0.0, 0.0, 0.0], count: numX * numY)
        let dc = decode83(characters[2..<6])
        colors[0] = [
            srgbToLinear(dc >> 16),
            srgbToLinear((dc >> 8) & 255),
            srgbToLinear(dc & 255),
        ]
        var index = 1
        while index < numX * numY {
            let value = decode83(characters[(4 + index * 2)..<(6 + index * 2)])
            let quantR = value / (19 * 19)
            let quantG = (value / 19) % 19
            let quantB = value % 19
            colors[index] = [
                signedPow(Double(quantR - 9) / 9.0, 2.0) * maximum,
                signedPow(Double(quantG - 9) / 9.0, 2.0) * maximum,
                signedPow(Double(quantB - 9) / 9.0, 2.0) * maximum,
            ]
            index += 1
        }

        var rgba = [Int](repeating: 0, count: width * height * 4)
        let stride = width * 4
        for y in 0..<height {
            for x in 0..<width {
                var red = 0.0, green = 0.0, blue = 0.0
                for j in 0..<numY {
                    let basisY = cos(Double.pi * Double(y) * Double(j) / Double(height))
                    for i in 0..<numX {
                        let basis = cos(Double.pi * Double(x) * Double(i) / Double(width)) * basisY
                        let color = colors[i + j * numX]
                        red += color[0] * basis
                        green += color[1] * basis
                        blue += color[2] * basis
                    }
                }
                let offset = y * stride + x * 4
                rgba[offset] = linearToSrgb(red)
                rgba[offset + 1] = linearToSrgb(green)
                rgba[offset + 2] = linearToSrgb(blue)
                rgba[offset + 3] = 255
            }
        }
        return Pixels(width: width, height: height, rgba: rgba)
    }

    /// Decode standard base64 without depending on a platform codec, so the twins cannot drift
    /// on padding or on a character outside the alphabet.
    private static func decodeBase64(_ text: String) -> [Int]? {
        if base64ByteLength(text) < 0 { return nil }
        var body = Array(text)
        while body.last == "=" { body.removeLast() }
        var bytes = [Int](repeating: 0, count: body.count * 3 / 4)
        var accumulator = 0
        var bits = 0
        var written = 0
        for character in body {
            guard let digit = base64Index[character] else { return nil }
            accumulator = (accumulator << 6) | digit
            bits += 6
            if bits >= 8 {
                bits -= 8
                bytes[written] = (accumulator >> bits) & 255
                written += 1
            }
        }
        return bytes
    }

    /// Decode a ThumbHash to RGBA. Unlike a blurhash the size is not the caller's choice — the
    /// hash carries its own aspect ratio and the decode is defined at <=32 px on the long edge,
    /// which is exactly why it is worth the extra bytes: the placeholder has the right shape.
    /// `hash` is the base64 transport form, with or without the `thumbhash:` prefix.
    public static func decodeThumbhash(_ hash: String) -> Pixels? {
        let stripped = hash.hasPrefix("thumbhash:") ? String(hash.dropFirst(10)) : hash
        guard let bytes = decodeBase64(stripped.trimmingCharacters(in: .whitespacesAndNewlines)),
              bytes.count >= 5 else { return nil }

        let header24 = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16)
        let header16 = bytes[3] | (bytes[4] << 8)
        let lDc = Double(header24 & 63) / 63.0
        let pDc = Double((header24 >> 6) & 63) / 31.5 - 1.0
        let qDc = Double((header24 >> 12) & 63) / 31.5 - 1.0
        let lScale = Double((header24 >> 18) & 31) / 31.0
        let hasAlpha = (header24 >> 23) != 0
        if hasAlpha && bytes.count < 6 { return nil }
        let pScale = Double((header16 >> 3) & 63) / 63.0
        let qScale = Double((header16 >> 9) & 63) / 63.0
        let isLandscape = (header16 >> 15) != 0
        let lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : (header16 & 7))
        let ly = max(3, isLandscape ? (header16 & 7) : (hasAlpha ? 5 : 7))
        let aDc = hasAlpha ? Double(bytes[5] & 15) / 15.0 : 1.0
        let aScale = hasAlpha ? Double(bytes[5] >> 4) / 15.0 : 0.0

        let acStart = hasAlpha ? 6 : 5
        var acIndex = 0
        var overran = false
        func channel(_ nx: Int, _ ny: Int, _ scale: Double) -> [Double] {
            var factors: [Double] = []
            for cy in 0..<ny {
                var cx = cy == 0 ? 1 : 0
                while cx * ny < nx * (ny - cy) {
                    let byteIndex = acStart + (acIndex >> 1)
                    if byteIndex >= bytes.count {
                        overran = true
                        factors.append(0.0)
                    } else {
                        let nibble = (bytes[byteIndex] >> ((acIndex & 1) << 2)) & 15
                        factors.append((Double(nibble) / 7.5 - 1.0) * scale)
                    }
                    acIndex += 1
                    cx += 1
                }
            }
            return factors
        }
        let lAc = channel(lx, ly, lScale)
        let pAc = channel(3, 3, pScale * 1.25)
        let qAc = channel(3, 3, qScale * 1.25)
        let aAc = hasAlpha ? channel(5, 5, aScale) : [Double]()
        if overran { return nil }

        let ratio = Double(lx) / Double(ly)
        let width = truncatedInt(roundHalfUp(ratio > 1.0 ? 32.0 : 32.0 * ratio))
        let height = truncatedInt(roundHalfUp(ratio > 1.0 ? 32.0 / ratio : 32.0))
        guard width > 0, height > 0 else { return nil }
        var rgba = [Int](repeating: 0, count: width * height * 4)
        let coefficientsX = max(lx, hasAlpha ? 5 : 3)
        let coefficientsY = max(ly, hasAlpha ? 5 : 3)
        var fx = [Double](repeating: 0.0, count: coefficientsX)
        var fy = [Double](repeating: 0.0, count: coefficientsY)

        var offset = 0
        for y in 0..<height {
            for cy in 0..<coefficientsY {
                fy[cy] = cos(Double.pi / Double(height) * (Double(y) + 0.5) * Double(cy))
            }
            for x in 0..<width {
                for cx in 0..<coefficientsX {
                    fx[cx] = cos(Double.pi / Double(width) * (Double(x) + 0.5) * Double(cx))
                }
                var luminance = lDc, chromaP = pDc, chromaQ = qDc, alpha = aDc
                var j = 0
                for cy in 0..<ly {
                    let doubled = fy[cy] * 2.0
                    var cx = cy == 0 ? 1 : 0
                    while cx * ly < lx * (ly - cy) {
                        luminance += lAc[j] * fx[cx] * doubled
                        j += 1
                        cx += 1
                    }
                }
                j = 0
                for cy in 0..<3 {
                    let doubled = fy[cy] * 2.0
                    var cx = cy == 0 ? 1 : 0
                    while cx < 3 - cy {
                        let basis = fx[cx] * doubled
                        chromaP += pAc[j] * basis
                        chromaQ += qAc[j] * basis
                        j += 1
                        cx += 1
                    }
                }
                if hasAlpha {
                    j = 0
                    for cy in 0..<5 {
                        let doubled = fy[cy] * 2.0
                        var cx = cy == 0 ? 1 : 0
                        while cx < 5 - cy {
                            alpha += aAc[j] * fx[cx] * doubled
                            j += 1
                            cx += 1
                        }
                    }
                }
                let blue = luminance - 2.0 / 3.0 * chromaP
                let red = (3.0 * luminance - blue + chromaQ) / 2.0
                let green = red - chromaQ
                rgba[offset] = max(0, truncatedInt(255.0 * min(1.0, red)))
                rgba[offset + 1] = max(0, truncatedInt(255.0 * min(1.0, green)))
                rgba[offset + 2] = max(0, truncatedInt(255.0 * min(1.0, blue)))
                rgba[offset + 3] = max(0, truncatedInt(255.0 * min(1.0, alpha)))
                offset += 4
            }
        }
        return Pixels(width: width, height: height, rgba: rgba)
    }

    /// Decode whatever kind of hash `placeholder` turned out to be, at the size the caller wants.
    public static func decodePlaceholder(
        _ placeholder: Placeholder, width: Int = 32, height: Int = 32
    ) -> Pixels? {
        switch placeholder.kind {
        case "blurhash": return decodeBlurhash(placeholder.value, width: width, height: height)
        case "thumbhash": return decodeThumbhash(placeholder.value)
        default: return nil
        }
    }

    // ------------------------------------------------------------------ priority / media type

    /// `priority` — unknown words are `normal`, never a silent demotion to `low`.
    public static func resolveImagePriority(_ priority: String?) -> String {
        let word = (priority ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return priorities.contains(word) ? word : "normal"
    }

    private static let mediaTypes: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
        "webp": "image/webp", "avif": "image/avif", "heic": "image/heic", "heif": "image/heif",
        "svg": "image/svg+xml", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
    ]

    /// Map the sniffed container to the media type `on:load` reports. Unknown bytes stay unknown.
    public static func imageMediaType(_ extensionOrType: String?) -> String {
        let text = (extensionOrType ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return "unknown" }
        if text.contains("/") { return text }
        let key = text.hasPrefix(".") ? String(text.dropFirst()) : text
        return mediaTypes[key] ?? "unknown"
    }

    /// The `on:load` payload, assembled in one place so all three renderers report the same shape.
    public static func loadPayload(
        width: Double, height: Double, mediaType: String?, cacheType: String
    ) -> [String: Any] {
        return [
            "width": width,
            "height": height,
            "mediaType": imageMediaType(mediaType),
            "cacheType": cacheType,
        ]
    }
}
