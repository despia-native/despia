/**
 * upload.ts — the file-input routing decision, TS twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/upload/routing.json; the cases run
 * against THIS file, against the Kotlin twin (:core UploadRouting.kt) and against the Swift twin
 * (DSXFileUploadPolicy.route).
 *
 * Pure: an `accept`/`capture` hint in, a route out. The pickers themselves are each platform's
 * business; what a page ASKED FOR is the same question everywhere, so it is answered once.
 */

export type CameraMediaScope = 'imagesOnly' | 'videosOnly' | 'both';

export type FilePickerRoute =
  | { route: 'camera'; front: boolean; scope: CameraMediaScope }
  | { route: 'photoLibrary'; scope: CameraMediaScope }
  | { route: 'documents'; types: string[] }
  | { route: 'sourceSheet' };

/**
 * The comma-separated `accept` list, normalized. Empty entries and stray whitespace are the norm
 * in hand-written markup (`accept="image/*, .pdf,"`), never a reason to misroute.
 */
export function acceptEntries(accept: string | null | undefined): string[] {
  return String(accept ?? '')
    .toLowerCase()
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The media scope an `accept` list implies. `both` is the honest answer for an EMPTY accept (the
 * page asked for anything) and for a MIXED one (`image/*,video/*` genuinely wants the toggle).
 */
export function cameraMediaScope(accept: string | null | undefined): CameraMediaScope {
  const entries = acceptEntries(accept);
  if (entries.length === 0) return 'both';
  if (entries.every((e) => e.startsWith('image/'))) return 'imagesOnly';
  if (entries.every((e) => e.startsWith('video/'))) return 'videosOnly';
  return 'both';
}

/** True when every entry is media the image/video pickers can actually serve. */
export function isMediaOnly(accept: string | null | undefined): boolean {
  const entries = acceptEntries(accept);
  return entries.length > 0 && entries.every((e) => e.startsWith('image/') || e.startsWith('video/'));
}

/**
 * The whole routing decision.
 *
 * `capture` wins when present and meaningful — the page explicitly asked for a camera — and the
 * scope still narrows what that camera may return, which is the fix for the PHOTO/VIDEO toggle on
 * a stills-only input. Otherwise a media-only accept narrows the library, a non-media accept opens
 * a document picker (the only one that can enforce those types), and no usable hint falls back to
 * the sheet — which is also where `native_overwrite=false` deliberately lands every input.
 */
export function routeFilePicker(input: {
  accept: string | null | undefined;
  capture: string | null | undefined;
  nativeInterception?: boolean;
}): FilePickerRoute {
  if (input.nativeInterception === false) return { route: 'sourceSheet' };

  const scope = cameraMediaScope(input.accept);
  const capture = String(input.capture ?? '').toLowerCase();
  if (capture === 'environment' || capture === 'user') {
    return { route: 'camera', front: capture === 'user', scope };
  }

  const entries = acceptEntries(input.accept);
  if (entries.length === 0) return { route: 'sourceSheet' };
  if (isMediaOnly(input.accept)) {
    // A mixed image+video accept has no narrowing to apply, so the sheet (camera AND library) is
    // a better answer than an un-narrowed library.
    return scope === 'both' ? { route: 'sourceSheet' } : { route: 'photoLibrary', scope };
  }
  return { route: 'documents', types: entries };
}
