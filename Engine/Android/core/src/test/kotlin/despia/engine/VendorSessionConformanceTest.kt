package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The inline-vendor-surface conformance runner - executes
 * OpenSource/Conformance/inline-surfaces/stripe.json through THIS runtime's VendorSessionRef fold,
 * VendorSessionMachine, VendorCardField fold and VendorRetain keying
 * (architecture/proposals/inline-native-surfaces.md, parity/V01-stripe-inline.md). The TS
 * twin (@despia-native/kernel vendor-session.ts) and the Swift reference (VendorSession.swift)
 * run the SAME file, so `session=` cannot accept a literal on one renderer and refuse it
 * on another, and a payment cannot be startable twice on one renderer and once on the
 * others.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift
 * starts, and the drift here is a double charge.
 */
class VendorSessionConformanceTest {

    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/inline-surfaces/stripe.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/inline-surfaces/stripe.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(): Map<String, Any?> {
        val root = json(corpusFile().readText()).foundationValue as? Map<String, Any?>
            ?: error("stripe.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "stripe.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String): Map<String, Any?> =
        root()[name] as? Map<String, Any?> ?: error("stripe.json: no $name section")

    @Suppress("UNCHECKED_CAST")
    private fun cases(section: Map<String, Any?>, key: String = "cases"): List<Map<String, Any?>> =
        section[key] as? List<Map<String, Any?>> ?: error("no $key[]")

    // -- 1 - the secret boundary ---------------------------------------------------------

    @Test
    fun sessionReferenceResolverAgreesWithCorpus() {
        val section = section("sessionRef")
        val rows = cases(section)
        assertTrue(rows.isNotEmpty(), "sessionRef corpus must not be empty")
        for (row in rows) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val result = VendorSessionRef.resolve(row["value"] as? String)

            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(result.isFailure, "$name: expected refusal $expectedError, got ${result.getOrNull()}")
                val failure = result.exceptionOrNull() as VendorSessionRef.RefusalError
                assertEquals(expectedError, VendorSessionRef.code(failure.refusal), "$name: refusal code")
                val expectedFamily = expect["family"] as? String
                assertEquals(
                    expectedFamily,
                    failure.family?.let { VendorSessionRef.code(it) },
                    "$name: credential family",
                )
                continue
            }

            assertTrue(result.isSuccess, "$name: expected a reference, got ${result.exceptionOrNull()?.message}")
            val ref = result.getOrThrow()
            assertEquals(expect["kind"] as String, VendorSessionRef.code(ref.kind), "$name: kind")
            assertEquals(expect["path"] as String, ref.path, "$name: path")
        }
    }

    @Test
    fun declaredVocabulariesAgreeWithCorpus() {
        val section = section("sessionRef")
        @Suppress("UNCHECKED_CAST")
        val kinds = (section["kinds"] as List<Any?>).map { it as String }.toSet()
        @Suppress("UNCHECKED_CAST")
        val refusals = (section["refusals"] as List<Any?>).map { it as String }.toSet()
        @Suppress("UNCHECKED_CAST")
        val families = (section["families"] as List<Any?>).map { it as String }.toSet()
        for (row in cases(section)) {
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val error = expect["error"] as? String
            if (error != null) {
                assertTrue(refusals.contains(error), "undeclared refusal $error")
                val family = expect["family"] as? String
                if (family != null) assertTrue(families.contains(family), "undeclared family $family")
            } else {
                assertTrue(kinds.contains(expect["kind"] as String), "undeclared kind ${expect["kind"]}")
            }
        }
    }

    @Test
    fun everyDeclaredFamilyIsReachableAndNoReferenceCarriesOne() {
        // The allowlist is the rule; family detection only sharpens the message. Both
        // halves are load-bearing: no declared family is dead vocabulary, and a legal
        // reference never trips the detector.
        val section = section("sessionRef")
        val reached = HashSet<String>()
        for (row in cases(section)) {
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            (expect["family"] as? String)?.let { reached.add(it) }
            val value = row["value"] as? String
            if (expect["kind"] != null && value != null) {
                assertNull(VendorSessionRef.secretFamilyIn(value), "a permitted reference must carry no credential: $value")
            }
        }
        @Suppress("UNCHECKED_CAST")
        for (family in (section["families"] as List<Any?>).map { it as String }) {
            assertTrue(reached.contains(family), "family $family is declared but no corpus row pins it")
        }
    }

    // -- 2 - one session, two views ------------------------------------------------------

    @Test
    fun canonicalViewOrderAgreesWithCorpus() {
        @Suppress("UNCHECKED_CAST")
        val views = (section("machine")["views"] as List<Any?>).map { it as String }
        assertEquals(views, VENDOR_VIEWS, "canonical view order")
    }

    @Test
    fun sessionMachineAgreesWithCorpus() {
        val section = section("machine")
        @Suppress("UNCHECKED_CAST")
        val states = (section["states"] as List<Any?>).map { it as String }.toSet()
        @Suppress("UNCHECKED_CAST")
        val refusals = (section["refusals"] as List<Any?>).map { it as String }.toSet()
        val rows = cases(section)
        assertTrue(rows.isNotEmpty(), "machine corpus must not be empty")

        for (row in rows) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val steps = row["steps"] as? List<Map<String, Any?>> ?: error("$name: no steps")
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as? List<Map<String, Any?>> ?: error("$name: no expect")
            assertEquals(steps.size, expect.size, "$name: one expectation per step")

            val machine = VendorSessionMachine()
            steps.forEachIndexed { index, step ->
                val where = "$name: step $index (${step["op"]})"
                val result = machine.step(
                    VendorSessionMachine.Step(
                        op = step["op"] as String,
                        view = step["view"] as? String,
                        code = step["code"] as? String,
                    )
                )
                val expected = expect[index]
                val expectedState = expected["state"] as String
                assertTrue(states.contains(expectedState), "$where: undeclared state $expectedState")

                val expectedError = expected["error"] as? String
                if (expectedError != null) {
                    assertTrue(!result.ok, "$where: expected refusal $expectedError, got $result")
                    assertTrue(refusals.contains(expectedError), "$where: undeclared refusal $expectedError")
                    assertEquals(expectedError, result.error, "$where: refusal code")
                    assertEquals(expectedState, result.state, "$where: state after a refusal")
                    assertEquals(expectedState, machine.state, "$where: a refusal never moves the machine")
                    return@forEachIndexed
                }

                assertTrue(result.ok, "$where: expected a step, got $result")
                assertEquals(expectedState, result.state, "$where: state")
                @Suppress("UNCHECKED_CAST")
                assertEquals((expected["notify"] as List<Any?>).map { it as String }, result.notify, "$where: notify audience")
                assertEquals((expected["attempts"] as Number).toInt(), result.attempts, "$where: attempts")
                assertEquals(expected["outcome"] as? String, result.outcome, "$where: outcome")
                assertEquals(expected["by"] as? String, result.by, "$where: originating view")
                assertEquals(expected["code"] as? String, result.code, "$where: failure code")
                assertEquals(expectedState, machine.state, "$where: state is stable after the step")
            }
        }
    }

    @Test
    fun anOutcomeAlwaysReachesTheFaceThatStartedIt() {
        // The law behind the corpus rows, asserted directly so a future edit to the
        // audience rule fails here rather than only inside one scenario.
        for (originator in VENDOR_VIEWS) {
            val machine = VendorSessionMachine()
            machine.step(VendorSessionMachine.Step("open"))
            machine.step(VendorSessionMachine.Step("attach", originator))
            machine.step(VendorSessionMachine.Step("start", originator))
            machine.step(VendorSessionMachine.Step("detach", originator))
            val settled = machine.step(VendorSessionMachine.Step("complete"))
            assertTrue(settled.ok, "$originator: complete")
            assertTrue(settled.notify.contains(originator), "$originator: a detached originator is still owed its outcome")
        }
    }

    // -- 3 - the field-validity fold -----------------------------------------------------

    @Test
    fun cardPartOrderAndMessagesAgreeWithCorpus() {
        val section = section("cardField")
        @Suppress("UNCHECKED_CAST")
        val order = (section["partOrder"] as List<Any?>).map { it as String }
        assertEquals(order, VendorCardField.PARTS, "canonical part order")
        @Suppress("UNCHECKED_CAST")
        val messages = (section["incompleteMessages"] as Map<String, Any?>).mapValues { it.value as String }
        assertEquals(messages, VendorCardField.INCOMPLETE_MESSAGES.toMap(), "incomplete messages")
        assertEquals(section["requiredMessage"] as String, VendorCardField.REQUIRED_MESSAGE, "required message")
    }

    @Suppress("UNCHECKED_CAST")
    private fun parts(row: Map<String, Any?>): List<VendorCardField.PartState> =
        (row["parts"] as List<Map<String, Any?>>).map {
            VendorCardField.PartState(
                part = it["part"] as String,
                empty = it["empty"] as? Boolean ?: true,
                complete = it["complete"] as? Boolean ?: false,
                error = it["error"] as? String ?: "",
            )
        }

    @Test
    fun fieldValidityFoldAgreesWithCorpus() {
        val rows = cases(section("cardField"))
        assertTrue(rows.isNotEmpty(), "cardField corpus must not be empty")
        for (row in rows) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val fold = VendorCardField.fold(parts(row), row["required"] as Boolean)
            assertEquals(expect["complete"] as Boolean, fold.complete, "$name: complete")
            assertEquals(expect["valid"] as Boolean, fold.valid, "$name: valid")
            assertEquals(expect["pristine"] as Boolean, fold.pristine, "$name: pristine")
            assertEquals(expect["error"] as String, fold.error, "$name: error")
            assertEquals(expect["offender"] as String, fold.offender, "$name: offender")
            assertEquals(expect["value"] as String, fold.value, "$name: value")
            assertTrue(fold.value == "" || fold.value == "complete", "$name: the folded value is a sentinel, never card data")
        }
    }

    @Test
    fun foldedFormFieldAgreesWithCorpus() {
        @Suppress("UNCHECKED_CAST")
        val formField = section("cardField")["formField"] as Map<String, Any?>
        val rows = cases(formField)
        assertTrue(rows.isNotEmpty(), "formField corpus must not be empty")
        for (row in rows) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val field = VendorCardField.formField(
                row["fieldName"] as String,
                VendorCardField.fold(parts(row), row["required"] as Boolean),
            )
            assertEquals(expect["name"] as String, field.name, "$name: name")
            assertEquals(expect["value"] as String, field.value, "$name: value")
            assertEquals(expect["initial"] as String, field.initial, "$name: initial")
            assertEquals(expect["validate"] as String, field.validate, "$name: validate")
            assertEquals(expect["message"] as String, field.message, "$name: message")
        }
    }

    // -- 4 - keyed identity --------------------------------------------------------------

    @Test
    fun retainKeyAgreesWithCorpus() {
        val rows = cases(section("retain"), "keys")
        assertTrue(rows.isNotEmpty(), "retain key corpus must not be empty")
        for (row in rows) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            val key = VendorRetain.key(
                tag = input["tag"] as String,
                key = input["key"] as? String,
                session = input["session"] as? String,
                index = (input["index"] as? Number)?.toInt() ?: 0,
            )
            assertEquals(row["expect"] as String, key, name)
        }
    }

    @Test
    fun retainReconcileAgreesWithCorpus() {
        val rows = cases(section("retain"), "reconcile")
        assertTrue(rows.isNotEmpty(), "retain reconcile corpus must not be empty")
        for (row in rows) {
            val name = row["name"] as? String ?: "<unnamed>"
            @Suppress("UNCHECKED_CAST")
            val previous = (row["previous"] as List<Any?>).map { it as String }
            @Suppress("UNCHECKED_CAST")
            val next = (row["next"] as List<Any?>).map { it as String }
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val diff = VendorRetain.reconcile(previous, next)
            @Suppress("UNCHECKED_CAST")
            assertEquals((expect["mounted"] as List<Any?>).map { it as String }, diff.mounted, "$name: mounted")
            @Suppress("UNCHECKED_CAST")
            assertEquals((expect["retained"] as List<Any?>).map { it as String }, diff.retained, "$name: retained")
            @Suppress("UNCHECKED_CAST")
            assertEquals((expect["released"] as List<Any?>).map { it as String }, diff.released, "$name: released")
        }
    }

    @Test
    fun retainKeyNeverCarriesTheSessionValue() {
        // Keys land in diff logs and render traces. The key derives from the session's
        // REFERENCE path, so even a misconfigured build cannot log a credential through it.
        val key = VendorRetain.key("stripe.CardInput", session = "dsx.module.stripe.context.session")
        assertNull(VendorSessionRef.secretFamilyIn(key))
        assertTrue(!key.contains("pk_") && !key.contains("sk_"))
    }
}
