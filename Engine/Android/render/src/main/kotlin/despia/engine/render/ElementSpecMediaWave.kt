//
//  ElementSpecMediaWave.kt — the MEDIA wave of the element parity registry: the <video> and
//  <audio> element specs. Fixtures: OpenSource/Conformance/elements/video.json + audio.json,
//  extracted line-by-line from the Swift reference renderers
//  (ClosedSource/DSX/Modules/Mandatory/Foundation/Components/Media/Video/Video.swift and
//  …/Media/Audio/AudioElement.swift — the AVPlayer half of the cross-platform contract the
//  Android ExoPlayer renderer mirrors 1:1; the Video dsx.json pins that AVPlayer ⇄ ExoPlayer
//  pairing explicitly).
//
//  Registration follows ElementSpec.kt's header rules: the specs register from
//  registerBuiltins() (the single registerMediaWaveSpecs() call line after
//  registerInputWave()), and every constant is single-sourced HERE — referenced by BOTH the
//  spec registrations below and the element implementation
//  (ClosedSource/DSX/Modules/Mandatory/Foundation/kotlin/FoundationMedia.kt). That facet is
//  a module `kotlin/` folder compiling in :app, OUTSIDE :render's module boundary, which is
//  why MediaElementDefaults is public where ElementDefaults stays internal: the facet must
//  read the same numbers or spec and implementation could drift apart (header rule 3).
//
//  The fixtures pin NO geometry and NO colors — the media elements draw no chrome (controls
//  are DSX; <audio> is headless by contract), so the parity surface is the attribute table.
//  Implementation-only constants (tick cadence, publish epsilons, the load-timeout window,
//  the Android unsized frame) live in MediaElementDefaults too but stay OUT of the specs —
//  they are behavior, not fixture-pinned contract (header rule 4).
//

package despia.engine.render

/// The single source for every constant the <video>/<audio> implementations hardcode —
/// referenced by BOTH the Foundation facet composables (FoundationMedia.kt) and the
/// ElementSpec registrations below, so spec and implementation cannot drift apart.
/// Values mirror the Swift reference (the fixtures' `_src` lines cite the exact origin).
object MediaElementDefaults {
    // ── fixture-pinned attribute defaults (video.json / audio.json) ──
    const val AUTOPLAY = true                  // Video.swift:74 / AudioElement.swift:58
    const val ACTIVE = true                    // Video.swift:73 (video only — pager multi-mount)
    const val LOOP = false                     // Video.swift:75 / AudioElement.swift:59
    const val MUTED = false                    // Video.swift:76 / AudioElement.swift:60
    const val VIDEO_GRAVITY = "fill"           // Video.swift:77 (fill | fit)
    const val SPEED = 1.0                      // Video.swift:78 / AudioElement.swift:61
    const val START = 0.0                      // Video.swift:79 / AudioElement.swift:62
    const val SUBTITLES = false                // Video.swift:80 (video only)
    const val RELOAD = 0.0                     // Video.swift:81 / AudioElement.swift:63
    const val VIDEO_AUDIO_SESSION = "ambient"  // Video.swift:82 — claims playback ONLY when "playback"
    const val AUDIO_SESSION = "playback"       // AudioElement.swift:64 — "ambient" opts out
    const val PIP = false                      // Video.swift:83 (video only)
    const val NOW_PLAYING = false              // Video.swift:84 / AudioElement.swift:65
    const val VIDEO_REMOTE_SKIP = 5.0          // Video.swift:87
    const val AUDIO_REMOTE_SKIP = 15.0         // AudioElement.swift:68

    // ── implementation constants (behavior, NOT in the specs — header rule 4) ──
    const val TICK_MS = 250L                   // Video.swift:246 — the 4 Hz periodic observer
    const val LOAD_TIMEOUT_MS = 15_000L        // Video.swift:383 — the bad-CDN guard window
    const val POSITION_EPSILON = 0.02          // Video.swift:274 — `bind` publishes on >0.02 change
    const val DURATION_EPSILON = 0.5           // Video.swift:262 — duration republish threshold (s)
    const val EXTERNAL_SEEK_SECONDS = 0.75     // Video.swift:502 — an external write moving the clock >0.75s is a seek
    const val RESTART_FRACTION = 0.995         // Video.swift:437 — a re-activated FINISHED clip restarts

    // Android chrome (not in the fixture): the unsized default frame — fillMaxWidth × this
    // height, the <chart>/<map> precedent (on iOS the UIViewRepresentable takes SwiftUI's
    // proposed size; markup sizes explicitly with height=/grow=).
    const val VIDEO_UNSIZED_HEIGHT = 240.0
}

/// The MEDIA wave (the <video>/<audio> cross-platform contract — Foundation/Components/Media),
/// alphabetical. Constants single-sourced from MediaElementDefaults; the fixtures' `_src`
/// lines cite the Swift origin of every default. Called ONLY from ElementSpecs.registerBuiltins().
internal fun registerMediaWaveSpecs() {
    val d = MediaElementDefaults
    fun canonBool(b: Boolean) = if (b) "true" else "false"
    ElementSpecs.register(ElementSpec("audio",
        attributes = mapOf(
            "src" to null,
            "autoplay" to canonBool(d.AUTOPLAY),
            "loop" to canonBool(d.LOOP),
            "muted" to canonBool(d.MUTED),
            "speed" to ElementSpecs.canon(d.SPEED),
            "start" to ElementSpecs.canon(d.START),
            "reload" to ElementSpecs.canon(d.RELOAD),
            "session" to d.AUDIO_SESSION,
            "nowPlaying" to canonBool(d.NOW_PLAYING),
            "nowTitle" to null,
            "nowArtist" to null,
            "remoteSkip" to ElementSpecs.canon(d.AUDIO_REMOTE_SKIP),
            "paused" to null,
            "bind" to null,
            "time" to null,
            "duration" to null,
            "buffering" to null,
            "scrubbing" to null,
        )))
    ElementSpecs.register(ElementSpec("video",
        attributes = mapOf(
            "src" to null,
            "active" to canonBool(d.ACTIVE),
            "autoplay" to canonBool(d.AUTOPLAY),
            "loop" to canonBool(d.LOOP),
            "muted" to canonBool(d.MUTED),
            "gravity" to d.VIDEO_GRAVITY,
            "speed" to ElementSpecs.canon(d.SPEED),
            "start" to ElementSpecs.canon(d.START),
            "subtitles" to canonBool(d.SUBTITLES),
            "reload" to ElementSpecs.canon(d.RELOAD),
            "audio" to d.VIDEO_AUDIO_SESSION,
            "pip" to canonBool(d.PIP),
            "nowPlaying" to canonBool(d.NOW_PLAYING),
            "nowTitle" to null,
            "nowArtist" to null,
            "remoteSkip" to ElementSpecs.canon(d.VIDEO_REMOTE_SKIP),
            "paused" to null,
            "bind" to null,
            "time" to null,
            "duration" to null,
            "buffering" to null,
            "scrubbing" to null,
            "preview" to null,
        )))
}
