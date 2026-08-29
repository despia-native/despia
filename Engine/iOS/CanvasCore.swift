//
//  CanvasCore.swift - the shared `<canvas>` core, the Swift twin of the web kernel's
//  canvas-core.ts and Android's CanvasCore.kt (parity/U04-canvas.md): the SVG path-data
//  parser, the 2-D transform plane, fill-rule resolution, gradient normalisation, the
//  tier-1 display list (+ its keyed diff and SVG serialisation), the tier-2 command
//  recorder, the `on:frame` schedule and the accessibility fold. The law is the corpus,
//  OpenSource/Conformance/canvas/.
//
//  WHY THIS IS A SHARED CORE AND NOT THREE RASTERISERS. Three rasterisers will never be
//  bit-identical, so the determinism split is deliberate: PIXELS are toleranced and belong
//  to the platform (GraphicsContext / DrawScope / canvas 2D), GEOMETRY is exact and lives
//  here. A path's normalized segment list, a transform's composed matrix, a gradient's stop
//  offsets, a display list's keys and diff, a tier-2 command stream and the frame budget
//  are all pure data folds, and a renderer that disagrees with one of them draws a
//  different picture no tolerance can excuse.
//
//  Apple-free by construction: only Foundation, so the same file serves iOS, macOS,
//  watchOS and the record lane. The UIKit/SwiftUI adapter is StackCanvas.swift.
//

import Foundation

public enum CanvasCore {

    // MARK: - numbers

    /// the affine six: x' = a*x + c*y + e, y' = b*x + d*y + f (the SVG / Canvas2D spelling,
    /// never the scene kernel's column-major mat4 - a 2-D canvas has no third axis and
    /// borrowing the 3-D shape would invite silent index drift)
    public struct Matrix: Equatable {
        public let a: Double
        public let b: Double
        public let c: Double
        public let d: Double
        public let e: Double
        public let f: Double

        public init(_ a: Double, _ b: Double, _ c: Double, _ d: Double, _ e: Double, _ f: Double) {
            self.a = a; self.b = b; self.c = c; self.d = d; self.e = e; self.f = f
        }

        public static let identity = Matrix(1, 0, 0, 1, 0, 0)

        public var list: [Double] { [a, b, c, d, e, f] }

        public var isIdentity: Bool {
            a == 1 && b == 0 && c == 0 && d == 1 && e == 0 && f == 0
        }
    }

    /// world = parentWorld * local, the same fold the scene kernel uses one dimension up
    public static func matMul(_ m: Matrix, _ n: Matrix) -> Matrix {
        Matrix(
            m.a * n.a + m.c * n.b,
            m.b * n.a + m.d * n.b,
            m.a * n.c + m.c * n.d,
            m.b * n.c + m.d * n.d,
            m.a * n.e + m.c * n.f + m.e,
            m.b * n.e + m.d * n.f + m.f
        )
    }

    public static func apply(_ m: Matrix, _ x: Double, _ y: Double) -> (x: Double, y: Double) {
        (m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)
    }

    static let degrees = Double.pi / 180.0

    static func asDouble(_ value: Any?, _ fallback: Double) -> Double {
        if let n = value as? Double { return n.isFinite ? n : fallback }
        if let n = value as? Int { return Double(n) }
        if let n = value as? NSNumber { return n.doubleValue.isFinite ? n.doubleValue : fallback }
        if let s = value as? String, let n = Double(s.trimmingCharacters(in: .whitespaces)), n.isFinite {
            return n
        }
        return fallback
    }

    // MARK: - path data (`d`)

    /// one normalized ABSOLUTE segment. Every authored command folds to M / L / C / Q / Z:
    /// H and V become L, S and T resolve their reflected control point, and an elliptical
    /// arc becomes 1..4 cubics.
    public struct Segment: Equatable {
        public let cmd: String
        public let values: [Double]

        public init(_ cmd: String, _ values: [Double]) {
            self.cmd = cmd
            self.values = values
        }
    }

    public struct PathParse {
        public let segments: [Segment]
        public let diagnostics: [String]
    }

    static let pathCommands = Set("MmLlHhVvCcSsQqTtAaZz")

    final class PathScanner {
        private let chars: [Character]
        private var i = 0

        init(_ source: String) { chars = Array(source) }

        /// whitespace or a comma; the form feed the SVG grammar also accepts rides the
        /// unicode scalar test rather than a literal
        private func isSep(_ c: Character) -> Bool {
            c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{000C}" || c == ","
        }

        func skipSep() {
            while i < chars.count && isSep(chars[i]) { i += 1 }
        }

        func atEnd() -> Bool {
            skipSep()
            return i >= chars.count
        }

        func peek() -> Character { i < chars.count ? chars[i] : " " }

        func advance() { i += 1 }

        /// the SVG number grammar: sign, digit runs, a bare leading '.', and exponents.
        /// '.5.5' is deliberately TWO numbers - a second '.' terminates the first.
        func number() -> Double? {
            skipSep()
            let start = i
            if peek() == "+" || peek() == "-" { i += 1 }
            var digits = 0
            while i < chars.count && chars[i].isASCII && chars[i].isNumber { i += 1; digits += 1 }
            if peek() == "." {
                i += 1
                while i < chars.count && chars[i].isASCII && chars[i].isNumber { i += 1; digits += 1 }
            }
            if digits == 0 { i = start; return nil }
            let e = peek()
            if e == "e" || e == "E" {
                let mark = i
                i += 1
                if peek() == "+" || peek() == "-" { i += 1 }
                var expDigits = 0
                while i < chars.count && chars[i].isASCII && chars[i].isNumber { i += 1; expDigits += 1 }
                if expDigits == 0 { i = mark }
            }
            guard let value = Double(String(chars[start..<i])), value.isFinite else {
                i = start
                return nil
            }
            return value
        }

        /// the two arc flags are SINGLE characters, so `a5 5 0 0110 0` is fa=0 fs=1 x=10 y=0
        func flag() -> Int? {
            skipSep()
            let c = peek()
            if c == "0" { i += 1; return 0 }
            if c == "1" { i += 1; return 1 }
            return nil
        }
    }

    static func arcK(_ delta: Double) -> Double { (4.0 / 3.0) * tan(delta / 4.0) }

    /// centre parameterisation -> 1..4 cubics, split at ceil(|dTheta| / 90deg)
    static func arcCentreToCubics(
        _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double, _ phi: Double,
        _ theta1: Double, _ dtheta: Double
    ) -> [Segment] {
        var out: [Segment] = []
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        func point(_ t: Double) -> (Double, Double) {
            let x = rx * cos(t)
            let y = ry * sin(t)
            return (cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y)
        }
        func deriv(_ t: Double) -> (Double, Double) {
            let x = -rx * sin(t)
            let y = ry * cos(t)
            return (cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y)
        }
        let count = max(1, Int(ceil(abs(dtheta) / (Double.pi / 2) - 1e-9)))
        let step = dtheta / Double(count)
        let k = arcK(step)
        for i in 0..<count {
            let t1 = theta1 + step * Double(i)
            let t2 = t1 + step
            let p1 = point(t1)
            let p2 = point(t2)
            let d1 = deriv(t1)
            let d2 = deriv(t2)
            out.append(Segment("C", [
                p1.0 + k * d1.0, p1.1 + k * d1.1,
                p2.0 - k * d2.0, p2.1 - k * d2.1,
                p2.0, p2.1,
            ]))
        }
        return out
    }

