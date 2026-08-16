package despia.engine.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import despia.engine.JSE
import despia.engine.writeBound
import java.io.Closeable
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.JComponent
import javafx.application.Platform as FxPlatform
import javafx.embed.swing.JFXPanel
import javafx.geometry.Pos
import javafx.scene.Scene
import javafx.scene.layout.StackPane
import javafx.scene.media.Media
import javafx.scene.media.MediaException
import javafx.scene.media.MediaPlayer
import javafx.scene.media.MediaView
import javafx.scene.shape.Rectangle
import javafx.util.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.max

private const val DESKTOP_MEDIA_BUNDLED_MAX_BYTES = 64L * 1024L * 1024L
private const val DESKTOP_MEDIA_TICK_MILLIS = 250L
private const val DESKTOP_MEDIA_LOAD_TIMEOUT_MILLIS = 15_000L
private const val DESKTOP_MEDIA_EXTERNAL_SEEK_SECONDS = 0.75
private const val DESKTOP_MEDIA_POSITION_EPSILON = 0.0001

@Composable
internal fun DesktopNativeAudio(context: DesktopElementContext, modifier: Modifier) {
    DesktopNativeMedia(context, modifier, video = false)
}

@Composable
internal fun DesktopNativeVideo(context: DesktopElementContext, modifier: Modifier) {
    DesktopNativeMedia(context, modifier, video = true)
}

private sealed interface DesktopPreparedMediaState {
    data object Loading : DesktopPreparedMediaState
    data class Ready(val source: DesktopPreparedMedia) : DesktopPreparedMediaState
    data class Failure(val reason: String) : DesktopPreparedMediaState
}

private data class DesktopMediaKeys(
    val paused: String?,
    val position: String?,
    val time: String?,
    val duration: String?,
    val buffering: String?,
    val scrubbing: String?,
)

private data class DesktopMediaConfiguration(
    val active: Boolean,
    val autoplay: Boolean,
    val loop: Boolean,
    val muted: Boolean,
    val speed: Double,
    val start: Double,
    val gravity: String,
    val pausedKeyPresent: Boolean,
    val paused: Boolean,
    val scrubbing: Boolean,
)

private data class DesktopFxMediaSnapshot(
    val ready: Boolean = false,
    val failed: Boolean = false,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val time: Double = 0.0,
    val duration: Double = 0.0,
    val buffered: Double = 0.0,
)

private sealed interface DesktopFxMediaEvent {
    data object Ready : DesktopFxMediaEvent
    data object Ended : DesktopFxMediaEvent
    data class Error(val message: String) : DesktopFxMediaEvent
}

/** Shared native audio/video element. The JavaFX player is a platform-native decoder
 * (Media Foundation on Windows, bundled GStreamer-lite on Linux) hosted by SwingPanel;
 * it is not a WebView and exposes no decoder chrome. All remote subrequests remain behind
 * DesktopMediaGateway, including HLS playlists and Range seeks. */
@Composable
private fun DesktopNativeMedia(context: DesktopElementContext, modifier: Modifier, video: Boolean) {
    val source = context.value("src")?.trim().orEmpty()
    val reload = context.value("reload")?.let(JSE::number)?.takeIf(Double::isFinite) ?: 0.0
    val preparedState by produceState<DesktopPreparedMediaState>(
        DesktopPreparedMediaState.Loading,
        source,
        reload,
        video,
    ) {
        if (source.isEmpty()) {
            value = DesktopPreparedMediaState.Failure("Source is missing")
            return@produceState
        }
        val prepared = try {
            withContext(Dispatchers.IO) { prepareDesktopMediaSource(source, video) }
        } catch (failure: Throwable) {
            value = DesktopPreparedMediaState.Failure(safeDesktopMediaPlaybackFailure(failure))
            return@produceState
        }
        value = DesktopPreparedMediaState.Ready(prepared)
        // The producer owns the prepared gateway/temp file. This closes it even if
        // composition is cancelled between publishing Ready and mounting the player.
        try {
            awaitCancellation()
        } finally {
            prepared.close()
        }
    }
    DisposableEffect(preparedState) {
        onDispose { (preparedState as? DesktopPreparedMediaState.Ready)?.source?.close() }
    }

    when (val prepared = preparedState) {
        DesktopPreparedMediaState.Loading -> if (video) {
            Box(
                desktopMediaSize(modifier, context.attributes, 240f),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp) }
        } else {
            Box(Modifier.size(0.dp))
        }
        is DesktopPreparedMediaState.Failure -> {
            LaunchedEffect(prepared.reason, context.attributes["on:error"]) {
                context.attributes["on:error"]?.let { context.run(it, mapOf("message" to prepared.reason)) }
            }
            if (video) {
                DesktopMediaStateCard(
                    desktopMediaSize(modifier, context.attributes, 240f),
                    context.attributes,
                    "Video unavailable",
                    prepared.reason,
                    "No remote media bytes reached an unmediated decoder",
                    240f,
                )
            } else {
                // Canonical <audio> is headless; errors travel through on:error.
                Box(Modifier.size(0.dp))
            }
        }
        is DesktopPreparedMediaState.Ready -> DesktopMountedNativeMedia(
            context = context,
            modifier = modifier,
            video = video,
            prepared = prepared.source,
        )
    }
}

