//
//  ApiBlock.kt - the `<api>` block, Android half (/web/05). Kotlin twin of the web
//  kernel's api.ts and the iOS ApiBlock.swift — ONE law, encoded in
//  OpenSource/Conformance/api/api-blocks.json and run by all three runtimes:
//
//    • reserved paths <as>.data/.loading/.refreshing/.error{status,message,body}/.fetchedAt
//      (plain store entries — normal JSE path reads resolve them)
//    • a block refetches when its MATERIALIZED request (url+method+headers+body,
//      watchKey-compared) changes. The web tracks reads through its signal graph; this
//      twin re-materializes on `storeChanged()` (the host calls it per store publish —
//      the watch machinery) and compares. Same observable law.
//    • auto defaults true for GET and is a formula; network errors (status 0) retry per
//      `retry`, http errors do not; stale data survives a failed refetch
//    • cache: no-store (default) · max-age(d) · swr(fresh, stale) — key method+url+body;
//      send() always hits the network, refresh() revalidates
//    • events: success / error / message (a {stream:[…]} response appends each chunk to
//      <as>.data and fires message per chunk, then success)
//
//  SEAMS (host-wired, like every kernel seam): `fetch` is a BLOCKING call here — the
//  Android host wraps it in its coroutine dispatcher (the same shape as Context.fetchImpl);
//  `now` and `schedule` are injectable (tests drive time deterministically). Mounted
//  declarations use the async transport, including abort-stale and debounce cancellation.
//  Pure JVM, android.*-free → surface-safe, exactly like Jse.kt.
//

package despia.engine

import java.util.ArrayDeque
import java.util.IdentityHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.WeakHashMap

/// Cancellation token returned by the asynchronous native transport used by a mounted
/// `<api>` declaration. The pure conformance host keeps using the blocking [fetch] seam;
/// Android UI mounts use this shape so no socket work can ever run on the main thread.
fun interface ApiBlockFetchCall {
    fun cancel()
}

/// Completion-style transport for a mounted `<api>`. It may deliver any number of
/// `{partial:true,message:…}` envelopes followed by exactly one terminal envelope.
/// Deliveries use the store's owning executor (Android installs the main Looper).
fun interface ApiBlockAsyncFetch {
    fun request(
        url: String,
        request: Map<String, Any?>,
        completion: (Map<String, Any?>) -> Unit,
    ): ApiBlockFetchCall
}

// ── the dependency graph (/web/11) ───────────────────────────────────────────────────
//
//  Kotlin twin of the web kernel's ApiGraph and the Swift ApiGraph — ONE law, encoded in
//  OpenSource/Conformance/api/api-blocks.json:
//
//    • an edge exists when a block's url/headers/body expression names another block's
//      `as` as its PATH ROOT, plus the explicit `needs="a, b"` (invisible deps)
//    • an auto block is GATED while an upstream is unresolved / in error, or while an
//      interpolation landing in url/headers/body evaluates to null (`missing-value`)
//    • ambient planes (dsx.const/env/global/route/…) are TYPED-ABSENT by law, never holes
//    • a cycle, or a `needs=` naming an unknown block, is a DECLARED error
//

/** Text analysis shared by the graph and the gate. Deliberately conservative: the result
 *  is only ever intersected with the sibling `as` names, or asked whether every path is
 *  ambient. Mirrors api.ts `expressionPaths` / `interpolationHoles` exactly. */
internal object ApiGraphText {
    private val keywords = setOf(
        "true", "false", "null", "undefined", "new", "typeof", "in", "of", "return",
        "if", "else", "function", "await", "void", "delete", "instanceof", "this",
    )
    private val ambientRoots = setOf(
        "global", "route", "cookie", "platform", "os", "env", "screen", "source", "app",
        "query", "params", "path", "const",
    )
    private val dsxScopeHeads = setOf("variable", "formula", "item", "attribute", "element", "event", "action")

    private fun isStart(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z' || c == '_' || c == '$'
    private fun isPart(c: Char): Boolean = isStart(c) || c in '0'..'9'

    /** Every `{{ … }}` hole of an interpolation template, in source order. */
    fun holes(template: String): List<String> {
        if (!template.contains("{{")) return emptyList()
        val out = ArrayList<String>()
        var idx = 0
        while (true) {
            val open = template.indexOf("{{", idx)
            if (open < 0) break
            val close = template.indexOf("}}", open + 2)
            if (close < 0) break
            out.add(template.substring(open + 2, close))
            idx = close + 2
        }
        return out
    }

    /** The dotted PATHS an expression reads. String literals are skipped; `{ key: v }`
     *  keys are not paths; an identifier after `.` is a member, not a root. */
    fun paths(expr: String): List<String> {
        val out = ArrayList<String>()
        val n = expr.length
        var i = 0
        while (i < n) {
            val c = expr[i]
            if (c == '"' || c == '\'' || c == '`') {
                i += 1
                while (i < n && expr[i] != c) {
                    if (expr[i] == '\\') i += 1
                    i += 1
                }
                i += 1
                continue
            }
            if (!isStart(c)) { i += 1; continue }
            var j = i
            while (j < n && isPart(expr[j])) j += 1
            var before = i - 1
            while (before >= 0 && (expr[before] == ' ' || expr[before] == '\t' || expr[before] == '\n')) before -= 1
            var after = j
            while (after < n && (expr[after] == ' ' || expr[after] == '\t')) after += 1
            val isMember = before >= 0 && expr[before] == '.'
            val isObjectKey = after < n && expr[after] == ':' && (after + 1 >= n || expr[after + 1] != ':')
            if (isMember || isObjectKey || keywords.contains(expr.substring(i, j))) { i = j; continue }
            val path = StringBuilder(expr.substring(i, j))
            var cursor = j
            while (true) {
                var dot = cursor
                while (dot < n && (expr[dot] == ' ' || expr[dot] == '\t')) dot += 1
                if (dot >= n || expr[dot] != '.' || dot + 1 >= n || !isStart(expr[dot + 1])) break
                var end = dot + 1
                while (end < n && isPart(expr[end])) end += 1
                path.append('.').append(expr, dot + 1, end)
                cursor = end
            }
            out.add(path.toString())
            i = cursor
        }
        return out
    }

    /** The scope name a dotted path reads — the edge candidate and the `blockedBy` name. */
    fun scopeName(path: String): String {
        val parts = path.split(".")
        if (parts.firstOrNull() != "dsx") return parts.firstOrNull() ?: path
        if ((parts.getOrNull(1) == "variable" || parts.getOrNull(1) == "formula") && parts.size > 2) return parts[2]
        return ""
    }

    fun isAmbient(path: String): Boolean {
        val parts = path.split(".")
        val head = parts.firstOrNull() ?: ""
        if (head == "dsx") return !dsxScopeHeads.contains(parts.getOrNull(1) ?: "")
        return ambientRoots.contains(head)
    }

    /** A hole reading ONLY ambient planes is never a gate (typed absence, durability P4). */
    fun holeIsAmbient(hole: String): Boolean {
        val p = paths(hole)
        return p.isEmpty() || p.all { isAmbient(it) }
    }

    /** The name reported for a `missing-value` hole: its first non-ambient scope name. */
    fun holeName(hole: String): String {
        for (path in paths(hole)) {
            if (isAmbient(path)) continue
            val name = scopeName(path)
            if (name.isNotEmpty()) return name
        }
        return hole.trim()
    }

    /** The upstream `<api>` names one spec reads: `needs=` first, then expression edges. */
    fun upstreams(spec: Map<String, String>, siblings: Set<String>): List<String> {
        val self = spec["as"] ?: ""
        val out = ArrayList<String>()
        for (raw in (spec["needs"] ?: "").split(",")) {
            val name = raw.trim()
            if (name.isNotEmpty() && name != self && !out.contains(name)) out.add(name)
        }
        fun push(name: String) {
            if (name.isNotEmpty() && name != self && siblings.contains(name) && !out.contains(name)) out.add(name)
        }
        for (hole in holes(spec["url"] ?: "")) for (path in paths(hole)) push(scopeName(path))
        for (expr in listOfNotNull(spec["headers"], spec["body"])) for (path in paths(expr)) push(scopeName(path))
        return out
    }

    fun unknownNeeds(spec: Map<String, String>, siblings: Set<String>): List<String> {
        val out = ArrayList<String>()
        for (raw in (spec["needs"] ?: "").split(",")) {
            val name = raw.trim()
            if (name.isNotEmpty() && !siblings.contains(name) && !out.contains(name)) out.add(name)
        }
        return out
    }
}

/** The `<api>` dependency graph of ONE scope (/web/11). Every block mounts before any
 *  fires; a settled block re-evaluates its dependents, so deep chains waterfall along
 *  their own edges while everything else stays concurrent. */
class ApiGraph(specs: List<Map<String, String>>) {
    private val names = ArrayList<String>()
    private val upstream = LinkedHashMap<String, List<String>>()
    private val unknown = LinkedHashMap<String, List<String>>()
    private val blocks = LinkedHashMap<String, ApiBlock>()
    private var started = false

