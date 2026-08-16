package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import despia.engine.ApiBlock
import despia.engine.DSX
import despia.engine.DSXCookies
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.StackApiHandle
import despia.engine.StackStore
import despia.engine.claimApiHandle
import despia.engine.kernelLog
import despia.engine.sink

/** Lifecycle host for a declarative desktop `<api>`. The portable ApiBlock owns
 * request/watch/cache semantics; this surface owns only native Compose lifecycle and
 * the JDK transport. */
@Composable
internal fun DesktopApiView(
    attrs: Map<String, String>,
    store: StackStore,
    runner: JSERunner,
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
    val mount = remember(store, name) { MountedDesktopApi(name) }
    DisposableEffect(mount, attrs, runner, item) {
        // Registration precedes ApiBlock construction because construction seeds state
        // and can schedule an immediate GET.
        val registration = store.claimApiHandle(name, mount)
        if (registration == null) {
            kernelLog("[Stack] ignored duplicate <api as=\"$name\">; the first declaration owns the handle")
            onDispose {}
        } else {
            mount.start(attrs, store, runner, item)
            val storeSubscription = store.sink { mount.scheduleStoreChanged() }
            val globalSubscription = DSX.state.sink { mount.scheduleStoreChanged() }
            val cookieSubscription = DSXCookies.shared.sink { mount.scheduleStoreChanged() }
            onDispose {
                storeSubscription.cancel()
                globalSubscription.cancel()
                cookieSubscription.cancel()
                mount.dispose()
                registration.cancel()
            }
        }
    }
}

private class MountedDesktopApi(private val name: String) : StackApiHandle {
    private var block: ApiBlock? = null
    private var storeChangeScheduled = false

    fun start(
        attrs: Map<String, String>,
        store: StackStore,
        runner: JSERunner,
        item: Map<String, Any?>?,
    ) {
        check(block == null) { "api '$name' mounted twice without disposal" }
        block = ApiBlock(
            spec = attrs,
            store = store,
            item = item,
            fetch = { _, _ -> error("mounted <api> used its blocking transport") },
            onEvent = { event, payload ->
                attrs["on:$event"]?.let { action ->
                    runner.runGated(
                        action = action,
                        item = payload,
                        args = payload,
                        debounceMs = JSERunner.gateMs(attrs, event, "debounce"),
                        throttleMs = JSERunner.gateMs(attrs, event, "throttle"),
                        gateKey = "api:$name:$event",
                    )
                }
            },
            asyncFetch = DesktopNetwork.apiFetch,
        )
    }

    fun scheduleStoreChanged() {
        synchronized(this) {
            if (storeChangeScheduled || block == null) return
            storeChangeScheduled = true
        }
        JSE.afterRender {
            synchronized(this) { storeChangeScheduled = false }
            block?.storeChanged()
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
        block?.dispose()
        block = null
        synchronized(this) { storeChangeScheduled = false }
    }
}
