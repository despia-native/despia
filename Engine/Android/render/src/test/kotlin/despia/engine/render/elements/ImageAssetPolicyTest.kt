package despia.engine.render.elements

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageAssetPolicyTest {
    @Test
    fun onlyTheCrossPlatformAppLogoNameUsesTheApplicationIconFallback() {
        assertTrue(ImageAssetPolicy.usesApplicationIconFallback("AppLogo"))
        assertFalse(ImageAssetPolicy.usesApplicationIconFallback("applogo"))
        assertFalse(ImageAssetPolicy.usesApplicationIconFallback("AppLogo.png"))
        assertFalse(ImageAssetPolicy.usesApplicationIconFallback("MissingLogo"))
    }
}
