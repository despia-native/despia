//
//  ScrollConformance.swift — the Swift runner for OpenSource/Conformance/scroll/, all seven files.
//
//  WHY IT EXISTS AS A NEW FILE. The corpus README has listed a Swift runner in its table since
//  U01 landed, and there was none: the TS lane ran the seven files per-PR, Kotlin ran them under
//  gradle, and the third column was a claim. A table that names a runner nobody wrote is worse
//  than an empty cell, because every later change reads it as covered — and the plane is the one
//  substrate where the two native renderers MUST agree with the browser to the last decimal,
//  since `--scroll-*` is resolved by their own twins rather than by a browser.
//
//  What it judges is the pure core (`ScrollLinked.swift`) and nothing else: geometry in, values
//  out. Observing the scroll view, driving the display link and writing the resolved values into
//  the render tree belong to StackScroll.swift and are not conformance.
//
//  Pure Foundation, no UIKit — the record lane runs headless.
//
import Foundation

enum ScrollLinkedConformance {

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static func fail(_ file: String, _ label: String, _ message: String) -> Failure {
        Failure(description: "scroll/\(file) — \(label): \(message)")
    }

    private static func cases(_ dir: URL, _ file: String) throws -> [[String: Any]] {
        let data = try Data(contentsOf: dir.appendingPathComponent(file))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["cases"] as? [[String: Any]], !list.isEmpty else {
            throw Failure(description: "scroll/\(file): no cases[]")
        }
        return list
    }

    private static func name(_ c: [String: Any]) -> String { c["name"] as? String ?? "(unnamed)" }

    /// JSON `null` arrives as `NSNull`, which is PRESENT to Swift's optional machinery and absent
    /// to the corpus author who wrote it. Several cases turn on exactly that distinction - an
    /// unrealised row is `"child": null` and must refuse - so every optional read goes through
    /// here rather than trusting the subscript.
    private static func present(_ any: Any?) -> Any? {
        guard let any = any, !(any is NSNull) else { return nil }
        return any
    }
    private static func map(_ any: Any?) -> [String: Any] { any as? [String: Any] ?? [:] }
    private static func num(_ any: Any?) -> Double { ScrollCore.finite(any) }

    private static func strings(_ any: Any?) -> [String: String] {
        map(any).compactMapValues { $0 as? String }
    }

    private static func frames(_ any: Any?) -> [ScrollChildFrame] {
        (any as? [[String: Any]] ?? []).map { ScrollChildFrame(start: num($0["start"]), length: num($0["length"])) }
    }

    private static func metrics(_ any: Any?) -> ScrollMetrics {
        let g = map(any)
        return ScrollCore.metrics(
            x: g["x"], y: g["y"],
            viewportWidth: g["viewportWidth"], viewportHeight: g["viewportHeight"],
            contentWidth: g["contentWidth"], contentHeight: g["contentHeight"])
    }

    /// Exact equality on purpose. Every published number has already been through `round4`, so a
    /// tolerance here would only hide the drift the corpus exists to catch.
    private static func same(
        _ got: Double, _ expected: Any?, _ file: String, _ label: String, _ field: String
    ) throws {
        let want = num(expected)
        if got != want { throw fail(file, label, "\(field) \(got) (expected \(want))") }
    }

    private static func same(
        _ got: String, _ expected: Any?, _ file: String, _ label: String, _ field: String
    ) throws {
        let want = expected as? String
        if got != want { throw fail(file, label, "\(field) \(got) (expected \(want ?? "nil"))") }
    }

    private static func same(
        _ got: Bool, _ expected: Any?, _ file: String, _ label: String, _ field: String
    ) throws {
        let want = expected as? Bool ?? false
        if got != want { throw fail(file, label, "\(field) \(got) (expected \(want))") }
    }

    private static func same(
        _ got: [String: String], _ expected: Any?, _ file: String, _ label: String
    ) throws {
        let want = strings(expected)
        if got != want {
            let missing = want.filter { got[$0.key] != $0.value }
            let extra = got.filter { want[$0.key] == nil }
            throw fail(file, label, "properties differ — wrong/missing \(missing), unexpected \(extra)")
        }
    }

    // ---------------------------------------------------------------- the seven files

    static func verify(corpusDir dir: URL) throws -> Int {
        var total = 0
        total += try verifyMetrics(dir)
        total += try verifyEvents(dir)
        total += try verifyImperative(dir)
        total += try verifySnap(dir)
        total += try verifyLinked(dir)
        total += try verifyCollapse(dir)
        total += try verifyConfig(dir)
        return total
    }

