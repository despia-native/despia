//
//  ParityCapture.swift — the NATIVE CAPTURE seam of the parity contract on iOS
//  (OpenSource/Conformance/parity/README.md, "The native capture planes"; the
//  Kotlin twin is Engine/Android render/ParityCapture.kt). The record lane's
//  specimen pass (ClosedSource/scripts/conformance/ParityRecord.swift) arms a
//  Session around a fixture render; StackNodeView's content chain consults it once
//  per element render, so every authored element that materializes reports its
//  settled geometry + the style facts the resolver produced for it. Disarmed
//  (session == nil — every production render), the cost is one static optional
//  read per element and nothing attaches.
//
//  StackNode is a VALUE type here (unlike the Kotlin twin's identity map), so the
//  comparable set is carried by a STAMP: ParityCapture.stamp walks the parsed
//  fixture tree and writes each authored node's source pre-order path into a
//  reserved attribute (`data-dsx-parity`). Only the record harness ever stamps, so
//  only the fixture's own authored nodes report — component internals and synthetic
//  nodes fall out naturally (platform anatomy, out of the comparable set by the
//  README's alignment rule). A node rendered more than once (bound list/grid rows)
//  records one entry per probe instance; the emitter orders repeats by settled
//  position and suffixes the path (`0.3.0~1`), exactly like the Kotlin twin.
//

import SwiftUI
import UIKit

enum ParityCapture {
    /// The reserved stamp attribute. Never authored; written only by `stamp`.
    static let pathKey = "data-dsx-parity"

    /// Head/declaration tags: registered, never boxed — the web plane has no host
    /// node for them either (the Kotlin twin's declarationTags).
    static let declarationTags: Set<String> = [
        "head", "event", "expects", "action", "api", "variable", "var", "let",
        "component", "formula", "script", "functions", "style", "watch", "attribute",
        "slot",
    ]

    /// The armed session, set ONLY by the record harness around a fixture render
    /// (main-thread renders; the harness arms, renders, settles, disarms).
    static var session: Session? = nil

    /// Stamp the authored tree with source pre-order paths. Child INDICES count every
    /// child (declaration siblings included) so paths agree with the Kotlin twin's
    /// indexing; declaration tags themselves are never stamped (they never box).
    static func stamp(_ node: StackNode, path: String = "0") -> StackNode {
        var copy = node
        if !declarationTags.contains(node.tag) {
            copy.attrs[pathKey] = path
        }
        copy.children = node.children.enumerated().map { index, child in
            stamp(child, path: "\(path).\(index)")
        }
        return copy
    }

    /// One probe instance's settled report: geometry in window points (CSS px 1:1)
    /// plus the RESOLVED attr strings the cascade produced (colors resolve to
    /// concrete rgb at emit, under the pass's committed scheme).
    struct Record {
        let path: String
        let tag: String
        let frame: CGRect
        let radius: Double
        let color: String?
        let background: String?
        let fontSize: Double?
        let fontWeight: String?
        let lineHeight: Double?
    }

    /// One measured node of the emitted plane — the web NodeMetrics twin.
    struct Measured {
        let path: String
        let tag: String
        let box: [Double]
        let radius: String
        let color: String
        let background: String
        let text: (size: String?, weight: String?, line: String?)?
    }

    final class Session {
        private var records: [UUID: Record] = [:]

        func report(slot: UUID, path: String, tag: String, frame: CGRect, attrs: [String: String]) {
            let fontSize = tag == "text" ? attrs["fontSize"].flatMap { Double($0) } : nil
            let lineHeight = fontSize.flatMap { fs in attrs["lineSpacing"].flatMap { Double($0) }.map { fs + $0 } }
            records[slot] = Record(
                path: path, tag: tag, frame: frame,
                radius: attrs["radius"].flatMap { Double($0) } ?? 0,
                color: attrs["color"],
                background: attrs["background"],
                fontSize: fontSize,
                fontWeight: tag == "text" ? attrs["fontWeight"] : nil,
                lineHeight: lineHeight
            )
        }

        var count: Int { records.count }

