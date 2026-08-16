package despia.engine.desktop

import despia.engine.DSXModuleCallMount
import despia.engine.JSEModuleOutcome
import despia.engine.JSERunner
import despia.engine.Module
import despia.engine.ModuleCallError
import despia.engine.ModuleRegistry
import despia.modules.clipboard.desktopClipboardNumberString
import despia.modules.deviceuuid.DesktopDeviceUUID
import despia.modules.deviceuuid.DesktopDeviceUUIDResult
import despia.modules.deviceuuid.DesktopDeviceUUIDStore
import despia.modules.valuestore.DesktopValueStore
import java.io.File
import java.math.BigDecimal
import java.math.BigInteger
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.prefs.AbstractPreferences
import java.util.prefs.BackingStoreException
import java.util.prefs.Preferences
import kotlin.io.path.createFile
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.parallel.ResourceLock
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

@ResourceLock("dsx-desktop-persistence")
class DesktopOptionalPackagePersistenceTest {
    @TempDir
    lateinit var temporaryDirectory: Path

    private val originalAppId = System.getProperty("dsx.app.id")
    private val createdAppIds = ArrayList<String>()

    @AfterEach
    fun restoreGlobalPersistenceState() {
        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        DesktopAppIdentity.setPersistenceTestOverrides()
        createdAppIds.forEach { appId ->
            System.setProperty("dsx.app.id", appId)
            removeCurrentPreferenceAreas("device", "settings")
            removeAppStorage(appId)
        }
        Files.deleteIfExists(temporaryDirectory.resolve("app-data"))
        createdAppIds.clear()
        if (originalAppId == null) System.clearProperty("dsx.app.id")
        else System.setProperty("dsx.app.id", originalAppId)
    }

    @Test
    fun preferenceAcquisitionDistinguishesMissingIdentityFromUnavailableBackend() {
        System.setProperty("dsx.app.id", "!")
        assertIs<DesktopPreferenceAccess.IdentityMissing>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        )

