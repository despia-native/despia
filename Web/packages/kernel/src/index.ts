//
//  @despia/kernel - the DSX web kernel. TS twin of OpenSource/Engine/ (see /web/01):
//  store + signals, JSE (interpreter + compiled), action runner, module bus,
//  dsx.platform. Direct DOM access lives ONLY in @despia/dom — this package is
//  DOM-free by law (surface-safe: browser, Node/SSR, workers).
//

export {
  JSE, JSESeams, StackStore, Parser, type Item,
  attributeBinding, type AttributeBinding,
} from "./jse/jse.ts";
export {
  OVERRIDE_PREFIX, overrideAttrName, splitOverrideAttrs, resolveOverride, resolveOverridePlane,
  type OverrideDecl,
} from "./style-overrides.ts";
export {
  NSNull, isNSNull, isDict, isLambda, number, string, truthy, jseEquals, compare,
  arith, typeofString, watchKey, asArray, asRows, safeInt, graphemes, charCount,
  trimWhitespaceOnly, swiftDouble,
  type Dict, type StackLambda, type LambdaParam, type StackFormula,
} from "./jse/values.ts";
export { tokenize, cachedTokens, type Token } from "./jse/tokens.ts";
// The `<code>` surface's scanner, and the three scanning rules a second reader of JSE source
// must share rather than re-implement - above all whether a `/` opens a regex or divides.
export {
  highlight, highlightLines, highlightMask, opensRegex, endOfRegex, endOfNumber,
  HI_LETTER, type HiKind, type HiToken, type HiSpan, type HiLine,
} from "./jse/highlight.ts";
export { JSERegex, reDoSProne } from "./jse/regex.ts";
// config-validate.ts is deliberately NOT re-exported here. It is dashboard/server logic (the
// D1 validation grammar) that an embedded widget never runs, and the barrel is what the embed
// slicer can prove reachable — folding it in cost the EmbedCard slice ~199 B of dead weight
// against the 40,960-byte G10 law. Headroom is bought by proving absence, never by raising the
// limit, so it ships as the subpath export `@despia/kernel/config-validate`.
export { DSXPathMatch } from "./jse/pathmatch.ts";
export { JSECore, JSECrypto, base64Encode, base64Decode } from "./jse/core.ts";
export { higherOrderFns, methodFns } from "./jse/dispatch.ts";
export { decodeOperatorEntities, endOfJseNumber } from "./jse/tokens.ts";
export {
  compileExpression, compileBlock, evalCompiled, evalBlockCompiled,
  CompiledScope, BlockScope, type CompiledProgram,
} from "./compile/codegen.ts";
export {
  classifyBody, tierReport, type TierVerdict, type TierReport, type TierReportEntry,
} from "./compile/tier.ts";
export { installJsTier, runJsTier, type JsTierEnv } from "./compile/jstier.ts";
export {
  ReactiveStore, DSXState, trackReads, getPath, flushEffects, noteSurfaceRead,
  readCookiePartition, invalidateCookies, type Subscriber,
} from "./store.ts";
export {
  ModuleRegistry, DSXEvents, ModuleCallError, defineModule, makeDsx,
  ERROR_NOT_LOADED, ERROR_UNSUPPORTED_PLATFORM, ERROR_EXCLUDED,
  resolveChain, RESERVED_MEMBERS, PROXY_DENYLIST, actionPlatformKey,
  type WebModule, type ActionContext, type ActionHandler, type DsxContext, type Envelope,
  type ChainTable, type ChainResolution, type ModuleHandle, type ModuleProxy,
} from "./bus.ts";
export { DSXLogs, reportLog, JSERedact, type DSXLogEntry } from "./logs.ts";
export {
  ORIENTATION_CANONICAL, ORIENTATION_IMPERATIVE_ID, resolveOrientation, OrientationClaimStack,
  type OrientationResolved, type OrientationRefusal, type OrientationResolution,
} from "./orientation.ts";
export {
  matchFontWeight, selectFontFace, parseFontVariation, resolveFontVariation, parseFontFeatures,
  type FontFace, type FontSelection, type FontVariationResolution,
} from "./fonts.ts";
export {
  FILE_ROOTS, FILE_ACTIONS, FILE_PLATFORMS, FILE_ERROR_RECOVERABLE, FILE_UNSUPPORTED,
  parseFilePath, fileRootBase, fileRootWritable, fileUnsupported, filePathContains, fileGlobMatch,
  type ParsedFilePath, type FilePathRefusal, type FilePathResult,
} from "./filepaths.ts";
export {
  TELEMETRY_PLACEHOLDERS, TELEMETRY_SCRUB_ORDER, TelemetryQueue,
  telemetryLuhn, telemetryIsSensitiveKey, telemetryScrubText, telemetryScrubValue,
  telemetryArgShape, telemetryCollapseMessage, telemetryFingerprint, telemetryHash32,
  telemetrySampled, telemetryBackoffMs,
  type TelemetryOfferOutcome, type TelemetryOfferResult,
} from "./telemetry.ts";
export {
  LIVE_WIRE_VERSION, LIVE_MESSAGE_CAP, LIVE_BATCH_MAX_ROWS, LIVE_QUEUE_CAP,
  LIVE_IDLE_ACK_PAUSE, LIVE_RING_CAP,
  liveRowFromLog, liveRowFromError, liveRowFromKernel, liveBatchBody,
  liveAckStart, liveAckFold, liveAckExpire, LiveQueue, LiveRing,
  liveCanonical, liveSha256Hex, liveReportSeal, liveReportVerdict, liveReportExtract,
  type LiveRow, type LiveAckState,
} from "./livelogs.ts";
export {
  snackbarInitial, snackbarApply, snackbarPending, normalizeRequest,
  resolveDuration, resolveEdge, resolveLift,
  SNACKBAR_SHORT_MS, SNACKBAR_LONG_MS, SNACKBAR_DEFAULT_MS, SNACKBAR_MIN_MS,
  SNACKBAR_MAX_MS, SNACKBAR_GAP, SNACKBAR_TOP_GAP,
  type SnackbarResult, type SnackbarEdge, type SnackbarAction, type SnackbarRequest,
  type SnackbarEntry, type SnackbarSettlement, type SnackbarState, type SnackbarOp,
  type SnackbarChrome, type SnackbarLift,
} from "./snackbar.ts";
export {
  BACKGROUND_KINDS, BACKGROUND_REQUIREMENTS, BACKGROUND_PERIODIC_FLOOR_SECONDS,
  BACKGROUND_BUCKETS, BACKGROUND_BUDGET_MS,
  resolveBackgroundTask, backgroundBucket, backgroundConstraints, backgroundUnmet,
  backgroundBudget, backgroundRunRecord, backgroundRunAllowed,
  type BackgroundTask, type BackgroundRow, type BackgroundRefusal, type BackgroundResolution,
  type BackgroundConstraints, type BackgroundDeviceState, type BackgroundBudget,
  type BackgroundRunEvent, type BackgroundRunResult, type BackgroundRunRecord,
} from "./background.ts";
export {
  GEO_STATUSES, GEO_LEVELS, GEO_REGION_CAPS, GEO_RADIUS_FLOOR_METERS, GEO_RADIUS_CEILING_METERS,
  GEO_ACCURACIES, GEO_DEFAULT_ACCURACY, GEO_EARTH_RADIUS_METERS,
  geoPermissionPlan, geoApplyPermission, geoEscalationRoute, geoPreciseOutcome,
  geoRadius, GeoRegionSet, geoDeliveryPlan, geoAccuracy, geoDistanceMeters,
  geoShouldDeliver, geoCacheServes,
  type GeoPermissionState, type GeoPermissionPlan, type GeoPreciseOutcome, type GeoRadius,
  type GeoRegionResult, type GeoDeliveryPlan, type GeoAccuracy, type GeoAccuracyResolution,
  type GeoFix, type GeoFilterVerdict,
} from "./geo.ts";
export {
  CRYPTO_DIGESTS, CRYPTO_MAC_DIGESTS, CRYPTO_MAX_RANDOM_BYTES,
  foldDigest, digestWebName, uuidV4, uuidV7, uniformBound, uniformPick, uniformInt,
} from "./crypto-core.ts";
export {
  RECORDER_FLOOR_DB, RECORDER_METER_INTERVAL_MS, RECORDER_STATES, RECORDER_FORMATS,
  foldRecorderFormat, recorderMeterLevel, recorderAmplitudeDb, recorderMeterFromAmplitude,
  recorderTransition, type RecorderTransition,
} from "./recorder-core.ts";
export {
  CAPTURE_FORMATS, CAPTURE_MAX_PIXELS, PDF_PAGE_SIZES,
  foldCaptureFormat, captureQuality, resolveCaptureScale, capturePixelSize,
  pdfPageSize, pdfMargins,
} from "./capture-core.ts";
export { refKey, RefRegistry, type RefResolution } from "./ref.ts";
export {
  ActionRunner, makeRunEnv, writeBound, RunnerFetchSeam, type RunEnv, type ComponentVerb,
} from "./runner.ts";
export {
  ApiBlock, ApiGraph, ApiServerOrigin, clearApiCache, materializeApiRequest, apiSsrEnabled, apiDeferred, apiStreamEligible, executeApiForSSR,
  type ApiSpec, type ApiHandle, type ApiBlockOpts, type ApiEvent, type ApiSeed, type SsrApiOutcome,
  type ApiBlocked,
} from "./api.ts";
export {
  ScreenReadiness, installScreenPhase, screenIsAppSurface, screenRouteString, NATIVE_SURFACE,
  SETTLE_DEADLINE_MS,
} from "./screen.ts";
export {
  resolveInputDeclarations, inputCanonicalKeys, inputDigitalAxis, inputAnalogAxis,
  InputMachine, sceneAudioAttenuation,
  INPUT_DEFAULT_DEADZONE, INPUT_MAX_DEADZONE, INPUT_PAD_BUTTONS, INPUT_PAD_STICKS,
  INPUT_KEY_SETS, INPUT_TOUCH_WORDS, INPUT_MOMENTARY_TOUCH,
  AUDIO_DEFAULT_REF_DISTANCE, AUDIO_DEFAULT_MAX_DISTANCE, AUDIO_DEFAULT_ROLLOFF,
  type InputDeclaration, type InputBinding, type InputResolution, type InputDiagnostic,
  type InputDiagnosticCode, type InputPadSnapshot, type InputAxisValue, type InputEvent,
  type InputCommit, type AudioAttenuation,
} from "./input.ts";
export {
  mat4Identity, mat4Multiply, mat4Translation, mat4Scaling,
  mat4RotationX, mat4RotationY, mat4RotationZ, mat4RotationXYZ, mat4Trs,
  mat4LookAt, mat4Perspective, mat4Orthographic, mat4Invert,
  transformPoint, projectToNdc, pickRay, raySphere,
  type Mat4, type Vec3,
} from "./scene/math.ts";
export {
  parseScene, interpolateSceneHoles, resolvedProps, worldMatrices, findSceneNode,
  sceneCamera, sceneLighting, parseSceneColor, nodeBoundingRadius, worldBoundingSphere,
  LIGHT_KINDS, COLLIDE_KINDS, text3dQuad, TEXT3D_DEFAULT_SIZE, TEXT3D_ADVANCE,
  POINT_LIGHT_DEFAULT_RANGE, SCENE_MAX_POINT_LIGHTS,
  scenePointAttenuation, sceneLitColor, sceneFog, sceneFogFactor,
  scenePrefabDefFromTemplate, scenePrefabScope, scenePrefabResolver,
  SCENE_PREFAB_DEPTH_LIMIT, SCENE_PREFAB_TRANSFORM_WORDS,
  readPosition, SPRITE_ANCHORS, SPRITE_DEFAULT_ANCHOR, parseSpriteFrames, normalizeSpriteFlip,
  type ScenePrefabParam, type ScenePrefabDef, type ScenePrefabLookup, type ScenePrefabRef,
  type SceneMarkupNode, type SceneNode, type SceneNodeKind, type SceneMode, type SceneIR,
  type SceneDiagnostic, type SceneDiag, type SceneResolve, type SceneNodeProps,
  type SceneCamera, type SceneLighting, type Text3dQuad,
  type ScenePointLight, type ScenePointLightResolved, type SceneFog,
} from "./scene/ir.ts";
export {
  spriteQuad, spriteSizeOf, spriteAnchorOffset, spriteFrameCount, spriteUvRect,
  spriteFrameAt, sceneDrawOrder2d, SPRITE_DEFAULT_HEIGHT,
  type SpriteQuad,
} from "./scene/sprite.ts";
export {
  parseSceneEasing, sceneBezier, sceneSpring, springSettleSeconds, sceneClipMs,
  sceneEasingProgress, parseSceneAnimValue, formatSceneAnimValue, srgbToLinear, linearToSrgb,
  parseSceneDuration, parseSceneLoop, parseSceneTween, sceneTweenValue,
  parseSceneTransitions, sceneTransitionValue,
  SCENE_EASE_CONSTANTS, SCENE_ANIM_TARGETS, SCENE_TWEEN_DEFAULT_DURATION_MS,
  SCENE_SPRING_DEFAULT_STIFFNESS, SCENE_SPRING_DEFAULT_DAMPING, sceneAnimComponents,
  type SceneEasing, type SceneAnimTarget, type SceneLoop, type SceneTweenSpec,
  type SceneTweenSample, type SceneTransitionEntry, type SceneTransitionState,
} from "./scene/anim.ts";
// The UI MOTION ENGINE (ui-motion.md) — the native UI layer's twin of the scene
// animation system, over the SAME spring and bezier solver (motion.ts imports them).
export {
  parseMotion, motionFromAttrs, motionEasing, motionProgress, motionSettleMs,
  motionSpringConstants, motionSpring, motionStart, motionValue, motionRetarget,
  decayAt, decayTarget, decayDurationMs, rubberBand, rubberBandInverse, snapTarget,
  MOTION_CURVES, MOTION_DEFAULT_DURATION_MS, MOTION_SPRING_DEFAULT_RESPONSE,
  MOTION_SPRING_DEFAULT_DAMPING_FRACTION, MOTION_PRESET_KEEP, MOTION_PRESET_PRESS,
  MOTION_PRESET_DEFAULT, MOTION_DECELERATION_RATE, MOTION_DECAY_TAU_MS,
  MOTION_DECAY_MIN_VELOCITY, MOTION_RUBBER_BAND_C, MOTION_RUBBER_BAND_RELEASE,
  type MotionSpec, type MotionName, type MotionCurveName, type MotionState, type MotionDiag,
} from "./motion.ts";
// The KEYFRAME SAMPLER (runtime-pressure R28) — `@keyframes` + `animation`, folded to the
// values one frame shows. The web never calls it (a browser owns its own animations); it is
// the reference the two native frame-loop drivers are judged against.
export {
  parseAnimation, animationSpec, keyframeTimeline, sampleMotion, droppedProperties, motionAttributes,
  MOTION_PROPERTIES, MOTION_ANIMATION_KEYS, MOTION_INFINITE,
  type KeyframeSpec, type KeyframeStop, type KeyframeSample, type KeyframeAttributes,
} from "./motion-core.ts";
export {
  sceneBindRows, diffSceneBindRows, instantiateSceneRow, SCENE_BIND_LIMIT,
  type SceneBindRow, type SceneBindDiff,
} from "./scene/bind.ts";
export {
  worldAabb, collidePair, sceneContacts, createSceneCollisionTracker, sceneColliderFor,
  type SceneColliderShape, type SceneContact, type SceneCollisionEvent, type SceneCollisionTracker,
} from "./scene/collide.ts";
export {
  orbitFromCamera, orbitPosition, orbitDrag, orbitZoom,
  ORBIT_DEG_PER_PX, ORBIT_ZOOM_RATE, ORBIT_PITCH_LIMIT_DEG,
  type OrbitState,
} from "./scene/orbit.ts";
export {
  parseGlb, quaternionToMat4,
  type GlbPrimitive, type GlbMesh, type GlbDraw, type GlbModel, type GlbError,
  type GlbParseResult,
  type GlbNode, type GlbSkin, type GlbChannel, type GlbChannelPath, type GlbClip,
} from "./scene/gltf.ts";
export {
  quatSlerp, glbLocalMatrix, glbNodeWorlds, glbJointMatrices,
  skinPosition, skinnedPrimitivePositions,
  glbClipTime, sampleGlbChannel, sampleGlbClip, findGlbClip,
  sceneCrossfadeProgress, glbEffectiveTrs, blendGlbTrs, blendGlbPoses,
  createSceneClipMixer,
  SCENE_SKIN_WEIGHT_EPSILON, SCENE_SLERP_NLERP_THRESHOLD,
  SCENE_CLIP_DEFAULT_BLEND_MS, SCENE_CLIP_DEFAULT_LOOP,
  type GlbQuat, type GlbTrs, type GlbTrsOverride, type GlbPose, type SceneClipMixer,
} from "./scene/skin.ts";
export {
  createSceneFrameClock, sceneFrameSchedule, SCENE_FRAME_MIN_INTERVAL_MS,
  type SceneFramePayload, type SceneFrameClock,
} from "./scene/frame.ts";
export {
  sceneSurfaceSeam, sceneBusRegister, sceneBusUnregister, sceneBusResolve, sceneBusEmit,
  type SceneBusHandle, type SceneBusNode, type SceneBusCapture, type SceneBusListener,
  type SceneSurfaceSeam,
} from "./scene/registry.ts";
export {
  createScenePhysicsWorld, stepScenePhysicsWorld, scenePhysicsContact,
  carryScenePhysicsContactState,
  scenePhysicsInverseInertia, scenePhysicsWriteVelocity, scenePhysicsWriteAngularVelocity,
  scenePhysicsWriteTorque, scenePhysicsTeleport, scenePhysicsTeleportRotation, scenePhysicsWakeAll,
  createScenePhysicsAccumulator, scenePhysicsSchedule, scenePhysicsInterpolate,
  scenePhysicsGravity, extractScenePhysics, scenePhysicsToLocal, scenePhysicsToRoot,
  scenePhysicsRotationToLocal, scenePhysicsRotationToRoot,
  SCENE_PHYSICS_DT, SCENE_PHYSICS_MAX_STEPS, SCENE_PHYSICS_DEFAULT_GRAVITY,
  SCENE_PHYSICS_CORRECTION_PERCENT, SCENE_PHYSICS_SLOP,
  SCENE_PHYSICS_RESTITUTION_MIN_SPEED, SCENE_PHYSICS_GROUND_NORMAL_Y,
  SCENE_PHYSICS_SLEEP_SPEED, SCENE_PHYSICS_SLEEP_TICKS, SCENE_PHYSICS_SLIDE_ITERATIONS,
  SCENE_PHYSICS_MANIFOLD_ITERATIONS,
  SCENE_PHYSICS_DEFAULT_SPEED, SCENE_PHYSICS_DEFAULT_JUMP,
  SCENE_PHYSICS_DEFAULT_ANGULAR_DAMPING, SCENE_PHYSICS_RADIANS_TO_DEGREES,
  SCENE_PHYSICS_DEGREES_TO_RADIANS, SCENE_SPRITE_COLLIDER_HALF_Z, SCENE_PHYSICS_KINDS,
  type ScenePhysicsKind, type ScenePhysicsShape, type ScenePhysicsBodySpec,
  type ScenePhysicsBody, type ScenePhysicsWorld, type ScenePhysicsPairEvent,
  type ScenePhysicsStepResult, type ScenePhysicsIntent, type ScenePhysicsIntents,
  type ScenePhysicsContact, type ScenePhysicsAccumulator,
  type ScenePhysicsExtraction, type ScenePhysicsExtractedBody,
} from "./scene/physics.ts";

