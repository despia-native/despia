package despia.engine.desktop

import despia.engine.ModuleRegistry
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import java.util.prefs.Preferences

internal sealed interface DesktopPreferenceAccess<out T> {
    data class Available<T>(val value: T, val namespace: String) : DesktopPreferenceAccess<T>
    data object IdentityMissing : DesktopPreferenceAccess<Nothing>
    data class PersistenceUnavailable(internal val cause: Exception) : DesktopPreferenceAccess<Nothing>
}

internal class DesktopPersistenceValueTooLargeException(
    val maximumBytes: Int,
) : IllegalArgumentException("Desktop value exceeds the $maximumBytes-byte UTF-8 limit")

/** App-owned namespace for desktop persistence. Optional packages must never fall
 * back to one framework-global Preferences node: that would merge unrelated apps'
 * settings and turn an installation identifier into a cross-app tracking value. */
object DesktopAppIdentity {
    private const val DEFAULT_LOCK_TIMEOUT_MILLIS = 5_000L
    internal const val MAX_OPAQUE_VALUE_BYTES = 1024 * 1024
    internal const val OPAQUE_VALUE_FILE_NAME = "appsettings.utf8"
    private const val PROPERTY = "dsx.app.id"
    private const val ENVIRONMENT = "DSX_APP_ID"
    // One worker preserves invocation order for read-after-write and consecutive
    // writes. The queue is bounded, so serialization cannot become unbounded load.
    private const val PERSISTENCE_WORKERS = 1
    private const val PERSISTENCE_QUEUE_CAPACITY = 128
    private val pattern = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
    private val areaPattern = Regex("[a-z][a-z0-9-]{0,63}")
    private val processLocks = ConcurrentHashMap<String, ReentrantLock>()
    private val persistenceThreadNumber = AtomicInteger()
    private val persistenceExecutor = ThreadPoolExecutor(
        PERSISTENCE_WORKERS,
        PERSISTENCE_WORKERS,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(PERSISTENCE_QUEUE_CAPACITY),
        { task ->
            Thread(
                task,
                "dsx-desktop-persistence-${persistenceThreadNumber.incrementAndGet()}",
            ).apply { isDaemon = true }
        },
        ThreadPoolExecutor.AbortPolicy(),
    )

    private data class DirectoryIdentity(
        val path: Path,
        val realPath: Path,
        val fileKey: Any?,
        val expectedParentRealPath: Path?,
    )

    private data class LockTarget(
        val path: Path,
        val directoryChain: List<DirectoryIdentity>,
    )

    private data class StorageTarget(
        val path: Path,
        val directoryChain: List<DirectoryIdentity>,
        val parent: DirectoryIdentity,
    )

    @Volatile
    private var preferenceRootProvider: () -> Preferences = { Preferences.userRoot() }

    @Volatile
    private var lockRootOverride: Path? = null

    @Volatile
    private var storageRootOverride: Path? = null

    @Volatile
    private var lockTimeoutMillis: Long = DEFAULT_LOCK_TIMEOUT_MILLIS

    @Volatile
    private var processLockObserverForTests: ((String) -> Unit)? = null

    fun configure(raw: String?) {
        if (raw == null) return
        val value = raw.trim()
        require(pattern.matches(value)) {
            "DSX desktop app id must be 1-128 ASCII letters, digits, dots, underscores, or hyphens"
        }
        System.setProperty(PROPERTY, value)
    }

    fun current(): String? {
        val value = runCatching { System.getProperty(PROPERTY) }.getOrNull()
            ?.trim()?.takeIf(String::isNotEmpty)
            ?: runCatching { System.getenv(ENVIRONMENT) }.getOrNull()?.trim()?.takeIf(String::isNotEmpty)
        return value?.takeIf(pattern::matches)
    }

    /**
     * Runs persistence away from the module/action thread on a deliberately small,
     * bounded daemon pool. A saturated process refuses new work instead of growing
     * an unbounded queue. Callers must convert `false` into a terminal error.
     */
    internal fun submitPersistence(operation: () -> Unit): Boolean = try {
        persistenceExecutor.execute(operation)
        true
    } catch (_: RejectedExecutionException) {
        false
    }