    /** the cycle path when the declared graph is not a DAG (a DECLARED error) */
    val cycle: List<String>?

    init {
        val siblings = specs.mapNotNull { it["as"] }.toSet()
        for (spec in specs) {
            val name = spec["as"] ?: continue
            names.add(name)
            upstream[name] = ApiGraphText.upstreams(spec, siblings)
            val missing = ApiGraphText.unknownNeeds(spec, siblings)
            if (missing.isNotEmpty()) unknown[name] = missing
        }
        cycle = findCycle()
    }

    /** DFS with an explicit colour map — the first cycle found, walked in declaration
     *  order so every runtime reports the same one. */
    private fun findCycle(): List<String>? {
        val state = HashMap<String, Int>() // 0 unvisited · 1 on-stack · 2 done
        val stack = ArrayList<String>()
        fun walk(name: String): List<String>? {
            when (state[name]) {
                1 -> return stack.subList(stack.indexOf(name), stack.size).toList() + name
                2 -> return null
            }
            state[name] = 1
            stack.add(name)
            for (up in upstream[name] ?: emptyList()) {
                if (!upstream.containsKey(up)) continue
                val found = walk(up)
                if (found != null) return found
            }
            stack.removeAt(stack.size - 1)
            state[name] = 2
            return null
        }
        for (name in names) {
            val found = walk(name)
            if (found != null) return found
        }
        return null
    }

    fun upstreamsOf(name: String): List<String> = upstream[name] ?: emptyList()

    fun unknownNeedsOf(name: String): List<String> = unknown[name] ?: emptyList()

    fun attach(block: ApiBlock, name: String) { blocks[name] = block }

    fun detach(name: String) { blocks.remove(name) }

    /** Mount is over — every block is registered, so the runnable ones may start. The
     *  two phases matter on a SYNCHRONOUS transport: priming every gate first means a
     *  cascade cannot fire a block the start loop is about to reach. */
    fun start() {
        if (started) return
        started = true
        for (name in names) blocks[name]?.graphPrime()
        for (name in ArrayList(names)) blocks[name]?.graphStart()
    }

    /** An upstream settled: its dependents fire the moment THEIR inputs are whole. */
    fun notifySettled(settled: String) {
        if (!started) return
        for (name in ArrayList(names)) {
            if (name == settled) continue
            blocks[name]?.storeChanged()
        }
    }
}

/// Dot-path reads/writes over a StackStore's vars — the block's envelope writer.
/// Copy-on-write upward rebuilds (the State.kt shape); numeric segments grow lists.
object DsxPaths {
    fun get(store: StackStore, path: String): Any? {
        val parts = DsxStatePathPolicy.segments(path) ?: return null
        var cur: Any? = store.vars[parts[0]]
        for (p in parts.drop(1)) {
            // `.length` on lists/strings mirrors the JSE walk (fixtures assert data.length)
            if (p == "length" && cur !is Map<*, *>) {
                cur = when (cur) {
                    is List<*> -> cur.size.toDouble()
                    is String -> cur.length.toDouble()
                    else -> null
                }
                continue
            }
            val i = DsxStatePathPolicy.arrayIndex(p)
            cur = if (i != null && cur is List<*>) {
                if (i >= 0 && i < cur.size) cur[i] else null
            } else {
                @Suppress("UNCHECKED_CAST")
                (cur as? Map<String, Any?>)?.get(p)
            }
        }
        return cur
    }