@Composable
private fun DesktopMountedNativeMedia(
    context: DesktopElementContext,
    modifier: Modifier,
    video: Boolean,
    prepared: DesktopPreparedMedia,
) {
    val session = remember(prepared, video) { DesktopFxMediaSession(prepared, video) }
    DisposableEffect(session) { onDispose { session.close() } }
    val latestContext by rememberUpdatedState(context)
    val keys = DesktopMediaKeys(
        paused = context.value("paused")?.takeIf(String::isNotBlank),
        position = context.value("bind")?.takeIf(String::isNotBlank),
        time = context.value("time")?.takeIf(String::isNotBlank),
        duration = context.value("duration")?.takeIf(String::isNotBlank),
        buffering = context.value("buffering")?.takeIf(String::isNotBlank),
        scrubbing = context.value("scrubbing")?.takeIf(String::isNotBlank),
    )
    val configuration = DesktopMediaConfiguration(
        active = if (video) desktopMediaBool(context.value("active"), true) else true,
        autoplay = desktopMediaBool(context.value("autoplay"), true),
        loop = desktopMediaBool(context.value("loop"), false),
        muted = desktopMediaBool(context.value("muted"), false),
        speed = (context.value("speed")?.let(JSE::number) ?: 1.0).takeIf(Double::isFinite) ?: 1.0,
        start = (context.value("start")?.let(JSE::number) ?: 0.0).takeIf(Double::isFinite)?.coerceAtLeast(0.0) ?: 0.0,
        gravity = context.value("gravity").takeIf { it == "fit" } ?: "fill",
        pausedKeyPresent = keys.paused != null,
        paused = keys.paused?.let { JSE.truthy(JSE.eval(it, context.store, context.item)) } == true,
        scrubbing = keys.scrubbing?.let { JSE.truthy(JSE.eval(it, context.store, context.item)) } == true,
    )
    val latestKeys by rememberUpdatedState(keys)
    val latestConfiguration by rememberUpdatedState(configuration)

    LaunchedEffect(session, configuration) { session.apply(configuration) }
    LaunchedEffect(session) {
        val coordinator = DesktopMediaBindingCoordinator()
        var loadElapsed = 0L
        var timeoutDelivered = false
        // Canonical active loads publish an immediate zero readout; duration is corrected
        // once the decoder reports the actual asset duration.
        if (latestConfiguration.active) {
            latestKeys.time?.let { latestContext.writeDesktopMedia(it, 0.0) }
            latestKeys.duration?.let { latestContext.writeDesktopMedia(it, 0.0) }
        }
        while (isActive) {
            delay(DESKTOP_MEDIA_TICK_MILLIS)
            val currentContext = latestContext
            val currentKeys = latestKeys
            val currentConfiguration = latestConfiguration
            val snapshot = session.snapshot()
            session.drainEvents().forEach { event ->
                when (event) {
                    DesktopFxMediaEvent.Ready -> {
                        coordinator.adoptBoundPosition(currentContext, currentKeys)
                        currentContext.attributes["on:ready"]?.let { currentContext.run(it) }
                    }
                    DesktopFxMediaEvent.Ended -> currentContext.attributes["on:ended"]?.let { currentContext.run(it) }
                    is DesktopFxMediaEvent.Error -> currentContext.attributes["on:error"]?.let {
                        currentContext.run(it, mapOf("message" to event.message))
                    }
                }
            }
            if (!snapshot.ready && !snapshot.failed && currentConfiguration.active) {
                loadElapsed += DESKTOP_MEDIA_TICK_MILLIS
                if (loadElapsed >= DESKTOP_MEDIA_LOAD_TIMEOUT_MILLIS && !timeoutDelivered) {
                    timeoutDelivered = true
                    session.failLoadTimeout()
                }
            }
            coordinator.tick(currentContext, currentKeys, currentConfiguration, snapshot, session)
        }
    }

    if (video) {
        val sized = desktopMediaSize(modifier, context.attributes, 240f)
            .semantics { contentDescription = context.value("a11yLabel") ?: "Video" }
        SwingPanel(
            background = Color.Transparent,
            factory = { session.panel },
            modifier = sized,
            update = { session.apply(configuration) },
        )
    } else {
        // Keep a mounted JFXPanel so the native audio graph remains alive while preserving
        // the canonical zero-sized, author-owned-controls surface.
        Box(Modifier.size(0.dp)) {
            SwingPanel(
                background = Color.Transparent,
                factory = { session.panel },
                modifier = Modifier.fillMaxSize(),
                update = { session.apply(configuration) },
            )
        }
    }
}

