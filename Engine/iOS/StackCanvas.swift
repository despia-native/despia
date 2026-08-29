//
//  StackCanvas.swift - the iOS `<canvas>` element (parity/U04-canvas.md): the 2-D drawing
//  surface. Every NUMBER lives in the platform-neutral kernel (CanvasCore.swift - corpus
//  OpenSource/Conformance/canvas/, twins @despia-native/kernel canvas-core.ts and :core
//  CanvasCore.kt); this file only owns the SwiftUI adapter: a `Canvas` whose GraphicsContext
//  replays the kernel display list, the tier-2 command replay, the CADisplayLink loop under
//  the kernel's 60/s budget, and the declared accessibility overlay. No Skia dependency:
//  CoreGraphics IS the platform answer, which is the deliberate paragraph-3d decision.
//
//  TIER 1 is RETAINED: the child tree folds to a display list and the matrix rides beside each
//  path, so a transform animation repaints the same geometry under a new CTM instead of
//  rebuilding it. TIER 2 is IMMEDIATE: a `commands` list is replayed over the whole surface,
//  tier 1 painting first - the corpus pins the ordering.
//
//  TIER 2 IS A COMMAND LIST, NOT A LIVE `ctx` OBJECT. The corpus models it that way
//  - `tier2.json` `script` is an array of arrays - and the handler payload seam carries DATA,
//  not live handles, so the author builds commands and the renderer replays them through the
//  SAME kernel recorder all three renderers run. `on:draw` fires when the list changes so an
//  author can refresh it; it is a notification, never a mutable graphics handle.
//
//  Registered like the other structural elements: a PrivilegedStackComponent, because the
//  tier-1 child tree is a SUBTREE this element owns - Stack layout stops at `<canvas>`, and
//  its children are drawing primitives, never layout elements.
//
//  NAMED GAP: `<image>` and `drawImage` need the content plane's async fetch, which is not a
//  draw-thread call; the op is skipped rather than drawn from a blocking decode. Tracked with
//  the Android twin's identical gap.
//

import Foundation
import SwiftUI
import UIKit

// MARK: - Component

final class CanvasElement: PrivilegedStackComponent {
    override class var tag: String { "canvas" }

    override class func body(_ dsx: PrivilegedStackComponentContext) -> AnyView {
        AnyView(CanvasSurface(node: dsx.node, attrs: dsx.attrs, store: dsx.store,
                              env: dsx.env, item: dsx.item))
    }
}

// MARK: - The ink adapter

extension InkCore {
    /// The shared ops, replayed onto a SwiftUI path — the curve itself lives in the kernel.
    /// Declared here rather than in `InkCore.swift`, which stays Foundation-only.
    static func path(_ points: [InkCore.Point], in size: CGSize) -> Path {
        var path = Path()
        for op in InkCore.ops(points, Double(size.width), Double(size.height)) {
            switch op.verb {
            case .move: path.move(to: CGPoint(x: op.x, y: op.y))
            case .line: path.addLine(to: CGPoint(x: op.x, y: op.y))
            case .quad: path.addQuadCurve(to: CGPoint(x: op.x, y: op.y),
                                          control: CGPoint(x: op.cx, y: op.cy))
            }
        }
        return path
    }
}

// MARK: - The surface

private struct CanvasSurface: View {
    let node: StackNode
    let attrs: [String: String]
    @ObservedObject var store: StackStore
    let env: JSERunner
    let item: [String: Any]?

    @StateObject private var clock = CanvasDisplayClock()
    @State private var onScreen = true
    @State private var liveStroke: [InkCore.Point] = []
    @State private var surfaceSize: CGSize = .zero

    private var frameAction: String? {
        attrs["on:frame"].flatMap { $0.isEmpty ? nil : $0 }
    }

    private var drawAction: String? {
        attrs["on:draw"].flatMap { $0.isEmpty ? nil : $0 }
    }

