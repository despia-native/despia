//
//  InkCore.swift — the INK PRIMITIVE's pure core: the wire shape of a captured drawing, the
//  capture folds (clamp · round · coalesce), the ink curve, and the tier-1 canvas nodes a
//  committed drawing becomes. Foundation only — nothing SwiftUI-shaped in it.
//
//  This is the `<ink>` child of `<canvas>` (StackCanvas.swift): the one primitive a drawing
//  surface needs that a display list cannot express — a pointer stream captured and painted
//  NATIVELY, at pointer rate, without a store write per sample. `<Signature>` is its first
//  consumer.
//
//  The law is OpenSource/Conformance/canvas/ink.json; the TS twin is @despia-native/kernel
//  ink-core.ts and the Kotlin twin :core InkCore.kt.
//
//  THE VALUE IS THE API. A drawing is `[{ points: [[x, y], …], width }]` with x/y NORMALIZED
//  0…1 against the surface box and rounded to 1/coordinateScale at CAPTURE — so the number
//  written to the store is the number every renderer draws, a phone capture replays on a
//  desktop surface, and clearing is `drawing = []` rather than a control channel.
//
//  THE COMMITTED DRAWING IS ORDINARY TIER 1. `nodes(_:…)` turns the stored strokes into the
//  same `path` markup nodes an author could have written by hand, so the display list, its
//  keyed diff and its SVG serialisation need no special case for ink. Only the IN-FLIGHT
//  stroke is transient native paint.
//

import Foundation

public enum InkCore {

    /// Ink defaults and the capture folds.
    public static let strokeWidth: Double = 3
    /// Samples closer than this (in surface points, before normalization) are dropped.
    public static let minPointDistance: Double = 1.5
    /// The normalized pair is rounded to 1/10000 at capture.
    public static let coordinateScale: Double = 10000
    /// The ink paint every renderer applies to a committed stroke.
    public static let lineCap = "round"
    public static let lineJoin = "round"

    /// One captured point, normalized 0…1. This pair IS the stored value.
    public struct Point: Equatable {
        public let x: Double
        public let y: Double
        public init(x: Double, y: Double) { self.x = x; self.y = y }
    }

    public struct Stroke: Equatable {
        public let points: [Point]
        public let width: Double
        public init(points: [Point], width: Double) { self.points = points; self.width = width }
    }

    public enum Verb { case move, line, quad }

    public struct Op: Equatable {
        public let verb: Verb
        public let x: Double
        public let y: Double
        public let cx: Double
        public let cy: Double
    }

    /// Read a stored drawing. Anything that is not a usable stroke is dropped, never guessed.
    public static func decode(_ rows: [[String: Any]]) -> [Stroke] {
        rows.compactMap { row in
            guard let raw = row["points"] as? [Any] else { return nil }
            let points = raw.compactMap { pair -> Point? in
                guard let xy = pair as? [Any], xy.count >= 2,
                      let x = JSE.number(xy[0]), let y = JSE.number(xy[1]) else { return nil }
                return Point(x: x, y: y)
            }
            guard !points.isEmpty else { return nil }
            return Stroke(points: points, width: JSE.number(row["width"]) ?? strokeWidth)
        }
    }

    /// The store shape — plain arrays, so the value survives every transport unchanged.
    public static func encode(_ strokes: [Stroke]) -> [[String: Any]] {
        strokes.map { stroke in
            ["points": stroke.points.map { [$0.x, $0.y] }, "width": stroke.width]
        }
    }

    /// Clamp a pointer position to the surface box and round it AT CAPTURE.
    public static func point(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> Point {
        Point(x: round01(width > 0 ? x / width : 0), y: round01(height > 0 ? y / height : 0))
    }

    private static func round01(_ v: Double) -> Double {
        let clamped = v.isFinite ? min(max(v, 0), 1) : 0
        return (clamped * coordinateScale).rounded() / coordinateScale
    }

    /// The coalescing floor: is the new sample far enough from the last one to keep?
    public static func farEnough(_ last: Point, _ next: Point,
                                 _ width: Double, _ height: Double) -> Bool {
        let dx = (next.x - last.x) * width
        let dy = (next.y - last.y) * height
        return dx * dx + dy * dy >= minPointDistance * minPointDistance
    }

    /// The INK LAW: a quadratic Bézier through the MIDPOINTS of consecutive samples, so the
    /// same stroke list draws the same curve on every renderer. A one-point stroke is a dot,
    /// painted by the round cap.
    public static func ops(_ points: [Point], _ width: Double, _ height: Double) -> [Op] {
        guard !points.isEmpty else { return [] }
        let at = points.map { Point(x: $0.x * width, y: $0.y * height) }
        var out = [Op(verb: .move, x: at[0].x, y: at[0].y, cx: 0, cy: 0)]
        if at.count == 1 {
            out.append(Op(verb: .line, x: at[0].x, y: at[0].y, cx: 0, cy: 0))
            return out
        }
        for i in 1..<(at.count - 1) {
            out.append(Op(verb: .quad,
                          x: (at[i].x + at[i + 1].x) / 2, y: (at[i].y + at[i + 1].y) / 2,
                          cx: at[i].x, cy: at[i].y))
        }
        out.append(Op(verb: .line, x: at[at.count - 1].x, y: at[at.count - 1].y, cx: 0, cy: 0))
        return out
    }

    /// The same ops as an SVG `d` — the serialised form the tier-1 nodes carry.
    public static func pathData(_ points: [Point], _ width: Double, _ height: Double) -> String {
        ops(points, width, height).map { op in
            switch op.verb {
            case .quad: return "Q \(trim(op.cx)) \(trim(op.cy)) \(trim(op.x)) \(trim(op.y))"
            case .move: return "M \(trim(op.x)) \(trim(op.y))"
            case .line: return "L \(trim(op.x)) \(trim(op.y))"
            }
        }.joined(separator: " ")
    }

    private static func trim(_ v: Double) -> String {
        let rounded = (v * 1000).rounded() / 1000
        if rounded == rounded.rounded() && rounded.isFinite {
            return String(Int(rounded))
        }
        return String(rounded)
    }

    /// The committed drawing as TIER-1 markup nodes — one stroked `path` per stroke, in the
    /// surface's own pixel space. The display list, its keyed diff and its SVG serialisation
    /// then treat ink exactly like geometry an author wrote by hand.
    public static func nodes(_ strokes: [Stroke], _ width: Double, _ height: Double,
                             _ stroke: String) -> [CanvasCore.MarkupNode] {
        strokes.map { entry in
            CanvasCore.MarkupNode(kind: "path", attrs: [
                "d": pathData(entry.points, width, height),
                "fill": "none",
                "stroke": stroke,
                "strokeWidth": entry.width,
                "strokeLinecap": lineCap,
                "strokeLinejoin": lineJoin,
            ])
        }
    }
}