private class DesktopMediaBindingCoordinator {
    private var lastSelfFraction = -1.0
    private var lastSecond = -1
    private var lastDuration = -1.0
    private var lastBuffering: Boolean? = null
    private var wasScrubbing = false
    private var wasActive = true
    private var seekTarget: Double? = null
    private var seekTicks = 0

    fun adoptBoundPosition(context: DesktopElementContext, keys: DesktopMediaKeys) {
        lastSelfFraction = keys.position?.let { JSE.number(JSE.eval(it, context.store, context.item)) } ?: 0.0
    }

    fun tick(
        context: DesktopElementContext,
        keys: DesktopMediaKeys,
        configuration: DesktopMediaConfiguration,
        snapshot: DesktopFxMediaSnapshot,
        session: DesktopFxMediaSession,
    ) {
        if (!configuration.active) {
            wasActive = false
            return
        }
        if (!wasActive) {
            wasActive = true
            lastSecond = -1
            lastDuration = -1.0
            val fraction = mediaFraction(snapshot)
            lastSelfFraction = fraction
            keys.position?.let { context.writeDesktopMedia(it, fraction) }
        }
        val buffering = snapshot.buffering && !configuration.paused
        if (buffering != lastBuffering) {
            lastBuffering = buffering
            keys.buffering?.let { context.writeDesktopMedia(it, buffering) }
        }
        if (!snapshot.ready || snapshot.duration <= 0.0) return
        if (abs(snapshot.duration - lastDuration) > 0.01) {
            lastDuration = snapshot.duration
            keys.duration?.let { context.writeDesktopMedia(it, snapshot.duration) }
        }
        if (configuration.scrubbing != wasScrubbing) {
            wasScrubbing = configuration.scrubbing
            if (!configuration.scrubbing) {
                val target = keys.position?.let { JSE.number(JSE.eval(it, context.store, context.item)) }
                if (target != null && target.isFinite()) beginSeek(target.coerceIn(0.0, 1.0), session)
            }
        }
        val pendingTarget = seekTarget
        if (pendingTarget != null) {
            seekTicks += 1
            if (abs(mediaFraction(snapshot) - pendingTarget) <= 0.002 || seekTicks >= 8) {
                seekTarget = null
                seekTicks = 0
            }
            return
        }
        if (configuration.scrubbing) return

        val fraction = mediaFraction(snapshot)
        val key = keys.position
        if (key != null) {
            val bound = JSE.number(JSE.eval(key, context.store, context.item))
            if (bound != null && bound.isFinite() && bound != lastSelfFraction &&
                abs(bound.coerceIn(0.0, 1.0) * snapshot.duration - snapshot.time) > DESKTOP_MEDIA_EXTERNAL_SEEK_SECONDS
            ) {
                beginSeek(bound.coerceIn(0.0, 1.0), session)
                return
            }
            if (bound == null || abs(bound - fraction) > DESKTOP_MEDIA_POSITION_EPSILON) {
                lastSelfFraction = fraction
                context.writeDesktopMedia(key, fraction)
            }
        }
        val second = snapshot.time.toInt()
        if (second != lastSecond) {
            lastSecond = second
            keys.time?.let { context.writeDesktopMedia(it, snapshot.time) }
            context.attributes["on:timeupdate"]?.let {
                context.run(it, mapOf("time" to snapshot.time, "duration" to snapshot.duration))
            }
        }
    }

