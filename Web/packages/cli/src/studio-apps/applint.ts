//
//  The app-lint tier (studio-apps.md §13) behind `despia review --app`: the OPEN twin of
//  the closed editor-dogfood discipline, because submitters and the shelf CI cannot run
//  closed ruby. Three rules, each fail-closed on the thing it names:
//
//    1. TOKEN-ONLY COLOUR. Every colour an app's sheets or inline styles set comes from
//       the --dsx-* plane (or a kit --sk-* alias), a keyword, or the platform — a literal
//       is the app deciding alone, which is exactly how an app stops following the theme.
//    2. THE REMOTE-LITERAL BAN. A hardcoded http(s) URL in markup or sheets is a wire the
//       src gate would refuse at mount and the egress funnel would refuse at call time —
//       lint says it at authoring time, with the grant that would make it lawful.
//    3. THE BYTE BUDGET. An app's authored surface (dsx + css + web js) stays under 1 MB;
//       heavy assets belong in the content plane, not the sub-registry compile.
//
export type AppLintFinding = { file: string; line: number; level: "error" | "warning" | "notice"; message: string };

const COLOUR_PROPS = new Set([
  "color", "background", "background-color", "border-color", "border", "fill", "stroke",
  "caret-color", "outline-color", "accent-color", "box-shadow", "text-shadow",
]);

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|lab|lch|color)\(/;
const KEYWORDS = new Set([
  "none", "transparent", "currentcolor", "inherit", "initial", "unset", "auto", "0",
]);

function colourValueOffends(value: string): boolean {
  const v = value.trim();
  if (v === "" || KEYWORDS.has(v.toLowerCase())) return false;
  // strip every var(...) and color-mix over vars — what remains must not carry a literal
  const stripped = v.replace(/var\(--(?:dsx|sk)-[a-z0-9-]*\)/gi, "").replace(/color-mix\([^()]*\)/gi, "");
  return COLOUR_LITERAL.test(stripped);
}

const REMOTE = /https?:\/\/[^\s"'<>)]+/g;

/** Lint one file of an app package. `kind` decides which rules see it. */
export function lintAppSource(file: string, source: string, kind: "dsx" | "css" | "js"): AppLintFinding[] {
  const findings: AppLintFinding[] = [];
  const lines = source.split("\n");
  const push = (line: number, level: AppLintFinding["level"], message: string): void => {
    findings.push({ file, line, level, message });
  };

  lines.forEach((text, i) => {
    const line = i + 1;

    // rule 1 — colour axes (every declaration on the line, not just single-declaration lines)
    if (kind === "css") {
      for (const m of text.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)) {
        if (COLOUR_PROPS.has(m[1]!) && colourValueOffends(m[2]!)) {
          push(line, "error", `${m[1]}: ${m[2]!.trim()} — an app's colours come from the token plane (var(--dsx-…)), a keyword, or the platform, never a literal`);
        }
      }
    }
    if (kind === "dsx") {
      for (const style of text.matchAll(/style="([^"]*)"/g)) {
        for (const decl of style[1]!.split(";")) {
          const [prop, value] = decl.split(":", 2);
          if (prop === undefined || value === undefined) continue;
          if (COLOUR_PROPS.has(prop.trim()) && !value.includes("{{") && colourValueOffends(value)) {
            push(line, "error", `style ${prop.trim()}: ${value.trim()} — an app's colours come from the token plane (var(--dsx-…)), never a literal`);
          }
        }
      }
    }

    // rule 2 — remote literals (comments excepted: a doc link is prose, not a wire).
    // The js line-comment strip guards the `://` of a URL literal with a lookbehind —
    // `https://x` is a wire, `// https://x` is prose.
    const bare = kind === "dsx" ? text.replace(/<!--.*?-->/g, "")
      : kind === "js" ? text.replace(/\/\*.*?\*\//g, "").replace(/(?<!:)\/\/.*$/, "")
      : text.replace(/\/\*.*?\*\//g, "");
    for (const hit of bare.matchAll(REMOTE)) {
      push(line, "error", `${hit[0]} — a remote literal in an app surface; declare the host as a net:<host> grant and reach it through the scoped fetch, or ship the asset in the package`);
    }
  });

  return findings;
}

/** The byte budget over the app's authored surface. */
export function lintAppBudget(files: ReadonlyArray<{ file: string; bytes: number }>): AppLintFinding[] {
  const CAP = 1024 * 1024;
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total <= CAP) return [];
  return [{
    file: files[0]?.file ?? "",
    line: 0,
    level: "error",
    message: `the app's authored surface is ${total} bytes (cap ${CAP}) — heavy assets ride the content plane, not the sub-registry compile`,
  }];
}