    /// the F.6.5 endpoint->centre conversion plus the F.6.6 corrections: rx = |rx|,
    /// ry = |ry|; identical endpoints emit NOTHING; a zero radius degenerates to a line;
    /// radii too small are scaled by sqrt(lambda).
    public static func arcToCubics(
        _ x1: Double, _ y1: Double, _ rxIn: Double, _ ryIn: Double, _ phiDeg: Double,
        _ largeArc: Int, _ sweep: Int, _ x2: Double, _ y2: Double
    ) -> [Segment] {
        if x1 == x2 && y1 == y2 { return [] }
        var rx = abs(rxIn)
        var ry = abs(ryIn)
        if rx == 0 || ry == 0 { return [Segment("L", [x2, y2])] }
        let wrapped = phiDeg.truncatingRemainder(dividingBy: 360)
        let phi = (wrapped < 0 ? wrapped + 360 : wrapped) * degrees
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        let dx = (x1 - x2) / 2
        let dy = (y1 - y2) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let scale = sqrt(lambda)
            rx *= scale
            ry *= scale
        }
        let rx2 = rx * rx
        let ry2 = ry * ry
        let numerator = max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p)
        let denominator = rx2 * y1p * y1p + ry2 * x1p * x1p
        let coefficient = denominator == 0 ? 0 : sqrt(numerator / denominator)
        let signum: Double = largeArc == sweep ? -1 : 1
        let cxp = signum * coefficient * ((rx * y1p) / ry)
        let cyp = signum * coefficient * (-(ry * x1p) / rx)
        let cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2
        let theta1 = atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
        let theta2 = atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
        var dtheta = theta2 - theta1
        if sweep == 0 && dtheta > 0 { dtheta -= 2 * Double.pi }
        else if sweep == 1 && dtheta < 0 { dtheta += 2 * Double.pi }
        return arcCentreToCubics(cx, cy, rx, ry, phi, theta1, dtheta)
    }

    /// The SVG path-data mini-language -> the normalized ABSOLUTE segment list.
    ///
    /// ARTICLE 7: a malformed token STOPS the parse, keeps every segment already produced
    /// and emits exactly ONE diagnostic - never a crash, never a partial number.
    public static func parsePath(_ d: String?) -> PathParse {
        var segments: [Segment] = []
        var diagnostics: [String] = []
        let scan = PathScanner(d ?? "")
        var cmd: Character?
        var cx = 0.0, cy = 0.0, sx = 0.0, sy = 0.0
        var lastCubic: (Double, Double)?
        var lastQuad: (Double, Double)?
        var reopen = false

        func openIfNeeded() {
            guard reopen else { return }
            segments.append(Segment("M", [cx, cy]))
            reopen = false
        }

        parsing: while !scan.atEnd() {
            let head = scan.peek()
            if head.isLetter {
                if !pathCommands.contains(head) {
                    diagnostics.append("canvas.path: unknown command '\(head)'")
                    break parsing
                }
                cmd = head
                scan.advance()
            } else {
                guard let current = cmd else {
                    diagnostics.append("canvas.path: data does not start with a command")
                    break parsing
                }
                if current == "M" { cmd = "L" }
                else if current == "m" { cmd = "l" }
                else if current == "Z" || current == "z" {
                    diagnostics.append("canvas.path: an argument after closepath")
                    break parsing
                }
            }

            let active = cmd!
            let rel = active.isLowercase
            let upper = Character(active.uppercased())
            var failed = false
            func need() -> Double {
                guard let v = scan.number() else { failed = true; return 0 }
                return v
            }

            switch upper {
            case "Z":
                segments.append(Segment("Z", []))
                cx = sx
                cy = sy
                lastCubic = nil
                lastQuad = nil
                reopen = true
            case "M":
                let x = need(), y = need()
                if failed { diagnostics.append("canvas.path: truncated moveto"); break parsing }
                cx = rel ? cx + x : x
                cy = rel ? cy + y : y
                sx = cx; sy = cy
                segments.append(Segment("M", [cx, cy]))
                lastCubic = nil; lastQuad = nil; reopen = false
            case "L":
                let x = need(), y = need()
                if failed { diagnostics.append("canvas.path: truncated lineto"); break parsing }
                openIfNeeded()
                cx = rel ? cx + x : x
                cy = rel ? cy + y : y
                segments.append(Segment("L", [cx, cy]))
                lastCubic = nil; lastQuad = nil
            case "H":
                let x = need()
                if failed { diagnostics.append("canvas.path: truncated horizontal lineto"); break parsing }
                openIfNeeded()
                cx = rel ? cx + x : x
                segments.append(Segment("L", [cx, cy]))
                lastCubic = nil; lastQuad = nil
            case "V":
                let y = need()
                if failed { diagnostics.append("canvas.path: truncated vertical lineto"); break parsing }
                openIfNeeded()
                cy = rel ? cy + y : y
                segments.append(Segment("L", [cx, cy]))
                lastCubic = nil; lastQuad = nil
            case "C", "S":
                var c1x = 0.0, c1y = 0.0
                if upper == "S" {
                    let reflected = lastCubic ?? (cx, cy)
                    c1x = 2 * cx - reflected.0
                    c1y = 2 * cy - reflected.1
                } else {
                    c1x = need(); c1y = need()
                    if !failed {
                        c1x = rel ? cx + c1x : c1x
                        c1y = rel ? cy + c1y : c1y
                    }
                }
                var c2x = need(), c2y = need(), x = need(), y = need()
                if failed { diagnostics.append("canvas.path: truncated cubic"); break parsing }
                c2x = rel ? cx + c2x : c2x
                c2y = rel ? cy + c2y : c2y
                x = rel ? cx + x : x
                y = rel ? cy + y : y
                openIfNeeded()
                segments.append(Segment("C", [c1x, c1y, c2x, c2y, x, y]))
                cx = x; cy = y
                lastCubic = (c2x, c2y)
                lastQuad = nil
            case "Q", "T":
                var qx = 0.0, qy = 0.0
                if upper == "T" {
                    let reflected = lastQuad ?? (cx, cy)
                    qx = 2 * cx - reflected.0
                    qy = 2 * cy - reflected.1
                } else {
                    qx = need(); qy = need()
                    if !failed {
                        qx = rel ? cx + qx : qx
                        qy = rel ? cy + qy : qy
                    }
                }
                var x = need(), y = need()
                if failed { diagnostics.append("canvas.path: truncated quadratic"); break parsing }
                x = rel ? cx + x : x
                y = rel ? cy + y : y
                openIfNeeded()
                segments.append(Segment("Q", [qx, qy, x, y]))
                cx = x; cy = y
                lastQuad = (qx, qy)
                lastCubic = nil
            case "A":
                let rx = need(), ry = need(), rot = need()
                let fa = scan.flag(), fs = scan.flag()
                if fa == nil || fs == nil { failed = true }
                var x = need(), y = need()
                if failed { diagnostics.append("canvas.path: truncated arc"); break parsing }
                x = rel ? cx + x : x
                y = rel ? cy + y : y
                let cubics = arcToCubics(cx, cy, rx, ry, rot, fa ?? 0, fs ?? 0, x, y)
                if !cubics.isEmpty {
                    openIfNeeded()
                    segments.append(contentsOf: cubics)
                    cx = x; cy = y
                }
                lastCubic = nil; lastQuad = nil
            default:
                break
            }
        }
        return PathParse(segments: segments, diagnostics: diagnostics)
    }

    // MARK: - bounding box (TIGHT: curve extrema solved analytically)

    static func cubicExtrema(_ p0: Double, _ p1: Double, _ p2: Double, _ p3: Double) -> [Double] {
        let a = -p0 + 3 * p1 - 3 * p2 + p3
        let b = 2 * (p0 - 2 * p1 + p2)
        let c = p1 - p0
        var roots: [Double] = []
        if abs(a) < 1e-12 {
            if abs(b) > 1e-12 { roots.append(-c / b) }
        } else {
            let disc = b * b - 4 * a * c
            if disc >= 0 {
                let s = sqrt(disc)
                roots.append((-b + s) / (2 * a))
                roots.append((-b - s) / (2 * a))
            }
        }
        return roots.filter { $0 > 0 && $0 < 1 }
    }

    static func cubicAt(_ p0: Double, _ p1: Double, _ p2: Double, _ p3: Double, _ t: Double) -> Double {
        let u = 1 - t
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
    }

    static func quadAt(_ p0: Double, _ p1: Double, _ p2: Double, _ t: Double) -> Double {
        let u = 1 - t
        return u * u * p0 + 2 * u * t * p1 + t * t * p2
    }

    /// the TIGHT bounding box - the geometry half of the determinism split, exact on every
    /// renderer. nil for an empty path.
    public static func pathBBox(_ segments: [Segment]) -> [Double]? {
        var minX = Double.infinity, minY = Double.infinity
        var maxX = -Double.infinity, maxY = -Double.infinity
        var seen = false
        var cx = 0.0, cy = 0.0, sx = 0.0, sy = 0.0
        func hit(_ x: Double, _ y: Double) {
            seen = true
            if x < minX { minX = x }
            if y < minY { minY = y }
            if x > maxX { maxX = x }
            if y > maxY { maxY = y }
        }
        for seg in segments {
            let v = seg.values
            switch seg.cmd {
            case "M":
                cx = v[0]; cy = v[1]; sx = cx; sy = cy; hit(cx, cy)
            case "L":
                cx = v[0]; cy = v[1]; hit(cx, cy)
            case "Q":
                hit(v[2], v[3])
                let dx = cx - 2 * v[0] + v[2]
                if abs(dx) >= 1e-12 {
                    let t = (cx - v[0]) / dx
                    if t > 0 && t < 1 { hit(quadAt(cx, v[0], v[2], t), cy) }
                }
                let dy = cy - 2 * v[1] + v[3]
                if abs(dy) >= 1e-12 {
                    let t = (cy - v[1]) / dy
                    if t > 0 && t < 1 { hit(cx, quadAt(cy, v[1], v[3], t)) }
                }
                cx = v[2]; cy = v[3]
            case "C":
                hit(v[4], v[5])
                for t in cubicExtrema(cx, v[0], v[2], v[4]) { hit(cubicAt(cx, v[0], v[2], v[4], t), cy) }
                for t in cubicExtrema(cy, v[1], v[3], v[5]) { hit(cx, cubicAt(cy, v[1], v[3], v[5], t)) }
                cx = v[4]; cy = v[5]
            default:
                cx = sx; cy = sy
            }
        }
        return seen ? [minX, minY, maxX, maxY] : nil
    }
}

// MARK: - the transform attribute

extension CanvasCore {

    public struct TransformParse {
        public let matrix: Matrix
        public let diagnostics: [String]
    }

    static let transformArity: [String: [Int]] = [
        "translate": [1, 2], "scale": [1, 2], "rotate": [1, 3],
        "skewX": [1], "skewY": [1], "matrix": [6],
    ]

    static func transformFunction(_ name: String, _ a: [Double]) -> Matrix? {
        switch name {
        case "translate":
            return Matrix(1, 0, 0, 1, a[0], a.count > 1 ? a[1] : 0)
        case "scale":
            return Matrix(a[0], 0, 0, a.count > 1 ? a[1] : a[0], 0, 0)
        case "rotate":
            let r = a[0] * degrees
            let rot = Matrix(cos(r), sin(r), -sin(r), cos(r), 0, 0)
            if a.count == 1 { return rot }
            return matMul(matMul(Matrix(1, 0, 0, 1, a[1], a[2]), rot),
                          Matrix(1, 0, 0, 1, -a[1], -a[2]))
        case "skewX":
            return Matrix(1, 0, tan(a[0] * degrees), 1, 0, 0)
        case "skewY":
            return Matrix(1, tan(a[0] * degrees), 0, 1, 0, 0)
        case "matrix":
            return Matrix(a[0], a[1], a[2], a[3], a[4], a[5])
        default:
            return nil
        }
    }

    /// The SVG function list, applied LEFT TO RIGHT: the leftmost function is outermost, so
    /// M = M1*M2*...*Mn and `translate(10,0) scale(2)` is NOT `scale(2) translate(10,0)`.
    ///
    /// ARTICLE 7: an unknown function, a wrong-arity function, a non-numeric argument or
    /// junk between functions costs exactly ONE diagnostic and is SKIPPED - every other
    /// function in the list still applies.
    public static func parseTransform(_ input: String?) -> TransformParse {
        let source = input ?? ""
        var diagnostics: [String] = []
        var matrix = Matrix.identity
        guard let pattern = try? NSRegularExpression(pattern: "([A-Za-z][A-Za-z0-9]*)\\s*\\(([\\s\\S]*?)\\)") else {
            return TransformParse(matrix: matrix, diagnostics: diagnostics)
        }
        let ns = source as NSString
        var cursor = 0
        func gap(_ range: NSRange) {
            guard range.length > 0 else { return }
            let text = ns.substring(with: range)
            if !text.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r,")).isEmpty {
                diagnostics.append("canvas.transform: junk '\(text.trimmingCharacters(in: .whitespacesAndNewlines))'")
            }
        }
        for match in pattern.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
            gap(NSRange(location: cursor, length: match.range.location - cursor))
            cursor = match.range.location + match.range.length
            let name = ns.substring(with: match.range(at: 1))
            guard let arity = transformArity[name] else {
                diagnostics.append("canvas.transform: unknown function '\(name)'")
                continue
            }
            let words = ns.substring(with: match.range(at: 2))
                .components(separatedBy: CharacterSet(charactersIn: " \t\n\r,"))
                .filter { !$0.isEmpty }
            if !arity.contains(words.count) {
                let spelling = arity.map { String($0) }.joined(separator: " or ")
                diagnostics.append("canvas.transform: \(name) takes \(spelling) arguments")
                continue
            }
            var args: [Double] = []
            var numeric = true
            for word in words {
                guard let value = Double(word), value.isFinite else { numeric = false; break }
                args.append(value)
            }
            if !numeric {
                diagnostics.append("canvas.transform: \(name) has a non-numeric argument")
                continue
            }
            if let local = transformFunction(name, args) { matrix = matMul(matrix, local) }
        }
        gap(NSRange(location: cursor, length: ns.length - cursor))
        return TransformParse(matrix: matrix, diagnostics: diagnostics)
    }
}