    /** Every public module terminal rejoins the host-installed UI executor. */
    internal fun dispatchPersistenceTerminal(terminal: () -> Unit) {
        ModuleRegistry.shared.mainExecutor.execute(terminal)
    }

    /**
     * Acquires an app-scoped Preferences node without conflating a missing app id
     * with an unavailable persistence backend. Package code must use this result
     * (or [withLockedPreferenceNode]) rather than treating every failure as an
     * identity configuration error.
     */
    internal fun acquirePreferenceNode(area: String): DesktopPreferenceAccess<Preferences> {
        require(areaPattern.matches(area)) { "Invalid DSX desktop preference area" }
        return try {
            val property = System.getProperty(PROPERTY)?.trim()?.takeIf(String::isNotEmpty)
            val appId = property
                ?: System.getenv(ENVIRONMENT)?.trim()?.takeIf(String::isNotEmpty)
                ?: return DesktopPreferenceAccess.IdentityMissing
            if (!pattern.matches(appId)) return DesktopPreferenceAccess.IdentityMissing
            val namespace = namespaceFor(appId)
            DesktopPreferenceAccess.Available(
                preferenceRootProvider().node("/dev/dsx/apps/$namespace/$area"),
                namespace,
            )
        } catch (failure: Exception) {
            DesktopPreferenceAccess.PersistenceUnavailable(failure)
        }
    }

    /** Compatibility accessor for non-critical stores. Persistence-sensitive
     * package code must use the structural acquisition API above. */
    fun preferenceNode(area: String): Preferences? =
        (acquirePreferenceNode(area) as? DesktopPreferenceAccess.Available)?.value

    /**
     * Serializes a Preferences operation across threads and processes belonging
     * to the same OS user. The lock path contains only the app-id hash, is kept
     * below the user's home directory, rejects symbolic links, and is private on
     * POSIX hosts. One deadline covers both the in-process and file-lock waits.
     *
     * `Preferences.sync/flush` are platform calls with no interruptible timeout.
     * This blocking primitive is therefore intentionally internal; public module
     * actions must invoke it only through [submitPersistence], never on the EDT.
     */
    internal fun <T> withLockedPreferenceNode(
        area: String,
        operation: (Preferences) -> T,
    ): DesktopPreferenceAccess<T> = withLockedPersistence(
        area,
        synchronizePreferences = true,
    ) { preferences, _ ->
        operation(preferences)
    }

    /**
     * Reads the ValueStore's single opaque string from its private app directory.
     * A pre-file desktop release stored the value in Preferences; on the first
     * locked read that key is atomically migrated and durably removed.
     */
    internal fun readAppScopedOpaqueValue(
        area: String,
        legacyPreferenceKey: String,
    ): DesktopPreferenceAccess<String> = withLockedPersistence(
        area,
        synchronizePreferences = false,
    ) { preferences, namespace ->
        val target = storageTarget(namespace, area)
        val stored = readStorageFile(target, MAX_OPAQUE_VALUE_BYTES)
        // Preferences can block without a portable deadline. This call is
        // deliberately reached only on the bounded persistence worker. Syncing
        // even when the file exists lets a prior partially completed migration
        // finish removing a durable legacy key on the next access.
        preferences.sync()
        val legacy = preferences.get(legacyPreferenceKey, null)
        if (stored != null) {
            if (legacy != null) removeLegacyPreference(preferences, legacyPreferenceKey)
            stored
        } else if (legacy != null) {
            writeStorageFile(target, encodeOpaqueValue(legacy), MAX_OPAQUE_VALUE_BYTES)
            removeLegacyPreference(preferences, legacyPreferenceKey)
            legacy
        } else ""
    }

