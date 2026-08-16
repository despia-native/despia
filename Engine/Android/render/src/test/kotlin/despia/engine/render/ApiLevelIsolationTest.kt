package despia.engine.render

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiLevelIsolationTest {
    private fun classBytes(resource: String): String {
        val stream = javaClass.getResourceAsStream(resource)
        assertNotNull("compiled class resource is missing: $resource", stream)
        return stream!!.use {
            String(it.readBytes(), StandardCharsets.ISO_8859_1)
        }
    }

    @Test fun api24LoadedImageClassHasNoApi28ImageSymbols() {
        val minimumApiClass =
            classBytes("/despia/engine/render/elements/ImageElementsKt.class")
        assertFalse(minimumApiClass.contains("android/graphics/ImageDecoder"))
        assertFalse(minimumApiClass.contains("android/graphics/drawable/AnimatedImageDrawable"))

        val api28Boundary =
            classBytes("/despia/engine/render/elements/ImageApi28Impl.class")
        assertTrue(api28Boundary.contains("android/graphics/ImageDecoder"))
        assertTrue(api28Boundary.contains("android/graphics/drawable/AnimatedImageDrawable"))
        assertTrue(api28Boundary.contains("androidx/annotation/DoNotInline"))
    }
}