// MARK: - flattening and the fill rules

extension CanvasCore {

    /// uniform in t, never adaptive: adaptive subdivision is per-implementation and would
    /// make the fill-rule corpus unpinnable
    public static let flattenSegments = 16

    /// every subpath, closed, as a point list
    public static func flatten(_ segments: [Segment]) -> [[(x: Double, y: Double)]] {
        var out: [[(x: Double, y: Double)]] = []
        var open = false
        var cx = 0.0, cy = 0.0, sx = 0.0, sy = 0.0
        func push(_ x: Double, _ y: Double) {
            if !open { out.append([]); open = true }
            out[out.count - 1].append((x, y))
        }
        for seg in segments {
            let v = seg.values
            switch seg.cmd {
            case "M":
                open = false
                cx = v[0]; cy = v[1]; sx = cx; sy = cy
                push(cx, cy)
            case "L":
                if !open { push(cx, cy) }
                cx = v[0]; cy = v[1]
                push(cx, cy)
            case "Q":
                if !open { push(cx, cy) }
                for i in 1...flattenSegments {
                    let t = Double(i) / Double(flattenSegments)
                    push(quadAt(cx, v[0], v[2], t), quadAt(cy, v[1], v[3], t))
                }
                cx = v[2]; cy = v[3]
            case "C":
                if !open { push(cx, cy) }
                for i in 1...flattenSegments {
                    let t = Double(i) / Double(flattenSegments)
                    push(cubicAt(cx, v[0], v[2], v[4], t), cubicAt(cy, v[1], v[3], v[5], t))
                }
                cx = v[4]; cy = v[5]
            default:
                cx = sx; cy = sy
                open = false
            }
        }
        return out.filter { $0.count > 1 }
    }

    /// the signed shoelace area of the FLATTENED path - positive is clockwise in the y-down
    /// canvas space. It pins the flattening itself, not just the inside/outside verdicts.
    public static func pathArea(_ segments: [Segment]) -> Double {
        var total = 0.0
        for sub in flatten(segments) {
            for i in 0..<sub.count {
                let a = sub[i]
                let b = sub[(i + 1) % sub.count]
                total += a.x * b.y - b.x * a.y
            }
        }
        return total / 2
    }

    static func crossings(_ segments: [Segment], _ px: Double, _ py: Double) -> (winding: Int, count: Int) {
        var winding = 0
        var count = 0
        for sub in flatten(segments) {
            for i in 0..<sub.count {
                let a = sub[i]
                let b = sub[(i + 1) % sub.count]
                let up = a.y <= py && py < b.y
                let down = b.y <= py && py < a.y
                if !up && !down { continue }
                let x = a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y)
                if x <= px { continue }
                count += 1
                winding += up ? 1 : -1
            }
        }
        return (winding, count)
    }

    /// the winding number at a point (half-open in y, crossings strictly right of the point)
    public static func windingAt(_ segments: [Segment], _ x: Double, _ y: Double) -> Int {
        crossings(segments, x, y).winding
    }

    public static func crossingsAt(_ segments: [Segment], _ x: Double, _ y: Double) -> Int {
        crossings(segments, x, y).count
    }

    /// is this point inside, under `rule`?
    public static func contains(_ segments: [Segment], _ x: Double, _ y: Double, _ rule: String) -> Bool {
        let c = crossings(segments, x, y)
        return rule == "evenodd" ? c.count % 2 == 1 : c.winding != 0
    }
}

// MARK: - colour

extension CanvasCore {

    /// a resolved paint. A SEMANTIC TOKEN survives the pure core UNRESOLVED - the theme
    /// resolves it at paint time, so the core must not bake it.
    public enum Paint: Equatable {
        case rgba(Double, Double, Double, Double)
        case token(String)
        case gradient(String)

        public static let black = Paint.rgba(0, 0, 0, 1)

        public var rgbaList: [Double]? {
            if case let .rgba(r, g, b, a) = self { return [r, g, b, a] }
            return nil
        }

        public var alpha: Double {
            if case let .rgba(_, _, _, a) = self { return a }
            return 1
        }
    }

    /// the semantic colour words (the StackStyle.color vocabulary) -> their web custom
    /// property. `clear` is the one word with no token: it is literally transparent.
    public static let colorTokens: [String: String] = [
        "clear": "transparent",
        "label": "--dsx-label",
        "text": "--dsx-label",
        "secondary": "--dsx-secondary-label",
        "secondaryLabel": "--dsx-secondary-label",
        "tertiary": "--dsx-tertiary-label",
        "tertiaryLabel": "--dsx-tertiary-label",
        "quaternary": "--dsx-tertiary-label",
        "accent": "--dsx-accent",
        "destructive": "--dsx-destructive",
        "separator": "--dsx-separator",
        "fill": "--dsx-fill",
        "fillFaint": "--dsx-fill",
        "background": "--dsx-background",
        "systemBackground": "--dsx-background",
        "secondaryBackground": "--dsx-secondary-background",
        "tertiaryBackground": "--dsx-tertiary-background",
        "groupedBackground": "--dsx-grouped-background",
        "secondaryGroupedBackground": "--dsx-secondary-grouped-background",
    ]

    static let literalWords: [String: Paint] = [
        "white": .rgba(1, 1, 1, 1),
        "black": .rgba(0, 0, 0, 1),
    ]

    /// `none` is the ABSENCE of a paint and is distinct from an unparseable one: none paints
    /// nothing with no diagnostic, garbage costs one diagnostic and falls back to black.
    public struct PaintParse {
        public let paint: Paint?
        public let ok: Bool
    }

    public static func parsePaint(_ input: String?) -> PaintParse {
        let raw = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return PaintParse(paint: nil, ok: false) }
        if raw == "none" || raw == "transparent" { return PaintParse(paint: nil, ok: true) }
        if raw.hasPrefix("url(") && raw.hasSuffix(")") {
            let inner = String(raw.dropFirst(4).dropLast())
                .trimmingCharacters(in: .whitespaces)
            if inner.hasPrefix("#") && inner.count > 1 {
                return PaintParse(paint: .gradient(String(inner.dropFirst())), ok: true)
            }
            return PaintParse(paint: nil, ok: false)
        }
        if let literal = literalWords[raw] { return PaintParse(paint: literal, ok: true) }
        if colorTokens[raw] != nil { return PaintParse(paint: .token(raw), ok: true) }
        if let rgba = parseRgba(raw) { return PaintParse(paint: rgba, ok: true) }
        return PaintParse(paint: nil, ok: false)
    }

    /// `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb(r,g,b)` / `rgba(r,g,b,a)`, in
    /// STRAIGHT (non-premultiplied) sRGB, components 0..1
    public static func parseRgba(_ input: String) -> Paint? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("#") {
            let hex = Array(raw.dropFirst())
            guard !hex.isEmpty, hex.allSatisfy({ $0.isHexDigit }) else { return nil }
            func wide(_ n: Int) -> Double {
                Double(UInt8(String([hex[n], hex[n]]), radix: 16) ?? 0) / 255
            }
            func pair(_ n: Int) -> Double {
                Double(UInt8(String([hex[n], hex[n + 1]]), radix: 16) ?? 0) / 255
            }
            switch hex.count {
            case 3: return .rgba(wide(0), wide(1), wide(2), 1)
            case 4: return .rgba(wide(0), wide(1), wide(2), wide(3))
            case 6: return .rgba(pair(0), pair(2), pair(4), 1)
            case 8: return .rgba(pair(0), pair(2), pair(4), pair(6))
            default: return nil
            }
        }
        guard let openIndex = raw.firstIndex(of: "("), raw.hasSuffix(")") else { return nil }
        let head = raw[raw.startIndex..<openIndex].lowercased()
        guard head == "rgb" || head == "rgba" else { return nil }
        let body = raw[raw.index(after: openIndex)..<raw.index(before: raw.endIndex)]
        let parts = body.components(separatedBy: CharacterSet(charactersIn: ",/ \t\n\r"))
            .filter { !$0.isEmpty }
        guard parts.count >= 3, parts.count <= 4 else { return nil }
        func channel(_ text: String) -> Double? {
            let value: Double?
            if text.hasSuffix("%") { value = Double(text.dropLast()).map { $0 * 2.55 } }
            else { value = Double(text) }
            guard let v = value, v.isFinite else { return nil }
            return min(1, max(0, v / 255))
        }
        guard let r = channel(parts[0]), let g = channel(parts[1]), let b = channel(parts[2]) else {
            return nil
        }
        var a = 1.0
        if parts.count == 4 {
            let text = parts[3]
            let value: Double?
            if text.hasSuffix("%") { value = Double(text.dropLast()).map { $0 / 100 } }
            else { value = Double(text) }
            guard let v = value, v.isFinite else { return nil }
            a = min(1, max(0, v))
        }
        return .rgba(r, g, b, a)
    }
}

// MARK: - gradients

extension CanvasCore {

    public struct StopInput {
        public let offset: Any?
        public let color: String?
        public let opacity: Any?

        public init(offset: Any?, color: String?, opacity: Any?) {
            self.offset = offset
            self.color = color
            self.opacity = opacity
        }
    }

    /// a normalized stop: an rgba stop has its `stop-opacity` already multiplied in; a TOKEN
    /// stop keeps the word and its opacity for the theme to resolve at paint time
    public struct Stop {
        public let offset: Double
        public let rgba: Paint?
        public let token: String?
        public let opacity: Double
    }

    public struct StopsParse {
        public let stops: [Stop]
        public let diagnostics: [String]
    }

    static func parseOffset(_ value: Any?) -> Double? {
        guard let value else { return nil }
        if let text = value as? String {
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { return nil }
            if trimmed.hasSuffix("%") {
                guard let parsed = Double(trimmed.dropLast()), parsed.isFinite else { return nil }
                return min(1, max(0, parsed / 100))
            }
            guard let parsed = Double(trimmed), parsed.isFinite else { return nil }
            return min(1, max(0, parsed))
        }
        let number = asDouble(value, Double.nan)
        return number.isFinite ? min(1, max(0, number)) : nil
    }

