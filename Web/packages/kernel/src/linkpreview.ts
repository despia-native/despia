//
//  linkpreview.ts — the SHARED PURE CORE behind Core/Preview (F17.1): what a rich link
//  preview IS, decided once and run identically by all three renderers.
//
//  WHY A PURE CORE AT ALL. Every chat, bookmark and notes app writes its own OG scraper, and
//  every one of them disagrees on the same four questions: which tag wins when a page ships
//  both `og:title` and `<title>`, what a relative `og:image` resolves against, what counts as
//  a fetchable URL, and how many bytes you are allowed to read before giving up. Those four
//  answers are the product. They are pinned in OpenSource/Conformance/preview/metadata.json
//  and this file is the reference implementation; Engine/iOS/LinkPreview.swift and
//  :core LinkPreview.kt are the twins.
//
//  WHAT IS DELIBERATELY NOT HERE: the fetch. Reading bytes off a network is platform plumbing
//  and lives in each module facet. The BUDGET for that fetch is here, because a 256 KB cap
//  that only two of three renderers honour is not a cap.
//
//  NO PLATFORM URL CLASS. `URL` in TypeScript, `java.net.URI` and `Foundation.URL` disagree on
//  empty paths, backslashes, uppercase hosts and userinfo. A preview that resolves to a
//  different origin on one renderer is exactly the bug this core exists to prevent, so the
//  parser and the relative-reference resolver are written out longhand and corpus-pinned.
//

/** A single response ceiling. An unbounded read of an attacker-chosen URL is a memory
 *  exhaustion primitive, and the head is all a preview ever needs. */
export const PREVIEW_MAX_BYTES = 262144;

/** Redirect chains terminate. Five is what browsers and curl converge on. */
export const PREVIEW_MAX_REDIRECTS = 5;

export const PREVIEW_DEFAULT_TIMEOUT_MS = 8000;
export const PREVIEW_MIN_TIMEOUT_MS = 1000;
export const PREVIEW_MAX_TIMEOUT_MS = 30000;

/** Why a URL was refused before a single byte moved. */
export type PreviewRefusal = "invalid_url" | "unsupported_scheme" | "credentials_in_url";

/** A validated fetch target, split the way every renderer needs it. */
export interface PreviewTarget {
  /** the normalized absolute URL — lowercase scheme and host, default port dropped */
  readonly url: string;
  /** `scheme://host[:port]` — the only origin a relative reference may resolve into */
  readonly origin: string;
  /** host[:port], lowercase */
  readonly host: string;
  /** `http` or `https`, lowercase */
  readonly scheme: string;
  /** path, always leading-slash; query and fragment excluded */
  readonly path: string;
}

export interface LinkPreview {
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly siteName: string;
  readonly favicon: string;
  readonly type: string;
  readonly canonical: string;
}

export type PreviewResult<T> = { ok: true; value: T } | { ok: false; error: PreviewRefusal };

/** Clamp an author-supplied timeout into the band the module will actually honour. A value
 *  outside the band is clamped rather than refused: a caller asking for 5 minutes wants
 *  "as long as you can", not an error. */
