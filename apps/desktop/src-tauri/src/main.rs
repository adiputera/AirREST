// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GTK_THEME").is_err() {
            unsafe {
                std::env::set_var("GTK_THEME", "Adwaita:dark");
            }
        }
    }
    airrest_desktop_lib::run()
}
