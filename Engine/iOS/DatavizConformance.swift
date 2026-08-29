//
//  DatavizConformance.swift — the record-lane leg of the dataviz corpus: runs
//  `OpenSource/Conformance/dataviz/` (all SIX files — scales · marks · interaction · a11y ·
//  camera · cluster) through THIS renderer's Dataviz core (parity/U09-dataviz.md).
//
//  The TS runner (@despia-native/kernel dataviz-conformance.test.ts) and the Kotlin twin
//  (`:core` DatavizConformanceTest) execute the SAME files, so a chart cannot put a datum in
//  one place on one renderer and somewhere else on another, five hundred pins cannot group two
//  ways at the same zoom, and the accessible table cannot say something the picture does not.
//
//  Foundation-only by contract, like the rest of ConformanceHosts: the recorder binary runs it
//  headless. Returns the number of cases verified; throws on the FIRST mismatch, and on a
//  malformed or missing corpus — a silently-skipped suite is how drift starts.
//
import Foundation

public enum DatavizConformance {
    public struct Failure: Error, CustomStringConvertible { public let description: String }

    private static let tolerance = 1e-9

    /// Run every file in the corpus directory. The count is cases, not assertions.
    public static func verify(corpusDir: URL) throws -> Int {
        let scales = try verifyScales(corpusDir.appendingPathComponent("scales.json"))
        let marks = try verifyMarks(corpusDir.appendingPathComponent("marks.json"))
        let interaction = try verifyInteraction(
            corpusDir.appendingPathComponent("interaction.json")
        )
        let a11y = try verifyAccessibleTable(corpusDir.appendingPathComponent("a11y.json"))
        let camera = try verifyCamera(corpusDir.appendingPathComponent("camera.json"))
        let cluster = try verifyCluster(corpusDir.appendingPathComponent("cluster.json"))
        return scales + marks + interaction + a11y + camera + cluster
    }

    // MARK: - corpus plumbing

