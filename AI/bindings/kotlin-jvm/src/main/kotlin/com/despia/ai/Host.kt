// Host.kt - everything ABOVE the engine seam, in Kotlin.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The Kotlin twin of bindings/ts/src/host.ts. The engine streams typed blocks
// and knows nothing else; policy lives here - the catalog, fit, the router, the
// tool registry, the agentic loop, approvals, the transcript, delivery and typed
// absence. That split is what makes swapping engines cheap, and it is why this
// file exists three times rather than once inside the engine.
//
// It drives the REAL C++ MockEngine over JNI. Where the TypeScript host runs its
// own synchronous mock, this one blocks on the native worker per turn, which is
// what a real consumer does.

package com.despia.ai

private val KNOWN_ENTRY_FIELDS = setOf(
    "schema_version", "id", "name", "family", "category", "engine", "format", "status", "requires",
    "files", "license", "languages", "inputs", "outputs", "context_length", "context_length_max",
    "parameters", "thinking", "tool_dialect", "template", "sampling", "requirements", "perf_priors",
    "mock", "origin",
)

/** Verdicts that mean "do not spend the bytes". A download is the most
 *  expensive thing a user can be asked to wait for, so these are refused
 *  BEFORE the transfer rather than discovered at load time. */
private val REFUSES_DOWNLOAD = mapOf(
    "too_big" to "model_too_big",
    "unsupported" to "unsupported",
    "quarantined" to "model_quarantined",
)

private val KNOWN_BLOCKS = setOf("text", "thinking", "tool", "json", "audio", "image", "file", "embedding")

const val TOOL_DEPTH_CAP = 32

data class BusEvent(val req: String, val event: String, val final: Boolean, val data: Json)

private class Parked(
    val id: String,
    val kind: String,          // "approval" | "deadline"
    val dueAt: Long,
    val resume: (String) -> Unit,
)

/**
 * The reference host for one conformance case.
 *
 * Everything the corpus asserts is an observable on this object, which is the
 * same shape the TypeScript runner reads - one grammar, two implementations.
 */
class Host(private val case: Json) : AutoCloseable {
    private val spec = case
    private var engine: Engine? = null

    val caps: Json
    private val enginePresent = !(spec["engine"].has("present") && !spec["engine"]["present"].bool())
    private val device = spec["device"]
    private val policy = spec["catalog"]["fit_policy"]
    private val table = spec["router"]

    val entries = LinkedHashMap<String, Json>()
    val entryOrder = mutableListOf<String>()
    /** The ids the USER added at runtime. This is the overlay a real device
     *  persists BESIDE the catalog rather than inside it: an OTA catalog
     *  replaces `entries` wholesale, and a model somebody chose must not
     *  disappear because the fleet's catalog was retuned. */
    val addedIds = mutableListOf<String>()
    private val sources: Json get() = spec["catalog"]["sources"]
    var installed = mutableListOf<String>()
    private var loadedModel: String? = null
    val verdicts = LinkedHashMap<String, Verdict>()
    private val quarantined = mutableSetOf<String>()

    // Observations.
    val events = mutableListOf<BusEvent>()
    val errors = mutableListOf<Json>()
    val absent = mutableListOf<Json>()
    val results = LinkedHashMap<String, Json>()
    val dispatched = mutableListOf<Json>()
    val dispatchGroups = mutableListOf<List<String>>()
    val remoteRequests = mutableListOf<Json>()
    val notices = mutableListOf<Json>()
    val catalogNotices = mutableListOf<Json>()
    val transcript = mutableListOf<Json>()
    val providers = mutableListOf<Json>()
    var buildAbort: Json? = null
    var rows = listOf<Json>()
    var downloadCount = 0
    var mcpConnectCount = 0
    val downloadAttempts = mutableListOf<Json>()
    /** Every URL contacted while RESOLVING a source, in order. Zero is the
     *  whole assertion for a registry the app never allowed. */
    val resolveAttempts = mutableListOf<Json>()
    val downloaded = mutableListOf<Json>()
    val deletedOnMismatch = mutableListOf<String>()
    val pinnedDigests = LinkedHashMap<String, String>()
    var engineLoadCount = 0
    val engineRequests = mutableListOf<Json>()
    val serverResponses = mutableListOf<Json>()
    var discoveryFile: Json? = null
    var boundLoopbackOnly = false
    var tokenInUrl = false
    var snapshotBeforeWrite = false
    var snapshotBeforeFirstWrite = false
    var dispatchedAfterApproval = false
    var transcriptTransmitted = false
    val ridOf = LinkedHashMap<String, Int>()

    private val tools = LinkedHashMap<String, Json>()
    private val parked = mutableListOf<Parked>()
    private var now = 0L
    private val pinned = LinkedHashMap<String, String>()
    private val store = LinkedHashMap<String, Json>()
    private val sessionToken = "session-token"
    private val discoveryToken = "pairing-token"
    private var externalConsent = false
    private var serverStarted = false
    private var writesSeen = 0
    private var approvalSeen = false
    private var ridSeq = 0

    init {
        caps = buildCaps()
        spec["catalog"]["pinned"].fields.forEach { (k, v) -> pinned[k] = v.string() }
        device["quarantined"].strings().forEach { quarantined.add(it) }
        ingestCatalog()
        spec["tools"].items.forEach { t -> tools[t["name"].string()] = t }
        deriveProviders()
        rows = availableRows()
    }

    override fun close() {
        engine?.close()
    }

    private fun buildCaps(): Json {
        val defaults = Json.parse(
            """{"schema_version":1,"abi":1,"engines":["gguf","mock"],"formats":["gguf","mock"],
                "modalities":["text","embedding"],"dialects":["hermes-json"],
                "features":["gbnf","structured-output","tools"]}"""
        )
        val declared = spec["engine"]["capabilities"]
        if (declared !is Json.Obj) return defaults
        val merged = LinkedHashMap(defaults.fields)
        if (spec["engine"].has("abi")) merged["abi"] = spec["engine"]["abi"]
        declared.fields.forEach { (k, v) -> merged[k] = v }
        return Json.Obj(merged)
    }

    // --- catalog ---------------------------------------------------------

