package id.adiputera.airrest

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class AndroidUpdatePlugin(private val activity: Activity) : Plugin(activity) {
    private val context = activity.applicationContext

    override fun load(webView: WebView) {
        // Best-effort cleanup of staged APKs and preferences left by legacy in-app updater builds.
        Thread({
            runCatching { File(context.filesDir, "updates").deleteRecursively() }
            runCatching {
                context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                    ?.let { File(it, "updates").deleteRecursively() }
            }
            runCatching { context.deleteSharedPreferences("airrest_apk_update") }
        }, "airrest-update-cleanup").apply { isDaemon = true }.start()
    }

    @Suppress("DEPRECATION") // API 24–27 do not expose longVersionCode.
    private fun installedVersionCode(): Long {
        val info: PackageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }

    private fun openInExternalBrowser(url: String, onComplete: (Result<Unit>) -> Unit) {
        val uri = Uri.parse(url)
        activity.runOnUiThread {
            val browserSelector = Intent(Intent.ACTION_VIEW, Uri.parse("https://"))
                .addCategory(Intent.CATEGORY_BROWSABLE)
            val selectedIntent = Intent(Intent.ACTION_VIEW, uri).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                selector = browserSelector
            }
            val fallbackIntent = Intent(Intent.ACTION_VIEW, uri).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                try {
                    activity.startActivity(selectedIntent)
                } catch (_: ActivityNotFoundException) {
                    activity.startActivity(fallbackIntent)
                }
                onComplete(Result.success(Unit))
            } catch (error: Exception) {
                Log.w("AirRESTUpdate", "openInExternalBrowser failed", error)
                onComplete(
                    Result.failure(
                        IllegalStateException("No external browser was found to open the update link.", error),
                    ),
                )
            }
        }
    }

    @Command
    fun download(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val release = args.getString("version")
            val htmlUrl = args.getString("htmlUrl")
            val version = UpdatePolicy.version(release)
            require(UpdatePolicy.versionCode(version) > installedVersionCode()) {
                "This version is already installed."
            }
            val validatedReleaseUrl = UpdatePolicy.validateReleaseUrl(htmlUrl, release)
            val list = args.getJSONArray("assets")
            val assets = (0 until list.length()).map { index ->
                val asset = list.getJSONObject(index)
                UpdateAsset(
                    asset.getString("name"),
                    asset.getString("browser_download_url"),
                    asset.optLong("size", 0),
                    if (asset.isNull("digest")) null else asset.getString("digest"),
                )
            }
            val asset = UpdatePolicy.selectAssetOrNull(assets, release, Build.SUPPORTED_ABIS.toList())
            val targetUrl = asset?.url ?: validatedReleaseUrl
            val targetKind = if (asset != null) "apk" else "releasePage"
            openInExternalBrowser(targetUrl) { result ->
                result.fold(
                    onSuccess = {
                        invoke.resolve(JSObject().put("target", targetKind).put("url", targetUrl))
                    },
                    onFailure = { error ->
                        invoke.reject(error.message ?: "No external browser was found to open the update link.")
                    },
                )
            }
        } catch (error: Exception) {
            Log.w("AirRESTUpdate", "command=download result=failed", error)
            invoke.reject(error.message ?: "Could not open the update download in your browser.")
        }
    }

    @Command
    fun browse(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val release = args.getString("version")
            val url = args.getString("url")
            val validatedUrl = UpdatePolicy.validateReleaseUrl(url, release)
            openInExternalBrowser(validatedUrl) { result ->
                result.fold(
                    onSuccess = {
                        invoke.resolve(JSObject().put("target", "releasePage").put("url", validatedUrl))
                    },
                    onFailure = { error ->
                        invoke.reject(error.message ?: "No external browser was found to open the release page.")
                    },
                )
            }
        } catch (error: Exception) {
            Log.w("AirRESTUpdate", "command=browse result=failed", error)
            invoke.reject(error.message ?: "Could not open the release page in your browser.")
        }
    }
}