    private static func document(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Failure(description: "\(url.lastPathComponent): not a JSON object")
        }
        guard let version = num(doc["version"]), Int(version) == 1 else {
            throw Failure(description: "\(url.lastPathComponent): version")
        }
        return doc
    }

    private static func section(
        _ doc: [String: Any], _ file: String, _ key: String
    ) throws -> [[String: Any]] {
        guard let rows = doc[key] as? [[String: Any]], !rows.isEmpty else {
            throw Failure(description: "\(file): \(key)[] must not be empty")
        }
        return rows
    }

    private static func num(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { return n.doubleValue }
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        return nil
    }

    private static func double(_ value: Any?, _ label: String) throws -> Double {
        guard let d = num(value) else { throw Failure(description: "\(label): not a number") }
        return d
    }

    private static func int(_ value: Any?, _ label: String) throws -> Int {
        Int(try double(value, label))
    }

    private static func bool(_ value: Any?, _ label: String) throws -> Bool {
        guard let b = value as? Bool ?? (value as? NSNumber)?.boolValue else {
            throw Failure(description: "\(label): not a boolean")
        }
        return b
    }

    private static func text(_ value: Any?, _ label: String) throws -> String {
        guard let s = value as? String else { throw Failure(description: "\(label): not a string") }
        return s
    }

    private static func doubles(_ value: Any?, _ label: String) throws -> [Double] {
        guard let list = value as? [Any] else { throw Failure(description: "\(label): not a list") }
        return try list.map { try double($0, label) }
    }

    private static func object(_ value: Any?, _ label: String) throws -> [String: Any] {
        guard let o = value as? [String: Any] else {
            throw Failure(description: "\(label): not an object")
        }
        return o
    }

    private static func objects(_ value: Any?, _ label: String) throws -> [[String: Any]] {
        guard let o = value as? [[String: Any]] else {
            throw Failure(description: "\(label): not a list of objects")
        }
        return o
    }

    private static func close(_ actual: Double, _ expected: Double, _ label: String) throws {
        guard actual.isFinite, abs(actual - expected) <= tolerance else {
            throw Failure(description: "\(label): \(actual) != \(expected)")
        }
    }

    private static func closeList(
        _ actual: [Double], _ expected: [Double], _ label: String
    ) throws {
        guard actual.count == expected.count else {
            throw Failure(
                description: "\(label): \(actual.count) values (expected \(expected.count))"
            )
        }
        for i in expected.indices { try close(actual[i], expected[i], "\(label)[\(i)]") }
    }

    private static func same<T: Equatable>(_ actual: T, _ expected: T, _ label: String) throws {
        guard actual == expected else {
            throw Failure(description: "\(label): \(actual) != \(expected)")
        }
    }

    // MARK: - scales.json

    private static func verifyDomain(
        _ got: Dataviz.NiceDomain, _ expect: [String: Any], _ at: String
    ) throws {
        try close(got.lo, try double(expect["lo"], at), "\(at): lo")
        try close(got.hi, try double(expect["hi"], at), "\(at): hi")
        try close(got.step, try double(expect["step"], at), "\(at): step")
        try closeList(got.ticks, try doubles(expect["ticks"], at), "\(at): ticks")
    }

    private static func verifyScales(_ url: URL) throws -> Int {
        let file = "dataviz/scales.json"
        let doc = try document(url)
        var count = 0

        for c in try section(doc, file, "decExp") {
            let at = "\(file)/decExp/\(try text(c["name"], file))"
            try same(
                Dataviz.decimalExponent(try double(c["x"], at)),
                try int(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "pow10") {
            let at = "\(file)/pow10/\(try text(c["name"], file))"
            try close(
                Dataviz.powerOfTen(try int(c["n"], at)), try double(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "niceNum") {
            let at = "\(file)/niceNum/\(try text(c["name"], file))"
            try close(
                Dataviz.niceNumber(try double(c["x"], at), round: try bool(c["round"], at)),
                try double(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "niceDomain") {
            let at = "\(file)/niceDomain/\(try text(c["name"], file))"
            let got = Dataviz.niceLinearDomain(
                lo: try double(c["lo"], at), hi: try double(c["hi"], at),
                count: try int(c["count"], at)
            )
            try verifyDomain(got, try object(c["expect"], at), at)
            count += 1
        }
        for c in try section(doc, file, "valueDomain") {
            let at = "\(file)/valueDomain/\(try text(c["name"], file))"
            let got = Dataviz.valueDomain(
                values: try doubles(c["values"], at),
                includeZero: try bool(c["includeZero"], at),
                count: try int(c["count"], at)
            )
            try verifyDomain(got, try object(c["expect"], at), at)
            count += 1
        }
        for c in try section(doc, file, "linear") {
            let at = "\(file)/linear/\(try text(c["name"], file))"
            try close(
                Dataviz.linearScale(
                    try double(c["v"], at),
                    domain: try doubles(c["domain"], at),
                    range: try doubles(c["range"], at)
                ),
                try double(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "band") {
            let at = "\(file)/band/\(try text(c["name"], file))"
            let got = Dataviz.bandScale(
                count: try int(c["count"], at),
                range: try doubles(c["range"], at),
                paddingInner: try double(c["paddingInner"], at),
                paddingOuter: try double(c["paddingOuter"], at),
                align: try double(c["align"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.step, try double(expect["step"], at), "\(at): step")
            try close(got.bandwidth, try double(expect["bandwidth"], at), "\(at): bandwidth")
            try close(got.start, try double(expect["start"], at), "\(at): start")
            try closeList(
                got.positions, try doubles(expect["positions"], at), "\(at): positions"
            )
            try closeList(got.centers, try doubles(expect["centers"], at), "\(at): centers")
            count += 1
        }
        for c in try section(doc, file, "log") {
            let at = "\(file)/log/\(try text(c["name"], file))"
            let got = Dataviz.logDomain(
                lo: try double(c["lo"], at), hi: try double(c["hi"], at),
                maxTicks: try int(c["maxTicks"], at)
            )
            let expect = try object(c["expect"], at)
            try same(got.valid, try bool(expect["valid"], at), "\(at): valid")
            try same(got.reason, try text(expect["reason"], at), "\(at): reason")
            try close(got.lo, try double(expect["lo"], at), "\(at): lo")
            try close(got.hi, try double(expect["hi"], at), "\(at): hi")
            try closeList(got.ticks, try doubles(expect["ticks"], at), "\(at): ticks")
            count += 1
        }
        for c in try section(doc, file, "logScale") {
            let at = "\(file)/logScale/\(try text(c["name"], file))"
            try close(
                Dataviz.logScale(
                    try double(c["v"], at),
                    domain: try doubles(c["domain"], at),
                    range: try doubles(c["range"], at)
                ),
                try double(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "time") {
            let at = "\(file)/time/\(try text(c["name"], file))"
            let got = Dataviz.timeTicks(
                lo: try double(c["lo"], at), hi: try double(c["hi"], at),
                count: try int(c["count"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.step, try double(expect["step"], at), "\(at): step")
            try closeList(got.ticks, try doubles(expect["ticks"], at), "\(at): ticks")
            count += 1
        }
        return count
    }

    // MARK: - marks.json

    private static func verifyMarks(_ url: URL) throws -> Int {
        let file = "dataviz/marks.json"
        let doc = try document(url)
        var count = 0

        for c in try section(doc, file, "pie") {
            let at = "\(file)/pie/\(try text(c["name"], file))"
            let got = Dataviz.pieSlices(
                values: try doubles(c["values"], at),
                outerRadius: try double(c["outerRadius"], at),
                innerRadius: try double(c["innerRadius"], at),
                startAngle: try double(c["startAngle"], at),
                padAngle: try double(c["padAngle"], at),
                clockwise: try bool(c["clockwise"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.total, try double(expect["total"], at), "\(at): total")
            try same(got.empty, try bool(expect["empty"], at), "\(at): empty")
            try close(got.innerRadius, try double(expect["innerRadius"], at), "\(at): innerRadius")
            try close(got.outerRadius, try double(expect["outerRadius"], at), "\(at): outerRadius")
            let slices = try objects(expect["slices"], at)
            try same(got.slices.count, slices.count, "\(at): slice count")
            for i in slices.indices {
                let a = got.slices[i]
                let e = slices[i]
                let node = "\(at)[\(i)]"
                try same(a.index, try int(e["index"], node), "\(node): index")
                try close(a.value, try double(e["value"], node), "\(node): value")
                try close(a.fraction, try double(e["fraction"], node), "\(node): fraction")
                try close(a.startAngle, try double(e["startAngle"], node), "\(node): startAngle")
                try close(a.endAngle, try double(e["endAngle"], node), "\(node): endAngle")
                try close(a.sweep, try double(e["sweep"], node), "\(node): sweep")
                try close(a.centroidX, try double(e["centroidX"], node), "\(node): centroidX")
                try close(a.centroidY, try double(e["centroidY"], node), "\(node): centroidY")
                try same(a.full, try bool(e["full"], node), "\(node): full")
            }
            count += 1
        }

        for c in try section(doc, file, "bubble") {
            let at = "\(file)/bubble/\(try text(c["name"], file))"
            try close(
                Dataviz.bubbleRadius(
                    try double(c["v"], at),
                    min: try double(c["min"], at),
                    max: try double(c["max"], at),
                    rMin: try double(c["rMin"], at),
                    rMax: try double(c["rMax"], at)
                ),
                try double(c["expect"], at), at
            )
            count += 1
        }

        for c in try section(doc, file, "radar") {
            let at = "\(file)/radar/\(try text(c["name"], file))"
            let center = try doubles(c["center"], at)
            let got = Dataviz.radarPoints(
                values: try doubles(c["values"], at),
                max: try double(c["max"], at),
                radius: try double(c["radius"], at),
                centerX: center[0],
                centerY: center[1]
            )
            let expect = try objects(c["expect"], at)
            try same(got.count, expect.count, "\(at): count")
            for i in expect.indices {
                let a = got[i]
                let e = expect[i]
                let node = "\(at)[\(i)]"
                try same(a.index, try int(e["index"], node), "\(node): index")
                try close(a.fraction, try double(e["fraction"], node), "\(node): fraction")
                try close(a.angle, try double(e["angle"], node), "\(node): angle")
                try close(a.x, try double(e["x"], node), "\(node): x")
                try close(a.y, try double(e["y"], node), "\(node): y")
            }
            count += 1
        }

        for c in try section(doc, file, "funnel") {
            let at = "\(file)/funnel/\(try text(c["name"], file))"
            let got = Dataviz.funnelStages(
                values: try doubles(c["values"], at),
                width: try double(c["width"], at),
                height: try double(c["height"], at),
                gap: try double(c["gap"], at)
            )
            let expect = try objects(c["expect"], at)
            try same(got.count, expect.count, "\(at): count")
            for i in expect.indices {
                let a = got[i]
                let e = expect[i]
                let node = "\(at)[\(i)]"
                try same(a.index, try int(e["index"], node), "\(node): index")
                try close(a.topWidth, try double(e["topWidth"], node), "\(node): topWidth")
                try close(a.bottomWidth, try double(e["bottomWidth"], node), "\(node): bottomWidth")
                try close(a.top, try double(e["top"], node), "\(node): top")
                try close(a.bottom, try double(e["bottom"], node), "\(node): bottom")
                try close(a.ofFirst, try double(e["ofFirst"], node), "\(node): ofFirst")
                try close(a.ofPrevious, try double(e["ofPrevious"], node), "\(node): ofPrevious")
            }
            count += 1
        }

        for c in try section(doc, file, "candleBuckets") {
            let at = "\(file)/candleBuckets/\(try text(c["name"], file))"
            let points = try objects(c["points"], at).map {
                Dataviz.TimePoint(t: num($0["t"]) ?? 0, v: num($0["v"]) ?? 0)
            }
            let got = Dataviz.candleBuckets(
                points: points,
                interval: try double(c["interval"], at),
                origin: try double(c["origin"], at)
            )
            let expect = try objects(c["expect"], at)
            try same(got.count, expect.count, "\(at): count")
            for i in expect.indices {
                let a = got[i]
                let e = expect[i]
                let node = "\(at)[\(i)]"
                try same(a.bucket, try int(e["bucket"], node), "\(node): bucket")
                try close(a.start, try double(e["start"], node), "\(node): start")
                try close(a.open, try double(e["open"], node), "\(node): open")
                try close(a.high, try double(e["high"], node), "\(node): high")
                try close(a.low, try double(e["low"], node), "\(node): low")
                try close(a.close, try double(e["close"], node), "\(node): close")
                try same(a.count, try int(e["count"], node), "\(node): count")
                try same(a.direction, try text(e["direction"], node), "\(node): direction")
            }
            count += 1
        }

        for c in try section(doc, file, "candleGeometry") {
            let at = "\(file)/candleGeometry/\(try text(c["name"], file))"
            let ohlc = try doubles(c["ohlc"], at)
            let got = Dataviz.candleGeometry(
                open: ohlc[0], high: ohlc[1], low: ohlc[2], close: ohlc[3],
                domain: try doubles(c["domain"], at),
                range: try doubles(c["range"], at),
                minBody: try double(c["minBody"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.bodyTop, try double(expect["bodyTop"], at), "\(at): bodyTop")
            try close(got.bodyBottom, try double(expect["bodyBottom"], at), "\(at): bodyBottom")
            try close(got.wickTop, try double(expect["wickTop"], at), "\(at): wickTop")
            try close(got.wickBottom, try double(expect["wickBottom"], at), "\(at): wickBottom")
            try same(got.direction, try text(expect["direction"], at), "\(at): direction")
            count += 1
        }

        for c in try section(doc, file, "heatmap") {
            let at = "\(file)/heatmap/\(try text(c["name"], file))"
            let points = try objects(c["points"], at).map {
                Dataviz.WeightedPoint(
                    x: num($0["x"]) ?? 0, y: num($0["y"]) ?? 0, w: num($0["w"]) ?? 0
                )
            }
            let got = Dataviz.heatmapCells(
                points: points,
                xBins: try int(c["xBins"], at),
                yBins: try int(c["yBins"], at),
                xDomain: try doubles(c["xDomain"], at),
                yDomain: try doubles(c["yDomain"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.max, try double(expect["max"], at), "\(at): max")
            let cells = try objects(expect["cells"], at)
            try same(got.cells.count, cells.count, "\(at): cell count")
            for i in cells.indices {
                let a = got.cells[i]
                let e = cells[i]
                let node = "\(at)[\(i)]"
                try same(a.xBin, try int(e["xBin"], node), "\(node): xBin")
                try same(a.yBin, try int(e["yBin"], node), "\(node): yBin")
                try close(a.value, try double(e["value"], node), "\(node): value")
                try close(a.intensity, try double(e["intensity"], node), "\(node): intensity")
            }
            count += 1
        }
        return count
    }

    // MARK: - interaction.json

    private static func verifyInteraction(_ url: URL) throws -> Int {
        let file = "dataviz/interaction.json"
        let doc = try document(url)
        var count = 0

        for c in try section(doc, file, "nearestIndex") {
            let at = "\(file)/nearestIndex/\(try text(c["name"], file))"
            try same(
                Dataviz.nearestIndex(
                    fraction: try double(c["fraction"], at), count: try int(c["count"], at)
                ),
                try int(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "nearestValueIndex") {
            let at = "\(file)/nearestValueIndex/\(try text(c["name"], file))"
            try same(
                Dataviz.nearestValueIndex(
                    try double(c["value"], at), values: try doubles(c["values"], at)
                ),
                try int(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "brush") {
            let at = "\(file)/brush/\(try text(c["name"], file))"
            let got = Dataviz.brushWindow(
                from: try double(c["from"], at), to: try double(c["to"], at),
                domain: try doubles(c["domain"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.start, try double(expect["start"], at), "\(at): start")
            try close(got.end, try double(expect["end"], at), "\(at): end")
            try same(got.cleared, try bool(expect["cleared"], at), "\(at): cleared")
            count += 1
        }
        for c in try section(doc, file, "zoom") {
            let at = "\(file)/zoom/\(try text(c["name"], file))"
            let got = Dataviz.zoomDomain(
                domain: try doubles(c["domain"], at),
                full: try doubles(c["full"], at),
                factor: try double(c["factor"], at),
                anchor: try double(c["anchor"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.lo, try double(expect["lo"], at), "\(at): lo")
            try close(got.hi, try double(expect["hi"], at), "\(at): hi")
            count += 1
        }
        for c in try section(doc, file, "pan") {
            let at = "\(file)/pan/\(try text(c["name"], file))"
            let got = Dataviz.panDomain(
                domain: try doubles(c["domain"], at),
                full: try doubles(c["full"], at),
                delta: try double(c["delta"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.lo, try double(expect["lo"], at), "\(at): lo")
            try close(got.hi, try double(expect["hi"], at), "\(at): hi")
            count += 1
        }
        return count
    }

    // MARK: - a11y.json

    private static func verifyAccessibleTable(_ url: URL) throws -> Int {
        let file = "dataviz/a11y.json"
        let doc = try document(url)
        var count = 0
        for c in try section(doc, file, "table") {
            let at = "\(file)/table/\(try text(c["name"], file))"
            let rows = try objects(c["rows"], at).map { row -> [String: Dataviz.Datum] in
                var out: [String: Dataviz.Datum] = [:]
                for (key, value) in row { out[key] = Dataviz.Datum.from(value) }
                return out
            }
            let got = Dataviz.accessibleTable(
                rows: rows,
                spec: Dataviz.AccessibleTableSpec(
                    x: try text(c["x"], at),
                    y: try text(c["y"], at),
                    series: try text(c["series"], at),
                    type: try text(c["type"], at),
                    xTitle: try text(c["xTitle"], at),
                    yTitle: try text(c["yTitle"], at)
                )
            )
            let expect = try object(c["expect"], at)
            try same(got.caption, try text(expect["caption"], at), "\(at): caption")
            guard let columns = expect["columns"] as? [String] else {
                throw Failure(description: "\(at): columns")
            }
            try same(got.columns, columns, "\(at): columns")
            guard let expectRows = expect["rows"] as? [[String]] else {
                throw Failure(description: "\(at): rows")
            }
            try same(got.rows, expectRows, "\(at): rows")
            try same(got.summary, try text(expect["summary"], at), "\(at): summary")
            count += 1
        }
        return count
    }

    // MARK: - camera.json

    private static func verifyCamera(_ url: URL) throws -> Int {
        let file = "dataviz/camera.json"
        let doc = try document(url)
        var count = 0

        let defaults = try object(doc["defaults"], file)
        try close(Dataviz.mapTileSize, try double(defaults["tileSize"], file), "\(file): tileSize")
        try close(Dataviz.mapMinZoom, try double(defaults["minZoom"], file), "\(file): minZoom")
        try close(Dataviz.mapMaxZoom, try double(defaults["maxZoom"], file), "\(file): maxZoom")
        try close(
            Dataviz.mapDefaultZoom, try double(defaults["defaultZoom"], file),
            "\(file): defaultZoom"
        )
        try close(
            Dataviz.mapMaxMercatorLatitude, try double(defaults["maxMercatorLatitude"], file),
            "\(file): maxMercatorLatitude"
        )
        count += 1

        for c in try section(doc, file, "project") {
            let at = "\(file)/project/\(try text(c["name"], file))"
            if let lon = num(c["lon"]), let expected = num(c["expectWorldX"]) {
                try close(Dataviz.mercatorX(lon), expected, "\(at): worldX")
            }
            if let lat = num(c["lat"]), let expected = num(c["expectWorldY"]) {
                try close(Dataviz.mercatorY(lat), expected, "\(at): worldY")
            }
            count += 1
        }
        for c in try section(doc, file, "roundTrip") {
            let at = "\(file)/roundTrip/\(try text(c["name"], file))"
            let lat = try double(c["lat"], at)
            let lon = try double(c["lon"], at)
            try close(Dataviz.latitudeAtWorldY(Dataviz.mercatorY(lat)), lat, "\(at): lat")
            try close(Dataviz.longitudeAtWorldX(Dataviz.mercatorX(lon)), lon, "\(at): lon")
            count += 1
        }
        for c in try section(doc, file, "normalizeLon") {
            let at = "\(file)/normalizeLon/\(try text(c["name"], file))"
            try close(
                Dataviz.normalizeLongitude(try double(c["lon"], at)),
                try double(c["expect"], at), at
            )
            count += 1
        }
        for c in try section(doc, file, "fitTo") {
            let at = "\(file)/fitTo/\(try text(c["name"], file))"
            let coords = try objects(c["coords"], at).map {
                Dataviz.GeoPoint(lat: num($0["lat"]) ?? 0, lon: num($0["lon"]) ?? 0)
            }
            let padding = try object(c["padding"], at)
            let got = Dataviz.fitCamera(
                coords: coords,
                width: try double(c["width"], at),
                height: try double(c["height"], at),
                padding: Dataviz.EdgePadding(
                    top: try double(padding["top"], at),
                    right: try double(padding["right"], at),
                    bottom: try double(padding["bottom"], at),
                    left: try double(padding["left"], at)
                )
            )
            let expect = try object(c["expect"], at)
            try same(got.valid, try bool(expect["valid"], at), "\(at): valid")
            try close(got.lat, try double(expect["lat"], at), "\(at): lat")
            try close(got.lon, try double(expect["lon"], at), "\(at): lon")
            try close(got.zoom, try double(expect["zoom"], at), "\(at): zoom")
            count += 1
        }
        for c in try section(doc, file, "region") {
            let at = "\(file)/region/\(try text(c["name"], file))"
            let got = Dataviz.mapRegion(
                lat: try double(c["lat"], at),
                lon: try double(c["lon"], at),
                zoom: try double(c["zoom"], at),
                width: try double(c["width"], at),
                height: try double(c["height"], at)
            )
            let expect = try object(c["expect"], at)
            try close(got.centerLat, try double(expect["centerLat"], at), "\(at): centerLat")
            try close(got.centerLon, try double(expect["centerLon"], at), "\(at): centerLon")
            try close(got.zoom, try double(expect["zoom"], at), "\(at): zoom")
            try close(got.latSpan, try double(expect["latSpan"], at), "\(at): latSpan")
            try close(got.lonSpan, try double(expect["lonSpan"], at), "\(at): lonSpan")
            count += 1
        }
        return count
    }

    // MARK: - cluster.json

    private static func pins(_ raw: Any?, _ at: String) throws -> [Dataviz.GeoPoint] {
        try objects(raw, at).map {
            Dataviz.GeoPoint(lat: num($0["lat"]) ?? 0, lon: num($0["lon"]) ?? 0)
        }
    }

    private static func verifyCluster(_ url: URL) throws -> Int {
        let file = "dataviz/cluster.json"
        let doc = try document(url)
        var count = 0
        let defaults = try object(doc["defaults"], file)
        let maxZoom = try int(defaults["maxZoom"], file)
        let radius = try double(defaults["clusterRadius"], file)

        let membership = try object(doc["membership"], file)
        let membershipPins = try pins(membership["pins"], "\(file)/membership")
        let cases = try objects(membership["cases"], "\(file)/membership")
        guard !cases.isEmpty else {
            throw Failure(description: "\(file): membership.cases[] must not be empty")
        }
        for c in cases {
            let zoom = try double(c["zoom"], file)
            let at = "\(file)/membership z=\(zoom)"
            let got = Dataviz.clusterPins(
                pins: membershipPins, zoom: zoom,
                radius: try double(c["radius"], at), maxZoom: maxZoom
            )
            let expect = try objects(c["expect"], at)
            try same(got.count, expect.count, "\(at): node count")
            for i in expect.indices {
                let a = got[i]
                let e = expect[i]
                let node = "\(at)[\(i)]"
                try same(a.id, try text(e["id"], node), "\(node): id")
                try same(a.cluster, try bool(e["cluster"], node), "\(node): cluster")
                try close(a.lat, try double(e["lat"], node), "\(node): lat")
                try close(a.lon, try double(e["lon"], node), "\(node): lon")
                try same(a.count, try int(e["count"], node), "\(node): count")
                let members = try doubles(e["members"], node).map { Int($0) }
                try same(a.members, members, "\(node): members")
                try same(
                    a.expansionZoom, try int(e["expansionZoom"], node), "\(node): expansionZoom"
                )
            }
            count += 1
        }

        let stability = try object(doc["stability"], file)
        let stabilityPins = try pins(stability["pins"], "\(file)/stability")
        let sweep = try doubles(stability["sameLevel"], "\(file)/stability")
        guard sweep.count > 1 else {
            throw Failure(description: "\(file): stability.sameLevel needs a sweep")
        }
        let reference = Dataviz.clusterPins(
            pins: stabilityPins, zoom: sweep[0], radius: radius, maxZoom: maxZoom
        ).map { $0.id }
        for zoom in sweep {
            let ids = Dataviz.clusterPins(
                pins: stabilityPins, zoom: zoom, radius: radius, maxZoom: maxZoom
            ).map { $0.id }
            try same(ids, reference, "\(file)/stability: zoom \(zoom) must not re-cluster")
            count += 1
        }
        let next = Dataviz.clusterPins(
            pins: stabilityPins, zoom: try double(stability["nextLevel"], file),
            radius: radius, maxZoom: maxZoom
        ).map { $0.id }
        guard next != reference else {
            throw Failure(description: "\(file)/stability: the next level must re-cluster")
        }
        count += 1

        let scale = try object(doc["scale"], file)
        let scalePins = try pins(scale["pins"], "\(file)/scale")
        guard scalePins.count >= 500 else {
            throw Failure(description: "\(file): scale.pins must be the 500-pin lattice")
        }
        for c in try objects(scale["cases"], "\(file)/scale") {
            let zoom = try double(c["zoom"], file)
            let at = "\(file)/scale z=\(zoom)"
            let got = Dataviz.clusterPins(
                pins: scalePins, zoom: zoom,
                radius: try double(c["radius"], at), maxZoom: maxZoom
            )
            guard let expect = c["expect"] as? [[Any]] else {
                throw Failure(description: "\(at): expect is not a digest")
            }
            try same(got.count, expect.count, "\(at): node count")
            for i in expect.indices {
                let node = "\(at)[\(i)]"
                try same(got[i].id, try text(expect[i][0], node), "\(node): id")
                try same(got[i].count, try int(expect[i][1], node), "\(node): count")
            }
            count += 1
        }
        return count
    }
}