    internal fun writeAppScopedOpaqueValue(
        area: String,
        legacyPreferenceKey: String,
        value: String,
    ): DesktopPreferenceAccess<Boolean> = withLockedPersistence(
        area,
        synchronizePreferences = false,
    ) { preferences, namespace ->
        val bytes = encodeOpaqueValue(value)
        val target = storageTarget(namespace, area)
        writeStorageFile(target, bytes, MAX_OPAQUE_VALUE_BYTES)
        // See the blocking contract on withLockedPreferenceNode: always off UI.
        preferences.sync()
        if (preferences.get(legacyPreferenceKey, null) != null) {
            removeLegacyPreference(preferences, legacyPreferenceKey)
        }
        if (readStorageFile(target, MAX_OPAQUE_VALUE_BYTES) != value) {
            throw IllegalStateException("Desktop value was not durably persisted")
        }
        true
    }

    /**
     * Read-decide-write of the app-scoped opaque value inside ONE lock acquisition.
     *
     * [readAppScopedOpaqueValue] followed by [writeAppScopedOpaqueValue] takes the lock twice, so
     * it cannot express "adopt the durable value, or mint one when none exists": two processes
     * both read absent, both mint, and both believe they own the identity they wrote. A caller
     * whose WRITE depends on what it READ needs the decision inside the same critical section.
     *
     * [transform] receives the durable value — null when absent or when only a legacy Preferences
     * key remains — plus the namespace, and returns the value to persist. Returning what was
     * already stored writes nothing. The legacy key is migrated and removed exactly as the
     * read/write pair does, so a caller moving off Preferences keeps existing installs.
     */
    internal fun updateAppScopedOpaqueValue(
        area: String,
        legacyPreferenceKey: String,
        transform: (String?, String) -> String,
    ): DesktopPreferenceAccess<String> = withLockedPersistence(
        area,
        synchronizePreferences = false,
    ) { preferences, namespace ->
        val target = storageTarget(namespace, area)
        val stored = readStorageFile(target, MAX_OPAQUE_VALUE_BYTES)
        // See the blocking contract on withLockedPreferenceNode: always off UI.
        preferences.sync()
        val legacy = preferences.get(legacyPreferenceKey, null)
        val next = transform(stored ?: legacy, namespace)
        if (next != stored) {
            writeStorageFile(target, encodeOpaqueValue(next), MAX_OPAQUE_VALUE_BYTES)
            if (readStorageFile(target, MAX_OPAQUE_VALUE_BYTES) != next) {
                throw IllegalStateException("Desktop value was not durably persisted")
            }
        }
        if (legacy != null) removeLegacyPreference(preferences, legacyPreferenceKey)
        next
    }

    private fun <T> withLockedPersistence(
        area: String,
        synchronizePreferences: Boolean,
        operation: (Preferences, String) -> T,
    ): DesktopPreferenceAccess<T> {
        val acquired = when (val result = acquirePreferenceNode(area)) {
            is DesktopPreferenceAccess.Available -> result
            DesktopPreferenceAccess.IdentityMissing -> return DesktopPreferenceAccess.IdentityMissing
            is DesktopPreferenceAccess.PersistenceUnavailable -> return result
        }
        val processLock = processLocks.computeIfAbsent("${acquired.namespace}:$area") { ReentrantLock() }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(lockTimeoutMillis)
        val initialRemaining = deadline - System.nanoTime()
        if (initialRemaining <= 0L) {
            return DesktopPreferenceAccess.PersistenceUnavailable(
                IllegalStateException("Desktop persistence lock acquisition timed out"),
            )
        }
        val locked = try {
            processLock.tryLock(initialRemaining, TimeUnit.NANOSECONDS)
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
            return DesktopPreferenceAccess.PersistenceUnavailable(
                IllegalStateException("Desktop persistence lock acquisition was interrupted", interrupted),
            )
        }
        if (!locked) {
            return DesktopPreferenceAccess.PersistenceUnavailable(
                IllegalStateException("Desktop in-process persistence lock acquisition timed out"),
            )
        }
        return try {
            processLockObserverForTests?.invoke(area)
            val lockTarget = lockTarget(acquired.namespace, area)
            openPrivateLockChannel(lockTarget).use { channel ->
                acquireBounded(channel, deadline).use {
                    if (synchronizePreferences) {
                        // Preferences implementations cache values per process.
                        // Synchronizing inside the inter-process lock makes the
                        // following read observe the last durable writer.
                        acquired.value.sync()
                    }
                    DesktopPreferenceAccess.Available(
                        operation(acquired.value, acquired.namespace),
                        acquired.namespace,
                    )
                }
            }
        } catch (failure: Exception) {
            DesktopPreferenceAccess.PersistenceUnavailable(failure)
        } finally {
            processLock.unlock()
        }
    }

