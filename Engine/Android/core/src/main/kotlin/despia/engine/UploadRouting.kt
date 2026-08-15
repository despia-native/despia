package despia.engine

/**
 * UploadRouting.kt — the file-input routing decision, Kotlin twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/upload/routing.json; the cases run
 * against THIS file (:core UploadRoutingConformanceTest), against the TS twin
 * (packages/kernel/src/upload.ts) and against the Swift twin (DSXFileUploadPolicy.route).
 *
 * Pure: an `accept`/`capture` hint in, a route out. The pickers themselves are each platform's
 * business; what a page ASKED FOR is the same question everywhere, so it is answered once.
 */

enum class CameraMediaScope(val word: String) {
    IMAGES_ONLY("imagesOnly"),
    VIDEOS_ONLY("videosOnly"),
    BOTH("both"),
}

sealed class FilePickerRoute(val word: String) {
    data class Camera(val front: Boolean, val scope: CameraMediaScope) : FilePickerRoute("camera")
    data class PhotoLibrary(val scope: CameraMediaScope) : FilePickerRoute("photoLibrary")
    data class Documents(val types: List<String>) : FilePickerRoute("documents")
    object SourceSheet : FilePickerRoute("sourceSheet")
}

object UploadRouting {

    /**
     * The comma-separated `accept` list, normalized. Empty entries and stray whitespace are the
     * norm in hand-written markup (`accept="image/∗, .pdf,"`), never a reason to misroute.
     */
    fun acceptEntries(accept: String?): List<String> =
        (accept ?: "").lowercase().split(",").map { it.trim() }.filter { it.isNotEmpty() }

    /**
     * The media scope an `accept` list implies. BOTH is the honest answer for an EMPTY accept (the
     * page asked for anything) and for a MIXED one (`image/∗,video/∗` genuinely wants the toggle).
     */
    fun cameraMediaScope(accept: String?): CameraMediaScope {
        val entries = acceptEntries(accept)
        if (entries.isEmpty()) return CameraMediaScope.BOTH
        if (entries.all { it.startsWith("image/") }) return CameraMediaScope.IMAGES_ONLY
        if (entries.all { it.startsWith("video/") }) return CameraMediaScope.VIDEOS_ONLY
        return CameraMediaScope.BOTH
    }

    /** True when every entry is media the image/video pickers can actually serve. */
    fun isMediaOnly(accept: String?): Boolean {
        val entries = acceptEntries(accept)
        return entries.isNotEmpty() && entries.all { it.startsWith("image/") || it.startsWith("video/") }
    }

    /**
     * The whole routing decision.
     *
     * `capture` wins when present and meaningful — the page explicitly asked for a camera — and the
     * scope still narrows what that camera may return, which is the fix for the PHOTO/VIDEO toggle
     * on a stills-only input. Otherwise a media-only accept narrows the library, a non-media accept
     * opens a document picker (the only one that can enforce those types), and no usable hint falls
     * back to the sheet — which is also where `native_overwrite=false` deliberately lands.
     */
    fun route(accept: String?, capture: String?, nativeInterception: Boolean = true): FilePickerRoute {
        if (!nativeInterception) return FilePickerRoute.SourceSheet

        val scope = cameraMediaScope(accept)
        when (capture?.lowercase()) {
            "environment" -> return FilePickerRoute.Camera(front = false, scope = scope)
            "user" -> return FilePickerRoute.Camera(front = true, scope = scope)
        }

        val entries = acceptEntries(accept)
        if (entries.isEmpty()) return FilePickerRoute.SourceSheet
        if (isMediaOnly(accept)) {
            // A mixed image+video accept has no narrowing to apply, so the sheet (camera AND
            // library) is a better answer than an un-narrowed library.
            return if (scope == CameraMediaScope.BOTH) FilePickerRoute.SourceSheet
            else FilePickerRoute.PhotoLibrary(scope)
        }
        return FilePickerRoute.Documents(entries)
    }
}
