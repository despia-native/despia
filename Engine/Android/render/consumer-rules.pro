# API 24 loads and verifies ImageElementsKt during app startup. Keep the API-28
# implementation as a separate optimization boundary so R8 cannot inline ImageDecoder
# or AnimatedImageDrawable references back into that minimum-SDK-loaded class.
-keep,allowshrinking,allowobfuscation class despia.engine.render.elements.ImageApi28Impl {
    *;
}
-keep,allowshrinking,allowobfuscation class despia.engine.render.elements.ImageApi28Impl$* {
    *;
}