// U01 scroll + U10 collapsing header: the observable/drivable scrolling core.
export {
  BLUR_MAX, COLLAPSE_EPSILON, FLING_VELOCITY, FRAME_BUDGET_MS, NAV_BAR_HEIGHT, RESERVED_SCROLL_KEYS,
  SCRIM_ALPHA,
  SCRIM_START, SCROLL_EPSILON, SETTLE_MS, TITLE_HANDOFF_FRACTION, coalesceScroll, collapseState,
  evaluateScrollLinked, formatNumber, isScrollPlaneRef, maintainPositionOffset, namedScrollProperties,
  parseEdgeInsets, parseScrollConfig,
  reachEndState, resolveLinkedScope, resolveScrollCommand, resolveSnap, round4,
  scrollLinkedProperties, scrollMetrics, scrollMotion, shouldDispatchScroll, shouldEmitCollapse,
  type Align, type ChildFrame, type CoalesceResult, type CollapseInput, type CollapseState,
  type EdgeInsets, type KeyboardDismiss, type LinkedAncestor, type MaintainResult,
  type NamedScrollPlane,
  type Overscroll, type ReachEndState, type ScrollAxis, type ScrollCommand, type ScrollConfig,
  type ScrollDirection, type ScrollGeometry, type ScrollMetrics, type ScrollMotion,
  type ScrollProperties, type ScrollSample, type ScrollTarget, type SnapMode,
  type TitleTransition,
} from "./scroll.ts";
// U03 shared element transitions: matching, sampling and the transition machine.
export {
  SHARED_A11Y_FOCUS, SHARED_HANDOFF_START, SHARED_MODES, SharedTransitionMachine,
  matchSharedElements, sampleSharedPair, type SharedDirection, type SharedElement,
  type SharedGeometry, type SharedMachineSnapshot, type SharedMatch, type SharedMatchOptions,
  type SharedOutcome, type SharedPair, type SharedRect, type SharedSample, type SharedState,
} from "./shared-transition.ts";
// Inline native surfaces: the vendor session machine shared by the overlay and inline faces.
export {
  CARD_INCOMPLETE_MESSAGES, CARD_PARTS, CARD_REQUIRED_MESSAGE, VENDOR_VIEWS,
  VendorSessionMachine, cardFieldFold, cardFormField, resolveSessionRef, secretFamilyIn,
  vendorRetainKey, vendorRetainReconcile, type CardFieldFold, type CardPartState,
  type SecretFamily, type SessionRef, type SessionRefKind, type SessionRefRefusal,
  type SessionRefResolution, type VendorOutcome, type VendorRetainDiff, type VendorRetainInput,
  type VendorSessionState, type VendorStep, type VendorStepRefusal, type VendorStepResult,
  type VendorView,
} from "./vendor-session.ts";