    private static func verifyMetrics(_ dir: URL) throws -> Int {
        let file = "metrics.json"
        let list = try cases(dir, file)
        for c in list {
            let label = name(c)
            let e = map(c["expect"])
            let m = metrics(c["geometry"])
            try same(m.x, e["x"], file, label, "x")
            try same(m.y, e["y"], file, label, "y")
            try same(m.maxX, e["maxX"], file, label, "maxX")
            try same(m.maxY, e["maxY"], file, label, "maxY")
            try same(m.progress, e["progress"], file, label, "progress")
            try same(m.progressX, e["progressX"], file, label, "progressX")
            try same(m.atTop, e["atTop"], file, label, "atTop")
            try same(m.atBottom, e["atBottom"], file, label, "atBottom")
            try same(m.atStart, e["atStart"], file, label, "atStart")
            try same(m.atEnd, e["atEnd"], file, label, "atEnd")
        }
        return list.count
    }

    private static func verifyEvents(_ dir: URL) throws -> Int {
        let file = "events.json"
        let list = try cases(dir, file)
        var motion = 0, coalesce = 0, reach = 0
        for c in list {
            let label = name(c)
            let e = map(c["expect"])
            if let previous = present(c["previous"]) {
                motion += 1
                let p = map(previous), n = map(c["next"])
                let got = ScrollCore.motion(
                    previous: ScrollSample(x: num(p["x"]), y: num(p["y"]), t: num(p["t"])),
                    next: ScrollSample(x: num(n["x"]), y: num(n["y"]), t: num(n["t"])),
                    previousDirection: c["previousDirection"] as? String)
                try same(got.dx, e["dx"], file, label, "dx")
                try same(got.dy, e["dy"], file, label, "dy")
                try same(got.velocityX, e["velocityX"], file, label, "velocityX")
                try same(got.velocityY, e["velocityY"], file, label, "velocityY")
                try same(got.velocity, e["velocity"], file, label, "velocity")
                try same(got.direction, e["direction"], file, label, "direction")
            } else if let samples = present(c["samples"]) as? [Any] {
                coalesce += 1
                let got = ScrollCore.coalesce(
                    samples: samples,
                    hasHandler: c["hasHandler"] as? Bool ?? false,
                    frameBudgetMs: num(c["frameBudgetMs"]))
                try same(Double(got.dispatches), e["dispatches"], file, label, "dispatches")
                let at = (e["at"] as? [Any] ?? []).map { num($0) }
                if got.at != at { throw fail(file, label, "dispatch times \(got.at) (expected \(at))") }
            } else {
                reach += 1
                let got = ScrollCore.reachEnd(
                    latched: c["latched"] as? Bool ?? false,
                    metrics: metrics(c["geometry"]),
                    threshold: c["threshold"],
                    axis: c["axis"] as? String ?? "vertical")
                try same(got.fire, e["fire"], file, label, "fire")
                try same(got.latched, e["latched"], file, label, "latched")
                try same(got.remaining, e["remaining"], file, label, "remaining")
            }
        }
        guard motion > 0, coalesce > 0, reach > 0 else {
            throw Failure(description: "scroll/\(file) lost one of its three groups")
        }
        return list.count
    }

    private static func verifyImperative(_ dir: URL) throws -> Int {
        let file = "imperative.json"
        let list = try cases(dir, file)
        for c in list {
            let label = name(c)
            let command = map(c["command"])
            let geometry = map(c["geometry"])
            let child = present(command["child"]).map { raw -> ScrollChildFrame in
                let f = map(raw)
                return ScrollChildFrame(start: num(f["start"]), length: num(f["length"]))
            }
            let got = ScrollCore.resolveCommand(
                kind: command["kind"] as? String ?? "",
                metrics: metrics(c["geometry"]),
                viewportWidth: geometry["viewportWidth"],
                viewportHeight: geometry["viewportHeight"],
                axis: c["axis"] as? String ?? "vertical",
                animated: command["animated"] as? Bool ?? true,
                toX: present(command["x"]).map { num($0) },
                toY: present(command["y"]).map { num($0) },
                child: child,
                align: command["align"] as? String ?? "nearest")
            guard let expect = present(c["expect"]) as? [String: Any] else {
                if got != nil { throw fail(file, label, "expected a refusal, got \(got!)") }
                continue
            }
            guard let target = got else { throw fail(file, label, "expected a target, got a refusal") }
            try same(target.x, expect["x"], file, label, "x")
            try same(target.y, expect["y"], file, label, "y")
            try same(target.animated, expect["animated"], file, label, "animated")
        }
        return list.count
    }