    internal fun namespaceFor(appId: String): String {
        require(pattern.matches(appId)) { "Invalid DSX desktop app id" }
        return MessageDigest.getInstance("SHA-256")
            .digest(appId.lowercase(Locale.ROOT).toByteArray(StandardCharsets.UTF_8))
            .take(16)
            .joinToString("") { byte -> "%02x".format(Locale.ROOT, byte.toInt() and 0xff) }
    }

    private fun lockTarget(namespace: String, area: String): LockTarget {
        val override = lockRootOverride
        val chain = ArrayList<DirectoryIdentity>()
        val baseIdentity = if (override != null) {
            val base = requireAbsoluteNormalized(override)
            val parent = directoryIdentity(
                base.parent ?: throw IllegalStateException("Desktop persistence directory has no parent"),
            )
            chain += parent
            ensurePrivateDirectory(base, parent.realPath)
        } else {
            val homeRaw = System.getProperty("user.home")?.trim().orEmpty()
            if (homeRaw.isEmpty()) throw IllegalStateException("Desktop persistence requires a user home")
            val home = requireAbsoluteNormalized(Path.of(homeRaw))
            // A configured home is an OS/JVM trust anchor and is legitimately a
            // symlink on many Linux, NFS, and managed macOS installations. Resolve
            // it once, then enforce no-link/no-reparse containment on every child.
            val homeIdentity = trustedDirectoryAnchor(home)
            chain += homeIdentity
            val dsxIdentity = ensurePrivateDirectory(homeIdentity.path.resolve(".dsx"), homeIdentity.realPath)
            chain += dsxIdentity
            ensurePrivateDirectory(dsxIdentity.path.resolve("persistence-locks"), dsxIdentity.realPath)
        }
        chain += baseIdentity
        val appIdentity = ensurePrivateDirectory(baseIdentity.path.resolve(namespace), baseIdentity.realPath)
        chain += appIdentity
        verifyDirectoryChain(chain)
        return LockTarget(appIdentity.path.resolve("$area.lock"), chain)
    }

    private fun storageTarget(namespace: String, area: String): StorageTarget {
        val override = storageRootOverride
        val chain = ArrayList<DirectoryIdentity>()
        val baseIdentity = if (override != null) {
            val base = requireAbsoluteNormalized(override)
            val parent = directoryIdentity(
                base.parent ?: throw IllegalStateException("Desktop persistence directory has no parent"),
            )
            chain += parent
            ensurePrivateDirectory(base, parent.realPath)
        } else {
            val homeRaw = System.getProperty("user.home")?.trim().orEmpty()
            if (homeRaw.isEmpty()) throw IllegalStateException("Desktop persistence requires a user home")
            val homeIdentity = trustedDirectoryAnchor(requireAbsoluteNormalized(Path.of(homeRaw)))
            chain += homeIdentity
            val dsxIdentity = ensurePrivateDirectory(homeIdentity.path.resolve(".dsx"), homeIdentity.realPath)
            chain += dsxIdentity
            ensurePrivateDirectory(dsxIdentity.path.resolve("apps"), dsxIdentity.realPath)
        }
        chain += baseIdentity
        val appIdentity = ensurePrivateDirectory(baseIdentity.path.resolve(namespace), baseIdentity.realPath)
        chain += appIdentity
        val areaIdentity = ensurePrivateDirectory(appIdentity.path.resolve(area), appIdentity.realPath)
        chain += areaIdentity
        verifyDirectoryChain(chain)
        return StorageTarget(
            path = areaIdentity.path.resolve(OPAQUE_VALUE_FILE_NAME),
            directoryChain = chain,
            parent = areaIdentity,
        )
    }