        configureFreshApp()
        DesktopAppIdentity.setPersistenceTestOverrides(
            rootProvider = { throw SecurityException("denied for deterministic test") },
            lockRoot = temporaryDirectory.resolve("locks"),
        )
        assertIs<DesktopPreferenceAccess.PersistenceUnavailable>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        )
    }

    @Test
    fun existingPreferencesUuidIsPreservedCanonicalizedAndSurvivesCacheReset() {
        val appId = configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot)
        val existing = "3f53cc97-1afd-49b8-a4de-2a9554761234"
        val preferences = assertIs<DesktopPreferenceAccess.Available<Preferences>>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        ).value
        preferences.put("vendor-install-uuid", existing)
        preferences.flush()

        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        val first = assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid
        assertEquals(existing.uppercase(), first)
        // The durable home is the app-scoped FILE now, so a pre-file install's Preferences key is
        // migrated and REMOVED — the contract readAppScopedOpaqueValue has always applied to the
        // ValueStore. Asserting the key is GONE, and the file is present, is what proves the
        // migration actually ran rather than the value merely still being readable where it was.
        assertEquals(null, preferences.get("vendor-install-uuid", null))
        assertTrue(Files.exists(appStorageFile(appId, "device")), "the UUID was not migrated to its durable file")

        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        val afterRestart = assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid
        assertEquals(first, afterRestart)
    }

    @Test
    fun durableUuidChangedByAnotherProcessWinsOverTheLocalCache() {
        configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("stale-cache-locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot)
        val first = assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid
        val replacement = "50ba7fe0-80df-4cc3-bae1-c21840b8e442".uppercase()
        assertNotEquals(first, replacement)

        // A sibling process replaces the DURABLE value — which is the app-scoped file. Writing the
        // legacy Preferences key is no longer a durable act, and the stale key planted below is
        // the proof: it must NOT override what the file says.
        assertIs<DesktopPreferenceAccess.Available<Boolean>>(
            DesktopAppIdentity.writeAppScopedOpaqueValue("device", "vendor-install-uuid", replacement.lowercase()),
        )
        val preferences = assertIs<DesktopPreferenceAccess.Available<Preferences>>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        ).value
        preferences.put("vendor-install-uuid", "11111111-1111-4111-8111-111111111111")
        preferences.flush()
        preferences.sync()

        // This process's cache still holds `first`. The durable value wins, canonicalized.
        assertEquals(
            replacement,
            assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid,
        )
        // …and the canonical form was written back durably, not just returned.
        assertEquals(
            replacement,
            assertIs<DesktopPreferenceAccess.Available<String>>(
                DesktopAppIdentity.readAppScopedOpaqueValue("device", "vendor-install-uuid"),
            ).value,
        )
        // The stale legacy key never won, and the migration cleared it.
        assertEquals(null, preferences.get("vendor-install-uuid", null))
    }

    @Test
    fun concurrentFirstInitializationPublishesOneDurableUuid() {
        configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot)
        val workers = 24
        val ready = CountDownLatch(workers)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(workers)
        try {
            val futures = (0 until workers).map {
                pool.submit<String> {
                    ready.countDown()
                    assertTrue(start.await(10, TimeUnit.SECONDS))
                    assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid
                }
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS))
            start.countDown()
            val values = futures.map { it.get(20, TimeUnit.SECONDS) }
            assertEquals(1, values.toSet().size)

            DesktopDeviceUUIDStore.resetMemoryCacheForTests()
            assertEquals(
                values.singleDistinct(),
                assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid,
            )
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun concurrentIndependentJvmInitializationPublishesOneDurableUuid() {
        // Spawns four independent child JVMs, releases them together, and asserts they publish ONE
        // durable identity. This used to be skipped on CI: the durable value lived in
        // java.util.prefs, whose backing store does not reliably reflect a sibling process's write
        // back into THIS process's cached view on headless/container runners, so the post-reset
        // re-read below was unstable there. That was not merely a CI artefact — the same per-process
        // caching is why four JVMs each read "absent" and each minted a DIFFERENT UUID. The durable
        // value is now an app-scoped file guarded by the cross-process lock, which IS reliably
        // visible across processes, so the skip's cause is gone and this runs everywhere.
        val appId = configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("process-locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot)
        val preferences = assertIs<DesktopPreferenceAccess.Available<Preferences>>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        ).value
        preferences.remove("vendor-install-uuid")
        preferences.flush()
        preferences.sync()

        val startSignal = temporaryDirectory.resolve("start.signal")
        val classpath = listOf(
            DesktopOptionalPackagePersistenceTest::class.java,
            DesktopAppIdentity::class.java,
            DesktopDeviceUUIDStore::class.java,
            ModuleRegistry::class.java,
            Unit::class.java,
        ).map { type ->
            Path.of(requireNotNull(type.protectionDomain.codeSource).location.toURI()).toString()
        }.distinct().joinToString(File.pathSeparator)
        val javaBinary = Path.of(
            System.getProperty("java.home"),
            "bin",
            if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) "java.exe" else "java",
        )
        val processes = (0 until 4).map {
            ProcessBuilder(
                javaBinary.toString(),
                "-cp",
                classpath,
                DesktopDeviceUUIDProcessProbe::class.java.name,
                appId,
                lockRoot.toString(),
                startSignal.toString(),
            ).redirectErrorStream(true).start()
        }
        try {
            startSignal.createFile()
            val values = processes.map { process ->
                assertTrue(process.waitFor(30, TimeUnit.SECONDS), "UUID process oracle timed out")
                val output = process.inputStream.bufferedReader().readText()
                assertEquals(0, process.exitValue(), output)
                requireNotNull(output.lineSequence().firstOrNull { it.startsWith("VALUE:") }) { output }
                    .removePrefix("VALUE:")
                    .trim()
            }
            assertEquals(1, values.toSet().size)
            DesktopDeviceUUIDStore.resetMemoryCacheForTests()
            assertEquals(
                values.singleDistinct(),
                assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid,
            )
        } finally {
            processes.filter { it.isAlive }.forEach { it.destroyForcibly() }
        }
    }

    @Test
    fun uuidNeverReturnsAnEphemeralValueWhenDurableLockingFails() {
        configureFreshApp()
        val unusableRoot = temporaryDirectory.resolve("not-a-directory").createFile()
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = unusableRoot)
        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        assertIs<DesktopDeviceUUIDResult.PersistenceUnavailable>(DesktopDeviceUUIDStore.identifier())

        val preferences = assertIs<DesktopPreferenceAccess.Available<Preferences>>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        ).value
        assertEquals(null, preferences.get("vendor-install-uuid", null))

        DesktopAppIdentity.setPersistenceTestOverrides(
            lockRoot = Files.createDirectory(temporaryDirectory.resolve("working-locks")),
        )
        val durable = assertIs<DesktopDeviceUUIDResult.Value>(DesktopDeviceUUIDStore.identifier()).uuid
        assertTrue(durable.matches(UUID_PATTERN))
    }

    @Test
    fun symbolicLockDirectoryIsRejectedWithoutPublishingAUuid() {
        configureFreshApp()
        val realDirectory = Files.createDirectory(temporaryDirectory.resolve("real-locks"))
        val symbolicDirectory = temporaryDirectory.resolve("linked-locks")
        assumeTrue(
            runCatching { Files.createSymbolicLink(symbolicDirectory, realDirectory) }.isSuccess,
            "Host does not permit symbolic-link creation",
        )
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = symbolicDirectory)
        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        assertIs<DesktopDeviceUUIDResult.PersistenceUnavailable>(DesktopDeviceUUIDStore.identifier())
        val preferences = assertIs<DesktopPreferenceAccess.Available<Preferences>>(
            DesktopAppIdentity.acquirePreferenceNode("device"),
        ).value
        assertEquals(null, preferences.get("vendor-install-uuid", null))
    }

    @Test
    fun symlinkedConfiguredHomeIsAcceptedAsATrustedAnchor() {
        configureFreshApp()
        val realHome = Files.createDirectory(temporaryDirectory.resolve("real-home"))
        val linkedHome = temporaryDirectory.resolve("linked-home")
        assumeTrue(
            runCatching { Files.createSymbolicLink(linkedHome, realHome) }.isSuccess,
            "Host does not permit symbolic-link creation",
        )
        val originalHome = System.getProperty("user.home")
        try {
            System.setProperty("user.home", linkedHome.toString())
            DesktopAppIdentity.setPersistenceTestOverrides()
            assertIs<DesktopPreferenceAccess.Available<String>>(
                DesktopAppIdentity.withLockedPreferenceNode("device") { "accepted" },
            )
            assertTrue(Files.isDirectory(realHome.resolve(".dsx/persistence-locks")))
        } finally {
            if (originalHome == null) System.clearProperty("user.home")
            else System.setProperty("user.home", originalHome)
            DesktopAppIdentity.setPersistenceTestOverrides()
        }
    }

    @Test
    fun wedgedInProcessPersistenceOperationTimesOutInsteadOfBlockingForever() {
        configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("timeout-locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot, timeoutMillis = 100)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holderResult = AtomicReference<DesktopPreferenceAccess<String>>()
        val holder = Thread {
            holderResult.set(DesktopAppIdentity.withLockedPreferenceNode("settings") {
                entered.countDown()
                check(release.await(10, TimeUnit.SECONDS))
                "released"
            })
        }
        holder.start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        try {
            val blocked = assertIs<DesktopPreferenceAccess.PersistenceUnavailable>(
                DesktopAppIdentity.withLockedPreferenceNode("settings") { "must-not-run" },
            )
            assertTrue(blocked.cause.message.orEmpty().contains("timed out"))
        } finally {
            release.countDown()
            holder.join(5_000)
        }
        assertIs<DesktopPreferenceAccess.Available<String>>(holderResult.get())
    }

    @Test
    fun interruptedInProcessLockWaitFailsAndPreservesInterruptStatus() {
        configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("interrupt-locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot, timeoutMillis = 5_000)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = Thread {
            DesktopAppIdentity.withLockedPreferenceNode("settings") {
                entered.countDown()
                check(release.await(10, TimeUnit.SECONDS))
            }
        }
        holder.start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val attempted = CountDownLatch(1)
        val waiterResult = AtomicReference<DesktopPreferenceAccess<String>>()
        val waiterInterrupted = AtomicBoolean(false)
        val waiter = Thread {
            attempted.countDown()
            waiterResult.set(DesktopAppIdentity.withLockedPreferenceNode("settings") { "must-not-run" })
            waiterInterrupted.set(Thread.currentThread().isInterrupted)
        }
        waiter.start()
        assertTrue(attempted.await(5, TimeUnit.SECONDS))
        try {
            Thread.sleep(50)
            waiter.interrupt()
            waiter.join(5_000)
            assertIs<DesktopPreferenceAccess.PersistenceUnavailable>(waiterResult.get())
            assertTrue(waiterInterrupted.get())
        } finally {
            release.countDown()
            holder.join(5_000)
        }
    }

    @Test
    fun oneDeadlineCoversBothLockStagesAndKilledProcessReleasesTheFileLock() {
        val appId = configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("cross-process-timeout-locks"))
        val ready = temporaryDirectory.resolve("holder.ready")
        val release = temporaryDirectory.resolve("holder.release")
        val process = startPersistenceLockHolder(appId, lockRoot, ready, release)
        try {
            waitForPath(ready, 10, TimeUnit.SECONDS)
            val timeoutMillis = 500L
            val firstHasProcessLock = CountDownLatch(1)
            val firstThread = AtomicReference<Thread>()
            DesktopAppIdentity.setPersistenceTestOverrides(
                lockRoot = lockRoot,
                timeoutMillis = timeoutMillis,
                processLockObserver = { area ->
                    if (area == "settings" && Thread.currentThread() === firstThread.get()) {
                        firstHasProcessLock.countDown()
                    }
                },
            )
            val firstResult = AtomicReference<DesktopPreferenceAccess<String>>()
            val first = Thread({
                firstResult.set(
                    DesktopAppIdentity.withLockedPreferenceNode("settings") { "must-not-run" },
                )
            }, "dsx-first-lock-contender")
            firstThread.set(first)
            first.start()
            assertTrue(firstHasProcessLock.await(5, TimeUnit.SECONDS))

            val started = System.nanoTime()
            val second = DesktopAppIdentity.withLockedPreferenceNode("settings") { "must-not-run" }
            val elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            first.join(5_000)
            assertIs<DesktopPreferenceAccess.PersistenceUnavailable>(firstResult.get())
            assertIs<DesktopPreferenceAccess.PersistenceUnavailable>(second)
            // A fresh per-stage deadline would take about 2x (process wait + file
            // wait). Keep generous scheduler headroom while still detecting that bug.
            assertTrue(
                elapsedMillis < 800,
                "combined lock wait used more than one deadline: ${elapsedMillis}ms",
            )

            process.destroyForcibly()
            assertTrue(process.waitFor(10, TimeUnit.SECONDS), "lock holder did not terminate")
            DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot, timeoutMillis = 2_000)
            assertIs<DesktopPreferenceAccess.Available<String>>(
                DesktopAppIdentity.withLockedPreferenceNode("settings") { "recovered" },
            )
        } finally {
            if (process.isAlive) process.destroyForcibly()
            process.waitFor(10, TimeUnit.SECONDS)
        }
    }

    @Test
    fun valueStoreMigratesLegacyPreferencesIntoItsAtomicPrivateFile() {
        val appId = configureFreshApp()
        val lockRoot = Files.createDirectory(temporaryDirectory.resolve("migration-locks"))
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = lockRoot)
        val preferences = assertIs<DesktopPreferenceAccess.Available<Preferences>>(
            DesktopAppIdentity.acquirePreferenceNode("settings"),
        ).value
        preferences.put("appsettings", "legacy-value")
        preferences.flush()
        preferences.sync()
        registerPersistenceModules()

        assertEquals("legacy-value", call("writevalue", "read"))
        assertEquals(null, preferences.get("appsettings", null))
        val file = valueStoreFile(appId)
        assertTrue(Files.isRegularFile(file))
        assertEquals("legacy-value", Files.readString(file))
    }

    @Test
    fun valueStoreRoundTrips64KiBAndRejectsInputBeyondItsOneMiBBound() {
        val appId = configureFreshApp()
        DesktopAppIdentity.setPersistenceTestOverrides(
            lockRoot = Files.createDirectory(temporaryDirectory.resolve("large-value-locks")),
        )
        registerPersistenceModules()
        val value = "DSX-🚀".repeat(9 * 1024)
        assertTrue(value.toByteArray(Charsets.UTF_8).size > 64 * 1024)
        assertEquals(mapOf("ok" to true), call("writevalue", "write", mapOf("value" to value)))
        assertEquals(value, call("writevalue", "read"))
        assertEquals(value.toByteArray(Charsets.UTF_8).size.toLong(), Files.size(valueStoreFile(appId)))

        val oversized = "x".repeat(DesktopAppIdentity.MAX_OPAQUE_VALUE_BYTES + 1)
        val failure = assertFailsWith<ModuleCallError.ActionFailed> {
            call("writevalue", "write", mapOf("value" to oversized))
        }
        assertEquals("value_too_large", failure.code)
        assertEquals(value, call("writevalue", "read"))
    }

    @Test
    fun valueStoreFailsClosedForSymlinkedFiles() {
        val appId = configureFreshApp()
        DesktopAppIdentity.setPersistenceTestOverrides(
            lockRoot = Files.createDirectory(temporaryDirectory.resolve("unsafe-value-locks")),
        )
        registerPersistenceModules()
        assertEquals("", call("writevalue", "read"))
        val file = valueStoreFile(appId)
        val outside = temporaryDirectory.resolve("outside-value")
        Files.writeString(outside, "must-stay-unchanged")
        assumeTrue(
            runCatching { Files.createSymbolicLink(file, outside) }.isSuccess,
            "Host does not permit symbolic-link creation",
        )
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> { call("writevalue", "read") }.code,
        )
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> {
                call("writevalue", "write", mapOf("value" to "replacement"))
            }.code,
        )
        assertEquals("must-stay-unchanged", Files.readString(outside))
    }

    @Test
    fun valueStoreRejectsMalformedUtf8AndOversizedStoredFiles() {
        val appId = configureFreshApp()
        DesktopAppIdentity.setPersistenceTestOverrides(
            lockRoot = Files.createDirectory(temporaryDirectory.resolve("invalid-value-locks")),
        )
        registerPersistenceModules()
        assertEquals("", call("writevalue", "read"))
        val file = valueStoreFile(appId)
        Files.write(file, byteArrayOf(0xc3.toByte(), 0x28))
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> { call("writevalue", "read") }.code,
        )

        Files.write(
            file,
            ByteArray(DesktopAppIdentity.MAX_OPAQUE_VALUE_BYTES + 1),
            StandardOpenOption.WRITE,
            StandardOpenOption.TRUNCATE_EXISTING,
        )
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> { call("writevalue", "read") }.code,
        )
    }

    @Test
    fun publicPersistenceActionsKeepBlockingWorkOffCallerAndMainThreads() {
        configureFreshApp()
        val previousMain = ModuleRegistry.shared.mainExecutor
        val rootEntered = CountDownLatch(1)
        val releaseRoot = CountDownLatch(1)
        val blockFirstSync = AtomicBoolean(true)
        val persistenceThreads = java.util.concurrent.CopyOnWriteArrayList<String>()
        val preferenceSyncThreads = java.util.concurrent.CopyOnWriteArrayList<String>()
        val persistenceRanOnAwt = AtomicBoolean(false)
        val mainExecutions = AtomicInteger()
        val mainPool = Executors.newSingleThreadExecutor { work -> Thread(work, "dsx-test-main") }
        val callerPool = Executors.newSingleThreadExecutor { work -> Thread(work, "dsx-test-public-caller") }
        ModuleRegistry.shared.mainExecutor = Executor { work ->
            mainPool.execute {
                mainExecutions.incrementAndGet()
                work.run()
            }
        }
        try {
            DesktopAppIdentity.setPersistenceTestOverrides(
                rootProvider = {
                    persistenceThreads += Thread.currentThread().name
                    RecordingPreferences(null, "", Preferences.userRoot()) {
                        preferenceSyncThreads += Thread.currentThread().name
                        persistenceRanOnAwt.set(
                            persistenceRanOnAwt.get() || java.awt.EventQueue.isDispatchThread(),
                        )
                        if (blockFirstSync.compareAndSet(true, false)) {
                            rootEntered.countDown()
                            check(releaseRoot.await(10, TimeUnit.SECONDS))
                        }
                    }
                },
                lockRoot = Files.createDirectory(temporaryDirectory.resolve("async-locks")),
            )
            registerPersistenceModules()
            val write = callerPool.submit<Any?> {
                call("writevalue", "write", mapOf("value" to "off-main"))
            }
            assertTrue(rootEntered.await(5, TimeUnit.SECONDS))
            val mainMarker = CountDownLatch(1)
            ModuleRegistry.shared.mainExecutor.execute { mainMarker.countDown() }
            assertTrue(mainMarker.await(5, TimeUnit.SECONDS), "main executor was blocked by persistence")
            assertFalse(write.isDone)
            releaseRoot.countDown()
            assertEquals(mapOf("ok" to true), write.get(10, TimeUnit.SECONDS))
            assertEquals("off-main", callerPool.submit<Any?> { call("writevalue", "read") }.get(10, TimeUnit.SECONDS))
            assertIs<Map<*, *>>(callerPool.submit<Any?> { call("uuid", "value") }.get(10, TimeUnit.SECONDS))
            assertTrue(persistenceThreads.isNotEmpty())
            assertTrue(persistenceThreads.all { it.startsWith("dsx-desktop-persistence-") })
            assertTrue(preferenceSyncThreads.isNotEmpty())
            assertTrue(preferenceSyncThreads.all { it.startsWith("dsx-desktop-persistence-") })
            assertFalse(persistenceRanOnAwt.get())
            // Each action is entered on the main executor and its terminal is
            // marshalled through that executor again.
            assertTrue(mainExecutions.get() >= 7)
        } finally {
            releaseRoot.countDown()
            ModuleRegistry.shared.mainExecutor = previousMain
            callerPool.shutdownNow()
            mainPool.shutdownNow()
        }
    }

    @Test
    fun queuedValueStoreActionsStayFifoAndEveryTerminalRunsOnMainExecutor() {
        configureFreshApp()
        val previousMain = ModuleRegistry.shared.mainExecutor
        val rootEntered = CountDownLatch(1)
        val releaseRoot = CountDownLatch(1)
        val blockFirstRoot = AtomicBoolean(true)
        val mainPool = Executors.newSingleThreadExecutor { work -> Thread(work, "dsx-order-main") }
        val previousModuleHandle = JSERunner.moduleHandle
        ModuleRegistry.shared.mainExecutor = Executor { work -> mainPool.execute(work) }
        try {
            DesktopAppIdentity.setPersistenceTestOverrides(
                rootProvider = {
                    if (blockFirstRoot.compareAndSet(true, false)) {
                        rootEntered.countDown()
                        check(releaseRoot.await(10, TimeUnit.SECONDS))
                    }
                    Preferences.userRoot()
                },
                lockRoot = Files.createDirectory(temporaryDirectory.resolve("ordered-locks")),
            )
            registerPersistenceModules()
            val outcomes = java.util.concurrent.CopyOnWriteArrayList<Pair<String, Any?>>()
            val terminalThreads = java.util.concurrent.CopyOnWriteArrayList<String>()
            val completed = CountDownLatch(3)
            val dispatchFailure = AtomicReference<Throwable>()
            DSXModuleCallMount.bindRegistry()
            fun terminal(label: String): (JSEModuleOutcome) -> Unit = { outcome ->
                terminalThreads += Thread.currentThread().name
                outcomes += label to when (outcome) {
                    is JSEModuleOutcome.Resolve -> outcome.value
                    is JSEModuleOutcome.Error -> outcome.code
                }
                completed.countDown()
            }
            ModuleRegistry.shared.mainExecutor.execute {
                runCatching {
                    check(JSERunner.moduleHandle(
                        "writevalue://write",
                        mapOf("value" to "first"),
                        terminal("first"),
                    ))
                    check(JSERunner.moduleHandle(
                        "writevalue://write",
                        mapOf("value" to "second"),
                        terminal("second"),
                    ))
                    check(JSERunner.moduleHandle(
                        "writevalue://read",
                        emptyMap(),
                        terminal("read"),
                    ))
                }.exceptionOrNull()?.let(dispatchFailure::set)
            }
            assertTrue(rootEntered.await(5, TimeUnit.SECONDS))
            releaseRoot.countDown()
            assertTrue(completed.await(15, TimeUnit.SECONDS))
            dispatchFailure.get()?.let { throw it }
            assertEquals(listOf("first", "second", "read"), outcomes.map { it.first })
            assertEquals("second", outcomes.last().second)
            assertTrue(terminalThreads.all { it == "dsx-order-main" })
            assertEquals("second", call("writevalue", "read"))
        } finally {
            JSERunner.moduleHandle = previousModuleHandle
            releaseRoot.countDown()
            ModuleRegistry.shared.mainExecutor = previousMain
            mainPool.shutdownNow()
        }
    }

    @Test
    fun valueStoreReportsIdentityAndPersistenceFailuresWithDistinctWireCodes() {
        registerPersistenceModules()
        System.setProperty("dsx.app.id", "!")
        assertEquals(
            "app_identity_missing",
            assertFailsWith<ModuleCallError.ActionFailed> { call("writevalue", "read") }.code,
        )
        assertEquals(
            "app_identity_missing",
            assertFailsWith<ModuleCallError.ActionFailed> { call("uuid", "value") }.code,
        )

        configureFreshApp()
        DesktopAppIdentity.setPersistenceTestOverrides(
            rootProvider = { throw SecurityException("denied for deterministic test") },
            lockRoot = temporaryDirectory.resolve("locks"),
        )
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> { call("writevalue", "read") }.code,
        )
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> {
                call("writevalue", "write", mapOf("value" to "must-not-claim-success"))
            }.code,
        )
        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        assertEquals(
            "persistence_unavailable",
            assertFailsWith<ModuleCallError.ActionFailed> { call("uuid", "value") }.code,
        )
    }

    @Test
    fun clipboardNumberConversionMatchesAndroidWithoutSaturation() {
        assertEquals("42", desktopClipboardNumberString(42))
        assertEquals("42", desktopClipboardNumberString(42.0))
        assertEquals("42", desktopClipboardNumberString(42.0f))
        assertEquals("42.5", desktopClipboardNumberString(42.5))
        assertEquals("0.1", desktopClipboardNumberString(0.1f))
        assertEquals(Float.MAX_VALUE.toString(), desktopClipboardNumberString(Float.MAX_VALUE))
        assertEquals("0", desktopClipboardNumberString(-0.0))
        assertEquals("999999999999999", desktopClipboardNumberString(999_999_999_999_999.0))
        assertEquals("1.0E15", desktopClipboardNumberString(1_000_000_000_000_000.0))
        assertEquals("9.223372036854776E18", desktopClipboardNumberString(9.223372036854776E18))
        assertNotEquals(Long.MAX_VALUE.toString(), desktopClipboardNumberString(Double.MAX_VALUE))
        assertEquals(Double.MAX_VALUE.toString(), desktopClipboardNumberString(Double.MAX_VALUE))
        assertEquals("7.25", desktopClipboardNumberString(BigDecimal("7.25")))
        assertEquals("9223372036854775808", desktopClipboardNumberString(BigInteger("9223372036854775808")))
    }

    private fun configureFreshApp(): String {
        val appId = "dev.dsx.persistence.${UUID.randomUUID()}"
        createdAppIds += appId
        DesktopAppIdentity.configure(appId)
        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        return appId
    }

    private fun registerPersistenceModules() {
        ModuleRegistry.shared.register { DesktopValueStore() }
        ModuleRegistry.shared.register { DesktopDeviceUUID() }
    }

    private fun appStorageFile(appId: String, area: String): Path = temporaryDirectory
        .resolve("app-data")
        .resolve(DesktopAppIdentity.namespaceFor(appId))
        .resolve(area)
        .resolve(DesktopAppIdentity.OPAQUE_VALUE_FILE_NAME)

    private fun valueStoreFile(appId: String): Path = appStorageFile(appId, "settings")

    private fun removeAppStorage(appId: String) {
        // EVERY area this app persisted, not just "settings". The durable device UUID moved off
        // java.util.prefs into its own app-scoped "device" file, so naming one area here leaves
        // the other behind and the parent delete throws DirectoryNotEmptyException. The
        // Preferences half of this teardown already names both areas; the file half had not
        // caught up. Walk bottom-up so no future area can reintroduce the same gap.
        val app = valueStoreFile(appId).parent.parent
        if (!Files.exists(app)) return
        Files.walk(app).use { paths ->
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }

    private fun removeCurrentPreferenceAreas(vararg areas: String) {
        var namespaceNode: Preferences? = null
        areas.forEach { area ->
            val node = requireNotNull(DesktopAppIdentity.preferenceNode(area))
            val parent = node.parent()
            namespaceNode = parent
            node.removeNode()
            parent.flush()
            parent.sync()
        }
        val namespace = namespaceNode ?: return
        check(namespace.childrenNames().isEmpty()) {
            "Unexpected preference areas remain under ${namespace.absolutePath()}"
        }
        val apps = namespace.parent()
        namespace.removeNode()
        apps.flush()
        apps.sync()
    }

    private fun startPersistenceLockHolder(
        appId: String,
        lockRoot: Path,
        ready: Path,
        release: Path,
    ): Process {
        val classpath = listOf(
            DesktopOptionalPackagePersistenceTest::class.java,
            DesktopPersistenceLockHolderProbe::class.java,
            DesktopAppIdentity::class.java,
            ModuleRegistry::class.java,
            Unit::class.java,
        ).map { type ->
            Path.of(requireNotNull(type.protectionDomain.codeSource).location.toURI()).toString()
        }.distinct().joinToString(File.pathSeparator)
        val javaBinary = Path.of(
            System.getProperty("java.home"),
            "bin",
            if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) "java.exe" else "java",
        )
        return ProcessBuilder(
            javaBinary.toString(),
            "-cp",
            classpath,
            DesktopPersistenceLockHolderProbe::class.java.name,
            appId,
            lockRoot.toString(),
            ready.toString(),
            release.toString(),
        ).redirectErrorStream(true).start()
    }

    private fun waitForPath(path: Path, amount: Long, unit: TimeUnit) {
        val deadline = System.nanoTime() + unit.toNanos(amount)
        while (!Files.exists(path)) {
            check(deadline - System.nanoTime() > 0L) { "Timed out waiting for $path" }
            Thread.sleep(5)
        }
    }

    private fun call(
        scheme: String,
        action: String,
        args: Map<String, Any?> = emptyMap(),
    ): Any? = runBlocking { caller.module[scheme][action](args).foundationValue }

    private fun List<String>.singleDistinct(): String = distinct().single()

    private companion object {
        val caller = Module().dsx
        val UUID_PATTERN = Regex("[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}")
    }
}