    private fun ingestCatalog() {
        for (entry in spec["catalog"]["entries"].items) {
            // A malformed row is a ROW-level problem. One bad or too-new entry
            // must never blind an app to the rest of its models.
            val id = entry["id"].stringOrNull()
            if (id == null || entry["engine"].stringOrNull() == null) {
                catalogNotices.add(jsonOf(
                    "code" to Json.Str("entry_skipped"),
                    "reason" to Json.Str("missing_required_field")))
                continue
            }
            val unknown = entry.fields.keys.filter { it !in KNOWN_ENTRY_FIELDS }
            if (unknown.isNotEmpty()) {
                catalogNotices.add(jsonOf(
                    "code" to Json.Str("unknown_fields_ignored"),
                    "entry" to Json.Str(id),
                    "fields" to Json.Arr(unknown.map { Json.Str(it) })))
            }
            entries[id] = entry
            entryOrder.add(id)
        }
        // The RESTORED overlay: entries a previous launch added, read back
        // before anything else runs. A shipped row of the same id always wins -
        // the catalog is the fleet's document and a device-local addition may
        // never shadow it - and the collision is a notice rather than a silent
        // drop.
        for (entry in spec["catalog"]["added"].items) {
            val addedId = entry["id"].stringOrNull() ?: continue
            if (entries.containsKey(addedId)) {
                catalogNotices.add(jsonOf(
                    "code" to Json.Str("added_entry_skipped"),
                    "reason" to Json.Str("id_shadows_catalog"),
                    "entry" to Json.Str(addedId)))
                continue
            }
            val fields = LinkedHashMap(entry.fields)
            fields["origin"] = Json.Obj(LinkedHashMap(entry["origin"].fields).also {
                it["added"] = Json.Bool(true)
            })
            entries[addedId] = Json.Obj(fields)
            entryOrder.add(addedId)
            addedIds.add(addedId)
        }

        installed = spec["catalog"]["installed"].strings().toMutableList()
        for (id in installed) {
            if (!entries.containsKey(id)) {
                entries[id] = Json.parse("""{"id":"$id","engine":"mock","format":"mock"}""")
                entryOrder.add(id)
            }
        }
        spec["catalog"]["loaded"].stringOrNull()?.let { loadedModel = it }
        recomputeVerdicts()
    }

    private fun recomputeVerdicts() {
        val dev = deviceWithQuarantine()
        entries.forEach { (id, entry) -> verdicts[id] = Fit.evaluate(entry, dev, caps, policy) }
    }

    private fun deviceWithQuarantine(): Json {
        val fields = LinkedHashMap(device.fields)
        fields["quarantined"] = Json.Arr(quarantined.map { Json.Str(it) })
        return Json.Obj(fields)
    }

    private fun row(id: String): Json {
        val verdict = verdicts[id]?.toJson() ?: Json.Obj(mapOf("verdict" to Json.Str("unsupported")))
        val fields = LinkedHashMap(verdict.fields)
        fields["id"] = Json.Str(id)
        entries[id]?.get("status")?.stringOrNull()?.let { fields["status"] = Json.Str(it) }
        // A user-added model is never presented as a shipped one. The flag is
        // on the ROW because the row is what a surface renders.
        if (entries[id]?.get("origin")?.get("added")?.bool() == true) fields["added"] = Json.Bool(true)
        return Json.Obj(fields)
    }

    private fun installedRows(): List<Json> = entryOrder.filter { it in installed }.map { row(it) }

    /** Retirement stops NEW downloads only. An installed model keeps working
     *  forever - there is no remote kill switch. */
    private fun availableRows(): List<Json> =
        entryOrder.filter { (entries[it]?.get("status")?.string("active") ?: "active") != "retired" }
            .map { row(it) }

    // --- tools -----------------------------------------------------------

    private fun deriveSchema(fromArgs: Json): Json {
        val properties = LinkedHashMap<String, Json>()
        val required = mutableListOf<Json>()
        fromArgs.fields.forEach { (name, spec) ->
            properties[name] = jsonOf("type" to Json.Str(spec["type"].string()))
            if (spec["required"].bool()) required.add(Json.Str(name))
        }
        val out = LinkedHashMap<String, Json>()
        out["type"] = Json.Str("object")
        out["properties"] = Json.Obj(properties)
        if (required.isNotEmpty()) out["required"] = Json.Arr(required)
        return Json.Obj(out)
    }

    private fun toolDefinition(name: String): Json? {
        val t = tools[name] ?: return null
        // A module tool DERIVES its schema; a page or MCP tool carries its own
        // arbitrary JSON Schema through verbatim, never down-converted.
        val parameters = if (t.has("fromArgs")) deriveSchema(t["fromArgs"])
                         else if (t.has("schema")) t["schema"]
                         else jsonOf("type" to Json.Str("object"))
        val def = LinkedHashMap<String, Json>()
        def["name"] = Json.Str(t["name"].string(name))
        def["parameters"] = parameters
        t["description"].stringOrNull()?.let { def["description"] = Json.Str(it) }
        when (val source = t["source"].stringOrNull()) {
            null -> {}
            else -> {
                def["source"] = Json.Str(source)
                // Descriptions are UNTRUSTED input: tagged with where they came
                // from, and they change no policy.
                if (source == "mcp") def["provenance"] = Json.Str("mcp:${t["server"].string("unknown")}")
                if (source == "page") def["provenance"] = Json.Str("page")
            }
        }
        return Json.Obj(def)
    }

    // --- providers -------------------------------------------------------

    private fun deriveProviders() {
        val claimants = LinkedHashMap<String, MutableList<Json>>()
        for (row in spec["providers"].items) {
            if (exclusionFor(row["chain"].string()) != null) continue   // exclusion is the resolution
            claimants.getOrPut(row["modality"].string()) { mutableListOf() }.add(row)
        }
        for ((modality, list) in claimants) {
            if (list.size > 1) {
                // Two ENABLED claimants of one modality is a BUILD abort, never
                // a runtime coin flip.
                buildAbort = jsonOf(
                    "code" to Json.Str("facet_key_collision"),
                    "word" to Json.Str("provider"),
                    "key" to Json.Str(modality),
                    "claimants" to Json.Arr(list.map { Json.Str(it["chain"].string()) }))
                return
            }
        }
        for ((modality, list) in claimants) {
            val row = list[0]
            val engineId = row["engine"].stringOrNull()
            val carried = engineId == null || engineId in caps["engines"].strings()
            val fields = linkedMapOf<String, Json>(
                "modality" to Json.Str(modality),
                "chain" to Json.Str(row["chain"].string()),
                "available" to Json.Bool(carried))
            if (!carried) fields["reason"] = Json.Str("engine_not_carried")
            providers.add(Json.Obj(fields))
        }
    }

    private fun providerFor(chain: String): Pair<Json, Json>? {
        val row = providers.firstOrNull { it["chain"].string() == chain } ?: return null
        val declared = spec["providers"].items.firstOrNull { it["chain"].string() == chain } ?: return null
        return row to declared
    }

    // --- exclusion / absence ---------------------------------------------

    private fun exclusionFor(chain: String): Json? {
        val overlay = spec["excludedOverlay"][chain]
        return if (overlay is Json.Obj) overlay else null
    }

    private fun absence(label: String?, action: String, code: String, extra: Map<String, Json> = emptyMap()): Json {
        val fields = LinkedHashMap<String, Json>()
        fields["action"] = Json.Str(action)
        fields["code"] = Json.Str(code)
        fields.putAll(extra)
        val record = Json.Obj(fields)
        absent.add(record)
        label?.let { results[it] = jsonOf("error" to record) }
        return record
    }

