//
//  pathmatch.ts - the one DSX route-path matcher (TS twin of DSXPathMatch.swift /
//  PathMatch.kt). Shared by the `matches()` expression helper and the router.
//  Patterns: literal segments, `{name}`/`:name` (one segment → param), `*` (one
//  segment), trailing `/*` or `*` (catch-all). Query/hash stripped.
//

function normalize(s: string): string {
  const q = s.indexOf("?");
  const h = s.indexOf("#");
  const cut = q >= 0 && h >= 0 ? Math.min(q, h) : q >= 0 ? q : h;
  return cut >= 0 ? s.substring(0, cut) : s;
}

function segments(s: string): string[] {
  return s.split("/").filter((x) => x.length > 0);
}

export const DSXPathMatch = {
  /** Match a concrete path against a route pattern. Returns the extracted params
   *  (empty object when there are none) on a match, or `null` on no match. */
  match(path: string, pattern: string): { [k: string]: string } | null {
    const p = normalize(path);
    const pat = normalize(pattern);
    if (pat === "*" || pat === "/*" || pat.length === 0) return {}; // catch-all / empty
    const ps = segments(p);
    const pats = segments(pat);
    const params: { [k: string]: string } = {};
    let i = 0;
    while (i < pats.length) {
      const seg = pats[i]!;
      if (seg === "*") {
        // A trailing '*' soaks up the rest; a mid-path '*' matches one segment.
        if (i === pats.length - 1) return params;
        if (i >= ps.length) return null;
        i += 1;
        continue;
      }
      if (i >= ps.length) return null;
      if (seg.length >= 2 && seg.startsWith("{") && seg.endsWith("}")) {
        params[seg.substring(1, seg.length - 1)] = ps[i]!;
      } else if (seg.startsWith(":")) {
        params[seg.substring(1)] = ps[i]!;
      } else if (seg !== ps[i]) {
        return null;
      }
      i += 1;
    }
    return ps.length === pats.length ? params : null;
  },

  /** Boolean convenience — backs the `matches(path, pattern)` expression helper. */
  matches(path: string, pattern: string): boolean {
    return DSXPathMatch.match(path, pattern) !== null;
  },
};
