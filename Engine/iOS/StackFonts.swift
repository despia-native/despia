//
//  StackFonts.swift — the shared font FACE-SELECTION core. The law is the corpus,
//  `OpenSource/Conformance/fonts/matching.json` (parity/F01-fonts.md); the Kotlin twin is
//  `:core` StackFonts.kt and the web twin is @despia-native/kernel's fonts.ts.
//
//  WHAT LIVES HERE: given a family's declared faces and a requested weight/italic, which face
//  renders — plus variable-axis clamping and the `fontVariation`/`fontFeature` string parsers.
//  All pure, all corpus-pinned, because a heading that comes out semibold on iOS and bold on
//  Android is precisely the drift one shared core exists to prevent.
//
//  WHAT LIVES OUTSIDE: loading the bytes, registering the face, and applying the result
//  (`UIFont(name:size:)` wrapped in `UIFontMetrics.scaledFont(for:)` so Dynamic Type keeps
//  working — that wrapper is the whole correctness story and it is what the third-party RN font
//  libraries get wrong). The build extracts each face's PostScript name, which is the value the
//  platform actually wants and almost never the family name the designer typed.
//
//  No UIKit import: this file is pure so the record lane can run it headless.
//
import Foundation

public enum StackFonts {

    /// One declared face of a family.
    public struct Face: Equatable {
        public let weight: Int
        public let italic: Bool
        public let file: String?
        public let postscriptName: String?
        public init(weight: Int, italic: Bool, file: String? = nil, postscriptName: String? = nil) {
            self.weight = weight
            self.italic = italic
            self.file = file
            self.postscriptName = postscriptName
        }
    }

    /// The face that will render, and whether the renderer must slant it itself.
    public struct Selection: Equatable {
        public let face: Face
        public let synthesized: Bool
    }

    /// The CSS Fonts 4 weight-matching algorithm, over the weights available in one slant set.
    ///
    /// Deliberately NOT "nearest weight". In the 400–500 band the search goes UP to 500 first,
    /// which is why a family shipping 400 and 700 renders **400** for a requested 500 and **700**
    /// for a requested 501. Implementing the intuitive nearest-neighbour rule instead is the
    /// single most common way a type ramp comes out wrong.
    public static func matchWeight(_ available: [Int], desired: Int) -> Int? {
        guard !available.isEmpty else { return nil }
        if available.contains(desired) { return desired }

        let lower = available.filter { $0 < desired }.max()
        let higher = available.filter { $0 > desired }.min()

        if desired >= 400 && desired <= 500 {
            let inBand = available.filter { $0 >= desired && $0 <= 500 }
            if let best = inBand.min() { return best }
            if let lower { return lower }
            return available.filter { $0 > 500 }.min()
        }
        return desired < 400 ? (lower ?? higher) : (higher ?? lower)
    }

    /// Pick the face for a requested weight + slant.
    ///
    /// An exact slant match always wins, and the weight search runs WITHIN that slant set rather
    /// than across both. Italic asked for with no italic face falls back to the matched upright
    /// and reports `synthesized`. Upright asked for with only italic available uses the italic
    /// face rather than refusing: a rendered wrong slant beats no text at all.
    public static func selectFace(_ faces: [Face], weight: Int, italic: Bool) -> Selection? {
        let preferred = faces.filter { $0.italic == italic }
        let pool = preferred.isEmpty ? faces.filter { $0.italic != italic } : preferred
        guard !pool.isEmpty else { return nil }
        guard let matched = matchWeight(pool.map(\.weight), desired: weight),
              let face = pool.first(where: { $0.weight == matched }) else { return nil }
        return Selection(face: face, synthesized: preferred.isEmpty && italic)
    }

    /// The resolved axis set, plus what the family refused and why. Both reports are SORTED.
    public struct VariationResolution: Equatable {
        public let applied: [String: Double]
        public let clamped: [String]
        public let dropped: [String]
    }

    /// Parse a `fontVariation` string: `"wght 480, SOFT 40"`. Axis tags are case sensitive
    /// because OpenType defines them that way. A malformed pair is dropped and the rest survive —
    /// one typo should not silently discard a whole declaration.
    public static func parseVariation(_ input: String?) -> [String: Double] {
        var out: [String: Double] = [:]
        for chunk in (input ?? "").split(separator: ",", omittingEmptySubsequences: false) {
            let parts = chunk.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" })
            guard parts.count == 2, let value = Double(parts[1]), value.isFinite else { continue }
            out[String(parts[0])] = value
        }
        return out
    }

    /// Clamp requested axes against what the family declares. A static family drops every axis.
    public static func resolveVariation(declared: [String: (Double, Double)]?,
                                        requested: [String: Double]) -> VariationResolution {
        var applied: [String: Double] = [:]
        var clamped: [String] = []
        var dropped: [String] = []
        for tag in requested.keys {
            guard let range = declared?[tag] else { dropped.append(tag); continue }
            let value = requested[tag]!
            if value < range.0 { applied[tag] = range.0; clamped.append(tag) }
            else if value > range.1 { applied[tag] = range.1; clamped.append(tag) }
            else { applied[tag] = value }
        }
        return VariationResolution(applied: applied, clamped: clamped.sorted(), dropped: dropped.sorted())
    }

    /// Parse a `fontFeature` string: `"tnum, ss01"`. An OpenType feature tag is exactly four
    /// characters; anything else is a typo and is dropped rather than passed to the platform,
    /// which would ignore it silently. Duplicates collapse and the first position wins.
    public static func parseFeatures(_ input: String?) -> [String] {
        var out: [String] = []
        for chunk in (input ?? "").split(separator: ",", omittingEmptySubsequences: false) {
            let tag = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            guard tag.count == 4, !out.contains(tag) else { continue }
            out.append(tag)
        }
        return out
    }
}