    private fun requireAbsoluteNormalized(path: Path): Path {
        val absolute = path.toAbsolutePath().normalize()
        if (absolute != path.toAbsolutePath()) {
            throw IllegalArgumentException("Desktop persistence path must be normalized")
        }
        return absolute
    }

    private fun trustedDirectoryAnchor(path: Path): DirectoryIdentity {
        val normalized = requireAbsoluteNormalized(path)
        val real = normalized.toRealPath()
        val attributes = Files.readAttributes(
            real,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (!attributes.isDirectory || attributes.isSymbolicLink || Files.isSymbolicLink(real)) {
            throw IllegalStateException("Desktop persistence home is unsafe")
        }
        return DirectoryIdentity(real, real, attributes.fileKey(), expectedParentRealPath = null)
    }

    private fun ensurePrivateDirectory(path: Path, expectedParentRealPath: Path): DirectoryIdentity {
        try {
            Files.createDirectory(
                path,
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")),
            )
        } catch (_: UnsupportedOperationException) {
            try {
                Files.createDirectory(path)
            } catch (_: FileAlreadyExistsException) {
                // Validated below.
            }
        } catch (_: FileAlreadyExistsException) {
            // Validated below.
        }
        directoryIdentity(path, expectedParentRealPath)
        Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
            ?.setPermissions(PosixFilePermissions.fromString("rwx------"))
        return directoryIdentity(path, expectedParentRealPath)
    }

    private fun directoryIdentity(path: Path, expectedParentRealPath: Path? = null): DirectoryIdentity {
        val normalized = requireAbsoluteNormalized(path)
        val attributes = Files.readAttributes(
            normalized,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (!attributes.isDirectory || attributes.isSymbolicLink || Files.isSymbolicLink(normalized)) {
            throw IllegalStateException("Desktop persistence directory is unsafe")
        }
        val real = normalized.toRealPath()
        if (expectedParentRealPath != null) {
            val expectedReal = expectedParentRealPath.resolve(normalized.fileName.toString()).normalize()
            if (real != expectedReal) {
                // Reject Windows junction/reparse traversal as well as ordinary
                // symbolic-link ancestry, even when isSymbolicLink is incomplete.
                throw IllegalStateException("Desktop persistence directory escapes its parent")
            }
        }
        return DirectoryIdentity(normalized, real, attributes.fileKey(), expectedParentRealPath)
    }

    private fun verifyDirectoryChain(chain: List<DirectoryIdentity>) {
        chain.forEach { expected ->
            val current = directoryIdentity(expected.path, expected.expectedParentRealPath)
            if (current.realPath != expected.realPath ||
                (expected.fileKey != null && current.fileKey != null && current.fileKey != expected.fileKey)
            ) {
                throw IllegalStateException("Desktop persistence directory changed during lock acquisition")
            }
        }
    }

    private fun encodeOpaqueValue(value: String): ByteArray {
        if (value.length > MAX_OPAQUE_VALUE_BYTES) {
            throw DesktopPersistenceValueTooLargeException(MAX_OPAQUE_VALUE_BYTES)
        }
        val encoded = StandardCharsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(value))
        if (encoded.remaining() > MAX_OPAQUE_VALUE_BYTES) {
            throw DesktopPersistenceValueTooLargeException(MAX_OPAQUE_VALUE_BYTES)
        }
        val bytes = ByteArray(encoded.remaining())
        encoded.get(bytes)
        return bytes
    }

    private fun decodeOpaqueValue(bytes: ByteArray): String = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

    private fun readStorageFile(target: StorageTarget, maximumBytes: Int): String? {
        verifyDirectoryChain(target.directoryChain)
        val path = target.path
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return null
        val expected = regularFileIdentity(path, target.parent.realPath, maximumBytes)
        FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
            verifyDirectoryChain(target.directoryChain)
            val current = regularFileIdentity(path, target.parent.realPath, maximumBytes)
            if (expected.fileKey() != null && current.fileKey() != null && expected.fileKey() != current.fileKey()) {
                throw IllegalStateException("Desktop value file changed during read")
            }
            val channelSize = channel.size()
            if (channelSize < 0L || channelSize > maximumBytes.toLong()) {
                throw IllegalStateException("Desktop value file exceeds its bounded size")
            }
            val buffer = ByteBuffer.allocate(maximumBytes + 1)
            while (buffer.hasRemaining()) {
                val count = channel.read(buffer)
                if (count < 0) break
                if (count == 0) Thread.yield()
            }
            if (buffer.position() > maximumBytes || (buffer.position() == maximumBytes + 1)) {
                throw IllegalStateException("Desktop value file exceeds its bounded size")
            }
            if (!buffer.hasRemaining()) {
                throw IllegalStateException("Desktop value file exceeds its bounded size")
            }
            val bytes = ByteArray(buffer.position())
            buffer.flip()
            buffer.get(bytes)
            return decodeOpaqueValue(bytes)
        }
    }

