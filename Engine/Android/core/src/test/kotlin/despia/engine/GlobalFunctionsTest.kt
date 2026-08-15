package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/// The GLOBAL FUNCTION LIBRARY (js-core.md "Shared logic — the global function library"):
/// ONE app-wide `function name(){…}` table shared by every surface, registered once at
/// boot via JSE.registerGlobalFunctions. Lookup order at a named call — scope lambda →
/// the surface's own function table (a surface-local name SHADOWS the global) → the
/// global table → builtins — under the same fnDepth 32 guard. Global registration does
/// NOT capture scope (free names resolve against the CALLING surface's live store).
/// TS twin: OpenSource/Web/packages/kernel/test/global-functions.test.ts (both executors).
class GlobalFunctionsTest {

    @AfterTest fun clearGlobals() { JSE.clearGlobalFunctions() }

    private fun eval(expr: String, store: StackStore = StackStore()): Any? =
        JSE.eval(expr, store, null)

    @Test fun globalFunctionResolvesFromEverySurface() {
        JSE.registerGlobalFunctions("function tax(n) { return n * 0.2 }")
        assertEquals(10.0, eval("tax(50)"))
        assertEquals(10.0, eval("tax(50)"))            // a SECOND surface shares the table
    }

    @Test fun surfaceLocalFunctionShadowsTheGlobal() {
        JSE.registerGlobalFunctions("function price(n) { return n * 2 }")
        val store = StackStore()
        JSE.registerFunctions("function price(n) { return n * 3 }", store)
        assertEquals(15.0, JSE.eval("price(5)", store, null))   // the local wins
        assertEquals(10.0, eval("price(5)"))                    // a bare surface sees the global
    }

    @Test fun clearGlobalFunctionsRestoresTheBuiltinFallthrough() {
        assertEquals(1.0, eval("round(1.4)"))          // the builtin
        JSE.registerGlobalFunctions("function round(n) { return 999 }")
        assertEquals(999.0, eval("round(1.4)"))        // the global sits BEFORE builtins
        JSE.clearGlobalFunctions()
        assertEquals(1.0, eval("round(1.4)"))          // builtin again
    }

    @Test fun globalFunctionCallsAnotherGlobalFunction() {
        JSE.registerGlobalFunctions(
            "function tax(n) { return n * 0.2 }\nfunction total(n) { return n + tax(n) }")
        assertEquals(60.0, eval("total(50)"))
    }

    @Test fun globalRecursionIsContainedByTheSharedFnDepthGuard() {
        JSE.registerGlobalFunctions("function spin(n) { return spin(n + 1) }")
        val store = StackStore()
        assertEquals("contained", JSE.eval("spin(0) ?? 'contained'", store, null))
        assertEquals(0, store.fnDepth)                 // the guard unwound cleanly
    }
}
