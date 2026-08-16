// Catalog.kt - synthesising a catalog entry from a model registry's answer.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The Kotlin twin of bindings/ts/src/catalog.ts. One synthesis, two callers on
// the TypeScript side (the authoring tool and `models.add`); here it is the one
// `models.add` calls, and OpenSource/Conformance/ai/open-catalog is what says
// the two produce the same entry from the same inputs.
//
// THE REGISTRY DOCUMENT IS UNTRUSTED INPUT. It is a network document from a
// host, not a fact:
//
//   - THE REGISTRY NEVER NAMES A HOST. Both URLs come from TEMPLATES the APP
//     declared (`catalog.sources`), and the only things interpolated into them
//     are the caller's repo, a validated 40-hex commit and a validated relative
//     path. A response cannot say where the next request goes.
//   - THE REVISION MUST BE AN IMMUTABLE COMMIT. `main` names different bytes on
//     different days and never reaches a stored entry.
//   - THE DIGEST IS A CLAIM. Well formed, it rides into the entry so the
//     download verifies against it before the engine sees the file; MALFORMED,
//     it is dropped and the device pins what it actually downloaded, because a
//     digest that can never match is worse than no digest.
//   - THE LICENCE IS THE REPO'S, and its absence is recorded rather than
//     invented. Engine is not weights.
//   - THE FILE OUTRANKS THE REGISTRY on anything the bytes can answer.

package com.despia.ai

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val MIB = 1024.0 * 1024.0

/** The context the engine SIZES ITS KV CACHE TO, not the model's maximum. */
const val DEFAULT_SERVING_CONTEXT = 4096

private val SEGMENT = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
private val RELATIVE_PATH = Regex("^[A-Za-z0-9][A-Za-z0-9._\\-/]*$")
private val SHARD = Regex("-\\d{5}-of-\\d{5}\\.gguf$")
private val COMMIT = Regex("^[0-9a-f]{40}$")
private val DIGEST = Regex("^[0-9a-f]{64}$")

data class SourceRef(val scheme: String, val repo: String, val path: String?)

/** Either a value or a typed refusal. Never an exception: an add that fails is
 *  an answer, and a crash is not one (constitution Article 7). */
sealed interface Synth<out T> {
    data class Ok<T>(val value: T) : Synth<T>
    data class No(val code: String, val data: Json? = null, val message: String? = null) : Synth<Nothing>
}

object Catalog {

    fun parseSource(source: String): Synth<SourceRef> {
        val raw = source.trim()
        val colon = raw.indexOf(':')
        if (colon <= 0) {
            return Synth.No("source_malformed", jsonOf("source" to Json.Str(raw)),
                "A model source looks like \"hf:org/repo/file.gguf\" or \"hf:org/repo\" with a prefer.")
        }
        val scheme = raw.substring(0, colon)
        val rest = raw.substring(colon + 1)
        if (!SEGMENT.matches(scheme) || rest.contains('?') || rest.contains('#') || rest.contains('\\')) {
            return Synth.No("source_malformed", jsonOf("source" to Json.Str(raw)),
                "That source is not a registry reference.")
        }
        val parts = rest.split('/').filter { it.isNotEmpty() }
        if (parts.size < 2 || parts.any { !SEGMENT.matches(it) }) {
            return Synth.No("source_malformed", jsonOf("source" to Json.Str(raw)),
                "A model source needs an owner and a repository, like \"hf:org/repo\".")
        }
        val path = if (parts.size > 2) parts.drop(2).joinToString("/") else null
        return Synth.Ok(SourceRef(scheme, "${parts[0]}/${parts[1]}", path))
    }

    /** The template is the APP's; the values are validated before they arrive. */
    fun expand(template: String, values: Map<String, String>): String =
        Regex("\\{(\\w+)}").replace(template) { m -> values[m.groupValues[1]] ?: m.value }

    /** A file the engine cannot serve is refused when it is ADDED rather than
     *  at load time on someone's phone. */
    fun formatFor(filename: String): String? = if (filename.endsWith(".gguf")) "gguf" else null

