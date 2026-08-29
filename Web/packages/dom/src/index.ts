//
//  @despia/dom - the DSX web renderer. Direct DOM access lives ONLY here
//  (constitution rule 6, inverted for the web — /web/01).
//

export {
  mountNode, instantiate, setCookieWriter, BOUND_COLLECTION_LIMIT, type ScopedEnv,
  type MountCtx, type Instance, type SlotContent,
} from "./mount.ts";
export {
  ELEMENTS, GLOBAL_ELEMENTS, UNSUPPORTED, BUTTON_ROLES, RICH_ELEMENT_TAGS, iconSvg,
  registerGlobalElements, registerRichElements,
  SPINNER_SCALE_LIMITS, normalizeSpinnerScale,
  normalizeStarCount, normalizeStarSize, starAccessibleName,
  CHART_RENDER_POINT_LIMIT, downsampleChartPoints,
  KEYBOARD_MODES, CONTENT_TYPE_AUTOCOMPLETE, SEARCHBAR_GLYPHS, STEPPER_REPEAT,
  TEXTAREA_LINE_LIMITS, textAreaLineCount, assetImageSource,
  LINE_CLAMP_MAX, lineClampLines, lineClampStyle, applyLineClamp, applyKeyboardHintAttributes,
  booleanWord,
  type ElementFactory, type ElementApi,
} from "./elements.ts";
export {
  MARKDOWN_LIMITS, safeMarkdownHref, parseMarkdown, markdownFragment, markdownHtml,
  renderMarkdown, type MarkdownSink,
} from "./markdown.ts";
export {
  MARKDOWN_BLOCK_LIMITS, parseMarkdownBlocks, markdownBlocksFragment, markdownBlocksHtml,
  type MarkdownBlock, type MarkdownListItem,
} from "./markdown-blocks.ts";
export {
  PROSE_CSS, CODE_TINT_LIMITS, tokenizeCode, type CodeToken, type CodeTokenKind,
} from "./prose.ts";
export {
  UNIVERSAL_GLOBAL_ELEMENTS, UNIVERSAL_GLOBAL_TAGS, GLOBAL_ELEMENTS_CSS,
} from "./globals.ts";
export {
  FORM_ELEMENTS, FORM_ELEMENT_TAGS, FORM_ELEMENTS_CSS, FORM_LIMITS,
  normalizeFormInput, normalizeFormOptions, parseValidationRules, validateFormValue,
  type FormFieldType, type FormOption, type ValidationRule,
} from "./forms.ts";
export {
  NATIVE_CONTROL_ELEMENTS, NATIVE_CONTROL_TAGS, NATIVE_CONTROLS_CSS,
  NATIVE_CONTROL_OPTION_LIMIT, NATIVE_CONTROL_TEXT_LIMIT, OTP_LENGTH_LIMIT,
  registerNativeControls, normalizeNativeControlOptions, parseNativeControlCsv,
  normalizeDatePickerMode, isoDatePickerValue, datePickerWireValue,
  normalizeOtpLength, normalizeOtpValue, normalizeRangeBounds,
  type NativeControlOption, type DatePickerMode, type RangeBounds,
} from "./native-controls.ts";
export {
  STRUCTURAL_CONTROL_ELEMENTS, STRUCTURAL_CONTROL_TAGS, STRUCTURAL_CONTROLS_CSS, STRUCTURAL_CHILD_LIMIT,
  registerStructuralControls, normalizeStructuralGap, normalizeStructuralIndex,
} from "./structural-controls.ts";
export {
  SPLIT_CSS, SPLIT_ROLE_ORDER, SPLIT_TOGGLE_PATH, resolveSplit, resolveSplitRoles, splitSelectionActive,
  type SplitPlan, type SplitRole, type SplitWidths,
} from "./split.ts";
export {
  OVERLAY_CONTROL_ELEMENTS, OVERLAY_CONTROL_TAGS, OVERLAY_CONTROLS_CSS, OVERLAY_LIMITS,
  CONTEXT_MENU_PRESS,
  registerOverlayControls, normalizeOverlayItems, normalizeSheetBackground, normalizeSheetDetents, placeFloating,
  type OverlayItem, type OverlayRole, type SheetDetent, type FloatingPreference, type FloatingPlacement,
} from "./overlay-controls.ts";
export {
  DATA_CONTROL_ELEMENTS, DATA_CONTROL_GLOBAL_ELEMENTS, DATA_CONTROL_TAGS, DATA_CONTROLS_CSS,
  DATA_CONTROL_LIMITS, registerDataControls, parseDataControlCsv, normalizeDataControlOptions,
  parseCalendarDate, calendarDateKey, calendarMonthGrid, calendarFirstWeekday, normalizeCalendarLocale,
  normalizeSegmentedSelection,
  type DataControlOption, type CalendarDate, type CalendarGrid,
} from "./data-controls.ts";
export {
  APPLICATION_CONTROL_ELEMENTS, APPLICATION_CONTROL_TAGS, APPLICATION_CONTROLS_CSS,
  APPLICATION_CONTROL_LIMITS, registerApplicationControls, normalizeMenuBarItems,
  normalizeMenuBarIndex, normalizeMenuBarEnabledIndex, normalizeMenuBarTint, type MenuBarItem,
} from "./application-controls.ts";
export {
  MEDIA_SURFACE_ELEMENTS, MEDIA_SURFACE_TAGS, MEDIA_SURFACE_LIMITS,
  MEDIA_PLAYBACK_CSS, MEDIA_SVG_CSS, MEDIA_LIGHTBOX_CSS,
  audio, video, svg, lightbox,
  registerAudioSurface, registerVideoSurface, registerSvgSurface, registerLightboxSurface, registerMediaSurfaces,
  safeMediaUrl, boundedMediaText, normalizeMediaRate, normalizeAudioSessionCategory, mediaErrorMessage, sanitizeSvgMarkup, sanitizeSvgSource, svgBundleKey, svgFromPath,
  normalizeLightboxImages, parseLightboxUrls, normalizeLightboxColor,
  type LightboxImage,
} from "./media-surfaces.ts";
export { asFacetComponent, type FacetComponent, type FacetCtx, type FacetInstance } from "./facet.ts";
export {
  resolveAdaptiveShell,
  type AdaptiveShellPlan, type AdaptiveShellPanes, type AdaptiveShellWidths,
} from "./adaptive-shell.ts";
export { FrameRouter } from "./router.ts";
export { bootDsx, screenMetrics, type BootOptions } from "./boot.ts";
export {
  TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS,
} from "./theme.ts";
export {
  registerInputDeclarations, onInputEdge, inputHostFrame, inputBindings, inputDiagnostics,
  synthesizeInput, resetInputRuntime, canonicalBrowserKey,
} from "./input.ts";
// U01 scroll: the DOM adapter for the shared scrolling core.
export {
  applyScrollBehaviour, scrollController, ScrollController,
  type ScrollHooks, type ScrollEnvironment,
} from "./scroll.ts";
// U05 image: the DOM adapter for the shared image core.
export {
  applyImageAttributes, objectFitValue, objectPositionValue, fetchHints,
  placeholderStyle, pixelsToBmpDataUrl, type ImageBinding, type ImageHooks,
} from "./image.ts";

// The SHOT SKIN (platform/09-store-screenshots.md §3): the iOS 26 material vocabulary, for
// images that DEPICT the native build. Opt-in and never part of ELEMENTS_CSS - a page that
// does not call shotSkinCss() is byte-identical to one compiled before this existed.
export {
  shotSkinCss, SHOT_SKIN_TOKENS_CSS, SHOT_REFRACTION_SVG, type ShotSkinLevel,
} from "./shot-skin.ts";

// The SRC-ATTRIBUTE ORIGIN GATE (studio-apps.md §8): a scoping host (the AppMount facet)
// registers a per-app policy; the renderer's src writes consult it. Zero registrations =
// zero behavior change — see src-gate.ts.
export { SrcGate, admitSrc } from "./src-gate.ts";