    private static func verifySnap(_ dir: URL) throws -> Int {
        let file = "snap.json"
        let list = try cases(dir, file)
        var snaps = 0, maintains = 0
        for c in list {
            let label = name(c)
            if let mode = present(c["mode"]) as? String {
                snaps += 1
                let got = ScrollCore.resolveSnap(
                    mode: mode, offset: c["offset"],
                    viewportLength: c["viewportLength"], contentLength: c["contentLength"],
                    children: frames(c["children"]), velocity: c["velocity"])
                guard let expect = present(c["expect"]) else {
                    if got != nil { throw fail(file, label, "expected no snap target, got \(got!)") }
                    continue
                }
                guard let target = got else { throw fail(file, label, "expected a snap target") }
                try same(target, expect, file, label, "target")
            } else {
                maintains += 1
                let e = map(c["expect"])
                let got = ScrollCore.maintainPosition(
                    offset: c["offset"], anchorBefore: c["anchorBefore"], anchorAfter: c["anchorAfter"],
                    viewportLength: c["viewportLength"], contentLength: c["contentLength"])
                try same(got.offset, e["offset"], file, label, "offset")
                try same(got.delta, e["delta"], file, label, "delta")
            }
        }
        guard snaps > 0, maintains > 0 else {
            throw Failure(description: "scroll/\(file) lost one of its two groups")
        }
        return list.count
    }

    private static func verifyLinked(_ dir: URL) throws -> Int {
        let file = "linked.json"
        let list = try cases(dir, file)
        var published = 0, namedPublished = 0, scopes = 0, evaluated = 0
        for c in list {
            let label = name(c)
            if let ref = present(c["ref"]) as? String {
                namedPublished += 1
                let got = ScrollCore.namedLinkedProperties(
                    ref: ref, axis: c["axis"] as? String ?? "vertical",
                    metrics: metrics(c["geometry"]), velocity: c["velocity"])
                try same(got, c["expect"], file, label)
            } else if present(c["geometry"]) != nil {
                published += 1
                let got = ScrollCore.linkedProperties(
                    axis: c["axis"] as? String ?? "vertical",
                    metrics: metrics(c["geometry"]), velocity: c["velocity"])
                try same(got, c["expect"], file, label)
            } else if let ancestors = present(c["ancestors"]) as? [[String: Any]] {
                scopes += 1
                let scope = ancestors.map {
                    ScrollLinkedAncestor(axis: $0["axis"] as? String ?? "vertical",
                                         properties: strings($0["properties"]))
                }
                let named = (c["named"] as? [[String: Any]] ?? []).map {
                    NamedScrollPlane(ref: $0["ref"] as? String ?? "", properties: strings($0["properties"]))
                }
                try same(ScrollCore.resolveLinkedScope(scope, named: named), c["expect"], file, label)
            } else {
                evaluated += 1
                let got = ScrollCore.evaluateLinked(
                    c["expression"] as? String ?? "", properties: strings(c["properties"]))
                let want = c["expect"] as? String
                if got != want {
                    throw fail(file, label, "\(got ?? "nil") (expected \(want ?? "nil"))")
                }
            }
        }
        guard published > 0, namedPublished > 0, scopes > 0, evaluated > 0 else {
            throw Failure(description: "scroll/\(file) lost one of its four groups")
        }
        return list.count
    }

    private static func verifyCollapse(_ dir: URL) throws -> Int {
        let file = "collapse.json"
        let list = try cases(dir, file)
        var states = 0, emits = 0
        for c in list {
            let label = name(c)
            let e = map(c["expect"])
            if let raw = present(c["input"]) {
                states += 1
                let i = map(raw)
                let got = ScrollCore.collapse(
                    scrollY: i["scrollY"],
                    height: i["height"] ?? 280.0,
                    minHeight: i["minHeight"] ?? ScrollCore.navBarHeight,
                    pinnedHeight: i["pinnedHeight"] ?? 0.0,
                    parallax: i["parallax"] ?? 0.5,
                    stretch: i["stretch"] as? Bool ?? true,
                    blurOnCollapse: i["blurOnCollapse"] as? Bool ?? false,
                    titleTransition: i["titleTransition"] as? String ?? "move",
                    reduceMotion: i["reduceMotion"] as? Bool ?? false)
                try same(got.fraction, e["fraction"], file, label, "fraction")
                try same(got.headerHeight, e["headerHeight"], file, label, "headerHeight")
                try same(got.effectiveMinHeight, e["effectiveMinHeight"], file, label, "effectiveMinHeight")
                try same(got.imageTranslation, e["imageTranslation"], file, label, "imageTranslation")
                try same(got.imageScale, e["imageScale"], file, label, "imageScale")
                try same(got.effectiveParallax, e["effectiveParallax"], file, label, "effectiveParallax")
                try same(got.headerTitleOpacity, e["headerTitleOpacity"], file, label, "headerTitleOpacity")
                try same(got.navBarTitleOpacity, e["navBarTitleOpacity"], file, label, "navBarTitleOpacity")
                try same(got.titleOwner, e["titleOwner"], file, label, "titleOwner")
                try same(got.blurRadius, e["blurRadius"], file, label, "blurRadius")
                try same(got.pinnedOffset, e["pinnedOffset"], file, label, "pinnedOffset")
            } else {
                emits += 1
                let previous = present(c["previousFraction"])
                let got = ScrollCore.shouldEmitCollapse(
                    previousFraction: previous == nil ? nil : num(previous),
                    fraction: num(c["fraction"]))
                try same(got, e["emit"], file, label, "emit")
            }
        }
        guard states > 0, emits > 0 else {
            throw Failure(description: "scroll/\(file) lost one of its two groups")
        }
        return list.count
    }