    fun set(store: StackStore, path: String, value: Any?) {
        store.setPath(path, value)
    }
}

class ApiBlock(
    private val spec: Map<String, String>,
    private val store: StackStore,
    private val item: Map<String, Any?>? = null,
    /** BLOCKING fetch seam: (url, request{method,headers,body,expect}) → envelope
     *  {ok, status, data[, stream]} — the host wraps its real client + dispatcher. */
    private val fetch: (String, Map<String, Any?>) -> Map<String, Any?>,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val onEvent: (String, Map<String, Any?>) -> Unit = { _, _ -> },
    private val asyncFetch: ApiBlockAsyncFetch? = null,
    private val schedule: (Long, () -> Unit) -> ApiBlockFetchCall = { delay, task ->
        val future = JSERunner.scheduler.schedule(
            { JSERunner.mainExecutor.execute(task) },
            delay,
            java.util.concurrent.TimeUnit.MILLISECONDS,
        )
        ApiBlockFetchCall { future.cancel(false) }
    },
    /** /web/11: the scope's `<api>` DAG. With a graph the block does NOT start on
     *  construction — every sibling mounts first, then `graph.start()` runs the
     *  runnable ones. Without one, the block is its own scope (unchanged). */
    private val graph: ApiGraph? = null,
) {
    private class DeliveryGate {
        private val lock = Any()
        private var terminal = false

        fun claim(partial: Boolean): Boolean = synchronized(lock) {
            if (terminal) false
            else {
                if (!partial) terminal = true
                true
            }
        }

        fun isTerminal(): Boolean = synchronized(lock) { terminal }
    }

    /** Immutable prefix view over an append-only stream buffer. Creating one is O(1),
     * while its fixed size keeps previously published store values immutable as later
     * messages arrive. Reads synchronize with appends so retained snapshots are safe
     * for diagnostic/background observers too. */
    private class StreamSnapshot(
        private val values: ArrayList<Any?>,
        override val size: Int,
        private val lock: Any,
    ) : AbstractList<Any?>() {
        override fun get(index: Int): Any? = synchronized(lock) {
            if (index !in 0 until size) throw IndexOutOfBoundsException("index: $index, size: $size")
            values[index]
        }
    }

    private val asName: String = spec["as"] ?: "api"
    private val isAsNameValid: Boolean = DsxStatePathPolicy.isIdentifier(asName) &&
        (store.vars.containsKey(asName) || store.vars.size < DsxStatePathPolicy.maxContainerEntries)
    private var lastRequestKey: String? = null
    private var everFired = false
    private val declaredError: String? = when {
        graph == null -> null
        graph.cycle?.contains(spec["as"] ?: "") == true -> "cycle"
        graph.unknownNeedsOf(spec["as"] ?: "").isNotEmpty() -> "unknown-needs"
        else -> null
    }
    private val generation = AtomicInteger(0)
    private val lifecycleLock = Any()
    private var activeFetch: ApiBlockFetchCall? = null
    private var pendingGeneration: Int? = null
    private var pendingCompletion: ((Map<String, Any?>?) -> Unit)? = null
    private var debounceCall: ApiBlockFetchCall? = null
    private var debounceGeneration = 0
    private var streamChunks: ArrayList<Any?>? = null
    private var streamApproxBytes = 0L
    @Volatile private var disposed = false

    // ── the cache (runtime-level, the shared key law) ────────────────────────────────
    companion object {
        private data class Entry(val data: Any?, val at: Long, val costBytes: Long = 0L)
        private class CacheState {
            val entries = LinkedHashMap<String, Entry>(cacheLimit + 1, 0.75f, true)
            var costBytes = 0L
        }
        internal const val cacheLimit = 256
        internal const val maxCacheEntryBytes = 16L * 1024L * 1024L
        internal const val maxCacheAggregateBytes = 64L * 1024L * 1024L
        internal const val maxCacheGraphDepth = 256
        internal const val maxCacheGraphNodes = 100_000
        internal const val maxStreamEvents = 10_000
        internal const val maxStreamAggregateBytes = 16L * 1024L * 1024L
        private val caches = WeakHashMap<StackStore, CacheState>()
        /** Backward-compatible process partition seam used by pure conformance/tests. */
        @Volatile var cachePartition: () -> String = { "" }
        /** Request-aware auth/session partition. Android reconciles WebView cookies for
         * this materialized URL before any cache lookup, then fingerprints effective
         * cookies without expiry metadata. */
        @Volatile var requestCachePartition: (Map<String, Any?>) -> String =
            { cachePartition() }
        fun clearCache() = synchronized(caches) { caches.clear() }
        private fun cacheFor(store: StackStore): CacheState =
            caches.getOrPut(store) { CacheState() }
        private fun cacheGet(store: StackStore, key: String): Entry? {
            val retained = synchronized(caches) { cacheFor(store).entries[key] } ?: return null
            // Never publish the cache's retained object graph. Kotlin/JVM collections and
            // byte arrays are mutable even when typed as List/Map/Any; returning the stored
            // graph would let a native package or custom transport grow it after accounting.
            val detached = snapshotCacheValue(retained.data, maxCacheEntryBytes) ?: return null
            return retained.copy(data = detached.value)
        }
        private fun cachePut(store: StackStore, key: String, e: Entry) {
            // Snapshot before accounting and retain only that private graph. The response
            // itself remains the value published for the network settlement, while later
            // cache hits receive another detached snapshot through cacheGet.
            val snapshot = snapshotCacheValue(e.data, maxCacheEntryBytes)
            val dataCost = snapshot?.costBytes ?: (maxCacheEntryBytes + 1L)
            val keyCost = estimateUtf8Bytes(key, maxCacheAggregateBytes) + 64L
            val totalCost = if (dataCost > maxCacheEntryBytes ||
                keyCost > maxCacheAggregateBytes - dataCost
            ) {
                maxCacheAggregateBytes + 1L
            } else {
                dataCost + keyCost
            }
            synchronized(caches) {
                val cache = cacheFor(store)
                cache.entries.remove(key)?.let { cache.costBytes -= it.costBytes }
                // A successful oversized revalidation must not leave an older value
                // for this key reachable. It is served normally, just not retained.
                if (dataCost > maxCacheEntryBytes || totalCost > maxCacheAggregateBytes) {
                    return@synchronized
                }
                while (cache.entries.isNotEmpty() &&
                    (cache.entries.size >= cacheLimit ||
                        totalCost > maxCacheAggregateBytes - cache.costBytes)
                ) {
                    val eldest = cache.entries.entries.iterator().next()
                    cache.costBytes -= eldest.value.costBytes
                    cache.entries.remove(eldest.key)
                }
                cache.entries[key] = e.copy(data = snapshot!!.value, costBytes = totalCost)
                cache.costBytes += totalCost
            }
        }
        private fun cacheClear(store: StackStore) =
            synchronized(caches) { caches.remove(store) }

        private data class CacheSnapshot(val value: Any?, val costBytes: Long)
        private data class SnapshotTask(
            val source: Any?,
            val depth: Int,
            val assign: (Any?) -> Unit,
        )

        /** Iterative, identity-aware JSON graph snapshot used at both cache boundaries.
         * Repeated/cyclic containers and opaque mutable scalar types fail closed instead
         * of exposing aliasing or invoking recursive equality later. Explicit node/depth/
         * byte bounds keep a hostile custom transport from moving denial-of-service risk
         * into the defensive copy. Native JSON trees retain their normal value semantics. */
        private fun snapshotCacheValue(value: Any?, limit: Long): CacheSnapshot? {
            if (limit < 0L) return null
            var total = 0L
            var nodes = 0
            var root: Any? = null
            val copies = IdentityHashMap<Any, Any>()
            val pending = ArrayDeque<SnapshotTask>()
            pending.addLast(SnapshotTask(value, 0) { root = it })

            fun charge(bytes: Long): Boolean {
                if (bytes < 0L || bytes > limit - total) return false
                total += bytes
                return true
            }

            fun chargeEdges(count: Int, bytesEach: Long): Boolean {
                if (count < 0 || bytesEach <= 0L) return false
                val available = limit - total
                if (count.toLong() > available / bytesEach) return false
                return charge(count.toLong() * bytesEach)
            }

            fun chargeString(text: String): Boolean {
                if (!charge(16L)) return false
                val bytes = estimateUtf8Bytes(text, limit - total)
                return bytes <= limit - total && charge(bytes)
            }

            try {
                while (pending.isNotEmpty()) {
                    val task = pending.removeLast()
                    nodes += 1
                    if (nodes > maxCacheGraphNodes) return null
                    val current = task.source
                    if (current == null) {
                        if (!charge(4L)) return null
                        task.assign(null)
                        continue
                    }

                    when (current) {
                        is String -> {
                            if (!chargeString(current)) return null
                            task.assign(current)
                        }
                        is Boolean, is Char -> {
                            if (!charge(8L)) return null
                            task.assign(current)
                        }
                        is Byte, is Short, is Int, is Long, is Float, is Double -> {
                            if (!charge(16L)) return null
                            task.assign(current)
                        }
                        is ByteArray -> {
                            if (!charge(16L + current.size.toLong())) return null
                            task.assign(current.copyOf())
                        }
                        is BooleanArray -> {
                            if (!charge(16L + current.size.toLong())) return null
                            task.assign(current.copyOf())
                        }
                        is CharArray -> {
                            if (!charge(16L + current.size.toLong() * 2L)) return null
                            task.assign(current.copyOf())
                        }
                        is ShortArray -> {
                            if (!charge(16L + current.size.toLong() * 2L)) return null
                            task.assign(current.copyOf())
                        }
                        is IntArray -> {
                            if (!charge(16L + current.size.toLong() * 4L)) return null
                            task.assign(current.copyOf())
                        }
                        is FloatArray -> {
                            if (!charge(16L + current.size.toLong() * 4L)) return null
                            task.assign(current.copyOf())
                        }
                        is LongArray -> {
                            if (!charge(16L + current.size.toLong() * 8L)) return null
                            task.assign(current.copyOf())
                        }
                        is DoubleArray -> {
                            if (!charge(16L + current.size.toLong() * 8L)) return null
                            task.assign(current.copyOf())
                        }
                        is Map<*, *> -> {
                            if (copies.containsKey(current)) return null
                            if (task.depth >= maxCacheGraphDepth || !charge(32L)) return null
                            val maximumEntries = minOf(
                                (maxCacheGraphNodes - nodes) / 2,
                                ((limit - total) / 24L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
                            )
                            // Copy key/value references now rather than retaining live
                            // Map.Entry views while descendant tasks are processed. Iterate
                            // to an explicit ceiling instead of trusting a custom Map.size.
                            val entries = ArrayList<Pair<Any?, Any?>>(minOf(current.size, maximumEntries).coerceAtLeast(0))
                            for (entry in current.entries) {
                                if (entries.size >= maximumEntries) return null
                                entries += entry.key to entry.value
                            }
                            if (!chargeEdges(entries.size, 24L)) return null
                            val target = LinkedHashMap<String, Any?>(entries.size)
                            copies[current] = target
                            task.assign(target)
                            for (index in entries.indices.reversed()) {
                                val entry = entries[index]
                                val key = entry.first as? String ?: return null
                                nodes += 1
                                if (nodes > maxCacheGraphNodes || !chargeString(key)) return null
                                pending.addLast(SnapshotTask(entry.second, task.depth + 1) { child ->
                                    target[key] = child
                                })
                            }
                        }
                        is List<*> -> {
                            if (copies.containsKey(current)) return null
                            if (task.depth >= maxCacheGraphDepth ||
                                current.size > maxCacheGraphNodes - nodes ||
                                !charge(24L) || !chargeEdges(current.size, 8L)
                            ) return null
                            val target = ArrayList<Any?>(current.size)
                            repeat(current.size) { target.add(null) }
                            copies[current] = target
                            task.assign(target)
                            for (index in current.indices.reversed()) {
                                pending.addLast(SnapshotTask(current[index], task.depth + 1) { child ->
                                    target[index] = child
                                })
                            }
                        }
                        is Array<*> -> {
                            if (copies.containsKey(current)) return null
                            if (task.depth >= maxCacheGraphDepth ||
                                current.size > maxCacheGraphNodes - nodes ||
                                !charge(24L) || !chargeEdges(current.size, 8L)
                            ) return null
                            val target = arrayOfNulls<Any?>(current.size)
                            copies[current] = target
                            task.assign(target)
                            for (index in current.indices.reversed()) {
                                pending.addLast(SnapshotTask(current[index], task.depth + 1) { child ->
                                    target[index] = child
                                })
                            }
                        }
                        // Native JSON decoding produces only the cases above. Other
                        // Iterables, mutable Number subclasses and opaque objects cannot
                        // be snapshotted with stable value semantics, so do not cache them.
                        else -> return null
                    }
                }
            } catch (_: Exception) {
                return null
            }
            return CacheSnapshot(root, total)
        }

        /** Conservative retained-byte estimate for JSON-shaped API values. Traversal
         * is iterative, identity-aware for cycles/shared graphs, and stops immediately
         * above the supplied bound so a custom transport cannot turn cache accounting
         * into its own CPU or stack-exhaustion vector. */
        private fun estimateCacheValue(value: Any?, limit: Long): Long {
            var total = 0L
            val pending = ArrayDeque<Any>()
            val visited = IdentityHashMap<Any, Boolean>()

            fun charge(bytes: Long): Boolean {
                if (bytes < 0L || bytes > limit - total) {
                    total = limit + 1L
                    return false
                }
                total += bytes
                return true
            }

            fun enqueue(candidate: Any?) {
                if (total > limit) return
                if (candidate == null) charge(4L) else pending.addLast(candidate)
            }

            enqueue(value)
            try {
                while (pending.isNotEmpty() && total <= limit) {
                    when (val current = pending.removeLast()) {
                        is String -> {
                            if (!charge(16L)) break
                            val bytes = estimateUtf8Bytes(current, limit - total)
                            if (!charge(bytes)) break
                        }
                        is Boolean, is Char -> if (!charge(8L)) break
                        is Number -> if (!charge(16L)) break
                        is ByteArray -> if (!charge(16L + current.size.toLong())) break
                        is BooleanArray -> if (!charge(16L + current.size.toLong())) break
                        is CharArray -> if (!charge(16L + current.size.toLong() * 2L)) break
                        is ShortArray -> if (!charge(16L + current.size.toLong() * 2L)) break
                        is IntArray, is FloatArray -> {
                            val size = if (current is IntArray) current.size else (current as FloatArray).size
                            if (!charge(16L + size.toLong() * 4L)) break
                        }
                        is LongArray, is DoubleArray -> {
                            val size = if (current is LongArray) current.size else (current as DoubleArray).size
                            if (!charge(16L + size.toLong() * 8L)) break
                        }
                        is Map<*, *> -> {
                            if (visited.put(current, true) != null) continue
                            if (!charge(32L)) break
                            for ((key, child) in current) {
                                if (!charge(24L)) break
                                enqueue(key)
                                enqueue(child)
                            }
                        }
                        is Iterable<*> -> {
                            if (visited.put(current, true) != null) continue
                            if (!charge(24L)) break
                            for (child in current) {
                                if (!charge(8L)) break
                                enqueue(child)
                            }
                        }
                        is Array<*> -> {
                            if (visited.put(current, true) != null) continue
                            if (!charge(24L)) break
                            for (child in current) {
                                if (!charge(8L)) break
                                enqueue(child)
                            }
                        }
                        // Native API decoding produces only the JSON-shaped cases
                        // above. An opaque custom object can retain an arbitrarily large
                        // graph that cannot be costed safely, so fail closed and serve it
                        // without caching.
                        else -> return limit + 1L
                    }
                }
            } catch (_: Exception) {
                return limit + 1L
            }
            return total
        }

        private fun estimateUtf8Bytes(value: String, limit: Long): Long {
            var bytes = 0L
            var index = 0
            while (index < value.length) {
                val code = value[index].code
                val width = when {
                    code < 0x80 -> 1L
                    code < 0x800 -> 2L
                    code in 0xD800..0xDBFF &&
                        index + 1 < value.length &&
                        value[index + 1].code in 0xDC00..0xDFFF -> {
                        index += 1
                        4L
                    }
                    else -> 3L
                }
                if (width > limit - bytes) return limit + 1L
                bytes += width
                index += 1
            }
            return bytes
        }

        /** doc 05 `via="server"` / doc 13 "the embed knows its home origin": the absolute
         * base the proxy route resolves against. "" = same origin; the host sets its
         * configured web origin here. */
        @Volatile var apiServerOrigin: String = ""

        /** `encodeURIComponent` semantics, spelled out so all three runtimes put the same
         * bytes on the wire (unreserved: A-Z a-z 0-9 - _ . ! ~ * ' ( )). */
        internal fun percentEncode(value: String): String {
            val unreserved = "-_.!~*'()"
            val out = StringBuilder()
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val c = byte.toInt().toChar()
                if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || unreserved.indexOf(c) >= 0) {
                    out.append(c)
                } else {
                    out.append('%').append("0123456789ABCDEF"[(byte.toInt() shr 4) and 0xF])
                        .append("0123456789ABCDEF"[byte.toInt() and 0xF])
                }
            }
            return out.toString()
        }

        /** networking.md N2 — the declared REQUEST encodings the kernel materializes. */
        internal fun encodeFormBody(body: Any?): String {
            @Suppress("UNCHECKED_CAST")
            val dict = body as? Map<String, Any?> ?: return JSE.string(body)
            return dict.keys.sorted().joinToString("&") { key ->
                percentEncode(key) + "=" + percentEncode(JSE.string(dict[key]))
            }
        }

        /** multipart/form-data parts, SORTED BY FIELD NAME so the corpus is
         * order-deterministic on runtimes whose native dictionaries are unordered. */
        internal fun multipartParts(body: Any?): List<Map<String, Any?>> {
            @Suppress("UNCHECKED_CAST")
            val dict = body as? Map<String, Any?> ?: return emptyList()
            val out = ArrayList<Map<String, Any?>>()
            for (key in dict.keys.sorted()) {
                val value = dict[key]
                @Suppress("UNCHECKED_CAST")
                val blob = (value as? Map<String, Any?>)?.get("__blob") as? String
                if (blob != null) {
                    val shape = value as Map<*, *>
                    val part = linkedMapOf<String, Any?>("name" to key, "blob" to blob)
                    (shape["name"] as? String)?.let { part["filename"] = it }
                    (shape["type"] as? String)?.let { part["contentType"] = it }
                    out.add(part)
                } else {
                    out.add(linkedMapOf<String, Any?>("name" to key, "value" to JSE.string(value)))
                }
            }
            return out
        }

        /** "60" / "60s" / "10m" / "2h" → ms (bare numbers are seconds) */
        internal fun parseDuration(s: String): Long {
            val m = Regex("""^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$""").find(s) ?: return 0
            val n = m.groupValues[1].toDouble()
            return when (m.groupValues[2].ifEmpty { "s" }) {
                "ms" -> n.toLong()
                "m" -> (n * 60_000).toLong()
                "h" -> (n * 3_600_000).toLong()
                else -> (n * 1000).toLong()
            }
        }
    }

