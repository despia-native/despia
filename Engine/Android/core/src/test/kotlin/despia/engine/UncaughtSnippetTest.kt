package despia.engine

import java.util.concurrent.Executor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/// RUNTIME ERROR CONTEXT: an uncaught markup throw's ambient report carries `snippet` —
/// the first 120 chars of the BODY THAT THREW — in its ledger data, so an entry says WHAT
/// threw. The runner threads the entry/action body through `store.entryBody` (set at
/// run()/action-call start; a throw skips the restore, like the flow signal, so a nested
/// action's throw attributes ITS body). TS twin: uncaught-snippet.test.ts.
class UncaughtSnippetTest {

    private fun inlineExecutors() {
        ModuleRegistry.shared.mainExecutor = Executor { it.run() }
        JSERunner.mainExecutor = Executor { it.run() }
    }

    @Test fun uncaughtThrowReportsASnippetOfTheEntryBody() {
        inlineExecutors()
        val before = DSXErrorLedger.shared.count()
        JSERunner(StackStore()).run("x = 1; throw 'kapow'", null)
        assertEquals(1, DSXErrorLedger.shared.count() - before)
        val entry = DSXErrorLedger.shared.recent().last()
        assertEquals("uncaught", entry.code)
        assertEquals("kapow", entry.message)
        @Suppress("UNCHECKED_CAST")
        val data = entry.data as? Map<String, Any?>
        assertNotNull(data, "data carries the snippet")
        assertEquals("x = 1; throw 'kapow'", JSE.string(data["snippet"]))
    }

    @Test fun nestedActionThrowSnippetsTheActionBodyAndKeepsAuthorData() {
        inlineExecutors()
        val before = DSXErrorLedger.shared.count()
        val store = StackStore()
        val body = "throw { code: 'blew_up', data: { step: 3 } }"
        store.registerAction("boom", emptyMap(), body)
        JSERunner(store).run("a = 1; dsx.action.boom()", null)
        assertEquals(1, DSXErrorLedger.shared.count() - before)
        val entry = DSXErrorLedger.shared.recent().last()
        assertEquals("blew_up", entry.code)
        @Suppress("UNCHECKED_CAST")
        val data = entry.data as? Map<String, Any?>
        assertNotNull(data, "author data survives")
        assertEquals(3.0, (data["step"] as? Number)?.toDouble())   // untouched
        assertEquals(body, JSE.string(data["snippet"]))            // the THROWING body, not the entry's
    }
}