    private fun beginSeek(fraction: Double, session: DesktopFxMediaSession) {
        lastSelfFraction = fraction
        seekTarget = fraction
        seekTicks = 0
        session.seekFraction(fraction)
    }

    private fun mediaFraction(snapshot: DesktopFxMediaSnapshot): Double =
        if (snapshot.duration <= 0.0) 0.0 else (snapshot.time / snapshot.duration).coerceIn(0.0, 1.0)
}

private class DesktopPreparedMedia(
    val mediaUri: String,
    private val gateway: DesktopMediaGateway?,
    private val temporary: Path?,
) : Closeable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        gateway?.close()
        temporary?.let { runCatching { Files.deleteIfExists(it) } }
    }
}

private fun prepareDesktopMediaSource(source: String, video: Boolean): DesktopPreparedMedia {
    val isRemote = source.startsWith("https://", ignoreCase = true) ||
        source.startsWith("http://", ignoreCase = true)
    if (isRemote) {
        val gateway = DesktopMediaGateway.start(source)
        return DesktopPreparedMedia(gateway.url, gateway, null)
    }
    val suffixes = if (video) {
        listOf("", ".mp4", ".m4v")
    } else {
        listOf("", ".mp3", ".m4a", ".aac", ".wav")
    }
    val bytes = loadDesktopAsset(source, suffixes, DESKTOP_MEDIA_BUNDLED_MAX_BYTES)
        ?: throw IllegalArgumentException("asset_missing")
    val authoredExtension = source.substringAfterLast('.', "").lowercase()
        .takeIf { it.matches(Regex("[a-z0-9]{1,8}")) }
    val extension = authoredExtension ?: if (video) "mp4" else "mp3"
    val temporary = Files.createTempFile("dsx-media-", ".$extension")
    try {
        runCatching {
            Files.setPosixFilePermissions(
                temporary,
                setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
            )
        }
        Files.write(temporary, bytes)
        temporary.toFile().deleteOnExit()
        return DesktopPreparedMedia(temporary.toUri().toASCIIString(), null, temporary)
    } catch (failure: Throwable) {
        runCatching { Files.deleteIfExists(temporary) }
        throw failure
    }
}

