//
//  SceneBind.kt - data-driven scene children, Kotlin twin of
//  OpenSource/Web/packages/kernel/src/scene/bind.ts (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/bind.json. `<group bind="dsx.variable.enemies"
//  key="id">` instantiates its template children once per array row; the row scope
//  binds `item.*` exactly like `<list>` (the elements resolve through JSE.interpolate
//  with the row's item map — the Bound row-scope seam, StackNodeView.kt); add/remove/
//  reorder are KEYED (the list keying law verbatim, including the `·n` duplicate
//  suffix); removing a row removes its subtree and STOPS ITS ANIMATIONS.
//
//  The pure half (row keying · keyed diff · template instantiation) is the bind.ts
//  twin, corpus-pinned. [SceneBindReconciler] is the runtime half BOTH JVM `<scene>`
//  elements share (the SceneRaster stance): it captures each bound group's template,
//  reconciles rows against the live value, stamps every instantiated node with its row
//  item map (the row-scoped resolution seam), recurses into NESTED binds (full rows of
//  rows), and detaches removed subtrees from the [SceneAnimator].
//

package despia.engine.scene

/** the row cap — a hostile array cannot mint an unbounded draw list (the
 *  BOUND_COLLECTION_LIMIT stance, scene-sized) */
const val SCENE_BIND_LIMIT = 256

class SceneBindRow(val key: String, val index: Int, val item: Any?)

/** JS String() over the key plane: numbers stringify JS-style (5 → "5"), everything
 *  else toString — the list keying law's stringifier */
private fun bindKeyString(value: Any?): String = when (value) {
    is Double -> sceneNumberString(value)
    is Float -> sceneNumberString(value.toDouble())
    is Number -> value.toString()
    else -> value.toString()
}

/** THE ROW LAW: a non-array binds zero rows; a dict row keys on
 *  String(row[keyField] ?? index), a scalar row on String(row); duplicate keys get the
 *  `·1`, `·2`… suffix in encounter order (the list keying law); rows past
 *  SCENE_BIND_LIMIT are dropped with one diagnostic. */
fun sceneBindRows(value: Any?, keyField: String, diag: SceneDiag? = null): List<SceneBindRow> {
    if (value !is List<*>) return emptyList()
    if (value.size > SCENE_BIND_LIMIT) {
        diag?.invoke(SceneDiagnostic(
            SceneDiagnosticCode.BIND_OVERFLOW,
            "<group bind> has ${value.size} rows — instantiating the first $SCENE_BIND_LIMIT",
        ))
    }
    val rows = if (value.size > SCENE_BIND_LIMIT) value.subList(0, SCENE_BIND_LIMIT) else value
    val counts = HashMap<String, Int>()
    return rows.mapIndexed { index, item ->
        val base = if (item is Map<*, *>) bindKeyString(item[keyField] ?: index) else bindKeyString(item)
        val seen = counts[base] ?: 0
        counts[base] = seen + 1
        SceneBindRow(if (seen == 0) base else "$base·$seen", index, item)
    }
}

class SceneBindDiff(
    /** keys mounting fresh subtrees, in row order */
    val added: List<String>,
    /** keys whose subtrees unmount (dispose bindings, stop animations) */
    val removed: List<String>,
    /** keys keeping their instantiated subtree (identity survives reorder) */
    val retained: List<String>,
)

/** THE KEYED-IDENTITY LAW: a key present on both sides keeps its instantiated subtree
 *  across any reorder; a new key mounts; a vanished key unmounts. Pure — the corpus
 *  pins reorder scenarios as data. */
fun diffSceneBindRows(previous: List<String>, next: List<SceneBindRow>): SceneBindDiff {
    val before = previous.toHashSet()
    val now = next.mapTo(HashSet()) { it.key }
    val added = ArrayList<String>()
    val removed = ArrayList<String>()
    val retained = ArrayList<String>()
    for (row in next) (if (row.key in before) retained else added).add(row.key)
    for (key in previous) if (key !in now) removed.add(key)
    return SceneBindDiff(added, removed, retained)
}

/** deep-clone a template subtree with FRESH node identities (per-row caches, item
 *  scopes and animation states key on the node object) while sharing the immutable
 *  `source` markup — the renderer's way back to its binding machinery. */