    private sealed class Policy {
        object NoStore : Policy()
        class MaxAge(val age: Long) : Policy()
        class Swr(val fresh: Long, val stale: Long) : Policy()
    }

    private val policy: Policy = run {
        val raw = (spec["cache"] ?: "").trim()
        val maxAge = Regex("""^max-age\(([^)]+)\)$""").find(raw)
        val swr = Regex("""^swr\(([^,)]+),([^)]+)\)$""").find(raw)
        when {
            maxAge != null -> Policy.MaxAge(parseDuration(maxAge.groupValues[1]))
            swr != null -> Policy.Swr(parseDuration(swr.groupValues[1]), parseDuration(swr.groupValues[2]))
            else -> Policy.NoStore
        }
    }

    init {
        // seed the reserved paths — data null until first resolve (doc 05). `status`,
        // `blockedBy` and `progress` are /web/11 + networking.md N2 additions to the
        // SAME reserved envelope.
        if (isAsNameValid && store.vars[asName] == null) {
            store.set(asName, linkedMapOf<String, Any?>(
                "data" to null, "loading" to false, "refreshing" to false,
                "error" to null, "fetchedAt" to null,
                "status" to "ready", "blockedBy" to listOf<Any?>(), "progress" to null,
            ))
        }
        if (isAsNameValid) {
            if (graph == null) mountFire() else graph.attach(this, asName)
        }
    }