// U05 image: content fit/position, cache policy, placeholders, priority and recycling.
export {
  CACHE_POLICIES, CACHE_POLICY_DEFAULT, CONTENT_FITS, CONTENT_FIT_DEFAULT,
  CONTENT_POSITION_DEFAULT, IMAGE_PRIORITIES, PLACEHOLDER_COLOR_TOKENS, POSITION_ANCHORS,
  TRANSITION_DURATION_DEFAULT, TRANSITION_EFFECTS, base64ByteLength, cacheTypeFor,
  classifyPlaceholder, decodeBlurhash, decodePlaceholder, decodeThumbhash, imageMediaType,
  isBlurhash, resolveCachePolicy, resolveContentFit, resolveContentPosition, resolveDecodeSize,
  resolveImagePriority, resolveRecycling, resolveTransition, shouldTransition, solveImageRect,
  type CachePolicy, type CacheResolution, type CacheType, type ContentFit, type DecodeSize,
  type DecodedPixels, type ImageLoadPayload, type ImagePriority, type ImageRect, type ImageSize,
  type PlaceholderKind, type PlaceholderResolution, type RecyclingResolution,
  type TransitionEffect, type TransitionResolution, type TransitionSpec,
} from "./image-core.ts";
// F07b lockOrientation=: the router-level claim reconcile.
export {
  orientationClaimPlan, orientationFrameSurface, orientationModalSurface, type OrientationOp,
  type OrientationPlan, type OrientationSurface,
} from "./orientation-binding.ts";