    private fun siblings(info: Json): List<Json> = info["siblings"].items
    private fun ggufNames(info: Json): List<Json> =
        siblings(info).filter { it["rfilename"].string().endsWith(".gguf") }

    /**
     * Which file this add is about: named explicitly, or chosen by a quant
     * preference. The choice is DETERMINISTIC - shortest matching name, then
     * lexicographic - because "the first one the API listed" makes the entry a
     * function of the response's ordering, and a repo that reorders its files
     * would silently change which model an app installs.
     */
    fun pickFile(info: Json, path: String?, prefer: String?): Synth<Json> {
        val available = ggufNames(info)
        if (path != null) {
            val named = siblings(info).firstOrNull { it["rfilename"].string() == path }
                ?: return Synth.No("file_not_found",
                    jsonOf("file" to Json.Str(path),
                           "available" to Json.Arr(available.map { it["rfilename"] })),
                    "That repository has no file called $path.")
            if (SHARD.containsMatchIn(named["rfilename"].string())) {
                return Synth.No("unsupported",
                    jsonOf("reason" to Json.Str("sharded_model"), "file" to named["rfilename"]),
                    "That file is one shard of a split model, and an entry names a single file.")
            }
            return Synth.Ok(named)
        }

        val whole = available.filter { !SHARD.containsMatchIn(it["rfilename"].string()) }
        if (prefer != null) {
            val token = prefer.lowercase()
            val matches = whole.filter { it["rfilename"].string().lowercase().contains(token) }
            if (matches.isEmpty()) {
                val shardedOnly = available.filter { it["rfilename"].string().lowercase().contains(token) }
                if (shardedOnly.isNotEmpty()) {
                    return Synth.No("unsupported",
                        jsonOf("reason" to Json.Str("sharded_model"), "prefer" to Json.Str(prefer)),
                        "Every $prefer file in that repository is a split model.")
                }
                return Synth.No("no_matching_file",
                    jsonOf("prefer" to Json.Str(prefer),
                           "available" to Json.Arr(whole.map { it["rfilename"] })),
                    "No file in that repository matches $prefer.")
            }
            val best = matches.sortedWith(
                compareBy({ it["rfilename"].string().length }, { it["rfilename"].string() }))
            return Synth.Ok(best.first())
        }

        if (whole.size == 1) return Synth.Ok(whole.first())
        if (whole.isEmpty()) {
            return Synth.No("no_matching_file", jsonOf("available" to Json.Arr(emptyList())),
                "That repository publishes no GGUF file this build can serve.")
        }
        return Synth.No("ambiguous_file",
            jsonOf("available" to Json.Arr(whole.map { it["rfilename"] })),
            "That repository publishes several GGUF files. Name one, or pass a prefer like \"Q4_K_M\".")
    }

    // --- what the FILE says ------------------------------------------------

    data class GgufFacts(
        val architecture: String?,
        val parameters: Double?,
        val contextLength: Int?,
        val blockCount: Int?,
        val headCountKv: Int?,
        val headDim: Int?,
        /** `<arch>.pooling_type`, when the file declares one ABOVE zero. Zero is
         *  the vocabulary's own "no pooling", so it is read as absence rather
         *  than as a value - which is why it rides through the same
         *  positive-only `positive` every other fact does. */
        val pooling: Double? = null,
    )

    private fun positive(v: Json): Double? =
        (v as? Json.Num)?.value?.takeIf { it.isFinite() && it > 0 }

    /** Normalises the raw header table. Everything except `general.*` is
     *  namespaced by the architecture the FILE declares, so the architecture is
     *  read first and the rest is read through it. */
    fun ggufFacts(header: Json): GgufFacts? {
        if (header !is Json.Obj) return null
        val arch = header["general.architecture"].stringOrNull()
        fun at(suffix: String): Double? = arch?.let { positive(header["$it.$suffix"]) }
        val embedding = at("embedding_length")
        val heads = at("attention.head_count")
        return GgufFacts(
            architecture = arch,
            parameters = positive(header["general.parameter_count"]),
            contextLength = at("context_length")?.toInt(),
            blockCount = at("block_count")?.toInt(),
            headCountKv = (at("attention.head_count_kv") ?: heads)?.toInt(),
            headDim = (at("attention.key_length")
                ?: (if (embedding != null && heads != null) (embedding / heads).roundToInt().toDouble() else null))
                ?.toInt(),
            pooling = at("pooling_type"),
        )
    }

