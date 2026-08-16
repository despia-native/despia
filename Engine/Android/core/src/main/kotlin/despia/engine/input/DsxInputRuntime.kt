//
//  DsxInputRuntime.kt - the APP-WIDE G4 input runtime (:core, SDK-free).
//
//  The DECISIONS live in SceneInput.kt (corpus-pinned, three runtimes). This object is the
//  live plumbing that carries them: the merged binding table across every surface that
//  declared `<input>`, the one InputMachine, publication of each binding's live value onto
//  the reactive app store as `global.input.<name>` (so `dsx.input.jump` is an ordinary
//  tracked read — JSE.normalizeScope maps the `input` scope word), and the press-edge
//  subscription the `on:input.<name>` handlers ride.
//
//  Platform lanes push raw device events in (:render binds Compose key events, pointer
//  gestures and gamepad motion) and call commit() — exactly the split the TS twin uses.
//
package despia.engine.input

import despia.engine.DSX
import despia.engine.setPath

object DsxInputRuntime {

    private val lock = Any()
    private val owners = LinkedHashMap<Any, List<Map<String, String?>>>()
    private val subscribers = LinkedHashMap<String, MutableList<Pair<Any, (InputEvent) -> Unit>>>()
    private val machine = InputMachine(emptyList())
    private var published = mutableMapOf<String, Any?>()

    /** Diagnostics from the LAST rebuild — the Article-7 ledger a host may surface. */
    var diagnostics: List<InputDiagnostic> = emptyList()
        private set

    /** The live resolved table — introspection for hosts and tests. */
    val bindings: List<InputBinding> get() = machine.bindings

    /** Register one surface's head `<input>` declarations (idempotent per owner). */
    fun register(owner: Any, decls: List<Map<String, String?>>) {
        if (decls.isEmpty()) return
        synchronized(lock) {
            if (owners[owner] == decls) return
            owners[owner] = decls
            rebuild()
        }
    }

    fun unregister(owner: Any) {
        synchronized(lock) {
            if (owners.remove(owner) == null) return
            rebuild()
        }
    }

    private fun rebuild() {
        val all = owners.values.flatten()
        val resolved = SceneInput.resolveDeclarations(all)
        diagnostics = resolved.diagnostics
        machine.reset(resolved.bindings)
        // Seed every declared name so a read BEFORE any device event is the honest resting
        // value rather than null (the typed-absence rule).
        val next = mutableMapOf<String, Any?>()
        for (b in resolved.bindings) next[b.name] = if (b.axis) mapOf("x" to 0.0, "y" to 0.0) else false
        for ((name, value) in next) {
            if (published[name] != value) DSX.state.setPath("input.$name", value)
        }
        for (name in published.keys) if (!next.containsKey(name)) DSX.state.setPath("input.$name", null)
        published = next
    }

    /** Subscribe to a binding's press EDGE — the `on:input.<name>` consumer path. */
    fun subscribe(name: String, token: Any, handler: (InputEvent) -> Unit) {
        synchronized(lock) {
            subscribers.getOrPut(name) { mutableListOf() }.add(token to handler)
        }
    }

    fun unsubscribe(name: String, token: Any) {
        synchronized(lock) {
            subscribers[name]?.removeAll { it.first === token }
            if (subscribers[name]?.isEmpty() == true) subscribers.remove(name)
        }
    }

    fun keyDown(key: String) { machine.keyDown(key) }
    fun keyUp(key: String) { machine.keyUp(key) }
    fun releaseKeys() { machine.releaseKeys() }
    fun gamepad(snapshot: InputPadSnapshot?) { machine.gamepad(snapshot) }
    fun touch(word: String) { machine.touch(word) }
    fun touchRelease(word: String) { machine.touchRelease(word) }

    /** Does any declared binding name a gamepad leg? (the polling gate) */
    fun wantsGamepad(): Boolean = machine.bindings.any { it.buttons.isNotEmpty() || it.sticks.isNotEmpty() }

    /** Fold one frame: publish changed values, then dispatch the press edges. */
    fun commit() {
        val result = machine.commit()
        for ((name, value) in result.values) {
            val published = when (value) {
                is Pair<*, *> -> mapOf("x" to value.first, "y" to value.second)
                else -> value
            }
            if (this.published[name] != published) {
                this.published[name] = published
                DSX.state.setPath("input.$name", published)
            }
        }
        if (result.events.isEmpty()) return
        val snapshot = synchronized(lock) { subscribers.mapValues { it.value.toList() } }
        for (event in result.events) {
            for ((_, handler) in snapshot[event.name].orEmpty()) handler(event)
        }
    }

    /** Test seam: drop every registration, subscription and published value. */
    fun reset() {
        synchronized(lock) {
            owners.clear()
            subscribers.clear()
            machine.reset(emptyList())
            for (name in published.keys) DSX.state.setPath("input.$name", null)
            published = mutableMapOf()
            diagnostics = emptyList()
        }
    }
}
