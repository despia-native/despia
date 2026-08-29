//
//  filepaths.ts — the shared `files` core: the root vocabulary, the per-platform physical base
//  each token maps to, path normalisation, and the containment check that IS the sandbox. The
//  law is the corpus, OpenSource/Conformance/files/paths.json + errors.json
//  (parity/F03-files.md); the Kotlin twin is :core DSXFilePaths.kt and the Swift twin is
//  Engine/iOS/DSXFilePaths.swift.
//
//  This is a SECURITY boundary, not a convenience. Markup never names an absolute path: it
//  names `root:relative`, and everything a facet is allowed to touch follows from what this
//  file returns. Two halves, and both matter:
//
//    • parseFilePath — the TEXTUAL half. Trim, match the root EXACT CASE against the closed
//      five-word vocabulary, then normalise the relative part (`.` dropped, `..` popped,
//      empty segments collapsed) BEFORE testing for escape, because testing first is the
//      classic bypass. Percent escapes are never decoded into structure: a segment that
//      decodes to a dot segment or to a separator is refused outright.
//    • filePathContains — the PHYSICAL half, asked AFTER the OS has resolved symlinks on both
//      sides. `/a/bc` is not inside `/a/b`; forgetting the separator there is the bug every
//      hand-rolled containment check ships at least once.
//
//  Everything platform-shaped lives OUTSIDE this file. The Files module turns a base token
//  into a real container URL (FileManager / Context.filesDir / OPFS) and does the I/O; keeping
//  the DECISION separate from the PLUMBING is what lets one corpus judge three renderers.
//

/** The closed root vocabulary. A path is `root:relative`, and nothing else is addressable. */
export const FILE_ROOTS: readonly string[] = ["documents", "cache", "temp", "shared", "bundle"];

/** The action surface, shared so a fixture cannot name an action no renderer implements. */
export const FILE_ACTIONS: readonly string[] = [
  "info", "read", "write", "delete", "move", "copy", "mkdir", "list",
  "download", "upload", "free", "hash", "zip", "unzip", "exclude",
];

/** The platforms the base table answers for. */
export const FILE_PLATFORMS: readonly string[] = ["ios", "android", "web"];

/** The physical base each root resolves to, as a platform TOKEN rather than a container path:
 *  the container path is a runtime value, the choice of directory is the decision, and the
 *  decision is what has to agree on three renderers. `null` is the typed absence — that
 *  platform has no such place, so the facet resolves `unsupported_platform`. */
const FILE_BASES: { readonly [root: string]: { readonly [platform: string]: string | null } } = {
  documents: { ios: "Documents", android: "filesDir", web: "opfs" },
  cache: { ios: "Caches", android: "cacheDir", web: "cacheStorage" },
  temp: { ios: "tmp", android: "cacheDir/tmp", web: "memory" },
  shared: { ios: "AppGroup", android: "externalFilesDir", web: null },
  bundle: { ios: "Bundle", android: "assets", web: "origin" },
};

/** The read-only root. A write, mkdir, delete or move-to against it is `permission_denied`. */
const FILE_WRITABLE: { readonly [root: string]: boolean } = {
  documents: true, cache: true, temp: true, shared: true, bundle: false,
};

/** Every code the module settles with, and whether a retry is worth offering. Pinned by
 *  errors.json so `recoverable` cannot mean one thing on one renderer and another elsewhere. */
export const FILE_ERROR_RECOVERABLE: { readonly [code: string]: boolean } = {
  not_found: false,
  permission_denied: false,
  no_space: true,
  is_directory: false,
  not_directory: false,
  exists: true,
  hash_mismatch: true,
  network_failed: true,
  http_error: true,
  unsupported_root: false,
  unsupported_platform: false,
};

/** The typed-absence roster: capabilities a platform genuinely lacks, which resolve
 *  `unsupported_platform` with a real message rather than a silent no-op (durability P4). */
export const FILE_UNSUPPORTED: { readonly [platform: string]: readonly string[] } = {
  ios: [],
  android: ["exclude"],
  web: ["shared", "zip", "unzip", "exclude", "background"],
};

/** A path this module will not address — one condition with one code, whatever shape the
 *  attempt took, because a probing caller learns nothing from a finer distinction. */
export type FilePathRefusal = "unsupported_root";

/** A parsed document path: the root token, and the normalised relative path inside it
 *  (`""` for the root itself). */
export interface ParsedFilePath {
  readonly root: string;
  readonly relative: string;
}

export type FilePathResult =
  | { readonly ok: true; readonly value: ParsedFilePath }
  | { readonly ok: false; readonly error: FilePathRefusal };

const REFUSED: FilePathResult = { ok: false, error: "unsupported_root" };