        /// Collapse the recorded probes into the ordered node list: source pre-order,
        /// repeats ordered by (y, x) with a `~k` appearance suffix; colors resolved
        /// under `style` (the pass's committed scheme).
        func measured(style: UIUserInterfaceStyle) -> [Measured] {
            var byPath: [String: [Record]] = [:]
            for r in records.values { byPath[r.path, default: []].append(r) }
            var out: [Measured] = []
            for (path, unordered) in byPath {
                let list = unordered.sorted { a, b in
                    a.frame.minY != b.frame.minY ? a.frame.minY < b.frame.minY : a.frame.minX < b.frame.minX
                }
                // A probe that re-attached in place reports one duplicate box — keep
                // distinct boxes only (real repeats occupy distinct positions).
                var distinct: [Record] = []
                for r in list where !distinct.contains(where: { $0.frame == r.frame }) { distinct.append(r) }
                for (k, r) in distinct.enumerated() {
                    let text: (size: String?, weight: String?, line: String?)? = r.tag == "text"
                        ? (r.fontSize.map(ParityCapture.formatPx), r.fontWeight, r.lineHeight.map(ParityCapture.formatPx))
                        : nil
                    out.append(Measured(
                        path: k == 0 ? path : "\(path)~\(k)",
                        tag: r.tag,
                        box: [round2(r.frame.minX), round2(r.frame.minY), round2(r.frame.width), round2(r.frame.height)],
                        radius: ParityCapture.formatPx(r.radius),
                        color: ParityCapture.cssColor(r.color ?? "label", style: style),
                        background: r.background.map { ParityCapture.cssColor($0, style: style) } ?? "rgba(0, 0, 0, 0)",
                        text: text
                    ))
                }
            }
            out.sort { ParityCapture.pathOrdered($0.path, $1.path) }
            return out
        }

        private func round2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }
    }

    /// The capture probe — attached by StackNodeView's content chain OUTSIDE the
    /// styled view, so the reported bounds are the element's full styled box (the
    /// getBoundingClientRect / onGloballyPositioned twin). GeometryReader content
    /// evaluates at layout time, so the reported frame is the settled one; the
    /// harness additionally requires two consecutive identical snapshots.
    struct Probe: View {
        let session: Session
        let path: String
        let tag: String
        let attrs: [String: String]
        @State private var slot = UUID()

        init(session: Session, path: String, tag: String, attrs: [String: String]) {
            self.session = session
            self.path = path
            self.tag = tag
            self.attrs = attrs
        }

        var body: some View {
            GeometryReader { proxy -> Color in
                session.report(slot: slot, path: path, tag: tag,
                               frame: proxy.frame(in: .global), attrs: attrs)
                return Color.clear
            }
        }
    }

    /// Numeric source-path order: `0.10` sorts after `0.2`, `~k` repeats after the base.
    static func pathOrdered(_ a: String, _ b: String) -> Bool {
        func parts(_ p: String) -> ([Int], Int) {
            let split = p.split(separator: "~", maxSplits: 1)
            let base = split[0].split(separator: ".").map { Int($0) ?? 0 }
            let repeatIndex = split.count > 1 ? (Int(split[1]) ?? 0) : 0
            return (base, repeatIndex)
        }
        let (pa, ka) = parts(a)
        let (pb, kb) = parts(b)
        for i in 0..<max(pa.count, pb.count) {
            guard i < pa.count else { return true }
            guard i < pb.count else { return false }
            if pa[i] != pb[i] { return pa[i] < pb[i] }
        }
        return ka < kb
    }

    static func formatPx(_ v: Double) -> String {
        let rounded = (v * 100).rounded() / 100
        return rounded == rounded.rounded(.down) && rounded.isFinite
            ? "\(Int(rounded))px"
            : "\(rounded)px"
    }

    /// Resolve a DSX color word/literal to concrete `rgb()`/`rgba()` under a scheme —
    /// the style engine's own resolver (StackStyle.color), resolved through UIKit's
    /// dynamic-color machinery so system slots answer per scheme.
    static func cssColor(_ raw: String, style: UIUserInterfaceStyle) -> String {
        let resolved = UIColor(StackStyle.color(raw))
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        func ch(_ v: CGFloat) -> Int { max(0, min(255, Int((v * 255).rounded()))) }
        if a >= 0.999 { return "rgb(\(ch(r)), \(ch(g)), \(ch(b)))" }
        let alpha = (Double(a) * 100).rounded() / 100
        return "rgba(\(ch(r)), \(ch(g)), \(ch(b)), \(alpha))"
    }
}
