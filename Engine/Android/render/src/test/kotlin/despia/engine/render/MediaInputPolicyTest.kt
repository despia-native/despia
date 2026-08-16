package despia.engine.render

import despia.engine.render.elements.MediaInputPolicy
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaInputPolicyTest {
    @Test fun networkAndAssetNamesFailClosed() {
        assertEquals("https://example.com/image.png",
            MediaInputPolicy.validatedHttpURL("https://example.com/image.png"))
        listOf(
            "", "ftp://example.com/a", "https://", "https://u:p@example.com/a",
            "https://example.com:0/a", "https://exa mple.com/a",
        ).forEach { assertNull(it, MediaInputPolicy.validatedHttpURL(it)) }

        assertEquals("icons/a.png", MediaInputPolicy.normalizedAssetPath("icons/a.png"))
        listOf("", " ../a", "../a", "/a", "a\\b", "a:b", "a%2fb", "a//b", "a/./b")
            .forEach { assertNull(it, MediaInputPolicy.normalizedAssetPath(it)) }
    }

    @Test fun encodedReadsAndUtf8AreActuallyBounded() {
        assertArrayEquals(byteArrayOf(1, 2, 3),
            MediaInputPolicy.readBounded(ByteArrayInputStream(byteArrayOf(1, 2, 3)), 3))
        assertNull(MediaInputPolicy.readBounded(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), 3))
        assertEquals("ok", MediaInputPolicy.strictUTF8("ok".toByteArray()))
        assertNull(MediaInputPolicy.strictUTF8(byteArrayOf(0xc3.toByte(), 0x28)))
    }

    @Test fun localFilesStayInsideRegularNonSymlinkSandbox() {
        val root = Files.createTempDirectory("dsx-media-root")
        val outside = Files.createTempFile("dsx-media-outside", ".bin")
        val file = root.resolve("image.bin")
        Files.write(file, byteArrayOf(1, 2, 3))
        assertEquals(file.toFile().canonicalFile,
            MediaInputPolicy.validatedSandboxedFile(file.toString(), listOf(root.toFile()), 3)?.file)
        assertEquals(file.toFile().canonicalFile,
            MediaInputPolicy.validatedSandboxedFile(file.toUri().toString(), listOf(root.toFile()), 3)?.file)
        assertNull(MediaInputPolicy.validatedSandboxedFile(file.toString(), listOf(root.toFile()), 2))
        assertNull(MediaInputPolicy.validatedSandboxedFile(outside.toString(), listOf(root.toFile()), 100))
        assertNull(MediaInputPolicy.validatedSandboxedFile(root.toString(), listOf(root.toFile()), 100))
        assertNull(MediaInputPolicy.validatedSandboxedFile(
            root.resolve("missing/../image.bin").toString(), listOf(root.toFile()), 100))
        val prefixSibling = root.parent.resolve(root.fileName.toString() + "-sibling")
        Files.createDirectory(prefixSibling)
        val siblingFile = prefixSibling.resolve("image.bin")
        Files.write(siblingFile, byteArrayOf(9))
        assertNull(MediaInputPolicy.validatedSandboxedFile(
            siblingFile.toString(), listOf(root.toFile()), 100))
        val link = root.resolve("link")
        runCatching { Files.createSymbolicLink(link, file) }.onSuccess {
            assertNull(MediaInputPolicy.validatedSandboxedFile(link.toString(), listOf(root.toFile()), 100))
        }
        val linkedDirectory = root.resolve("linked-directory")
        runCatching { Files.createSymbolicLink(linkedDirectory, prefixSibling) }.onSuccess {
            assertNull(MediaInputPolicy.validatedSandboxedFile(
                linkedDirectory.resolve("image.bin").toString(), listOf(root.toFile()), 100))
        }
    }

    @Test fun decodeTargetsBoundPixelsFramesAndMemory() {
        val static = MediaInputPolicy.targetDimensions(100_000, 100_000)!!
        assertTrue(static.width <= MediaInputPolicy.MAXIMUM_PIXEL_DIMENSION)
        assertTrue(static.height <= MediaInputPolicy.MAXIMUM_PIXEL_DIMENSION)
        assertTrue(static.width.toLong() * static.height <= MediaInputPolicy.MAXIMUM_DECODED_PIXELS)
        assertTrue(MediaInputPolicy.decodedCostBytes(static)!! <= MediaInputPolicy.MAXIMUM_DECODED_BYTES)
        assertNull(MediaInputPolicy.targetDimensions(1, 1, MediaInputPolicy.MAXIMUM_ANIMATION_FRAMES + 1))

        val gif = Base64.getDecoder().decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
        assertEquals(1, MediaInputPolicy.encodedFrameCount(gif))
        assertNull(MediaInputPolicy.encodedFrameCount("GIF89a".toByteArray()))
    }

    @Test fun multiplyLinkedDescriptorsFailClosed() {
        assertTrue(MediaInputPolicy.acceptsRegularDescriptor(linkCount = 1, size = 3, maximumBytes = 3))
        assertFalse(MediaInputPolicy.acceptsRegularDescriptor(linkCount = 2, size = 3, maximumBytes = 3))
        assertFalse(MediaInputPolicy.acceptsRegularDescriptor(linkCount = 1, size = 4, maximumBytes = 3))
    }
}