// U09 dataviz: scales, marks, interaction, clustering, camera and the accessible table.
export {
  BRUSH_MIN_FRACTION, CLUSTER_DEFAULT_RADIUS, CLUSTER_MAX_ZOOM, LOG_NONPOSITIVE_DOMAIN,
  MAP_DEFAULT_ZOOM, MAP_MAX_MERCATOR_LATITUDE, MAP_MAX_ZOOM, MAP_MIN_ZOOM, MAP_TILE_SIZE,
  TIME_TICK_LADDER, ZOOM_MIN_SPAN_FRACTION, accessibleTable, bandScale, brushWindow,
  bubbleRadius, candleBuckets, candleGeometry, clusterPins, decimalExponent, fitCamera,
  formatDatavizCell, funnelStages, heatmapCells, latitudeAtWorldY, linearScale, logDomain,
  logScale, longitudeAtWorldX, mapRegion, mercatorX, mercatorY, minimalLongitudeArc,
  nearestIndex, nearestValueIndex, niceLinearDomain, niceNumber, normalizeLongitude, panDomain,
  pieSlices, powerOfTen, radarPoints, timeTicks, valueDomain, zoomDomain, type AccessibleTable,
  type AccessibleTableSpec, type BandLayout, type BrushWindow, type CameraFit, type Candle,
  type CandleDirection, type CandleGeometry, type ClusterNode, type DomainWindow,
  type EdgePadding, type FunnelStage, type GeoPoint, type HeatmapCell, type HeatmapGrid,
  type LogDomain, type MapRegion, type NiceDomain, type PieLayout, type PieOptions,
  type PieSlice, type RadarPoint, type TimePoint, type TimeTicks, type WeightedPoint,
} from "./dataviz.ts";
// U08 forms: masking, phone, the date fold, validity and the composite controls.
export {
  FORMS_COUNTRIES, FORMS_DEFAULT_COUNTRY, formsAggregate, formsCivilFromDays, formsCountry,
  formsCountryForDial, formsDateFold, formsDateFromDay, formsDayNumber, formsDaysFromCivil,
  formsFieldError, formsFlag, formsMonthGrid, formsRule, formsSelectable, formsSubmit,
  formsWeekday, maskCapacity, maskDescription, maskEdit, maskExtract, maskFormat,
  maskSignificant, maskTokens, multiSelectAnnouncement, multiSelectToggle, phoneParse, tagsAdd,
  tagsAnnouncement, tagsBackspace, type DateFoldConfig, type DateFoldEvent, type DateFoldStep,
  type FormAggregate, type FormFieldState, type FormsCountry, type MaskEdit, type MaskToken,
  type MaskTokenKind, type MonthGrid, type MultiSelectResult, type PhoneValue,
  type Selectability, type SubmitOutcome, type SubmitState, type TagRejection,
  type TagsBackspace, type TagsConfig, type TagsResult,
} from "./forms.ts";
// U07 controls: gradients, gauge, colour folds and mask modes.
export {
  COLOR_NAMES, COLOR_PICKER_MODES, GAUGE_STYLES, GRADIENT_ANGLE_DEFAULT,
  GRADIENT_DIRECTION_ALIASES, GRADIENT_TYPES, formatHexColor, gaugeTintSegment,
  gradientUnitPoints, meshFallbackLayers, nearestColorName, parseGradientAngle,
  parseGradientColors, parseGradientRadius, parseGradientStops, parseHexColor, parseMeshPoints,
  parseUnitPoint, resolveColorPickerMode, resolveGauge, resolveGradient, resolveMask,
  resolveSwatches, webNeedsCustomColorPanel, type ColorPickerMode, type GaugeAccessibility,
  type GaugeMetrics, type GaugeResolution, type GaugeStyle, type GaugeTintSegment,
  type GradientAttributes, type GradientResolution, type GradientType, type MaskMode,
  type MaskResolution, type MaskWebLayer, type MeshFallback, type MeshGrid, type MeshLayer,
  type MeshPoint, type Rgba, type UnitPoint,
} from "./controls-core.ts";