    private var resolvedAttrs: [String: Any] {
        var out: [String: Any] = [:]
        for entry in attrs { out[entry.key] = JSE.interpolate(entry.value, store: store, item: item) }
        return out
    }

    private var overlay: [[String: Any]] {
        guard let raw = attrs["a11yChildren"],
              let rows = JSE.eval(raw, store: store, item: item) as? [Any] else { return [] }
        return rows.compactMap { $0 as? [String: Any] }
    }

    /// a tier-2 command list read off a bound expression: rows of [name, args...]. The shape is
    /// VERIFIED here, at the boundary, never asserted downstream.
    private var commands: [[Any?]] {
        guard let raw = attrs["commands"],
              let rows = JSE.eval(raw, store: store, item: item) as? [Any] else { return [] }
        var out: [[Any?]] = []
        for row in rows {
            guard let cells = row as? [Any], let head = cells.first as? String, !head.isEmpty else {
                continue
            }
            out.append(cells.map { $0 as Any? })
        }
        return out
    }

    private func displayList(_ size: CGSize) -> CanvasCore.DisplayList {
        CanvasCore.buildDisplayList(node.children.flatMap {
            CanvasSurface.expand($0, store: store, item: item, size: size)
        })
    }

    /// The editable ink child, if the surface declares one. A read-only child still PAINTS; it
    /// just installs no capture.
    private var ink: StackNode? { node.children.first { $0.tag == "ink" } }

    private var inkReadOnly: Bool {
        guard let raw = ink?.attrs["readOnly"] else { return false }
        return JSE.truthy(JSE.eval(raw, store: store, item: item))
    }

    private var inkWidth: Double {
        guard let raw = ink?.attrs["strokeWidth"] else { return InkCore.strokeWidth }
        return JSE.number(JSE.eval(raw, store: store, item: item)) ?? InkCore.strokeWidth
    }

    private var inkStroke: String {
        guard let raw = ink?.attrs["stroke"] else { return "label" }
        let text = JSE.interpolate(raw, store: store, item: item).trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? "label" : text
    }

    private var inkStrokes: [InkCore.Stroke] {
        guard let raw = ink?.attrs["bind"] else { return [] }
        return InkCore.decode(JSE.asRows(JSE.eval(raw, store: store, item: item)))
    }

    /// the authored subtree with every hole resolved against the live store. Unknown tags ride
    /// through untouched so the KERNEL emits the one Article-7 diagnostic, on every renderer at
    /// the same point.
    /// A child becomes ONE markup node, except `<ink>`, whose COMMITTED strokes become one
    /// stroked path each (canvas/ink.json) - in the surface's own point space, which is why the
    /// size is passed in. Only the in-flight stroke is transient paint; the value is tier 1.
    static func expand(_ node: StackNode, store: StackStore, item: [String: Any]?,
                       size: CGSize) -> [CanvasCore.MarkupNode] {
        if node.tag == "ink" {
            let strokes = node.attrs["bind"].map {
                InkCore.decode(JSE.asRows(JSE.eval($0, store: store, item: item)))
            } ?? []
            let paint = node.attrs["stroke"].map {
                JSE.interpolate($0, store: store, item: item).trimmingCharacters(in: .whitespaces)
            } ?? ""
            return InkCore.nodes(strokes, Double(size.width), Double(size.height),
                                 paint.isEmpty ? "label" : paint)
        }
        var resolved: [String: Any] = [:]
        for entry in node.attrs {
            resolved[entry.key] = JSE.interpolate(entry.value, store: store, item: item)
        }
        return [CanvasCore.MarkupNode(
            kind: node.tag,
            attrs: resolved,
            children: node.children.flatMap { expand($0, store: store, item: item, size: size) }
        )]
    }

