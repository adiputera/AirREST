package id.adiputera.airrest

import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
    private fun asset(arch: String = "arm64") = UpdateAsset(
        "airrest-1.3.4-android-$arch.apk",
        "https://github.com/adiputera/AirREST/releases/download/v1.3.4/airrest-1.3.4-android-$arch.apk",
        1024, null,
    )

    @Test fun selectsApkUsingNativeAbiOrder() {
        val assets = listOf(asset(), asset("x86_64"))
        assertEquals(asset(), UpdatePolicy.selectAsset(assets, "v1.3.4", listOf("arm64-v8a", "armeabi-v7a")))
        assertEquals(asset("x86_64"), UpdatePolicy.selectAsset(assets, "v1.3.4", listOf("x86_64", "x86")))
    }

    @Test fun neverFallsBackToAnIncompatibleApk() {
        assertThrows(IllegalArgumentException::class.java) {
            UpdatePolicy.selectAsset(listOf(asset()), "v1.3.4", listOf("x86_64"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            UpdatePolicy.selectAsset(listOf(asset()), "v1.3.4", listOf("armeabi-v7a"))
        }
    }

    @Test fun rejectsUntrustedUrlsAndInvalidMetadata() {
        val good = asset()
        val invalid = listOf(
            good.copy(url = good.url.replace("https:", "http:")),
            good.copy(url = good.url.replace("github.com", "github.com.example.com")),
            good.copy(url = good.url.replace("adiputera/AirREST", "example/other")),
            good.copy(url = good.url.replace("/v1.3.4/", "/v1.3.3/")),
            good.copy(url = good.url + "?redirect=example.com"),
            good.copy(url = good.url.replace("github.com", "user@github.com")),
            good.copy(size = 0), good.copy(digest = "sha256:bad"),
        )
        invalid.forEach { value ->
            assertThrows(IllegalArgumentException::class.java) {
                UpdatePolicy.selectAsset(listOf(value), "v1.3.4", listOf("arm64-v8a"))
            }
        }
    }

    @Test fun byteProgressDoesNotMeanDownloadCompleted() {
        assertEquals(99, UpdatePolicy.progress(1024, 1024))
        assertEquals("downloading", UpdatePolicy.phase(2))
        assertEquals("verifying", UpdatePolicy.phase(8))
        assertEquals("failed", UpdatePolicy.phase(16))
        assertEquals("paused", UpdatePolicy.phase(4))
        assertNull(UpdatePolicy.progress(128, -1))
        assertEquals(50, UpdatePolicy.progress(512, 1024))
    }

    @Test fun versionsFollowReleaseVersionCodeAndRejectPreReleases() {
        assertEquals("1.3.4", UpdatePolicy.version("android-v1.3.4"))
        assertEquals(1003004L, UpdatePolicy.versionCode("1.3.4"))
        listOf("v1.3.4-beta", "../1.3.4", "1.3", "1.1000.0").forEach {
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.version(it) }
        }
    }

    @Test fun mismatchedOrMissingSigningKeysCannotBeInstalled() {
        assertTrue(UpdatePolicy.sameSigners(setOf("release-key"), setOf("release-key")))
        assertFalse(UpdatePolicy.sameSigners(setOf("debug-key"), setOf("release-key")))
        assertFalse(UpdatePolicy.sameSigners(emptySet(), emptySet()))
        assertFalse(UpdatePolicy.sameSigners(setOf("key-a", "key-b"), setOf("key-a")))
    }
}