// F04 media: pick plans, format folds, EXIF normalisation and the manipulate op chain.
export {
  EXIF_TRANSFORMS, MEDIA_FORMATS, MEDIA_FORMAT_SUPPORT, MEDIA_MAX_PIXELS, MEDIA_PICK_MAX,
  MEDIA_PICK_SOURCES, MEDIA_PICK_TYPES, MEDIA_RESIZE_FITS, exifNormalise, foldMediaFormat,
  mediaDecodeHint, mediaFormatLossless, mediaFormatPlan, mediaPickMimeTypes, mediaPickPlan,
  mediaQuality, resolveMediaOps, type MediaBox, type MediaDecodeHint, type MediaFormatPlan,
  type MediaOpsResult, type MediaOrientation, type MediaPickPlan, type MediaRect, type MediaStep,
} from "./media-core.ts";

// F02 notify: the permission ladder, the trigger resolver, the Android channel fold, the foreground-presentation fold and the tap normalisation.
export {
  NOTIFY_ANDROID_CHANNEL_SDK, NOTIFY_ANDROID_RUNTIME_PERMISSION_SDK, NOTIFY_CRON_SEARCH_DAYS,
  NOTIFY_DEFAULT_ACTION_IDS, NOTIFY_DEFAULT_CHANNEL, NOTIFY_DEFAULT_IMPORTANCE,
  NOTIFY_DEFAULT_OPTIONS, NOTIFY_DISMISS_ACTION_IDS, NOTIFY_EVENT_BYTES, NOTIFY_IMPORTANCE,
  NOTIFY_MODIFIER_OPTIONS, NOTIFY_OPTIONS, NOTIFY_PATH_BYTES, NOTIFY_PLATFORM_OPTIONS,
  NOTIFY_PRESENTATION_ALIASES, NOTIFY_PRESENTATION_WORDS, NOTIFY_REPEAT_UNITS, NOTIFY_STATUSES,
  NOTIFY_URL_BYTES, NOTIFY_UTC, notifyApplyPermission, notifyChannelFold, notifyChannelRequired,
  notifyCivilFromDays, notifyCivilOf, notifyDaysFromCivil, notifyDaysInMonth, notifyFireTimes,
  notifyFromWall, notifyImportance, notifyObservePermission, notifyOffsetAt, notifyOpenPayload,
  notifyParseCron, notifyParseInstant, notifyPermissionPlan, notifyPresentation,
  notifyRoutingRecord, notifyToWall, notifyWallOf, notifyWeekday, type NotifyChannelFold,
  type NotifyChannelRequirement, type NotifyChannelState, type NotifyCivil, type NotifyCronSpec,
  type NotifyFirePlan, type NotifyImportance, type NotifyImportanceResolution,
  type NotifyObserved, type NotifyOpenPayload, type NotifyPermissionPlan,
  type NotifyPermissionRequest, type NotifyPermissionState, type NotifyPresentation,
  type NotifyRawOpen, type NotifyRoutingRecord, type NotifyTrigger, type NotifyZoneRules,
  type NotifyZoneTransition,
} from "./notify.ts";