    private fun writeStorageFile(target: StorageTarget, bytes: ByteArray, maximumBytes: Int) {
        if (bytes.size > maximumBytes) {
            throw DesktopPersistenceValueTooLargeException(maximumBytes)
        }
        verifyDirectoryChain(target.directoryChain)
        rejectUnsafeExistingFile(target.path, target.parent.realPath, maximumBytes)
        val temporary = target.parent.path.resolve(
            ".${target.path.fileName}.tmp-${UUID.randomUUID()}",
        )
        try {
            createNewPrivateDataChannel(temporary).use { channel ->
                val buffer = ByteBuffer.wrap(bytes)
                while (buffer.hasRemaining()) {
                    if (channel.write(buffer) <= 0) {
                        throw IllegalStateException("Desktop value file write made no progress")
                    }
                }
                channel.force(true)
            }
            verifyDirectoryChain(target.directoryChain)
            regularFileIdentity(temporary, target.parent.realPath, maximumBytes)
            rejectUnsafeExistingFile(target.path, target.parent.realPath, maximumBytes)
            Files.move(
                temporary,
                target.path,
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            verifyDirectoryChain(target.directoryChain)
            regularFileIdentity(target.path, target.parent.realPath, maximumBytes)
            Files.getFileAttributeView(
                target.path,
                PosixFileAttributeView::class.java,
                LinkOption.NOFOLLOW_LINKS,
            )?.setPermissions(PosixFilePermissions.fromString("rw-------"))
        } finally {
            // The randomized path is always a child of a verified private test/app
            // directory. Delete only that exact entry and never recurse.
            runCatching { Files.deleteIfExists(temporary) }
        }
    }

    private fun rejectUnsafeExistingFile(path: Path, expectedParentRealPath: Path, maximumBytes: Int) {
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            regularFileIdentity(path, expectedParentRealPath, maximumBytes)
        }
    }

