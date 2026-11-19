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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

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
    };

    builder
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