    // --- the bus ---------------------------------------------------------

    fun call(step: Json) {
        val scheme = step["scheme"].string("intelligence")
        val action = step["action"].string()
        val args = step["args"]
        val label = step["as"].stringOrNull()

        if (scheme == "base") return baseCall(label, action, args)
        if (scheme == "mcp") return mcpCall(label, action, args)

        // Exclusion answers first and by name.
        exclusionFor(scheme)?.let { excluded ->
            val extra = LinkedHashMap<String, Json>()
            extra["reason"] = excluded["reason"]
            if (excluded.has("from")) extra["from"] = excluded["from"]
            else if (scheme.contains('.')) extra["chain"] = Json.Str(scheme)
            absence(label, action, "not_available", extra)
            return
        }
        if (!enginePresent) {
            absence(label, action, "not_available", mapOf("reason" to Json.Str("engine_absent")))
            return
        }

        if (scheme != "intelligence") {
            val provider = providerFor(scheme)
            if (provider != null) return providerCall(label, action, args, provider)
            if (scheme.startsWith("intelligence.")) {
                // A child of the container with no declared row is still a chain
                // of this module: the residency law puts NEW actions on child
                // chains, so the call belongs here.
                val implied = Json.parse("""{"available":true,"chain":"$scheme"}""") to
                    Json.parse("""{"chain":"$scheme"}""")
                return providerCall(label, action, args, implied)
            }
            absence(label, action, "not_available", mapOf("reason" to Json.Str("unknown_scheme")))
            return
        }

        when (action) {
            "capabilities" -> label?.let { results[it] = caps }
            "models", "models.installed" -> {
                rows = installedRows()
                label?.let { results[it] = jsonOf("rows" to Json.Arr(rows)) }
            }
            "models.available" -> {
                rows = availableRows()
                label?.let { results[it] = jsonOf("rows" to Json.Arr(rows)) }
            }
            "models.fit" -> {
                val id = args["model"].string()
                val v = verdicts[id]
                if (v == null) absence(label, action, "unknown_model", mapOf("data" to jsonOf("model" to Json.Str(id))))
                else label?.let { results[it] = v.toJson() }
            }
            "models.add" -> modelsAdd(label, args)
            "models.added" -> label?.let {
                results[it] = jsonOf("rows" to Json.Arr(addedIds.map { id -> row(id) }))
            }
            "models.best" -> modelsBest(label, args)
            "models.clearQuarantine" -> {
                quarantined.remove(args["model"].string())
                recomputeVerdicts()
                label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
            }
            "download" -> download(label, args)
            "completion", "embed" -> completion(label, action, args)
            else -> absence(label, action, "unknown_action")
        }
    }

    // --- open catalog: adding a model at runtime -------------------------

    /**
     * `models.add({ source, prefer?, revision?, id? })`.
     *
     * Turns a registry reference into a catalog entry at RUNTIME, so a
     * developer who wants a model that is not in the shipped eleven writes one
     * call instead of editing a JSON file and rebuilding. What comes out is an
     * ordinary entry: download, the four locks, pre-flight, fit, the governor
     * and load all apply to it unchanged, because it IS the same shape.
     *
     * THE REGISTRY'S ANSWER IS UNTRUSTED INPUT, and the sequence is what that
     * means concretely: the app's declared registry says where to ask and the
     * ANSWER never does; both legs are origin-checked before a byte is sent;
     * nothing in a response may widen `allowed_model_hosts`; a revision that is
     * not an immutable commit is refused; the FILE's own header outranks the
     * registry; and the entry is marked `origin.added` forever.
     */
    private fun modelsAdd(label: String?, args: Json) {
        fun refuse(code: String, extra: Map<String, Json>) {
            absence(label, "models.add", code, extra)
        }
        fun refusal(r: Synth.No) {
            val extra = LinkedHashMap<String, Json>()
            r.data?.let { extra["data"] = it }
            r.message?.let { extra["message"] = Json.Str(it) }
            refuse(r.code, extra)
        }

        val parsed = Catalog.parseSource(args["source"].string())
        val ref = when (parsed) {
            is Synth.No -> return refusal(parsed)
            is Synth.Ok -> parsed.value
        }

        val registry = sources[ref.scheme]
        if (registry !is Json.Obj) {
            // Fail closed, exactly like the origin allowlist: an app that has
            // not declared a registry has not opted into resolving against one.
            return refuse("source_unsupported", mapOf(
                "reason" to Json.Str("registry_not_declared"),
                "data" to jsonOf(
                    "registry" to Json.Str(ref.scheme),
                    // `_`-prefixed keys are the document's own annotations,
                    // never registries.
                    "declared" to Json.Arr(
                        sources.fields.keys.filter { !it.startsWith("_") }.map { Json.Str(it) })),
                "message" to Json.Str("This app does not resolve \"${ref.scheme}:\" sources.")))
        }

        val revision = args["revision"].stringOrNull()
            ?: registry["default_revision"].string("main")
        val apiUrl = Catalog.expand(registry["api"].string(),
            mapOf("repo" to ref.repo, "revision" to revision))
        val allowed = spec["delivery"]["allowed_model_hosts"].strings()

        // The allowlist covers the METADATA leg as well as the bytes. A
        // registry the app never named is not contacted at all.
        Delivery.checkOrigin(apiUrl, allowed)?.let { refusalOutcome ->
            val data = LinkedHashMap(refusalOutcome.data)
            data["leg"] = Json.Str("registry")
            return refuse(refusalOutcome.code ?: "origin_not_allowed", mapOf(
                "data" to Json.Obj(data),
                "message" to Json.Str("This app is not allowed to talk to that model registry.")))
        }

        resolveAttempts.add(jsonOf("url" to Json.Str(apiUrl), "leg" to Json.Str("registry")))
        val answer = spec["origins"][apiUrl]
        val info = answer["repo"]
        if (answer.isNull || answer["unreachable"].bool() || info !is Json.Obj) {
            return refuse("resolve_failed", mapOf(
                "data" to jsonOf("registry" to Json.Str(ref.scheme), "repo" to Json.Str(ref.repo)),
                "message" to Json.Str("That model registry did not answer.")))
        }

        val chosen = Catalog.pickFile(info, ref.path, args["prefer"].stringOrNull())
        val file = when (chosen) {
            is Synth.No -> return refusal(chosen)
            is Synth.Ok -> chosen.value
        }
        val id = args["id"].stringOrNull()

        // Phase one: synthesise WITHOUT the header, only to learn the URL the
        // app's own template resolves to. Nothing is stored from this pass.
        val first = Catalog.synthesize(ref, registry, info, file, id = id)
        val probe = when (first) {
            is Synth.No -> return refusal(first)
            is Synth.Ok -> first.value
        }
        val fileUrl = probe["files"][0]["urls"][0].string()

        Delivery.checkOrigin(fileUrl, allowed)?.let { refusalOutcome ->
            // The response resolved to a host this app never allowed. Nothing
            // in an API document may widen the allowlist, so this is where it
            // stops - and the error names the host, because "add a host" is a
            // decision a developer makes deliberately or not at all.
            val data = LinkedHashMap(refusalOutcome.data)
            data["leg"] = Json.Str("file")
            val host = refusalOutcome.data["host"]?.string() ?: "an origin"
            return refuse(refusalOutcome.code ?: "origin_not_allowed", mapOf(
                "data" to Json.Obj(data),
                "message" to Json.Str(
                    "That model is served from $host, which this app does not allow.")))
        }

        // Phase two: read the header off the file itself and synthesise for
        // real. The bytes outrank the registry on everything they can answer.
        resolveAttempts.add(jsonOf("url" to Json.Str(fileUrl), "leg" to Json.Str("file")))
        val header = spec["origins"][fileUrl]["header"]
        val built = Catalog.synthesize(ref, registry, info, file, header = header, id = id)
        val entry = when (built) {
            is Synth.No -> return refusal(built)
            is Synth.Ok -> built.value
        }
        val entryId = entry["id"].string()

        val existing = entries[entryId]
        if (existing != null && !existing["origin"]["added"].bool()) {
            // A shipped row is the fleet's document. A device-local addition
            // may never take its id and quietly change what a task routes to.
            return refuse("id_conflict", mapOf(
                "data" to jsonOf("model" to Json.Str(entryId), "origin" to Json.Str("catalog")),
                "message" to Json.Str(
                    "This app already ships a model called $entryId. Pass an id to add yours beside it.")))
        }

        entries[entryId] = entry
        if (entryId !in entryOrder) entryOrder.add(entryId)
        if (entryId !in addedIds) addedIds.add(entryId)
        verdicts[entryId] = Fit.evaluate(entry, deviceWithQuarantine(), caps, policy)
        rows = availableRows()

        if (entry["license"]["id"].string() == "unknown") {
            // Engine is not weights. A licence the repository did not state is
            // not a licence anybody may invent, so the entry records the
            // absence and the surface decides whether it will serve it.
            notices.add(jsonOf("code" to Json.Str("license_unknown"),
                "data" to jsonOf("model" to Json.Str(entryId), "repo" to Json.Str(ref.repo))))
        }

        label?.let {
            results[it] = jsonOf(
                "entry" to entry,
                "verdict" to (verdicts[entryId]?.toJson() ?: Json.Null),
                "added" to Json.Bool(true))
        }
    }

