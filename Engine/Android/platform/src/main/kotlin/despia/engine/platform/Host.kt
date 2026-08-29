//
//  Host.kt — the app's Android identity: the Application it runs in, and the Activity on screen.
//
//  THE ASYMMETRY THIS CLOSES. iOS modules reach their host through `UIApplication.shared` and
//  `UIApplication.topViewController()`, kernel primitives that name no package. Android had no
//  twin, so every module that needed a Context or an Activity walked there from Dom's exported
//  web view:
//
//      var c = (dsx.module["dom"].`object`("view") as? View)?.context
//      while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
//
//  That was safe while Dom was Mandatory and shipped in every build. It stopped being safe on
//  2026-08-21, when Dom moved to Core/Dom and became excludable: measured, 104 call sites across
//  88 module files resolved a Context that way, so in a Dom-less native app the camera, the
//  clipboard, haptics, biometrics, location, permissions and the rest found NULL and went
//  quietly inert. The app builds, links no WebKit, launches, and most of its OS surface does
//  nothing. Nothing throws, so nothing is reported.
//
//  So the host comes from the platform that owns it. `install` is called once by the host with
//  the Application; ActivityLifecycleCallbacks track the resumed one.
//
//  BOTH HALVES ARE HERE BECAUSE BOTH ARRIVE FROM ONE CALL, and because the choice between them
//  is the thing callers get wrong. `application` outlives every screen and is what long-lived
//  work must hold; `activity` is what presenting needs and must never be cached. Splitting them
//  across two objects would mean two installs and no place to state the rule.
//
//  THE ACTIVITY IS WEAK, cleared on destroy, because a static strong reference to an Activity is
//  the oldest leak on this platform. The Application is a strong reference and that is correct:
//  it is a process-lifetime singleton, so there is nothing to leak it past.
//
//  NAMES NO PACKAGE, which is what lets it live in the kernel at all (constitution Article 3).
//  It answers "where am I running" and nothing else. A module that wants a Window, a
//  PackageManager, a Resources or a decor view derives it from here.
//

package despia.engine.platform

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import java.lang.ref.WeakReference

object DSXHost {

    @Volatile
    private var app: Application? = null

    @Volatile
    private var resumed: WeakReference<Activity>? = null

    @Volatile
    private var installed = false

    /// The process-wide Context. Available from `Application.onCreate` until the process dies,
    /// including while backgrounded and before any Activity exists — which is exactly when
    /// scheduled work, notification channels and preference stores run.
    val application: Application?
        get() = app

    /// The Activity currently on screen, or null before the first one resumes and after the last
    /// one is destroyed. Callers must treat null as "not now" rather than "never": it is the
    /// honest answer during boot and while backgrounded, and code that presents UI should give up
    /// rather than invent a Context that cannot show anything.
    val activity: Activity?
        get() = resumed?.get()

    /// The best Context available, preferring the Activity so themed inflation, dialogs and
    /// `startActivity` behave. Use this where either will do; use `activity` where only an
    /// Activity will, and `application` where the work outlives the screen.
    ///
    /// NEVER CACHE THE RESULT: it is an Activity most of the time, and a field holding one is a
    /// leak. Call it at the point of use.
    val context: Context?
        get() = activity ?: app

    /// Seeded once by the host at boot. Idempotent, because a second install would double every
    /// callback and a host that grows a second entry point should not have to know that.
    fun install(application: Application) {
        if (installed) return
        installed = true
        app = application
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                resumed = WeakReference(activity)
            }

            override fun onActivityDestroyed(activity: Activity) {
                if (resumed?.get() === activity) resumed = null
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        })
    }

    /// Test seam. The JVM suites have no Application, and a gate that cannot arrange "an Activity
    /// is on screen" cannot test the modules that depend on one.
    fun seedForTesting(activity: Activity?, application: Application? = null) {
        resumed = activity?.let { WeakReference(it) }
        if (application != null) app = application
    }
}