    static func markup(_ node: StackNode, store: StackStore, item: [String: Any]?) -> CanvasCore.MarkupNode {
        var resolved: [String: Any] = [:]
        for entry in node.attrs {
            resolved[entry.key] = JSE.interpolate(entry.value, store: store, item: item)
        }
        return CanvasCore.MarkupNode(
            kind: node.tag,
            attrs: resolved,
            children: node.children.map { markup($0, store: store, item: item) }
        )
    }

    /// The pointer stream, natively. `begin` seeds the stroke, `move` coalesces against the
    /// shared floor, `end` writes the store ONCE and raises `on:strokeEnd`. `on:strokeStart` /
    /// `on:strokeEnd` ride the CANVAS element, beside `on:draw` and `on:frame` - the surface
    /// owns its events; `<ink>` owns the value.
    private var inkGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let box = surfaceSize
                let next = InkCore.point(Double(value.location.x), Double(value.location.y),
                                         Double(box.width), Double(box.height))
                guard let last = liveStroke.last else {
                    liveStroke = [next]
                    run("strokeStart", ["strokes": inkStrokes.count])
                    return
                }
                guard InkCore.farEnough(last, next, Double(box.width), Double(box.height)) else { return }
                liveStroke.append(next)
            }
            .onEnded { _ in
                let captured = liveStroke
                liveStroke = []
                guard !captured.isEmpty, let key = ink?.attrs["bind"] else { return }
                let committed = inkStrokes + [InkCore.Stroke(points: captured, width: inkWidth)]
                store.writeBound(JSE.normalizeScope(key), InkCore.encode(committed))
                run("strokeEnd", ["strokes": committed.count, "points": captured.count])
            }
    }

    /// Run one of this canvas's `on:<name>` handlers, the way `on:frame` already does.
    private func run(_ name: String, _ args: [String: Any]) {
        guard let action = attrs["on:\(name)"], !action.isEmpty else { return }
        env.run(action, item: item, args: args)
    }

    var body: some View {
        let verdict = CanvasCore.a11y(resolvedAttrs, overlay)
        let script = commands
        let strokes = inkStrokes
        let paint = StackStyle.color(inkStroke)
        let width = inkWidth
        let live = liveStroke
        return Canvas { context, size in
            let list = displayList(size)
            for op in list.ops { CanvasPainter.paint(op, list: list, into: &context) }
            if !script.isEmpty {
                let recorded = CanvasCore.runScript(script)
                for entry in recorded.log { CanvasPainter.replay(entry, size: size, into: &context) }
            }
            // THE IN-FLIGHT STROKE. View state, painted on top of the display list and never
            // written to the store: a moved finger must not rebuild a display list. The store
            // is written ONCE, on pointer-up.
            if !live.isEmpty {
                context.stroke(InkCore.path(live, in: size), with: .color(paint),
                               style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
            }
            _ = strokes
        }
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { surfaceSize = geo.size }
                    .dsxOnChange(of: geo.size) { newSize in surfaceSize = newSize }
            }
        )
        .contentShape(Rectangle())
        // `<ink>`'s pointer capture. The gesture is always attached and MASKED off unless the
        // surface declares an editable ink child, so an ordinary canvas keeps its own pointer
        // behaviour and no branch changes the view's type.
        .gesture(inkGesture, including: (ink != nil && !inkReadOnly) ? .all : .subviews)
        .onAppear {
            clock.bind(handler: frameAction, mounted: true, visible: onScreen) { payload in
                guard let action = frameAction else { return }
                env.run(action, item: item, args: [
                    "time": payload.time, "delta": payload.delta, "frame": payload.frame,
                ])
            }
            if let action = drawAction { env.run(action, item: item, args: [:]) }
        }
        .onDisappear { clock.bind(handler: frameAction, mounted: false, visible: onScreen) { _ in } }
        .modifier(CanvasVisibility { visible in
            onScreen = visible
            clock.setVisible(visible)
        })
        .modifier(CanvasSemantics(verdict: verdict))
    }
}

// MARK: - Visibility

