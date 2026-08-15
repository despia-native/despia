//
//  SceneBind.swift - data-driven scene children, the Swift twin of the web kernel's
//  scene/bind.ts (dsx-scene.md P5), corpus OpenSource/Conformance/scene/bind.json.
//  `<group bind="dsx.variable.enemies" key="id">` instantiates its template children
//  once per array row; the row scope binds `item.*` exactly like `<list>`. THE ROW LAW
//  is the iOS list element's keying (PrivilegedStackComponentContext.bound, Stack.swift
//  — the key field stringified per row, position fallback for a missing field) with the
//  corpus half the `<list>` law pins for scenes: duplicate keys take the `·1`/`·2`…
//  suffix in encounter order, and rows cap at 256 with one diagnostic. Add/remove/
//  reorder are KEYED (keyed identity survives reorder); removing a row removes its
//  subtree and stops its animations (the renderer's half — SceneElement). This module
//  is the platform-neutral half: row keying, the keyed diff, and template instantiation
//  — the renderer owns scopes, disposal and draw.
//

import Foundation

/// one bound row: its stable key, its position, and the raw row value
struct SceneBindRow {
    let key: String
    let index: Int
    let item: Any
}

/// one reconcile's verdict — keys mounting fresh, keys unmounting, keys kept
struct SceneBindDiff {
    /// keys mounting fresh subtrees, in row order
    let added: [String]
    /// keys whose subtrees unmount (dispose bindings, stop animations)
    let removed: [String]
    /// keys keeping their instantiated subtree (identity survives reorder)
    let retained: [String]
}

enum SceneBind {

    /// the row cap — a hostile array cannot mint an unbounded draw list (the
    /// BOUND_COLLECTION_LIMIT stance, scene-sized)
    static let bindLimit = 256

    /// the JS String() spelling for a key value (JSE.string, with the CFBoolean
    /// singleton spelled "true"/"false" — a bare NSNumber match would print 1/0)
    private static func stringify(_ value: Any) -> String {
        if let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() {
            return n.boolValue ? "true" : "false"
        }
        return JSE.string(value)
    }

    /// THE ROW LAW: a non-array binds zero rows; a dict row keys on
    /// String(row[keyField] ?? index), a scalar row on String(row); duplicate keys get
    /// the `·1`, `·2`… suffix in encounter order (the list keying law); rows past
    /// `bindLimit` are dropped with one diagnostic.
    static func rows(_ value: Any?, keyField: String,
                     _ diag: ((SceneDiagnostic) -> Void)? = nil) -> [SceneBindRow] {
        guard let array = value as? [Any] else { return [] }
        if array.count > bindLimit {
            diag?(SceneDiagnostic(code: "bind-overflow",
                                  message: "<group bind> has \(array.count) rows — instantiating the first \(bindLimit)"))
        }
        let bounded = array.count > bindLimit ? Array(array.prefix(bindLimit)) : array
        var counts: [String: Int] = [:]
        return bounded.enumerated().map { index, item in
            let base: String
            if let dict = item as? [String: Any] {
                let keyed = dict[keyField]
                base = (keyed == nil || keyed is NSNull) ? String(index) : stringify(keyed as Any)
            } else {
                base = stringify(item)
            }
            let seen = counts[base] ?? 0
            counts[base] = seen + 1
            return SceneBindRow(key: seen == 0 ? base : "\(base)·\(seen)", index: index, item: item)
        }
    }

    /// THE KEYED-IDENTITY LAW: a key present on both sides keeps its instantiated
    /// subtree across any reorder; a new key mounts; a vanished key unmounts. Pure —
    /// the corpus pins reorder scenarios as data.
    static func diff(previous: [String], next: [SceneBindRow]) -> SceneBindDiff {
        let before = Set(previous)
        let now = Set(next.map { $0.key })
        var added: [String] = []
        var removed: [String] = []
        var retained: [String] = []
        for row in next {
            if before.contains(row.key) { retained.append(row.key) } else { added.append(row.key) }
        }
        for key in previous where !now.contains(key) { removed.append(key) }
        return SceneBindDiff(added: added, removed: removed, retained: retained)
    }

    /// deep-clone a template subtree with FRESH node identities (SceneNode is a class,
    /// so per-row caches, handler scopes and animation states key on ObjectIdentifier —
    /// the TS instantiateSceneRow twin) while sharing the immutable attrs. A prefab
    /// expansion root keeps its `prefab` stamp (G1): a spawned row instantiates the
    /// prefab with a fresh per-instance identity + the shared raw scope.
    static func instantiateRow(_ template: [SceneNode]) -> [SceneNode] {
        template.map { node in
            SceneNode(kind: node.kind, id: node.id, attrs: node.attrs,
                      children: instantiateRow(node.children), prefab: node.prefab,
                      mode2d: node.mode2d)
        }
    }
}