    /** The downloadable catalog: everything not retired. Retirement stops NEW
     *  downloads only, which is exactly the right filter for a recommendation. */
    private fun downloadable(): List<String> =
        entryOrder.filter { (entries[it]?.get("status")?.string("active") ?: "active") != "retired" }

    /**
     * The best model of a kind that this device can actually run.
     *
     * ONE ranking, used by the refusal path as a fallback and by `models.best`
     * where the router has no opinion. It reuses `Fit.meetsFloor` rather than
     * restating a rank table: `runs_well` first, then `runs_slow`, and nothing
     * else is a degree of "works". Among equals the LARGEST wins, because the
     * biggest model that runs is the best quality this device can have.
     *
     * IT NEVER SUBSTITUTES ACROSS AN `unknown` CATEGORY, in either direction.
     * The whole offer means "another model of the same kind", so it is only
     * sound when the kind is known on both sides: a model this build could not
     * classify gets no replacement suggested for it, and it is never suggested
     * as a replacement for something else. Answering a refused speech model
     * with a chat model is worse than answering with nothing, because nothing
     * is obviously nothing and a chat model looks like an answer.
     */
    private fun bestAlternative(category: String?, exclude: String?, requireCaps: List<String>): Json {
        if (category == Catalog.CATEGORY_UNKNOWN) {
            return jsonOf(
                "none" to Json.Bool(true),
                "reason" to Json.Str("category_unknown"),
                "category" to Json.Str(Catalog.CATEGORY_UNKNOWN))
        }
        val features = caps["features"].strings()
        val candidates = downloadable().filter { id ->
            if (id == exclude) return@filter false
            val entry = entries[id] ?: return@filter false
            if (entry["category"].stringOrNull() == Catalog.CATEGORY_UNKNOWN) return@filter false
            if (category != null && entry["category"].stringOrNull() != category) return@filter false
            val declared = entry["requires"]["engine_caps"].strings()
            if (requireCaps.any { it !in features || it !in declared }) return@filter false
            val v = verdicts[id]
            v != null && Fit.meetsFloor(v.verdict, null)
        }
        if (candidates.isEmpty()) {
            val fields = linkedMapOf<String, Json>(
                "none" to Json.Bool(true),
                "reason" to Json.Str("no_model_of_this_kind_runs_here"))
            category?.let { fields["category"] = Json.Str(it) }
            return Json.Obj(fields)
        }
        fun rank(id: String): Int = if (Fit.meetsFloor(verdicts[id]!!.verdict, "runs_well")) 1 else 0
        fun size(id: String): Double = entries[id]?.get("requirements")?.get("disk_mb")?.number() ?: 0.0
        val best = candidates.reduce { a, b ->
            when {
                rank(b) > rank(a) -> b
                rank(b) < rank(a) -> a
                size(b) > size(a) -> b
                else -> a          // ties keep catalog order
            }
        }
        return recommendation(best, "best-that-runs")
    }

    private fun recommendation(id: String, reason: String): Json {
        val entry = entries[id] ?: Json.Null
        val fields = linkedMapOf<String, Json>("model" to Json.Str(id))
        entry["name"].stringOrNull()?.let { fields["name"] = Json.Str(it) }
        fields["verdict"] = verdicts[id]?.toJson() ?: jsonOf("verdict" to Json.Str("unsupported"))
        fields["reason"] = Json.Str(reason)
        fields["installed"] = Json.Bool(id in installed)
        fields["download_mb"] = Json.Num(entry["requirements"]["disk_mb"].number())
        return Json.Obj(fields)
    }