/// The frame loop must stop when the canvas leaves the screen: an always-running display link
/// is a battery bug, and the corpus counts the installs. SwiftUI has no intersection observer,
/// so the geometry of the view against the screen IS the test.
private struct CanvasVisibility: ViewModifier {
    let onChange: (Bool) -> Void

    func body(content: Content) -> some View {
        content.background(
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                let screen = UIScreen.main.bounds
                let visible = frame.width > 0 && frame.height > 0 && frame.intersects(screen)
                Color.clear
                    .onAppear { onChange(visible) }
                    .dsxOnChange(of: visible) { now in onChange(now) }
            }
        )
    }
}

// MARK: - Accessibility

/// A canvas is OPAQUE to assistive tech by construction, so the semantics are declared or they
/// do not exist. The verdict is the kernel's - one fold, three surfaces.
private struct CanvasSemantics: ViewModifier {
    let verdict: CanvasCore.A11yVerdict

    func body(content: Content) -> some View {
        if verdict.hidden {
            return AnyView(content.accessibilityHidden(true))
        }
        var view = AnyView(content)
        if verdict.role == "button" {
            view = AnyView(view.accessibilityAddTraits(.isButton))
        } else if verdict.role == "image" {
            view = AnyView(view.accessibilityAddTraits(.isImage))
        }
        if let label = verdict.label {
            view = AnyView(view.accessibilityLabel(Text(label)))
        }
        if !verdict.children.isEmpty {
            // The declared overlay is the accessible bar-chart pattern: a canvas has no view
            // tree, so the author's rows become REAL accessibility elements in the order they
            // were declared, laid over the drawing and invisible to sighted users.
            view = AnyView(view.overlay(
                VStack(spacing: 0) {
                    ForEach(Array(verdict.children.enumerated()), id: \.offset) { entry in
                        Color.clear
                            .accessibilityElement()
                            .accessibilityLabel(Text(entry.element.label))
                            .accessibilityValue(Text(entry.element.value ?? ""))
                            .accessibilityAddTraits(entry.element.role == "button" ? .isButton : .isImage)
                    }
                }
                .allowsHitTesting(false)
            ))
            view = AnyView(view.accessibilityElement(children: .contain))
        }
        return view
    }
}

// MARK: - The display clock

/// The kernel owns the schedule law; this object owns the CADisplayLink that feeds it. The link
/// exists ONLY while a handler is bound AND the element is mounted AND it is on screen.
private final class CanvasDisplayClock: ObservableObject {
    private let loop = CanvasCore.FrameLoop(bound: false)
    private var link: CADisplayLink?
    private var sink: ((CanvasCore.FramePayload) -> Void)?

    func bind(handler: String?, mounted: Bool, visible: Bool,
              sink: @escaping (CanvasCore.FramePayload) -> Void) {
        self.sink = sink
        loop.setBound(handler != nil)
        loop.setVisible(visible)
        loop.setMounted(mounted)
        settle()
    }

    func setVisible(_ visible: Bool) {
        loop.setVisible(visible)
        settle()
    }

    private func settle() {
        if loop.installed, link == nil {
            let created = CADisplayLink(target: self, selector: #selector(step))
            created.add(to: .main, forMode: .common)
            link = created
        } else if !loop.installed, let existing = link {
            existing.invalidate()
            link = nil
        }
    }

    @objc private func step(_ sender: CADisplayLink) {
        guard let payload = loop.tick(sender.timestamp * 1000) else { return }
        sink?(payload)
    }

    deinit {
        link?.invalidate()
    }
}

// MARK: - The painter

private enum CanvasPainter {