    private fun regularFileIdentity(
        path: Path,
        expectedParentRealPath: Path,
        maximumBytes: Int,
    ): BasicFileAttributes {
        val attributes = Files.readAttributes(
            path,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (!attributes.isRegularFile || attributes.isSymbolicLink || Files.isSymbolicLink(path)) {
            throw IllegalStateException("Desktop value file is unsafe")
        }
        if (attributes.size() < 0L || attributes.size() > maximumBytes.toLong()) {
            throw IllegalStateException("Desktop value file exceeds its bounded size")
        }
        val expectedReal = expectedParentRealPath.resolve(path.fileName.toString()).normalize()
        if (path.toRealPath() != expectedReal) {
            throw IllegalStateException("Desktop value file escapes its private directory")
        }
        return attributes
    }

    private fun createNewPrivateDataChannel(path: Path): FileChannel = try {
        FileChannel.open(
            path,
            setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")),
        )
    } catch (_: UnsupportedOperationException) {
        FileChannel.open(
            path,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS,
        )
    }

    private fun removeLegacyPreference(preferences: Preferences, key: String) {
        preferences.remove(key)
        preferences.flush()
        preferences.sync()
        if (preferences.get(key, null) != null) {
            throw IllegalStateException("Legacy desktop value was not durably removed")
        }
    }

    private fun openPrivateLockChannel(target: LockTarget): FileChannel {
        // Java exposes no portable FileChannel open-at-directory-handle primitive,
        // especially on Windows. Snapshotting every controlled ancestor by real
        // path + file key before and after the no-follow open closes ordinary
        // junction/symlink replacement races. The remaining same-account hostile
        // mutation case is the Preferences store's own trust boundary: code running
        // as the app's OS user can also edit that user's preference backend.
        verifyDirectoryChain(target.directoryChain)
        val path = target.path
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS) &&
            (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
        ) {
            throw IllegalStateException("Desktop persistence lock is unsafe")
        }
        val existingFileKey = if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS).fileKey()
        } else null
        val channel = if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            openExistingLockChannel(path)
        } else {
            try {
                createNewLockChannel(path)
            } catch (_: FileAlreadyExistsException) {
                if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                    throw IllegalStateException("Desktop persistence lock is unsafe")
                }
                openExistingLockChannel(path)
            }
        }
        try {
            verifyDirectoryChain(target.directoryChain)
            if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                throw IllegalStateException("Desktop persistence lock is unsafe")
            }
            val currentFileKey = Files.readAttributes(
                path,
                BasicFileAttributes::class.java,
                LinkOption.NOFOLLOW_LINKS,
            ).fileKey()
            if (existingFileKey != null && currentFileKey != null && existingFileKey != currentFileKey) {
                throw IllegalStateException("Desktop persistence lock changed during acquisition")
            }
            val parentReal = target.directoryChain.last().realPath
            if (path.toRealPath() != parentReal.resolve(path.fileName.toString()).normalize()) {
                throw IllegalStateException("Desktop persistence lock escapes its private directory")
            }
            Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
                ?.setPermissions(PosixFilePermissions.fromString("rw-------"))
            return channel
        } catch (failure: Exception) {
            channel.close()
            throw failure
        }
    }

    private fun createNewLockChannel(path: Path): FileChannel = try {
        FileChannel.open(
            path,
            setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")),
        )
    } catch (_: UnsupportedOperationException) {
        // Some Windows providers reject POSIX creation attributes. Retry only
        // without that attribute; NOFOLLOW_LINKS and CREATE_NEW remain mandatory,
        // so an unsupported no-follow guarantee fails closed.
        FileChannel.open(
            path,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS,
        )
    }

    private fun openExistingLockChannel(path: Path): FileChannel = FileChannel.open(
        path,
        StandardOpenOption.WRITE,
        LinkOption.NOFOLLOW_LINKS,
    )

    private fun acquireBounded(channel: FileChannel, deadline: Long): FileLock {
        while (true) {
            if (deadline - System.nanoTime() <= 0L) {
                throw IllegalStateException("Desktop persistence lock acquisition timed out")
            }
            channel.tryLock()?.let { return it }
            try {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0L) {
                    throw IllegalStateException("Desktop persistence lock acquisition timed out")
                }
                TimeUnit.NANOSECONDS.sleep(minOf(remaining, TimeUnit.MILLISECONDS.toNanos(10)))
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                throw IllegalStateException("Desktop persistence lock acquisition was interrupted", interrupted)
            }
        }
    }

    internal fun setPersistenceTestOverrides(
        rootProvider: (() -> Preferences)? = null,
        lockRoot: Path? = null,
        storageRoot: Path? = null,
        timeoutMillis: Long = DEFAULT_LOCK_TIMEOUT_MILLIS,
        processLockObserver: ((String) -> Unit)? = null,
    ) {
        require(timeoutMillis > 0) { "Desktop persistence lock timeout must be positive" }
        preferenceRootProvider = rootProvider ?: { Preferences.userRoot() }
        lockRootOverride = lockRoot
        storageRootOverride = storageRoot ?: lockRoot?.toAbsolutePath()?.normalize()?.parent?.resolve("app-data")
        lockTimeoutMillis = timeoutMillis
        processLockObserverForTests = processLockObserver
        processLocks.clear()
    }
}