// U04 canvas: path parsing, transforms, gradients, fill rules, the display list and frame scheduling.
export {
  CANVAS_A11Y_LINT_CODE, CANVAS_A11Y_LINT_MESSAGE, CANVAS_BLACK, CANVAS_COLOR_TOKENS,
  CANVAS_FALLBACK_ADVANCE, CANVAS_FALLBACK_ASCENT, CANVAS_FALLBACK_DESCENT,
  CANVAS_FLATTEN_SEGMENTS, CANVAS_FRAME_MIN_INTERVAL_MS, CANVAS_GESTURE_HANDLERS,
  CANVAS_IDENTITY, CanvasFrameLoop, CanvasRecorder, buildCanvasDisplayList, canvasA11y,
  canvasApply, canvasArcToCubics, canvasContains, canvasCrossingsAt, canvasEllipsePath,
  canvasEscapeXml, canvasFallbackMetrics, canvasFlatten, canvasFrameSchedule, canvasGradientT,
  canvasMatMul, canvasMatrixIsIdentity, canvasNumberText, canvasPathArea, canvasPathBBox,
  canvasRectPath, canvasRgbaHex, canvasToSvg, canvasWindingAt, diffCanvasDisplayList,
  normalizeCanvasStops, parseCanvasPaint, parseCanvasPath, parseCanvasRgba, parseCanvasTransform,
  runCanvasScript, sampleCanvasStops, type CanvasA11yChild, type CanvasA11yLint,
  type CanvasA11yVerdict, type CanvasBBox, type CanvasClip, type CanvasCommand,
  type CanvasDiffEntry, type CanvasDisplayList, type CanvasDrawEntry, type CanvasEffect,
  type CanvasFillRule, type CanvasFrameEvent, type CanvasFrameFold, type CanvasFramePayload,
  type CanvasGradient, type CanvasGradientKind, type CanvasMarkupNode, type CanvasMatrix,
  type CanvasMeasurement, type CanvasOp, type CanvasPaint, type CanvasPaintParse,
  type CanvasPathParse, type CanvasRgba, type CanvasScriptResult, type CanvasSegment,
  type CanvasShadow, type CanvasStop, type CanvasStopInput, type CanvasStopsParse,
  type CanvasTransformParse,
} from "./canvas-core.ts";

// F05 net: the classification fold, the online split, the radio map, the probe verdict and the debounce machine.
export {
  NET_TUNNEL_PREFIXES, NET_TYPES, NET_UNKNOWN, NetDebounce, classifyPath, isOnline,
  netSnapshotsEqual, probeReachable, radioGeneration, type NetChange, type NetPathInput,
  type NetSnapshot,
} from "./net-core.ts";
// <canvas>'s `<ink>` primitive: the wire shape, the capture folds, the ink curve and the
// tier-1 nodes a committed drawing becomes (canvas/ink.json).
export {
  INK_COORDINATE_SCALE, INK_LINECAP, INK_LINEJOIN, INK_MIN_POINT_DISTANCE, INK_STROKE_WIDTH,
  decodeInk, encodeInk, inkFarEnough, inkNodes, inkOps, inkPathData, inkPoint,
  type InkOp, type InkPoint, type InkStroke,
} from "./ink-core.ts";
// F12 contacts: paging, access decisions, label normalisation and the picker outcome.
export {
  CONTACTS_INVALID_MESSAGE, CONTACTS_PERMISSION_SURFACE, CONTACTS_READ_REFUSAL,
  CONTACTS_RESTRICTED_MESSAGE, CONTACTS_WRITE_REFUSAL, CONTACT_LABELS, CONTACT_MAX_PAGE,
  CONTACT_UNNAMED, clampContactLimit, contactBirthday, contactCollectedPage, contactDisplayName,
  contactPage, contactPickOutcome, contactReadCount, contactReadDecision, contactWriteDecision,
  isMeaningfulContact, normalizeContactLabel, subsetContact, type ContactPage,
  type ContactPickInput, type ContactPickOutcome, type ContactsDecision,
} from "./contacts-core.ts";
// F12 calendar: spans, the date grammar, access decisions, the editor fidelity ladder and RFC 5545 round-trips.
export {
  CALENDAR_INVALID_DATE, CALENDAR_INVALID_DATE_MESSAGE, CALENDAR_INVALID_RECURRENCE,
  CALENDAR_INVALID_RECURRENCE_MESSAGE, CALENDAR_PERMISSION_SURFACE, CALENDAR_READ_REFUSAL,
  CALENDAR_RESULT_FIDELITY, CALENDAR_WITH_ID_REFUSAL, CALENDAR_WRITE_REFUSAL, RRULE_DAYS,
  RRULE_FREQUENCIES, calendarAccessDecision, calendarPresentOutcome, calendarRemindersSupport,
  calendarSpan, calendarTargetDecision, calendarWindow, formatRecurrence, icsInstantToISO,
  isoToICSInstant, normalizeRRule, parseCalendarDate, parseRecurrence, type CalendarDecision,
  type CalendarPresentInput, type CalendarPresentOutcome, type CalendarSpan, type RecurrenceDay,
  type RecurrenceRule,
} from "./calendar-core.ts";
// F13 compose: the result vocabulary, the fidelity ladder, capability disclosure and the recipient cap.
export {
  COMPOSE_FORBIDDEN_PERMISSIONS, COMPOSE_PERMISSION_SURFACE, COMPOSE_RESULTS,
  COMPOSE_RESULT_FIDELITY, composeAttachmentDecision, composeCapabilities, composeOutcome,
  composeRecipientDecision, composeResolverPackage, type ComposeAttachmentInput,
  type ComposeCapabilities, type ComposeCapabilitiesInput, type ComposeDecision,
  type ComposeOutcome, type ComposeOutcomeInput,
} from "./compose-core.ts";