    /// THE LAW, in order: parse each offset (a number or a percentage) and CLAMP it into
    /// 0..1; a missing FIRST offset is 0 and a missing LAST is 1; a run of missing interior
    /// offsets spaces EVENLY between its two known neighbours; then walk left to right
    /// forcing MONOTONIC non-decreasing offsets (a decreasing offset is raised to its
    /// predecessor - never re-sorted, because author order is the paint order).
    public static func normalizeStops(_ input: [StopInput]) -> StopsParse {
        var diagnostics: [String] = []
        if input.isEmpty {
            diagnostics.append("canvas.gradient: no stops")
            return StopsParse(stops: [], diagnostics: diagnostics)
        }
        var offsets: [Double?] = input.map { parseOffset($0.offset) }
        if offsets[0] == nil { offsets[0] = 0 }
        if offsets[offsets.count - 1] == nil { offsets[offsets.count - 1] = 1 }
        var i = 0
        while i < offsets.count {
            if offsets[i] != nil { i += 1; continue }
            var j = i
            while j < offsets.count && offsets[j] == nil { j += 1 }
            let before = offsets[i - 1] ?? 0
            let after = offsets[j] ?? 1
            let span = Double(j - i + 1)
            for k in i..<j { offsets[k] = before + ((after - before) * Double(k - i + 1)) / span }
            i = j
        }
        var previous: Double?
        var stops: [Stop] = []
        for k in 0..<input.count {
            let raw = offsets[k] ?? 0
            let offset = previous == nil ? raw : max(raw, previous ?? raw)
            previous = offset
            let source = input[k]
            let opacity = source.opacity == nil ? 1 : min(1, max(0, asDouble(source.opacity, 1)))
            let parsed = parsePaint(source.color)
            switch parsed.paint {
            case let .token(word):
                stops.append(Stop(offset: offset, rgba: nil, token: word, opacity: opacity))
            case let .rgba(r, g, b, a):
                stops.append(Stop(offset: offset, rgba: .rgba(r, g, b, a * opacity),
                                  token: nil, opacity: opacity))
            default:
                if !parsed.ok {
                    diagnostics.append("canvas.gradient: unparseable colour '\(source.color ?? "")'")
                }
                stops.append(Stop(offset: offset, rgba: .rgba(0, 0, 0, opacity),
                                  token: nil, opacity: opacity))
            }
        }
        return StopsParse(stops: stops, diagnostics: diagnostics)
    }

    /// Sample the normalized stop list at t, interpolating componentwise in STRAIGHT
    /// (non-premultiplied) sRGB - not linear-light, not premultiplied, because that is what
    /// Canvas2D, CoreGraphics and Compose all do by default. Two stops at the SAME offset
    /// are a hard stop: the earlier stop owns the offset itself, the later one owns
    /// everything after it. A token stop cannot be sampled here - resolve the theme first.
    public static func sampleStops(_ stops: [Stop], _ t: Double) -> [Double]? {
        if stops.isEmpty { return nil }
        if t <= stops[0].offset { return stops[0].rgba?.rgbaList }
        var index = -1
        for i in 1..<stops.count where t <= stops[i].offset {
            index = i
            break
        }
        if index == -1 { return stops[stops.count - 1].rgba?.rgbaList }
        guard let a = stops[index - 1].rgba?.rgbaList, let b = stops[index].rgba?.rgbaList else {
            return nil
        }
        let span = stops[index].offset - stops[index - 1].offset
        let u = span <= 0 ? 1 : (t - stops[index - 1].offset) / span
        return [
            a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u,
            a[2] + (b[2] - a[2]) * u,
            a[3] + (b[3] - a[3]) * u,
        ]
    }

    /// the 1-D paint coordinate for each gradient kind. linear is the CLAMPED projection
    /// onto the axis, radial the clamped distance ratio, angular the turn fraction from
    /// `start`, measured with atan2 in the y-down canvas space and wrapped into the
    /// half-open unit turn: 0 inclusive, 1 exclusive.
    public static func gradientT(_ kind: String, _ geom: [Double], _ x: Double, _ y: Double) -> Double {
        func at(_ i: Int) -> Double { i < geom.count ? geom[i] : 0 }
        if kind == "linear" {
            let dx = at(2) - at(0)
            let dy = at(3) - at(1)
            let len2 = dx * dx + dy * dy
            if len2 == 0 { return 0 }
            return min(1, max(0, ((x - at(0)) * dx + (y - at(1)) * dy) / len2))
        }
        let cx = at(0)
        let cy = at(1)
        if kind == "radial" {
            let r = at(2)
            if r <= 0 { return 1 }
            return min(1, max(0, (((x - cx) * (x - cx) + (y - cy) * (y - cy)).squareRoot()) / r))
        }
        let deg = atan2(y - cy, x - cx) / degrees
        let turn = (deg - at(2)) / 360
        return turn - turn.rounded(.down)
    }

    public struct Gradient {
        public let kind: String
        public let geom: [Double]
        public let stops: [Stop]
    }
}

// MARK: - tier 1: the display list

extension CanvasCore {

    public struct MarkupNode {
        public let kind: String
        public let attrs: [String: Any]
        public let children: [MarkupNode]

        public init(kind: String, attrs: [String: Any] = [:], children: [MarkupNode] = []) {
            self.kind = kind
            self.attrs = attrs
            self.children = children
        }
    }

    public enum Effect {
        case blur(radius: Double)
        case shadow(dx: Double, dy: Double, radius: Double, color: Paint)
        case blend(mode: String)
    }

    public struct Clip {
        public let path: [Segment]
        public let transform: Matrix
    }

    /// ONE drawing op. The path is in LOCAL coordinates and the matrix rides beside it -
    /// never a baked path, because tier 1 is RETAINED and only the matrix changes when a
    /// transform animates. `kind` decides which optional fields are meaningful, exactly as
    /// the corpus op shape does.
    public struct Op {
        public var key: String
        public var kind: String
        public var transform: Matrix
        public var opacity: Double
        public var path: [Segment]?
        public var fill: Paint?
        public var stroke: Paint?
        public var strokeWidth: Double = 1
        public var fillRule: String = "nonzero"
        public var strokeLinecap: String = "butt"
        public var strokeLinejoin: String = "miter"
        public var text: String?
        public var x: Double = 0
        public var y: Double = 0
        public var width: Double?
        public var height: Double?
        public var fontSize: Double = 16
        public var textAnchor: String = "start"
        public var src: String?
        public var clip: Clip?
        public var effects: [Effect] = []
    }

    public struct DisplayList {
        public let ops: [Op]
        public let gradients: [String: Gradient]
        /// registration order: Swift dictionaries are unordered, and the SSR bytes are
        /// pinned, so the serialiser walks this instead of the dictionary
        public let gradientOrder: [String]
        public let diagnostics: [String]
    }

    static let shapeKinds: Set<String> = ["path", "rect", "circle", "ellipse", "line", "polygon", "polyline"]
    static let wrapperKinds: Set<String> = ["group", "blur", "shadow", "blend"]

    /// the ONE kind whose unstyled default fill is absent rather than SVG black: a line has
    /// no interior to fill
    static let unfilledKinds: Set<String> = ["line"]

    struct Inherited {
        var fill: Paint?
        var hasFill = false
        var stroke: Paint?
        var hasStroke = false
        var strokeWidth: Double?
        var fillRule: String?
        var strokeLinecap: String?
        var strokeLinejoin: String?
    }

    static func textAttr(_ node: MarkupNode, _ name: String) -> String? {
        guard let value = node.attrs[name] else { return nil }
        if let text = value as? String { return text }
        if let number = value as? Double { return String(number) }
        if let number = value as? Int { return String(number) }
        return String(describing: value)
    }

    static func numberAttr(_ node: MarkupNode, _ name: String, _ fallback: Double) -> Double {
        asDouble(node.attrs[name], fallback)
    }

    static func parsePoints(_ source: String) -> [(Double, Double)] {
        let words = source.components(separatedBy: CharacterSet(charactersIn: " \t\n\r,"))
            .filter { !$0.isEmpty }
        var out: [(Double, Double)] = []
        var i = 0
        while i + 1 < words.count {
            guard let x = Double(words[i]), let y = Double(words[i + 1]) else { break }
            out.append((x, y))
            i += 2
        }
        return out
    }

    /// rect/circle/ellipse/roundRect all become paths through the SAME arc->cubic converter
    /// as `d`, so a circle is four cubics with k = 4/3*tan(pi/8) on every renderer
    public static func rectPath(
        _ x: Double, _ y: Double, _ w: Double, _ h: Double, _ rxIn: Double, _ ryIn: Double
    ) -> [Segment] {
        let rx = min(abs(rxIn), abs(w) / 2)
        let ry = min(abs(ryIn), abs(h) / 2)
        if rx <= 0 || ry <= 0 {
            return [
                Segment("M", [x, y]),
                Segment("L", [x + w, y]),
                Segment("L", [x + w, y + h]),
                Segment("L", [x, y + h]),
                Segment("Z", []),
            ]
        }
        var out: [Segment] = [Segment("M", [x + rx, y]), Segment("L", [x + w - rx, y])]
        func corner(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
            out.append(contentsOf: arcToCubics(x1, y1, rx, ry, 0, 0, 1, x2, y2))
        }
        corner(x + w - rx, y, x + w, y + ry)
        out.append(Segment("L", [x + w, y + h - ry]))
        corner(x + w, y + h - ry, x + w - rx, y + h)
        out.append(Segment("L", [x + rx, y + h]))
        corner(x + rx, y + h, x, y + h - ry)
        out.append(Segment("L", [x, y + ry]))
        corner(x, y + ry, x + rx, y)
        out.append(Segment("Z", []))
        return out
    }

    public static func ellipsePath(_ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double) -> [Segment] {
        var out: [Segment] = [Segment("M", [cx + rx, cy])]
        out.append(contentsOf: arcCentreToCubics(cx, cy, rx, ry, 0, 0, 2 * Double.pi))
        out.append(Segment("Z", []))
        return out
    }

    static func shapePath(_ node: MarkupNode, _ diagnostics: inout [String]) -> [Segment] {
        switch node.kind {
        case "path":
            let parsed = parsePath(textAttr(node, "d"))
            diagnostics.append(contentsOf: parsed.diagnostics)
            return parsed.segments
        case "rect":
            let rxRaw = node.attrs["rx"]
            let ryRaw = node.attrs["ry"]
            let rx = rxRaw != nil ? asDouble(rxRaw, 0) : (ryRaw != nil ? asDouble(ryRaw, 0) : 0)
            let ry = ryRaw != nil ? asDouble(ryRaw, 0) : rx
            return rectPath(numberAttr(node, "x", 0), numberAttr(node, "y", 0),
                            numberAttr(node, "width", 0), numberAttr(node, "height", 0), rx, ry)
        case "circle":
            let r = numberAttr(node, "r", 0)
            return ellipsePath(numberAttr(node, "cx", 0), numberAttr(node, "cy", 0), r, r)
        case "ellipse":
            return ellipsePath(numberAttr(node, "cx", 0), numberAttr(node, "cy", 0),
                               numberAttr(node, "rx", 0), numberAttr(node, "ry", 0))
        case "line":
            return [
                Segment("M", [numberAttr(node, "x1", 0), numberAttr(node, "y1", 0)]),
                Segment("L", [numberAttr(node, "x2", 0), numberAttr(node, "y2", 0)]),
            ]
        case "polygon", "polyline":
            let points = parsePoints(textAttr(node, "points") ?? "")
            if points.isEmpty { return [] }
            var out: [Segment] = [Segment("M", [points[0].0, points[0].1])]
            for i in 1..<points.count { out.append(Segment("L", [points[i].0, points[i].1])) }
            if node.kind == "polygon" { out.append(Segment("Z", [])) }
            return out
        default:
            return []
        }
    }

