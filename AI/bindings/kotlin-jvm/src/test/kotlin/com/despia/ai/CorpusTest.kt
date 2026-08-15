// CorpusTest.kt - the Kotlin runner for the whole shared corpus.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The same files the TypeScript runner reads, driven through the Kotlin host
// over the REAL C++ MockEngine. Expectation semantics are identical by design:
// subset matching everywhere, `events` as an ordered subsequence, counts exact.
// If the two runners ever disagree about what a case means, that is the bug the
// corpus exists to surface.
//
// Three cases whose steps land mid-stream (`cancel` and `resync` against a
// paused script) are exercised by the dedicated native assertions in
// AiConformanceTest, where the threading is the point. The required Gradle test
// task runs both classes: those cases are reported as native-seam coverage, not
// as corpus-runner passes and not as skips.
//
// The SECOND skip is the `requires` guard below: a corpus file naming an
// expectation key this runner does not implement is skipped whole, out loud, and
// counted apart from the passes. See IMPLEMENTED_EXPECT_KEYS for why.

package com.despia.ai

import java.io.File
import kotlin.test.Test
import kotlin.test.fail

class CorpusTest {

    /** Every expect key runCase() actually reads. A corpus file's `requires`
     *  array is checked against this, and a key that is not here SKIPS the file.
     *
     *  This exists because the alternative already happened. The G2P corpus
     *  landed 63 cases using 14 expect keys no runner had heard of. runCase()
     *  reads the keys it knows and ignores the rest, so all 63 were counted, none
     *  was checked, and this lane reported 183/183 with a third of the corpus
     *  asserting nothing. The corpus author saw that coming and put `requires` in
     *  every file precisely to prevent it. Nothing read it.
     *
     *  So: adding a key to a corpus without teaching a runner to check it now
     *  makes that runner SAY SO. A conformance harness whose failure mode is
     *  silent success is worse than no harness, because the green is what stops
     *  anyone looking.
     *
     *  The list is this RUNNER's, not the corpus's and not the TypeScript
     *  runner's: it is exactly what runCase() below dereferences off `expect`,
     *  and it moves only when runCase() grows a check. Two runners implementing
     *  different sets is fine and visible - each skips what it cannot serve. */
    private val implementedExpectKeys = setOf(
        "buildAbort", "events", "eventCounts", "distinctRids", "results",
        "errors", "absent", "notices", "catalogNotices", "dispatched",
        "engineRequests", "remoteRequests", "rows", "providers", "transcript",
        "serverResponses", "downloadAttempts", "downloaded", "resolveAttempts",
        "deletedOnMismatch", "pinnedDigests", "dispatchGroups", "verdicts",
        "dispatchCount", "engineRequestCount", "remoteRequestCount", "downloadCount",
        "mcpConnectCount", "engineLoadCount", "downloadAttemptCount", "resolveAttemptCount",
        "maxEventBytes", "noInlineBytes", "noErrors", "dispatchedAfterApproval",
        "snapshotBeforeWrite", "snapshotBeforeFirstWrite", "boundLoopbackOnly",
        "transcriptTransmitted", "tokenInUrl", "discoveryFile",
    )

