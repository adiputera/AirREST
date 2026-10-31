# AirREST native app

The desktop and Android targets share the React application and services in
`packages/common`. Platform-specific HTTP, file dialogs, and script execution are
provided by the Tauri adapter. The desktop updater is enabled only on desktop.

## Android development

Install a supported Node.js version, Rust, a JDK, Android SDK, platform tools,
build tools, and Android NDK. Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`;
see the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/).
Install the Rust targets required by the device and emulator, for example:

```sh
rustup target add aarch64-linux-android x86_64-linux-android
npm ci
npm run dev:android
```

The generated Android project is included in this repository. Use
`npm run android:init` only when regenerating it intentionally. The project uses
Android SDK 36. `npm run build:android` builds an ARM64 release APK, and
`npm run build:android:emulator` builds a debug APK for an x86-64 emulator.
`npm run build:android:bundle` builds an ARM64 Android App Bundle. Signing and
Android versioning must be configured for distribution.
The Android linker is configured for 16 KB native-library alignment, including
when using NDK 27. The Android CI workflow checks both ELF and APK alignment;
release builds still need verification on a 16 KB Android device.

### Release signing and versioning

Provide all four environment variables to sign release APKs and AABs during
the Gradle build: `AIRREST_ANDROID_KEYSTORE_PATH` (absolute file path),
`AIRREST_ANDROID_KEYSTORE_PASSWORD`, `AIRREST_ANDROID_KEY_ALIAS`, and
`AIRREST_ANDROID_KEY_PASSWORD`. Keep the keystore and credentials outside the
repository and supply the passwords through your local secret manager or CI
secrets. If none are set, release builds remain unsigned for local testing;
partial configuration is rejected. Debug builds use the Android debug key.
With the variables set, build both ARM64 artifacts from the repository root:

```sh
npm run --prefix apps/native tauri -- android build --apk --aab --target aarch64 --ci
```

Tauri derives `versionCode` from `tauri.conf.json` as
`major * 1000000 + minor * 1000 + patch` (0.1.4 becomes 1004). Ensure each
published build has a higher code than the previous one; when necessary, set
`bundle.android.versionCode` explicitly and maintain it with the release
version. The version name comes from the Tauri app version. Preserve the same
signing identity for updates; Play App Signing may use an upload key that is
distinct from the key used to sign delivered APKs.

To check an APK locally, run `python3 scripts/check-android-page-size.py APK`
from the repository root with `--readelf` pointing to the NDK's `llvm-readelf`
and `--zipalign` pointing to the SDK build tools' `zipalign`.

With a disposable Android emulator running, use
`python3 scripts/android-emulator-smoke.py path/to/app.apk` from the repository
root to check startup, a local HTTP request, and draft persistence after a
process restart. The script installs the APK and changes its workspace data;
use a fresh emulator rather than one containing data you want to keep.

If a build is interrupted while Tauri is compressing assets, a zero-byte file
may be left in `src-tauri/target/**/tauri-codegen-assets`. If a subsequent APK
opens to a blank screen, check for these files, remove the affected generated
cache files, and rebuild the Rust target so Tauri embeds the assets again.

For requests to a server running on the development machine, Android Emulator
provides `10.0.2.2` as the host loopback alias. On a physical device, use an
address reachable from the device. HTTP, custom certificates, native file
pickers, background/resume, and QuickJS worker execution should be verified on
the actual target device before release. Local draft data is device-specific.
