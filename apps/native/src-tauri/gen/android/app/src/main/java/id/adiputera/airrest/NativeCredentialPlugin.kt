package id.adiputera.airrest

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val credentialKeyAlias = "airrest.native.credentials.v1"
private const val credentialPreferences = "airrest_native_credentials"
private const val nonceLength = 12
private const val gcmTagLengthBits = 128
private const val maxCredentialScopeLength = 512
private const val maxCredentialValueLength = 16 * 1024

private val credentialExecutor = Executors.newSingleThreadExecutor { work ->
    Thread(work, "airrest-native-credential").apply { isDaemon = true }
}

@TauriPlugin
class NativeCredentialPlugin(activity: Activity) : Plugin(activity) {
    private val context = activity.applicationContext
    private val preferences = context.getSharedPreferences(credentialPreferences, Context.MODE_PRIVATE)

    private fun execute(invoke: Invoke, block: () -> Unit) {
        credentialExecutor.execute {
            try {
                block()
            } catch (error: Exception) {
                // Credential contents and scope values must never be logged.
                invoke.reject(error.message ?: "Protected credential storage failed.")
            }
        }
    }

    private fun scopeFrom(invoke: Invoke): String {
        val scope = invoke.parseArgs(JSONObject::class.java).getString("scope")
        require(scope.isNotEmpty() && scope.length <= maxCredentialScopeLength && scope.none(Char::isISOControl)) {
            "Invalid protected credential scope."
        }
        return scope
    }

    private fun preferenceKey(scope: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray(StandardCharsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte) }
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(credentialKeyAlias, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val specification = KeyGenParameterSpec.Builder(
            credentialKeyAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(specification)
        return generator.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // AndroidKeyStore requires the provider to generate a fresh IV when
        // randomized encryption is enabled. Supplying one is rejected.
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val nonce = cipher.iv
        require(nonce.size == nonceLength) { "Protected credential encryption failed." }
        val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return Base64.encodeToString(nonce, Base64.NO_WRAP) + "." +
            Base64.encodeToString(ciphertext, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        val parts = value.split('.', limit = 2)
        require(parts.size == 2) { "Protected credential data is malformed." }
        val nonce = Base64.decode(parts[0], Base64.NO_WRAP)
        require(nonce.size == nonceLength) { "Protected credential data is malformed." }
        val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(gcmTagLengthBits, nonce))
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    @Command
    fun read(invoke: Invoke) = execute(invoke) {
        val encrypted = preferences.getString(preferenceKey(scopeFrom(invoke)), null)
        val value = encrypted?.let(::decrypt)
        invoke.resolve(JSObject().put("value", value ?: org.json.JSONObject.NULL))
    }

    @Command
    fun write(invoke: Invoke) = execute(invoke) {
        val args = invoke.parseArgs(JSONObject::class.java)
        val scope = scopeFrom(invoke)
        val value = args.getString("value")
        require(value.isNotEmpty() && value.length <= maxCredentialValueLength) {
            "Invalid protected credential value."
        }
        check(preferences.edit().putString(preferenceKey(scope), encrypt(value)).commit()) {
            "Could not save protected credentials."
        }
        invoke.resolve()
    }

    @Command
    fun remove(invoke: Invoke) = execute(invoke) {
        check(preferences.edit().remove(preferenceKey(scopeFrom(invoke))).commit()) {
            "Could not remove protected credentials."
        }
        invoke.resolve()
    }
}