    static func readInherited(
        _ node: MarkupNode, _ parent: Inherited, _ diagnostics: inout [String]
    ) -> Inherited {
        var next = parent
        func paint(_ name: String) -> (Bool, Paint?) {
            guard let raw = textAttr(node, name) else { return (false, nil) }
            let parsed = parsePaint(raw)
            if !parsed.ok {
                diagnostics.append("canvas.\(name): unparseable colour '\(raw)'")
                return (true, Paint.black)
            }
            return (true, parsed.paint)
        }
        let fillPair = paint("fill")
        if fillPair.0 { next.fill = fillPair.1; next.hasFill = true }
        let strokePair = paint("stroke")
        if strokePair.0 { next.stroke = strokePair.1; next.hasStroke = true }
        if node.attrs["strokeWidth"] != nil { next.strokeWidth = numberAttr(node, "strokeWidth", 1) }
        let rule = textAttr(node, "fillRule")
        if rule == "evenodd" || rule == "nonzero" { next.fillRule = rule }
        if let cap = textAttr(node, "strokeLinecap") { next.strokeLinecap = cap }
        if let join = textAttr(node, "strokeLinejoin") { next.strokeLinejoin = join }
        return next
    }

    static func clampUnit(_ v: Double) -> Double { min(1, max(0, v)) }

    static func registerGradient(
        _ node: MarkupNode, _ into: inout [String: Gradient], _ order: inout [String],
        _ diagnostics: inout [String]
    ) {
        guard let id = textAttr(node, "id"), !id.isEmpty else {
            diagnostics.append("canvas.gradient: a gradient needs an id")
            return
        }
        if into[id] == nil { order.append(id) }
        let word = textAttr(node, "kind") ?? "linear"
        let kind = (word == "radial" || word == "angular") ? word : "linear"
        var geom: [Double]
        if kind == "linear" {
            geom = [numberAttr(node, "x1", 0), numberAttr(node, "y1", 0),
                    numberAttr(node, "x2", 0), numberAttr(node, "y2", 0)]
        } else if kind == "radial" {
            geom = [numberAttr(node, "cx", 0), numberAttr(node, "cy", 0), numberAttr(node, "r", 0)]
        } else {
            geom = [numberAttr(node, "cx", 0), numberAttr(node, "cy", 0), numberAttr(node, "start", 0)]
        }
        let inputs = node.children.filter { $0.kind == "stop" }.map {
            StopInput(offset: $0.attrs["offset"], color: textAttr($0, "color"),
                      opacity: $0.attrs["opacity"])
        }
        let normalized = normalizeStops(inputs)
        diagnostics.append(contentsOf: normalized.diagnostics)
        into[id] = Gradient(kind: kind, geom: geom, stops: normalized.stops)
    }

    /// THE BUILD LAW: walk the children in document order; a wrapper (group / blur / shadow /
    /// blend) emits NO op and instead folds into its descendants - transform composes,
    /// opacity MULTIPLIES, paint attributes INHERIT, `clip` on a group rides every
    /// descendant op with the matrix in force where the clip was authored, and each effect
    /// wrapper APPENDS to the op's effect chain outermost-first. A `<gradient id>` child
    /// registers a paint and emits no op. An unknown child tag is one diagnostic and no op -
    /// a canvas draws, it does not lay out.
    ///
    /// THE KEY LAW (the `<list>` keying law verbatim): an authored `key` wins, an unkeyed
    /// node keys on its KIND plus its position among same-kind siblings, a duplicate gets
    /// the middot-n suffix in encounter order, and the key is PATH-PREFIXED by its
    /// ancestors' keys.
    public static func buildDisplayList(_ tree: [MarkupNode]) -> DisplayList {
        var ops: [Op] = []
        var gradients: [String: Gradient] = [:]
        var gradientOrder: [String] = []
        var diagnostics: [String] = []

        func walk(
            _ nodes: [MarkupNode], _ prefix: String, _ world: Matrix, _ opacity: Double,
            _ inherited: Inherited, _ effects: [Effect], _ clip: Clip?
        ) {
            var used = Set<String>()
            func keyFor(_ node: MarkupNode) -> String {
                let authored = textAttr(node, "key")
                let base = (authored?.isEmpty == false) ? authored! : node.kind
                var key = base
                var n = 1
                while used.contains(key) {
                    key = base + "\u{00B7}" + String(n)
                    n += 1
                }
                used.insert(key)
                return prefix.isEmpty ? key : prefix + "/" + key
            }

            for node in nodes {
                if node.kind == "gradient" {
                    registerGradient(node, &gradients, &gradientOrder, &diagnostics)
                    continue
                }
                if node.kind == "stop" { continue }
                let isWrapper = wrapperKinds.contains(node.kind)
                let isShape = shapeKinds.contains(node.kind)
                let isText = node.kind == "text"
                let isImage = node.kind == "image"
                if !isWrapper && !isShape && !isText && !isImage {
                    diagnostics.append("canvas: <\(node.kind)> is not a drawing primitive")
                    continue
                }

                let key = keyFor(node)
                let local = parseTransform(textAttr(node, "transform"))
                diagnostics.append(contentsOf: local.diagnostics)
                let nodeWorld = local.matrix.isIdentity ? world : matMul(world, local.matrix)
                let nodeOpacity = opacity * clampUnit(numberAttr(node, "opacity", 1))
                let nodeInherited = readInherited(node, inherited, &diagnostics)

                if isWrapper {
                    var nodeEffects = effects
                    if node.kind == "blur" {
                        nodeEffects.append(.blur(radius: numberAttr(node, "radius", 0)))
                    } else if node.kind == "shadow" {
                        let parsed = parsePaint(textAttr(node, "color") ?? "#000000")
                        nodeEffects.append(.shadow(
                            dx: numberAttr(node, "dx", 0), dy: numberAttr(node, "dy", 0),
                            radius: numberAttr(node, "radius", 0),
                            color: parsed.paint ?? Paint.black))
                    } else if node.kind == "blend" {
                        nodeEffects.append(.blend(mode: textAttr(node, "mode") ?? "normal"))
                    }
                    var nodeClip = clip
                    if let clipData = textAttr(node, "clip") {
                        let parsed = parsePath(clipData)
                        diagnostics.append(contentsOf: parsed.diagnostics)
                        // Nested clips are NOT intersected here: the innermost authored clip
                        // wins. Path intersection is a rasteriser job and no two agree on it.
                        nodeClip = Clip(path: parsed.segments, transform: nodeWorld)
                    }
                    walk(node.children, key, nodeWorld, nodeOpacity, nodeInherited, nodeEffects, nodeClip)
                    continue
                }

                var op = Op(key: key, kind: node.kind, transform: nodeWorld, opacity: nodeOpacity)
                if isText {
                    op.text = textAttr(node, "value") ?? ""
                    op.x = numberAttr(node, "x", 0)
                    op.y = numberAttr(node, "y", 0)
                    op.fontSize = numberAttr(node, "fontSize", 16)
                    op.textAnchor = textAttr(node, "textAnchor") ?? "start"
                    op.fill = nodeInherited.hasFill ? nodeInherited.fill : Paint.black
                } else if isImage {
                    op.src = textAttr(node, "src") ?? ""
                    op.x = numberAttr(node, "x", 0)
                    op.y = numberAttr(node, "y", 0)
                    op.width = node.attrs["width"] != nil ? numberAttr(node, "width", 0) : nil
                    op.height = node.attrs["height"] != nil ? numberAttr(node, "height", 0) : nil
                } else {
                    op.path = shapePath(node, &diagnostics)
                    op.fill = nodeInherited.hasFill
                        ? nodeInherited.fill
                        : (unfilledKinds.contains(node.kind) ? nil : Paint.black)
                    op.stroke = nodeInherited.hasStroke ? nodeInherited.stroke : nil
                    op.strokeWidth = nodeInherited.strokeWidth ?? 1
                    op.fillRule = nodeInherited.fillRule ?? "nonzero"
                    op.strokeLinecap = nodeInherited.strokeLinecap ?? "butt"
                    op.strokeLinejoin = nodeInherited.strokeLinejoin ?? "miter"
                }
                op.clip = clip
                op.effects = effects
                ops.append(op)
            }
        }

        walk(tree, "", Matrix.identity, 1, Inherited(), [], nil)
        return DisplayList(ops: ops, gradients: gradients, gradientOrder: gradientOrder,
                           diagnostics: diagnostics)
    }
}

// MARK: - the keyed diff

extension CanvasCore {

    public struct DiffEntry {
        public let op: String
        public let key: String
        public let to: Int?
        public let from: Int?
    }

    static func paintKey(_ paint: Paint?) -> String {
        switch paint {
        case .none: return "none"
        case let .some(.rgba(r, g, b, a)): return "rgba:\(r),\(g),\(b),\(a)"
        case let .some(.token(word)): return "token:\(word)"
        case let .some(.gradient(id)): return "gradient:\(id)"
        }
    }

    static func effectKey(_ effect: Effect) -> String {
        switch effect {
        case let .blur(radius): return "blur:\(radius)"
        case let .blend(mode): return "blend:\(mode)"
        case let .shadow(dx, dy, radius, color):
            return "shadow:\(dx),\(dy),\(radius)," + paintKey(color)
        }
    }

    static func segmentsKey(_ segments: [Segment]?) -> String {
        guard let segments else { return "nil" }
        return segments.map { $0.cmd + ":" + $0.values.map { String($0) }.joined(separator: ",") }
            .joined(separator: ";")
    }

    static func contentKey(_ op: Op) -> String {
        var parts: [String] = [op.kind, op.transform.list.map { String($0) }.joined(separator: ","),
                               String(op.opacity), segmentsKey(op.path),
                               paintKey(op.fill), paintKey(op.stroke),
                               String(op.strokeWidth), op.fillRule,
                               op.strokeLinecap, op.strokeLinejoin,
                               op.text ?? "nil", String(op.x), String(op.y),
                               op.width.map { String($0) } ?? "nil",
                               op.height.map { String($0) } ?? "nil",
                               String(op.fontSize), op.textAnchor, op.src ?? "nil"]
        if let clip = op.clip {
            parts.append(segmentsKey(clip.path))
            parts.append(clip.transform.list.map { String($0) }.joined(separator: ","))
        } else {
            parts.append("nil")
        }
        parts.append(op.effects.map { effectKey($0) }.joined(separator: ";"))
        return parts.joined(separator: "|")
    }