    // --- what KIND of model this is ----------------------------------------

    /**
     * Architecture → category, and the table is EVIDENCE rather than
     * recollection.
     *
     * It is exactly what the shipped catalog's eleven rows say, and nothing
     * else: three `family: "gemma3"` rows and two `family: "qwen3"` rows carry
     * `category: "text"`, four `family: "whisper"` rows carry `category: "asr"`.
     * `family` is the architecture slot - synthesis fills it from
     * `general.architecture` - so those rows ARE an architecture table somebody
     * measured and shipped.
     *
     * The eleventh row is why this table is not the whole answer:
     * `qwen3-embedding-0.6b-q8_0` is `family: "qwen3"` and
     * `category: "embedding"`. One architecture, two categories.
     *
     * ANYTHING NOT LISTED IS `unknown`, deliberately. Adding `llama`, `phi3`,
     * `bert` and friends from memory would be the same class of mistake as the
     * footprint coefficient: a plausible value nobody measured, which the rest
     * of the system then treats as a fact.
     */
    val CATEGORY_BY_ARCHITECTURE = mapOf(
        "gemma3" to "text",
        "qwen3" to "text",
        "whisper" to "asr",
    )

    /** The category a build records when the evidence does not name one. A REAL
     *  value, not an absence: the fallback matcher declines to substitute
     *  across it rather than guessing. */
    const val CATEGORY_UNKNOWN = "unknown"

    data class CategoryVerdict(val category: String, val from: String)

    /**
     * What kind of model this file is, from the header. Two signals, in order:
     *
     *   1. `<arch>.pooling_type` above zero → `embedding`. A model that pools
     *      its hidden states into one vector is an embedding model; that is
     *      what the key means. FIRST, because it is the only thing that
     *      separates the two kinds of `qwen3` - verified against the real
     *      files: Qwen3-Embedding-0.6B-Q8_0 declares `qwen3.pooling_type = 3`
     *      and Qwen3-0.6B-Q8_0 declares no pooling key at all, while
     *      nomic-embed-text-v1.5 declares `nomic-bert.pooling_type = 1` and
     *      neither gemma-3-1b, gemma-3-4b nor LFM2-350M declares one.
     *   2. the architecture table above → its category.
     *
     * Otherwise `unknown` - which is the correct answer to a question this
     * build has no evidence about.
     */
    fun categoryFor(facts: GgufFacts?): CategoryVerdict {
        if (facts?.pooling != null) return CategoryVerdict("embedding", "pooling")
        val known = facts?.architecture?.let { CATEGORY_BY_ARCHITECTURE[it] }
        if (known != null) return CategoryVerdict(known, "architecture")
        return CategoryVerdict(CATEGORY_UNKNOWN, "unknown")
    }

    /** What a category eats and what it produces, from the same eleven rows:
     *  the `embedding` row is `outputs: ["embedding"]`, the four `asr` rows are
     *  `inputs: ["audio"]`, and text is text. An entry whose declared `inputs`
     *  contradicted its category would be refused at the seam
     *  (`unsupported_input`) for a reason that is this file's fault. */
    fun modalityFor(category: String): Pair<List<String>, List<String>> = when (category) {
        "embedding" -> listOf("text") to listOf("embedding")
        "asr" -> listOf("audio") to listOf("text-stream")
        else -> listOf("text") to listOf("text-stream")
    }

    private fun roundUp32(mb: Double): Double = max(32.0, ceil(mb / 32.0) * 32.0)

