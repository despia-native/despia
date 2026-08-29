//
//  StackGradients.swift
//  DespiaScript
//
//  The U07 gradient LAYER — the six declared properties (`gradientType` · `gradientStops` ·
//  `gradientAngle` · `gradientCenter` · `gradientRadius` · `gradientPoints`) turned into the
//  SwiftUI paint, on top of the three legacy `gradientDir` tokens which keep working
//  unchanged.
//
//  The DECISION lives in ControlsCore (the shared pure core, corpus
//  OpenSource/Conformance/controls/gradients.json, three runtimes); this file is only the
//  PLUMBING, which is why the whole U07 gradient surface costs `Stack.swift` two lines:
//
//      if let layer = StackGradients.background(val) { v = AnyView(v.background(layer)) }
//
//  THE ANGLE CONVENTION is the corpus's: 0deg points UP and increases CLOCKWISE (CSS). SwiftUI
//  disagrees twice over — `UnitPoint` is a box-relative axis and `AngularGradient` starts at
//  three o'clock — so both conversions happen HERE, once, rather than at every call site:
//  the linear axis comes from the core as unit points, and the angular sweep is rotated back
//  by 90 degrees.
//
//  MESH DEGRADES HONESTLY. `MeshGradient` is iOS 18; below it, and anywhere the grid is
//  malformed, the paint is the corpus's DECLARED fallback — the base fill plus one soft radial
//  per control point, in row-major paint order — never a blank and never a silently different
//  look nobody wrote down.
//

import SwiftUI

enum StackGradients {

    /// The `.background(…)` layer for an element's gradient attributes, or nil when the element
    /// declares no gradient (or fewer than two colours, which is a flat fill and not a
    /// gradient — the caller paints nothing rather than a band of one colour).
    static func background(_ val: (String) -> String?) -> AnyView? {
        guard val("gradient") != nil || val("gradientPoints") != nil else { return nil }
        let resolved = ControlsCore.resolveGradient(
            gradient: val("gradient"),
            gradientType: val("gradientType"),
            gradientStops: val("gradientStops"),
            gradientAngle: val("gradientAngle"),
            gradientDir: val("gradientDir"),
            gradientCenter: val("gradientCenter"),
            gradientRadius: val("gradientRadius"),
            gradientPoints: val("gradientPoints")
        )
        return layer(resolved)
    }

    /// The paint for an already-resolved descriptor. Exposed so a component that resolves its
    /// own gradient (a gauge ramp, a masked sweep) paints the identical thing.
    static func layer(_ resolved: ControlsCore.Gradient) -> AnyView? {
        guard resolved.valid else { return nil }
        let stops = gradientStops(resolved)
        switch resolved.type {
        case "radial":
            return AnyView(GeometryReader { proxy in
                RadialGradient(
                    gradient: Gradient(stops: stops),
                    center: unitPoint(resolved.center),
                    startRadius: 0,
                    endRadius: max(proxy.size.width, proxy.size.height) * resolved.radius
                )
            })
        case "angular":
            // SwiftUI's sweep begins at three o'clock; the corpus convention begins at twelve.
            return AnyView(AngularGradient(
                gradient: Gradient(stops: stops),
                center: unitPoint(resolved.center),
                angle: .degrees(resolved.angle - 90)
            ))
        case "mesh":
            return meshLayer(resolved)
        default:
            return AnyView(LinearGradient(
                gradient: Gradient(stops: stops),
                startPoint: unitPoint(resolved.start),
                endPoint: unitPoint(resolved.end)
            ))
        }
    }

    private static func gradientStops(_ resolved: ControlsCore.Gradient) -> [Gradient.Stop] {
        resolved.colors.enumerated().map { index, token in
            let location = index < resolved.stops.count ? resolved.stops[index] : 0
            return Gradient.Stop(color: StackStyle.color(token), location: CGFloat(location))
        }
    }

    private static func unitPoint(_ point: ControlsCore.UnitPointValue) -> UnitPoint {
        UnitPoint(x: CGFloat(point.x), y: CGFloat(point.y))
    }

    /// The real mesh on iOS 18+, the corpus's declared degradation below it.
    private static func meshLayer(_ resolved: ControlsCore.Gradient) -> AnyView? {
        guard let mesh = resolved.mesh, let fallback = resolved.meshFallback else { return nil }
        if #available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, visionOS 2.0, *) {
            return AnyView(MeshGradient(
                width: mesh.columns,
                height: mesh.rows,
                points: mesh.points.map { SIMD2<Float>(Float($0.x), Float($0.y)) },
                colors: mesh.points.map { StackStyle.color($0.color) }
            ))
        }
        return AnyView(degradedMesh(fallback))
    }

    /// One soft radial per control point over the base fill, painted row-major — the pinned
    /// fallback, so "mesh degrades" is a specification a screenshot can be diffed against.
    private static func degradedMesh(_ fallback: ControlsCore.MeshFallback) -> some View {
        GeometryReader { proxy in
            let side = max(proxy.size.width, proxy.size.height)
            ZStack {
                StackStyle.color(fallback.base)
                ForEach(Array(fallback.layers.enumerated()), id: \.offset) { _, layer in
                    RadialGradient(
                        gradient: Gradient(colors: [
                            StackStyle.color(layer.color),
                            StackStyle.color(layer.color).opacity(0),
                        ]),
                        center: unitPoint(layer.center),
                        startRadius: 0,
                        endRadius: side * layer.radius
                    )
                }
            }
        }
    }
}
