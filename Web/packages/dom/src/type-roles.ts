/**
 * THE TYPE RAMP'S ROLE LIST, and nothing else.
 *
 * A leaf module on purpose. Both the sheet (theme.ts, which generates one element-layer rule
 * per role) and the renderer (elements.ts, which validates the authored word) need this list,
 * and importing the sheet from the renderer put a cycle through the element sheets that only
 * showed up as a "cannot access before initialization" at module load. The list has no
 * dependencies, so it can be the shared leaf instead.
 *
 * The order is `Conformance/defaults/type.json`'s key order, and `defaults-corpus.test.ts`
 * fails if the two ever disagree.
 */
export const TYPE_ROLES = [
  "display", "title1", "title2", "title3", "headline",
  "body", "reading", "callout", "footnote", "label", "caption", "caption2",
] as const;

export type TypeRole = (typeof TYPE_ROLES)[number];