    private static func verifyConfig(_ dir: URL) throws -> Int {
        let file = "config.json"
        let list = try cases(dir, file)
        for c in list {
            let label = name(c)
            let e = map(c["expect"])
            var attributes: [String: String?] = [:]
            for (key, value) in map(c["attributes"]) { attributes[key] = value as? String }
            let got = ScrollCore.parseConfig(attributes)
            try same(got.axis, e["axis"], file, label, "axis")
            if got.bind != e["bind"] as? String {
                throw fail(file, label, "bind \(got.bind ?? "nil")")
            }
            try same(got.indicators, e["indicators"], file, label, "indicators")
            if got.bounces != e["bounces"] as? Bool {
                throw fail(file, label, "bounces \(String(describing: got.bounces)) — the tristate is "
                    + "the point: unset means the PLATFORM decides")
            }
            try same(got.paging, e["paging"], file, label, "paging")
            try same(got.snap, e["snap"], file, label, "snap")
            try same(got.keyboardDismiss, e["keyboardDismiss"], file, label, "keyboardDismiss")
            try same(got.overscroll, e["overscroll"], file, label, "overscroll")
            try same(got.maintainPosition, e["maintainPosition"], file, label, "maintainPosition")
            try same(got.threshold, e["threshold"], file, label, "threshold")
            let inset = map(e["contentInset"])
            let want = ScrollEdgeInsets(
                top: num(inset["top"]), right: num(inset["right"]),
                bottom: num(inset["bottom"]), left: num(inset["left"]))
            if got.contentInset != want {
                throw fail(file, label, "contentInset \(got.contentInset) (expected \(want))")
            }
        }
        return list.count
    }

    // ---------------------------------------------------------------- what the corpus cannot state

    /// Three properties no table of cases can express, because each is a claim about ALL inputs.
    /// They are the ones a renderer is tempted to break, so they are asserted here rather than
    /// trusted: no handler means no dispatch at any sample rate, the metrics fold is total under
    /// hostile geometry, and `reachEnd` fires once per crossing rather than once per frame at the
    /// rail (the classic duplicate-page bug).
    static func verifyInvariants() throws -> Int {
        let train: [Any?] = (0..<600).map { Double($0 * 4) }
        for budget in [ScrollCore.frameBudgetMs, 0.0] {
            let got = ScrollCore.coalesce(samples: train, hasHandler: false, frameBudgetMs: budget)
            if got.dispatches != 0 {
                throw Failure(description: "scroll/invariants: \(got.dispatches) dispatches with no "
                    + "handler bound — the whole performance contract is that this is zero")
            }
        }

        let wild = [Double.nan, .infinity, -.infinity, -1e9, 0, 1e9]
        for y in wild {
            for contentHeight in wild {
                for viewportHeight in [0.0, 800.0] {
                    let m = ScrollCore.metrics(
                        x: 0, y: y, viewportWidth: 390, viewportHeight: viewportHeight,
                        contentWidth: 390, contentHeight: contentHeight)
                    guard m.progress >= 0, m.progress <= 1, m.maxY >= 0,
                          m.y.isFinite, m.progress.isFinite else {
                        throw Failure(description: "scroll/invariants: metrics escaped their range "
                            + "for y \(y), content \(contentHeight)")
                    }
                }
            }
        }

        var latched = false
        var fired = 0
        for y: Double in [0, 400, 900, 1200, 1200, 1200, 1199.9, 1200] {
            let state = ScrollCore.reachEnd(
                latched: latched,
                metrics: ScrollCore.metrics(x: 0, y: y, viewportWidth: 390, viewportHeight: 800,
                                            contentWidth: 390, contentHeight: 2000),
                threshold: 0, axis: "vertical")
            if state.fire { fired += 1 }
            latched = state.latched
        }
        guard fired == 1 else {
            throw Failure(description: "scroll/invariants: reachEnd fired \(fired) times for one "
                + "crossing — the latch is what stops the duplicate-page bug")
        }
        return 3
    }
}