    /**
     * `models.best({ task?, category? })` - what should this device DOWNLOAD.
     *
     * The router already answers "which of my INSTALLED models serves this
     * task". This is the question a developer has first, and it is the same
     * function over the whole catalog: `Router.route` with every downloadable
     * id in the candidate set and no stickiness, since a resident model cannot
     * be the answer to what to install.
     */
    private fun modelsBest(label: String?, args: Json) {
        val task = args["task"].stringOrNull()
        val category = args["category"].stringOrNull()

        if (task != null && table["remote"]["policy"].string("local") == "remote-only") {
            absence(label, "models.best", "no_model_available", mapOf(
                "reason" to Json.Str("policy-remote-only"),
                "message" to Json.Str(
                    "This app is configured to run this task remotely, so there is nothing to download.")))
            return
        }

        var requireCaps = emptyList<String>()
        if (task != null) {
            val spec0 = if (table["tasks"].has(task)) table["tasks"][task]
                        else table["tasks"][table["default"].string()]
            requireCaps = spec0["require_caps"].strings()
            // The router's declared preference order IS the app's ranking.
            // Where it has one, it wins over any size heuristic.
            val local = Json.Obj(LinkedHashMap(table.fields).also { it.remove("remote") })
            val decision = Router.route(task, local, downloadable(), entries, verdicts, caps, null)
            if (decision is Decision.Local) {
                label?.let { results[it] = recommendation(decision.model, decision.reason) }
                return
            }
        }

        val best = bestAlternative(category, null, requireCaps)
        if (best["none"].bool()) {
            val data = LinkedHashMap<String, Json>()
            category?.let { data["category"] = Json.Str(it) }
            task?.let { data["task"] = Json.Str(it) }
            absence(label, "models.best", "no_model_available", mapOf(
                "reason" to best["reason"],
                "data" to Json.Obj(data),
                "message" to Json.Str("No model in this catalog runs on this device.")))
            return
        }
        label?.let { results[it] = best }
    }

    /** A refusal a person reads. It says what is wrong and what to do about it,
     *  because a download refusal is user-facing in effect whatever the code
     *  says. */
    private fun refusalSentence(id: String, verdict: Verdict, fallback: Json): String {
        val offer = if (fallback["reason"].stringOrNull() == "category_unknown") {
            // Saying nothing runs here would be a different, false claim. What
            // is true is narrower: this build could not tell what kind of model
            // it is, so it has nothing it is entitled to offer in its place.
            " This build could not tell what kind of model that is, so it is not suggesting a replacement."
        } else if (fallback["none"].bool()) {
            " No model in this catalog runs on this device."
        } else {
            val how = if (fallback["verdict"]["verdict"].string() == "runs_well") "runs well" else "runs, slowly"
            " Try ${fallback["model"].string()} instead - it $how on this device."
        }
        return when {
            verdict.verdict == "too_big" && verdict.reason == "memory" ->
                "$id needs more memory than this device gives an app, so it would not run " +
                "even once it downloaded.$offer"
            verdict.verdict == "too_big" -> "$id is too big for this device.$offer"
            verdict.verdict == "quarantined" ->
                "$id crashed this app the last time it loaded and is held back until you clear it.$offer"
            else -> "This build cannot run $id (${verdict.reason ?: "unsupported"}).$offer"
        }
    }

    private fun download(label: String?, args: Json) {
        val id = args["model"].string()
        val entry = entries[id]
            ?: return run { absence(label, "download", "unknown_model", mapOf("data" to jsonOf("model" to Json.Str(id)))) }
        if (entry["status"].string("active") == "retired") {
            absence(label, "download", "model_retired", mapOf("data" to jsonOf("model" to Json.Str(id))))
            return
        }
        // Storage is accounted BEFORE the bytes move. This is the LIVE
        // free-space check and it stays ahead of the fit verdict below: it is
        // the more specific answer and it reads the device, not the catalog.
        val needed = entry["requirements"]["disk_mb"].number()
        val free = if (device.has("free_disk_mb")) device["free_disk_mb"].number() else Double.MAX_VALUE
        val category = entry["category"].stringOrNull()
        if (needed > free) {
            absence(label, "download", "insufficient_storage", mapOf(
                "data" to jsonOf(
                    "needed_mb" to Json.Num(needed), "free_mb" to Json.Num(free),
                    "fallback" to bestAlternative(category, id, emptyList())),
                "message" to Json.Str(
                    "$id needs ${needed.toLong()} MB and this device has ${free.toLong()} MB free. " +
                    "Free up space, or install a smaller model.")))
            return
        }

        // Lock 4, BEFORE the bytes move. It used to run only on the request
        // path, which meant a device with plenty of disk and no memory would
        // download gigabytes and discover at LOAD time that it could not run
        // them - the user paying the wait, the data and the battery for an
        // error. The refusal carries the verdict AND the reason, because "too
        // big for memory" and "too big for disk" send a person to two
        // completely different remedies.
        val verdict = verdicts[id]
        val code = verdict?.let { REFUSES_DOWNLOAD[it.verdict] }
        if (verdict != null && code != null) {
            val fallback = bestAlternative(category, id, emptyList())
            val extra = LinkedHashMap<String, Json>()
            verdict.reason?.let { extra["reason"] = Json.Str(it) }
            val data = linkedMapOf<String, Json>(
                "model" to Json.Str(id), "verdict" to Json.Str(verdict.verdict))
            verdict.reason?.let { data["reason"] = Json.Str(it) }
            data["fallback"] = fallback
            extra["data"] = Json.Obj(data)
            extra["message"] = Json.Str(refusalSentence(id, verdict, fallback))
            absence(label, "download", code, extra)
            return
        }
        if (entry["files"].items.isNotEmpty()) {
            val outcome = Delivery.deliver(
                entry = entry,
                allowed = spec["delivery"]["allowed_model_hosts"].strings(),
                pinned = pinned,
                fetch = { url -> spec["origins"][url].takeIf { it !is Json.Null } },
                onAttempt = { url -> downloadAttempts.add(jsonOf("url" to Json.Str(url))) },
                onDelete = { model -> deletedOnMismatch.add(model) },
            )
            pinned.forEach { (k, v) -> pinnedDigests[k] = v }
            if (!outcome.ok) {
                absence(label, "download", outcome.code ?: "download_failed",
                    mapOf("data" to Json.Obj(outcome.data)))
                return
            }
            downloaded.add(jsonOf(
                "model" to Json.Str(id),
                "sha256" to Json.Str(outcome.sha256 ?: ""),
                "url" to Json.Str(outcome.url ?: ""),
                "verified" to Json.Bool(true)))
        }
        downloadCount++
        if (id !in installed) installed.add(id)
        label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
    }

    // --- completion + the agentic loop -----------------------------------