    static func path(_ segments: [CanvasCore.Segment]) -> Path {
        var out = Path()
        for seg in segments {
            let v = seg.values
            switch seg.cmd {
            case "M": out.move(to: CGPoint(x: v[0], y: v[1]))
            case "L": out.addLine(to: CGPoint(x: v[0], y: v[1]))
            case "Q": out.addQuadCurve(to: CGPoint(x: v[2], y: v[3]),
                                       control: CGPoint(x: v[0], y: v[1]))
            case "C": out.addCurve(to: CGPoint(x: v[4], y: v[5]),
                                   control1: CGPoint(x: v[0], y: v[1]),
                                   control2: CGPoint(x: v[2], y: v[3]))
            default: out.closeSubpath()
            }
        }
        return out
    }

    static func transform(_ m: CanvasCore.Matrix) -> CGAffineTransform {
        CGAffineTransform(a: m.a, b: m.b, c: m.c, d: m.d, tx: m.e, ty: m.f)
    }

    /// a semantic token survives the kernel UNRESOLVED on purpose; the theme owns it, and on
    /// iOS the theme is the live trait environment through the ONE colour vocabulary
    static func color(_ paint: CanvasCore.Paint?) -> Color? {
        guard let paint else { return nil }
        switch paint {
        case let .rgba(r, g, b, a):
            return Color(.sRGB, red: r, green: g, blue: b, opacity: a)
        case let .token(word):
            return StackStyle.color(word)
        case .gradient:
            return nil
        }
    }

    static func shading(
        _ paint: CanvasCore.Paint?, list: CanvasCore.DisplayList
    ) -> GraphicsContext.Shading? {
        if case let .gradient(id) = paint {
            guard let gradient = list.gradients[id] else { return nil }
            return self.shading(for: gradient)
        }
        guard let resolved = color(paint) else { return nil }
        return .color(resolved)
    }

    static func shading(for gradient: CanvasCore.Gradient) -> GraphicsContext.Shading? {
        if gradient.stops.isEmpty { return nil }
        let stops: [Gradient.Stop] = gradient.stops.map { stop in
            let resolved: Color
            if let rgba = stop.rgba, let list = rgba.rgbaList {
                resolved = Color(.sRGB, red: list[0], green: list[1], blue: list[2], opacity: list[3])
            } else {
                resolved = StackStyle.color(stop.token ?? "label").opacity(stop.opacity)
            }
            return Gradient.Stop(color: resolved, location: min(1, max(0, stop.offset)))
        }
        let ramp = Gradient(stops: stops)
        func geom(_ i: Int) -> Double { i < gradient.geom.count ? gradient.geom[i] : 0 }
        switch gradient.kind {
        case "linear":
            return .linearGradient(ramp,
                                   startPoint: CGPoint(x: geom(0), y: geom(1)),
                                   endPoint: CGPoint(x: geom(2), y: geom(3)))
        case "radial":
            return .radialGradient(ramp,
                                   center: CGPoint(x: geom(0), y: geom(1)),
                                   startRadius: 0, endRadius: max(0.01, geom(2)))
        default:
            // SwiftUI ships a real conic sweep, so `angular` is not an approximation here.
            return .conicGradient(ramp,
                                  center: CGPoint(x: geom(0), y: geom(1)),
                                  angle: .degrees(geom(2)))
        }
    }

    static func strokeStyle(width: Double, cap: String, join: String) -> StrokeStyle {
        StrokeStyle(
            lineWidth: width,
            lineCap: cap == "round" ? .round : cap == "square" ? .square : .butt,
            lineJoin: join == "round" ? .round : join == "bevel" ? .bevel : .miter
        )
    }

    static func blend(_ mode: String) -> GraphicsContext.BlendMode? {
        switch mode {
        case "multiply": return .multiply
        case "screen": return .screen
        case "overlay": return .overlay
        case "darken": return .darken
        case "lighten": return .lighten
        case "difference": return .difference
        case "exclusion": return .exclusion
        case "hue": return .hue
        case "saturation": return .saturation
        case "color": return .color
        case "luminosity": return .luminosity
        default: return nil
        }
    }