    /**
     * `requirements`, derived from the real file size and the GGUF header.
     *
     * `disk_mb` IS the file size and `mapped_mb` is what the gguf loader mmaps,
     * which is the same number; only `footprint_mb` is an estimate. The KV cache
     * is computed exactly from the header; the compute buffers are not in the
     * header at all, so they are allowed for as a fraction of the weights, and
     * the whole thing carries the shipped catalog's own 1.5x margin rounded up
     * to 32 MB.
     *
     * WITHOUT a header the cache is not computable, and pretending it is zero is
     * the one error that gets a user killed by the OOM reaper - so the
     * headerless estimate takes the TOP of the range the eleven measured rows
     * show (0.7x the file). It refuses models that would in fact have run, which
     * a `predicted` verdict lets a surface offer anyway, and never accepts one
     * that would not.
     */
    fun deriveRequirements(bytes: Double?, facts: GgufFacts?, context: Int): Json {
        val diskMb = if (bytes != null && bytes > 0) ceil(bytes / MIB) else 0.0
        val kvMb = if (facts?.blockCount != null && facts.headCountKv != null && facts.headDim != null) {
            (2.0 * facts.blockCount * facts.headCountKv * facts.headDim * context * 2.0) / MIB
        } else {
            0.7 * diskMb
        }
        return jsonOf(
            "footprint_mb" to Json.Num(roundUp32(1.5 * (kvMb + 0.3 * diskMb))),
            "mapped_mb" to Json.Num(diskMb),
            "disk_mb" to Json.Num(diskMb),
        )
    }

    // --- identity ----------------------------------------------------------

    fun slugFor(repo: String, file: String): String {
        val base = file.replace(Regex("\\.[^.]+$"), "")
        return "${repo.substringAfterLast('/')}-$base".lowercase().replace(Regex("[^a-z0-9.-]+"), "-")
    }

    // --- the synthesis -----------------------------------------------------

