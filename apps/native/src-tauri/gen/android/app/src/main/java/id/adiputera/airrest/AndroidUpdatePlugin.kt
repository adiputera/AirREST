package id.adiputera.airrest

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

// Serializes commands across activity recreation; DownloadManager owns the actual transfer.
private val updateExecutor = Executors.newSingleThreadExecutor { work ->
    Thread(work, "airrest-apk-update").apply { isDaemon = true }
}

@TauriPlugin
class AndroidUpdatePlugin(private val activity: Activity) : Plugin(activity) {
    private val context = activity.applicationContext
    private val preferences = context.getSharedPreferences("airrest_apk_update", Context.MODE_PRIVATE)
    private val downloads = context.getSystemService(DownloadManager::class.java)
    private var verifiedFile: String? = null
    private var verifyingId: Long? = null

    private fun execute(invoke: Invoke, block: () -> Unit) {
        updateExecutor.execute {
            try {
                block()
            } catch (error: Exception) {
                Log.w("AirRESTUpdate", "command=${invoke.command} result=failed", error)
                invoke.reject(error.message ?: "Android could not complete this update action.")
            }
        }
    }

    private fun snapshot(state: String, message: String? = null, progress: Int? = null): JSObject =
        JSObject().apply {
            put("state", state)
            put("version", preferences.getString("version", null) ?: JSONObject.NULL)
            put("message", message ?: JSONObject.NULL)
            put("progress", progress ?: JSONObject.NULL)
            put("canInstall", canInstall())
        }

    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    @Suppress("DEPRECATION") // GET_SIGNATURES/versionCode are needed on API 24–27.
    private fun packageInfo(path: String? = null): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
            else PackageManager.GET_SIGNATURES
        return if (path == null) context.packageManager.getPackageInfo(context.packageName, flags)
            else requireNotNull(context.packageManager.getPackageArchiveInfo(path, flags)) {
                "The downloaded file is not a valid APK. Please retry."
            }
    }

    @Suppress("DEPRECATION") // API 24–27 do not expose longVersionCode/signingInfo.
    private fun code(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> =
        (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures)
            ?.map { it.toCharsString() }?.toSet() ?: emptySet()

    private fun externalFile(): File {
        val directory = requireNotNull(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)) {
            "Download storage is unavailable."
        }
        val name = requireNotNull(preferences.getString("file", null)) { "No APK download is saved." }
        require(Regex("[a-f0-9-]+\\.apk").matches(name)) { "Invalid saved download." }
        return File(directory, "updates/$name")
    }

    private fun stagedFile(): File = File(context.filesDir, "updates/${preferences.getLong("id", -1)}.apk")

    private fun fileKey(file: File): String = "${file.path}:${file.length()}:${file.lastModified()}"

    private fun clearDownload() {
        val id = preferences.getLong("id", -1)
        if (id >= 0) {
            downloads.remove(id)
            val staged = stagedFile()
            check(!staged.exists() || staged.delete()) { "Could not remove the previous update file." }
        }
        check(preferences.edit().clear().commit()) { "Could not clear the saved update." }
        verifiedFile = null
    }

    /** Stage privately before checking it; the installer never receives the external download file. */
    private fun validateApk(force: Boolean = false): File {
        val destination = stagedFile()
        val size = preferences.getLong("size", -1)
        if (!destination.exists()) {
            val source = externalFile()
            require(source.isFile && source.length() == size && size > 0) {
                "The APK is incomplete or missing. Please retry the download."
            }
            check(destination.parentFile?.let { it.isDirectory || it.mkdirs() } == true) {
                "Could not prepare APK storage."
            }
            try {
                source.copyTo(destination, overwrite = true)
            } catch (error: Exception) {
                destination.delete()
                throw error
            }
        }
        require(destination.isFile && destination.length() == size && size > 0) {
            "The APK is incomplete. Please retry the download."
        }
        val cacheKey = fileKey(destination)
        if (!force && verifiedFile == cacheKey) return destination
        preferences.getString("digest", null)?.let { expected ->
            val digest = MessageDigest.getInstance("SHA-256")
            destination.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                var count = input.read(buffer)
                while (count != -1) {
                    digest.update(buffer, 0, count)
                    count = input.read(buffer)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            require(actual.equals(expected.removePrefix("sha256:"), ignoreCase = true)) {
                "The APK checksum does not match the release. Please retry."
            }
        }
        val archive = packageInfo(destination.path)
        val installed = packageInfo()
        val version = requireNotNull(preferences.getString("version", null))
        require(archive.packageName == context.packageName && archive.versionName == version &&
            code(archive) == UpdatePolicy.versionCode(version) && code(archive) > code(installed)) {
            "The APK does not match this update or is not newer than the installed app."
        }
        require(UpdatePolicy.sameSigners(signers(installed), signers(archive))) {
            "This APK has a different signing key. Install an update from the same distribution as this app."
        }
        verifiedFile = cacheKey
        Log.i("AirRESTUpdate", "downloadId=${preferences.getLong("id", -1)} result=verified")
        return destination
    }

    private fun readStatus(): JSObject {
        val id = preferences.getLong("id", -1)
        if (id < 0) return snapshot("idle")
        val version = requireNotNull(preferences.getString("version", null))
        if (code(packageInfo()) >= UpdatePolicy.versionCode(version)) {
            clearDownload()
            return snapshot("idle")
        }
        preferences.getString("error", null)?.let { return snapshot("failed", it) }
        downloads.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
            if (!cursor.moveToFirst()) return snapshot("failed", "The download was removed. Please retry.")
            val phase = UpdatePolicy.phase(cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)))
            val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            if (phase == "verifying") {
                if (stagedFile().isFile && verifiedFile == fileKey(stagedFile())) {
                    return snapshot("ready", progress = 100)
                }
                if (verifyingId != id) {
                    verifyingId = id
                    updateExecutor.execute {
                        try {
                            if (preferences.getLong("id", -1) == id) validateApk()
                        } catch (error: Exception) {
                            val message = error.message ?: "APK verification failed. Please retry."
                            preferences.edit().putString("error", message).apply()
                            Log.w("AirRESTUpdate", "downloadId=$id result=verification_failed", error)
                        } finally {
                            verifyingId = null
                        }
                    }
                }
                return snapshot("verifying")
            }
            val message = when (phase) {
                "paused" -> "Download paused by Android (reason $reason). Waiting to resume; you can cancel and retry."
                "failed" -> when (reason) {
                    DownloadManager.ERROR_INSUFFICIENT_SPACE -> "Not enough storage. Free some space and retry."
                    DownloadManager.ERROR_DEVICE_NOT_FOUND -> "Download storage is unavailable. Please retry."
                    else -> "Download failed (reason $reason). Please retry."
                }
                else -> null
            }
            return snapshot(phase, message, UpdatePolicy.progress(
                cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
                cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
            ))
        }
        return snapshot("failed", "Android could not find the download. Please retry.")
    }

    @Command
    fun status(invoke: Invoke) = execute(invoke) { invoke.resolve(readStatus()) }

    @Command
    fun start(invoke: Invoke) = execute(invoke) {
        val args = invoke.getArgs()
        val release = args.getString("version")
        val version = UpdatePolicy.version(release)
        require(UpdatePolicy.versionCode(version) > code(packageInfo())) { "This version is already installed." }
        val list = args.getJSONArray("assets")
        val assets = (0 until list.length()).map { index ->
            val asset = list.getJSONObject(index)
            UpdateAsset(asset.getString("name"), asset.getString("browser_download_url"),
                asset.optLong("size", 0), if (asset.isNull("digest")) null else asset.getString("digest"))
        }
        val asset = UpdatePolicy.selectAsset(assets, release, Build.SUPPORTED_ABIS.toList())
        val current = readStatus()
        if (current.getString("state") in listOf("pending", "downloading", "paused", "verifying", "ready")) {
            invoke.resolve(current)
            return@execute
        }
        clearDownload()
        val directory = File(requireNotNull(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)) {
            "Download storage is unavailable."
        }, "updates")
        check(directory.isDirectory || directory.mkdirs()) { "Could not prepare download storage." }
        val fileName = "${UUID.randomUUID()}.apk"
        val request = DownloadManager.Request(Uri.parse(asset.url))
            .setTitle("AirREST $version")
            .setDescription("Return to AirREST when the download finishes to install the update.")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "updates/$fileName")
        val id = downloads.enqueue(request)
        if (!preferences.edit().putLong("id", id).putString("version", version)
                .putString("file", fileName).putLong("size", asset.size).putString("digest", asset.digest).commit()) {
            downloads.remove(id)
            error("Could not save the download. Please retry.")
        }
        Log.i("AirRESTUpdate", "downloadId=$id version=$version result=queued")
        invoke.resolve(readStatus())
    }

    @Command
    fun cancel(invoke: Invoke) = execute(invoke) {
        clearDownload()
        invoke.resolve(snapshot("idle"))
    }

    @Command
    fun install(invoke: Invoke) = execute(invoke) {
        check(readStatus().getString("state") == "ready") { "The APK is not ready to install." }
        val file = validateApk(force = true)
        activity.runOnUiThread {
            try {
                val permissionRequired = !canInstall()
                if (permissionRequired && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${context.packageName}")))
                } else {
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                    activity.startActivity(Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                }
                invoke.resolve(JSObject().put("action", if (permissionRequired) "permissionRequired" else "installerOpened"))
            } catch (error: Exception) {
                Log.w("AirRESTUpdate", "command=install result=failed", error)
                invoke.reject("Could not open Android's installer or installation settings. ${error.message ?: ""}")
            }
        }
    }
}
