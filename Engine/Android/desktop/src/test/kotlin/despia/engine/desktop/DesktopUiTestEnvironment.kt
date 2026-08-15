package despia.engine.desktop

import org.junit.jupiter.api.Assumptions

/**
 * Gate for the Skiko-backed desktop UI tests (the `*UiTest` classes that call
 * `runSkikoComposeUiTest`). They render the real Compose/Skia scene and assert
 * pixels, geometry, focus and input. On a headless CI runner there is no GPU —
 * Skiko falls back to software rendering ("Cannot create Linux GL context") — so
 * pixel-exact assertions are unstable AND some scenes block indefinitely, which
 * previously ran the desktop release lanes into their 60-minute job timeout the
 * first time packaging reached `:desktop:test`.
 *
 * These tests are therefore SKIPPED on CI (GitHub Actions sets `CI=true`) and run
 * normally on a developer machine or any real display. Force them on with
 * `DSX_DESKTOP_UI_TESTS=1` (e.g. a self-hosted runner that has a GPU).
 *
 * The display-free tests (`desktopSelfTest`, `desktopDemoSelfTest`, the pure
 * renderer/contract/host tests) are unaffected and keep running in CI.
 */
internal object DesktopUiTestEnvironment {
    val renderable: Boolean = when {
        System.getenv("DSX_DESKTOP_UI_TESTS") == "1" -> true
        System.getenv("CI") == "true" -> false
        else -> true
    }

    /** Skip the calling test (reported, not failed) when real Skiko rendering is unavailable. */
    fun assumeRenderable() = Assumptions.assumeTrue(
        renderable,
        "Skiko desktop UI rendering is unstable on headless CI; runs locally or with DSX_DESKTOP_UI_TESTS=1.",
    )
}