    /// paint one display-list op into a scratch layer, so the op's clip, opacity, effects and
    /// matrix never leak into the next one
    static func paint(_ op: CanvasCore.Op, list: CanvasCore.DisplayList,
                      into context: inout GraphicsContext) {
        context.drawLayer { layer in
            layer.opacity = op.opacity
            for effect in op.effects {
                switch effect {
                case let .blur(radius):
                    layer.addFilter(.blur(radius: radius / 2))
                case let .shadow(dx, dy, radius, shadowColor):
                    let resolved = color(shadowColor) ?? .black
                    layer.addFilter(.shadow(color: resolved, radius: radius / 2, x: dx, y: dy))
                case let .blend(mode):
                    if let resolved = blend(mode) { layer.blendMode = resolved }
                }
            }
            if let clip = op.clip {
                layer.clip(to: path(clip.path).applying(transform(clip.transform)))
            }
            layer.transform = transform(op.transform)
            switch op.kind {
            case "text":
                guard let resolved = color(op.fill) else { return }
                let label = Text(op.text ?? "").font(.system(size: op.fontSize))
                let anchor: UnitPoint = op.textAnchor == "middle" ? .top
                    : op.textAnchor == "end" ? .topTrailing : .topLeading
                layer.draw(layer.resolve(label.foregroundColor(resolved)),
                           at: CGPoint(x: op.x, y: op.y), anchor: anchor)
            case "image":
                return   // the content plane owns the bytes; header gap note
            default:
                let shape = path(op.path ?? [])
                if let fill = shading(op.fill, list: list) {
                    layer.fill(shape, with: fill,
                               style: FillStyle(eoFill: op.fillRule == "evenodd"))
                }
                if let stroke = shading(op.stroke, list: list) {
                    layer.stroke(shape, with: stroke,
                                 style: strokeStyle(width: op.strokeWidth,
                                                    cap: op.strokeLinecap, join: op.strokeLinejoin))
                }
            }
        }
    }

    /// replay one recorded tier-2 entry. The kernel recorder has already baked the CTM into
    /// every path point, so the surface stays in device space.
    static func replay(_ entry: CanvasCore.DrawEntry, size: CGSize,
                       into context: inout GraphicsContext) {
        context.drawLayer { layer in
            layer.opacity = entry.alpha
            if let shadow = entry.shadow {
                let resolved = color(shadow.color) ?? .black
                layer.addFilter(.shadow(color: resolved, radius: shadow.radius / 2,
                                        x: shadow.dx, y: shadow.dy))
            }
            if let mode = entry.blend, let resolved = blend(mode) { layer.blendMode = resolved }
            if let clip = entry.clip {
                layer.clip(to: path(clip.path), style: FillStyle(eoFill: clip.rule == "evenodd"))
            }
            switch entry.op {
            case "fill":
                guard let fill = color(entry.style) else { return }
                layer.fill(path(entry.path ?? []), with: .color(fill),
                           style: FillStyle(eoFill: entry.rule == "evenodd"))
            case "stroke":
                guard let stroke = color(entry.style) else { return }
                layer.stroke(path(entry.path ?? []), with: .color(stroke),
                             style: strokeStyle(width: entry.lineWidth ?? 1,
                                                cap: entry.cap ?? "butt", join: entry.join ?? "miter"))
            case "clear":
                let rect = entry.rect
                let area = rect == nil
                    ? CGRect(origin: .zero, size: size)
                    : CGRect(x: rect![0], y: rect![1], width: rect![2], height: rect![3])
                layer.blendMode = .destinationOut
                layer.fill(Path(area), with: .color(.black))
            case "fillText", "strokeText":
                guard let resolved = color(entry.style) else { return }
                let label = Text(entry.text ?? "").font(.system(size: entry.fontSize ?? 10))
                layer.draw(layer.resolve(label.foregroundColor(resolved)),
                           at: CGPoint(x: entry.x ?? 0, y: entry.y ?? 0), anchor: .topLeading)
            default:
                return   // drawImage rides the content plane; header gap note
            }
        }
    }
}
