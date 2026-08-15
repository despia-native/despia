package despia.engine.desktop

import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.Container
import despia.engine.ModuleRegistry
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStorePublisher
import despia.engine.DSXCookies
import despia.engine.DSXEvents
import despia.engine.DSXMessenger
import despia.engine.DSXShared
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.SwingUtilities
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.parallel.ResourceLock
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@ResourceLock("despia-engine-runtime-executors")
class DesktopContractsTest {
    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun dispatcherMovesBackgroundWorkToTheEdtAndRestoresSeams() {
        val oldAfter = JSE.afterRenderDispatch
        val oldMain = JSERunner.mainExecutor
        val oldStoreMain = StackStorePublisher.mainExecutor
        val oldCookieMain = DSXCookies.shared.mainExecutor
        val oldEventMain = DSXEvents.mainExecutor
        val oldSharedMain = DSXShared.mainExecutor
        val oldMessengerInboundMain = DSXMessenger.inboundMainExecutor
        val oldMessengerOutboundMain = DSXMessenger.outboundMainExecutor
        val oldRegistryMain = ModuleRegistry.shared.mainExecutor
        val oldContainerMain = Container.observerMainExecutor
        val handle = DesktopUiDispatcher.install()
        try {
            val latch = CountDownLatch(10)
            val onEdt = AtomicBoolean(true)
            val synchronousSeamsReturnedAfterExecution = AtomicBoolean(true)
            Thread {
                JSE.afterRender {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                JSERunner.mainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                StackStorePublisher.mainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                DSXCookies.shared.mainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                DSXEvents.mainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                DSXShared.mainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                DSXMessenger.inboundMainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                Container.observerMainExecutor.execute {
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                var registryRan = false
                var messengerOutboundRan = false
                DSXMessenger.outboundMainExecutor.execute {
                    messengerOutboundRan = true
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                ModuleRegistry.shared.mainExecutor.execute {
                    registryRan = true
                    onEdt.set(onEdt.get() && SwingUtilities.isEventDispatchThread())
                    latch.countDown()
                }
                synchronousSeamsReturnedAfterExecution.set(
                    synchronousSeamsReturnedAfterExecution.get() &&
                        messengerOutboundRan && registryRan,
                )
            }.start()
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            assertTrue(onEdt.get())
            assertTrue(synchronousSeamsReturnedAfterExecution.get())
        } finally {
            handle.close()
        }
        assertTrue(JSE.afterRenderDispatch === oldAfter)
        assertTrue(JSERunner.mainExecutor === oldMain)
        assertTrue(StackStorePublisher.mainExecutor === oldStoreMain)
        assertTrue(DSXCookies.shared.mainExecutor === oldCookieMain)
        assertTrue(DSXEvents.mainExecutor === oldEventMain)
        assertTrue(DSXShared.mainExecutor === oldSharedMain)
        assertTrue(DSXMessenger.inboundMainExecutor === oldMessengerInboundMain)
        assertTrue(DSXMessenger.outboundMainExecutor === oldMessengerOutboundMain)
        assertTrue(ModuleRegistry.shared.mainExecutor === oldRegistryMain)
        assertTrue(Container.observerMainExecutor === oldContainerMain)
    }

    @Test
    fun dispatcherRetainsUntilTheLastIdempotentHandleClosesOutOfOrder() {
        val oldAfter = JSE.afterRenderDispatch
        val oldMain = JSERunner.mainExecutor
        val oldStoreMain = StackStorePublisher.mainExecutor
        val oldCookieMain = DSXCookies.shared.mainExecutor
        val oldEventMain = DSXEvents.mainExecutor
        val oldSharedMain = DSXShared.mainExecutor
        val oldMessengerInboundMain = DSXMessenger.inboundMainExecutor
        val oldMessengerOutboundMain = DSXMessenger.outboundMainExecutor
        val oldRegistryMain = ModuleRegistry.shared.mainExecutor
        val oldContainerMain = Container.observerMainExecutor
        val first = DesktopUiDispatcher.install()
        val installedAfter = JSE.afterRenderDispatch
        val installedMain = JSERunner.mainExecutor
        val installedStoreMain = StackStorePublisher.mainExecutor
        val installedCookieMain = DSXCookies.shared.mainExecutor
        val installedEventMain = DSXEvents.mainExecutor
        val installedSharedMain = DSXShared.mainExecutor
        val installedMessengerInboundMain = DSXMessenger.inboundMainExecutor
        val installedMessengerOutboundMain = DSXMessenger.outboundMainExecutor
        val installedRegistryMain = ModuleRegistry.shared.mainExecutor
        val installedContainerMain = Container.observerMainExecutor
        val second = DesktopUiDispatcher.install()
        try {
            first.close()
            first.close()
            assertTrue(JSE.afterRenderDispatch === installedAfter)
            assertTrue(JSERunner.mainExecutor === installedMain)
            assertTrue(StackStorePublisher.mainExecutor === installedStoreMain)
            assertTrue(DSXCookies.shared.mainExecutor === installedCookieMain)
            assertTrue(DSXEvents.mainExecutor === installedEventMain)
            assertTrue(DSXShared.mainExecutor === installedSharedMain)
            assertTrue(DSXMessenger.inboundMainExecutor === installedMessengerInboundMain)
            assertTrue(DSXMessenger.outboundMainExecutor === installedMessengerOutboundMain)
            assertTrue(ModuleRegistry.shared.mainExecutor === installedRegistryMain)
            assertTrue(Container.observerMainExecutor === installedContainerMain)

            second.close()
            second.close()
            assertTrue(JSE.afterRenderDispatch === oldAfter)
            assertTrue(JSERunner.mainExecutor === oldMain)
            assertTrue(StackStorePublisher.mainExecutor === oldStoreMain)
            assertTrue(DSXCookies.shared.mainExecutor === oldCookieMain)
            assertTrue(DSXEvents.mainExecutor === oldEventMain)
            assertTrue(DSXShared.mainExecutor === oldSharedMain)
            assertTrue(DSXMessenger.inboundMainExecutor === oldMessengerInboundMain)
            assertTrue(DSXMessenger.outboundMainExecutor === oldMessengerOutboundMain)
            assertTrue(ModuleRegistry.shared.mainExecutor === oldRegistryMain)
            assertTrue(Container.observerMainExecutor === oldContainerMain)
        } finally {
            first.close()
            second.close()
        }
    }

    @Test
    fun interruptedSynchronousDispatchStillExecutesExactlyOnceBeforeReturning() {
        val handle = DesktopUiDispatcher.install()
        val blockerStarted = CountDownLatch(1)
        val releaseEdt = CountDownLatch(1)
        val workerEntered = CountDownLatch(1)
        val workerReturned = CountDownLatch(1)
        val executions = AtomicInteger()
        val interruptRestored = AtomicBoolean(false)
        SwingUtilities.invokeLater {
            blockerStarted.countDown()
            releaseEdt.await(10, TimeUnit.SECONDS)
        }
        try {
            assertTrue(blockerStarted.await(5, TimeUnit.SECONDS))
            val worker = Thread {
                workerEntered.countDown()
                ModuleRegistry.shared.mainExecutor.execute { executions.incrementAndGet() }
                interruptRestored.set(Thread.currentThread().isInterrupted)
                workerReturned.countDown()
            }
            worker.start()
            assertTrue(workerEntered.await(5, TimeUnit.SECONDS))
            worker.interrupt()
            assertFalse(
                workerReturned.await(250, TimeUnit.MILLISECONDS),
                "an accepted EDT action must finish before synchronous dispatch returns",
            )
            releaseEdt.countDown()
            assertTrue(workerReturned.await(5, TimeUnit.SECONDS))
            worker.join(5_000)
            assertFalse(worker.isAlive)
            assertEquals(1, executions.get())
            assertTrue(interruptRestored.get())
        } finally {
            releaseEdt.countDown()
            handle.close()
        }
    }

    @Test
    fun hoverLifecycleBalancesEnterExitAndDisposal() {
        var starts = 0
        var ends = 0
        val lifecycle = DesktopHoverLifecycle({ starts += 1 }, { ends += 1 })
        lifecycle.enter()
        lifecycle.enter()
        assertEquals(1, starts)
        lifecycle.dispose()
        lifecycle.dispose()
        assertEquals(1, ends)
        assertFalse(lifecycle.hovering)
        lifecycle.enter()
        lifecycle.exit()
        assertEquals(2, starts)
        assertEquals(2, ends)
    }

    @Test
    fun globalShortcutsRequirePrimaryExceptForEscape() {
        assertEquals(DesktopShortcut("s", primary = true, shift = true, alt = false), DesktopShortcut.parse("primary+shift+s"))
        assertEquals(DesktopShortcut("escape", primary = false, shift = false, alt = false), DesktopShortcut.parse("escape"))
        assertNull(DesktopShortcut.parse("s"))
        assertNull(DesktopShortcut.parse("shift+s"))
        assertNull(DesktopShortcut.parse("alt+1"))
        assertNotNull(DesktopShortcut.parse("primary+1"))
        listOf("space", "tab", "enter", "return", "up", "down", "left", "right", "shift+tab").forEach {
            assertNull(DesktopShortcut.parse(it), "unmodified global shortcut must be rejected: $it")
        }
        listOf("space", "tab", "enter", "return", "up", "down", "left", "right").forEach {
            assertNotNull(DesktopShortcut.parse("primary+$it"), "primary shortcut must be accepted: $it")
        }
        assertNull(DesktopShortcut.parse("hyper+s"))
        assertNull(DesktopShortcut.parse("primary+not-a-key"))
    }

    @Test
    fun collectionViewportIsFiniteForNestedScrollConstraints() {
        assertEquals(720f, desktopCollectionViewportDp(windowHeightPx = 1_440, density = 2f))
        assertEquals(DEFAULT_DESKTOP_COLLECTION_VIEWPORT_DP, desktopCollectionViewportDp(0, 2f))
        assertEquals(DEFAULT_DESKTOP_COLLECTION_VIEWPORT_DP, desktopCollectionViewportDp(1_440, Float.NaN))
        assertEquals(DEFAULT_DESKTOP_COLLECTION_VIEWPORT_DP, desktopCollectionViewportDp(1_440, 0f))
        assertEquals(MAX_DESKTOP_COLLECTION_VIEWPORT_DP, desktopCollectionViewportDp(Int.MAX_VALUE, 0.001f))
    }

    @Test
    fun hiddenOrDisabledNodesCannotProduceGlobalShortcutActions() {
        val attrs = mapOf("shortcut" to "primary+k", "on:tap" to "openCommandPalette()")
        assertEquals("openCommandPalette()", assertNotNull(desktopShortcutAction(attrs, interactive = true)).action)
        assertNull(desktopShortcutAction(attrs, interactive = false))
        assertNull(desktopShortcutAction(attrs - "on:tap", interactive = true))
        assertNull(desktopShortcutAction(attrs + ("shortcut" to "k"), interactive = true))
    }

    @Test
    fun authoredLayoutNumbersAreFiniteNonNegativeAndBounded() {
        assertEquals(0f, dimension("-12", 8f))
        assertEquals(8f, dimension("NaN", 8f))
        assertEquals(MAX_DESKTOP_LAYOUT_DP, dimension("1e30", 8f))
        assertEquals(-MAX_DESKTOP_SCALAR, scalar("-1e30", 0f))
        assertEquals(1f, boundedNumber("Infinity", 1f, 0f, 2f))
        assertNull(boundedNumberOrNull("NaN", 0f, 1f))
        assertEquals(0f, number(null, Float.NaN))
    }

    @Test
    fun componentInputsExcludeControlAttributesAndHaveARecursionCeiling() {
        assertEquals(
            mapOf<String, Any?>("kind" to "beta", "padding" to "8"),
            desktopComponentAttributes(
                linkedMapOf(
                    "tag" to "Badge",
                    "id" to "badge",
                    "kind" to "beta",
                    "padding" to "8",
                    "on:select" to "selected = true",
                    "from:select" to "action=choose",
                ),
            ),
        )
        assertEquals(32, MAX_DESKTOP_COMPONENT_DEPTH)
    }

    @Test
    fun accessibilityAliasesAndRolesFoldToOneSemanticSpec() {
        val spec = desktopAccessibility(
            "button",
            mapOf(
                "aria-label" to "Save",
                "a11yHint" to "Writes the document",
                "a11yValue" to "Ready",
                "a11yGroup" to "true",
                "a11yTrait" to "button, selected",
            ),
        )
        assertEquals("Save", spec.label)
        assertEquals("Writes the document", spec.hint)
        assertEquals("Ready", spec.value)
        assertEquals("button", spec.role)
        assertTrue(spec.group)
        assertFalse(spec.hidden)
        assertTrue(spec.selected)
    }

    @Test
    fun focusOrderIsNumericStableAndPlatformFolded() {
        Platform.os = "linux"
        val firstAuthored = StackNode("button", mapOf("focusOrder" to "20"), emptyList())
        val secondAuthored = StackNode("button", mapOf("focusOrder:desktop" to "10"), emptyList())
        val tie = StackNode("input", mapOf("focusOrder" to "20"), emptyList())
        val natural = StackNode("text", emptyMap(), emptyList())
        val root = StackNode("vstack", emptyMap(), listOf(firstAuthored, secondAuthored, tie, natural))
        val ordered = orderedFocusNodes(root)
        assertEquals(listOf(secondAuthored, firstAuthored, tie), ordered)
        assertNotNull(ordered.first())
    }
}