private class DesktopFxMediaSession(
    private val prepared: DesktopPreparedMedia,
    private val video: Boolean,
) : Closeable {
    private val fxPanel = JFXPanel().apply { isOpaque = false }
    val panel: JComponent get() = fxPanel
    private val closed = AtomicBoolean(false)
    private val state = AtomicReference(DesktopFxMediaSnapshot())
    private val events = ConcurrentLinkedQueue<DesktopFxMediaEvent>()
    private val root = StackPane()
    private val mediaView = if (video) MediaView() else null
    private var player: MediaPlayer? = null
    private var media: Media? = null
    private var configuration: DesktopMediaConfiguration? = null
    private var failureDelivered = false
    private var ready = false

    init {
        runFx {
            if (desktopFxToolkitConfigured.compareAndSet(false, true)) FxPlatform.setImplicitExit(false)
            root.style = "-fx-background-color: transparent;"
            root.alignment = Pos.CENTER
            mediaView?.let { view ->
                view.isSmooth = true
                root.children.setAll(view)
                val clip = Rectangle()
                clip.widthProperty().bind(root.widthProperty())
                clip.heightProperty().bind(root.heightProperty())
                root.clip = clip
                root.widthProperty().addListener { _, _, _ -> updateGeometry() }
                root.heightProperty().addListener { _, _, _ -> updateGeometry() }
            }
            fxPanel.scene = Scene(root).apply { fill = javafx.scene.paint.Color.TRANSPARENT }
            mountPlayer()
        }
    }

    fun snapshot(): DesktopFxMediaSnapshot = state.get()

    fun drainEvents(): List<DesktopFxMediaEvent> = buildList {
        while (true) add(events.poll() ?: break)
    }

    fun apply(next: DesktopMediaConfiguration) = runFx {
        val previous = configuration
        configuration = next
        val current = player ?: return@runFx
        current.cycleCount = if (next.loop) MediaPlayer.INDEFINITE else 1
        current.isMute = next.muted || !next.active
        val rate = next.speed.takeIf { it.isFinite() && it > 0.0 }?.coerceIn(0.125, 8.0) ?: 1.0
        if (abs(current.rate - rate) > 0.001) current.rate = rate
        updateGeometry()
        if (!ready) return@runFx
        when {
            !next.active -> current.pause()
            next.scrubbing -> Unit // The clock keeps running while the authored scrubber owns bind.
            next.pausedKeyPresent && next.paused -> current.pause()
            next.pausedKeyPresent && !next.paused -> current.play()
            previous != null && !previous.active && next.active && next.autoplay -> {
                val fraction = mediaFractionFx(current)
                if (fraction >= 0.999) current.seek(Duration.ZERO)
                current.play()
            }
        }
    }

    fun seekFraction(fraction: Double) = runFx {
        val current = player ?: return@runFx
        val duration = finiteSeconds(current.totalDuration)
        if (duration > 0.0) current.seek(Duration.seconds(fraction.coerceIn(0.0, 1.0) * duration))
    }

    fun failLoadTimeout() = runFx {
        if (ready || failureDelivered || closed.get()) return@runFx
        fail("media load timed out")
        player?.stop()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        // Network and file ownership ends synchronously with Compose disposal. FX UI
        // cleanup may be queued, but a stalled toolkit cannot keep the gateway alive.
        prepared.close()
        runFx(allowClosed = true) {
            runCatching { mediaView?.mediaPlayer = null }
            runCatching { player?.stop() }
            runCatching { player?.dispose() }
            player = null
            media = null
            root.children.clear()
            fxPanel.scene = null
        }
    }

    private fun mountPlayer() {
        if (closed.get()) return
        try {
            val mountedMedia = Media(prepared.mediaUri)
            media = mountedMedia
            mountedMedia.setOnError { fail(mediaErrorMessage(mountedMedia.error)) }
            mountedMedia.widthProperty().addListener { _, _, _ -> updateGeometry() }
            mountedMedia.heightProperty().addListener { _, _, _ -> updateGeometry() }
            val mountedPlayer = MediaPlayer(mountedMedia)
            player = mountedPlayer
            mediaView?.mediaPlayer = mountedPlayer
            mountedPlayer.isAutoPlay = false
            mountedPlayer.setOnError { fail(mediaErrorMessage(mountedPlayer.error)) }
            mountedPlayer.setOnHalted { fail("native media playback halted") }
            mountedPlayer.setOnReady {
                if (closed.get() || ready) return@setOnReady
                ready = true
                updateSnapshot(mountedPlayer)
                events += DesktopFxMediaEvent.Ready
                val desired = configuration
                if (desired != null) {
                    if (desired.start > 0.0) {
                        val maximum = finiteSeconds(mountedPlayer.totalDuration)
                        mountedPlayer.seek(Duration.seconds(if (maximum > 0.0) desired.start.coerceAtMost(maximum) else desired.start))
                    }
                    val shouldPlay = desired.active &&
                        (if (desired.pausedKeyPresent) !desired.paused else desired.autoplay)
                    if (shouldPlay) mountedPlayer.play()
                }
            }
            mountedPlayer.setOnEndOfMedia {
                if (configuration?.loop != true) events += DesktopFxMediaEvent.Ended
                updateSnapshot(mountedPlayer)
            }
            mountedPlayer.currentTimeProperty().addListener { _, _, _ -> updateSnapshot(mountedPlayer) }
            mountedPlayer.totalDurationProperty().addListener { _, _, _ -> updateSnapshot(mountedPlayer) }
            mountedPlayer.bufferProgressTimeProperty().addListener { _, _, _ -> updateSnapshot(mountedPlayer) }
            mountedPlayer.statusProperty().addListener { _, _, _ -> updateSnapshot(mountedPlayer) }
            updateGeometry()
        } catch (failure: Throwable) {
            fail(mediaErrorMessage(failure))
        }
    }

    private fun updateSnapshot(current: MediaPlayer) {
        val status = current.status
        state.set(
            DesktopFxMediaSnapshot(
                ready = ready,
                failed = failureDelivered,
                playing = status == MediaPlayer.Status.PLAYING,
                buffering = status == MediaPlayer.Status.STALLED,
                time = finiteSeconds(current.currentTime),
                duration = finiteSeconds(current.totalDuration),
                buffered = finiteSeconds(current.bufferProgressTime),
            ),
        )
    }

    private fun fail(message: String) {
        if (failureDelivered || closed.get()) return
        failureDelivered = true
        state.set(state.get().copy(failed = true, buffering = false))
        events += DesktopFxMediaEvent.Error(message)
    }

    private fun updateGeometry() {
        val view = mediaView ?: return
        val desired = configuration?.gravity ?: "fill"
        val width = root.width
        val height = root.height
        if (width <= 0.0 || height <= 0.0) return
        val mediaWidth = media?.width?.toDouble()?.takeIf { it > 0.0 }
        val mediaHeight = media?.height?.toDouble()?.takeIf { it > 0.0 }
        if (desired == "fit" || mediaWidth == null || mediaHeight == null) {
            view.isPreserveRatio = true
            view.fitWidth = width
            view.fitHeight = height
        } else {
            val scale = max(width / mediaWidth, height / mediaHeight)
            view.isPreserveRatio = false
            view.fitWidth = mediaWidth * scale
            view.fitHeight = mediaHeight * scale
        }
    }

    private fun runFx(allowClosed: Boolean = false, block: () -> Unit) {
        if (closed.get() && !allowClosed) return
        if (FxPlatform.isFxApplicationThread()) block() else runCatching { FxPlatform.runLater(block) }
            .onFailure {
                if (allowClosed) {
                    prepared.close()
                } else if (!closed.get()) {
                    prepared.close()
                    state.set(state.get().copy(failed = true))
                    events += DesktopFxMediaEvent.Error("native media runtime unavailable")
                }
            }
    }

}

