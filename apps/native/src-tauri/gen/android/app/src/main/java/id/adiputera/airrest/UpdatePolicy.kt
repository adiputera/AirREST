package id.adiputera.airrest

import java.net.URI

internal data class UpdateAsset(val name: String, val url: String, val size: Long, val digest: String?)

/** Release and transfer rules without Android I/O, also used by JVM tests. */
internal object UpdatePolicy {
    fun version(value: String): String {
        val normalized = value.replace(Regex("^(android-|desktop-)?v?"), "")
        require(Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(normalized)) {
            "Only stable release versions can be installed."
        }
        versionCode(normalized)
        return normalized
    }

    fun versionCode(version: String): Long {
        val parts = version.split('.').map { it.toLong() }
        require(parts.size == 3 && parts[0] in 0..2099 && parts[1] in 0..999 && parts[2] in 0..999) {
            "Invalid update version."
        }
        return parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
    }

    fun selectAsset(assets: List<UpdateAsset>, release: String, abis: List<String>): UpdateAsset {
        val version = version(release)
        val architectures = abis.mapNotNull {
            when (it) {
                "arm64-v8a" -> "arm64"
                "x86_64" -> "x86_64"
                else -> null
            }
        }
        val asset = architectures.firstNotNullOfOrNull { arch ->
            assets.find { it.name == "airrest-$version-android-$arch.apk" }
        } ?: throw IllegalArgumentException("No APK is available for this device's architecture.")
        val uri = URI(asset.url)
        require(uri.scheme == "https" && uri.host == "github.com" && uri.port == -1 &&
            uri.userInfo == null && uri.query == null && uri.fragment == null &&
            uri.rawPath == "/adiputera/AirREST/releases/download/$release/${asset.name}") {
            "The APK must come from the official AirREST release."
        }
        require(asset.size > 0) { "The release does not contain a valid APK size." }
        require(asset.digest == null || Regex("sha256:[a-fA-F0-9]{64}").matches(asset.digest)) {
            "The release contains an invalid APK checksum."
        }
        return asset
    }

    // DownloadManager states: pending, running, paused, successful, failed.
    fun phase(status: Int): String = when (status) {
        1 -> "pending"
        2 -> "downloading"
        4 -> "paused"
        8 -> "verifying"
        else -> "failed"
    }

    fun progress(bytes: Long, total: Long): Int? =
        if (total <= 0) null else ((bytes.toDouble() / total) * 100).toInt().coerceIn(0, 99)

    fun sameSigners(installed: Set<String>, archive: Set<String>): Boolean =
        installed.isNotEmpty() && installed == archive
}