    private fun completion(label: String?, action: String, args: Json) {
        if (device.has("runs_inference") && !device["runs_inference"].bool()) {
            // Reach-vs-run: every target REACHES the surface; running is a
            // per-target declaration, and reach without run answers typed.
            absence(label, action, "not_available", mapOf(
                "reason" to Json.Str("run_not_declared"),
                "data" to jsonOf("target" to device["target"])))
            return
        }

        var model = args["model"].stringOrNull()
        val task = args["task"].stringOrNull()
        val key = label ?: "#${++ridSeq}"

        if (model != null) {
            if (!entries.containsKey(model)) {
                absence(label, action, "unknown_model", mapOf("data" to jsonOf("model" to Json.Str(model))))
                return
            }
            emit(key, "routing", jsonOf("model" to Json.Str(model), "reason" to Json.Str("explicit")), false)
        } else if (task != null) {
            if (installed.isEmpty() && table["remote"]["policy"].string("local") == "local") {
                absence(label, action, "no_model_available", mapOf("reason" to Json.Str("none_installed")))
                return
            }
            when (val decision = Router.route(task, table, installed, entries, verdicts, caps, loadedModel)) {
                is Decision.None -> {
                    absence(label, action, "no_model_available", mapOf("reason" to Json.Str(decision.reason)))
                    return
                }
                is Decision.Remote -> {
                    emit(key, "routing", jsonOf(
                        "task" to Json.Str(task), "engine" to Json.Str("remote"),
                        "reason" to Json.Str(decision.reason)), false)
                    return runRemote(label, key)
                }
                is Decision.Local -> {
                    emit(key, "routing", jsonOf(
                        "task" to Json.Str(task), "model" to Json.Str(decision.model),
                        "reason" to Json.Str(decision.reason)), false)
                    model = decision.model
                }
            }
        } else {
            absence(label, action, "no_model_available", mapOf("reason" to Json.Str("none_installed")))
            return
        }

        val entry = entries[model]!!
        if (entry["engine"].string("mock") !in caps["engines"].strings()) {
            absence(label, action, "unsupported", mapOf(
                "reason" to Json.Str("engine_not_carried"),
                "data" to jsonOf("engine" to entry["engine"])))
            return
        }
        val verdict = verdicts[model]!!
        when (verdict.verdict) {
            "quarantined" -> return absence(label, action, "model_quarantined",
                mapOf("data" to jsonOf("model" to Json.Str(model)))).let { }
            "too_big" -> return absence(label, action, "model_too_big", mapOf("data" to jsonOf(
                "verdict" to Json.Str(verdict.verdict),
                "reason" to Json.Str(verdict.reason ?: "")))).let { }
            "unsupported" -> return absence(label, action, "unsupported",
                mapOf("reason" to Json.Str(verdict.reason ?: ""))).let { }
        }

        // A declared `inputs` list is a contract.
        if (entry.has("inputs")) {
            val declared = entry["inputs"].strings()
            for (message in args["messages"].items) {
                for (part in message["parts"].items) {
                    val type = part["type"].stringOrNull() ?: continue
                    if (type !in declared) {
                        absence(label, action, "unsupported_input", mapOf("data" to jsonOf(
                            "type" to Json.Str(type), "model" to Json.Str(model))))
                        return
                    }
                }
            }
        }

        ensureLoaded(model, entry)
        val messages = args["messages"].items.toMutableList()
        val toolNames = args["tools"].strings()
        turn(label, key, model, messages, toolNames, args, action, 0)
    }

    private fun ensureLoaded(model: String, entry: Json) {
        if (engine == null) engine = Engine()
        val fields = LinkedHashMap(entry.fields)
        fields["engine"] = Json.Str("mock")
        fields["format"] = Json.Str("mock")
        spec["mock"]["models"][model].takeIf { it !is Json.Null }?.let { fields["mock"] = it }
        engineLoadCount++
        engine!!.loadModel(Json.Obj(fields))
        loadedModel = model
    }

    private fun turn(
        label: String?, key: String, model: String, messages: MutableList<Json>,
        toolNames: List<String>, args: Json, kind: String, depth: Int,
    ) {
        val request = LinkedHashMap<String, Json>()
        request["schema_version"] = Json.Num(1.0)
        request["kind"] = Json.Str(kind)
        request["model"] = Json.Str(model)
        request["messages"] = Json.Arr(messages.toList())
        val defs = toolNames.mapNotNull { toolDefinition(it) }
        if (defs.isNotEmpty()) request["tools"] = Json.Arr(defs)
        if (args.has("response_format")) {
            request["response_format"] = args["response_format"]
            // Structured output is v1: the schema compiles to a grammar.
            if ("gbnf" in caps["features"].strings()) request["grammar"] = Json.Str("gbnf")
        }
        engineRequests.add(Json.Obj(request))
        transcript.add(jsonOf("kind" to Json.Str("request"), "model" to Json.Str(model)))

        val toolCalls = mutableListOf<Json>()
        var failure: Json? = null
        var terminal: Json? = null

        val envelopes = engine!!.drain(Json.Obj(request))
        ridOf[key] = envelopes.firstOrNull()?.get("id")?.int() ?: 0
        for (envelope in envelopes) {
            when (envelope["event"].string()) {
                "token" -> {
                    val delta = envelope["data"]["delta"]
                    when {
                        delta["type"].string() == "tool" -> toolCalls.add(delta)
                        delta["type"].string() !in KNOWN_BLOCKS -> notices.add(jsonOf(
                            "code" to Json.Str("unknown_block_ignored"),
                            "data" to jsonOf("type" to delta["type"])))
                        else -> emit(key, "token", envelope["data"], false)
                    }
                }
                "sync" -> emit(key, "sync", envelope["data"], false)
                "error" -> failure = envelope["data"]
                "complete" -> terminal = envelope["data"]
            }
        }

        if (failure != null) {
            errors.add(jsonOf(
                "req" to Json.Str(key),
                "code" to failure["code"],
                "message" to failure["message"]))
            label?.let { results[it] = jsonOf("error" to failure) }
            return
        }

        if (toolCalls.isNotEmpty()) {
            if (depth >= TOOL_DEPTH_CAP) {
                errors.add(jsonOf(
                    "req" to Json.Str(key),
                    "code" to Json.Str("tool_depth_exceeded"),
                    "data" to jsonOf("depth" to Json.Num(TOOL_DEPTH_CAP.toDouble()))))
                return
            }
            dispatchTools(label, key, model, messages, toolNames, args, kind, depth + 1, toolCalls)
            return
        }

        val data = LinkedHashMap<String, Json>()
        data["snapshot"] = Json.Arr(finalSnapshot(model, terminal?.get("snapshot")?.items ?: emptyList()))
        terminal?.get("usage")?.takeIf { it !is Json.Null }?.let { data["usage"] = it }
        if (terminal?.get("cancelled")?.bool() == true) data["cancelled"] = Json.Bool(true)
        emit(key, "complete", Json.Obj(data), true)
        transcript.add(jsonOf("kind" to Json.Str("complete")))
        label?.let { results[it] = Json.Obj(data) }
    }

    /** Blocks this build understands, coalesced, with embeddings stamped. */
    private fun finalSnapshot(model: String, raw: List<Json>): List<Json> {
        val out = mutableListOf<Json>()
        for (block in raw) {
            val type = block["type"].string()
            if (type !in KNOWN_BLOCKS) continue
            if (type == "embedding" && !block.has("model")) {
                out.add(Json.Obj(LinkedHashMap(block.fields).apply { put("model", Json.Str(model)) }))
                continue
            }
            val last = out.lastOrNull()
            if ((type == "text" || type == "thinking") && last != null && last["type"].string() == type) {
                out[out.size - 1] = Json.Obj(LinkedHashMap(last.fields).apply {
                    put("text", Json.Str(last["text"].string() + block["text"].string()))
                })
                continue
            }
            out.add(block)
        }
        return out
    }

