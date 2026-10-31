#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    let builder = {
        let mut updater_builder = tauri_plugin_updater::Builder::new();
        if let Some(pubkey) = option_env!("TAURI_UPDATER_PUBLIC_KEY")
            && !pubkey.trim().is_empty()
        {
            updater_builder = updater_builder.pubkey(pubkey.trim());
        }
        builder
            .plugin(tauri_plugin_process::init())
            .plugin(updater_builder.build())
    };

    builder
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