private fun DesktopElementContext.writeDesktopMedia(key: String, value: Any) {
    if (key.isBlank()) return
    val previous = JSE.eval(key, store, item)
    val unchanged = previous == value || previous is Number && value is Number &&
        abs(previous.toDouble() - value.toDouble()) < 0.0000001
    if (!unchanged) store.writeBound(key, value)
}

private fun finiteSeconds(duration: Duration?): Double = duration?.toSeconds()
    ?.takeIf { it.isFinite() && it >= 0.0 } ?: 0.0

private fun mediaFractionFx(player: MediaPlayer): Double {
    val duration = finiteSeconds(player.totalDuration)
    return if (duration <= 0.0) 0.0 else (finiteSeconds(player.currentTime) / duration).coerceIn(0.0, 1.0)
}

private fun mediaErrorMessage(failure: Throwable?): String = when (failure) {
    is MediaException -> when (failure.type) {
        MediaException.Type.MEDIA_UNAVAILABLE -> "media is unavailable"
        MediaException.Type.MEDIA_UNSUPPORTED -> "media format is unsupported"
        MediaException.Type.MEDIA_INACCESSIBLE -> "media could not be accessed"
        MediaException.Type.MEDIA_CORRUPTED -> "media is corrupted"
        MediaException.Type.PLAYBACK_ERROR -> "native media playback failed"
        else -> "native media initialization failed"
    }
    else -> "native media initialization failed"
}

private fun safeDesktopMediaPlaybackFailure(failure: Throwable): String {
    val message = generateSequence(failure) { it.cause }.mapNotNull(Throwable::message).firstOrNull().orEmpty()
    return when {
        message.contains("asset_missing") -> "Bundled media asset was not found"
        message.contains("InvalidURL") -> "Media source was blocked by DSX transport policy"
        message.contains("byte limit") || message.contains("exceeds") -> "Media exceeds the configured byte budget"
        else -> "Media source could not be prepared"
    }
}

private val desktopFxToolkitConfigured = AtomicBoolean(false)