fun instantiateSceneRow(template: List<SceneNode>): List<SceneNode> = template.map { node ->
    SceneNode(
        kind = node.kind,
        id = node.id,
        attrs = node.attrs,
        children = instantiateSceneRow(node.children),
        source = node.source,
        // a prefab expansion root keeps its stamp (G1): a spawned row instantiates the
        // prefab with a fresh per-instance identity + the shared raw scope
        prefab = node.prefab,
        mode2d = node.mode2d,
    )
}

/** the row's item map (the `<list>` Bound.item shape): dict rows spread their fields
 *  over the parent scope, scalar rows land as `value`; `index` rides both */
fun sceneRowItem(parent: Map<String, Any?>?, raw: Any?, index: Int): Map<String, Any?> {
    val out = HashMap<String, Any?>(parent ?: emptyMap())
    if (raw is Map<*, *>) {
        for ((k, v) in raw) if (k is String) out[k] = v
    } else {
        out["value"] = raw
    }
    out["index"] = index.toDouble()
    return out
}

// ── the shared runtime reconciler (both JVM `<scene>` elements) ──────────────────────

/**
 * Keyed bound-group reconciliation for the JVM `<scene>` elements. [register] walks a
 * parsed IR once, captures each `<group bind>`'s children as the TEMPLATE (they leave
 * the static render — instantiation is per row) and empties the group. [reconcile]
 * re-evaluates every bound expression against the live store (through the element's
 * [evalBind] seam), applies the keyed diff — a kept key keeps its instantiated
 * SceneNode identities across any reorder — and swaps the group's children. Every node
 * of an instantiated row is stamped with its row item map; the element's resolver reads
 * [itemFor] so `item.*` holes resolve per row (the `<list>` row law) and a row node's
 * handlers run in the row scope. Removing a row drops its stamps, unregisters nested
 * groups, and detaches the subtree from the [SceneAnimator] (its animations stop).
 * Nested binds are full rows of rows — inner groups register at row instantiation and
 * reconcile in the same pass.
 */