    /** /web/11 phase 1: publish this block's gate BEFORE any sibling fires, so a
     *  synchronous cascade cannot double-fire a block the start loop has yet to reach. */
    internal fun graphPrime() {
        if (disposed || !isAsNameValid) return
        if (declaredError != null) { publishDeclaredError(declaredError); return }
        val req = materializeGated()
        lastRequestKey = requestKey(req)
        publishGate(gateOf(req))
    }

    /** /web/11 phase 2: fire this block if it is runnable and a cascade has not already. */
    internal fun graphStart() {
        if (disposed || !isAsNameValid || declaredError != null || everFired) return
        val req = materializeGated()
        lastRequestKey = requestKey(req)
        val blocked = gateOf(req)
        publishGate(blocked)
        if (blocked.isNotEmpty() || !JSE.truthy(req["auto"])) return
        everFired = true
        fire(req, allowCache = true, refreshing = false, forceNetwork = false)
    }

    // ── materialize (the request from the live scope) ────────────────────────────────

    private fun materialize(): Map<String, Any?> {
        val method = (spec["method"] ?: "GET").uppercase()
        val auto = spec["auto"]?.let { JSE.truthy(JSE.eval(it, store, item)) } ?: (method == "GET")
        // /web/11 value-presence gating rides the SAME pass that interpolates, so a gated
        // block costs no extra evaluation: each `{{ … }}` hole is checked as it is written.
        val missing = ArrayList<String>()
        val url = interpolateGated(spec["url"] ?: "", missing)
        val rawHeaders = spec["headers"]?.let { JSE.eval(it, store, item) } as? Map<*, *>
        if (rawHeaders != null) {
            for (key in rawHeaders.keys.mapNotNull { it as? String }.sorted()) {
                if (rawHeaders[key] == null && !missing.contains(key)) missing.add(key)
            }
        }
        val headers = rawHeaders?.entries
            ?.mapNotNull { entry ->
                val name = (entry.key as? String)?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                    ?: return@mapNotNull null
                name to JSE.string(entry.value)
            }
            ?.sortedBy { it.first }
            ?.associateTo(LinkedHashMap()) { it }
        val bodyExpr = spec["body"]
        val body = bodyExpr?.let { JSE.eval(it, store, item) }
        if (bodyExpr != null && body == null) {
            for (path in ApiGraphText.paths(bodyExpr)) {
                if (ApiGraphText.isAmbient(path)) continue
                val name = ApiGraphText.scopeName(path)
                if (name.isNotEmpty() && !missing.contains(name)) missing.add(name)
                break
            }
        }
        val req = linkedMapOf<String, Any?>(
            "url" to url,
            "method" to method,
            "headers" to headers,
            "body" to body,
            "expect" to (spec["expect"] ?: "json").trim().lowercase().ifEmpty { "json" },
            "auto" to auto,
            "_missing" to missing,
        )
        applyTransportControls(req)
        // Capture once per materialization. Cache lookup and response storage use this
        // stable identity, and requestKey observes cookie login/logout transitions.
        req["_cachePartition"] = requestCachePartition(req)
        return req
    }

    /** `JSE.interpolate` with the /web/11 hole ledger: a `{{ … }}` that evaluates to null
     *  and reads at least one non-ambient path records its scope name. */
    private fun interpolateGated(template: String, missing: MutableList<String>): String {
        if (!template.contains("{{")) return template
        val out = StringBuilder()
        var idx = 0
        while (true) {
            val open = template.indexOf("{{", idx)
            if (open < 0) break
            out.append(template, idx, open)
            val close = template.indexOf("}}", open + 2)
            if (close < 0) { out.append(template, open, template.length); return out.toString() }
            val hole = template.substring(open + 2, close)
            val value = JSE.eval(hole, store, item)
            if (value == null && !ApiGraphText.holeIsAmbient(hole)) {
                val name = ApiGraphText.holeName(hole)
                if (!missing.contains(name)) missing.add(name)
            }
            out.append(JSE.string(value))
            idx = close + 2
        }
        out.append(template, idx, template.length)
        return out.toString()
    }