// F17.1 link previews: metadata folds.
export {
  PREVIEW_DEFAULT_TIMEOUT_MS, PREVIEW_MAX_BYTES, PREVIEW_MAX_REDIRECTS, PREVIEW_MAX_TIMEOUT_MS,
  PREVIEW_MESSAGES, PREVIEW_MIN_TIMEOUT_MS, clampPreviewTimeout, collapsePreviewText,
  decodePreviewEntities, foldLinkPreview, normalizePreviewPath, parseLinkPreview,
  previewSiteFallback, resolvePreviewReference, resolvePreviewTarget, scanPreviewTags,
  type LinkPreview, type PreviewRefusal, type PreviewResult, type PreviewTags,
  type PreviewTarget,
} from "./linkpreview.ts";
// F17.2 pay: the payment request fold.
export {
  PAYMENT_CAPABILITIES, PAYMENT_FIELDS, PAYMENT_MAX_MINOR, PAYMENT_MESSAGES, PAYMENT_NETWORKS,
  PAYMENT_STATUSES, currencyExponent, foldCapabilities, foldFields, foldNetworks, foldStatus,
  formatAmountMinor, normalizePaymentRequest, parseAmountMinor, type PaymentLine,
  type PaymentPlan, type PaymentRefusal, type PaymentResult, type RawPaymentRequest,
} from "./payment.ts";
// F17.3 passkeys: the WebAuthn ceremony fold.
export {
  PASSKEY_ATTESTATIONS, PASSKEY_DEFAULT_TIMEOUT_MS, PASSKEY_MAX_CHALLENGE_BYTES,
  PASSKEY_MAX_TIMEOUT_MS, PASSKEY_MAX_USER_ID_BYTES, PASSKEY_MEDIATIONS, PASSKEY_MESSAGES,
  PASSKEY_MIN_CHALLENGE_BYTES, PASSKEY_MIN_TIMEOUT_MS, PASSKEY_RESIDENT_KEYS,
  PASSKEY_VERIFICATIONS, base64UrlByteLength, base64UrlDecode, base64UrlEncode,
  clampPasskeyTimeout, foldAttestation, foldMediation, foldResidentKey, foldUserVerification,
  normalizeChallenge, normalizeCreateOptions, normalizeCredentialIds, normalizeGetOptions,
  normalizeRpId, normalizeUser, type PasskeyCreateOptions, type PasskeyGetOptions,
  type PasskeyRefusal, type PasskeyResult, type PasskeyUser,
} from "./passkeys.ts";
// F17.4 integrity: the attestation bookkeeping fold.
export {
  INTEGRITY_ADVISORY, INTEGRITY_FORMATS, INTEGRITY_MAX_CHALLENGE_BYTES,
  INTEGRITY_MAX_KEY_REF_CHARS, INTEGRITY_MESSAGES, INTEGRITY_MIN_CHALLENGE_BYTES,
  INTEGRITY_PROVIDERS, integrityEnvelope, integrityFormat, integrityProviderFor,
  normalizeIntegrityChallenge, normalizeKeyRef, type IntegrityEnvelope, type IntegrityRefusal,
  type IntegrityResult,
} from "./integrity.ts";
// F17.5 system bars: the bar-appearance fold.
export {
  BAR_BEHAVIORS, BAR_DIAGNOSTICS, BAR_LUMA_THRESHOLD, BAR_MESSAGES, BAR_STYLES, IMMERSIVE_MODES,
  barIconsDark, barLuma, foldBarBehavior, foldBarStyle, foldImmersiveMode, parseBarColor,
  planSystemBars, type BarColor, type BarPlan, type BarRefusal, type BarResult,
  type RawBarRequest,
} from "./systembars.ts";
// F17.6 intents: the launch fold.
export {
  INTENT_FLAGS, INTENT_FLAG_ORDER, INTENT_MESSAGES, foldIntentFlags, intentQueries,
  normalizeIntent, normalizeIntentAction, normalizeIntentData, normalizeIntentExtras,
  normalizeIntentPackage, normalizeIntentType, type IntentFlags, type IntentQuery,
  type IntentRefusal, type IntentResult, type IntentSpec, type RawIntent,
} from "./intents.ts";
// F17.7 spotlight: the index fold.
export {
  SPOTLIGHT_BATCH_MAX, SPOTLIGHT_MAX_DESCRIPTION_CHARS, SPOTLIGHT_MAX_ID_CHARS,
  SPOTLIGHT_MAX_KEYWORDS, SPOTLIGHT_MAX_TITLE_CHARS, SPOTLIGHT_MESSAGES, chunkSearchItems,
  normalizeSearchDomain, normalizeSearchItem, normalizeSearchItems, normalizeSearchKeywords,
  parseSearchUniqueId, searchUniqueId, type RawSearchItem, type SearchItem,
  type SpotlightRefusal, type SpotlightResult,
} from "./spotlight.ts";
// F17.8 handoff: the activity fold.
export {
  HANDOFF_MAX_PAYLOAD_BYTES, HANDOFF_MAX_TITLE_CHARS, HANDOFF_MESSAGES, canonicalHandoffJson,
  handoffPayloadBytes, normalizeActivityType, normalizeHandoff, normalizeHandoffUrl,
  parseHandoffContinuation, utf8ByteLength, type HandoffActivity, type HandoffRefusal,
  type HandoffResult, type RawHandoff,
} from "./handoff.ts";
// F17.9 light sensor: the ambient fold.
export {
  LIGHT_CATEGORIES, LIGHT_DEFAULT_INTERVAL_MS, LIGHT_MAX_INTERVAL_MS, LIGHT_MIN_ABSOLUTE_CHANGE,
  LIGHT_MIN_INTERVAL_MS, LIGHT_MIN_RELATIVE_CHANGE, LIGHT_THRESHOLDS, clampLightInterval,
  lightSample, luxCategory, shouldEmitLux, type LightSample,
} from "./lightsensor.ts";

