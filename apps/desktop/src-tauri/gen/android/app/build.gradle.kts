import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release credentials are supplied by the developer or CI, never stored here.
val signingNames = listOf(
    "AIRREST_ANDROID_KEYSTORE_PATH",
    "AIRREST_ANDROID_KEYSTORE_PASSWORD",
    "AIRREST_ANDROID_KEY_ALIAS",
    "AIRREST_ANDROID_KEY_PASSWORD",
)
val signingValues = signingNames.associateWith { providers.environmentVariable(it).orNull }
val signingConfigured = signingValues.values.any { !it.isNullOrBlank() }
if (signingConfigured) {
    val missing = signingNames.filter { signingValues[it].isNullOrBlank() }
    require(missing.isEmpty()) { "Incomplete Android release signing configuration; missing: ${missing.joinToString()}" }
    require(file(signingValues.getValue("AIRREST_ANDROID_KEYSTORE_PATH")!!).isFile) {
        "Android release keystore file does not exist"
    }
}

android {
    compileSdk = 36
    namespace = "id.adiputera.airrest"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "id.adiputera.airrest"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (signingConfigured) {
            create("airrestRelease") {
                storeFile = file(signingValues.getValue("AIRREST_ANDROID_KEYSTORE_PATH")!!)
                storePassword = signingValues.getValue("AIRREST_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValues.getValue("AIRREST_ANDROID_KEY_ALIAS")
                keyPassword = signingValues.getValue("AIRREST_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (signingConfigured) signingConfig = signingConfigs.getByName("airrestRelease")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
