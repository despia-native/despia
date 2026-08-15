//
//  StackApiView.kt — lifecycle mount for native declarative `<api>` blocks.
//
//  ApiBlock owns the cross-platform state machine; this file owns only Compose lifecycle
//  and the Android async transport. Construction happens in DisposableEffect (never in a
//  remember initializer/composition), after the callable handle is registered and before
//  any auto-fetch is allowed to start.
//
//  /web/11 (the dependency graph): a block declared in the SURFACE ROOT's head joins the
//  scope graph StackRootView built (`renderFields.apiGraph`) — construction then does NOT
//  auto-fire; the root's post-subtree effect calls `graph.start()` once every sibling has
//  attached, so `needs=` edges, `upstream-error` propagation and the declared cycle error
//  behave here exactly as the corpus pins them. Every OTHER position keeps the graph-less
//  contract, and that is deliberate, not a shortcut: a component's own head is its own
//  dependency scope, so borrowing the surface graph would invent edges the compiler never
//  saw. A LATE mount (a head behind visible-if, a recomposition after the start effect)
//  also takes the graph-less path — attaching to a started graph would leave that block
//  waiting forever for a release that already happened.
//

package despia.engine.render

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import despia.engine.ApiBlock
import despia.engine.ApiGraph
import despia.engine.DSX
import despia.engine.DSXCookies
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.StackApiHandle
import despia.engine.StackStore
import despia.engine.claimApiHandle
import despia.engine.kernelLog
import despia.engine.sink
import despia.engine.platform.NetworkBackend

@Composable
internal fun StackApiView(
    attrs: Map<String, String>,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
) {
    val name = attrs["as"]?.trim().orEmpty()
    val url = attrs["url"]?.trim().orEmpty()
    if (name.isEmpty() || url.isEmpty()) {
        DisposableEffect(name, url) {
            kernelLog("[Stack] ignored <api>: non-empty 'as' and 'url' attributes are required")
            onDispose {}
        }
        return
    }
    val mount = remember(store, name) { MountedStackApi(name) }

    DisposableEffect(mount, attrs, env, item) {
        // Registration MUST precede construction: ApiBlock's constructor seeds state and
        // schedules its first auto-fetch.
        val registration = store.claimApiHandle(name, mount)
        if (registration == null) {
            kernelLog("[Stack] ignored duplicate <api as=\"$name\">; the first declaration owns the handle")
            onDispose {}
        } else {
            mount.start(attrs, store, env, item)
            // Surface + global publications coalesce onto one post-render turn. This avoids
            // materializing intermediate request states during a batch of related writes.
            val subscription = store.sink { mount.scheduleStoreChanged() }
            val globalSubscription = DSX.state.sink { mount.scheduleStoreChanged() }
            // The declaration paints no pixels, so it also needs a lifecycle-scoped
            // imperative observer for cookie-bound url/headers/body expressions.
            val cookieSubscription = DSXCookies.shared.sink { mount.scheduleStoreChanged() }
            onDispose {
                subscription.cancel()
                globalSubscription.cancel()
                cookieSubscription.cancel()
                mount.dispose()
                registration.cancel()
            }
        }
    }
}

private class MountedStackApi(private val name: String) : StackApiHandle {
    private var block: ApiBlock? = null
    private var storeChangeScheduled = false
    /// The scope graph this block joined, so disposal can detach it (null = graph-less).
    private var graph: ApiGraph? = null

    fun start(
        attrs: Map<String, String>,
        store: StackStore,
        env: JSERunner,
        item: Map<String, Any?>?,
    ) {
        check(block == null) { "api '$name' mounted twice without disposal" }
        // /web/11 (header): only a ROOT-HEAD declaration whose graph has not started yet
        // joins the scope DAG; everything else keeps the graph-less contract.
        val fields = store.renderFields
        val scopeGraph = if (!fields.apiGraphStarted && fields.apiGraphNames.contains(name)) fields.apiGraph else null
        graph = scopeGraph
        block = ApiBlock(
            spec = attrs,
            store = store,
            item = item,
            // UI mounts always use asyncFetch. This blocking seam is intentionally
            // unreachable but remains required by the conformance-compatible constructor.
            fetch = { _, _ -> error("mounted <api> used its blocking transport") },
            onEvent = { event, payload ->
                attrs["on:$event"]?.let { action ->
                    env.runGated(
                        action = action,
                        item = payload,
                        args = payload,
                        debounceMs = JSERunner.gateMs(attrs, event, "debounce"),
                        throttleMs = JSERunner.gateMs(attrs, event, "throttle"),
                        gateKey = "api:$name:$event",
                    )
                }
            },
            asyncFetch = NetworkBackend.apiFetch,
            graph = scopeGraph,
        )
        scopeGraph?.attach(block!!, name)
    }

    fun storeChanged() {
        block?.storeChanged()
    }

    fun scheduleStoreChanged() {
        synchronized(this) {
            if (storeChangeScheduled || block == null) return
            storeChangeScheduled = true
        }
        JSE.afterRender {
            synchronized(this) { storeChangeScheduled = false }
            storeChanged()
        }
    }

    override fun refresh(completion: ((Map<String, Any?>?) -> Unit)?) {
        val live = block
        if (live == null) completion?.invoke(null)
        else if (completion == null) live.refresh()
        else live.refresh { completion(it) }
    }

    override fun send(
        args: Map<String, Any?>?,
        completion: ((Map<String, Any?>?) -> Unit)?,
    ) {
        val live = block
        if (live == null) completion?.invoke(null) else live.send(args) { completion?.invoke(it) }
    }

    override fun cancel() {
        block?.cancel()
    }

    fun dispose() {
        graph?.detach(name)
        graph = null
        block?.dispose()
        block = null
        synchronized(this) { storeChangeScheduled = false }
    }
}
