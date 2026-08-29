//
//  StackRef.kt - the `ref="name"` universal attribute's shared core (:core, pure JVM). The law
//  is the corpus: OpenSource/Conformance/input/ref.json. The twin of Swift StackRef and the web
//  @despia/kernel ref.ts.
//
//  WHAT REF IS FOR: publishing an element's backing platform view into the shared-handle
//  registry so a MODULE can reach it - Core/Capture's element and pdf actions, <scroll>'s
//  toElement, <Spotlight>'s target rect. The kernel names none of those consumers: it publishes
//  under a derived key and any module resolves it over the bus, which is what keeps `ref` a
//  kernel primitive rather than a feature.
//
//  THE ONE NON-OBVIOUS RULE is list recycling. A recycled row mounts the INCOMING view before it
//  unmounts the outgoing one, so a naive clear-on-disappear would kill the ref the visible row
//  now owns. Clearing therefore checks provider identity: only the CURRENT provider may clear,
//  and a stale provider's teardown is a no-op.
//
package despia.engine

object StackRef {

    /** The registry key for a ref name, or null when the name is not a ref.
     *
     *  Namespaced with `ref.` so an author's name can never collide with a first-class handle
     *  like `web` or `view`. Exact case: a name is opaque, not a keyword. */
    fun key(name: String?): String? {
        val trimmed = name?.trim().orEmpty()
        return if (trimmed.isEmpty()) null else "ref.$trimmed"
    }

    /** The stable machine id a consumer reports for both never-published and published-then-gone. */
    const val UNKNOWN: String = "unknown_ref"
}

/**
 * The provider table behind `ref=`. Renderer-neutral so one corpus judges three runtimes; each
 * platform adapter owns the actual weak handle and calls in on appear and disappear.
 */
class RefRegistry<V : Any> {

    private val entries = HashMap<String, Entry<V>>()

    private class Entry<V : Any>(var view: V?)

    /** Publish (or replace) the provider for [name]. The LAST provider wins. */
    fun provide(name: String?, view: V) {
        val k = StackRef.key(name) ?: return
        entries[k] = Entry(view)
    }

    /** Clear [name], but ONLY if [view] is still the current provider - the recycling rule. */
    fun clear(name: String?, view: V) {
        val k = StackRef.key(name) ?: return
        val e = entries[k] ?: return
        if (e.view === view) entries.remove(k)
    }

    /** The platform's weak handle went away without a teardown call. */
    fun collect(name: String?) {
        val k = StackRef.key(name) ?: return
        entries[k]?.view = null
    }

    /** The live view for [name], or null when nothing owns it (the `unknown_ref` case). */
    fun resolve(name: String?): V? {
        val k = StackRef.key(name) ?: return null
        return entries[k]?.view
    }
}
