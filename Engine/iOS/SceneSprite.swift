//
//  SceneSprite.swift - the DSX Scene 2D primitive, the Swift twin of the web kernel's
//  scene/sprite.ts and Android's SceneSprite.kt (dsx-game.md G6), corpus
//  OpenSource/Conformance/scene/sprite.json. Foundation-only — the NUMBERS only; the
//  SceneKit adapter (SceneElement) paints them and owns the texture I/O.
//
//  - THE QUAD LAW: `<sprite src size position rotation scale color anchor flip>` is a
//    TEXTURED QUAD in the node's LOCAL XY plane facing +Z, riding the node's world
//    transform exactly like `<plane>`. In mode="2d" that IS camera-facing (the
//    orthographic camera looks down −Z); BILLBOARDING IN 3D IS A NAMED ABSENCE.
//  - THE SIZE DEFAULT: unauthored, the quad is 1 unit TALL and as wide as the TEXTURE
//    ASPECT (1 when the texture is unknown or still loading — the honest square).
//  - THE ANCHOR LAW: the quad CENTER sits at (−ax·w, −ay·h, 0) from the node origin.
//  - THE SHEET LAW: `frames` is "N" (a single row) or "cols rows" (2-D packed,
//    EXPLICIT — the kernel never guesses); frame n maps ROW-MAJOR to a UV rectangle
//    whose v0 is the frame's TOP edge (the P4 UV law verbatim). `flip` mirrors it.
//  - THE FPS LAW: a positive `fps` OWNS the index — advanced = floor(elapsed × fps),
//    wrapped by `loop` — riding the SAME frame clock on:frame rides, never a second loop.
//  - THE 2D DRAW ORDER: z IS the draw order; `sceneDrawOrder2d` sorts world z ASCENDING
//    (stable) and the adapter layers the nodes in that order.
//

import Foundation

/// the sprite quad's layout in the node's LOCAL frame
struct SpriteQuad {
    /// the quad CENTER's offset from the node origin (the anchor law)
    let center: [Double]
    let halfWidth: Double
    let halfHeight: Double
    /// the frame's UV rectangle [u0, v0, u1, v1]; v0 is the frame's TOP edge
    let uv: [Double]
}

enum SceneSprite {

    /// the unauthored quad height in scene units — the width follows the texture aspect
    static let defaultHeight = 1.0

    /// THE SIZE LAW: an authored `size` wins; otherwise height = defaultHeight and
    /// width = the texture aspect (image width / height) at that height, falling back
    /// to a square when the aspect is unknown, non-finite or non-positive.
    static func sizeOf(_ props: SceneNodeProps, _ textureAspect: Double? = nil) -> [Double] {
        if props.spriteSizeAuthored { return [props.spriteSize[0], props.spriteSize[1]] }
        let aspect = textureAspect ?? 1
        let width = (aspect.isFinite && aspect > 0) ? aspect : 1
        return [width * defaultHeight, defaultHeight]
    }

    /// THE ANCHOR LAW: the quad CENTER offset from the node origin
    static func anchorOffset(_ props: SceneNodeProps, _ width: Double, _ height: Double) -> [Double] {
        let anchor = SceneIRKit.spriteAnchors[props.spriteAnchor] ?? [0, 0]
        return [-anchor[0] * width, -anchor[1] * height, 0]
    }

    /// the sheet's total cell count (cols · rows; 1 when no sheet is authored)
    static func frameCount(_ props: SceneNodeProps) -> Int {
        props.spriteFrames[0] * props.spriteFrames[1]
    }

    /// THE UV RECTANGLE LAW: frame n row-major over the [cols, rows] grid, `flip`
    /// swapping the u and/or v ends. The index arrives already floored + clamped.
    static func uvRect(_ props: SceneNodeProps, _ frame: Int) -> [Double] {
        let cols = props.spriteFrames[0]
        let rows = props.spriteFrames[1]
        let index = Swift.min(Swift.max(frame, 0), cols * rows - 1)
        let col = index % cols
        let row = index / cols
        var u0 = Double(col) / Double(cols)
        var u1 = Double(col + 1) / Double(cols)
        var v0 = Double(row) / Double(rows)
        var v1 = Double(row + 1) / Double(rows)
        if props.spriteFlip.contains("x") { swap(&u0, &u1) }
        if props.spriteFlip.contains("y") { swap(&v0, &v1) }
        return [u0, v0, u1, v1]
    }

    /// THE FPS LAW: a positive `fps` derives the index from the elapsed SECONDS on the
    /// shared frame clock — advanced = floor(elapsed × fps), wrapped (loop) or held
    /// (loop="false"); a non-positive elapsed reads frame 0. fps ≤ 0 (unauthored or
    /// malformed) hands back the authored/bound `frame` prop unchanged.
    static func frameAt(_ props: SceneNodeProps, _ elapsedSeconds: Double) -> Int {
        let total = frameCount(props)
        if props.spriteFps <= 0 || total <= 0 { return props.spriteFrame }
        guard elapsedSeconds > 0, elapsedSeconds.isFinite else { return 0 }
        let advanced = Int((elapsedSeconds * props.spriteFps).rounded(.down))
        if advanced <= 0 { return 0 }
        return props.spriteLoop ? advanced % total : Swift.min(advanced, total - 1)
    }

    /// the whole layout in one call: size (texture-aspect aware) → anchor offset → UV rect
    static func quad(_ props: SceneNodeProps, _ textureAspect: Double? = nil,
                     _ frame: Int? = nil) -> SpriteQuad {
        let size = sizeOf(props, textureAspect)
        return SpriteQuad(center: anchorOffset(props, size[0], size[1]),
                          halfWidth: size[0] / 2,
                          halfHeight: size[1] / 2,
                          uv: uvRect(props, frame ?? props.spriteFrame))
    }

    /// THE 2D DRAW-ORDER LAW: higher z draws IN FRONT, so painting runs world z
    /// ASCENDING with a STABLE sort — equal z keeps document order.
    static func drawOrder2d(_ zs: [Double]) -> [Int] {
        zs.enumerated()
            .sorted { a, b in a.element == b.element ? a.offset < b.offset : a.element < b.element }
            .map { $0.offset }
    }
}
