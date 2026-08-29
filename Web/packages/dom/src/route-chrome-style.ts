// Neutral Web route chrome. Defaults live in the weakest element layer so every DSX
// authoring path (theme, sidecar, static style, reactive token, or unlayered CSS) can win.
// Runtime state is expressed through data attributes; no presentation is stamped inline.

export const ROUTE_CHROME_STYLE_ID = "dsx-route-chrome-style";

export const ROUTE_CHROME_CSS = `@layer dsx-elements {
  :where(.dsx-route-chrome) {
    box-sizing: border-box;
    position: fixed;
    inset: 0 0 auto;
    height: calc(var(--dsx-route-height, 48px) + env(safe-area-inset-top));
    padding-block-start: env(safe-area-inset-top);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-rows: var(--dsx-route-height, 48px);
    align-items: center;
    z-index: var(--dsx-route-z-index, 9000);
    color: var(--dsx-route-foreground, var(--dsx-label, #111318));
    font-family: var(--dsx-font, system-ui, sans-serif);
    background: var(
      --dsx-route-surface,
      color-mix(in srgb, var(--dsx-background, #fff) 90%, transparent)
    );
    border-block-end: var(--dsx-hairline, 1px) solid var(--dsx-route-separator, var(--dsx-separator, rgba(17, 19, 24, 0.14)));
    box-shadow: var(--dsx-route-shadow, none);
    backdrop-filter: blur(var(--dsx-route-blur, 20px)) saturate(var(--dsx-route-saturation, 1.1));
    -webkit-backdrop-filter: blur(var(--dsx-route-blur, 20px)) saturate(var(--dsx-route-saturation, 1.1));
    transition:
      background-color var(--dsx-dur-base, 200ms) var(--dsx-ease, ease),
      border-color var(--dsx-dur-base, 200ms) var(--dsx-ease, ease);
  }

  @supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
    :where(.dsx-route-chrome) {
      background: var(--dsx-route-surface-opaque, var(--dsx-background, #fff));
    }
  }

  /* scroll-edge behavior: at the top of the content the bar reads seamless with the
     page (no material, no hairline); the material and hairline appear the moment
     content scrolls under. The route module stamps data-dsx-edge from the active
     frame's scroller. */
  :where(.dsx-route-chrome[data-dsx-edge="top"]) {
    background: transparent;
    border-block-end-color: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  :where(.dsx-route-chrome[hidden]) { display: none; }

  :where(.dsx-route-chrome[data-dsx-split="true"]) {
    inset-inline-start: var(--dsx-master-width, min(360px, 38%));
  }

  :where(.dsx-route-chrome[data-dsx-large="true"]) {
    height: calc(var(--dsx-route-large-height, 96px) + env(safe-area-inset-top));
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows:
      var(--dsx-route-height, 48px)
      calc(var(--dsx-route-large-height, 96px) - var(--dsx-route-height, 48px));
  }

  :where(.dsx-route-back) {
    appearance: none;
    grid-column: 1;
    grid-row: 1;
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    min-inline-size: var(--dsx-route-target-size, 44px);
    min-block-size: var(--dsx-route-target-size, 44px);
    max-inline-size: 100%;
    margin-inline-start: var(--dsx-route-edge, 0.25rem);
    padding-block: 0.375rem;
    padding-inline: 0.375rem 0.625rem;
    border: 0;
    border-radius: var(--dsx-route-control-radius, var(--dsx-radius-control));
    color: var(--dsx-route-accent, var(--dsx-accent, #315ce8));
    background: transparent;
    font: inherit;
    font-size: var(--dsx-route-control-font-size, var(--dsx-type-title3-size));
    font-weight: var(--dsx-type-label-weight);
    line-height: var(--dsx-type-leading-none);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  :where(.dsx-route-back:active) {
    background: var(--dsx-route-control-active, color-mix(in srgb, currentColor 13%, transparent));
  }

  :where(.dsx-route-back:focus-visible) {
    outline: var(--dsx-focus-width, 2px) solid var(--dsx-focus, var(--dsx-route-accent, var(--dsx-accent, #315ce8)));
    outline-offset: var(--dsx-focus-offset, 2px);
  }

  :where(.dsx-route-back-icon) {
    inline-size: 1.375rem;
    block-size: 1.375rem;
    flex: none;
  }

  :where([dir="rtl"] .dsx-route-back-icon) { transform: scaleX(-1); }

  /* the previous screen's title rides the chevron when the claims ledger knows it;
     the button's accessible name stays "Back". The text yields to the centered
     title (ellipsis in the leading column) and stands down entirely where space
     does not allow it. */
  :where(.dsx-route-back-label) {
    min-inline-size: 0;
    max-inline-size: var(--dsx-route-back-label-max, 9rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 23.9375rem) {
    :where(.dsx-route-back-label) { display: none; }
  }

  :where(.dsx-route-chrome[data-dsx-back="hidden"] .dsx-route-back) { visibility: hidden; }

  :where(.dsx-route-title) {
    grid-column: 2;
    grid-row: 1;
    justify-self: center;
    align-self: center;
    min-inline-size: 0;
    max-inline-size: var(--dsx-route-title-max, 60vw);
    overflow: hidden;
    color: inherit;
    font-size: var(--dsx-route-title-size, var(--dsx-type-title3-size));
    font-weight: var(--dsx-route-title-weight, var(--dsx-type-headline-weight));
    line-height: var(--dsx-type-title2-leading);
    letter-spacing: var(--dsx-type-title3-tracking);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :where(.dsx-route-chrome[data-dsx-large="true"] .dsx-route-title) {
    grid-column: 1 / 4;
    grid-row: 2;
    justify-self: start;
    align-self: end;
    max-inline-size: var(--dsx-route-large-title-max, calc(100% - 2rem));
    padding: 0 var(--dsx-route-large-title-edge, 1rem) 0.375rem;
    font-size: var(--dsx-route-large-title-size, var(--dsx-type-title1-size-fluid));
    letter-spacing: var(--dsx-type-display-tracking);
  }

  :where(.dsx-route-spacer) { grid-column: 3; grid-row: 1; }

  @media (hover: hover) and (pointer: fine) {
    :where(.dsx-route-back:hover) {
      background: var(--dsx-route-control-hover, color-mix(in srgb, currentColor 8%, transparent));
    }
  }

  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    :where(.dsx-route-chrome:not([data-dsx-large="true"])) {
      --dsx-route-height: 44px;
      --dsx-route-target-size: 32px;
      --dsx-route-control-radius: 6px;
      --dsx-route-control-font-size: var(--dsx-type-caption-size);
      grid-template-columns: auto minmax(0, 1fr) auto;
      padding-inline: 0.375rem;
    }

    :where(.dsx-route-chrome:not([data-dsx-large="true"]) .dsx-route-back) {
      margin-inline-start: 0;
      padding: 0.25rem 0.5rem;
    }

    :where(.dsx-route-chrome:not([data-dsx-large="true"]) .dsx-route-title) {
      justify-self: start;
      max-inline-size: min(48rem, calc(100% - 1rem));
      font-size: var(--dsx-type-footnote-size);
      font-weight: var(--dsx-type-headline-weight);
      letter-spacing: var(--dsx-type-callout-tracking);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :where(.dsx-route-chrome), :where(.dsx-route-back) {
      scroll-behavior: auto;
      transition: none;
    }
  }

  @media (forced-colors: active) {
    :where(.dsx-route-chrome) {
      background: Canvas;
      color: CanvasText;
      border-color: CanvasText;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    :where(.dsx-route-back) { color: LinkText; }
  }
}`;