    /** networking.md N2 + doc 05's secrets story: the DECLARED transport controls. */
    private fun applyTransportControls(req: LinkedHashMap<String, Any?>) {
        fun flag(raw: String?): Boolean? = when (raw?.trim()?.lowercase()) {
            null -> null
            "", "true", "1" -> true
            "false", "0" -> false
            else -> null
        }
        flag(spec["stream"])?.let { req["stream"] = it }
        val timeout = spec["timeout"]?.trim()?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0.0 }
        if (timeout != null) req["timeout"] = timeout
        val redirect = (spec["redirect"] ?: "").trim().lowercase()
        if (redirect == "error" || redirect == "follow") req["redirect"] = redirect
        val encode = (spec["encode"] ?: "json").trim().lowercase()
        if (encode == "text" || encode == "form" || encode == "multipart") {
            req["encode"] = encode
            @Suppress("UNCHECKED_CAST")
            val headers = LinkedHashMap((req["headers"] as? Map<String, Any?>) ?: emptyMap())
            if (encode == "multipart") {
                req["parts"] = multipartParts(req["body"])
            } else {
                req["wire"] = if (encode == "form") encodeFormBody(req["body"]) else JSE.string(req["body"])
                if (!headers.containsKey("content-type")) {
                    headers["content-type"] = if (encode == "form") {
                        "application/x-www-form-urlencoded;charset=UTF-8"
                    } else {
                        "text/plain;charset=UTF-8"
                    }
                }
            }
            req["headers"] = headers
        }
        if ((spec["via"] ?: "").trim().lowercase() == "server") {
            // The CLIENT half calls the generated internal route; the SERVER half performs
            // the real request with server-held headers. No secret is ever in the bundle.
            val target = JSE.string(req["url"])
            req["via"] = "server"
            req["target"] = target
            req["url"] = apiServerOrigin + "/dsx/api/" + (spec["as"] ?: "api") +
                "?u=" + percentEncode(target)
        }
    }

    private fun requestKey(req: Map<String, Any?>): String =
        JSE.watchKey(
            listOf(
                req["url"], req["method"], req["headers"], req["body"], req["expect"],
                req["auto"], req["_cachePartition"],
                // /web/11: the GATE is part of the tracked identity, so an upstream that
                // resolves (or fails) is a request change exactly like a url change.
                gateOf(req).joinToString(",") { "${it["name"]}:${it["reason"]}" },
            ),
        )

    /** The materialized request, with its gate resolved once. */
    private fun materializeGated(): Map<String, Any?> = materialize()

    /** /web/11's four gate rules, in a deterministic order: `needs=` and expression edges
     *  first (an upstream that has not resolved, or one carrying an error), then the
     *  value-presence holes the materialization already recorded. */
    private fun gateOf(req: Map<String, Any?>): List<Map<String, Any?>> {
        if (!JSE.truthy(req["auto"])) return emptyList()
        val out = ArrayList<Map<String, Any?>>()
        val seen = HashSet<String>()
        fun add(name: String, reason: String) {
            if (name.isEmpty() || !seen.add(name)) return
            out.add(linkedMapOf<String, Any?>("name" to name, "reason" to reason))
        }
        for (name in graph?.upstreamsOf(asName) ?: emptyList()) {
            if (JSE.eval("$name.error", store, null) != null) { add(name, "upstream-error"); continue }
            if (JSE.eval("$name.fetchedAt", store, null) == null) add(name, "unresolved")
        }
        (req["_missing"] as? List<*>)?.forEach { add(JSE.string(it), "missing-value") }
        return out
    }

    /** `<as>.status` / `<as>.blockedBy` (/web/11). `loading` stays TRUE while waiting,
     *  because from the user's seat a gated block IS loading. */
    private fun publishGate(blocked: List<Map<String, Any?>>) {
        if (!isAsNameValid) return
        DsxPaths.set(store, "$asName.blockedBy", blocked)
        if (blocked.isNotEmpty()) {
            DsxPaths.set(store, "$asName.status", "waiting")
            DsxPaths.set(store, "$asName.loading", true)
            DsxPaths.set(store, "$asName.refreshing", false)
        } else if (JSE.string(DsxPaths.get(store, "$asName.status")) == "waiting") {
            DsxPaths.set(store, "$asName.status", "ready")
            DsxPaths.set(store, "$asName.loading", false)
        }
    }

    /** /web/11: a cycle, or a `needs=` naming a block that is not in this scope. A silent
     *  forever-wait is the worse failure mode, so the block declares it and never fires. */
    private fun publishDeclaredError(message: String) {
        val error = linkedMapOf<String, Any?>("status" to -3.0, "message" to message, "body" to null)
        DsxPaths.set(store, "$asName.loading", false)
        DsxPaths.set(store, "$asName.refreshing", false)
        DsxPaths.set(store, "$asName.status", "error")
        DsxPaths.set(store, "$asName.blockedBy", listOf<Any?>())
        DsxPaths.set(store, "$asName.error", error)
        emitEvent("error", linkedMapOf("error" to error))
    }

    /** networking.md N2 "Progress": each entry publishes `<as>.progress` and fires
     *  `on:progress` BEFORE the terminal settle. */
    private fun publishProgress(entries: Any?) {
        val list = entries as? List<*> ?: return
        for (raw in list) {
            @Suppress("UNCHECKED_CAST")
            val entry = raw as? Map<String, Any?> ?: continue
            val loaded = JSE.number(entry["loaded"]) ?: 0.0
            val total = JSE.number(entry["total"]) ?: 0.0
            val progress = linkedMapOf<String, Any?>(
                "direction" to JSE.string(entry["direction"] ?: "down"),
                "loaded" to loaded,
                "total" to total,
                "fraction" to if (total > 0.0) loaded / total else 0.0,
            )
            DsxPaths.set(store, "$asName.progress", progress)
            emitEvent("progress", linkedMapOf("progress" to progress))
        }
    }

    private fun cacheKey(req: Map<String, Any?>): String =
        JSE.string(req["method"]) + "" + JSE.string(req["url"]) + "" +
            JSE.watchKey(req["headers"]) + "" + JSE.watchKey(req["body"]) + "" +
            JSE.string(req["expect"]) + "" + JSE.string(req["_cachePartition"])

    private fun mountFire() {
        if (declaredError != null) { publishDeclaredError(declaredError); return }
        val req = materialize()
        lastRequestKey = requestKey(req)
        val blocked = gateOf(req)
        publishGate(blocked)
        if (blocked.isNotEmpty()) return
        if (JSE.truthy(req["auto"])) {
            everFired = true
            fire(req, allowCache = true, refreshing = false, forceNetwork = false)
        }
    }

    /** The host calls this per store publish (the watch machinery). Re-materializes and
     *  refires ONLY when the materialized request changed — the cross-platform law. */
    fun storeChanged() {
        if (disposed || !isAsNameValid || declaredError != null) return
        val req = materialize()
        val key = requestKey(req)
        synchronized(lifecycleLock) {
            if (key == lastRequestKey) return
            lastRequestKey = key
        }
        cancelDebounce()
        // /web/11: a gated block publishes its gate and never fires. It fires the moment
        // ITS inputs are whole — no wave barrier, no ceremony.
        val blocked = gateOf(req)
        publishGate(blocked)
        if (blocked.isNotEmpty()) return
        if (!JSE.truthy(req["auto"])) return
        everFired = true
        val delay = spec["debounce"]?.trim()?.toDoubleOrNull()
            ?.takeIf { it.isFinite() && it > 0.0 }
            ?.toLong()
            ?: 0L
        if (delay <= 0L) {
            fire(req, allowCache = true, refreshing = false, forceNetwork = false)
            return
        }
        val ticket = synchronized(lifecycleLock) {
            debounceGeneration += 1
            debounceGeneration
        }
        val fired = AtomicBoolean(false)
        val call = schedule(delay) {
            fired.set(true)
            val owns = synchronized(lifecycleLock) {
                if (disposed || ticket != debounceGeneration) false
                else {
                    debounceCall = null
                    true
                }
            }
            if (owns) fire(req, allowCache = true, refreshing = false, forceNetwork = false)
        }
        synchronized(lifecycleLock) {
            if (disposed || fired.get() || ticket != debounceGeneration) call.cancel()
            else debounceCall = call
        }
    }

    private fun cancelDebounce() {
        val pending = synchronized(lifecycleLock) {
            debounceGeneration += 1
            val claimed = debounceCall
            debounceCall = null
            claimed
        }
        pending?.cancel()
    }

    // ── firing ─────────────────────────────────────────────────────────────────────────

    private fun serveCached(entry: Any?, at: Long) {
        DsxPaths.set(store, "$asName.loading", false)
        DsxPaths.set(store, "$asName.refreshing", false)
        DsxPaths.set(store, "$asName.data", entry)
        DsxPaths.set(store, "$asName.error", null)
        DsxPaths.set(store, "$asName.fetchedAt", at.toDouble())
        DsxPaths.set(store, "$asName.status", "ready")
        emitEvent("success", linkedMapOf("data" to entry, "status" to 200.0, "cached" to true))
        graph?.notifySettled(asName)
    }

    private fun fire(
        req: Map<String, Any?>,
        allowCache: Boolean,
        refreshing: Boolean,
        forceNetwork: Boolean,
        completion: ((Map<String, Any?>?) -> Unit)? = null,
    ): Map<String, Any?>? {
        if (disposed || !isAsNameValid) {
            completion?.invoke(null)
            return null
        }
        // Snapshot the auth/session partition at request start. A Set-Cookie response may
        // advance the live partition before settle; old-session data must never be written
        // under that newer identity.
        val stableCacheKey = cacheKey(req)
        if (allowCache && !forceNetwork && policy !is Policy.NoStore) {
            val entry = cacheGet(store, stableCacheKey)
            if (entry != null) {
                val age = now() - entry.at
                when (val p = policy) {
                    is Policy.MaxAge -> if (age < p.age) {
                        supersedeActive()
                        serveCached(entry.data, entry.at)
                        completion?.invoke(linkedMapOf(
                            "ok" to true, "status" to 200.0, "data" to entry.data, "cached" to true))
                        return null
                    }
                    is Policy.Swr -> {
                        if (age < p.fresh) {
                            supersedeActive()
                            serveCached(entry.data, entry.at)
                            completion?.invoke(linkedMapOf(
                                "ok" to true, "status" to 200.0, "data" to entry.data, "cached" to true))
                            return null
                        }
                        if (age < p.fresh + p.stale) {
                            serveCached(entry.data, entry.at)          // serve stale NOW …
                            return network(req, stableCacheKey, refreshing = true,
                                           completion = completion) // … revalidate behind it
                        }
                    }
                }
            }
        }
        return network(req, stableCacheKey, refreshing, completion)
    }

    private fun network(
        req: Map<String, Any?>,
        stableCacheKey: String,
        refreshing: Boolean,
        completion: ((Map<String, Any?>?) -> Unit)? = null,
    ): Map<String, Any?>? {
        val gen = generation.incrementAndGet()
        val previous = synchronized(lifecycleLock) {
            val old = activeFetch to pendingCompletion
            activeFetch = null
            pendingGeneration = if (completion != null) gen else null
            pendingCompletion = completion
            streamChunks = null
            streamApproxBytes = 0L
            old
        }
        // Never invoke arbitrary transport/user completion while holding lifecycleLock.
        previous.first?.cancel()
        previous.second?.invoke(null)
        DsxPaths.set(store, "$asName.${if (refreshing) "refreshing" else "loading"}", true)
        DsxPaths.set(store, "$asName.status", if (refreshing) "refreshing" else "loading")
        val retries = maxOf(0, (spec["retry"]?.toIntOrNull() ?: 0))

        val async = asyncFetch
        val cacheableResponse =
            JSE.string(req["method"]).uppercase() in setOf("GET", "HEAD")
        if (async != null) {
            fun attempt(index: Int) {
                if (disposed || gen != generation.get()) {
                    completePending(gen, null)
                    return
                }
                // A streaming transport may emit many partials, then exactly one terminal.
                // A broken adapter cannot emit after terminal or settle twice.
                val delivery = DeliveryGate()
                val sawPartial = AtomicBoolean(false)
                val call = async.request(JSE.string(req["url"]), req) { res ->
                    val partial = JSE.truthy(res["partial"])
                    if (!delivery.claim(partial)) return@request
                    if (disposed || gen != generation.get()) {
                        completePending(gen, null)
                        return@request
                    }
                    if (partial) {
                        sawPartial.set(true)
                        val message = if (res.containsKey("message")) res["message"] else res["data"]
                        if (!applyStreamMessage(gen, message, cacheableResponse) &&
                            delivery.claim(partial = false)
                        ) {
                            val active = synchronized(lifecycleLock) {
                                val claimed = activeFetch
                                activeFetch = null
                                claimed
                            }
                            active?.cancel()
                            settle(
                                stableCacheKey,
                                cacheableResponse,
                                gen,
                                linkedMapOf(
                                    "ok" to false,
                                    "status" to -2.0,
                                    "data" to null,
                                    "error" to "response_too_large",
                                ),
                            )
                        }
                        return@request
                    }
                    val networkFailure =
                        !JSE.truthy(res["ok"]) && (JSE.number(res["status"]) ?: 0.0) == 0.0
                    if (networkFailure && !sawPartial.get() &&
                        index < retries && !JSE.truthy(res["aborted"])
                    ) {
                        attempt(index + 1)
                    } else if (JSE.truthy(res["aborted"])) {
                        synchronized(lifecycleLock) {
                            activeFetch = null
                            streamChunks = null
                            streamApproxBytes = 0L
                        }
                        DsxPaths.set(store, "$asName.loading", false)
                        DsxPaths.set(store, "$asName.refreshing", false)
                        completePending(gen, null)
                    } else {
                        settle(stableCacheKey, cacheableResponse, gen, res)
                    }
                }
                synchronized(lifecycleLock) {
                    if (delivery.isTerminal() || disposed || gen != generation.get()) call.cancel()
                    else activeFetch = call
                }
            }
            attempt(0)
            return null
        }

        var res: Map<String, Any?> = linkedMapOf("ok" to false, "status" to 0.0, "data" to null)
        for (attempt in 0..retries) {
            res = fetch(JSE.string(req["url"]), req)
            if (JSE.truthy(res["aborted"])) {
                DsxPaths.set(store, "$asName.loading", false)
                DsxPaths.set(store, "$asName.refreshing", false)
                completePending(gen, null)
                return null
            }
            if (JSE.truthy(res["ok"]) || (JSE.number(res["status"]) ?: 0.0) != 0.0) break // only network errors retry
        }
        if (gen != generation.get() || disposed) {
            completePending(gen, null)
            return null
        }
        settle(stableCacheKey, cacheableResponse, gen, res)
        return res
    }

    /** Apply one already-decoded SSE message before EOF. Returns false when a custom
     * transport exceeds the same bounded-retention contract as the native parser. */
    private fun applyStreamMessage(
        gen: Int,
        message: Any?,
        cacheableResponse: Boolean,
    ): Boolean {
        val estimate = estimateStreamMessage(message)
        val snapshot = synchronized(lifecycleLock) {
            if (disposed || gen != generation.get()) return false
            val chunks = streamChunks ?: ArrayList<Any?>().also { streamChunks = it }
            if (chunks.size >= maxStreamEvents ||
                estimate > maxStreamAggregateBytes - streamApproxBytes
            ) {
                return false
            }
            chunks += message
            streamApproxBytes += estimate
            StreamSnapshot(chunks, chunks.size, lifecycleLock)
        }
        if (!cacheableResponse) cacheClear(store)
        DsxPaths.set(store, "$asName.data", snapshot)
        // A persistent stream may never reach EOF. Its first message resolves loading now.
        DsxPaths.set(store, "$asName.loading", false)
        DsxPaths.set(store, "$asName.refreshing", false)
        DsxPaths.set(store, "$asName.error", null)
        DsxPaths.set(store, "$asName.fetchedAt", now().toDouble())
        emitEvent("message", linkedMapOf("data" to message))
        return true
    }

    private fun estimateStreamMessage(message: Any?): Long {
        // Keep the former conservative UTF-16-sized contract without constructing a
        // serialized watch-key copy for every event. The iterative estimator also
        // handles cycles by identity and rejects opaque objects instead of recursing.
        val halfLimit = maxStreamAggregateBytes / 2L
        val units = estimateCacheValue(message, halfLimit)
        return if (units > halfLimit) maxStreamAggregateBytes + 1L else units * 2L
    }

    private fun settle(
        stableCacheKey: String,
        cacheableResponse: Boolean,
        gen: Int,
        res: Map<String, Any?>,
    ) {
        if (gen != generation.get() || disposed) {
            completePending(gen, null)
            return
        }
        synchronized(lifecycleLock) {
            if (gen == generation.get()) activeFetch = null
        }
        // networking.md N2: progress entries publish + fire BEFORE the terminal settle
        publishProgress(res["progress"])
        val ok = JSE.truthy(res["ok"])
        if (ok && !cacheableResponse) cacheClear(store)
        if (ok && JSE.truthy(res["streamed"])) {
            val chunks = synchronized(lifecycleLock) {
                val settled = ArrayList<Any?>(streamChunks ?: emptyList())
                streamChunks = null
                streamApproxBytes = 0L
                settled
            }
            DsxPaths.set(store, "$asName.data", chunks)
            DsxPaths.set(store, "$asName.loading", false)
            DsxPaths.set(store, "$asName.refreshing", false)
            DsxPaths.set(store, "$asName.error", null)
            DsxPaths.set(store, "$asName.fetchedAt", now().toDouble())
            if (cacheableResponse && policy !is Policy.NoStore) {
                cachePut(store, stableCacheKey, Entry(ArrayList<Any?>(chunks), now()))
            }
            DsxPaths.set(store, "$asName.status", "ready")
            emitEvent(
                "success",
                linkedMapOf(
                    "data" to chunks,
                    "status" to (JSE.number(res["status"]) ?: 200.0),
                ),
            )
            graph?.notifySettled(asName)
            val terminal = LinkedHashMap(res)
            terminal["data"] = chunks
            completePending(gen, terminal)
            return
        }
        val stream = res["stream"] as? List<Any?>
        if (ok && stream != null) {
            var aggregate = 0L
            val withinBound = stream.size <= maxStreamEvents && stream.all { chunk ->
                val estimate = estimateStreamMessage(chunk)
                if (estimate > maxStreamAggregateBytes - aggregate) false
                else {
                    aggregate += estimate
                    true
                }
            }
            if (!withinBound) {
                settle(
                    stableCacheKey,
                    cacheableResponse,
                    gen,
                    linkedMapOf(
                        "ok" to false,
                        "status" to -2.0,
                        "data" to null,
                        "error" to "response_too_large",
                    ),
                )
                return
            }
            val chunks = ArrayList<Any?>()
            val streamLock = Any()
            for (chunk in stream) {
                val snapshot = synchronized(streamLock) {
                    chunks.add(chunk)
                    StreamSnapshot(chunks, chunks.size, streamLock)
                }
                DsxPaths.set(store, "$asName.data", snapshot)
                emitEvent("message", linkedMapOf("data" to chunk))
            }
            // Replace the prefix view with one compact terminal list. The stream path
            // now performs O(n) total copying instead of copying every prefix at EOF.
            DsxPaths.set(store, "$asName.data", ArrayList<Any?>(chunks))
            DsxPaths.set(store, "$asName.loading", false)
            DsxPaths.set(store, "$asName.refreshing", false)
            DsxPaths.set(store, "$asName.error", null)
            DsxPaths.set(store, "$asName.fetchedAt", now().toDouble())
            if (cacheableResponse && policy !is Policy.NoStore) {
                cachePut(store, stableCacheKey, Entry(ArrayList<Any?>(chunks), now()))
            }
            DsxPaths.set(store, "$asName.status", "ready")
            emitEvent("success", linkedMapOf("data" to chunks, "status" to (JSE.number(res["status"]) ?: 200.0)))
            graph?.notifySettled(asName)
            completePending(gen, res)
            return
        }
        synchronized(lifecycleLock) {
            streamChunks = null
            streamApproxBytes = 0L
        }
        DsxPaths.set(store, "$asName.loading", false)
        DsxPaths.set(store, "$asName.refreshing", false)
        DsxPaths.set(store, "$asName.fetchedAt", now().toDouble())
        DsxPaths.set(store, "$asName.status", if (ok) "ready" else "error")
        if (ok) {
            DsxPaths.set(store, "$asName.data", res["data"])
            DsxPaths.set(store, "$asName.error", null)
            if (cacheableResponse && policy !is Policy.NoStore) {
                cachePut(store, stableCacheKey, Entry(res["data"], now()))
            }
            emitEvent("success", linkedMapOf("data" to res["data"], "status" to (JSE.number(res["status"]) ?: 200.0)))
        } else {
            val error = linkedMapOf<String, Any?>(
                "status" to (JSE.number(res["status"]) ?: 0.0),
                "message" to (res["error"]?.let { JSE.string(it) } ?: "http ${JSE.string(res["status"])}"),
                "body" to res["data"],
            )
            DsxPaths.set(store, "$asName.error", error)
            emitEvent("error", linkedMapOf("error" to error))
        }
        // /web/11: this block settled — its dependents fire the moment THEIR inputs are whole.
        graph?.notifySettled(asName)
        completePending(gen, res)
    }

    private fun completePending(gen: Int, value: Map<String, Any?>?) {
        val callback = synchronized(lifecycleLock) {
            if (pendingGeneration != gen) return
            val claimed = pendingCompletion
            pendingGeneration = null
            pendingCompletion = null
            claimed
        }
        callback?.invoke(value)
    }

    /** Author handlers are downstream observers. One throwing handler must never abort
     * transport settlement, strand an await continuation, or starve later SSE events. */
    private fun emitEvent(name: String, payload: Map<String, Any?>) {
        try {
            onEvent(name, payload)
        } catch (error: Exception) {
            kernelLog("[ApiBlock] on:$name failed: ${error.message ?: error::class.java.simpleName}")
        }
    }

    /** Make a cache-only result the newest owner before publishing it. */
    private fun supersedeActive() {
        generation.incrementAndGet()
        val previous = synchronized(lifecycleLock) {
            val claimed = activeFetch to pendingCompletion
            activeFetch = null
            pendingGeneration = null
            pendingCompletion = null
            streamChunks = null
            streamApproxBytes = 0L
            claimed
        }
        previous.first?.cancel()
        previous.second?.invoke(null)
    }

    // ── the handle (refresh / send / cancel — callable from the action runner) ────────

    /** revalidate now — bypasses freshness, rewrites the cache; data stays until resolve */
    fun refresh() {
        cancelDebounce()
        fire(materialize(), allowCache = false, refreshing = true, forceNetwork = true)
    }

    fun refresh(completion: (Map<String, Any?>?) -> Unit) {
        cancelDebounce()
        fire(materialize(), allowCache = false, refreshing = true, forceNetwork = true,
             completion = completion)
    }

    /** fire with a body override; mutations always hit the network */
    fun send(args: Map<String, Any?>? = null): Map<String, Any?>? {
        cancelDebounce()
        val req = LinkedHashMap(materialize())
        if (args != null) req["body"] = args
        incompleteInput(req)?.let { return it }
        return fire(req, allowCache = false, refreshing = false, forceNetwork = true)
    }

    /** /web/11: a manual send IGNORES gating but not HOLES — sending with a hole in the
     *  inputs returns an `incomplete-input` envelope instead of a malformed request. */
    private fun incompleteInput(req: Map<String, Any?>): Map<String, Any?>? {
        val missing = (req["_missing"] as? List<*>)?.map { JSE.string(it) } ?: emptyList()
        if (missing.isEmpty()) return null
        return linkedMapOf(
            "ok" to false, "status" to -3.0, "data" to null,
            "error" to linkedMapOf<String, Any?>("kind" to "incomplete-input", "missing" to missing),
        )
    }

    /** Async handle twin used by the action runner's `await <as>.send(...)`. */
    fun send(args: Map<String, Any?>? = null, completion: (Map<String, Any?>?) -> Unit) {
        cancelDebounce()
        val req = LinkedHashMap(materialize())
        if (args != null) req["body"] = args
        incompleteInput(req)?.let { completion(it); return }
        fire(req, allowCache = false, refreshing = false, forceNetwork = true, completion = completion)
    }

    fun cancel() {
        cancelDebounce()
        generation.incrementAndGet() // orphan anything in flight
        val pending = synchronized(lifecycleLock) {
            val claimed = activeFetch to pendingCompletion
            activeFetch = null
            pendingGeneration = null
            pendingCompletion = null
            streamChunks = null
            streamApproxBytes = 0L
            claimed
        }
        pending.first?.cancel()
        pending.second?.invoke(null)
        if (isAsNameValid) {
            DsxPaths.set(store, "$asName.loading", false)
            DsxPaths.set(store, "$asName.refreshing", false)
            if (JSE.string(DsxPaths.get(store, "$asName.status")) != "error") {
                DsxPaths.set(store, "$asName.status", "ready")
            }
        }
    }

    fun dispose() {
        disposed = true
        cancel()
        graph?.detach(asName)
    }
}