    /** Consecutive read-only calls run together; a mutating call runs alone. */
    private fun groupsOf(calls: List<Json>): List<List<Json>> {
        val groups = mutableListOf<List<Json>>()
        var current = mutableListOf<Json>()
        for (call in calls) {
            if (tools[call["name"].string()]?.has("mutates") == true) {
                if (current.isNotEmpty()) { groups.add(current); current = mutableListOf() }
                groups.add(listOf(call))
            } else current.add(call)
        }
        if (current.isNotEmpty()) groups.add(current)
        return groups
    }

    private fun dispatchTools(
        label: String?, key: String, model: String, messages: MutableList<Json>,
        toolNames: List<String>, args: Json, kind: String, depth: Int, calls: List<Json>,
    ) {
        val groups = groupsOf(calls)
        val results = mutableListOf<Json>()

        fun runGroup(index: Int) {
            if (index >= groups.size) {
                messages.addAll(results)
                turn(label, key, model, messages, toolNames, args, kind, depth)
                return
            }
            val group = groups[index]
            var pending = group.size
            val names = group.map { it["name"].string() }
            val done = {
                if (--pending == 0) {
                    dispatchGroups.add(names)
                    runGroup(index + 1)
                }
            }
            for (call in group) runTool(key, call, results, done)
        }
        runGroup(0)
    }

    private fun runTool(key: String, call: Json, results: MutableList<Json>, done: () -> Unit) {
        val id = call["id"].string("call_0")
        val name = call["name"].string()
        val argsIn = call["arguments"]
        transcript.add(jsonOf("kind" to Json.Str("tool_call"), "name" to Json.Str(name), "arguments" to argsIn))

        val answer = { content: Json, status: String ->
            emit(key, "tool", jsonOf("id" to Json.Str(id), "name" to Json.Str(name),
                "status" to Json.Str(status)), false)
            transcript.add(jsonOf("kind" to Json.Str("tool_result"), "id" to Json.Str(id)))
            results.add(jsonOf("role" to Json.Str("tool"), "tool_call_id" to Json.Str(id), "content" to content))
            done()
        }

        // A tool may not call the model that is running it.
        if (name == "intelligence" || name.startsWith("intelligence.")) {
            return answer(jsonOf("error" to Json.Str("tool_self_call")), "refused")
        }
        val spec = tools[name] ?: return answer(jsonOf("error" to Json.Str("tool_unknown")), "unknown")

        val dispatch = {
            if (spec["hangs"].bool()) {
                emit(key, "tool", jsonOf("id" to Json.Str(id), "name" to Json.Str(name),
                    "arguments" to argsIn, "status" to Json.Str("ready")), false)
                park(Parked(id, "deadline", now + spec["deadline_ms"].number(30000.0).toLong()) {
                    answer(jsonOf("error" to Json.Str("tool_timeout")), "timeout")
                })
            } else {
                emit(key, "tool", jsonOf("id" to Json.Str(id), "name" to Json.Str(name),
                    "arguments" to argsIn, "status" to Json.Str("ready")), false)
                if (spec.has("mutates")) {
                    // A pre-write snapshot, then a savepoint: a failure unwinds
                    // atomically and the backup predates the agent.
                    snapshotBeforeWrite = true
                    if (writesSeen == 0) snapshotBeforeFirstWrite = true
                    writesSeen++
                    if (approvalSeen) dispatchedAfterApproval = true
                }
                if (spec["fails"].bool()) answer(jsonOf("error" to Json.Str("tool_failed")), "failed")
                else {
                    val record = LinkedHashMap<String, Json>()
                    record["name"] = Json.Str(name)
                    record["arguments"] = argsIn
                    spec["source"].stringOrNull()?.let { record["source"] = Json.Str(it) }
                    dispatched.add(Json.Obj(record))
                    answer(if (spec.has("returns")) spec["returns"] else jsonOf("ok" to Json.Bool(true)), "done")
                }
            }
        }

        // A `mutates` tool is approval-gated regardless of which source offered
        // it, and a description saying otherwise changes nothing.
        if (spec.has("mutates") && spec["approval"].string() == "prompt") {
            emit(key, "tool", jsonOf("id" to Json.Str(id), "name" to Json.Str(name),
                "arguments" to argsIn, "status" to Json.Str("awaiting_approval")), false)
            val timeout = if (spec.has("approval_timeout_ms")) spec["approval_timeout_ms"].number().toLong()
                          else Long.MAX_VALUE
            park(Parked(id, "approval", if (timeout == Long.MAX_VALUE) timeout else now + timeout) { outcome ->
                transcript.add(jsonOf("kind" to Json.Str("approval"),
                    "id" to Json.Str(id), "decision" to Json.Str(outcome)))
                when (outcome) {
                    "approve" -> {
                        approvalSeen = true
                        emit(key, "tool", jsonOf("id" to Json.Str(id), "status" to Json.Str("approved")), false)
                        dispatch()
                    }
                    "deny" -> answer(jsonOf("error" to Json.Str("tool_denied")), "denied")
                    else -> answer(jsonOf("error" to Json.Str("approval_timeout")), "timeout")
                }
            })
            return
        }
        dispatch()
    }

    // Nothing is held while a tool is parked: no engine request, no write lock.
    private fun park(p: Parked) { parked.add(p) }

    fun approve(id: String, decision: String) {
        val index = parked.indexOfFirst { it.id == id && it.kind == "approval" }
        if (index < 0) return
        val p = parked.removeAt(index)
        p.resume(decision)
    }

    fun tick(ms: Long) {
        now += ms
        while (true) {
            val index = parked.indexOfFirst { it.dueAt <= now }
            if (index < 0) return
            val p = parked.removeAt(index)
            p.resume("timeout")
        }
    }

    // --- providers, remote, base, mcp ------------------------------------

    private fun providerCall(label: String?, action: String, args: Json, provider: Pair<Json, Json>) {
        val (row, declared) = provider
        if (!row["available"].bool()) {
            absence(label, action, "not_available", mapOf(
                "reason" to Json.Str("engine_not_carried"),
                "data" to jsonOf("engine" to declared["engine"])))
            return
        }
        args["language"].stringOrNull()?.let { want ->
            // A request no installed voice serves is a missing asset, not a
            // failure of speech.
            val serving = entryOrder.filter { want in (entries[it]?.get("languages")?.strings() ?: emptyList()) }
            if (serving.none { it in installed }) {
                absence(label, action, "no_voice_for_language", mapOf("data" to jsonOf(
                    "language" to Json.Str(want),
                    "available" to Json.Arr(serving.map { Json.Str(it) }))))
                return
            }
        }
        val model = args["model"].stringOrNull() ?: installed.firstOrNull()
        if (model == null) {
            absence(label, action, "no_model_available", mapOf("reason" to Json.Str("none_installed")))
            return
        }
        val key = label ?: "#${++ridSeq}"
        ensureLoaded(model, entries[model] ?: Json.parse("""{"id":"$model","engine":"mock"}"""))
        turn(label, key, model, mutableListOf(), emptyList(), args, action, 0)
    }

