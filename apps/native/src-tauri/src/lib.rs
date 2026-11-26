#[cfg(desktop)]
mod perf_histogram;
#[cfg(desktop)]
mod perf_runner;

#[cfg(desktop)]
const CREDENTIAL_SERVICE: &str = "airrest.native.credentials.v1";

#[cfg(desktop)]
fn validate_credential_scope(scope: &str) -> Result<(), String> {
    if scope.is_empty() || scope.len() > 512 || scope.chars().any(char::is_control) {
        return Err("Invalid protected credential scope.".to_owned());
    }
    Ok(())
}

#[cfg(desktop)]
fn credential_entry(scope: &str) -> Result<keyring::Entry, String> {
    validate_credential_scope(scope)?;
    keyring::Entry::new(CREDENTIAL_SERVICE, scope)
        .map_err(|_| "Protected credential storage is unavailable.".to_owned())
}

#[cfg(desktop)]
#[derive(serde::Serialize)]
struct CredentialReadResult {
    value: Option<String>,
}

#[cfg(desktop)]
#[tauri::command(rename = "read")]
fn credential_read(scope: String) -> Result<CredentialReadResult, String> {
    let entry = credential_entry(&scope)?;
    match entry.get_password() {
        Ok(value) => Ok(CredentialReadResult { value: Some(value) }),
        Err(keyring::Error::NoEntry) => Ok(CredentialReadResult { value: None }),
        Err(_) => Err("Could not read protected credentials.".to_owned()),
    }
}

#[cfg(desktop)]
#[tauri::command(rename = "write")]
fn credential_write(scope: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 16 * 1024 {
        return Err("Invalid protected credential value.".to_owned());
    }
    credential_entry(&scope)?
        .set_password(&value)
        .map_err(|_| "Could not save protected credentials.".to_owned())
}

#[cfg(desktop)]
#[tauri::command(rename = "remove")]
fn credential_remove(scope: String) -> Result<(), String> {
    let entry = credential_entry(&scope)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove protected credentials.".to_owned()),
    }
}

#[cfg(target_os = "macos")]
use tauri::{
    Emitter, Manager,
    menu::{
        AboutMetadata, HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem, Submenu,
        WINDOW_SUBMENU_ID,
    },
};

#[cfg(target_os = "macos")]
fn build_macos_menu<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app_handle.package_info();
    let config = app_handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let close_tab_item = MenuItem::with_id(
        app_handle,
        "close_active_tab",
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let close_window_item = MenuItem::with_id(
        app_handle,
        "close_window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let window_close_item = MenuItem::with_id(
        app_handle,
        "window_close_window",
        "Close Window",
        true,
        None::<&str>,
    )?;

    let window_menu = Submenu::with_id_and_items(
        app_handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app_handle, None)?,
            &PredefinedMenuItem::maximize(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &window_close_item,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(app_handle, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app_handle,
        &[
            &Submenu::with_items(
                app_handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app_handle, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::services(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::hide(app_handle, None)?,
                    &PredefinedMenuItem::hide_others(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::quit(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                app_handle,
                "File",
                true,
                &[&close_tab_item, &close_window_item],
            )?,
            &Submenu::with_items(
                app_handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app_handle, None)?,
                    &PredefinedMenuItem::redo(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::cut(app_handle, None)?,
                    &PredefinedMenuItem::copy(app_handle, None)?,
                    &PredefinedMenuItem::paste(app_handle, None)?,
                    &PredefinedMenuItem::select_all(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                app_handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app_handle, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(build_macos_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "close_active_tab" => {
                let _ = app.emit("airrest:close-active-tab", ());
            }
            "close_window" | "window_close_window" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.close();
                }
            }
            _ => {}
        });

    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("android-update")
            .setup(|_app, api| {
                api.register_android_plugin("id.adiputera.airrest", "AndroidUpdatePlugin")?;
                Ok(())
            })
            .build(),
    );

    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("native-credential")
            .setup(|_app, api| {
                api.register_android_plugin("id.adiputera.airrest", "NativeCredentialPlugin")?;
                Ok(())
            })
            .build(),
    );

    #[cfg(desktop)]
    let builder = {
        let mut updater_builder = tauri_plugin_updater::Builder::new();
        if let Some(pubkey) = option_env!("TAURI_UPDATER_PUBLIC_KEY")
            && !pubkey.trim().is_empty()
        {
            updater_builder = updater_builder.pubkey(pubkey.trim());
        }
        builder
            .manage(perf_runner::PerfRunnerManager::default())
            .plugin(
                tauri::plugin::Builder::<tauri::Wry>::new("native-credential")
                    .invoke_handler(tauri::generate_handler![
                        credential_read,
                        credential_write,
                        credential_remove,
                    ])
                    .build(),
            )
            .plugin(tauri_plugin_process::init())
            .plugin(updater_builder.build())
            .invoke_handler(tauri::generate_handler![
                perf_runner::start_performance_run,
                perf_runner::stop_performance_run,
                perf_runner::update_performance_variables,
                perf_runner::check_performance_capacity,
            ])
    };

    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