class SceneBindReconciler(
    /** evaluate a bind expression in a row scope (the element wires JSE.eval) */
    private val evalBind: (expr: String, item: Map<String, Any?>?) -> Any?,
    private val animator: SceneAnimator? = null,
    private val diag: SceneDiag? = null,
    /** G1: the prefab item plane — rows instantiated inside prefab bodies stamp their
     *  chains, and a bound group inside a prefab evaluates in the LIVE instance scope */
    private val prefabItems: ScenePrefabItems? = null,
) {
    private class Row(val nodes: List<SceneNode>, var item: Map<String, Any?>, var raw: Any?, var index: Int)

    private class Group(
        val template: List<SceneNode>,
        val keyField: String,
        val scopeItem: Map<String, Any?>?,
    ) {
        val rowsByKey = LinkedHashMap<String, Row>()
        var order: List<String> = emptyList()
        /** the live scope the rows were last stamped with — a change (a prefab
         *  instance param re-resolving) must restamp every retained row, or spawned
         *  subtrees keep the scope values they were born with (the review's
         *  three-renderer divergence; iOS restamps every pass) */
        var lastScope: Map<String, Any?>? = null
    }

    private val groups = LinkedHashMap<SceneNode, Group>()
    private val rowItems = HashMap<SceneNode, Map<String, Any?>>()

    /** the element's extra per-node cleanup when a row unmounts (the bus adapter's
     *  write overlay dies with the node — a retained entry is a leak keyed by a dead
     *  identity). Set after construction; called once per dropped node. */
    var onDrop: ((SceneNode) -> Unit)? = null

    /** the row scope a node resolves in (null = not inside a bound row) */
    fun itemFor(node: SceneNode): Map<String, Any?>? = rowItems[node]

    /** true when the IR holds at least one bound group (a cheap has-work probe) */
    fun hasGroups(): Boolean = groups.isNotEmpty()

    /** the stats() honest read (the scene bus): live instantiated rows across groups */
    fun rowCount(): Int = groups.values.sumOf { it.rowsByKey.size }

    /** walk a mounted subtree: capture `<group bind>` templates (their children leave
     *  the static tree), record the enclosing row scope, skip template internals */
    fun register(nodes: List<SceneNode>, scopeItem: Map<String, Any?>?) {
        for (node in nodes) {
            if (node.kind == SceneNodeKind.GROUP && node.attrs.containsKey("bind")) {
                groups[node] = Group(node.children, node.attrs["key"] ?: "id", scopeItem)
                node.children = emptyList()
                continue // template children instantiate per row, never statically
            }
            register(node.children, scopeItem)
        }
    }

    /** reconcile every bound group (including groups minted by nested rows this same
     *  pass). Returns true when the instantiated tree changed — the element re-rasters. */
    fun reconcile(resolveBase: SceneResolve): Boolean {
        // the store may have changed since the last pass — resolved instance scopes
        // re-derive once per pass, not once per attribute read (the per-pass cache)
        prefabItems?.beginPass()
        var changed = false
        val done = HashSet<SceneNode>()
        while (true) {
            val pending = groups.keys.filter { it !in done }
            if (pending.isEmpty()) break
            for (groupNode in pending) {
                done.add(groupNode)
                if (reconcileGroup(groupNode, resolveBase)) changed = true
            }
        }
        return changed
    }

    private fun reconcileGroup(groupNode: SceneNode, resolveBase: SceneResolve): Boolean {
        val group = groups[groupNode] ?: return false
        val expr = groupNode.attrs["bind"] ?: return false
        // G1: a bound group inside a prefab body evaluates in the LIVE instance scope
        // (params re-resolve at the instance site per reconcile); outside prefabs this
        // IS the captured scope item, unchanged
        val scopeItem = prefabItems?.itemFor(groupNode, { rowItems[it] }, group.scopeItem)
            ?: group.scopeItem
        // a changed enclosing scope restamps every retained row below (value equality —
        // itemFor builds a fresh map per pass, so identity cannot carry the comparison)
        val scopeChanged = group.rowsByKey.isNotEmpty() && scopeItem != group.lastScope
        group.lastScope = scopeItem
        val rows = sceneBindRows(evalBind(expr, scopeItem), group.keyField, diag)
        val diff = diffSceneBindRows(group.order, rows)
        var changed = diff.added.isNotEmpty() || diff.removed.isNotEmpty()
        for (key in diff.removed) {
            group.rowsByKey.remove(key)?.let { drop(it.nodes) }
        }
        val nextChildren = ArrayList<SceneNode>()
        for (row in rows) {
            var rec = group.rowsByKey[row.key]
            if (rec == null) {
                val nodes = instantiateSceneRow(group.template)
                val item = sceneRowItem(scopeItem, row.item, row.index)
                stampItems(nodes, item)
                // G1: spawned prefab instances inherit the group's prefab chain
                prefabItems?.stamp(nodes, prefabItems.chainOf(groupNode))
                register(nodes, item)                        // nested binds join the pass
                animator?.attach(nodes, groupNode, resolveBase)
                rec = Row(nodes, item, row.item, row.index)
                group.rowsByKey[row.key] = rec
            } else if (scopeChanged || rec.raw != row.item || rec.index != row.index) {
                // keyed identity survives: same subtree, refreshed row scope (the list law)
                val item = sceneRowItem(scopeItem, row.item, row.index)
                stampItems(rec.nodes, item)
                rec.item = item
                rec.raw = row.item
                rec.index = row.index
                changed = true
            }
            nextChildren.addAll(rec.nodes)
        }
        group.order = rows.map { it.key }
        groupNode.children = nextChildren
        return changed
    }

    private fun stampItems(nodes: List<SceneNode>, item: Map<String, Any?>) {
        for (node in nodes) {
            rowItems[node] = item
            stampItems(node.children, item)
        }
    }

    private fun drop(nodes: List<SceneNode>) {
        for (node in nodes) {
            onDrop?.invoke(node)
            rowItems.remove(node)
            groups.remove(node)?.let { nested ->
                for (row in nested.rowsByKey.values) drop(row.nodes)
            }
            drop(node.children)
        }
        prefabItems?.drop(nodes) // a despawned prefab instance drops its chain (G1)
        animator?.detach(nodes) // removing a row STOPS its animations (the bind law)
    }
}