/** Percent-decode a single segment, tolerantly: a malformed escape stays literal. Used ONLY to
 *  ask whether a segment is hiding structure — the decoded form is never used as a name. */
function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === "%" && i + 2 < segment.length) {
      const hex = segment.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse a `root:relative` document path.
 *
 * The root is matched exact-case against [FILE_ROOTS] — a case-insensitive vocabulary is a
 * vocabulary nobody can lint. The relative part is normalised, then tested for escape; a `..`
 * that stays inside the root is legal and folded away, a `..` that climbs out is refused. A
 * backslash, a colon, a control character, a `~` segment and any percent escape that decodes
 * to a dot segment or a separator are all refused: none of them can name something inside the
 * sandbox, and every one of them is somebody's traversal attempt.
 */
export function parseFilePath(raw: string | null | undefined): FilePathResult {
  const text = (raw ?? "").trim();
  if (text.length === 0) return REFUSED;

  const colon = text.indexOf(":");
  if (colon <= 0) return REFUSED;
  const root = text.slice(0, colon);
  if (!FILE_ROOTS.includes(root)) return REFUSED;

  const rest = text.slice(colon + 1);
  if (hasControlCharacter(rest)) return REFUSED;
  if (rest.includes("\\") || rest.includes(":")) return REFUSED;

  const stack: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return REFUSED;
      stack.pop();
      continue;
    }
    if (segment.startsWith("~")) return REFUSED;
    const decoded = decodeSegment(segment);
    if (decoded === "." || decoded === "..") return REFUSED;
    if (decoded.includes("/") || decoded.includes("\\")) return REFUSED;
    stack.push(segment);
  }
  return { ok: true, value: { root, relative: stack.join("/") } };
}

/** The physical base token for a root on a platform, or `null` when the platform has no such
 *  place (the typed absence). An unknown root or platform is also `null`. */
export function fileRootBase(root: string, platform: string): string | null {
  return FILE_BASES[root]?.[platform] ?? null;
}

/** Whether a root accepts writes. An unknown root is not writable. */
export function fileRootWritable(root: string): boolean {
  return FILE_WRITABLE[root] === true;
}

/** Whether a platform lacks a capability outright (so it resolves `unsupported_platform`). */
export function fileUnsupported(platform: string, capability: string): boolean {
  return (FILE_UNSUPPORTED[platform] ?? []).includes(capability);
}

/** Collapse `.`, `..` and duplicate separators in an ABSOLUTE path. A `..` at the top stays at
 *  the top (POSIX `/..` is `/`). The result keeps its leading `/` and drops any trailing one. */
function normalizeAbsolute(path: string): string {
  const stack: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join("/")}`;
}

/**
 * Is `candidate` inside `base`? Asked after the facet has realpath'd both sides, so a symlink
 * pointing out of the sandbox fails here instead of being followed.
 *
 * Both sides must be absolute. `/a/bc` is NOT inside `/a/b`: the separator is load-bearing, and
 * omitting it is the prefix bug. Comparison is byte-exact — on a case-insensitive filesystem a
 * mismatch means the OS resolved something we did not expect, which is precisely when to refuse.
 */
export function filePathContains(base: string, candidate: string): boolean {
  if (!base.startsWith("/") || !candidate.startsWith("/")) return false;
  const root = normalizeAbsolute(base);
  const target = normalizeAbsolute(candidate);
  if (target === root) return true;
  return root === "/" ? target.startsWith("/") : target.startsWith(`${root}/`);
}

/**
 * `list`'s `glob` filter, matched against the path RELATIVE to the listed directory.
 *
 * A tiny, closed grammar on purpose: `*` matches any run of characters within one segment, `?`
 * matches one character within one segment, and a whole segment of `**` matches zero or more
 * segments. Brace expansion, character classes and negation are deliberately absent — they are
 * where every hand-rolled matcher starts disagreeing with every other, and a listing filter
 * needs none of them. Anchored (the whole relative path) and case-exact.
 */
export function fileGlobMatch(pattern: string, path: string): boolean {
  return matchSegments(pattern.split("/"), path.split("/"), 0, 0);
}

function matchSegments(pattern: string[], path: string[], p: number, i: number): boolean {
  if (p === pattern.length) return i === path.length;
  if (pattern[p] === "**") {
    for (let skip = i; skip <= path.length; skip += 1) {
      if (matchSegments(pattern, path, p + 1, skip)) return true;
    }
    return false;
  }
  if (i === path.length) return false;
  if (!matchSegment(pattern[p]!, path[i]!)) return false;
  return matchSegments(pattern, path, p + 1, i + 1);
}

/** One segment against one segment: `*` is any run, `?` is one character, neither crosses `/`. */
function matchSegment(pattern: string, segment: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < segment.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === segment[s])) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = s;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}