    /// the complement of a longest increasing subsequence of the retained previous indices,
    /// so a single item moved to the front is ONE move, not n
    static func longestIncreasing(_ values: [Int]) -> [Int] {
        if values.isEmpty { return [] }
        var tails: [Int] = []
        var parents = [Int](repeating: -1, count: values.count)
        for i in 0..<values.count {
            var lo = 0
            var hi = tails.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if values[tails[mid]] < values[i] { lo = mid + 1 } else { hi = mid }
            }
            if lo > 0 { parents[i] = tails[lo - 1] }
            if lo < tails.count { tails[lo] = i } else { tails.append(i) }
        }
        var out: [Int] = []
        var cursor = tails[tails.count - 1]
        while cursor != -1 {
            out.append(cursor)
            cursor = parents[cursor]
        }
        return out.reversed()
    }

    /// THE DIFF LAW: keys present on both sides KEEP their identity across reorder.
    public static func diffDisplayList(_ before: [Op], _ after: [Op]) -> [DiffEntry] {
        var beforeIndex: [String: Int] = [:]
        for (i, op) in before.enumerated() { beforeIndex[op.key] = i }
        let afterKeys = Set(after.map { $0.key })
        var out: [DiffEntry] = []
        for op in before where !afterKeys.contains(op.key) {
            out.append(DiffEntry(op: "remove", key: op.key, to: nil, from: nil))
        }
        var retained: [Int] = []
        var retainedAt: [Int] = []
        for (i, op) in after.enumerated() {
            if let previous = beforeIndex[op.key] {
                retained.append(previous)
                retainedAt.append(i)
            }
        }
        let stable = Set(longestIncreasing(retained).map { retainedAt[$0] })
        for (i, op) in after.enumerated() {
            guard let previous = beforeIndex[op.key] else {
                out.append(DiffEntry(op: "insert", key: op.key, to: i, from: nil))
                continue
            }
            if !stable.contains(i) {
                out.append(DiffEntry(op: "move", key: op.key, to: i, from: previous))
            } else if contentKey(before[previous]) == contentKey(op) {
                out.append(DiffEntry(op: "keep", key: op.key, to: i, from: nil))
            } else {
                out.append(DiffEntry(op: "update", key: op.key, to: i, from: nil))
            }
        }
        return out
    }
}

// MARK: - the SSR SVG serialisation

extension CanvasCore {