    private fun runRemote(label: String?, key: String) {
        val remote = table["remote"]
        // No credential ships in the app: the app's own backend holds the keys.
        remoteRequests.add(jsonOf(
            "endpoint" to remote["endpoint"],
            "dialect" to remote["dialect"],
            "hasCredential" to Json.Bool(false)))
        val mock = spec["remoteMock"]
        if (mock.has("error")) {
            errors.add(jsonOf(
                "req" to Json.Str(key),
                "code" to Json.Str(mock["error"]["code"].string("remote_failed")),
                "message" to mock["error"]["message"]))
            label?.let { results[it] = jsonOf("error" to mock["error"]) }
            return
        }
        val snapshot = mutableListOf<Json>()
        var seq = 0
        var text = ""
        for (step in mock["script"].items) {
            if (!step.has("token")) continue
            val delta = jsonOf("type" to Json.Str("text"), "text" to step["token"])
            emit(key, "token", jsonOf("seq" to Json.Num(seq.toDouble()), "delta" to delta), false)
            seq++
            text += step["token"].string()
        }
        if (text.isNotEmpty()) snapshot.add(jsonOf("type" to Json.Str("text"), "text" to Json.Str(text)))
        val data = jsonOf("snapshot" to Json.Arr(snapshot))
        emit(key, "complete", data, true)
        label?.let { results[it] = data }
    }

    /** The minimal store the ai corpus needs to prove that a pending approval
     *  holds no write lock. Despia Local proper is OpenSource/Local. */
    private fun baseCall(label: String?, action: String, args: Json) {
        when (action) {
            "put" -> {
                store["${args["store"].string()}/${args["key"].string()}"] = args["value"]
                label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
            }
            "get" -> label?.let {
                results[it] = jsonOf("value" to (store["${args["store"].string()}/${args["key"].string()}"] ?: Json.Null))
            }
            else -> label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
        }
    }

    private fun mcpCall(label: String?, action: String, args: Json) {
        val servers = spec["mcpServers"].items
        when (action) {
            "connect" -> {
                val name = args["server"].string()
                val server = servers.firstOrNull { it["name"].string() == name }
                if (server == null) {
                    // The app's config is the allowlist: a model cannot talk the
                    // app into a new network peer.
                    absence(label, action, "server_not_declared", mapOf("data" to jsonOf("server" to Json.Str(name))))
                    return
                }
                if (server["unreachable"].bool()) {
                    // Degradation is per-server.
                    errors.add(jsonOf(
                        "req" to Json.Str(label ?: ""),
                        "code" to Json.Str("server_unreachable"),
                        "data" to jsonOf("server" to Json.Str(name))))
                    return
                }
                mcpConnectCount++
                for (t in server["tools"].items) {
                    // Namespaced by server, so two servers offering `search`
                    // never collide.
                    val namespaced = "mcp.$name.${t["name"].string()}"
                    tools[namespaced] = Json.Obj(LinkedHashMap(t.fields).apply {
                        put("name", Json.Str(namespaced))
                        put("source", Json.Str("mcp"))
                        put("server", Json.Str(name))
                    })
                }
                label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
            }
            "server.tools" -> {
                val served = spec["servedRows"].items.map { row ->
                    val fields = LinkedHashMap<String, Json>()
                    fields["name"] = row["action"]
                    fields["description"] = row["description"]
                    fields["inputSchema"] = if (row.has("fromArgs")) deriveSchema(row["fromArgs"])
                                            else jsonOf("type" to Json.Str("object"))
                    if (row.has("mutates")) fields["mutates"] = row["mutates"]
                    Json.Obj(fields)
                }
                label?.let { results[it] = jsonOf("tools" to Json.Arr(served)) }
            }
            "server.start" -> {
                serverStarted = true
                // Loopback only, and the token is the boundary rather than the
                // interface - it never rides in a URL.
                boundLoopbackOnly = true
                tokenInUrl = false
                label?.let { results[it] = jsonOf("ok" to Json.Bool(true), "port" to Json.Num(0.0)) }
            }
            "server.consent" -> {
                externalConsent = args["external"].bool()
                discoveryFile = if (externalConsent) jsonOf(
                    "mode" to Json.Str("0600"),
                    "hasPort" to Json.Bool(true),
                    "tokenDistinctFromSession" to Json.Bool(discoveryToken != sessionToken),
                    "removedAfterWithdrawal" to Json.Bool(false))
                else Json.Obj(LinkedHashMap((discoveryFile ?: Json.Obj(emptyMap())).fields).apply {
                    put("removedAfterWithdrawal", Json.Bool(true))
                })
                label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
            }
            else -> label?.let { results[it] = jsonOf("ok" to Json.Bool(true)) }
        }
    }

    fun serverRequest(step: Json) {
        val label = step["as"].string()
        val raw = step["token"]
        val token = when {
            raw.stringOrNull() == "\$session.token" -> sessionToken
            raw.stringOrNull() == "\$discovery.token" -> if (externalConsent) discoveryToken else "stale"
            else -> raw.stringOrNull()
        }
        val valid = token == sessionToken || (token == discoveryToken && externalConsent)
        if (!serverStarted || !valid) {
            serverResponses.add(jsonOf("req" to Json.Str(label), "code" to Json.Str("unauthorized")))
            return
        }
        val row = spec["servedRows"].items.firstOrNull { it["action"].string() == step["tool"].string() }
        if (row == null) {
            serverResponses.add(jsonOf("req" to Json.Str(label), "code" to Json.Str("unknown_tool")))
            return
        }
        if (row.has("mutates") && row["approval"].string() == "prompt") {
            // The protocol is not a bypass: a write requested over MCP waits for
            // approval and runs inside a snapshot, exactly like an in-app one.
            park(Parked(label, "approval", Long.MAX_VALUE) { outcome ->
                if (outcome == "approve") {
                    snapshotBeforeWrite = true
                    approvalSeen = true
                    dispatchedAfterApproval = true
                    serverResponses.add(jsonOf("req" to Json.Str(label), "ok" to Json.Bool(true)))
                } else {
                    serverResponses.add(jsonOf("req" to Json.Str(label), "code" to Json.Str("tool_denied")))
                }
            })
            return
        }
        serverResponses.add(jsonOf("req" to Json.Str(label), "ok" to Json.Bool(true)))
    }

    private fun emit(req: String, event: String, data: Json, final: Boolean) {
        events.add(BusEvent(req, event, final, data))
    }
}
