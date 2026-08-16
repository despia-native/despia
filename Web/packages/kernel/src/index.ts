//
//  @despia/kernel - the DSX web kernel. TS twin of OpenSource/Engine/ (see /web/01):
//  store + signals, JSE (interpreter + compiled), action runner, module bus,
//  dsx.platform. Direct DOM access lives ONLY in @despia/dom — this package is
//  DOM-free by law (surface-safe: browser, Node/SSR, workers).
//

export {
  JSE, JSESeams, StackStore, Parser, type Item,
} from "./jse/jse.ts";
export {
  NSNull, isNSNull, isDict, isLambda, number, string, truthy, jseEquals, compare,
  arith, typeofString, watchKey, asArray, asRows, safeInt, graphemes, charCount,
  trimWhitespaceOnly, swiftDouble,
  type Dict, type StackLambda, type LambdaParam, type StackFormula,
} from "./jse/values.ts";
export { tokenize, cachedTokens, type Token } from "./jse/tokens.ts";
export { JSERegex, reDoSProne } from "./jse/regex.ts";
// config-validate.ts is deliberately NOT re-exported here. It is dashboard/server logic (the
// D1 validation grammar) that an embedded widget never runs, and the barrel is what the embed
// slicer can prove reachable — folding it in cost the EmbedCard slice ~199 B of dead weight
// against the 40,960-byte G10 law. Headroom is bought by proving absence, never by raising the
// limit, so it ships as the subpath export `@despia/kernel/config-validate`.
export { DSXPathMatch } from "./jse/pathmatch.ts";
export { JSECore, JSECrypto, base64Encode, base64Decode } from "./jse/core.ts";
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
  resolveChain, RESERVED_MEMBERS, PROXY_DENYLIST,
  type WebModule, type ActionContext, type ActionHandler, type DsxContext, type Envelope,
  type ChainTable, type ChainResolution, type ModuleHandle, type ModuleProxy,
} from "./bus.ts";
export { DSXLogs, reportLog, JSERedact, type DSXLogEntry } from "./logs.ts";
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