    /// round to 6 decimals and trim: the ONE number spelling the SVG bytes are pinned to.
    /// The rounding is floor(x + 0.5), matching JS `Math.round` and Kotlin `Math.round`
    /// exactly, so a negative tie folds the same way on all three renderers.
    public static func numberText(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        let rounded = (value * 1e6 + 0.5).rounded(.down) / 1e6
        if rounded == 0 { return "0" }
        if rounded == rounded.rounded(.towardZero) && abs(rounded) < 1e15 {
            return String(Int64(rounded))
        }
        var text = String(format: "%.6f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    /// `name(body)` built by concatenation so the repo's brace-balance backstop stays honest
    static func fnCall(_ name: String, _ body: String) -> String {
        name + "(" + body + ")"
    }

    static func hexByte(_ v: Double) -> String {
        let n = min(255, max(0, Int((v * 255).rounded())))
        let text = String(n, radix: 16)
        return n < 16 ? "0" + text : text
    }

    public static func rgbaHex(_ paint: Paint) -> String {
        guard case let .rgba(r, g, b, _) = paint else { return "#000000" }
        return "#" + hexByte(r) + hexByte(g) + hexByte(b)
    }

    static func paintText(_ paint: Paint?) -> String {
        guard let paint else { return "none" }
        switch paint {
        case .rgba: return rgbaHex(paint)
        case let .gradient(id): return fnCall("url", "#" + id)
        case let .token(word):
            guard let token = colorTokens[word], token != "transparent" else { return "transparent" }
            return fnCall("var", token)
        }
    }

    public static func escapeXml(_ source: String) -> String {
        source.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    static func pathText(_ segments: [Segment]) -> String {
        var parts: [String] = []
        for seg in segments {
            parts.append(seg.cmd)
            for v in seg.values { parts.append(numberText(v)) }
        }
        return parts.joined(separator: " ")
    }

    static func matrixText(_ m: Matrix) -> String {
        fnCall("matrix", m.list.map { numberText($0) }.joined(separator: ","))
    }

    static func attribute(_ name: String, _ value: String) -> String {
        name + "=\"" + value + "\""
    }

    /// The tier-1 tree renders SERVER-SIDE as SVG and hydrates onto a canvas with no repaint
    /// flash: a capability neither RN nor Flutter has, and it costs one serialiser.
    ///
    /// NAMED ABSENCE: SVG has no conic-gradient primitive, so an `angular` gradient
    /// serialises as a radialGradient with the same stops - the SSR frame approximates and
    /// the live canvas paints the real sweep. Everything else is byte-pinned by the corpus.
    public static func toSvg(_ list: DisplayList, _ width: Double, _ height: Double) -> String {
        var defs: [String] = []
        var fxCounter = 0
        func fxId() -> String {
            fxCounter += 1
            return "dsx-fx-" + String(fxCounter)
        }

        for id in list.gradientOrder {
            guard let gradient = list.gradients[id] else { continue }
            var stopText = ""
            for stop in gradient.stops {
                var bits: [String] = [attribute("offset", numberText(stop.offset))]
                if let rgba = stop.rgba, let list = rgba.rgbaList {
                    bits.append(attribute("stop-color", rgbaHex(rgba)))
                    if list[3] < 1 { bits.append(attribute("stop-opacity", numberText(list[3]))) }
                } else {
                    let token = colorTokens[stop.token ?? ""]
                    let spelling = (token == nil || token == "transparent")
                        ? "transparent" : fnCall("var", token ?? "")
                    bits.append(attribute("stop-color", spelling))
                    if stop.opacity < 1 {
                        bits.append(attribute("stop-opacity", numberText(stop.opacity)))
                    }
                }
                stopText += "<stop " + bits.joined(separator: " ") + "/>"
            }
            func g(_ i: Int) -> Double { i < gradient.geom.count ? gradient.geom[i] : 0 }
            if gradient.kind == "linear" {
                let bits = [attribute("id", id),
                            attribute("gradientUnits", "userSpaceOnUse"),
                            attribute("x1", numberText(g(0))), attribute("y1", numberText(g(1))),
                            attribute("x2", numberText(g(2))), attribute("y2", numberText(g(3)))]
                defs.append("<linearGradient " + bits.joined(separator: " ") + ">" + stopText
                            + "</linearGradient>")
            } else {
                let r = gradient.kind == "radial" ? g(2) : max(width, height) / 2
                let bits = [attribute("id", id),
                            attribute("gradientUnits", "userSpaceOnUse"),
                            attribute("cx", numberText(g(0))), attribute("cy", numberText(g(1))),
                            attribute("r", numberText(r))]
                defs.append("<radialGradient " + bits.joined(separator: " ") + ">" + stopText
                            + "</radialGradient>")
            }
        }

        var body = ""
        for op in list.ops {
            var inner: String
            if op.kind == "text" {
                var bits = [attribute("x", numberText(op.x)), attribute("y", numberText(op.y)),
                            attribute("font-size", numberText(op.fontSize)),
                            attribute("fill", paintText(op.fill))]
                let alpha = op.fill?.alpha ?? 1
                if alpha < 1 { bits.append(attribute("fill-opacity", numberText(alpha))) }
                bits.append(attribute("text-anchor", op.textAnchor))
                inner = "<text " + bits.joined(separator: " ") + ">" + escapeXml(op.text ?? "")
                    + "</text>"
            } else if op.kind == "image" {
                var bits = [attribute("x", numberText(op.x)), attribute("y", numberText(op.y))]
                if let w = op.width { bits.append(attribute("width", numberText(w))) }
                if let h = op.height { bits.append(attribute("height", numberText(h))) }
                bits.append(attribute("href", escapeXml(op.src ?? "")))
                inner = "<image " + bits.joined(separator: " ") + "/>"
            } else {
                var bits = [attribute("d", pathText(op.path ?? [])),
                            attribute("fill", paintText(op.fill))]
                let alpha = op.fill?.alpha ?? 1
                if alpha < 1 { bits.append(attribute("fill-opacity", numberText(alpha))) }
                if op.fillRule != "nonzero" { bits.append(attribute("fill-rule", op.fillRule)) }
                if let stroke = op.stroke {
                    bits.append(attribute("stroke", paintText(stroke)))
                    bits.append(attribute("stroke-width", numberText(op.strokeWidth)))
                    if stroke.alpha < 1 {
                        bits.append(attribute("stroke-opacity", numberText(stroke.alpha)))
                    }
                    if op.strokeLinecap != "butt" {
                        bits.append(attribute("stroke-linecap", op.strokeLinecap))
                    }
                    if op.strokeLinejoin != "miter" {
                        bits.append(attribute("stroke-linejoin", op.strokeLinejoin))
                    }
                }
                inner = "<path " + bits.joined(separator: " ") + "/>"
            }

            var wrap: [String] = []
            if !op.transform.isIdentity { wrap.append(attribute("transform", matrixText(op.transform))) }
            if op.opacity != 1 { wrap.append(attribute("opacity", numberText(op.opacity))) }
            if let clip = op.clip {
                let id = fxId()
                let clipTransform = clip.transform.isIdentity
                    ? "" : " " + attribute("transform", matrixText(clip.transform))
                defs.append("<clipPath " + attribute("id", id) + " "
                            + attribute("clipPathUnits", "userSpaceOnUse") + "><path "
                            + attribute("d", pathText(clip.path)) + clipTransform
                            + "/></clipPath>")
                wrap.append(attribute("clip-path", fnCall("url", "#" + id)))
            }
            if !wrap.isEmpty { inner = "<g " + wrap.joined(separator: " ") + ">" + inner + "</g>" }

            for effect in op.effects.reversed() {
                switch effect {
                case let .blend(mode):
                    inner = "<g " + attribute("style", "mix-blend-mode:" + mode) + ">" + inner
                        + "</g>"
                case let .blur(radius):
                    let id = fxId()
                    defs.append("<filter " + attribute("id", id) + "><feGaussianBlur "
                                + attribute("stdDeviation", numberText(radius / 2))
                                + "/></filter>")
                    inner = "<g " + attribute("filter", fnCall("url", "#" + id)) + ">" + inner
                        + "</g>"
                case let .shadow(dx, dy, radius, color):
                    let id = fxId()
                    let alpha = color.alpha
                    defs.append("<filter " + attribute("id", id) + "><feDropShadow "
                                + attribute("dx", numberText(dx)) + " "
                                + attribute("dy", numberText(dy)) + " "
                                + attribute("stdDeviation", numberText(radius / 2)) + " "
                                + attribute("flood-color", rgbaHex(color)) + " "
                                + attribute("flood-opacity", numberText(alpha))
                                + "/></filter>")
                    inner = "<g " + attribute("filter", fnCall("url", "#" + id)) + ">" + inner
                        + "</g>"
                }
            }
            body += inner
        }

        let defsText = defs.isEmpty ? "" : "<defs>" + defs.joined() + "</defs>"
        let head = [attribute("xmlns", "http://www.w3.org/2000/svg"),
                    attribute("width", numberText(width)),
                    attribute("height", numberText(height)),
                    attribute("viewBox", "0 0 " + numberText(width) + " " + numberText(height))]
        return "<svg " + head.joined(separator: " ") + ">" + defsText + body + "</svg>"
    }
}

// MARK: - tier 2: the command recorder

extension CanvasCore {

    public struct Shadow {
        public let dx: Double
        public let dy: Double
        public let radius: Double
        public let color: Paint
    }

    public struct ClipState {
        public let path: [Segment]
        public let rule: String
    }

    public struct DrawEntry {
        public var alpha: Double
        public var ctm: Matrix
        public var op: String
        public var clip: ClipState?
        public var shadow: Shadow?
        public var blend: String?
        public var path: [Segment]?
        public var rect: [Double]?
        public var src: String?
        public var text: String?
        public var x: Double?
        public var y: Double?
        public var width: Double?
        public var height: Double?
        public var style: Paint?
        public var fontSize: Double?
        public var rule: String?
        public var lineWidth: Double?
        public var cap: String?
        public var join: String?
    }

    public struct Measurement {
        public let text: String
        public let width: Double
        public let ascent: Double
        public let descent: Double
    }

    public struct ScriptResult {
        public let log: [DrawEntry]
        public let measurements: [Measurement]
        public let diagnostics: [String]
    }

    /// the fallback text metrics, pinned so the fallback itself cannot drift. A platform
    /// WITH real font metrics answers from them, and that divergence is documented, not
    /// silent.
    public static let fallbackAdvance = 0.6
    public static let fallbackAscent = 0.8
    public static let fallbackDescent = 0.2

    public static func fallbackMetrics(_ text: String, _ fontSize: Double) -> Measurement {
        Measurement(text: text,
                    width: fallbackAdvance * fontSize * Double(text.count),
                    ascent: fallbackAscent * fontSize,
                    descent: fallbackDescent * fontSize)
    }

    struct PaintState {
        var ctm = Matrix.identity
        var fill = Paint.black
        var stroke = Paint.black
        var lineWidth = 1.0
        var cap = "butt"
        var join = "miter"
        var alpha = 1.0
        var shadow: Shadow?
        var blend: String?
        var clip: ClipState?
        var fontSize = 10.0
    }

    /// The Canvas2D subset as a RECORDER: every call folds into a command stream a renderer
    /// replays, which is why this corpus is exact on all three renderers - it asserts the
    /// stream, never the pixels.
    ///
    /// (1) The CTM is baked into each path point AT POINT-ADD TIME - the Canvas2D rule, not
    /// the SVG one. (2) save/restore push and pop the matrix AND the paint state as one
    /// unit. (3) `arc` takes RADIANS (the Canvas2D signature authors know), `rotate` takes
    /// DEGREES (every other DSX angle). (4) A draw with an EMPTY path emits nothing at all.
    public final class Recorder {
        public private(set) var log: [DrawEntry] = []
        public private(set) var measurements: [Measurement] = []
        public private(set) var diagnostics: [String] = []

        private var state = PaintState()
        private var stack: [PaintState] = []
        private var path: [Segment] = []
        private var userX = 0.0
        private var userY = 0.0
        private var startX = 0.0
        private var startY = 0.0
        private var hasCurrent = false

        public init() {}

        public func run(_ script: [[Any?]]) -> ScriptResult {
            for command in script { call(command) }
            return ScriptResult(log: log, measurements: measurements, diagnostics: diagnostics)
        }

        private func bake(_ x: Double, _ y: Double) -> (Double, Double) {
            let p = CanvasCore.apply(state.ctm, x, y)
            return (p.x, p.y)
        }

        private func moveTo(_ x: Double, _ y: Double) {
            let p = bake(x, y)
            path.append(Segment("M", [p.0, p.1]))
            userX = x; userY = y; startX = x; startY = y; hasCurrent = true
        }

        private func lineTo(_ x: Double, _ y: Double) {
            if !hasCurrent { moveTo(x, y); return }
            let p = bake(x, y)
            path.append(Segment("L", [p.0, p.1]))
            userX = x; userY = y
        }

        private func head(_ op: String) -> DrawEntry {
            DrawEntry(alpha: state.alpha, ctm: state.ctm, op: op,
                      clip: state.clip, shadow: state.shadow, blend: state.blend)
        }

        private func numbers(_ command: [Any?], _ count: Int, _ from: Int = 1) -> [Double]? {
            var out: [Double] = []
            for i in 0..<count {
                let index = from + i
                guard index < command.count, let raw = command[index] else { return nil }
                let value = CanvasCore.asDouble(raw, Double.nan)
                guard value.isFinite else { return nil }
                out.append(value)
            }
            return out
        }

        private func stringArg(_ command: [Any?], _ index: Int) -> String? {
            guard index < command.count else { return nil }
            return command[index] as? String
        }

        private func call(_ command: [Any?]) {
            let name = stringArg(command, 0) ?? ""
            func missing() { diagnostics.append("canvas.ctx.\(name): missing argument") }
            switch name {
            case "beginPath":
                path = []
                hasCurrent = false
            case "closePath":
                if path.isEmpty { return }
                path.append(Segment("Z", []))
                userX = startX; userY = startY
            case "moveTo":
                guard let a = numbers(command, 2) else { missing(); return }
                moveTo(a[0], a[1])
            case "lineTo":
                guard let a = numbers(command, 2) else { missing(); return }
                lineTo(a[0], a[1])
            case "quadTo":
                guard let a = numbers(command, 4) else { missing(); return }
                if !hasCurrent { moveTo(a[0], a[1]) }
                let c = bake(a[0], a[1])
                let p = bake(a[2], a[3])
                path.append(Segment("Q", [c.0, c.1, p.0, p.1]))
                userX = a[2]; userY = a[3]
            case "cubicTo":
                guard let a = numbers(command, 6) else { missing(); return }
                if !hasCurrent { moveTo(a[0], a[1]) }
                let c1 = bake(a[0], a[1])
                let c2 = bake(a[2], a[3])
                let p = bake(a[4], a[5])
                path.append(Segment("C", [c1.0, c1.1, c2.0, c2.1, p.0, p.1]))
                userX = a[4]; userY = a[5]
            case "arc":
                guard let a = numbers(command, 5) else { missing(); return }
                let ccw = command.count > 6 ? (command[6] as? Bool ?? false) : false
                arc(a[0], a[1], a[2], a[3], a[4], ccw)
            case "arcTo":
                guard let a = numbers(command, 5) else { missing(); return }
                arcTo(a[0], a[1], a[2], a[3], a[4])
            case "rect":
                guard let a = numbers(command, 4) else { missing(); return }
                appendUserPath(CanvasCore.rectPath(a[0], a[1], a[2], a[3], 0, 0), a[0], a[1])
            case "roundRect":
                guard let a = numbers(command, 5) else { missing(); return }
                appendUserPath(CanvasCore.rectPath(a[0], a[1], a[2], a[3], a[4], a[4]), a[0], a[1])
            case "fill", "stroke":
                if path.isEmpty { return }
                var entry = head(name)
                entry.path = path
                if name == "fill" {
                    entry.style = state.fill
                    entry.rule = stringArg(command, 1) == "evenodd" ? "evenodd" : "nonzero"
                } else {
                    entry.style = state.stroke
                    entry.lineWidth = state.lineWidth
                    entry.cap = state.cap
                    entry.join = state.join
                }
                log.append(entry)
            case "clip":
                if path.isEmpty { return }
                let rule = stringArg(command, 1) == "evenodd" ? "evenodd" : "nonzero"
                state.clip = ClipState(path: path, rule: rule)
            case "clear":
                var entry = head("clear")
                entry.rect = numbers(command, 4)
                log.append(entry)
            case "save":
                stack.append(state)
            case "restore":
                guard let popped = stack.popLast() else {
                    diagnostics.append("canvas.ctx.restore: the state stack is empty")
                    return
                }
                state = popped
            case "translate":
                guard let a = numbers(command, 2) else { missing(); return }
                compose(Matrix(1, 0, 0, 1, a[0], a[1]))
            case "scale":
                guard let a = numbers(command, 2) else { missing(); return }
                compose(Matrix(a[0], 0, 0, a[1], 0, 0))
            case "rotate":
                guard let a = numbers(command, 1) else { missing(); return }
                let r = a[0] * CanvasCore.degrees
                compose(Matrix(cos(r), sin(r), -sin(r), cos(r), 0, 0))
            case "transform":
                guard let a = numbers(command, 6) else { missing(); return }
                compose(Matrix(a[0], a[1], a[2], a[3], a[4], a[5]))
            case "drawImage":
                guard let src = stringArg(command, 1), let a = numbers(command, 2, 2) else {
                    missing()
                    return
                }
                let size = numbers(command, 2, 4)
                var entry = head("drawImage")
                entry.src = src
                entry.x = a[0]
                entry.y = a[1]
                entry.width = size?[0]
                entry.height = size?[1]
                log.append(entry)
            case "fillText", "strokeText":
                guard let body = stringArg(command, 1), let a = numbers(command, 2, 2) else {
                    missing()
                    return
                }
                var entry = head(name)
                entry.text = body
                entry.x = a[0]
                entry.y = a[1]
                entry.style = name == "fillText" ? state.fill : state.stroke
                entry.fontSize = state.fontSize
                if name == "strokeText" { entry.lineWidth = state.lineWidth }
                log.append(entry)
            case "measureText":
                guard let body = stringArg(command, 1) else { missing(); return }
                measurements.append(CanvasCore.fallbackMetrics(body, state.fontSize))
            case "setFillStyle", "setStrokeStyle":
                guard let raw = stringArg(command, 1) else { missing(); return }
                let parsed = CanvasCore.parsePaint(raw)
                guard let paint = parsed.paint else {
                    if !parsed.ok {
                        diagnostics.append("canvas.ctx.\(name): unparseable colour '\(raw)'")
                    }
                    return
                }
                if name == "setFillStyle" { state.fill = paint } else { state.stroke = paint }
            case "setLineWidth":
                guard let a = numbers(command, 1) else { missing(); return }
                state.lineWidth = a[0]
            case "setLineCap":
                guard let raw = stringArg(command, 1) else { missing(); return }
                state.cap = raw
            case "setLineJoin":
                guard let raw = stringArg(command, 1) else { missing(); return }
                state.join = raw
            case "setShadow":
                guard let a = numbers(command, 3), let raw = stringArg(command, 4) else {
                    missing()
                    return
                }
                let parsed = CanvasCore.parsePaint(raw)
                state.shadow = Shadow(dx: a[0], dy: a[1], radius: a[2],
                                      color: parsed.paint ?? Paint.black)
            case "setBlendMode":
                guard let raw = stringArg(command, 1) else { missing(); return }
                state.blend = raw
            case "setGlobalAlpha":
                guard let a = numbers(command, 1) else { missing(); return }
                state.alpha = CanvasCore.clampUnit(a[0])
            case "setFont":
                guard let a = numbers(command, 1) else { missing(); return }
                state.fontSize = a[0]
            default:
                diagnostics.append("canvas.ctx: unknown method '\(name)'")
            }
        }

        private func compose(_ local: Matrix) {
            state.ctm = CanvasCore.matMul(state.ctm, local)
        }

        /// a user-space subpath, every point baked through the CTM as it is added
        private func appendUserPath(_ segments: [Segment], _ endX: Double, _ endY: Double) {
            appendUserCurves(segments)
            userX = endX; userY = endY; startX = endX; startY = endY; hasCurrent = true
        }

        private func appendUserCurves(_ segments: [Segment]) {
            for seg in segments {
                if seg.cmd == "Z" {
                    path.append(Segment("Z", []))
                    continue
                }
                var out: [Double] = []
                var i = 0
                while i < seg.values.count {
                    let p = bake(seg.values[i], seg.values[i + 1])
                    out.append(p.0)
                    out.append(p.1)
                    i += 2
                }
                path.append(Segment(seg.cmd, out))
            }
        }

        /// joins from the current point with a line, sweeps clockwise unless anticlockwise
        /// is set, clamps at a full turn, and folds to cubics through the same converter
        /// as `d`
        private func arc(_ cx: Double, _ cy: Double, _ r: Double,
                         _ a0: Double, _ a1: Double, _ ccw: Bool) {
            let px = cx + r * cos(a0)
            let py = cy + r * sin(a0)
            if hasCurrent { lineTo(px, py) } else { moveTo(px, py) }
            let full = 2 * Double.pi
            var delta = a1 - a0
            if !ccw {
                if delta >= full {
                    delta = full
                } else {
                    delta = delta.truncatingRemainder(dividingBy: full)
                    if delta < 0 { delta += full }
                }
            } else if delta <= -full {
                delta = -full
            } else {
                delta = delta.truncatingRemainder(dividingBy: full)
                if delta > 0 { delta -= full }
            }
            if delta == 0 { return }
            appendUserCurves(CanvasCore.arcCentreToCubics(cx, cy, r, r, 0, a0, delta))
            userX = cx + r * cos(a0 + delta)
            userY = cy + r * sin(a0 + delta)
        }

        private func arcTo(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ r: Double) {
            if !hasCurrent { moveTo(x1, y1); return }
            let v1x = userX - x1
            let v1y = userY - y1
            let v2x = x2 - x1
            let v2y = y2 - y1
            let l1 = (v1x * v1x + v1y * v1y).squareRoot()
            let l2 = (v2x * v2x + v2y * v2y).squareRoot()
            let cross = v1x * v2y - v1y * v2x
            if l1 == 0 || l2 == 0 || r <= 0 || abs(cross) < 1e-12 { lineTo(x1, y1); return }
            let u1x = v1x / l1, u1y = v1y / l1
            let u2x = v2x / l2, u2y = v2y / l2
            let angle = acos(min(1, max(-1, u1x * u2x + u1y * u2y)))
            let d = r / tan(angle / 2)
            let t1x = x1 + u1x * d, t1y = y1 + u1y * d
            let t2x = x1 + u2x * d, t2y = y1 + u2y * d
            var bx = u1x + u2x
            var by = u1y + u2y
            let bl = (bx * bx + by * by).squareRoot()
            if bl == 0 { lineTo(x1, y1); return }
            bx /= bl
            by /= bl
            let centreDistance = r / sin(angle / 2)
            let cx = x1 + bx * centreDistance
            let cy = y1 + by * centreDistance
            lineTo(t1x, t1y)
            let theta1 = atan2(t1y - cy, t1x - cx)
            let theta2 = atan2(t2y - cy, t2x - cx)
            var delta = theta2 - theta1
            while delta > Double.pi { delta -= 2 * Double.pi }
            while delta < -Double.pi { delta += 2 * Double.pi }
            appendUserCurves(CanvasCore.arcCentreToCubics(cx, cy, r, r, 0, theta1, delta))
            userX = t2x
            userY = t2y
        }
    }

    public static func runScript(_ script: [[Any?]]) -> ScriptResult {
        Recorder().run(script)
    }
}

// MARK: - `on:frame`: the display-link contract

extension CanvasCore {

    /// the 60/s budget - the SAME constant the scene kernel uses, deliberately shared
    public static let frameMinIntervalMs = 1000.0 / 60.0

    public struct FramePayload {
        public let time: Double
        public let delta: Double
        public let frame: Int
    }

    public struct FrameFold {
        public let emitted: [FramePayload]
        public let installs: Int
        public let uninstalls: Int
        public let installed: Bool
    }

    /// An always-running frame callback is a BATTERY BUG, so the law is enforced by fixture,
    /// not by intent. The loop is installed ONLY while an `on:frame` handler is bound AND
    /// the canvas is mounted AND it is on screen; ticks arriving while the loop is not
    /// installed are DROPPED, never queued; `delta` is 0 on the first tick after every
    /// install and `time` is accumulated delta, so it EXCLUDES offscreen intervals; `frame`
    /// counts emissions.
    public final class FrameLoop {
        private var bound: Bool
        private var mounted = false
        private var visible = true
        private var installedFlag = false
        private var lastEmitted: Double?
        private var time = 0.0
        private var frame = 0

        public private(set) var installs = 0
        public private(set) var uninstalls = 0

        public var installed: Bool { installedFlag }

        public init(bound: Bool) { self.bound = bound }

        public func setBound(_ value: Bool) { bound = value; settle() }
        public func setMounted(_ value: Bool) { mounted = value; settle() }
        public func setVisible(_ value: Bool) { visible = value; settle() }

        private func settle() {
            let want = bound && mounted && visible
            if want && !installedFlag {
                installedFlag = true
                installs += 1
                lastEmitted = nil
            } else if !want && installedFlag {
                installedFlag = false
                uninstalls += 1
            }
        }

        /// one raw platform tick (ms); the payload to emit, or nil when dropped or coalesced
        public func tick(_ nowMs: Double) -> FramePayload? {
            guard installedFlag else { return nil }
            guard let last = lastEmitted else {
                lastEmitted = nowMs
                let payload = FramePayload(time: time, delta: 0, frame: frame)
                frame += 1
                return payload
            }
            let gap = nowMs - last
            if gap < CanvasCore.frameMinIntervalMs { return nil }
            lastEmitted = nowMs
            let delta = gap / 1000
            time += delta
            let payload = FramePayload(time: time, delta: delta, frame: frame)
            frame += 1
            return payload
        }
    }

    /// the pure fold the corpus pins: a bound flag plus a lifecycle/tick event list
    public static func frameSchedule(_ bound: Bool, _ events: [[String: Any]]) -> FrameFold {
        let loop = FrameLoop(bound: bound)
        var emitted: [FramePayload] = []
        for event in events {
            switch event["type"] as? String ?? "" {
            case "mount": loop.setMounted(true)
            case "unmount": loop.setMounted(false)
            case "visible": loop.setVisible((event["value"] as? Bool) ?? false)
            case "tick":
                if let payload = loop.tick(asDouble(event["at"], 0)) { emitted.append(payload) }
            default: break
            }
        }
        return FrameFold(emitted: emitted, installs: loop.installs,
                         uninstalls: loop.uninstalls, installed: loop.installed)
    }
}

// MARK: - accessibility

extension CanvasCore {

    /// the gesture words that make a canvas INTERACTIVE. `on:draw` and `on:frame` are
    /// deliberately absent: a painted background is decorative.
    public static let gestureHandlers: [String] = [
        "on:tap", "on:doubletap", "on:longpress", "on:drag", "on:pan",
        "on:pinch", "on:rotate", "on:swipe", "on:press", "on:adjust",
    ]

    public static let a11yLintCode = "canvas-a11y-label"
    public static let a11yLintMessage =
        "<canvas> with a gesture handler needs a11yLabel \u{2014} a canvas is opaque to assistive tech"

    public struct A11yChild {
        public let role: String
        public let label: String
        public let value: String?
    }

    public struct A11yLint {
        public let code: String
        public let level: String
        public let message: String
    }

    public struct A11yVerdict {
        public let interactive: Bool
        public let label: String?
        public let children: [A11yChild]
        public let role: String
        public let hidden: Bool
        public let lint: A11yLint?
    }

    /// A canvas is OPAQUE to assistive tech by construction - there is no view tree to
    /// inspect, only pixels - so the semantics are declared or they do not exist. One fold,
    /// one rule, three surfaces: this is what all three renderers apply AND what
    /// `lint_dsx.rb` enforces.
    public static func a11y(
        _ attrs: [String: Any], _ a11yChildren: [[String: Any]]? = nil
    ) -> A11yVerdict {
        let interactive = gestureHandlers.contains { name in
            guard let raw = attrs[name] else { return false }
            return !String(describing: raw).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let trimmed = (attrs["a11yLabel"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let label: String? = trimmed.isEmpty ? nil : trimmed
        let children = (a11yChildren ?? []).map { child in
            A11yChild(role: child["role"] as? String ?? "image",
                      label: child["label"] as? String ?? "",
                      value: child["value"] as? String)
        }
        let declared = label != nil || !children.isEmpty
        let role: String
        if !children.isEmpty {
            role = "group"
        } else if interactive {
            role = label != nil ? "button" : "group"
        } else {
            role = label != nil ? "image" : "none"
        }
        return A11yVerdict(
            interactive: interactive,
            label: label,
            children: children,
            role: role,
            hidden: !interactive && !declared,
            lint: (interactive && !declared)
                ? A11yLint(code: a11yLintCode, level: "error", message: a11yLintMessage) : nil
        )
    }
}