/** Minimal delegating Preferences backend that exposes the exact sync thread. */
private class RecordingPreferences(
    parent: RecordingPreferences?,
    name: String,
    private val delegate: Preferences,
    private val onSync: () -> Unit,
) : AbstractPreferences(parent, name) {
    override fun putSpi(key: String, value: String) = delegate.put(key, value)
    override fun getSpi(key: String): String? = delegate.get(key, null)
    override fun removeSpi(key: String) = delegate.remove(key)

    @Throws(BackingStoreException::class)
    override fun removeNodeSpi() = delegate.removeNode()

    @Throws(BackingStoreException::class)
    override fun keysSpi(): Array<String> = delegate.keys()

    @Throws(BackingStoreException::class)
    override fun childrenNamesSpi(): Array<String> = delegate.childrenNames()

    override fun childSpi(name: String): AbstractPreferences = RecordingPreferences(
        this,
        name,
        delegate.node(name),
        onSync,
    )

    @Throws(BackingStoreException::class)
    override fun syncSpi() {
        onSync()
        delegate.sync()
    }

    @Throws(BackingStoreException::class)
    override fun flushSpi() = delegate.flush()
}

/** A deliberately dependency-light cross-process oracle used by the test above. */
object DesktopDeviceUUIDProcessProbe {
    @JvmStatic
    fun main(arguments: Array<String>) {
        require(arguments.size == 3)
        DesktopAppIdentity.configure(arguments[0])
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = Path.of(arguments[1]))
        val startSignal = Path.of(arguments[2])
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (!Files.exists(startSignal)) {
            check(System.nanoTime() < deadline) { "start signal timed out" }
            Thread.sleep(5)
        }
        DesktopDeviceUUIDStore.resetMemoryCacheForTests()
        when (val result = DesktopDeviceUUIDStore.identifier()) {
            is DesktopDeviceUUIDResult.Value -> println("VALUE:${result.uuid}")
            DesktopDeviceUUIDResult.IdentityMissing -> error("identity_missing")
            is DesktopDeviceUUIDResult.PersistenceUnavailable ->
                throw IllegalStateException("persistence_unavailable", result.cause)
        }
    }
}

/** Holds the real OS file lock until the parent releases or kills this JVM. */
object DesktopPersistenceLockHolderProbe {
    @JvmStatic
    fun main(arguments: Array<String>) {
        require(arguments.size == 4)
        DesktopAppIdentity.configure(arguments[0])
        DesktopAppIdentity.setPersistenceTestOverrides(lockRoot = Path.of(arguments[1]))
        val ready = Path.of(arguments[2])
        val release = Path.of(arguments[3])
        when (val result = DesktopAppIdentity.withLockedPreferenceNode("settings") {
            ready.createFile()
            while (!Files.exists(release)) Thread.sleep(5)
            "released"
        }) {
            is DesktopPreferenceAccess.Available -> println("VALUE:${result.value}")
            DesktopPreferenceAccess.IdentityMissing -> error("identity_missing")
            is DesktopPreferenceAccess.PersistenceUnavailable ->
                throw IllegalStateException("persistence_unavailable", result.cause)
        }
    }
}
