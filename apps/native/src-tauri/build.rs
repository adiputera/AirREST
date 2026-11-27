fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // NDK r27 defaults to 4 KiB; Android devices may use 16 KiB pages.
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
    }
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&[
            "start_performance_run",
            "stop_performance_run",
            "update_performance_variables",
            "check_performance_capacity",
        ]))
        .plugin(
            "android-update",
            tauri_build::InlinedPlugin::new().commands(&["download", "browse"]),
        )
        .plugin(
            "native-credential",
            tauri_build::InlinedPlugin::new().commands(&["read", "write", "remove"]),
        );
    tauri_build::try_build(attributes).expect("failed to build AirREST application metadata");
}