    /**
     * @param registry the APP's declared templates
     * @param info     the registry's answer, UNTRUSTED
     * @param header   what the FILE said, when it could be read
     * @param requireLicense the authoring tool's stance; the runtime records
     *        `unknown` instead and lets the surface refuse
     */
    fun synthesize(
        ref: SourceRef,
        registry: Json,
        info: Json,
        file: Json,
        header: Json = Json.Null,
        id: String? = null,
        requireLicense: Boolean = false,
        servingContext: Int = DEFAULT_SERVING_CONTEXT,
    ): Synth<Json> {
        // 1. The revision must be an immutable commit.
        val commit = info["sha"].string().lowercase()
        if (!COMMIT.matches(commit)) {
            return Synth.No("revision_not_immutable",
                jsonOf("repo" to Json.Str(ref.repo), "sha" to info["sha"]),
                "That repository did not resolve to a commit, and a moving revision is never stored.")
        }

        val path = file["rfilename"].string()
        if (!RELATIVE_PATH.matches(path) || path.split('/').contains("..")) {
            return Synth.No("source_malformed", jsonOf("file" to Json.Str(path)),
                "That file path is not one this build will store.")
        }
        val format = formatFor(path)
            ?: return Synth.No("unsupported",
                jsonOf("reason" to Json.Str("format_not_carried"), "file" to Json.Str(path)),
                "$path is not a format this build carries (gguf).")

        // 2. The licence is the repo's, not the adder's.
        val declaredLicense = info["cardData"]["license"].stringOrNull()
        if (declaredLicense == null && requireLicense) {
            return Synth.No("license_unknown", jsonOf("repo" to Json.Str(ref.repo)),
                "${ref.repo} declares no licence.")
        }

        // 3. A digest is a CLAIM; a malformed one is dropped.
        val claimed = file["lfs"]["sha256"].stringOrNull()?.lowercase()
        val digest = claimed?.takeIf { DIGEST.matches(it) }
        val bytes = positive(file["lfs"]["size"]) ?: positive(file["size"])

        // 4. The file outranks the registry on anything the bytes can answer.
        val facts = ggufFacts(header)
        val registryContext = positive(info["gguf"]["context_length"])?.toInt()
        val trained = facts?.contextLength ?: registryContext
        val contextFrom = when {
            facts?.contextLength != null -> "file"
            registryContext != null -> "registry"
            else -> "default"
        }
        val serving = if (trained != null) min(servingContext, trained) else servingContext
        val registryFamily = info["gguf"]["architecture"].stringOrNull()
            ?: info["config"]["model_type"].stringOrNull()
        val family = facts?.architecture ?: registryFamily
        val familyFrom = when {
            facts?.architecture != null -> "file"
            registryFamily != null -> "registry"
            else -> "unknown"
        }

        val name = path.substringAfterLast('/')
        val url = expand(registry["file"].string(),
            mapOf("repo" to ref.repo, "commit" to commit, "path" to path))

        // WHAT KIND of model this is, from the same bytes. It used to be the
        // literal "text" on every entry, which made a Whisper GGUF or an
        // embedding model a chat model as far as everything downstream could
        // tell - and the fallback matcher, which offers "another model of the
        // same kind", would answer a refused speech model with something that
        // cannot hear.
        val kind = categoryFor(facts)
        val (inputs, outputs) = modalityFor(kind.category)

        val provenance = linkedMapOf<String, Json>(
            "revision" to Json.Str("registry"),
            "bytes" to Json.Str(if (bytes == null) "unknown" else "registry"),
            "sha256" to Json.Str(
                if (digest != null) "registry" else if (claimed != null) "discarded_malformed" else "none"),
            "license" to Json.Str(if (declaredLicense != null) "repo_card" else "unknown"),
            "family" to Json.Str(familyFrom),
            "category" to Json.Str(kind.from),
            "context_length" to Json.Str(contextFrom),
            "parameters" to Json.Str(if (facts?.parameters != null) "file" else "unknown"),
            "requirements" to Json.Str(
                if (facts?.blockCount != null) "derived_from_header" else "estimated_from_size"),
        )

        val fileFields = linkedMapOf<String, Json>("name" to Json.Str(name))
        bytes?.let { fileFields["bytes"] = Json.Num(it) }
        digest?.let { fileFields["sha256"] = Json.Str(it) }
        fileFields["urls"] = Json.Arr(listOf(Json.Str(url)))

        val license = linkedMapOf<String, Json>("id" to Json.Str(declaredLicense ?: "unknown"))
        registry["page"].stringOrNull()?.let {
            license["url"] = Json.Str(expand(it, mapOf("repo" to ref.repo, "commit" to commit)))
        }

        val origin = linkedMapOf<String, Json>(
            "added" to Json.Bool(true),
            "registry" to Json.Str(ref.scheme),
            "source" to Json.Str(
                if (ref.path != null) "${ref.scheme}:${ref.repo}/${ref.path}" else "${ref.scheme}:${ref.repo}"),
            "repo" to Json.Str(ref.repo),
            "revision" to Json.Str(commit),
            "provenance" to Json.Obj(provenance),
        )

        val entry = linkedMapOf<String, Json>(
            "schema_version" to Json.Num(1.0),
            "id" to Json.Str(id ?: slugFor(ref.repo, name)),
            "name" to Json.Str("${ref.repo.substringAfterLast('/')} ($name)"),
        )
        family?.let { entry["family"] = Json.Str(it) }
        entry["category"] = Json.Str(kind.category)
        entry["engine"] = Json.Str("gguf")
        entry["format"] = Json.Str(format)
        entry["status"] = Json.Str("active")
        entry["requires"] = jsonOf("abi" to Json.Num(1.0))
        entry["files"] = Json.Arr(listOf(Json.Obj(fileFields)))
        entry["license"] = Json.Obj(license)
        val languages = info["cardData"]["language"]
        if (languages is Json.Arr) entry["languages"] = languages
        else languages.stringOrNull()?.let { entry["languages"] = Json.Arr(listOf(Json.Str(it))) }
        entry["inputs"] = Json.Arr(inputs.map { Json.Str(it) })
        entry["outputs"] = Json.Arr(outputs.map { Json.Str(it) })
        entry["context_length"] = Json.Num(serving.toDouble())
        trained?.let { entry["context_length_max"] = Json.Num(it.toDouble()) }
        facts?.parameters?.let { entry["parameters"] = Json.Num(it) }
        entry["requirements"] = deriveRequirements(bytes, facts, serving)
        entry["origin"] = Json.Obj(origin)
        if (digest == null) {
            entry["_note"] = Json.Str(
                "The registry published no usable digest for this file, so the device pins one on " +
                "first download and verifies against it forever after.")
        }
        return Synth.Ok(Json.Obj(entry))
    }
}
