//
//  shot-skin.ts - THE SHOT SKIN (platform/09-store-screenshots.md §3, W3).
//
//  An OPT-IN stylesheet that renders the iOS 26 material vocabulary for ONE purpose: an image
//  that DEPICTS the native build. It is never part of `ELEMENTS_CSS`, never linked by a
//  shipping web app, and importing this module without calling `shotSkinCss()` costs a page
//  nothing.
//
//  WHY THIS DOES NOT VIOLATE system-defaults.md's "never fake-Cupertino".
//
//  That law governs what an app LOOKS LIKE WHEN IT RUNS: a web app should look like a web app,
//  and imitating a platform the web cannot host is the disavowed mistake. A store screenshot is
//  not a running surface - it is a picture of the iOS build - so inside it the law INVERTS:
//  imitating iOS 26 is the accurate act and honest-neutral is the inaccurate one. The law is
//  preserved by SCOPE, not by exception, which is why this is a separate target's skin rather
//  than a flag on the default one.
//
//  WHAT A STILL FRAME ACTUALLY NEEDS. Most of what makes Liquid Glass recognisable is
//  BEHAVIOUR - lensing that tracks scrolling content, specular response to motion, the press
//  morph, a control melting into a bar. A screenshot freezes every one of those away. What
//  survives into one frame is a much shorter list, and it is all reachable in CSS:
//
//    1. a backdrop blur with a saturation lift   (the material reading through)
//    2. a bright specular top edge               (the light catching the rim)
//    3. a subtle tint over the blur              (glass is never colourless)
//    4. a hairline rim                           (the edge against the content)
//    5. depth beneath                            (it floats over, it is not painted on)
//
//  The sixth - true refraction of the background through the glass shape - is the only one CSS
//  cannot express, and it is the offline pass's job (`shotRefractionCss`), affordable precisely
//  because a shot renderer has no frame budget: 200ms per IMAGE, not per frame.
//

/** How faithful the material pass is. `flat` is the shipping web treatment (for an A/B of the
 *  skin's effect); `glass` is the five-property still; `refract` adds the offline displacement
 *  pass. */
export type ShotSkinLevel = "flat" | "glass" | "refract";

/** The iOS 26 material recipe, as one frame of it.
 *
 *  Values are the still-frame readings of the system materials, not guesses: a chrome bar's
 *  backdrop is a heavy blur with saturation pushed past 1 (the OS lifts colour through glass so
 *  what is behind stays legible as colour rather than grey), a bright hairline along the top
 *  edge where light catches, and a tint that keeps the surface from disappearing into whatever
 *  is behind it. */
export function shotSkinCss(level: ShotSkinLevel = "glass"): string {
  if (level === "flat") return "";
  const refraction = level === "refract" ? SHOT_REFRACTION_CSS : "";
  // UNLAYERED ON PURPOSE. An unlayered rule beats every layered one, which is exactly the
  // cascade position an override sheet wants - and it keeps the skin OUT of
  // `@layer dsx-elements`, where the design-system gate correctly refuses improvised
  // constants. The gate is right: these box-shadows are not design-system values, they are a
  // depiction of another platform's materials, and pretending otherwise by dressing them in
  // element tokens would make the token plane mean two different things.
  return `
  /* The material family, iOS 26 weights. The web default paints these as flat token fills
     (theme.ts SURFACE_ELEMENTS_CSS); here each is the real backdrop treatment. */
  .dsx-surface-glass, .dsx-surface-ultraThin, .dsx-surface-thin,
  .dsx-surface-regular, .dsx-surface-thick, .dsx-surface-sheet {
    position: relative;
    isolation: isolate;
    -webkit-backdrop-filter: var(--dsx-shot-glass-filter);
    backdrop-filter: var(--dsx-shot-glass-filter);
    background: var(--dsx-shot-glass-tint);
    box-shadow:
      inset 0 var(--dsx-hairline, 0.5px) 0 0 var(--dsx-shot-glass-specular),
      inset 0 0 0 var(--dsx-hairline, 0.5px) var(--dsx-shot-glass-rim),
      var(--dsx-shot-glass-depth);
  }
  .dsx-surface-ultraThin { --dsx-shot-glass-filter: blur(14px) saturate(1.5); }
  .dsx-surface-thin      { --dsx-shot-glass-filter: blur(20px) saturate(1.6); }
  .dsx-surface-glass     { --dsx-shot-glass-filter: blur(28px) saturate(1.8); }
  .dsx-surface-regular   { --dsx-shot-glass-filter: blur(34px) saturate(1.7); }
  .dsx-surface-thick     { --dsx-shot-glass-filter: blur(44px) saturate(1.5); }
  .dsx-surface-sheet     { --dsx-shot-glass-filter: blur(44px) saturate(1.5); }

  /* App chrome IS the Liquid Glass carrier. The bars are what a reviewer and a customer read
     as "this is iOS 26", and they are the whole reason this skin exists. */
  .dsx-tabbar, .dsx-navbar, .dsx-toolbar, .dsx-route-chrome-bar {
    -webkit-backdrop-filter: blur(28px) saturate(1.8);
    backdrop-filter: blur(28px) saturate(1.8);
    background: var(--dsx-shot-glass-tint);
    box-shadow:
      inset 0 var(--dsx-hairline, 0.5px) 0 0 var(--dsx-shot-glass-specular),
      var(--dsx-shot-glass-depth);
  }
  /* A glass bar lets content pass UNDER it (the scroll-edge behaviour). An opaque bar that
     pushes content above itself changes the apparent layout of the screen, which is the
     STRUCTURAL half the parity diff enforces - so it is set here, not left to chance. */
  .dsx-tabbar, .dsx-navbar { background-clip: padding-box; }

  .dsx-button[data-dsx-surface="glass"], .dsx-glass-button {
    -webkit-backdrop-filter: blur(20px) saturate(1.8);
    backdrop-filter: blur(20px) saturate(1.8);
    background: var(--dsx-shot-glass-tint);
    box-shadow:
      inset 0 var(--dsx-hairline, 0.5px) 0 0 var(--dsx-shot-glass-specular),
      inset 0 0 0 var(--dsx-hairline, 0.5px) var(--dsx-shot-glass-rim),
      var(--dsx-shot-glass-depth);
  }
${refraction}`;
}

