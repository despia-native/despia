package despia.engine.render

import android.os.Build
import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import despia.engine.render.elements.MediaInputPolicy
import java.io.File
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MediaInputPolicyInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var root: File

    @Before fun setUp() {
        assertTrue(Build.VERSION.SDK_INT >= 24)
        root = File(context.cacheDir, "dsx-media-${UUID.randomUUID()}")
        assertTrue(root.mkdirs())
    }

    @After fun tearDown() {
        root.deleteRecursively()
    }

    @Test fun descriptorReadIsBoundedAndPrivateRootsExcludeExternalStorage() {
        val bytes = byteArrayOf(1, 2, 3)
        val file = File(root, "image.bin").apply { writeBytes(bytes) }
        assertTrue(bytes.contentEquals(
            MediaInputPolicy.readSandboxedRegularFile(file.path, listOf(root), bytes.size)
        ))
        assertNull(MediaInputPolicy.readSandboxedRegularFile(file.path, listOf(root), bytes.size - 1))

        val privateRoots = MediaInputPolicy.appPrivateRoots(context).map { it.canonicalPath }.toSet()
        assertEquals(4, privateRoots.size)
        context.externalCacheDir?.let { assertFalse(privateRoots.contains(it.canonicalPath)) }
        context.getExternalFilesDirs(null).filterNotNull().forEach {
            assertFalse(privateRoots.contains(it.canonicalPath))
        }
    }

    @Test fun finalComponentSwapToSymlinkFailsClosed() {
        val candidate = File(root, "candidate.bin").apply { writeText("inside") }
        val outside = File(context.filesDir, "dsx-media-outside-${UUID.randomUUID()}.bin")
            .apply { writeText("outside-secret") }
        try {
            var swapped = false
            val result = MediaInputPolicy.readSandboxedRegularFile(
                candidate.path,
                listOf(root),
                1_024,
            ) {
                swapped = candidate.delete() && runCatching {
                    Os.symlink(outside.path, candidate.path)
                }.isSuccess
            }
            assertTrue(swapped)
            assertNull(result)
        } finally {
            candidate.delete()
            outside.delete()
        }
    }

    @Test fun directoryComponentSwapToSymlinkFailsDescriptorIdentityCheck() {
        val directory = File(root, "child").apply { assertTrue(mkdirs()) }
        val parked = File(root, "child-parked")
        val candidate = File(directory, "image.bin").apply { writeText("inside") }
        val outsideDirectory = File(context.filesDir, "dsx-media-dir-${UUID.randomUUID()}")
            .apply { assertTrue(mkdirs()) }
        File(outsideDirectory, "image.bin").writeText("outside-secret")
        try {
            var swapped = false
            val result = MediaInputPolicy.readSandboxedRegularFile(
                candidate.path,
                listOf(root),
                1_024,
            ) {
                swapped = directory.renameTo(parked) && runCatching {
                    Os.symlink(outsideDirectory.path, directory.path)
                }.isSuccess
            }
            assertTrue(swapped)
            assertNull(result)
        } finally {
            directory.delete()
            parked.renameTo(directory)
            outsideDirectory.deleteRecursively()
        }
    }

    @Test fun hardLinkToFileOutsideAllowedRootFailsClosedWhenSupported() {
        val outside = File(context.filesDir, "dsx-media-hardlink-${UUID.randomUUID()}.bin")
            .apply { writeText("outside-secret") }
        val link = File(root, "linked.bin")
        val linked = runCatching { Os.link(outside.path, link.path) }.isSuccess
        try {
            assumeTrue("filesystem does not permit app-private hard links", linked)
            assertNull(MediaInputPolicy.readSandboxedRegularFile(link.path, listOf(root), 1_024))
        } finally {
            link.delete()
            outside.delete()
        }
    }
}