export function clampPreviewTimeout(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PREVIEW_DEFAULT_TIMEOUT_MS;
  if (n < PREVIEW_MIN_TIMEOUT_MS) return PREVIEW_MIN_TIMEOUT_MS;
  if (n > PREVIEW_MAX_TIMEOUT_MS) return PREVIEW_MAX_TIMEOUT_MS;
  return Math.round(n);
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*$/;

function defaultPortFor(scheme: string): string {
  return scheme === "https" ? "443" : "80";
}

/**
 * Parse and normalize an absolute http(s) URL.
 *
 * Refuses, loudly and before the network:
 *  • anything that is not http or https — `file:`, `data:` and custom schemes are how a
 *    preview scraper becomes a local-file exfiltration gadget;
 *  • userinfo (`https://user:pass@host/`) — the credential would be logged, cached and
 *    handed to a redirect target.
 */
export function resolvePreviewTarget(raw: unknown): PreviewResult<PreviewTarget> {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (input.length === 0) return { ok: false, error: "invalid_url" };

  const colon = input.indexOf(":");
  if (colon <= 0) return { ok: false, error: "invalid_url" };
  const scheme = input.slice(0, colon).toLowerCase();
  if (!SCHEME_RE.test(scheme)) return { ok: false, error: "invalid_url" };
  if (scheme !== "http" && scheme !== "https") return { ok: false, error: "unsupported_scheme" };
  if (input.slice(colon + 1, colon + 3) !== "//") return { ok: false, error: "invalid_url" };

  const rest = input.slice(colon + 3);
  let cut = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i]!;
    if (c === "/" || c === "?" || c === "#" || c === "\\") { cut = i; break; }
  }
  let authority = rest.slice(0, cut);
  const tail = rest.slice(cut);

  if (authority.includes("@")) return { ok: false, error: "credentials_in_url" };
  if (authority.length === 0) return { ok: false, error: "invalid_url" };

  let port = "";
  const portCut = authority.lastIndexOf(":");
  // A bracketed IPv6 literal carries colons of its own; the port colon is after the `]`.
  const bracketEnd = authority.lastIndexOf("]");
  if (portCut > bracketEnd && portCut >= 0) {
    port = authority.slice(portCut + 1);
    authority = authority.slice(0, portCut);
    if (port.length > 0 && !/^[0-9]+$/.test(port)) return { ok: false, error: "invalid_url" };
  }
  const host = authority.toLowerCase();
  if (host.length === 0) return { ok: false, error: "invalid_url" };
  if (/[\s<>"{}|^`]/.test(host)) return { ok: false, error: "invalid_url" };
  if (port === defaultPortFor(scheme)) port = "";

  const hostPort = port.length > 0 ? `${host}:${port}` : host;
  const origin = `${scheme}://${hostPort}`;

  let pathAndTail = tail.replace(/\\/g, "/");
  if (pathAndTail.length === 0 || (pathAndTail[0] !== "/" && pathAndTail[0] !== "?" && pathAndTail[0] !== "#")) {
    pathAndTail = `/${pathAndTail}`;
  }
  if (pathAndTail[0] === "?" || pathAndTail[0] === "#") pathAndTail = `/${pathAndTail}`;

  let path = pathAndTail;
  const qCut = path.search(/[?#]/);
  if (qCut >= 0) path = path.slice(0, qCut);
  if (path.length === 0) path = "/";
  path = normalizePreviewPath(path);

  const suffix = qCut >= 0 ? pathAndTail.slice(qCut) : "";
  return { ok: true, value: { url: `${origin}${path}${suffix}`, origin, host: hostPort, scheme, path } };
}

/** RFC 3986 §5.2.4 remove_dot_segments, restricted to the absolute-path case we ever hold. */
export function normalizePreviewPath(path: string): string {
  const out: string[] = [];
  const trailing = path.endsWith("/") || path.endsWith("/.") || path.endsWith("/..");
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { out.pop(); continue; }
    out.push(segment);
  }
  let result = `/${out.join("/")}`;
  if (trailing && result !== "/") result += "/";
  return result;
}

/**
 * Resolve a reference found in a document against the document's own URL.
 *
 * Returns "" for anything that cannot become an absolute http(s) URL — an empty href, a
 * `javascript:` handler, a `data:` blob. "" is the typed absence for every string field in a
 * LinkPreview, so a hostile page cannot smuggle a scheme through the image slot.
 */
export function resolvePreviewReference(base: PreviewTarget, ref: unknown): string {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (value.length === 0) return "";

  if (value.startsWith("//")) {
    const absolute = resolvePreviewTarget(`${base.scheme}:${value}`);
    return absolute.ok ? absolute.value.url : "";
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(value)) {
    const absolute = resolvePreviewTarget(value);
    return absolute.ok ? absolute.value.url : "";
  }
  if (value.startsWith("#")) return `${base.origin}${base.path}${value}`;
  if (value.startsWith("?")) return `${base.origin}${base.path}${value}`;
  if (value.startsWith("/")) {
    const cut = value.search(/[?#]/);
    const rawPath = cut >= 0 ? value.slice(0, cut) : value;
    const suffix = cut >= 0 ? value.slice(cut) : "";
    return `${base.origin}${normalizePreviewPath(rawPath)}${suffix}`;
  }

  const cut = value.search(/[?#]/);
  const rawPath = cut >= 0 ? value.slice(0, cut) : value;
  const suffix = cut >= 0 ? value.slice(cut) : "";
  const dir = base.path.slice(0, base.path.lastIndexOf("/") + 1);
  return `${base.origin}${normalizePreviewPath(`${dir}${rawPath}`)}${suffix}`;
}

// ── the document scan ────────────────────────────────────────────────────────────────

/** What a scan of a document head found, before precedence is applied. */
export interface PreviewTags {
  /** `<meta property|name=…>` → content, keyed by the LOWERCASED property */
  readonly meta: Readonly<Record<string, string>>;
  /** `<link rel=…>` → href, keyed by the LOWERCASED rel; first occurrence wins */
  readonly links: Readonly<Record<string, string>>;
  /** the `<title>` element's text, entity-decoded and collapsed */
  readonly documentTitle: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
};

/** Decode the entity set a real page actually uses in a title. Unknown entities are left
 *  verbatim rather than dropped: `AT&T` written badly must not become `ATT`. */
export function decodePreviewEntities(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const amp = input.indexOf("&", i);
    if (amp < 0) { out += input.slice(i); break; }
    out += input.slice(i, amp);
    const semi = input.indexOf(";", amp);
    if (semi < 0 || semi - amp > 10) { out += "&"; i = amp + 1; continue; }
    const body = input.slice(amp + 1, semi);
    let decoded: string | null = null;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) decoded = String.fromCodePoint(code);
    } else if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) decoded = String.fromCodePoint(code);
    } else {
      const named = NAMED_ENTITIES[body.toLowerCase()];
      if (named !== undefined) decoded = named;
    }
    if (decoded === null) { out += "&"; i = amp + 1; continue; }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

/** Collapse the whitespace a hand-written `<title>` carries across three source lines. */
export function collapsePreviewText(input: string): string {
  return input.replace(/[\s\u00a0]+/g, " ").trim();
}

/** Case-insensitive forward search. A `toLowerCase()` copy of the document would change its
 *  LENGTH for some Unicode, drifting every index against the Kotlin and Swift twins. */
function indexOfCI(haystack: string, needle: string, from: number): number {
  const n = haystack.length;
  const m = needle.length;
  const lowered = needle.toLowerCase();
  for (let i = Math.max(0, from); i + m <= n; i += 1) {
    let hit = true;
    for (let k = 0; k < m; k += 1) {
      if (haystack[i + k]!.toLowerCase() !== lowered[k]) { hit = false; break; }
    }
    if (hit) return i;
  }
  return -1;
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/**
 * Scan a document for its preview tags. Deliberately NOT a DOM parse: this runs over the
 * first 256 KB of an untrusted response on three runtimes, so it is a forward character
 * scan that never backtracks, never executes anything, and stops the moment `<body>` or
 * `</head>` proves there is nothing left worth reading.
 *
 * FIRST OCCURRENCE WINS for every key. A page that ships `og:image` twice means the first
 * one; the alternative (last wins) lets an injected comment thread override the publisher.
 */
export function scanPreviewTags(html: string): PreviewTags {
  const meta: Record<string, string> = {};
  const links: Record<string, string> = {};
  let documentTitle = "";

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;

    if (html.startsWith("!--", i)) {
      const end = html.indexOf("-->", i + 3);
      i = end < 0 ? n : end + 3;
      continue;
    }
    let closing = false;
    if (html[i] === "/") { closing = true; i += 1; }

    let nameEnd = i;
    while (nameEnd < n && !isSpace(html[nameEnd]!) && html[nameEnd] !== ">" && html[nameEnd] !== "/") nameEnd += 1;
    const tag = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;

    if (closing) {
      // `</head>` ends the region we care about; everything after it is page content.
      if (tag === "head") break;
      const gt = html.indexOf(">", i);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    const attrs: Record<string, string> = {};
    while (i < n) {
      while (i < n && isSpace(html[i]!)) i += 1;
      if (i >= n) break;
      if (html[i] === ">") { i += 1; break; }
      if (html[i] === "/" && html[i + 1] === ">") { i += 2; break; }
      let keyEnd = i;
      while (keyEnd < n && !isSpace(html[keyEnd]!) && html[keyEnd] !== "=" && html[keyEnd] !== ">") keyEnd += 1;
      const key = html.slice(i, keyEnd).toLowerCase();
      i = keyEnd;
      while (i < n && isSpace(html[i]!)) i += 1;
      let value = "";
      if (html[i] === "=") {
        i += 1;
        while (i < n && isSpace(html[i]!)) i += 1;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          i += 1;
          const end = html.indexOf(quote, i);
          value = end < 0 ? html.slice(i) : html.slice(i, end);
          i = end < 0 ? n : end + 1;
        } else {
          let end = i;
          while (end < n && !isSpace(html[end]!) && html[end] !== ">") end += 1;
          value = html.slice(i, end);
          i = end;
        }
      }
      if (key.length > 0 && attrs[key] === undefined) attrs[key] = decodePreviewEntities(value);
    }

    if (tag === "body") break;

    if (tag === "title") {
      const close = indexOfCI(html, "</title", i);
      const text = close < 0 ? html.slice(i) : html.slice(i, close);
      if (documentTitle.length === 0) documentTitle = collapsePreviewText(decodePreviewEntities(text));
      i = close < 0 ? n : close;
      continue;
    }
    if (tag === "script" || tag === "style") {
      const close = indexOfCI(html, `</${tag}`, i);
      i = close < 0 ? n : close;
      continue;
    }
    if (tag === "meta") {
      const key = (attrs["property"] ?? attrs["name"] ?? attrs["itemprop"] ?? "").trim().toLowerCase();
      const content = attrs["content"];
      if (key.length > 0 && content !== undefined && meta[key] === undefined) {
        meta[key] = collapsePreviewText(content);
      }
      continue;
    }
    if (tag === "link") {
      const href = attrs["href"];
      const rel = (attrs["rel"] ?? "").trim().toLowerCase();
      if (href !== undefined && rel.length > 0) {
        // `rel` is a space-separated token list: `rel="shortcut icon"` is two tokens.
        for (const token of rel.split(/\s+/)) {
          if (token.length > 0 && links[token] === undefined) links[token] = href.trim();
        }
      }
      continue;
    }
  }

  return { meta, links, documentTitle };
}

function firstMeta(tags: PreviewTags, keys: readonly string[]): string {
  for (const key of keys) {
    const value = tags.meta[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
}

function firstLink(tags: PreviewTags, keys: readonly string[]): string {
  for (const key of keys) {
    const value = tags.links[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
}

/** The registrable-looking part of a host, used as the site-name fallback. `www.` is dropped
 *  because no publisher calls itself "www.example.com". */
export function previewSiteFallback(host: string): string {
  const bare = host.split(":")[0] ?? host;
  return bare.startsWith("www.") ? bare.slice(4) : bare;
}

/**
 * Fold a scanned document into the preview a caller receives. THE PRECEDENCE IS THE PRODUCT
 * and is pinned case by case in the corpus:
 *
 *   title        og:title → twitter:title → <title>            → ""
 *   description  og:description → twitter:description → description → ""
 *   image        og:image → og:image:url → og:image:secure_url → twitter:image
 *                → twitter:image:src → link[rel=image_src]     → ""     (resolved absolute)
 *   siteName     og:site_name → application-name → host without `www.`
 *   favicon      link[rel=icon] → shortcut icon → apple-touch-icon → mask-icon
 *                → <origin>/favicon.ico                                 (resolved absolute)
 *   type         og:type → "website"
 *   canonical    link[rel=canonical] → og:url → the request URL          (resolved absolute)
 *
 * Every field is a String and absence is "", never null: a preview card renders the same on
 * three renderers only if "no image" has one spelling.
 */
export function foldLinkPreview(tags: PreviewTags, target: PreviewTarget): LinkPreview {
  const title = firstMeta(tags, ["og:title", "twitter:title"]) || tags.documentTitle;
  const description = firstMeta(tags, ["og:description", "twitter:description", "description"]);
  const rawImage = firstMeta(tags, [
    "og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src",
  ]) || firstLink(tags, ["image_src"]);
  const rawCanonical = firstLink(tags, ["canonical"]) || firstMeta(tags, ["og:url"]);
  const rawFavicon = firstLink(tags, ["icon", "shortcut", "apple-touch-icon", "mask-icon"]);

  const canonical = resolvePreviewReference(target, rawCanonical) || target.url;
  const image = resolvePreviewReference(target, rawImage);
  const favicon = resolvePreviewReference(target, rawFavicon) || `${target.origin}/favicon.ico`;
  const siteName = firstMeta(tags, ["og:site_name", "application-name"]) || previewSiteFallback(target.host);
  const type = firstMeta(tags, ["og:type"]) || "website";

  return { title, description, image, siteName, favicon, type, canonical };
}

/** The whole read, once the bytes are in hand. The module facets differ only in how they
 *  got the bytes. */
export function parseLinkPreview(html: string, target: PreviewTarget): LinkPreview {
  return foldLinkPreview(scanPreviewTags(html), target);
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const PREVIEW_MESSAGES: Readonly<Record<PreviewRefusal, string>> = {
  invalid_url: "That is not a URL a preview can be fetched from.",
  unsupported_scheme: "Link previews are only fetched over http and https.",
  credentials_in_url: "A URL carrying a username or password is never fetched.",
};