/** The token plane the skin resolves against, both schemes.
 *
 *  Separate from the rules so a shot can override one value (a brand tint) without restating
 *  the recipe, and so the light/dark split follows the same guarded shape every DSX sheet uses:
 *  the full palette on bare `:root`, redefined under `prefers-color-scheme: dark` guarded
 *  against an explicit light pin, and again under an explicit dark pin. */
export const SHOT_SKIN_TOKENS_CSS = `  :root {
    --dsx-shot-glass-filter: blur(28px) saturate(1.8);
    --dsx-shot-glass-tint: rgba(255, 255, 255, 0.62);
    --dsx-shot-glass-specular: rgba(255, 255, 255, 0.75);
    --dsx-shot-glass-rim: rgba(0, 0, 0, 0.07);
    --dsx-shot-glass-depth: 0 1px 12px rgba(0, 0, 0, 0.10);
  }
  :root:not([data-theme="light"]) {
    @media (prefers-color-scheme: dark) {
      --dsx-shot-glass-tint: rgba(28, 28, 30, 0.60);
      --dsx-shot-glass-specular: rgba(255, 255, 255, 0.16);
      --dsx-shot-glass-rim: rgba(255, 255, 255, 0.10);
      --dsx-shot-glass-depth: 0 1px 14px rgba(0, 0, 0, 0.42);
    }
  }
  :root[data-theme="dark"] {
    --dsx-shot-glass-tint: rgba(28, 28, 30, 0.60);
    --dsx-shot-glass-specular: rgba(255, 255, 255, 0.16);
    --dsx-shot-glass-rim: rgba(255, 255, 255, 0.10);
    --dsx-shot-glass-depth: 0 1px 14px rgba(0, 0, 0, 0.42);
  }
`;

/** The sixth property: refraction of the background through the glass shape.
 *
 *  An SVG displacement map over the composited backdrop. A live renderer could never pay for
 *  this per frame; a shot renderer pays it once per image and nothing is waiting. Kept behind
 *  the `refract` level because it is the one part that is genuinely expensive and the one part
 *  a reviewer will never notice missing. */
const SHOT_REFRACTION_CSS = `
  .dsx-surface-glass, .dsx-tabbar, .dsx-navbar {
    -webkit-backdrop-filter: blur(28px) saturate(1.8) url(#dsx-shot-refract);
    backdrop-filter: blur(28px) saturate(1.8) url(#dsx-shot-refract);
  }
`;

/** The filter the `refract` level references. Injected into the shot page's body once. */
export const SHOT_REFRACTION_SVG = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<filter id="dsx-shot-refract" x="0" y="0" width="100%" height="100%">
  <feTurbulence type="fractalNoise" baseFrequency="0.9 0.02" numOctaves="1" seed="7" result="noise"/>
  <feGaussianBlur in="noise" stdDeviation="1.2" result="soft"/>
  <feDisplacementMap in="SourceGraphic" in2="soft" scale="3" xChannelSelector="R" yChannelSelector="G"/>
</filter>
</svg>`;