    private fun corpusRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            for (candidate in listOf(File(dir, "OpenSource/Conformance/ai"), File(dir, "conformance/ai"))) {
                if (candidate.isDirectory) return candidate
            }
            dir = dir.parentFile
        }
        error("the ai corpus was not found")
    }

    private fun corpusFiles(root: File): List<File> =
        root.walkTopDown().filter { it.isFile && it.extension == "json" }.sortedBy { it.path }.toList()

    /** Run the strict corpus driver beside the shared native G2P frontend.  The
     *  JVM binding reaches this same frontend in production; copying its pack
     *  reader and letter-to-sound implementation into Kotlin would test a
     *  different product.  The Gradle build supplies this binary and a missing
     *  binary, malformed summary, non-zero exit, or failed case is fatal. */
    private fun runNativeG2pCorpus(root: File): Pair<Int, Int> {
        val binary = System.getProperty("despia.ai.g2p.corpus")
            ?.takeIf { it.isNotBlank() }
            ?: error("the required native G2P corpus runner was not configured")
        val process = ProcessBuilder(binary, root.absolutePath)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        val status = process.waitFor()
        print(output)
        val match = Regex("g2p_corpus:\\s+(\\d+) cases\\s+\\D+?(\\d+) failures")
            .find(output)
            ?: error("the G2P runner did not emit its machine-checked case summary")
        val cases = match.groupValues[1].toInt()
        val failures = match.groupValues[2].toInt()
        if (status != 0 || failures != 0) {
            error("the native G2P corpus failed ($failures failed cases, exit $status)")
        }
        return cases to failures
    }

    private fun subsetMatch(expected: Json, actual: Json): Boolean = when (expected) {
        is Json.Obj -> expected.fields.all { (key, value) -> subsetMatch(value, actual[key]) }
        is Json.Arr -> actual is Json.Arr && actual.items.size >= expected.items.size &&
            expected.items.withIndex().all { (i, value) -> subsetMatch(value, actual.items[i]) }
        else -> expected.render() == actual.render()
    }

    private fun show(v: Json): String = v.render().let { if (it.length > 300) it.take(300) + "..." else it }

    /** A step that lands mid-stream needs the engine suspended while the driver
     *  keeps running. The native worker is asynchronous, so those exact cases
     *  belong to AiConformanceTest in the same required Gradle task. */
    private fun drivable(case: Json): Boolean =
        case["steps"].items.none { it.has("cancel") || it.has("resync") }

    private fun checkList(name: String, expected: List<Json>, actual: List<Json>, fails: MutableList<String>) {
        if (actual.size < expected.size) {
            fails.add("$name: expected at least ${expected.size}, got ${actual.size}: ${show(Json.Arr(actual))}")
            return
        }
        expected.forEachIndexed { i, want ->
            if (!subsetMatch(want, actual[i])) {
                fails.add("$name[$i]: expected ${show(want)}, got ${show(actual[i])}")
            }
        }
        if (expected.isEmpty() && actual.isNotEmpty()) {
            fails.add("$name: expected none, got ${show(Json.Arr(actual))}")
        }
    }

    private fun runCase(case: Json, fails: MutableList<String>) {
        val expect = case["expect"]

        // A build-abort case asserts a PREPARE-time refusal, answered by the
        // derivation and never by a running request.
        if (expect.has("buildAbort")) {
            Host(case).use { host ->
                val abort = host.buildAbort
                if (abort == null) fails.add("expected a build abort, the derivation produced none")
                else if (!subsetMatch(expect["buildAbort"], abort)) {
                    fails.add("buildAbort: expected ${show(expect["buildAbort"])}, got ${show(abort)}")
                }
            }
            return
        }

        Host(case).use { host ->
            for (step in case["steps"].items) {
                when {
                    step.has("call") -> host.call(step["call"])
                    step.has("approve") -> host.approve(step["approve"]["id"].string(),
                        if (step["approve"]["decision"].string() == "deny") "deny" else "approve")
                    step.has("tick") -> host.tick(step["tick"]["ms"].number().toLong())
                    step.has("serverRequest") -> host.serverRequest(step["serverRequest"])
                    else -> fails.add("unknown step: ${show(step)}")
                }
            }

            // events: an ordered SUBSEQUENCE, same as the TS runner.
            var cursor = 0
            for (want in expect["events"].items) {
                var found = -1
                for (i in cursor until host.events.size) {
                    val got = host.events[i]
                    if (want.has("req") && got.req != want["req"].string()) continue
                    if (want.has("event") && got.event != want["event"].string()) continue
                    if (want.has("final") && got.final != want["final"].bool()) continue
                    if (want.has("data") && !subsetMatch(want["data"], got.data)) continue
                    found = i; break
                }
                if (found < 0) {
                    fails.add("expected event ${show(want)} after index $cursor; got " +
                        host.events.joinToString(",") { "${it.req}:${it.event}" })
                    break
                }
                cursor = found + 1
            }

            expect["eventCounts"].fields.forEach { (name, want) ->
                val got = host.events.count { it.event == name }
                if (got != want.int()) fails.add("eventCounts.$name: expected ${want.int()}, got $got")
            }

            if (expect.has("distinctRids")) {
                val rids = expect["distinctRids"].strings().map { host.ridOf[it] }
                if (rids.toSet().size != rids.size || rids.any { it == null }) {
                    fails.add("distinctRids: labels did not map to distinct request ids ($rids)")
                }
            }

            expect["results"].fields.forEach { (label, want) ->
                val got = host.results[label]
                if (got == null) fails.add("results.$label: no result was recorded")
                else if (!subsetMatch(want, got)) {
                    fails.add("results.$label: expected ${show(want)}, got ${show(got)}")
                }
            }

            if (expect.has("errors")) checkList("errors", expect["errors"].items, host.errors, fails)
            if (expect.has("absent")) checkList("absent", expect["absent"].items, host.absent, fails)
            if (expect.has("notices")) checkList("notices", expect["notices"].items, host.notices, fails)
            if (expect.has("catalogNotices")) {
                checkList("catalogNotices", expect["catalogNotices"].items, host.catalogNotices, fails)
            }
            if (expect.has("dispatched")) checkList("dispatched", expect["dispatched"].items, host.dispatched, fails)
            if (expect.has("engineRequests")) {
                checkList("engineRequests", expect["engineRequests"].items, host.engineRequests, fails)
            }
            if (expect.has("remoteRequests")) {
                checkList("remoteRequests", expect["remoteRequests"].items, host.remoteRequests, fails)
            }
            if (expect.has("rows")) checkList("rows", expect["rows"].items, host.rows, fails)
            if (expect.has("providers")) checkList("providers", expect["providers"].items, host.providers, fails)
            if (expect.has("transcript")) checkList("transcript", expect["transcript"].items, host.transcript, fails)
            if (expect.has("serverResponses")) {
                checkList("serverResponses", expect["serverResponses"].items, host.serverResponses, fails)
            }
            if (expect.has("downloadAttempts")) {
                checkList("downloadAttempts", expect["downloadAttempts"].items, host.downloadAttempts, fails)
            }
            if (expect.has("downloaded")) checkList("downloaded", expect["downloaded"].items, host.downloaded, fails)
            if (expect.has("resolveAttempts")) {
                checkList("resolveAttempts", expect["resolveAttempts"].items, host.resolveAttempts, fails)
            }

            if (expect.has("deletedOnMismatch")) {
                val want = expect["deletedOnMismatch"].strings()
                if (want != host.deletedOnMismatch) {
                    fails.add("deletedOnMismatch: expected $want, got ${host.deletedOnMismatch}")
                }
            }
            expect["pinnedDigests"].fields.forEach { (model, want) ->
                if (host.pinnedDigests[model] != want.string()) {
                    fails.add("pinnedDigests.$model: expected ${want.string()}, got ${host.pinnedDigests[model]}")
                }
            }

            if (expect.has("dispatchGroups")) {
                val want = expect["dispatchGroups"].items.map { it.strings() }
                if (want != host.dispatchGroups) {
                    fails.add("dispatchGroups: expected $want, got ${host.dispatchGroups}")
                }
            }

            val counts = listOf(
                Triple("dispatchCount", expect["dispatchCount"], host.dispatched.size),
                Triple("engineRequestCount", expect["engineRequestCount"], host.engineRequests.size),
                Triple("remoteRequestCount", expect["remoteRequestCount"], host.remoteRequests.size),
                Triple("downloadCount", expect["downloadCount"], host.downloadCount),
                Triple("mcpConnectCount", expect["mcpConnectCount"], host.mcpConnectCount),
                Triple("engineLoadCount", expect["engineLoadCount"], host.engineLoadCount),
                Triple("downloadAttemptCount", expect["downloadAttemptCount"], host.downloadAttempts.size),
                Triple("resolveAttemptCount", expect["resolveAttemptCount"], host.resolveAttempts.size),
            )
            for ((name, want, got) in counts) {
                if (want !is Json.Null && want.int() != got) fails.add("$name: expected ${want.int()}, got $got")
            }

            expect["verdicts"].fields.forEach { (id, want) ->
                val got = host.verdicts[id]
                if (got == null) fails.add("verdicts.$id: no verdict was computed")
                else if (!subsetMatch(want, got.toJson())) {
                    fails.add("verdicts.$id: expected ${show(want)}, got ${show(got.toJson())}")
                }
            }

            if (expect.has("maxEventBytes")) {
                // The bound applies to INCREMENTAL events; sync and complete are
                // snapshots by design.
                val bound = expect["maxEventBytes"].int()
                for (event in host.events) {
                    if (event.event == "sync" || event.event == "complete") continue
                    val size = event.data.render().length
                    if (size > bound) {
                        fails.add("maxEventBytes: a ${event.event} event serialized to $size bytes, over $bound")
                        break
                    }
                }
            }

            if (expect["noInlineBytes"].bool()) {
                val text = host.events.joinToString(",") { it.data.render() } +
                    host.engineRequests.joinToString(",") { it.render() }
                if (Regex("\"[A-Za-z0-9+/]{512,}={0,2}\"").containsMatchIn(text)) {
                    fails.add("noInlineBytes: a payload looks like inline base64")
                }
            }
            if (expect["noErrors"].bool() && host.errors.isNotEmpty()) {
                fails.add("noErrors: the case produced ${show(Json.Arr(host.errors))}")
            }

            val flags = listOf(
                "dispatchedAfterApproval" to host.dispatchedAfterApproval,
                "snapshotBeforeWrite" to host.snapshotBeforeWrite,
                "snapshotBeforeFirstWrite" to host.snapshotBeforeFirstWrite,
                "boundLoopbackOnly" to host.boundLoopbackOnly,
                "transcriptTransmitted" to host.transcriptTransmitted,
                "tokenInUrl" to host.tokenInUrl,
            )
            for ((name, got) in flags) {
                val want = expect[name]
                if (want !is Json.Null && want.bool() != got) {
                    fails.add("$name: expected ${want.bool()}, got $got")
                }
            }

            if (expect.has("discoveryFile")) {
                val got = host.discoveryFile
                if (got == null) fails.add("discoveryFile: none was written")
                else if (!subsetMatch(expect["discoveryFile"], got)) {
                    fails.add("discoveryFile: expected ${show(expect["discoveryFile"])}, got ${show(got)}")
                }
            }
        }
    }

    @Test
    fun `the shared corpus runs on the Kotlin host`() {
        val root = corpusRoot()
        var total = 0
        var ran = 0
        var unservedFiles = 0
        var unservedCases = 0
        val nativeSeamCases = mutableListOf<String>()
        val failures = mutableListOf<String>()

        // G2P files share one declared fixture pack and are therefore one
        // native suite.  Count their cases from the source documents, execute
        // every assertion once through the real frontend, and require the
        // runner's count to match before the ordinary host corpus continues.
        val g2pRoot = File(root, "g2p")
        if (File(g2pRoot, "fixture-pack.json").isFile) {
            val expected = corpusFiles(g2pRoot).sumOf { file ->
                Json.parse(file.readText(Charsets.UTF_8))["cases"].items.size
            }
            total += expected
            try {
                val (executed, nativeFailures) = runNativeG2pCorpus(g2pRoot)
                if (executed != expected) {
                    failures.add("g2p :: expected $expected corpus cases, native runner executed $executed")
                } else if (nativeFailures == 0) {
                    ran += executed
                }
            } catch (e: Throwable) {
                failures.add("g2p :: threw: ${e::class.simpleName}: ${e.message}")
            }
        }

        for (file in corpusFiles(root)) {
            val rel = file.path.removePrefix(root.path + "/")
            val doc = Json.parse(file.readText(Charsets.UTF_8))

            // Already executed together above by the frontend that owns these
            // semantics.  Running them through Host would be a vacuous pass:
            // Host has no pack reader and no phonemizer.
            if (rel.startsWith("g2p/")) continue

            // The requires guard, before any case in the file runs. A file this
            // runner cannot serve is SKIPPED and SAID OUT LOUD, never counted as
            // passing. Some corpora exercise a subsystem that lives in one lane
            // only: the G2P cases drive a frontend with no Kotlin host yet, so
            // skipping them here is correct and silently counting them was not.
            //
            // The skip is loud on purpose and the count is in the summary line,
            // so "183/183 passed" can never again mean "120 checked and 63 waved
            // through". A file skipped by EVERY runner would be a file nothing
            // executes; the G2P cases are served by engine/test/g2p_corpus.cpp
            // (ClosedSource/scripts/check_g2p_corpus.rb, per-PR), which is where
            // to look when a skip line here needs answering.
            val missing = doc["requires"].strings().filterNot { it in implementedExpectKeys }
            if (missing.isNotEmpty()) {
                val count = doc["cases"].items.size
                unservedFiles++
                unservedCases += count
                println("SKIP $rel ($count cases) requires [${missing.joinToString(", ")}]")
                continue
            }

            for (case in doc["cases"].items) {
                total++
                val name = case["name"].string()
                if (!drivable(case)) {
                    nativeSeamCases.add(name)
                    ran++
                    continue
                }
                ran++
                val fails = mutableListOf<String>()
                try {
                    runCase(case, fails)
                } catch (e: Throwable) {
                    fails.add("threw: ${e::class.simpleName}: ${e.message}")
                }
                failures.addAll(fails.map { "$rel :: $name\n      $it" })
            }
        }

        val skipNote = if (unservedFiles > 0) {
            ", $unservedCases cases in $unservedFiles files SKIPPED (this runner cannot serve them)"
        } else ""
        println("kotlin corpus: ${ran - failures.map { it.substringBefore('\n') }.distinct().size}/$ran " +
                "required cases covered ($total total; ${ran - nativeSeamCases.size} corpus-driven, " +
                "${nativeSeamCases.size} by required native-seam assertions: " +
                "${nativeSeamCases.joinToString("; ")})$skipNote")
        if (failures.isNotEmpty()) {
            fail("kotlin corpus:\n  " + failures.joinToString("\n  "))
        }
    }
}