// V02 to V06 inline native surfaces: the surface gate, roster, ad slot, paywall, sign-in ladder and scan gate folds, shared by all five vendors.
export {
  AD_SIZES, PACKAGE_MONTHS, PACKAGE_ORDER, ROSTER_TIERS, SCAN_DEBOUNCE_MS, SIGNIN_STRATEGY_ORDER,
  SURFACE_GATE_MESSAGES, SURFACE_GATE_SUBJECT, adRequestGate, adSlot, paywallFold, rosterColumns,
  rosterFold, scanGate, signInLadder, surfaceGate, type AdConsent, type AdRequestCode,
  type AdRequestGate, type AdRequestGateInput, type AdSlot, type AdSlotCode, type PaywallFold,
  type PaywallFoldInput, type PaywallPackage, type RosterFold, type RosterFoldInput,
  type RosterParticipant, type ScanGate, type ScanGateInput, type ScanMode, type ScanReason,
  type SignInLadder, type SignInLadderInput, type SignInStatus, type SignInStep,
  type SurfaceCapability, type SurfaceGate, type SurfaceGateCode, type SurfaceGateInput,
  type SurfacePermission, type SurfaceRender,
} from "./vendor-surface.ts";

// U12 rive: the state-machine input fold, selection, fit/alignment, playback + residency, payloads.
export {
  RIVE_A11Y_LINT_CODE, RIVE_A11Y_LINT_MESSAGE, RIVE_ALIGNMENT_WORDS, RIVE_ERROR_MESSAGES,
  RIVE_FIT_WORDS, RIVE_FRAME_MIN_INTERVAL_MS, RIVE_GESTURE_HANDLERS, RivePlayback, riveA11y,
  riveErrorPayload, riveEventPayload, riveFit, riveInputPlan, riveLoadPayload, riveNumberText,
  rivePlaybackSchedule, riveResidency, riveSelection, riveStateChanges, type RiveA11yChild,
  type RiveA11yLint, type RiveA11yVerdict, type RiveAdvance, type RiveArtboard,
  type RiveDeclaredInput, type RiveErrorPayload, type RiveEventFold, type RiveEventPayload,
  type RiveInputKind, type RiveInputOp, type RiveInputPlan, type RiveInputRefusal,
  type RiveLoadPayload, type RiveManifest, type RivePlacement, type RivePlaybackEvent,
  type RivePlaybackFold, type RiveResidencyEvent, type RiveResidencyFold, type RiveSelection,
  type RiveSelectionError, type RiveStateChange,
} from "./rive-core.ts";

// F18 OTA runtime safety: the two decisions a device makes about a generation before applying
// it, and the publisher's validator, so `dsx ota build` refuses exactly what a device would.
export {
  compareRuntimeVersions, evaluateGeneration, otaHash32, parseRuntimeVersion, rolloutApplies,
  rolloutBucket, runtimeVersionSatisfied, type OtaClient, type OtaDecision,
  type OtaGenerationDeclaration, type OtaRollout, type OtaVerdict,
} from "./ota.ts";

// P12 localization: the kernel string-table seam (web twin of DSXStrings.swift /
// Strings.kt), corpus-gated by OpenSource/Conformance/strings/cases.json.
export { DSXStrings } from "./strings.ts";

// The SHOT plane (platform/10-screenshot-execution.md): the pure halves of automated store
// screenshots - the scope ladder that decides what "John Doe" is before anything renders, and
// the guard set that refuses an image rather than publishing an empty one. Corpus-gated by
// OpenSource/Conformance/shot/.
export {
  resolveShotScope, shotScopeVerdict, parseSample, templateToPattern, seamCollisions,
  type ShotHead, type ShotHydrate, type ShotSnapshot, type ShotOverrides, type ShotMode,
  type ShotScopeInput, type ShotScopeResult, type ShotSeamRoute, type ShotUnresolved,
} from "./shot-scope.ts";
export {
  convertLength, parseLength, lengthUnitOf, ROOT_FONT_SIZE_PX, SWITCHABLE_LENGTH_UNITS,
  DEFAULT_LENGTH_UNIT, type LengthUnit, type ParsedLength,
} from "./length-units.ts";
// film.ts is deliberately NOT re-exported here. It is toolchain logic (the marketing
// compiler's timeline - 12-marketing-video.md) that an embedded widget never runs, and the
// barrel is what the embed slicer proves reachability from: folding it in moved the locked
// media-embed qualification bytes, which the ledger pins. Same law as config-validate above -
// headroom is bought by proving absence - so it ships as the subpath export
// `@despia/kernel/film`.
export {
  evaluateShotGuards, settleHolds, readableScreen,
  type AllowEmpty, type FrameApi, type FrameCollection, type FrameDecoration, type FrameRect,
  type FrameReport, type FrameScene, type FrameSettle, type GuardFinding,
} from "./shot-guards.ts";
export {
  SHOT_DEVICES, shotDevice, shotPixelSize, checkStoreConstraints,
  type ShotDevice, type StoreConstraintFailure,
} from "./shot-devices.ts";

// A1 auth hardening: the login-trigger origin pin and the OAuth proof folds (PKCE / state /
// nonce), corpus-gated by OpenSource/Conformance/auth/{trigger,pkce}.json on three runtimes.
export {
  applyAuthorizeProofs, base64UrlDecodeUtf8, base64UrlNoPad, claimsUriScheme,
  codeChallengeS256, codeVerifierFromEntropy, constantTimeEquals, idTokenPayload,
  isAllowedAuthorizationUrl, isCodeVerifier, matchesConfiguredTrigger, normalizedPort,
  opaqueProof, planAuthorizeProofs, splitOrigin, tokenEndpointAllowed, verifyCallbackProofs,
  AUTH_PROOF_ENTROPY_BYTES, PKCE_CHALLENGE_METHOD, PKCE_VERIFIER_ENTROPY_BYTES,
  PKCE_VERIFIER_MAX_LENGTH, PKCE_VERIFIER_MIN_LENGTH,
  type AuthProofRefusal, type AuthorizeProofPlan, type CallbackVerdict, type MintedProofs,
  type UrlOrigin,
} from "./auth-proof.ts";

// keyboard.ts is deliberately NOT re-exported here. The Viewport and PreventDefault
// web facets are the production importers, and folding the decision into this barrel
// put unused gzip into every EmbedCard against the 40,960-byte G10 law (mcp.ts and
// config-validate.ts already record the same class of defect). Headroom is bought by
// proving absence. Those facets import the subpath `@despia/kernel/keyboard`; the
// conformance runner still reaches ../src/keyboard.ts directly.
